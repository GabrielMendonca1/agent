// peers: coordenação entre sessões do Pi **na mesma máquina** (IPC local).
// Nada de rede: outra máquina ou outro sócio é `megamind_*`.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { injectSlot } from "../lib/prompt-slot.ts";
import { MESSAGE_TYPE, Mesh, RECEIPT_TYPE, slotBlock, type IncomingMeta, type MeshOptions } from "./mesh.ts";
import { compactToolsEnabled, incomingComponent, receiptLine, type ToolTheme } from "./render.ts";
import { registerPeerTools } from "./tools.ts";

const EXIT_HOOK = Symbol.for("pi-peers.exit-hook");
const STATUS_KEY = "mark-meta-peers";

function hookExit(mesh: Mesh): void {
  const slot = globalThis as Record<symbol, { drop: () => void } | undefined>;
  const holder = slot[EXIT_HOOK];
  if (holder) {
    holder.drop = () => mesh.stop();
    return;
  }
  const fresh = { drop: () => mesh.stop() };
  slot[EXIT_HOOK] = fresh;
  process.once("exit", () => fresh.drop());
}

export default function (pi: ExtensionAPI, options: MeshOptions = {}) {
  const mesh = new Mesh(pi, options);
  hookExit(mesh);
  registerPeerTools(pi, mesh);

  let ui: ExtensionContext | null = null;

  /** Uma contagem no rodapé nativo; pedidos abertos têm texto e cor de alerta. */
  function paintStatus(): void {
    const ctx = ui;
    if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") return;
    ctx.ui.setStatus("peers", undefined); // limpa o indicador legado na linha de estado
    const theme = ctx.ui.theme;
    const others = mesh.peers().filter((peer) => !peer.self);
    if (others.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const open = mesh.openAskPeerIds();
    const pending = others.some((peer) => open.has(peer.id));
    const label = `${others.length} ${others.length === 1 ? "sessão" : "sessões"}`;
    ctx.ui.setStatus(STATUS_KEY, theme.fg(pending ? "error" : "muted", label + (pending ? " · pedido pendente" : "")));
  }

  if (compactToolsEnabled()) {
    // Mensagem que chega: cabeçalho com a origem e corpo com barra. O texto que
    // o modelo recebe continua sendo o bloco `[peers …]` cru.
    pi.registerMessageRenderer(MESSAGE_TYPE, (message: any, renderOptions: any, theme: any) => {
      const meta = message?.details as IncomingMeta | undefined;
      if (!meta?.kind) return undefined;
      return incomingComponent(theme as ToolTheme, meta, {
        expanded: renderOptions?.expanded === true,
        now: Date.now(),
      }) as never;
    });

    // Recibo de entrega: entrada durável (não entra no contexto do modelo),
    // uma linha apagada na TUI.
    pi.registerEntryRenderer(RECEIPT_TYPE, (entry: any, _options: any, theme: any) => {
      const line = receiptLine(theme as ToolTheme, (entry?.data ?? {}) as Record<string, string>);
      return { render: () => [line], invalidate: () => {} } as never;
    });
  }

  mesh.onReceipt = () => paintStatus();
  mesh.onAsksChanged = () => paintStatus();
  mesh.onPeersChanged = () => paintStatus();

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    ui = ctx;
    mesh.adopt(ctx);
    mesh.restoreQueue(ctx);
    mesh.startDrain();
    mesh.setStatus("idle");
    mesh.drain();
    paintStatus();
  });

  pi.on("agent_start", (_event, ctx: ExtensionContext) => {
    ui = ctx;
    mesh.adopt(ctx);
    mesh.setStatus("busy");
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    ui = ctx;
    mesh.adopt(ctx);
    if ((ctx as any)?.isIdle?.() !== true) return;
    mesh.setStatus("idle");
    mesh.drain();
    paintStatus();
  });

  pi.on("session_shutdown", () => {
    ui = null;
    mesh.shutdown();
  });

  pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
    ui = ctx;
    mesh.adopt(ctx);
    const prompt = typeof (event as any)?.prompt === "string" ? (event as any).prompt : "";
    if (prompt) mesh.noteSubject(prompt);
    const value = slotBlock(mesh.peers(), Date.now());
    const systemPrompt = injectSlot(event.systemPrompt, "PEERS", value ? { ...value } : null);
    if (systemPrompt === null) return;
    return { systemPrompt };
  });
}
