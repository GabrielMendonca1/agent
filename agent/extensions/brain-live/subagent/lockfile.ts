/**
 * Generation-numbered lock files, shared by the session lock (handles.ts) and the swarm board
 * lock (swarm.ts). Node built-ins only: child-board.ts loads this inside the children.
 *
 * State: the highest-numbered `<lock>.<N>` (readdir). It is either a holder {token, pid, at, …}
 * or a release marker {release: true}. The current (highest) file is never removed or renamed.
 * - Every generation file is complete when it appears: the record is written and fsynced to a
 *   unique temp file, then hard-linked to `<lock>.<N>` (link fails with EEXIST if that generation
 *   exists). An unparseable generation file is corruption and fails closed with an error.
 * - Acquire: when there is no generation, the highest is a release marker, or its owner process
 *   is dead, link `<lock>.<N+1>`. EEXIST means another contender won: retry. A live owner is
 *   never displaced, however long it holds the lock.
 * - Release: link `<N+1>` as a release marker (EEXIST: a newer generation exists). A release that
 *   fails throws and stays pending in this process: it is retried at every later acquire or
 *   release and on an unref'd 5 s timer until it succeeds.
 * - Files below the highest and temp files older than a minute are deleted lazily.
 * - `<lock>` itself is the single-file lock of older builds. It is only read, never written or
 *   deleted: a live owner blocks, a dead one is ignored. Mixed old/new processes are unsupported.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LockBody {
	token: string;
	pid: number;
	at: number;
	release?: boolean;
	[key: string]: unknown;
}

/** True when the owner of `held` is gone. */
export type DeadCheck = (held: LockBody, file: string) => boolean;

export type LockAttempt = { ok: true; release: () => void } | { ok: false; owner?: LockBody };

const TEMP_MAX_AGE_MS = 60_000;
const PENDING_RETRY_MS = 5_000;

type Read = { state: "ok"; body: LockBody } | { state: "missing" } | { state: "corrupt"; error: string };

function readStrict(file: string): Read {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
		return { state: "corrupt", error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const body = JSON.parse(raw);
		if (body && typeof body === "object" && !Array.isArray(body)) return { state: "ok", body: body as LockBody };
	} catch {
		/* reported below */
	}
	return { state: "corrupt", error: "not a lock record" };
}

/** Lenient read for callers that only inspect (tests, status). */
export function readLock(file: string): LockBody | undefined {
	const read = readStrict(file);
	return read.state === "ok" ? read.body : undefined;
}

function entries(lock: string): string[] {
	try {
		return fs.readdirSync(path.dirname(lock));
	} catch {
		return [];
	}
}

function generations(lock: string): number[] {
	const prefix = `${path.basename(lock)}.`;
	return entries(lock)
		.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
		.map((name) => Number(name.slice(prefix.length)))
		.sort((a, b) => a - b);
}

const genFile = (lock: string, n: number) => `${lock}.${n}`;
const highest = (lock: string) => generations(lock).at(-1) ?? 0;
const unique = () => `${process.pid}-${randomBytes(6).toString("hex")}`;

/** Writes the full record to a temp file, fsyncs it, then links it into place. False on EEXIST. */
function publish(file: string, body: Record<string, unknown>): boolean {
	const tmp = `${path.dirname(file)}/${path.basename(file).replace(/\.\d+$/, "")}.tmp-${unique()}`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		try {
			fs.writeSync(fd, JSON.stringify(body));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.linkSync(tmp, file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* already gone */ }
	}
}

/** The owner holding `lock` now (highest generation, then the legacy file), if it may be alive. */
function liveOwner(lock: string, isDead: DeadCheck): { n: number; owner?: LockBody; held: boolean } {
	for (;;) {
		const n = highest(lock);
		if (n > 0) {
			const file = genFile(lock, n);
			const read = readStrict(file);
			if (read.state === "missing") continue; // pruned after a newer generation appeared: look again
			if (read.state === "corrupt") throw new Error(`Lock file ${file} is corrupt (${read.error}); refusing to take it over. Remove it after checking that no process uses it.`);
			if (!read.body.release && !isDead(read.body, file)) return { n, owner: read.body, held: true };
		}
		// Legacy single-file lock of an older build: read only. A live owner blocks; a dead one is ignored.
		const legacy = readLock(lock);
		if (legacy && !isDead(legacy, lock)) return { n, owner: legacy, held: true };
		return { n, held: false };
	}
}

function prune(lock: string, below: number): void {
	for (const n of generations(lock)) {
		if (n >= below) break;
		try { fs.unlinkSync(genFile(lock, n)); } catch { /* another process pruned it */ }
	}
	const prefix = `${path.basename(lock)}.tmp-`;
	for (const name of entries(lock)) {
		if (!name.startsWith(prefix)) continue;
		const file = path.join(path.dirname(lock), name);
		try {
			if (Date.now() - fs.statSync(file).mtimeMs > TEMP_MAX_AGE_MS) fs.unlinkSync(file);
		} catch { /* gone */ }
	}
}

// Releases that failed: retried before every acquire/release in this process and on a timer.
const pending = new Set<() => boolean>();
let pendingTimer: ReturnType<typeof setInterval> | undefined;

function retryPending(): void {
	for (const retry of [...pending]) if (retry()) pending.delete(retry);
	if (pending.size === 0 && pendingTimer) {
		clearInterval(pendingTimer);
		pendingTimer = undefined;
	}
}

function schedulePending(retry: () => boolean): void {
	pending.add(retry);
	if (!pendingTimer) {
		pendingTimer = setInterval(retryPending, PENDING_RETRY_MS);
		pendingTimer.unref?.();
	}
}

/** Releases that failed and are still being retried in this process. */
export function pendingReleases(): number {
	return pending.size;
}

/** Non-blocking: one acquisition, retried only when another contender won the same generation. */
export function tryLock(lock: string, data: Record<string, unknown>, isDead: DeadCheck): LockAttempt {
	retryPending();
	for (let attempt = 0; attempt < 5; attempt++) {
		const state = liveOwner(lock, isDead);
		if (state.held) return { ok: false, owner: state.owner };
		const n = state.n + 1;
		const body: LockBody = { ...data, pid: process.pid, at: Date.now(), token: unique() };
		if (!publish(genFile(lock, n), body)) continue;
		// Valid only while ours is the highest: a contender that read an older state lost the link race.
		if (highest(lock) !== n) continue;
		prune(lock, n);
		let released = false;
		let lastError = "";
		const attemptRelease = (): boolean => {
			if (released) return true;
			try {
				if (!publish(genFile(lock, n + 1), { release: true, token: body.token, pid: process.pid, at: Date.now() })) {
					lastError = "a newer generation already exists";
					released = true; // nothing left to release: the lock moved on
					return true;
				}
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				return false;
			}
			released = true;
			prune(lock, n + 1);
			return true;
		};
		return {
			ok: true,
			/** Throws when the marker cannot be written; the release stays pending and is retried. */
			release: () => {
				retryPending();
				if (released) return;
				if (attemptRelease()) {
					if (lastError) throw new Error(`Could not release lock ${genFile(lock, n)}: ${lastError}`);
					return;
				}
				schedulePending(attemptRelease);
				throw new Error(`Could not release lock ${genFile(lock, n)}: ${lastError}; retrying in the background`);
			},
		};
	}
	return { ok: false, owner: liveOwner(lock, isDead).owner };
}

/** Release each lock once; a failed release is already pending (retried in the background). Returns the errors. */
export function releaseAll(releases: Array<() => void>): string[] {
	const errors: string[] = [];
	for (const release of releases) {
		try {
			release();
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return errors;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Blocking variant: retries every 10 ms until `waitMs`. */
export function waitLock(lock: string, data: Record<string, unknown>, isDead: DeadCheck, waitMs: number): LockAttempt {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const attempt = tryLock(lock, data, isDead);
		if (attempt.ok || Date.now() > deadline) return attempt;
		sleep(10);
	}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
