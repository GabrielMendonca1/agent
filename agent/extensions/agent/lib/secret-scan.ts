/**
 * Heurística de segredo compartilhada por tudo que sai desta sessão: Megamind
 * (outra máquina) e peers (mesma máquina). Prefixos conhecidos de credencial,
 * campos nomeados, JWT e URL com credencial.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub (PAT clássico, OAuth, app, refresh) e fine-grained.
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  // OpenAI/Anthropic e afins.
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/u,
  // AWS access key id, Slack, Google API key.
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/u,
  /\bxox[abpr]-[A-Za-z0-9-]{8,}/u,
  /\bAIza[0-9A-Za-z_-]{20,}/u,
  // Chave privada PEM e JWT.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/u,
  // `Bearer` já sai redigido por `redactBearer`: aqui pega `Basic`, `token …` e afins.
  /\bAuthorization\s*[:=]\s*(?!Bearer\s*\[?redacted\]?(?![\w-]))\S{3,}/iu,
  // Campo nomeado com valor.
  /\b(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|senha|password|passwd|pwd)\s*[:=]\s*["']?\S{6,}/iu,
  // `key` sozinho é palavra comum: só conta com valor longo.
  /\bkey\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}/iu,
  // URL com credencial embutida ou segredo na query.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /\bhttps?:\/\/\S*[?&](?:key|token|sig|signature|access_token|api[_-]?key|password)=[^\s&"']{6,}/iu,
];

/** `true` quando o texto não pode sair desta sessão. */
export function looksSecret(...values: string[]): boolean {
  return values.some((value) => typeof value === "string" && SECRET_PATTERNS.some((pattern) => pattern.test(value)));
}

/** Redige `Bearer <token>` em qualquer texto. */
export function redactBearer(value: string): string {
  return value.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}
