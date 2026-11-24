#!/usr/bin/env node
// cache-keeper: janela de aquecimento pela curva de retorno e troca do payload no refresh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mkdtempSync as makeTemp, rmSync as removeTemp, readdirSync as listDir } from 'node:fs';
import { homedir, tmpdir as tempDir } from 'node:os';
// Locate the read-only Pi fixture before isolating HOME.
const testPiRoot = process.env.AGENT_PI_ROOT || join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
const isolated = makeTemp(join(tempDir(), 'agent-cache-check-'));
process.env.HOME = isolated;
process.env.USERPROFILE = isolated;
process.env.PI_CODING_AGENT_DIR = join(isolated, 'agent');
delete process.env.AGENT_CHILD;
process.on('exit', () => removeTemp(isolated, { recursive: true, force: true }));

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(join(repo, 'agent/extensions/brain-live/cache-keeper.ts')).href);
const { warmWindow } = mod;

// Poucas pausas registradas → janela padrão de 3 h.
assert.equal(warmWindow([{ s: 600 }], 3600), 3 * 3600);
// Sempre volta em 10 min → o TTL de 1 h já cobre; nenhum refresh.
assert.equal(warmWindow(Array.from({ length: 40 }, () => ({ s: 600 })), 3600), 0);
// Sempre volta em 2 h → aquece até cobrir (2 refreshes: 54 e 108 min).
assert.equal(warmWindow(Array.from({ length: 40 }, () => ({ s: 7200 })), 3600), 2 * 3240);
// Nunca volta (todas censuradas) → não vale aquecer.
assert.equal(warmWindow(Array.from({ length: 40 }, () => ({ s: 20 * 3600, c: 1 })), 3600), 0);
// Metade volta em ~3 h, metade some: aquece enquanto a chance por intervalo passa do limiar.
const mixed = [...Array.from({ length: 30 }, (_, i) => ({ s: 3 * 3600 + i * 60 })), ...Array.from({ length: 30 }, () => ({ s: 30 * 3600, c: 1 }))];
const w = warmWindow(mixed, 3600);
assert.ok(w >= 3 * 3240 && w <= 5 * 3240, `janela ${w}`);
// Peso por contexto: quem volta tarde tem contexto grande → compensa esperar mais.
const weighted = [...Array.from({ length: 20 }, () => ({ s: 3 * 3600, k: 300_000 })), ...Array.from({ length: 20 }, () => ({ s: 40 * 3600, c: 1, k: 10_000 }))];
assert.ok(warmWindow(weighted, 3600) >= 3 * 3240);
// TTL de 5 min: volta em 12 min → 2 refreshes (270 s e 540 s).
assert.equal(warmWindow(Array.from({ length: 40 }, () => ({ s: 720 })), 300), 540);

// Registro: guarda o último payload real e não altera requests sem cache_control.
const handlers = {};
const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerCommand: () => {} };
delete process.env.AGENT_CHILD; delete process.env.AGENT_CACHE_KEEPER;
mod.default(pi);
for (const name of ['before_provider_request', 'agent_settled', 'agent_start', 'session_shutdown']) assert.ok(handlers[name], name);
const payload = { system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'oi' }] };
assert.equal(handlers.before_provider_request[0]({ payload }), undefined);
assert.equal(handlers.before_provider_request[0]({ payload: { messages: [] } }), undefined);

// O aquecedor nativo do Pi (cacheWarming "idle") fica parado: com o keeper ligado, desligado e em filho.
const nativeWarmerStops = async (env) => {
  const saved = { AGENT_CACHE_KEEPER: process.env.AGENT_CACHE_KEEPER, AGENT_CHILD: process.env.AGENT_CHILD };
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const seen = {};
  try { mod.default({ on: (name, fn) => { (seen[name] ??= []).push(fn); }, registerCommand: () => {} }); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const decide = seen.cache_warming_decision ?? [];
  assert.equal(decide.length, 1, `cache_warming_decision registrado (${JSON.stringify(env)})`);
  assert.deepEqual(await decide[0]({ type: 'cache_warming_decision', warmCost: 0.01, missCost: 1, continuationProbability: 0.9, action: 'warm' }), { action: 'stop' });
};
await nativeWarmerStops({ AGENT_CACHE_KEEPER: undefined, AGENT_CHILD: undefined });
await nativeWarmerStops({ AGENT_CACHE_KEEPER: '0', AGENT_CHILD: undefined });
await nativeWarmerStops({ AGENT_CACHE_KEEPER: undefined, AGENT_CHILD: '1' });
assert.ok(handlers.cache_warming_decision, 'cache_warming_decision na sessão principal');

// ---- cache-policy (backend D/E/F/H/J + aquecimento seguro) ----
const policy = await import(pathToFileURL(join(repo, 'agent/core/cache-policy.mjs')).href);
const opus = { api: 'anthropic-messages', provider: 'anthropic', id: 'claude-opus-5-5', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
const sonnet = { api: 'anthropic-messages', provider: 'anthropic', id: 'claude-sonnet-5-5', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const codex = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6-sol', cost: { input: 1.25, output: 10, cacheRead: 0.125 } };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
// F: reescrita = input × 2 (1 h) ou cacheWrite do catálogo (5 min); OpenAI sem prêmio de escrita.
near(policy.rebuildCost(opus, 100_000, 3600).usd, 100_000 * 10e-6, '1h');
near(policy.rebuildCost(opus, 100_000, 300).usd, 100_000 * 6.25e-6, '5min');
near(policy.rebuildCost(codex, 100_000, 3600).usd, 100_000 * 1.25e-6, 'openai');
assert.equal(policy.rebuildCost({ api: 'x' }, 1000).usd, undefined, 'sem preço não inventa');
const sw = policy.modelSwitchEstimate({ from: opus, to: sonnet, tokens: 200_000, ttlSeconds: 3600, warm: true });
near(sw.rebuildUsd, 200_000 * 6e-6, 'troca: reescrita no sonnet'); near(sw.stayUsd, 200_000 * 0.5e-6, 'ficar: leitura no opus');
near(sw.extraUsd, sw.rebuildUsd - sw.stayUsd, 'extra'); assert.equal(sw.sameModel, false);
// Aquecimento seguro.
assert.deepEqual(policy.warmPlan({ messages: [] }, { model: opus, promptTokens: 10_000 }).maxTokens, 1);
assert.equal(policy.warmPlan({ thinking: { type: 'adaptive' } }, { model: opus, promptTokens: 10_000 }).maxTokens, 1);
assert.deepEqual(policy.warmPlan({ thinking: { type: 'enabled', budget_tokens: 4096 } }, { model: opus, promptTokens: 8_000, ttlSeconds: 3600 }), { action: 'skip', reason: 'thinking-budget' });
const big = policy.warmPlan({ thinking: { type: 'enabled', budget_tokens: 2048 } }, { model: opus, promptTokens: 600_000, ttlSeconds: 3600 });
assert.equal(big.action, 'replay'); assert.equal(big.maxTokens, 2049); assert.ok(big.worstCaseUsd <= 0.5);
assert.equal(policy.warmPlan({ thinking: { type: 'enabled', budget_tokens: 32_000 } }, { model: opus, promptTokens: 900_000, ttlSeconds: 3600 }).reason, 'cost-cap');
assert.equal(policy.warmPlan(null).reason, 'no-payload');
assert.equal(policy.warmPlan({}, { maxSessionUsd: 0 }).reason, 'session-cost-cap');
assert.equal(policy.warmPlan({}, { model: opus, promptTokens: 460_000, sessionSpentUsd: 4.8 }).reason, 'session-cost-cap');
assert.equal(policy.warmPlan({ thinking: { type: 'enabled', budget_tokens: 2048 } }, {
  model: opus, promptTokens: 600_000, ttlSeconds: 3600, sessionSpentUsd: 4.7,
}).reason, 'session-cost-cap');
// D: só o limiar é adiável; frio, limite duro e orçamento de adiamento liberam.
assert.equal(policy.compactionDecision({ reason: 'overflow', warm: true, tokens: 10, contextWindow: 1e6 }).action, 'allow');
assert.equal(policy.compactionDecision({ reason: 'manual', warm: true, tokens: 10, contextWindow: 1e6 }).action, 'allow');
assert.equal(policy.compactionDecision({ reason: 'threshold', warm: false, tokens: 460_000, contextWindow: 1e6 }).cause, 'cold');
const d = policy.compactionDecision({ reason: 'threshold', warm: true, tokens: 460_000, contextWindow: 1e6, ttlSeconds: 3600 });
assert.equal(d.action, 'defer'); assert.equal(d.hardLimit, 900_000); assert.ok(d.maxTurns >= 5 && d.maxTurns <= 12, `maxTurns ${d.maxTurns}`);
assert.equal(policy.compactionDecision({ reason: 'threshold', warm: true, tokens: 460_000, contextWindow: 1e6, deferredTurns: d.maxTurns }).cause, 'defer-budget');
assert.equal(policy.compactionDecision({ reason: 'threshold', warm: true, tokens: 905_000, contextWindow: 1e6 }).cause, 'hard-limit');
// H: mantém a chave da sessão principal; preenche quando falta; subagente usa o prefixo estável.
const resp = { model: 'gpt-6-sol', instructions: 'papel X', tools: [{ name: 'read' }], input: [{ role: 'user', content: 'a' }] };
assert.equal(policy.openaiCacheKey({ ...resp, prompt_cache_key: 'sess-1' }), undefined);
const k1 = policy.openaiCacheKey(resp);
assert.match(k1, /^agent-[0-9a-f]{16}$/);
assert.equal(policy.openaiCacheKey({ ...resp, input: [{ role: 'user', content: 'outra tarefa' }], prompt_cache_key: 'sess-2' }, { child: true }), k1, 'filhos do mesmo papel compartilham chave');
assert.notEqual(policy.openaiCacheKey({ ...resp, instructions: 'papel Y' }), k1);
// Codex children of one role in different worktrees: instructions differ only in <cwd> (and a
// legacy <project_context> with absolute paths); the key must not.
const codexChild = (cwd, role = 'papel X') => ({ ...resp, prompt_cache_key: `sess-${cwd}`, input: [{ role: 'user', content: `Task in ${cwd}` }],
  instructions: `${role}\n\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${cwd}/AGENTS.md">\nregras\n</project_instructions>\n</project_context>\n\n<skills>\ncatalog\n</skills>\n\n<cwd>\n${cwd}\n</cwd>` });
const kA = policy.openaiCacheKey(codexChild('/w/a'), { child: true });
assert.equal(policy.openaiCacheKey(codexChild('/w/b'), { child: true }), kA, 'Codex children in different cwds share prompt_cache_key');
assert.notEqual(policy.openaiCacheKey(codexChild('/w/b', 'papel Y'), { child: true }), kA, 'other role, other key');
assert.notEqual(policy.openaiCacheKey({ ...codexChild('/w/a'), instructions: codexChild('/w/a').instructions.replace('catalog', 'outro') }, { child: true }), kA, 'skills stay in the key');
assert.equal(policy.openaiCacheKey(payload), undefined, 'Anthropic não muda');
// J: causa da quebra, sem conteúdo.
const fp = policy.fingerprint(payload);
assert.equal(policy.breakCause(fp, policy.fingerprint({ ...payload, system: [{ type: 'text', text: 'y' }] })), 'prompt-changed');
assert.equal(policy.breakCause(fp, policy.fingerprint({ ...payload, tools: [{ name: 't' }] })), 'tools-changed');
assert.equal(policy.breakCause(fp, policy.fingerprint({ ...payload, thinking: { type: 'adaptive' } })), 'thinking-changed');
assert.equal(policy.breakCause(fp, fp, { elapsedS: 4000, ttlSeconds: 3600 }), 'ttl-expired');
assert.ok(!JSON.stringify(fp).includes('oi'), 'fingerprint não guarda texto');
// First changed segment: append-only prefixes remain intact, including Responses input.
const history = { ...payload, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }, { role: 'user', content: 'third' }] };
const historyFp = policy.fingerprint(history);
assert.deepEqual(policy.firstChangedSegment(historyFp, policy.fingerprint({ ...history, messages: [...history.messages, { role: 'user', content: 'new' }] })), { segment: 'none' });
assert.deepEqual(policy.firstChangedSegment(historyFp, policy.fingerprint({ ...history, messages: history.messages.map((m, i) => i === 1 ? { ...m, content: 'edit' } : m) })), { segment: 'message', index: 1 });
assert.deepEqual(policy.firstChangedSegment(historyFp, policy.fingerprint({ ...history, system: 'changed', tools: [{ name: 'new' }] })), { segment: 'system' });
assert.deepEqual(policy.firstChangedSegment(fp, policy.fingerprint({ ...payload, tools: [{ name: 'new' }] })), { segment: 'tools' });
assert.deepEqual(policy.firstChangedSegment(fp, policy.fingerprint({ ...payload, model: 'other' })), { segment: 'model' });
assert.deepEqual(policy.firstChangedSegment(fp, policy.fingerprint({ ...payload, thinking: { type: 'adaptive' } })), { segment: 'thinking' });
assert.deepEqual(policy.firstChangedSegment(undefined, fp), { segment: 'none' });
const inputFp = policy.fingerprint({ ...resp, input: history.messages });
assert.deepEqual(inputFp.messages, historyFp.messages);
assert.deepEqual(policy.firstChangedSegment(inputFp, policy.fingerprint({ ...resp, input: [...history.messages, { role: 'user', content: 'new' }] })), { segment: 'none' });
assert.deepEqual(policy.firstChangedSegment(inputFp, policy.fingerprint({ ...resp, input: history.messages.map((m, i) => i === 1 ? { ...m, content: 'edit' } : m) })), { segment: 'message', index: 1 });
assert.ok(historyFp.messages.every(hash => /^[0-9a-f]{16}$/.test(hash)), 'only message hashes');

// E: leque escalonado libera os demais no 1º token, em falha do líder e no timeout; respeita capacidade.
{
  const order = [];
  let release;
  const first = new Promise(r => { release = r; });
  const start = (t, i) => { order.push(`start${i}`); return { firstToken: i === 0 ? first : Promise.resolve(), done: (i === 0 ? first : Promise.resolve()).then(() => new Promise(r => setTimeout(() => r(t), 5))) }; };
  const pending = policy.staggeredFanout(['a', 'b', 'c'], start);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['start0'], 'segura os demais até o 1º token');
  release();
  const out = await pending;
  assert.equal(out.gate, 'first-token'); assert.deepEqual(out.results.map(r => r.value), ['a', 'b', 'c']);
  const failed = await policy.staggeredFanout(['a', 'b'], (t, i) => ({ firstToken: i === 0 ? Promise.reject(new Error('x')) : Promise.resolve(), done: i === 0 ? Promise.reject(new Error('x')) : Promise.resolve(t) }));
  assert.equal(failed.gate, 'leader-failed'); assert.equal(failed.results[1].value, 'b');
  const slow = await policy.staggeredFanout(['a', 'b'], (t) => ({ firstToken: new Promise(() => {}), done: new Promise(r => setTimeout(() => r(t), 40)) }), { firstTokenTimeoutMs: 10 });
  assert.equal(slow.gate, 'timeout'); assert.equal(slow.results.length, 2);
  let live = 0, peak = 0;
  await policy.staggeredFanout([1, 2, 3, 4, 5], () => { live++; peak = Math.max(peak, live); return { firstToken: Promise.resolve(), done: new Promise(r => setTimeout(() => { live--; r(); }, 5)) }; }, { maxConcurrent: 2 });
  assert.ok(peak <= 2, `capacidade ${peak}`);
  const pre = new AbortController(); pre.abort();
  assert.deepEqual(await policy.staggeredFanout(['a'], () => { throw new Error('não deveria iniciar'); }, { signal: pre.signal }), { gate: 'aborted', results: [] });
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10);
  const aborted = await policy.staggeredFanout(['a', 'b'], (t) => ({ firstToken: new Promise(() => {}), done: new Promise(r => setTimeout(() => r(t), 30)) }), { signal: ac.signal, firstTokenTimeoutMs: 1000 });
  assert.equal(aborted.gate, 'aborted'); assert.equal(aborted.results.length, 1, 'cancelado em voo: não dispara o resto');
}

// Hooks reais da extensão: D cancela só o limiar com cache quente; F emite estimativa; H em filho.
{
  const h = {}; const emitted = [];
  mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: () => {}, events: { emit: (n, d) => emitted.push([n, d]) } });
  const ctx = { sessionManager: {}, cwd: '/tmp/ck-test', hasUI: false, model: opus, getContextUsage: () => ({ tokens: 460_000, contextWindow: 1_000_000 }) };
  for (const f of h.session_start) f({}, ctx);
  const run = (name, ev) => h[name].map(f => f(ev, ctx)).find(r => r !== undefined);
  assert.equal(run('session_before_compact', { reason: 'threshold' }), undefined, 'sem request ainda: cache frio → compacta');
  for (const f of h.before_provider_request) f({ payload }, ctx);
  assert.deepEqual(run('session_before_compact', { reason: 'threshold' }), { cancel: true }, 'quente → adia');
  assert.equal(run('session_before_compact', { reason: 'overflow' }), undefined, 'overflow nunca adia');
  assert.equal(policy.sessionCachePolicy(ctx).deferCompaction({ reason: 'threshold' }, ctx), true);
  assert.equal(policy.sessionCachePolicy(ctx).allowPrune, undefined, 'contrato exclusivo de poda removido');
  assert.equal(policy.sessionCachePolicy(ctx).cacheState().warm, true);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3601_000;
    assert.equal(policy.sessionCachePolicy(ctx).cacheState().warm, false, 'TTL vencido continua observável');
  } finally { Date.now = realNow; }
  const preview = globalThis[Symbol.for('agent.cache-keeper.estimateSwitch')](sonnet, { ...ctx, model: opus });
  assert.ok(preview.rebuildUsd > preview.stayUsd && preview.tokens === 460_000, 'prévia antes da escolha');
  assert.equal(emitted.length, 0, 'prévia não emite nem avisa');
  run('model_select', { source: 'set', previousModel: opus, model: sonnet });
  assert.equal(emitted[0][0], 'agent:cache-estimate'); assert.equal(emitted[0][1].to, 'anthropic/claude-sonnet-5-5'); assert.ok(emitted[0][1].rebuildUsd > 0);
  run('model_select', { source: 'restore', previousModel: opus, model: sonnet });
  assert.equal(emitted.length, 1, 'restore não avisa');
  process.env.AGENT_CHILD = '1';
  const hc = {}; mod.default({ on: (n, f) => { (hc[n] ??= []).push(f); }, registerCommand: () => {} });
  delete process.env.AGENT_CHILD;
  assert.deepEqual(Object.keys(hc), ['cache_warming_decision', 'before_provider_request'], 'filho: aquecedor nativo parado e só a chave OpenAI');
  assert.match(hc.before_provider_request[0]({ payload: { ...resp, prompt_cache_key: 'sess-9' } }).prompt_cache_key, /^agent-/);
}

// E — filho de prefetch: 1º request vira aquecimento de tools+system; fora da Anthropic sai.
{
  assert.deepEqual(policy.prefetchPayload({ ...payload, thinking: { type: 'enabled', budget_tokens: 4096 }, max_tokens: 32000 }), { ...payload, max_tokens: 1 });
  assert.equal(policy.prefetchPayload({ messages: [], system: 'sem cache_control' }), undefined);
  assert.equal(policy.prefetchPayload(resp), undefined);
  Object.assign(process.env, { AGENT_CHILD: '1', AGENT_CACHE_PREFETCH: '1', AGENT_CACHE_PREFETCH_NO_EXIT: '1' });
  const h = {}; mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: () => {} });
  for (const k of ['AGENT_CHILD', 'AGENT_CACHE_PREFETCH', 'AGENT_CACHE_PREFETCH_NO_EXIT']) delete process.env[k];
  const send = (p) => h.before_provider_request.map(f => f({ payload: p })).find(r => r !== undefined);
  const first = send({ ...payload, thinking: { type: 'adaptive' }, max_tokens: 32000 });
  assert.equal(first.max_tokens, 1); assert.equal(first.thinking, undefined); assert.deepEqual(first.system, payload.system);
  assert.equal(send({ ...payload, max_tokens: 32000 }), undefined, 'segundo request não é reescrito (o processo já saiu)');
}

// ---- refresh de verdade (pi-ai anthropic) contra um servidor HTTP falso ----
// O falso aplica a regra documentada da Messages API para thinking com budget (budget_tokens
// ≥ 1024 e < max_tokens; senão 400) e acerta o cache quando o corpo, sem max_tokens, se repete.
// Não substitui a API real: prova que o keeper não manda o corpo que a regra rejeita.
{
  const { createServer } = await import('node:http');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const piAi = join(testPiRoot, 'node_modules/@earendil-works/pi-ai/dist');
  const { streamSimpleAnthropic } = await import(pathToFileURL(join(piAi, 'legacy-api-aliases.js')).href);
  const seen = []; const prefixes = new Set();
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      const body = JSON.parse(raw); seen.push(body);
      const t = body.thinking;
      if (t?.type === 'enabled' && !(t.budget_tokens >= 1024 && t.budget_tokens < body.max_tokens)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens must be greater than thinking.budget_tokens' } }));
      }
      const { max_tokens, stream, ...key } = body; const k = JSON.stringify(key);
      const hit = prefixes.has(k); prefixes.add(k);
      const usage = hit ? { input_tokens: 3, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 0 } : { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 8000, output_tokens: 0 };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '.' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } });
      ev('message_stop', {}); res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const model = { ...opus, id: 'claude-test', name: 'test', baseUrl: `http://127.0.0.1:${server.address().port}`, reasoning: true, input: ['text'], contextWindow: 1_000_000, maxTokens: 64_000 };
  process.env.AGENT_JUICE_HOME = join(isolated, 'unused-ledger'); delete process.env.AGENT_RUNTIME_ENABLED;
  process.env.AGENT_CACHE_KEEPER_TEST = '1';
  const errWrite = process.stderr.write.bind(process.stderr); const lines = [];
  async function scenario(real, tokens, final) {
    const h = {}; const api = { on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: () => {}, events: { emit() {} } };
    mod.default(api);
    const sent = [];
    const ctx = { sessionManager: {}, cwd: '/tmp/ck-test', hasUI: false, model, getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
      modelRegistry: { streamSimple: (m, c, o) => { sent.push(o); return streamSimpleAnthropic(m, c, { ...o, apiKey: 'test' }); } } };
    for (const f of h.before_provider_request) f({ payload: real }, ctx);
    if (final) globalThis[Symbol.for('agent.cache-keeper.finalPayload')](final);
    const before = seen.length;
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    try { for (const f of h.agent_settled) await f({}, ctx); } finally { process.stderr.write = errWrite; }
    return { bodies: seen.slice(before), opts: sent, last: lines.at(-1) };
  }
  const base = { model: 'claude-test', system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'oi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }], max_tokens: 32_000, stream: true };
  for (const [name, real] of [['plain', base], ['adaptive', { ...base, thinking: { type: 'adaptive' } }]]) {
    prefixes.add(JSON.stringify((({ max_tokens, stream, ...k }) => k)(real))); // o turno real já escreveu o cache
    const r = await scenario(real, 8000);
    assert.equal(r.bodies.length, 1, name); assert.equal(r.bodies[0].max_tokens, 1, name);
    assert.deepEqual({ ...r.bodies[0], max_tokens: 0 }, { ...real, max_tokens: 0 }, `${name}: corpo idêntico salvo max_tokens`);
    assert.match(r.last, /hit/, name);
    assert.equal(r.opts[0][policy.CALL_KIND], 'cache-warm', `${name}: ping marcado para não substituir o payload real`);
  }
  // Extensão depois do keeper muda o corpo (ex.: tool-lexicon): o ping reenvia o corpo FINAL.
  {
    const lexed = { ...base, tools: [{ name: 'read', description: 'léxico do Vault' }] };
    prefixes.add(JSON.stringify((({ max_tokens, stream, ...k }) => k)(lexed)));
    const r = await scenario(base, 8000, lexed);
    assert.deepEqual(r.bodies[0].tools, lexed.tools, 'ping usa o corpo final'); assert.match(r.last, /hit/);
  }
  // Lane de message threads (chave de API, Pi ≥ 1.5.2): o payload completo leva o beta de threads;
  // o keeper não aquece (o ping não provaria o mesmo prefixo da continuação) e diz por quê.
  {
    const threaded = { ...base, betas: ['message-threads-2026-08-12'] };
    prefixes.add(JSON.stringify((({ max_tokens, stream, ...k }) => k)(threaded)));
    const r = await scenario(threaded, 8000);
    assert.equal(r.bodies.length, 0, 'threads: nenhum ping'); assert.equal(r.opts.length, 0, 'threads: nenhum streamSimple');
    assert.match(r.last, /miss \(0 ping\) skip=message-threads/, 'threads: motivo observável');
    // Host normal (sem modo teste): nenhum timer de ping; a barra diz por quê.
    delete process.env.AGENT_CACHE_KEEPER_TEST;
    const h = {}; mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand() {}, events: { emit() {} } });
    const statuses = []; const calls = [];
    const ctx = { sessionManager: {}, cwd: '/tmp/ck-threads', hasUI: true, model, ui: { setStatus: (_k, t) => statuses.push(t), notify() {} },
      getContextUsage: () => ({ tokens: 8000, contextWindow: 1_000_000 }), modelRegistry: { streamSimple: (...a) => { calls.push(a); throw new Error('não deveria pingar'); } } };
    h.session_start.forEach(f => f({}, ctx));
    h.before_provider_request.forEach(f => f({ payload: threaded }, ctx));
    for (const f of h.agent_settled) await f({}, ctx);
    assert.match(statuses.at(-1), /❄ \(message-threads\)/, `status: ${statuses.at(-1)}`);
    assert.equal(policy.sessionCachePolicy(ctx).cacheState().warm, true, 'request real ainda conta como cache quente');
    h.session_shutdown.forEach(f => f({}, ctx));
    assert.equal(calls.length, 0);
    process.env.AGENT_CACHE_KEEPER_TEST = '1';
  }
  const budget = { ...base, thinking: { type: 'enabled', budget_tokens: 2048 } };
  // Contexto pequeno: o pior caso (2049 tokens de saída) não compensa → nenhum request.
  const small = await scenario(budget, 8000);
  assert.equal(small.bodies.length, 0, 'budget + contexto pequeno: pula'); assert.match(small.last, /miss/);
  // Contexto grande: replay com max_tokens = budget+1 (aceito pela regra), thinking intacto, hit.
  prefixes.add(JSON.stringify((({ max_tokens, stream, ...k }) => k)(budget)));
  const large = await scenario(budget, 600_000);
  assert.equal(large.bodies.length, 1); assert.equal(large.bodies[0].max_tokens, 2049);
  assert.deepEqual(large.bodies[0].thinking, budget.thinking); assert.match(large.last, /hit/);
  // Payload preso ao modelo: Anthropic → troca para OpenAI (+ turno OpenAI) → nenhum ping com o
  // corpo Anthropic velho; idem troca para outro id Anthropic (alias) e ctx.model mutado sem evento.
  {
    const oai = { api: 'openai-responses', provider: 'openai', id: 'gpt-x', cost: { input: 1, output: 1 } };
    const sibling = { ...model, id: 'claude-test-2' };
    const cases = [
      ['anthropic→openai com turno', (h, ctx) => { h.model_select.forEach(f => f({ source: 'set', previousModel: model, model: oai }, ctx)); ctx.model = oai; h.before_provider_request.forEach(f => f({ payload: { model: 'gpt-x', input: [{ role: 'user', content: 'x' }] } }, ctx)); }],
      ['alias para outro id', (h, ctx) => { h.model_select.forEach(f => f({ source: 'cycle', previousModel: model, model: sibling }, ctx)); ctx.model = sibling; }],
      ['ctx.model mutado sem model_select', (_h, ctx) => { ctx.model = sibling; }],
      ['turno OpenAI sem model_select', (h, ctx) => { ctx.model = oai; h.before_provider_request.forEach(f => f({ payload: { model: 'gpt-x', input: [] } }, ctx)); ctx.model = model; }],
    ];
    for (const [name, act] of cases) {
      const h = {}; mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: () => {}, events: { emit() {} } });
      const sent = [];
      const ctx = { sessionManager: {}, cwd: '/tmp/ck-test', hasUI: false, model, getContextUsage: () => ({ tokens: 8000, contextWindow: 1_000_000 }),
        modelRegistry: { streamSimple: (m, c, o) => { sent.push(m); return streamSimpleAnthropic(m, c, { ...o, apiKey: 'test' }); } } };
      h.before_provider_request.forEach(f => f({ payload: base }, ctx));
      act(h, ctx);
      const before = seen.length;
      process.stderr.write = (x) => { lines.push(String(x)); return true; };
      try { for (const f of h.agent_settled) await f({}, ctx); } finally { process.stderr.write = errWrite; }
      assert.equal(sent.length, 0, `${name}: nenhum ping`); assert.equal(seen.length, before, `${name}: nada chegou ao servidor`);
    }
    // Controle: mesmo modelo continua aquecendo.
    const ok = await scenario(base, 8000); assert.equal(ok.bodies.length, 1);
  }
  // Regressão do bug: o corpo antigo (max_tokens 1 com budget) é rejeitado pela mesma regra.
  const old = await fetch(model.baseUrl + '/v1/messages', { method: 'POST', body: JSON.stringify({ ...budget, max_tokens: 1 }) });
  assert.equal(old.status, 400);
  server.close();
  // cch (identidade Claude Code): o hash exclui model e max_tokens → ping e turno real têm o mesmo cch.
  const { patchClaudeCodeCch } = await import(pathToFileURL(join(piAi, 'api/anthropic-claude-code.js')).href);
  const cc = { ...budget, system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=sdk-cli; cch=00000;' }, ...budget.system] };
  const cchOf = (b) => JSON.parse(patchClaudeCodeCch(JSON.stringify(b))).system[0].text.match(/cch=([0-9a-f]{5})/)[1];
  assert.equal(cchOf({ ...cc, max_tokens: 2049 }), cchOf(cc), 'cch preservado no ping');
  delete process.env.AGENT_CACHE_KEEPER_TEST;
}

// ---- runtime nativo + hooks: zero ledger I/O ----
{
  const { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const runtime = await import(pathToFileURL(join(repo, 'agent/core/runtime.mjs')).href);
  const client = await import(pathToFileURL(join(repo, 'agent/core/client.mjs')).href);
  const home = mkdtempSync(join(isolated, 'ck-ledger-'));
  Object.assign(process.env, { AGENT_RUNTIME_ENABLED: '1', AGENT_JUICE_HOME: home, AGENT_JUICE_STATE: join(home, 'run.json') });
  const broker = join(home, 'run.json'), legacyPrefs = join(home, 'preferences.json');
  writeFileSync(broker, JSON.stringify({ version: 2, runId: 'broker', mode: 'simple', calls: { used: 1 }, output: { used: 0, reserved: 100 }, usd: 0, pending: [{ callId: 'legacy-reservation', model: 'legacy/model', kind: 'stream', reservedOutputTokens: 100, status: 'reserved' }], receipts: [], cache: { gaps: [], breaks: {}, warmSkips: {} } }));
  writeFileSync(legacyPrefs, JSON.stringify({ mode: 'complex', supportModel: 'legacy/model' }));
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = [hash(broker), hash(legacyPrefs)];
  // Observe even swallowed ledger reads/writes, not only the final bytes.
  const io = [];
  const restoreIO = [];
  for (const target of [fs, fs.promises]) {
    for (const name of ['readFile', 'writeFile', 'appendFile', 'open', 'stat', 'access', 'rename', 'unlink', 'mkdir',
      'readFileSync', 'writeFileSync', 'appendFileSync', 'openSync', 'statSync', 'existsSync', 'renameSync', 'unlinkSync', 'mkdirSync']) {
      if (typeof target[name] !== 'function') continue;
      const original = target[name];
      target[name] = function (...args) {
        if (args.slice(0, 2).some(p => typeof p === 'string' && p.startsWith(home + '/') && /(?:run|preferences)(?:\.v3)?\.json/.test(p))) io.push([name, args[0]]);
        return original.apply(this, args);
      };
      restoreIO.push(() => { target[name] = original; });
    }
  }
  syncBuiltinESMExports();
  try {
  assert.deepEqual(client.getAgentPreferences(), { supportModel: null }, 'preferências antigas não são importadas');
  // Ping marcado: símbolo interno não é um campo JSON do provider.
  class FakeRuntime { async prepareRequest(model, options) { return { model, options, provider: { streamSimple: (_m, _c, o) => {
    assert.equal(JSON.stringify(o).includes('cache-warm'), false);
    const message = { role: 'assistant', stopReason: 'length', usage: { input: 3, output: 1, cacheRead: 8000, cacheWrite: 0, totalTokens: 8004, cost: { total: 0.004 } } };
    return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: 'done', message }; } };
  } } }; } }
  runtime.installAgentRuntime(FakeRuntime);
  const rt = new FakeRuntime();
  // Runtime entrega ao keeper o corpo final da cadeia onPayload (não nos pings).
  {
    const got = []; const key = Symbol.for('agent.cache-keeper.finalPayload'); const saved = globalThis[key];
    globalThis[key] = (p) => got.push(p);
    class Rt2 { async prepareRequest(model, options) { return { model, options, provider: { streamSimple: (_m, _c, o) => {
      const message = { role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } };
      const done = Promise.resolve(o.onPayload?.({ step: 0 })).then(() => message);
      return { result: () => done, async *[Symbol.asyncIterator]() { yield { type: 'done', message: await done }; } };
    } } }; } }
    runtime.installAgentRuntime(Rt2);
    const p2 = await new Rt2().prepareRequest({ provider: 'anthropic', id: 'x', maxTokens: 5 }, { onPayload: async (p) => ({ ...p, step: 1 }) });
    await p2.provider.streamSimple(p2.model, {}, p2.options).result();
    assert.deepEqual(got, [{ step: 1 }], 'corpo final entregue');
    const p3 = await new Rt2().prepareRequest({ provider: 'anthropic', id: 'x', maxTokens: 5 }, { onPayload: async (p) => ({ ...p, step: 2 }), [policy.CALL_KIND]: 'cache-warm' });
    await p3.provider.streamSimple(p3.model, {}, p3.options).result();
    assert.equal(got.length, 1, 'ping não sobrescreve');
    globalThis[key] = saved;
  }
  // Both provider entrypoints return the native stream, usage, error and abort signal.
  for (const method of ['stream', 'streamSimple']) {
    const controller = new AbortController();
    const failure = new Error('native provider failure');
    const message = { stopReason: 'length', usage: { output: 99999, cost: { total: 42 } } };
    const event = { type: 'done', message };
    const native = { result: async () => { if (controller.signal.aborted) throw controller.signal.reason; return message; },
      async *[Symbol.asyncIterator]() { yield event; } };
    let received;
    class NativeRuntime { async prepareRequest(model, options) { return { model, options, provider: {
      [method]: (_m, _c, o) => { received = o; if (o.fail) throw failure; return native; },
    } }; } }
    assert.equal(runtime.installAgentRuntime(NativeRuntime), true);
    assert.equal(runtime.installAgentRuntime(NativeRuntime), true, 'instalação idempotente');
    const options = { signal: controller.signal, maxTokens: 32000 };
    const p = await new NativeRuntime().prepareRequest(opus, options);
    const actual = p.provider[method](p.model, {}, p.options);
    assert.equal(actual, native);
    assert.equal(received, options, 'sem teto ou reserva de output');
    assert.equal(await actual.result(), message);
    assert.deepEqual(await Array.fromAsync(actual), [event]);
    assert.throws(() => p.provider[method](p.model, {}, { fail: true }), e => e === failure);
    controller.abort(failure);
    await assert.rejects(actual.result(), e => e === failure);
  }
  const prepared = await rt.prepareRequest({ provider: 'anthropic', id: 'claude-test', maxTokens: 10 }, { maxTokens: 1, [policy.CALL_KIND]: 'cache-warm' });
  await prepared.provider.streamSimple(prepared.model, {}, prepared.options).result();
  // Hooks mantêm os diagnósticos locais sem escrever accounting.
  const h = {}; const cmds = {};
  mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: (n, c) => { cmds[n] = c; }, events: { emit() {} } });
  const notes = []; const statuses = [];
  const ctx = { sessionManager: {}, cwd: home, hasUI: true, model: opus, ui: { notify: (t) => notes.push(t), setStatus: (_key, text) => statuses.push(text) }, getContextUsage: () => ({ tokens: 460_000, contextWindow: 1_000_000 }) };
  for (const f of h.session_start) f({}, ctx);
  for (const f of h.before_provider_request) f({ payload }, ctx);
  for (const f of h.session_before_compact) f({ reason: 'threshold' }, ctx);
  for (const f of h.before_provider_request) f({ payload: { ...payload, tools: [{ name: 'novo' }] } }, ctx);
  for (const f of h.message_end) f({ message: { role: 'assistant', usage: { input: 9000, cacheRead: 0, cacheWrite: 0 } } });
  assert.match(statuses.at(-1), /✂ tools/);
  assert.deepEqual(readdirSync(home).sort(), ['preferences.json', 'run.json'], 'nenhum ledger criado');
  await cmds.cache.handler('', ctx);
  assert.match(notes.at(-1), /pings nesta sessão: 0/);
  // OpenAI status survives non-Anthropic requests and clears at the next session.
  ctx.model = codex;
  for (const f of h.before_provider_request) f({ payload: { ...resp, input: history.messages } }, ctx);
  for (const f of h.before_provider_request) f({ payload: { ...resp, input: history.messages.map((m, i) => i === 1 ? { ...m, content: 'edit' } : m) } }, ctx);
  for (const f of h.message_end) f({ message: { role: 'assistant', usage: { input: 9000, cacheRead: 0 } } });
  assert.equal(statuses.at(-1), '✂ msg#1');
  for (const f of h.agent_start) f({}, ctx);
  assert.equal(statuses.at(-1), '✂ msg#1');
  await cmds.cache.handler('', ctx);
  assert.match(notes.at(-1), /✂ msg#1/);
  for (const f of h.session_start) f({}, ctx);
  assert.equal(statuses.at(-1), undefined);
  assert.deepEqual(readdirSync(home).sort(), ['preferences.json', 'run.json']);
  assert.deepEqual(io, [], 'zero ledger/preferências legadas I/O, incluindo leituras');
  } finally {
    restoreIO.forEach(restore => restore());
    syncBuiltinESMExports();
  }
  assert.deepEqual([hash(broker), hash(legacyPrefs)], before, 'nenhum arquivo legado alterado');
  rmSync(home, { recursive: true, force: true });
  for (const k of ['AGENT_RUNTIME_ENABLED', 'AGENT_JUICE_BIN', 'AGENT_JUICE_STATE']) delete process.env[k];
}

// Pausas persistem no perfil Agent, com censura e limite real de 400 amostras.
{
  const h = {};
  mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand() {} });
  const ctx = { sessionManager: {}, cwd: join(isolated, 'pause-project'), model: opus,
    getContextUsage: () => ({ tokens: 8000, contextWindow: 1000000 }) };
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    h.session_start.forEach(f => f({}, ctx));
    h.before_provider_request.forEach(f => f({ payload }, ctx));
    for (let i = 0; i < 401; i++) {
      for (const f of h.agent_settled) await f({}, ctx);
      now += 2000;
      h.agent_start.forEach(f => f({}, ctx));
    }
    for (const f of h.agent_settled) await f({}, ctx);
    now += 3000;
    h.session_shutdown.forEach(f => f({}, ctx));
    const dir = join(process.env.PI_CODING_AGENT_DIR, 'cache-keeper');
    const saved = listDir(dir).map(name => JSON.parse(fs.readFileSync(join(dir, name), 'utf8'))).find(x => x.cwd === ctx.cwd);
    assert.equal(saved.gaps.length, 400);
    assert.deepEqual(saved.gaps.at(-1), { s: 3, c: 1, k: 8000 });
    assert.ok(saved.gaps.slice(0, -1).every(x => x.s === 2 && x.k === 8000 && x.c === undefined));
  } finally {
    Date.now = clock;
    h.session_shutdown.forEach(f => f({}, ctx));
  }
}

// Refresh em voo de um ciclo encerrado não pode aquecer nem contabilizar no novo ciclo.
{
  const saved = process.env.AGENT_CACHE_KEEPER_TEST;
  process.env.AGENT_CACHE_KEEPER_TEST = '1';
  const h = {}; const commands = {};
  mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: (n, c) => { commands[n] = c; } });
  let finish; let signal;
  const notes = [];
  const ctx = {
    sessionManager: {}, cwd: '/tmp/ck-cycle', hasUI: false, model: opus,
    ui: { notify: t => notes.push(t) },
    getContextUsage: () => ({ tokens: 460000, contextWindow: 1000000 }),
    modelRegistry: { streamSimple: (_m, _c, opts) => {
      signal = opts.signal;
      return { result: () => new Promise(resolve => { finish = resolve; }) };
    } },
  };
  for (const f of h.session_start) f({}, ctx);
  for (const f of h.before_provider_request) f({ payload }, ctx);
  const pending = h.agent_settled[0]({}, ctx);
  assert.ok(finish, 'refresh começou');
  for (const f of h.session_shutdown) f({}, ctx);
  assert.equal(signal.aborted, true, 'shutdown cancela refresh antigo');
  for (const f of h.session_start) f({}, ctx);
  finish({ usage: { cacheRead: 460000, input: 0, cost: { total: 1 } } });
  await pending;
  assert.equal(policy.sessionCachePolicy(ctx).cacheState().warm, undefined);
  await commands.cache.handler('', ctx);
  assert.match(notes.at(-1), /pings nesta sessão: 0/);
  for (const f of h.session_shutdown) f({}, ctx);
  if (saved === undefined) delete process.env.AGENT_CACHE_KEEPER_TEST; else process.env.AGENT_CACHE_KEEPER_TEST = saved;
}

// Um ping consome orçamento mesmo se o provider não informar custo; o próximo não é agendado.
{
  const saved = { AGENT_CACHE_KEEPER_TEST: process.env.AGENT_CACHE_KEEPER_TEST, AGENT_CACHE_KEEPER_MAX_SESSION_USD: process.env.AGENT_CACHE_KEEPER_MAX_SESSION_USD };
  process.env.AGENT_CACHE_KEEPER_MAX_SESSION_USD = '0.25';
  const h = {}; const commands = {}; const statuses = []; const notes = [];
  mod.default({ on: (n, f) => { (h[n] ??= []).push(f); }, registerCommand: (n, c) => { commands[n] = c; } });
  let id = 'first'; let pings = 0;
  const ctx = {
    sessionManager: { getSessionId: () => id }, cwd: isolated, hasUI: true, model: opus,
    ui: { setStatus: (_k, t) => statuses.push(t), notify: t => notes.push(t) },
    getContextUsage: () => ({ tokens: 460_000 }),
    modelRegistry: { streamSimple: () => {
      pings++;
      return { result: async () => ({ usage: { cacheRead: 460_000 } }) };
    } },
  };
  const capture = () => { for (const f of h.before_provider_request) f({ payload }, ctx); };
  try {
    for (const f of h.session_start) f({}, ctx);
    capture();
    process.env.AGENT_CACHE_KEEPER_TEST = '1';
    await h.agent_settled[0]({}, ctx);
    delete process.env.AGENT_CACHE_KEEPER_TEST;
    await h.agent_settled[0]({}, ctx);
    assert.match(statuses.at(-1), /teto da sessão/);
    await commands.cache.handler('', ctx);
    assert.match(notes.at(-1), /US\$0\.2300 estimados \/ US\$0\.25 \(teto da sessão\)/);

    process.env.AGENT_CACHE_KEEPER_TEST = '1';
    await h.agent_settled[0]({}, ctx);
    assert.equal(pings, 1);
    id = 'second';
    capture();
    await h.agent_settled[0]({}, ctx);
    assert.equal(pings, 2);
  } finally {
    for (const f of h.session_shutdown) f({}, ctx);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// I — compactação ociosa (pura): mínimo, instante e decisão no disparo.
assert.equal(policy.idleCompactMinTokens(undefined), 200_000);
assert.equal(policy.idleCompactMinTokens('150k'), 150_000);
assert.equal(policy.idleCompactMinTokens('1M'), 1_000_000);
assert.equal(policy.idleCompactMinTokens('50000'), 100_000, 'piso de 100K');
assert.equal(policy.idleCompactMinTokens('lixo'), 200_000);
assert.equal(policy.idleCompactionAt({ coldAt: 10_000, idleSince: 0 }), 3_240_000, 'nunca antes de 54 min parado');
assert.equal(policy.idleCompactionAt({ coldAt: 9_000_000, idleSince: 0 }), 9_000_000, 'fim da janela de aquecimento');
const idleOk = { tokens: 250_000, minTokens: 200_000, idle: true };
assert.equal(policy.idleCompactionDecision(idleOk).action, 'compact');
assert.equal(policy.idleCompactionDecision({ ...idleOk, enabled: false }).reason, 'disabled');
assert.equal(policy.idleCompactionDecision({ ...idleOk, idle: false }).reason, 'busy');
assert.equal(policy.idleCompactionDecision({ ...idleOk, pending: true }).reason, 'busy');
assert.equal(policy.idleCompactionDecision({ ...idleOk, editorText: 'oi' }).reason, 'typing');
assert.equal(policy.idleCompactionDecision({ ...idleOk, tokens: 120_000 }).reason, 'small');

assert.ok(listDir(process.env.PI_CODING_AGENT_DIR).every(name => name === 'cache-keeper'), 'somente estado de pausas no perfil');
console.log('PASS cache-keeper');
