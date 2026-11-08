import { createHash } from "node:crypto";

export const NUDGE = "loop guard: esta chamada rodou 3 vezes com o mesmo resultado. Mude a abordagem.";
export const STOP = "loop guard: sexta chamada idêntica após 5 resultados iguais. Execução interrompida.";
export const EMPTY_STOP = "loop guard: 3 turnos sem texto e sem chamadas bem-sucedidas. Execução interrompida.";

export function stableStringify(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

export function initialState() {
  return { key: null, hash: null, streak: 0, pending: {}, emptyTurns: 0 };
}

// Only completed, identical results grow the streak. The sixth attempt is blocked
// before execution, so its result cannot be known. Nested calls never participate.
export function next(state = initialState(), event) {
  if (event.type === "before_agent_start" && event.messageType === "user") return { state: initialState() };
  if (event.parentToolCallId) return { state };
  if (event.type === "tool_call") {
    const key = `${event.toolName}:${stableStringify(event.input)}`;
    if (key === state.key && state.streak >= 5) return { state, stop: true };
    return { state: {
      ...state,
      ...(key !== state.key ? { key, hash: null, streak: 0 } : {}),
      pending: { ...state.pending, [event.toolCallId]: key },
    } };
  }
  if (event.type === "tool_result") {
    const key = state.pending[event.toolCallId];
    if (key === undefined) return { state };
    const pending = { ...state.pending };
    delete pending[event.toolCallId];
    const hash = createHash("sha256").update(stableStringify({
      isError: event.isError, content: event.content, structuredContent: event.structuredContent,
    })).digest("hex");
    const streak = key === state.key && hash === state.hash ? state.streak + 1 : 1;
    return { state: { ...state, key, hash, streak, pending }, nudge: streak === 3 };
  }
  if (event.type === "turn_end") {
    const empty = !event.hasText && event.toolResults.every((result) => result.isError || result.blocked);
    const emptyTurns = empty ? state.emptyTurns + 1 : 0;
    return { state: { ...state, pending: {}, emptyTurns }, abort: emptyTurns === 3 };
  }
  return { state };
}
