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
 * usuário, tarefa). UI, notificações e docs continuam em português e não entram aqui.
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
const STOPWORDS = /\b(quando|sempre|antes|depois|arquivo|usu[aá]rio|tarefa)\b/i;
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
    sendUserMessage: (text) => { sent.push(text); },
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
  for (const [name, tool] of tools) checkTool(toolSource.get(name), tool);
  console.log(`ok ${tools.size} tools inspecionadas`);

  // plan só com steps; todo separada e deferred (decisão f).
  const plan = tools.get('plan');
  assert.deepEqual(Object.keys(plan.parameters.properties), ['steps'], 'plan só aceita steps');
  assert.equal(tools.get('todo').exposure, 'deferred', 'todo é deferred');
  console.log('ok plan só steps; todo deferred');

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
