/** Pi owns compaction, using the user's selected model, authentication and errors. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionCachePolicy } from "../../juice/cache-policy.mjs";

export default function compaction(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    if (sessionCachePolicy(ctx)?.deferCompaction(event, ctx)) return { cancel: true };
    if (event.signal?.aborted) return { cancel: true };
    // No forced provider, auxiliary inference or silent retry after a failure.
    // Undefined keeps the native Pi compaction path and custom instructions intact.
  });
}
