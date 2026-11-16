import { fileURLToPath } from 'node:url';
import { restoreSkillPolicyEnvironment } from './skill-policy.mjs';

const PRELOAD = /(^|[\\/])agent[\\/]juice[\\/]runtime\.mjs$/;
const isPreload = (value) => {
  if (value.startsWith('file:')) {
    try { value = fileURLToPath(value); } catch { return false; }
  }
  return PRELOAD.test(value);
};

// Keep the exact spelling of unrelated Node flags, including quoted paths.
export function stripPreload(nodeOptions) {
  const tokens = [];
  const pattern = /(?:[^\s"']|"(?:\\.|[^"\\])*"|'[^']*')+/g;
  for (const match of nodeOptions.matchAll(pattern)) {
    const raw = match[0];
    const value = raw.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, double, single) => single ?? double.replace(/\\(["\\])/g, '$1'));
    tokens.push({ raw, value });
  }
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const { raw, value } = tokens[i];
    if (value.startsWith('--import=') && isPreload(value.slice(9))) continue;
    if (value === '--import' && tokens[i + 1] && isPreload(tokens[i + 1].value)) { i++; continue; }
    kept.push(raw);
  }
  return kept.join(' ');
}

/** Bash/codemode must not inherit the Agent preload or feature activation. */
export function userCommandEnv(env = process.env) {
  const copy = { ...env };
  if (typeof copy.NODE_OPTIONS === 'string') {
    const rest = stripPreload(copy.NODE_OPTIONS);
    if (rest) copy.NODE_OPTIONS = rest;
    else delete copy.NODE_OPTIONS;
  }
  // Invalid policy snapshots fail visibly, never restore the unsafe inherited env.
  restoreSkillPolicyEnvironment(copy);
  for (const key of Object.keys(copy)) {
    if (key.startsWith('AGENT_JUICE_') || ['AGENT_RUNTIME_ENABLED', 'AGENT_PI_ROOT', 'AGENT_CHILD', 'AGENT_CACHE_PREFETCH'].includes(key)) delete copy[key];
  }
  return copy;
}

/**
 * Sticky anti-recursion marker. Unlike AGENT_CHILD, neither userCommandEnv nor the launcher
 * removes it, so `agent -p` run from a child's bash still cannot delegate.
 */
export const NO_DELEGATE_ENV = 'AGENT_NO_DELEGATE';

/**
 * Cache retention a child runs with. Children default to `short` (Anthropic 5 min, write 1.25x)
 * even when the session runs `long` (1h, write 2x): pauses of 5-60 min inside a child are rare,
 * so 1h writes cost ~4x what they save. AGENT_CHILD_CACHE_RETENTION overrides; an inherited
 * `none` (cache disabled by the user) is kept.
 */
export function childCacheRetention(env = process.env) {
  if (env.AGENT_CHILD_CACHE_RETENTION) return env.AGENT_CHILD_CACHE_RETENTION;
  return env.PI_CACHE_RETENTION === 'none' ? 'none' : 'short';
}

/** Agent children retain the preload and skill policy, but no legacy accounting env. */
export function subagentEnv(env = process.env) {
  const copy = { ...env, AGENT_CHILD: '1', [NO_DELEGATE_ENV]: '1', PI_CACHE_RETENTION: childCacheRetention(env) };
  if (copy.AGENT_RUNTIME_ENABLED === undefined && copy.AGENT_JUICE_ENABLED !== undefined) copy.AGENT_RUNTIME_ENABLED = copy.AGENT_JUICE_ENABLED;
  if (!copy.AGENT_PI_ROOT && copy.AGENT_JUICE_PI_ROOT) copy.AGENT_PI_ROOT = copy.AGENT_JUICE_PI_ROOT;
  for (const key of Object.keys(copy)) {
    if (key.startsWith('AGENT_JUICE_') && key !== 'AGENT_JUICE_SKILLS_BEFORE') delete copy[key];
  }
  return copy;
}
