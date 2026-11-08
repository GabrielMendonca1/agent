// Política de prompt cache do Agent (backend, sem UI). Funções puras, testadas em
// scripts/test-cache-keeper.mjs; quem liga ao caminho real é cache-keeper.ts (aquecimento,
// compactação, troca de modelo, chave OpenAI) e o runner de subagentes (leque escalonado).
// Nada aqui guarda texto de payload: só números e enums.

/** Option-symbol que o runtime Juice lê como `kind` da chamada (ex.: 'cache-warm'). Símbolo não serializa no provider. */
export const JUICE_KIND = Symbol.for('agent.juice.kind');

/** Preço em US$ por token de um modelo do Pi (`model.cost` vem em US$/milhão). */
function perToken(model, key) {
  const v = model?.cost?.[key];
  return Number.isFinite(v) && v >= 0 ? v / 1e6 : undefined;
}

/** Multiplicador de escrita de cache por API/TTL. OpenAI não cobra escrita; Anthropic 1,25× (5 min) e 2× (1 h). */
export function writeMultiplier(model, ttlSeconds) {
  if (model?.api !== 'anthropic-messages') return 1;
  return ttlSeconds >= 3600 ? 2 : 1.25;
}

/**
 * F — custo de reconstruir o prefixo em `model` (US$), por tokens e preço do catálogo.
 * Anthropic: escrita = input × multiplicador do TTL (o catálogo só traz a escrita de 5 min).
 * OpenAI/outros: entrada cheia. Sem preço → `usd: undefined` (não inventa).
 */
export function rebuildCost(model, tokens, ttlSeconds = 300) {
  const input = perToken(model, 'input');
  if (!(tokens > 0) || input === undefined) return { tokens: tokens > 0 ? tokens : 0, usd: undefined };
  const catalogWrite = perToken(model, 'cacheWrite');
  const mult = writeMultiplier(model, ttlSeconds);
  const write = model?.api === 'anthropic-messages' && ttlSeconds < 3600 && catalogWrite ? catalogWrite : input * mult;
  return { tokens, usd: tokens * write };
}

/** Custo de um turno que só LÊ o prefixo do cache (US$). */
export function readCost(model, tokens) {
  const read = perToken(model, 'cacheRead') ?? (perToken(model, 'input') ?? NaN) * 0.1;
  return tokens > 0 && Number.isFinite(read) ? tokens * read : undefined;
}

/**
 * F — estimativa da troca de modelo no meio da sessão. Trocar de modelo muda a chave do cache
 * (o prefixo é por modelo): o próximo turno escreve `tokens` no modelo novo em vez de ler.
 * `extra` = o que a troca custa a mais que continuar no modelo atual com cache quente.
 */
export function modelSwitchEstimate({ from, to, tokens, ttlSeconds = 300, warm = true }) {
  const rebuild = rebuildCost(to, tokens, ttlSeconds);
  const stay = warm ? readCost(from, tokens) : rebuildCost(from, tokens, ttlSeconds).usd;
  const extra = rebuild.usd !== undefined && stay !== undefined ? Math.max(0, rebuild.usd - stay) : undefined;
  return { tokens, rebuildUsd: rebuild.usd, stayUsd: stay, extraUsd: extra, sameModel: from?.provider === to?.provider && from?.id === to?.id };
}

/**
 * Aquecimento seguro: como reenviar o último payload sem invalidar o prefixo nem gastar sem teto.
 * - sem thinking / disabled / adaptive → replay com max_tokens 1 (mesma regra do aquecedor
 *   nativo do Pi: `isReplayable` aceita adaptive; budget não).
 * - thinking `enabled` com budget B → a API exige max_tokens > B, e mudar o budget invalida o
 *   cache das mensagens. Replay só com max_tokens B+1 e se o PIOR caso (B+1 tokens de saída)
 *   couber no teto: ≤ `capShare` da perda evitada e ≤ `maxPingUsd`. Senão pula ('thinking-budget'
 *   ou 'cost-cap').
 * Devolve { action:'replay', maxTokens, worstCaseUsd } | { action:'skip', reason }.
 */
export function warmPlan(payload, { model, promptTokens = 0, ttlSeconds = 300, capShare = 0.25, maxPingUsd = 0.5 } = {}) {
  if (!payload || typeof payload !== 'object') return { action: 'skip', reason: 'no-payload' };
  const thinking = payload.thinking;
  const read = readCost(model, promptTokens) ?? 0;
  const out = perToken(model, 'output');
  if (!thinking || thinking.type === 'disabled' || thinking.type === 'adaptive') {
    const worst = read + (out ?? 0);
    if (worst > maxPingUsd) return { action: 'skip', reason: 'cost-cap' };
    return { action: 'replay', maxTokens: 1, worstCaseUsd: worst };
  }
  if (thinking.type === 'enabled' && Number.isSafeInteger(thinking.budget_tokens) && thinking.budget_tokens > 0) {
    if (out === undefined) return { action: 'skip', reason: 'thinking-budget' };
    const maxTokens = thinking.budget_tokens + 1;
    const worst = read + maxTokens * out;
    const avoided = rebuildCost(model, promptTokens, ttlSeconds).usd ?? 0;
    if (worst > maxPingUsd) return { action: 'skip', reason: 'cost-cap' };
    if (worst > capShare * Math.max(0, avoided - read)) return { action: 'skip', reason: 'thinking-budget' };
    return { action: 'replay', maxTokens, worstCaseUsd: worst };
  }
  return { action: 'skip', reason: 'thinking-budget' };
}

/**
 * D — compactação com o cache quente. Só a compactação por limiar (`threshold`) é opcional;
 * `manual` e `overflow` passam sempre. Adia enquanto: o cache está quente, há folga até o
 * limite duro (janela − max(64k, 10%)) e o adiamento ainda compensa. Compactar com o cache
 * frio troca uma reescrita w×L por L (resumo) + w×S; cada turno adiado lê (L−S) a mais a 0,1×.
 * Logo, adiar compensa por até ⌊((w−1)L − wS) / (0,1(L−S))⌋ turnos (S ≈ 15% de L).
 */
export function compactionDecision({ reason, warm, tokens, contextWindow, ttlSeconds = 3600, deferredTurns = 0 }) {
  if (reason !== 'threshold') return { action: 'allow', cause: reason === 'overflow' ? 'overflow' : 'manual' };
  if (!warm) return { action: 'allow', cause: 'cold' };
  if (!(tokens > 0) || !(contextWindow > 0)) return { action: 'allow', cause: 'unknown-usage' };
  const hard = contextWindow - Math.max(64_000, Math.floor(contextWindow * 0.1));
  if (tokens >= hard) return { action: 'allow', cause: 'hard-limit' };
  const w = ttlSeconds >= 3600 ? 2 : 1.25;
  const S = 0.15 * tokens;
  const maxTurns = Math.max(0, Math.floor(((w - 1) * tokens - w * S) / (0.1 * (tokens - S))));
  if (deferredTurns >= maxTurns) return { action: 'allow', cause: 'defer-budget' };
  return { action: 'defer', cause: 'warm', maxTurns, hardLimit: hard };
}

/**
 * I — compactação ociosa (idle compaction do Claude Code: conversa ≥200K tokens parada ~54 min é
 * compactada antes do cache de 1 h vencer; `idleCompaction: false` desliga e
 * CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS ajusta o mínimo, com piso de 100K). No Agent o keeper aquece o
 * prefixo por uma janela; o resumo sai quando o cache vai esfriar de vez (janela fechada, refresh
 * pulado ou sem acerto). Na volta, o turno escreve o resumo S no cache em vez do contexto L inteiro.
 * Nunca antes de `floorS` parado: quem volta logo não perde o histórico literal.
 */
export const IDLE_COMPACT_DEFAULT_MIN_TOKENS = 200_000;
export const IDLE_COMPACT_FLOOR_TOKENS = 100_000;
export const IDLE_COMPACT_FLOOR_S = 3240; // 90% de 1 h, o mesmo ponto do Claude Code

/** Mínimo de tokens a partir de AGENT_IDLE_COMPACT_MIN_TOKENS ("150000", "150k", "1M"); piso 100K. */
export function idleCompactMinTokens(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return IDLE_COMPACT_DEFAULT_MIN_TOKENS;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(raw));
  if (!m) return IDLE_COMPACT_DEFAULT_MIN_TOKENS;
  const unit = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Math.max(IDLE_COMPACT_FLOOR_TOKENS, Math.round(Number(m[1]) * unit));
}

/** Instante (ms) da compactação ociosa: quando o cache esfria, mas nunca antes de `floorS` parado. */
export function idleCompactionAt({ coldAt, idleSince, floorS = IDLE_COMPACT_FLOOR_S }) {
  return Math.max(coldAt, idleSince + floorS * 1000);
}

/**
 * Decide no disparo. `ctx.compact()` aborta o que estiver rodando, então só compacta com o agente
 * ocioso, sem fila e com o editor vazio (texto no editor = a pessoa voltou e vai mandar algo).
 */
export function idleCompactionDecision({ enabled = true, tokens = 0, minTokens = IDLE_COMPACT_DEFAULT_MIN_TOKENS, idle = false, pending = false, editorText = '' }) {
  if (!enabled) return { action: 'skip', reason: 'disabled' };
  if (!idle || pending) return { action: 'skip', reason: 'busy' };
  if (String(editorText ?? '').trim()) return { action: 'skip', reason: 'typing' };
  if (!(tokens >= minTokens)) return { action: 'skip', reason: 'small' };
  return { action: 'compact' };
}

/**
 * Conexão local por SessionManager (o Pi cria um ctx novo a cada dispatch).
 * session_start instala uma conexão nova; shutdown a remove por identidade, para
 * um runtime antigo não retirar a conexão de um reload. Nenhum payload é guardado aqui.
 * @typedef {{ cacheState: () => {warm?: boolean, warmUntil?: number, ttlSeconds?: number},
 * deferCompaction: (event: object, ctx: any) => boolean, idleCompacting?: () => boolean }} SessionCachePolicy
 */
const sessionPolicies = new WeakMap();

/** @param {{sessionManager?: object}} ctx @param {SessionCachePolicy} policy */
export function bindSessionCachePolicy(ctx, policy) {
  const manager = ctx?.sessionManager;
  if (!manager) throw new Error('cache policy requires a sessionManager');
  sessionPolicies.set(manager, policy);
  return () => { if (sessionPolicies.get(manager) === policy) sessionPolicies.delete(manager); };
}

/** @param {{sessionManager?: object}} ctx @returns {SessionCachePolicy | undefined} */
export function sessionCachePolicy(ctx) {
  return ctx?.sessionManager ? sessionPolicies.get(ctx.sessionManager) : undefined;
}

/** Um objeto de evento por tentativa automática. ctx.compact() depois chega como manual. */
export function allowAutoCompaction(ctx) {
  return sessionCachePolicy(ctx)?.deferCompaction({ reason: 'threshold', source: 'agent.auto' }, ctx) !== true;
}

/**
 * E — prefetch do próximo papel: o runner lança o filho do papel seguinte com
 * AGENT_CACHE_PREFETCH=1 e tarefa ".". O 1º request desse filho vira um aquecimento: corpo do
 * próprio Pi (tools + system idênticos ao filho real), max_tokens 1 e sem `thinking` (thinking
 * só invalida o cache das MENSAGENS; tools/system continuam). Devolve o payload a enviar, ou
 * undefined se não for Messages API da Anthropic com cache_control (aí o filho segue normal e
 * o runner deve cancelar). Não grava nada.
 */
export function prefetchPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages) || !('system' in payload)) return undefined;
  const marked = [...(Array.isArray(payload.system) ? payload.system : []), ...(payload.tools ?? [])].some((b) => b?.cache_control);
  if (!marked) return undefined;
  const { thinking, ...rest } = payload;
  return { ...rest, max_tokens: 1 };
}

/** Hash FNV-1a 64 em hex (estável, sem depender de crypto no host). */
function fnv64(text) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) { h ^= BigInt(byte); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

/**
 * H — `prompt_cache_key` para OpenAI Responses/Codex. O Pi já manda o sessionId como chave, o
 * que basta na sessão principal. Duas lacunas: (1) chamada sem sessionId sai sem chave;
 * (2) subagentes do mesmo papel compartilham instructions+tools mas cada um tem sessionId
 * próprio, então caem em máquinas diferentes. Nesses casos a chave vira o hash do prefixo
 * estável (instructions + tools): `agent-<16 hex>`, ≤ 64 chars. Devolve undefined para manter.
 * Não promete hit: o roteamento da OpenAI usa chave + prefixo; a medição fica no ledger.
 */
export function openaiCacheKey(payload, { child = false } = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.input)) return undefined;
  if (process.env.PI_CACHE_RETENTION === 'none') return undefined; // cache desligado pelo usuário
  if (payload.prompt_cache_key && !child) return undefined;
  const prefix = JSON.stringify([payload.model ?? '', payload.instructions ?? '', payload.tools ?? []]);
  return `agent-${fnv64(prefix)}`;
}

/**
 * Classifica a causa de uma quebra de cache entre dois requests consecutivos da mesma sessão,
 * sem guardar conteúdo: compara hashes de system/tools/thinking/modelo e o tempo decorrido.
 */
export function fingerprint(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  return {
    model: fnv64(String(payload.model ?? '')),
    system: fnv64(JSON.stringify(payload.system ?? payload.instructions ?? '')),
    tools: fnv64(JSON.stringify(payload.tools ?? [])),
    thinking: fnv64(JSON.stringify(payload.thinking ?? payload.reasoning ?? null)),
    messages: (payload.messages ?? payload.input ?? []).map((m) => fnv64(JSON.stringify(m))),
  };
}
/** First changed segment; message indices are zero-based. Appends do not change the prefix. */
export function firstChangedSegment(prev, next) {
  if (!prev || !next) return { segment: 'none' };
  // Pi appends tools loaded by tool_search, but _rebuildSystemPrompt also changes
  // system. These loads therefore show as 'system'; measure first, align it later.
  for (const segment of ['model', 'system', 'tools', 'thinking']) {
    if (prev[segment] !== next[segment]) return { segment };
  }
  const a = prev.messages ?? [], b = next.messages ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return { segment: 'message', index };
  }
  return { segment: 'none' };
}
export function breakCause(prev, next, { elapsedS = 0, ttlSeconds = 300 } = {}) {
  if (!prev || !next) return 'unknown';
  if (prev.model !== next.model) return 'model-changed';
  if (prev.system !== next.system) return 'prompt-changed';
  if (prev.tools !== next.tools) return 'tools-changed';
  if (prev.thinking !== next.thinking) return 'thinking-changed';
  if (elapsedS > ttlSeconds) return 'ttl-expired';
  return 'unknown';
}

/**
 * E — leque escalonado: N filhos com o mesmo prefixo. Dispara o 1º; quando ele produz o 1º
 * token efetivo (o provider já processou e escreveu o prefixo), libera os demais, que leem o
 * cache em vez de escrever N vezes. Falha/cancelamento/timeout do 1º libera os outros mesmo
 * assim (nunca trava o leque). `maxConcurrent` limita a capacidade.
 * `start(task, i)` → { firstToken: Promise, done: Promise }.
 */
export async function staggeredFanout(tasks, start, { firstTokenTimeoutMs = 30_000, maxConcurrent = Infinity, signal } = {}) {
  if (!tasks.length) return { gate: 'empty', results: [] };
  if (signal?.aborted) return { gate: 'aborted', results: [] };
  const results = new Array(tasks.length);
  const run = (i) => {
    const handle = start(tasks[i], i);
    results[i] = Promise.resolve(handle.done).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
    return handle;
  };
  const leader = run(0);
  let timer;
  const gate = await Promise.race([
    Promise.resolve(leader.firstToken).then(() => 'first-token', () => 'leader-failed'),
    Promise.resolve(leader.done).then(() => 'leader-done', () => 'leader-failed'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), firstTokenTimeoutMs); timer.unref?.(); }),
    new Promise((resolve) => signal?.addEventListener('abort', () => resolve('aborted'), { once: true })), // em voo: não dispara o resto
  ]);
  clearTimeout(timer);
  if (gate === 'aborted') return { gate, results: await Promise.all(results.filter(Boolean)) };
  // Capacidade: no máximo maxConcurrent em voo, contando o líder.
  let next = 1;
  const inflight = new Set([results[0]]);
  while (next < tasks.length) {
    if (signal?.aborted) break;
    if (inflight.size >= maxConcurrent) { await Promise.race(inflight); for (const p of [...inflight]) if (await isSettled(p)) inflight.delete(p); continue; }
    run(next);
    inflight.add(results[next]);
    next += 1;
  }
  return { gate, results: await Promise.all(results.filter(Boolean)) };
}
async function isSettled(p) {
  const marker = Symbol('pending');
  return (await Promise.race([p, Promise.resolve(marker)])) !== marker;
}
