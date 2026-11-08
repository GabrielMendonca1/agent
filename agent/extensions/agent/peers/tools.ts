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
      "Outras sessões do Pi nesta mesma máquina: short6, projeto, branch, cwd, ociosa/ocupada, no que estão e há quanto tempo. Outra máquina ou outro sócio é megamind_who",
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
      "Manda uma mensagem para outra sessão do Pi nesta máquina (short6 do peers_list ou id completo) e devolve o id dela. Ela lê quando ficar ociosa; quem recebe decide o que fazer. `reply_to` encadeia a conversa. Sem segredo, sem código em massa",
    parameters: Type.Object({
      to: Type.String({ description: "short6 (peers_list) ou id completo da sessão" }),
      body: Type.String({ description: "mensagem curta e completa; até 8 KB" }),
      reply_to: Type.Optional(Type.String({ description: "id (p-xxxxxxxx) de uma mensagem/pedido que você recebeu; liga a conversa" })),
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
      "Pede algo a outra sessão desta máquina e acompanha: vira um pedido com id que ela responde com peers_reply (accepted/declined, depois done/failed). Volta na hora — a resposta chega sozinha nesta sessão",
    parameters: Type.Object({
      to: Type.String({ description: "short6 (peers_list) ou id completo da sessão que deve fazer o trabalho" }),
      title: Type.String({ description: "uma linha dizendo o que precisa (até 200 chars)" }),
      body: Type.String({ description: "contexto, critério de pronto e limites; até 8 KB, sem segredo" }),
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
      "Responde um pedido que chegou pelo peers (bloco [peers PEDIDO <id> …]): aceita, recusa ou informa pronto/falhou com o resumo do que foi feito",
    parameters: Type.Object({
      id: Type.String({ description: "id do pedido recebido (p-xxxxxxxx)" }),
      status: Type.String({ description: REPLY_STATUS.join(" | ") }),
      result: Type.Optional(Type.String({ description: "resumo do que foi feito ou motivo da recusa (obrigatório em declined/done/failed)" })),
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
      "Lê um recorte recente do transcrito de outra sessão desta máquina (só leitura, não interrompe ninguém). Use antes de perguntar o óbvio",
    parameters: Type.Object({
      to: Type.String({ description: "short6 (peers_list) ou id completo da sessão" }),
      chars: Type.Optional(
        Type.Number({ description: `teto de caracteres (1..${CONTEXT_MAX_CHARS}, default ${CONTEXT_DEFAULT_CHARS})` }),
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
    description: "Diz numa linha no que esta sessão está trabalhando; as outras sessões desta máquina veem no peers_list",
    parameters: Type.Object({
      note: Type.String({ description: "resumo curto (até 120 chars); string vazia limpa" }),
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
