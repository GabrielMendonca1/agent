#!/usr/bin/env node
/**
 * Seletor minimalista de `/skill:` (Agent) — API pública do módulo real
 * `agent/extensions/agent/tui/skill-picker.ts`, sem rede, sem provedor e
 * sem ler o disco: catálogo vem de `pi.getCommands()` (comandos REAIS, aqui
 * injetados) cruzado com `loadSkillCategories()` (lido do módulo real do repo).
 *
 * Cobre: catálogo sem nomes fantasmas, losango da curadoria (injetada, nunca
 * duplicada na UI), filtro, navegação, Tab visitando outra categoria, Enter
 * inserindo `/skill:<nome> ` com espaço, Esc/abertura pelo texto e desenho em
 * largura curta.
 */
import assert from 'node:assert/strict';

import { AUTOMATIC_GLOBAL_SKILLS, isAutomaticSkill } from '../agent/core/skill-policy.mjs';
import { loadSkillCategories } from '../agent/core/skill-categories.mjs';
const COMMON_SKILLS = [...AUTOMATIC_GLOBAL_SKILLS, 'personal'];
import {
  AUTOMATIC_MARK,
  buildCatalog,
  commandFor,
  movePicker,
  nextCategoryView,
  openPicker,
  pickerQuery,
  renderPicker,
  shortDescription,
  visibleEntries,
  withQuery,
} from '../agent/extensions/agent/tui/skill-picker.ts';

const categories = loadSkillCategories();
assert.ok(categories.length === 4, `categorias do repo carregadas (${categories.length})`);

/** Comandos como `pi.getCommands()` entrega: só skills REALMENTE carregadas. */
const declared = [...new Set(categories.flatMap((t) => [...(t.skills ?? [])]))];
const INSTALLED = [...declared.filter((n) => n !== 'prototype'), ...COMMON_SKILLS];
const commands = [
  { name: '/compact', description: 'Compacta a conversa', source: 'extension' },
  ...INSTALLED.map((name) => ({
    name: `skill:${name}`,
    description: `Faz ${name} de verdade. Use quando precisar de ${name}; detalhe longo que não cabe numa linha curta de lista.`,
    source: 'skill',
  })),
];

/** Curadoria REAL do MAIN (nome + REGISTRO da categoria); a UI não tem lista própria. */
assert.equal(typeof isAutomaticSkill, 'function', 'curadoria expõe isAutomaticSkill');
assert.ok(AUTOMATIC_GLOBAL_SKILLS.includes('peers'), 'curadoria expõe as globais automáticas');

const catalog = buildCatalog({ commands, categories, isAutomaticSkill });

// ---- catálogo real, sem nomes fantasmas -----------------------------------
assert.deepEqual(catalog.categories, categories.map((t) => t.name), 'ordem das categorias é a do loadSkillCategories');
const designNames = catalog.byCategory.get('design').map((e) => e.name);
assert.ok(designNames.includes('ui-review') && designNames.includes('microcopy'), `design lista suas skills: ${designNames}`);
assert.ok(!designNames.includes('prototype'), 'skill declarada mas NÃO instalada fica fora do catálogo');
assert.deepEqual(catalog.common.map((e) => e.name), [...[...AUTOMATIC_GLOBAL_SKILLS].sort(), 'personal'], 'comuns instaladas entram no catálogo, automáticas primeiro');

// ---- automáticas vêm da curadoria, não da UI ------------------------------
const systemEntries = visibleEntries(catalog, openPicker(catalog, 'system'), isAutomaticSkill);
const auto = systemEntries.filter((e) => e.automatic).map((e) => e.name).sort();
const esperado = [...categories.find(t => t.name === 'system').skills, ...AUTOMATIC_GLOBAL_SKILLS].sort();
assert.deepEqual(auto, esperado, `automáticas de system vêm da curadoria (${auto}) e batem com o registro (${esperado})`);
assert.ok(auto.includes('html-plan'), 'html-plan é automática em system segundo a curadoria');
const semCuradoria = buildCatalog({ commands, categories });
assert.equal(
  visibleEntries(semCuradoria, openPicker(semCuradoria, 'system')).some((e) => e.automatic),
  false,
  'sem isAutomaticSkill a UI não inventa automáticas',
);

// ---- comuns em qualquer categoria, sem duplicar -----------------------------
for (const name of catalog.categories) {
  const entries = visibleEntries(catalog, openPicker(catalog, name), isAutomaticSkill);
  const names = entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, `${name}: sem duplicatas na lista`);
  for (const common of COMMON_SKILLS) assert.ok(names.includes(common), `${name}: comum ${common} na lista`);
}

// ---- abertura pelo texto (o `/sk`+Tab do autocomplete chega em `/skill:`) --
assert.equal(pickerQuery('/skill'), '', '`/skill` sem dois-pontos abre o seletor sem filtro');
assert.equal(pickerQuery('/skills'), undefined, 'outros comandos não abrem o seletor');
assert.equal(pickerQuery('/skilltdd'), undefined, 'filtro exige o separador de comando');
assert.equal(pickerQuery('/skill '), undefined, 'texto com espaço não abre o seletor');
assert.equal(pickerQuery('/skill:'), '', '`/skill:` abre o seletor sem filtro');
assert.equal(pickerQuery('/skill:ui-rev'), 'ui-rev', 'filtro é o que vem depois de `/skill:`');
assert.equal(pickerQuery('/skill:tdd '), undefined, 'com espaço (comando já inserido) o seletor fecha');
assert.equal(pickerQuery('/sk'), undefined, 'texto antes de `/skill:` não abre o seletor');
assert.equal(pickerQuery('fala do /skill:tdd'), undefined, 'menção no meio do texto não abre o seletor');
assert.equal(pickerQuery(''), undefined, 'input vazio não abre o seletor');
assert.equal(pickerQuery('/skill:a\nb'), undefined, 'texto multilinha (paste) não abre o seletor');

// ---- filtro ---------------------------------------------------------------
let state = openPicker(catalog, 'design');
assert.equal(state.category, 'design', 'abre na categoria da sessão');
state = withQuery(state, 'a11');
const filtered = visibleEntries(catalog, state, isAutomaticSkill).map((e) => e.name);
assert.deepEqual(filtered, ['a11y'], `filtro por nome: ${filtered}`);
assert.deepEqual(
  visibleEntries(catalog, withQuery(state, 'ZZZZ'), isAutomaticSkill),
  [],
  'filtro sem resultado devolve lista vazia (sem explodir)',
);
assert.equal(withQuery(state, 'a11').index, 0, 'filtro novo volta a seleção ao topo');
assert.equal(openPicker(catalog, 'inexistente').category, catalog.categories[0], 'categoria desconhecida cai no primeiro');

// ---- navegação ------------------------------------------------------------
let nav = openPicker(catalog, 'system');
const systemCount = visibleEntries(catalog, nav, isAutomaticSkill).length;
assert.ok(systemCount > 1, 'system tem mais de uma skill para navegar');
assert.equal(movePicker(nav, 1, systemCount).index, 1, '↓ desce');
assert.equal(movePicker(nav, -1, systemCount).index, systemCount - 1, '↑ no topo dá a volta');
assert.equal(movePicker({ ...nav, index: systemCount - 1 }, 1, systemCount).index, 0, '↓ no fim dá a volta');
assert.equal(movePicker(nav, 1, 0).index, 0, 'lista vazia mantém índice 0');

// ---- Tab visita outra categoria, sem trocar a sessão ------------------------
const visited = nextCategoryView(catalog, openPicker(catalog, 'system'));
assert.notEqual(visited.category, 'system', 'Tab muda a categoria VISITADO');
assert.equal(openPicker(catalog, 'system').category, 'system', 'a categoria da sessão não é alterado pelo seletor');
let volta = openPicker(catalog, 'system');
for (let i = 0; i < catalog.categories.length; i++) volta = nextCategoryView(catalog, volta);
assert.equal(volta.category, 'system', 'Tab circula e volta aa categoria de origem');
assert.equal(nextCategoryView(catalog, { ...visited, index: 3 }).index, 0, 'troca de categoria reseta a seleção');

// ---- Enter insere comando + espaço, sem enviar ----------------------------
const chosen = visibleEntries(catalog, openPicker(catalog, 'design'), isAutomaticSkill)[0];
assert.equal(commandFor(chosen), `/skill:${chosen.name} `, 'Enter insere `/skill:<nome> ` com espaço');
assert.equal(pickerQuery(commandFor(chosen)), undefined, 'depois de inserir, o seletor fecha sozinho');

// ---- descrição curta ------------------------------------------------------
assert.equal(shortDescription('Faz X. Use quando Y acontecer.'), 'Faz X', 'descrição curta = primeira frase');
assert.ok(shortDescription('a'.repeat(200)).length <= 64, 'descrição curta é limitada');
assert.equal(shortDescription(undefined), '', 'skill sem descrição não quebra');

// ---- desenho --------------------------------------------------------------
const plain = (lines) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
const wide = plain(renderPicker(catalog, openPicker(catalog, 'system'), 80, {}, isAutomaticSkill));
assert.ok(wide[0].includes('system'), `cabeçalho nomeia a categoria visitado: ${wide[0]}`);
assert.ok(wide.some((l) => l.includes('▸')), 'linha selecionada marcada');
assert.ok(wide.some((l) => l.includes('handoff') && l.includes(AUTOMATIC_MARK)), 'automática marcada com losango');
assert.ok(wide.some((l) => l.includes('Faz handoff')), 'descrição curta aparece ao lado do nome');
assert.ok(wide.some((l) => l.includes('enter inserir')), 'rodapé explica as teclas');
assert.ok(wide.every((l) => l.length <= 80), 'nada estoura a largura');
const narrow = plain(renderPicker(catalog, openPicker(catalog, 'system'), 28, {}, isAutomaticSkill));
assert.ok(narrow.every((l) => l.length <= 28), `largura curta respeitada:\n${narrow.join('\n')}`);
assert.ok(narrow.some((l) => l.includes('handoff')), 'em largura curta o nome continua visível');
assert.deepEqual(renderPicker(catalog, openPicker(catalog, 'system'), 4, {}, isAutomaticSkill), [], 'largura mínima não desenha nada');
const vazio = plain(renderPicker(catalog, withQuery(openPicker(catalog, 'system'), 'ZZZZ'), 80, {}, isAutomaticSkill));
assert.ok(vazio.some((l) => l.includes('nenhuma skill')), 'filtro sem resultado é dito na tela');
const many = buildCatalog({
  commands: Array.from({ length: 30 }, (_, i) => ({ name: `skill:s${i}`, description: 'x', source: 'skill' })),
  categories: [{ name: 'system', skills: Array.from({ length: 30 }, (_, i) => `s${i}`) }],
});
const rolled = plain(renderPicker(many, { category: 'system', query: '', index: 20 }, 80));
assert.ok(rolled.some((l) => l.includes('(21/30)')), `lista longa rola e mostra a posição:\n${rolled.join('\n')}`);
assert.ok(rolled.some((l) => /▸ s20\b/.test(l)), 'o selecionado fica dentro da janela rolada');
const painted = renderPicker(catalog, openPicker(catalog, 'system'), 80, { muted: (t) => `<m>${t}</m>` }, isAutomaticSkill);
assert.ok(painted.some((l) => l.includes('<m>')), 'pintura do tema (claro/escuro) é injetada por quem desenha');

console.log('ok: seletor de /skill: (catálogo real, filtro, Tab, Enter, Esc, largura curta)');
