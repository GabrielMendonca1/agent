/**
 * Medidas do estilo Claude Code — o "respiro" ajustável sem rebuild.
 *
 * O que o núcleo já resolve (e NÃO se repete aqui):
 *  - `PI_TUI_BLOCK_GAP` (0..4): linhas em branco entre blocos do transcript;
 *  - `PI_TUI_MARGIN_X` / `PI_TUI_MARGIN_Y`: margem do fullscreen;
 *  - `GARIME_INPUT_MARGIN_TOP` (margin.ts): respiro acima da caixa do input.
 *
 * O que fica aqui é o que o núcleo NÃO alcança:
 *
 *  - `GARIME_CLAUDE_GAP_TOOL` (0..3, default 2) — linhas em branco EXTRA acima
 *    de cada card de tool. O `ToolExecutionComponent` com `renderShell: "self"`
 *    ignora o `Spacer(PI_TUI_BLOCK_GAP)` e empurra sempre UMA linha em branco
 *    (`lines.push("")`), então o card fica preso em gap 1 enquanto prosa e
 *    pensamento seguem o env. Este knob repõe a diferença pelo lado do card:
 *    com `PI_TUI_BLOCK_GAP=3` (~/.zshenv) + `GARIME_CLAUDE_GAP_TOOL=2`
 *    (este default) a tela inteira respira 3 — R3 +1.
 *
 *  - `GARIME_CLAUDE_CARD_PAD` (0..4, default 1) — colunas à esquerda do card.
 *    A prosa e o pensamento passam pelo `outputPad` das settings (default 1);
 *    o card desenha a própria moldura e começa na coluna 0, o que deixava o
 *    `⏺` do card UMA coluna à esquerda do `⏺` da fala. O default 1 alinha os
 *    dois; quem roda com `outputPad: 0` põe 0 aqui.
 *
 *  - `GARIME_CLAUDE_THINK_INDENT` (0..4, default 0) — recuo do corpo do
 *    pensamento pelo lado da extensão, via bloco de citação (ver
 *    `thinking.ts`). Fica em 0 porque o recuo de verdade do R3 é do núcleo
 *    (`PI_TUI_THINK_INDENT`, default 2), que recua sem a barra fina; ligar os
 *    dois recuaria duas vezes.
 */

/** Lê um inteiro de env dentro de [0, max]; valor inválido volta ao default. */
export function readCount(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return Math.min(max, Math.max(0, fallback));
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed) || parsed < 0) return Math.min(max, Math.max(0, fallback));
	return Math.min(max, parsed);
}

export interface ClaudeLayout {
	/** Linhas em branco EXTRA acima do card (além da que o núcleo já põe). */
	gapTool: number;
	/** Colunas de recuo do card, para alinhar com o `outputPad` da prosa. */
	cardPad: number;
	/** Colunas de recuo do corpo do pensamento. */
	thinkIndent: number;
}

/** As medidas correntes. Lido a cada render: mudar o env não exige rebuild. */
export function layoutFor(env: NodeJS.ProcessEnv = process.env): ClaudeLayout {
	return {
		gapTool: readCount(env, "GARIME_CLAUDE_GAP_TOOL", 2, 3),
		cardPad: readCount(env, "GARIME_CLAUDE_CARD_PAD", 1, 4),
		thinkIndent: readCount(env, "GARIME_CLAUDE_THINK_INDENT", 0, 4),
	};
}
