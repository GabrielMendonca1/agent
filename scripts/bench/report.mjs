import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function summarize(config, runs, stopReason) {
  const arms = config.models.flatMap(model => config.modes.map(mode => ({ model, mode })));
  const commonTasks = config.tasks.filter(task => arms.every(a => Array.from({ length: config.trials }, (_, i) => i + 1).every(trial => runs.some(r => r.task === task && r.model === a.model && r.mode === a.mode && r.trial === trial && r.pass))));
  const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
  return { createdAt: new Date().toISOString(), config, stopReason, budgetNote: 'Soft cap: usage arrives after requests; concurrent in-flight requests may overshoot. Costs are provider list-price usage.cost.total, not invoices.',
    commonTasks, arms: arms.map(a => {
      const rows = runs.filter(r => r.model === a.model && r.mode === a.mode);
      const common = rows.filter(r => commonTasks.includes(r.task));
      return { ...a, attempted: rows.length, passed: rows.filter(r => r.pass).length, passRate: rows.length ? rows.filter(r => r.pass).length / rows.length : null,
        totalCostUsd: sum(rows, 'costUsd'), requestsPerTask: rows.length ? sum(rows, 'requests') / rows.length : null,
        totalWallSeconds: sum(rows, 'wallSeconds'), commonRuns: common.length,
        costPerPassedTaskUsd: common.length ? sum(common, 'costUsd') / common.length : null,
        secondsPerPassedTask: common.length ? sum(common, 'wallSeconds') / common.length : null };
    }), runs };
}
const fmt = (n, digits = 3) => n == null ? 'n/a' : n.toFixed(digits);
export function markdown(report) {
  const { config, runs } = report;
  return `# Mark task benchmark — ${report.createdAt.slice(0, 10)}\n\nTask version: ${config.taskVersion}. Trials: ${config.trials}. Concurrency: ${config.concurrency}. Budget: $${config.maxUsd}.\n\n${report.budgetNote}\n\nStop reason: ${report.stopReason || 'completed'}.\n\nCommon-pass tasks (every arm, every trial): ${report.commonTasks.join(', ') || 'none'}. Cost/passed task and seconds/passed task use only this set; requests/task and pass rate use every attempted run. Arm time is summed agent wall time, not elapsed concurrent makespan.\n\n| Model | Mode | Passed | Cost/passed task | Requests/task | Seconds/passed task | Arm seconds | Total USD |\n|---|---|---:|---:|---:|---:|---:|---:|\n${report.arms.map(a => `| ${a.model} | ${a.mode} | ${a.passed}/${a.attempted} | ${fmt(a.costPerPassedTaskUsd)} | ${fmt(a.requestsPerTask, 2)} | ${fmt(a.secondsPerPassedTask, 1)} | ${fmt(a.totalWallSeconds, 1)} | ${fmt(a.totalCostUsd)} |`).join('\n')}\n\n## Runs and traces\n\n| Task | Mode | Trial | Pass | USD | Requests | Seconds | Tools | Trace |\n|---|---|---:|---|---:|---:|---:|---|---|\n${runs.map(r => `| ${r.task} | ${r.mode} | ${r.trial} | ${r.pass} | ${fmt(r.costUsd)} | ${r.requests} | ${fmt(r.wallSeconds, 1)} | ${Object.entries(r.tools).map(([k,v]) => `${k}:${v}`).join(', ')} | ${r.jsonlPath} |`).join('\n')}\n\n## Failure traces\n\n${runs.filter(r => !r.pass).map(r => `### ${r.task} / ${r.model} / ${r.mode} / ${r.trial}\n\n${r.failure}\n\nFinal assistant (bounded, redacted):\n\n\`\`\`text\n${r.finalText.replaceAll('```', "'''")}\n\`\`\`\n\nTool errors:\n\n\`\`\`text\n${r.toolErrors.join('\n').replaceAll('```', "'''")}\n\`\`\`\n`).join('\n') || 'None.\n'}\n## Interpretation\n\nJSON includes token categories, toolsAdded, codemode calls and static tools. occurrences (nestedEstimate). nestedCalls=null means no reliable observed nested-call telemetry; estimates are not execution counts. Traces and failed fixtures stay local; successful fixtures are deleted. No retries or result replacement. One trial is descriptive, not evidence of a stable winner.\n`;
}
export async function saveReport(out, report) {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(out, 'report.md'), markdown(report), { mode: 0o600 });
}
