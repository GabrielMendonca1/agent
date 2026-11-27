// Catálogo canônico de repositórios: `projects_list` paginado vira o mapa
// repo_key -> project_id. Fora dele, a presença usa a identidade do repositório.
// Módulo puro — nenhuma dependência de `pi`.
import { basename } from "node:path";
import { FIELD, TOOL } from "./contract.ts";
import { callGateway, checkedToolCall, object, resultRecord, text } from "./gateway.ts";
import { megamindName } from "./profile.ts";
import { asRepoKey, normalizeRepoKey } from "./repos.ts";

const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export type Catalog = {
  /** `repo_key` -> `project_id`. */
  byRepo: Map<string, string>;
  /** Ids de projeto na ordem do catálogo: base do `megamind_who` sem argumento. */
  projectIds: string[];
};

function pageItems(record: Record<string, unknown> | undefined): unknown[] {
  if (!record) throw new Error(`${megamindName()} malformed catalog`);
  const items = record[FIELD.items];
  if (!Array.isArray(items)) throw new Error(`${megamindName()} malformed catalog: missing items`);
  return items;
}

function nextCursor(record: Record<string, unknown> | undefined): string | undefined {
  const raw = record ? text(record[FIELD.nextCursor]) : undefined;
  return raw && raw.trim() ? raw.trim() : undefined;
}

async function* catalogItems(signal?: AbortSignal) {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const record = resultRecord(await checkedToolCall(TOOL.projects, { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, signal));
    for (const item of pageItems(record)) {
      if (!object(item)) throw new Error(`${megamindName()} malformed catalog item`);
      const id = text(item.id);
      if (!id) throw new Error(`${megamindName()} malformed catalog project id`);
      if (item.repos !== undefined && !Array.isArray(item.repos)) throw new Error(`${megamindName()} malformed catalog repos`);
      yield { id, title: text(item.title), status: text(item.status), repos: Array.isArray(item.repos) ? item.repos : [] };
    }
    cursor = nextCursor(record);
    if (!cursor) return;
    if (seenCursors.has(cursor)) throw new Error(`${megamindName()} catalog cursor loop`);
    seenCursors.add(cursor);
  }
  throw new Error(`${megamindName()} catalog page limit exceeded`);
}

/** `projects_list` é legada e não tem flag própria em initialize. */
export async function listProjects(signal?: AbortSignal) {
  const listing = await callGateway("tools/list", {}, signal);
  if (!object(listing) || !Array.isArray(listing.tools) || !listing.tools.some((tool) => object(tool) && tool.name === TOOL.projects)) {
    throw new Error(`${megamindName()} server does not advertise ${TOOL.projects}`);
  }
  const projects = [];
  for await (const { id, title, status, repos } of catalogItems(signal)) {
    projects.push({ id, title, status, repos: repos.map(text).filter((repo): repo is string => repo !== undefined) });
  }
  return projects;
}

/** Lê o catálogo inteiro para vincular o repositório à presença. */
export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
  const byRepo = new Map<string, string>();
  const projectIds: string[] = [];
  for await (const { id, repos } of catalogItems(signal)) {
    if (!projectIds.includes(id)) projectIds.push(id);
    for (const entry of repos) {
      const raw = text(entry);
      const key = raw ? asRepoKey(raw) ?? normalizeRepoKey(raw) : null;
      if (!key) throw new Error(`${megamindName()} malformed catalog repo key`);
      if (byRepo.has(key) && byRepo.get(key) !== id) throw new Error(`${megamindName()} ambiguous catalog repo association`);
      byRepo.set(key, id);
    }
  }
  return { byRepo, projectIds };
}

/** Mesma chave válida usada pelo app; sem remoto, resta o nome da pasta. */
export function sanitizeMegamindProjectId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/gu, "-").replace(/^[^A-Za-z0-9]+/u, "").slice(0, 64) || "project";
}

export function resolveProjectId(root: string, repoKey: string | null, catalog?: Catalog): string {
  return (repoKey ? catalog?.byRepo.get(repoKey) : undefined)
    ?? sanitizeMegamindProjectId(repoKey ?? basename(root));
}
