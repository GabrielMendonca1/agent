/**
 * Como o Megamind aparece na tela (e só na tela).
 *
 * 1. Tool call recolhida em UMA linha, no espírito do card compacto do
 *    Mark TUI (`mark/extensions/mark/tui/compact-tools.ts`):
 *
 *      ◈ megamind → @leo  "libera o push?"            ✓ entregue
 *
 *    Expandido (ctrl+o) mostra corpo e resultado completos com barra lateral.
 * 2. Mensagem que chega de outro agente/sócio: cabeçalho com origem, corpo com
 *    barra lateral e a orientação de resposta escondida até expandir.
 *
 * Nada aqui muda um byte do que o modelo recebe: o texto das tools e o bloco
 * `[arca-megamind …]` continuam idênticos; a estrutura vem de `details` (que o
 * modelo não vê) e, quando falta, de uma leitura tolerante do próprio texto.
 * `ARCA_COMPACT_TOOLS=0` devolve a renderização padrão do Pi.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const GLYPH = "◈";
const LABEL = "megamind";
const INDENT = " ";
/** Barra lateral do corpo expandido. */
const BAR = "│";

export interface RenderTheme {
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

export const emptyComponent = (): Renderable => new Lines(() => []);

export function compactToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.ARCA_COMPACT_TOOLS !== "0";
}

export type StatusKind = "running" | "ok" | "pending" | "error" | "none";

const TONES: Record<StatusKind, string> = {
	running: "dim",
	ok: "success",
	pending: "warning",
	error: "error",
	none: "muted",
};

/** Uma linha recolhida: `◈ megamind <head>  <summary>        <status>`. */
export interface Collapsed {
	head: string;
	summary: string;
	status: { kind: StatusKind; text: string };
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function firstLine(source: string): string {
	for (const line of String(source ?? "").split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

export function lineCount(text: string): number {
	const trimmed = String(text ?? "").replace(/\n+$/u, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

/** Erro em uma linha: a primeira frase útil do texto do resultado. */
export function errorSummary(text: string): string {
	return firstLine(text) || "falhou";
}

export function shortId(value: string): string {
	return value.slice(0, 8);
}

function quoted(value: string): string {
	const line = firstLine(value);
	return line ? `"${line}"` : "";
}

function plural(value: number, one: string, many: string): string {
	return `${value} ${value === 1 ? one : many}`;
}

export interface ToolRenderInput {
	tool: string;
	args?: unknown;
	details?: unknown;
	/** Texto do resultado (vazio enquanto a tool roda). */
	text?: string;
	isError?: boolean;
	running?: boolean;
}

/** Linha recolhida de cada tool do Megamind. */
export function collapsedFor(input: ToolRenderInput): Collapsed {
	const args = record(input.args) ?? {};
	const details = record(input.details) ?? {};
	const text = str(input.text);
	const running = input.running === true;
	const failed = input.isError === true;
	const error = { kind: "error" as StatusKind, text: `✗ ${errorSummary(text)}` };
	const waiting = { kind: "running" as StatusKind, text: "…" };

	if (input.tool === "megamind_send") {
		const to = str(details.to) || str(args.to) || "destino";
		return {
			head: `→ ${to}`,
			summary: quoted(str(details.body) || str(args.body)),
			status: running ? waiting : failed ? error : { kind: "ok", text: "✓ entregue" },
		};
	}
	if (input.tool === "megamind_ask") {
		const to = str(details.to) || str(args.to) || "destino";
		const action = str(details.action) || str(args.action);
		const title = str(details.title) || str(args.title);
		return {
			head: `⧗ pedido → ${to}`,
			summary: [action, title].filter(Boolean).join(" · "),
			status: running ? waiting : failed ? error : { kind: "pending", text: "aguardando" },
		};
	}
	if (input.tool === "megamind_reply") {
		const id = shortId(str(details.id) || str(args.id));
		const status = str(details.status) || str(args.status);
		const result = str(details.result) || str(args.result);
		return {
			head: `✓ resposta ${id}`,
			summary: [status, quoted(result)].filter(Boolean).join(" · "),
			status: running ? waiting : failed ? error : { kind: "none", text: "" },
		};
	}
	if (input.tool === "megamind_who") {
		const people = count(details.people);
		const online = count(details.online);
		const sessions = count(details.sessions);
		const summary = people === undefined
			? plural(lineCount(text), "linha", "linhas")
			: [plural(people, "sócio", "sócios"), `${online ?? 0} online`, plural(sessions ?? 0, "sessão", "sessões")].join(" · ");
		return {
			head: "quem",
			summary: running ? "" : summary,
			status: running ? waiting : failed ? error : { kind: "ok", text: "✓" },
		};
	}
	if (input.tool === "megamind_read") {
		const target = str(details.with) || str(args.with) || "caixa";
		const items = count(details.items);
		return {
			head: `ler ${target}`,
			summary: running ? "" : plural(items ?? lineCount(text), "item", "itens"),
			status: running ? waiting : failed ? error : { kind: "ok", text: "✓" },
		};
	}
	return {
		head: input.tool.replace(/^megamind_/u, ""),
		summary: running ? "" : firstLine(text),
		status: running ? waiting : failed ? error : { kind: "ok", text: "✓" },
	};
}

/**
 * Monta a linha recolhida garantindo `visibleWidth(linha) <= width`: primeiro
 * encolhe o resumo, depois o texto do status, por último trunca o cabeçalho.
 */
export function collapsedLine(width: number, theme: RenderTheme, line: Collapsed): string {
	const avail = width - INDENT.length;
	if (avail <= 0) return "";
	const brand = `${GLYPH} ${LABEL}`;
	const head = line.head ? `${brand} ${line.head}` : brand;
	const headWidth = visibleWidth(head);
	if (headWidth >= avail) return INDENT + theme.fg("accent", truncateToWidth(head, avail, "…"));

	const rest = avail - headWidth;
	let statusText = line.status.text;
	let statusWidth = visibleWidth(statusText);
	if (statusWidth > 0 && rest < statusWidth + 1) {
		statusText = rest - 1 >= 4 ? truncateToWidth(statusText, rest - 1, "…") : "";
		statusWidth = visibleWidth(statusText);
	}
	const space = rest - statusWidth - (statusWidth ? 1 : 0) - 2;
	const summary = line.summary && space >= 4 ? truncateToWidth(line.summary, space, "…") : "";

	const used = headWidth + (summary ? 2 + visibleWidth(summary) : 0) + statusWidth;
	let out = INDENT + theme.fg("accent", brand);
	if (line.head) out += ` ${theme.bold(theme.fg("toolTitle", line.head))}`;
	if (summary) out += `  ${theme.fg("dim", summary)}`;
	if (statusWidth > 0) out += " ".repeat(Math.max(1, avail - used)) + theme.fg(TONES[line.status.kind], statusText);
	return out;
}

/** Corpo com barra lateral na cor de destaque. */
export function barLines(width: number, theme: RenderTheme, tone: string, text: string): string[] {
	const content = String(text ?? "").replace(/\n+$/u, "");
	if (!content) return [];
	const inner = Math.max(1, width - INDENT.length - 4);
	const lines: string[] = [];
	for (const raw of content.split("\n")) {
		const wrapped = raw ? wrapTextWithAnsi(theme.fg(tone, raw), inner) : [""];
		for (const piece of wrapped) lines.push(`${INDENT}  ${theme.fg("accent", BAR)} ${piece}`);
	}
	return lines;
}

export interface MegamindRender {
	line: Collapsed;
	expanded?: boolean;
	/** Blocos mostrados só quando expandido, na ordem. */
	blocks?: Array<{ tone: string; text: string }>;
}

export function megamindComponent(theme: RenderTheme, render: MegamindRender): Renderable {
	return new Lines((width) => {
		const lines = [collapsedLine(width, theme, render.line)];
		if (!render.expanded) return lines;
		for (const block of render.blocks ?? []) lines.push(...barLines(width, theme, block.tone, block.text));
		return lines;
	});
}

/** Texto do resultado de uma tool (concatena os blocos de texto). */
export function resultText(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return (result?.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

// --- mensagem que chega ----------------------------------------------------

const BLOCK_START = /^\[arca-megamind(?<header>[^\]]*)\]/u;
const BLOCK_END = "[/arca-megamind]";

export interface ParsedMessage {
	/** PEDIDO, RESPOSTA, MENSAGEM ou AVISO. */
	kind: string;
	id: string;
	who: string;
	meta: string;
	body: string;
	footer: string;
}

/**
 * Lê o bloco `[arca-megamind …]` com tolerância: cabeçalho que não casar com
 * nenhuma forma conhecida vira `MENSAGEM` com o cabeçalho cru em `meta`, e
 * texto que não é bloco nenhum devolve `undefined` (cai no render padrão).
 */
export function parseInboxMessage(content: string): ParsedMessage | undefined {
	const text = String(content ?? "");
	const match = BLOCK_START.exec(text);
	if (!match) return undefined;
	const header = (match.groups?.header ?? "").trim();
	const afterHeader = text.slice(match[0].length).replace(/^\n/u, "");
	const end = afterHeader.indexOf(BLOCK_END);
	const body = (end === -1 ? afterHeader : afterHeader.slice(0, end)).replace(/\n+$/u, "");
	const footer = end === -1 ? "" : afterHeader.slice(end + BLOCK_END.length).trim();

	// Aviso local (sobreposição de arquivos): bloco sem cabeçalho nem fechamento.
	if (!header) return { kind: "AVISO", id: "", who: "", meta: "", body: body.trim() || text.trim(), footer };

	const ask = /^(?<kind>PEDIDO)\s+(?<id>\S+)\s*(?<tail>.*)$/su.exec(header);
	if (ask?.groups) {
		const tail = ask.groups.tail ?? "";
		// `who` pode ter "@" dentro (label@máquina, (@handle)): o que o separa do
		// instante é " @ ", não o caractere solto.
		const who = /\b(?:resposta de|de|por)\s+(?<who>.+?)(?:\s@\s|\s—\s|$)/u.exec(tail)?.groups?.who ?? "";
		const kind = ask.groups.kind === "PEDIDO" && /resposta de/u.test(tail) ? "RESPOSTA" : ask.groups.kind;
		const status = /agora está\s+(?<status>[^\s—]+)/u.exec(tail)?.groups?.status
			?? /^\((?<title>[^)]*)\)\s+foi\s+(?<decided>[^\s—]+)/u.exec(tail)?.groups?.decided;
		const title = /^\((?<title>[^)]*)\)/u.exec(tail)?.groups?.title;
		return { kind, id: ask.groups.id ?? "", who: who.trim(), meta: metaOf([title, status, at(tail)]), body, footer };
	}
	const message = /^de\s+(?<who>.+?)\s@\s(?<meta>.*)$/su.exec(header);
	if (message?.groups) {
		return { kind: "MENSAGEM", id: "", who: (message.groups.who ?? "").trim(), meta: metaOf([at(header)]), body, footer };
	}
	return { kind: "MENSAGEM", id: "", who: "", meta: header, body, footer };
}

/** Instante do cabeçalho: o que vem depois de " @ " e antes do travessão. */
function at(header: string): string | undefined {
	return /\s@\s(?<at>[^—]+)/u.exec(header)?.groups?.at?.trim();
}

/** Linha de meta: título, status e instante, sem repetir quem mandou. */
function metaOf(parts: Array<string | undefined>): string {
	return parts.map((part) => part?.trim()).filter(Boolean).join(" · ");
}

/** Cabeçalho visível da mensagem: `◈ <TIPO> <id> de <quem>`. */
export function messageHeader(parsed: ParsedMessage): string {
	return [GLYPH, parsed.kind, parsed.id, parsed.who ? `de ${parsed.who}` : ""].filter(Boolean).join(" ");
}

export function messageComponent(theme: RenderTheme, parsed: ParsedMessage, expanded: boolean): Renderable {
	return new Lines((width) => {
		const avail = Math.max(1, width - INDENT.length);
		const lines = [INDENT + theme.fg("accent", theme.bold(truncateToWidth(messageHeader(parsed), avail, "…")))];
		if (parsed.meta) lines.push(INDENT + theme.fg("dim", truncateToWidth(parsed.meta, avail, "…")));
		lines.push(...barLines(width, theme, "text", parsed.body));
		// Orientação de resposta: ruído em cada mensagem, só aparece expandido.
		if (expanded && parsed.footer) lines.push(...barLines(width, theme, "dim", parsed.footer));
		return lines;
	});
}
