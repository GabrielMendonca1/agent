#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Swarm (item 5, part 1) on the real Pi with a fake provider, no network:
// /swarm gate (off by default, refusal, toggle without touching the system prompt),
// deferred `swarm` tool found via tool_search, and the writer <-> reviewer loop
// (isolated worktree, warm resumes on the same JSONL, stalled, caps, ambiguous verdict,
// project skill refused before any worktree).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.AGENT_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
const cli = join(piRoot, 'dist/cli.js');
assert.ok(existsSync(cli), 'pi installed');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-swarm-')));
const home = join(root, 'home');
const agent = join(home, '.pi/agent');
mkdirSync(join(agent, 'agents'), { recursive: true });
writeFileSync(join(agent, 'agents/worker.md'), '---\nname: worker\ndescription: fixture writer\ntools: read, edit, bash\nbrief_required: [objective, context, scope, done_when, stop_if]\n---\nfixture\n');
writeFileSync(join(agent, 'agents/reviewer.md'), '---\nname: reviewer\ndescription: fixture reviewer\ntools: read, bash\nbrief_required: [objective, context, scope]\n---\nfixture\n');
writeFileSync(join(agent, 'agents/mutator.md'), '---\nname: mutator\ndescription: fixture that edits\ntools: read, edit\n---\nfixture\n');
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], enableSkillCommands: false, defaultTools: ['+tool_search'], retry: { enabled: false }, quietStartup: true }));
writeFileSync(join(agent, 'auth.json'), '{}');

// Provider: the parent follows FG_SCRIPT (one step per assistant turn); the writer commits one
// file per turn (or nothing in FG_NOOP turns); the reviewer answers FG_VERDICTS in order.
const provider = join(root, 'provider.mjs');
writeFileSync(provider, `
import { AssistantMessageEventStream } from '${join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js').replace(/\\\\/g, '/')}';
import { appendFileSync } from 'node:fs';
const text = m => Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : String(m.content ?? '');
export default function (pi) {
  const stream = (model, context) => {
    const s = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      const n = context.messages.filter(m => m.role === 'assistant').length;
      // Tools arrive as system messages with toolsAdded; a tool loaded by tool_search appends one later.
      const tools = context.messages.filter(m => m.role === 'system').flatMap(m => (m.toolsAdded ?? []).map(t => t.name));
      const system = JSON.stringify(context.messages.find(m => m.role === 'system')?.sections ?? {});
            const last = context.messages.at(-1);
      let content, stopReason = 'stop';
      const cost = Number(process.env.FG_COST || 0);
      if (!process.env.AGENT_CHILD) {
        if (process.env.FG_DUMP) appendFileSync(process.env.FG_DUMP, JSON.stringify({ n, tools, system, messages: context.messages.map(m => [m.role, text(m)]) }) + '\\n');
        const script = JSON.parse(process.env.FG_SCRIPT || '[]');
        const step = script[n];
        const all = context.messages.map(text).join('\\n');
        const job = /Launched swarm loop job (\\S+),/.exec(all)?.[1] ?? '';
        if (step?.tool) {
          content = [{ type: 'toolCall', id: 'call-' + n, name: step.tool, arguments: JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('$JOB', job)) }];
          stopReason = 'toolUse';
        } else content = [{ type: 'text', text: step?.text ?? 'PARENT-DONE' }];
      } else {
        const role = tools.includes('edit') ? 'writer' : 'reviewer';
        const turn = context.messages.filter(m => m.role === 'user').length;
        const session = process.argv[process.argv.indexOf('--session') + 1];
        if (process.env.FG_LOG && last.role === 'user') appendFileSync(process.env.FG_LOG, JSON.stringify({ role, turn, cwd: process.cwd(), session, prompt: text(last) }) + '\\n');
        if (role === 'writer') {
          const noop = (process.env.FG_NOOP || '').split(',').includes(String(turn));
          if (last.role === 'user' && !noop) {
            content = [{ type: 'toolCall', id: 'w-' + turn, name: 'bash', arguments: { command: 'f=swarm-' + turn + '-' + process.pid + '.txt; printf r' + turn + ' > $f && git add $f && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm swarm-round-' + turn } }];
            stopReason = 'toolUse';
          } else content = [{ type: 'text', text: 'WRITER-DONE-' + turn }];
        } else {
          const verdicts = (process.env.FG_VERDICTS || 'APPROVE').split(',');
          const v = verdicts[Math.min(turn, verdicts.length) - 1];
          content = [{ type: 'text', text: v === 'NONE' ? 'swarm-1.txt:1 looks fine I guess' : 'swarm-' + turn + '.txt:1 finding-' + turn + '\\n**VERDICT: ' + v + '**' }];
        }
      }
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: process.env.AGENT_CHILD ? cost : 0 } } };
      s.push({ type: 'start', partial: message });
      s.push({ type: 'done', reason: stopReason, message }); s.end();
    });
    return s;
  };
  pi.registerProvider('fg-fake', { api: 'fg-fake', apiKey: 'offline', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'fake', name: 'fake', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }], stream, streamSimple: stream });
}
`);

const work = join(root, 'work');
mkdirSync(work);
const git = (...args) => {
  const r = spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
git('init', '-q', '-b', 'main');
writeFileSync(join(work, 'README.md'), 'fixture\n');
git('add', '.');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init');

let runIndex = 0;
const env = (extra) => ({ ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_DURABLE_HOST: '0',
  AGENT_RUNTIME_ENABLED: '1', AGENT_PI_ROOT: piRoot, AGENT_CHECKPOINTS: '0', NODE_OPTIONS: '', AGENT_SUBAGENT_CHILD_EXTENSIONS: provider, ...extra });
function runPi(extra, { session = join(root, `parent-${++runIndex}.jsonl`), prompts = ['go'] } = {}) {
  const r = spawnSync(process.execPath, [cli, '-p', '--mode', 'json', '--session', session, '--no-extensions', '-e', 'builtin:tool-search', '-e', provider,
    '-e', join(repo, 'agent/extensions/brain-live/subagent/index.ts'), '--model', 'fg-fake/fake', ...prompts],
  { cwd: work, env: env(extra), encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const toolResults = (events, name) => events.filter(e => e.type === 'tool_execution_end' && e.toolName === name).map(e => e.result);
const resultText = (r) => r.content.map(p => p.text || '').join('');
const jobsDir = join(agent, 'subagent-jobs');
const readJob = (jobId) => JSON.parse(readFileSync(join(jobsDir, readdirSync(jobsDir, { recursive: true }).find(p => p.endsWith(`${jobId}.json`))), 'utf8'));
const readLog = (file) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const brief = { objective: 'add a swarm file', context: `repo ${work}`, scope: 'swarm-*.txt only', done_when: 'file committed', stop_if: 'anything else is needed' };
const search = { tool: 'tool_search', args: { query: 'swarm loop writer reviewer' } };
const swarmCall = (args = {}) => ({ tool: 'swarm', args: { mode: 'loop', writer: { brief }, ...args } });
const worktreesDir = join(agent, 'agent/worktrees');
const worktreeCount = () => existsSync(worktreesDir) ? readdirSync(worktreesDir).length : 0;

/** Launch one swarm loop and return the launch result, final record, delivered message and child log. */
function loop(name, extra, args) {
  const log = join(root, `${name}.log`);
  const events = runPi({ AGENT_SWARM: '1', FG_LOG: log, FG_SCRIPT: JSON.stringify([search, swarmCall(args), { text: 'waiting' }]), ...extra });
  const [launch] = toolResults(events, 'swarm');
  assert.ok(launch && !launch.isError, `${name}: ${launch && resultText(launch)}`);
  const jobId = /Launched swarm loop job (\S+),/.exec(resultText(launch))[1];
  const delivered = events.filter(e => e.type === 'message_end' && e.message.role === 'custom' && e.message.customType === 'subagent-result').map(e => e.message);
  assert.equal(delivered.length, 1, `${name}: one subagent-result`);
  return { events, launch, jobId, record: readJob(jobId), message: delivered[0], log: readLog(log) };
}

try {
  // 1. Gate: off by default; the tool is not in the first request and tool_search finds it; the call is refused.
  {
    const dump = join(root, 'gate.dump');
    const events = runPi({ FG_DUMP: dump, FG_SCRIPT: JSON.stringify([search, swarmCall()]) });
    const requests = readLog(dump);
    assert.ok(requests[0].tools.includes('subagent') && requests[0].tools.includes('tool_search'), `first request tools: ${requests[0].tools}`);
    assert.ok(!requests[0].tools.includes('swarm'), 'swarm absent from the initial schema');
    assert.doesNotMatch(requests[0].system.replaceAll(root, ''), /\bswarm\b/i, 'swarm absent from the system prompt');
    assert.match(requests[1].messages.filter(([role]) => role === 'toolResult').at(-1)[1], /Loaded 1 tool.*- swarm: /s, 'tool_search returns swarm');
    assert.ok(requests[1].tools.includes('swarm'), `swarm declared after tool_search: ${requests[1].tools}`);
    const [refused] = toolResults(events, 'swarm');
    assert.equal(refused.isError, true);
    assert.equal(resultText(refused), 'Swarm is off in this session. Ask the user to enable it with /swarm.');
    assert.equal(worktreeCount(), 0);
    console.log('ok gate: off by default, swarm deferred (absent from first request), found via tool_search, refused');
  }

  // 2. /swarm toggles session state; the system prompt and tools stay byte-identical.
  {
    const session = join(root, 'toggle.jsonl');
    const dump = join(root, 'toggle.dump');
    // -p takes several messages: the command runs first, then one model turn persists the session.
    runPi({ FG_DUMP: dump, FG_SCRIPT: JSON.stringify([{ text: 'on' }]) }, { session, prompts: ['/swarm on', 'go'] });
    const entries = () => readFileSync(session, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(entries().filter(e => e.type === 'custom' && e.customType === 'agent-swarm').map(e => e.data), [{ enabled: true }]);
    const hidden = entries().filter(e => e.type === 'custom_message' && e.customType === 'agent-swarm-mode');
    assert.equal(hidden.length, 1, 'one hidden playbook message');
    assert.equal(hidden[0].display, false);
    assert.match(hidden[0].content, /tool_search/);
    // A new process restores "on" from the session; /swarm toggles it off and the call is refused.
    const offEvents = runPi({ FG_DUMP: dump, FG_SCRIPT: JSON.stringify([null, search, swarmCall()]) }, { session, prompts: ['/swarm', 'go'] });
    assert.deepEqual(entries().filter(e => e.type === 'custom' && e.customType === 'agent-swarm').map(e => e.data), [{ enabled: true }, { enabled: false }]);
    assert.match(resultText(toolResults(offEvents, 'swarm')[0]), /^Swarm is off in this session/);
    const [onReq, offReq] = readLog(dump);
    assert.equal(onReq.system, offReq.system, 'system prompt unchanged by /swarm');
    assert.deepEqual(onReq.tools, offReq.tools, 'tool list unchanged by /swarm');
    assert.ok(onReq.messages.some(([, t]) => /Swarm mode is active/.test(t)), 'playbook reaches the model as an appended message');
    console.log('ok /swarm: toggles via agent-swarm entries + hidden message; system prompt and tools unchanged');
  }

  // 3. Round 1 APPROVE in an isolated worktree; reviewer reads the worktree; integrate merges.
  {
    const log = join(root, 'approve.log');
    const events = runPi({ AGENT_SWARM: '1', FG_LOG: log, FG_SCRIPT: JSON.stringify([search, swarmCall(), { text: 'waiting' },
      { tool: 'subagent', args: { action: 'integrate', jobId: '$JOB' } }, { text: 'merged' }]) });
    const [launch] = toolResults(events, 'swarm');
    assert.ok(!launch.isError, resultText(launch));
    const jobId = /Launched swarm loop job (\S+),/.exec(resultText(launch))[1];
    const record = readJob(jobId);
    assert.equal(record.mode, 'swarm');
    assert.equal(record.status, 'completed', record.error);
    assert.equal(record.swarm.outcome, 'approved');
    assert.equal(record.swarm.rounds.length, 1);
    const [writer, reviewer] = record.tasks;
    assert.ok(writer.worktree && readdirSync(work).some(f => /^swarm-1-\d+\.txt$/.test(f)), 'integrate merged the writer branch');
    const turns = readLog(log);
    assert.equal(turns.find(t => t.role === 'writer').cwd, writer.worktree, 'writer runs in its worktree');
    assert.equal(turns.find(t => t.role === 'reviewer').cwd, turns.find(t => t.role === 'writer').cwd, 'reviewer cwd = writer worktree');
    assert.notEqual(turns.find(t => t.role === 'reviewer').cwd, work);
    assert.match(turns.find(t => t.role === 'reviewer').prompt, /VERDICT: APPROVE/);
    assert.match(turns.find(t => t.role === 'reviewer').prompt, new RegExp(`Range: ${record.swarm.baseSha.slice(0, 12)}\\.\\.`));
    const delivered = events.find(e => e.type === 'message_end' && e.message.customType === 'subagent-result').message;
    assert.match(delivered.content, /swarm loop · outcome: approved · rounds: 1\/3 · cost: \$0\.00/);
    assert.match(delivered.content, /\| 1 \| [0-9a-f]{12} \| .* \| APPROVE \| \$0\.00 \|/);
    assert.match(delivered.content, /handles: writer worker-\d+, reviewer reviewer-\d+/);
    assert.match(delivered.content, /### isolated task 1/);
    const integrate = toolResults(events, 'subagent').at(-1);
    assert.ok(!integrate.isError, resultText(integrate));
    assert.match(resultText(integrate), /Task 1: integrate complete/);
    assert.equal(reviewer.worktree, undefined, 'only the writer owns a worktree');
    console.log('ok loop approve: isolated writer, reviewer in the same worktree, compact result, integrate merges');
  }

  // 4. REQUEST_CHANGES -> round 2 resumes both sessions with delta-only prompts -> APPROVE.
  {
    const { record, message, log } = loop('rounds', { FG_VERDICTS: 'REQUEST_CHANGES,APPROVE' });
    assert.equal(record.swarm.outcome, 'approved', record.error);
    assert.equal(record.swarm.rounds.length, 2);
    const writers = log.filter(t => t.role === 'writer');
    const reviewers = log.filter(t => t.role === 'reviewer');
    assert.equal(writers.length, 2);
    assert.equal(reviewers.length, 2);
    assert.equal(writers[0].session, writers[1].session, 'writer resumes its own JSONL');
    assert.equal(reviewers[0].session, reviewers[1].session, 'reviewer resumes its own JSONL');
    assert.notEqual(writers[0].session, reviewers[0].session);
    assert.equal(writers[1].turn, 2);
    assert.equal(reviewers[1].turn, 2);
    assert.match(writers[1].prompt, /round 2\/3/);
    assert.match(writers[1].prompt, /finding-1/);
    assert.doesNotMatch(writers[1].prompt, /## Objective/, 'writer round 2 gets only the findings');
    assert.match(reviewers[1].prompt, /round 2\/3/);
    assert.doesNotMatch(reviewers[1].prompt, /## Objective/, 'reviewer round 2 gets only the delta');
    assert.match(reviewers[1].prompt, /VERDICT: APPROVE/);
    assert.match(message.content, /outcome: approved · rounds: 2\/3/);
    assert.match(message.content, /\| 1 \| .* \| REQUEST_CHANGES \|/);
    const registry = JSON.parse(readFileSync(join(jobsDir, record.sessionId, 'handles', 'registry.json'), 'utf8'));
    for (const task of record.tasks) assert.equal(registry.handles[task.handle].lifecycle, 'waiting', `${task.handle} waits`);
    console.log('ok loop rounds: REQUEST_CHANGES then APPROVE, writer and reviewer resume the same --session JSONL');
  }

  // 5. Stagnation: the writer changes nothing -> stalled, reviewer never runs.
  {
    const { record, log } = loop('stalled', { FG_NOOP: '1' });
    assert.equal(record.swarm.outcome, 'stalled');
    assert.equal(record.status, 'failed');
    assert.equal(log.filter(t => t.role === 'reviewer').length, 0, 'no reviewer turn');
    console.log('ok stalled: writer without changes ends the loop before review');
  }

  // 6. Caps: maxRounds and maxUsd.
  {
    const rounds = loop('max-rounds', { FG_VERDICTS: 'REQUEST_CHANGES' }, { maxRounds: 2 });
    assert.equal(rounds.record.swarm.outcome, 'max_rounds');
    assert.equal(rounds.record.swarm.rounds.length, 2);
    assert.match(rounds.message.content, /outcome: max_rounds · rounds: 2\/2/);
    const usd = loop('max-usd', { FG_VERDICTS: 'REQUEST_CHANGES', FG_COST: '0.2' }, { maxUsd: 0.5 });
    assert.equal(usd.record.swarm.outcome, 'max_usd');
    assert.equal(usd.record.swarm.rounds.length, 1, 'round 2 never starts over budget');
    assert.ok(usd.record.swarm.spentUsd >= 0.5, `spent ${usd.record.swarm.spentUsd}`);
    assert.match(usd.message.content, /outcome: max_usd · rounds: 1\/3 · cost: \$0\.60/);
    console.log('ok caps: max_rounds and max_usd stop the loop');
  }

  // 7. Ambiguous verdict: no VERDICT line never approves.
  {
    const { record } = loop('ambiguous', { FG_VERDICTS: 'NONE' });
    assert.equal(record.swarm.outcome, 'ambiguous');
    assert.equal(record.swarm.rounds[0].verdict, 'none');
    console.log('ok ambiguous: a reply without VERDICT is not approval');
  }

  // 8. Isolated writer with a project skill fails at launch, before any job or worktree.
  {
    mkdirSync(join(work, '.pi/skills/local'), { recursive: true });
    writeFileSync(join(work, '.pi/skills/local/SKILL.md'), '---\nname: local\ndescription: project fixture\n---\nbody\n');
    const before = worktreeCount();
    const events = runPi({ AGENT_SWARM: '1', FG_SCRIPT: JSON.stringify([search, swarmCall({ writer: { brief, skills: ['local'] } })]) });
    const [refused] = toolResults(events, 'swarm');
    assert.equal(refused.isError, true, resultText(refused));
    assert.match(resultText(refused), /project skill.*Nothing was launched/s);
    assert.equal(worktreeCount(), before, 'no worktree created');
    rmSync(join(work, '.pi'), { recursive: true, force: true });
    console.log('ok project skill: isolated writer refused at launch, no worktree');
  }

  // 9. Role checks: a writer reviewer is refused before launch.
  {
    const events = runPi({ AGENT_SWARM: '1', FG_SCRIPT: JSON.stringify([search, swarmCall({ reviewer: { agent: 'mutator' } })]) });
    assert.match(resultText(toolResults(events, 'swarm')[0]), /Reviewer mutator must be read-only/);
    console.log('ok roles: reviewer with edit refused');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
