#!/usr/bin/env node
/**
 * Smoke da TUI real no perfil Agent (host clássico), offline:
 * provider Anthropic falso em loopback, terminal via tmux. Confere a montagem aprovada:
 * startup compacto, editor/rodapé nativos, status único, plano abaixo do input,
 * seletor de skills, papéis, thinking manual e subagentes opt-in. --regular valida
 * também o modo scrollback do terminal; sem flag usa fullscreen. Requer tmux.
 * Nada fora de um diretório temporário.
 */
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AUTONOMY_POLICY } from '../agent/core/policy.mjs';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const fixturePiRoot = join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
const tuiMode = process.argv.includes('--regular') ? 'regular' : 'fullscreen';
function setFixtureTui(info) {
  const path = join(info.agentDir, 'settings.json');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  settings.tuiMode = tuiMode;
  // This smoke checks normal startup, not an upgrade from the local profile's
  // last seen changelog. Match the SDK used by this fixture's launcher.
  const env = JSON.parse(readFileSync(join(info.root, 'environment.json'), 'utf8'));
  settings.lastChangelogVersion = JSON.parse(readFileSync(join(env.AGENT_PI_ROOT, 'package.json'), 'utf8')).version;
  writeFileSync(path, JSON.stringify(settings));
}
// Execução independe de tmux e de qualquer extensão visual. Loader, resolver e
// backend de shell são os do Pi real; só HOME, settings e contexto são fixtures.
async function checkShellRuntime() {
  const piRoot = realpathSync(process.env.AGENT_PI_ROOT || join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent'));
  const load = p => import(pathToFileURL(join(piRoot, p)).href);
  const { loadExtensions, createExtensionRuntime } = await load('dist/core/extensions/loader.js');
  const { ExtensionRunner } = await load('dist/core/extensions/runner.js');
  const { createEventBus } = await load('dist/core/event-bus.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-shell-')));
  const saved = { ...process.env };
  try {
    const agent = join(root, 'agent'); mkdirSync(agent);
    const work = join(root, 'work'); mkdirSync(join(work, '.pi'), { recursive: true });
    const other = join(root, 'other'); mkdirSync(other);
    for (const shell of ['global', 'project']) {
      writeFileSync(join(root, `shell-${shell}`), `#!/bin/sh\nexport SHELL_FIXTURE=${shell}\nexec /bin/bash "$@"\n`, { mode: 0o755 });
    }
    const prefixFor = value => `export PREFIX_FIXTURE="\${PREFIX_FIXTURE:-}${value}"`;
    const settings = prefix => writeFileSync(join(work, '.pi/settings.json'), JSON.stringify({ shellPath: '~/shell-project', shellCommandPrefix: prefixFor(prefix) }));
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ shellPath: '~/shell-global', shellCommandPrefix: prefixFor('global') }));
    settings('project');
    Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agent,
      NODE_OPTIONS: '--no-warnings --import=/tmp/agent/core/runtime.mjs',
      AGENT_SKILLS_BEFORE: 'null', PI_AUTOMATIC_SKILLS: 'fixture-curated',
      AGENT_JUICE_SECRET: 'filtered', SHELL_ALLOWED: 'kept' });
    delete process.env.PREFIX_FIXTURE;
    delete process.env.SHELL_FIXTURE;
    const runtimePath = join(repo, 'agent/extensions/brain-live/shell-runtime.ts');
    const tui = join(repo, 'agent/extensions/agent/tui');
    const probe = `node -e 'console.log(JSON.stringify({cwd:process.cwd(),allowed:process.env.SHELL_ALLOWED,pre:process.env.PREFIX_FIXTURE??null,shell:process.env.SHELL_FIXTURE??null,options:process.env.NODE_OPTIONS,skills:process.env.PI_AUTOMATIC_SKILLS??null,legacyEnv:Object.keys(process.env).filter(k=>k.startsWith("AGENT_JUICE_"))}))'`;
    const expected = { cwd: work, allowed: 'kept', pre: 'global', shell: 'global', options: '--no-warnings', skills: null, legacyEnv: [] };
    for (const mode of ['plain', 'none', 'claude']) {
      delete process.env.AGENT_TRUST_PROJECT_SHELL;
      process.env.ARCA_COMPACT_TOOLS = mode === 'plain' ? '0' : '1';
      process.env.GARIME_CLAUDE_STYLE = mode === 'claude' ? '1' : '0';
      const paths = [runtimePath];
      if (mode === 'claude') paths.push(join(tui, 'claude-cards.ts'));
      const runtime = createExtensionRuntime();
      const loaded = await loadExtensions(paths, root, createEventBus(), runtime);
      assert.deepEqual(loaded.errors, [], mode);
      const [shell, ...visual] = loaded.extensions;
      assert.equal(shell.tools.size, 1);
      for (const ext of visual) {
        assert.equal(ext.tools.size, 0, 'TUI não registra execução');
        assert.equal(ext.handlers.size, 0, 'TUI não intercepta !cmd');
      }
      const tool = shell.tools.get('bash').definition;
      const ctx = { cwd: work, sessionManager: { getSessionId: () => 'shell-check', getSessionFile: () => undefined } };
      const execute = (command, signal, cwd = work) => tool.execute('shell-check', { command }, signal, undefined, { ...ctx, cwd });
      const userBash = shell.handlers.get('user_bash')[0];
      const runUser = async (command, projectPrefix, options) => {
        const { operations } = await userBash({ command }, ctx);
        // Pi antepõe o prefixo mesclado antes de chamar operations, mesmo sem opt-in do Agent.
        return operations.exec(`${prefixFor(projectPrefix)}\n${command}`, work, options);
      };
      const checkShell = async (projectPrefix, expectedOutput) => {
        const result = await execute(probe);
        assert.equal(result.structuredContent.exit_code, 0);
        assert.deepEqual(JSON.parse(result.content[0].text), expectedOutput, `${mode}: bash do modelo`);
        let userOut = '';
        const status = await runUser(probe, projectPrefix, { env: { ...process.env }, onData: b => { userOut += b; } });
        assert.equal(status.exitCode, 0);
        assert.deepEqual(JSON.parse(userOut), expectedOutput, `${mode}: !cmd`);
      };
      settings('project');
      await checkShell('project', expected);
      process.env.AGENT_TRUST_PROJECT_SHELL = '1';
      await checkShell('project', { ...expected, pre: 'project', shell: 'project' });
      settings('updated');
      await checkShell('updated', { ...expected, pre: 'updated', shell: 'project' });
      const global = JSON.parse((await execute(probe, undefined, other)).content[0].text);
      assert.deepEqual(global, { ...expected, cwd: other });
      const failed = await execute('printf stdout; printf stderr >&2; exit 7');
      assert.match(failed.content[0].text, /stdoutstderr/);
      assert.equal(failed.structuredContent.exit_code, 7);
      assert.equal(failed.isError, true);
      let failedOut = '';
      assert.equal((await runUser('printf stdout; printf stderr >&2; exit 7', 'updated', { onData: b => { failedOut += b; } })).exitCode, 7);
      assert.equal(failedOut, 'stdoutstderr');
      // Cancela após a primeira saída: prova propagação de AbortSignal em execução.
      const controller = new AbortController();
      await assert.rejects(tool.execute('cancel', { command: 'printf ready; sleep 30' }, controller.signal, () => controller.abort(), ctx), /aborted/i);
      const userAbort = new AbortController();
      await assert.rejects(runUser('printf ready; sleep 30', 'updated', { signal: userAbort.signal, onData: () => userAbort.abort() }), /aborted/i);
      const runner = new ExtensionRunner(loaded.extensions, runtime, root, {}, {});
      const base = { marker: 'native' };
      const renderer = runner.resolveToolRenderers('bash', () => base);
      if (mode === 'plain' || mode === 'none') assert.equal(renderer, base);
      else {
        const text = renderer.renderCall({ command: 'echo marker' }, { fg: (_c, t) => t, bold: t => t }, { isPartial: true, isError: false, executionStarted: true, state: {} }).render(100).join('\n');
        assert.match(text.replace(/\x1b\[[0-9;]*m/g, ''), /⏺ Bash/, 'Claude precede compacto na ordem da TUI');
      }
      if (mode !== 'claude') assert.equal(runner.resolveToolRenderers('read', () => base), base, 'compacto preserva renderer das outras tools');
      assert.ok(process.env.NODE_OPTIONS.includes('/agent/core/runtime.mjs'), 'env do pai intacto');
      assert.equal(process.env.AGENT_JUICE_SECRET, 'filtered');
      console.log(`ok shell ${mode}: bash/!cmd, cwd, settings, env, stdout/stderr, exit 7 e cancelamento`);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}
await checkShellRuntime();
assert.equal(spawnSync('tmux', ['-V']).status, 0, 'tmux necessário');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parent = mkdtempSync(join(tmpdir(), 'agent-tui-'));
const session = `agenttui${process.pid}`;
/** Um socket tmux PRÓPRIO por terminal de teste (-L): nunca toca o tmux do usuário. */
function terminal(sock) {
  const tmux = (...args) => spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8' });
  const screen = () => tmux('capture-pane', '-p', '-t', sock).stdout ?? '';
  /** Captura com os códigos ANSI, para conferir a cor da borda do input. */
  const screenAnsi = () => tmux('capture-pane', '-p', '-e', '-t', sock).stdout ?? '';
  const keys = (...args) => tmux('send-keys', '-t', sock, ...args);
  async function waitScreen(re, what, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const s = screen(); if (re.test(s)) return s; await sleep(250); }
    throw new Error(`${what}: não apareceu\n${screen()}`);
  }
  async function waitGone(re, what, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (!re.test(screen())) return; await sleep(250); }
    throw new Error(`${what}: continua na tela\n${screen()}`);
  }
  return { tmux, screen, screenAnsi, keys, waitScreen, waitGone };
}
const { tmux, screen, screenAnsi, waitScreen, waitGone } = terminal(session);

// Skills do repo que SÓ o Gabriel invoca (`disable-model-invocation: true`): ficam fora do system
// e o único caminho até elas é o comando `/skill:<nome>` do editor do Pi (enableSkillCommands).
const SKILLS_DIR = join(repo, 'agent/skills');
const USER_ONLY_SKILLS = ['design', 'dev', 'plan'].flatMap(category => readdirSync(join(SKILLS_DIR, category), { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name));
const PLAN_STEPS = [
  { text: 'Reproduzir o erro', status: 'done' },
  { text: 'Corrigir refresh do token', status: 'in_progress' },
  { text: 'Rodar checks gate', status: 'pending' },
];
const fake = await startFakeAnthropic([
  { tool: { name: 'plan', input: { steps: PLAN_STEPS } } },
  { text: 'ok', usage: { input: 100, cacheRead: 900, output: 3 } },
]);
try {
  const seed = join(parent, 'seed'); mkdirSync(seed);
  const prep = spawnSync(process.execPath, [join(repo, 'scripts/prepare-agent-test.mjs'), '--temp-parent', parent, '--agent-dir', seed, '--pi-root', fixturePiRoot], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(prep.status, 0, prep.stderr);
  const info = JSON.parse(prep.stdout);
  setFixtureTui(info);
  rmSync(join(info.agentDir, 'auth.json'), { force: true });
  writeFileSync(join(info.agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'fake-key', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } } }));
  // Megamind e peers não existem num perfil de teste (sem enrollment, sem malha):
  // uma extensão fixa publica os mesmos statuses que eles publicariam, para a
  // linha acima do input ser conferida na tela real.
  // Os status são reescritos algumas vezes porque as extensões reais de peers e
  // megamind publicam as mesmas chaves depois (e limpam quando não há malha).
  writeFileSync(join(info.agentDir, 'extensions/agent-tui-coordination.ts'), `export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const publish = () => {
      ctx.ui.setStatus('megamind', '◈ megamind · ARCA');
      ctx.ui.setStatus('agent-meta-peers', '4 sessões');
    };
    publish();
    const timer = setInterval(publish, 500); timer.unref?.();
    pi.on('session_shutdown', () => clearInterval(timer));
  });
}
`);
  const home = join(info.agentDir, '../..');
  mkdirSync(join(home, '.config/arca-projects'), { recursive: true });
  writeFileSync(join(home, '.config/arca-projects/config.json'), '{}');
  mkdirSync(join(info.agentDir, 'skills/arca-ops'), { recursive: true });
  writeFileSync(join(info.agentDir, 'skills/arca-ops/SKILL.md'), '---\nname: arca-ops\ndescription: Fixture offline de dica de operações\n---\nFixture.\n');
  const env = JSON.parse(readFileSync(join(info.root, 'environment.json'), 'utf8'));
  const exports = Object.entries({ ...env, AGENT_LEARN: '0', AGENT_DISPATCHER: '0', AGENT_CACHE_KEEPER: '0' }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  // Projeto vazio: sem .pi, sem pergunta de confiança. Com git, para o rodapé ter branch.
  const work = join(parent, 'work'); mkdirSync(work);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: work, encoding: 'utf8' }).status, 0, `git ${args[0]}`);
  git('init', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  const cmd = `cd ${JSON.stringify(work)} && env ${exports} ${JSON.stringify(join(info.root, 'launch.sh'))} --model anthropic/claude-haiku-5-5`;
  assert.equal(tmux('new-session', '-d', '-s', session, '-x', '150', '-y', '200', cmd).status, 0, 'tmux abriu');

  // Compact startup + native editor/footer; statuses each have one producer.
  await waitScreen(/claude-haiku-5-5/, 'modelo no status nativo');
  assert.doesNotMatch(screen(), /simple|complex/, 'sem modos legados');
  await waitScreen(/4 sessões/u, 'peers no rodapé nativo');
  const startup = tmux('capture-pane', '-p', '-S', '-500', '-t', session).stdout;
  assert.match(startup, /✳ Agent/, 'marca compacta no startup');
  assert.match(startup, /Use \/skill:arca-ops para operar o projeto/);
  assert.doesNotMatch(screen(), /Dicas|┌─|└─|US\$|⠀⠀⠀⢠⣶/u, 'sem palco, caixa ou custo Agent duplicado');
  assert.match(screen(), /work \(main\)/, 'diretório e branch nativos');
  assert.match(screen(), /claude-haiku-5-5/, 'modelo no rodapé nativo');
  for (const width of [200, 85, 150]) {
    tmux('resize-window', '-t', session, '-x', String(width), '-y', '45');
    await sleep(1000);
    assert.equal(screen().split('4 sessões').length - 1, 1, 'uma contagem de sessões após resize');
    assert.doesNotMatch(screen(), /┌─|└─|Dicas/);
  }
  assert.equal(fake.messages().length, 0, 'startup não consulta modelo');
  assert.doesNotMatch(screen(), /(?<!\/)subagents on/, 'sem status de opt-in: subagentes sempre ligados');
  tmux('send-keys', '-t', session, '-l', 'oi');
  await waitScreen(/oi/, 'texto no editor nativo');
  tmux('send-keys', '-t', session, 'Enter');
  let s = await waitScreen(/plano 1\/3/, 'turno publica plano');
  await waitScreen(/◈ megamind · ARCA/u, 'coordenação preservada');
  await waitScreen(/4 sessões/, 'status Peers após o turno');
  assert.equal(screen().split('4 sessões').length - 1, 1, 'peers não duplicado na conversa');

  // 5) Plano ABAIXO do input: ↓ vazio foca, Enter alterna, ←/→ fecham/abrem, ↑/esc voltam.
  const lines = () => screen().split('\n');
  const rowOf = (re) => lines().findIndex(l => re.test(l));
  const planLine = () => lines().find(l => /plano 1\/3/.test(l)) ?? '';
  await waitScreen(/▸ plano 1\/3 · ◉ Corrigir refresh do token/, 'plano recolhido abaixo do input');
  const rowsBeforePlan = screen().split('\n');
  const nativeRule = rowsBeforePlan.findIndex(l => /^\s*─{10}/u.test(l));
  assert.ok(nativeRule >= 0 && nativeRule < rowOf(/▸ plano 1\/3/), 'plano abaixo do editor nativo');
  assert.ok(rowOf(/▸ plano 1\/3/) < rowOf(/work \(main\)/), 'plano acima do rodapé nativo');
  assert.match(planLine(), /↓ seleciona · clique abre\/fecha/, 'dica do plano aponta para baixo');

  // Input NÃO vazio: ↓ continua sendo do editor (não foca o plano, não perde o texto).
  tmux('send-keys', '-t', session, '-l', 'rascunho');
  await waitScreen(/rascunho/, 'texto no input');
  tmux('send-keys', '-t', session, 'Down');
  await sleep(750);
  assert.match(planLine(), /↓ seleciona/, '↓ com texto no input não foca o plano');
  assert.match(screen(), /rascunho/, '↓ com texto preserva o input');
  tmux('send-keys', '-t', session, 'C-u');
  await waitGone(/rascunho/, 'Ctrl+U limpa o input');

  // Input vazio: ↓ desce para o plano (dica focada, com ›) e → expande.
  tmux('send-keys', '-t', session, 'Down');
  await waitScreen(/› ▸ plano 1\/3/u, '↓ com input vazio foca o plano abaixo');
  assert.match(planLine(), /Enter abre\/fecha · ←\/→ fecha\/abre · ↑\/esc volta/, 'dica do plano focado');
  tmux('send-keys', '-t', session, 'Right');
  s = await waitScreen(/▾ plano 1\/3/, 'plano expandido com →');
  assert.match(s, /✓ Reproduzir o erro/);
  assert.match(s, /◉ Corrigir refresh do token/);
  assert.match(s, /◻ Rodar checks gate/);
  tmux('send-keys', '-t', session, 'Left');
  await waitScreen(/› ▸ plano 1\/3 · ◉ Corrigir refresh do token/u, '← recolhe o plano');
  // ↓ no plano não tem para onde ir (é o último bloco antes do rodapé): o foco fica.
  tmux('send-keys', '-t', session, 'Down');
  await sleep(750);
  assert.match(planLine(), /› ▸ plano/u, '↓ no plano mantém o foco');
  // Caminho inverso: ↑ devolve o foco ao input.
  tmux('send-keys', '-t', session, 'Up');
  await waitScreen(/▸ plano 1\/3 · ◉ Corrigir refresh do token · ↓ seleciona/u, '↑ devolve o foco ao input');
  tmux('send-keys', '-t', session, 'Down');
  await waitScreen(/› ▸ plano 1\/3/u, '↓ foca o plano de novo');
  tmux('send-keys', '-t', session, 'Escape');
  await waitScreen(/▸ plano 1\/3 · ◉ Corrigir refresh do token · ↓ seleciona/u, 'esc devolve o foco ao input');
  // Enter abre/fecha a lista mantendo o foco no plano, sem enviar um prompt.
  const requestsBeforeEnter = fake.messages().length;
  tmux('send-keys', '-t', session, 'Down');
  await waitScreen(/› ▸ plano 1\/3/u, '↓ foca o plano antes do Enter');
  tmux('send-keys', '-t', session, 'Enter');
  await waitScreen(/› ▾ plano 1\/3/u, 'Enter abre a lista do plano');
  assert.match(screen(), /◻ Rodar checks gate/);
  tmux('send-keys', '-t', session, 'Enter');
  await waitScreen(/› ▸ plano 1\/3/u, 'Enter fecha a lista do plano');
  assert.equal(fake.messages().length, requestsBeforeEnter, 'Enter no plano não envia mensagem ao modelo');
  tmux('send-keys', '-t', session, 'Up');
  await waitScreen(/▸ plano 1\/3 · ◉ Corrigir refresh do token · ↓ seleciona/u, '↑ devolve o foco ao input após Enter');
  tmux('send-keys', '-t', session, '-l', 'tchau');
  await waitScreen(/tchau/, 'editor normal depois de voltar do plano');
  tmux('send-keys', '-t', session, 'C-u');
  await waitGone(/tchau/, 'Ctrl+U limpa o input depois do plano');

  if (process.env.SHOW) console.log(screen().split('\n').filter(l => l.trim()).slice(-8).join('\n'));
  assert.ok(fake.messages().length >= 2, 'provider falso recebeu o turno e a volta da tool');
  console.log(`ok tui ${info.host}: startup compacto, editor/rodapé nativos, status único e plano navegável`);
} finally {
  tmux('kill-server');
  await fake.close();
  rmSync(parent, { recursive: true, force: true });
}

// ---- opt-in a quente no MESMO processo -----------------------------------
// ctx.getSystemPrompt() mede o prompt efetivo em before_provider_request.
// PID e contador sequencial provam que o processo não reinicia durante a troca.
async function runHotSwitch(host) {
  const hotParent = mkdtempSync(join(tmpdir(), `agent-tui-hot-${host}-`));
  const sock = `agenthot${process.pid}${host}`;
  const term = terminal(sock);
  const hotFake = await startFakeAnthropic([{ text: 'ok' }]);
  try {
    const seed = join(hotParent, 'seed'); mkdirSync(seed);
    const prep = spawnSync(process.execPath, [join(repo, 'scripts/prepare-agent-test.mjs'), '--temp-parent', hotParent, '--host', host, '--agent-dir', seed, '--pi-root', fixturePiRoot], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    if (prep.status !== 0) {
      throw new Error(prep.stderr);
    }
    const info = JSON.parse(prep.stdout);
  setFixtureTui(info);
    rmSync(join(info.agentDir, 'auth.json'), { force: true });
    writeFileSync(join(info.agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: hotFake.baseUrl, apiKey: 'fake-key', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } } }));
    // Observador: NÃO devolve nada (não altera prompt, mensagens nem tools); só anota
    // PID, um contador local e o system efetivo antes de cada requisição ao provider.
    const observeFile = join(hotParent, 'system.jsonl');
    writeFileSync(join(info.agentDir, 'extensions', 'agent-observe-system.ts'), [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      'export default function (pi: any) {',
      '  let seq = 0;',
      "  pi.on('session_start', (_event: any, ctx: any) => writeFileSync(process.env.AGENT_OBSERVE_SYSTEM + '.session', ctx.sessionManager.getSessionId()));",
      "  pi.on('before_provider_request', async (_event: any, ctx: any) => {",
      '    const file = process.env.AGENT_OBSERVE_SYSTEM;',
      '    if (!file) return;',
      "    appendFileSync(file, JSON.stringify({ pid: process.pid, seq: ++seq, system: ctx.getSystemPrompt() }) + '\\n');",
      '  });',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(info.agentDir, 'agent-models.json'), JSON.stringify({ tiers: {}, roleModels: Object.fromEntries(['scout', 'worker', 'planner', 'reviewer', 'visual'].map(role => [role, [{ model: 'anthropic/claude-haiku-5-5', thinking: 'medium' }]])) }));
    const env = JSON.parse(readFileSync(join(info.root, 'environment.json'), 'utf8'));
    const exports = Object.entries({ ...env, AGENT_LEARN: '0', AGENT_DISPATCHER: '0', AGENT_CACHE_KEEPER: '0', AGENT_OBSERVE_SYSTEM: observeFile, AGENT_LUCID_SSH: '/usr/bin/false' })
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    const work = join(hotParent, 'work'); mkdirSync(work);
    assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: work }).status, 0, 'git init');
    const cmd = `cd ${JSON.stringify(work)} && env ${exports} ${JSON.stringify(join(info.root, 'launch.sh'))} --model anthropic/claude-haiku-5-5`;
    assert.equal(term.tmux('new-session', '-d', '-s', sock, '-x', '200', '-y', '45', cmd).status, 0, `tmux abriu (${host})`);

    const observed = () => {
      let raw = ''; try { raw = readFileSync(observeFile, 'utf8'); } catch { return []; }
      return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    };
    /** Espera por CONDIÇÃO: nova observação do turno e depois quiescência (sem novas linhas). */
    const turn = async (text, label) => {
      const before = observed().length;
      term.keys('-l', text);
      await term.waitScreen(new RegExp(text), `${host}/${label}: texto no input`);
      term.keys('Enter');
      const deadline = Date.now() + 60_000;
      while (observed().length === before) {
        if (Date.now() > deadline) throw new Error(`${host}/${label}: nenhuma requisição ao provider\n${term.screen()}`);
        await sleep(200);
      }
      let stable = observed().length;
      const quiet = Date.now() + 10_000;
      while (Date.now() < quiet) {
        await sleep(400);
        const now = observed().length;
        if (now === stable) break;
        stable = now;
      }
      return observed().slice(before);
    };

    await term.waitScreen(/claude-haiku-5-5/, `${host}: TUI subiu`);


    // ---- seletor Agent real: não basta provar o autocomplete nativo ------
    assert.equal(hotFake.messages().length, 0, `${host}: provedor consultado antes do seletor`);
    assert.ok(USER_ONLY_SKILLS.includes('microcopy'), 'skill manual de referência existe');
    const sessionId = () => readFileSync(observeFile + '.session', 'utf8');
    const sessionDeadline = Date.now() + 20_000;
    while (!existsSync(observeFile + '.session')) {
      if (Date.now() > sessionDeadline) throw new Error('observer did not capture session');
      await sleep(200);
    }
    const originalSession = sessionId();
    assert.ok(originalSession, `${host}: sessão capturada pelo observador`);
    term.keys('-l', '/skill');
    let picker = await term.waitScreen(/skills · design/, `${host}: /skill sem dois-pontos abre seletor próprio abaixo do input`, 5_000);
    assert.match(picker, /^\s*▸ a11y\s+ \s+\S/m, `${host}: seleção e descrição; design sob demanda`);
    assert.match(picker, /^\s+award-site\s+ \s+\S/m, `${host}: design não é automática`);
    assert.doesNotMatch(picker, /^\s*(?:▸ )?(?:review|pr|skills)\s+◆/m, `${host}: manuais sem marca`);
    assert.ok(picker.split('\n').findIndex(l => /─{10}/.test(l)) < picker.split('\n').findIndex(l => l.includes('skills · design')), 'seletor fica abaixo do editor nativo');
    assert.doesNotMatch(picker, /→ skill:/, 'autocomplete nativo não divide tela com o seletor');
    term.keys('Escape');
    await term.waitGone(/skills · design/, `${host}: Esc fecha /skill sem dois-pontos`);
    assert.match(term.screen(), /^\s*\/skill\s*$/m, 'Esc preserva /skill sem reescrever o rascunho');
    term.keys('C-u');
    await term.waitGone(/^\s*\/skill\s*$/m, `${host}: limpa /skill após Esc`);
    term.keys('-l', '/skill');
    await term.waitScreen(/skills · design/, `${host}: /skill reabre o seletor`);
    term.keys('Down');
    await term.waitScreen(/^\s*▸ award-site\s+ /m, `${host}: seta escolhe award-site`);
    term.keys('Tab');
    picker = await term.waitScreen(/skills · dev/, `${host}: Tab em /skill visita dev`, 5_000);
    assert.match(picker, /^\s*▸ debug\s+ /m, `${host}: debug sob demanda`);
    assert.doesNotMatch(picker, /simple|complex|(?<!\/)subagents on/, 'Tab não ativa equipe nem modo');
    assert.equal(sessionId(), originalSession, 'Tab não troca sessão');
    term.keys('Tab');
    picker = await term.waitScreen(/skills · plan/, `${host}: Tab visita plan`);
    assert.match(picker, /^\s*▸ rea\s+ /m, `${host}: rea sob demanda`);
    term.keys('Tab');
    picker = await term.waitScreen(/skills · system/, `${host}: Tab visita system`);
    assert.match(picker, /^\s*▸ computer-use\s+◆/m, 'computer-use é automática em qualquer modo');
    term.keys('Tab');
    await term.waitScreen(/skills · design/, `${host}: Tab volta a design`);
    term.keys('-l', ':mic');
    picker = await term.waitScreen(/^\s*▸ microcopy\s+\S/m, `${host}: filtro encontra skill manual`);
    assert.doesNotMatch(picker, /^\s*(?:▸ )?a11y\s+/m, 'filtro remove outra skill');
    assert.doesNotMatch(picker, /^\s*▸ microcopy\s+◆/m, 'microcopy continua manual');
    term.keys('Enter');
    await term.waitScreen(/\/skill:microcopy\s/, `${host}: Enter insere o comando`);
    await term.waitGone(/skills · design/, `${host}: Enter fecha sem enviar`);
    term.keys('C-u');
    await term.waitGone(/\/skill:/, `${host}: limpa comando sem enviar`);
    term.keys('-l', '/skill:');
    await term.waitScreen(/skills · design/, `${host}: /skill: continua abrindo sem filtro`);
    term.keys('Enter');
    await term.waitScreen(/\/skill:a11y\s/, `${host}: Enter em /skill: insere comando`);
    await term.waitGone(/skills · design/, `${host}: /skill: fecha após inserir`);
    term.keys('C-u');
    await term.waitGone(/\/skill:/, `${host}: limpa /skill: sem enviar`);
    term.keys('-l', '/sk');
    term.keys('Tab');
    await term.waitScreen(/skills · design/, `${host}: /sk+Tab abre na primeira categoria`);
    term.keys('Escape');
    await term.waitGone(/skills · design/, `${host}: Esc fecha o seletor`);
    assert.match(term.screen(), /\/skill:/, 'Esc preserva o rascunho');
    term.keys('C-u');
    await term.waitGone(/\/skill:/, `${host}: limpa após Esc`);
    assert.equal(hotFake.messages().length, 0, `${host}: seleção não consulta o provedor`);
    assert.equal(observed().length, 0, `${host}: seleção não inicia turno`);
    assert.equal(sessionId(), originalSession, 'seletor preserva sessão');
    console.log(`ok skill-picker ${host}: filtro, ◆, setas, Tab visita sem trocar sessão, Enter insere, Esc fecha; zero requests`);

    // ---- /models real: papéis visíveis e abrir/cancelar não grava ----------
    const rolesFile = join(info.agentDir, 'agent-models.json');
    const rolesBefore = readFileSync(rolesFile, 'utf8');
    const sessionModel = () => /claude-haiku-5-5 [•·] \w+/.exec(term.screen())?.[0];
    const modelBeforePanel = sessionModel();
    assert.ok(modelBeforePanel, `${host}: modelo/thinking visíveis antes do painel`);
    term.keys('-l', '/models'); term.keys('Enter');
    const modelPanel = await term.waitScreen(/scout[\s\S]*worker[\s\S]*planner[\s\S]*reviewer[\s\S]*visual/, `${host}: cinco papéis no painel real`);
    for (const role of ['scout', 'worker', 'planner', 'reviewer', 'visual']) {
      const line = modelPanel.split('\n').find(l => new RegExp(`\\b${role}\\b`).test(l));
      assert.match(line ?? '', /models\.json.*(?:medium|high|low)/, `${host}/${role}: origem e thinking efetivos`);
    }
    term.keys('Down', 'Down', 'Enter');
    await term.waitScreen(/autorizados neste papel/, `${host}: picker restrito de scout`);
    term.keys('Escape');
    await term.waitScreen(/Enter par autorizado/, `${host}: cancelar volta ao papel`);
    // `q` fecha o painel; dois Esc rápidos são o atalho global da lista de fork.
    term.keys('q');
    await term.waitGone(/Enter par autorizado/, `${host}: fecha painel`);
    assert.equal(readFileSync(rolesFile, 'utf8'), rolesBefore, `${host}: abrir/cancelar não grava preferências`);
    assert.equal(sessionModel(), modelBeforePanel, `${host}: sessão/thinking intactos`);
    assert.equal(hotFake.messages().length, 0, `${host}: /models não consulta modelo`);
    console.log(`ok roles ${host}: cinco papéis, origem/thinking, picker autorizado; cancelar preserva arquivo e sessão`);

    // ---- escolha manual de modelo + thinking (bug relatado) ---------------
    // `/thinking <nível>` é do Pi; o Agent não pode desfazer nem levar o modelo
    // com ele. O rodapé nativo mostra modelo e nível.
    {
      const footerLine = () => term.screen().split('\n').filter(l => /claude-haiku-5-5/.test(l)).at(-1) ?? '';
      term.keys('-l', '/thinking high');
      await term.waitScreen(/\/thinking high/, `${host}: /thinking no input`);
      // O primeiro Enter pode ser consumido pelo dropdown de argumentos do próprio Pi
      // (níveis de thinking): insiste até o comando sair do input.
      for (let i = 0; i < 6 && /\/thinking/.test(term.screen()); i++) { term.keys('Enter'); await sleep(500); }
      await term.waitScreen(/claude-haiku-5-5.*high/, `${host}: /thinking high aplicado no rodapé`);
      assert.match(footerLine(), /claude-haiku-5-5.*high/, `${host}: Agent mexeu no thinking/modelo escolhidos:\n${footerLine()}`);
      console.log(`ok manual ${host}: /thinking high persiste e o modelo não troca`);
    }

    const phases = [];
    // Quatro turnos no mesmo processo: subagentes sempre ligados, sem acumular bloco.
    phases.push({ label: 'turno1', obs: await turn('oi', 'turno1') });
    phases.push({ label: 'turno2', obs: await turn('com a equipe', 'turno2') });
    phases.push({ label: 'turno3', obs: await turn('continue', 'turno3') });
    phases.push({ label: 'turno4', obs: await turn('sozinho de novo', 'turno4') });

    // MESMO PROCESSO: um único PID e um contador que nunca reinicia (relançar zeraria os dois).
    const all = observed();
    const pids = [...new Set(all.map(o => o.pid))];
    assert.equal(pids.length, 1, `${host}: observações de mais de um processo (${pids.join(', ')}) — houve relançamento`);
    assert.deepEqual(all.map(o => o.seq), all.map((_, i) => i + 1), `${host}: contador da extensão reiniciou — não foi o mesmo processo`);
    assert.ok(all.length >= 4, `${host}: ${all.length} observações para 4 turnos`);

    const count = (text, re) => (text.match(re) ?? []).length;
    const body = (policy) => new RegExp(policy.split('\n')[0].replace(/[().*+?^${}|[\]\\]/g, '\\$&'), 'g');
    const counts = (text) => ({
      autonomy: count(text, /<agent_autonomy>/g),
      complex: count(text, /<agent_complex>/g),
      autonomyBody: count(text, body(AUTONOMY_POLICY)),
    });
    // Autonomia é exatamente 1 em TODA observação (inclusive fora dos turnos): nada acumula.
    for (const o of all) assert.equal(counts(o.system).autonomy, 1, `${host}: observação ${o.seq} com autonomia ${counts(o.system).autonomy}`);
    for (const { label, obs } of phases) {
      assert.ok(obs.length > 0, `${host}/${label}: turno sem requisição observada`);
      for (const o of obs) {
        assert.deepEqual(counts(o.system), { autonomy: 1, complex: 0, autonomyBody: 1 },
          `${host}/${label}: observação ${o.seq} deveria ter autonomia 1 e complex 0`);
        assert.equal(count(o.system, /^<\/?agent_workflow>$/gm), 0, `${host}/${label}: receita no system efetivo`);
        assert.equal(count(o.system, /Receita deste projeto|Regras aprendidas aqui/g), 0, `${host}/${label}: conteúdo da receita no system efetivo`);
        assert.doesNotMatch(o.system, /Modo complex \(vale só enquanto/, `${host}/${label}: delegação obrigatória no prompt`);
      }
    }
    // Ancoragem: na 1ª requisição da sessão nova o observado é o system que foi pela rede
    // (prova que `ctx.getSystemPrompt()` não é uma reconstrução do teste).
    const wire = hotFake.messages()[0].system;
    assert.equal(all[0].system, Array.isArray(wire) ? wire.map(b => b.text).join('\n') : wire, `${host}: observado == system da 1ª requisição`);
    const [p1, p2, p3, p4] = phases;
    assert.equal(p3.obs.at(-1).system, p2.obs.at(-1).system, `${host}: turnos seguidos mandam o mesmo system efetivo (sem acúmulo)`);
    assert.equal(p4.obs.at(-1).system, p1.obs.at(-1).system, `${host}: quarto turno preserva o system efetivo inicial`);
    assert.equal(p2.obs.at(-1).system, p1.obs.at(-1).system, `${host}: segundo turno preserva o system efetivo`);
    assert.match(p1.obs[0].system, /Your user \(the person in this session\) decides/);
    assert.match(p1.obs[0].system, /Act as an orchestrator: delegate recon and bulk reading to `scout`/, `${host}: diretriz de orquestrador no system`);
    assert.equal(hotFake.messages().length, 4, `quatro turnos, sem inferência auxiliar: ${JSON.stringify(hotFake.messages().map(p => ({ model: p.model, max_tokens: p.max_tokens })))}`);
    console.log(`ok hot ${host}: subagentes sempre ligados (PID ${pids[0]}, ${all.length} observações seq 1..${all.length}) em 4 turnos — autoridade e diretriz de orquestrador estáveis, sem inferência extra`);
  } finally {
    term.tmux('kill-server');
    await hotFake.close();
    rmSync(hotParent, { recursive: true, force: true });
  }
}

for (const host of ['classic']) await runHotSwitch(host);
console.log(`PASS tui ${tuiMode} (Pi real, tmux, provider falso, sem rede)`);
