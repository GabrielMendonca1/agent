/**
 * Cards de tool no estilo Claude Code (Proposta A — "respiro")
 *
 *   ⏺ Read(src/router.ts)
 *     ⎿  Read 23 lines
 *          1  import type { IncomingMessage } from "node:http";
 *          …
 *        … +18 lines (ctrl+o to expand)
 *
 * Gramática: `⏺ Nome(args)` com bullet verde no sucesso, vermelho no erro e
 * cinza enquanto roda; resultado em `⎿`. Colapsado mostra só o resumo;
 * expandido (ctrl+o/clique) mostra o corpo completo. ask_user mantém a
 * pergunta e as opções visíveis nos dois estados.
 *
 * Como isto alcança TODA tool, inclusive as nativas: `pi.registerToolRenderer`
 * (API 1.0.4) intercepta a resolução de renderer por nome, antes da definição
 * registrada. `renderShell: "self"` tira a caixa de fundo do
 * `ToolExecutionComponent`, então o card desenha a própria moldura.
 *
 * Tool sem caso próprio cai no genérico `⏺ Nome(args)` + primeira linha do
 * resultado — nenhuma tool fica sem card.
 *
 * `GARIME_CLAUDE_STYLE=0` devolve o desenho anterior (resolver não registra).
 */

import { relative, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import { layoutFor } from "./claude-layout";
import {
	BULLET,
	ELBOW,
	claudeStyleEnabled,
	emit,
	markup,
	padBg,
	paint,
	stylesFor,
	T,
	type Styles,
	type ThemeLike,
	type Token,
	wrapTokens,
} from "./claude-style";

export interface Renderable {
	render(width: number): string[];
	invalidate(): void;
}

class Lines implements Renderable {
	// pi recria o componente a cada mudança de estado; só tema/largura mudam o desenho de uma instância.
	#width = -1;
	#lines: string[] = [];
	constructor(private readonly build: (width: number) => string[]) {}
	render(width: number): string[] {
		if (width !== this.#width) {
			this.#lines = this.build(width);
			this.#width = width;
		}
		return this.#lines;
	}
	invalidate(): void {
		this.#width = -1;
	}
}

const empty = (): Renderable => new Lines(() => []);

export type CardStatus = "run" | "ok" | "error";

/** Nomes à moda Claude Code. O que não está aqui é PascalCase do nome da tool. */
const LABELS: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Update",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "Ls",
	subagent: "Task",
	ask_user: "AskUser",
	plan: "Plan",
	todo: "Todo",
	checks: "Checks",
	codemode: "Codemode",
	generate_image: "GenerateImage",
	tool_search: "ToolSearch",
	project_overview: "ProjectOverview",
};

/**
 * Nomes como o Claude Code CLI mostra (estilo cc-agent): a busca é
 * `Search`, o glob é `Glob` e o checklist aparece como `Update Todos`.
 */
const CC_LABELS: Record<string, string> = {
	grep: "Search",
	find: "Glob",
	ls: "List",
	plan: "Update Todos",
	todo: "Update Todos",
};

export function toolLabel(name: string, env: NodeJS.ProcessEnv = process.env): string {
	if (CC_LABELS[name]) return CC_LABELS[name];
	if (LABELS[name]) return LABELS[name];
	return name
		.split(/[_\-.:]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Caminho relativo ao cwd quando dá; caminho curto é referência, não endereço. */
export function shortPath(raw: string, cwd: string | undefined): string {
	if (!raw) return "";
	if (!cwd || !isAbsolute(raw)) return raw;
	const rel = relative(cwd, raw);
	return !rel || rel.startsWith("..") ? raw : rel;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		if (line.trim()) return line.trim();
	}
	return "";
}

function oneLine(text: string, max = 90): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Argumentos resumidos entre parênteses, como o Claude Code faz. */
export function callArgs(toolName: string, args: any, cwd?: string): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const path = shortPath(str(a.file_path) || str(a.path) || str(a.notebook_path), cwd);
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return path;
		case "bash":
		case "powershell":
			return oneLine(str(a.command));
		case "grep": {
			const parts = [`"${oneLine(str(a.pattern), 40)}"`];
			if (path) parts.push(`path: ${path}`);
			if (a.glob) parts.push(`glob: ${str(a.glob)}`);
			return parts.join(", ");
		}
		case "find":
			return oneLine(str(a.pattern) || path, 50);
		case "codemode":
			return oneLine(firstLine(str(a.code)), 60);
		case "plan": {
			const steps = Array.isArray(a.steps) ? a.steps.length : 0;
			return steps ? `${steps} ${steps === 1 ? "passo" : "passos"}` : "";
		}
		case "ask_user":
			return oneLine(str(a.title) || str(a.question), 60);
		case "subagent": {
			if (Array.isArray(a.tasks)) {
				const agents = a.tasks.map((t: any) => str(t?.agent)).filter(Boolean);
				return agents.length ? `${agents.join(", ")} — ${agents.length} tarefas` : `${a.tasks.length} tarefas`;
			}
			const agent = str(a.agent);
			const task = oneLine(str(a.brief?.objective) || str(a.task), 48);
			return [agent, task].filter(Boolean).join(" — ");
		}
		case "generate_image":
			return oneLine(str(a.model) || str(a.prompt), 60);
		case "tool_search":
			return `"${oneLine(str(a.query), 50)}"`;
		default:
			break;
	}
	const entries = Object.entries(a).filter(([, value]) => value !== undefined && value !== null && value !== "");
	if (entries.length === 0) return "";
	return oneLine(
		entries
			.slice(0, 3)
			.map(([key, value]) =>
				typeof value === "object" ? `${key}: …` : `${key}: ${oneLine(String(value), 28)}`,
			)
			.join(", "),
		70,
	);
}

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

/** Tools cujo argumento É um comando: o parentesco ganha a cor de comando. */
const COMMAND_TOOLS = new Set(["bash", "powershell", "codemode"]);

/** `⏺ Nome(args)` — a 1ª linha do card. Linhas seguintes indentam 2 col. */
export function headerLines(
	width: number,
	st: Styles,
	card: { label: string; args: string; status: CardStatus; argStyle?: "muted" | "cmd" },
): string[] {
	const dot = card.status === "error" ? st.error : card.status === "run" ? st.dim : st.success;
	const tokens: Token[] = [T(dot, `${BULLET} `), T(st.bold, card.label), T(st.dim, "(")];
	if (card.args) tokens.push(...markup(st, card.args, card.argStyle ?? "muted"));
	tokens.push(T(st.dim, ")"));
	if (card.status === "run") tokens.push(T(st.dim, " …"));
	return wrapTokens(tokens, Math.max(8, width), 2).map((line, i) => (i ? "  " : "") + emit(line));
}

export interface ResultBody {
	summary: string;
	context?: string;
	/** Linhas de preview: texto (com marcação) ou tokens já classificados. */
	preview?: Array<string | Token[]>;
	/** Linhas escondidas além do preview (contadas no `… +N lines`). */
	more?: number;
	diff?: DiffLine[];
	steps?: Array<{ text: string; status: string }>;
	options?: { options: string[]; selected?: number };
	sub?: Array<{ text: string; status: CardStatus }>;
}

export interface DiffLine {
	n?: number;
	kind: "+" | "-" | " ";
	text: string;
}

const PREVIEW_INDENT = "     ";

/** `  ⎿  resumo` + corpo indentado, com truncamento estilo Claude Code. */
export function resultLines(
	width: number,
	st: Styles,
	body: ResultBody,
	options: { expanded: boolean; isError: boolean },
): string[] {
	const lines: string[] = [];
	const inner = Math.max(12, width);
	const elbow = paint(`  ${ELBOW}  `, st.dim);
	const head: Token[] = options.isError
		? [T(st.error, "Erro: "), ...markup(st, body.summary, "muted")]
		: markup(st, body.summary, "muted");
	if (body.summary || options.isError) {
		wrapTokens(head, inner - 5, 0).forEach((line, i) => {
			lines.push((i ? PREVIEW_INDENT : elbow) + emit(line));
		});
	}

	// ask_user exige atenção mesmo com as demais ferramentas colapsadas.
	if (!options.expanded && !body.options) return lines;
	if (body.context) {
		wrapTokens([T(st.muted, body.context)], inner - 5).forEach((line) => lines.push(PREVIEW_INDENT + emit(line)));
	}
	const preview = body.preview ?? [];
	const shown = preview;
	for (const item of shown) {
		const tokens = typeof item === "string" ? markup(st, item, options.isError ? "muted" : "dim") : item;
		wrapTokens(tokens, inner - 5, 2).forEach((line, i) => {
			lines.push(PREVIEW_INDENT + (i ? "  " : "") + emit(line));
		});
	}

	const hidden = (options.expanded ? 0 : body.more ?? 0) + Math.max(0, preview.length - shown.length);
	if (hidden > 0) {
		lines.push(
			PREVIEW_INDENT +
				paint(`… +${hidden} ${hidden === 1 ? "line" : "lines"} `, st.faint) +
				paint("(ctrl+o to expand)", { fg: st.p.faint, italic: true }),
		);
	}

	if (body.diff) lines.push(...diffLines(inner, st, body.diff, options.expanded));
	if (body.steps) lines.push(...stepLines(inner, st, body.steps));
	if (body.options) lines.push("", ...optionLines(inner, st, body.options));
	if (body.sub) lines.push(...subLines(inner, st, body.sub));
	return lines;
}

/** Diff com número de linha apagado e fundo vermelho/verde suave. */
export function diffLines(width: number, st: Styles, diff: DiffLine[], expanded: boolean): string[] {
	const gutter = 7;
	const limit = expanded ? diff.length : 14;
	const lines: string[] = [];
	for (const entry of diff.slice(0, limit)) {
		const bg = entry.kind === "+" ? st.p.addBg : entry.kind === "-" ? st.p.delBg : undefined;
		const fg = entry.kind === "+" ? st.p.addFg : entry.kind === "-" ? st.p.delFg : st.p.muted;
		const num = String(entry.n ?? "").padStart(4);
		const sign = entry.kind === " " ? " " : entry.kind;
		const room = Math.max(4, width - 5 - gutter);
		const text = visibleWidth(entry.text) > room ? `${[...entry.text].slice(0, room - 1).join("")}…` : entry.text;
		const painted = paint(num, { fg: st.p.faint, bg }) + paint(` ${sign} ${text}`, { fg, bg });
		lines.push(PREVIEW_INDENT + padBg(painted, width - 5, bg));
	}
	const hidden = diff.length - Math.min(diff.length, limit);
	if (hidden > 0) {
		lines.push(
			PREVIEW_INDENT +
				paint(`… +${hidden} lines `, st.faint) +
				paint("(ctrl+o to expand)", { fg: st.p.faint, italic: true }),
		);
	}
	return lines;
}

/** Checklist de plan/todo: ☒ riscado nos concluídos, ☐ nos pendentes. */
export function stepLines(width: number, st: Styles, steps: Array<{ text: string; status: string }>): string[] {
	const lines: string[] = [];
	for (const step of steps) {
		const done = step.status === "done" || step.status === "completed";
		const doing = step.status === "in_progress" || step.status === "doing";
		const box = done ? "☒" : "☐";
		const style = done ? st.done : doing ? st.bold : st.muted;
		const boxStyle = done ? st.success : doing ? st.accent : st.dim;
		wrapTokens([T(boxStyle, `${box} `), T(style, step.text)], width - 5, 2).forEach((line, i) => {
			lines.push(PREVIEW_INDENT + (i ? "  " : "") + emit(line));
		});
	}
	return lines;
}

/** Opções de `ask_user`: ●/○ e a escolhida em arc. */
export function optionLines(width: number, st: Styles, data: { options: string[]; selected?: number }): string[] {
	const lines: string[] = [];
	data.options.forEach((option, i) => {
		const picked = i === data.selected;
		const tokens: Token[] = [
			T(picked ? st.accent : st.dim, `${picked ? "●" : "○"} ${i + 1}. `),
			T(picked ? st.text : st.muted, option),
		];
		if (picked) tokens.push(T(st.faint, "  ← escolhido"));
		const room = Math.max(1, width - PREVIEW_INDENT.length);
		const hanging = Math.min(visibleWidth(`${picked ? "●" : "○"} ${i + 1}. `), room - 1);
		wrapTokens(tokens, room, hanging).forEach((line, j) => {
			// Revalida a palavra após a quebra, agora com o recuo pendente.
			wrapTextWithAnsi(emit(line), room - (j ? hanging : 0)).forEach((part, k) => {
				lines.push(truncateToWidth(PREVIEW_INDENT + (j || k ? " ".repeat(hanging) : "") + part, width, ""));
			});
		});
	});
	return lines;
}

/** Sub-itens de um card de subagente (`⎿` de segundo nível). */
export function subLines(width: number, st: Styles, sub: Array<{ text: string; status: CardStatus }>): string[] {
	const lines: string[] = [];
	for (const item of sub) {
		const dot = item.status === "error" ? st.error : item.status === "run" ? st.dim : st.success;
		wrapTokens([T(dot, `${ELBOW} `), ...markup(st, item.text, "dim")], width - 7, 2).forEach((line, i) => {
			lines.push("       " + (i ? "  " : "") + emit(line));
		});
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Do resultado da tool para o corpo do card
// ---------------------------------------------------------------------------

interface ResultLike {
	content?: Array<{ type: string; text?: string; mimeType?: string }>;
	details?: any;
}

export function resultText(result: ResultLike | undefined): string {
	return (result?.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function textLines(text: string): string[] {
	const trimmed = String(text ?? "").replace(/\s+$/, "");
	return trimmed ? trimmed.split("\n") : [];
}

/** Linha de código numerada, como o Read do Claude Code mostra. */
const codeLine = (st: Styles, n: number, text: string): Token[] => [
	T(st.line, String(n).padStart(4) + "  "),
	T(st.dim, text.replace(/\t/g, "  ")),
];

/** `src/router.ts:7:  trecho` → cada parte com a sua cor. */
function grepTokens(st: Styles, raw: string): Token[] {
	const m = raw.match(/^([^\s:][^:]*):(\d+):(.*)$/);
	if (!m) return markup(st, raw, "dim");
	return [T(st.file, m[1]), T(st.line, `:${m[2]}`), T(st.dim, `: ${m[3].trim()}`)];
}

/** Diff unificado (details.diff do edit/write) → linhas numeradas. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
	const out: DiffLine[] = [];
	let n = 0;
	for (const raw of String(diff ?? "").split("\n")) {
		if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
		const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			n = Number.parseInt(hunk[1], 10);
			continue;
		}
		if (!raw) continue;
		const kind = raw[0];
		const text = raw.slice(1);
		if (kind === "+") out.push({ n: n++, kind: "+", text });
		else if (kind === "-") out.push({ n, kind: "-", text });
		else if (kind === " ") out.push({ n: n++, kind: " ", text });
	}
	return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Monta o corpo do card a partir do resultado real da tool. */
export function describeResult(
	toolName: string,
	args: any,
	result: ResultLike | undefined,
	st: Styles,
	context: { isError: boolean; cwd?: string },
): ResultBody {
	const text = resultText(result);
	const lines = textLines(text);
	const details = result?.details;
	const hasImage = (result?.content ?? []).some((block) => block.type === "image");

	if (context.isError) {
		return { summary: firstLine(text) || "falhou", preview: lines.slice(1), more: 0 };
	}

	const generic = (): ResultBody => ({ summary: firstLine(text) || (hasImage ? "imagem" : ""), preview: lines.slice(1) });

	switch (toolName) {
		case "read": {
			if (hasImage && lines.length === 0) return { summary: "Leu imagem" };
			const offset = Number.parseInt(String(args?.offset ?? 1), 10) || 1;
			return {
				summary: `Leu ${plural(lines.length, "linha", "linhas")}`,
				preview: lines.map((line, i) => codeLine(st, offset + i, line)),
			};
		}
		case "write": {
			const diff = typeof details?.diff === "string" ? parseUnifiedDiff(details.diff) : undefined;
			return { summary: firstLine(text) || `Wrote ${shortPath(str(args?.file_path), context.cwd)}`, diff };
		}
		case "edit": {
			const diff = typeof details?.diff === "string" ? parseUnifiedDiff(details.diff) : undefined;
			return { summary: firstLine(text) || "Updated", diff };
		}
		case "grep":
			return {
				summary: `Found ${plural(lines.length, "match", "matches")}`,
				preview: lines.map((line) => grepTokens(st, line)),
			};
		case "find":
			return { summary: `Found ${plural(lines.length, "file", "files")}`, preview: lines.map((line) => markup(st, `\`${line}\``)) };
		case "ls":
			return { summary: `Listed ${plural(lines.length, "path", "paths")}`, preview: lines.map((line) => markup(st, `\`${line}\``)) };
		case "plan":
		case "todo": {
			const steps = Array.isArray(details?.steps) ? details.steps : Array.isArray(args?.steps) ? args.steps : undefined;
			if (!steps) return generic();
			const done = steps.filter((s: any) => s?.status === "done" || s?.status === "completed").length;
			return { summary: `${done}/${steps.length} passos`, steps: steps.map((s: any) => ({ text: str(s?.text), status: str(s?.status) })) };
		}
		case "ask_user": {
			const list = Array.isArray(details?.options) ? details.options.map((o: any) => String(o)) : undefined;
			if (!list) return generic();
			return {
				summary: str(args?.question) || str(details?.answer),
				context: str(args?.context),
				options: { options: list, selected: typeof details?.answer === "string" ? list.indexOf(details.answer) : typeof details?.selected === "number" ? details.selected : undefined },
			};
		}
		case "subagent": {
			const job = details?.job;
			const sub = Array.isArray(details?.results)
				? details.results.map((r: any) => ({ text: oneLine(str(r?.task) || str(r?.agent), 80), status: "ok" as CardStatus }))
				: [];
			const jobLine = job ? `${str(job.mode)} · \`${str(job.jobId)}\` · ${(job.agents ?? []).join(", ")}` : "";
			return { summary: jobLine || firstLine(text), preview: sub.length ? undefined : lines.slice(1), sub: sub.length ? sub : undefined };
		}
		default:
			return generic();
	}
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/** Recua linhas já pintadas; linha vazia continua vazia. */
function indent(lines: string[], pad: number): string[] {
	if (pad <= 0) return lines;
	const prefix = " ".repeat(pad);
	return lines.map((line) => (line ? prefix + line : line));
}

function statusOf(context: { isPartial: boolean; isError: boolean; executionStarted: boolean }): CardStatus {
	if (context.isError) return "error";
	if (context.isPartial) return "run";
	return "ok";
}

/** Renderers no estilo Claude para QUALQUER tool. */
export function claudeRenderers(): {
	renderShell: "self";
	renderCall: (args: any, theme: any, context: any) => any;
	renderResult: (result: any, options: any, theme: any, context: any) => any;
} {
	return {
		renderShell: "self",
		renderCall(args: any, theme: ThemeLike, context: any) {
			const name = String(context?.toolName ?? context?.state?.claudeToolName ?? "");
			return new Lines((width) => {
				const st = stylesFor(theme);
				const { cardPad, gapTool } = layoutFor();
				const lines = headerLines(width - cardPad, st, {
					label: toolLabel(name || context?.state?.claudeToolName || ""),
					args: callArgs(name, args, context?.cwd),
					status: statusOf(context),
					argStyle: COMMAND_TOOLS.has(name) ? "cmd" : "muted",
				});
				// O respiro extra do card vive AQUI: o shell "self" do
				// ToolExecutionComponent põe uma linha em branco fixa, fora do
				// PI_TUI_BLOCK_GAP (ver claude-layout.ts).
				return [...Array.from({ length: gapTool }, () => ""), ...indent(lines, cardPad)];
			}) as never;
		},
		renderResult(result: any, options: any, theme: ThemeLike, context: any) {
			const name = String(context?.toolName ?? context?.state?.claudeToolName ?? "");
			return new Lines((width) => {
				const st = stylesFor(theme);
				const { cardPad } = layoutFor();
				const body = describeResult(name, context?.args, result, st, {
					isError: Boolean(context?.isError),
					cwd: context?.cwd,
				});
				if (!body.summary && !body.preview?.length && !body.diff && !body.steps && !body.options && !body.sub) return [];
				return indent(
					resultLines(width - cardPad, st, body, {
						expanded: Boolean(options?.expanded ?? context?.expanded),
						isError: Boolean(context?.isError),
					}),
					cardPad,
				);
			}) as never;
		},
	};
}

export default function agentClaudeCards(pi: ExtensionAPI) {
	if (!claudeStyleEnabled()) return;
	if (typeof pi.registerToolRenderer !== "function") return;
	// Resolver oficial da TUI: Claude Code para todas as ferramentas,
	// inclusive para bash. Só muda apresentação; shell-runtime mantém a execução.
	pi.registerToolRenderer((toolName) => {
		const renderers = claudeRenderers();
		return {
			renderShell: "self",
			// O contexto do renderer não carrega o nome da tool: ele é fechado aqui,
			// no resolver, que já recebe o nome.
			renderCall: (args: any, theme: any, context: any) =>
				renderers.renderCall(args, theme, { ...context, toolName }),
			renderResult: (result: any, options: any, theme: any, context: any) =>
				renderers.renderResult(result, options, theme, { ...context, toolName }),
		};
	});
}

export { empty as emptyCard };
