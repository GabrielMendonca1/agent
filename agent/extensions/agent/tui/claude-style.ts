/**
 * Estilo Claude Code — primitivas de desenho
 *
 * Base da "Proposta A (respiro)" escolhida pelo Gabriel
 * (docs/tui-catalog/proposta-claude-code.html): gramática `⏺`/`⎿`, paleta de
 * links com uma cor por tipo de referência e medidas fixas (margem 2 col, gap
 * 1, preview de 4 linhas).
 *
 * Aqui ficam só as primitivas puras: paleta por aparência do tema, pintura em
 * truecolor, marcação inline (arquivo/URL/comando/símbolo/`código`) e quebra de
 * linha por COLUNAS VISÍVEIS. Quem monta card é `claude-cards.ts`.
 *
 * Por que truecolor e não tokens de tema: o tema do Pi tem 3 slots coloríveis
 * para texto rico (`mdLink`, `mdLinkUrl`, `mdCode`) e a proposta pede 5 cores de
 * referência dentro dos cards. As cores entram como hex, e o preto/branco/cinza
 * continua vindo do tema (`theme.colors`), então um tema novo muda o card junto.
 *
 * Desligar tudo: `GARIME_CLAUDE_STYLE=0`.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const BULLET = "⏺";
export const ELBOW = "⎿";
export const STAR = "✻";

/** Linhas de resultado mostradas antes do `… +N lines`. */
export const PREVIEW_LINES = 4;

/** O estilo Claude está ligado? Ligado por padrão; `GARIME_CLAUDE_STYLE=0` desliga. */
export function claudeStyleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.GARIME_CLAUDE_STYLE !== "0";
}

/** Cor de destaque forçada por env, se for um hex válido. */
export function accentOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = (env.GARIME_CLAUDE_ACCENT ?? "").trim();
	return HEX.test(raw) ? raw : undefined;
}

/**
 * Aparência forçada por env (`GARIME_CLAUDE_APPEARANCE=dark|light`), se válida.
 * Qualquer outro valor é ignorado — vale o tema ativo do Pi.
 */
export function appearanceOverride(env: NodeJS.ProcessEnv = process.env): "dark" | "light" | undefined {
	const raw = (env.GARIME_CLAUDE_APPEARANCE ?? "").trim();
	return raw === "dark" || raw === "light" ? raw : undefined;
}

export interface Style {
	fg?: string;
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
}

export interface Palette {
	text: string;
	muted: string;
	dim: string;
	faint: string;
	rule: string;
	success: string;
	error: string;
	accent: string;
	/** links: uma cor por tipo de referência */
	file: string;
	line: string;
	url: string;
	cmd: string;
	sym: string;
	codeFg: string;
	codeBg: string;
	/** diff */
	addBg: string;
	addFg: string;
	delBg: string;
	delFg: string;
}

/** Paleta oficial cc-agent escura. */
export const CC_AGENT_DARK: Palette = {
	text: "#f7f7f7",
	muted: "#9a9a9a",
	dim: "#626262",
	faint: "#4a4a4a",
	rule: "#2a2a2a",
	success: "#4EBA65",
	error: "#FF6B80",
	accent: "#5AD8FF",
	file: "#5AD8FF",
	line: "#626262",
	url: "#8AB4F8",
	cmd: "#D7C08A",
	sym: "#7FD7C4",
	codeFg: "#B1B9F9",
	codeBg: "",
	addBg: "#1C3A29",
	addFg: "#D6F5E3",
	delBg: "#4A1F24",
	delFg: "#FFD6DC",
};

/** Paleta oficial cc-agent clara. */
export const CC_AGENT_LIGHT: Palette = {
	text: "#1a1a1a",
	muted: "#505050",
	dim: "#5a5a5a",
	faint: "#787878",
	rule: "#d7d7d7",
	success: "#2E7D46",
	error: "#C03346",
	accent: "#066090",
	file: "#066090",
	line: "#5a5a5a",
	url: "#1F4FBF",
	cmd: "#8a5300",
	sym: "#0f6b5c",
	codeFg: "#4B4FBF",
	codeBg: "",
	addBg: "#d6efdd",
	addFg: "#10401f",
	delBg: "#fbdde0",
	delFg: "#6b1620",
};

/** O mínimo que estas primitivas usam de um `Theme` do Pi. */
export interface ThemeLike {
	name?: string;
	appearance?: string;
	colors?: Record<string, unknown>;
}

/**
 * Tema EFETIVO: o tema ativo do Pi (que já responde a hot-swap, porque o host
 * exporta um proxy vivo) com a aparência sobrescrita quando a pessoa pediu
 * explicitamente por env. Precedência: `GARIME_CLAUDE_APPEARANCE` > tema ativo
 * (`appearance` declarada/detectada) > nome do tema.
 */
export function effectiveTheme(theme: ThemeLike | undefined, env: NodeJS.ProcessEnv = process.env): ThemeLike | undefined {
	const forced = appearanceOverride(env);
	if (!forced) return theme;
	return { name: theme?.name, appearance: forced, colors: theme?.colors };
}

/**
 * Roxo do modo complex (mockup aprovado; não é o accent do tema, que no cc-agent
 * é azul). O escuro fica como está; o claro é a mesma família de matiz com
 * contraste de TEXTO em fundo claro (#5B32AD: 8,4:1 sobre #ffffff, 7,8:1 sobre
 * #f7f7f7), porque #B19AFF em fundo claro dá 2,4:1 e não se lê.
 */
export const COMPLEX_PURPLE_DARK = "#B19AFF";
export const COMPLEX_PURPLE_LIGHT = "#5B32AD";

export function complexPurple(theme: ThemeLike | undefined, env: NodeJS.ProcessEnv = process.env): string {
	return isLight(effectiveTheme(theme, env)) ? COMPLEX_PURPLE_LIGHT : COMPLEX_PURPLE_DARK;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function hexOf(theme: ThemeLike | undefined, token: string): string | undefined {
	const value = theme?.colors?.[token];
	return typeof value === "string" && HEX.test(value) ? value : undefined;
}

/** `true` quando o tema é para fundo claro (declarado, detectado ou pelo nome). */
export function isLight(theme: ThemeLike | undefined): boolean {
	if (theme?.appearance === "light") return true;
	if (theme?.appearance === "dark") return false;
	return (theme?.name ?? "").includes("light");
}

/**
 * Paleta efetiva: cinza/preto/branco e estados vêm do TEMA quando ele expõe hex
 * concretos; as cores de link vêm da proposta (o tema não tem slots para elas).
 */
export function paletteFor(theme: ThemeLike | undefined, env: NodeJS.ProcessEnv = process.env): Palette {
	const light = isLight(effectiveTheme(theme, env));
	const base = light ? CC_AGENT_LIGHT : CC_AGENT_DARK;
	const accent = accentOverride(env) ?? hexOf(theme, "accent") ?? base.accent;
	return {
		...base,
		accent,
		file: accent,
		text: hexOf(theme, "text") ?? base.text,
		muted: hexOf(theme, "muted") ?? base.muted,
		dim: hexOf(theme, "dim") ?? base.dim,
		faint: hexOf(theme, "borderMuted") ?? base.faint,
		rule: hexOf(theme, "border") ?? base.rule,
		success: hexOf(theme, "success") ?? base.success,
		error: hexOf(theme, "error") ?? base.error,
		line: hexOf(theme, "dim") ?? base.line,
	};
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
	number,
	number,
	number,
];

/** Pinta um texto em truecolor. Sem estilo, devolve o texto cru. */
export function paint(text: string, style: Style | undefined): string {
	if (!text || !style) return text;
	const codes: number[] = [];
	if (style.bold) codes.push(1);
	if (style.italic) codes.push(3);
	if (style.underline) codes.push(4);
	if (style.strike) codes.push(9);
	if (style.fg && HEX.test(style.fg)) codes.push(38, 2, ...rgb(style.fg));
	if (style.bg && HEX.test(style.bg)) codes.push(48, 2, ...rgb(style.bg));
	return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

export interface Token {
	style?: Style;
	text: string;
}

export const T = (style: Style | undefined, text: string): Token => ({ style, text });

/** Tabela de estilos derivada da paleta: o vocabulário que os cards usam. */
export interface Styles {
	p: Palette;
	text: Style;
	bold: Style;
	muted: Style;
	dim: Style;
	faint: Style;
	italic: Style;
	accent: Style;
	success: Style;
	error: Style;
	file: Style;
	line: Style;
	url: Style;
	cmd: Style;
	sym: Style;
	code: Style;
	done: Style;
}

export function stylesFor(theme: ThemeLike | undefined, env: NodeJS.ProcessEnv = process.env): Styles {
	const p = paletteFor(theme, env);
	return {
		p,
		text: { fg: p.text },
		bold: { fg: p.text, bold: true },
		muted: { fg: p.muted },
		dim: { fg: p.dim },
		faint: { fg: p.faint },
		italic: { fg: p.muted, italic: true },
		accent: { fg: p.accent },
		success: { fg: p.success },
		error: { fg: p.error },
		file: { fg: p.file, underline: true },
		line: { fg: p.line },
		url: { fg: p.url, underline: true },
		cmd: { fg: p.cmd },
		sym: { fg: p.sym },
		code: { fg: p.codeFg, bg: p.codeBg },
		done: { fg: p.dim, strike: true },
	};
}

// ---------------------------------------------------------------------------
// Marcação inline: cada tipo de referência com a sua cor
// ---------------------------------------------------------------------------

const RE_URL = /https?:\/\/[^\s)]+/;
const RE_PATH =
	/(?:[~./]|\b)[\w@./-]*\/[\w@.-]+\.[a-z]{2,6}(?::\d+(?:-\d+)?)?|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|log|png|jpg|html|css|py|sh|toml|yml|yaml)\b(?::\d+(?:-\d+)?)?/;
const RE_SYM = /\b[A-Za-z_][\w.]*\(\)/;
const RE_CMD = /^(?:pnpm|npm|npx|yarn|bun|node|git|vitest|jest|rg|pi|cargo|go|make|docker|python|python3|uv|bash|sh)\b/;

/** `src/router.ts:8-10` → caminho colorido + sufixo de linha mais apagado. */
export function filePathTokens(st: Styles, raw: string): Token[] {
	const m = raw.match(/^(.*?)(:\d+(?:-\d+)?)$/);
	if (!m) return [T(st.file, raw)];
	return [T(st.file, m[1]), T(st.line, m[2])];
}

/** Conteúdo de um par de backticks: comando, caminho, símbolo ou código. */
export function codeTokens(st: Styles, raw: string): Token[] {
	if (RE_URL.test(raw)) return [T(st.url, raw)];
	if (RE_CMD.test(raw)) return [T(st.cmd, raw)];
	const p = raw.match(RE_PATH);
	if (p && p[0] === raw) return filePathTokens(st, raw);
	if (RE_SYM.test(raw)) return [T(st.sym, raw)];
	return [T(st.code, raw)];
}

/**
 * Texto com marcação: `código` por backticks e, fora deles, caminhos e URLs
 * ainda viram link. O resto fica no estilo base.
 */
export function markup(st: Styles, text: string, base: keyof Styles = "text"): Token[] {
	const out: Token[] = [];
	const baseStyle = st[base] as Style;
	const flush = (chunk: string) => {
		let left = chunk;
		while (left) {
			const u = left.match(RE_URL);
			const p = left.match(RE_PATH);
			const s = left.match(RE_SYM);
			const cand = [u, p, s]
				.filter((m): m is RegExpMatchArray => Boolean(m))
				.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
			if (!cand) {
				out.push(T(baseStyle, left));
				break;
			}
			const at = cand.index ?? 0;
			if (at > 0) out.push(T(baseStyle, left.slice(0, at)));
			if (cand === u) out.push(T(st.url, cand[0]));
			else if (cand === s) out.push(T(st.sym, cand[0]));
			else out.push(...filePathTokens(st, cand[0]));
			left = left.slice(at + cand[0].length);
		}
	};
	let rest = text;
	while (rest.length) {
		const i = rest.indexOf("`");
		const j = i < 0 ? -1 : rest.indexOf("`", i + 1);
		if (i < 0 || j < 0) {
			flush(rest);
			break;
		}
		flush(rest.slice(0, i));
		out.push(...codeTokens(st, rest.slice(i + 1, j)));
		rest = rest.slice(j + 1);
	}
	return out.filter((token) => token.text.length > 0);
}

/**
 * Quebra tokens em linhas de até `width` colunas VISÍVEIS, com indentação
 * pendente (`hang`) nas linhas seguintes. Nunca mede em `length`: emoji e
 * glifos largos contam por célula.
 */
export function wrapTokens(tokens: Token[], width: number, hang = 0): Token[][] {
	const limit = Math.max(1, width);
	const words: Array<Token & { space?: boolean }> = [];
	for (const token of tokens) {
		for (const part of token.text.split(/(\s+)/)) {
			if (!part) continue;
			words.push({ style: token.style, text: part, space: /^\s+$/.test(part) });
		}
	}
	const lines: Token[][] = [];
	let cur: Token[] = [];
	let used = 0;
	let avail = limit;
	const push = () => {
		lines.push(cur);
		cur = [];
		used = 0;
		avail = Math.max(1, limit - hang);
	};
	for (const word of words) {
		if (word.space) {
			if (used === 0) continue;
			cur.push({ style: word.style, text: word.text });
			used += visibleWidth(word.text);
			continue;
		}
		let text = word.text;
		while (visibleWidth(text) > avail) {
			if (used > 0) {
				push();
				continue;
			}
			const head = truncateToWidth(text, avail, "", true);
			cur.push({ style: word.style, text: head });
			text = text.slice(head.length);
			push();
		}
		if (used + visibleWidth(text) > avail) push();
		cur.push({ style: word.style, text });
		used += visibleWidth(text);
	}
	if (cur.length) lines.push(cur);
	return lines.map((line) => {
		while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
		return line;
	});
}

/** Tokens → uma linha pintada. */
export const emit = (tokens: Token[]): string => tokens.map((token) => paint(token.text, token.style)).join("");

/** Completa a linha até `n` colunas com fundo (blocos com bg, como o diff). */
export function padBg(text: string, n: number, bg: string | undefined): string {
	const miss = Math.max(0, n - visibleWidth(text));
	if (miss === 0) return text;
	return text + (bg ? paint(" ".repeat(miss), { bg }) : " ".repeat(miss));
}
