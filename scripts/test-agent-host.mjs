#!/usr/bin/env node
/**
 * Regressão offline do perfil Agent: Pi real + provider Anthropic roteirizado em
 * loopback (scripts/lib/fake-anthropic.mjs). Nenhuma chamada sai da máquina, nada
 * fora de um diretório temporário é escrito.
 *
 * Compara recursos temporários e instalados, schemas no payload, exposição,
 * política estável, subagent sempre ligado (filho não lança) e ausência de ledger. Fixtures sem auth.
 *
 * `node scripts/test-agent-host.mjs [classic]`
 */
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { categoryPrompt } from '../agent/core/skill-categories.mjs';
import { AUTONOMY_POLICY } from '../agent/core/policy.mjs';
import { applyAgentResources, planAgentResources, rollbackAgentResources } from './lib/agent-resources.mjs';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const piRoot = join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Family policy boundaries and explicit override; no provider calls.
{
  const { codemodeModeFor } = await import('../agent/core/codemode-policy.mjs');
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-astra', 'gpt-6-sol', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-7-sol', 'gpt-10.3-astra']) {
    assert.equal(codemodeModeFor({ provider: 'openai-codex', id }, {}), 'only', id);
  }
  for (const id of ['gpt-5.5-sol', 'gpt-5.7-sol', 'gpt-6.2-luna', 'gpt-7-luna']) {
    assert.equal(codemodeModeFor({ provider: 'openai-codex', id }, {}), 'on', id);
  }
  for (const id of ['claude-opus-5', 'claude-fable-5.1', 'claude-opus-6-2', 'claude-fable-10']) {
    assert.equal(codemodeModeFor({ provider: 'anthropic', id }, {}), 'only', id);
  }
  for (const id of ['claude-opus-4.9', 'claude-haiku-6', 'claude-sonnet-7']) {
    assert.equal(codemodeModeFor({ provider: 'anthropic', id }, {}), 'on', id);
  }
  assert.equal(codemodeModeFor({ provider: 'openai', id: 'gpt-7-sol' }, {}), 'on');
  assert.equal(codemodeModeFor(null, {}), 'on');
  assert.equal(codemodeModeFor({ provider: 'openai-codex', id: 'gpt-7-sol' }, { AGENT_CODEMODE_MODE: 'on' }), 'on');
  assert.equal(codemodeModeFor(null, { AGENT_CODEMODE_MODE: 'only' }), 'only');
}

// ---- diagnóstico: registry realista, sem sessão, I/O ou inferência ---------
{
  const root = realpathSync(piRoot);
  const { createJiti } = createRequire(join(root, 'package.json'))('jiti');
  const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
    '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai'),
    '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui'),
    typebox: join(root, 'node_modules/typebox/build/index.mjs'),
  } });
  const { default: register, buildAgentDoctorReport } = await load.import(join(repo, 'agent/extensions/brain-live/project-operator/index.ts'));
  const source = path => ({ path, source: 'fixture', scope: 'user', origin: 'top-level' });
  const tools = [
    { name: 'read', exposure: 'direct', sourceInfo: source('builtin:read') },
    { name: 'subagent', exposure: 'direct', sourceInfo: source('/fixture/agent/extensions/brain-live/subagent/index.ts') },
    { name: 'remote', exposure: 'deferred', sourceInfo: source('/fixture/external.ts') },
    { name: 'off', exposure: 'hidden', sourceInfo: source('/fixture/off.ts') },
    { name: 'programmatic', exposure: 'codemode', sourceInfo: source('/fixture/programmatic.ts') },
  ];
  const commands = [{ name: 'skill:demo', source: 'skill', sourceInfo: source('/fixture/demo/SKILL.md') }];
  const input = { tools, commands, activeTools: ['read', 'subagent'], mode: null,
    settings: { cacheWarming: 'idle', privateToken: 'DO_NOT_PRINT_THIS_SECRET' }, agentExtensionsRoot: '/fixture/agent/extensions' };
  const report = buildAgentDoctorReport(input);
  assert.match(report, /Pi nativo · builtin:read/);
  assert.match(report, /Agent · brain-live\/subagent\/index.ts/);
  assert.match(report, /remote · não declarada · exposição: deferred/);
  assert.match(report, /off · não declarada · exposição: hidden/);
  assert.match(report, /programmatic · não declarada · exposição: codemode/);
  assert.match(report, /Modo Agent: não observado/);
  assert.doesNotMatch(report, /Modo sem opt-in bloqueia subagent/);
  assert.match(report, /SKILLS COM COMANDO OBSERVADO: 1/);
  assert.match(report, /Cache nativo: idle/);
  assert.doesNotMatch(report, /DO_NOT_PRINT_THIS_SECRET|privateToken/);
  const override = buildAgentDoctorReport({ ...input, tools: [{ ...tools[0], sourceInfo: source('/fixture/custom-read.ts') }] });
  assert.match(override, /extensão\/integração · \/fixture\/custom-read.ts/);
  assert.doesNotMatch(override, /Pi nativo ·/);
  const native = buildAgentDoctorReport({ ...input, settings: {}, mode: null });
  assert.match(native, /Modo Agent: não observado/);
  assert.match(native, /Cache nativo: idle \(padrão do Pi 1\.5\.1\+\) \(configuração; o Agent para o aquecedor nativo/);
  const handlers = new Map();
  const forbidden = () => { throw new Error('diagnóstico tentou efeito colateral'); };
  register({
    on() {}, registerTool() {}, registerCommand(name, command) { handlers.set(name, command); },
    getAllTools: () => tools, getActiveTools: () => input.activeTools,
    getCommands: () => commands, getSettings: () => input.settings,
    exec: forbidden, sendMessage: forbidden, sendUserMessage: forbidden, appendEntry: forbidden,
  });
  let shown;
  await handlers.get('agent-doctor').handler('', {
    mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'agent-mode', data: { version: 1, mode: 'simple' } }] },
    modelRegistry: { streamSimple: forbidden },
    ui: { editor: async (_title, text) => { shown = text; return 'texto alterado pelo usuário: não salvar'; } },
  });
  assert.match(shown, /DIAGNÓSTICO DA SESSÃO/);
  assert.doesNotMatch(shown, /DO_NOT_PRINT_THIS_SECRET/);
  console.log('ok agent-doctor: origem real, exposição, modo, skills e settings filtrados; sem turno nem escrita de sessão');
}

// ---- vínculo ARCA: só com --install/--link-arca, e com HOME fictício aqui -----
{
  const parent = mkdtempSync(join(tmpdir(), 'agent-arca-'));
  try {
    const fakeHome = join(parent, 'fake-home');
    for (const d of ['.config/arca-projects', '.cache/arca-projects', '.pi/mesh']) mkdirSync(join(fakeHome, d), { recursive: true });
    writeFileSync(join(fakeHome, '.config/arca-projects/config.json'), '{"fake":true}');
    const seed = join(parent, 'seed'); mkdirSync(seed);
    const vault = join(parent, 'vault'); mkdirSync(vault);
    const prep = (...extra) => {
      const out = join(parent, `p${extra.length}`); mkdirSync(out);
      const r = spawnSync(process.execPath, [join(repo, 'scripts/prepare-agent-test.mjs'), '--pi-root', piRoot, '--temp-parent', out, '--agent-dir', seed, '--vault-pi', vault, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome, USERPROFILE: fakeHome } });
      assert.equal(r.status, 0, `prepare ${extra.join(' ') || '(sem flag)'} falhou: ${(r.stderr.split('\n').find(l => /Error/.test(l)) ?? r.stderr.trim().split('\n').at(-1))?.replaceAll(process.env.HOME ?? '\0', '~')}`);
      const env = JSON.parse(readFileSync(join(JSON.parse(r.stdout).root, 'environment.json'), 'utf8'));
      assert.equal(typeof env, 'object');
      const settings = JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'));
      for (const name of ['cache-keeper.ts', 'plan.ts']) assert.ok(settings.extensions.includes(join(repo, 'agent/extensions/brain-live', name)));
      assert.ok(!settings.extensions.some(path => /(?:^|\/)jev(?:\.ts|\/)/.test(path)), 'JEV não entra no perfil');
      assert.ok(!existsSync(join(env.PI_CODING_AGENT_DIR, 'auth.json')));
      return env;
    };
    const isolated = prep();
    if (isolated) {
      for (const k of ['ARCA_MEGAMIND_CONFIG', 'ARCA_MEGAMIND_CACHE', 'PI_MESH_DIR']) assert.equal(isolated[k], undefined, `sem flag, ${k} não vaza`);
      const linked = prep('--link-arca', '--arca-home', fakeHome);
      assert.ok(linked, '--link-arca não pode pular quando o isolado preparou');
      assert.equal(linked.ARCA_MEGAMIND_CONFIG, join(fakeHome, '.config/arca-projects/config.json'));
      assert.equal(linked.ARCA_MEGAMIND_CACHE, join(fakeHome, '.cache/arca-projects'));
      assert.equal(linked.PI_MESH_DIR, join(fakeHome, '.pi/mesh'));
      console.log('ok vínculo ARCA: isolado sem flag; --link-arca aponta Megamind/peers (HOME fictício, sem rede)');
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

// ---- integração: Pi real + provider falso ------------------------------------
async function runHost(host) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-host-'));
  try {
    const seed = join(parent, 'seed'); mkdirSync(seed);
    const vault = join(parent, 'vault'); mkdirSync(vault);
    writeFileSync(join(vault, 'system-prompt.md'), 'You are an expert coding assistant.\n\nAvailable tools:\n{{PI_EXTRA_TOOLS}}\n\n{{PI_SKILLS}}\n{{PI_PROJECT_CONTEXT}}\n');
    const prep = spawnSync(process.execPath, [join(repo, 'scripts/prepare-agent-test.mjs'), '--pi-root', piRoot, '--temp-parent', parent, '--host', host, '--agent-dir', seed, '--vault-pi', vault], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: parent, USERPROFILE: parent } });
    if (prep.status !== 0) {
      throw new Error(prep.stderr);
    }
    const info = JSON.parse(prep.stdout);
    assert.equal(info.exposure, 'direct');
    assert.ok(!existsSync(join(info.agentDir, 'auth.json')));
    const fake = await startFakeAnthropic([
      { tool: { name: 'subagent', input: { agent: 'missing-fixture-role', task: 'x' } } },
      { tool: { name: 'codemode', input: { code: 'const r = await tools.subagent({agent: "missing-fixture-role", task: "x"}); console.log(JSON.stringify(r));' } } },
      { text: 'feito' },
      { text: 'resumed' },
      { tool: { name: 'subagent', input: { agent: 'missing-fixture-role', task: 'x' } } },
      { tool: { name: 'codemode', input: { code: 'const r = await tools.subagent({agent: "missing-fixture-role", task: "x"}); console.log(JSON.stringify(r));' } } },
      { text: 'child checked' },
    ]);
    try {
      rmSync(join(info.agentDir, 'auth.json'), { force: true });
      writeFileSync(join(info.agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'fake-key', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } } }));
      const env = JSON.parse(readFileSync(join(info.root, 'environment.json'), 'utf8'));
      // Skills pessoais sem disable-model-invocation: a política em memória deve
      // manter os comandos, anunciar as globais curadas e as skills de system/.
      mkdirSync(join(info.agentDir, 'skills'), { recursive: true });
      mkdirSync(join(info.agentDir, 'extensions'), { recursive: true });
      const policyNames = ['arca-ops', 'diagram', 'omni-ops', 'peers', 'megamind', 'tasks', 'goal', 'grill', 'cua', 'pessoal'];
      for (const name of policyNames) {
        const folder = join(info.agentDir, 'skills', name);
        assert.ok(realpathSync(join(info.agentDir, 'skills')).startsWith(realpathSync(info.root) + '/'), 'pai da fixture deve ser isolado');
        // O setup pode recriar links para defaults gerenciados. Desvincular SOMENTE
        // esta entrada temporária antes de escrever; nunca seguir seu destino global.
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(folder, { recursive: true });
        assert.ok(realpathSync(folder).startsWith(realpathSync(info.root) + '/'));
        writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n`);
      }
      // Observação do system EFETIVO: extensão só deste perfil temporário que, antes de CADA
      // requisição ao provider (depois dos handlers de before_agent_start, portanto já com as
      // políticas aplicadas), anexa `ctx.getSystemPrompt()` a um arquivo. Não devolve nada —
      // não altera prompt, mensagens nem tools. É o único jeito de ler o prompt efetivo no
      // host (incluindo handlers que forçam o system).
      writeFileSync(join(info.agentDir, 'extensions', 'agent-observe-system.ts'), [
        "import { appendFileSync } from 'node:fs';",
        'export default function (pi: any) {',
        "  pi.on('before_provider_request', async (_event: any, ctx: any) => {",
        "    if (pi.getCommands().some(c => c.name === 'jev')) throw new Error('JEV entrou no loader');",
        '    const file = process.env.AGENT_OBSERVE_SYSTEM;',
        '    if (!file) return;',
        "    appendFileSync(file, JSON.stringify({ system: ctx.getSystemPrompt(), tools: pi.getAllTools().map(t => ({ name: t.name, exposure: t.exposure ?? 'direct' })).sort((a, b) => a.name.localeCompare(b.name)) }) + '\\n');",
        '  });',
        '}',
        '',
      ].join('\n'));
      const session = join(parent, 'session.jsonl');
      // launch.sh real do perfil clássico; mesma sessão duas vezes = resume.
      const runPi = (prompt, label, flags = {}) => new Promise((resolve) => {
        const observeFile = join(parent, `system-${label}.jsonl`);
        const child = spawn(Object.keys(flags).length ? process.execPath : join(info.root, 'launch.sh'), [...(Object.keys(flags).length ? [join(piRoot, 'dist/cli.js')] : []), '--session', session, '-p', '--mode', 'json', '--model', 'anthropic/claude-haiku-5-5', prompt], {
          // O artefato fica fora do projeto, como na instalação real (trust do Pi 1.3).
          cwd: parent, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
          env: { PATH: process.env.PATH, ...env, AGENT_LEARN: '0', AGENT_DISPATCHER: '0', AGENT_OBSERVE_SYSTEM: observeFile, ...flags },
        });
        let out = '', err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => resolve({
          code, out, err,
          observed: existsSync(observeFile)
            ? readFileSync(observeFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).system)
            : [],
          tools: existsSync(observeFile) ? JSON.parse(readFileSync(observeFile, 'utf8').split('\n')[0]).tools : [],
        }));
      });
      // Comando real: o relatório consulta o registry sem enviar prompt ao provider.
      const beforeDoctor = fake.messages().length;
      const doctor = await runPi('/agent-doctor', 'doctor');
      assert.equal(doctor.code, 0, doctor.err);
      assert.equal(fake.messages().length, beforeDoctor, 'agent-doctor não pode chamar o provider');
      const doctorEvent = doctor.err.split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(event => event.type === 'agent_doctor');
      assert.ok(doctorEvent, `comando JSON emite diagnóstico em stderr\nstdout: ${doctor.out}\nstderr: ${doctor.err}`);
      assert.doesNotMatch(doctor.out, /agent_doctor/, 'diagnóstico não altera protocolo JSONL oficial');
      assert.match(doctorEvent.report, /Pi nativo · builtin:read/);
      assert.match(doctorEvent.report, /Modo Agent: não observado/);
      assert.doesNotMatch(doctorEvent.report, /read-media\.ts/);
      console.log('ok agent-doctor no Pi real: read nativo, sem modo legado, zero chamadas ao provider');
      const result = await runPi('oi', 'run1-off');
      assert.equal(result.code, 0, `${host}: Pi saiu com ${result.code}\n${result.err.slice(0, 2000)}`);
      const requests = fake.messages();
      assert.equal(requests.length, 3, `${host}: 3 requisições ao provider`);
      const names = (i) => requests[i].tools.map(t => t.name);
      for (const tool of ['generate_image', 'project_overview']) assert.ok(!names(0).includes(tool), `${host}: ${tool} deferred fora da 1ª requisição`);
      assert.ok(names(0).includes('subagent'), `${host}: subagent segue no schema (cache)`);
      const events = result.out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
      const ends = events.filter(e => e.type === 'tool_execution_end');
      const text = (e) => JSON.stringify(e?.result?.content ?? '');
      // Sem flag nenhuma: o launch chega ao dispatcher (papel inexistente: nenhum filho nasce).
      for (const toolName of ['subagent', 'codemode']) {
        const content = text(ends.find(e => e.toolName === toolName));
        assert.match(content, /Unknown agent\(s\): missing-fixture-role/, `${host}/${toolName}: launch sem flag chega ao dispatcher`);
        assert.doesNotMatch(content, /Subagents disabled|AGENT_SUBAGENTS|\/subagents on/, `${host}/${toolName}: sem opt-in`);
      }
      assert.ok(!names(1).includes('generate_image'), 'classic: imagem continua deferred');
      // Prompt único: preamble e skills uma vez só; sem seções nativas de tools/rules.
      const system = (i) => fake.messages()[i].system.map(b => b.text).join('\n');
      const count = (text, re) => (text.match(re) ?? []).length;
      const sys0 = system(0);
      assert.equal(count(sys0, /You are an expert coding assistant/g), 1, `${host}: preamble uma vez`);
      assert.equal(count(sys0, /<agent_autonomy>/g), 1, `${host}: autonomia uma vez no system real`);
      assert.equal(count(sys0, /<agent_skill_categories>/g), 1, `${host}: categorias uma vez no system real`);
      assert.ok(sys0.includes(categoryPrompt()), `${host}: uma linha determinística por pasta não-system`);
      assert.equal(count(sys0, /<agent_complex>/g), 0, `${host}: sem política complex`);
      assert.doesNotMatch(sys0, /Complex mode: delegate by role|Delegate independent reading and recon in parallel|Use structured briefs with objective, context/, `${host}: sem texto de modo complex`);
      // Este Vault de fixture lista só os snippets; as guidelines são provadas no prompt padrão (agent-headless).
      assert.equal(count(sys0, /subagent: Delegate reading, recon, review and self-contained implementation to subagents/g), 1, `${host}: snippet de orquestrador uma vez`);
      assert.doesNotMatch(sys0, /Optional async subagents|only when the user enables them/, `${host}: sem texto de opt-in`);
      // Receita do projeto é interna: o modelo principal não vê o bloco nem as etapas.
      assert.equal(count(sys0, /^<\/?agent_workflow>$/gm), 0, `${host}: receita fora do system prompt`);
      assert.equal(count(sys0, /Receita deste projeto|Regras aprendidas aqui|Projeto agent, receita/g), 0, `${host}: nada do conteúdo da receita no system prompt`);
      assert.equal(count(sys0, /<available_skills>/g), 1, `${host}: skills uma vez`);
      assert.deepEqual([...sys0.matchAll(/<name>([^<]+)<\/name>/g)].map(m => m[1]).sort(),
        ['computer-use', 'diagram', 'handoff', 'html-plan', 'megamind', 'peers', 'pr', 'sources'], `${host}: curadoria real no provider, inclusive skills pessoais`);
      for (const name of policyNames) assert.equal(readFileSync(join(info.agentDir, 'skills', name, 'SKILL.md'), 'utf8'),
        `---\nname: ${name}\ndescription: Fixture ${name}\n---\n`, `${host}: SKILL.md intacto`);
      assert.equal(count(sys0, /^Available tools:$/gm), 1, `${host}: lista de tools do Agent`);
      assert.equal(count(sys0, /<tools>|<rules>/g), 0, `${host}: sem tools/rules nativos`);
      for (let i = 1; i < requests.length; i++) assert.equal(system(i), sys0, `${host}: system fixo na sessão`);
      // O que a extensão de observação vê é o system EFETIVO de verdade (ctx.getSystemPrompt()),
      // não uma reconstrução: na 1ª requisição de uma sessão nova ele é idêntico ao que foi pela rede.
      assert.equal(result.observed.length, requests.length, `${host}: uma observação por requisição`);
      assert.equal(result.observed[0], sys0, `${host}: ctx.getSystemPrompt() == system da 1ª requisição (observação não finge)`);
      // Políticas no system efetivo, requisição por requisição.
      const policyCounts = (text) => ({
        autonomy: count(text, /<agent_autonomy>/g),
        complex: count(text, /<agent_complex>/g),
        autonomyBody: count(text, new RegExp(AUTONOMY_POLICY.split('\n')[0].replace(/[().*+?^${}|[\]\\]/g, '\\$&'), 'g')),
      });
      // Corpo efetivo da política: o que o modelo lê, sem a parte volátil (nada aqui) —
      // serve para provar que dois turnos mandam exatamente o mesmo prefixo.
      const checkPhase = (label, observed) => {
        assert.ok(observed.length > 0, `${host}/${label}: nenhuma requisição observada`);
        for (const [i, text] of observed.entries()) {
          const c = policyCounts(text);
          assert.deepEqual(c, { autonomy: 1, complex: 0, autonomyBody: 1 },
            `${host}/${label}: requisição ${i} deveria ter autonomia 1 e complex 0 (sem acumular blocos)`);
          // Nem receita nem regras aprendidas chegam ao principal.
          assert.equal(count(text, /^<\/?agent_workflow>$/gm), 0, `${host}/${label}: receita fora do system efetivo`);
          assert.equal(count(text, /Receita deste projeto|Regras aprendidas aqui/g), 0, `${host}/${label}: conteúdo de receita no system efetivo`);
          assert.doesNotMatch(text, /Modo complex \(vale só enquanto/, `${host}/${label}: política de delegação obrigatória no system`);
        }
        return observed;
      };
      checkPhase('run1-off', result.observed);
      // Resume: segundo prompt na mesma sessão mantém system e tools (prefixo em cache).
      const before = requests.length;
      const resumed = await runPi('de novo', 'run2-off');
      assert.equal(resumed.code, 0, `${host}: resume saiu com ${resumed.code}\n${resumed.err.slice(0, 2000)}`);
      assert.ok(fake.messages().length > before, `${host}: resume chamou o provider`);
      assert.equal(system(before), sys0, `${host}: resume mantém o system`);
      checkPhase('run2-off', resumed.observed);
      assert.equal(resumed.observed.at(-1), result.observed.at(-1), `${host}: resume repete o system efetivo (prefixo estável)`);
      // Processo filho (AGENT_CHILD=1) nunca lança subagente, direto ou via codemode.
      const childRun = await runPi('sou um filho', 'child', { AGENT_CHILD: '1' });
      assert.equal(childRun.code, 0, childRun.err);
      const childEnds = childRun.out.split('\n').flatMap(line => { try { const event = JSON.parse(line); return event.type === 'tool_execution_end' ? [event] : []; } catch { return []; } });
      for (const toolName of ['subagent', 'codemode']) {
        const content = text(childEnds.find(event => event.toolName === toolName));
        assert.match(content, /subagents cannot launch subagents/, `${toolName}: filho bloqueado com mensagem clara`);
        assert.doesNotMatch(content, /Unknown agent|Launched subagent job/, `${toolName}: filho não chega ao dispatch`);
      }
      assert.match(sys0, /Your user \(the person in this session\) decides/);
      assert.match(sys0, /push, merge, deploy, a destructive action or an effect on third parties/);
      // Volta à semente e aplica o contrato de instalação no mesmo HOME isolado.
      // Sem normalizar schemas: descrições e defaults também têm de ser iguais.
      assert.deepEqual(rollbackAgentResources({ receiptPath: info.resourceReceipt }).conflicts, []);
      const installed = applyAgentResources({
        plan: planAgentResources({ agentRoot: join(repo, 'agent'), agentDir: info.agentDir, homeDir: env.HOME }),
        backupDir: join(parent, 'installed-backup'),
      });
      const beforeInstalled = fake.messages().length;
      const installedResult = await runPi('perfil instalado', 'installed-off');
      assert.equal(installedResult.code, 0, installedResult.err);
      assert.deepEqual(fake.messages()[beforeInstalled].tools, requests[0].tools, 'payload: nomes e schemas iguais');
      assert.equal(system(beforeInstalled), sys0, 'payload: system e políticas iguais');
      assert.deepEqual(installedResult.tools, result.tools, 'exposição igual para todas as tools');
      for (const name of ['generate_image', 'project_overview']) assert.equal(result.tools.find(t => t.name === name)?.exposure, 'deferred');
      console.log(`ok equivalência offline: ${result.tools.length} tools; system ${sys0.length} chars; schemas ${JSON.stringify(requests[0].tools).length} chars (não tokens)`);
      assert.deepEqual(rollbackAgentResources({ receiptPath: installed.receiptPath }).conflicts, []);
      assert.equal(existsSync(join(info.root, 'run.v3.json')), false);
      assert.equal(env.AGENT_JUICE_HOME, undefined);
      assert.equal(env.AGENT_JUICE_STATE, undefined);
      assert.equal(fake.messages().length, 8, '3 dispatch + resume + 3 filho + instalado; sem inferência extra');
      console.log(`ok ${host}: prompt único (${sys0.length} chars), dispatch sem flag direto/codemode, resume, filho bloqueado, orquestrador, autoridade e zero inferência extra`);
    } finally { await fake.close(); }
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

const only = process.argv[2];
for (const host of ['classic']) if (!only || only === host) await runHost(host);
console.log('PASS host (Pi real, provider falso, sem rede)');
