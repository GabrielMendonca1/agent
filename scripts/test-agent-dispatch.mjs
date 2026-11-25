#!/usr/bin/env node
// Dispatch preserva escolhas de recursos e papéis, sem herdar accounting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = process.env.AGENT_PI_ROOT || join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
if (!existsSync(join(pkg, 'package.json'))) throw new Error('Pi instalado é necessário para verificar o dispatch do piloto.');
const req = createRequire(join(pkg, 'package.json'));
const { createJiti } = req('jiti');
const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-'));
const savedEnv = { ...process.env };
let checks = 0;
try {
  delete process.env.AGENT_JUICE_CHILD;
  delete process.env.AGENT_CHILD;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: true, alias: {
    '@earendil-works/pi-coding-agent': join(pkg, 'dist/index.js'),
  } });
  const runner = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/runner.ts'));
  const jobs = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/jobs.ts'));
  const defaults = { model: 'test/principal', thinkingLevel: 'low', resources: { supportModel: 'test/economico' } };
  const routed = jobs.resolveJobTaskModels([{ agent: 'scout', task: 'inventário' }, { agent: 'worker', task: 'alteração' }], defaults);
  assert.equal(routed.ok, true);
  assert.equal(routed.tasks[0].model, 'test/economico');
  assert.equal(routed.tasks[1].model, 'test/principal');
  checks++; console.log('ok apoio para scout e principal para worker, sem Vault');
  const bySlot = jobs.resolveJobTaskModels([{ agent: 'worker', task: 'w' }, { agent: 'reviewer', task: 'r' }], { ...defaults, resources: { ...defaults.resources, slots: { worker: 'apoio', reviewer: 'apoio' } } });
  assert.deepEqual(bySlot.tasks.map(t => t.model), ['test/economico', 'test/economico']);
  checks++; console.log('ok receita/despachante: slot por papel decide o modelo');
  assert.equal(jobs.resolveJobTaskModels([{ agent: 'scout', task: 'x', model: 'test/terceiro' }], defaults).ok, false);
  assert.equal(jobs.resolveJobTaskModels([{ agent: 'scout', task: 'x', model: 'test/principal' }], defaults).ok, true);
  checks++; console.log('ok override só admite os dois modelos selecionados');
  const inherited = jobs.resolveJobTaskModels([{ agent: 'scout', task: 'x' }], { ...defaults, resources: {} });
  assert.equal(inherited.tasks[0].model, 'test/principal');
  checks++; console.log('ok apoio não configurado herda principal');

  // Regressão (bug relatado): complex NÃO apaga a config de subagente que o usuário já tinha.
  // (a) `roleModels` do models.json dele manda, com o thinking do par autorizado;
  // (b) papel com `model`/`thinking` no próprio .md decide no runner (nada é fixado aqui);
  // (c) papel sem config própria segue no slot principal/apoio do piloto.
  {
    const vault = process.env.PI_CODING_AGENT_DIR;
    mkdirSync(vault, { recursive: true });
    const tier = (model) => ({ label: 'l', description: 'd', model, thinking: 'medium' });
    writeFileSync(join(vault, 'agent-models.json'), JSON.stringify({
      tiers: { fast: tier('test/fast'), standard: tier('test/std'), deep: tier('test/deep'), visual: tier('test/vis'), image: tier('test/img') },
      roleModels: { reviewer: [{ model: 'test/antigo-reviewer', thinking: 'xhigh' }, { model: 'test/segunda-opcao', thinking: 'low' }] },
    }) + '\n');
    // MODELS_FILE pertence ao perfil isolado Agent.
    const freshJobs = jobs;
    const roleFiles = [{ name: 'reviewer' }, { name: 'planner', model: 'tier:deep', thinking: 'high' }, { name: 'worker' }];
    const kept = freshJobs.resolveJobTaskModels([{ agent: 'reviewer', task: 'r' }, { agent: 'planner', task: 'p' }, { agent: 'worker', task: 'w' }], defaults, roleFiles);
    assert.equal(kept.ok, true, kept.error);
    assert.deepEqual(kept.tasks[0], { agent: 'reviewer', task: 'r', model: 'test/antigo-reviewer', thinking: 'xhigh' }, 'roleModels do usuário preservado no piloto');
    assert.deepEqual(kept.tasks[1], { agent: 'planner', task: 'p' }, 'papel com config no .md não é sobrescrito pelo slot');
    assert.equal(kept.tasks[2].model, 'test/principal', 'papel sem config própria segue no slot');
    assert.equal(kept.tasks[2].thinking, 'low', 'papel sem config herda o thinking do pedido');
    const alt = freshJobs.resolveJobTaskModels([{ agent: 'reviewer', task: 'r', model: 'test/segunda-opcao' }], defaults, roleFiles);
    assert.deepEqual(alt.tasks[0].thinking, 'low', 'escolha explícita dentro da lista do papel vale com o thinking do par');
    const denied = freshJobs.resolveJobTaskModels([{ agent: 'reviewer', task: 'r', model: 'test/principal' }], defaults, roleFiles);
    assert.equal(denied.ok, false, 'modelo fora da lista do papel configurado é recusado');
    assert.match(denied.error, /not allowed for agent "reviewer"/);
    const modelsFile = join(vault, 'agent-models.json');
    const validConfig = readFileSync(modelsFile, 'utf8');
    writeFileSync(modelsFile, '{ invalid');
    const broken = freshJobs.resolveJobTaskModels([{ agent: 'reviewer', task: 'r' }], defaults, roleFiles);
    assert.equal(broken.ok, false, 'config existente inválida não pode ignorar silenciosamente a allowlist');
    writeFileSync(modelsFile, validConfig);
    checks++; console.log('ok complex preserva config de papel (roleModels e frontmatter); configuração inválida bloqueia; slot só preenche o que falta');

    // Fallback de cota: próximo modelo da lista do papel (com o thinking do par), com volta;
    // sem lista própria, o par principal/apoio do piloto; papel com modelo no .md não troca.
    assert.deepEqual(jobs.nextRoleModel('reviewer', 'test/antigo-reviewer', defaults, roleFiles), { model: 'test/segunda-opcao', thinking: 'low' });
    assert.deepEqual(jobs.nextRoleModel('reviewer', 'test/segunda-opcao', defaults, roleFiles), { model: 'test/antigo-reviewer', thinking: 'xhigh' });
    assert.deepEqual(jobs.nextRoleModel('worker', 'test/principal', defaults, roleFiles), { model: 'test/economico', thinking: 'low' });
    assert.equal(jobs.nextRoleModel('planner', undefined, defaults, roleFiles), undefined);
    assert.equal(jobs.nextRoleModel('worker', 'test/principal', { model: 'test/principal' }, roleFiles), undefined, 'sem piloto nem lista: nada a trocar');
    assert.equal(jobs.nextRoleModel('worker', 'test/principal', { ...defaults, resources: {} }, roleFiles), undefined, 'apoio = principal: nada a trocar');
    // O mesmo filtro do launch: um apoio que o Pi resolveria para Gemini via API não vira fallback.
    const geminiRegistry = { getAll: () => [{ provider: 'google', id: 'economico', name: 'economico' }], hasConfiguredAuth: () => true };
    assert.equal(jobs.nextRoleModel('worker', 'test/principal', { ...defaults, resources: { supportModel: 'economico' } }, roleFiles, geminiRegistry), undefined, 'fallback passa pelo modelRegistry');
    checks++; console.log('ok fallback de cota: próximo modelo da lista do papel ou do par do piloto, nunca fora da allowlist');
  }

  // Classificação de cota: só o erro do provedor/runner, nunca o texto do modelo.
  {
    for (const text of [
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
      'Codex error: The usage limit has been reached',
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
      'You exceeded your current quota, please check your plan',
      'Model is at capacity, try again later',
    ]) assert.equal(runner.classifyProviderError(text), 'quota', text);
    for (const text of [undefined, '', 'Connection error.', '400 invalid_request_error: prompt is too long', 'listening on port 4290']) assert.equal(runner.classifyProviderError(text), undefined, String(text));
    const base = { exitCode: 1, stopReason: 'error', providerError: '429 rate_limit_error', finalText: '', stderr: '', usage: {} };
    assert.equal(runner.failureOf(base), 'quota');
    assert.equal(runner.failureOf({ ...base, stopReason: 'aborted' }), undefined, 'cancel/timeout never reads as quota');
    assert.equal(runner.failureOf({ ...base, providerError: undefined, errorMessage: 'quota', finalText: 'the rate limit is 429' }), undefined, 'model prose and runner messages are not classified');
    assert.equal(runner.failureOf({ ...base, exitCode: 0, stopReason: 'stop' }), undefined);
    // Soft deadline: start + timeout - min(max(10%, 3 min), timeout/2).
    assert.equal(jobs.softDeadlineMs(1000, 3600), 1000 + 3600_000 - 360_000);
    assert.equal(jobs.softDeadlineMs(1000, 1200), 1000 + 1200_000 - 180_000);
    assert.equal(jobs.softDeadlineMs(1000, 60), 1000 + 30_000);
    assert.equal(jobs.softDeadlineMs(1000, 300), 1000 + 150_000);
    checks++; console.log('ok cota classificada pelo erro do provedor (429/529/usage limit/RESOURCE_EXHAUSTED/capacity); soft deadline com margem 10%/3 min, no máximo metade do timeout');
  }

  let captured;
  runner.runnerHooks.hostFreePercent = () => 100;
  runner.runnerHooks.getPiInvocation = (args) => ({ command: 'fake-pi', args });
  runner.runnerHooks.spawn = (_command, args, opts) => {
    captured = { args, opts };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'feito' }], usage: { input: 1, output: 2, cost: { total: 0 } }, stopReason: 'stop' } }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  process.env.AGENT_RUNTIME_ENABLED = '1';
  process.env.AGENT_JUICE_STATE = join(root, 'later-parent.json');
  const agent = { name: 'scout', description: 'fixture', systemPrompt: '', tools: ['read'], source: 'user' };
  const result = await runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: defaults, agents: [agent], agentName: 'scout', task: 'fixture', roleModel: { model: 'test/economico', thinking: 'low' }, makeDetails: (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
  assert.equal(result.exitCode, 0);
  assert.equal(captured.opts.env.AGENT_JUICE_STATE, undefined);
  assert.equal(captured.opts.env.AGENT_RUNTIME_ENABLED, '1');
  assert.equal(captured.opts.env.AGENT_SUBAGENTS, undefined, 'sem variável de opt-in');
  assert.equal(captured.opts.env.AGENT_CHILD, '1');
  assert.equal(captured.opts.env.AGENT_NO_DELEGATE, '1', 'marcador anti-recursão pegajoso');
  assert.equal(captured.args[captured.args.indexOf('--model') + 1], 'test/economico');
  assert.ok(!captured.args.includes('--no-skills'));
  checks++; console.log('ok filho remove estado de accounting e preserva skills');

  // Papel com config no próprio .md, sem par central: o filho nasce com o modelo/thinking
  // do arquivo do usuário (resolvendo `tier:`), não com o principal do piloto.
  {
    const planner = { name: 'planner', description: 'fixture', systemPrompt: '', tools: ['read'], source: 'user', model: 'tier:deep', thinking: 'high' };
    await runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: defaults, agents: [planner], agentName: 'planner', task: 'fixture', makeDetails: (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
    assert.equal(captured.args[captured.args.indexOf('--model') + 1], 'test/deep', 'frontmatter `model: tier:deep` do usuário vale no piloto');
    assert.equal(captured.args[captured.args.indexOf('--thinking') + 1], 'high', 'frontmatter `thinking` do usuário vale no piloto');
    checks++; console.log('ok papel com model/thinking no .md manda no filho (piloto)');
  }

  // continue: o snapshot do launch refaz o mesmo argv sobre o mesmo --session; só a mensagem muda,
  // crua (sem Task:/contexto), e um papel alterado depois do launch não muda nada.
  {
    const roleFile = join(root, 'resume-role.md');
    writeFileSync(roleFile, 'v1');
    const role = { name: 'scout', description: 'fixture', systemPrompt: 'RESUME-SYSTEM', tools: ['read', 'grep'], source: 'user', filePath: roleFile };
    const prompts = [];
    const spawnBefore = runner.runnerHooks.spawn;
    runner.runnerHooks.spawn = (command, args, opts) => {
      prompts.push(readFileSync(args[args.indexOf('--system-prompt') + 1], 'utf8'));
      return spawnBefore(command, args, opts);
    };
    const details = (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results });
    try {
      const first = await runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: defaults, agents: [role], agentName: 'scout', task: 'primeira', roleModel: { model: 'test/economico', thinking: 'low' }, makeDetails: details });
      const launchArgs = captured.args;
      const inv = first.invocation;
      assert.deepEqual([inv.runner, inv.model, inv.thinking, inv.tools, inv.systemPrompt, inv.cwd, inv.writes], ['pi', 'test/economico', 'low', ['read', 'grep'], 'RESUME-SYSTEM', root, false]);
      assert.equal(inv.sandbox, process.platform === 'darwin' ? 'seatbelt' : inv.sandbox);
      assert.match(inv.roleSha, /^[0-9a-f]{64}$/);
      writeFileSync(roleFile, 'v2');
      const changed = { ...role, systemPrompt: 'CHANGED', tools: ['read'] };
      const second = await runner.runSingleAgent({ defaultCwd: '/elsewhere', dispatchDefaults: { model: 'test/principal' }, agents: [changed], agentName: 'scout', task: 'SEGUNDA', makeDetails: details, resume: { invocation: inv, sessionFile: first.sessionFile } });
      assert.equal(second.sessionFile, first.sessionFile);
      const strip = (args) => args.slice(0, -1).map((arg, i) => args[i - 1] === '--system-prompt' ? '<prompt>' : arg);
      assert.deepEqual(strip(captured.args), strip(launchArgs), 'same argv as the launch, same --session');
      assert.equal(captured.args[captured.args.indexOf('--session') + 1], first.sessionFile);
      assert.equal(captured.args.at(-1), 'SEGUNDA', 'continue sends only the raw message');
      assert.match(launchArgs.at(-1), /^Task: primeira/);
      assert.deepEqual(prompts, ['RESUME-SYSTEM', 'RESUME-SYSTEM'], 'system prompt text from the snapshot');
      assert.equal(captured.opts.cwd, root, 'cwd from the snapshot');
      await assert.rejects(runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: defaults, agents: [role], agentName: 'scout', task: 'x', makeDetails: details, resume: { invocation: { ...inv, runner: 'agy' }, sessionFile: first.sessionFile } }), /no Pi session to continue/);
    } finally {
      runner.runnerHooks.spawn = spawnBefore;
    }
    checks++; console.log('ok continue: snapshot refaz o argv do launch com o mesmo --session e só a mensagem nova');
  }

  // Regras aprendidas do projeto: vão só na mensagem do filho e só as do cwd EFETIVO dele.
  const project = (name, rules) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.agent'), { recursive: true });
    writeFileSync(join(dir, '.agent/workflow.md'), ['# Receita', '', 'versão: v2', '', '## Regras aprendidas', ...rules.map(r => `- ${r}`), ''].join('\n'));
    return dir;
  };
  const projA = project('proj-a', ['regra exclusiva do projeto A']);
  const projB = project('proj-b', ['regra exclusiva do projeto B']);
  const message = () => captured.args[captured.args.length - 1];
  const runIn = (opts) => runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: defaults, agents: [agent], agentName: 'scout', task: 'fixture', roleModel: { model: 'test/economico', thinking: 'low' }, makeDetails: (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }), ...opts });

  let child = await runIn({ cwd: projA });
  assert.match(message(), /^Task: fixture\n\n## Project notes\n/, message());
  assert.match(message(), /- regra exclusiva do projeto A/);
  assert.doesNotMatch(message(), /projeto B/, 'regras de outro projeto não entram');
  assert.equal(child.task, 'fixture', 'o registro do job guarda a tarefa, não as regras');
  child = await runIn({ cwd: projB });
  assert.match(message(), /- regra exclusiva do projeto B/);
  assert.doesNotMatch(message(), /projeto A/, 'cwd por tarefa decide as regras');
  await runIn({ defaultCwd: projB, cwd: undefined });
  assert.match(message(), /- regra exclusiva do projeto B/, 'sem cwd por tarefa vale o cwd do dispatch');
  await runIn({ cwd: root });
  assert.equal(message(), 'Task: fixture', 'projeto sem regras: mensagem intacta');
  const warm = await runner.prefetchAgent({ defaultCwd: projA, dispatchDefaults: defaults, agents: [agent], agentName: 'scout', roleModel: { model: 'test/economico', thinking: 'low' } });
  assert.equal(typeof warm, 'number');
  assert.equal(message(), 'Task: .', 'aquecimento não leva regras (prefixo intacto)');
  checks++; console.log('ok regras do projeto só na mensagem do filho, pelo cwd efetivo; aquecimento intacto');

  // Teto do bloco de orientação: nada de receita gigante comendo o contexto do filho.
  const { RULES_GUIDANCE_CAP, RULES_SOURCE_CAP, projectRules } = await import(join(repo, 'agent/core/workflow.mjs'));
  const recipeOf = (dir) => readFileSync(join(dir, '.agent/workflow.md'), 'utf8');
  const guidanceRules = (text) => text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const emoji = project('proj-emoji', ['regra com acentuação e emoji 🚀🧪 — cabe inteira', 'segunda regra ção ✓']);
  let guidance = projectRules(emoji);
  assert.ok(Buffer.byteLength(guidance, 'utf8') <= RULES_GUIDANCE_CAP);
  assert.deepEqual(guidanceRules(guidance), ['regra com acentuação e emoji 🚀🧪 — cabe inteira', 'segunda regra ção ✓']);
  const giant = `regra enorme 🚀 ${'á'.repeat(RULES_GUIDANCE_CAP)}`;
  const huge = project('proj-huge', [giant, 'regra curta depois da enorme', `outra enorme ${'b'.repeat(RULES_GUIDANCE_CAP)}`, 'última curta 🧪']);
  guidance = projectRules(huge);
  assert.ok(Buffer.byteLength(guidance, 'utf8') <= RULES_GUIDANCE_CAP, 'bloco respeita o teto');
  assert.deepEqual(guidanceRules(guidance), ['regra curta depois da enorme', 'última curta 🧪'], 'regra maior que o orçamento é descartada inteira, as curtas seguem');
  assert.ok(!guidance.includes('regra enorme') && !guidance.includes('outra enorme'));
  const many = Array.from({ length: 400 }, (_, i) => `regra ${String(i).padStart(3, '0')} 🧪 ${'detalhe '.repeat(6)}fim`);
  const crowd = project('proj-many', many);
  guidance = projectRules(crowd);
  const kept = guidanceRules(guidance);
  assert.ok(Buffer.byteLength(guidance, 'utf8') <= RULES_GUIDANCE_CAP);
  assert.ok(kept.length > 10 && kept.length < many.length, `truncou pelo teto (${kept.length} de ${many.length})`);
  assert.deepEqual(kept, many.slice(0, kept.length), 'ordem preservada e cada regra inteira');
  assert.equal(projectRules(crowd), guidance, 'determinístico entre chamadas');
  const before = recipeOf(crowd);
  assert.equal(projectRules(crowd), guidance);
  assert.equal(recipeOf(crowd), before, 'receita nunca truncada nem reescrita');
  const over = project('proj-fonte-grande', [`x ${'y'.repeat(RULES_SOURCE_CAP)}`, 'regra curta que não será lida']);
  assert.ok(readFileSync(join(over, '.agent/workflow.md')).byteLength > RULES_SOURCE_CAP);
  assert.equal(projectRules(over), '', 'fonte acima do teto: fail closed, sem injetar');
  const overBefore = recipeOf(over);
  assert.equal(projectRules(over), '');
  assert.equal(recipeOf(over), overBefore, 'fonte grande permanece intacta');
  const edge = project('proj-limite-fonte', []);
  const tail = '\n## Regras aprendidas\n- regra inteira no limite\n';
  const edgeText = '#'.repeat(RULES_SOURCE_CAP - Buffer.byteLength(tail, 'utf8')) + tail;
  const edgeFile = join(edge, '.agent/workflow.md');
  writeFileSync(edgeFile, edgeText);
  assert.equal(Buffer.byteLength(edgeText, 'utf8'), RULES_SOURCE_CAP);
  assert.deepEqual(guidanceRules(projectRules(edge)), ['regra inteira no limite'], '64KiB exatos ainda entram');
  writeFileSync(edgeFile, edgeText + 'x');
  assert.equal(projectRules(edge), '', '64KiB+1 não entram');
  const nonRegular = join(root, 'proj-diretorio');
  mkdirSync(join(nonRegular, '.agent/workflow.md'), { recursive: true });
  assert.equal(projectRules(nonRegular), '', 'diretório no lugar do arquivo: fail closed');
  assert.equal(projectRules(join(root, 'nao-existe')), '', 'projeto ausente: sem orientação');
  assert.equal(projectRules(undefined), '');
  await runIn({ cwd: huge });
  const capped = message();
  assert.ok(Buffer.byteLength(capped, 'utf8') <= RULES_GUIDANCE_CAP + Buffer.byteLength('Task: fixture\n\n', 'utf8'));
  assert.deepEqual(guidanceRules(capped), ['regra curta depois da enorme', 'última curta 🧪'], 'mensagem do filho sem regra parcial');
  checks++; console.log('ok orientação limitada a 8KiB UTF-8, regras inteiras, fonte >64KiB não injetada');

  delete process.env.AGENT_RUNTIME_ENABLED;
  delete process.env.AGENT_JUICE_STATE;
  await runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: { model: 'test/principal' }, agents: [agent], agentName: 'scout', task: 'fixture', makeDetails: (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
  // Sem recursos explícitos, filho ainda recebe isolamento e catálogo de skills.
  const sandbox = runner.sandboxForTools(agent.tools);
  // Children run with the 5 min cache unless explicitly overridden; an inherited `none` stays.
  const childRetention = process.env.AGENT_CHILD_CACHE_RETENTION || (process.env.PI_CACHE_RETENTION === 'none' ? 'none' : 'short');
  assert.deepEqual(captured.opts.env, { ...process.env, AGENT_CHILD: '1', AGENT_NO_DELEGATE: '1', PI_CACHE_RETENTION: childRetention, AGENT_BASH_SANDBOX: sandbox === 'none' ? '' : sandbox, AGENT_SANDBOX_CWD: sandbox === 'none' ? '' : root, AGENT_CHECKS_READONLY: '1', AGENT_CHILD_SOFT_DEADLINE_MS: '' });
  assert.ok(!captured.args.includes('--no-skills'));
  const checksExt = (args) => args.filter((arg) => arg.endsWith('/brain-live/checks/index.ts'));
  assert.deepEqual(checksExt(captured.args), [], 'no checks extension unless the role lists checks');
  for (const [tools, readonly] of [[['read', 'checks'], '1'], [['read', 'edit', 'checks'], '']]) {
    const role = { ...agent, name: 'checker', tools };
    await runner.runSingleAgent({ defaultCwd: root, dispatchDefaults: { model: 'test/principal' }, agents: [role], agentName: 'checker', task: 'fixture', makeDetails: (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
    assert.equal(checksExt(captured.args).length, 1, `-e checks for ${tools}`);
    assert.equal(captured.args[captured.args.indexOf('--tools') + 1], tools.join(','));
    assert.equal(captured.opts.env.AGENT_CHECKS_READONLY, readonly, `checks read-only marker for ${tools}`);
  }
  checks++; console.log('ok dispatch sem recursos mantém isolamento e catálogo de skills');

  // Launcher: argv[1] só vale se for CLI declarado do pacote Pi; host do SDK cai no CLI do Pi carregado.
  const piPkg = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const bundleCli = realpathSync(join(pkg, piPkg.bin.pi));
  const savedArgv1 = process.argv[1];
  try {
    for (const accepted of [join(pkg, piPkg.bin.pi), join(pkg, 'dist/cli.js'), join(pkg, '../../../bin/pi')].filter((p) => existsSync(p))) {
      process.argv[1] = accepted;
      assert.deepEqual(runner.getPiInvocation(['-p']), { command: process.execPath, args: [accepted, '-p'] }, `CLI Pi aceito: ${accepted}`);
    }
    const fakeCli = join(root, 'other/dist/cli.js');
    mkdirSync(dirname(fakeCli), { recursive: true });
    writeFileSync(join(root, 'other/package.json'), JSON.stringify({ name: 'other', bin: { pi: 'dist/cli.js' } }));
    writeFileSync(fakeCli, '');
    for (const host of [fakeCli, savedArgv1]) {
      process.argv[1] = host;
      assert.deepEqual(runner.getPiInvocation(['-p']), { command: process.execPath, args: [bundleCli, '-p'] }, `script de host rejeitado: ${host}`);
    }
  } finally {
    process.argv[1] = savedArgv1;
  }
  // Processo Node real cujo argv[1] é o host: --version deve vir do Pi, nunca reexecutar o host.
  const hostDir = join(root, 'host/scripts');
  mkdirSync(hostDir, { recursive: true });
  const marker = join(root, 'host-ran');
  const host = join(hostDir, 'superagent.mjs');
  writeFileSync(host, `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
if (process.argv.length > 2) { appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n'); console.log('Usage: superagent'); process.exit(2); }
const { createJiti } = createRequire(${JSON.stringify(join(pkg, 'package.json'))})('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, alias: { '@earendil-works/pi-coding-agent': ${JSON.stringify(join(pkg, 'dist/index.js'))} } });
const runner = await jiti.import(${JSON.stringify(join(repo, 'agent/extensions/brain-live/subagent/runner.ts'))});
const out = {};
for (const flag of ['--version', '--help']) {
  const inv = runner.getPiInvocation([flag]);
  const r = spawnSync(inv.command, inv.args, { encoding: 'utf8', timeout: 30000 });
  out[flag] = { inv, status: r.status, stdout: r.stdout };
}
console.log(JSON.stringify(out));
`);
  const hostRun = spawnSync(process.execPath, [host], { encoding: 'utf8', timeout: 90000 });
  assert.equal(hostRun.status, 0, hostRun.stderr);
  const hostOut = JSON.parse(hostRun.stdout.trim().split('\n').pop());
  assert.deepEqual(hostOut['--version'].inv, { command: process.execPath, args: [bundleCli, '--version'] });
  assert.equal(hostOut['--version'].status, 0);
  assert.equal(hostOut['--version'].stdout.trim(), piPkg.version, 'versão do Pi, não do host');
  assert.equal(hostOut['--help'].status, 0);
  assert.match(hostOut['--help'].stdout, /\bpi\b/);
  assert.doesNotMatch(hostOut['--help'].stdout, /superagent/);
  assert.ok(!existsSync(marker), 'host não pode ser executado como CLI do Pi');
  checks++; console.log('ok launcher rejeita script de host do SDK e usa o CLI do Pi carregado');

  console.log(`${checks} checks passed`);
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
}
