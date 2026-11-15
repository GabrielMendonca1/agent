/**
 * Registros de recursos do Agent: planejar, aplicar e desfazer a carga das extensões/skills/temas
 * do artefato imutável (`<artifactRoot>/agent`) no `agentDir` real do usuário, **uma única vez**.
 *
 * Por que não basta copiar e registrar (o que `syncAgentSetup` faz): a pasta auto-descoberta do
 * usuário (`<agent-dir>/extensions`) tem versões antigas das mesmas extensões. O Pi não deduplica
 * por nome — só por `realpath` (`toResolvedPaths` → `canonicalizePath`) —, então uma cópia nova no
 * artefato e a cópia pessoal antiga carregariam as **duas**, duplicando tools e commands. E o
 * `syncAgentSetup` resolve isso cedendo o nome à cópia pessoal, o que deixa o Agent desligado.
 *
 * O que este helper faz: registra o caminho do artefato em `settings.extensions` e **desliga a
 * descoberta automática pessoal daquele nome com uma exclusão explícita** — sem renomear, mover ou
 * apagar arquivo nenhum do usuário. As duas formas de exclusão foram medidas no SDK instalado
 * (`DefaultResourceLoader` do host clássico):
 *
 * - auto-descoberta: `-extensions/<nome>/index.ts` (caminho relativo ao `agentDir`), a mesma forma
 *   que o Gabriel já usa à mão no settings dele;
 * - entrada explícita de `extensions[]`: `-<caminho absoluto do arquivo de entrada>`.
 *
 * Em `applyPatterns`/`isEnabledByOverrides` (dist/core/package-manager.js) `-x` é exclusão exata
 * (compara `relative(baseDir,path)` e o caminho absoluto em POSIX) e vence `+x`; `!x` é glob. Por
 * isso as exclusões emitidas aqui apontam para o **arquivo de entrada** (`index.ts`/`.js`/entradas
 * de `pi.extensions`), não para a pasta.
 *
 * Skills e temas são tratados de forma conservadora:
 * - skills: `<agentRoot>/skills` entra em `settings.skills`. No host clássico uma entrada de settings
 *   (rank 2) vence a skill auto-descoberta de mesmo nome (rank 3).
 *   Colisões são relatadas, nunca silenciadas.
 * - temas: só cópia de arquivo ausente para `<agent-dir>/themes` quando essa pasta é real (não
 *   symlink pessoal) e o nome não é de um tema do usuário; `settings.theme` e os temas pessoais
 *   nunca são tocados.
 *
 * Keybindings: apenas app.thinking.cycle/shift+tab é gerenciada reversivelmente
 * para alternar simple/complex. Ctrl+T permanece nativo do Pi.
 *
 * Nada de SYSTEM.md/auth/Vault/models, defaults, papéis, rc de shell ou settings pessoais fora de
 * `extensions`/`skills` e das keybindings declaradas. O relatório carrega só caminhos e nomes —
 * nunca o settings inteiro.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENT_TREE, BRAIN_LIVE_TREE, EXTENSIONS_SUBDIR, THEMES_SUBDIR, entryName, extensionsIn, isAgentSetupDisabled, legacyNamesOf, themesIn } from "./agent-setup.mjs";

export const PLAN_VERSION = 1;
export const RECEIPT_VERSION = 1;
export const RECEIPT_NAME = "agent-resources-receipt.json";
/** Recursos removidos do artefato cujas cópias pessoais continuam desligadas pelo recibo. */
export const RETIRED_EXTENSIONS = ["ipython", "read-media"];

/** Chaves de settings que este helper pode escrever. Nada mais é lido para o plano nem gravado. */
export const MANAGED_SETTINGS_KEYS = ["extensions", "skills"];
/** Arquivo e keybindings gerenciadas: ação reservada → tecla que o Agent assume. */
export const KEYBINDINGS_FILE = "keybindings.json";
export const MANAGED_SHORTCUTS = { "app.thinking.cycle": "shift+tab" };
export const MANAGED_KEYBINDINGS = Object.keys(MANAGED_SHORTCUTS);
/** Compat: primeiro atalho gerenciado (o do modo), mantido para quem já importava o nome. */
export const AGENT_SHORTCUT = MANAGED_SHORTCUTS["app.thinking.cycle"];
/** Nomes legados migrados pelo SDK (`KEYBINDING_NAME_MIGRATIONS`) para as ações canônicas. */
const LEGACY_KEYBINDING_NAMES = { "app.thinking.cycle": "cycleThinkingLevel" };
const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

const DISABLED = /^[-!]/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashValue = (value) => sha256(JSON.stringify(value === undefined ? null : value));
const toPosix = (value) => value.split(sep).join("/");
const asList = (value) => (Array.isArray(value) ? value : []);

function assertAbsolute(label, value) {
	if (typeof value !== "string" || !value || !isAbsolute(value)) throw new Error(`${label} precisa ser caminho absoluto: ${value}`);
	return resolve(value);
}

function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Arquivos de entrada de uma pasta de extensão, como o SDK resolve (`resolveExtensionEntries`). */
export function extensionEntryFiles(path) {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return [];
	}
	if (stats.isFile()) return /\.(?:ts|js)$/.test(path) ? [resolve(path)] : [];
	if (!stats.isDirectory()) return [];
	try {
		const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"))?.pi?.extensions;
		if (Array.isArray(manifest) && manifest.length) {
			const entries = manifest.map((entry) => resolve(path, entry)).filter((entry) => existsSync(entry));
			if (entries.length) return entries;
		}
	} catch {
		/* sem package.json legível: cai no index */
	}
	for (const index of ["index.ts", "index.js"]) {
		if (existsSync(join(path, index))) return [resolve(path, index)];
	}
	return [];
}

/**
 * Extensões auto-descobertas em `<agentDir>/extensions`, com os arquivos de entrada que o Pi
 * registra (é neles que a exclusão exata precisa bater).
 */
export function autoDiscoveredExtensions(agentDir) {
	const dir = join(agentDir, EXTENSIONS_SUBDIR);
	const own = extensionEntryFiles(dir);
	if (own.length) return [{ name: basename(dir), path: dir, entries: own }];
	return extensionsIn(dir).map((extension) => ({ ...extension, entries: extensionEntryFiles(extension.path) }));
}

/**
 * Contrato comum à instalação e ao perfil temporário: as duas árvores do Agent,
 * `agent` primeiro, sem repetir nome. Registrar as fábricas originais preserva
 * a exposição declarada por cada tool; este planner não cria wrappers.
 */
export function agentExtensionCandidates(agentRoot) {
	const candidates = [
		...extensionsIn(join(agentRoot, EXTENSIONS_SUBDIR, AGENT_TREE)),
		...extensionsIn(join(agentRoot, EXTENSIONS_SUBDIR, BRAIN_LIVE_TREE)),
		...extensionsIn(join(agentRoot, EXTENSIONS_SUBDIR, "standard")),
	];
	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.name)) continue;
		seen.add(candidate.name);
		unique.push({ ...candidate, entries: extensionEntryFiles(candidate.path) });
	}
	return unique;
}

/** Caminho absoluto de uma entrada de settings (`~`, relativo ao agentDir, prefixos `+-!`). */
function resolveSettingsEntry(entry, { agentDir, homeDir }) {
	const raw = String(entry).replace(/^[+\-!]/, "");
	if (raw.startsWith("~/")) return resolve(homeDir, raw.slice(2));
	return resolve(agentDir, raw);
}

/** Identidade de um alias explícito que SOMENTE reexporta default; nunca executa código pessoal. */
function explicitExtensionName(path) {
	const fallback = entryName(path);
	let current = path;
	const seen = new Set();
	for (let depth = 0; depth < 8; depth++) {
		if (seen.has(current)) return fallback;
		seen.add(current);
		try {
			if (!/\.(?:ts|js)$/.test(current) || !statSync(current).isFile() || statSync(current).size > 8192) break;
			const source = readFileSync(current, "utf8");
			const match = source.match(/^\s*export\s*\{\s*default\s*\}\s*from\s*(["'])([^"'\r\n]+)\1\s*;?\s*$/);
			if (!match || !(isAbsolute(match[2]) || match[2].startsWith("."))) break;
			const target = resolve(dirname(current), match[2]);
			if (!/\.(?:ts|js)$/.test(target)) break;
			current = target;
		} catch { break; }
	}
	return entryName(current);
}

/** Mesma leitura de tecla do SDK: minúsculas, modificadores em qualquer ordem (`shift+tab`/`tab+shift`). */
function parseKey(key) {
	const parts = key.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
	const base = parts.filter((part) => !KEY_MODIFIERS.has(part));
	return { base, modifiers: new Set(parts.filter((part) => KEY_MODIFIERS.has(part))) };
}

/** `candidate` é a mesma tecla que `shortcut` (ordem/caixa dos modificadores são irrelevantes)? */
function isSameKey(candidate, shortcut) {
	if (typeof candidate !== "string") return false;
	const left = parseKey(candidate);
	const right = parseKey(shortcut);
	if (left.base.length !== 1 || right.base.length !== 1 || left.base[0] !== right.base[0]) return false;
	if (left.modifiers.size !== right.modifiers.size) return false;
	for (const modifier of right.modifiers) if (!left.modifiers.has(modifier)) return false;
	return true;
}

/**
 * Plano das keybindings gerenciadas: suspender só a tecla reservada de cada ação
 * (`shift+tab` de `app.thinking.cycle`, `ctrl+t` de `app.thinking.toggle`) sem mexer em mais
 * nenhuma tecla nem em nenhuma outra ação do arquivo pessoal.
 */
function planKeybindings({ agentDir, limitations }) {
	const path = join(agentDir, KEYBINDINGS_FILE);
	const exists = existsSync(path);
	let raw = {};
	if (exists) {
		const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`${path} não é JSON válido; Agent não pode suspender ${MANAGED_KEYBINDINGS.join("/")} com segurança`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} não é um objeto JSON`);
		raw = parsed;
	}

	const report = [];
	const changes = [];
	const cas = [];
	for (const [key, shortcut] of Object.entries(MANAGED_SHORTCUTS)) {
		const present = Object.hasOwn(raw, key);
		const value = raw[key];
		if (present && typeof value !== "string" && !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
			// O SDK descarta valor inválido e volta ao default (a tecla do Agent): sem fail closed o atalho
			// nativo seguiria vencendo com o Agent achando que resolveu.
			throw new Error(`${path}: ${key} não é string nem lista de strings; corrija antes de ativar o Agent`);
		}
		const entry = { key, path, keyRemoved: shortcut };
		let next;
		if (!present) {
			// Ausente = default do SDK, que é exatamente a tecla do Agent; lista vazia desliga só essa ação.
			next = [];
			entry.action = "unbind-default";
		} else {
			const current = typeof value === "string" ? [value] : value;
			const kept = current.filter((candidate) => !isSameKey(candidate, shortcut));
			if (kept.length === current.length) {
				entry.action = "already-free";
				entry.keyRemoved = null;
				report.push(entry);
				continue;
			}
			next = kept;
			entry.action = "unbind-key";
			entry.keptKeys = kept.length;
		}
		entry.fileExists = exists;
		report.push(entry);
		changes.push({ key, path, value: next, fileExists: exists });
		cas.push({ key, path, exists, hash: hashValue(present ? value : undefined), absent: !present });
		const legacy = LEGACY_KEYBINDING_NAMES[key];
		if (legacy && Object.hasOwn(raw, legacy)) {
			limitations.push(`${path} tem o nome legado "${legacy}"; o SDK migra para ${key} e a entrada canônica (gerenciada) vence — a legada fica no arquivo, intocada`);
		}
	}
	return { path, report, changes, cas };
}

/** Skills recursivas: nome do frontmatter, como no Pi; primeira ocorrência vence. */
function skillsIn(dir, seen = new Set()) {
	let stats;
	try {
		const real = realpathSync(dir);
		if (seen.has(real)) return [];
		seen.add(real);
		stats = statSync(dir);
	} catch { return []; }
	const file = stats.isFile() && dir.endsWith(".md") ? dir
		: stats.isDirectory() && existsSync(join(dir, "SKILL.md")) ? join(dir, "SKILL.md") : null;
	if (file) {
		try {
			const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
			const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^['"]|['"]$/g, "")
				|| (basename(file) === "SKILL.md" ? basename(dirname(file)) : basename(file, ".md"));
			return [{ name, path: file }];
		} catch { return []; }
	}
	if (!stats.isDirectory()) return [];
	try {
		const found = readdirSync(dir).sort().filter(name => !name.startsWith(".") && name !== "node_modules")
			.flatMap(name => skillsIn(join(dir, name), seen));
		return [...new Map(found.map(skill => [skill.name, skill]).reverse()).values()].sort((a, b) => a.name.localeCompare(b.name));
	} catch { return []; }
}

/**
 * Plano de registro do Agent. Só lê (`settings.json`, nomes/symlinks de extensões, skills e
 * temas); não escreve nada.
 */
export function planAgentResources({ agentRoot, agentDir, homeDir }) {
	const root = assertAbsolute("agentRoot", agentRoot);
	const agent = assertAbsolute("agentDir", agentDir);
	const home = assertAbsolute("homeDir", homeDir);
	if (!existsSync(root)) throw new Error(`agentRoot inexistente: ${root}`);
	const settingsPath = join(agent, "settings.json");
	let settings = {};
	if (existsSync(settingsPath)) {
		const text = readFileSync(settingsPath, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`${settingsPath} não é JSON válido; Agent não pode registrar recursos com segurança`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${settingsPath} não é um objeto JSON`);
		settings = parsed;
	}

	const limitations = [];
	const blocking = [];
	const collisions = [];
	const originalExtensions = asList(settings.extensions);
	const originalSkills = asList(settings.skills);
	const rootPrefix = `${root}${sep}`;

	if (isAgentSetupDisabled(settings)) {
		return {
			version: PLAN_VERSION,
			disabled: true,
			agentRoot: root,
			agentDir: agent,
			homeDir: home,
			settingsPath,
			report: {
				extensions: [],
				unmatchedPersonal: [],
				skills: { register: [], collisions: [] },
				themes: [],
				collisions: [],
				keybindings: [],
				limitations: ['"-agent-setup" no settings desliga o setup do Agent; nenhum registro do Agent planejado'],
				blocking: [],
				settingsKeys: [],
			},
			keybindingsPath: join(agent, KEYBINDINGS_FILE),
			changes: { settings: {}, copyFiles: [], keybindings: [] },
			cas: { settings: { path: settingsPath, keys: {} }, files: [], keybindings: [] },
		};
	}

	// Entradas de settings separadas: ativas (plain/`+`) e exclusões já declaradas (`-`/`!`).
	const activeEntries = [];
	const exclusionEntries = [];
	for (const entry of originalExtensions) {
		if (typeof entry !== "string") continue;
		if (DISABLED.test(entry)) exclusionEntries.push(entry);
		else activeEntries.push(entry);
	}
	const excludedTargets = new Set(exclusionEntries.map((entry) => toPosix(resolveSettingsEntry(entry, { agentDir: agent, homeDir: home }))));
	// Só o interruptor por nome (`-dup`, `-agent-setup`) desliga uma extensão do Agent. Uma exclusão
	// com caminho (`-extensions/dup/index.ts`) é o filtro que este helper mesmo emite para apagar a
	// autodescoberta pessoal; tratá-la como interruptor desligaria o Agent na reaplicação.
	const excludedNames = new Set(
		exclusionEntries
			.map((entry) => entry.slice(1))
			.filter((entry) => !entry.includes("/") && !entry.includes(sep) && !entry.startsWith("~"))
			.map((entry) => entryName(entry)),
	);
	const activeResolved = activeEntries.map((entry) => ({ entry, path: resolveSettingsEntry(entry, { agentDir: agent, homeDir: home }) }));
	const alreadyRegistered = new Set(activeResolved.map(({ path }) => path));
	// Entradas pessoais explícitas (fora do artefato), por nome de recurso.
	const explicitByName = new Map();
	for (const { entry, path } of activeResolved) {
		if (path === root || path.startsWith(rootPrefix)) continue;
		const name = explicitExtensionName(path);
		const files = extensionEntryFiles(path);
		const list = explicitByName.get(name) ?? [];
		list.push({ entry, path, entries: files });
		explicitByName.set(name, list);
	}
	const autoByName = new Map(autoDiscoveredExtensions(agent).map((extension) => [extension.name, extension]));

	if (asList(settings.packages).length > 0) {
		limitations.push("settings.packages não foi inspecionado (sem rede/instalação); extensão de pacote com nome igual pode colidir e precisa de filtro de pacote");
	}

	const extensionsReport = [];
	const addPaths = [];
	const addExclusions = [];
	const seenExclusion = new Set(excludedTargets);

	const candidates = agentExtensionCandidates(root);
	const installedNames = new Set(candidates.map(({ name }) => name));
	// Retired resources still suppress personal copies, through the same reversible receipt.
	const retired = RETIRED_EXTENSIONS.filter((name) => !installedNames.has(name))
		.map((name) => ({ name, path: join(root, EXTENSIONS_SUBDIR, AGENT_TREE, name), entries: [], retired: true }));
	for (const candidate of [...candidates, ...retired]) {
		const agentPath = resolve(candidate.path);
		const item = { name: candidate.name, agentPath, action: "register", exclusions: [], personal: [] };
		if (!candidate.retired && candidate.entries.length === 0) {
			item.action = "blocked";
			item.reason = "sem arquivo de entrada (index.ts/js ou pi.extensions) no artefato";
			blocking.push(`extensão ${candidate.name}: ${item.reason} (${agentPath})`);
			extensionsReport.push(item);
			continue;
		}
		const aliases = [candidate.name, ...legacyNamesOf(candidate.name)];
		if (!candidate.retired && (aliases.some((name) => excludedNames.has(name)) || excludedTargets.has(toPosix(agentPath)))) {
			item.action = "skipped-user-disabled";
			item.reason = `desligada no settings do usuário por "-${candidate.name}" ou exclusão equivalente`;
			extensionsReport.push(item);
			continue;
		}

		// Cópia pessoal sob o nome antigo (ex.: `garime-tui` → `tui`) é a mesma extensão: também sai.
		for (const auto of aliases.map((name) => autoByName.get(name)).filter(Boolean)) {
			const personalEntries = auto.entries.length ? auto.entries : [];
			if (personalEntries.length === 0) {
				item.action = "blocked";
				item.reason = `cópia pessoal auto-descoberta em ${auto.path} sem arquivo de entrada resolvível; exclusão exata impossível`;
				blocking.push(`extensão ${candidate.name}: ${item.reason}`);
				continue;
			}
			item.personal.push({ kind: "auto", path: auto.path });
			for (const entry of personalEntries) {
				// Relativo ao agentDir: é a forma medida no SDK para a auto-descoberta e sobrevive a
				// symlink da pasta de extensões pessoal.
				const pattern = `-${toPosix(relative(agent, entry))}`;
				if (!seenExclusion.has(toPosix(entry))) item.exclusions.push(pattern);
			}
			collisions.push({ name: candidate.name, kind: "auto", personalPath: auto.path, agentPath, resolution: "auto-descoberta pessoal desligada por exclusão exata (arquivo intocado)" });
		}

		for (const explicit of aliases.flatMap((name) => explicitByName.get(name) ?? [])) {
			if (explicit.entries.length === 0) {
				item.action = "blocked";
				item.reason = `entrada pessoal ${explicit.entry} não resolve arquivo de entrada; exclusão exata impossível`;
				blocking.push(`extensão ${candidate.name}: ${item.reason}`);
				continue;
			}
			item.personal.push({ kind: "settings", path: explicit.path });
			for (const entry of explicit.entries) {
				const pattern = `-${toPosix(entry)}`;
				if (!seenExclusion.has(toPosix(entry))) item.exclusions.push(pattern);
			}
			collisions.push({ name: candidate.name, kind: "settings", personalPath: explicit.path, agentPath, resolution: "entrada pessoal de extensions[] desligada por exclusão exata (entrada preservada na lista)" });
		}
		if (item.action === "blocked") {
			extensionsReport.push(item);
			continue;
		}

		item.exclusions = [...new Set(item.exclusions)];
		for (const pattern of item.exclusions) seenExclusion.add(toPosix(resolveSettingsEntry(pattern, { agentDir: agent, homeDir: home })));
		if (candidate.retired) item.action = "retired";
		else if (alreadyRegistered.has(agentPath)) item.action = item.exclusions.length ? "exclude-only" : "already-registered";
		else addPaths.push(agentPath);
		addExclusions.push(...item.exclusions);
		extensionsReport.push(item);
	}

	// Entradas pessoais que seguem ativas e não casam por nome com nenhuma extensão do Agent.
	// Colisão aqui só aparece por tool/command no startup do Pi ("Tool X conflicts with …"), porque
	// este plano compara nomes de recurso (arquivo/pasta), não tools registradas em runtime.
	const agentNames = new Set(extensionsReport.flatMap((item) => [item.name, ...legacyNamesOf(item.name)]));
	const unmatchedPersonal = [];
	for (const [name, entries] of explicitByName) {
		if (agentNames.has(name)) continue;
		for (const entry of entries) unmatchedPersonal.push({ name, path: entry.path });
	}
	if (unmatchedPersonal.length) {
		limitations.push(`colisão por tool/command não é detectável no plano: ${unmatchedPersonal.map((entry) => entry.name).join(", ")} seguem registradas pelo usuário com outro nome de recurso e só o startup do Pi acusa conflito de tool`);
	}

	// Skills: só a raiz do artefato, com colisões relatadas (precedência difere por host).
	const skillsRoot = join(root, "skills");
	const skillsRegister = [];
	const skillCollisions = [];
	if (existsSync(skillsRoot)) {
		const agentSkills = skillsIn(skillsRoot);
		const personalSkills = new Map();
		for (const skill of skillsIn(join(agent, "skills"))) personalSkills.set(skill.name, { kind: "auto", path: skill.path });
		for (const entry of originalSkills) {
			if (typeof entry !== "string" || DISABLED.test(entry)) continue;
			const path = resolveSettingsEntry(entry, { agentDir: agent, homeDir: home });
			if (path === root || path.startsWith(rootPrefix)) continue;
			for (const skill of skillsIn(path)) if (!personalSkills.has(skill.name)) personalSkills.set(skill.name, { kind: "settings", path: skill.path });
		}
		for (const skill of agentSkills) {
			const personal = personalSkills.get(skill.name);
			if (!personal) continue;
			skillCollisions.push({
				name: skill.name,
				agentPath: skill.path,
				personalPath: personal.path,
				kind: personal.kind,
				resolution: "host clássico: entrada de settings vence (Agent)",
			});
		}
		if (skillCollisions.length) {
			limitations.push(`colisão de nome de skill resolvida de formas diferentes nos dois hosts: ${skillCollisions.map((collision) => collision.name).join(", ")}`);
		}
		const resolvedSkillEntries = new Set(originalSkills.filter((entry) => typeof entry === "string" && !DISABLED.test(entry)).map((entry) => resolveSettingsEntry(entry, { agentDir: agent, homeDir: home })));
		if (!resolvedSkillEntries.has(skillsRoot)) skillsRegister.push(skillsRoot);
	}

	// Temas: só cópia de arquivo ausente numa pasta de temas que é do Agent/Agent (não symlink
	// pessoal) e com nome que não é de tema do usuário.
	const themesReport = [];
	const copyFiles = [];
	const agentThemes = themesIn(join(root, THEMES_SUBDIR));
	if (agentThemes.length) {
		const themesDir = join(agent, THEMES_SUBDIR);
		const personalThemes = new Set(themesIn(themesDir).map((theme) => theme.name));
		const linked = isSymlink(themesDir);
		for (const theme of agentThemes) {
			if (personalThemes.has(theme.name)) {
				themesReport.push({ name: theme.name, action: "personal-wins", path: join(themesDir, `${theme.name}.json`) });
				continue;
			}
			if (linked) {
				themesReport.push({ name: theme.name, action: "unavailable", path: themesDir, reason: "pasta de temas do usuário é symlink; Agent não escreve nela" });
				limitations.push(`tema ${theme.name} não registrado: ${themesDir} é symlink pessoal (themes[] não vale para o tema inicial, que o Pi resolve antes do registro)`);
				continue;
			}
			const target = join(themesDir, `${theme.name}.json`);
			copyFiles.push({ from: theme.path, to: target });
			themesReport.push({ name: theme.name, action: "copy-missing", path: target });
		}
	}

	// Keybindings reservadas que bloqueariam os atalhos do Agent (duas chaves, reversíveis).
	let lean = false;
	try { lean = JSON.parse(readFileSync(join(root, "..", "manifest.json"), "utf8")).version >= 3; } catch {}
	const keybindings = lean ? { path: join(agent, KEYBINDINGS_FILE), report: [], changes: [], cas: [] } : planKeybindings({ agentDir: agent, limitations });

	// O wrapper codemode-mode registra o codemode por modelo; o builtin do Pi não pode subir ao lado.
	if (extensionsReport.some((item) => item.name === "codemode-mode" && ["register", "already-registered", "exclude-only"].includes(item.action))
		&& !originalExtensions.includes("-builtin:codemode")) addExclusions.push("-builtin:codemode");

	const changes = { settings: {}, copyFiles, keybindings: keybindings.changes };
	if (addPaths.length || addExclusions.length) changes.settings.extensions = { add: addPaths, addExclusions: [...new Set(addExclusions)] };
	if (skillsRegister.length) changes.settings.skills = { add: skillsRegister };

	const cas = {
		keybindings: keybindings.cas,
		settings: {
			path: settingsPath,
			exists: existsSync(settingsPath),
			keys: Object.fromEntries(Object.keys(changes.settings).map((key) => [key, { hash: hashValue(settings[key]), absent: !(key in settings) }])),
		},
		files: copyFiles.map(({ to }) => ({ path: to, exists: existsSync(to) })),
	};

	return {
		version: PLAN_VERSION,
		disabled: false,
		agentRoot: root,
		agentDir: agent,
		homeDir: home,
		settingsPath,
		keybindingsPath: keybindings.path,
		report: {
			extensions: extensionsReport,
			keybindings: keybindings.report,
			unmatchedPersonal,
			skills: { register: skillsRegister, collisions: skillCollisions },
			themes: themesReport,
			collisions,
			limitations,
			blocking,
			settingsKeys: Object.keys(changes.settings),
		},
		changes,
		cas,
	};
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeAtomic(path, text, mode) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, text, mode === undefined ? undefined : { mode });
	try {
		if (mode !== undefined) chmodSync(temporary, mode);
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function casStore(backupDir, value) {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	const hash = sha256(text);
	const path = join(backupDir, "cas", `${hash}.json`);
	if (!existsSync(path)) writeAtomic(path, text, 0o600);
	return { casPath: path, casHash: hash };
}

/**
 * Aplica o plano: backup seletivo em CAS, escrita atômica, idempotente, com recibo absoluto.
 * Duas fases: (1) preflight de TODAS as chaves (settings, keybindings) contra plano e recibo
 * anterior, só lendo — qualquer CAS violado lança antes de qualquer escrita; (2) escrita.
 */
export function applyAgentResources({ plan, backupDir }) {
	if (!plan || plan.version !== PLAN_VERSION) throw new Error(`plano inválido ou de outra versão: ${plan?.version}`);
	const backup = assertAbsolute("backupDir", backupDir);
	if (plan.report.blocking.length > 0) {
		throw new Error(`plano com impossibilidades não resolvidas: ${plan.report.blocking.join("; ")}`);
	}
	const receiptPath = join(backup, RECEIPT_NAME);
	if (plan.disabled) {
		mkdirSync(backup, { recursive: true });
		const receipt = { version: RECEIPT_VERSION, createdAt: new Date().toISOString(), agentRoot: plan.agentRoot, agentDir: plan.agentDir, settingsPath: plan.settingsPath, keybindingsPath: plan.keybindingsPath ?? null, backupDir: backup, disabled: true, settings: [], keybindings: [], files: [], report: plan.report };
		writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
		return { receiptPath, changed: false, disabled: true, settings: [], keybindings: [], created: [], report: plan.report };
	}

	const settingsExists = existsSync(plan.settingsPath);
	const settings = settingsExists ? readJson(plan.settingsPath) : {};
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${plan.settingsPath} não é um objeto JSON`);
	const mode = settingsExists ? statSync(plan.settingsPath).mode & 0o777 : 0o600;

	// Reaplicação não pode apagar o recibo que ainda descreve o estado anterior: o que já estava
	// aplicado é carregado do recibo anterior (CAS inclusive), e só o que falta ganha backup novo.
	let previous = null;
	if (existsSync(receiptPath)) {
		const candidate = readJson(receiptPath);
		if (candidate.version !== RECEIPT_VERSION || candidate.settingsPath !== plan.settingsPath) {
			throw new Error(`recibo incompatível em ${receiptPath}; preserve e reconcilie antes de reaplicar`);
		}
		previous = candidate;
	}
	const previousSettings = new Map((previous?.settings ?? []).map((entry) => [entry.key, entry]));

	const settingsEntries = [];
	let changed = false;
	for (const [key, change] of Object.entries(plan.changes.settings)) {
		const current = asList(settings[key]).slice();
		const additions = [...(change.addExclusions ?? []), ...(change.add ?? [])];
		const missing = additions.filter((entry) => !current.includes(entry));
		const next = [...current, ...missing];
		const currentHash = hashValue(settings[key]);
		const plannedHash = plan.cas.settings.keys[key]?.hash;
		const nextHash = hashValue(next);
		const carried = previousSettings.get(key);
		if (carried && currentHash !== carried.afterHash && currentHash !== carried.beforeHash) {
			throw new Error(`settings.${key} mudou após a aplicação anterior; recibo/CAS preservado, reconcilie antes de reaplicar`);
		}
		if (currentHash === nextHash) {
			// Já aplicado: idempotente, sem backup novo nem escrita.
			if (carried && carried.afterHash === currentHash) {
				settingsEntries.push({ ...carried, reapplied: true });
				continue;
			}
			settingsEntries.push({ key, beforeHash: plannedHash ?? currentHash, afterHash: nextHash, beforeAbsent: plan.cas.settings.keys[key]?.absent === true, casPath: null, reapplied: true });
			continue;
		}
		if (currentHash !== plannedHash) {
			throw new Error(`settings.${key} mudou depois do plano (${plan.settingsPath}); replaneje antes de aplicar`);
		}
		const entry = carried?.casPath && carried.afterHash === currentHash
			? { key, casPath: carried.casPath, beforeHash: carried.beforeHash, beforeAbsent: carried.beforeAbsent, afterHash: nextHash, reapplied: false }
			: { key, beforeHash: currentHash, beforeAbsent: plan.cas.settings.keys[key]?.absent === true, afterHash: nextHash, reapplied: false, backupValue: { key, value: key in settings ? settings[key] : null, absent: !(key in settings) } };
		settings[key] = next;
		settingsEntries.push(entry);
		changed = true;
	}

	// Plano novo sem mudança nenhuma numa chave (tudo já aplicado): o recibo continua respondendo
	// pelo estado anterior dela.
	for (const carried of previousSettings.values()) {
		if (settingsEntries.some((entry) => entry.key === carried.key)) continue;
		const hash = hashValue(settings[carried.key]);
		if (hash !== carried.afterHash) {
			if (hash === carried.beforeHash) continue;
			throw new Error(`settings.${carried.key} mudou após a aplicação anterior; recibo/CAS preservado, reconcilie antes de reaplicar`);
		}
		settingsEntries.push({ ...carried, reapplied: true });
	}

	// Keybindings: uma entrada por ação gerenciada, arquivo pessoal preservado nas demais chaves.
	const previousKeybindings = new Map((previous?.keybindings ?? []).map((entry) => [`${entry.path}\u0000${entry.key}`, entry]));
	const keybindingEntries = [];
	const keybindingFiles = new Map(); // path → { raw, mode, changed }: uma leitura e uma escrita por arquivo
	const keybindingFile = (path) => {
		let file = keybindingFiles.get(path);
		if (!file) {
			const exists = existsSync(path);
			const raw = exists ? readJson(path) : {};
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} não é um objeto JSON`);
			file = { raw, mode: exists ? statSync(path).mode & 0o777 : 0o600, changed: false };
			keybindingFiles.set(path, file);
		}
		return file;
	};
	for (const change of plan.changes.keybindings ?? []) {
		const fileExists = existsSync(change.path);
		// `fileExisted` é o estado do arquivo ANTES desta gestão (o do plano), não o de agora: a segunda
		// ação gerenciada já encontra o arquivo criado pela primeira, e é a origem do plano que decide se
		// o rollback pode remover o arquivo ao esvaziá-lo.
		const fileExistedBefore = change.fileExists === undefined ? fileExists : change.fileExists === true;
		const file = keybindingFile(change.path);
		const raw = file.raw;
		const present = Object.hasOwn(raw, change.key);
		const currentHash = hashValue(present ? raw[change.key] : undefined);
		const nextHash = hashValue(change.value);
		const planned = (plan.cas.keybindings ?? []).find((entry) => entry.path === change.path && entry.key === change.key);
		const carried = previousKeybindings.get(`${change.path}\u0000${change.key}`);
		if (carried && currentHash !== carried.afterHash && currentHash !== carried.beforeHash) {
			throw new Error(`${change.key} em ${change.path} mudou após a aplicação anterior; recibo/CAS preservado, reconcilie antes de reaplicar`);
		}
		if (present && currentHash === nextHash) {
			if (carried && carried.afterHash === currentHash) {
				keybindingEntries.push({ ...carried, reapplied: true });
				continue;
			}
			keybindingEntries.push({ key: change.key, path: change.path, beforeHash: planned?.hash ?? currentHash, beforeAbsent: planned?.absent === true, fileExisted: fileExistedBefore, casPath: null, afterHash: nextHash, reapplied: true });
			continue;
		}
		if (currentHash !== planned?.hash) {
			throw new Error(`${change.key} em ${change.path} mudou depois do plano; replaneje antes de aplicar`);
		}
		const entry = carried?.casPath && carried.afterHash === currentHash
			? { key: change.key, path: change.path, casPath: carried.casPath, beforeHash: carried.beforeHash, beforeAbsent: carried.beforeAbsent, fileExisted: carried.fileExisted, afterHash: nextHash, reapplied: false }
			: { key: change.key, path: change.path, beforeHash: currentHash, beforeAbsent: !present, fileExisted: fileExistedBefore, afterHash: nextHash, reapplied: false, backupValue: { keybinding: change.key, path: change.path, value: present ? raw[change.key] : null, absent: !present, fileExisted: fileExistedBefore } };
		raw[change.key] = change.value;
		file.changed = true;
		keybindingEntries.push(entry);
	}
	for (const [id, carried] of previousKeybindings) {
		if (keybindingEntries.some((entry) => `${entry.path}\u0000${entry.key}` === id)) continue;
		if (!existsSync(carried.path)) continue;
		const file = keybindingFile(carried.path);
		const raw = file.raw;
		const hash = hashValue(Object.hasOwn(raw, carried.key) ? raw[carried.key] : undefined);
		// Uma ação retirada da gestão volta ao valor original, mas nunca desfaz edição pessoal.
		if (!MANAGED_KEYBINDINGS.includes(carried.key)) {
			if (hash !== carried.afterHash || hash === carried.beforeHash) continue;
			if (!carried.casPath || !existsSync(carried.casPath)) {
				throw new Error(`${carried.key}: backup CAS ausente para encerrar a gestão; recibo preservado`);
			}
			const original = readJson(carried.casPath);
			if (original.absent === true) delete raw[carried.key];
			else raw[carried.key] = original.value;
			file.changed = true;
			continue;
		}
		if (hash !== carried.afterHash) {
			if (hash === carried.beforeHash) continue;
			throw new Error(`${carried.key} em ${carried.path} mudou após a aplicação anterior; recibo/CAS preservado, reconcilie antes de reaplicar`);
		}
		keybindingEntries.push({ ...carried, reapplied: true });
	}

	// ---- Fase 2: nenhuma validação de CAS resta; só escrita. ----
	mkdirSync(backup, { recursive: true });
	for (const entry of [...settingsEntries, ...keybindingEntries]) {
		if (!entry.backupValue) continue;
		Object.assign(entry, casStore(backup, entry.backupValue));
		delete entry.backupValue;
	}
	const keybindingsChanged = [...keybindingFiles.values()].some((file) => file.changed);

	const created = [];
	for (const file of previous?.files ?? []) {
		// Arquivo que esta gestão criou antes continua sob rollback enquanto estiver igual.
		if (existsSync(file.path) && sha256(readFileSync(file.path)) === file.hash) created.push(file);
	}
	const copies = plan.changes.copyFiles.filter(({ to }) => !existsSync(to));
	const newlyCreated = copies.map(({ from, to }) => ({ path: to, hash: sha256(readFileSync(from)) }));
	created.push(...newlyCreated);

	const receipt = {
		version: RECEIPT_VERSION,
		createdAt: new Date().toISOString(),
		agentRoot: plan.agentRoot,
		agentDir: plan.agentDir,
		settingsPath: plan.settingsPath,
		keybindingsPath: plan.keybindingsPath ?? null,
		backupDir: backup,
		disabled: false,
		settings: settingsEntries,
		keybindings: keybindingEntries,
		files: created,
		report: plan.report,
	};
	// Write-ahead: se qualquer escrita abaixo falhar, o recibo + CAS já descrevem como
	// desfazer o que chegou ao disco. Entradas ainda não aplicadas são idempotentes no rollback.
	writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
	for (const [path, file] of keybindingFiles) {
		if (file.changed) writeAtomic(path, `${JSON.stringify(file.raw, null, 2)}\n`, file.mode);
	}
	for (const { from, to } of copies) {
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to, constants.COPYFILE_EXCL);
	}
	if (changed) writeAtomic(plan.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, mode);
	return { receiptPath, changed: changed || keybindingsChanged || newlyCreated.length > 0, disabled: false, settings: settingsEntries, keybindings: keybindingEntries, created: newlyCreated.map(({ path }) => path), report: plan.report };
}

/**
 * Desfaz o que o recibo registra, com CAS, em duas fases: (1) preflight de TODAS as entradas
 * (settings, keybindings, arquivos copiados) sem escrever nada; (2) escrita, só se não houve
 * conflito. Qualquer conflito (mudança posterior do usuário, CAS ausente, arquivo ilegível)
 * devolve `conflicts` e deixa o disco intacto — nunca um rollback parcial misturando chaves
 * restauradas com chaves que seguem do Agent. Repetível depois que o usuário reconcilia.
 * Idempotente.
 */
export function rollbackAgentResources({ receiptPath }) {
	const path = assertAbsolute("receiptPath", receiptPath);
	const receipt = readJson(path);
	if (receipt.version !== RECEIPT_VERSION) throw new Error(`recibo de outra versão: ${receipt.version}`);
	const restored = [];
	const conflicts = [];
	const skipped = [];
	const writes = []; // escritas decididas no preflight, executadas só sem conflito
	const unlinks = [];

	if (receipt.settings.length > 0 && existsSync(receipt.settingsPath)) {
		const settings = readJson(receipt.settingsPath);
		const mode = statSync(receipt.settingsPath).mode & 0o777;
		let changed = false;
		for (const entry of receipt.settings) {
			const currentHash = hashValue(settings[entry.key]);
			if (currentHash === entry.beforeHash) {
				skipped.push({ key: entry.key, reason: "já estava no estado anterior" });
				continue;
			}
			if (currentHash !== entry.afterHash) {
				conflicts.push({ key: entry.key, reason: "mudança posterior do usuário preservada" });
				continue;
			}
			if (!entry.casPath) {
				// Aplicação idempotente não gravou backup novo; o estado anterior está no recibo que o
				// gravou. Sem CAS não há restauração segura.
				conflicts.push({ key: entry.key, reason: "sem backup CAS nesta aplicação (reaplicação idempotente); restaure pelo recibo original" });
				continue;
			}
			if (!existsSync(entry.casPath)) {
				conflicts.push({ key: entry.key, reason: `backup CAS ausente: ${entry.casPath}` });
				continue;
			}
			const backup = readJson(entry.casPath);
			if (backup.absent === true) delete settings[entry.key];
			else settings[entry.key] = backup.value;
			restored.push({ key: entry.key });
			changed = true;
		}
		if (changed) writes.push({ path: receipt.settingsPath, value: settings, mode });
	} else if (receipt.settings.length > 0) {
		for (const entry of receipt.settings) {
			if (entry.beforeAbsent) skipped.push({ key: entry.key, reason: "já estava ausente antes da aplicação" });
			else conflicts.push({ key: entry.key, reason: `settings ausente: ${receipt.settingsPath}` });
		}
	}

	// Keybindings: restaura presença/ausência/valor só da chave gerenciada. Se o arquivo não existia
	// antes e sobra vazio, ele sai; qualquer outra chave presente mantém o arquivo do usuário.
	// Uma leitura por arquivo: as ações do recibo compartilham o mesmo `keybindings.json`.
	const keybindingFiles = new Map();
	for (const entry of receipt.keybindings ?? []) {
		if (!existsSync(entry.path)) {
			skipped.push({ key: entry.key, path: entry.path, reason: "arquivo de keybindings ausente" });
			continue;
		}
		let file = keybindingFiles.get(entry.path);
		if (!file) {
			let raw = null;
			try {
				raw = readJson(entry.path);
			} catch {
				/* ilegível: relatado abaixo, por entrada */
			}
			file = { raw, mode: statSync(entry.path).mode & 0o777, changed: false, removable: false };
			keybindingFiles.set(entry.path, file);
		}
		const { raw } = file;
		if (raw === null) {
			conflicts.push({ key: entry.key, path: entry.path, reason: "keybindings.json ilegível; preservado" });
			continue;
		}
		if (typeof raw !== "object" || Array.isArray(raw)) {
			conflicts.push({ key: entry.key, path: entry.path, reason: "keybindings.json não é objeto JSON; preservado" });
			continue;
		}
		const present = Object.hasOwn(raw, entry.key);
		const currentHash = hashValue(present ? raw[entry.key] : undefined);
		if (currentHash === entry.beforeHash) {
			skipped.push({ key: entry.key, path: entry.path, reason: "já estava no estado anterior" });
			continue;
		}
		if (currentHash !== entry.afterHash) {
			conflicts.push({ key: entry.key, path: entry.path, reason: "mudança posterior do usuário preservada" });
			continue;
		}
		if (!entry.casPath || !existsSync(entry.casPath)) {
			conflicts.push({ key: entry.key, path: entry.path, reason: entry.casPath ? `backup CAS ausente: ${entry.casPath}` : "sem backup CAS nesta aplicação (reaplicação idempotente); restaure pelo recibo original" });
			continue;
		}
		const backup = readJson(entry.casPath);
		if (backup.absent === true) delete raw[entry.key];
		else raw[entry.key] = backup.value;
		file.changed = true;
		file.removable ||= entry.fileExisted === false;
		restored.push({ key: entry.key, path: entry.path });
	}
	for (const [filePath, file] of keybindingFiles) {
		if (!file.changed) continue;
		if (file.removable && Object.keys(file.raw).length === 0) unlinks.push(filePath);
		else writes.push({ path: filePath, value: file.raw, mode: file.mode });
	}

	const removed = [];
	for (const file of receipt.files ?? []) {
		if (!existsSync(file.path)) {
			skipped.push({ path: file.path, reason: "já removido" });
			continue;
		}
		if (sha256(readFileSync(file.path)) !== file.hash) {
			conflicts.push({ path: file.path, reason: "arquivo alterado depois da aplicação; preservado" });
			continue;
		}
		unlinks.push(file.path);
	}

	if (conflicts.length > 0) return { receiptPath: path, restored: [], removed: [], conflicts, skipped, changed: false };

	for (const { path: target, value, mode } of writes) writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, mode);
	for (const target of unlinks) {
		unlinkSync(target);
		removed.push(target);
	}
	return { receiptPath: path, restored, removed, conflicts, skipped, changed: restored.length > 0 || removed.length > 0 };
}
