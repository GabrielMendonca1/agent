/** Mark escolhe o modelo; o Pi prepara, gera e valida o resumo. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionCachePolicy } from "../../juice/cache-policy.mjs";

export const COMPACTION_PROVIDER = "openai-codex";
export const COMPACTION_MODEL = "gpt-6-luna";
export const COMPACTION_THINKING = "medium" as const;

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning") {
  if (ctx.hasUI) ctx.ui.notify(text, level);
}

export default function compaction(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    if (sessionCachePolicy(ctx)?.deferCompaction(event, ctx)) return { cancel: true };
    const { preparation, customInstructions, signal } = event;
    if (signal?.aborted) return { cancel: true };
    // No modelo escolhido, o próprio host já faz tudo; não substituir o caminho nativo.
    if (ctx.model?.provider === COMPACTION_PROVIDER && ctx.model.id === COMPACTION_MODEL) return;
    try {
      const model = ctx.modelRegistry.find(COMPACTION_PROVIDER, COMPACTION_MODEL);
      if (!model) {
        notify(ctx, `compaction: ${COMPACTION_MODEL} não encontrada, usando o modelo atual`, "warning");
        return;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        notify(ctx, `compaction: sem auth para ${COMPACTION_MODEL}, usando o modelo atual`, "warning");
        return;
      }
      const selected = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
      const { compact } = await import("@earendil-works/pi-coding-agent");
      const reason = sessionCachePolicy(ctx)?.idleCompacting?.() ? "ociosa" : event.reason;
      notify(ctx, `compaction (${reason}) com ${COMPACTION_MODEL} · prompt nativo`, "info");
      const result = await compact(
        preparation, selected, auth.apiKey, auth.headers,
        customInstructions, signal, COMPACTION_THINKING,
        (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
        auth.env,
      );
      if (signal?.aborted) return { cancel: true };
      return { compaction: {
        ...result,
        details: { ...result.details, compactionModel: `${COMPACTION_PROVIDER}/${COMPACTION_MODEL}` },
      } };
    } catch {
      if (signal?.aborted) return { cancel: true };
      notify(ctx, `compaction com ${COMPACTION_MODEL} falhou; usando a padrão do Pi`, "warning");
      return;
    }
  });
}
