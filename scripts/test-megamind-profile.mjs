#!/usr/bin/env node
/**
 * Perfil Megamind da extensão que o Agent leva: sem `ARCA_MEGAMIND_CONFIG`, quem manda é o
 * enrollment que a máquina tem. Numa máquina só Omni (sócio da Omni), uma sessão de terminal
 * apontava para a ARCA e mostrava ARCA — o bug que isto trava. HOME é injetado: nenhuma config
 * real é lida.
 *
 * O segundo ponto cego: o perfil Omni falando os nomes da ARCA com o Mainframe.
 * O grupo do Omni é `#omni` e as capabilities dele são `capabilities.omni`, com o
 * anúncio antigo (`capabilities.arca`) ainda valendo enquanto o servidor não sobe.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repo, "extensions", "megamind", "profile.ts");
const contractSource = join(repo, "extensions", "megamind", "contract.ts");
// O módulo é TS; um Node sem type stripping ligado por padrão ainda carrega o texto já limpo.
const { COMPANIES, megamindApp, megamindName, megamindProfile, defaultConfigPath } = await import(source).catch(
	async () => import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(readFileSync(source, "utf8")))}`),
);
const { chatGroup, eventsUrl, groupAddress, serverProfile } = await import(contractSource).catch(
	async () => import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(readFileSync(contractSource, "utf8")))}`),
);
const { resetCore, resolveCore } = await import(join(repo, "extensions", "megamind", "core.ts"));

const root = mkdtempSync(join(tmpdir(), "agent-megamind-profile-"));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
async function atest(name, fn) { await fn(); checks++; console.log(`ok ${name}`); }

/** HOME de teste com os enrollments pedidos já no lugar. */
function home(name, companies) {
	const dir = join(root, name);
	for (const company of companies) {
		mkdirSync(join(dir, ".config", company), { recursive: true });
		writeFileSync(join(dir, ".config", company, "config.json"), JSON.stringify({ endpoint: "https://example.invalid/mcp", token_file: join(dir, "token") }));
	}
	mkdirSync(dir, { recursive: true });
	return dir;
}

try {
	const omniOnly = home("omni-only", ["omni-megamind"]);
	const both = home("both", ["arca-projects", "omni-megamind"]);
	const empty = home("empty", []);

	test("máquina só Omni: sem variável a sessão é da Omni", () => {
		assert.deepEqual(megamindProfile({}, omniOnly), {
			id: "omni",
			label: "Omni",
			configPath: join(omniOnly, ".config", "omni-megamind", "config.json"),
		});
	});

	test("as duas presentes: a ARCA continua na frente", () => {
		assert.deepEqual(megamindProfile({}, both), { id: "arca", label: "ARCA", configPath: defaultConfigPath(both) });
	});

	test("sem enrollment nenhum: ARCA padrão, inerte sem credencial", () => {
		assert.deepEqual(megamindProfile({}, empty), { id: "arca", label: "ARCA", configPath: defaultConfigPath(empty) });
	});

	test("OMNI_MEGAMIND_CONFIG move a config da Omni, como no app", () => {
		const moved = join(root, "elsewhere", "config.json");
		mkdirSync(dirname(moved), { recursive: true });
		writeFileSync(moved, "{}");
		assert.deepEqual(megamindProfile({ OMNI_MEGAMIND_CONFIG: moved }, empty), { id: "omni", label: "Omni", configPath: moved });
		// Caminho declarado que não existe não vale enrollment.
		assert.equal(megamindProfile({ OMNI_MEGAMIND_CONFIG: join(root, "nada", "config.json") }, omniOnly).id, "arca");
	});

	test("ARCA_MEGAMIND_CONFIG explícito e o sentinela não mudam", () => {
		const omni = join(omniOnly, ".config", "omni-megamind", "config.json");
		assert.deepEqual(megamindProfile({ ARCA_MEGAMIND_CONFIG: omni }, empty), { id: "omni", label: "Omni", configPath: omni });
		assert.deepEqual(megamindProfile({ ARCA_MEGAMIND_CONFIG: defaultConfigPath(empty) }, empty), { id: "arca", label: "ARCA", configPath: defaultConfigPath(empty) });
		assert.equal(megamindProfile({ ARCA_MEGAMIND_CONFIG: "~/.config/omni-megamind/config.json" }, empty).id, "omni");
		const outro = join(root, "etc", "acme-megamind", "config.json");
		assert.deepEqual(megamindProfile({ ARCA_MEGAMIND_CONFIG: outro }, empty), { id: "custom", label: "acme-megamind", configPath: outro });
		for (const value of ["none", "NONE", "  none  "]) {
			assert.deepEqual(megamindProfile({ ARCA_MEGAMIND_CONFIG: value }, both), { id: "none" });
		}
	});

	test("o grupo do chat tem o nome do perfil", () => {
		assert.equal(chatGroup("omni"), "omni");
		assert.equal(chatGroup("arca"), "arca");
		assert.equal(chatGroup("custom"), "arca");
		// Servidor que não anuncia o canal novo: o Omni continua no canal antigo.
		assert.equal(chatGroup("omni", false), "arca");
	});

	test("perfil Omni lê capabilities.omni, com capabilities.arca de reserva", () => {
		assert.deepEqual(serverProfile({ omni: { core: 6 }, tools: {} }, "omni"), { server: { core: 6 }, group: "omni", alias: "omni" });
		assert.deepEqual(serverProfile({ arca: { core: 6 } }, "omni"), { server: { core: 6 }, group: "arca", alias: "omni" });
		assert.deepEqual(serverProfile({}, "omni"), { group: "arca", alias: "omni" });
	});

	test("perfil ARCA só olha capabilities.arca", () => {
		assert.deepEqual(serverProfile({ arca: { core: 6 } }, "arca"), { server: { core: 6 }, group: "arca", alias: "arca" });
		assert.deepEqual(serverProfile({ omni: { core: 6 } }, "arca"), { group: "arca", alias: "arca" });
	});

	test("o grupo do perfil vira o canal que este servidor entende", () => {
		assert.equal(groupAddress("#omni", "arca", "omni"), "#arca");
		assert.equal(groupAddress("#Omni", "omni", "omni"), "#omni");
		assert.equal(groupAddress("#arca", "arca", "arca"), "#arca");
		// Perfil ARCA não reescreve nada: o endereço segue para o servidor como veio.
		assert.equal(groupAddress("#omni", "arca", "arca"), "#omni");
		assert.equal(groupAddress("@biel", "omni", "omni"), "@biel");
		assert.equal(groupAddress("4e1a2f90-0000-4000-8000-000000000000", "omni", "omni"), "4e1a2f90-0000-4000-8000-000000000000");
	});

	test("a rota SSE vem do endpoint do enrollment, não de um caminho fixo", () => {
		assert.equal(eventsUrl("https://mainframe.example.com/api/omni/mcp"), "https://mainframe.example.com/api/omni/events");
		assert.equal(eventsUrl("https://hub.example.invalid/api/arca/mcp"), "https://hub.example.invalid/api/arca/events");
		assert.equal(eventsUrl("https://hub.example.invalid/api/omni/mcp/"), "https://hub.example.invalid/api/omni/events");
		assert.equal(eventsUrl("https://hub.example.invalid/gateway"), "https://hub.example.invalid/api/arca/events");
	});

	test("perfil Omni: nenhum texto da ARCA", () => {
		const omni = megamindProfile({}, omniOnly);
		assert.equal(megamindName(omni), "Omni Megamind");
		assert.equal(megamindApp(omni), "Omni");
		const previous = process.env.ARCA_MEGAMIND_CONFIG;
		process.env.ARCA_MEGAMIND_CONFIG = omni.configPath;
		try {
			for (const text of [megamindName(), megamindApp()]) assert.doesNotMatch(text, /ARCA/u);
		} finally {
			if (previous === undefined) delete process.env.ARCA_MEGAMIND_CONFIG;
			else process.env.ARCA_MEGAMIND_CONFIG = previous;
		}
	});

	test("perfil ARCA intacto: os textos dele continuam os mesmos", () => {
		const arca = megamindProfile({}, both);
		assert.equal(megamindName(arca), "ARCA Megamind");
		assert.equal(megamindApp(arca), "ARCA Desktop");
		const previous = process.env.ARCA_MEGAMIND_CONFIG;
		process.env.ARCA_MEGAMIND_CONFIG = arca.configPath;
		try {
			assert.equal(megamindName(), "ARCA Megamind");
		} finally {
			if (previous === undefined) delete process.env.ARCA_MEGAMIND_CONFIG;
			else process.env.ARCA_MEGAMIND_CONFIG = previous;
		}
	});

	test("empresa nova é uma linha da tabela: tudo sai dela", () => {
		COMPANIES.push({ id: "acme", label: "Acme", app: "Acme Desktop", dir: "acme-megamind", group: "acme", env: "ACME_MEGAMIND_CONFIG" });
		try {
			const acmeOnly = home("acme-only", ["acme-megamind"]);
			const acme = megamindProfile({}, acmeOnly);
			assert.deepEqual(acme, { id: "acme", label: "Acme", configPath: join(acmeOnly, ".config", "acme-megamind", "config.json") });
			assert.equal(megamindName(acme), "Acme Megamind");
			assert.equal(megamindApp(acme), "Acme Desktop");
			assert.equal(chatGroup("acme"), "acme");
			assert.deepEqual(serverProfile({ acme: { core: 6 } }, "acme"), { server: { core: 6 }, group: "acme", alias: "acme" });
			assert.deepEqual(serverProfile({ arca: { core: 6 } }, "acme"), { server: { core: 6 }, group: "arca", alias: "acme" });
			assert.equal(groupAddress("#acme", "arca", "acme"), "#arca");
			assert.equal(megamindProfile({ ACME_MEGAMIND_CONFIG: acme.configPath }, empty).id, "acme");
			assert.equal(megamindProfile({}, both).id, "arca");
			assert.equal(megamindProfile({}, empty).configPath, defaultConfigPath(empty));
		} finally {
			COMPANIES.pop();
		}
	});

	await atest("probe que falhou não fica em cache: a próxima chamada sonda de novo", async () => {
		let requests = 0;
		const server = createServer((request, response) => {
			requests++;
			request.resume();
			if (requests === 1) {
				response.writeHead(503).end();
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: { omni: { core: 6 } } } }));
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		const port = server.address().port;
		const dir = join(root, "probe", ".config", "omni-megamind");
		mkdirSync(dir, { recursive: true });
		const tokenFile = join(dir, "token");
		writeFileSync(tokenFile, "device-token");
		chmodSync(tokenFile, 0o600);
		const config = join(dir, "config.json");
		writeFileSync(config, JSON.stringify({ endpoint: `http://127.0.0.1:${port}/api/omni/mcp`, token_file: tokenFile }));
		const env = { ARCA_MEGAMIND_CONFIG: process.env.ARCA_MEGAMIND_CONFIG, ARCA_ALLOW_INSECURE_LOCALHOST: process.env.ARCA_ALLOW_INSECURE_LOCALHOST };
		process.env.ARCA_MEGAMIND_CONFIG = config;
		process.env.ARCA_ALLOW_INSECURE_LOCALHOST = "1";
		try {
			resetCore();
			const failed = await resolveCore();
			assert.equal(failed.core, 5);
			assert.equal(failed.group, "arca");
			const retried = await resolveCore();
			assert.equal(retried.core, 6);
			assert.equal(retried.group, "omni");
			assert.equal(requests, 2);
			assert.equal(await resolveCore(), retried);
			assert.equal(requests, 2);
		} finally {
			resetCore();
			for (const [name, value] of Object.entries(env)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await new Promise((done) => server.close(done));
		}
	});

	console.log(`${checks} checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
