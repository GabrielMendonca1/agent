/**
 * ask-user — equivalente do AskUserQuestion do Claude Code.
 *
 * Registra a tool `ask_user`: quando o modelo precisa de uma decisão, ele
 * chama a tool com a pergunta e opções. A pergunta vive NA LINHA DA TOOL,
 * dentro do chat (rola junto com o histórico) — não no rodapé fixo. O editor
 * continua no lugar dele. O cursor é publicado como resultado parcial
 * (onUpdate) e a linha é redesenhada. Chamadas dentro de outras tools usam
 * o mesmo conteúdo num widget acima do editor enquanto aguardam resposta.
 *
 * Exceção nominal à regra native-tool-rendering: esta é a única tool que
 * exige a atenção do operador, então tem renderCall/renderResult próprios
 * (pequenos) para não parecer só mais uma caixa de ferramenta.
 *
 * Teclas enquanto a pergunta está aberta:
 *   ↑↓      move o cursor        1-9  escolhe direto
 *   enter   confirma a opção     esc  dispensa
 *   Texto digitado no editor + enter vira resposta livre.
 *
 * Sem UI, tenta o Megamind antes de pedir uma pergunta em texto plano.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createAskRequest, escalationDelay, normalizeOption } from "./ask-user-megamind.mjs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, visibleWidth, truncateToWidth, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

interface AskArgs {
	title?: string;
	question?: string;
	options?: string[];
	context?: string;
}

interface AskState {
	options: string[];
	selected: number;
	answer?: string;
	dismissed?: boolean;
	escalated?: boolean;
	remoteStatus?: string;
	source?: "terminal" | "Megamind";
}

const HINT = "↑↓ enter · 1-9 direto · esc dispensa · ou digite + enter";
const HINT_FREE = "digite + enter para responder · esc dispensa";

/** Quebra antes de pintar, com recuo pendente sob o texto da opção. */
function wrapped(text: string, width: number, prefix = ""): string[] {
	if (visibleWidth(prefix) >= width) {
		return wrapTextWithAnsi(prefix + text, Math.max(1, width)).map(line => truncateToWidth(line, width, ""));
	}
	const indent = " ".repeat(visibleWidth(prefix));
	return wrapTextWithAnsi(text, Math.max(1, width - indent.length))
		.map((line, i) => truncateToWidth((i ? indent : prefix) + line, width, ""));
}

export function renderHeader(args: AskArgs, _expanded: boolean, theme: any, width = 80): string {
	const lines: string[] = [];
	if (args.title) lines.push(...wrapped(args.title.trim(), width, "? ").map(line => theme.fg("accent", theme.bold(line))));
	if (args.question) lines.push(...wrapped(args.question.trim(), width).map(line => theme.fg("text", line)));
	if (args.context?.trim()) lines.push(...wrapped(args.context.trim(), width).map(line => theme.fg("muted", line)));
	return lines.join("\n");
}

export function renderList(st: Partial<AskState>, isPartial: boolean, _expanded: boolean, theme: any, width = 80): string {
	const options = st.options ?? [];
	const lines: string[] = [""];
	if (st.dismissed) return "\n" + wrapped("dispensada", width, "✗ ").map(line => theme.fg("muted", line)).join("\n");
	const idx = isPartial ? st.selected : st.answer === undefined ? -1 : options.indexOf(st.answer);
	for (let i = 0; i < options.length; i++) {
		const chosen = i === idx;
		const label = options[i] + (chosen ? "  ← escolhido" : "");
		lines.push(...wrapped(label, width, `${chosen ? "●" : "○"} ${i + 1}. `).map(line => theme.fg(chosen ? "accent" : "text", line)));
	}
	if (isPartial && (st.remoteStatus || st.escalated)) lines.push(...wrapped(st.remoteStatus || "também enviada ao Megamind", width).map(line => theme.fg("dim", line)));
	if (!isPartial && st.source === "Megamind" && st.answer !== undefined) lines.push(...wrapped(st.answer, width, "↩ via Megamind ").map(line => theme.fg("success", line)));
	if (isPartial) lines.push(...wrapped(options.length ? HINT : HINT_FREE, width).map(line => theme.fg("dim", line)));
	else if (st.answer !== undefined && idx < 0) lines.push(...wrapped(st.answer, width, "✎ ").map(line => theme.fg("success", line)));
	return lines.join("\n");
}

/** A largura só está disponível quando a TUI renderiza o componente. */
function responsive(build: (width: number) => string) {
	return { render: (width: number) => build(width).split("\n"), invalidate() {} };
}

const GOAL_RUNNING = "Goal em execução: decida e registre no audit; se for linha vermelha, adie e registre também no state.md.";
const GOAL_UNREADABLE = "Não foi possível verificar o estado do goal. Confira state.md; decida e registre no audit ou adie se for linha vermelha.";

/**
 * Estado persistido, reavaliado em cada chamada, inclusive após retomada.
 * Escopo conservador: qualquer goal running em <ctx.cwd>/.pi/goals bloqueia
 * esta sessão; não adivinha dono por PID nem procura em pais/outros worktrees.
 * blocked/done/stopped não bloqueiam. Falha de leitura não libera perguntas.
 */
function goalQuestionBlock(cwd: string): string | undefined {
	const goals = join(cwd, ".pi", "goals");
	try {
		for (const entry of readdirSync(goals, { withFileTypes: true })) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			try {
				const firstLine = readFileSync(join(goals, entry.name, "state.md"), "utf8").split(/\r?\n/, 1)[0];
				if (/^# goal \S+ — running\s*$/.test(firstLine)) return GOAL_RUNNING;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return GOAL_UNREADABLE;
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return GOAL_UNREADABLE;
	}
}

export default function askUser(pi: ExtensionAPI) {
	const nestedCalls = new Set<string>();
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "ask_user") return;
		const reason = goalQuestionBlock(ctx.cwd);
		if (reason) return { block: true, reason };
		if (event.parentToolCallId) nestedCalls.add(event.toolCallId);
	});
	pi.on("tool_result", (event) => { nestedCalls.delete(event.toolCallId); });
	pi.on("session_start", () => { nestedCalls.clear(); });

	pi.registerTool({
		name: "ask_user",
		label: "Perguntar",
		description:
			"Ask the user a question with selectable options when essential information is missing and you cannot find it yourself, or when you need authorization for a consequential action. Decide routine choices yourself.",
		promptSnippet: "Ask the user to pick an option when you need their decision",
		promptGuidelines: [
			"Use ask_user when you need the user's input: give a short title that explains why the decision is needed, the question and 2-4 concrete options. Avoid generic titles like 'Choose an option'. The user can also type a free answer. Do not repeat the question as text after calling it.",
		],
		parameters: Type.Object({
			title: Type.String({
				description: "Short, informative title: why this decision is needed or what it affects",
			}),
			question: Type.String({ description: "The question, short and direct" }),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "2-4 concrete options. Omit for a free-form answer.",
					minItems: 2,
					maxItems: 6,
				}),
			),
			context: Type.Optional(Type.String({ description: "Extra context shown to the user" })),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			// Defesa também para invocação direta e mudança de estado após tool_call.
			const reason = goalQuestionBlock(ctx.cwd);
			if (reason) {
				nestedCalls.delete(_id);
				return { content: [{ type: "text" as const, text: reason }], isError: true };
			}
			const fallback = () => ({ content: [{ type: "text" as const, text: "Usuário não está disponível interativamente agora. Faça a pergunta numa mensagem normal e aguarde a próxima resposta dele." }] });

			const options = params.options && params.options.length >= 2 ? params.options.map(normalizeOption) : [];
			const state: AskState = { options, selected: 0 };
			const nested = nestedCalls.delete(_id);
			const widgetId = `ask-user:${_id}`;
			let widgetVisible = false;
			const clearWidget = () => {
				if (!widgetVisible) return;
				widgetVisible = false;
				ctx.ui.setWidget(widgetId, undefined);
			};
			const publish = () => {
				onUpdate?.({ content: [{ type: "text", text: "aguardando resposta…" }], details: { ...state } });
				if (nested && ctx.hasUI) {
					widgetVisible = true;
					ctx.ui.setWidget(widgetId, (_tui, theme) => responsive(width =>
						renderHeader(params, true, theme, width) + "\n" + renderList(state, true, true, theme, width)),
					{ placement: "aboveEditor" });
				}
			};
			try {
				publish();

				let remoteFailed = false;
				const answer = await new Promise<string | undefined>((resolve) => {
					let unsubscribe: (() => void) | undefined;
					let settled = false;
					let timer: ReturnType<typeof setTimeout> | undefined;
					let bound: ReturnType<typeof setTimeout> | undefined;
					let remote: Awaited<ReturnType<typeof createAskRequest>> | undefined;
					const creation = new AbortController();
					const finish = (value: string | undefined, source: "terminal" | "Megamind" = "terminal") => {
						if (settled) return;
						settled = true;
						clearWidget();
						state.source = source;
						state.answer = value;
						clearTimeout(timer);
						clearTimeout(bound);
						signal?.removeEventListener("abort", onAbort);
						unsubscribe?.();
						creation.abort();
						remote?.stop();
						if (source !== "terminal" || !remote) { resolve(value); return; }
						// Limita a arbitragem; a limpeza continua sem prender a tool.
						const closing = remote.close(value);
						if (signal?.aborted || value === undefined) { void closing; resolve(value); return; }
						let deadline: ReturnType<typeof setTimeout>;
						void Promise.race([
							closing,
							new Promise<undefined>(done => { deadline = setTimeout(() => done(undefined), 3_000); }),
						]).then(result => {
							clearTimeout(deadline);
							if (result) { state.source = "Megamind"; resolve(result.answer); }
							else resolve(value);
						});
					};
					const onAbort = () => finish(undefined);
					if (signal?.aborted) return finish(undefined);
					signal?.addEventListener("abort", onAbort, { once: true });
					const escalate = () => {
						if (settled) return;
						void createAskRequest({ ...params, options }, creation.signal, ctx.sessionManager?.getSessionId?.()).then(async created => {
							remote = created;
							if (settled) { void remote.close(state.source === "terminal" ? state.answer : undefined); return; }
							state.escalated = true;
							publish();
							const result = await remote.wait(retrying => {
								if (settled) return;
								state.remoteStatus = retrying ? "Megamind indisponível; tentando novamente" : undefined;
								publish();
							});
							if (settled) return;
							if (result) finish(result.answer, "Megamind");
							else {
								state.remoteStatus = "Megamind encerrado; responda no terminal";
								publish();
								if (!ctx.hasUI) { remoteFailed = true; finish(undefined); }
							}
						}).catch(() => {
							if (settled) return;
							state.remoteStatus = "Megamind indisponível; responda no terminal";
							publish();
							if (!ctx.hasUI) { remoteFailed = true; finish(undefined); }
						});
					};
					const delay = escalationDelay();
					if (!ctx.hasUI) {
						if (delay < 0) { remoteFailed = true; finish(undefined); return; }
						bound = setTimeout(() => { remoteFailed = true; finish(undefined); }, 30 * 60_000);
						escalate();
						return;
					}
					if (delay >= 0) timer = setTimeout(escalate, delay);

					unsubscribe = ctx.ui.onTerminalInput((data) => {
						// Protocolo kitty (Ghostty) manda press E release; só o press conta.
						if (isKeyRelease(data)) return undefined;
						const typed = ctx.ui.getEditorText().trim();

						if (matchesKey(data, "escape")) {
							finish(undefined);
							return { consume: true };
						}
						if (matchesKey(data, "enter")) {
							if (typed) {
								ctx.ui.setEditorText("");
								finish(typed);
								return { consume: true };
							}
							if (options.length > 0) {
								finish(options[state.selected]);
								return { consume: true };
							}
							return undefined;
						}
						if (options.length === 0 || typed) return undefined; // usuário está escrevendo; não roubar teclas

						if (matchesKey(data, "up")) {
							state.selected = Math.max(0, state.selected - 1);
							publish();
							return { consume: true };
						}
						if (matchesKey(data, "down")) {
							state.selected = Math.min(options.length - 1, state.selected + 1);
							publish();
							return { consume: true };
						}
						if (/^[1-9]$/.test(data)) {
							const idx = Number(data) - 1;
							if (idx < options.length) {
								finish(options[idx]);
								return { consume: true };
							}
						}
						return undefined;
					});
				});

				if (!ctx.hasUI && remoteFailed) return fallback();
				const clean = answer?.trim();
				if (!clean) {
					state.dismissed = true;
					return {
						content: [{ type: "text", text: `O usuário dispensou a pergunta (${state.source}). Siga com o melhor julgamento e diga o que assumiu.` }],
						details: { ...state },
					};
				}
				state.answer = clean;
				return { content: [{ type: "text", text: `Resposta do usuário (${state.source}): ${clean}` }], details: { ...state } };
			} finally {
				clearWidget();
			}
		},

		renderCall(args, theme, context) {
			return responsive(width => renderHeader(args as AskArgs, context?.expanded ?? true, theme, width));
		},

		renderResult(result, { expanded = true, isPartial }, theme) {
			return responsive(width => renderList((result.details ?? {}) as Partial<AskState>, isPartial, expanded, theme, width));
		},
	});
}
