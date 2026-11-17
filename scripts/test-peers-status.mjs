#!/usr/bin/env node
/** Contagem de sessões sob o editor, vermelha enquanto há pedidos abertos.
 * Carrega a extensão real com Pi falso e malha IPC num diretório temporário.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), '.local/share/agent');
function findPiRoot() {
  if (process.env.AGENT_PI_ROOT) return realpathSync(process.env.AGENT_PI_ROOT);
  const relative = 'lib/node_modules/@earendil-works/pi-coding-agent';
  const current = join(store, 'current', relative);
  if (existsSync(join(current, 'dist/index.js'))) return realpathSync(current);
  const releases = join(store, 'releases');
  const found = (existsSync(releases) ? readdirSync(releases) : []).map((n) => join(releases, n, relative)).filter((p) => existsSync(join(p, 'dist/index.js')));
  return found.length ? realpathSync(found.sort().at(-1)) : null;
}
const piRoot = findPiRoot();
if (!piRoot) { console.log('skip: Pi não encontrado no store do overlay'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'agent-peers-status-'));
const sessions = [];
try {
  const req = createRequire(join(piRoot, 'package.json'));
  const { createJiti } = req('jiti');
  const dep = (name) => join(piRoot, 'node_modules', name);
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
    '@earendil-works/pi-ai': dep('@earendil-works/pi-ai'),
    '@earendil-works/pi-tui': dep('@earendil-works/pi-tui'),
    typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
  } });
  const peers = (await jiti.import(join(repo, 'agent/extensions/agent/peers/index.ts'))).default;

  let n = 0;
  async function session() {
    const handlers = new Map();
    const tools = new Map();
    const pi = {
      on(name, h) { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
      registerTool(t) { tools.set(t.name, t); }, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, registerFlag() {}, getFlag() {},
      sendMessage() {}, sendUserMessage() {}, appendEntry() {},
    };
    peers(pi, { dir });
    const writes = [];
    const legacy = [];
    const id = `019a0000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
    const ctx = {
      mode: 'tui', hasUI: true, cwd: dir, isIdle: () => true,
      sessionManager: { getSessionId: () => id, getBranch: () => [] },
      ui: { theme: { fg: (c, t) => `<${c}>${t}</>` }, setStatus: (k, v) => { if (k === 'agent-meta-peers') writes.push(v); if (k === 'peers') legacy.push(v); }, notify() {}, setWidget() {} },
    };
    for (const h of handlers.get('session_start') ?? []) await h({ reason: 'startup' }, ctx);
    const stop = async () => { for (const h of handlers.get('session_shutdown') ?? []) await h({ reason: 'quit' }, ctx); };
    const call = async (name, args) => (await tools.get(name).execute('x', args)).content[0].text;
    const s = { writes, legacy, ctx, handlers, stop, call, id, short: id.slice(-6) };
    sessions.push(s);
    return s;
  }
  const repaint = async (s) => { for (const h of s.handlers.get('agent_settled') ?? []) await h({}, s.ctx); return s.writes.at(-1); };

  const me = await session();

  assert.equal(await repaint(me), undefined, 'sem outras sessões: status limpo');

  const waitStatus = async (expected, message) => {
    const deadline = Date.now() + 2000;
    while (me.writes.at(-1) !== expected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(me.writes.at(-1), expected, message);
  };
  const newcomer = await session();
  await waitStatus('<muted>1 sessão</>', 'nova sessão atualiza sem ação local');
  await newcomer.stop();
  await waitStatus(undefined, 'saída da última outra sessão limpa sem ação local');
  console.log('ok entrada e saída sem ação local');

  const others = [];
  for (let i = 0; i < 3; i++) others.push(await session());
  assert.equal(await repaint(me), '<muted>3 sessões</>', 'contagem de sessões');
  assert.ok(me.legacy.every(v => v === undefined), 'status legado nunca publica conteúdo');
  console.log('ok contagem sem indicador legado');

  const [b, c] = others;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  // Eu peço a B: B vermelho (acompanha o pedido enquanto não fechar).
  const asked = await me.call('peers_ask', { to: b.short, title: 'faça X', body: 'detalhes' });
  const askId = asked.match(/p-[0-9a-f]+/)?.[0];
  assert.ok(askId, asked);
  assert.equal(me.writes.at(-1), '<error>3 sessões · pedido pendente</>', 'pedido meu a B: um vermelho na frente');
  // B aceita (ainda aberto), depois conclui: fecha.
  for (const h of b.handlers.get('agent_settled') ?? []) await h({}, b.ctx);
  await b.call('peers_reply', { id: askId, status: 'accepted' });
  await settle();
  assert.equal(me.writes.at(-1), '<error>3 sessões · pedido pendente</>', 'accepted não fecha');
  await b.call('peers_reply', { id: askId, status: 'done', result: 'feito' });
  await settle();
  assert.equal(me.writes.at(-1), '<muted>3 sessões</>', 'done fecha o pedido');
  console.log('ok pedido meu: vermelho até done');

  // C me pede: C vermelho até eu responder done.
  const inc = await c.call('peers_ask', { to: me.short, title: 'faça Y', body: 'detalhes' });
  const incId = inc.match(/p-[0-9a-f]+/)?.[0];
  assert.ok(incId, inc);
  await settle();
  assert.equal(me.writes.at(-1), '<error>3 sessões · pedido pendente</>', 'pedido de C a mim: vermelho');
  const replied = await me.call('peers_reply', { id: incId, status: 'declined', result: 'não' });
  assert.match(replied, /./);
  assert.equal(me.writes.at(-1), '<muted>3 sessões</>', 'declined fecha o pedido');
  console.log('ok pedido dela: vermelho até eu fechar');

  for (let i = 0; i < 7; i++) others.push(await session());
  assert.equal(await repaint(me), '<muted>10 sessões</>', 'contagem exata acima de oito');
  console.log('ok contagem acima de oito');

  for (const s of [...others, me]) await s.stop();
} finally {
  for (const s of sessions) await s.stop();
  rmSync(dir, { recursive: true, force: true });
}
