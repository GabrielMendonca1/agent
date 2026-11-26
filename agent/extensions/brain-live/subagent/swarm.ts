/**
 * Swarm loop: one writer and one reviewer take turns on the same checkout until the
 * reviewer approves or a cap stops them. Every swarm run is an ordinary subagent job
 * (two tasks, two handles); rounds 2+ resume both child sessions so their prompt caches
 * stay warm and each turn only carries the delta.
 *
 * The verdict is fail-closed: only an isolated `VERDICT: APPROVE` line approves.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pidAlive, waitLock } from "./lockfile.ts";
import type { SingleResult, UsageStats } from "./runner.ts";

export const SWARM_ENTRY_TYPE = "agent-swarm";
export const SWARM_MESSAGE_TYPE = "agent-swarm-mode";
export const SWARM_STATUS_KEY = "agent-swarm";
export const SWARM_OFF_ERROR = "Swarm is off in this session. Ask the user to enable it with /swarm.";

export const SWARM_MAX_ROUNDS = 5;
export const SWARM_DEFAULT_ROUNDS = 3;
export const SWARM_MIN_USD = 0.1;
export const SWARM_MAX_USD = 50;
export const SWARM_DEFAULT_USD = 5;

/** Hidden session message sent by `/swarm on`: the model learns about the deferred tool here. */
export const SWARM_ON_TEXT = [
	"Swarm mode is active in this session. The `swarm` tool is deferred: load it with tool_search (query \"swarm\").",
	"You have an autonomous mandate to pick the shape of delegated work:",
	"- swarm loop: one writer implements and one reviewer reviews in rounds until approval; use it for implementation that needs an independent review.",
	"- swarm board: 2+ coupled agents working in parallel on one shared objective, coordinating through an append-only board (claims, decisions, blockers, done).",
	"- plain subagent: one-shot recon, reading, a single review, or independent parallel tasks.",
	"You choose the decomposition, the roles, maxRounds and maxUsd. Log each choice in one line (mode, roles, caps, why).",
	"A swarm job is a normal subagent job: read it with subagent status/result/trace/list, stop it with cancel, and close it with integrate/discard or continue a handle.",
	"Red lines:",
	"- Never integrate or merge a swarm result before you review the final diff and verdict yourself.",
	"- No free chat between agents: every turn is a writer change or a reviewer verdict.",
	"- If the user turns swarm off, do not call the swarm tool again.",
	"Use plain subagent or your own tools for anything that does not need a loop.",
].join("\n");

export const VERDICT_CONTRACT = [
	"## Verdict contract",
	"List each finding with path:line and evidence first.",
	"End the reply with one final line, outside any code block, that is exactly `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; nothing may follow it.",
	"Approve only when no blocking finding remains. A reply without that line counts as not approved.",
].join("\n");

/** Loop outcomes, plus "done" for a board whose tasks all finished. */
export type SwarmOutcome = "approved" | "ambiguous" | "stalled" | "max_rounds" | "max_usd" | "quota" | "failed" | "done";
export type SwarmVerdict = "APPROVE" | "REQUEST_CHANGES";

export interface SwarmRound {
	round: number;
	/** HEAD of the writer checkout after the writer turn. */
	writerSha?: string;
	gate?: string;
	verdict?: SwarmVerdict | "none";
	costUsd: number;
}

/**
 * Persisted on JobRecord.swarm. Loop: mode "swarm", rounds and verdicts. Board: mode "parallel"
 * (the regular fan-out), maxUsd checked as tasks finish, and the board file.
 */
export interface SwarmRecord {
	kind: "loop" | "board";
	isolate: boolean;
	maxRounds: number;
	maxUsd: number;
	spentUsd: number;
	rounds: SwarmRound[];
	outcome?: SwarmOutcome;
	/** Checkout HEAD before the first writer turn (the worktree base when isolated). */
	baseSha?: string;
	lastVerdict?: string;
	/** Board: the shared append-only board.jsonl. */
	boardPath?: string;
}

const VERDICT_LINE = /^\s*(?:\*\*)?VERDICT:\s*(APPROVE|REQUEST_CHANGES)(?:\*\*)?\s*$/i;

/**
 * The verdict is the last non-empty line of the reviewer reply, outside any code fence.
 * A verdict quoted earlier, followed by more text, or inside a fence is ambiguous (undefined).
 */
export function parseVerdict(text: string | undefined): SwarmVerdict | undefined {
	const lines = (text ?? "").split(/\r?\n/);
	let last = lines.length - 1;
	while (last >= 0 && !lines[last].trim()) last--;
	if (last < 0) return undefined;
	// CommonMark fences: the closer uses the opener's character, is at least as long, and has no info string.
	let fence: { char: string; length: number } | undefined;
	for (const line of lines.slice(0, last)) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!match) continue;
		const [char, length, rest] = [match[1][0], match[1].length, match[2]];
		if (!fence) {
			if (!(char === "`" && rest.includes("`"))) fence = { char, length };
		} else if (char === fence.char && length >= fence.length && !rest.trim()) fence = undefined;
	}
	if (fence) return undefined;
	const match = VERDICT_LINE.exec(lines[last]);
	return match ? (match[1].toUpperCase() as SwarmVerdict) : undefined;
}

function git(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout.trimEnd() : undefined;
}

export function isGitRepo(cwd: string): boolean {
	return git(cwd, ["rev-parse", "--show-toplevel"]) !== undefined;
}

export function headSha(cwd: string): string | undefined {
	return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * HEAD + porcelain status + diff of tracked files + names and contents of untracked files:
 * equal fingerprints mean the writer changed nothing, even when it only edited an untracked file.
 */
export function fingerprint(cwd: string): string | undefined {
	// From the repository root: a writer in a subdirectory may change files anywhere in the checkout.
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (root === undefined) return undefined;
	cwd = root;
	const head = git(cwd, ["rev-parse", "HEAD"]);
	const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
	const diff = git(cwd, ["diff", "HEAD", "--binary"]);
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (head === undefined || status === undefined || diff === undefined || untracked === undefined) return undefined;
	const hash = createHash("sha256").update(`${head}\0${status}\0${diff}\0`);
	for (const name of untracked.split("\0").filter(Boolean).sort()) {
		hash.update(`${name}\0`);
		try {
			const file = path.join(cwd, name);
			const stat = fs.lstatSync(file);
			hash.update(stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : stat.isFile() ? fs.readFileSync(file) : `type:${stat.mode}`);
		} catch {
			hash.update("missing");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

function cap(text: string, bytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= bytes) return text;
	return `${buf.subarray(0, bytes).toString("utf-8")}\n[truncated: ${buf.length - bytes} bytes]`;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export interface LoopDeps {
	swarm: SwarmRecord;
	writerTask: string;
	reviewerTask: string;
	/** Writer and reviewer checkout (the writer worktree when isolated). */
	cwd: string;
	isolated: boolean;
	signal: AbortSignal;
	/** Runs task 0 (writer) or 1 (reviewer); `resume` continues that task's own child session. */
	run: (slot: 0 | 1, text: string, resume: boolean) => Promise<SingleResult>;
	failed: (result: SingleResult) => boolean;
	/** Gate line of the writer checkout (last checks run), or undefined. */
	gate: () => string | undefined;
	persist: () => void;
	summaryCap: number;
}

export interface LoopResult {
	/** Compact block that heads the job result. */
	head: string;
	/** Last reviewer reply, placed after the worktree and gate summaries. */
	tail: string;
	error?: string;
}

const failureOutcome = (result: SingleResult): SwarmOutcome => (result.failure === "quota" ? "quota" : "failed");

const describeFailure = (who: string, result: SingleResult) =>
	`${who} ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr.slice(0, 500) || "(no error message)"}`;

export async function runSwarmLoop(deps: LoopDeps): Promise<LoopResult> {
	const { swarm } = deps;
	swarm.baseSha ??= headSha(deps.cwd);
	let error: string | undefined;
	let lastReview = "";
	let writerNote = "";
	let prevSha = swarm.baseSha;
	let pendingFindings = "";

	const finish = (outcome: SwarmOutcome, why?: string): LoopResult => {
		swarm.outcome = outcome;
		if (outcome !== "approved") error ??= why ?? `Swarm loop ended without approval (outcome ${outcome}).`;
		deps.persist();
		const rows = swarm.rounds.map((r) => `| ${r.round} | ${r.writerSha?.slice(0, 12) ?? "-"} | ${r.gate ?? "n/a"} | ${r.verdict ?? "-"} | ${usd(r.costUsd)} |`);
		const head = [
			`swarm loop · outcome: ${outcome} · rounds: ${swarm.rounds.length}/${swarm.maxRounds} · cost: ${usd(swarm.spentUsd)}`,
			...(rows.length ? ["| round | writer sha | gate | verdict | cost |", "|---|---|---|---|---|", ...rows] : []),
			...(why ? [`stop: ${why}`] : []),
		].join("\n");
		const tail = lastReview ? `### last reviewer reply\n${cap(lastReview.trim(), deps.summaryCap)}` : "";
		return { head, tail, error };
	};

	// `run` reports usage accumulated over the task's rounds; the round pays only the difference.
	const seen = [0, 0];
	const spend = (round: SwarmRound, slot: 0 | 1, result: SingleResult) => {
		const total = (result.usage as UsageStats).cost || 0;
		const cost = Math.max(0, total - seen[slot]);
		seen[slot] = Math.max(seen[slot], total);
		round.costUsd += cost;
		swarm.spentUsd += cost;
	};

	for (let k = 1; ; k++) {
		if (k > 1) {
			if (k > swarm.maxRounds) return finish("max_rounds", `reviewer still requests changes after ${swarm.maxRounds} round(s)`);
			if (swarm.spentUsd >= swarm.maxUsd) return finish("max_usd", `spent ${usd(swarm.spentUsd)} of ${usd(swarm.maxUsd)}`);
		}
		if (deps.signal.aborted) return finish("failed", "job stopped");
		const round: SwarmRound = { round: k, costUsd: 0 };
		swarm.rounds.push(round);
		deps.persist();

		// Writer turn: the brief first, then only the reviewer findings on its own session.
		const before = fingerprint(deps.cwd);
		const writerText = k === 1
			? `${deps.writerTask}\n\n## Swarm loop\nRound 1/${swarm.maxRounds}. A reviewer checks your work after this turn. ${deps.isolated ? "Commit your work before you finish." : "Leave your changes in the working tree or commit them."} End with a short summary of what changed.`
			: [
				`## Swarm loop: round ${k}/${swarm.maxRounds}`,
				`Remaining budget: ${usd(Math.max(0, swarm.maxUsd - swarm.spentUsd))}.`,
				"The reviewer requested changes. Address each finding below, run the relevant checks, " + (deps.isolated ? "commit, " : "") + "and end with a short summary of what changed.",
				"",
				"## Reviewer findings",
				cap(pendingFindings.trim() || "(no findings text)", 16 * 1024),
			].join("\n");
		const writer = await deps.run(0, writerText, k > 1);
		spend(round, 0, writer);
		if (deps.failed(writer)) {
			deps.persist();
			return finish(failureOutcome(writer), describeFailure("writer", writer));
		}
		writerNote = writer.finalText;
		const after = fingerprint(deps.cwd);
		const newSha = headSha(deps.cwd);
		round.writerSha = newSha;
		round.gate = deps.gate()?.split("\n")[0];
		deps.persist();
		if (before !== undefined && before === after) return finish("stalled", `writer changed nothing in round ${k}`);

		// Reviewer turn: the brief and the full range first, then only the delta.
		const range = swarm.baseSha && newSha ? `${(k === 1 ? swarm.baseSha : prevSha ?? swarm.baseSha).slice(0, 12)}..${newSha.slice(0, 12)}` : "(not a git checkout; inspect the files)";
		const gateLine = round.gate ?? "gate: not available";
		const reviewerText = k === 1
			? [
				deps.reviewerTask,
				"",
				"## Change under review",
				`Checkout: ${deps.cwd} (read only; do not edit, commit or change git state).`,
				`Range: ${range}; also check \`git status\` for uncommitted changes.`,
				gateLine,
				"",
				"## Writer summary",
				cap(writerNote.trim() || "(empty)", 8 * 1024),
				"",
				VERDICT_CONTRACT,
			].join("\n")
			: [
				`## Swarm loop: round ${k}/${swarm.maxRounds}`,
				`The writer addressed your findings. New range: ${range}.`,
				gateLine,
				"",
				"## Writer note",
				cap(writerNote.trim() || "(empty)", 2 * 1024),
				"",
				VERDICT_CONTRACT,
			].join("\n");
		prevSha = newSha;
		const reviewer = await deps.run(1, reviewerText, k > 1);
		spend(round, 1, reviewer);
		if (deps.failed(reviewer)) {
			round.verdict = "none";
			deps.persist();
			return finish(failureOutcome(reviewer), describeFailure("reviewer", reviewer));
		}
		lastReview = reviewer.finalText;
		swarm.lastVerdict = cap(lastReview.trim(), deps.summaryCap);
		const verdict = parseVerdict(lastReview);
		round.verdict = verdict ?? "none";
		deps.persist();
		if (verdict === "APPROVE") return finish("approved");
		if (!verdict) return finish("ambiguous", "reviewer reply has no VERDICT line");
		pendingFindings = lastReview;
	}
}

// ---------------------------------------------------------------------------
// Board: one append-only JSONL per board job, shared by its children through the
// child-only `board` tool (child-board.ts). No chat: entries have no addressee and
// nobody is notified; children read with `since` when they need to.

export const BOARD_KINDS = ["claim", "decision", "note", "blocker", "done"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
export const BOARD_TEXT_MAX = 400;
export const BOARD_REFS_MAX = 8;
export const BOARD_REF_MAX = 160;
export const BOARD_MAX_ENTRIES = 100;
export const BOARD_MAX_BYTES = 64 * 1024;
export const BOARD_SUMMARY_CAP = 2 * 1024;
export const BOARD_MIN_USD = 0.1;
export const BOARD_MAX_USD = 100;
export const BOARD_DEFAULT_USD = 15;
export const BOARD_PATH_ENV = "AGENT_BOARD_PATH";
export const BOARD_HANDLE_ENV = "AGENT_BOARD_HANDLE";

export interface BoardEntry {
	seq: number;
	ts: number;
	handle: string;
	kind: BoardKind;
	text: string;
	refs?: string[];
}

/** <baseDir>/<sessionId>/<jobId>/board.jsonl (the job record stays at <jobId>.json). */
export function boardPath(baseDir: string, sessionId: string, jobId: string): string {
	return path.join(baseDir, sessionId, jobId, "board.jsonl");
}

export function createBoard(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
}

export function readBoard(file: string): BoardEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const entries: BoardEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as BoardEntry;
			if (Number.isInteger(entry.seq) && typeof entry.text === "string") entries.push(entry);
		} catch {
			/* a torn line never blocks reading */
		}
	}
	return entries;
}

/** Board lock: held for milliseconds; only a dead owner is taken over (lockfile.ts). */
function withBoardLock<T>(file: string, body: () => T): T {
	const lock = `${file}.lock`;
	const attempt = waitLock(lock, {}, (held) => Boolean(held && typeof held.pid === "number" && !pidAlive(held.pid)), 5_000);
	if (!attempt.ok) throw new Error("Board is busy; try again.");
	try {
		return body();
	} finally {
		attempt.release();
	}
}

/** Validated append; seq is the last seq + 1 under the lock. Errors are model-facing. */
export function postBoard(file: string, input: { handle: string; kind: unknown; text: unknown; refs?: unknown }): { ok: true; entry: BoardEntry } | { ok: false; error: string } {
	const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
	if (!(BOARD_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `kind must be one of ${BOARD_KINDS.join(", ")}.` };
	const text = typeof input.text === "string" ? input.text.trim() : "";
	if (!text) return { ok: false, error: "text is required." };
	if (text.length > BOARD_TEXT_MAX) return { ok: false, error: `text has ${text.length} characters; the limit is ${BOARD_TEXT_MAX}. Post a shorter entry.` };
	let refs: string[] | undefined;
	if (input.refs !== undefined) {
		if (!Array.isArray(input.refs) || input.refs.some((ref) => typeof ref !== "string")) return { ok: false, error: "refs must be a list of strings." };
		refs = (input.refs as string[]).map((ref) => ref.trim()).filter(Boolean);
		if (refs.length > BOARD_REFS_MAX) return { ok: false, error: `refs has ${refs.length} items; the limit is ${BOARD_REFS_MAX}.` };
		const long = refs.find((ref) => ref.length > BOARD_REF_MAX);
		if (long) return { ok: false, error: `each ref is limited to ${BOARD_REF_MAX} characters.` };
		if (refs.length === 0) refs = undefined;
	}
	if (!fs.existsSync(file)) return { ok: false, error: "The board of this job no longer exists." };
	return withBoardLock(file, () => {
		const entries = readBoard(file);
		if (entries.length >= BOARD_MAX_ENTRIES) return { ok: false as const, error: `The board is full (${BOARD_MAX_ENTRIES} entries); reading still works.` };
		const entry: BoardEntry = { seq: (entries.at(-1)?.seq ?? 0) + 1, ts: Date.now(), handle: input.handle, kind: kind as BoardKind, text, ...(refs ? { refs } : {}) };
		const line = `${JSON.stringify(entry)}\n`;
		if (fs.statSync(file).size + Buffer.byteLength(line) > BOARD_MAX_BYTES) return { ok: false as const, error: `The board is full (${BOARD_MAX_BYTES / 1024} KiB); reading still works.` };
		fs.appendFileSync(file, line, { mode: 0o600 });
		return { ok: true as const, entry };
	});
}

export function formatBoardEntry(entry: BoardEntry): string {
	return `#${entry.seq} [${entry.handle} · ${entry.kind}] ${entry.text}${entry.refs?.length ? ` (refs: ${entry.refs.join(", ")})` : ""}`;
}

/** Final result section: compact entries up to ~2 KiB, then the path of the full file. */
export function boardSummary(file: string): string {
	const entries = readBoard(file);
	const lines: string[] = [];
	let bytes = 0;
	for (const entry of entries) {
		const line = formatBoardEntry(entry).replace(/\s+/g, " ");
		bytes += Buffer.byteLength(line) + 1;
		if (bytes > BOARD_SUMMARY_CAP) {
			lines.push(`[${entries.length - lines.length} more entries in the file]`);
			break;
		}
		lines.push(line);
	}
	return [`### board (${entries.length} entries)`, ...(lines.length ? lines : ["(empty)"]), `full board: ${file}`].join("\n");
}

/** First line of the objective (or of the task) for the sibling list. */
function objectiveLine(task: string): string {
	const match = /## Objective\n([^\n]+)/.exec(task);
	const line = (match?.[1] ?? task.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** The 4-line block prepended to each board task message; the role system prompt stays untouched. */
export function boardBlock(own: string, siblings: Array<{ handle: string; task: string }>): string {
	return [
		`Swarm board: you are ${own}. Siblings working in parallel: ${siblings.map((s) => `${s.handle} (${objectiveLine(s.task)})`).join("; ")}.`,
		"Use the `board` tool to post a claim before you take a file or contract, a decision when you fix a shared choice, a blocker when you are stuck, and done when you finish.",
		"Before you touch a shared contract (API, schema, shared file), read the board with since = the last seq you saw.",
		"The board is not a chat: no messages to siblings, no questions and answers; post only facts others need.",
	].join("\n");
}
