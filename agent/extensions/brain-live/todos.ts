/**
 * Todos de TRABALHO DE AGENTE, com escopo de projeto: arquivos em `.pi/todos`
 * (relativo ao cwd, ou PI_TODO_PATH), um markdown por item, para sessões pi
 * concorrentes se coordenarem via claim/release.
 *
 * Não substitui a lista pessoal de tarefas do usuário.
 *
 * Formato de <todo-dir>/<id>.md:
 * - front matter JSON (não YAML): { id, title, tags, status, created_at, assigned_to_session }
 * - corpo markdown opcional depois de uma linha em branco
 *
 * Settings em <todo-dir>/settings.json: { "gc": true, "gcDays": 7 } — no
 * session_start apaga todos fechados mais velhos que gcDays.
 *
 * Porte enxuto de mitsuhiko/todos.ts. Cortado de propósito, porque pi roda em
 * daemon mode e `ui.custom` pendura: as 4 classes TUI (seletor, menu de ação,
 * confirmação de delete, overlay de detalhe) e os `ui.custom`; copyToClipboard;
 * buildRefinePrompt e a integração de refine; DynamicBorder/getMarkdownTheme/
 * keyHint; a renderização temática (renderTodoHeading/renderTodoList/
 * renderTodoDetail) e os renderCall/renderResult que dependiam dela. `/todos`
 * usa ui.select, que funciona no daemon. fuzzyMatch (pi-tui) virou match por
 * substring para não arrastar a dependência de TUI.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_SETTINGS_NAME = "settings.json";
const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const DEFAULT_TODO_SETTINGS = { gc: true, gcDays: 7 };
const LOCK_TTL_MS = 30 * 60 * 1000;

const BOLD = (s: string) => `\u001b[1m${s}\u001b[22m`;
const FAINT = (s: string) => `\u001b[2m${s}\u001b[22m`;

interface TodoFrontMatter {
  id: string;
  title: string;
  tags: string[];
  status: string;
  created_at: string;
  assigned_to_session?: string;
}

interface TodoRecord extends TodoFrontMatter {
  body: string;
}

interface LockInfo {
  id: string;
  pid: number;
  created_at: string;
}

interface TodoSettings {
  gc: boolean;
  gcDays: number;
}

export const TodoParams = Type.Object({
  action: StringEnum([
    "list",
    "list-all",
    "get",
    "create",
    "update",
    "append",
    "delete",
    "claim",
    "release",
  ] as const),
  id: Type.Optional(Type.String({ description: "Todo id (TODO-<hex> or raw hex filename)" })),
  title: Type.Optional(Type.String({ description: "Short summary shown in lists" })),
  status: Type.Optional(Type.String({ description: "Todo status" })),
  tags: Type.Optional(Type.Array(Type.String({ description: "Todo tag" }))),
  body: Type.Optional(
    Type.String({ description: "Long-form details (markdown). Update replaces; append adds." }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Override another session's assignment" })),
});

type TodoAction =
  | "list"
  | "list-all"
  | "get"
  | "create"
  | "update"
  | "append"
  | "delete"
  | "claim"
  | "release";

type TodoToolDetails =
  | { action: "list" | "list-all"; todos: TodoFrontMatter[]; currentSessionId?: string; error?: string }
  | {
      action: "get" | "create" | "update" | "append" | "delete" | "claim" | "release";
      todo?: TodoRecord;
      error?: string;
    };

export function formatTodoId(id: string): string {
  return `${TODO_ID_PREFIX}${id}`;
}

export function normalizeTodoId(id: string): string {
  let trimmed = id.trim();
  if (trimmed.startsWith("#")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
    trimmed = trimmed.slice(TODO_ID_PREFIX.length);
  }
  return trimmed;
}

export function validateTodoId(id: string): { id: string } | { error: string } {
  const normalized = normalizeTodoId(id);
  if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
    return { error: "Invalid todo id. Expected TODO-<hex>." };
  }
  return { id: normalized.toLowerCase() };
}

function displayTodoId(id: string): string {
  return formatTodoId(normalizeTodoId(id));
}

function isTodoClosed(status: string): boolean {
  return ["closed", "done"].includes(status.toLowerCase());
}

function getTodoTitle(todo: TodoFrontMatter): string {
  return todo.title || "(untitled)";
}

function getTodoStatus(todo: TodoFrontMatter): string {
  return todo.status || "open";
}

function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
  if (isTodoClosed(getTodoStatus(todo))) {
    todo.assigned_to_session = undefined;
  }
}

function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
  return [...todos].sort((a, b) => {
    const aClosed = isTodoClosed(a.status);
    const bClosed = isTodoClosed(b.status);
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    const aAssigned = !aClosed && Boolean(a.assigned_to_session);
    const bAssigned = !bClosed && Boolean(b.assigned_to_session);
    if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
}

function buildTodoSearchText(todo: TodoFrontMatter): string {
  const tags = todo.tags.join(" ");
  const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
  return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment}`.trim();
}

export function filterTodos(todos: TodoFrontMatter[], query: string): TodoFrontMatter[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return todos;

  return sortTodos(
    todos.filter((todo) => {
      const text = buildTodoSearchText(todo).toLowerCase();
      return tokens.every((token) => text.includes(token));
    }),
  );
}

function getTodosDir(cwd: string): string {
  const overridePath = process.env[TODO_PATH_ENV];
  if (overridePath && overridePath.trim()) {
    return path.resolve(cwd, overridePath.trim());
  }
  return path.resolve(cwd, TODO_DIR_NAME);
}

function getTodosDirLabel(cwd: string): string {
  const overridePath = process.env[TODO_PATH_ENV];
  if (overridePath && overridePath.trim()) {
    return path.resolve(cwd, overridePath.trim());
  }
  return TODO_DIR_NAME;
}

function getTodoSettingsPath(todosDir: string): string {
  return path.join(todosDir, TODO_SETTINGS_NAME);
}

function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
  const gc = raw.gc ?? DEFAULT_TODO_SETTINGS.gc;
  const gcDays = Number.isFinite(raw.gcDays) ? (raw.gcDays as number) : DEFAULT_TODO_SETTINGS.gcDays;
  return { gc: Boolean(gc), gcDays: Math.max(0, Math.floor(gcDays)) };
}

async function readTodoSettings(todosDir: string): Promise<TodoSettings> {
  let data: Partial<TodoSettings> = {};
  try {
    data = JSON.parse(await fs.readFile(getTodoSettingsPath(todosDir), "utf8")) as Partial<TodoSettings>;
  } catch {
    data = {};
  }
  return normalizeTodoSettings(data);
}

async function garbageCollectTodos(todosDir: string, settings: TodoSettings): Promise<void> {
  if (!settings.gc) return;

  let entries: string[] = [];
  try {
    entries = await fs.readdir(todosDir);
  } catch {
    return;
  }

  const cutoff = Date.now() - settings.gcDays * 24 * 60 * 60 * 1000;
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) => {
        const id = entry.slice(0, -3);
        const filePath = path.join(todosDir, entry);
        try {
          const content = await fs.readFile(filePath, "utf8");
          const { frontMatter } = splitFrontMatter(content);
          const parsed = parseFrontMatter(frontMatter, id);
          if (!isTodoClosed(parsed.status)) return;
          const createdAt = Date.parse(parsed.created_at);
          if (!Number.isFinite(createdAt)) return;
          if (createdAt < cutoff) {
            await fs.unlink(filePath);
          }
        } catch {
          // todo ilegível: ignora
        }
      }),
  );
}

function getTodoPath(todosDir: string, id: string): string {
  return path.join(todosDir, `${id}.md`);
}

function getLockPath(todosDir: string, id: string): string {
  return path.join(todosDir, `${id}.lock`);
}

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
  const data: TodoFrontMatter = {
    id: idFallback,
    title: "",
    tags: [],
    status: "open",
    created_at: "",
    assigned_to_session: undefined,
  };

  const trimmed = text.trim();
  if (!trimmed) return data;

  try {
    const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
    if (!parsed || typeof parsed !== "object") return data;
    if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
    if (typeof parsed.title === "string") data.title = parsed.title;
    if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
    if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
    if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
      data.assigned_to_session = parsed.assigned_to_session;
    }
    if (Array.isArray(parsed.tags)) {
      data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
    }
  } catch {
    return data;
  }

  return data;
}

function findJsonObjectEnd(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  if (!content.startsWith("{")) {
    return { frontMatter: "", body: content };
  }

  const endIndex = findJsonObjectEnd(content);
  if (endIndex === -1) {
    return { frontMatter: "", body: content };
  }

  const frontMatter = content.slice(0, endIndex + 1);
  const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
  return { frontMatter, body };
}

export function parseTodoContent(content: string, idFallback: string): TodoRecord {
  const { frontMatter, body } = splitFrontMatter(content);
  const parsed = parseFrontMatter(frontMatter, idFallback);
  return {
    id: idFallback,
    title: parsed.title,
    tags: parsed.tags ?? [],
    status: parsed.status,
    created_at: parsed.created_at,
    assigned_to_session: parsed.assigned_to_session,
    body: body ?? "",
  };
}

export function serializeTodo(todo: TodoRecord): string {
  const frontMatter = JSON.stringify(
    {
      id: todo.id,
      title: todo.title,
      tags: todo.tags ?? [],
      status: todo.status,
      created_at: todo.created_at,
      assigned_to_session: todo.assigned_to_session || undefined,
    },
    null,
    2,
  );

  const body = todo.body ?? "";
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  if (!trimmedBody) return `${frontMatter}\n`;
  return `${frontMatter}\n\n${trimmedBody}\n`;
}

async function ensureTodosDir(todosDir: string) {
  await fs.mkdir(todosDir, { recursive: true });
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
  return parseTodoContent(await fs.readFile(filePath, "utf8"), idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord) {
  await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function generateTodoId(todosDir: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!existsSync(getTodoPath(todosDir, id))) return id;
  }
  throw new Error("Failed to generate unique todo id");
}

// Sem prompt de "roubar lock?": em daemon o dono do lock some sem limpar, e
// esperar resposta humana trava a sessão. Lock vivo (< TTL) recusa; lock velho
// é lixo e vai embora.
async function acquireLock(todosDir: string, id: string): Promise<(() => Promise<void>) | { error: string }> {
  const lockPath = getLockPath(todosDir, id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const info: LockInfo = { id, pid: process.pid, created_at: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
      await handle.close();
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignora
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        return { error: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
      }
      const stats = await fs.stat(lockPath).catch(() => null);
      const lockAge = stats ? Date.now() - stats.mtimeMs : LOCK_TTL_MS + 1;
      if (lockAge <= LOCK_TTL_MS) {
        return { error: `Todo ${displayTodoId(id)} is locked. Try again later.` };
      }
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }

  return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

async function withTodoLock<T>(
  todosDir: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  const lock = await acquireLock(todosDir, id);
  if (typeof lock === "object" && "error" in lock) return lock;
  try {
    return await fn();
  } finally {
    await lock();
  }
}

async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(todosDir);
  } catch {
    return [];
  }

  const todos: TodoFrontMatter[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    try {
      const content = await fs.readFile(path.join(todosDir, entry), "utf8");
      const { frontMatter } = splitFrontMatter(content);
      const parsed = parseFrontMatter(frontMatter, id);
      todos.push({
        id,
        title: parsed.title,
        tags: parsed.tags ?? [],
        status: parsed.status,
        created_at: parsed.created_at,
        assigned_to_session: parsed.assigned_to_session,
      });
    } catch {
      // todo ilegível: ignora
    }
  }

  return sortTodos(todos);
}

function formatAssignmentSuffix(todo: TodoFrontMatter): string {
  return todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : "";
}

function formatTodoHeading(todo: TodoFrontMatter): string {
  const tagText = todo.tags.length ? ` [${todo.tags.join(", ")}]` : "";
  return `${formatTodoId(todo.id)} ${getTodoTitle(todo)}${tagText}${formatAssignmentSuffix(todo)}`;
}

function splitTodosByAssignment(todos: TodoFrontMatter[]): {
  assignedTodos: TodoFrontMatter[];
  openTodos: TodoFrontMatter[];
  closedTodos: TodoFrontMatter[];
} {
  const assignedTodos: TodoFrontMatter[] = [];
  const openTodos: TodoFrontMatter[] = [];
  const closedTodos: TodoFrontMatter[] = [];
  for (const todo of todos) {
    if (isTodoClosed(getTodoStatus(todo))) {
      closedTodos.push(todo);
      continue;
    }
    if (todo.assigned_to_session) {
      assignedTodos.push(todo);
    } else {
      openTodos.push(todo);
    }
  }
  return { assignedTodos, openTodos, closedTodos };
}

function serializeTodoForAgent(todo: TodoRecord): string {
  return JSON.stringify({ ...todo, id: formatTodoId(todo.id) }, null, 2);
}

function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
  const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
  const mapTodo = (todo: TodoFrontMatter) => ({ ...todo, id: formatTodoId(todo.id) });
  return JSON.stringify(
    {
      assigned: assignedTodos.map(mapTodo),
      open: openTodos.map(mapTodo),
      closed: closedTodos.map(mapTodo),
    },
    null,
    2,
  );
}

async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
  if (!existsSync(filePath)) return null;
  return readTodoFile(filePath, id);
}

async function appendTodoBody(filePath: string, todo: TodoRecord, text: string): Promise<TodoRecord> {
  const spacer = todo.body.trim().length ? "\n\n" : "";
  todo.body = `${todo.body.replace(/\s+$/, "")}${spacer}${text.trim()}\n`;
  await writeTodoFile(filePath, todo);
  return todo;
}

async function updateTodoStatus(
  todosDir: string,
  id: string,
  status: string,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return { error: validated.error };
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);
  if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };

  const result = await withTodoLock(todosDir, normalizedId, async () => {
    const existing = await ensureTodoExists(filePath, normalizedId);
    if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
    existing.status = status;
    clearAssignmentIfClosed(existing);
    await writeTodoFile(filePath, existing);
    return existing;
  });

  if (typeof result === "object" && "error" in result) return { error: result.error };
  return result;
}

async function claimTodoAssignment(
  todosDir: string,
  id: string,
  ctx: ExtensionContext,
  force = false,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return { error: validated.error };
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);
  if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };
  const sessionId = ctx.sessionManager.getSessionId();

  const result = await withTodoLock(todosDir, normalizedId, async () => {
    const existing = await ensureTodoExists(filePath, normalizedId);
    if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
    if (isTodoClosed(existing.status)) {
      return { error: `Todo ${displayTodoId(id)} is closed` } as const;
    }
    const assigned = existing.assigned_to_session;
    if (assigned && assigned !== sessionId && !force) {
      return {
        error: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
      } as const;
    }
    if (assigned !== sessionId) {
      existing.assigned_to_session = sessionId;
      await writeTodoFile(filePath, existing);
    }
    return existing;
  });

  if (typeof result === "object" && "error" in result) return { error: result.error };
  return result;
}

async function releaseTodoAssignment(
  todosDir: string,
  id: string,
  ctx: ExtensionContext,
  force = false,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return { error: validated.error };
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);
  if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };
  const sessionId = ctx.sessionManager.getSessionId();

  const result = await withTodoLock(todosDir, normalizedId, async () => {
    const existing = await ensureTodoExists(filePath, normalizedId);
    if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
    const assigned = existing.assigned_to_session;
    if (!assigned) return existing;
    if (assigned !== sessionId && !force) {
      return {
        error: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
      } as const;
    }
    existing.assigned_to_session = undefined;
    await writeTodoFile(filePath, existing);
    return existing;
  });

  if (typeof result === "object" && "error" in result) return { error: result.error };
  return result;
}

async function deleteTodo(todosDir: string, id: string): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return { error: validated.error };
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);
  if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };

  const result = await withTodoLock(todosDir, normalizedId, async () => {
    const existing = await ensureTodoExists(filePath, normalizedId);
    if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
    await fs.unlink(filePath);
    return existing;
  });

  if (typeof result === "object" && "error" in result) return { error: result.error };
  return result;
}

function todoSelectLabel(todo: TodoFrontMatter, currentSessionId?: string): string {
  const assigned = todo.assigned_to_session;
  const state = assigned
    ? `${getTodoStatus(todo)} · ${assigned === currentSessionId ? "esta sessão" : assigned}`
    : getTodoStatus(todo);
  return `${BOLD(formatTodoId(todo.id))} ${getTodoTitle(todo)} ${FAINT(`(${state})`)}`;
}

/** Persistent project tasks; plan.ts registers it as the deferred `todo` tool. */
export function createTaskTool(): ToolDefinition<typeof TodoParams> {
  const todosDirLabel = getTodosDirLabel(process.cwd());
  return {
    name: "todo",
    label: "Todo",
    description:
      `Project-scoped agent work items in ${todosDirLabel} (list, list-all, get, create, update, append, delete, claim, release). ` +
      "Use only for project work, not personal tasks. " +
      "Title is the short summary; body is long-form markdown notes (update replaces, append adds). " +
      "Todo ids are shown as TODO-<hex>; id parameters accept TODO-<hex> or the raw hex filename. " +
      "Claim tasks before working on them to avoid conflicts with other pi sessions, and close them when complete.",
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const todosDir = getTodosDir(ctx.cwd);
      const action: TodoAction = params.action;
      const fail = (error: string): { content: [{ type: "text"; text: string }]; details: TodoToolDetails; isError: boolean } => ({
        content: [{ type: "text", text: error }],
        details: { action, error } as TodoToolDetails,
        isError: true,
      });

      switch (action) {
        case "list": {
          const todos = await listTodos(todosDir);
          const { assignedTodos, openTodos } = splitTodosByAssignment(todos);
          const listedTodos = [...assignedTodos, ...openTodos];
          const currentSessionId = ctx.sessionManager.getSessionId();
          return {
            content: [{ type: "text", text: serializeTodoListForAgent(listedTodos) }],
            details: { action: "list", todos: listedTodos, currentSessionId } as TodoToolDetails,
          };
        }

        case "list-all": {
          const todos = await listTodos(todosDir);
          const currentSessionId = ctx.sessionManager.getSessionId();
          return {
            content: [{ type: "text", text: serializeTodoListForAgent(todos) }],
            details: { action: "list-all", todos, currentSessionId } as TodoToolDetails,
          };
        }

        case "get": {
          if (!params.id) return fail("Error: id required");
          const validated = validateTodoId(params.id);
          if ("error" in validated) return fail(validated.error);
          const normalizedId = validated.id;
          const todo = await ensureTodoExists(getTodoPath(todosDir, normalizedId), normalizedId);
          if (!todo) return fail(`Todo ${formatTodoId(normalizedId)} not found`);
          return {
            content: [{ type: "text", text: serializeTodoForAgent(todo) }],
            details: { action: "get", todo } as TodoToolDetails,
          };
        }

        case "create": {
          if (!params.title) return fail("Error: title required");
          await ensureTodosDir(todosDir);
          const id = await generateTodoId(todosDir);
          const filePath = getTodoPath(todosDir, id);
          const todo: TodoRecord = {
            id,
            title: params.title,
            tags: params.tags ?? [],
            status: params.status ?? "open",
            created_at: new Date().toISOString(),
            body: params.body ?? "",
          };

          const result = await withTodoLock(todosDir, id, async () => {
            await writeTodoFile(filePath, todo);
            return todo;
          });
          if (typeof result === "object" && "error" in result) return fail(result.error);

          return {
            content: [{ type: "text", text: serializeTodoForAgent(todo) }],
            details: { action: "create", todo } as TodoToolDetails,
          };
        }

        case "update": {
          if (!params.id) return fail("Error: id required");
          const validated = validateTodoId(params.id);
          if ("error" in validated) return fail(validated.error);
          const normalizedId = validated.id;
          const displayId = formatTodoId(normalizedId);
          const filePath = getTodoPath(todosDir, normalizedId);
          if (!existsSync(filePath)) return fail(`Todo ${displayId} not found`);

          const result = await withTodoLock(todosDir, normalizedId, async () => {
            const existing = await ensureTodoExists(filePath, normalizedId);
            if (!existing) return { error: `Todo ${displayId} not found` } as const;

            existing.id = normalizedId;
            if (params.title !== undefined) existing.title = params.title;
            if (params.status !== undefined) existing.status = params.status;
            if (params.tags !== undefined) existing.tags = params.tags;
            if (params.body !== undefined) existing.body = params.body;
            if (!existing.created_at) existing.created_at = new Date().toISOString();
            clearAssignmentIfClosed(existing);

            await writeTodoFile(filePath, existing);
            return existing;
          });
          if (typeof result === "object" && "error" in result) return fail(result.error);

          const todo = result as TodoRecord;
          return {
            content: [{ type: "text", text: serializeTodoForAgent(todo) }],
            details: { action: "update", todo } as TodoToolDetails,
          };
        }

        case "append": {
          if (!params.id) return fail("Error: id required");
          const validated = validateTodoId(params.id);
          if ("error" in validated) return fail(validated.error);
          const normalizedId = validated.id;
          const displayId = formatTodoId(normalizedId);
          const filePath = getTodoPath(todosDir, normalizedId);
          if (!existsSync(filePath)) return fail(`Todo ${displayId} not found`);

          const result = await withTodoLock(todosDir, normalizedId, async () => {
            const existing = await ensureTodoExists(filePath, normalizedId);
            if (!existing) return { error: `Todo ${displayId} not found` } as const;
            if (!params.body || !params.body.trim()) return existing;
            return appendTodoBody(filePath, existing, params.body);
          });
          if (typeof result === "object" && "error" in result) return fail(result.error);

          const todo = result as TodoRecord;
          return {
            content: [{ type: "text", text: serializeTodoForAgent(todo) }],
            details: { action: "append", todo } as TodoToolDetails,
          };
        }

        case "claim": {
          if (!params.id) return fail("Error: id required");
          const result = await claimTodoAssignment(todosDir, params.id, ctx, Boolean(params.force));
          if ("error" in result) return fail(result.error);
          return {
            content: [{ type: "text", text: serializeTodoForAgent(result) }],
            details: { action: "claim", todo: result } as TodoToolDetails,
          };
        }

        case "release": {
          if (!params.id) return fail("Error: id required");
          const result = await releaseTodoAssignment(todosDir, params.id, ctx, Boolean(params.force));
          if ("error" in result) return fail(result.error);
          return {
            content: [{ type: "text", text: serializeTodoForAgent(result) }],
            details: { action: "release", todo: result } as TodoToolDetails,
          };
        }

        case "delete": {
          if (!params.id) return fail("Error: id required");
          const validated = validateTodoId(params.id);
          if ("error" in validated) return fail(validated.error);
          const result = await deleteTodo(todosDir, validated.id);
          if ("error" in result) return fail(result.error);
          return {
            content: [{ type: "text", text: serializeTodoForAgent(result) }],
            details: { action: "delete", todo: result } as TodoToolDetails,
          };
        }
      }
    },

  };
}

export default function todosExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const todosDir = getTodosDir(ctx.cwd);
    if (!existsSync(todosDir)) return;
    await garbageCollectTodos(todosDir, await readTodoSettings(todosDir));
  });

  pi.registerCommand("todos", {
    description: "Todos de trabalho do projeto (.pi/todos)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const todosDir = getTodosDir(ctx.cwd);
      const all = await listTodos(todosDir);
      const currentSessionId = ctx.sessionManager.getSessionId();
      const search = (args ?? "").trim();
      const todos = search ? filterTodos(all, search) : all;

      if (!todos.length) {
        ctx.ui.notify(search ? `Nenhum todo casa com "${search}"` : "Nenhum todo.", "info");
        return;
      }

      const labels = todos.map((todo) => todoSelectLabel(todo, currentSessionId));
      const picked = await ctx.ui.select(`Todos · ${getTodosDirLabel(ctx.cwd)}`, labels);
      if (!picked) return;
      const todo = todos[labels.indexOf(picked)];
      if (!todo) return;

      const record = await ensureTodoExists(getTodoPath(todosDir, todo.id), todo.id);
      if (!record) {
        ctx.ui.notify(`Todo ${formatTodoId(todo.id)} não encontrado`, "error");
        return;
      }

      const closed = isTodoClosed(getTodoStatus(record));
      const VER = "Ver";
      const FECHAR = closed ? "Reabrir" : "Fechar";
      const ASSIGN = record.assigned_to_session ? "Release" : "Claim";
      const APAGAR = "Apagar";
      const actions = [VER, FECHAR, ASSIGN, APAGAR];
      const action = await ctx.ui.select(formatTodoHeading(record), actions);
      if (!action) return;

      if (action === VER) {
        pi.sendMessage(
          {
            customType: "todo-detail",
            content: `${formatTodoId(record.id)} ${getTodoTitle(record)}\n\n${record.body.trim()}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      if (action === FECHAR) {
        const result = await updateTodoStatus(todosDir, record.id, closed ? "open" : "closed");
        ctx.ui.notify(
          "error" in result ? result.error : `${closed ? "Reaberto" : "Fechado"} ${formatTodoId(record.id)}`,
          "error" in result ? "error" : "info",
        );
        return;
      }

      if (action === ASSIGN) {
        const result = record.assigned_to_session
          ? await releaseTodoAssignment(todosDir, record.id, ctx, true)
          : await claimTodoAssignment(todosDir, record.id, ctx, true);
        ctx.ui.notify(
          "error" in result
            ? result.error
            : `${record.assigned_to_session ? "Liberado" : "Reservado"} ${formatTodoId(record.id)}`,
          "error" in result ? "error" : "info",
        );
        return;
      }

      const ok = await ctx.ui.confirm(
        "Apagar todo",
        `Apagar ${formatTodoId(record.id)} "${getTodoTitle(record)}"? Não dá para desfazer.`,
      );
      if (!ok) return;
      const result = await deleteTodo(todosDir, record.id);
      ctx.ui.notify(
        "error" in result ? result.error : `Apagado ${formatTodoId(record.id)}`,
        "error" in result ? "error" : "info",
      );
    },
  });
}
