import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep transcript tool cards compact on startup, reload, and session switches. */
export default function agentToolDisplay(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setToolsExpanded(false);
  });
}
