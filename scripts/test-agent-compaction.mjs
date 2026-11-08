#!/usr/bin/env node
// Compactação do Mark: motor nativo, modelo separado, preservação e gatilho por limiar.
// Hooks públicos com pi/ctx falsos. modelRegistry.streamSimple é um dublê;
// compact()/serialização/validação são os reais do SDK. Nenhuma inferência externa.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SDK real instalado: as extensões resolvem `@earendil-works/*` contra ele (serializeConversation
// de verdade), como o host faz. Sem rede e sem modelo.
const piRoot = process.env.MARK_JUICE_PI_ROOT || join(homedir(), '.local/share/pi-overlay/current/lib/node_modules/@earendil-works/pi-coding-agent');
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
const vaultRoot = mkdtempSync(join(tmpdir(), 'mark-compaction-'));
mkdirSync(join(vaultRoot, 'Pi'), { recursive: true });
process.env.PI_SYSTEM_DIR = vaultRoot;
const TEMPLATE = 'LEGACY_VAULT_SENTINEL {{CONVERSA}}';
writeFileSync(join(vaultRoot, 'Pi', 'compactacao.md'), TEMPLATE + '\n');

// Ledger do Juice ligado mas apontado para um bin inexistente: as extensões rodam o caminho
// real (recordJuiceCacheEvent é best-effort e engole a falha) sem broker nem estado global.
process.env.MARK_JUICE_ENABLED = '1';
process.env.MARK_JUICE_BIN = join(vaultRoot, 'bin-inexistente');
process.env.MARK_JUICE_HOME = vaultRoot;
process.env.MARK_JUICE_STATE = join(vaultRoot, 'run.json');
delete process.env.MARK_JUICE_CHILD;
delete process.env.MARK_CACHE_KEEPER;

const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
const compaction = await load('mark/extensions/brain-live/compaction.ts');
const cacheKeeper = await load('mark/extensions/brain-live/cache-keeper.ts');
const juice = await load('mark/extensions/brain-live/juice.ts');
const policy = await load('mark/juice/cache-policy.mjs');

let checks = 0;
const falhas = [];
// Coleta falhas em vez de parar na primeira: a evidência red de cada defeito aparece junta.
const test = async (name, fn) => {
  try { await fn(); checks += 1; console.log(`ok ${name}`); }
  catch (erro) { falhas.push(`${name}: ${erro?.message ?? erro}`); console.log(`not ok ${name}`); }
};

await test('aprendizado opt-in: só MARK_LEARN=1 no principal com modelo', () => {
  for (const value of [undefined, '', '0', 'true', 'yes']) assert.equal(juice.learnEligible('provider/model', { MARK_LEARN: value }), false);
  assert.equal(juice.learnEligible('provider/model', { MARK_LEARN: '1' }), true);
  assert.equal(juice.learnEligible(null, { MARK_LEARN: '1' }), false);
  assert.equal(juice.learnEligible('provider/model', { MARK_LEARN: '1', MARK_JUICE_CHILD: '1' }), false);
});

// ---------- /next: limites e elegibilidade do handoff ----------
await test('/next: hint somente acima de 60k', () => {
  assert.equal(juice.nextHint(60_000), false);
  assert.equal(juice.nextHint(60_001), true);
  assert.equal(juice.nextHint(undefined), false);
});

await test('/next: handoff só no primeiro run de usuário e recente', () => {
  const input = { messageType: 'user', firstRun: true, mtime: 1_000, now: 600_999 };
  assert.equal(juice.shouldInjectHandoff(input), true);
  assert.equal(juice.shouldInjectHandoff({ ...input, messageType: undefined }), true);
  assert.equal(juice.shouldInjectHandoff({ ...input, messageType: 'custom' }), false);
  assert.equal(juice.shouldInjectHandoff({ ...input, firstRun: false }), false);
  assert.equal(juice.shouldInjectHandoff({ ...input, now: 601_000 }), false);
  assert.equal(juice.shouldInjectHandoff({ ...input, mtime: 601_000 }), false);
});

// ---------- dublês ----------
const LUNA = { provider: 'openai-codex', id: 'gpt-6-luna', api: 'openai-codex-responses', contextWindow: 400_000 };
const MAIN = { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', contextWindow: 1_000_000 };

function fakeCtx({ model = MAIN, tokens = 0, contextWindow = 1_000_000, lunaFound = true, complete } = {}) {
  const notes = [];
  const statuses = [];
  const calls = [];
  const ctx = {
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mark-mode', data: { version: 1, mode: 'simple' } }], getEntries: () => [] },
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
  const base = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    registerCommand: (name, spec) => { commands[name] = spec; },
    sendUserMessage: text => sent.push(text),
    events: { emit: () => {}, on: () => {} },
  };
  // O resto da API de extensão (registerShortcut, setModel, ...) não interessa a estes testes.
  const pi = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}) });
  mod.default(pi);
  return { handlers, commands, sent };
}

await test('/next: ocupado recusa sem enviar, esperar, compactar ou trocar', async () => {
  const { commands, sent } = register(juice);
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
  const { handlers, commands, sent } = register(juice);
  const order = [];
  const ctx = fakeCtx();
  ctx.sessionManager = { getSessionFile: () => '/parent.jsonl' };
  ctx.waitForIdle = async () => { order.push('idle'); };
  ctx.newSession = async (options) => {
    assert.equal(options.parentSession, '/parent.jsonl');
    assert.equal(typeof options.setup, 'function');
    await options.setup({ appendCustomEntry: (type, data) => {
      assert.equal(type, 'mark-next');
      assert.deepEqual(data, { parentSession: '/parent.jsonl' });
    } });
    order.push('new');
    return { cancelled: false };
  };
  const pending = commands.next.handler('corrigir cache', ctx);
  await Promise.resolve();
  assert.deepEqual(order, [], 'não troca enquanto o agente trabalha');
  mkdirSync(join(vaultRoot, '.mark'), { recursive: true });
  writeFileSync(join(vaultRoot, '.mark/handoff.md'), 'handoff novo');
  for (const fn of handlers.agent_end) await fn({}, ctx);
  await pending;
  assert.deepEqual(order, ['idle', 'new']);
  assert.deepEqual(sent, ['/skill:handoff corrigir cache'], 'nenhuma mensagem pós-newSession');
});

await test('/next --keep: compacta em vez de trocar sessão', async () => {
  const { handlers, commands, sent } = register(juice);
  const ctx = fakeCtx();
  let compacted = 0;
  ctx.waitForIdle = async () => {};
  ctx.compact = () => { compacted++; };
  ctx.newSession = () => assert.fail('não deve trocar sessão');
  const pending = commands.next.handler('--keep próximo passo', ctx);
  writeFileSync(join(vaultRoot, '.mark/handoff.md'), 'handoff keep');
  for (const fn of handlers.agent_end) await fn({}, ctx);
  await pending;
  assert.equal(compacted, 1);
  assert.deepEqual(sent, ['/skill:handoff próximo passo']);
});

await test('/next: agente sem novo handoff não encerra a sessão', async () => {
  const { handlers, commands } = register(juice);
  const ctx = fakeCtx();
  ctx.waitForIdle = async () => {};
  ctx.sessionManager = { getSessionFile: () => '/parent.jsonl' };
  ctx.newSession = () => assert.fail('handoff anterior não autoriza troca');
  writeFileSync(join(vaultRoot, '.mark/handoff.md'), 'handoff anterior recente');
  const pending = commands.next.handler('', ctx);
  for (const fn of handlers.agent_end) await fn({}, ctx);
  await pending;
  assert.match(ctx.notes.at(-1)?.text ?? '', /Handoff/);
});

await test('/next: agent_settled atualiza estado e formatadores de compatibilidade preservam hint', async () => {
  const { handlers } = register(juice);
  for (const tokens of [60_001, 60_000]) {
    const ctx = fakeCtx({ tokens });
    await handlers.agent_settled[0]({}, ctx);
    const state = globalThis[Symbol.for('mark.state')]();
    assert.equal(state.nextHint, tokens > 60_000);
    const panel = await load('mark/juice/panel.ts');
    const theme = { fg: (_c, text) => text };
    assert.equal(panel.footerLine(200, theme, state)[0].includes('· /next encerra a tarefa'), tokens > 60_000);
    assert.equal(panel.markStatus(theme, state).includes('· /next encerra a tarefa'), tokens > 60_000);
  }
});

await test('/next: run custom não consome elegibilidade do primeiro run de usuário', async () => {
  for (const messageType of ['user', undefined]) {
    const { handlers } = register(juice);
    const ctx = fakeCtx();
    const file = join(vaultRoot, '.mark/handoff.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'handoff após custom');
    assert.equal(await handlers.before_agent_start[0]({ messageType: 'custom' }, ctx), undefined);
    assert.equal(existsSync(file), true, 'custom não consome arquivo');
    assert.deepEqual(await handlers.before_agent_start[0]({ messageType }, ctx), {
      message: { customType: 'mark-handoff', content: 'handoff após custom', display: false },
    });
    writeFileSync(file, 'não reinjetar');
    assert.equal(await handlers.before_agent_start[0]({ messageType }, ctx), undefined);
  }
});

await test('/next: injeção invisível uma vez e consumo por rename', async () => {
  const { handlers } = register(juice);
  const ctx = fakeCtx();
  mkdirSync(join(vaultRoot, '.mark'), { recursive: true });
  writeFileSync(join(vaultRoot, '.mark/handoff.md'), 'DECISÃO do handoff');
  const invoke = async () => {
    const results = [];
    for (const fn of handlers.before_agent_start) results.push(await fn({ messageType: 'user' }, ctx));
    return results.filter(r => r?.message?.customType === 'mark-handoff');
  };
  assert.deepEqual(await invoke(), [{ message: { customType: 'mark-handoff', content: 'DECISÃO do handoff', display: false } }]);
  assert.equal(existsSync(join(vaultRoot, '.mark/handoff.md')), false);
  assert.equal(readFileSync(join(vaultRoot, '.mark/handoff.consumed.md'), 'utf8'), 'DECISÃO do handoff');
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
  const result = await handlers.session_before_compact[0]({ preparation: prep(), reason: 'manual' }, ctx);
  assert.equal(result, undefined);
  assert.match(ctx.notes.at(-1).text, /falhou/);
});

await test('cancelamento não chama modelo nem retorna resumo', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await handlers.session_before_compact[0]({ preparation: prep(), signal: controller.signal }, ctx), { cancel: true });
  assert.equal(ctx.calls.length, 0);
});

await test('hook real: /compact com instruções mantém o texto no prompt enviado à Luna', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const event = { preparation: prep(), customInstructions: 'liste apenas os comandos que falharam', reason: 'manual' };
  const out = await handlers.session_before_compact[0](event, ctx);
  assert.ok(out?.compaction?.summary, 'resumo custom devolvido');
  assert.equal(ctx.calls.length, 1, 'uma chamada de resumo');
  const prompt = ctx.calls[0].request.messages[0].content[0].text;
  assert.match(JSON.stringify(ctx.calls[0].request), /liste apenas os comandos que falharam/, 'instruções do usuário chegaram ao prompt');
  assert.equal(ctx.calls[0].model.id, LUNA.id, 'resumo sai na Luna');
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
  await handlers.session_before_compact[0](event, ctx);
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
  await handlers.session_before_compact[0](event, ctx);
  const prompt = ctx.calls[0].request.messages[0].content[0].text;
  assert.match(JSON.stringify(ctx.calls[0].request), /PEDIDO-LONGO-DO-GABRIEL/, 'prefixo do turno partido não pode ser descartado');
  assert.match(JSON.stringify(ctx.calls[0].request), /TRABALHO-FEITO/);
});

await test('tokensBefore nativo preservado sem estimativa paralela', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx({ tokens: 480_000 });
  const event = { preparation: prep({ tokensBefore: 7 }), reason: 'threshold' };
  const out = await handlers.session_before_compact[0](event, ctx);
  assert.equal(out.compaction.tokensBefore, 7);
});

await test('arquivos lidos/escritos seguem no prompt e nos details do resumo', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx();
  const out = await handlers.session_before_compact[0]({ preparation: prep(), reason: 'manual' }, ctx);
  assert.match(out.compaction.summary, /a\.ts/); assert.match(out.compaction.summary, /b\.ts/);
  assert.deepEqual(out.compaction.details.readFiles, ['a.ts']);
  assert.deepEqual(out.compaction.details.modifiedFiles, ['b.ts']);
  assert.equal(out.compaction.firstKeptEntryId, 'entry-7', 'corte do pi preservado');
});

await test('falha do runtime alternativo devolve ao Pi sem resumo parcial', async () => {
  const { handlers } = register(compaction);
  const ctx = fakeCtx({ complete: () => { throw Error('context overflow fixture'); } });
  assert.equal(await handlers.session_before_compact[0]({ preparation: prep(), reason: 'threshold' }, ctx), undefined);
  assert.match(ctx.notes.at(-1).text, /falhou/);
});

// ---------- 3. gatilho automático por limiar (juice.ts) ----------
await test('limiar: 450k em 1M, 90% nas janelas menores', async () => {
  assert.equal(juice.compactThreshold(1_000_000), 450_000);
  assert.equal(juice.compactThreshold(200_000), 180_000);
});

function juiceSettled({ tokens, contextWindow = 1_000_000, gate }) {
  const { handlers } = register(juice);
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
  const t = juiceSettled({ tokens: 100_000, gate: () => true });
  await t.run();
  assert.equal(t.compactCalls.length, 0);
  t.restore();
});

await test('acima do limiar com cache frio compacta uma vez', async () => {
  const t = juiceSettled({ tokens: 460_000, gate: () => true });
  await t.run();
  assert.equal(t.compactCalls.length, 1);
  t.restore();
});

await test('acima do limiar com cache quente NÃO compacta: o gate do cache decide', async () => {
  let asked = 0;
  const t = juiceSettled({ tokens: 460_000, gate: () => { asked += 1; return false; } });
  await t.run();
  assert.equal(asked, 1, 'o gatilho automático consulta a política de cache');
  assert.equal(t.compactCalls.length, 0, 'ctx.compact() viraria compactação "manual" e furaria a política');
  t.restore();
});

await test('sem cache-keeper o gatilho automático continua funcionando', async () => {
  const t = juiceSettled({ tokens: 460_000, gate: undefined });
  await t.run();
  assert.equal(t.compactCalls.length, 1, 'ausência do hook não pode travar a compactação');
  t.restore();
});

await test('settled repetido não dispara compactações concorrentes', async () => {
  const t = juiceSettled({ tokens: 460_000, gate: () => true });
  await t.run(); await t.run(); await t.run();
  assert.equal(t.compactCalls.length, 1, 'uma compactação em voo por vez');
  t.compactCalls[0].onComplete?.({ summary: 's' });
  await t.run();
  assert.equal(t.compactCalls.length, 2, 'depois de concluir, um novo limiar pode disparar');
  t.restore();
});

await test('callbacks e eventos do Pi liberam o gatilho; queda de contexto não prova conclusão', async () => {
  const t = juiceSettled({ tokens: 460_000, gate: () => true });
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
  delete process.env.MARK_JUICE_CHILD;
  delete process.env.MARK_CACHE_KEEPER;
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

  // Gate do gatilho automático (juice.ts) vê a mesma época: nova compactação, novo orçamento.
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
if (!existsSync(loaderEntry)) {
  console.log('# sem loader do Pi instalado: seção do loader real pulada');
} else {
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(loaderEntry).href);
  const { createEventBus } = await import(pathToFileURL(join(piRoot, 'dist/core/event-bus.js')).href);
  const paths = ['cache-keeper.ts', 'compaction.ts'].map((f) => join(repo, 'mark/extensions/brain-live', f));
  const loaded = await loadExtensions(paths, vaultRoot, createEventBus(), createExtensionRuntime());
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

  await test('loader real: /compact manual passa pelo cache e leva as instruções à Luna', async () => {
    const ctx = fakeCtx({ tokens: 460_000 });
    warmUp(ctx);
    const out = await emit({ reason: 'manual', preparation: prep(), customInstructions: 'MANTENHA os números do ledger' }, ctx);
    assert.ok(out?.compaction?.summary, 'manual nunca é bloqueado pelo cache');
    assert.equal(ctx.calls.length, 1);
    assert.match(JSON.stringify(ctx.calls[0].request), /MANTENHA os números do ledger/);
  });
}

rmSync(vaultRoot, { recursive: true, force: true });
if (falhas.length) {
  console.error(`\n${falhas.length} falha(s):\n` + falhas.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`\n${checks} checks ok`);
