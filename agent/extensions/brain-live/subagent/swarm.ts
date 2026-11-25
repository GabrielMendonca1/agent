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
	"- swarm board: 2+ coupled agents working in parallel on one shared objective (not available yet; use parallel subagent tasks meanwhile).",
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
	"End the reply with one final line that is exactly `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`.",
	"Approve only when no blocking finding remains. A reply without that line counts as not approved.",
].join("\n");

export type SwarmOutcome = "approved" | "ambiguous" | "stalled" | "max_rounds" | "max_usd" | "quota" | "failed";
export type SwarmVerdict = "APPROVE" | "REQUEST_CHANGES";

export interface SwarmRound {
	round: number;
	/** HEAD of the writer checkout after the writer turn. */
	writerSha?: string;
	gate?: string;
	verdict?: SwarmVerdict | "none";
	costUsd: number;
}

/** Persisted on JobRecord.swarm; board (part 2) adds its own fields under kind "board". */
export interface SwarmRecord {
	kind: "loop";
	isolate: boolean;
	maxRounds: number;
	maxUsd: number;
	spentUsd: number;
	rounds: SwarmRound[];
	outcome?: SwarmOutcome;
	/** Checkout HEAD before the first writer turn (the worktree base when isolated). */
	baseSha?: string;
	lastVerdict?: string;
}

const VERDICT_LINE = /^\s*(?:\*\*)?VERDICT:\s*(APPROVE|REQUEST_CHANGES)(?:\*\*)?\s*$/i;

/** Last isolated verdict line of the reviewer reply; undefined when there is none. */
export function parseVerdict(text: string | undefined): SwarmVerdict | undefined {
	const lines = (text ?? "").split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = VERDICT_LINE.exec(lines[i]);
		if (match) return match[1].toUpperCase() as SwarmVerdict;
	}
	return undefined;
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

/** HEAD + porcelain status + diff hash: equal fingerprints mean the writer changed nothing. */
export function fingerprint(cwd: string): string | undefined {
	const head = git(cwd, ["rev-parse", "HEAD"]);
	const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
	const diff = git(cwd, ["diff", "HEAD", "--binary"]);
	if (head === undefined || status === undefined || diff === undefined) return undefined;
	return createHash("sha256").update(`${head}\0${status}\0${diff}`).digest("hex");
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
