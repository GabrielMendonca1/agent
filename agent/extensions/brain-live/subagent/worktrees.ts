import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findManifest, gate, lastRun, lastRunLine } from "../checks/runner.ts";
import type { AgentConfig } from "./agents.ts";
import type { JobRecord, JobTaskSpec } from "./jobs.ts";

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

function verifyDestination(t: JobTaskSpec): void {
	if (!t.sourceBranch) throw new Error("No recorded source branch (detached HEAD or legacy record); refusing integrate.");
	if (currentBranch(t.sourceCwd!) !== t.sourceBranch) throw new Error(`Source branch changed; expected ${t.sourceBranch}; refusing integrate.`);
}

function verifyMerged(t: JobTaskSpec): void {
	if (!t.sourceBranch) throw new Error("No recorded destination branch; refusing cleanup without discard.");
	git(t.sourceCwd!, ["merge-base", "--is-ancestor", `refs/heads/${t.branch}`, `refs/heads/${t.sourceBranch}`]);
}

/** Chamadas síncronas serializam worktree add antes de qualquer filho nascer. */
export function isolateWriters(record: JobRecord, agents: AgentConfig[], persist: () => void): void {
	if (record.mode !== "parallel") return;
	const groups = new Map<string, { task: JobTaskSpec; index: number; cwd: string }[]>();
	record.tasks.forEach((task, index) => {
		const agent = agents.find((a) => a.name === task.agent)!;
		// Lista ausente/vazia usa as ferramentas padrão, que incluem edição.
		if (agent.tools?.length && !agent.tools.some((t) => t === "edit" || t === "write")) return;
		const cwd = path.resolve(task.cwd ?? record.cwd);
		let root: string;
		try { root = git(cwd, ["rev-parse", "--show-toplevel"]); } catch { return; }
		const group = groups.get(root) ?? [];
		group.push({ task, index, cwd });
		groups.set(root, group);
	});
	for (const [root, group] of groups) {
		if (group.length < 2) continue;
		const baseSha = git(root, ["rev-parse", "HEAD"]);
		const sourceBranch = currentBranch(root);
		for (const { task, index, cwd } of group) {
			const name = `${record.jobId}-${index + 1}`;
			const worktree = path.join(getAgentDir(), "agent", "worktrees", name);
			const branch = `agent/${name}`;
			fs.mkdirSync(path.dirname(worktree), { recursive: true });
			git(root, ["worktree", "add", "-b", branch, worktree, baseSha]);
			Object.assign(task, { worktree, branch, sourceCwd: cwd, sourceBranch, baseSha, cwd: path.join(worktree, path.relative(root, cwd)) });
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
	const named = spawnSync("git", ["-C", worktree, "config", "user.email"], { encoding: "utf8" }).stdout?.trim();
	const identity = named ? [] : ["-c", "user.name=Agent", "-c", "user.email=agent@localhost"];
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

function remove(t: JobTaskSpec, force: boolean, discard: boolean, persist: () => void): void {
	const branchExists = git(t.sourceCwd!, ["branch", "--list", t.branch!]) !== "";
	// Não usa HEAD: a origem pode estar em outro branch ao retomar a limpeza.
	if (!discard && branchExists) verifyMerged(t);
	if (fs.existsSync(t.worktree!)) {
		git(t.sourceCwd!, ["worktree", "remove", ...(force ? ["--force"] : []), t.worktree!]);
	} else git(t.sourceCwd!, ["worktree", "prune"]);
	t.worktreePathRemoved = true;
	persist();
	// A ancestralidade no destino registrado já foi confirmada acima; -d depende de HEAD.
	if (branchExists) git(t.sourceCwd!, ["branch", "-D", t.branch!]);
	// Mantém os metadados históricos; apenas o recurso deixa de estar ativo.
	t.worktreeRemoved = true;
	persist();
}

async function manageSelectedWorktrees(record: JobRecord, action: "integrate" | "discard", index: number | undefined, force: boolean, persist: () => void): Promise<string> {
	if (record.status === "running" || record.runs?.some((r) => !r.done)) throw new Error("Job still running or has unresolved children.");
	if (index !== undefined && (!Number.isInteger(index) || index < 1 || index > record.tasks.length)) throw new Error("taskIndex must be a 1-based task index.");
	const messages: string[] = [];
	for (const [i, t] of record.tasks.entries()) {
		if ((index !== undefined && index !== i + 1) || !t.worktree || t.worktreeRemoved) continue;
		const exists = fs.existsSync(t.worktree);
		const dirty = exists ? git(t.worktree, ["status", "--porcelain"]) : "";
		if (dirty && (action === "integrate" || !force)) throw new Error(`Task ${i + 1} has uncommitted changes:\n${dirty}`);
		if (action === "integrate") {
			verifyDestination(t);
			if (!exists) {
				remove(t, false, false, persist);
				messages.push(`Task ${i + 1}: integrate cleanup complete (${t.branch}).`);
				continue;
			}
			if (fs.existsSync(path.join(git(t.sourceCwd!, ["rev-parse", "--absolute-git-dir"]), "MERGE_HEAD"))) throw new Error("Source has a merge in progress.");
			if (git(t.sourceCwd!, ["status", "--porcelain"])) throw new Error(`Source ${t.sourceCwd} is dirty; refusing merge.`);
			const manifest = findManifest(t.worktree);
			if (manifest) {
				const result = await gate(manifest, { cwd: t.worktree });
				if (!result.ok) throw new Error(`Task ${i + 1}: checks gate failed: ${result.verdict}`);
				messages.push(`Task ${i + 1}: checks gate passed (${result.results.length} checks).`);
			} else messages.push(`Task ${i + 1}: no checks manifest; orchestrator must run checks after integrate.`);
			// O gate pode ter alterado arquivos; revalida ambos antes do merge.
			if (git(t.sourceCwd!, ["status", "--porcelain"]) || git(t.worktree, ["status", "--porcelain"])) throw new Error("Source or worktree became dirty during checks; refusing merge.");
			if (git(t.worktree, ["rev-parse", "HEAD"]) !== git(t.sourceCwd!, ["rev-parse", t.branch!])) throw new Error("Worktree HEAD differs from its branch; refusing merge.");
			verifyDestination(t);
			try { git(t.sourceCwd!, ["merge", "--no-ff", "--no-edit", t.branch!]); }
			catch (error) {
				const conflicts = git(t.sourceCwd!, ["diff", "--name-only", "--diff-filter=U"]);
				// Só aborta um merge criado por esta chamada.
				let abortError = "";
				if (fs.existsSync(path.join(git(t.sourceCwd!, ["rev-parse", "--absolute-git-dir"]), "MERGE_HEAD"))) {
					try { git(t.sourceCwd!, ["merge", "--abort"]); }
					catch (failure) { abortError = `\nmerge --abort failed: ${String(failure)}`; }
				}
				throw new Error(`Merge failed for ${t.branch}; conflicts: ${conflicts || "(none)"}\n${String(error)}${abortError}`);
			}
		}
		remove(t, action === "discard" && force, action === "discard", persist);
		messages.push(`Task ${i + 1}: ${action} complete (${t.branch}).`);
	}
	return messages.join("\n") || "No active isolated worktrees selected.";
}

/** GC após 30 dias: só apaga recursos limpos e já integrados; preserva o resto. */
export function gcWorktrees(record: JobRecord, now: number, persist: () => void = () => {}): boolean {
	if (record.status === "running" || !record.finishedAt || now - record.finishedAt < 30 * 86400000 || record.runs?.some((r) => !r.done)) return false;
	for (const t of record.tasks) {
		if (!t.worktree || t.worktreeRemoved) continue;
		try {
			if (managementLocks.has(git(t.sourceCwd!, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) return false;
			if (fs.existsSync(t.worktree)) {
				if (git(t.worktree, ["status", "--porcelain"])) return false;
				if (!t.sourceBranch) return false;
				// Um HEAD destacado pode conter commits que o branch antigo não contém.
				git(t.sourceCwd!, ["merge-base", "--is-ancestor", git(t.worktree, ["rev-parse", "HEAD"]), `refs/heads/${t.sourceBranch}`]);
			}
			remove(t, false, false, persist);
		} catch { return false; }
	}
	return true;
}

const managementLocks = new Set<string>();

/** Não permite duas ações concorrentes no mesmo repositório durante o gate. */
export async function manageWorktrees(record: JobRecord, action: "integrate" | "discard", index: number | undefined, force: boolean, persist: () => void): Promise<string> {
	const roots = [...new Set(record.tasks.filter((t) => t.sourceCwd && !t.worktreeRemoved).map((t) => git(t.sourceCwd!, ["rev-parse", "--path-format=absolute", "--git-common-dir"])))];
	if (roots.some((root) => managementLocks.has(root))) throw new Error("Worktree management already in progress for this repository.");
	for (const root of roots) managementLocks.add(root);
	try { return await manageSelectedWorktrees(record, action, index, force, persist); }
	finally { for (const root of roots) managementLocks.delete(root); }
}
