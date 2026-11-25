#!/usr/bin/env node
// Compactação do Agent: motor e modelo nativos, preservação e gatilho por limiar.
// Hooks públicos com pi/ctx falsos. modelRegistry.streamSimple é um dublê;
// compact()/serialização/validação são os reais do SDK. Nenhuma inferência externa.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SDK real instalado: as extensões resolvem `@earendil-works/*` contra ele (serializeConversation
// de verdade), como o host faz. Sem rede e sem modelo.
const piRoot = process.env.AGENT_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
assert.ok(existsSync(join(piRoot, 'package.json')), `pi instalado em ${piRoot}`);

// As extensões importam vizinhos sem extensão (`./vault-runtime`), como o bundler do host faz;
// o ESM do node exige o caminho completo. Hook de resolução só para este processo de teste.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    if (specifier.startsWith('@earendil-works/')) {
      const pkg = specifier === '@earendil-works/pi-coding-agent' ? piRoot : join(piRoot, 'node_modules', specifier);
      if (!existsSync(join(pkg, 'package.json'))) return next(specifier, context); // subcaminho: o resolvedor normal
      const entry = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
      const main = typeof entry.exports?.['.'] === 'string' ? entry.exports['.'] : (entry.exports?.['.']?.import ?? entry.module ?? entry.main ?? 'index.js');
      const file = join(pkg, typeof main === 'string' ? main : 'index.js');
      if (existsSync(file)) return next(pathToFileURL(file).href, context);
    }
    return next(specifier, context);
  },
});

// Vault temporário: PI_SYSTEM_DIR vence em lib/paths, e PI_VAULT_DIR é const de módulo
// resolvida no import — por isso o env vem antes do primeiro `import()`.
const vaultRoot = mkdtempSync(join(tmpdir(), 'agent-compaction-'));
process.on('exit', () => rmSync(vaultRoot, { recursive: true, force: true }));
mkdirSync(join(vaultRoot, 'Pi'), { recursive: true });
process.env.PI_SYSTEM_DIR = vaultRoot;
process.env.HOME = vaultRoot;
process.env.USERPROFILE = vaultRoot;
process.env.PI_CODING_AGENT_DIR = join(vaultRoot, 'agent');
const TEMPLATE = 'LEGACY_VAULT_SENTINEL {{CONVERSA}}';
writeFileSync(join(vaultRoot, 'Pi', 'compactacao.md'), TEMPLATE + '\n');

// Runtime ligado; variáveis legadas não devem criar estado de accounting.
process.env.AGENT_RUNTIME_ENABLED = '1';
process.env.AGENT_JUICE_BIN = join(vaultRoot, 'bin-inexistente');
process.env.AGENT_JUICE_HOME = vaultRoot;
process.env.AGENT_JUICE_STATE = join(vaultRoot, 'run.json');
delete process.env.AGENT_JUICE_CHILD;
delete process.env.AGENT_CHILD;
delete process.env.AGENT_CACHE_KEEPER;

const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
const compaction = await load('agent/extensions/brain-live/compaction.ts');
const cacheKeeper = await load('agent/extensions/brain-live/cache-keeper.ts');
const projectPrompt = await load('agent/extensions/brain-live/project-prompt.ts');
const policy = await load('agent/core/cache-policy.mjs');

let checks = 0;
const falhas = [];
// Coleta falhas em vez de parar na primeira: a evidência red de cada defeito aparece junta.
const test = async (name, fn) => {
  try { await fn(); checks += 1; console.log(`ok ${name}`); }
  catch (erro) { falhas.push(`${name}: ${erro?.message ?? erro}`); console.log(`not ok ${name}`); }
};

// ---------- /next: limites e elegibilidade do handoff ----------
await test('/next: hint somente acima de 60k', () => {
  assert.equal(projectPrompt.nextHint(60_000), false);
  assert.equal(projectPrompt.nextHint(60_001), true);
  assert.equal(projectPrompt.nextHint(undefined), false);
});

// ---------- handoff: carimbo, branch/HEAD, idade e aviso ----------
const handoff = await load('agent/extensions/brain-live/lib/handoff.ts');
const HOUR = 3600_000;

await test('handoff: carimbo idempotente substitui o frontmatter e nunca duplica ---', () => {
  const meta = { session: 's1', created_at: '2026-01-01T00:00:00.000Z', branch: 'main', head: 'a'.repeat(40) };
  const once = handoff.stampHandoffText('corpo\n', meta);
  assert.equal(once, `---\nsession: s1\ncreated_at: 2026-01-01T00:00:00.000Z\nbranch: main\nhead: ${'a'.repeat(40)}\n---\ncorpo\n`);
  const again = handoff.stampHandoffText(once, { ...meta, session: 's2' });
  assert.equal(again.match(/^---$/gm).length, 2, 'um único bloco de frontmatter');
  assert.deepEqual(handoff.parseHandoff(again), { meta: { ...meta, session: 's2' }, body: 'corpo\n' });
  assert.equal(handoff.stampHandoffText('---\nsession: velho\n---\n\ncorpo', { session: 'novo' }), '---\nsession: novo\n---\ncorpo');
});

await test('handoff: AGENT_HANDOFF_MAX_AGE (padrão 24 h; s/m/h/d; número puro = horas)', () => {
  assert.equal(handoff.handoffMaxAgeMs(undefined), 24 * HOUR);
  assert.equal(handoff.handoffMaxAgeMs('lixo'), 24 * HOUR);
  assert.equal(handoff.handoffMaxAgeMs('2'), 2 * HOUR);
  assert.equal(handoff.handoffMaxAgeMs('90m'), 90 * 60_000);
  assert.equal(handoff.handoffMaxAgeMs('3d'), 72 * HOUR);
});

await test('handoff: decisão por sessão nova, idade, branch e HEAD; sem git só a idade', () => {
  const git = { branch: 'main', head: 'b'.repeat(40), exists: sha => sha !== 'c'.repeat(40), isAncestor: sha => sha === 'a'.repeat(40) };
  const meta = { created_at: new Date(10 * HOUR).toISOString(), branch: 'main', head: 'a'.repeat(40) };
  const base = { meta, mtime: 0, now: 13 * HOUR, maxAgeMs: 24 * HOUR, git };
  const reason = (over) => { const d = handoff.handoffDecision({ ...base, ...over }); return d.inject ? 'inject' : d.reason; };
  assert.equal(reason({}), 'inject', 'HEAD descende do head do handoff');
  assert.equal(reason({ meta: { ...meta, head: git.head } }), 'inject', 'HEAD igual');
  assert.equal(reason({ newSession: false }), 'not-new');
  assert.equal(reason({ now: 34 * HOUR }), 'old', '24 h ou mais');
  assert.equal(reason({ meta: { ...meta, branch: 'feature' } }), 'other-branch');
  assert.equal(reason({ meta: { ...meta, head: 'c'.repeat(40) } }), 'missing-head');
  assert.equal(reason({ meta: { ...meta, head: 'd'.repeat(40) } }), 'diverged');
  assert.equal(reason({ meta: {} , mtime: 12 * HOUR }), 'unstamped');
  assert.equal(reason({ meta: {}, mtime: 12 * HOUR, git: undefined }), 'inject', 'sem git vale só a idade (mtime)');
  assert.equal(reason({ meta: {}, mtime: 0, now: 25 * HOUR, git: undefined }), 'old');
  const notice = (over) => handoff.handoffNotice(handoff.handoffDecision({ ...base, ...over }), over.meta ?? meta);
  assert.equal(notice({ meta: { ...meta, branch: 'feature' } }), 'Há um handoff de 3 h atrás na branch feature; use /handoff para carregar.');
  assert.equal(notice({ meta: { ...meta, head: 'c'.repeat(40) } }), 'Há um handoff de 3 h atrás na branch main, mas o commit ccccccc dele não existe mais (rebase ou amend?); use /handoff para carregar.');
  assert.match(notice({ meta: { ...meta, head: 'd'.repeat(40) } }), /feito sobre ddddddd, que não está no histórico do HEAD atual; use \/handoff/);
  assert.match(notice({ now: 60 * HOUR }), /^Há um handoff de 2 dias atrás na branch main; use \/handoff para carregar\.$/);
});


// ---------- dublês ----------
const LUNA = { provider: 'openai-codex', id: 'gpt-6-luna', api: 'openai-codex-responses', contextWindow: 400_000 };
const MAIN = { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', contextWindow: 1_000_000 };

function fakeCtx({ model = MAIN, tokens = 0, contextWindow = 1_000_000, lunaFound = false, complete } = {}) {
  const notes = [];
  const statuses = [];
  const calls = [];
  const ctx = {
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'agent-mode', data: { version: 1, mode: 'simple' } }], getEntries: () => [] },
    hasUI: true,
    isIdle: () => true,
    cwd: vaultRoot,
    model,
    ui: { notify: (text, level) => notes.push({ text, level }), setStatus: (k, t) => statuses.push([k, t]) },
    getContextUsage: () => ({ tokens, contextWindow }),
    modelRegistry: {
      find: (p, id) => (lunaFound && p === LUNA.provider && id === LUNA.id ? LUNA : undefined),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'offline', headers: { 'x-h': 'v' }, env: {} }),
      streamSimple: (m, request, options) => ({ result: async () => {
        calls.push({ model: m, request, options });
        if (complete) return complete({ model: m, request, options });
        return { stopReason: 'stop', content: [{ type: 'text', text: '## Objetivo\nresumo falso' }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      } }),
    },
    notes, statuses, calls,
  };
  return ctx;
}

function register(mod) {
  const handlers = {};
  const commands = {};
  const sent = [];
  const messages = [];
  const base = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    registerCommand: (name, spec) => { commands[name] = spec; },
    sendUserMessage: text => sent.push(text),
    sendMessage: (message, options) => messages.push([message, options]),
    events: { emit: () => {}, on: () => {} },
  };
  // O resto da API de extensão (registerShortcut, setModel, ...) não interessa a estes testes.
  const pi = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}) });
  mod.default(pi);
  return { handlers, commands, sent, messages };
}

await test('handoff: repo git real — carimbo pelo hook de write, mesma branch injeta; rebase/outra branch avisam', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'agent-handoff-git-'));
  try {
    const git = (...args) => { const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const { handlers, commands } = register(projectPrompt);
    const ctx = { ...fakeCtx(), cwd: repoDir };
    ctx.sessionManager = { ...ctx.sessionManager, getSessionId: () => 'sessao-1' };
    const file = join(repoDir, '.agent/handoff.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'CORPO do handoff\n');
    for (const fn of handlers.tool_result) await fn({ toolName: 'write', input: { path: '.agent/handoff.md' }, isError: false }, ctx);
    const stamped = handoff.parseHandoff(readFileSync(file, 'utf8'));
    assert.deepEqual([stamped.meta.session, stamped.meta.branch, stamped.meta.head, stamped.body], ['sessao-1', 'main', git('rev-parse', 'HEAD'), 'CORPO do handoff\n']);
    for (const fn of handlers.tool_result) await fn({ toolName: 'edit', input: { path: file }, isError: false }, ctx);
    assert.equal(readFileSync(file, 'utf8').match(/^---$/gm).length, 2, 'edit recarimba sem duplicar');
    const text = readFileSync(file, 'utf8');
    for (const fn of handlers.tool_result) await fn({ toolName: 'write', input: { path: 'outro.md' }, isError: false }, ctx);
    assert.equal(readFileSync(file, 'utf8'), text, 'outro arquivo não carimba');

    // Commit posterior: HEAD descende do head carimbado → injeta na primeira mensagem.
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'depois');
    const first = async (h, c) => { for (const fn of h.before_agent_start) { const r = await fn({ messageType: 'user' }, c); if (r?.message?.customType === 'agent-handoff') return r.message; } };
    const injected = await first(handlers, ctx);
    assert.equal(injected.display, false);
    assert.match(injected.content, /^Handoff from a previous session \(session sessao-1, written .*, branch main, commit [0-9a-f]{7}\)\. Continue from it\.\n<handoff>\nCORPO do handoff\n<\/handoff>$/);
    assert.ok(!existsSync(file) && existsSync(join(repoDir, '.agent/handoff.consumed.md')), 'consumido');

    // Outra branch: aviso visível, arquivo intacto; /handoff carrega com nota de desatualizado.
    writeFileSync(file, handoff.stampHandoffText('CORPO 2', { session: 's', created_at: new Date(Date.now() - 3 * HOUR).toISOString(), branch: 'feature', head: git('rev-parse', 'HEAD') }));
    const other = register(projectPrompt);
    const ctx2 = { ...fakeCtx(), cwd: repoDir };
    assert.equal(await first(other.handlers, ctx2), undefined);
    assert.deepEqual(ctx2.notes, [{ text: 'Há um handoff de 3 h atrás na branch feature; use /handoff para carregar.', level: 'info' }]);
    assert.ok(existsSync(file), 'nada é descartado');
    const sentMessages = other.messages;
    await other.commands.handoff.handler('', ctx2);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0][1], { deliverAs: 'nextTurn' });
    assert.equal(sentMessages[0][0].customType, 'agent-handoff');
    assert.match(sentMessages[0][0].content, /It may be outdated: it was written on branch feature; the current branch is main\./);
    assert.ok(!existsSync(file), '/handoff consome');
    assert.match(ctx2.notes.at(-1).text, /^Handoff carregado, com aviso/);
    await other.commands.handoff.handler('', ctx2);
    assert.equal(ctx2.notes.at(-1).text, 'Nenhum handoff pendente em .agent/handoff.md.');

    // Commit sumido (rebase/amend): aviso visível, nunca falha.
    writeFileSync(file, handoff.stampHandoffText('CORPO 3', { session: 's', created_at: new Date().toISOString(), branch: 'main', head: 'f'.repeat(40) }));
    const gone = register(projectPrompt);
    const ctx3 = { ...fakeCtx(), cwd: repoDir };
    assert.equal(await first(gone.handlers, ctx3), undefined);
    assert.match(ctx3.notes[0].text, /^Há um handoff de menos de 1 min atrás na branch main, mas o commit fffffff dele não existe mais \(rebase ou amend\?\); use \/handoff para carregar\.$/);

    // Sessão retomada (já tem resposta do assistente): oferece, não injeta.
    writeFileSync(file, handoff.stampHandoffText('CORPO 4', { session: 's', created_at: new Date().toISOString(), branch: 'main', head: git('rev-parse', 'HEAD') }));
    const resumed = register(projectPrompt);
    const ctx4 = { ...fakeCtx(), cwd: repoDir };
    ctx4.sessionManager = { getBranch: () => [{ type: 'message', message: { role: 'assistant' } }] };
    assert.equal(await first(resumed.handlers, ctx4), undefined);
    assert.match(ctx4.notes[0].text, /use \/handoff para carregar/);
    assert.ok(existsSync(file));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

await test('learning removido mesmo com opt-in legado', async () => {
  process.env.AGENT_LEARN = '1';
  const { handlers, commands } = register(projectPrompt);
  assert.equal(projectPrompt.learnEligible, undefined);
  assert.equal(commands.learn, undefined);
  assert.equal(handlers.session_before_compact, undefined);
  const ctx = fakeCtx();
  for (const event of ['agent_end', 'agent_settled']) {
    for (const handler of handlers[event] ?? []) await handler({}, ctx);
  }
  assert.equal(ctx.calls.length, 0);
  assert.equal(existsSync(join(vaultRoot, '.agent/workflow.md')), false);
  delete process.env.AGENT_LEARN;
});

await test('/next: ocupado recusa sem enviar, esperar, compactar ou trocar', async () => {
  const { commands, sent } = register(projectPrompt);
  const ctx = fakeCtx();
  ctx.isIdle = () => false;
  ctx.waitForIdle = () => assert.fail('não deve esperar o turno anterior');
  ctx.compact = () => assert.fail('não deve compactar');
  ctx.newSession = () => assert.fail('não deve trocar sessão');
  const pending = commands.next.handler('--keep', ctx);
  assert.deepEqual(sent, [], 'não envia handoff enquanto ocupado');
  await pending;
  assert.deepEqual(ctx.notes, [{ text: 'Espere o turno terminar para usar /next', level: 'warning' }]);
});

await test('/next: espera handoff antes de trocar; preserva pai e não envia após troca', async () => {
  const { handlers, commands, sent } = register(projectPrompt);
  const order = [];
  const ctx = fakeCtx();
  ctx.sessionManager = { getSessionFile: () => '/parent.jsonl' };
  ctx.waitForIdle = async () => { order.push('idle'); };
  ctx.newSession = async (options) => {
    // Written without the write tool (as through bash): /next stamps it before switching.
    const stamped = handoff.parseHandoff(readFileSync(join(vaultRoot, '.agent/handoff.md'), 'utf8'));
    assert.ok(Date.parse(stamped.meta.created_at) > 0, 'carimbado antes do newSession');
    assert.equal(stamped.body, 'handoff novo');
    assert.equal(options.parentSession, '/parent.jsonl');
    assert.equal(typeof options.setup, 'function');
    await options.setup({ appendCustomEntry: (type, data) => {
      assert.equal(type, 'agent-next');
      assert.deepEqual(data, { parentSession: '/parent.jsonl' });
    } });
    order.push('new');
    return { cancelled: false };
  };
  const pending = commands.next.handler('corrigir cache', ctx);
  await Promise.resolve();
  assert.deepEqual(order, [], 'não troca enquanto o agente trabalha');
  mkdirSync(join(vaultRoot, '.agent'), { recursive: true });
  writeFileSync(join(vaultRoot, '.agent/handoff.md'), 'handoff novo');
  for (const fn of handlers.agent_end) await fn({}, ctx);
  await pending;
  assert.deepEqual(order, ['idle', 'new']);
  assert.deepEqual(sent, ['/skill:handoff corrigir cache'], 'nenhuma mensagem pós-newSession');
});

await test('/next --keep: compacta em vez de trocar sessão', async () => {
  const { handlers, commands, sent } = register(projectPrompt);
  const ctx = fakeCtx();
  let compacted = 0;
  ctx.waitForIdle = async () => {};
  ctx.compact = () => { compacted++; };
  ctx.newSession = () => assert.fail('não deve trocar sessão');
  const pending = commands.next.handler('--keep próximo passo', ctx);
  writeFileSync(join(vaultRoot, '.agent/handoff.md'), 'handoff keep');
  for (const fn of handlers.agent_end) await fn({}, ctx);
  await pending;
  assert.equal(compacted, 1);
  assert.deepEqual(sent, ['/skill:handoff próximo passo']);
});

await test('/next: agente sem novo handoff não encerra a sessão', async () => {
  const { handlers, commands } = register(projectPrompt);
  const ctx = fakeCtx();
  ctx.waitForIdle = async () => {};
  ctx.sessionManager = { getSessionFile: () => '/parent.jsonl' };
  ctx.newSession = () => assert.fail('handoff anterior não autoriza troca');
  writeFileSync(join(vaultRoot, '.agent/handoff.md'), 'handoff anterior recente');
  const pending = commands.next.handler('', ctx);
  for (const fn of handlers.agent_end) await fn({}, ctx);
  await pending;
  assert.match(ctx.notes.at(-1)?.text ?? '', /Handoff/);
});

await test('/next: agent_settled atualiza estado e formatadores de compatibilidade preservam hint', async () => {
  const { handlers } = register(projectPrompt);
  for (const tokens of [60_001, 60_000]) {
    const ctx = fakeCtx({ tokens });
    await handlers.agent_settled[0]({}, ctx);
    const state = globalThis[Symbol.for('agent.state')]();
    assert.equal(state.nextHint, tokens > 60_000);
    const panel = await load('agent/core/panel.ts');
    const theme = { fg: (_c, text) => text };
    assert.equal(panel.footerLine(200, theme, state)[0].includes('· /next encerra a tarefa'), tokens > 60_000);
    assert.equal(panel.agentStatus(theme, state).includes('· /next encerra a tarefa'), tokens > 60_000);
  }
});

await test('/next: run custom não consome elegibilidade do primeiro run de usuário', async () => {
  for (const messageType of ['user', undefined]) {
    const { handlers } = register(projectPrompt);
    const ctx = fakeCtx();
    const file = join(vaultRoot, '.agent/handoff.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'handoff após custom');
    assert.equal(await handlers.before_agent_start[0]({ messageType: 'custom' }, ctx), undefined);
    assert.equal(existsSync(file), true, 'custom não consome arquivo');
    const result = await handlers.before_agent_start[0]({ messageType }, ctx);
    assert.equal(result?.message?.customType, 'agent-handoff');
    assert.match(result.message.content, /^Handoff from a previous session\. Continue from it\.\n<handoff>\nhandoff após custom\n<\/handoff>$/);
    writeFileSync(file, 'não reinjetar');
    assert.equal(await handlers.before_agent_start[0]({ messageType }, ctx), undefined);
  }
});

await test('/next: injeção invisível uma vez e consumo por rename', async () => {
  const { handlers } = register(projectPrompt);
  const ctx = fakeCtx();
  mkdirSync(join(vaultRoot, '.agent'), { recursive: true });
  writeFileSync(join(vaultRoot, '.agent/handoff.md'), 'DECISÃO do handoff');
  const invoke = async () => {
    const results = [];
    for (const fn of handlers.before_agent_start) results.push(await fn({ messageType: 'user' }, ctx));
    return results.filter(r => r?.message?.customType === 'agent-handoff');
  };
  assert.deepEqual(await invoke(), [{ message: { customType: 'agent-handoff', content: 'Handoff from a previous session. Continue from it.\n<handoff>\nDECISÃO do handoff\n</handoff>', display: false } }]);
  assert.equal(existsSync(join(vaultRoot, '.agent/handoff.md')), false);
  assert.equal(readFileSync(join(vaultRoot, '.agent/handoff.consumed.md'), 'utf8'), 'DECISÃO do handoff');
  assert.deepEqual(await invoke(), []);
});

const msg = (role, text) => ({ role, content: [{ type: 'text', text }], timestamp: 1 });
const prep = (over = {}) => ({
  firstKeptEntryId: 'entry-7',
  messagesToSummarize: [msg('user', 'preciso do seletor'), msg('assistant', 'feito')],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 123_456,
  fileOps: { read: new Set(['a.ts']), edited: new Set(['b.ts']), written: new Set() },
  settings: { reserveTokens: 16384, keepRecentTokens: 20000 },
  ...over,
});

const { compact: nativeCompact } = await import(pathToFileURL(join(piRoot, 'dist/core/compaction/compaction.js')).href);
// Model the host continuation, not an extension-owned summary or fallback.
async function nativeAfterHook(handler, event, ctx) {
  assert.equal(await handler(event, ctx), undefined, 'hook deixa preparação e instruções com o host');
  return { compaction: await nativeCompact(event.preparation, ctx.model, 'offline', {},
    event.customInstructions, event.signal, undefined, ctx.modelRegistry.streamSimple) };
}

// ---------- compactação pelo motor nativo; o template antigo não governa ----------
await test('modelo já é Luna: host nativo cuida do resumo sem override', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx({ model: LUNA });
  assert.equal(await handlers.session_before_compact[0]({ preparation: prep(), reason: 'manual' }, ctx), undefined);
  assert.equal(ctx.calls.length, 0);
});

for (const stopReason of ['length', 'error']) await test(`resumo ${stopReason} não vira checkpoint`, async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx({ complete: () => ({ stopReason, content: [{ type: 'text', text: 'PARCIAL' }], errorMessage: 'fixture' }) });
  await assert.rejects(nativeAfterHook(handlers.session_before_compact[0], { preparation: prep(), reason: 'manual' }, ctx));
  assert.equal(ctx.calls.length, 1, 'sem retry alternativo');
});

await test('cancelamento não chama modelo nem retorna resumo', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await handlers.session_before_compact[0]({ preparation: prep(), signal: controller.signal }, ctx), { cancel: true });
  assert.equal(ctx.calls.length, 0);
});

await test('hook real: /compact com instruções mantém o texto no prompt enviado ao modelo selecionado', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const event = { preparation: prep(), customInstructions: 'liste apenas os comandos que falharam', reason: 'manual' };
  const out = await nativeAfterHook(handlers.session_before_compact[0], event, ctx);
  assert.ok(out?.compaction?.summary, 'resumo custom devolvido');
  assert.equal(ctx.calls.length, 1, 'uma chamada de resumo');
  const prompt = ctx.calls[0].request.messages[0].content[0].text;
  assert.match(JSON.stringify(ctx.calls[0].request), /liste apenas os comandos que falharam/, 'instruções do usuário chegaram ao prompt');
  assert.equal(ctx.calls[0].model, MAIN, 'resumo usa modelo selecionado');
  assert.doesNotMatch(JSON.stringify(ctx.calls[0].request), /LEGACY_VAULT_SENTINEL/);
  assert.equal(readFileSync(join(vaultRoot, 'Pi', 'compactacao.md'), 'utf8'), TEMPLATE + '\n', 'arquivo antigo permanece intacto');
});

// ---------- 2. preservação: resumo anterior, prefixo de turno e tokens ----------
await test('sem modelo alternativo ou auth: devolve ao host nativo', async () => {
  const { handlers } = register(compaction);
  for (const lunaFound of [false, true]) {
    const ctx = fakeCtx({ lunaFound });
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: 'fixture' });
    assert.equal(await handlers.session_before_compact[0]({ preparation: prep() }, ctx), undefined);
    assert.equal(ctx.calls.length, 0);
  }
});

await test('resumo anterior vem da preparation nativa', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  // O Pi clássico entrega previousSummary na preparation.
  const event = {
    preparation: prep({ previousSummary: 'RESUMO-ANTIGO' }),
    branchEntries: [{ type: 'compaction', id: 'c1', summary: 'RESUMO-ANTIGO', firstKeptEntryId: 'z' }],
    reason: 'threshold',
  };
  await nativeAfterHook(handlers.session_before_compact[0], event, ctx);
  const prompt = ctx.calls[0].request.messages[0].content[0].text;
  assert.match(JSON.stringify(ctx.calls[0].request), /RESUMO-ANTIGO/, 'resumo anterior preservado no prompt');
});

await test('turno partido: o prefixo do turno entra na conversa resumida', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const event = {
    preparation: prep({
      messagesToSummarize: [],
      turnPrefixMessages: [msg('user', 'PEDIDO-LONGO-DO-GABRIEL'), msg('assistant', 'TRABALHO-FEITO')],
      isSplitTurn: true,
    }),
    reason: 'threshold',
  };
  await nativeAfterHook(handlers.session_before_compact[0], event, ctx);
  const prompt = ctx.calls[0].request.messages[0].content[0].text;
  assert.match(JSON.stringify(ctx.calls[0].request), /PEDIDO-LONGO-DO-GABRIEL/, 'prefixo do turno partido não pode ser descartado');
  assert.match(JSON.stringify(ctx.calls[0].request), /TRABALHO-FEITO/);
});

await test('tokensBefore nativo preservado sem estimativa paralela', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx({ tokens: 480_000 });
  const event = { preparation: prep({ tokensBefore: 7 }), reason: 'threshold' };
  const out = await nativeAfterHook(handlers.session_before_compact[0], event, ctx);
  assert.equal(out.compaction.tokensBefore, 7);
});

await test('arquivos lidos/escritos seguem no prompt e nos details do resumo', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const out = await nativeAfterHook(handlers.session_before_compact[0], { preparation: prep(), reason: 'manual' }, ctx);
  assert.match(out.compaction.summary, /a\.ts/); assert.match(out.compaction.summary, /b\.ts/);
  assert.deepEqual(out.compaction.details.readFiles, ['a.ts']);
  assert.deepEqual(out.compaction.details.modifiedFiles, ['b.ts']);
  assert.equal(out.compaction.firstKeptEntryId, 'entry-7', 'corte do pi preservado');
});

await test('falha do runtime nativo propaga falha sem resumo parcial', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx({ complete: () => { throw Error('context overflow fixture'); } });
  await assert.rejects(nativeAfterHook(handlers.session_before_compact[0], { preparation: prep(), reason: 'threshold' }, ctx), /context overflow fixture/);
  assert.equal(ctx.calls.length, 1);
});

// ---------- 3. gatilho automático por limiar (project-prompt.ts) ----------
await test('limiar: 450k em 1M, 90% nas janelas menores', async () => {
  assert.equal(projectPrompt.compactThreshold(1_000_000), 450_000);
  assert.equal(projectPrompt.compactThreshold(200_000), 180_000);
});

function projectPromptSettled({ tokens, contextWindow = 1_000_000, gate }) {
  const { handlers } = register(projectPrompt);
  const compactCalls = [];
  const ctx = {
    ...fakeCtx({ tokens, contextWindow }),
    getContextUsage: () => ({ tokens, contextWindow }),
    compact: (options) => compactCalls.push(options ?? {}),
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  };
  const settled = handlers.agent_settled ?? [];
  const run = async () => { for (const fn of settled) await fn({}, ctx); };
  const restore = gate === undefined ? () => {} : policy.bindSessionCachePolicy(ctx, {
    cacheState: () => ({}),
    deferCompaction: (_event, context) => !gate(context),
  });
  return { run, compactCalls, handlers, ctx, restore };
}

await test('abaixo do limiar não compacta', async () => {
  const t = projectPromptSettled({ tokens: 100_000, gate: () => true });
  await t.run();
  assert.equal(t.compactCalls.length, 0);
  t.restore();
});

await test('acima do limiar com cache frio compacta uma vez', async () => {
  const t = projectPromptSettled({ tokens: 460_000, gate: () => true });
  await t.run();
  assert.equal(t.compactCalls.length, 1);
  t.restore();
});

await test('acima do limiar com cache quente NÃO compacta: o gate do cache decide', async () => {
  let asked = 0;
  const t = projectPromptSettled({ tokens: 460_000, gate: () => { asked += 1; return false; } });
  await t.run();
  assert.equal(asked, 1, 'o gatilho automático consulta a política de cache');
  assert.equal(t.compactCalls.length, 0, 'ctx.compact() viraria compactação "manual" e furaria a política');
  t.restore();
});

await test('sem cache-keeper o gatilho automático continua funcionando', async () => {
  const t = projectPromptSettled({ tokens: 460_000, gate: undefined });
  await t.run();
  assert.equal(t.compactCalls.length, 1, 'ausência do hook não pode travar a compactação');
  t.restore();
});

await test('settled repetido não dispara compactações concorrentes', async () => {
  const t = projectPromptSettled({ tokens: 460_000, gate: () => true });
  await t.run(); await t.run(); await t.run();
  assert.equal(t.compactCalls.length, 1, 'uma compactação em voo por vez');
  t.compactCalls[0].onComplete?.({ summary: 's' });
  await t.run();
  assert.equal(t.compactCalls.length, 2, 'depois de concluir, um novo limiar pode disparar');
  t.restore();
});

await test('callbacks e eventos do Pi liberam o gatilho; queda de contexto não prova conclusão', async () => {
  const t = projectPromptSettled({ tokens: 460_000, gate: () => true });
  await t.run();
  t.ctx.getContextUsage = () => ({ tokens: 120_000, contextWindow: 1_000_000 });
  await t.run();
  t.ctx.getContextUsage = () => ({ tokens: 460_000, contextWindow: 1_000_000 });
  await t.run();
  assert.equal(t.compactCalls.length, 1, 'poda não libera outro pedido em voo');
  t.compactCalls[0].onError(new Error('cancelled'));
  await t.run();
  assert.equal(t.compactCalls.length, 2, 'callback de erro libera nova tentativa');
  for (const fn of t.handlers.session_compact_failed ?? []) await fn({ aborted: true }, t.ctx);
  await t.run();
  assert.equal(t.compactCalls.length, 3, 'evento de falha/cancelamento libera nova tentativa');
  for (const fn of t.handlers.session_compact ?? []) await fn({}, t.ctx);
  await t.run();
  assert.equal(t.compactCalls.length, 4, 'evento de conclusão libera nova tentativa');
  t.restore();
});

// ---------- 4. contabilidade do adiamento (cache-keeper) ----------
function keeperWithWarmCache({ tokens = 460_000, contextWindow = 1_000_000 } = {}) {
  delete process.env.AGENT_JUICE_CHILD;
delete process.env.AGENT_CHILD;
  delete process.env.AGENT_CACHE_KEEPER;
  const { handlers } = register(cacheKeeper);
  const ctx = fakeCtx({ tokens, contextWindow });
  for (const fn of handlers.session_start ?? []) fn({}, ctx);
  // Request real Anthropic com cache_control de 1 h → prefixo quente.
  const payload = {
    model: MAIN.id,
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
  };
  for (const fn of handlers.before_provider_request) fn({ payload }, ctx);
  return { handlers, ctx };
}

await test('adiamento consultado só pelo hook de compaction.ts também consome o orçamento', async () => {
  // Ordem de carga invertida: compaction.ts pergunta pelo globalThis e cancela ANTES do handler
  // do keeper (o Pi para no 1º cancel) — o adiamento tem de ser contabilizado ali mesmo, senão
  // o orçamento nunca é consumido e a compactação por limiar fica adiada para sempre.
  const { ctx } = keeperWithWarmCache();
  const defer = policy.sessionCachePolicy(ctx).deferCompaction;
  const max = policy.compactionDecision({ reason: 'threshold', warm: true, tokens: 460_000, contextWindow: 1_000_000, ttlSeconds: 3600 }).maxTurns;
  let adiados = 0;
  for (let i = 0; i < max + 1; i += 1) if (defer({ reason: 'threshold', preparation: prep() }, ctx) === true) adiados += 1;
  assert.equal(adiados, max, `adia ${max} vezes e depois libera, mas adiou ${adiados}`);
});

await test('adiamento por cache quente é contabilizado UMA vez por evento', async () => {
  const { handlers, ctx } = keeperWithWarmCache();
  const defer = policy.sessionCachePolicy(ctx).deferCompaction;
  const event = { reason: 'threshold', preparation: prep() };
  assert.equal(defer(event, ctx), true, 'cache quente adia');
  const out = handlers.session_before_compact[0](event, ctx);
  assert.deepEqual(out, { cancel: true }, 'o mesmo evento segue adiado');
  const deferrals = ctx.statuses.filter(([, text]) => typeof text === 'string' && text.includes('adiada'));
  assert.equal(deferrals.length, 1, `orçamento consumido uma vez, não duas: ${JSON.stringify(deferrals)}`);
  assert.match(deferrals[0][1], /\(1\//);
});

await test('eventos distintos consomem o orçamento até liberar', async () => {
  const { handlers, ctx } = keeperWithWarmCache();
  const max = policy.compactionDecision({ reason: 'threshold', warm: true, tokens: 460_000, contextWindow: 1_000_000, ttlSeconds: 3600 }).maxTurns;
  assert.ok(max >= 1, `orçamento de adiamento: ${max}`);
  let allowed = 0;
  for (let i = 0; i < max + 1; i += 1) {
    const out = handlers.session_before_compact[0]({ reason: 'threshold', preparation: prep() }, ctx);
    if (out === undefined) allowed += 1;
  }
  assert.equal(allowed, 1, 'depois do orçamento, compacta');
});

await test('o gate do gatilho automático usa a mesma decisão de limiar', async () => {
  const { ctx } = keeperWithWarmCache();
  const gate = policy.allowAutoCompaction;
  assert.equal(typeof gate, 'function', 'cache-keeper expõe o gate do automático');
  assert.equal(gate(ctx), false, 'cache quente → não compacta agora');
  const duro = { ...ctx, getContextUsage: () => ({ tokens: 960_000, contextWindow: 1_000_000 }) };
  assert.equal(gate(duro), true, 'limite duro passa mesmo quente');
});

await test('host durável: compactação concluída no branch libera o orçamento, sem session_compact', async () => {
  // O extension-host durável não entrega `session_compact` às extensões: o orçamento de
  // adiamento é por compactação, então o fim dela tem de ser visto na entrada confirmada do
  // branch ativo. getEntries explode para provar que a leitura é por getBranch.
  const { handlers, ctx } = keeperWithWarmCache();
  let branch = [];
  ctx.sessionManager.getBranch = () => branch;
  ctx.sessionManager.getEntries = () => { throw new Error('getBranch é a fonte'); };
  const gate = (event) => handlers.session_before_compact[0](event, ctx);
  const max = policy.compactionDecision({ reason: 'threshold', warm: true, tokens: 460_000, contextWindow: 1_000_000, ttlSeconds: 3600 }).maxTurns;
  // Quantos adiamentos até o próximo "allow" (orçamento restante).
  const adiamentosAteLiberar = () => {
    for (let i = 0; i <= max + 1; i += 1) {
      if (gate({ reason: 'threshold', preparation: prep() }) === undefined) return i;
    }
    return Infinity;
  };
  assert.equal(adiamentosAteLiberar(), max, `orçamento inicial é ${max} adiamentos`);

  // Compactação TERMINOU de verdade: entrada com id e resumo, nenhum evento emitido.
  branch = [{ type: 'compaction', id: 'cmp-1', summary: 'resumo real', firstKeptEntryId: 'e1' }];
  assert.equal(adiamentosAteLiberar(), max, 'compactação confirmada no branch devolve o orçamento inteiro');
  const adiados = ctx.statuses.filter(([, t]) => typeof t === 'string' && t.includes('adiada'));
  assert.match(adiados.at(-max)[1], /\(1\//, 'a contagem de adiamentos reinicia em 1');

  // Mesmo id não reinicia outra vez: orçamento continua gasto.
  assert.equal(adiamentosAteLiberar(), 0, 'o mesmo id de compactação não devolve orçamento');

  // Pedido/falha: entrada sem resumo confirmado não reinicia nada.
  branch = [...branch, { type: 'compaction', id: 'cmp-2' }];
  assert.equal(adiamentosAteLiberar(), 0, 'entrada sem resumo (pedido/falha) não libera orçamento');

  // Gate do gatilho automático (project-prompt.ts) vê a mesma época: nova compactação, novo orçamento.
  branch = [...branch, { type: 'compaction', id: 'cmp-3', summary: 'segundo resumo', firstKeptEntryId: 'e9' }];
  const auto = policy.allowAutoCompaction;
  assert.equal(auto(ctx), false, 'cache quente + orçamento reiniciado → adia o gatilho automático');
});

await test('manual e overflow nunca são bloqueados pelo cache', async () => {
  const { handlers, ctx } = keeperWithWarmCache();
  assert.equal(handlers.session_before_compact[0]({ reason: 'manual', preparation: prep() }, ctx), undefined);
  assert.equal(handlers.session_before_compact[0]({ reason: 'overflow', preparation: prep() }, ctx), undefined);
});

await test('sessões isoladas e ciclo novo não herdam payload, memo nem orçamento', async () => {
  const a = keeperWithWarmCache();
  const b = keeperWithWarmCache();
  assert.notEqual(policy.sessionCachePolicy(a.ctx), policy.sessionCachePolicy(b.ctx));
  const event = { reason: 'threshold' };
  const pa = policy.sessionCachePolicy(a.ctx);
  assert.equal(pa.deferCompaction(event, a.ctx), true);
  assert.equal(pa.deferCompaction(event, { ...a.ctx }), true, 'ctx novo, mesmo manager/evento');
  assert.equal(a.ctx.statuses.filter(([, t]) => t?.includes('adiada')).length, 1);
  assert.equal(policy.sessionCachePolicy(b.ctx).deferCompaction(event, b.ctx), true);
  for (const f of a.handlers.session_shutdown) f({}, a.ctx);
  assert.equal(policy.sessionCachePolicy(a.ctx), undefined);
  assert.equal(policy.sessionCachePolicy(b.ctx).cacheState().warm, true);
  for (const f of a.handlers.session_start) f({}, a.ctx); // mesmo manager: /reload, /resume ou /new
  assert.equal(policy.sessionCachePolicy(a.ctx).cacheState().warm, undefined);
  assert.equal(policy.sessionCachePolicy(a.ctx).deferCompaction(event, a.ctx), false, 'memo antigo não sobrevive');
});

await test('cleanup antigo não remove conexão de runtime novo', async () => {
  const ctx = fakeCtx();
  const old = policy.bindSessionCachePolicy(ctx, { cacheState: () => ({ warm: false }) });
  const current = { cacheState: () => ({ warm: true }) };
  const cleanup = policy.bindSessionCachePolicy(ctx, current);
  old();
  assert.equal(policy.sessionCachePolicy(ctx), current);
  cleanup();
  assert.equal(policy.sessionCachePolicy(ctx), undefined);
});

// ---------- 5. loader REAL do Pi: as duas extensões juntas, cancel de verdade ----------
// Carrega cache-keeper.ts e compaction.ts com o loader do Pi instalado (mesmo jiti da
// distribuição) e emite `session_before_compact` pela cadeia de handlers com a MESMA regra do
// runner real (para no 1º cancel). Nenhuma chamada de modelo: o modelRegistry é dublê.
const loaderEntry = join(piRoot, 'dist/core/extensions/loader.js');
assert.ok(existsSync(loaderEntry), 'loader real obrigatório');
{
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(loaderEntry).href);
  const { createEventBus } = await import(pathToFileURL(join(piRoot, 'dist/core/event-bus.js')).href);
  const paths = ['cache-keeper.ts', 'compaction.ts'].map((f) => join(repo, 'agent/extensions/brain-live', f));
  const runtime = createExtensionRuntime();
  runtime.appendEntry = () => {}; // This loader-only fixture has no session writer.
  const loaded = await loadExtensions(paths, vaultRoot, createEventBus(), runtime);
  assert.deepEqual(loaded.errors, [], 'extensões carregam no loader real');
  const chain = loaded.extensions.flatMap((ext) => [...(ext.handlers.get('session_before_compact') ?? [])]);
  assert.equal(chain.length, 2, 'as duas extensões registram o hook');

  // Emissão com a semântica do runner real (runner.js: para no 1º cancel).
  const emit = async (event, ctx) => {
    let out;
    for (const handler of chain) {
      const r = await handler(event, ctx);
      if (r) { out = r; if (r.cancel) return r; }
    }
    return out;
  };

  const warmUp = (ctx) => {
    const payload = {
      model: MAIN.id,
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
    };
    for (const ext of loaded.extensions) {
      for (const fn of ext.handlers.get('session_start') ?? []) fn({}, ctx);
      for (const fn of ext.handlers.get('before_provider_request') ?? []) fn({ payload }, ctx);
    }
  };

  await test('loader real: limiar com cache quente cancela antes de qualquer resumo', async () => {
    const ctx = fakeCtx({ tokens: 460_000 });
    warmUp(ctx);
    const out = await emit({ reason: 'threshold', preparation: prep() }, ctx);
    assert.deepEqual(out, { cancel: true });
    assert.equal(ctx.calls.length, 0, 'nenhuma chamada de resumo durante o adiamento');
    const adiados = ctx.statuses.filter(([, t]) => typeof t === 'string' && t.includes('adiada'));
    assert.equal(adiados.length, 1, `orçamento consumido uma vez: ${JSON.stringify(adiados)}`);
  });

  await test('loader real: /compact manual passa pelo cache e leva as instruções ao modelo selecionado', async () => {
    const ctx = fakeCtx({ tokens: 460_000 });
    warmUp(ctx);
    const out = await nativeAfterHook(emit, { reason: 'manual', preparation: prep(), customInstructions: 'MANTENHA os números do pedido' }, ctx);
    assert.ok(out?.compaction?.summary, 'manual nunca é bloqueado pelo cache');
    assert.equal(ctx.calls.length, 1);
    assert.match(JSON.stringify(ctx.calls[0].request), /MANTENHA os números do pedido/);
  });
}

assert.equal(existsSync(join(vaultRoot, 'run.json')), false, 'nenhum ledger criado');
assert.equal(existsSync(join(vaultRoot, 'run.v3.json')), false);
rmSync(vaultRoot, { recursive: true, force: true });
if (falhas.length) {
  console.error(`\n${falhas.length} falha(s):\n` + falhas.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`\n${checks} checks ok`);
