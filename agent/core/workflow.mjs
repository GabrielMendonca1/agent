// Read-only compatibility for project recipes; current rules live in .agent/rules.md.
import { hasRules, sourceContext } from './project-context.mjs';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const WORKFLOW_DIR = '.agent';
export const WORKFLOW_FILE = 'workflow.md';

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
    if (hasRules(cwd)) return sourceContext(cwd).map(({ path, content }) => `## ${path}\n${content}`).join('\n\n');
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

export function readWorkflow(cwd) {
  const file = join(cwd, WORKFLOW_DIR, hasRules(cwd) ? 'rules.md' : WORKFLOW_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
