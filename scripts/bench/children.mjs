// Subagent cost attribution. Each run's parent session id (first `type: session` line of
// --mode json) names the job directory $PI_CODING_AGENT_DIR/subagent-jobs/<sessionId>/.
// Only numeric usage, roles, models and lifecycle fields are copied: never task text, results,
// paths or anything else from the profile.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same default as the `agent` launcher.
export const profileDir = (env = process.env) => env.PI_CODING_AGENT_DIR || join(homedir(), '.agent');
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const TERMINAL_TASK = new Set(['completed', 'failed', 'not_run']);

export async function readJobs(profile, sessionId) {
  if (!SAFE_ID.test(String(sessionId ?? '')) || sessionId === '.' || sessionId === '..') return [];
  const dir = join(profile, 'subagent-jobs', sessionId);
  let names;
  try { names = (await readdir(dir)).filter(n => n.endsWith('.json')); } catch { return []; }
  const jobs = [];
  for (const name of names.sort()) {
    let r;
    try { r = JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { continue; } // mid-rename or foreign file
    if (r?.sessionId !== sessionId || !Array.isArray(r.tasks)) continue;
    jobs.push({
      jobId: String(r.jobId), mode: r.mode, status: r.status, createdAt: num(r.createdAt), finishedAt: r.finishedAt == null ? null : num(r.finishedAt),
      resumes: num(r.resumes),
      jobCostUsd: typeof r.usage?.cost === 'number' ? num(r.usage.cost) : null,
      tasks: r.tasks.map(t => ({ agent: String(t.agent), model: typeof t.model === 'string' ? t.model : null, state: t.state ?? null,
        costUsd: t.usage ? num(t.usage.cost) : null, turns: num(t.usage?.turns),
        tokens: { input: num(t.usage?.input), cacheRead: num(t.usage?.cacheRead), cacheWrite: num(t.usage?.cacheWrite), output: num(t.usage?.output) } })),
    });
  }
  return jobs;
}

// Per-task usage arrives as each child returns; the job-level sum only at settle. Use the larger
// so a running job still counts finished children. `complete` is false when some child cost is
// unknown (running, interrupted, killed): the total is then a lower bound.
export function childTotals(jobs) {
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let costUsd = 0, tasks = 0, turns = 0, complete = true;
  const agents = {};
  for (const j of jobs) {
    const taskSum = j.tasks.reduce((n, t) => n + (t.costUsd ?? 0), 0);
    costUsd += Math.max(taskSum, j.jobCostUsd ?? 0);
    if (j.status === 'running' || j.status === 'interrupted') complete = false;
    for (const t of j.tasks) {
      tasks++; turns += t.turns;
      agents[t.agent] = (agents[t.agent] || 0) + 1;
      for (const k of Object.keys(tokens)) tokens[k] += t.tokens[k];
      if (t.costUsd == null && !(t.state === 'not_run')) complete = false;
      if (t.state && !TERMINAL_TASK.has(t.state)) complete = false;
    }
  }
  return { costUsd, jobs: jobs.length, tasks, turns, agents, tokens, complete };
}
