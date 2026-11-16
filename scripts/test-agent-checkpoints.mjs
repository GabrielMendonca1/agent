#!/usr/bin/env node
// /rewind no Pi real, sem rede: `pi --mode rpc` com brain-live/checkpoints.ts contra o Anthropic
// falso. Prova: snapshot antes de write/edit, persistência ao retomar (--continue em outro processo),
// arquivo criado → removido, conflito com mudança feita por fora, conversa via navigateTree e
// payload do modelo idêntico com e sem a extensão.
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.AGENT_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
const cli = join(piRoot, 'dist/cli.js');
if (!existsSync(cli)) { console.log(`SKIP agent-checkpoints: Pi não instalado em ${piRoot}`); process.exit(0); }
const extension = join(repo, 'agent/extensions/brain-live/checkpoints.ts');

const root = mkdtempSync(join(tmpdir(), 'agent-checkpoints-'));
const agentDir = join(root, 'home/.agent');
const work = join(root, 'work');
const sessions = join(root, 'sessions');
mkdirSync(agentDir, { recursive: true }); mkdirSync(work); mkdirSync(sessions);
const file = (name) => join(work, name);
const read = (name) => readFileSync(file(name), 'utf8');

const script = [
  { tool: { name: 'write', input: { path: 'a.txt', content: 'A1' } } },
  { text: 'um feito' },
  { tool: { name: 'write', input: { path: 'sub/new.txt', content: 'N' } } },
  { tool: { name: 'edit', input: { path: 'a.txt', edits: [{ oldText: 'A1', newText: 'A2' }] } } },
  { text: 'dois feito' },
];
let fake;
const configure = (baseUrl) => {
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false } }));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { api: 'anthropic-messages', apiKey: 'offline', baseUrl,
    models: [{ id: 'claude-x', name: 'x', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 }] } } }));
};
const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_DURABLE_HOST: '0' };
delete env.AGENT_CHECKPOINTS; delete env.AGENT_CHILD;
const base = ['--no-extensions', '--no-skills', '--model', 'fake/claude-x', '--tools', 'read,edit,write'];

function rpc(extra) {
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', ...base, '-e', extension, '--session-dir', sessions, ...extra], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const queue = []; const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    queue.push(msg);
    for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  let n = 0;
  return {
    send: (cmd) => child.stdin.write(`${JSON.stringify(cmd)}\n`),
    wait(test, label) {
      const seen = queue.find(test);
      if (seen) { queue.splice(queue.indexOf(seen), 1); return Promise.resolve(seen); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando ${label}\n${stderr.slice(-2000)}`)), 30_000);
        waiters.push({ test, resolve: (m) => { clearTimeout(timer); queue.splice(queue.indexOf(m), 1); resolve(m); } });
      });
    },
    async request(cmd) { const id = `r${++n}`; this.send({ ...cmd, id }); return this.wait((m) => m.type === 'response' && m.id === id, cmd.type); },
    async prompt(message) { await this.request({ type: 'prompt', message }); await this.wait((m) => m.type === 'agent_settled', `agent_settled de ${message}`); },
    select(label) { return this.wait((m) => m.type === 'extension_ui_request' && m.method === 'select', `select ${label}`); },
    answer(req, value) { this.send({ type: 'extension_ui_response', id: req.id, ...(value === undefined ? { cancelled: true } : { value }) }); },
    notify() { return this.wait((m) => m.type === 'extension_ui_request' && m.method === 'notify', 'notify'); },
    close() { child.stdin.end(); return new Promise((r) => { const k = setTimeout(() => child.kill('SIGKILL'), 10_000); child.on('close', () => { clearTimeout(k); r(); }); }); },
  };
}

function runPrint(withExtension) {
  const args = [cli, '-p', '--no-session', ...base, ...(withExtension ? ['-e', extension] : []), 'um'];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(kill); done({ code, out }); });
  });
}

try {
  // 1. Payload: com e sem a extensão, os requests ao modelo são iguais (nenhuma tool, nada no prompt).
  const bodies = [];
  for (const withExtension of [false, true]) {
    writeFileSync(file('a.txt'), 'A0');
    fake = await startFakeAnthropic(script.slice(0, 2));
    configure(fake.baseUrl);
    const r = await runPrint(withExtension);
    assert.equal(r.code, 0, r.out);
    bodies.push(fake.messages().map(({ system, tools, messages }) => ({ system, tools, messages })));
    await fake.close();
  }
  assert.equal(bodies[0].length, 2, 'write + resposta');
  assert.deepEqual(bodies[1], bodies[0], 'payload do modelo idêntico com a extensão');
  console.log('ok payload: system, tools e mensagens iguais com e sem checkpoints');
  rmSync(join(agentDir, 'checkpoints'), { recursive: true, force: true });

  // 2. Sessão com dois turnos; o processo termina. Antes: uma sessão de checkpoints velha (40 dias)
  // e uma recente; o session_start apaga só a velha.
  for (const [name, days] of [['velha', 40], ['recente', 1]]) {
    const dir = join(agentDir, 'checkpoints', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.jsonl'), '');
    const when = new Date(Date.now() - days * 86_400_000);
    utimesSync(join(dir, 'index.jsonl'), when, when);
  }
  writeFileSync(file('a.txt'), 'A0');
  fake = await startFakeAnthropic(script);
  configure(fake.baseUrl);
  let pi = rpc([]);
  await pi.prompt('um');
  await pi.prompt('dois');
  await pi.close();
  assert.equal(read('a.txt'), 'A2');
  assert.equal(read('sub/new.txt'), 'N');
  const kept = readdirSync(join(agentDir, 'checkpoints'));
  assert.ok(!kept.includes('velha') && kept.includes('recente'), `limpeza por idade: ${kept}`);
  const sessionId = kept.find((name) => name !== 'recente');
  const index = readFileSync(join(agentDir, 'checkpoints', sessionId, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(index.filter((r) => r.t === 'snap').map((r) => [relative(realpathSync(work), r.path), r.before === null]), [['a.txt', false], ['sub/new.txt', true], ['a.txt', false]]);
  console.log('ok snapshot: estado anterior de a.txt e marcador "não existia" para sub/new.txt; sessão de 40 dias apagada');

  // 3. Retoma em outro processo: /rewind para antes do turno 2, só código.
  pi = rpc(['--continue']);
  pi.send({ type: 'prompt', message: '/rewind' });
  let req = await pi.select('turno');
  assert.match(req.title, /bash .*não é rastreado/);
  assert.equal(req.options.length, 2);
  assert.match(req.options[0], /^2\. dois · sub\/new\.txt, a\.txt$/);
  assert.match(req.options[1], /^1\. um · a\.txt$/);
  pi.answer(req, req.options[0]);
  req = await pi.select('ação');
  assert.match(req.title, /sub\/new\.txt: remover \(criado pelo agente\)/);
  assert.match(req.title, /a\.txt: restaurar/);
  pi.answer(req, 'Só código');
  await pi.notify();
  assert.equal(read('a.txt'), 'A1');
  assert.equal(existsSync(file('sub/new.txt')), false, 'arquivo criado pelo agente foi removido');
  console.log('ok rewind após retomar: a.txt volta a A1 e sub/new.txt criado → removido');

  // 4. Mudança por fora: conflito pede confirmação; cancelar não toca, sobrescrever restaura.
  writeFileSync(file('a.txt'), 'EXTERNO');
  for (const choice of ['Cancelar', 'Sobrescrever mesmo assim']) {
    pi.send({ type: 'prompt', message: '/rewind' });
    req = await pi.select('turno');
    pi.answer(req, req.options.find((o) => o.startsWith('1. um')));
    req = await pi.select('ação');
    assert.match(req.title, /a\.txt: restaurar · mudou por fora/);
    pi.answer(req, 'Código e conversa');
    req = await pi.select('conflito');
    assert.match(req.title, /Mudaram depois da última edição do agente[\s\S]*a\.txt/);
    pi.answer(req, choice);
    if (choice === 'Cancelar') {
      const { data } = await pi.request({ type: 'get_messages' });
      assert.equal(read('a.txt'), 'EXTERNO', 'cancelar não sobrescreve');
      assert.ok(data.messages.some((m) => m.role === 'user'), 'cancelar não mexe na conversa');
    }
  }
  await pi.notify();
  assert.equal(read('a.txt'), 'A0');
  const { data } = await pi.request({ type: 'get_messages' });
  assert.equal(data.messages.filter((m) => m.role === 'user').length, 0, `conversa voltou para antes do turno 1: ${JSON.stringify(data.messages.map((m) => m.role))}`);
  const { data: state } = await pi.request({ type: 'get_state' });
  assert.equal(state.sessionId, sessionId, 'mesma sessão (navegação na árvore, não fork)');
  await pi.close();
  console.log('ok conflito: mudança externa detectada; cancelar preserva; sobrescrever restaura A0; conversa via navigateTree');
  await fake.close();
  console.log('PASS agent-checkpoints');
} finally {
  await fake?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
