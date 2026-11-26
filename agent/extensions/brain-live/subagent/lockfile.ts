/**
 * Generation-numbered lock files, shared by the session lock (handles.ts) and the swarm board
 * lock (swarm.ts). Node built-ins only: child-board.ts loads this inside the children.
 *
 * State: the highest-numbered `<lock>.<N>` (readdir). It is either a holder {token, pid, at, …}
 * or a release marker {release: true}. The current (highest) file is never removed or renamed.
 * - Acquire: when there is no generation, the highest is a release marker, or its owner process
 *   is dead, create `<lock>.<N+1>` with O_EXCL. EEXIST means another contender won: retry.
 *   A live owner is never displaced, however long it holds the lock.
 * - Release: only while the holder's file is still the highest, O_EXCL create `<N+1>` as a release
 *   marker. Files below the highest are deleted lazily.
 * - `<lock>` itself (the legacy single-file lock) is a mirror written by the holder and removed
 *   before release, so existence checks keep working. A `<lock>` that does not belong to the
 *   current holder (an older build, generation 0) counts as one more owner: held while its
 *   process is alive, ignored once it is dead.
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

/** True when the owner of `held` is gone. `held` is undefined for an unreadable file. */
export type DeadCheck = (held: LockBody | undefined, file: string) => boolean;

export type LockAttempt = { ok: true; release: () => void } | { ok: false; owner?: LockBody };

/** An unreadable generation (owner died between create and write) is taken over only after this. */
const UNREADABLE_GRACE_MS = 10_000;

export function readLock(file: string): LockBody | undefined {
	try {
		const body = JSON.parse(fs.readFileSync(file, "utf-8"));
		return body && typeof body === "object" ? (body as LockBody) : undefined;
	} catch {
		return undefined;
	}
}

function generations(lock: string): number[] {
	const prefix = `${path.basename(lock)}.`;
	let names: string[];
	try {
		names = fs.readdirSync(path.dirname(lock));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
		.map((name) => Number(name.slice(prefix.length)))
		.sort((a, b) => a - b);
}

const genFile = (lock: string, n: number) => `${lock}.${n}`;
const highest = (lock: string) => generations(lock).at(-1) ?? 0;

/** The owner holding `lock` now (highest generation, then the legacy file), if it may be alive. */
function liveOwner(lock: string, isDead: DeadCheck): { n: number; owner?: LockBody; held: boolean } {
	const n = highest(lock);
	if (n > 0) {
		const file = genFile(lock, n);
		const body = readLock(file);
		if (!body) {
			let age = 0;
			try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone: a newer one exists */ }
			if (age <= UNREADABLE_GRACE_MS) return { n, held: true };
		} else if (!body.release && !isDead(body, file)) return { n, owner: body, held: true };
		// A release marker or a dead holder: free, unless a live legacy owner holds `<lock>`.
	}
	const legacy = readLock(lock);
	const current = n > 0 ? readLock(genFile(lock, n)) : undefined;
	if (legacy && !(current?.token && legacy.token === current.token) && !isDead(legacy, lock)) return { n, owner: legacy, held: true };
	return { n, held: false };
}

function prune(lock: string, below: number): void {
	for (const n of generations(lock)) {
		if (n >= below) break;
		try { fs.unlinkSync(genFile(lock, n)); } catch { /* another process pruned it */ }
	}
}

const unique = () => `${process.pid}-${randomBytes(6).toString("hex")}`;

/** Non-blocking: one acquisition, retried only when another contender won the same generation. */
export function tryLock(lock: string, data: Record<string, unknown>, isDead: DeadCheck): LockAttempt {
	for (let attempt = 0; attempt < 5; attempt++) {
		const state = liveOwner(lock, isDead);
		if (state.held) return { ok: false, owner: state.owner };
		const n = state.n + 1;
		const body: LockBody = { ...data, pid: process.pid, at: Date.now(), token: unique() };
		try {
			fs.writeFileSync(genFile(lock, n), JSON.stringify(body), { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		// Valid only while ours is the highest: a contender that read an older state lost the O_EXCL race.
		if (highest(lock) !== n) continue;
		try { fs.writeFileSync(lock, JSON.stringify(body), { mode: 0o600 }); } catch { /* the mirror is advisory */ }
		prune(lock, n);
		let released = false;
		return {
			ok: true,
			release: () => {
				if (released) return;
				released = true;
				if (highest(lock) !== n) return; // never touch a newer generation
				if (readLock(lock)?.token === body.token) {
					try { fs.unlinkSync(lock); } catch { /* gone */ }
				}
				try {
					fs.writeFileSync(genFile(lock, n + 1), JSON.stringify({ release: true, token: body.token, pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
				} catch {
					return;
				}
				prune(lock, n + 1);
			},
		};
	}
	return { ok: false, owner: liveOwner(lock, isDead).owner };
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
