/**
 * Leitura (somente leitura) das sessões do "pi durável".
 *
 * Uma sessão durável é um DIRETÓRIO com um `session.sqlite` dentro:
 *
 *   <agentDir>/durable-sessions/<sha256(cwd)[0..24]>/<timestamp>-<uuid>/session.sqlite
 *
 * O host durável projeta isso em `ctx.sessionManager`: `getSessionDir()` devolve
 * o diretório da sessão e `getSessionFile()` o `session.sqlite` (em vez do JSONL).
 *
 * POR QUE SQL CRU, E NÃO A API DO PI-DURABLE
 * `openNodeSqliteStorage()` abre o banco para ESCRITA e roda as migrações no
 * open — ou seja, escreveria no banco de uma sessão que pode estar viva em
 * outro processo. Aqui nada pode escrever nem travar sessão alheia, então
 * abrimos o arquivo em modo somente leitura (`node:sqlite` DatabaseSync com
 * `readOnly`, ou `bun:sqlite` nos testes) e lemos as tabelas direto.
 *
 * ACOPLAMENTO ASSUMIDO (packages/durable/src/storage/sqlite/migrations.ts):
 *   conversations(id, record)                — record JSON do ConversationRecord
 *   entries(id, conversation_id, record)     — record JSON do EntryRecord:
 *                                              { kind, model: Message[], data }
 *   documents(id, kind, scope_kind, owner_id)— `kind` guardado como JSON ("\"pi.agent\"")
 *   document_revisions(document_id, seq, kind, content)
 * O `cwd` da sessão mora no documento `pi.agent` da conversa raiz; esse
 * documento tem `checkpointWhen: () => true`, então a revisão `base` mais nova
 * já é o valor corrente (não precisamos aplicar deltas do chord).
 * Se o schema mudar, as leituras falham fechado: a sessão aparece sem preview,
 * sem cwd e sem custo — nunca com erro na UI.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const SESSION_DB = "session.sqlite";
export const DURABLE_DIRNAME = "durable-sessions";
const OWNER_FILE = "owner.json";
/**
 * O dono renova a trava do proper-lockfile a cada ~2,5 s (stale 5 s). Só
 * tratamos uma trava como abandonada depois de muito mais que isso E sem dono
 * vivo em `owner.json`; na dúvida a sessão conta como travada.
 */
const LOCK_GRACE_MS = 60_000;

// ---------- caminhos ----------

export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	return env && env.trim() ? resolve(env) : join(homedir(), ".pi", "agent");
}

export function hashCwd(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

export function durableRoot(dir = agentDir()): string {
	return join(dir, DURABLE_DIRNAME);
}

/** `<agentDir>` deduzido de um caminho dentro de `durable-sessions/<hash>/<id>`. */
export function agentDirFrom(path: string): string | undefined {
	let cursor = path.endsWith(".sqlite") ? dirname(path) : path;
	for (let up = 0; up < 3; up++) {
		const parent = dirname(cursor);
		if (basename(parent) === DURABLE_DIRNAME) return dirname(parent);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
	return undefined;
}

/** Um caminho de sessão durável: o `session.sqlite` ou o diretório que o contém. */
export function isDurablePath(path: string): boolean {
	if (!path) return false;
	if (path.endsWith(".sqlite")) return true;
	try {
		return statSync(path).isDirectory() && existsSync(join(path, SESSION_DB));
	} catch {
		return false;
	}
}

export function durableDirOf(path: string): string {
	return path.endsWith(".sqlite") ? dirname(path) : path;
}

export function durableDbOf(path: string): string {
	return path.endsWith(".sqlite") ? path : join(path, SESSION_DB);
}

// ---------- trava ----------

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function livingOwner(directory: string): boolean {
	try {
		const owner = JSON.parse(readFileSync(join(directory, OWNER_FILE), "utf8")) as { pid?: unknown };
		return typeof owner.pid === "number" && owner.pid !== process.pid && pidAlive(owner.pid);
	} catch {
		return false;
	}
}

function lockFresh(path: string, now: number): boolean {
	try {
		return now - statSync(path).mtimeMs < LOCK_GRACE_MS;
	} catch {
		return false;
	}
}

/**
 * `locked` quando alguém pode estar com a sessão aberta: `owner.json` com pid
 * vivo, ou a trava do proper-lockfile (`<dir>.lock`, `<dir>/session.sqlite.lock`)
 * ainda sendo renovada.
 */
export function durableLockState(directory: string, now = Date.now()): "locked" | "free" {
	if (livingOwner(directory)) return "locked";
	for (const lock of [`${directory}.lock`, `${join(directory, SESSION_DB)}.lock`]) {
		if (existsSync(lock) && lockFresh(lock, now)) return "locked";
	}
	return "free";
}

// ---------- sqlite somente leitura ----------

interface Reader {
	all(sql: string, ...params: (string | number)[]): Record<string, unknown>[];
	close(): void;
}

interface NodeSqlite {
	DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
		prepare(sql: string): { all(...params: (string | number)[]): unknown[] };
		close(): void;
	};
}

interface BunSqlite {
	Database: new (path: string, options?: { readonly?: boolean }) => {
		query(sql: string): { all(...params: (string | number)[]): unknown[] };
		close(): void;
	};
}

let abrir: ((file: string) => Reader) | null | undefined;

/** `node:sqlite` no pi, `bun:sqlite` nos testes; sem nenhum dos dois, nada é lido. */
function abridor(): ((file: string) => Reader) | null {
	if (abrir !== undefined) return abrir;
	abrir = null;
	const req = createRequire(import.meta.url);
	// Specifier por variável: nem o bun nem o esbuild tentam resolver em build.
	const nodeId = "node:sqlite";
	const bunId = "bun:sqlite";
	try {
		const { DatabaseSync } = req(nodeId) as NodeSqlite;
		abrir = (file) => {
			const db = new DatabaseSync(file, { readOnly: true });
			return {
				all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
				close: () => db.close(),
			};
		};
		return abrir;
	} catch {
		/* runtime sem node:sqlite */
	}
	try {
		const { Database } = req(bunId) as BunSqlite;
		abrir = (file) => {
			const db = new Database(file, { readonly: true });
			return {
				all: (sql, ...params) => db.query(sql).all(...params) as Record<string, unknown>[],
				close: () => db.close(),
			};
		};
	} catch {
		/* runtime sem sqlite embutido */
	}
	return abrir;
}

/** Força a conexão a tocar no banco: o erro de WAL sem `-shm` só aparece aqui. */
function sondar(reader: Reader): Reader {
	try {
		reader.all("SELECT 1");
	} catch (error) {
		try {
			reader.close();
		} catch {
			/* ignore */
		}
		throw error;
	}
	return reader;
}

function abrirLeitura(database: string): Reader | null {
	const open = abridor();
	if (!open || !existsSync(database)) return null;
	try {
		return sondar(open(database));
	} catch {
		// Sem o `-shm` ao lado, algumas implementações recusam ler um banco WAL
		// em modo leitura (o erro aparece na abertura ou na primeira consulta);
		// cai para o plano B.
	}
	try {
		// `immutable=1` não cria nem toca em arquivo nenhum; em troca ignora o
		// `-wal`. Só se chega aqui quando não existe `-shm`, ou seja, quando
		// ninguém está com a sessão aberta.
		return sondar(open(`file:${encodeURI(database)}?immutable=1`));
	} catch {
		// Banco de versão futura, corrompido ou sem permissão: fecha calado.
		return null;
	}
}

// ---------- leitura de uma sessão ----------

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export interface DurableUsageMsg {
	/** ISO; cai para a mtime do banco quando a mensagem não tem timestamp. */
	timestamp: string;
	role: "assistant" | "toolResult" | "other";
	provider?: string;
	model?: string;
	toolName?: string;
	usage: Usage;
}

export interface DurableSession {
	id: string;
	directory: string;
	database: string;
	/** "" quando o documento `pi.agent` não pôde ser lido. */
	cwd: string;
	/** Textos dos primeiros prompts do usuário, na ordem. */
	users: string[];
	provider: string;
	modelId: string;
	modified: number;
	/** Mensagens com `usage`; só preenchido com `opts.usage`. */
	usage: DurableUsageMsg[];
	/** Há alguma entrada de conversa no banco. */
	entradas: number;
}

interface Message {
	role?: string;
	content?: unknown;
	provider?: string;
	model?: string;
	toolName?: string;
	usage?: Usage;
	timestamp?: number;
}

interface EntryRecord {
	kind?: string;
	model?: Message[];
	conversationId?: number;
}

function parseRecord(row: Record<string, unknown>): EntryRecord | null {
	const raw = row.record;
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as EntryRecord;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function textoDe(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const partes: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = (part as { text?: string }).text;
			if (typeof text === "string") partes.push(text);
		}
	}
	return partes.join("\n");
}

function mtimeOf(database: string): number {
	let maior = 0;
	for (const path of [database, `${database}-wal`]) {
		try {
			maior = Math.max(maior, statSync(path).mtimeMs);
		} catch {
			/* arquivo ausente */
		}
	}
	return maior;
}

/**
 * Lê uma sessão durável. `opts.usage` varre todas as entradas (para o /cost);
 * sem ele a leitura é rasa: cwd, primeiros prompts e último modelo.
 */
export function readDurableSession(
	path: string,
	opts: { usage?: boolean; users?: number } = {},
): DurableSession | null {
	const directory = durableDirOf(path);
	const database = durableDbOf(path);
	const base: DurableSession = {
		id: basename(directory),
		directory,
		database,
		cwd: "",
		users: [],
		provider: "",
		modelId: "",
		modified: mtimeOf(database),
		usage: [],
		entradas: 0,
	};
	const db = abrirLeitura(database);
	if (!db) return base.modified > 0 ? base : null;
	try {
		const raiz = db.all("SELECT MIN(id) AS id FROM conversations")[0]?.id;
		const rootId = typeof raiz === "number" ? raiz : 0;

		const agente = db.all(
			`SELECT r.content AS content FROM documents d
			 JOIN document_revisions r ON r.document_id = d.id
			 WHERE d.kind = '"pi.agent"' AND d.scope_kind = 'conversation' AND d.owner_id = ?
			   AND r.kind = 'base'
			 ORDER BY r.seq DESC LIMIT 1`,
			rootId,
		)[0]?.content;
		if (typeof agente === "string") {
			try {
				const estado = JSON.parse(agente) as { cwd?: unknown };
				if (typeof estado.cwd === "string") base.cwd = estado.cwd;
			} catch {
				/* documento ilegível */
			}
		}

		const quantosUsers = Math.max(1, opts.users ?? 3);
		for (const row of db.all(
			`SELECT record FROM entries WHERE conversation_id = ?
			   AND json_extract(record, '$.kind') = 'pi.user' ORDER BY id LIMIT ?`,
			rootId,
			quantosUsers,
		)) {
			const texto = textoDe(parseRecord(row)?.model?.[0]?.content);
			if (texto.trim()) base.users.push(texto);
		}

		const ultimo = db.all(
			`SELECT record FROM entries WHERE conversation_id = ?
			   AND json_extract(record, '$.kind') = 'pi.assistant' ORDER BY id DESC LIMIT 1`,
			rootId,
		)[0];
		const assistente = ultimo ? parseRecord(ultimo)?.model?.[0] : undefined;
		if (assistente) {
			base.provider = typeof assistente.provider === "string" ? assistente.provider : "";
			base.modelId = typeof assistente.model === "string" ? assistente.model : "";
		}

		const total = db.all("SELECT COUNT(*) AS n FROM entries")[0]?.n;
		base.entradas = typeof total === "number" ? total : 0;

		if (opts.usage) {
			const fallback = new Date(base.modified || Date.now()).toISOString();
			for (const row of db.all("SELECT record FROM entries ORDER BY id")) {
				const record = parseRecord(row);
				for (const message of record?.model ?? []) {
					const usage = message?.usage;
					if (!usage || typeof usage !== "object") continue;
					const timestamp =
						typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : fallback;
					const role =
						message.role === "assistant" ? "assistant" : message.role === "toolResult" ? "toolResult" : "other";
					base.usage.push({
						timestamp,
						role,
						...(typeof message.provider === "string" ? { provider: message.provider } : {}),
						...(typeof message.model === "string" ? { model: message.model } : {}),
						...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
						usage,
					});
				}
			}
		}
		return base;
	} catch {
		// Schema diferente do esperado: devolve o que já temos (pelo menos a mtime).
		return base;
	} finally {
		try {
			db.close();
		} catch {
			/* ignore */
		}
	}
}

// ---------- descoberta ----------

export interface DurableRef {
	id: string;
	directory: string;
	database: string;
	/** Diretório-projeto (hash do cwd). */
	hash: string;
	modified: number;
}

function subdirs(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock"))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Sessões duráveis sob `root`; com `cwd`, só as do diretório-projeto daquele cwd. */
export function listDurableSessions(root: string, opts: { cwd?: string } = {}): DurableRef[] {
	const hashes = opts.cwd ? [hashCwd(opts.cwd)] : subdirs(root);
	const refs: DurableRef[] = [];
	for (const hash of hashes) {
		const projeto = join(root, hash);
		for (const id of subdirs(projeto)) {
			const directory = join(projeto, id);
			const database = join(directory, SESSION_DB);
			if (!existsSync(database)) continue;
			refs.push({ id, directory, database, hash, modified: mtimeOf(database) });
		}
	}
	refs.sort((a, b) => b.modified - a.modified || (a.id < b.id ? 1 : -1));
	return refs;
}

/** Diretórios de sessão sob `root`, mesmo sem `session.sqlite` (para o gc). */
export function listDurableDirs(root: string): { directory: string; modified: number }[] {
	const dirs: { directory: string; modified: number }[] = [];
	for (const hash of subdirs(root)) {
		for (const id of subdirs(join(root, hash))) {
			const directory = join(root, hash, id);
			let modified = mtimeOf(join(directory, SESSION_DB));
			if (!modified) {
				try {
					modified = statSync(directory).mtimeMs;
				} catch {
					continue;
				}
			}
			dirs.push({ directory, modified });
		}
	}
	return dirs;
}
