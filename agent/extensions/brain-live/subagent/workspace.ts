import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitLock, type LockBody } from "./lockfile.ts";
import { ownerMayBeAlive, readProcessIdentity, type ProcessIdentity } from "./process-owner.ts";

export interface ActiveWorkspaceEntry {
	id: string;
	kind: "session" | "job";
	pid: number;
	identity?: ProcessIdentity;
	branch: string;
	worktree: string;
	sourceBranch?: string;
	scope?: string;
	startedAt: number;
}

function gitCommonDir(cwd: string): string {
	const commonDir = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).replace(/\r?\n$/, "");
	return fs.realpathSync(commonDir);
}

export function repoKey(cwd: string): string {
	return createHash("sha256").update(gitCommonDir(cwd)).digest("hex").slice(0, 16);
}

function repoDir(commonDir: string): string {
	// Git metadata is shared by every checkout and profile, unlike PI_CODING_AGENT_DIR.
	const dir = path.join(commonDir, "agent-workspace");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

const ownerIsDead = (owner: LockBody): boolean => !ownerMayBeAlive(owner.pid, owner.identity as ProcessIdentity | undefined);

function ownerLabel(owner?: LockBody): string {
	return owner ? `PID ${owner.pid}, branch ${owner.branch ?? "(unknown)"}` : "owner unavailable";
}

function withState<T>(cwd: string, fn: (entries: ActiveWorkspaceEntry[]) => { value: T; changed?: boolean }): T {
	const dir = repoDir(gitCommonDir(cwd));
	const lock = waitLock(path.join(dir, "state.lock"), { identity: readProcessIdentity(process.pid) }, ownerIsDead, 5_000);
	if (!lock.ok) throw new Error(`Timed out waiting for workspace state lock (${ownerLabel(lock.owner)}).`);
	try {
		const file = path.join(dir, "state.json");
		let raw: string | undefined;
		try { raw = fs.readFileSync(file, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const stored: ActiveWorkspaceEntry[] = raw === undefined ? [] : JSON.parse(raw);
		const entries = stored.filter((entry) => ownerMayBeAlive(entry.pid, entry.identity) && fs.existsSync(entry.worktree));
		const pruned = entries.length !== stored.length;
		const { value, changed } = fn(entries);
		if (pruned || changed) {
			const tmp = `${file}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(entries) + "\n", { flag: "wx", mode: 0o600 });
				fs.renameSync(tmp, file);
			} finally { fs.rmSync(tmp, { force: true }); }
		}
		return value;
	} finally { lock.release(); }
}

export function registerWorkspace(cwd: string, entry: ActiveWorkspaceEntry): void {
	withState(cwd, (entries) => {
		const index = entries.findIndex((e) => e.id === entry.id);
		const workspace = {
			...entry,
			worktree: fs.realpathSync(entry.worktree),
			identity: entry.identity ?? readProcessIdentity(entry.pid),
		};
		if (index === -1) entries.push(workspace);
		else entries[index] = workspace;
		return { value: undefined, changed: true };
	});
}

export function unregisterWorkspace(cwd: string, id: string): void {
	withState(cwd, (entries) => {
		const index = entries.findIndex((e) => e.id === id);
		if (index !== -1) entries.splice(index, 1);
		return { value: undefined, changed: index !== -1 };
	});
}

export function updateWorkspaceScope(cwd: string, id: string, scope?: string): boolean {
	return withState(cwd, (entries) => {
		const entry = entries.find((e) => e.id === id);
		if (!entry) return { value: false };
		entry.scope = scope;
		return { value: true, changed: true };
	});
}

export function listActiveWorkspaces(cwd: string): ActiveWorkspaceEntry[] {
	return withState(cwd, (entries) => ({ value: entries }));
}

/** Serialize checkout removal with registerWorkspace, which resolves the path under this same lock. */
export function withUnsharedWorkspace<T>(cwd: string, worktree: string, ownerId: string | undefined, fn: () => T): T {
	return withState(cwd, (entries) => {
		const checkout = fs.realpathSync(worktree);
		if (entries.some((entry) => entry.id !== ownerId && entry.worktree === checkout)) {
			throw new Error("Another active workspace owner is using this checkout.");
		}
		return { value: fn() };
	});
}

export function hasOtherActiveWriter(cwd: string, excludeId?: string): boolean {
	return listActiveWorkspaces(cwd).some((entry) => entry.id !== excludeId);
}

const integrating = new Set<string>();

function integrateLock(key: string) {
	return path.join(repoDir(key), "integrate.lock");
}

export async function withRepoIntegrateLock<T>(cwd: string, fn: () => T | Promise<T>, options: { branch?: string; timeoutMs?: number } = {}): Promise<T> {
	const key = gitCommonDir(cwd);
	if (integrating.has(key)) throw new Error("Worktree management already in progress for this repository.");
	integrating.add(key);
	try {
		const file = integrateLock(key);
		const branch = options.branch ?? execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
		const owner = { branch, identity: readProcessIdentity(process.pid) };
		const deadline = Date.now() + (options.timeoutMs ?? 60_000);
		for (;;) {
			const lock = waitLock(file, owner, ownerIsDead, 0);
			if (lock.ok) {
				try { return await fn(); }
				finally { lock.release(); }
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Timed out waiting for repository integration lock (${ownerLabel(lock.owner)}).`);
			// A blocking wait here could stall a gate on another repository in this process.
			await delay(Math.min(remaining, 50));
		}
	} finally { integrating.delete(key); }
}

/** Synchronous GC is best effort; never wait for an integration. */
export function tryRepoIntegrateLock(cwd: string, branch: string, fn: () => void): boolean {
	const key = gitCommonDir(cwd);
	if (integrating.has(key)) return false;
	const lock = waitLock(integrateLock(key), { branch, identity: readProcessIdentity(process.pid) }, ownerIsDead, 0);
	if (!lock.ok) return false;
	integrating.add(key);
	try { fn(); return true; }
	finally {
		try { lock.release(); }
		finally { integrating.delete(key); }
	}
}

export function validateWorktreeSlug(slug: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(slug) && !slug.includes("..");
}
