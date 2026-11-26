#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { subagentEnv, userCommandEnv } from '../agent/core/child-env.mjs';

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const piRoot = realpathSync(process.env.WORKSPACE_TEST_PI ?? join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'),
  'current/lib/node_modules/@earendil-works/pi-coding-agent'));
const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
} });
const load = (name) => jiti.import(join(repo, 'agent/extensions/brain-live', `${name}.ts`));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
}).trimEnd();
const head = (cwd) => git(cwd, 'rev-parse', 'HEAD');
const clean = (cwd) => assert.equal(git(cwd, 'status', '--porcelain'), '', cwd);
const workspaceEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('AGENT_WORKTREE_')));

async function worker() {
  const [kind, cwd, branch] = process.argv.slice(3);
  let run;
  if (kind === 'owner') {
    const { registerWorkspace } = await load('subagent/workspace');
    registerWorkspace(cwd, { id: branch, kind: 'job', branch: git(cwd, 'branch', '--show-current'),
      worktree: cwd, pid: process.pid, scope: branch, startedAt: Date.now() });
  } else if (kind === 'integrate') {
    const { integrateWorktreeBranch } = await load('subagent/worktrees');
    run = (target) => integrateWorktreeBranch(target);
  } else {
    assert.equal(kind, 'ui');
    assert.equal(realpathSync(process.cwd()), realpathSync(cwd), 'Pi starts inside the session checkout');
    // The hermetic env helper clears Agent state, so pass the launched session's
    // four variables explicitly as fixture data instead of inheriting them.
    Object.assign(process.env, JSON.parse(branch), { AGENT_RUNTIME_ENABLED: '1' });
    const { default: extension } = await load('workspace-ui');
    const hooks = new Map();
    const notices = [];
    let command, shutdown = false;
    const ctx = { cwd, hasUI: false, isIdle: () => true, shutdown: () => { shutdown = true; },
      ui: { setStatus() {}, notify: (text, level) => notices.push({ text, level }) } };
    extension({ on: (name, cb) => hooks.set(name, cb), registerCommand: (name, spec) => {
      assert.equal(name, 'workspace');
      command = spec.handler;
    } });
    hooks.get('session_start')({}, ctx);
    assert.deepEqual(notices, [], 'session registration succeeds');
    run = async (args) => {
      let leftBeforeRemoval = false;
      const chdir = process.chdir;
      process.chdir = (destination) => {
        if (destination === process.env.AGENT_WORKTREE_SOURCE && existsSync(process.env.AGENT_WORKTREE_SESSION)) {
          leftBeforeRemoval = true;
        }
        chdir(destination);
      };
      try {
        await command(args, ctx);
        return { notices: notices.splice(0), shutdown, cwd: realpathSync(process.cwd()), leftBeforeRemoval };
      } finally { process.chdir = chdir; }
    };
  }
  process.on('message', async ({ input }) => {
    try {
      const pending = run(input);
      // Both integration APIs enter the lock acquisition before yielding.
      process.send({ type: 'entered' });
      process.send({ type: 'result', value: await pending });
    } catch (error) { process.send({ type: 'error', error: String(error.stack ?? error) }); }
  });
  process.send({ type: 'ready' });
}

async function main() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-concurrency-')));
  // No ambient Git config, preload, provider keys, profile, or network transport.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(comspec|systemroot|pathext|windir)$/i.test(key))),
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    PI_CODING_AGENT_DIR: join(root, 'profile'), PI_CHECKS_CACHE_DIR: join(root, 'checks-cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_ALLOW_PROTOCOL: '',
    GIT_TERMINAL_PROMPT: '0', AGENT_RUST_AUTO_INSTALL: '0', AGENT_WARM_START: '0', WORKSPACE_TEST_PI: piRoot,
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const workers = new Set();
  let releaseGate = () => {};
  function start(...args) {
    const cwd = args[0] === 'ui' ? args[1] : root;
    const child = fork(script, ['--worker', ...args], { env, cwd, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const closed = once(child, 'close');
    workers.add({ child, closed });
    const inbox = [];
    child.on('message', (msg) => inbox.push(msg));
    async function read(type) {
      return until(() => {
        if (inbox[0]?.type === 'error') throw Error(inbox.shift().error);
        assert.equal(child.exitCode, null, `worker ${args[0]} exited waiting for ${type}`);
        assert.equal(child.signalCode, null, `worker ${args[0]} killed waiting for ${type}`);
        if (!inbox.length) return;
        assert.equal(inbox[0].type, type);
        return inbox.shift();
      }, `${args[0]}: ${type}`);
    }
    return { child, closed, read, async enter(input) { child.send({ input }); await read('entered'); },
      async result() { return (await read('result')).value; } };
  }
  async function until(probe, label) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = probe();
      if (value) return value;
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      await delay(20);
    }
  }
  function commit(cwd, name, text = `${name}\n`) {
    writeFileSync(join(cwd, name), text);
    git(cwd, 'add', '--', name);
    git(cwd, 'commit', '-qm', name);
    return head(cwd);
  }
  function init(name, checks = [], link = [], checkScript) {
    const cwd = join(root, name);
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Workspace fixture');
    git(cwd, 'config', 'user.email', 'workspace@example.invalid');
    if (checks.length) writeFileSync(join(cwd, '.pi/checks.json'), JSON.stringify({ checks, link }));
    if (checkScript) writeFileSync(join(cwd, '.pi/fixture.cjs'), checkScript);
    writeFileSync(join(cwd, '.gitignore'), '/deps\n');
    writeFileSync(join(cwd, 'shared.txt'), 'base\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'base');
    return cwd;
  }
  function checkout(sourceCwd, branch) {
    const worktree = join(root, branch);
    git(sourceCwd, 'worktree', 'add', '-qb', branch, worktree);
    return { sourceCwd, sourceBranch: 'main', worktree, branch };
  }
  function unchanged(cwd, sha) {
    assert.equal(head(cwd), sha, cwd);
    clean(cwd);
    assert.equal(spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', 'MERGE_HEAD']).status, 128, cwd);
  }
  function removed(target) {
    assert.ok(!existsSync(target.worktree), target.worktree);
    assert.equal(git(target.sourceCwd, 'branch', '--list', target.branch), '');
  }
  function holdGate() {
    const ready = join(root, 'gate-ready');
    const release = join(root, 'gate-release');
    rmSync(ready, { force: true });
    rmSync(release, { force: true });
    const script = `const { existsSync, writeFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
if (existsSync('hold.txt') && !existsSync(${JSON.stringify(release)})) {
  writeFileSync(${JSON.stringify(ready)}, process.cwd());
  const deadline = Date.now() + 30000;
  while (existsSync(${JSON.stringify(root)}) && !existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await delay(20);
  if (!existsSync(${JSON.stringify(release)})) process.exitCode = 1;
}
})();
`;
    releaseGate = () => writeFileSync(release, '');
    return { check: { name: 'hold-gate', cmd: 'node .pi/fixture.cjs', timeoutMs: 35_000 }, script,
      async reached(worktree) {
        await until(() => existsSync(ready) && readFileSync(ready, 'utf8'), 'first integration reaches its gate');
        assert.equal(readFileSync(ready, 'utf8'), worktree);
      } };
  }

  try {
    const { listActiveWorkspaces } = await load('subagent/workspace');
    const { integrateWorktreeBranch } = await load('subagent/worktrees');

    // 1. Exercise the real launch lifecycle; replace only the Pi executable.
    const source = init('auto');
    const owner = start('owner', source, 'live-writer');
    await owner.read('ready');
    assert.deepEqual(listActiveWorkspaces(source).map(({ id }) => id), ['live-writer']);
    const { SubagentJobManager } = await load('subagent/jobs');
    const { runnerHooks } = await load('subagent/runner');
    const fixture = join(root, 'fake-child.mjs');
    const observedCwd = join(root, 'child-cwd');
    writeFileSync(fixture, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(observedCwd)}, process.cwd());
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }));
`);
    runnerHooks.getPiInvocation = () => ({ command: process.execPath, args: [fixture] });
    runnerHooks.hostFreePercent = () => 100;
    const roleFile = join(root, 'writer.md');
    writeFileSync(roleFile, 'fixture');
    let finished;
    const manager = new SubagentJobManager({ baseDir: join(root, 'jobs'), onComplete(record) { finished = record; } });
    async function single(isolated, options = {}) {
      rmSync(observedCwd, { force: true });
      finished = undefined;
      const launch = manager.launch({ sessionId: 'parent', sessionGeneration: 0, mode: 'single', cwd: source,
        agents: [{ name: 'writer', description: 'fixture', source: 'user', tools: ['read', 'edit'], systemPrompt: 'fixture', filePath: roleFile }],
        tasks: [{ agent: 'writer', task: 'fixture' }], agentScope: 'user', projectAgentsDir: null,
        dispatchDefaults: { model: 'fixture/fake', resources: { slots: {} } }, timeoutSeconds: 0, ...options });
      assert.ok(launch.ok, launch.error);
      await manager.waitForAnyJob('parent');
      assert.equal(finished?.status, 'completed', JSON.stringify(finished ?? launch.record));
      const task = finished.tasks[0];
      assert.equal(Boolean(task.worktree), isolated, JSON.stringify(launch.record));
      assert.ok(existsSync(observedCwd), JSON.stringify(launch.record));
      assert.equal(realpathSync(readFileSync(observedCwd, 'utf8')), task.worktree ?? source);
      if (isolated) assert.equal(git(task.worktree, 'branch', '--show-current'), task.branch);
    }
    await single(true);
    await single(false, { isolate: false });
    owner.child.kill('SIGKILL');
    await owner.closed;
    await single(false); // Launch itself is the first registry access after the crash.
    assert.deepEqual(listActiveWorkspaces(source), []);
    await single(true, { isolate: true });
    clean(source);
    console.log('ok auto-isolation, explicit overrides, and dead writer pruning');

    // 2. Start B only once A holds the production lock and is blocked in a real check.
    const gate = holdGate();
    const serial = init('serial', [gate.check], [], gate.script);
    const a = checkout(serial, 'serial-a');
    const b = checkout(serial, 'serial-b');
    const aSha = commit(a.worktree, 'hold.txt');
    const bSha = commit(b.worktree, 'other.txt');
    const before = head(serial);
    const first = start('integrate');
    const second = start('integrate');
    await Promise.all([first.read('ready'), second.read('ready')]);
    await first.enter(a);
    await gate.reached(a.worktree);
    await second.enter(b);
    unchanged(serial, before);
    unchanged(b.worktree, bSha);
    releaseGate();
    const integrated = await Promise.all([first.result(), second.result()]);
    for (const result of integrated) {
      assert.match(result.gateMessage, /checks gate passed/);
      assert.equal(result.cleanupWarning, undefined);
    }
    assert.equal(git(serial, 'show', 'HEAD:hold.txt'), 'hold.txt');
    assert.equal(git(serial, 'show', 'HEAD:other.txt'), 'other.txt');
    assert.equal(git(serial, 'rev-parse', 'HEAD^1^2'), aSha, 'A published before B');
    git(serial, 'merge-base', '--is-ancestor', bSha, 'HEAD');
    clean(serial);
    removed(a);
    removed(b);
    console.log('ok competing integrations serialize across processes');

    // 3. Conflicting preview aborts without publishing anything to main.
    const conflicting = init('conflict');
    const left = checkout(conflicting, 'conflict-a');
    const right = { ...checkout(conflicting, 'conflict-b'), handle: 'writer-b' };
    commit(left.worktree, 'shared.txt', 'left\n');
    const rightSha = commit(right.worktree, 'shared.txt', 'right\n');
    await integrateWorktreeBranch(left);
    const mainSha = head(conflicting);
    const mainRefLog = git(conflicting, 'reflog', 'show', 'main');
    await assert.rejects(integrateWorktreeBranch(right), (error) => {
      assert.match(error.message, /Merge preview failed.*conflicts: shared\.txt/);
      assert.match(error.message, /Resume the writer \(writer-b\) with subagent continue/);
      return true;
    });
    unchanged(conflicting, mainSha);
    assert.equal(git(conflicting, 'reflog', 'show', 'main'), mainRefLog);
    unchanged(right.worktree, rightSha);
    console.log('ok conflicting preview aborts and names file and writer');

    // 4. Neither side fails alone: the real gate rejects only the clean preview.
    const failing = init('failing', [{ name: 'combined-only', cmd: 'node .pi/fixture.cjs' }], [], `
const { existsSync } = require('node:fs');
if (existsSync('left.txt') && existsSync('right.txt')) {
  console.error('merged-only');
  process.exitCode = 1;
}
`);
    const candidate = checkout(failing, 'failing-writer');
    const candidateSha = commit(candidate.worktree, 'right.txt');
    const sourceSha = commit(failing, 'left.txt');
    const sourceLog = git(failing, 'reflog', 'show', 'main');
    await assert.rejects(integrateWorktreeBranch(candidate), (error) => {
      assert.match(error.message, /BLOCKS: 1 check/);
      assert.match(error.message, /combined-only[^\n]*merged-only/);
      return true;
    });
    unchanged(failing, sourceSha);
    assert.equal(git(failing, 'reflog', 'show', 'main'), sourceLog);
    unchanged(candidate.worktree, candidateSha);
    assert.ok(!existsSync(join(candidate.worktree, 'left.txt')));
    console.log('ok failed gate diagnoses exact check and restores preview');

    // 5. Run the actual launcher with a temporary store and a Pi CLI probe.
    const uiGate = holdGate();
    const sessions = init('sessions', [uiGate.check], ['deps'], uiGate.script);
    mkdirSync(join(sessions, 'deps'));
    const store = join(root, 'store');
    const bin = join(store, 'current/bin');
    mkdirSync(bin, { recursive: true });
    const cli = `console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AGENT_WORKTREE_'))) }));`;
    if (process.platform === 'win32') {
      const pkg = join(store, 'current/node_modules/@earendil-works/pi-coding-agent');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: { pi: 'cli.cjs' } }));
      writeFileSync(join(pkg, 'cli.cjs'), cli);
    } else {
      writeFileSync(join(bin, 'pi'), '#!/usr/bin/env node\n' + cli, { mode: 0o755 });
    }
    const launchArgs = (...args) => spawnSync(process.execPath, [join(repo, 'scripts/agent-launch.mjs'), '--store', store,
      '--', ...args], { cwd: sessions, env, encoding: 'utf8', timeout: 10_000 });
    const launch = (slug) => launchArgs('--worktree', slug, '--version');
    for (const promptArgs of [
      ['--system-prompt', '--worktree=example', '-p', 'hello'],
      ['--append-system-prompt', '--worktree', '-p', 'hello'],
      ['--', '--worktree=literal'],
    ]) {
      const plain = launchArgs(...promptArgs);
      assert.equal(plain.status, 0, plain.stderr);
      const probe = JSON.parse(plain.stdout);
      assert.equal(realpathSync(probe.cwd), sessions);
      assert.deepEqual(probe.args, promptArgs);
      assert.deepEqual(probe.env, {});
    }
    for (const slug of ['../x', '-bad', 'a/b']) {
      const bad = launch(slug);
      assert.equal(bad.status, 70, bad.stderr);
      assert.match(bad.stderr, /Invalid worktree slug/);
      assert.equal(bad.stdout, '');
    }
    assert.equal(git(sessions, 'worktree', 'list', '--porcelain').split(/^worktree /m).length, 2);
    function session(slug, piArgs = []) {
      const launched = launchArgs(...piArgs, '--worktree', slug, '--version');
      assert.equal(launched.status, 0, launched.stderr);
      const probe = JSON.parse(launched.stdout);
      const checkout = join(env.PI_CODING_AGENT_DIR, 'agent/worktrees', `session-${slug}`);
      assert.equal(realpathSync(probe.cwd), checkout);
      assert.deepEqual(probe.args, [...piArgs, '--version']);
      assert.deepEqual(probe.env, { AGENT_WORKTREE_SESSION: checkout, AGENT_WORKTREE_SOURCE: sessions,
        AGENT_WORKTREE_BRANCH: 'main', AGENT_WORKTREE_NAME: `agent/session-${slug}` });
      assert.equal(git(checkout, 'branch', '--show-current'), `agent/session-${slug}`);
      assert.ok(lstatSync(join(checkout, 'deps')).isSymbolicLink());
      assert.equal(realpathSync(join(checkout, 'deps')), join(sessions, 'deps'));
      for (const filter of [userCommandEnv, subagentEnv]) {
        const filtered = filter({ ...probe.env, AGENT_WORKTREE_FUTURE: 'sensitive', KEEP: 'yes' });
        assert.deepEqual(workspaceEnv(filtered), {});
        assert.equal(filtered.KEEP, 'yes');
      }
      return probe;
    }
    const publish = session('publish', ['--system-prompt', '--worktree=literal']);
    const drop = session('drop');
    console.log('ok launcher passes session cwd and env, links declared paths, and rejects invalid slugs');

    // 6. Drive the registered command handlers in distinct live session processes.
    const publisher = start('ui', publish.cwd, JSON.stringify(publish.env));
    const discarder = start('ui', drop.cwd, JSON.stringify(drop.env));
    const crashed = start('owner', sessions, 'dead-ui-fixture');
    await Promise.all([publisher.read('ready'), discarder.read('ready'), crashed.read('ready')]);
    async function command(worker, input, level = 'info') {
      await worker.enter(input);
      const { notices } = await worker.result();
      assert.equal(notices.length, 1, JSON.stringify(notices));
      assert.equal(notices[0].level, level, notices[0].text);
      return notices[0].text;
    }
    assert.match(await command(publisher, 'claim   edit   ui.txt'), /Workspace scope: edit ui\.txt/);
    const status = await command(discarder, 'status');
    assert.match(status, /session agent\/session-publish · PID \d+ \(active\)[\s\S]*Scope: edit ui\.txt/);
    assert.match(status, /session agent\/session-drop \(this session\)/);
    assert.match(status, /job main · PID \d+ \(active\)[\s\S]*Scope: dead-ui-fixture/);
    crashed.child.kill('SIGKILL');
    await crashed.closed;
    assert.doesNotMatch(await command(discarder, 'status'), /dead-ui-fixture|job main/);

    git(sessions, 'worktree', 'lock', drop.cwd);
    await discarder.enter('discard');
    const locked = await discarder.result();
    assert.equal(locked.notices[0]?.level, 'error');
    assert.match(locked.notices[0].text, /locked/i);
    assert.equal(locked.shutdown, false);
    assert.equal(locked.cwd, realpathSync(drop.cwd), 'restore the session cwd when removal fails');
    assert.equal(locked.leftBeforeRemoval, true, 'leave the checkout before attempting removal');
    git(sessions, 'worktree', 'unlock', drop.cwd);

    const lockHolder = checkout(sessions, 'ui-lock-holder');
    commit(lockHolder.worktree, 'hold.txt');
    commit(publish.cwd, 'ui.txt');
    commit(drop.cwd, 'discarded.txt');
    const uiBase = head(sessions);
    await first.enter(lockHolder);
    await uiGate.reached(lockHolder.worktree);
    await Promise.all([publisher.enter('integrate'), discarder.enter('discard')]);
    unchanged(sessions, uiBase);
    assert.ok(existsSync(drop.cwd), 'discard waits for the repo integration lock');
    assert.ok(existsSync(publish.cwd), 'integrate waits for the repo integration lock');
    releaseGate();
    const [holderResult, published, discarded] = await Promise.all([first.result(), publisher.result(), discarder.result()]);
    assert.match(holderResult.gateMessage, /checks gate passed/);
    assert.equal(holderResult.cleanupWarning, undefined);
    assert.deepEqual(published, { notices: [{ level: 'info', text: 'Integrated agent/session-publish into main.\nchecks gate passed (1 checks).' }], shutdown: true, cwd: sessions, leftBeforeRemoval: true });
    assert.deepEqual(discarded, { notices: [{ level: 'info', text: 'Discarded agent/session-drop.' }], shutdown: true, cwd: sessions, leftBeforeRemoval: true });
    removed({ sourceCwd: sessions, worktree: publish.cwd, branch: publish.env.AGENT_WORKTREE_NAME });
    removed({ sourceCwd: sessions, worktree: drop.cwd, branch: drop.env.AGENT_WORKTREE_NAME });
    assert.equal(git(sessions, 'show', 'HEAD:ui.txt'), 'ui.txt');
    assert.ok(!existsSync(join(sessions, 'discarded.txt')));
    assert.deepEqual(listActiveWorkspaces(sessions), []);
    clean(sessions);
    console.log('ok /workspace status, claim, integrate, and discard under the repo lock');

    // Register a second session on the same checkout after the first has begun
    // waiting for the lock. A forced discard must preserve the late owner's edits.
    const raceGate = holdGate();
    const race = session('race');
    const original = start('ui', race.cwd, JSON.stringify(race.env));
    await original.read('ready');
    const raceHolder = checkout(sessions, 'race-lock-holder');
    await first.enter(raceHolder);
    await raceGate.reached(raceHolder.worktree);
    await original.enter('discard --force');
    const reopened = session('race');
    const late = start('ui', reopened.cwd, JSON.stringify(reopened.env));
    await late.read('ready');
    const edit = join(reopened.cwd, 'uncommitted.txt');
    writeFileSync(edit, 'late owner edit');
    releaseGate();
    await first.result();
    const refused = await original.result();
    assert.equal(refused.shutdown, false);
    assert.equal(refused.cwd, realpathSync(race.cwd));
    assert.equal(refused.leftBeforeRemoval, false);
    assert.equal(refused.notices[0]?.level, 'error');
    assert.match(refused.notices[0].text, /Another active workspace owner/);
    assert.equal(readFileSync(edit, 'utf8'), 'late owner edit');
    console.log('ok forced discard preserves a late session owner and its uncommitted edits');
  } finally {
    releaseGate();
    for (const { child } of workers) child.kill('SIGKILL');
    await Promise.all([...workers].map(({ closed }) => closed));
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') await worker();
else await main();
