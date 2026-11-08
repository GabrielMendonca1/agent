#!/usr/bin/env node
// Prompt completo do MARK II, como o modelo recebe: system prompt + ferramentas,
// capturados do payload real (before_provider_request) num perfil MARK II
// temporário, nos modos simple e complex, rodando num workspace (padrão: este repo).
// Grava dois arquivos no Vault (~/Sistema/Pi):
//   header.md       — resumo: tamanhos, system prompt do complex, o que muda no simple, ferramentas
//   prompt-tudo.md  — literalmente tudo: os dois modos completos, schemas e o payload bruto
//
//   node scripts/dump-mark-prompt.mjs [--workspace <dir>] [--dir <pasta>] [--model provider/id]
//                                     [--pi-root <runtime>] [--system-prompt <arquivo>]
//                                     → header-proposta.md / prompt-tudo-proposta.md
//
// Custo: duas chamadas curtas ao modelo (padrão Haiku). Não toca no perfil `mark2`.
import { setJuiceMode } from '../mark/juice/client.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const workspace = resolve(option('--workspace', repo));
const outDir = resolve(option('--dir', join(process.env.PI_SYSTEM_DIR || join(homedir(), 'Sistema'), 'Pi')));
// Com --system-prompt (proposta), grava ao lado sem sobrescrever o dump do prompt atual.
const proposal = option('--system-prompt', null);
const suffix = proposal ? '-proposta' : '';
const out = join(outDir, `header${suffix}.md`);
const outAll = join(outDir, `prompt-tudo${suffix}.md`);
const model = option('--model', 'anthropic/claude-haiku-5-5');

// 1) Perfil temporário, igual ao do mark2 (mesmo preparador), sem instalar launcher.
const parent = mkdtempSync(join(tmpdir(), 'mark-prompt-'));
const piRoot = option('--pi-root', null);
const prep = spawnSync(process.execPath, [join(repo, 'scripts/prepare-juice-test.mjs'), '--temp-parent', parent, ...(piRoot ? ['--pi-root', resolve(piRoot)] : []), ...(proposal ? ['--system-prompt', resolve(proposal)] : [])], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
if (prep.status !== 0) throw new Error(`prepare falhou: ${prep.stderr}`);
const profile = JSON.parse(prep.stdout);
const env = JSON.parse(readFileSync(join(profile.root, 'environment.json'), 'utf8'));

// 2) Extensão de captura: grava o payload do primeiro request do agente principal.
const capture = join(parent, 'capture.mjs');
writeFileSync(capture, `import { writeFileSync, existsSync } from 'node:fs';
export default function (pi) {
  pi.on('before_provider_request', (event) => {
    const path = process.env.MARK_PROMPT_CAPTURE;
    if (!path || process.env.MARK_JUICE_CHILD === '1' || existsSync(path)) return;
    writeFileSync(path, JSON.stringify(event.payload));
  });
}
`);

function capturePayload(mode) {
  Object.assign(process.env, { MARK_JUICE_ENABLED: '1', MARK_JUICE_HOME: env.MARK_JUICE_HOME, MARK_JUICE_STATE: env.MARK_JUICE_STATE });
  setJuiceMode(mode);
  const file = join(parent, `payload-${mode}.json`);
  const run = spawnSync(join(profile.root, 'launch.sh'), ['-p', '--no-session', '-e', capture, '--model', model, 'Responda só: ok'], {
    cwd: workspace, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, MARK_PROMPT_CAPTURE: file, MARK_LEARN: '0', MARK_DISPATCHER: '0' },
  });
  if (!existsSync(file)) throw new Error(`sem payload (${mode}): ${run.stderr?.slice(-800)}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// 3) Normaliza payloads de provedores diferentes para { system, tools }.
function normalize(p) {
  const text = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.map(b => b?.text ?? '').join('\n') : '';
  let system = text(p.system) || text(p.instructions);
  if (!system && Array.isArray(p.messages)) system = text(p.messages.find(m => m.role === 'system')?.content);
  if (!system && Array.isArray(p.input)) system = text(p.input.find(m => m.role === 'system' || m.role === 'developer')?.content);
  const tools = (p.tools ?? []).map(t => {
    const fn = t.function ?? t;
    const schema = fn.input_schema ?? fn.parameters ?? {};
    const params = Object.entries(schema.properties ?? {}).map(([name, s]) => ({ name, description: s?.description ?? '' }));
    return { name: fn.name, description: fn.description ?? '', params, schema };
  });
  // Identificadores de conta/dispositivo não vão para o Vault (ele sincroniza).
  const raw = structuredClone(p);
  if (raw.metadata?.user_id) raw.metadata.user_id = '<omitido: device_id, account_uuid, session_id>';
  return { system, tools, raw };
}

function lineDiff(a, b) {
  // Diff simples por linha (LCS), suficiente para prompts de poucos milhares de linhas.
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const outLines = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i++; j++; continue; }
    if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) outLines.push(`+ ${y[j++]}`);
    else outLines.push(`- ${x[i++]}`);
  }
  return outLines.filter(l => l.trim() !== '+' && l.trim() !== '-').join('\n');
}

try {
  const complex = normalize(capturePayload('complex'));
  const simple = normalize(capturePayload('simple'));
  const tok = (s) => Math.round(s.length / 4);
  const toolsText = (tools) => tools.map(t => [
    `### ${t.name}`, '', t.description.trim(), '',
    ...(t.params.length ? ['Parâmetros:', ...t.params.map(p => `- \`${p.name}\`${p.description ? ` — ${p.description.replace(/\s+/g, ' ').trim()}` : ''}`), ''] : []),
  ].join('\n')).join('\n');
  const toolChars = JSON.stringify(complex.tools).length;
  const removed = complex.tools.map(t => t.name).filter(n => !simple.tools.some(t => t.name === n));
  const added = simple.tools.map(t => t.name).filter(n => !complex.tools.some(t => t.name === n));
  const fence = '~~~~';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const doc = [
    '# Header — prompt do MARK II',
    '',
    `> Gerado por \`node ~/Projects/mark-pi/scripts/dump-mark-prompt.mjs\` em ${stamp}.`,
    `> Workspace: \`${workspace}\` · capturado do payload real enviado ao modelo (${model}).`,
    '> É o que o agente lê: system prompt + descrições das ferramentas. **Não edite aqui** — a fonte é `system-prompt.md` e `tools.md` (ver [[contexto]]); rode o script de novo para atualizar.',
    '',
    ...(proposal ? [`> **Proposta** — system prompt de \`${resolve(proposal)}\`, não o do Vault. Compare com [[header]].`, ''] : []),
    `**Tudo, sem resumo:** [[prompt-tudo${suffix}]] — os dois modos completos, cada ferramenta com o schema JSON inteiro e o payload bruto enviado à API.`,
    '',
    `| | complex | simple |`,
    `|---|---|---|`,
    `| system prompt | ${complex.system.length} chars (~${tok(complex.system)} tokens) | ${simple.system.length} chars (~${tok(simple.system)} tokens) |`,
    `| ferramentas | ${complex.tools.length} (~${Math.round(toolChars / 4)} tokens com schemas) | ${simple.tools.length} |`,
    '',
    '## 1. System prompt — modo complex',
    '',
    fence + 'text',
    complex.system,
    fence,
    '',
    '## 2. Modo simple — o que muda',
    '',
    removed.length || added.length ? `Ferramentas: ${removed.length ? `sem ${removed.map(n => `\`${n}\``).join(', ')}` : ''}${added.length ? ` · com ${added.map(n => `\`${n}\``).join(', ')}` : ''}.` : 'Ferramentas: as mesmas.',
    '',
    simple.system === complex.system ? 'System prompt: idêntico.' : ['System prompt (`-` só no complex, `+` só no simple):', '', fence + 'diff', lineDiff(complex.system, simple.system), fence].join('\n'),
    '',
    '## 3. Ferramentas — modo complex',
    '',
    toolsText(complex.tools),
  ].join('\n');
  writeFileSync(out, doc.replace(/\s*$/, '\n'));

  // prompt-tudo.md: literalmente tudo, por modo, sem cortes nem diff.
  const full = (mode, n) => [
    `## Modo ${mode}`,
    '',
    `### System prompt (${n.system.length} chars)`,
    '',
    fence + 'text', n.system, fence,
    '',
    `### Ferramentas (${n.tools.length})`,
    '',
    ...n.tools.flatMap(t => [`#### ${t.name}`, '', fence + 'text', t.description, fence, '', 'Schema:', '', fence + 'json', JSON.stringify(t.schema, null, 2), fence, '']),
    `### Payload bruto enviado à API (${mode})`,
    '',
    fence + 'json', JSON.stringify(n.raw, null, 2), fence,
    '',
  ].join('\n');
  const all = [
    '# Prompt do MARK II — tudo',
    '',
    `> Gerado em ${stamp} · workspace \`${workspace}\` · ${model}. Resumo em [[header${suffix}]].${proposal ? ` Proposta: \`${resolve(proposal)}\`.` : ''}`,
    '> Sem resumo nem diff: o que o modelo recebe em cada modo, inclusive mensagens e parâmetros do request. Único campo alterado: `metadata.user_id` (identificadores de conta), omitido.',
    '',
    full('complex', complex),
    full('simple', simple),
  ].join('\n');
  writeFileSync(outAll, all.replace(/\s*$/, '\n'));
  console.log(`${out}\n${outAll}\ncomplex: ${complex.system.length} chars, ${complex.tools.length} tools · simple: ${simple.system.length} chars, ${simple.tools.length} tools`);
} finally {
  rmSync(parent, { recursive: true, force: true });
}
