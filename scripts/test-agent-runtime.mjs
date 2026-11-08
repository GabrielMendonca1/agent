#!/usr/bin/env node
/**
 * MARK II instalado: artefato, configuração e launcher.
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

process.env.MARK_RUST_AUTO_INSTALL = "0"; // nenhum teste instala Rust de verdade
process.env.MARK_WARM_START = "0"; // nem aquece o cache abrindo o pi instalado

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
	MARK_SUBDIR,
	PI_ENTRY,
	RUNTIME_PRELOAD,
	buildMarkIILaunch,
	markIIConfigPath,
	prepareMarkIIArtifact,
	readMarkIIConfig,
	validateMarkIIArtifact,
	writeMarkIIConfig,
} from "./lib/mark-ii-runtime.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repo, "scripts", "mark-ii-launch.mjs");
// realpath: /var/folders -> /private/var/folders no macOS. Os caminhos do contrato são físicos.
const root = realpathSync(mkdtempSync(join(tmpdir(), "mark-ii-runtime-test-")));
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
const out = process.env.MARK_II_TEST_OUT;
if (out) writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), env: process.env, execPath: process.execPath }));
if (process.env.MARK_II_TEST_WAIT) {
  // WAIT=1: trata o sinal e sai com 42. WAIT=2: nao trata nada e morre do proprio sinal.
  if (process.env.MARK_II_TEST_WAIT === "1") {
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { appendFileSync(process.env.MARK_II_TEST_SIGNALS, signal + "\\n"); process.exit(42); });
  }
  writeFileSync(process.env.MARK_II_TEST_READY, "ready");
  setTimeout(() => process.exit(99), 10000);
} else process.exit(Number(process.env.MARK_II_TEST_EXIT ?? 0));
`,
	);
	return piRoot;
}

/** Árvore `mark/` de fixture: preload que só registra que rodou, mais lixo que não deve viajar. */
function fixtureSource(name = "src") {
	const source = join(root, name);
	const mark = join(source, MARK_SUBDIR);
	mkdirSync(join(mark, "juice"), { recursive: true });
	writeFileSync(
		join(mark, RUNTIME_PRELOAD),
		`import { appendFileSync } from "node:fs";
if (process.env.MARK_II_TEST_PRELOAD) appendFileSync(process.env.MARK_II_TEST_PRELOAD, import.meta.url + "\\n");
`,
	);
	// O nome entra no conteúdo: cada fixture é um artefato distinto (o digest é do conteúdo).
	writeFileSync(join(mark, "juice", "client.mjs"), `export const juiceEnabled = () => true; // ${name}\n`);
	mkdirSync(join(mark, "extensions", "brain-live"), { recursive: true });
	writeFileSync(join(mark, "extensions", "brain-live", "juice.ts"), "export default {};\n");
	mkdirSync(join(mark, "extensions", "mark", "tui"), { recursive: true });
	writeFileSync(join(mark, "extensions", "mark", "tui", "compact-tools.ts"), "export const compactTools = true;\n");
	writeFileSync(join(mark, "extensions", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// Produtos de build e ruído local nunca entram no artefato.
	mkdirSync(join(mark, "node_modules"), { recursive: true });
	writeFileSync(join(mark, "node_modules", "x.js"), "module.exports = 1;\n");
	writeFileSync(join(mark, ".DS_Store"), "lixo\n");
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
	mkdirSync(join(artifact.markRoot, 'mass-core'));
	writeFileSync(join(artifact.markRoot, 'mass-core/Cargo.toml'), 'legacy vendor sources\n');
	manifest.files['mass-core/Cargo.toml'] = `-${hashOf(join(artifact.markRoot, 'mass-core/Cargo.toml'))}`;
	const brokerPath = join(artifact.artifactRoot, BROKER_SUBDIR, BROKER_NAME);
	mkdirSync(dirname(brokerPath)); writeBroker(brokerPath); chmodSync(brokerPath, 0o555);
	manifest.version = 1;
	manifest.broker = { path: `${BROKER_SUBDIR}/${BROKER_NAME}`, sha256: hashOf(brokerPath), platform: process.platform, arch: process.arch, format: { darwin: 'mach-o', linux: 'elf', win32: 'pe' }[process.platform] };
	const hash = createHash('sha256').update(`mark-ii-artifact v1\0${process.platform}\0${process.arch}\0${manifest.piRoot}\0${manifest.piEntry}\0`).update(`broker\0${manifest.broker.sha256}\0`);
	for (const [file, value] of Object.entries(manifest.files).sort((a,b) => a[0] < b[0] ? -1 : 1)) hash.update(`F ${file}\0${value}\0`);
	manifest.artifactId = hash.digest('hex');
	chmodSync(artifact.manifestPath, 0o644); writeFileSync(artifact.manifestPath, JSON.stringify(manifest));
	renameSync(artifact.artifactRoot, join(dirname(artifact.artifactRoot), manifest.artifactId));
	return validateMarkIIArtifact({ store, artifactId: manifest.artifactId });
}
const quiet = { log: () => {} };
const source = fixtureSource();
const piRoot = fakePiRoot("release-a");
const store = fixtureStore("main");
const prepared = prepareMarkIIArtifact({ sourceRoot: source, store, piRoot, ...quiet });

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
	juiceHome,
};

// ---------------------------------------------------------------- artefato

test("prepare instala o artefato completo, com markRoot=artifactRoot/mark e manifesto conferível", () => {
	assert.equal(prepared.artifactRoot, join(realpathSync(store), "mark-ii", "releases", prepared.artifactId));
	assert.equal(prepared.markRoot, join(prepared.artifactRoot, MARK_SUBDIR));
	assert.equal(prepared.manifestPath, join(prepared.artifactRoot, MANIFEST_FILE));
	assert.equal(prepared.piRoot, realpathSync(piRoot));
	assert.match(prepared.artifactId, /^[0-9a-f]{64}$/);
	const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
	assert.equal(manifest.platform, process.platform);
	assert.equal(manifest.arch, process.arch);
	assert.equal(manifest.piEntry, PI_ENTRY);
	assert.equal(manifest.version, 2);
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
	assert.equal(statSync(join(prepared.markRoot, RUNTIME_PRELOAD)).mode & 0o222, 0, "arquivo do artefato não pode ser gravável");
	assert.equal(statSync(prepared.manifestPath).mode & 0o222, 0);
	assert.equal(readMarkIIConfig(store), null, "prepare não escreve configuração");
	assert.ok(!existsSync(markIIConfigPath(store)));
	assert.equal(JSON.parse(readFileSync(join(juiceHome, "run.json"), "utf8")).runId, "pre-existente");
	assert.equal(readFileSync(join(store, "current", "bin", "pi"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("prepare é idempotente: mesmo conteúdo e mesmo par Pi devolvem o mesmo artefato", () => {
	const again = prepareMarkIIArtifact({ sourceRoot: source, store, piRoot, ...quiet });
	assert.equal(again.artifactId, prepared.artifactId);
	assert.equal(again.artifactRoot, prepared.artifactRoot);
});

test("o artefato identifica o PAR Pi+MARK II: outra release Pi é outro artefato", () => {
	const other = fakePiRoot("release-b");
	const second = prepareMarkIIArtifact({ sourceRoot: source, store, piRoot: other, ...quiet });
	assert.notEqual(second.artifactId, prepared.artifactId);
	assert.equal(second.piRoot, realpathSync(other));
	// E cada um valida só contra o seu Pi.
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: second.artifactId, piRoot }), /preparado para/);
});

test("prepare recusa piRoot mutável (current), sem ModelRuntime, e origem sem preload", () => {
	const link = join(root, "pi-roots", "current-link");
	rmSync(link, { recursive: true, force: true });
	symlinkSync(piRoot, link);
	assert.throws(() => prepareMarkIIArtifact({ sourceRoot: source, store, piRoot: link, ...quiet }), /caminho físico/);
	const classic = join(root, "pi-roots", "classic");
	mkdirSync(join(classic, "dist"), { recursive: true });
	writeFileSync(join(classic, "dist", "cli.js"), "");
	assert.throws(() => prepareMarkIIArtifact({ sourceRoot: source, store, piRoot: classic, ...quiet }), /CLI clássico e ModelRuntime/);
	const bare = join(root, "src-sem-preload");
	mkdirSync(join(bare, MARK_SUBDIR, "juice"), { recursive: true });
	writeFileSync(join(bare, MARK_SUBDIR, "juice", "client.mjs"), "");
	assert.throws(() => prepareMarkIIArtifact({ sourceRoot: bare, store, piRoot, ...quiet }), /sem o preload/);
});

test("prepare works without any native toolchain on PATH", () => {
 const saved = process.env.PATH; process.env.PATH = join(root, 'empty');
 try { assert.equal(prepareMarkIIArtifact({ sourceRoot: source, store, piRoot, ...quiet }).artifactId, prepared.artifactId); }
 finally { process.env.PATH = saved; }
});

test("validate recusa adulteração de arquivo, manifesto e arquivo extra", () => {
	const victim = prepareMarkIIArtifact({ sourceRoot: fixtureSource("src-tamper"), store, piRoot, ...quiet });
	const file = join(victim.markRoot, RUNTIME_PRELOAD);
	const original = readFileSync(file);
	chmodSync(file, 0o644);
	writeFileSync(file, "// código trocado\n");
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: victim.artifactId }), /alterado no artefato/);
	assert.throws(() => prepareMarkIIArtifact({ sourceRoot: join(root, "src-tamper"), store, piRoot, ...quiet }), /preservado para não remover/);
	assert.equal(readFileSync(file, "utf8"), "// código trocado\n", "prepare não remove artefato que pode estar em uso");
	writeFileSync(file, original);
	chmodSync(file, 0o444);
	assert.equal(validateMarkIIArtifact({ store, artifactId: victim.artifactId }).artifactId, victim.artifactId);

	// Manifesto reescrito de forma "coerente" com o arquivo trocado: o digest no NOME do diretório
	// não bate mais, e é essa conferência que impede a adulteração completa.
	const manifest = JSON.parse(readFileSync(victim.manifestPath, "utf8"));
	chmodSync(file, 0o644);
	writeFileSync(file, "// código trocado de novo\n");
	manifest.files[RUNTIME_PRELOAD] = `-${hashOf(file)}`;
	chmodSync(victim.manifestPath, 0o644);
	writeFileSync(victim.manifestPath, JSON.stringify(manifest, null, 2));
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: victim.artifactId }), /não corresponde ao seu identificador/);

	const extra = join(victim.markRoot, "intruso.mjs");
	writeFileSync(extra, "// não declarado\n");
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: victim.artifactId }), /não declarado no manifesto|não corresponde/);
	rmSync(victim.artifactRoot, { recursive: true, force: true });
});

test("validate recusa travessia, link no store, id inválido e broker removido", () => {
	for (const bad of ["../../etc", "..", "a/b", "", prepared.artifactId.toUpperCase(), `${prepared.artifactId}x`, null]) {
		assert.throws(() => validateMarkIIArtifact({ store, artifactId: bad }), /artifactId inválido/);
	}
	// Um "artefato" que é link para outro diretório é recusado (o digest viveria fora do store).
	const releases = join(realpathSync(store), "mark-ii", "releases");
	const fakeId = "b".repeat(64);
	const outside = join(root, "fora-do-store");
	mkdirSync(outside, { recursive: true });
	symlinkSync(outside, join(releases, fakeId));
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: fakeId }), /link simbólico/);
	rmSync(join(releases, fakeId), { force: true });
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: "c".repeat(64) }), /não está instalado/);

	const victim = legacyArtifact(prepareMarkIIArtifact({ sourceRoot: fixtureSource("src-broker"), store, piRoot, ...quiet }), store);
	chmodSync(victim.brokerPath, 0o755);
	writeFileSync(victim.brokerPath, Buffer.concat([nativeHeader, Buffer.from("changed")]));
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: victim.artifactId }), /broker do artefato mudou/);
	rmSync(victim.brokerPath, { force: true });
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: victim.artifactId }), /broker do artefato.*não existe/s);
	rmSync(victim.artifactRoot, { recursive: true, force: true });
});

test("artefato durável histórico valida e lança bundle com ambiente antigo; prepare continua clássico", async () => {
	const historicalModule = join(root, "historical-runtime.mjs");
	writeFileSync(historicalModule, readFileSync(join(repo, "scripts/lib/mark-ii-runtime.mjs"), "utf8")
		.replace('export const PI_ENTRY = "dist/cli.js";', 'export const PI_ENTRY = "dist/bundle/cli.js";'));
	const historical = await import(pathToFileURL(historicalModule));
	const durablePi = fakePiRoot("durable");
	mkdirSync(join(durablePi, "dist/bundle"));
	writeFileSync(join(durablePi, "dist/bundle/cli.js"), readFileSync(join(durablePi, PI_ENTRY)));
	rmSync(join(durablePi, PI_ENTRY));
	const old = legacyArtifact(historical.prepareMarkIIArtifact({ sourceRoot: source, store, piRoot: durablePi, ...quiet }), store);
	assert.equal(validateMarkIIArtifact({ store, artifactId: old.artifactId }).piEntry, join(durablePi, "dist/bundle/cli.js"));
	assert.throws(() => prepareMarkIIArtifact({ sourceRoot: source, store, piRoot: durablePi, ...quiet }), /CLI clássico/);
	writeMarkIIConfig({ store, config: { ...enabledConfig, artifactId: old.artifactId, piRoot: durablePi } });
	for (const durableHost of [undefined, "1"]) {
		const env = { ...baseEnv, MARK_JUICE_PI_ENTRY: "stale" };
		if (durableHost !== undefined) env.PI_DURABLE_HOST = durableHost;
		const spec = buildMarkIILaunch({ store, env, args: ["--version"] });
		assert.deepEqual(spec.args, [join(durablePi, "dist/bundle/cli.js"), "--version"]);
		assert.equal(spec.env.MARK_JUICE_PI_ENTRY, "bundle");
		assert.equal(spec.env.MARK_JUICE_BIN, old.brokerPath);
		assert.equal(spec.env.MARK_JUICE_HOME, juiceHome);
		assert.equal(spec.env.MARK_JUICE_STATE, join(juiceHome, "run.json"));
		assert.equal(spec.env.PI_DURABLE_HOST, durableHost);
		assert.equal(spec.preload, `--import=${pathToFileURL(join(old.markRoot, RUNTIME_PRELOAD)).href}`);
	}
	const out = join(root, "durable-observed.json");
	const launched = runLauncher(["--store", store, "--", "--version"], { ...baseEnv, MARK_II_TEST_OUT: out });
	assert.equal(launched.status, 0, launched.stderr);
	assert.equal(JSON.parse(readFileSync(out)).env.MARK_JUICE_PI_ENTRY, "bundle");
	const durableEntry = join(durablePi, "dist/bundle/cli.js");
	const durableCode = readFileSync(durableEntry);
	rmSync(durableEntry);
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: old.artifactId }), /não tem dist\/bundle\/cli.js/);
	const outside = join(root, "outside-entry");
	mkdirSync(outside);
	writeFileSync(join(outside, "cli.js"), durableCode);
	rmSync(join(durablePi, "dist/bundle"), { recursive: true });
	symlinkSync(outside, join(durablePi, "dist/bundle"), "junction");
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: old.artifactId }), /fora do caminho físico/);
	rmSync(join(durablePi, "dist/bundle"));
	mkdirSync(join(durablePi, "dist/bundle"));
	writeFileSync(durableEntry, durableCode);
	// Alterar a entrada para outra existente continua sendo adulteração do digest v1.
	writeFileSync(join(durablePi, PI_ENTRY), "");
	chmodSync(old.manifestPath, 0o644);
	const manifest = JSON.parse(readFileSync(old.manifestPath));
	for (const piEntry of ["../escape.js", "/tmp/escape.js", "dist/missing.js"]) {
		writeFileSync(old.manifestPath, JSON.stringify({ ...manifest, piEntry }));
		assert.throws(() => validateMarkIIArtifact({ store, artifactId: old.artifactId }), /entrada do Pi/);
	}
	writeFileSync(old.manifestPath, JSON.stringify({ ...manifest, piEntry: PI_ENTRY }));
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: old.artifactId }), /não corresponde ao seu identificador/);
	writeFileSync(old.manifestPath, JSON.stringify({ ...manifest, runtimePreload: "../escape.mjs" }));
	assert.throws(() => validateMarkIIArtifact({ store, artifactId: old.artifactId }), /runtimePreload/);
	writeMarkIIConfig({ store, config: enabledConfig });
});

// ---------------------------------------------------------------- configuração

test("config: ausente é null, roundtrip atômico valida e preserva resourceReceipt", () => {
	const fresh = fixtureStore("config");
	assert.equal(readMarkIIConfig(fresh), null);
	const receipt = join(root, "receipts", "recibo.json");
	const written = writeMarkIIConfig({ store: fresh, config: { ...enabledConfig, resourceReceipt: receipt } });
	assert.equal(written.path, markIIConfigPath(fresh));
	assert.deepEqual(readMarkIIConfig(fresh), { ...enabledConfig, resourceReceipt: receipt });
	// Fora de <store>/mark, que o setup legado substitui inteiro a cada ativação.
	assert.ok(!written.path.startsWith(join(fresh, "mark", "/")));
	assert.equal(written.path, join(fresh, "mark-ii", "config.json"));
	const reread = readMarkIIConfig(fresh);
	assert.equal(reread.resourceReceipt, receipt);
	// Sem recibo o campo simplesmente não existe (nem null, nem inventado).
	writeMarkIIConfig({ store: fresh, config: enabledConfig });
	assert.equal("resourceReceipt" in readMarkIIConfig(fresh), false);
});

test("config: schema fechado recusa preferência pessoal, caminho relativo e tipo errado", () => {
	const fresh = fixtureStore("config-bad");
	const cases = [
		[{ ...enabledConfig, defaultModel: "anthropic/claude-opus-5-5" }, /chave desconhecida/],
		[{ ...enabledConfig, defaultThinkingLevel: "high" }, /chave desconhecida/],
		[{ ...enabledConfig, version: 2 }, /versão/],
		[{ ...enabledConfig, enabled: "sim" }, /booleano/],
		[{ ...enabledConfig, artifactId: "../../etc/passwd" }, /artifactId/],
		[{ ...enabledConfig, piRoot: "relativo/pi" }, /absoluto/],
		[{ ...enabledConfig, juiceHome: `${root}/ledger/../ledger/juice` }, /\.\./],
		[{ ...enabledConfig, resourceReceipt: "~/recibo.json" }, /absoluto|~/],
		[[], /objeto JSON/],
	];
	for (const [config, pattern] of cases) assert.throws(() => writeMarkIIConfig({ store: fresh, config }), pattern);
	assert.equal(readMarkIIConfig(fresh), null, "nenhuma config inválida é gravada");
});

test("config ilegível ou que é link não cai em fallback silencioso", () => {
	const fresh = fixtureStore("config-broken");
	mkdirSync(join(fresh, "mark-ii"), { recursive: true });
	writeFileSync(markIIConfigPath(fresh), "{ não é json");
	assert.throws(() => readMarkIIConfig(fresh), /não é JSON válido/);
	rmSync(markIIConfigPath(fresh));
	writeFileSync(join(root, "config-alheia.json"), JSON.stringify(enabledConfig));
	symlinkSync(join(root, "config-alheia.json"), markIIConfigPath(fresh));
	assert.throws(() => readMarkIIConfig(fresh), /arquivo regular/);
});

// ---------------------------------------------------------------- lançamento

test("default desligado: sem configuração o lançamento é legado, sem MARK_JUICE_*", () => {
	const fresh = fixtureStore("legacy");
	const spec = buildMarkIILaunch({ store: fresh, env: baseEnv, args: ["--help"] });
	assert.equal(spec.mode, "legacy");
	assert.equal(spec.command, join(fresh, "current", "bin", "pi"));
	assert.deepEqual(spec.args, ["--help"]);
	assert.equal(Object.keys(spec.env).some((key) => key.startsWith("MARK_JUICE_")), false);
	assert.equal(spec.env.HOME, baseEnv.HOME);
});

test(`${DISABLE_ENV}=1 volta ao legado e limpa contabilização fantasma herdada`, () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const dirty = {
		...baseEnv,
		[DISABLE_ENV]: "1",
		MARK_JUICE_ENABLED: "1",
		MARK_JUICE_BIN: "/antigo/mark-juice",
		MARK_JUICE_SKILLS_BEFORE: JSON.stringify("minha-skill"),
		PI_AUTOMATIC_SKILLS: "peers,megamind,prometheus,tasks",
		MARK_II_ARTIFACT: "antigo",
		NODE_OPTIONS: `--enable-source-maps --import=file:///velho/mark/juice/runtime.mjs`,
	};
	const spec = buildMarkIILaunch({ store, env: dirty, args: ["chat"] });
	assert.equal(spec.mode, "legacy");
	assert.match(spec.reason, /MARK_II_DISABLED=1/);
	assert.equal(Object.keys(spec.env).some((key) => key.startsWith("MARK_JUICE_") || key === "MARK_II_ARTIFACT"), false);
	assert.equal(spec.env.NODE_OPTIONS, "--enable-source-maps");
	assert.equal(spec.env.PI_AUTOMATIC_SKILLS, "minha-skill", "opt-out restaura curadoria nativa do usuário");
	const noPrevious = buildMarkIILaunch({ store, env: { ...dirty, MARK_JUICE_SKILLS_BEFORE: "null" } });
	assert.equal(noPrevious.env.PI_AUTOMATIC_SKILLS, undefined, "sem env anterior, opt-out remove a curadoria do Mark");
	assert.ok(spec.warnings.some((warning) => /preload do MARK II removido/.test(warning)));
});

test("habilitado: lança a entrada clássica da release física por process.execPath, sem subprocesso pi", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const spec = buildMarkIILaunch({ store, env: { ...baseEnv, MARK_JUICE_PI_ENTRY: "bundle", PI_DURABLE_HOST: "1" }, args: ["-p", "oi", "--session", "/tmp/s.jsonl"] });
	assert.equal(spec.mode, "mark-ii");
	assert.equal(spec.command, process.execPath);
	assert.deepEqual(spec.args, [join(prepared.piRoot, PI_ENTRY), "-p", "oi", "--session", "/tmp/s.jsonl"]);
	assert.equal(spec.env.MARK_JUICE_ENABLED, "1");
	assert.equal(spec.env.MARK_JUICE_BIN, undefined);
	assert.equal(spec.env.MARK_JUICE_HOME, juiceHome);
	assert.equal(spec.env.MARK_JUICE_STATE, join(juiceHome, "run.v3.json"));
	assert.equal(spec.env.MARK_JUICE_PI_ROOT, prepared.piRoot);
	assert.equal(spec.env.MARK_JUICE_PI_ENTRY, undefined);
	assert.equal(spec.env.PI_DURABLE_HOST, "0");
	assert.equal(spec.env.MARK_II_ARTIFACT, prepared.artifactId);
	for (const key of ["MARK_JUICE_HOME", "MARK_JUICE_STATE", "MARK_JUICE_PI_ROOT"]) {
		assert.ok(spec.env[key].startsWith("/") || /^[A-Za-z]:\\/.test(spec.env[key]), `${key} tem de ser absoluto`);
	}
	assert.equal(spec.env.NODE_OPTIONS, `--import=${pathToFileURL(join(prepared.markRoot, RUNTIME_PRELOAD)).href}`);
	// Nenhum caminho do artefato/release passa por um ponteiro mutável.
	for (const value of [spec.env.MARK_JUICE_PI_ROOT, spec.args[0], spec.env.NODE_OPTIONS]) {
		assert.ok(!value.includes("/current/"), `${value} não pode depender de "current"`);
	}
});

test("launcher usa o Juice global configurado, não caminhos herdados", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const epHome = realpathSync(mkdtempSync(join(tmpdir(), "mark-ep-")));
	const epState = join(epHome, "ledger.json");
	const plain = buildMarkIILaunch({ store, env: { ...baseEnv, MARK_JUICE_HOME: epHome, MARK_JUICE_STATE: epState }, args: ["-p", "x"] });
	assert.equal(plain.env.MARK_JUICE_HOME, juiceHome);
	assert.equal(plain.env.MARK_JUICE_STATE, join(juiceHome, "run.v3.json"));
});

test("o ambiente real do usuário passa intacto: HOME, agent dir, modelos, thinking e extras", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const personal = {
		...baseEnv,
		PI_MODEL: "anthropic/claude-opus-5-5",
		PI_REASONING_LEVEL: "high",
		PI_OFFLINE: "0",
		ANTHROPIC_API_KEY: "não-tocar",
		MARK_JUICE_CHILD: "1",
	};
	const spec = buildMarkIILaunch({ store, env: personal, args: [] });
	for (const key of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_SYSTEM_DIR", "XDG_CONFIG_HOME", "PI_MODEL", "PI_REASONING_LEVEL", "PI_OFFLINE", "ANTHROPIC_API_KEY", "LANG", "TERM"]) {
		assert.equal(spec.env[key], personal[key], `${key} foi alterado pelo launcher`);
	}
	// Nada de transplante do piloto nem de preferência imposta.
	const added = Object.keys(spec.env).filter((key) => !(key in personal));
	assert.deepEqual(added.sort(), ["MARK_II_ARTIFACT", "MARK_JUICE_ENABLED", "MARK_JUICE_HOME", "MARK_JUICE_PI_ROOT", "MARK_JUICE_STATE", "NODE_OPTIONS", "PI_CACHE_RETENTION", "PI_DURABLE_HOST"]);
	// Cache de 1 h por padrão; valor do usuário prevalece.
	assert.equal(spec.env.PI_CACHE_RETENTION, "long");
	assert.equal(buildMarkIILaunch({ store, env: { ...personal, PI_CACHE_RETENTION: "none" }, args: [] }).env.PI_CACHE_RETENTION, "none");
	// MARK_JUICE_CHILD herdado sairia como "filho sem pai": este processo é o pai do run.
	assert.equal("MARK_JUICE_CHILD" in spec.env, false);
});

test("NODE_OPTIONS do usuário é preservado e o preload entra uma única vez", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const ours = `--import=${pathToFileURL(join(prepared.markRoot, RUNTIME_PRELOAD)).href}`;
	const first = buildMarkIILaunch({ store, env: { ...baseEnv, NODE_OPTIONS: "--max-old-space-size=8192 --enable-source-maps" }, args: [] });
	assert.equal(first.env.NODE_OPTIONS, `--max-old-space-size=8192 --enable-source-maps ${ours}`);
	// Relançar dentro de um ambiente que já tem o preload não duplica import.
	const second = buildMarkIILaunch({ store, env: { ...baseEnv, NODE_OPTIONS: first.env.NODE_OPTIONS }, args: [] });
	assert.equal(second.env.NODE_OPTIONS, first.env.NODE_OPTIONS);
	assert.equal(second.env.NODE_OPTIONS.split(ours).length - 1, 1);
	// Preload de OUTRO MARK II (piloto, artefato antigo) sai, com aviso explícito.
	const third = buildMarkIILaunch({ store, env: { ...baseEnv, NODE_OPTIONS: `--import=file:///perfil/piloto/mark/juice/runtime.mjs --trace-warnings` }, args: [] });
	assert.equal(third.env.NODE_OPTIONS, `--trace-warnings ${ours}`);
	assert.ok(third.warnings.some((warning) => /dois gates/.test(warning)));
});

test("versão fixa por processo: promover outra release não muda a especificação já resolvida", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const before = buildMarkIILaunch({ store, env: baseEnv, args: [] });
	const other = fakePiRoot("release-c");
	rmSync(join(store, "current"), { recursive: true, force: true });
	symlinkSync(other, join(store, "current"));
	const after = buildMarkIILaunch({ store, env: baseEnv, args: [] });
	assert.deepEqual(after.args, before.args);
	assert.equal(after.env.MARK_JUICE_PI_ROOT, before.env.MARK_JUICE_PI_ROOT);
	assert.equal(after.env.MARK_JUICE_PI_ROOT, prepared.piRoot);
	assert.ok(!before.args[0].includes(other), "a sessão não pode seguir o ponteiro current");
	// Restaura o `current` de fixture para os testes seguintes.
	rmSync(join(store, "current"), { recursive: true, force: true });
	mkdirSync(join(store, "current", "bin"), { recursive: true });
	writeFileSync(join(store, "current", "bin", "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

test("habilitado com artefato/ledger/config quebrado: erro, nunca lançamento sem contabilização", () => {
	const fresh = fixtureStore("fail-closed");
	const victim = prepareMarkIIArtifact({ sourceRoot: fixtureSource("src-fc"), store: fresh, piRoot, ...quiet });
	writeMarkIIConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId } });
	assert.equal(buildMarkIILaunch({ store: fresh, env: baseEnv, args: [] }).mode, "mark-ii");
	// juiceHome inexistente.
	writeMarkIIConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId, juiceHome: join(root, "ledger-fantasma") } });
	assert.throws(() => buildMarkIILaunch({ store: fresh, env: baseEnv, args: [] }), /juiceHome/);
	// piRoot mutável na configuração: o artefato valida (o link resolve para a mesma release), mas um
	// ponteiro trocaria de versão no meio da sessão, então o lançamento é recusado.
	const link = join(root, "pi-roots", "current-cfg");
	rmSync(link, { recursive: true, force: true });
	symlinkSync(piRoot, link);
	writeMarkIIConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId, piRoot: link } });
	assert.throws(() => buildMarkIILaunch({ store: fresh, env: baseEnv, args: [] }), /caminho físico/);
	// Artefato apagado embaixo da configuração.
	writeMarkIIConfig({ store: fresh, config: { ...enabledConfig, artifactId: victim.artifactId } });
	rmSync(victim.artifactRoot, { recursive: true, force: true });
	assert.throws(() => buildMarkIILaunch({ store: fresh, env: baseEnv, args: [] }), /não está instalado/);
});

test("enabled:false é desligamento explícito, sem contabilização e sem erro", () => {
	const fresh = fixtureStore("disabled");
	prepareMarkIIArtifact({ sourceRoot: source, store: fresh, piRoot, ...quiet });
	writeMarkIIConfig({ store: fresh, config: { ...enabledConfig, enabled: false } });
	const spec = buildMarkIILaunch({ store: fresh, env: baseEnv, args: ["x"] });
	assert.equal(spec.mode, "legacy");
	assert.match(spec.reason, /enabled:false/);
	assert.equal(Object.keys(spec.env).some((key) => key.startsWith("MARK_JUICE_")), false);
});

// ---------------------------------------------------------------- wrapper

test("o wrapper despacha manutenção antes do runtime e só chama o launcher no caminho normal", () => {
	const wrapper = readFileSync(join(repo, "scripts", "pi-overlay-wrapper.sh"), "utf8");
	const dispatch = wrapper.indexOf("overlay-update)");
	const esac = wrapper.indexOf("esac");
	const markII = wrapper.indexOf('exec node "$MARK_II_LAUNCHER"');
	assert.ok(dispatch > 0 && esac > dispatch && markII > esac, "o bloco MARK II tem de vir depois do dispatch de manutenção");
	assert.match(wrapper, /\[ "\$\{MARK_II_DISABLED:-\}" != "1" \] && \[ -f "\$MARK_II_CONFIG" \]/);
	assert.match(wrapper, /exec node "\$MARK_II_LAUNCHER" --store "\$STORE" -- "\$@"/);
	// Launcher ausente com opt-in ligado: erro, não "pi sem MARK II" silencioso.
	assert.match(wrapper, /exit 1/);
	const cmd = readFileSync(join(repo, "scripts", "pi-overlay-wrapper.cmd"), "utf8");
	assert.ok(cmd.indexOf(":normal") < cmd.indexOf('node "%MARK_II_LAUNCHER%"'));
	assert.ok(cmd.indexOf("goto :normal") > cmd.indexOf('if /i "%~1"=="update" goto :update'));
	assert.match(cmd, /if defined MARK_II_DISABLED \(if \/i "%MARK_II_DISABLED%"=="1" goto :delegate\)/);
	assert.match(cmd, /if not exist "%MARK_II_CONFIG%" goto :delegate/);
	assert.match(cmd, /node "%MARK_II_LAUNCHER%" --store "%STORE%" -- %\*/);
	assert.ok(cmd.includes(":markii_missing"));
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
	writeMarkIIConfig({ store, config: enabledConfig });
	const out = join(root, "cli-print.json");
	const result = runLauncher(["--store", store, "--print-spec", "--", "-p", "oi"], { ...baseEnv, MARK_II_TEST_OUT: out, EXAMPLE_SECRET: "sentinela-privada-nao-imprimir" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(!result.stdout.includes("sentinela-privada-nao-imprimir"), "diagnóstico não despeja ambiente privado");
	const spec = JSON.parse(result.stdout);
	assert.equal(spec.mode, "mark-ii");
	assert.deepEqual(spec.args, [join(prepared.piRoot, PI_ENTRY), "-p", "oi"]);
	assert.ok(!existsSync(out), "--print-spec não lança o Pi");
});

test("CLI lança o Pi com o preload uma vez, repassa argumentos e propaga o código de saída", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const out = join(root, "cli-run.json");
	const preloadLog = join(root, "cli-preload.log");
	rmSync(out, { force: true });
	rmSync(preloadLog, { force: true });
	const result = runLauncher(["--store", store, "--", "--session", "/tmp/x.jsonl", "--", "-p", "oi"], {
		...baseEnv,
		MARK_II_TEST_OUT: out,
		MARK_II_TEST_PRELOAD: preloadLog,
		MARK_II_TEST_EXIT: "7",
	});
	assert.equal(result.status, 7, `${result.stdout}${result.stderr}`);
	const observed = JSON.parse(readFileSync(out, "utf8"));
	assert.deepEqual(observed.argv, ["--session", "/tmp/x.jsonl", "--", "-p", "oi"]);
	assert.equal(observed.env.MARK_JUICE_ENABLED, "1");
	assert.equal(observed.env.MARK_JUICE_PI_ROOT, prepared.piRoot);
	assert.equal(observed.env.HOME, baseEnv.HOME);
	assert.equal(observed.env.PI_CODING_AGENT_DIR, baseEnv.PI_CODING_AGENT_DIR);
	assert.equal(observed.execPath, process.execPath);
	// Preload do artefato, exatamente uma vez, a partir do artefato (não do checkout).
	const preloads = readFileSync(preloadLog, "utf8").trim().split("\n");
	assert.equal(preloads.length, 1, preloads.join(" "));
	assert.equal(preloads[0], pathToFileURL(join(prepared.markRoot, RUNTIME_PRELOAD)).href);
});

test("CLI com opt-out executa o Pi legado da release ativa", () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const marker = join(root, "legacy-marker");
	rmSync(marker, { force: true });
	writeFileSync(join(store, "current", "bin", "pi"), `#!/bin/sh\necho "$@" > ${marker}\nexit 3\n`, { mode: 0o755 });
	const result = runLauncher(["--store", store, "--", "--version"], { ...baseEnv, [DISABLE_ENV]: "1" });
	assert.equal(result.status, 3, result.stderr);
	assert.equal(readFileSync(marker, "utf8").trim(), "--version");
});

test("CLI falha fechado com diagnóstico (exit 70) quando a configuração não serve", () => {
	const fresh = fixtureStore("cli-bad");
	mkdirSync(join(fresh, "mark-ii"), { recursive: true });
	writeFileSync(markIIConfigPath(fresh), JSON.stringify({ ...enabledConfig, artifactId: "d".repeat(64) }));
	const result = runLauncher(["--store", fresh, "--", "-p", "oi"], baseEnv);
	assert.equal(result.status, 70);
	assert.match(result.stderr, /MARK II/);
	assert.match(result.stderr, /não foi iniciado/);
	assert.match(result.stderr, new RegExp(`${DISABLE_ENV}=1`));
});

test("CLI encaminha sinais ao Pi: filho que trata sai com o próprio código", async () => {
	writeMarkIIConfig({ store, config: enabledConfig });
	const ready = join(root, "signal-ready");
	const signals = join(root, "signal-log");
	rmSync(ready, { force: true });
	rmSync(signals, { force: true });
	const child = spawn(process.execPath, [launcher, "--store", store, "--"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH, ...baseEnv, MARK_II_TEST_WAIT: "1", MARK_II_TEST_READY: ready, MARK_II_TEST_SIGNALS: signals },
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
	writeMarkIIConfig({ store, config: enabledConfig });
	const ready = join(root, "signal-ready-2");
	rmSync(ready, { force: true });
	const child = spawn(process.execPath, [launcher, "--store", store, "--"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH, ...baseEnv, MARK_II_TEST_WAIT: "2", MARK_II_TEST_READY: ready },
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
