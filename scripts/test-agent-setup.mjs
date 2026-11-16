#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENTS_MARKER,
	AGENTS_SUBDIR,
	AGENT_TREE,
	BRAIN_LIVE_TREE,
	EXTENSIONS_SUBDIR,
	AGENT_DIR,
	AGENT_SETTINGS_DEFAULTS,
	PATH_MARKER,
	THEMES_MARKER,
	THEMES_MARKER_LEGACY,
	THEMES_SUBDIR,
	extensionsIn,
	agentSetupFiles,
	syncAgentSetup,
	themesIn,
} from "./lib/agent-setup.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "agent-setup-test-"));
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
	return { home, agentDir, store, sync: (extra = {}) => syncAgentSetup({ sourceRoot: repo, store, agentDir, homeDir: home, ...quiet, ...extra }) };
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
		const files = agentSetupFiles(repo);
		for (const file of [
			`${AGENT_DIR}/${EXTENSIONS_SUBDIR}/${BRAIN_LIVE_TREE}/subagent/index.ts`,
			`${AGENT_DIR}/${EXTENSIONS_SUBDIR}/${BRAIN_LIVE_TREE}/lib/paths.ts`,
			`${AGENT_DIR}/${EXTENSIONS_SUBDIR}/${AGENT_TREE}/accounts.ts`,
			`${AGENT_DIR}/${EXTENSIONS_SUBDIR}/${AGENT_TREE}/tui/index.ts`,
			`${AGENT_DIR}/${EXTENSIONS_SUBDIR}/${AGENT_TREE}/peers/package.json`,
			`${AGENT_DIR}/${THEMES_SUBDIR}/grayscale-baimin-claude-cc-agent.json`,
			`${AGENT_DIR}/${AGENTS_SUBDIR}/worker.md`,
		]) {
			assert.ok(files.includes(file), `falta no bundle: ${file}`);
		}
		// Nada de segredo nem de sessão viaja.
		assert.ok(!files.some((file) => /\/(?:auth\.json|accounts.*\.json|mcp\.json|models\.json)$|\.log$|\/durable-sessions\//.test(file)));
		assert.ok(files.includes("agent/juice/client.mjs"), "cliente do piloto viaja com suas extensões");
	});

	test("o vault-runtime vendorizado degrada quieto sem ~/Sistema/Pi", () => {
		const file = join(repo, AGENT_DIR, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE, "vault-runtime.ts");
		const source = readFileSync(file, "utf8");
		assert.ok(source.includes("if (!existsSync(root)) return { skills: 0, errors: [] };"));
		assert.ok(source.includes('if (!existsSync(PI_VAULT_DIR)) return;'));
	});

	test("as libs usadas nas duas árvores estão na cópia", () => {
		const files = new Set(agentSetupFiles(repo));
		// Mesmo nome, árvore diferente: o que tem consumidor em cada uma continua vendorizado lá.
		for (const kept of [
			`${BRAIN_LIVE_TREE}/lib/tiers.ts`,
			`${BRAIN_LIVE_TREE}/lib/compaction-epoch.ts`,
			`${BRAIN_LIVE_TREE}/lib/cost-ledger.ts`,
			`${BRAIN_LIVE_TREE}/lib/paths.ts`,
			`${BRAIN_LIVE_TREE}/lib/durable-sessions.ts`,
			`${BRAIN_LIVE_TREE}/lib/image-normalize.ts`,
			`${AGENT_TREE}/lib/json-file.ts`,
			`${AGENT_TREE}/lib/image-normalize.ts`,
			`${AGENT_TREE}/lib/prompt-slot.ts`,
			`${AGENT_TREE}/lib/secret-scan.ts`,
		]) {
			assert.ok(files.has(`${AGENT_DIR}/${EXTENSIONS_SUBDIR}/${kept}`), `falta no bundle: ${kept}`);
		}
	});

	test("lib/ e sessions.md não contam como extensão; peers entra pelo package.json", () => {
		const tree = join(repo, AGENT_DIR, EXTENSIONS_SUBDIR);
		const names = extensionsIn(join(tree, BRAIN_LIVE_TREE)).map((extension) => extension.name);
		assert.ok(!names.includes("lib"));
		assert.ok(!names.includes("sessions.md"));
		assert.ok(names.includes("sessions"));
		assert.deepEqual(extensionsIn(join(tree, AGENT_TREE)).map((e) => e.name), ["accounts", "peers", "skim", "tui", "web", "whimsical"]);
	});

	const clean = machine("clean");
	let cleanResult;
	test("HOME limpa: instala, registra tudo e preenche os defaults", () => {
		cleanResult = clean.sync();
		assert.equal(cleanResult.installed, true);
		assert.deepEqual(cleanResult.skippedExtensions, []);
		const settings = readSettings(clean.agentDir);
		const registered = new Set(
			[BRAIN_LIVE_TREE, AGENT_TREE]
				.flatMap((tree) => extensionsIn(join(clean.store, AGENT_DIR, EXTENSIONS_SUBDIR, tree)))
				.filter((extension) => extension.name !== "web")
				.map((extension) => extension.name),
		);
		assert.equal(settings.extensions.length, registered.size + 1);
		assert.ok(settings.extensions.includes("-builtin:codemode"));
		assert.ok(registered.has("codemode-mode"));
		assert.ok(settings.extensions.every((entry) => entry === "-builtin:codemode" || entry.startsWith(join(clean.store, AGENT_DIR))));
		// Um nome por extensão.
		const names = settings.extensions.map((entry) => entry.split("/").pop().replace(/\.ts$/, ""));
		assert.equal(new Set(names).size, names.length);
		assert.equal(settings.themes, undefined);
		assert.ok(existsSync(join(clean.agentDir, THEMES_SUBDIR, "grayscale-baimin-claude-cc-agent.json")));
		assert.equal(cleanResult.themes.length, themesIn(join(repo, AGENT_DIR, THEMES_SUBDIR)).length);
		for (const [key, value] of Object.entries(AGENT_SETTINGS_DEFAULTS)) assert.deepEqual(settings[key], value);
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
		for (const { name } of extensionsIn(join(repo, AGENT_DIR, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE))) {
			if (name === "subagent") continue;
			writeFileSync(join(auto, `${name}.ts`), "export default function () {}\n");
		}
		// Temas auto-carregados com os mesmos nomes.
		const themes = join(gabriel.agentDir, THEMES_SUBDIR);
		mkdirSync(themes, { recursive: true });
		for (const theme of themesIn(join(repo, AGENT_DIR, THEMES_SUBDIR))) {
			writeFileSync(join(themes, `${theme.name}.json`), `${JSON.stringify({ name: theme.name })}\n`);
		}
		// Papéis próprios e as entradas da ARCA no settings, como na máquina dele.
		mkdirSync(join(gabriel.agentDir, AGENTS_SUBDIR), { recursive: true });
		writeFileSync(join(gabriel.agentDir, AGENTS_SUBDIR, "worker.md"), "meu worker\n");
		const original = {
			theme: "grayscale-baimin-claude-cc-agent-light/grayscale-baimin-claude-cc-agent",
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
		// skim não existe na ARCA dele: é a única extensão do Agent registrada, uma vez.
		assert.deepEqual(result.extensions, ["skim"]);
		assert.deepEqual(result.themes, []);
		assert.deepEqual(result.agents, []);
		assert.equal(result.settingsUpdated, true); // os defaults que ele não tinha e o skim
		const settings = readSettings(gabriel.agentDir);
		const skimPath = join(gabriel.store, AGENT_DIR, EXTENSIONS_SUBDIR, AGENT_TREE, "skim");
		assert.deepEqual(settings.extensions.filter((entry) => entry !== skimPath), [...original.extensions, "-builtin:codemode"]);
		assert.equal(settings.extensions.filter((entry) => entry === skimPath).length, 1);
		assert.equal(settings.themes, undefined);
		assert.equal(settings.theme, original.theme);
		assert.equal(readFileSync(join(gabriel.agentDir, AGENTS_SUBDIR, "worker.md"), "utf8"), "meu worker\n");
		assert.ok(!existsSync(join(gabriel.agentDir, AGENTS_SUBDIR, "planner.md")));
		assert.deepEqual(result.skippedThemes.length, themesIn(join(repo, AGENT_DIR, THEMES_SUBDIR)).length);
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
		settings.themes = [join(repo, "agent/themes")];
		writeSettings(m.agentDir, settings);
		const again = m.sync();
		assert.deepEqual(readSettings(m.agentDir).themes, [join(repo, "agent/themes")]);
		assert.deepEqual(again.themes, []);
		// A cópia gerenciada sai de cena para o tema que a pessoa carrega: dois arquivos com o mesmo
		// nome seriam colisão de recurso no Pi.
		const themes = join(m.agentDir, THEMES_SUBDIR);
		assert.deepEqual(readdirSync(themes).filter((name) => name.endsWith(".json")), []);
		assert.deepEqual(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes, []);
	});

	test("descolisão: tirado o tema pessoal, o Agent volta a instalar e atualizar o dele", () => {
		const m = machine("collide");
		const first = m.sync();
		const themes = join(m.agentDir, THEMES_SUBDIR);
		const mine = themesIn(join(repo, AGENT_DIR, THEMES_SUBDIR))[0].name;
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
		assert.ok(!existsSync(join(themes, `${mine}.json`)), "a cópia do Agent cede o nome");
		assert.ok(!JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes.includes(mine));
		assert.equal(readFileSync(join(personalDir, `${mine}.json`), "utf8"), `${JSON.stringify({ name: mine, colors: {} })}\n`);

		// Retirado o tema pessoal, a atualização do Agent retoma sem duplicata.
		const back = readSettings(m.agentDir);
		delete back.themes;
		writeSettings(m.agentDir, back);
		const resumed = m.sync();
		assert.ok(resumed.themes.includes(mine));
		assert.equal(readFileSync(join(themes, `${mine}.json`), "utf8"), managed);
		assert.ok(JSON.parse(readFileSync(join(themes, THEMES_MARKER), "utf8")).themes.includes(mine));
	});

	test("a própria pasta de temas em settings.themes não colide com o Agent", () => {
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

	test("marcador antigo .agent-themes.json migra sem perder a propriedade dos temas", () => {
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
		// Os temas continuam do Agent (atualizados), e o tema da pessoa fica como está.
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

	test('"-agent-setup" desliga tudo; "-<nome>" desliga uma extensão', () => {
		const off = machine("off");
		writeSettings(off.agentDir, { extensions: ["-agent-setup"] });
		const result = off.sync();
		assert.equal(result.disabled, true);
		assert.ok(!existsSync(join(off.store, AGENT_DIR)));
		assert.deepEqual(readSettings(off.agentDir), { extensions: ["-agent-setup"] });

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

	test("extensão pessoal adicionada depois substitui só o registro do Agent", () => {
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
		symlinkSync(join(repo, "agent/extensions/brain-live"), join(m.agentDir, "extensions"), "dir");
		symlinkSync(join(repo, "agent/themes"), join(m.agentDir, "themes"), "dir");
		const settings = { ...AGENT_SETTINGS_DEFAULTS, extensions: ["accounts.ts", "peers", "skim", "whimsical.ts", "garime-tui", "-builtin:codemode"] };
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
		assert.ok(!existsSync(join(bad.store, AGENT_DIR)));
	});

	test("arquivo removido da fonte desaparece da cópia do store", () => {
		const stale = join(clean.store, AGENT_DIR, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE, "intruso.ts");
		writeFileSync(stale, "export default function () {}\n");
		clean.sync();
		assert.ok(!existsSync(stale));
	});

	console.log(`${checks} checks passed${skips ? `, ${skips} skipped` : ""}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
