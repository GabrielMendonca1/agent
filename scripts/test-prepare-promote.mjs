#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireStoreLock, readCurrentTarget } from "./lib/store-lock.mjs";
import { staleAhead } from "./lib/overlay-stale.mjs";

const root = mkdtempSync(join(tmpdir(), "prepare-promote-test-"));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "fixture");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
async function atest(name, fn) { await fn(); checks++; console.log(`ok ${name}`); }
try {
	mkdirSync(join(fixture, "scripts"), { recursive: true });
	mkdirSync(join(fixture, "overlay"));
	for (const name of ["agent-update.mjs", "agent-wrapper.sh", "agent-wrapper.cmd"]) {
		copyFileSync(join(repo, "scripts", name), join(fixture, "scripts", name));
	}
	cpSync(join(repo, "scripts", "lib"), join(fixture, "scripts", "lib"), { recursive: true });
	writeFileSync(join(fixture, "overlay", "README.md"), "fixture");
	// Stubs dos helpers do Agent (contratos A e B), escritos DEPOIS da cópia de scripts/lib para
	// substituir os reais: estes testes exercitam a transação do updater offline, nunca a compilação
	// do runtime nem o registro de recursos nos hosts reais. `AGENT_TEST_FAIL` injeta as falhas.
	writeFileSync(join(fixture, "scripts", "agent-launch.mjs"), "#!/usr/bin/env node\n// fixture launcher\n", { mode: 0o755 });
	writeFileSync(join(fixture, "scripts", "lib", "agent-runtime.mjs"), `import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
const fault = () => process.env.AGENT_TEST_FAIL ?? "";
const configFile = (store) => join(store, "runtime", "config.json");
// O host clássico da fixture é o próprio cli.js do pacote instalado (sem dist/bundle).
export const PI_ENTRY = "cli.js";
export const AGENT_SUBDIR = "agent";
export function prepareAgentArtifact({ sourceRoot, store, piRoot }) {
	if (fault() === "prepare") throw new Error("stub: artifact preparation failed");
	if (!sourceRoot || !store || !piRoot) throw new Error("stub: missing argument");
	if (!existsSync(join(resolve(piRoot), PI_ENTRY))) throw new Error("stub: piRoot has no classic host");
	const artifactId = createHash("sha256").update(resolve(piRoot)).update(existsSync(join(sourceRoot, "agent-input")) ? readFileSync(join(sourceRoot, "agent-input")) : "").digest("hex");
	const artifactRoot = join(store, "runtime", "releases", artifactId);
	mkdirSync(join(artifactRoot, "agent"), { recursive: true });
	writeFileSync(join(artifactRoot, "agent", "extension.txt"), "agent ii resource\\n");
	// Árvore mínima que o helper REAL de recursos reconhece (agent/extensions/agent/<nome>/index.ts).
	const demo = join(artifactRoot, "agent", "extensions", "agent", "agent-demo");
	mkdirSync(demo, { recursive: true });
	writeFileSync(join(demo, "index.ts"), \`// agent ii demo extension of \${artifactId}\\n\`);
	if (existsSync(join(sourceRoot, "agent-input")) && readFileSync(join(sourceRoot, "agent-input"), "utf8") === "with-ipython") {
		const ipython = join(artifactRoot, "agent", "extensions", "agent", "ipython");
		mkdirSync(ipython, { recursive: true });
		writeFileSync(join(ipython, "index.ts"), "// old ipython extension\\n");
	}
	const manifestPath = join(artifactRoot, "manifest.json");
	writeFileSync(manifestPath, JSON.stringify({ artifactId, piRoot: resolve(piRoot), platform: process.platform }, null, 2));
	return { artifactId, artifactRoot, piRoot: resolve(piRoot), manifestPath };
}
export function validateAgentArtifact({ store, artifactId, piRoot }) {
	if (fault() === "validate") throw new Error("stub: artifact validation failed");
	const artifactRoot = join(store, "runtime", "releases", String(artifactId));
	const manifestPath = join(artifactRoot, "manifest.json");
	if (!existsSync(manifestPath)) throw new Error(\`stub: artifact \${artifactId} is absent\`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (piRoot && manifest.piRoot !== resolve(piRoot)) throw new Error("stub: artifact piRoot mismatch");
	return { artifactId: manifest.artifactId, artifactRoot, agentRoot: join(artifactRoot, "agent"), piRoot: manifest.piRoot, manifestPath, manifest };
}
export function readAgentConfig(store) {
	const file = configFile(store);
	if (!existsSync(file)) return null;
	const config = JSON.parse(readFileSync(file, "utf8"));
	if (config.version !== 1) throw new Error("stub: unsupported config version");
	return config;
}
export function writeAgentConfig({ store, config }) {
	if (fault() === "config") throw new Error("stub: config write failed");
	const file = configFile(store);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(\`\${file}.tmp\`, \`\${JSON.stringify(config, null, 2)}\\n\`);
	renameSync(\`\${file}.tmp\`, file);
	return { file };
}
export function buildAgentLaunch() { throw new Error("stub: the updater must not build a launch spec"); }
`);
	// O stub registra o CAMINHO do artefato em `settings.extensions` (como o helper real), para que os
	// testes olhem o path EFETIVO e não só `enabled`/`artifactId`. Com `AGENT_REAL_RESOURCES` ele
	// delega ao helper real do B: a transação do updater é exercitada contra a semântica de verdade.
	writeFileSync(join(fixture, "scripts", "lib", "agent-resources.mjs"), `import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const real = process.env.AGENT_REAL_RESOURCES ? await import(pathToFileURL(process.env.AGENT_REAL_RESOURCES).href) : null;
const fault = () => process.env.AGENT_TEST_FAIL ?? "";
export const PLAN_VERSION = real?.PLAN_VERSION ?? 1;
export const RECEIPT_NAME = real?.RECEIPT_NAME ?? "agent-resources-receipt.json";
const settingsFile = (agentDir) => join(agentDir, "settings.json");
const readSettings = (agentDir) => (existsSync(settingsFile(agentDir)) ? JSON.parse(readFileSync(settingsFile(agentDir), "utf8")) : {});
function writeSettings(agentDir, settings) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsFile(agentDir), \`\${JSON.stringify(settings, null, 2)}\\n\`);
}
const entryOf = (agentRoot) => join(agentRoot, "extensions", "agent", "agent-demo", "index.ts");
export function planAgentResources({ agentRoot, agentDir, homeDir }) {
	if (!agentRoot || !agentDir || !homeDir) throw new Error("stub: missing argument");
	if (!existsSync(agentRoot)) throw new Error("stub: agentRoot is absent");
	if (real) return real.planAgentResources({ agentRoot, agentDir, homeDir });
	return { version: PLAN_VERSION, agentRoot, agentDir, homeDir, report: { extensions: [entryOf(agentRoot)], blocking: [], limitations: [] } };
}
export function applyAgentResources({ plan, backupDir }) {
	if (plan?.version !== PLAN_VERSION) throw new Error("stub: plan of another version");
	mkdirSync(backupDir, { recursive: true });
	if (fault() === "apply") throw new Error("stub: resource apply failed before writing anything");
	if (real) {
		const applied = real.applyAgentResources({ plan, backupDir });
		if (fault() === "no-receipt") return { report: {} };
		return applied;
	}
	const registry = join(plan.agentDir, "agent-registry.json");
	mkdirSync(plan.agentDir, { recursive: true });
	writeFileSync(registry, JSON.stringify({ agentRoot: plan.agentRoot }, null, 2));
	// Registro efetivo: o caminho do artefato entra em settings.extensions, preservando o pessoal.
	const settings = readSettings(plan.agentDir);
	const before = "extensions" in settings ? settings.extensions : null;
	const entry = entryOf(plan.agentRoot);
	settings.extensions = [...(before ?? []), ...((before ?? []).includes(entry) ? [] : [entry])];
	writeSettings(plan.agentDir, settings);
	const receiptPath = join(backupDir, RECEIPT_NAME);
	writeFileSync(receiptPath, JSON.stringify({ registry, agentDir: plan.agentDir, agentRoot: plan.agentRoot, entry, before }, null, 2));
	// Falha depois do recibo: o updater tem de achar o recibo pelo backupDir estável e desfazer.
	if (fault() === "apply-partial") throw new Error("stub: resource apply failed after writing the registry");
	if (fault() === "no-receipt") return { report: {} };
	return { receiptPath, report: { registry, entry } };
}
export function rollbackAgentResources({ receiptPath }) {
	if (fault() === "rollback") throw new Error("stub: resource rollback failed");
	if (real) return real.rollbackAgentResources({ receiptPath });
	if (!existsSync(receiptPath)) return { removed: [], conflicts: [], report: { removed: 0 } };
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	// Conflito: o helper devolve sucesso parcial e o updater tem de tratar como erro.
	if (fault() === "conflict") return { removed: [], conflicts: [{ key: "extensions", reason: "stub: later personal change preserved" }], report: {} };
	const settings = readSettings(receipt.agentDir);
	if (receipt.before === null) delete settings.extensions;
	else settings.extensions = receipt.before;
	writeSettings(receipt.agentDir, settings);
	rmSync(receipt.registry, { force: true });
	return { removed: [receipt.registry], conflicts: [], report: { removed: 1 } };
}
`);
	const patches = ["base", "optional"].map((name) => {
		writeFileSync(join(fixture, "overlay", `${name}.patch`), name);
		return { name, path: `overlay/${name}.patch`, sha256: hash(name), tests: ["fixture.test.ts"], optional: name === "optional" };
	});
	const manifest = {
		name: "agent", agent: "II",
		officialPackage: "fixture-pi", officialRepository: "https://example.invalid/pi", overlayRef: "v1.0.0", overlayBase: "a".repeat(40), patches,
		compatibility: { forbiddenOverlayMarkers: [], upstreamLayouts: [{ name: "fixture", binPi: "cli.js" }], bundleMarkers: [{ name: "base", path: "cli.js", marker: "BASE", patch: "base" }, { name: "optional", path: "cli.js", marker: "OPTIONAL", patch: "optional" }] },
	};
	json(join(fixture, "overlay", "manifest.json"), manifest);
	const script = join(fixture, "scripts", "agent-update.mjs");
	const api = await import(pathToFileURL(script));
	const sentinel = join(root, "executed");
	const forbidden = join(root, "forbidden");
	const stubs = join(root, "stubs"); mkdirSync(stubs);
	for (const command of ["npm", "git", "npx"]) {
		const body = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'forbidden'); process.exit(91);\n`;
		writeFileSync(join(stubs, command), body, { mode: 0o755 });
		writeFileSync(join(stubs, `${command}.cmd`), `@echo forbidden > "${forbidden}"\r\n@exit /b 91\r\n`);
	}
	const env = { ...process.env, PATH: `${stubs}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, PREPARE_TEST_SENTINEL: sentinel };
	function cli(store, args, ok = true) {
		const result = spawnSync(process.execPath, [script, "--store", store, ...args], { encoding: "utf8", env });
		assert.equal(result.status === 0, ok, result.stdout + result.stderr);
		assert.equal(existsSync(forbidden), false, "promotion invoked a build command");
		return result;
	}
	function make(optional = false) {
		const store = realpathSync(mkdtempSync(join(root, "store-")));
		const id = "1.0.0-prepared";
		const release = join(store, "releases", id);
		const pkg = join(release, "lib", "node_modules", "fixture-pi");
		mkdirSync(pkg, { recursive: true }); mkdirSync(join(release, "bin"));
		const body = `#!${process.execPath}\n// BASE ${optional ? "OPTIONAL" : ""}\nif(process.env.PREPARE_TEST_SENTINEL) require('node:fs').writeFileSync(process.env.PREPARE_TEST_SENTINEL,'ran'); console.log('1.0.0');\n`;
		writeFileSync(join(pkg, "cli.js"), body, { mode: 0o755 });
		json(join(pkg, "package.json"), { name: "fixture-pi", version: "1.0.0", bin: { pi: "cli.js" } });
		if (process.platform === "win32") writeFileSync(join(release, "pi.cmd"), `@"${process.execPath}" "%~dp0lib\\node_modules\\fixture-pi\\cli.js" %*\r\n`);
		else symlinkSync("../lib/node_modules/fixture-pi/cli.js", join(release, "bin", "pi"));
		const selected = patches.filter((p) => !p.optional || optional);
		const fp = createHash("sha256").update(readFileSync(join(fixture, "overlay", "manifest.json")));
		for (const p of selected) fp.update(readFileSync(join(fixture, p.path)));
		const metadata = { installedAt: new Date().toISOString(), officialRef: manifest.overlayRef, officialCommit: manifest.overlayBase, officialVersion: "1.0.0", overlayFingerprint: fp.digest("hex"), patches: Object.fromEntries(selected.map((p) => [p.name, p.sha256])), optionalLayers: optional ? ["optional"] : [], treeDigest: api.digestTree(release), digestAlgorithm: 3 };
		json(join(release, "agent-release.json"), metadata);
		api.writePrepared(store, release, metadata, null, { repository: manifest.officialRepository, requestedRef: "release", refFromManifest: true, layout: "fixture", entrypoint: "cli.js" });
		return { store, id, release, pkg, metadata, receipt: join(store, "prepared", `${id}.json`) };
	}
	function rejected(f, args = ["--promote", f.id, "--force"]) {
		rmSync(sentinel, { force: true });
		const before = ["current", "previous", "active.json", "layers.json"].map((name) => existsSync(join(f.store, name)) ? realpathSync(join(f.store, name)) + (name.endsWith("json") ? readFileSync(join(f.store, name)) : "") : null);
		cli(f.store, args, false);
		assert.equal(existsSync(sentinel), false, "invalid candidate executed");
		assert.deepEqual(["current", "previous", "active.json", "layers.json"].map((name) => existsSync(join(f.store, name)) ? realpathSync(join(f.store, name)) + (name.endsWith("json") ? readFileSync(join(f.store, name)) : "") : null), before);
	}
	test("prepare finalization never activates or writes selection/launchers", () => {
		const f = make();
		for (const name of ["current", "previous", "active.json", "layers.json", "bin"]) assert.equal(existsSync(join(f.store, name)), false);
		assert.equal(load(f.receipt).metadata.treeDigest, api.digestTree(f.release));
		assert.throws(() => api.writePrepared(f.store, f.release, { ...f.metadata, officialRef: "wrong" }, null, {}), /metadata/);
	});
	test("promote exact directory, optional selection from receipt, bundled imports, strict retry, rollback", () => {
		const f = make(true);
		json(join(f.store, "layers.json"), { optional: [] });
		const promoted = cli(f.store, ["--promote", f.id]);
		assert.match(promoted.stdout, /agent Agent: promoted prepared release/);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.equal(api.digestTree(f.release), f.metadata.treeDigest);
		assert.deepEqual(load(join(f.store, "layers.json")).optional, ["optional"]);
		rejected(f, ["--promote", f.id]); // snapshot was null: repeat requires explicit force
		cli(f.store, ["--promote", f.id, "--force"]);
		const bundle = load(join(f.store, "active.json")).overlayRepo;
		const result = spawnSync(process.execPath, [join(bundle, "scripts", "agent-update.mjs"), "--store", f.store, "--promote", f.id, "--force"], { env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const next = make(false);
		cpSync(next.release, join(f.store, "releases", "next"), { recursive: true, verbatimSymlinks: true });
		// Capture the real link target like prepare does; Windows junctions can use extended-length paths.
		api.writePrepared(f.store, join(f.store, "releases", "next"), next.metadata, readCurrentTarget(f.store), load(next.receipt).provenance);
		cli(f.store, ["--promote", "next"]);
		assert.equal(realpathSync(join(f.store, "previous")), f.release);
		cli(f.store, ["--rollback"]);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.deepEqual(load(join(f.store, "layers.json")).optional, ["optional"]);
	});
	for (const field of ["officialRef", "officialCommit", "officialVersion", "overlayFingerprint", "optionalLayers", "patches", "treeDigest", "installedAt", "extra"]) {
		test(`metadata tamper ${field} fails before execution, even force`, () => {
			const f = make(); const m = load(join(f.release, "agent-release.json")); m[field] = "tampered"; json(join(f.release, "agent-release.json"), m); rejected(f);
		});
	}
	test("raw content and receipt corruption fail before execution", () => {
		const f = make(); writeFileSync(join(f.pkg, "cli.js"), "throw Error('tampered')"); rejected(f);
		const g = make(); json(g.receipt, { ...load(g.receipt), schemaVersion: 999 }); rejected(g);
		const h = make(); const r = load(h.receipt); r.selection = ["optional"]; json(h.receipt, r); rejected(h);
		const i = make(); const q = load(i.receipt); q.provenance.repository = "wrong"; json(i.receipt, q); rejected(i);
	});
	test("receipt missing, foreign store, platform and entrypoint rejected", () => {
		const missing = make(); rmSync(missing.receipt); rejected(missing);
		for (const field of ["store", "platform", "nodeVersion", "manifestSha256"]) {
			const f = make(); const r = load(f.receipt); r[field] = "incompatible"; json(f.receipt, r); rejected(f);
		}
		const f = make(); const r = load(f.receipt); r.provenance.entrypoint = "wrong.js"; json(f.receipt, r); rejected(f);
		const alias = make(); const original = alias.receipt + ".original"; copyFileSync(alias.receipt, original); rmSync(alias.receipt);
		// A directory junction covers Windows without requiring symlink privileges.
		if (process.platform !== "win32") {
			symlinkSync(original, alias.receipt); rejected(alias);
		}
	});
	test("markers fail before execution even with updated raw hash", () => {
		const f = make(true); const path = join(f.pkg, "cli.js"); writeFileSync(path, readFileSync(path, "utf8").replace("OPTIONAL", "ABSENT"));
		const m = load(join(f.release, "agent-release.json")); m.treeDigest = api.digestTree(f.release); json(join(f.release, "agent-release.json"), m);
		const r = load(f.receipt); r.metadata = m; r.metadataSha256 = hash(readFileSync(join(f.release, "agent-release.json"))); r.exactTreeDigest = api.digestTree(f.release, 0); json(f.receipt, r); rejected(f);
	});
	test("IDs, release symlinks and escaping internal links rejected", () => {
		const f = make();
		for (const id of ["../x", "/tmp/x", "a/b", "a\\b", "..", ""]) rejected(f, ["--promote", id]);
		symlinkSync(f.release, join(f.store, "releases", "alias"), process.platform === "win32" ? "junction" : "dir"); rejected(f, ["--promote", "alias"]);
		symlinkSync(root, join(f.release, "escape"), process.platform === "win32" ? "junction" : "dir"); rejected(f);
	});
	test("lock, stale CAS and retry after releasing lock", () => {
		const f = make(); const lock = acquireStoreLock(f.store);
		rejected(f, ["--promote", f.id]); lock.release();
		cli(f.store, ["--promote", f.id]);
		rejected(f, ["--promote", f.id]);
	});
	test("Finder metadata does not invalidate payload; changed payload modes do", () => {
		const f = make(); writeFileSync(join(f.release, ".DS_Store"), "OS metadata");
		assert.equal(api.digestTree(f.release, 0), load(f.receipt).exactTreeDigest);
		cli(f.store, ["--promote", f.id]);
		if (process.platform !== "win32") {
			const g = make(); chmodSync(join(g.pkg, "cli.js"), 0o644); rejected(g);
		}
	});
	test("orphaned receipts and broken symlinks reserve their release IDs", () => {
		const f = make(); rmSync(f.release, { recursive: true });
		assert.equal(api.allocateReleaseDir(join(f.store, "releases"), f.id), f.release + "+2");
		if (process.platform !== "win32") {
			symlinkSync(join(root, "missing"), f.release + "+2");
			assert.equal(api.allocateReleaseDir(join(f.store, "releases"), f.id), f.release + "+3");
		}
	});
	test("new updater pruning retains prepared test runtimes", () => {
		const f = make();
		for (let i = 0; i < 6; i++) mkdirSync(join(f.store, "releases", `orphan-${i}`));
		api.collectOrphanReleases(f.store, null);
		assert.ok(existsSync(f.release));
	});
	test("incompatible modes and build/selection flags rejected", () => {
		for (const mode of ["--promote"]) for (const flag of ["--ref", "--with", "--without", "--hydrate", "--simulate-conflict", "--vendor-model-data"]) {
			assert.throws(() => api.parseArgs([mode, ...(mode === "--promote" ? ["valid"] : []), flag, ...(["--ref", "--with", "--without"].includes(flag) ? ["x"] : [])]));
		}
		for (const args of [["--prepare", "--check"], ["--prepare", "--rollback"], ["--prepare", "--force"], ["--prepare", "--no-prune"], ["--prepare", "--adopt-launcher"], ["--promote"]]) assert.throws(() => api.parseArgs(args));
	});
	if (process.platform !== "win32") test("symlinked CLI executes with preserve-symlinks-main", () => {
		const f = make();
		const alias = join(fixture, "scripts", "updater-alias.mjs");
		symlinkSync(script, alias);
		const result = spawnSync(process.execPath, ["--preserve-symlinks-main", alias, "--store", f.store, "--promote", f.id], { env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
	});
	test("legacy check and rollback flags remain accepted", () => {
		for (const args of [
			["--check", "--no-prune"], ["--check", "--force"], ["--check", "--adopt-launcher"],
			["--rollback", "--no-prune"], ["--rollback", "--adopt-launcher"],
			["--rollback", "--ref", "v1.0.0"], ["--rollback", "--with", "optional"],
		]) assert.doesNotThrow(() => api.parseArgs(args));
	});
	function prepareSibling(f, id) {
		const next = make(false);
		const dir = join(f.store, "releases", id);
		cpSync(next.release, dir, { recursive: true, verbatimSymlinks: true });
		api.writePrepared(f.store, dir, next.metadata, readCurrentTarget(f.store), load(next.receipt).provenance);
		return dir;
	}
	test("active.json of the wrong type is refused before any pointer moves", () => {
		const f = make();
		mkdirSync(join(f.store, "active.json", "not-a-file"), { recursive: true });
		const result = cli(f.store, ["--promote", f.id], false);
		const output = result.stdout + result.stderr;
		assert.match(output, /active\.json is not a regular file/);
		assert.match(output, /active pi was not changed/);
		assert.equal(existsSync(join(f.store, "current")), false);
		assert.equal(existsSync(join(f.store, "previous")), false);
		assert.equal(existsSync(join(f.store, "layers.json")), false);
	});
	if (process.platform !== "win32") test("blocked resource sync reports partial activation, never a silent current/active split", () => {
		const f = make();
		cli(f.store, ["--promote", f.id]);
		assert.equal(load(join(f.store, "active.json")).releaseDir, f.release);
		const next = prepareSibling(f, "partial");
		// Pasta de skills do store que o sync não consegue substituir (sem permissão de escrita no
		// diretório, com filho dentro): a falha cai depois de `current` e do wrapper já terem mudado.
		const skills = join(f.store, "skills");
		mkdirSync(join(skills, "stuck"), { recursive: true });
		writeFileSync(join(skills, "stuck", "SKILL.md"), "stuck");
		chmodSync(skills, 0o500);
		const home = mkdtempSync(join(root, "home-"));
		let result;
		try {
			result = spawnSync(process.execPath, [script, "--store", f.store, "--promote", "partial", "--adopt-launcher", "--force"], {
				encoding: "utf8",
				env: { ...env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
			});
		} finally {
			chmodSync(skills, 0o700);
		}
		const output = result.stdout + result.stderr;
		assert.equal(result.status, 1, output);
		assert.equal(existsSync(forbidden), false, "promotion invoked a build command");
		assert.match(output, /Partial activation/);
		assert.doesNotMatch(output, /active pi was not changed|was not changed/);
		const active = load(join(f.store, "active.json"));
		assert.equal(active.partialActivation, true);
		assert.match(active.partialActivationReason, /skills/);
		// O ponteiro e a metadata descrevem a mesma release.
		assert.equal(realpathSync(join(f.store, "current")), realpathSync(next));
		assert.equal(realpathSync(active.releaseDir), realpathSync(next));
		assert.equal(active.treeDigest, load(join(next, "agent-release.json")).treeDigest);
		assert.equal(realpathSync(join(f.store, "previous")), f.release);
		// Rollback existente continua funcionando a partir do estado parcial.
		cli(f.store, ["--rollback"]);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		const rolled = load(join(f.store, "active.json"));
		assert.equal(rolled.releaseDir, f.release);
		assert.equal(rolled.partialActivation, undefined);
	});
	test("staging cleanup removes only this process's own directory", () => {
		const f = make();
		const releases = join(f.store, "releases");
		const own = join(releases, `.staging-${process.pid}`);
		const foreign = join(releases, `.staging-${process.pid + 1}`);
		mkdirSync(join(own, "lib"), { recursive: true });
		mkdirSync(foreign, { recursive: true });
		assert.equal(api.discardOwnStaging(own), true);
		assert.equal(existsSync(own), false);
		assert.equal(api.discardOwnStaging(foreign), false);
		assert.equal(existsSync(foreign), true);
		assert.equal(api.discardOwnStaging(own), false, "nothing left to remove is not a failure");
		assert.equal(existsSync(f.release), true);
	});
	// ---- Agent: instalação/enable/disable e persistência do opt-in em update/rollback ----
	function cliWith(store, args, overrides = {}, ok = true) {
		const result = spawnSync(process.execPath, [script, "--store", store, ...args], { encoding: "utf8", env: { ...env, ...overrides } });
		assert.equal(result.status === 0, ok, result.stdout + result.stderr);
		assert.equal(existsSync(forbidden), false, "agent path invoked a build command");
		return result;
	}
	const agentEnv = (home) => ({ ...env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") });
	const agentConfig = (store) => load(join(store, "runtime", "config.json"));
	const registryOf = (home) => join(home, ".pi", "agent", "agent-registry.json");
	function host(label) {
		const home = mkdtempSync(join(root, `home-${label}-`));
		const juice = join(home, "juice");
		mkdirSync(juice, { recursive: true });
		return { home, juice, env: agentEnv(home) };
	}
	function promoted(optional = false) {
		const f = make(optional);
		cli(f.store, ["--promote", f.id]);
		return f;
	}
	test("agent enable installs the helpers in the bundle, validates the artifact first and records the opt-in", () => {
		const f = promoted();
		const h = host("enable");
		const result = cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		assert.match(result.stdout, /Agent enabled over/);
		const active = load(join(f.store, "active.json"));
		for (const relative of ["scripts/lib/agent-runtime.mjs", "scripts/lib/agent-resources.mjs", "scripts/agent-launch.mjs"]) {
			assert.ok(existsSync(join(active.overlayRepo, relative)), `${relative} is missing from the installed bundle`);
		}
		const config = agentConfig(f.store);
		assert.equal(config.version, 1);
		assert.equal(config.enabled, true);
		// O paré com o host clássico (pacote instalado), não com a raiz da release.
		assert.equal(config.piRoot, f.pkg);
		assert.equal(config.juiceHome, h.juice);
		assert.ok(isAbsolute(config.resourceReceipt));
		assert.ok(existsSync(config.resourceReceipt));
		assert.ok(existsSync(join(f.store, "runtime", "releases", config.artifactId, "agent")));
		assert.ok(existsSync(registryOf(h.home)));
		assert.deepEqual(active.agent, { enabled: true, artifactId: config.artifactId, piRoot: config.piRoot, juiceHome: h.juice, resourceReceipt: config.resourceReceipt });
		assert.equal(active.releaseDir, f.release);
		// Backup seletivo: launcher/active/config e o diretório do recibo; nada de settings inteiro.
		const backups = readdirSync(join(f.store, "backups")).filter((name) => name.includes("agent-enable"));
		assert.equal(backups.length, 1);
		const backup = join(f.store, "backups", backups[0]);
		assert.ok(existsSync(join(backup, "restore.txt")));
		assert.ok(existsSync(join(backup, "active.json")));
		// Nada de settings inteiro, auth ou Vault no backup: launcher, active.json e a config.
		assert.deepEqual(
			readdirSync(backup).sort(),
			["active.json", "restore.txt", process.platform === "win32" ? "pi-wrapper.cmd" : "pi-wrapper"].sort(),
		);
		// O recibo/CAS dos recursos tem caminho estável por store (o helper do B reconhece a reaplicação por ele).
		assert.equal(dirname(config.resourceReceipt), join(f.store, "runtime", "resources-backup"));
		assert.match(readFileSync(join(backup, "restore.txt"), "utf8"), /resources-backup/);
	});
	test("same Pi release with a new Agent artifact records the checkout and clears the ahead notice", () => {
		const h = host("same-release");
		const git = (...args) => {
			const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: fixture, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		const hostEnv = { ...h.env, PATH: process.env.PATH };
		try {
			git("init", "-q");
			writeFileSync(join(fixture, "agent-input"), "first artifact");
			git("add", "agent-input");
			git("commit", "-qm", "first artifact");
			const first = git("rev-parse", "HEAD");
			const f = make();
			// Immutable release metadata still describes its original build.
			f.metadata.sourceRepo = realpathSync(fixture);
			f.metadata.sourceCommit = first;
			json(join(f.release, "agent-release.json"), f.metadata);
			const provenance = load(f.receipt).provenance;
			rmSync(f.receipt);
			api.writePrepared(f.store, f.release, f.metadata, null, provenance);
			cliWith(f.store, ["--promote", f.id], hostEnv);
			cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], hostEnv);
			const originalArtifact = agentConfig(f.store).artifactId;
			writeFileSync(join(fixture, "agent-input"), "second artifact");
			git("add", "agent-input");
			git("commit", "-qm", "second artifact");
			assert.match(cliWith(f.store, ["--status"], hostEnv).stdout, /1 commit ahead of the install/);
			assert.equal(staleAhead(f.store), 1); // Prime the footer/startup cache before reinstalling.
			const assertCurrentSource = () => {
				const active = load(join(f.store, "active.json"));
				assert.equal(active.sourceCommit, git("rev-parse", "HEAD"));
				assert.equal(active.sourceRepo, realpathSync(fixture));
				assert.equal(active.releaseDir, f.release);
				const status = cliWith(f.store, ["--status"], hostEnv).stdout;
				assert.match(status, /install is up to date/);
				assert.doesNotMatch(status, /ahead of the install/);
				assert.equal(staleAhead(f.store), 0);
				assert.deepEqual(load(join(f.release, "agent-release.json")), f.metadata);
			};
			cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], hostEnv);
			assert.notEqual(agentConfig(f.store).artifactId, originalArtifact);
			assertCurrentSource();
			writeFileSync(join(fixture, "agent-input"), "third artifact");
			git("add", "agent-input");
			git("commit", "-qm", "third artifact");
			cliWith(f.store, ["--promote", f.id, "--force"], hostEnv);
			assertCurrentSource();
			// Running the installed bundle cannot infer a newer checkout or restore the Pi build's old origin.
			const bundle = load(join(f.store, "active.json")).overlayRepo;
			const bundled = spawnSync(process.execPath, [join(bundle, "scripts", "agent-update.mjs"), "--store", f.store, "--agent-enable", "--juice-home", h.juice], { env: hostEnv, encoding: "utf8" });
			assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
			assertCurrentSource();
		} finally {
			rmSync(join(fixture, ".git"), { recursive: true, force: true });
			rmSync(join(fixture, "agent-input"), { force: true });
		}
	});
	test("agent enable fails closed: no config and no registration survive a partial failure", () => {
		const f = promoted();
		const h = host("enable-fail");
		for (const fault of ["prepare", "validate", "apply", "apply-partial", "config"]) {
			const result = cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], { ...h.env, AGENT_TEST_FAIL: fault }, false);
			const output = result.stdout + result.stderr;
			assert.match(output, /Agent was NOT enabled/, `${fault}: ${output}`);
			assert.equal(existsSync(join(f.store, "runtime", "config.json")), false, `${fault} wrote a config`);
			assert.equal(existsSync(registryOf(h.home)), false, `${fault} left a registration behind`);
		}
		// Helper que aplica recursos e não devolve recibo: impossível desfazer pelo updater. A feature
		// fica desligada e o que sobrou é relatado, nunca declarado como limpo.
		const orphan = cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], { ...h.env, AGENT_TEST_FAIL: "no-receipt" }, false);
		const orphanOutput = orphan.stdout + orphan.stderr;
		assert.match(orphanOutput, /no absolute receiptPath/);
		assert.match(orphanOutput, /Agent was NOT enabled/);
		assert.match(orphanOutput, /is still there and must be undone by hand/);
		assert.equal(existsSync(join(f.store, "runtime", "config.json")), false);
		rmSync(registryOf(h.home), { force: true });
		// Store sem release ativa: nada a habilitar.
		const empty = realpathSync(mkdtempSync(join(root, "store-empty-")));
		assert.match(cliWith(empty, ["--agent-enable", "--juice-home", h.juice], h.env, false).stderr, /No active release/);
		// Store isolado não autoriza escrita no perfil real.
		const bare = { ...h.env };
		delete bare.PI_CODING_AGENT_DIR;
		assert.match(cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], bare, false).stderr, /PI_CODING_AGENT_DIR/);
		assert.equal(existsSync(join(f.store, "runtime", "config.json")), false);
	});
	test("re-enable is idempotent and a failed re-enable never undoes the live opt-in", () => {
		const f = promoted();
		const h = host("re-enable");
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		const first = agentConfig(f.store);
		const failed = cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], { ...h.env, AGENT_TEST_FAIL: "config" }, false);
		const output = failed.stdout + failed.stderr;
		assert.match(output, /was KEPT/);
		assert.match(output, /opt-in it already had/);
		assert.deepEqual(agentConfig(f.store), first);
		assert.ok(existsSync(registryOf(h.home)), "a failed re-enable must not strip the live opt-in's registrations");
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		assert.deepEqual(agentConfig(f.store), first);
		assert.ok(existsSync(registryOf(h.home)));
	});
	test("agent CLI shape: exclusive modes, absolute --juice-home, no build flags", () => {
		assert.throws(() => api.parseArgs(["--agent-enable"]), /--juice-home/);
		assert.throws(() => api.parseArgs(["--agent-enable", "--juice-home", "relative/juice"]), /absolute/);
		assert.throws(() => api.parseArgs(["--agent-enable", "--juice-home", "/tmp/a/../b"]), /absolute/);
		assert.throws(() => api.parseArgs(["--juice-home", "/tmp/juice"]), /only valid with --agent-enable/);
		assert.throws(() => api.parseArgs(["--agent-disable", "--juice-home", "/tmp/juice"]), /only valid with --agent-enable/);
		for (const mode of [["--agent-enable", "--juice-home", "/tmp/juice"], ["--agent-disable"]]) {
			for (const other of [["--check"], ["--rollback"], ["--prepare"], ["--promote", "valid"], ["--agent-disable"]]) {
				if (mode[0] === other[0]) continue;
				assert.throws(() => api.parseArgs([...mode, ...other]), /mutually exclusive|incompatible/);
			}
			for (const flag of [["--ref", "v1.0.0"], ["--with", "optional"], ["--without", "optional"], ["--hydrate"], ["--simulate-conflict"], ["--no-prune"]]) {
				assert.throws(() => api.parseArgs([...mode, ...flag]), /incompatible/);
			}
		}
		const enable = api.parseArgs(["--agent-enable", "--juice-home", "/tmp/juice", "--store", "/tmp/store", "--force", "--adopt-launcher"]);
		assert.equal(enable.agentEnable, true);
		assert.equal(enable.juiceHome, resolve("/tmp/juice"));
		assert.equal(api.parseArgs(["--agent-disable", "--store", "/tmp/store"]).agentDisable, true);
	});
	test("promote with Agent prepares the new pair before switching, preserves the opt-in and skips the legacy agent-setup sync", () => {
		const f = promoted();
		const h = host("pair");
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		const first = agentConfig(f.store);
		const next = prepareSibling(f, "agent-next");
		// Par novo impossível: a troca é recusada antes de qualquer ponteiro.
		const refused = cliWith(f.store, ["--promote", "agent-next", "--adopt-launcher"], { ...h.env, AGENT_TEST_FAIL: "prepare" }, false);
		const refusedOutput = refused.stdout + refused.stderr;
		assert.match(refusedOutput, /no valid artifact could be prepared/);
		assert.match(refusedOutput, /active pi was not changed/);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.deepEqual(agentConfig(f.store), first);
		// Artefato registrado corrompido: a troca também é recusada (CAS do par anterior).
		const stale = cliWith(f.store, ["--promote", "agent-next", "--adopt-launcher"], { ...h.env, AGENT_TEST_FAIL: "validate" }, false);
		assert.match(stale.stdout + stale.stderr, /no longer validates/);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		const ok = cliWith(f.store, ["--promote", "agent-next", "--adopt-launcher"], h.env);
		assert.match(ok.stdout, /skipping the legacy agent-setup\/skills\/extensions sync/);
		const after = agentConfig(f.store);
		assert.equal(after.enabled, true);
		assert.equal(after.juiceHome, h.juice);
		assert.equal(after.resourceReceipt, first.resourceReceipt);
		assert.equal(after.piRoot, join(realpathSync(next), "lib", "node_modules", "fixture-pi"));
		assert.notEqual(after.artifactId, first.artifactId);
		assert.equal(load(join(f.store, "active.json")).agent.artifactId, after.artifactId);
		// Rollback de release repareia a config com a release anterior.
		cliWith(f.store, ["--rollback"], h.env);
		const rolled = agentConfig(f.store);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.equal(rolled.enabled, true);
		assert.equal(rolled.piRoot, f.pkg);
		assert.equal(rolled.artifactId, first.artifactId);
		assert.equal(rolled.resourceReceipt, first.resourceReceipt);
		assert.equal(load(join(f.store, "active.json")).agent.piRoot, f.pkg);
		// Rollback sem par possível não mexe nos ponteiros.
		cliWith(f.store, ["--promote", "agent-next", "--adopt-launcher", "--force"], h.env);
		const oldManifestPath = join(f.store, "runtime", "releases", first.artifactId, "manifest.json");
		const oldManifest = load(oldManifestPath);
		json(oldManifestPath, { ...oldManifest, piRoot: after.piRoot });
		const blocked = cliWith(f.store, ["--rollback"], h.env, false);
		assert.match(blocked.stdout + blocked.stderr, /Rollback refuses to continue|no valid artifact could be prepared/);
		assert.equal(realpathSync(join(f.store, "current")), realpathSync(next));
		assert.equal(agentConfig(f.store).piRoot, join(realpathSync(next), "lib", "node_modules", "fixture-pi"));
		json(oldManifestPath, oldManifest);
		// Pre-index stores retain the source rebuild fallback.
		rmSync(join(f.store, "runtime", "pi-artifacts.json"));
		cliWith(f.store, ["--rollback"], h.env);
		assert.equal(agentConfig(f.store).artifactId, first.artifactId);
	});
	// ---- Agent: a troca de par precisa trocar os REGISTROS, não só artifactId/piRoot ----
	const agentDirOf = (home) => join(home, ".pi", "agent");
	const settingsOf = (home) => load(join(agentDirOf(home), "settings.json"));
	const agentRootOf = (store, artifactId) => join(store, "runtime", "releases", artifactId, "agent");
	const demoEntry = (store, artifactId) => join(agentRootOf(store, artifactId), "extensions", "agent", "agent-demo", "index.ts");
	const entriesOf = (home) => settingsOf(home).extensions ?? [];
	// Entrada ATIVA (sem prefixo de exclusão) que carrega a extensão do artefato: o helper real registra
	// a pasta da extensão, o stub registra o arquivo de entrada; as duas valem como "path efetivo".
	const loadsDemo = (home, store, artifactId) =>
		entriesOf(home).some((entry) => typeof entry === "string" && !/^[-!]/.test(entry) && entry.startsWith(agentRootOf(store, artifactId)));
	const mentions = (home, artifactId) => entriesOf(home).filter((entry) => String(entry).includes(artifactId));
	/** Settings pessoal pré-existente + (no caminho real) uma cópia pessoal auto-descoberta do mesmo nome. */
	function seedPersonal(h, { collision }) {
		const agent = agentDirOf(h.home);
		mkdirSync(agent, { recursive: true });
		if (collision) {
			const personal = join(agent, "extensions", "agent-demo");
			mkdirSync(personal, { recursive: true });
			writeFileSync(join(personal, "index.ts"), "// personal copy\n");
		}
		const settings = { theme: "personal-theme", extensions: ["~/personal/own.ts"], skills: ["store/skills"] };
		json(join(agent, "settings.json"), settings);
		return settings;
	}
	/**
	 * enable N1 → update N2 → rollback N1 → disable, sempre olhando o PATH efetivo do settings.
	 * `real` roda a mesma sequência contra o helper de recursos de verdade (contrato B).
	 */
	function pairSwap(label, { real }) {
		const f = promoted();
		const h = host(label);
		const hostEnv = real ? { ...h.env, AGENT_REAL_RESOURCES: join(repo, "scripts", "lib", "agent-resources.mjs") } : h.env;
		const personal = seedPersonal(h, { collision: real });
		const personalIpython = join(agentDirOf(h.home), "extensions", "ipython", "index.ts");
		if (real) {
			mkdirSync(dirname(personalIpython), { recursive: true });
			writeFileSync(personalIpython, "// personal ipython\n");
		}
		writeFileSync(join(fixture, "agent-input"), "with-ipython");
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], hostEnv);
		const first = agentConfig(f.store);
		assert.ok(loadsDemo(h.home, f.store, first.artifactId), `${label}: N1 path is not registered`);
		assert.ok(entriesOf(h.home).includes("~/personal/own.ts"), `${label}: personal entry was dropped`);

		assert.ok(existsSync(join(agentRootOf(f.store, first.artifactId), "extensions", "agent", "ipython", "index.ts")));
		writeFileSync(join(fixture, "agent-input"), "without-ipython");
		const next = prepareSibling(f, `${label}-next`);
		const promotion = cliWith(f.store, ["--promote", `${label}-next`, "--adopt-launcher"], hostEnv);
		assert.match(promotion.stdout, /resource registrations switched to/);
		const after = agentConfig(f.store);
		assert.notEqual(after.artifactId, first.artifactId);
		assert.ok(!existsSync(join(agentRootOf(f.store, after.artifactId), "extensions", "agent", "ipython")));
		if (real) assert.ok(entriesOf(h.home).includes("-extensions/ipython/index.ts"));
		assert.equal(after.piRoot, join(realpathSync(next), "lib", "node_modules", "fixture-pi"));
		// Par único: só os caminhos de N2 estão carregados, nenhum de N1 sobrou.
		assert.ok(loadsDemo(h.home, f.store, after.artifactId), `${label}: N2 path is not registered`);
		assert.deepEqual(mentions(h.home, first.artifactId), [], `${label}: N1 paths still loaded after the update`);
		assert.ok(entriesOf(h.home).includes("~/personal/own.ts"));
		assert.equal(dirname(after.resourceReceipt), join(f.store, "runtime", "resources-backup"));
		// O recibo mutável do par antigo foi snapshotado antes de ser reescrito.
		assert.ok(readdirSync(join(f.store, "runtime", "resource-snapshots")).length > 0, `${label}: no receipt snapshot`);

		// Rollback de release: relinka os recursos de N1 e o opt-in persiste.
		cliWith(f.store, ["--rollback"], { ...hostEnv, AGENT_TEST_FAIL: "prepare" });
		const rolled = agentConfig(f.store);
		assert.equal(rolled.enabled, true);
		assert.equal(rolled.artifactId, first.artifactId);
		assert.ok(existsSync(join(agentRootOf(f.store, rolled.artifactId), "extensions", "agent", "ipython", "index.ts")));
		assert.equal(rolled.piRoot, f.pkg);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.ok(loadsDemo(h.home, f.store, first.artifactId), `${label}: rollback did not relink N1`);
		assert.deepEqual(mentions(h.home, after.artifactId), [], `${label}: N2 paths survived the rollback`);

		// Opt-out: devolve o settings pessoal ORIGINAL (nenhuma cópia nova, nenhum resto de N1/N2).
		cliWith(f.store, ["--agent-disable"], hostEnv);
		assert.deepEqual(settingsOf(h.home), personal, `${label}: disable did not restore the original settings`);
		if (real) assert.ok(existsSync(personalIpython));
		rmSync(join(fixture, "agent-input"));
		return { f, h, hostEnv };
	}
	test("update swaps the EFFECTIVE resource registrations, rollback relinks them and disable restores the originals", () => {
		pairSwap("swap", { real: false });
	});
	test("same transaction against the real resources helper: one pair's paths at a time, personal settings intact", () => {
		const { h } = pairSwap("swap-real", { real: true });
		// A cópia pessoal auto-descoberta nunca foi renomeada nem apagada.
		assert.ok(existsSync(join(agentDirOf(h.home), "extensions", "agent-demo", "index.ts")));
	});
	test("a resource rollback reporting conflicts fails the update instead of leaving a mixed pair", () => {
		const f = promoted();
		const h = host("conflict");
		seedPersonal(h, { collision: false });
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		const first = agentConfig(f.store);
		prepareSibling(f, "conflict-next");
		const result = cliWith(f.store, ["--promote", "conflict-next", "--adopt-launcher"], { ...h.env, AGENT_TEST_FAIL: "conflict" }, false);
		const output = result.stdout + result.stderr;
		assert.match(output, /resources unchanged/);
		assert.doesNotMatch(output, /RE-APPLIED|could NOT be re-applied/);
		assert.doesNotMatch(output, /promoted prepared release/);
		// Nem par misturado nem ponteiro novo: o Pi e os recursos continuam em N1.
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.deepEqual(agentConfig(f.store), first);
		assert.ok(entriesOf(h.home).includes(demoEntry(f.store, first.artifactId)));
		assert.equal(entriesOf(h.home).filter((entry) => String(entry).includes("agent-demo")).length, 1);
	});
	test("an opt-in whose resource receipt vanished refuses the update instead of stacking registrations", () => {
		const f = promoted();
		const h = host("no-receipt-update");
		seedPersonal(h, { collision: false });
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		const first = agentConfig(f.store);
		rmSync(first.resourceReceipt);
		prepareSibling(f, "orphan-next");
		const result = cliWith(f.store, ["--promote", "orphan-next", "--adopt-launcher"], h.env, false);
		const output = result.stdout + result.stderr;
		assert.match(output, /resource receipt/);
		assert.match(output, /active pi was not changed/);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		assert.deepEqual(agentConfig(f.store), first);
	});
	test("agent disable closes the opt-out first, then rolls back the resource delta, and keeps the artifact", () => {
		const f = promoted();
		const h = host("disable");
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		const config = agentConfig(f.store);
		assert.ok(existsSync(registryOf(h.home)));
		// Falha no rollback dos recursos: o opt-out já está fechado e a retentativa é explícita.
		const failed = cliWith(f.store, ["--agent-disable"], { ...h.env, AGENT_TEST_FAIL: "rollback" }, false);
		const failedOutput = failed.stdout + failed.stderr;
		assert.match(failedOutput, /already DISABLED/);
		assert.match(failedOutput, /--agent-disable/);
		assert.equal(agentConfig(f.store).enabled, false);
		assert.ok(existsSync(registryOf(h.home)), "the failed rollback must be reported, not silently claimed");
		// Retentativa: idempotente, remove o delta e preserva o registro do opt-in e o artefato.
		cliWith(f.store, ["--agent-disable"], h.env);
		assert.equal(existsSync(registryOf(h.home)), false);
		const disabled = agentConfig(f.store);
		assert.equal(disabled.enabled, false);
		assert.equal(disabled.artifactId, config.artifactId);
		assert.equal(disabled.juiceHome, h.juice);
		assert.ok(existsSync(join(f.store, "runtime", "releases", config.artifactId, "agent")), "opt-out must not delete the artifact");
		cliWith(f.store, ["--agent-disable"], h.env);
		assert.equal(load(join(f.store, "active.json")).agent.enabled, false);
		assert.equal(load(join(f.store, "active.json")).releaseDir, f.release);
		// Sem a feature, a ativação volta integralmente ao caminho legado.
		prepareSibling(f, "legacy-again");
		const again = cliWith(f.store, ["--promote", "legacy-again", "--adopt-launcher"], h.env);
		assert.doesNotMatch(again.stdout, /skipping the legacy agent-setup\/skills\/extensions sync/);
		assert.equal(agentConfig(f.store).enabled, false);
		// Store sem Agent: disable é inócuo.
		const g = promoted();
		assert.match(cliWith(g.store, ["--agent-disable"], h.env).stdout, /not configured/);
	});
	test("pruning keeps the release the Agent config points at", () => {
		const f = make();
		// mtimes explícitas: `orphan-0` é o mais antigo, portanto o único fora do piso de retenção.
		for (let i = 0; i < 4; i++) {
			const dir = join(f.store, "releases", `orphan-${i}`);
			mkdirSync(dir);
			utimesSync(dir, 1_700_000_000 + i * 3600, 1_700_000_000 + i * 3600);
		}
		const pinned = join(f.store, "releases", "orphan-0");
		// `piRoot` aponta para o pacote DENTRO da release: a release que o contém está em uso.
		api.collectOrphanReleases(f.store, null, [join(pinned, "lib", "node_modules", "fixture-pi")]);
		assert.ok(existsSync(pinned), "a release referenced by the Agent config is in use");
		assert.ok(existsSync(f.release));
		api.collectOrphanReleases(f.store, null, []);
		assert.equal(existsSync(pinned), false);
	});
	await atest("--check reports Agent status without building", async () => {
		const f = promoted();
		assert.match(await api.agentStatusReport(f.store), /Agent: not configured/);
		const h = host("status");
		cliWith(f.store, ["--agent-enable", "--juice-home", h.juice], h.env);
		const status = await api.agentStatusReport(f.store);
		assert.match(status, /Agent: enabled/);
		assert.match(status, /artifact valid/);
		assert.match(status, new RegExp(h.juice.replaceAll("/", "\\/")));
		const config = agentConfig(f.store);
		rmSync(join(f.store, "runtime", "releases", config.artifactId), { recursive: true, force: true });
		assert.match(await api.agentStatusReport(f.store), /artifact INVALID/);
	});
	await atest("real runtime: durable pair promotes to classic and installed launcher survives rollback", async () => {
		const f = promoted();
		const h = host("durable-migration");
		const lib = join(fixture, "scripts/lib");
		const runtimeText = readFileSync(join(repo, "scripts/lib/agent-runtime.mjs"), "utf8");
		writeFileSync(join(lib, "real-runtime.mjs"), runtimeText);
		// Historical producer is fixture-only; production prepare remains classic-only.
		writeFileSync(join(lib, "historical-runtime.mjs"), runtimeText.replace(
			'export const PI_ENTRY = "dist/cli.js";', 'export const PI_ENTRY = "dist/bundle/cli.js";'));
		writeFileSync(join(lib, "agent-runtime.mjs"), runtimeText);
		copyFileSync(join(repo, "scripts/agent-launch.mjs"), join(fixture, "scripts/agent-launch.mjs"));
		const runtime = await import(pathToFileURL(join(lib, "real-runtime.mjs")));
		const historical = await import(pathToFileURL(join(lib, "historical-runtime.mjs")));
		const agent = join(fixture, "agent");
		mkdirSync(join(agent, "juice"), { recursive: true });
		writeFileSync(join(agent, "juice/runtime.mjs"), "// fixture preload\n");
		const demo = join(agent, "extensions/agent/agent-demo");
		mkdirSync(demo, { recursive: true });
		writeFileSync(join(demo, "index.ts"), "// fixture extension\n");
		const preparePi = (pkg, entry) => {
			mkdirSync(dirname(join(pkg, entry)), { recursive: true });
			mkdirSync(join(pkg, "dist/core"), { recursive: true });
			writeFileSync(join(pkg, "dist/core/model-runtime.js"), "");
			writeFileSync(join(pkg, entry), `require("node:fs").writeFileSync(process.env.AGENT_LAUNCH_OUT, JSON.stringify({ entry: __filename, env: process.env, args: process.argv.slice(2) }));`);
		};
		preparePi(f.pkg, "dist/bundle/cli.js");
		// Keep release verification exact after adding the historical host fixture.
		const refresh = (dir) => {
			const metadata = load(join(dir, "agent-release.json"));
			metadata.treeDigest = api.digestTree(dir);
			json(join(dir, "agent-release.json"), metadata);
			return metadata;
		};
		refresh(f.release);
		let old = historical.prepareAgentArtifact({ sourceRoot: fixture, store: f.store, piRoot: f.pkg, log: () => {} });
		// Convert only this fixture to the historical v1 format, including its native dependency.
		// Production has no native producer; rollback must still validate and launch v1.
		const legacy = load(old.manifestPath);
		const nativeName = process.platform === "win32" ? "mark-juice.exe" : "mark-juice";
		const native = join(old.artifactRoot, "broker", nativeName);
		mkdirSync(dirname(native));
		writeFileSync(native, readFileSync(process.execPath).subarray(0, 8192), { mode: 0o555 });
		legacy.version = 1;
		legacy.broker = { path: `broker/${nativeName}`, sha256: hash(readFileSync(native)), platform: process.platform, arch: process.arch, format: { darwin: "mach-o", linux: "elf", win32: "pe" }[process.platform] };
		const digest = createHash("sha256").update(`agent-artifact v1\0${process.platform}\0${process.arch}\0${legacy.piRoot}\0${legacy.piEntry}\0`).update(`broker\0${legacy.broker.sha256}\0`);
		for (const [file, value] of Object.entries(legacy.files).sort((a, b) => a[0] < b[0] ? -1 : 1)) digest.update(`F ${file}\0${value}\0`);
		legacy.artifactId = digest.digest("hex");
		chmodSync(old.manifestPath, 0o644); json(old.manifestPath, legacy);
		renameSync(old.artifactRoot, join(dirname(old.artifactRoot), legacy.artifactId));
		old = runtime.validateAgentArtifact({ store: f.store, artifactId: legacy.artifactId });
		const resources = await import(pathToFileURL(join(lib, "agent-resources.mjs")));
		const applied = resources.applyAgentResources({ plan: resources.planAgentResources({ agentRoot: old.agentRoot, agentDir: join(h.home, ".pi/agent"), homeDir: h.home }), backupDir: join(f.store, "initial-receipt") });
		runtime.writeAgentConfig({ store: f.store, config: { version: 1, enabled: true, artifactId: old.artifactId, piRoot: f.pkg, juiceHome: h.juice, resourceReceipt: applied.receiptPath } });
		const next = prepareSibling(f, "classic-migration");
		const nextPkg = join(next, "lib/node_modules/fixture-pi");
		preparePi(nextPkg, "dist/cli.js");
		const nextMetadata = refresh(next);
		const receiptPath = join(f.store, "prepared/classic-migration.json");
		const provenance = load(receiptPath).provenance;
		rmSync(receiptPath);
		api.writePrepared(f.store, next, nextMetadata, readCurrentTarget(f.store), provenance);
		const out = join(root, "migration-launch.json");
		const migrationEnv = { ...h.env, AGENT_LAUNCH_OUT: out, AGENT_WARM_START: "0" };
		cliWith(f.store, ["--promote", "classic-migration"], migrationEnv);
		const active = load(join(f.store, "active.json"));
		const launch = (entry, durable) => {
			const result = spawnSync(process.execPath, [join(active.overlayRepo, "scripts/agent-launch.mjs"), "--store", f.store, "--", "--version"], { env: migrationEnv, encoding: "utf8" });
			assert.equal(result.status, 0, result.stdout + result.stderr);
			const observed = load(out);
			assert.equal(observed.entry, entry);
			assert.deepEqual(observed.args, ["--version"]);
			assert.equal(observed.env.AGENT_JUICE_PI_ENTRY, durable ? "bundle" : undefined);
			assert.equal(observed.env.AGENT_JUICE_BIN, durable ? old.brokerPath : undefined);
			assert.equal(observed.env.PI_DURABLE_HOST, durable ? migrationEnv.PI_DURABLE_HOST : "0");
		};
		launch(join(nextPkg, "dist/cli.js"), false);
		// Run rollback through the installed updater, as the wrapper does.
		const rolled = spawnSync(process.execPath, [join(active.overlayRepo, "scripts/agent-update.mjs"), "--store", f.store, "--rollback"], { env: migrationEnv, encoding: "utf8" });
		assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
		assert.equal(agentConfig(f.store).artifactId, old.artifactId);
		assert.equal(load(join(f.store, "active.json")).overlayRepo, active.overlayRepo);
		assert.equal(realpathSync(join(f.store, "current")), f.release);
		launch(join(f.pkg, "dist/bundle/cli.js"), true);
	});
	assert.equal(existsSync(forbidden), false);
	console.log(`prepare-promote: ${checks} tests OK (fixtures only; no real build or external E2E)`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
