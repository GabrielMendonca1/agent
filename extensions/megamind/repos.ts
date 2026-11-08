// Leitura local de git para o ARCA Megamind: chave canônica do repo do cwd,
// branch atual e caminhos tocados. Módulo puro: só git de leitura, sem rede,
// sem ExtensionAPI. Nunca roda fetch/pull — apenas lê o que já está no disco.
// Windows: o git vem do PATH (execFile, sem shell) e os caminhos são normalizados.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { LIMITS } from "./contract.ts";

// `host/owner/name`: exatamente dois segmentos de path depois do host.
const REPO_KEY = /^[a-z0-9.-]+(\/[a-z0-9._-]+){2}$/u;
// Um `.git` plantado (tarball em ~/Downloads) não pode executar código nosso:
// sem hooks, sem fsmonitor, sem config de sistema, sem lock opcional.
const GIT_HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } as const;
const GIT_TIMEOUT_MS = 3_000;

/** `host/owner/name`, minúsculo, sem `.git`, protocolo, usuário ou porta. */
export function normalizeRepoKey(remoteUrl: string): string | null {
  const raw = remoteUrl.trim();
  if (!raw || raw.length > 400) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^@/:\s]+):(?!\/)(.+)$/u.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol === "file:") return null;
    host = url.hostname;
    path = url.pathname;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  // `ssh://git@github.com:22/x/y` — a porta pode sobrar no início do path.
  path = path.replace(/^\/+/u, "").replace(/\/+$/u, "").replace(/\.git$/iu, "");
  const key = `${host}/${path}`.toLowerCase();
  if (key.length > 200 || !REPO_KEY.test(key)) return null;
  return key;
}

/** Valida um `repo_key` que já vem normalizado (catálogo do Mainframe). */
export function asRepoKey(value: string): string | null {
  const key = value.trim().replace(/\/+$/u, "").replace(/\.git$/iu, "").toLowerCase();
  if (!key || key.length > 200 || !REPO_KEY.test(key)) return null;
  return key;
}

/** Argumentos reais passados ao git: hardening sempre antes do subcomando. */
export function gitArgs(args: readonly string[]): string[] {
  return [...GIT_HARDENING, ...args];
}

/** `signal` do chamador: o deadline da rodada corta o git em curso. */
export type GitOptions = { signal?: AbortSignal };

function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      gitArgs(args),
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, ...GIT_ENV },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => done(error ? null : String(stdout)),
    );
  });
}

/** Raiz do clone que contém `path` (subdiretório conta), ou null. */
export async function repoRoot(path: string, options: GitOptions = {}): Promise<string | null> {
  const out = await git(path, ["rev-parse", "--show-toplevel"], options);
  const top = out?.trim().split(/\r?\n/u)[0];
  // O git devolve `C:/x` no Windows: sem normalizar, o caminho não bate com o
  // que o resto do processo enxerga.
  return top ? resolve(top) : null;
}

/** `repo_key` do clone, lendo só o remote `origin`. Null quando não é reportável. */
export async function repoKeyOf(path: string, options: GitOptions = {}): Promise<string | null> {
  const remote = await git(path, ["remote", "get-url", "origin"], options);
  if (remote === null) return null;
  return normalizeRepoKey(remote.trim().split(/\r?\n/u)[0] ?? "");
}

/** Branch do HEAD (`HEAD` em detached). Null quando o git falha. */
export async function currentBranch(path: string, options: GitOptions = {}): Promise<string | null> {
  const out = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  const branch = out?.trim().split(/\r?\n/u)[0]?.trim();
  return branch ? branch.slice(0, LIMITS.branchChars) : null;
}

/** Desfaz o quoting do git (`core.quotePath`): escapes C e octais por byte. */
export function unquoteGitPath(value: string): string {
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]!;
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte);
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) break;
    const octal = /^[0-7]{3}/u.exec(value.slice(index + 1, index + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      index += 3;
      continue;
    }
    bytes.push(simple[next] ?? Buffer.from(next, "utf8")[0]!);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Caminhos do `git status --porcelain`: só os caminhos, sem os códigos de
 * status, sem conteúdo. É o que a presença publica como "onde estou mexendo".
 */
/** Diretórios de estado de agente que não contam como sobreposição quando não rastreados. */
const AGENT_STATE = /^(\.pi|\.claude|\.codex|\.agents|\.herdr|\.cursor)\//u;

export function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    // `XY path` / `XY orig -> path` (rename/copy). Porcelain v1 usa 2 colunas + espaço.
    let rest = line.length > 3 && line[2] === " " ? line.slice(3) : line.replace(/^\s*\S+\s+/u, "");
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    // Caminho com char especial vem entre aspas e com escapes do git.
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
      // Escapes do git são por byte (`\\303\\251` = é): desfazer char a char daria `303251`.
      rest = unquoteGitPath(rest.slice(1, -1));
    }
    const path = rest.trim().replace(/\\/gu, "/").slice(0, LIMITS.pathChars);
    if (!path || paths.includes(path)) continue;
    // Estado local do agente (checkpoints, todos, sessões) não é trabalho no código:
    // dois agentes no mesmo repo sempre "tocam" esses diretórios.
    if (line.startsWith("??") && AGENT_STATE.test(path)) continue;
    paths.push(path);
    if (paths.length >= LIMITS.paths) break;
  }
  return paths;
}

/** Caminhos tocados no clone (≤100). Lista vazia quando o git falha. */
export async function changedPaths(path: string, options: GitOptions = {}): Promise<string[]> {
  // `GIT_OPTIONAL_LOCKS=0` (GIT_ENV) já cobre o `--no-optional-locks`.
  const out = await git(path, ["status", "--porcelain"], options);
  return out === null ? [] : parsePorcelainPaths(out);
}
