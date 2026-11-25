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
import { type ModelRegistry, type ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { commitWip, gateSummary, gcWorktrees, isolateWriters, manageWorktrees, worktreeSummary } from "./worktrees.ts";
import { getRoleModelChoices, isGoogleApiModel, resolveGeminiPreference, resolveModelRef, resolveRoleModel } from "../lib/tiers.ts";
import type { AgentConfig, AgentScope } from "./agents.ts";
import {
	type DurableRunState,
	MAX_RESUMES,
	removeJobRunDir,
	sessionMayBeOwned,
} from "./legacy-runs.ts";
import { ownerMayBeAlive, readProcessIdentity, type ProcessIdentity } from "./process-owner.ts";
import {
	acquireSessionLock,
	assignHandles,
	type ChildInvocation,
	fileSha,
	type HandleEntry,
	readRegistry,
	updateRegistry,
} from "./handles.ts";
// @ts-ignore — módulo JS compartilhado, sem tipos
import { staggeredFanout } from "../../../core/cache-policy.mjs";
import { childCacheRetention } from "../../../core/child-env.mjs";
import {
	ChildSlots,
	type DispatchDefaults,
	emptyUsage,
	type FailureClass,
	GLOBAL_CHILD_LIMIT,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	prefetchAgent,
	PREFETCH_EXIT,
	prettyModelLabel,
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
	return JSON.stringify([task.agent, task.model ?? null, task.thinking ?? null, task.sourceCwd ?? task.cwd ?? defaultCwd, task.skills ?? []]);
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
	/** Extra skill names requested at launch, on top of the role allowlist. */
	skills?: string[];
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
	/** Launch input only: caller-chosen handle for this task. */
	name?: string;
	/** Stable per-session name (`<role>-<n>` or `name`); `continue` addresses the task by it. */
	handle?: string;
	/** Launch snapshot of the child invocation (see handles.ts). */
	invocation?: ChildInvocation;
	/** Failure class of the task's last run: "quota" = provider quota, rate limit or capacity. */
	failure?: FailureClass;
	/** Model switch after a quota failure: automatic (read-only fallback) or asked by `continue`. */
	modelSwitch?: { from?: string; to: string; reason: "quota"; auto: boolean; at: number };
	/** Hard timeout: sha of `WIP(agent): timeout <jobId>` in the job worktree. */
	wipCommit?: string;
	wipError?: string;
}

/** Soft timeout margin: 10% of the job timeout, at least 3 minutes, at most half the timeout. */
export const SOFT_TIMEOUT_MIN_MARGIN_MS = 3 * 60 * 1000;

/** Quota failures, model switches and timeout WIP commits, one line per event. */
export function recoveryNotes(record: JobRecord): string {
	return record.tasks.flatMap((task, i) => {
		const label = `task ${i + 1} (${task.agent}${task.handle ? `, handle ${task.handle}` : ""})`;
		const lines: string[] = [];
		const moved = task.modelSwitch;
		if (moved?.auto) lines.push(`${label}: quota/rate limit on ${moved.from ?? "the default model"}; retried once on ${moved.to} over the same session (read-only fallback).`);
		else if (moved && record.continuesFrom) lines.push(`${label}: continued on ${moved.to} after a quota failure on ${moved.from ?? "the default model"}.`);
		if (task.failure === "quota")
			lines.push(`${label}: failed on provider quota/rate limit/capacity (model ${task.model ?? "default"}).${task.handle ? ` The handle waits: continue it with "model" set to another model allowed for this role.` : ""}`);
		if (task.wipCommit) lines.push(`${label}: hard timeout; work in progress committed as ${task.wipCommit} (WIP(agent): timeout ${record.jobId}).${task.handle ? " Continue the handle to resume." : ""}`);
		if (task.wipError) lines.push(`${label}: hard timeout; WIP commit failed: ${task.wipError}`);
		return lines;
	}).join("\n");
}

/** Absolute epoch ms of the soft-timeout steer: start + timeout - margin, never before start. */
export function softDeadlineMs(startMs: number, timeoutSeconds: number): number {
	const timeoutMs = timeoutSeconds * 1000;
	// Short timeouts warn at half time instead of on the first turn.
	const margin = Math.min(Math.max(timeoutMs * 0.1, SOFT_TIMEOUT_MIN_MARGIN_MS), timeoutMs / 2);
	return Math.max(startMs, startMs + timeoutMs - margin);
}

/** Read-only automatic fallback: the child's follow-up turn on the next model. */
export const QUOTA_FALLBACK_MESSAGE =
	"The previous attempt stopped on a provider quota/rate limit before finishing; you now run on another model. Continue the task from where it stopped.";

/**
 * `not_run`: the job ended before this task started (chain stop, abort).
 * `interrupted`: the parent died while this task ran; its session file is kept.
 */
export type TaskState = "running" | "completed" | "failed" | "not_run" | "interrupted";

/** Config do papel no próprio arquivo .md do usuário (`model:`/`tier:`/`thinking:`). */
export type RoleFileConfig = Pick<AgentConfig, "name" | "runner" | "model" | "thinking">;
type DispatchModelRegistry = Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">;

function piModelFilter(registry?: DispatchModelRegistry): typeof isGoogleApiModel {
	let runtime: Pick<ModelRuntime, "getModels" | "hasConfiguredAuth"> | undefined;
	const checked = new Map<string, boolean>();
	return (ref) => {
		if (isGoogleApiModel(ref)) return true;
		if (!ref || !registry) return false;
		const cached = checked.get(ref);
		if (cached !== undefined) return cached;
		if (!runtime) {
			const models = registry.getAll();
			const byProvider = new Map(models.map((m) => [m.provider, m]));
			runtime = {
				getModels: () => models,
				hasConfiguredAuth: (provider) => {
					const model = byProvider.get(provider);
					return model !== undefined && registry.hasConfiguredAuth(model);
				},
			};
		}
		// Pi's --model also matches partial IDs and display names. Reuse its
		// resolver (which only reads these two methods), not our own fuzzy rules.
		const { model } = resolveCliModel({ cliModel: ref, modelRuntime: runtime as ModelRuntime });
		const blocked = model ? isGoogleApiModel(`${model.provider}/${model.id}`) : false;
		checked.set(ref, blocked);
		return blocked;
	};
}

export function resolveJobTaskModels(tasks: JobTaskSpec[], defaults?: DispatchDefaults, roleFiles?: readonly RoleFileConfig[], registry?: DispatchModelRegistry): { ok: true; tasks: JobTaskSpec[] } | { ok: false; error: string } {
	const isBlocked = piModelFilter(registry);
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
	const checkPiModel = (model: string | undefined) => {
		if (isBlocked(model)) throw new Error("Agent: Google API models are not available for Pi subagents. Choose another model in /models or use the gemini role via agy.");
	};
	const checkInheritedModel = (file?: RoleFileConfig) => {
		checkPiModel(file?.model ? resolveModelRef(file.model).model : defaults?.model);
	};
	try {
		if (defaults?.resources) {
			const primary = defaults.model;
			const configuredSupport = defaults.resources.supportModel;
			const support = () => configuredSupport && !isBlocked(configuredSupport) ? configuredSupport : primary;
			return { ok: true, tasks: tasks.map((task) => {
				const external = externalTask(task);
				if (external) return external;
				checkPiModel(task.model);
				if (!primary) throw new Error("Agent: parent model unavailable.");
				// A config do papel que o usuário já tinha (`roleModels`: modelo + thinking por papel)
				// é autoritativa e NUNCA é zerada pelo piloto; o slot principal/apoio só preenche
				// papel sem config própria.
				const own = resolveRoleModel(task.agent, task.model, { isBlocked, allowUnconfiguredOverride: true });
				if (own) return { ...task, model: own.model, thinking: own.thinking };
				// Papel que traz `model`/`thinking` no próprio .md e chamada sem escolha explícita:
				// o arquivo do usuário decide (o runner resolve `tier:`/thinking do frontmatter).
				const file = roleFiles?.find((role) => role.name === task.agent);
				if (!task.model && (file?.model || file?.thinking)) {
					checkInheritedModel(file);
					return { ...task };
				}
				// Slot vem da receita; sem receita, scout em apoio e o resto no principal.
				const slot = task.slot ?? defaults.resources?.slots?.[task.agent] ?? (task.agent === "scout" ? "apoio" : "principal");
				const model = task.model ?? (slot === "apoio" ? support() : primary);
				if (model !== primary && model !== support()) {
					throw new Error(`Agent: ${task.agent} deve usar principal ou apoio configurado em /models; recebido ${model}.`);
				}
				// Papel sem config própria: slot do piloto e o thinking do pedido.
				checkPiModel(model);
				return { ...task, model, thinking: defaults.thinkingLevel ?? "medium" };
			}) };
		}
		return {
			ok: true,
			tasks: tasks.map((task) => {
				const external = externalTask(task);
				if (external) return external;
				checkPiModel(task.model);
				const selected = resolveRoleModel(task.agent, task.model, { isBlocked });
				if (selected) return { ...task, model: selected.model, thinking: selected.thinking };
				checkInheritedModel(roleFiles?.find((role) => role.name === task.agent));
				return { ...task };
			}),
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Next model of a role after `current`, for the read-only quota fallback: the role's
 * own list (`roleModels`), or the pilot's principal/apoio pair for a role without its
 * own config. Each candidate passes the launch resolution; wraps around once.
 */
export function nextRoleModel(agent: string, current: string | undefined, defaults: DispatchDefaults | undefined, roleFiles: readonly RoleFileConfig[], registry?: DispatchModelRegistry): { model: string; thinking?: string } | undefined {
	let list: string[];
	try {
		const own = getRoleModelChoices(agent);
		// A configured role (even with an empty list) never falls back to the pilot pair.
		if (own !== undefined) list = own.map((choice) => choice.model);
		else {
			const file = roleFiles.find((role) => role.name === agent);
			if (!defaults?.resources || !defaults.model || file?.runner === "agy" || file?.model || file?.thinking) return undefined;
			list = [defaults.model, defaults.resources.supportModel || defaults.model];
		}
	} catch {
		return undefined;
	}
	const unique = [...new Set(list)];
	const at = current ? unique.indexOf(current) : -1;
	const candidates = at >= 0 ? [...unique.slice(at + 1), ...unique.slice(0, at)] : unique.filter((model) => model !== current);
	for (const model of candidates) {
		const resolved = resolveJobTaskModels([{ agent, task: "", model }], defaults, roleFiles, registry);
		if (resolved.ok && resolved.tasks[0].model) return { model: resolved.tasks[0].model, thinking: resolved.tasks[0].thinking };
	}
	return undefined;
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
	/** `continue` job: the launch task whose child session this job resumed. */
	continuesFrom?: { jobId: string; taskIndex: number; handle: string };
}

export interface ContinueSpec {
	jobId: string;
	sessionId: string;
	sessionGeneration: number;
	anchorEntryId?: string | null;
	handle: string;
	message: string;
	/** Only after a quota failure: another model allowed for the role (launch resolution). */
	model?: string;
	agents: AgentConfig[];
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	dispatchDefaults: DispatchDefaults;
	/** Same Google API filter as launch: a quota switch cannot route Gemini through Pi. */
	modelRegistry?: DispatchModelRegistry;
	timeoutSeconds: number;
}

export type ContinueOutcome =
	| { ok: true; record: JobRecord; resultPath: string; entry: HandleEntry; warnings: string[] }
	| { ok: false; error: string };

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
	modelRegistry?: DispatchModelRegistry;
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
	settleInterruptedHandles(baseDir, updated);
	return updated;
}

/** Parent crash: handles of the interrupted job leave "running" (waiting if a Pi session exists, else closed). */
function settleInterruptedHandles(baseDir: string, record: JobRecord): void {
	if (!record.tasks.some((task) => task.handle)) return;
	try {
		updateRegistry(baseDir, record.sessionId, (registry) => {
			for (const task of record.tasks) {
				const entry = task.handle ? registry.handles[task.handle] : undefined;
				if (!entry || entry.lastJobId !== record.jobId || entry.lifecycle !== "running") continue;
				const sessionFile = task.sessionFile ?? entry.sessionFile;
				const resumable = (task.invocation ?? entry.invocation)?.runner === "pi" && !!sessionFile && fs.existsSync(sessionFile);
				entry.lifecycle = resumable ? "waiting" : "closed";
				entry.closedReason = resumable ? undefined : "the parent restarted before the task opened a child session";
				entry.updatedAt = Date.now();
			}
		});
	} catch {
		/* best-effort: continueBlocker still reads the job record */
	}
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
	/** `continue`: lock next to the child JSONL, released when the job settles. */
	releaseLock?: () => void;
	/** AGENT_CHILD_SOFT_DEADLINE_MS for this job's children. */
	softDeadlineMs?: number;
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
		const resolvedTasks = resolveJobTaskModels(spec.tasks, spec.dispatchDefaults, spec.agents, spec.modelRegistry);
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
				...(t.skills?.length ? { skills: [...t.skills] } : {}),
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

		// Handles are reserved with the record: names are unique per parent session.
		try {
			const handles = updateRegistry(this.deps.baseDir, spec.sessionId, (registry) => {
				const names = spec.tasks.map((t) => t.name).filter((name): name is string => Boolean(name));
				const taken = names.filter((name, i) => registry.handles[name] || names.indexOf(name) !== i);
				if (taken.length > 0) throw new Error(`Handle name(s) already used in this session: ${taken.join(", ")}. Pick another name or omit it.`);
				return assignHandles(registry, spec.tasks, jobId, record.createdAt);
			});
			record.tasks.forEach((task, index) => { task.handle = handles[index]; });
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		// Persist the launch before acknowledging it, so a crash right after the
		// ack still leaves a record that restore() can mark interrupted.
		const resultPath = writeRecord(this.deps.baseDir, record);
		this.start(record, spec);
		return { ok: true, record, resultPath };
	}

	/** Shared lifecycle for a fresh dispatch and a restored job. */
	private start(record: JobRecord, spec: LaunchSpec, releaseLock?: () => void): void {
		const controller = new AbortController();
		const job: ActiveJob = {
			record,
			controller,
			releaseLock,
			cancelRequested: false,
			timedOut: false,
			done: Promise.resolve(),
			started: new Map(),
			returned: new Map(),
			thrown: new Map(),
		};
		if (spec.timeoutSeconds > 0) {
			job.softDeadlineMs = softDeadlineMs(Date.now(), spec.timeoutSeconds);
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
			skills: task.skills,
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
		// A continue job rebuilds the launch argv over the same child session.
		const resume = job.record.continuesFrom && task.invocation && task.sessionFile
			? { invocation: task.invocation, sessionFile: task.sessionFile }
			: undefined;
		const common = {
			defaultCwd: spec.cwd,
			dispatchDefaults: spec.dispatchDefaults,
			agents: spec.agents,
			agentName: task.agent,
			cwd: task.cwd,
			sourceCwd: resume ? resume.invocation.sourceCwd : task.sourceCwd,
			resume,
			roleModel: task.model && task.thinking ? { model: task.model, thinking: task.thinking } : undefined,
			skills: task.skills,
			step: opts.step,
			signal,
			makeDetails,
			onProcessStarted: this.deps.onProcessStarted,
			acquireSlot: (s?: AbortSignal) => this.slots.acquire(s),
			onFirstToken,
			onStart: (result: SingleResult) => this.taskStarted(job, slot, result),
			softDeadlineMs: job.softDeadlineMs,
		};
		const taskText = !resume && task.worktree ? `You are in an isolated worktree ${task.worktree} on branch ${task.branch}; commit your work there; do not touch ${task.sourceCwd}.\n${opts.taskText}` : opts.taskText;
		let result: SingleResult;
		try {
			result = await runSingleAgent({ ...common, task: taskText, parentSession: spec.dispatchDefaults.parentSession });
			result = await this.quotaFallback(job, spec, task, result, common);
			// The child and its process tree are gone here (runChild waits): safe to commit.
			if (job.timedOut && result.stopReason === "aborted") this.commitTimeoutWip(job, task);
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

	/**
	 * Read-only roles only: after a quota/rate/capacity failure, one more run on the
	 * next model of the role over the same child session. Writers never switch alone.
	 */
	private async quotaFallback(job: ActiveJob, spec: LaunchSpec, task: JobTaskSpec, first: SingleResult, common: Omit<Parameters<typeof runSingleAgent>[0], "task">): Promise<SingleResult> {
		const invocation = first.invocation;
		if (first.failure !== "quota" || job.controller.signal.aborted || invocation?.runner !== "pi" || invocation.writes) return first;
		if (task.modelSwitch?.auto || !first.sessionFile || !fs.existsSync(first.sessionFile)) return first;
		const next = nextRoleModel(task.agent, invocation.model, spec.dispatchDefaults, spec.agents, spec.modelRegistry);
		if (!next) return first;
		const switched: ChildInvocation = { ...invocation, model: next.model, thinking: next.thinking ?? invocation.thinking, modelLabel: prettyModelLabel(next.model, undefined) };
		task.modelSwitch = { from: invocation.model, to: next.model, reason: "quota", auto: true, at: this.now() };
		task.invocation = switched;
		task.model = switched.model;
		task.thinking = switched.thinking;
		this.persist(job.record);
		if (task.handle) this.touchHandle(job.record, task.handle, (entry) => { entry.invocation = switched; });
		const second = await runSingleAgent({ ...common, resume: { invocation: switched, sessionFile: first.sessionFile }, task: QUOTA_FALLBACK_MESSAGE });
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) second.usage[key] += first.usage[key];
		return second;
	}

	/** The job's own worktree for this task; never the user's checkout. */
	private jobWorktree(record: JobRecord, task: JobTaskSpec): string | undefined {
		let worktree = task.worktree && !task.worktreeRemoved ? task.worktree : undefined;
		if (!worktree && record.continuesFrom) worktree = readRegistry(this.deps.baseDir, record.sessionId).handles[record.continuesFrom.handle]?.worktree;
		const source = task.sourceCwd ?? task.invocation?.sourceCwd;
		if (!worktree || !source || !fs.existsSync(worktree)) return undefined;
		if (path.resolve(worktree) === path.resolve(source)) return undefined;
		return worktree;
	}

	/** Hard timeout, after the child tree exited: `WIP(agent): timeout <jobId>` in the job worktree. */
	private commitTimeoutWip(job: ActiveJob, task: JobTaskSpec): void {
		const worktree = this.jobWorktree(job.record, task);
		if (!worktree) return;
		try {
			const sha = commitWip(worktree, job.record.jobId);
			if (sha) task.wipCommit = sha;
		} catch (error) {
			task.wipError = error instanceof Error ? error.message : String(error);
		}
		this.persist(job.record);
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
		task.invocation ??= result.invocation;
		this.persist(job.record);
		if (task.handle && !job.record.continuesFrom) {
			this.touchHandle(job.record, task.handle, (entry) => {
				entry.sessionFile = task.sessionFile;
				entry.invocation = task.invocation;
				entry.cwd = task.invocation?.cwd ?? task.cwd;
				entry.worktree = task.worktree;
				entry.branch = task.branch;
			});
		}
	}

	/** Registry update for a handle this job still drives; a newer job owns it otherwise. */
	private touchHandle(record: JobRecord, handle: string, change: (entry: HandleEntry) => void): void {
		try {
			updateRegistry(this.deps.baseDir, record.sessionId, (registry) => {
				const entry = registry.handles[handle];
				if (!entry || entry.lastJobId !== record.jobId) return;
				change(entry);
				entry.updatedAt = this.now();
			});
		} catch {
			/* best-effort: the job record still names the session file */
		}
	}

	/** Job end: a task with a live Pi session waits for `continue`; anything else closes. */
	private settleHandles(record: JobRecord): void {
		record.tasks.forEach((task) => {
			if (!task.handle) return;
			this.touchHandle(record, task.handle, (entry) => {
				const resumable = task.invocation?.runner === "pi" && task.sessionFile && fs.existsSync(task.sessionFile);
				if (entry.lifecycle === "closed") return;
				// Last run's provider failure: `continue` accepts `model` only after "quota".
				entry.failure = task.failure;
				entry.wipCommit = task.wipCommit;
				if (resumable) {
					entry.lifecycle = "waiting";
					entry.closedReason = undefined;
				} else {
					entry.lifecycle = "closed";
					entry.closedReason = task.invocation?.runner === "agy" ? "agy runner keeps no Pi session" : "the task never started a child session";
				}
			});
		});
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
		if (returned?.failure) task.failure = returned.failure;
		else delete task.failure;
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
		const isolated = worktreeSummary(this.worktreeView(job.record));
		if (isolated) output = `${isolated}\n\n${output}`;
		const recovery = recoveryNotes(job.record);
		if (recovery) output = `${output}\n\n${recovery}`;
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
		this.settleHandles(finished);
		job.releaseLock?.();
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

	/** A continue job shows the worktree of the launch task it resumed. */
	private worktreeView(record: JobRecord): JobRecord {
		const from = record.continuesFrom;
		if (!from) return record;
		const entry = readRegistry(this.deps.baseDir, record.sessionId).handles[from.handle];
		const origin = readRecord(this.deps.baseDir, record.sessionId, from.jobId)?.tasks[from.taskIndex - 1];
		if (!entry?.worktree || !origin?.worktree || origin.worktreeRemoved) return { ...record, tasks: [] };
		return { ...record, tasks: [{ ...origin }] };
	}

	/**
	 * Refusals for `continue`, checked before anything is anchored or locked:
	 * unknown handle, agy runner, still running, closed, worktree gone, no session.
	 */
	continueBlocker(sessionId: string, handle: string, agents: AgentConfig[], model?: string): { ok: true; entry: HandleEntry & { sessionFile: string }; invocation: ChildInvocation } | { ok: false; error: string } {
		if (!isSafeId(sessionId)) return { ok: false, error: "Unsafe session id; refusing to continue." };
		const registry = readRegistry(this.deps.baseDir, sessionId);
		const entry = registry.handles[handle];
		if (!entry) return { ok: false, error: `Unknown handle ${handle} in this session. Use action "list" to see handles.` };
		const invocation = entry.invocation;
		const roleRunner = agents.find((a) => a.name === entry.agent)?.runner;
		if (invocation?.runner === "agy" || (!invocation && roleRunner === "agy"))
			return { ok: false, error: `Handle ${entry.handle} ran on the agy runner (${entry.agent}), which keeps no Pi session to resume. Use action "launch" with a fresh brief.` };
		if (entry.lifecycle === "running") {
			const last = this.active.get(entry.lastJobId)?.record ?? readRecord(this.deps.baseDir, sessionId, entry.lastJobId);
			if (this.active.has(entry.lastJobId) || (last?.status === "running" && ownedByLiveForeignParent(last)))
				return { ok: false, error: `Handle ${entry.handle} is still running in job ${entry.lastJobId}. Wait for its result, then continue.` };
		}
		if (entry.lifecycle === "closed")
			return { ok: false, error: `Handle ${entry.handle} is closed (${entry.closedReason ?? "closed"}). Launch a new task instead.` };
		if (entry.worktree && !fs.existsSync(entry.worktree)) {
			this.closeHandles(sessionId, [entry.handle], "worktree removed");
			return { ok: false, error: `Handle ${entry.handle}: worktree ${entry.worktree} was removed. Launch a new task instead.` };
		}
		if (!invocation || !entry.sessionFile || !fs.existsSync(entry.sessionFile))
			return { ok: false, error: `Handle ${entry.handle} has no child session to resume${entry.sessionFile ? ` (${entry.sessionFile} is missing)` : ""}. Launch a new task instead.` };
		// Decision (d): a model switch keeps context but loses the cache; only quota justifies it.
		if (model !== undefined && entry.failure !== "quota")
			return { ok: false, error: `Handle ${entry.handle}: "model" is accepted only after a quota/rate-limit failure, and its last run ${entry.failure ? `failed with "${entry.failure}"` : "did not fail on quota"}. Continue without "model" to keep ${invocation.model ?? "the same model"}.` };
		return { ok: true, entry: entry as HandleEntry & { sessionFile: string }, invocation };
	}

	/**
	 * `continue`: a new async single-task job over the same child JSONL, cwd/worktree
	 * and launch snapshot. The job ends with the usual terminal status; the handle
	 * goes back to `waiting`.
	 */
	continueTask(spec: ContinueSpec): ContinueOutcome {
		if (this.shuttingDown) return { ok: false, error: "Session is shutting down; no new subagent jobs." };
		if (this.active.size >= MAX_ACTIVE_JOBS)
			return { ok: false, error: `Too many subagent jobs running (${this.active.size}/${MAX_ACTIVE_JOBS}). Wait or cancel one (action: "list" / "cancel").` };
		if (!isSafeId(spec.jobId)) return { ok: false, error: "Unsafe job id; refusing to continue." };
		const checked = this.continueBlocker(spec.sessionId, spec.handle, spec.agents, spec.model);
		if (!checked.ok) return checked;
		const { entry } = checked;
		let invocation = checked.invocation;
		let modelSwitch: JobTaskSpec["modelSwitch"];
		if (spec.model !== undefined) {
			// Same resolution as launch: the role's allowlist (or the pilot's principal/apoio pair).
			const resolved = resolveJobTaskModels([{ agent: entry.agent, task: spec.message, model: spec.model }], spec.dispatchDefaults, spec.agents, spec.modelRegistry);
			if (!resolved.ok) return { ok: false, error: `Handle ${entry.handle}: model ${spec.model} refused. ${resolved.error}` };
			const chosen = resolved.tasks[0];
			if (!chosen.model) return { ok: false, error: `Handle ${entry.handle}: model ${spec.model} refused; the role has no model allowlist.` };
			invocation = { ...invocation, model: chosen.model, thinking: chosen.thinking ?? invocation.thinking, modelLabel: prettyModelLabel(chosen.model, undefined) };
			modelSwitch = { from: checked.invocation.model, to: chosen.model, reason: "quota", auto: false, at: this.now() };
		}
		const lock = acquireSessionLock(entry.sessionFile, spec.jobId);
		if (!lock.ok)
			return { ok: false, error: `Another continue is already writing to ${entry.sessionFile}${lock.owner ? ` (job ${lock.owner.jobId}, pid ${lock.owner.pid})` : ""}. Wait for it to finish.` };

		const warnings: string[] = [];
		if (invocation.roleSha && fileSha(invocation.roleFile) !== invocation.roleSha)
			warnings.push(`Role file of ${entry.agent} changed since launch; continuing with the launch snapshot (system prompt, tools, model).`);

		const dispatchDefaults: DispatchDefaults = { ...spec.dispatchDefaults };
		// Only a writer running in place gets a /rewind checkpoint; a worktree isolates it already.
		if (!invocation.writes || invocation.sourceCwd !== undefined) delete dispatchDefaults.writerCheckpoint;
		const now = this.now();
		const record: JobRecord = {
			version: 2,
			jobId: spec.jobId,
			sessionId: spec.sessionId,
			mode: "single",
			status: "running",
			agents: [entry.agent],
			tasks: [{
				agent: entry.agent,
				task: spec.message,
				cwd: invocation.cwd,
				model: invocation.model,
				thinking: invocation.thinking,
				handle: entry.handle,
				invocation,
				sessionFile: entry.sessionFile,
				...(modelSwitch ? { modelSwitch } : {}),
			}],
			cwd: invocation.cwd,
			agentScope: spec.agentScope,
			timeoutSeconds: spec.timeoutSeconds,
			createdAt: now,
			anchorEntryId: spec.anchorEntryId ?? null,
			sessionGeneration: spec.sessionGeneration,
			parentPid: process.pid,
			parentIdentity: readProcessIdentity(process.pid),
			continuesFrom: { jobId: entry.jobId, taskIndex: entry.taskIndex, handle: entry.handle },
		};
		let resultPath: string;
		try {
			resultPath = writeRecord(this.deps.baseDir, record);
			updateRegistry(this.deps.baseDir, spec.sessionId, (current) => {
				const live = current.handles[entry.handle];
				if (!live) return;
				live.lifecycle = "running";
				live.lastJobId = record.jobId;
				live.continues++;
				// Later continues keep the switched model: the session now runs on it.
				if (modelSwitch) live.invocation = invocation;
				live.updatedAt = now;
			});
		} catch (error) {
			lock.release();
			return { ok: false, error: `Could not persist the continue job: ${error instanceof Error ? error.message : String(error)}` };
		}
		this.start(record, {
			jobId: record.jobId,
			sessionId: spec.sessionId,
			sessionGeneration: spec.sessionGeneration,
			anchorEntryId: spec.anchorEntryId,
			mode: "single",
			tasks: record.tasks,
			agents: spec.agents,
			agentScope: spec.agentScope,
			projectAgentsDir: spec.projectAgentsDir,
			dispatchDefaults,
			modelRegistry: spec.modelRegistry,
			cwd: invocation.cwd,
			timeoutSeconds: spec.timeoutSeconds,
		}, lock.release);
		return { ok: true, record, resultPath, entry: readRegistry(this.deps.baseDir, spec.sessionId).handles[entry.handle] ?? entry, warnings };
	}

	/** Handles of this session, oldest first. */
	handles(sessionId: string): HandleEntry[] {
		if (!isSafeId(sessionId)) return [];
		return Object.values(readRegistry(this.deps.baseDir, sessionId).handles).sort((a, b) => a.createdAt - b.createdAt);
	}

	private closeHandles(sessionId: string, handles: string[], reason: string): void {
		if (handles.length === 0) return;
		try {
			updateRegistry(this.deps.baseDir, sessionId, (registry) => {
				for (const name of handles) {
					const entry = registry.handles[name];
					if (!entry || (entry.lifecycle === "running" && this.active.has(entry.lastJobId))) continue;
					entry.lifecycle = "closed";
					entry.closedReason = reason;
					entry.updatedAt = this.now();
				}
			});
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Integração e descarte são explícitos; nunca fazem parte do término do job.
	 * On a continue job they act on the launch task that owns the worktree. Both close
	 * the selected handles: the child session is done.
	 */
	async manage(sessionId: string, jobId: string, action: "integrate" | "discard", taskIndex?: number, force = false): Promise<string> {
		let record = this.get(sessionId, jobId);
		if (!record) throw new Error(`Unknown job ${jobId}.`);
		if (record.continuesFrom) {
			if (record.status === "running") throw new Error("Job still running or has unresolved children.");
			if (taskIndex !== undefined && taskIndex !== 1) throw new Error("taskIndex must be a 1-based task index.");
			const from = record.continuesFrom;
			const origin = this.get(sessionId, from.jobId);
			if (!origin) throw new Error(`Launch job ${from.jobId} of handle ${from.handle} is gone; nothing to ${action}.`);
			record = origin;
			taskIndex = from.taskIndex;
		}
		const target = record;
		const registry = readRegistry(this.deps.baseDir, sessionId);
		const selected = target.tasks
			.map((task, i) => ({ task, index: i + 1 }))
			.filter(({ index }) => taskIndex === undefined || taskIndex === index)
			.map(({ task, index }) => task.handle ?? Object.values(registry.handles).find((h) => h.jobId === target.jobId && h.taskIndex === index)?.handle)
			.filter((handle): handle is string => Boolean(handle));
		const busy = selected.filter((handle) => registry.handles[handle]?.lifecycle === "running" && this.active.has(registry.handles[handle].lastJobId));
		if (busy.length > 0) throw new Error(`Handle(s) ${busy.join(", ")} still running a continue job; wait for it before ${action}.`);
		const text = await manageWorktrees(target, action, taskIndex, force, () => writeRecord(this.deps.baseDir, target));
		this.closeHandles(sessionId, selected, action === "integrate" ? "integrated" : "discarded");
		return text;
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
