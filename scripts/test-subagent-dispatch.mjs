#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Dispatch real do Mark com provider falso: assíncrono, modelos por papel,
// concorrência e receita restrita aos filhos. Sem rede.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { juiceOperation, setJuiceMode } from '../mark/juice/client.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.MARK_JUICE_PI_ROOT || join(homedir(), '.local/share/pi-overlay/current/lib/node_modules/@earendil-works/pi-coding-agent');
const cli = join(piRoot, 'dist/cli.js');
assert.ok(existsSync(cli), 'pi instalado');

const root = mkdtempSync(join(tmpdir(), 'subagent-dispatch-'));
const home = join(root, 'home');
const agent = join(home, '.pi/agent');
mkdirSync(join(agent, 'agents'), { recursive: true });
writeFileSync(join(agent, 'agents/worker.md'), '---\nname: worker\ndescription: fixture\ntools: read, edit, bash\nbrief_required: [objective, context, scope, done_when, stop_if]\n---\nfixture\n');
writeFileSync(join(agent, 'agents/todoer.md'), '---\nname: todoer\ndescription: tool fora da lista só-leitura\ntools: read, todo\n---\nfixture\n');
writeFileSync(join(agent, 'agents/emptytools.md'), '---\nname: emptytools\ndescription: tools vazia = conjunto padrão\ntools: []\n---\nfixture\n');
writeFileSync(join(agent, 'agents/alltools.md'), '---\nname: alltools\ndescription: sem tools = conjunto padrão\n---\nfixture\n');
writeFileSync(join(agent, 'agents/mutator.md'), '---\nname: mutator\ndescription: fixture que edita\ntools: read, edit\n---\nfixture\n');
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], enableSkillCommands: false, retry: { enabled: false }, quietStartup: true }));
writeFileSync(join(agent, 'auth.json'), '{}');
const ledger = join(root, 'run.v3.json');
Object.assign(process.env, { MARK_JUICE_ENABLED: '1', MARK_JUICE_HOME: root, MARK_JUICE_STATE: ledger }); juiceOperation({ op: 'init', runId: 'ep', mode: 'complex' });

// Provider falso: pai chama `subagent` uma vez, depois encerra com texto; filho só responde texto.
const provider = join(root, 'provider.mjs');
writeFileSync(provider, `
import { AssistantMessageEventStream } from '${join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js').replace(/\\\\/g, '/')}';
export default function (pi) {
  pi.on('session_start', () => {
    if (process.env.FG_SESSION_MODE) pi.appendEntry('mark-mode', { version: 1, mode: process.env.FG_SESSION_MODE });
  });
  const stream = (model, context) => {
    const s = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      const n = context.messages.filter(m => m.role === 'assistant').length;
      const child = !!process.env.MARK_JUICE_CHILD;
      if (!process.env.MARK_JUICE_CHILD && process.env.FG_TOOLS) {
        const { writeFileSync } = await import('node:fs');
        try { writeFileSync(process.env.FG_TOOLS, JSON.stringify(context)); } catch {}
      }
      if (process.env.MARK_JUICE_CHILD && process.env.FG_CHILD_CTX) {
        const { writeFileSync } = await import('node:fs');
        try { writeFileSync(process.env.FG_CHILD_CTX, JSON.stringify(context)); } catch {}
      }
      const lastUser = [...context.messages].reverse().find(m => m.role === 'user');
      const userText = lastUser ? (Array.isArray(lastUser.content) ? lastUser.content.map(p => p.text || '').join(' ') : String(lastUser.content)) : '';
      let content, stopReason = 'stop';
      if (/^Você decide qual modelo/.test(userText)) {
        content = [{ type: 'text', text: 'apoio' }]; // despachante: manda para o barato
      } else if (child && n === 0 && process.env.FG_SANDBOX_COMMAND) {
        content = [{ type: 'toolCall', id: 'call-sandbox', name: 'bash', arguments: { command: process.env.FG_SANDBOX_COMMAND } }];
        stopReason = 'toolUse';
      } else if (child && process.env.FG_WRITE) {
        const tag = /tarefa-(\\w+)/.exec(userText)?.[1] ?? 'single';
        if (n === 0) {
          content = [{ type: 'toolCall', id: 'write-' + tag, name: 'bash', arguments: { command: 'printf ' + tag + ' > file-' + tag + ' && git add file-' + tag + ' && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m tarefa-' + tag } }];
          stopReason = 'toolUse';
        } else {
          const { appendFileSync } = await import('node:fs');
          appendFileSync(process.env.FG_WRITE, JSON.stringify({ tag, cwd: process.cwd() }) + '\\n');
          content = [{ type: 'text', text: 'COMMIT-' + tag }];
        }
      } else if (child && model.id === 'cheap') {
        content = [{ type: 'text', text: process.env.FG_CHEAP_TEXT || 'node --test: 1 failed' }]; // barato falhou
      } else if (child && process.env.FG_LOG) {
        // Leque: registra quando cada filho começou e quando emitiu o 1º token.
        const tag = /tarefa-(\\w+)/.exec(userText)?.[1] ?? '?';
        const { appendFileSync } = await import('node:fs');
        const log = (what) => appendFileSync(process.env.FG_LOG, JSON.stringify({ tag, what, t: Date.now() }) + '\\n');
        log('start');
        const delay = Number(process.env.FG_DELAY || 400);
        const text = 'FILHO-' + tag;
        const partial = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        s.push({ type: 'start', partial });
        await new Promise(r => setTimeout(r, delay));
        log('token');
        partial.content = [{ type: 'text', text: '' }];
        s.push({ type: 'text_start', contentIndex: 0, partial });
        partial.content = [{ type: 'text', text }];
        s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
        s.push({ type: 'text_end', contentIndex: 0, content: text, partial });
        await new Promise(r => setTimeout(r, delay));
        s.push({ type: 'done', reason: 'stop', message: { ...partial } }); s.end();
        return;
      } else if (!child && n === 0 && process.env.FG_PARALLEL) {
        const brief = { objective: 'o', context: 'c', scope: 's', done_when: 'd', stop_if: 'x' };
        const names = process.env.FG_PARALLEL.split(',');
        content = [{ type: 'toolCall', id: 'call-p', name: 'subagent', arguments: { tasks: ['a', 'b', 'c'].map((x, i) => ({ agent: names[i % names.length], brief, task: 'tarefa-' + x })) } }];
        stopReason = 'toolUse';
      } else if (!child && n === 1 && process.env.FG_KEEPALIVE) {
        // Mantém o pai vivo enquanto os filhos assíncronos correm.
        content = [{ type: 'toolCall', id: 'call-wait', name: 'bash', arguments: { command: 'sleep ' + process.env.FG_KEEPALIVE } }];
        stopReason = 'toolUse';
      } else if (!child && n === 2 && process.env.FG_INTEGRATE) {
        const launch = context.messages.find(m => m.role === 'toolResult' && m.toolName === 'subagent');
        const text = launch?.content?.map(p => p.text || '').join(' ') || '';
        const jobId = /Launched subagent job ([^ ]+)/.exec(text)?.[1];
        content = [{ type: 'toolCall', id: 'integrate', name: 'subagent', arguments: { action: 'integrate', jobId } }];
        stopReason = 'toolUse';
      } else if (!child && n === 0) {
        content = [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { agent: process.env.FG_AGENT || 'worker', brief: { objective: 'o', context: 'c', scope: 's', done_when: 'd', stop_if: 'x' }, task: 'fixture' } }];
        stopReason = 'toolUse';
      } else content = [{ type: 'text', text: child ? 'FILHO-PRONTO' : 'PAI-TERMINOU' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      s.push({ type: 'start', partial: message });
      s.push({ type: 'done', reason: stopReason, message }); s.end();
    });
    return s;
  };
  pi.registerProvider('fg-fake', { api: 'fg-fake', apiKey: 'offline', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'fake', name: 'fake', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }, { id: 'cheap', name: 'cheap', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }], stream, streamSimple: stream });
}
`);

let runIndex = 0;
function runPi(extraEnv) {
  if (extraEnv.MARK_JUICE_PILOT_MODE) {
    Object.assign(process.env, { MARK_JUICE_ENABLED: '1', MARK_JUICE_HOME: root, MARK_JUICE_STATE: ledger }); setJuiceMode(extraEnv.MARK_JUICE_PILOT_MODE);
    delete extraEnv.MARK_JUICE_PILOT_MODE;
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_DURABLE_HOST: '0',
    MARK_JUICE_ENABLED: '1', MARK_JUICE_STATE: ledger, MARK_JUICE_HOME: root, MARK_JUICE_PI_ROOT: piRoot,
    NODE_OPTIONS: '', MARK_SUBAGENT_CHILD_EXTENSIONS: provider, ...extraEnv };
  const r = spawnSync(process.execPath, [cli, '-p', '--mode', 'json', '--session', join(root, `parent-${++runIndex}.jsonl`), '--no-extensions', '-e', provider, '-e', join(repo, 'mark/extensions/brain-live/subagent/index.ts'), '--model', 'fg-fake/fake', 'tarefa'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Fora do piloto: assíncrono (comportamento legado intacto)
const bg = runPi({ MARK_JUICE_ENABLED: '0' });
const end3 = bg.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent');
assert.match(end3.result.content[0].text, /Launched subagent job .* status running/, 'fora do piloto continua assíncrono');
console.log('ok legado: subagent assíncrono (jobId + follow-up)');
// Receita usada pelos slots de modelo, não pelo prompt do principal.
mkdirSync(join(root, '.mark'), { recursive: true });
writeFileSync(join(root, '.mark/workflow.md'), ['# Receita', '', 'versão: v1', '', '## Etapas (complex)',
  ...['worker', 'mutator', 'todoer', 'alltools', 'emptytools'].map((r, i) => `${i + 1}. ${r} · apoio · contrato`), ''].join('\n'));

// Piloto em complex: assíncrono como o Pi normal — a chamada volta
//    com jobId na hora e o pai segue trabalhando.
const pilot = runPi({ MARK_JUICE_PILOT_MODE: 'complex' });
const end9 = pilot.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent');
const t9 = end9.result.content[0].text;
assert.match(t9, /Launched subagent job .* status running/, `complex é assíncrono: ${t9.slice(0, 200)}`);
assert.equal(end9.result.details.job.status, 'running');
assert.doesNotMatch(t9, /FILHO-PRONTO/, 'nada de resultado inline');
console.log('ok piloto em complex: dispatch assíncrono (jobId na hora)');

// Both gates must ignore conflicting global defaults and accounting modes.
for (const [savedMode, defaultMode, allowed] of [['complex', 'simple', true], ['simple', 'complex', false], ['invalid', 'complex', false]]) {
  const events = runPi({ MARK_JUICE_PILOT_MODE: defaultMode, FG_SESSION_MODE: savedMode });
  const result = events.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result;
  if (allowed) assert.match(result.content[0].text, /Launched subagent job/);
  else {
    assert.doesNotMatch(result.content[0].text, /Launched subagent job/);
    assert.match(result.content[0].text, savedMode === 'invalid' ? /modo da sessão inválido/ : /Modo simple/);
  }
}
console.log('ok dispatch usa o branch: default/ledger divergentes e registro inválido');

// Slot do apoio continua valendo no assíncrono (despachante escolhe apoio).
writeFileSync(join(root, 'preferences.v3.json'), JSON.stringify({ mode: 'complex', supportModel: 'fg-fake/cheap' }));
const t10 = runPi({ MARK_JUICE_PILOT_MODE: 'complex' }).find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result.content[0].text;
assert.match(t10, /Models: worker=fg-fake\/cheap/, `slot apoio no assíncrono: ${t10.slice(0, 250)}`);
console.log('ok assíncrono: slot/despachante ainda manda o papel para o apoio');
rmSync(join(root, 'preferences.v3.json'));
delete process.env.MARK_JUICE_SUPPORT_MODEL;

// tasks[] independentes correm em paralelo de verdade: três papéis distintos,
//     todos nascidos antes do 1º token de qualquer um deles.
const plog = join(root, 'async-parallel.log'); rmSync(plog, { force: true });
const par = runPi({ MARK_JUICE_PILOT_MODE: 'complex', FG_PARALLEL: 'worker,mutator,alltools', FG_LOG: plog, FG_DELAY: '2500', FG_KEEPALIVE: '8' });
const t11 = par.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result.content[0].text;
assert.match(t11, /Launched subagent job .* \(parallel: worker, mutator, alltools\), status running/, t11.slice(0, 250));
const ev11 = readFileSync(plog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const starts11 = ev11.filter(e => e.what === 'start');
assert.equal(starts11.length, 3, `três filhos nasceram: ${JSON.stringify(ev11)}`);
const firstToken = Math.min(...ev11.filter(e => e.what === 'token').map(e => e.t));
assert.ok(starts11.every(e => e.t < firstToken), `filhos concorrentes: ${JSON.stringify(ev11)}`);
console.log('ok assíncrono: tasks[] de papéis distintos correm concorrentes');

// Descrição e guidelines do piloto não prometem foreground nem citam o limite.
// A receita do projeto ganha uma regra aprendida: o principal não pode vê-la.
const wfFile = join(root, '.mark/workflow.md');
writeFileSync(wfFile, `${readFileSync(wfFile, 'utf8')}\n## Regras aprendidas\n- regra aprendida neste projeto fixture\n`);
const dump = join(root, 'context.json'); rmSync(dump, { force: true });
runPi({ MARK_JUICE_PILOT_MODE: 'complex', FG_TOOLS: dump });
const prompt = readFileSync(dump, 'utf8');
assert.match(prompt, /ASYNC: the call returns a jobId immediately/, 'o dump contém a descrição da tool');
assert.match(prompt, /Independent tasks go in one call as/, 'a descrição da tool explica chamadas paralelas');
assert.doesNotMatch(prompt, /Complex mode: delegate by role|Delegate independent reading and recon in parallel/, 'política de complex não é uma guideline fixa da tool');
for (const banned of [/FOREGROUND/, /foreground/, /one at a time/, /one subagent call per step/]) {
  assert.doesNotMatch(prompt, banned, `a tool não deve mencionar ${banned}`);
}
for (const banned of [/\b(10|ten|dez)\s+(child|children|subagent|subagents|process|processes|filhos)/i, /(up to|max(imum)?|limit\w*|at most)[^.]{0,24}\b10\b/i]) {
  assert.doesNotMatch(prompt, banned, `o limite interno não aparece no prompt (${banned})`);
}
console.log('ok descrição/guidelines sem foreground, sem "one at a time" e sem o limite');

// A receita é interna: nada dela (regras, caminho, menções) chega ao principal;
//     o filho a recebe como orientação do projeto, junto do brief.
for (const banned of [/regra aprendida neste projeto fixture/, /Project notes/, /workflow\.md/, /mark_workflow/, /\brecipe\b/i, /\breceita\b/i, /Regras aprendidas/]) {
  assert.doesNotMatch(prompt, banned, `o principal não vê a receita (${banned})`);
}
const childDump = join(root, 'child-context.json'); rmSync(childDump, { force: true });
const withRules = runPi({ MARK_JUICE_PILOT_MODE: 'complex', FG_CHILD_CTX: childDump, FG_KEEPALIVE: '3' });
assert.match(withRules.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result.content[0].text, /status running/);
const childCtx = readFileSync(childDump, 'utf8');
assert.match(childCtx, /## Project notes/, 'o filho recebe a orientação do projeto');
assert.match(childCtx, /- regra aprendida neste projeto fixture/, 'com as regras do cwd dele');
assert.match(childCtx, /## Objective/, 'o brief continua indo ao filho');
const childResult = JSON.stringify(withRules.filter(e => e.type === 'tool_execution_end' || (e.type === 'message_end' && e.message?.role === 'assistant')));
for (const banned of [/regra aprendida neste projeto fixture/, /Project notes/]) {
  assert.doesNotMatch(childResult, banned, `nem o resultado da tool devolve a receita (${banned})`);
}
console.log('ok receita só no filho: principal sem regras/menções, resultado da tool sem vazamento');
const sessionsRoot = join(agent, 'sessions');
const childHeaders = readdirSync(sessionsRoot, { recursive: true })
  .filter(name => name.endsWith('.jsonl'))
  .map(name => JSON.parse(readFileSync(join(sessionsRoot, name), 'utf8').split('\n')[0]));
assert.ok(childHeaders.some(h => h.type === 'session' && h.version === 3 && h.parentSession === join(root, `parent-${runIndex}.jsonl`)), 'filho JSONL ligado ao pai por parentSession oficial');
assert.ok(!existsSync(join(agent, 'durable-sessions')), 'nenhuma sessão durável criada');
// Prova concreta: bash real no filho, arquivo já sujo e escape offline do detector.
const sandboxCwd = mkdtempSync(join(repo, '.sandbox-check-'));
const savedEnv = { ...process.env };
try {
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: sandboxCwd }).status, 0);
  writeFileSync(join(sandboxCwd, 'dirty.txt'), 'antes');
  const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: { '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js') } });
  const runner = await jiti.import(join(repo, 'mark/extensions/brain-live/subagent/runner.ts'));
  runner.runnerHooks.getPiInvocation = args => ({ command: process.execPath, args: [cli, ...args] });
  runner.runnerHooks.hostFreePercent = () => 100;
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', MARK_SUBAGENT_CHILD_EXTENSIONS: provider });
  const role = { name: 'readonly', source: 'user', tools: ['read', 'bash'], systemPrompt: 'fixture' };
  const run = () => runner.runSingleAgent({ defaultCwd: sandboxCwd, agents: [role], agentName: role.name, task: 'fixture', dispatchDefaults: { model: 'fg-fake/fake', juice: { statePath: ledger } }, makeDetails: results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
  assert.equal(runner.sandboxForTools(['read', 'bash', 'write']), undefined, 'worker não recebe sandbox');
  assert.equal(runner.sandboxForTools([]), undefined, 'tools vazia preserva padrão');
  if (process.platform === 'darwin') {
    process.env.FG_SANDBOX_COMMAND = 'printf depois > dirty.txt; touch novo.txt';
    const blocked = await run();
    assert.equal(blocked.sandbox, 'seatbelt');
    assert.equal(blocked.exitCode, 0, blocked.errorMessage || blocked.stderr);
    assert.equal(readFileSync(join(sandboxCwd, 'dirty.txt'), 'utf8'), 'antes');
    assert.ok(!existsSync(join(sandboxCwd, 'novo.txt')));
    console.log('ok sandbox=seatbelt: bash do filho não altera arquivo sujo nem cria arquivo');
  }
  process.env.MARK_TEST_SANDBOX_NONE = '1';
  process.env.FG_SANDBOX_COMMAND = 'printf depois > dirty.txt';
  const detected = await run();
  assert.equal(detected.sandbox, 'none');
  assert.equal(detected.exitCode, 1);
  assert.equal(detected.stopReason, 'error');
  assert.match(detected.errorMessage, /read-only role modified the checkout: dirty.txt/);
  console.log('ok sandbox=none: detector reprova mudança de conteúdo com porcelain inalterado');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(sandboxCwd, { recursive: true, force: true });
}
// Escritores no mesmo git: checkout limpo, commits isolados e integração explícita.
function git(...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
git('init', '-b', 'main');
git('config', 'user.name', 'Fixture');
git('config', 'user.email', 'fixture@example.invalid');
writeFileSync(join(root, '.gitignore'), '*\n!file-*\n!.gitignore\n');
mkdirSync(join(root, '.pi'), { recursive: true });
mkdirSync(join(root, 'linked'), { recursive: true });
writeFileSync(join(root, 'linked', 'fixture'), 'linked');
writeFileSync(join(root, '.pi/checks.json'), JSON.stringify({ link: ['linked'], checks: [{ name: 'fixture', cmd: 'node -e "require(\\\"node:fs\\\").readFileSync(\\\"linked/fixture\\\")"' }] }));
git('add', '.gitignore'); git('add', '-f', '.pi/checks.json'); git('commit', '-m', 'base');
const writerLog = join(root, 'writers.log');
const isolatedEvents = runPi({ MARK_JUICE_PILOT_MODE: 'complex', FG_PARALLEL: 'worker', FG_WRITE: writerLog, FG_KEEPALIVE: '8' });
const isolatedJob = isolatedEvents.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result.details.job;
const rows = readFileSync(writerLog, 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.length, 3);
assert.equal(new Set(rows.map(r => r.cwd)).size, 3, 'cada escritor recebe um worktree distinto');
assert.ok(rows.every(r => r.cwd !== root));
assert.equal(git('status', '--porcelain'), '', 'checkout de origem permanece limpo');
assert.ok(!existsSync(join(root, 'file-a')), 'nenhum arquivo integrado automaticamente');
const recordsDir = join(agent, 'subagent-jobs');
const recordPath = readdirSync(recordsDir, { recursive: true }).find(p => p.endsWith(isolatedJob.jobId + '.json'));
const isolatedRecord = JSON.parse(readFileSync(join(recordsDir, recordPath), 'utf8'));
assert.equal(isolatedRecord.status, 'completed', isolatedRecord.error);
assert.match(isolatedRecord.result, /status --porcelain:/);
assert.match(isolatedRecord.result, /tarefa-a/);
// A chamada seguinte usa a própria tool, na mesma sessão do pai.
const integrated = runPi({ MARK_JUICE_PILOT_MODE: 'complex', FG_PARALLEL: 'worker', FG_WRITE: join(root, 'integrated.log'), FG_KEEPALIVE: '8', FG_INTEGRATE: '1' });
const integration = integrated.filter(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').at(-1).result;
assert.ok(!integration.isError, JSON.stringify(integration));
assert.match(integration.content[0].text, /integrate complete/);
assert.match(integration.content[0].text, /checks gate passed \(1 checks\)/);
for (const x of ['a', 'b', 'c']) assert.equal(readFileSync(join(root, 'file-' + x), 'utf8'), x);
// Integra também o primeiro job pelo manager, carregado sem dependências do Pi.
const { createJiti } = await import(join(piRoot, 'node_modules/jiti/lib/jiti.mjs'));
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js') } });
const { SubagentJobManager } = await jiti.import(join(repo, 'mark/extensions/brain-live/subagent/jobs.ts'));
const manager = new SubagentJobManager({ baseDir: recordsDir, onComplete() {} });
assert.ok(isolatedRecord.tasks.every(t => t.sourceBranch === 'main'), 'destino registrado no isolamento');
const beforeSwitch = git('rev-parse', 'HEAD');
git('switch', '-c', 'other');
await assert.rejects(manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'integrate', 1), /Source branch changed/);
assert.equal(git('rev-parse', 'HEAD'), beforeSwitch, 'nenhum merge no branch errado');
git('switch', 'main');
const task3 = isolatedRecord.tasks[2];
writeFileSync(join(task3.worktree, 'file-dirty'), 'dirty');
await assert.rejects(manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'discard', 3), /uncommitted/);
assert.ok(existsSync(task3.worktree), 'discard sem force preserva alterações');
await assert.rejects(manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'integrate', 3, true), /uncommitted/);
await manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'discard', 3, true);
assert.ok(!existsSync(task3.worktree));
writeFileSync(join(root, 'file-dirty'), 'dirty');
await assert.rejects(manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'integrate', 1), /dirty/);
rmSync(join(root, 'file-dirty'));
// Um conflito aborta o merge e preserva o branch para decisão posterior.
const task1 = isolatedRecord.tasks[0];
writeFileSync(join(task1.worktree, 'file-a'), 'conflict');
const commit = spawnSync('git', ['-C', task1.worktree, 'commit', '-am', 'conflito'], { encoding: 'utf8' });
assert.equal(commit.status, 0, commit.stderr);
await assert.rejects(manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'integrate', 1), /conflicts: file-a/);
assert.equal(git('status', '--porcelain'), '', 'merge abortado deixa origem limpa');
assert.equal(readFileSync(join(root, 'file-a'), 'utf8'), 'a');
assert.ok(existsSync(task1.worktree));
await manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'discard', 1);
await manager.manage(isolatedRecord.sessionId, isolatedRecord.jobId, 'integrate');
assert.equal(git('worktree', 'list', '--porcelain').split('worktree ').length - 1, 1, 'zero worktrees adicionais após integrar');
assert.equal(git('branch', '--list', 'mark/*'), '', 'branches removidas');
// GC não apaga recurso recente ou sujo, mesmo quando o branch já está integrado.
const { gcWorktrees, manageWorktrees } = await jiti.import(join(repo, 'mark/extensions/brain-live/subagent/worktrees.ts'));
const gcPath = join(root, 'gc-worktree');
git('worktree', 'add', '-b', 'mark/gc', gcPath, 'HEAD');
const gcRecord = { ...isolatedRecord, tasks: [{ worktree: gcPath, branch: 'mark/gc', sourceCwd: root, sourceBranch: 'main' }], finishedAt: Date.now() };
assert.equal(gcWorktrees(gcRecord, Date.now()), false, 'GC preserva jobs recentes');
gcRecord.finishedAt -= 31 * 86400000;
writeFileSync(join(gcPath, 'file-gc'), 'dirty');
assert.equal(gcWorktrees(gcRecord, Date.now()), false, 'GC preserva worktree sujo');
assert.ok(existsSync(gcPath));
rmSync(join(gcPath, 'file-gc'));
assert.equal(gcWorktrees(gcRecord, Date.now()), true, 'GC remove apenas limpo, antigo e integrado');
assert.ok(!existsSync(gcPath));
assert.equal(git('branch', '--list', 'mark/*'), '');

// Retoma remoção interrompida sem consultar status de um diretório inexistente.
function cleanupFixture(name) {
  const worktree = join(root, name);
  const branch = `mark/${name}`;
  git('worktree', 'add', '-b', branch, worktree, 'HEAD');
  return { ...isolatedRecord, tasks: [{ worktree, branch, sourceCwd: root, sourceBranch: 'main' }], finishedAt: Date.now() - 31 * 86400000 };
}
const missing = cleanupFixture('missing');
writeFileSync(join(missing.tasks[0].worktree, 'file-unmerged'), 'unmerged');
assert.equal(spawnSync('git', ['-C', missing.tasks[0].worktree, 'add', 'file-unmerged']).status, 0);
assert.equal(spawnSync('git', ['-C', missing.tasks[0].worktree, 'commit', '-m', 'unmerged']).status, 0);
rmSync(missing.tasks[0].worktree, { recursive: true, force: true });
assert.equal(gcWorktrees(missing, Date.now()), false, 'GC preserva branch não integrado mesmo sem worktree');
await assert.rejects(manageWorktrees(missing, 'integrate', undefined, false, () => {}));
assert.notEqual(git('branch', '--list', missing.tasks[0].branch), '');
await manageWorktrees(missing, 'discard', undefined, false, () => {});
await manageWorktrees(missing, 'discard', undefined, false, () => {});
assert.equal(git('branch', '--list', missing.tasks[0].branch), '', 'discard retomável e idempotente');
for (const action of ['integrate', 'gc']) {
  const resumed = cleanupFixture(`missing-${action}`);
  rmSync(resumed.tasks[0].worktree, { recursive: true, force: true });
  if (action === 'gc') assert.equal(gcWorktrees(resumed, Date.now()), true);
  else await manageWorktrees(resumed, action, undefined, false, () => {});
  assert.equal(resumed.tasks[0].worktreeRemoved, true);
}
const interrupted = cleanupFixture('interrupted');
await assert.rejects(manageWorktrees(interrupted, 'integrate', undefined, false, () => { throw new Error('persist interrupted'); }), /persist interrupted/);
assert.equal(interrupted.tasks[0].worktreePathRemoved, true, 'estado persistido após remover o diretório');
assert.equal(existsSync(interrupted.tasks[0].worktree), false);
assert.notEqual(git('branch', '--list', interrupted.tasks[0].branch), '', 'branch preservado na interrupção');
await manageWorktrees(interrupted, 'integrate', undefined, false, () => {});
assert.equal(interrupted.tasks[0].worktreeRemoved, true);

// O gate também pode trocar o branch de origem: valida novamente antes do merge.
const switched = cleanupFixture('gate-switch');
const gateTree = switched.tasks[0].worktree;
writeFileSync(join(gateTree, '.pi/checks.json'), JSON.stringify({ checks: [{ name: 'switch', cmd: `git -C ${JSON.stringify(root)} switch other` }] }));
assert.equal(spawnSync('git', ['-C', gateTree, 'commit', '-am', 'gate troca branch']).status, 0);
await assert.rejects(manageWorktrees(switched, 'integrate', undefined, false, () => {}), /Source branch changed/);
assert.equal(git('rev-parse', 'HEAD'), beforeSwitch, 'gate não integra no branch errado');
git('switch', 'main');
await manageWorktrees(switched, 'discard', undefined, false, () => {});
// Registros legados e isolamento com HEAD destacado nunca inferem um destino.
for (const sourceBranch of [undefined, null]) {
  const detached = cleanupFixture(`no-source-${String(sourceBranch)}`);
  detached.tasks[0].sourceBranch = sourceBranch;
  await assert.rejects(manageWorktrees(detached, 'integrate', undefined, false, () => {}), /No recorded source branch/);
  await manageWorktrees(detached, 'discard', undefined, false, () => {});
}

const singleLog = join(root, 'single.log');
runPi({ MARK_JUICE_PILOT_MODE: 'complex', FG_WRITE: singleLog, FG_KEEPALIVE: '4' });
assert.equal(resolve(JSON.parse(readFileSync(singleLog, 'utf8').trim()).cwd).replace(/^\/private/, ''), root.replace(/^\/private/, ''), 'single mantém cwd');
console.log('ok worktrees: isolamento paralelo, origem limpa, integração explícita e single intacto');
rmSync(root, { recursive: true, force: true });
console.log('ok subagent-dispatch: legado, piloto, slots, concorrência e isolamento da receita');
