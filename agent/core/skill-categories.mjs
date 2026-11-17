/** Catálogo por pastas, compartilhado pelo prompt e pelo seletor. */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANY_SKILLS_DIR, userCompanies } from './companies.mjs';
export const AGENT_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../skills');

export function loadSkillCategories(root = AGENT_SKILLS_DIR) {
  return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(e => ({ name: e.name, skills: skillCandidates(join(root, e.name)).map(file => {
      const head = readSkillHead(file);
      return head?.name || basename(dirname(file));
    }).sort() }));
}

/** Categorias com escopo de empresa (`arca`, `omni`): só as das empresas do usuário. */
export function loadCompanySkillCategories(companies = userCompanies(), root = COMPANY_SKILLS_DIR) {
  if (!existsSync(root)) return [];
  const wanted = new Set(companies);
  return loadSkillCategories(root).filter(c => wanted.has(c.name));
}

/** Categorias gerais seguidas das de empresa do usuário (ordem do seletor). */
export function loadAllSkillCategories(companies = userCompanies()) {
  return [...loadSkillCategories(), ...loadCompanySkillCategories(companies)];
}

/** Só as categorias gerais: as de empresa são automáticas e já vêm em <available_skills>. */
export function categoryPrompt(categories = loadSkillCategories()) {
  return categories.filter(c => c.name !== 'system' && c.skills.length)
    .map(c => `${c.name}: ${c.skills.join(', ')} — invoque com /skill:nome ou leia o SKILL.md quando a tarefa pedir.`).join('\n');
}

/** Frontmatter do SKILL.md. */
function readSkillHead(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (key) => (new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim() ?? '').replace(/^['"]|['"]$/g, '');
  return { name: field('name'), description: field('description') };
}

/** Descoberta recursiva, encerrada no SKILL.md e protegida contra ciclos de symlink. */
function skillCandidates(entry, seen = new Set()) {
  let stats;
  try {
    const real = realpathSync(entry);
    if (seen.has(real)) return [];
    seen.add(real);
    stats = statSync(entry);
  } catch { return []; }
  if (stats.isFile()) return [];
  if (existsSync(join(entry, 'SKILL.md'))) return [join(entry, 'SKILL.md')];
  try {
    return readdirSync(entry).sort().filter(n => !n.startsWith('.') && n !== 'node_modules')
      .flatMap(n => skillCandidates(join(entry, n), seen));
  } catch { return []; }
}

