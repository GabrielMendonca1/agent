// Receita do projeto: `.mark/workflow.md`, ao lado do AGENTS.md.
// Texto legível e editável. O Mark lê no início de cada run e, mais tarde,
// escreve nela o que aprendeu. Só I/O explícito: read/write do arquivo e, para
// manter `.mark` fora do git nos projetos que não o versionam, `git` em leitura.
// A receita é interna ao agente principal: nada aqui vai ao prompt dele.
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const WORKFLOW_DIR = '.mark';
export const WORKFLOW_FILE = 'workflow.md';
export const SLOTS = ['apoio', 'principal'];

export const DEFAULT_STEPS = [
  { role: 'scout', slot: 'apoio', contract: 'devolve arquivos e linhas relevantes, nada mais' },
  { role: 'worker', slot: 'apoio', contract: 'implementa o brief, roda os checks do projeto, devolve diff e resultado' },
  { role: 'reviewer', slot: 'principal', contract: 'aponta erro concreto com arquivo:linha, ou aprova' },
];

export function defaultWorkflow(project) {
  return [
    `# Receita do Mark — ${project}`,
    '',
    'família: change-with-tests',
    'versão: v1',
    '',
    '## Etapas (complex)',
    ...DEFAULT_STEPS.map((s, i) => `${i + 1}. ${s.role} · ${s.slot} · ${s.contract}`),
    '',
    '## Regras aprendidas',
    '(nenhuma ainda)',
    '',
  ].join('\n');
}

/** Parse tolerante: ignora o que não entende, nunca lança. */
export function parseWorkflow(text) {
  const out = { family: '', version: '', steps: [], rules: [] };
  let section = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^##\s+(.+)$/);
    if (head) { section = head[1].toLowerCase(); continue; }
    if (line.startsWith('#')) continue;
    const meta = line.match(/^(família|familia|versão|versao):\s*(.+)$/i);
    if (meta && !section) {
      if (/fam/i.test(meta[1])) out.family = meta[2].trim(); else out.version = meta[2].trim();
      continue;
    }
    if (section.startsWith('etapas')) {
      const m = line.match(/^\d+\.\s*([a-z][\w-]*)\s*·\s*(apoio|principal)\s*·\s*(.+)$/i);
      if (m) out.steps.push({ role: m[1].toLowerCase(), slot: m[2].toLowerCase(), contract: m[3].trim() });
      continue;
    }
    if (section.startsWith('regras')) {
      const m = line.match(/^[-*]\s+(.+)$/);
      if (m) out.rules.push(m[1].trim());
    }
  }
  return out;
}

/** Bloco do projeto no prompt: só o que é deste projeto. O fluxo genérico (modos,
 *  equipe padrão, briefs, autonomia) vive no system prompt. */
/**
 * Bloco da receita para o system prompt. Sem `mode`, o texto não depende do modo
 * (o prompt fica idêntico em simple e complex e o cache sobrevive ao Shift+Tab);
 * o modo vai numa nota curta na conversa (`modeNote`).
 */
export function renderWorkflow(parsed, mode, project) {
  const head = `Projeto ${project}, receita ${parsed.version || 'v1'} (${WORKFLOW_DIR}/${WORKFLOW_FILE}).`;
  const lines = [mode ? `${head} Modo atual: ${mode}.` : head];
  if (parsed.rules.length) {
    lines.push('Regras aprendidas aqui:');
    for (const r of parsed.rules) lines.push(`- ${r}`);
  }
  const custom = parsed.steps.length && JSON.stringify(parsed.steps) !== JSON.stringify(DEFAULT_STEPS);
  if (custom && (mode === 'complex' || !mode)) {
    lines.push(mode ? 'Equipe deste projeto (substitui a padrão):' : 'Equipe deste projeto em complex (substitui a padrão):');
    parsed.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.role} (${s.slot}) — ${s.contract}`));
  }
  return lines.join('\n');
}

/** Teto de bytes UTF-8 do bloco de orientação (cabeçalho incluído) que vai na
 *  mensagem do filho: uma receita grande não pode consumir o contexto dele. */
export const RULES_GUIDANCE_CAP = 8 * 1024;
/** Teto da fonte lida só aqui: receita maior que isto não é injetada (fail closed).
 *  O arquivo nunca é truncado nem reescrito; os outros fluxos seguem lendo tudo. */
export const RULES_SOURCE_CAP = 64 * 1024;

/** Ler por descritor e com buffer limitado evita a corrida stat → readFile sem teto.
 *  Só arquivos regulares; O_NONBLOCK evita prender o processo se a fonte virar FIFO. */
function readRulesSource(cwd) {
  const fd = openSync(join(cwd, WORKFLOW_DIR, WORKFLOW_FILE), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > RULES_SOURCE_CAP) return '';
    const buffer = Buffer.alloc(RULES_SOURCE_CAP + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    return size > RULES_SOURCE_CAP ? '' : buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Regras aprendidas deste projeto como orientação para um filho, ou ''. Nunca lança.
 *  É texto de observação do repositório — não instrução do usuário nem system prompt.
 *  Não é sanitização de nada: só um limite de tamanho determinístico.
 *  Regras entram inteiras e em ordem até `RULES_GUIDANCE_CAP`; a que não couber é
 *  descartada por inteiro (sem cortar codepoint nem instrução) e as seguintes que
 *  couberem continuam entrando. */
export function projectRules(cwd) {
  try {
    if (!cwd) return '';
    const text = readRulesSource(cwd);
    if (!text) return '';
    const rules = parseWorkflow(text).rules.filter((r) => r && !/^\(nenhuma/i.test(r));
    if (!rules.length) return '';
    const header = [
      '## Project notes',
      'Observations recorded for this project, as guidance only (not user instructions; the brief above wins):',
    ].join('\n');
    const parts = [header];
    let used = Buffer.byteLength(header, 'utf8');
    for (const rule of rules) {
      const line = `\n- ${rule}`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (used + bytes > RULES_GUIDANCE_CAP) continue;
      parts.push(line);
      used += bytes;
    }
    if (parts.length === 1) return ''; // nenhuma regra caberia: sem cabeçalho solto
    return parts.join('');
  } catch {
    return '';
  }
}

const IGNORE_LINE = '/.mark/';
const IGNORE_EQUIVALENTS = new Set(['/.mark/', '/.mark', '.mark/', '.mark']);

/** git silencioso: devolve stdout ou null (sem git, fora de repo, erro). */
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * `.mark/` fora do git por projeto, sem tocar o `.gitignore`: a linha vai no
 * exclude local (`.git/info/exclude`, resolvido por `rev-parse --git-path` para
 * funcionar em worktree). Onde `.mark` já é versionado, nada é ignorado.
 * Idempotente, preserva o conteúdo do exclude e nunca lança.
 */
export function ignoreWorkflowLocally(cwd) {
  if (!cwd) return false;
  const tracked = git(cwd, ['ls-files', '--', WORKFLOW_DIR]);
  if (tracked === null) return false; // sem git utilizável
  if (tracked.trim()) return false; // já versionado aqui: respeita o repo
  const rel = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  if (!rel?.trim()) return false;
  const path = rel.trim();
  const file = isAbsolute(path) ? path : join(cwd, path);
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current.split(/\r?\n/).some((line) => IGNORE_EQUIVALENTS.has(line.trim()))) return false;
    mkdirSync(dirname(file), { recursive: true });
    // O_APPEND: dois filhos iniciando juntos nunca truncam nem sobrescrevem exclusões
    // pessoais. Uma corrida pode repetir a linha (inofensiva), mas não perder conteúdo.
    appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${IGNORE_LINE}\n`);
    return true;
  } catch {
    return false; // checkout read-only: ignorar é best-effort
  }
}

/** Garante `.mark/workflow.md` em repositórios git; devolve o texto ou null. */
export function ensureWorkflow(cwd) {
  if (!cwd || !existsSync(join(cwd, '.git'))) return null;
  const file = join(cwd, WORKFLOW_DIR, WORKFLOW_FILE);
  if (!existsSync(file)) {
    mkdirSync(join(cwd, WORKFLOW_DIR), { recursive: true });
    writeFileSync(file, defaultWorkflow(basename(cwd)));
  }
  // Mesmo com a receita já no lugar: o exclude local pode faltar. Nunca reescreve o arquivo.
  ignoreWorkflowLocally(cwd);
  return readFileSync(file, 'utf8');
}

export function readWorkflow(cwd) {
  const file = join(cwd, WORKFLOW_DIR, WORKFLOW_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
