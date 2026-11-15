#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Runtime enxuto com loader real: opt-in de subagentes, política de autoridade,
// modelo/thinking manuais, categorias, notas, rodapé nativo e compactação. Sem rede/modelo.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
const { subagentsEnabled } = await import('../agent/juice/client.mjs');
const load = async p => import(pathToFileURL(p).href);
const { loadExtensions, createExtensionRuntime } = await load(join(root, 'dist/core/extensions/loader.js'));
const { createEventBus } = await load(join(root, 'dist/core/event-bus.js'));
const bus = createEventBus();
const { initTheme } = await load(join(root, 'dist/modes/interactive/theme/theme.js'));
initTheme('dark', false);
const dir = mkdtempSync(join(tmpdir(), 'agent-mode-'));
const saved = { ...process.env };
const juicePath = join(repo, 'agent/extensions/brain-live/juice.ts');
let agentLineText = () => '';
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
const text = () => plain(statuses.get('agent-mode') ?? '');
const observed = () => globalThis[Symbol.for('agent.state')]();
let extension;
async function emit(name, event = {}) { for (const handler of extension.handlers.get(name) || []) await handler(event, ctx); }
async function emitResult(name, event = {}) { let out; for (const handler of extension.handlers.get(name) || []) out = (await handler(event, ctx)) ?? out; return out; }
const snapshot = { version: 2, runId: 'fixture', mode: 'simple', usd: 0.42, calls: { used: 0 }, output: { used: 0, reserved: 0 }, pending: [], receipts: [] };
const statePath = join(dir, 'run.v3.json');
function save() { writeFileSync(statePath, JSON.stringify(snapshot)); }
try {
  delete process.env.AGENT_RUNTIME_ENABLED;
  delete process.env.AGENT_JUICE_ENABLED;
  let loaded = await loadExtensions([juicePath], dir, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions[0].handlers.size, 0);
  assert.equal(loaded.extensions[0].commands.size, 0);
  assert.equal(loaded.extensions[0].shortcuts.size, 0);
  console.log('ok desligado: sem hooks, comandos ou atalhos');

  Object.assign(process.env, { AGENT_RUNTIME_ENABLED: '1', AGENT_PI_ROOT: root, PI_CODING_AGENT_DIR: dir, AGENT_SUBAGENTS: '0' });
  save();
  loaded = await loadExtensions([juicePath], dir, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  extension = loaded.extensions[0];
  assert.equal(extension.shortcuts.has('shift+tab'), false, 'sem atalho de modos');
  assert.equal(extension.commands.has('mode'), false, 'sem /mode');
  assert.ok(extension.commands.has('subagents'));
  assert.ok(!extension.commands.has('juice') && !extension.commands.has('mass'));
  const setTeam = value => extension.commands.get('subagents').handler(value, ctx);
  await emit('session_start');
  assert.ok(!existsSync(join(dir, '.agent')), 'startup não cria receita');
  mkdirSync(join(dir, '.agent'));
  const wf = join(dir, '.agent/workflow.md');
  writeFileSync(wf, '# Receita privada\n(nenhuma ainda)\n3. reviewer · principal\n');
  assert.equal(notices.length, 0, 'início silencioso');
  assert.equal(thinkingWrites, 0);
  assert.equal(modelWrites, 0);
  assert.ok(active.includes('subagent'), 'schema estável mesmo sem opt-in');
  assert.equal(subagentsEnabled(ctx), false);
  assert.equal(text(), '');
  assert.equal(statuses.size, 0, 'sem status legado ou estatísticas duplicadas');
  assert.equal(observed().usd, undefined, 'nenhum ledger no estado observado');
  await setTeam('on');
  assert.equal(subagentsEnabled(ctx), true);
  assert.equal(text(), 'subagents on');
  assert.equal(branch.length, 0, 'opt-in é da sessão, não escreve modo no branch');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).mode, 'simple', 'estado legado intacto');
  assert.equal(existsSync(join(dir, 'agent-preferences.json')), false, 'opt-in não grava defaults');
  assert.equal(thinking, 'medium');
  console.log('ok opt-in: schema estável, sem modo/ledger, modelo e thinking intactos');

  // Juice não intercepta tools extras; admissão fica no dispatcher de subagent.
  assert.equal((await emitResult('tool_call', { toolName: 'generate_image', input: {} }))?.block, undefined);
  assert.equal(extension.shortcuts.has('ctrl+t'), false);
  const categoryEvent = { systemPromptOptions: { sections: {}, selectedTools: [], toolSnippets: {}, promptGuidelines: [], cwd: dir } };
  await emitResult('before_agent_start', categoryEvent);
  assert.match(categoryEvent.systemPromptOptions.sections.agent_skill_categories, /^design: a11y,/);
  assert.match(categoryEvent.systemPromptOptions.sections.agent_skill_categories, /\ndev: debug, tdd —[^\n]*\nplan: rea —/);
  const again = await emitResult('before_agent_start', categoryEvent);
  assert.equal(again?.message, undefined, 'opt-in não injeta nota');

  // Leitor de compatibilidade ainda expõe observações, mas não instala rodapé.
  const agentLine = globalThis[Symbol.for('agent.footer.line')];
  agentLineText = () => agentLine(theme).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(typeof agentLine, 'function', 'juice registra a linha do Agent');
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const line2 = plain(agentLine(theme));
  assert.match(line2, /^clássico · cache — ttl (5m|1h) · API≈US\$ 0\.00 · sob demanda (off|—|\d+\/\d+) · prefetch off$/, line2);
  await emit('message_end', { message: { role: 'assistant', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 5 } } });
  assert.match(plain(agentLine(theme)), /cache 90%/, 'hit do último turno');
  const beforeMode = renders;
  await setTeam('off');
  await setTeam('on');
  assert.ok(renders >= beforeMode + 2, 'mode changes publish native status');

  // A extensão escuta agent:team pelo pi.events; emitimos pelo mesmo barramento.
  const emitTeam = (agents, status) => bus.emit('agent:team', { id: 'j1', agents, status });
  emitTeam(['scout'], 'running');
  assert.ok(observed().team.some(item => item.agent === 'scout' || item.name === 'scout'), 'team remains structured');
  const duringTeam = text();
  emitTeam(['scout'], 'completed'); emitTeam(['worker'], 'running'); emitTeam(['worker'], 'failed');
  assert.equal(text(), duringTeam, 'Juice does not duplicate mascot count in mode status');
  await emit('input', { text: 'nova tarefa' });
  assert.deepEqual(observed().team, [], 'new task clears team');
  snapshot.usd = 2.1; save();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(observed().usd, undefined, 'native footer does not watch ledger');
  assert.equal(text(), duringTeam);
  console.log('ok team structured, single status, no ledger watcher');

  await setTeam('off');
  assert.equal(subagentsEnabled(ctx), false);
  await setTeam('x');
  assert.match(notices.at(-1).text, /Use \/subagents on ou \/subagents off/);
  assert.equal(subagentsEnabled(ctx), false, 'argumento inválido não autoriza');
  const opts = () => ({ selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: '', sections: {}, contextFiles: [], skills: [], cwd: dir });
  let run = { systemPromptOptions: opts() };
  await emit('before_agent_start', run);
  assert.equal(run.systemPromptOptions.sections.agent_workflow, undefined);
  console.log('ok /subagents on|off, argumento inválido não concede permissão');

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
    await setTeam('off');
    await setTeam('on');
    assert.equal(thinking, 'xhigh', 'ida e volta do opt-in preserva o thinking');
    assert.deepEqual(ctx.model, chosen, 'ida e volta do opt-in preserva o modelo');
    assert.equal(thinkingWrites, writes, 'extensão runtime nunca chama setThinkingLevel');
    assert.equal(modelWrites, 0, 'extensão runtime nunca chama setModel');
    assert.equal(text(), 'subagents on', 'status independe do modelo');
    ctx.model = { provider: 'fixture', id: 'fable-5.1' };
    await emit('model_select', { model: ctx.model });
    thinking = 'medium';
    console.log('ok modelo e thinking manuais sobrevivem ao opt-in, model_select e cada run');
  }

  // Receita invisível: regra nova, equipe customizada e prompt forçado do Vault nunca
  // levam a receita ao modelo principal — nem como seção, nem como nota.
  writeFileSync(wf, readFileSync(wf, 'utf8')
    .replace('(nenhuma ainda)', '- teste roda com `node scripts/test-*.mjs`')
    .replace('3. reviewer · principal', '3. reviewer · apoio'));
  await setTeam('on');
  run = { systemPromptOptions: opts() };
  let out = await emitResult('before_agent_start', run);
  assert.equal(run.systemPromptOptions.sections.agent_workflow, undefined, 'opt-in não manda a receita');
  assert.doesNotMatch(out?.message?.content ?? '', /Receita|workflow\.md|scout|reviewer/, 'receita não vira nota na conversa');
  run = { systemPromptOptions: opts() };
  out = await emitResult('before_agent_start', run);
  assert.equal(run.systemPromptOptions.sections.agent_workflow, undefined, 'nenhum run reintroduz a seção');
  run = { systemPromptOptions: { ...opts(), forceSystemPrompt: 'PROMPT DO VAULT' } };
  const forcedOut = (await emitResult('before_agent_start', run))?.systemPrompt ?? '';
  assert.doesNotMatch(forcedOut, /agent_workflow|scout|reviewer/, 'prompt forçado do Vault não recebe a receita');
  assert.match(forcedOut, /^PROMPT DO VAULT\n\n<agent_autonomy>/, 'no prompt forçado só entram as políticas globais');
  await emit('session_start');
  writeFileSync(wf, '# Receita privada\n(nenhuma ainda)\n');
  console.log('ok receita fora do modelo principal (seção, nota e prompt forçado)');
  const { createJiti } = await load(join(root, 'node_modules/jiti/lib/jiti.mjs'));
  const { renderSystemPrompt } = await createJiti(import.meta.url, { moduleCache: false }).import(join(repo, 'agent/extensions/brain-live/vault-runtime.ts'));
  const vault = join(dir, 'vault'); mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'system-prompt.md'), 'Vault\nCurrent working directory: {{PI_CWD}}');
  const rendered = renderSystemPrompt('base', vault, { cwd: '/x', sections: { agent_workflow: 'RECEITA' } });
  assert.equal(rendered, 'Vault\nCurrent working directory: /x\n\n<agent_workflow>\nRECEITA\n</agent_workflow>', 'vault-runtime não descarta seções de extensões');
  writeFileSync(join(vault, 'system-prompt.md'), 'A\n{{PI_EXTRA_SECTIONS}}\nB');
  assert.equal(renderSystemPrompt('base', vault, { sections: { agent_workflow: 'R' } }), 'A\n<agent_workflow>\nR\n</agent_workflow>\nB');
  writeFileSync(join(vault, 'system-prompt.md'), 'Tools:\n{{#PI_TOOL grep}}\n- grep\n{{/PI_TOOL}}\n{{#PI_TOOL read}}\n- read\n{{/PI_TOOL}}\nFim');
  assert.equal(renderSystemPrompt('base', vault, { selectedTools: ['read'] }), 'Tools:\n- read\nFim', 'tool inativa não deixa linha em branco');
  // Prompt estável: descreve todas as tools registradas, ativas ou não.
  const { stableDynamics } = await createJiti(import.meta.url, { moduleCache: false }).import(join(repo, 'agent/extensions/brain-live/vault-runtime.ts'));
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
  for (const value of ['off', 'off', 'on', 'on', 'off']) {
    await setTeam(value);
    notes.push((await emitResult('before_agent_start', { systemPromptOptions: opts() }))?.message ?? null);
  }
  assert.deepEqual(notes, [null, null, null, null, null], 'opt-in não insere notas ou turnos');
  console.log('ok vault-runtime: seções e tools estáveis, sem notas de modo');

  // Políticas GLOBAIS no system prompt: autoridade em on e off; sem delegação obrigatória.
  // Usa o montador de prompt do Pi clássico e prompts forçados por extensões
  // para medir o texto que o modelo vê de fato.
  {
    const { buildSystemPrompt, buildSystemPromptSections, diffSystemPromptSections } = await load(join(root, 'dist/core/system-prompt.js'));
    const AUT = 'Política de trabalho:';
    const CPX = 'Modo complex (vale só enquanto o modo for complex):';
    const count = (text, needle) => text.split(needle).length - 1;
    const run = async (mode, extra = {}) => {
      await setTeam(mode);
      const options = { ...opts(), ...extra };
      const out = await emitResult('before_agent_start', { systemPromptOptions: options });
      if (out?.systemPrompt !== undefined) options.forceSystemPrompt = out.systemPrompt; // o runner do Pi faz isso
      return { options, out, prompt: options.forceSystemPrompt ?? buildSystemPrompt(options) };
    };

    // Clássico (prompt montado por seções).
    const off = await run('off');
    assert.deepEqual(Object.keys(off.options.sections), ['agent_skill_categories', 'agent_autonomy'], 'off: categorias e autoridade');
    assert.equal(count(off.prompt, AUT), 1, 'off: autonomia exatamente uma vez');
    assert.equal(count(off.prompt, CPX), 0, 'off: nenhuma instrução de complex');
    assert.equal(count(off.prompt, 'subagent'), 0, 'off: nada de equipe no system');
    const offAgain = await run('off');
    assert.equal(offAgain.prompt, off.prompt, 'mesmo opt-in, mesmo texto (prefixo de cache intacto)');
    const on = await run('on');
    assert.deepEqual(Object.keys(on.options.sections), ['agent_skill_categories', 'agent_autonomy'], 'on: categorias e autoridade');
    assert.equal(count(on.prompt, AUT), 1, 'on: autonomia uma vez');
    assert.equal(count(on.prompt, CPX), 0, 'on: sem política complex');
    assert.equal(on.prompt, off.prompt, 'opt-in preserva exatamente o prompt');
    assert.equal((await run('on')).prompt, on.prompt, 'on estável entre turnos');
    const back = await run('off');
    assert.equal(back.prompt, off.prompt, 'opt-out devolve o prompt inicial');
    const patch = diffSystemPromptSections(buildSystemPromptSections(on.options), buildSystemPromptSections(back.options));
    assert.equal(patch, undefined, 'opt-in não muda as seções de política');
    assert.match(back.prompt, /Quem decide é o seu usuário/);
    assert.match(back.prompt, /push, merge, deploy, ação destrutiva ou efeito em terceiros/);

    // Prompt forçado (Vault no clássico): as políticas entram no texto, uma vez.
    const forcedOn = await run('on', { forceSystemPrompt: 'PROMPT DO VAULT' });
    assert.match(forcedOn.prompt, /^PROMPT DO VAULT\n\n<agent_autonomy>\n[\s\S]*\n<\/agent_autonomy>\n\n<agent_skill_categories>[\s\S]*<\/agent_skill_categories>$/, forcedOn.prompt);
    const forcedOff = await run('off', { forceSystemPrompt: 'PROMPT DO VAULT' });
    assert.match(forcedOff.prompt, /^PROMPT DO VAULT\n\n<agent_autonomy>\n[\s\S]*\n<\/agent_autonomy>\n\n<agent_skill_categories>[\s\S]*<\/agent_skill_categories>$/, forcedOff.prompt);
    assert.equal(count(forcedOff.prompt, CPX), 0, 'forçado em off: sem complex');

    // Ordem dos handlers: juice antes OU depois do vault-runtime, no clássico. A
    // política tem de aparecer exatamente uma vez no prompt que sai (risco real de
    // duplicar pela seção + texto forçado, ou de sumir se ninguém a levar).
    const vaultPath = join(repo, 'agent/extensions/brain-live/vault-runtime.ts');
    // Estes loads extras publicam os mesmos símbolos globais (estado/rodapé); guarde os da
    // sessão real para devolver no fim, senão o resto do teste observa a instância solta.
    const ownedGlobals = [Symbol.for('agent.state'), Symbol.for('agent.footer.line')].map((key) => [key, globalThis[key]]);
    const sistema = join(dir, 'sistema');
    mkdirSync(join(sistema, 'Pi/skills'), { recursive: true });
    writeFileSync(join(sistema, 'Pi/system-prompt.md'), 'PROMPT DO VAULT\n\n{{PI_EXTRA_SECTIONS}}\n\nFIM');
    process.env.PI_SYSTEM_DIR = sistema;
    process.env.AGENT_VAULT = '1';
    writeFileSync(join(dir, '.agent/notes.md'), 'docs/private.md — privado\n');
    try {
      for (const [first, second] of [[juicePath, vaultPath], [vaultPath, juicePath]]) {
        for (const host of ['clássico']) {
          for (const mode of ['off', 'on']) {
            const where = `${basename(first)} primeiro, ${host}, ${mode}`;
            const rt = createExtensionRuntime();
            Object.assign(rt, { setThinkingLevel() {}, getThinkingLevel: () => 'low', getActiveTools: () => [...active], getAllTools: all, setActiveTools() {}, appendEntry: runtime.appendEntry });
            const pack = await loadExtensions([first, second], dir, createEventBus(), rt);
            assert.deepEqual(pack.errors, [], where);
            branch = [];
            process.env.AGENT_SUBAGENTS = mode === 'on' ? '1' : '0';
            for (const ext of pack.extensions) for (const h of ext.handlers.get('session_start') || []) await h({ reason: 'startup' }, ctx);
            const options = opts();
            for (const ext of pack.extensions) for (const h of ext.handlers.get('before_agent_start') || []) {
              const out = await h({ systemPromptOptions: options, systemPrompt: 'BASE' }, ctx);
              if (out?.systemPrompt !== undefined) options.forceSystemPrompt = out.systemPrompt;
            }
            delete process.env.AGENT_JUICE_PI_ENTRY;
            const prompt = options.forceSystemPrompt ?? buildSystemPrompt(options);
            assert.equal(count(prompt, 'Mapa de notas do projeto'), 1, `notas uma vez — ${where}`);
            assert.doesNotMatch(prompt, /docs\/private.md|privado/, `conteúdo do mapa fora — ${where}`);
            assert.equal(count(prompt, AUT), 1, `autonomia uma vez — ${where}:\n${prompt}`);
            assert.equal(count(prompt, CPX), 0, `sem política de delegação obrigatória — ${where}:\n${prompt}`);
            assert.doesNotMatch(prompt, /agent_workflow|Receita do Agent/, `receita fora do principal — ${where}`);
            for (const ext of pack.extensions) for (const h of ext.handlers.get('session_shutdown') || []) await h({ reason: 'quit' }, ctx);
          }
        }
      }
    } finally {
      delete process.env.PI_SYSTEM_DIR;
      delete process.env.AGENT_VAULT;
      process.env.AGENT_SUBAGENTS = '0';
      rmSync(join(dir, '.agent/notes.md'));
      for (const [key, value] of ownedGlobals) globalThis[key] = value;
    }

    // Filho (subagente) não recebe política do principal.
    process.env.AGENT_CHILD = '1';
    try {
      const child = await run('on', { forceSystemPrompt: 'PROMPT DO FILHO' });
      assert.equal(child.prompt, 'PROMPT DO FILHO', 'filho: prompt intacto');
      assert.deepEqual(Object.keys(child.options.sections), [], 'filho: nenhuma seção de política');
    } finally { delete process.env.AGENT_CHILD; }
    await setTeam('off');
    console.log('ok políticas globais: autoridade com opt-in on/off, sem política complex (clássico e forçado)');
  }
  await emit('session_start');

  // Mapa de notas: snapshot por sessão nas duas vias; /notes usa arquivos atuais.
  {
    const { notesSection } = await import('../agent/juice/policy.mjs');
    const map = join(dir, '.agent/notes.md');
    writeFileSync(map, 'docs/known.md — CONTEÚDO PRIVADO\n\n');
    await emit('session_start');
    const expected = notesSection({ count: 1, ageDays: 0 });
    const classic = { systemPromptOptions: opts() };
    await emitResult('before_agent_start', classic);
    assert.equal(classic.systemPromptOptions.sections.agent_notes, expected.slice('<agent_notes>'.length, -'</agent_notes>'.length));
    writeFileSync(map, 'docs/known.md — alterado\ndocs/new.md — outra\n');
    for (const host of ['classic']) {
      process.env.AGENT_JUICE_PI_ENTRY = host;
      let base = 'BASE';
      for (let turn = 0; turn < 3; turn++) {
        const out = await emitResult('before_agent_start', { systemPromptOptions: { ...opts(), forceSystemPrompt: base } });
        const delta = out.systemPrompt.slice(base.length);
        assert.ok(delta.endsWith(expected), 'ponteiro congelado e depois das políticas/categorias');
        assert.equal(delta.split('<agent_notes>').length - 1, 1);
        assert.doesNotMatch(delta, /CONTEÚDO PRIVADO|docs\/known|docs\/new/);
        base = out.systemPrompt;
      }
    }
    delete process.env.AGENT_JUICE_PI_ENTRY;
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
    assert.equal(empty.systemPromptOptions.sections.agent_notes, undefined);
    rmSync(join(dir, 'docs'), { recursive: true });
    console.log('ok notes: snapshot estável, clássico, sem conteúdo, /notes cria/atualiza mapa');
  }

  // Flags legadas de aprendizado não podem iniciar inferência nem reescrever receitas.
  process.env.AGENT_LEARN = '1';
  writeFileSync(join(dir, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: 'fixture/haiku' }));
  const recipeBefore = readFileSync(wf, 'utf8');
  branch = [{ type: 'message', message: { role: 'user', content: 'conserta o bug' } }];
  await emit('agent_settled');
  assert.equal(completions.length, 0, 'runtime não faz inferência auxiliar');
  assert.equal(readFileSync(wf, 'utf8'), recipeBefore, 'receita legada preservada');
  assert.equal(existsSync(join(dir, '.agent/history.json')), false);
  console.log('ok sem inferência auxiliar ou aprendizado legado');

  // Sessão A → B: o cache da A não aparece na B; não existe mais estado de prova.
  {
    const line = () => agentLineText();
    // Custo da sessão continua estruturado; /cost mantém o ledger cumulativo.
    const agentStateFn = globalThis[Symbol.for('agent.state')];
    assert.equal(typeof agentStateFn, 'function', 'juice publica o estado observado para a TUI do Agent');
    const sessionUsd = () => agentStateFn().sessionUsd;
    const spent = sessionUsd();
    await emit('message_end', { message: { role: 'assistant', usage: { input: 10, cacheRead: 90, cacheWrite: 0, cost: { total: 0.12 } } } });
    await emit('message_end', { message: { role: 'assistant', usage: { input: 10, cacheRead: 90, cacheWrite: 0, cost: { total: 0.03 } } } });
    assert.ok(Math.abs(sessionUsd() - (spent + 0.15)) < 1e-9, `custo da sessão soma os turnos: ${sessionUsd()}`);
    await emit('message_end', { message: { role: 'user', usage: { cost: { total: 9 } } } });
    assert.ok(Math.abs(sessionUsd() - (spent + 0.15)) < 1e-9, 'só mensagem assistant entra no custo da sessão');
    assert.equal(agentStateFn().usd, undefined, 'ledger stays available via /cost, not duplicate UI reads');
    assert.match(line(), /cache 90%/);
    branch = [];
    await emit('agent_settled');
    await emit('session_start');
    assert.equal(sessionUsd(), 0, 'session_start zera o custo da sessão');
    assert.doesNotMatch(line(), /cache 90%|prova/, 'sessão B nasce sem cache/prova da A');
    assert.match(line(), /cache —/);
    assert.doesNotMatch(text(), /prova/, 'prova removida do rodapé');
    assert.doesNotMatch(line(), /prova/);
    assert.equal(completions.length, 0, 'trocar sessão não faz inferência');
    console.log('ok sessão nova zera cache e custo, sem inferência extra');
  }

  branch = []; // sem run: agent_settled abaixo não aprende nem prova
  // Produtor real publica texto simples em chave própria, sem substituir o footer.
  for (const tokens of [60_001, 60_000, 60_001, 59_999]) {
    usage = { tokens, percent: tokens / 10_000, contextWindow: 1_000_000 };
    await emit('agent_settled');
    assert.equal(statuses.get('agent-next'), tokens > 60_000 ? '/next encerra a tarefa' : undefined);
    assert.equal(observed().nextHint, tokens > 60_000);
    assert.deepEqual([...statuses.keys()].filter(key => key.startsWith('agent-')).sort(), tokens > 60_000 ? ['agent-next'] : []);
  }
  usage = { tokens: 60_001, percent: 6, contextWindow: 1_000_000 };
  await emit('agent_settled');
  await emit('session_start', { reason: 'reload' });
  assert.equal(statuses.has('agent-next'), false, 'reload clears the previous hint');
  await emit('agent_settled');
  assert.equal(statuses.get('agent-next'), '/next encerra a tarefa');
  await emit('session_shutdown');
  assert.equal(statuses.has('agent-mode'), false, 'shutdown clears mode');
  assert.equal(statuses.has('agent-next'), false, 'shutdown clears active hint');
  const disposedRenders = renders;
  await emit('tool_result');
  assert.equal(renders, disposedRenders, 'disposed producer cannot republish statuses');
  await emit('session_start');
  assert.equal(statuses.has('agent-next'), false, 'new session starts without hint');
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

  // Opt-in é por identidade da sessão, não por dados legados nem persistência de branch.
  {
    const { SessionManager } = await load(join(root, 'dist/core/session-manager.js'));
    const manager = SessionManager.inMemory(dir);
    const own = { ...ctx, sessionManager: manager };
    const command = value => extension.commands.get('subagents').handler(value, own);
    manager.appendCustomEntry('agent-mode', { version: 1, mode: 'complex' });
    assert.equal(subagentsEnabled(own), false, 'complex legado não concede delegação');
    await command('on');
    assert.equal(subagentsEnabled(own), true);
    assert.equal(subagentsEnabled({ ...ctx, sessionManager: SessionManager.inMemory(dir) }), false, 'outra sessão não herda opt-in');
    await command('off');
    process.env.AGENT_SUBAGENTS = '1';
    assert.equal(subagentsEnabled(own), false, '/subagents off vence env');
    manager.newSession();
    assert.equal(subagentsEnabled(own), true, 'nova identidade usa opt-in de env');
    process.env.AGENT_CHILD = '1';
    assert.equal(subagentsEnabled(own), false, 'filho nunca delega mesmo com env');
    await command('on');
    assert.match(notices.at(-1).text, /não podem habilitar/);
    assert.equal(subagentsEnabled(own), false);
    delete process.env.AGENT_CHILD;
    process.env.AGENT_SUBAGENTS = '0';
    assert.equal(subagentsEnabled(own), false, 'comando negado ao filho não deixa autorização residual');
    console.log('ok autoridade opt-in: isolamento, env, off explícito, nova sessão e filho fail-closed');
  }

  await emit('session_shutdown');
  const stopped = renders;
  snapshot.usd = 9; save(); await new Promise(r => setTimeout(r, 160));
  assert.equal(renders, stopped, 'shutdown não repinta status após mudança do ledger');
  assert.equal(statuses.has('agent-mode'), false, 'shutdown clears session status');
  console.log('PASS runtime (loader real, opt-in; sem ledger ou chamadas de modelo)');
} finally {
  if (extension) await emit('session_shutdown');
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}
