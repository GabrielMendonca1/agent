import { appendFileSync, chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SENSITIVE_PATH = /(^|\.)env(\.|$)|secret|credential|token|\.pem$|\.key$|id_rsa|id_ed25519/i;
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;
function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET, "[redigido]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

const MAX_LINE_BYTES = 256 * 1024;

// Keep each record valid JSON, including its newline, even for image/tool payloads.
function logLine(record: Record<string, unknown>): string {
  record = redact(record) as Record<string, unknown>;
  let text = JSON.stringify(record);
  if (Buffer.byteLength(text) + 1 <= MAX_LINE_BYTES) return `${text}\n`;
  const capped: Record<string, unknown> = { ...record, truncated: true };
  for (const field of ["content", "structuredContent", "args", "name", "id", "parent"]) {
    const value = JSON.stringify(capped[field]);
    capped[field] = value === undefined ? null : { truncated: true, preview: value.slice(0, 8192) };
    text = JSON.stringify(capped);
    if (Buffer.byteLength(text) + 1 <= MAX_LINE_BYTES) return `${text}\n`;
  }
  return `${JSON.stringify(capped)}\n`;
}

export default function codemodeLog(pi: ExtensionAPI) {
  if (process.env.MARK_CODEMODE_LOG === "0") return;
  const pending = new Map<string, { name: string; args: unknown; parent: string }>();
  const logs = new Map<string, string>();
  const reset = () => { try { pending.clear(); logs.clear(); } catch { /* best-effort */ } };
  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  pi.on("tool_call", (event) => {
    try {
      if (event.parentToolCallId) pending.set(event.toolCallId, {
        name: event.toolName,
        args: JSON.parse(JSON.stringify(event.input)),
        parent: event.parentToolCallId,
      });
    } catch { /* logging must never stop execution */ }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      if (event.parentToolCallId) {
        const call = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        const dir = join(ctx.sessionManager.getSessionDir(), "codemode");
        // Encoding keeps a tool-call id from becoming a path outside this directory.
        const path = join(dir, `${encodeURIComponent(event.parentToolCallId)}.jsonl`);
        const args = call?.args ?? event.input;
        const readPath = (args as { path?: unknown } | undefined)?.path;
        const sensitive = (call?.name ?? event.toolName) === "read" && typeof readPath === "string"
          && SENSITIVE_PATH.test(basename(readPath.replace(/\\/g, "/")));
        const line = logLine({
          ts: new Date().toISOString(), id: event.toolCallId, parent: event.parentToolCallId,
          name: call?.name ?? event.toolName, args,
          isError: event.isError,
          content: sensitive ? "[redigido: arquivo sensível]" : event.content,
          structuredContent: sensitive ? "[redigido: arquivo sensível]" : event.structuredContent ?? null,
        });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        const fd = openSync(path, "a", 0o600);
        try {
          fchmodSync(fd, 0o600);
          appendFileSync(fd, line, "utf8");
        } finally { closeSync(fd); }
        logs.set(event.parentToolCallId, path);
      } else if (event.toolName === "codemode") {
        const path = logs.get(event.toolCallId);
        logs.delete(event.toolCallId);
        for (const [id, call] of pending) if (call.parent === event.toolCallId) pending.delete(id);
        if (path) return {
          content: [...event.content, { type: "text" as const, text: `[log das chamadas: ${path}]` }],
          structuredContent: event.structuredContent,
        };
      }
    } catch { /* disk, serialization and session failures are non-fatal */ }
  });
}
