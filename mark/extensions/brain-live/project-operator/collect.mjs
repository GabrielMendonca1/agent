import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LIMITS, deriveWarnings, projectSlug, redact, safeInline } from "./render.mjs";

const ALLOWED_BINARIES = new Set(["git", "ps", "lsof"]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["rev-parse", "status", "log", "stash", "rev-list", "worktree"]);
const FORBIDDEN_GIT_TOKENS = new Set([
  "commit", "add", "checkout", "reset", "clean", "push", "fetch", "pull", "gc", "prune", "rm", "mv",
  "merge", "rebase", "apply", "restore", "switch", "tag", "branch", "init", "config", "remote",
  "submodule", "update-ref", "write-tree", "commit-tree", "hash-object", "am", "cherry-pick",
  "revert", "bisect", "daemon", "credential", "fsck", "repack", "filter-branch", "gui", "stage",
]);
const SHELL_METACHARS = /[;&|`$><\n\r\\]/;
const MAX_LSOF_PIDS = 200;

const RUNTIME_LABELS = new Set([
  "node", "bun", "deno", "python3", "python", "ruby", "cargo", "rustc", "esbuild", "vite",
  "next-server", "tsc", "docker", "postgres", "redis-server", "ollama", "wrangler", "caddy", "nginx",
]);

const SAFE_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

function defaultExec(argv, options) {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...SAFE_ENV },
      },
      (error, stdout) => {
        if (error && !stdout) {
          resolve({ ok: false, reason: error.killed ? "timeout" : "error", stdout: "" });
          return;
        }
        resolve({ ok: !error, reason: error ? "error" : undefined, stdout: String(stdout ?? "") });
      },
    );
  });
}

export function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return "empty argv";
  for (const arg of argv) {
    if (typeof arg !== "string") return "non-string arg";
    if (SHELL_METACHARS.test(arg)) return `shell metacharacter in arg: ${arg}`;
  }
  if (!ALLOWED_BINARIES.has(argv[0])) return `binary not allowed: ${argv[0]}`;
  if (argv[0] === "git") {
    const sub = argv.find((a, i) => i > 0 && !a.startsWith("-"));
    if (!sub || !ALLOWED_GIT_SUBCOMMANDS.has(sub)) return `git subcommand not allowed: ${sub ?? "<none>"}`;
    for (const arg of argv.slice(1)) {
      if (FORBIDDEN_GIT_TOKENS.has(arg)) return `forbidden git token: ${arg}`;
    }
  }
  return null;
}

export async function runReadOnly(argv, options = {}) {
  const rejection = validateArgv(argv);
  if (rejection) return { ok: false, reason: rejection, stdout: "", rejected: true };
  const exec = options.exec ?? defaultExec;
  try {
    return await exec(argv, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 1500 });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "exec failed", stdout: "" };
  }
}

export function encodeProjectDir(target) {
  return String(target).replace(/[/.]/g, "-");
}

export function etimeToSeconds(value) {
  if (typeof value !== "string") return 0;
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return 0;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

export function classifyComm(comm) {
  if (typeof comm !== "string" || comm.length === 0) return null;
  const trimmed = comm.trim();
  const first = trimmed.split(" ")[0];
  const base = path.basename(first);
  const isClaudePath = first.includes("/claude/") || first.includes("ClaudeCode.app") || base === "claude";
  if (isClaudePath || trimmed.startsWith("claude ")) {
    const helper = /\b(bg-pty-host|bg-spare|bg-worker)\b/.test(trimmed);
    return { kind: "claude", label: helper ? "claude-helper" : "claude-code", helper };
  }
  if (base === "pi" || base === "pi-coding-agent") return { kind: "pi", label: "pi", helper: false };
  if (RUNTIME_LABELS.has(base)) return { kind: "runtime", label: base, helper: false };
  return null;
}

export function parsePs(stdout) {
  const rows = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const comm = match[5];
    const classification = classifyComm(comm);
    if (!classification) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageSec: etimeToSeconds(match[3]),
      rssKb: Number(match[4]),
      kind: classification.kind,
      label: classification.label,
      helper: classification.helper,
    });
  }
  return rows;
}

export function parseLsofCwd(stdout) {
  const map = new Map();
  let pid = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith("n") && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

export function parseLsofPorts(stdout) {
  const map = new Map();
  let pid = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith("n") && pid !== null) {
      const match = /:(\d+)$/.exec(line.slice(1));
      if (!match) continue;
      const port = Number(match[1]);
      const list = map.get(pid) ?? [];
      if (!list.includes(port)) list.push(port);
      map.set(pid, list);
    }
  }
  return map;
}

export function isWithin(root, target) {
  if (typeof target !== "string" || typeof root !== "string" || !target || !root) return false;
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function bucketCwd(root, worktrees, cwd) {
  if (!cwd) return null;
  if (cwd === root) return "root";
  if (isWithin(root, cwd)) return "subdir";
  for (const wt of worktrees ?? []) {
    if (wt !== root && isWithin(wt, cwd)) return "worktree";
  }
  return null;
}

export function summarizeProcesses(rows, cwdMap, portMap, root, worktrees) {
  const matched = [];
  for (const row of rows) {
    const bucket = bucketCwd(root, worktrees, cwdMap.get(row.pid));
    if (!bucket) continue;
    const cwd = cwdMap.get(row.pid);
    const rel = cwd === root ? "." : path.relative(root, cwd);
    matched.push({ ...row, bucket, rel: rel.startsWith("..") ? "(worktree)" : rel, ports: portMap.get(row.pid) ?? [] });
  }
  const pidSet = new Set(matched.map((row) => row.pid));
  const claudePids = new Set(matched.filter((row) => row.kind === "claude").map((row) => row.pid));
  const piPids = new Set(matched.filter((row) => row.kind === "pi").map((row) => row.pid));
  const claudeSessions = matched.filter(
    (row) => row.kind === "claude" && !row.helper && !claudePids.has(row.ppid),
  ).length;
  const claudeHelpers = matched.filter((row) => row.kind === "claude" && row.helper).length;
  const piSessions = matched.filter((row) => row.kind === "pi" && !piPids.has(row.ppid)).length;
  const runtimes = matched
    .filter((row) => row.kind === "runtime")
    .sort((a, b) => a.pid - b.pid)
    .map((row) => ({ pid: row.pid, ppid: row.ppid, label: row.label, rel: row.rel, ports: row.ports, ageSec: row.ageSec }));
  return {
    claude: { sessions: claudeSessions, helpers: claudeHelpers },
    pi: { sessions: piSessions },
    runtimes: runtimes.slice(0, LIMITS.processes),
    truncated: runtimes.length > LIMITS.processes,
    matchedPids: pidSet.size,
  };
}

function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  let realA = ra;
  let realB = rb;
  try {
    realA = fs.realpathSync(ra);
  } catch {}
  try {
    realB = fs.realpathSync(rb);
  } catch {}
  return realA === realB;
}

function containsOrSame(parent, child) {
  if (samePath(parent, child)) return true;
  let p = path.resolve(parent);
  let c = path.resolve(child);
  try {
    p = fs.realpathSync(p);
  } catch {}
  try {
    c = fs.realpathSync(c);
  } catch {}
  return c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
}

export async function detectRoot(cwd, options = {}) {
  const home = path.resolve(options.home ?? homedir());
  const base = path.resolve(cwd || home);
  if (samePath(base, home) || base === path.parse(base).root) return { root: base, isRepo: false, inert: true };
  const result = await runReadOnly(["git", "rev-parse", "--show-toplevel"], { cwd: base, exec: options.exec });
  const raw = result.ok ? result.stdout.trim().split("\n")[0] : "";
  const toplevel = raw ? path.resolve(raw) : "";
  if (toplevel && !containsOrSame(toplevel, home)) return { root: toplevel, isRepo: true, inert: false };
  return { root: base, isRepo: false, inert: false };
}

export async function collectGit(root, options = {}) {
  const exec = options.exec;
  const run = (argv) => runReadOnly(argv, { cwd: root, exec, timeoutMs: options.timeoutMs });
  const toplevelResult = await run(["git", "rev-parse", "--show-toplevel"]);
  const toplevel = toplevelResult.ok ? toplevelResult.stdout.trim().split("\n")[0] : "";
  if (!toplevel || !samePath(toplevel, root)) return { unavailable: true, reason: "nonrepo" };
  const branchResult = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchResult.ok) return { unavailable: true };
  const [statusResult, logResult, upstreamResult, stashResult, worktreeResult] = await Promise.all([
    run(["git", "status", "--porcelain=v1", "-uall"]),
    run(["git", "log", "-1", "--format=%h%x00%ct%x00%s"]),
    run(["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    run(["git", "stash", "list"]),
    run(["git", "worktree", "list", "--porcelain"]),
  ]);
  const dirty = { staged: 0, unstaged: 0, untracked: 0, total: 0 };
  const files = [];
  if (statusResult.ok) {
    for (const line of statusResult.stdout.split("\n")) {
      if (line.length < 4) continue;
      const status = line.slice(0, 2);
      const file = line.slice(3);
      dirty.total += 1;
      if (status === "??") dirty.untracked += 1;
      else {
        if (status[0] !== " ") dirty.staged += 1;
        if (status[1] !== " ") dirty.unstaged += 1;
      }
      if (files.length < LIMITS.gitFiles) files.push({ status: status.trim() || "??", path: file });
    }
  }
  let head = null;
  let subject = null;
  let commitTs = null;
  if (logResult.ok) {
    const [hash, ts, rawSubject] = logResult.stdout.trim().split("\u0000");
    head = hash ?? null;
    commitTs = ts ? Number(ts) * 1000 : null;
    subject = rawSubject ? redact(rawSubject.slice(0, 72), { maxChars: 72 }) : null;
  }
  let upstream = null;
  if (upstreamResult.ok) {
    const match = /^(\d+)\s+(\d+)/.exec(upstreamResult.stdout.trim());
    if (match) upstream = { behind: Number(match[1]), ahead: Number(match[2]) };
  }
  const worktrees = [];
  if (worktreeResult.ok) {
    for (const line of worktreeResult.stdout.split("\n")) {
      if (line.startsWith("worktree ")) worktrees.push(line.slice(9).trim());
    }
  }
  return {
    branch: branchResult.stdout.trim() || null,
    head,
    subject,
    commitTs,
    dirty,
    files,
    upstream,
    stashes: stashResult.ok ? stashResult.stdout.split("\n").filter((l) => l.trim()).length : 0,
    worktrees,
  };
}

export async function collectProcesses(root, worktrees, options = {}) {
  const exec = options.exec;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const psResult = await runReadOnly(["ps", "-U", String(uid), "-o", "pid=,ppid=,etime=,rss=,comm="], {
    exec,
    timeoutMs: options.timeoutMs,
  });
  if (!psResult.ok) return { unavailable: true, reason: psResult.reason };
  const rows = parsePs(psResult.stdout);
  if (rows.length === 0) {
    return { claude: { sessions: 0, helpers: 0 }, pi: { sessions: 0 }, runtimes: [], truncated: false, matchedPids: 0 };
  }
  const pids = rows.slice(0, MAX_LSOF_PIDS).map((row) => row.pid);
  const [cwdResult, portResult] = await Promise.all([
    runReadOnly(["lsof", "-w", "-n", "-P", "-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"], {
      exec,
      timeoutMs: options.timeoutMs ?? 2500,
    }),
    runReadOnly(["lsof", "-w", "-n", "-P", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], {
      exec,
      timeoutMs: options.timeoutMs ?? 2500,
    }),
  ]);
  if (!cwdResult.ok) return { unavailable: true, reason: cwdResult.reason };
  return summarizeProcesses(
    rows,
    parseLsofCwd(cwdResult.stdout),
    portResult.ok ? parseLsofPorts(portResult.stdout) : new Map(),
    root,
    worktrees,
  );
}

function truncateName(name) {
  return safeInline(path.basename(String(name), ".jsonl"), 28) || "?";
}

async function readSessionDir(dir, now, currentFile) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(full);
      out.push({
        name: truncateName(entry.name),
        ageMs: Math.max(0, now - stat.mtimeMs),
        sizeKb: Math.round(stat.size / 1024),
        active: now - stat.mtimeMs < 10 * 60 * 1000,
        current: currentFile ? full === currentFile : false,
      });
    } catch {}
  }
  return out;
}

export function claudeProjectDirs(root, projectsDir, exists = fs.existsSync) {
  const encoded = encodeProjectDir(root);
  const dirs = [];
  let names;
  try {
    names = fs.readdirSync(projectsDir);
  } catch {
    return dirs;
  }
  for (const name of names) {
    if (name === encoded) {
      dirs.push(path.join(projectsDir, name));
      continue;
    }
    if (!name.startsWith(`${encoded}-`)) continue;
    const suffix = name.slice(encoded.length + 1);
    if (!suffix) continue;
    const candidates = [suffix, suffix.replace(/-/g, path.sep)];
    if (candidates.some((candidate) => exists(path.join(root, candidate)))) {
      dirs.push(path.join(projectsDir, name));
    }
  }
  return dirs;
}

export async function collectSessions(root, options = {}) {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now();
  const claudeProjects = options.claudeProjectsDir ?? path.join(home, ".claude", "projects");
  const piSessions = options.piSessionsDir ?? path.join(home, ".pi", "agent", "sessions");
  const claude = [];
  for (const dir of claudeProjectDirs(root, claudeProjects, options.exists)) {
    claude.push(...(await readSessionDir(dir, now, options.currentSessionFile)));
  }
  const piDir = path.join(piSessions, `-${encodeProjectDir(root)}--`);
  const pi = await readSessionDir(piDir, now, options.currentSessionFile);
  const sort = (list) => list.sort((a, b) => a.ageMs - b.ageMs).slice(0, LIMITS.sessionsPerAgent);
  return { claude: sort(claude), pi: sort(pi) };
}

const cache = new Map();

export async function snapshot(root, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 5000;
  const cached = cache.get(root);
  if (!options.force && cached && now - cached.at < maxAgeMs) return cached;
  const git = await collectGit(root, options);
  const worktrees = git?.worktrees ?? [];
  const [processes, sessions] = await Promise.all([
    collectProcesses(root, worktrees, options),
    collectSessions(root, { ...options, now }),
  ]);
  const result = {
    at: now,
    root,
    slug: projectSlug(root),
    inert: false,
    git,
    processes,
    sessions,
    warnings: [],
  };
  result.warnings = deriveWarnings(result);
  cache.set(root, result);
  return result;
}

export function clearSnapshotCache() {
  cache.clear();
}
