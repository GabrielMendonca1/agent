/**
 * Empresas do usuário (ARCA, Omni) e as skills do Agent com escopo de empresa.
 *
 * `agent/company-skills/<empresa>/<skill>/SKILL.md` fica FORA de `agent/skills` (que o updater
 * registra para todo mundo em `settings.skills`): cada pasta só entra na sessão, via
 * `resources_discover` (juice.ts), para quem tem o enrollment daquela empresa.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPANY_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../company-skills');

/** Pasta do enrollment de cada empresa em `~/.config/` (espelha extensions/megamind/profile.ts). */
export const COMPANIES = Object.freeze([
  Object.freeze({ id: 'arca', dir: 'arca-projects' }),
  Object.freeze({ id: 'omni', dir: 'omni-megamind', env: 'OMNI_MEGAMIND_CONFIG' }),
]);

/**
 * Empresas do usuário, só por arquivos locais (sem rede). Mesmo critério de
 * `megamindProfile()` (extensions/megamind/profile.ts): `ARCA_MEGAMIND_CONFIG`
 * explícito vale pela pasta da config (`none`/pasta desconhecida = nenhuma);
 * sem ele, cada enrollment existente em `~/.config/<empresa>/config.json` conta,
 * então quem tem os dois recebe os dois.
 * @returns {('arca'|'omni')[]}
 */
export function userCompanies(env = process.env, home = homedir()) {
  const absolute = (value) => resolve(value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);
  const inside = (file, dir) => {
    const rel = relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const raw = (env.ARCA_MEGAMIND_CONFIG ?? '').trim();
  if (raw) {
    if (raw.toLowerCase() === 'none') return [];
    const file = absolute(raw);
    return COMPANIES.filter((c) => inside(file, join(home, '.config', c.dir))).map((c) => c.id);
  }
  return COMPANIES.filter((c) => {
    const declared = (c.env ? (env[c.env] ?? '') : '').trim();
    return existsSync(declared ? absolute(declared) : join(home, '.config', c.dir, 'config.json'));
  }).map((c) => c.id);
}

/** Pastas de skills das empresas do usuário que existem no artefato. */
export function companySkillDirs(companies = userCompanies(), root = COMPANY_SKILLS_DIR) {
  return companies.map((id) => join(root, id)).filter((dir) => existsSync(dir));
}
