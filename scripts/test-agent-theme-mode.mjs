#!/usr/bin/env node
/**
 * Prova offline FOCAL de dark/light na TUI Agent (nada de produção é tocado).
 *
 * O que prova, na TUI real (Pi de verdade, tmux próprio com `-L`, provider
 * Anthropic falso em loopback, zero rede):
 *
 *  1) O par de temas da fixture (`<light>/<dark>`, nesta ordem, conforme
 *     docs/themes.md) é aplicado por `--use-theme` sem ler settings pessoais.
 *  2) A escolha do lado do par vem do TERMINAL, não do macOS: num tmux destacado
 *     ninguém responde a consulta de cores, então vale o fallback documentado
 *     (notificação → `COLORFGBG` → dark). `COLORFGBG=0;15` (fundo claro) tem de
 *     levar ao tema claro; `15;0`, ao escuro.
 *  3) Editor e rodapé nativos; a borda reflete thinking, não modo do Agent.
 *  4) Cores e contraste dos cards Claude Code preservados em claro/escuro.
 *  5) Hot-swap de tema no MESMO PID por `ctx.ui.setTheme()` (extensão fixture),
 *     conferindo quais cores acompanham a troca e quais ficam presas.
 *
 * LIMITES declarados (não são afrouxamento de asserção, são o que o ambiente dá):
 *  - Nenhum dos dois temas define `colors.background`: o fundo é o DEFAULT DO
 *    TERMINAL. O tmux destacado não reporta fundo, então, como diz themes.md, o
 *    Pi usa o palpite por aparência: branco no claro, preto no escuro. Os
 *    contrastes aqui são calculados contra esse fundo efetivo (#ffffff/#000000),
 *    que é exatamente o que o usuário vê num terminal claro/escuro padrão.
 *  - OSC 11/OSC 4 não são injetáveis num tmux destacado (sem cliente, a resposta
 *    não chega ao Pi); por isso o hot-swap é provado por `ctx.ui.setTheme()`, que
 *    é o mesmo caminho que o controlador de tema usa ao trocar de lado do par
 *    (`setThemeName`), e por `COLORFGBG` no arranque para o lado do par.
 *
 * Os números de contraste usados como piso: >= 3:1 para controles/elementos
 * gráficos (borda do input, ícones de estado) e >= 4.5:1 para texto.
 *
 * Nada fora de diretórios temporários próprios e de um socket tmux próprio.
 */
import './lib/hermetic-test-env.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
if (spawnSync('tmux', ['-V']).status !== 0) throw new Error('tmux ausente');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KEEP = process.env.KEEP === '1';
/**
 * Qual cópia da Agent TUI medir. Vazio = a árvore de trabalho (o perfil aponta para
 * `agent/extensions/agent/tui`). Com um diretório, mede ESSA cópia — serve para
 * reproduzir o estado de um commit sem mexer na árvore de ninguém, por exemplo:
 *   mkdir -p /tmp/head && git archive HEAD agent | tar -x -C /tmp/head   # `agent/` inteiro: o
 *   # a Agent TUI importa `../../../core/client.mjs`, então a cópia precisa da mesma vizinhança
 *   AGENT_THEME_TUI_SRC=/tmp/head/agent/extensions/agent/tui node scripts/test-agent-theme-mode.mjs
 */
const TUI_SRC = process.env.AGENT_THEME_TUI_SRC ? join(process.env.AGENT_THEME_TUI_SRC) : '';

// Fixture do par do Agent; não lê settings nem temas pessoais.
const PAIR = 'grayscale-baimin-claude-cc-agent-light/grayscale-baimin-claude-cc-agent';
const [LIGHT_THEME, DARK_THEME] = PAIR.split('/');
const REPO_THEMES = join(repo, 'agent/themes');
const piRoot = join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');

// ---- cor: ANSI truecolor lido da tela + contraste WCAG ----------------------
const SGR = /\x1b\[([0-9;]*)m/g;

/** Divide uma linha capturada em trechos com a cor de frente/fundo vigente. */
function spans(line) {
  const out = [];
  let fg, bg, at = 0;
  SGR.lastIndex = 0;
  let m;
  const push = (text) => { if (text) out.push({ fg, bg, text }); };
  while ((m = SGR.exec(line))) {
    push(line.slice(at, m.index));
    at = m.index + m[0].length;
    const codes = m[1].split(';').filter(c => c !== '').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = undefined; bg = undefined; }
      else if (c === 39) fg = undefined;
      else if (c === 49) bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const hex = '#' + codes.slice(i + 2, i + 5).map(v => (v & 0xff).toString(16).padStart(2, '0')).join('');
        if (c === 38) fg = hex; else bg = hex;
        i += 4;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2;
    }
  }
  push(line.slice(at));
  return out;
}

/** Cor de frente (e fundo) vigente onde `needle` aparece na linha. */
function colorAt(line, needle) {
  for (const span of spans(line)) if (span.text.includes(needle)) return { fg: span.fg, bg: span.bg, text: span.text };
  return undefined;
}
const fgAt = (line, needle) => colorAt(line, needle)?.fg;
/** Texto da linha sem ANSI: a tela tem códigos ENTRE ícone e palavra, nada é contiguo. */
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const srgb = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const ratio = (a, b) => Number(contrast(a, b).toFixed(2));

// ---- relatório: cada achado é um caso concreto, não uma suíte genérica ------
const findings = [];
const notes = [];
function check(ok, id, detail) {
  findings.push({ ok: Boolean(ok), id, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} — ${detail}`);
}

// Cores dos tokens do tema, inclusive nos novos quadros do welcome.
function tokenColor(name, token) {
  const theme = JSON.parse(readFileSync(join(REPO_THEMES, `${name}.json`), 'utf8'));
  const value = theme.colors[token];
  return theme.vars[value] ?? value;
}

function terminal(sock) {
  const tmux = (...args) => spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8' });
  const screen = () => tmux('capture-pane', '-p', '-t', sock).stdout ?? '';
  const screenAnsi = () => tmux('capture-pane', '-p', '-e', '-t', sock).stdout ?? '';
  const keys = (...args) => tmux('send-keys', '-t', sock, ...args);
  async function waitScreen(re, what, ms = 45_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const s = screen(); if (re.test(s)) return s; await sleep(250); }
    throw new Error(`${what}: não apareceu\n${screen()}`);
  }
  return { tmux, screen, screenAnsi, keys, waitScreen };
}

/** Extensão fixture: fotografa o tema ativo e troca de tema a quente sob comando. */
const PROBE = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'export default function (pi: any) {',
  "  pi.on('session_start', async (_event: any, ctx: any) => {",
  "    if (ctx.mode !== 'tui') return;",
  '    const log = process.env.AGENT_THEME_PROBE;',
  '    const ctl = process.env.AGENT_THEME_CTL;',
  '    if (!log) return;',
  "    const TOKENS = ['text', 'muted', 'dim', 'border', 'borderMuted', 'accent', 'success', 'error', 'warning'];",
  '    const snap = (tag: string, extra: any = {}) => {',
  '      const theme = ctx.ui.theme;',
  '      const samples: any = {};',
  "      for (const token of TOKENS) { try { samples[token] = theme.fg(token, '#'); } catch { samples[token] = null; } }",
  "      appendFileSync(log, JSON.stringify({ tag, pid: process.pid, name: theme?.name, appearance: theme?.appearance, samples, ...extra }) + '\\n');",
  '    };',
  "    snap('start');",
  '    let lastWanted = "";',
  '    let lastName = ctx.ui.theme?.name;',
  '    const timer = setInterval(() => {',
  "      let wanted = ''; try { wanted = readFileSync(ctl, 'utf8').trim(); } catch { wanted = ''; }",
  '      if (wanted && wanted !== lastWanted) {',
  '        lastWanted = wanted;',
  '        const result = ctx.ui.setTheme(wanted);',
  "        snap('setTheme', { wanted, result });",
  '        lastName = ctx.ui.theme?.name;',
  '        return;',
  '      }',
  "      if (ctx.ui.theme?.name !== lastName) { lastName = ctx.ui.theme?.name; snap('themeChanged'); }",
  '    }, 250);',
  '    timer.unref?.();',
  '  });',
  '}',
  '',
].join('\n');

/**
 * Uma sessão TUI completa para uma aparência de terminal.
 * `colorfgbg` é o único sinal de claro/escuro disponível (nada de OS/macOS).
 */
async function run({ label, colorfgbg, expectTheme, bg, swapTo }) {
  const parent = mkdtempSync(join(tmpdir(), `agent-theme-${label}-`));
  const sock = `agentthm${process.pid}${label}`;
  const term = terminal(sock);
  const fake = await startFakeAnthropic([
    { tool: { name: 'plan', input: { steps: [{ text: 'medir cores', status: 'in_progress' }] } } },
    { text: 'ok', usage: { input: 100, cacheRead: 900, output: 3 } },
  ]);
  try {
    // O prepare separa os registros gerenciados da seed por CAS, somente na cópia.
    // Deferred permanece ligado: desligá-lo esconderia colisões com a release global.
    const seed = join(parent, 'seed'); mkdirSync(seed);
    writeFileSync(join(seed, 'settings.json'), JSON.stringify({ theme: PAIR, lastChangelogVersion: JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).version }));
    const prep = spawnSync(process.execPath, [join(repo, 'scripts/prepare-agent-test.mjs'), '--temp-parent', parent, '--agent-dir', seed, '--pi-root', piRoot], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    if (prep.status !== 0) {
      throw new Error(prep.stderr);
    }
    const info = JSON.parse(prep.stdout);
    rmSync(join(info.agentDir, 'auth.json'), { force: true });
    writeFileSync(join(info.agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'fake-key', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } } }));
    // Os temas do teste são os do REPO (os pessoais ficam intocados onde estão).
    mkdirSync(join(info.agentDir, 'themes'), { recursive: true });
    for (const file of readdirSync(REPO_THEMES).filter(f => f.endsWith('.json'))) {
      cpSync(join(REPO_THEMES, file), join(info.agentDir, 'themes', file));
    }
    if (TUI_SRC) {
      // O perfil carrega a Agent TUI pelo CAMINHO em settings.extensions (o prepare aponta
      // para a árvore do repo). Trocar esse caminho — no settings do PERFIL temporário, nunca
      // no global — é o que faz a medição cair sobre a cópia pedida.
      const file = join(info.agentDir, 'settings.json');
      const settings = JSON.parse(readFileSync(file, 'utf8'));
      const repoTui = join(repo, 'agent/extensions/agent/tui');
      let swapped = 0;
      settings.extensions = (settings.extensions ?? []).map((entry) => {
        if (typeof entry !== 'string' || entry.replace(/^[!+-]/, '') !== repoTui) return entry;
        swapped++;
        return entry.replace(repoTui, TUI_SRC);
      });
      if (!swapped) throw new Error(`AGENT_THEME_TUI_SRC: nenhuma entrada da Agent TUI para trocar em ${file}`);
      writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    }
    const probeLog = join(parent, 'theme.jsonl');
    const ctlFile = join(parent, 'theme.ctl');
    writeFileSync(ctlFile, '');
    writeFileSync(join(info.agentDir, 'extensions/agent-theme-probe.ts'), PROBE);

    const env = JSON.parse(readFileSync(join(info.root, 'environment.json'), 'utf8'));
    const exports = Object.entries({
      ...env, AGENT_LEARN: '0', AGENT_DISPATCHER: '0', AGENT_CACHE_KEEPER: '0',
      AGENT_THEME_PROBE: probeLog, AGENT_THEME_CTL: ctlFile, COLORFGBG: colorfgbg,
      GARIME_CLAUDE_APPEARANCE: '', GARIME_CLAUDE_ACCENT: '',
    }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const work = join(parent, 'work'); mkdirSync(work);
    spawnSync('git', ['init', '-b', 'main'], { cwd: work });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: work });
    const cmd = `cd ${JSON.stringify(work)} && env ${exports} ${JSON.stringify(join(info.root, 'launch.sh'))} --model anthropic/claude-haiku-5-5 --use-theme ${JSON.stringify(PAIR)}`;
    if (term.tmux('new-session', '-d', '-s', sock, '-x', '200', '-y', '45', cmd).status !== 0) throw new Error('tmux não abriu');

    const observed = () => {
      let raw = ''; try { raw = readFileSync(probeLog, 'utf8'); } catch { return []; }
      return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    };
    await term.waitScreen(/claude-haiku-5-5/, `${label}: TUI subiu`);
    const deadline = Date.now() + 20_000;
    while (observed().length === 0 && Date.now() < deadline) await sleep(250);
    const first = observed()[0];
    if (!first) throw new Error(`${label}: fixture não registou o tema ativo`);

    // (1)+(2) lado do par escolhido pelo terminal (COLORFGBG), não pelo SO.
    check(first.name === expectTheme, `${label}/par-do-tema`,
      `COLORFGBG=${colorfgbg} com --use-theme ${PAIR} → tema "${first.name}" (appearance ${first.appearance}); esperado "${expectTheme}"`);

    const pickLine = (re, last = false) => {
      const lines = term.screenAnsi().split('\n').filter(l => re.test(plain(l)));
      return (last ? lines.at(-1) : lines[0]) ?? '';
    };
    const borderOf = () => fgAt(pickLine(/^\s*─{10}/u), '─');
    const cardLine = () => pickLine(/⏺/);
    const statLine = () => pickLine(/%.*(?:auto|\/1\.0M)/, true);
    const checkNative = (name, id) => {
      check(!/┌─|└─|Dicas/.test(term.screen()), `${id}/native-layout`, 'sem moldura, palco ou painel Agent');
      check(eq(borderOf(), tokenColor(name, 'thinkingMedium')), `${id}/native-border`, `borda nativa: ${borderOf()}`);
      check(!/simple|complex/.test(term.screen()), `${id}/no-legacy-mode`, 'sem modos legados no rodapé');
    };
    checkNative(first.name, label);
    // The native editor border represents thinking; there is no subagent opt-in status.
    check(!/(?<!\/)subagents on/.test(term.screen()), `${label}/no-opt-in-status`, 'subagentes sempre ligados, sem status de opt-in');
    term.keys('-l', 'oi');
    await term.waitScreen(/oi/, `${label}: texto no editor`);
    term.keys('Enter');
    await term.waitScreen(/▸ plano 0\/1/, `${label}: plano concluído`);
    await term.waitScreen(/⏺/, `${label}: card Claude`);
    const cardBullet = fgAt(cardLine(), '⏺');
    const cardText = plain(cardLine());
    check(eq(cardBullet, tokenColor(first.name, 'success')), `${label}/chat-bullet`, `card Claude preservado: ${cardBullet}`);
    check(Boolean(cardBullet) && ratio(cardBullet, bg) >= 3, `${label}/chat-contrast`, 'bullet com contraste >= 3:1');
    check(/%/.test(plain(statLine())), `${label}/native-context`, 'contexto no rodapé nativo');
    const beforeSwap = observed().length;
    writeFileSync(ctlFile, swapTo);
    const end = Date.now() + 20_000;
    let swap;
    while (Date.now() < end) {
      swap = observed().slice(beforeSwap).find(o => o.tag === 'setTheme');
      if (swap) break;
      await sleep(250);
    }
    if (!swap) throw new Error(`${label}: setTheme não observado`);
    await sleep(1500);
    check(swap.result?.success === true && swap.name === swapTo && swap.pid === first.pid, `${label}/hot-swap`, 'tema troca no mesmo PID');
    checkNative(swapTo, `${label}/swapped`);
    const afterBullet = fgAt(cardLine(), '⏺');
    check(eq(afterBullet, tokenColor(swapTo, 'success')), `${label}/chat-hot-swap`, `card acompanha tema: ${afterBullet}`);
    check(plain(cardLine()) === cardText, `${label}/chat-preserved`, 'hot-swap não altera conteúdo');
    check(Boolean(afterBullet) && ratio(afterBullet, swapTo === LIGHT_THEME ? '#ffffff' : '#000000') >= 3, `${label}/chat-hot-contrast`, 'bullet após troca >= 3:1');

    // Captura (sem segredos: só a tela da TUI) para inspeção manual.
    const shot = join(tmpdir(), `agent-theme-${label}.ansi`);
    writeFileSync(shot, term.screenAnsi());
    notes.push(`captura ${label}: ${shot}`);
  } finally {
    term.tmux('kill-server');
    await fake.close();
    if (!KEEP) rmSync(parent, { recursive: true, force: true });
    else notes.push(`perfil preservado: ${parent}`);
  }
}

// ---- estado dos pontos suspeitos na ÁRVORE que o perfil carrega -------------
// Informativo (o veredito vem da tela, não do grep): diz CONTRA QUAL código as
// medições foram feitas, porque o perfil aponta para `agent/extensions/agent/tui`
// do repo — incluindo alterações não commitadas.

const dirty = spawnSync('git', ['status', '--short', '--', 'agent/extensions/agent/tui'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
console.log(`árvore medida: ${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()}${dirty ? ` + não commitado:\n${dirty}` : ' (limpa)'}`);
if (TUI_SRC) console.log(`Agent TUI medido: ${TUI_SRC} (override AGENT_THEME_TUI_SRC)`);
console.log(`par testado: ${PAIR} (fixture, temas do repo)`);

await run({ label: 'dark', colorfgbg: '15;0', expectTheme: DARK_THEME, bg: '#000000', swapTo: LIGHT_THEME });
await run({ label: 'light', colorfgbg: '0;15', expectTheme: LIGHT_THEME, bg: '#ffffff', swapTo: DARK_THEME });

console.log('\n--- medições ---');
for (const note of notes) console.log(note);
const failed = findings.filter(f => !f.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} casos ok`);
if (failed.length) {
  console.log('\nFALHAS (bugs de produção reproduzidos; o teste fica VERMELHO até o fix no main):');
  for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`);
  process.exit(1);
}
console.log('PASS theme-mode (Pi real, tmux, provider falso, sem rede)');
