/**
 * `.agent/handoff.md`: the handoff skill writes the body; this module stamps the frontmatter
 * (session, created_at, branch, head) and decides whether a new session receives it.
 *
 * Injected on the first user message of a new session when it is not consumed, on the same
 * branch, HEAD equals or descends from `head`, and younger than AGENT_HANDOFF_MAX_AGE (24 h).
 * Without git only the age counts. Anything else yields one visible notice; nothing is dropped
 * silently. The wrapper and the notices are English.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const HANDOFF_FILE = '.agent/handoff.md';
export const HANDOFF_CONSUMED = '.agent/handoff.consumed.md';
const HOUR = 3600_000;

export interface HandoffMeta { session?: string; created_at?: string; branch?: string; head?: string }
export interface GitState {
  branch: string;
  /** Empty on an unborn branch (repository without commits). */
  head: string;
  /** The commit exists in this repository. */
  exists(sha: string): boolean;
  /** `git merge-base --is-ancestor <sha> HEAD`. */
  isAncestor(sha: string): boolean;
}
export type HandoffReason = 'old' | 'other-branch' | 'unstamped' | 'missing-head' | 'diverged' | 'not-new';
export type HandoffDecision = { inject: true; ageMs: number } | { inject: false; ageMs: number; reason: HandoffReason };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseHandoff(text: string): { meta: HandoffMeta; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: HandoffMeta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(session|created_at|branch|head):\s*(.*?)\s*$/.exec(line);
    if (field && field[2]) meta[field[1] as keyof HandoffMeta] = field[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Replaces any leading frontmatter; stamping twice never duplicates `---`. */
export function stampHandoffText(text: string, meta: HandoffMeta): string {
  const { body } = parseHandoff(text);
  const lines = (['session', 'created_at', 'branch', 'head'] as const)
    .filter(key => meta[key]).map(key => `${key}: ${meta[key]}`);
  return `---\n${lines.join('\n')}\n---\n${body.replace(/^(?:\r?\n)+/, '')}`;
}

/** AGENT_HANDOFF_MAX_AGE: number with optional unit (s, m, h, d); a bare number is hours. Default 24 h. */
export function handoffMaxAgeMs(raw = process.env.AGENT_HANDOFF_MAX_AGE): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(raw ?? '');
  if (!match) return 24 * HOUR;
  const unit = { s: 1000, m: 60_000, h: HOUR, d: 24 * HOUR, '': HOUR }[match[2].toLowerCase() as 's' | 'm' | 'h' | 'd' | ''];
  return Number(match[1]) * unit;
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000 });
}

/** Branch/HEAD of `cwd`; undefined only outside a git work tree. An unborn branch has head ''. */
export function gitState(cwd: string): GitState | undefined {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return undefined;
  const head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  // symbolic-ref names the branch even before its first commit; detached HEAD reads as 'HEAD'.
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    branch: branch.status === 0 && branch.stdout.trim() ? branch.stdout.trim() : 'HEAD',
    head: head.status === 0 ? head.stdout.trim() : '',
    exists: sha => git(cwd, ['cat-file', '-e', `${sha}^{commit}`]).status === 0,
    isAncestor: sha => git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0,
  };
}

export function handoffDecision({ meta, mtime, now, maxAgeMs, git: repo, newSession = true }: {
  meta: HandoffMeta; mtime: number; now: number; maxAgeMs: number; git?: GitState; newSession?: boolean;
}): HandoffDecision {
  const created = Date.parse(meta.created_at ?? '');
  const ageMs = Math.max(0, now - (Number.isFinite(created) ? created : mtime));
  const no = (reason: HandoffReason): HandoffDecision => ({ inject: false, ageMs, reason });
  if (!newSession) return no('not-new');
  if (ageMs >= maxAgeMs) return no('old');
  if (!repo) return { inject: true, ageMs };
  if (!meta.branch) return no('unstamped');
  if (meta.branch !== repo.branch) return no('other-branch');
  // Stamped on an unborn branch: any HEAD of the same branch comes after it.
  if (!meta.head) return { inject: true, ageMs };
  if (meta.head === repo.head) return { inject: true, ageMs };
  if (!repo.exists(meta.head)) return no('missing-head');
  return repo.isAncestor(meta.head) ? { inject: true, ageMs } : no('diverged');
}

/** "3 h", "12 min", "2 days" */
export function ageLabel(ms: number): string {
  if (ms < 60_000) return 'less than 1 min';
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.floor(ms / (24 * HOUR))} days`;
}

const short = (sha?: string) => (sha ?? '').slice(0, 7);

/** One line for the TUI. */
export function handoffNotice(decision: Extract<HandoffDecision, { inject: false }>, meta: HandoffMeta): string {
  const base = `A handoff from ${ageLabel(decision.ageMs)} ago${meta.branch ? ` on branch ${meta.branch}` : ''} is pending`;
  const tail = '; use /handoff to load it.';
  switch (decision.reason) {
    case 'unstamped': return `A handoff from ${ageLabel(decision.ageMs)} ago with no recorded branch or commit is pending${tail}`;
    case 'missing-head': return `${base}, but its commit ${short(meta.head)} no longer exists (rebase or amend?)${tail}`;
    case 'diverged': return `${base}, written on ${short(meta.head)}, which is not in the current HEAD history${tail}`;
    default: return base + tail;
  }
}

/** Why a handoff loaded on demand may be outdated (model-facing, English). */
function staleNote(decision: HandoffDecision, meta: HandoffMeta, repo?: GitState): string {
  if (decision.inject) return '';
  const hours = Math.round(decision.ageMs / HOUR);
  const why = {
    old: `it is about ${hours} h old`,
    'other-branch': `it was written on branch ${meta.branch}; the current branch is ${repo?.branch ?? 'unknown'}`,
    unstamped: 'it records no branch or commit',
    'missing-head': `its commit ${short(meta.head)} no longer exists (rebase or amend)`,
    diverged: `the current HEAD does not descend from its commit ${short(meta.head)}`,
    'not-new': 'it was written for a new session, and this session already has history',
  }[decision.reason];
  return `It may be outdated: ${why}. Check it against the current code and git state first.`;
}

/** Message the model receives (customType agent-handoff). */
export function handoffMessage(text: string, decision: HandoffDecision, repo?: GitState): string {
  const { meta, body } = parseHandoff(text);
  const origin = [
    meta.session && `session ${meta.session}`,
    meta.created_at && `written ${meta.created_at}`,
    meta.branch && `branch ${meta.branch}`,
    meta.head && `commit ${short(meta.head)}`,
  ].filter(Boolean).join(', ');
  return [
    `Handoff from a previous session${origin ? ` (${origin})` : ''}. Continue from it.`,
    staleNote(decision, meta, repo),
    '<handoff>',
    body.trim(),
    '</handoff>',
  ].filter(Boolean).join('\n');
}

export function handoffPath(cwd: string): string { return join(cwd, HANDOFF_FILE); }

/** Same path resolution as Pi's edit/write tools. */
export function isHandoffPath(input: unknown, cwd: string): boolean {
  if (typeof input !== 'string' || !input) return false;
  let p = input.startsWith('@') ? input.slice(1) : input;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return (isAbsolute(p) ? resolve(p) : resolve(cwd, p)) === resolve(handoffPath(cwd));
}

/** Stamps `.agent/handoff.md` in place with the session and the current branch/HEAD. */
export function stampHandoff(cwd: string, session: string | undefined, now = Date.now()): boolean {
  const file = handoffPath(cwd);
  if (!existsSync(file)) return false;
  const repo = gitState(cwd);
  const text = readFileSync(file, 'utf8');
  const stamped = stampHandoffText(text, { session, created_at: new Date(now).toISOString(), branch: repo?.branch, head: repo?.head });
  if (stamped !== text) writeFileSync(file, stamped);
  return true;
}

export interface PendingHandoff { text: string; meta: HandoffMeta; decision: HandoffDecision; git?: GitState }

/** Reads and judges the pending handoff; undefined when there is none. */
export function readHandoff(cwd: string, opts: { now?: number; newSession?: boolean } = {}): PendingHandoff | undefined {
  const file = handoffPath(cwd);
  let text: string;
  let mtime: number;
  try {
    mtime = Math.floor(statSync(file).mtimeMs);
    text = readFileSync(file, 'utf8');
  } catch { return undefined; }
  const { meta } = parseHandoff(text);
  const repo = gitState(cwd);
  const decision = handoffDecision({ meta, mtime, now: opts.now ?? Date.now(), maxAgeMs: handoffMaxAgeMs(), git: repo, newSession: opts.newSession });
  return { text, meta, decision, git: repo };
}

export function consumeHandoff(cwd: string): void {
  renameSync(handoffPath(cwd), join(cwd, HANDOFF_CONSUMED));
}
