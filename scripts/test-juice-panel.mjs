#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Extensão de modo do Mark (juice.ts) com o loader real do Pi e um ledger JSON:
// simple/complex, Shift+Tab, thinking/modelo intocados pelo modo, `subagent` liberado só em complex, categorias, rodapé
// nativo com modo e dica /next, estado de equipe e compactação por janela. Sem rede, sem modelo.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(homedir(), '.local/share/pi-overlay/current/lib/node_modules/@earendil-works/pi-coding-agent');
const load = async p => import(pathToFileURL(p).href);
const { loadExtensions, createExtensionRuntime } = await load(join(root, 'dist/core/extensions/loader.js'));
const { createEventBus } = await load(join(root, 'dist/core/event-bus.js'));
const bus = createEventBus();
const { initTheme } = await load(join(root, 'dist/modes/interactive/theme/theme.js'));
initTheme('dark', false);
const { visibleWidth } = await load(join(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'));
const dir = mkdtempSync(join(tmpdir(), 'mark-mode-'));
const saved = { ...process.env };
const juicePath = join(repo, 'mark/extensions/brain-live/juice.ts');
let markLineText = () => '';
const theme = { fg: (_color, text) => `\x1b[38;5;208m${text}\x1b[0m`, bold: text => text };
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');

// Runtime falso: registra o que a extensão pede ao Pi.
let thinking = 'medium', active = ['read', 'bash', 'edit', 'subagent'];
let thinkingWrites = 0, modelWrites = 0;
const all = () => ['read', 'bash', 'edit', 'subagent'].map(name => ({ name }));
const runtime = createExtensionRuntime();
Object.assign(runtime, { setThinkingLevel: l => { thinkingWrites++; thinking = l; }, getThinkingLevel: () => thinking, setModel: async m => { modelWrites++; ctx.model = m; return true; }, getActiveTools: () => [...active], getAllTools: all, setActiveTools: names => { active = [...names]; } });

let renders = 0, compacted = 0;
const statuses = new Map();
const notices = [];
let usage = { tokens: 0, percent: 0, contextWindow: 1_000_000 };
runtime.appendEntry = (customType, data) => branch.push({ type: 'custom', customType, data });
let branch = [], completions = [], answer = 'nenhuma';
const ctx = {
  cwd: dir, mode: 'tui', hasUI: true, isIdle: () => true,
  sessionManager: { getBranch: () => branch },
  modelRegistry: { find: (p, id) => ({ provider: p, id }), streamSimple: (_m, context) => ({ result: async () => { completions.push(context.messages[0].content[0].text); return { stopReason: 'stop', content: [{ type: 'text', text: answer }] }; } }) },
  model: { provider: 'fixture', id: 'fable-5.1' },
  getContextUsage: () => usage, compact: () => { compacted++; },
  ui: { setFooter: () => assert.fail('Juice must not replace the native footer'),
    setStatus: (key, value) => { renders++; if (value === undefined) statuses.delete(key); else statuses.set(key, value); }, notify: (text, level) => notices.push({ text, level }), confirm: async () => false },
};
const text = () => plain(statuses.get('mark-mode') ?? '');
const observed = () => globalThis[Symbol.for('mark.state')]();
let extension;
async function emit(name, event = {}) { for (const handler of extension.handlers.get(name) || []) await handler(event, ctx); }
async function emitResult(name, event = {}) { let out; for (const handler of extension.handlers.get(name) || []) out = (await handler(event, ctx)) ?? out; return out; }
const snapshot = { version: 2, runId: 'fixture', mode: 'simple', usd: 0.42, calls: { used: 0 }, output: { used: 0, reserved: 0 }, pending: [], receipts: [] };
const statePath = join(dir, 'run.v3.json');
function save() { writeFileSync(statePath, JSON.stringify(snapshot)); }
async function waitFor(predicate, what) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, what); await new Promise(r => setTimeout(r, 30)); }
}
try {
  delete process.env.MARK_JUICE_ENABLED;
  let loaded = await loadExtensions([juicePath], dir, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions[0].handlers.size, 0);
  assert.equal(loaded.extensions[0].commands.size, 0);
  assert.equal(loaded.extensions[0].shortcuts.size, 0);
  console.log('ok desligado: sem hooks, comandos ou atalhos');

  Object.assign(process.env, { MARK_JUICE_ENABLED: '1', MARK_JUICE_HOME: dir, MARK_JUICE_STATE: statePath });
  save();
  loaded = await loadExtensions([juicePath], dir, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  extension = loaded.extensions[0];
  assert.ok(extension.shortcuts.has('shift+tab'), 'Shift+Tab registrado');
  assert.ok(extension.commands.has('mode'), '/mode registrado');
  assert.ok(!extension.commands.has('juice') && !extension.commands.has('mass'), 'comandos antigos removidos');

  await emit('session_start');
  assert.ok(!existsSync(join(dir, '.mark')), 'sem .git não cria .mark/');
  mkdirSync(join(dir, '.git'));
  await emit('session_start');
  const wf = join(dir, '.mark/workflow.md');
  assert.ok(existsSync(wf), 'repositório git ganha .mark/workflow.md');
  assert.match(readFileSync(wf, 'utf8'), /^# Receita do Mark — mark-mode-/m);
  assert.match(readFileSync(wf, 'utf8'), /1\. scout · apoio · /);
  assert.equal(notices.length, 0, 'início silencioso');
  assert.equal(thinking, 'medium', 'modo não escolhe thinking: o nível do humano fica');
  assert.equal(thinkingWrites, 0, 'session_start não escreve thinking');
  assert.ok(active.includes('subagent'), 'subagent fica no schema em simple (cache)');
  assert.equal((await emitResult('tool_call', { toolName: 'subagent', input: {} }))?.block, true, 'simple bloqueia subagent na chamada');
  assert.match(text(), /simple$/);
  assert.equal(statuses.size, 1, 'only mode is published; native footer owns statistics');
  assert.equal(observed().usd, null, 'no duplicate ledger read for native footer');
  console.log('ok native mode status; no fallback footer or duplicate ledger cost');

  await extension.shortcuts.get('shift+tab').handler(ctx);
  assert.equal(branch.at(-1).data.mode, 'complex', 'modo salvo no branch');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).mode, 'simple', 'ledger não muda');
  assert.equal(JSON.parse(readFileSync(join(dir, 'preferences.v3.json'), 'utf8')).mode, 'simple', 'default global não muda');
  assert.equal(thinking, 'medium', 'Shift+Tab não mexe no thinking escolhido');
  assert.ok(active.includes('subagent'), 'complex com subagent');
  assert.equal((await emitResult('tool_call', { toolName: 'subagent', input: {} }))?.block, undefined, 'complex libera subagent');
  assert.match(text(), /complex$/);
  console.log('ok Shift+Tab: complex, thinking intocado, subagent ativo');

  // Sem gating de ferramentas extras; o único bloqueio é subagent em simple.
  assert.equal((await emitResult('tool_call', { toolName: 'generate_image', input: {} }))?.block, undefined);
  assert.equal(extension.shortcuts.has('ctrl+t'), false);
  const categoryEvent = { systemPromptOptions: { sections: {}, selectedTools: [], toolSnippets: {}, promptGuidelines: [], cwd: dir } };
  await emitResult('before_agent_start', categoryEvent);
  assert.match(categoryEvent.systemPromptOptions.sections.mark_skill_categories, /^design: a11y,/);
  assert.match(categoryEvent.systemPromptOptions.sections.mark_skill_categories, /\ndev: debug, tdd —[^\n]*\nplan: rea —/);
  const again = await emitResult('before_agent_start', categoryEvent);
  assert.equal(again?.message, undefined, 'mesmo modo não repete nota');

  // Leitor de compatibilidade ainda expõe observações, mas não instala rodapé.
  const markLine = globalThis[Symbol.for('mark.footer.line')];
  markLineText = () => markLine(theme).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(typeof markLine, 'function', 'juice registra a linha do Mark');
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const line2 = plain(markLine(theme));
  assert.match(line2, /^complex · clássico · apoio \S+ · cache — ttl (5m|1h) · API≈US\$ — · learn (on|off) · sob demanda (off|—|\d+\/\d+) · prefetch off$/, line2);
  await emit('message_end', { message: { role: 'assistant', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 5 } } });
  assert.match(plain(markLine(theme)), /cache 90%/, 'hit do último turno');
  const beforeMode = renders;
  await extension.shortcuts.get('shift+tab').handler(ctx);
  await extension.shortcuts.get('shift+tab').handler(ctx);
  assert.ok(renders >= beforeMode + 2, 'mode changes publish native status');

  // A extensão escuta mark:team pelo pi.events; emitimos pelo mesmo barramento.
  const emitTeam = (agents, status) => bus.emit('mark:team', { id: 'j1', agents, status });
  emitTeam(['scout'], 'running');
  assert.ok(observed().team.some(item => item.agent === 'scout' || item.name === 'scout'), 'team remains structured');
  const duringTeam = text();
  emitTeam(['scout'], 'completed'); emitTeam(['worker'], 'running'); emitTeam(['worker'], 'failed');
  assert.equal(text(), duringTeam, 'Juice does not duplicate mascot count in mode status');
  await emit('input', { text: 'nova tarefa' });
  assert.deepEqual(observed().team, [], 'new task clears team');
  snapshot.usd = 2.1; save();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(observed().usd, null, 'native footer does not watch ledger');
  assert.equal(text(), duringTeam);
  console.log('ok team structured, single status, no ledger watcher');

  await extension.commands.get('mode').handler('simple', ctx);
  assert.equal(thinking, 'medium'); assert.equal((await emitResult('tool_call', { toolName: 'subagent', input: {} }))?.block, true);
  await extension.commands.get('mode').handler('', ctx);
  assert.equal(thinking, 'medium', '/mode não mexe no thinking');
  await extension.commands.get('mode').handler('x', ctx);
  assert.equal(notices.at(-1).level, 'error');
  active = ['read', 'bash', 'edit', 'subagent'];
  await extension.commands.get('mode').handler('simple', ctx);
  active = ['read', 'bash', 'edit', 'subagent']; // outra extensão reativou tudo
  const opts = () => ({ selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: '', sections: {}, contextFiles: [], skills: [], cwd: dir });
  let run = { systemPromptOptions: opts() };
  await emit('before_agent_start', run);
  assert.equal((await emitResult('tool_call', { toolName: 'subagent', input: {} }))?.block, true, 'before_agent_start reaplica o modo');
  assert.equal(run.systemPromptOptions.sections.mark_workflow, undefined, 'receita é interna: nada no system prompt');
  console.log('ok /mode simple|complex|toggle; reaplica antes de cada run');

  // Regressão (bug relatado): modelo e thinking são escolha do humano e PERSISTEM em tudo
  // que o modo faz — trocar o thinking não troca o modelo, e trocar de modo/modelo não
  // devolve o thinking a um default do modo.
  {
    thinking = 'xhigh';
    const chosen = { provider: 'fixture', id: 'fable-9.9' };
    ctx.model = chosen;
    const writes = thinkingWrites;
    await emit('model_select', { model: chosen });
    assert.equal(thinking, 'xhigh', 'model_select não reescreve o thinking do humano');
    assert.deepEqual(ctx.model, chosen, 'nada troca o modelo escolhido');
    await emit('before_agent_start', { systemPromptOptions: opts() });
    assert.equal(thinking, 'xhigh', 'before_agent_start não reescreve o thinking');
    await extension.shortcuts.get('shift+tab').handler(ctx);
    await extension.shortcuts.get('shift+tab').handler(ctx);
    assert.equal(thinking, 'xhigh', 'ida e volta de modo preserva o thinking');
    assert.deepEqual(ctx.model, chosen, 'ida e volta de modo preserva o modelo');
    assert.equal(thinkingWrites, writes, 'extensão de modo nunca chama setThinkingLevel');
    assert.equal(modelWrites, 0, 'extensão de modo nunca chama setModel');
    assert.match(text(), /simple$/, 'native mode status remains independent of model');
    ctx.model = { provider: 'fixture', id: 'fable-5.1' };
    await emit('model_select', { model: ctx.model });
    thinking = 'medium';
    console.log('ok modelo e thinking manuais sobrevivem a modo, model_select e cada run');
  }

  // Receita invisível: regra nova, equipe customizada e prompt forçado do Vault nunca
  // levam a receita ao modelo principal — nem como seção, nem como nota.
  writeFileSync(wf, readFileSync(wf, 'utf8')
    .replace('(nenhuma ainda)', '- teste roda com `node scripts/test-*.mjs`')
    .replace('3. reviewer · principal', '3. reviewer · apoio'));
  await extension.commands.get('mode').handler('complex', ctx);
  run = { systemPromptOptions: opts() };
  let out = await emitResult('before_agent_start', run);
  assert.equal(run.systemPromptOptions.sections.mark_workflow, undefined, 'complex também não manda a receita');
  assert.doesNotMatch(out?.message?.content ?? '', /Receita|workflow\.md|scout|reviewer/, 'receita não vira nota na conversa');
  run = { systemPromptOptions: opts() };
  out = await emitResult('before_agent_start', run);
  assert.equal(run.systemPromptOptions.sections.mark_workflow, undefined, 'nenhum run reintroduz a seção');
  run = { systemPromptOptions: { ...opts(), forceSystemPrompt: 'PROMPT DO VAULT' } };
  const forcedOut = (await emitResult('before_agent_start', run))?.systemPrompt ?? '';
  assert.doesNotMatch(forcedOut, /mark_workflow|scout|reviewer/, 'prompt forçado do Vault não recebe a receita');
  assert.match(forcedOut, /^PROMPT DO VAULT\n\n<mark_autonomy>/, 'no prompt forçado só entram as políticas globais');
  await emit('session_start');
  writeFileSync(wf, readFileSync(join(repo, '.mark/workflow.md'), 'utf8'));
  console.log('ok receita fora do modelo principal (seção, nota e prompt forçado)');
  const { createJiti } = await load(join(root, 'node_modules/jiti/lib/jiti.mjs'));
  const { renderSystemPrompt } = await createJiti(import.meta.url, { moduleCache: false }).import(join(repo, 'mark/extensions/brain-live/vault-runtime.ts'));
  const vault = join(dir, 'vault'); mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'system-prompt.md'), 'Vault\nCurrent working directory: {{PI_CWD}}');
  const rendered = renderSystemPrompt('base', vault, { cwd: '/x', sections: { mark_workflow: 'RECEITA' } });
  assert.equal(rendered, 'Vault\nCurrent working directory: /x\n\n<mark_workflow>\nRECEITA\n</mark_workflow>', 'vault-runtime não descarta seções de extensões');
  writeFileSync(join(vault, 'system-prompt.md'), 'A\n{{PI_EXTRA_SECTIONS}}\nB');
  assert.equal(renderSystemPrompt('base', vault, { sections: { mark_workflow: 'R' } }), 'A\n<mark_workflow>\nR\n</mark_workflow>\nB');
  writeFileSync(join(vault, 'system-prompt.md'), 'Tools:\n{{#PI_TOOL grep}}\n- grep\n{{/PI_TOOL}}\n{{#PI_TOOL read}}\n- read\n{{/PI_TOOL}}\nFim');
  assert.equal(renderSystemPrompt('base', vault, { selectedTools: ['read'] }), 'Tools:\n- read\nFim', 'tool inativa não deixa linha em branco');
  // Prompt estável: descreve todas as tools registradas, ativas ou não.
  const { stableDynamics } = await createJiti(import.meta.url, { moduleCache: false }).import(join(repo, 'mark/extensions/brain-live/vault-runtime.ts'));
  const registry = { getAllTools: () => [
    { name: 'read', description: 'Lê', exposure: 'direct', promptGuidelines: ['g-read'] },
    { name: 'grep', description: 'Busca\nmais', exposure: 'direct', promptGuidelines: ['g-grep'] },
    { name: 'secret', description: 'x', exposure: 'hidden' },
  ] };
  const onlyRead = stableDynamics(registry, { selectedTools: ['read'], toolSnippets: { read: 'Lê arquivos' }, promptGuidelines: ['g-read', 'geral'] });
  const both = stableDynamics(registry, { selectedTools: ['read', 'grep'], toolSnippets: { read: 'Lê arquivos', grep: 'Busca' }, promptGuidelines: ['g-read', 'g-grep', 'geral'] });
  assert.deepEqual(onlyRead.selectedTools, ['read', 'grep'], 'hidden fica fora');
  assert.deepEqual(onlyRead.promptGuidelines, both.promptGuidelines, 'guidelines não dependem das ativas');
  assert.equal(renderSystemPrompt('base', vault, onlyRead), renderSystemPrompt('base', vault, both), 'prompt idêntico com qualquer conjunto ativo');
  const notes = [];
  for (const mode of ['simple', 'simple', 'complex', 'complex', 'simple']) {
    await extension.commands.get('mode').handler(mode, ctx);
    notes.push((await emitResult('before_agent_start', { systemPromptOptions: opts() }))?.message?.content ?? null);
  }
  assert.deepEqual(notes.map((n) => n && n.split(':')[1].trim().split(' ')[0]), ['simple', null, 'complex', null, 'simple'], 'nota de modo só quando muda');
  rmSync(wf);
  console.log('ok vault-runtime: seções de extensão, prompt estável; nota de modo só na troca');

  // Políticas GLOBAIS no system prompt: autonomia nos dois modos; complex só em complex.
  // Usa o montador de prompt do Pi clássico e prompts forçados por extensões
  // para medir o texto que o modelo vê de fato.
  {
    const { buildSystemPrompt, buildSystemPromptSections, diffSystemPromptSections } = await load(join(root, 'dist/core/system-prompt.js'));
    const AUT = 'Autonomia do Mark (vale em qualquer modo):';
    const CPX = 'Modo complex (vale só enquanto o modo for complex):';
    const count = (text, needle) => text.split(needle).length - 1;
    const run = async (mode, extra = {}) => {
      await extension.commands.get('mode').handler(mode, ctx);
      const options = { ...opts(), ...extra };
      const out = await emitResult('before_agent_start', { systemPromptOptions: options });
      if (out?.systemPrompt !== undefined) options.forceSystemPrompt = out.systemPrompt; // o runner do Pi faz isso
      return { options, out, prompt: options.forceSystemPrompt ?? buildSystemPrompt(options) };
    };

    // Clássico (prompt montado por seções).
    const simple = await run('simple');
    assert.deepEqual(Object.keys(simple.options.sections), ['mark_skill_categories', 'mark_autonomy'], 'simple: só a seção de autonomia');
    assert.equal(count(simple.prompt, AUT), 1, 'simple: autonomia exatamente uma vez');
    assert.equal(count(simple.prompt, CPX), 0, 'simple: nenhuma instrução de complex');
    assert.equal(count(simple.prompt, 'subagent'), 0, 'simple: nada de equipe no system');
    const simpleAgain = await run('simple');
    assert.equal(simpleAgain.prompt, simple.prompt, 'mesmo modo, mesmo texto (prefixo de cache intacto)');
    const complex = await run('complex');
    assert.deepEqual(Object.keys(complex.options.sections), ['mark_skill_categories', 'mark_autonomy', 'mark_complex'], 'complex: as duas seções');
    assert.equal(count(complex.prompt, AUT), 1, 'complex: autonomia uma vez');
    assert.equal(count(complex.prompt, CPX), 1, 'complex: política de complex uma vez');
    assert.ok(complex.prompt.startsWith(simple.prompt), 'complex = simple + bloco de complex no fim');
    assert.equal((await run('complex')).prompt, complex.prompt, 'complex estável entre turnos');
    const back = await run('simple');
    assert.equal(back.prompt, simple.prompt, 'voltar a simple devolve o texto de simple');
    const patch = diffSystemPromptSections(buildSystemPromptSections(complex.options), buildSystemPromptSections(back.options));
    assert.equal(patch.mark_complex, null, 'complex→simple remove a seção do system (o Pi manda null)');
    assert.equal(Object.keys(patch).length, 1, 'nada mais muda no system ao trocar de modo');

    // Prompt forçado (Vault no clássico): as políticas entram no texto, uma vez.
    const forcedComplex = await run('complex', { forceSystemPrompt: 'PROMPT DO VAULT' });
    assert.match(forcedComplex.prompt, /^PROMPT DO VAULT\n\n<mark_autonomy>\n[\s\S]*\n<\/mark_autonomy>\n\n<mark_complex>\n[\s\S]*\n<\/mark_complex>\n\n<mark_skill_categories>[\s\S]*<\/mark_skill_categories>$/, forcedComplex.prompt);
    const forcedSimple = await run('simple', { forceSystemPrompt: 'PROMPT DO VAULT' });
    assert.match(forcedSimple.prompt, /^PROMPT DO VAULT\n\n<mark_autonomy>\n[\s\S]*\n<\/mark_autonomy>\n\n<mark_skill_categories>[\s\S]*<\/mark_skill_categories>$/, forcedSimple.prompt);
    assert.equal(count(forcedSimple.prompt, CPX), 0, 'forçado em simple: sem complex');

    // Ordem dos handlers: juice antes OU depois do vault-runtime, no clássico. A
    // política tem de aparecer exatamente uma vez no prompt que sai (risco real de
    // duplicar pela seção + texto forçado, ou de sumir se ninguém a levar).
    const vaultPath = join(repo, 'mark/extensions/brain-live/vault-runtime.ts');
    // Estes loads extras publicam os mesmos símbolos globais (estado/rodapé); guarde os da
    // sessão real para devolver no fim, senão o resto do teste observa a instância solta.
    const ownedGlobals = [Symbol.for('mark.state'), Symbol.for('mark.footer.line')].map((key) => [key, globalThis[key]]);
    const sistema = join(dir, 'sistema');
    mkdirSync(join(sistema, 'Pi/skills'), { recursive: true });
    writeFileSync(join(sistema, 'Pi/system-prompt.md'), 'PROMPT DO VAULT\n\n{{PI_EXTRA_SECTIONS}}\n\nFIM');
    process.env.PI_SYSTEM_DIR = sistema;
    writeFileSync(join(dir, '.mark/notes.md'), 'docs/private.md — privado\n');
    try {
      for (const [first, second] of [[juicePath, vaultPath], [vaultPath, juicePath]]) {
        for (const host of ['clássico']) {
          for (const mode of ['simple', 'complex']) {
            const where = `${basename(first)} primeiro, ${host}, ${mode}`;
            const rt = createExtensionRuntime();
            Object.assign(rt, { setThinkingLevel() {}, getThinkingLevel: () => 'low', getActiveTools: () => [...active], getAllTools: all, setActiveTools() {}, appendEntry: runtime.appendEntry });
            const pack = await loadExtensions([first, second], dir, createEventBus(), rt);
            assert.deepEqual(pack.errors, [], where);
            branch = [];
            writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode, supportModel: 'fixture/haiku' }));
            for (const ext of pack.extensions) for (const h of ext.handlers.get('session_start') || []) await h({ reason: 'startup' }, ctx);
            const options = opts();
            for (const ext of pack.extensions) for (const h of ext.handlers.get('before_agent_start') || []) {
              const out = await h({ systemPromptOptions: options, systemPrompt: 'BASE' }, ctx);
              if (out?.systemPrompt !== undefined) options.forceSystemPrompt = out.systemPrompt;
            }
            delete process.env.MARK_JUICE_PI_ENTRY;
            const prompt = options.forceSystemPrompt ?? buildSystemPrompt(options);
            assert.equal(count(prompt, 'Mapa de notas do projeto'), 1, `notas uma vez — ${where}`);
            assert.doesNotMatch(prompt, /docs\/private.md|privado/, `conteúdo do mapa fora — ${where}`);
            assert.equal(count(prompt, AUT), 1, `autonomia uma vez — ${where}:\n${prompt}`);
            assert.equal(count(prompt, CPX), mode === 'complex' ? 1 : 0, `complex conforme o modo — ${where}:\n${prompt}`);
            assert.doesNotMatch(prompt, /mark_workflow|Receita do Mark/, `receita fora do principal — ${where}`);
            for (const ext of pack.extensions) for (const h of ext.handlers.get('session_shutdown') || []) await h({ reason: 'quit' }, ctx);
          }
        }
      }
    } finally {
      delete process.env.PI_SYSTEM_DIR;
      rmSync(join(dir, '.mark/notes.md'));
      for (const [key, value] of ownedGlobals) globalThis[key] = value;
    }

    // Filho (subagente) não recebe política do principal.
    process.env.MARK_JUICE_CHILD = '1';
    try {
      const child = await run('complex', { forceSystemPrompt: 'PROMPT DO FILHO' });
      assert.equal(child.prompt, 'PROMPT DO FILHO', 'filho: prompt intacto');
      assert.deepEqual(Object.keys(child.options.sections), [], 'filho: nenhuma seção de política');
    } finally { delete process.env.MARK_JUICE_CHILD; }
    await extension.commands.get('mode').handler('simple', ctx);
    console.log('ok políticas globais: autonomia nos dois modos, complex só em complex (clássico e forçado)');
  }
  await emit('session_start');

  // Mapa de notas: snapshot por sessão nas duas vias; /notes usa arquivos atuais.
  {
    const { notesSection } = await import('../mark/juice/policy.mjs');
    const map = join(dir, '.mark/notes.md');
    writeFileSync(map, 'docs/known.md — CONTEÚDO PRIVADO\n\n');
    await emit('session_start');
    const expected = notesSection({ count: 1, ageDays: 0 });
    const classic = { systemPromptOptions: opts() };
    await emitResult('before_agent_start', classic);
    assert.equal(classic.systemPromptOptions.sections.mark_notes, expected.slice(12, -13));
    writeFileSync(map, 'docs/known.md — alterado\ndocs/new.md — outra\n');
    for (const host of ['classic']) {
      process.env.MARK_JUICE_PI_ENTRY = host;
      let base = 'BASE';
      for (let turn = 0; turn < 3; turn++) {
        const out = await emitResult('before_agent_start', { systemPromptOptions: { ...opts(), forceSystemPrompt: base } });
        const delta = out.systemPrompt.slice(base.length);
        assert.ok(delta.endsWith(expected), 'ponteiro congelado e depois das políticas/categorias');
        assert.equal(delta.split('<mark_notes>').length - 1, 1);
        assert.doesNotMatch(delta, /CONTEÚDO PRIVADO|docs\/known|docs\/new/);
        base = out.systemPrompt;
      }
    }
    delete process.env.MARK_JUICE_PI_ENTRY;
    const requests = [];
    runtime.sendUserMessage = (text, options) => requests.push({ text, options });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/known.md'), 'known');
    writeFileSync(join(dir, 'docs/missing.md'), 'missing');
    await extension.commands.get('notes').handler('', ctx);
    assert.match(requests[0].text, /docs\/missing.md/);
    assert.doesNotMatch(requests[0].text, /docs\/known.md/);
    assert.match(requests[0].text, /caminho — assunto/);
    assert.deepEqual(requests[0].options, { deliverAs: 'followUp' });
    rmSync(map);
    await extension.commands.get('notes').handler('', ctx);
    assert.match(requests[1].text, /docs\/known.md/);
    await emit('session_start');
    const empty = { systemPromptOptions: opts() };
    await emitResult('before_agent_start', empty);
    assert.equal(empty.systemPromptOptions.sections.mark_notes, undefined);
    rmSync(join(dir, 'docs'), { recursive: true });
    console.log('ok notes: snapshot estável, clássico, sem conteúdo, /notes cria/atualiza mapa');
  }

  // Aprender do trabalho real: opt-in, checks verdes e apoio; grava regras e versão.
  process.env.MARK_LEARN = '1';
  writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: 'fixture/haiku' }));
  mkdirSync(join(dir, '.pi'), { recursive: true });
  writeFileSync(join(dir, '.pi/checks.json'), JSON.stringify({ checks: [{ name: 't', cmd: 'node scripts/test-x.mjs' }] }));
  const msg = (role, content, extra = {}) => ({ type: 'message', message: { role, content, ...extra } });
  const runOf = (checkOut, isError = false) => [
    msg('user', [{ type: 'text', text: 'conserta o bug' }]),
    msg('assistant', [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'node scripts/test-x.mjs' } }]),
    msg('toolResult', [{ type: 'text', text: checkOut }], { toolCallId: 'c1', toolName: 'bash', isError }),
    msg('assistant', [{ type: 'text', text: 'Pronto: corrigido em scripts/lib/x.mjs.' }]),
  ];
  branch = runOf('# pass 3\n# fail 1', true); answer = '- regra que não deve entrar';
  await emit('agent_settled');
  assert.equal(completions.length, 0, 'check vermelho não chama modelo');
  branch = runOf('# pass 4\n# fail 0'); answer = '- teste roda com `node scripts/test-x.mjs`\n- código fica em scripts/lib/\n- curta\n- terceira regra válida\n- quarta regra ignorada';
  delete process.env.MARK_LEARN;
  const beforeOptIn = readFileSync(wf, 'utf8');
  await emit('agent_settled');
  assert.equal(completions.length, 0, 'default não chama apoio mesmo com check verde');
  assert.equal(readFileSync(wf, 'utf8'), beforeOptIn, 'default preserva receita existente');
  assert.equal(globalThis[Symbol.for('mark.state')]().learn, false, 'rodapé reflete opt-in ausente');
  process.env.MARK_LEARN = '1';
  await emit('agent_settled');
  assert.equal(completions.length, 1, 'check verde chama o apoio uma vez');
  assert.match(completions[0], /Regras existentes: nenhuma/);
  let wtext = readFileSync(wf, 'utf8');
  assert.match(wtext, /^versão: v2$/m);
  assert.match(wtext.replaceAll(" [by: Mark; proven: no]", ""), /- teste roda com `node scripts\/test-x\.mjs`\n- código fica em scripts\/lib\/\n- terceira regra válida\n/, 'até 3 regras; curta demais é descartada');
  assert.doesNotMatch(wtext, /nenhuma ainda|quarta regra|- curta/);
  assert.match(notices.at(-1).text, /receita v2: 3 regra/);
  const hist = JSON.parse(readFileSync(join(dir, '.mark/history.json'), 'utf8'));
  assert.equal(hist[0].proven, 'no');
  assert.match(wtext, /\[by: Mark; proven: no\]/);
  assert.equal(hist.length, 1); assert.equal(hist[0].version, 'v2'); assert.deepEqual(hist[0].added.length, 3);
  branch = runOf('# pass 4\n# fail 0'); answer = '- Teste roda com node scripts/test-x.mjs\n- nova regra';
  await emit('agent_settled');
  wtext = readFileSync(wf, 'utf8');
  assert.match(wtext, /^versão: v3$/m);
  assert.equal((wtext.match(/^- /gm) || []).length, 4, 'duplicada (case/pontuação) não entra');
  assert.match(completions[1], /Regras existentes:\n- teste roda/);
  branch = runOf('# pass 4\n# fail 0'); answer = 'nenhuma';
  await emit('agent_settled');
  assert.match(readFileSync(wf, 'utf8'), /^versão: v3$/m, 'sem regra, sem versão nova');
  writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: null }));
  branch = runOf('# pass 4\n# fail 0'); answer = '- x';
  await emit('agent_settled');
  assert.equal(completions.length, 3, 'sem apoio não aprende (nunca o principal)');
  writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: 'fixture/haiku' }));
  console.log('ok aprender do trabalho real: verde → apoio → regras, versão, history; vermelho/sem apoio → nada');

  // Sessão A → B: o cache da A não aparece na B; não existe mais estado de prova.
  {
    const line = () => markLineText();
    // Custo da sessão continua estruturado; /cost mantém o ledger cumulativo.
    const markStateFn = globalThis[Symbol.for('mark.state')];
    assert.equal(typeof markStateFn, 'function', 'juice publica o estado observado para a TUI do Mark');
    const sessionUsd = () => markStateFn().sessionUsd;
    const spent = sessionUsd();
    await emit('message_end', { message: { role: 'assistant', usage: { input: 10, cacheRead: 90, cacheWrite: 0, cost: { total: 0.12 } } } });
    await emit('message_end', { message: { role: 'assistant', usage: { input: 10, cacheRead: 90, cacheWrite: 0, cost: { total: 0.03 } } } });
    assert.ok(Math.abs(sessionUsd() - (spent + 0.15)) < 1e-9, `custo da sessão soma os turnos: ${sessionUsd()}`);
    await emit('message_end', { message: { role: 'user', usage: { cost: { total: 9 } } } });
    assert.ok(Math.abs(sessionUsd() - (spent + 0.15)) < 1e-9, 'só mensagem assistant entra no custo da sessão');
    assert.equal(markStateFn().usd, null, 'ledger stays available via /cost, not duplicate UI reads');
    assert.match(line(), /cache 90%/);
    branch = runOf('# pass 4\n# fail 0'); answer = '- regra da sessão A';
    await emit('agent_settled');
    await emit('session_start');
    assert.equal(sessionUsd(), 0, 'session_start zera o custo da sessão');
    assert.doesNotMatch(line(), /cache 90%|prova/, 'sessão B nasce sem cache/prova da A');
    assert.match(line(), /cache —/);
    assert.doesNotMatch(text(), /prova/, 'prova removida do rodapé');
    assert.doesNotMatch(line(), /prova/);
    for (const [k, v] of [['MARK_JUICE_CHILD', '1']]) {
      process.env[k] = v;
      assert.match(line(), /learn off/, `${k} desliga learn no rodapé (mesma condição do learnFromRun)`);
      delete process.env[k];
    }
    assert.match(line(), /learn on/, 'apoio definido e fora de filho: learn on');
    console.log('ok sessão nova zera cache; sem prova local; learn segue a elegibilidade real');
  }

  branch = []; // sem run: agent_settled abaixo não aprende nem prova
  // Produtor real publica texto simples em chave própria, sem substituir o footer.
  for (const tokens of [60_001, 60_000, 60_001, 59_999]) {
    usage = { tokens, percent: tokens / 10_000, contextWindow: 1_000_000 };
    await emit('agent_settled');
    assert.equal(statuses.get('mark-next'), tokens > 60_000 ? '/next encerra a tarefa' : undefined);
    assert.equal(observed().nextHint, tokens > 60_000);
    assert.deepEqual([...statuses.keys()].filter(key => key.startsWith('mark-')).sort(), tokens > 60_000 ? ['mark-mode', 'mark-next'] : ['mark-mode']);
  }
  usage = { tokens: 60_001, percent: 6, contextWindow: 1_000_000 };
  await emit('agent_settled');
  await emit('session_start', { reason: 'reload' });
  assert.equal(statuses.has('mark-next'), false, 'reload clears the previous hint');
  await emit('agent_settled');
  assert.equal(statuses.get('mark-next'), '/next encerra a tarefa');
  await emit('session_shutdown');
  assert.equal(statuses.has('mark-mode'), false, 'shutdown clears mode');
  assert.equal(statuses.has('mark-next'), false, 'shutdown clears active hint');
  const disposedRenders = renders;
  await emit('tool_result');
  assert.equal(renders, disposedRenders, 'disposed producer cannot republish statuses');
  await emit('session_start');
  assert.equal(statuses.has('mark-next'), false, 'new session starts without hint');
  console.log('ok native /next status: >60k publishes, <=60k/reload/shutdown clear');

  usage = { tokens: 449_000, percent: 45, contextWindow: 1_000_000 };
  await emit('agent_settled'); assert.equal(compacted, 0);
  usage = { tokens: 451_000, percent: 45, contextWindow: 1_000_000 };
  await emit('agent_settled'); assert.equal(compacted, 1, '1M compacta em ~450k');
  await emit('agent_settled'); assert.equal(compacted, 1, 'não empilha compactação em voo');
  await emit('session_compact'); // SDK informa que a primeira terminou
  usage = { tokens: 179_000, percent: 89, contextWindow: 200_000 };
  await emit('agent_settled'); assert.equal(compacted, 1);
  usage = { tokens: 181_000, percent: 90.5, contextWindow: 200_000 };
  await emit('agent_settled'); assert.equal(compacted, 2, 'menores compactam faltando 10%');
  console.log('ok compactação: 450k em 1M, 10% nas menores');

  // Real Pi branches: independent sessions, persisted resume, fork and reload.
  {
    const { SessionManager } = await load(join(root, 'dist/core/session-manager.js'));
    const globals = [Symbol.for('mark.state'), Symbol.for('mark.footer.line')].map(key => [key, globalThis[key]]);
    const make = async (manager, start = true) => {
      const context = { ...ctx, sessionManager: manager };
      const rt = createExtensionRuntime();
      Object.assign(rt, {
        getActiveTools: () => [...active], getAllTools: all, setActiveTools() {},
        appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      });
      const pack = await loadExtensions([juicePath], dir, createEventBus(), rt);
      assert.deepEqual(pack.errors, []);
      const ext = pack.extensions[0];
      const fire = async (name, event = {}, eventContext = context) => {
        let result;
        for (const h of ext.handlers.get(name) || []) result = (await h(event, eventContext)) ?? result;
        return result;
      };
      if (start) await fire('session_start', { reason: 'startup' });
      return { context, ext, fire, mode: value => ext.commands.get('mode').handler(value, context),
        view: globalThis[Symbol.for('mark.state')] };
    };
    const sessions = [];
    try {
      writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode: 'simple', supportModel: null }));
      const aManager = SessionManager.create(dir, join(dir, 'sessions'));
      aManager.appendMessage({ role: 'user', content: 'A', timestamp: Date.now() });
      const a = await make(aManager); sessions.push(a);
      const simpleLeaf = aManager.getLeafId();
      await a.mode('complex');
      const complexLeaf = aManager.getLeafId();
      const bManager = SessionManager.create(dir, join(dir, 'sessions'));
      const b = await make(bManager); sessions.push(b);
      assert.equal(existsSync(bManager.getSessionFile()), false, 'native mode entry before the first message needs no file');
      assert.equal(bManager.getBranch().at(-1).data.mode, 'simple');
      await b.mode('simple');
      for (const [session, mode] of [[a, 'complex'], [b, 'simple']]) {
        const event = { systemPromptOptions: opts() };
        await session.fire('before_agent_start', event);
        assert.equal(!!event.systemPromptOptions.sections.mark_complex, mode === 'complex');
        assert.equal((await session.fire('tool_call', { toolName: 'subagent' }))?.block === true, mode === 'simple');
        assert.equal(session.view().mode, mode);
      }
      // A changed default and ledger cannot change a saved branch.
      writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode: 'simple', supportModel: null }));
      snapshot.mode = 'simple'; save();
      const resumed = await make(SessionManager.open(aManager.getSessionFile())); sessions.push(resumed);
      assert.equal(resumed.view().mode, 'complex', 'resume restores saved complex');
      await resumed.fire('session_start', { reason: 'reload' });
      assert.equal(resumed.view().mode, 'complex', 'reload restores saved complex');
      const forked = await make(SessionManager.forkFrom(aManager.getSessionFile(), dir, join(dir, 'forks'))); sessions.push(forked);
      assert.equal(forked.view().mode, 'complex', 'fork inherits saved branch mode');
      await forked.mode('simple');
      assert.equal(resumed.view().mode, 'complex', 'fork mode does not change parent');
      aManager.branch(simpleLeaf);
      await a.fire('session_tree');
      assert.equal(a.view().mode, 'simple', 'tree reads selected branch');
      aManager.branch(complexLeaf);
      await a.fire('session_tree');
      assert.equal(a.view().mode, 'complex');
      aManager.appendCustomEntry('mark-mode', { version: 2, mode: 'complex' });
      assert.match((await a.fire('tool_call', { toolName: 'subagent' })).reason, /modo da sessão inválido/);
      await a.mode('simple'); // Explicit user change repairs an invalid record.
      const before = bManager.getBranch().length;
      await b.fire('session_start', { reason: 'reload' });
      assert.equal(bManager.getBranch().length, before, 'initial default saved only once');
      const getBranch = b.context.sessionManager.getBranch;
      b.context.sessionManager.getBranch = () => { throw new Error('branch unreadable'); };
      assert.match((await b.fire('tool_call', { toolName: 'subagent' })).reason, /branch unreadable/);
      b.context.sessionManager.getBranch = getBranch;
      // Independent Jiti loaders must use the native ESM guard, including reload.
      const { createJiti } = await load(join(root, 'node_modules/jiti/lib/jiti.mjs'));
      const modePath = join(repo, 'mark/extensions/brain-live/lib/session-mode.mjs');
      const first = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(modePath);
      const second = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(modePath);
      const native = await load(modePath);
      assert.equal(first.saveSessionMode, second.saveSessionMode, 'independent Jiti loaders share the helper');
      assert.equal(first.readSessionMode, native.readSessionMode, 'Jiti uses the native ESM instance');
      const guardedManager = SessionManager.inMemory(dir);
      const original = await make(guardedManager); sessions.push(original);
      const failingPi = { appendEntry(type, data) {
        guardedManager.appendCustomEntry(type, data);
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      } };
      assert.throws(() => first.saveSessionMode(failingPi, original.context, 'complex'), /EACCES/);
      assert.equal(guardedManager.getBranch().at(-1).data.mode, 'complex', 'failure leaves complex in memory');
      assert.throws(() => second.readSessionMode({ ...original.context }), /falha ao salvar/);
      assert.throws(() => second.ensureSessionMode(failingPi, { ...original.context }), /falha ao salvar/);
      const reloaded = await make(guardedManager, false); sessions.push(reloaded);
      await assert.rejects(() => reloaded.fire('session_start', { reason: 'reload' }), /falha ao salvar/);
      for (const session of [original, reloaded]) {
        const blocked = await session.fire('tool_call', { toolName: 'subagent' });
        assert.equal(blocked.block, true);
        assert.match(blocked.reason, /falha ao salvar/);
      }
      await reloaded.mode('complex');
      assert.equal(first.readSessionMode(original.context), 'complex', 'explicit recovery clears the shared guard');
      assert.equal(second.readSessionMode(reloaded.context), 'complex');
      for (const session of [original, reloaded]) {
        assert.equal(await session.fire('tool_call', { toolName: 'subagent' }), undefined);
      }
      console.log('ok guard compartilhado: Jiti x2, ESM nativo, novo loader Pi, failclosed e recuperação explícita');
      // Pi 1.5 rolls back _appendEntry when _persist throws. The failure latch
      // must still block until explicit recovery. The dirty-branch case above
      // separately proves that an append-then-throw cannot authorize complex.
      for (const code of ['EACCES', 'ENOSPC']) {
        await a.mode('simple');
        const persist = aManager._persist;
        const branchBeforeFailure = aManager.getBranch();
        const leafBeforeFailure = aManager.getLeafId();
        try {
          aManager._persist = () => { throw Object.assign(new Error(code), { code }); };
          await a.mode('complex');
          assert.deepEqual(aManager.getBranch(), branchBeforeFailure, 'failed native append rolls back the entire branch');
          assert.equal(aManager.getLeafId(), leafBeforeFailure, 'failed native append restores the leaf');
          assert.match(notices.at(-1).text, new RegExp(code));
          for (let i = 0; i < 2; i++) {
            const blocked = await a.fire('tool_call', { toolName: 'subagent' }, { ...a.context });
            assert.equal(blocked.block, true);
            assert.match(blocked.reason, /falha ao salvar o modo da sessão/);
          }
          // Failed recovery cannot clear the latch, even when the branch is already simple.
          await a.mode('simple');
          assert.deepEqual(aManager.getBranch(), branchBeforeFailure, 'failed recovery also rolls back');
          assert.equal(aManager.getLeafId(), leafBeforeFailure);
          assert.match((await a.fire('tool_call', { toolName: 'subagent' })).reason, /falha ao salvar/);
        } finally {
          aManager._persist = persist;
        }
        assert.match((await a.fire('tool_call', { toolName: 'subagent' })).reason, /falha ao salvar/, 'restored storage alone does not recover');
        assert.doesNotMatch((await b.fire('tool_call', { toolName: 'subagent' })).reason, /falha ao salvar/, 'another manager is not poisoned');
        const failedFile = aManager.getSessionFile();
        aManager.newSession();
        assert.doesNotMatch((await a.fire('tool_call', { toolName: 'subagent' })).reason, /falha ao salvar/, 'another session on the same manager is not poisoned');
        aManager.setSessionFile(failedFile);
        assert.match((await a.fire('tool_call', { toolName: 'subagent' })).reason, /falha ao salvar/, 'returning to the failed session cannot bypass the latch');
        await a.mode('complex');
        assert.equal(await a.fire('tool_call', { toolName: 'subagent' }), undefined, 'explicit successful recovery authorizes complex');
      }
      const memoryManager = SessionManager.inMemory(dir);
      const memory = await make(memoryManager); sessions.push(memory);
      await memory.mode('complex');
      assert.equal(await memory.fire('tool_call', { toolName: 'subagent' }), undefined, '--no-session keeps native in-memory mode entries');
      assert.equal(memoryManager.getSessionFile(), undefined);
      console.log('ok autoridade única: sessões concorrentes, resume, fork, reload, tree, falhas de escrita, recuperação e --no-session');
    } finally {
      for (const session of sessions) await session.fire('session_shutdown');
      for (const [key, value] of globals) globalThis[key] = value;
    }
  }

  await emit('session_shutdown');
  const stopped = renders;
  snapshot.usd = 9; save(); await new Promise(r => setTimeout(r, 160));
  assert.equal(renders, stopped, 'shutdown não repinta status após mudança do ledger');
  assert.equal(statuses.has('mark-mode'), false, 'shutdown clears session status');
  console.log('PASS modo (loader real, ledger JSON; sem chamadas de modelo)');
} finally {
  if (extension) await emit('session_shutdown');
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}
