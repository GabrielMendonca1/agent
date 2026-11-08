import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EMPTY_STOP, initialState, next, NUDGE, STOP } from "../../juice/loop-guard.mjs";

export default function loopGuard(pi: ExtensionAPI) {
  if (process.env.MARK_LOOP_GUARD === "0") return;
  let state = initialState();

  pi.on("session_start", () => { try { state = initialState(); } catch { /* best-effort */ } });
  pi.on("session_switch", () => { try { state = initialState(); } catch { /* best-effort */ } });

  pi.on("before_agent_start", (event) => {
    try { state = next(state, event).state; } catch { /* best-effort */ }
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const outcome = next(state, event);
      state = outcome.state;
      if (outcome.stop) {
        try { ctx.ui.notify(STOP, "warning"); } catch { /* headless */ }
        return { block: true, reason: STOP, terminate: true };
      }
    } catch { /* never interrupt the agent on a guard failure */ }
  });

  pi.on("tool_result", (event) => {
    try {
      const outcome = next(state, event);
      state = outcome.state;
      if (outcome.nudge) return {
        content: [...event.content, { type: "text" as const, text: NUDGE }],
        structuredContent: event.structuredContent,
      };
    } catch { /* best-effort */ }
  });

  pi.on("turn_end", (event, ctx) => {
    try {
      const hasText = event.message.role === "assistant" && Array.isArray(event.message.content)
        && event.message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
      const outcome = next(state, { type: "turn_end", hasText, toolResults: event.toolResults });
      state = outcome.state;
      if (outcome.abort) {
        try { ctx.abort(); } catch { /* best-effort */ }
        try { ctx.ui.notify(EMPTY_STOP, "warning"); } catch { /* headless */ }
      }
    } catch { /* best-effort */ }
  });
}
