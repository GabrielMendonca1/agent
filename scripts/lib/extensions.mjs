/**
 * Extensões padrão do Mark.
 *
 * Hoje é só o Megamind (`extensions/megamind/`, mesma extensão que morava em
 * `~/ARCA/arca/extensions/arca-megamind`). Ela viaja no bundle; a cada ativação no store padrão o
 * updater copia para `<store>/extensions/megamind` e garante esse caminho em `extensions[]` do
 * `settings.json` do Pi — e remove qualquer entrada `…/arca-megamind`, porque dois Megaminds
 * carregados ao mesmo tempo registrariam as mesmas tools e comandos duas vezes. Nenhuma outra
 * entrada de `extensions[]` é tocada.
 *
 * O Pi resolve `@earendil-works/*` e `typebox` das extensões por alias do próprio loader
 * (`dist/core/extensions/loader.js`), não por `node_modules` ao lado do arquivo: a extensão roda
 * igual a partir do store.
 *
 * Desligar: ponha `"-megamind"` em `extensions[]` do settings. O updater então não copia nem
 * registra nada (e também não remove a entrada antiga — a escolha é sua).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const EXTENSIONS_DIR = "extensions";
export const MEGAMIND_DIR = "megamind";
/** Basenames que contam como "este Megamind" numa entrada de desligamento. */
const megamindNames = new Set([MEGAMIND_DIR, "arca-megamind"]);
const ignored = new Set([".DS_Store", "node_modules"]);

const trimmed = (entry) => String(entry).replace(/[\\/]+$/, "");
const entryBasename = (entry) => basename(trimmed(entry));

/** Entrada que carregaria outro Megamind: o `arca-megamind` do repo ARCA ou um `extensions/megamind` de outro store. */
const isOtherMegamind = (entry) =>
	typeof entry === "string" &&
	(entryBasename(entry) === "arca-megamind" ||
		(entryBasename(entry) === MEGAMIND_DIR && basename(resolve(trimmed(entry), "..")) === EXTENSIONS_DIR));

/** Arquivos (relativos à raiz do repo) que viajam no bundle do overlay. */
export function extensionFiles(repoRoot) {
	const files = [];
	const walk = (relative) => {
		for (const entry of readdirSync(join(repoRoot, relative), { withFileTypes: true })) {
			if (ignored.has(entry.name) || entry.name.startsWith(".")) continue;
			const child = `${relative}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) files.push(child);
		}
	};
	const root = `${EXTENSIONS_DIR}/${MEGAMIND_DIR}`;
	if (existsSync(join(repoRoot, root))) walk(root);
	return files.sort();
}

/**
 * Copia o Megamind para `<store>/extensions/megamind` e registra o caminho no settings do Pi.
 * Devolve `{ installed, disabled, settingsUpdated, removed }`.
 */
export function syncMarkExtensions({
	sourceRoot,
	store,
	agentDir,
	register = true,
	log = console.log,
	warn = console.warn,
}) {
	const source = join(sourceRoot, EXTENSIONS_DIR, MEGAMIND_DIR);
	const target = resolve(join(store, EXTENSIONS_DIR, MEGAMIND_DIR));
	const settingsFile = join(agentDir, "settings.json");
	if (isMegamindDisabled(settingsFile, warn)) {
		log("Megamind do Mark desligado por \"-megamind\" no settings do Pi; nada instalado");
		return { installed: false, disabled: true, settingsUpdated: false, removed: [] };
	}
	if (!existsSync(source)) {
		warn(`Megamind do Mark não encontrado em ${source}; nada instalado`);
		return { installed: false, disabled: false, settingsUpdated: false, removed: [] };
	}

	// `register: false` (Mark II): só atualiza uma cópia que já existe; o registro é do recibo de recursos.
	if (!register && !existsSync(target)) return { installed: false, disabled: false, settingsUpdated: false, removed: [] };
	const temporary = `${target}.tmp-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(resolve(target, ".."), { recursive: true });
	cpSync(source, temporary, {
		recursive: true,
		filter: (path) => {
			const name = path.split(/[\\/]/).pop();
			return !ignored.has(name) && !name.startsWith(".");
		},
	});
	rmSync(target, { recursive: true, force: true });
	renameSync(temporary, target);

	const { settingsUpdated, removed } = register
		? ensureExtensionEntry(settingsFile, target, warn)
		: { settingsUpdated: false, removed: [] };
	log(`Megamind do Mark: ${target}`);
	return { installed: true, disabled: false, settingsUpdated, removed };
}

/** `true` se o settings tiver uma entrada de desligamento (`-megamind`, `!megamind`, com ou sem caminho). */
export function isMegamindDisabled(file, warn = console.warn) {
	const settings = readSettings(file, "extensions", warn);
	if (!settings) return false;
	const entries = Array.isArray(settings.extensions) ? settings.extensions : [];
	return entries.some(
		(entry) => typeof entry === "string" && /^[-!]/.test(entry) && megamindNames.has(entryBasename(entry.slice(1))),
	);
}

/**
 * Acrescenta `entry` a `extensions[]` e remove as entradas de outro Megamind (`arca-megamind`
 * ou outra cópia de `megamind`); não reescreve um settings ilegível.
 */
export function ensureExtensionEntry(file, entry, warn = console.warn) {
	const settings = readSettings(file, "extensions", warn);
	if (!settings) return { settingsUpdated: false, removed: [] };
	const current = Array.isArray(settings.extensions) ? settings.extensions : [];
	const removed = current.filter((other) => other !== entry && isOtherMegamind(other));
	const kept = current.filter((other) => !removed.includes(other));
	const extensions = kept.includes(entry) ? kept : [...kept, entry];
	if (removed.length === 0 && extensions.length === current.length && extensions.every((x, i) => x === current[i])) {
		return { settingsUpdated: false, removed };
	}
	settings.extensions = extensions;
	mkdirSync(resolve(file, ".."), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	renameSync(temporary, file);
	if (removed.length) warn(`Entrada de outro Megamind removida do settings do Pi: ${removed.join(", ")}`);
	return { settingsUpdated: true, removed };
}

/** Objeto do settings, ou `null` se ilegível (com aviso citando a chave). */
function readSettings(file, key, warn) {
	if (!existsSync(file)) return {};
	let settings;
	try {
		settings = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		warn(`${file} não é JSON válido; ajuste "${key}" à mão`);
		return null;
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		warn(`${file} não é um objeto JSON; ajuste "${key}" à mão`);
		return null;
	}
	return settings;
}
