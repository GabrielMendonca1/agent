#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';
import { GENERATED_MARKER, rebuildAgents, renderAgents, selectProjectContext } from '../agent/core/project-context.mjs';
import { projectRules, readWorkflow } from '../agent/core/workflow.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.AGENT_PI_ROOT || join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
const root = mkdtempSync(join(tmpdir(), 'agent-project-context-'));
const home = join(root, 'home');
const profile = join(home, '.agent');
const project = join(root, 'project');
const originalProfile = join(resolve(piRoot, '../../../../..'), '.agent');
const req = createRequire(join(piRoot, 'package.json'));
const { createJiti } = req('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
  '@earendil-works/pi-ai': join(piRoot, 'node_modules/@earendil-works/pi-ai'),
  '@earendil-works/pi-tui': join(piRoot, 'node_modules/@earendil-works/pi-tui'),
} });
let fake;
try {
  mkdirSync(profile, { recursive: true });
  // Copy the audit profile, excluding credentials at every depth. Settings/models are replaced below.
  if (existsSync(originalProfile)) cpSync(originalProfile, profile, { recursive: true, filter: path => !['auth.json', 'sessions'].includes(path.split('/').at(-1)) });
  assert.equal(existsSync(join(profile, 'auth.json')), false);
  mkdirSync(join(project, '.agent'), { recursive: true });
  writeFileSync(join(profile, 'AGENTS.md'), 'PERSONAL_SENTINEL\n');
  writeFileSync(join(project, '.agent/rules.md'), 'RULE_SENTINEL\n');
  writeFileSync(join(project, '.agent/header.md'), 'HEADER_SENTINEL\n');
  writeFileSync(join(project, '.agent/notes.md'), 'NOTES_BODY_SECRET\n');
  writeFileSync(join(project, 'STATUS.md'), 'STATUS_BODY_SECRET\n');
  writeFileSync(join(project, 'HISTORY.md'), 'HISTORY_BODY_SECRET\n');
  mkdirSync(join(project, 'docs'));
  assert.equal(rebuildAgents(project), true);
  const built = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.equal(built, renderAgents(project));
  assert.equal(rebuildAgents(project), false, 'deterministic rebuild');
  assert.equal(built, readFileSync(join(project, 'AGENTS.md'), 'utf8'));
  const { contextFilesMessage } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/runner.ts'));
  const child = contextFilesMessage(project, profile);
  for (const text of ['RULE_SENTINEL', 'HEADER_SENTINEL', 'PERSONAL_SENTINEL', join(project, 'STATUS.md')]) assert.ok(child.includes(text), text);
  assert.ok(!child.includes(GENERATED_MARKER));
  assert.ok(!child.includes('STATUS_BODY_SECRET'));
  assert.ok(projectRules(project).includes('RULE_SENTINEL'));
  assert.ok(projectRules(project).includes('HEADER_SENTINEL'));
  writeFileSync(join(project, '.agent/workflow.md'), '## Regras aprendidas\n- LEGACY_SENTINEL\n');
  assert.ok(!projectRules(project).includes('LEGACY_SENTINEL'), 'rules suppress legacy workflow');
  assert.equal(readWorkflow(project), 'RULE_SENTINEL\n');

  const { installProjectContext } = await jiti.import(join(repo, 'agent/extensions/brain-live/lib/project-context.ts'));
  const commands = {}; const hooks = {};
  installProjectContext({ on: (name, fn) => { hooks[name] = fn; }, registerCommand: (name, cmd) => { commands[name] = cmd; }, sendMessage: (message, options) => { commands.sent = message; commands.sentOptions = options; } });
  const notices = []; const ui = { notify: (...args) => notices.push(args), select: async (_title, choices) => choices[1] };
  await commands.remember.handler('UI_RULE', { cwd: project, hasUI: true, ui });
  assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').includes('- UI_RULE'));
  const beforeCancel = readFileSync(join(project, '.agent/rules.md'), 'utf8');
  await commands.remember.handler('CANCELED_RULE', { cwd: project, hasUI: true, ui: { ...ui, select: async () => undefined } });
  assert.equal(readFileSync(join(project, '.agent/rules.md'), 'utf8'), beforeCancel);
  const empty = join(root, 'empty'); mkdirSync(empty);
  await commands.remember.handler('NO_UI_RULE', { cwd: empty, hasUI: false, ui });
  assert.match(notices.at(-1)[0], /Sem UI/);
  assert.equal(existsSync(join(empty, '.agent/rules.md')), false);
  await commands.rules.handler('init', { cwd: project, ui });
  assert.match(commands.sent.content, /Replace the manual AGENTS.md explicitly/);
  assert.equal(commands.sent.display, false, 'prompt em inglês oculto no TUI');
  assert.deepEqual(commands.sentOptions, { triggerTurn: true, deliverAs: 'followUp' });
  assert.deepEqual(notices.at(-1), ['Pedido enviado ao agente: migrar AGENTS.md para .agent/rules.md e .agent/header.md.', 'info']);

  fake = await startFakeAnthropic([
    { tool: { name: 'edit', input: { path: '.agent/rules.md', oldText: 'RULE_SENTINEL', newText: 'EDITED_RULE' } } },
    { tool: { name: 'write', input: { path: '.agent/header.md', content: 'EDITED_HEADER\n' } } },
    { text: 'ok' },
  ]);
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ packages: [], skills: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }));
  writeFileSync(join(profile, 'models.json'), JSON.stringify({ providers: { fake: { api: 'anthropic-messages', apiKey: 'offline', baseUrl: fake.baseUrl, models: [{ id: 'context', name: 'context', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const extension = join(root, 'probe.ts');
  writeFileSync(extension, `import projectPrompt from ${JSON.stringify(join(repo, 'agent/extensions/brain-live/project-prompt.ts'))};
import { readFileSync, writeFileSync } from 'node:fs';
export default function(pi) {
 const commands = {}; const proxy = new Proxy(pi, { get(target, key) { if(key === 'registerCommand') return (name, cmd) => { commands[name] = cmd; target.registerCommand(name, cmd); }; return Reflect.get(target, key); } });
 projectPrompt(proxy);
 let done = false;
 pi.on('tool_result', (event, ctx) => {
   if (!event.isError && ['edit', 'write'].includes(event.toolName)) {
     const generated = readFileSync(ctx.cwd + '/AGENTS.md', 'utf8');
     if (event.toolName === 'edit' && !generated.includes('EDITED_RULE')) throw new Error('edit did not rebuild');
     if (event.toolName === 'write' && !generated.includes('EDITED_HEADER')) throw new Error('write did not rebuild');
   }
 });
 pi.on('agent_end', async (_event, ctx) => {
   if(done) return; done = true;
   await commands.remember.handler('REMEMBERED_RULE', { ...ctx, hasUI: false });
   if (!readFileSync(ctx.cwd + '/AGENTS.md', 'utf8').includes('- REMEMBERED_RULE')) throw new Error('remember did not rebuild');
   await commands.remember.handler('PERSONAL_REMEMBERED', { ...ctx, hasUI: true, ui: { ...ctx.ui, select: async (_title, choices) => choices[0] } });
   if (!readFileSync(${JSON.stringify(join(profile, 'AGENTS.md'))}, 'utf8').includes('- PERSONAL_REMEMBERED')) throw new Error('personal remember failed');
   writeFileSync(${JSON.stringify(join(root, 'remember-ok'))}, 'ok');
   pi.sendUserMessage('Verify stable context', { deliverAs: 'followUp' });
   await commands.rules.handler('init', ctx);
 });
}`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', AGENT_RUNTIME_ENABLED: '1', AGENT_CHILD: '0', NODE_OPTIONS: '' };
  const run = (cwd, extensions) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(piRoot, 'dist/cli.js'), '-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', ...extensions.flatMap(file => ['-e', file]), '--model', 'fake/context', '--tools', 'read,edit,write', 'Check context'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); assert.equal(code, 0, output); resolveRun(output); });
  });
  const system = body => body.system.map(block => block.text).join('\n');
  const output = await run(project, [extension]);
  assert.ok(!/Error|did not rebuild/.test(output), output);
  assert.ok(existsSync(join(root, 'remember-ok')), output);
  const prompts = fake.messages().map(system);
  assert.ok(prompts.length >= 5, 'tool cycles, fresh user turn and /rules init turn');
  const lastText = body => { const content = body.messages.at(-1).content; return typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''); };
  assert.ok(fake.messages().some(body => body.messages.at(-1).role === 'user' && lastText(body).startsWith('Migrate this project context to the Agent sources.')), '/rules init chega ao modelo e dispara um turno');
  for (const prompt of prompts) {
    for (const text of ['RULE_SENTINEL', 'HEADER_SENTINEL', 'PERSONAL_SENTINEL', join(project, 'AGENTS.md'), join(project, '.agent/notes.md'), join(project, 'STATUS.md')]) assert.ok(prompt.includes(text), text);
    for (const text of [GENERATED_MARKER, 'STATUS_BODY_SECRET', 'NOTES_BODY_SECRET', 'HISTORY_BODY_SECRET', 'REMEMBERED_RULE', 'PERSONAL_REMEMBERED', 'EDITED_HEADER', 'EDITED_RULE']) assert.ok(!prompt.includes(text), text);
    assert.equal(prompt, prompts[0], 'fixed session snapshot, including subsequent user turn');
  }
  const manual = 'MANUAL_SENTINEL\n';
  writeFileSync(join(project, 'AGENTS.md'), manual);
  assert.equal(rebuildAgents(project), false);
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), manual);
  const count = fake.messages().length;
  await run(project, [join(repo, 'agent/extensions/brain-live/project-prompt.ts')]);
  const manualPrompt = system(fake.messages()[count]);
  assert.ok(manualPrompt.includes(manual)); assert.ok(manualPrompt.includes('/rules init'));
  assert.ok(manualPrompt.includes('- PERSONAL_REMEMBERED'), 'new session refreshes personal snapshot');
  assert.ok(!manualPrompt.includes('EDITED_RULE'), 'manual project context remains whole, not mixed with sources');
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), manual);
  rmSync(join(project, '.agent/rules.md'));
  assert.ok(projectRules(project).includes('LEGACY_SENTINEL'), 'legacy fallback');
  const personal = [{ path: join(profile, 'AGENTS.md'), content: GENERATED_MARKER + '\npersonal' }];
  assert.deepEqual(selectProjectContext(personal, empty, profile), personal, 'personal never transformed');
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), renderAgents(repo), 'repository AGENTS.md matches sources byte for byte');
  console.log('PASS project context: real Pi prompt, edit/write/remember disk rebuild, stable session, manual guard, children and repository sync');
} finally {
  if (fake) await fake.close();
  rmSync(root, { recursive: true, force: true });
}
