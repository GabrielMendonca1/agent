/**
 * Audit of a subagent job without loading the child's context.
 *
 * Each started task records its child session JSONL (the full transcript).
 * `trace` reads it and returns one short line per step: assistant text, tool
 * call with summarized arguments, tool result as ok|error + bytes, then model,
 * turns and usage. Thinking and tool-result bodies are never included.
 */

import * as fs from "node:fs";
import type { JobRecord, JobTaskSpec } from "./jobs.ts";

const TEXT_CAP = 300;
const ARGS_CAP = 200;

function cut(text: string, cap: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

function usageLine(u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }): string {
	return `in ${u.input} out ${u.output} cacheRead ${u.cacheRead} cacheWrite ${u.cacheWrite} $${u.cost.toFixed(4)}`;
}

/**
 * `legacy`: record written before per-task audit, real state unknown. A task still
 * `running` in a finished job lost its parent before recovery marked it.
 */
function taskState(record: JobRecord, task: JobTaskSpec): string {
	if (task.state === "running" && record.status !== "running") return "interrupted";
	return task.state ?? (record.status === "running" ? "pending" : "legacy");
}

/** Child session of a task; legacy records only had the job-level list, matched by index when unambiguous. */
function taskSessionFile(record: JobRecord, index: number): string | undefined {
	const task = record.tasks[index];
	if (task.sessionFile || task.state) return task.sessionFile;
	const files = record.sessionFiles ?? [];
	return files.length === record.tasks.length ? files[index] : undefined;
}

/** Legacy job-level sessions that cannot be assigned to a task. */
function unattributedSessions(record: JobRecord): string[] {
	const files = record.sessionFiles ?? [];
	const legacy = record.tasks.some((task) => !task.state && !task.sessionFile);
	return legacy && files.length !== record.tasks.length ? files : [];
}

/** One line per task for action status: role, state, model, usage and child JSONL. */
export function taskStatusLines(record: JobRecord): string[] {
	return record.tasks.map((task, i) => {
		const parts = [`task ${i + 1} ${task.agent}`, taskState(record, task)];
		if (task.model) parts.push(`${task.model}${task.thinking ? ` thinking ${task.thinking}` : ""}`);
		if (task.usage) parts.push(`${task.usage.turns} turns ${usageLine(task.usage)}`);
		const file = taskSessionFile(record, i);
		if (file) parts.push(file);
		if (task.error) parts.push(`error: ${cut(task.error, TEXT_CAP)}`);
		return parts.join(" · ");
	}).concat(unattributedSessions(record).map((file) => `job session (task unknown) · ${file}`));
}

function resultBytes(content: unknown): number {
	if (!Array.isArray(content)) return typeof content === "string" ? Buffer.byteLength(content, "utf-8") : 0;
	let bytes = 0;
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") bytes += Buffer.byteLength(part.text, "utf-8");
		else if (typeof part?.data === "string") bytes += part.data.length;
	}
	return bytes;
}

/** Linear summary of one child session file; tolerates a partial last line of a running child. */
export function traceSession(file: string): string[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (error) {
		return [`(session unreadable: ${error instanceof Error ? error.message : String(error)})`];
	}
	const lines: string[] = [];
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let turns = 0;
	let model: string | undefined;
	let thinking: string | undefined;
	let step = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "model_change" && entry.modelId) model = `${entry.provider}/${entry.modelId}`;
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) thinking = entry.thinkingLevel;
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role === "assistant") {
			turns++;
			if (msg.provider && msg.model) model = `${msg.provider}/${msg.model}`;
			const u = msg.usage;
			if (u) {
				usage.input += u.input || 0;
				usage.output += u.output || 0;
				usage.cacheRead += u.cacheRead || 0;
				usage.cacheWrite += u.cacheWrite || 0;
				usage.cost += u.cost?.total || 0;
			}
			for (const part of Array.isArray(msg.content) ? msg.content : []) {
				if (part?.type === "text" && part.text?.trim()) lines.push(`${++step}. assistant: ${cut(part.text, TEXT_CAP)}`);
				else if (part?.type === "toolCall") lines.push(`${++step}. call ${part.name} ${cut(JSON.stringify(part.arguments ?? {}), ARGS_CAP)}`);
			}
			if (msg.errorMessage) lines.push(`${++step}. assistant error (${msg.stopReason ?? "error"}): ${cut(String(msg.errorMessage), TEXT_CAP)}`);
		} else if (msg.role === "toolResult") {
			lines.push(`${++step}. result ${msg.toolName ?? "?"} ${msg.isError ? "error" : "ok"} ${resultBytes(msg.content)} B`);
		}
	}
	if (lines.length === 0) lines.push("(no steps recorded yet)");
	lines.push(`model ${model ?? "?"}${thinking ? ` thinking ${thinking}` : ""} · ${turns} turns · ${usageLine(usage)}`);
	return lines;
}

/** Trace of one task (1-based) or all tasks of a job. */
export function traceJob(record: JobRecord, taskIndex?: number): { ok: true; text: string } | { ok: false; error: string } {
	if (taskIndex !== undefined && (!Number.isInteger(taskIndex) || taskIndex < 1 || taskIndex > record.tasks.length)) {
		return { ok: false, error: `taskIndex must be between 1 and ${record.tasks.length}.` };
	}
	const indexes = taskIndex === undefined ? record.tasks.map((_, i) => i) : [taskIndex - 1];
	const sections = indexes.map((i) => {
		const task = record.tasks[i];
		const file = taskSessionFile(record, i);
		const head = `## task ${i + 1} · ${task.agent} · ${taskState(record, task)}${file ? ` · ${file}` : ""}`;
		const body = file ? traceSession(file) : ["(no child session)"];
		if (task.error) body.push(`error: ${cut(task.error, TEXT_CAP)}`);
		return [head, ...body].join("\n");
	});
	const loose = unattributedSessions(record);
	if (loose.length) sections.push(["## job sessions (legacy record; not attributed to tasks)", ...loose].join("\n"));
	return { ok: true, text: `job ${record.jobId} (${record.status})\n\n${sections.join("\n\n")}` };
}
