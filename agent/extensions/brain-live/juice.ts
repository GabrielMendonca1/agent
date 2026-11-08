/**
 * Modo do Mark: `simple` ⇄ `complex`.
 *
 *   simple   → orquestrador sozinho, `subagent` bloqueado na chamada.
 *   complex  → equipe pela receita do projeto, `subagent` liberado.
 *
 * Modelo e thinking do principal são escolha MANUAL do humano (`/model`, `/thinking`,
 * `/models`) e persistem: o modo NÃO mexe em nenhum dos dois. Trocar de modo (ou de
 * modelo) nunca reescreve o nível de raciocínio escolhido.
 *
 * Políticas globais no system prompt: autonomia nos dois modos; complex só
 * em complex. A lista de tools não muda; simple bloqueia subagent na chamada.
 *
 * Shift+Tab alterna. `/mode [simple|complex]` também. O agente nunca vê limite
 * de token: o ledger JSON só mede custo, disponível ao humano em /cost.
 * Compactação: ~450k em janelas de 1M; faltando 10% nas menores.
 * Receita do projeto: `.mark/workflow.md` (criada em repositórios git) é interna —
 * o modelo principal NÃO a vê (nem no prompt, nem em nota): ela só alimenta os slots
 * de modelo por papel do `subagent` e o aprendizado.
 * Aprender do trabalho real: run com checks verdes → o modelo de apoio escreve
 * 0–3 regras na receita (centavos). Nunca o modelo principal; nunca em filhos.
 */
import { modeStatus } from '../mark/tui/status-line';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { markStatus, shortModel, type ModeFooterState, type TeamStatus } from '../../juice/panel.ts';
import { getJuicePreferences, juiceEnabled } from '../../juice/client.mjs';
import { ensureWorkflow, parseWorkflow, readWorkflow } from '../../juice/workflow.mjs';
import { categoryPrompt } from '../../juice/skill-categories.mjs';
import { companySkillDirs } from '../../juice/companies.mjs';
import { appendPolicy, policySections, POLICY_SECTIONS, notesSection } from '../../juice/policy.mjs';
import { readNotesMetadata, unmappedDocs } from '../../juice/notes.mjs';
import { applyLearned, digestRun, hadGreenChecks, lastRunMessages, learnPrompt, parseRules } from '../../juice/learn.mjs';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureSessionMode, saveSessionMode } from './lib/session-mode.mjs';
import { allowAutoCompaction } from '../../juice/cache-policy.mjs';
import type { JuiceMode } from '../../juice/protocol.d.ts';

/**
 * O modo também vai como nota curta na conversa (só no primeiro run e quando muda).
 * As políticas globais — autonomia sempre, complex só em complex — vão no system
 * prompt de verdade; ver policy.mjs.
 */
export function modeNote(mode: JuiceMode): string {
  return mode === 'complex'
    ? 'Modo do Mark agora: complex — trabalhe com a equipe (`subagent`); a política de complex está no system prompt.'
    : 'Modo do Mark agora: simple — trabalhe sozinho; sem política de complex no system prompt e com `subagent` bloqueado.';
}
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

export function shouldInjectHandoff({ messageType, firstRun, mtime, now }: {
  messageType?: string; firstRun: boolean; mtime: number; now: number;
}): boolean {
  return (messageType === undefined || messageType === 'user') && firstRun
    && now >= mtime && now - mtime < 10 * 60_000;
}

/**
 * Active tool list: the team tool stays active in BOTH modes when registered.
 * Changing the tool list rewrites the request head and zeroes the cache (classic
 * main collapses tool changes to the top); simple blocks `subagent` at call time.
 */
export function activeToolsFor(_mode: JuiceMode, active: string[], all: string[]): string[] {
  const required = [TEAM_TOOL, 'codemode', 'tool_search'].filter(name => all.includes(name) && !active.includes(name));
  return required.length ? [...active, ...required] : active;
}

/** Why a tool call is refused under the current mode, or null. */
export function refusal(tool: string, mode: JuiceMode): string | null {
  if (tool === TEAM_TOOL && mode === 'simple') return 'Modo simple: `subagent` indisponível. Trabalhe sozinho ou peça ao Gabriel para trocar para complex (Shift+Tab).';
  return null;
}

export function learnEligible(support: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARK_JUICE_CHILD !== '1' && env.MARK_LEARN === '1' && !!support;
}

export default function (pi: ExtensionAPI) {
  // Mark II desligado = sem hooks; com ele, activeToolsFor liga subagent e codemode no session_start.
  if (!juiceEnabled()) return;
  let statusContext: ExtensionContext | undefined;
  let state: ModeFooterState = { mode: 'simple', model: '—', usd: null, sessionUsd: 0, team: [] };
  let notedMode: JuiceMode | null = null;
  // Rodapé e execução usam learnEligible: aprendizado só com MARK_LEARN=1.
  let projectNotes = ''; // Snapshot só no session_start; nunca reler por turno.

  // /next is isolated from policy/notes injection: switching the host
  // unloads this extension, so nothing is sent after newSession.
  let firstHandoffRun = true;
  let nextRunning = false;
  let handoffFinished: (() => void) | undefined;
  pi.on('agent_end', async () => { handoffFinished?.(); });
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType !== undefined && event.messageType !== 'user') return;
    const firstRun = firstHandoffRun;
    firstHandoffRun = false;
    const file = join(ctx.cwd, '.mark/handoff.md');
    try {
      if (!shouldInjectHandoff({ messageType: event.messageType, firstRun, mtime: Math.floor(statSync(file).mtimeMs), now: Date.now() })) return;
      const content = readFileSync(file, 'utf8');
      renameSync(file, join(ctx.cwd, '.mark/handoff.consumed.md'));
      return { message: { customType: 'mark-handoff', content, display: false } };
    } catch { /* absent/unreadable handoff must not block a normal run */ }
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
        const file = join(ctx.cwd, '.mark/handoff.md');
        const previous = existsSync(file) ? { mtime: statSync(file).mtimeMs, content: readFileSync(file, 'utf8') } : null;
        // Subscribe before sending: waitForIdle alone can race with run startup.
        const finished = new Promise<void>(resolve => { handoffFinished = resolve; });
        pi.sendUserMessage(`/skill:handoff${focus ? ` ${focus}` : ''}`);
        await finished;
        await ctx.waitForIdle();
        const mtime = statSync(file).mtimeMs;
        if ((previous && previous.mtime === mtime && previous.content === readFileSync(file, 'utf8'))
          || !shouldInjectHandoff({ firstRun: true, mtime: Math.floor(mtime), now: Date.now() })) {
          throw new Error('Handoff não foi atualizado; sessão mantida.');
        }
        if (keep) { ctx.compact(); return; }
        const parentSession = ctx.sessionManager.getSessionFile();
        await ctx.newSession({
          parentSession,
          setup: async manager => { manager.appendCustomEntry('mark-next', { parentSession }); },
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        handoffFinished = undefined;
        nextRunning = false;
      }
    },
  });

  // Compatibility readers remain read-only; native footer receives mode and /next hint.
  let snapshot: ModeFooterState | undefined;
  const render = () => {
    snapshot = undefined;
    if (statusContext?.mode === 'tui') {
      statusContext.ui.setStatus('mark-mode', modeStatus(state.mode));
      statusContext.ui.setStatus('mark-next', state.nextHint ? '/next encerra a tarefa' : undefined);
    }
  };
  (globalThis as any)[Symbol.for('mark.footer.line')] = (theme: Pick<Theme, 'fg'>) => markStatus(theme, observed());
  // Leitores de compatibilidade: não são fonte do rodapé nativo nem autoridade de modo.
  (globalThis as any)[Symbol.for('mark.state')] = () => (snapshot ??= observed());
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
    let support: string | null | undefined;
    try { support = getJuicePreferences().supportModel; } catch { support = undefined; }
    return {
      ...state,
      host: 'clássico',
      support,
      ttl: process.env.PI_CACHE_RETENTION === 'long' ? '1h' : '5m',
      learn: support === undefined ? undefined : learnEligible(support),
      deferred,
      prefetch: process.env.MARK_CACHE_PREFETCH_NEXT === '1',
    };
  };
  function refresh(ctx?: ExtensionContext) {
    const model = shortModel(ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined) || state.model;
    state = { ...state, model };
    render();
  }
  // Só modo + lista de tools. Thinking e modelo são do humano (ver nota no topo): o modo
  // não os reescreve, nem aqui nem em model_select/before_agent_start.
  function applyMode(mode: JuiceMode) {
    state = { ...state, mode };
    try {
      pi.setActiveTools(activeToolsFor(mode, pi.getActiveTools(), pi.getAllTools().map(t => t.name)));
    } catch { /* tools not registered yet; before_agent_start re-applies */ }
    render();
  }
  function setMode(mode: JuiceMode, ctx: ExtensionContext) {
    try {
      if (process.env.MARK_JUICE_CHILD === '1') throw new Error('Juice children cannot change mode');
      saveSessionMode(pi, ctx, mode);
      const saved = ensureSessionMode(pi, ctx);
      if (saved !== mode) throw new Error('Mark: não foi possível salvar o modo da sessão.');
      applyMode(saved);
      refresh(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }
  function dispose() {
    statusContext?.ui.setStatus('mark-mode', undefined);
    statusContext?.ui.setStatus('mark-next', undefined);
    statusContext = undefined;
  }

  pi.on('session_start', async (_event, ctx) => {
    dispose();
    statusContext = ctx;
    // Estado da sessão zera; o ledger cumulativo permanece separado em /cost.
    state = { ...state, team: [], cacheHit: undefined, sessionUsd: 0, nextHint: false };
    firstHandoffRun = true;
    compacting = false;
    notedMode = null;
    projectNotes = notesSection(readNotesMetadata(ctx.cwd));
    try { ensureWorkflow(ctx.cwd); } catch { /* read-only checkout: the prompt just omits the recipe */ }
    applyMode(ensureSessionMode(pi, ctx));
    refresh(ctx);
  });
  pi.on('session_shutdown', async () => { dispose(); });
  // Skills de empresa (mark/company-skills/<empresa>): só para quem tem o enrollment.
  pi.on('resources_discover', async () => {
    const skillPaths = companySkillDirs();
    return skillPaths.length ? { skillPaths } : undefined;
  });
  pi.on('session_tree', async (_event, ctx) => {
    notedMode = null;
    applyMode(ensureSessionMode(pi, ctx));
    refresh(ctx);
  });
  pi.on('model_select', async (_event, ctx) => { applyMode(ensureSessionMode(pi, ctx)); refresh(ctx); });
  // Tools register in extension order; re-apply right before each run so the
  // schema stays stable; simple blocks `subagent` at call time.
  pi.on('before_agent_start', async (event, ctx) => {
    applyMode(ensureSessionMode(pi, ctx));
    const notes = [
      notedMode === state.mode ? '' : modeNote(state.mode),
    ].filter(Boolean);
    notedMode = state.mode;
    const message = () => notes.length ? { customType: 'mark-mode', content: notes.join('\n\n'), display: false } : undefined;
    const result = (systemPrompt: string | null) => {
      const msg = message();
      if (systemPrompt === null && !msg) return undefined;
      return { ...(systemPrompt === null ? {} : { systemPrompt }), ...(msg ? { message: msg } : {}) };
    };
    // Políticas GLOBAIS no system prompt do principal: autonomia nos dois modos,
    // complex só em complex. Vão por seção (host clássico monta o prompt a partir delas
    // e remove a que sai) e, quando o prompt JÁ está forçado por outro handler ou pelo
    // outro handler, anexadas ao texto forçado. As duas vias não se somam: quando este
    // handler roda antes do vault-runtime o prompt ainda não está forçado (só seções, que
    // o vault renderiza); quando roda depois, o texto forçado não tem as seções.
    const opts = event.systemPromptOptions;
    const policy: JuiceMode | null = process.env.MARK_JUICE_CHILD === '1' ? null : state.mode;
    if (policy && opts) {
      opts.sections ??= {};
      const sections: Record<string, string | undefined> = { ...policySections(policy), mark_skill_categories: categoryPrompt() };
      opts.sections.mark_skill_categories = sections.mark_skill_categories!;
      for (const name of POLICY_SECTIONS) {
        if (sections[name]) opts.sections[name] = sections[name]!;
        else delete opts.sections[name];
      }
    }
    // Mesmo snapshot na seção estruturada e no prompt forçado por outra extensão.
    if (policy && opts) {
      if (projectNotes) opts.sections!.mark_notes = projectNotes.slice('<mark_notes>'.length, -'</mark_notes>'.length);
      else delete opts.sections!.mark_notes;
    }
    const forced = typeof opts?.forceSystemPrompt === 'string' ? opts.forceSystemPrompt : null;
    const withPolicy = policy && forced !== null
      ? `${appendPolicy(forced, policy)}\n\n<mark_skill_categories>\n${categoryPrompt()}\n</mark_skill_categories>${projectNotes ? `\n\n${projectNotes}` : ''}`
      : null;
    return result(withPolicy);
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
    try { await learnFromRun(ctx); } catch { /* aprender é best-effort; nunca atrapalha a sessão */ }
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
    compacting = true;
    const done = () => { compacting = false; };
    try { ctx.compact({ onComplete: done, onError: done }); } catch { done(); }
  }
  pi.on('session_compact', async () => { compacting = false; });
  pi.on('session_compact_failed', async () => { compacting = false; });

  function projectCheckCmds(cwd: string): string[] {
    try {
      const file = join(cwd, '.pi/checks.json');
      if (!existsSync(file)) return [];
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed?.checks) ? parsed.checks.map((c: any) => String(c.cmd || '')).filter(Boolean) : [];
    } catch { return []; }
  }
  async function learnFromRun(ctx: ExtensionContext) {
    const prefs = getJuicePreferences();
    const supportId = prefs.supportModel;
    if (!supportId || !learnEligible(supportId)) return;
    const text = readWorkflow(ctx.cwd);
    if (text === null) return;
    const messages = lastRunMessages(ctx.sessionManager.getBranch() as any[]);
    if (!messages.length || !hadGreenChecks(messages, projectCheckCmds(ctx.cwd))) return;
    const [provider, ...rest] = supportId.split('/');
    const model = ctx.modelRegistry.find(provider, rest.join('/'));
    if (!model) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let answer = '';
    try {
      // streamSimple sem `reasoning` = thinking desligado: resposta de 3 linhas,
      // o teto não some em pensamento (complete() herda thinking do modelo).
      const response = await ctx.modelRegistry.streamSimple(
        model,
        { messages: [{ role: 'user', content: [{ type: 'text', text: learnPrompt(digestRun(messages), parseWorkflow(text).rules, basename(ctx.cwd)) }], timestamp: Date.now() }] } as any,
        { maxTokens: 600, signal: controller.signal, cacheRetention: 'none' } as any,
      ).result();
      // Só resposta completa: um stream abortado/cortado deixaria regra truncada na receita.
      if (response.stopReason === 'stop') answer = (response.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    } finally { clearTimeout(timer); }
    const rules = parseRules(answer);
    if (!rules.length) return;
    const merged = applyLearned(ctx.cwd, rules, { by: supportId, mode: state.mode, proven: 'no' });
    if (!merged) return;
    pi.events.emit('mark:workflow-changed', { cwd: ctx.cwd, version: merged.version, added: merged.added });
    if (ctx.hasUI) ctx.ui.notify(`receita ${merged.version}: ${merged.added.length} regra(s) aprendida(s)`, 'info');
  }
  // Team state from the subagent extension.
  pi.events.on('mark:team', (data: { agents?: string[]; status?: TeamStatus }) => {
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

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== TEAM_TOOL) return;
    try {
      const mode = ensureSessionMode(pi, ctx);
      applyMode(mode);
      const reason = refusal(event.toolName, mode);
      return reason ? { block: true, reason } : undefined;
    } catch (error) {
      return { block: true, reason: `Mark: dispatch bloqueado: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  pi.registerShortcut('shift+tab', {
    description: 'Mark: simple ⇄ complex',
    handler: async (ctx) => setMode(ensureSessionMode(pi, ctx) === 'simple' ? 'complex' : 'simple', ctx),
  });
  // Independente dos comandos de modo: /notes só pede manutenção do mapa ao agente.
  pi.registerCommand('notes', {
    description: 'Mark: acrescentar ao mapa os documentos ainda sem nota',
    handler: async (_args, ctx) => {
      let files: string[];
      try { files = unmappedDocs(ctx.cwd); } catch (error) {
        ctx.ui.notify(`Não foi possível listar notas: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return;
      }
      if (!files.length) { ctx.ui.notify('Nenhum documento sem linha em .mark/notes.md.', 'info'); return; }
      pi.sendUserMessage([
        'Atualize .mark/notes.md neste projeto (crie o mapa se não existir).',
        'Leia os documentos abaixo e acrescente uma linha por arquivo no formato caminho — assunto; preserve as linhas existentes e não duplique caminhos.',
        'Documentos sem linha no mapa:',
        ...files.map(file => `- ${file}`),
      ].join('\n'), { deliverAs: 'followUp' });
    },
  });
  pi.registerCommand('mode', {
    description: 'Mark: simple | complex (Shift+Tab alterna)',
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === 'simple' || arg === 'complex') return setMode(arg, ctx);
      if (arg) return ctx.ui.notify('Use /mode simple ou /mode complex', 'error');
      setMode(ensureSessionMode(pi, ctx) === 'simple' ? 'complex' : 'simple', ctx);
    },
  });
  // The pilot does not authorize non-chat auxiliary APIs.
  pi.on('cache_warming_decision', async () => ({ action: 'stop' as const }));
}
