#!/usr/bin/env node
/**
 * skim, offline, in the real Pi (dist/cli.js) against loopback fakes:
 *  - main model and the Haiku fallback: scripts/lib/fake-anthropic.mjs;
 *  - openai/gpt-6-luna: a minimal OpenAI Responses SSE server below.
 * Proves: file answer with cited line + footer and usage on the tool result; fallback to the
 * next model; clear error without the source when every model fails; command through the
 * session's bash (tool_call hooks block it, seatbelt sandbox denies writes, full output reaches
 * the cheap model past Pi's 2000-line cut and the child output cap); the child-cap hint; the
 * bundled roles and the runner wiring; the main-session payload increase (≤ 1.2 KB).
 * Nothing leaves the machine. `node scripts/test-agent-skim.mjs`
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), '.local/share/agent');
const rel = 'lib/node_modules/@earendil-works/pi-coding-agent';
const piRoot = (() => {
  const explicit = process.env.AGENT_PI_ROOT || process.env.AGENT_JUICE_PI_ROOT;
  if (explicit) return realpathSync(explicit);
  const candidates = [join(store, 'current', rel), ...(existsSync(join(store, 'releases')) ? readdirSync(join(store, 'releases')).sort().reverse().map(n => join(store, 'releases', n, rel)) : [])];
  const found = candidates.find(p => existsSync(join(p, 'dist/cli.js')));
  assert.ok(found, 'Pi instalado necessário');
  return realpathSync(found);
})();
const SKIM = join(repo, 'agent/extensions/agent/skim/index.ts');
const CAP = join(repo, 'agent/extensions/brain-live/subagent/child-output-cap.ts');
const SANDBOX = join(repo, 'agent/extensions/brain-live/bash-sandbox.ts');
const MAIN = 'anthropic/claude-sonnet-4-5';
let checks = 0;
const ok = name => { checks++; console.log(`ok ${name}`); };

// Minimal OpenAI Responses API: POST /v1/responses, SSE. mode 'ok' answers, 'fail' returns 400.
async function startFakeOpenAI() {
  const state = { mode: 'ok', answer: 'answer', requests: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      state.requests.push({ url: req.url, payload: JSON.parse(body || 'null') });
      if (!req.url.endsWith('/responses')) { res.writeHead(404).end(); return; }
      if (state.mode === 'fail') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'fake openai refused', type: 'invalid_request_error' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: state.answer, annotations: [] }] };
      send({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: state.answer });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 100000, output_tokens: 20, total_tokens: 100020, input_tokens_details: { cached_tokens: 0 } } } });
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  state.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => new Promise(r => server.close(r));
  return state;
}

const root = mkdtempSync(join(tmpdir(), 'agent-skim-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'work');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const openai = await startFakeOpenAI();
const textOf = m => (Array.isArray(m?.content) ? m.content : []).map(p => p.text ?? '').join('');
const userText = payload => JSON.stringify(payload.messages ?? payload.input ?? []);

async function runPi({ script, extensions = [SKIM], env = {}, prompt = 'go' }) {
  const fake = await startFakeAnthropic(script);
  try {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {
      anthropic: { baseUrl: fake.baseUrl, apiKey: 'offline-anthropic' },
      openai: { baseUrl: openai.baseUrl, apiKey: 'offline-openai' },
    } }));
    const result = await new Promise(done => {
      const child = spawn(process.execPath, [join(piRoot, 'dist/cli.js'), '--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills',
        ...extensions.flatMap(e => ['-e', e]), '--model', MAIN, prompt], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: '', PI_OFFLINE: '1', PI_DURABLE_HOST: '0', ...env },
      });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', code => done({ code, out, err }));
    });
    assert.equal(result.code, 0, `pi saiu com ${result.code}\n${result.err.slice(0, 3000)}`);
    const events = result.out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const toolResults = events.filter(e => e.type === 'message_end' && e.message?.role === 'toolResult').map(e => e.message);
    return { payloads: fake.messages(), toolResults, err: result.err };
  } finally { await fake.close(); }
}

try {
  // Source: 3000 lines, the needle at line 2500 only.
  const file = join(cwd, 'big.log');
  writeFileSync(file, Array.from({ length: 3000 }, (_, i) => i === 2499 ? 'NEEDLE-2500 disk full' : `filler line ${i + 1}`).join('\n'));

  // 1) primary model answers about a file; usage on the tool result; source never reaches the main model.
  openai.mode = 'ok'; openai.answer = 'Disk full. L2500: "NEEDLE-2500 disk full"';
  let run = await runPi({ script: [{ tool: { name: 'skim', input: { path: 'big.log', question: 'Why did it fail?' } } }, { text: 'done' }] });
  assert.equal(openai.requests.length, 1, 'one OpenAI request');
  const oreq = openai.requests[0].payload;
  assert.equal(oreq.model, 'gpt-6-luna');
  assert.ok(userText(oreq).includes('2500\\tNEEDLE-2500 disk full'), 'numbered source sent to the cheap model');
  assert.ok(userText(oreq).includes('Question: Why did it fail?'));
  assert.match(JSON.stringify(oreq.instructions ?? oreq.input), /say so explicitly/, 'not-in-source rule in the cheap prompt');
  let skimResult = run.toolResults.find(m => m.toolName === 'skim');
  assert.ok(skimResult && !skimResult.isError, textOf(skimResult));
  assert.match(textOf(skimResult), /L2500: "NEEDLE-2500 disk full"/);
  assert.match(textOf(skimResult), /\[skim: .*big\.log · \d+ chars, 3000 lines · model openai\/gpt-6-luna\]$/);
  assert.ok(skimResult.usage?.cost?.total > 0, `usage counted on the tool result: ${JSON.stringify(skimResult.usage)}`);
  assert.equal(skimResult.usage.input, 100000);
  const back = JSON.stringify(run.payloads[1].messages);
  assert.ok(back.includes('NEEDLE-2500') && !back.includes('filler line 42'), 'main model gets the answer, not the source');
  ok('file: gpt-6-luna answers with L<n> quote and footer; usage on the tool result; source not in main context');

  // Payload increase in the main session: same run with and without skim.
  const size = p => Buffer.byteLength(JSON.stringify(p.system ?? '')) + Buffer.byteLength(JSON.stringify(p.tools ?? []));
  const withSkim = run.payloads[0];
  const without = (await runPi({ script: [{ text: 'ok' }], extensions: [] })).payloads[0];
  assert.ok(withSkim.tools.some(t => t.name === 'skim') && !without.tools.some(t => t.name === 'skim'));
  assert.match(JSON.stringify(withSkim.system), /Use skim to understand large outputs, logs, diffs or pages when you do not need exact text; use read\/rg for text you will edit or quote\./);
  const roleBytes = ['scout', 'reviewer', 'planner', 'worker'].length * Buffer.byteLength(', skim'); // subagent description lists role tools
  const delta = size(withSkim) - size(without) + roleBytes;
  assert.ok(delta <= 1200, `skim adds ${delta} bytes to system+tools`);
  ok(`payload: skim adds ${delta} bytes to the main system+tools (≤ 1200, incl. ${roleBytes} in role lists)`);

  // 2) primary fails → Haiku; command through bash: full output past Pi's 2000-line cut and the child cap,
  // and a plain big bash result in a skim-enabled child gets the skim hint.
  openai.mode = 'fail'; openai.requests.length = 0;
  const command = 'seq 1 3000; echo MARK-END';
  run = await runPi({
    extensions: [SKIM, CAP],
    script: [
      { tool: { name: 'bash', input: { command: 'seq 1 3000' } } },
      { tool: { name: 'skim', input: { command, question: 'Last line?' } } },
      { text: 'MARK-END (L3001)' },
      { text: 'done' },
    ],
  });
  assert.equal(openai.requests.length, 1, 'primary tried first');
  const haiku = run.payloads[2];
  assert.equal(haiku.model, 'claude-haiku-4-5', 'fallback request goes to Haiku');
  assert.ok(userText(haiku).includes('1\\t1\\n2\\t2') && userText(haiku).includes('1500\\t1500') && userText(haiku).includes('3001\\tMARK-END'), 'whole command output, uncapped, numbered');
  skimResult = run.toolResults.find(m => m.toolName === 'skim');
  assert.ok(skimResult && !skimResult.isError, textOf(skimResult));
  assert.match(textOf(skimResult), /\[skim: \$ seq 1 3000; echo MARK-END \(exit 0\) · \d+ chars, 3002 lines · model anthropic\/claude-haiku-4-5\]$/);
  const capped = textOf(run.toolResults.find(m => m.toolName === 'bash'));
  assert.match(capped, /Full output: \S+ — read it with read offset\/limit or rg -n, not whole; to understand it without exact text, skim path=<that file>\.\]/);
  const cappedFile = /Full output: (\S+)/.exec(capped)[1];
  rmSync(dirname(cappedFile), { recursive: true, force: true });
  ok('fallback: OpenAI 400 → Haiku; command output whole (2000-line cut and child cap bypassed); cap hint names skim');

  // 3) every model fails: clear error, source not returned.
  run = await runPi({
    env: { AGENT_SKIM_MODEL: 'openai/gpt-6-luna, anthropic/no-such-model' },
    script: [{ tool: { name: 'skim', input: { path: file, question: 'Why?' } } }, { text: 'done' }],
  });
  skimResult = run.toolResults.find(m => m.toolName === 'skim');
  assert.ok(skimResult?.isError, 'all failed → error result');
  assert.match(textOf(skimResult), /skim: no cheap model answered \(openai\/gpt-6-luna: .*fake openai refused.*; anthropic\/no-such-model: unknown model\)\. Source not returned/);
  assert.doesNotMatch(textOf(skimResult), /NEEDLE-2500|filler line/);
  ok('all models fail: error names each failure; no source returned');

  // 4) the command runs through the session bash: a tool_call hook blocks it like a model-issued call.
  const blocker = join(root, 'blocker.mjs');
  writeFileSync(blocker, `export default function (pi) { pi.on('tool_call', e => e.toolName === 'bash' && String(e.input.command).includes('BLOCKME') ? { block: true, reason: 'blocked by policy' } : undefined); }\n`);
  openai.mode = 'ok';
  run = await runPi({ extensions: [SKIM, blocker], script: [{ tool: { name: 'skim', input: { command: 'echo BLOCKME', question: 'x' } } }, { text: 'done' }] });
  skimResult = run.toolResults.find(m => m.toolName === 'skim');
  assert.ok(skimResult?.isError);
  assert.match(textOf(skimResult), /skim: bash failed: .*blocked by policy/);
  ok('command: tool_call hooks of the session bash apply to skim');

  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const outside = mkdtempSync(join(repo, '.skim-sandbox-'));
    try {
      openai.requests.length = 0;
      run = await runPi({
        extensions: [SANDBOX, SKIM], env: { AGENT_BASH_SANDBOX: 'seatbelt', AGENT_SANDBOX_CWD: cwd },
        script: [{ tool: { name: 'skim', input: { command: `echo x > ${outside}/w.txt; echo rc=$?`, question: 'Did it write?' } } }, { text: 'done' }],
      });
      assert.ok(!existsSync(join(outside, 'w.txt')), 'sandbox denied the write');
      assert.match(userText(openai.requests[0].payload), /Operation not permitted/);
      ok('command: read-only child sandbox (seatbelt) applies to skim');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } else console.log('skip seatbelt check (not macOS)');

  // 5) wiring: bundled roles declare skim; the runner loads the extension only for them.
  for (const role of ['scout', 'reviewer', 'planner', 'worker']) {
    assert.match(readFileSync(join(repo, 'agent/agents', `${role}.md`), 'utf8'), /^tools: .*\bskim\b/m, role);
  }
  assert.doesNotMatch(readFileSync(join(repo, 'agent/agents/visual.md'), 'utf8'), /^tools: .*\bskim\b/m);
  const require = createRequire(join(piRoot, 'package.json'));
  const { createJiti } = require('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
    '@earendil-works/pi-ai': join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
    '@earendil-works/pi-agent-core': join(piRoot, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
    typebox: require.resolve('typebox'),
  } });
  const runner = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/runner.ts'));
  const seen = [];
  // Fake child: one skim tool result carrying usage, then the assistant turn.
  const lines = [
    { type: 'message_end', message: { role: 'toolResult', toolName: 'skim', content: [], usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fin' }], stopReason: 'stop', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 1 } } } },
  ].map(l => JSON.stringify(l)).join('\n');
  runner.runnerHooks.hostFreePercent = () => 100;
  runner.runnerHooks.getPiInvocation = args => { seen.push(args); return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(lines)})`] }; };
  const results = [];
  for (const tools of [['read', 'skim'], ['read']]) {
    results.push(await runner.runSingleAgent({ agents: [{ name: 'r', source: 'user', tools, systemPrompt: 'x' }], agentName: 'r', task: 't', defaultCwd: cwd, cwd,
      dispatchDefaults: {}, makeDetails: () => ({}), prefetch: true }));
  }
  assert.equal(seen.length, 2);
  assert.ok(seen[0].some(a => a.endsWith('agent/skim/index.ts')), 'role with skim loads the extension');
  assert.ok(!seen[1].some(a => a.endsWith('agent/skim/index.ts')), 'role without skim does not');
  assert.equal(results[0].usage.cost, 1.25, 'child cost includes skim usage');
  assert.equal(results[0].usage.input, 10, 'child tokens stay the child model\'s');
  assert.equal(results[0].usage.turns, 1);
  ok('roles scout/reviewer/planner/worker declare skim; runner loads it only for them; child cost includes skim usage');

  // 6) AGENT_SKIM_MAX_CHARS: head + tail with original line numbers, cut reported in the footer.
  const core = await jiti.import(join(repo, 'agent/extensions/agent/skim/core.ts'));
  assert.equal(core.skimMaxChars({}), 400000);
  assert.equal(core.skimMaxChars({ AGENT_SKIM_MAX_CHARS: '2000' }), 2000);
  assert.deepEqual(core.skimModels({}), ['openai/gpt-6-luna', 'anthropic/claude-haiku-4-5']);
  const big = readFileSync(file, 'utf8');
  let sent = '';
  const registry = { find: (p, id) => ({ provider: p, id }), hasConfiguredAuth: () => true,
    streamSimple: (_m, context) => ({ result: async () => { sent = context.messages[0].content[0].text; return { stopReason: 'stop', content: [{ type: 'text', text: 'Not in the source.' }] }; } }) };
  const cut = await core.skim({ registry, question: 'q', source: { label: 'big.log', text: big, numbered: true }, env: { AGENT_SKIM_MAX_CHARS: '2000' } });
  assert.ok(sent.includes('1\tfiller line 1\n') && sent.includes('3000\tfiller line 3000'), 'head and tail keep original line numbers');
  assert.match(sent, /\[\.\.\. \d+ chars omitted \(AGENT_SKIM_MAX_CHARS=2000\) \.\.\.\]/);
  assert.ok(sent.length < 3000 && !sent.includes('NEEDLE-2500'));
  assert.match(cut.text, /^Not in the source\.\n\n\[skim: big\.log · \d+ chars, 3000 lines · cut to first \d+ \+ last \d+ chars · model openai\/gpt-6-luna\]$/);
  ok('AGENT_SKIM_MAX_CHARS: head+tail with original line numbers; footer reports the cut');

  console.log(`\n${checks}/${checks} agent-skim checks passed (fakes in loopback; no external calls)`);
} finally {
  await openai.close();
  rmSync(root, { recursive: true, force: true });
}
