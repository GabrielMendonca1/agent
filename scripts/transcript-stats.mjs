#!/usr/bin/env node
/** Read-only Pi transcript aggregates. Never emits message contents or file paths. */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

let days = 30, modelFilter = '', json = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--json') json = true;
  else if (flag === '--since' && /^\d+d$/.test(args[i + 1] ?? '')) days = Number(args[++i].slice(0, -1));
  else if (flag === '--model' && args[i + 1] && !args[i + 1].startsWith('--')) modelFilter = args[++i].toLowerCase();
  else {
    console.error('Usage: node scripts/transcript-stats.mjs [--since <Nd>] [--model <substr>] [--json]');
    process.exit(1);
  }
}
const cutoff = Date.now() - days * 864e5;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
async function* transcripts(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* transcripts(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}
const rows = [];
let unreadableFiles = 0, malformedLines = 0;
for await (const file of transcripts(join(homedir(), '.pi'))) {
  let model = 'unknown', sessionTime, local = [];
  const sub = /subagent|sub-agent|pi-sub/i.test(file); // Heuristic, as in the prototype.
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { malformedLines++; continue; }
      if (entry.type === 'session') sessionTime = entry.timestamp;
      if (entry.type === 'model_change') model = [entry.provider, entry.modelId].filter(Boolean).join('/') || 'unknown';
      const m = entry.type === 'message' ? entry.message : undefined;
      if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const calls = m.content.filter(block => block.type === 'toolCall');
      if (!calls.length && !m.usage) continue;
      // Assistant messages carry the actual model (including mid-session changes).
      const key = m.model ? [m.provider, m.model].filter(Boolean).join('/') : model;
      const ts = timestamp(m.timestamp ?? entry.timestamp ?? sessionTime);
      const eligible = Number.isFinite(ts) && ts >= cutoff && key.toLowerCase().includes(modelFilter);
      local.push({ eligible, calls: calls.map(c => c.name || 'unknown'), usage: m.usage || {}, sub, model: key,
        session: file, nested: calls.filter(c => c.name === 'codemode').map(c => (JSON.stringify(c.arguments || {}).match(/tools\./g) || []).length) });
    }
    // Keep boundaries when a time/model filter skips requests: they are not consecutive.
    let previous;
    for (const row of local) {
      row.previous = previous?.eligible ? previous : undefined;
      if (row.eligible) rows.push(row);
      previous = row;
    }
  } catch { unreadableFiles++; }
}
function summarize(selected) {
  const tools = new Map(), sessions = new Set(), cacheShares = [];
  let codemodeRequests = 0, codemodes = 0, nested = 0, calls = 0, withCalls = 0, withoutCalls = 0;
  let cacheRead = 0, inputTokens = 0, cacheWrite = 0, cacheBreaks = 0, consecutiveRuns = 0;
  const runLengths = new Map();
  const cache = u => Number(u.cacheRead ?? u.cache_read ?? 0);
  for (const r of selected) {
    sessions.add(r.session);
    calls += r.calls.length;
    for (const name of r.calls) tools.set(name, (tools.get(name) || 0) + 1);
    if (r.nested.length) { codemodeRequests++; withCalls += r.calls.length; }
    else withoutCalls += r.calls.length;
    codemodes += r.nested.length;
    nested += r.nested.reduce((a, b) => a + b, 0);
    const c = cache(r.usage), i = Number(r.usage.input || 0), w = Number(r.usage.cacheWrite ?? r.usage.cache_write ?? 0);
    cacheRead += c; inputTokens += i; cacheWrite += w;
    if (c + i + w) cacheShares.push(c / (c + i + w));
    const prev = r.previous?.model === r.model ? r.previous : undefined;
    if (prev && cache(prev.usage) > 0 && c < cache(prev.usage) * 0.25) cacheBreaks++;
    const simple = r.calls.length > 0 && r.calls.length <= 2 && r.calls.every(n => ['read', 'bash', 'grep'].includes(n));
    const length = simple ? (runLengths.get(r.previous) || 0) + 1 : 0;
    runLengths.set(r, length);
    if (length === 2) consecutiveRuns++;
  }
  cacheShares.sort((a, b) => a - b);
  const n = cacheShares.length;
  const denominator = cacheRead + inputTokens + cacheWrite;
  return { sessions: sessions.size, requests: selected.length, toolCalls: calls,
    callsPerRequest: selected.length ? calls / selected.length : 0,
    tools: [...tools].sort((a, b) => b[1] - a[1]), codemodeRequests,
    codemodeShare: selected.length ? codemodeRequests / selected.length : 0, codemodes,
    avgWith: codemodeRequests ? withCalls / codemodeRequests : 0,
    avgWithout: selected.length > codemodeRequests ? withoutCalls / (selected.length - codemodeRequests) : 0,
    nestedMean: codemodes ? nested / codemodes : 0, consecutiveRuns,
    inputTokens, cacheRead, cacheWrite, cacheRequests: n,
    cacheMedian: n ? (cacheShares[Math.floor((n - 1) / 2)] + cacheShares[Math.floor(n / 2)]) / 2 : 0,
    cacheWeighted: denominator ? cacheRead / denominator : 0, cacheBreaks };
}
const report = { sinceDays: days, modelFilter, ...summarize(rows), unreadableFiles, malformedLines,
  split: Object.fromEntries(['main', 'subagent'].map(kind => [kind, summarize(rows.filter(r => r.sub === (kind === 'subagent')))])),
  perModel: Object.fromEntries([...new Set(rows.map(r => r.model))].sort().map(model => [model, summarize(rows.filter(r => r.model === model))])) };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  const print = (label, r) => console.log(`${label}: ${r.sessions} sessions, ${r.requests} requests, ${r.toolCalls} tool calls (${r.callsPerRequest.toFixed(2)}/request)\n  codemode: ${r.codemodeRequests} requests (${(r.codemodeShare * 100).toFixed(3)}%), ${r.codemodes} calls, ${r.nestedMean.toFixed(2)} tools./script (heuristic); calls/request with/without: ${r.avgWith.toFixed(2)}/${r.avgWithout.toFixed(2)}\n  consecutive read/bash/grep runs: ${r.consecutiveRuns}; input/cache-read/cache-write tokens: ${r.inputTokens}/${r.cacheRead}/${r.cacheWrite}\n  cache: ${r.cacheRequests} requests, median ${(r.cacheMedian * 100).toFixed(1)}%, weighted ${(r.cacheWeighted * 100).toFixed(1)}%, drops <25%: ${r.cacheBreaks}\n  tools: ${r.tools.map(([name, count]) => `${name} ${count}`).join(', ') || 'none'}`);
  print(`Last ${days}d`, report);
  for (const [kind, stats] of Object.entries(report.split)) print(`${kind} (path heuristic)`, stats);
  for (const [model, stats] of Object.entries(report.perModel)) print(model, stats);
  console.log(`Skipped unreadable files: ${unreadableFiles}; malformed lines: ${malformedLines}`);
}
