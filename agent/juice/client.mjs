import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withDirectoryLock } from './lock.mjs';

const MODES = ['simple', 'complex'];
const home = () => process.env.AGENT_JUICE_HOME || join(homedir(), '.pi/agent/agent-juice');
// Even an inherited broker path selects only its directory, never its file.
export const juiceStatePath = () => join(process.env.AGENT_JUICE_STATE ? dirname(process.env.AGENT_JUICE_STATE) : home(), 'run.v3.json');
const ledger = juiceStatePath;
const preferencesPath = () => join(home(), 'preferences.v3.json');
export function juiceEnabled() {
  return process.env.AGENT_JUICE_ENABLED === '1' && isAbsolute(home()) && isAbsolute(ledger());
}
export function requireJuice() {
  if (!juiceEnabled()) throw new Error('Juice paused: missing or invalid opt-in configuration');
}
function read(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
// Serialize the full read/modify/rename transaction across parents and children.
// Dead owners are reclaimed, never live ones; an ownerless lock fails closed.
function update(file, fn) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const result = withDirectoryLock(`${file}.lock-dir`, () => {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const value = fn(read(file, null));
      writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
      renameSync(temp, file);
      return value;
    } finally { rmSync(temp, { force: true }); }
  });
  if (result === undefined) throw new Error(`Juice: state lock timeout: ${file}`);
  return result;
}
function validState(s) {
  if (!s || s.version !== 2 || !MODES.includes(s.mode) || !Array.isArray(s.pending) || !Array.isArray(s.receipts) ||
      !Number.isSafeInteger(s.calls?.used) || s.calls.used < 0 ||
      !Number.isSafeInteger(s.output?.used) || s.output.used < 0 ||
      !Number.isSafeInteger(s.output?.reserved) || s.output.reserved < 0 || !Number.isFinite(s.usd) || s.usd < 0) {
    throw new Error('Juice: invalid accounting state');
  }
  return s;
}
function validUsage(usage) {
  if (usage === undefined || usage === null) return;
  if (typeof usage !== 'object' || Array.isArray(usage)) throw new Error('Juice: invalid usage');
  for (const [key, value] of Object.entries(usage)) {
    if (key === 'cost') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(n => !Number.isFinite(n) || n < 0)) throw new Error('Juice: invalid cost');
    } else if (!Number.isSafeInteger(value) || value < 0) throw new Error('Juice: invalid usage');
  }
}
function preferences(prefs) {
  if (!MODES.includes(prefs.mode) || !(prefs.supportModel === null || (typeof prefs.supportModel === 'string' && prefs.supportModel.includes('/')))) throw new Error('Invalid Juice preferences');
  return { mode: prefs.mode, supportModel: prefs.supportModel };
}
const defaults = () => {
  // Only the mode is seeded from legacy preferences; the broker file is read-only.
  const legacy = read(join(home(), 'preferences.json'), null);
  return { mode: MODES.includes(legacy?.mode) ? legacy.mode : 'simple', supportModel: process.env.AGENT_JUICE_SUPPORT_MODEL || null };
};
function initialPreferences() {
  return update(preferencesPath(), old => preferences(old || defaults()));
}
export function getJuicePreferences() {
  return juiceEnabled() ? preferences(read(preferencesPath(), null) || initialPreferences()) : { mode: 'simple', supportModel: null };
}
export function setJuicePreferences(patch) {
  requireJuice();
  if (process.env.AGENT_JUICE_CHILD === '1') throw new Error('Juice children cannot change preferences');
  const prefs = update(preferencesPath(), old => preferences({ ...(old || defaults()), ...patch }));
  if (prefs.supportModel) process.env.AGENT_JUICE_SUPPORT_MODEL = prefs.supportModel;
  else delete process.env.AGENT_JUICE_SUPPORT_MODEL;
  return prefs;
}
const empty = (runId, mode) => ({ version: 2, runId, mode, calls: { used: 0 }, output: { used: 0, reserved: 0 }, usd: 0, pending: [], receipts: [], cache: { gaps: emptyGaps(), breaks: {}, warmSkips: {}, decisions: {} } });
const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
function aggregates(state) {
  const totals = Object.fromEntries([...keys, 'usd'].map(k => [k, 0]));
  const byKind = Object.create(null), byModel = Object.create(null);
  for (const entry of [...state.receipts, ...state.pending]) {
    for (const [map, key] of [[byKind, entry.kind], [byModel, entry.model]]) {
      const a = map[key] ??= { calls: 0, settled: 0, ...Object.fromEntries([...keys, 'usd'].map(k => [k, 0])) };
      a.calls++;
      if (entry.status === 'settled') {
        a.settled++;
        for (const k of keys) a[k] += entry.usage?.[k] || 0;
        a.usd += entry.usage?.cost?.total || 0;
      }
    }
    if (entry.status === 'settled') {
      for (const k of keys) totals[k] += entry.usage?.[k] || 0;
      totals.usd += entry.usage?.cost?.total || 0;
    }
  }
  return { totals, byKind, byModel };
}
function snapshot(s) {
  if (!s) return null;
  validState(s);
  const { receipts, pending, cache, ...rest } = s;
  return { ...rest, pendingCount: pending.length, pending: pending.slice(-50), receiptCount: receipts.length, cache: cacheView(cache), ...aggregates(s) };
}
export function juiceOperation(request) {
  requireJuice();
  if (request.op === 'snapshot') return { ok: true, state: getJuiceSnapshot() };
  if (request.op === 'report') return { ok: true, report: getJuiceReport() };
  if (request.op === 'cache') return { ok: recordJuiceCacheEvent(request) };
  if (request.op === 'receipts') return { ok: true, total: 0, offset: 0, receipts: [] };
  let allow;
  const state = update(ledger(), old => {
    if (request.op === 'init') {
      if (!MODES.includes(request.mode)) throw new Error('Invalid Juice mode');
      return old ? validState(old) : empty(request.runId, request.mode);
    }
    validState(old);
    if (request.op === 'mode') {
      if (!MODES.includes(request.mode)) throw new Error('Invalid Juice mode');
      old.mode = request.mode;
    } else if (request.op === 'reserve') {
      if ([...old.pending, ...old.receipts].some(e => e.callId === request.callId)) throw new Error('Juice: duplicate call id');
      if (!Number.isSafeInteger(request.requestedOutputTokens) || request.requestedOutputTokens < 1) throw new Error('Juice: invalid reservation');
      old.pending.push({ callId: request.callId, model: request.model, kind: request.kind, reservedOutputTokens: request.requestedOutputTokens, status: 'reserved' });
      old.calls.used++; old.output.reserved += request.requestedOutputTokens; allow = true;
    } else if (['settle', 'cancel', 'unknown'].includes(request.op)) {
      const i = old.pending.findIndex(e => e.callId === request.callId);
      if (i < 0) throw new Error('Juice: unknown call id');
      const e = old.pending[i];
      if (request.op === 'unknown') e.status = 'unknown';
      else {
        if (request.op === 'settle') {
          if (!Number.isSafeInteger(request.outputTokens) || request.outputTokens < 0) throw new Error('Juice: invalid usage');
          validUsage(request.usage);
          e.status = 'settled'; e.outputTokens = request.outputTokens; e.usage = request.usage;
          old.output.used += request.outputTokens; old.usd += request.usage?.cost?.total || 0;
        } else e.status = 'cancelled';
        old.output.reserved -= e.reservedOutputTokens;
        old.pending.splice(i, 1); old.receipts.push(e);
      }
    } else throw new Error('Juice: unsupported operation');
    return validState(old);
  });
  return { ok: true, state: snapshot(state), ...(allow ? { allow } : {}) };
}
export function getJuiceSnapshot() { return juiceEnabled() ? snapshot(read(ledger(), null)) : null; }
export async function getJuiceSnapshotAsync() {
  if (!juiceEnabled()) return null;
  try { return snapshot(JSON.parse(await readFile(ledger(), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// No interactive consumer of the paged audit trail. Aggregates remain available.
export function getJuiceReceipts() { return null; }
export function getJuiceReport() {
  if (!juiceEnabled()) return null;
  const s = read(ledger(), null); if (!s) return null;
  validState(s);
  const a = aggregates(s), warm = a.byKind['cache-warm'];
  const input = a.totals.input + a.totals.cacheRead + a.totals.cacheWrite;
  return { ...a, warm: { pings: warm?.calls || 0, cacheRead: warm?.cacheRead || 0, cacheWrite: warm?.cacheWrite || 0, usd: warm?.usd || 0 }, hitRate: input ? a.totals.cacheRead / input : 0, cache: cacheView(s.cache) };
}
const emptyGaps = () => edges.map(() => ({ returned: 0, censored: 0 }));
const edges = [300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, null];
function cacheView(cache = {}) {
  const buckets = edges.map((le, i) => ({ le, returned: cache.gaps?.[i]?.returned || 0, censored: cache.gaps?.[i]?.censored || 0 }));
  const hazard = buckets.map((b, i) => {
    const atRisk = buckets.slice(i).reduce((n, v) => n + v.returned + v.censored, 0);
    return { le: b.le, p: atRisk ? b.returned / atRisk : 0 };
  });
  return { ...cache, gaps: { hazard, count: buckets.reduce((n, b) => n + b.returned, 0), censored: buckets.reduce((n, b) => n + b.censored, 0), buckets } };
}
export function recordJuiceCacheEvent(event) {
  try {
    if (!juiceEnabled() || !existsSync(ledger())) return false;
    let field, key;
    if (event.event === 'break' && ['ttl-expired', 'prompt-changed', 'tools-changed', 'model-changed', 'compaction', 'thinking-changed', 'unknown'].includes(event.cause)) { field = 'breaks'; key = event.cause; }
    else if (event.event === 'warm_skip' && ['thinking-budget', 'window-closed', 'no-payload', 'error', 'cost-cap'].includes(event.reason)) { field = 'warmSkips'; key = event.reason; }
    else if (['compaction', 'prune'].includes(event.event) && ['deferred', 'allowed'].includes(event.action) && ['warm', 'cold', 'hard-limit', 'defer-budget', 'unknown-usage', 'manual', 'overflow', 'idle'].includes(event.cause)) { field = 'decisions'; key = `${event.event}:${event.action}:${event.cause}`; }
    else if (!(event.event === 'gap' && Number.isFinite(event.seconds) && event.seconds >= 0 && event.seconds <= 30 * 86400)) return false;
    update(ledger(), s => {
      validState(s);
      s.cache ||= { gaps: emptyGaps(), breaks: {}, warmSkips: {}, decisions: {} };
      // Additive, bounded metadata; existing break counters and readers stay unchanged.
      if (field === 'breaks' && ['model', 'system', 'tools', 'thinking', 'message', 'none'].includes(event.segment)) {
        s.cache.lastBreak = { cause: event.cause, segment: event.segment,
          ...(event.segment === 'message' && Number.isSafeInteger(event.index) && event.index >= 0 ? { index: event.index } : {}) };
      }
      if (field) { s.cache[field] ||= {}; s.cache[field][key] = (s.cache[field][key] || 0) + 1; }
      else {
        s.cache.gaps = edges.map((_, i) => ({ returned: s.cache.gaps?.[i]?.returned || 0, censored: s.cache.gaps?.[i]?.censored || 0 }));
        const i = edges.findIndex(le => le === null || event.seconds <= le);
        const b = s.cache.gaps[i];
        b[event.censored ? 'censored' : 'returned']++;
      }
      return s;
    });
    return true;
  } catch { return false; }
}
export function setJuiceMode(mode) {
  requireJuice();
  if (process.env.AGENT_JUICE_CHILD === '1') throw new Error('Juice children cannot change mode');
  if (!MODES.includes(mode)) throw new Error('Invalid Juice mode');
  // Global default for new/old branches without a saved mode, not session authority.
  setJuicePreferences({ mode });
  return null;
}
export function formatJuiceStatus(s = getJuiceSnapshot(), prefs = getJuicePreferences()) {
  return s ? `juice ${s.mode} · US$ ${(Number.isFinite(s.usd) ? s.usd : 0).toFixed(2)}` : `juice ${prefs.mode} · sem execução`;
}
