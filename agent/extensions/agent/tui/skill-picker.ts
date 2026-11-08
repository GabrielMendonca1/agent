/**
 * Seletor minimalista de `/skill:` (Agent)
 *
 * Lógica PURA do seletor: catálogo, filtro, navegação e desenho das linhas. Quem
 * liga nas teclas e no render do input é o `AgentEditor` (editor.ts).
 *
 * Fonte do catálogo: os comandos REAIS da sessão (`pi.getCommands()`, source
 * `skill`), cruzados com as categorias (`loadSkillCategories()`). Nada é lido do disco
 * por tecla ou por render — o editor monta o catálogo uma vez por abertura — e
 * nenhum nome é inventado: skill declarada na categoria mas ausente dos comandos
 * carregados simplesmente não aparece.
 *
 * Quem decide o que é automático é a curadoria (`isAutomaticSkill` em
 * agent/juice/skill-policy.mjs, injetada pelo editor). Esta UI não mantém lista
 * própria de automáticas: sem a função, ninguém ganha o losango.
 *
 * Este módulo não importa nada (nem do SDK): é testável direto por API pública.
 */

/** Comando de skill como `pi.getCommands()` entrega (`name: "skill:<nome>"`). */
export interface SkillCommandInfo {
	name: string;
	description?: string;
	source?: string;
}

/** Categoria como `loadSkillCategories()` entrega (só o que o seletor usa). */
export interface CategoryLike {
	name: string;
	skills?: string[];
}

export interface SkillEntry {
	/** Nome sem o prefixo `skill:`. */
	name: string;
	description: string;
	/** Categoria onde a skill foi declarada, ou `COMMON_GROUP` para as comuns. */
	group: string;
	/** Automática na categoria visitada (losango), segundo a curadoria. */
	automatic: boolean;
}

export interface SkillCatalog {
	/** Nomes de categoria na ordem de visita do Tab. */
	categories: string[];
	/** Skills por categoria (ordem declarada, sem duplicatas). */
	byCategory: Map<string, SkillEntry[]>;
	/** Comuns disponíveis em qualquer categoria. */
	common: SkillEntry[];
}

export interface PickerState {
	/** Categoria VISITADA na lista (Tab muda só isto; a sessão não troca). */
	category: string;
	/** Filtro digitado depois de `/skill:`. */
	query: string;
	/** Índice selecionado dentro das entradas visíveis. */
	index: number;
}

/** Rótulo do grupo das comuns. */
export const COMMON_GROUP = "comuns";
/** Marca de skill automática na categoria visitada. */
export const AUTOMATIC_MARK = "◆";
/** Linhas de skill desenhadas por vez (o resto rola com a seleção). */
export const MAX_ROWS = 8;

const SKILL_PREFIX = "skill:";
/** Texto que mantém o seletor aberto: `/skill` ou `/skill:<filtro>`, sem espaço. */
const OPEN_RE = /^\/skill(?::([A-Za-z0-9:_-]*))?$/;

/** Curadoria compartilhada com o anúncio no system prompt. */
export type IsAutomaticSkill = (name: string) => boolean;

/** Descrição curta: primeira frase, sem quebras, limitada em `max` colunas. */
export function shortDescription(description: string | undefined, max = 64): string {
	const flat = String(description ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return "";
	const stop = /^(.{4,}?[.;])\s/.exec(flat);
	const first = stop ? stop[1].replace(/[.;]$/, "") : flat;
	if (first.length <= max) return first;
	return `${first.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Skills REAIS da sessão, por nome, a partir dos comandos carregados. */
function realSkills(commands: readonly SkillCommandInfo[]): Map<string, string> {
	const found = new Map<string, string>();
	for (const command of commands ?? []) {
		const name = String(command?.name ?? "");
		if (!name.startsWith(SKILL_PREFIX)) continue;
		if (command.source !== undefined && command.source !== "skill") continue;
		const bare = name.slice(SKILL_PREFIX.length);
		if (!bare || found.has(bare)) continue;
		found.set(bare, shortDescription(command.description));
	}
	return found;
}

/**
 * Catálogo do seletor: só nomes que existem como comando de skill na sessão.
 * `isAutomaticSkill` vem da curadoria; sem ela, nada é marcado como automático.
 */
export function buildCatalog(options: {
	commands: readonly SkillCommandInfo[];
	categories: readonly CategoryLike[];
	isAutomaticSkill?: IsAutomaticSkill;
}): SkillCatalog {
	const real = realSkills(options.commands ?? []);
	const auto = options.isAutomaticSkill;
	const isAuto = (name: string) => {
		if (typeof auto !== "function") return false;
		try {
			return auto(name) === true;
		} catch {
			return false;
		}
	};
	const byCategory = new Map<string, SkillEntry[]>();
	const names: string[] = [];
	for (const category of options.categories ?? []) {
		const name = String(category?.name ?? "");
		if (!name || byCategory.has(name)) continue;
		names.push(name);
		const declared = [...(category.skills ?? [])];
		const seen = new Set<string>();
		const entries: SkillEntry[] = [];
		for (const skill of declared) {
			if (!real.has(skill) || seen.has(skill)) continue;
			seen.add(skill);
			entries.push({ name: skill, description: real.get(skill) ?? "", group: name, automatic: isAuto(skill) });
		}
		byCategory.set(name, entries);
	}
	// Comuns: automáticas (◆) primeiro, depois as demais; alfabética dentro de cada grupo.
	const common: SkillEntry[] = [...real.keys()].filter(name => ![...byCategory.values()].some(entries => entries.some(e => e.name === name))).sort().map((name) => ({
		name,
		description: real.get(name) ?? "",
		group: COMMON_GROUP,
		automatic: isAuto(name),
	})).sort((a, b) => Number(b.automatic) - Number(a.automatic));
	return { categories: names, byCategory, common };
}

/** Filtro de `/skill` ou `/skill:<filtro>`; fora desses comandos, `undefined`. */
export function pickerQuery(text: string): string | undefined {
	const match = OPEN_RE.exec(String(text ?? ""));
	return match ? (match[1] ?? "") : undefined;
}

/** Entradas da categoria visitada + comuns (comuns nunca duplicam a categoria). */
function groupEntries(catalog: SkillCatalog, category: string, isAuto?: IsAutomaticSkill): SkillEntry[] {
	const own = catalog.byCategory.get(category) ?? [];
	const names = new Set(own.map((entry) => entry.name));
	const common = catalog.common
		.filter((entry) => !names.has(entry.name))
		.map((entry) => ({
			...entry,
			automatic: typeof isAuto === "function" ? isAuto(entry.name) === true : entry.automatic,
		}));
	return [...own, ...common];
}

/** Entradas visíveis: grupo da categoria visitada, filtrado por nome/descrição. */
export function visibleEntries(catalog: SkillCatalog, state: PickerState, isAuto?: IsAutomaticSkill): SkillEntry[] {
	const query = state.query.trim().toLowerCase();
	const entries = groupEntries(catalog, state.category, isAuto);
	if (!query) return entries;
	const byName = entries.filter((entry) => entry.name.toLowerCase().includes(query));
	if (byName.length > 0) return byName;
	return entries.filter((entry) => entry.description.toLowerCase().includes(query));
}

/** Estado inicial na categoria pedida (cai no primeiro do catálogo se faltar). */
export function openPicker(catalog: SkillCatalog, category: string | undefined, query = ""): PickerState {
	const chosen = category && catalog.byCategory.has(category) ? category : (catalog.categories[0] ?? COMMON_GROUP);
	return { category: chosen, query, index: 0 };
}

/** Move a seleção com rolagem circular; lista vazia mantém o índice em 0. */
export function movePicker(state: PickerState, delta: number, count: number): PickerState {
	if (count <= 0) return { ...state, index: 0 };
	const index = (((state.index + delta) % count) + count) % count;
	return { ...state, index };
}

/** Tab: próxima categoria do catálogo, sem mudar a sessão. */
export function nextCategoryView(catalog: SkillCatalog, state: PickerState): PickerState {
	if (catalog.categories.length === 0) return state;
	const at = catalog.categories.indexOf(state.category);
	const next = catalog.categories[(at + 1) % catalog.categories.length];
	return { ...state, category: next, index: 0 };
}

/** Novo filtro (digitação/backspace): mantém a categoria visitada e volta ao topo. */
export function withQuery(state: PickerState, query: string): PickerState {
	return query === state.query ? state : { ...state, query, index: 0 };
}

/** O que o Enter INSERE no input (sem enviar): comando + espaço para o argumento. */
export function commandFor(entry: SkillEntry): string {
	return `/skill:${entry.name} `;
}

/** Janela de rolagem que mantém o selecionado visível. */
export function windowFor(count: number, index: number, rows = MAX_ROWS): { start: number; end: number } {
	if (count <= rows) return { start: 0, end: count };
	const start = Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows));
	return { start, end: start + rows };
}

const width_ = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
const clip = (text: string, max: number) => (width_(text) <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);

export interface PickerPaint {
	/** Linha selecionada. */
	selected?: (text: string) => string;
	/** Texto secundário (descrição, cabeçalho, dica). */
	muted?: (text: string) => string;
	/** Marca de automática. */
	automatic?: (text: string) => string;
}

/**
 * Linhas do seletor, para sair ABAIXO da caixa do input.
 * Em largura curta a descrição some e fica só nome (+ losango).
 */
export function renderPicker(
	catalog: SkillCatalog,
	state: PickerState,
	width: number,
	paint: PickerPaint = {},
	isAuto?: IsAutomaticSkill,
): string[] {
	if (width < 8) return [];
	const id = (text: string) => text;
	const muted = paint.muted ?? id;
	const selected = paint.selected ?? id;
	const automatic = paint.automatic ?? id;
	const entries = visibleEntries(catalog, state, isAuto);
	const inner = Math.max(4, width - 2);
	const lines: string[] = [];
	const scope = entries.length > 0 ? `${state.category}${state.query ? ` · ${state.query}` : ""}` : state.category;
	lines.push(`  ${muted(clip(`skills · ${scope}`, inner))}`);
	if (entries.length === 0) {
		lines.push(`  ${muted(clip("nenhuma skill com esse filtro", inner))}`);
		return lines;
	}
	const index = Math.max(0, Math.min(state.index, entries.length - 1));
	const { start, end } = windowFor(entries.length, index, MAX_ROWS);
	const nameWidth = Math.max(...entries.slice(start, end).map((entry) => entry.name.length));
	for (let at = start; at < end; at++) {
		const entry = entries[at];
		const mark = entry.automatic ? AUTOMATIC_MARK : " ";
		const bullet = at === index ? "▸" : " ";
		const head = `${bullet} ${entry.name.padEnd(nameWidth)} ${mark}`;
		const room = inner - width_(head) - 2;
		const tail = room >= 12 && entry.description ? `  ${muted(clip(entry.description, room))}` : "";
		const painted = `${at === index ? selected(head) : head}${tail}`;
		lines.push(`  ${painted}`);
	}
	if (entries.length > end - start) lines.push(`  ${muted(`(${index + 1}/${entries.length})`)}`);
	lines.push(`  ${muted(clip("↑↓ escolher · tab outra categoria · enter inserir · esc fechar", inner))}`);
	return lines;
}
