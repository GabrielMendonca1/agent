#!/usr/bin/env node
// Cache E — prefetch do próximo papel, offline: `pi -p` real com a tool `subagent` real
// em chain (alpha → beta), contra um servidor Anthropic falso (SSE) que registra cada
// request. Sem rede, sem API real; nenhum "cache hit" é alegado — só a forma dos requests.
//   (a) o request de prefetch tem max_tokens 1 e nenhum `thinking`;
//   (b) `system` e `tools` do prefetch são byte-idênticos aos do 1º request do beta real;
//   (c) um único request no prefetch, e ele nasce durante a etapa alpha (após o 1º token);
//   (d) provider não Anthropic: o filho de prefetch sai 3 sem nenhum request;
//   (e) contabilidade: o ledger do Juice registra a chamada com kind `cache-prefetch`;
//   (f) sem opt-in (sem flag e sem TTL longo) não há prefetch.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { juiceOperation } from '../mark/juice/client.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.MARK_JUICE_PI_ROOT || join(homedir(), '.local/share/pi-overlay/current/lib/node_modules/@earendil-works/pi-coding-agent');
const cli = join(piRoot, 'dist/cli.js');
assert.ok(existsSync(cli), 'pi instalado');

const root = mkdtempSync(join(tmpdir(), 'mark-prefetch-'));
const home = join(root, 'home');
const agentDir = join(home, '.pi/agent');
mkdirSync(join(agentDir, 'agents'), { recursive: true });
writeFileSync(join(agentDir, 'agents/alpha.md'), '---\nname: alpha\ndescription: fixture\ntools: read\n---\nVocê é alpha.\n');
writeFileSync(join(agentDir, 'agents/scout.md'), '---\nname: scout\ndescription: fixture Codex (slot apoio)\ntools: read\n---\nVocê é gamma.\n');
writeFileSync(join(agentDir, 'agents/beta.md'), '---\nname: beta\ndescription: fixture\ntools: read, ls\n---\nVocê é beta, outro papel.\n');
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], enableSkillCommands: false, retry: { enabled: false }, quietStartup: true }));
writeFileSync(join(agentDir, 'auth.json'), '{}');

// ---- servidor Anthropic falso ----
const requests = [];
let failAlpha;
const sse = (res, events) => {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [t, d] of events) res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
};
const start = (usage = {}) => ['message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } } }];
const textBlock = (t) => [['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }], ['content_block_stop', { index: 0 }]];
const stop = (reason = 'end_turn') => [['message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 1 } }], ['message_stop', {}]];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    if (req.url.includes('/responses')) {
      requests.push({ role: 'resp', kind: 'real', t: Date.now(), body });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'offline', type: 'invalid_request_error' } }));
    }
    const sys = JSON.stringify(body.system ?? '');
    const role = body.tools?.some(t => t.name === 'subagent') ? 'parent' : sys.includes('Você é alpha') ? 'alpha' : sys.includes('Você é beta') ? 'beta' : '?';
    const kind = body.max_tokens === 1 ? 'prefetch' : 'real';
    const turn = (body.messages ?? []).filter(m => m.role === 'assistant').length;
    requests.push({ role, kind, turn, t: Date.now(), body });
    // Dispatch do Mark é assíncrono: o pai recebe um jobId e,
    // nos turnos seguintes, acompanha com action:"result" até o estado terminal do job.
    // Nada de sleep para "dar tempo": quem encerra a espera é o próprio status do job.
    if (role === 'parent' && turn > 0) {
      const convo = JSON.stringify(body.messages ?? []);
      const jobId = /Launched subagent job ([A-Za-z0-9_-]+)/.exec(convo)?.[1];
      const terminal = /job [A-Za-z0-9_-]+ \((completed|failed|cancelled|timeout|interrupted)\)/.test(convo);
      if (jobId && !terminal) {
        await new Promise(r => setTimeout(r, 120)); // só espaça o poll; o fim vem do job
        sse(res, [start(), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_p${turn}`, name: 'subagent', input: {} } }],
          ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ action: 'result', jobId }) } }],
          ['content_block_stop', { index: 0 }], ...stop('tool_use')]);
        return res.end();
      }
    }
    if (role === 'parent' && turn === 0 && process.env.PF_PARENT === 'gamma') {
      sse(res, [start(), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_g', name: 'subagent', input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ tasks: [{ agent: 'scout', task: 'um' }, { agent: 'scout', task: 'dois' }] }) } }],
        ['content_block_stop', { index: 0 }], ...stop('tool_use')]);
      return res.end();
    }
    if (role === 'parent' && turn === 0) {
      sse(res, [start(), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'subagent', input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ chain: [{ agent: 'alpha', task: 'etapa um' }, { agent: 'beta', task: 'etapa dois: {previous}' }] }) } }],
        ['content_block_stop', { index: 0 }], ...stop('tool_use')]);
      return res.end();
    }
    if (role === 'alpha' && kind === 'real' && process.env.PF_ALPHA_FAIL) {
      // 1º token (dispara o prefetch do beta) e depois erro do provider: a etapa falha.
      sse(res, [start(), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ALPHA' } }]]);
      failAlpha = () => {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'falha de teste' } })}\n\n`);
        res.end();
      };
      return;
    }
    if (kind === 'prefetch' && process.env.PF_SLOW_WARM) {
      // Aquecimento lento: só responderia depois de 8 s. O job falhado tem de matá-lo antes.
      const entry = requests.at(-1);
      req.socket.on('close', () => { entry.closedAt = Date.now(); });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      failAlpha(); // falha com o warm comprovadamente em voo, sem janela arbitrária de 600 ms
      await new Promise(r => setTimeout(r, 8000));
      if (!res.destroyed) { entry.answered = true; sse(res, [start({ cache_creation_input_tokens: 9 }), ...textBlock('x'), ...stop('max_tokens')]); res.end(); }
      return;
    }
    if (role === 'alpha' && kind === 'real') {
      // 1º token já, resto depois: a janela em que o prefetch do beta deve nascer.
      sse(res, [start(), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ALPHA' } }]]);
      await new Promise(r => setTimeout(r, 2500));
      sse(res, [['content_block_stop', { index: 0 }], ...stop()]);
      return res.end();
    }
    sse(res, [start(kind === 'prefetch' ? { cache_creation_input_tokens: 9 } : {}), ...textBlock(role === 'parent' ? 'PAI-OK' : `${role.toUpperCase()}-OK`), ...stop(kind === 'prefetch' ? 'max_tokens' : 'end_turn')]);
    res.end();
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const model = (id) => ({ id, name: id, reasoning: true, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 200000, maxTokens: 8000 });
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {
  fakeanth: { baseUrl: `http://127.0.0.1:${port}`, api: 'anthropic-messages', apiKey: 'offline', models: [model('claude-x')] },
  fakeresp: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-responses', apiKey: 'offline', models: [model('gpt-x')] },
  fakeoai: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'offline', models: [model('gpt-x')] },
} }));

const ledger = join(root, 'run.v3.json');
const baseEnv = {
  ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_DURABLE_HOST: '0',
  MARK_JUICE_ENABLED: '1', MARK_JUICE_STATE: ledger, MARK_JUICE_HOME: root, MARK_JUICE_PI_ROOT: piRoot,
  NODE_OPTIONS: `--import=${pathToFileURL(join(repo, 'mark/juice/runtime.mjs')).href}`,
};
// O processo desta fixture usa dist/cli.js (clássico), não o bundle do pai real.
for (const k of ['MARK_JUICE_PI_ENTRY', 'MARK_JUICE_CHILD', 'MARK_CACHE_PREFETCH', 'MARK_CACHE_PREFETCH_NEXT', 'PI_CACHE_RETENTION', 'MARK_SUBAGENT_CHILD_EXTENSIONS']) delete baseEnv[k];
const run = (cmd, args, env) => new Promise((done) => {
  const p = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 90_000);
  p.on('close', (code) => { clearTimeout(timer); done({ code, out, err }); });
});
const initLedger = () => {
  rmSync(ledger, { force: true });
  // Cada pai usa --no-session: o modo inicial vem das preferências, nunca do ledger.
  writeFileSync(join(root, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: null }));
  Object.assign(process.env, { MARK_JUICE_ENABLED: '1', MARK_JUICE_HOME: root, MARK_JUICE_STATE: ledger }); juiceOperation({ op: 'init', runId: 'pf', mode: 'simple' });
};
const runParent = (extra) => run(process.execPath, [cli, '-p', '--mode', 'json', '--no-session', '--no-extensions', '-e', join(repo, 'mark/extensions/brain-live/subagent/index.ts'), '--model', 'fakeanth/claude-x', '--thinking', 'high', 'tarefa'], { ...baseEnv, ...extra });

let n = 0;
const ok = (m) => { n++; console.log(`ok ${m}`); };

// ---- com opt-in ----
initLedger();
let r = await runParent({ MARK_CACHE_PREFETCH_NEXT: '1' });
assert.equal(r.code, 0, r.err.slice(-2000));
assert.match(r.out, /BETA-OK/, 'a chain chegou ao beta');
assert.match(r.out, /job [A-Za-z0-9_-]+ \(completed\)/, 'o job da chain terminou completed (chain inteira executada)');
const pre = requests.filter(q => q.kind === 'prefetch');
const betaReal = requests.find(q => q.role === 'beta' && q.kind === 'real');
const alphaReal = requests.find(q => q.role === 'alpha' && q.kind === 'real');
assert.equal(pre.length, 1, `um único request de prefetch: ${JSON.stringify(requests.map(q => [q.role, q.kind]))}`);
assert.equal(pre[0].role, 'beta', 'prefetch é do próximo papel');
assert.equal(pre[0].body.max_tokens, 1);
assert.equal(pre[0].body.thinking, undefined, 'sem thinking');
assert.ok(betaReal.body.thinking, 'o beta real tem thinking (o prefetch tirou)');
ok('(a) prefetch: max_tokens 1, sem thinking');
assert.equal(JSON.stringify(pre[0].body.system), JSON.stringify(betaReal.body.system), 'system byte-idêntico');
assert.equal(JSON.stringify(pre[0].body.tools), JSON.stringify(betaReal.body.tools), 'tools byte-idênticas');
assert.match(JSON.stringify(pre[0].body.system), /cache_control/, 'prefixo marcado para cache');
ok('(b) system e tools do prefetch = 1º request do beta real (byte a byte)');
assert.ok(pre[0].t > alphaReal.t && pre[0].t < betaReal.t, 'prefetch nasce durante a etapa alpha');
ok('(c) 1 request de prefetch, durante a etapa anterior e antes do beta real');
const state = readFileSync(ledger, 'utf8');
const receipts = JSON.parse(state).receipts.filter(x => x.kind === 'cache-prefetch');
assert.equal(receipts.length, 1, 'uma chamada cache-prefetch no ledger');
assert.equal(receipts[0].status, 'settled', 'liquidada (filho saiu limpo, sem retry/compactação)');
assert.equal(receipts[0].outputTokens, 1);
assert.equal(receipts[0].usage.cacheWrite, 9, 'usage do provider contabilizado');
assert.doesNotMatch(state, /Você é beta|x-api-key|offline/, 'ledger sem payload nem headers');
ok('(e) ledger: chamada contabilizada como cache-prefetch, sem payload');

// ---- (d) provider não Anthropic: o mesmo filho de prefetch sai 3 sem request ----
const before = requests.length;
const d = await run(process.execPath, [cli, '--mode', 'json', '-p', '--no-session', '--no-extensions', '-e', join(repo, 'mark/extensions/brain-live/cache-keeper.ts'), '--model', 'fakeoai/gpt-x', '--tools', 'read', 'Task: .'],
  { ...baseEnv, NODE_OPTIONS: '', MARK_JUICE_ENABLED: '0', MARK_JUICE_CHILD: '1', MARK_CACHE_PREFETCH: '1' });
assert.equal(d.code, 3, d.err.slice(-1000));
assert.equal(requests.length, before, 'nenhum request');
ok('(d) não Anthropic: exit 3, zero requests');

// ---- (f) sem opt-in: nada de prefetch ----
requests.length = 0;
initLedger();
r = await runParent({ PI_CACHE_RETENTION: 'long' });
assert.equal(r.code, 0, r.err.slice(-2000));
assert.match(r.out, /BETA-OK/);
assert.equal(requests.filter(q => q.kind === 'prefetch').length, 0, 'sem flag e sem TTL longo não aquece');
ok('(f) sem MARK_CACHE_PREFETCH_NEXT=1 não há prefetch (nem com TTL longo)');

// ---- (i) etapa falha com aquecimento em voo: o warm morre com o job, nada depois ----
requests.length = 0;
initLedger();
process.env.PF_ALPHA_FAIL = '1'; process.env.PF_SLOW_WARM = '1';
const t0 = Date.now();
r = await runParent({ MARK_CACHE_PREFETCH_NEXT: '1' });
const tEnd = Date.now();
delete process.env.PF_ALPHA_FAIL; delete process.env.PF_SLOW_WARM;
const warmReq = requests.find(q => q.kind === 'prefetch');
assert.ok(warmReq, `o prefetch chegou a sair: ${JSON.stringify(requests.map(q => [q.role, q.kind]))}`);
assert.ok(!requests.some(q => q.role === 'beta' && q.kind === 'real'), 'beta real não roda após falha');
assert.doesNotMatch(r.out, /BETA-OK/);
assert.ok(tEnd - t0 < 8000, `pai não esperou o warm lento terminar sozinho (${tEnd - t0} ms)`);
await new Promise(res => setTimeout(res, 300));
assert.ok(warmReq.closedAt && warmReq.closedAt <= tEnd, 'conexão do warm fechada antes do fim do pai (filho morto com o job)');
assert.ok(!warmReq.answered, 'warm nunca completou');
const after = requests.length;
await new Promise(res => setTimeout(res, 1500));
assert.equal(requests.length, after, 'nenhum request depois do estado terminal');
ok('(i) etapa falha: aquecimento em voo abortado e aguardado; nada nasce depois do job');

// ---- H nos filhos reais: o cache-keeper carrega no filho do piloto ----
// Codex/Responses: dois filhos reais do mesmo papel chegam com a mesma prompt_cache_key "mark-…".
requests.length = 0;
initLedger();
process.env.PF_PARENT = 'gamma';
// scout vai para o slot apoio = modelo de apoio no provider Responses falso.
writeFileSync(join(root, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: 'fakeresp/gpt-x' }));
r = await runParent({});
rmSync(join(root, 'preferences.v3.json'));
delete process.env.PF_PARENT;
// Só os filhos scout (o despachante do piloto também pode usar o modelo de apoio).
const resp = requests.filter(q => q.role === 'resp' && JSON.stringify(q.body).includes('Você é gamma'));
assert.equal(resp.length, 2, `dois filhos gamma no provider Responses: ${JSON.stringify(requests.map(q => q.role))}`);
assert.match(String(resp[0].body.prompt_cache_key), /^mark-/, `prompt_cache_key: ${resp[0].body.prompt_cache_key}`);
assert.equal(resp[0].body.prompt_cache_key, resp[1].body.prompt_cache_key, 'mesma chave para o mesmo prefixo');
ok('(g) filhos reais Codex: prompt_cache_key "mark-…" estável entre filhos do mesmo papel');
// Anthropic: o keeper em modo filho não muda o corpo (mesmo argv com e sem -e keeper).
requests.length = 0;
const childArgs = ['--mode', 'json', '-p', '--no-session', '--no-extensions', '--model', 'fakeanth/claude-x', '--thinking', 'high', '--tools', 'read', 'Task: igual'];
const childEnv = { ...baseEnv, NODE_OPTIONS: '', MARK_JUICE_ENABLED: '0', MARK_JUICE_CHILD: '1' };
await run(process.execPath, [cli, ...childArgs], childEnv);
await run(process.execPath, [cli, ...childArgs.slice(0, 5), '-e', join(repo, 'mark/extensions/brain-live/cache-keeper.ts'), ...childArgs.slice(5)], childEnv);
assert.equal(requests.length, 2);
assert.equal(JSON.stringify(requests[1].body), JSON.stringify(requests[0].body), 'corpo Anthropic idêntico com e sem keeper');
ok('(h) filho Anthropic: corpo byte-idêntico com o keeper carregado');

server.close();
rmSync(root, { recursive: true, force: true });
console.log(`${n} checks passed`);
