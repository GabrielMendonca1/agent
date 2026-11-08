/**
 * Setup do Agent: as extensões, os temas e os papéis de subagente que o Gabriel usa.
 *
 * `agent/` é a cópia vendorizada das pastas vivas dele. A cada ativação no store padrão o updater copia a árvore para
 * `<store>/agent/…` e registra no `settings.json` do Pi: cada extensão em `extensions[]`, os temas
 * em `themes[]` e os papéis em `<agent-dir>/agents` — que é o único lugar onde a extensão
 * `subagent` procura papéis de usuário (`getAgentDir()/agents`; não há chave de settings para
 * isso). Também preenche os defaults do Gabriel (modelo, tema, tuiMode…) **apenas** nas chaves que
 * o usuário ainda não escreveu, e garante `~/.local/bin` no PATH do shell.
 *
 * Nada carrega duas vezes. O Pi descobre extensões sozinho em `<agent-dir>/extensions` e carrega
 * as de `extensions[]`; os caminhos são diferentes, então o Pi não deduplica por nome e as mesmas
 * tools/comandos entrariam duas vezes. Por isso uma extensão do Agent cujo nome já exista na pasta
 * auto-carregada do usuário ou numa entrada de `extensions[]` **não** é registrada. Na máquina do
 * Gabriel isso significa nenhuma entrada nova: a pasta dele já tem todas, e `accounts`, `peers`,
 * `whimsical` e `garime-tui` (hoje `tui`) já estão no settings apontando para `~/ARCA/arca/extensions`. O mesmo
 * vale para temas (nome duplicado é colisão de recurso no Pi) e para a pasta de papéis.
 *
 * Duas árvores de extensão: `brain-live/` e `agent/` têm um `lib/` cada, com arquivos de mesmo nome
 * e conteúdo diferente, e cada extensão resolve `../lib` pela sua árvore.
 *
 * Desligar tudo: `"-agent-setup"` em `extensions[]`. Desligar uma extensão: `"-<nome>"`, como em
 * qualquer entrada do Pi — o Agent não registra o que está desligado.
 */
import {
	appendFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export const AGENT_DIR = "agent";
export const EXTENSIONS_SUBDIR = "extensions";
export const THEMES_SUBDIR = "themes";
/**
 * Marcador da pasta de temas: diz quais `.json` são do Agent e podem ser atualizados. Sem sufixo
 * `.json` de propósito — o Pi carrega *todo* `*.json` de `<agent-dir>/themes`, inclusive oculto, e
 * um marcador `.json` virava `Invalid theme ...: expected an object with a "colors" map.` no
 * startup e no `/reload` (docs/themes.md: "Pi reports invalid theme files during startup").
 */
export const THEMES_MARKER = ".agent-themes";
/** Marcador antigo (`.json`), migrado para `THEMES_MARKER` sem perder a propriedade dos temas. */
export const THEMES_MARKER_LEGACY = ".agent-themes.json";
export const AGENTS_SUBDIR = "agents";
/** Cópia de `~/Garime/brain-live/extensions` (a pasta auto-carregada do Gabriel). */
export const BRAIN_LIVE_TREE = "brain-live";
/** Cópia das extensões do Agent (antes `~/ARCA/arca/extensions`; hoje `agent/extensions/agent`). */
export const AGENT_TREE = "agent";
/**
 * Nomes antigos de extensões renomeadas no Agent. A cópia pessoal do usuário (ainda `garime-tui`)
 * é a mesma extensão que `tui`: tratar como nome distinto carregaria as duas.
 */
export const LEGACY_EXTENSION_NAMES = { tui: ["garime-tui"] };
export const legacyNamesOf = (name) => LEGACY_EXTENSION_NAMES[name] ?? [];
/** Marcador da pasta de papéis: diz quais `.md` são do Agent e podem ser atualizados. */
export const AGENTS_MARKER = ".agent-agents.json";
/** Linha de PATH; o marcador é o que torna a escrita no rc idempotente. */
export const PATH_MARKER = "# agent: pi em ~/.local/bin";
const PATH_LINE = `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac`;

/** Defaults do Gabriel; escritos só onde o usuário não tem a chave. */
export const AGENT_SETTINGS_DEFAULTS = {
	defaultProvider: "anthropic",
	defaultModel: "claude-opus-5-5",
	defaultThinkingLevel: "medium",
	theme: "grayscale-baimin-claude-cc-agent-light/grayscale-baimin-claude-cc-agent",
	tuiMode: "fullscreen",
	quietStartup: false,
	hideThinkingBlock: false,
};

// Local build products never travel in the Agent setup bundle.
const ignored = new Set([".DS_Store", "node_modules", "__pycache__", "target"]);
const EXTENSION_SUFFIXES = [".ts", ".js", ".mjs", ".cjs"];
const DISABLED = /^[-!]/;

const copyFilter = (path) => !ignored.has(basename(path));

/** Arquivos de `root`, caminho relativo a `root`, ordenados. */
export function treeFiles(root) {
	if (!existsSync(root)) return [];
	const files = [];
	const walk = (relative) => {
		for (const entry of readdirSync(relative ? join(root, relative) : root, { withFileTypes: true })) {
			if (ignored.has(entry.name)) continue;
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) files.push(child);
		}
	};
	walk("");
	return files.sort();
}

/** Arquivos (relativos à raiz do repo) que viajam no bundle do overlay. */
export function agentSetupFiles(repoRoot) {
	return treeFiles(join(repoRoot, AGENT_DIR)).map((file) => `${AGENT_DIR}/${file}`);
}

/** Nome de recurso de uma entrada de `extensions[]`/`themes[]`: basename sem extensão. */
export function entryName(entry) {
	const normalized = String(entry).replace(/\\/g, "/").replace(/\/+$/, "");
	const name = /^index\.(?:ts|js|mjs|cjs)$/.test(basename(normalized)) ? basename(resolve(normalized, "..")) : basename(normalized);
	const suffix = EXTENSION_SUFFIXES.find((end) => name.endsWith(end));
	return suffix ? name.slice(0, -suffix.length) : name;
}

/** `true` se `dir` é um ponto de entrada de extensão (index.ts/js ou package.json com `pi.extensions`). */
function isExtensionDir(dir) {
	if (existsSync(join(dir, "index.ts")) || existsSync(join(dir, "index.js"))) return true;
	try {
		return Array.isArray(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.pi?.extensions);
	} catch {
		return false;
	}
}

/**
 * Extensões diretamente sob `dir`, como o Pi as descobre: arquivo `.ts`/`.js` ou subdiretório com
 * ponto de entrada. Devolve `[{ name, path }]`; um `lib/` sem index não é extensão.
 */
export function extensionsIn(dir) {
	if (!existsSync(dir)) return [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		if (ignored.has(entry.name) || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:ts|js)$/.test(entry.name)) {
			found.push({ name: entryName(entry.name), path });
			continue;
		}
		if ((entry.isDirectory() || entry.isSymbolicLink()) && isExtensionDir(path)) found.push({ name: entry.name, path });
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Temas de `dir`: `[{ name, path }]`, com o nome declarado no JSON quando legível. */
export function themesIn(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json") && name !== THEMES_MARKER_LEGACY)
		.map((file) => {
			const path = join(dir, file);
			let name = file.slice(0, -".json".length);
			try {
				const declared = JSON.parse(readFileSync(path, "utf8"))?.name;
				if (typeof declared === "string" && declared) name = declared;
			} catch {
				/* tema ilegível: vale o nome do arquivo */
			}
			return { name, path };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Nomes que o usuário já carrega por uma lista de settings, ignorando o que o Agent instalou. */
function namesFromSettings(entries, ownRoot) {
	const names = new Set();
	for (const entry of entries) {
		if (typeof entry !== "string" || DISABLED.test(entry)) continue;
		const path = entry.startsWith("+") ? entry.slice(1) : entry;
		if (resolve(path).startsWith(ownRoot)) continue;
		names.add(entryName(path));
	}
	return names;
}

/** Nomes desligados por `-nome`/`!nome` numa lista de settings. */
function disabledNames(entries) {
	const names = new Set();
	for (const entry of entries) {
		if (typeof entry === "string" && DISABLED.test(entry)) names.add(entryName(entry.slice(1)));
	}
	return names;
}

const asList = (value) => (Array.isArray(value) ? value : []);

/** Objeto do settings, ou `null` se ilegível (com aviso). */
function readSettings(file, warn) {
	if (!existsSync(file)) return {};
	let settings;
	try {
		settings = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		warn(`${file} não é JSON válido; o setup do Agent não foi registrado`);
		return null;
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		warn(`${file} não é um objeto JSON; o setup do Agent não foi registrado`);
		return null;
	}
	return settings;
}

function writeJsonFile(file, data) {
	mkdirSync(resolve(file, ".."), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(temporary, file);
}

/** Substitui `target` pelo conteúdo de `source` numa troca atômica. */
function replaceTree(source, target) {
	const temporary = `${target}.tmp-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(resolve(target, ".."), { recursive: true });
	cpSync(source, temporary, { recursive: true, dereference: true, filter: copyFilter });
	rmSync(target, { recursive: true, force: true });
	renameSync(temporary, target);
}

/** `true` se o settings desliga o setup inteiro (`-agent-setup`). */
export function isAgentSetupDisabled(settings) {
	return disabledNames(asList(settings?.extensions)).has("agent-setup");
}

/** Preenche em `settings` os defaults do Agent que faltam; devolve as chaves escritas. */
export function applyDefaults(settings) {
	const written = [];
	for (const [key, value] of Object.entries(AGENT_SETTINGS_DEFAULTS)) {
		if (key in settings) continue;
		settings[key] = value;
		written.push(key);
	}
	return written;
}

/**
 * Acrescenta a linha de PATH nos rc do shell que ainda não a têm.
 * Cria ambos os rc quando ausentes; preserva PATH já configurado.
 */
export function ensureLocalBinOnPath({ homeDir, log = console.log, warn = console.warn }) {
	if (process.platform === "win32") return [];
	const candidates = [join(homeDir, ".zshrc"), join(homeDir, ".bashrc")];
	const targets = candidates;
	const written = [];
	for (const file of targets) {
		try {
			const current = existsSync(file) ? readFileSync(file, "utf8") : "";
			if (current.includes(PATH_MARKER) || current.split("\n").some((line) =>
				!line.trimStart().startsWith("#") && /(?:export\s+)?PATH=.*(?:\$HOME|\$\{HOME\}|~)\/\.local\/bin/.test(line)
			)) continue;
			appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${PATH_MARKER}\n${PATH_LINE}\n`);
			written.push(file);
		} catch (error) {
			warn(`não deu para garantir ~/.local/bin no PATH em ${file}: ${error.message}`);
		}
	}
	if (written.length) log(`~/.local/bin no PATH: ${written.join(", ")} (vale num terminal novo)`);
	return written;
}

/**
 * Instala os papéis de subagente em `<agent-dir>/agents`, o único lugar onde a extensão `subagent`
 * procura papéis de usuário. Uma pasta que já existe e não é do Agent (a do Gabriel é um link para
 * `~/Sistema/Pi/agents`) fica intocada.
 */
/**
 * Copia os temas do Agent para `<agent-dir>/themes`, sem tocar em tema que a pessoa já tem (por
 * nome, na pasta ou em `themes[]`) nem numa pasta que é symlink dela. Um marcador lembra quais
 * arquivos são do Agent para atualizá-los e retirar os que saíram do Agent.
 */
export function installThemes({ source, agentDir, settingsThemes = [], homeDir = homedir(), log = console.log }) {
	const vendored = themesIn(source);
	if (vendored.length === 0) return { installed: [], skipped: [] };
	const target = join(agentDir, THEMES_SUBDIR);
	const marker = join(target, THEMES_MARKER);
	const legacyMarker = join(target, THEMES_MARKER_LEGACY);
	let isLink = false;
	try {
		isLink = lstatSync(target).isSymbolicLink();
	} catch {
		isLink = false;
	}
	if (isLink) {
		log(`Temas do Agent não instalados: ${target} já é seu`);
		return { installed: [], skipped: vendored.map((theme) => theme.name) };
	}
	// O marcador antigo valia como propriedade: ler dele quando o novo ainda não existe mantém os
	// temas já instalados sob controle do Agent (em vez de virarem "pessoais" e congelarem).
	const markerFile = existsSync(marker) ? marker : existsSync(legacyMarker) ? legacyMarker : undefined;
	const previous = (markerFile ? asList(readSettings(markerFile, () => {})?.themes) : [])
		.filter((name) => typeof name === "string" && basename(name) === name);
	const taken = new Set([
		...themesIn(target).map((theme) => theme.name).filter((name) => !previous.includes(name)),
		...settingsThemes.filter((entry) => typeof entry === "string" && !DISABLED.test(entry))
			.flatMap((entry) => {
				const path = entry.startsWith("~/") ? join(homeDir, entry.slice(2)) : resolve(agentDir, entry.replace(/^\+/, ""));
				// A própria pasta de instalação em `themes[]` não torna os temas do Agent "pessoais": seria
				// uma colisão do Agent com ele mesmo, instalando e tirando a cada ativação.
				if (path === target || path.startsWith(`${target}${sep}`)) return [];
				try {
					return lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()
						? themesIn(path).map((theme) => theme.name)
						: [JSON.parse(readFileSync(path, "utf8")).name];
				} catch { return [entryName(entry).replace(/\.json$/, "")]; }
			}),
		...disabledNames(settingsThemes),
	]);
	mkdirSync(target, { recursive: true });
	for (const stale of previous) {
		if (!vendored.some((theme) => theme.name === stale)) rmSync(join(target, `${stale}.json`), { force: true });
	}
	const installed = [];
	const skipped = [];
	for (const theme of vendored) {
		if (taken.has(theme.name)) {
			skipped.push(theme.name);
			// A cópia que o marcador prova ser do Agent cede o nome ao tema da pessoa: dois arquivos com
			// o mesmo nome seriam colisão de recurso no Pi, e deixá-la fora do marcador a congelaria
			// para sempre. Tirado o tema pessoal, a próxima ativação instala de novo e atualizada.
			// Tema que não está no marcador é da pessoa e não se toca.
			if (previous.includes(theme.name)) rmSync(join(target, `${theme.name}.json`), { force: true });
			continue;
		}
		cpSync(theme.path, join(target, `${theme.name}.json`));
		installed.push(theme.name);
	}
	writeJsonFile(marker, { themes: installed });
	// Só depois do marcador novo gravado: o antigo é do Agent (nome próprio) e o Pi tentava carregá-lo
	// como tema.
	if (existsSync(legacyMarker)) rmSync(legacyMarker, { force: true });
	return { installed, skipped };
}

export function installAgents({ source, agentDir, log = console.log }) {
	const names = existsSync(source) ? readdirSync(source).filter((name) => name.endsWith(".md")).sort() : [];
	if (names.length === 0) return { installed: [], skipped: true };
	const target = join(agentDir, AGENTS_SUBDIR);
	const marker = join(target, AGENTS_MARKER);
	let exists = false;
	try {
		exists = Boolean(lstatSync(target));
	} catch {
		exists = false;
	}
	if (exists && (lstatSync(target).isSymbolicLink() || !existsSync(marker))) {
		log(`Papéis de subagente do Agent não instalados: ${target} já é seu (${names.join(", ")} ficam em <store>/agent/agents)`);
		return { installed: [], skipped: true };
	}
	const previous = (existsSync(marker) ? asList(readSettings(marker, () => {})?.agents) : [])
		.filter((name) => typeof name === "string" && basename(name) === name && name.endsWith(".md"));
	mkdirSync(target, { recursive: true });
	for (const stale of previous) {
		if (!names.includes(stale)) rmSync(join(target, stale), { force: true });
	}
	const installed = [];
	for (const name of names) {
		if (existsSync(join(target, name)) && !previous.includes(name)) continue;
		cpSync(join(source, name), join(target, name));
		installed.push(name);
	}
	writeJsonFile(marker, { agents: installed });
	log(`Papéis de subagente do Agent: ${names.join(", ")} (${target})`);
	return { installed, skipped: false };
}

/**
 * Copia `agent/` para `<store>/agent`, registra extensões e temas em `settings.json` sem duplicar o
 * que o usuário já carrega, instala os papéis de subagente, preenche os defaults que faltam e
 * garante `~/.local/bin` no PATH.
 */
export function syncAgentSetup({ sourceRoot, store, agentDir, homeDir, log = console.log, warn = console.warn }) {
	const empty = {
		installed: false,
		disabled: false,
		extensions: [],
		skippedExtensions: [],
		themes: [],
		skippedThemes: [],
		agents: [],
		defaults: [],
		pathFiles: [],
		settingsUpdated: false,
	};
	const source = join(sourceRoot, AGENT_DIR);
	const settingsFile = join(agentDir, "settings.json");
	const settings = readSettings(settingsFile, warn);
	if (!settings) return empty;
	if (isAgentSetupDisabled(settings)) {
		log('Setup do Agent desligado por "-agent-setup" no settings do Pi; nada instalado');
		return { ...empty, disabled: true };
	}
	if (!existsSync(source)) {
		warn(`Setup do Agent não encontrado em ${source}; nada instalado`);
		return empty;
	}

	const target = resolve(join(store, AGENT_DIR));
	replaceTree(source, target);
	const ownRoot = `${target}${sep}`;

	// Extensões: candidatas das duas árvores, menos as que o usuário já carrega ou desligou.
	// Web viaja no bundle, mas só carrega por -e explícito.
	const candidates = [
		...extensionsIn(join(target, EXTENSIONS_SUBDIR, AGENT_TREE)).filter((extension) => extension.name !== "web"),
		...extensionsIn(join(target, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE)),
	];
	const originalExtensions = asList(settings.extensions);
	const settingsExtensions = originalExtensions.filter((entry) =>
		typeof entry !== "string" || !resolve(entry).startsWith(ownRoot));
	const taken = new Set([
		...extensionsIn(join(agentDir, EXTENSIONS_SUBDIR)).map((extension) => extension.name),
		...namesFromSettings(settingsExtensions, ownRoot),
		...disabledNames(settingsExtensions),
	]);
	// Entrada já presente (ativação anterior) não é recolocada: a lista não cresce a cada update.
	const present = new Set(settingsExtensions.filter((entry) => typeof entry === "string").map((entry) => resolve(entry)));
	const extensions = [];
	const skippedExtensions = [];
	const seen = new Set();
	for (const candidate of candidates) {
		if (seen.has(candidate.name)) continue;
		seen.add(candidate.name);
		if ([candidate.name, ...legacyNamesOf(candidate.name)].some((name) => taken.has(name))) skippedExtensions.push(candidate.name);
		else if (!present.has(resolve(candidate.path))) extensions.push(candidate);
	}

	// Temas: copiados para <agent-dir>/themes, o único lugar que o Pi resolve na inicialização
	// (`themes[]` só entra no registro depois do initTheme e deixa o tema do settings "not found").
	const themesDir = join(target, THEMES_SUBDIR);
	const originalThemes = asList(settings.themes);
	const settingsThemes = originalThemes.filter((entry) =>
		typeof entry !== "string" || !resolve(entry).startsWith(ownRoot));
	const themeInstall = installThemes({ source: themesDir, agentDir, settingsThemes, homeDir, log });
	const skippedThemes = themeInstall.skipped;
	const newThemeEntries = themeInstall.installed;

	const before = JSON.stringify(settings);
	const nextExtensions = [...settingsExtensions, ...extensions.map((e) => e.path)];
	// The Agent wrapper owns codemode; never load the stock registration beside it.
	if (!disabledNames(settingsExtensions).has("codemode-mode") &&
		(extensions.some((e) => e.name === "codemode-mode") || taken.has("codemode-mode"))) {
		for (let i = nextExtensions.length - 1; i >= 0; i--) {
			if (["+builtin:codemode", "-builtin:codemode", "builtin:codemode"].includes(nextExtensions[i])) nextExtensions.splice(i, 1);
		}
		nextExtensions.push("-builtin:codemode");
	}
	if (JSON.stringify(nextExtensions) !== JSON.stringify(originalExtensions)) settings.extensions = nextExtensions;
	if (JSON.stringify(settingsThemes) !== JSON.stringify(originalThemes)) {
		if (settingsThemes.length) settings.themes = settingsThemes;
		else delete settings.themes;
	}
	const defaults = applyDefaults(settings);
	const settingsUpdated = JSON.stringify(settings) !== before;
	if (settingsUpdated) writeJsonFile(settingsFile, settings);

	const agents = installAgents({ source: join(target, AGENTS_SUBDIR), agentDir, log });
	const pathFiles = ensureLocalBinOnPath({ homeDir, log, warn });

	if (extensions.length) log(`Extensões do Agent registradas: ${extensions.map((e) => e.name).join(", ")}`);
	if (skippedExtensions.length) {
		log(`Extensões do Agent não registradas porque você já as carrega: ${skippedExtensions.join(", ")}`);
	}
	if (newThemeEntries.length) log(`Temas do Agent: ${newThemeEntries.join(", ")} (${join(agentDir, THEMES_SUBDIR)})`);
	if (skippedThemes.length) log(`Temas do Agent não instalados porque você já os tem: ${skippedThemes.join(", ")}`);
	if (defaults.length) log(`Defaults do Agent escritos (chaves que você não tinha): ${defaults.join(", ")}`);
	log(`Setup do Agent: ${target}`);
	return {
		installed: true,
		disabled: false,
		extensions: extensions.filter((extension) => !originalExtensions.includes(extension.path)).map((extension) => extension.name),
		skippedExtensions,
		themes: newThemeEntries,
		skippedThemes,
		agents: agents.installed,
		defaults,
		pathFiles,
		settingsUpdated,
	};
}
