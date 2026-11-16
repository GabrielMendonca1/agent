/**
 * Child-only: caps large tool outputs before they enter a subagent's context.
 *
 * Measured (Mark sessions, 30 days): child tool outputs above 10k chars (80% bash
 * sed/cat/head/git diff/rg, 17% read) cost about as much in later cacheRead as in the
 * first send. Above the limit the full text goes to a per-session temp file and the
 * model gets head + tail plus one line with the omitted size and the file path, to be
 * read in slices (read offset/limit or rg -n).
 *
 * Loaded only by the runner (`-e`) in children; it lives under subagent/ so the
 * main session never auto-loads it. AGENT_CHILD_TOOL_OUTPUT_MAX sets the limit in
 * chars (default 8000); 0 disables.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CHILD_TOOL_OUTPUT_MAX = 8000;
/** A `read` that already asks for at most this many lines is left alone. */
export const SMALL_READ_LIMIT = 200;
const CAPPED_TOOLS = new Set(["bash", "read", "grep", "find", "ls"]);

export function childToolOutputMax(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.AGENT_CHILD_TOOL_OUTPUT_MAX;
	if (raw === undefined || raw.trim() === "") return DEFAULT_CHILD_TOOL_OUTPUT_MAX;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CHILD_TOOL_OUTPUT_MAX;
}

/** Whether a finished call of `toolName` with `input` is a candidate for capping. */
export function shouldCap(toolName: string, input: unknown): boolean {
	if (!CAPPED_TOOLS.has(toolName)) return false;
	if (toolName === "read") {
		const limit = Number((input as { limit?: unknown } | undefined)?.limit);
		if (Number.isFinite(limit) && limit > 0 && limit <= SMALL_READ_LIMIT) return false;
	}
	return true;
}

/**
 * Head (~3/4 of max) + tail (~1/4), cut on line boundaries when one is near.
 * Returns undefined when `text` fits. `fullPath` is named in the marker line.
 */
export function capText(text: string, max: number, fullPath: string): string | undefined {
	if (max <= 0 || text.length <= max) return undefined;
	const headBudget = Math.floor(max * 0.75);
	const tailBudget = max - headBudget;
	let headEnd = text.lastIndexOf("\n", headBudget);
	if (headEnd < headBudget / 2) headEnd = headBudget;
	let tailStart = text.indexOf("\n", text.length - tailBudget);
	if (tailStart < 0 || tailStart - (text.length - tailBudget) > tailBudget / 2) tailStart = text.length - tailBudget;
	else tailStart += 1;
	if (tailStart <= headEnd) return undefined;
	const lineOf = (index: number) => text.slice(0, index).split("\n").length;
	const totalLines = text.split("\n").length;
	const omitted = tailStart - headEnd;
	const marker = `[... ${omitted} of ${text.length} chars omitted (lines ${lineOf(headEnd) + (text[headEnd] === "\n" ? 1 : 0)}-${lineOf(tailStart) - (text[tailStart - 1] === "\n" ? 1 : 0)} of ${totalLines}). Full output: ${fullPath} — read it with read offset/limit or rg -n, not whole.]`;
	return `${text.slice(0, headEnd)}\n${marker}\n${text.slice(tailStart)}`;
}

export default function childOutputCap(pi: ExtensionAPI) {
	const max = childToolOutputMax();
	if (max <= 0) return;
	let dir: string | undefined;
	pi.on("tool_result", (event: any, ctx: any) => {
		if (!shouldCap(event.toolName, event.input)) return;
		const content = Array.isArray(event.content) ? event.content : [];
		if (!content.length || content.some((part: any) => part?.type !== "text")) return;
		const text = content.map((part: any) => part.text ?? "").join("\n");
		if (text.length <= max) return;
		if (!dir) {
			const session = String(ctx?.sessionManager?.getSessionId?.() ?? process.pid).replace(/[^A-Za-z0-9._-]/g, "_");
			dir = join(tmpdir(), "agent-child-output", session);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const file = join(dir, `${event.toolName}-${String(event.toolCallId).replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
		const capped = capText(text, max, file);
		if (!capped) return;
		try {
			writeFileSync(file, text, { mode: 0o600 });
		} catch {
			return; // without the full copy the cut would lose data: keep the original
		}
		return { content: [{ type: "text", text: capped }] };
	});
}
