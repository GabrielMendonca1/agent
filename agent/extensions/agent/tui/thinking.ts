/**
 * Pensamento em destaque
 *
 * O raciocínio do modelo chegava como um bloco cinza itálico sem moldura,
 * perdido entre cards de tool. Aqui ele ganha cabeçalho e barra lateral:
 *
 *   ✻ pensando
 *   │ Vou checar o arquivo de config e depois
 *   │ rodar o teste para confirmar...
 *
 * Técnica: `registerMarkdownTransformer` reescreve o Markdown do
 * `assistant-thinking` antes do parse — cabeçalho em negrito e corpo como
 * blockquote. A barra `│` vem do `quoteBorder` do próprio markdown do Pi,
 * então acompanha tema e largura sem patch no renderer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { claudeStyleEnabled } from "./claude-style";
import { layoutFor } from "./claude-layout";
import { transformProse } from "./claude-prose";

export const THINKING_HEADER = "✻ pensando";

/** Cabeçalho do pensamento no estilo Claude Code (Proposta A). */
export const CLAUDE_THINKING_HEADER = "✻ Thinking…";

/**
 * Prefixa o cabeçalho e transforma o corpo em blockquote.
 *
 * Idempotente: se o cabeçalho já está lá, devolve o texto intacto.
 * Streaming parcial (fence aberta, linha cortada) continua válido porque cada
 * linha — inclusive as vazias e as de dentro da fence — recebe o marcador `>`,
 * e o markdown do Pi já trata fence não fechada dentro de blockquote.
 */
export function transformThinking(markdown: string): string {
	const normalized = markdown.replace(/\r\n/g, "\n");
	if (!normalized.trim()) return markdown;
	if (normalized.trimStart().startsWith(`**${THINKING_HEADER}**`)) return markdown;

	const quoted = normalized
		.replace(/\s+$/, "")
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n");
	// O renderer do Pi sempre separa parágrafo de blockquote com uma linha em
	// branco; ela fica como respiro entre cabeçalho e corpo.
	return `**${THINKING_HEADER}**\n${quoted}`;
}

/**
 * Variante Claude Code: cabeçalho `✻ Thinking…` em itálico e corpo apagado.
 *
 * Recuo do corpo (`GARIME_CLAUDE_THINK_INDENT`, ver claude-layout.ts): o
 * markdown do Pi reembrulha o parágrafo, então espaço literal (ou NBSP) só
 * recuaria a PRIMEIRA linha — a única indentação que sobrevive à quebra é a do
 * bloco de citação, que recua todas as linhas e desenha uma barra fina em
 * `mdQuoteBorder`. Indentação sem barra nenhuma exige patch de núcleo
 * (docs/tui-claude-core.patch, item 6).
 */
export function transformThinkingClaude(markdown: string, env: NodeJS.ProcessEnv = process.env): string {
	const normalized = markdown.replace(/\r\n/g, "\n");
	if (!normalized.trim()) return markdown;
	if (normalized.trimStart().startsWith(`**${CLAUDE_THINKING_HEADER}**`)) return markdown;
	const body = normalized.replace(/\s+$/, "");
	if (layoutFor(env).thinkIndent > 0) {
		const quoted = body
			.split("\n")
			.map((line) => (line.trim() ? `> ${line}` : ">"))
			.join("\n");
		return `**${CLAUDE_THINKING_HEADER}**\n${quoted}`;
	}
	return `**${CLAUDE_THINKING_HEADER}**\n\n${body}`;
}

/**
 * UM transformer por extensão: `registerMarkdownTransformer` guarda um único
 * callback (`extension.markdownTransformer = transformer`), então pensamento e
 * prosa precisam dividir o mesmo ponto de registro — dois registros fariam o
 * segundo apagar o primeiro.
 */
export default function agentThinking(pi: ExtensionAPI) {
	const claude = claudeStyleEnabled();
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "assistant-thinking") {
			return claude ? transformThinkingClaude(markdown) : transformThinking(markdown);
		}
		return claude ? transformProse(markdown, context.messageType) : markdown;
	});
}
