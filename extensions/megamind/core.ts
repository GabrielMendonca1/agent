// O núcleo do Megamind visto pelo cliente: hello, who, send, read, reply, bye.
// Este arquivo fala a v6 direto; `core-v5.ts` implementa a mesma interface sobre
// as tools antigas. Quem decide qual dos dois vale é `resolveCore`, pelo
// `capabilities.<empresa>.core` do `initialize`.
import { randomUUID } from "node:crypto";
import { CHAT_GROUP, CORE_V6, INBOX_KINDS, SESSION_UUID, TOOL, groupAddress, serverProfile, type InboxKind } from "./contract.ts";
import { megamindProfile } from "./profile.ts";
import {
  callGateway,
  checkedToolCall,
  gatewayError,
  object,
  optional,
  resultRecord,
  text,
  toolCall,
  type JsonObject,
} from "./gateway.ts";

/** Sessão de agente como `who` a devolve. */
export type CoreSession = {
  session_id: string;
  label?: string;
  project_id?: string;
  harness?: string;
  note?: string;
  branch?: string;
  /** `working` | `idle` | `closed`. */
  status?: string;
  last_seen?: string;
  /** Sessão do mesmo dispositivo que chamou: fala-se com ela por Peers. */
  same_device?: boolean;
  device_label?: string;
  at?: number;
};

export type CorePerson = { handle: string; name?: string; org_role?: string; app_online: boolean; sessions: CoreSession[] };

/** Contexto de org/repo devolvido pelo who do servidor novo. */
export type CoreWhoInfo = { org?: string; maintainers?: string[]; org_sync_error?: string };

/** Prioridade do projeto, só quando o projeto tem uma. */
export type CorePriority = { title: string; done: number; total: number; next?: string; blocked: string[] };

export type CoreHello = { session: unknown; handle?: string; priority?: CorePriority };

export type CoreFrom = { kind?: string; handle?: string; label?: string; session_id?: string; project_id?: string };

/** Item de `read`: uma mensagem, um pedido, o andamento de um pedido seu ou uma resposta. */
export type CoreItem = {
  id: string;
  kind: InboxKind;
  from: CoreFrom;
  to?: string;
  body?: string;
  ask?: { title?: string; status?: string };
  created_at?: string;
  /** Arquivos de uma mensagem do chat; baixados com megamind_fetch. */
  attachments?: CoreAttachment[];
  body_placeholder?: boolean;
  held?: true;
  held_reason?: string;
};

/** O servidor só marca posts retidos e só mostra a marca à conta autora. */
export function parseHeld(value: JsonObject): Pick<CoreItem, "held" | "held_reason"> {
  return value.held === true ? { held: true, ...optional(value, "held_reason") } : {};
}

export type CoreAttachment = { name: string; size?: number; mime?: string };

/** `attachments` do servidor, só com nome válido; ausente quando não há arquivo. */
export function parseAttachments(value: unknown): { attachments?: CoreAttachment[] } {
  const out: CoreAttachment[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!object(raw)) continue;
    const name = text(raw.name);
    if (!name) continue;
    const size = integer(raw.size);
    out.push({ name, ...(size !== undefined ? { size } : {}), ...optional(raw, "mime") });
  }
  return out.length > 0 ? { attachments: out } : {};
}

export type CoreTarget = { kind?: string; label?: string; handle?: string; session_id?: string };
export type CoreSent = { id?: string; to?: CoreTarget; woke: Array<{ session_id: string; label?: string }>; held: boolean };

export type HelloArgs = JsonObject & { session_id: string; project_id: string; harness: string; label: string; cwd?: string };
export type AskArgs = { title: string; ttl_hours?: number; project_id?: string };
export type SendArgs = { to: string; body: string; to_session?: string; ask?: AskArgs; reply_to?: string };
export type ReadArgs = { with?: string; since?: string; limit?: number };
export type InboxBatch = { items: CoreItem[]; cursor: string; discarded: number; malformed?: string[] };
export type ReplyArgs = { id: string; status: string; result?: string };

/** Candidato de um endereço ambíguo (`conflict`, §endereço do contrato). */
export type AddressCandidate = { session_id?: string; label?: string; owner?: string; status?: string };

/** Recusa do servidor com o código do contrato: o cliente decide o que dizer. */
export class CoreError extends Error {
  readonly code: string | undefined;
  readonly candidates: AddressCandidate[];

  constructor(message: string, code?: string, candidates: AddressCandidate[] = []) {
    super(message);
    this.code = code;
    this.candidates = candidates;
  }
}

export interface MegamindCore {
  /** 6 = núcleo novo; 5 = servidor antigo, atendido pelo adaptador. */
  readonly core: number;
  /** `true` quando a leitura da caixa ainda exige `acknowledge` (v5). */
  readonly acknowledges: boolean;
  /** Servidor anunciou `capabilities.<empresa>.direct_delivery`: aceita `to_session`. */
  readonly directDelivery: boolean;
  /** Servidor anunciou `capabilities.<empresa>.agent_last_prompt`: pode levar a prévia do prompt. */
  readonly lastPrompt: boolean;
  /** Canal de grupo deste servidor (`arca` no antigo, `omni` no Omni novo). */
  readonly group: string;
  /** Metadados opcionais da última consulta who (servidores com metadados de org). */
  readonly whoInfo?: CoreWhoInfo;
  hello(args: HelloArgs, signal?: AbortSignal): Promise<CoreHello>;
  who(project_id?: string, signal?: AbortSignal): Promise<CorePerson[]>;
  send(session_id: string, args: SendArgs, signal?: AbortSignal): Promise<CoreSent>;
  read(session_id: string, args: ReadArgs, signal?: AbortSignal): Promise<CoreItem[]>;
  readInbox?(session_id: string, cursor: string, limit: number, signal?: AbortSignal): Promise<InboxBatch | CoreItem[]>;
  reply(session_id: string, args: ReplyArgs, signal?: AbortSignal): Promise<{ handoff?: string }>;
  bye(session_id: string, args: { summary: string; branch?: string; paths?: string[] }, signal?: AbortSignal): Promise<void>;
  ack(session_id: string, ids: string[], signal?: AbortSignal): Promise<void>;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** `priority` do hello; ausente quando o projeto não tem prioridade nenhuma. */
export function parsePriority(value: unknown): CorePriority | undefined {
  if (!object(value)) return undefined;
  const title = text(value.title)?.trim();
  if (!title) return undefined;
  const blocked = Array.isArray(value.blocked)
    ? value.blocked.filter((item): item is string => typeof item === "string")
    : [];
  return {
    title,
    done: integer(value.done) ?? 0,
    total: integer(value.total) ?? 0,
    ...optional(value, "next"),
    blocked,
  };
}

export function parseSession(value: unknown, sessionDevice = false): CoreSession | undefined {
  if (!object(value)) return undefined;
  const session_id = text(value.session_id);
  if (!session_id) return undefined;
  const stamp = text(value.last_seen);
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  return {
    session_id,
    ...optional(value, "label"),
    ...(sessionDevice ? optional(value, "device_label") : {}),
    ...optional(value, "project_id"),
    ...optional(value, "harness"),
    ...optional(value, "note"),
    ...optional(value, "branch"),
    ...optional(value, "status"),
    ...optional(value, "last_seen"),
    ...(value.same_device === true ? { same_device: true } : {}),
    ...(Number.isFinite(at) ? { at } : {}),
  };
}

export function parsePeople(value: unknown, sessionDevice = false): CorePerson[] {
  const record = resultRecord(value);
  const people: CorePerson[] = [];
  for (const item of Array.isArray(record?.people) ? record.people : []) {
    if (!object(item)) continue;
    const handle = text(item.handle);
    if (!handle) continue;
    const sessions: CoreSession[] = [];
    for (const raw of Array.isArray(item.sessions) ? item.sessions : []) {
      const session = parseSession(raw, sessionDevice);
      if (session) sessions.push(session);
    }
    people.push({ handle, ...optional(item, "name"), ...optional(item, "org_role"), app_online: item.app_online === true, sessions });
  }
  return people;
}

const ITEM_KINDS: readonly string[] = INBOX_KINDS;
/** Id de registro do servidor (`^[a-z0-9]{15}$`); nunca truncado. */
const RECORD_ID = /^[a-z0-9]{1,64}$/u;

export function parseItem(value: unknown): CoreItem | undefined {
  if (!object(value)) return undefined;
  const kind = text(value.kind) ?? "";
  if (!ITEM_KINDS.includes(kind)) return undefined;
  const id = text(value.id)?.trim();
  if (!id || !RECORD_ID.test(id)) return undefined;
  const from = object(value.from) ? value.from : {};
  const ask = object(value.ask) ? { ...optional(value.ask, "title"), ...optional(value.ask, "status") } : undefined;
  return {
    id,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `kind` acabou de ser conferido contra ITEM_KINDS.
    kind: kind as CoreItem["kind"],
    from: { ...optional(from, "kind"), ...optional(from, "handle"), ...optional(from, "label"), ...optional(from, "session_id"), ...optional(from, "project_id") },
    ...optional(value, "to"),
    ...optional(value, "body"),
    ...(ask && (ask.title || ask.status) ? { ask } : {}),
    ...optional(value, "created_at"),
    ...parseAttachments(value.attachments),
    ...(value.body_placeholder === true ? { body_placeholder: true } : {}),
    ...(kind === "message" ? parseHeld(value) : {}),
  };
}

export function parseItems(value: unknown): CoreItem[] {
  const record = resultRecord(value);
  const items: CoreItem[] = [];
  for (const raw of Array.isArray(record?.items) ? record.items : []) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  return items;
}

export function parseSent(value: unknown): CoreSent {
  const record = resultRecord(value) ?? {};
  const woke: CoreSent["woke"] = [];
  for (const raw of Array.isArray(record.woke) ? record.woke : []) {
    if (!object(raw)) continue;
    const session_id = text(raw.session_id);
    if (session_id) woke.push({ session_id, ...optional(raw, "label") });
  }
  const target = object(record.to) ? record.to : undefined;
  return {
    ...optional(record, "id"),
    ...(target
      ? { to: { ...optional(target, "kind"), ...optional(target, "label"), ...optional(target, "handle"), ...optional(target, "session_id") } }
      : {}),
    woke,
    held: record.held === true || woke.length === 0,
  };
}

/** Candidatos de `conflict`: quem mais casou com o endereço. */
export function parseCandidates(detail: unknown): AddressCandidate[] {
  const list = object(detail) && Array.isArray(detail.candidates) ? detail.candidates : [];
  const candidates: AddressCandidate[] = [];
  for (const item of list) {
    if (!object(item)) continue;
    candidates.push({
      ...optional(item, "session_id"),
      ...optional(item, "label"),
      ...optional(item, "owner"),
      ...optional(item, "status"),
    });
  }
  return candidates;
}

/** Resultado recusado pelo servidor vira `CoreError` com código e candidatos. */
export function requireOk(name: string, result: unknown): unknown {
  const failure = gatewayError(result);
  if (!failure) return result;
  const message = [failure.code, failure.message].filter(Boolean).join(": ") || `${name} recusado pelo gateway`;
  throw new CoreError(message, failure.code, parseCandidates(failure.detail));
}

/** `project_id` é anunciado no schema de `request_create`, sem flag no initialize. */
export async function requestProject(project_id: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (!project_id) return undefined;
  const listing = await callGateway("tools/list", {}, signal).catch((error: unknown) => {
    if (error instanceof Error && error.message.endsWith("(-32601)")) return undefined;
    throw error;
  });
  if (object(listing) && Array.isArray(listing.tools) && listing.tools.some((tool) =>
    object(tool) && tool.name === TOOL.requestCreate && object(tool.inputSchema)
    && object(tool.inputSchema.properties) && object(tool.inputSchema.properties.project_id)
    && tool.inputSchema.properties.project_id.type === "string")) return project_id;
  return undefined;
}

/** Núcleo v6: cada chamada é uma tool do servidor, sem tradução. */
export class CoreV6 implements MegamindCore {
  readonly core = CORE_V6;
  readonly acknowledges = false;
  readonly directDelivery: boolean;
  readonly lastPrompt: boolean;
  readonly group: string;
  private readonly alias: string;
  private readonly inboxCursor: boolean;
  private readonly agentCwd: boolean;
  private readonly sessionDevice: boolean;
  whoInfo?: CoreWhoInfo;

  constructor(capabilities: Omit<CoreProbe, "core"> = {}) {
    this.inboxCursor = capabilities.inboxCursor === true;
    this.agentCwd = capabilities.agentCwd === true;
    this.sessionDevice = capabilities.sessionDevice === true;
    this.directDelivery = capabilities.directDelivery === true;
    this.lastPrompt = capabilities.lastPrompt === true;
    this.group = capabilities.group ?? CHAT_GROUP;
    this.alias = capabilities.alias ?? this.group;
  }

  async hello(args: HelloArgs, signal?: AbortSignal): Promise<CoreHello> {
    const { cwd, ...base } = args;
    const workingDir = cwd?.trim();
    const payload = this.agentCwd && workingDir !== undefined && !/\p{Cc}/u.test(workingDir) && [...workingDir].length <= 512
      ? { ...base, cwd: workingDir }
      : base;
    const record = resultRecord(await checkedToolCall(TOOL.hello, payload, signal)) ?? {};
    const you = object(record.you) ? record.you : undefined;
    const priority = parsePriority(record.priority);
    return {
      session: record.session,
      ...(you ? optional(you, "handle") : {}),
      ...(priority ? { priority } : {}),
    };
  }

  async who(project_id?: string, signal?: AbortSignal): Promise<CorePerson[]> {
    const result = await checkedToolCall(TOOL.who, project_id ? { project_id } : {}, signal);
    const record = resultRecord(result) ?? {};
    this.whoInfo = {
      ...optional(record, "org"),
      ...optional(record, "org_sync_error"),
      ...(Array.isArray(record.maintainers) ? { maintainers: record.maintainers.filter((v): v is string => typeof v === "string") } : {}),
    };
    return parsePeople(result, this.sessionDevice);
  }

  async send(session_id: string, args: SendArgs, signal?: AbortSignal): Promise<CoreSent> {
    const project_id = await requestProject(args.ask?.project_id, signal);
    const address = args.to.trim();
    const person = /^(?:@|actor:)/u.test(address);
    if (args.ask && (person || project_id)) {
      const to = SESSION_UUID.test(address) ? address.toLowerCase() : address;
      const record = resultRecord(requireOk(TOOL.requestCreate, await toolCall(TOOL.requestCreate, {
        from_session: session_id,
        to,
        title: args.ask.title,
        body: args.body,
        request_id: randomUUID(),
        ...(project_id ? { project_id } : {}),
      }, signal))) ?? {};
      const id = text(record.id) ?? text(record.message_id);
      return { ...(id ? { id } : {}), to: person ? { kind: "person", label: to } : { kind: "session", session_id: to }, woke: [], held: person };
    }
    if (args.to_session && !this.directDelivery) throw new CoreError("this Mainframe cannot deliver to a specific session yet");
    const payload: JsonObject = {
      session_id,
      to: groupAddress(args.to, this.group, this.alias),
      body: args.body,
      request_id: randomUUID(),
      ...(args.to_session && this.directDelivery ? { to_session: args.to_session } : {}),
      ...(args.reply_to ? { reply_to: args.reply_to } : {}),
      ...(args.ask ? { ask: { title: args.ask.title } } : {}),
    };
    return parseSent(requireOk(TOOL.conversation, await toolCall(TOOL.conversation, payload, signal)));
  }

  async read(session_id: string, args: ReadArgs, signal?: AbortSignal): Promise<CoreItem[]> {
    const payload: JsonObject = {
      session_id,
      ...(args.with ? { with: groupAddress(args.with, this.group, this.alias) } : {}),
      ...(args.since ? { since: args.since } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    };
    return parseItems(requireOk(TOOL.read, await toolCall(TOOL.read, payload, signal)));
  }

  async readInbox(session_id: string, cursor: string, limit: number, signal?: AbortSignal): Promise<InboxBatch | CoreItem[]> {
    if (!this.inboxCursor) return this.read(session_id, { limit }, signal);
    const result = requireOk(TOOL.read, await toolCall(TOOL.read, { session_id, cursor, limit }, signal));
    const record = resultRecord(result);
    if (!Array.isArray(record?.items) || record.items.length > limit
      || typeof record.cursor !== "string" || (record.items.length === 0) !== (record.cursor === "")) {
      throw new CoreError("malformed Megamind inbox batch");
    }
    const items: CoreItem[] = [];
    const malformed: string[] = [];
    let discarded = 0;
    for (const raw of record.items) {
      const kind = object(raw) ? text(raw.kind) : undefined;
      if (!kind || !ITEM_KINDS.includes(kind)) { discarded++; continue; } // inclui decision legada
      const item = parseItem(raw);
      // O recibo é do lote inteiro: avise e pule itens inválidos para não travar a caixa.
      if (!item) malformed.push(`${kind} (id ${object(raw) && Object.hasOwn(raw, "id") ? "present" : "missing"})`);
      else items.push(item);
    }
    return { items, cursor: record.cursor, discarded, malformed };
  }

  async reply(session_id: string, args: ReplyArgs, signal?: AbortSignal): Promise<{ handoff?: string }> {
    const payload: JsonObject = { session_id, id: args.id, status: args.status, ...(args.result ? { result: args.result } : {}) };
    const record = resultRecord(requireOk(TOOL.reply, await toolCall(TOOL.reply, payload, signal)));
    const handoff = record ? text(record.handoff_id) : undefined;
    return handoff ? { handoff } : {};
  }

  async bye(session_id: string, args: { summary: string; branch?: string; paths?: string[] }, signal?: AbortSignal): Promise<void> {
    await toolCall(TOOL.bye, {
      session_id,
      summary: args.summary,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.paths ? { paths: args.paths } : {}),
    }, signal);
  }

  async ack(): Promise<void> {
    // A v6 confirma no `read` (via recibo ou auto-ack), nunca por ID.
  }
}

/** O que o `initialize` revela: a versão do núcleo e os campos opcionais. */
export type CoreProbe = { core?: number; lastPrompt?: boolean; directDelivery?: boolean; inboxCursor?: boolean; agentCwd?: boolean; sessionDevice?: boolean; group?: string; alias?: string };

/** `capabilities.<empresa>.core` e `serverInfo` do `initialize`. */
export async function probeCore(signal?: AbortSignal): Promise<CoreProbe> {
  const result = await callGateway("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "arca-megamind-pi", version: "6" },
  }, signal);
  const record = object(result) ? result : undefined;
  const capabilities = record && object(record.capabilities) ? record.capabilities : undefined;
  const { server, group, alias } = serverProfile(capabilities, megamindProfile().id);
  const info = record && object(record.serverInfo) ? record.serverInfo : undefined;
  const core = server ? integer(server.core) : undefined;
  // Servidor antigo não anuncia os campos opcionais e pode recusar o argumento desconhecido.
  const optionalCapabilities = {
    lastPrompt: server?.agent_last_prompt === true,
    directDelivery: server?.direct_delivery === true,
    inboxCursor: server?.inbox_cursor === true,
    agentCwd: server?.agent_cwd === true,
    sessionDevice: server?.session_device === true,
  };
  if (core !== undefined) return { core, group, alias, ...optionalCapabilities };
  const version = info ? Number.parseInt(text(info.version) ?? "", 10) : Number.NaN;
  return { ...(Number.isFinite(version) ? { core: version } : {}), group, alias, ...optionalCapabilities };
}

let cached: Promise<MegamindCore> | undefined;

/** O núcleo desta sessão: v6 quando o servidor o anuncia, senão o adaptador v5. */
export async function resolveCore(signal?: AbortSignal, requireProbe = false): Promise<MegamindCore> {
  const pending = cached ??= (async () => {
    const probe = await probeCore(signal);
    if (probe.core !== undefined && probe.core >= CORE_V6) return new CoreV6(probe);
    const { CoreV5 } = await import("./core-v5.ts");
    return new CoreV5(probe);
  })();
  try {
    return await pending;
  } catch (error) {
    if (cached === pending) cached = undefined;
    // Falha transitória não autoriza ler a caixa por um protocolo que confirma por ID.
    if (requireProbe && !(error instanceof Error && error.message.endsWith("(-32601)"))) throw error;
    const names = serverProfile(undefined, megamindProfile().id);
    const { CoreV5 } = await import("./core-v5.ts");
    return new CoreV5(names);
  }
}

/** Esquece o núcleo detectado (fim de sessão e testes). */
export function resetCore(): void {
  cached = undefined;
}
