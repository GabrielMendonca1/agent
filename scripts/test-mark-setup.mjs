#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOSURE_ALLOWED_ORPHANS, PRUNED_VENDOR_PATHS, extensionGraph } from "./lib/mark-closure.mjs";
import {
	AGENTS_MARKER,
	AGENTS_SUBDIR,
	MARK_TREE,
	BRAIN_LIVE_TREE,
	EXTENSIONS_SUBDIR,
	MARK_DIR,
	MARK_SETTINGS_DEFAULTS,
	PATH_MARKER,
	THEMES_MARKER,
	THEMES_MARKER_LEGACY,
	THEMES_SUBDIR,
	extensionsIn,
	markSetupFiles,
	syncMarkSetup,
	themesIn,
} from "./lib/mark-setup.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "mark-setup-test-"));
const quiet = { log: () => {}, warn: () => {} };
const readSettings = (dir) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
const writeSettings = (dir, settings) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
};
/** Casa `<home>/.pi/agent` com um store e uma HOME próprios. */
function machine(name) {
	const home = join(root, name);
	const agentDir = join(home, ".pi", "agent");
	const store = join(home, "store");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(store, { recursive: true });
	return { home, agentDir, store, sync: (extra = {}) => syncMarkSetup({ sourceRoot: repo, store, agentDir, homeDir: home, ...quiet, ...extra }) };
}
/** `ensureLocalBinOnPath` só escreve rc de shell POSIX; no Windows o contrato é não tocar em nada. */
const posixShells = process.platform !== "win32";
let checks = 0;
let skips = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
function skip(name, why) { skips++; console.log(`skip ${name} (${why})`); }
/** Links de diretório no Windows exigem privilégio; sem ele o teste informa que pulou. */
function canSymlinkDirs() {
	const probe = join(root, "symlink-probe");
	try {
		mkdirSync(join(probe, "target"), { recursive: true });
		symlinkSync(join(probe, "target"), join(probe, "link"), "dir");
		return true;
	} catch {
		return false;
	}
}

try {
	test("o repo leva as duas árvores de extensão, os temas e os papéis", () => {
		const files = markSetupFiles(repo);
		for (const file of [
			`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${BRAIN_LIVE_TREE}/subagent/index.ts`,
			`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${BRAIN_LIVE_TREE}/lib/paths.ts`,
			`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${MARK_TREE}/accounts.ts`,
			`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${MARK_TREE}/tui/index.ts`,
			`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${MARK_TREE}/peers/package.json`,
			`${MARK_DIR}/${THEMES_SUBDIR}/grayscale-baimin-claude-cc-mark.json`,
			`${MARK_DIR}/${AGENTS_SUBDIR}/worker.md`,
		]) {
			assert.ok(files.includes(file), `falta no bundle: ${file}`);
		}
		// Nada de segredo nem de sessão viaja.
		assert.ok(!files.some((file) => /\/(?:auth\.json|accounts.*\.json|mcp\.json|models\.json)$|\.log$|\/durable-sessions\//.test(file)));
		assert.ok(files.includes("mark/juice/client.mjs"), "cliente do piloto viaja com suas extensões");
	});

	test("o vault-runtime vendorizado degrada quieto sem ~/Sistema/Pi", () => {
		const file = join(repo, MARK_DIR, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE, "vault-runtime.ts");
		const source = readFileSync(file, "utf8");
		assert.ok(source.includes("if (!existsSync(root)) return { skills: 0, errors: [] };"));
		assert.ok(source.includes('if (!existsSync(PI_VAULT_DIR)) return;'));
	});

	test("o grafo das extensões vendorizadas fecha: nada importa módulo que não viaja", () => {
		const graph = extensionGraph(join(repo, MARK_DIR, EXTENSIONS_SUBDIR));
		assert.deepEqual(graph.unresolved, [], `import sem destino em ${MARK_DIR}/`);
		assert.ok(graph.roots.some((path) => path.endsWith("/codemode-mode.ts")));
		assert.ok(!graph.roots.some((path) => path.endsWith("/read-media.ts")));
		assert.ok(graph.roots.some((path) => path.endsWith("/shell-runtime.ts")));
		// Fora do grafo só o que está documentado em CLOSURE_ALLOWED_ORPHANS (CLI à mão, cópia antiga
		// preservada): qualquer outro arquivo sem consumidor é lib que voltou a viajar morta.
		assert.deepEqual(graph.unreached, [...CLOSURE_ALLOWED_ORPHANS].sort());
	});

	test("closure encontra imports laterais, reexports, imports dinâmicos e require literais", () => {
		const tree = join(root, "closure-fixture");
		mkdirSync(join(tree, MARK_TREE), { recursive: true });
		writeFileSync(join(tree, MARK_TREE, "entry.ts"), [
			'import "./side-effect";',
			'export { value } from "./reexport";',
			'import("./dynamic");',
			'require("./required");',
		].join("\n"));
		assert.deepEqual(extensionGraph(tree).unresolved, ["dynamic", "reexport", "required", "side-effect"]
			.map((name) => `mark/entry.ts -> ./${name}`));
	});

	test("vendor em fixture reaplica patches, mantém a poda e recusa consumidor reintroduzido", () => {
		// Só código do repo: nunca fontes pessoais, nem o mark/ real como destino.
		const fixture = join(root, "vendor-repo");
		const source = join(root, "vendor-source");
		for (const path of ["mark", "mark-patches", "scripts/lib"]) {
			cpSync(join(repo, path), join(fixture, path), { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("target") });
		}
		cpSync(join(repo, "scripts/vendor-gabriel-setup.mjs"), join(fixture, "scripts/vendor-gabriel-setup.mjs"));
		cpSync(join(repo, "mark"), source, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("target") });
		const patches = readdirSync(join(repo, "mark-patches")).filter((name) => name.endsWith(".patch")).sort().map((name) => join(repo, "mark-patches", name));
		const juicePatch = join(repo, "mark/juice/extensions.patch");
		if (existsSync(juicePatch)) patches.push(juicePatch);
		for (const patch of patches.reverse()) {
			const result = spawnSync("git", ["apply", "-R", patch], { cwd: source, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		// A fonte pessoal ainda chama a TUI de `garime-tui`; o vendor a grava como `tui`.
		renameSync(join(source, "extensions/mark/tui"), join(source, "extensions/mark/garime-tui"));
		for (const path of PRUNED_VENDOR_PATHS) {
			const target = join(source, "extensions", path, ...(path.endsWith(".ts") ? [] : ["index.ts"]));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, "export const unusedFixture = true;\n");
		}
		const env = {
			PATH: process.env.PATH, HOME: root, USERPROFILE: root,
			MARK_VENDOR_HOME: root,
			MARK_VENDOR_BRAIN_LIVE: join(source, "extensions/brain-live"),
			MARK_VENDOR_ARCA: join(source, "extensions/mark"),
			MARK_VENDOR_THEMES: join(source, "themes"),
			MARK_VENDOR_AGENTS: join(source, "agents"),
		};
		const run = (...args) => spawnSync(process.execPath, [join(fixture, "scripts/vendor-gabriel-setup.mjs"), ...args], {
			cwd: fixture, env, encoding: "utf8", timeout: 30_000,
		});
		for (const args of [["--check"], [], ["--check"]]) {
			const result = run(...args);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		}
		const snapshot = () => markSetupFiles(fixture).map((path) => [path, readFileSync(join(fixture, path), "utf8")]);
		const before = snapshot();
		const entry = join(source, "extensions/mark/accounts.ts");
		writeFileSync(entry, `${readFileSync(entry, "utf8")}\nimport "./lib/tiers.ts";\n`);
		const rejected = run();
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /accounts\.ts -> \.\/lib\/tiers\.ts/);
		assert.deepEqual(snapshot(), before, "falha não altera o bundle anterior");
		assert.ok(!readdirSync(fixture).some((name) => name.startsWith("mark.tmp-")));
	});

	test("as libs fora do grafo não estão na cópia, e as usadas nas duas árvores estão", () => {
		const files = new Set(markSetupFiles(repo));
		for (const pruned of PRUNED_VENDOR_PATHS) {
			assert.ok(!files.has(`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${pruned}`), `lib podada voltou: ${pruned}`);
		}
		// Mesmo nome, árvore diferente: o que tem consumidor em cada uma continua vendorizado lá.
		for (const kept of [
			`${BRAIN_LIVE_TREE}/lib/tiers.ts`,
			`${BRAIN_LIVE_TREE}/lib/compaction-epoch.ts`,
			`${BRAIN_LIVE_TREE}/lib/cost-ledger.ts`,
			`${BRAIN_LIVE_TREE}/lib/paths.ts`,
			`${BRAIN_LIVE_TREE}/lib/durable-sessions.ts`,
			`${BRAIN_LIVE_TREE}/lib/image-normalize.ts`,
			`${MARK_TREE}/lib/json-file.ts`,
			`${MARK_TREE}/lib/image-normalize.ts`,
			`${MARK_TREE}/lib/prompt-slot.ts`,
			`${MARK_TREE}/lib/secret-scan.ts`,
		]) {
			assert.ok(files.has(`${MARK_DIR}/${EXTENSIONS_SUBDIR}/${kept}`), `falta no bundle: ${kept}`);
		}
	});

	test("lib/ e sessions.md não contam como extensão; peers entra pelo package.json", () => {
		const tree = join(repo, MARK_DIR, EXTENSIONS_SUBDIR);
		const names = extensionsIn(join(tree, BRAIN_LIVE_TREE)).map((extension) => extension.name);
		assert.ok(!names.includes("lib"));
		assert.ok(!names.includes("sessions.md"));
		assert.ok(names.includes("sessions"));
		assert.deepEqual(extensionsIn(join(tree, MARK_TREE)).map((e) => e.name), ["accounts", "peers", "tui", "web", "whimsical"]);
	});

	const clean = machine("clean");
	let cleanResult;
	test("HOME limpa: instala, registra tudo e preenche os defaults", () => {
		cleanResult = clean.sync();
		assert.equal(cleanResult.installed, true);
		assert.deepEqual(cleanResult.skippedExtensions, []);
		const settings = readSettings(clean.agentDir);
		const registered = new Set(
			[BRAIN_LIVE_TREE, MARK_TREE]
				.flatMap((tree) => extensionsIn(join(clean.store, MARK_DIR, EXTENSIONS_SUBDIR, tree)))
				.filter((extension) => extension.name !== "web")
				.map((extension) => extension.name),
		);
		assert.equal(settings.extensions.length, registered.size + 1);
		assert.ok(settings.extensions.includes("-builtin:codemode"));
		assert.ok(registered.has("codemode-mode"));
		assert.ok(settings.extensions.every((entry) => entry === "-builtin:codemode" || entry.startsWith(join(clean.store, MARK_DIR))));
		// Um nome por extensão.
		const names = settings.extensions.map((entry) => entry.split("/").pop().replace(/\.ts$/, ""));
		assert.equal(new Set(names).size, names.length);
		assert.deepEqual(extensionGraph(join(clean.store, MARK_DIR, EXTENSIONS_SUBDIR)).unresolved, []);
		assert.equal(settings.themes, undefined);
		assert.ok(existsSync(join(clean.agentDir, THEMES_SUBDIR, "grayscale-baimin-claude-cc-mark.json")));
		assert.equal(cleanResult.themes.length, themesIn(join(repo, MARK_DIR, THEMES_SUBDIR)).length);
		for (const [key, value] of Object.entries(MARK_SETTINGS_DEFAULTS)) assert.deepEqual(settings[key], value);
		assert.deepEqual(cleanResult.agents, ["planner.md", "reviewer.md", "scout.md", "visual.md", "worker.md"]);
		assert.ok(existsSync(join(clean.agentDir, AGENTS_SUBDIR, "worker.md")));
		if (posixShells) {
			for (const rc of [".zshrc", ".bashrc"]) assert.ok(readFileSync(join(clean.home, rc), "utf8").includes(PATH_MARKER));
		} else {
			assert.deepEqual(cleanResult.pathFiles, []);
			for (const rc of [".zshrc", ".bashrc"]) assert.ok(!existsSync(join(clean.home, rc)), `${rc} não existe no Windows`);
		}
	});

	test("o marcador de temas não é um .json que o Pi tentaria carregar como tema", () => {
		const themes = join(clean.agentDir, THEMES_SUBDIR);
		assert.ok(existsSync(join(themes, THEMES_MARKER)));
		assert.ok(!existsSync(join(themes, THEMES_MARKER_LEGACY)));
		assert.deepEqual(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes, cleanResult.themes);
		// Todo `*.json` da pasta (inclusive oculto) é tema para o loader do Pi: cada um tem `colors`.
		for (const file of readdirSync(themes).filter((name) => name.endsWith(".json"))) {
			const theme = JSON.parse(readFileSync(join(themes, file), "utf8"));
			assert.ok(theme && typeof theme.colors === "object", `${file} não é um tema válido`);
		}
	});

	test("segunda ativação não duplica nada", () => {
		const before = readFileSync(join(clean.agentDir, "settings.json"), "utf8");
		const zshrc = posixShells ? readFileSync(join(clean.home, ".zshrc"), "utf8") : undefined;
		const result = clean.sync();
		assert.equal(result.settingsUpdated, false);
		assert.deepEqual(result.defaults, []);
		assert.deepEqual(result.pathFiles, []);
		assert.equal(readFileSync(join(clean.agentDir, "settings.json"), "utf8"), before);
		if (posixShells) assert.equal(readFileSync(join(clean.home, ".zshrc"), "utf8"), zshrc);
	});

	test("papel novo entra e papel sumido sai, sem tocar nos do usuário", () => {
		const own = join(clean.agentDir, AGENTS_SUBDIR, "meu.md");
		writeFileSync(own, "---\nname: meu\ndescription: meu papel\n---\n");
		writeFileSync(join(clean.agentDir, AGENTS_SUBDIR, "stale.md"), "antigo");
		const marker = join(clean.agentDir, AGENTS_SUBDIR, AGENTS_MARKER);
		writeFileSync(marker, `${JSON.stringify({ agents: ["worker.md", "stale.md"] }, null, 2)}\n`);
		clean.sync();
		assert.ok(!existsSync(join(clean.agentDir, AGENTS_SUBDIR, "stale.md")));
		assert.ok(existsSync(own));
		assert.ok(existsSync(join(clean.agentDir, AGENTS_SUBDIR, "planner.md")));
	});

	test("máquina do Gabriel: nada é registrado duas vezes e o settings dele fica igual", () => {
		const gabriel = machine("gabriel");
		// Pasta auto-carregada com os mesmos nomes da árvore brain-live.
		const auto = join(gabriel.agentDir, EXTENSIONS_SUBDIR);
		mkdirSync(join(auto, "subagent"), { recursive: true });
		writeFileSync(join(auto, "subagent", "index.ts"), "export default function () {}\n");
		for (const { name } of extensionsIn(join(repo, MARK_DIR, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE))) {
			if (name === "subagent") continue;
			writeFileSync(join(auto, `${name}.ts`), "export default function () {}\n");
		}
		// Temas auto-carregados com os mesmos nomes.
		const themes = join(gabriel.agentDir, THEMES_SUBDIR);
		mkdirSync(themes, { recursive: true });
		for (const theme of themesIn(join(repo, MARK_DIR, THEMES_SUBDIR))) {
			writeFileSync(join(themes, `${theme.name}.json`), `${JSON.stringify({ name: theme.name })}\n`);
		}
		// Papéis próprios e as entradas da ARCA no settings, como na máquina dele.
		mkdirSync(join(gabriel.agentDir, AGENTS_SUBDIR), { recursive: true });
		writeFileSync(join(gabriel.agentDir, AGENTS_SUBDIR, "worker.md"), "meu worker\n");
		const original = {
			theme: "grayscale-baimin-claude-cc-mark-light/grayscale-baimin-claude-cc-mark",
			defaultModel: "claude-opus-5-5",
			tuiMode: "fullscreen",
			extensions: [
				"/Users/x/ARCA/arca/extensions/accounts.ts",
				"-extensions/garime-tui/index.ts",
				"/Users/x/ARCA/arca/extensions/garime-tui",
				"/Users/x/ARCA/arca/extensions/peers",
				"/Users/x/ARCA/arca/extensions/whimsical.ts",
			],
		};
		writeSettings(gabriel.agentDir, original);
		const result = gabriel.sync();
		assert.deepEqual(result.extensions, []);
		assert.deepEqual(result.themes, []);
		assert.deepEqual(result.agents, []);
		assert.equal(result.settingsUpdated, true); // só os defaults que ele não tinha
		const settings = readSettings(gabriel.agentDir);
		assert.deepEqual(settings.extensions, [...original.extensions, "-builtin:codemode"]);
		assert.equal(settings.themes, undefined);
		assert.equal(settings.theme, original.theme);
		assert.equal(readFileSync(join(gabriel.agentDir, AGENTS_SUBDIR, "worker.md"), "utf8"), "meu worker\n");
		assert.ok(!existsSync(join(gabriel.agentDir, AGENTS_SUBDIR, "planner.md")));
		assert.deepEqual(result.skippedThemes.length, themesIn(join(repo, MARK_DIR, THEMES_SUBDIR)).length);
		assert.ok(result.skippedExtensions.includes("accounts"));
		assert.ok(result.skippedExtensions.includes("tui"));
		assert.ok(result.skippedExtensions.includes("subagent"));
	});

	test("colisão de um tema só registra os outros arquivo por arquivo", () => {
		const one = machine("one-theme");
		const themes = join(one.agentDir, THEMES_SUBDIR);
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "911.json"), `${JSON.stringify({ name: "911" })}\n`);
		const result = one.sync();
		assert.deepEqual(result.skippedThemes, ["911"]);
		assert.ok(result.themes.length > 1);
		assert.ok(!result.themes.includes("911"));
		assert.equal(readFileSync(join(themes, "911.json"), "utf8"), `${JSON.stringify({ name: "911" })}\n`);
		assert.ok(existsSync(join(themes, "911-day.json")));
	});

	test("tema pessoal em settings prevalece também após uma instalação", () => {
		const m = machine("later-theme");
		m.sync();
		const settings = readSettings(m.agentDir);
		settings.themes = [join(repo, "mark/themes")];
		writeSettings(m.agentDir, settings);
		const again = m.sync();
		assert.deepEqual(readSettings(m.agentDir).themes, [join(repo, "mark/themes")]);
		assert.deepEqual(again.themes, []);
		// A cópia gerenciada sai de cena para o tema que a pessoa carrega: dois arquivos com o mesmo
		// nome seriam colisão de recurso no Pi.
		const themes = join(m.agentDir, THEMES_SUBDIR);
		assert.deepEqual(readdirSync(themes).filter((name) => name.endsWith(".json")), []);
		assert.deepEqual(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes, []);
	});

	test("descolisão: tirado o tema pessoal, o Mark volta a instalar e atualizar o dele", () => {
		const m = machine("collide");
		const first = m.sync();
		const themes = join(m.agentDir, THEMES_SUBDIR);
		const mine = themesIn(join(repo, MARK_DIR, THEMES_SUBDIR))[0].name;
		assert.ok(first.themes.includes(mine));
		const managed = readFileSync(join(themes, `${mine}.json`), "utf8");

		// Tema pessoal homónimo entra por settings.themes.
		const personalDir = join(m.home, "meus-temas");
		mkdirSync(personalDir, { recursive: true });
		writeFileSync(join(personalDir, `${mine}.json`), `${JSON.stringify({ name: mine, colors: {} })}\n`);
		const settings = readSettings(m.agentDir);
		settings.themes = [personalDir];
		writeSettings(m.agentDir, settings);
		const collided = m.sync();
		assert.ok(collided.skippedThemes.includes(mine));
		assert.ok(!existsSync(join(themes, `${mine}.json`)), "a cópia do Mark cede o nome");
		assert.ok(!JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes.includes(mine));
		assert.equal(readFileSync(join(personalDir, `${mine}.json`), "utf8"), `${JSON.stringify({ name: mine, colors: {} })}\n`);

		// Retirado o tema pessoal, a atualização do Mark retoma sem duplicata.
		const back = readSettings(m.agentDir);
		delete back.themes;
		writeSettings(m.agentDir, back);
		const resumed = m.sync();
		assert.ok(resumed.themes.includes(mine));
		assert.equal(readFileSync(join(themes, `${mine}.json`), "utf8"), managed);
		assert.ok(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes.includes(mine));
	});

	test("a própria pasta de temas em settings.themes não colide com o Mark", () => {
		const m = machine("self-themes");
		const first = m.sync();
		const themes = join(m.agentDir, THEMES_SUBDIR);
		const settings = readSettings(m.agentDir);
		settings.themes = [themes];
		writeSettings(m.agentDir, settings);
		for (const pass of [1, 2]) {
			const again = m.sync();
			assert.deepEqual(again.skippedThemes, [], `passo ${pass}`);
			assert.deepEqual(again.themes, first.themes, `passo ${pass}`);
			assert.deepEqual(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes, first.themes);
			for (const name of first.themes) assert.ok(existsSync(join(themes, `${name}.json`)), `${name} sumiu no passo ${pass}`);
		}
	});

	test("marcador antigo .mark-themes.json migra sem perder a propriedade dos temas", () => {
		const m = machine("legacy-marker");
		m.sync();
		const themes = join(m.agentDir, THEMES_SUBDIR);
		const owned = JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes;
		// Estado de quem instalou com a versão anterior: marcador `.json` e nenhum marcador novo.
		writeFileSync(join(themes, THEMES_MARKER_LEGACY), `${JSON.stringify({ themes: owned }, null, 2)}\n`);
		rmSync(join(themes, THEMES_MARKER));
		writeFileSync(join(themes, "pessoal.json"), `${JSON.stringify({ name: "pessoal", colors: {} })}\n`);

		const result = m.sync();
		assert.ok(!existsSync(join(themes, THEMES_MARKER_LEGACY)), "o marcador `.json` sai da pasta de temas");
		assert.deepEqual(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes, owned);
		// Os temas continuam do Mark (atualizados), e o tema da pessoa fica como está.
		assert.deepEqual(result.themes, owned);
		assert.deepEqual(result.skippedThemes, []);
		assert.equal(readFileSync(join(themes, "pessoal.json"), "utf8"), `${JSON.stringify({ name: "pessoal", colors: {} })}\n`);
	});

	test("defaults só entram onde o usuário não escreveu", () => {
		const mine = machine("mine");
		writeSettings(mine.agentDir, { defaultModel: "gpt-5.5", theme: "dark", quietStartup: true });
		const result = mine.sync();
		assert.ok(!result.defaults.includes("defaultModel"));
		assert.ok(!result.defaults.includes("theme"));
		assert.ok(!result.defaults.includes("quietStartup"));
		const settings = readSettings(mine.agentDir);
		assert.equal(settings.defaultModel, "gpt-5.5");
		assert.equal(settings.theme, "dark");
		assert.equal(settings.quietStartup, true);
		assert.equal(settings.tuiMode, "fullscreen");
	});

	test('"-mark-setup" desliga tudo; "-<nome>" desliga uma extensão', () => {
		const off = machine("off");
		writeSettings(off.agentDir, { extensions: ["-mark-setup"] });
		const result = off.sync();
		assert.equal(result.disabled, true);
		assert.ok(!existsSync(join(off.store, MARK_DIR)));
		assert.deepEqual(readSettings(off.agentDir), { extensions: ["-mark-setup"] });

		const partial = machine("partial");
		writeSettings(partial.agentDir, { extensions: ["-plan", "!todos"] });
		const run = partial.sync();
		assert.ok(run.skippedExtensions.includes("plan"));
		assert.ok(run.skippedExtensions.includes("todos"));
		assert.ok(!readSettings(partial.agentDir).extensions.some((entry) => /\/(?:plan|todos\.ts)$/.test(entry)));
	});

	test("a linha de PATH vai para os rc existentes e nunca duplica", () => {
		const shells = machine("shells");
		writeFileSync(join(shells.home, ".zshrc"), "export EDITOR=vi");
		writeFileSync(join(shells.home, ".bashrc"), "# bash\n");
		const result = shells.sync();
		if (!posixShells) {
			// Windows: nem rc nem PATH de shell; o `pi.cmd` entra pelo PATH do instalador.
			assert.deepEqual(result.pathFiles, []);
			assert.equal(readFileSync(join(shells.home, ".zshrc"), "utf8"), "export EDITOR=vi");
			assert.equal(readFileSync(join(shells.home, ".bashrc"), "utf8"), "# bash\n");
			return;
		}
		assert.equal(result.pathFiles.length, 2);
		for (const file of [".zshrc", ".bashrc"]) {
			const text = readFileSync(join(shells.home, file), "utf8");
			assert.equal(text.split(PATH_MARKER).length - 1, 1);
			assert.ok(text.includes('PATH="$HOME/.local/bin:$PATH"'));
		}
		assert.ok(readFileSync(join(shells.home, ".zshrc"), "utf8").startsWith("export EDITOR=vi\n"));
		assert.deepEqual(shells.sync().pathFiles, []);
	});

	test("PATH existente fica byte a byte igual", () => {
		const m = machine("existing-path");
		const text = 'export PATH="$HOME/.local/bin:$PATH"\n';
		writeFileSync(join(m.home, ".zshrc"), text);
		m.sync();
		assert.equal(readFileSync(join(m.home, ".zshrc"), "utf8"), text);
		assert.equal(existsSync(join(m.home, ".bashrc")), posixShells);
	});

	test("extensão pessoal adicionada depois substitui só o registro do Mark", () => {
		const m = machine("later-extension");
		m.sync();
		mkdirSync(join(m.agentDir, "extensions"));
		writeFileSync(join(m.agentDir, "extensions", "todos.ts"), "export default function () {}\n");
		const settings = readSettings(m.agentDir);
		settings.extensions.push("/personal/subagent/index.ts");
		writeSettings(m.agentDir, settings);
		m.sync();
		const entries = readSettings(m.agentDir).extensions;
		assert.ok(!entries.some((entry) => entry.startsWith(m.store) && /(?:todos\.ts|subagent)$/.test(entry)));
		assert.ok(entries.includes("/personal/subagent/index.ts"));
	});

	const linksTest = () => {
		const m = machine("links");
		const personal = join(m.home, "personal-agents");
		mkdirSync(personal);
		writeFileSync(join(personal, "worker.md"), "personal");
		symlinkSync(personal, join(m.agentDir, "agents"), "dir");
		symlinkSync(join(repo, "mark/extensions/brain-live"), join(m.agentDir, "extensions"), "dir");
		symlinkSync(join(repo, "mark/themes"), join(m.agentDir, "themes"), "dir");
		const settings = { ...MARK_SETTINGS_DEFAULTS, extensions: ["accounts.ts", "peers", "whimsical.ts", "garime-tui", "-builtin:codemode"] };
		writeSettings(m.agentDir, settings);
		const before = readFileSync(join(m.agentDir, "settings.json"), "utf8");
		assert.equal(m.sync().settingsUpdated, false);
		assert.equal(readFileSync(join(m.agentDir, "settings.json"), "utf8"), before);
		assert.equal(readFileSync(join(personal, "worker.md"), "utf8"), "personal");
		assert.ok(!existsSync(join(personal, AGENTS_MARKER)));
	};
	if (canSymlinkDirs()) test("links pessoais de extensões, temas e papéis ficam intocados", linksTest);
	else skip("links pessoais de extensões, temas e papéis ficam intocados", "sem permissão para link de diretório");

	test("settings ilegível não é reescrito", () => {
		const bad = machine("bad");
		writeFileSync(join(bad.agentDir, "settings.json"), "{ nope");
		const result = bad.sync();
		assert.equal(result.installed, false);
		assert.equal(readFileSync(join(bad.agentDir, "settings.json"), "utf8"), "{ nope");
		assert.ok(!existsSync(join(bad.store, MARK_DIR)));
	});

	test("arquivo removido da fonte desaparece da cópia do store", () => {
		const stale = join(clean.store, MARK_DIR, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE, "intruso.ts");
		writeFileSync(stale, "export default function () {}\n");
		clean.sync();
		assert.ok(!existsSync(stale));
	});

	console.log(`${checks} checks passed${skips ? `, ${skips} skipped` : ""}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
