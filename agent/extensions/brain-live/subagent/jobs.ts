/**
 * Async subagent jobs.
 *
 * A `subagent` call dispatches a bounded background job and returns a jobId
 * immediately; the parent keeps working. When the job finishes the manager
 * persists the final result and hands the record to `onComplete`, which the
 * extension turns into a single custom message (never a user message).
 *
 * Storage: <baseDir>/<sessionId>/<jobId>.json, written atomically, mode 0600.
 * Only task metadata + final result/error/usage are stored — never transcripts,
 * thinking or tool messages. Each task records its child's session JSONL path
 * as soon as it starts; that file is the full audit trail (see trace.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gateSummary, gcWorktrees, isolateWriters, manageWorktrees, worktreeSummary } from "./worktrees.ts";
import { getRoleModelChoices, resolveGeminiPreference, type ResolvedRoleModel, resolveRoleModel } from "../lib/tiers.ts";
import type { AgentConfig, AgentScope } from "./agents.ts";
import {
	type DurableRunState,
	MAX_RESUMES,
	removeJobRunDir,
	sessionMayBeOwned,
} from "./legacy-runs.ts";
import { ownerMayBeAlive, readProcessIdentity, type ProcessIdentity } from "./process-owner.ts";
// @ts-ignore — módulo JS compartilhado, sem tipos
import { staggeredFanout } from "../../../core/cache-policy.mjs";
import { childCacheRetention } from "../../../core/child-env.mjs";
import {
	ChildSlots,
	type DispatchDefaults,
	emptyUsage,
	GLOBAL_CHILD_LIMIT,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	prefetchAgent,
	PREFETCH_EXIT,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "./runner.ts";

export const MAX_PARALLEL_TASKS = 32;
export const MAX_CHAIN_STEPS = 8;
/** Parallel tasks of one job in flight; the child-slot pool is the real ceiling. */
export const MAX_CONCURRENCY = GLOBAL_CHILD_LIMIT;

/** Prefixo de cache de um filho: papel + modelo + thinking + cwd (system e tools derivam disso). */
export function prefixKey(task: JobTaskSpec, defaultCwd: string): string {
	return JSON.stringify([task.agent, task.model ?? null, task.thinking ?? null, task.sourceCwd ?? task.cwd ?? defaultCwd]);
}

/**
 * TTL do cache Anthropic que o FILHO pede: o runner lança filhos com a retenção de
 * `childCacheRetention` (5 min por padrão, mesmo com a sessão principal em long), então
 * prefetch e "filho real recente" usam esse TTL, não o do pai.
 */
export function cacheTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
	return childCacheRetention(env) === "long" ? 3600 : 300;
}

/** Estado por prefixo: aquecimento em voo, e até quando o cache está quente. */
const prefetchState = new Map<string, { inflight: boolean; until: number }>();

/**
 * Prefetch do próximo papel (cache E). Opt-in, DESLIGADO por padrão: só com
 * AGENT_CACHE_PREFETCH_NEXT=1. Custa MAIS que não aquecer (escrita do prefixo
 * 1,25× + leitura 0,1× no filho real + 1 token); o ganho é só latência do 1º
 * request da etapa seguinte. Um aquecimento por prefixo (agent+model+thinking+cwd),
 * nunca com outro em voo ou filho real recente (até TTL×0,9).
 */
export function prefetchAllowed(_spec: Pick<LaunchSpec, "dispatchDefaults">, key: string, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.AGENT_CACHE_PREFETCH_NEXT !== "1") return false;
	const st = prefetchState.get(key);
	return !st || (!st.inflight && st.until <= now);
}

/** Filhos com prefixo idêntico (mesmo system+tools+modelo): só aí o leque escalonado ganha cache. */
export function sharesPrefix(tasks: JobTaskSpec[]): boolean {
	if (tasks.length < 2) return false;
	const key = (t: JobTaskSpec) => JSON.stringify([t.agent, t.model ?? null, t.thinking ?? null, t.sourceCwd ?? t.cwd ?? null]);
	const first = key(tasks[0]);
	return tasks.every((t) => key(t) === first);
}
/** Repeated calls must not be able to spawn unbounded processes. */
export const MAX_ACTIVE_JOBS = 32;
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 7200;
/** Bound for one `action: "result"` read. */
export const RESULT_READ_CAP = 8 * 1024;
/** Hard ceiling for a stored result; overflow is reported, never silently cut. */
export const MAX_STORED_RESULT_BYTES = 16 * 1024 * 1024;
/** Session/job ids reach the filesystem: only this shape is accepted. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Bound for the completion notification body. */
export const NOTIFY_SUMMARY_CAP = 4 * 1024;
const LEGACY_TASK_SNAPSHOT_CAP = 2000;

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "timeout" | "interrupted";
export type JobMode = "single" | "parallel" | "chain";

export interface JobTaskSpec {
	agent: string;
	task: string;
	cwd?: string;
	/** Metadados opcionais: registros antigos continuam válidos. */
	worktree?: string;
	branch?: string;
	sourceCwd?: string;
	sourceBranch?: string | null;
	worktreePathRemoved?: boolean;
	baseSha?: string;
	worktreeRemoved?: boolean;
	/** Optional per-call selection. It must match this role's central allowlist. */
	model?: string;
	/** Internal per-brief decision; role defaults never overwrite a sibling task's choice. */
	slot?: "apoio" | "principal";
	/** Populated internally from the authorized model-role pair; never caller-controlled. */
	thinking?: string;
	/** Internal: model/thinking already came from the agy role preference (/models), not from the caller. */
	agyResolved?: boolean;
	/** Audit, written by the manager: per-task lifecycle, child session and usage. */
	state?: TaskState;
	sessionFile?: string;
	usage?: UsageStats;
	error?: string;
}

/**
 * `not_run`: the job ended before this task started (chain stop, abort).
 * `interrupted`: the parent died while this task ran; its session file is kept.
 */
export type TaskState = "running" | "completed" | "failed" | "not_run" | "interrupted";

/**
 * Config própria do papel (`roleModels` no models.json do usuário), quando existe.
 * Ausência do arquivo é suportada por getRoleModelChoices; configuração existente
 * inválida NÃO vira ausência silenciosa nem permite ignorar a allowlist do usuário.
 * Escolha explícita fora da lista continua sendo erro (propaga).
 */
function ownRoleModel(role: string, requestedModel?: string): ResolvedRoleModel | undefined {
	const configured = (getRoleModelChoices(role)?.length ?? 0) > 0;
	return configured ? resolveRoleModel(role, requestedModel) : undefined;
}

/** Config do papel no próprio arquivo .md do usuário (`model:`/`tier:`/`thinking:`). */
export type RoleFileConfig = Pick<AgentConfig, "name" | "runner" | "model" | "thinking">;

export function resolveJobTaskModels(tasks: JobTaskSpec[], defaults?: DispatchDefaults, roleFiles?: readonly RoleFileConfig[]): { ok: true; tasks: JobTaskSpec[] } | { ok: false; error: string } {
	const externalTask = (task: JobTaskSpec): JobTaskSpec | undefined => {
		const role = roleFiles?.find((file) => file.name === task.agent);
		if (role?.runner !== "agy") return undefined;
		// Dispatch resolves once before approval and launch() resolves again: the
		// model filled by the first pass is the role preference, not a caller override.
		if (task.agyResolved) return task;
		if (task.model !== undefined) {
			const source = role.name === "gemini" ? "choose its model in /models" : "set a native model ID in the role file";
			throw new Error(`Agent: ${task.agent} uses agy; ${source} instead of passing a Pi model override.`);
		}
		const choice = role.name === "gemini" ? resolveGeminiPreference(role) : undefined;
		return { ...task, ...choice, agyResolved: true };
	};
	try {
		if (defaults?.resources) {
			const primary = defaults.model;
			const support = defaults.resources.supportModel || primary;
			return { ok: true, tasks: tasks.map((task) => {
				const external = externalTask(task);
				if (external) return external;
				if (!primary) throw new Error("Agent: parent model unavailable.");
				// A config do papel que o usuário já tinha (`roleModels`: modelo + thinking por papel)
				// é autoritativa e NUNCA é zerada pelo piloto; o slot principal/apoio só preenche
				// papel sem config própria.
				const own = ownRoleModel(task.agent, task.model);
				if (own) return { ...task, model: own.model, thinking: own.thinking };
				// Papel que traz `model`/`thinking` no próprio .md e chamada sem escolha explícita:
				// o arquivo do usuário decide (o runner resolve `tier:`/thinking do frontmatter).
				const file = roleFiles?.find((role) => role.name === task.agent);
				if (!task.model && (file?.model || file?.thinking)) return { ...task };
				// Slot vem da receita; sem receita, scout em apoio e o resto no principal.
				const slot = task.slot ?? defaults.resources?.slots?.[task.agent] ?? (task.agent === "scout" ? "apoio" : "principal");
				const model = task.model ?? (slot === "apoio" ? support : primary);
				if (model !== primary && model !== support) {
					throw new Error(`Agent: ${task.agent} deve usar principal ou apoio configurado em /models; recebido ${model}.`);
				}
				// Papel sem config própria: slot do piloto e o thinking do pedido.
				return { ...task, model, thinking: defaults.thinkingLevel ?? "medium" };
			}) };
		}
		return {
			ok: true,
			tasks: tasks.map((task) => {
				const external = externalTask(task);
				if (external) return external;
				const selected = resolveRoleModel(task.agent, task.model);
				return selected ? { ...task, model: selected.model, thinking: selected.thinking } : { ...task };
			}),
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export interface JobRecord {
	/** Version 2 persists complete task templates; legacy records truncated them. */
	version?: 2;
	jobId: string;
	sessionId: string;
	mode: JobMode;
	status: JobStatus;
	agents: string[];
	tasks: JobTaskSpec[];
	cwd: string;
	agentScope: AgentScope;
	timeoutSeconds: number;
	createdAt: number;
	finishedAt?: number;
	/** Session entry the launch was anchored to; used as branch guard. */
	anchorEntryId?: string | null;
	sessionGeneration?: number;
	result?: string;
	/** Sessões dos filhos, inclusive quando o resultado falha ou excede o limite. */
	sessionFiles?: string[];
	error?: string;
	usage?: UsageStats;
	notified?: boolean;
	/** pi que lançou (ou retomou) este job; vazio em registros antigos. */
	parentPid?: number;
	parentIdentity?: ProcessIdentity;
	/** Histórico de jobs duráveis antigos; usado somente para limpeza segura. */
	runs?: DurableRunState[];
	/** Total de retomadas para telemetria; MAX_RESUMES vale por slot. */
	resumes?: number;
}

export interface LaunchSpec {
	/** Pre-reserved id (so the launch anchor entry can name the job). */
	jobId?: string;
	sessionId: string;
	sessionGeneration: number;
	anchorEntryId?: string | null;
	mode: JobMode;
	tasks: JobTaskSpec[];
	agents: AgentConfig[];
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	dispatchDefaults: DispatchDefaults;
	cwd: string;
	timeoutSeconds: number;
}

export interface JobManagerDeps {
	baseDir: string;
	onComplete: (record: JobRecord) => void;
	onProcessStarted?: (agentName: string) => () => void;
	now?: () => number;
	newJobId?: () => string;
	/** Test seam: concurrent children of this manager (default GLOBAL_CHILD_LIMIT). */
	childLimit?: number;
}

/** No traversal, no absolute path, no dot-segments — spoofed ids cannot escape baseDir. */
export function isSafeId(value: unknown): value is string {
	return typeof value === "string" && value !== "." && value !== ".." && SAFE_ID.test(value);
}

export function jobDir(baseDir: string, sessionId: string): string {
	if (!isSafeId(sessionId)) throw new Error(`Unsafe session id: ${String(sessionId)}`);
	return path.join(baseDir, sessionId);
}

export function jobPath(baseDir: string, sessionId: string, jobId: string): string {
	if (!isSafeId(jobId)) throw new Error(`Unsafe job id: ${String(jobId)}`);
	return path.join(jobDir(baseDir, sessionId), `${jobId}.json`);
}

export function writeRecord(baseDir: string, record: JobRecord): string {
	const dir = jobDir(baseDir, record.sessionId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = jobPath(baseDir, record.sessionId, record.jobId);
	const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, target);
	return target;
}

export function readRecord(baseDir: string, sessionId: string, jobId: string): JobRecord | null {
	if (!isSafeId(sessionId) || !isSafeId(jobId)) return null;
	try {
		const raw = fs.readFileSync(jobPath(baseDir, sessionId, jobId), "utf-8");
		const parsed = JSON.parse(raw) as JobRecord;
		// Reads are scoped to the current session; a mismatching file is ignored.
		return parsed.sessionId === sessionId ? parsed : null;
	} catch {
		return null;
	}
}

export function listRecords(baseDir: string, sessionId: string): JobRecord[] {
	if (!isSafeId(sessionId)) return [];
	let names: string[];
	try {
		names = fs.readdirSync(jobDir(baseDir, sessionId));
	} catch {
		return [];
	}
	const records: JobRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = readRecord(baseDir, sessionId, name.slice(0, -5));
		if (record) records.push(record);
	}
	return records.sort((a, b) => a.createdAt - b.createdAt);
}

/** O job pertence a outro `pi` ainda vivo: não é nosso para interromper nem retomar. */
export function ownedByLiveForeignParent(record: JobRecord): boolean {
	if (record.parentPid === process.pid && record.parentIdentity) {
		const current = readProcessIdentity(process.pid);
		if (current && current.host === record.parentIdentity.host && current.start === record.parentIdentity.start) return false;
	}
	return ownerMayBeAlive(record.parentPid, record.parentIdentity);
}

/** Não adota pipes de um órfão nem apaga a sessão que ele ainda pode estar usando. */
export function recoveryBlocker(record: JobRecord): string | undefined {
	if (ownedByLiveForeignParent(record)) return `Job ${record.jobId}: parent may still be alive; record preserved.`;
	const pending = record.runs?.find((run) => !run.done && (run.spawnPending === true || (run.spawnPending === undefined && run.childPid === undefined)));
	if (pending) return `Job ${record.jobId}: launch of slot ${pending.slot} is unconfirmed; record and session preserved. Inspect the launch before manual recovery; no automatic replay.`;
	const child = record.runs?.find((run) => (!run.done && ownerMayBeAlive(run.childPid, run.childIdentity)) || sessionMayBeOwned(run));
	if (child) return `Job ${record.jobId}: child/session ${child.slot} may still be alive; session preserved. Reopen the parent after the child exits to retry recovery.`;
	return undefined;
}

/**
 * A job that was running when the process died is marked interrupted on restore
 * and never respawned.
 */
export function restoreInterrupted(
	baseDir: string,
	sessionId: string,
): JobRecord[] {
	const changed: JobRecord[] = [];
	for (const record of listRecords(baseDir, sessionId)) {
		if (record.status !== "running") continue;
		if (recoveryBlocker(record)) continue;
		changed.push(markInterrupted(baseDir, record));
	}
	return changed;
}

/** Marca um job "running" órfão como interrompido (sem respawn) e devolve o registro. */
export function markInterrupted(baseDir: string, record: JobRecord): JobRecord {
	const blocked = recoveryBlocker(record);
	if (blocked) throw new Error(blocked);
	// Unnotified on purpose: the parent still deserves one "interrupted" notice on
	// the resumed session/branch. It is never respawned.
	const exhausted = (record.runs ?? []).some((run) => !run.done && (run.resumes ?? 0) >= MAX_RESUMES);
	// Records written before per-task audit have no task state: leave them as they are.
	const audited = record.tasks.some((task) => task.state);
	const tasks = audited
		? record.tasks.map((task) =>
				task.state === "running" ? { ...task, state: "interrupted" as const } : task.state ? task : { ...task, state: "not_run" as const },
			)
		: record.tasks;
	const updated: JobRecord = {
		...record,
		tasks,
		status: "interrupted",
		finishedAt: record.finishedAt ?? Date.now(),
		error:
			record.error ??
			(exhausted
				? `Job interrupted: limite de ${MAX_RESUMES} retomadas atingido depois de quedas sucessivas.`
				: "Job interrupted: pi restarted while the subagent was running."),
		notified: record.notified ?? false,
		runs: undefined,
	};
	writeRecord(baseDir, updated);
	removeJobRunDir(baseDir, updated.sessionId, updated.jobId);
	return updated;
}

export function validateTimeoutSeconds(value: number | undefined): { ok: true; value: number } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, value: DEFAULT_TIMEOUT_SECONDS };
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) {
		return { ok: false, error: `timeoutSeconds must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.` };
	}
	return { ok: true, value };
}

interface ActiveJob {
	record: JobRecord;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	cancelRequested: boolean;
	timedOut: boolean;
	done: Promise<void>;
	/** Aquecimentos de cache deste job: abortados e aguardados antes do estado terminal. */
	warm?: { controller: AbortController; pending: Set<Promise<void>> };
	/** Live result of each started task (by index), kept even if the task throws. */
	started: Map<number, SingleResult>;
	/** Results that tasks actually returned. */
	returned: Map<number, SingleResult>;
	/** Tasks that threw, with the message. */
	thrown: Map<number, string>;
}

export type LaunchOutcome = { ok: true; record: JobRecord; resultPath: string } | { ok: false; error: string };

export class SubagentJobManager {
	private readonly deps: JobManagerDeps;
	private readonly active = new Map<string, ActiveJob>();
	private readonly slots: ChildSlots;
	private counter = 0;
	private shuttingDown = false;

	constructor(deps: JobManagerDeps) {
		this.deps = deps;
		this.slots = new ChildSlots(deps.childLimit ?? GLOBAL_CHILD_LIMIT);
	}

	get baseDir(): string {
		return this.deps.baseDir;
	}

	activeCount(): number {
		return this.active.size;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private nextJobId(): string {
		if (this.deps.newJobId) return this.deps.newJobId();
		this.counter++;
		return `${this.now().toString(36)}-${this.counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	/** Reserve an id before the launch, so the anchor entry can reference the job. */
	reserveJobId(): string {
		let id = this.nextJobId();
		if (!isSafeId(id)) id = `job-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
		return id;
	}

	/** In-flight jobs of one session. */
	runningJobs(sessionId: string): number {
		let count = 0;
		for (const job of this.active.values()) if (job.record.sessionId === sessionId) count++;
		return count;
	}

	/**
	 * Resolves when any in-flight job of the session settles (at once if none).
	 * Each job is bounded by its own timeout timer; `onComplete` has already run.
	 */
	async waitForAnyJob(sessionId: string): Promise<void> {
		const jobs = [...this.active.values()].filter((job) => job.record.sessionId === sessionId);
		if (jobs.length === 0) return;
		await Promise.race(jobs.map((job) => job.done.catch(() => undefined)));
	}

	/** Children currently spawned by this manager (global ceiling guard). */
	activeChildren(): number {
		return this.slots.active;
	}

	launch(spec: LaunchSpec): LaunchOutcome {
		if (this.shuttingDown) return { ok: false, error: "Session is shutting down; no new subagent jobs." };
		if (this.active.size >= MAX_ACTIVE_JOBS) {
			return {
				ok: false,
				error: `Too many subagent jobs running (${this.active.size}/${MAX_ACTIVE_JOBS}). Wait or cancel one (action: "list" / "cancel").`,
			};
		}
		if (spec.tasks.length === 0) return { ok: false, error: "No tasks to run." };
		if (spec.mode === "chain" && spec.tasks.length > MAX_CHAIN_STEPS) {
			return { ok: false, error: `Too many chain steps (${spec.tasks.length}). Max is ${MAX_CHAIN_STEPS}.` };
		}
		if (spec.mode === "parallel" && spec.tasks.length > MAX_PARALLEL_TASKS) {
			return { ok: false, error: `Too many parallel tasks (${spec.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` };
		}
		if (spec.mode === "single" && spec.tasks.length > 1) return { ok: false, error: "Single mode takes exactly one task." };

		// Unknown agents are rejected before anything is launched: no phantom jobs.
		const known = new Set(spec.agents.map((a) => a.name));
		const unknown = spec.tasks.map((t) => t.agent).filter((name) => !known.has(name));
		if (unknown.length > 0) {
			const available = spec.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return { ok: false, error: `Unknown agent(s): ${[...new Set(unknown)].join(", ")}. Available: ${available}` };
		}

		// Resolve every preference / explicit selection before creating a record or
		// scheduling work. `thinking` comes only from the authorized pair.
		const resolvedTasks = resolveJobTaskModels(spec.tasks, spec.dispatchDefaults, spec.agents);
		if (!resolvedTasks.ok) return resolvedTasks;
		spec = { ...spec, tasks: resolvedTasks.tasks };

		const jobId = spec.jobId && isSafeId(spec.jobId) ? spec.jobId : this.reserveJobId();
		if (!isSafeId(spec.sessionId)) return { ok: false, error: "Unsafe session id; refusing to persist a job." };
		if (this.active.has(jobId)) return { ok: false, error: `Job ${jobId} already exists.` };
		const record: JobRecord = {
			version: 2,
			jobId,
			sessionId: spec.sessionId,
			mode: spec.mode,
			status: "running",
			agents: spec.tasks.map((t) => t.agent),
			tasks: spec.tasks.map((t) => ({
				agent: t.agent,
				task: t.task,
				cwd: t.cwd,
				model: t.model,
				thinking: t.thinking,
			})),
			cwd: spec.cwd,
			agentScope: spec.agentScope,
			timeoutSeconds: spec.timeoutSeconds,
			createdAt: this.now(),
			anchorEntryId: spec.anchorEntryId ?? null,
			sessionGeneration: spec.sessionGeneration,
			parentPid: process.pid,
			parentIdentity: readProcessIdentity(process.pid),
		};

		// Persist the launch before acknowledging it, so a crash right after the
		// ack still leaves a record that restore() can mark interrupted.
		const resultPath = writeRecord(this.deps.baseDir, record);
		this.start(record, spec);
		return { ok: true, record, resultPath };
	}

	/** Shared lifecycle for a fresh dispatch and a restored job. */
	private start(record: JobRecord, spec: LaunchSpec): void {
		const controller = new AbortController();
		const job: ActiveJob = {
			record,
			controller,
			cancelRequested: false,
			timedOut: false,
			done: Promise.resolve(),
			started: new Map(),
			returned: new Map(),
			thrown: new Map(),
		};
		if (spec.timeoutSeconds > 0) {
			job.timer = setTimeout(() => {
				job.timedOut = true;
				controller.abort();
			}, spec.timeoutSeconds * 1000);
			job.timer.unref?.();
		}
		this.active.set(record.jobId, job);
		job.done = this.run(job, spec);
	}

	private persist(record: JobRecord): void {
		try {
			writeRecord(this.deps.baseDir, record);
		} catch {
			/* persistência best-effort: o job continua */
		}
	}

	/**
	 * Leque escalonado (cache fase E): ≥2 filhos com o mesmo prefixo (papel+modelo+
	 * thinking+cwd). O líder escreve o prefixo no cache; os demais só nascem após o
	 * 1º token efetivo dele (ou falha/fim/timeout do líder) e passam a ler o cache.
	 */
	private async runFanout(
		job: ActiveJob,
		spec: LaunchSpec,
		signal: AbortSignal,
		details: (results: SingleResult[]) => SubagentDetails,
	): Promise<SingleResult[]> {
		const { results } = await staggeredFanout(
			spec.tasks.map((task, index) => ({ task, index })),
			({ task, index }: { task: JobTaskSpec; index: number }) => {
				let fired!: () => void;
				const firstToken = new Promise<void>((resolve) => { fired = resolve; });
				const done = this.runTask(job, spec, { slot: index, task, taskText: task.task, signal, makeDetails: details, onFirstToken: () => fired() });
				return { firstToken, done };
			},
			{ maxConcurrent: MAX_CONCURRENCY, signal },
		);
		// A task that threw is already settled by runTask; its siblings ran to the end.
		const out: SingleResult[] = new Array(spec.tasks.length);
		results.forEach((r: { status: string; value?: SingleResult }, i: number) => {
			if (r.status === "fulfilled") out[i] = r.value as SingleResult;
		});
		return out;
	}

	/** Aquecimento fire-and-forget do prefixo de `task.agent` (ver prefetchPolicy). */
	private prefetchRole(job: ActiveJob, spec: LaunchSpec, task: JobTaskSpec, signal: AbortSignal): void {
		if (spec.agents.find((role) => role.name === task.agent)?.runner === "agy") return;
		const key = prefixKey(task, spec.cwd);
		if (!prefetchAllowed(spec, key, Date.now()) || signal.aborted) return;
		const ttlMs = cacheTtlSeconds() * 1000;
		prefetchState.set(key, { inflight: true, until: 0 });
		// Dono = o job: aborta junto com ele (cancel/timeout/shutdown) e também quando o job
		// termina por qualquer motivo (run() aborta e espera no finally). Nunca sobrevive ao job.
		if (!job.warm) {
			const controller = new AbortController();
			const forward = () => controller.abort();
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forward, { once: true });
			job.warm = { controller, pending: new Set() };
		}
		const warm = job.warm;
		const pending: Promise<void> = prefetchAgent({
			defaultCwd: spec.cwd,
			dispatchDefaults: spec.dispatchDefaults,
			agents: spec.agents,
			agentName: task.agent,
			cwd: task.cwd,
			sourceCwd: task.sourceCwd,
			roleModel: task.model && task.thinking ? { model: task.model, thinking: task.thinking } : undefined,
			signal: warm.controller.signal,
			acquireSlot: (s?: AbortSignal) => this.slots.acquire(s),
		}).then((code) => {
			prefetchState.set(key, { inflight: false, until: code === PREFETCH_EXIT.warmed ? Date.now() + ttlMs * 0.9 : 0 });
		}).finally(() => { warm.pending.delete(pending); });
		warm.pending.add(pending);
	}

	private async runTask(
		job: ActiveJob,
		spec: LaunchSpec,
		opts: {
			slot: number;
			task: JobTaskSpec;
			taskText: string;
			step?: number;
			signal: AbortSignal;
			makeDetails: (results: SingleResult[]) => SubagentDetails;
			onFirstToken?: () => void;
		},
	): Promise<SingleResult> {
		const { slot, task, signal, makeDetails, onFirstToken } = opts;
		// Filho real deste prefixo vivo: o cache fica quente pelo TTL; aquecer seria desperdício.
		const key = prefixKey(task, spec.cwd);
		const prev = prefetchState.get(key);
		prefetchState.set(key, { inflight: prev?.inflight ?? false, until: Date.now() + cacheTtlSeconds() * 1000 * 0.9 });
		const common = {
			defaultCwd: spec.cwd,
			dispatchDefaults: spec.dispatchDefaults,
			agents: spec.agents,
			agentName: task.agent,
			cwd: task.cwd,
			sourceCwd: task.sourceCwd,
			roleModel: task.model && task.thinking ? { model: task.model, thinking: task.thinking } : undefined,
			step: opts.step,
			signal,
			makeDetails,
			onProcessStarted: this.deps.onProcessStarted,
			acquireSlot: (s?: AbortSignal) => this.slots.acquire(s),
			onFirstToken,
			onStart: (result: SingleResult) => this.taskStarted(job, slot, result),
		};
		const taskText = task.worktree ? `You are in an isolated worktree ${task.worktree} on branch ${task.branch}; commit your work there; do not touch ${task.sourceCwd}.\n${opts.taskText}` : opts.taskText;
		let result: SingleResult;
		try {
			result = await runSingleAgent({ ...common, task: taskText, parentSession: spec.dispatchDefaults.parentSession });
		} catch (e) {
			job.thrown.set(slot, e instanceof Error ? e.message : String(e));
			this.settleTask(job, slot);
			this.persist(job.record);
			throw e;
		}
		job.returned.set(slot, result);
		this.settleTask(job, slot);
		this.persist(job.record);
		return result;
	}

	/** Parallel tasks never reject: an exception is recorded on its task and siblings keep running. */
	private async runParallelTask(job: ActiveJob, spec: LaunchSpec, opts: Parameters<SubagentJobManager["runTask"]>[2]): Promise<SingleResult | undefined> {
		try {
			return await this.runTask(job, spec, opts);
		} catch {
			return undefined;
		}
	}

	/** The child session exists and its model is resolved: record both before the child runs. */
	private taskStarted(job: ActiveJob, slot: number, result: SingleResult): void {
		job.started.set(slot, result);
		const task = job.record.tasks[slot];
		if (!task) return;
		task.state = "running";
		task.sessionFile = result.sessionFile;
		// Role frontmatter or parent defaults: the record names the model actually used.
		task.model ??= result.model;
		task.thinking ??= result.thinking;
		this.persist(job.record);
	}

	/**
	 * Final state, usage and error of one task, written as soon as it returns or throws.
	 * `error` names the job-level cause for a task that never returned.
	 */
	private settleTask(job: ActiveJob, index: number, error?: string): void {
		const task = job.record.tasks[index];
		if (!task) return;
		const returned = job.returned.get(index);
		const result = returned ?? job.started.get(index);
		if (!result) {
			task.state = "not_run";
			return;
		}
		task.usage = { ...result.usage };
		task.sessionFile ??= result.sessionFile;
		task.model ??= result.model;
		task.thinking ??= result.thinking;
		if (returned && !isFailedResult(returned)) task.state = "completed";
		else {
			task.state = "failed";
			task.error = returned
				? returned.errorMessage || returned.stopReason || returned.stderr.slice(0, 500) || "failed"
				: `did not finish: ${job.thrown.get(index) ?? error ?? "job stopped"}`;
		}
	}

	/** Tasks still unsettled at the end of the job; the job aggregate is the sum of all tasks. */
	private settleTasks(job: ActiveJob, error: string | undefined): { usage: UsageStats; sessionFiles: string[] } {
		const usage = emptyUsage();
		const sessionFiles: string[] = [];
		job.record.tasks.forEach((task, index) => {
			if (!job.returned.has(index) && !job.thrown.has(index)) this.settleTask(job, index, error);
			const result = job.returned.get(index) ?? job.started.get(index);
			if (!result) return;
			if (task.sessionFile) sessionFiles.push(task.sessionFile);
			usage.input += result.usage.input;
			usage.output += result.usage.output;
			usage.cacheRead += result.usage.cacheRead;
			usage.cacheWrite += result.usage.cacheWrite;
			usage.cost += result.usage.cost;
			usage.turns += result.usage.turns;
			usage.contextTokens = Math.max(usage.contextTokens, result.usage.contextTokens);
		});
		return { usage, sessionFiles };
	}

	private async run(job: ActiveJob, spec: LaunchSpec): Promise<void> {
		const signal = job.controller.signal;
		const makeDetails =
			(mode: JobMode) =>
			(results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope: spec.agentScope,
				projectAgentsDir: spec.projectAgentsDir,
				results,
			});
		let output = "";
		let error: string | undefined;

		try {
			spec = { ...spec, tasks: job.record.tasks };
			isolateWriters(job.record, spec.agents, () => writeRecord(this.deps.baseDir, job.record));
			if (spec.mode === "chain") {
				let previousOutput = "";
				for (let i = 0; i < spec.tasks.length; i++) {
					// An aborted job never starts another chain step.
					if (signal.aborted) {
						error = error ?? "Chain aborted before step " + (i + 1);
						break;
					}
					const step = spec.tasks[i];
					const next = spec.tasks[i + 1];
					const result = await this.runTask(job, spec, {
						slot: i,
						task: step,
						taskText: step.task.replace(/\{previous\}/g, () => previousOutput),
						step: i + 1,
						signal,
						makeDetails: makeDetails("chain"),
						// Cache E: enquanto esta etapa roda, aquece o prefixo do próximo papel.
						onFirstToken: next ? () => this.prefetchRole(job, spec, next, signal) : undefined,
					});
					const status = isFailedResult(result) ? "failed" : "completed";
					output += `${output ? "\n\n---\n\n" : ""}## step ${i + 1} · ${step.agent} · ${status}${result.sandbox ? ` · sandbox=${result.sandbox}` : ""}\n\n${getResultOutput(result)}`;
					if (isFailedResult(result)) {
						error = `Chain stopped at step ${i + 1} (${step.agent}); see its section in the result.`;
						break;
					}
					previousOutput = result.finalText;
				}
			} else if (spec.mode === "parallel") {
				const results = sharesPrefix(spec.tasks)
					? await this.runFanout(job, spec, signal, makeDetails("parallel"))
					: await mapWithConcurrencyLimit(
						spec.tasks,
						MAX_CONCURRENCY,
						(t, index) =>
							this.runParallelTask(job, spec, {
								slot: index,
								task: t,
								taskText: t.task,
								signal,
								makeDetails: makeDetails("parallel"),
							}),
						() => signal.aborted,
					);
				// Every sibling has settled here, including those of a task that threw.
				const done = results.filter(Boolean) as SingleResult[];
				const successCount = done.filter((r) => !isFailedResult(r)).length;
				// Full outputs are stored: only previews are bounded, elsewhere.
				const summaries: string[] = [];
				spec.tasks.forEach((t, i) => {
					const r = results[i];
					const threw = job.thrown.get(i);
					if (r) {
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						summaries.push(`### [${r.agent}] ${status}${r.sandbox ? ` · sandbox=${r.sandbox}` : ""}\n\n${getResultOutput(r)}`);
					} else if (threw !== undefined) summaries.push(`### [${t.agent}] failed (exception)\n\n${threw}`);
				});
				output = `Parallel: ${successCount}/${spec.tasks.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
				// Any failed child fails the job; every result and the usage are still kept.
				const failedNames = [
					...done.filter((r) => isFailedResult(r)).map((r) => r.agent),
					...[...job.thrown.keys()].map((i) => spec.tasks[i].agent),
				];
				const thrown = [...job.thrown].map(([i, message]) => `task ${i + 1} (${spec.tasks[i].agent}) threw: ${message}`);
				if (failedNames.length > 0)
					error = `${failedNames.length}/${spec.tasks.length} parallel task(s) failed: ${[...new Set(failedNames)].join(", ")}.${thrown.length ? ` ${thrown.join("; ")}.` : ""}`;
				else if (done.length < spec.tasks.length)
					error = `${spec.tasks.length - done.length} parallel task(s) never ran.`;
			} else {
				const t = spec.tasks[0];
				const result = await this.runTask(job, spec, {
					slot: 0,
					task: t,
					taskText: t.task,
					signal,
					makeDetails: makeDetails("single"),
				});
				// O parcial vai em output; o erro guarda só a causa, sem duplicar o texto.
				if (isFailedResult(result)) error = `Agent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || "(no error message)"}`;
				output = (result.sandbox ? `Sandbox: ${result.sandbox}\n\n` : "") + (result.finalText || (error ? "" : "(no output)"));
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			if (job.timer) clearTimeout(job.timer);
			// Aquecimento pendente (esperando slot/memória ou em voo) morre com o job, e o
			// estado terminal só é gravado depois que o filho dele fechou.
			if (job.warm) {
				job.warm.controller.abort();
				await Promise.allSettled([...job.warm.pending]);
			}
			this.active.delete(job.record.jobId);
		}

		const { usage, sessionFiles } = this.settleTasks(job, error);
		const isolated = worktreeSummary(job.record);
		if (isolated) output = `${isolated}\n\n${output}`;
		const gates = gateSummary(job.record, spec.agents);
		if (gates) output = `${output}\n\n${gates}`;
		const outputBytes = Buffer.byteLength(output, "utf-8");
		if (outputBytes > MAX_STORED_RESULT_BYTES) {
			// Never silently shrink a result: report the overflow instead.
			output = "";
			error = `${error ? `${error}\n` : ""}Result too large to store (${outputBytes} bytes > ${MAX_STORED_RESULT_BYTES}).`;
		}
		// Terminal state is only persisted once the child actually finished.
		const status: JobStatus = job.cancelRequested
			? "cancelled"
			: job.timedOut
				? "timeout"
				: error
					? "failed"
					: "completed";
		const heldSession = job.record.runs?.some(sessionMayBeOwned) ?? false;
		const finished: JobRecord = {
			...job.record,
			status: heldSession ? "interrupted" : status,
			finishedAt: this.now(),
			result: output || undefined,
			sessionFiles: sessionFiles.length ? sessionFiles : undefined,
			error: heldSession ? `${error ?? "Job stopped"}; session still owned or unreadable, legacy job data preserved.`
				: status === "timeout" ? (error ?? `Timed out after ${spec.timeoutSeconds}s.`) : error,
			usage,
			runs: heldSession ? job.record.runs : undefined,
		};
		job.record = finished;
		let persisted = false;
		try {
			writeRecord(this.deps.baseDir, finished);
			persisted = true;
		} catch (e) {
			finished.status = "failed";
			finished.error = `${error ?? ""} Could not persist final job record (${String(e)}); legacy job data preserved in ${this.deps.baseDir}.`.trim();
		}
		// Só remover a fonte de recuperação depois que o resultado está seguro no registro.
		if (persisted && !heldSession) removeJobRunDir(this.deps.baseDir, finished.sessionId, finished.jobId);
		try {
			this.deps.onComplete(finished);
		} catch {
			/* a stale callback must never break the manager */
		}
	}

	get(sessionId: string, jobId: string): JobRecord | null {
		const job = this.active.get(jobId);
		if (job && job.record.sessionId === sessionId) return job.record;
		return readRecord(this.deps.baseDir, sessionId, jobId);
	}

	list(sessionId: string): JobRecord[] {
		const records = listRecords(this.deps.baseDir, sessionId);
		for (const record of records) {
			if (gcWorktrees(record, this.now(), () => this.persist(record))) {
				fs.unlinkSync(jobPath(this.deps.baseDir, sessionId, record.jobId));
			} else this.persist(record);
		}
		return listRecords(this.deps.baseDir, sessionId);
	}

	/** Integração e descarte são explícitos; nunca fazem parte do término do job. */
	async manage(sessionId: string, jobId: string, action: "integrate" | "discard", taskIndex?: number, force = false): Promise<string> {
		const record = this.get(sessionId, jobId);
		if (!record) throw new Error(`Unknown job ${jobId}.`);
		return manageWorktrees(record, action, taskIndex, force, () => writeRecord(this.deps.baseDir, record));
	}

	/** Idempotent: returns promptly, terminal state lands when the child exits. */
	cancel(sessionId: string, jobId: string): { ok: boolean; message: string } {
		const job = this.active.get(jobId);
		if (!job || job.record.sessionId !== sessionId) {
			const record = readRecord(this.deps.baseDir, sessionId, jobId);
			if (!record) return { ok: false, message: `Unknown job ${jobId} in this session.` };
			return { ok: true, message: `Job ${jobId} already ${record.status}.` };
		}
		if (job.cancelRequested) return { ok: true, message: `Job ${jobId} cancellation already requested.` };
		job.cancelRequested = true;
		job.controller.abort();
		return { ok: true, message: `Job ${jobId} cancelling; terminal state persists when the child exits.` };
	}

	markNotified(record: JobRecord): void {
		if (record.notified) return;
		record.notified = true;
		try {
			writeRecord(this.deps.baseDir, record);
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Aborts only this manager's children and waits for them to actually settle.
	 * Awaited by `session_shutdown` so a quit does not orphan a child that ignores
	 * SIGTERM (the SIGKILL escalation lives inside the still-pending run promises).
	 */
	async shutdown(graceMs = 15000): Promise<void> {
		this.shuttingDown = true;
		const pending = [...this.active.values()];
		for (const job of pending) {
			job.cancelRequested = true;
			if (job.timer) clearTimeout(job.timer);
			job.controller.abort();
		}
		if (pending.length === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, graceMs);
			timer.unref?.();
		});
		await Promise.race([Promise.allSettled(pending.map((j) => j.done)).then(() => undefined), deadline]);
		if (timer) clearTimeout(timer);
	}

	/** Test/diagnostic helper: wait for all in-flight jobs to settle. */
	async drain(): Promise<void> {
		while (this.active.size > 0) {
			await Promise.all([...this.active.values()].map((j) => j.done));
		}
	}
}

/** Back up to a UTF-8 character boundary so paging never splits a codepoint. */
function alignDown(buf: Buffer, index: number): number {
	let i = Math.max(0, Math.min(index, buf.length));
	while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

function alignUp(buf: Buffer, index: number): number {
	let i = Math.max(0, Math.min(index, buf.length));
	while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

export function readResultSlice(
	record: JobRecord,
	offset: number,
	limit: number,
): { text: string; totalBytes: number; nextOffset: number | null } {
	return sliceText(resultBody(record), offset, limit);
}

/** One bounded page (≤ RESULT_READ_CAP bytes) of a text, on UTF-8 boundaries. */
export function sliceText(
	full: string,
	offset: number,
	limit: number,
): { text: string; totalBytes: number; nextOffset: number | null } {
	const buf = Buffer.from(full, "utf-8");
	// Non-finite/NaN/fractional input must not become a NaN slice.
	const rawOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
	const rawLimit = Number.isFinite(limit) ? Math.trunc(limit) : RESULT_READ_CAP;
	const start = alignDown(buf, Math.max(0, Math.min(rawOffset, buf.length)));
	const cap = Math.max(1, Math.min(rawLimit > 0 ? rawLimit : RESULT_READ_CAP, RESULT_READ_CAP));
	let end = Math.min(buf.length, start + cap);
	end = alignDown(buf, end);
	// A cap smaller than the next character must still make progress.
	if (end <= start && start < buf.length) end = alignUp(buf, start + 1);
	return {
		text: buf.subarray(start, end).toString("utf-8"),
		totalBytes: buf.length,
		nextOffset: end < buf.length ? end : null,
	};
}

function resultBody(record: JobRecord): string {
	const body = record.result
		? record.error
			? `${record.result}\n\n[error] ${record.error}`
			: record.result
		: (record.error ?? "(no output)");
	const sessions = record.sessionFiles?.length ? `[child sessions]\n${record.sessionFiles.join("\n")}\n\n` : "";
	return sessions + body;
}

export function summarizeForNotification(record: JobRecord): string {
	const body = resultBody(record);
	const buf = Buffer.from(body, "utf-8");
	if (buf.length <= NOTIFY_SUMMARY_CAP) return body;
	return `${buf.subarray(0, NOTIFY_SUMMARY_CAP).toString("utf-8")}\n\n[truncated: ${buf.length - NOTIFY_SUMMARY_CAP} bytes; read the rest with subagent action:"result"]`;
}
