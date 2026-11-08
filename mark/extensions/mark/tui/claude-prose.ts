/**
 * Prosa no estilo Claude Code: fala do agente com `⏺`, pedido do usuário com fundo próprio
 * e referências de arquivo coloridas.
 *
 * Tudo acontece ANTES do parser de markdown do Pi
 * (`registerMarkdownTransformer`), porque é o único ponto em que uma extensão
 * toca o texto da mensagem.
 *
 * Limites conhecidos (viram patch de core em docs/tui-claude-core.patch):
 *  - a indentação pendente de 2 colunas nas linhas seguintes à do `⏺` não tem
 *    hook: só a primeira linha ganha o bullet;
 *  - o markdown do Pi tem 3 cores para texto rico (`mdLink`, `mdLinkUrl`,
 *    `mdCode`), então em PROSA arquivo e URL dividem a mesma cor. Dentro dos
 *    cards, onde o desenho é nosso, as 5 cores da proposta valem.
 */

/** O fundo e o recuo nativos identificam a mensagem do usuário. */
export const USER_PREFIX = "";
export const AGENT_BULLET = "⏺ ";

/** Caminho de arquivo em prosa: vira link markdown para herdar `mdLink` do tema. */
const RE_PATH_IN_CODE =
	/^(?:[~./]|\b)[\w@./-]*\/[\w@.-]+\.[a-z]{2,6}(?::\d+(?:-\d+)?)?$|^[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|log|png|jpg|html|css|py|sh|toml|yml|yaml)(?::\d+(?:-\d+)?)?$/;

/**
 * `⏺` na primeira linha da fala do agente.
 *
 * Idempotente e seguro em streaming: sem conteúdo ainda, devolve o texto
 * intacto; com o bullet já posto, não põe outro. Cabeçalho, lista e citação
 * ficam de fora — o bullet antes de `#` ou `-` quebraria o bloco markdown.
 */
export function prefixAgentBullet(markdown: string): string {
	if (!markdown.trim()) return markdown;
	if (markdown.trimStart().startsWith(AGENT_BULLET.trim())) return markdown;
	const first = markdown.split("\n", 1)[0] ?? "";
	if (/^\s*(?:[#>*+-]|\d+[.)]|```|\||\\>)/.test(first)) return markdown;
	return AGENT_BULLET + markdown;
}

/** Mantém todos os parágrafos no recuo nativo, sem chevron. */
export function prefixUserChevron(markdown: string): string {
	return markdown;
}

/**
 * Caminhos entre backticks viram links markdown, para receberem a cor de link
 * do tema (arc) em vez da cor de código. Fences de código ficam intactas.
 */
export function linkFilePaths(markdown: string): string {
	const parts = markdown.split(/(```[\s\S]*?(?:```|$))/);
	return parts
		.map((part, index) => {
			if (index % 2 === 1) return part;
			return part.replace(/`([^`\n]+)`/g, (whole, inner: string) =>
				RE_PATH_IN_CODE.test(inner) ? `[${inner}](${inner})` : whole,
			);
		})
		.join("");
}

/** A transformação de prosa do estilo Claude, por tipo de mensagem. */
export function transformProse(markdown: string, messageType: string): string {
	if (messageType === "user") return prefixUserChevron(markdown);
	if (messageType === "assistant") return prefixAgentBullet(linkFilePaths(markdown));
	return markdown;
}
