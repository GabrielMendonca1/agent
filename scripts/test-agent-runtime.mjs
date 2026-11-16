#!/usr/bin/env node
/**
 * Agent instalado: artefato, configuração e launcher.
 *
 * Tudo offline e em fixtures: HOME, store, agent-dir e release Pi são diretórios temporários, o
 * "Pi" é um script que ecoa argumentos/ambiente, e o "broker" é um arquivo com o cabeçalho nativo
 * desta máquina (nenhum binário é executado, nenhuma inferência é feita, nada global é tocado).
 *
 * O que cada bloco prova está no nome do teste; o fio condutor é: o artefato não pode ser
 * adulterado nem viajar entre arquiteturas, a configuração não aceita preferências pessoais, o
 * launcher preserva o ambiente real do usuário e nada roda anunciando contabilização sem tê-la.
 */
import assert from "node:assert/strict";

process.env.AGENT_RUST_AUTO_INSTALL = "0"; // nenhum teste instala Rust de verdade
process.env.AGENT_WARM_START = "0"; // nem aquece o cache abrindo o pi instalado

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	renameSync,
	readFileSync,
	readSync,
	closeSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CONFIG_VERSION,
	DISABLE_ENV,
	MANIFEST_FILE,
	AGENT_SUBDIR,
	PI_ENTRY,
	RUNTIME_PRELOAD,
	buildAgentLaunch,
	agentConfigPath,
	prepareAgentArtifact,
	readAgentConfig,
	validateAgentArtifact,
	writeAgentConfig,
} from "./lib/agent-runtime.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repo, "scripts", "agent-launch.mjs");
// realpath: /var/folders -> /private/var/folders no macOS. Os caminhos do contrato são físicos.
const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-test-")));
let checks = 0;
const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

// ---------------------------------------------------------------- fixtures

/** Cabeçalho do executável nativo desta máquina: serve de "broker" válido sem compilar nada. */
const nativeHeader = (() => {
	const buffer = Buffer.alloc(8192);
	const fd = openSync(process.execPath, "r");
	const read = readSync(fd, buffer, 0, buffer.length, 0);
	closeSync(fd);
	return buffer.subarray(0, read);
})();

function writeBroker(path, { foreign = false } = {}) {
	mkdirSync(dirname(path), { recursive: true });
	const bytes = Buffer.from(nativeHeader);
	if (foreign) {
		// Mesmo formato, outra arquitetura: Mach-O cputype / ELF e_machine / PE machine.
		const magic = bytes.readUInt32BE(0);
		if (magic === 0xcffaedfe || magic === 0xcefaedfe) bytes.writeUInt32LE(process.arch === "arm64" ? 0x01000007 : 0x0100000c, 4);
		else if (bytes.subarray(0, 4).toString("latin1") === "\x7fELF") bytes.writeUInt16LE(process.arch === "arm64" ? 0x3e : 0xb7, 18);
		else if (bytes.subarray(0, 2).toString("latin1") === "MZ") bytes.writeUInt16LE(process.arch === "arm64" ? 0x8664 : 0xaa64, bytes.readUInt32LE(0x3c) + 4);
		else throw new Error(`formato de ${process.execPath} não reconhecido pelo fixture`);
	}
	writeFileSync(path, bytes, { mode: 0o755 });
	return path;
}

/** Release Pi de fixture: host clássico com uma CLI que só relata o que recebeu. */
function fakePiRoot(name) {
	const piRoot = join(root, "pi-roots", name);
	mkdirSync(join(piRoot, "dist", "core"), { recursive: true });
	writeFileSync(join(piRoot, "dist", "core", "model-runtime.js"), "export class ModelRuntime {}\n");
	writeFileSync(
		join(piRoot, "dist", "cli.js"),
		`import { appendFileSync, writeFileSync } from "node:fs";
const out = process.env.AGENT_TEST_OUT;
if (out) writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), env: process.env, execPath: process.execPath }));
if (process.env.AGENT_TEST_WAIT) {
  // WAIT=1: trata o sinal e sai com 42. WAIT=2: nao trata nada e morre do proprio sinal.
  if (process.env.AGENT_TEST_WAIT === "1") {
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { appendFileSync(process.env.AGENT_TEST_SIGNALS, signal + "\\n"); process.exit(42); });
  }
  writeFileSync(process.env.AGENT_TEST_READY, "ready");
  setTimeout(() => process.exit(99), 10000);
} else process.exit(Number(process.env.AGENT_TEST_EXIT ?? 0));
`,
	);
	return piRoot;
}

/** Árvore `agent/` de fixture: preload que só registra que rodou, mais lixo que não deve viajar. */
function fixtureSource(name = "src") {
	const source = join(root, name);
	const agent = join(source, AGENT_SUBDIR);
	mkdirSync(join(agent, "juice"), { recursive: true });
	writeFileSync(
		join(agent, RUNTIME_PRELOAD),
		`import { appendFileSync } from "node:fs";
if (process.env.AGENT_TEST_PRELOAD) appendFileSync(process.env.AGENT_TEST_PRELOAD, import.meta.url + "\\n");
`,
	);
	// O nome entra no conteúdo: cada fixture é um artefato distinto (o digest é do conteúdo).
	writeFileSync(join(agent, "juice", "client.mjs"), `export const juiceEnabled = () => true; // ${name}\n`);
	mkdirSync(join(agent, "extensions", "brain-live"), { recursive: true });
	writeFileSync(join(agent, "extensions", "brain-live", "juice.ts"), "export default {};\n");
	mkdirSync(join(agent, "extensions", "agent", "tui"), { recursive: true });
	writeFileSync(join(agent, "extensions", "agent", "tui", "compact-tools.ts"), "export const compactTools = true;\n");
	writeFileSync(join(agent, "extensions", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// Produtos de build e ruído local nunca entram no artefato.
	mkdirSync(join(agent, "node_modules"), { recursive: true });
	writeFileSync(join(agent, "node_modules", "x.js"), "module.exports = 1;\n");
	writeFileSync(join(agent, ".DS_Store"), "lixo\n");
	return source;
}

/** Store com `current` apontando para uma release (o caminho legado do wrapper). */
function fixtureStore(name, currentTarget) {
	const store = join(root, "stores", name);
	mkdirSync(join(store, "current", "bin"), { recursive: true });
	writeFileSync(join(store, "current", "bin", "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	if (currentTarget) {
		rmSync(join(store, "current"), { recursive: true, force: true });
		symlinkSync(currentTarget, join(store, "current"));
	}
	return store;
}

// Legacy v1 fixture: the immutable manifest declares its native dependency.
const BROKER_NAME = process.platform === 'win32' ? 'mark-juice.exe' : 'mark-juice';
const BROKER_SUBDIR = 'broker';
function legacyArtifact(artifact, store) {
	const manifest = JSON.parse(readFileSync(artifact.manifestPath));
	// v1 included the vendor sources: their hashes must still participate in validation.
	mkdirSync(join(artifact.agentRoot, 'mass-core'));
	writeFileSync(join(artifact.agentRoot, 'mass-core/Cargo.toml'), 'legacy vendor sources\n');
	manifest.files['mass-core/Cargo.toml'] = `-${hashOf(join(artifact.agentRoot, 'mass-core/Cargo.toml'))}`;
	const brokerPath = join(artifact.artifactRoot, BROKER_SUBDIR, BROKER_NAME);
	mkdirSync(dirname(brokerPath)); writeBroker(brokerPath); chmodSync(brokerPath, 0o555);
	manifest.version = 1;
	manifest.broker = { path: `${BROKER_SUBDIR}/${BROKER_NAME}`, sha256: hashOf(brokerPath), platform: process.platform, arch: process.arch, format: { darwin: 'mach-o', linux: 'elf', win32: 'pe' }[process.platform] };
	const hash = createHash('sha256').update(`agent-artifact v1\0${process.platform}\0${process.arch}\0${manifest.piRoot}\0${manifest.piEntry}\0`).update(`broker\0${manifest.broker.sha256}\0`);
	for (const [file, value] of Object.entries(manifest.files).sort((a,b) => a[0] < b[0] ? -1 : 1)) hash.update(`F ${file}\0${value}\0`);
	manifest.artifactId = hash.digest('hex');
	chmodSync(artifact.manifestPath, 0o644); writeFileSync(artifact.manifestPath, JSON.stringify(manifest));
	renameSync(artifact.artifactRoot, join(dirname(artifact.artifactRoot), manifest.artifactId));
	return validateAgentArtifact({ store, artifactId: manifest.artifactId });
}
const quiet = { log: () => {} };
const source = fixtureSource();
const piRoot = fakePiRoot("release-a");
const store = fixtureStore("main");
const prepared = prepareAgentArtifact({ sourceRoot: source, store, piRoot, ...quiet });

const baseEnv = {
	HOME: join(root, "home-real"),
	USERPROFILE: join(root, "home-real"),
	PATH: process.env.PATH,
	PI_CODING_AGENT_DIR: join(root, "home-real", ".pi", "agent"),
	PI_SYSTEM_DIR: join(root, "home-real", "Sistema"),
	XDG_CONFIG_HOME: join(root, "home-real", ".config"),
	LANG: "pt_BR.UTF-8",
	TERM: "xterm-256color",
};
const juiceHome = join(root, "ledger", "juice");
mkdirSync(juiceHome, { recursive: true });
// Ledger preexistente: o launcher não pode tocá-lo (init idempotente é do runtime).
writeFileSync(join(juiceHome, "run.json"), JSON.stringify({ runId: "pre-existente", cost: { total: 1.5 } }));
const enabledConfig = {
	version: CONFIG_VERSION,
	enabled: true,
	artifactId: prepared.artifactId,
	piRoot: prepared.piRoot,
};

// ---------------------------------------------------------------- artefato

test("prepare instala o artefato completo, com agentRoot=artifactRoot/agent e manifesto conferível", () => {
	assert.equal(prepared.artifactRoot, join(realpathSync(store), "runtime", "releases", prepared.artifactId));
	assert.equal(prepared.agentRoot, join(prepared.artifactRoot, AGENT_SUBDIR));
	assert.equal(prepared.manifestPath, join(prepared.artifactRoot, MANIFEST_FILE));
	assert.equal(prepared.piRoot, realpathSync(piRoot));
	assert.match(prepared.artifactId, /^[0-9a-f]{64}$/);
	const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
	assert.equal(manifest.platform, process.platform);
	assert.equal(manifest.arch, process.arch);
	assert.equal(manifest.piEntry, PI_ENTRY);
	assert.equal(manifest.version, 3);
	assert.equal(manifest.broker, undefined);
	// A árvore viaja inteira; node_modules e .DS_Store ficam de fora.
	assert.ok(manifest.files[RUNTIME_PRELOAD], "o preload tem de estar no manifesto");
	assert.ok(manifest.files["extensions/brain-live/juice.ts"]);
	assert.ok(!Object.keys(manifest.files).some((file) => file.startsWith("node_modules/") || file.endsWith(".DS_Store")));
	// Bit de execução preservado e registrado.
	assert.match(manifest.files["extensions/run.sh"], /^x/);
	assert.match(manifest.files[RUNTIME_PRELOAD], /^-/);
	assert.ok(!existsSync(join(prepared.artifactRoot, BROKER_SUBDIR)));
});

test("o artefato é imutável no disco e não cria configuração, ledger nem launcher", () => {
	assert.equal(statSync(join(prepared.agentRoot, RUNTIME_PRELOAD)).mode & 0o222, 0, "arquivo do artefato não pode ser gravável");
	assert.equal(statSync(prepared.manifestPath).mode & 0o222, 0);
	assert.equal(readAgentConfig(store), null, "prepare não escreve configuração");
	assert.ok(!existsSync(agentConfigPath(store)));
	assert.equal(JSON.parse(readFileSync(join(juiceHome, "run.json"), "utf8")).runId, "pre-existente");
	assert.equal(readFileSync(join(store, "current", "bin", "pi"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("prepare é idempotente: mesmo conteúdo e mesmo par Pi devolvem o mesmo artefato", () => {
	const again = prepareAgentArtifact({ sourceRoot: source, store, piRoot, ...quiet });
	assert.equal(again.artifactId, prepared.artifactId);
	assert.equal(again.artifactRoot, prepared.artifactRoot);
});

test("o artefato identifica o PAR Pi+Agent: outra release Pi é outro artefato", () => {
	const other = fakePiRoot("release-b");
	const second = prepareAgentArtifact({ sourceRoot: source, store, piRoot: other, ...quiet });
	assert.notEqual(second.artifactId, prepared.artifactId);
	assert.equal(second.piRoot, realpathSync(other));
	// E cada um valida só contra o seu Pi.
	assert.throws(() => validateAgentArtifact({ store, artifactId: second.artifactId, piRoot }), /preparado para/);
});

test("prepare recusa piRoot mutável (current), sem ModelRuntime, e origem sem preload", () => {
	const link = join(root, "pi-roots", "current-link");
	rmSync(link, { recursive: true, force: true });
	symlinkSync(piRoot, link);
	assert.throws(() => prepareAgentArtifact({ sourceRoot: source, store, piRoot: link, ...quiet }), /caminho físico/);
	const classic = join(root, "pi-roots", "classic");
	mkdirSync(join(classic, "dist"), { recursive: true });
	writeFileSync(join(classic, "dist", "cli.js"), "");
	assert.throws(() => prepareAgentArtifact({ sourceRoot: source, store, piRoot: classic, ...quiet }), /CLI clássico e ModelRuntime/);
	const bare = join(root, "src-sem-preload");
	mkdirSync(join(bare, AGENT_SUBDIR, "juice"), { recursive: true });
	writeFileSync(join(bare, AGENT_SUBDIR, "juice", "client.mjs"), "");
	assert.throws(() => prepareAgentArtifact({ sourceRoot: bare, store, piRoot, ...quiet }), /sem o preload/);
});

test("prepare works without any native toolchain on PATH", () => {
 const saved = process.env.PATH; process.env.PATH = join(root, 'empty');
 try { assert.equal(prepareAgentArtifact({ sourceRoot: source, store, piRoot, ...quiet }).artifactId, prepared.artifactId); }
 finally { process.env.PATH = saved; }
});

test("validate recusa adulteração de arquivo, manifesto e arquivo extra", () => {
	const victim = prepareAgentArtifact({ sourceRoot: fixtureSource("src-tamper"), store, piRoot, ...quiet });
	const file = join(victim.agentRoot, RUNTIME_PRELOAD);
	const original = readFileSync(file);
	chmodSync(file, 0o644);
	writeFileSync(file, "// código trocado\n");
	assert.throws(() => validateAgentArtifact({ store, artifactId: victim.artifactId }), /alterado no artefato/);
	assert.throws(() => prepareAgentArtifact({ sourceRoot: join(root, "src-tamper"), store, piRoot, ...quiet }), /preservado para não remover/);
	assert.equal(readFileSync(file, "utf8"), "// código trocado\n", "prepare não remove artefato que pode estar em uso");
	writeFileSync(file, original);
	chmodSync(file, 0o444);
	assert.equal(validateAgentArtifact({ store, artifactId: victim.artifactId }).artifactId, victim.artifactId);

	// Manifesto reescrito de forma "coerente" com o arquivo trocado: o digest no NOME do diretório
	// não bate mais, e é essa conferência que impede a adulteração completa.
	const manifest = JSON.parse(readFileSync(victim.manifestPath, "utf8"));
	chmodSync(file, 0o644);
	writeFileSync(file, "// código trocado de novo\n");
	manifest.files[RUNTIME_PRELOAD] = `-${hashOf(file)}`;
	chmodSync(victim.manifestPath, 0o644);
	writeFileSync(victim.manifestPath, JSON.stringify(manifest, null, 2));
	assert.throws(() => validateAgentArtifact({ store, artifactId: victim.artifactId }), /não corresponde ao seu identificador/);

	const extra = join(victim.agentRoot, "intruso.mjs");
	writeFileSync(extra, "// não declarado\n");
	assert.throws(() => validateAgentArtifact({ store, artifactId: victim.artifactId }), /não declarado no manifesto|não corresponde/);
	rmSync(victim.artifactRoot, { recursive: true, force: true });
});

test("validate recusa travessia, link no store, id inválido e broker removido", () => {
	for (const bad of ["../../etc", "..", "a/b", "", prepared.artifactId.toUpperCase(), `${prepared.artifactId}x`, null]) {
		assert.throws(() => validateAgentArtifact({ store, artifactId: bad }), /artifactId inválido/);
	}
	// Um "artefato" que é link para outro diretório é recusado (o digest viveria fora do store).
	const releases = join(realpathSync(store), "runtime", "releases");
	const fakeId = "b".repeat(64);
	const outside = join(root, "fora-do-store");
	mkdirSync(outside, { recursive: true });
	symlinkSync(outside, join(releases, fakeId));
	assert.throws(() => validateAgentArtifact({ store, artifactId: fakeId }), /link simbólico/);
	rmSync(join(releases, fakeId), { force: true });
	assert.throws(() => validateAgentArtifact({ store, artifactId: "c".repeat(64) }), /não está instalado/);

	const victim = legacyArtifact(prepareAgentArtifact({ sourceRoot: fixtureSource("src-broker"), store, piRoot, ...quiet }), store);
	chmodSync(victim.brokerPath, 0o755);
	writeFileSync(victim.brokerPath, Buffer.concat([nativeHeader, Buffer.from("changed")]));
	assert.throws(() => validateAgentArtifact({ store, artifactId: victim.artifactId }), /broker do artefato mudou/);
	rmSync(victim.brokerPath, { force: true });
	assert.throws(() => validateAgentArtifact({ store, artifactId: victim.artifactId }), /broker do artefato.*não existe/s);
	rmSync(victim.artifactRoot, { recursive: true, force: true });
});

test("artefato durável histórico valida e lança bundle com ambiente antigo; prepare continua clássico", async () => {
	const historicalModule = join(root, "historical-runtime.mjs");
	writeFileSync(historicalModule, readFileSync(join(repo, "scripts/lib/agent-runtime.mjs"), "utf8")
		.replace('export const PI_ENTRY = "dist/cli.js";', 'export const PI_ENTRY = "dist/bundle/cli.js";'));
	const historical = await import(pathToFileURL(historicalModule));
	const durablePi = fakePiRoot("durable");
	mkdirSync(join(durablePi, "dist/bundle"));
	writeFileSync(join(durablePi, "dist/bundle/cli.js"), readFileSync(join(durablePi, PI_ENTRY)));
	rmSync(join(durablePi, PI_ENTRY));
	const old = legacyArtifact(historical.prepareAgentArtifact({ sourceRoot: source, store, piRoot: durablePi, ...quiet }), store);
	assert.equal(validateAgentArtifact({ store, artifactId: old.artifactId }).piEntry, join(durablePi, "dist/bundle/cli.js"));
	assert.throws(() => prepareAgentArtifact({ sourceRoot: source, store, piRoot: durablePi, ...quiet }), /CLI clássico/);
	writeAgentConfig({ store, config: { ...enabledConfig, version: 1, juiceHome, artifactId: old.artifactId, piRoot: durablePi } });
	for (const durableHost of [undefined, "1"]) {
		const env = { ...baseEnv, AGENT_JUICE_PI_ENTRY: "stale" };
		if (durableHost !== undefined) env.PI_DURABLE_HOST = durableHost;
		const spec = buildAgentLaunch({ store, env, args: ["--version"] });
		assert.deepEqual(spec.args, [join(durablePi, "dist/bundle/cli.js"), "--version"]);
		assert.equal(spec.env.AGENT_JUICE_PI_ENTRY, "bundle");
		assert.equal(spec.env.AGENT_JUICE_BIN, old.brokerPath);
		assert.equal(spec.env.AGENT_JUICE_HOME, juiceHome);
		assert.equal(spec.env.AGENT_JUICE_STATE, join(juiceHome, "run.json"));
		assert.equal(spec.env.PI_DURABLE_HOST, durableHost);
		assert.equal(spec.preload, `--import=${pathToFileURL(join(old.agentRoot, RUNTIME_PRELOAD)).href}`);
	}
	const out = join(root, "durable-observed.json");
	const launched = runLauncher(["--store", store, "--", "--version"], { ...baseEnv, AGENT_TEST_OUT: out });
	assert.equal(launched.status, 0, launched.stderr);
	assert.equal(JSON.parse(readFileSync(out)).env.AGENT_JUICE_PI_ENTRY, "bundle");
	const durableEntry = join(durablePi, "dist/bundle/cli.js");
	const durableCode = readFileSync(durableEntry);
	rmSync(durableEntry);
	assert.throws(() => validateAgentArtifact({ store, artifactId: old.artifactId }), /não tem dist\/bundle\/cli.js/);
	const outside = join(root, "outside-entry");
	mkdirSync(outside);
	writeFileSync(join(outside, "cli.js"), durableCode);
	rmSync(join(durablePi, "dist/bundle"), { recursive: true });
	symlinkSync(outside, join(durablePi, "dist/bundle"), "junction");
	assert.throws(() => validateAgentArtifact({ store, artifactId: old.artifactId }), /fora do caminho físico/);
	rmSync(join(durablePi, "dist/bundle"));
	mkdirSync(join(durablePi, "dist/bundle"));
	writeFileSync(durableEntry, durableCode);
	// Alterar a entrada para outra existente continua sendo adulteração do digest v1.
	writeFileSync(join(durablePi, PI_ENTRY), "");
	chmodSync(old.manifestPath, 0o644);
	const manifest = JSON.parse(readFileSync(old.manifestPath));
	for (const piEntry of ["../escape.js", "/tmp/escape.js", "dist/missing.js"]) {
		writeFileSync(old.manifestPath, JSON.stringify({ ...manifest, piEntry }));
		assert.throws(() => validateAgentArtifact({ store, artifactId: old.artifactId }), /entrada do Pi/);
	}
	writeFileSync(old.manifestPath, JSON.stringify({ ...manifest, piEntry: PI_ENTRY }));
	assert.throws(() => validateAgentArtifact({ store, artifactId: old.artifactId }), /não corresponde ao seu identificador/);
	writeFileSync(old.manifestPath, JSON.stringify({ ...manifest, runtimePreload: "../escape.mjs" }));
	assert.throws(() => validateAgentArtifact({ store, artifactId: old.artifactId }), /runtimePreload/);
	writeAgentConfig({ store, config: enabledConfig });
});

test("artefato v2 histórico continua com seu contrato Juice sem ser reescrito", () => {
	const historicalStore = fixtureStore("v2-history");
	const current = prepareAgentArtifact({ sourceRoot: source, store: historicalStore, piRoot, ...quiet });
	const manifest = JSON.parse(readFileSync(current.manifestPath, "utf8"));
	manifest.version = 2;
	const digest = createHash("sha256").update(`agent-artifact v2\0${process.platform}\0${process.arch}\0${manifest.piRoot}\0${manifest.piEntry}\0`);
	for (const [file, value] of Object.entries(manifest.files).sort((a,b) => a[0] < b[0] ? -1 : 1)) digest.update(`F ${file}\0${value}\0`);
	manifest.artifactId = digest.digest("hex");
	chmodSync(current.manifestPath, 0o644); writeFileSync(current.manifestPath, JSON.stringify(manifest));
	const destination = join(dirname(current.artifactRoot), manifest.artifactId);
	renameSync(current.artifactRoot, destination);
	const before = readFileSync(join(destination, MANIFEST_FILE), "utf8");
	writeAgentConfig({ store: historicalStore, config: { ...enabledConfig, version: 1, artifactId: manifest.artifactId, juiceHome } });
	const spec = buildAgentLaunch({ store: historicalStore, env: baseEnv });
	assert.equal(spec.env.AGENT_JUICE_ENABLED, "1");
	assert.equal(spec.env.AGENT_JUICE_STATE, join(juiceHome, "run.v3.json"));
	assert.equal(spec.env.AGENT_JUICE_PI_ROOT, piRoot);
	assert.equal(spec.env.AGENT_RUNTIME_ENABLED, undefined);
	assert.equal(readFileSync(join(destination, MANIFEST_FILE), "utf8"), before);
});

// ---------------------------------------------------------------- configuração

test("config: ausente é null, roundtrip atômico valida e preserva resourceReceipt", () => {
	const fresh = fixtureStore("config");
	assert.equal(readAgentConfig(fresh), null);
	const receipt = join(root, "receipts", "recibo.json");
	const written = writeAgentConfig({ store: fresh, config: { ...enabledConfig, resourceReceipt: receipt } });
	assert.equal(written.path, agentConfigPath(fresh));
	assert.deepEqual(readAgentConfig(fresh), { ...enabledConfig, resourceReceipt: receipt });
	// Fora de <store>/agent, que o setup legado substitui inteiro a cada ativação.
	assert.ok(!written.path.startsWith(join(fresh, "agent", "/")));
	assert.equal(written.path, join(fresh, "runtime", "config.json"));
	const reread = readAgentConfig(fresh);
	assert.equal(reread.resourceReceipt, receipt);
	// Sem recibo o campo simplesmente não existe (nem null, nem inventado).
	writeAgentConfig({ store: fresh, config: enabledConfig });
	assert.equal("resourceReceipt" in readAgentConfig(fresh), false);
});

test("config: schema fechado recusa preferência pessoal, caminho relativo e tipo errado", () => {
	const fresh = fixtureStore("config-bad");
	const cases = [
		[{ ...enabledConfig, defaultModel: "anthropic/claude-opus-5-5" }, /chave desconhecida/],
		[{ ...enabledConfig, defaultThinkingLevel: "high" }, /chave desconhecida/],
		[{ ...enabledConfig, version: 99 }, /versão/],
		[{ ...enabledConfig, enabled: "sim" }, /booleano/],
		[{ ...enabledConfig, artifactId: "../../etc/passwd" }, /artifactId/],
		[{ ...enabledConfig, piRoot: "relativo/pi" }, /absoluto/],
		[{ ...enabledConfig, version: 1, juiceHome: `${root}/ledger/../ledger/juice` }, /\.\./],
		[{ ...enabledConfig, resourceReceipt: "~/recibo.json" }, /absoluto|~/],
		[[], /objeto JSON/],
	];
	for (const [config, pattern] of cases) assert.throws(() => writeAgentConfig({ store: fresh, config }), pattern);
	assert.equal(readAgentConfig(fresh), null, "nenhuma config inválida é gravada");
});

test("config ilegível ou que é link não cai em fallback silencioso", () => {
	const fresh = fixtureStore("config-broken");
	mkdirSync(join(fresh, "runtime"), { recursive: true });
	writeFileSync(agentConfigPath(fresh), "{ não é json");
	assert.throws(() => readAgentConfig(fresh), /não é JSON válido/);
	rmSync(agentConfigPath(fresh));
	writeFileSync(join(root, "config-alheia.json"), JSON.stringify(enabledConfig));
	symlinkSync(join(root, "config-alheia.json"), agentConfigPath(fresh));
	assert.throws(() => readAgentConfig(fresh), /arquivo regular/);
});

// ---------------------------------------------------------------- lançamento

test("default desligado: sem configuração o lançamento é legado, sem AGENT_JUICE_*", () => {
	const fresh = fixtureStore("legacy");
	const spec = buildAgentLaunch({ store: fresh, env: baseEnv, args: ["--help"] });
	assert.equal(spec.mode, "legacy");
	assert.equal(spec.command, join(fresh, "current", "bin", "pi"));
	assert.deepEqual(spec.args, ["--help"]);
	assert.equal(Object.keys(spec.env).some((key) => key.startsWith("AGENT_JUICE_")), false);
	assert.equal(spec.env.HOME, baseEnv.HOME);
});

test(`${DISABLE_ENV}=1 volta ao legado e limpa contabilização fantasma herdada`, () => {
	writeAgentConfig({ store, config: enabledConfig });
	const dirty = {
		...baseEnv,
		[DISABLE_ENV]: "1",
		AGENT_JUICE_ENABLED: "1",
		AGENT_JUICE_BIN: "/antigo/agent-juice",
		AGENT_JUICE_SKILLS_BEFORE: JSON.stringify("minha-skill"),
		PI_AUTOMATIC_SKILLS: "peers,megamind,prometheus,tasks",
		AGENT_ARTIFACT: "antigo",
		NODE_OPTIONS: `--enable-source-maps --import=file:///velho/agent/juice/runtime.mjs`,
	};
	const spec = buildAgentLaunch({ store, env: dirty, args: ["chat"] });
	assert.equal(spec.mode, "legacy");
	assert.match(spec.reason, /AGENT_DISABLED=1/);
	assert.equal(Object.keys(spec.env).some((key) => key.startsWith("AGENT_JUICE_") || key === "AGENT_ARTIFACT"), false);
	assert.equal(spec.env.NODE_OPTIONS, "--enable-source-maps");
	assert.equal(spec.env.PI_AUTOMATIC_SKILLS, "minha-skill", "opt-out restaura curadoria nativa do usuário");
	const noPrevious = buildAgentLaunch({ store, env: { ...dirty, AGENT_JUICE_SKILLS_BEFORE: "null" } });
	assert.equal(noPrevious.env.PI_AUTOMATIC_SKILLS, undefined, "sem env anterior, opt-out remove a curadoria do Agent");
	assert.ok(spec.warnings.some((warning) => /preload herdado/.test(warning)));
});

test("habilitado: lança a entrada clássica da release física por process.execPath, sem subprocesso pi", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const spec = buildAgentLaunch({ store, env: { ...baseEnv, AGENT_JUICE_PI_ENTRY: "bundle", PI_DURABLE_HOST: "1" }, args: ["-p", "oi", "--session", "/tmp/s.jsonl"] });
	assert.equal(spec.mode, "agent");
	assert.equal(spec.command, process.execPath);
	assert.deepEqual(spec.args, [join(prepared.piRoot, PI_ENTRY), "-p", "oi", "--session", "/tmp/s.jsonl"]);
	assert.equal(spec.env.AGENT_RUNTIME_ENABLED, "1");
	assert.equal(spec.env.AGENT_JUICE_BIN, undefined);
	assert.equal(spec.env.AGENT_JUICE_HOME, undefined);
	assert.equal(spec.env.AGENT_JUICE_STATE, undefined);
	assert.equal(spec.env.AGENT_PI_ROOT, prepared.piRoot);
	assert.equal(spec.env.AGENT_JUICE_PI_ENTRY, undefined);
	assert.equal(spec.env.PI_DURABLE_HOST, "0");
	assert.equal(spec.env.AGENT_ARTIFACT, prepared.artifactId);
	for (const key of ["AGENT_PI_ROOT"]) {
		assert.ok(spec.env[key].startsWith("/") || /^[A-Za-z]:\\/.test(spec.env[key]), `${key} tem de ser absoluto`);
	}
	assert.equal(spec.env.NODE_OPTIONS, `--import=${pathToFileURL(join(prepared.agentRoot, RUNTIME_PRELOAD)).href}`);
	// Nenhum caminho do artefato/release passa por um ponteiro mutável.
	for (const value of [spec.env.AGENT_PI_ROOT, spec.args[0], spec.env.NODE_OPTIONS]) {
		assert.ok(!value.includes("/current/"), `${value} não pode depender de "current"`);
	}
});

test("launcher novo descarta Juice herdado sem acessar ledger", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const epHome = realpathSync(mkdtempSync(join(tmpdir(), "agent-ep-")));
	const epState = join(epHome, "ledger.json");
	const plain = buildAgentLaunch({ store, env: { ...baseEnv, AGENT_JUICE_HOME: epHome, AGENT_JUICE_STATE: epState }, args: ["-p", "x"] });
	assert.equal(plain.env.AGENT_JUICE_HOME, undefined);
	assert.equal(plain.env.AGENT_JUICE_STATE, undefined);
});

test("o ambiente real do usuário passa intacto: HOME, agent dir, modelos, thinking e extras", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const personal = {
		...baseEnv,
		PI_MODEL: "anthropic/claude-opus-5-5",
		PI_REASONING_LEVEL: "high",
		PI_OFFLINE: "0",
		ANTHROPIC_API_KEY: "não-tocar",
		AGENT_JUICE_CHILD: "1",
	};
	const spec = buildAgentLaunch({ store, env: personal, args: [] });
	for (const key of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_SYSTEM_DIR", "XDG_CONFIG_HOME", "PI_MODEL", "PI_REASONING_LEVEL", "PI_OFFLINE", "ANTHROPIC_API_KEY", "LANG", "TERM"]) {
		assert.equal(spec.env[key], personal[key], `${key} foi alterado pelo launcher`);
	}
	// Nada de transplante do piloto nem de preferência imposta.
	const added = Object.keys(spec.env).filter((key) => !(key in personal));
	assert.deepEqual(added.sort(), ["AGENT_ARTIFACT", "AGENT_PI_ROOT", "AGENT_RUNTIME_ENABLED", "NODE_OPTIONS", "PI_CACHE_RETENTION", "PI_DURABLE_HOST", "PI_SKIP_VERSION_CHECK"]);
	// Aviso de versão do Pi upstream calado por padrão; valor do usuário (inclusive vazio) prevalece.
	assert.equal(spec.env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(buildAgentLaunch({ store, env: { ...personal, PI_SKIP_VERSION_CHECK: "" }, args: [] }).env.PI_SKIP_VERSION_CHECK, "");
	// Cache de 1 h por padrão; valor do usuário prevalece.
	assert.equal(spec.env.PI_CACHE_RETENTION, "long");
	assert.equal(buildAgentLaunch({ store, env: { ...personal, PI_CACHE_RETENTION: "none" }, args: [] }).env.PI_CACHE_RETENTION, "none");
	// AGENT_JUICE_CHILD herdado sairia como "filho sem pai": este processo é o pai do run.
	assert.equal("AGENT_JUICE_CHILD" in spec.env, false);
});

test("NODE_OPTIONS do usuário é preservado e o preload entra uma única vez", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const ours = `--import=${pathToFileURL(join(prepared.agentRoot, RUNTIME_PRELOAD)).href}`;
	const first = buildAgentLaunch({ store, env: { ...baseEnv, NODE_OPTIONS: "--max-old-space-size=8192 --enable-source-maps" }, args: [] });
	assert.equal(first.env.NODE_OPTIONS, `--max-old-space-size=8192 --enable-source-maps ${ours}`);
	// Relançar dentro de um ambiente que já tem o preload não duplica import.
	const second = buildAgentLaunch({ store, env: { ...baseEnv, NODE_OPTIONS: first.env.NODE_OPTIONS }, args: [] });
	assert.equal(second.env.NODE_OPTIONS, first.env.NODE_OPTIONS);
	assert.equal(second.env.NODE_OPTIONS.split(ours).length - 1, 1);
	// Preload de OUTRO Agent (piloto, artefato antigo) sai, com aviso explícito.
	const third = buildAgentLaunch({ store, env: { ...baseEnv, NODE_OPTIONS: `--import=file:///perfil/piloto/agent/juice/runtime.mjs --trace-warnings` }, args: [] });
	assert.equal(third.env.NODE_OPTIONS, `--trace-warnings ${ours}`);
	const quoted = buildAgentLaunch({ store, env: { ...baseEnv, NODE_OPTIONS: '--require "unrelated module with spaces.cjs" --import "file:///old path/juice/runtime.mjs" --trace-warnings' } });
	assert.equal(quoted.env.NODE_OPTIONS, `--require "unrelated module with spaces.cjs" --trace-warnings ${ours}`);
	assert.ok(third.warnings.some((warning) => /preload herdado/.test(warning)));
});

test("versão fixa por processo: promover outra release não muda a especificação já resolvida", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const before = buildAgentLaunch({ store, env: baseEnv, args: [] });
	const other = fakePiRoot("release-c");
	rmSync(join(store, "current"), { recursive: true, force: true });
	symlinkSync(other, join(store, "current"));
	const after = buildAgentLaunch({ store, env: baseEnv, args: [] });
	assert.deepEqual(after.args, before.args);
	assert.equal(after.env.AGENT_PI_ROOT, before.env.AGENT_PI_ROOT);
	assert.equal(after.env.AGENT_PI_ROOT, prepared.piRoot);
	assert.ok(!before.args[0].includes(other), "a sessão não pode seguir o ponteiro current");
	// Restaura o `current` de fixture para os testes seguintes.
	rmSync(join(store, "current"), { recursive: true, force: true });
	mkdirSync(join(store, "current", "bin"), { recursive: true });
	writeFileSync(join(store, "current", "bin", "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

test("habilitado com artefato/ledger/config quebrado: erro, nunca lançamento sem contabilização", () => {
	const fresh = fixtureStore("fail-closed");
	const victim = prepareAgentArtifact({ sourceRoot: fixtureSource("src-fc"), store: fresh, piRoot, ...quiet });
	writeAgentConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId } });
	assert.equal(buildAgentLaunch({ store: fresh, env: baseEnv, args: [] }).mode, "agent");
	// juiceHome inexistente.
	assert.throws(() => writeAgentConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId, juiceHome: join(root, "ledger-fantasma") } }), /juiceHome/);
	assert.equal(buildAgentLaunch({ store: fresh, env: baseEnv }).mode, "agent");
	// piRoot mutável na configuração: o artefato valida (o link resolve para a mesma release), mas um
	// ponteiro trocaria de versão no meio da sessão, então o lançamento é recusado.
	const link = join(root, "pi-roots", "current-cfg");
	rmSync(link, { recursive: true, force: true });
	symlinkSync(piRoot, link);
	writeAgentConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId, piRoot: link } });
	assert.throws(() => buildAgentLaunch({ store: fresh, env: baseEnv, args: [] }), /caminho físico/);
	// Artefato apagado embaixo da configuração.
	writeAgentConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId } });
	rmSync(victim.artifactRoot, { recursive: true, force: true });
	assert.throws(() => buildAgentLaunch({ store: fresh, env: baseEnv, args: [] }), /não está instalado/);
});

test("enabled:false é desligamento explícito, sem contabilização e sem erro", () => {
	const fresh = fixtureStore("disabled");
	prepareAgentArtifact({ sourceRoot: source, store: fresh, piRoot, ...quiet });
	writeAgentConfig({ store: fresh, config: { ...enabledConfig, enabled: false } });
	const spec = buildAgentLaunch({ store: fresh, env: baseEnv, args: ["x"] });
	assert.equal(spec.mode, "legacy");
	assert.match(spec.reason, /enabled:false/);
	assert.equal(Object.keys(spec.env).some((key) => key.startsWith("AGENT_JUICE_")), false);
});

// ---------------------------------------------------------------- wrapper

test("o wrapper despacha manutenção antes do runtime e só chama o launcher no caminho normal", () => {
	const wrapper = readFileSync(join(repo, "scripts", "agent-wrapper.sh"), "utf8");
	const dispatch = wrapper.indexOf("overlay-update)");
	const esac = wrapper.indexOf("esac");
	const agent = wrapper.indexOf('exec node "$AGENT_LAUNCHER"');
	assert.ok(dispatch > 0 && esac > dispatch && agent > esac, "o bloco Agent tem de vir depois do dispatch de manutenção");
	assert.match(wrapper, /\[ -f "\$AGENT_LAUNCHER" \]/);
	assert.match(wrapper, /exec node "\$AGENT_LAUNCHER" --store "\$STORE" -- "\$@"/);
	// Launcher ausente com opt-in ligado: erro, não "pi sem Agent" silencioso.
	assert.match(wrapper, /exit 1/);
	const cmd = readFileSync(join(repo, "scripts", "agent-wrapper.cmd"), "utf8");
	assert.match(cmd, /^:normal$/m);
	assert.ok(cmd.indexOf(":normal") < cmd.indexOf('node "%AGENT_LAUNCHER%"'));
	assert.ok(cmd.indexOf("goto :normal") > cmd.indexOf('if /i "%~1"=="update" goto :update'));
	assert.match(cmd, /if exist "%AGENT_LAUNCHER%" goto :agent_launch/);
	assert.match(cmd, /if exist "%AGENT_CONFIG%" goto :agent_missing/);
	assert.match(cmd, /node "%AGENT_LAUNCHER%" --store "%STORE%" -- %\*/);
	assert.ok(cmd.includes(":agent_missing"));
	// O despacho de manutenção continua intacto nos dois.
	for (const text of [wrapper, cmd]) {
		for (const route of ["overlay-update", "overlay-rollback", "update"]) assert.ok(text.includes(route));
	}
});

// ---------------------------------------------------------------- CLI

function runLauncher(args, env, { timeout = 20000 } = {}) {
	return spawnSync(process.execPath, [launcher, ...args], {
		encoding: "utf8",
		timeout,
		env: { PATH: process.env.PATH, ...env },
	});
}

test("CLI --print-spec usa o helper e não executa nada", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const out = join(root, "cli-print.json");
	const result = runLauncher(["--store", store, "--print-spec", "--", "-p", "oi"], { ...baseEnv, AGENT_TEST_OUT: out, EXAMPLE_SECRET: "sentinela-privada-nao-imprimir" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(!result.stdout.includes("sentinela-privada-nao-imprimir"), "diagnóstico não despeja ambiente privado");
	const spec = JSON.parse(result.stdout);
	assert.equal(spec.mode, "agent");
	assert.deepEqual(spec.args, [join(prepared.piRoot, PI_ENTRY), "-p", "oi"]);
	assert.ok(!existsSync(out), "--print-spec não lança o Pi");
});

test("CLI lança o Pi com o preload uma vez, repassa argumentos e propaga o código de saída", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const out = join(root, "cli-run.json");
	const preloadLog = join(root, "cli-preload.log");
	rmSync(out, { force: true });
	rmSync(preloadLog, { force: true });
	const result = runLauncher(["--store", store, "--", "--session", "/tmp/x.jsonl", "--", "-p", "oi"], {
		...baseEnv,
		AGENT_TEST_OUT: out,
		AGENT_TEST_PRELOAD: preloadLog,
		AGENT_TEST_EXIT: "7",
	});
	assert.equal(result.status, 7, `${result.stdout}${result.stderr}`);
	const observed = JSON.parse(readFileSync(out, "utf8"));
	assert.deepEqual(observed.argv, ["--session", "/tmp/x.jsonl", "--", "-p", "oi"]);
	assert.equal(observed.env.AGENT_RUNTIME_ENABLED, "1");
	assert.equal(observed.env.AGENT_PI_ROOT, prepared.piRoot);
	assert.equal(observed.env.HOME, baseEnv.HOME);
	assert.equal(observed.env.PI_CODING_AGENT_DIR, baseEnv.PI_CODING_AGENT_DIR);
	assert.equal(observed.execPath, process.execPath);
	// Preload do artefato, exatamente uma vez, a partir do artefato (não do checkout).
	const preloads = readFileSync(preloadLog, "utf8").trim().split("\n");
	assert.equal(preloads.length, 1, preloads.join(" "));
	assert.equal(preloads[0], pathToFileURL(join(prepared.agentRoot, RUNTIME_PRELOAD)).href);
});

test("CLI com opt-out executa o Pi legado da release ativa", () => {
	writeAgentConfig({ store, config: enabledConfig });
	const marker = join(root, "legacy-marker");
	rmSync(marker, { force: true });
	writeFileSync(join(store, "current", "bin", "pi"), `#!/bin/sh\necho "$@" > ${marker}\nexit 3\n`, { mode: 0o755 });
	const result = runLauncher(["--store", store, "--", "--version"], { ...baseEnv, [DISABLE_ENV]: "1" });
	assert.equal(result.status, 3, result.stderr);
	assert.equal(readFileSync(marker, "utf8").trim(), "--version");
});

test("CLI falha fechado com diagnóstico (exit 70) quando a configuração não serve", () => {
	const fresh = fixtureStore("cli-bad");
	mkdirSync(join(fresh, "runtime"), { recursive: true });
	writeFileSync(agentConfigPath(fresh), JSON.stringify({ ...enabledConfig, artifactId: "d".repeat(64) }));
	const result = runLauncher(["--store", fresh, "--", "-p", "oi"], baseEnv);
	assert.equal(result.status, 70);
	assert.match(result.stderr, /Agent/);
	assert.match(result.stderr, /não foi iniciado/);
	assert.match(result.stderr, new RegExp(`${DISABLE_ENV}=1`));
});

test("CLI encaminha sinais ao Pi: filho que trata sai com o próprio código", async () => {
	writeAgentConfig({ store, config: enabledConfig });
	const ready = join(root, "signal-ready");
	const signals = join(root, "signal-log");
	rmSync(ready, { force: true });
	rmSync(signals, { force: true });
	const child = spawn(process.execPath, [launcher, "--store", store, "--"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH, ...baseEnv, AGENT_TEST_WAIT: "1", AGENT_TEST_READY: ready, AGENT_TEST_SIGNALS: signals },
	});
	const done = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
	const deadline = Date.now() + 15000;
	while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	assert.ok(existsSync(ready), "o Pi de fixture não chegou a iniciar");
	child.kill("SIGTERM");
	const exit = await done;
	assert.equal(readFileSync(signals, "utf8").trim(), "SIGTERM", "o sinal tem de chegar ao filho");
	assert.deepEqual(exit, { code: 42, signal: null }, `launcher saiu com ${JSON.stringify(exit)}`);
});

test("CLI morre do mesmo sinal quando o Pi morre do sinal", async () => {
	writeAgentConfig({ store, config: enabledConfig });
	const ready = join(root, "signal-ready-2");
	rmSync(ready, { force: true });
	const child = spawn(process.execPath, [launcher, "--store", store, "--"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH, ...baseEnv, AGENT_TEST_WAIT: "2", AGENT_TEST_READY: ready },
	});
	const done = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
	const deadline = Date.now() + 15000;
	while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	assert.ok(existsSync(ready), "o Pi de fixture não chegou a iniciar");
	child.kill("SIGTERM");
	const exit = await done;
	assert.deepEqual(exit, { code: null, signal: "SIGTERM" }, `launcher saiu com ${JSON.stringify(exit)}`);
});

function hashOf(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
	for (const [name, fn] of tests) {
		await fn();
		checks++;
		console.log(`ok ${name}`);
	}
	console.log(`\nPASS ${checks}/${tests.length} (fixtures em ${root})`);
} catch (error) {
	console.error(`\nFAIL após ${checks}/${tests.length}: ${error.message}`);
	console.error(error.stack);
	process.exitCode = 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}
