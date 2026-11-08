#!/usr/bin/env node
/**
 * A extensão `sessions` vendorizada não pode apagar histórico sozinha: `/gc` é explícito.
 *
 * Carrega o `sessions.ts` de `agent/` com o próprio loader do Pi instalado (jiti, como na
 * distribuição) dentro de uma HOME/agent-dir temporários, com sessões JSONL de mentira — jamais
 * contra sessões reais. Sem Pi instalado o teste pula.
 *
 * O que fica provado: nenhum handler de `session_start` (era ele que podava no startup, sem
 * confirmação e inclusive em outros projetos da mesma pasta de sessões), o comando `/gc` continua
 * registrado, e ele poda quando pedido.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const store = process.env.AGENT_STORE || join(homedir(), ".local", "share", "agent");
const agentPackage = join(store, "current", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const loaderEntry = join(agentPackage, "dist/core/extensions/loader.js");
if (!existsSync(loaderEntry)) {
	console.log(`sem Pi instalado em ${join(store, "current")}; teste de sessions pulado`);
	process.exit(0);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const root = mkdtempSync(join(tmpdir(), "agent-sessions-test-"));
let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log(`ok ${name}`); }); }

/** JSONL válido (header + prompt do usuário) com a data de modificação pedida. */
function writeSession(path, cwd, ageDays) {
	const lines = [
		JSON.stringify({ type: "session", id: `id-${ageDays}`, cwd }),
		JSON.stringify({ type: "message", message: { role: "user", content: "oi, isso é histórico" } }),
	];
	writeFileSync(path, `${lines.join("\n")}\n`);
	const when = (Date.now() - ageDays * DAY_MS) / 1000;
	utimesSync(path, when, when);
}

try {
	const { loadExtensions } = await import(loaderEntry);
	const sessionsRoot = join(root, "agent", "sessions");
	const mine = join(sessionsRoot, "projeto-atual");
	const outro = join(sessionsRoot, "outro-projeto");
	mkdirSync(mine, { recursive: true });
	mkdirSync(outro, { recursive: true });
	const current = join(mine, "atual.jsonl");
	const antiga = join(outro, "antiga.jsonl");
	writeSession(current, join(root, "projeto-atual"), 0);
	writeSession(antiga, join(root, "outro-projeto"), 31);

	const loaded = await loadExtensions([join(repo, "agent", "extensions", "brain-live", "sessions.ts")], root);
	assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];

	const notifications = [];
	const ctx = {
		cwd: join(root, "projeto-atual"),
		hasUI: true,
		ui: { notify: (message) => notifications.push(message) },
		sessionManager: { getSessionDir: () => mine, getSessionFile: () => current },
	};

	await test("nenhum handler de session_start: o startup não poda nada", async () => {
		const handlers = extension.handlers.get("session_start") ?? [];
		assert.deepEqual(handlers, [], "sessions voltou a mexer em session_start");
		// Mesmo assim, roda o que houver: o histórico de outro projeto tem de sobreviver.
		for (const handler of handlers) await handler({ type: "session_start", reason: "startup" }, ctx);
		assert.ok(existsSync(antiga), "sessão de 31 dias de outro projeto foi apagada no startup");
		assert.ok(existsSync(current));
		assert.deepEqual(notifications, []);
	});

	await test("/gc continua registrado e poda quando pedido", async () => {
		assert.ok(extension.commands.has("sessions"));
		const gc = extension.commands.get("gc");
		assert.ok(gc, "o comando /gc desapareceu");
		await gc.handler("", ctx);
		assert.ok(!existsSync(antiga), "/gc não podou a sessão velha");
		assert.ok(existsSync(current), "/gc apagou a sessão atual");
		assert.deepEqual(notifications, ["gc: 1 sessão(ões) apagada(s)"]);
	});

	await test("/cost lê JSONL clássico sem host durável, com ou sem filtro de projeto", async () => {
		const pack = await loadExtensions([join(repo, "agent/extensions/brain-live/cost.ts")], root);
		assert.deepEqual(pack.errors, []);
		const cost = pack.extensions[0].commands.get("cost");
		assert.ok(cost);
		for (const args of ["", "hoje", "semana aqui", "tudo"]) await cost.handler(args, ctx);
		assert.ok(!existsSync(join(root, "agent/durable-sessions")));
	});

	console.log(`${checks} checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
