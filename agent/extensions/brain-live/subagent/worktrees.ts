import { realpathSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findManifest, gate, lastRun, lastRunLine } from "../checks/runner.ts";
import type { AgentConfig } from "./agents.ts";
import type { JobRecord, JobTaskSpec } from "./jobs.ts";
import { isProjectSkill, rootForms, skillLabel } from "./skills.ts";
import { repoKey, tryRepoIntegrateLock, unregisterWorkspace, withRepoIntegrateLock } from "./workspace.ts";

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(r.stderr?.trim() || r.error?.message || `git ${args.join(" ")} failed`);
	return r.stdout.trimEnd();
}

function currentBranch(cwd: string): string | null {
	const r = spawnSync("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
	if (r.status === 1) return null;
	if (r.status !== 0) throw new Error(r.stderr?.trim() || "Cannot determine source branch.");
	return r.stdout.trim();
}

export interface IsolationOptions {
	isolate?: boolean;
	hasOtherActiveWriter?: (cwd: string, excludeId?: string) => boolean;
	excludeId?: string;
}

/** Writer tasks grouped by checkout root. Existing callers retain the local-only policy. */
export function plannedIsolation(record: Pick<JobRecord, "mode" | "tasks" | "cwd" | "swarm">, agents: AgentConfig[], options?: IsolationOptions): Map<string, { task: JobTaskSpec; index: number; cwd: string }[]> {
	const groups = new Map<string, { task: JobTaskSpec; index: number; cwd: string }[]>();
	if (options?.isolate === false) return groups;
	if (record.mode === "swarm") {
		const writer = record.tasks[0];
		if (!(options?.isolate ?? record.swarm?.isolate) || !writer) return groups;
		const cwd = path.resolve(writer.cwd ?? record.cwd);
		let root: string;
		// Fail closed: isolation was requested, so a failed lookup refuses instead of running in place.
		try { root = git(cwd, ["rev-parse", "--show-toplevel"]); } catch (error) { throw new Error(`Swarm isolate needs a git repository at ${cwd}: ${error instanceof Error ? error.message : String(error)}`); }
		groups.set(root, [{ task: writer, index: 0, cwd }]);
		return groups;
	}
	if (record.mode !== "parallel" && !(record.mode === "single" && options)) return groups;
	record.tasks.forEach((task, index) => {
		const agent = agents.find((a) => a.name === task.agent)!;
		// Lista ausente/vazia usa as ferramentas padrão, que incluem edição.
		if (agent.tools?.length && !agent.tools.some((t) => t === "edit" || t === "write")) return;
		const cwd = path.resolve(task.cwd ?? record.cwd);
		let root: string;
		try { root = git(cwd, ["rev-parse", "--show-toplevel"]); }
		catch (error) {
			if (options?.isolate === true) throw new Error(`Isolation needs a git repository at ${cwd}: ${String(error)}`);
			return;
		}
		const group = groups.get(root) ?? [];
		group.push({ task, index, cwd });
		groups.set(root, group);
	});
	if (options?.isolate === true) return groups;
	const repoByRoot = new Map<string, string>();
	const writerCounts = new Map<string, number>();
	for (const [root, group] of groups) {
		const key = options ? repoKey(root) : root;
		repoByRoot.set(root, key);
		writerCounts.set(key, (writerCounts.get(key) ?? 0) + group.length);
	}
	const activeByRepo = new Map<string, boolean>();
	for (const root of groups.keys()) {
		const key = repoByRoot.get(root)!;
		if (writerCounts.get(key)! >= 2) continue;
		const active = activeByRepo.get(key) ?? options?.hasOtherActiveWriter?.(root, options.excludeId) ?? false;
		activeByRepo.set(key, active);
		if (!active) groups.delete(root);
	}
	return groups;
}

/**
 * Launch check for a writer that will run in a worktree: project skills (isProjectSkill: lexical
 * path or resolved target inside the repository) are refused outright. Personal, company and
 * bundled skills keep their absolute path.
 */
export function worktreeSkillError(file: string, root: string, cwd?: string, shadowed: string[] = []): string | undefined {
	const roots = rootForms(root, cwd);
	if (!isProjectSkill(file, roots)) return undefined;
	// Same name elsewhere: the isolated writer must never get the project copy; refuse, naming both.
	const outside = shadowed.filter((other) => !isProjectSkill(other, roots));
	if (outside.length) return `skill "${skillLabel(file)}" resolves to the project copy ${file}, which shadows ${outside.join(", ")}; isolated writers never get project skills. Rename or remove one copy, or run the task in place.`;
	return `skill "${skillLabel(file)}" is a project skill; isolated writers only get personal, company and bundled skills. Run the task in place to use it.`;
}

export function isolateWriters(record: JobRecord, agents: AgentConfig[], persist: () => void, options?: IsolationOptions): void {
	for (const [root, group] of plannedIsolation(record, agents, options)) {
		const baseSha = git(root, ["rev-parse", "HEAD"]);
		const sourceBranch = currentBranch(root);
		for (const { task, index, cwd } of group) {
			const name = `${record.jobId}-${index + 1}`;
			const worktree = path.join(getAgentDir(), "agent", "worktrees", name);
			const branch = `agent/${name}`;
			fs.mkdirSync(path.dirname(worktree), { recursive: true });
			git(root, ["worktree", "add", "-b", branch, worktree, baseSha]);
			Object.assign(task, { worktree, branch, sourceCwd: cwd, sourceBranch, baseSha, cwd: path.join(worktree, path.relative(root, realpathSync(cwd))) });
			// Persiste antes dos links: falhas posteriores não perdem a referência durável.
			persist();
			for (const entry of findManifest(root)?.link ?? []) {
				const source = path.resolve(root, entry);
				const target = path.resolve(worktree, entry);
				if (!target.startsWith(worktree + path.sep) || !source.startsWith(root + path.sep)) throw new Error(`Invalid worktree link: ${entry}`);
				if (fs.existsSync(source) && !fs.existsSync(target)) {
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : undefined);
				}
			}
		}
	}
}

/**
 * Hard timeout: commit whatever the killed child left in its job worktree, without
 * hooks, so `continue` resumes from it. Only for the job's own worktree (the caller
 * checks); manifest `link` symlinks are never committed. Returns the sha, or
 * undefined when there was nothing to commit.
 */
export function commitWip(worktree: string, jobId: string): string | undefined {
	if (!git(worktree, ["status", "--porcelain"])) return undefined;
	const links = (findManifest(worktree)?.link ?? []).map((entry) => `:(exclude)${entry}`);
	git(worktree, ["add", "-A", "--", ".", ...links]);
	if (spawnSync("git", ["-C", worktree, "diff", "--cached", "--quiet"]).status === 0) return undefined;
	const config = (key: string) => spawnSync("git", ["-C", worktree, "config", key], { encoding: "utf8" }).stdout?.trim();
	const identity = [
		...(config("user.name") ? [] : ["-c", "user.name=Agent"]),
		...(config("user.email") ? [] : ["-c", "user.email=agent@localhost"]),
	];
	git(worktree, [...identity, "commit", "--no-verify", "-q", "-m", `WIP(agent): timeout ${jobId}`]);
	return git(worktree, ["rev-parse", "HEAD"]);
}

export function worktreeSummary(record: JobRecord): string {
	return record.tasks.flatMap((t, i) => {
		if (!t.worktree) return [];
		try {
			return [`### isolated task ${i + 1}\nworktree: ${t.worktree}\nbranch: ${t.branch}\nstatus --porcelain:\n${git(t.worktree, ["status", "--porcelain"]) || "(clean)"}\nlog ${t.baseSha}..HEAD:\n${git(t.worktree, ["log", "--oneline", `${t.baseSha}..HEAD`]) || "(no commits)"}`];
		} catch (error) { return [`### isolated task ${i + 1}\nworktree: ${t.worktree}\nbranch: ${t.branch}\n${String(error)}`]; }
	}).join("\n\n");
}

/**
 * Uma linha por tarefa de papel escritor com `checks`: o último gate/run gravado no checkout
 * da tarefa, revalidado contra HEAD + working tree (fresh/stale). Rodada anterior ao job não conta.
 */
export function gateSummary(record: JobRecord, agents: AgentConfig[]): string {
	return record.tasks.flatMap((t, i) => {
		const tools = agents.find((a) => a.name === t.agent)?.tools ?? [];
		if (!tools.includes("checks") || !(tools.includes("edit") || tools.includes("write"))) return [];
		const prefix = record.tasks.length > 1 ? `[task ${i + 1} ${t.agent}] ` : "";
		try {
			const manifest = findManifest(t.worktree ?? t.cwd ?? record.cwd);
			if (!manifest) return [];
			const state = lastRun(manifest.root);
			if (state.status === "missing" || Date.parse(state.record.at) < record.createdAt) return [`${prefix}gate: not run in this job`];
			return [prefix + lastRunLine(state)];
		} catch (error) { return [`${prefix}gate: unavailable (${error instanceof Error ? error.message : String(error)})`]; }
	}).join("\n");
}

export interface WorktreeBranch {
	worktree: string;
	branch: string;
	sourceCwd: string;
	sourceBranch?: string | null;
	handle?: string;
	worktreePathRemoved?: boolean;
	worktreeRemoved?: boolean;
}

interface WorktreeManagementOptions {
	persist?: () => void;
	workspaceId?: string;
	label?: string;
}

function assertBranchTarget(t: JobTaskSpec | WorktreeBranch): asserts t is WorktreeBranch {
	if (!t.sourceCwd || !t.branch || !t.worktree) throw new Error("Missing worktree branch or checkout metadata.");
}

function verifyTarget(t: WorktreeBranch): void {
	git(t.sourceCwd, ["check-ref-format", `refs/heads/${t.branch}`]);
	if (t.sourceBranch === t.branch || currentBranch(t.sourceCwd) === t.branch) {
		throw new Error("Worktree branch is the source checkout's branch; refusing worktree management.");
	}
	if (fs.existsSync(t.worktree)) {
		const root = (cwd: string) => realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
		const worktree = realpathSync(t.worktree);
		if (root(t.sourceCwd) === worktree || root(t.worktree) !== worktree || repoKey(t.sourceCwd) !== repoKey(t.worktree)) {
			throw new Error("Worktree must be a separate checkout of the source repository.");
		}
	}
}

function verifyDestination(t: WorktreeBranch): void {
	if (!t.sourceBranch) throw new Error("No recorded source branch (detached HEAD or legacy record); refusing integrate.");
	if (currentBranch(t.sourceCwd) !== t.sourceBranch) throw new Error(`Source branch changed; expected ${t.sourceBranch}; refusing integrate.`);
}

function remove(t: WorktreeBranch, force: boolean, discard: boolean, options: WorktreeManagementOptions): void {
	const branchExists = git(t.sourceCwd, ["branch", "--list", "--", t.branch]) !== "";
	// Do not use HEAD: the source checkout may have switched branches during cleanup.
	if (!discard && branchExists) {
		if (!t.sourceBranch) throw new Error("No recorded destination branch; refusing cleanup without discard.");
		git(t.sourceCwd, ["merge-base", "--is-ancestor", `refs/heads/${t.branch}`, `refs/heads/${t.sourceBranch}`]);
	}
	if (fs.existsSync(t.worktree)) {
		git(t.sourceCwd, ["worktree", "remove", ...(force ? ["--force"] : []), "--", t.worktree]);
	} else git(t.sourceCwd, ["worktree", "prune"]);
	t.worktreePathRemoved = true;
	options.persist?.();
	if (branchExists) git(t.sourceCwd, ["branch", "-D", "--", t.branch]);
	if (options.workspaceId) unregisterWorkspace(t.sourceCwd, options.workspaceId);
	t.worktreeRemoved = true;
	options.persist?.();
}

const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
const merging = (cwd: string) => fs.existsSync(path.join(git(cwd, ["rev-parse", "--absolute-git-dir"]), "MERGE_HEAD"));

function requireClean(cwd: string, label: string): void {
	if (merging(cwd)) throw new Error(`${label} has a merge in progress.`);
	const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
	if (dirty) throw new Error(`${label} is dirty and has uncommitted changes:\n${dirty}`);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
	const r = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], { encoding: "utf8" });
	if (r.status === 0 || r.status === 1) return r.status === 0;
	throw new Error(r.stderr?.trim() || r.error?.message || "Cannot verify Git ancestry.");
}

function merge(cwd: string, branch: string, sha: string, before: string, label: string, hint = ""): string {
	if (currentBranch(cwd) !== branch || head(cwd) !== before || merging(cwd)) {
		throw new Error(`${label}: checkout changed before merge; retry integrate.`);
	}
	const upToDate = isAncestor(cwd, sha, before);
	try {
		git(cwd, ["-c", "rerere.enabled=false", "merge", "--no-ff", "--commit", "--no-squash", "--no-edit", "--no-autostash", "--no-overwrite-ignore", sha]);
		if (merging(cwd)) throw new Error("Git stopped before committing the merge.");
	} catch (error) {
		let conflicts: string[] = [];
		let recovery = "";
		try {
			// Read conflicts before abort, but still abort if reading them fails.
			try { conflicts = git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean); }
			finally { if (merging(cwd)) git(cwd, ["merge", "--abort"]); }
			if (head(cwd) !== before || git(cwd, ["status", "--porcelain"])) throw new Error(`Checkout did not return to clean HEAD ${before}.`);
		} catch (failure) { recovery = `\nCould not confirm merge rollback: ${String(failure)}`; }
		const files = conflicts.map((file) => /[\r\n\t]/.test(file) ? JSON.stringify(file) : file);
		throw new Error(`${label}; conflicts: ${files.join(", ") || "(none)"}\n${String(error)}${recovery}${conflicts.length && hint ? `\n${hint}` : ""}`);
	}
	const merged = head(cwd);
	// Only the exact expected merge is eligible for rollback. A writer can commit
	// before Git starts the merge or after it exits, without taking our lock.
	const expected = upToDate ? merged === before : git(cwd, ["show", "-s", "--format=%P", merged]) === `${before} ${sha}`;
	if (!expected || currentBranch(cwd) !== branch) {
		throw new Error(`${label}: checkout changed during merge; leaving its commits intact. Inspect ${cwd} and retry integrate.`);
	}
	return merged;
}

function rollbackSync(t: WorktreeBranch, checkedHead: string, preMergeSha: string): void {
	if (currentBranch(t.worktree) !== t.branch || merging(t.worktree)) {
		throw new Error("Worktree branch or merge state changed during checks.");
	}
	// Compare and swap under the ref lock. A prior HEAD check followed by reset
	// could overwrite a commit made between the two Git commands.
	git(t.worktree, ["update-ref", "-m", "agent: roll back integration preview", `refs/heads/${t.branch}`, preMergeSha, checkedHead]);
	if (currentBranch(t.worktree) !== t.branch || head(t.worktree) !== preMergeSha || merging(t.worktree)) {
		throw new Error("Worktree changed during rollback; refusing to restore checkout files.");
	}
	// Refresh the index and files without moving any ref again.
	git(t.worktree, ["read-tree", "--reset", "-u", "HEAD"]);
}

export async function integrateWorktreeBranch(t: WorktreeBranch, options: WorktreeManagementOptions = {}): Promise<{ gateMessage?: string; cleanupOnly?: boolean }> {
	return withRepoIntegrateLock(t.sourceCwd, async () => {
		verifyDestination(t);
		verifyTarget(t);
		if (!fs.existsSync(t.worktree)) {
			remove(t, false, false, options);
			return { cleanupOnly: true };
		}
		const label = options.label ?? `Worktree ${t.worktree}`;
		const source = `Source ${t.sourceCwd}`;
		requireClean(t.worktree, label);
		requireClean(t.sourceCwd, source);
		const preMergeSha = head(t.worktree);
		const sourceHead = head(t.sourceCwd);
		if (currentBranch(t.worktree) !== t.branch) throw new Error(`${label} is not on ${t.branch}; refusing merge.`);
		const synced = !isAncestor(t.worktree, sourceHead, preMergeSha);
		let checkedHead = preMergeSha;
		if (synced) {
			const writer = t.handle ? `Resume the writer (${t.handle}) with subagent continue` : options.label ? "Resume the writer with subagent continue" : "Resume work in the worktree";
			checkedHead = merge(t.worktree, t.branch, sourceHead, preMergeSha, `Merge preview failed for ${t.branch}`, `${writer} to merge ${t.sourceBranch} in ${t.worktree}, resolve the conflicts, and retry integrate.`);
		}
		let gateMessage: string;
		try {
			const manifest = findManifest(t.worktree);
			if (manifest) {
				const result = await gate(manifest, { cwd: t.worktree });
				if (!result.ok) {
					const failures = result.results.filter((r) => !r.ok).map((r) => {
						const summary = r.tail.trim().replace(/\s+/g, " ").slice(-240);
						return `- ${r.name}: ${r.timedOut ? "timed out" : `exit ${r.code ?? "unknown"}`}${summary ? ` — ${summary}` : ""}`;
					});
					throw new Error(`${label}: checks gate failed: ${result.verdict}\n${failures.join("\n")}`);
				}
				gateMessage = `checks gate passed (${result.results.length} checks).`;
			} else gateMessage = "no checks manifest; orchestrator must run checks after integrate.";
			verifyDestination(t);
			requireClean(t.sourceCwd, source);
			requireClean(t.worktree, label);
			if (head(t.sourceCwd) !== sourceHead) throw new Error("Source HEAD changed during checks; retry integrate.");
			if (currentBranch(t.worktree) !== t.branch || head(t.worktree) !== checkedHead) throw new Error("Worktree HEAD changed during checks; refusing merge.");
			if (!isAncestor(t.worktree, sourceHead, checkedHead)) throw new Error("Worktree no longer includes the source HEAD; refusing merge.");
		} catch (error) {
			if (synced) {
				try { rollbackSync(t, checkedHead, preMergeSha); }
				catch (failure) { throw new Error(`${String(error)}\nCould not roll back sync: ${String(failure)}`); }
			}
			throw error;
		}
		merge(t.sourceCwd, t.sourceBranch!, checkedHead, sourceHead, `Merge failed for ${t.branch}`);
		remove(t, false, false, options);
		return { gateMessage };
	}, { branch: t.branch });
}

export async function discardWorktreeBranch(t: WorktreeBranch, force = false, options: WorktreeManagementOptions = {}): Promise<void> {
	return withRepoIntegrateLock(t.sourceCwd, () => {
		verifyTarget(t);
		if (fs.existsSync(t.worktree) && !force) requireClean(t.worktree, options.label ?? `Worktree ${t.worktree}`);
		remove(t, force, true, options);
	}, { branch: t.branch });
}

/** GC after 30 days: remove only clean, integrated resources and never wait for a lock. */
export function gcWorktrees(record: JobRecord, now: number, persist: () => void = () => {}): boolean {
	if (record.status === "running" || !record.finishedAt || now - record.finishedAt < 30 * 86400000 || record.runs?.some((r) => !r.done)) return false;
	for (const [i, t] of record.tasks.entries()) {
		if (!t.worktree || t.worktreeRemoved) continue;
		try {
			assertBranchTarget(t);
			if (!tryRepoIntegrateLock(t.sourceCwd, t.branch, () => {
				verifyTarget(t);
				if (fs.existsSync(t.worktree)) {
					requireClean(t.worktree, `Worktree ${t.worktree}`);
					if (!t.sourceBranch) throw new Error("No recorded destination branch.");
					// Detached HEAD may contain commits not reachable from the recorded branch.
					git(t.sourceCwd, ["merge-base", "--is-ancestor", head(t.worktree), `refs/heads/${t.sourceBranch}`]);
				}
				remove(t, false, false, { persist, workspaceId: `${record.jobId}:${i + 1}` });
			})) return false;
		} catch { return false; }
	}
	return true;
}

export async function manageWorktrees(record: JobRecord, action: "integrate" | "discard", index: number | undefined, force: boolean, persist: () => void): Promise<string> {
	if (record.status === "running" || record.runs?.some((r) => !r.done)) throw new Error("Job still running or has unresolved children.");
	if (index !== undefined && (!Number.isInteger(index) || index < 1 || index > record.tasks.length)) throw new Error("taskIndex must be a 1-based task index.");
	const messages: string[] = [];
	for (const [i, t] of record.tasks.entries()) {
		if ((index !== undefined && index !== i + 1) || !t.worktree || t.worktreeRemoved) continue;
		assertBranchTarget(t);
		const label = `Task ${i + 1}`;
		const options = { persist, label, workspaceId: `${record.jobId}:${i + 1}` };
		if (action === "integrate") {
			const { gateMessage, cleanupOnly } = await integrateWorktreeBranch(t, options);
			if (gateMessage) messages.push(`${label}: ${gateMessage}`);
			if (cleanupOnly) {
				messages.push(`${label}: integrate cleanup complete (${t.branch}).`);
				continue;
			}
		} else await discardWorktreeBranch(t, force, options);
		messages.push(`${label}: ${action} complete (${t.branch}).`);
	}
	return messages.join("\n") || "No active isolated worktrees selected.";
}
