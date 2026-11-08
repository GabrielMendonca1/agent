/**
 * Cost Ledger — agregador puro de custo/tokens sobre os JSONL de sessão do pi.
 *
 * O pi já grava `usage` (input/output/cacheRead/cacheWrite + cost) em cada
 * mensagem de assistente, em cada toolResult com trabalho de LLM aninhado e em
 * cada compaction. Este módulo só LÊ: nada aqui escreve, nada aqui fala com a
 * rede. Extensão (`/cost`) e CLI (`bin/pi-cost`) chamam as mesmas funções.
 *
 * "Custo" aqui é o valor de TABELA do modelo. Com OAuth de assinatura a conta
 * real é outra; o número serve para comparar modelos, dias e projetos entre si
 * e para medir quanto o cache poupou — não para bater com a fatura.
 *
 * Economia de cache = (tokens lidos do cache) × (preço de input cheio − preço
 * de cache). O preço de input cheio vem da própria mensagem quando ela tem
 * input não cacheado suficiente; senão do último preço visto para o mesmo
 * modelo; senão da razão padrão dos provedores (cache read = 10% do input).
 *
 * Além do JSONL antigo, `agregar()` aceita sessões do pi durável: um caminho
 * terminado em `session.sqlite` (ou o diretório da sessão) é lido em modo
 * somente leitura por lib/durable-sessions.ts e vira as mesmas entradas.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { durableDbOf, isDurablePath, listDurableSessions, readDurableSession } from "./durable-sessions.ts";

export interface Bucket {
	key: string;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** quanto custaria sem cache (tokens de cache ao preço de input cheio) */
	semCache: number;
	mensagens: number;
	/** por bucket de sessão: primeiro/último timestamp, projeto, título */
	primeiro?: string;
	ultimo?: string;
	projeto?: string;
	titulo?: string;
}

export type Dimensao = "dia" | "modelo" | "projeto" | "sessao" | "hora";

export interface Filtro {
	/** inclui mensagens com timestamp >= desde (ISO) */
	desde?: string;
	/** inclui mensagens com timestamp < ate (ISO) */
	ate?: string;
	/** restringe a um diretório de sessões (um projeto) */
	sessionDir?: string;
	/** restringe a um arquivo de sessão */
	sessionFile?: string;
	/** só a branch que termina nesta folha (para "esta sessão" respeitar /rewind) */
	leafId?: string;
	/** só sessões cujo cwd é este (serve a "aqui" quando o dir não basta) */
	cwd?: string;
}

export interface Ledger {
	total: Bucket;
	por: Record<Dimensao, Bucket[]>;
	arquivos: number;
	linhasInvalidas: number;
}

const DIMENSOES: Dimensao[] = ["dia", "modelo", "projeto", "sessao", "hora"];
const MIN_INPUT_PARA_PRECO = 200;
const RAZAO_CACHE_PADRAO = 10;

export function novoBucket(key: string): Bucket {
	return { key, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, semCache: 0, mensagens: 0 };
}

export function projetoDe(sessionDir: string): string {
	// "--Users-biel-Garime--" -> "Garime"; "--Users-biel--" -> "~"
	const nome = basename(sessionDir).replace(/^-+|-+$/g, "");
	const semHome = nome.replace(/^Users-[^-]+-?/, "");
	return semHome || "~";
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** preço de input cheio, em $/token, ou undefined se a mensagem não permite inferir */
function precoInputDe(u: Usage): number | undefined {
	const input = u.input ?? 0;
	const custo = u.cost?.input ?? 0;
	if (input >= MIN_INPUT_PARA_PRECO && custo > 0) return custo / input;
	return undefined;
}

function somar(b: Bucket, u: Usage, precoInput: number | undefined): void {
	const cacheRead = u.cacheRead ?? 0;
	const cacheWrite = u.cacheWrite ?? 0;
	const custoCacheRead = u.cost?.cacheRead ?? 0;
	const custoCacheWrite = u.cost?.cacheWrite ?? 0;
	let preco = precoInput;
	if (preco === undefined && cacheRead > 0 && custoCacheRead > 0) preco = (custoCacheRead / cacheRead) * RAZAO_CACHE_PADRAO;
	const semCacheDelta =
		(u.cost?.input ?? 0) + (u.cost?.output ?? 0) + (preco !== undefined ? (cacheRead + cacheWrite) * preco : custoCacheRead + custoCacheWrite);
	b.cost += u.cost?.total ?? 0;
	b.input += u.input ?? 0;
	b.output += u.output ?? 0;
	b.cacheRead += cacheRead;
	b.cacheWrite += cacheWrite;
	b.semCache += semCacheDelta;
	b.mensagens += 1;
}

/** Sessões duráveis sob `<agentDir>/durable-sessions`, como caminhos de `session.sqlite`. */
export function listarSessoesDuraveis(root: string, filtro: { cwd?: string } = {}): string[] {
	return listDurableSessions(root, filtro.cwd ? { cwd: filtro.cwd } : {}).map((ref) => ref.database);
}

export function listarSessoes(root: string, filtro: Filtro = {}): string[] {
	if (filtro.sessionFile) return [filtro.sessionFile];
	const dirs = filtro.sessionDir ? [filtro.sessionDir] : lerDir(root).map((d) => join(root, d)).filter(ehDir);
	const arquivos: string[] = [];
	for (const dir of dirs) {
		for (const nome of lerDir(dir)) if (nome.endsWith(".jsonl")) arquivos.push(join(dir, nome));
	}
	return arquivos;
}

function lerDir(p: string): string[] {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}

function ehDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

interface Entrada {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: { role?: string; provider?: string; model?: string; toolName?: string; usage?: Usage; content?: unknown };
	usage?: Usage;
	cwd?: string;
	name?: string;
}

/** Restringe à cadeia de parentId que termina em leafId. */
function apenasBranch(entradas: Entrada[], leafId: string): Entrada[] {
	const porId = new Map<string, Entrada>();
	for (const e of entradas) if (e.id) porId.set(e.id, e);
	const escolhidas = new Set<string>();
	let cursor: string | null | undefined = leafId;
	while (cursor && porId.has(cursor) && !escolhidas.has(cursor)) {
		escolhidas.add(cursor);
		cursor = porId.get(cursor)?.parentId;
	}
	return entradas.filter((e) => e.id && escolhidas.has(e.id));
}

/** Uma sessão carregada, no formato que o laço de agregação consome. */
interface Carga {
	entradas: Entrada[];
	projeto: string;
	sessaoId: string;
	titulo?: string;
	cwd?: string;
}

function projetoPorCwd(cwd: string | undefined, fallback: string): string {
	if (!cwd) return fallback;
	return cwd === homedir() ? "~" : basename(cwd) || "~";
}

/** Sessão JSONL do pi clássico. */
function carregarJsonl(arquivo: string, ledger: Ledger): Carga | null {
	let texto: string;
	try {
		texto = readFileSync(arquivo, "utf8");
	} catch {
		return null;
	}
	const entradas: Entrada[] = [];
	for (const linha of texto.split("\n")) {
		if (!linha.trim()) continue;
		try {
			entradas.push(JSON.parse(linha));
		} catch {
			ledger.linhasInvalidas += 1;
		}
	}
	const cabecalho = entradas.find((e) => e.type === "session");
	const titulo = entradas.find((e) => e.type === "session_info" && e.name)?.name ?? primeiroPrompt(entradas);
	return {
		entradas,
		projeto: projetoPorCwd(cabecalho?.cwd, projetoDe(join(arquivo, ".."))),
		sessaoId: basename(arquivo, ".jsonl"),
		...(titulo === undefined ? {} : { titulo }),
		...(cabecalho?.cwd === undefined ? {} : { cwd: cabecalho.cwd }),
	};
}

/** Sessão do pi durável (SQLite somente leitura) como entradas equivalentes. */
function carregarDuravel(arquivo: string): Carga | null {
	const session = readDurableSession(arquivo, { usage: true, users: 3 });
	if (!session) return null;
	const entradas: Entrada[] = session.usage.map((u) => {
		if (u.role === "assistant") {
			return {
				type: "message",
				timestamp: u.timestamp,
				message: { role: "assistant", provider: u.provider ?? "?", model: u.model ?? "?", usage: u.usage },
			};
		}
		if (u.role === "toolResult") {
			return {
				type: "message",
				timestamp: u.timestamp,
				message: { role: "toolResult", toolName: u.toolName ?? "?", usage: u.usage },
			};
		}
		// Resumo de compactação e afins: contam como "compaction", como no JSONL.
		return { type: "compaction", timestamp: u.timestamp, usage: u.usage };
	});
	const titulo = session.users[0]?.trim().split("\n")[0]?.trim().slice(0, 60);
	return {
		entradas,
		projeto: projetoPorCwd(session.cwd, "?"),
		sessaoId: session.id,
		...(titulo ? { titulo } : {}),
		...(session.cwd ? { cwd: session.cwd } : {}),
	};
}

/** Durável quando o caminho é o `session.sqlite` ou o diretório que o contém. */
function ehDuravel(arquivo: string): boolean {
	return arquivo.endsWith(".sqlite") || isDurablePath(arquivo);
}

/** Mesmo diretório, tolerando symlink (o durável guarda o cwd já resolvido). */
function mesmoCwd(a: string | undefined, b: string): boolean {
	if (!a) return false;
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

function primeiroPrompt(entradas: Entrada[]): string | undefined {
	for (const e of entradas) {
		if (e.type !== "message" || e.message?.role !== "user") continue;
		const c = e.message.content;
		const texto = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text : "")).join("") : "";
		const linha = texto.trim().split("\n")[0]?.trim();
		if (linha) return linha.slice(0, 60);
	}
	return undefined;
}

export function agregar(arquivos: string[], filtro: Filtro = {}): Ledger {
	const ledger: Ledger = {
		total: novoBucket("total"),
		por: { dia: [], modelo: [], projeto: [], sessao: [], hora: [] },
		arquivos: 0,
		linhasInvalidas: 0,
	};
	const mapas: Record<Dimensao, Map<string, Bucket>> = { dia: new Map(), modelo: new Map(), projeto: new Map(), sessao: new Map(), hora: new Map() };
	const precoPorModelo = new Map<string, number>();

	for (const arquivo of arquivos) {
		const duravel = ehDuravel(arquivo);
		const carga = duravel ? carregarDuravel(durableDbOf(arquivo)) : carregarJsonl(arquivo, ledger);
		if (!carga) continue;
		if (filtro.cwd && !mesmoCwd(carga.cwd, filtro.cwd)) continue;
		const { entradas, projeto, sessaoId, titulo } = carga;
		// A sessão durável não tem árvore: não há branch a recortar.
		const corpo = filtro.leafId && !duravel ? apenasBranch(entradas, filtro.leafId) : entradas;
		let contou = false;

		for (const e of corpo) {
			const ts = e.timestamp ?? "";
			if (filtro.desde && ts < filtro.desde) continue;
			if (filtro.ate && ts >= filtro.ate) continue;
			let u: Usage | undefined;
			let modelo: string;
			if (e.type === "message" && e.message) {
				u = e.message.usage;
				if (!u) continue;
				if (e.message.role === "assistant") modelo = `${e.message.provider ?? "?"}/${e.message.model ?? "?"}`;
				else if (e.message.role === "toolResult") modelo = `tool:${e.message.toolName ?? "?"}`;
				else continue;
			} else if (e.type === "compaction" && e.usage) {
				u = e.usage;
				modelo = "compaction";
			} else continue;

			let preco = precoInputDe(u);
			if (preco !== undefined) precoPorModelo.set(modelo, preco);
			else preco = precoPorModelo.get(modelo);

			const chaves: Record<Dimensao, string> = {
				dia: ts.slice(0, 10) || "?",
				hora: ts.slice(0, 13).replace("T", " ") || "?",
				modelo,
				projeto,
				sessao: sessaoId,
			};
			somar(ledger.total, u, preco);
			if (!contou) {
				contou = true;
				ledger.arquivos += 1;
			}
			for (const dim of DIMENSOES) {
				const chave = chaves[dim];
				let b = mapas[dim].get(chave);
				if (!b) {
					b = novoBucket(chave);
					mapas[dim].set(chave, b);
					if (dim === "sessao") {
						b.projeto = projeto;
						b.titulo = titulo;
					}
				}
				somar(b, u, preco);
				if (dim === "sessao") {
					if (!b.primeiro || ts < b.primeiro) b.primeiro = ts;
					if (!b.ultimo || ts > b.ultimo) b.ultimo = ts;
				}
			}
		}
	}
	for (const dim of DIMENSOES) {
		const lista = [...mapas[dim].values()];
		// tempo em ordem cronológica; o resto por custo
		if (dim === "dia" || dim === "hora") lista.sort((a, b) => a.key.localeCompare(b.key));
		else lista.sort((a, b) => b.cost - a.cost);
		ledger.por[dim] = lista;
	}
	return ledger;
}

// ---------- janelas de tempo ----------

export type Janela = "sessao" | "hoje" | "ontem" | "semana" | "mes" | "tudo";

export function janela(nome: Janela, agora = new Date()): { desde?: string; ate?: string } {
	const inicioDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
	const hoje = inicioDia(agora);
	const iso = (d: Date) => d.toISOString();
	switch (nome) {
		case "hoje":
			return { desde: iso(hoje) };
		case "ontem":
			return { desde: iso(new Date(hoje.getTime() - 86_400_000)), ate: iso(hoje) };
		case "semana":
			return { desde: iso(new Date(hoje.getTime() - 6 * 86_400_000)) };
		case "mes":
			return { desde: iso(new Date(hoje.getTime() - 29 * 86_400_000)) };
		default:
			return {};
	}
}

// ---------- formatação ----------

export function fmtTokens(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtUsd(n: number): string {
	return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

export function cacheHit(b: Bucket): number {
	const entrada = b.input + b.cacheRead + b.cacheWrite;
	return entrada > 0 ? b.cacheRead / entrada : 0;
}

export function economia(b: Bucket): number {
	return Math.max(0, b.semCache - b.cost);
}

function pad(s: string, n: number, dir: "l" | "r" = "r"): string {
	const falta = Math.max(0, n - [...s].length);
	return dir === "r" ? s + " ".repeat(falta) : " ".repeat(falta) + s;
}

export function linhaBucket(b: Bucket, larguraChave: number, rotulo = b.key): string {
	const entrada = b.input + b.cacheRead + b.cacheWrite;
	return [
		pad(rotulo, larguraChave),
		pad(fmtUsd(b.cost), 8, "l"),
		`in ${pad(fmtTokens(entrada), 6, "l")}`,
		`out ${pad(fmtTokens(b.output), 6, "l")}`,
		`cache ${pad(`${Math.round(cacheHit(b) * 100)}%`, 4, "l")}`,
		`poupou ${pad(fmtUsd(economia(b)), 6, "l")}`,
		pad(`${b.mensagens}msg`, 7, "l"),
	].join("  ");
}

export function rotuloSessao(b: Bucket): string {
	const curto = b.key.replace(/[^A-Za-z0-9]/g, "").slice(-6);
	const quando = b.primeiro ? b.primeiro.slice(5, 16).replace("T", " ") : "";
	return `${quando} ${curto} ${b.projeto ?? ""}${b.titulo ? ` · ${b.titulo}` : ""}`.trim();
}

export function relatorio(ledger: Ledger, dim: Dimensao, opts: { limite?: number; titulo?: string } = {}): string {
	const limite = opts.limite ?? 20;
	const t = ledger.total;
	const entradaTotal = t.input + t.cacheRead + t.cacheWrite;
	const linhas: string[] = [];
	if (opts.titulo) linhas.push(opts.titulo);
	linhas.push(
		`total ${fmtUsd(t.cost)} equiv. tabela · in ${fmtTokens(entradaTotal)} (${fmtTokens(t.input)} novo, ${fmtTokens(t.cacheRead)} cache) · out ${fmtTokens(t.output)} · cache hit ${Math.round(cacheHit(t) * 100)}% · sem cache seria ${fmtUsd(t.semCache)} → poupou ${fmtUsd(economia(t))} · ${t.mensagens} msgs em ${ledger.arquivos} sessões`,
	);
	linhas.push("");
	const lista = ledger.por[dim].slice(dim === "dia" || dim === "hora" ? -limite : 0, dim === "dia" || dim === "hora" ? undefined : limite);
	const rotulos = lista.map((b) => (dim === "sessao" ? rotuloSessao(b) : b.key));
	const largura = Math.min(64, Math.max(4, ...rotulos.map((r) => [...r].length)));
	lista.forEach((b, i) => linhas.push(linhaBucket(b, largura, rotulos[i]!.slice(0, largura))));
	const resto = ledger.por[dim].length - lista.length;
	if (resto > 0) linhas.push(`… +${resto} ${dim}(s)`);
	return linhas.join("\n");
}

export function parseArgs(args: string[]): { janela: Janela; dim: Dimensao; limite?: number; projetoAtual: boolean } {
	let jan: Janela | undefined;
	let dim: Dimensao | undefined;
	let limite: number | undefined;
	let projetoAtual = false;
	for (const a of args) {
		const v = a.toLowerCase();
		// "sessao" é janela E dimensão: sozinho é "esta sessão"; depois de uma janela é "por sessão"
		if (v === "sessao") {
			if (jan) dim = "sessao";
			else jan = "sessao";
		} else if (["hoje", "ontem", "semana", "mes", "tudo"].includes(v)) jan = v as Janela;
		else if (["dia", "modelo", "projeto", "hora"].includes(v)) dim = v as Dimensao;
		else if (v === "aqui") projetoAtual = true;
		else if (/^\d+$/.test(v)) limite = Number(v);
	}
	const janelaFinal = jan ?? "sessao";
	return { janela: janelaFinal, dim: dim ?? (janelaFinal === "sessao" ? "modelo" : "dia"), limite, projetoAtual };
}
