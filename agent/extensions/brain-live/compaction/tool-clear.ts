/** Local, branch-scoped tool-result projection. Originals remain in the session journal. */
import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sessionCachePolicy } from '../../../core/cache-policy.mjs';

const BATCH = 'agent-tool-clear';
const REQUEST = 'agent-tool-clear-request';
const allowed = new Set(['bash', 'read', 'grep', 'find', 'ls', 'codemode', 'skim', 'web_fetch']);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const limit = (key: string, fallback: number) => {
  const n = Number(process.env[key]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
type Replacement = { toolCallId: string; sourceHash: string; text: string };
type Batch = { version: 1; replacements: Replacement[]; estimatedTokensSaved: number };
// Pi loads each extension through its own jiti instance. Share only manager-keyed
// controllers, like the cache-policy connection; never a process-wide session state.
const controllerKey = Symbol.for('agent.tool-clear.controllers');
const shared = globalThis as any;
const controllers: WeakMap<object, ReturnType<typeof installToolClear>> = shared[controllerKey] ??= new WeakMap();
const branch = (ctx: ExtensionContext): any[] => ctx.sessionManager.getBranch();
const modelKey = (ctx: ExtensionContext) => `${ctx.model?.provider}/${ctx.model?.id}`;

export function replayToolClears(messages: any[], entries: any[]): any[] {
  const saved = new Map<string, Replacement>();
  for (const e of entries) if (e.type === 'custom' && e.customType === BATCH && e.data?.version === 1) {
    for (const r of e.data.replacements) saved.set(`${r.toolCallId}:${r.sourceHash}`, r);
  }
  return messages.map(m => {
    if (m.role !== 'toolResult') return m;
    const r = saved.get(`${m.toolCallId}:${hash(m)}`);
    return r ? { ...m, content: [{ type: 'text', text: r.text }] } : m;
  });
}

/** Savings not yet reflected in a provider usage response. */
export function pendingToolClearSavings(ctx: ExtensionContext): number {
  let pending = 0;
  for (const e of branch(ctx)) {
    if (e.type === 'message' && e.message.role === 'assistant' && e.message.usage && !['error', 'aborted'].includes(e.message.stopReason)) pending = 0;
    if (e.type === 'custom' && e.customType === BATCH) pending += e.data?.estimatedTokensSaved ?? 0;
    if (e.type === 'compaction') pending = 0;
  }
  return pending;
}

export function clearBeforeAutoCompaction(ctx: ExtensionContext, threshold: number): boolean {
  const controller = controllers.get(ctx.sessionManager);
  if (!controller) return false;
  controller.clear(ctx, true);
  const tokens = ctx.getContextUsage()?.tokens;
  return typeof tokens === 'number' && pendingToolClearSavings(ctx) > 0 && tokens - pendingToolClearSavings(ctx) <= threshold;
}

/** Keeper refreshes bypass before_provider_request; persist their clock too. */
export function recordToolClearRequest(pi: ExtensionAPI, ctx: ExtensionContext, ttl: number) {
  if (!controllers.has(ctx.sessionManager)) return;
  pi.appendEntry(REQUEST, { version: 1, at: Date.now(), model: modelKey(ctx), ttl });
}

export function installToolClear(pi: ExtensionAPI) {
  const child = process.env.AGENT_CHILD === '1';
  const clear = (ctx: ExtensionContext, automatic = false, input?: any[]) => {
    if (child || process.env.AGENT_TOOL_CLEAR === '0') return;
    const entries = branch(ctx);
    const request = entries.filter(e => e.type === 'custom' && e.customType === REQUEST).at(-1)?.data;
    const cache = sessionCachePolicy(ctx)?.cacheState();
    const changedModel = request && request.model !== modelKey(ctx);
    const expired = request && Date.now() - request.at > request.ttl * 1000;
    // Keeper refreshes take precedence over our request clock. Unknown is not cold.
    if (!automatic && !changedModel && cache?.warm !== false && !(cache?.warm !== true && expired)) return;
    const tokens = ctx.getContextUsage()?.tokens;
    if (typeof tokens !== 'number' || tokens - pendingToolClearSavings(ctx) < limit('AGENT_TOOL_CLEAR_MIN_TOKENS', 150_000)) return;
    const compact = entries.filter(e => e.type === 'compaction').at(-1);
    const start = compact ? entries.findIndex(e => e.id === compact.firstKeptEntryId) : 0;
    // Only the retained projection can save tokens after compaction.
    const raw = input ?? entries.slice(Math.max(0, start)).filter(e => e.type === 'message').map(e => e.message);
    const messages = replayToolClears(raw, entries);
    const turns = messages.filter(m => m.role === 'user').length;
    const keep = limit('AGENT_TOOL_CLEAR_KEEP_TURNS', 3);
    let turn = 0;
    const calls = new Map();
    const replacements: Replacement[] = [];
    let savings = 0;
    for (const m of messages) {
      if (m.role === 'user') turn++;
      if (m.role === 'assistant') for (const c of m.content ?? []) if (c.type === 'toolCall') calls.set(c.id, c);
      if (turn === 0 || turn > turns - keep || m.role !== 'toolResult' || !allowed.has(m.toolName)) continue;
      const call = calls.get(m.toolCallId);
      if (!call || call.name !== m.toolName || !Array.isArray(m.content) || !m.content.length || m.content.some((c: any) => c.type !== 'text')) continue;
      if (m.content.some((c: any) => c.text.startsWith('[old result removed:') || c.text.startsWith('[resultado antigo removido:'))) continue;
      const size = m.content.reduce((n: number, c: any) => n + c.text.length, 0);
      const args = JSON.stringify(call.arguments ?? {}).replace(/\s+/g, ' ').slice(0, 160);
      const text = `[old result removed: ${m.toolName} ${args}; ${size} chars; run it again if needed]`;
      const saved = Math.floor((size - text.length) / 4);
      if (saved <= 0) continue;
      replacements.push({ toolCallId: m.toolCallId, sourceHash: hash(m), text });
      savings += saved;
    }
    if (savings < limit('AGENT_TOOL_CLEAR_MIN_SAVINGS', 40_000)) return;
    const batch: Batch = { version: 1, replacements, estimatedTokensSaved: savings };
    // Write ahead. Never emit a projection that cannot be replayed from the active branch.
    pi.appendEntry(BATCH, batch);
  };
  const controller = { clear };
  if (!child) {
    pi.on('session_start', (_e, ctx) => { controllers.set(ctx.sessionManager, controller); });
    pi.on('session_shutdown', (_e, ctx) => {
      if (controllers.get(ctx.sessionManager) === controller) controllers.delete(ctx.sessionManager);
    });
    pi.on('context', (event, ctx) => {
      clear(ctx, false, event.messages);
      return { messages: replayToolClears(event.messages, branch(ctx)) };
    });
    pi.on('before_provider_request', (_event, ctx) => {
      recordToolClearRequest(pi, ctx, process.env.PI_CACHE_RETENTION === 'long' ? 3600 : 300);
    });
  }
  return controller;
}
