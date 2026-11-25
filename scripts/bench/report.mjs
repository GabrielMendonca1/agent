import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const sum = (rows, f) => rows.reduce((n, r) => n + (typeof f === 'function' ? f(r) : r[f]), 0);
export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const childCost = r => r.children?.costUsd ?? 0;
function metrics(rows) {
  const passed = rows.filter(r => r.pass).length;
  return { attempted: rows.length, passed, passRate: rows.length ? passed / rows.length : null,
    totalCostUsd: sum(rows, 'costUsd'), parentCostUsd: sum(rows, 'parentCostUsd'), childCostUsd: sum(rows, childCost),
    // false when any run has a child whose cost was not recorded (killed, interrupted): totals are lower bounds.
    childCostComplete: rows.every(r => !r.children || r.children.complete),
    medianWallSeconds: median(rows.map(r => r.wallSeconds)), medianCostUsd: median(rows.map(r => r.costUsd)),
    totalWallSeconds: sum(rows, 'wallSeconds'), requestsPerTask: rows.length ? sum(rows, 'requests') / rows.length : null,
    parentTokens: Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map(k => [k, sum(rows, r => r.tokens[k])])),
    subagentCalls: sum(rows, 'subagentCalls'), skimCalls: sum(rows, 'skimCalls'), codemodeCalls: sum(rows, 'codemodeCalls'),
    childJobs: sum(rows, r => r.children?.jobs ?? 0), childTasks: sum(rows, r => r.children?.tasks ?? 0) };
}
export function summarize(config, runs, stopReason) {
  const arms = config.models.flatMap(model => config.modes.map(mode => ({ model, mode })));
  const trials = task => config.trialsByTask?.[task] ?? config.trials ?? 1;
  const commonTasks = config.tasks.filter(task => arms.every(a => Array.from({ length: trials(task) }, (_, i) => i + 1).every(trial => runs.some(r => r.task === task && r.model === a.model && r.mode === a.mode && r.trial === trial && r.pass))));
  return { createdAt: new Date().toISOString(), config, stopReason,
    budgetNote: 'Soft cap: usage arrives after requests and child usage is polled every 5 s; concurrent in-flight requests may overshoot. Costs are provider list-price usage.cost.total (parent) plus subagent job usage.cost (children), not invoices.',
    commonTasks, arms: arms.map(a => {
      const rows = runs.filter(r => r.model === a.model && r.mode === a.mode);
      const common = rows.filter(r => commonTasks.includes(r.task));
      return { ...a, ...metrics(rows), commonRuns: common.length,
        costPerPassedTaskUsd: common.length ? sum(common, 'costUsd') / common.length : null,
        secondsPerPassedTask: common.length ? sum(common, 'wallSeconds') / common.length : null,
        byTask: Object.fromEntries(config.tasks.map(task => [task, metrics(rows.filter(r => r.task === task))]).filter(([, m]) => m.attempted)) };
    }), runs };
}
const fmt = (n, digits = 3) => n == null ? 'n/a' : n.toFixed(digits);
const usd = (m) => `${fmt(m.totalCostUsd)}${m.childCostComplete ? '' : '+'}`;
export function markdown(report) {
  const { config, runs } = report;
  const p = config.provenance ?? {};
  return `# Agent task benchmark — ${report.createdAt.slice(0, 10)}

Task version: ${config.taskVersion}. Trials: ${config.trials ?? 'per task (solo 1, orchestration 3)'}. Concurrency: ${config.concurrency}. Budget: $${config.maxUsd}.

Installed artifact: ${p.artifactId ?? 'unknown'}. Installed source commit: ${p.installedSourceCommit ?? 'unknown'}. Bench commit: ${p.benchCommit ?? 'unknown'}${p.benchDirty ? ' (dirty)' : ''}. Binary: ${p.agentBin ?? 'n/a'}.

${report.budgetNote} A "+" marks totals with a child whose cost was not recorded (lower bound).

Stop reason: ${report.stopReason || 'completed'}.

Common-pass tasks (every arm, every trial): ${report.commonTasks.join(', ') || 'none'}. Cost/passed task and seconds/passed task use only this set; requests/task and pass rate use every attempted run. Arm time is summed agent wall time, not elapsed concurrent makespan.

| Model | Mode | Passed | Total USD | Parent USD | Children USD | Median s | Cost/passed task | Seconds/passed task | Requests/task | subagent | skim | codemode | Child jobs/tasks |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${report.arms.map(a => `| ${a.model} | ${a.mode} | ${a.passed}/${a.attempted} | ${usd(a)} | ${fmt(a.parentCostUsd)} | ${fmt(a.childCostUsd)} | ${fmt(a.medianWallSeconds, 1)} | ${fmt(a.costPerPassedTaskUsd)} | ${fmt(a.secondsPerPassedTask, 1)} | ${fmt(a.requestsPerTask, 2)} | ${a.subagentCalls} | ${a.skimCalls} | ${a.codemodeCalls} | ${a.childJobs}/${a.childTasks} |`).join('\n')}

## Per task (median over trials)

| Task | Model | Mode | Passed | Median s | Median USD | Total USD | Children USD |
|---|---|---|---:|---:|---:|---:|---:|
${report.arms.flatMap(a => Object.entries(a.byTask).map(([task, m]) => `| ${task} | ${a.model} | ${a.mode} | ${m.passed}/${m.attempted} | ${fmt(m.medianWallSeconds, 1)} | ${fmt(m.medianCostUsd)} | ${usd(m)} | ${fmt(m.childCostUsd)} |`)).join('\n')}

## Runs and traces

| Task | Mode | Trial | Pass | USD | Parent | Children | Requests | Seconds | Tools | Child agents | Trace |
|---|---|---:|---|---:|---:|---:|---:|---:|---|---|---|
${runs.map(r => `| ${r.task} | ${r.mode} | ${r.trial} | ${r.pass} | ${fmt(r.costUsd)} | ${fmt(r.parentCostUsd)} | ${fmt(childCost(r))}${r.children && !r.children.complete ? '+' : ''} | ${r.requests} | ${fmt(r.wallSeconds, 1)} | ${Object.entries(r.tools).map(([k, v]) => `${k}:${v}`).join(', ')} | ${Object.entries(r.children?.agents ?? {}).map(([k, v]) => `${k}:${v}`).join(', ')} | ${r.jsonlPath} |`).join('\n')}

## Failure traces

${runs.filter(r => !r.pass).map(r => `### ${r.task} / ${r.model} / ${r.mode} / ${r.trial}\n\n${r.failure}\n\nFinal assistant (bounded, redacted):\n\n\`\`\`text\n${r.finalText.replaceAll('```', "'''")}\n\`\`\`\n\nTool errors:\n\n\`\`\`text\n${r.toolErrors.join('\n').replaceAll('```', "'''")}\n\`\`\`\n`).join('\n') || 'None.\n'}
## Interpretation

JSON includes parent token categories, toolsAdded, codemode calls and static tools. occurrences (nestedEstimate), and per run the sanitized subagent jobs (role, model, state, usage; no task text or results). nestedCalls=null means no reliable observed nested-call telemetry; estimates are not execution counts. Traces, parent sessions and failed fixtures stay local; successful fixtures are deleted. No retries or result replacement. Orchestration tasks also fail when the required delegation pattern is missing. Fewer than 3 trials are descriptive, not evidence of a stable winner.
`;
}
export async function saveReport(out, report) {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(out, 'report.md'), markdown(report), { mode: 0o600 });
}
