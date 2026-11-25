import { loadCompanySkillCategories, loadSkillCategories } from './skill-categories.mjs';
/** Curadoria Agent: catálogo completo para o humano, anúncio automático mínimo. */
export const AUTOMATIC_GLOBAL_SKILLS = Object.freeze(['peers', 'megamind', 'diagram']);

const SYSTEM_SKILLS = Object.freeze(loadSkillCategories().find(c => c.name === 'system')?.skills ?? []);
/** Skills de empresa (ARCA/Omni) entram só para quem tem o enrollment, e aí são automáticas. */
const COMPANY_SKILLS = Object.freeze(loadCompanySkillCategories().flatMap(c => c.skills));
/** Skills pessoais comuns, a categoria system e as de empresa do usuário ficam sempre visíveis. */
export function automaticSkillNames() {
  return [...new Set([...AUTOMATIC_GLOBAL_SKILLS, ...SYSTEM_SKILLS, ...COMPANY_SKILLS])];
}
export function isAutomaticSkill(name) {
  return automaticSkillNames().includes(name);
}

export const PREVIOUS_SKILL_POLICY_ENV = 'AGENT_SKILLS_BEFORE';
/** Skill names a subagent advertises (comma list, may be empty). Set by the runner; bash never inherits it. */
export const CHILD_SKILLS_ENV = 'AGENT_CHILD_SKILLS';

/** Desfazer só a política instalada pelo Agent, preservando eventual env do usuário. */
export function restoreSkillPolicyEnvironment(env) {
  // Read-only compatibility for a parent process started before the rename.
  const key = Object.hasOwn(env, PREVIOUS_SKILL_POLICY_ENV) ? PREVIOUS_SKILL_POLICY_ENV : 'AGENT_JUICE_SKILLS_BEFORE';
  if (!Object.hasOwn(env, key)) return;
  const previous = JSON.parse(env[key]);
  if (previous !== null && typeof previous !== 'string') throw new Error('Agent: snapshot de curadoria inválido');
  if (previous === null) delete env.PI_AUTOMATIC_SKILLS;
  else env.PI_AUTOMATIC_SKILLS = previous;
  delete env[PREVIOUS_SKILL_POLICY_ENV];
  delete env.AGENT_JUICE_SKILLS_BEFORE;
}

/**
 * Opt-in do formatter compartilhado do SDK (overlay/agent-skill-curation.patch).
 * O catálogo inteiro segue em /skill:, inclusive no host durável, sem modificar
 * objetos nem SKILL.md. As automáticas de trabalho vêm da pasta system/.
 * A prova de capacidade evita ativar silenciosamente sobre um SDK antigo.
 */
export function installSkillPolicy(formatSkillsForPrompt) {
  const env = process.env;
  env[PREVIOUS_SKILL_POLICY_ENV] ??= JSON.stringify(env.PI_AUTOMATIC_SKILLS ?? null);
  // Subagent with an allowlist (runner.ts): advertise exactly what the parent resolved.
  const child = env.AGENT_CHILD === '1' && env[CHILD_SKILLS_ENV] !== undefined;
  env.PI_AUTOMATIC_SKILLS = child ? env[CHILD_SKILLS_ENV] : automaticSkillNames().join(',');
  const probe = { name: 'agent-policy-probe', description: 'compatibility probe', filePath: '/agent-policy-probe/SKILL.md', baseDir: '/agent-policy-probe', source: 'user', disableModelInvocation: false };
  if (typeof formatSkillsForPrompt !== 'function' || formatSkillsForPrompt([probe]) !== '') {
    restoreSkillPolicyEnvironment(env);
    throw new Error('Agent: SDK sem curadoria de skills; prepare/promova a release com agent-skill-curation antes de ativar este artefato');
  }
}
