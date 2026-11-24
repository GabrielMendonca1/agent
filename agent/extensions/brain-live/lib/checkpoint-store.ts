import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Rec =
	| { t: "turn"; turn: string; ts: number; prompt: string }
	| { t: "snap"; turn: string; ts: number; path: string; before: string | null; checkout?: string; source?: "subagent"; skipped?: "too-large" }
	| { t: "after"; turn: string; ts: number; path: string; hash: string | null; source?: "subagent" }
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
	unattributed: boolean;
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

	/**
	 * O que restaurar para voltar ao estado de antes do turno: para cada arquivo, o snapshot mais
	 * antigo gravado a partir do turno (ordem cronológica da captura, qualquer ramo da conversa).
	 */
	plan(turn: string, since: number): Plan[] {
		const first = new Map<string, Extract<Rec, { t: "snap" }>>();
		const unattributedPaths = new Set<string>();
		const checkouts = new Map<string, string>();
		const latest = new Map<string, { hash: string | null; source?: "subagent" }>();
		for (const r of this.records) {
			const inRange = r.turn === turn || r.ts >= since;
			if (r.t === "after") {
				latest.set(r.path, r);
				if (inRange && r.source === "subagent") unattributedPaths.add(r.path);
			} else if (r.t === "rewind") {
				for (const f of r.files) latest.set(f.path, f);
			} else if (r.t === "snap" && inRange) {
				// Os snapshots antigos com checkout também vieram de uma varredura.
				if (r.source === "subagent" || r.checkout) unattributedPaths.add(r.path);
				if (r.checkout) checkouts.set(r.path, r.checkout);
				if (r.ts < (first.get(r.path)?.ts ?? Infinity)) first.set(r.path, r);
			}
		}
		const plans: Plan[] = [];
		for (const [path, snap] of first) {
			const checkout = checkouts.get(path);
			if (checkout && !safeCheckoutPath(checkout, path)) continue;
			const target = snap.skipped ? undefined : snap.before;
			const current = hashOf(path);
			if (target !== undefined && current === target) continue;
			const last = latest.get(path);
			const expected = last?.hash;
			const conflict = expected !== undefined && current !== expected;
			const unattributed = unattributedPaths.has(path) || last?.source === "subagent";
			plans.push({ path, checkout, target, current, expected, conflict, unattributed });
		}
		return plans;
	}

	/** Não toca arquivos cujo estado já não é o revisado, mesmo após confirmação. */
	apply(plans: Plan[]) {
		const done: { path: string; hash: string | null }[] = [];
		const skipped: string[] = [];
		for (const p of plans) {
			if (p.target === undefined) continue;
			const blob = p.target === null ? null : this.blob(p.target);
			const stillReviewed = () => {
				try {
					return (!p.checkout || safeCheckoutPath(p.checkout, p.path)) && hashOf(p.path) === p.current;
				} catch {
					return false;
				}
			};
			if (blob !== null && p.current === null && stillReviewed()) mkdirSync(dirname(p.path), { recursive: true });
			if (!stillReviewed()) {
				skipped.push(p.path);
				continue;
			}
			if (blob === null) {
				try {
					unlinkSync(p.path);
				} catch (error: any) {
					if (error?.code !== "ENOENT") throw error;
					skipped.push(p.path);
					continue;
				}
			} else {
				writeFileSync(p.path, blob);
			}
			done.push({ path: p.path, hash: p.target });
		}
		return { done, skipped };
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

const SCAN_BUDGET_MS = 3000;
const execFileAsync = promisify(execFile);

async function withScanBudget<T>(dispatch: AbortSignal | undefined, scan: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const timeout = AbortSignal.timeout(SCAN_BUDGET_MS);
	const signal = dispatch ? AbortSignal.any([dispatch, timeout]) : timeout;
	const abortError = () => new Error(dispatch?.aborted ? "dispatch cancelled" : "3s scan budget exceeded");
	if (signal.aborted) throw abortError();
	let onAbort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([aborted, scan(signal)]);
	} catch {
		if (signal.aborted) throw abortError();
		throw new Error("checkout unavailable or scan limits exceeded");
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function git(cwd: string, signal: AbortSignal, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, signal, encoding: "buffer", maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" });
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
}

async function gitPaths(root: string, signal: AbortSignal, ...args: string[]): Promise<string[]> {
	return (await git(root, signal, "ls-files", "-z", ...args)).split("\0").filter(Boolean);
}

function visiblePaths(root: string, signal: AbortSignal): Promise<string[]> {
	return gitPaths(root, signal, "--cached", "--others", "--exclude-standard");
}

// Não segue links. null indica caminho ausente; undefined indica caminho não regular.
async function scanPath(root: string, file: string, signal: AbortSignal) {
	const rel = relative(root, file);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
	let path = root;
	try {
		if (await realpath(root) !== root) return;
		const parts = rel.split(sep);
		for (const [i, part] of parts.entries()) {
			signal.throwIfAborted();
			path = join(path, part);
			const st = await lstat(path);
			if (i === parts.length - 1) return st.isFile() ? st : undefined;
			if (!st.isDirectory()) return;
		}
	} catch (error: any) {
		if (path !== root && error?.code === "ENOENT") return null;
		throw error;
	}
}

// O tamanho pode mudar entre lstat e open. Não leia além do limite da captura.
async function readScanFile(file: string, remaining: number, signal: AbortSignal): Promise<Buffer | undefined> {
	const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		signal.throwIfAborted();
		const st = await fd.stat();
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
		if (st.size > remaining) throw new Error("writer checkpoint byte limit exceeded");
		const buf = Buffer.allocUnsafe(st.size);
		let read = 0;
		while (read < buf.length) {
			signal.throwIfAborted();
			const { bytesRead } = await fd.read(buf, read, buf.length - read, null);
			if (!bytesRead) return;
			read += bytesRead;
		}
		signal.throwIfAborted();
		if ((await fd.stat()).size === st.size) return buf;
	} finally {
		await fd.close();
	}
}

async function scanFiles<T>(root: string, paths: Set<string>, signal: AbortSignal, save: (buf: Buffer) => T): Promise<Map<string, T | null | undefined>> {
	if (paths.size > MAX_SCAN_PATHS) throw new Error("writer checkpoint path limit exceeded");
	let bytes = 0;
	const files = new Map<string, T | null | undefined>();
	for (const name of paths) {
		signal.throwIfAborted();
		const file = join(root, name);
		const st = await scanPath(root, file, signal);
		if (st === null) files.set(name, null);
		else if (!st || st.size > MAX_FILE_BYTES) files.set(name, undefined);
		else {
			signal.throwIfAborted();
			const buf = await readScanFile(file, MAX_SCAN_BYTES - bytes, signal);
			if (buf) bytes += buf.length;
			files.set(name, buf && save(buf));
		}
	}
	return files;
}

type WriterChange = { path: string; before: { buf: Buffer; hash: string } | null; after: string | null };

async function recordWriter(checkpoint: WriterCheckpoint, checkout: string, ts: number, changes: WriterChange[], signal?: AbortSignal) {
	if (!changes.length) return;
	const { root, sessionId, turn, prompt } = checkpoint;
	const dir = join(root, sessionId);
	const blobs = join(dir, "blobs");
	await mkdir(blobs, { recursive: true });
	const records: Rec[] = [{ t: "turn", turn, ts, prompt }];
	const saved = new Set<string>();
	for (const { path, before, after } of changes) {
		signal?.throwIfAborted();
		if (before && !saved.has(before.hash)) {
			// Publica apenas blobs completos, inclusive se outra gravação usar o mesmo hash.
			const tmp = join(blobs, `.${randomUUID()}`);
			try {
				await writeFile(tmp, before.buf, { signal });
				await rename(tmp, join(blobs, before.hash));
			} catch (error) {
				await unlink(tmp).catch(() => {});
				throw error;
			}
			saved.add(before.hash);
		}
		records.push({ t: "snap", turn, ts, path, checkout, before: before?.hash ?? null, source: "subagent" });
		records.push({ t: "after", turn, ts: Date.now(), path, hash: after, source: "subagent" });
	}
	const data = Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(""));
	const index = await open(join(dir, "index.jsonl"), "a");
	try {
		signal?.throwIfAborted();
		// Um append, sem intercalar linhas com os checkpoints do pai ou de outro job.
		if ((await index.write(data)).bytesWritten !== data.length) throw new Error("incomplete checkpoint index write");
	} finally {
		await index.close();
	}
}

/** Captura antes do spawn; persiste só arquivos que mudaram, inclusive se o filho falhar. */
export async function captureWriter(cwd: string, checkpoint: WriterCheckpoint, dispatch?: AbortSignal): Promise<() => Promise<void>> {
	const { root, ts, before, excluded } = await withScanBudget(dispatch, async (signal) => {
		const root = await realpath((await git(cwd, signal, "rev-parse", "--show-toplevel")).replace(/\n$/, ""));
		const ts = Date.now();
		const names = await visiblePaths(root, signal);
		// Um ignorado já existente pode entrar no índice (git add -f). Não marque como novo.
		const ignored = await gitPaths(root, signal, "--others", "--ignored", "--exclude-standard", "--directory");
		if (names.length + ignored.length > MAX_SCAN_PATHS) throw new Error("writer checkpoint path limit exceeded");
		const excluded = new Set([...ignored, ...names.filter((name) => name.endsWith("/"))]);
		const before = await scanFiles(root, new Set(names), signal, (buf) => ({ buf, hash: sha(buf) }));
		return { root, ts, before, excluded };
	});
	const wasExcluded = (name: string) => {
		for (let part = name; part !== "."; part = dirname(part)) {
			if (excluded.has(part) || excluded.has(`${part}/`)) return true;
		}
		return false;
	};
	return async () => {
		const after = await withScanBudget(dispatch, async (signal) =>
			scanFiles(root, new Set([...before.keys(), ...await visiblePaths(root, signal)]), signal, sha));
		const changes: WriterChange[] = [];
		for (const [name, hash] of after) {
			if (hash === undefined || (!before.has(name) && wasExcluded(name))) continue;
			const old = before.has(name) ? before.get(name) : null;
			if (old === undefined || (old?.hash ?? null) === hash) continue;
			changes.push({ path: join(root, name), before: old, after: hash });
		}
		try {
			await recordWriter(checkpoint, root, ts, changes, dispatch);
		} catch {
			throw new Error(dispatch?.aborted ? "dispatch cancelled" : "checkpoint could not be saved");
		}
	};
}
