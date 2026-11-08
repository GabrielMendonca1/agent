#!/usr/bin/env node
// Catálogo completo para comandos; anúncio automático mínimo. SDKs reais, sem modelo/rede.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as policy from '../mark/juice/skill-policy.mjs';
const root = process.env.MARK_JUICE_PI_ROOT || join(homedir(), '.local/share/pi-overlay/current/lib/node_modules/@earendil-works/pi-coding-agent');
const dir = mkdtempSync(join(tmpdir(), 'mark-skill-policy-'));
const savedEnv = { ...process.env };
const names = ['peers', 'megamind', 'prometheus', 'tasks', 'diagram', 'arca-ops', 'omni-ops', 'goal', 'grill', 'cua', 'debug', 'tdd', 'pr', 'handoff', 'sources', 'html-plan', 'ui-review', 'pessoal'];
try {
  for (const name of names) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Uso de ${name}\n---\n`);
  }
  const bytes = names.map(name => readFileSync(join(dir, name, 'SKILL.md'), 'utf8'));
  for (const entry of ['dist/index.js']) {
    const sdk = await import(pathToFileURL(join(root, entry)).href);
    const source = names.map(name => ({ name, description: `Uso de ${name}`, filePath: join(dir, name, 'SKILL.md'), baseDir: join(dir, name), source: 'user', disableModelInvocation: false }));
    const before = JSON.stringify(source);
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: sdk.SettingsManager.inMemory({ packages: [] }), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, skillsOverride: () => ({ skills: source, diagnostics: [] }) });
    await loader.reload();
    assert.equal(loader.getSkills().skills.length, names.length);
    policy.restoreSkillPolicyEnvironment(process.env);
    process.env.PI_AUTOMATIC_SKILLS = 'pessoal'; // configuração nativa a preservar no opt-out
    policy.installSkillPolicy(sdk.formatSkillsForPrompt);
    policy.installSkillPolicy(sdk.formatSkillsForPrompt); // idempotente
    const result = loader.getSkills();
    assert.deepEqual(result.skills.map(s => s.name), names, 'todos continuam disponíveis para /skill:');
    assert.deepEqual(result.skills.filter(s => !s.disableModelInvocation).map(s => s.name), names, 'catálogo e flags nativos intactos');
    const prompt = sdk.formatSkillsForPrompt(result.skills);
    for (const name of names) assert.equal(prompt.includes(`<name>${name}</name>`), policy.automaticSkillNames().includes(name), `${entry}: anúncio de ${name}`);
    assert.equal(JSON.stringify(source), before, 'o catálogo original não é mutado');
    assert.deepEqual(names.map(name => readFileSync(join(dir, name, 'SKILL.md'), 'utf8')), bytes, 'arquivos pessoais intactos');
    await loader.reload();
    assert.equal(sdk.formatSkillsForPrompt(loader.getSkills().skills), prompt, 'reload mantém curadoria');
    policy.restoreSkillPolicyEnvironment(process.env);
    assert.equal(process.env.PI_AUTOMATIC_SKILLS, 'pessoal', 'opt-out restaura env nativa anterior');
    assert.deepEqual([...sdk.formatSkillsForPrompt(result.skills).matchAll(/<name>([^<]+)<\/name>/g)].map(m => m[1]), ['pessoal']);
    delete process.env.PI_AUTOMATIC_SKILLS;
    console.log(`ok ${entry}: pessoais e system automáticas, catálogo inteiro, fonte intacta e reload`);
  }
  assert.deepEqual(policy.automaticSkillNames(), ['peers', 'megamind', 'prometheus', 'cua', 'diagram', 'arca-ops', 'omni-ops', 'handoff', 'html-plan', 'pr', 'sources']);
  assert.equal(policy.isAutomaticSkill('debug'), false);
  assert.equal(policy.isAutomaticSkill('review'), false);
  assert.equal(policy.isAutomaticSkill('peers'), true);
  console.log('PASS skill-policy (SDK clássico, zero provider)');
} finally {
  for (const key of ['PI_AUTOMATIC_SKILLS', policy.PREVIOUS_SKILL_POLICY_ENV]) {
    if (Object.hasOwn(savedEnv, key)) process.env[key] = savedEnv[key]; else delete process.env[key];
  }
  rmSync(dir, { recursive: true, force: true });
}
