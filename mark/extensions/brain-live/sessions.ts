/**
 * /sessions and /gc use official classic JSONL sessions.
 * Old durable SQLite sessions are listed read-only for historical context;
 * they are never resumed or pruned by the classic host.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  durableDirOf,
  durableRoot,
  listDurableSessions,
  readDurableSession,
} from "./lib/durable-sessions.ts";

const MAX_SESSIONS = 30;
const EMPTY_TTL_MS = 60 * 60 * 1000;
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEAD_BYTES = 64 * 1024;
const PREVIEW_WIDTH = 60;
const PREVIEW_KEEP = 4 * PREVIEW_WIDTH;
const MODEL_WIDTH = 26;
const NO_PREVIEW = "(no preview)";
const PAST_HEAD = "(preview past 64 KiB)";
const LEGACY_TAG = "legado";

export interface ModelInfo {
  provider: string;
  modelId: string;
}

export interface Entry {
  /** Arquivo JSONL para retomada, ou diretório histórico SQLite somente leitura. */
  path: string;
  id: string;
  cwd: string;
  modified: number;
  preview: string;
  truncated: boolean;
  provider: string;
  modelId: string;
  /** Sessão do pi durável (SQLite); falso para os JSONL oficiais. */
  durable: boolean;
}

/** Onde procurar sessões: JSONL oficiais e histórico durável. */
export interface Roots {
  /** Diretórios-projeto com `*.jsonl`. */
  jsonl: string[];
  /** `<agentDir>/durable-sessions`, ou undefined quando não há. */
  durable?: string;
  /** A sessão atual: arquivo JSONL. */
  current?: string;
}

export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, PREVIEW_KEEP);
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: string }).text;
      if (typeof text === "string" && text.trim()) return text.slice(0, PREVIEW_KEEP);
    }
  }
  return "";
}

function isBoilerplate(text: string): boolean {
  const flat = text.trimStart();
  return (
    /^\[(Base|Sistema|peers |pi-relay|system)/i.test(flat) ||
    /^You are operating/i.test(flat) ||
    /^<\/?[a-z]/i.test(flat) ||
    flat.startsWith("{")
  );
}

function modelFrom(entry: Record<string, unknown>): ModelInfo | null {
  if (entry.type === "model_change") {
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const modelId = typeof entry.modelId === "string" ? entry.modelId : "";
    return provider || modelId ? { provider, modelId } : null;
  }
  if (entry.type === "message") {
    const message = entry.message as { role?: string; provider?: string; model?: string } | undefined;
    if (message?.role === "assistant") {
      const provider = typeof message.provider === "string" ? message.provider : "";
      const modelId = typeof message.model === "string" ? message.model : "";
      return provider || modelId ? { provider, modelId } : null;
    }
  }
  return null;
}

function readAt(path: string, position: number, length: number): { text: string; read: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, position);
    return { text: buffer.toString("utf8", 0, read), read };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function parseSessionHead(path: string): Omit<Entry, "modified" | "durable"> | null {
  const head = readAt(path, 0, HEAD_BYTES + 1);
  if (!head) return null;

  const truncated = head.read > HEAD_BYTES;
  const lines = head.text.split("\n");
  if (truncated) lines.pop();

  let header = false;
  let id = basename(path, ".jsonl");
  let cwd = "";
  let preview = "";
  let fallback = "";
  let model: ModelInfo | null = null;

  for (const line of lines) {
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const entry = rec as Record<string, unknown>;
    if (entry.type === "session") {
      header = true;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      if (typeof entry.id === "string" && entry.id) id = entry.id;
      continue;
    }
    const seen = modelFrom(entry);
    if (seen) model = seen;
    if (!preview && entry.type === "message") {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === "user") {
        const text = firstText(message.content);
        if (text && isBoilerplate(text)) {
          if (!fallback) fallback = text;
        } else if (text) {
          preview = text;
        }
      }
    }
  }

  if (!header) return null;
  return {
    path,
    id,
    cwd,
    preview: preview || fallback,
    truncated,
    provider: model?.provider ?? "",
    modelId: model?.modelId ?? "",
  };
}

export function tailModel(path: string, size: number): ModelInfo | null {
  if (size <= HEAD_BYTES) return null;
  const tail = readAt(path, size - HEAD_BYTES, HEAD_BYTES);
  if (!tail) return null;

  const cut = tail.text.indexOf("\n");
  if (cut === -1) return null;

  let model: ModelInfo | null = null;
  for (const line of tail.text.slice(cut + 1).split("\n")) {
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const seen = modelFrom(rec as Record<string, unknown>);
    if (seen) model = seen;
  }
  return model;
}

export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function clip(text: string, width: number, empty = NO_PREVIEW): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return empty;
  const chars = Array.from(flat);
  if (chars.length <= width) return flat;
  return `${chars.slice(0, width - 1).join("")}…`;
}

export function modelTag(entry: Pick<Entry, "provider" | "modelId">): string {
  const provider = (entry.provider ?? "").trim();
  const modelId = (entry.modelId ?? "").trim();
  if (!provider && !modelId) return "";
  return clip(provider && modelId ? `${provider}/${modelId}` : provider || modelId, MODEL_WIDTH, "");
}

export function collect(dir: string, currentPath?: string, projectCwd?: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const current = currentPath ? canonical(currentPath) : undefined;
  const target = projectCwd ? canonical(projectCwd) : undefined;

  const candidates: { path: string; name: string; modified: number; size: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let modified: number;
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      modified = stat.mtimeMs;
      size = stat.size;
    } catch {
      continue;
    }
    if (current && canonical(path) === current) continue;
    candidates.push({ path, name, modified, size });
  }

  candidates.sort((a, b) => b.modified - a.modified || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const entries: Entry[] = [];
  for (const candidate of candidates) {
    if (entries.length >= MAX_SESSIONS) break;
    const head = parseSessionHead(candidate.path);
    if (!head) continue;
    if (target && (!head.cwd || canonical(head.cwd) !== target)) continue;
    const late = tailModel(candidate.path, candidate.size);
    entries.push({
      ...head,
      durable: false,
      modified: candidate.modified,
      provider: late ? late.provider : head.provider,
      modelId: late ? late.modelId : head.modelId,
    });
  }
  return entries;
}

/** Uma sessão durável vira Entry: preview = primeiro prompt não-boilerplate. */
export function durableEntry(path: string): Entry | null {
  const session = readDurableSession(path, { users: 4 });
  if (!session) return null;
  let preview = "";
  let fallback = "";
  for (const text of session.users) {
    const corte = text.slice(0, PREVIEW_KEEP);
    if (isBoilerplate(corte)) {
      if (!fallback) fallback = corte;
    } else if (corte.trim()) {
      preview = corte;
      break;
    }
  }
  return {
    path: session.directory,
    id: session.id,
    cwd: session.cwd,
    modified: session.modified,
    preview: preview || fallback,
    truncated: false,
    provider: session.provider,
    modelId: session.modelId,
    durable: true,
  };
}

/** Sessões duráveis sob `root`, da mais nova para a mais velha. */
export function collectDurable(root: string, currentPath?: string, projectCwd?: string): Entry[] {
  const current = currentPath ? canonical(durableDirOf(currentPath)) : undefined;
  const target = projectCwd ? canonical(projectCwd) : undefined;
  const entries: Entry[] = [];
  for (const ref of listDurableSessions(root, projectCwd ? { cwd: projectCwd } : {})) {
    if (entries.length >= MAX_SESSIONS) break;
    if (current && canonical(ref.directory) === current) continue;
    const entry = durableEntry(ref.directory);
    if (!entry) continue;
    // O diretório-projeto já é o hash do cwd; o cwd lido confirma quando dá.
    if (target && entry.cwd && canonical(entry.cwd) !== target) continue;
    entries.push(entry);
  }
  return entries;
}

/** JSONL antigos + duráveis, misturados por data de modificação. */
export function collectAll(roots: Roots, projectCwd?: string): Entry[] {
  const entries: Entry[] = [];
  for (const dir of roots.jsonl) entries.push(...collect(dir, roots.current, projectCwd));
  if (roots.durable) entries.push(...collectDurable(roots.durable, roots.current, projectCwd));
  entries.sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries.slice(0, MAX_SESSIONS);
}

/** Classic JSONL roots, plus optional read-only durable history. */
export function resolveRoots(sessionDir: string | undefined, sessionFile: string | undefined): Roots {
  const jsonl = sessionDir ? [sessionDir] : [];
  let durable: string | undefined;
  if (sessionDir) {
    const root = dirname(sessionDir);
    // Só expande para os projetos vizinhos no layout do pi (`<agentDir>/sessions/<projeto>`).
    if (basename(root) === "sessions") {
      for (const dir of jsonlProjectDirs(root)) if (dir !== sessionDir) jsonl.push(dir);
      durable = durableRoot(dirname(root));
    }
  }
  return {
    jsonl,
    ...(durable ? { durable } : {}),
    ...(sessionFile ? { current: sessionFile } : {}),
  };
}

function jsonlProjectDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function label(entry: Entry, index: number, markLegacy = false): string {
  const where = entry.cwd ? basename(entry.cwd) : "?";
  const id = entry.id.length > 8 ? entry.id.slice(-8) : entry.id;
  const position = String(index + 1).padStart(2, "0");
  const parts = [position, stamp(entry.modified), where, id];
  if (markLegacy && !entry.durable) parts.push(LEGACY_TAG);
  const model = modelTag(entry);
  if (model) parts.push(model);
  parts.push(clip(entry.preview, PREVIEW_WIDTH, entry.truncated ? PAST_HEAD : NO_PREVIEW));
  return parts.join("  ");
}

function shortenPath(path: string): string {
  if (!path) return "?";
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

class SessionPicker {
  private selected = 0;

  constructor(
    private entries: Entry[],
    private dir: string,
    private tui: TUI,
    private theme: { bold(text: string): string; bg(color: string, text: string): string },
    private done: (entry: Entry | null) => void,
    private markLegacy = false,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = ["", ` ${this.theme.bold("Sessões")} ${clip(shortenPath(this.dir), Math.max(10, width - 12), "")}`, ""];
    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      const tag = this.markLegacy && !entry.durable ? ` ${LEGACY_TAG}` : "";
      const row = ` ${index === this.selected ? "›" : " "} ${shortenPath(entry.cwd)}${tag}  ${clip(entry.preview, Math.max(10, width - 40), entry.truncated ? PAST_HEAD : NO_PREVIEW)}`;
      lines.push(index === this.selected ? this.theme.bg("selectedBg", row.padEnd(width)) : row);
    }
    lines.push("", ` ${this.selected + 1}/${this.entries.length} · ↑↓ navegar · Enter retomar · Esc sair`);
    return lines;
  }

  handleInput(data: string): void {
    const n = this.entries.length;
    if (data === "\u001b[A" || data === "k") this.selected = this.selected === 0 ? n - 1 : this.selected - 1;
    else if (data === "\u001b[B" || data === "j") this.selected = this.selected === n - 1 ? 0 : this.selected + 1;
    else if (data === "\r" || data === "\n") return this.done(this.entries[this.selected] ?? null);
    else if (data === "\u001b" || data === "\u0003") return this.done(null);
    this.tui.requestRender();
  }
}

async function confirmElsewhere(ctx: ExtensionCommandContext, cwd: string): Promise<boolean> {
  const title = "Resume session from another project?";
  const message = `This session belongs to ${cwd}. Resuming moves the working directory there.`;
  return (await ctx.ui.confirm(title, message)) === true;
}

function pruneSessions(dir: string, currentPath?: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }

  const current = currentPath ? canonical(currentPath) : undefined;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    if (current && canonical(path) === current) continue;

    let modified: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      modified = stat.mtimeMs;
    } catch {
      continue;
    }

    const parsed = parseSessionHead(path);
    if (!parsed) continue;
    const ageMs = Date.now() - modified;
    // Um preview pode estar depois do limite de 64 KiB; nunca trate esse caso
    // como vazio. Sessões válidas antigas continuam sujeitas ao TTL de 30 dias.
    const empty = !parsed.preview && !parsed.truncated;
    if (!((empty && ageMs > EMPTY_TTL_MS) || ageMs > STALE_TTL_MS)) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      // Arquivo sumiu ou ficou sem permissão entre a leitura e a remoção.
    }
  }
  return removed;
}

export default function (pi: ExtensionAPI) {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const all = typeof args === "string" && args.trim().toLowerCase() === "all";

    let dir: string;
    let current: string | undefined;
    try {
      dir = ctx.sessionManager.getSessionDir();
      current = ctx.sessionManager.getSessionFile();
    } catch {
      ctx.ui.notify("Could not resolve the session directory.", "error");
      return;
    }

    const roots = resolveRoots(dir, current);
    const projectCwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : undefined;
    const entries = collectAll(roots, all ? undefined : projectCwd);
    if (entries.length === 0) {
      ctx.ui.notify(
        all || !projectCwd
          ? `No other sessions in ${dir}`
          : `No other sessions for ${projectCwd} — try /sessions all`,
        "info",
      );
      return;
    }

    // Classic JSONL sessions are the current format.
    const markLegacy = false;
    const labels: string[] = [];
    const byLabel = new Map<string, Entry>();
    entries.forEach((entry, index) => {
      const text = `${label(entry, index, markLegacy)}  [${shortenPath(entry.cwd)}]`;
      labels.push(text);
      byLabel.set(text, entry);
    });

    const scope = all || !projectCwd ? "all projects" : basename(projectCwd);
    let target: Entry | null = null;
    let customRan = false;
    try {
      const customUsable = typeof ctx.ui.custom === "function" && ctx.ui.getAllThemes().length > 0;
      if (customUsable) {
        target =
          (await ctx.ui.custom<Entry | null>((tui, theme, _keybindings, done) => {
            customRan = true;
            return new SessionPicker(entries, dir, tui, theme, done, markLegacy);
          })) ?? null;
      }
    } catch {
      customRan = false;
    }

    if (!customRan) {
      const picked = await ctx.ui.select(`Sessions — ${scope} (${entries.length})`, labels);
      if (!picked) return;
      target = byLabel.get(picked) ?? null;
      if (!target) {
        ctx.ui.notify("Selection did not match a listed session.", "warning");
        return;
      }
    }

    if (!target) return;
    if (target.durable) {
      ctx.ui.notify("Sessão durável histórica: somente leitura; retome uma sessão JSONL do Pi clássico.", "warning");
      return;
    }

    const elsewhere = Boolean(
      target.cwd && projectCwd && canonical(target.cwd) !== canonical(projectCwd),
    );
    if (elsewhere && !(await confirmElsewhere(ctx, target.cwd))) return;

    let result: { cancelled: boolean } | undefined;
    try {
      result = await ctx.switchSession(target.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to resume ${basename(target.path)}: ${reason}`, "error");
      return;
    }

    if (result?.cancelled) {
      ctx.ui.notify("Session switch cancelled.", "warning");
      return;
    }

    ctx.ui.notify(`Resumed ${basename(target.path)}${elsewhere ? ` (${target.cwd})` : ""}`, "info");
  };

  // Poda só por pedido explícito (`/gc`). Nada de apagar histórico no startup: a sessão antiga
  // de qualquer projeto da mesma pasta é do usuário, e a exclusão não tem como ser confirmada
  // antes (em modo sem UI não haveria nem aviso).
  const gc = async (ctx: ExtensionContext) => {
    let dir: string | undefined;
    let current: string | undefined;
    try {
      dir = ctx.sessionManager.getSessionDir();
      current = ctx.sessionManager.getSessionFile();
    } catch {
      // Sem session dir (por exemplo, --no-session): nada a podar.
    }
    const roots = dir ? resolveRoots(dir, current) : undefined;
    let removed = 0;
    for (const projeto of roots?.jsonl ?? []) removed += pruneSessions(projeto, roots?.current);
    if (ctx.hasUI) {
      ctx.ui.notify(`gc: ${removed} sessão(ões) apagada(s)`, "info");
    }
  };

  const description = "Browse and resume a saved session (pass 'all' for every project)";
  pi.registerCommand("sessions", { description, handler });
  pi.registerCommand("gc", {
    description: "Apagar sessões velhas/vazias",
    handler: async (_args: string, ctx: ExtensionCommandContext) => gc(ctx),
  });
}
