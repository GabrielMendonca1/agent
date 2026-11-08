// Porte enxuto de files.ts (mitsuhiko) para daemon mode.
// CORTES: Quick Look (qlmanage) e reveal no Finder (open -R) — GUI macOS local,
// e o cliente pi pode estar remoto; os tres overlays ui.custom (fuzzyFilter/
// SelectList/DynamicBorder) — ui.custom e stub que pendura no daemon; os atalhos
// ctrl+shift+o / ctrl+shift+r — risco de conflito de teclado no cliente; e o
// spawn de editor externo $EDITOR — usa ctx.ui.editor; e a escrita no editor do
// cliente em "Adicionar ao prompt" — no daemon setEditorText/pasteToEditor
// substituem o texto digitado (getEditorText e stub ""), entao so notificamos.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_ITEMS = 40;
const MAX_EDIT_BYTES = 40 * 1024 * 1024;
const MAX_REFS = 200;

const BOLD = (s: string) => `\u001b[1m${s}\u001b[22m`;
const FAINT = (s: string) => `\u001b[2m${s}\u001b[22m`;

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

type ContentBlock = { type?: string; text?: string; arguments?: Record<string, unknown> };

type FileToolName = "write" | "edit";

interface SessionFileChange {
  operations: Set<FileToolName>;
  lastTimestamp: number;
}

interface FileEntry {
  canonicalPath: string;
  displayPath: string;
  isDirectory: boolean;
  status?: string;
  isReferenced: boolean;
  hasSessionChange: boolean;
  lastTimestamp: number;
}

const extractFileReferencesFromText = (text: string): string[] => {
  const refs: string[] = [];
  for (const match of text.matchAll(FILE_TAG_REGEX)) refs.push(match[1]);
  for (const match of text.matchAll(FILE_URL_REGEX)) refs.push(match[0]);
  for (const match of text.matchAll(PATH_REGEX)) refs.push(match[1]);
  return refs;
};

const extractFileReferencesFromToolArgs = (args: unknown): string[] => {
  if (!args || typeof args !== "object") return [];
  const refs: string[] = [];
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "filepath", "fileName", "filename"]) {
    const value = record[key];
    if (typeof value === "string") refs.push(value);
  }
  for (const key of ["paths", "files", "filePaths"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") refs.push(item);
    }
  }
  return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
  if (typeof content === "string") return extractFileReferencesFromText(content);
  if (!Array.isArray(content)) return [];
  const refs: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      refs.push(...extractFileReferencesFromText(block.text));
    }
    if (block.type === "toolCall") refs.push(...extractFileReferencesFromToolArgs(block.arguments));
  }
  return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
  if (entry.type === "message") {
    return "content" in entry.message ? extractFileReferencesFromContent(entry.message.content) : [];
  }
  if (entry.type === "custom_message") return extractFileReferencesFromContent(entry.content);
  return [];
};

const sanitizeReference = (raw: string): string => {
  let value = raw.trim();
  value = value.replace(/^["'`(<\[]+/, "");
  value = value.replace(/[>"'`,;).\]]+$/, "");
  value = value.replace(/[.,;:]+$/, "");
  return value;
};

const isCommentLikeReference = (value: string): boolean => value.startsWith("//");

const stripLineSuffix = (value: string): string => {
  let result = value.replace(/#L\d+(C\d+)?$/i, "");
  const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
  const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
  const segment = result.slice(segmentStart);
  const colonIndex = segment.indexOf(":");
  if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
    return result.slice(0, segmentStart + colonIndex);
  }
  const lastColon = result.lastIndexOf(":");
  if (lastColon > lastSeparator) {
    const suffix = result.slice(lastColon + 1);
    if (/^\d+(?::\d+)?$/.test(suffix)) result = result.slice(0, lastColon);
  }
  return result;
};

export const normalizeReferencePath = (raw: string, cwd: string): string | null => {
  let candidate = sanitizeReference(raw);
  if (!candidate || isCommentLikeReference(candidate)) return null;

  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }

  candidate = stripLineSuffix(candidate);
  if (!candidate || isCommentLikeReference(candidate)) return null;

  if (candidate.startsWith("~")) candidate = path.join(homedir(), candidate.slice(1));
  if (!path.isAbsolute(candidate)) candidate = path.resolve(cwd, candidate);

  candidate = path.normalize(candidate);
  const root = path.parse(candidate).root;
  if (candidate.length > root.length) candidate = candidate.replace(/[\\/]+$/, "");
  return candidate;
};

const canonicalCwd = (cwd: string): string => {
  try {
    return realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
};

const shortenPath = (absolutePath: string, cwd: string): string => {
  const normalizedCwd = canonicalCwd(cwd);
  if (absolutePath.startsWith(normalizedCwd + path.sep)) return path.relative(normalizedCwd, absolutePath);
  const home = homedir();
  return absolutePath.startsWith(home) ? `~${absolutePath.slice(home.length)}` : absolutePath;
};

const toCanonicalPath = (inputPath: string): { canonicalPath: string; isDirectory: boolean } | null => {
  if (!existsSync(inputPath)) return null;
  try {
    const canonicalPath = realpathSync(inputPath);
    return { canonicalPath, isDirectory: statSync(canonicalPath).isDirectory() };
  } catch {
    return null;
  }
};

const git = (cwd: string, args: string[]): { code: number; stdout: string; stderr: string } => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) return { code: 1, stdout: "", stderr: String(result.error) };
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const getGitRoot = (cwd: string): string | null => {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
};

/** git status --porcelain -z: em rename/copy o formato e `R  <novo>\0<antigo>\0`,
 * entao o caminho do proprio registro e o destino e o par seguinte e descartado. */
const getGitStatusMap = (cwd: string): Map<string, string> => {
  const statusMap = new Map<string, string>();
  const result = git(cwd, ["status", "--porcelain=1", "-z"]);
  if (result.code !== 0 || !result.stdout) return statusMap;

  const parts = result.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    const filePath = part.slice(3);
    if ((status.startsWith("R") || status.startsWith("C")) && parts[i + 1]) {
      i += 1;
    }
    if (!filePath) continue;
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const canonical = toCanonicalPath(resolved);
    statusMap.set(canonical?.canonicalPath ?? path.normalize(resolved), status.replace(/\s/g, "") || status.trim());
  }
  return statusMap;
};

const collectRecentFileReferences = (entries: SessionEntry[], cwd: string, limit: number): string[] => {
  const results: string[] = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
    const refs = extractFileReferencesFromEntry(entries[i]);
    for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
      const normalized = normalizeReferencePath(refs[j], cwd);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      if (existsSync(normalized)) results.push(normalized);
    }
  }
  return results;
};

/** Arquivos tocados por tools write/edit: toolCall casado com o toolResult (que carrega o timestamp). */
const collectSessionFileChanges = (entries: SessionEntry[], cwd: string): Map<string, SessionFileChange> => {
  const toolCalls = new Map<string, { path: string; name: FileToolName }>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, any>>) {
      if (block.type !== "toolCall") continue;
      const name = block.name as FileToolName;
      if (name !== "write" && name !== "edit") continue;
      const filePath = block.arguments?.path;
      if (typeof filePath === "string" && filePath) toolCalls.set(block.id, { path: filePath, name });
    }
  }

  const fileMap = new Map<string, SessionFileChange>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; toolCallId?: string; timestamp?: number };
    if (msg.role !== "toolResult") continue;
    const toolCall = msg.toolCallId ? toolCalls.get(msg.toolCallId) : undefined;
    if (!toolCall) continue;

    const resolved = path.isAbsolute(toolCall.path) ? toolCall.path : path.resolve(cwd, toolCall.path);
    const canonical = toCanonicalPath(resolved);
    if (!canonical) continue;

    const timestamp = msg.timestamp ?? 0;
    const existing = fileMap.get(canonical.canonicalPath);
    if (existing) {
      existing.operations.add(toolCall.name);
      if (timestamp > existing.lastTimestamp) existing.lastTimestamp = timestamp;
    } else {
      fileMap.set(canonical.canonicalPath, { operations: new Set([toolCall.name]), lastTimestamp: timestamp });
    }
  }
  return fileMap;
};

const buildFileEntries = (ctx: ExtensionCommandContext): { files: FileEntry[]; gitRoot: string | null } => {
  const entries = ctx.sessionManager.getEntries();
  const cwd = ctx.cwd;
  const gitRoot = getGitRoot(cwd);
  const statusMap = gitRoot ? getGitStatusMap(gitRoot) : new Map<string, string>();
  const sessionChanges = collectSessionFileChanges(entries, cwd);
  const fileMap = new Map<string, FileEntry>();

  const upsert = (canonicalPath: string, isDirectory: boolean, patch: Partial<FileEntry>) => {
    const existing = fileMap.get(canonicalPath);
    const merged: FileEntry = {
      canonicalPath,
      displayPath: shortenPath(canonicalPath, cwd),
      isDirectory: existing?.isDirectory || isDirectory,
      status: patch.status ?? existing?.status ?? statusMap.get(canonicalPath),
      isReferenced: (existing?.isReferenced ?? false) || patch.isReferenced === true,
      hasSessionChange: (existing?.hasSessionChange ?? false) || patch.hasSessionChange === true,
      lastTimestamp: Math.max(existing?.lastTimestamp ?? 0, patch.lastTimestamp ?? 0),
    };
    fileMap.set(canonicalPath, merged);
  };

  for (const [canonicalPath, status] of statusMap) {
    const canonical = toCanonicalPath(canonicalPath);
    upsert(canonicalPath, canonical?.isDirectory ?? false, { status });
  }

  for (const reference of collectRecentFileReferences(entries, cwd, MAX_REFS)) {
    const canonical = toCanonicalPath(reference);
    if (!canonical) continue;
    upsert(canonical.canonicalPath, canonical.isDirectory, { isReferenced: true });
  }

  for (const [canonicalPath, change] of sessionChanges) {
    const canonical = toCanonicalPath(canonicalPath);
    if (!canonical) continue;
    upsert(canonical.canonicalPath, canonical.isDirectory, {
      hasSessionChange: true,
      lastTimestamp: change.lastTimestamp,
    });
  }

  const files = Array.from(fileMap.values()).sort((a, b) => {
    const aDirty = Boolean(a.status);
    const bDirty = Boolean(b.status);
    if (aDirty !== bDirty) return aDirty ? -1 : 1;
    if (a.lastTimestamp !== b.lastTimestamp) return b.lastTimestamp - a.lastTimestamp;
    if (a.hasSessionChange !== b.hasSessionChange) return a.hasSessionChange ? -1 : 1;
    return a.displayPath.localeCompare(b.displayPath);
  });

  return { files: files.slice(0, MAX_ITEMS), gitRoot };
};

const showDiff = (pi: ExtensionAPI, ctx: ExtensionCommandContext, target: FileEntry, gitRoot: string | null): void => {
  if (!gitRoot) {
    ctx.ui.notify("Fora de um repositório git", "warning");
    return;
  }
  let diff = git(gitRoot, ["diff", "--", target.canonicalPath]).stdout;
  if (!diff.trim()) diff = git(gitRoot, ["diff", "--cached", "--", target.canonicalPath]).stdout;
  if (!diff.trim()) {
    ctx.ui.notify("Sem alterações", "info");
    return;
  }
  pi.sendMessage(
    {
      customType: "file-diff",
      content: `\`\`\`diff\n${diff.replace(/\n$/, "")}\n\`\`\``,
      display: true,
    },
    { triggerTurn: false },
  );
};

const editFile = async (ctx: ExtensionCommandContext, target: FileEntry): Promise<void> => {
  if (!existsSync(target.canonicalPath)) {
    ctx.ui.notify(`Arquivo não encontrado: ${target.displayPath}`, "error");
    return;
  }
  const stats = statSync(target.canonicalPath);
  if (stats.isDirectory()) {
    ctx.ui.notify("Diretórios não podem ser editados", "warning");
    return;
  }
  if (stats.size >= MAX_EDIT_BYTES) {
    ctx.ui.notify("Arquivo grande demais", "warning");
    return;
  }
  const buffer = readFileSync(target.canonicalPath);
  if (buffer.includes(0)) {
    ctx.ui.notify("Arquivo binário", "warning");
    return;
  }

  const content = buffer.toString("utf8");
  const updated = await ctx.ui.editor(target.displayPath, content);
  if (updated === undefined || updated === content) return;

  try {
    writeFileSync(target.canonicalPath, updated, "utf8");
    ctx.ui.notify(`Salvo: ${target.displayPath}`, "info");
  } catch {
    ctx.ui.notify(`Falhou ao salvar ${target.displayPath}`, "error");
  }
};

// No daemon, getEditorText e stub ("") e tanto setEditorText quanto pasteToEditor
// viram um setText do lado do cliente: escrever no editor apagaria o que o usuario
// esta digitando. Entao so entregamos a mencao pronta para colar.
const addToPrompt = (ctx: ExtensionCommandContext, target: FileEntry): void => {
  const mention = `@${target.displayPath}`;
  ctx.ui.notify(`Cole no prompt: ${BOLD(mention)}`, "info");
};

const pickFile = async (ctx: ExtensionCommandContext, files: FileEntry[]): Promise<FileEntry | null> => {
  const labels = files.map((file) => {
    const status = BOLD(file.status ?? "--");
    const origin = file.status ? "git" : "sessão";
    return `${status} ${file.displayPath}${file.isDirectory ? "/" : ""} ${FAINT(origin)}`;
  });
  const picked = await ctx.ui.select(`Arquivos · ${files.length}`, labels);
  if (!picked) return null;
  const index = labels.indexOf(picked);
  return index >= 0 ? files[index] : null;
};

const ACTIONS = ["Ver diff", "Editar", "Adicionar ao prompt", "Mostrar caminho"];

const runFiles = async (pi: ExtensionAPI, ctx: ExtensionCommandContext, straightToDiff: boolean): Promise<void> => {
  const { files, gitRoot } = buildFileEntries(ctx);
  if (files.length === 0) {
    ctx.ui.notify("Nenhum arquivo encontrado", "info");
    return;
  }

  const target = await pickFile(ctx, files);
  if (!target) return;

  if (straightToDiff) {
    showDiff(pi, ctx, target, gitRoot);
    return;
  }

  const action = await ctx.ui.select(target.displayPath, ACTIONS);
  if (!action) return;

  switch (action) {
    case "Ver diff":
      showDiff(pi, ctx, target, gitRoot);
      break;
    case "Editar":
      await editFile(ctx, target);
      break;
    case "Adicionar ao prompt":
      addToPrompt(ctx, target);
      break;
    case "Mostrar caminho":
      ctx.ui.notify(BOLD(target.canonicalPath), "info");
      break;
  }
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("files", {
    description: "Arquivos do git status e referenciados na sessão",
    handler: async (_args: string, ctx: ExtensionCommandContext) => runFiles(pi, ctx, false),
  });
  pi.registerCommand("diff", {
    description: "Diff de um arquivo alterado",
    handler: async (_args: string, ctx: ExtensionCommandContext) => runFiles(pi, ctx, true),
  });
}
