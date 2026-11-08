#!/usr/bin/env node
/** Comandos do usuário/agente (bash, codemode) não herdam o preload do Juice nem a curadoria de skills. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userCommandEnv } from '../mark/juice/child-env.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rt = '/tmp/x/mark/juice/runtime.mjs';
const url = `--import=file://${rt}`;

const run = (env) => userCommandEnv(env);
assert.equal(run({ NODE_OPTIONS: url }).NODE_OPTIONS, undefined);
assert.equal(run({ NODE_OPTIONS: `--max-old-space-size=64 ${url} --no-warnings` }).NODE_OPTIONS, '--max-old-space-size=64 --no-warnings');
assert.equal(run({ NODE_OPTIONS: `--no-warnings --import ${rt}` }).NODE_OPTIONS, '--no-warnings');
assert.equal(run({ NODE_OPTIONS: `--import ./other.mjs ${url}` }).NODE_OPTIONS, '--import ./other.mjs');
assert.equal(run({ PI_AUTOMATIC_SKILLS: 'peers' }).PI_AUTOMATIC_SKILLS, 'peers'); // sem snapshot: intacto
assert.equal(run({ PI_AUTOMATIC_SKILLS: 'peers', MARK_JUICE_SKILLS_BEFORE: 'null' }).PI_AUTOMATIC_SKILLS, undefined);
const s = run({ PI_AUTOMATIC_SKILLS: 'peers', MARK_JUICE_SKILLS_BEFORE: '"a,b"', MARK_JUICE_X: '1', KEEP: '1' });
assert.deepEqual(s, { PI_AUTOMATIC_SKILLS: 'a,b', KEEP: '1' });
const original = { NODE_OPTIONS: url, MARK_JUICE_SKILLS_BEFORE: 'null', PI_AUTOMATIC_SKILLS: 'peers' };
run(original);
assert.equal(original.NODE_OPTIONS, url); // não muta
assert.deepEqual(run({ MARK_JUICE_SKILLS_BEFORE: '{' , A: '1'}), { MARK_JUICE_SKILLS_BEFORE: '{', A: '1' }); // best-effort
console.log('ok userCommandEnv');

const store = process.env.PI_OVERLAY_STORE ? resolve(process.env.PI_OVERLAY_STORE) : join(homedir(), '.local/share/pi-overlay');
const rel = 'lib/node_modules/@earendil-works/pi-coding-agent';
let piRoot = process.env.MARK_JUICE_PI_ROOT;
if (!piRoot && existsSync(join(store, 'current', rel, 'dist/index.js'))) piRoot = join(store, 'current', rel);
if (!piRoot) { console.log('skip: Pi não encontrado'); process.exit(0); }
piRoot = realpathSync(piRoot);

const root = mkdtempSync(join(tmpdir(), 'mark-child-env-'));
const saved = { ...process.env };
try {
  mkdirSync(join(root, 'mark/juice'), { recursive: true });
  const fake = join(root, 'mark/juice/runtime.mjs');
  writeFileSync(fake, '');
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.NODE_OPTIONS = `--no-warnings --import=file://${fake}`;
  process.env.PI_AUTOMATIC_SKILLS = 'peers,megamind,prometheus,tasks';
  process.env.MARK_JUICE_SKILLS_BEFORE = 'null';

  const req = createRequire(join(piRoot, 'package.json'));
  const { createJiti } = req('jiti');
  const dep = (n) => join(piRoot, 'node_modules', n);
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
    '@earendil-works/pi-ai': dep('@earendil-works/pi-ai'),
    '@earendil-works/pi-tui': dep('@earendil-works/pi-tui'),
    typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
  } });
  const shell = await jiti.import(join(repo, 'mark/extensions/brain-live/shell-runtime.ts'));
  const display = await jiti.import(join(repo, 'mark/extensions/mark/tui/claude-cards.ts'));

  const probe = `node -e 'console.log(JSON.stringify({o:process.env.NODE_OPTIONS??null,s:process.env.PI_AUTOMATIC_SKILLS??null,j:Object.keys(process.env).filter(k=>k.startsWith("MARK_JUICE_"))}))'`;
  for (const compact of ['1', '0', 'absent']) {
    process.env.GARIME_CLAUDE_STYLE = compact === '0' ? '0' : '1';
    const tools = new Map();
    const handlers = new Map();
    const pi = { registerTool: (t) => tools.set(t.name, t), on: (n, h) => handlers.set(n, h), registerToolRenderer() {} };
    shell.default(pi);
    if (compact !== 'absent') display.default(pi);
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 's1', getSessionFile: () => undefined } };
    const result = await tools.get('bash').execute('t1', { command: probe }, undefined, undefined, ctx);
    const out = JSON.parse(result.content[0].text.trim());
    assert.deepEqual(out, { o: '--no-warnings', s: null, j: [] }, `bash (compact=${compact})`);

    const ops = handlers.get('user_bash')({ command: probe }, ctx).operations;
    let data = '';
    await ops.exec(probe, root, { onData: (b) => { data += b; }, env: { ...process.env } });
    assert.deepEqual(JSON.parse(data.trim()), { o: '--no-warnings', s: null, j: [] }, `user_bash (compact=${compact})`);
  }
  assert.ok(process.env.NODE_OPTIONS.includes(fake) && process.env.PI_AUTOMATIC_SKILLS, 'pai intacto');
  console.log('ok bash e user_bash filtram o env; pai intacto');
} finally {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
}
