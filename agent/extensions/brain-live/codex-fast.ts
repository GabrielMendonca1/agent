// codex-fast: liga o "Fast mode" do Codex (equivalente ao /fast do Codex CLI).
//
// O pi-ai ja serializa `service_tier` no body do Responses API (e ajusta custo por tier),
// mas o pi nao expoe nenhum controle pra isso. Aqui injetamos `service_tier: "priority"` via
// before_provider_request, somente quando o modelo ativo e do provider openai-codex.
// Outros providers nao sao tocados.
//
// Por que "priority" e nao "fast": o backend chatgpt.com/backend-api responde
// `Unsupported service_tier: fast` pra todos os modelos (testado em 2026-09-01 com gpt-5.4,
// gpt-5.4-mini, gpt-5.3-codex, gpt-5.5); "priority" (priority processing, que e o que o
// Fast mode do Codex CLI usa por baixo) e aceito. PI_CODEX_TIER sobrescreve se mudar.
//
// Estado e por sessao e persiste no transcript (appendEntry) — sobrevive a resume/reload.
//
// Uso:
//   /fast          alterna
//   /fast on|off   define
//   /fast status   mostra
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const TIER = process.env.PI_CODEX_TIER ?? "priority";
const ENTRY = "codex-fast";
const STATUS_KEY = "codex-fast";

export default function (pi: ExtensionAPI) {
  let enabled = false;

  const applyStatus = (ctx: { ui: { setStatus: (k: string, v: string | undefined) => void } }) => {
    ctx.ui.setStatus(STATUS_KEY, enabled ? "⚡ fast" : undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    enabled = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY) {
        enabled = Boolean((entry.data as { enabled?: boolean } | undefined)?.enabled);
      }
    }
    applyStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    if (ctx.model?.provider !== PROVIDER) return;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") return;
    if (payload.service_tier === TIER) return;
    return { ...payload, service_tier: TIER };
  });

  pi.registerCommand("fast", {
    description: `Fast mode do Codex (service_tier=${TIER}): /fast [on|off|status]`,
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "status") {
        const scope = ctx.model?.provider === PROVIDER ? "" : ` (modelo atual é ${ctx.model?.provider ?? "?"} — só afeta ${PROVIDER})`;
        ctx.ui.notify(`Fast mode: ${enabled ? "ligado" : "desligado"}${scope}`, "info");
        return;
      }
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else if (arg === "") enabled = !enabled;
      else {
        ctx.ui.notify("Uso: /fast [on|off|status]", "error");
        return;
      }
      pi.appendEntry(ENTRY, { enabled });
      applyStatus(ctx);
      const warn = ctx.model?.provider === PROVIDER ? "" : ` — modelo atual não é ${PROVIDER}; passa a valer quando trocar.`;
      ctx.ui.notify(`Fast mode ${enabled ? "ligado" : "desligado"}${warn}`, "info");
    },
  });
}
