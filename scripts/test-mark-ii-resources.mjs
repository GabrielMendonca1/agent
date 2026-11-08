#!/usr/bin/env node
/**
 * Testes do registro de recursos do MARK II (scripts/lib/mark-ii-resources.mjs).
 *
 * Tudo em fixtures: HOME, `agentDir` e artefato ficam num diretório temporário; nada fora dele é
 * lido ou escrito, nenhuma credencial, nenhuma rede, nenhum provider.
 *
 * A última parte mede o SDK real instalado (todas as releases presentes em
 * `<store>/releases/*`), no loader clássico (`DefaultResourceLoader` com os padrões do `pi`).
 * Sem SDK instalado essa parte é pulada (e avisada).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { applyMarkIIResources, autoDiscoveredExtensions, markIIExtensionCandidates, planMarkIIResources, rollbackMarkIIResources } from "./lib/mark-ii-resources.mjs";

const root = mkdtempSync(join(tmpdir(), "mark-ii-resources-test-"));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const tool = (name, flavour) => `export default function (pi) { pi.registerTool({ name: ${JSON.stringify(name)}, description: ${JSON.stringify(flavour)}, parameters: { type: "object", properties: {} }, execute: async () => ({ content: ${JSON.stringify(flavour)}, details: undefined }) }); }\n`;

/** Fixture: HOME + agentDir pessoal + artefato MARK II imutável. */
function makeFixture(label, { themesLink = false, settings } = {}) {
	const base = join(root, label);
	const home = join(base, "home");
	const agentDir = join(home, ".pi", "agent");
	const markRoot = join(base, "artifact", "mark");
	const personal = join(base, "personal");
	mkdirSync(join(agentDir, "extensions", "dup"), { recursive: true });
	mkdirSync(join(agentDir, "skills", "shared"), { recursive: true });
	mkdirSync(join(personal, "peers"), { recursive: true });
	mkdirSync(join(markRoot, "extensions", "brain-live", "dup"), { recursive: true });
	mkdirSync(join(markRoot, "extensions", "brain-live", "fresh"), { recursive: true });
	mkdirSync(join(markRoot, "extensions", "mark", "peers"), { recursive: true });
	mkdirSync(join(markRoot, "skills", "system", "renamed-shared"), { recursive: true });
	mkdirSync(join(markRoot, "skills", "design", "markii-only"), { recursive: true });
	mkdirSync(join(markRoot, "themes"), { recursive: true });

	writeFileSync(join(agentDir, "extensions", "dup", "index.ts"), tool("dup_tool", "pessoal-antigo"));
	writeFileSync(join(personal, "peers", "index.ts"), tool("peers_tool", "pessoal"));
	writeFileSync(join(markRoot, "extensions", "brain-live", "dup", "index.ts"), tool("dup_tool", "markii"));
	writeFileSync(join(markRoot, "extensions", "brain-live", "fresh", "index.ts"), tool("fresh_tool", "markii"));
	writeFileSync(join(markRoot, "extensions", "mark", "peers", "index.ts"), tool("peers_tool", "markii"));
	writeFileSync(join(agentDir, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: pessoal\n---\ncorpo\n");
	writeFileSync(join(markRoot, "skills", "system", "renamed-shared", "SKILL.md"), "---\nname: shared\ndescription: markii\n---\ncorpo\n");
	writeFileSync(join(markRoot, "skills", "design", "markii-only", "SKILL.md"), "---\nname: markii-only\ndescription: markii\n---\ncorpo\n");
	writeJson(join(markRoot, "themes", "markii-theme.json"), { name: "markii-theme", colors: { text: "#fff" } });

	const themesDir = join(agentDir, "themes");
	if (themesLink) {
		const outside = join(base, "personal-themes");
		mkdirSync(outside, { recursive: true });
		writeJson(join(outside, "pessoal.json"), { name: "pessoal", colors: { text: "#000" } });
		symlinkSync(outside, themesDir);
	} else {
		mkdirSync(themesDir, { recursive: true });
		writeJson(join(themesDir, "pessoal.json"), { name: "pessoal", colors: { text: "#000" } });
	}

	writeJson(join(agentDir, "settings.json"), settings ?? {
		defaultModel: "claude-opus-5-5",
		defaultThinkingLevel: "medium",
		theme: "pessoal",
		extensions: [join(personal, "peers"), "-extensions/nada.ts"],
		skills: ["!cua-driver"],
	});
	return { base, home, agentDir, markRoot, personal, backupDir: join(base, "backup") };
}

try {
	test("artefato real não planeja JEV e não desativa cópia pessoal independente", () => {
		const f = makeFixture("no-jev");
		const entry = join(f.agentDir, "extensions", "jev.ts");
		writeFileSync(entry, tool("personal_jev", "personal"));
		const markRoot = new URL("../mark", import.meta.url).pathname;
		assert.ok(!markIIExtensionCandidates(markRoot).some(c => c.name === "jev"));
		const plan = planMarkIIResources({ markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.ok(!plan.report.extensions.some(c => c.name === "jev"));
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.ok(!readJson(join(f.agentDir, "settings.json")).extensions.some(p => /(?:^|\/)jev(?:\.ts|\/|$)/.test(p)));
		assert.ok(existsSync(entry));
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: applied.receiptPath }).conflicts, []);
	});
	for (const [name, relative] of [["ipython", "ipython/index.ts"], ["read-media", "read-media.ts"]]) {
		test(`retired ${name} stays excluded; receipt undo restores personal settings`, () => {
			const f = makeFixture(`retired-${name}`);
			const entry = join(f.agentDir, "extensions", relative);
			mkdirSync(join(f.agentDir, "extensions", name), { recursive: true });
			writeFileSync(entry, tool(name, "personal"));
			const settingsPath = join(f.agentDir, "settings.json");
			const before = readJson(settingsPath);
			before.extensions.push(entry);
			writeJson(settingsPath, before);
			const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
			assert.deepEqual(plan.report.blocking, []);
			const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
			const after = readJson(settingsPath).extensions;
			assert.ok(after.includes(`-extensions/${relative}`));
			assert.ok(after.includes(`-${entry}`));
			assert.ok(!after.some((item) => item.startsWith(f.markRoot) && item.endsWith(`/${name}`)));
			assert.deepEqual(rollbackMarkIIResources({ receiptPath: applied.receiptPath }).conflicts, []);
			assert.deepEqual(readJson(settingsPath), before);
			assert.ok(existsSync(entry));
		});
	}
	const fixture = makeFixture("main");
	const plan = planMarkIIResources({ markRoot: fixture.markRoot, agentDir: fixture.agentDir, homeDir: fixture.home });

	test("candidatas do artefato e auto-descoberta pessoal são enumeradas com arquivos de entrada", () => {
		assert.deepEqual(markIIExtensionCandidates(fixture.markRoot).map((c) => c.name), ["peers", "dup", "fresh"]);
		assert.deepEqual(autoDiscoveredExtensions(fixture.agentDir).map((e) => e.name), ["dup"]);
		assert.deepEqual(autoDiscoveredExtensions(fixture.agentDir)[0].entries, [join(fixture.agentDir, "extensions", "dup", "index.ts")]);
	});

	test("plano: registra MARK II e exclui a colisão pessoal (auto e settings), sem remover nada", () => {
		assert.equal(plan.disabled, false);
		assert.deepEqual(plan.report.blocking, []);
		const byName = new Map(plan.report.extensions.map((item) => [item.name, item]));
		assert.equal(byName.get("fresh").action, "register");
		assert.deepEqual(byName.get("fresh").exclusions, []);
		assert.deepEqual(byName.get("dup").exclusions, ["-extensions/dup/index.ts"]);
		assert.deepEqual(byName.get("peers").exclusions, [`-${join(fixture.personal, "peers", "index.ts")}`]);
		assert.deepEqual(plan.changes.settings.extensions.add, [
			join(fixture.markRoot, "extensions", "mark", "peers"),
			join(fixture.markRoot, "extensions", "brain-live", "dup"),
			join(fixture.markRoot, "extensions", "brain-live", "fresh"),
		]);
		assert.deepEqual(plan.changes.settings.skills.add, [join(fixture.markRoot, "skills")]);
		assert.deepEqual(plan.report.collisions.map((c) => [c.name, c.kind]), [["peers", "settings"], ["dup", "auto"]]);
		assert.deepEqual(plan.report.skills.collisions.map((c) => c.name), ["shared"]);
		assert.deepEqual(plan.report.themes, [{ name: "markii-theme", action: "copy-missing", path: join(fixture.agentDir, "themes", "markii-theme.json") }]);
		// Relatório seguro: nada além de caminhos/nomes dos recursos envolvidos.
		const serialized = JSON.stringify(plan.report);
		assert.ok(!serialized.includes("claude-opus-5-5"), "o relatório não pode conter settings pessoais");
		assert.ok(!serialized.includes("defaultThinkingLevel"));
		assert.deepEqual(plan.report.settingsKeys, ["extensions", "skills"]);
	});

	test("entrada pessoal de outro nome é relatada como colisão de tool indetectável no plano", () => {
		const other = makeFixture("unmatched", { settings: { extensions: [join(root, "unmatched", "personal", "peers"), "/fora/mark-sessions.ts"] } });
		const otherPlan = planMarkIIResources({ markRoot: other.markRoot, agentDir: other.agentDir, homeDir: other.home });
		assert.deepEqual(otherPlan.report.unmatchedPersonal, [{ name: "mark-sessions", path: "/fora/mark-sessions.ts" }]);
		assert.ok(otherPlan.report.limitations.some((limitation) => limitation.includes("conflito de tool")));
		assert.deepEqual(plan.report.unmatchedPersonal, []);
	});

	test("tui (antes garime-tui): cópia pessoal sob o nome antigo, auto-descoberta e explícita, é excluída", () => {
		const f = makeFixture("legacy-name");
		mkdirSync(join(f.markRoot, "extensions", "mark", "tui"), { recursive: true });
		writeFileSync(join(f.markRoot, "extensions", "mark", "tui", "index.ts"), tool("tui_tool", "markii"));
		mkdirSync(join(f.agentDir, "extensions", "garime-tui"), { recursive: true });
		writeFileSync(join(f.agentDir, "extensions", "garime-tui", "index.ts"), tool("tui_tool", "pessoal"));
		const explicit = join(f.personal, "garime-tui");
		mkdirSync(explicit, { recursive: true });
		writeFileSync(join(explicit, "index.ts"), tool("tui_tool", "pessoal"));
		const settings = readJson(join(f.agentDir, "settings.json"));
		settings.extensions.push(explicit);
		writeJson(join(f.agentDir, "settings.json"), settings);
		const p = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.deepEqual(p.report.blocking, []);
		const tui = p.report.extensions.find((item) => item.name === "tui");
		assert.equal(tui.action, "register");
		assert.deepEqual(tui.exclusions.sort(), ["-extensions/garime-tui/index.ts", `-${join(explicit, "index.ts")}`].sort());
		assert.ok(!p.report.unmatchedPersonal.some((entry) => entry.name === "garime-tui"));
		// `-garime-tui` por nome desliga a `tui` do Mark, como desligava a antiga.
		settings.extensions.push("-garime-tui");
		writeJson(join(f.agentDir, "settings.json"), settings);
		const off = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.equal(off.report.extensions.find((item) => item.name === "tui").action, "skipped-user-disabled");
	});

	test("alias explícito de default é excluído pela entrada original sem tocar seu arquivo", () => {
		const f = makeFixture("alias");
		const alias = join(f.personal, "old-peer-tools.ts");
		const body = 'export { default } from "./peers/index.ts";\n';
		writeFileSync(alias, body);
		const settings = readJson(join(f.agentDir, "settings.json"));
		settings.extensions.push(alias);
		writeJson(join(f.agentDir, "settings.json"), settings);
		const p = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.ok(p.report.extensions.find(e => e.name === "peers").exclusions.includes(`-${alias}`));
		assert.deepEqual(p.report.unmatchedPersonal, []);
		applyMarkIIResources({ plan: p, backupDir: f.backupDir });
		assert.equal(readFileSync(alias, "utf8"), body);
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: join(f.backupDir, "mark-ii-resources-receipt.json") }).conflicts, []);
		assert.deepEqual(readJson(join(f.agentDir, "settings.json")), settings);
	});

	test("plano não escreve nada", () => {
		const settings = readJson(join(fixture.agentDir, "settings.json"));
		assert.deepEqual(settings.extensions, [join(fixture.personal, "peers"), "-extensions/nada.ts"]);
		assert.ok(!existsSync(fixture.backupDir));
		assert.ok(!existsSync(join(fixture.agentDir, "themes", "markii-theme.json")));
	});

	const applied = applyMarkIIResources({ plan, backupDir: fixture.backupDir });

	test("apply: recibo absoluto, settings tocado só nas chaves gerenciadas, tema ausente copiado", () => {
		assert.equal(applied.receiptPath, join(fixture.backupDir, "mark-ii-resources-receipt.json"));
		assert.equal(applied.changed, true);
		const settings = readJson(join(fixture.agentDir, "settings.json"));
		assert.equal(settings.defaultModel, "claude-opus-5-5");
		assert.equal(settings.defaultThinkingLevel, "medium");
		assert.equal(settings.theme, "pessoal");
		assert.deepEqual(settings.extensions, [
			join(fixture.personal, "peers"),
			"-extensions/nada.ts",
			`-${join(fixture.personal, "peers", "index.ts")}`,
			"-extensions/dup/index.ts",
			join(fixture.markRoot, "extensions", "mark", "peers"),
			join(fixture.markRoot, "extensions", "brain-live", "dup"),
			join(fixture.markRoot, "extensions", "brain-live", "fresh"),
		]);
		assert.deepEqual(settings.skills, ["!cua-driver", join(fixture.markRoot, "skills")]);
		assert.equal(Object.keys(settings).length, 5);
		assert.ok(existsSync(join(fixture.agentDir, "themes", "markii-theme.json")));
		assert.ok(existsSync(join(fixture.agentDir, "themes", "pessoal.json")));
		// Arquivos pessoais intocados: a extensão antiga continua lá, só desligada por filtro.
		assert.ok(existsSync(join(fixture.agentDir, "extensions", "dup", "index.ts")));
		assert.ok(existsSync(join(fixture.personal, "peers", "index.ts")));
	});

	test("apply: backup seletivo em CAS, só das chaves alteradas", () => {
		const receipt = readJson(applied.receiptPath);
		assert.deepEqual(receipt.settings.map((entry) => entry.key), ["extensions", "skills"]);
		assert.equal(statSync(applied.receiptPath).mode & 0o777, 0o600);
		for (const entry of receipt.settings) {
			const backup = readJson(entry.casPath);
			assert.equal(backup.key, entry.key);
			assert.ok(Array.isArray(backup.value));
			assert.ok(!JSON.stringify(backup).includes("claude-opus-5-5"), "o backup não guarda settings não relacionados");
		}
		// extensions, skills e a keybinding gerenciada.
		const casFiles = readdirSync(join(fixture.backupDir, "cas"));
		assert.equal(casFiles.length, 3);
		assert.deepEqual(receipt.keybindings.map((entry) => entry.key), ["app.thinking.cycle"]);
		for (const entry of receipt.keybindings) {
			assert.deepEqual(readJson(entry.casPath), { keybinding: entry.key, path: join(fixture.agentDir, "keybindings.json"), value: null, absent: true, fileExisted: false });
		}
	});

	test("apply é idempotente: segundo plano/apply não muda nada", () => {
		const replan = planMarkIIResources({ markRoot: fixture.markRoot, agentDir: fixture.agentDir, homeDir: fixture.home });
		assert.deepEqual(replan.changes.settings, {});
		assert.deepEqual(replan.changes.copyFiles, []);
		assert.deepEqual(replan.changes.keybindings, []);
		assert.deepEqual(replan.report.keybindings.map((entry) => entry.action), ["already-free"]);
		const byName = new Map(replan.report.extensions.map((item) => [item.name, item]));
		assert.equal(byName.get("dup").action, "already-registered");
		const before = readFileSync(join(fixture.agentDir, "settings.json"), "utf8");
		const again = applyMarkIIResources({ plan: replan, backupDir: fixture.backupDir });
		assert.equal(again.changed, false);
		assert.equal(readFileSync(join(fixture.agentDir, "settings.json"), "utf8"), before);
	});

	test("rollback restaura exatamente o estado anterior e remove só o arquivo que criou", () => {
		const result = rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.deepEqual(result.restored.map((entry) => entry.key), ["extensions", "skills", "app.thinking.cycle"]);
		// keybindings.json não existia antes e ficou vazio: sai junto, sem deixar sobra.
		assert.deepEqual(result.removed, [join(fixture.agentDir, "keybindings.json"), join(fixture.agentDir, "themes", "markii-theme.json")]);
		assert.ok(!existsSync(join(fixture.agentDir, "keybindings.json")));
		assert.deepEqual(result.conflicts, []);
		const settings = readJson(join(fixture.agentDir, "settings.json"));
		assert.deepEqual(settings.extensions, [join(fixture.personal, "peers"), "-extensions/nada.ts"]);
		assert.deepEqual(settings.skills, ["!cua-driver"]);
		assert.equal(settings.theme, "pessoal");
		assert.ok(existsSync(join(fixture.agentDir, "themes", "pessoal.json")));
		assert.ok(existsSync(join(fixture.agentDir, "extensions", "dup", "index.ts")));
	});

	test("rollback é idempotente", () => {
		const result = rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.equal(result.changed, false);
		assert.deepEqual(result.conflicts, []);
		assert.equal(result.skipped.length, 4);
	});

	test("reinstalar após rollback mantém o contrato e preserva bindings pessoais", () => {
		const f = makeFixture("reinstall");
		const original = readJson(join(f.agentDir, "settings.json"));
		const bindings = { "app.thinking.cycle": ["shift+tab", "alt+k"], "app.session.new": "ctrl+shift+n" };
		writeJson(join(f.agentDir, "keybindings.json"), bindings);
		let registered;
		for (let i = 0; i < 2; i++) {
			const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
			const applied = applyMarkIIResources({ plan, backupDir: join(f.base, `backup-${i}`) });
			const settings = readJson(join(f.agentDir, "settings.json"));
			if (registered) assert.deepEqual(settings, registered);
			registered = settings;
			assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { ...bindings, "app.thinking.cycle": ["alt+k"] });
			assert.deepEqual(rollbackMarkIIResources({ receiptPath: applied.receiptPath }).conflicts, []);
			assert.deepEqual(readJson(join(f.agentDir, "settings.json")), original);
			assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), bindings);
		}
	});

	test("CAS do apply: settings mudado depois do plano faz o apply recusar", () => {
		const stale = makeFixture("stale");
		const stalePlan = planMarkIIResources({ markRoot: stale.markRoot, agentDir: stale.agentDir, homeDir: stale.home });
		const settings = readJson(join(stale.agentDir, "settings.json"));
		settings.extensions = [...settings.extensions, "/outro/caminho"];
		writeJson(join(stale.agentDir, "settings.json"), settings);
		assert.throws(() => applyMarkIIResources({ plan: stalePlan, backupDir: stale.backupDir }), /mudou depois do plano/);
		assert.deepEqual(readJson(join(stale.agentDir, "settings.json")).extensions.slice(-1), ["/outro/caminho"]);
	});

	test("rollback preserva mudança posterior do usuário e relata conflito", () => {
		const later = makeFixture("later");
		const laterPlan = planMarkIIResources({ markRoot: later.markRoot, agentDir: later.agentDir, homeDir: later.home });
		const receipt = applyMarkIIResources({ plan: laterPlan, backupDir: later.backupDir }).receiptPath;
		const settings = readJson(join(later.agentDir, "settings.json"));
		settings.extensions = [...settings.extensions, "/extensao/nova/do/usuario"];
		writeJson(join(later.agentDir, "settings.json"), settings);
		writeFileSync(join(later.agentDir, "themes", "markii-theme.json"), `${JSON.stringify({ name: "markii-theme", colors: { text: "#111" } })}\n`);
		const result = rollbackMarkIIResources({ receiptPath: receipt });
		assert.deepEqual(result.conflicts.map((conflict) => conflict.key ?? conflict.path), ["extensions", join(later.agentDir, "themes", "markii-theme.json")]);
		const after = readJson(join(later.agentDir, "settings.json"));
		assert.ok(after.extensions.includes("/extensao/nova/do/usuario"));
		assert.deepEqual(after, settings, "conflito recusa o rollback inteiro, sem restauração parcial");
		assert.ok(existsSync(join(later.agentDir, "themes", "markii-theme.json")));
	});

	test("pasta de temas que é symlink pessoal não é escrita; limitação relatada", () => {
		const linked = makeFixture("linked", { themesLink: true });
		const linkedPlan = planMarkIIResources({ markRoot: linked.markRoot, agentDir: linked.agentDir, homeDir: linked.home });
		assert.deepEqual(linkedPlan.changes.copyFiles, []);
		assert.deepEqual(linkedPlan.report.themes.map((theme) => theme.action), ["unavailable"]);
		assert.ok(linkedPlan.report.limitations.some((limitation) => limitation.includes("symlink pessoal")));
		applyMarkIIResources({ plan: linkedPlan, backupDir: linked.backupDir });
		assert.deepEqual(readdirSync(join(linked.agentDir, "themes")).sort(), ["pessoal.json"]);
	});

	test('extensão desligada pelo usuário ("-dup") não é registrada e aparece no relatório', () => {
		const off = makeFixture("user-off", { settings: { extensions: ["-dup"] } });
		const offPlan = planMarkIIResources({ markRoot: off.markRoot, agentDir: off.agentDir, homeDir: off.home });
		const byName = new Map(offPlan.report.extensions.map((item) => [item.name, item]));
		assert.equal(byName.get("dup").action, "skipped-user-disabled");
		assert.ok(!offPlan.changes.settings.extensions.add.some((path) => path.endsWith(join("brain-live", "dup"))));
	});

	test('"-mark-setup" desliga o plano inteiro', () => {
		const disabled = makeFixture("disabled", { settings: { extensions: ["-mark-setup"] } });
		const disabledPlan = planMarkIIResources({ markRoot: disabled.markRoot, agentDir: disabled.agentDir, homeDir: disabled.home });
		assert.equal(disabledPlan.disabled, true);
		assert.deepEqual(disabledPlan.changes.settings, {});
		const result = applyMarkIIResources({ plan: disabledPlan, backupDir: disabled.backupDir });
		assert.equal(result.changed, false);
		assert.deepEqual(readJson(join(disabled.agentDir, "settings.json")).extensions, ["-mark-setup"]);
	});

	test("upgrade de artefato preserva o CAS original para rollback completo", () => {
		const f = makeFixture("receipt-original");
		const next = makeFixture("receipt-next");
		const original = readJson(join(f.agentDir, "settings.json"));
		const apply = (markRoot) => applyMarkIIResources({ plan: planMarkIIResources({ markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		const first = apply(f.markRoot);
		const before = readJson(first.receiptPath).settings.find(e => e.key === "extensions");
		const second = apply(next.markRoot);
		const after = readJson(second.receiptPath).settings.find(e => e.key === "extensions");
		assert.equal(after.casPath, before.casPath);
		assert.equal(after.beforeHash, before.beforeHash);
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: second.receiptPath }).conflicts, []);
		assert.deepEqual(readJson(join(f.agentDir, "settings.json")), original);
	});

	test("re-enable após edição pessoal recusa sem perder recibo nem CAS", () => {
		const f = makeFixture("receipt-edited");
		const applied = applyMarkIIResources({ plan: planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		const receipt = readFileSync(applied.receiptPath, "utf8");
		const personal = readJson(join(f.agentDir, "settings.json"));
		personal.extensions.push("/personal/new.ts");
		writeJson(join(f.agentDir, "settings.json"), personal);
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.throws(() => applyMarkIIResources({ plan, backupDir: f.backupDir }), /recibo\/CAS preservado/);
		assert.equal(readFileSync(applied.receiptPath, "utf8"), receipt);
		assert.deepEqual(readJson(join(f.agentDir, "settings.json")), personal);
	});

	test("plano recusa settings.json ilegível em vez de registrar errado", () => {
		const broken = makeFixture("broken");
		writeFileSync(join(broken.agentDir, "settings.json"), "{ nope");
		assert.throws(() => planMarkIIResources({ markRoot: broken.markRoot, agentDir: broken.agentDir, homeDir: broken.home }), /não é JSON válido/);
	});

	// ---- keybindings: só app.thinking.cycle/shift+tab; Ctrl+T intocado ---------------
	/** Fixture com keybindings.json pessoal já existente. */
	const withKeybindings = (label, value) => {
		const f = makeFixture(label);
		writeJson(join(f.agentDir, "keybindings.json"), value);
		return f;
	};

	test("keybindings: app.thinking.cycle ausente vira []; toggle não é gerenciada", () => {
		const f = makeFixture("kb-absent");
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.deepEqual(plan.changes.keybindings, [
			{ key: "app.thinking.cycle", path: join(f.agentDir, "keybindings.json"), value: [], fileExists: false },
		]);
		assert.deepEqual(plan.report.keybindings.map((entry) => [entry.key, entry.action, entry.keyRemoved]), [
			["app.thinking.cycle", "unbind-default", "shift+tab"],
		]);
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.equal(applied.changed, true);
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": [] });
		assert.equal(statSync(join(f.agentDir, "keybindings.json")).mode & 0o777, 0o600);
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: applied.receiptPath }).conflicts, []);
		assert.ok(!existsSync(join(f.agentDir, "keybindings.json")));
	});

	test("keybindings: strings reservadas (em qualquer ordem/caixa) saem; outras ações intocadas", () => {
		const f = withKeybindings("kb-string", { "app.session.new": "ctrl+shift+n", "app.thinking.cycle": "Tab+Shift", "app.thinking.toggle": "T+Ctrl" });
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.deepEqual(plan.changes.keybindings.map((change) => change.value), [[]]);
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.session.new": "ctrl+shift+n", "app.thinking.cycle": [], "app.thinking.toggle": "T+Ctrl" });
		rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.session.new": "ctrl+shift+n", "app.thinking.cycle": "Tab+Shift", "app.thinking.toggle": "T+Ctrl" });
	});

	test("keybindings: lista perde só a tecla reservada e mantém os outros atalhos da mesma ação", () => {
		const f = withKeybindings("kb-list", { "app.thinking.cycle": ["shift+tab", "alt+k"], "app.thinking.toggle": ["ctrl+t", "alt+t"] });
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.deepEqual(plan.changes.keybindings.map((change) => change.value), [["alt+k"]]);
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": ["alt+k"], "app.thinking.toggle": ["ctrl+t", "alt+t"] });
		rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": ["shift+tab", "alt+k"], "app.thinking.toggle": ["ctrl+t", "alt+t"] });
	});

	test("keybindings: quem já não usa a tecla reservada não é mudado nem entra no recibo", () => {
		const f = withKeybindings("kb-free", { "app.thinking.cycle": ["alt+k"], "app.thinking.toggle": "alt+t" });
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.deepEqual(plan.changes.keybindings, []);
		assert.deepEqual(plan.report.keybindings.map((entry) => entry.action), ["already-free"]);
		const before = readFileSync(join(f.agentDir, "keybindings.json"), "utf8");
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.deepEqual(readJson(applied.receiptPath).keybindings, []);
		assert.equal(readFileSync(join(f.agentDir, "keybindings.json"), "utf8"), before);
	});

	test("keybindings: rollback preserva edição posterior do usuário na mesma ação", () => {
		const f = makeFixture("kb-edited");
		const applied = applyMarkIIResources({ plan: planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		writeJson(join(f.agentDir, "keybindings.json"), { "app.thinking.cycle": "alt+j", "app.session.new": "ctrl+shift+n" });
		const result = rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.deepEqual(result.conflicts.filter((conflict) => conflict.key === "app.thinking.cycle").map((conflict) => conflict.reason), ["mudança posterior do usuário preservada"]);
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": "alt+j", "app.session.new": "ctrl+shift+n" });
	});

	test("keybindings: gestão parcial — só a ação ainda conflitante entra no plano", () => {
		const f = withKeybindings("kb-partial", { "app.thinking.cycle": [], "app.thinking.toggle": "ctrl+t", "app.session.tree": "ctrl+shift+t" });
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.deepEqual(plan.report.keybindings.map((entry) => [entry.key, entry.action]), [["app.thinking.cycle", "already-free"]]);
		assert.deepEqual(plan.changes.keybindings.map((change) => [change.key, change.value]), []);
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": [], "app.thinking.toggle": "ctrl+t", "app.session.tree": "ctrl+shift+t" });
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: applied.receiptPath }).conflicts, []);
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": [], "app.thinking.toggle": "ctrl+t", "app.session.tree": "ctrl+shift+t" });
	});

	test("keybindings: nomes legados (cycleThinkingLevel/toggleThinking) são relatados e intocados", () => {
		const f = withKeybindings("kb-legacy", { cycleThinkingLevel: "shift+tab", toggleThinking: "ctrl+t" });
		const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		assert.equal(plan.report.limitations.filter((limitation) => limitation.includes("nome legado")).length, 1);
		const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { cycleThinkingLevel: "shift+tab", toggleThinking: "ctrl+t", "app.thinking.cycle": [] });
		rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { cycleThinkingLevel: "shift+tab", toggleThinking: "ctrl+t" });
	});

	test("keybindings: arquivo com outras chaves do usuário sobrevive ao rollback", () => {
		const f = withKeybindings("kb-keep-file", { "app.session.tree": "ctrl+shift+t" });
		const applied = applyMarkIIResources({ plan: planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		rollbackMarkIIResources({ receiptPath: applied.receiptPath });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.session.tree": "ctrl+shift+t" });
	});

	test("keybindings: JSON ilegível ou valor inválido faz o plano recusar (fail closed)", () => {
		const broken = makeFixture("kb-broken");
		writeFileSync(join(broken.agentDir, "keybindings.json"), "{ nope");
		assert.throws(() => planMarkIIResources({ markRoot: broken.markRoot, agentDir: broken.agentDir, homeDir: broken.home }), /keybindings\.json não é JSON válido/);
		const invalid = withKeybindings("kb-invalid", { "app.thinking.cycle": { key: "shift+tab" } });
		assert.throws(() => planMarkIIResources({ markRoot: invalid.markRoot, agentDir: invalid.agentDir, homeDir: invalid.home }), /não é string nem lista de strings/);
	});

	test("keybindings: upgrade preserva o CAS original e o rollback volta ao valor do usuário", () => {
		const f = withKeybindings("kb-upgrade", { "app.thinking.cycle": "shift+tab", "app.thinking.toggle": "ctrl+t" });
		const next = makeFixture("kb-upgrade-next");
		const apply = (markRoot) => applyMarkIIResources({ plan: planMarkIIResources({ markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		const first = readJson(apply(f.markRoot).receiptPath).keybindings;
		const second = apply(next.markRoot);
		const carried = readJson(second.receiptPath).keybindings;
		assert.deepEqual(carried.map((entry) => entry.casPath), first.map((entry) => entry.casPath));
		assert.deepEqual(carried.map((entry) => entry.beforeHash), first.map((entry) => entry.beforeHash));
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: second.receiptPath }).conflicts, []);
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": "shift+tab", "app.thinking.toggle": "ctrl+t" });
	});

	test("keybindings: recibo só de app.thinking.cycle permanece estável no upgrade", () => {
		const f = withKeybindings("kb-receipt-legacy", { "app.thinking.cycle": "shift+tab", "app.thinking.toggle": "ctrl+t", "app.session.tree": "ctrl+shift+t" });
		const original = readJson(join(f.agentDir, "keybindings.json"));
		const first = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		// Estado real do global de hoje: a gestão anterior cuidava só de app.thinking.cycle.
		const onlyCycle = { key: "app.thinking.cycle" };
		const legacyPlan = {
			...first,
			changes: { ...first.changes, keybindings: first.changes.keybindings.filter((change) => change.key === onlyCycle.key) },
			cas: { ...first.cas, keybindings: first.cas.keybindings.filter((entry) => entry.key === onlyCycle.key) },
		};
		const legacyReceipt = readJson(applyMarkIIResources({ plan: legacyPlan, backupDir: f.backupDir }).receiptPath);
		assert.deepEqual(legacyReceipt.keybindings.map((entry) => entry.key), ["app.thinking.cycle"]);
		const upgraded = applyMarkIIResources({ plan: planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		// A chave do modo é carregada do recibo anterior; toggle permanece intacta.
		assert.deepEqual(readJson(upgraded.receiptPath).keybindings.map((entry) => [entry.key, entry.reapplied]), [["app.thinking.cycle", true]]);
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.cycle": [], "app.thinking.toggle": "ctrl+t", "app.session.tree": "ctrl+shift+t" });
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: upgraded.receiptPath }).conflicts, []);
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), original);
	});

	for (const edited of [false, true]) test(`upgrade libera Ctrl+T antes gerenciado; edição pessoal=${edited}`, () => {
		const f = makeFixture(`kb-retired-${edited}`);
		const oldPlan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
		// Simula recibo anterior com a segunda ação reservada; sem código legado em produção.
		oldPlan.changes.keybindings.push({ ...oldPlan.changes.keybindings[0], key: "app.thinking.toggle" });
		oldPlan.cas.keybindings.push({ ...oldPlan.cas.keybindings[0], key: "app.thinking.toggle" });
		applyMarkIIResources({ plan: oldPlan, backupDir: f.backupDir });
		if (edited) writeJson(join(f.agentDir, "keybindings.json"), { "app.thinking.cycle": [], "app.thinking.toggle": "alt+t" });
		const upgraded = applyMarkIIResources({ plan: planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home }), backupDir: f.backupDir });
		assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), edited ? { "app.thinking.cycle": [], "app.thinking.toggle": "alt+t" } : { "app.thinking.cycle": [] });
		assert.deepEqual(readJson(upgraded.receiptPath).keybindings.map(e => e.key), ["app.thinking.cycle"]);
		assert.deepEqual(rollbackMarkIIResources({ receiptPath: upgraded.receiptPath }).conflicts, []);
		if (edited) assert.deepEqual(readJson(join(f.agentDir, "keybindings.json")), { "app.thinking.toggle": "alt+t" });
	});

	// ---- SDK real, offline, nas duas configurações de loader de produção -------------------------
	const store = process.env.PI_OVERLAY_STORE || join(homedir(), ".local", "share", "pi-overlay");
	const releasesDir = join(store, "releases");
	const releases = existsSync(releasesDir)
		? readdirSync(releasesDir)
			.map((release) => join(releasesDir, release, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist"))
			.filter((dist) => existsSync(join(dist, "core", "resource-loader.js")))
		: [];
	if (releases.length === 0) {
		console.log(`sem SDK instalado em ${releasesDir}; medição de autodescoberta/registro pulada`);
	} else {
		const sdk = makeFixture("sdk");
		const alias = join(sdk.personal, "old-peer-tools.ts");
		writeFileSync(alias, 'export { default } from "./peers/index.ts";\n');
		const sdkSettings = readJson(join(sdk.agentDir, "settings.json"));
		sdkSettings.extensions.push(alias);
		writeJson(join(sdk.agentDir, "settings.json"), sdkSettings);
		const sdkPlan = planMarkIIResources({ markRoot: sdk.markRoot, agentDir: sdk.agentDir, homeDir: sdk.home });
		applyMarkIIResources({ plan: sdkPlan, backupDir: sdk.backupDir });
		const cwd = join(sdk.base, "cwd");
		mkdirSync(cwd, { recursive: true });
		const probe = (dist) => {
			const script = [
				`const dist = ${JSON.stringify(dist)};`,
				`const { DefaultResourceLoader } = await import(dist + "/core/resource-loader.js");`,
				`const { loadSkills } = await import(dist + "/core/skills.js");`,
				`const { builtInExtensions } = await import(dist + "/extensions/index.js");`,
				`const cwd = ${JSON.stringify(cwd)};`,
				`const agentDir = ${JSON.stringify(sdk.agentDir)};`,
				"const read = async (extra) => {",
				"  const loader = new DefaultResourceLoader({ cwd, agentDir, ...extra });",
				"  await loader.reload();",
				"  const result = loader.getExtensions();",
				"  return {",
				"    extensions: result.extensions.filter((e) => !e.path.startsWith('builtin:')).map((e) => ({ path: e.path, tools: [...e.tools.keys()] })),",
				"    errors: result.errors,",
				"    skills: loader.getSkills().skills.map((s) => ({ name: s.name, path: s.filePath })),",
				"  };",
				"};",
				"const classic = await read({});",
				"console.log(JSON.stringify({ classic }));",
			].join("\n");
			const env = { PATH: process.env.PATH, HOME: sdk.home, USERPROFILE: sdk.home, TMPDIR: sdk.base, PI_CODING_AGENT_DIR: sdk.agentDir, PI_ACCOUNTS_MIRROR: "0" };
			const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, env, encoding: "utf8", timeout: 120_000 });
			assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
			return JSON.parse(run.stdout.trim().split("\n").pop());
		};

		for (const dist of releases) {
			const release = dist.split("/releases/")[1].split("/")[0];
			const measured = probe(dist);
			for (const [host, result] of Object.entries(measured)) {
				test(`SDK ${release} (${host}): MARK II carrega uma única vez, sem duplicar tool nem erro`, () => {
					assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
					const paths = result.extensions.map((extension) => extension.path).sort();
					assert.deepEqual(paths, [
						join(sdk.markRoot, "extensions", "mark", "peers", "index.ts"),
						join(sdk.markRoot, "extensions", "brain-live", "dup", "index.ts"),
						join(sdk.markRoot, "extensions", "brain-live", "fresh", "index.ts"),
					].sort());
					const tools = result.extensions.flatMap((extension) => extension.tools);
					assert.deepEqual([...tools].sort(), ["dup_tool", "fresh_tool", "peers_tool"]);
					assert.equal(new Set(tools).size, tools.length, `tool duplicada: ${tools.join(", ")}`);
				});
			}
			test(`SDK ${release}: skill do MARK II entra e a colisão resolve no clássico (MARK II)`, () => {
				const names = (result) => result.skills.map((skill) => skill.name).sort();
				assert.ok(names(measured.classic).includes("markii-only"));
				const classicShared = measured.classic.skills.find((skill) => skill.name === "shared");
				assert.equal(classicShared.path, join(sdk.markRoot, "skills", "system", "renamed-shared", "SKILL.md"));
				assert.equal(measured.classic.skills.filter((skill) => skill.name === "shared").length, 1);
			});
		}

		// ---- atalhos no SDK real: reservados por app.thinking.cycle/toggle antes, livres depois ----
		// Mede `ExtensionRunner.getShortcuts(keybindings.getEffectiveConfig())`, o mesmo caminho que a
		// TUI usa, com o `KeybindingsManager` lendo o keybindings.json do agentDir da fixture.
		const shortcutProbe = (dist, fixture) => {
			const script = [
				`const dist = ${JSON.stringify(dist)};`,
				`const cwd = ${JSON.stringify(fixture.cwd)};`,
				`const agentDir = ${JSON.stringify(fixture.agentDir)};`,
				'const { DefaultResourceLoader } = await import(dist + "/core/resource-loader.js");',
				'const { KeybindingsManager } = await import(dist + "/core/keybindings.js");',
				'const { ExtensionRunner } = await import(dist + "/core/extensions/runner.js");',
				"const loader = new DefaultResourceLoader({ cwd, agentDir });",
				"await loader.reload();",
				"const loaded = loader.getExtensions();",
				"const keybindings = KeybindingsManager.create(agentDir);",
				"const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, undefined, undefined);",
				"const shortcuts = runner.getShortcuts(keybindings.getEffectiveConfig());",
				"console.log(JSON.stringify({",
				"  shortcuts: [...shortcuts.keys()],",
				"  thinkingCycle: keybindings.getKeys('app.thinking.cycle'),",
				"  thinkingToggle: keybindings.getKeys('app.thinking.toggle'),",
				"  diagnostics: runner.getShortcutDiagnostics().map((d) => d.message),",
				"}));",
			].join("\n");
			const env = { PATH: process.env.PATH, HOME: fixture.home, USERPROFILE: fixture.home, TMPDIR: fixture.base, PI_CODING_AGENT_DIR: fixture.agentDir, PI_ACCOUNTS_MIRROR: "0" };
			const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: fixture.cwd, env, encoding: "utf8", timeout: 120_000 });
			assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
			return JSON.parse(run.stdout.trim().split("\n").pop());
		};

		for (const dist of releases) {
			const release = dist.split("/releases/")[1].split("/")[0];
			const f = makeFixture(`shortcut-${release.slice(0, 12)}`, { settings: {} });
			f.cwd = join(f.base, "cwd");
			mkdirSync(f.cwd, { recursive: true });
			// Extensão do artefato que registra o atalho do modo, como mark/extensions/brain-live/juice.ts.
			writeFileSync(
				join(f.markRoot, "extensions", "brain-live", "fresh", "index.ts"),
				[
					"export default function (pi) {",
					'  pi.registerShortcut("shift+tab", { description: "modo simple | complex", handler: async () => {} });',
					"}",
					"",
				].join("\n"),
			);
			const plan = planMarkIIResources({ markRoot: f.markRoot, agentDir: f.agentDir, homeDir: f.home });
			// Estado "antes": extensões do MARK II registradas, keybindings do usuário nos defaults —
			// exatamente o que o launcher real fazia sem esta gestão.
			const planWithoutKeybindings = { ...plan, changes: { ...plan.changes, keybindings: [] }, cas: { ...plan.cas, keybindings: [] } };
			applyMarkIIResources({ plan: planWithoutKeybindings, backupDir: f.backupDir });
			const before = shortcutProbe(dist, f);
			const applied = applyMarkIIResources({ plan, backupDir: f.backupDir });
			const after = shortcutProbe(dist, f);
			const rolledBack = rollbackMarkIIResources({ receiptPath: applied.receiptPath });

			test(`SDK ${release}: Shift+Tab é liberado para o modo; Ctrl+T permanece nativo`, () => {
				assert.deepEqual(before.thinkingCycle, ["shift+tab"], "default do SDK deixou de ser shift+tab");
				assert.deepEqual(before.thinkingToggle, ["ctrl+t"], "default do SDK deixou de ser ctrl+t");
				assert.deepEqual(before.shortcuts, [], `nenhum atalho deveria registrar sob os defaults: ${before.shortcuts.join(", ")}`);
				for (const key of ["shift+tab"]) {
					assert.ok(before.diagnostics.some((message) => message.includes(key) && message.includes("Skipping")), before.diagnostics.join(" | "));
				}
				assert.deepEqual([...after.shortcuts].sort(), ["shift+tab"]);
				assert.deepEqual(after.thinkingCycle, []);
				assert.deepEqual(after.thinkingToggle, ["ctrl+t"]);
				// Nenhum atalho é mais descartado. Sobra só o aviso de `ctrl+t` vs `app.tree.filter.noTools`,
				// que é binding de picker (`restrictOverride: false`): o SDK registra a extensão e avisa.
				assert.ok(!after.diagnostics.some((message) => message.includes("Skipping")), after.diagnostics.join(" | "));
				assert.deepEqual(
					after.diagnostics.filter((message) => !(message.includes("ctrl+t") && message.includes("app.tree.filter.noTools"))),
					[],
					after.diagnostics.join(" | "),
				);
				// Rollback devolve o estado original (ausência do arquivo) e os dois atalhos nativos voltam.
				assert.deepEqual(rolledBack.conflicts, []);
				assert.ok(!existsSync(join(f.agentDir, "keybindings.json")));
				const restored = shortcutProbe(dist, f);
				assert.deepEqual(restored.thinkingCycle, ["shift+tab"]);
				assert.deepEqual(restored.thinkingToggle, ["ctrl+t"]);
				// O mesmo rollback tira o registro das extensões do artefato: nenhum atalho de extensão resta.
				assert.deepEqual(restored.shortcuts, []);
			});
		}
	}

	console.log(`${checks} checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
