#!/usr/bin/env node
// Cache do Agent no caminho real, sem rede: `pi -p` de verdade, provider anthropic-messages
// do pi-ai apontado para um servidor HTTP falso em loopback, runtime Juice (preload) + broker
// Rust + cache-keeper.ts. Prova, no mesmo processo do Pi:
//  - corpo FINAL: uma extensão carregada depois do keeper muda as tools; o ping reenvia o corpo
//    que de fato saiu (e acerta o cache do servidor falso);
//  - J: ping entra no ledger com kind cache-warm;
//  - D: compactação por limiar com o cache quente é cancelada e registrada (compaction:deferred:warm);
//  - F: troca de modelo emite `agent:cache-estimate` com custo de reconstrução.
// O servidor falso acerta o cache quando o corpo (sem max_tokens/stream) se repete. Não prova a API real.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { juiceOperation, getJuiceReport } from '../agent/juice/client.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.AGENT_JUICE_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
const host = 'classic';
const cli = join(piRoot, 'dist/cli.js');
assert.ok(existsSync(cli), 'pi instalado');

const bodies = []; const seen = new Set();
const server = createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = JSON.parse(raw); bodies.push(body);
    if (Array.isArray(body.input)) { // OpenAI Responses (H)
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      const item = { type: 'message', id: 'msg_o', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
      sse({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } });
      sse({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      sse({ type: 'response.content_part.added', output_index: 0, item_id: 'msg_o', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      sse({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_o', content_index: 0, delta: 'ok' });
      sse({ type: 'response.output_text.done', output_index: 0, item_id: 'msg_o', content_index: 0, text: 'ok' });
      sse({ type: 'response.content_part.done', output_index: 0, item_id: 'msg_o', content_index: 0, part: item.content[0] });
      sse({ type: 'response.output_item.done', output_index: 0, item });
      sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 50, output_tokens: 1, total_tokens: 51, input_tokens_details: { cached_tokens: 0 } } } });
      return res.end();
    }
    const { max_tokens, stream, ...k } = body; const key = JSON.stringify(k);
    const hit = seen.has(key); seen.add(key);
    // Contexto grande (460k de 1M) para o Pi cruzar o limiar de compactação (reserve 550k).
    const usage = hit ? { input_tokens: 10, cache_read_input_tokens: 460_000, cache_creation_input_tokens: 0, output_tokens: 0 }
      : { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 460_000, output_tokens: 0 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_' + bodies.length, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } });
    // 1º turno real pede uma tool: duas mensagens de assistant → há o que compactar.
    const tool = body.max_tokens !== 1 && !body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
    if (tool) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'x.txt' }) } });
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
    }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: body.max_tokens === 1 ? 'max_tokens' : tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
    ev('message_stop', {}); res.end();
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const root = mkdtempSync(join(tmpdir(), 'cache-e2e-'));
const home = join(root, 'home'); const agent = join(home, '.pi/agent'); const juiceHome = join(root, 'juice');
mkdirSync(agent, { recursive: true }); mkdirSync(juiceHome, { recursive: true });
writeFileSync(join(root, 'x.txt'), 'conteúdo\n'.repeat(200));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: true, reserveTokens: 550_000, keepRecentTokens: 10 }, retry: { enabled: false }, cacheWarming: 'off' }));
const ledger = join(juiceHome, 'run.v3.json');
Object.assign(process.env, { AGENT_JUICE_ENABLED: '1', AGENT_JUICE_HOME: root, AGENT_JUICE_STATE: ledger }); juiceOperation({ op: 'init', runId: 'e2e', mode: 'simple' });

const model = (id) => ({ id, name: id, reasoning: false, input: ['text'], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 1_000_000, maxTokens: 32_000 });
const events = join(root, 'events.jsonl');
// Providers falsos via models.json no host clássico.
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: {
  'fake-anth': { api: 'anthropic-messages', apiKey: 'offline', baseUrl: `http://127.0.0.1:${port}`, models: [model('claude-a'), model('claude-b')] },
  'fake-oai': { api: 'openai-responses', apiKey: 'offline', baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ ...model('gpt-x'), cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } }] },
} }));
// "Léxico" que muda as tools DEPOIS do keeper
// + troca de modelo no fim do turno para exercitar F.
const ext = join(root, 'e2e-ext.ts');
writeFileSync(ext, `
import { appendFileSync } from "node:fs";
import { sessionCachePolicy } from ${JSON.stringify(join(repo, 'agent/juice/cache-policy.mjs'))};
export default function (pi: any) {
  pi.on("before_provider_request", (e: any) => Array.isArray(e.payload?.tools) && e.payload.tools.length ? { ...e.payload, tools: e.payload.tools.map((t: any) => ({ ...t, description: (t.description ?? "") + " [léxico]" })) } : undefined);
  pi.events.on("agent:cache-estimate", (d: any) => appendFileSync(${JSON.stringify(events)}, JSON.stringify(d) + "\\n"));
  let switched = false;
  // Depois do ping (o keeper roda antes no agent_settled): a troca esquece o payload, sem 2º ping.
  pi.on("agent_settled", async (_e: any, ctx: any) => { if (switched) return; switched = true;
    const policy = sessionCachePolicy(ctx);
    if (!policy || policy.cacheState().warm !== true) throw new Error("conexão por sessão não encontrada no Pi real");
    const other = { sessionManager: {} };
    if (sessionCachePolicy(other)) throw new Error("cache vazou entre sessões");
    if (!policy.deferCompaction({ reason: "threshold" }, ctx)) throw new Error("limiar quente devia adiar");
    if (policy.deferCompaction({ reason: "manual" }, ctx) || policy.deferCompaction({ reason: "overflow" }, ctx)) throw new Error("manual/overflow bloqueado");
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({ kind: "session-policy", isolated: true }) + "\\n");
    const b = ctx.modelRegistry.find("fake-anth", "claude-b"); if (b) await pi.setModel(b); });
}
`);
const env = {
  ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
  PI_DURABLE_HOST: '0',
  PI_CACHE_RETENTION: 'long', AGENT_CACHE_KEEPER_TEST: '1',
  AGENT_JUICE_ENABLED: '1', AGENT_JUICE_HOME: juiceHome, AGENT_JUICE_STATE: ledger, AGENT_JUICE_PI_ROOT: piRoot,
  NODE_OPTIONS: `--import=${pathToFileURL(join(repo, 'agent/juice/runtime.mjs')).href}`,
};
delete env.AGENT_JUICE_CHILD; delete env.AGENT_CACHE_KEEPER;
delete env.AGENT_JUICE_PI_ENTRY;
const runPi = (prompt, extra = {}, m = 'fake-anth/claude-a') => new Promise((done) => {
  const child = spawn(process.execPath, [cli, '-p', '--no-session', '--no-extensions', '-e', join(repo, 'agent/extensions/brain-live/cache-keeper.ts'), '-e', ext, '--model', m, '--tools', 'read', prompt], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', d => text += d); child.stderr.on('data', d => text += d);
  const kill = setTimeout(() => child.kill('SIGKILL'), 90_000);
  child.on('close', (code) => { clearTimeout(kill); done({ code, text }); });
});
const out = await runPi('oi');
const fail = (msg) => { console.error(`exit ${out.code}\n` + out.text.slice(-3000)); assert.fail(msg); };

const real = bodies.filter(b => b.max_tokens !== 1);
const pings = bodies.filter(b => b.max_tokens === 1);
if (!real.length) fail('nenhum request real chegou ao servidor falso');
if (pings.length !== 1) fail(`esperado 1 ping, veio ${pings.length}`);
const lastReal = real.at(-1);
assert.ok(lastReal.tools?.[0]?.description?.endsWith('[léxico]'), 'o request real saiu com o léxico');
assert.deepEqual({ ...pings[0], max_tokens: 0 }, { ...lastReal, max_tokens: 0 }, 'ping = corpo final enviado, salvo max_tokens');
assert.match(out.text, /cache-keeper test: hit/, 'ping acertou o cache');
console.log('ok corpo final: o ping reenvia o que saiu (com léxico) e acerta');

const report = getJuiceReport();
assert.equal(report.warm.pings, 1, 'ping no ledger como cache-warm');
assert.equal(report.warm.cacheRead, 460_000);
assert.ok(report.byKind.streamSimple?.calls >= 1 || report.byKind.stream?.calls >= 1, 'turno real no ledger');
console.log('ok J: ledger separa o ping (kind cache-warm) do turno real');

assert.ok((report.cache.decisions['compaction:deferred:warm'] ?? 0) >= 1, `compactação adiada registrada: ${JSON.stringify(report.cache.decisions)}`);
assert.ok(!bodies.some(b => JSON.stringify(b).includes('summar')), 'nenhum request de resumo saiu');
console.log('ok D: limiar com cache quente → compactação adiada, sem request de resumo');

const observed = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
assert.ok(observed.some(e => e.kind === 'session-policy' && e.isolated), 'Pi real usa conexão explícita, sem vazamento entre managers');
const est = observed.filter(e => e.kind === 'model-switch');
if (!est.length) fail('troca de modelo não emitiu agent:cache-estimate');
assert.equal(est[0].from, 'fake-anth/claude-a'); assert.equal(est[0].to, 'fake-anth/claude-b');
assert.ok(est[0].tokens >= 460_000 && est[0].rebuildUsd > 0, JSON.stringify(est[0]));
console.log('ok F: troca de modelo no Pi real emite a estimativa de reconstrução');

// E — filho de prefetch no Pi real: 1 request (max_tokens 1, sem thinking, tools+system iguais
// aos do filho normal), sai com 0 antes de o Pi tratar o `length` como recuperável.
{
  const before = bodies.length;
  const pre = await runPi('.', { AGENT_JUICE_CHILD: '1', AGENT_CACHE_PREFETCH: '1', AGENT_CACHE_KEEPER_TEST: '0' });
  const sent = bodies.slice(before);
  if (pre.code !== 0 || sent.length !== 1) { console.error(pre.text.slice(-2000)); assert.fail(`prefetch: exit ${pre.code}, ${sent.length} requests`); }
  assert.equal(sent[0].max_tokens, 1); assert.equal(sent[0].thinking, undefined);
  assert.deepEqual(sent[0].tools, real[0].tools, 'tools idênticas às do filho normal');
  assert.deepEqual(sent[0].system, real[0].system, 'system idêntico ao do filho normal');
  const r2 = getJuiceReport();
  assert.equal(r2.byKind['cache-prefetch']?.calls, 1, 'prefetch no ledger como cache-prefetch');
  const rec = JSON.parse(readFileSync(ledger, 'utf8')).receipts.find(e => e.kind === 'cache-prefetch');
  assert.equal(rec.reservedOutputTokens, 1, 'prefetch reserva 1 token, não o teto do modelo');
  console.log('ok E: filho de prefetch no Pi real: 1 request de aquecimento, prefixo idêntico, exit 0');
}

// H — no Pi real, OpenAI Responses: a sessão principal mantém a chave do Pi (sessionId);
// subagentes do mesmo papel (mesmo model+instructions+tools) recebem a mesma chave do prefixo.
{
  const before = bodies.length;
  const main = await runPi('tarefa um', { AGENT_CACHE_KEEPER_TEST: '0' }, 'fake-oai/gpt-x');
  const kids = [await runPi('tarefa dois', { AGENT_JUICE_CHILD: '1', AGENT_CACHE_KEEPER_TEST: '0' }, 'fake-oai/gpt-x'),
    await runPi('tarefa três', { AGENT_JUICE_CHILD: '1', AGENT_CACHE_KEEPER_TEST: '0' }, 'fake-oai/gpt-x')];
  const sent = bodies.slice(before).filter(b => Array.isArray(b.input));
  if (sent.length !== 3) { console.error([main, ...kids].map(r => r.text.slice(-800)).join('\n---\n')); assert.fail(`H: ${sent.length} requests Responses`); }
  assert.ok(!String(sent[0].prompt_cache_key ?? '').startsWith('agent-'), `principal mantém a chave do Pi: ${sent[0].prompt_cache_key}`);
  assert.match(sent[1].prompt_cache_key, /^agent-[0-9a-f]{16}$/);
  assert.equal(sent[2].prompt_cache_key, sent[1].prompt_cache_key, 'filhos do mesmo papel: mesma chave');
  console.log('ok H: Responses no Pi real: principal com a chave do Pi, filhos com a chave do prefixo');
}
server.close();
console.log(`PASS cache-e2e (${host})`);
