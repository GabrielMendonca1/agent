import { createHash } from "node:crypto";

export const NUDGE = "loop guard: esta chamada rodou 3 vezes com o mesmo resultado. Mude a abordagem.";
export const STOP = "loop guard: sexta chamada idêntica após 5 resultados iguais. Execução interrompida.";
export const CYCLE_NUDGE = "loop guard: este ciclo de chamadas rodou 3 vezes com os mesmos resultados. Mude a abordagem.";
export const CYCLE_STOP = "loop guard: início do sexto ciclo de chamadas após 5 repetições com os mesmos resultados. Execução interrompida.";
export const EMPTY_STOP = "loop guard: 3 turnos sem texto e sem chamadas bem-sucedidas. Execução interrompida.";

export function stableStringify(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

const PERIODS = [2, 3];
const HISTORY_SIZE = 5 * Math.max(...PERIODS);

function repeatedSuffix(history, period, repetitions) {
  const start = history.length - period * repetitions;
  if (start < 0) return false;
  const first = history[start];
  // Single-key streaks already have their own guard.
  if (history.slice(start, start + period).every(({ key }) => key === first.key)) return false;
  for (let i = start + period; i < history.length; i++) {
    if (history[i].key !== history[i - period].key || history[i].hash !== history[i - period].hash) return false;
  }
  return true;
}

export function initialState() {
  return { key: null, hash: null, streak: 0, history: [], pending: {}, emptyTurns: 0 };
}

// Only completed, identical results grow the streak. The sixth attempt is blocked
// before execution, so its result cannot be known. Nested calls never participate.
export function next(state = initialState(), event) {
  if (event.type === "before_agent_start" && event.messageType === "user") return { state: initialState() };
  if (event.parentToolCallId) return { state };
  if (event.type === "tool_call") {
    const key = `${event.toolName}:${stableStringify(event.input)}`;
    if (key === state.key && state.streak >= 5) return { state, stop: true };
    if (PERIODS.some((period) => repeatedSuffix(state.history, period, 5) && key === state.history.at(-period).key)) {
      return { state, stop: true, cycle: true };
    }
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
    const history = [...state.history, { key, hash }].slice(-HISTORY_SIZE);
    // A rotated suffix on the next result is still the same cycle, not a new nudge.
    const cycle = PERIODS.some((period) => repeatedSuffix(history, period, 3) && !repeatedSuffix(state.history, period, 3));
    return { state: { ...state, key, hash, streak, history, pending }, nudge: streak === 3 || cycle, ...(cycle ? { cycle } : {}) };
  }
  if (event.type === "turn_end") {
    const empty = !event.hasText && event.toolResults.every((result) => result.isError || result.blocked);
    const emptyTurns = empty ? state.emptyTurns + 1 : 0;
    return { state: { ...state, pending: {}, emptyTurns }, abort: emptyTurns === 3 };
  }
  return { state };
}
