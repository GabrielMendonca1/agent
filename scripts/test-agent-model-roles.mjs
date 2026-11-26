#!/usr/bin/env node
// /models pelos papéis: os cinco papéis nativos aparecem com modelo/thinking/origem
// efetivos, o picker lista a allowlist do papel (roleModels) e depois os demais disponíveis,
// escolher um novo o autoriza, abrir/cancelar não grava,
// gravar não toca sessão nem outros papéis, e config quebrada é dita em vez de escondida.
// Loader real do Pi, registro de modelos falso, nenhuma chamada de modelo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.AGENT_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
const load = async p => import(pathToFileURL(p).href);
const { loadExtensions, createExtensionRuntime } = await load(join(root, 'dist/core/extensions/loader.js'));
const { createEventBus } = await load(join(root, 'dist/core/event-bus.js'));
const { initTheme } = await load(join(root, 'dist/modes/interactive/theme/theme.js'));
initTheme('dark', false);

const dir = mkdtempSync(join(tmpdir(), 'agent-model-roles-'));
const savedEnv = { ...process.env };
const modelsPath = join(repo, 'agent/extensions/brain-live/models.ts');
const vault = join(dir, '.agent');
const file = join(vault, 'agent-models.json');
const tier = (label, model, thinking) => ({ label, description: 'd', model, thinking });
const fixture = () => ({
  tiers: {
    fast: tier('Fast', 'test/luna', 'high'), standard: tier('Standard', 'test/sol', 'medium'), deep: tier('Deep', 'test/fable', 'medium'),
    visual: tier('Visual', 'test/flash', 'low'), image: { label: 'Image', description: 'd', model: 'test/img', quality: 'medium', size: 'auto' },
  },
  roleModels: {
    scout: [{ model: 'test/haiku', thinking: 'medium' }, { model: 'test/luna', thinking: 'medium' }],
    worker: [{ model: 'test/opus', thinking: 'medium' }, { model: 'test/sol', thinking: 'high' }],
    planner: [{ model: 'test/fable', thinking: 'medium' }, { model: 'test/astra', thinking: 'medium' }],
    reviewer: [{ model: 'test/fable', thinking: 'medium' }],
    visual: [{ model: 'test/flash', thinking: 'low' }],
  },
  extraDoUsuario: { nao: 'mexer' },
});
const writeFixture = (data = fixture()) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(file, 'utf8'));
const bytes = () => readFileSync(file, 'utf8');

const theme = { fg: (_c, t) => t, bold: t => t };
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const KEY = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', esc: '\x1b' };

const catalog = [
  { provider: 'test', id: 'haiku', name: 'Haiku 4.5', contextWindow: 200_000 },
  { provider: 'test', id: 'opus', name: 'Opus 5', contextWindow: 200_000 },
  { provider: 'test', id: 'fable', name: 'Fable 5.1', contextWindow: 200_000 },
  { provider: 'test', id: 'astra', name: 'Astra 6', contextWindow: 400_000 },
  { provider: 'test', id: 'luna', name: 'Luna 6', contextWindow: 400_000 },
  { provider: 'test', id: 'sol', name: 'Sol 6.1', contextWindow: 400_000 },
  { provider: 'test', id: 'flash', name: 'Flash 3.8', contextWindow: 1_000_000 },
  { provider: 'test', id: 'google/gemini-test', name: 'Blocked Google Chat' },
  { provider: 'test', id: 'img', name: 'GPT Image', type: 'image' },
];

let thinkingWrites = 0, modelWrites = 0, sessionThinking = 'medium';
const notices = [];
const runtime = createExtensionRuntime();
Object.assign(runtime, {
  getThinkingLevel: () => sessionThinking,
  setThinkingLevel: l => { thinkingWrites++; sessionThinking = l; },
  setModel: async m => { modelWrites++; ctx.model = m; return true; },
});
let view, requests = 0;
const ctx = {
  cwd: dir, mode: 'tui', hasUI: true,
  model: { provider: 'test', id: 'fable' },
  get thinkingLevel() { return sessionThinking; },
  scopedModels: [],
  modelRegistry: {
    getAvailable: () => catalog,
    find: (provider, id) => catalog.find(m => m.provider === provider && m.id === id),
  },
  ui: {
    notify: (text, level) => notices.push({ text, level }),
    custom: factory => new Promise(resolve => { view = factory({ requestRender: () => requests++ }, theme, {}, resolve); }),
  },
};
const screen = (width = 120) => view.render(width).map(plain).join('\n');
const rowOf = (name, width = 120) => view.render(width).map(plain).find(l => new RegExp(`(^|\\s)${name}\\s`).test(l)) ?? '';
const type = s => { view.handleInput(s); };
const current = () => (view.render(120).map(plain).find(l => l.trimStart().startsWith('▸')) ?? '').trimStart().replace(/^▸\s*/, '');
const goTo = name => {
  for (let i = 0; i < 24; i++) {
    if (current().startsWith(name)) return;
    type(KEY.down);
  }
  throw new Error(`linha "${name}" não encontrada:\n${screen()}`);
};

const assertWidths = () => {
  for (const width of [40, 60, 80, 120]) {
    for (const line of view.render(width)) assert.ok(plain(line).length <= width, `overflow em ${width}: ${plain(line)}`);
  }
};

async function openPanel(extension) {
  notices.length = 0;
  const pending = extension.commands.get('models').handler('', ctx);
  await new Promise(r => setImmediate(r));
  return { pending };
}

let checks = 0;
try {
  mkdirSync(vault, { recursive: true });
  writeFixture();
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = vault;
  process.env.AGENT_RUNTIME_ENABLED = '1';
  delete process.env.AGENT_JUICE_ENABLED;
  writeFileSync(join(vault, 'agent-preferences.json'), JSON.stringify({ supportModel: 'test/haiku' }));

  const loaded = await loadExtensions([modelsPath], dir, createEventBus(), runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension.commands.has('models'), '/models registrado');

  // 1. Piloto: os cinco papéis aparecem com modelo, thinking e origem efetivos.
  let done = await openPanel(extension);
  const before = bytes();
  for (const [role, model, thinking] of [['scout', 'Haiku 4.5', 'medium'], ['worker', 'Opus 5', 'medium'], ['planner', 'Fable 5.1', 'medium'], ['reviewer', 'Fable 5.1', 'medium'], ['visual', 'Flash 3.8', 'low']]) {
    const line = rowOf(role);
    assert.ok(line.includes(model), `papel ${role} mostra o modelo efetivo:\n${screen()}`);
    assert.ok(line.includes('models.json'), `papel ${role} mostra a origem`);
    assert.ok(line.includes(thinking), `papel ${role} mostra o thinking do par`);
  }
  const principal = rowOf('Principal');
  assert.ok(principal.includes('Fable 5.1') && principal.includes('sessão'), `Principal é sessão: ${principal}`);
  assert.ok(!/scout · worker|orquestrador · reviewer/.test(screen()), 'slots não se vendem como papéis');
  assert.ok(rowOf('Apoio').includes('fallback'), 'Apoio é fallback explícito');
  assert.equal(bytes(), before, 'abrir /models não grava');
  assertWidths();
  checks++; console.log('ok piloto mostra os cinco papéis com modelo/thinking/origem; slots sem rótulo enganoso');

  // 2. Papel: autorizados primeiro, depois os demais disponíveis; Esc não grava.
  goTo('scout');
  type(KEY.enter);
  const picker = screen();
  assert.ok(picker.includes('Haiku 4.5') && picker.includes('Luna 6'), `picker lista os autorizados:\n${picker}`);
  assert.ok(/Opus 5/.test(picker) && /Astra 6/.test(picker), `picker oferece os demais disponíveis:\n${picker}`);
  assert.ok(picker.indexOf('Luna 6') < picker.indexOf('Opus 5'), `autorizados vêm antes:\n${picker}`);
  assert.ok(!/GPT Image/.test(picker), 'modelo de imagem não entra no picker de papel');
  assert.ok(picker.includes('thinking medium') && picker.includes('preferência atual'), 'picker mostra o par e a preferência atual');
  type(KEY.esc);
  assert.ok(rowOf('scout').includes('Haiku 4.5'), 'Esc volta para a lista');
  assert.equal(bytes(), before, 'cancelar não grava');
  checks++; console.log('ok picker do papel: allowlist primeiro e demais disponíveis; abrir e cancelar não gravam');

  // 3. Confirmar troca a preferência do papel e nada mais.
  type(KEY.enter); type(KEY.down); type(KEY.enter);
  const after = readConfig();
  assert.deepEqual(after.roleModels.scout, [{ model: 'test/luna', thinking: 'medium' }, { model: 'test/haiku', thinking: 'medium' }], 'preferência do papel vai para a frente, sem perder opção');
  assert.deepEqual(after.tiers, fixture().tiers, 'tiers preservados');
  for (const role of ['worker', 'planner', 'reviewer', 'visual']) assert.deepEqual(after.roleModels[role], fixture().roleModels[role], `papel ${role} intocado`);
  assert.deepEqual(after.extraDoUsuario, { nao: 'mexer' }, 'campos pessoais desconhecidos preservados');
  assert.equal(modelWrites, 0, 'preferência de papel não troca o modelo da sessão');
  assert.equal(thinkingWrites, 0, 'preferência de papel não troca o thinking da sessão');
  assert.deepEqual(ctx.model, { provider: 'test', id: 'fable' }, 'sessão intacta');
  const row = rowOf('scout');
  assert.ok(row.includes('Luna 6') && row.includes('medium'), `linha reflete a nova preferência: ${row}`);
  assert.ok(notices.some(n => n.text.includes('test/luna') && n.text.includes('thinking medium')), 'confirmação é informada');
  checks++; console.log('ok confirmar grava só a preferência daquele papel (sessão, tiers e demais papéis intactos)');

  // 4. Edição concorrente: o snapshot da abertura não pode voltar ao disco.
  const concurrent = readConfig();
  concurrent.tiers.deep.model = 'test/astra';
  concurrent.roleModels.worker = [{ model: 'test/sol', thinking: 'high' }, { model: 'test/opus', thinking: 'medium' }];
  writeFileSync(file, `${JSON.stringify(concurrent, null, 2)}\n`);
  goTo('planner');
  type(KEY.enter); type(KEY.down); type(KEY.enter);
  const merged = readConfig();
  assert.equal(merged.tiers.deep.model, 'test/astra', 'edição concorrente de tier preservada');
  assert.deepEqual(merged.roleModels.worker[0], { model: 'test/sol', thinking: 'high' }, 'edição concorrente de outro papel preservada');
  assert.deepEqual(merged.roleModels.planner[0], { model: 'test/astra', thinking: 'medium' }, 'escolha nova aplicada sobre o arquivo atual');
  checks++; console.log('ok gravação relê o arquivo: não clobbera edição concorrente');

  // 4b. As setas editam somente o par ativo, pulando Google API e relendo o arquivo.
  goTo('scout');
  const edited = readConfig();
  edited.roleModels.scout.reverse();
  edited.roleModels.scout[0].thinking = 'xhigh';
  edited.roleModels.scout.unshift({ model: 'test/google/gemini-test', thinking: 'low' });
  edited.tiers.standard.thinking = 'low';
  edited.roleModels.reviewer[0].thinking = 'off';
  writeFixture(edited);
  type(KEY.right);
  const expected = structuredClone(edited);
  expected.roleModels.scout[1].thinking = 'off';
  assert.deepEqual(readConfig(), expected, '→ só muda o thinking do primeiro modelo permitido no arquivo atual');
  assert.match(rowOf('scout'), /Haiku 4\.5.*off/);
  type(KEY.left);
  assert.deepEqual(readConfig(), edited, '← volta a xhigh sem tocar nas edições externas');
  assert.equal(modelWrites, 0);
  assert.equal(thinkingWrites, 0);
  assert.equal(sessionThinking, 'medium');
  checks++; console.log('ok setas editam só o thinking do papel ativo, preservando a sessão e edições concorrentes');

  // 5. Papel sem allowlist: picker com todos; escolher cria a allowlist do papel.
  const withoutScout = readConfig();
  delete withoutScout.roleModels.scout;
  writeFileSync(file, `${JSON.stringify(withoutScout, null, 2)}\n`);
  type(KEY.esc); await done.pending;
  done = await openPanel(extension);
  const stable = bytes();
  const noAllowlist = rowOf('scout');
  assert.ok(noAllowlist.includes('—') && noAllowlist.includes('frontmatter'), `papel sem allowlist aparece com a origem real: ${noAllowlist}`);
  goTo('scout');
  type(KEY.left);
  assert.equal(notices.at(-1).level, 'warning');
  assert.match(notices.at(-1).text, /scout: escolha um modelo com Enter/);
  assert.equal(bytes(), stable, '← sem allowlist não grava');
  type(KEY.enter);
  assert.ok(/Haiku 4\.5[\s\S]*Opus 5/.test(screen()) || /Opus 5[\s\S]*Haiku 4\.5/.test(screen()), `sem allowlist abre picker com todos:\n${screen()}`);
  type(KEY.esc);
  assert.equal(bytes(), stable, 'cancelar não grava');
  goTo('scout');
  type(KEY.enter);
  for (const ch of 'opus') type(ch);
  type(KEY.enter);
  assert.deepEqual(readConfig().roleModels.scout, [{ model: 'test/opus', thinking: 'medium' }], 'escolha cria a allowlist do papel');
  assert.deepEqual(readConfig().roleModels.worker, withoutScout.roleModels.worker, 'outro papel intocado');
  assert.equal(modelWrites, 0, 'sessão intacta');
  checks++; console.log('ok papel sem allowlist: origem real, picker com todos, escolha cria a allowlist');

  // 5b. Modelo fora da allowlist: autoriza com o thinking da preferência atual e vira preferência.
  goTo('worker');
  type(KEY.enter);
  for (const ch of 'astra') type(ch);
  type(KEY.enter);
  assert.deepEqual(readConfig().roleModels.worker[0], { model: 'test/astra', thinking: withoutScout.roleModels.worker[0].thinking }, 'novo modelo autorizado na frente');
  assert.equal(readConfig().roleModels.worker.length, withoutScout.roleModels.worker.length + 1, 'nenhuma opção perdida');
  checks++; console.log('ok modelo novo no papel: autorizado com o thinking da preferência');

  // 5c. Presets independentes: escolher, ajustar thinking e voltar à herança.
  const swarmSlots = [['writer', 'worker'], ['reviewer', 'reviewer'], ['board', 'papel']];
  for (const [slot, inherited] of swarmSlots) {
    const label = `swarm ${slot}`;
    const saved = bytes();
    assert.ok(rowOf(label).includes(`herda ${inherited}`), screen());
    goTo(label);
    type(KEY.right);
    assert.equal(notices.at(-1).level, 'warning');
    assert.ok(notices.at(-1).text.includes(`${label}: escolha um modelo com Enter`));
    assert.equal(bytes(), saved, '←/→ sem preset não grava');
    type(KEY.enter);
    assert.ok(screen().indexOf('Herdar padrão') < screen().indexOf('Haiku 4.5') && screen().includes('Herdar padrão'), screen());
    assert.doesNotMatch(screen(), /Blocked Google Chat|GPT Image/);
    for (const ch of 'astra') type(ch);
    type(KEY.enter);
    assert.deepEqual(readConfig().swarmModels?.[slot], { model: 'test/astra', thinking: 'medium' });
    assert.ok(rowOf(label).includes('Astra 6'), screen());
    const externalEdit = readConfig();
    externalEdit.extraDoUsuario.latestSlot = slot;
    externalEdit.swarmModels[slot] = { model: 'test/luna', thinking: 'xhigh' };
    writeFixture(externalEdit);
    type(KEY.right);
    const changed = structuredClone(externalEdit);
    changed.swarmModels[slot].thinking = 'off';
    assert.deepEqual(readConfig(), changed, 'thinking do preset não sobrescreve a edição concorrente');
    assert.match(rowOf(label), /Luna 6.*off/);
    assertWidths();
    type(KEY.left);
    assert.deepEqual(readConfig(), externalEdit, '← volta a xhigh');
    type(KEY.enter);
    externalEdit.swarmModels[slot].thinking = 'low';
    writeFixture(externalEdit);
    for (const ch of 'haiku') type(ch);
    type(KEY.enter);
    externalEdit.swarmModels[slot].model = 'test/haiku';
    assert.deepEqual(readConfig(), externalEdit, 'trocar o modelo no picker preserva o thinking mais recente');
    type(KEY.enter);
    for (const ch of 'herdar') type(ch);
    for (let i = 0; i < catalog.length && !/^→ Herdar padrão/m.test(screen()); i++) type(KEY.up);
    assert.match(screen(), /^→ Herdar padrão/m);

    type(KEY.enter);
    delete externalEdit.swarmModels;
    assert.deepEqual(readConfig(), externalEdit, 'Herdar padrão só remove o preset');
    assert.ok(rowOf(label).includes(`herda ${inherited}`), screen());
  }
  assert.equal(modelWrites, 0);
  assert.equal(thinkingWrites, 0);
  checks++; console.log('ok presets do swarm: herança, picker, thinking, remoção e larguras 40/60/80/120');

  // 5d. Erro em presets não desabilita o editor de papéis.
  type(KEY.esc); await done.pending;
  const invalidPreset = readConfig();
  invalidPreset.swarmModels = {
    writer: { model: 'test/astra', thinking: 'turbo' },
    reviewer: null,
    board: { model: 'test/luna', thinking: 'low' },
  };
  writeFixture(invalidPreset);
  done = await openPanel(extension);
  assert.match(rowOf('swarm writer'), /config inválida/);
  assert.match(rowOf('swarm reviewer'), /config inválida/);
  assert.match(rowOf('swarm board'), /Luna 6.*low/);
  goTo('scout');
  type(KEY.right);
  invalidPreset.roleModels.scout[0].thinking = 'high';
  assert.deepEqual(readConfig(), invalidPreset, 'erro em presets não bloqueia nem é alterado por escrita de papel');
  goTo('swarm board');
  type(KEY.right);
  invalidPreset.swarmModels.board.thinking = 'medium';
  assert.deepEqual(readConfig(), invalidPreset, 'thinking em slot válido preserva entradas inválidas');
  goTo('swarm writer');
  type(KEY.enter);
  for (const ch of 'astra') type(ch);
  type(KEY.enter);
  invalidPreset.swarmModels.writer.thinking = 'medium';
  assert.deepEqual(readConfig(), invalidPreset, 'substitui só o slot inválido escolhido');
  assert.match(rowOf('swarm writer'), /Astra 6.*medium/);
  assert.match(rowOf('swarm reviewer'), /config inválida/);
  goTo('swarm reviewer');
  type(KEY.enter);
  assert.match(screen(), /^→ Herdar padrão/m);
  type(KEY.enter);
  delete invalidPreset.swarmModels.reviewer;
  assert.deepEqual(readConfig(), invalidPreset, 'Herdar padrão remove a entrada inválida mesmo se for null');
  assert.match(rowOf('swarm reviewer'), /herda reviewer/);
  assert.ok(!notices.some(n => n.level === 'error'), JSON.stringify(notices));
  checks++; console.log('ok entradas inválidas isoladas e reparáveis: substituir ou voltar a herdar');

  // 6. Config quebrada: erro explícito, painel de pé, nada gravado.
  type(KEY.esc); await done.pending;
  writeFileSync(file, '{ invalid');
  done = await openPanel(extension);
  const broken = screen();
  assert.match(broken, /erro lendo .*models\.json/, `erro de config explícito:\n${broken}`);
  assert.ok(rowOf('worker').includes('config inválida'), 'papel marcado como config inválida');
  goTo('worker');
  type(KEY.enter);
  assert.equal(notices.at(-1).level, 'error');
  assert.equal(bytes(), '{ invalid', 'config quebrada não é reescrita pelo painel');
  type(KEY.esc); await done.pending;
  checks++; console.log('ok config inválida: erro explícito no painel, Enter recusa, arquivo intocado');

  // 7. Legado (sem piloto): Default + tiers seguem funcionando, com os papéis visíveis.
  delete process.env.AGENT_RUNTIME_ENABLED;
  writeFixture();
  const legacy = await loadExtensions([modelsPath], dir, createEventBus(), runtime);
  assert.deepEqual(legacy.errors, []);
  done = await openPanel(legacy.extensions[0]);
  const legacyScreen = screen();
  for (const label of ['Default', 'Fast', 'Standard', 'Deep', 'Visual', 'Image', 'scout', 'worker', 'planner', 'reviewer']) {
    assert.ok(new RegExp(`(^|\\s)${label}\\s`).test(legacyScreen), `legado mostra ${label}:\n${legacyScreen}`);
  }
  for (const [slot, inherited] of swarmSlots) {
    assert.ok(rowOf(`swarm ${slot}`).includes(`herda ${inherited}`), legacyScreen);
  }
  assertWidths();
  goTo('Fast');
  const concurrentTierEdit = readConfig();
  concurrentTierEdit.roleModels.scout.reverse();
  concurrentTierEdit.duringTierPanel = 'preservar';
  writeFixture(concurrentTierEdit);
  type(KEY.right);
  assert.equal(readConfig().tiers.fast.thinking, 'xhigh', '←→ ainda edita o thinking do tier');
  assert.deepEqual(readConfig().roleModels, concurrentTierEdit.roleModels, 'editar tier preserva preferências de papéis alteradas externamente');
  assert.equal(readConfig().duringTierPanel, 'preservar', 'editar tier preserva campos concorrentes');
  goTo('reviewer');
  const legacyRoleEdit = readConfig();
  legacyRoleEdit.roleModels.reviewer[0].thinking = 'low';
  type(KEY.left);
  assert.deepEqual(readConfig(), legacyRoleEdit, '← em papel também só edita o par ativo no modo legado');
  type(KEY.enter);
  assert.ok(screen().includes('autorizados neste papel'), 'papel abre a allowlist também no legado');
  assert.ok(!/GPT Image/.test(screen()), 'legado: modelo de imagem fora do picker de papel');
  type(KEY.esc); type(KEY.esc); await done.pending;
  assert.equal(modelWrites, 0); assert.equal(thinkingWrites, 0);
  checks++; console.log('ok legado não regrediu: Default/tiers editáveis e papéis visíveis');

  // 8. Negativo direto no helper: fora da allowlist é recusado, sem gravar.
  const req = createRequire(join(root, 'package.json'));
  const { createJiti } = req('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const tiers = await jiti.import(join(repo, 'agent/extensions/brain-live/lib/tiers.ts'));
  const snapshot = bytes();
  assert.throws(() => tiers.setRolePreference('scout', 'test/opus'), /is not allowed/);
  assert.throws(() => tiers.setRolePreference('inexistente', 'test/opus'), /has no allowed models/);
  assert.throws(() => tiers.setSwarmModel('writer', { model: 'test/google/gemini-test', thinking: 'high' }), /not the Pi API/);
  assert.equal(bytes(), snapshot, 'recusa não grava');
  checks++; console.log('ok helper recusa modelo fora da allowlist e papel inexistente');
  // 9. Malformed presets don't affect the same role lookup used by ordinary subagents.
  const bad = fixture();
  bad.swarmModels = { writer: { model: 'test/astra', thinking: 'turbo' }, board: { model: 'test/luna', thinking: 'high' } };
  writeFixture(bad);
  assert.deepEqual(tiers.getRoleModelChoices('worker'), bad.roleModels.worker);
  assert.throws(() => tiers.getSwarmModel('writer'), /invalid option in swarmModels/);
  assert.deepEqual(tiers.getSwarmModel('board'), bad.swarmModels.board);
  assert.equal(tiers.getSwarmModel('reviewer'), undefined);
  assert.deepEqual(tiers.loadSwarmModels(), { board: bad.swarmModels.board });

  // A malformed section has no individual slots to remove; choosing inheritance repairs it all.
  for (const section of [null, [], 'invalid']) {
    writeFixture({ ...fixture(), swarmModels: section });
    assert.throws(() => tiers.getSwarmModel('board'), /swarmModels.*must be an object/);
    done = await openPanel(legacy.extensions[0]);
    goTo('swarm writer');
    assert.match(rowOf('swarm writer'), /config inválida/);
    type(KEY.enter);
    assert.match(screen(), /^→ Herdar padrão/m);
    type(KEY.enter);
    assert.deepEqual(readConfig(), fixture(), 'Herdar padrão removes the malformed section');
    for (const [slot, inherited] of swarmSlots) {
      assert.match(rowOf(`swarm ${slot}`), new RegExp(`herda ${inherited}`));
      assert.equal(tiers.getSwarmModel(slot), undefined, 'dispatch can resolve the normal role');
    }
    type(KEY.esc); await done.pending;
  }
  checks++; console.log('ok Herdar padrão repara a seção inválida e dispatch volta a herdar');

  // Simulate a stale lock whose PID now belongs to the current live process.
  const subagentDir = join(repo, 'agent/extensions/brain-live/subagent');
  const { readProcessIdentity } = await jiti.import(join(subagentDir, 'process-owner.ts'));
  const { tryLock, readLock } = await jiti.import(join(subagentDir, 'lockfile.ts'));
  const identity = readProcessIdentity(process.pid);
  if (process.platform === 'darwin' || process.platform === 'linux') assert.ok(identity);
  if (identity) {
    const lockPath = `${file}.lock`;
    const orphan = tryLock(lockPath, { identity: { ...identity, start: `${identity.start}-old` } }, () => false);
    assert.ok(orphan.ok);
    try {
      tiers.setSwarmModel('writer', () => {
        const generation = readdirSync(vault).filter(name => /^agent-models\.json\.lock\.\d+$/.test(name))
          .sort((a, b) => Number(a.split('.').at(-1)) - Number(b.split('.').at(-1))).at(-1);
        assert.deepEqual(readLock(join(vault, generation)).identity, identity, 'the new holder records its identity');
        return { model: 'test/astra', thinking: 'high' };
      });
      assert.deepEqual(tiers.getSwarmModel('writer'), { model: 'test/astra', thinking: 'high' });
    } finally {
      orphan.release();
    }
    checks++; console.log('ok lock órfão recuperado mesmo com PID vivo reutilizado');
  }

  // 10. Hold the first process after it has read the config; the second tries to write
  // before the first is released. Without a transaction lock the role update is lost.
  writeFixture();
  const tiersUrl = pathToFileURL(join(repo, 'agent/extensions/brain-live/lib/tiers.ts')).href;
  const signalFile = (name) => join(dir, `writer-${name}`);
  const worker = (source) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import * as tiers from ${JSON.stringify(tiersUrl)};
      import { existsSync, writeFileSync } from 'node:fs';
      const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      function waitFor(path, timeout) {
        const until = Date.now() + timeout;
        while (!existsSync(path) && Date.now() < until) sleep(10);
        return existsSync(path);
      }
      ${source}
    `], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`config writer exited: ${code ?? signal}`)));
    });
  };
  await Promise.all([
    worker(`tiers.setSwarmModel('writer', () => {
      writeFileSync(${JSON.stringify(signalFile('read'))}, '');
      if (!waitFor(${JSON.stringify(signalFile('started'))}, 4000)) throw new Error('role writer did not start');
      waitFor(${JSON.stringify(signalFile('finished'))}, 350);
      return { model: 'test/astra', thinking: 'xhigh' };
    });`),
    worker(`if (!waitFor(${JSON.stringify(signalFile('read'))}, 4000)) throw new Error('swarm writer did not read');
      writeFileSync(${JSON.stringify(signalFile('started'))}, '');
      tiers.setRoleThinking('worker', 'low');
      writeFileSync(${JSON.stringify(signalFile('finished'))}, '');`),
  ]);
  const both = fixture();
  both.swarmModels = { writer: { model: 'test/astra', thinking: 'xhigh' } };
  both.roleModels.worker[0].thinking = 'low';
  assert.deepEqual(readConfig(), both, 'both concurrent process updates survive');
  checks += 2; console.log('ok presets inválidos isolados no dispatch; escritas concorrentes preservadas');
  console.log(`PASS /models por papel (${checks} blocos)`);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
}
