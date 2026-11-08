#!/usr/bin/env node
/**
 * Abre o Pi numa HOME temporária com o setup do Agent instalado e confere que ele sobe limpo:
 * nenhuma extensão falha ao carregar e as tools das extensões aparecem no system prompt.
 *
 * Usa o Pi já instalado no store (`<store>/current`), porque é esse o binário que o sócio vai
 * abrir; sem store instalado o teste pula. Nada é escrito fora do diretório temporário: HOME,
 * `PI_CODING_AGENT_DIR` e o store do Agent são todos dentro dele.
 *
 * O endpoint é loopback fechado, com chave fictícia; não há chamada real ao provider. O que
 * importa é a mensagem de sistema, que o Pi emite antes de falar com o provider.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncAgentSetup } from "./lib/agent-setup.mjs";
import { syncAgentExtensions } from "./lib/extensions.mjs";
import { syncAgentSkills } from "./lib/skills.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const store = process.env.AGENT_STORE || join(homedir(), ".local", "share", "agent");
const current = join(store, "current");
const pi = join(current, "bin", "pi");
const agentPackage = join(current, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(pi)) {
	console.log(`sem Pi instalado em ${current}; teste de startup pulado`);
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "agent-startup-test-"));
const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
const agentStore = join(root, "store");
mkdirSync(agentDir, { recursive: true });
mkdirSync(agentStore, { recursive: true });
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

try {
	syncAgentSkills({ sourceRoot: repo, store: agentStore, agentDir, homeDir: home, log: () => {}, warn: () => {} });
	syncAgentExtensions({ sourceRoot: repo, store: agentStore, agentDir, log: () => {}, warn: () => {} });
	const setup = syncAgentSetup({ sourceRoot: repo, store: agentStore, agentDir, homeDir: home, log: () => {}, warn: () => {} });
	assert.equal(setup.installed, true);

	// Test-only endpoint: no real credentials or provider traffic.
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: {
		baseUrl: "http://127.0.0.1:1", apiKey: "agent-startup-test-not-a-key",
	} } }));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: root,
		XDG_CONFIG_HOME: join(home, ".config"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_ACCOUNTS_MIRROR: "0",
		ORCA_BACKGROUND_LAUNCH: "1",
	};
	// Entradas `-…`/`builtin:` são diretivas do settings (o Pi filtra antes do loader), não caminhos.
	const paths = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).extensions.filter((p) => !p.startsWith("-") && !/^\+?builtin:/.test(p));
	test("o loader isolado carrega as extensões registradas sem erro", () => {
		const script = `
			const { loadExtensions } = await import(${JSON.stringify(join(agentPackage, "dist/core/extensions/loader.js"))});
			const loaded = await loadExtensions(${JSON.stringify(paths)}, ${JSON.stringify(root)});
			console.log(JSON.stringify(loaded.errors));
			process.exit(loaded.errors.length || loaded.extensions.length !== ${paths.length} ? 1 : 0);
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});

	test("o loader do Pi não acha tema inválido na pasta de temas instalada", () => {
		// Duas leituras, porque o Pi tem duas: a auto-descoberta de `<agent-dir>/themes` (que pula
		// arquivo oculto) e o caminho de diretório pedido em `themes[]`/`--theme`, que carrega *todo*
		// `*.json` do diretório, inclusive oculto. Nessa segunda, um marcador `.json` do setup virava
		// `Invalid theme ...: expected an object with a "colors" map.` (docs/themes.md: "Pi reports
		// invalid theme files during startup and /reload"). A leitura por diretório usa uma cópia e um
		// agent-dir vazio para o mesmo tema não entrar duas vezes e virar colisão de nome.
		const probe = join(root, "themes-probe");
		const probeAgentDir = join(root, "probe-agent");
		cpSync(join(agentDir, "themes"), probe, { recursive: true });
		mkdirSync(probeAgentDir, { recursive: true });
		const loaderPath = JSON.stringify(join(agentPackage, "dist/core/resource-loader.js"));
		const script = [
			`const { DefaultResourceLoader } = await import(${loaderPath});`,
			"const read = async (dir, extra) => {",
			`  const loader = new DefaultResourceLoader({ cwd: ${JSON.stringify(root)}, agentDir: dir, additionalThemePaths: extra });`,
			"  await loader.reload();",
			"  const { themes, diagnostics } = loader.getThemes();",
			"  return { themes: themes.map((theme) => theme.name).sort(), diagnostics };",
			"};",
			`const auto = await read(${JSON.stringify(agentDir)}, []);`,
			`const dir = await read(${JSON.stringify(probeAgentDir)}, [${JSON.stringify(probe)}]);`,
			"console.log(JSON.stringify({ auto, dir }));",
		].join("\n");
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		const loaded = JSON.parse(run.stdout.trim().split("\n").pop());
		for (const [where, result] of Object.entries(loaded)) {
			assert.deepEqual(result.diagnostics, [], `diagnósticos de tema (${where}): ${JSON.stringify(result.diagnostics)}`);
			for (const name of setup.themes) assert.ok(result.themes.includes(name), `tema ausente no loader (${where}): ${name}`);
		}
	});

	test("pi -p sobe na HOME limpa com as tools das extensões", () => {
		const result = spawnSync(pi, ["--mode", "json", "-p", "oi"], {
			cwd: root,
			encoding: "utf8",
			timeout: 180_000,
			env,
		});
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.ok(!result.error, String(result.error));
		assert.ok(!/Failed to load extension|does not export a valid factory|Extension error|ENOENT|User agents: unknown|Invalid theme/.test(output), output.slice(0, 2000));
		const system = output.split("\n").find((line) => line.includes('"role":"system"'));
		assert.ok(system, `sem mensagem de sistema na saída:\n${output.slice(0, 2000)}`);
		for (const tool of ["subagent", "ask_user", "checks", "plan"]) {
			assert.ok(system.includes(`"name":"${tool}"`), `tool ausente no startup: ${tool}`);
		}
		// Deferred: registradas (o loader acima carrega as extensões), mas fora da 1ª requisição.
		for (const tool of ["project_overview", "peers_list"]) {
			assert.ok(!system.includes(`"name":"${tool}"`), `tool deferred declarada no startup: ${tool}`);
		}
		assert.ok(!system.includes('"name":"todo"'), "todo must be merged into plan, not registered separately");
		// Papéis de subagente achados em <agent-dir>/agents.
		for (const role of ["planner", "reviewer", "scout", "visual", "worker"]) assert.ok(system.includes(`${role} —`), `papel ausente: ${role}`);
	});

	console.log(`${checks} checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
