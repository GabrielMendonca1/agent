// Prioridade do projeto como o `hello` a devolve (o servidor lê o STATUS.md
// espelhado). Só formatação: projeto sem prioridade não tem o que mostrar, e é
// por isso que nada aqui inventa título, contagem ou linha.
import type { CorePriority } from "./core.ts";
import { looksSecret, safeInline } from "./messaging.ts";

const TITLE_MAX = 120;
const STATUS_TITLE_MAX = 48;
/** Quantos bloqueios cabem no aviso de contexto. */
const BLOCKED_MAX = 5;

function safeText(value: string | undefined, max = TITLE_MAX): string {
  const clean = safeInline(value, max).replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();
  return clean && looksSecret(clean) ? "[redigido]" : clean;
}

/** `null` quando o projeto ainda não tem tarefa nenhuma na prioridade. */
export function priorityPercent(priority: CorePriority): number | null {
  return priority.total > 0 ? Math.round(100 * priority.done / priority.total) : null;
}

function progress(priority: CorePriority): string {
  const percent = priorityPercent(priority);
  return percent === null ? "sem tarefas" : `${percent}% (${priority.done}/${priority.total})`;
}

/** Linha da barra de status do Pi. */
export function priorityStatus(priority: CorePriority): string {
  const percent = priorityPercent(priority);
  return `⚑ ${safeText(priority.title, STATUS_TITLE_MAX) || "prioridade"} ${percent === null ? "sem tarefas" : `${percent}%`}`;
}

/** Aviso que entra no contexto quando a prioridade do projeto muda. */
export function formatPriorityContext(priority: CorePriority, project: string): string {
  const parts = [`Prioridade do projeto ${safeText(project, 60) || "desconhecido"}: ${safeText(priority.title) || "sem título"} — ${progress(priority)}.`];
  const next = safeText(priority.next);
  if (next) parts.push(`Próxima: ${next}.`);
  const blocked = priority.blocked.slice(0, BLOCKED_MAX).map((item) => safeText(item)).filter(Boolean);
  if (blocked.length > 0) parts.push(`Bloqueios: ${blocked.join("; ")}.`);
  return parts.join(" ");
}

export function priorityFingerprint(priority: CorePriority | undefined): string {
  return priority ? JSON.stringify(priority) : "unavailable";
}
