#!/usr/bin/env node
/**
 * Testes do lock do store e do compare-and-swap.
 *
 * Roda em segundos e sem construir release nenhuma: o valor está justamente em poder
 * testar a exclusão mútua sem pagar os vinte minutos de um build.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireStoreLock, assertCurrentUnchanged, processAlive, readCurrentTarget } from "./lib/store-lock.mjs";

const feito = [];
function teste(nome, fn) {
	fn();
	feito.push(nome);
}

const raiz = mkdtempSync(join(tmpdir(), "store-lock-test-"));
const novoStore = () => mkdtempSync(join(raiz, "store-"));
// Por quê: no Windows um symlink de diretório exige admin ou Developer Mode; o updater usa junction
// (que exige alvo existente). O teste aponta `current` do mesmo jeito que o updater aponta.
const apontaCurrent = (store, nome) => {
	const alvo = join(raiz, nome);
	mkdirSync(alvo, { recursive: true });
	symlinkSync(alvo, join(store, "current"), process.platform === "win32" ? "junction" : undefined);
};

teste("um segundo updater é recusado enquanto o primeiro está vivo", () => {
	const store = novoStore();
	const lock = acquireStoreLock(store);
	assert.throws(() => acquireStoreLock(store), /está em uso/);
	lock.release();
	// Depois de liberado, o próximo entra.
	acquireStoreLock(store).release();
});

teste("lock de processo morto é roubado em vez de travar a máquina", () => {
	const store = novoStore();
	// pid 999999 não existe neste sistema; escreve um lock órfão à mão.
	writeFileSync(join(store, ".update.lock"), JSON.stringify({ pid: 999999, holder: "fantasma" }));
	const lock = acquireStoreLock(store);
	const dono = JSON.parse(readFileSync(join(store, ".update.lock"), "utf8"));
	assert.equal(dono.pid, process.pid, "o lock órfão devia ter sido roubado");
	lock.release();
});

teste("lock corrompido não trava o store", () => {
	const store = novoStore();
	writeFileSync(join(store, ".update.lock"), "isto não é json");
	const lock = acquireStoreLock(store);
	lock.release();
});

teste("release é idempotente e não apaga lock de outro dono", () => {
	const store = novoStore();
	const lock = acquireStoreLock(store);
	lock.release();
	// Outro processo tomou o lock depois de nós.
	writeFileSync(join(store, ".update.lock"), JSON.stringify({ pid: 999999, holder: "outro" }));
	lock.release(); // segunda chamada: não pode remover o lock alheio
	assert.ok(existsSync(join(store, ".update.lock")), "release repetido apagou lock de outro dono");
});

teste("processAlive reconhece o próprio processo e ignora pid inválido", () => {
	assert.equal(processAlive(process.pid), true);
	assert.equal(processAlive(999999), false);
	assert.equal(processAlive(0), false);
	assert.equal(processAlive(-1), false);
	assert.equal(processAlive(undefined), false);
});

teste("compare-and-swap aceita quando current não mudou", () => {
	const store = novoStore();
	apontaCurrent(store, "release-a");
	assertCurrentUnchanged(store, readCurrentTarget(store));
});

teste("compare-and-swap recusa quando alguém promoveu no meio do caminho", () => {
	const store = novoStore();
	apontaCurrent(store, "release-a");
	const antes = readCurrentTarget(store);
	rmSync(join(store, "current"));
	apontaCurrent(store, "release-b");
	assert.throws(() => assertCurrentUnchanged(store, antes), /release ativa mudou/);
	// --force é escape explícito, não default.
	assertCurrentUnchanged(store, antes, { force: true });
});

teste("store sem release ativa não é confundido com mudança", () => {
	const store = novoStore();
	assert.equal(readCurrentTarget(store), null);
	assertCurrentUnchanged(store, null);
});

// Exclusão real entre dois PROCESSOS, não só duas chamadas no mesmo processo.
const store = novoStore();
// `import()` exige uma URL: um caminho do Windows (`C:\...`) tem barras invertidas, que num
// especificador de módulo são escape — o teste morreria no import em vez de testar o lock.
const lockModule = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "lib", "store-lock.mjs")).href;
const filho = spawn(process.execPath, [
	"-e",
	`
	import(${JSON.stringify(lockModule)}).then(async (m) => {
		m.acquireStoreLock(${JSON.stringify(store)}, { holder: "filho" });
		console.log("peguei");
		await new Promise((r) => setTimeout(r, 5000));
	});
`,
]);
let rodouEntreProcessos = false;
const limparRaiz = () => rmSync(raiz, { recursive: true, force: true });
filho.stdout.once("data", () => {
	try {
		assert.throws(() => acquireStoreLock(store), /está em uso/, "o pai entrou num store travado por outro processo");
		feito.push("dois processos: o segundo é recusado de verdade");
		rodouEntreProcessos = true;
		console.log(feito.map((n) => `  ok ${n}`).join("\n"));
		console.log(`store-lock: ${feito.length} testes OK`);
	} finally {
		filho.kill("SIGKILL");
		limparRaiz();
	}
});
filho.stderr.on("data", (chunk) => process.stderr.write(chunk));
// Um filho que morre antes de tomar o lock nunca emite stdout. Sem isto a suíte terminaria com
// código 0 sem ter rodado o único teste que cobre dois processos de verdade — que é justamente o
// caso que o lock existe para proteger.
filho.on("exit", (code, signal) => {
	if (rodouEntreProcessos) return;
	limparRaiz();
	console.error(
		`o processo filho saiu (código ${code}, sinal ${signal}) sem tomar o lock: o teste entre processos não rodou`,
	);
	process.exit(1);
});
filho.on("error", (error) => {
	console.error("falha ao subir o processo filho:", error);
	process.exit(1);
});
