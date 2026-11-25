// Arquivos no chat do Megamind: o agente manda arquivos locais e baixa os que
// recebe. MCP não carrega bytes, então o envio é o multipart de
// POST /api/arca/chat com a credencial do dispositivo, e a baixa é
// GET /api/arca/chat/{id}/attachments/{nome}. Módulo puro — sem `pi`.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { assertSafeUrl, metadata, object, redactBearer, text, token, type JsonObject } from "./gateway.ts";
import { megamindName } from "./profile.ts";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".html": "text/html", ".zip": "application/zip", ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export type LocalFile = { path: string; name: string; mime: string; size: number };

/** Caminhos do agente (`~`, relativo ao cwd) → arquivos regulares dentro dos limites do servidor. */
export async function resolveFiles(paths: readonly string[], cwd: string): Promise<LocalFile[]> {
  if (paths.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} files per message`);
  const out: LocalFile[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
    const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`file not found: ${trimmed}`);
    if (info.size === 0) throw new Error(`empty file: ${trimmed}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`file larger than 25 MiB: ${trimmed}`);
    out.push({ path, name: basename(path), mime: MIME[extname(path).toLowerCase()] ?? "application/octet-stream", size: info.size });
  }
  return out;
}

/** Rota irmã do endpoint MCP (`…/mcp` → `…/chat`), sem credencial na URL. */
export function chatUrl(endpoint: string, ...segments: string[]): URL {
  const { pathname } = new URL(endpoint);
  const base = pathname.replace(/\/mcp\/*$/u, "/chat");
  const path = [base === pathname ? "/api/arca/chat" : base, ...segments.map(encodeURIComponent)].join("/");
  return assertSafeUrl(new URL(path, endpoint).toString());
}

async function authorized(signal?: AbortSignal): Promise<{ endpoint: string; bearer: string; signal: AbortSignal }> {
  const config = await metadata();
  const bearer = await token(config.tokenFile);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return { endpoint: config.endpoint, bearer, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

async function failure(response: Response, what: string): Promise<Error> {
  // Rota sem o ramo de agente: Mainframe anterior a esta versão.
  if (response.status === 404 || response.status === 405) {
    return new Error(`this ${megamindName()} does not accept files from agents yet (HTTP ${response.status})`);
  }
  let code = "";
  try {
    const body: unknown = await response.json();
    if (object(body) && object(body.error)) code = text(body.error.code) ?? "";
  } catch {
    // corpo não-JSON: fica só o status
  }
  return new Error(redactBearer(`${what}: HTTP ${response.status}${code ? ` ${code}` : ""}`));
}

export type UploadArgs = { session_id: string; channel: string; to_session?: string; body: string; request_id: string; files: readonly LocalFile[] };

/** Envia a mensagem com arquivos; a resposta é a mesma do `chat_post` (`message_id`, `woken`). */
export async function uploadChat(args: UploadArgs, signal?: AbortSignal): Promise<JsonObject> {
  const auth = await authorized(signal);
  const form = new FormData();
  form.set("session_id", args.session_id);
  form.set("channel", args.channel);
  if (args.to_session) form.set("to_session", args.to_session);
  form.set("request_id", args.request_id);
  if (args.body) form.set("body", args.body);
  for (const file of args.files) {
    form.append("attachments", new Blob([await readFile(file.path)], { type: file.mime }), file.name);
  }
  const response = await fetch(chatUrl(auth.endpoint), {
    method: "POST",
    redirect: "error",
    headers: { Accept: "application/json", Authorization: `Bearer ${auth.bearer}` },
    body: form,
    signal: auth.signal,
  });
  if (!response.ok) throw await failure(response, "file upload refused");
  const result: unknown = await response.json();
  return object(result) ? result : {};
}

/** Nome salvo em disco: um único componente, sem `..` nem separador. */
export function safeFileName(name: string): string {
  const leaf = name.split(/[/\\]/u).pop()?.replace(/[\p{Cc}<>:"|?*]/gu, "_").trim() ?? "";
  return !leaf || leaf === "." || leaf === ".." ? "arquivo" : leaf.slice(0, 200);
}

/** Pasta padrão da baixa: `<cwd>/.megamind/inbox/<id>`, ou o tmp sem cwd. */
export function inboxDir(cwd: string | undefined, message_id: string): string {
  return join(cwd || tmpdir(), ".megamind", "inbox", safeFileName(message_id));
}

/** Baixa um anexo de uma mensagem que esta credencial pode ler; devolve o caminho salvo. */
export async function downloadAttachment(message_id: string, name: string, dir: string, signal?: AbortSignal): Promise<string> {
  const auth = await authorized(signal);
  const response = await fetch(chatUrl(auth.endpoint, message_id, "attachments", name), {
    redirect: "error",
    headers: { Authorization: `Bearer ${auth.bearer}` },
    signal: auth.signal,
  });
  if (!response.ok) throw await failure(response, `baixa de ${name} recusada`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_FILE_BYTES) throw new Error(`${name} is larger than 25 MiB`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${name} is larger than 25 MiB`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeFileName(name));
  await writeFile(path, bytes);
  return path;
}

/** `@handle` → handle e o grupo → seu canal: só o chat recebe arquivo. */
export function chatChannelOf(to: string, group: string, alias = group): string | undefined {
  const value = to.trim().toLowerCase().replace(/^#/u, "");
  if (value === group || value === alias) return group;
  if (/^@[a-z][a-z0-9-]{1,31}$/u.test(value)) return value.slice(1);
  return undefined;
}
