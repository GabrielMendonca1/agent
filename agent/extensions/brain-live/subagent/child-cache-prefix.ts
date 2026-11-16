/**
 * Child-only: keeps the Anthropic system cache breakpoint shared across worktrees.
 *
 * Children run with --no-context-files (AGENTS.md goes in the task message), so the system
 * prompt is role + skills + a trailing `<cwd>` section, and only `<cwd>` differs between two
 * children of the same role/model in different checkouts. Pi sends the system as one text block
 * with cache_control at its end, which puts the cwd inside the cached prefix. This splits the
 * block before `<cwd>` and moves the breakpoint there; the cwd block is still covered by the
 * message breakpoint. Same number of breakpoints, same bytes, same order.
 *
 * Loaded only by the runner (`-e`); lives under subagent/ so the main session never loads it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CWD_SECTION = "\n\n<cwd>\n";

export function splitSystemBeforeCwd(payload: any): any {
	if (!payload || typeof payload !== "object" || !Array.isArray(payload.system) || !Array.isArray(payload.messages)) return undefined;
	const last = payload.system.at(-1);
	if (last?.type !== "text" || !last.cache_control || typeof last.text !== "string") return undefined;
	const at = last.text.lastIndexOf(CWD_SECTION);
	// Only when cwd is the final section: anything after it would also leave the shared prefix.
	if (at <= 0 || !last.text.endsWith("\n</cwd>") || last.text.indexOf("\n</cwd>", at) !== last.text.length - 7) return undefined;
	const { cache_control, ...block } = last;
	return {
		...payload,
		system: [...payload.system.slice(0, -1), { ...block, text: last.text.slice(0, at), cache_control }, { ...block, text: last.text.slice(at) }],
	};
}

export default function childCachePrefix(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event: { payload: any }) => splitSystemBeforeCwd(event.payload));
}
