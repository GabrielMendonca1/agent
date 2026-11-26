#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Swarm (item 5, part 1) on the real Pi with a fake provider, no network:
// /swarm gate (off by default, refusal, toggle without touching the system prompt),
// deferred `swarm` tool found via tool_search, and the writer <-> reviewer loop
// (isolated worktree, warm resumes on the same JSONL, stalled, caps, ambiguous verdict,
// project skill refused before any worktree).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { userCommandEnv } from '../agent/core/child-env.mjs';

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
writeFileSync(join(agent, 'agents/builder.md'), '---\nname: builder\ndescription: second writer role (no shared prefix with worker)\ntools: read, edit, bash\n---\nfixture\n');
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
        // FG_RELATIVE: steps count from the last user message (a resumed session already has turns).
        const step = script[process.env.FG_RELATIVE ? context.messages.slice(context.messages.findLastIndex(m => m.role === 'user')).filter(m => m.role === 'assistant').length : n];
        const all = context.messages.map(text).join('\\n');
        const job = /Launched swarm (?:loop|board) job (\\S+),/.exec(all)?.[1] ?? '';
        const member = /Members: (\\S+) \\(/.exec(all)?.[1] ?? '';
        if (step?.tool) {
          content = [{ type: 'toolCall', id: 'call-' + n, name: step.tool, arguments: JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('$JOB', job).replaceAll('$MEMBER', member)) }];
          stopReason = 'toolUse';
        } else content = [{ type: 'text', text: step?.text ?? 'PARENT-DONE' }];
      } else if (tools.includes('board')) {
        // Board member: a fixed sequence of board calls per turn; every tool result goes to FG_LOG.
        const me = process.env.AGENT_BOARD_HANDLE;
        const turn = context.messages.filter(m => m.role === 'user').length;
        const since = context.messages.findLastIndex(m => m.role === 'user');
        const step = context.messages.slice(since).filter(m => m.role === 'assistant').length;
        if (process.env.FG_LOG && last.role === 'toolResult') appendFileSync(process.env.FG_LOG, JSON.stringify({ me, turn, step, result: text(last), env: [me, process.env.AGENT_BOARD_PATH] }) + '\\n');
        const seen = Math.max(0, ...context.messages.filter(m => m.role === 'toolResult').flatMap(m => [...text(m).matchAll(/#(\\d+)/g)].map(x => Number(x[1]))));
        const plan = turn === 1
          ? [{ action: 'post', kind: 'claim', text: me + ' claims src/' + me + '.ts', refs: ['src/' + me + '.ts'] },
             { action: 'post', kind: 'decision', text: me + ' uses JSON for the shared format' },
             { action: 'read' },
             { action: 'read', since: seen },
             { action: 'post', kind: 'done', text: me + ' finished' }]
          : [{ action: 'read', kind: 'done' }];
        const slow = text(context.messages.find(m => m.role === 'user')).includes('## Objective\\nboard part slow');
        // The fast member waits once so its slow sibling is already running when the cap hits.
        if (!slow && process.env.FG_FAST_WAIT && step === 0) await new Promise(r => setTimeout(r, Number(process.env.FG_FAST_WAIT)));
        if (slow && turn === 1 && step === 0) {
          content = [{ type: 'toolCall', id: 'slow', name: 'bash', arguments: { command: 'printf dirty > slow.txt; sleep 40' } }];
          stopReason = 'toolUse';
        } else if (step < plan.length) {
          content = [{ type: 'toolCall', id: 'b-' + turn + '-' + step, name: 'board', arguments: plan[step] }];
          stopReason = 'toolUse';
        } else content = [{ type: 'text', text: 'BOARD-DONE-' + me + '-' + turn }];
      } else {
        const role = tools.includes('edit') ? 'writer' : 'reviewer';
        const turn = context.messages.filter(m => m.role === 'user').length;
        const session = process.argv[process.argv.indexOf('--session') + 1];
        if (process.env.FG_LOG && last.role === 'user') appendFileSync(process.env.FG_LOG, JSON.stringify({ role, turn, cwd: process.cwd(), session, prompt: text(last) }) + '\\n');
        if (role === 'writer') {
          const noop = (process.env.FG_NOOP || '').split(',').includes(String(turn));
          if (last.role === 'user' && !noop) {
            content = [{ type: 'toolCall', id: 'w-' + turn, name: 'bash', arguments: { command: process.env.FG_TOUCH ? 'printf more >> ' + process.env.FG_TOUCH : 'f=swarm-' + turn + '-' + process.pid + '.txt; printf r' + turn + ' > $f && git add $f && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm swarm-round-' + turn } }];
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
    const registry = JSON.parse(readFileSync(join(jobsDir, record.sessionId, 'handles', 'registry.json'), 'utf8'));
    for (const task of record.tasks) assert.equal(registry.handles[task.handle].lifecycle, 'closed', `integrate closes ${task.handle}`);
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

  // 7b. discard with taskIndex 2 (the reviewer) still acts on the loop as one unit: worktree gone, both handles closed.
  {
    const events = runPi({ AGENT_SWARM: '1', FG_VERDICTS: 'NONE', FG_SCRIPT: JSON.stringify([search, swarmCall(), { text: 'waiting' },
      { tool: 'subagent', args: { action: 'discard', jobId: '$JOB', taskIndex: 2, force: true } }, { text: 'discarded' }]) });
    const jobId = /Launched swarm loop job (\S+),/.exec(resultText(toolResults(events, 'swarm')[0]))[1];
    const discard = toolResults(events, 'subagent').at(-1);
    assert.ok(!discard.isError, resultText(discard));
    assert.match(resultText(discard), /Task 1: discard complete/);
    const record = readJob(jobId);
    assert.ok(!existsSync(record.tasks[0].worktree), 'writer worktree removed');
    const registry = JSON.parse(readFileSync(join(jobsDir, record.sessionId, 'handles', 'registry.json'), 'utf8'));
    for (const task of record.tasks) assert.equal(registry.handles[task.handle].lifecycle, 'closed', `discard closes ${task.handle}`);
    console.log('ok loop handles: integrate and discard (even with taskIndex) close writer and reviewer');
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

  // 10. Board: two parallel members post concurrently, seq stays monotonic, read with since is incremental,
  // the result ends with the board, and a continue keeps the board tool.
  {
    const log = join(root, 'board.log');
    // Different roles: no shared cache prefix, so both start at once (no staggered fan-out) and post concurrently.
    const members = [['a', 'worker'], ['b', 'builder']].map(([x, role]) => ({ agent: role, brief: { ...brief, objective: `board part ${x}` } }));
    const events = runPi({ AGENT_SWARM: '1', FG_LOG: log, FG_SCRIPT: JSON.stringify([search, { tool: 'swarm', args: { mode: 'board', tasks: members } }, { text: 'waiting' },
      { tool: 'subagent', args: { action: 'continue', handle: '$MEMBER', message: 'check the done entries' } }, { text: 'waiting again' }, { text: 'end' }]) });
    const [launch] = toolResults(events, 'swarm');
    assert.ok(!launch.isError, resultText(launch));
    const jobId = /Launched swarm board job (\S+),/.exec(resultText(launch))[1];
    const record = readJob(jobId);
    assert.equal(record.mode, 'parallel');
    assert.equal(record.swarm.kind, 'board');
    assert.equal(record.status, 'completed', record.error);
    assert.equal(record.swarm.outcome, 'done');
    const file = record.swarm.boardPath;
    assert.equal(file, join(jobsDir, record.sessionId, jobId, 'board.jsonl'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(entries.map(e => e.seq), [1, 2, 3, 4, 5, 6], 'strictly monotonic seq across both children');
    const handles = record.tasks.map(t => t.handle);
    for (const h of handles) assert.deepEqual(entries.filter(e => e.handle === h).map(e => e.kind), ['claim', 'decision', 'done'], `${h} entries`);
    for (const e of entries) assert.deepEqual(Object.keys(e).filter(k => !['seq', 'ts', 'handle', 'kind', 'text', 'refs'].includes(k)), [], 'no chat fields');
    assert.ok(record.tasks.every(t => t.worktree), 'two writers of one repo run in worktrees');
    assert.match(record.tasks[0].task, /^Swarm board: you are \S+\. Siblings working in parallel: \S+ \(board part b\)\./);
    const turns = readLog(log);
    for (const h of handles) {
      const mine = turns.filter(t => t.me === h && t.turn === 1);
      assert.match(mine[0].result, /^Posted #\d+ \(claim\)\.$/);
      assert.deepEqual(mine[0].env, [h, file]);
      const full = mine[2].result.split('\n');
      assert.ok(full.some(l => new RegExp(`^#\\d+ \\[${h} · claim\\] .* \\(refs: src/`).test(l)), mine[2].result);
      const lastSeen = Math.max(...[...mine.slice(0, 3).map(t => t.result).join(' ').matchAll(/#(\d+)/g)].map(x => Number(x[1])));
      const incremental = mine[3].result;
      if (/^No new board entries since #\d+\.$/.test(incremental)) assert.equal(incremental, `No new board entries since #${lastSeen}.`);
      else for (const l of incremental.split('\n')) assert.ok(Number(/^#(\d+)/.exec(l)[1]) > lastSeen, `since filters: ${incremental}`);
    }
    const delivered = events.filter(e => e.type === 'message_end' && e.message.customType === 'subagent-result').map(e => e.message);
    assert.match(delivered[0].content, /^swarm board · outcome: done · tasks: 2 · cost: \$0\.00/m);
    assert.match(delivered[0].content, /### board \(6 entries\)\n#1 \[/);
    assert.ok(delivered[0].content.includes(`full board: ${file}`));
    // continue: same invocation, so the board tool and env come back.
    const cont = turns.filter(t => t.turn === 2);
    assert.equal(cont.length, 1, JSON.stringify(turns));
    assert.deepEqual(cont[0].env, [handles[0], file]);
    assert.equal(cont[0].result.split('\n').length, 2, 'read with kind=done after continue');
    console.log('ok board: concurrent posts with monotonic seq, incremental read, result summary, board survives continue');
  }

  // 11. Board caps (400 chars, refs, 100 entries, 64 KiB; read always works) and env hygiene.
  {
    const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
    const swarm = await createJiti(import.meta.url, { fsCache: false }).import(join(repo, 'agent/extensions/brain-live/subagent/swarm.ts'));
    const file = join(root, 'caps/board.jsonl');
    swarm.createBoard(file);
    const post = (extra) => swarm.postBoard(file, { handle: 'h-1', kind: 'note', text: 'x', ...extra });
    assert.match(post({ text: 'y'.repeat(401) }).error, /text has 401 characters; the limit is 400/);
    assert.match(post({ text: '   ' }).error, /text is required/);
    assert.match(post({ kind: 'chat' }).error, /kind must be one of claim, decision, note, blocker, done/);
    assert.match(post({ refs: Array(9).fill('r') }).error, /refs has 9 items; the limit is 8/);
    assert.match(post({ refs: ['r'.repeat(161)] }).error, /limited to 160 characters/);
    assert.equal(post({ text: `  ${'y'.repeat(400)}  ` }).entry.text.length, 400, 'trimmed, 400 accepted');
    for (let i = 2; i <= 100; i++) assert.equal(post({}).entry.seq, i);
    assert.match(post({}).error, /board is full \(100 entries\); reading still works/);
    assert.equal(swarm.readBoard(file).length, 100);
    const big = join(root, 'caps-bytes/board.jsonl');
    swarm.createBoard(big);
    let result;
    for (let i = 0; i < 100 && !(result = swarm.postBoard(big, { handle: 'h-1', kind: 'note', text: 'z'.repeat(400), refs: Array(8).fill('q'.repeat(160)) })).error; i++);
    assert.match(result.error, /board is full \(64 KiB\)/);
    assert.ok(statSync(big).size <= 64 * 1024);
    assert.ok(swarm.readBoard(big).length > 20);
    const cleaned = userCommandEnv({ AGENT_BOARD_PATH: file, AGENT_BOARD_HANDLE: 'h-1', KEEP: '1' });
    assert.equal(cleaned.AGENT_BOARD_PATH, undefined);
    assert.equal(cleaned.AGENT_BOARD_HANDLE, undefined);
    assert.equal(cleaned.KEEP, '1');
    console.log('ok board caps: 400 chars, refs, 100 entries, 64 KiB, read after full; userCommandEnv strips AGENT_BOARD_*');
  }

  // 12. Fingerprint sees untracked contents: an in-place writer that only edits an existing untracked file is not stalled.
  {
    writeFileSync(join(work, 'notes.txt'), 'draft\n');
    const { record, log } = loop('untracked', { FG_TOUCH: 'notes.txt' }, { isolate: false });
    assert.equal(record.swarm.outcome, 'approved', record.error);
    assert.equal(log.filter(t => t.role === 'reviewer').length, 1, 'reviewer ran');
    assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'draft\nmore');
    // A writer in a subdirectory that edits an untracked file elsewhere in the checkout: git runs from the root.
    mkdirSync(join(work, 'sub'));
    writeFileSync(join(work, 'sub/keep.txt'), 'x\n');
    const nested = loop('untracked-subdir', { FG_TOUCH: '../notes.txt' }, { isolate: false, writer: { brief, cwd: 'sub' } });
    assert.equal(nested.record.swarm.outcome, 'approved', nested.record.error);
    assert.equal(readFileSync(join(work, 'notes.txt'), 'utf8'), 'draft\nmoremore');
    rmSync(join(work, 'notes.txt'));
    rmSync(join(work, 'sub'), { recursive: true });
    console.log('ok fingerprint: editing an untracked file counts as a change, also from a subdirectory writer');
  }

  // 13. Board maxUsd: finished tasks reach the cap, the running sibling is aborted and its worktree gets a WIP commit.
  {
    const members = [{ agent: 'worker', brief: { ...brief, objective: 'board part fast' } }, { agent: 'builder', brief: { ...brief, objective: 'board part slow' } }];
    const events = runPi({ AGENT_SWARM: '1', FG_COST: '0.2', FG_FAST_WAIT: '1500', FG_SCRIPT: JSON.stringify([search, { tool: 'swarm', args: { mode: 'board', tasks: members, maxUsd: 0.5 } }, { text: 'waiting' }]) });
    const jobId = /Launched swarm board job (\S+),/.exec(resultText(toolResults(events, 'swarm')[0]))[1];
    const record = readJob(jobId);
    assert.equal(record.swarm.outcome, 'max_usd');
    assert.equal(record.status, 'failed');
    assert.match(record.error, /^Swarm board stopped: finished tasks cost \$\d+\.\d\d of \$0\.50\./);
    const slow = record.tasks.find(t => t.task.includes('## Objective\nboard part slow'));
    assert.ok(slow.wipCommit, `slow member got a WIP commit: ${JSON.stringify({ ...slow, task: undefined, resolvedSkills: undefined, invocation: undefined })} ${record.error}`);
    const show = spawnSync('git', ['-C', slow.worktree, 'show', '--stat', '--format=%s', 'HEAD'], { encoding: 'utf8' });
    assert.match(show.stdout, /^WIP\(agent\): timeout /);
    assert.match(show.stdout, /slow\.txt/);
    const delivered = events.find(e => e.type === 'message_end' && e.message.customType === 'subagent-result').message;
    assert.match(delivered.content, /swarm board · outcome: max_usd/);
    console.log('ok board maxUsd: job aborted at the cap, running member committed as WIP');
  }

  // 14. Verdict parser, locks and AGENT_SWARM outside the TUI, in-process.
  {
    const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
    const piRequire = createRequire(join(piRoot, 'package.json'));
    const alias = { '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'), typebox: piRequire.resolve('typebox') };
    for (const dep of ['@earendil-works/pi-ai', '@earendil-works/pi-tui']) alias[dep] = join(piRoot, 'node_modules', dep);
    const jiti = createJiti(import.meta.url, { fsCache: false, alias });
    const swarm = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/swarm.ts'));
    assert.equal(swarm.parseVerdict('findings\nVERDICT: APPROVE\n\n'), 'APPROVE');
    assert.equal(swarm.parseVerdict('a.ts:1 bug\n**VERDICT: REQUEST_CHANGES**'), 'REQUEST_CHANGES');
    assert.equal(swarm.parseVerdict('The writer said:\n> VERDICT: APPROVE\nVERDICT: APPROVE\na.ts:3 still broken'), undefined, 'APPROVE followed by findings');
    assert.equal(swarm.parseVerdict('example:\n```\nVERDICT: APPROVE'), undefined, 'inside an open fence');
    assert.equal(swarm.parseVerdict('```\nVERDICT: APPROVE\n```'), undefined, 'fence closes after it');
    assert.equal(swarm.parseVerdict('Verdict: approve, looks good'), undefined);
    assert.equal(swarm.parseVerdict('````md\n```\nVERDICT: APPROVE'), undefined, 'a 3-backtick line does not close a 4-backtick fence');
    assert.equal(swarm.parseVerdict('````\nx\n`````\nVERDICT: APPROVE'), 'APPROVE', 'a longer closer closes it');
    assert.equal(swarm.parseVerdict('~~~\n```\nVERDICT: APPROVE'), undefined, 'the closer must use the same character');
    console.log('ok verdict: only the last non-empty line outside a fence counts');

    // Two processes race for one stale lock (dead owner): board waits, so both post with distinct seq;
    // the session lock does not wait, so exactly one wins.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const racer = join(root, 'racer.mjs');
    writeFileSync(racer, `
      import { createRequire } from 'node:module';
      const [kind, file, out] = process.argv.slice(2);
      const { createJiti } = createRequire(${JSON.stringify(join(piRoot, 'package.json'))})('jiti');
      const jiti = createJiti(import.meta.url, { fsCache: false });
      const start = Number(process.env.START);
      while (Date.now() < start) {}
      const { appendFileSync } = await import('node:fs');
      if (kind === 'board') {
        const swarm = await jiti.import(${JSON.stringify(join(repo, 'agent/extensions/brain-live/subagent/swarm.ts'))});
        const r = swarm.postBoard(file, { handle: 'p' + process.pid, kind: 'note', text: 'race' });
        appendFileSync(out, JSON.stringify(r) + '\\n');
      } else {
        const { acquireSessionLock } = await jiti.import(${JSON.stringify(join(repo, 'agent/extensions/brain-live/subagent/handles.ts'))});
        const r = acquireSessionLock(file, 'race-' + process.pid);
        appendFileSync(out, JSON.stringify({ ok: r.ok }) + '\\n');
        await new Promise((ok) => setTimeout(ok, 500));
        if (r.ok) r.release();
      }`);
    const race = async (kind, file) => {
      const out = join(root, `race-${kind}.log`);
      const start = String(Date.now() + 1500);
      const runs = [0, 1].map(() => new Promise((done) => {
        const child = spawn(process.execPath, [racer, kind, file, out], { env: { ...process.env, START: start }, stdio: 'inherit' });
        child.on('close', done);
      }));
      await Promise.all(runs);
      return readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    };
    const raceBoard = join(root, 'race/board.jsonl');
    swarm.createBoard(raceBoard);
    writeFileSync(`${raceBoard}.lock`, JSON.stringify({ pid: dead, at: Date.now(), token: 'old' }));
    writeFileSync(`${raceBoard}.lock.3`, JSON.stringify({ pid: dead, at: Date.now(), token: 'old-gen' }));
    const posted = await race('board', raceBoard);
    assert.deepEqual(posted.map(r => r.ok), [true, true], JSON.stringify(posted));
    assert.deepEqual(posted.map(r => r.entry.seq).sort(), [1, 2]);
    assert.ok(!existsSync(`${raceBoard}.lock`), 'board lock released');
    const raceSession = join(root, 'race/child.jsonl');
    writeFileSync(raceSession, '');
    writeFileSync(`${raceSession}.continue.lock.7`, JSON.stringify({ pid: dead, jobId: 'old', at: Date.now(), token: 'old-gen' }));
    const sessions = await race('session', raceSession);
    assert.deepEqual(sessions.map(r => r.ok).sort(), [false, true], 'one winner on a stale session lock');
    assert.ok(!existsSync(`${raceSession}.continue.lock`));
    // A live owner is never displaced, however old its lock; its release leaves a marker and the next holder wins.
    const lockfile = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/lockfile.ts'));
    const lock = join(root, 'race/paused.lock');
    const ownerDead = (held) => Boolean(held && !lockfile.pidAlive(held.pid));
    const first = lockfile.tryLock(lock, {}, ownerDead);
    assert.ok(first.ok);
    const gens = () => readdirSync(join(root, 'race')).filter(n => n.startsWith('paused.lock.')).map(n => Number(n.slice('paused.lock.'.length))).sort((a, b) => a - b);
    const [heldGen] = gens();
    utimesSync(`${lock}.${heldGen}`, new Date(0), new Date(0));
    const blocked = lockfile.tryLock(lock, {}, ownerDead);
    assert.equal(blocked.ok, false, 'an old but live lock is not taken over');
    assert.equal(blocked.owner.token, JSON.parse(readFileSync(`${lock}.${heldGen}`, 'utf8')).token);
    first.release();
    assert.equal(JSON.parse(readFileSync(`${lock}.${heldGen + 1}`, 'utf8')).release, true, 'release is a marker generation');
    const next = lockfile.tryLock(lock, {}, ownerDead);
    assert.ok(next.ok);
    first.release();
    assert.equal(gens().at(-1), heldGen + 2, 'a second release of the old owner changes nothing');
    assert.ok(lockfile.tryLock(lock, {}, ownerDead).ok === false, 'the new holder keeps the lock');
    next.release();
    assert.ok(!existsSync(lock), 'mirror removed on release');
    assert.ok(gens().length <= 2, `lower generations pruned: ${gens()}`);
    console.log('ok locks: generation files, one winner on a dead owner, a live owner is never displaced');

    // AGENT_SWARM=1 turns swarm on in print/json/rpc runs, never in the TUI.
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.AGENT_SWARM = '1';
    const factory = (await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/index.ts'))).default;
    const boot = async (mode) => {
      const handlers = {}; const entries = [];
      const noop = () => {};
      const fakePi = new Proxy({ on: (name, h) => { (handlers[name] ??= []).push(h); }, appendEntry: (type, data) => entries.push([type, data]), events: { on: noop, emit: noop } }, { get: (t, k) => (k in t ? t[k] : noop) });
      factory(fakePi);
      const ctx = { mode, hasUI: mode === 'tui', cwd: work, ui: { setStatus: noop, notify: noop }, sessionManager: { getSessionId: () => `boot-${mode}`, getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => null } };
      for (const h of handlers.session_start) await h({}, ctx);
      for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
      return entries.filter(([type]) => type === 'agent-swarm');
    };
    assert.deepEqual(await boot('tui'), [], 'TUI ignores AGENT_SWARM');
    for (const mode of ['print', 'json', 'rpc']) assert.deepEqual(await boot(mode), [['agent-swarm', { enabled: true }]], `${mode} honors AGENT_SWARM`);
    delete process.env.AGENT_SWARM;
    console.log('ok AGENT_SWARM: honored in print/json/rpc, ignored in the TUI');

    // integrate holds every handle's session lock: a held lock (continue elsewhere) makes it refuse.
    const session = join(root, 'locked.jsonl');
    const launched = runPi({ AGENT_SWARM: '1', FG_SCRIPT: JSON.stringify([search, swarmCall(), { text: 'waiting' }]) }, { session });
    const lockedJob = readJob(/Launched swarm loop job (\S+),/.exec(resultText(toolResults(launched, 'swarm')[0]))[1]);
    const { acquireSessionLock } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/handles.ts'));
    const held = acquireSessionLock(lockedJob.tasks[1].sessionFile, 'other-continue');
    assert.ok(held.ok);
    const refused = runPi({ FG_RELATIVE: '1', FG_SCRIPT: JSON.stringify([{ tool: 'subagent', args: { action: 'integrate', jobId: '$JOB' } }]) }, { session });
    const integrateResult = toolResults(refused, 'subagent').at(-1);
    assert.equal(integrateResult.isError, true);
    assert.match(resultText(integrateResult), /Handle reviewer-\d+ is busy: its session is locked by job other-continue \(pid \d+\)\. Wait for it to finish, then integrate\./);
    assert.ok(existsSync(lockedJob.tasks[0].worktree), 'nothing merged or removed');
    held.release();
    const registry = JSON.parse(readFileSync(join(jobsDir, lockedJob.sessionId, 'handles', 'registry.json'), 'utf8'));
    for (const task of lockedJob.tasks) assert.equal(registry.handles[task.handle].lifecycle, 'waiting');
    assert.ok(!existsSync(`${lockedJob.tasks[0].sessionFile}.continue.lock`), 'manage released the locks it took');
    console.log('ok manage: integrate refuses while a handle session is locked, and releases its own locks');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
