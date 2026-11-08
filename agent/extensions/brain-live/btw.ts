// btw: pergunta lateral ao modelo com o contexto da sessao atual, sem poluir o
// historico principal. Porte enxuto de mitsuhiko/btw.ts.
//
// Comando: /btw. O Pi instalado nao tem /btw nativo (core/slash-commands.js), entao o
// nome fica livre para a extensao. A thread lateral vive aqui, a resposta aparece no
// transcript via sendMessage(triggerTurn:false) e /btw merge injeta o resumo no
// contexto principal.
//
// Cortes deliberados (pi roda sempre em daemon mode):
// - BtwOverlay e todo o runtime de overlay (OverlayRuntime, render de tool calls,
//   editor de draft, atalhos) — dependem de ui.custom(), que em daemon e stub que pendura.
// - A AgentSession lateral (createAgentSession/ResourceLoader/createExtensionRuntime) —
//   substituida por uma chamada `complete` direta. Tradeoff: a conversa lateral perde
//   tools; ganho: ~70% menos codigo e zero risco de travar o daemon.
import { buildSessionContext, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";

const BOLD = (s: string) => `\u001b[1m${s}\u001b[22m`;
const FAINT = (s: string) => `\u001b[2m${s}\u001b[22m`;

const BTW_SYSTEM_PROMPT = [
  "You are BTW, a side-channel assistant embedded in the user's coding agent.",
  "You have access to the main conversation context — use it to give informed answers.",
  "Help with focused questions, planning, and quick explorations.",
  "Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
  "Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

export interface BtwEntry {
  question: string;
  answer: string;
  timestamp: number;
  model: string;
}

// Formato real do host (core/system-prompt.js:42-43): "\nCurrent date: <data>" seguido de
// "\nCurrent working directory: <cwd>", e depois disso o host ainda concatena doutrina,
// harness state, guidelines, context files e skills — por isso sem ancora de fim de string.
export function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date:[^\n]*/gu, "")
    .replace(/\nCurrent working directory:[^\n]*/gu, "")
    .trim();
}

const TOOL_ARGS_LIMIT = 400;
const TOOL_RESULT_LIMIT = 2000;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function textOf(content: (TextContent | ImageContent)[] | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as TextContent).text)
    .join("\n")
    .trim();
}

// A lateral chama complete() sem tools, e a Messages API recusa (400) request com bloco
// tool_use/tool_result e tools ausente. Como toda chamada toolless do proprio pi
// (compaction, branch-summarization), viramos os blocos de tool em texto.
export function flattenToolBlocks(messages: Message[]): Message[] {
  const out: Message[] = [];

  for (const message of messages) {
    if (message.role === "toolResult") {
      const body = truncate(textOf(message.content), TOOL_RESULT_LIMIT);
      out.push({
        role: "user",
        content: [{ type: "text", text: `[resultado ${message.toolName}${message.isError ? " (erro)" : ""}]\n${body}` }],
        timestamp: message.timestamp,
      });
      continue;
    }

    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }

    const content = message.content.flatMap((part) => {
      if (part.type === "text") return [part];
      if (part.type === "toolCall") {
        return [{
          type: "text" as const,
          text: `[tool ${part.name}] ${truncate(JSON.stringify(part.arguments ?? {}), TOOL_ARGS_LIMIT)}`,
        }];
      }
      return [];
    });

    if (content.length === 0) continue;
    out.push({ ...message, content });
  }

  return out;
}

export function buildSeedMessages(ctx: ExtensionContext, thread: BtwEntry[]): Message[] {
  const seed: Message[] = [];

  try {
    const contextMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
    seed.push(...flattenToolBlocks(contextMessages.filter((message) => "role" in message) as Message[]));
  } catch {
    // sem contexto utilizavel: segue com a thread lateral sozinha
  }

  for (const item of thread) {
    seed.push(
      { role: "user", content: [{ type: "text", text: item.question }], timestamp: item.timestamp },
      { role: "assistant", content: [{ type: "text", text: item.answer }], model: item.model, timestamp: item.timestamp } as Message,
    );
  }

  return seed;
}

export function formatThread(thread: BtwEntry[]): string {
  return thread
    .map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
    .join("\n\n---\n\n");
}

export function extractText(parts: AssistantMessage["content"]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n")
    .trim();
}

export type Completer = (model: Model<any>, context: { systemPrompt?: string; messages: Message[] }, options?: Record<string, unknown>) => Promise<AssistantMessage>;

// import dinamico: fora do runtime do pi o nome @earendil-works/pi-ai resolve
// pra outro pacote, e o smoke nunca chega a carregar o provider.
let completer: Completer = async (model, context, options) => {
  const { complete } = await import("@earendil-works/pi-ai");
  return (complete as unknown as Completer)(model, context, options);
};

/** Ponto de injecao: o smoke test troca o completer para nunca tocar a rede. */
export function setCompleter(fn: Completer): void {
  completer = fn;
}

export default function (pi: ExtensionAPI) {
  let thread: BtwEntry[] = [];

  async function ask(ctx: ExtensionCommandContext, messages: Message[], systemPrompt: string): Promise<string> {
    const model = ctx.model;
    if (!model) throw new Error("Nenhum modelo ativo.");

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) throw new Error(auth.error);

    const response = await completer(model, { systemPrompt, messages }, { apiKey: auth.apiKey, headers: auth.headers });
    if (response.stopReason === "aborted") throw new Error("Requisicao lateral abortada.");
    if (response.stopReason === "error") throw new Error(response.errorMessage || "Requisicao lateral falhou.");
    return extractText(response.content) || "(sem resposta)";
  }

  function systemPromptFor(ctx: ExtensionContext, extra: string): string {
    return `${stripDynamicSystemPromptFooter(ctx.getSystemPrompt())}\n\n${extra}`;
  }

  function working(ctx: ExtensionCommandContext, message?: string): void {
    if (ctx.hasUI) ctx.ui.setWorkingMessage(message);
  }

  function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  async function askAndShow(ctx: ExtensionCommandContext, question: string): Promise<void> {
    const seed = buildSeedMessages(ctx, thread);
    seed.push({ role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() });

    working(ctx, "Pensando na lateral…");
    try {
      const answer = await ask(ctx, seed, systemPromptFor(ctx, BTW_SYSTEM_PROMPT));
      thread.push({ question, answer, timestamp: Date.now(), model: ctx.model?.id ?? "?" });
      pi.sendMessage(
        { customType: "btw", content: `${BOLD(`lateral: ${question}`)}\n\n${answer}`, display: true },
        { triggerTurn: false },
      );
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    } finally {
      working(ctx);
    }
  }

  async function merge(ctx: ExtensionCommandContext): Promise<void> {
    if (thread.length === 0) {
      notify(ctx, "Nenhuma thread lateral para resumir.", "warning");
      return;
    }

    working(ctx, "Pensando na lateral…");
    try {
      const summary = await ask(
        ctx,
        [{ role: "user", content: [{ type: "text", text: formatThread(thread) }], timestamp: Date.now() }],
        systemPromptFor(ctx, BTW_SUMMARY_PROMPT),
      );
      pi.sendMessage(
        { customType: "btw", content: `${BOLD("lateral · resumo da thread")}\n\n${summary}`, display: true },
        { triggerTurn: true },
      );
      thread = [];
      notify(ctx, "Resumo da lateral injetado no contexto principal.", "info");
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    } finally {
      working(ctx);
    }
  }

  pi.registerCommand("btw", {
    description: `pergunta sem parar o trabalho ${FAINT("/btw <pergunta> · /btw reset · /btw merge")}`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const input = args.trim();

      if (input === "reset") {
        thread = [];
        notify(ctx, "Thread lateral limpa.", "info");
        return;
      }

      if (input === "merge") {
        await merge(ctx);
        return;
      }

      let question = input;
      if (!question) {
        if (!ctx.hasUI) return;
        question = (await ctx.ui.input("Pergunta paralela"))?.trim() ?? "";
        if (!question) return;
      }

      await askAndShow(ctx, question);
    },
  });
}
