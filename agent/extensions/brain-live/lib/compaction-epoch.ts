/**
 * Época de compactação observada no BRANCH da sessão.
 *
 * O host durável do SDK (1.1.0) não entrega `session_compact` às extensões nem chama os
 * callbacks de `ctx.compact()`: quem precisa saber que uma compactação TERMINOU não pode
 * esperar evento. A prova confiável que o host já publica é a própria entrada de compactação
 * no branch ativo — é dela que `compaction.previousSummaryOf` lê o resumo anterior.
 *
 * Aqui só se olha para entradas CONFIRMADAS: `type === "compaction"` com `id` e `summary` não
 * vazio. Pedido de compactação, cancelamento e falha não criam entrada com resumo, então não
 * movem a época; tokens caírem também não (não é sinal, é consequência possível de outra coisa).
 *
 * `getBranch()` é preferido a `getEntries()`: o branch é o ramo ATIVO, e uma compactação feita
 * em outro ramo (ou abandonada por um branch novo) não é desta conversa.
 */

/** Entrada de compactação confirmada: a que tem id e resumo gravados. */
export function isConfirmedCompaction(entry: unknown): boolean {
	const e = entry as { type?: unknown; id?: unknown; summary?: unknown } | null | undefined;
	if (!e || typeof e !== "object" || e.type !== "compaction") return false;
	if (!(typeof e.id === "string" && e.id)) return false;
	return typeof e.summary === "string" && e.summary.trim().length > 0;
}

/** ID da última compactação confirmada do branch, ou undefined quando não houve nenhuma. */
export function lastCompactionId(branch: Iterable<unknown> | null | undefined): string | undefined {
	if (!branch || typeof (branch as any)[Symbol.iterator] !== "function") return undefined;
	let id: string | undefined;
	for (const entry of branch) {
		if (isConfirmedCompaction(entry)) id = (entry as { id: string }).id;
	}
	return id;
}

/**
 * Branch ATIVO da sessão. `getBranch` é a leitura certa; `getEntries` só entra quando o host
 * não expõe `getBranch` (dublês de teste, versões antigas). Nunca lê o disco.
 */
export function branchOf(ctx: unknown): unknown[] {
	const manager = (ctx as { sessionManager?: any } | null | undefined)?.sessionManager;
	if (!manager) return [];
	try {
		const branch = manager.getBranch?.() ?? manager.getEntries?.() ?? [];
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

/**
 * Detector de compactação concluída, por observação. Uma instância por extensão.
 *
 * `sync` adota o estado atual sem disparar nada (início de sessão, restore, ou quando o evento
 * `session_compact` chega de fato no host clássico — assim a mesma compactação não é contada
 * duas vezes). `observe` devolve true UMA vez por compactação nova.
 *
 * Primeira observação sem `sync` anterior só adota o estado: sem um ponto de partida conhecido
 * não há como afirmar que a compactação encontrada é nova (a sessão pode ter sido retomada
 * depois dela). Quem quer o reset no restore chama `sync` no `session_start`.
 */
export class CompactionEpoch {
	private seen?: string;
	private primed = false;

	/** Adota o estado atual do branch como já visto. */
	sync(branch: Iterable<unknown> | null | undefined): void {
		this.seen = lastCompactionId(branch);
		this.primed = true;
	}

	/** true quando o branch mostra uma compactação confirmada que ainda não havia sido vista. */
	observe(branch: Iterable<unknown> | null | undefined): boolean {
		const id = lastCompactionId(branch);
		if (id === undefined) return false; // nada confirmado: não mexe no estado conhecido
		const known = this.primed;
		const changed = id !== this.seen;
		this.seen = id;
		this.primed = true;
		return known && changed;
	}

	/** Último id adotado, para diagnóstico. */
	get lastSeen(): string | undefined {
		return this.seen;
	}
}
