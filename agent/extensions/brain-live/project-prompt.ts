import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { agentStatus, shortModel, type ModeFooterState, type TeamStatus } from '../../core/panel.ts';
import { runtimeEnabled, isChild } from '../../core/client.mjs';
import { categoryPrompt } from '../../core/skill-categories.mjs';
import { companySkillDirs } from '../../core/companies.mjs';
import { appendPolicy, policySections, POLICY_SECTIONS, notesSection } from '../../core/policy.mjs';
import { readNotesMetadata, unmappedDocs } from '../../core/notes.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { allowAutoCompaction } from '../../core/cache-policy.mjs';
import { installProjectContext } from './lib/project-context.ts';
import { clearBeforeAutoCompaction } from './compaction/tool-clear.ts';
import { consumeHandoff, handoffMessage, handoffNotice, handoffPath, isHandoffPath, readHandoff, stampHandoff } from './lib/handoff.ts';

const COMPACT_AT_1M = 450_000;
const TEAM_TOOL = 'subagent';

/** Tokens at which the session compacts, for a given context window. */
export function compactThreshold(contextWindow: number): number {
  return contextWindow >= 1_000_000 ? COMPACT_AT_1M : Math.floor(contextWindow * 0.9);
}

/** /next is a task-boundary suggestion, not an automatic session switch. */
export function nextHint(tokens: number | null | undefined): boolean {
  return typeof tokens === 'number' && tokens > 60_000;
}

/** Session opened by /next: its `agent-next` entry asks for the handoff without gates. */
export function openedByNext(ctx: Pick<ExtensionContext, 'sessionManager'>): boolean {
  try {
    return ctx.sessionManager.getBranch().some((entry: any) => entry?.type === 'custom' && entry.customType === 'agent-next' && entry.data?.handoff === true);
  } catch { return false; }
}

/** A session that already has an assistant reply is resumed, not new: its handoff is offered, not injected. */
export function sessionHasHistory(ctx: Pick<ExtensionContext, 'sessionManager'>): boolean {
  try {
    return ctx.sessionManager.getBranch().some((entry: any) => entry?.type === 'message' && entry.message?.role === 'assistant');
  } catch { return false; }
}

/**
 * Keep the tool schema stable; admission is checked at launch.
 * Changing the tool list rewrites the request head and zeroes the cache (classic
 * main collapses tool changes to the top).
 */
export function activeToolsFor(_mode: unknown, active: string[], all: string[]): string[] {
  const required = [TEAM_TOOL, 'codemode', 'tool_search'].filter(name => all.includes(name) && !active.includes(name));
  return required.length ? [...active, ...required] : active;
}

export default function (pi: ExtensionAPI) {
  // Agent desligado = sem hooks; com ele, activeToolsFor liga subagent e codemode no session_start.
  if (!runtimeEnabled()) return;
  let statusContext: ExtensionContext | undefined;
  let state: ModeFooterState = { model: '—', sessionUsd: 0, team: [] };
  let projectNotes = ''; // Snapshot só no session_start; nunca reler por turno.

  // /next is isolated from policy/notes injection: switching the host
  // unloads this extension, so nothing is sent after newSession.
  let firstHandoffRun = true;
  // /handoff asks for delivery with the next user run; the file is consumed only then.
  let handoffRequested = false;
  let nextRunning = false;
  let handoffFinished: (() => void) | undefined;
  pi.on('agent_end', async () => { handoffFinished?.(); });
  // Handoff: first user message of a session. Fresh, same branch and HEAD at or after its commit
  // → injected once; otherwise one visible line points to /handoff (never a silent drop).
  // A session opened by /next and a /handoff request skip the gates. The file is renamed only
  // here, when the message goes out with this run.
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType !== undefined && event.messageType !== 'user') return;
    const requested = handoffRequested;
    const first = firstHandoffRun;
    handoffRequested = false;
    firstHandoffRun = false;
    if (!requested && !first) return;
    try {
      const pending = readHandoff(ctx.cwd, { newSession: !sessionHasHistory(ctx) });
      if (!pending) {
        if (requested) ctx.ui.notify('The requested handoff is gone from .agent/handoff.md; nothing was loaded.', 'warning');
        return;
      }
      const fromNext = first && openedByNext(ctx);
      if (!requested && !fromNext && !pending.decision.inject) {
        ctx.ui.notify(handoffNotice(pending.decision, pending.meta), 'info');
        return;
      }
      // /next wrote it for this session: no stale note. /handoff keeps the note when gates failed.
      const decision = fromNext ? { inject: true as const, ageMs: pending.decision.ageMs } : pending.decision;
      const content = handoffMessage(pending.text, decision, pending.git);
      consumeHandoff(ctx.cwd);
      return { message: { customType: 'agent-handoff', content, display: false } };
    } catch (error) {
      ctx.ui.notify(`Handoff not loaded: ${error instanceof Error ? error.message : String(error)}; use /handoff to try again.`, 'warning');
    }
  });
  // The skill writes only the body; the stamp (session, time, branch, HEAD) comes from here.
  pi.on('tool_result', async (event: any, ctx) => {
    if ((event.toolName !== 'write' && event.toolName !== 'edit') || event.isError || !isHandoffPath(event.input?.path, ctx.cwd)) return;
    try { stampHandoff(ctx.cwd, ctx.sessionManager?.getSessionId?.()); } catch { /* the /next stamp still covers it */ }
  });
  pi.registerCommand('handoff', {
    description: 'Load the pending .agent/handoff.md (old or from another branch) with the next message',
    handler: async (_args, ctx) => {
      try {
        const pending = readHandoff(ctx.cwd, { newSession: !sessionHasHistory(ctx) });
        if (!pending) return ctx.ui.notify('No pending handoff in .agent/handoff.md.', 'info');
        // Delivered and consumed by before_agent_start with the next message; quitting first keeps the file.
        handoffRequested = true;
        ctx.ui.notify(pending.decision.inject ? 'Handoff queued; it goes with the next message.'
          : 'Handoff queued with a note to the model that it may be outdated; it goes with the next message.', 'info');
      } catch (error) {
        ctx.ui.notify(`Could not load the handoff: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
  pi.registerCommand('next', {
    description: 'Encerra a tarefa com handoff e abre sessão nova (--keep compacta aqui)',
    handler: async (args, ctx) => {
      if (nextRunning) return ctx.ui.notify('/next já está em andamento', 'warning');
      if (!ctx.isIdle()) return ctx.ui.notify('Espere o turno terminar para usar /next', 'warning');
      nextRunning = true;
      const keep = /(?:^|\s)--keep(?=\s|$)/.test(args);
      const focus = args.replace(/(?:^|\s)--keep(?=\s|$)/g, ' ').trim();
      try {
        const file = handoffPath(ctx.cwd);
        const previous = existsSync(file) ? { mtime: statSync(file).mtimeMs, content: readFileSync(file, 'utf8') } : null;
        // Subscribe before sending: waitForIdle alone can race with run startup.
        const finished = new Promise<void>(resolve => { handoffFinished = resolve; });
        pi.sendUserMessage(`/skill:handoff${focus ? ` ${focus}` : ''}`);
        await finished;
        await ctx.waitForIdle();
        const mtime = existsSync(file) ? statSync(file).mtimeMs : undefined;
        if (mtime === undefined || (previous && previous.mtime === mtime && previous.content === readFileSync(file, 'utf8'))) {
          throw new Error('Handoff was not updated; session kept.');
        }
        // Covers a handoff written through bash: the new session sees this branch and HEAD.
        stampHandoff(ctx.cwd, ctx.sessionManager?.getSessionId?.());
        if (keep) { ctx.compact(); return; }
        const parentSession = ctx.sessionManager.getSessionFile();
        await ctx.newSession({
          parentSession,
          // `handoff: true`: the first message of the new session injects it past the age/branch gates.
          setup: async manager => { manager.appendCustomEntry('agent-next', { parentSession, handoff: true }); },
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        handoffFinished = undefined;
        nextRunning = false;
      }
    },
  });

  // Compatibility readers remain read-only; native footer receives the /next hint.
  let snapshot: ModeFooterState | undefined;
  const render = () => {
    snapshot = undefined;
    if (statusContext?.mode === 'tui') {
      statusContext.ui.setStatus('agent-next', state.nextHint ? '/next encerra a tarefa' : undefined);
    }
  };
  (globalThis as any)[Symbol.for('agent.footer.line')] = (theme: Pick<Theme, 'fg'>) => agentStatus(theme, observed());
  // Leitores de compatibilidade: não são fonte do rodapé nativo nem autoridade de modo.
  (globalThis as any)[Symbol.for('agent.state')] = () => (snapshot ??= observed());
  // Só estado observável; o que não dá para observar fica undefined → "—".
  const observed = (): ModeFooterState => {
    let deferred: ModeFooterState['deferred'];
    try {
      const all = pi.getAllTools();
      const lazy = all.filter(t => t.exposure === 'deferred').map(t => t.name);
      const hasSearch = all.some(t => t.name === 'tool_search' && t.exposure !== 'hidden');
      const active = new Set(pi.getActiveTools());
      deferred = lazy.length && hasSearch ? { loaded: lazy.filter(n => active.has(n)).length, total: lazy.length } : null;
    } catch { deferred = undefined; }
    return {
      ...state,
      host: 'clássico',
      ttl: process.env.PI_CACHE_RETENTION === 'long' ? '1h' : '5m',
      deferred,
      prefetch: process.env.AGENT_CACHE_PREFETCH_NEXT === '1',
    };
  };
  function refresh(ctx?: ExtensionContext) {
    const model = shortModel(ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined) || state.model;
    state = { ...state, model };
    render();
  }
  // Tool activation never changes the user-selected model or thinking.
  function applyTools() {
    try {
      pi.setActiveTools(activeToolsFor(undefined, pi.getActiveTools(), pi.getAllTools().map(t => t.name)));
    } catch { /* tools not registered yet; before_agent_start re-applies */ }
    render();
  }
  function dispose() {
    statusContext?.ui.setStatus('agent-next', undefined);
    statusContext = undefined;
  }

  pi.on('session_start', async (_event, ctx) => {
    dispose();
    statusContext = ctx;
    // Usage is native session data, never profile accounting.
    state = { ...state, team: [], cacheHit: undefined, sessionUsd: 0, nextHint: false };
    firstHandoffRun = true;
    handoffRequested = false;
    compacting = false;
    projectNotes = notesSection(readNotesMetadata(ctx.cwd));
    applyTools();
    refresh(ctx);
  });
  pi.on('session_shutdown', async () => { dispose(); });
  // Skills de empresa (agent/company-skills/<empresa>): só para quem tem o enrollment.
  pi.on('resources_discover', async () => {
    const skillPaths = companySkillDirs();
    return skillPaths.length ? { skillPaths } : undefined;
  });
  pi.on('session_tree', async (_event, ctx) => {
    applyTools();
    refresh(ctx);
  });
  pi.on('model_select', async (_event, ctx) => { applyTools(); refresh(ctx); });
  // Tools register in extension order; re-apply right before each run so the
  // schema stays stable; subagents are always available to the main session.
  pi.on('before_agent_start', async (event, ctx) => {
    applyTools();
    const opts = event.systemPromptOptions;
    const policy = !isChild();
    if (policy && opts) {
      opts.sections ??= {};
      const sections: Record<string, string | undefined> = { ...policySections(), agent_skill_categories: categoryPrompt() };
      opts.sections.agent_skill_categories = sections.agent_skill_categories!;
      for (const name of POLICY_SECTIONS) {
        if (sections[name]) opts.sections[name] = sections[name]!;
        else delete opts.sections[name];
      }
    }
    // Mesmo snapshot na seção estruturada e no prompt forçado por outra extensão.
    if (policy && opts) {
      if (projectNotes) opts.sections!.agent_notes = projectNotes.slice('<agent_notes>'.length, -'</agent_notes>'.length);
      else delete opts.sections!.agent_notes;
    }
    const forced = typeof opts?.forceSystemPrompt === 'string' ? opts.forceSystemPrompt : null;
    const withPolicy = policy && forced !== null
      ? `${appendPolicy(forced)}\n\n<agent_skill_categories>\n${categoryPrompt()}\n</agent_skill_categories>${projectNotes ? `\n\n${projectNotes}` : ''}`
      : null;
    return withPolicy === null ? undefined : { systemPrompt: withPolicy };
  });
  pi.on('message_end', async (event: any, ctx) => {
    const u = event?.message?.role === 'assistant' ? event.message.usage : undefined;
    if (u) {
      const total = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      // Equivalente de API da sessão: o provider já devolve o custo desta resposta.
      const spent = typeof u.cost?.total === 'number' ? u.cost.total : 0;
      state = { ...state, cacheHit: total > 0 ? (u.cacheRead ?? 0) / total : null, sessionUsd: (state.sessionUsd ?? 0) + spent };
    }
    refresh(ctx);
  });
  pi.on('tool_result', async (_event, ctx) => refresh(ctx));
  pi.on('input', async (event) => {
    if (!event.text.trim().startsWith('/')) { state = { ...state, team: [] }; render(); }
  });
  pi.on('agent_settled', async (_event, ctx) => {
    state = { ...state, nextHint: nextHint(ctx.getContextUsage()?.tokens) };
    refresh(ctx);
    autoCompact(ctx);
  });
  // Compactação automática por limiar. `ctx.compact()` é a única porta pública e o SDK a
  // registra como reason "manual" (CompactOptions não tem reason), então a decisão de limiar —
  // cache quente adia, limite duro e orçamento de adiamento passam — é tomada AQUI, pelo mesmo
  // gate do cache-keeper. Sem o gate (keeper desligado) o limiar vale por si.
  // Pi clássico conclui o pedido por callback/evento; não inferimos sucesso pelo
  // relógio nem por uma redução de contexto (que também pode vir da poda).
  let compacting = false;
  function autoCompact(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage();
    if (compacting || !usage || !(usage.tokens > compactThreshold(usage.contextWindow))) return;
    if (!allowAutoCompaction(ctx)) return;
    if (clearBeforeAutoCompaction(ctx, compactThreshold(usage.contextWindow))) return;
    compacting = true;
    const done = () => { compacting = false; };
    try { ctx.compact({ onComplete: done, onError: done }); } catch { done(); }
  }
  pi.on('session_compact', async () => { compacting = false; });
  pi.on('session_compact_failed', async () => { compacting = false; });

  // Team state from the subagent extension.
  pi.events.on('agent:team', (data: { agents?: string[]; status?: TeamStatus }) => {
    if (!Array.isArray(data?.agents) || !data.status) return;
    const team = [...state.team];
    for (const agent of data.agents) {
      const i = team.findIndex(t => t.agent === agent);
      if (i >= 0) team[i] = { agent, status: data.status };
      else team.push({ agent, status: data.status });
    }
    state = { ...state, team };
    render();
  });

  // Independente dos comandos de modo: /notes só pede manutenção do mapa ao agente.
  pi.registerCommand('notes', {
    description: 'Agent: add the documents without a note to the map',
    handler: async (_args, ctx) => {
      let files: string[];
      try { files = unmappedDocs(ctx.cwd); } catch (error) {
        ctx.ui.notify(`Could not list notes: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return;
      }
      if (!files.length) { ctx.ui.notify('Every document already has a line in .agent/notes.md.', 'info'); return; }
      // The prompt goes to the model; the TUI shows a short notice.
      pi.sendMessage({ customType: 'agent-notes', display: false, content: [
        'Update .agent/notes.md in this project (create the map if it does not exist).',
        'Read the documents below and add one line per file in the format path — subject; keep existing lines and do not duplicate paths.',
        'Documents without a line in the map:',
        ...files.map(file => `- ${file}`),
      ].join('\n') }, { triggerTurn: true, deliverAs: 'followUp' });
      ctx.ui.notify(`Sent to the agent: map ${files.length} document(s) in .agent/notes.md.`, 'info');
    },
  });
  installProjectContext(pi);
}
