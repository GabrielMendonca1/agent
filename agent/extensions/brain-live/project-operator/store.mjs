import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LIMITS, redact } from "./render.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const JOURNAL_MAX_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 300000;

export function stateBaseDir(home = homedir()) {
  return path.join(home, ".pi", "agent", "project-overviews");
}

export function sidecarPaths(slug, baseDir = stateBaseDir()) {
  const safeSlug = String(slug);
  if (!/^[a-z0-9._-]+$/.test(safeSlug) || safeSlug.includes("..")) {
    throw new Error(`invalid slug: ${safeSlug}`);
  }
  const dir = path.join(baseDir, safeSlug);
  const resolvedBase = path.resolve(baseDir);
  if (path.resolve(dir) !== path.join(resolvedBase, safeSlug)) throw new Error("slug escapes base dir");
  return {
    baseDir: resolvedBase,
    dir,
    overview: path.join(dir, "OVERVIEW.md"),
    journal: path.join(dir, "journal.jsonl"),
    metadata: path.join(dir, "metadata.json"),
  };
}

export function assertInside(baseDir, target) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`refusing to write outside state dir: ${resolved}`);
  }
  return resolved;
}

export async function ensureDir(dir, baseDir) {
  if (baseDir) assertInside(baseDir, dir);
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await fsp.chmod(dir, DIR_MODE);
  } catch {}
  return dir;
}

export async function writeAtomic(target, content, baseDir) {
  if (baseDir) assertInside(baseDir, target);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await fsp.writeFile(tmp, content, { mode: FILE_MODE });
    await fsp.rename(tmp, target);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {}
    throw error;
  }
  return target;
}

async function rotateIfNeeded(journalPath) {
  try {
    const stat = await fsp.stat(journalPath);
    if (stat.size <= JOURNAL_MAX_BYTES) return;
    await fsp.rename(journalPath, `${journalPath}.1`);
  } catch {}
}

export async function appendRecord(paths, entry) {
  await ensureDir(paths.dir, paths.baseDir);
  assertInside(paths.baseDir, paths.journal);
  await rotateIfNeeded(paths.journal);
  const record = {
    ts: entry.ts ?? Date.now(),
    kind: entry.kind === "intervention" ? "intervention" : "note",
    session: redact(String(entry.session ?? "pi"), { maxChars: 64 }),
    text: redact(String(entry.text ?? ""), { maxChars: LIMITS.recordChars }),
  };
  await fsp.appendFile(paths.journal, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
  return record;
}

export async function readTail(paths, count = LIMITS.journalEntries) {
  let raw;
  try {
    raw = await fsp.readFile(paths.journal, "utf-8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") entries.push(parsed);
    } catch {}
  }
  return entries.slice(-count);
}

export async function writeOverview(paths, content) {
  await ensureDir(paths.dir, paths.baseDir);
  return writeAtomic(paths.overview, content, paths.baseDir);
}

export async function writeMetadata(paths, metadata) {
  await ensureDir(paths.dir, paths.baseDir);
  return writeAtomic(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`, paths.baseDir);
}

export function shouldPersist(options = {}) {
  const { fingerprint, lastFingerprint, at, lastPersistAt, force, heartbeatMs = HEARTBEAT_MS } = options;
  if (force) return true;
  if (lastFingerprint === null || lastFingerprint === undefined) return true;
  if (lastPersistAt === null || lastPersistAt === undefined) return true;
  if (fingerprint !== lastFingerprint) return true;
  return Number(at ?? 0) - Number(lastPersistAt) >= heartbeatMs;
}

const chains = new Map();

export function serialize(key, task) {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  chains.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}
