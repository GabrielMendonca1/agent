#!/usr/bin/env node
/**
 * Fotografa a TUI real (perfil Agent de teste, provider falso, offline) para
 * comparar com o protótipo: tmux → captura ANSI → HTML → PNG (Chrome headless).
 *
 *   node scripts/agent-tui-shot.mjs --out /tmp/shots [--cols 180] [--rows 50]
 *     [--light] [--complex] [--chat]
 *
 * `--chat` manda uma mensagem (o provider falso publica um plano e responde)
 * para fotografar o estado de conversa. Nada fora de diretórios temporários.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(name);
const out = resolve(arg('--out', join(tmpdir(), 'agent-tui-shot')));
const cols = Number(arg('--cols', '180'));
const rows = Number(arg('--rows', '50'));
const light = flag('--light');
const complex = flag('--complex');
const chat = flag('--chat');
const name = [chat ? 'chat' : 'inicial', light ? 'claro' : 'escuro', complex ? 'complex' : 'simple'].join('-');
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sock = `agentshot${process.pid}`;
const tmux = (...a) => spawnSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
const parent = mkdtempSync(join(tmpdir(), 'agent-shot-'));
const fake = await startFakeAnthropic([
  { tool: { name: 'plan', input: { steps: [
    { text: 'Levantar cache, plano, Megamind e subagentes', status: 'done' },
    { text: 'Atualizar o input e o estado inicial', status: 'in_progress' },
    { text: 'Corrigir Megamind fora de ARCA/Omni', status: 'pending' },
    { text: 'Conferir a renderização', status: 'pending' },
  ] } } },
  { text: 'Vou levantar o que a TUI já mostra e atualizar o input.', usage: { input: 100, cacheRead: 900, output: 3 } },
]);
try {
  const prep = spawnSync(process.execPath, [join(repo, 'scripts/prepare-juice-test.mjs'), '--temp-parent', parent], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  if (prep.status !== 0) throw new Error(prep.stderr);
  const info = JSON.parse(prep.stdout);
  rmSync(join(info.agentDir, 'auth.json'), { force: true });
  writeFileSync(join(info.agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'fake-key', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } } }));
  writeFileSync(join(info.agentDir, 'extensions/agent-shot-coordination.ts'), `export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const publish = () => { ctx.ui.setStatus('megamind', '◈ megamind · ARCA'); ctx.ui.setStatus('peers', '\\u{F06A9} ▮▮▮▮'); };
    publish();
    for (const ms of [500, 1500, 4000]) setTimeout(publish, ms).unref?.();
  });
}
`);
  if (light) {
    const settingsPath = join(info.agentDir, 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    settings.theme = 'grayscale-baimin-claude-cc-agent-light';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
  const env = JSON.parse(readFileSync(join(info.root, 'environment.json'), 'utf8'));
  const exports = Object.entries({ ...env, AGENT_LEARN: '0', AGENT_DISPATCHER: '0', AGENT_CACHE_KEEPER: '0' }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const work = join(parent, 'agent');
  mkdirSync(work);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: work });
  const cmd = `cd ${JSON.stringify(work)} && env ${exports} ${JSON.stringify(join(info.root, 'launch.sh'))} --model anthropic/claude-opus-5-5 --thinking medium`;
  tmux('new-session', '-d', '-s', sock, '-x', String(cols), '-y', String(rows), cmd);
  await sleep(9000);
  if (complex) { tmux('send-keys', '-t', sock, 'BTab'); await sleep(2500); }
  if (chat) {
    tmux('send-keys', '-t', sock, '-l', 'deixa o input igual ao protótipo');
    tmux('send-keys', '-t', sock, 'Enter');
    await sleep(9000);
  }
  const ansi = tmux('capture-pane', '-p', '-e', '-t', sock).stdout ?? '';
  writeFileSync(join(out, `${name}.ansi`), ansi);
  writeFileSync(join(out, `${name}.html`), toHtml(ansi, light));
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  spawnSync(chrome, ['--headless', '--disable-gpu', `--user-data-dir=${join(parent, 'chrome')}`, `--screenshot=${join(out, `${name}.png`)}`, `--window-size=${Math.round(cols * 9)},${Math.round(rows * 19 + 20)}`, '--virtual-time-budget=1500', `file://${join(out, `${name}.html`)}`], { stdio: 'ignore' });
  console.log(join(out, `${name}.png`));
} finally {
  tmux('kill-server');
  await fake.close?.();
  rmSync(parent, { recursive: true, force: true });
}

/** ANSI (SGR 38/48 truecolor/256, bold, dim, reverse) → HTML monoespaçado. */
function toHtml(ansi, isLight) {
  const bg = isLight ? '#fcfcfa' : '#000000';
  const fg = isLight ? '#1a1a1a' : '#f7f7f7';
  // Ícones (Nerd Font, dingbats) ocupam 1 célula no terminal; no Chrome saem mais largos e empurram a borda.
  // Blocos e quadrantes (▀▄█▌▐▖▗▘▝▚▞▙▛▜▟): o terminal pinta a célula inteira; a fonte deixa frestas.
  const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
  const block = (c) => {
    const bits = QUAD.indexOf(c);
    const q = [[0, 0, 1], [50, 0, 2], [0, 50, 4], [50, 50, 8]].filter(([, , b]) => bits & b)
      .map(([x, y]) => `<b style="left:${x}%;top:${y}%"></b>`).join('');
    return `<span class="q">${q}</span>`;
  };
  // Braille: 2×4 pontinhos espalhados pela célula inteira, como no terminal (a fonte do Chrome os encolhe).
  const dots = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]];
  const braille = (c) => {
    const bits = c.codePointAt(0) - 0x2800;
    const d = dots.filter(([, , b]) => bits & b)
      .map(([x, y]) => `<b class="d" style="left:${12 + x * 50}%;top:${5 + y * 25}%"></b>`).join('');
    return `<span class="q">${d}</span>`;
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/[▀▄█▌▐▖▗▘▝▚▞▙▛▜▟]/gu, block)
    .replace(/[\u2800-\u28ff]/gu, braille)
    .replace(/[\u2600-\u27bf\ue000-\uf8ff]|[\u{f0000}-\u{fffff}]/gu, (c) => `<span class="g"><i>${c}</i></span>`);
  const lines = ansi.replace(/\n$/, '').split('\n');
  let state = {};
  const style = () => {
    let f = state.fg, b = state.bg;
    if (state.reverse) [f, b] = [b ?? bg, f ?? fg];
    const parts = [];
    if (f) parts.push(`color:${f}`);
    if (b) parts.push(`background:${b}`);
    if (state.bold) parts.push('font-weight:700');
    if (state.dim) parts.push('opacity:.6');
    if (state.italic) parts.push('font-style:italic');
    return parts.join(';');
  };
  const c256 = (n) => {
    if (n < 16) return ['#000', '#c00', '#0a0', '#a50', '#00a', '#a0a', '#0aa', '#aaa', '#555', '#f55', '#5f5', '#ff5', '#55f', '#f5f', '#5ff', '#fff'][n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16; const r = Math.floor(n / 36), g = Math.floor(n / 6) % 6, b = n % 6; const s = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${s(r)},${s(g)},${s(b)})`;
  };
  const html = lines.map((line) => {
    let outLine = '';
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m;
    const emit = (text) => { if (text) outLine += `<span style="${style()}">${esc(text)}</span>`; };
    while ((m = re.exec(line))) {
      emit(line.slice(last, m.index));
      last = re.lastIndex;
      const codes = (m[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) state = {};
        else if (c === 1) state.bold = true;
        else if (c === 2) state.dim = true;
        else if (c === 3) state.italic = true;
        else if (c === 7) state.reverse = true;
        else if (c === 22) { state.bold = false; state.dim = false; }
        else if (c === 23) state.italic = false;
        else if (c === 27) state.reverse = false;
        else if (c === 39) state.fg = undefined;
        else if (c === 49) state.bg = undefined;
        else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const v = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; if (c === 38) state.fg = v; else state.bg = v; i += 4; }
        else if ((c === 38 || c === 48) && codes[i + 1] === 5) { const v = c256(codes[i + 2]); if (c === 38) state.fg = v; else state.bg = v; i += 2; }
        else if (c >= 30 && c <= 37) state.fg = c256(c - 30);
        else if (c >= 90 && c <= 97) state.fg = c256(c - 90 + 8);
      }
    }
    emit(line.slice(last));
    return outLine || ' ';
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Nerd;src:url('file:///Users/biel/Library/Fonts/SymbolsNerdFontMono-Regular.ttf')}body{margin:0;background:${bg};color:${fg}}.q{display:inline-block;position:relative;width:1ch;height:19px;vertical-align:top}.q b{position:absolute;width:50%;height:50%;background:currentColor}.q b.d{width:2.5px;height:2.5px;border-radius:50%}.g{display:inline-block;width:1ch;overflow:visible;text-align:center;white-space:nowrap}.g i{font-style:normal;font-size:12px}pre{margin:10px;font:14px/19px 'SF Mono',Menlo,Nerd,monospace;white-space:pre}</style><pre>${html}</pre>`;
}
