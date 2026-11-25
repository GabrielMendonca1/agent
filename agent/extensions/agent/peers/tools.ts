// As tools que o modelo enxerga. Tudo aqui é da **mesma máquina**: outra
// máquina/outro sócio é `megamind_*`. O contrato espelha o Megamind
// (send/ask/reply com id), para o agente aprender um modelo só.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_DEFAULT_CHARS,
  CONTEXT_MAX_CHARS,
  REPLY_STATUS,
  formatPeers,
  type Mesh,
} from "./mesh.ts";
import {
  compactToolsEnabled,
  emptyComponent,
  firstMeaningfulLine,
  peersComponent,
  resultText,
  type PeersCard,
  type PeersStatus,
  type ToolTheme,
} from "./render.ts";

export interface PeerToolDetails {
  ok: boolean;
  op: "list" | "send" | "ask" | "reply" | "context" | "status";
  id?: string;
  to?: string;
  project?: string;
  branch?: string;
  title?: string;
  status?: string;
  chars?: number;
  summary?: string;
}

function result(text: string, ok: boolean, details: PeerToolDetails) {
  return { content: [{ type: "text" as const, text }], details: { ...details, ok } };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const OK: PeersStatus = { tone: "success", glyph: "✓" };

function errorStatus(text: string): PeersStatus {
  return { tone: "error", glyph: "✗", text: firstMeaningfulLine(text).replace(/^peers_\w+:\s*/, "") };
}

/** Card de cada tool a partir do `details` do resultado (puro, testável). */
export function cardFor(details: PeerToolDetails | undefined, output: string, running = false): PeersCard {
  const d = details ?? ({ ok: false, op: "send" } as PeerToolDetails);
  const where = `${d.project ?? ""}${d.branch ? `@${d.branch}` : ""}`.trim();
  const status: PeersStatus = running
    ? { tone: "muted", glyph: "…", text: "indo" }
    : d.ok
      ? OK
      : errorStatus(output);
  if (d.op === "send") {
    return {
      op: "→",
      target: d.to,
      detail: [where, d.summary ? `"${d.summary}"` : ""].filter(Boolean).join("  "),
      status: d.ok ? { ...OK, text: "na fila" } : status,
    };
  }
  if (d.op === "ask") {
    return {
      op: "⧗ pedido →",
      target: d.to,
      detail: d.title ? `· ${d.title}` : "",
      status: d.ok ? { tone: "warning", text: "aguardando" } : status,
    };
  }
  if (d.op === "reply") {
    return {
      op: d.ok ? "✓ resposta" : "resposta",
      target: d.id,
      detail: d.status ?? "",
      status: d.ok ? { tone: "success" } : status,
    };
  }
  if (d.op === "context") {
    return {
      op: "contexto",
      target: d.to,
      detail: [where, d.chars ? `· ${d.chars} chars` : ""].filter(Boolean).join(" "),
      status,
    };
  }
  if (d.op === "list") return { op: "lista", detail: d.summary ?? "", status };
  return { op: "nota", detail: d.summary ? `"${d.summary}"` : "", status };
}

/** Rendering compacto: uma linha recolhida, corpo inteiro no ctrl+o. */
function renderers(op: PeerToolDetails["op"], summaryOf: (args: any) => Partial<PeerToolDetails>) {
  if (!compactToolsEnabled()) return {};
  return {
    renderCall(args: any, theme: any, context: { isPartial: boolean }) {
      if (!context.isPartial) return emptyComponent() as never;
      return peersComponent(theme as ToolTheme, cardFor({ ok: true, op, ...summaryOf(args) } as PeerToolDetails, "", true)) as never;
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: { isError: boolean }) {
      if (options.isPartial) return emptyComponent() as never;
      const output = resultText(result);
      const details = { ...(result?.details as PeerToolDetails | undefined), ok: !context.isError && result?.details?.ok !== false };
      return peersComponent(theme as ToolTheme, {
        ...cardFor(details as PeerToolDetails, output),
        expanded: options.expanded,
        expandedBlocks: [{ tone: details.ok ? "toolOutput" : "error", text: output }],
      }) as never;
    },
  };
}

export function registerPeerTools(pi: ExtensionAPI, mesh: Mesh): void {
  pi.registerTool({
    exposure: "deferred",
    name: "peers_list",
    label: "Peers List",
    description:
      "Other Pi sessions on this machine: short6, project, branch, cwd, idle/busy, what they are doing and for how long. For another machine or partner use megamind_who",
    parameters: Type.Object({}),
    execute: () => {
      const peers = mesh.peers();
      const others = peers.filter((peer) => !peer.self);
      const busy = others.filter((peer) => peer.status === "busy").length;
      const sent = mesh.outgoing();
      return result(formatPeers(peers, Date.now(), sent), true, {
        ok: true,
        op: "list",
        summary: `${others.length} ${others.length === 1 ? "sessão" : "sessões"} · ${busy} ${busy === 1 ? "ocupada" : "ocupadas"}`,
      });
    },
    ...renderers("list", () => ({})),
  });

  pi.registerTool({
    exposure: "deferred",
    name: "peers_send",
    label: "Peers Send",
    description:
      "Send a message to another Pi session on this machine (short6 from peers_list or full id) and return its id. The session reads it when idle; the recipient decides what to do. `reply_to` threads the conversation. No secrets, no bulk code",
    parameters: Type.Object({
      to: Type.String({ description: "short6 (peers_list) or full session id" }),
      body: Type.String({ description: "short, complete message; up to 8 KB" }),
      reply_to: Type.Optional(Type.String({ description: "id (p-xxxxxxxx) of a message/request you received; threads the conversation" })),
    }),
    async execute(_id, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const sent = await mesh.send(str(args.to), args.body, str(args.reply_to) || undefined);
      return result(sent.text, sent.ok, {
        ok: sent.ok,
        op: "send",
        id: sent.id,
        to: sent.peer?.short ?? str(args.to),
        project: sent.peer?.project,
        branch: sent.peer?.branch,
        summary: firstMeaningfulLine(str(args.body)),
      });
    },
    ...renderers("send", (args) => ({ to: str(args?.to), summary: firstMeaningfulLine(str(args?.body)) })),
  });

  pi.registerTool({
    exposure: "deferred",
    name: "peers_ask",
    label: "Peers Ask",
    description:
      "Ask another session on this machine for something and track it: it becomes a request with an id that the session answers with peers_reply (accepted/declined, then done/failed). Returns immediately; the answer arrives in this session on its own",
    parameters: Type.Object({
      to: Type.String({ description: "short6 (peers_list) or full id of the session that should do the work" }),
      title: Type.String({ description: "one line saying what you need (up to 200 chars)" }),
      body: Type.String({ description: "context, done criteria and limits; up to 8 KB, no secrets" }),
    }),
    async execute(_id, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const asked = await mesh.ask(str(args.to), args.title, args.body);
      return result(asked.text, asked.ok, {
        ok: asked.ok,
        op: "ask",
        id: asked.id,
        to: asked.peer?.short ?? str(args.to),
        project: asked.peer?.project,
        branch: asked.peer?.branch,
        title: asked.title ?? firstMeaningfulLine(str(args.title)),
      });
    },
    ...renderers("ask", (args) => ({ to: str(args?.to), title: firstMeaningfulLine(str(args?.title)) })),
  });

  pi.registerTool({
    exposure: "deferred",
    name: "peers_reply",
    label: "Peers Reply",
    description:
      "Answer a request received through peers (block [peers REQUEST <id> …]): accept, decline, or report done/failed with a summary of what was done",
    parameters: Type.Object({
      id: Type.String({ description: "id of the received request (p-xxxxxxxx)" }),
      status: Type.String({ description: REPLY_STATUS.join(" | ") }),
      result: Type.Optional(Type.String({ description: "summary of what was done or reason for declining (required for declined/done/failed)" })),
    }),
    async execute(_id, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const replied = await mesh.reply(str(args.id), str(args.status), args.result);
      return result(replied.text, replied.ok, {
        ok: replied.ok,
        op: "reply",
        id: replied.id ?? str(args.id),
        status: replied.status ?? str(args.status),
      });
    },
    ...renderers("reply", (args) => ({ id: str(args?.id), status: str(args?.status) })),
  });

  pi.registerTool({
    exposure: "deferred",
    name: "peers_context",
    label: "Peers Context",
    description:
      "Read a recent slice of another session's transcript on this machine (read-only, interrupts no one). Use it before asking the obvious",
    parameters: Type.Object({
      to: Type.String({ description: "short6 (peers_list) or full session id" }),
      chars: Type.Optional(
        Type.Number({ description: `character cap (1..${CONTEXT_MAX_CHARS}, default ${CONTEXT_DEFAULT_CHARS})` }),
      ),
    }),
    async execute(_id, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const read = await mesh.context(str(args.to), typeof args.chars === "number" ? args.chars : undefined);
      return result(read.text, read.ok, {
        ok: read.ok,
        op: "context",
        to: read.peer?.short ?? str(args.to),
        project: read.peer?.project,
        branch: read.peer?.branch,
        chars: read.chars,
      });
    },
    ...renderers("context", (args) => ({ to: str(args?.to) })),
  });

  pi.registerTool({
    exposure: "deferred",
    name: "peers_status",
    label: "Peers Status",
    description: "Say in one line what this session is working on; other sessions on this machine see it in peers_list",
    parameters: Type.Object({
      note: Type.String({ description: "short summary (up to 120 chars); an empty string clears it" }),
    }),
    execute(_id, params) {
      const note = str(((params ?? {}) as Record<string, unknown>).note);
      mesh.setNote(note);
      return result(mesh.note ? `nota desta sessão: ${mesh.note}` : "nota desta sessão limpa", true, {
        ok: true,
        op: "status",
        summary: mesh.note,
      });
    },
    ...renderers("status", (args) => ({ summary: firstMeaningfulLine(str(args?.note)) })),
  });
}
