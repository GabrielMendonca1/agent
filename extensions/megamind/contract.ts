// Contrato com o Mainframe num lugar só: nome de tool, nome de campo, kinds da
// inbox e tetos. Quando `docs/ARCA-MEGAMIND-CONTRACT.md` do servidor divergir,
// só este arquivo muda.
import { companyOf, type MegamindProfileId } from "./profile.ts";

/** Tools do gateway MCP (device Bearer). Nunca viram tool do modelo. */
export const TOOL = {
  // Núcleo v6.
  hello: "hello",
  who: "who",
  conversation: "send",
  read: "read",
  reply: "reply",
  bye: "bye",
  // v5: o caminho de compatibilidade e o que a v6 não substituiu.
  projects: "projects_list",
  register: "register_agent",
  agents: "list_agents",
  send: "send_message",
  requestCreate: "request_create",
  requestUpdate: "request_update",
  requestsList: "requests_list",
  inbox: "inbox",
  acknowledge: "acknowledge",
  handoff: "handoff",
  prioritiesList: "priorities_list",
  chatPost: "chat_post",
  chatRead: "chat_read",
  chatMembers: "chat_members",
} as const;

/** Rota SSE do device (mesmo Bearer do MCP). */
export const EVENTS_PATH = "/api/arca/events";

/** Tipos de item de `read` (v6): o adaptador v5 traduz a inbox antiga para eles. */
export const INBOX_KINDS = ["message", "ask", "reply"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Versão do núcleo servida pelo gateway (`capabilities.<empresa>.core`). */
export const CORE_V6 = 6;

/** Transições que o Pi pode pedir em `request_update`. */
export const REPLY_STATUS = ["accepted", "declined", "in_progress", "done", "failed"] as const;
export type ReplyStatus = (typeof REPLY_STATUS)[number];

/** Status que mantêm um pedido de colega "em atendimento" nesta sessão. */
export const OPEN_STATUS: readonly string[] = ["sent", "accepted", "in_progress"];

/** Canal de grupo do chat (§2.13); o resto é DM por handle. */
export const CHAT_GROUP = "arca";

/**
 * Nome do grupo neste perfil (a tabela de empresas dá o canal). Sem o canal
 * anunciado vale o do servidor antigo, que só conhece `arca`.
 */
export function chatGroup(profile: MegamindProfileId, announced = true): string {
  const company = companyOf(profile);
  return company && announced ? company.group : CHAT_GROUP;
}

/**
 * Capabilities do servidor deste perfil e o canal de grupo que ele entende: a
 * empresa lê `capabilities.<canal dela>` e cai em `capabilities.arca`
 * (servidor antigo).
 */
export function serverProfile(capabilities: unknown, profile: MegamindProfileId): { server?: Record<string, unknown>; group: string; alias: string } {
  const alias = chatGroup(profile);
  const announced = alias === CHAT_GROUP ? undefined : namespace(capabilities, alias);
  const server = announced ?? namespace(capabilities, CHAT_GROUP);
  return {
    ...(server ? { server } : {}),
    group: chatGroup(profile, announced !== undefined),
    alias,
  };
}

function namespace(capabilities: unknown, name: string): Record<string, unknown> | undefined {
  if (!isRecord(capabilities)) return undefined;
  const value = capabilities[name];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** O grupo pelo nome do perfil (`#omni`) vira o canal que este servidor entende. */
export function groupAddress(to: string, group: string, alias: string): string {
  return to.trim().toLowerCase() === `#${alias}` ? `#${group}` : to;
}

/**
 * Recusa por causa do campo `idle`: servidor antigo, que valida a lista de
 * argumentos (contrato §2: chave desconhecida ⇒ `invalid_request`). Só isso
 * desliga o campo — falha de rede ou `rate_limited` não.
 */
export function rejectsIdleField(message: string): boolean {
  if (!rejectsValidation(message)) return false;
  return /\bidle\b/iu.test(message)
    || /unknown|unexpected|unrecognized|not allowed|desconhecid|invalid params|-32602/iu.test(message);
}

/** A recusa nomeia `idle`: com dois campos opcionais na chamada, só ela acusa o antigo. */
export function blamesIdleField(message: string): boolean {
  return rejectsValidation(message) && /\bidle\b/iu.test(message);
}

/**
 * Recusa de validação do contrato (`invalid_request` e seus apelidos). Só isso
 * desliga um campo opcional; falha de rede ou `rate_limited` não.
 */
export function rejectsValidation(message: string): boolean {
  return /invalid_request|invalid_params|invalid params|invalid argument|validação|validation|-32602/iu.test(message);
}

/** Tetos do contrato (§2/§3 do plano). */
export const LIMITS = {
  paths: 100,
  pathChars: 200,
  branchChars: 120,
  title: 200,
  body: 8 * 1024,
  result: 8 * 1024,
  summary: 500,
  detail: 4 * 1024,
  /** `chat_read.limit` (1..100, default 30). */
  chatRead: 100,
  chatReadDefault: 30,
  note: 120,
} as const;

/** Campos de resposta que a extensão lê (§2.1–2.9: lista é sempre `items`). */
export const FIELD = {
  items: "items",
  overlaps: "overlaps",
  nextCursor: "next_cursor",
} as const;

/** Endereço SSE derivado do endpoint MCP do enrollment. */
export function eventsUrl(endpoint: string): string {
  const { pathname } = new URL(endpoint);
  const derived = pathname.replace(/\/mcp\/*$/u, "/events");
  return new URL(derived === pathname ? EVENTS_PATH : derived, endpoint).toString();
}
