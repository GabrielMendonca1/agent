import { realpathSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findManifest, gate, lastRun, lastRunLine } from "../checks/runner.ts";
import type { AgentConfig } from "./agents.ts";
import type { JobRecord, JobTaskSpec } from "./jobs.ts";
import type { ChildSkills } from "./skills.ts";

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
/** Writer tasks isolateWriters moves into worktrees (2+ writers of one repository in parallel), by root. */
export function plannedIsolation(record: Pick<JobRecord, "mode" | "tasks" | "cwd">, agents: AgentConfig[]): Map<string, { task: JobTaskSpec; index: number; cwd: string }[]> {
	const groups = new Map<string, { task: JobTaskSpec; index: number; cwd: string }[]>();
	if (record.mode !== "parallel") return groups;
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
	for (const [root, group] of groups) if (group.length < 2) groups.delete(root);
	return groups;
}

const skillLabel = (file: string) => path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file, ".md");

/**
 * Lexical forms of the repository root: git's toplevel, its realpath and the same root reached
 * through `cwd` (e.g. /var vs /private/var on macOS). Catalog paths are compared lexically.
 */
function rootForms(root: string, cwd?: string): string[] {
	const forms = new Set([path.resolve(root)]);
	try {
		const real = realpathSync(root);
		forms.add(real);
		if (cwd) {
			const rel = path.relative(real, realpathSync(cwd));
			if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
				const candidate = path.resolve(cwd, ...(rel ? rel.split(path.sep).map(() => "..") : []));
				if (realpathSync(candidate) === real) forms.add(candidate);
			}
		}
	} catch { /* missing paths: only the given form */ }
	return [...forms];
}

/** Project-local when the path, as written (no dereferencing), lies under the repository root. */
function projectLocal(file: string, roots: string[]): { root: string; rel: string } | undefined {
	const resolved = path.resolve(file);
	for (const root of roots) if (resolved.startsWith(root + path.sep)) return { root, rel: path.relative(root, resolved) };
	return undefined;
}

/** First path component from `root` to `rel` that is a symlink or missing; undefined when all are real. */
function badComponent(root: string, rel: string): { at: string; kind: "symlink" | "missing" } | undefined {
	let current = root;
	for (const part of rel.split(path.sep)) {
		current = path.join(current, part);
		let stat: fs.Stats;
		try { stat = fs.lstatSync(current); } catch { return { at: current, kind: "missing" }; }
		if (stat.isSymbolicLink()) return { at: current, kind: "symlink" };
	}
	return undefined;
}

const posix = (rel: string) => rel.split(path.sep).join("/");

/** Regular file reached only through real directories, whose realpath stays inside `root`. */
function plainFileError(root: string, rel: string, label: string, where: string): string | undefined {
	const bad = badComponent(root, rel);
	if (bad?.kind === "symlink") return `skill "${label}" (${posix(rel)}) goes through a symlink (${bad.at}) in ${where}; isolated writers only load regular committed skill files.`;
	if (bad) return `skill "${label}" (${posix(rel)}) is missing in ${where}.`;
	const file = path.join(root, rel);
	if (!fs.lstatSync(file).isFile()) return `skill "${label}" (${posix(rel)}) is not a regular file in ${where}.`;
	if (!realpathSync(file).startsWith(realpathSync(root) + path.sep)) return `skill "${label}" (${posix(rel)}) resolves outside ${where}.`;
	return undefined;
}

/**
 * Launch check for a writer that will run in a worktree. A project-local skill (lexically under
 * the repository) must be a regular file reached without symlinks, committed at HEAD with mode
 * 100644, and its directory (or the flat .md file) must have no uncommitted changes, so the child
 * reads exactly what was validated. Other skills (personal, company, bundled) keep their path.
 */
export function worktreeSkillError(file: string, root: string, cwd?: string): string | undefined {
	const local = projectLocal(file, rootForms(root, cwd));
	if (!local) return undefined;
	const label = skillLabel(file);
	const rel = posix(local.rel);
	const plain = plainFileError(local.root, local.rel, label, "the source checkout");
	if (plain) return plain;
	const notCommitted = `skill "${label}" (${rel}) is not committed in this worktree; commit it or run the task in place.`;
	const tree = spawnSync("git", ["-C", local.root, "ls-tree", "HEAD", "--", rel], { encoding: "utf8" });
	if (tree.status !== 0 || !tree.stdout.trim()) return notCommitted;
	if (!tree.stdout.startsWith("100644 blob ")) return `skill "${label}" (${rel}) is committed with git mode ${tree.stdout.split(" ")[0]}, not as a regular file (100644); commit a regular file or run the task in place.`;
	const scope = path.posix.basename(rel) === "SKILL.md" ? path.posix.dirname(rel) : rel;
	const status = spawnSync("git", ["-C", local.root, "status", "--porcelain", "--untracked-files=all", "--", scope], { encoding: "utf8" });
	if (status.status !== 0 || status.stdout.trim()) return `skill "${label}" has uncommitted changes; commit them or run the task in place.`;
	return undefined;
}

/** Same project skills, lexically at the same relative path in the worktree, rechecked there. */
export function mapSkillsToWorktree(skills: ChildSkills, root: string, worktree: string, cwd?: string): ChildSkills {
	const roots = rootForms(root, cwd);
	const paths = skills.paths.map((file) => {
		const local = projectLocal(file, roots);
		if (!local) return file;
		const error = plainFileError(worktree, local.rel, skillLabel(file), "the worktree");
		if (error) throw new Error(error);
		return path.join(worktree, local.rel);
	});
	return { ...skills, paths };
}

/**
 * Continue of an isolated writer: every carried project skill (under the worktree of `cwd`) must
 * still be a regular file reached without symlinks inside it. Returns the error, if any.
 */
export function carriedSkillsError(skills: ChildSkills | undefined, cwd: string): string | undefined {
	if (!skills?.paths.length) return undefined;
	const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (top.status !== 0 || !top.stdout.trim()) return undefined;
	const roots = rootForms(top.stdout.trim(), cwd);
	for (const file of skills.paths) {
		const local = projectLocal(file, roots);
		if (!local) continue;
		const error = plainFileError(local.root, local.rel, skillLabel(file), "the worktree");
		if (error) return error;
	}
	return undefined;
}

export function isolateWriters(record: JobRecord, agents: AgentConfig[], persist: () => void): void {
	for (const [root, group] of plannedIsolation(record, agents)) {
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
			// Checked at launch (worktreeSkillError); this refuses anything that still leaves the worktree.
			if (task.resolvedSkills) {
				task.resolvedSkills = mapSkillsToWorktree(task.resolvedSkills, root, worktree, cwd);
				persist();
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
