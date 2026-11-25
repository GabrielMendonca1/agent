/**
 * Child-only: the `board` tool of a swarm board job.
 *
 * The runner loads this file with `-e` only when the child invocation carries a board
 * (ChildInvocation.board, so `continue` keeps it) and sets AGENT_BOARD_PATH and
 * AGENT_BOARD_HANDLE. Without both variables nothing is registered. Lives under
 * subagent/ so the main session never loads it.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BOARD_HANDLE_ENV, BOARD_KINDS, BOARD_PATH_ENV, formatBoardEntry, postBoard, readBoard } from "./swarm.ts";

const BoardParams = Type.Object({
	action: StringEnum(["post", "read"] as const),
	kind: Type.Optional(StringEnum(BOARD_KINDS, { description: "post: entry kind; read: only this kind" })),
	text: Type.Optional(Type.String({ description: "post: one fact, up to 400 characters" })),
	refs: Type.Optional(Type.Array(Type.String(), { description: "post: up to 8 paths, symbols or commits" })),
	since: Type.Optional(Type.Integer({ minimum: 0, description: "read: only entries after this seq (default 0)" })),
});

export default function childBoard(pi: ExtensionAPI) {
	const file = process.env[BOARD_PATH_ENV];
	const handle = process.env[BOARD_HANDLE_ENV];
	if (!file || !handle) return;
	const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) });

	pi.registerTool({
		name: "board",
		label: "Board",
		description: "Shared append-only board of your swarm: post claim, decision, blocker, done or note entries for sibling agents, and read new entries with since. Not a chat.",
		promptSnippet: "Post claims, decisions, blockers and done to the swarm board; read it with since",
		parameters: BoardParams,
		async execute(_toolCallId, params) {
			if (params.action === "post") {
				const posted = postBoard(file, { handle, kind: params.kind, text: params.text, refs: params.refs });
				if (!posted.ok) return reply(posted.error, true);
				return reply(`Posted #${posted.entry.seq} (${posted.entry.kind}).`);
			}
			const since = Math.max(0, Math.floor(params.since ?? 0));
			const entries = readBoard(file).filter((entry) => entry.seq > since && (!params.kind || entry.kind === params.kind));
			if (entries.length === 0) return reply(`No new board entries since #${since}.`);
			return reply(entries.map(formatBoardEntry).join("\n"));
		},
	});
}
