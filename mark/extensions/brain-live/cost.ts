/**
 * /cost — custo e tokens além da sessão.
 *
 * O rodapé e a linha do loader já mostram o gasto DESTA sessão, ao vivo. O que
 * faltava era olhar para trás: quanto foi hoje, esta semana, por modelo, por
 * projeto, por sessão — e quanto o cache poupou. Tudo sai do que o pi já grava:
 * os JSONL oficiais e os `session.sqlite` das sessões duráveis (lidos somente
 * para leitura). Nada novo é persistido.
 *
 *   /cost                      esta sessão, por modelo
 *   /cost hoje                 hoje, por dia (1 linha) — combine com dimensão:
 *   /cost hoje modelo          hoje, por modelo
 *   /cost semana projeto       7 dias, por projeto
 *   /cost mes sessao 30        30 dias, 30 sessões mais caras
 *   /cost tudo dia             tudo, por dia
 *   /cost semana aqui          7 dias, só sessões deste projeto
 *
 * Janelas: sessao · hoje · ontem · semana · mes · tudo
 * Dimensões: dia · hora · modelo · projeto · sessao
 *
 * "poupou" = o que o cache economizou em relação a pagar tudo como input novo.
 * Custo é valor de tabela do modelo (com OAuth de assinatura, é referência).
 */

import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { durableRoot } from "./lib/durable-sessions.ts";
import { agregar, janela, listarSessoes, listarSessoesDuraveis, parseArgs, relatorio } from "./lib/cost-ledger.ts";

const JANELAS = ["sessao", "hoje", "ontem", "semana", "mes", "tudo"];
const DIMENSOES = ["dia", "hora", "modelo", "projeto", "sessao", "aqui"];

export default function costExtension(pi: ExtensionAPI) {
	pi.registerCommand("cost", {
		description: "Custo/tokens: /cost [sessao|hoje|ontem|semana|mes|tudo] [dia|hora|modelo|projeto|sessao] [aqui] [N]",
		getArgumentCompletions: (prefix) => {
			const partes = prefix.split(/\s+/);
			const atual = partes.pop() ?? "";
			const fonte = partes.length === 0 ? JANELAS : DIMENSOES;
			const base = partes.length ? `${partes.join(" ")} ` : "";
			const itens = fonte.filter((v) => v.startsWith(atual)).map((v) => ({ value: `${base}${v}`, label: v }));
			return itens.length ? itens : null;
		},
		handler: async (args, ctx) => {
			const opts = parseArgs(args.trim().split(/\s+/).filter(Boolean));
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			const sessionDir = ctx.sessionManager.getSessionDir?.() ?? (sessionFile ? dirname(sessionFile) : undefined);
			const root = sessionDir ? dirname(sessionDir) : undefined;
			// Optional read-only history; current sessions are always official JSONL.
			const raizDuravel = root ? durableRoot(dirname(root)) : undefined;
			if (!root) {
				ctx.ui.notify("Não achei o diretório de sessões.", "error");
				return;
			}

			const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : undefined;
			let titulo: string;
			let arquivos: string[];
			let filtro: Parameters<typeof agregar>[1] = {};
			if (opts.janela === "sessao") {
				if (!sessionFile) {
					ctx.ui.notify("Sessão ainda não foi gravada em disco.", "warning");
					return;
				}
				arquivos = [sessionFile];
				filtro = { leafId: ctx.sessionManager.getLeafId?.() ?? undefined };
				titulo = "esta sessão";
			} else {
				// "aqui": JSONL do host clássico filtra por diretório-projeto; o resto por cwd.
				const porDir = opts.projetoAtual && sessionDir;
				arquivos = listarSessoes(root, porDir ? { sessionDir } : {});
				if (raizDuravel) {
					arquivos = arquivos.concat(
						listarSessoesDuraveis(raizDuravel, opts.projetoAtual && cwd ? { cwd } : {}),
					);
				}
				filtro = janela(opts.janela);
				if (opts.projetoAtual && !porDir && cwd) filtro = { ...filtro, cwd };
				titulo = `${opts.janela}${opts.projetoAtual ? " · este projeto" : ""}`;
			}

			const ledger = agregar(arquivos, filtro);
			if (ledger.total.mensagens === 0) {
				ctx.ui.notify(`Sem uso registrado em "${titulo}".`, "info");
				return;
			}
			const texto = relatorio(ledger, opts.dim, { limite: opts.limite, titulo: `/cost ${titulo} · por ${opts.dim}` });
			pi.sendMessage({ customType: "cost-report", content: texto, display: true }, { triggerTurn: false });
		},
	});
}
