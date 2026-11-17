/**
 * cache-keeper — mantém o prompt cache da Anthropic quente enquanto você está parado.
 *
 * Por que não o aquecedor do Pi (`cacheWarming: idle`): ele para aos 30 min ociosos e usa uma
 * chance fixa de 15%; com TTL de 1 h (PI_CACHE_RETENTION=long) o 1º refresh cairia aos 54 min,
 * ou seja, nunca aquece. Medido nas sessões do Gabriel (cache-plan.md): TTL 1 h + aquecer
 * enquanto vale = −22% no lado da entrada; o ótimo teórico é −23,1%.
 *
 * Como funciona:
 * - Guarda o último request real do agente principal (before_provider_request).
 * - Quando a sessão fica ociosa (agent_settled), agenda um refresh aos 90% do TTL: reenvia o
 *   MESMO payload com max_tokens 1 (lê o prefixo a 0,1× e renova o TTL).
 * - Aquece por uma janela T escolhida pelas pausas registradas do projeto: o T que minimiza
 *   refresh pago (0,1× o contexto) + perda esperada ((w−0,1)×; w = 2,0 em 1 h, 1,25 em 5 min).
 *   Cada pausa pesa pelo tamanho do contexto. Com menos de 30 pausas registradas, janela de 3 h
 *   (ótimo medido nas sessões do Gabriel; a curva é plana entre 2,7 h e 9 h).
 * - Para no primeiro refresh que não acerta o cache, em qualquer entrada sua e no fim da sessão.
 * - Thinking: o replay segue `warmPlan` (cache-policy.mjs). Sem thinking/adaptive → max_tokens 1;
 *   thinking com budget B → max_tokens B+1 só se o pior caso couber no teto de custo, senão pula.
 * - Message threads (chave de API Anthropic, beta `message-threads-*` no payload): não aquece e
 *   mostra `cache ❄ (message-threads)` (ver `usesMessageThreads`).
 * - Contabilidade (ledger J): o ping vai pelo ModelRuntime com kind `cache-warm` (runtime.mjs);
 *   pausas, quebras de cache (com causa) e pulos vão ao ledger como números/enums, sem payload.
 * - D: compactação por limiar com o cache quente é adiada (`compactionDecision`); manual,
 *   overflow e o limite duro passam sempre.
 * - F: prévia ANTES da escolha para a TUI (`estimateSwitch` em globalThis); depois da troca,
 *   aviso + evento `agent:cache-estimate` em pi.events (pós-fato, não é prévia).
 * - H: OpenAI/Codex sem `prompt_cache_key` (ou em subagente) ganham chave do prefixo estável.
 * - I: compactação ociosa (como no Claude Code). Quando o aquecimento acaba (janela fechada,
 *   refresh pulado ou sem acerto) e o contexto tem ≥ AGENT_IDLE_COMPACT_MIN_TOKENS (padrão 200K,
 *   piso 100K), compacta antes do cache esfriar, nunca antes de 54 min parado. Só com o agente
 *   ocioso, sem fila e com o editor vazio. Desliga: AGENT_IDLE_COMPACT=0.
 *
 * O aquecedor nativo do Pi fica parado sempre (handler `cache_warming_decision` → stop).
 *
 * Desliga: AGENT_CACHE_KEEPER=0. Teste: AGENT_CACHE_KEEPER_TEST=1 faz um refresh já no agent_settled.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindSessionCachePolicy, breakCause, compactionDecision, idleCompactionAt, idleCompactionDecision, idleCompactMinTokens, fingerprint, firstChangedSegment, CALL_KIND, modelSwitchEstimate, openaiCacheKey, prefetchPayload, warmPlan } from "../../core/cache-policy.mjs";
import { isChild } from "../../core/client.mjs";
import { CompactionEpoch, branchOf } from "./lib/compaction-epoch.ts";
import { clearBeforeAutoCompaction, recordToolClearRequest } from './compaction/tool-clear.ts';

const DEFAULT_WINDOW_S = 3 * 3600; // ótimo nas pausas do Gabriel pesadas por contexto (curva plana de 2,7 h a 9 h)
const MAX_WINDOW_S = 24 * 3600;
const MIN_SAMPLES = 30;
const MAX_SAMPLES = 400;

type Gap = { s: number; c?: 1; k?: number }; // pausa (s); c=1: censurada (fechou sem voltar); k: tokens do contexto (peso)
type Payload = Record<string, any>;

const ttlOf = (p: Payload): number => {
  const all = [
    ...(Array.isArray(p.system) ? p.system : []),
    ...(p.tools ?? []),
    ...((p.messages ?? []) as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
  ].map((b: any) => b?.cache_control).filter(Boolean);
  if (!all.length) return 0;
  return all.some((c: any) => c.ttl === "1h") ? 3600 : 300;
};

/**
 * Janela de aquecimento (s): o T que minimiza o custo esperado nas pausas registradas do projeto
 * (aluguel de esquis com distribuição empírica; "histogram policy" de keep-alive). Para cada T
 * candidato (múltiplos do intervalo de refresh), soma em unidades de contexto: 0,1 por refresh
 * enquanto a pausa dura e (w − 0,1) quando você volta depois do cache expirar. Pausas censuradas
 * (sessão fechou sem voltar) só pagam refresh. Empate → menor T.
 */
export function warmWindow(gaps: Gap[], ttl: number): number {
  if (gaps.length < MIN_SAMPLES) return DEFAULT_WINDOW_S;
  const step = Math.floor(ttl * 0.9);
  const w = ttl >= 3600 ? 2.0 : 1.25;
  let best = 0, bestCost = Infinity;
  for (let T = 0; T <= MAX_WINDOW_S; T += step) {
    let cost = 0;
    for (const g of gaps) {
      let refreshes = 0, alive = ttl;
      for (let r = step; r <= T && r < g.s; r += step) { refreshes += 1; alive = r + ttl; }
      cost += (g.k ?? 1) * (0.1 * refreshes + (!g.c && g.s > alive ? w - 0.1 : 0));
    }
    if (cost < bestCost - 1e-9) { best = T; bestCost = cost; }
  }
  return best;
}

const MAX_PING_USD = Number(process.env.AGENT_CACHE_KEEPER_MAX_PING_USD ?? 0.5);

/**
 * Lane de message threads da Anthropic (chave de API, Pi ≥ 1.5.2): o payload guardado é o request
 * completo (before_provider_request roda antes de o provider aplicar a thread) e leva o beta
 * `message-threads-*` em `betas`. O request real seguinte sai como `thread: continue` só com as
 * mensagens novas; o ping sairia completo e sem `thread`. Que esse ping aqueça o cache que a
 * continuação lê não dá para provar sem chamada real, e um erro aqui paga escrita do contexto
 * inteiro. Então o keeper não aquece nessa lane e diz por quê (`message-threads`).
 * A lane OAuth (pi-black) não usa threads e não leva esse beta.
 */
export const usesMessageThreads = (p: Payload | undefined): boolean =>
  !!p && ("thread" in p || (Array.isArray(p.betas) && p.betas.some((b: unknown) => typeof b === "string" && b.startsWith("message-threads-"))));
const THREADS_SKIP = "message-threads";

export default function cacheKeeper(pi: ExtensionAPI) {
  // O aquecedor nativo do Pi (`cacheWarming`, padrão "idle" desde a 1.5.1) fica parado sempre,
  // inclusive com AGENT_CACHE_KEEPER=0: desligar o keeper não pode ligar outro aquecedor pago.
  pi.on("cache_warming_decision", async () => ({ action: "stop" as const }));
  if (process.env.AGENT_CACHE_KEEPER === "0") return;
  const child = isChild();

  // H — vale também em subagentes: chave do prefixo estável quando falta ou é por sessão de filho.
  pi.on("before_provider_request", (event: { payload: Payload }) => {
    const key = openaiCacheKey(event.payload, { child });
    if (key) return { ...event.payload, prompt_cache_key: key };
  });
  // E — filho de prefetch (AGENT_CACHE_PREFETCH=1, lançado pelo runner com tarefa "."): o 1º
  // request só escreve tools+system no cache (max_tokens 1, sem thinking) e o processo sai logo
  // depois da resposta, antes de o Pi tratar o `length` como recuperável (compactação/retry).
  // Fora da Anthropic sai antes de qualquer request. Limite: um request, 60 s.
  if (child && process.env.AGENT_CACHE_PREFETCH === "1") {
    const noExit = process.env.AGENT_CACHE_PREFETCH_NO_EXIT === "1"; // só testes
    const exit = (code: number) => { if (!noExit) process.exit(code); };
    let sent = false;
    pi.on("session_start", (_e, ctx) => {
      if ((ctx.model as any)?.api !== "anthropic-messages") exit(3);
      setTimeout(() => exit(4), 60_000).unref?.();
    });
    pi.on("before_provider_request", (event: { payload: Payload }) => {
      const warm = sent ? undefined : prefetchPayload(event.payload);
      if (!warm) { exit(3); return; }
      sent = true;
      return warm;
    });
    pi.on("message_end", (event: any) => { if (sent && event?.message?.role === "assistant") exit(event.message.stopReason === "error" ? 5 : 0); });
  }
  if (child) return;

  // Payload preso ao modelo que o enviou: o ping só reusa com o MESMO provider/modelo Anthropic.
  type Bound = { provider: string; id: string; api: string };
  let last: { payload: Payload; at: number; model: Bound } | undefined;
  let pendingModel: Bound | undefined;
  let pinging = false;
  let cycle = 0;
  let refreshController: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleSince: number | undefined;
  let idleTokens: number | undefined;
  let warmUntil: number | undefined; // até quando o cache está garantido
  let stats = { pings: 0, misses: 0, cost: 0 };
  let lastSkip: string | undefined;
  let ctxRef: ExtensionContext | undefined;
  let prevFp: { fp: ReturnType<typeof fingerprint>; at: number; ttl: number } | undefined;
  let requestBreak: ({ cause: string } & ReturnType<typeof firstChangedSegment>) | undefined;
  let lastDrop: ReturnType<typeof firstChangedSegment> | undefined;
  let deferredTurns = 0;
  // I — compactação ociosa: um disparo por pausa.
  const idleEnabled = process.env.AGENT_IDLE_COMPACT !== "0";
  const idleMin = idleCompactMinTokens(process.env.AGENT_IDLE_COMPACT_MIN_TOKENS);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleAt: number | undefined;
  let idleCompacting = false;
  // Fim REAL da compactação: o host durável não emite `session_compact`, então o orçamento de
  // adiamento é liberado ao ver a entrada de compactação confirmada no branch ativo.
  const epoch = new CompactionEpoch();
  // Uma leitura do branch por decisão de compactação (nunca em laço nem por timer).
  function noteCompactionDone(ctx: ExtensionContext) {
    if (!epoch.observe(branchOf(ctx))) return;
    deferredTurns = 0;

  }

  const store = (cwd: string) => {
    const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".agent");
    const dir = join(base, "cache-keeper");
    mkdirSync(dir, { recursive: true });
    return join(dir, createHash("sha1").update(cwd).digest("hex").slice(0, 12) + ".json");
  };
  const loadGaps = (cwd: string): Gap[] => {
    try { return JSON.parse(readFileSync(store(cwd), "utf8")).gaps ?? []; } catch { return []; }
  };
  const saveGap = (cwd: string, gap: Gap) => {
    if (gap.s < 1) return;

    const gaps = [...loadGaps(cwd), gap].slice(-MAX_SAMPLES);
    try { writeFileSync(store(cwd), JSON.stringify({ cwd, gaps }) + "\n"); } catch { /* best-effort */ }
  };

  const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
  const dropLabel = () => lastDrop ? `✂ ${lastDrop.segment === "message" ? `msg#${lastDrop.index}` : lastDrop.segment}` : undefined;
  const status = (text?: string) => {
    if (ctxRef?.hasUI) ctxRef.ui.setStatus("cache-keeper", [text, dropLabel()].filter(Boolean).join(" · ") || undefined);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    timer = undefined; idleTimer = undefined; idleAt = undefined;
  };

  // I — agenda a compactação ociosa para quando o cache esfriar (coldAt), nunca antes de 54 min parado.
  function planIdleCompaction(ctx: ExtensionContext, coldAt: number) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined; idleAt = undefined;
    if (!idleEnabled || idleSince === undefined || idleCompacting) return;
    const tokens = ctx.getContextUsage?.()?.tokens ?? 0;
    if (!(tokens >= idleMin)) return;
    const at = idleCompactionAt({ coldAt, idleSince });
    const scheduledCycle = cycle;
    idleAt = at;
    idleTimer = setTimeout(() => {
      idleTimer = undefined; idleAt = undefined;
      if (scheduledCycle !== cycle || idleSince === undefined) return;
      runIdleCompaction(ctx);
    }, Math.max(1000, at - Date.now()));
    idleTimer.unref?.();
  }
  function runIdleCompaction(ctx: ExtensionContext) {
    let editorText = "";
    try { if (ctx.hasUI) editorText = ctx.ui.getEditorText?.() ?? ""; } catch { /* sem editor */ }
    const tokens = ctx.getContextUsage?.()?.tokens ?? 0;
    const decision = idleCompactionDecision({
      enabled: idleEnabled, tokens, minTokens: idleMin,
      idle: ctx.isIdle?.() ?? false, pending: ctx.hasPendingMessages?.() ?? false, editorText,
    });
    if (decision.action !== "compact") return;
    if (clearBeforeAutoCompaction(ctx, idleMin - 1)) {
      forget(); // A saved projection supersedes the old warmable payload.
      return;
    }
    idleCompacting = true;
    const runCycle = cycle;
    forget(); // o resumo muda o prefixo: o payload guardado não serve mais para aquecer

    status("compactando (ocioso)…");
    const done = (text: string, level: "info" | "warning") => {
      if (runCycle !== cycle) return;
      idleCompacting = false;
      status(undefined);
      if (ctx.hasUI) ctx.ui.notify(text, level);
    };
    ctx.compact({
      onComplete: (r: any) => done(`Compactado enquanto ocioso, antes do cache expirar (~${Math.round((r?.tokensBefore ?? tokens) / 1000)}k tokens → resumo). Desligar: AGENT_IDLE_COMPACT=0`, "info"),
      onError: (e: Error) => done(`Compactação ociosa não rodou: ${e.message}`, "warning"),
    });
  }

  // Request real → guarda; refresh do keeper → troca pelo último payload real com max_tokens 1.
  pi.on("before_provider_request", (event: { payload: Payload }, ctx?: ExtensionContext) => {
    const p = event.payload;
    if (pinging) return;
    requestBreak = undefined;
    if (p && typeof p === "object") {
      const next = { fp: fingerprint(p), at: Date.now(), ttl: ttlOf(p) || 300 };
      if (prevFp) requestBreak = {
        cause: breakCause(prevFp.fp, next.fp, { elapsedS: (next.at - prevFp.at) / 1000, ttlSeconds: prevFp.ttl }),
        ...firstChangedSegment(prevFp.fp, next.fp),
      };
      prevFp = next; // One fingerprint per session, never a history of payloads.
    }
    const m: any = ctx?.model;
    pendingModel = m ? { provider: m.provider, id: m.id, api: m.api } : undefined;
    captureFinal = true; // o runtime Agent entrega o corpo final depois da cadeia inteira
    remember(p, pendingModel);
  });
  // Corpo final (runtime.mjs, depois de tool-lexicon/image-normalize etc.) substitui o parcial.
  let captureFinal = false;
  (globalThis as any)[Symbol.for("agent.cache-keeper.finalPayload")] = (p: Payload) => {
    if (!captureFinal || pinging) return;
    captureFinal = false;
    remember(p, pendingModel);
  };
  // Esquece o payload e cancela o timer: troca de modelo/provider ou request que não é Anthropic.
  function forget() { clear(); last = undefined; warmUntil = undefined; status(undefined); }
  const sameModel = (a?: Bound, b?: any) => !!a && !!b && a.provider === b.provider && a.id === b.id;
  function remember(p: Payload, model?: Bound) {
    // Request de outro provider (ou sem modelo conhecido) torna o payload Anthropic guardado velho.
    if (!model || model.api !== "anthropic-messages") { if (p && typeof p === "object") forget(); return; }
    if (!p || !Array.isArray(p.messages) || !("system" in p)) return; // só Messages API da Anthropic
    if (typeof p.model === "string" && p.model !== model.id) return; // corpo de outro modelo (alias/rota)
    if (!ttlOf(p)) return;
    last = { payload: structuredClone(p), at: Date.now(), model };
    warmUntil = last.at + ttlOf(p) * 1000;
  }

  async function refresh(ctx: ExtensionContext): Promise<boolean> {
    const model: any = ctx.model;
    if (!last || !model) return false;
    // Guarda no momento do ping (ctx é mutável): mesmo provider/modelo/API do request guardado.
    if (!sameModel(last.model, model) || model.api !== "anthropic-messages" || (typeof last.payload.model === "string" && last.payload.model !== model.id)) {
      forget();

      lastSkip = "modelo trocado";
      return false;
    }
    const snapshot = last.payload;
    if (usesMessageThreads(snapshot)) {
      lastSkip = THREADS_SKIP;
      return false;
    }
    const ttl = ttlOf(snapshot);
    const plan = warmPlan(snapshot, { model, promptTokens: ctx.getContextUsage?.()?.tokens ?? 0, ttlSeconds: ttl, maxPingUsd: MAX_PING_USD });
    if (plan.action === "skip") {

      lastSkip = plan.reason;
      return false;
    }
    const refreshCycle = cycle;
    pinging = true;
    let kill: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      refreshController = controller;
      kill = setTimeout(() => controller.abort(), 60_000);
      const response: any = await ctx.modelRegistry.streamSimple(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: "." }], timestamp: Date.now() }] } as any,
        {
          maxTokens: plan.maxTokens, signal: controller.signal, cacheRetention: ttl >= 3600 ? "long" : "short",
          // Contabilidade separada no ledger (kind cache-warm); o símbolo não vai ao provider.
          [CALL_KIND]: "cache-warm",
          // Chamadas por modelRegistry não passam por before_provider_request: troca o payload aqui.
          // Corpo idêntico salvo max_tokens: o cch (que exclui model/max_tokens) e o prefixo se mantêm.
          onPayload: () => ({ ...snapshot, max_tokens: plan.maxTokens }),
        } as any,
      ).result();
      if (refreshCycle !== cycle) return false;
      const u = response?.usage ?? {};
      const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      stats.pings += 1;
      stats.cost += u.cost?.total ?? 0;
      const hit = prompt > 0 && (u.cacheRead ?? 0) >= 0.9 * prompt;
      if (process.env.AGENT_CACHE_KEEPER_TEST === "1") process.stderr.write(`cache-keeper usage: ${JSON.stringify(u)} stop=${response?.stopReason} err=${response?.errorMessage ?? ""}\n`);
      if (!hit) stats.misses += 1;
      if (hit) recordToolClearRequest(pi, ctx, ttl);
      return hit;
    } catch (error) {
      if (refreshCycle !== cycle) return false;
      if (process.env.AGENT_CACHE_KEEPER_TEST === "1") process.stderr.write(`cache-keeper erro: ${error}\n`);

      return false;
    } finally {
      clearTimeout(kill);
      if (refreshCycle === cycle) { pinging = false; refreshController = undefined; }
    }
  }

  function schedule(ctx: ExtensionContext) {
    clear();
    if (!last || idleSince === undefined) return;
    const ttl = ttlOf(last.payload);
    const window = warmWindow(loadGaps(ctx.cwd), ttl) * 1000;
    const base = warmUntil ?? last.at + ttl * 1000;
    const at = base - Math.max(10_000, ttl * 100); // 90% do TTL (margem ≥ 10 s)
    if (usesMessageThreads(last.payload)) {
      planIdleCompaction(ctx, at);
      status(`cache até ${hhmm(base)} · ❄ (${THREADS_SKIP})` + (idleAt ? ` · resumo ${hhmm(idleAt)}` : ""));
      return;
    }
    if (at - idleSince > window) {

      planIdleCompaction(ctx, at);
      status(`cache até ${hhmm(base)}` + (idleAt ? ` · resumo ${hhmm(idleAt)}` : ""));
      return;
    }
    status(`cache ♨ até ${hhmm(base)}`);
    const scheduledCycle = cycle;
    timer = setTimeout(async () => {
      timer = undefined;
      if (idleSince === undefined) return;
      const ok = await refresh(ctx);
      if (scheduledCycle !== cycle) return;
      if (!ok) {
        planIdleCompaction(ctx, Date.now());
        status((lastSkip ? `cache ❄ (${lastSkip})` : "cache ❄") + (idleAt ? ` · resumo ${hhmm(idleAt)}` : ""));
        lastSkip = undefined;
        return;
      }
      warmUntil = Date.now() + ttl * 1000;
      schedule(ctx);
    }, Math.max(1000, at - Date.now()));
    timer.unref?.();
  }

  let unbindPolicy: (() => void) | undefined;
  pi.on("session_start", (_e, ctx) => {
    unbindPolicy?.();
    cycle += 1;
    refreshController?.abort();
    refreshController = undefined;
    pinging = false;
    lastDrop = undefined;
    forget();
    pendingModel = undefined;
    captureFinal = false;
    idleSince = undefined;
    idleTokens = undefined;
    prevFp = undefined;
    requestBreak = undefined;
    deferredTurns = 0;
    idleCompacting = false;
    decidido = new WeakMap();
    stats = { pings: 0, misses: 0, cost: 0 };
    lastSkip = undefined;
    ctxRef = ctx;
    epoch.sync(branchOf(ctx));
    unbindPolicy = bindSessionCachePolicy(ctx, { cacheState, deferCompaction, idleCompacting: () => idleCompacting });
  });

  // J — quebra de cache com causa: resposta que leu < 50% do prompt depois de um request anterior.
  pi.on("message_end", (event: any) => {
    const m = event?.message;
    if (pinging || m?.role !== "assistant" || !m.usage || !requestBreak) return;
    const u = m.usage;
    const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (prompt < 2048 || (u.cacheRead ?? 0) >= 0.5 * prompt) return;
    const { cause, ...changed } = requestBreak;
    lastDrop = changed;

    status();
  });

  // Estado do cache do prefixo: true = dentro do TTL do último request guardado; false = TTL
  // vencido (frio); undefined = sem informação (nenhum payload Anthropic visto nesta sessão).
  const cacheWarm = (): boolean | undefined => {
    if (!last || warmUntil === undefined) return undefined;
    return Date.now() < warmUntil;
  };
  // Consulta pura do estado do cache. Não decide, não grava no ledger nem aquece.
  // Ausência do hook = keeper ausente (quem consulta não deve inferir "frio" disso).
  const cacheState = () => ({
    warm: cacheWarm(),
    warmUntil: cacheWarm() === true ? warmUntil : undefined,
    ttlSeconds: last ? ttlOf(last.payload) : undefined,
  });

  // D — compactação por limiar com cache quente espera o cache esfriar (ou o limite duro).
  // Ambos os hooks usam a mesma conexão e o mesmo evento, independente da ordem de carga.
  const decideCompaction = (event: any, ctx: ExtensionContext) => {
    const usage = ctx.getContextUsage?.();
    return compactionDecision({
      reason: event?.reason, warm: warmUntil !== undefined && Date.now() < warmUntil,
      tokens: usage?.tokens ?? 0, contextWindow: usage?.contextWindow ?? 0,
      ttlSeconds: last ? ttlOf(last.payload) : 300, deferredTurns,
    });
  };
  // Uma decisão POR EVENTO de compactação, memorizada no próprio evento: quem pergunta duas
  // vezes (o hook de compaction.ts e o handler daqui, para o mesmo `session_before_compact`)
  // recebe a MESMA resposta e consome o orçamento de adiamento uma única vez. Decidir de novo
  // também mudaria a resposta no meio do evento (deferredTurns acabou de subir).
  let decidido = new WeakMap<object, ReturnType<typeof compactionDecision>>();
  function gateCompaction(event: any, ctx: ExtensionContext) {
    // Antes de decidir: uma compactação concluída desde a última pergunta zera o adiamento
    // (o orçamento é por compactação, não por sessão).
    noteCompactionDone(ctx);
    const chave = event && typeof event === "object" ? (event as object) : undefined;
    const memo = chave && decidido.get(chave);
    if (memo) return memo;
    const decision = decideCompaction(event, ctx);
    if (chave) decidido.set(chave, decision);

    if (decision.action === "defer") {
      deferredTurns += 1;
      status(`compactação adiada: cache quente (${deferredTurns}/${decision.maxTurns})`);
    }
    return decision;
  }
  const deferCompaction = (event: any, ctx: ExtensionContext) => gateCompaction(event, ctx).action === "defer";
  pi.on("session_before_compact", (event: any, ctx: ExtensionContext) => {
    if (deferCompaction(event, ctx)) return { cancel: true };
  });
  // Host clássico: o evento chega. `sync` adota a entrada já gravada para a observação não
  // contar a MESMA compactação de novo no próximo gate.
  pi.on("session_compact", (_e: any, ctx: ExtensionContext) => {
    deferredTurns = 0;

    epoch.sync(branchOf(ctx));
  });

  // F — PRÉVIA para a TUI mostrar ANTES da escolha (seletor de modelo):
  // `globalThis[Symbol.for("agent.cache-keeper.estimateSwitch")]?.(toModel, ctx)` → estimativa
  // com o estado atual (modelo ativo, tokens, TTL, cache quente). Pura: não muda nada nem grava.
  (globalThis as any)[Symbol.for("agent.cache-keeper.estimateSwitch")] = (to: any, ctx: ExtensionContext) => {
    const from = ctx.model as any;
    const tokens = ctx.getContextUsage?.()?.tokens ?? 0;
    if (!from || !to || !tokens) return undefined;
    return modelSwitchEstimate({ from, to, tokens, ttlSeconds: last ? ttlOf(last.payload) : 300, warm: warmUntil !== undefined && Date.now() < warmUntil });
  };
  // F — aviso DEPOIS da troca (model_select já aconteceu): registra/avisa o custo que vem no próximo turno.
  pi.on("model_select", (event: any, ctx: ExtensionContext) => {
    if (event?.source === "restore" || !event?.previousModel || !event?.model) return;
    const tokens = ctx.getContextUsage?.()?.tokens ?? 0;
    const est = modelSwitchEstimate({ from: event.previousModel, to: event.model, tokens, ttlSeconds: last ? ttlOf(last.payload) : 300, warm: warmUntil !== undefined && Date.now() < warmUntil });
    if (est.sameModel || !tokens) return;
    (pi as any).events?.emit?.("agent:cache-estimate", { kind: "model-switch", from: `${event.previousModel.provider}/${event.previousModel.id}`, to: `${event.model.provider}/${event.model.id}`, ...est });
    if (ctx.hasUI && est.extraUsd !== undefined && est.extraUsd >= 0.01) {
      ctx.ui.notify(`Troca de modelo reescreve ~${Math.round(tokens / 1000)}k tokens de cache: ~US$${est.rebuildUsd!.toFixed(2)} no próximo turno (continuar custaria ~US$${(est.stayUsd ?? 0).toFixed(2)}).`, "info");
    }
  });
  // Troca de modelo (inclusive restore/alias para outro id): o payload guardado não serve mais.
  pi.on("model_select", (event: any) => { if (last && !sameModel(last.model, event?.model)) forget(); });
  pi.on("agent_start", (_e, ctx) => {
    ctxRef = ctx;
    clear();
    if (idleSince !== undefined) saveGap(ctx.cwd, { s: Math.round((Date.now() - idleSince) / 1000), k: idleTokens });
    idleSince = undefined;
    status(undefined);
  });
  pi.on("agent_settled", async (_e, ctx) => {
    ctxRef = ctx;
    if (!last) return;
    idleSince = Date.now();
    idleTokens = ctx.getContextUsage?.()?.tokens ?? undefined;
    if (process.env.AGENT_CACHE_KEEPER_TEST === "1") {
      const delay = Number(process.env.AGENT_CACHE_KEEPER_TEST_DELAY ?? 0) * 1000;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const ok = await refresh(ctx);
      process.stderr.write(`cache-keeper test: ${ok ? "hit" : "miss"} (${stats.pings} ping)${lastSkip ? ` skip=${lastSkip}` : ""}\n`);
      lastSkip = undefined;
      return;
    }
    schedule(ctx);
  });
  pi.on("session_shutdown", (_e, ctx) => {
    unbindPolicy?.();
    unbindPolicy = undefined;
    cycle += 1;
    refreshController?.abort();
    refreshController = undefined;
    pinging = false;
    lastDrop = undefined;
    prevFp = undefined;
    requestBreak = undefined;
    forget();
    captureFinal = false;
    if (idleSince !== undefined) saveGap(ctx.cwd, { s: Math.round((Date.now() - idleSince) / 1000), c: 1, k: idleTokens });
    idleSince = undefined;
  });

  pi.registerCommand("cache", {
    description: "Estado do cache-keeper: janela de aquecimento, pings e pausas registradas",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const gaps = loadGaps(ctx.cwd);
      const ttl = last ? ttlOf(last.payload) : 3600;
      const win = warmWindow(gaps, ttl);
      ctx.ui.notify([
        `TTL ${ttl >= 3600 ? "1 h" : "5 min"} · janela de aquecimento ${(win / 3600).toFixed(1)} h${gaps.length < MIN_SAMPLES ? ` (padrão; ${gaps.length}/${MIN_SAMPLES} pausas registradas)` : ` (${gaps.length} pausas deste projeto)`}`,
        `compactação ociosa: ${idleEnabled ? `≥${Math.round(idleMin / 1000)}k tokens${idleAt ? ` · agendada ${hhmm(idleAt)}` : ""}` : "desligada (AGENT_IDLE_COMPACT=0)"}`,
        `pings nesta sessão: ${stats.pings} (${stats.misses} sem acerto, US$${stats.cost.toFixed(4)})` + (warmUntil ? ` · cache garantido até ${hhmm(warmUntil)}` : ""),
        ...(dropLabel() ? [dropLabel()!] : []),
      ].join("\n"), "info");
    },
  });
}
