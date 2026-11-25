#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Dispatch real do Agent com provider falso: assíncrono, modelos por papel,
// concorrência e receita restrita aos filhos. Sem rede.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';
import { buildAgentLaunch } from './lib/agent-runtime.mjs';
import { subagentEnv, userCommandEnv } from '../agent/core/child-env.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.AGENT_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
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
// Provider falso: pai chama `subagent` uma vez, depois encerra com texto; filho só responde texto.
const provider = join(root, 'provider.mjs');
writeFileSync(provider, `
import { AssistantMessageEventStream } from '${join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js').replace(/\\\\/g, '/')}';
export default function (pi) {
  pi.on('session_start', () => {
    if (process.env.FG_SESSION_MODE) pi.appendEntry('agent-mode', { version: 1, mode: process.env.FG_SESSION_MODE });
  });
  const stream = (model, context) => {
    const s = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      const n = context.messages.filter(m => m.role === 'assistant').length;
      const child = !!process.env.AGENT_CHILD;
      if (!process.env.AGENT_CHILD && process.env.FG_TOOLS) {
        const { writeFileSync } = await import('node:fs');
        try { writeFileSync(process.env.FG_TOOLS, JSON.stringify(context)); } catch {}
      }
      if (process.env.AGENT_CHILD && process.env.FG_CHILD_CTX) {
        const { writeFileSync } = await import('node:fs');
        try { writeFileSync(process.env.FG_CHILD_CTX, JSON.stringify(context)); } catch {}
      }
      const lastUser = [...context.messages].reverse().find(m => m.role === 'user');
      const userText = lastUser ? (Array.isArray(lastUser.content) ? lastUser.content.map(p => p.text || '').join(' ') : String(lastUser.content)) : '';
      let content, stopReason = 'stop';
      const launchedJob = () => {
        const launch = context.messages.find(m => m.role === 'toolResult' && m.toolName === 'subagent');
        return /Launched subagent job ([^ ]+)/.exec(launch?.content?.map(p => p.text || '').join(' ') || '')?.[1];
      };
      if (process.env.FG_CHILD_LAUNCH && n === 0) {
        // Processo filho (AGENT_CHILD=1) tentando delegar.
        content = [{ type: 'toolCall', id: 'call-child', name: 'subagent', arguments: { agent: 'worker', brief: { objective: 'o', context: 'c', scope: 's', done_when: 'd', stop_if: 'x' } } }];
        stopReason = 'toolUse';
      } else if (child && n === 0 && process.env.FG_CHECKS_ARGS) {
        content = [{ type: 'toolCall', id: 'call-checks', name: 'checks', arguments: JSON.parse(process.env.FG_CHECKS_ARGS) }];
        stopReason = 'toolUse';
      } else if (child && n === 0 && process.env.FG_SANDBOX_COMMAND) {
        content = [{ type: 'toolCall', id: 'call-sandbox', name: 'bash', arguments: { command: process.env.FG_SANDBOX_COMMAND } }];
        stopReason = 'toolUse';
      } else if (child && process.env.FG_STALL) {
        // Timeout: suja o worktree, registra se o aviso suave chegou e trava num loop que escreve.
        const { appendFileSync } = await import('node:fs');
        const text = m => Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : String(m.content);
        appendFileSync(process.env.FG_STALL, JSON.stringify({ n, t: Date.now(), cwd: process.cwd(), model: model.id,
          users: context.messages.filter(m => m.role === 'user').map(text) }) + '\\n');
        if (n === 0) content = [{ type: 'toolCall', id: 'stall-0', name: 'bash', arguments: { command: 'printf dirty > dirty.txt; sleep 1' } }];
        else if (n === 1) content = [{ type: 'toolCall', id: 'stall-1', name: 'bash', arguments: { command: 'echo $$ >> ' + process.env.FG_STALL + '.pids; while true; do date >> ticks.txt; sleep 0.05; done' } }];
        if (content) stopReason = 'toolUse';
        else content = [{ type: 'text', text: 'RETOMADO-' + n }];
      } else if (child && process.env.FG_QUOTA_MODEL === model.id) {
        // Erro do provedor (HTTP 429), não texto do modelo; registra o turno como o log do continue.
        const { appendFileSync } = await import('node:fs');
        const text = m => Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : String(m.content);
        if (process.env.FG_CHILD_LOG) appendFileSync(process.env.FG_CHILD_LOG, JSON.stringify({ model: model.id, quota: true, messages: context.messages.filter(m => m.role !== 'system').map(m => [m.role, text(m)]) }) + '\\n');
        const error = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error',
          errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization"}}',
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        s.push({ type: 'start', partial: { ...error, stopReason: 'stop', errorMessage: undefined } });
        s.push({ type: 'error', reason: 'error', error }); s.end();
        return;
      } else if (child && process.env.FG_CHILD_LOG) {
        // continue: registra o que cada turno do filho recebeu (histórico, system, cwd).
        const { appendFileSync } = await import('node:fs');
        const text = m => Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : String(m.content);
        appendFileSync(process.env.FG_CHILD_LOG, JSON.stringify({ cwd: process.cwd(), model: model.id, system: JSON.stringify(context.messages.filter(m => m.role === 'system')),
          messages: context.messages.filter(m => m.role !== 'system').map(m => [m.role, text(m)]) }) + '\\n');
        content = [{ type: 'text', text: 'FILHO-TURNO-' + n }];
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
        const delay = Number(process.env['FG_DELAY_' + tag] || process.env.FG_DELAY || 400);
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
      } else if (!child && n === 0 && process.env.FG_CHAIN) {
        content = [{ type: 'toolCall', id: 'call-chain', name: 'subagent', arguments: { chain: [
          { agent: 'scout', brief: { objective: 'first', context: 'fixture' } },
          { agent: 'scout', brief: { objective: 'second', context: '{previous}' } }
        ] } }];
        stopReason = 'toolUse';
      } else if (!child && n === 0 && process.env.FG_PARALLEL) {
        const brief = { objective: 'o', context: 'c', scope: 's', done_when: 'd', stop_if: 'x' };
        const names = process.env.FG_PARALLEL.split(',');
        content = [{ type: 'toolCall', id: 'call-p', name: 'subagent', arguments: { tasks: ['a', 'b', 'c'].map((x, i) => ({ agent: names[i % names.length], brief, task: 'tarefa-' + x })) } }];
        stopReason = 'toolUse';
      } else if (!child && n === 1 && process.env.FG_AUDIT) {
        content = [{ type: 'toolCall', id: 'audit-status', name: 'subagent', arguments: { action: 'status', jobId: launchedJob() } }];
        stopReason = 'toolUse';
      } else if (!child && n === 2 && process.env.FG_AUDIT) {
        content = [{ type: 'toolCall', id: 'audit-wait', name: 'bash', arguments: { command: 'sleep 6' } }];
        stopReason = 'toolUse';
      } else if (!child && n === 3 && process.env.FG_AUDIT) {
        content = [{ type: 'toolCall', id: 'audit-trace', name: 'subagent', arguments: { action: 'trace', jobId: launchedJob() } }];
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
      } else if (!child && n === 2 && process.env.FG_CONTINUE) {
        // Depois do resultado do launch: continue pelo handle, e duas tentativas concorrentes recusadas.
        const launch = context.messages.find(m => m.role === 'toolResult' && m.toolName === 'subagent');
        const handle = /Handles: ([^ .,]+)/.exec(launch?.content?.map(p => p.text || '').join(' ') || '')?.[1];
        content = [
          { type: 'toolCall', id: 'cont-1', name: 'subagent', arguments: { action: 'continue', handle, message: 'SEGUNDO-TURNO' } },
          { type: 'toolCall', id: 'cont-2', name: 'subagent', arguments: { action: 'continue', handle, message: 'CONCORRENTE' } },
          { type: 'toolCall', id: 'cont-3', name: 'subagent', arguments: { action: 'continue', jobId: launchedJob(), message: 'POR-JOBID' } },
        ];
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
const piEnv = (extraEnv) => ({ ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_DURABLE_HOST: '0',
  AGENT_RUNTIME_ENABLED: '1', AGENT_PI_ROOT: piRoot,
  NODE_OPTIONS: '', PI_AUTOMATIC_SKILLS: 'fixture', AGENT_SUBAGENT_CHILD_EXTENSIONS: provider, ...extraEnv });
function runPi(extraEnv, env = piEnv(extraEnv)) {
  const r = spawnSync(process.execPath, [cli, '-p', '--mode', 'json', '--session', join(root, `parent-${++runIndex}.jsonl`), '--no-extensions', '-e', provider, '-e', join(repo, 'agent/extensions/brain-live/subagent/index.ts'), '--model', 'fg-fake/fake', 'tarefa'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Installed layout, empty profile: discovery must not depend on checkout or copied personal roles.
const { createJiti: discoveryJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
const load = discoveryJiti(import.meta.url, { fsCache: false, alias: { '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js') } });
const installed = join(root, 'installed/agent');
mkdirSync(join(installed, 'extensions/brain-live/subagent'), { recursive: true });
cpSync(join(repo, 'agent/agents'), join(installed, 'agents'), { recursive: true });
cpSync(join(repo, 'agent/extensions/brain-live/subagent/agents.ts'), join(installed, 'extensions/brain-live/subagent/agents.ts'));
const { discoverAgents } = await load.import(join(installed, 'extensions/brain-live/subagent/agents.ts'));
const cleanProfile = join(home, '.agent');
mkdirSync(cleanProfile, { recursive: true });
cpSync(join(agent, 'settings.json'), join(cleanProfile, 'settings.json'));
writeFileSync(join(cleanProfile, 'auth.json'), '{}');
const previousProfile = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = cleanProfile;
try {
  const defaults = discoverAgents(root, 'user').agents;
  assert.deepEqual(defaults.map(a => a.name).sort(), ['gemini', 'planner', 'reviewer', 'scout', 'visual', 'worker']);
  assert.ok(defaults.every(a => a.source === 'bundled' && a.filePath.startsWith(installed) && a.systemPrompt && a.tools.length));
  assert.equal(discoverAgents(root, 'project').agents.length, 0);
  mkdirSync(join(cleanProfile, 'agents'));
  writeFileSync(join(cleanProfile, 'agents/scout.md'), '---\nname: scout\ndescription: personal override\ntools: read\n---\nPERSONAL-SCOUT');
  assert.equal(discoverAgents(root, 'user').agents.find(a => a.name === 'scout').source, 'user');
  const { CONFIG_DIR_NAME } = await load.import(join(piRoot, 'dist/index.js'));
  const projectRoles = join(root, CONFIG_DIR_NAME, 'agents');
  mkdirSync(projectRoles, { recursive: true });
  writeFileSync(join(projectRoles, 'scout.md'), '---\nname: scout\ndescription: untrusted project\ntools: read\n---\nPROJECT-SCOUT');
  assert.equal(discoverAgents(root, 'user').agents.find(a => a.name === 'scout').systemPrompt.trim(), 'PERSONAL-SCOUT');
  for (const scope of ['project', 'both']) {
    const role = discoverAgents(root, scope).agents.find(a => a.name === 'scout');
    assert.equal(role.source, 'project', 'project override retains provenance for consent');
    assert.equal(role.systemPrompt.trim(), 'PROJECT-SCOUT');
  }
  assert.equal(discoverAgents(root, 'project').agents.length, 1, 'project-only excludes personal and bundled');
  rmSync(projectRoles, { recursive: true });
  rmSync(join(cleanProfile, 'agents'), { recursive: true });
} finally {
  if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousProfile;
}
mkdirSync(join(cleanProfile, 'skills/fixture'), { recursive: true });
writeFileSync(join(cleanProfile, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: OFFLINE-SKILL-CATALOG\n---\nRead-only fixture skill.');
const bundledDump = join(root, 'bundled-context.json');
const bundledEvents = runPi({ PI_CODING_AGENT_DIR: cleanProfile, FG_AGENT: 'scout', FG_CHILD_CTX: bundledDump, FG_KEEPALIVE: '4' });
const bundledLaunch = bundledEvents.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result;
assert.match(bundledLaunch.content[0].text, /Launched subagent job/);
const bundledContext = JSON.parse(readFileSync(bundledDump, 'utf8'));
assert.match(JSON.stringify(bundledContext), /Read only. Bash is for inspection only/);
assert.match(JSON.stringify(bundledContext), /OFFLINE-SKILL-CATALOG/);
assert.match(JSON.stringify(bundledContext), /Inspect with `rg -n` and excerpts of up to ~150 lines/, 'role prompt asks for bounded reads');
const bundledTools = bundledContext.messages.find(m => m.role === 'system').toolsAdded;
assert.ok(bundledTools.some(t => t.name === 'read'));
assert.ok(!bundledTools.some(t => ['edit', 'write', 'subagent'].includes(t.name)), 'bundled scout scope is retained');
assert.ok(!existsSync(join(cleanProfile, 'agents')), 'dispatch never installs roles into profile');
console.log('ok bundled: relocated discovery, personal/project precedence, async scout prompt/tools/skills');

const chainDump = join(root, 'chain-context.json');
const chainEvents = runPi({ FG_CHAIN: '1', FG_CHILD_CTX: chainDump, FG_KEEPALIVE: '6' });
const chainLaunch = chainEvents.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result;
assert.match(chainLaunch.content[0].text, /Launched subagent job .*chain/);
assert.match(readFileSync(chainDump, 'utf8'), /FILHO-PRONTO/, 'chain forwards the previous result into the next brief');
console.log('ok chain: async launch and previous result passed to next role');

// Launch works without the runtime preload and without any flag.
const bg = runPi({ AGENT_RUNTIME_ENABLED: '0' });
const end3 = bg.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent');
assert.match(end3.result.content[0].text, /Launched subagent job .* status running/, 'fora do piloto continua assíncrono');
console.log('ok legado: subagent assíncrono (jobId + follow-up)');
// `-p` espera o job: o pai encerra o turno logo após lançar, recebe o resultado e reage antes de sair.
const bgJob = end3.result.details.job.jobId;
const bgMessages = bg.filter(e => e.type === 'message_end').map(e => e.message);
const bgResult = bgMessages.findIndex(m => m.role === 'custom' && m.customType === 'subagent-result' && m.details?.jobId === bgJob);
assert.ok(bgResult > 0, `-p entregou o resultado do job: ${JSON.stringify(bgMessages.map(m => m.role))}`);
assert.equal(bgMessages[bgResult].details.status, 'completed');
assert.ok(bgMessages.slice(0, bgResult).some(m => m.role === 'assistant' && m.content.some(p => p.text === 'PAI-TERMINOU')), 'o pai encerrou o turno antes do resultado');
assert.ok(bgMessages.slice(bgResult + 1).some(m => m.role === 'assistant'), 'o pai rodou outro turno com o resultado');
const bgRecordPath = readdirSync(join(agent, 'subagent-jobs'), { recursive: true }).find(p => p.endsWith(bgJob + '.json'));
const bgRecord = JSON.parse(readFileSync(join(agent, 'subagent-jobs', bgRecordPath), 'utf8'));
assert.equal(bgRecord.status, 'completed');
assert.equal(bgRecord.notified, true);
console.log('ok -p: espera o job, entrega o resultado e o pai reage antes de sair');

// continue: o 2º turno do filho roda sobre o mesmo JSONL, com o mesmo system/tools, e vê o 1º turno.
// Job de continue termina com status normal; o handle volta a waiting. Concorrência é recusada.
{
  const childLog = join(root, 'continue-turns.log'); rmSync(childLog, { force: true });
  const events = runPi({ FG_CONTINUE: '1', FG_CHILD_LOG: childLog });
  const results = events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').map(e => e.result);
  const launchText = results[0].content[0].text;
  const handle = /Handles: ([^ .,]+)\./.exec(launchText)?.[1];
  assert.equal(handle, 'worker-1', launchText);
  const [cont, concurrent, byJob] = results.slice(1);
  assert.ok(!cont.isError, JSON.stringify(cont));
  assert.match(cont.content[0].text, /^Continued handle worker-1 \(worker\) as job \S+, status running\. Same session \S+\.jsonl/);
  for (const refused of [concurrent, byJob]) {
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^Handle worker-1 is still running in job \S+\. Wait for its result, then continue\.$/);
  }
  const turns = readFileSync(childLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(turns.length, 2, 'launch + um continue');
  assert.match(turns[0].messages[0][1], /^Task: ## Objective/);
  assert.deepEqual(turns[1].messages[0], turns[0].messages[0], 'o 2º turno começa pelo histórico do 1º');
  assert.deepEqual(turns[1].messages.slice(1), [['assistant', 'FILHO-TURNO-0'], ['user', 'SEGUNDO-TURNO']], 'só a mensagem nova, sem Task:/contexto repetidos');
  assert.equal(turns[1].system, turns[0].system, 'mesmo system (preâmbulo e tools)');
  assert.equal(turns[1].cwd, turns[0].cwd, 'mesmo cwd');
  const jobsDir = join(agent, 'subagent-jobs');
  const readJob = id => JSON.parse(readFileSync(join(jobsDir, readdirSync(jobsDir, { recursive: true }).find(p => p.endsWith(id + '.json'))), 'utf8'));
  const launchJob = readJob(results[0].details.job.jobId);
  const contJob = readJob(cont.details.job.jobId);
  assert.equal(launchJob.status, 'completed');
  assert.equal(contJob.status, 'completed', contJob.error);
  assert.deepEqual(contJob.continuesFrom, { jobId: launchJob.jobId, taskIndex: 1, handle: 'worker-1' });
  assert.equal(contJob.tasks[0].sessionFile, launchJob.tasks[0].sessionFile, 'mesmo --session');
  assert.match(contJob.result, /FILHO-TURNO-1/);
  const inv = launchJob.tasks[0].invocation;
  assert.deepEqual([inv.runner, inv.model, inv.tools, inv.writes], ['pi', 'fg-fake/fake', ['read', 'edit', 'bash'], true]);
  assert.ok(inv.systemPrompt.includes('fixture') && inv.extensions.includes(provider) && inv.roleSha && inv.cwd);
  assert.deepEqual(contJob.tasks[0].invocation, inv, 'continue reusa o snapshot do launch');
  const session = readFileSync(launchJob.tasks[0].sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(session.filter(e => e.type === 'session').length, 1);
  assert.deepEqual(session.filter(e => e.message?.role === 'user').map(e => e.message.content.map(p => p.text).join('').slice(0, 13)), ['Task: ## Obje', 'SEGUNDO-TURNO']);
  const registry = JSON.parse(readFileSync(join(jobsDir, launchJob.sessionId, 'handles/registry.json'), 'utf8'));
  assert.deepEqual([registry.handles['worker-1'].lifecycle, registry.handles['worker-1'].lastJobId, registry.handles['worker-1'].continues], ['waiting', contJob.jobId, 1]);
  const messages = events.filter(e => e.type === 'message_end').map(e => e.message);
  assert.ok(messages.some(m => m.role === 'custom' && m.customType === 'subagent-result' && m.details?.jobId === contJob.jobId && m.details.status === 'completed'), '-p espera e entrega o job de continue');
  console.log('ok continue: mesmo JSONL/system/cwd, histórico preservado, job com status normal, handle waiting, concorrência recusada');
}
// Receita usada pelos slots de modelo, não pelo prompt do principal.
mkdirSync(join(root, '.agent'), { recursive: true });
writeFileSync(join(root, '.agent/workflow.md'), ['# Receita', '', 'versão: v1', '', '## Etapas (complex)',
  ...['worker', 'mutator', 'todoer', 'alltools', 'emptytools'].map((r, i) => `${i + 1}. ${r} · apoio · contrato`), ''].join('\n'));

// Runtime: assíncrono como o Pi normal — a chamada volta
//    com jobId na hora e o pai segue trabalhando; nenhuma flag de opt-in.
const pilot = runPi({  });
const end9 = pilot.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent');
const t9 = end9.result.content[0].text;
assert.match(t9, /Launched subagent job .* status running/, `complex é assíncrono: ${t9.slice(0, 200)}`);
assert.equal(end9.result.details.job.status, 'running');
assert.doesNotMatch(t9, /FILHO-PRONTO/, 'nada de resultado inline');
console.log('ok runtime: dispatch assíncrono sem flag (jobId na hora)');

// Sempre ligado, independente do modo legado salvo na sessão.
for (const savedMode of ['complex', 'simple', 'invalid']) {
  const events = runPi({ FG_SESSION_MODE: savedMode });
  const result = events.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result;
  assert.match(result.content[0].text, /Launched subagent job/, `modo legado ${savedMode}`);
}
// Processo filho nunca lança subagente: guarda explícita, nada é despachado.
const childJobs = join(agent, 'subagent-jobs');
const jobsBefore = existsSync(childJobs) ? readdirSync(childJobs, { recursive: true }).length : 0;
const childEvents = runPi({ AGENT_CHILD: '1', FG_CHILD_LAUNCH: '1' });
const childLaunch = childEvents.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result;
assert.equal(childLaunch.isError, true);
assert.match(childLaunch.content[0].text, /This process is a subagent \(AGENT_CHILD=1\); subagents cannot launch subagents\./);
assert.equal(existsSync(childJobs) ? readdirSync(childJobs, { recursive: true }).length : 0, jobsBefore, 'filho não cria job');
// `agent -p` rodado pelo bash de um filho: bash e launcher tiram AGENT_CHILD, o processo
// relançado é pai do run, mas o marcador pegajoso ainda impede delegar.
const relaunch = buildAgentLaunch({ store: join(root, 'no-agent-store'), env: userCommandEnv(subagentEnv(piEnv({ FG_CHILD_LAUNCH: '1' }))), args: [] });
assert.equal(relaunch.env.AGENT_CHILD, undefined, 'launcher remove AGENT_CHILD');
const relaunchEvents = runPi({}, relaunch.env);
const relaunched = relaunchEvents.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result;
assert.equal(relaunched.isError, true, 'descendente de subagente relançado pelo launcher não delega');
assert.match(relaunched.content[0].text, /descends from a subagent \(AGENT_NO_DELEGATE=1\).*unset AGENT_NO_DELEGATE/);
assert.equal(existsSync(childJobs) ? readdirSync(childJobs, { recursive: true }).length : 0, jobsBefore, 'descendente não cria job');
console.log('ok sempre ligado: independente de modos legados; filho e descendente relançado bloqueados com mensagem clara');

// Slot do apoio vem da receita explícita, sem inferência classificadora.
writeFileSync(join(agent, 'agent-preferences.json'), JSON.stringify({ supportModel: 'fg-fake/cheap' }));
const t10 = runPi({  }).find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result.content[0].text;
assert.match(t10, /Models: worker=fg-fake\/cheap/, `slot apoio no assíncrono: ${t10.slice(0, 250)}`);
console.log('ok assíncrono: slot explícito ainda manda o papel para o apoio');
rmSync(join(agent, 'agent-preferences.json'));


// tasks[] independentes correm em paralelo de verdade: três papéis distintos,
//     todos nascidos antes do 1º token de qualquer um deles.
const plog = join(root, 'async-parallel.log'); rmSync(plog, { force: true });
const par = runPi({ FG_PARALLEL: 'worker,mutator,alltools', FG_LOG: plog, FG_DELAY: '2500', FG_KEEPALIVE: '8' });
const t11 = par.find(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').result.content[0].text;
assert.match(t11, /Launched subagent job .* \(parallel: worker, mutator, alltools\), status running/, t11.slice(0, 250));
const ev11 = readFileSync(plog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const starts11 = ev11.filter(e => e.what === 'start');
assert.equal(starts11.length, 3, `três filhos nasceram: ${JSON.stringify(ev11)}`);
const firstToken = Math.min(...ev11.filter(e => e.what === 'token').map(e => e.t));
assert.ok(starts11.every(e => e.t < firstToken), `filhos concorrentes: ${JSON.stringify(ev11)}`);
console.log('ok assíncrono: tasks[] de papéis distintos correm concorrentes');

// Auditoria pela própria tool: status mostra o JSONL do filho enquanto ele roda;
// trace resume os passos depois; o registro guarda modelo e usage por tarefa.
const auditEvents = runPi({ FG_AUDIT: '1', FG_LOG: join(root, 'audit.log'), FG_DELAY: '1500' });
const auditEnds = auditEvents.filter(e => e.type === 'tool_execution_end' && e.toolName === 'subagent');
assert.equal(auditEnds.length, 3, 'launch, status e trace');
const auditJob = auditEnds[0].result.details.job;
const statusText = auditEnds[1].result.content[0].text;
assert.match(statusText, new RegExp(`job ${auditJob.jobId}: running`), `status durante a execução: ${statusText}`);
const runningSession = /^task 1 worker · running · fg-fake\/fake thinking \w+ · (\S+\.jsonl)$/m.exec(statusText)?.[1];
assert.ok(runningSession && existsSync(runningSession), `status mostra o JSONL do filho em execução: ${statusText}`);
const traceText = auditEnds[2].result.content[0].text;
assert.ok(Buffer.byteLength(traceText) <= 8192 + 200, 'trace respeita o teto por chamada');
assert.match(traceText, new RegExp(`^job ${auditJob.jobId} \\(completed\\)`), traceText);
assert.ok(traceText.includes(`## task 1 · worker · completed · ${runningSession}`), traceText);
assert.match(traceText, /^1\. assistant: FILHO-\?$/m, traceText);
assert.match(traceText, /^model fg-fake\/fake thinking \w+ · 1 turns · in 1 out 1 cacheRead 0 cacheWrite 0 \$0\.0000$/m, traceText);
assert.doesNotMatch(traceText, /Task: |## Objective/, 'trace não devolve o brief nem o contexto do filho');
const auditRecordPath = readdirSync(join(agent, 'subagent-jobs'), { recursive: true }).find(p => p.endsWith(auditJob.jobId + '.json'));
const auditRecord = JSON.parse(readFileSync(join(agent, 'subagent-jobs', auditRecordPath), 'utf8'));
assert.deepEqual(auditRecord.tasks.map(t => [t.agent, t.state, t.model, t.sessionFile, t.usage.turns]), [['worker', 'completed', 'fg-fake/fake', runningSession, 1]]);
assert.deepEqual(auditRecord.sessionFiles, [runningSession]);
console.log('ok auditoria via tool: status com JSONL em execução, trace linear, registro por tarefa');

// Descrição e guidelines não prometem foreground nem citam o limite.
// A receita do projeto ganha uma regra aprendida: o principal não pode vê-la.
const wfFile = join(root, '.agent/workflow.md');
writeFileSync(wfFile, `${readFileSync(wfFile, 'utf8')}\n## Regras aprendidas\n- regra aprendida neste projeto fixture\n`);
const dump = join(root, 'context.json'); rmSync(dump, { force: true });
runPi({ FG_TOOLS: dump });
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
for (const banned of [/regra aprendida neste projeto fixture/, /Project notes/, /workflow\.md/, /agent_workflow/, /\brecipe\b/i, /\breceita\b/i, /Regras aprendidas/]) {
  assert.doesNotMatch(prompt, banned, `o principal não vê a receita (${banned})`);
}
const childDump = join(root, 'child-context.json'); rmSync(childDump, { force: true });
const withRules = runPi({ FG_CHILD_CTX: childDump, FG_KEEPALIVE: '3' });
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
  const runner = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/runner.ts'));
  runner.runnerHooks.getPiInvocation = args => ({ command: process.execPath, args: [cli, ...args] });
  runner.runnerHooks.hostFreePercent = () => 100;
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', AGENT_SUBAGENT_CHILD_EXTENSIONS: provider });
  const role = { name: 'readonly', source: 'user', tools: ['read', 'bash'], systemPrompt: 'fixture' };
  const run = () => runner.runSingleAgent({ defaultCwd: sandboxCwd, agents: [role], agentName: role.name, task: 'fixture', dispatchDefaults: { model: 'fg-fake/fake', resources: { slots: {} } }, makeDetails: results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
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

  // checks in children: -e only when the role lists it; writer defaults to "fast" and records
  // the run; a read-only role (Seatbelt on macOS) gets list/last only and reads the record.
  const checksRepo = mkdtempSync(join(root, 'checks-repo-'));
  const ranLog = join(root, 'checks-ran.log');
  const checksGit = (...args) => assert.equal(spawnSync('git', ['-C', checksRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]).status, 0, args.join(' '));
  mkdirSync(join(checksRepo, '.pi'));
  writeFileSync(join(checksRepo, '.pi/checks.json'), JSON.stringify({ checks: [
    { name: 'quick', cmd: `printf 'quick\\n' >> '${ranLog}'`, tags: ['fast'] },
    { name: 'full', cmd: `printf 'full\\n' >> '${ranLog}'` },
  ] }));
  writeFileSync(join(checksRepo, 'tracked'), 'base\n');
  checksGit('init', '-q', '-b', 'main');
  checksGit('add', '.');
  checksGit('commit', '-qm', 'base');
  process.env.PI_CHECKS_CACHE_DIR = join(root, 'checks-cache');
  const checksDump = join(root, 'checks-context.json');
  process.env.FG_CHILD_CTX = checksDump;
  const checksRun = async (tools, args) => {
    process.env.FG_CHECKS_ARGS = JSON.stringify(args);
    const role = { name: 'checks-' + tools.join('-'), source: 'user', tools, systemPrompt: 'fixture' };
    const result = await runner.runSingleAgent({ defaultCwd: checksRepo, agents: [role], agentName: role.name, task: 'fixture', dispatchDefaults: { model: 'fg-fake/fake', resources: { slots: {} } }, makeDetails: results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
    assert.equal(result.exitCode, 0, result.errorMessage || result.stderr);
    const ctx = JSON.parse(readFileSync(checksDump, 'utf8'));
    const toolResult = ctx.messages.find(m => m.role === 'toolResult' && m.toolName === 'checks');
    const schema = ctx.messages.find(m => m.role === 'system').toolsAdded.find(t => t.name === 'checks');
    return { result, toolResult, text: toolResult?.content.map(p => p.text).join('') ?? '', schema };
  };
  const unloaded = await checksRun(['read', 'bash', 'edit'], {});
  assert.equal(unloaded.schema, undefined, 'no -e checks unless the role lists it');
  const jobStart = Date.now();
  const writer = await checksRun(['read', 'bash', 'edit', 'checks'], {});
  assert.ok(!writer.toolResult.isError, writer.text);
  assert.match(writer.text, /^default tags fast \(subagent\)/);
  assert.match(writer.text, /^OK: tudo verde/m);
  assert.equal(readFileSync(ranLog, 'utf8'), 'quick\n', 'writer child ran only the fast check');
  assert.deepEqual(writer.schema.parameters.properties.action.enum, ['gate', 'run', 'baseline', 'list', 'last']);
  const explicit = await checksRun(['read', 'bash', 'edit', 'checks'], { action: 'run', only: 'full' });
  assert.ok(!explicit.toolResult.isError, explicit.text);
  assert.equal(readFileSync(ranLog, 'utf8'), 'quick\nfull\n', 'explicit only is honored');
  const regate = await checksRun(['read', 'bash', 'edit', 'checks'], {});
  assert.ok(!regate.toolResult.isError, regate.text);
  writeFileSync(ranLog, '');
  const refused = await checksRun(['read', 'bash', 'checks'], { action: 'gate' });
  assert.equal(refused.toolResult.isError, true);
  assert.match(refused.text, /^checks gate is not available in a read-only subagent: it would execute project-controlled commands/);
  assert.deepEqual(refused.schema.parameters.properties.action.enum, ['list', 'last']);
  assert.equal(refused.schema.parameters.properties.tags, undefined);
  if (process.platform === 'darwin') assert.equal(refused.result.sandbox, 'seatbelt');
  const freshLast = await checksRun(['read', 'bash', 'checks'], { action: 'last' });
  assert.ok(!freshLast.toolResult.isError, freshLast.text);
  assert.match(freshLast.text, /^fresh: gate tags=fast: 1\/1 green, new failures: \[\]/);
  writeFileSync(join(checksRepo, 'tracked'), 'edited\n');
  const staleLast = await checksRun(['read', 'bash', 'checks'], { action: 'last' });
  assert.match(staleLast.text, /^stale: status, diff changed since the recorded run/);
  assert.equal(readFileSync(ranLog, 'utf8'), '', 'read-only child executed no check');
  const { gateSummary } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/worktrees.ts'));
  const writerRole = { name: 'w', tools: ['read', 'edit', 'checks'] };
  const jobRecord = (createdAt) => ({ tasks: [{ agent: 'w', task: 't', cwd: checksRepo }], cwd: checksRepo, createdAt });
  assert.match(gateSummary(jobRecord(jobStart), [writerRole]), /^gate tags=fast: 1\/1 green, new failures: \[\] \(stale: status, diff changed since; /);
  assert.equal(gateSummary(jobRecord(Date.now() + 1000), [writerRole]), 'gate: not run in this job');
  assert.equal(gateSummary(jobRecord(jobStart), [{ ...writerRole, tools: ['read', 'checks'] }]), '', 'read-only roles get no gate line');
  delete process.env.FG_CHECKS_ARGS;
  delete process.env.FG_CHILD_CTX;
  console.log(`ok checks in children: -e by role, writer defaults to fast, read-only (${refused.result.sandbox}) refuses gate and reads last fresh/stale, job gate line`);

  process.env.AGENT_TEST_SANDBOX_NONE = '1';
  process.env.FG_SANDBOX_COMMAND = 'printf depois > dirty.txt';
  const detected = await run();
  assert.equal(detected.sandbox, 'none');
  assert.equal(detected.exitCode, 1);
  assert.equal(detected.stopReason, 'error');
  assert.match(detected.errorMessage, /read-only role modified the checkout: dirty.txt/);
  console.log('ok sandbox=none: detector reprova mudança de conteúdo com porcelain inalterado');

  // Child tool-output cap: real bash in the child, ~10.5k chars (under Pi's own 2000-line cut).
  const cap = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/child-output-cap.ts'));
  assert.equal(cap.shouldCap('read', { path: 'x', limit: 150 }), false, 'small read limit is left alone');
  assert.equal(cap.shouldCap('read', { path: 'x' }), true);
  const capDump = join(root, 'cap-context.json');
  const bashResult = () => JSON.parse(readFileSync(capDump, 'utf8')).messages.find(m => m.role === 'toolResult' && m.toolName === 'bash').content.map(p => p.text).join('');
  const seqOut = spawnSync('seq', ['100000', '101500'], { encoding: 'utf8' }).stdout;
  process.env.FG_SANDBOX_COMMAND = 'seq 100000 101500';
  process.env.FG_CHILD_CTX = capDump;
  const capped = await run();
  assert.equal(capped.exitCode, 0, capped.errorMessage || capped.stderr);
  const cappedText = bashResult();
  assert.ok(cappedText.length < 8600, `capped bash output: ${cappedText.length} chars`);
  assert.ok(cappedText.startsWith('100000\n100001\n') && cappedText.trimEnd().endsWith('101499\n101500'), 'head and tail kept');
  assert.match(cappedText, /\[\.\.\. \d+ of \d+ chars omitted \(lines \d+-\d+ of \d+\)\. Full output: \S+ — read it with read offset\/limit or rg -n/);
  const fullPath = /Full output: (\S+)/.exec(cappedText)[1];
  assert.equal(readFileSync(fullPath, 'utf8').trimEnd(), seqOut.trimEnd(), 'full output saved for the child');
  rmSync(dirname(fullPath), { recursive: true, force: true });
  process.env.AGENT_CHILD_TOOL_OUTPUT_MAX = '0';
  await run();
  delete process.env.AGENT_CHILD_TOOL_OUTPUT_MAX;
  delete process.env.FG_CHILD_CTX;
  assert.equal(bashResult().trimEnd(), seqOut.trimEnd(), 'AGENT_CHILD_TOOL_OUTPUT_MAX=0 disables the cap');
  console.log('ok child output cap: bash head+tail with full-output path; read with small limit untouched; 0 disables');

  // Stable child prefix: two children of one role in different worktrees, real Anthropic
  // payloads. AGENTS.md leaves the system (--no-context-files) and reaches the child once, in
  // the task message; the system breakpoint sits before <cwd>, the only part that differs.
  const anth = await startFakeAnthropic([{ text: 'ok' }]);
  const repoFixture = join(root, 'prefix-repo');
  mkdirSync(repoFixture);
  const gitIn = (...a) => assert.equal(spawnSync('git', a, { cwd: repoFixture }).status, 0, a.join(' '));
  gitIn('init', '-q');
  writeFileSync(join(repoFixture, 'AGENTS.md'), '# Regras\n- PROJECT-RULES-FIXTURE\n');
  gitIn('add', 'AGENTS.md');
  gitIn('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init');
  const trees = ['prefix-wt-a', 'prefix-wt-b'].map(name => join(root, name));
  for (const tree of trees) gitIn('worktree', 'add', '-q', tree);
  writeFileSync(join(agent, 'AGENTS.md'), 'GLOBAL-RULES-FIXTURE\n');
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fa: { baseUrl: anth.baseUrl, api: 'anthropic-messages', apiKey: 'offline',
    models: [{ id: 'claude-x', name: 'claude-x', reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 200000, maxTokens: 8000 }] } } }));
  delete process.env.FG_SANDBOX_COMMAND;
  try {
    const prefixRole = { name: 'prefixrole', source: 'user', tools: ['read'], systemPrompt: 'PREFIX-ROLE-PROMPT' };
    for (const tree of trees) {
      const r = await runner.runSingleAgent({ defaultCwd: tree, agents: [prefixRole], agentName: prefixRole.name, task: 'fixture', dispatchDefaults: { model: 'fa/claude-x', resources: { slots: {} } }, makeDetails: results => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }) });
      assert.equal(r.exitCode, 0, r.errorMessage || r.stderr);
    }
    const [a, b] = anth.messages();
    assert.equal(anth.messages().length, 2);
    assert.equal(JSON.stringify(a.tools), JSON.stringify(b.tools), 'tools identical');
    for (const [p, tree] of [[a, trees[0]], [b, trees[1]]]) {
      assert.equal(p.system.length, 2, 'system split before <cwd>');
      assert.ok(p.system[0].cache_control && !p.system[1].cache_control, 'system breakpoint sits before <cwd>');
      assert.equal(p.system[1].text, `\n\n<cwd>\n${tree}\n</cwd>`, 'second block is only the cwd section');
      assert.match(p.system[0].text, /^PREFIX-ROLE-PROMPT/);
      assert.doesNotMatch(JSON.stringify(p.system), /project_context|RULES-FIXTURE/, 'no context files in the system');
      const sent = JSON.stringify(p);
      for (const marker of ['PROJECT-RULES-FIXTURE', 'GLOBAL-RULES-FIXTURE']) assert.equal(sent.split(marker).length - 1, 1, `${marker} reaches the child exactly once`);
      assert.ok(sent.includes(`<project_instructions path=\\"${join(tree, 'AGENTS.md')}\\">`), 'with its own path');
    }
    assert.equal(JSON.stringify(a.system[0]), JSON.stringify(b.system[0]), 'system byte-identical up to <cwd> across worktrees');
    console.log(`ok stable child prefix: system ${Buffer.byteLength(a.system[0].text)} B shared across worktrees, breakpoint before <cwd>, AGENTS.md once in the task`);
  } finally {
    rmSync(join(agent, 'AGENTS.md'), { force: true });
    rmSync(join(agent, 'models.json'), { force: true });
    await anth.close();
  }

  // Jobs below use a 30 min ceiling: with timeouts under ~200 s the soft deadline is the start
  // itself and every child would get the soft-timeout steer, which the timeout block covers.
  // Exercise the actual spawn queue: two live children, remaining tasks queued,
  // cancellation owned by the launching session, and no spawn under pressure.
  delete process.env.FG_SANDBOX_COMMAND;
  process.env.FG_LOG = join(root, 'bounded.log');
  process.env.FG_DELAY = '10000';
  const { SubagentJobManager: BudgetManager, MAX_PARALLEL_TASKS, cacheTtlSeconds } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/jobs.ts'));
  assert.equal(cacheTtlSeconds({ PI_CACHE_RETENTION: 'long' }), 300, 'prefetch/warm window uses the child TTL, not the session one');
  assert.equal(cacheTtlSeconds({ PI_CACHE_RETENTION: 'long', AGENT_CHILD_CACHE_RETENTION: 'long' }), 3600);
  let terminal;
  const budget = new BudgetManager({ baseDir: join(root, 'budget-jobs'), childLimit: 2, onComplete: record => { terminal = record; } });
  const spec = { sessionId: 'owner', sessionGeneration: 0, mode: 'parallel',
    tasks: Array.from({ length: 4 }, (_, i) => ({ agent: 'readonly-' + i, task: 'tarefa-' + i })),
    agents: Array.from({ length: 4 }, (_, i) => ({ ...role, name: 'readonly-' + i, tools: ['read'] })), agentScope: 'user', projectAgentsDir: null,
    dispatchDefaults: { model: 'fg-fake/fake', resources: { slots: {} } }, cwd: sandboxCwd, timeoutSeconds: 1800 };
  assert.equal(budget.launch({ ...spec, tasks: Array.from({ length: MAX_PARALLEL_TASKS + 1 }, () => spec.tasks[0]) }).ok, false);
  const launched = budget.launch(spec);
  assert.ok(launched.ok, launched.error);
  const waitUntil = async (condition) => {
    const deadline = Date.now() + 15000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'bounded dispatch settled before deadline');
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    await waitUntil(() => existsSync(process.env.FG_LOG) && readFileSync(process.env.FG_LOG, 'utf8').trim().split('\n').length === 2);
    assert.equal(budget.activeChildren(), 2);
    assert.equal(budget.cancel('other-session', launched.record.jobId).ok, false);
    assert.equal(budget.activeCount(), 1, 'foreign cancellation leaves owner running');
    assert.equal(budget.cancel('owner', launched.record.jobId).ok, true);
    await waitUntil(() => terminal !== undefined);
    assert.equal(terminal.status, 'cancelled');
    assert.equal(budget.activeChildren(), 0);
    assert.equal(readFileSync(process.env.FG_LOG, 'utf8').trim().split('\n').length, 2, 'queued children never spawned');
  } finally {
    await budget.shutdown();
  }
  delete process.env.FG_LOG;
  delete process.env.FG_DELAY;
  runner.runnerHooks.hostFreePercent = () => 0;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    const blocked = await runner.runSingleAgent({ defaultCwd: sandboxCwd, agents: [role], agentName: role.name,
      task: 'fixture', signal: abort.signal, dispatchDefaults: { model: 'fg-fake/fake', resources: { slots: {} } }, makeDetails: results => ({ results }) });
    assert.notEqual(blocked.exitCode, 0);
    assert.equal(blocked.usage.turns, 0, 'memory wait cancels without inference');
  } finally {
    clearTimeout(timer);
    runner.runnerHooks.hostFreePercent = () => 100;
  }
  console.log('ok bounded dispatch: ceiling, queued cancellation, session ownership, memory pressure');

  // Paralelo com uma tarefa que lança exceção: os irmãos terminam (o job fica vivo e
  // cancelável até lá) e cada tarefa grava estado/usage no momento em que retorna ou lança.
  {
    const { taskStatusLines } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/trace.ts'));
    const invocation = runner.runnerHooks.getPiInvocation;
    runner.runnerHooks.getPiInvocation = args => {
      if (String(args.at(-1)).includes('tarefa-b')) throw new Error('spawn exploded');
      return invocation(args);
    };
    Object.assign(process.env, { FG_LOG: join(root, 'settle.log'), FG_DELAY_a: '300', FG_DELAY_c: '2000' });
    try {
      // shared=false: mapWithConcurrencyLimit; shared=true: leque escalonado do mesmo papel.
      for (const shared of [false, true]) {
        let settled, childrenAtEnd;
        const mgr = new BudgetManager({ baseDir: join(root, 'settle-jobs'), onComplete: record => { settled = record; childrenAtEnd = mgr.activeChildren(); } });
        const names = shared ? ['readonly-0', 'readonly-0', 'readonly-0'] : ['readonly-0', 'readonly-1', 'readonly-2'];
        const out = mgr.launch({ ...spec, tasks: ['a', 'b', 'c'].map((x, i) => ({ agent: names[i], task: 'tarefa-' + x })) });
        assert.ok(out.ok, out.error);
        const jobId = out.record.jobId;
        const disk = () => JSON.parse(readFileSync(join(root, 'settle-jobs/owner', jobId + '.json'), 'utf8'));
        await waitUntil(() => disk().tasks[0].state === 'completed');
        const mid = disk();
        assert.equal(mid.status, 'running', `exceção de um irmão não encerra o job (shared=${shared})`);
        assert.equal(mgr.activeCount(), 1);
        assert.deepEqual(mid.tasks.map(t => t.state), ['completed', 'failed', 'running'], `estado por tarefa no disco (shared=${shared})`);
        assert.equal(mid.tasks[0].usage.turns, 1, 'usage final gravado quando a tarefa retorna');
        assert.match(mid.tasks[1].error, /^did not finish: spawn exploded/, 'erro gravado quando a tarefa lança');
        assert.deepEqual(taskStatusLines(mgr.get('owner', jobId)).map(l => l.split(' · ')[1]), ['completed', 'failed', 'running']);
        if (shared) assert.match(mgr.cancel('owner', jobId).message, /cancelling/, 'job com filho vivo continua cancelável');
        await waitUntil(() => settled !== undefined);
        assert.equal(childrenAtEnd, 0, 'job só termina depois que todos os filhos saíram');
        assert.equal(mgr.activeChildren(), 0);
        if (shared) {
          assert.equal(settled.status, 'cancelled');
          assert.deepEqual(settled.tasks.map(t => t.state), ['completed', 'failed', 'failed']);
          assert.ok(settled.tasks[2].usage && settled.tasks[2].sessionFile);
        } else {
          assert.equal(settled.status, 'failed');
          assert.match(settled.error, /1\/3 parallel task\(s\) failed: readonly-1\. task 2 \(readonly-1\) threw: spawn exploded/);
          assert.deepEqual(settled.tasks.map(t => t.state), ['completed', 'failed', 'completed']);
          assert.equal(settled.tasks[2].usage.turns, 1);
          assert.match(settled.result, /^Parallel: 2\/3 succeeded/);
          assert.match(settled.result, /FILHO-a/);
          assert.match(settled.result, /\[readonly-1\] failed \(exception\)\n\nspawn exploded/);
          assert.match(settled.result, /FILHO-c/, 'resultado inclui o irmão que terminou depois da exceção');
          assert.equal(settled.usage.turns, 2);
        }
        await mgr.shutdown();
      }
    } finally {
      runner.runnerHooks.getPiInvocation = invocation;
      for (const k of ['FG_LOG', 'FG_DELAY_a', 'FG_DELAY_c']) delete process.env[k];
    }
    console.log('ok paralelo com exceção: irmãos terminam, job cancelável até o fim, estado/usage por tarefa gravados ao terminar');
  }

  // continue pelo manager: worktree do launch, snapshot contra papel alterado, lock no JSONL,
  // discard fecha o handle, worktree removido, agy e handle desconhecido recusados.
  {
    for (const key of ['FG_CHECKS_ARGS', 'FG_CHILD_CTX', 'FG_LOG', 'FG_DELAY']) delete process.env[key];
    const { updateRegistry, sessionLockPath } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/handles.ts'));
    const contRepo = realpathSync(mkdtempSync(join(root, 'continue-repo-')));
    const contGit = (...args) => assert.equal(spawnSync('git', ['-C', contRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]).status, 0, args.join(' '));
    contGit('init', '-q', '-b', 'main');
    writeFileSync(join(contRepo, 'base'), 'base\n');
    contGit('add', '.');
    contGit('commit', '-qm', 'base');
    const roleFile = join(root, 'cwriter.md');
    writeFileSync(roleFile, '---\nname: cwriter\n---\nfixture-writer');
    const writer = { name: 'cwriter', description: 'fixture', source: 'user', tools: ['read', 'edit', 'bash'], systemPrompt: 'fixture-writer', filePath: roleFile };
    const childLog = join(root, 'continue-manager.log');
    process.env.FG_CHILD_LOG = childLog;
    const done = [];
    const contJobs = join(root, 'continue-jobs');
    const mgr = new BudgetManager({ baseDir: contJobs, onComplete: record => done.push(record) });
    const base = { sessionId: 'cont', sessionGeneration: 0, agents: [writer], agentScope: 'user', projectAgentsDir: null,
      dispatchDefaults: { model: 'fg-fake/fake', resources: { slots: {} } }, timeoutSeconds: 1800 };
    const launched = mgr.launch({ ...base, mode: 'parallel', cwd: contRepo,
      tasks: [{ agent: 'cwriter', task: 'tarefa-a', name: 'alpha' }, { agent: 'cwriter', task: 'tarefa-b' }] });
    assert.ok(launched.ok, launched.error);
    assert.deepEqual(launched.record.tasks.map(t => t.handle), ['alpha', 'cwriter-1']);
    const dup = mgr.launch({ ...base, mode: 'single', cwd: contRepo, tasks: [{ agent: 'cwriter', task: 'x', name: 'alpha' }] });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /Handle name\(s\) already used in this session: alpha/);
    await waitUntil(() => done.length === 1);
    assert.equal(done[0].status, 'completed', JSON.stringify(done[0].tasks.map(t => t.error)) + done[0].result);
    const [alpha, second] = done[0].tasks;
    assert.ok(alpha.worktree && second.worktree && alpha.invocation.cwd === alpha.cwd && alpha.invocation.sourceCwd);
    assert.deepEqual(mgr.handles('cont').map(h => [h.handle, h.lifecycle, h.worktree]), [['alpha', 'waiting', alpha.worktree], ['cwriter-1', 'waiting', second.worktree]]);

    writeFileSync(roleFile, '---\nname: cwriter\n---\nchanged-prompt');
    const cont = (handle, jobId, message = 'SEGUNDO tarefa-a') => mgr.continueTask({ ...base, jobId, handle, message });
    const first = cont('alpha', 'cont-1');
    assert.ok(first.ok, first.error);
    assert.match(first.warnings.join(' '), /Role file of cwriter changed since launch; continuing with the launch snapshot/);
    assert.ok(existsSync(sessionLockPath(alpha.sessionFile)), 'lock next to the JSONL while the continue runs');
    assert.match(cont('alpha', 'cont-x').error, /^Handle alpha is still running in job cont-1\./);
    await assert.rejects(mgr.manage('cont', launched.record.jobId, 'discard', 1, true), /still running a continue job/);
    await waitUntil(() => done.length === 2);
    const contRecord = done[1];
    assert.equal(contRecord.status, 'completed', contRecord.error);
    assert.deepEqual(contRecord.continuesFrom, { jobId: launched.record.jobId, taskIndex: 1, handle: 'alpha' });
    assert.equal(contRecord.tasks[0].sessionFile, alpha.sessionFile);
    assert.match(contRecord.result, /### isolated task 1\nworktree: /, 'continue result shows the launch worktree');
    assert.ok(!existsSync(sessionLockPath(alpha.sessionFile)), 'lock released at the end');
    const turns = readFileSync(childLog, 'utf8').trim().split('\n').map(JSON.parse);
    const last = turns.at(-1);
    assert.equal(realpathSync(last.cwd), realpathSync(alpha.worktree), 'continue runs in the same worktree');
    assert.deepEqual(last.messages.slice(-2), [['assistant', 'FILHO-TURNO-0'], ['user', 'SEGUNDO tarefa-a']]);
    assert.match(last.system, /fixture-writer/, 'system prompt from the snapshot, not the changed role file');
    assert.doesNotMatch(last.system, /changed-prompt/);
    assert.equal(mgr.handles('cont')[0].lifecycle, 'waiting');

    // Lock: a live owner refuses; a dead owner is taken over.
    writeFileSync(sessionLockPath(alpha.sessionFile), JSON.stringify({ pid: process.pid, jobId: 'other', at: Date.now() }));
    assert.match(cont('alpha', 'cont-2').error, /^Another continue is already writing to \S+ \(job other, pid \d+\)\. Wait for it to finish\.$/);
    writeFileSync(sessionLockPath(alpha.sessionFile), JSON.stringify({ pid: 2 ** 22 + 12345, jobId: 'dead', at: Date.now() }));
    const takeover = cont('alpha', 'cont-3', 'TERCEIRO tarefa-a');
    assert.ok(takeover.ok, takeover.error);
    await waitUntil(() => done.length === 3);
    assert.equal(done[2].status, 'completed', done[2].error);

    // discard through the continue job acts on the launch task and closes the handle.
    const discarded = await mgr.manage('cont', 'cont-3', 'discard', undefined, true);
    assert.match(discarded, /Task 1: discard complete/);
    assert.ok(!existsSync(alpha.worktree));
    assert.match(cont('alpha', 'cont-4').error, /^Handle alpha is closed \(discarded\)\. Launch a new task instead\.$/);
    // Worktree removed outside the tool: refused and closed.
    rmSync(second.worktree, { recursive: true, force: true });
    assert.match(cont('cwriter-1', 'cont-5').error, /^Handle cwriter-1: worktree \S+ was removed\. Launch a new task instead\.$/);
    assert.equal(mgr.handles('cont')[1].lifecycle, 'closed');
    // agy keeps no Pi session; unknown handles are named.
    updateRegistry(contJobs, 'cont', registry => {
      registry.handles['gemini-1'] = { handle: 'gemini-1', agent: 'gemini', jobId: 'g', taskIndex: 1, lastJobId: 'g', lifecycle: 'closed', continues: 0, createdAt: 1, updatedAt: 1,
        invocation: { version: 1, runner: 'agy', agent: 'gemini', agentSource: 'user', extensions: [], systemPrompt: '', cwd: contRepo, writes: false } };
    });
    assert.match(cont('gemini-1', 'cont-6').error, /^Handle gemini-1 ran on the agy runner \(gemini\), which keeps no Pi session to resume\. Use action "launch" with a fresh brief\.$/);
    assert.match(cont('nope', 'cont-7').error, /^Unknown handle nope in this session\./);
    assert.equal(done.length, 3, 'refusals never start a job');
    await mgr.shutdown();
    delete process.env.FG_CHILD_LOG;
    console.log('ok continue (manager): worktree reused, snapshot over changed role, lock live/stale, discard closes, removed worktree, agy and unknown refused');
  }

  // Cota: 429 do provedor vira failure "quota"; papel só leitura troca sozinho uma vez no mesmo
  // JSONL; escritor nunca troca sozinho, e só aceita `model` (da allowlist) depois da cota.
  {
    const { QUOTA_FALLBACK_MESSAGE } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/jobs.ts'));
    const quotaLog = join(root, 'quota-turns.log');
    Object.assign(process.env, { FG_QUOTA_MODEL: 'fake', FG_CHILD_LOG: quotaLog });
    const done = [];
    const mgr = new BudgetManager({ baseDir: join(root, 'quota-jobs'), onComplete: record => done.push(record) });
    const qreader = { name: 'qreader', description: 'fixture', source: 'user', tools: ['read'], systemPrompt: 'fixture-reader' };
    const qwriter = { name: 'qwriter', description: 'fixture', source: 'user', tools: ['read', 'edit', 'bash'], systemPrompt: 'fixture-writer' };
    const writerCwd = realpathSync(mkdtempSync(join(root, 'quota-writer-')));
    // Piloto: principal fg-fake/fake, apoio fg-fake/cheap; papel sem lista própria usa esse par.
    const base = { sessionId: 'quota', sessionGeneration: 0, agents: [qreader, qwriter], agentScope: 'user', projectAgentsDir: null,
      dispatchDefaults: { model: 'fg-fake/fake', resources: { supportModel: 'fg-fake/cheap', slots: {} } }, timeoutSeconds: 1800 };
    assert.ok(mgr.launch({ ...base, mode: 'single', cwd: sandboxCwd, tasks: [{ agent: 'qreader', task: 'ler', name: 'reader' }] }).ok);
    assert.ok(mgr.launch({ ...base, mode: 'single', cwd: writerCwd, tasks: [{ agent: 'qwriter', task: 'escrever', name: 'writer' }] }).ok);
    await waitUntil(() => done.length === 2);
    const reader = done.find(r => r.agents[0] === 'qreader');
    const writer = done.find(r => r.agents[0] === 'qwriter');
    const turns = () => readFileSync(quotaLog, 'utf8').trim().split('\n').map(JSON.parse);

    // Só leitura: 429 no principal, uma nova rodada no apoio sobre a mesma sessão, registrada.
    assert.equal(reader.status, 'completed', reader.error + reader.result);
    const rt = reader.tasks[0];
    assert.equal(rt.failure, undefined);
    assert.deepEqual([rt.modelSwitch.from, rt.modelSwitch.to, rt.modelSwitch.reason, rt.modelSwitch.auto], ['fg-fake/fake', 'fg-fake/cheap', 'quota', true]);
    assert.equal(rt.model, 'fg-fake/cheap');
    assert.match(reader.result, /task 1 \(qreader, handle reader\): quota\/rate limit on fg-fake\/fake; retried once on fg-fake\/cheap over the same session \(read-only fallback\)\./);
    const readerJsonl = readFileSync(rt.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(readerJsonl.filter(e => e.type === 'session').length, 1, 'one JSONL, one header');
    const readerMsgs = readerJsonl.filter(e => e.type === 'message').map(e => e.message);
    assert.ok(readerMsgs.some(m => m.role === 'assistant' && m.model === 'fake' && m.stopReason === 'error' && /rate_limit_error/.test(m.errorMessage)), 'the 429 turn is in the same JSONL');
    assert.ok(readerMsgs.some(m => m.role === 'assistant' && m.model === 'cheap' && m.stopReason === 'stop'), 'the fallback turn is in the same JSONL');
    const fallbackTurn = turns().find(t => t.model === 'cheap' && t.messages.some(([, text]) => text === QUOTA_FALLBACK_MESSAGE));
    assert.ok(fallbackTurn, 'fallback turn carries the follow-up message');
    assert.match(fallbackTurn.messages[0][1], /^Task: ler/, 'fallback turn sees the original task (same session)');
    const readerHandle = mgr.handles('quota').find(h => h.handle === 'reader');
    assert.deepEqual([readerHandle.lifecycle, readerHandle.failure, readerHandle.invocation.model], ['waiting', undefined, 'fg-fake/cheap']);

    // Escritor: falha por cota, sem troca automática; handle waiting com failure quota.
    assert.equal(writer.status, 'failed');
    const wt = writer.tasks[0];
    assert.deepEqual([wt.failure, wt.modelSwitch, wt.model], ['quota', undefined, 'fg-fake/fake']);
    assert.match(writer.result + writer.error, /failed on provider quota\/rate limit\/capacity \(model fg-fake\/fake\)\. The handle waits: continue it with "model" set to another model allowed for this role\./);
    assert.equal(turns().filter(t => t.quota && t.messages[0][1].startsWith('Task: escrever')).length, 1, 'writer never retried alone');
    const writerHandle = () => mgr.handles('quota').find(h => h.handle === 'writer');
    assert.deepEqual([writerHandle().lifecycle, writerHandle().failure], ['waiting', 'quota']);

    // Recusas: modelo fora da allowlist; `model` em handle cuja última rodada não falhou por cota.
    const cont = (handle, jobId, model, message = 'SEGUE') => mgr.continueTask({ ...base, jobId, handle, message, model });
    assert.match(cont('writer', 'q-1', 'fg-fake/other').error, /^Handle writer: model fg-fake\/other refused\. /);
    assert.match(cont('reader', 'q-2', 'fg-fake/fake').error, /^Handle reader: "model" is accepted only after a quota\/rate-limit failure, and its last run did not fail on quota\./);
    assert.equal(done.length, 2, 'refusals never start a job');

    // continue com outro modelo permitido: mesmo JSONL, histórico preservado, troca registrada.
    const switched = cont('writer', 'q-3', 'fg-fake/cheap');
    assert.ok(switched.ok, switched.error);
    assert.equal(switched.entry.invocation.model, 'fg-fake/cheap');
    await waitUntil(() => done.length === 3);
    const resumed = done[2];
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(resumed.tasks[0].sessionFile, wt.sessionFile, 'same child JSONL');
    assert.deepEqual([resumed.tasks[0].modelSwitch.from, resumed.tasks[0].modelSwitch.to, resumed.tasks[0].modelSwitch.auto], ['fg-fake/fake', 'fg-fake/cheap', false]);
    assert.match(resumed.result, /continued on fg-fake\/cheap after a quota failure on fg-fake\/fake/);
    const last = turns().at(-1);
    assert.equal(last.model, 'cheap');
    assert.match(last.messages[0][1], /^Task: escrever/, 'history of the first turn');
    assert.deepEqual(last.messages.at(-1), ['user', 'SEGUE']);
    const writerJsonl = readFileSync(wt.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(writerJsonl.filter(e => e.type === 'session').length, 1);
    assert.deepEqual([writerHandle().lifecycle, writerHandle().failure, writerHandle().invocation.model], ['waiting', undefined, 'fg-fake/cheap']);
    // Depois de um turno sem cota, `model` volta a ser recusado.
    assert.match(cont('writer', 'q-4', 'fg-fake/fake').error, /accepted only after a quota\/rate-limit failure/);
    await mgr.shutdown();
    for (const key of ['FG_QUOTA_MODEL', 'FG_CHILD_LOG']) delete process.env[key];
    console.log('ok quota: 429 -> failure quota, read-only falls back once on the same JSONL, writer waits; continue model only after quota and inside the allowlist');
  }

  // Timeout duro: aviso suave antes do teto (extensão no filho, sem stdin), árvore do filho morta
  // ANTES do commit WIP no worktree do job; escritor no lugar não ganha commit; continue retoma.
  {
    const { SOFT_TIMEOUT_MESSAGE } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/child-soft-deadline.ts'));
    const stallLog = join(root, 'stall.log');
    process.env.FG_STALL = stallLog;
    const repoFor = (name) => {
      const dir = realpathSync(mkdtempSync(join(root, name)));
      const g = (...args) => assert.equal(spawnSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]).status, 0, args.join(' '));
      g('init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'base'), 'base\n');
      g('add', '.');
      g('commit', '-qm', 'base');
      return dir;
    };
    const gitOut = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();
    const isolatedRepo = repoFor('stall-repo-');
    const inPlaceRepo = repoFor('stall-inplace-');
    const inPlaceHead = gitOut(inPlaceRepo, 'rev-parse', 'HEAD');
    const done = [];
    const mgr = new BudgetManager({ baseDir: join(root, 'stall-jobs'), onComplete: record => done.push(record) });
    const swriter = { name: 'swriter', description: 'fixture', source: 'user', tools: ['read', 'edit', 'bash'], systemPrompt: 'fixture-writer' };
    const TIMEOUT = 10;
    // Two roles: one shared prefix would stagger the second child behind the stalled leader's first token.
    const base = { sessionId: 'stall', sessionGeneration: 0, agents: [swriter, { ...swriter, name: 'swriter2' }], agentScope: 'user', projectAgentsDir: null,
      dispatchDefaults: { model: 'fg-fake/fake', resources: { slots: {} } }, timeoutSeconds: TIMEOUT };
    const started = Date.now();
    const isolated = mgr.launch({ ...base, mode: 'parallel', cwd: isolatedRepo,
      tasks: [{ agent: 'swriter', task: 'tarefa-a', name: 'stall-a' }, { agent: 'swriter2', task: 'tarefa-b', name: 'stall-b' }] });
    assert.ok(isolated.ok, isolated.error);
    assert.ok(mgr.launch({ ...base, mode: 'single', cwd: inPlaceRepo, tasks: [{ agent: 'swriter', task: 'tarefa-c', name: 'stall-c' }] }).ok);
    const deadline = Date.now() + 60000;
    while (done.length < 2) {
      assert.ok(Date.now() < deadline, 'timeout jobs settled');
      await new Promise(r => setTimeout(r, 50));
    }
    const job = done.find(r => r.jobId === isolated.record.jobId);
    const inPlace = done.find(r => r.jobId !== isolated.record.jobId);
    assert.equal(job.status, 'timeout', 'JobStatus unchanged: a hard timeout stays timeout');
    assert.equal(inPlace.status, 'timeout');

    // Aviso suave: chegou ao filho como mensagem de usuário, antes do teto duro.
    const stalls = readFileSync(stallLog, 'utf8').trim().split('\n').map(JSON.parse);
    const warned = stalls.filter(t => t.users.includes(SOFT_TIMEOUT_MESSAGE));
    assert.ok(warned.length >= 3, `soft warning reached every child: ${JSON.stringify(stalls.map(t => [t.n, t.users.length]))}`);
    for (const t of warned) assert.ok(t.t < started + TIMEOUT * 1000, 'soft warning before the hard deadline');
    assert.ok(stalls.every(t => t.users.filter(u => u === SOFT_TIMEOUT_MESSAGE).length <= 1), 'soft warning once per child');

    // Árvore morta antes do commit: o loop que escrevia ticks.txt não vive mais, o WIP contém
    // tudo o que ele escreveu, e o worktree continua limpo depois.
    const pids = readFileSync(stallLog + '.pids', 'utf8').trim().split('\n').map(Number);
    assert.equal(pids.length, 3, 'three stalled loops');
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `loop ${pid} is gone`);
    for (const [i, task] of job.tasks.entries()) {
      assert.match(task.wipCommit ?? '', /^[0-9a-f]{40}$/, `task ${i + 1} WIP sha recorded: ${task.wipError ?? ''}`);
      assert.equal(gitOut(task.worktree, 'rev-parse', 'HEAD'), task.wipCommit);
      assert.equal(gitOut(task.worktree, 'log', '-1', '--format=%s'), `WIP(agent): timeout ${job.jobId}`);
      assert.deepEqual(gitOut(task.worktree, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['dirty.txt', 'ticks.txt']);
      assert.equal(gitOut(task.worktree, 'status', '--porcelain'), '', 'clean right after the WIP commit');
      assert.match(job.result, new RegExp(`task ${i + 1} \\(${task.agent}, handle stall-${'ab'[i]}\\): hard timeout; work in progress committed as ${task.wipCommit} \\(WIP\\(agent\\): timeout ${job.jobId}\\)\\. Continue the handle to resume\\.`));
    }
    await new Promise(r => setTimeout(r, 500));
    for (const task of job.tasks) assert.equal(gitOut(task.worktree, 'status', '--porcelain'), '', 'nothing wrote after the commit');
    assert.equal(gitOut(isolatedRepo, 'status', '--porcelain'), '', "user's checkout untouched");
    // Escritor único sem worktree: nenhum commit (o /rewind cobre); o arquivo sujo fica.
    assert.equal(inPlace.tasks[0].wipCommit, undefined);
    assert.equal(gitOut(inPlaceRepo, 'rev-parse', 'HEAD'), inPlaceHead);
    assert.match(gitOut(inPlaceRepo, 'status', '--porcelain'), /dirty\.txt/);
    const handles = Object.fromEntries(mgr.handles('stall').map(h => [h.handle, h]));
    assert.deepEqual([handles['stall-a'].lifecycle, handles['stall-a'].wipCommit], ['waiting', job.tasks[0].wipCommit]);
    assert.equal(handles['stall-c'].lifecycle, 'waiting');

    // continue retoma no mesmo worktree, sobre o WIP, com o histórico (aviso incluso). Teto de
    // 30 min: o prazo suave fica 27 min à frente, então nenhum aviso novo neste turno.
    const resumed = mgr.continueTask({ ...base, jobId: 'stall-cont', handle: 'stall-a', message: 'retome', timeoutSeconds: 1800 });
    assert.ok(resumed.ok, resumed.error);
    while (done.length < 3) {
      assert.ok(Date.now() < deadline + 30000, 'continue settled');
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(done[2].status, 'completed', done[2].error);
    assert.match(done[2].result, /RETOMADO-/);
    const resumeTurn = readFileSync(stallLog, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(realpathSync(resumeTurn.cwd), realpathSync(job.tasks[0].worktree));
    assert.ok(resumeTurn.users.includes(SOFT_TIMEOUT_MESSAGE) && resumeTurn.users.at(-1) === 'retome', 'same session history');
    assert.equal(mgr.handles('stall').find(h => h.handle === 'stall-a').lifecycle, 'waiting');
    await mgr.shutdown();
    delete process.env.FG_STALL;
    console.log(`ok timeout: soft warning before the deadline, child tree gone before WIP commit ${job.tasks[0].wipCommit.slice(0, 12)}, in-place writer without commit, handle waiting, continue resumes`);
  }

  // Trilha de auditoria com filhos reais roteirizados pelo provider Anthropic falso:
  // chain [ok, exceção, nunca rodou] e um single que falha depois de agir.
  const fake = await startFakeAnthropic([
    { tool: { name: 'read', input: { path: 'dirty.txt' } } },
    { text: 'AUDIT-STEP-ONE done' },
    { tool: { name: 'bash', input: { command: 'printf audit > dirty.txt' } } },
    { text: 'AUDIT-WROTE' },
  ]);
  const auditAgent = join(root, 'audit-agent');
  mkdirSync(auditAgent, { recursive: true });
  writeFileSync(join(auditAgent, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], retry: { enabled: false }, quietStartup: true }));
  writeFileSync(join(auditAgent, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'audit-test-not-a-key' } } }));
  const piInvocation = runner.runnerHooks.getPiInvocation;
  try {
    Object.assign(process.env, { PI_CODING_AGENT_DIR: auditAgent, AGENT_TEST_SANDBOX_NONE: '1' });
    delete process.env.AGENT_SUBAGENT_CHILD_EXTENSIONS;
    let spawns = 0;
    runner.runnerHooks.getPiInvocation = args => {
      if (++spawns === 2) throw new Error('spawn exploded');
      return { command: process.execPath, args: [cli, ...args] };
    };
    const { taskStatusLines, traceJob } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/trace.ts'));
    const { sliceText } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/jobs.ts'));
    // Modelo vem do frontmatter do papel (sem roleModels): o registro tem de nomeá-lo.
    const auditor = { name: 'auditor', source: 'user', tools: ['read', 'bash'], model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'fixture' };
    let finished;
    const audits = new BudgetManager({ baseDir: join(root, 'audit-jobs'), onComplete: record => { finished = record; } });
    const auditSpec = { sessionId: 'audit', sessionGeneration: 0, agents: [auditor], agentScope: 'user', projectAgentsDir: null,
      dispatchDefaults: { model: 'fg-fake/fake', thinkingLevel: 'low', resources: { slots: {} } }, cwd: sandboxCwd, timeoutSeconds: 1800 };
    const chain = audits.launch({ ...auditSpec, mode: 'chain', tasks: [1, 2, 3].map(i => ({ agent: 'auditor', task: 'etapa-' + i })) });
    assert.ok(chain.ok, chain.error);
    const jobId = chain.record.jobId;
    // Durante a execução: status já lista o JSONL da tarefa 1, gravado também no disco.
    const live = audits.get('audit', jobId);
    assert.equal(live.status, 'running');
    assert.equal(live.tasks[0].state, 'running');
    assert.ok(live.tasks[0].sessionFile?.endsWith('.jsonl') && existsSync(live.tasks[0].sessionFile));
    assert.equal(live.tasks[0].model, 'anthropic/claude-sonnet-4-5', 'modelo do frontmatter no registro');
    const onDisk = JSON.parse(readFileSync(join(root, 'audit-jobs/audit', jobId + '.json'), 'utf8'));
    assert.equal(onDisk.tasks[0].sessionFile, live.tasks[0].sessionFile, 'JSONL persistido quando a tarefa começa');
    const lines = taskStatusLines(live);
    assert.equal(lines[0], `task 1 auditor · running · anthropic/claude-sonnet-4-5 · ${live.tasks[0].sessionFile}`);
    assert.deepEqual(lines.slice(1), ['task 2 auditor · pending', 'task 3 auditor · pending']);
    assert.match(traceJob(live, 1).text, /## task 1 · auditor · running · /, 'trace parcial de job em andamento');
    await waitUntil(() => finished !== undefined);
    const record = finished;
    assert.equal(record.status, 'failed');
    assert.match(record.error, /spawn exploded/);
    assert.deepEqual(record.tasks.map(t => t.state), ['completed', 'failed', 'not_run']);
    assert.deepEqual(record.tasks[0].usage, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: record.tasks[0].usage.cost, contextTokens: record.tasks[0].usage.contextTokens, turns: 2 });
    assert.ok(record.tasks[1].sessionFile && existsSync(record.tasks[1].sessionFile), 'tarefa que lançou exceção mantém o JSONL');
    assert.equal(record.tasks[1].usage.turns, 0);
    assert.equal(record.tasks[1].model, 'anthropic/claude-sonnet-4-5');
    assert.match(record.tasks[1].error, /^did not finish: spawn exploded/);
    assert.equal(record.tasks[2].sessionFile, undefined);
    assert.equal(record.tasks[2].usage, undefined);
    assert.deepEqual(record.sessionFiles, [record.tasks[0].sessionFile, record.tasks[1].sessionFile]);
    assert.equal(record.usage.turns, 2, 'agregado = soma das tarefas');
    assert.equal(record.usage.input, 20);
    const all = traceJob(record).text;
    const step1 = traceJob(record, 1).text;
    assert.ok(all.includes(step1.split('\n\n')[1]), 'trace completo contém o da tarefa 1');
    const step1Lines = step1.split('\n');
    assert.deepEqual(step1Lines.slice(0, 4), [`job ${jobId} (failed)`, '', `## task 1 · auditor · completed · ${record.tasks[0].sessionFile}`, '1. call read {"path":"dirty.txt"}'], step1);
    assert.match(step1Lines[4], /^2\. result read ok \d+ B$/, step1);
    assert.equal(step1Lines[5], '3. assistant: AUDIT-STEP-ONE done', step1);
    assert.match(step1Lines[6], new RegExp(`^model anthropic/claude-sonnet-4-5(?: thinking \\w+)? · 2 turns · in 20 out 10 cacheRead 0 cacheWrite 0 \\$${record.tasks[0].usage.cost.toFixed(4)}$`), step1);
    assert.equal(step1Lines.length, 7, step1);
    assert.match(traceJob(record, 2).text, /## task 2 · auditor · failed · \S+\.jsonl\n\(no steps recorded yet\)\nmodel \S+(?: thinking \w+)? · 0 turns · in 0 out 0 cacheRead 0 cacheWrite 0 \$0\.0000\nerror: did not finish: spawn exploded/);
    assert.match(traceJob(record, 3).text, /## task 3 · auditor · not_run\n\(no child session\)/);
    assert.equal(traceJob(record, 4).ok, false);
    const page = sliceText(all, 0, 64);
    assert.ok(Buffer.byteLength(page.text) <= 64 && page.nextOffset > 0, 'trace pagina como result');
    assert.ok(Buffer.byteLength(sliceText(all, 0, 1e9).text) <= 8192, 'teto de bytes por chamada');

    // Recuperação depois da queda do pai: tarefa em execução vira interrupted com o JSONL.
    const { markInterrupted } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/jobs.ts'));
    const orphan = { ...record, jobId: 'orphan', status: 'running', finishedAt: undefined, error: undefined, parentPid: undefined, parentIdentity: undefined, runs: undefined,
      tasks: [record.tasks[0], { ...record.tasks[1], state: 'running', error: undefined }, { agent: 'auditor', task: 'etapa-3' }] };
    const recovered = markInterrupted(join(root, 'recovered-jobs'), orphan);
    assert.equal(recovered.status, 'interrupted');
    assert.deepEqual(recovered.tasks.map(t => t.state), ['completed', 'interrupted', 'not_run']);
    assert.equal(recovered.tasks[1].sessionFile, record.tasks[1].sessionFile, 'JSONL preservado');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'recovered-jobs/audit/orphan.json'), 'utf8')).tasks.map(t => t.state), ['completed', 'interrupted', 'not_run']);
    assert.match(taskStatusLines(recovered)[1], /^task 2 auditor · interrupted · /);
    assert.match(traceJob(recovered, 2).text, /## task 2 · auditor · interrupted · \S+\.jsonl\n/);

    // Registro anterior à auditoria por tarefa: estado desconhecido, sessões só no job.
    const [s1, s2] = record.sessionFiles;
    const legacyJob = (sessionFiles) => ({ jobId: 'legacy', sessionId: 'audit', mode: 'chain', status: 'completed', agents: ['auditor', 'auditor'],
      tasks: [{ agent: 'auditor', task: 'etapa-1' }, { agent: 'auditor', task: 'etapa-2' }], sessionFiles });
    const paired = legacyJob([s1, s2]);
    assert.deepEqual(taskStatusLines(paired), [`task 1 auditor · legacy · ${s1}`, `task 2 auditor · legacy · ${s2}`]);
    const pairedTrace = traceJob(paired, 1).text;
    assert.ok(pairedTrace.includes(`## task 1 · auditor · legacy · ${s1}\n1. call read`), pairedTrace);
    assert.match(pairedTrace, /^3\. assistant: AUDIT-STEP-ONE done$/m);
    const unpaired = legacyJob([s1]);
    assert.deepEqual(taskStatusLines(unpaired), ['task 1 auditor · legacy', 'task 2 auditor · legacy', `job session (task unknown) · ${s1}`]);
    const unpairedTrace = traceJob(unpaired).text;
    assert.match(unpairedTrace, /## task 1 · auditor · legacy\n\(no child session\)/);
    assert.ok(unpairedTrace.endsWith(`## job sessions (legacy record; not attributed to tasks)\n${s1}`), unpairedTrace);
    assert.doesNotMatch(unpairedTrace + taskStatusLines(unpaired).join('\n'), /not_run/);

    // Tarefa que falha depois de agir: os passos continuam auditáveis.
    finished = undefined;
    const single = audits.launch({ ...auditSpec, mode: 'single', tasks: [{ agent: 'auditor', task: 'escreve' }] });
    assert.ok(single.ok, single.error);
    await waitUntil(() => finished !== undefined);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.tasks[0].state, 'failed');
    assert.match(finished.tasks[0].error, /read-only role modified the checkout: dirty.txt/);
    assert.equal(finished.tasks[0].usage.turns, 2);
    const failedTrace = traceJob(finished).text;
    assert.match(failedTrace, /^1\. call bash \{"command":"printf audit > dirty.txt"\}$/m);
    assert.match(failedTrace, /^2\. result bash ok \d+ B$/m);
    assert.match(failedTrace, /^3\. assistant: AUDIT-WROTE$/m);
    assert.match(failedTrace, /^error: read-only role modified the checkout: dirty.txt$/m);
    assert.doesNotMatch(failedTrace, /Task: escreve|fixture/, 'sem prompt nem system do filho');
    await audits.shutdown();
    console.log('ok trace: passos de filho roteirizado, tarefa com exceção e não executada, falha após agir, modelo/usage por tarefa');
  } finally {
    runner.runnerHooks.getPiInvocation = piInvocation;
    await fake.close();
  }
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
const isolatedEvents = runPi({ FG_PARALLEL: 'worker', FG_WRITE: writerLog, FG_KEEPALIVE: '8' });
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
const integrated = runPi({ FG_PARALLEL: 'worker', FG_WRITE: join(root, 'integrated.log'), FG_KEEPALIVE: '8', FG_INTEGRATE: '1' });
const integration = integrated.filter(e => e.type === 'tool_execution_end' && e.toolName === 'subagent').at(-1).result;
assert.ok(!integration.isError, JSON.stringify(integration));
assert.match(integration.content[0].text, /integrate complete/);
assert.match(integration.content[0].text, /checks gate passed \(1 checks\)/);
for (const x of ['a', 'b', 'c']) assert.equal(readFileSync(join(root, 'file-' + x), 'utf8'), x);
// Integra também o primeiro job pelo manager, carregado sem dependências do Pi.
const { createJiti } = await import(join(piRoot, 'node_modules/jiti/lib/jiti.mjs'));
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js') } });
const { SubagentJobManager } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/jobs.ts'));
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
assert.equal(git('branch', '--list', 'agent/*'), '', 'branches removidas');
// GC não apaga recurso recente ou sujo, mesmo quando o branch já está integrado.
const { gcWorktrees, manageWorktrees } = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/worktrees.ts'));
const gcPath = join(root, 'gc-worktree');
git('worktree', 'add', '-b', 'agent/gc', gcPath, 'HEAD');
const gcRecord = { ...isolatedRecord, tasks: [{ worktree: gcPath, branch: 'agent/gc', sourceCwd: root, sourceBranch: 'main' }], finishedAt: Date.now() };
assert.equal(gcWorktrees(gcRecord, Date.now()), false, 'GC preserva jobs recentes');
gcRecord.finishedAt -= 31 * 86400000;
writeFileSync(join(gcPath, 'file-gc'), 'dirty');
assert.equal(gcWorktrees(gcRecord, Date.now()), false, 'GC preserva worktree sujo');
assert.ok(existsSync(gcPath));
rmSync(join(gcPath, 'file-gc'));
assert.equal(gcWorktrees(gcRecord, Date.now()), true, 'GC remove apenas limpo, antigo e integrado');
assert.ok(!existsSync(gcPath));
assert.equal(git('branch', '--list', 'agent/*'), '');

// Retoma remoção interrompida sem consultar status de um diretório inexistente.
function cleanupFixture(name) {
  const worktree = join(root, name);
  const branch = `agent/${name}`;
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
runPi({ FG_WRITE: singleLog, FG_KEEPALIVE: '4' });
assert.equal(resolve(JSON.parse(readFileSync(singleLog, 'utf8').trim()).cwd).replace(/^\/private/, ''), root.replace(/^\/private/, ''), 'single mantém cwd');
console.log('ok worktrees: isolamento paralelo, origem limpa, integração explícita e single intacto');
rmSync(root, { recursive: true, force: true });
console.log('ok subagent-dispatch: sempre ligado, auditoria, slots, concorrência e isolamento da receita');
