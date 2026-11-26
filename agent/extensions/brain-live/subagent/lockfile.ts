/**
 * O_EXCL lock files shared by the continue/session lock (handles.ts) and the swarm board
 * lock (swarm.ts). Node built-ins only: child-board.ts loads this inside the children.
 *
 * - Each holder writes a unique token (pid + random); release removes the file only while
 *   it still carries that token, so an owner that lost the lock never deletes the replacement.
 * - A stale lock is taken over atomically: rename it to a unique tombstone (only one renamer
 *   wins), re-check that the tombstone is the stale lock that was judged, then O_EXCL create.
 *   A renamer that moved a fresh lock by mistake links it back (link fails if a newer lock exists).
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

export interface LockBody {
	token: string;
	pid: number;
	at: number;
	[key: string]: unknown;
}

/** `held` is undefined when the lock file is unreadable (an owner between create and write). */
export type StaleCheck = (held: LockBody | undefined, file: string) => boolean;

export type LockAttempt = { ok: true; release: () => void } | { ok: false; owner?: LockBody };

export function readLock(file: string): LockBody | undefined {
	try {
		const body = JSON.parse(fs.readFileSync(file, "utf-8"));
		return body && typeof body === "object" ? (body as LockBody) : undefined;
	} catch {
		return undefined;
	}
}

const unique = () => `${process.pid}-${randomBytes(6).toString("hex")}`;
const same = (a: LockBody | undefined, b: LockBody | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Put a wrongly moved lock back; never over a lock created in the meantime. */
function restore(tomb: string, file: string): void {
	try { fs.linkSync(tomb, file); } catch { /* a newer lock exists: it wins */ }
	try { fs.unlinkSync(tomb); } catch { /* gone */ }
}

/** Rename-verify takeover of the lock judged stale as `held`; true when it is gone. */
function takeOver(file: string, held: LockBody | undefined, isStale: StaleCheck): boolean {
	const tomb = `${file}.stale-${unique()}`;
	try {
		fs.renameSync(file, tomb);
	} catch {
		return false; // another contender moved it first
	}
	const moved = readLock(tomb);
	if (same(moved, held) && isStale(moved, tomb)) {
		try { fs.unlinkSync(tomb); } catch { /* gone */ }
		return true;
	}
	restore(tomb, file);
	return false;
}

function release(file: string, token: string): void {
	if (readLock(file)?.token !== token) return; // lost to a takeover: the file is someone else's
	const tomb = `${file}.release-${unique()}`;
	try {
		fs.renameSync(file, tomb);
	} catch {
		return;
	}
	if (readLock(tomb)?.token === token) {
		try { fs.unlinkSync(tomb); } catch { /* gone */ }
	} else restore(tomb, file);
}

/** Non-blocking: one create, plus a takeover when the current lock is stale. */
export function tryLock(file: string, data: Record<string, unknown>, isStale: StaleCheck): LockAttempt {
	const token = unique();
	const body: LockBody = { ...data, pid: process.pid, at: Date.now(), token };
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify(body), { flag: "wx", mode: 0o600 });
			let released = false;
			return { ok: true, release: () => { if (!released) { released = true; release(file, token); } } };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const held = readLock(file);
		if (!isStale(held, file)) return { ok: false, owner: held };
		takeOver(file, held, isStale);
	}
	return { ok: false, owner: readLock(file) };
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Blocking variant: retries every 10 ms until `waitMs`. */
export function waitLock(file: string, data: Record<string, unknown>, isStale: StaleCheck, waitMs: number): LockAttempt {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const attempt = tryLock(file, data, isStale);
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
