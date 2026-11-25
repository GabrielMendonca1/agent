#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, chmod, writeFile, readFile, access } from 'node:fs/promises';
import { createWriteStream, constants } from 'node:fs';
import { finished } from 'node:stream/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, relative, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks, sets, version, defaultTrials } from './tasks.mjs';
import { check } from './checkers.mjs';
import { newStats, consume, redact } from './trace.mjs';
import { profileDir, readJobs, childTotals } from './children.mjs';
import { summarize, saveReport } from './report.mjs';

function options(args) {
  // trials: null means per task (defaultTrials); --trials N forces N for every task.
  const c = { models: ['anthropic/claude-opus-5-5'], modes: ['on', 'only'], trials: null, tasks: ['all'], out: resolve(`bench-${Date.now()}`), concurrency: 2, maxUsd: 5, dry: false, taskVersion: version };
  const names = { '--models': 'models', '--modes': 'modes', '--trials': 'trials', '--tasks': 'tasks', '--out': 'out', '--concurrency': 'concurrency', '--max-usd': 'maxUsd' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') { c.dry = true; continue; }
    const k = names[args[i]], v = args[++i];
    if (!k || !v || v.startsWith('--')) throw new Error('Usage: run.mjs --models a,b --modes on,only --trials N --tasks all|solo|orchestration|id,... --out dir --concurrency K --max-usd X [--dry]');
    c[k] = Array.isArray(c[k]) ? v.split(',') : k === 'out' ? resolve(v) : Number(v);
  }
  // Set names (solo, orchestration, all) expand to their ids; ids and sets may be mixed.
  c.tasks = [...new Set(c.tasks.flatMap(id => sets[id] ?? [id]))];
  if (c.trials !== null && (!Number.isSafeInteger(c.trials) || c.trials < 1)) throw new Error('Invalid trials');
  if (!Number.isSafeInteger(c.concurrency) || c.concurrency < 1) throw new Error('Invalid concurrency');
  if (!Number.isFinite(c.maxUsd) || c.maxUsd <= 0) throw new Error('Invalid budget');
  for (const k of ['models', 'modes', 'tasks']) if (!c[k].length || new Set(c[k]).size !== c[k].length || c[k].some(x => !x)) throw new Error(`Invalid ${k}`);
  if (c.modes.some(m => !['on', 'only'].includes(m)) || c.tasks.some(id => !tasks.some(t => t.id === id))) throw new Error('Unknown mode or task');
  return c;
}
async function fixture(task, parent = tmpdir(), allocated = () => {}) {
  const dir = await mkdtemp(join(parent, 'agent-bench-'));
  try {
    await allocated(dir);
    await task.fixture(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=bench@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture v' + version], { cwd: dir });
    return dir;
  } catch (error) {
    try {
      await rm(dir, { recursive: true, force: true });
      await allocated(null);
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], `Fixture initialization and cleanup failed: ${dir}`); }
    throw error;
  }
}
async function dry(config) {
  const results = [];
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  try {
    for (const task of tasks.filter(t => config.tasks.includes(t.id))) {
      if (interrupted) throw new Error('interrupted');
      const dir = await fixture(task);
      try {
        if (interrupted) throw new Error('interrupted');
        // A run with no subagent jobs must never count as delegated.
        if (task.delegation && !task.delegation([])) throw new Error(`${task.id}: delegation predicate accepts a run without jobs`);
        const before = await check(task, dir);
        const start = performance.now();
        await task.reference(dir);
        const after = await check(task, dir, { wallSeconds: (performance.now() - start) / 1000 });
        results.push({ task: task.id, untouchedFails: !before.pass, referencePasses: after.pass });
        console.log(`${task.id}: untouched ${before.pass ? 'BAD PASS' : 'fails'}, reference ${after.pass ? 'passes' : 'BAD FAIL'}`);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    if (interrupted) throw new Error('interrupted');
  } finally {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
  }
  if (results.some(r => !r.untouchedFails || !r.referencePasses)) throw new Error('Dry verification failed');
  console.log(`${results.length}/${results.length} checker pairs passed; no model requests`);
}
// AGENT_BIN, else the first executable `agent` on PATH.
async function agentBin(env = process.env) {
  const executable = path => access(path, constants.X_OK).then(() => true, () => false);
  if (env.AGENT_BIN) {
    if (await executable(env.AGENT_BIN)) return resolve(env.AGENT_BIN);
    throw new Error(`AGENT_BIN is not an executable file: ${env.AGENT_BIN}`);
  }
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) if (await executable(join(dir, 'agent'))) return join(dir, 'agent');
  throw new Error('agent binary not found: put `agent` on PATH or set AGENT_BIN=/path/to/agent');
}
// Session-scoped variables of a surrounding agent session must not leak into the measured run:
// AGENT_NO_DELEGATE would forbid every subagent and NODE_OPTIONS may point at a stale preload.
const INHERITED = ['AGENT_CHILD', 'AGENT_NO_DELEGATE', 'NODE_OPTIONS', 'AGENT_SKILLS_BEFORE', 'AGENT_RUNTIME_ENABLED', 'AGENT_PI_ROOT', 'AGENT_ARTIFACT',
  'AGENT_BASH_SANDBOX', 'AGENT_SANDBOX_CWD', 'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_CACHE_RETENTION'];
function runEnv(mode) {
  const env = { ...process.env, AGENT_CODEMODE_MODE: mode };
  for (const key of INHERITED) delete env[key];
  return env;
}
// What was measured: installed artifact and source commit (from the store), plus this checkout.
// Only these identifiers are read; nothing else from the store or profile reaches the report.
async function provenance(bin) {
  const store = process.env.AGENT_STORE || join(homedir(), '.local/share/agent');
  const field = async (file, key) => { try { const v = JSON.parse(await readFile(join(store, file), 'utf8'))[key]; return typeof v === 'string' ? v : null; } catch { return null; } };
  const git = (...args) => { try { return execFileSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const benchCommit = git('rev-parse', 'HEAD');
  return { agentBin: redact(bin), artifactId: await field('runtime/config.json', 'artifactId'), installedSourceCommit: await field('active.json', 'sourceCommit'),
    benchCommit, benchDirty: benchCommit ? git('status', '--porcelain', '--', '.') !== '' : null };
}
async function real(config) {
  const bin = await agentBin();
  const profile = profileDir();
  await mkdir(config.out, { recursive: true, mode: 0o700 });
  if ((await readdir(config.out)).length) throw new Error('Output directory must be empty (never overwrite a run)');
  await chmod(config.out, 0o700);
  await mkdir(join(config.out, 'traces'), { mode: 0o700 });
  await mkdir(join(config.out, 'fixtures'), { mode: 0o700 });
  // Parent sessions live in the run (the session id keys the child job records); never --no-session.
  await mkdir(join(config.out, 'sessions'), { mode: 0o700 });
  config.provenance = await provenance(bin);
  const selected = tasks.filter(t => config.tasks.includes(t.id));
  config.trialsByTask = Object.fromEntries(selected.map(t => [t.id, config.trials ?? defaultTrials(t)]));
  const jobs = [];
  const maxTrials = Math.max(...Object.values(config.trialsByTask));
  for (let trial = 1; trial <= maxTrials; trial++) for (const task of selected) if (trial <= config.trialsByTask[task.id]) for (const model of config.models) for (const mode of config.modes) jobs.push({ task, model, mode, trial });
  const runs = [], active = new Set();
  let spent = 0, stopReason = null, next = 0;
  let checkpoint = Promise.resolve();
  const save = () => {
    const report = summarize(config, [...runs].sort((a,b) => a.jsonlPath.localeCompare(b.jsonlPath)), stopReason);
    checkpoint = checkpoint.catch(() => {}).then(() => saveReport(config.out, report));
    return checkpoint;
  };
  function stop(reason) {
    stopReason ||= reason;
    for (const kill of active) kill();
  }
  const onInterrupt = () => stop('interrupted');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  async function run(job, index) {
    const { task, model, mode, trial } = job;
    const id = `${String(index + 1).padStart(3, '0')}-${task.id}-${mode}-t${trial}`;
    const jsonlPath = `traces/${id}.jsonl`;
    const stats = newStats();
    const start = performance.now();
    const record = { task: task.id, model, mode, trial, pass: false, ...stats,
      wallSeconds: 0, exit: { code: null, signal: null }, timedOut: false, jsonlPath,
      failure: 'fixture initialization failed', fixturePath: null };
    let trace, timer, kill, poller;
    // Child cost comes from the job records; refresh it while the run is live so the budget sees it.
    const refreshChildren = async () => {
      if (!stats.sessionId) return;
      const jobs = await readJobs(profile, stats.sessionId);
      const totals = childTotals(jobs);
      const previous = stats.costUsd;
      stats.children = totals; stats.childJobs = jobs;
      stats.costUsd = stats.parentCostUsd + totals.costUsd;
      spent += stats.costUsd - previous;
      if (spent >= config.maxUsd) stop('soft budget exhausted');
    };
    try {
      // Allocate directly in the report: failures never depend on a later move/copy.
      const dir = await fixture(task, join(config.out, 'fixtures'), async path => {
        record.fixturePath = path ? relative(config.out, path) : null;
        if (path) {
          runs.push(record);
          // Persist ownership before initialization or launch can fail.
          await save();
        }
      });
      if (stopReason) {
        record.failure = stopReason;
        await rm(dir, { recursive: true, force: true });
        record.fixturePath = null;
        return;
      }
      trace = createWriteStream(join(config.out, jsonlPath), { flags: 'wx', mode: 0o600 });
      // Observe errors before launch as well as during trace finalization.
      let traceError;
      const traceDone = finished(trace).catch(error => { traceError = error; kill?.(); });
      let buffer = '', stderr = '', timedOut = false, launchError = null;
      const child = spawn(bin, ['-p', '--mode', 'json', '--session-dir', join(config.out, 'sessions'), '--model', model, task.prompt], {
        cwd: dir, env: runEnv(mode), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      poller = setInterval(() => { refreshChildren().catch(() => {}); }, 5000);
      let killed = false;
      kill = () => {
        if (killed) return;
        killed = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000).unref();
      };
      active.add(kill);
      timer = setTimeout(() => { timedOut = true; kill(); }, task.timeoutSeconds * 1000);
      function line(value) {
        if (!value.trim()) return;
        // Preserve every event, but redact known credential patterns and local user names.
        trace.write(redact(value) + '\n');
        let event;
        try { event = JSON.parse(value); } catch { stats.malformedLines++; return; }
        const previous = stats.costUsd;
        consume(stats, event);
        spent += stats.costUsd - previous;
        if (stats.fatal) stop(stats.fatal);
        if (spent >= config.maxUsd) stop('soft budget exhausted');
      }
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + redact(chunk.toString())).slice(-12000); });
      child.on('error', e => { launchError = e.code || 'spawn failed'; });
      const exit = await new Promise(res => child.on('close', (code, signal) => res({ code, signal })));
      clearTimeout(timer); clearInterval(poller); active.delete(kill);
      if (buffer.trim()) line(buffer);
      await refreshChildren();
      trace.end(); await traceDone;
      if (traceError) throw traceError;
      const wallSeconds = (performance.now() - start) / 1000;
      if (stderr) await writeFile(join(config.out, `traces/${id}.stderr.log`), stderr, { mode: 0o600 });
      if (launchError || (!stats.requests && /credential|api.key|unauthorized|authentication|login|log in/i.test(stderr))) stop(launchError || 'credentials missing');
      if (!stats.requests) stop('pi emitted no assistant usage in fixture (see private trace)');
      if (!stats.sessionId) stop('no session header in --mode json output; child cost cannot be attributed');
      const verdict = await check(task, dir, { wallSeconds });
      // Orchestration tasks also require the delegation pattern they measure.
      stats.delegation = task.delegation ? task.delegation(stats.childJobs ?? []) : null;
      const pass = verdict.pass && !stats.delegation && exit.code === 0 && !timedOut && !killed && !stopReason && stats.requests > 0;
      Object.assign(record, stats, { pass, wallSeconds, exit, timedOut,
        failure: pass ? null : timedOut ? 'task timeout' : stopReason || (killed ? 'process stopped' : launchError || verdict.reason || (stats.delegation && `${task.id}: ${stats.delegation}`) || 'agent failed or no usage') });
      if (pass) {
        record.finalText = ''; // Only publish final assistant text for failures.
        await rm(dir, { recursive: true, force: true });
        record.fixturePath = null;
      }
      console.log(`${id}: ${pass ? 'PASS' : 'FAIL'} $${stats.costUsd.toFixed(3)} (parent $${stats.parentCostUsd.toFixed(3)}, children $${(stats.children?.costUsd ?? 0).toFixed(3)}${stats.children && !stats.children.complete ? ' incomplete' : ''}) ${stats.requests} requests ${wallSeconds.toFixed(1)}s; total $${spent.toFixed(3)}`);
      // A checkpoint keeps partial measurements if the next launch fails.
      await save();
    } catch (error) {
      Object.assign(record, stats, { pass: false, wallSeconds: (performance.now() - start) / 1000,
        failure: `harness error: ${redact(error.message).slice(0, 200)}` });
      throw error;
    } finally {
      clearTimeout(timer); clearInterval(poller);
      if (active.has(kill)) { active.delete(kill); kill(); }
      if (trace && !trace.destroyed) trace.destroy();
    }
  }
  try {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(config.concurrency, jobs.length) }, async () => {
      try {
        while (!stopReason && next < jobs.length) { const i = next++; await run(jobs[i], i); }
      } catch (e) { stop(`harness error: ${redact(e.message).slice(0, 200)}`); throw e; }
    }));
    const failure = workers.find(w => w.status === 'rejected');
    if (failure) throw failure.reason;
  }
  finally {
    try { await save(); }
    finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); }
  }
  console.log(`Report: ${config.out}/report.md; spent $${spent.toFixed(3)}${stopReason ? '; STOP: ' + stopReason : ''}`);
  if (stopReason) process.exitCode = 1;
}
try {
  const config = options(process.argv.slice(2));
  if (config.dry) await dry(config); else await real(config);
} catch (e) { console.error(redact(e.message)); process.exitCode = 1; }
