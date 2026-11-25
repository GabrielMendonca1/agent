#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "checks-runner-test-"));
process.env.PI_CHECKS_CACHE_DIR = join(temp, "cache");
const { baseline, gate, runChecks, compare, resultOk, writeLastRun, lastRun, lastRunLine, repoLockPath, withRepoLock } = await import("../agent/extensions/brain-live/checks/runner.ts");
const root = join(temp, "repo");
mkdirSync(root);
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const node = (code) => `${quote(process.execPath)} -e ${quote(code)}`;
const events = join(temp, "events");
const check = (name, tags = []) => ({ name, tags, cmd: node(`const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(name + "\n")}); process.exit(fs.existsSync('fail-${name}') ? 1 : 0);`) });
const manifest = { root, checks: [check("a", ["fast"]), check("b")], parallel: 2, defaultTimeoutMs: 2000, link: [] };
const log = () => existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean) : [];
const worktrees = () => git("worktree", "list", "--porcelain");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const dead = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { if (e.code === "ESRCH") return true; throw e; } };

try {
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "tracked"), "base\n");
  git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  const sha = git("rev-parse", "HEAD");
  const before = worktrees();
  let phases = 0;
  const green = await gate(manifest, { baselineOptions: { onPhase: () => phases++ } });
  assert.equal(green.ok, true);
  assert.equal(green.baselineSkipped, true);
  assert.match(green.verdict, /baseline dispensada/);
  assert.equal(phases, 0);
  assert.equal(existsSync(process.env.PI_CHECKS_CACHE_DIR), false);
  assert.equal(worktrees(), before);

  await baseline(manifest, { tags: ["fast"] });
  const partialCount = log().length;
  const full = await baseline(manifest);
  assert.equal(full.cached, false);
  assert.deepEqual(full.results.map((r) => r.name), ["a", "b"]);
  assert.deepEqual(log().slice(partialCount), ["b"]);
  const cachedResults = [];
  assert.equal((await baseline(manifest, {
    onPhase: () => assert.fail("cache hit must not prepare a worktree"),
    onStart: () => assert.fail("cache hit must not spawn checks"),
    onResult: (r) => cachedResults.push(r.name),
  })).cached, true);
  assert.deepEqual(cachedResults, ["a", "b"]);
  assert.equal(log().length, partialCount + 1);
  const changed = { ...manifest, checks: [{ ...manifest.checks[0], cmd: manifest.checks[0].cmd + " " }, manifest.checks[1]] };
  await baseline(changed);
  assert.deepEqual(log().slice(partialCount + 1), ["a"]);
  const timeoutChanged = { ...changed, defaultTimeoutMs: 2500 };
  const count = log().length;
  await baseline(timeoutChanged);
  assert.deepEqual(log().slice(count).sort(), ["a", "b"]);
  assert.deepEqual(compare(full.results, green.results).newFailures, []);
  console.log("ok per-check reuse, selection order, cmd and timeout fingerprints");

  // V1 cannot prove a fingerprint. It is a miss, even for a matching name.
  const slug = root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const cacheFile = join(process.env.PI_CHECKS_CACHE_DIR, slug, `${sha}.json`);
  writeFileSync(cacheFile, JSON.stringify({ sha, results: full.results }));
  assert.equal((await baseline(manifest, { tags: ["fast"] })).cached, false);
  writeFileSync(join(root, "fail-b"), "");
  const tagged = await gate(manifest, { tags: ["fast"] });
  assert.equal(tagged.ok, true);
  const gated = await gate(manifest);
  assert.equal(gated.ok, false);
  assert.deepEqual(gated.comparison.newFailures, ["b"]);
  assert.equal(worktrees(), before);
  const inherited = { ...manifest, checks: [manifest.checks[0], { ...manifest.checks[1], cmd: node("process.exit(1)") }] };
  rmSync(cacheFile);
  await baseline(inherited, { tags: ["fast"] });
  const inheritedGate = await gate(inherited);
  assert.equal(inheritedGate.ok, true);
  assert.deepEqual(inheritedGate.comparison.newFailures, []);
  assert.deepEqual(inheritedGate.comparison.stillFailing, ["b"]);
  console.log("ok tags then full gate: no missing-name false failures");

  rmSync(cacheFile);
  const starts = [];
  const failedOnly = await gate(manifest, { baselineOptions: { onStart: (c) => starts.push(c.name) } });
  assert.equal(failedOnly.ok, false);
  assert.deepEqual(starts, ["b"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(cacheFile)).results), ["b"]);
  assert.equal(resultOk({ results: failedOnly.results }), false);
  assert.equal(resultOk({ ok: false, results: green.results }), false);
  assert.equal(resultOk({ ok: true, results: failedOnly.results }), true);
  const unavailable = await gate(manifest, { baselineOptions: { sha: "not-a-commit" } });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.verdict, /baseline indisponível/);
  console.log("ok baseline only failed names; green skips worktree; renderer ok fallback");

  const oldDir = join(process.env.PI_CHECKS_CACHE_DIR, "old-project");
  mkdirSync(oldDir);
  const oldFile = join(oldDir, "abcdef.json");
  writeFileSync(oldFile, "{}");
  const old = new Date(Date.now() - 15 * 86400000);
  utimesSync(oldFile, old, old);
  await baseline(manifest, { names: ["a"], refresh: true });
  assert.equal(existsSync(oldDir), false);
  console.log("ok cache GC across slugs");

  const pidFile = join(temp, "pid");
  const long = { ...manifest, parallel: 1, checks: [
    { name: "long", cmd: `sh -c ${quote(`sleep 30 & echo $! > ${quote(pidFile)}; wait`)}`, timeoutMs: 60000 },
    { name: "never", cmd: node(`require('node:fs').writeFileSync(${JSON.stringify(join(temp, "never"))}, '')`) },
  ] };
  for (const mode of ["run", "baseline"]) {
    rmSync(pidFile, { force: true });
    const controller = new AbortController();
    const started = [];
    const options = { signal: controller.signal, onStart: (c) => started.push(c.name), refresh: true };
    const promise = mode === "run" ? runChecks(long, options) : baseline(long, options);
    // Attach rejection handler before abort.
    const rejected = assert.rejects(promise, { name: "AbortError" });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await pause(10);
    assert.ok(existsSync(pidFile), "grandchild started");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    controller.abort();
    await rejected;
    for (let i = 0; i < 100 && !dead(pid); i++) await pause(20);
    assert.ok(dead(pid), `grandchild ${pid} died after ${mode} abort`);
    assert.deepEqual(started, ["long"]);
    assert.equal(existsSync(join(temp, "never")), false);
    assert.equal(worktrees(), before);
  }
  console.log("ok abort kills grandchild, stops queue, removes baseline worktree");
  assert.ok(readdirSync(process.env.PI_CHECKS_CACHE_DIR).length > 0);

  // checks last: HEAD + working-tree fingerprint decide fresh/stale; the record is never trusted blindly.
  rmSync(join(root, "fail-b"), { force: true });
  assert.equal(lastRun(root).status, "missing");
  const lastGate = await gate(manifest, { tags: ["fast"] });
  assert.ok(writeLastRun(root, { action: "gate", selection: { tags: ["fast"] }, ...lastGate }));
  const fresh = lastRun(root);
  assert.equal(fresh.status, "fresh");
  assert.match(lastRunLine(fresh), /^gate tags=fast: 1\/1 green, new failures: \[\] \(fresh; [0-9a-f]{8} at /);
  const diverged = () => { const s = lastRun(root); return s.status === "stale" ? s.diverged : s.status; };
  writeFileSync(join(root, "tracked"), "edited\n");
  assert.deepEqual(diverged(), ["status", "diff"]);
  writeFileSync(join(root, "tracked"), "base\n");
  assert.equal(diverged(), "fresh");
  writeFileSync(join(root, "untracked"), "one");
  assert.deepEqual(diverged(), ["status", "untracked"]);
  assert.ok(writeLastRun(root, { action: "run", selection: {}, ok: true, verdict: "OK", results: lastGate.results }));
  assert.equal(diverged(), "fresh");
  writeFileSync(join(root, "untracked"), "two");
  assert.deepEqual(diverged(), ["untracked"], "same porcelain, different untracked content");
  writeFileSync(join(root, "untracked"), "one");
  git("add", "untracked");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "untracked");
  assert.deepEqual(diverged(), ["head", "status", "untracked"]);
  assert.match(lastRunLine(lastRun(root)), /^run: 1\/1 green, failures: \[\] \(stale: head, status, untracked changed since; /);
  const cacheEntries = readdirSync(join(process.env.PI_CHECKS_CACHE_DIR, slug));
  assert.ok(cacheEntries.includes("ultima-rodada.json"));
  assert.deepEqual(cacheEntries.filter((name) => name.endsWith(".tmp")), [], "atomic writes leave no temp files");
  console.log("ok last run: fresh, stale by head/status/diff/untracked, atomic write");

  // Repo lock in git-common-dir: serializes, takes over a dead owner, waits for a live one.
  const lockFile = repoLockPath(root);
  assert.equal(lockFile, join(root, ".git", "pi-checks.lock"));
  let inside = 0;
  let overlap = false;
  const hold = () => withRepoLock(root, async () => { inside++; if (inside > 1) overlap = true; await pause(40); inside--; });
  await Promise.all([hold(), hold(), hold()]);
  assert.equal(overlap, false);
  assert.equal(existsSync(lockFile), false, "lock released");
  const zombie = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();
  writeFileSync(lockFile, JSON.stringify({ pid: Number(zombie), host: (await import("node:os")).hostname(), at: Date.now(), token: "dead" }));
  assert.equal(await withRepoLock(root, () => "taken"), "taken");
  assert.equal(existsSync(lockFile), false);
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), at: Date.now(), token: "live" }));
  const waiting = new AbortController();
  let waited = false;
  const blocked = assert.rejects(withRepoLock(root, () => assert.fail("live lock must not be stolen"), { signal: waiting.signal, onWait: () => { waited = true; } }), { name: "AbortError" });
  await pause(150);
  waiting.abort();
  await blocked;
  assert.ok(waited);
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).token, "live");
  rmSync(lockFile);
  console.log("ok repo lock: serial, dead-owner takeover, live owner respected");
  console.log("checks-runner: all passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
