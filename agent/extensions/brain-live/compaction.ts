/** Pi owns compaction, using the user's selected model, authentication and errors. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionCachePolicy } from "../../core/cache-policy.mjs";
import { installToolClear, clearBeforeAutoCompaction, replayToolClears } from './compaction/tool-clear.ts';

export default function compaction(pi: ExtensionAPI) {
  installToolClear(pi);
  pi.on("session_before_compact", async (event, ctx) => {
    if (sessionCachePolicy(ctx)?.deferCompaction(event, ctx)) return { cancel: true };
    if (event.signal?.aborted) return { cancel: true };
    if (event.reason === 'threshold') {
      const usage = ctx.getContextUsage();
      const threshold = usage ? (usage.contextWindow >= 1_000_000 ? 450_000 : Math.floor(usage.contextWindow * 0.9)) : 0;
      if (clearBeforeAutoCompaction(ctx, threshold)) return { cancel: true };
    }
    // Summaries also see saved markers, never resurrect cleared output.
    if (event.preparation) {
      const entries = ctx.sessionManager.getBranch();
      event.preparation.messagesToSummarize = replayToolClears(event.preparation.messagesToSummarize, entries);
      event.preparation.turnPrefixMessages = replayToolClears(event.preparation.turnPrefixMessages, entries);
    }
    // No forced provider, auxiliary inference or silent retry after a failure.
    // Undefined keeps the native Pi compaction path and custom instructions intact.
  });
}
