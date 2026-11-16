/**
 * checkpoints — /rewind: desfaz as edições de arquivo do agente até um turno escolhido.
 *
 * Antes de cada `edit`/`write` da sessão principal (inclusive chamadas aninhadas, ex. codemode),
 * guarda o conteúdo anterior do arquivo — ou o marcador "não existia" — associado à entrada do
 * usuário que abriu o turno. Só a primeira mudança de cada arquivo por turno vira snapshot.
 * Depois de cada edição registra o hash que o agente deixou; no /rewind, hash diferente no disco
 * significa mudança por fora (editor, bash, outro processo) e pede confirmação.
 *
 * Bash não é rastreado (rm, mv, sed -i, geradores…). Filhos (AGENT_CHILD=1) não gravam: escritores
 * já rodam em worktree isolado.
 *
 * Disco: `<perfil>/checkpoints/<sessionId>/` com `index.jsonl` (append-only) e `blobs/<sha256>`.
 * Persistem ao retomar a sessão (mesmo sessionId). Limpeza no session_start: sessões sem uso há
 * AGENT_CHECKPOINTS_DAYS dias (30) e, acima de AGENT_CHECKPOINTS_MAX_MB (500), as mais antigas.
 * AGENT_CHECKPOINTS=0 desliga tudo (nem grava nem registra o comando).
 *
 * Não registra tool nem mexe no prompt: é só comando do usuário.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PROMPT_WIDTH = 60;
const FILES_SHOWN = 3;
const TRACKED = new Set(["edit", "write"]);

export const BASH_NOTE = "só edições feitas por edit/write do agente; bash (rm, mv, sed…) não é rastreado";

type Rec =
	| { t: "turn"; turn: string; ts: number; prompt: string }
	| { t: "snap"; turn: string; ts: number; path: string; before: string | null; skipped?: "too-large" }
	| { t: "after"; turn: string; ts: number; path: string; hash: string | null }
	| { t: "rewind"; turn: string; ts: number; files: { path: string; hash: string | null }[] };

export interface Plan {
	path: string;
	/** Conteúdo-alvo: sha do blob, null = não existia (remover), undefined = não restaurável. */
	target: string | null | undefined;
	current: string | null;
	/** Hash que o agente deixou por último (edit/write ou rewind); undefined se nunca mudou com sucesso. */
	expected: string | null | undefined;
	conflict: boolean;
}

const num = (raw: string | undefined, fallback: number) => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

function sha(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

function hashOf(path: string): string | null {
	try {
		return sha(readFileSync(path));
	} catch (error: any) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
		throw error;
	}
}

/** Mesma resolução de caminho das tools edit/write do Pi (resolveToCwd). */
export function resolveToolPath(input: string, cwd: string): string {
	let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	if (/^file:\/\//.test(p)) p = fileURLToPath(p);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text : "")).join(" ");
}

function oneLine(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

export class Store {
	readonly dir: string;
	records: Rec[] = [];

	constructor(root: string, sessionId: string) {
		this.dir = join(root, sessionId);
		const index = join(this.dir, "index.jsonl");
		if (!existsSync(index)) return;
		for (const line of readFileSync(index, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				this.records.push(JSON.parse(line));
			} catch {
				/* linha truncada: ignora */
			}
		}
	}

	private append(rec: Rec) {
		mkdirSync(this.dir, { recursive: true });
		appendFileSync(join(this.dir, "index.jsonl"), `${JSON.stringify(rec)}\n`);
		this.records.push(rec);
	}

	private putBlob(buf: Buffer): string {
		const hash = sha(buf);
		const blob = join(this.dir, "blobs", hash);
		if (!existsSync(blob)) {
			mkdirSync(dirname(blob), { recursive: true });
			writeFileSync(blob, buf);
		}
		return hash;
	}

	blob(hash: string): Buffer {
		return readFileSync(join(this.dir, "blobs", hash));
	}

	hasSnap(turn: string, path: string): boolean {
		return this.records.some((r) => r.t === "snap" && r.turn === turn && r.path === path);
	}

	/** Snapshot do estado anterior; só a primeira vez de cada arquivo no turno. */
	snapshot(turn: string, prompt: string, path: string) {
		if (this.hasSnap(turn, path)) return;
		if (!this.records.some((r) => r.t === "turn" && r.turn === turn)) this.append({ t: "turn", turn, ts: Date.now(), prompt });
		let before: string | null = null;
		let skipped: "too-large" | undefined;
		try {
			const st = statSync(path);
			if (st.size > MAX_FILE_BYTES) skipped = "too-large";
			else before = this.putBlob(readFileSync(path));
		} catch (error: any) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
		}
		this.append({ t: "snap", turn, ts: Date.now(), path, before, ...(skipped ? { skipped } : {}) });
	}

	after(turn: string, path: string) {
		this.append({ t: "after", turn, ts: Date.now(), path, hash: hashOf(path) });
	}

	rewound(turn: string, files: { path: string; hash: string | null }[]) {
		this.append({ t: "rewind", turn, ts: Date.now(), files });
	}

	/** Arquivos alterados com sucesso no turno. */
	changedIn(turn: string): string[] {
		const out: string[] = [];
		for (const r of this.records) if (r.t === "after" && r.turn === turn && !out.includes(r.path)) out.push(r.path);
		return out;
	}

	expected(path: string): string | null | undefined {
		let hash: string | null | undefined;
		for (const r of this.records) {
			if (r.t === "after" && r.path === path) hash = r.hash;
			else if (r.t === "rewind") for (const f of r.files) if (f.path === path) hash = f.hash;
		}
		return hash;
	}

	/**
	 * O que restaurar para voltar ao estado de antes do turno: para cada arquivo, o snapshot mais
	 * antigo gravado a partir do turno (ordem cronológica do disco, qualquer ramo da conversa).
	 */
	plan(turn: string, since: number): Plan[] {
		const start = this.records.findIndex((r) => (r.t === "turn" && r.turn === turn) || (r.t === "snap" && r.ts >= since));
		if (start < 0) return [];
		const first = new Map<string, Extract<Rec, { t: "snap" }>>();
		for (const r of this.records.slice(start)) if (r.t === "snap" && !first.has(r.path)) first.set(r.path, r);
		const plans: Plan[] = [];
		for (const [path, snap] of first) {
			const target = snap.skipped ? undefined : snap.before;
			const current = hashOf(path);
			if (target !== undefined && current === target) continue;
			const expected = this.expected(path);
			// Nunca mudou com sucesso pelo agente e está igual ao snapshot: nada a fazer (acima).
			const conflict = expected !== undefined && current !== expected;
			plans.push({ path, target, current, expected, conflict });
		}
		return plans;
	}

	/** Aplica o plano; devolve os caminhos tocados com o hash resultante. */
	apply(plans: Plan[]): { path: string; hash: string | null }[] {
		const done: { path: string; hash: string | null }[] = [];
		for (const p of plans) {
			if (p.target === undefined) continue;
			if (p.target === null) {
				try {
					unlinkSync(p.path);
				} catch (error: any) {
					if (error?.code !== "ENOENT") throw error;
				}
			} else {
				mkdirSync(dirname(p.path), { recursive: true });
				writeFileSync(p.path, this.blob(p.target));
			}
			done.push({ path: p.path, hash: p.target });
		}
		return done;
	}
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

function lastUser(ctx: ExtensionContext): { id: string; prompt: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e: any = branch[i];
		if (e?.type === "message" && e.message?.role === "user") return { id: e.id, prompt: oneLine(textOf(e.message.content), 200) };
	}
	return undefined;
}

export default function checkpoints(pi: ExtensionAPI) {
	if (process.env.AGENT_CHECKPOINTS === "0" || process.env.AGENT_CHILD === "1") return;
	const root = join(getAgentDir(), "checkpoints");
	let store: Store | undefined;

	const storeFor = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId();
		if (!store || store.dir !== join(root, id)) store = new Store(root, id);
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
			let plans = s.plan(turn.id, since);

			const CODE_AND_CHAT = "Código e conversa";
			const CODE = "Só código";
			const CHAT = "Só conversa";
			const CANCEL = "Cancelar";
			const summary = plans.length
				? plans
						.map((p) => {
							const how = p.target === null ? "remover (criado pelo agente)" : p.target === undefined ? "não restaurável (> 20 MB)" : "restaurar";
							return `  ${rel(p.path, ctx.cwd)}: ${how}${p.conflict ? " · mudou por fora" : ""}`;
						})
						.join("\n")
				: "  nenhum arquivo a restaurar";
			const options = plans.length ? [CODE_AND_CHAT, CODE, CHAT, CANCEL] : [CHAT, CANCEL];
			const action = await ctx.ui.select(`Arquivos desde esse turno:\n${summary}\nO que desfazer?`, options);
			if (action === undefined || action === CANCEL) return;

			let report: string | undefined;
			if (action === CODE_AND_CHAT || action === CODE) {
				const conflicts = plans.filter((p) => p.conflict);
				if (conflicts.length) {
					const OVERWRITE = "Sobrescrever mesmo assim";
					const SKIP = "Pular os alterados";
					const choice = await ctx.ui.select(
						`Mudaram depois da última edição do agente (editor, bash ou outro processo):\n${conflicts.map((p) => `  ${rel(p.path, ctx.cwd)}`).join("\n")}`,
						[OVERWRITE, SKIP, CANCEL],
					);
					if (choice === undefined || choice === CANCEL) return;
					if (choice === SKIP) plans = plans.filter((p) => !p.conflict);
				}
				const done = s.apply(plans);
				if (done.length) s.rewound(turn.id, done);
				const lost = plans.filter((p) => p.target === undefined).map((p) => rel(p.path, ctx.cwd));
				report = `Restaurados ${done.length} arquivo(s).${lost.length ? ` Não restaurável: ${lost.join(", ")}.` : ""} Bash não é rastreado.`;
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
