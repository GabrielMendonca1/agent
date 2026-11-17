#!/usr/bin/env node
import { createHash } from "node:crypto";
import { validateDirectory, downloadArtifact, bootstrap } from "./lib/agent-distribution.mjs";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { acquireStoreLock, assertCurrentUnchanged, readCurrentTarget } from "./lib/store-lock.mjs";
import {
	LAYERS_FILE,
	isOptionalPatch,
	markersForPatches,
	optionalLayersFromRecord,
	parseLayerNames,
	readStoreLayers,
	seedLayersFromActive,
	selectLayers,
	writeStoreLayers,
} from "./lib/layers.mjs";
import { extensionFiles, syncAgentExtensions } from "./lib/extensions.mjs";
import { agentSetupFiles, syncAgentSetup } from "./lib/agent-setup.mjs";
import { checkoutInfo, commitsAhead } from "./lib/overlay-stale.mjs";
import { skillFiles, syncAgentSkills } from "./lib/skills.mjs";
import { pinInternalPackages, verifyInstalledInternalPackages } from "./lib/internal-packages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "overlay", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const productDisplayName = manifest.name;
const defaultStore = join(homedir(), ".local", "share", "agent");
const releaseMetadataFile = "agent-release.json";
const digestAlgorithm = 3;
const supportedDigestAlgorithms = new Set([1, 2, 3]);
const ignoredTreeEntries = new Set([".DS_Store"]);
// Releases órfãs (nem current/previous, nem preparadas, nem em uso pelo Agent) mantidas pelo update.
const orphanReleaseRetention = 1;
// Backups de launcher mantidos pelo `overlay-gc`.
const backupRetention = 5;
// Nomes que o updater gera em backups/: carimbo ISO (backupLauncher) e carimbo + "-agent-<rótulo>" (captureAgentBackup).
const updaterBackupName = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(?:-agent-([a-z]+))?$/;
// Camadas que saíram do overlay; independente do manifesto, que pode já nem listá-las.
const removedLayers = {
	"context-windows":
		"layer context-windows was removed in 2026-10. It was never ported past Pi 0.87. Run without it, or check out an older agent to keep it.",
};
// Receipt v1 additionally hashes raw bytes and file modes; not a runtime digest format.
const receiptDigestAlgorithm = 0;
const updaterGeneration = 5;

const isWindows = process.platform === "win32";

/**
 * `tar` do Windows: o bsdtar de System32 entende `C:\\...`. Num shell Git Bash o `tar` do PATH é o
 * GNU tar, que lê `C:` como host remoto ("Cannot connect to C: resolve failed").
 */
function tarCommand() {
	if (!isWindows) return "tar";
	const system = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
	return existsSync(system) ? system : "tar";
}

/**
 * Agent viaja no bundle instalado como três arquivos: o helper de runtime/artefatos, o helper de
 * recursos e o CLI de lançamento. O updater não os reimplementa — ele os importa do próprio bundle
 * em que está rodando (`repoRoot`), que é imutável e content-addressed. Um checkout que ainda não
 * carrega esses arquivos continua instalando e atualizando pelo caminho legado.
 */
const agentFiles = {
	runtime: "scripts/lib/agent-runtime.mjs",
	resources: "scripts/lib/agent-resources.mjs",
	launch: "scripts/agent-launch.mjs",
};
const agentRuntimeExports = [
	"prepareAgentArtifact",
	"validateAgentArtifact",
	"readAgentConfig",
	"writeAgentConfig",
];
const agentResourceExports = ["planAgentResources", "applyAgentResources", "rollbackAgentResources"];
const agentStoreDir = "runtime";

// No Windows `npm`/`npx` são scripts .cmd, e desde a correção de CVE-2024-27980 o Node recusa
// spawná-los sem shell. Rodar por shell significa montar a linha de comando à mão, com quoting
// explícito: um caminho com espaço (`C:\Users\João Silva\...`) partido em dois argumentos faria o
// npm instalar em outro lugar, silenciosamente.
const windowsShellCommands = new Set(["npm", "npx"]);

function needsWindowsShell(command) {
	return isWindows && (windowsShellCommands.has(command) || /\.(cmd|bat)$/i.test(command));
}

function fail(message) {
	throw new Error(message);
}

function quoteForCmd(argument) {
	const value = String(argument);
	if (/[\r\n\0]/.test(value)) fail(`Cannot pass an argument with a newline through cmd.exe: ${JSON.stringify(value)}`);
	// cmd.exe expande %VAR% mesmo dentro de aspas e não tem escape confiável para `%`: recusar é
	// honesto, silenciar seria instalar em um caminho que ninguém pediu.
	if (value.includes("%")) fail(`Cannot pass an argument containing "%" through cmd.exe: ${JSON.stringify(value)}`);
	if (value === "") return '""';
	if (!/[\s"&|<>^()!,;=]/.test(value)) return value;
	// Dentro de aspas, uma barra invertida só é especial quando precede uma aspa.
	const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
	return `"${escaped}"`;
}

function run(command, args, options = {}) {
	console.log(`+ ${command} ${args.join(" ")}`);
	const shell = needsWindowsShell(command);
	// Com `shell: true` o Node junta command e args sem nenhum quoting; a linha vai montada daqui.
	const line = shell ? [command, ...args].map(quoteForCmd).join(" ") : command;
	const result = spawnSync(line, shell ? [] : args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
		shell,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) fail(`${command} failed with exit code ${result.status}`);
	return options.capture ? result.stdout.trim() : "";
}

/**
 * Onde mora o binário instalado de uma release.
 *
 * `npm install --global --prefix X` grava `X/bin/pi` no POSIX, mas `X/pi.cmd` (mais `X/pi.ps1` e o
 * script POSIX `X/pi`) no Windows — sem `bin/`. Quem procurar `bin/pi` no Windows conclui que a
 * instalação falhou ou que toda release está degradada.
 */
function releaseBinaryCandidates(root) {
	return isWindows
		? [join(root, "pi.cmd"), join(root, "pi.ps1"), join(root, "pi"), join(root, "bin", "pi")]
		: [join(root, "bin", "pi")];
}

function releaseBinary(root) {
	const candidates = releaseBinaryCandidates(root);
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
	const args = argv[0] === "update" ? argv.slice(1) : argv;
	const parsed = {
		ref: "release",
		check: false,
		hydrate: false,
		rollback: false,
		simulateConflict: false,
		force: false,
		noPrune: false,
		adoptLauncher: false,
		vendorModelData: false,
		agentEnable: false,
		agentDisable: false,
		status: false,
		gc: false,
		dryRun: false,
		keep: 1,
		with: [],
		without: [],
		store: process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : defaultStore,
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--install-artifact") parsed.installArtifact = args[++index] ?? fail("--install-artifact requires a path, latest or release tag");
		else if (arg === "--release-tag") parsed.releaseTag = args[++index] ?? fail("--release-tag requires a tag");
		else if (arg === "--release-repo") parsed.releaseRepo = args[++index] ?? fail("--release-repo requires a repo");
		else if (arg === "--prepare") parsed.prepare = true;
		else if (arg === "--promote") parsed.promote = args[++index] ?? fail("--promote requires a release ID");
		else if (arg === "--check") parsed.check = true;
		else if (arg === "--hydrate") parsed.hydrate = true;
		else if (arg === "--rollback") parsed.rollback = true;
		else if (arg === "--status") parsed.status = true;
		else if (arg === "--gc") parsed.gc = true;
		else if (arg === "--dry-run") parsed.dryRun = true;
		else if (arg === "--keep") {
			const value = args[++index];
			if (!/^\d+$/.test(value ?? "")) fail("--keep requires a non-negative integer");
			parsed.keep = Number(value);
		}
		else if (arg === "--simulate-conflict") parsed.simulateConflict = true;
		else if (arg === "--force") parsed.force = true;
		else if (arg === "--no-prune") parsed.noPrune = true;
		else if (arg === "--adopt-launcher") parsed.adoptLauncher = true;
		else if (arg === "--vendor-model-data") parsed.vendorModelData = true;
		else if (arg === "--agent-enable") parsed.agentEnable = true;
		else if (arg === "--agent-disable") parsed.agentDisable = true;
		else if (arg === "--juice-home") parsed.juiceHome = args[++index] ?? fail("--juice-home requires an absolute path");
		else if (arg === "--with") parsed.with.push(args[++index] ?? fail("--with requires a layer name"));
		else if (arg === "--without") parsed.without.push(args[++index] ?? fail("--without requires a layer name"));
		else if (arg === "--ref") parsed.ref = args[++index] ?? fail("--ref requires a value");
		else if (arg === "--store") parsed.store = resolve(args[++index] ?? fail("--store requires a value"));
		else fail(`Unknown overlay update option: ${arg}. Usage: agent-update [--prepare | --promote <releaseId> | --check | --rollback | --agent-enable | --agent-disable | --install-artifact <archive|latest|tag> | --status | --gc [--dry-run] [--keep <N>]] [--hydrate] [--ref <vX.Y.Z|latest>] [--with <layer>] [--without <layer>] [--rollback] [--force] [--no-prune] [--adopt-launcher] [--vendor-model-data] [--store <path>]`);
	}
	const modes = [parsed.installArtifact !== undefined, parsed.prepare, parsed.promote !== undefined, parsed.check, parsed.rollback, parsed.agentEnable, parsed.agentDisable, parsed.status, parsed.gc].filter(Boolean);
	if (modes.length > 1) {
		fail("--prepare, --promote, --install-artifact, --check, --rollback, --agent-enable, --agent-disable, --status and --gc are mutually exclusive");
	}
	const reject = (flags) => {
		for (const flag of flags) if (args.includes(flag)) fail(`${flag} is incompatible with this mode`);
	};
	if (parsed.status || parsed.gc) {
		reject(["--ref", "--with", "--without", "--hydrate", "--vendor-model-data", "--simulate-conflict", "--no-prune", "--force", "--adopt-launcher"]);
	}
	if (parsed.status && (args.includes("--dry-run") || args.includes("--keep"))) fail("--dry-run and --keep are only valid with --gc");
	if (!parsed.gc && (args.includes("--dry-run") || args.includes("--keep"))) fail("--dry-run and --keep are only valid with --gc");
	if (parsed.installArtifact !== undefined) reject(["--ref", "--with", "--without", "--hydrate", "--vendor-model-data", "--simulate-conflict", "--force", "--juice-home"]);
	if (parsed.promote !== undefined) reject(["--ref", "--with", "--without", "--hydrate", "--vendor-model-data", "--simulate-conflict"]);
	if (parsed.prepare) reject(["--adopt-launcher", "--no-prune", "--force"]);
	// Habilitar/desabilitar Agent não constrói nem seleciona camadas: ele opera sobre a release que
	// já está ativa. Aceitar uma flag de build aqui prometeria uma reconstrução que não acontece.
	if (parsed.agentEnable || parsed.agentDisable) {
		reject(["--ref", "--with", "--without", "--hydrate", "--vendor-model-data", "--simulate-conflict", "--no-prune"]);
	}
	if (parsed.juiceHome !== undefined) {
		if (!parsed.agentEnable) fail("--juice-home is only valid with --agent-enable");
		if (!isAbsolute(parsed.juiceHome) || parsed.juiceHome.split(/[\\/]/).includes("..")) {
			fail(`--juice-home requires an absolute path without "..": got ${JSON.stringify(parsed.juiceHome)}`);
		}
		parsed.juiceHome = resolve(parsed.juiceHome);
	}
	// Preserve previously accepted check/rollback flags; restrictions above belong to the new modes.
	if (parsed.promote !== undefined) validateReleaseId(parsed.promote);
	parsed.adoptLauncher = parsed.adoptLauncher || parsed.store === defaultStore;
	parsed.with = parseLayerNames(parsed.with);
	parsed.without = parseLayerNames(parsed.without);
	// Pedir explicitamente uma camada removida é erro; a registrada no store só vira aviso (build()).
	for (const name of parsed.with) if (removedLayers[name]) fail(removedLayers[name]);
	parsed.without = parsed.without.filter((name) => !removedLayers[name]);
	// Vendorar snapshot é uma operação de autoria sobre o checkout, não parte de um install:
	// ela só faz sentido depois de um gate verde que acabou de hidratar o catálogo ao vivo.
	if (parsed.vendorModelData && !(parsed.check && parsed.hydrate)) {
		fail("--vendor-model-data requires --check --hydrate: it records the freshly hydrated dataset into overlay/model-data");
	}
	return parsed;
}

function linkExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Remove o ponteiro, nunca o alvo: uma junction se apaga com rmdir, um link de arquivo com unlink. */
function removeLink(path) {
	if (!linkExists(path)) return;
	try {
		rmdirSync(path);
		return;
	} catch {
		// Não é diretório nem junction.
	}
	try {
		unlinkSync(path);
	} catch {
		rmSync(path, { force: true });
	}
}

function atomicSymlink(target, linkPath) {
	mkdirSync(dirname(linkPath), { recursive: true });
	const temporary = `${linkPath}.tmp-${process.pid}`;
	removeLink(temporary);
	// No Windows, symlink de diretório exige privilégio de administrador ou Developer Mode; junction
	// não exige nada e é exatamente o que `current`/`previous` precisam ser (ponteiros para diretórios
	// de release). Sem isso a ativação falha com EPERM na máquina de um sócio.
	const type = isWindows ? (existsSync(target) && statSync(target).isDirectory() ? "junction" : "file") : undefined;
	symlinkSync(target, temporary, type);
	// No POSIX o rename troca o ponteiro atomicamente, inclusive por cima de um link existente; no
	// Windows ele falha se o destino existir, então o antigo sai primeiro.
	if (isWindows) removeLink(linkPath);
	renameSync(temporary, linkPath);
}

function linkTarget(path) {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Texto cru de um link de ativação (`current`/`previous`), ou undefined se não existir. */
function readCurrentTargetText(path) {
	try {
		return readlinkSync(path);
	} catch {
		return undefined;
	}
}

function resolvedPath(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

async function rollback(store, options) {
	const current = join(store, "current");
	const previous = join(store, "previous");
	const currentTarget = linkTarget(current);
	const previousTarget = linkTarget(previous);
	if (!previousTarget) fail(`No previous release is available under ${previous}`);
	// Conferido antes de trocar os ponteiros: um `active.json` inválido faria o rollback deixar
	// `current` na release antiga com a metadata da nova.
	assertActiveWritable(store);
	const report = verifyRelease(previousTarget);
	for (const warning of report.warnings) console.warn(`Rollback warning: ${warning}`);
	if (report.problems.length > 0 && !options.force) {
		fail(
			`Refusing to roll back to ${previousTarget}; it does not satisfy the current overlay contract:\n` +
				report.problems.map((problem) => `  - ${problem}`).join("\n") +
				`\nThe active release was not changed. Re-run with --force to roll back anyway.`,
		);
	}
	// O par do rollback é preparado e validado antes dos ponteiros, igual à ativação: voltar o Pi sem
	// um artefato Agent válido para a release antiga deixaria o opt-in apontando para o par errado.
	const agent = await rollbackAgentPair(store, previousTarget, { store, adoptLauncher: options.adoptLauncher });
	atomicSymlink(previousTarget, current);
	if (currentTarget) atomicSymlink(currentTarget, previous);
	const metadata = releaseMetadata(previousTarget) ?? {};
	let agentConfig;
	try {
		agentConfig = agent ? commitAgentPair(store, agent) : undefined;
	} catch (error) {
		// Os ponteiros já voltaram: desfazer o par aqui deixaria `current` na release antiga com o par
		// novo (ou nenhum). Voltar os ponteiros é o que mantém par e runtime coerentes.
		const agentRestore = restoreAgentPair(store, agent);
		atomicSymlink(currentTarget ?? previousTarget, current);
		if (previousTarget) atomicSymlink(previousTarget, previous);
		error.message =
			`${error.message}${agentRestore.note}\nRollback aborted while switching the Agent pair: current/previous were ` +
			`restored to ${currentTarget ?? "none"}/${previousTarget} and active.json was left untouched.`;
		if (agentRestore.unknown || error.agentResourcesUnknown) error.activationState = "unknown";
		throw error;
	}
	// Rollback troca o par, não o bundle do launcher: o launcher instalado precisa entender
	// a entrada e o ambiente declarados pelo artefato histórico (inclusive durable-host).
	writeActive(store, previousTarget, metadata, launcherRecord(store), {
		rolledBackAt: new Date().toISOString(),
		rolledBackFrom: currentTarget ?? null,
		agent: agentConfig ? agentActiveSummary(agentConfig) : undefined,
		digestAlgorithm: metadata.treeDigest ? (metadata.digestAlgorithm ?? 1) : undefined,
		degraded: report.problems.length > 0 ? true : undefined,
		degradedReasons: report.problems.length > 0 ? report.problems : undefined,
	});
	if (report.problems.length > 0) {
		console.warn(`Forced rollback to a degraded release; active.json records: ${report.problems.join("; ")}`);
	}
	// A seleção registrada tem de descrever a release que passou a valer: senão o próximo
	// `pi overlay-update` sem flags reintroduziria (ou tiraria) uma camada que o rollback acabou de mudar.
	const optional = optionalLayersFromRecord(metadata, overlayPatches());
	writeStoreLayers(store, optional);
	console.log(
		`${productDisplayName}: rolled back Pi overlay to ${previousTarget} (camadas opcionais: ${optional.length > 0 ? optional.join(", ") : "nenhuma"}; registrado em ${join(store, LAYERS_FILE)})`,
	);
}

function latestReleaseRef() {
	const raw = run("npm", ["view", manifest.officialPackage, "version", "--json"], { capture: true });
	const parsed = JSON.parse(raw);
	const version = Array.isArray(parsed) ? parsed.at(-1) : parsed;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
		fail(`Invalid version returned for ${manifest.officialPackage}: ${raw}`);
	}
	return `v${version}`;
}

function overlayPatches() {
	const patches = manifest.patches;
	if (!Array.isArray(patches) || patches.length === 0) fail("Overlay manifest declares no patches");
	if (!patches.some((patch) => !isOptionalPatch(patch))) fail("Overlay manifest declares no base patches");
	return patches.map((patch) => {
		if (!patch.name || !patch.path || !patch.sha256) fail(`Invalid overlay patch entry: ${JSON.stringify(patch)}`);
		if (!Array.isArray(patch.tests) || patch.tests.length === 0) {
			fail(`Overlay patch "${patch.name}" declares no tests; every patch must ship an executed gate`);
		}
		return { ...patch, file: join(repoRoot, patch.path) };
	});
}

/**
 * Release identity derives from what the overlay actually contains, never from a hand-written
 * commit id: manifest bytes (patch order, checksums, release overlays) plus every patch file.
 * Changing any of them yields a new releaseId, so an edited overlay can never reuse a release
 * that was built from the previous one. The fingerprint covers the overlay only; the release
 * directory also carries the digest of the built tree, so two builds of the same overlay that
 * differ in content land in different directories instead of overwriting each other.
 *
 * Only the selected layers enter the fingerprint: an install with `context-windows` and one
 * without it are different runtimes and must never share a release directory.
 */
function overlayFingerprint(patches) {
	const hash = createHash("sha256");
	hash.update(readFileSync(manifestPath));
	for (const patch of patches) hash.update(readFileSync(patch.file));
	return hash.digest("hex");
}

/**
 * Hydration fetches the model catalog live (models.dev, openrouter, nvidia, vercel), so a release
 * that built yesterday can stop building today for reasons that have nothing to do with the overlay:
 * upstream renames a provider and the pinned tests, or the hydrator itself, reject the new catalog.
 * A vendored snapshot makes the install reproducible: the manifest pins the sha256 of the dataset's
 * own `.manifest.json`, which pins the sha256 of every provider file, and upstream's
 * `check:model-data` then proves the snapshot really is the catalog this release's sources declare.
 * `--hydrate` opts back into the live fetch, which is how a new snapshot is produced.
 */
function vendoredModelData(officialVersion) {
	const entry = (manifest.modelData ?? []).find((candidate) => candidate.officialVersion === officialVersion);
	if (!entry) return undefined;
	if (!entry.path || !entry.manifestSha256) fail(`Invalid overlay modelData entry: ${JSON.stringify(entry)}`);
	const dir = join(repoRoot, entry.path);
	const manifestFile = join(dir, ".manifest.json");
	if (!existsSync(manifestFile)) fail(`Vendored model data for ${officialVersion} is missing: ${manifestFile}`);
	const actual = sha256(manifestFile);
	if (actual !== entry.manifestSha256) {
		fail(`Vendored model data manifest checksum mismatch: expected ${entry.manifestSha256}, got ${actual}`);
	}
	const dataManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	const files = dataManifest.files;
	if (!files || typeof files !== "object") fail(`Vendored model data manifest has no file hashes: ${manifestFile}`);
	const present = readdirSync(dir).filter((name) => name.endsWith(".json") && name !== ".manifest.json");
	if (present.length !== Object.keys(files).length) {
		fail(`Vendored model data has ${present.length} provider files, manifest declares ${Object.keys(files).length}`);
	}
	for (const [name, expected] of Object.entries(files)) {
		const file = join(dir, name);
		if (!existsSync(file)) fail(`Vendored model data is missing ${file}`);
		const got = sha256(file);
		if (got !== expected) fail(`Vendored model data file ${name} checksum mismatch: expected ${expected}, got ${got}`);
	}
	return { ...entry, dir, generatedAt: dataManifest.generatedAt };
}

function installVendoredModelData(sourceDir, vendored) {
	const destination = join(sourceDir, "packages", "ai", "src", "providers", "data");
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	// `.DS_Store` e companhia entram no diretório sozinhos (Finder, backup) e não fazem parte do
	// dataset: copiá-los sujaria a árvore da release e o digest que ela registra.
	for (const name of readdirSync(vendored.dir)) {
		if (ignoredTreeEntries.has(name)) continue;
		copyFileSync(join(vendored.dir, name), join(destination, name));
	}
	console.log(`Using vendored model data ${vendored.officialVersion} (generated ${vendored.generatedAt})`);
}

/**
 * Renova o snapshot versionado a partir do dataset que acabou de passar no gate.
 *
 * Antes isto era um passo manual descrito no README: copiar o diretório do release instalado,
 * recalcular o sha256 do `.manifest.json` e editar o manifesto à mão. Três passos, três chances de
 * errar, e o próximo install offline quebra. Aqui o dataset vendorado é exatamente o que a build
 * que acabou de passar no gate usou.
 */
function vendorModelData(sourceDir, officialVersion) {
	const source = join(sourceDir, "packages", "ai", "src", "providers", "data");
	const manifestFile = join(source, ".manifest.json");
	if (!existsSync(manifestFile)) fail(`Hydrated model data has no manifest to vendor: ${manifestFile}`);
	const relative = join("overlay", "model-data", officialVersion);
	const destination = join(repoRoot, relative);
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	let copied = 0;
	for (const name of readdirSync(source)) {
		if (ignoredTreeEntries.has(name) || !name.endsWith(".json")) continue;
		copyFileSync(join(source, name), join(destination, name));
		copied++;
	}
	const manifestSha256 = sha256(join(destination, ".manifest.json"));
	const entries = manifest.modelData ?? [];
	const entry = { officialVersion, path: relative.replaceAll("\\", "/"), manifestSha256 };
	const existing = entries.findIndex((candidate) => candidate.officialVersion === officialVersion);
	if (existing >= 0) entries[existing] = entry;
	else entries.push(entry);
	manifest.modelData = entries;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(
		`Vendored model data ${officialVersion} into ${relative} (${copied} files, manifestSha256 ${manifestSha256}). ` +
			`overlay/manifest.json changed, so the overlay fingerprint printed below is the pre-vendor one; ` +
			`re-run --check offline to validate the snapshot.`,
	);
}

function verifyOverlayPatch(patch) {
	if (!existsSync(patch.file)) fail(`Overlay patch "${patch.name}" is missing: ${patch.file}`);
	const actual = sha256(patch.file);
	if (actual !== patch.sha256) {
		fail(`Overlay patch "${patch.name}" checksum mismatch: expected ${patch.sha256}, got ${actual}`);
	}
	const patchText = readFileSync(patch.file, "utf8").toLowerCase();
	for (const marker of manifest.compatibility.forbiddenOverlayMarkers) {
		if (patchText.includes(marker.toLowerCase())) {
			fail(`Forbidden runtime marker in overlay patch "${patch.name}": ${marker}`);
		}
	}
}

function applyOverlayPatch(sourceDir, patch) {
	try {
		run("git", ["-C", sourceDir, "apply", "--3way", "--whitespace=nowarn", patch.file]);
	} catch (error) {
		const escape = isOptionalPatch(patch)
			? ` "${patch.name}" is an optional layer: re-run with --without ${patch.name} to install without it.`
			: "";
		fail(
			`Overlay layer "${patch.name}" (${patch.path}) did not apply to the official source. ` +
				`Port it to this release before updating; the active pi was not changed.${escape} (${error.message})`,
		);
	}
}

function packWorkspace(sourceDir, workspace, destination) {
	mkdirSync(destination, { recursive: true });
	run("npm", ["pack", "--workspace", workspace, "--pack-destination", destination], { cwd: sourceDir });
	const packed = readdirSync(destination)
		.filter((name) => name.endsWith(".tgz"))
		.map((name) => join(destination, name));
	if (packed.length !== 1) fail(`Expected one tarball for ${workspace}, found ${packed.length}`);
	return packed[0];
}

function findInstalledPackages(root, packageName) {
	const segments = packageName.split("/");
	const matches = [];
	const walk = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = join(directory, entry.name);
			if (entry.name === "node_modules") {
				const candidate = join(full, ...segments);
				if (existsSync(join(candidate, "package.json"))) matches.push(candidate);
			}
			walk(full);
		}
	};
	walk(root);
	return matches;
}

/**
 * The updater only publishes packages/coding-agent, so overlay patches that touch another
 * workspace would silently vanish from the release. Each declared release overlay is packed
 * from the patched source and forced over every installed copy of that package.
 */
function applyReleaseOverlays(sourceDir, installDir, stageRoot) {
	for (const overlay of manifest.releaseOverlays ?? []) {
		const workDir = join(stageRoot, "release-overlays", overlay.name);
		const tarball = packWorkspace(sourceDir, overlay.workspace, join(workDir, "pack"));
		const extracted = join(workDir, "extract");
		mkdirSync(extracted, { recursive: true });
		run(tarCommand(), ["-xzf", tarball, "-C", extracted]);
		const payload = join(extracted, "package");
		if (!existsSync(join(payload, "package.json"))) fail(`Release overlay "${overlay.name}" produced no package`);

		const targets = findInstalledPackages(installDir, overlay.package);
		if (targets.length === 0) {
			fail(
				`Release overlay "${overlay.name}" found no installed copy of ${overlay.package}. ` +
					`Pi changed how it bundles that package; re-check the overlay before updating.`,
			);
		}
		for (const target of targets) {
			rmSync(target, { recursive: true, force: true });
			mkdirSync(target, { recursive: true });
			cpSync(payload, target, { recursive: true });
		}
		for (const target of targets) {
			const markerFile = join(target, overlay.markerFile);
			if (!existsSync(markerFile)) fail(`Release overlay "${overlay.name}" is missing ${markerFile}`);
			if (!readFileSync(markerFile, "utf8").includes(overlay.requiredMarker)) {
				fail(
					`Release overlay "${overlay.name}" did not reach ${markerFile}: ` +
						`marker ${JSON.stringify(overlay.requiredMarker)} is absent.`,
				);
			}
		}
		console.log(`Release overlay "${overlay.name}" applied to ${targets.length} installed copy/copies`);
	}
}

const volatileReleaseFields = [["dist/providers/data/.manifest.json", "generatedAt"]];

function digestFileContents(relative, full) {
	for (const [suffix, field] of volatileReleaseFields) {
		if (relative !== suffix && !relative.endsWith(`/${suffix}`)) continue;
		try {
			const parsed = JSON.parse(readFileSync(full, "utf8"));
			if (!(field in parsed)) break;
			delete parsed[field];
			return Buffer.from(JSON.stringify(parsed));
		} catch {
			break;
		}
	}
	return readFileSync(full);
}

function digestTree(root, algorithm = digestAlgorithm) {
	const hash = createHash("sha256");
	const walk = (directory, prefix) => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const entry of entries) {
			if (prefix === "" && entry.name === releaseMetadataFile) continue;
			if ((algorithm >= 3 || algorithm === receiptDigestAlgorithm) && ignoredTreeEntries.has(entry.name)) continue;
			const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			const full = join(directory, entry.name);
			if (algorithm === receiptDigestAlgorithm) hash.update(`M ${lstatSync(full).mode}\0`);
			if (entry.isSymbolicLink()) {
				hash.update(`L ${relative}\0${readlinkSync(full)}\0`);
			} else if (entry.isDirectory()) {
				hash.update(`D ${relative}\0`);
				walk(full, relative);
			} else {
				hash.update(`F ${relative}\0`);
				hash.update(algorithm >= 2 ? digestFileContents(relative, full) : readFileSync(full));
				hash.update("\0");
			}
		}
	};
	walk(root, "");
	return hash.digest("hex");
}

function releaseMetadata(releaseDir) {
	const file = join(releaseDir, releaseMetadataFile);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function missingReleaseOverlayMarkers(releaseDir) {
	const problems = [];
	for (const overlay of manifest.releaseOverlays ?? []) {
		const targets = findInstalledPackages(releaseDir, overlay.package);
		if (targets.length === 0) {
			problems.push(`release overlay "${overlay.name}": no installed copy of ${overlay.package}`);
			continue;
		}
		for (const target of targets) {
			const markerFile = join(target, overlay.markerFile);
			if (!existsSync(markerFile) || !readFileSync(markerFile, "utf8").includes(overlay.requiredMarker)) {
				problems.push(
					`release overlay "${overlay.name}": marker ${JSON.stringify(overlay.requiredMarker)} absent from ${markerFile}`,
				);
			}
		}
	}
	return problems;
}

function containsMarker(path, marker) {
	if (!statSync(path).isDirectory()) return readFileSync(path, "utf8").includes(marker);
	const stack = [path];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && readFileSync(full, "utf8").includes(marker)) return true;
		}
	}
	return false;
}

/**
 * Check the installed official package, not just the source overlay package. Each declared
 * marker names a file or directory in the installed layout and a literal string expected there.
 * Paths are supplied by the release manifest, so classic and historical release layouts can be
 * verified without selecting a host. Missing paths remain rollback-compatible.
 *
 * A marker that names a `patch` is only demanded when that patch is part of the release being
 * checked: a base-only install does not carry the optional layer's code and is not degraded for it.
 */
function missingBundleMarkers(releaseDir, patchNames) {
	const markers = markersForPatches(manifest.compatibility?.bundleMarkers ?? [], patchNames);
	if (markers.length === 0) return [];
	const targets = findInstalledPackages(releaseDir, manifest.officialPackage);
	if (targets.length === 0) return [`no installed copy of ${manifest.officialPackage} to check overlay markers in`];
	const problems = [];
	for (const target of targets) {
		for (const marker of markers) {
			const path = join(target, marker.path);
			if (!existsSync(path)) continue;
			if (!containsMarker(path, marker.marker)) {
				problems.push(`overlay marker "${marker.name}": ${JSON.stringify(marker.marker)} absent from ${path}`);
			}
		}
	}
	return problems;
}

/**
 * A release is self-verifying: it records the overlay it was built from, the digest of its own
 * installed tree, and the algorithm that produced that digest. Without `expected` (rollback) the
 * release only has to satisfy the current overlay contract; with `expected` (update) it must also
 * be the exact build we just produced. A digest recorded under an older algorithm is recomputed
 * under that algorithm instead of being waved through: content that cannot be verified at all is a
 * problem, never a warning.
 */
function verifyRelease(releaseDir, expected) {
	const problems = [];
	const warnings = [];
	const pi = releaseBinary(releaseDir);
	if (!existsSync(pi)) {
		problems.push(`no installed pi entrypoint in ${releaseDir} (looked for ${releaseBinaryCandidates(releaseDir).join(", ")})`);
	}
	const metadata = releaseMetadata(releaseDir);
	const recordedAlgorithm = metadata?.digestAlgorithm ?? 1;
	if (!metadata) {
		problems.push(`${join(releaseDir, releaseMetadataFile)} is missing or unreadable`);
	} else if (expected) {
		for (const key of ["officialCommit", "officialVersion", "overlayFingerprint"]) {
			if (metadata[key] !== expected[key]) {
				problems.push(`${key} is ${metadata[key] ?? "absent"}, expected ${expected[key]}`);
			}
		}
		const expectedDigest =
			recordedAlgorithm === digestAlgorithm ? expected.treeDigest : expected.digestUnder?.(recordedAlgorithm);
		if (!expectedDigest) {
			problems.push(`treeDigest was recorded under algorithm ${recordedAlgorithm}, which this build cannot reproduce`);
		} else if (metadata.treeDigest !== expectedDigest) {
			problems.push(`treeDigest is ${metadata.treeDigest ?? "absent"}, expected ${expectedDigest}`);
		}
		if (JSON.stringify(metadata.patches ?? null) !== JSON.stringify(expected.patches)) {
			problems.push("recorded patch checksums differ from the selected overlay layers");
		}
	} else {
		// Rollback: a release is judged by what it recorded, not by the layers selected now.
		// A store that dropped an optional layer must still be able to roll back to the release
		// that carried it, and a release built before layers existed records all patches.
		const recorded = Object.keys(metadata.patches ?? {});
		if (recorded.length === 0) problems.push("release records no overlay patches");
		const declared = new Map(overlayPatches().map((patch) => [patch.name, patch]));
		for (const name of recorded) {
			if (!declared.has(name)) warnings.push(`release records overlay patch "${name}", which the manifest no longer declares`);
		}
		for (const [name, patch] of declared) {
			if (!isOptionalPatch(patch) && !recorded.includes(name)) {
				problems.push(`release does not record base overlay patch "${name}"`);
			}
		}
	}
	if (metadata && !metadata.treeDigest) {
		problems.push(`${releaseDir} predates release digests; its contents cannot be verified`);
	} else if (metadata && !supportedDigestAlgorithms.has(recordedAlgorithm)) {
		problems.push(
			`${releaseDir} recorded its digest with algorithm ${recordedAlgorithm}, which this updater cannot ` +
				`compute; its contents cannot be verified`,
		);
	} else if (metadata) {
		const actual = digestTree(releaseDir, recordedAlgorithm);
		if (actual !== metadata.treeDigest) {
			problems.push(
				`release contents changed on disk: treeDigest ${actual.slice(0, 12)}, recorded ${metadata.treeDigest.slice(0, 12)}`,
			);
		} else if (recordedAlgorithm !== digestAlgorithm) {
			warnings.push(
				`${releaseDir} recorded its digest with algorithm ${recordedAlgorithm}; recomputing under that ` +
					`algorithm verified its contents byte for byte`,
			);
		}
	}
	const recordedPatches = metadata?.patches
		? Object.keys(metadata.patches)
		: (manifest.patches ?? []).map((patch) => patch.name);
	problems.push(...missingReleaseOverlayMarkers(releaseDir));
	problems.push(...missingBundleMarkers(releaseDir, recordedPatches));
	if (problems.length === 0 && existsSync(pi)) {
		try {
			run(pi, ["--version"], { capture: true });
		} catch (error) {
			problems.push(`${pi} did not run: ${error.message}`);
		}
	}
	return { problems, warnings };
}

function packageMetadata(sourceDir) {
	return JSON.parse(readFileSync(join(sourceDir, "packages", "coding-agent", "package.json"), "utf8"));
}

/**
 * Upstream may publish the CLI as loose modules (`dist/cli.js`) or as a bundle (`dist/cli.js`).
 * Both are legitimate, but only the ones declared in the manifest are: the guard matches `bin.pi`
 * against a declared layout and then proves that layout is really the one in front of it (the files
 * and build wiring it claims must exist). An undeclared entrypoint stops the update before a single
 * patch touches the source, which is exactly what happened on 0.84.3.
 */
function upstreamLayouts() {
	const layouts = manifest.compatibility?.upstreamLayouts;
	if (!Array.isArray(layouts) || layouts.length === 0) fail("Overlay manifest declares no upstream layouts");
	for (const layout of layouts) {
		if (!layout.name || !layout.binPi) fail(`Invalid upstream layout entry: ${JSON.stringify(layout)}`);
	}
	return layouts;
}

function verifyOfficialIdentity(sourceDir) {
	const pkg = packageMetadata(sourceDir);
	if (pkg.name !== manifest.officialPackage) fail(`Unexpected package identity: ${pkg.name}`);
	if (pkg.piConfig?.configDir !== ".pi") fail(`Unexpected pi config directory: ${JSON.stringify(pkg.piConfig)}`);
	const layouts = upstreamLayouts();
	const layout = layouts.find((entry) => entry.binPi === pkg.bin?.pi);
	if (!layout) {
		fail(
			`Unexpected pi entrypoint: ${JSON.stringify(pkg.bin)}. Declared layouts: ` +
				`${layouts.map((entry) => `${entry.name} -> ${entry.binPi}`).join(", ")}. ` +
				`Pi restructured how it publishes the CLI; review the overlays against the new layout and declare ` +
				`it in overlay/manifest.json before updating.`,
		);
	}
	for (const relative of layout.sourceFiles ?? []) {
		if (!existsSync(join(sourceDir, relative))) {
			fail(`Upstream layout "${layout.name}" expects ${relative}, which this release does not ship`);
		}
	}
	if (layout.buildScriptContains && !(pkg.scripts?.build ?? "").includes(layout.buildScriptContains)) {
		fail(
			`Upstream layout "${layout.name}" expects the coding-agent build to run ${layout.buildScriptContains}, ` +
				`but it is ${JSON.stringify(pkg.scripts?.build)}`,
		);
	}
	return { pkg, layout };
}

function installOverlayBundle(store) {
	// Every declared patch travels, not only the selected ones: an installed bundle must be able to
	// add an optional layer later with `pi overlay-update --with <layer>` without a checkout.
	const relativeFiles = [
		"overlay/manifest.json",
		...overlayPatches().map((patch) => patch.path),
		// Without the vendored snapshots an installed bundle could only update by hydrating live.
		...(manifest.modelData ?? []).flatMap((entry) =>
			readdirSync(join(repoRoot, entry.path))
				.filter((name) => !ignoredTreeEntries.has(name))
				.sort()
				.map((name) => `${entry.path}/${name}`),
		),
		"overlay/README.md",
		"scripts/agent-update.mjs",
		"scripts/lib/agent-distribution.mjs",
		"scripts/lib/mark-migration.mjs",
		"scripts/migrate-from-mark.mjs",
		"scripts/import-durable-sessions.mjs",
		// The updater imports these at module load; a bundle without them cannot run `pi update` at all.
		"scripts/lib/store-lock.mjs",
		"scripts/lib/internal-packages.mjs",
		"scripts/lib/layers.mjs",
		"scripts/lib/skills.mjs",
		"scripts/lib/extensions.mjs",
		"scripts/lib/agent-setup.mjs",
		"scripts/lib/overlay-stale.mjs",
		// Skills padrão do Agent: o bundle instalado precisa delas para reinstalar sem checkout.
		...skillFiles(repoRoot),
		// Idem a extensão Megamind.
		...extensionFiles(repoRoot),
		// Idem o setup do Gabriel (extensões, temas, papéis de subagente) vendorizado em `agent/`.
		...agentSetupFiles(repoRoot),
		// Os dois launchers viajam sempre: o bundle é o mesmo conteúdo em qualquer plataforma, e um
		// store copiado de uma máquina para outra continua tendo o wrapper da plataforma que o lê.
		"scripts/agent-wrapper.sh",
		"scripts/agent-wrapper.cmd",
		// Agent: o launcher e os dois helpers precisam viver no bundle imutável, senão `pi` passaria a
		// depender do checkout. Um checkout anterior ao Agent não carrega esses arquivos e segue
		// instalando pelo caminho legado, em vez de falhar no empacotamento.
		...Object.values(agentFiles).filter((relative) => existsSync(join(repoRoot, relative))),
	];
	const fingerprint = createHash("sha256");
	for (const relative of relativeFiles) fingerprint.update(relative).update("\0").update(sha256(join(repoRoot, relative)));
	// O bundle carrega TODOS os patches do manifesto, não a seleção desta instalação: identificá-lo
	// pela seleção faria duas seleções do mesmo overlay instalarem bundles de conteúdo idêntico em
	// diretórios diferentes, e a coleta de bundles superseded apagaria o do vizinho.
	const bundleId = `${overlayFingerprint(overlayPatches()).slice(0, 12)}-${fingerprint.digest("hex").slice(0, 12)}`;
	const bundle = join(store, "overlay-bundles", bundleId);
	const installed = relativeFiles.every((relative) => {
		const copy = join(bundle, relative);
		return existsSync(copy) && sha256(copy) === sha256(join(repoRoot, relative));
	});
	if (installed) return bundle;
	if (existsSync(bundle)) {
		console.warn(`Overlay bundle ${bundleId} does not match its own fingerprint; reinstalling it`);
		rmSync(bundle, { recursive: true, force: true });
	}

	const temporary = `${bundle}.tmp-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	for (const relative of relativeFiles) {
		const destination = join(temporary, relative);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(repoRoot, relative), destination);
	}
	chmodSync(join(temporary, "scripts", "agent-update.mjs"), 0o755);
	chmodSync(join(temporary, "scripts", "agent-wrapper.sh"), 0o755);
	mkdirSync(dirname(bundle), { recursive: true });
	renameSync(temporary, bundle);
	return bundle;
}

/**
 * Guarda o launcher que estava lá antes de o overlay adotar o nome, com o comando exato de
 * restauração. Vale tanto para um symlink no POSIX quanto para um `pi.cmd` de outra instalação.
 */
function backupLauncher(store, path) {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const backupDir = join(store, "backups", stamp);
	mkdirSync(backupDir, { recursive: true });
	const backup = join(backupDir, basename(path));
	renameSync(path, backup);
	writeFileSync(
		join(backupDir, "restore.txt"),
		isWindows ? `move /y "${backup}" "${path}"\r\n` : `mv ${backup} ${path}\n`,
		"utf8",
	);
	console.log(`Backed up previous pi launcher to ${backup}`);
}

/**
 * Windows não tem symlink de arquivo sem privilégio, e o PowerShell dos sócios resolve comandos por
 * PATHEXT: o launcher aqui são dois arquivos de verdade em `~/.local/bin` (`agent.cmd` para cmd e
 * PowerShell, `agent.ps1` para quando o PowerShell prefere o .ps1), ambos encaminhando para o wrapper
 * do store — que é quem carrega a semântica e é reescrito a cada update.
 */
function adoptWindowsLauncher(store, wrapper, overlayRepo) {
	const localBin = join(homedir(), ".local", "bin");
	mkdirSync(localBin, { recursive: true });
	const launchers = [
		{ path: join(localBin, "agent.cmd"), body: `@echo off\r\ncall "${wrapper}" %*\r\nexit /b\r\n` },
		{
			path: join(localBin, "agent.ps1"),
			body: `#!/usr/bin/env pwsh\r\n& "${wrapper}" @args\r\nexit $LASTEXITCODE\r\n`,
		},
	];
	for (const launcher of launchers) {
		let current;
		try {
			current = readFileSync(launcher.path, "utf8");
		} catch {
			current = undefined;
		}
		if (current === launcher.body) continue;
		if (linkExists(launcher.path)) backupLauncher(store, launcher.path);
		const temporary = `${launcher.path}.tmp-${process.pid}`;
		writeFileSync(temporary, launcher.body);
		removeLink(launcher.path);
		renameSync(temporary, launcher.path);
	}
	const inPath = (process.env.PATH ?? "")
		.split(";")
		.some((entry) => entry && resolve(entry).toLowerCase() === localBin.toLowerCase());
	if (!inPath) {
		console.warn(
			`${localBin} não está no PATH; \`agent\` só vai resolver depois de adicioná-lo:\n` +
				`  setx PATH "%PATH%;${localBin}"   (abra um terminal novo depois)`,
		);
	}
	return { wrapper, localPi: launchers[0].path, localLaunchers: launchers.map((entry) => entry.path), overlayRepo };
}

function installWrapper(store, adoptLauncher) {
	const overlayRepo = installOverlayBundle(store);
	const templateFile = isWindows ? "agent-wrapper.cmd" : "agent-wrapper.sh";
	const template = readFileSync(join(overlayRepo, "scripts", templateFile), "utf8");
	const rendered = template.replaceAll("__OVERLAY_REPO__", overlayRepo);
	const wrapper = join(store, "bin", isWindows ? "pi-wrapper.cmd" : "pi-wrapper");
	mkdirSync(dirname(wrapper), { recursive: true });
	const temporary = `${wrapper}.tmp-${process.pid}`;
	writeFileSync(temporary, rendered, { mode: 0o755 });
	chmodSync(temporary, 0o755);
	renameSync(temporary, wrapper);

	if (!adoptLauncher) {
		console.log(`Store ${store} is not the default store; ${join(homedir(), ".local", "bin")} was left alone`);
		return { wrapper, localPi: null, overlayRepo };
	}
	if (isWindows) return adoptWindowsLauncher(store, wrapper, overlayRepo);

	const localPi = join(homedir(), ".local", "bin", "agent");
	let currentIsWrapper = false;
	try {
		currentIsWrapper = lstatSync(localPi).isSymbolicLink() && realpathSync(localPi) === realpathSync(wrapper);
	} catch {
		currentIsWrapper = false;
	}
	if (!currentIsWrapper) {
		if (linkExists(localPi)) backupLauncher(store, localPi);
		atomicSymlink(wrapper, localPi);
	}
	return { wrapper, localPi, overlayRepo };
}

/**
 * `active.json` descreve o que `current` aponta. Uma gravação parcial (disco cheio, processo morto
 * no meio) deixaria um arquivo truncado que `activeRecord` lê como ilegível — e daí o store perde a
 * geração do updater e a seleção semeada. Escreve em temporário e renomeia: ou o arquivo antigo, ou
 * o novo, nunca metade.
 */
/**
 * Checkout git de onde ESTE updater roda (só se `repoRoot` for a raiz de um checkout; o bundle em
 * `overlay-bundles/` não é). Rodando de um bundle, a origem já registrada em `active.json` é
 * preservada: o bundle não enxerga o checkout, então não pode afirmar nada novo sobre ele.
 */
function checkoutSource() {
	if (process.env.AGENT_DIST === "1") { const info = checkoutInfo(repoRoot); return info ? { sourceCommit: info.head } : {}; }
	const info = checkoutInfo(repoRoot);
	if (info && resolvedPath(info.top) === resolvedPath(repoRoot)) return { sourceRepo: info.top, sourceCommit: info.head };
	return {};
}

/**
 * A origem pertence à RELEASE (gravada em `agent-release.json` quando ela é construída) e `active.json`
 * a herda da metadata da release que passa a valer: rollback/promote descrevem o destino, nunca o
 * HEAD atual nem a release que saiu. Release sem origem (feita por updater antigo) fica sem origem.
 * O Agent sobrescreve essa origem após instalar seu artefato: ele vem do checkout atual mesmo
 * quando a release Pi é reaproveitada. A metadata imutável da release continua intacta.
 * `inherit` (só o enable do Agent, que mantém a mesma release) preserva a origem já registrada.
 */
function sourceRecord(store, metadata, inherit = false) {
	if (metadata?.sourceRepo && metadata?.sourceCommit) return { sourceRepo: metadata.sourceRepo, sourceCommit: metadata.sourceCommit };
	if (!inherit) return { sourceRepo: undefined, sourceCommit: undefined };
	const previous = activeRecord(store);
	return previous?.sourceRepo && previous?.sourceCommit ? { sourceRepo: previous.sourceRepo, sourceCommit: previous.sourceCommit } : {};
}

// Sem checkout (updater do bundle), não regride a origem de um artefato já instalado sobre o mesmo Pi.
function agentSource(store, releaseDir) {
	const source = checkoutSource();
	if (source.sourceCommit) return source;
	const active = activeRecord(store);
	return active?.releaseDir === releaseDir && active.sourceRepo && active.sourceCommit
		? { sourceRepo: active.sourceRepo, sourceCommit: active.sourceCommit }
		: {};
}

function writeActive(store, releaseDir, metadata, launcher, extra = {}, { inheritSource = false } = {}) {
	const active = { ...metadata, release: readJsonFile(join(store, "release-identities.json"))?.[releaseDir], releaseDir, ...launcher, updaterGeneration, ...sourceRecord(store, metadata, inheritSource), ...extra };
	for (const [key, value] of Object.entries(active)) {
		if (value === undefined) delete active[key];
	}
	const file = join(store, "active.json");
	mkdirSync(store, { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	rmSync(temporary, { force: true });
	writeFileSync(temporary, `${JSON.stringify(active, null, 2)}\n`);
	try {
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function activeRecord(store) {
	const file = join(store, "active.json");
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function launcherRecord(store) {
	const fallback = {
		wrapper: join(store, "bin", isWindows ? "pi-wrapper.cmd" : "pi-wrapper"),
		localPi: null,
		overlayRepo: null,
	};
	const previous = activeRecord(store);
	if (!previous) return fallback;
	return {
		wrapper: previous.wrapper ?? fallback.wrapper,
		localPi: previous.localPi ?? null,
		localLaunchers: previous.localLaunchers ?? undefined,
		overlayRepo: previous.overlayRepo ?? null,
	};
}

function agentFilePath(key) {
	return join(repoRoot, agentFiles[key]);
}

function requireAgentExports(module, names, file) {
	const missing = names.filter((name) => typeof module[name] !== "function");
	if (missing.length > 0) {
		fail(
			`${file} does not export ${missing.join(", ")}: the Agent helper contract changed. ` +
				`The updater speaks the contract in .pi/goals/agent-global-activate-20261013/contracts.md; ` +
				`nothing was changed.`,
		);
	}
	return module;
}

async function loadAgentRuntime() {
	const file = agentFilePath("runtime");
	if (!existsSync(file)) {
		fail(`Agent runtime helper is missing: ${file}. This bundle/checkout cannot manage Agent; nothing was changed.`);
	}
	return requireAgentExports(await import(pathToFileURL(file).href), agentRuntimeExports, file);
}

async function loadAgentResourceHelper() {
	const file = agentFilePath("resources");
	if (!existsSync(file)) {
		fail(`Agent resources helper is missing: ${file}. This bundle/checkout cannot manage Agent; nothing was changed.`);
	}
	return requireAgentExports(await import(pathToFileURL(file).href), agentResourceExports, file);
}

/**
 * Opt-in lido sem helper é opt-in perdido: um bundle anterior ao Agent não sabe ler a config, e
 * seguir pelo caminho legado em silêncio reinstalaria recursos que o Agent gerencia. Quando o
 * store tem `runtime/` e o helper não está no bundle, o aviso é explícito.
 */
async function readAgentState(store) {
	if (!existsSync(agentFilePath("runtime"))) {
		if (existsSync(join(store, agentStoreDir))) {
			console.warn(
				`${join(store, agentStoreDir)} exists but this updater has no ${agentFiles.runtime}: proceeding on the ` +
					`legacy path without reading the Agent opt-in. Run the updater from a bundle/checkout that ships ` +
					`the Agent helpers to preserve it.`,
			);
		}
		return undefined;
	}
	const runtime = await loadAgentRuntime();
	return { runtime, config: runtime.readAgentConfig(store) ?? null };
}

/**
 * `piRoot` do par Agent: a cópia instalada do pacote oficial dentro da release, não a raiz da
 * release. Pares novos exigem o host clássico; rollback também aceita um par histórico indexado,
 * sempre no diretório do pacote; `releases/<id>` contém apenas o `bin/pi` e o `lib/node_modules`.
 */
function agentPiRoot(releaseDir, runtime, history = {}) {
	const entry = typeof runtime?.PI_ENTRY === "string" ? runtime.PI_ENTRY : "dist/cli.js";
	const candidates = findInstalledPackages(releaseDir, manifest.officialPackage)
		.filter((directory) => history[directory] || existsSync(join(directory, entry)))
		// O install global tem uma cópia no topo e pode ter cópias aninhadas; a rasa é a que `bin/pi` usa.
		.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || (a < b ? -1 : 1));
	if (candidates.length === 0) {
		fail(
			`No installed copy of ${manifest.officialPackage} under ${releaseDir} ships ${entry}: this release does not ` +
				`carry the classic host that Agent pairs with. Update to a release built from the current overlay ` +
				`first; nothing was changed.`,
		);
	}
	return candidates[0];
}

/**
 * Backup/recibo dos recursos vive em um caminho estável por store, não em um diretório novo por
 * execução: o helper do B guarda o CAS do estado anterior ao lado do recibo e reconhece a
 * reaplicação por ele. Um backup novo a cada enable perderia essa cadeia e um opt-out posterior
 * não saberia mais o que devolver. Quando a config já aponta para um recibo, o diretório dele manda.
 */
function agentResourceBackupDir(store, config) {
	if (config?.resourceReceipt) return dirname(config.resourceReceipt);
	return join(store, agentStoreDir, "resources-backup");
}

/** HOME/agent-dir em que os recursos do Agent são registrados, com a guarda de store isolado. */
function agentHostDirs(options) {
	const homeDir = homedir();
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homeDir, ".agent");
	// Um store que não é o do usuário não autoriza escrita no perfil real: ou o chamador isola o
	// agent-dir (fixture, teste), ou ele está operando o store padrão de propósito.
	if (!options.adoptLauncher && !process.env.PI_CODING_AGENT_DIR) {
		fail(
			`Refusing to register Agent resources from the non-default store ${options.store} into ${agentDir}: ` +
				`set PI_CODING_AGENT_DIR (and HOME) to an isolated profile, or operate the default store ${defaultStore}.`,
		);
	}
	return { homeDir, agentDir };
}

/**
 * Backup seletivo das coisas que o Agent troca: `active.json`, o wrapper do store, o ponteiro
 * `~/.local/bin/agent` (como comando de restauração) e a config do Agent. Nada de settings inteiro,
 * nada de auth/Vault/ledger — o delta de settings é responsabilidade do recibo de recursos, que o
 * helper do B grava dentro de `resources/`.
 */
function captureAgentBackup(store, label, { config, resourcesDir } = {}) {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const dir = join(store, "backups", `${stamp}-agent-${label}`);
	mkdirSync(dir, { recursive: true });
	const restore = [];
	const active = join(store, "active.json");
	if (linkExists(active) && lstatSync(active).isFile()) {
		copyFileSync(active, join(dir, "active.json"));
		restore.push(isWindows ? `copy /y "${join(dir, "active.json")}" "${active}"` : `cp ${join(dir, "active.json")} ${active}`);
	}
	const wrapper = join(store, "bin", isWindows ? "pi-wrapper.cmd" : "pi-wrapper");
	if (existsSync(wrapper)) {
		const copy = join(dir, basename(wrapper));
		copyFileSync(wrapper, copy);
		restore.push(isWindows ? `copy /y "${copy}" "${wrapper}"` : `cp -p ${copy} ${wrapper}`);
	}
	const localPi = activeRecord(store)?.localPi;
	if (localPi && linkExists(localPi)) {
		const target = readCurrentTargetText(localPi);
		if (target) restore.push(isWindows ? `rem launcher ${localPi} -> ${target}` : `ln -sfn ${target} ${localPi}`);
	}
	if (config) {
		writeFileSync(join(dir, "agent-config.json"), `${JSON.stringify(config, null, 2)}\n`);
		restore.push(
			config.enabled
				? `# reativar: node ${join(repoRoot, "scripts", "agent-update.mjs")} --store ${store} --agent-enable${config.version === 1 ? ` --juice-home ${config.juiceHome}` : ""}`
				: `# a config salva em ${join(dir, "agent-config.json")} já estava desabilitada`,
		);
	}
	if (resourcesDir) restore.push(`# recursos (delta de settings/registros): recibo e CAS em ${resourcesDir}`);
	writeFileSync(join(dir, "restore.txt"), `${restore.join("\n")}\n`, "utf8");
	console.log(`Agent ${label}: selective backup at ${dir} (restore commands in ${join(dir, "restore.txt")})`);
	return { dir, resourcesDir };
}

/** agentRoot do par: o helper do A devolve `agentRoot`; o fallback é o layout do contrato. */
function artifactAgentRoot(artifact) {
	return artifact.agentRoot ?? join(artifact.artifactRoot, "agent");
}

/**
 * O recibo de recursos é MUTÁVEL: `applyAgentResources` reescreve `<backupDir>/<RECEIPT_NAME>`.
 * Antes de desfazer o recibo do par antigo para registrar o do par novo, ele é copiado para um
 * snapshot imutável: assim uma falha no meio da troca ainda tem o registro exato do que valia (o
 * CAS do estado pessoal é endereçado por conteúdo e não é apagado por nenhuma reaplicação).
 */
function snapshotAgentReceipt(store, label, receiptPath) {
	if (!receiptPath || !existsSync(receiptPath)) return undefined;
	const dir = join(store, agentStoreDir, "resource-snapshots");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const path = join(dir, `${stamp}-${label}-${basename(receiptPath)}`);
	copyFileSync(receiptPath, path);
	return path;
}

/** Plano com impossibilidade declarada é erro: nada de registrar o Agent pela metade. */
function planAgentResourcesOrFail(resources, { agentRoot, agentDir, homeDir }) {
	const plan = resources.planAgentResources({ agentRoot, agentDir, homeDir });
	const blocking = plan?.report?.blocking ?? [];
	if (blocking.length > 0) {
		throw new Error(`the Agent resource plan for ${agentRoot} has unresolved impossibilities: ${blocking.join("; ")}`);
	}
	return plan;
}

/** Aplicação sem recibo absoluto é falha: sem recibo não existe rollback nem opt-out. */
function applyAgentResourcesOrFail(resources, plan, backupDir) {
	const result = resources.applyAgentResources({ plan, backupDir });
	const receiptPath = result?.receiptPath;
	if (!receiptPath || !isAbsolute(receiptPath)) {
		throw new Error(
			`applyAgentResources returned no absolute receiptPath (got ${JSON.stringify(receiptPath)}); whatever it ` +
				`registered in ${plan.agentDir ?? "the agent folder"} cannot be undone by the updater`,
		);
	}
	return { ...result, receiptPath };
}

/**
 * Rollback de recursos que devolve `conflicts` é FALHA, não sucesso: conflito significa que uma
 * mudança posterior do usuário foi preservada e o registro gerenciado ficou de pé.
 */
function rollbackAgentResourcesOrFail(resources, receiptPath) {
	const result = resources.rollbackAgentResources({ receiptPath });
	const conflicts = result?.conflicts ?? [];
	if (conflicts.length > 0) {
		throw Object.assign(new Error(
			`Agent resource rollback refused before writing; resources unchanged (${receiptPath}): ` +
				conflicts.map((conflict) => `${conflict.key ?? conflict.path ?? "?"}: ${conflict.reason ?? "conflict"}`).join("; "),
		), { code: "AGENT_RESOURCE_CONFLICT" });
	}
	return result;
}

/** Reaplica os registros de um agentRoot sobre o estado pessoal (volta ao par anterior). */
function restoreAgentResources({ resources, agentRoot, agentDir, homeDir, backupDir, snapshot }) {
	try {
		// Undo any new generation first; never append the old generation on top of it.
		const receiptPath = join(backupDir, resources.RECEIPT_NAME);
		if (existsSync(receiptPath)) rollbackAgentResourcesOrFail(resources, receiptPath);
		if (snapshot) copyFileSync(snapshot, receiptPath);
		const plan = planAgentResourcesOrFail(resources, { agentRoot, agentDir, homeDir });
		const applied = applyAgentResourcesOrFail(resources, plan, backupDir);
		if (snapshot) copyFileSync(snapshot, applied.receiptPath);
		return {
			restored: true,
			receiptPath: applied.receiptPath,
			note: `The previous pair's resource registrations (${agentRoot}) were RE-APPLIED; receipt ${applied.receiptPath}.`,
		};
	} catch (error) {
		return {
			restored: false,
			note:
				`The previous pair's resource registrations (${agentRoot}) could NOT be re-applied (${error.message}): the ` +
				`resource state could not be verified; do not assume registrations were restored` +
				`${snapshot ? `; the previous receipt was snapshotted at ${snapshot}` : ""}. Run --agent-enable again or ` +
				`--agent-disable before using pi.`,
		};
	}
}

/**
 * Troca EFETIVA dos registros de recursos de um par para o outro.
 *
 * Só trocar `artifactId`/`piRoot` na config deixaria `settings.extensions` carregando as extensões
 * da release ANTIGA (par misturado, tools duplicadas). Então: desfaz o recibo do artefato antigo —
 * o que devolve o settings ao estado pessoal original, preservado em CAS — e só então planeja e
 * aplica o agentRoot novo sobre esse estado. O recibo resultante descreve o estado pessoal como
 * "antes", de modo que um `--agent-disable` posterior devolva os registros genuinamente originais.
 *
 * Falha depois de desfazer: tenta reaplicar o par antigo e diz exatamente o que ficou de pé.
 */
function switchAgentResources({ store, resources, label, previousReceipt, previousAgentRoot, agentRoot, agentDir, homeDir }) {
	const backupDir = dirname(previousReceipt);
	const snapshot = snapshotAgentReceipt(store, label, previousReceipt);
	try {
		rollbackAgentResourcesOrFail(resources, previousReceipt);
		const plan = planAgentResourcesOrFail(resources, { agentRoot, agentDir, homeDir });
		const applied = applyAgentResourcesOrFail(resources, plan, backupDir);
		return { receiptPath: applied.receiptPath, snapshot, report: applied.report ?? plan.report };
	} catch (error) {
		if (error.code === "AGENT_RESOURCE_CONFLICT") throw error;
		const recovery = restoreAgentResources({ resources, agentRoot: previousAgentRoot, agentDir, homeDir, backupDir, snapshot });
		error.message = `${error.message}\n${recovery.note}`;
		if (!recovery.restored) error.agentResourcesUnknown = true;
		throw error;
	}
}

function agentActiveSummary(config) {
	return {
		enabled: config.enabled === true,
		artifactId: config.artifactId,
		piRoot: config.piRoot,
		...(config.version === 1 ? { juiceHome: config.juiceHome } : {}),
		resourceReceipt: config.resourceReceipt,
	};
}

// Additive index: old stores need no migration; a recorded but invalid pair must fail closed.
function agentPairHistory(store) {
	const file = join(store, agentStoreDir, "pi-artifacts.json");
	if (!existsSync(file)) return {};
	const history = JSON.parse(readFileSync(file, "utf8"));
	if (!history || typeof history !== "object" || Array.isArray(history) ||
		Object.values(history).some((id) => typeof id !== "string" && !(id && typeof id.artifactId === "string"))) {
		throw new Error(`Invalid Agent pair history: ${file}`);
	}
	return history;
}

/**
 * Par Pi+Agent para uma release que ainda NÃO está ativa (update, promote, rollback).
 *
 * O artefato registrado é revalidado (CAS do par anterior) e o artefato da release nova é
 * preparado e validado antes de qualquer ponteiro mudar: se o Agent não puder acompanhar a troca,
 * a troca não acontece, em vez de deixar `pi` apontando para um par inexistente.
 */
async function prepareAgentPair(store, releaseDir, label, options) {
	const state = await readAgentState(store);
	if (!state?.config?.enabled) {
		if (!options?.installRuntime || state?.config) return undefined;
		const runtime = await loadAgentRuntime(), resources = await loadAgentResourceHelper();
		const piRoot = agentPiRoot(releaseDir, runtime);
		const artifact = runtime.prepareAgentArtifact({ sourceRoot: repoRoot, store, piRoot });
		const { homeDir, agentDir } = agentHostDirs(options);
		const plan = planAgentResourcesOrFail(resources, { agentRoot: artifactAgentRoot(artifact), agentDir, homeDir });
		return { runtime, resources, artifact, piRoot, homeDir, agentDir, initial: true, oldConfig: state?.config, plan, config: {} };
	}
	const { runtime, config } = state;
	const resources = await loadAgentResourceHelper();
	const history = agentPairHistory(store);
	// Um par histórico pode declarar o host durável, sem a entrada clássica desta geração.
	// Só rollback consulta o índice; preparação de artefatos novos continua clássica.
	const piRoot = agentPiRoot(releaseDir, runtime, label === "Rollback" ? history : undefined);
	let previousArtifact;
	try {
		previousArtifact = runtime.validateAgentArtifact({ store, artifactId: config.artifactId, piRoot: config.piRoot });
	} catch (error) {
		fail(
			`Agent is enabled in ${store} but the recorded artifact ${config.artifactId} no longer validates: ` +
				`${error.message}\n${label} refuses to continue: run --agent-disable (or repair the artifact) first. ` +
				`The active pi was not changed.`,
		);
	}
	let artifact;
	try {
		const recordedId = label === "Rollback" ? history[piRoot] : undefined;
		const artifactId = (typeof recordedId === "object" ? recordedId.artifactId : recordedId) ?? runtime.prepareAgentArtifact({ sourceRoot: repoRoot, store, piRoot }).artifactId;
		artifact = runtime.validateAgentArtifact({ store, artifactId, piRoot });
	} catch (error) {
		fail(
			`Agent is enabled in ${store} but no valid artifact could be prepared for ${piRoot}: ${error.message}\n` +
				`${label} refuses to continue so the opt-in is never silently dropped. The active pi was not changed.`,
		);
	}
	// Par novo ⇒ registros novos. Sem o recibo do par antigo não há como DESFAZER os registros dele,
	// e aplicar o novo em cima deixaria as extensões das duas releases carregando ao mesmo tempo.
	const switching = artifact.artifactId !== config.artifactId;
	if (switching && !(config.resourceReceipt && existsSync(config.resourceReceipt))) {
		fail(
			`Agent is enabled in ${store} with artifact ${config.artifactId} but its resource receipt ` +
				`${config.resourceReceipt ?? "(none)"} is missing: the registrations of the old pair cannot be swapped for ` +
				`the new one, and keeping both would load two generations of the same extensions. ${label} refuses to ` +
				`continue: run --agent-disable and then --agent-enable. The active pi was not changed.`,
		);
	}
	const { homeDir, agentDir } = agentHostDirs(options ?? { store, adoptLauncher: true });
	// Save the pair we are leaving, including stores installed before this index existed.
	// Do this before pointers/resources change; a failed activation leaves a valid association.
	const historyPath = join(store, agentStoreDir, "pi-artifacts.json");
	const temporary = `${historyPath}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify({ ...history, [config.piRoot]: config }, null, 2)}\n`);
	renameSync(temporary, historyPath);
	const historicalConfig = label === "Rollback" && typeof history[piRoot] === "object" ? history[piRoot] : undefined;
	if (artifact.manifest?.version < 3) {
		console.warn("Rollback: legacy runtime restores its declared Juice accounting contract.");
		const home = historicalConfig?.juiceHome || config.juiceHome;
		if (!home || !isAbsolute(home) || home.split(/[\\/]/).includes("..") || !existsSync(home) || !statSync(home).isDirectory()) fail("Legacy rollback requires its original existing juiceHome directory; nothing activated");
	}
	return { runtime, resources, config, historicalConfig, artifact, previousArtifact, piRoot, agentDir, homeDir, label, switching };
}

/**
 * Par novo valendo: registros de recursos trocados PRIMEIRO (settings efetivo) e só então a config,
 * que é o que o launcher lê. Opt-in, juiceHome e a cadeia de backup/CAS do B são preservados.
 */
function commitAgentPair(store, pair) {
	let receiptPath = pair.config.resourceReceipt;
	let switched;
	if (pair.initial) {
		const backupDir = agentResourceBackupDir(store, pair.oldConfig);
		try { receiptPath = pair.resources.applyAgentResources({ plan: pair.plan, backupDir }).receiptPath; }
		catch (error) {
			const receipt = join(backupDir, pair.resources.RECEIPT_NAME);
			if (existsSync(receipt)) rollbackAgentResourcesOrFail(pair.resources, receipt);
			throw error;
		}
		if (!receiptPath) fail("Initial runtime activation returned no resource receipt");
		pair.initialReceipt = receiptPath;
	}
	if (pair.switching) {
		switched = switchAgentResources({
			store,
			resources: pair.resources,
			label: pair.label ?? "switch",
			previousReceipt: pair.config.resourceReceipt,
			previousAgentRoot: artifactAgentRoot(pair.previousArtifact),
			agentRoot: artifactAgentRoot(pair.artifact),
			agentDir: pair.agentDir,
			homeDir: pair.homeDir,
		});
		receiptPath = switched.receiptPath;
		console.log(
			`Agent: resource registrations switched to ${artifactAgentRoot(pair.artifact)} (receipt ${receiptPath}; the ` +
				`previous pair's registrations were rolled back first, so no extension loads twice)`,
		);
	}
	const config = {
		...pair.config,
		version: pair.artifact.manifest?.version >= 3 ? 2 : (pair.historicalConfig?.version ?? pair.config.version),
		enabled: true,
		artifactId: pair.artifact.artifactId,
		piRoot: pair.artifact.piRoot ?? pair.piRoot,
		resourceReceipt: receiptPath,
	};
	if (config.version === 2) delete config.juiceHome;
	else if (pair.historicalConfig?.juiceHome) config.juiceHome = pair.historicalConfig.juiceHome;
	pair.committed = { config, switched };
	try {
		pair.runtime.writeAgentConfig({ store, config });
	} catch (error) {
		pair.committed = undefined;
		if (pair.initialReceipt) rollbackAgentResourcesOrFail(pair.resources, pair.initialReceipt);
		if (switched) {
			const recovery = restoreAgentResources({
				resources: pair.resources,
				agentRoot: artifactAgentRoot(pair.previousArtifact),
				agentDir: pair.agentDir,
				homeDir: pair.homeDir,
				backupDir: dirname(pair.config.resourceReceipt),
				snapshot: switched.snapshot,
			});
			error.message = `${error.message}\n${recovery.note}`;
			if (!recovery.restored) error.agentResourcesUnknown = true;
		}
		throw error;
	}
	return config;
}

/**
 * Desfaz o commit do par (recursos e config) quando uma etapa POSTERIOR falha e os ponteiros voltam:
 * config e registros efetivos têm de descrever o mesmo par que `current`.
 */
function restoreAgentPair(store, pair) {
	if (!pair?.committed) return { note: "", unknown: false };
	if (pair.initial) {
		try {
			rollbackAgentResourcesOrFail(pair.resources, pair.initialReceipt);
			if (pair.oldConfig) pair.runtime.writeAgentConfig({ store, config: pair.oldConfig });
			else rmSync(join(store, agentStoreDir, "config.json"), { force: true });
			pair.committed = undefined;
			return { note: "Initial runtime resources/config restored.", unknown: false };
		} catch (error) { return { note: error.message, unknown: true }; }
	}
	const { switched } = pair.committed;
	const notes = [];
	let unknown = false;
	if (switched) {
		const recovery = restoreAgentResources({
			resources: pair.resources,
			agentRoot: artifactAgentRoot(pair.previousArtifact),
			agentDir: pair.agentDir,
			homeDir: pair.homeDir,
			backupDir: dirname(pair.config.resourceReceipt),
			snapshot: switched.snapshot,
		});
		notes.push(recovery.note);
		if (!recovery.restored) unknown = true;
	}
	try {
		pair.runtime.writeAgentConfig({ store, config: pair.config });
		notes.push(`The Agent config was restored to artifact ${pair.config.artifactId} / ${pair.config.piRoot}.`);
	} catch (error) {
		notes.push(
			`The Agent config still records artifact ${pair.committed.config.artifactId} / ${pair.committed.config.piRoot} ` +
				`and could NOT be restored (${error.message}): run --agent-enable again or --agent-disable before using pi.`,
		);
		unknown = true;
	}
	pair.committed = undefined;
	return { note: ` ${notes.join(" ")}`, unknown };
}

async function agentStatusReport(store) {
	if (!existsSync(agentFilePath("runtime"))) {
		return `Agent: helper ${agentFiles.runtime} absent from this bundle/checkout (legacy mode)`;
	}
	try {
		const runtime = await loadAgentRuntime();
		const config = runtime.readAgentConfig(store);
		if (!config) return `Agent: not configured in ${store}`;
		let artifactState;
		try {
			runtime.validateAgentArtifact({ store, artifactId: config.artifactId });
			artifactState = "artifact valid";
		} catch (error) {
			artifactState = `artifact INVALID: ${error.message}`;
		}
		return (
			`Agent: ${config.enabled ? "enabled" : "disabled"} (artifactId ${config.artifactId}, piRoot ${config.piRoot}, ` +
			`contract v${config.version}, ${artifactState}` +
			`${config.resourceReceipt ? `, resource receipt ${config.resourceReceipt}` : ""})`
		);
	} catch (error) {
		return `Agent: status unavailable (${error.message})`;
	}
}

/**
 * `--agent-enable --juice-home <abs>`: ativa o Agent sobre a release que já está ativa.
 *
 * Ordem: validar a release ativa → preparar/validar artefato → planejar recursos → backup seletivo
 * → instalar bundle/wrapper novos → aplicar recursos → gravar config → registrar em `active.json`.
 * Artefato e plano antes de tocar launcher, recursos ou config; a config (que é o que o launcher lê)
 * é a última coisa a ligar. Qualquer falha antes dela deixa o Agent DESLIGADO (falha fechada).
 */
async function agentEnable(options) {
	const { store } = options;
	if (options.juiceHome !== undefined) console.warn("--juice-home is deprecated and ignored for new runtimes; that path is not accessed.");
	const runtime = await loadAgentRuntime();
	const resources = await loadAgentResourceHelper();
	if (!existsSync(agentFilePath("launch"))) {
		fail(`Agent launcher is missing: ${agentFilePath("launch")}. Nothing was changed.`);
	}
	const releaseDir = linkTarget(join(store, "current"));
	if (!releaseDir) {
		fail(`No active release under ${join(store, "current")}: install Pi first; Agent activates over the active pair.`);
	}
	const report = verifyRelease(releaseDir);
	for (const warning of report.warnings) console.warn(`Agent enable warning: ${warning}`);
	if (report.problems.length > 0 && !options.force) {
		fail(
			`Refusing to enable Agent over ${releaseDir}; the active release does not satisfy the current overlay contract:\n` +
				report.problems.map((problem) => `  - ${problem}`).join("\n") +
				`\nNothing was changed. Re-run the updater to rebuild the release, or pass --force to enable anyway.`,
		);
	}
	assertActiveWritable(store);
	const metadata = assertActivatable(store, releaseDir);
	const { homeDir, agentDir } = agentHostDirs(options);
	const existing = runtime.readAgentConfig(store);
	// Religar sobre um opt-in que já vale: o recibo descreve registros que PERTENCEM a ele. Desfazer
	// o recibo numa falha desta execução tiraria do ar o Agent que estava funcionando.
	const hadOptIn = existing?.enabled === true;
	let switched;
	const undoResources = (receiptPath) => {
		if (switched) {
			return restoreAgentResources({
				resources,
				agentRoot: artifactAgentRoot(switched.previousArtifact),
				agentDir,
				homeDir,
				backupDir: dirname(existing.resourceReceipt),
				snapshot: switched.snapshot,
			}).note;
		}
		if (!receiptPath) return `no receipt was produced, so nothing could be rolled back automatically; inspect ${agentResourceBackupDir(store, existing)}`;
		if (hadOptIn) {
			return (
				`the resource receipt ${receiptPath} was KEPT: it also describes the registrations of the opt-in that was ` +
				`already enabled (artifact ${existing.artifactId}), which stays in place`
			);
		}
		try {
			rollbackAgentResourcesOrFail(resources, receiptPath);
			return `the resources applied in this run were rolled back from ${receiptPath}`;
		} catch (rollbackError) {
			return `rolling back ${receiptPath} ALSO failed: ${rollbackError.message}; inspect ${dirname(receiptPath)}`;
		}
	};

	// Artefato e plano vêm antes de launcher, recursos e config: uma falha aqui não tocou nada.
	const piRoot = agentPiRoot(releaseDir, runtime);
	let artifact;
	let plan;
	let previousArtifact;
	try {
		const prepared = runtime.prepareAgentArtifact({ sourceRoot: repoRoot, store, piRoot });
		artifact = runtime.validateAgentArtifact({ store, artifactId: prepared.artifactId, piRoot });
		// Opt-in vivo com OUTRO artefato: é troca de par, não primeira ativação. O plano é replanejado
		// depois de desfazer os registros do par antigo (senão o novo entraria em cima do antigo), então
		// aqui só o artefato antigo é validado — ele é o alvo da restauração se a troca falhar.
		if (hadOptIn && existing.artifactId !== artifact.artifactId) {
			if (!(existing.resourceReceipt && existsSync(existing.resourceReceipt))) {
				throw new Error(
					`the opt-in already enabled (artifact ${existing.artifactId}) has no resource receipt at ` +
						`${existing.resourceReceipt ?? "(none)"}: its registrations cannot be swapped for the new pair's. ` +
						`Run --agent-disable first.`,
				);
			}
			previousArtifact = runtime.validateAgentArtifact({ store, artifactId: existing.artifactId });
		} else {
			plan = planAgentResourcesOrFail(resources, { agentRoot: artifactAgentRoot(artifact), agentDir, homeDir });
		}
	} catch (error) {
		error.message =
			`${error.message}\nAgent was NOT enabled: the artifact/plan for ${piRoot} did not validate, so the ` +
			`launcher, the resources and the config were not touched.`;
		throw error;
	}
	if (plan?.report) console.log(`Agent resource plan: ${JSON.stringify(plan.report)}`);

	const resourcesDir = agentResourceBackupDir(store, existing);
	const backup = captureAgentBackup(store, "enable", { config: existing ?? undefined, resourcesDir });
	const launcher = installWrapper(store, options.adoptLauncher);

	let receipt;
	try {
		if (previousArtifact) {
			const result = switchAgentResources({
				store,
				resources,
				label: "enable",
				previousReceipt: existing.resourceReceipt,
				previousAgentRoot: artifactAgentRoot(previousArtifact),
				agentRoot: artifactAgentRoot(artifact),
				agentDir,
				homeDir,
			});
			switched = { ...result, previousArtifact };
			receipt = { receiptPath: result.receiptPath, report: result.report };
			console.log(`Agent: resource registrations switched to ${artifactAgentRoot(artifact)} (receipt ${result.receiptPath})`);
		} else {
			receipt = resources.applyAgentResources({ plan, backupDir: resourcesDir });
		}
	} catch (error) {
		const candidate =
			error?.receiptPath ?? (typeof resources.RECEIPT_NAME === "string" ? join(resourcesDir, resources.RECEIPT_NAME) : undefined);
		const recovered = undoResources(candidate && existsSync(candidate) ? candidate : undefined);
		error.message =
			`${error.message}\nAgent was NOT enabled by this attempt: no config was written; ` +
			`${hadOptIn ? "the existing opt-in remains configured" : "pi keeps launching the legacy path"}. ` +
			`${recovered}. The overlay bundle and the wrapper at ${launcher.wrapper} were reinstalled (same content as ` +
			`before unless this checkout changed them); backup at ${backup.dir}, resource CAS at ${resourcesDir}.`;
		throw error;
	}
	const receiptPath = receipt?.receiptPath;
	if (!receiptPath || !isAbsolute(receiptPath)) {
		fail(
			`applyAgentResources returned no absolute receiptPath (got ${JSON.stringify(receiptPath)}); without a receipt ` +
				`--agent-disable could not undo the registrations, so Agent was NOT enabled (no config was written and ` +
				`pi keeps launching the legacy path).\nThe helper reported the resources as applied: whatever it wrote to ` +
				`${agentDir} is still there and must be undone by hand using the backup at ${resourcesDir}.`,
		);
	}

	const config = {
		version: 2,
		enabled: true,
		artifactId: artifact.artifactId,
		piRoot: artifact.piRoot ?? piRoot,
		resourceReceipt: receiptPath,
	};
	try {
		runtime.writeAgentConfig({ store, config });
	} catch (error) {
		const recovered = undoResources(receiptPath);
		error.message =
			`${error.message}\nAgent was NOT enabled by this run: the config could not be written, so the store keeps the ` +
			`${hadOptIn ? "opt-in it already had" : "legacy path"}. ${recovered}. Backup at ${backup.dir}.`;
		throw error;
	}

	try {
		writeActive(store, releaseDir, metadata, launcher, {
			activatedAt: activeRecord(store)?.activatedAt,
			agent: agentActiveSummary(config),
			agentEnabledAt: new Date().toISOString(),
			...agentSource(store, releaseDir),
		}, { inheritSource: true });
	} catch (error) {
		const recovery = undoResources(receiptPath);
		if (existing) runtime.writeAgentConfig({ store, config: existing });
		else rmSync(join(store, agentStoreDir, "config.json"), { force: true });
		error.message = `${error.message}\nAgent activation record failed; previous config restored. ${recovery}. Backup at ${backup.dir}.`;

		throw error;
	}
	console.log(
		`${productDisplayName}: Agent enabled over ${config.piRoot} (artifact ${artifact.artifactId}, runtime v3, ` +
			`receipt ${receiptPath}; backup ${backup.dir}). Ledger, SYSTEM/Vault, auth and ` +
			`model/thinking defaults were not touched.`,
	);
}

/**
 * `--agent-disable`: opt-out fecha a feature primeiro e só então devolve o delta de recursos.
 *
 * A config é gravada como `enabled:false` antes do rollback dos recursos: se o rollback falhar no
 * meio, `pi` já voltou ao caminho legado (falha fechada) e o recibo continua registrado para a
 * retentativa, em vez de ficar meio ligado. Ledger, mark2 e o artefato não são tocados.
 */
async function agentDisable(options) {
	const { store } = options;
	const runtime = await loadAgentRuntime();
	const config = runtime.readAgentConfig(store);
	if (!config) {
		console.log(`${productDisplayName}: Agent is not configured in ${store}; nothing to disable.`);
		return;
	}
	const backup = captureAgentBackup(store, "disable", { config, resourcesDir: agentResourceBackupDir(store, config) });
	const disabled = { ...config, enabled: false };
	runtime.writeAgentConfig({ store, config: disabled });
	const active = activeRecord(store);
	if (active?.releaseDir) {
		try {
			writeActive(store, active.releaseDir, releaseMetadata(active.releaseDir) ?? {}, launcherRecord(store), {
				activatedAt: active.activatedAt,
				agent: agentActiveSummary(disabled),
				agentDisabledAt: new Date().toISOString(),
			});
		} catch (error) {
			console.warn(`Agent is disabled, but ${join(store, "active.json")} still records it as enabled: ${error.message}`);
		}
	}
	if (!config.resourceReceipt) {
		console.log(
			`${productDisplayName}: Agent disabled in ${store}; the config recorded no resource receipt, so no ` +
				`registration was rolled back. Backup at ${backup.dir}.`,
		);
		return;
	}
	const resources = await loadAgentResourceHelper();
	try {
		// Conflito devolvido pelo helper (mudança posterior do usuário preservada) é erro: o opt-out não
		// pode anunciar "delta devolvido" quando parte do registro gerenciado continua no settings.
		const result = rollbackAgentResourcesOrFail(resources, config.resourceReceipt);
		if (result?.report) console.log(`Agent resource rollback: ${JSON.stringify(result.report)}`);
	} catch (error) {
		error.message =
			`${error.message}\nAgent is already DISABLED (pi launches the legacy path), but rolling back the resource ` +
			`delta from ${config.resourceReceipt} failed: the registrations may still be in ${agentHostDirs(options).agentDir}. ` +
			`Retry with: node ${join(repoRoot, "scripts", "agent-update.mjs")} --store ${store} --agent-disable ` +
			`(idempotent). Backup at ${backup.dir}.`;
		throw error;
	}
	console.log(
		`${productDisplayName}: Agent disabled in ${store}; the resource delta from ${config.resourceReceipt} was rolled ` +
			`back and the opt-in record (artifact ${config.artifactId}) was kept for a future --agent-enable. Ledger, ` +
			`mark2 and personal settings were not touched. Backup at ${backup.dir}.`,
	);
}

/**
 * Every bundle ever installed keeps a runnable updater in the store, and whichever one runs last
 * owns the wrapper and the store layout. A store therefore records the updater generation that
 * wrote it, and an older updater refuses to touch it instead of silently reinstating retired
 * lifecycle behaviour.
 */
function assertUpdaterGeneration(store, force) {
	const record = activeRecord(store);
	const recorded = record?.updaterGeneration ?? 0;
	if (recorded <= updaterGeneration) return;
	const newer = record?.overlayRepo
		? join(record.overlayRepo, "scripts", "agent-update.mjs")
		: "the updater of the bundle recorded in active.json";
	if (!force) {
		fail(
			`${store} was last written by overlay updater generation ${recorded}; this one is generation ` +
				`${updaterGeneration}. Run ${newer} instead, or pass --force to downgrade the store on purpose.`,
		);
	}
	console.warn(`Downgrading ${store} from updater generation ${recorded} to ${updaterGeneration} (--force)`);
}

/**
 * A release directory is named after the content it holds, so a build reuses a directory only when
 * the copy on disk still verifies as this exact build. A directory that does not is never
 * overwritten, moved, or deleted: the tree a live session is running from keeps its path and its
 * inode, the new build lands in a sibling directory, and `previous` therefore still points at the
 * generation that was active a moment ago.
 */
function releaseCandidates(releasesDir, releaseId, preferred) {
	let entries = [];
	try {
		entries = readdirSync(releasesDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs = entries
		.filter((entry) => entry.isDirectory() && (entry.name === releaseId || entry.name.startsWith(`${releaseId}+`)))
		.map((entry) => join(releasesDir, entry.name))
		.sort();
	const active = dirs.filter((dir) => resolvedPath(dir) === preferred);
	return [...active, ...dirs.filter((dir) => resolvedPath(dir) !== preferred)];
}

function allocateReleaseDir(releasesDir, releaseId) {
	const available = (candidate) => !linkExists(candidate) &&
		!linkExists(join(dirname(releasesDir), "prepared", `${basename(candidate)}.json`));
	const primary = join(releasesDir, releaseId);
	if (available(primary)) return primary;
	for (let index = 2; index <= 99; index++) {
		const candidate = join(releasesDir, `${releaseId}+${index}`);
		if (available(candidate)) return candidate;
	}
	return fail(`No free release directory left for ${releaseId} under ${releasesDir}`);
}

/**
 * Releases nobody points at are the only ones that may be collected, and only past the retention
 * floor: `current` and `previous` are always kept, so rollback always has a working target and a
 * live session never loses the tree it is running from.
 */
function planOrphanReleases(store, activeRelease, keepExtra = [], retention = orphanReleaseRetention, preparedProtects = () => true) {
	const releasesDir = join(store, "releases");
	const kept = new Set(
		[activeRelease, linkTarget(join(store, "current")), linkTarget(join(store, "previous"))].filter(Boolean).map(resolvedPath),
	);
	// `keepExtra` pode apontar para DENTRO de uma release (o `piRoot` do Agent é o diretório do
	// pacote instalado): a release que contém o caminho em uso também está em uso.
	const keptInside = keepExtra.filter(Boolean).map(resolvedPath);
	const inUse = (dir) => kept.has(dir) || keptInside.some((path) => path === dir || path.startsWith(`${dir}${isWindows ? "\\" : "/"}`));
	const orphans = readdirSync(releasesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => join(releasesDir, entry.name))
		.filter((dir) => !inUse(resolvedPath(dir)) && !(linkExists(join(store, "prepared", `${basename(dir)}.json`)) && preparedProtects(basename(dir))))
		.map((dir) => ({ dir, mtimeMs: statSync(dir).mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return { kept: orphans.slice(0, retention).map((orphan) => orphan.dir), doomed: orphans.slice(retention).map((orphan) => orphan.dir) };
}

function collectOrphanReleases(store, activeRelease, keepExtra = [], retention = orphanReleaseRetention) {
	for (const dir of planOrphanReleases(store, activeRelease, keepExtra, retention).doomed) {
		console.log(`Collecting orphan release ${basename(dir)}`);
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Superseded bundles are collected for the same reason releases are: a store that keeps every
 * updater it ever installed keeps every retired lifecycle bug one stray invocation away from the
 * live tree. A bundle that carries its own git history is a checkout rather than a generated
 * bundle, so it is kept and only stripped of its executable bit.
 */
function collectOverlayBundles(store, keep) {
	const bundlesDir = join(store, "overlay-bundles");
	const kept = new Set(keep.filter(Boolean).map(resolvedPath));
	let entries = [];
	try {
		entries = readdirSync(bundlesDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const bundle = join(bundlesDir, entry.name);
		if (kept.has(resolvedPath(bundle))) continue;
		if (existsSync(join(bundle, ".git"))) {
			for (const script of existsSync(join(bundle, "scripts")) ? readdirSync(join(bundle, "scripts")) : []) {
				chmodSync(join(bundle, "scripts", script), 0o644);
			}
			console.log(`Overlay checkout ${entry.name} is superseded; its scripts are no longer executable`);
			continue;
		}
		console.log(`Collecting superseded overlay bundle ${entry.name}`);
		rmSync(bundle, { recursive: true, force: true });
	}
}

/**
 * Tudo que pode ser conferido antes de mexer em ponteiro é conferido antes.
 *
 * A metadata da release e o tipo de `active.json` eram validados tarde: a release era lida (e podia
 * ser recusada por não ter rótulo) e `active.json` era gravado DEPOIS de `current` já apontar para a
 * release nova. Um `active.json` que não é arquivo regular, ou uma release sem `agent-release.json`,
 * terminavam com `current` novo e metadata antiga — divergência silenciosa, ainda anunciada como
 * "active pi was not changed". Falhar aqui é a única falha de ativação que realmente não muda nada.
 */
function assertActivatable(store, releaseDir) {
	const file = join(releaseDir, releaseMetadataFile);
	const metadata = releaseMetadata(releaseDir);
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		fail(`Refusing to activate ${releaseDir}: ${file} is missing, unreadable or not a JSON object. The active pi was not changed.`);
	}
	for (const key of ["officialVersion", "overlayFingerprint", "treeDigest"]) {
		if (typeof metadata[key] !== "string" || metadata[key] === "") {
			fail(`Refusing to activate ${releaseDir}: ${file} has no usable "${key}". The active pi was not changed.`);
		}
	}
	assertActiveWritable(store);
	return metadata;
}

/** `active.json` precisa ser arquivo regular: o rename atômico não sobrescreve diretório nem link. */
function assertActiveWritable(store) {
	const active = join(store, "active.json");
	if (linkExists(active) && !lstatSync(active).isFile()) {
		fail(
			`${active} is not a regular file; the activation record cannot be written there. ` +
				`Move it out of the way and run the updater again. The active pi was not changed.`,
		);
	}
}

/**
 * Ativação em três trechos, com honestidade diferente em cada um:
 *
 * 1. ponteiros + wrapper: se falhar, `current`/`previous` voltam ao que eram e `active.json` nem é
 *    tocado — nada mudou (o wrapper e o bundle não são transacionais, e a mensagem diz isso).
 * 2. sync de recursos (skills, extensões, setup do Agent): o runtime JÁ está ativo. Não há como
 *    desfazer settings/temas/pasta de papéis aqui, então `active.json` é gravado apontando para a
 *    release nova (ponteiro e metadata consistentes) com `partialActivation`, e o erro diz
 *    "partial activation", não "unchanged".
 * 3. gravação de `active.json`: se ela falhar, os ponteiros voltam, para não deixar `current` novo
 *    com metadata velha.
 */
async function activateRelease(store, releaseDir, adoptLauncher, activationOptions = {}) {
	const metadata = assertActivatable(store, releaseDir);
	// Par Pi+Agent preparado e validado ANTES de qualquer ponteiro: com o opt-in ligado, uma troca
	// de release sem artefato correspondente deixaria `pi` sem runtime para carregar.
	const agent = await prepareAgentPair(store, releaseDir, "Activation", { store, adoptLauncher, ...activationOptions });
	const current = join(store, "current");
	const previous = join(store, "previous");
	const oldCurrent = linkTarget(current);
	// Para restaurar vale o texto do link, não o caminho resolvido: `readCurrentTarget` (o CAS) compara
	// exatamente esse texto, e um store sob caminho com symlink (/tmp -> /private/tmp) resolveria para
	// outra string, fazendo a próxima execução achar que alguém trocou `current`.
	const currentText = readCurrentTargetText(current);
	const previousText = readCurrentTargetText(previous);
	const restorePointers = () => {
		try {
			if (currentText) atomicSymlink(currentText, current);
			else removeLink(current);
			if (previousText) atomicSymlink(previousText, previous);
			else removeLink(previous);
			return true;
		} catch (error) {
			console.error(`Could not restore ${current}/${previous} after a failed activation: ${error.message}`);
			return false;
		}
	};
	const describeRestore = (restored) =>
		restored
			? `current/previous were restored to ${currentText ?? "none"}/${previousText ?? "none"}`
			: `current/previous could NOT be restored; inspect ${store} before running pi`;

	let launcher;
	try {
		if (oldCurrent && oldCurrent !== resolvedPath(releaseDir)) atomicSymlink(oldCurrent, previous);
		atomicSymlink(releaseDir, current);
		launcher = installWrapper(store, adoptLauncher);
	} catch (error) {
		const restored = restorePointers();
		if (!restored) error.activationState = "unknown";
		error.message =
			`${error.message}\nActivation aborted while switching the runtime: ${describeRestore(restored)} and ` +
			`active.json was left untouched. The wrapper, the launcher and the installed overlay bundle are not ` +
			`part of this restore: they may already reference the new bundle.`;
		throw error;
	}

	// Só o store padrão é o Agent do usuário; um store de teste não toca o settings do Pi.
	let syncFailure;
	if (adoptLauncher && !(activationOptions.installRuntime && !agent)) {
		const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".agent");
		try {
			// Com o Agent ligado, extensões, skills e temas são registrados pelo recibo de recursos, com
			// backup/CAS e rollback. Os syncs legados escrevem `settings.extensions`/`settings.skills` sem
			// recibo nenhum (e o agent-setup ainda devolve defaults pessoais): rodá-los aqui deixaria
			// entradas que nem o opt-out nem a troca de par sabem desfazer — exatamente o par misturado.
			if (agent) {
				console.log(
					`Agent is enabled: skipping the legacy agent-setup/skills/extensions sync; those registrations are ` +
						`managed by the Agent resource receipt` +
						`${agent.config.resourceReceipt ? ` ${agent.config.resourceReceipt}` : ""} and switch with the pair.`,
				);
				// Os registros que o usuário já tinha (settings/symlinks) ainda apontam para <store>/skills e
				// <store>/extensions/megamind: sem atualizar os arquivos, o Megamind e as skills padrão ficam
				// congelados na última ativação legada. Só o conteúdo de cópias existentes muda; settings não.
				if (!(agent.artifact.manifest?.version >= 3)) {
					syncAgentSkills({ sourceRoot: launcher.overlayRepo, store, agentDir, homeDir: homedir(), register: false });
					syncAgentExtensions({ sourceRoot: launcher.overlayRepo, store, agentDir, register: false });
				}
			} else {
				syncAgentSkills({ sourceRoot: launcher.overlayRepo, store, agentDir, homeDir: homedir() });
				syncAgentExtensions({ sourceRoot: launcher.overlayRepo, store, agentDir });
				syncAgentSetup({ sourceRoot: launcher.overlayRepo, store, agentDir, homeDir: homedir() });
			}
		} catch (error) {
			syncFailure = error;
		}
	}

	let agentConfig;
	try {
		agentConfig = agent ? commitAgentPair(store, agent) : undefined;
		if (activationOptions.selection) writeStoreLayers(store, activationOptions.selection);
		writeActive(store, releaseDir, metadata, launcher, {
			activatedAt: new Date().toISOString(),
			agent: agentConfig ? agentActiveSummary(agentConfig) : undefined,
			// O sync legado também instala `agent/` do checkout atual: numa release Pi reaproveitada, a origem
			// da metadata dela é antiga e o aviso de "commits ahead" mentiria depois de atualizar.
			...(agentConfig || (adoptLauncher && !syncFailure) ? agentSource(store, releaseDir) : {}),
			partialActivation: syncFailure ? true : undefined,
			partialActivationReason: syncFailure ? (syncFailure.message ?? String(syncFailure)) : undefined,
		});
	} catch (error) {
		// O par do Agent é (artefato, piRoot, registros de recursos): se ele já descreve a release nova
		// e os ponteiros voltam para a antiga, o launcher carregaria o par errado. Ele volta primeiro.
		const agentRestore = restoreAgentPair(store, agent);
		const agentNote = agentRestore.note;
		if (agentRestore.unknown || error.agentResourcesUnknown) error.activationState = "unknown";
		const restored = restorePointers();
		if (!restored) error.activationState = "unknown";
		else if (error.activationState !== "unknown" && (syncFailure || adoptLauncher)) error.activationState = "partial";
		error.message =
			`${error.message}${agentNote}\nCould not record the activation in ${join(store, "active.json")}: ${describeRestore(restored)}, ` +
			`so current and the recorded metadata still agree. The wrapper and any resource already synced to the ` +
			`agent folder were NOT rolled back.${syncFailure ? ` The resource sync had already failed: ${syncFailure.message}` : ""}`;
		throw error;
	}

	if (syncFailure) {
		const error = new Error(
			`Partial activation: the runtime at ${releaseDir} IS active (current, wrapper and active.json point at it), ` +
				`but syncing the Agent resources failed: ${syncFailure.message}\n` +
				`Settings, themes, skills and the agent folder may hold a mix of the two releases; nothing was rolled back ` +
				`and active.json records partialActivation. Fix the cause and run the updater again, or roll back with ` +
				`\`agent overlay-rollback\`.`,
		);
		error.activationState = "partial";
		throw error;
	}
	return launcher;
}

/** Mesma transação do activate, só para o rollback de release: par validado antes dos ponteiros. */
async function rollbackAgentPair(store, previousTarget, options) {
	return prepareAgentPair(store, previousTarget, "Rollback", options);
}

// Receipts are local integrity records, not signatures against the store owner.
function validateReleaseId(id) {
	if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(id) || id.includes("..")) {
		fail("--promote requires a release ID, not a path");
	}
}

function storeChild(store, directory, name) {
	const root = realpathSync(store);
	const parent = join(root, directory);
	if (!linkExists(parent)) fail(`Missing store directory ${parent}; run --prepare first`);
	if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) fail(`Unsafe store directory: ${parent}`);
	const child = join(parent, name);
	if (!linkExists(child)) fail(`Missing prepared artifact ${child}; run --prepare first`);
	if (lstatSync(child).isSymbolicLink() || realpathSync(child) !== child) fail(`Unsafe store path: ${child}`);
	return child;
}

function assertContainedTree(root) {
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				const target = realpathSync(path);
				if (target !== root && !target.startsWith(`${root}${isWindows ? "\\" : "/"}`)) {
					fail(`Release symlink escapes its tree: ${path}`);
				}
			} else if (entry.isDirectory()) walk(path);
			else if (!entry.isFile()) fail(`Unsupported release entry: ${path}`);
		}
	};
	walk(root);
}

function requireVerified(releaseDir, metadata) {
	const report = verifyRelease(releaseDir, metadata);
	if (report.problems.length) fail(`Release verification failed: ${report.problems.join("; ")}`);
}

function writePrepared(store, releaseDir, metadata, currentAtPrepare, provenance) {
	const id = basename(releaseDir);
	validateReleaseId(id);
	releaseDir = storeChild(store, "releases", id);
	assertContainedTree(releaseDir);
	if (JSON.stringify(releaseMetadata(releaseDir)) !== JSON.stringify(metadata)) fail("Build metadata differs from installed metadata");
	requireVerified(releaseDir, metadata);
	const receipt = {
		schemaVersion: 1, updaterGeneration, store: realpathSync(store), releaseId: id,
		platform: process.platform, arch: process.arch, nodeVersion: process.version,
		preparedAt: new Date().toISOString(), currentAtPrepare,
		manifestSha256: sha256(manifestPath), provenance, metadata,
		metadataSha256: sha256(join(releaseDir, releaseMetadataFile)),
		// Algorithm 0 preserves raw catalog timestamps and modes; OS-only .DS_Store remains ignored.
		exactTreeDigest: digestTree(releaseDir, receiptDigestAlgorithm),
		selection: metadata.optionalLayers,
	};
	const receipts = join(store, "prepared");
	mkdirSync(receipts, { recursive: true });
	if (lstatSync(receipts).isSymbolicLink()) fail("Unsafe prepared directory");
	writeFileSync(join(receipts, `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
	return receipt;
}

async function promote(options) {
	const { store, promote: id } = options;
	validateReleaseId(id);
	const releaseDir = storeChild(store, "releases", id);
	const receiptFile = storeChild(store, "prepared", `${id}.json`);
	let receipt;
	try { receipt = JSON.parse(readFileSync(receiptFile, "utf8")); }
	catch { fail(`Invalid prepare receipt JSON: ${receiptFile}`); }
	const expectedReceipt = {
		schemaVersion: 1, updaterGeneration, store: realpathSync(store), releaseId: id,
		platform: process.platform, arch: process.arch, nodeVersion: process.version, manifestSha256: sha256(manifestPath),
	};
	for (const [field, value] of Object.entries(expectedReceipt)) {
		if (receipt?.[field] !== value) fail(`Invalid or incompatible prepare receipt: ${field} differs; run --prepare again in this store/environment`);
	}
	if (!(receipt.currentAtPrepare === null || typeof receipt.currentAtPrepare === "string") ||
		!Number.isFinite(Date.parse(receipt.preparedAt))) fail("Invalid prepare receipt: currentAtPrepare or preparedAt");
	assertContainedTree(releaseDir);
	const metadata = releaseMetadata(releaseDir);
	if (!metadata || JSON.stringify(metadata) !== JSON.stringify(receipt.metadata) ||
		sha256(join(releaseDir, releaseMetadataFile)) !== receipt.metadataSha256 ||
		digestTree(releaseDir, receiptDigestAlgorithm) !== receipt.exactTreeDigest) fail("Prepared metadata or exact tree digest changed");
	if (!Array.isArray(receipt.selection)) fail("Invalid receipt selection");
	const selection = selectLayers(overlayPatches(), { with: receipt.selection });
	for (const patch of selection.selected) verifyOverlayPatch(patch);
	if (JSON.stringify(selection.optional) !== JSON.stringify(receipt.selection) ||
		JSON.stringify(metadata.optionalLayers) !== JSON.stringify(selection.optional) ||
		JSON.stringify(metadata.patches) !== JSON.stringify(Object.fromEntries(selection.selected.map((p) => [p.name, p.sha256]))) ||
		metadata.overlayFingerprint !== overlayFingerprint(selection.selected) || metadata.digestAlgorithm !== digestAlgorithm) {
		fail("Prepared selection, patches or fingerprint are inconsistent");
	}
	const provenance = receipt.provenance;
	if (!provenance || provenance.repository !== manifest.officialRepository ||
		typeof provenance.requestedRef !== "string" || typeof provenance.refFromManifest !== "boolean" ||
		typeof metadata.officialRef !== "string" || !/^[a-f0-9]{40,64}$/.test(metadata.officialCommit) ||
		(provenance.refFromManifest && (provenance.requestedRef !== "release" || metadata.officialRef !== manifest.overlayRef || metadata.officialCommit !== manifest.overlayBase)) ||
		(!["release", "latest"].includes(provenance.requestedRef) && metadata.officialRef !== provenance.requestedRef)) {
		fail("Invalid prepared provenance");
	}
	const layout = upstreamLayouts().find((item) => item.name === provenance.layout && item.binPi === provenance.entrypoint);
	const packages = findInstalledPackages(releaseDir, manifest.officialPackage);
	if (!layout || packages.length === 0) fail("Invalid prepared entrypoint layout");
	for (const target of packages) {
		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		if (pkg.name !== manifest.officialPackage || pkg.version !== metadata.officialVersion || pkg.bin?.pi !== layout.binPi ||
			!existsSync(join(target, layout.binPi))) fail("Installed package identity differs from prepared build");
	}
	// CAS uses the preparation snapshot, not the state at the start of promotion.
	assertCurrentUnchanged(store, receipt.currentAtPrepare, { force: options.force });
	requireVerified(releaseDir, metadata);
	assertCurrentUnchanged(store, receipt.currentAtPrepare, { force: options.force });
	await activateRelease(store, releaseDir, options.adoptLauncher);
	writeStoreLayers(store, selection.optional);
	// Do not prune here: a prepared binary may still be running external tests.
	console.log(`${productDisplayName}: promoted prepared release ${id} without rebuilding (${metadata.treeDigest})`);
}

// Portable content verification replaces (never bypasses) host-bound --prepare receipts.
async function installArtifact(options) {
	options.store = realpathSync(options.store);
	const root = realpathSync(resolve(options.installArtifact));
	const artifact = validateDirectory(root);
	if (root !== repoRoot.replace(/[\\/]bundle$/, "")) fail("Install must run from the verified artifact bundle (use the archive path)");
	const source = join(root, "release");
	assertContainedTree(source);
	const metadata = releaseMetadata(source);
	const selection = selectLayers(overlayPatches(), { with: metadata?.optionalLayers ?? [] });
	for (const patch of selection.selected) verifyOverlayPatch(patch);
	if (metadata?.digestAlgorithm !== 3 || metadata?.treeDigest !== artifact.treeDigest ||
		metadata?.overlayFingerprint !== artifact.overlayFingerprint || metadata?.overlayFingerprint !== overlayFingerprint(selection.selected) ||
		JSON.stringify(metadata.patches) !== JSON.stringify(Object.fromEntries(selection.selected.map(p => [p.name, p.sha256])))) fail("Artifact release metadata/selection mismatch");
	for (const pkgRoot of findInstalledPackages(source, manifest.officialPackage)) {
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
		if (pkg.name !== manifest.officialPackage || pkg.version !== metadata.officialVersion || !upstreamLayouts().some(l => l.binPi === pkg.bin?.pi)) fail("Artifact package identity/layout mismatch");
	}
	if (!findInstalledPackages(source, manifest.officialPackage).length) fail("Artifact contains no Pi package");
	requireVerified(source, metadata);
	const before = readCurrentTarget(options.store);
	const releases = join(options.store, "releases"); mkdirSync(releases, { recursive: true });
	if (lstatSync(releases).isSymbolicLink() || realpathSync(releases) !== releases) fail("Unsafe releases directory");
	const release = join(releases, artifact.releaseId);
	if (linkExists(release)) {
		if (lstatSync(release).isSymbolicLink() || sha256(join(release, releaseMetadataFile)) !== sha256(join(source, releaseMetadataFile)) || digestTree(release, 0) !== digestTree(source, 0)) fail("Existing release ID has different content");
	} else {
		const stage = join(releases, `.artifact-${process.pid}`);
		try { cpSync(source, stage, { recursive: true, verbatimSymlinks: true }); assertContainedTree(stage); renameSync(stage, release); }
		finally { rmSync(stage, { recursive: true, force: true }); }
	}
	// Capture only transaction-owned launcher/metadata files; auth and sessions never enter backups.
	const paths = [join(options.store,"release-identities.json"), join(options.store,"active.json"), join(options.store,"layers.json"), join(options.store,"bin", isWindows ? "pi-wrapper.cmd" : "pi-wrapper")];
	if (options.adoptLauncher) paths.push(join(homedir(), ".local", "bin", isWindows ? "agent.cmd" : "agent"));
	const snapshots = paths.map(path => ({ path, exists: linkExists(path), link: linkExists(path) && lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null,
		body: linkExists(path) && lstatSync(path).isFile() ? readFileSync(path) : null, mode: linkExists(path) ? lstatSync(path).mode : 0o755 }));
	try {
		assertCurrentUnchanged(options.store, before);
		// Provenance belongs to the installed pair, outside its immutable verified tree.
		// Snapshot/restore this index with active.json so failed installs cannot relabel rollback.
		const identitiesFile = join(options.store, "release-identities.json");
		const identities = readJsonFile(identitiesFile) ?? {};
		if (options.releaseTag) identities[release] = { tag: options.releaseTag, assetId: artifact.releaseId, repo: options.releaseRepo };
		else delete identities[release];
		const temporary = `${identitiesFile}.tmp-${process.pid}`;
		try { writeFileSync(temporary, `${JSON.stringify(identities, null, 2)}\n`); renameSync(temporary, identitiesFile); }
		finally { rmSync(temporary, { force: true }); }
		await activateRelease(options.store, release, options.adoptLauncher, { installRuntime: true, selection: selection.optional });
	} catch (error) {
		for (const saved of snapshots) {
			try {
				if (!saved.exists) rmSync(saved.path, { force: true });
				else if (saved.link) { rmSync(saved.path, { force: true }); symlinkSync(saved.link, saved.path); }
				else if (saved.body) {
					// Replace the directory entry; never follow a launcher symlink created during activation.
					const temporary = mkdtempSync(join(dirname(saved.path), ".agent-restore-"));
					try {
						const file = join(temporary, "file");
						writeFileSync(file, saved.body, { mode: saved.mode & 0o7777, flag: "wx" });
						chmodSync(file, saved.mode & 0o7777);
						renameSync(file, saved.path);
					} finally { rmSync(temporary, { recursive: true, force: true }); }
				}
			} catch (restoreError) { error.message += `\nLauncher metadata restore failed: ${restoreError.message}`; }
		}
		throw error;
	}
	console.log(`Agent: installed private artifact ${artifact.releaseId}; profile ${process.env.PI_CODING_AGENT_DIR || join(homedir(), ".agent")}`);
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Bytes em disco de um arquivo ou árvore, sem seguir symlinks; ilegível conta como 0. */
function pathSize(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	let entries = [];
	try {
		entries = readdirSync(path);
	} catch {
		return 0;
	}
	for (const name of entries) total += pathSize(join(path, name));
	return total;
}

function formatSize(bytes) {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${bytes}B`;
}

function directoryNames(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
	} catch {
		return [];
	}
}

/**
 * `agent overlay-status`: somente leitura, sem lock e sem rede. Mostra o que está instalado, o par
 * Agent e quantos commits o checkout de origem tem à frente da instalação (git local).
 */
function overlayStatus(store) {
	const active = activeRecord(store);
	const lines = [`${productDisplayName} overlay status (${store})`];
	if (!active) {
		lines.push("Installed: no active.json; run: node scripts/agent-update.mjs");
		console.log(lines.join("\n"));
		return;
	}
	lines.push(active.release ? `Release: ${active.release.tag} (assetId ${active.release.assetId}, repo ${active.release.repo})` : "Release: unknown (local install or unrecorded release)");
	const commit = typeof active.officialCommit === "string" ? active.officialCommit.slice(0, 10) : "unknown";
	lines.push(`Pi: ${active.officialVersion ?? "unknown"} (${active.officialRef ?? "unknown ref"}, commit ${commit})`);
	const optional = Array.isArray(active.optionalLayers) ? active.optionalLayers : [];
	lines.push(`Overlay: ${Object.keys(active.patches ?? {}).length} patches; optional layers ${optional.length > 0 ? optional.join(", ") : "none"}`);
	for (const name of ["current", "previous"]) {
		const target = linkTarget(join(store, name));
		lines.push(`${name === "current" ? "Current:  " : "Previous: "}${target ? basename(target) : "none"}`);
	}
	const config = readJsonFile(join(store, agentStoreDir, "config.json"));
	lines.push(
		config?.enabled === true
			? `Agent: on (artifact ${String(config.artifactId).slice(0, 12)})`
			: config
				? "Agent: off (configured but disabled)"
				: "Agent: off (not configured)",
	);
	if (!active.sourceRepo || !active.sourceCommit) {
		lines.push("Checkout: source unknown (installed before the updater recorded it)");
	} else {
		const ahead = commitsAhead(active.sourceRepo, active.sourceCommit);
		const where = `${active.sourceRepo} @ ${String(active.sourceCommit).slice(0, 10)}`;
		lines.push(
			ahead === undefined
				? `Checkout: ${where} (cannot compare: repository or commit not found)`
				: ahead === "diverged"
					? `Checkout: ${where} (diverged: the installed commit is not an ancestor of the checkout HEAD)`
				: ahead === 0
					? `Checkout: ${where} (install is up to date)`
					: `Checkout: ${where} (${ahead} commit${ahead === 1 ? "" : "s"} ahead of the install; run: node ${join(active.sourceRepo, "scripts", "agent-update.mjs")})`,
		);
	}
	// Sem varrer o store inteiro: só o que o gc apagaria (o mesmo plano do --dry-run).
	const reclaimable = planOverlayGc(store, 1, { sizeReports: false }).filter((item) => item.action === "delete");
	lines.push(`Reclaimable by gc: ${formatSize(reclaimable.reduce((sum, item) => sum + item.size, 0))} in ${reclaimable.length} item(s) (details: agent overlay-gc --dry-run)`);
	console.log(lines.join("\n"));
}

/** Snapshot com PID, argumentos e ambiente (AGENT_JUICE_BIN pode ser usado só no próximo
 * snapshot do broker). Nunca imprime comandos/ambiente: podem conter segredos.
 * Windows ou inspeção indisponível: undefined, para conservar em vez de presumir desuso.
 */
function liveProcesses() {
	if (isWindows) return undefined;
	// Sem locale UTF-8 (ex.: `env -i`), o ps escapa bytes não ASCII (`ç` vira `M-CM-'` no macOS,
	// `?` no procps) e um caminho com acento deixa de casar: forçar UTF-8 mantém o texto literal.
	const result = spawnSync("ps", ["eww", "-ax", "-o", "pid=,command="], {
		encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10000,
		env: { ...process.env, LC_ALL: "C.UTF-8" },
	});
	if (result.status !== 0 || !result.stdout?.trim()) return undefined;
	const processes = result.stdout.split("\n").flatMap((line) => {
		const match = line.match(/^\s*(\d+)\s+(.+)$/);
		return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
	});
	return processes.length ? processes : undefined;
}

function commandUsesPath(command, path) {
	let start = 0;
	while ((start = command.indexOf(path, start)) !== -1) {
		const next = command[start + path.length];
		if (next === undefined || /[\/\\\s"']/.test(next)) return true;
		start += path.length;
	}
	// Se o ps ainda escapar bytes não ASCII (locale UTF-8 indisponível), casa cada trecho não
	// ASCII com qualquer escape curto sem `/`: na dúvida, conserva.
	if (!/[^\x00-\x7f]/.test(path)) return false;
	const loose = path.split(/([^\x00-\x7f]+)/).map((part, index) => index % 2
		? `[^/\\s]{1,${part.length * 16}}?`
		: part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
	return new RegExp(`${loose}(?=$|[\\/\\\\\\s"'])`).test(command);
}

/**
 * Plano do `overlay-gc`. Cada item é { kind, path, size, action: "delete" | "report", note }.
 * Só "delete" é apagado; "report" é listado porque não há como provar que está sem uso (ou porque
 * é trabalho do usuário). Nada em uso por current/previous, recibo preparado ou Agent entra.
 */
function planOverlayGc(store, keep = 1, { sizeReports = true, getProcesses = liveProcesses } = {}) {
	const items = [];
	const add = (kind, path, action, note) => items.push({ kind, path, size: action === "delete" || sizeReports ? pathSize(path) : 0, action, note });
	const active = activeRecord(store);
	const config = readJsonFile(join(store, agentStoreDir, "config.json"));
	const agentPiRoot = config?.piRoot;
	const processes = getProcesses();
	const unavailable = "process inspection unavailable: cannot prove unused";
	const reason = (proc) => proc ? `in use by running process ${proc.pid}` : unavailable;
	const using = (dir) => processes?.find((proc) => [dir, resolvedPath(dir)].some((path) => commandUsesPath(proc.command, path)));
	const livePaths = new Map();
	const livePiRoots = [];
	const processCandidates = [];
	for (const [kind, parent] of [["release", join(store, "releases")], ["agent artifact", join(store, agentStoreDir, "releases")]]) {
		const names = new Set(directoryNames(parent).map((entry) => entry.name));
		// Também reporta árvores já removidas por um GC anterior, ainda referidas por kernels vivos.
		for (const proc of processes ?? []) {
			for (const prefix of new Set([`${parent}${sep}`, `${resolvedPath(parent)}${sep}`])) {
				let start = 0;
				while ((start = proc.command.indexOf(prefix, start)) !== -1) {
					start += prefix.length;
					const name = proc.command.slice(start).match(/^[^/\\\s"']+/)?.[0];
					if (name && name !== "." && name !== "..") names.add(name);
				}
			}
		}
		for (const name of names) {
			const dir = join(parent, name);
			processCandidates.push({ kind, dir });
			const proc = using(dir);
			if (!proc && processes !== undefined) continue;
			livePaths.set(resolvedPath(dir), reason(proc));
			if (kind === "release") livePiRoots.push({ path: dir, note: reason(proc) });
			else {
				const piRoot = readJsonFile(join(dir, "manifest.json"))?.piRoot;
				if (typeof piRoot === "string") livePiRoots.push({ path: piRoot, note: reason(proc) });
			}
		}
	}
	for (const { kind, dir } of processCandidates) {
		const canonical = resolvedPath(dir);
		if (kind === "release" && !livePaths.has(canonical)) {
			const root = livePiRoots.find(({ path }) => resolvedPath(path) === canonical || resolvedPath(path).startsWith(`${canonical}${sep}`));
			if (root) livePaths.set(canonical, root.note);
		}
		if (livePaths.has(canonical)) add(kind, dir, "report", livePaths.get(canonical));
	}

	// Releases: a mesma regra do update (current, previous, preparadas, piRoot do Agent), com retenção `keep`.
	const releasesDir = join(store, "releases");
	if (existsSync(releasesDir)) {
		// Um recibo só protege a release enquanto o `promote` ainda funciona sem --force: se `current`
		// mudou desde o prepare, o CAS recusa a promoção e a release preparada está superada.
		const current = readCurrentTarget(store);
		const promotable = (id) => readJsonFile(join(store, "prepared", `${id}.json`))?.currentAtPrepare === current;
		for (const dir of planOrphanReleases(store, active?.releaseDir, [agentPiRoot, ...livePiRoots.map(({ path }) => path)], keep, promotable).doomed) {
			add("release", dir, "delete", "orphan release");
			const receipt = join(store, "prepared", `${basename(dir)}.json`);
			if (existsSync(receipt)) add("prepared receipt", receipt, "delete", "superseded: current changed since prepare");
		}
	}

	// Artefatos Agent: ativo (config e active.json) e alvo de rollback (artefato cujo piRoot está
	// em current/previous) nunca saem. Manifest ilegível = não dá para provar que está sem uso.
	const artifactsDir = join(store, agentStoreDir, "releases");
	const artifacts = directoryNames(artifactsDir);
	if (artifacts.length > 0 && !config) {
		for (const entry of artifacts) {
			const dir = join(artifactsDir, entry.name);
			if (!livePaths.has(resolvedPath(dir))) add("agent artifact", dir, "report", "runtime/config.json unreadable: cannot tell which artifact is active");
		}
	} else if (artifacts.length > 0) {
		const activeIds = new Set([config.artifactId, active?.agent?.artifactId].filter(Boolean));
		const previousRoot = linkTarget(join(store, "previous"));
		const inPrevious = (piRoot) => previousRoot !== undefined && typeof piRoot === "string" && resolvedPath(piRoot).startsWith(previousRoot);
		// Keep the exact recorded rollback pair, not just the newest artifact for that Pi.
		try {
			for (const [piRoot, id] of Object.entries(agentPairHistory(store))) {
				if (inPrevious(piRoot)) activeIds.add(typeof id === "object" ? id.artifactId : id);
			}
		} catch {
			// An unreadable index cannot prove any artifact unused.
			for (const entry of artifacts) activeIds.add(entry.name);
		}
		const unused = [];
		let rollbackTarget;
		for (const entry of artifacts) {
			const dir = join(artifactsDir, entry.name);
			if (livePaths.has(resolvedPath(dir))) continue;
			const manifestData = readJsonFile(join(dir, "manifest.json"));
			if (!manifestData) {
				add("agent artifact", dir, "report", "manifest unreadable: cannot tell whether it is in use");
				continue;
			}
			if (activeIds.has(entry.name) || livePaths.has(resolvedPath(dir))) continue;
			const candidate = { dir, mtimeMs: statSync(dir).mtimeMs };
			// Sem índice (stores antigos), mantenha também o artefato mais recente de `previous`.
			if (inPrevious(manifestData.piRoot) && (!rollbackTarget || candidate.mtimeMs > rollbackTarget.mtimeMs)) {
				if (rollbackTarget) unused.push(rollbackTarget);
				rollbackTarget = candidate;
			} else {
				unused.push(candidate);
			}
		}
		unused.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const item of unused.slice(keep)) add("agent artifact", item.dir, "delete", "unused artifact (not active, not the rollback target)");
	}

	// Recibos preparados cuja release já não existe: não há o que promover.
	const preparedDir = join(store, "prepared");
	if (existsSync(preparedDir)) {
		for (const name of readdirSync(preparedDir)) {
			if (!name.endsWith(".json")) continue;
			if (!linkExists(join(releasesDir, name.slice(0, -".json".length)))) add("prepared receipt", join(preparedDir, name), "delete", "its release no longer exists");
		}
	}

	// Backups: só os diretórios com o nome que o updater gera entram na retenção; o resto é só reportado.
	// Nunca saem: o backup de launcher (nome só com o carimbo; guarda o `pi` original movido, com
	// restore.txt) e o `*-agent-enable` mais antigo (única cópia de active.json/pi-wrapper pré-Agent).
	const backupsDir = join(store, "backups");
	const retention = [];
	let oldestEnable;
	for (const entry of directoryNames(backupsDir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const dir = join(backupsDir, entry.name);
		const match = updaterBackupName.exec(entry.name);
		if (!match) {
			add("backup", dir, "report", "not created by the updater; never deleted by gc");
		} else if (!match[1]) {
			add("backup", dir, "report", "original launcher backup (restore.txt); never deleted by gc");
		} else if (match[1] === "enable" && !oldestEnable) {
			oldestEnable = dir;
			add("backup", dir, "report", "oldest agent-enable backup (pre-Agent active.json/pi-wrapper); never deleted by gc");
		} else {
			retention.push({ dir, name: entry.name });
		}
	}
	retention.sort((a, b) => (a.name < b.name ? 1 : -1));
	for (const backup of retention.slice(backupRetention)) add("backup", backup.dir, "delete", `older than the ${backupRetention} most recent`);

	// O broker é copiado para o artefato, mas sessões antigas podem guardar AGENT_JUICE_BIN
	// no cache e invocá-lo só no próximo snapshot. Conserva também se qualquer Pi estiver vivo.
	const buildCache = join(store, agentStoreDir, "build-cache");
	if (existsSync(buildCache)) {
		const proc = using(buildCache) ?? processes?.find((proc) =>
			/agent-launch\.mjs|AGENT_JUICE_ENABLED=1|(?:coding-agent|pi-coding-agent)[/\\]dist[/\\]cli\.js|[/\\]bin[/\\]pi(?:\s|$)/.test(proc.command) ||
			processCandidates.some(({ dir }) => commandUsesPath(proc.command, dir) || commandUsesPath(proc.command, resolvedPath(dir))));
		add("agent build-cache", buildCache, proc || processes === undefined ? "report" : "delete",
			proc || processes === undefined ? reason(proc) : "obsolete native build cache (legacy releases only)");
	}

	// Só reportados: sem vínculo legível com o que está em uso, ou trabalho do usuário.
	const snapshots = join(store, agentStoreDir, "resource-snapshots");
	if (existsSync(snapshots)) add("agent resource-snapshots", snapshots, "report", "recovery copies of resource receipts; nothing records which are still needed");
	const candidates = join(store, "candidates");
	if (existsSync(candidates)) add("candidates", candidates, "report", "port workspaces are never deleted by gc; remove by hand when done");
	return items;
}

function overlayGc(options) {
	const { store, dryRun, keep } = options;
	const items = planOverlayGc(store, keep, { getProcesses: options.getProcesses });
	const root = `${resolvedPath(store)}${sep}`;
	const deletes = items.filter((item) => item.action === "delete");
	console.log(`${productDisplayName} overlay-gc${dryRun ? " (dry run: nothing is deleted)" : ""} — store ${store}, keep ${keep}`);
	for (const item of items) {
		console.log(`  ${item.action === "delete" ? (dryRun ? "would delete" : "delete") : "report only"}  ${item.path}  ${formatSize(item.size)}  [${item.kind}: ${item.note}]`);
	}
	const total = deletes.reduce((sum, item) => sum + item.size, 0);
	if (items.length === 0) console.log("  nothing to collect");
	if (dryRun) {
		console.log(`Would reclaim ${formatSize(total)} in ${deletes.length} item(s).`);
		return;
	}
	for (const item of deletes) {
		// Defesa em profundidade: o plano só produz caminhos do store, mas apagar fora dele é irreversível.
		if (!resolvedPath(resolve(item.path)).startsWith(root)) fail(`Refusing to delete ${item.path}: outside ${store}`);
		rmSync(item.path, { recursive: true, force: true });
	}
	console.log(`Reclaimed ${formatSize(total)} in ${deletes.length} item(s).`);
}

/** Rodado de dentro de uma sessão Agent antiga, tira do próprio ambiente o preload do Juice e a curadoria de skills. */
async function sanitizeUpdaterEnv(env = process.env) {
	try {
		const { userCommandEnv } = await import(pathToFileURL(join(repoRoot, "agent", "juice", "child-env.mjs")).href);
		const clean = userCommandEnv(env);
		for (const key of Object.keys(env)) if (!(key in clean)) delete env[key];
		for (const [key, value] of Object.entries(clean)) if (env[key] !== value) env[key] = value;
	} catch {}
}

/**
 * Aquece o cache de abertura: a primeira sessão depois de uma release nova transpila todas as
 * extensões TypeScript (jiti) e compila o JS do Node do zero — ~1,5 s contra ~0,5 s com cache. Um
 * `pi --offline --list-models` pelo launcher instalado carrega as mesmas extensões sem abrir a TUI
 * nem falar com provider, e deixa o cache pronto. Melhor esforço: falhar aqui não desfaz nada.
 * Só no store padrão (launcher adotado); `AGENT_WARM_START=0` desliga.
 */
function warmStartCache(options) {
	if (!options.adoptLauncher || process.env.AGENT_WARM_START === "0") return;
	const launcher = join(options.store, "bin", isWindows ? "pi-wrapper.cmd" : "pi-wrapper");
	if (!existsSync(launcher)) return;
	const started = Date.now();
	const result = spawnSync(launcher, ["--offline", "--list-models"], {
		cwd: homedir(), stdio: "ignore", timeout: 120_000, shell: isWindows, windowsHide: true,
	});
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (result.status === 0) console.log(`+ cache de abertura aquecido (${seconds}s)`);
	else console.warn(`cache de abertura não aquecido (${result.error?.code ?? `exit ${result.status}`}); a primeira sessão abre mais devagar`);
}

async function main() {
	await sanitizeUpdaterEnv();
	const options = parseArgs(process.argv.slice(2));
	// Somente leitura: não toma o lock, não exige geração do updater (só lê o que está no disco).
	if (options.status) return overlayStatus(options.store);
	if (options.gc && options.dryRun) return overlayGc(options);
	if (options.releaseTag !== undefined || options.releaseRepo !== undefined) {
		if (options.installArtifact === undefined || !/^[\w.+-]+$/.test(options.releaseTag ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(options.releaseRepo ?? "")) fail("Release identity requires an artifact, valid tag and repo");
	}
	if (options.installArtifact !== undefined && (options.installArtifact === "latest" || !existsSync(resolve(options.installArtifact)) || !lstatSync(resolve(options.installArtifact)).isDirectory())) {
		const temporary = mkdtempSync(join(tmpdir(), "agent-download-"));
		try {
			const remote = options.installArtifact === "latest" || !existsSync(resolve(options.installArtifact));
			const downloaded = remote ? downloadArtifact(temporary, options.installArtifact === "latest" ? process.env.AGENT_VERSION || "" : options.installArtifact) : undefined;
			const tag = downloaded?.tag ?? options.releaseTag;
			const repo = downloaded?.repo ?? options.releaseRepo;
			const status = bootstrap(downloaded?.archive ?? resolve(options.installArtifact), ["--store", options.store, ...(options.adoptLauncher ? ["--adopt-launcher"] : []), ...(tag ? ["--release-tag", tag, "--release-repo", repo] : [])]);
			if (status !== 0) fail(`Artifact bootstrap failed (${status})`);
			return;
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	}
	assertUpdaterGeneration(options.store, options.force);

	// `--check` constrói em tmp e não promove nada: não disputa o store, não toma o lock. O status do
	// Agent sai antes da construção, para ser legível mesmo quando o gate falha depois.
	if (options.check) {
		console.log(await agentStatusReport(options.store));
		return build(options, null);
	}

	const holder = options.agentEnable
		? "agent-update --agent-enable"
		: options.agentDisable
			? "agent-update --agent-disable"
			: options.gc
				? "agent-update --gc"
				: options.rollback
				? "agent-update --rollback"
				: "agent-update";
	const lock = acquireStoreLock(options.store, { holder });
	const releaseLock = () => lock.release();
	process.on("exit", releaseLock);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => {
			releaseLock();
			process.exit(130);
		});
	}
	try {
		// Fotografia de `current` ANTES da construção: a comparação no fim é contra este valor.
		if (options.installArtifact !== undefined) await installArtifact(options);
		else if (options.agentEnable) await agentEnable(options);
		else if (options.agentDisable) await agentDisable(options);
		else if (options.gc) await overlayGc(options);
		else if (options.promote !== undefined) await promote(options);
		else await build(options, readCurrentTarget(options.store));
	} finally {
		releaseLock();
	}
	// Só depois de ativar algo (não em --prepare, que deixa current intacto, nem em gc/disable).
	if (options.agentEnable || options.promote !== undefined || (!options.prepare && !options.gc && !options.agentDisable)) {
		warmStartCache(options);
	}
}

async function build(options, currentAtStart) {
	if (options.rollback) {
		await rollback(options.store, options);
		return;
	}

	const declared = overlayPatches();
	let stored = readStoreLayers(options.store);
	if (stored === undefined) {
		const seeded = seedLayersFromActive(options.store, declared);
		if (seeded) {
			stored = seeded.optional;
			console.warn(
				`${join(options.store, LAYERS_FILE)} não existe; semeando a seleção com as camadas opcionais que a ` +
					`release ativa registrou (${seeded.source}): ${seeded.optional.join(", ")}. ` +
					`Use --without ${seeded.optional[0]} para instalar sem ela.`,
			);
		}
	}
	if (stored?.some((name) => removedLayers[name])) {
		for (const name of stored.filter((item) => removedLayers[item])) console.warn(`${join(options.store, LAYERS_FILE)}: ${removedLayers[name]} Ignoring it.`);
		stored = stored.filter((name) => !removedLayers[name]);
	}
	const selection = selectLayers(declared, {
		with: options.with,
		without: options.without,
		stored,
	});
	for (const warning of selection.warnings) console.warn(warning);
	const patches = selection.selected;
	console.log(
		`${productDisplayName} layers: base ${selection.base.join(", ")}; optional ${
			selection.optional.length > 0 ? selection.optional.join(", ") : "none"
		} (available: ${selection.available.length > 0 ? selection.available.join(", ") : "none"})`,
	);
	for (const patch of patches) verifyOverlayPatch(patch);
	const overlayFp = overlayFingerprint(patches);
	if (options.simulateConflict) fail("Simulated overlay conflict; active release was not changed");

	// Default: a release oficial que a casa portou e testou (`manifest.overlayRef`). `--ref latest`
	// pega a última do npm, que pode ainda não aceitar os patches.
	const refFromManifest = options.ref === "release" && Boolean(manifest.overlayRef);
	const targetRef =
		options.ref === "latest" || (options.ref === "release" && !manifest.overlayRef)
			? latestReleaseRef()
			: options.ref === "release"
				? manifest.overlayRef
				: options.ref;
	const stageRoot = mkdtempSync(join(tmpdir(), "agent-update-"));
	const sourceDir = join(stageRoot, "source");
	// O staging dentro do store (`releases/.staging-<pid>`) é desta tentativa e de mais ninguém: só ele
	// é removido no catch, e só pelo caminho que esta execução criou. Varrer `.staging-*` por prefixo
	// apagaria o staging vivo de outro updater (outro store compartilhado, outro pid).
	let ownStaging;
	// A partir daqui a release nova está valendo: qualquer falha posterior (seleção, coleta) não pode
	// ser relatada como "active pi was not changed".
	let activated = false;
	try {
		run("git", ["clone", "--filter=blob:none", "--no-checkout", manifest.officialRepository, sourceDir]);
		// O clone é `--no-checkout`, então dá tempo de desligar a conversão de fim de linha antes de a árvore
		// existir. Com o `core.autocrlf=true` que o Git for Windows instala por padrão, o checkout viria
		// em CRLF: os patches não aplicariam e a árvore instalada teria outro digest em cada plataforma.
		run("git", ["-C", sourceDir, "config", "core.autocrlf", "false"]);
		run("git", ["-C", sourceDir, "config", "core.eol", "lf"]);
		run("git", ["-C", sourceDir, "fetch", "--force", "--tags", "origin"]);
		run("git", ["-C", sourceDir, "checkout", "--detach", targetRef]);
		const officialCommit = run("git", ["-C", sourceDir, "rev-parse", "HEAD"], { capture: true });
		// Uma tag do upstream pode ser movida depois de publicada, e `v0.87.1` deixaria de ser o commit
		// que a casa portou e testou sem que nada no checkout mudasse. Quando o ref veio do manifesto
		// (default, sem `--ref`), o commit exigido é o que o port registrou em `overlayBase`.
		if (refFromManifest) {
			if (!manifest.overlayBase) {
				fail(
					`Overlay manifest declares overlayRef ${manifest.overlayRef} but no overlayBase; ` +
						`re-run \`node scripts/port.mjs export\` so the tested commit is pinned, or pass --ref explicitly.`,
				);
			}
			if (officialCommit !== manifest.overlayBase) {
				fail(
					`Official tag ${targetRef} now points at ${officialCommit}, but this overlay was ported and tested ` +
						`against ${manifest.overlayBase} (overlay/manifest.json:overlayBase). The upstream tag was moved. ` +
						`Re-port with \`node scripts/port.mjs start --ref ${targetRef}\` (which re-pins overlayBase), or pass ` +
						`--ref ${targetRef} explicitly to build the moved tag on purpose. The active pi was not changed.`,
				);
			}
		}
		const officialRemote = run("git", ["-C", sourceDir, "remote", "get-url", "origin"], { capture: true });
		if (officialRemote !== manifest.officialRepository) fail(`Unexpected official remote: ${officialRemote}`);
		verifyOfficialIdentity(sourceDir);

		for (const patch of patches) applyOverlayPatch(sourceDir, patch);
		const { pkg, layout } = verifyOfficialIdentity(sourceDir);
		run("npm", ["ci", "--ignore-scripts"], { cwd: sourceDir });
		const vendoredData = options.hydrate ? undefined : vendoredModelData(pkg.version);
		if (vendoredData) {
			installVendoredModelData(sourceDir, vendoredData);
			run("npm", ["-w", "packages/ai", "run", "check:model-data"], { cwd: sourceDir });
		} else {
			run("npm", ["-w", "packages/ai", "run", "hydrate-model-data"], { cwd: sourceDir });
		}
		run("npm", ["run", "check"], { cwd: sourceDir });
		// The default build regenerates the catalog from the network, which would overwrite the
		// snapshot (and the provider shards pinned by this tag) mid-build; build:offline is upstream's
		// path for a dataset that is already present and validated.
		run("npm", ["run", vendoredData ? "build:offline" : "build"], { cwd: sourceDir });

		const overlayTests = [];
		for (const patch of patches) {
			const missing = patch.tests.filter((file) => !existsSync(join(sourceDir, file)));
			if (missing.length > 0) {
				fail(
					`Overlay patch "${patch.name}" no longer installs its own gate: ${missing.join(", ")}. ` +
						`Port the patch and its tests to this release before updating.`,
				);
			}
			overlayTests.push(...patch.tests);
		}
		// Testes upstream instáveis só nesta plataforma (manifest.platformSkippedTests): saem pelo nome.
		const skipped = (manifest.platformSkippedTests?.[process.platform] ?? []).map((entry) => entry.name);
		const skipArgs = skipped.length
			? ["-t", `^(?!.*(?:${skipped.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})).*$`]
			: [];
		for (const name of skipped) console.log(`(pulando no ${process.platform}: ${name})`);
		// Hermético: PI_*/MARK_* e NODE_OPTIONS de quem chama (ex.: PI_CACHE_RETENTION, PI_AUTOMATIC_SKILLS de
		// uma sessão de agente) mudam o resultado dos testes upstream. `undefined` remove a chave no spawn.
		const inherited = Object.keys(process.env).filter((key) => /^(PI_|MARK_)/.test(key) || key === "NODE_OPTIONS");
		run("node", [join(sourceDir, "node_modules", "vitest", "dist", "cli.js"), "--run", ...skipArgs, ...overlayTests], {
			cwd: sourceDir,
			env: Object.fromEntries(inherited.map((key) => [key, undefined])),
		});

		const internalVersions = pinInternalPackages(sourceDir, manifest.officialPackage);
		const artifacts = join(stageRoot, "artifacts");
		mkdirSync(artifacts, { recursive: true });
		run("npm", ["pack", "--workspace", "packages/coding-agent", "--pack-destination", artifacts], {
			cwd: sourceDir,
		});
		const packed = readdirSync(artifacts)
			.filter((name) => name.endsWith(".tgz"))
			.map((name) => join(artifacts, name));
		if (packed.length !== 1) fail(`Expected one package tarball, found ${packed.length}`);
		const packedFiles = run(tarCommand(), ["-tzf", packed[0]], { capture: true }).split(/\r?\n/).map((entry) => entry.trim().replaceAll("\\", "/")).filter(Boolean);
		const packedEntrypoint = `package/${pkg.bin.pi}`;
		if (!packedFiles.includes(packedEntrypoint)) {
			fail(`Packed package is missing the official pi entrypoint ${packedEntrypoint}`);
		}
		for (const required of layout.packedFiles ?? []) {
			if (!packedFiles.includes(required)) {
				fail(`Packed package is missing ${required}, which the "${layout.name}" layout depends on`);
			}
		}

		const metadata = {
			installedAt: new Date().toISOString(),
			officialRef: targetRef,
			officialCommit,
			officialVersion: pkg.version,
			overlayFingerprint: overlayFp,
			patches: Object.fromEntries(patches.map((patch) => [patch.name, patch.sha256])),
			optionalLayers: selection.optional,
			...checkoutSource(),
		};
		if (options.check) {
			if (options.vendorModelData) vendorModelData(sourceDir, pkg.version);
			console.log(`${productDisplayName} compatibility check passed: ${JSON.stringify(metadata)}`);
			rmSync(stageRoot, { recursive: true, force: true });
			return;
		}

		const releasesDir = join(options.store, "releases");
		const installDir = join(releasesDir, `.staging-${process.pid}`);
		ownStaging = installDir;
		mkdirSync(releasesDir, { recursive: true });
		if (options.prepare && (lstatSync(releasesDir).isSymbolicLink() || realpathSync(releasesDir) !== join(realpathSync(options.store), "releases"))) {
			fail("Unsafe releases directory");
		}
		rmSync(installDir, { recursive: true, force: true });
		run("npm", ["install", "--global", "--prefix", installDir, "--ignore-scripts", packed[0]]);
		const installedPi = releaseBinary(installDir);
		if (!existsSync(installedPi)) {
			fail(`Installed pi entrypoint is missing; looked for ${releaseBinaryCandidates(installDir).join(", ")}`);
		}
		applyReleaseOverlays(sourceDir, installDir, stageRoot);
		verifyInstalledInternalPackages(installDir, manifest.officialPackage, internalVersions, run);
		run(installedPi, ["--version"]);
		metadata.treeDigest = digestTree(installDir);
		metadata.digestAlgorithm = digestAlgorithm;
		writeFileSync(join(installDir, releaseMetadataFile), `${JSON.stringify(metadata, null, 2)}\n`);

		const releaseId = [
			pkg.version,
			officialCommit.slice(0, 10),
			overlayFp.slice(0, 10),
			metadata.treeDigest.slice(0, 10),
		].join("-");
		const expected = {
			...metadata,
			digestUnder: (algorithm) =>
				supportedDigestAlgorithms.has(algorithm) ? digestTree(installDir, algorithm) : undefined,
		};
		let releaseDir;
		for (const candidate of options.prepare ? [] : releaseCandidates(releasesDir, releaseId, linkTarget(join(options.store, "current")))) {
			const report = verifyRelease(candidate, expected);
			if (report.problems.length === 0) {
				for (const warning of report.warnings) console.warn(`  - ${warning}`);
				rmSync(installDir, { recursive: true, force: true });
				releaseDir = candidate;
				console.log(
					`Release ${basename(candidate)} on disk is identical to this build (treeDigest ${metadata.treeDigest.slice(0, 12)}); kept it`,
				);
				break;
			}
			console.warn(`${basename(candidate)} does not hold this build and was left untouched:`);
			for (const problem of report.problems) console.warn(`  - ${problem}`);
		}
		if (!releaseDir) {
			releaseDir = allocateReleaseDir(releasesDir, releaseId);
			renameSync(installDir, releaseDir);
		}
		if (options.prepare) {
			writePrepared(options.store, releaseDir, metadata, currentAtStart, {
				repository: officialRemote, requestedRef: options.ref, refFromManifest,
				entrypoint: pkg.bin.pi, layout: layout.name,
			});
			console.log(`${productDisplayName}: prepared ${basename(releaseDir)} at ${releaseDir}; current unchanged. External package E2E not executed.`);
			rmSync(stageRoot, { recursive: true, force: true });
			return;
		}
		// Entre o início da construção e agora se passaram muitos minutos. Se `current` mudou
		// nesse intervalo, ativar aqui apagaria silenciosamente a release de outra pessoa.
		if (!options.check) assertCurrentUnchanged(options.store, currentAtStart, { force: options.force });
		const launcher = await activateRelease(options.store, releaseDir, options.adoptLauncher);
		activated = true;
		// A seleção só é registrada depois de uma instalação real bem-sucedida: um gate que falhou
		// não pode mudar o que o próximo `pi overlay-update` sem flags vai instalar.
		writeStoreLayers(options.store, selection.optional);
		if (options.noPrune) {
			console.log("Preserving all existing releases and overlay bundles (--no-prune)");
		} else {
			// A release que a config do Agent registra como `piRoot` está em uso mesmo quando não é
			// `current`/`previous` (opt-out guardado, par preparado): coletar ela quebraria o artefato.
			const agentPiRoot = (await readAgentState(options.store))?.config?.piRoot;
			collectOrphanReleases(options.store, releaseDir, agentPiRoot ? [agentPiRoot] : []);
			collectOverlayBundles(options.store, [launcher.overlayRepo, repoRoot]);
		}
		console.log(
			`${productDisplayName}: activated official Pi ${pkg.version} + overlay at ${releaseDir} (layers: ${patches.map((patch) => patch.name).join(", ")}; recorded in ${join(options.store, LAYERS_FILE)})`,
		);
		rmSync(stageRoot, { recursive: true, force: true });
	} catch (error) {
		// `stageRoot` (fora do store) continua preservado para diagnóstico; o staging dentro do store é
		// descartado, porque nada o coleta depois e ele é meia instalação npm.
		if (ownStaging) discardOwnStaging(ownStaging);
		if (error?.activationState === "partial" || (activated && !error?.activationState)) {
			console.error(
				`Update stopped AFTER the new runtime was activated: this is a partial activation, not an unchanged ` +
					`install. Staging preserved at ${stageRoot}`,
			);
		} else if (error?.activationState === "unknown") {
			console.error(
				`Update failed during activation and the store pointers could not be restored; the active pi may have ` +
					`changed. Inspect ${options.store}. Staging preserved at ${stageRoot}`,
			);
		} else {
			console.error(`Update failed safely; active pi was not changed. Staging preserved at ${stageRoot}`);
		}
		throw error;
	}
}

/** Remove só o staging que esta execução criou, sob o lock do store; nunca por prefixo. */
function discardOwnStaging(installDir) {
	if (basename(installDir) !== `.staging-${process.pid}`) {
		console.warn(`Refusing to remove ${installDir}: it is not this process's staging directory`);
		return false;
	}
	if (!linkExists(installDir)) return false;
	try {
		rmSync(installDir, { recursive: true, force: true });
		console.error(`Discarded this attempt's staging directory ${installDir}`);
		return true;
	} catch (error) {
		console.error(`Could not remove the staging directory ${installDir}: ${error.message}`);
		return false;
	}
}

export { overlayStatus, overlayGc, planOverlayGc, parseArgs, digestTree, writePrepared, collectOrphanReleases, allocateReleaseDir, discardOwnStaging, agentStatusReport, installOverlayBundle, requireVerified, verifyRelease, assertContainedTree };

if (process.argv[1] && resolvedPath(resolve(process.argv[1])) === resolvedPath(fileURLToPath(import.meta.url))) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
