/**
 * Agent loader no transcript, após a última mensagem/tool.
 * Requer runtime com placement público afterTranscript; ativar só após a release.
 * Quadros a 250 ms, contadores amostrados separadamente a 1000 ms.
 *
 * RUNTIME ANTIGO: nada a detectar. O `setExtensionWidget` dos runtimes sem a
 * camada de transcript (0.99.x, 1.0.0 e 1.0.2 pré-camada, verificado no dist)
 * resolve o placement por eliminação — `placement === "belowEditor" ? abaixo :
 * acima` — então um placement desconhecido cai em `aboveEditor`: a linha aparece
 * acima do input, como na versão anterior, sem erro e sem desaparecer. Detecção
 * de capacidade seria código morto; o teste de ciclo de vida fixa esse contrato.
 */

import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	appearanceOverride,
	claudeStyleEnabled,
	paint,
	paletteFor,
	STAR,
	type ThemeLike,
} from "./claude-style";

const WIDGET = "garime-loader";

/**
 * Frase do momento, publicada por outra extensão (ex.: `whimsical.ts`) no barramento
 * `pi.events`. O loader não sorteia nada: só mostra a última frase recebida enquanto
 * o MODELO trabalha. Quando uma ferramenta roda, o verbo da ferramenta tem prioridade,
 * porque "Lendo loader.ts" informa e "Percolating…" só distrai.
 */
export const FRASE_EVENTO = "garime:frase";

const VERBOS: Record<string, string> = {
	read: "Lendo",
	bash: "Rodando",
	edit: "Editando",
	write: "Escrevendo",
	grep: "Procurando",
	find: "Procurando",
	ls: "Listando",
	codemode: "Executando",
	subagent: "Delegando",
	generate_image: "Desenhando",
	ask_user: "Perguntando",
	checks: "Verificando",
	plan: "Planejando",
	todo: "Anotando",
};

/** O verbo da ferramenta em uso; ferramenta desconhecida usa o próprio nome. */
export function verboDe(toolName: string | undefined): string | undefined {
	if (!toolName) return undefined;
	return VERBOS[toolName] ?? undefined;
}

/** `"Percolating..."` → `"Percolating"`: o loader põe as próprias reticências. */
export function limparFrase(texto: unknown): string | undefined {
	if (typeof texto !== "string") return undefined;
	const limpo = texto.trim().replace(/(\.{2,}|…)+$/u, "").trim();
	return limpo ? limpo.slice(0, 60) : undefined;
}

const QUADROS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Pulso do estilo Claude Code: a estrela cresce e volta, na mesma célula. */
const QUADROS_CLAUDE = [STAR, "✶", "✳", "✢", "·", "✢", "✳", "✶"];
const ATUALIZACAO_MS = 250;
const AMOSTRAGEM_MS = 1000;

/**
 * Teto de entradas varridas por tique. A amostragem normal ve UMA entrada (a
 * que ainda esta chegando); o teto so existe para que um salto de branch nao
 * vire uma varredura de milhares de mensagens dentro do relogio.
 */
const AMOSTRA_MAX = 64;

/** Abaixo disto a linha vira ruído: some e devolve a largura ao que importa. */
const LARGURA_MINIMA = 40;

export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * `1m12s`, não `72s` nem `00:01:12`. Segundo cru obriga a dividir de cabeça, e
 * relógio de dois pontos parece hora do dia.
 */
export function fmtDuracao(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * O que a ferramenta está tocando, em uma palavra. Cada ferramenta guarda o alvo
 * num campo diferente, e nenhuma promete que ele existe: sem alvo reconhecível a
 * linha mostra só o verbo, em vez de inventar rótulo.
 */
export function alvoDe(toolName: string, args: any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const caminho = args.path ?? args.file ?? args.filePath ?? args.notebook_path;
	if (typeof caminho === "string" && caminho) return basename(caminho);
	if (typeof args.pattern === "string" && args.pattern) return args.pattern.slice(0, 24);
	if (typeof args.command === "string" && args.command) {
		// do comando inteiro só o executável interessa: `rg -n foo bar` -> `rg`
		return args.command.trim().split(/\s+/)[0]?.slice(0, 24);
	}
	if (typeof args.url === "string" && args.url) {
		try {
			return new URL(args.url).hostname;
		} catch {
			return undefined;
		}
	}
	return toolName || undefined;
}

/**
 * Monta a linha com esquerda e direita coladas nas bordas. Quando não cabe, o
 * lado ESQUERDO cede: verbo e alvo são contexto, enquanto tempo e gasto são os
 * números que a pessoa está esperando ver crescer.
 */
export function montarLinha(esquerda: string, direita: string, largura: number): string | undefined {
	if (largura < LARGURA_MINIMA) return undefined;
	if (direita.length >= largura) return direita.slice(0, largura);
	const espacoEsquerda = Math.max(0, largura - direita.length - 2);
	const corte = esquerda.length > espacoEsquerda ? `${esquerda.slice(0, Math.max(0, espacoEsquerda - 1))}…` : esquerda;
	return corte + " ".repeat(Math.max(2, largura - corte.length - direita.length)) + direita;
}

export interface Totais {
	input: number;
	output: number;
	custo: number;
}

interface Estado {
	trabalhando: boolean;
	inicio: number;
	verbo: string;
	/** verbo da ferramenta em uso, se houver */
	verboFerramenta?: string;
	/** última frase recebida pelo barramento */
	frase?: string;
	alvo?: string;
	quadro: number;
	totais: Totais;
}

export function textoDireita(input: number, output: number, custo: number, decorrido: number): string {
	return `${fmtDuracao(decorrido)}  in ${fmtTokens(input)} out ${fmtTokens(output)}  $${custo.toFixed(2)}`;
}

export function textoEsquerda(estado: Estado): string {
	const giro = QUADROS[estado.quadro % QUADROS.length];
	const verbo = estado.verboFerramenta ?? estado.frase ?? estado.verbo;
	return estado.alvo ? `${giro} ${verbo}…  ${estado.alvo}` : `${giro} ${verbo}…`;
}

/**
 * Linha do loader no estilo Claude Code:
 *
 *   ✻ Verificando… (12s · ↑ 1.2k tokens · esc to interrupt)
 *
 * Uma linha só, alinhada à esquerda: tempo, tokens e o jeito de interromper
 * ficam entre parênteses, como no Claude Code. O custo sai de cena (ele já vive
 * no rodapé) para a linha caber em 60 colunas.
 *
 * A cor do verbo: a fábrica do widget recebe `(tui, theme)`, então o tema ATIVO
 * chega aqui e a linha acompanha claro/escuro e hot-swap. Sem tema, usa cc-agent
 * escuro; GARIME_CLAUDE_APPEARANCE e GARIME_CLAUDE_ACCENT continuam disponíveis.
 */
export function linhaClaude(
	estado: Pick<Estado, "quadro" | "verbo" | "verboFerramenta" | "frase" | "alvo" | "totais">,
	decorrido: number,
	env: NodeJS.ProcessEnv = process.env,
	theme?: ThemeLike,
): string {
	const giro = QUADROS_CLAUDE[estado.quadro % QUADROS_CLAUDE.length];
	const verbo = estado.verboFerramenta ?? estado.frase ?? estado.verbo;
	const alvo = estado.alvo ? ` ${estado.alvo}` : "";
	const meta = `(${fmtDuracao(decorrido)} · ↑ ${fmtTokens(estado.totais.input + estado.totais.output)} tokens · esc to interrupt)`;
	const p = paletteFor(theme ?? { appearance: appearanceOverride(env) ?? "dark" }, env);
	return `${paint(`${giro} `, { fg: p.accent })}${paint(`${verbo}…${alvo}`, { fg: p.accent, italic: true })} ${paint(meta, { fg: p.dim })}`;
}

/**
 * Uma extensao recarregada roda `instalar` de novo, com timers e widget novos,
 * enquanto a instancia velha continua viva na memoria com o `pi` antigo. Sem
 * este registro por processo o reload multiplica relogios: dois tiques por
 * segundo depois do primeiro reload, tres depois do segundo. O registro e
 * global de proposito — o vazamento tambem e.
 */
const REGISTRO = Symbol.for("garime.loader.instancia");

interface Instancia {
	desligar(): void;
}

function somarEntrada(alvo: Totais, entrada: any): void {
	if (!entrada || entrada.type !== "message" || entrada.message?.role !== "assistant") return;
	const m = entrada.message as AssistantMessage;
	const usage = m.usage;
	if (!usage) return;
	// mesma conta do rodapé: cacheRead é a maior parte do que entra
	alvo.input += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	alvo.output += usage.output ?? 0;
	alvo.custo += usage.cost?.total ?? 0;
}

function instalar(pi: ExtensionAPI): void {
	const anterior = (globalThis as any)[REGISTRO] as Instancia | undefined;
	anterior?.desligar?.();

	const estado: Estado = {
		trabalhando: false,
		inicio: 0,
		verbo: "Trabalhando",
		quadro: 0,
		totais: { input: 0, output: 0, custo: 0 },
	};
	let relogio: ReturnType<typeof setInterval> | undefined;
	let contexto: ExtensionContext | undefined;
	let tui: any;
	let ultimoQuadroPedido = 0;
	let ultimaAmostra = 0;
	let vivo = true;

	/**
	 * Prefixo ja fechado da branch. `indice` e a primeira entrada ainda NAO
	 * congelada; tudo antes dela ja esta somado em `totais` e nunca mais e lido.
	 * A ultima entrada da branch fica sempre de fora porque ela ainda esta
	 * sendo escrita: congela-la travaria os numeros no meio do streaming.
	 */
	let congelados: { indice: number; totais: Totais } = { indice: 0, totais: { input: 0, output: 0, custo: 0 } };

	function zerarCache(): void {
		congelados = { indice: 0, totais: { input: 0, output: 0, custo: 0 } };
		estado.totais = { input: 0, output: 0, custo: 0 };
	}

	/**
	 * O unico lugar que toca a sessao. `completo` (evento de agent_start) alcanca
	 * a branch inteira de uma vez; o tique usa a janela limitada, entao o custo
	 * por segundo nao cresce com o tamanho do chat.
	 */
	function amostrar(ctx: ExtensionContext, completo = false): void {
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		// branch trocada ou rebobinada (fork, /rewind): o prefixo antigo mente.
		if (branch.length < congelados.indice) zerarCache();
		const teto = completo ? branch.length : Math.min(branch.length, congelados.indice + AMOSTRA_MAX);
		const congelavel = Math.max(congelados.indice, Math.min(teto, branch.length - 1));
		for (let i = congelados.indice; i < congelavel; i++) somarEntrada(congelados.totais, branch[i]);
		congelados.indice = congelavel;
		const totais: Totais = { ...congelados.totais };
		for (let i = congelavel; i < teto; i++) somarEntrada(totais, branch[i]);
		estado.totais = totais;
	}

	/**
	 * ARMADILHA que custou uma versao: nao existe `ui.getWidth()` na API de extensao.
	 * Entregar `string[]` obriga a ADIVINHAR a largura, e o palpite (100) desenhava a
	 * linha morrendo no meio de um terminal de 180 colunas — os numeros pareciam
	 * flutuar no vazio em vez de encostar na borda direita.
	 *
	 * A forma de FABRICA existe justamente para isso: o `render(width)` do componente
	 * recebe a largura real do viewport a cada quadro, inclusive quando a janela e
	 * redimensionada. O widget e instalado UMA vez; o tique do giro so pede novo
	 * quadro, em vez de reinstalar o widget a cada segundo.
	 *
	 * `render` e O(1) e nao fala com ninguem: le numeros ja calculados. Ele roda a
	 * cada quadro de streaming, muitas vezes por segundo, e sob esse ritmo qualquer
	 * getBranch/readFile/JSON ali dentro vira o custo dominante da TUI.
	 */
	function instalarWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(
			WIDGET,
			(tuiRef: any, themeRef?: any) => {
				tui = tuiRef;
				return {
					render(width: number): string[] {
						if (!estado.trabalhando) return [];
						if (claudeStyleEnabled()) {
							if (width < 24) return [];
							// `themeRef` é o tema ativo do host (proxy vivo): ler aqui custa O(1)
							// e segue a troca de tema sem reinstalar o widget.
							return [linhaClaude(estado, Date.now() - estado.inicio, process.env, themeRef as ThemeLike | undefined)];
						}
						const { input, output, custo } = estado.totais;
						const linha = montarLinha(
							textoEsquerda(estado),
							textoDireita(input, output, custo, Date.now() - estado.inicio),
							width,
						);
						return linha ? [linha] : [];
					},
					dispose() {
						// so solta a referencia se ainda for a MINHA: um widget novo
						// instalado antes do dispose do velho nao pode ser apagado.
						if (tui === tuiRef) tui = undefined;
					},
				};
			},
			{ placement: "afterTranscript" },
		);
	}

	/**
	 * Teto duro de quatro repaints por segundo. Ferramenta rapida dispara start/end aos
	 * pares dezenas de vezes por segundo; sem o teto cada par vira um repaint do
	 * transcript. O quadro represado nao se perde nem precisa de timer proprio: o
	 * tique de 250 ms, que ja existe enquanto o agente trabalha, o entrega.
	 */
	function pedirQuadro(): void {
		const agora = Date.now();
		if (agora - ultimoQuadroPedido < ATUALIZACAO_MS) return;
		ultimoQuadroPedido = agora;
		tui?.requestRender?.();
	}

	function pintar(): void {
		const ctx = contexto;
		if (!vivo || !ctx?.ui?.setWidget) return;
		if (!estado.trabalhando) {
			ctx.ui.setWidget(WIDGET, undefined, { placement: "afterTranscript" });
			return;
		}
		if (!tui) instalarWidget(ctx);
		pedirQuadro();
	}

	/** Idempotente: um relogio por instancia, criado so quando falta. */
	function ligarRelogio(): void {
		if (relogio || !vivo) return;
		relogio = setInterval(() => {
			estado.quadro += 1;
			// A branch e varrida AQUI, uma vez por segundo e em janela limitada —
			// nunca dentro de render().
			if (contexto && Date.now() - ultimaAmostra >= AMOSTRAGEM_MS) {
				ultimaAmostra = Date.now();
				amostrar(contexto);
			}
			pintar();
		}, ATUALIZACAO_MS);
		// O tique não pode segurar o processo vivo no fim da sessão.
		relogio.unref?.();
	}

	function desligarRelogio(): void {
		if (!relogio) return;
		clearInterval(relogio);
		relogio = undefined;
	}

	function comecar(ctx: ExtensionContext): void {
		if (!vivo) return;
		contexto = ctx;
		estado.trabalhando = true;
		estado.inicio = Date.now();
		estado.alvo = undefined;
		estado.verboFerramenta = undefined;
		estado.quadro = 0;
		amostrar(ctx, true);
		ultimaAmostra = Date.now();
		ligarRelogio();
		// o teto NAO e zerado aqui de proposito: turno novo em menos de 250 ms
		// (cadeia de sub-agentes) nao pode furar a fila. A linha aparece na hora de
		// qualquer forma, porque instalar o widget ja e um repaint do pi.
		pintar();
	}

	/**
	 * Fim de turno, fim de sessao e reload passam todos por aqui: o widget sai da
	 * tela, o relogio morre e nenhuma closure fica segurando o ctx da sessao — que
	 * carrega a branch inteira atras dele.
	 */
	function parar(): void {
		estado.trabalhando = false;
		desligarRelogio();
		pintar();
		tui = undefined;
		contexto = undefined;
	}

	/**
	 * O indicador nativo (o logo em pixels com "Brewing...") sai de cena: com a linha
	 * no transcript, seriam DOIS avisos de que o agente esta trabalhando, e o nativo
	 * ocupava quatro linhas no meio do grafo de cards para dizer menos.
	 *
	 * `setWorkingVisible(false)` e API publica de extensao, entao nada disto exige
	 * patch no nucleo. `setWorkingIndicator({ frames: [] })` acompanha porque as duas
	 * chaves sao independentes: a primeira esconde a LINHA, a segunda zera o desenho
	 * animado. Sem a segunda, uma mudanca futura no pi que volte a exibir a linha
	 * traria o logo de volta junto.
	 *
	 * Idempotente e barato: chamado a cada session_start, e nao a cada quadro.
	 */
	function calarIndicadorNativo(ctx: ExtensionContext): void {
		ctx.ui?.setWorkingVisible?.(false);
		ctx.ui?.setWorkingIndicator?.({ frames: [] });
	}

	const instancia: Instancia = {
		desligar() {
			if (!vivo) return;
			parar();
			vivo = false;
			zerarCache();
			if ((globalThis as any)[REGISTRO] === instancia) (globalThis as any)[REGISTRO] = undefined;
		},
	};
	(globalThis as any)[REGISTRO] = instancia;

	pi.on("session_start", async (_e, ctx) => {
		// sessao nova, branch nova: o prefixo congelado da anterior nao vale mais.
		// Nao liga relogio nem instala widget — varios session_start seguidos
		// (reload de sessao, /new) nao podem multiplicar nada.
		if (!vivo) return;
		contexto = ctx;
		estado.trabalhando = false;
		desligarRelogio();
		zerarCache();
		calarIndicadorNativo(ctx);
	});

	pi.on("agent_start", async (_e, ctx) => {
		calarIndicadorNativo(ctx);
		comecar(ctx);
	});
	pi.on("agent_end", async () => parar());
	pi.on("session_shutdown", async () => parar());
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!vivo) return;
		contexto = ctx;
		estado.verboFerramenta = verboDe(event.toolName);
		estado.alvo = alvoDe(event.toolName, event.args);
		pintar();
	});
	pi.on("tool_execution_end", async () => {
		if (!vivo) return;
		estado.verboFerramenta = undefined;
		estado.alvo = undefined;
		pintar();
	});
	// Frase de quem quiser publicar. `events` pode faltar em hosts de teste.
	pi.events?.on?.(FRASE_EVENTO, (dados: unknown) => {
		if (!vivo) return;
		const frase = limparFrase((dados as { texto?: unknown } | undefined)?.texto);
		if (!frase) return;
		estado.frase = frase;
		pintar();
	});
}

export default function (pi: ExtensionAPI) {
	instalar(pi);
}
