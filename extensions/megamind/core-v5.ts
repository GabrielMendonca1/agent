// Servidor sem o núcleo v6 (`capabilities.<empresa>.core` ausente ou < 6): as mesmas
// seis chamadas, montadas sobre as tools v5. As cinco tools do agente não mudam;
// o que muda é o que sai daqui para o gateway.
import { randomUUID } from "node:crypto";
import { CHAT_GROUP, TOOL } from "./contract.ts";
import {
  CoreError,
  parseAttachments,
  parsePriority,
  requireOk,
  type CoreHello,
  type CoreItem,
  type CorePerson,
  type CoreSent,
  type CoreSession,
  type HelloArgs,
  type MegamindCore,
  type ReadArgs,
  type ReplyArgs,
  type SendArgs,
} from "./core.ts";
import {
  checkedToolCall,
  object,
  optional,
  resultList,
  resultRecord,
  text,
  toolCall,
  type JsonObject,
} from "./gateway.ts";

/** Endereço que a v5 entende sem ajuda: sessão, dispositivo ou pessoa. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Kind = "channel" | "person" | "session";
type Target = { kind: Kind; address: string };

/**
 * Endereço do agente → endereço da v5. O servidor antigo não resolve prefixo,
 * rótulo nem nome: o que ele não entende vira `not_found` com a saída (o id
 * completo aparece em `megamind_who`).
 */
export function targetOf(to: string, group = CHAT_GROUP, alias = group): Target {
  const value = to.trim();
  if (value.startsWith("#")) {
    const channel = value.slice(1).toLowerCase();
    if (channel !== group && channel !== alias) throw new CoreError(`not_found: the only channel is #${alias}`, "not_found");
    return { kind: "channel", address: group };
  }
  if (value.startsWith("@")) return { kind: "person", address: value.slice(1).toLowerCase() };
  if (value.startsWith("actor:")) return { kind: "person", address: value };
  if (UUID.test(value) || value.startsWith("device:")) return { kind: "session", address: value };
  throw new CoreError(
    `not_found: this Mainframe is still v5 and cannot resolve "${value}"; use the full session id (megamind_who), @handle or #${alias}`,
    "not_found",
  );
}

/** `list_agents` → sessão, com o device para saber se é desta máquina. */
function sessionOf(value: unknown): (CoreSession & { device_id?: string; owner_name?: string; handle?: string }) | undefined {
  if (!object(value)) return undefined;
  const session_id = text(value.session_id);
  if (!session_id) return undefined;
  const stamp = text(value.last_seen);
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  const status = text(value.status);
  return {
    session_id,
    ...optional(value, "label"),
    ...optional(value, "project_id"),
    ...optional(value, "harness"),
    ...optional(value, "note"),
    ...optional(value, "branch"),
    ...optional(value, "owner_name"),
    ...optional(value, "handle"),
    ...optional(value, "device_id"),
    ...optional(value, "last_seen"),
    // `active`/`idle`/`recent` da v5 no vocabulário da v6.
    ...(status ? { status: status === "active" ? "working" : status === "idle" ? "idle" : "closed" } : {}),
    ...(Number.isFinite(at) ? { at } : {}),
  };
}

/** Item da inbox v5 no formato da v6 (`message` | `ask` | `reply`). */
export function itemOf(entry: unknown): CoreItem | undefined {
  if (!object(entry)) return undefined;
  const id = text(entry.id) ?? text(entry.message_id);
  if (!id) return undefined;
  const kind = text(entry.kind) ?? "message";
  const label = text(entry.from_label) ?? text(entry.author_label);
  const handle = text(entry.from_owner_name) ?? text(entry.author_name);
  const session = text(entry.from_session) ?? text(entry.author_session) ?? text(entry.handled_by_session);
  const from = {
    kind: text(entry.author_kind) ?? "agent",
    ...(handle ? { handle } : {}),
    ...(label ? { label } : {}),
    ...(session ? { session_id: session } : {}),
  };
  const created = optional(entry, "created_at");
  if (kind === "message" || kind === "chat") {
    const body = text(entry.body);
    if (body === undefined) return undefined;
    return { id, kind: "message", from, body, ...created };
  }
  if (kind === "request") {
    return {
      id,
      kind: "ask",
      from,
      ...optional(entry, "body"),
      ask: { ...optional(entry, "title"), ...optional(entry, "status") },
      ...created,
    };
  }
  if (kind === "request_update") {
    return {
      id: text(entry.request) ?? id,
      kind: "reply",
      from,
      body: text(entry.result) ?? text(entry.body) ?? "",
      ask: { ...optional(entry, "title"), ...optional(entry, "status") },
      ...created,
    };
  }
  return undefined;
}

/** Uma linha de `chat_read` como item de conversa. */
function chatItemOf(raw: unknown): CoreItem | undefined {
  if (!object(raw)) return undefined;
  const id = text(raw.id) ?? text(raw.message_id);
  const body = text(raw.body);
  if (!id || body === undefined) return undefined;
  const author = text(raw.author_name);
  return {
    id,
    kind: "message",
    from: { kind: text(raw.author_kind) ?? "human", ...(author ? { handle: author } : {}) },
    body,
    ...optional(raw, "created_at"),
    ...parseAttachments(raw.attachments),
  };
}

export class CoreV5 implements MegamindCore {
  readonly core = 5;
  readonly directDelivery = false;
  readonly acknowledges = true;
  readonly lastPrompt: boolean;
  readonly group: string;
  private readonly alias: string;
  /** Dispositivo desta sessão: a v5 não marca `same_device`, o cliente compara. */
  private device = "";

  constructor(capabilities: { lastPrompt?: boolean; group?: string; alias?: string } = {}) {
    this.lastPrompt = capabilities.lastPrompt === true;
    this.group = capabilities.group ?? CHAT_GROUP;
    this.alias = capabilities.alias ?? this.group;
  }

  async hello(args: HelloArgs, signal?: AbortSignal): Promise<CoreHello> {
    const session = await checkedToolCall(TOOL.register, args, signal);
    const record = resultRecord(session);
    const device = record ? text(record.device_id) : undefined;
    if (device) this.device = device;
    const [handle, priority] = await Promise.all([
      this.handleOf(text(args.session_id) ?? "", signal),
      this.priorityOf(text(args.project_id) ?? "", signal),
    ]);
    return { session, ...(handle ? { handle } : {}), ...(priority ? { priority } : {}) };
  }

  /** Handle do dono: só `chat_members` o revela na v5. */
  private async handleOf(session_id: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const people = await this.members(signal);
      return people.find((person) => person.sessions.some((item) => item.session_id === session_id))?.handle;
    } catch {
      return undefined;
    }
  }

  /** Prioridade do projeto por `priorities_list`, na forma que o hello devolve. */
  private async priorityOf(project_id: string, signal?: AbortSignal) {
    if (!project_id) return undefined;
    try {
      const projects = resultRecord(await checkedToolCall(TOOL.prioritiesList, {}, signal))?.projects;
      for (const item of Array.isArray(projects) ? projects : []) {
        if (!object(item) || text(item.project_id) !== project_id) continue;
        const queue = Array.isArray(item.queue) ? item.queue : [];
        const next = object(queue[0]) ? text(queue[0].title) : undefined;
        const blocked = (Array.isArray(item.blocked) ? item.blocked : [])
          .map((entry) => (object(entry) ? text(entry.text) : undefined))
          .filter((entry): entry is string => Boolean(entry));
        return parsePriority({ ...item, ...(next ? { next } : {}), blocked });
      }
    } catch {
      // sem prioridade não há o que mostrar
    }
    return undefined;
  }

  /** `chat_members` no formato de `who`. */
  private async members(signal?: AbortSignal): Promise<CorePerson[]> {
    const record = resultRecord(await checkedToolCall(TOOL.chatMembers, {}, signal));
    if (!record || !Array.isArray(record.items)) throw new CoreError("not_found: server has no chat_members", "not_found");
    const people: CorePerson[] = [];
    for (const item of record.items) {
      if (!object(item)) continue;
      const handle = text(item.handle);
      if (!handle) continue;
      const sessions: CoreSession[] = [];
      for (const raw of Array.isArray(item.sessions) ? item.sessions : []) {
        const session = sessionOf(raw);
        if (!session) continue;
        const project = session.project_id ?? (object(raw) ? text(raw.project) : undefined);
        sessions.push({ ...session, ...(project ? { project_id: project } : {}) });
      }
      people.push({
        handle,
        ...optional(item, "name"),
        app_online: item.app_online === true || item.online === true,
        sessions,
      });
    }
    return people;
  }

  async who(project_id?: string, signal?: AbortSignal): Promise<CorePerson[]> {
    const agents = resultList(await checkedToolCall(TOOL.agents, project_id ? { project_id } : {}, signal))
      .map(sessionOf)
      .filter((session): session is NonNullable<ReturnType<typeof sessionOf>> => session !== undefined);
    const devices = new Map(agents.map((session) => [session.session_id, session.device_id]));
    let people: CorePerson[];
    try {
      people = await this.members(signal);
    } catch {
      // Servidor v4 (sem chat): cada dono vira uma "pessoa" com as sessões dele.
      const byOwner = new Map<string, CorePerson>();
      for (const session of agents) {
        const handle = session.handle ?? session.owner_name ?? "sócio";
        const person = byOwner.get(handle) ?? { handle, app_online: false, sessions: [] };
        person.sessions.push(session);
        byOwner.set(handle, person);
      }
      people = [...byOwner.values()];
    }
    return people.map((person) => ({
      ...person,
      sessions: person.sessions
        .filter((session) => !project_id || session.project_id === project_id)
        .map((session) => {
          const device = devices.get(session.session_id);
          return { ...session, ...(this.device && device === this.device ? { same_device: true } : {}) };
        }),
    }));
  }

  async send(session_id: string, args: SendArgs, signal?: AbortSignal): Promise<CoreSent> {
    const target = targetOf(args.to, this.group, this.alias);
    const request_id = randomUUID();
    if (args.ask) {
      if (target.kind === "channel") throw new CoreError("invalid_request: a channel cannot answer a request", "invalid_request");
      const created = requireOk(TOOL.requestCreate, await toolCall(TOOL.requestCreate, {
        from_session: session_id,
        to: target.kind === "person" ? args.to.trim() : target.address,
        title: args.ask.title,
        body: args.body,
        request_id,
      }, signal));
      return { ...this.idOf(created), to: target.kind === "person" ? { kind: "person", label: args.to.trim() } : { kind: "session", session_id: target.address }, woke: [], held: target.kind === "person" };
    }
    if (target.kind === "channel" || target.kind === "person") {
      const posted = requireOk(TOOL.chatPost, await toolCall(TOOL.chatPost, {
        session_id,
        to: target.address,
        body: args.body,
        request_id,
      }, signal));
      const record = resultRecord(posted) ?? {};
      const woke: CoreSent["woke"] = [];
      for (const entry of Array.isArray(record.woken) ? record.woken : []) {
        if (!object(entry)) continue;
        const woken = text(entry.session_id);
        if (woken) woke.push({ session_id: woken, ...optional(entry, "label") });
      }
      return {
        ...(text(record.message_id) ? { id: text(record.message_id)! } : {}),
        to: { kind: target.kind, label: `${target.kind === "channel" ? "#" : "@"}${target.address}` },
        woke,
        held: woke.length === 0,
      };
    }
    const sent = requireOk(TOOL.send, await toolCall(TOOL.send, {
      from_session: session_id,
      to: target.address,
      body: args.body,
      request_id,
      ...(args.reply_to ? { reply_to: args.reply_to } : {}),
    }, signal));
    return { ...this.idOf(sent), to: { kind: "session", session_id: target.address }, woke: [], held: false };
  }

  private idOf(result: unknown): { id?: string } {
    const record = resultRecord(result) ?? {};
    const id = text(record.id) ?? text(record.message_id);
    return id ? { id } : {};
  }

  async read(session_id: string, args: ReadArgs, signal?: AbortSignal): Promise<CoreItem[]> {
    if (args.with) {
      const target = targetOf(args.with, this.group, this.alias);
      if (target.kind === "session") {
        throw new CoreError("invalid_request: this Mainframe is v5 and cannot read a conversation with one session; read the inbox without `with`", "invalid_request");
      }
      const payload: JsonObject = {
        session_id,
        channel: target.address,
        limit: args.limit ?? LIMITS.chatReadDefault,
        ...(args.since ? { since: args.since } : {}),
      };
      const items = resultList(requireOk(TOOL.chatRead, await toolCall(TOOL.chatRead, payload, signal)));
      return items.map(chatItemOf).filter((item): item is CoreItem => item !== undefined);
    }
    const inbox = requireOk(TOOL.inbox, await toolCall(TOOL.inbox, { session_id }, signal));
    return resultList(inbox).map(itemOf).filter((item): item is CoreItem => item !== undefined);
  }

  async reply(session_id: string, args: ReplyArgs, signal?: AbortSignal): Promise<{ handoff?: string }> {
    const updated = requireOk(TOOL.requestUpdate, await toolCall(TOOL.requestUpdate, {
      session_id,
      id: args.id,
      status: args.status,
      ...(args.result ? { result: args.result } : {}),
    }, signal));
    const handoff = text(resultRecord(updated)?.handoff_id);
    return handoff ? { handoff } : {};
  }

  async bye(session_id: string, args: { summary: string; branch?: string; paths?: string[] }, signal?: AbortSignal): Promise<void> {
    await toolCall(TOOL.handoff, {
      session_id,
      summary: args.summary,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.paths ? { paths: args.paths } : {}),
    }, signal);
  }

  async ack(session_id: string, ids: string[], signal?: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    await checkedToolCall(TOOL.acknowledge, { session_id, ids }, signal);
  }
}
