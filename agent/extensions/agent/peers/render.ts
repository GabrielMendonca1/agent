/**
 * Desenho do peers na TUI: cada tool call vira UMA linha recolhida
 *
 *   󰚩 peers → 7c2e91 arca@main  "terminei o port"            ✓ na fila
 *
 * e ctrl+o abre o corpo inteiro com barra lateral. A mensagem que chega ganha
 * cabeçalho com a origem; o texto que o **modelo** recebe continua sendo o
 * bloco `[peers …]` do mesh — aqui só muda a tela.
 *
 * As funções são puras (largura entra, linhas saem): os testes medem o
 * recolhido em 60 e 120 colunas. `ARCA_COMPACT_TOOLS=0` desliga tudo e devolve
 * o renderer padrão do Pi. Os helpers abaixo mantêm os cards compactos de coordenação.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ageOf, type IncomingMeta } from "./mesh.ts";

export const GLYPH = "\u{F06A9}"; // Nerd Fonts md-robot (󰚩)
const INDENT = " ";
const BAR = "│ ";

export interface ToolTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface Renderable {
  render(width: number): string[];
  invalidate(): void;
}

class Lines implements Renderable {
  constructor(private readonly build: (width: number) => string[]) {}
  render(width: number): string[] {
    return this.build(width);
  }
  invalidate(): void {}
}

/** Componente sem altura: a outra metade (call/result) já desenhou a linha. */
export const emptyComponent = (): Renderable => new Lines(() => []);

export function compactToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARCA_COMPACT_TOOLS !== "0";
}

export function firstMeaningfulLine(source: string): string {
  for (const line of String(source ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export interface PeersStatus {
  tone: "success" | "error" | "warning" | "muted";
  glyph?: string;
  text?: string;
}

export interface PeersCard {
  /** Verbo da chamada: `→`, `⧗ pedido →`, `contexto`, `lista`, `nota`… */
  op: string;
  /** Short6 do par (destacado). */
  target?: string;
  /** Resto em tom apagado: projeto@branch, primeira linha, contagem… */
  detail?: string;
  status: PeersStatus;
  expanded?: boolean;
  expandedBlocks?: Array<{ tone: string; text: string }>;
}

function statusWidth(status: PeersStatus): number {
  const glyph = status.glyph ? visibleWidth(status.glyph) : 0;
  const text = status.text ? visibleWidth(status.text) : 0;
  return glyph + text + (glyph && text ? 1 : 0);
}

function styleStatus(theme: ToolTheme, status: PeersStatus, text: string | undefined): string {
  const glyph = status.glyph ? theme.fg(status.tone, status.glyph) : "";
  if (!text) return glyph;
  const styled = theme.fg(status.tone === "error" ? "error" : "muted", text);
  return glyph ? `${glyph} ${styled}` : styled;
}

/**
 * Linha recolhida. Garante `visibleWidth(linha) <= width` em qualquer largura:
 * sacrifica primeiro o detalhe, depois o alvo, por último o texto do status.
 */
export function peersLine(width: number, theme: ToolTheme, card: PeersCard): string {
  const avail = Math.max(0, width - INDENT.length);
  if (avail <= 0) return "";

  const head = `${GLYPH} peers`;
  const headWidth = visibleWidth(head);
  const styledHead = `${theme.fg("accent", GLYPH)} ${theme.fg("toolTitle", theme.bold("peers"))}`;
  if (headWidth >= avail) return INDENT + theme.fg("toolTitle", truncateToWidth(head, avail, "…"));

  const rest = avail - headWidth;
  let statusText = card.status.text;
  let used = statusWidth({ ...card.status, text: statusText });
  if (rest < used + 1) {
    const room = rest - 1 - (card.status.glyph ? visibleWidth(card.status.glyph) + 1 : 0);
    statusText = room >= 4 && statusText ? truncateToWidth(statusText, room, "…") : undefined;
    used = statusWidth({ ...card.status, text: statusText });
    if (rest < used + 1) {
      statusText = undefined;
      used = 0;
    }
  }

  const summarySpace = rest - used - (used ? 1 : 0) - 1;
  const parts: Array<{ text: string; style: (value: string) => string }> = [];
  if (card.op) parts.push({ text: card.op, style: (value) => theme.fg("muted", value) });
  if (card.target) parts.push({ text: card.target, style: (value) => theme.fg("toolTitle", theme.bold(value)) });
  if (card.detail) parts.push({ text: card.detail, style: (value) => theme.fg("dim", value) });

  let plain = "";
  let styled = "";
  for (const part of parts) {
    const sep = plain ? " " : "";
    const room = summarySpace - visibleWidth(plain) - sep.length;
    if (room < 2) break;
    const text = visibleWidth(part.text) <= room ? part.text : truncateToWidth(part.text, room, "…");
    if (!text) break;
    plain += sep + text;
    styled += sep + part.style(text);
  }

  let line = INDENT + styledHead;
  if (plain) line += ` ${styled}`;
  if (used > 0) {
    const gap = Math.max(1, avail - headWidth - (plain ? visibleWidth(plain) + 1 : 0) - used);
    line += " ".repeat(gap) + styleStatus(theme, card.status, statusText);
  }
  return line;
}

/** Corpo com barra lateral, quebrado na largura disponível. */
export function barLines(width: number, theme: ToolTheme, tone: string, text: string): string[] {
  const content = String(text ?? "").replace(/\n+$/, "");
  if (!content) return [];
  const inner = Math.max(1, width - INDENT.length - 2 - visibleWidth(BAR));
  const lines: string[] = [];
  for (const raw of content.split("\n")) {
    const wrapped = raw ? wrapTextWithAnsi(theme.fg(tone, raw), inner) : [""];
    for (const piece of wrapped) lines.push(`${INDENT}  ${theme.fg("dim", BAR)}${piece}`);
  }
  return lines;
}

export function peersComponent(theme: ToolTheme, card: PeersCard): Renderable {
  return new Lines((width) => {
    const lines = [peersLine(width, theme, card)];
    if (!card.expanded) return lines;
    for (const block of card.expandedBlocks ?? []) lines.push(...barLines(width, theme, block.tone, block.text));
    return lines;
  });
}

/** Texto do resultado de uma tool (concatena blocos de texto). */
export function resultText(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
  return (result?.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

// ------------------------------------------------- mensagem que chega

/** Cabeçalho da mensagem recebida: origem e idade, sem o bloco cru. */
export function incomingHeader(meta: IncomingMeta, now: number): string {
  const who = `${meta.short} ${meta.project}${meta.branch ? `@${meta.branch}` : ""}`;
  const age = ageOf(meta.at, now);
  if (meta.kind === "ask") return `${GLYPH} PEDIDO ${meta.id} de ${who} · ${age}`;
  if (meta.kind === "reply") return `${GLYPH} PEDIDO ${meta.id} ${meta.status ?? "atualizado"} · ${who} · ${age}`;
  const chain = meta.reply_to ? ` · resposta a ${meta.reply_to}` : "";
  return `${GLYPH} de ${who}${chain} · ${age}`;
}

/**
 * Mensagem recebida na TUI: cabeçalho + corpo com barra. A orientação de
 * autoridade só aparece expandida (o modelo recebe sempre, no bloco).
 */
export function incomingComponent(theme: ToolTheme, meta: IncomingMeta, options: { expanded: boolean; now: number }): Renderable {
  return new Lines((width) => {
    const avail = Math.max(1, width - INDENT.length);
    const header = truncateToWidth(incomingHeader(meta, options.now), avail, "…");
    const lines = [INDENT + theme.fg("accent", header)];
    lines.push(...barLines(width, theme, "toolOutput", meta.body ?? ""));
    if (options.expanded && meta.guidance) lines.push(...barLines(width, theme, "muted", meta.guidance));
    return lines;
  });
}

/** Linha do recibo de entrega: entrada durável, fora do contexto do modelo. */
export function receiptLine(theme: ToolTheme, data: { id?: string; short?: string; kind?: string }): string {
  const what = data.kind === "ask" ? "pedido" : "mensagem";
  return `${INDENT}${theme.fg("accent", GLYPH)} ${theme.fg("muted", `${what} ${data.id ?? ""} entregue a ${data.short ?? "?"}`)}`;
}
