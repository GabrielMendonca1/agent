#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureSettingsEntry, skillFiles, skillNames, syncAgentSkills } from "./lib/skills.mjs";
import { loadSkillCategories, loadCompanySkillCategories, categoryPrompt } from "../agent/juice/skill-categories.mjs";
import { COMPANY_SKILLS_DIR, companySkillDirs, userCompanies } from "../agent/juice/companies.mjs";
const categories = loadSkillCategories();
const categoryOf = name => categories.find(c => c.skills.includes(name))?.name;
const agentNames = () => categories.flatMap(c => c.skills).sort();

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "agent-skills-test-"));
const skill = (dir, name) => {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
};
const quiet = { log: () => {}, warn: () => {} };
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
try {
	// Agent: system automática; design/plan sob demanda.
	test("agent/skills: nomes, frontmatter válido e créditos", () => {
		const dir = join(repo, "agent/skills");
		const expected = ["a11y", "award-site", "colors", "debug", "figma-to-code", "handoff", "html-plan", "iso-figure", "layout", "microcopy", "polish", "pr", "prototype", "rea", "sources", "tdd", "type", "ui-review"];
		assert.deepEqual(agentNames(), expected);
		assert.ok(existsSync(join(dir, "CREDITS.md")), "CREDITS.md com origem e licença");
		for (const name of expected) {
			const text = readFileSync(join(dir, categoryOf(name), name, "SKILL.md"), "utf8");
			const head = /^---\n([\s\S]*?)\n---\n/.exec(text);
			assert.ok(head, `${name}: sem frontmatter`);
			const field = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head[1])?.[1]?.trim();
			assert.equal(field("name"), name, `${name}: name do frontmatter`);
			assert.equal(field("disable-model-invocation"), categoryOf(name) === "system" ? undefined : "true", `${name}: categoria decide visibilidade`);
			const description = field("description") ?? "";
			assert.ok(description.length > 20, `${name}: descrição`);
			// `: ` numa descrição sem aspas quebra o YAML e o Pi descarta a skill em silêncio.
			if (/:\s/.test(description.replace(/^["'].*["']$/s, ""))) assert.match(description, /^".*"$/s, `${name}: descrição com ": " precisa de aspas`);
		}
	});

	test("repo skills/ has the Agent defaults and they travel in the bundle", () => {
		const names = skillNames(join(repo, "skills"));
		assert.deepEqual(names, ["goal", "grill", "megamind", "peers", "prometheus", "repitch", "review", "skills", "ui-ux"]);
		assert.deepEqual(names.filter(name => agentNames().includes(name)), [], "overlay and Agent skills must not collide");
		assert.ok(skillFiles(repo).includes("skills/grill/SKILL.md"));
		assert.ok(!skillFiles(repo).some(file => file.startsWith("skills/debug/")));
	});

	test("categorias geram resumo determinístico sem system", () => {
        assert.deepEqual(categories.map(c => c.name), ['design', 'dev', 'plan', 'system']);
        assert.deepEqual(categories.find(c => c.name === 'system').skills, ['handoff', 'html-plan', 'pr', 'sources']);
        assert.equal(categoryPrompt().split('\n').length, 3);
        assert.equal(categoryPrompt(), categoryPrompt());
        assert.ok(!categoryPrompt().includes('system:'));
    });

	const source = join(root, "bundle");
	skill(join(source, "skills"), "grill");
	skill(join(source, "skills"), "review");
	writeFileSync(join(source, "skills", "grill", ".DS_Store"), "");
	const store = join(root, "store");
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	mkdirSync(store); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark", skills: ["!cua-driver"] }, null, 2)}\n`);

	test("copies defaults and appends one settings entry, keeping existing keys", () => {
		const result = syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, ...quiet });
		assert.deepEqual(result.installed, ["grill", "review"]);
		assert.ok(existsSync(join(store, "skills", "grill", "SKILL.md")));
		assert.ok(!existsSync(join(store, "skills", "grill", ".DS_Store")));
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(settings.theme, "dark");
		assert.deepEqual(settings.skills, ["!cua-driver", resolve(store, "skills")]);
	});

	test("second run is idempotent", () => {
		assert.equal(syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, ...quiet }).settingsUpdated, false);
	});

	test("register:false (Agent) refreshes an existing copy without touching settings", () => {
		writeFileSync(join(source, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: v2\n---\n");
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		const result = syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, register: false, ...quiet });
		assert.deepEqual(result.installed, ["grill", "review"]);
		assert.equal(result.settingsUpdated, false);
		assert.match(readFileSync(join(store, "skills", "review", "SKILL.md"), "utf8"), /v2/);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		const fresh = join(root, "fresh-store");
		mkdirSync(fresh);
		assert.deepEqual(syncAgentSkills({ sourceRoot: source, store: fresh, agentDir, homeDir, register: false, ...quiet }).installed, []);
		assert.ok(!existsSync(join(fresh, "skills")));
	});

	for (const register of [true, false]) test(`removed bundle skills disappear only from the managed copy (register:${register})`, () => {
		const removed = "debug";
		skill(join(source, "skills"), removed);
		syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, register, ...quiet });
		assert.ok(existsSync(join(store, "skills", removed, "SKILL.md")));
		skill(join(agentDir, "skills"), removed);
		skill(join(homeDir, ".agents", "skills"), removed);
		skill(join(homeDir, ".claude", "skills"), removed);
		const userFiles = [join(agentDir, "skills"), join(homeDir, ".agents", "skills"), join(homeDir, ".claude", "skills")]
			.map(dir => join(dir, removed, "SKILL.md"));
		const before = userFiles.map(file => readFileSync(file, "utf8"));
		const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
		rmSync(join(source, "skills", removed), { recursive: true });
		const result = syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, register, ...quiet });
		assert.deepEqual(result.installed, ["grill", "review"]);
		assert.ok(!existsSync(join(store, "skills", removed)));
		assert.deepEqual(userFiles.map(file => readFileSync(file, "utf8")), before);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), settings);
		for (const file of userFiles) rmSync(dirname(file), { recursive: true });
	});

	test("app links in ~/.agents/skills pointing at <store>/skills are not collisions", () => {
		mkdirSync(join(homeDir, ".agents", "skills"), { recursive: true });
		symlinkSync(join(store, "skills", "grill"), join(homeDir, ".agents", "skills", "grill"));
		const result = syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, ...quiet });
		assert.deepEqual(result.installed, ["grill", "review"]);
		assert.ok(existsSync(join(homeDir, ".agents", "skills", "grill", "SKILL.md")));
		rmSync(join(homeDir, ".agents", "skills", "grill"));
	});

	test("user skill with the same name wins; removed defaults disappear", () => {
		skill(join(agentDir, "skills"), "grill");
		skill(join(homeDir, ".agents", "skills"), "review");
		const result = syncAgentSkills({ sourceRoot: source, store, agentDir, homeDir, ...quiet });
		assert.deepEqual(result.skipped, ["grill", "review"]);
		assert.deepEqual(skillNames(join(store, "skills")), []);
	});

	test("invalid settings.json is left untouched", () => {
		const file = join(root, "bad.json");
		writeFileSync(file, "{ nope");
		assert.equal(ensureSettingsEntry(file, "/x", () => {}), false);
		assert.equal(readFileSync(file, "utf8"), "{ nope");
	});

	test("missing settings.json is created", () => {
		const file = join(root, "new", "settings.json");
		assert.equal(ensureSettingsEntry(file, "/x", () => {}), true);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { skills: ["/x"] });
	});

    test("categorias descobrem nomes do frontmatter recursivamente, sem ciclos", () => {
        const grouped = join(root, 'grouped');
        skill(join(grouped, 'design', 'nested', 'deeper'), 'palette');
        symlinkSync(grouped, join(grouped, 'design', 'cycle'));
        assert.deepEqual(loadSkillCategories(grouped), [{ name: 'design', skills: ['palette'] }]);
    });
    test("skills de empresa: escopo pelo enrollment, fora de agent/skills", () => {
        const scoped = join(root, 'company');
        skill(join(scoped, 'arca'), 'arca-deploy');
        skill(join(scoped, 'omni'), 'omni-tenant');
        assert.deepEqual(loadCompanySkillCategories(['arca'], scoped), [{ name: 'arca', skills: ['arca-deploy'] }]);
        assert.deepEqual(loadCompanySkillCategories([], scoped), []);
        assert.deepEqual(companySkillDirs(['omni', 'arca'], scoped), [join(scoped, 'omni'), join(scoped, 'arca')]);
        assert.deepEqual(companySkillDirs(['omni'], join(root, 'absent')), []);
        const home = join(root, 'home');
        assert.deepEqual(userCompanies({}, home), []);
        mkdirSync(join(home, '.config/omni-megamind'), { recursive: true });
        writeFileSync(join(home, '.config/omni-megamind/config.json'), '{}');
        assert.deepEqual(userCompanies({}, home), ['omni']);
        assert.deepEqual(userCompanies({ ARCA_MEGAMIND_CONFIG: 'none' }, home), []);
        // As reais: só arca/omni, frontmatter válido, nenhuma também em agent/skills.
        const real = loadSkillCategories(COMPANY_SKILLS_DIR);
        assert.deepEqual(real.map(c => c.name), ['arca', 'omni']);
        for (const c of real) for (const name of c.skills) {
            assert.ok(!agentNames().includes(name), `${name}: duplicada em agent/skills`);
            const text = readFileSync(join(COMPANY_SKILLS_DIR, c.name, name, 'SKILL.md'), 'utf8');
            assert.doesNotMatch(text.split('\n---')[0], /disable-model-invocation/, `${name}: skill de empresa é automática`);
        }
    });
    const sdkRoot = process.env.AGENT_JUICE_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
    const { loadSkills } = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
    test("Pi instalado descobre as três categorias e preserva flags", () => {
        const result = loadSkills({ cwd: root, agentDir: root, skillPaths: [join(repo, 'agent/skills')], includeDefaults: false });
        assert.deepEqual(result.skills.map(s => s.name).sort(), agentNames());
        assert.deepEqual(result.diagnostics, []);
        for (const s of result.skills) {
            assert.equal(s.disableModelInvocation, categoryOf(s.name) !== 'system', s.name);
            assert.equal(s.filePath, join(repo, 'agent/skills', categoryOf(s.name), s.name, 'SKILL.md'));
        }
    });

	console.log(`${checks} checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
