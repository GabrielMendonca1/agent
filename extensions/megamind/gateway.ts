// Transporte da extensão arca-megamind: config do enrollment, credencial e a chamada
// JSON-RPC ao gateway MCP. Módulo puro — nenhuma dependência de `pi`.
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { eventsUrl, FIELD } from "./contract.ts";
import { defaultConfigPath, megamindName, megamindProfile } from "./profile.ts";

const PROTOCOL = "2025-03-26";
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE = 4 * 1024 * 1024;
/** Marcador interno que leva o erro MCP do execute até o hook tool_result. */
export const ERROR_DETAIL = "__arca_megamind_mcp_error";

export type JsonObject = Record<string, unknown>;
export type ToolContent = { type: string } & JsonObject;
export type ToolOutput = { content: ToolContent[]; details: JsonObject };

export function object(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `{campo: valor}` quando o campo veio como string; `{}` quando faltou. */
export function optional<K extends string>(source: JsonObject, field: K): { [P in K]?: string } {
  const value = text(source[field]);
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a chave é `field`, com string ou ausente, que é exatamente o tipo declarado.
  return (value === undefined ? {} : { [field]: value }) as { [P in K]?: string };
}

// Caminho da config do enrollment (diretório interno do contrato de enrollment);
// ARCA_MEGAMIND_CONFIG aponta outro perfil (Omni, próprio) ou existe para testes.
export function configPath(): string {
  return megamindProfile().configPath ?? defaultConfigPath();
}

/** Mensagem única do sentinela: a sessão não fala com Megamind nenhum. */
export const MEGAMIND_OFF = "Megamind is off for this project (ARCA_MEGAMIND_CONFIG=none)";

/** `ARCA_MEGAMIND_CONFIG=none`: projeto sem Megamind, nada de rede nesta sessão. */
export function megamindDisabled(): boolean {
  return megamindProfile().id === "none";
}

// Cache local (marcadores, varredura); ARCA_MEGAMIND_CACHE existe para testes.
export function cacheDir(): string {
  return process.env.ARCA_MEGAMIND_CACHE || join(homedir(), ".cache", "arca-projects");
}

export type Metadata = { endpoint: string; tokenFile: string; eventsUrl?: string };

export async function metadata(): Promise<Metadata> {
  if (megamindDisabled()) throw new Error(MEGAMIND_OFF);
  const raw: unknown = JSON.parse(await readFile(configPath(), "utf8"));
  if (!object(raw) || typeof raw.endpoint !== "string" || typeof raw.token_file !== "string") {
    throw new Error(`${megamindName()} config is invalid`);
  }
  return {
    endpoint: raw.endpoint,
    tokenFile: raw.token_file,
    // O enrollment pode declarar a rota SSE; sem isso ela é derivada do endpoint.
    ...(typeof raw.events_url === "string" ? { eventsUrl: raw.events_url } : {}),
  };
}

/** Estado observável do transporte, para diagnóstico (`/megamind`). Sem segredo. */
export const gatewayStatus: { lastOkAt: number; lastErrorAt: number; lastError: string } = {
  lastOkAt: 0,
  lastErrorAt: 0,
  lastError: "",
};

export async function token(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`${megamindName()} credential file must be mode 0600`);
  // No Windows `mode` não reflete permissão real (a ACL do usuário protege
  // %USERPROFILE%\.config\arca-projects, onde a credencial mora):
  // checar bits ali reprovaria toda credencial válida.
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${megamindName()} credential file must be mode 0600`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${megamindName()} credential file is empty`);
  return value;
}

/**
 * Remove controle, separadores de linha/parágrafo e format chars (bidi, zero-width).
 * Mesmo conjunto que o gateway rejeita em `arcaNote`/`arcaLabel`: filtrar aqui
 * evita mandar presença que o servidor recusa.
 */
export function stripControl(value: string): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/gu, "");
}

/** Única redação de credencial da extensão (mensagem de erro e corpo de megamind_send). */
export function redactBearer(value: string): string {
  return value.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

export function safeMessage(error: unknown): string {
  return error instanceof Error ? redactBearer(error.message) : `${megamindName()} request failed`;
}

/** Mesmo crivo de transporte para MCP e SSE: HTTPS (ou localhost explícito), sem credencial na URL. */
export function assertSafeUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.ARCA_ALLOW_INSECURE_LOCALHOST === "1" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new Error(`${megamindName()} gateway must use HTTPS`);
  }
  return url;
}

/** `signal` do chamador cancela junto com o timeout próprio da chamada. */
export async function callGateway(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
  const config = await metadata();
  const bearer = await token(config.tokenFile);
  assertSafeUrl(config.endpoint);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`gateway HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE)) {
      throw new Error("gateway response is too large");
    }
    if (!response.body) throw new Error("gateway returned an empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_RESPONSE) throw new Error("gateway response is too large");
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const rpc: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!object(rpc)) throw new Error("gateway returned invalid JSON");
    // O código entra na mensagem: é por ele (`-32601`/`-32602`) que o cliente
    // reconhece "tool que não existe neste servidor" sem depender do texto.
    if (object(rpc.error)) {
      const message = typeof rpc.error.message === "string" ? rpc.error.message : "gateway RPC error";
      const code = typeof rpc.error.code === "number" && Number.isFinite(rpc.error.code) ? rpc.error.code : undefined;
      throw new Error(code === undefined ? message : `${message} (${code})`);
    }
    gatewayStatus.lastOkAt = Date.now();
    return rpc.result ?? {};
  } catch (error) {
    gatewayStatus.lastErrorAt = Date.now();
    gatewayStatus.lastError = safeMessage(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Atalho de `tools/call`: só o nome e os argumentos mudam entre chamadas. */
export function toolCall(name: string, args: JsonObject, signal?: AbortSignal): Promise<unknown> {
  return callGateway("tools/call", { name, arguments: args }, signal);
}

/** Chamadas internas só avançam estado depois de aceitas pelo MCP. */
export async function checkedToolCall(name: string, args: JsonObject, signal?: AbortSignal): Promise<unknown> {
  const result = await toolCall(name, args, signal);
  const failure = gatewayFailure(result);
  if (failure) {
    const error = new Error(`${megamindName()} ${name} rejected by gateway: ${failure}`);
    gatewayStatus.lastErrorAt = Date.now();
    gatewayStatus.lastError = error.message;
    throw error;
  }
  return result;
}

/**
 * Erro de tool do contrato (§1): resultado MCP com `isError` e
 * `content[0].text` = `{"error":{"code","message"}}`. Devolve o texto do erro
 * (`code: message`) ou `undefined` quando a chamada deu certo — sem isto uma
 * recusa do servidor passaria por sucesso.
 */
export function gatewayFailure(result: unknown): string | undefined {
  const failure = gatewayError(result);
  if (!failure) return undefined;
  return [failure.code, failure.message].filter(Boolean).join(": ") || "gateway rejected the call";
}

/** Erro de tool com o `detail` preservado: a v6 manda ali os candidatos de um endereço ambíguo. */
export type GatewayError = { code?: string; message?: string; detail?: unknown };

export function gatewayError(result: unknown): GatewayError | undefined {
  if (!object(result) || result.isError !== true) return undefined;
  const record = resultRecord(result);
  const error = record && object(record.error) ? record.error : undefined;
  if (!error) return {};
  return {
    ...optional(error, "code"),
    ...optional(error, "message"),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

// Resultado MCP: o record vem como JSON no primeiro content textual.
export function resultRecord(value: unknown): JsonObject | undefined {
  if (!object(value)) return undefined;
  if (!Array.isArray(value.content)) return value;
  for (const part of value.content) {
    const raw = object(part) ? text(part.text) : undefined;
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (object(parsed)) return parsed;
    } catch {
      // conteúdo não-JSON: ignora
    }
  }
  return undefined;
}

/** Lista de um resultado MCP: o contrato devolve sempre `{"items":[…]}`. */
export function resultList(value: unknown, field: string = FIELD.items): unknown[] {
  const items = resultRecord(value)?.[field];
  return Array.isArray(items) ? items : [];
}

function contentParts(value: unknown[]): ToolContent[] {
  return value.filter((part): part is ToolContent => object(part) && typeof part.type === "string");
}

export function toolResult(value: unknown): ToolOutput {
  if (object(value) && Array.isArray(value.content)) {
    const details = object(value.details) ? { ...value.details } : {};
    if (value.isError === true) details[ERROR_DETAIL] = true;
    return { content: contentParts(value.content), details };
  }
  const result = object(value) ? value : { value };
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
}

/** Resultado de erro já pronto para o modelo (mantém o marcador interno). */
export function toolError(message: string): ToolOutput {
  return toolResult({ content: [{ type: "text", text: message }], isError: true });
}

/** Evento do SSE do device: só `{kind, id}` — o conteúdo vem do `inbox`. */
export type GatewayEvent = { kind: string; id: string };
export type EventsHandle = { close: () => void };
export type EventsOptions = {
  /** Falhas desde a última conexão estável; 401/403 são sinalizados à parte. */
  onError?: (error: unknown, failures: number, authError: boolean) => void;
  /** Cota de conexões do dispositivo estourada (429): o stream desiste e sobra o polling. */
  onQuota?: () => void;
  /** Stream aberto: o Pi pode antecipar uma leitura de inbox. */
  onOpen?: () => void;
  /** Conexão sustentada por EVENTS_STABLE_MS: rearma os avisos de falha. */
  onStable?: () => void;
  /** Backoff da reconexão, em ms. */
  backoffMs?: readonly number[];
};

export const EVENTS_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** Frame de SSE maior que isto é lixo: o stream é reiniciado. */
const EVENTS_MAX_BUFFER = 64 * 1024;
/**
 * Conexão que durou menos que isto não conta como boa: proxy que aceita o 200 e
 * fecha em seguida geraria reconexão a cada 1 s, sem backoff.
 */
export const EVENTS_STABLE_MS = 10_000;

/** Um frame SSE (`data:` acumulado) vira evento quando traz `kind`. */
export function parseEventFrame(frame: string): GatewayEvent | undefined {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    const value = colon === -1 ? "" : line.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (data.length === 0) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    return undefined;
  }
  if (!object(payload)) return undefined;
  const kind = text(payload.kind);
  // Eventos legados não têm mais efeito no cliente.
  if (!kind || kind === "decision" || kind === "approval_decision") return undefined;
  const id = text(payload.id) ?? (typeof payload.id === "number" ? String(payload.id) : "");
  return { kind, id };
}

/**
 * SSE do device com reconexão e backoff, em `fetch` streaming (sem dependência).
 * Só antecipa a leitura da inbox: o polling continua sendo o caminho garantido.
 */
export function openEvents(onEvent: (event: GatewayEvent) => void, options: EventsOptions = {}): EventsHandle {
  const backoff = options.backoffMs ?? EVENTS_BACKOFF_MS;
  let closed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let failures = 0;

  async function connect(): Promise<void> {
    // Controller criado antes de qualquer await: `close()` durante a leitura da
    // config/credencial precisa ter o que abortar, senão a conexão nasce órfã.
    const local = new AbortController();
    controller = local;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = await metadata();
      const bearer = await token(config.tokenFile);
      const url = assertSafeUrl(config.eventsUrl ?? eventsUrl(config.endpoint)).toString();
      if (closed) return;
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "text/event-stream", "Cache-Control": "no-store", Authorization: `Bearer ${bearer}` },
        signal: local.signal,
      });
      // 429 = o dispositivo já tem conexões demais (contrato v6: 16). Nada a
      // avisar ao usuário: a leitura periódica continua entregando tudo.
      if (response.status === 429) {
        closed = true;
        options.onQuota?.();
        return;
      }
      if (!response.ok) {
        const error = new Error(`events HTTP ${response.status}`);
        reportError(error, response.status === 401 || response.status === 403);
        return;
      }
      if (!response.body) throw new Error("events stream is empty");
      gatewayStatus.lastOkAt = Date.now();
      stableTimer = setTimeout(() => {
        if (closed) return;
        attempt = 0;
        failures = 0;
        options.onStable?.();
      }, EVENTS_STABLE_MS);
      stableTimer.unref?.();
      options.onOpen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) throw new Error("events stream closed");
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > EVENTS_MAX_BUFFER) throw new Error("events frame is too large");
          // Frames são separados por linha em branco (CRLF tolerado).
          for (;;) {
            const match = /\r?\n\r?\n/u.exec(buffer);
            if (!match) break;
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const event = parseEventFrame(frame);
            if (event) onEvent(event);
          }
        }
      } finally {
        // Erro no loop (frame grande demais) também precisa fechar o socket:
        // sem isto a conexão velha fica aberta e consome a cota do device.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } finally {
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      local.abort();
      if (controller === local) controller = undefined;
    }
  }

  function schedule(): void {
    if (closed || timer !== undefined) return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)]!;
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      void loop();
    }, delay);
    timer.unref?.();
  }

  function reportError(error: unknown, authError = false): void {
    gatewayStatus.lastErrorAt = Date.now();
    gatewayStatus.lastError = safeMessage(error);
    failures += 1;
    options.onError?.(error, failures, authError);
  }

  async function loop(): Promise<void> {
    if (closed) return;
    try {
      await connect();
      // Stream fechado pelo servidor (deploy, timeout do proxy): reconecta.
      if (!closed) schedule();
    } catch (error) {
      if (closed) return;
      reportError(error);
      schedule();
    }
  }

  void loop();
  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    },
  };
}
