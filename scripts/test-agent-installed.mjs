#!/usr/bin/env node
/**
 * Prova offline do Agent **INSTALADO**: artefato imutável no store + Pi real do overlay +
 * provider Anthropic falso em loopback. Nada do checkout entra no processo do Pi.
 *
 * O que este teste prova (e o que ele NÃO prova):
 *  - o artefato é preparado por `prepareAgentArtifact` e o Pi é lançado pelo launcher **copiado
 *    para um bundle instalado fictício** (`<root>/bundle/scripts/...`), nunca por
 *    `scripts/agent-launch.mjs` do checkout: se o updater esquecer de empacotar um helper, a
 *    cópia quebra aqui;
 *  - o ambiente pessoal atravessa intacto: HOME/USERPROFILE/XDG/PI_CODING_AGENT_DIR/PI_SYSTEM_DIR
 *    fictícios, `NODE_OPTIONS` do usuário preservado com um único preload, e os arquivos pessoais
 *    (SYSTEM.md, models.json com modelo/thinking, keybindings, papel pessoal, Vault fake e a
 *    extensão pessoal homônima) continuam byte a byte onde estavam;
 *  - os recursos do Agent entram **uma única vez** (`planAgentResources`/`applyAgentResources`
 *    idempotentes) e as políticas chegam ao modelo EFETIVO: `agent_autonomy` sempre, `agent_complex`
 *    não exigem modo complex — lido no corpo que foi pela rede ao provider falso;
 *  - nenhum ledger é criado; um ledger legado corrompido/bloqueado é ignorado e preservado;
 *    relançamentos (subagentes sempre ligados) preservam preferências;
 *  - `rollbackAgentResources` + opt-out devolvem o settings pessoal e o launcher ao modo legado,
 *    sem nenhuma `AGENT_JUICE_*`.
 *
 * Caminhos reais usados somente para LEITURA: a release do Pi em `<store real>/releases/...`
 * (piRoot, não é copiada). Tudo o que é escrito fica no diretório temporário do teste.
 *
 * `--source-root <abs>` troca a árvore de origem do artefato (uma cópia com correção candidata),
 * para separar "o artefato está incompleto" de "o lançamento instalado está quebrado".
 *
 *   node scripts/test-agent-installed.mjs [--pi-root <abs>] [--source-root <abs>]
 */
import assert from "node:assert/strict";

process.env.AGENT_RUST_AUTO_INSTALL = "0"; // nenhum teste instala Rust de verdade
process.env.AGENT_WARM_START = "0"; // nem aquece o cache abrindo o pi instalado

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planAgentResources, applyAgentResources, rollbackAgentResources } from "./lib/agent-resources.mjs";
import { prepareAgentArtifact, readAgentConfig, writeAgentConfig } from "./lib/agent-runtime.mjs";
import { startFakeAnthropic } from "./lib/fake-anthropic.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const index = argv.indexOf(name);
	return index < 0 ? fallback : argv[index + 1];
};
const realStore = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), ".local", "share", "agent");

/** Release FÍSICA do Pi instalado (o helper recusa o ponteiro `current`, que troca de versão). */
function findPiRoot() {
	const explicit = option("--pi-root", process.env.AGENT_TEST_PI_ROOT);
	if (explicit) return resolve(explicit);
	const relative = join("lib", "node_modules", "@earendil-works", "pi-coding-agent");
	const current = join(realStore, "current", relative);
	if (existsSync(join(current, "dist/cli.js"))) return realpathSync(current);
	const releases = join(realStore, "releases");
	const candidates = (existsSync(releases) ? readdirSync(releases) : [])
		.map((name) => join(releases, name, relative))
		.filter((path) => existsSync(join(path, "dist/cli.js")));
	return candidates.length ? realpathSync(candidates.sort().at(-1)) : null;
}

const piRoot = findPiRoot();
if (!piRoot) {
	throw new Error(`sem release candidata do Pi com CLI clássico em ${realStore}; startup instalado não validado`);
}

const PERSONAL = {
	system: "SENTINELA PESSOAL Agent: este SYSTEM.md é do usuário.\n",
	vault: "SENTINELA VAULT FAKE (nunca o ~/Sistema real).\n",
	role: "---\nname: pessoal\ndescription: papel pessoal do usuário\n---\nFaça do jeito do usuário.\n",
	keybindings: `${JSON.stringify({ "app.thinking.cycle": [], "app.session.tree": "ctrl+shift+alt+k" }, null, 2)}\n`,
	cost: "// extensão pessoal homônima do Agent: SENTINELA-COST-PESSOAL\nexport default function (_pi: any) {}\n",
	sentinel: "export default function (_pi: any) {}\n",
};

// realpath: no macOS `/var/folders/...` é link para `/private/var/...` e os helpers devolvem
// caminhos físicos; sem isso as comparações de prefixo do store ficariam falsas.
const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-installed-")));
let checks = 0;
const test = (name, value) => {
	assert.ok(value !== false, name);
	checks++;
	console.log(`ok ${name}`);
};

try {
	// ---------------------------------------------------------------- HOME/store/cwd fictícios
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const store = join(root, "store");
	const cwd = join(root, "projeto");
	const legacyHome = join(root, "legacy");
	const bundle = join(root, "bundle");
	for (const dir of [join(agentDir, "extensions", "personal-sentinel"), join(agentDir, "agents"), join(home, "Sistema", "Pi"), store, cwd, legacyHome, join(bundle, "scripts", "lib")]) {
		mkdirSync(dir, { recursive: true });
	}
	// Preferências pessoais que o Agent não tem permissão de tocar: modelo e thinking vivem aqui.
	const fake = await startFakeAnthropic([{ text: "feito" }]);
	const personalModels = {
		providers: {
			anthropic: {
				baseUrl: fake.baseUrl,
				apiKey: "agent-installed-test-not-a-key",
				compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
			},
		},
	};
	const personalSettings = {
		defaultProvider: "anthropic",
		defaultModel: "claude-haiku-5-5",
		defaultThinkingLevel: "medium",
		extensions: [join(agentDir, "extensions", "personal-sentinel", "index.ts")],
		quietStartup: "header",
	};
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(personalModels, null, 2)}\n`);
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(personalSettings, null, 2)}\n`);
	writeFileSync(join(agentDir, "SYSTEM.md"), PERSONAL.system);
	writeFileSync(join(agentDir, "keybindings.json"), PERSONAL.keybindings);
	writeFileSync(join(agentDir, "agents", "pessoal.md"), PERSONAL.role);
	writeFileSync(join(home, "Sistema", "Pi", "system-prompt.md"), PERSONAL.vault);
	writeFileSync(join(agentDir, "extensions", "personal-sentinel", "index.ts"), PERSONAL.sentinel);
	// Homônima de uma extensão do artefato: o plano tem de excluir a descoberta, não apagar o arquivo.
	writeFileSync(join(agentDir, "extensions", "cost.ts"), PERSONAL.cost);
	// Observação do system EFETIVO (mesma técnica do test-agent-host): no host durável as trocas de
	// política vão como delta de meio de conversa e NÃO aparecem em `payload.system`, então o único
	// jeito de ler o que o modelo recebe é `ctx.getSystemPrompt()` antes de cada requisição. A
	// extensão só anexa a um arquivo: não altera prompt, mensagens nem tools.
	writeFileSync(join(agentDir, "extensions", "agent-observe-system.ts"), [
		"import { appendFileSync } from 'node:fs';",
		"export default function (pi: any) {",
		"  pi.on('before_provider_request', async (_event: any, ctx: any) => {",
		"    const file = process.env.AGENT_OBSERVE_SYSTEM;",
		"    if (!file) return;",
		"    appendFileSync(file, JSON.stringify({ system: ctx.getSystemPrompt() }) + '\\n');",
		"  });",
		"}",
		"",
	].join("\n"));

	// ---------------------------------------------------------------- artefato + recursos + config
	const sourceRoot = resolve(option("--source-root", repo));
	const artifact = prepareAgentArtifact({ sourceRoot, store, piRoot, log: () => {} });
	test("artefato preparado dentro do store fictício, com agentRoot próprio", artifact.agentRoot.startsWith(store) && artifact.piRoot === piRoot);

	const plan = planAgentResources({ agentRoot: artifact.agentRoot, agentDir, homeDir: home });
	assert.deepEqual(plan.report.blocking, [], `plano com impossibilidades: ${JSON.stringify(plan.report.blocking)}`);
	const applied = applyAgentResources({ plan, backupDir: join(store, "runtime", "backups") });
	test("recursos do Agent aplicados com recibo absoluto", applied.changed && applied.receiptPath.startsWith(store));

	const settingsAfterApply = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	const agentEntries = (settings) => settings.extensions.filter((entry) => typeof entry === "string" && entry.includes(artifact.agentRoot));
	test("entradas do artefato sem duplicata e preferências pessoais intactas no settings", (() => {
		const entries = agentEntries(settingsAfterApply);
		assert.equal(new Set(entries).size, entries.length, `entradas duplicadas: ${JSON.stringify(entries)}`);
		assert.ok(entries.length > 0, "nenhuma extensão do artefato registrada");
		assert.equal(settingsAfterApply.defaultModel, personalSettings.defaultModel);
		assert.equal(settingsAfterApply.defaultThinkingLevel, personalSettings.defaultThinkingLevel);
		assert.ok(settingsAfterApply.extensions.includes(personalSettings.extensions[0]), "extensão pessoal saiu do settings");
		return true;
	})());

	// Reaplicar o plano não pode crescer a lista (ativação repetida é o caso real do updater).
	const replan = planAgentResources({ agentRoot: artifact.agentRoot, agentDir, homeDir: home });
	applyAgentResources({ plan: replan, backupDir: join(store, "runtime", "backups") });
	const settingsReapplied = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	test("segunda aplicação é idempotente: nenhuma entrada nova", JSON.stringify(settingsReapplied.extensions) === JSON.stringify(settingsAfterApply.extensions));

	const preferencesPath = join(legacyHome, "preferences.v3.json");
	const writePreferences = (mode) => writeFileSync(preferencesPath, `${JSON.stringify({ mode, supportModel: "anthropic/claude-haiku-5-5" })}\n`);
	writePreferences("simple");
	const preferencesBefore = readFileSync(preferencesPath, "utf8");
	writeAgentConfig({
		store,
		config: { version: 2, enabled: true, artifactId: artifact.artifactId, piRoot, resourceReceipt: applied.receiptPath },
	});

	// ---------------------------------------------------------------- bundle instalado fictício
	// O updater (C) empacota launcher + helpers; aqui o lançamento usa SÓ essa cópia.
	cpSync(join(repo, "scripts", "agent-launch.mjs"), join(bundle, "scripts", "agent-launch.mjs"));
	for (const name of ["agent-runtime.mjs", "agent-resources.mjs"]) {
		cpSync(join(repo, "scripts", "lib", name), join(bundle, "scripts", "lib", name));
	}
	const launcher = join(bundle, "scripts", "agent-launch.mjs");

	const userNodeOptions = "--no-warnings";
	const piEnv = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: root,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_SYSTEM_DIR: join(home, "Sistema"),
		PI_ACCOUNTS_MIRROR: "0",
		PI_OFFLINE: "1",
		ORCA_BACKGROUND_LAUNCH: "1",
		AGENT_LEARN: "0",
		AGENT_DISPATCHER: "0",
		NODE_OPTIONS: userNodeOptions,
	};
	const spec = (extraEnv = {}) => {
		const result = spawnSync(process.execPath, [launcher, "--store", store, "--print-spec"], {
			cwd, encoding: "utf8", timeout: 60_000, env: { ...piEnv, ...extraEnv },
		});
		assert.equal(result.status, 0, `--print-spec falhou: ${result.stdout}\n${result.stderr}`);
		return JSON.parse(result.stdout);
	};

	const enabled = spec({ AGENT_JUICE_PI_ENTRY: "bundle" });
	test("launcher do bundle instalado resolve o artefato do store, sem nada do checkout", (() => {
		assert.equal(enabled.mode, "agent");
		assert.equal(enabled.piRoot, piRoot);
		assert.equal(enabled.args[0], join(piRoot, "dist/cli.js"));
		assert.equal(enabled.env.AGENT_JUICE_PI_ENTRY, undefined, "artefato clássico remove seleção durável herdada");
		const manifest = JSON.parse(readFileSync(artifact.manifestPath, "utf8"));
		assert.equal(manifest.piEntry, "dist/cli.js", "prepare só produz artefatos clássicos");
		assert.equal(enabled.preload, `--import=${pathToFileURL(join(artifact.artifactRoot, manifest.runtimePreload)).href}`);
		assert.ok(enabled.agentRoot.startsWith(store), `artefato fora do store: ${enabled.agentRoot}`);
		for (const [key, value] of Object.entries({ command: enabled.command, preload: enabled.preload, NODE_OPTIONS: enabled.env.NODE_OPTIONS })) {
			assert.ok(!value.includes(`${repo}/agent/`) && !value.includes(`${repo}/scripts/`), `${key} aponta para o checkout: ${value}`);
		}
		return true;
	})());
	test("ambiente pessoal atravessa intacto e o preload entra uma única vez", (() => {
		for (const [key, value] of Object.entries(piEnv)) {
			if (key === "NODE_OPTIONS") continue;
			assert.equal(enabled.env[key], value, `${key} alterado pelo launcher`);
		}
		const tokens = enabled.env.NODE_OPTIONS.split(/\s+/).filter(Boolean);
		assert.ok(tokens.includes(userNodeOptions), `NODE_OPTIONS do usuário perdido: ${enabled.env.NODE_OPTIONS}`);
		assert.equal(tokens.filter((token) => token.includes("core/runtime.mjs")).length, 1, `preload repetido: ${enabled.env.NODE_OPTIONS}`);
		assert.equal(enabled.env.AGENT_JUICE_HOME, undefined);
		assert.equal(enabled.env.AGENT_JUICE_STATE, undefined);
		assert.equal(enabled.env.AGENT_RUNTIME_ENABLED, "1");
		assert.equal(enabled.env.AGENT_PI_ROOT, piRoot);
		return true;
	})());

	// ---------------------------------------------------------------- Pi real, provider falso
	const session = join(root, "session");
	const runPi = (prompt, label, extraEnv = {}) => new Promise((done) => {
		const observeFile = join(root, `system-${label}.jsonl`);
		const child = spawn(process.execPath, [launcher, "--store", store, "--", "--session", session, "-p", "--mode", "json", prompt], {
			cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, env: { ...piEnv, ...extraEnv, AGENT_OBSERVE_SYSTEM: observeFile },
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.stderr.on("data", (chunk) => { err += chunk; });
		child.on("close", (code) => done({
			code, out, err,
			observed: existsSync(observeFile)
				? readFileSync(observeFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).system)
				: [],
		}));
	});
	const systemText = (index) => (fake.messages()[index].system ?? []).map((block) => block.text ?? "").join("\n");
	const count = (text, pattern) => (text.match(pattern) ?? []).length;

	const first = await runPi("oi", "run1-simple");
	test("Pi instalado sobe pelo artefato e responde (nenhuma extensão falha ao carregar)", (() => {
		const output = `${first.out}${first.err}`;
		assert.equal(first.code, 0, `Pi saiu com ${first.code}\n${output.slice(0, 3000)}`);
		assert.ok(!/Failed to load extension|does not export a valid factory|Extension error|Invalid theme|Cannot find module/.test(output), output.slice(0, 3000));
		assert.ok(fake.messages().length >= 1, "nenhuma requisição chegou ao provider falso");
		return true;
	})());
	test("políticas no system EFETIVO sem modo obrigatório: autonomia 1, complex 0", (() => {
		assert.equal(first.observed.length, fake.messages().length, "uma observação por requisição");
		assert.equal(first.observed[0], systemText(0), "ctx.getSystemPrompt() != system da 1ª requisição (observação não finge)");
		for (const [index, text] of first.observed.entries()) {
			assert.equal(count(text, /<agent_autonomy>/g), 1, `requisição ${index} sem autonomia única`);
			assert.equal(count(text, /<agent_complex>/g), 0, `requisição ${index} com complex em simple`);
		}
		return true;
	})());
	test("extensão pessoal homônima preservada no disco e fora da carga dupla", (() => {
		assert.equal(readFileSync(join(agentDir, "extensions", "cost.ts"), "utf8"), PERSONAL.cost);
		const exclusions = settingsAfterApply.extensions.filter((entry) => typeof entry === "string" && /^[-!]/.test(entry));
		assert.ok(exclusions.some((entry) => entry.includes("cost")), `sem exclusão da homônima pessoal: ${JSON.stringify(exclusions)}`);
		return true;
	})());

	const ledgerPath = join(legacyHome, "run.v3.json");
	test("runtime novo responde sem criar ledger nem accounting", (() => {
		assert.equal(existsSync(ledgerPath), false);
		assert.equal(readAgentConfig(store).juiceHome, undefined);
		assert.equal(readAgentConfig(store).version, 2);
		return true;
	})());

	// A corrupt legacy ledger and a lock must be irrelevant, not silently repaired.
	writeFileSync(ledgerPath, "corrupt legacy sentinel");
	writeFileSync(join(legacyHome, "run.v3.json.lock"), "locked sentinel");
	const before = fake.messages().length;
	const second = await runPi("de novo", "run2-lean", { AGENT_JUICE_HOME: legacyHome, AGENT_JUICE_STATE: ledgerPath });
	test("relançamento preserva preferências e ignora ledger legado corrompido/bloqueado", (() => {
		assert.equal(second.code, 0, second.err);
		assert.equal(readFileSync(preferencesPath, "utf8"), preferencesBefore);
		assert.ok(fake.messages().length > before);
		assert.equal(readFileSync(ledgerPath, "utf8"), "corrupt legacy sentinel");
		assert.equal(readFileSync(join(legacyHome, "run.v3.json.lock"), "utf8"), "locked sentinel");
		return true;
	})());

	const afterDefault = fake.messages().length;
	const enabledSubagents = await runPi("agora com a equipe", "run3-team");
	test("subagentes sempre ligados não exigem comando complex nem trocam modelo pessoal", (() => {
		assert.equal(enabledSubagents.code, 0, enabledSubagents.err);
		assert.ok(enabledSubagents.observed.length > 0);
		for (const payload of fake.messages().slice(afterDefault)) assert.ok(String(payload.model).includes("haiku"));
		assert.equal(readFileSync(ledgerPath, "utf8"), "corrupt legacy sentinel");
		return true;
	})());
	const back = await runPi("sozinho de novo", "run4-default");
	test("novo processo não cria modo ou contabilidade", (() => {
		assert.equal(back.code, 0, back.err);
		assert.ok(back.observed.length > 0);
		for (const text of back.observed) assert.equal(count(text, /<agent_complex>/g), 0);
		assert.equal(readFileSync(preferencesPath, "utf8"), preferencesBefore);
		assert.equal(readFileSync(ledgerPath, "utf8"), "corrupt legacy sentinel");
		return true;
	})());

	test("arquivos pessoais intactos depois dos relançamentos instalados", (() => {
		assert.equal(readFileSync(join(agentDir, "SYSTEM.md"), "utf8"), PERSONAL.system);
		// keybindings.json: só o delta GERENCIADO (a ação reservada que bloqueava o atalho do Agent)
		// aparece; o atalho sentinela e o valor pessoal de app.thinking.cycle seguem exatos.
		const keybindingsNow = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8"));
		const keybindingsBefore = JSON.parse(PERSONAL.keybindings);
		for (const [key, value] of Object.entries(keybindingsBefore)) assert.deepEqual(keybindingsNow[key], value, `${key} alterado no keybindings pessoal`);
		const managedDelta = Object.keys(keybindingsNow).filter((key) => !Object.hasOwn(keybindingsBefore, key));
		assert.deepEqual(managedDelta, [], `delta fora do gerenciado: ${JSON.stringify(managedDelta)}`);
		assert.equal(keybindingsNow["app.thinking.toggle"], undefined, "Ctrl+T mantém o default nativo");
		assert.equal(readFileSync(join(agentDir, "agents", "pessoal.md"), "utf8"), PERSONAL.role);
		assert.equal(readFileSync(join(home, "Sistema", "Pi", "system-prompt.md"), "utf8"), PERSONAL.vault);
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")), personalModels);
		return true;
	})());

	// ---------------------------------------------------------------- rollback + opt-out
	const rolledBack = rollbackAgentResources({ receiptPath: applied.receiptPath });
	test("rollback devolve o settings pessoal sem conflito", (() => {
		assert.deepEqual(rolledBack.conflicts, [], `conflitos no rollback: ${JSON.stringify(rolledBack.conflicts)}`);
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.deepEqual(settings.extensions, personalSettings.extensions, `extensions após rollback: ${JSON.stringify(settings.extensions)}`);
		assert.equal(settings.defaultModel, personalSettings.defaultModel);
		assert.equal(settings.defaultThinkingLevel, personalSettings.defaultThinkingLevel);
		assert.equal(readFileSync(join(agentDir, "extensions", "cost.ts"), "utf8"), PERSONAL.cost);
		assert.equal(readFileSync(join(agentDir, "SYSTEM.md"), "utf8"), PERSONAL.system);
		assert.equal(readFileSync(join(agentDir, "keybindings.json"), "utf8"), PERSONAL.keybindings);
		return true;
	})());
	test("rollback é idempotente", rollbackAgentResources({ receiptPath: applied.receiptPath }).conflicts.length === 0);

	const current = readAgentConfig(store);
	writeAgentConfig({ store, config: { ...current, enabled: false } });
	const optedOut = spec();
	test("opt-out volta ao caminho legado sem nenhuma AGENT_JUICE_*", (() => {
		assert.equal(optedOut.mode, "legacy");
		for (const key of Object.keys(optedOut.env)) assert.ok(!key.startsWith("AGENT_JUICE_") && key !== "AGENT_ARTIFACT", `env fantasma no legado: ${key}`);
		assert.equal(optedOut.env.HOME, home);
		assert.equal(optedOut.env.PI_CODING_AGENT_DIR, agentDir);
		return true;
	})());
	const disabledByEnv = spec({ AGENT_DISABLED: "1" });
	test("AGENT_DISABLED=1 também é legado e preserva o ambiente pessoal", disabledByEnv.mode === "legacy" && disabledByEnv.env.HOME === home);

	await fake.close();
	console.log(`${checks} checks passed`);
	console.log(`PASS agent instalado (artefato ${artifact.artifactId.slice(0, 12)}, piRoot ${piRoot}, provider falso em loopback)`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
