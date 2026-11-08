// Prévia do último prompt humano (contrato §2.2 `last_prompt`): uma linha,
// ≤140 pontos de código, nunca logada nem guardada em nenhum outro lugar.
import { redactBearer } from "./gateway.ts";
import { looksSecret } from "./messaging.ts";

/** Teto do contrato, em pontos de código (o servidor trunca de novo). */
export const LAST_PROMPT_MAX = 140;

/**
 * O prompt como os sócios o veem: controles e separadores de linha/parágrafo
 * (que o servidor recusa) viram espaço, espaço em branco colapsa, e o corte em
 * 140 inclui o `…`. Prompt com cara de segredo não é publicado: vira `""`, que
 * limpa a prévia anterior no servidor.
 */
export function lastPromptPreview(raw: string): string {
  const flat = redactBearer(raw)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!flat || looksSecret(flat)) return "";
  const runes = [...flat];
  if (runes.length <= LAST_PROMPT_MAX) return flat;
  return `${runes.slice(0, LAST_PROMPT_MAX - 1).join("").trimEnd()}…`;
}
