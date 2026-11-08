import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { JuiceMode } from './protocol.d.ts';

export type TeamStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface ModeFooterState {
  mode: JuiceMode;
  /** Short model name of the orchestrator (ex.: fable-5.1). */
  model: string;
  /** Accumulated cost in the ledger (cumulative for the profile). null = unknown. */
  usd: number | null;
  /**
   * Equivalente de API da SESSÃO ATUAL, somando o usage das mensagens assistant
   * (inclui subagentes quando eles reportam no mesmo processo). Zera em
   * session_start. null = sem dado ainda. É isto que a linha acima do input mostra.
   */
  sessionUsd?: number | null;
  /** Team members touched in this session, in first-seen order, with last status. */
  team: Array<{ agent: string; status: TeamStatus }>;
  /** Campos do rodapé unificado (markStatus). undefined = não observado → "—". */
  host?: 'durável' | 'clássico';
  support?: string | null;
  /** Último turno: cacheRead / (input + cacheRead + cacheWrite), 0–1. */
  cacheHit?: number | null;
  ttl?: '5m' | '1h';
  learn?: boolean;
  /** Tools sob demanda: carregadas / total; null = sem tool_search (todas declaradas). */
  deferred?: { loaded: number; total: number } | null;
  prefetch?: boolean;
  nextHint?: boolean;
}

const GLYPH: Record<TeamStatus, string> = { running: '●', completed: '✓', failed: '✗', cancelled: '✗', timeout: '✗' };

/** Pure: no ledger reads, timers or model calls. One line, or nothing on zero width. */
export function footerLine(width: number, theme: Pick<Theme, 'fg'>, state: ModeFooterState): string[] {
  if (width <= 0) return [];
  const dim = (s: string) => theme.fg('dim', s);
  const sep = dim(' · ');
  const mode = theme.fg(state.mode === 'complex' ? 'accent' : 'muted', state.mode);
  const cost = state.usd === null ? dim('US$ —') : dim(`US$ ${state.usd.toFixed(2)}`);
  let line = `${mode}${sep}${dim(state.model)}${sep}${cost}`;
  if (state.mode === 'complex' && state.team.length) {
    const team = state.team.map(({ agent, status }) => {
      const color = status === 'running' ? 'accent' : status === 'completed' ? 'success' : 'error';
      return `${agent} ${theme.fg(color, GLYPH[status])}`;
    }).join('  ');
    line += `   ${team}`;
  }
  if (state.nextHint) line += sep + dim('/next encerra a tarefa');
  return [visibleWidth(line) <= width ? line : truncateToWidth(line, width, '…')];
}

export function shortModel(id: string | undefined): string {
  if (!id) return '—';
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
}

/**
 * Segmentos do Mark para o rodapé unificado (mark/tui/footer.ts linha 2), em ordem de
 * prioridade: o corte por largura come do fim. Só estado observado; o resto vira "—".
 * Consumo = equivalente de API do ledger, não cobrança nem quota.
 */
export function markStatus(theme: Pick<Theme, 'fg'>, state: ModeFooterState): string {
  const dim = (s: string) => theme.fg('dim', s);
  const muted = (s: string) => theme.fg('muted', s);
  const on = (v: boolean | undefined) => v === undefined ? dim('—') : v ? theme.fg('success', 'on') : dim('off');
  const parts: string[] = [];
  parts.push(`${theme.fg(state.mode === 'complex' ? 'accent' : 'muted', state.mode)}`);
  parts.push(muted(state.host ?? '—'));
  parts.push(`${dim('apoio')} ${muted(state.support ? shortModel(state.support) : '—')}`);
  const hit = state.cacheHit === null || state.cacheHit === undefined ? '—' : `${Math.round(state.cacheHit * 100)}%`;
  parts.push(`${dim('cache')} ${muted(hit)}${state.ttl ? dim(` ttl ${state.ttl}`) : ''}`);
  parts.push(`${dim('API≈')}${muted(state.usd === null ? 'US$ —' : `US$ ${state.usd.toFixed(2)}`)}`);
  if (state.team.length) parts.push(state.team.map(({ agent, status }) => {
    const color = status === 'running' ? 'accent' : status === 'completed' ? 'success' : 'error';
    return `${muted(agent)} ${theme.fg(color, GLYPH[status])}`;
  }).join(' '));
  parts.push(`${dim('learn')} ${on(state.learn)}`);
  parts.push(`${dim('sob demanda')} ${state.deferred === undefined ? dim('—') : state.deferred === null ? dim('off') : muted(`${state.deferred.loaded}/${state.deferred.total}`)}`);
  parts.push(`${dim('prefetch')} ${on(state.prefetch)}`);
  if (state.nextHint) parts.push(dim('/next encerra a tarefa'));
  return parts.join(dim(' · '));
}
