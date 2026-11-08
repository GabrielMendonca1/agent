import { restoreSkillPolicyEnvironment } from './skill-policy.mjs';

const PRELOAD = /(^|[\\/])agent[\\/]juice[\\/]runtime\.mjs$/;
const isPreload = (value) => PRELOAD.test(String(value).replace(/^file:\/\//, ''));

function stripPreload(nodeOptions) {
  const tokens = nodeOptions.split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--import=') && isPreload(token.slice('--import='.length))) continue;
    if (token === '--import' && i + 1 < tokens.length && isPreload(tokens[i + 1])) { i++; continue; }
    kept.push(token);
  }
  return kept.join(' ');
}

/**
 * Env para comandos que a sessão executa a pedido do usuário/agente (bash, codemode):
 * sem o preload do Juice, sem a curadoria de skills e sem AGENT_JUICE_*. Devolve cópia;
 * o processo pai e os subagentes seguem com process.env intacto.
 */
export function userCommandEnv(env = process.env) {
  const copy = { ...env };
  try {
    if (typeof copy.NODE_OPTIONS === 'string') {
      const rest = stripPreload(copy.NODE_OPTIONS);
      if (rest) copy.NODE_OPTIONS = rest;
      else delete copy.NODE_OPTIONS;
    }
    restoreSkillPolicyEnvironment(copy);
    for (const key of Object.keys(copy)) if (key.startsWith('AGENT_JUICE_')) delete copy[key];
    return copy;
  } catch {
    return { ...env };
  }
}
