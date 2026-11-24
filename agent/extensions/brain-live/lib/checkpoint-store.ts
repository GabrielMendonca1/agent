import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Rec =
	| { t: "turn"; turn: string; ts: number; prompt: string }
	| { t: "snap"; turn: string; ts: number; path: string; before: string | null; checkout?: string; skipped?: "too-large" }
	| { t: "after"; turn: string; ts: number; path: string; hash: string | null }
	| { t: "rewind"; turn: string; ts: number; files: { path: string; hash: string | null }[] };

export interface Plan {
	path: string;
	checkout?: string;
	/** Conteúdo-alvo: sha do blob, null = não existia (remover), undefined = não restaurável. */
	target: string | null | undefined;
	current: string | null;
	/** Hash que o agente deixou por último (edit/write ou rewind); undefined se nunca mudou com sucesso. */
	expected: string | null | undefined;
	conflict: boolean;
}

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

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text : "")).join(" ");
}

export function oneLine(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

export function lastUser(ctx: ExtensionContext): { id: string; prompt: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e: any = branch[i];
		if (e?.type === "message" && e.message?.role === "user") return { id: e.id, prompt: oneLine(textOf(e.message.content), 200) };
	}
	return undefined;
}

// Não segue links nem trata diretórios e arquivos especiais como conteúdo.
function safeCheckoutPath(root: string, file: string): boolean {
	const rel = relative(root, file);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
	let path = root;
	try {
		if (realpathSync(root) !== root) return false;
		const parts = rel.split(sep);
		for (const [i, part] of parts.entries()) {
			path = join(path, part);
			const st = lstatSync(path);
			if (i === parts.length - 1 ? !st.isFile() : !st.isDirectory()) return false;
		}
		return true;
	} catch (error: any) {
		return path !== root && error?.code === "ENOENT";
	}
}

export class Store {
	readonly dir: string;
	records: Rec[] = [];
	private indexSize = 0;

	constructor(root: string, sessionId: string) {
		this.dir = join(root, sessionId);
		this.refresh();
	}

	refresh() {
		const index = join(this.dir, "index.jsonl");
		const size = statSync(index, { throwIfNoEntry: false })?.size ?? 0;
		if (size === this.indexSize) return;
		const data = size ? readFileSync(index) : Buffer.alloc(0);
		this.indexSize = data.length;
		this.records = [];
		for (const line of data.toString("utf8").split("\n")) {
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
		const line = `${JSON.stringify(rec)}\n`;
		appendFileSync(join(this.dir, "index.jsonl"), line);
		this.indexSize += Buffer.byteLength(line);
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

	hasSnap(turn: string, path: string, ts = Infinity): boolean {
		return this.records.some((r) => r.t === "snap" && r.turn === turn && r.path === path && r.ts <= ts);
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

	recordWriter(turn: string, prompt: string, checkout: string, ts: number, path: string, before: Buffer | null, after: string | null) {
		if (!this.hasSnap(turn, path, ts)) {
			if (!this.records.some((r) => r.t === "turn" && r.turn === turn)) this.append({ t: "turn", turn, ts, prompt });
			this.append({ t: "snap", turn, ts, path, checkout, before: before === null ? null : this.putBlob(before) });
		}
		this.append({ t: "after", turn, ts: Date.now(), path, hash: after });
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
	 * antigo gravado a partir do turno (ordem cronológica da captura, qualquer ramo da conversa).
	 */
	plan(turn: string, since: number): Plan[] {
		const first = new Map<string, Extract<Rec, { t: "snap" }>>();
		for (const r of this.records) {
			if (r.t === "snap" && (r.turn === turn || r.ts >= since) && r.ts < (first.get(r.path)?.ts ?? Infinity)) first.set(r.path, r);
		}
		const plans: Plan[] = [];
		for (const [path, snap] of first) {
			if (snap.checkout && !safeCheckoutPath(snap.checkout, path)) continue;
			const target = snap.skipped ? undefined : snap.before;
			const current = hashOf(path);
			if (target !== undefined && current === target) continue;
			const expected = this.expected(path);
			// Nunca mudou com sucesso pelo agente e está igual ao snapshot: nada a fazer (acima).
			const conflict = expected !== undefined && current !== expected;
			plans.push({ path, ...(snap.checkout ? { checkout: snap.checkout } : {}), target, current, expected, conflict });
		}
		return plans;
	}

	/** Aplica o plano; devolve os caminhos tocados com o hash resultante. */
	apply(plans: Plan[]): { path: string; hash: string | null }[] {
		const done: { path: string; hash: string | null }[] = [];
		for (const p of plans) {
			if (p.target === undefined || (p.checkout && !safeCheckoutPath(p.checkout, p.path))) continue;
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

export interface WriterCheckpoint {
	root: string;
	sessionId: string;
	turn: string;
	prompt: string;
}

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_PATHS = 10_000;

function git(cwd: string, ...args: string[]): string {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(execFileSync("git", args, {
		cwd, maxBuffer: 2 * 1024 * 1024, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
	}));
}

function gitPaths(root: string, ...args: string[]): string[] {
	return git(root, "ls-files", "-z", ...args).split("\0").filter(Boolean);
}

function visiblePaths(root: string): string[] {
	return gitPaths(root, "--cached", "--others", "--exclude-standard");
}

// O tamanho pode mudar entre lstat e open. Não leia além do limite da captura.
function readScanFile(file: string, remaining: number): Buffer | undefined {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
		if (st.size > remaining) throw new Error("writer checkpoint byte limit exceeded");
		const buf = Buffer.allocUnsafe(st.size);
		let read = 0;
		while (read < buf.length) {
			const n = readSync(fd, buf, read, buf.length - read, null);
			if (!n) return;
			read += n;
		}
		if (fstatSync(fd).size === st.size) return buf;
	} finally {
		closeSync(fd);
	}
}

function scanFiles<T>(root: string, paths: Set<string>, save: (buf: Buffer) => T): Map<string, T | null | undefined> {
	if (paths.size > MAX_SCAN_PATHS) throw new Error("writer checkpoint path limit exceeded");
	let bytes = 0;
	const files = new Map<string, T | null | undefined>();
	for (const name of paths) {
		const file = join(root, name);
		if (!safeCheckoutPath(root, file)) {
			files.set(name, undefined);
			continue;
		}
		const st = lstatSync(file, { throwIfNoEntry: false });
		if (!st) files.set(name, null);
		else if (st.size > MAX_FILE_BYTES) files.set(name, undefined);
		else {
			const buf = readScanFile(file, MAX_SCAN_BYTES - bytes);
			if (buf) bytes += buf.length;
			files.set(name, buf && save(buf));
		}
	}
	return files;
}

/** Captura antes do spawn; persiste só arquivos que mudaram, inclusive se o filho falhar. */
export function captureWriter(cwd: string, checkpoint: WriterCheckpoint): (() => void) | undefined {
	try {
		const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel").replace(/\n$/, ""));
		const ts = Date.now();
		const names = visiblePaths(root);
		// Um ignorado já existente pode entrar no índice (git add -f). Não marque como novo.
		const ignored = gitPaths(root, "--others", "--ignored", "--exclude-standard", "--directory");
		if (names.length + ignored.length > MAX_SCAN_PATHS) return;
		const excluded = new Set([...ignored, ...names.filter((name) => name.endsWith("/"))]);
		const wasExcluded = (name: string) => {
			for (let part = name; part !== "."; part = dirname(part)) {
				if (excluded.has(part) || excluded.has(`${part}/`)) return true;
			}
			return false;
		};
		const before = scanFiles(root, new Set(names), (buf) => buf);
		return () => {
			try {
				const after = scanFiles(root, new Set([...before.keys(), ...visiblePaths(root)]), sha);
				const store = new Store(checkpoint.root, checkpoint.sessionId);
				for (const [name, hash] of after) {
					if (hash === undefined || (!before.has(name) && wasExcluded(name))) continue;
					const old = before.has(name) ? before.get(name) : null;
					if (old === undefined || (old === null ? null : sha(old)) === hash) continue;
					store.recordWriter(checkpoint.turn, checkpoint.prompt, root, ts, join(root, name), old, hash);
				}
			} catch { /* best-effort: não muda o resultado do subagente */ }
		};
	} catch { return undefined; /* checkout ausente ou captura indisponível */ }
}
