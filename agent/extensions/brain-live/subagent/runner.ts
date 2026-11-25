/**
 * Child process runner for subagents.
 *
 * Extracted from index.ts so the async job manager (jobs.ts) and its tests can
 * drive real execution without loading the TUI/extension surface. The only
 * runtime imports here are node builtins plus agent discovery/tier lookup, so a
 * test can import this module and swap `runnerHooks.spawn` for a fake child.
 */

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, getPackageDir, loadProjectContextFiles, SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { captureWriter, type WriterCheckpoint } from "../lib/checkpoint-store.ts";
import { resolveModelRef } from "../lib/tiers.ts";
import { NO_DELEGATE_ENV, subagentEnv, userCommandEnv } from "../../../core/child-env.mjs";
import { hasRules, selectProjectContext } from "../../../core/project-context.mjs";
import { projectRules } from "../../../core/workflow.mjs";
import { readHostFreePercent, waitForHostMemory } from "./host-memory.ts";
import { isProcessAlive, listDescendants, signalProcesses } from "./process-tree.ts";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { type ChildInvocation, fileSha } from "./handles.ts";

/** Preview cap. Never applied to what is stored: full outputs are kept in the job record. */
export const PREVIEW_OUTPUT_CAP = 50 * 1024;
/** A single JSONL line bigger than this is a protocol/output overflow: explicit error, never silent truncation. */
export const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
/**
 * Total stdout budget for one child: guards against runaway output, not memory (lines are
 * parsed and dropped; only the last assistant text is kept, and the per-line cap bounds the
 * buffer). `pi --mode json` repeats each tool result in ~4 events, so a long worker legitimately
 * streams tens of MB; 16 MB killed real 30-minute implementation jobs.
 */
export const MAX_STDOUT_TOTAL_BYTES = 256 * 1024 * 1024;
/** Streaming previews the runner ignores (`pi --mode json` serializes `type` first). */
export function isStreamingPreviewLine(line: string): boolean {
	return line.startsWith('{"type":"message_update"') || line.startsWith('{"type":"tool_execution_update"');
}
/** stderr is diagnostic only: bounded in memory. */
export const MAX_STDERR_BYTES = 64 * 1024;
/** Above this, the task goes to a temp file passed as `@path` instead of argv (E2BIG guard). */
export const ARG_INLINE_CAP = 16 * 1024;
/**
 * Shared ceiling of concurrently spawned children (all jobs of one manager).
 * Deliberately high: a `pi` child is 100-200 MB and the memory guard is the
 * host-free check in host-memory.ts, not a head count.
 */
export const GLOBAL_CHILD_LIMIT = 32;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	/** Only the last assistant text is retained — never the tool/thinking transcript. */
	finalText: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	modelLabel?: string;
	/** Effective CLI thinking level (fixed by the selected role/model pair). */
	thinking?: string;
	/** Isolamento do bash de papéis somente leitura. */
	sandbox?: SandboxMode;
	stopReason?: string;
	errorMessage?: string;
	/** Caminho da sessão do filho, quando criada. */
	sessionFile?: string;
	step?: number;
	/** Launch snapshot that rebuilds this child's argv on `continue`. */
	invocation?: ChildInvocation;
	/** Error reported by the provider or the agy CLI (never model prose); input of `failure`. */
	providerError?: string;
	/** Failure class of this run: "quota" = quota, rate limit or capacity. */
	failure?: FailureClass;
}

export type FailureClass = "quota";

/**
 * Provider/runner errors that mean "try later or on another model": HTTP 429/529,
 * rate limits, quota and usage limits (e.g. "Codex error: The usage limit has been
 * reached"), overloaded/capacity, Gemini RESOURCE_EXHAUSTED.
 */
const QUOTA_ERROR = /\b(?:429|529)\b|rate[ _-]?limit|too many requests|quota|usage limit|overloaded|capacity|RESOURCE_EXHAUSTED/i;

/** Classify a provider/runner error text. Model prose never reaches this. */
export function classifyProviderError(text: string | undefined): FailureClass | undefined {
	return text && QUOTA_ERROR.test(text) ? "quota" : undefined;
}

/** A failed, non-aborted run whose provider error is a quota/rate/capacity error. */
export function failureOf(result: SingleResult): FailureClass | undefined {
	if (!isFailedResult(result) || result.stopReason === "aborted") return undefined;
	return classifyProviderError(result.providerError);
}

export interface JobSummary {
	jobId: string;
	/** `running`, `completed`… ou `resumed (n)` para um job retomado após uma queda. */
	status: string;
	/** Retomadas já gastas pelo job. */
	resumes?: number;
	mode: "single" | "parallel" | "chain";
	agents: string[];
	/** Effective authorized selections, aligned with tasks/agents. */
	models?: Array<{ model?: string; thinking?: string }>;
	createdAt: number;
	finishedAt?: number;
	resultPath?: string;
	resultBytes?: number;
	note?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "control";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	job?: JobSummary;
	jobs?: JobSummary[];
}

export interface DispatchDefaults {
	parentSession?: string;
	writerCheckpoint?: WriterCheckpoint;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Resource choices snapshotted at launch. */
	resources?: {
		supportModel?: string;
		/** Slot por papel decidido pela receita do projeto e pelo despachante: apoio | principal. */
		slots?: Record<string, "apoio" | "principal">;
	};
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Last text part of one assistant message, if any. */
function assistantText(msg: Message): string | undefined {
	if (msg.role !== "assistant") return undefined;
	for (let i = msg.content.length - 1; i >= 0; i--) {
		const part = msg.content[i];
		if (part.type === "text") return part.text;
	}
	return undefined;
}

/**
 * Bounded slot pool shared by every job of a manager: at most `limit` children
 * exist at any time, no matter how many jobs are active. An abort while waiting
 * never spawns.
 */
export class ChildSlots {
	private inUse = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly limit: number) {}

	get active(): number {
		return this.inUse;
	}

	async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
		if (signal?.aborted) return null;
		if (this.inUse < this.limit) {
			this.inUse++;
			return this.release();
		}
		const granted = await new Promise<boolean>((resolve) => {
			const onAbort = () => {
				const idx = this.waiters.indexOf(wake);
				if (idx >= 0) this.waiters.splice(idx, 1);
				resolve(false);
			};
			const wake = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve(true);
			};
			this.waiters.push(wake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		if (!granted) return null;
		if (signal?.aborted) {
			this.release()();
			return null;
		}
		return this.release();
	}

	private release(): () => void {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.inUse--;
			this.wakeNext();
		};
	}

	private wakeNext() {
		const next = this.waiters.shift();
		if (!next) return;
		this.inUse++;
		next();
	}
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		const error = result.errorMessage || result.stderr;
		return error && result.finalText && error !== result.finalText
			? `${error}\n\n[partial output]\n${result.finalText}`
			: error || result.finalText || "(no output)";
	}
	return result.finalText || "(no output)";
}

/** Preview only (UI/notification). Stored results are never passed through this. */
export function previewOutput(output: string, cap = PREVIEW_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;

	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Preview truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in the job result file.]`;
}

export function prettyModelLabel(model: string | undefined, tier: string | undefined): string | undefined {
	if (tier) return tier;
	if (!model) return undefined;
	const provider = model.includes("/") ? model.split("/", 1)[0] : model;
	const labels: Record<string, string> = {
		anthropic: "Claude",
		"openai-codex": "Codex",
		openai: "OpenAI",
		google: "Gemini",
		"google-gemini-cli": "Gemini",
		"google-antigravity": "Gemini",
	};
	return labels[provider] ?? provider;
}

const FIRST_TOKEN_EVENTS = new Set([
	"text_start", "text_delta", "thinking_start", "thinking_delta", "toolcall_start", "toolcall_delta",
]);

const CACHE_KEEPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cache-keeper.ts");
/** Extensão que registra web_search/web_fetch; o filho roda --no-extensions. */
const WEB_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "web", "index.ts");
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
/** Extensão que registra skim; só entra no filho cujo papel declara a tool. */
const SKIM_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "skim", "index.ts");
/** Extensão que registra checks; só entra no filho cujo papel declara a tool. */
const CHECKS_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "checks", "index.ts");
/** Child-only cap for large tool outputs (AGENT_CHILD_TOOL_OUTPUT_MAX). */
const CHILD_OUTPUT_CAP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-output-cap.ts");
/** Child-only: Anthropic system cache breakpoint before the trailing <cwd> section. */
const CHILD_CACHE_PREFIX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-cache-prefix.ts");
/** Child-only: one steer message at AGENT_CHILD_SOFT_DEADLINE_MS (soft timeout). */
const CHILD_SOFT_DEADLINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-soft-deadline.ts");

/**
 * AGENTS.md/CLAUDE.md the child's Pi would load for `cwd` (same discovery: global agent dir
 * plus ancestors, worktree shadowing), rendered for the task message. Children run with
 * `--no-context-files`, so these files reach them exactly once, outside the system prompt:
 * the system then holds only role + skills + cwd and stays identical across worktrees.
 */
export function contextFilesMessage(cwd: string, agentDir = getAgentDir()): string {
	const files = selectProjectContext(loadProjectContextFiles({ cwd, agentDir }), cwd, agentDir);
	if (!files.length) return "";
	return [
		"## Project instructions",
		"Project-specific instructions and guidelines:",
		...files.map(({ path: file, content }) => `<project_instructions path="${file}">\n${content}\n</project_instructions>`),
	].join("\n\n");
}

export type SandboxMode = "seatbelt" | "bwrap" | "none";
let probedSandbox: SandboxMode | undefined;

/** Sonda local, uma vez por processo; indisponibilidade nunca impede o despacho. */
export function sandboxForTools(tools?: string[]): SandboxMode | undefined {
	if (!tools?.length || tools.includes("edit") || tools.includes("write")) return undefined;
	// Escape exclusivo dos checks offline para provar o detector no modo degradado.
	if (process.env.PI_OFFLINE === "1" && process.env.AGENT_TEST_SANDBOX_NONE === "1") return "none";
	if (probedSandbox !== undefined) return probedSandbox;
	probedSandbox = "none";
	try {
		if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) probedSandbox = "seatbelt";
		else if (process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { timeout: 5000, stdio: "ignore" }).status === 0) probedSandbox = "bwrap";
	} catch { /* plataforma sem sandbox: detector continua ativo */ }
	return probedSandbox;
}

/** Estado e conteúdo dos caminhos sujos, inclusive renomes e arquivos não rastreados. */
function checkoutSnapshot(cwd: string): Map<string, string> | undefined {
	const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 });
	const root = git(["rev-parse", "--show-toplevel"]);
	if (root.status !== 0) return undefined;
	const status = git(["-C", root.stdout.trim(), "status", "--porcelain", "-z", "--untracked-files=all"]);
	if (status.status !== 0) throw new Error("read-only checkout detector: git status failed");
	const snapshot = new Map<string, string>();
	const entries = status.stdout.split("\0");
	const record = (name: string, state: string) => {
		const file = path.join(root.stdout.trim(), name);
		let content: string;
		try {
			const stat = fs.lstatSync(file);
			content = `${stat.mode}:` + (stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "directory");
		} catch (error: any) {
			if (error.code !== "ENOENT") throw error;
			content = "missing";
		}
		snapshot.set(name, `${state}:${content}`);
	};
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const state = entry.slice(0, 2);
		record(entry.slice(3), state);
		if (/[RC]/.test(state) && entries[i + 1]) record(entries[++i], state);
	}
	return snapshot;
}

/** Saídas do filho de aquecimento (contrato do cache-keeper). */
export const PREFETCH_EXIT = { warmed: 0, unsupported: 3, timeout: 4, providerError: 5 } as const;

/**
 * Aquece o cache do prefixo (system+tools) de um papel: mesmo argv do filho real
 * (agente/modelo/thinking/tools/skills), tarefa ".", `--no-session`, sem UI.
 * Nunca lança; devolve o exit code (0 aquecido, 3 sem suporte, 4 timeout, 5 erro, outro = falha).
 */
export async function prefetchAgent(
	opts: Omit<RunAgentOptions, "task" | "onUpdate" | "makeDetails" | "onFirstToken" | "onProcessStarted" | "prefetch">,
): Promise<number> {
	if (!fs.existsSync(CACHE_KEEPER_PATH)) return PREFETCH_EXIT.unsupported; // sem o keeper o filho faria o trabalho de verdade
	if (opts.signal?.aborted) return 143;
	try {
		const r = await runSingleAgent({ ...opts, task: ".", prefetch: true, makeDetails: () => ({}) as SubagentDetails });
		return r.exitCode;
	} catch {
		return -1;
	}
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	shouldStop?: () => boolean,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			// After an abort no further task may be started: a shutdown must not
			// leave a queued task spawning a child in the next session.
			if (shouldStop?.()) return;
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
	reuseDir?: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = reuseDir ?? (await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-")));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function realpathOrNull(file: string): string | null {
	try {
		return fs.realpathSync(file);
	} catch {
		return null;
	}
}

/** CLI entries declared by a Pi package dir (`bin.pi` and the classic `dist/cli.js`), as real paths. */
function piCliEntries(packageDir: string): string[] {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
		if (pkg?.name !== PI_PACKAGE_NAME) return [];
		const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
		const entries = [bin, "dist/cli.js"].filter((e): e is string => typeof e === "string" && e.length > 0);
		return entries.map((e) => realpathOrNull(path.join(packageDir, e))).filter((e): e is string => !!e);
	} catch {
		return [];
	}
}

/** Pi package loaded in this process (public SDK API); null when unavailable. */
function loadedPiPackageDir(): string | null {
	try {
		return getPackageDir();
	} catch {
		return null;
	}
}

/**
 * True only for a real Pi CLI entry: the file must be a declared CLI of the
 * loaded Pi package or of the Pi package that contains it. A host script that
 * embeds the SDK (e.g. an SDK consumer's script in argv[1]) is never accepted.
 */
function isPiCliScript(script: string): boolean {
	const real = realpathOrNull(script);
	if (!real) return false;
	const dirs = new Set<string>();
	const loaded = loadedPiPackageDir();
	if (loaded) dirs.add(loaded);
	for (let dir = path.dirname(real); dir !== path.dirname(dir); dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			dirs.add(dir);
			break;
		}
	}
	for (const dir of dirs) if (piCliEntries(dir).includes(real)) return true;
	return false;
}

/** CLI of the Pi package loaded in this process, for hosts whose argv[1] is not Pi. */
function loadedPiCli(): string | null {
	const dir = loadedPiPackageDir();
	return dir ? (piCliEntries(dir)[0] ?? null) : null;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	// Homebrew may remove the versioned executable while this session stays alive.
	const executableExists = fs.existsSync(process.execPath);
	const command = executableExists ? process.execPath : isGenericRuntime ? execName : "pi";
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && (executableExists || isGenericRuntime)) {
		if (isPiCliScript(currentScript)) return { command, args: [currentScript, ...args] };
		// SDK host: argv[1] is the host's script, not Pi. Run the loaded Pi package's CLI.
		if (isGenericRuntime) {
			const cli = loadedPiCli();
			if (cli) return { command, args: [cli, ...args] };
		}
	}

	if (!isGenericRuntime) {
		return { command, args };
	}

	return { command: "pi", args };
}

/**
 * Test seams. `getPiInvocation` resolves `process.argv[1]`, which under a test
 * runner is the test file itself; tests replace `spawn` (and may replace the
 * invocation) instead of spawning a recursive worker.
 */
export const runnerHooks = {
	spawn: nodeSpawn as typeof nodeSpawn,
	getPiInvocation,
	killGraceMs: 5000,
	/** Leitura de memória livre do host; testes fixam em 100. */
	hostFreePercent: readHostFreePercent,
	listDescendants,
	signalProcesses,
	isProcessAlive,
	/** Bound for the wait on a killed child's process tree. */
	treeExitWaitMs: 5000,
};

/** Poll until every pid is gone (or `boundMs` passes). Returns the pids still alive. */
async function waitForExit(pids: number[], boundMs: number): Promise<number[]> {
	const deadline = Date.now() + boundMs;
	let alive = pids.filter((pid) => runnerHooks.isProcessAlive(pid));
	while (alive.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		alive = alive.filter((pid) => runnerHooks.isProcessAlive(pid));
	}
	return alive;
}

export interface RunAgentOptions {
	defaultCwd: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	/** Checkout de origem para regras e prefixo compartilhado. */
	sourceCwd?: string;
	/** Already-authorized central role choice. Takes precedence over legacy frontmatter/defaults. */
	roleModel?: { model: string; thinking: string };
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	onProcessStarted?: (agentName: string) => () => void;
	/** Shared child-process slot pool; resolves null when aborted before a slot frees. */
	acquireSlot?: (signal?: AbortSignal) => Promise<(() => void) | null>;
	/** Arquivo da sessão pai, no formato oficial do Pi. */
	parentSession?: string;
	/** Chamado uma vez no 1º token efetivo do filho (delta de texto/thinking/toolcall). */
	onFirstToken?: () => void;
	/** Interno: filho de aquecimento (use prefetchAgent). */
	prefetch?: boolean;
	/** Called once with the live result (session file, model, thinking) before the child is spawned. */
	onStart?: (result: SingleResult) => void;
	/** `continue`: rebuild the argv from the launch snapshot over the same session; `task` is the raw message. */
	resume?: { invocation: ChildInvocation; sessionFile: string };
	/** Absolute epoch ms for the soft-timeout steer (AGENT_CHILD_SOFT_DEADLINE_MS). */
	softDeadlineMs?: number;
}

interface ChildRunOptions {
	stdin?: string;
	writerCheckpoint?: WriterCheckpoint;
	runner?: AgentConfig["runner"];
	args: string[];
	cwd: string;
	agentName: string;
	signal?: AbortSignal;
	/** Mutado no lugar: o chamador é dono do resultado. */
	result: SingleResult;
	emitUpdate: () => void;
	onProcessStarted?: (agentName: string) => () => void;
	acquireSlot?: (signal?: AbortSignal) => Promise<(() => void) | null>;
	onFirstToken?: () => void;
	/** Variáveis extras só deste filho. */
	extraEnv?: Record<string, string>;
	/** Aquecimento: 1 request, nenhuma tool; o runner mata se o filho passar disso. */
	prefetch?: boolean;
}

/** Decode the final Antigravity envelope; stdout is not a Pi event stream. */
function settleAgyResult(result: SingleResult, stdout: string, exitCode: number): void {
	let envelope: { status?: string; response?: string; error?: string | { message?: string }; num_turns?: number;
		denied_actions?: { action?: string; display_name?: string }[];
		usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } } | undefined;
	try { envelope = JSON.parse(stdout); } catch { /* exit 1 can also write plain diagnostics */ }
	const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
	result.usage.input = count(envelope?.usage?.input_tokens);
	result.usage.output = count(envelope?.usage?.output_tokens);
	result.usage.cacheRead = count(envelope?.usage?.cache_read_tokens);
	result.usage.turns = count(envelope?.num_turns);
	const response = typeof envelope?.response === "string" ? envelope.response : "";
	if (exitCode === 0 && envelope?.status === "SUCCESS" && typeof envelope.response === "string" && response.trim()) {
		result.finalText = response;
		return;
	}
	// SUCCESS with an empty response: headless agy auto-denied a tool and produced nothing.
	const denied = (envelope?.denied_actions ?? []).map((d) => d?.display_name || d?.action).filter(Boolean);
	const diagnostics = result.stderr.split("\n").filter((line) => line.trim() && !line.startsWith("warning:")).join("\n").trim();
	if (exitCode === 0 && envelope?.status === "SUCCESS") {
		result.finalText = result.errorMessage = diagnostics ||
			(denied.length ? `agy produced no output; denied tools: ${denied.join(", ")}` : "agy returned an empty response");
		result.stopReason = "error";
		result.exitCode = 1;
		return;
	}
	const error = typeof envelope?.error === "string" ? envelope.error : envelope?.error?.message;
	// The CLI's error or diagnostics classify the failure; the model's `response` never does.
	result.providerError = [typeof error === "string" ? error : "", diagnostics].filter(Boolean).join("\n") || undefined;
	const message = (typeof error === "string" && error.trim()) || result.stderr.trim() ||
		(exitCode !== 0 && (response || (!envelope && stdout.trim().slice(0, 500)))) ||
		(typeof envelope?.status === "string" && envelope.status !== "SUCCESS" ? `agy returned ${envelope.status}` :
			exitCode !== 0 ? `agy exited with code ${exitCode}` : "agy did not return a valid JSON result");
	result.finalText = result.errorMessage = message;
	result.stopReason = "error";
	result.exitCode = exitCode || 1;
}

/** Run one child with the shared slot, memory, cancellation and output limits. */
async function runChild(opts: ChildRunOptions): Promise<void> {
	const { result, signal } = opts;
	const agy = opts.runner === "agy";
	let processFinished: (() => void) | undefined;
	let releaseSlot: (() => void) | null | undefined;
	let finishCheckpoint: (() => Promise<void>) | undefined;
	let checkpointNote: string | undefined;
	const checkpointSkipped = (phase: string, error: unknown) => {
		const reason = error instanceof Error ? error.message : String(error);
		checkpointNote = `Checkpoint skipped (${phase}: ${reason}). /rewind will not cover this dispatch.`;
	};
	try {
		// Slot first: the global ceiling must bound spawned processes, not queued work.
		if (opts.acquireSlot) {
			releaseSlot = await opts.acquireSlot(signal);
			if (releaseSlot === null) {
				result.exitCode = 143;
				result.stopReason = "aborted";
				result.errorMessage = "Subagent aborted before start";
				return;
			}
		}
		// Host sem memória segura o spawn em vez de empurrar o Mac para o swap.
		// Abortado enquanto esperava slot/memória: não nasce.
		if (signal?.aborted || !(await waitForHostMemory({ signal, hostFreePercent: runnerHooks.hostFreePercent })) || signal?.aborted) {
			result.exitCode = 143;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent aborted before start";
			return;
		}

		let wasAborted = false;
		let spawnError: string | undefined;
		let outputOverflow: string | undefined;
		let authRequired = false;
		let agyOutput = "";
		/** Descendants SIGKILLed after an abort: waited on before the run returns. */
		const killedTree = new Set<number>();

		const invocation = agy ? { command: "agy", args: opts.args } : runnerHooks.getPiInvocation(opts.args);
		if (opts.writerCheckpoint) {
			try {
				finishCheckpoint = await captureWriter(opts.cwd, opts.writerCheckpoint, signal);
			} catch (error) {
				checkpointSkipped("pre-scan", error);
			}
			if (signal?.aborted) {
				result.exitCode = 143;
				result.stopReason = "aborted";
				result.errorMessage = "Subagent aborted before start";
				return;
			}
		}
		const exitCode = await new Promise<number>((resolve) => {
			const proc = runnerHooks.spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
				env: agy ? userCommandEnv({ ...process.env, [NO_DELEGATE_ENV]: "1" })
					: subagentEnv({ ...process.env, ...opts.extraEnv }),
			});
			let buffer = "";
			let stdoutBytes = 0;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// 1º token efetivo: o provider já processou (e escreveu no cache) o prefixo.
				// Não é o evento `start` (cabeçalho chega antes do conteúdo).
				if (
					opts.onFirstToken &&
					event.type === "message_update" &&
					FIRST_TOKEN_EVENTS.has(event.assistantMessageEvent?.type)
				) {
					const fire = opts.onFirstToken;
					opts.onFirstToken = undefined;
					try { fire(); } catch { /* listener must not break the stream */ }
				}

				// Rede de segurança do aquecimento: tool nunca roda; após a 1ª resposta, morre.
				if (opts.prefetch && event.type === "tool_execution_start") {
					result.errorMessage = "prefetch: tool bloqueada";
					killProc();
					return;
				}
				if (opts.prefetch && event.type === "message_end" && event.message?.role === "assistant") {
					// O keeper sai sozinho com o código do contrato; se não sair, morre.
					setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) killProc(); }, 3000).unref?.();
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					const text = assistantText(msg);
					// Only the latest assistant text survives: no transcript in memory.
					if (text !== undefined) result.finalText = text;

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
						// The provider's error for this turn, kept apart from the runner's own messages.
						result.providerError = msg.stopReason === "error" ? msg.errorMessage : undefined;
					} else if (msg.role === "toolResult" && (msg as any).usage) {
						// Tool-side inference on another model (skim, web_fetch prompt): cost only;
						// tokens stay the child model's so context and cache-hit figures keep meaning.
						result.usage.cost += (msg as any).usage.cost?.total || 0;
					}
					opts.emitUpdate();
				}

				// tool_result_end payloads are deliberately dropped: the UI never shows them.
			};

			// Descendentes vistos enquanto o filho ainda vivia: depois do SIGKILL eles
			// viram órfãos do launchd e não há mais como achá-los pela árvore.
			const descendants = new Set<number>();
			const snapshotDescendants = () => {
				if (!proc.pid) return;
				for (const pid of runnerHooks.listDescendants(proc.pid)) descendants.add(pid);
			};
			const killDescendants = () => {
				if (descendants.size === 0) return;
				// Processes forked since the snapshot by a still-living descendant (a shell loop).
				for (const pid of [...descendants]) for (const child of runnerHooks.listDescendants(pid)) descendants.add(child);
				runnerHooks.signalProcesses(descendants, "SIGKILL");
				for (const pid of descendants) killedTree.add(pid);
				descendants.clear();
			};

			const killProc = () => {
				if (wasAborted) return;
				wasAborted = true;
				snapshotDescendants();
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					// `proc.killed` only says a signal was delivered; a child that
					// ignores SIGTERM is still alive. Exit state is the real check.
					if (proc.exitCode === null && proc.signalCode === null) {
						snapshotDescendants();
						proc.kill("SIGKILL");
					}
					killDescendants();
				}, runnerHooks.killGraceMs);
				killTimer.unref?.();
			};

			const cleanup = () => {
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", killProc);
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(code);
			};

			const overflow = (why: string) => {
				if (outputOverflow) return;
				outputOverflow = why;
				buffer = "";
				// Explicit failure beats silent truncation of a result.
				result.errorMessage ||= why;
				killProc();
			};

			if (agy) proc.stdout?.setEncoding("utf8");
			proc.stdout?.on("data", (data: Buffer | string) => {
				if (outputOverflow) return;
				const chunk = typeof data === "string" ? data : data.toString();
				if (agy) {
					stdoutBytes += Buffer.byteLength(chunk, "utf-8");
					if (stdoutBytes > MAX_STDOUT_LINE_BYTES) {
						overflow(`Subagent output limit exceeded (agy JSON > ${MAX_STDOUT_LINE_BYTES} bytes).`);
					} else agyOutput += chunk;
					return;
				}
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				if (Buffer.byteLength(buffer, "utf-8") > MAX_STDOUT_LINE_BYTES) {
					overflow(`Subagent output limit exceeded (JSONL line > ${MAX_STDOUT_LINE_BYTES} bytes).`);
					return;
				}
				for (const line of lines) {
					const lineBytes = Buffer.byteLength(line, "utf-8");
					if (lineBytes > MAX_STDOUT_LINE_BYTES) {
						overflow(`Subagent output limit exceeded (JSONL line > ${MAX_STDOUT_LINE_BYTES} bytes).`);
						return;
					}
					// Prévias de streaming não entram no orçamento: o runner as descarta e
					// `message_update` de tool call traz os argumentos acumulados a cada
					// evento (cresce ao quadrado com o tamanho de um `write`). O teto por
					// linha continua valendo para elas.
					if (!isStreamingPreviewLine(line)) {
						stdoutBytes += lineBytes;
						if (stdoutBytes > MAX_STDOUT_TOTAL_BYTES) {
							overflow(`Subagent output limit exceeded (> ${MAX_STDOUT_TOTAL_BYTES} bytes of stdout).`);
							return;
						}
					}
					processLine(line);
				}
			});

			proc.stderr?.on("data", (data: Buffer | string) => {
				if (authRequired || Buffer.byteLength(result.stderr, "utf-8") >= MAX_STDERR_BYTES) return;
				result.stderr += data.toString();
				// agy prompts for interactive login even with stdin closed. Fail the job
				// promptly and do not persist the authorization URL as a diagnostic.
				if (agy && result.stderr.includes("Authentication required. Please visit the URL to log in:")) {
					authRequired = true;
					result.stderr = "Antigravity CLI authentication required. Run agy interactively to log in, then retry.";
					killProc();
					return;
				}
				if (Buffer.byteLength(result.stderr, "utf-8") > MAX_STDERR_BYTES) {
					result.stderr = `${result.stderr.slice(0, MAX_STDERR_BYTES)}\n[stderr truncated]`;
				}
			});


			proc.on("close", (code: number | null, closeSignal?: NodeJS.Signals | null) => {
				if (buffer.trim()) processLine(buffer);
				// O `pi` mata os filhos que rastreia no SIGTERM; o que sobrou é órfão nosso.
				if (wasAborted) killDescendants();
				// A signal kill reports code === null: never let that read as success.
				finish(code ?? (closeSignal || wasAborted ? 143 : 1));
			});

			proc.on("error", (err: Error) => {
				spawnError = err?.message || "spawn failed";
				result.stderr += `${spawnError}\n`;
				finish(1);
			});

			if (opts.stdin !== undefined && proc.stdin) {
				// O CLI pode fechar o pipe cedo (por exemplo, quando falha a autenticação).
				proc.stdin.on("error", () => {});
				proc.stdin.end(opts.stdin, "utf8");
			}

			// Handlers existem ANTES dos callbacks: uma falha de tracking não abandona
			// o processo nem libera o slot antes de observar sua saída.
			try { processFinished = opts.onProcessStarted?.(opts.agentName); }
			catch (error) { spawnError ||= `Subagent tracking failed: ${String(error)}`; }
			if (spawnError) killProc();

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
			// Aquecimento nunca passa do teto (o keeper já sai em 60 s).
			if (opts.prefetch) setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) killProc(); }, 75_000).unref?.();
		});

		result.exitCode = exitCode;
		// A killed child returns only after its whole tree is gone: the caller may touch
		// the worktree next (timeout WIP commit), and nothing may still be writing there.
		if (killedTree.size > 0) await waitForExit([...killedTree], runnerHooks.treeExitWaitMs);
		if (spawnError) {
			result.errorMessage ||= spawnError;
			result.stopReason = "error";
			if (result.exitCode === 0) result.exitCode = 1;
		}
		if (outputOverflow) {
			result.stopReason = "error";
			result.errorMessage ||= outputOverflow;
			if (result.exitCode === 0) result.exitCode = 1;
			return;
		}
		if (authRequired && !signal?.aborted) {
			result.exitCode = 1;
			result.stopReason = "error";
			result.finalText = result.errorMessage = result.stderr;
			return;
		}
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage ||= "Subagent aborted";
			if (result.exitCode === 0) result.exitCode = 143;
		} else if (agy && !spawnError) {
			settleAgyResult(result, agyOutput, exitCode);
			opts.emitUpdate();
		}
		result.failure = failureOf(result);

	} finally {
		try {
			try {
				if (finishCheckpoint) await finishCheckpoint();
			} catch (error) {
				checkpointSkipped("post-scan", error);
			}
			if (checkpointNote) result.finalText = [checkpointNote, result.finalText].filter(Boolean).join("\n\n");
			processFinished?.();
		}
		finally { releaseSlot?.(); }
	}
}

function agyEffort(thinking?: string): string | undefined {
	if (thinking === "minimal" || thinking === "off") return "low";
	return thinking && ["low", "medium", "high", "xhigh", "max"].includes(thinking) ? thinking : undefined;
}

function writerCheckpointFor(agent: AgentConfig, opts: RunAgentOptions): WriterCheckpoint | undefined {
	// sourceCwd só é definido para tarefas transferidas para um worktree isolado.
	if (opts.prefetch || opts.sourceCwd !== undefined) return;
	const writes = agent.tools?.length
		? agent.tools.some((tool) => tool === "edit" || tool === "write") : agent.runner !== "agy";
	return writes ? opts.dispatchDefaults.writerCheckpoint : undefined;
}

async function runAgyAgent(agent: AgentConfig, opts: RunAgentOptions): Promise<SingleResult> {
	const { task, step, signal } = opts;
	const cwd = opts.cwd ?? opts.defaultCwd;
	const readOnly = !agent.tools?.some((tool) => tool === "edit" || tool === "write");
	const model = opts.roleModel?.model ?? (agent.model?.trim() || undefined);
	const effort = agyEffort(opts.roleModel?.thinking ?? agent.thinking ?? opts.dispatchDefaults.thinkingLevel);
	const result: SingleResult = {
		agent: agent.name, agentSource: agent.source, task, step, exitCode: -1,
		finalText: "", stderr: "", usage: emptyUsage(), model, modelLabel: model ?? "Gemini", thinking: effort,
	};
	if (opts.prefetch) return { ...result, exitCode: PREFETCH_EXIT.unsupported };
	if (model && !/^[a-z0-9][a-z0-9._-]*$/i.test(model)) {
		const error = "agy model must be a native ID from agy models, without a Pi provider prefix or tier.";
		return { ...result, model: undefined, exitCode: 1, stopReason: "error", finalText: error, errorMessage: error };
	}
	const instructions = contextFilesMessage(cwd);
	const sourceCwd = opts.sourceCwd ?? cwd;
	const guidance = path.resolve(sourceCwd) === path.resolve(cwd) && hasRules(cwd)
		&& instructions.includes(`path="${path.join(cwd, ".agent", "rules.md")}"`) ? "" : projectRules(sourceCwd);
	// Headless read-only agy auto-denies every shell command; say so, or the model ends with no answer.
	const readOnlyNote = readOnly ? "Read-only run: shell commands are denied here. Use only your file reading tools, and state what you could not verify." : "";
	const prompt = [agent.systemPrompt.trim(), readOnlyNote, `Task: ${task}`, instructions, guidance].filter(Boolean).join("\n\n");
	// Writers run with full permissions; --sandbox stays as an extra layer (it blocks writes to <cwd>/.git
	// but leaves shell, network and isolated-worktree commits working).
	// Sem -p, o agy usa o texto de stdin como prompt e mantém o envelope JSON.
	const largePrompt = Buffer.byteLength(prompt, "utf8") > ARG_INLINE_CAP;
	const args = [...(largePrompt ? [] : ["-p", prompt]), "--output-format", "json", "--disable-slash-commands",
		...(readOnly ? ["--mode", "plan"] : ["--mode", "auto", "--dangerously-skip-permissions"]), "--sandbox"];
	if (model) args.push("--model", model);
	if (effort) args.push("--effort", effort);
	result.invocation = {
		version: 1, runner: "agy", agent: agent.name, agentSource: agent.source, roleFile: agent.filePath || undefined,
		roleSha: fileSha(agent.filePath), model, thinking: effort, tools: agent.tools, extensions: [],
		systemPrompt: agent.systemPrompt, cwd, sourceCwd: opts.sourceCwd, writes: !readOnly,
	};
	try { opts.onStart?.(result); } catch { /* audit bookkeeping must not break the run */ }
	const before = readOnly ? checkoutSnapshot(cwd) : undefined;
	await runChild({
		runner: "agy", args, cwd, signal, result, agentName: agent.name,
		stdin: largePrompt ? prompt : undefined, writerCheckpoint: writerCheckpointFor(agent, opts),
		onProcessStarted: opts.onProcessStarted, acquireSlot: opts.acquireSlot,
		emitUpdate: () => opts.onUpdate?.({
			content: [{ type: "text", text: previewOutput(result.finalText) || "(running...)" }],
			details: opts.makeDetails([result]),
		}),
	});
	verifyCheckout(before, cwd, result);
	return result;
}

function verifyCheckout(before: Map<string, string> | undefined, cwd: string, result: SingleResult): void {
	if (!before) return;
	const after = checkoutSnapshot(cwd);
	const changed = after ? [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).sort() : ["(git checkout unavailable)"];
	if (changed.length) {
		result.stopReason = "error";
		result.errorMessage = `read-only role modified the checkout: ${changed.join(", ")}`;
		result.exitCode = 1;
	}
}

/**
 * Launch snapshot of a Pi child: model, thinking, tools, sandbox, extensions, system
 * prompt text and effective cwd. `continue` rebuilds the argv from it, so a role or
 * environment change after the launch cannot alter the cached prefix.
 */
function launchInvocation(agent: AgentConfig, opts: RunAgentOptions): ChildInvocation {
	const cwd = opts.cwd ?? opts.defaultCwd;
	const sandbox = sandboxForTools(agent.tools);
	const extensions: string[] = [];
	if (sandbox && sandbox !== "none") extensions.push(path.join(path.dirname(CACHE_KEEPER_PATH), "bash-sandbox.ts"));
	// Every child keeps cache keys, limits and the skill catalog, without warming timers.
	if (fs.existsSync(CACHE_KEEPER_PATH)) extensions.push(CACHE_KEEPER_PATH);
	if (fs.existsSync(CHILD_OUTPUT_CAP_PATH)) extensions.push(CHILD_OUTPUT_CAP_PATH);
	if (fs.existsSync(CHILD_CACHE_PREFIX_PATH)) extensions.push(CHILD_CACHE_PREFIX_PATH);
	if (fs.existsSync(CHILD_SOFT_DEADLINE_PATH)) extensions.push(CHILD_SOFT_DEADLINE_PATH);
	// Explicit child extensions can provide an offline
	// provider in checks. Never inherit the parent's whole profile.
	for (const ext of (process.env.AGENT_SUBAGENT_CHILD_EXTENSIONS ?? "").split(":").filter(Boolean)) extensions.push(ext);
	// Papel que declara web_search/web_fetch precisa da extensão que os registra;
	// sem ela o --tools filtra para nada e o filho fica sem web.
	if (agent.tools?.some((t) => WEB_TOOLS.has(t)) && fs.existsSync(WEB_EXTENSION_PATH)) extensions.push(WEB_EXTENSION_PATH);
	if (agent.tools?.includes("skim") && fs.existsSync(SKIM_EXTENSION_PATH)) extensions.push(SKIM_EXTENSION_PATH);
	if (agent.tools?.includes("checks") && fs.existsSync(CHECKS_EXTENSION_PATH)) extensions.push(CHECKS_EXTENSION_PATH);
	const inheritsDispatchConfig = !agent.model;
	// Central role config wins for native roles. Without it, preserve legacy
	// project/user frontmatter (`model`, `tier:*`, `thinking`) and parent defaults.
	const resolved = !opts.roleModel && agent.model ? resolveModelRef(agent.model) : undefined;
	const model = opts.roleModel?.model ?? resolved?.model ?? opts.dispatchDefaults.model;
	const thinking = (opts.roleModel?.thinking ?? agent.thinking ?? resolved?.thinking)
		|| (inheritsDispatchConfig ? opts.dispatchDefaults.thinkingLevel : undefined) || undefined;
	return {
		version: 1,
		runner: "pi",
		agent: agent.name,
		agentSource: agent.source,
		roleFile: agent.filePath || undefined,
		roleSha: fileSha(agent.filePath),
		model,
		modelLabel: prettyModelLabel(model, resolved?.tier),
		thinking,
		tools: agent.tools && agent.tools.length > 0 ? [...agent.tools] : undefined,
		sandbox,
		extensions,
		systemPrompt: agent.systemPrompt,
		cwd,
		sourceCwd: opts.sourceCwd,
		writes: agent.tools?.length ? agent.tools.some((tool) => tool === "edit" || tool === "write") : true,
	};
}

/** Role as it was at launch: a continue never depends on the current role file. */
function agentFromInvocation(invocation: ChildInvocation): AgentConfig {
	return {
		name: invocation.agent,
		description: "",
		tools: invocation.tools,
		systemPrompt: invocation.systemPrompt,
		source: invocation.agentSource,
		filePath: invocation.roleFile ?? "",
	};
}

export async function runSingleAgent(opts: RunAgentOptions): Promise<SingleResult> {
	const { agents, agentName, task, step, signal, onUpdate, makeDetails } = opts;
	if (opts.resume && opts.resume.invocation.runner !== "pi") throw new Error(`Agent ${agentName} ran on agy; it has no Pi session to continue.`);
	const agent = opts.resume ? agentFromInvocation(opts.resume.invocation) : agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			finalText: "",
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			errorMessage: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			step,
		};
	}

	if (agent.runner === "agy") return runAgyAgent(agent, opts);

	// Garime: filho enxuto. Sem extensões (presence, relay, vault, kernel…) nem skills;
	// AGENTS.md/CLAUDE.md continuam valendo, na mensagem da tarefa (contextFilesMessage),
	// não no system. Só as tools do frontmatter.
	// `continue` reusa o snapshot do launch: mesmo argv, mesmo --session, só a mensagem muda.
	const resume = opts.prefetch ? undefined : opts.resume;
	const invocation = resume?.invocation ?? launchInvocation(agent, opts);
	const args: string[] = ["--mode", "json", "-p", "--no-extensions", "--no-context-files"];
	const cwd = invocation.cwd;
	const sandbox = invocation.sandbox;
	// AGENT_CHECKS_READONLY marca o papel sem edit/write mesmo sem sandbox disponível:
	// ali checks só lê (list/last); executar o manifesto escaparia do sandbox.
	const extraEnv: Record<string, string> = { AGENT_BASH_SANDBOX: "", AGENT_SANDBOX_CWD: "", AGENT_CHECKS_READONLY: sandbox ? "1" : "",
		AGENT_CHILD_SOFT_DEADLINE_MS: !opts.prefetch && opts.softDeadlineMs ? String(Math.floor(opts.softDeadlineMs)) : "" };
	if (sandbox && sandbox !== "none") {
		extraEnv.AGENT_BASH_SANDBOX = sandbox;
		extraEnv.AGENT_SANDBOX_CWD = cwd;
	}
	if (opts.prefetch) Object.assign(extraEnv, { AGENT_CACHE_PREFETCH: "1", AGENT_CHILD: "1" });
	let sessionFile: string | undefined;
	if (opts.prefetch) args.push("--no-session");
	else if (resume) {
		args.push("--session", resume.sessionFile);
		sessionFile = resume.sessionFile;
	} else {
		// Seed the official JSONL header so the CLI opens a child of this parent.
		const session = SessionManager.create(cwd, undefined, { parentSession: opts.parentSession });
		const file = session.getSessionFile()!;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(session.getHeader()) + "\n", { mode: 0o600, flag: "wx" });
		args.push("--session", file);
		sessionFile = file;
	}
	// Aquecimento: o cache-keeper troca o 1º request por max_tokens 1 sem thinking e sai.
	// Não muda system/tools (só before_provider_request), então o prefixo é o do filho real.
	for (const ext of invocation.extensions) args.push("-e", ext);
	const model = invocation.model;
	if (model) args.push("--model", model);
	const thinking = invocation.thinking;
	if (thinking) args.push("--thinking", thinking);
	if (invocation.tools && invocation.tools.length > 0) args.push("--tools", invocation.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		sandbox,
		sessionFile,
		task,
		exitCode: -1,
		finalText: "",
		stderr: "",
		usage: emptyUsage(),
		model,
		modelLabel: invocation.modelLabel,
		thinking,
		step,
		invocation,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: previewOutput(currentResult.finalText) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	if (!opts.prefetch) {
		try { opts.onStart?.(currentResult); } catch { /* audit bookkeeping must not break the run */ }
	}

	let tmpTaskPath: string | null = null;
	try {
		let promptPath: string | undefined;
		if (invocation.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, invocation.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			promptPath = tmp.filePath;
			args.push("--system-prompt", promptPath);
		}

		// Orientação do projeto DESTE filho: as regras aprendidas no `cwd` efetivo
		// dele (projeto B nunca recebe as de A). Só na mensagem do filho — não entra
		// no registro do job, no brief persistido, nem em nada que volte ao pai.
		// Aquecimento (tarefa ".") fica de fora.
		// `continue`: project context and rules are already in the child's history; send only the message.
		const prefetchOrResume = opts.prefetch || resume !== undefined;
		const instructions = prefetchOrResume ? "" : contextFilesMessage(cwd);
		const sourceCwd = invocation.sourceCwd ?? cwd;
		const guidance = prefetchOrResume || (path.resolve(sourceCwd) === path.resolve(cwd) && hasRules(cwd)
			&& instructions.includes(`path="${path.join(cwd, ".agent", "rules.md")}"`)) ? "" : projectRules(sourceCwd);
		// argv is a hard OS limit (E2BIG): a big task goes to a file read by the
		// child as `@path` (pi CLI file argument), never into the command line.
		const sandboxNotice = !resume && sandbox === "none" ? "\n\nSandbox: none on this platform; writes are detected after the run and fail the task." : "";
		const inlineTask = resume ? task : [`Task: ${task}`, instructions, guidance].filter(Boolean).join("\n\n") + sandboxNotice;
		if (Buffer.byteLength(inlineTask, "utf-8") > ARG_INLINE_CAP) {
			let messagePath: string;
			const tmp = await writePromptToTempFile(`${agent.name}-task`, inlineTask, tmpPromptDir ?? undefined);
			tmpPromptDir = tmp.dir;
			tmpTaskPath = tmp.filePath;
			messagePath = tmp.filePath;
			args.push("--", `@${messagePath}`, resume ? "Read the follow-up message in the attached file." : "Execute the task described in the attached file.");
		} else {
			args.push(inlineTask);
		}

		const before = sandbox ? checkoutSnapshot(cwd) : undefined;
		await runChild(
			{
				args,
				cwd,
				agentName,
				signal,
				result: currentResult,
				emitUpdate,
				onProcessStarted: opts.onProcessStarted,
				acquireSlot: opts.acquireSlot,
				onFirstToken: opts.onFirstToken,
				writerCheckpoint: writerCheckpointFor(agent, opts),
				extraEnv,
				...(opts.prefetch ? { prefetch: true } : {}),
			},
		);
		verifyCheckout(before, cwd, currentResult);
		return currentResult;
	} finally {
		if (tmpTaskPath)
			try {
				fs.unlinkSync(tmpTaskPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
