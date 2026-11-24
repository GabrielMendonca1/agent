/**
 * checkpoints — /rewind: desfaz as edições de arquivo do agente até um turno escolhido.
 *
 * Antes de cada `edit`/`write` da sessão principal (inclusive chamadas aninhadas, ex. codemode),
 * guarda o conteúdo anterior do arquivo — ou o marcador "não existia" — associado à entrada do
 * usuário que abriu o turno. Só a primeira mudança de cada arquivo por turno vira snapshot.
 * Depois de cada edição registra o hash que o agente deixou; no /rewind, hash diferente no disco
 * significa mudança por fora (editor, bash, outro processo) e pede confirmação.
 *
 * Bash da sessão principal não é rastreado. Filhos (AGENT_CHILD=1) não gravam; o pai
 * compara o antes/depois de escritores que executam direto num checkout Git, sem atribuir autoria.
 *
 * Disco: `<perfil>/checkpoints/<sessionId>/` com `index.jsonl` (append-only) e `blobs/<sha256>`.
 * Persistem ao retomar a sessão (mesmo sessionId). Limpeza no session_start: sessões sem uso há
 * AGENT_CHECKPOINTS_DAYS dias (30) e, acima de AGENT_CHECKPOINTS_MAX_MB (500), as mais antigas.
 * AGENT_CHECKPOINTS=0 desliga tudo (nem grava nem registra o comando).
 *
 * Não registra tool nem mexe no prompt: é só comando do usuário.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { lastUser, oneLine, Store, textOf } from "./lib/checkpoint-store.ts";
export { type Plan, Store } from "./lib/checkpoint-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROMPT_WIDTH = 60;
const FILES_SHOWN = 3;
const TRACKED = new Set(["edit", "write"]);

export const BASH_NOTE = "edit/write da sessão e escritores sem worktree em Git; bash da sessão não é rastreado";

const num = (raw: string | undefined, fallback: number) => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Mesma resolução de caminho das tools edit/write do Pi (resolveToCwd). */
export function resolveToolPath(input: string, cwd: string): string {
	let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	if (/^file:\/\//.test(p)) p = fileURLToPath(p);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function dirSize(dir: string): number {
	let total = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) total += dirSize(p);
		else
			try {
				total += statSync(p).size;
			} catch {
				/* sumiu */
			}
	}
	return total;
}

/** Apaga sessões velhas e, acima do teto, as menos recentes. Nunca a sessão atual. */
export function prune(root: string, keep: string, maxDays: number, maxMb: number, now = Date.now()) {
	if (!existsSync(root)) return;
	const sessions = readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name !== keep)
		.map((e) => {
			const dir = join(root, e.name);
			let mtime = 0;
			try {
				mtime = statSync(join(dir, "index.jsonl")).mtimeMs;
			} catch {
				mtime = statSync(dir).mtimeMs;
			}
			return { dir, mtime, size: 0 };
		})
		.sort((a, b) => a.mtime - b.mtime);
	const alive = [];
	for (const s of sessions) {
		if (now - s.mtime > maxDays * DAY_MS) rmSync(s.dir, { recursive: true, force: true });
		else alive.push(s);
	}
	let total = existsSync(join(root, keep)) ? dirSize(join(root, keep)) : 0;
	for (const s of alive) total += s.size = dirSize(s.dir);
	for (const s of alive) {
		if (total <= maxMb * 1024 * 1024) break;
		rmSync(s.dir, { recursive: true, force: true });
		total -= s.size;
	}
}

export default function checkpoints(pi: ExtensionAPI) {
	if (process.env.AGENT_CHECKPOINTS === "0" || process.env.AGENT_CHILD === "1") return;
	const root = join(getAgentDir(), "checkpoints");
	let store: Store | undefined;

	const storeFor = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId();
		if (!store || store.dir !== join(root, id)) store = new Store(root, id);
		else store.refresh();
		return store;
	};
	const rel = (path: string, cwd: string) => {
		const r = relative(cwd, path);
		return r && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r) ? r : path;
	};

	pi.on("session_start", (_event, ctx) => {
		store = undefined;
		try {
			prune(root, ctx.sessionManager.getSessionId(), num(process.env.AGENT_CHECKPOINTS_DAYS, 30), num(process.env.AGENT_CHECKPOINTS_MAX_MB, 500));
		} catch {
			/* limpeza é best-effort */
		}
	});

	// Antes da escrita: o Pi espera os handlers de tool_call antes de executar a tool.
	pi.on("tool_call", (event: any, ctx) => {
		if (!TRACKED.has(event.toolName) || typeof event.input?.path !== "string") return;
		try {
			const user = lastUser(ctx);
			storeFor(ctx).snapshot(user?.id ?? "start", user?.prompt ?? "", resolveToolPath(event.input.path, ctx.cwd));
		} catch (error) {
			try {
				ctx.ui.notify(`checkpoint falhou: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} catch {
				/* headless */
			}
		}
	});

	pi.on("tool_result", (event: any, ctx) => {
		if (!TRACKED.has(event.toolName) || event.isError || typeof event.input?.path !== "string") return;
		try {
			const user = lastUser(ctx);
			storeFor(ctx).after(user?.id ?? "start", resolveToolPath(event.input.path, ctx.cwd));
		} catch {
			/* best-effort */
		}
	});

	pi.registerCommand("rewind", {
		description: `desfaz edições de arquivo e/ou a conversa até um turno (${BASH_NOTE})`,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agente em execução: interrompa (Esc) e rode /rewind de novo.", "warning");
				return;
			}
			const s = storeFor(ctx);
			const turns = ctx.sessionManager
				.getBranch()
				.filter((e: any) => e?.type === "message" && e.message?.role === "user")
				.reverse() as any[];
			if (!turns.length) {
				ctx.ui.notify("Nenhum turno para voltar.", "info");
				return;
			}
			const labels = turns.map((e, i) => {
				const files = s.changedIn(e.id).map((p) => rel(p, ctx.cwd));
				const shown = files.length
					? `${files.slice(0, FILES_SHOWN).join(", ")}${files.length > FILES_SHOWN ? ` +${files.length - FILES_SHOWN}` : ""}`
					: "sem edições";
				return `${turns.length - i}. ${oneLine(textOf(e.message.content), PROMPT_WIDTH) || "(sem texto)"} · ${shown}`;
			});
			const picked = await ctx.ui.select(`Voltar para antes de qual turno? (${BASH_NOTE})`, labels);
			if (picked === undefined) return;
			const turn = turns[labels.indexOf(picked)];
			const since = Date.parse(turn.timestamp) || 0;
			s.refresh();
			let plans = s.plan(turn.id, since);

			const CODE_AND_CHAT = "Código e conversa";
			const CODE = "Só código";
			const CHAT = "Só conversa";
			const CANCEL = "Cancelar";
			const summary = plans.length
				? plans
						.map((p) => {
							const how = p.target === null
								? (p.unattributed ? "remover (não existia no checkpoint)" : "remover (criado pelo agente)")
								: p.target === undefined ? "não restaurável (> 20 MB)" : "restaurar";
							return `  ${rel(p.path, ctx.cwd)}: ${how}${p.conflict ? " · mudou por fora" : ""}${p.unattributed ? " · autoria incerta (subagente)" : ""}`;
						})
						.join("\n")
				: "  nenhum arquivo a restaurar";
			const options = plans.length ? [CODE_AND_CHAT, CODE, CHAT, CANCEL] : [CHAT, CANCEL];
			const action = await ctx.ui.select(`Arquivos desde esse turno:\n${summary}\nO que desfazer?`, options);
			if (action === undefined || action === CANCEL) return;

			let report: string | undefined;
			if (action === CODE_AND_CHAT || action === CODE) {
				const conflicts = plans.filter((p) => p.conflict);
				const unattributed = plans.filter((p) => p.unattributed);
				if (conflicts.length || unattributed.length) {
					const OVERWRITE = "Sobrescrever mesmo assim";
					const SKIP = "Pular os alterados";
					const list = (files: typeof plans) => files.map((p) => `  ${rel(p.path, ctx.cwd)}`).join("\n");
					const warnings = [];
					if (conflicts.length) warnings.push(`Mudaram depois da última edição do agente (editor, bash ou outro processo):\n${list(conflicts)}`);
					if (unattributed.length) warnings.push(`Alterações sem autoria confirmada (varredura de subagente; podem incluir edições suas):\n${list(unattributed)}`);
					const choice = await ctx.ui.select(warnings.join("\n\n"), [OVERWRITE, SKIP, CANCEL]);
					if (choice === SKIP) plans = plans.filter((p) => !p.conflict && !p.unattributed);
					else if (choice !== OVERWRITE) return;
				}
				const { done, skipped } = s.apply(plans);
				if (done.length) s.rewound(turn.id, done);
				const lost = plans.filter((p) => p.target === undefined).map((p) => rel(p.path, ctx.cwd));
				report = `Restaurados ${done.length} arquivo(s).${lost.length ? ` Não restaurável: ${lost.join(", ")}.` : ""}${skipped.length ? ` Pulados após a revisão (estado diferente ou não verificável): ${skipped.map((p) => rel(p, ctx.cwd)).join(", ")}.` : ""} Bash da sessão não é rastreado.`;
			}
			if (action === CODE_AND_CHAT || action === CHAT) {
				await ctx.waitForIdle();
				const nav = await ctx.navigateTree(turn.id, { summarize: false });
				if (nav.cancelled) report = `${report ?? ""} Conversa não mudou (navegação cancelada).`.trim();
			}
			// Depois da navegação: o TUI redesenha o histórico e apagaria um aviso anterior.
			if (report) ctx.ui.notify(report, "info");
		},
	});
}
