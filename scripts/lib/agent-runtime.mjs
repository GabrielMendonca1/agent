/**
 * MARK II: artefato imutável, configuração declarativa e lançamento da release física.
 * v2 empacota somente mark/ (sem runtime nativo).
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
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MARK_II_DIR = "mark-ii";
export const RELEASES_SUBDIR = "releases";
export const BUILD_CACHE_SUBDIR = "build-cache";
export const CONFIG_FILE = "config.json";
export const MANIFEST_FILE = "manifest.json";
/** Árvore vendorizada dentro do artefato: `markRoot = artifactRoot/mark`. */
export const MARK_SUBDIR = "mark";
const LEGACY_NATIVE_DIR = "broker";
const LEGACY_NATIVE_NAME = process.platform === "win32" ? "mark-juice.exe" : "mark-juice";
/** Preload do gate de contabilização, relativo a `markRoot`. */
export const RUNTIME_PRELOAD = "juice/runtime.mjs";
/** Classic CLI and its shared ModelRuntime module. */
export const PI_ENTRY = "dist/cli.js";
const DURABLE_PI_ENTRY = "dist/bundle/cli.js";
/** Pacote do Pi oficial que o overlay instala na release. */
const OFFICIAL_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_RUNTIME_MODULE = "dist/core/model-runtime.js";
export const LEDGER_FILE = "run.v3.json";
export const CONFIG_VERSION = 1;
export const ARTIFACT_VERSION = 2;
export const DISABLE_ENV = "MARK_II_DISABLED";
/** Chaves que o launcher escreve. Qualquer outra do ambiente real passa intacta. */
export const MANAGED_ENV_KEYS = [
	"MARK_JUICE_ENABLED",
	"MARK_JUICE_BIN",
	"MARK_JUICE_HOME",
	"MARK_JUICE_STATE",
	"MARK_JUICE_PI_ROOT",
	"MARK_JUICE_PI_ENTRY",
	"MARK_II_ARTIFACT",
	"NODE_OPTIONS",
];
const CONFIG_KEYS = new Set(["version", "enabled", "artifactId", "piRoot", "juiceHome", "resourceReceipt"]);
const ARTIFACT_ID = /^[0-9a-f]{64}$/;
const ignoredTreeEntries = new Set([".DS_Store", "node_modules", "__pycache__", "target"]);
const isWindows = process.platform === "win32";

function fail(message) {
	throw new Error(`MARK II: ${message}`);
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
	return process.env.PI_OVERLAY_STORE ? resolve(process.env.PI_OVERLAY_STORE) : join(homedir(), ".local", "share", "pi-overlay");
}

function storeRoot(store) {
	return requirePlainAbsolute(typeof store === "string" ? resolve(store) : store, "store");
}

export function markIIRoot(store) {
	return join(storeRoot(store), MARK_II_DIR);
}

export function markIIConfigPath(store) {
	return join(markIIRoot(store), CONFIG_FILE);
}

export function markIIReleasesDir(store) {
	return join(markIIRoot(store), RELEASES_SUBDIR);
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

/** Arquivos da árvore `mark/` do artefato: `{ "juice/runtime.mjs": "x<sha>" | "-<sha>" }`. */
function hashTree(root) {
	const files = {};
	const walk = (relative) => {
		const directory = relative ? join(root, relative) : root;
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (ignoredTreeEntries.has(entry.name)) continue;
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			const full = join(directory, entry.name);
			if (entry.isSymbolicLink()) fail(`o artefato não pode conter links simbólicos: ${full}`);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) files[child] = `${statSync(full).mode & 0o111 ? "x" : "-"}${sha256File(full)}`;
			else fail(`entrada de tipo não suportado no artefato: ${full}`);
		}
	};
	walk("");
	if (Object.keys(files).length === 0) fail(`a árvore mark/ do artefato está vazia: ${root}`);
	return files;
}

function artifactDigest({ files, broker, piRoot, piEntry, version = ARTIFACT_VERSION }) {
	const hash = createHash("sha256");
	hash.update(`mark-ii-artifact v${version}\0${process.platform}\0${process.arch}\0${piRoot}\0${piEntry}\0`);
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
			fail(`piRoot ${root} não tem ${relative}: o MARK II exige o CLI clássico e ModelRuntime`);
		}
		const file = join(root, relative);
		requireRegularFile(file, "entrada do Pi");
		if (physicalPath(file, "entrada do Pi") !== file) fail(`entrada do Pi resolve fora do caminho físico: ${file}`);
	}
	return root;
}

// ---------------------------------------------------------------------------- artefato

/**
 * Prepara (ou reaproveita) o artefato do par Pi+MARK II. Não toca em configuração, ledger,
 * settings nem no launcher ativo: só escreve sob `<store>/mark-ii/releases`.
 */
export function prepareMarkIIArtifact({ sourceRoot, store, piRoot, log = console.log } = {}) {
	const source = requireDirectory(typeof sourceRoot === "string" ? resolve(sourceRoot) : sourceRoot, "sourceRoot");
	const markSource = requireDirectory(join(source, MARK_SUBDIR), "árvore mark/ de origem");
	if (!existsSync(join(markSource, RUNTIME_PRELOAD))) {
		fail(`a árvore de origem não tem ${MARK_SUBDIR}/${RUNTIME_PRELOAD}; sem o preload não há contabilização`);
	}
	const root = storeRoot(store);
	const pi = requirePiRoot(piRoot);
	const releasesDir = join(markIIRoot(root), RELEASES_SUBDIR);
	mkdirSync(releasesDir, { recursive: true });

	const stage = join(releasesDir, `.stage-${process.pid}-${Date.now().toString(36)}`);
	rmSync(stage, { recursive: true, force: true });
	try {
		mkdirSync(stage, { recursive: true });
		cpSync(markSource, join(stage, MARK_SUBDIR), {
			recursive: true,
			dereference: true,
			filter: (path) => !ignoredTreeEntries.has(basename(path)),
		});
		const files = hashTree(join(stage, MARK_SUBDIR));
		const artifactId = artifactDigest({ files, piRoot: pi, piEntry: PI_ENTRY });
		const artifactRoot = join(releasesDir, artifactId);

		if (existsSync(artifactRoot)) {
			try {
				const reused = validateMarkIIArtifact({ store: root, artifactId, piRoot: pi });
				log(`MARK II: artefato ${artifactId.slice(0, 12)} já instalado e válido (${artifactRoot})`);
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
			markSubdir: MARK_SUBDIR,
			runtimePreload: `${MARK_SUBDIR}/${RUNTIME_PRELOAD}`,
			files,
		};
		writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
		chmodSync(join(stage, MANIFEST_FILE), 0o444);
		freezeTree(join(stage, MARK_SUBDIR));
		renameSync(stage, artifactRoot);
		log(`MARK II: artefato ${artifactId.slice(0, 12)} preparado em ${artifactRoot}`);
		return validateMarkIIArtifact({ store: root, artifactId, piRoot: pi });
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/**
 * Valida um artefato instalado e devolve os caminhos físicos dele. O nome do diretório é o digest
 * do conteúdo: qualquer alteração em arquivo, broker ou manifesto quebra a conferência.
 */
export function validateMarkIIArtifact({ store, artifactId, piRoot } = {}) {
	if (typeof artifactId !== "string" || !ARTIFACT_ID.test(artifactId)) {
		fail(`artifactId inválido: ${JSON.stringify(artifactId)} (esperado digest sha256 em hex)`);
	}
	const releasesDir = join(markIIRoot(store), RELEASES_SUBDIR);
	const releasesReal = requireDirectory(releasesDir, "diretório de releases do MARK II");
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
	if (![1, ARTIFACT_VERSION].includes(manifest.version)) fail(`manifesto versão ${manifest.version} não suportada (esperado ${ARTIFACT_VERSION}): ${manifestPath}`);
	if (manifest.artifactId !== artifactId) fail(`manifesto declara artifactId ${manifest.artifactId}, mas está em ${artifactId}`);
	if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
		fail(`artefato ${artifactId.slice(0, 12)} foi preparado para ${manifest.platform}/${manifest.arch}; esta máquina é ${process.platform}/${process.arch}`);
	}
	// Entradas conhecidas são relativas e confinadas ao piRoot físico. A entrada declarada
	// já participa do digest v1: aceitar o host histórico não muda a identidade do artefato.
	if (![PI_ENTRY, DURABLE_PI_ENTRY].includes(manifest.piEntry)) fail(`entrada do Pi não suportada: ${manifest.piEntry}`);
	if (manifest.runtimePreload !== `${MARK_SUBDIR}/${RUNTIME_PRELOAD}`) fail(`runtimePreload inesperado: ${manifest.runtimePreload}`);

	const markRoot = join(artifactReal, manifest.markSubdir === MARK_SUBDIR ? MARK_SUBDIR : fail(`markSubdir inesperado: ${manifest.markSubdir}`));
	requireDirectory(markRoot, "árvore mark/ do artefato");
	if (!existsSync(join(markRoot, RUNTIME_PRELOAD))) fail(`artefato sem ${MARK_SUBDIR}/${RUNTIME_PRELOAD}: ${markRoot}`);
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

	const files = hashTree(markRoot);
	const declared = manifest.files;
	if (!declared || typeof declared !== "object" || Array.isArray(declared)) fail(`manifesto sem mapa de arquivos: ${manifestPath}`);
	for (const [relative, value] of Object.entries(files)) {
		if (!(relative in declared)) fail(`arquivo não declarado no manifesto do artefato: ${MARK_SUBDIR}/${relative}`);
		if (declared[relative] !== value) fail(`arquivo alterado no artefato: ${MARK_SUBDIR}/${relative}`);
	}
	for (const relative of Object.keys(declared)) {
		if (!(relative in files)) fail(`arquivo declarado no manifesto e ausente do artefato: ${MARK_SUBDIR}/${relative}`);
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
		markRoot,
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
	if (config.version !== CONFIG_VERSION) fail(`configuração versão ${JSON.stringify(config.version)} não suportada (esperado ${CONFIG_VERSION}; ${where})`);
	if (typeof config.enabled !== "boolean") fail(`"enabled" tem de ser booleano (${where})`);
	if (typeof config.artifactId !== "string" || !ARTIFACT_ID.test(config.artifactId)) fail(`"artifactId" inválido (${where}): ${JSON.stringify(config.artifactId)}`);
	requirePlainAbsolute(config.piRoot, `"piRoot" (${where})`);
	requirePlainAbsolute(config.juiceHome, `"juiceHome" (${where})`);
	if (config.resourceReceipt !== undefined) requirePlainAbsolute(config.resourceReceipt, `"resourceReceipt" (${where})`);
	const normalized = {
		version: CONFIG_VERSION,
		enabled: config.enabled,
		artifactId: config.artifactId,
		piRoot: config.piRoot,
		juiceHome: config.juiceHome,
	};
	if (config.resourceReceipt !== undefined) normalized.resourceReceipt = config.resourceReceipt;
	return normalized;
}

/** `null` quando não há opt-in nenhum; a config validada quando há; erro quando há e está ruim. */
export function readMarkIIConfig(store) {
	const path = markIIConfigPath(store);
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

/** Escrita atômica da configuração validada. `resourceReceipt` do B é preservado como veio. */
export function writeMarkIIConfig({ store, config } = {}) {
	const path = markIIConfigPath(store);
	const normalized = validateConfig(config, path);
	mkdirSync(markIIRoot(store), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	rmSync(temporary, { force: true });
	writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
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
	const tokens = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
	const kept = [];
	let present = false;
	for (const token of tokens) {
		if (token === preload) {
			if (present) continue;
			present = true;
			kept.push(token);
			continue;
		}
		if (/^--(?:import|require|experimental-loader|loader)=.*juice[\\/]runtime\.mjs/.test(token)) {
			warnings.push(`NODE_OPTIONS: preload de outro MARK II removido para não instalar dois gates (${token})`);
			continue;
		}
		kept.push(token);
	}
	if (!present) kept.push(preload);
	return kept.join(" ");
}

/**
 * O que executar para esta sessão. `env` é o ambiente REAL do usuário e sai preservado: HOME,
 * USERPROFILE, XDG_*, PI_CODING_AGENT_DIR, PI_SYSTEM_DIR, modelos e thinking não são tocados.
 *
 * - opt-out (`MARK_II_DISABLED=1`) ou `enabled:false` → `mode:"legacy"`, sem nenhuma `MARK_JUICE_*`
 *   (ambiente herdado é limpo dessas chaves: sem contabilização fantasma).
 * - habilitado → `mode:"mark-ii"` com o par Pi+artefato validado, caminhos físicos e fixos.
 * - habilitado e algo quebrado → erro. Nunca lançar anunciando contabilização sem tê-la.
 */
export function buildMarkIILaunch({ store, env = process.env, args = [] } = {}) {
	const root = storeRoot(store);
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("args tem de ser um array de strings");
	if (!env || typeof env !== "object") fail("env tem de ser um objeto");
	const configPath = markIIConfigPath(root);
	const passthrough = Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
	const legacy = (reason) => {
		const cleaned = { ...passthrough };
		const warnings = [];
		// O preload lembra o valor nativo antes da curadoria. O caminho legado não
		// carrega o preload, portanto restaura aqui antes de limpar as chaves Mark. Este caminho é o
		// escape do launcher: um snapshot ilegível vira aviso, nunca erro.
		if (Object.hasOwn(cleaned, "MARK_JUICE_SKILLS_BEFORE")) {
			let previous;
			try {
				previous = JSON.parse(cleaned.MARK_JUICE_SKILLS_BEFORE);
				if (previous !== null && typeof previous !== "string") throw new Error("não é string nem null");
			} catch (error) {
				previous = undefined;
				warnings.push(`MARK_JUICE_SKILLS_BEFORE ilegível (${error.message}): PI_AUTOMATIC_SKILLS mantido como veio`);
			}
			if (previous === null) delete cleaned.PI_AUTOMATIC_SKILLS;
			else if (previous !== undefined) cleaned.PI_AUTOMATIC_SKILLS = previous;
		}
		// Nenhuma MARK_JUICE_* herdada sobrevive ao caminho legado: um `pi` sem gate não pode
		// aparentar estar contabilizando.
		for (const key of Object.keys(cleaned)) if (key.startsWith("MARK_JUICE_") || key === "MARK_II_ARTIFACT") delete cleaned[key];
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
	const config = readMarkIIConfig(root);
	if (!config) return legacy("sem configuração MARK II instalada");
	if (!config.enabled) return legacy(`${configPath} tem enabled:false`);

	const artifact = validateMarkIIArtifact({ store: root, artifactId: config.artifactId, piRoot: config.piRoot });
	requirePhysical(config.piRoot, `"piRoot" de ${configPath}`);
	const juiceHome = requireDirectory(config.juiceHome, `"juiceHome" de ${configPath}`);
	const ledgerPath = join(juiceHome, artifact.brokerPath ? "run.json" : LEDGER_FILE);
	const preload = `--import=${pathToFileURL(artifact.runtimePreload).href}`;
	const warnings = [];
	const nextEnv = { ...passthrough };
	// Filho herdado de outra sessão criaria um run novo (ou exigiria um pai que não existe): este
	// processo é o pai do run.
	delete nextEnv.MARK_JUICE_CHILD;
	nextEnv.MARK_JUICE_ENABLED = "1";
	if (artifact.brokerPath) nextEnv.MARK_JUICE_BIN = artifact.brokerPath; // v1 rollback only
	else delete nextEnv.MARK_JUICE_BIN;
	nextEnv.MARK_JUICE_HOME = juiceHome;
	nextEnv.MARK_JUICE_STATE = ledgerPath;
	nextEnv.MARK_JUICE_PI_ROOT = artifact.piRoot;
	if (artifact.manifest.piEntry === DURABLE_PI_ENTRY) {
		nextEnv.MARK_JUICE_PI_ENTRY = "bundle";
	} else {
		delete nextEnv.MARK_JUICE_PI_ENTRY;
		nextEnv.PI_DURABLE_HOST = "0";
	}
	nextEnv.MARK_II_ARTIFACT = artifact.artifactId;
	// Cache Anthropic de 1 h: com o cache-keeper (ping a 90% do TTL) custa ~45% menos que 5 min
	// nas pausas reais do Gabriel. Valor já definido pelo usuário (inclusive `none`) prevalece.
	if (!nextEnv.PI_CACHE_RETENTION) nextEnv.PI_CACHE_RETENTION = "long";
	nextEnv.NODE_OPTIONS = mergeNodeOptions(passthrough.NODE_OPTIONS, preload, warnings);
	return {
		mode: "mark-ii",
		reason: `${configPath} habilitado`,
		store: root,
		configPath,
		command: process.execPath,
		args: [artifact.piEntry, ...args],
		env: nextEnv,
		artifactId: artifact.artifactId,
		artifactRoot: artifact.artifactRoot,
		markRoot: artifact.markRoot,
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

/** No caminho legado o preload de um MARK II herdado também sai: ele importaria o gate sem env. */
function mergeNodeOptionsLegacy(value, warnings) {
	const tokens = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
	const kept = [];
	for (const token of tokens) {
		if (/^--(?:import|require|experimental-loader|loader)=.*juice[\\/]runtime\.mjs/.test(token)) {
			warnings.push(`NODE_OPTIONS: preload do MARK II removido no caminho legado (${token})`);
			continue;
		}
		kept.push(token);
	}
	return kept.join(" ");
}

/** Caminhos que o store usa, para o updater e os testes falarem a mesma língua. */
export const markIIPaths = (store) => ({
	root: markIIRoot(store),
	config: markIIConfigPath(store),
	releases: markIIReleasesDir(store),
	buildCache: join(markIIRoot(store), BUILD_CACHE_SUBDIR),
});
