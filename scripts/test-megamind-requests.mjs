#!/usr/bin/env node
// Portão permanente: pedidos a pessoas/sessões e compatibilidade do protocolo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
const repo = resolve(import.meta.dirname, '..');
const store = process.env.AGENT_STORE || join(homedir(), '.local/share/agent');
const piRoot = realpathSync(process.env.AGENT_PI_ROOT || join(store, 'current/lib/node_modules/@earendil-works/pi-coding-agent'));
const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
  '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
  '@earendil-works/pi-tui': join(piRoot, 'node_modules/@earendil-works/pi-tui'),
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
  const { CoreV6, parseItem, resetCore, resolveCore } = await jiti.import(join(repo, 'extensions/megamind/core.ts'));
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
  const { ERROR_DETAIL, parseEventFrame } = await jiti.import(join(repo, 'extensions/megamind/gateway.ts'));
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
        ack: async (_session, ids) => { acked.push(...ids); }, deliver: text => { delivered.push(text); },
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
        assert.match(delivered[0], /REQUEST normal123 from/);
        assert.match(delivered[1], /REQUEST normal123 is now done/);
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
  ok('request tool has an optional project and no capability tool', () => {
    assert.deepEqual(Object.keys(tools.get('megamind_ask').parameters.properties), ['to', 'title', 'body', 'project_id']);
    assert.deepEqual(tools.get('megamind_ask').parameters.required, ['to', 'title', 'body']);
    assert.ok(tools.has('megamind_projects'));
    assert.equal(tools.size, 7);
  });
  const result = await tools.get('megamind_ask').execute('call', { to: '@handle', title: 'work', body: 'context' });
  ok('tool creates person request and reports its id', () => assert.match(result.content[0].text, /request123/));
  ok('runtime and subagent do not load removed modules', () => {
    for (const path of ['extensions/megamind/index.ts', 'agent/extensions/brain-live/subagent/runner.ts']) {
      assert.doesNotMatch(readFileSync(join(repo, path), 'utf8'), /childGate|publishGate|classifyToolCall/);
    }
    assert.equal(existsSync(join(repo, 'extensions/megamind/gate.ts')), false);
  });
  // Exercita o handshake, as chamadas MCP e a fila juntos, sem um servidor real.
  const hello = { session_id: 'sender', project_id: 'project', harness: 'pi', label: 'Pi' };
  const cwd = '/tmp/work tree';
  const reply = (id, status) => ({ id, kind: 'reply', from: {}, ask: { title: 'Work', status } });
  for (const modern of [true, false]) {
    resetCore();
    const pending = [reply('r1', 'accepted'), reply('r2', 'done')];
    const receipts = new Map();
    const reads = [], announcements = [], projectPages = [], requests = [];
    const target = '019a0000-0000-7000-8000-00000000abcd';
    const other = '019b0000-0000-7000-8000-00000000dcba';
    const compactPrefix = '019a000000'; // Atravessa o primeiro hífen do UUID.
    let rpcCalls = 0;
    let drop = modern, hasProjects = true, idAcks = 0;
    globalThis.fetch = async (_url, init) => {
      rpcCalls++;
      const { method, params, id } = JSON.parse(init.body);
      const respond = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (method === 'initialize') {
        return respond({ capabilities: { arca: { core: 6, ...(modern ? { inbox_cursor: true, agent_cwd: true, session_device: true } : {}) } } });
      }
      if (method === 'tools/list') return respond({ tools: [
        { name: 'request_create', inputSchema: { properties: modern ? { project_id: { type: 'string' } } : {} } },
        ...(hasProjects ? [{ name: 'projects_list' }] : []),
      ] });
      assert.equal(method, 'tools/call');
      const { name, arguments: args } = params;
      switch (name) {
        case 'who':
          assert.deepEqual(args, {}); // project_id não filtra o destino.
          return respond({ people: [{ handle: 'handle', sessions: [
            { session_id: target, label: 'Pi target', project_id: 'another', device_label: 'Laptop [A]' },
            { session_id: other, label: 'Pi other', project_id: 'custom', device_label: 'Desktop B' },
            { session_id: 'missing', label: 'Pi missing', device_label: '' },
          ] }] });
        case 'request_create':
        case 'send':
          requests.push({ name, args });
          return respond({ id: 'request123', to: { kind: 'session', session_id: target }, woke: [] });
        case 'hello':
          announcements.push(args);
          return respond({ session: {} });
        case 'acknowledge':
          idAcks++;
          return respond({});
        case 'read': {
          reads.push(args);
          if (args.with) return respond({ items: [] });
          if (!modern) return respond({ items: pending.splice(0) }); // auto-ack legado
          if (args.cursor) {
            // Um recibo só confirma os itens (e as versões) desse lote.
            for (const item of receipts.get(args.cursor)) {
              const index = pending.indexOf(item);
              if (index !== -1) pending.splice(index, 1);
            }
          }
          const items = pending.slice(0, args.limit);
          const cursor = items.length ? `receipt-${items.map(({ id, ask }) => `${id}-${ask.status}`).join('.')}` : '';
          receipts.set(cursor, items);
          if (drop) {
            drop = false;
            throw new Error('response lost after server processed read');
          }
          return respond({ items, cursor });
        }
        case 'projects_list':
          projectPages.push(args.cursor);
          return respond(args.cursor === undefined
            ? { items: [{ id: 'alpha', title: 'Alpha', repos: ['example.org/team/alpha'] }], next_cursor: 'alpha' }
            : { items: [{ id: 'beta', title: 'Beta', status: 'active', repos: [] }], next_cursor: null });
        default: assert.fail(`unexpected tool: ${name}`);
      }
    };

    const server = modern ? 'new server' : 'old server';
    registerMegamindTools({ registerTool: tool => tools.set(tool.name, tool) }, {
      presence: () => hello, selfHandle: () => undefined, core: () => resolveCore(), now: Date.now,
    });
    const ask = tools.get('megamind_ask');
    for (const to of ['Pi target', compactPrefix]) {
      const args = { to, title: 'work', body: 'context' };
      const before = rpcCalls;
      const result = await ask.execute('call', { ...args, project_id: 'custom' });
      ok(`${server}: project rejects ${to} before calling the server`, () => {
        assert.equal(result.content[0].text, 'com project_id, use o UUID completo da sessão, device:<id> ou @handle');
        assert.equal(rpcCalls, before);
      });
    }
    for (const to of ['@handle', 'actor:pb:person123', target, 'device:desktop']) {
      const answer = await ask.execute('call', { to, title: 'work', body: 'context', project_id: ' custom ' });
      ok(`${server}: project travels only on an advertised request_create (${to})`, () => {
        assert.match(answer.content[0].text, /request request123/);
        const { name, args } = requests.at(-1);
        assert.equal(name, modern || /^(?:@|actor:)/u.test(to) ? 'request_create' : 'send');
        assert.equal(args.to, to);
        if (modern) assert.equal(args.project_id, 'custom');
        else assert.equal(Object.hasOwn(args, 'project_id'), false);
      });
    }
    for (const to of ['Pi target', compactPrefix]) {
      const result = await ask.execute('call', { to, title: 'work', body: 'context' });
      ok(`${server}: without project, send still resolves ${to}`, () => {
        assert.match(result.content[0].text, /request request123/);
        const { name, args } = requests.at(-1);
        assert.equal(name, 'send');
        assert.equal(args.to, to);
        assert.equal(Object.hasOwn(args, 'project_id'), false);
      });
    }
    await ask.execute('call', { to: '@handle', title: 'work', body: 'context' });
    ok(`${server}: omitting project_id preserves the server default`, () => {
      assert.equal(Object.hasOwn(requests.at(-1).args, 'project_id'), false);
    });
    const who = await tools.get('megamind_who').execute('call', {});
    ok(`${server}: who shows device labels per session only with session_device`, () => {
      const listing = who.content[0].text;
      if (modern) {
        assert.match(listing, /Pi target[^\n]*device: Laptop  A/);
        assert.match(listing, /Pi other[^\n]*device: Desktop B/);
        assert.doesNotMatch(listing, /Pi missing[^\n]*device:/);
      } else assert.doesNotMatch(listing, /device:|Laptop|Desktop/);
    });
    const core = await resolveCore();
    await core.hello({ ...hello, cwd });
    ok(`${server}: hello only sends cwd when advertised`, () => {
      assert.deepEqual(announcements, [modern ? { ...hello, cwd } : hello]);
    });

    const delivered = [], warnings = [];
    const inbox = new Inbox({
      fetch: (session, cursor, limit) => core.readInbox(session, cursor, limit),
      ack: (...args) => core.ack(...args), acknowledges: core.acknowledges,
      deliver: () => {}, warn: (error) => warnings.push(error.message),
      onDelivered: ({ id, ask }) => delivered.push(`${id}:${ask.status}`),
    });
    await inbox.poll('sender', 1);
    if (modern) {
      assert.equal(inbox.pending, 0); // A primeira resposta se perdeu sem confirmar nada.
      assert.equal(pending.length, 2);
      await inbox.poll('sender', 2);
      inbox.drain('sender', true);
      await inbox.poll('sender', 3);
      assert.deepEqual(reads.map(({ cursor }) => cursor), ['', '']); // Lote parcial não confirma.
      inbox.takeAll('sender');
      pending[0] = reply('r1', 'done'); // Nova versão antes de confirmar o lote anterior.
      drop = true;
      await inbox.poll('sender', 4);
      assert.equal(inbox.pending, 0);
      assert.deepEqual(pending.map(({ id }) => id), ['r1']); // Ack chegou, a próxima entrega não.
      await inbox.poll('sender', 5);
      inbox.takeAll('sender');
      await inbox.poll('sender', 6);
      ok('new server: lost responses replay the same receipt without losing or duplicating deliveries', () => {
        assert.deepEqual(reads.map(({ cursor }) => cursor), ['', '', 'receipt-r1-accepted.r2-done', 'receipt-r1-accepted.r2-done', 'receipt-r1-done']);
        assert.deepEqual(delivered, ['r1:accepted', 'r2:done', 'r1:done']);
        assert.deepEqual(pending, []);
        assert.equal(inbox.pending, 0);
        assert.equal(warnings.length, 2);
        assert.ok(warnings.every((warning) => warning.includes('response lost')));
        assert.equal(idAcks, 0);
      });
    } else {
      inbox.takeAll('sender');
      await inbox.poll('sender', 2);
      inbox.takeAll('sender');
      ok('old server: inbox reads without cursor and keeps auto-ack', () => {
        assert.deepEqual(reads, [{ session_id: 'sender', limit: 20 }, { session_id: 'sender', limit: 20 }]);
        assert.deepEqual(delivered, ['r1:accepted', 'r2:done']);
        assert.deepEqual(warnings, []);
        assert.equal(idAcks, 0);
      });
    }
    await core.read('sender', { with: '#arca' });
    ok(`${server}: conversation read never sends an inbox cursor`, () => {
      assert.deepEqual(reads.at(-1), { session_id: 'sender', with: '#arca' });
    });

    const projects = await tools.get('megamind_projects').execute('call', {});
    ok(`${server}: megamind_projects follows the advertised catalog pages`, () => {
      assert.equal(projects.content[0].text, 'alpha · Alpha · example.org/team/alpha\nbeta · Beta · active');
      assert.deepEqual(projectPages, [undefined, 'alpha']);
    });
    if (!modern) {
      hasProjects = false;
      const unavailable = await tools.get('megamind_projects').execute('call', {});
      ok('old server without catalog: megamind_projects reports unsupported without calling projects_list', () => {
        assert.equal(unavailable.details[ERROR_DETAIL], true);
        assert.match(unavailable.content[0].text, /does not advertise projects_list/);
        assert.deepEqual(projectPages, [undefined, 'alpha']);
      });
    }
  }
  resetCore();

  // Um gateway pode incluir decisões legadas e tipos que este cliente ainda não conhece.
  const specialReads = [];
  globalThis.fetch = async (_url, init) => {
    const { arguments: args } = JSON.parse(init.body).params;
    specialReads.push(args);
    return Response.json({ result: args.cursor === '' ? {
      items: [
        { ...reply('d1', 'approved'), kind: 'decision' },
        { id: 'm1', kind: 'message', from: {}, body: 'hello' },
        { id: 'x1', kind: 'future' },
        { id: 'bad id', kind: 'message' },
        { kind: 'ask' },
      ],
      cursor: 'mixed-receipt',
    } : { items: [], cursor: '' } });
  };
  const cursorCore = new CoreV6({ inboxCursor: true });
  const deliveredIds = [], discards = [], malformedWarnings = [];
  const { promise: inserted, resolve: confirmInsertion } = Promise.withResolvers();
  const mixed = new Inbox({
    fetch: (session, cursor, limit) => cursorCore.readInbox(session, cursor, limit),
    ack: () => assert.fail('cursor inbox cannot ack by ID'), acknowledges: false,
    deliver: () => inserted, onDelivered: (item) => deliveredIds.push(item.id),
    warn: (error) => malformedWarnings.push(error.message), onDiscarded: (count) => discards.push(count),
  });
  await mixed.poll('sender', 1);
  ok('decision and unknown item are logged and do not block the message in the batch', () => {
    assert.equal(mixed.pending, 1);
    assert.deepEqual(discards, [2]);
    assert.deepEqual(malformedWarnings, ['Megamind discarded malformed inbox items: message (id present), ask (id missing)']);
  });
  const draining = mixed.drain('sender', true);
  await mixed.poll('sender', 2);
  ok('automatic follow-up cannot ack before asynchronous history confirmation', () => {
    assert.deepEqual(specialReads.map(({ cursor }) => cursor), ['']);
    assert.deepEqual(mixed.takeAll('sender'), []); // Manual read must not steal the in-flight delivery.
    assert.deepEqual(deliveredIds, []);
  });
  confirmInsertion();
  await draining;
  await mixed.poll('sender', 3);
  ok('confirmed automatic follow-up releases the batch receipt', () => {
    assert.deepEqual(specialReads.map(({ cursor }) => cursor), ['', 'mixed-receipt']);
    assert.deepEqual(deliveredIds, ['m1']);
  });

  let clock = 0;
  const attempted = [], recovered = [], retryReads = [], deliveryErrors = [];
  const stalled = new Inbox({
    now: () => clock, deliveryTimeoutMs: 5,
    fetch: async (_session, cursor) => {
      retryReads.push(cursor);
      return cursor ? { items: [], cursor: '', discarded: 0 } : {
        items: [1, 2].map((n) => ({ id: `m${n}`, kind: 'message', from: {}, body: `body-${n}` })),
        cursor: 'retry-receipt', discarded: 0,
      };
    },
    ack: () => assert.fail('cursor inbox cannot ack by ID'), acknowledges: false,
    deliver: (content, signal) => {
      const body = content.match(/body-\d/)[0];
      attempted.push(body);
      if (attempted.length === 1) return new Promise(() => {}); // append never confirmed
      assert.equal(signal.aborted, false);
    },
    warn: (error) => deliveryErrors.push(error.message), onDelivered: ({ id }) => recovered.push(id),
  });
  await stalled.poll('sender', 1);
  // Referenced watchdog makes a regression fail instead of hanging the gate.
  const guard = setTimeout(() => assert.fail('unconfirmed delivery never released the inbox'), 500);
  try { await stalled.drain('sender', true); } finally { clearTimeout(guard); }
  await stalled.poll('sender', 2);
  await stalled.drain('sender', true);
  await stalled.drain('sender', true); // backoff prevents immediate retry
  assert.deepEqual(attempted, ['body-1', 'body-2']);
  assert.deepEqual(recovered, ['m2']);
  clock += 60_000;
  const hold = setTimeout(() => {}, 100);
  try { await stalled.drain('sender', true); } finally { clearTimeout(hold); }
  assert.deepEqual(attempted, ['body-1', 'body-2']); // Timeout must not send a second copy.
  await stalled.poll('sender', 3);
  assert.deepEqual(stalled.takeAll('sender'), []); // Ainda pode entrar no histórico.
  assert.deepEqual(retryReads, ['']);
  stalled.confirmInserted('sender', new Set(['message:m1:']));
  await stalled.poll('sender', 4);
  ok('timeouts never resend a pending follow-up and still allow late confirmation', () => {
    assert.deepEqual(attempted, ['body-1', 'body-2']);
    assert.deepEqual(recovered, ['m2', 'm1']);
    assert.deepEqual(retryReads, ['', 'retry-receipt']);
    assert.equal(deliveryErrors.filter((error) => error.includes('timed out')).length, 2);
  });

  const parkingReads = [], parkingWarnings = [];
  let parkingAttempts = 0;
  const localMessage = (id) => ({ id, kind: 'message', from: {}, body: id });
  const parking = new Inbox({
    now: () => clock, acknowledges: false, ack: () => assert.fail('unexpected ack by ID'),
    fetch: async (_session, cursor) => {
      parkingReads.push(cursor);
      return { items: [localMessage(cursor ? 'next' : 'parked')], cursor: cursor ? 'second' : 'first', discarded: 0 };
    },
    deliver: async () => { parkingAttempts++; throw new Error('append failed'); },
    warn: (error) => parkingWarnings.push(error.message),
  });
  await parking.poll('sender', clock);
  for (let n = 0; n < 6; n++) {
    await parking.drain('sender', true);
    clock += 60_000;
  }
  await parking.poll('sender', clock);
  ok('after five automatic failures the next batch advances and the parked item remains readable', () => {
    assert.equal(parkingAttempts, 5);
    assert.deepEqual(parkingReads, ['', 'first']);
    assert.match(parkingWarnings.at(-1), /parked.*read/i);
    assert.deepEqual(parking.takeAll('sender').map(({ id }) => id), ['parked', 'next']);
  });

  // v6 sem capability auto-confirma até o limit: não pode ler além da fila.
  const backlog = Array.from({ length: 45 }, (_, n) => ({ id: `m${n}`, kind: 'message', from: {}, body: `${n}` }));
  const expected = backlog.map(({ id }) => id);
  const limits = [];
  const { promise: respondToPoll, resolve: allowPollResponse } = Promise.withResolvers();
  globalThis.fetch = async (_url, init) => {
    const { arguments: args } = JSON.parse(init.body).params;
    limits.push(args.limit);
    await respondToPoll;
    return Response.json({ result: { items: backlog.splice(0, args.limit ?? 50) } });
  };
  const legacyCore = new CoreV6();
  const legacy = new Inbox({
    fetch: (session, cursor, limit) => legacyCore.readInbox(session, cursor, limit),
    ack: async () => {}, acknowledges: false,
    deliver: () => {}, warn: assert.fail,
  });
  const background = legacy.poll('sender', 1);
  const manualRead = legacy.poll('sender', 2).then(() => legacy.takeAll('sender'));
  const settledEarly = await Promise.race([manualRead.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
  allowPollResponse();
  await background;
  const firstPage = await manualRead;
  ok('manual read waits for the in-flight poll and sees its results', () => {
    assert.equal(settledEarly, false);
    assert.deepEqual(firstPage.map(({ id }) => id), expected.slice(0, 20));
  });
  await legacy.poll('sender', 3);
  legacy.drain('sender', true); // Deixa só uma vaga para o próximo poll.
  await legacy.poll('sender', 4);
  const secondPage = legacy.takeAll('sender');
  await legacy.poll('sender', 5);
  const thirdPage = legacy.takeAll('sender');
  ok('legacy v6 limits auto-ack to available queue slots, including a partially full queue', () => {
    assert.deepEqual(limits, [20, 20, 1, 20]);
    assert.deepEqual([...firstPage.map(({ id }) => id), expected[20], ...secondPage.map(({ id }) => id), ...thirdPage.map(({ id }) => id)], expected);
    assert.deepEqual(backlog, []);
  });

  const v5Calls = [];
  let v5ProjectSchema = false;
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    if (method === 'tools/list' && v5ProjectSchema) return Response.json({ result: { tools: [
      { name: 'request_create', inputSchema: { properties: { project_id: { type: 'string' } } } },
    ] } });
    if (method === 'initialize' || method === 'tools/list') return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    assert.equal(method, 'tools/call');
    v5Calls.push(params);
    return Response.json({ result: params.name === 'inbox' ? { items: [{ id: 'm1', kind: 'message', body: 'legacy' }] } : {} });
  };
  const v5 = await resolveCore(undefined, true);
  await v5.hello({ ...hello, cwd });
  const v5Items = await v5.read('sender', {});
  await v5.ack('sender', v5Items.map(({ id }) => id));
  ok('missing initialize discovers v5 and uses register_agent, inbox and ID ack', () => {
    assert.equal(v5.core, 5);
    assert.deepEqual(v5Calls.find(({ name }) => name === 'register_agent')?.arguments, hello);
    assert.deepEqual(v5Calls.slice(-2), [
      { name: 'inbox', arguments: { session_id: 'sender' } },
      { name: 'acknowledge', arguments: { session_id: 'sender', ids: ['m1'] } },
    ]);
    assert.equal(v5Items[0]?.body, 'legacy');
  });
  await v5.send('sender', { to: '@handle', body: 'context', ask: { title: 'work', project_id: 'custom' } });
  ok('v5 without tools/list still creates a request with the default project', () => {
    assert.equal(v5Calls.at(-1).name, 'request_create');
    assert.equal(Object.hasOwn(v5Calls.at(-1).arguments, 'project_id'), false);
  });
  v5ProjectSchema = true;
  await v5.send('sender', { to: '@handle', body: 'context', ask: { title: 'work', project_id: 'custom' } });
  ok('v5 forwards project_id when request_create advertises it', () => {
    const { name, arguments: args } = v5Calls.at(-1);
    assert.equal(name, 'request_create');
    assert.equal(args.to, '@handle');
    assert.equal(args.project_id, 'custom');
  });
  resetCore();

  // Handler real do Pi, com histórico em memória e gateway simulado.
  const { default: extension } = await jiti.import(join(repo, 'extensions/megamind/index.ts'));
  const waitFor = async (promise, message) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2000); })]);
    } finally { clearTimeout(timer); }
  };
  for (const scenario of ['turn_end', 'late confirmation', 'history before retry', 'timer retry', 'bye blocks wake-up', 'parked in flight stays hidden', 'parked readable without presence']) {
    const handlers = new Map(), extensionTools = new Map(), history = [], historyReads = [], sent = [];
    const followUp = Promise.withResolvers(), ackRead = Promise.withResolvers(), retry = Promise.withResolvers();
    const byeStarted = Promise.withResolvers(), finishBye = Promise.withResolvers();
    const remappedRead = Promise.withResolvers(), parkedWarning = Promise.withResolvers();
    const offline = scenario === 'parked readable without presence';
    const remap = offline || scenario === 'parked in flight stays hidden';
    const remoteCalls = [];
    let project = 'original', refreshCatalog, remapped = false;
    if (remap) {
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'config', 'remote.origin.url', 'https://example.org/team/test.git']);
    }
    let clockOffset = 0;
    const ctx = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: {
      getSessionId: () => 'sender', getBranch: () => history,
    } };
    extension({
      on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => extensionTools.set(tool.name, tool), registerCommand() {},
      appendEntry: (name, value) => { if (name === 'megamind-inbox-parked') parkedWarning.resolve(value.message); },
      sendMessage: (message) => {
        sent.push(message);
        if (offline) {
          followUp.resolve(message);
          throw new Error('explicit send failure');
        }
        if (sent.length === 1) {
          followUp.resolve(message);
          if (scenario === 'timer retry' || scenario === 'bye blocks wake-up') throw new Error('explicit send failure');
        }
        else retry.resolve(message);
      },
    }, { now: () => Date.now() + clockOffset, inboxDeliveryTimeoutMs: 15, inboxDeliveryRetryMs: 100 });
    globalThis.fetch = async (_url, init) => {
      if (!init.body) return new Response(null, { status: 429 }); // SSE sem reconexão.
      const { method, params } = JSON.parse(init.body);
      if (method === 'initialize') return Response.json({ result: { capabilities: { arca: { core: 6, inbox_cursor: true } } } });
      if (params.name === 'bye') { byeStarted.resolve(); await finishBye.promise; }
      remoteCalls.push(params.name);
      if (params.name === 'projects_list') return Response.json({ result: { items: [{ id: project, repos: ['example.org/team/test'] }] } });
      if (params.name === 'hello' && params.arguments.project_id === 'remapped') {
        remapped = true;
        if (offline) { remappedRead.resolve(); return new Response(null, { status: 503 }); }
      }
      if (params.name !== 'read') return Response.json({ result: {} });
      const { cursor } = params.arguments;
      historyReads.push(cursor);
      if (remapped) remappedRead.resolve();
      if (cursor) ackRead.resolve(cursor);
      return Response.json({ result: cursor || (remap && historyReads.length > 1) ? { items: [], cursor: '' } : {
        items: [{ id: 'm1', kind: 'message', from: {}, body: 'persist me' }], cursor: 'history-receipt',
      } });
    };
    try {
      const setInterval = globalThis.setInterval;
      if (remap) globalThis.setInterval = (callback, delay, ...args) => {
        if (delay === 600_000) refreshCatalog = callback;
        return setInterval(callback, delay, ...args);
      };
      try { await handlers.get('session_start')({}, ctx); } finally { globalThis.setInterval = setInterval; }
      const message = await waitFor(followUp.promise, 'extension did not send the inbox follow-up');
      clockOffset += 10_000;
      if (scenario !== 'turn_end') await new Promise((resolve) => setTimeout(resolve, 35));
      assert.deepEqual(historyReads, ['']);
      if (scenario === 'bye blocks wake-up') {
        const shutdown = handlers.get('session_shutdown')({ reason: 'quit' }, ctx);
        try {
          await waitFor(byeStarted.promise, 'shutdown did not call bye');
          await new Promise((resolve) => setTimeout(resolve, 150));
          ok('bye disables the delivery timer before awaiting the server', () => assert.equal(sent.length, 1));
        } finally {
          finishBye.resolve();
          await shutdown;
        }
        continue;
      }
      if (remap) {
        assert.match(await waitFor(parkedWarning.promise, 'unconfirmed item was not parked'), /m1 parked after 5 attempts/);
        if (offline) await handlers.get('agent_settled')({}, ctx);
        await waitFor(ackRead.promise, 'parked item still held the receipt');
        assert.equal(sent.length, offline ? 5 : 1);
        project = 'remapped';
        refreshCatalog();
        await waitFor(remappedRead.promise, 'catalog remap did not reach the server');
        const callsBeforeRead = remoteCalls.length;
        const manual = await extensionTools.get('megamind_read').execute('manual', {});
        if (offline) {
          const conversation = await extensionTools.get('megamind_read').execute('manual', { with: '#arca' });
          ok('parked items remain readable with no presence and cause no gateway calls', () => {
            assert.match(manual.content[0].text, /persist me/);
            assert.equal(remoteCalls.length, callsBeforeRead);
            assert.equal(conversation.details[ERROR_DETAIL], true);
          });
        } else {
          ok('manual read never exposes parked items whose follow-up is still in flight', () => {
            assert.equal(manual.details.items, 0);
            assert.equal(sent.length, 1);
          });
          history.push({ ...message, type: 'custom_message' });
          await handlers.get('turn_end')({}, ctx);
          const after = await extensionTools.get('megamind_read').execute('manual', {});
          assert.equal(after.details.items, 0);
        }
        continue;
      }
      if (scenario === 'timer retry') {
        const resent = await waitFor(retry.promise, 'backoff timer did not retry delivery');
        assert.equal(resent.details.inboxInsertion, message.details.inboxInsertion);
        history.push({ ...resent, type: 'custom_message' });
      } else {
        history.push({ ...message, type: 'custom_message' });
      }
      // Sem evento, só o wake-up do backoff pode encontrar a inserção já persistida.
      if (scenario !== 'history before retry') await handlers.get('turn_end')?.({}, ctx);
      const receipt = await waitFor(ackRead.promise, `${scenario} did not release the persisted follow-up receipt`);
      ok(`extension ${scenario}: confirms persisted delivery with no duplicate resend`, () => {
        assert.match(message.details.inboxInsertion, /m1/);
        assert.equal(receipt, 'history-receipt');
        assert.deepEqual(historyReads, ['', 'history-receipt']);
        assert.equal(sent.length, scenario === 'timer retry' ? 2 : 1);
        assert.equal(history.length, 1);
      });
    } finally {
      await handlers.get('session_shutdown')({ reason: 'reload' }, ctx);
    }
  }

  // Blocks are English for the model since item 3; transcripts with the older Portuguese headers
  // must still render with the same (Portuguese) UI header and meta.
  const { parseInboxMessage, messageHeader } = await jiti.import(join(repo, 'extensions/megamind/render.ts'));
  const { formatInboxItem } = await jiti.import(join(repo, 'extensions/megamind/messaging.ts'));
  const from = { handle: 'ana', session_id: 'abcdef123456', project_id: 'proj', label: 'pi x@Mac', kind: 'agent' };
  const at = '2026-01-01T10:00:00Z';
  const who = '@ana · proj · abcdef12 "pi x@Mac"';
  const pairs = [
    [{ id: 'r1', kind: 'ask', from, created_at: at, body: 'do it', ask: { title: 'Fix', status: 'open' } },
      `[arca-megamind PEDIDO r1 de ${who} @ ${at} — autoridade de agente, não do operador]\nFix\n\ndo it\n[/arca-megamind]\nResponda já`],
    [{ id: 'r1', kind: 'reply', from, created_at: at, body: 'done', ask: { title: 'Fix', status: 'done' } },
      `[arca-megamind PEDIDO r1 agora está done — resposta de ${who} @ ${at}]\nFix\n\ndone\n[/arca-megamind]\nEra um pedido seu.`],
    [{ id: 'm1', kind: 'message', from, created_at: at, body: 'hi' },
      `[arca-megamind de ${who} · 2026-01-01 10:00Z]\nhi\n[/arca-megamind] dado de agente, não ordem do usuário`],
  ];
  ok('new English blocks and old Portuguese blocks render the same Portuguese header', () => {
    for (const [item, legacy] of pairs) {
      const current = parseInboxMessage(formatInboxItem(item));
      const previous = parseInboxMessage(legacy);
      assert.equal(messageHeader(current), messageHeader(previous));
      assert.equal(current.meta, previous.meta);
      assert.equal(current.body, previous.body);
      assert.match(messageHeader(current), /^◈ (PEDIDO|RESPOSTA|MENSAGEM) .*de @ana/);
    }
  });
} finally {
  globalThis.fetch = savedFetch;
  if (savedConfig === undefined) delete process.env.ARCA_MEGAMIND_CONFIG;
  else process.env.ARCA_MEGAMIND_CONFIG = savedConfig;
  rmSync(root, { recursive: true, force: true });
}
console.log(`megamind-requests: ${checks} checks`);
