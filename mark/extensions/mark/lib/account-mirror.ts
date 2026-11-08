// account-mirror: espelha a credencial ativa do pi nas fontes "do sistema" que o CodexBar
// (e os CLIs oficiais) leem:
//   openai-codex → ~/.codex/auth.json          (formato do Codex CLI; exige id_token)
//   anthropic    → Keychain "Claude Code-credentials" (formato do Claude Code: claudeAiOauth)
//
// Pi, Codex CLI e Claude Code usam os mesmos OAuth clients, entao os tokens sao
// intercambiaveis. O pi nao guarda id_token; obtemos por refresh em auth.openai.com e
// cacheamos por conta em ~/.pi/agent/accounts-mirror.json (o refresh rotaciona o refresh
// token e devolve `earliest_refresh_at` — advisory, mas nao vale abusar).
//
// `pull*` fazem o caminho inverso: se o CLI renovou o token (expira depois) e e a mesma
// identidade, adotamos no pi. Sem isso, com refresh token compartilhado e rotacionado, o
// lado que renovar por ultimo mata o outro.
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readJson, writeJson } from "./json-file.ts";

export type Credential = Record<string, unknown> & {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
};


const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_DEFAULT_SCOPES = ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"];
// Tudo o mais no blob (emailAddress, organizationUuid, accountUuid…) identifica a conta.
const CLAUDE_CARRIED_KEYS = ["scopes", "subscriptionType", "rateLimitTier"];
const KEYCHAIN_TIMEOUT_MS = 15_000;
const KEYCHAIN_NOT_FOUND_EXIT = 44;
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface SecurityResult {
  code: number;
  stdout: string;
}

/** Claude Code 2.1+ rejeita $USER fora de [a-zA-Z0-9._-] e guarda o item em claude-code-user (#12857). */
export function claudeKeychainAccount(): string {
  const user = process.env.USER || process.env.USERNAME || "";
  return KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : "claude-code-user";
}

/** Claude Code 2.1+ escopa o item por config dir: sha256(NFC(dir)) truncado em 8 hex. */
export function claudeKeychainServices(configDir: string | undefined): string[] {
  if (!configDir) return [CLAUDE_KEYCHAIN_SERVICE];
  const aliases = [configDir];
  try {
    // macOS resolve /var → /private/var; o Claude hasheia o realpath.
    const canonical = realpathSync(configDir);
    if (canonical !== configDir) aliases.push(canonical);
  } catch {
    /* dir inexistente: so o caminho literal */
  }
  const scoped = aliases.map((dir) => `${CLAUDE_KEYCHAIN_SERVICE}-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`);
  return [...new Set([...scoped, CLAUDE_KEYCHAIN_SERVICE])];
}

interface MirrorState {
  version: 1;
  codexIdTokens: Record<string, string>; // "<provider>/<nome>" → id_token
}

export function decodeJwt(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwtExpMs(token: string | undefined): number | undefined {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

export function codexEmail(cred: Credential): string | undefined {
  const profile = decodeJwt(cred.access)?.["https://api.openai.com/profile"] as { email?: string } | undefined;
  return profile?.email;
}

export interface MirrorOptions {
  home?: string;
  platform?: NodeJS.Platform;
  security?: (args: string[]) => SecurityResult;
  fetch?: typeof fetch;
}

export function createAccountMirror(options: MirrorOptions = {}) {
const home = options.home ?? homedir();
const platform = options.platform ?? process.platform;
const CODEX_AUTH_PATH = join(home, ".codex", "auth.json");
// O Claude Code honra CLAUDE_CONFIG_DIR tanto no arquivo quanto no escopo do Keychain.
const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || undefined;
const claudeConfigDir = inheritedConfigDir ?? join(home, ".claude");
const claudePath = join(claudeConfigDir, ".credentials.json");
const security = options.security ?? ((args: string[]): SecurityResult => {
  const result = spawnSync("security", args, { encoding: "utf-8", timeout: KEYCHAIN_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.signal) throw result.error ?? new Error("security interrompido");
  return { code: result.status ?? 1, stdout: result.stdout ?? "" };
});
// ---------- Codex ----------

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
}

async function refreshCodex(refreshToken: string): Promise<{ access: string; refresh: string; expires: number; idToken: string }> {
  const response = await (options.fetch ?? fetch)(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`refresh Codex falhou (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const json = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || !json.id_token || typeof json.expires_in !== "number") {
    throw new Error("refresh Codex sem campos esperados");
  }
  return { access: json.access_token, refresh: json.refresh_token, idToken: json.id_token, expires: Date.now() + json.expires_in * 1000 };
}

/**
 * Grava a credencial em ~/.codex/auth.json. Pode devolver uma credencial atualizada
 * (quando precisou refrescar pra obter id_token) — o chamador deve persisti-la no pi.
 */
async function pushCodex(key: string, cred: Credential, statePath: string): Promise<{ cred: Credential; refreshed: boolean; error?: string }> {
  if (!cred.access || !cred.refresh || !cred.accountId) throw new Error("credencial openai-codex incompleta");
  const state = readJson<MirrorState>(statePath, { version: 1, codexIdTokens: {} });
  let idToken = state.codexIdTokens[key];
  let next = cred;
  let refreshed = false;
  let error: string | undefined;
  const idExp = jwtExpMs(idToken);
  if (!idToken || (idExp !== undefined && idExp < Date.now() + 60_000)) {
    const fresh = await refreshCodex(cred.refresh);
    idToken = fresh.idToken;
    // Daqui pra frente o refresh token antigo ja morreu: reporta falha, nunca lanca.
    next = { ...cred, access: fresh.access, refresh: fresh.refresh, expires: fresh.expires };
    refreshed = true;
    state.codexIdTokens[key] = idToken;
    try {
      writeJson(statePath, state);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  let current: CodexAuthFile = {};
  try {
    current = readJson<CodexAuthFile>(CODEX_AUTH_PATH, {});
  } catch {
    /* auth.json do Codex corrompido: reescreve em vez de honrar */
  }
  const out: CodexAuthFile = {
    ...current,
    auth_mode: current.auth_mode ?? "chatgpt",
    OPENAI_API_KEY: current.OPENAI_API_KEY ?? null,
    tokens: { id_token: idToken, access_token: next.access as string, refresh_token: next.refresh as string, account_id: next.accountId as string },
    last_refresh: new Date().toISOString(),
  };
  try {
    writeJson(CODEX_AUTH_PATH, out);
  } catch (e) {
    if (!refreshed) throw e;
    error = e instanceof Error ? e.message : String(e);
  }
  return { cred: next, refreshed, ...(error ? { error } : {}) };
}

/** Se o Codex CLI renovou o token da MESMA conta e ele vence depois do nosso, adota. */
function pullCodex(key: string, cred: Credential, statePath: string): Credential | undefined {
  let file: CodexAuthFile = {};
  try {
    file = readJson<CodexAuthFile>(CODEX_AUTH_PATH, {});
  } catch {
    return undefined;
  }
  const t = file.tokens;
  if (!t?.access_token || !t.refresh_token || !t.account_id) return undefined;
  if (t.account_id !== cred.accountId) return undefined;
  if (t.access_token === cred.access) return undefined;
  const theirExp = jwtExpMs(t.access_token);
  const ourExp = jwtExpMs(cred.access) ?? cred.expires ?? 0;
  if (theirExp === undefined || theirExp <= ourExp) return undefined;
  if (t.id_token) {
    const state = readJson<MirrorState>(statePath, { version: 1, codexIdTokens: {} });
    state.codexIdTokens[key] = t.id_token;
    writeJson(statePath, state);
  }
  return { ...cred, access: t.access_token, refresh: t.refresh_token, expires: theirExp };
}

// ---------- Claude ----------

interface ClaudeKeychain {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Item ausente (exit 44) e blob vazio; qualquer outra falha nao pode sobrescrever o item. */
function readClaudeKeychain(): ClaudeKeychain {
  if (platform !== "darwin") {
    try {
      return readJson<ClaudeKeychain>(claudePath, {});
    } catch {
      return {};
    }
  }
  const account = claudeKeychainAccount();
  for (const service of claudeKeychainServices(inheritedConfigDir)) {
    const result = security(["find-generic-password", "-s", service, "-a", account, "-w"]);
    if (result.code === KEYCHAIN_NOT_FOUND_EXIT) continue;
    if (result.code !== 0) throw new Error("leitura do Keychain do Claude falhou");
    try {
      return JSON.parse(result.stdout.trim()) as ClaudeKeychain;
    } catch {
      return {};
    }
  }
  return {};
}

function pushClaude(cred: Credential): void {
  if (!cred.access || !cred.refresh || typeof cred.expires !== "number") throw new Error("credencial anthropic incompleta");
  const current = readClaudeKeychain();
  const prev = current.claudeAiOauth ?? {};
  // Chaves de identidade pertencem a quem as escreveu; so viajam quando e a mesma conta.
  const sameAccount = prev.refreshToken === cred.refresh || prev.accessToken === cred.access;
  const carried = sameAccount ? prev : Object.fromEntries(CLAUDE_CARRIED_KEYS.filter((k) => k in prev).map((k) => [k, prev[k]]));
  const out: ClaudeKeychain = {
    ...current,
    claudeAiOauth: {
      ...carried,
      accessToken: cred.access,
      refreshToken: cred.refresh,
      expiresAt: cred.expires,
      scopes: carried.scopes ?? CLAUDE_DEFAULT_SCOPES,
      subscriptionType: carried.subscriptionType ?? "max",
    },
  };
  if (platform !== "darwin") {
    writeJson(claudePath, out);
    return;
  }
  const account = claudeKeychainAccount();
  const contents = JSON.stringify(out);
  for (const service of claudeKeychainServices(inheritedConfigDir)) {
    const result = security(["add-generic-password", "-U", "-a", account, "-s", service, "-w", contents]);
    if (result.code !== 0) throw new Error("gravacao no Keychain do Claude falhou");
  }
}

/** Se o Claude Code renovou (expira depois e refresh diferente), adota. Sem identidade no token: assume a mesma conta. */
function pullClaude(cred: Credential): Credential | undefined {
  let o: ClaudeKeychain["claudeAiOauth"];
  try {
    o = readClaudeKeychain().claudeAiOauth;
  } catch {
    return undefined;
  }
  if (!o?.accessToken || !o.refreshToken || typeof o.expiresAt !== "number") return undefined;
  if (o.accessToken === cred.access) return undefined;
  if (o.expiresAt <= (cred.expires ?? 0)) return undefined;
  return { ...cred, access: o.accessToken, refresh: o.refreshToken, expires: o.expiresAt };
}

// ---------- dispatcher ----------



/** `cred` e sempre o que o chamador tem de persistir, mesmo com `error` preenchido (refresh rotacionado). */
async function push(provider: string, key: string, cred: Credential, statePath: string): Promise<{ cred: Credential; note: string; error?: string } | undefined> {
  if (provider === "openai-codex") {
    const r = await pushCodex(key, cred, statePath);
    return { cred: r.cred, note: `~/.codex/auth.json${r.refreshed ? " (token renovado p/ id_token)" : ""}`, ...(r.error ? { error: r.error } : {}) };
  }
  if (provider === "anthropic") {
    pushClaude(cred);
    return { cred, note: platform === "darwin" ? "Keychain Claude Code" : "~/.claude/.credentials.json" };
  }
  return undefined;
}

function pull(provider: string, key: string, cred: Credential, statePath: string): Credential | undefined {
  if (provider === "openai-codex") return pullCodex(key, cred, statePath);
  if (provider === "anthropic") return pullClaude(cred);
  return undefined;
}

return { push, pull, pushClaude, pullClaude, pushCodex, pullCodex };
}

export const MIRRORED_PROVIDERS = ["openai-codex", "anthropic"] as const;
export const { push, pull } = createAccountMirror();
