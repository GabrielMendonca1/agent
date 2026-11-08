#!/usr/bin/env node
// Portão permanente: pedidos a pessoas/sessões e compatibilidade do protocolo.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
const repo = resolve(import.meta.dirname, '..');
const store = process.env.AGENT_STORE || join(homedir(), '.local/share/agent');
const piRoot = realpathSync(process.env.AGENT_JUICE_PI_ROOT || join(store, 'current/lib/node_modules/@earendil-works/pi-coding-agent'));
const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
} });
const root = mkdtempSync(join(tmpdir(), 'agent-megamind-requests-'));
const savedConfig = process.env.ARCA_MEGAMIND_CONFIG;
const savedFetch = globalThis.fetch;
let checks = 0;
function ok(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
try {
  writeFileSync(join(root, 'token'), 'fictional-device-credential', { mode: 0o600 });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ endpoint: 'https://mainframe.example/api/arca/mcp', token_file: join(root, 'token') }));
  process.env.ARCA_MEGAMIND_CONFIG = join(root, 'config.json');
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push(rpc.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { id: 'request123', to: { kind: 'session', session_id: 'abcdef' }, woke: [] } }));
  };
  const { CoreV5, itemOf } = await jiti.import(join(repo, 'extensions/megamind/core-v5.ts'));
  const { CoreV6, parseItem } = await jiti.import(join(repo, 'extensions/megamind/core.ts'));
  for (const Core of [CoreV5, CoreV6]) {
    const core = new Core();
    for (const to of ['@Handle', 'actor:pb:person123']) {
      const sent = await core.send('sender', { to, body: 'context', ask: { title: 'work' } });
      ok(`v${core.core} person ${to} uses request_create without rewriting address`, () => {
        const call = calls.at(-1);
        assert.equal(call.name, 'request_create');
        assert.equal(call.arguments.to, to);
        assert.equal(call.arguments.from_session, 'sender');
        assert.equal(call.arguments.title, 'work');
        assert.equal(call.arguments.body, 'context');
        assert.equal(sent.id, 'request123');
        assert.equal(sent.to.kind, 'person');
      });
    }
    const to = '019a0000-0000-7000-8000-00000000abcd';
    await core.send('sender', { to, body: 'context', ask: { title: 'work' } });
    ok(`v${core.core} session routing unchanged`, () => assert.equal(calls.at(-1).name, core.core === 5 ? 'request_create' : 'send'));
  }
  const { parseEventFrame } = await jiti.import(join(repo, 'extensions/megamind/gateway.ts'));
  ok('legacy decision events are ignored', () => {
    assert.equal(parseEventFrame('data: {"kind":"decision","id":"legacy123"}'), undefined);
    assert.equal(parseEventFrame('data: {"kind":"approval_decision","id":"legacy123"}'), undefined);
    assert.equal(itemOf({ id: 'legacy123', kind: 'approval_decision' }), undefined);
    assert.equal(itemOf({ id: 'legacy123', kind: 'decision' }), undefined);
    assert.equal(parseItem({ id: 'legacy123', kind: 'decision' }), undefined);
  });
  const { Inbox, isAskUserItem } = await jiti.import(join(repo, 'extensions/megamind/messaging.ts'));
  const registryKey = Symbol.for('agent.askUser.requests');
  const savedRegistry = globalThis[registryKey];
  try {
    // O loader real usa Jiti por extensão, mas conserva o global do processo.
    const { loadExtensions } = await import(join(piRoot, 'dist/core/extensions/loader.js'));
    const writer = join(root, 'registry-writer.ts');
    const reader = join(root, 'registry-reader.ts');
    writeFileSync(writer, `import { registerAskUserRequest } from ${JSON.stringify(join(repo, 'agent/extensions/brain-live/ask-user-requests.mjs'))};\nexport default () => registerAskUserRequest('registered123');`);
    writeFileSync(reader, `import { isAskUserItem } from ${JSON.stringify(join(repo, 'extensions/megamind/messaging.ts'))};\nexport default () => { if (!isAskUserItem({kind:'reply', id:'registered123', from:{}})) throw new Error('global isolado'); };`);
    const loaded = await loadExtensions([writer, reader], root);
    ok('Pi loader shares registry across extensions and host', () => {
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 2);
      assert.equal(isAskUserItem({ kind: 'reply', id: 'registered123', from: {} }), true);
    });
    const { createAskRequest } = await import(join(repo, 'agent/extensions/brain-live/ask-user-megamind.mjs'));
    globalThis.fetch = async (_url, init) => {
      const rpc = JSON.parse(init.body);
      const name = rpc.params.name;
      if (name === 'request_create') assert.equal(globalThis[registryKey].has(rpc.params.arguments.request_id), true);
      const result = name === 'list_agents' ? { items: [{ session_id: 'sender', owner_id: 'owner' }] } : { id: 'created123' };
      return new Response(JSON.stringify({ result }));
    };
    const request = await createAskRequest({ question: 'Pergunta?' }, undefined, 'sender');
    request.stop();
    ok('createAskRequest registers returned id', () => assert.equal(globalThis[registryKey].has('created123'), true));
    const ask = (id, body) => ({ id, kind: 'ask', from: {}, body });
    const reply = id => ({ id, kind: 'reply', from: {}, ask: { status: 'done' } });
    const hidden = [ask('marker123', 'Pergunta\n\n[ask_user]\n- Sim'), ask('crlf123', 'Pergunta\r\n[ask_user]\r\n- Não'), ask('bare123', '[ask_user]'), reply('created123'), { ...reply('registered123'), ask: { status: 'declined' } }];
    const normal = [ask('normal123', 'Trabalhe'), reply('normal123'), ...['x [ask_user]', ' [ask_user]', '[ask_user] extra', '[ASK_USER]', '[ask_user]\r'].map((body, i) => ask(`near${i}`, body)), { id: 'message123', kind: 'message', from: {}, body: '[ask_user]' }];
    for (const acknowledges of [true, false]) {
      const delivered = [], tracked = [], acked = [], warnings = [];
      const inbox = new Inbox({ fetch: async () => [...hidden, ...normal], acknowledges,
        ack: async (_session, ids) => { acked.push(...ids); }, deliver: text => delivered.push(text),
        onDelivered: item => tracked.push(item.id), warn: error => warnings.push(error) });
      await inbox.poll('sender', 1);
      ok(`inbox v${acknowledges ? 5 : 6} skips and acks only exact markers/registered updates`, () => {
        assert.equal(inbox.pending, normal.length);
        assert.deepEqual(acked, hidden.map(item => item.id));
        assert.deepEqual(tracked, []);
      });
      while (inbox.pending) inbox.drain('sender', true);
      await Promise.resolve();
      ok(`inbox v${acknowledges ? 5 : 6} normal requests/updates unchanged`, () => {
        assert.equal(delivered.length, normal.length);
        assert.match(delivered[0], /PEDIDO normal123 de/);
        assert.match(delivered[1], /PEDIDO normal123 agora está done/);
        assert.deepEqual(tracked, normal.map(item => item.id));
        assert.deepEqual(warnings, []);
      });
      inbox.reset();
      await inbox.poll('sender', 2);
      ok(`inbox v${acknowledges ? 5 : 6} manual read also excludes escalations`, () => assert.deepEqual(inbox.takeAll('sender'), normal));
    }
    let attempts = 0;
    const warnings = [];
    const retry = new Inbox({ fetch: async () => hidden, acknowledges: true,
      ack: async () => { if (++attempts <= hidden.length) throw new Error('offline'); },
      deliver: () => assert.fail('escalation injected'), warn: error => warnings.push(error) });
    await retry.poll('sender', 1);
    await retry.poll('sender', 2);
    ok('skipped items retry failed ack without injection', () => {
      assert.equal(attempts, hidden.length * 2);
      assert.equal(warnings.length, hidden.length);
      assert.equal(retry.pending, 0);
    });
  } finally {
    if (savedRegistry === undefined) delete globalThis[registryKey];
    else globalThis[registryKey] = savedRegistry;
    globalThis.fetch = async () => new Response(JSON.stringify({ result: { id: 'request123', to: { kind: 'session', session_id: 'abcdef' }, woke: [] } }));
  }
  const { registerMegamindTools } = await jiti.import(join(repo, 'extensions/megamind/tools.ts'));
  const tools = new Map();
  registerMegamindTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {
    presence: () => ({ session_id: 'sender', project_id: 'project' }),
    core: async () => new CoreV5(), now: Date.now,
  });
  ok('request tool has only destination/title/body and no capability tool', () => {
    assert.deepEqual(Object.keys(tools.get('megamind_ask').parameters.properties), ['to', 'title', 'body']);
    assert.equal(tools.size, 6);
  });
  const result = await tools.get('megamind_ask').execute('call', { to: '@handle', title: 'work', body: 'context' });
  ok('tool creates person request and reports its id', () => assert.match(result.content[0].text, /request123/));
  ok('runtime and subagent do not load removed modules', () => {
    for (const path of ['extensions/megamind/index.ts', 'agent/extensions/brain-live/subagent/runner.ts']) {
      assert.doesNotMatch(readFileSync(join(repo, path), 'utf8'), /childGate|publishGate|classifyToolCall/);
    }
    assert.equal(existsSync(join(repo, 'extensions/megamind/gate.ts')), false);
  });
} finally {
  globalThis.fetch = savedFetch;
  if (savedConfig === undefined) delete process.env.ARCA_MEGAMIND_CONFIG;
  else process.env.ARCA_MEGAMIND_CONFIG = savedConfig;
  rmSync(root, { recursive: true, force: true });
}
console.log(`megamind-requests: ${checks} checks`);
