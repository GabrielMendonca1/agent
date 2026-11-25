/**
 * Child-only: soft timeout. Near the job's hard timeout the child gets one steer
 * message asking it to commit what works and summarize what is left.
 *
 * `pi -p` has no interactive stdin, so the runner cannot type into the child. The
 * runner sets AGENT_CHILD_SOFT_DEADLINE_MS (absolute epoch ms: job start + timeout
 * - margin, margin = 10% of the timeout, at least 3 min, never before the start).
 * Once past it, while a run is in flight, this extension queues the message with
 * `sendUserMessage(..., { deliverAs: "steer" })`; the agent loop delivers it before
 * the next model call (after the current tool calls finish). At most once per process.
 *
 * Loaded only by the runner (`-e`); lives under subagent/ so the main session never loads it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SOFT_DEADLINE_ENV = "AGENT_CHILD_SOFT_DEADLINE_MS";
export const SOFT_TIMEOUT_MESSAGE = "Time is almost up: commit what works and summarize what is left.";

export function softDeadlineFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[SOFT_DEADLINE_ENV];
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export default function childSoftDeadline(pi: ExtensionAPI) {
	const deadline = softDeadlineFromEnv();
	if (deadline === undefined) return;
	let sent = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const fire = () => {
		if (sent || !running || Date.now() < deadline) return;
		sent = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
		try {
			pi.sendUserMessage(SOFT_TIMEOUT_MESSAGE, { deliverAs: "steer" });
		} catch {
			/* the hard timeout still applies */
		}
	};

	pi.on("agent_start", () => {
		running = true;
		if (sent) return;
		if (Date.now() >= deadline) return fire();
		if (!timer) {
			timer = setTimeout(fire, deadline - Date.now());
			// Never keep a finished print-mode child alive.
			timer.unref?.();
		}
	});
	// Backstop for timers that fire late (busy event loop): checked at every turn boundary.
	pi.on("turn_end", () => fire());
	pi.on("tool_execution_end", () => fire());
	pi.on("agent_end", () => {
		running = false;
	});
}
