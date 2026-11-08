#!/usr/bin/env node
/** Contrato do editor nativo, adaptadores de interação e status estáticos. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), '.local/share/agent');
function findPiRoot() {
  const rel = 'lib/node_modules/@earendil-works/pi-coding-agent';
  const cur = join(store, 'current', rel);
  if (existsSync(cur)) return cur;
  const releases = join(store, 'releases');
  if (!existsSync(releases)) return undefined;
  for (const r of readdirSync(releases).sort().reverse()) if (existsSync(join(releases, r, rel))) return join(releases, r, rel);
}
const piRoot = findPiRoot();
if (!piRoot) { console.log('skip: Pi não encontrado no store do overlay'); process.exit(0); }

const req = createRequire(join(piRoot, 'package.json'));
const { createJiti } = req('jiti');
const dep = (n) => join(piRoot, 'node_modules', n);
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: true, alias: {
  '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
  '@earendil-works/pi-ai': dep('@earendil-works/pi-ai'),
  '@earendil-works/pi-tui': dep('@earendil-works/pi-tui'),
  typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
} });
const { AgentEditor } = await jiti.import(join(repo, 'agent/extensions/agent/tui/editor.ts'));
const { CustomEditor } = await jiti.import(join(piRoot, 'dist/index.js'));
const { visibleWidth } = await jiti.import(dep('@earendil-works/pi-tui'));
const theme = { fg: (_c, t) => t, borderColor: t => t, selectList: { selectedBg: t => t } };
const tui = { terminal: { rows: 45 }, requestRender() {} };
const keys = { matches: (data, action) => (action === 'tui.editor.cursorDown' && data === '\x1b[B') || (action === 'app.interrupt' && data === '\x1b') };
const native = new CustomEditor(tui, theme, keys);
let focus = 0;
const editor = new AgentEditor(tui, theme, keys, r => { focus++; r.handled = true; });
const text = 'Texto longo com imagem colada, 日本語, emoji 🦊 e palavras inteiras para conferir resize e cursor sem redesenhar o editor.';
for (const padding of [0, 1, 2]) for (const width of [12, 40, 85, 120, 200]) for (const value of ['', text, 'linha 1\nlinha 2']) {
  native.setPaddingX(padding);
  editor.setPaddingX(padding);
  for (const e of [native, editor]) e.setText(value);
  const expected = native.render(width);
  assert.deepEqual(editor.render(width), expected, `render nativo sem margem extra (${padding}/${width}/${value.length})`);
  for (const line of editor.render(width)) assert.ok(visibleWidth(line) <= width);
}
console.log('ok desenho nativo sem margem extra: vazio, multilinha, Unicode, padding, resize e cursor');
editor.setText('rascunho'); editor.handleInput('\x1b[B'); assert.equal(focus, 0);
editor.setText(''); editor.handleInput('\x1b[B'); assert.equal(focus, 1);
editor.setText('apagar'); editor.handleInput('\x1b'); editor.handleInput('\x1b'); assert.equal(editor.getText(), '');
console.log('ok ↓ só foca plano com input vazio; Esc duplo limpa rascunho');
const skillEditor = new AgentEditor(tui, theme, keys, undefined, undefined, {
 commands: () => [{ name: 'skill:fixture', source: 'skill', description: 'Uma skill real' }],
 categories: () => [{ name: 'dev', skills: ['fixture'] }],
});
skillEditor.handleInput('\x1b[200~/skill:fix\x1b[201~');
assert.ok(skillEditor.skillPickerState(), 'paste abre seletor');
assert.ok(skillEditor.render(80).length > native.render(80).length, 'seletor acrescenta linhas');
skillEditor.handleInput('\r');
assert.equal(skillEditor.getText(), '/skill:fixture ', 'Enter insere sem enviar');
assert.equal(skillEditor.skillPickerState(), undefined);
console.log('ok paste e seletor preservados sobre editor nativo');

// Jobs own role data; formatting must not parse statuses or animate on its own.
const { subagentMascots, modeStatus } = await jiti.import(join(repo, 'agent/extensions/agent/tui/status-line.ts'));
assert.equal(subagentMascots([]), undefined);
const roles = ['worker-sol', 'scout', 'planner', 'reviewer', 'visual', 'unknown'];
const faces = subagentMascots(roles);
assert.ok(faces.endsWith(' +1'), 'overflow remains bounded');
assert.equal(subagentMascots(roles), faces, 'faces static across calls');
assert.notEqual(subagentMascots(['worker']), subagentMascots(['reviewer']), 'role shape/color distinct');
assert.match(subagentMascots(['unknown']), /‥/, 'unknown role fallback');
assert.doesNotMatch(faces, /subagente|agentes|sessões|US\$/, 'no duplicate text counts or cost');
assert.equal(modeStatus('complex'), '\u{F09D1} complex');
assert.equal(modeStatus('simple'), '\u{F0241} simple');
console.log('ok mascotes estáticos por papel, limite, fallback e modo sem custo duplicado');

// Plano no TUI nativo: o host monta/remove widgets; o SDK controla o foco real.
{
  const { TuiMainScreen } = await jiti.import(dep('@earendil-works/pi-tui'));
  const { default: installPlan, PLAN_FOCUS_EVENT } = await jiti.import(join(repo, 'agent/extensions/brain-live/plan.ts'));
  const screen = new TuiMainScreen({ rows: 45, columns: 120, write() {} });
  screen.requestRender = () => {};
  const events = new Map();
  const handlers = new Map();
  const entries = [];
  let tool, widget, branch = [];
  const planTheme = { ...theme, bold: t => t };
  const input = new AgentEditor(screen, theme, keys, request => events.get(PLAN_FOCUS_EVENT)(request));
  screen.addChild(input);
  screen.setFocus(input);
  installPlan({
    events: { on: (name, fn) => events.set(name, fn) },
    on: (name, fn) => handlers.set(name, fn),
    registerTool: value => { tool = value; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  });
  const ctx = {
    hasUI: true, mode: 'tui',
    sessionManager: { getBranch: () => branch },
    ui: { setWidget(id, factory, options) {
      assert.equal(id, 'garime-plan');
      if (widget) {
        assert.notEqual(screen.getFocusedComponent(), widget, 'devolve foco ANTES de desmontar');
        screen.removeChild(widget);
      }
      widget = factory?.(screen, planTheme);
      if (widget) {
        assert.equal(options.placement, 'belowEditor');
        screen.addChild(widget);
        assert.ok(screen.children.indexOf(widget) > screen.children.indexOf(input));
      }
    } },
  };
  const publish = steps => tool.execute('probe', { steps }, undefined, undefined, ctx);
  const focusPlan = () => {
    input.setText('');
    input.handleInput('\x1b[B');
    assert.equal(screen.getFocusedComponent(), widget);
    assert.equal(widget.focused, true);
  };
  const click = (x, y = 0, button = 'left') => widget.handleMouse({ type: 'click', button, x, y });
  const initial = [
    { text: 'Preparar', status: 'pending' },
    { text: 'Executar agora', status: 'in_progress' },
    { text: 'Conferir', status: 'pending' },
  ];
  await handlers.get('session_start')({}, ctx);
  assert.equal(widget, undefined);
  await publish(initial);
  assert.equal(screen.getFocusedComponent(), input, 'publicar não rouba foco');
  assert.match(widget.render(120)[0], /^▸ plano 0\/3 · ◉ Executar agora/);
  for (const width of [12, 40, 120]) for (const line of widget.render(width)) assert.ok(visibleWidth(line) <= width);
  assert.equal(click(2), undefined, 'sem foco, só x0 é seta');
  assert.equal(click(0, 1), undefined);
  assert.equal(click(0, 0, 'right'), undefined);
  assert.deepEqual(click(0), { handled: true, render: true });
  assert.equal(widget.render(120).length, 4);
  assert.match(widget.render(120)[2], /◉ Executar agora/);
  assert.equal(screen.getFocusedComponent(), input, 'mouse não pede foco');
  click(0);
  focusPlan();
  assert.match(widget.render(120)[0], /^› ▸ plano 0\/3/);
  assert.equal(click(0), undefined, 'com foco x0 é marcador, não seta');
  assert.deepEqual(click(2), { handled: true, render: true });
  assert.equal(widget.render(120).length, 4);
  assert.equal(screen.getFocusedComponent(), widget);
  click(2);
  widget.handleInput('\x1b[C');
  assert.equal(widget.render(120).length, 4);
  widget.handleInput('\x1b[D');
  assert.equal(widget.render(120).length, 1);
  widget.handleInput('\r');
  assert.equal(widget.render(120).length, 4);
  widget.handleInput('\x1b[A');
  assert.equal(screen.getFocusedComponent(), input);
  focusPlan();
  widget.handleInput('x');
  assert.equal(screen.getFocusedComponent(), input);
  assert.equal(input.getText(), 'x', 'texto encaminhado ao editor');
  focusPlan();
  await publish(initial.map((step, i) => i === 0 ? { ...step, status: 'done' } : step));
  assert.equal(screen.getFocusedComponent(), input, 'substituir plano focado devolve foco');
  assert.match(widget.render(120)[0], /plano 1\/3/);
  focusPlan();
  await publish([]);
  assert.equal(widget, undefined);
  assert.equal(screen.getFocusedComponent(), input, 'plan[] não deixa foco órfão');
  assert.equal(entries.at(-1).data.steps.length, 0);
  await publish(initial);
  const other = { focused: false, render: () => [], invalidate() {} };
  screen.addChild(other);
  screen.setFocus(other);
  await publish(initial);
  assert.equal(screen.getFocusedComponent(), other, 'atualizar não rouba foco de outro componente');
  await publish([]);
  assert.equal(screen.getFocusedComponent(), other, 'limpar não rouba foco');
  branch = [entries[0], { type: 'custom', customType: 'garime-plan', data: { steps: [
    { text: 'Feito', status: 'done' }, { text: 'Dispensado', status: 'skipped' }, { text: 'Da branch', status: 'pending' },
  ] } }, { type: 'custom', customType: 'outro', data: { steps: [] } }];
  await handlers.get('session_start')({}, ctx);
  assert.equal(screen.getFocusedComponent(), other);
  assert.match(widget.render(120)[0], /^▸ plano 2\/3 · ◻ Da branch/);
  focusPlan();
  widget.handleInput('\r');
  branch = [entries[0]];
  await handlers.get('session_start')({}, ctx);
  assert.equal(screen.getFocusedComponent(), input, 'restore também desmonta sem foco órfão');
  assert.match(widget.render(120)[0], /^▸ plano 0\/3 · ◉ Executar agora/, 'restore reseta expansão');
  focusPlan();
  branch = [entries.at(-1)];
  await handlers.get('session_start')({}, ctx);
  assert.equal(widget, undefined, 'branch com plan[] limpa widget');
  assert.equal(screen.getFocusedComponent(), input);
  console.log('ok plano nativo: 0/3, etapa atual, mouse com/sem foco, teclado, atualização, plan[] e restore de branch');
}
