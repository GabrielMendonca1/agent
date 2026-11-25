/**
 * Agent: artefato imutável, configuração declarativa e lançamento da release física.
 * v3 usa runtime lean; v1/v2 mantêm accounting declarado para rollback.
 * v1 continua validando seu broker e lançando o preload/entrada que declara para rollback.
 * O digest vincula conteúdo, plataforma e par Pi; nunca segue current durante a sessão.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	symlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT_RUNTIME_DIR = "runtime";
export const RELEASES_SUBDIR = "releases";
export const BUILD_CACHE_SUBDIR = "build-cache";
export const CONFIG_FILE = "config.json";
export const MANIFEST_FILE = "manifest.json";
/** Árvore vendorizada dentro do artefato: `agentRoot = artifactRoot/agent`. */
export const AGENT_SUBDIR = "agent";
const LEGACY_NATIVE_DIR = "broker";
const LEGACY_NATIVE_NAME = process.platform === "win32" ? "mark-juice.exe" : "mark-juice";
/** Preload estável do runtime, relativo a `agentRoot` (accounting só nos históricos). */
export const RUNTIME_PRELOAD = "core/runtime.mjs";
// Read-only compatibility: immutable installed manifests keep their original preload.
const LEGACY_RUNTIME_PRELOAD = "juice/runtime.mjs";
/** Classic CLI and its shared ModelRuntime module. */
export const PI_ENTRY = "dist/cli.js";
const DURABLE_PI_ENTRY = "dist/bundle/cli.js";
/** Pacote do Pi oficial que o overlay instala na release. */
const OFFICIAL_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_RUNTIME_MODULE = "dist/core/model-runtime.js";
export const LEDGER_FILE = "run.v3.json";
export const CONFIG_VERSION = 2;
export const ARTIFACT_VERSION = 3;
export const DISABLE_ENV = "AGENT_DISABLED";
/** Chaves que o launcher escreve. Qualquer outra do ambiente real passa intacta. */
export const MANAGED_ENV_KEYS = [
	"AGENT_RUNTIME_ENABLED",
	"AGENT_PI_ROOT",
	"AGENT_CHILD",
	"AGENT_JUICE_ENABLED",
	"AGENT_JUICE_BIN",
	"AGENT_JUICE_HOME",
	"AGENT_JUICE_STATE",
	"AGENT_JUICE_PI_ROOT",
	"AGENT_JUICE_PI_ENTRY",
	"AGENT_ARTIFACT",
	"AGENT_ARTIFACT_ROOT",
	"NODE_OPTIONS",
];
const CONFIG_KEYS = new Set(["version", "enabled", "artifactId", "piRoot", "juiceHome", "resourceReceipt"]);
const ARTIFACT_ID = /^[0-9a-f]{64}$/;
const ignoredTreeEntries = new Set([".DS_Store", "node_modules", "__pycache__", "target"]);
const isWindows = process.platform === "win32";

function fail(message) {
	throw new Error(`Agent: ${message}`);
}

/** Caminho absoluto, sem `..`, sem `~`: o que pode entrar num manifesto ou numa config. */
function requirePlainAbsolute(value, label) {
	if (typeof value !== "string" || value === "") fail(`${label} precisa ser um caminho absoluto (recebi ${JSON.stringify(value)})`);
	if (!isAbsolute(value)) fail(`${label} precisa ser absoluto: ${value}`);
	if (value.split(/[\\/]/).includes("..")) fail(`${label} não pode conter "..": ${value}`);
	if (value.startsWith("~")) fail(`${label} não pode começar com "~": ${value}`);
	return value;
}

function physicalPath(path, label) {
	try {
		return realpathSync(path);
	} catch (error) {
		return fail(`${label} não existe no disco: ${path} (${error.code ?? error.message})`);
	}
}

/** Caminho que JÁ é físico: nenhum componente é symlink. Um `current` mutável é recusado aqui. */
function requirePhysical(path, label) {
	requirePlainAbsolute(path, label);
	const real = physicalPath(path, label);
	if (real !== path) {
		fail(`${label} precisa ser o caminho físico; ${path} resolve para ${real} (um ponteiro mutável como "current" trocaria de versão no meio da sessão)`);
	}
	return real;
}

function requireDirectory(path, label) {
	const real = physicalPath(path, label);
	if (!statSync(real).isDirectory()) fail(`${label} não é um diretório: ${path}`);
	return real;
}

function requireRegularFile(path, label) {
	let info;
	try {
		info = lstatSync(path);
	} catch (error) {
		return fail(`${label} não existe: ${path} (${error.code ?? error.message})`);
	}
	if (info.isSymbolicLink()) fail(`${label} é um link simbólico; o artefato só aceita arquivo regular: ${path}`);
	if (!info.isFile()) fail(`${label} não é um arquivo regular: ${path}`);
	return path;
}

export function defaultStore() {
	return process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), ".local", "share", "agent");
}

function storeRoot(store) {
	return requirePlainAbsolute(typeof store === "string" ? resolve(store) : store, "store");
}

export function agentRuntimeRoot(store) {
	return join(storeRoot(store), AGENT_RUNTIME_DIR);
}

export function agentConfigPath(store) {
	return join(agentRuntimeRoot(store), CONFIG_FILE);
}

export function agentReleasesDir(store) {
	return join(agentRuntimeRoot(store), RELEASES_SUBDIR);
}

// ---------------------------------------------------------------------------- broker

/**
 * Plataforma/arquitetura de um executável, lida do cabeçalho do próprio arquivo.
 *
 * Apenas para artefatos v1 de rollback; versões novas não têm executável nativo.
 */
function legacyBinaryPlatform(path) {
	const handle = readFileSync(path);
	if (handle.length < 64) fail(`broker ${path} é muito pequeno para ser um executável (${handle.length} bytes)`);
	const magic = handle.readUInt32BE(0);
	// Mach-O 64 bits, little endian (0xfeedfacf gravado como cf fa ed fe).
	if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
		const cpu = handle.readUInt32LE(4);
		const arch = cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : cpu === 0x0000000c ? "arm" : `mach-o-cpu-${cpu}`;
		return { platform: "darwin", arch, format: "mach-o" };
	}
	if (magic === 0xfeedfacf || magic === 0xfeedface) {
		const cpu = handle.readUInt32BE(4);
		return { platform: "darwin", arch: cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : `mach-o-cpu-${cpu}`, format: "mach-o" };
	}
	// Universal binary: um fat não prova que a fatia desta arquitetura está lá dentro.
	if (magic === 0xcafebabe || magic === 0xbebafeca) {
		fail(`broker ${path} é um binário universal (fat); o artefato exige uma fatia única para ${process.platform}/${process.arch}`);
	}
	if (handle.subarray(0, 4).toString("latin1") === "\x7fELF") {
		const little = handle[5] === 1;
		const machine = little ? handle.readUInt16LE(18) : handle.readUInt16BE(18);
		const arch = machine === 0xb7 ? "arm64" : machine === 0x3e ? "x64" : machine === 0x28 ? "arm" : `elf-machine-${machine}`;
		return { platform: "linux", arch, format: "elf" };
	}
	if (handle.subarray(0, 2).toString("latin1") === "MZ") {
		const peOffset = handle.readUInt32LE(0x3c);
		if (peOffset + 6 > handle.length || handle.subarray(peOffset, peOffset + 4).toString("latin1") !== "PE\0\0") {
			fail(`broker ${path} parece um executável DOS/PE truncado`);
		}
		const machine = handle.readUInt16LE(peOffset + 4);
		const arch = machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : `pe-machine-${machine}`;
		return { platform: "win32", arch, format: "pe" };
	}
	return fail(`broker ${path} não é um executável nativo reconhecido (Mach-O/ELF/PE); um script não serve como broker`);
}

function requireLocalBroker(path, label) {
	requireRegularFile(path, label);
	const detected = legacyBinaryPlatform(path);
	if (detected.platform !== process.platform || detected.arch !== process.arch) {
		fail(
			`${label} é ${detected.platform}/${detected.arch} (${detected.format}) e esta máquina é ` +
				`${process.platform}/${process.arch}: o broker tem de ser compilado para o alvo local`,
		);
	}
	return detected;
}

// ---------------------------------------------------------------------------- digest

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Arquivos da árvore `agent/` do artefato: `{ "core/runtime.mjs": "x<sha>" | "-<sha>" }`. */
function hashTree(root, { strict = false } = {}) {
	const files = {};
	const walk = (relative) => {
		const directory = relative ? join(root, relative) : root;
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (!strict && ignoredTreeEntries.has(entry.name)) continue;
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			const full = join(directory, entry.name);
			if (entry.isSymbolicLink()) fail(`o artefato não pode conter links simbólicos: ${full}`);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) files[child] = `${statSync(full).mode & 0o111 ? "x" : "-"}${sha256File(full)}`;
			else fail(`entrada de tipo não suportado no artefato: ${full}`);
		}
	};
	walk("");
	if (Object.keys(files).length === 0) fail(`a árvore agent/ do artefato está vazia: ${root}`);
	return files;
}

function artifactDigest({ files, broker, piRoot, piEntry, version = ARTIFACT_VERSION }) {
	const hash = createHash("sha256");
	hash.update(`agent-artifact v${version}\0${process.platform}\0${process.arch}\0${piRoot}\0${piEntry}\0`);
	if (version === 1) hash.update(`broker\0${broker}\0`);
	for (const [relative, value] of Object.entries(files).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		hash.update(`F ${relative}\0${value}\0`);
	}
	return hash.digest("hex");
}

function freezeTree(root) {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) freezeTree(full);
		else chmodSync(full, statSync(full).mode & 0o111 ? 0o555 : 0o444);
	}
}

/** Entrada declarada em um Pi físico; preparações novas exigem também o ModelRuntime clássico. */
function requirePiRoot(piRoot, piEntry = PI_ENTRY) {
	const root = requirePhysical(typeof piRoot === "string" ? resolve(piRoot) : piRoot, "piRoot");
	for (const relative of piEntry === PI_ENTRY ? [piEntry, PI_RUNTIME_MODULE] : [piEntry]) {
		if (!existsSync(join(root, relative))) {
			fail(`piRoot ${root} não tem ${relative}: o Agent exige o CLI clássico e ModelRuntime`);
		}
		const file = join(root, relative);
		requireRegularFile(file, "entrada do Pi");
		if (physicalPath(file, "entrada do Pi") !== file) fail(`entrada do Pi resolve fora do caminho físico: ${file}`);
	}
	return root;
}

// ---------------------------------------------------------------------------- artefato

/**
 * Prepara (ou reaproveita) o artefato do par Pi+Agent. Não toca em configuração, ledger,
 * settings nem no launcher ativo: só escreve sob `<store>/runtime/releases`.
 */
export function prepareAgentArtifact({ sourceRoot, store, piRoot, log = console.log } = {}) {
	const source = requireDirectory(typeof sourceRoot === "string" ? resolve(sourceRoot) : sourceRoot, "sourceRoot");
	const agentSource = requireDirectory(join(source, AGENT_SUBDIR), "árvore agent/ de origem");
	if (!existsSync(join(agentSource, RUNTIME_PRELOAD))) {
		fail(`a árvore de origem não tem ${AGENT_SUBDIR}/${RUNTIME_PRELOAD}; sem o preload não há runtime`);
	}
	const root = storeRoot(store);
	const pi = requirePiRoot(piRoot);
	const releasesDir = join(agentRuntimeRoot(root), RELEASES_SUBDIR);
	mkdirSync(releasesDir, { recursive: true });

	const stage = join(releasesDir, `.stage-${process.pid}-${Date.now().toString(36)}`);
	rmSync(stage, { recursive: true, force: true });
	try {
		mkdirSync(stage, { recursive: true });
		cpSync(agentSource, join(stage, AGENT_SUBDIR), {
			recursive: true,
			dereference: true,
			filter: (path) => !ignoredTreeEntries.has(basename(path)),
		});
		// Standard integrations travel with the immutable resource receipt, not a mutable store sync.
		for (const [from, to] of [["extensions", "extensions/standard"], ["skills", "skills/standard"]]) {
			if (existsSync(join(source, from))) cpSync(join(source, from), join(stage, AGENT_SUBDIR, to), {
				recursive: true, dereference: true, filter: path => !ignoredTreeEntries.has(basename(path)),
			});
		}
		const files = hashTree(join(stage, AGENT_SUBDIR), { strict: true });
		const artifactId = artifactDigest({ files, piRoot: pi, piEntry: PI_ENTRY });
		const artifactRoot = join(releasesDir, artifactId);

		if (existsSync(artifactRoot)) {
			try {
				const reused = validateAgentArtifact({ store: root, artifactId, piRoot: pi });
				log(`Agent: artefato ${artifactId.slice(0, 12)} já instalado e válido (${artifactRoot})`);
				return reused;
			} catch (error) {
				fail(`artefato ${artifactId.slice(0, 12)} existente inválido (${error.message}); preservado para não remover arquivos de sessões abertas. Repare explicitamente ou prepare conteúdo novo.`);
			}
		}

		const manifest = {
			version: ARTIFACT_VERSION,
			artifactId,
			createdAt: new Date().toISOString(),
			platform: process.platform,
			arch: process.arch,
			piRoot: pi,
			piEntry: PI_ENTRY,
			agentSubdir: AGENT_SUBDIR,
			runtimePreload: `${AGENT_SUBDIR}/${RUNTIME_PRELOAD}`,
			files,
		};
		writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
		chmodSync(join(stage, MANIFEST_FILE), 0o444);
		freezeTree(join(stage, AGENT_SUBDIR));
		renameSync(stage, artifactRoot);
		log(`Agent: artefato ${artifactId.slice(0, 12)} preparado em ${artifactRoot}`);
		return validateAgentArtifact({ store: root, artifactId, piRoot: pi });
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/**
 * Valida um artefato instalado e devolve os caminhos físicos dele. O nome do diretório é o digest
 * do conteúdo: qualquer alteração em arquivo, broker ou manifesto quebra a conferência.
 */
export function validateAgentArtifact({ store, artifactId, piRoot } = {}) {
	if (typeof artifactId !== "string" || !ARTIFACT_ID.test(artifactId)) {
		fail(`artifactId inválido: ${JSON.stringify(artifactId)} (esperado digest sha256 em hex)`);
	}
	const releasesDir = join(agentRuntimeRoot(store), RELEASES_SUBDIR);
	const releasesReal = requireDirectory(releasesDir, "diretório de releases do Agent");
	const artifactRoot = join(releasesDir, artifactId);
	let info;
	try {
		info = lstatSync(artifactRoot);
	} catch (error) {
		return fail(`artefato ${artifactId} não está instalado em ${releasesDir} (${error.code ?? error.message})`);
	}
	if (info.isSymbolicLink()) fail(`${artifactRoot} é um link simbólico; o artefato tem de ser um diretório real`);
	if (!info.isDirectory()) fail(`${artifactRoot} não é um diretório`);
	const artifactReal = realpathSync(artifactRoot);
	if (artifactReal !== join(releasesReal, artifactId)) {
		fail(`${artifactRoot} resolve para fora de ${releasesReal} (${artifactReal}); travessia recusada`);
	}

	const manifestPath = join(artifactReal, MANIFEST_FILE);
	requireRegularFile(manifestPath, "manifesto do artefato");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return fail(`manifesto ilegível em ${manifestPath}: ${error.message}`);
	}
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail(`manifesto não é um objeto JSON: ${manifestPath}`);
	if (![1, 2, ARTIFACT_VERSION].includes(manifest.version)) fail(`manifesto versão ${manifest.version} não suportada (esperado ${ARTIFACT_VERSION}): ${manifestPath}`);
	if (manifest.artifactId !== artifactId) fail(`manifesto declara artifactId ${manifest.artifactId}, mas está em ${artifactId}`);
	if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
		fail(`artefato ${artifactId.slice(0, 12)} foi preparado para ${manifest.platform}/${manifest.arch}; esta máquina é ${process.platform}/${process.arch}`);
	}
	// Entradas conhecidas são relativas e confinadas ao piRoot físico. A entrada declarada
	// já participa do digest v1: aceitar o host histórico não muda a identidade do artefato.
	if (![PI_ENTRY, DURABLE_PI_ENTRY].includes(manifest.piEntry)) fail(`entrada do Pi não suportada: ${manifest.piEntry}`);
	if (![RUNTIME_PRELOAD, LEGACY_RUNTIME_PRELOAD].map(path => `${AGENT_SUBDIR}/${path}`).includes(manifest.runtimePreload)) fail(`runtimePreload inesperado: ${manifest.runtimePreload}`);

	const agentRoot = join(artifactReal, manifest.agentSubdir === AGENT_SUBDIR ? AGENT_SUBDIR : fail(`agentSubdir inesperado: ${manifest.agentSubdir}`));
	requireDirectory(agentRoot, "árvore agent/ do artefato");
	if (!existsSync(join(artifactReal, manifest.runtimePreload))) fail(`artefato sem ${AGENT_SUBDIR}/${RUNTIME_PRELOAD}: ${agentRoot}`);
	let brokerPath, brokerSha;
	if (manifest.version === 1) {
		brokerPath = join(artifactReal, LEGACY_NATIVE_DIR, LEGACY_NATIVE_NAME);
		if (manifest.broker?.path !== `${LEGACY_NATIVE_DIR}/${LEGACY_NATIVE_NAME}`) fail(`manifesto declara broker em ${manifest.broker?.path}, esperado ${LEGACY_NATIVE_DIR}/${LEGACY_NATIVE_NAME}`);
		requireRegularFile(brokerPath, "broker do artefato");
		brokerSha = sha256File(brokerPath);
		if (brokerSha !== manifest.broker.sha256) {
			fail(`broker do artefato mudou no disco: sha256 ${brokerSha.slice(0, 12)}, manifesto ${String(manifest.broker.sha256).slice(0, 12)}`);
		}
		const brokerInfo = requireLocalBroker(brokerPath, "broker do artefato");
		if (brokerInfo.platform !== manifest.broker.platform || brokerInfo.arch !== manifest.broker.arch) {
			fail(`broker do artefato é ${brokerInfo.platform}/${brokerInfo.arch}, manifesto declara ${manifest.broker.platform}/${manifest.broker.arch}`);
		}

	} else if (manifest.broker !== undefined) fail("new artifacts cannot declare a native runtime");

	const files = hashTree(agentRoot, { strict: manifest.version >= 3 });
	const declared = manifest.files;
	if (!declared || typeof declared !== "object" || Array.isArray(declared)) fail(`manifesto sem mapa de arquivos: ${manifestPath}`);
	for (const [relative, value] of Object.entries(files)) {
		if (!(relative in declared)) fail(`arquivo não declarado no manifesto do artefato: ${AGENT_SUBDIR}/${relative}`);
		if (declared[relative] !== value) fail(`arquivo alterado no artefato: ${AGENT_SUBDIR}/${relative}`);
	}
	for (const relative of Object.keys(declared)) {
		if (!(relative in files)) fail(`arquivo declarado no manifesto e ausente do artefato: ${AGENT_SUBDIR}/${relative}`);
	}

	const pi = requirePiRoot(manifest.piRoot, manifest.piEntry);
	const digest = artifactDigest({ files, broker: brokerSha, piRoot: pi, piEntry: manifest.piEntry, version: manifest.version });
	if (digest !== artifactId) {
		fail(`conteúdo do artefato não corresponde ao seu identificador (digest ${digest.slice(0, 12)} != ${artifactId.slice(0, 12)}); manifesto ou arquivos foram alterados`);
	}
	if (piRoot !== undefined) {
		const wanted = physicalPath(typeof piRoot === "string" ? resolve(piRoot) : piRoot, "piRoot pedido");
		if (wanted !== pi) fail(`artefato ${artifactId.slice(0, 12)} foi preparado para ${pi}, não para ${wanted}`);
	}
	return {
		artifactId,
		artifactRoot: artifactReal,
		agentRoot,
		brokerPath,
		piRoot: pi,
		piEntry: join(pi, manifest.piEntry),
		runtimePreload: join(artifactReal, manifest.runtimePreload),
		manifestPath,
		manifest,
	};
}

// ---------------------------------------------------------------------------- configuração

function validateConfig(config, where) {
	if (!config || typeof config !== "object" || Array.isArray(config)) fail(`configuração não é um objeto JSON (${where})`);
	for (const key of Object.keys(config)) {
		if (!CONFIG_KEYS.has(key)) {
			fail(`chave desconhecida "${key}" na configuração (${where}); o schema é fechado e não aceita preferências pessoais como modelo ou thinking`);
		}
	}
	if (![1, CONFIG_VERSION].includes(config.version)) fail(`configuração versão ${JSON.stringify(config.version)} não suportada (esperado ${CONFIG_VERSION}; ${where})`);
	if (typeof config.enabled !== "boolean") fail(`"enabled" tem de ser booleano (${where})`);
	if (typeof config.artifactId !== "string" || !ARTIFACT_ID.test(config.artifactId)) fail(`"artifactId" inválido (${where}): ${JSON.stringify(config.artifactId)}`);
	requirePlainAbsolute(config.piRoot, `"piRoot" (${where})`);
	if (config.version === 1) requirePlainAbsolute(config.juiceHome, `"juiceHome" (${where})`);
	else if (config.juiceHome !== undefined) fail("config v2 não aceita juiceHome");
	if (config.resourceReceipt !== undefined) requirePlainAbsolute(config.resourceReceipt, `"resourceReceipt" (${where})`);
	const normalized = {
		version: config.version,
		enabled: config.enabled,
		artifactId: config.artifactId,
		piRoot: config.piRoot,
		...(config.version === 1 ? { juiceHome: config.juiceHome } : {}),
	};
	if (config.resourceReceipt !== undefined) normalized.resourceReceipt = config.resourceReceipt;
	return normalized;
}

/** `null` quando não há opt-in nenhum; a config validada quando há; erro quando há e está ruim. */
export function readAgentConfig(store) {
	const path = agentConfigPath(store);
	let info;
	try {
		info = lstatSync(path);
	} catch {
		return null;
	}
	if (info.isSymbolicLink() || !info.isFile()) fail(`${path} precisa ser um arquivo regular (nada de link): o opt-in não é lido daí`);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return fail(`${path} não é JSON válido (${error.message}); corrija ou remova o arquivo — não há fallback silencioso`);
	}
	return validateConfig(parsed, path);
}

// Alias only: resource receipts and artifact realpaths remain unchanged.
// Return an undo for the config commit failure path; historical artifacts without standard stay intact.
export function syncStableSkills(store, target) {
	if (!existsSync(target)) return () => {};
	const link = join(store, "skills");
	let old;
	try { old = lstatSync(link); } catch (e) { if (e.code !== "ENOENT") throw e; }
	let backup = null;
	if (old && !old.isSymbolicLink()) {
		const known = new Set(readdirSync(target));
		const legacy = old.isDirectory() && readdirSync(link, { withFileTypes: true })
			.every(entry => entry.isDirectory() && known.has(entry.name));
		backup = `${link}.before-agent-migration`;
		for (let n = 1; ; n++) {
			try { lstatSync(backup); }
			catch (error) { if (error.code === "ENOENT") break; throw error; }
			backup = `${link}.before-agent-migration-${n}`;
		}
		renameSync(link, backup);
		if (!legacy) console.warn(`Pending: unrecognized skills content preserved at ${backup}; review manually`);
	}
	const previous = old?.isSymbolicLink() ? readlinkSync(link) : null;
	if (previous && resolve(dirname(link), previous) === resolve(target)) return () => {};
	mkdirSync(store, { recursive: true });
	const replace = destination => {
		const temp = `${link}.tmp-${process.pid}`;
		symlinkSync(destination, temp, process.platform === "win32" ? "junction" : "dir");
		try { renameSync(temp, link); } catch (e) { rmSync(temp, { force: true }); throw e; }
	};
	const undo = () => {
		if (previous !== null) replace(previous);
		else {
			rmSync(link, { force: true });
			if (backup) renameSync(backup, link);
		}
	};
	try { replace(resolve(target)); } catch (error) { if (backup) renameSync(backup, link); throw error; }
	return undo;
}

/** Escrita atômica da configuração validada. `resourceReceipt` do B é preservado como veio. */
export function writeAgentConfig({ store, config } = {}) {
	const path = agentConfigPath(store);
	const normalized = validateConfig(config, path);
	mkdirSync(agentRuntimeRoot(store), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	rmSync(temporary, { force: true });
	writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
	let undoSkills;
	try {
		undoSkills = syncStableSkills(store, join(agentReleasesDir(store), normalized.artifactId, "agent", "skills", "standard"));
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		undoSkills?.();
		throw error;
	}
	return { path, config: normalized };
}

// ---------------------------------------------------------------------------- lançamento

/**
 * Comando legado da release ativa: `{ command, args }` (args = prefixo antes dos do usuário).
 *
 * No Windows o `bin` do npm é `pi.cmd`, que o Node não spawna sem shell (CVE-2024-27980) e cujo
 * quoting seria nosso: roda-se o CLI do pacote com `node`, o que o `pi.cmd` faz de qualquer forma.
 */
export function legacyPiCommand(store) {
	const current = join(storeRoot(store), "current");
	if (!isWindows) return { command: join(current, "bin", "pi"), args: [] };
	const packageDir = join(current, "node_modules", ...OFFICIAL_PACKAGE.split("/"));
	let bin;
	try {
		bin = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin;
	} catch (error) {
		return fail(`não achei ${OFFICIAL_PACKAGE} em ${packageDir} (${error.code ?? error.message}): sem ele o Pi legado não tem o que executar`);
	}
	const entry = typeof bin === "string" ? bin : bin?.pi;
	if (typeof entry !== "string") fail(`${join(packageDir, "package.json")} não declara bin.pi`);
	return { command: process.execPath, args: [join(packageDir, entry)] };
}

/**
 * `NODE_OPTIONS` do usuário preservado, com o preload do artefato exatamente uma vez.
 *
 * Um `--import` de OUTRO `juice/runtime.mjs` (artefato antigo, perfil piloto) instalaria um segundo
 * gate, de outra versão, no mesmo processo: ele sai da lista e isso é relatado em `warnings`.
 */
function mergeNodeOptions(value, preload, warnings) {
	return [mergeNodeOptionsLegacy(value, warnings), preload].filter(Boolean).join(" ");
}

/**
 * O que executar para esta sessão. `env` é o ambiente REAL do usuário e sai preservado: HOME,
 * USERPROFILE, XDG_*, PI_CODING_AGENT_DIR, PI_SYSTEM_DIR, modelos e thinking não são tocados.
 *
 * - opt-out (`AGENT_DISABLED=1`) ou `enabled:false` → `mode:"legacy"`, sem nenhuma `AGENT_JUICE_*`
 *   (ambiente herdado é limpo dessas chaves: sem contabilização fantasma).
 * - habilitado → `mode:"agent"` com o par Pi+artefato validado, caminhos físicos e fixos.
 * - habilitado e algo quebrado → erro. Nunca lançar anunciando contabilização sem tê-la.
 */
export function buildAgentLaunch({ store, env = process.env, args = [] } = {}) {
	const root = storeRoot(store);
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("args tem de ser um array de strings");
	if (!env || typeof env !== "object") fail("env tem de ser um objeto");
	const configPath = agentConfigPath(root);
	const passthrough = Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
	const legacy = (reason) => {
		const cleaned = { ...passthrough };
		const warnings = [];
		// O preload lembra o valor nativo antes da curadoria. O caminho legado não
		// carrega o preload, portanto restaura aqui antes de limpar as chaves Agent. Este caminho é o
		// escape do launcher: um snapshot ilegível vira aviso, nunca erro.
		const snapshotKey = Object.hasOwn(cleaned, "AGENT_SKILLS_BEFORE") ? "AGENT_SKILLS_BEFORE" : "AGENT_JUICE_SKILLS_BEFORE";
		if (Object.hasOwn(cleaned, snapshotKey)) {
			let previous;
			try {
				previous = JSON.parse(cleaned[snapshotKey]);
				if (previous !== null && typeof previous !== "string") throw new Error("não é string nem null");
			} catch (error) {
				previous = undefined;
				warnings.push(`${snapshotKey} ilegível (${error.message}): PI_AUTOMATIC_SKILLS mantido como veio`);
			}
			if (previous === null) delete cleaned.PI_AUTOMATIC_SKILLS;
			else if (previous !== undefined) cleaned.PI_AUTOMATIC_SKILLS = previous;
		}
		// Nenhuma AGENT_JUICE_* herdada sobrevive ao caminho legado: um `pi` sem gate não pode
		// aparentar estar contabilizando.
		for (const key of Object.keys(cleaned)) if (key.startsWith("AGENT_JUICE_") || ["AGENT_SKILLS_BEFORE", "AGENT_ARTIFACT", "AGENT_ARTIFACT_ROOT", "AGENT_RUNTIME_ENABLED", "AGENT_PI_ROOT", "AGENT_CHILD"].includes(key)) delete cleaned[key];
		cleaned.NODE_OPTIONS = mergeNodeOptionsLegacy(cleaned.NODE_OPTIONS, warnings);
		if (cleaned.NODE_OPTIONS === "") delete cleaned.NODE_OPTIONS;
		const pi = legacyPiCommand(root);
		return {
			mode: "legacy",
			reason,
			store: root,
			configPath,
			command: pi.command,
			args: [...pi.args, ...args],
			env: cleaned,
			warnings,
		};
	};
	if (env[DISABLE_ENV] === "1") return legacy(`${DISABLE_ENV}=1`);
	const config = readAgentConfig(root);
	if (!config) return legacy("sem configuração Agent instalada");
	if (!config.enabled) return legacy(`${configPath} tem enabled:false`);

	const artifact = validateAgentArtifact({ store: root, artifactId: config.artifactId, piRoot: config.piRoot });
	requirePhysical(config.piRoot, `"piRoot" de ${configPath}`);
	const lean = artifact.manifest.version >= 3;
	if (!lean && config.version !== 1) fail("artefato legado exige configuração v1 com juiceHome declarado");
	const juiceHome = lean ? undefined : requireDirectory(config.juiceHome, `"juiceHome" de ${configPath}`);
	const ledgerPath = lean ? undefined : join(juiceHome, artifact.brokerPath ? "run.json" : LEDGER_FILE);
	const preload = `--import=${pathToFileURL(artifact.runtimePreload).href}`;
	const warnings = [];
	const nextEnv = { ...passthrough };
	// Filho herdado de outra sessão criaria um run novo (ou exigiria um pai que não existe): este
	// processo é o pai do run.
	for (const key of Object.keys(nextEnv)) if (key.startsWith("AGENT_JUICE_") || ["AGENT_RUNTIME_ENABLED", "AGENT_PI_ROOT", "AGENT_CHILD", "AGENT_SKILLS_BEFORE"].includes(key)) delete nextEnv[key];
	if (lean) {
		nextEnv.AGENT_RUNTIME_ENABLED = "1";
		nextEnv.AGENT_PI_ROOT = artifact.piRoot;
		nextEnv.PI_DURABLE_HOST = "0";
	} else {
		nextEnv.AGENT_JUICE_ENABLED = "1";
		if (artifact.brokerPath) nextEnv.AGENT_JUICE_BIN = artifact.brokerPath;
		nextEnv.AGENT_JUICE_HOME = juiceHome;
		nextEnv.AGENT_JUICE_STATE = ledgerPath;
		nextEnv.AGENT_JUICE_PI_ROOT = artifact.piRoot;
		if (artifact.manifest.piEntry === DURABLE_PI_ENTRY) nextEnv.AGENT_JUICE_PI_ENTRY = "bundle";
		else nextEnv.PI_DURABLE_HOST = "0";
	}
	nextEnv.AGENT_ARTIFACT = artifact.artifactId;
	// Physical path of the pair this process started with: children inherit it and GC sees it in
	// `ps eww` even when the preload URL is percent-encoded.
	nextEnv.AGENT_ARTIFACT_ROOT = artifact.artifactRoot;
	// Cache Anthropic de 1 h: com o cache-keeper (ping a 90% do TTL) custa ~45% menos que 5 min
	// nas pausas reais do Gabriel. Valor já definido pelo usuário (inclusive `none`) prevalece.
	if (!nextEnv.PI_CACHE_RETENTION) nextEnv.PI_CACHE_RETENTION = "long";
	// O aviso "Update Available" do Pi upstream é enganoso aqui: o Pi do Agent só muda por artefato
	// (`agent update`). Valor do usuário prevalece; vazio religa a checagem.
	if (nextEnv.PI_SKIP_VERSION_CHECK === undefined) nextEnv.PI_SKIP_VERSION_CHECK = "1";
	nextEnv.NODE_OPTIONS = mergeNodeOptions(passthrough.NODE_OPTIONS, preload, warnings);
	return {
		mode: "agent",
		reason: `${configPath} habilitado`,
		store: root,
		configPath,
		command: process.execPath,
		args: [artifact.piEntry, ...args],
		env: nextEnv,
		artifactId: artifact.artifactId,
		artifactRoot: artifact.artifactRoot,
		agentRoot: artifact.agentRoot,
		brokerPath: artifact.brokerPath,
		piRoot: artifact.piRoot,
		piEntry: artifact.piEntry,
		juiceHome,
		ledgerPath,
		manifestPath: artifact.manifestPath,
		preload,
		resourceReceipt: config.resourceReceipt ?? null,
		warnings,
	};
}

/** No caminho legado o preload de um Agent herdado também sai: ele importaria o gate sem env. */
function mergeNodeOptionsLegacy(value, warnings) {
	// Preserve raw quoting of unrelated options (paths with spaces included).
	const tokens = typeof value === "string" ? value.match(/(?:[^\s"']+|"[^"\n]*"|'[^'\n]*')+/g) ?? [] : [];
	const kept = [];
	const unquote = (s) => s.replace(/["']/g, "");
	for (let i = 0; i < tokens.length; i++) {
		const token = unquote(tokens[i]);
		const separate = /^--(?:import|require|experimental-loader|loader)$/.test(token);
		const target = separate ? unquote(tokens[i + 1] ?? "") : token.replace(/^--[^=]+=/, "");
		if ((separate || /^--(?:import|require|experimental-loader|loader)=/.test(token)) && /(?:core|juice)[\\/]runtime\.mjs(?:$|[?#])/.test(target)) {
			warnings.push("NODE_OPTIONS: preload herdado do Agent removido");
			if (separate) i++;
			continue;
		}
		kept.push(tokens[i]);
	}
	return kept.join(" ");
}

/** Caminhos que o store usa, para o updater e os testes falarem a mesma língua. */
export const agentPaths = (store) => ({
	root: agentRuntimeRoot(store),
	config: agentConfigPath(store),
	releases: agentReleasesDir(store),
	buildCache: join(agentRuntimeRoot(store), BUILD_CACHE_SUBDIR),
});
