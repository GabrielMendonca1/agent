/**
 * Continuable subagent tasks: invocation snapshot, handle registry and session lock.
 *
 * Job status is unchanged: every job (launch or continue) still ends completed,
 * failed, cancelled or timeout. The per-task lifecycle lives here instead:
 *
 *   running  a job is driving this child session right now;
 *   waiting  the child finished its turn, the process exited, JSONL and worktree
 *            stay alive; `continue` wakes it with a new message;
 *   closed   integrated, discarded, worktree removed, or nothing to resume.
 *
 * Storage: <baseDir>/<sessionId>/handles/registry.json (0600, tmp+rename). It is
 * kept out of the job directory listing (`*.json` at the top level are job records).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ownerMayBeAlive, readProcessIdentity, type ProcessIdentity } from "./process-owner.ts";

/** Everything needed to rebuild the child argv byte for byte on `continue`. */
export interface ChildInvocation {
	version: 1;
	/** `agy` keeps no Pi JSONL: such tasks can only be relaunched. */
	runner: "pi" | "agy";
	agent: string;
	agentSource: "bundled" | "user" | "project";
	/** Role file and its sha256 at launch; `continue` warns when the file changed. */
	roleFile?: string;
	roleSha?: string;
	/** Effective selection. A quota failure may switch `model`/`thinking` (fallback or `continue`). */
	model?: string;
	modelLabel?: string;
	thinking?: string;
	/** `--tools` value; undefined means the Pi default set (no flag). */
	tools?: string[];
	sandbox?: "seatbelt" | "bwrap" | "none";
	/** `-e` extensions, in argv order. */
	extensions: string[];
	/** Role system prompt text (written to a temp file for `--system-prompt`). */
	systemPrompt: string;
	/** Effective child cwd (inside the worktree for isolated writers). */
	cwd: string;
	/** Checkout the isolated worktree came from; absent when the child ran in place. */
	sourceCwd?: string;
	/** Role can edit/write: a continue without worktree captures a writer checkpoint. */
	writes: boolean;
}

export type HandleLifecycle = "running" | "waiting" | "closed";

export interface HandleEntry {
	handle: string;
	agent: string;
	/** Launch job and 1-based task index: owner of the worktree and the first turn. */
	jobId: string;
	taskIndex: number;
	/** Latest job that drove this session (launch or continue). */
	lastJobId: string;
	lifecycle: HandleLifecycle;
	closedReason?: string;
	sessionFile?: string;
	cwd?: string;
	worktree?: string;
	branch?: string;
	invocation?: ChildInvocation;
	/** Number of `continue` jobs started on this handle. */
	continues: number;
	/** Provider failure class of the last run ("quota"); `continue` accepts `model` only then. */
	failure?: string;
	/** Hard timeout of the last run: WIP commit left in the worktree. */
	wipCommit?: string;
	createdAt: number;
	updatedAt: number;
}

export interface HandleRegistry {
	version: 1;
	/** Next auto number per role (`<role>-<n>`), never reused within the session. */
	counters: Record<string, number>;
	handles: Record<string, HandleEntry>;
}

const HANDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export function validHandleName(name: string): boolean {
	return HANDLE_NAME.test(name);
}

export function registryPath(baseDir: string, sessionId: string): string {
	return path.join(baseDir, sessionId, "handles", "registry.json");
}

export function readRegistry(baseDir: string, sessionId: string): HandleRegistry {
	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath(baseDir, sessionId), "utf-8")) as HandleRegistry;
		if (parsed?.version === 1 && parsed.handles && parsed.counters) return parsed;
	} catch {
		/* missing or unreadable: start empty */
	}
	return { version: 1, counters: {}, handles: {} };
}

function writeRegistry(baseDir: string, sessionId: string, registry: HandleRegistry): void {
	const file = registryPath(baseDir, sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Synchronous read-modify-write: one event-loop tick, so tasks of one process never interleave. */
export function updateRegistry<T>(baseDir: string, sessionId: string, change: (registry: HandleRegistry) => T): T {
	const registry = readRegistry(baseDir, sessionId);
	const out = change(registry);
	writeRegistry(baseDir, sessionId, registry);
	return out;
}

/** Names that would collide with a handle already registered (any lifecycle). */
export function takenHandles(baseDir: string, sessionId: string, names: string[]): string[] {
	const registry = readRegistry(baseDir, sessionId);
	return names.filter((name) => registry.handles[name]);
}

/** Reserve one handle per task: the caller's name, or the next `<role>-<n>`. */
export function assignHandles(
	registry: HandleRegistry,
	tasks: Array<{ agent: string; name?: string }>,
	jobId: string,
	now: number,
): string[] {
	return tasks.map((task, index) => {
		let handle = task.name;
		if (!handle) {
			let n = registry.counters[task.agent] ?? 1;
			while (registry.handles[`${task.agent}-${n}`]) n++;
			handle = `${task.agent}-${n}`;
			registry.counters[task.agent] = n + 1;
		}
		registry.handles[handle] = {
			handle,
			agent: task.agent,
			jobId,
			taskIndex: index + 1,
			lastJobId: jobId,
			lifecycle: "running",
			continues: 0,
			createdAt: now,
			updatedAt: now,
		};
		return handle;
	});
}

export function findHandle(registry: HandleRegistry, jobId: string, taskIndex: number): HandleEntry | undefined {
	const all = Object.values(registry.handles);
	return all.find((h) => h.jobId === jobId && h.taskIndex === taskIndex) ?? all.find((h) => h.lastJobId === jobId && taskIndex === 1);
}

export function fileSha(file: string | undefined): string | undefined {
	if (!file) return undefined;
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return undefined;
	}
}

interface LockOwner {
	pid: number;
	identity?: ProcessIdentity;
	jobId: string;
	at: number;
}

export function sessionLockPath(sessionFile: string): string {
	return `${sessionFile}.continue.lock`;
}

/**
 * O_EXCL lock next to the child JSONL: one continue per session at a time, also
 * across parent processes. A lock whose owner process is gone is taken over.
 */
export function acquireSessionLock(sessionFile: string, jobId: string): { ok: true; release: () => void } | { ok: false; owner?: LockOwner } {
	const file = sessionLockPath(sessionFile);
	const owner: LockOwner = { pid: process.pid, identity: readProcessIdentity(process.pid), jobId, at: Date.now() };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
			let released = false;
			return {
				ok: true,
				release: () => {
					if (released) return;
					released = true;
					try {
						const current = JSON.parse(fs.readFileSync(file, "utf-8")) as LockOwner;
						if (current.pid === owner.pid && current.jobId === owner.jobId) fs.unlinkSync(file);
					} catch {
						/* already gone */
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let held: LockOwner | undefined;
		try {
			held = JSON.parse(fs.readFileSync(file, "utf-8")) as LockOwner;
		} catch {
			held = undefined;
		}
		// Unreadable lock: a writer may be between create and write; treat as held.
		if (!held || ownerMayBeAlive(held.pid, held.identity)) return { ok: false, owner: held };
		try {
			fs.unlinkSync(file);
		} catch {
			/* someone else took it over first; retry decides */
		}
	}
	return { ok: false };
}
