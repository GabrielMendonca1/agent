// Aprender do trabalho real: ao fim de um run com checks verdes, um modelo barato
// escreve 0–3 regras curtas em `.agent/workflow.md`. Funções puras aqui; a chamada
// ao modelo e o I/O ficam na extensão.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKFLOW_DIR, WORKFLOW_FILE, parseWorkflow } from './workflow.mjs';
import { withWorkflowLock } from './lock.mjs';

export const MAX_RULES = 30;
const GREEN = /OK: nada que funcionava|\b\d+\/\d+ verdes\b|\ball tests passed\b|\bpass(ed)?\b.*\bfail(ed)?\s*0\b|^# fail 0$/im;
const RED = /BLOQUEIA|\bFAIL(ED)?\b(?!\s*:?\s*0\b)|\bnot ok\b|\bfalh(ou|aram)\b|# fail [1-9]/i;

/** Mensagens do último turno do usuário até o fim (entries do branch da sessão). */
export function lastRunMessages(entries) {
  const msgs = entries.filter(e => e?.type === 'message' && e.message?.role).map(e => e.message);
  let start = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { start = i; break; }
  return start < 0 ? [] : msgs.slice(start);
}

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
}

/**
 * O comando bash executa de fato um check do projeto e o exit code dele é o do
 * comando inteiro? Aceita `check`, `cd dir && check`, `a && check && b`, com
 * `env`/`VAR=x` à frente. Recusa o que mascara ou não executa: `||`, `;`, `|`,
 * `&` (background), subshell/substituição, redirecionamento de status, eco/string.
 */
export function runsCheck(command, checkCmds) {
  const cmd = String(command ?? '').trim();
  if (!cmd || /\|\||;|\n|\$\(|`|(^|[^&>])&($|[^&])|\|/.test(cmd)) return false;
  // Aspas: `echo "x && <check>"` dividiria por && dentro da string. Só aceitas se o
  // próprio check as tem, e cada segmento precisa ter aspas balanceadas.
  if (/['"\\]/.test(cmd) && !checkCmds.some(c => /['"\\]/.test(String(c)))) return false;
  const segments = cmd.split('&&').map(s => s.trim().replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '')
    // Redirecionar saída (`2>&1`, `> log`) não muda o exit code.
    .replace(/(?:\s+\d?>>?\s*(?:&\d|\S+))+$/, ''));
  return checkCmds.some(c => {
    const want = String(c ?? '').trim();
    const balanced = seg => (seg.split('"').length % 2 === 1) && (seg.split("'").length % 2 === 1);
    return want && segments.every(balanced) && segments.some(seg => seg === want);
  });
}

/** Verde objetivo: tool `checks` sem bloqueio, ou bash rodando um check do projeto sem erro. */
export function hadGreenChecks(messages, checkCmds = []) {
  const calls = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const p of m.content) if (p?.type === 'toolCall') calls.set(p.id, p);
    }
  }
  let green = false;
  for (const m of messages) {
    if (m.role !== 'toolResult') continue;
    const call = calls.get(m.toolCallId);
    // Resultado sem chamada correspondente neste run não é evidência.
    if (!call) continue;
    const out = text(m.content);
    if (call.name === 'checks') {
      if (m.isError) return false;
      if (RED.test(out) && !GREEN.test(out)) return false;
      if (GREEN.test(out)) green = true;
      continue;
    }
    if (call.name === 'bash' && runsCheck(call.arguments?.command, checkCmds)) {
      // Exit code é a verdade (o bash do Pi marca isError); texto só para pegar
      // runners que saem 0 com falha declarada.
      if (m.isError || /BLOQUEIA|# fail [1-9]|\bnot ok\b|\b[1-9]\d* failed\b/i.test(out)) return false;
      green = true;
    }
  }
  return green;
}

/** Resumo curto do run para o modelo barato: pedido, ferramentas (arquivos/comandos), resposta final. */
export function digestRun(messages, limit = 6000) {
  const lines = [];
  const first = messages.find(m => m.role === 'user');
  if (first) lines.push(`Pedido: ${text(first.content).slice(0, 800)}`);
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p?.type !== 'toolCall') continue;
      const a = p.arguments ?? {};
      const what = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.agent ?? '';
      lines.push(`- ${p.name}${what ? `: ${String(what).slice(0, 160)}` : ''}`);
    }
  }
  const last = [...messages].reverse().find(m => m.role === 'assistant' && text(m.content).trim());
  if (last) lines.push(`Resposta final: ${text(last.content).slice(0, 1200)}`);
  const out = lines.join('\n');
  return out.length > limit ? out.slice(0, limit) + '\n…' : out;
}

export function learnPrompt(digest, existingRules, project) {
  return [
    `Você mantém a receita do projeto "${project}" para um agente de código. Abaixo, o resumo de uma tarefa concluída com os checks verdes.`,
    'Escreva de 0 a 3 regras curtas (até 140 caracteres cada), específicas deste projeto, que pouparia exploração numa próxima tarefa: como rodar testes/checks, onde ficam as coisas, armadilhas, convenções. Nada genérico ("escreva testes"), nada já coberto pelas regras existentes.',
    existingRules.length ? `Regras existentes:\n${existingRules.map(r => `- ${r}`).join('\n')}` : 'Regras existentes: nenhuma.',
    'Resumo:', digest,
    "Responda só com as regras, uma por linha começando com '- ', ou exatamente 'nenhuma'.",
  ].join('\n\n');
}

export function parseRules(answer) {
  const out = [];
  for (const raw of String(answer ?? '').split(/\r?\n/)) {
    const m = raw.trim().match(/^[-*]\s+(.+)$/);
    if (!m) continue;
    const r = m[1].trim().replace(/\s+/g, ' ');
    if (r.length >= 8 && r.length <= 200) out.push(r);
    if (out.length === 3) break;
  }
  return out;
}

const norm = s => s.replace(/(?: \[by: Agent; proven: no\])+$/, '').toLowerCase().replace(/[`'"().,;:]/g, '').replace(/\s+/g, ' ').trim();

/** Mescla regras novas no texto da receita; devolve { text, added, version } ou null se nada mudou. */
export function mergeRules(workflowText, newRules, floor = 0) {
  const parsed = parseWorkflow(workflowText);
  const seen = new Set(parsed.rules.map(norm));
  const added = newRules.filter(r => !seen.has(norm(r)) && seen.add(norm(r)));
  if (!added.length) return null;
  let rules = [...parsed.rules, ...added];
  if (rules.length > MAX_RULES) rules = rules.slice(rules.length - MAX_RULES);
  // floor: maior versão já registrada em history — após reversão o arquivo volta a vN, mas vN+1 já existiu.
  const current = parseInt((parsed.version || 'v1').replace(/\D/g, ''), 10) || 1;
  const version = `v${Math.max(current, floor) + 1}`;
  const lines = workflowText.split(/\r?\n/);
  const out = [];
  let inRules = false, wroteRules = false, sawRules = false;
  for (const line of lines) {
    if (/^##\s+regras/i.test(line)) { inRules = true; sawRules = true; out.push(line); out.push(...rules.map(r => `- ${r}`)); wroteRules = true; continue; }
    if (inRules) { if (/^##\s+/.test(line)) { inRules = false; out.push(''); out.push(line); } continue; }
    if (/^vers(ão|ao):/i.test(line)) { out.push(`versão: ${version}`); continue; }
    out.push(line);
  }
  if (!sawRules) { out.push('', '## Regras aprendidas', ...rules.map(r => `- ${r}`)); wroteRules = true; }
  if (!/^vers(ão|ao):/im.test(workflowText)) out.splice(1, 0, '', `versão: ${version}`);
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  return wroteRules ? { text, added, version } : null;
}

/** Aplica no disco e registra em history.json; devolve o resultado da mesclagem. */
export function applyLearned(cwd, newRules, meta = {}) {
  // Ler-mesclar-escrever sob a trava da receita: processos aprendendo ao mesmo
  // tempo não perdem regras nem repetem versão.
  return withWorkflowLock(cwd, () => applyLearnedLocked(cwd, newRules, meta)) ?? null;
}

function applyLearnedLocked(cwd, newRules, meta) {
  const file = join(cwd, WORKFLOW_DIR, WORKFLOW_FILE);
  if (!existsSync(file)) return null;
  const before = readFileSync(file, 'utf8');
  const hist = join(cwd, WORKFLOW_DIR, 'history.json');
  let history = [];
  try { history = JSON.parse(readFileSync(hist, 'utf8')); if (!Array.isArray(history)) history = []; } catch { history = []; }
  const floor = Math.max(0, ...history.map(h => parseInt(String(h?.version ?? '').replace(/\D/g, ''), 10) || 0));
  const merged = mergeRules(before, newRules.map(r => `${r} [by: Agent; proven: no]`), floor);
  if (!merged) return null;
  writeFileSync(file, merged.text);
  history.push({ version: merged.version, at: new Date().toISOString(), added: merged.added, previous: before, ...meta, proven: 'no' });
  writeFileSync(hist, JSON.stringify(history.slice(-50), null, 2) + '\n');
  return merged;
}
