#!/usr/bin/env node
/**
 * Guarda de idioma (docs/harness-spec.md, item 3): o que o modelo lê fica em inglês.
 *
 * Carrega as extensões reais do Agent com jiti e um `pi` falso, e verifica sem rede:
 * - campos registrados de cada tool (description, promptSnippet, promptGuidelines) e todas as
 *   descriptions aninhadas do schema TypeBox;
 * - política, seção de notas, categorias de skills e as seções injetadas pelo project-prompt
 *   (estruturadas e no prompt forçado), o slot de peers, o loop guard e os prompts de /notes e /rules init;
 * - `description:` dos papéis em agent/agents/*.md.
 * Falha com diacríticos do português ou palavras comuns (quando, sempre, antes, depois, arquivo,
 * usuário, tarefa, resultado, pedido, mensagem, nenhum(a), ainda).
 * UI, notificações e docs não entram aqui.
 */
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionsIn } from './lib/agent-setup.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const store = process.env.AGENT_STORE || join(homedir(), '.local/share/agent');
const suffix = 'lib/node_modules/@earendil-works/pi-coding-agent';
const piRoot = process.env.AGENT_PI_ROOT || [join(store, 'current', suffix),
  ...(existsSync(join(store, 'releases')) ? readdirSync(join(store, 'releases')).sort().reverse().map(n => join(store, 'releases', n, suffix)) : [])]
  .find(p => existsSync(join(p, 'dist/index.js')));
assert.ok(piRoot, 'Pi instalado necessário para carregar as extensões reais');
const root = realpathSync(piRoot);
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const alias = {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  typebox: require.resolve('typebox'),
};
for (const dep of ['@earendil-works/pi-ai', '@earendil-works/pi-tui']) alias[dep] = join(root, 'node_modules', dep);
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias });

const sandbox = mkdtempSync(join(tmpdir(), 'agent-tool-language-'));
process.env.HOME = sandbox;
process.env.PI_CODING_AGENT_DIR = join(sandbox, '.agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
process.env.AGENT_RUNTIME_ENABLED = '1';
process.env.AGENT_CHILD = '0';
process.env.PI_ACCOUNTS_MIRROR = '0';

const DIACRITICS = /[áàâãäéèêëíìîïóòôõöúùûüçñ]/i;
// Only words that are not English and not common in URLs or acronyms (no sem, para, agora, com, nao).
const STOPWORDS = /\b(quando|sempre|antes|depois|arquivo|usu[aá]rio|tarefa|resultado|pedido|mensagem|nenhum|nenhuma|ainda)\b/i;
const failures = [];
let inspected = 0;
function check(where, text) {
  if (typeof text !== 'string' || !text) return;
  inspected++;
  for (const line of text.split('\n')) {
    const hit = DIACRITICS.exec(line) ?? STOPWORDS.exec(line);
    if (hit) failures.push(`${where}: «${hit[0]}» em ${JSON.stringify(line.trim().slice(0, 160))}`);
  }
}

/** Todas as descriptions/titles de um schema TypeBox/JSON Schema, com o caminho. */
function walkSchema(where, node, path = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => walkSchema(where, item, `${path}[${i}]`)); return; }
  for (const key of ['description', 'title']) if (typeof node[key] === 'string') check(`${where}${path}.${key}`, node[key]);
  for (const [key, value] of Object.entries(node)) {
    // Só pula o texto já checado: um objeto em `title`/`description` é uma propriedade com esse nome.
    if (value && typeof value === 'object') walkSchema(where, value, `${path}.${key}`);
  }
}

function checkTool(source, tool) {
  const where = `${source} tool ${tool.name}`;
  check(`${where}.description`, tool.description);
  check(`${where}.promptSnippet`, tool.promptSnippet);
  for (const [i, line] of (tool.promptGuidelines ?? []).entries()) check(`${where}.promptGuidelines[${i}]`, line);
  if (tool.namespace) {
    check(`${where}.namespace.description`, tool.namespace.description);
    check(`${where}.namespace.instructions`, tool.namespace.instructions);
  }
  walkSchema(`${where}.parameters`, tool.parameters);
}

/** `pi` falso: guarda tools e handlers; o resto é no-op. */
function fakePi(tools, handlers, commands, sent) {
  const noop = () => {};
  const base = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, command) => { commands.set(name, command); },
    sendMessage: (message) => { sent.push(message.content); },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    events: { on: noop, emit: noop, off: noop },
    getAllTools: () => [...tools.values()].map(t => ({ name: t.name, exposure: t.exposure ?? 'direct' })),
    getActiveTools: () => [...tools.keys()],
    setActiveTools: noop,
    getFlag: () => undefined,
    getThinkingLevel: () => 'off',
  };
  return new Proxy(base, { get: (target, key) => (key in target ? target[key] : noop) });
}

const tools = new Map();
const handlers = {};
const commands = new Map();
const sent = [];
const pi = fakePi(tools, handlers, commands, sent);
const toolSource = new Map();
const entries = [
  ...extensionsIn(join(repo, 'agent/extensions/agent')),
  ...extensionsIn(join(repo, 'agent/extensions/brain-live')),
  { name: 'megamind', path: join(repo, 'extensions/megamind') },
];
const loadErrors = [];
try {
  for (const entry of entries) {
    const file = existsSync(join(entry.path, 'index.ts')) ? join(entry.path, 'index.ts') : entry.path;
    const before = new Set(tools.keys());
    try {
      const factory = (await jiti.import(file)).default;
      if (typeof factory === 'function') await factory(pi);
    } catch (error) {
      loadErrors.push(`${entry.name}: ${error?.message ?? error}`);
    }
    for (const name of tools.keys()) if (!before.has(name)) toolSource.set(name, entry.name);
  }
  assert.deepEqual(loadErrors, [], `extensões não carregaram:\n${loadErrors.join('\n')}`);
  // Megamind só registra as tools no session_start; o registro em si é puro.
  const { registerMegamindTools } = await jiti.import(join(repo, 'extensions/megamind/tools.ts'));
  const megamindBefore = new Set(tools.keys());
  registerMegamindTools(pi, { presence: () => undefined, core: async () => { throw new Error('offline'); }, now: Date.now });
  for (const name of tools.keys()) if (!megamindBefore.has(name)) toolSource.set(name, 'megamind');
  for (const required of ['plan', 'todo', 'subagent', 'checks', 'jobs', 'ask_user', 'skim', 'web_search', 'web_fetch', 'peers_list', 'megamind_who']) {
    assert.ok(tools.has(required), `tool ${required} não registrada: ${[...tools.keys()].join(', ')}`);
  }
  // Propriedades chamadas title/description também são percorridas.
  const probe = { type: 'object', properties: {
    title: { type: 'string', description: 'Título da tarefa' },
    description: { type: 'object', title: 'Descrição', properties: { body: { type: 'string', description: 'quando usar' } } },
  } };
  const before = failures.length;
  walkSchema('probe', probe);
  assert.deepEqual(failures.splice(before).map(f => f.split(':')[0]),
    ['probe.properties.title.description', 'probe.properties.description.title', 'probe.properties.description.properties.body.description'],
    'walkSchema desce em propriedades title/description');
  // Stopwords: Portuguese without accents fails; English with look-alike tokens passes.
  const stopBefore = failures.length;
  check('probe-pt', 'megamind_reply: o resultado looks like a secret');
  check('probe-en', 'SEM image at https://agora.example/para?com=1; nao.example is a host');
  assert.deepEqual(failures.splice(stopBefore).map(f => f.split(':')[0]), ['probe-pt'], 'only the Portuguese probe fails');
  for (const [name, tool] of tools) checkTool(toolSource.get(name), tool);
  console.log(`ok ${tools.size} tools inspecionadas`);

  // plan só com steps; todo separada e deferred (decisão f).
  const plan = tools.get('plan');
  assert.deepEqual(Object.keys(plan.parameters.properties), ['steps'], 'plan só aceita steps');
  assert.equal(tools.get('todo').exposure, 'deferred', 'todo é deferred');
  console.log('ok plan só steps; todo deferred');

  // Swarm (item 5): tool deferred (schema já checado acima) e os textos que o modelo lê.
  assert.equal(tools.get('swarm')?.exposure, 'deferred', 'swarm é deferred');
  const swarm = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/swarm.ts'));
  // O texto oculto vem do próprio comando /swarm on.
  const sentBefore = sent.length;
  await commands.get('swarm').handler('on', { hasUI: false, ui: { notify() {}, setStatus() {} } });
  const hidden = sent.splice(sentBefore);
  assert.deepEqual(hidden, [swarm.SWARM_ON_TEXT], '/swarm on envia só o playbook');
  check('swarm /swarm on message', hidden[0]);
  check('swarm off error', swarm.SWARM_OFF_ERROR);
  check('swarm verdict contract', swarm.VERDICT_CONTRACT);
  console.log('ok swarm deferred e textos do /swarm em inglês');

  // Política, notas e categorias, direto dos módulos.
  const policy = await jiti.import(join(repo, 'agent/core/policy.mjs'));
  for (const [name, text] of Object.entries(policy.policySections())) check(`policy ${name}`, text);
  if (!/Reply to the user in their language\./.test(policy.AUTONOMY_POLICY)) failures.push("policy: missing Reply to the user in their language.");
  check('policy notesSection', policy.notesSection({ count: 12, ageDays: 3 }));
  check('policy appendPolicy', policy.appendPolicy('BASE'));
  const categories = await jiti.import(join(repo, 'agent/core/skill-categories.mjs'));
  check('skill categories', categories.categoryPrompt());
  console.log('ok política, notas e categorias');

  // Seções e wrapper injetados pelo project-prompt (estruturado e prompt forçado).
  for (const forced of [undefined, 'FORCED']) {
    const event = { messageType: 'user', systemPrompt: 'BASE', systemPromptOptions: { sections: {}, ...(forced ? { forceSystemPrompt: forced } : {}) } };
    const ctx = { cwd: sandbox, hasUI: false, mode: 'print', ui: { setStatus() {}, notify() {} }, model: undefined, sessionManager: { getBranch: () => [], getSessionId: () => 'x' } };
    let injected = '';
    for (const handler of handlers.before_agent_start ?? []) {
      try {
        const result = await handler(event, ctx);
        if (typeof result?.systemPrompt === 'string') injected += result.systemPrompt;
      } catch { /* handlers that need a real session are irrelevant here */ }
    }
    for (const [name, text] of Object.entries(event.systemPromptOptions.sections)) check(`section ${name}`, text);
    check(`forced prompt${forced ? '' : ' (none)'}`, injected);
    if (forced) assert.ok(injected.includes('<agent_skill_categories>'), 'prompt forçado recebe categorias');
  }
  // Prompts que /notes e /rules init mandam ao modelo.
  mkdirSync(join(sandbox, 'docs'), { recursive: true });
  writeFileSync(join(sandbox, 'docs', 'guide.md'), '# guide\n');
  const commandCtx = { cwd: sandbox, hasUI: false, ui: { notify() {} } };
  await commands.get('notes').handler('', commandCtx);
  await commands.get('rules').handler('init', commandCtx);
  assert.equal(sent.length, 2, 'notes e rules init mandam um prompt cada');
  sent.forEach((text, i) => check(`command prompt ${['notes', 'rules init'][i]}`, text));
  const { slotBlock } = await jiti.import(join(repo, 'agent/extensions/agent/peers/mesh.ts'));
  const peer = { short: 'abc123', project: 'demo', branch: 'main', status: 'idle', note: 'note', at: Date.now() };
  const now = Date.now();
  const slot = slotBlock([peer, { ...peer, short: 'old123', at: now - 3 * 3600_000 }, { ...peer, short: 'self01', self: true }], now)?.block;
  assert.match(slot, /^abc123 .* now$/m, 'par recente aparece no slot');
  assert.match(slot, /^old123 .* 3h$/m, 'par antigo aparece no slot');
  check('peers slot', slot);
  const guard = await jiti.import(join(repo, 'agent/core/loop-guard.mjs'));
  for (const name of ['NUDGE', 'CYCLE_NUDGE', 'STOP', 'CYCLE_STOP']) check(`loop guard ${name}`, guard[name]);
  console.log('ok seções injetadas, slot de peers e loop guard');

  // Wrappers fixos em runtime: dados de fixture em inglês ASCII, para o check medir só o texto do Agent.
  // Fora: corpo do usuário/par, ids e marcadores de protocolo ([peers …], [arca-megamind …], megamind:).
  const mesh = await jiti.import(join(repo, 'agent/extensions/agent/peers/mesh.ts'));
  const sender = { short: 'abc123', project: 'demo', branch: 'main' };
  for (const [name, built] of Object.entries({
    message: mesh.messageBlock({ id: 'p-00000001', from: sender, body: 'hello', at: Date.now(), reply_to: 'p-00000000' }),
    ask: mesh.askBlock({ id: 'p-00000002', from: sender, title: '', body: 'context', at: Date.now() }),
    reply: mesh.replyBlock({ id: 'p-00000002', from: sender, status: 'done', result: '', at: Date.now() }),
  })) {
    check(`peers ${name} block`, built.text);
    check(`peers ${name} guidance`, built.guidance);
  }
  const messaging = await jiti.import(join(repo, 'extensions/megamind/messaging.ts'));
  const remote = { handle: 'ana', session_id: 'abcdef123456', project_id: 'proj', label: 'pi demo', kind: 'agent' };
  const at = '2026-01-01T10:00:00Z';
  for (const item of [
    { id: 'r1', kind: 'ask', from: remote, created_at: at, body: 'context', ask: { title: '', status: 'open' } },
    { id: 'r1', kind: 'reply', from: remote, created_at: at, body: 'ok', ask: { title: 'fix', status: 'done' } },
    { id: 'r1', kind: 'reply', from: { handle: '' }, created_at: at, body: 'ok', ask: { title: 'fix', status: '' } },
    { id: 'm1', kind: 'message', from: remote, created_at: at, body: 'hi', attachments: [{ name: 'a.txt', size: 2048 }] },
  ]) check(`megamind ${item.kind} block`, messaging.formatInboxItem(item, undefined, 'demo'));
  const devices = await jiti.import(join(repo, 'extensions/megamind/devices.ts'));
  const hints = ['peers', 'local', 'remote'].map(place => devices.coordinateHint('abcdef123456', place, 'codex'));
  hints.forEach((hint, i) => check(`megamind coordinate hint ${i}`, hint));
  check('megamind overlap notice', messaging.overlapNotice({ who: 'pi demo', owner: 'Ana', branch: 'main', paths: 'a.ts', sameBranch: true, hint: hints[2] }));
  const soft = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/child-soft-deadline.ts'));
  check('subagent soft timeout', soft.SOFT_TIMEOUT_MESSAGE);
  // ask_user bloqueado por goal em execução: o reason vai para o modelo.
  mkdirSync(join(sandbox, '.pi/goals/g1'), { recursive: true });
  writeFileSync(join(sandbox, '.pi/goals/g1/state.md'), '# goal g1 — running\n');
  const blocked = await Promise.all((handlers.tool_call ?? []).map(h => Promise.resolve(h({ toolName: 'ask_user', toolCallId: 't', input: {} }, { cwd: sandbox, ui: { notify() {} } })).catch(() => undefined)));
  const reason = blocked.find(r => r?.block)?.reason;
  assert.ok(reason, 'ask_user bloqueado com goal em execução');
  check('ask_user goal block reason', reason);
  // Resultados e erros de runtime de peers e megamind (amostra representativa).
  const peerRow = { id: 'abcdef123456', short: 'abcdef', project: 'demo', branch: 'main', status: 'idle', note: '', at: Date.now(), cwd: '/tmp/demo', v: 2 };
  check('peers list (empty)', mesh.formatPeers([], Date.now()));
  check('peers list', mesh.formatPeers([peerRow, { ...peerRow, short: 'self01', self: true, v: 1 }], Date.now(), { queued: 1, delivered: 2 }));
  check('peers context', mesh.formatContext(peerRow, { busy: true, returned_messages: 1, total_messages: 3, char_limit: 100, truncated: true, messages: [{ role: 'user', text: 'x' }] }).replace(/\nuser: x$/, ''));
  for (const to of ['', 'zzzzzz']) check(`peers resolveTarget ${to || 'empty'}`, mesh.resolveTarget(to, [peerRow]).error);
  for (const body of ['', 'x'.repeat(1 << 20), 'token sk-ant-api03-' + 'a'.repeat(40)]) check('peers checkBody', mesh.checkBody(body).error);
  const megamindTools = await jiti.import(join(repo, 'extensions/megamind/tools.ts'));
  const { CoreError } = await jiti.import(join(repo, 'extensions/megamind/core.ts'));
  check('megamind conflict', megamindTools.formatCoreError(new CoreError('conflict', 'conflict', [{ session_id: 'abc', owner: '@ana', status: 'idle' }])));
  try { megamindTools.sessionOwner([], 'nobody'); } catch (error) { check('megamind sessionOwner', error.message); }
  // Com presença falsa, a validação dos argumentos responde antes de qualquer rede.
  const present = new Map();
  megamindTools.registerMegamindTools(fakePi(present, {}, new Map(), []), { presence: () => ({ session_id: 'abcdef123456' }), core: async () => { throw new Error('offline'); }, now: Date.now });
  check('megamind no presence', (await tools.get('megamind_send').execute('t', { to: '@ana', body: 'x' }, undefined, undefined, { cwd: sandbox })).content[0].text);
  for (const [name, params] of [['megamind_send', {}], ['megamind_send', { to: '@ana' }], ['megamind_ask', { to: '@ana' }], ['megamind_reply', {}], ['megamind_reply', { id: 'r1', status: 'bogus' }], ['megamind_reply', { id: 'r1', status: 'done', result: 'token sk-ant-api03-' + 'a'.repeat(40) }], ['megamind_send', { to: '@ana', body: 'token sk-ant-api03-' + 'a'.repeat(40) }], ['megamind_fetch', {}]]) {
    const out = await (present.get(name) ?? tools.get(name)).execute('t', params, undefined, undefined, { cwd: sandbox });
    check(`${name} ${JSON.stringify(params)}`, out?.content?.map(part => part.text ?? '').join('\n'));
  }

  // Mais resultados de runtime: checks, web, megamind who/prioridade, nota do peers.
  const checksRunner = await jiti.import(join(repo, 'agent/extensions/brain-live/checks/runner.ts'));
  const sample = [{ name: 'a', ok: false, ms: 10, tail: '' }, { name: 'b', ok: false, ms: 10, tail: '' }, { name: 'c', ok: true, ms: 10, tail: '' }];
  check('checks formatResults', checksRunner.formatResults(sample, { newFailures: ['a'], stillFailing: ['b'], fixed: ['c'] }));
  const allGreen = await checksRunner.gate({ root: sandbox, checks: [{ name: 'ok', cmd: 'true' }] });
  check('checks gate verdict', allGreen.verdict);
  const webCore = await jiti.import(join(repo, 'agent/extensions/agent/web/core.ts'));
  check('web wrapper', webCore.wrap('https://example.com', 'body'));
  check('megamind who', megamindTools.formatPeople([{ handle: 'ana', name: '', app_online: true, sessions: [] }, { handle: 'bob', name: '', app_online: false, sessions: [{ session_id: 'abc', status: 'idle' }] }], undefined, Date.now()).join('\n'));
  const priorities = await jiti.import(join(repo, 'extensions/megamind/priorities.ts'));
  check('megamind priority context', priorities.formatPriorityContext({ title: 'ship', done: 1, total: 2, next: 'docs', blocked: ['ci'] }, 'demo'));
  for (const note of ['', 'x']) check('peers note', (await tools.get('peers_status').execute('t', { note })).content[0].text.replace(/: x$/, ''));
  // Skills de sistema: o corpo do SKILL.md é lido pelo modelo.
  for (const dir of readdirSync(join(repo, 'agent/skills/system'))) {
    const file = join(repo, 'agent/skills/system', dir, 'SKILL.md');
    if (existsSync(file)) check(`skill system/${dir}`, readFileSync(file, 'utf8'));
  }

  // Erros de skills do launch (nome desconhecido, caminho, agy, papel com nome inválido).
  const childSkills = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/skills.ts'));
  childSkills.runnerSkillHooks.catalog = async () => [{ name: 'debug', filePath: '/skills/debug/SKILL.md' }];
  for (const [role, extra] of [
    [{ name: 'worker', skills: ['debug'] }, ['nope']],
    [{ name: 'worker', skills: ['debug'] }, ['../x/SKILL.md']],
    [{ name: 'gemini', runner: 'agy' }, ['debug']],
    [{ name: 'custom', skills: ['nope'] }, []],
  ]) {
    const resolved = await childSkills.resolveChildSkills(role, extra, sandbox);
    assert.equal(resolved.ok, false, `skills error for ${role.name}`);
    check(`subagent skills error ${role.name}`, resolved.error);
  }
  // Handoff injetado ou carregado por /handoff: wrapper e notas de desatualizado.
  const handoffLib = await jiti.import(join(repo, 'agent/extensions/brain-live/lib/handoff.ts'));
  const handoffText = handoffLib.stampHandoffText('body', { session: 's1', created_at: '2026-01-01T00:00:00.000Z', branch: 'main', head: 'a'.repeat(40) });
  const repoState = { branch: 'feature', head: 'b'.repeat(40) };
  check('handoff wrapper', handoffLib.handoffMessage(handoffText, { inject: true, ageMs: 0 }, repoState));
  for (const reason of ['old', 'other-branch', 'unstamped', 'missing-head', 'diverged', 'not-new']) {
    check(`handoff stale ${reason}`, handoffLib.handoffMessage(handoffText, { inject: false, ageMs: 30 * 3600_000, reason }, repoState).replace('body', ''));
  }
  console.log('ok wrappers de runtime: peers, megamind, soft timeout, bloqueio do ask_user, erros de skills e handoff');

  // Papéis: o description: entra na descrição da tool subagent.
  for (const file of readdirSync(join(repo, 'agent/agents')).filter(f => f.endsWith('.md'))) {
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(repo, 'agent/agents', file), 'utf8'))?.[1] ?? '';
    const description = /^description:\s*(.*)$/m.exec(head)?.[1];
    assert.ok(description, `${file} sem description`);
    check(`agents/${file} description`, description);
  }
  console.log('ok descrições de papéis');

  assert.ok(inspected > 50, `poucos textos inspecionados: ${inspected}`);
  assert.deepEqual(failures, [], `texto lido pelo modelo fora do inglês:\n${failures.join('\n')}`);
  console.log(`ok ${inspected} textos em inglês`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(0);
