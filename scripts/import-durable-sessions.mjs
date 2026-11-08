#!/usr/bin/env node
// Durable-host -> Pi 1.4.0 session format v3. No dependencies on an installed release.
// Source: durable-host/{session-id,session-store,entries,legacy-import}.js and
// pi-durable entries.d.ts. Root conversation is 1; child task state is not a session.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync, linkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'dry-run': { type: 'boolean', default: false },
  source: { type: 'string', default: join(homedir(), '.pi/agent/durable-sessions') },
  destination: { type: 'string', default: join(homedir(), '.pi/agent/sessions') },
  session: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/import-durable-sessions.mjs [--dry-run] [--limit N] [--session UUID]\n'
    + '  [--source DIR] [--destination DIR] (defaults: ~/.pi/agent/{durable-sessions,sessions})');
  process.exit(0);
}
const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!(limit > 0 && (Number.isSafeInteger(limit) || limit === Infinity))) throw new Error('Invalid --limit');
const source = resolve(values.source), destination = resolve(values.destination);
if (destination === source || destination.startsWith(source + '/')) throw new Error('Destination overlaps source');
const report = { dryRun: values['dry-run'], found: 0, converted: 0, planned: 0, skipped: 0,
  failed: 0, messages: 0, compactions: 0, ignored: {}, notes: {} };
const count = (bag, key, n = 1) => { bag[key] = (bag[key] ?? 0) + n; };
const iso = (value) => new Date(value).toISOString();
function sessionId(name) {
  const uuid = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].toLowerCase();
  // Same UUID v5 namespace and fallback as durableSessionUuid().
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8129dad11d180b400c04fd430c8', 'hex'))
    .update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function files(root, name) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(e => e.isDirectory() ? files(join(root, e.name), name)
      : e.isFile() && name(e.name) ? [join(root, e.name)] : []);
}
function existingIds() {
  const ids = new Set();
  for (const path of files(destination, n => n.endsWith('.jsonl'))) {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(65536), n = readSync(fd, buf);
      const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
      try { const h = JSON.parse(first); if (h.type === 'session') ids.add(h.id); } catch { /* not a header */ }
    } finally { closeSync(fd); }
  }
  return ids;
}
function signature(path) {
  return ['', '-wal', '-shm'].map(ext => {
    try { const s = statSync(path + ext); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  });
}
function snapshot(path) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-durable-import-'));
  let db;
  try {
    const before = signature(path);
    for (const [i, ext] of ['', '-wal', '-shm'].entries()) {
      if (before[i] !== null) copyFileSync(path + ext, join(temp, 'session.sqlite' + ext));
    }
    if (JSON.stringify(before) !== JSON.stringify(signature(path))) throw new Error('Source changed during snapshot; retry when idle');
    db = new DatabaseSync(join(temp, 'session.sqlite'), { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (!tables.length) return null;
    if (!tables.some(t => t.name === 'entries')) throw new Error('STOP: unrecognized nonempty SQLite schema');
    const records = db.prepare('SELECT record FROM entries ORDER BY id').all().map(r => JSON.parse(r.record));
    const ignored = {};
    for (const table of ['tasks', 'submissions', 'documents', 'document_revisions']) {
      if (tables.some(t => t.name === table)) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        if (n) ignored[`host-state:${table}`] = n;
      }
    }
    return { records, ignored };
  } finally { db?.close(); rmSync(temp, { recursive: true, force: true }); }
}
function convert(records, meta, id, path) {
  const root = records.filter(r => r.conversationId === 1);
  const systemCwd = root.flatMap(r => r.model ?? []).map(m => m.sections?.cwd)
    .find(c => typeof c === 'string' && /<cwd>\s*([^<]+?)\s*<\/cwd>/.test(c))
    ?.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/)?.[1];
  const cwd = meta.cwd || systemCwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { skip: 'cwd unavailable (project hash is not a cwd)' };
  const firstTimestamp = root.flatMap(r => r.model ?? []).find(m => Number.isFinite(m.timestamp))?.timestamp;
  const timestamp = iso(meta.created ?? firstTimestamp ?? Number(basename(dirname(path)).split('-')[0]));
  const entries = [{ type: 'session', version: 3, id, timestamp, cwd }];
  let parentId = null, lastTimestamp = timestamp, model, thinking;
  const ignored = {}, notes = {};
  const append = (entryId, time, entry) => {
    entries.push({ ...entry, id: entryId, parentId, timestamp: time }); parentId = entryId;
  };
  const mapped = new Map();
  for (const r of root) {
    const messages = r.model ?? [];
    if (['pi.user', 'pi.assistant', 'pi.tool-result'].includes(r.kind) && !messages.length)
      throw new Error(`STOP: ${r.kind} ${r.id} has no complete messages`);
    const time = messages.find(m => Number.isFinite(m.timestamp))?.timestamp
      ?? (Number.isFinite(r.data?.data?.timestamp) ? r.data.data.timestamp : undefined);
    lastTimestamp = time === undefined ? lastTimestamp : iso(time);
    if (time === undefined) count(notes, 'entry timestamp unavailable: previous timestamp used');
    const entryId = String(r.id);
    if (r.kind === 'arca.entry') {
      append(entryId, lastTimestamp, { type: 'custom', customType: r.data?.customType ?? 'unknown', data: r.data?.data });
      mapped.set(r.id, entryId); continue;
    }
    if (r.kind === 'pi.compaction') {
      const content = messages[0]?.content;
      if (content === undefined) throw new Error(`STOP: compaction ${r.id} missing summary`);
      const summary = typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      // Durable stores the already-wrapped user summary. Keep it verbatim; no heuristic stripping.
      append(entryId, lastTimestamp, { type: 'compaction', summary,
        firstKeptEntryId: String(r.head ?? r.id), tokensBefore: 0, details: r.data });
      count(notes, 'compaction tokensBefore unavailable: 0 used');
      mapped.set(r.id, entryId); continue;
    }
    if (r.kind === 'arca.message') {
      const m = messages[0];
      append(entryId, lastTimestamp, { type: 'custom_message', customType: r.data?.customType ?? 'unknown',
        content: m?.content ?? '', display: r.data?.display ?? true, details: r.data?.details });
      mapped.set(r.id, entryId); continue;
    }
    let written = false;
    for (const [i, message] of messages.entries()) {
      if (!['user', 'assistant', 'toolResult'].includes(message.role)) { count(ignored, `${r.kind}:${message.role}`); continue; }
      if (message.content === undefined) throw new Error(`STOP: incomplete message ${r.id}`);
      const t = Number.isFinite(message.timestamp) ? iso(message.timestamp) : lastTimestamp;
      if (message.role === 'assistant') {
        const nextModel = `${message.provider}/${message.model}`;
        if (message.provider && message.model && model !== nextModel) {
          append(`${entryId}-model-${i}`, t, { type: 'model_change', provider: message.provider, modelId: message.model }); model = nextModel;
        }
        if (message.providerThinkingLevel && thinking !== message.providerThinkingLevel) {
          thinking = message.providerThinkingLevel;
          append(`${entryId}-thinking-${i}`, t, { type: 'thinking_level_change', thinkingLevel: thinking });
        }
      }
      const mid = i === 0 ? entryId : `${entryId}-${i}`;
      append(mid, t, { type: 'message', message }); mapped.set(r.id, mapped.get(r.id) ?? mid); written = true;
    }
    if (!written && !messages.length) count(ignored, r.kind);
  }
  // A compaction head may name an ignored system entry; advance to the next retained entry.
  for (const entry of entries.filter(e => e.type === 'compaction')) {
    const head = Number(entry.firstKeptEntryId);
    const kept = root.find(r => r.id >= head && mapped.has(r.id));
    if (!kept) throw new Error(`STOP: compaction ${entry.id} has unresolved head ${head}`);
    entry.firstKeptEntryId = mapped.get(kept.id);
  }
  if (meta.name?.trim()) append('durable-session-name', lastTimestamp, { type: 'session_info', name: meta.name });
  for (const r of records.filter(r => r.conversationId !== 1)) count(ignored, `child-conversation:${r.kind}`);
  const messages = entries.filter(e => e.type === 'message').length;
  if (!messages) return { skip: 'empty session (no user/assistant/toolResult messages)' };
  const slug = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return { entries, ignored, notes, messages, cwd, name: meta.name,
    compactions: entries.filter(e => e.type === 'compaction').length,
    target: join(destination, slug, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`) };
}

const ids = existingIds();
const plans = [];
// Preflight everything before publishing: partial-message input stops the entire import.
for (const path of files(source, n => n === 'session.sqlite')) {
  const id = sessionId(basename(dirname(path)));
  if (values.session && values.session !== id && values.session !== basename(dirname(path))) continue;
  report.found++;
  const skip = reason => { report.skipped++; console.log(JSON.stringify({ status: 'skipped', id, source: path, reason })); };
  if (basename(dirname(path)).endsWith('.lock')) { skip('lock artifact (not a session)'); continue; }
  if (ids.has(id)) { skip('same session id already exists'); continue; }
  if (plans.length >= limit) { skip('--limit'); continue; }
  try {
    const data = snapshot(path);
    if (data === null) { skip('empty SQLite (no tables; lock artifact)'); continue; }
    const metaPath = join(dirname(path), 'meta.json');
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    const result = convert(data.records, meta, id, path);
    if (result.skip) { skip(result.skip); continue; }
    if (existsSync(result.target)) { skip('target path exists (never overwritten)'); continue; }
    Object.assign(result.ignored, data.ignored);
    plans.push({ id, source: path, ...result }); ids.add(id);
  } catch (e) {
    report.failed++; console.error(JSON.stringify({ status: 'failed', source: path, error: e.message }));
    if (e.message.startsWith('STOP:')) { console.error('Stopped before publishing any sessions.'); process.exit(1); }
  }
}
for (const plan of plans) {
  try {
    if (!values['dry-run']) {
      mkdirSync(dirname(plan.target), { recursive: true });
      // Publish atomically and exclusively. A crash cannot leave a partial JSONL marked imported.
      const temp = mkdtempSync(join(tmpdir(), 'pi-jsonl-import-'));
      try {
        const staging = join(temp, 'session.jsonl');
        writeFileSync(staging, plan.entries.map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        linkSync(staging, plan.target); // EEXIST/EXDEV are failures, never overwrite/fallback.
      } finally { rmSync(temp, { recursive: true, force: true }); }
      report.converted++;
    } else report.planned++;
    report.messages += plan.messages; report.compactions += plan.compactions;
    for (const [k, v] of Object.entries(plan.ignored)) count(report.ignored, k, v);
    for (const [k, v] of Object.entries(plan.notes)) count(report.notes, k, v);
    console.log(JSON.stringify({ status: values['dry-run'] ? 'would-convert' : 'converted',
      id: plan.id, cwd: plan.cwd, name: plan.name, messages: plan.messages,
      compactions: plan.compactions, target: plan.target }));
  } catch (e) { report.failed++; console.error(JSON.stringify({ status: 'failed', id: plan.id, error: e.message })); }
}
console.log(JSON.stringify({ report }, null, 2));
if (report.failed) process.exitCode = 1;
