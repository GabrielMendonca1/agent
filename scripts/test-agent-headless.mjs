#!/usr/bin/env node
/**
 * Perfil Agent headless (scripts/lib/agent-headless.mjs): `pi -p --mode json` com provider falso numa HOME
 * temporária. Prova política estável com subagentes sempre ligados (diretriz de orquestrador), sem ledger,
 * que nada de TUI/peers/megamind/brain-live extra entra, e
 * que o prompt de sistema é menor que o do perfil completo (bytes impressos).
 *
 * Usa o Pi do store (`<store>/current`); sua ausência é erro. Nenhuma chamada de rede real.
 */
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncAgentSetup } from './lib/agent-setup.mjs';
import { syncAgentExtensions } from './lib/extensions.mjs';
import { syncAgentSkills } from './lib/skills.mjs';
import { headlessSettings } from './lib/agent-headless.mjs';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.AGENT_STORE || join(homedir(), '.local', 'share', 'agent');
const pi = join(store, 'current', 'bin', 'pi');
const piRoot = join(store, 'current', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
assert.ok(existsSync(pi), `sem Pi instalado em ${store}/current`);

const root = mkdtempSync(join(tmpdir(), 'agent-headless-test-'));
const home = join(root, 'home');
const agentStore = join(root, 'store');
const fake = await startFakeAnthropic([{ text: 'pong', usage: { output: 5 } }]);
let checks = 0;
const ok = (name) => { checks++; console.log(`ok ${name}`); };

/** Um agent dir completo (setup do Agent) e um headless derivado dele; ambos com o mesmo modelo falso. */
function agentDirFor(name, transform) {
	const agentDir = join(home, name, '.pi', 'agent');
	mkdirSync(agentDir, { recursive: true });
	const quiet = { log: () => {}, warn: () => {} };
	syncAgentSkills({ sourceRoot: repo, store: agentStore, agentDir, homeDir: join(home, name), ...quiet });
	syncAgentExtensions({ sourceRoot: repo, store: agentStore, agentDir, ...quiet });
	syncAgentSetup({ sourceRoot: repo, store: agentStore, agentDir, homeDir: join(home, name), ...quiet });
	const file = join(agentDir, 'settings.json');
	const full = JSON.parse(readFileSync(file, 'utf8'));
	if (transform) writeFileSync(file, `${JSON.stringify(transform(full), null, 2)}\n`);
	writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'agent-headless-test-not-a-key' } } }));
	return { agentDir, settings: JSON.parse(readFileSync(file, 'utf8')) };
}

/** spawn assíncrono: o provider falso vive neste processo e precisa do event loop livre. */
function spawnAsync(cmd, args, options) {
	return new Promise((resolveRun) => {
		const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', (c) => { output += c; });
		child.stderr.on('data', (c) => { output += c; });
		const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
		child.on('close', (status, signal) => { clearTimeout(timer); resolveRun({ status, signal, output }); });
	});
}

const preload = pathToFileURL(join(repo, 'agent/juice/runtime.mjs')).href;

/** `pi -p --mode json` com Juice ligado; devolve o payload enviado ao provider. */
async function run(agent, label, extraEnv = {}) {
	const juiceHome = join(root, `juice-${label}`);
	mkdirSync(juiceHome, { recursive: true, mode: 0o700 });
	writeFileSync(join(juiceHome, 'preferences.v3.json'), `${JSON.stringify({ mode: 'complex', supportModel: null })}\n`);
	const before = fake.messages().length;
	const h = join(home, label.split('-')[0]);
	const result = await spawnAsync(pi, ['-p', '--mode', 'json', '--no-session', '--model', 'anthropic/claude-sonnet-4-5', 'oi'], {
		cwd: root,
		env: {
			PATH: process.env.PATH, HOME: h, USERPROFILE: h, TMPDIR: root, XDG_CONFIG_HOME: join(h, '.config'),
			PI_CODING_AGENT_DIR: agent.agentDir, PI_ACCOUNTS_MIRROR: '0', ORCA_BACKGROUND_LAUNCH: '1',
			AGENT_RUNTIME_ENABLED: '1', AGENT_PI_ROOT: piRoot, AGENT_CHILD: '0',
			NODE_OPTIONS: `--import=${preload}`,
			...extraEnv,
		},
	});
	const output = result.output;
	assert.ok(!/Failed to load extension|does not export a valid factory|Extension error|ENOENT/.test(output), `${label}: ${output.slice(0, 2000)}`);
	const sent = fake.messages().slice(before);
	assert.equal(result.status, 0, output);
	assert.ok(sent.length === 1, `${label}: nenhuma chamada ao provider (status ${result.status} ${result.signal}; urls ${JSON.stringify(fake.requests.map((r) => r.url))}):\n${output.slice(-600)}`);
	const payload = sent[0];
	const system = typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system);
	const tools = (payload.tools ?? []).map((t) => t.name);
	assert.ok(!existsSync(join(juiceHome, 'run.v3.json')), 'runtime não cria ledger');
	return { system, tools, payloadTools: payload.tools ?? [], bytes: Buffer.byteLength(system), toolBytes: Buffer.byteLength(JSON.stringify(payload.tools ?? [])), output };
}

try {
	const full = agentDirFor('full');
	const headless = agentDirFor('headless', (settings) => headlessSettings(settings));
	// settings do Agent: cópia legada excluída por `-…/index.ts` + cópia da release → só a da release
	{
		const { headlessSettings } = await import('./lib/agent-headless.mjs');
		const L = '/o/agent/extensions/brain-live'; const R = '/o/runtime/releases/abc/agent/extensions/brain-live';
		const h = headlessSettings({ extensions: [`${L}/juice.ts`, `${L}/subagent`, `-${L}/subagent/index.ts`, `${R}/juice.ts`, `${R}/subagent`, '/o/agent/extensions/agent/tui'] }, { exists: () => false });
		assert.deepEqual(h.extensions, [`${R}/juice.ts`, `${R}/subagent`], 'uma cópia por extensão, a da release');
		console.log('ok sem extensão duplicada no settings do Agent');
	}
	const names = (s) => s.extensions.map((e) => e.split('/').slice(-2).join('/').replace(/\.ts$/, ''));

	assert.deepEqual(names(headless.settings).sort(), ['brain-live/juice', 'brain-live/subagent']);
	for (const entry of ['agent/tui', 'agent/peers', 'extensions/megamind']) {
		assert.ok(full.settings.extensions.some((e) => e.endsWith(entry)), `perfil completo sem ${entry}`);
		assert.ok(!headless.settings.extensions.some((e) => e.includes(entry)), `headless carrega ${entry}`);
	}
	assert.equal(headless.settings.tuiMode, undefined);
	assert.equal(headless.settings.theme, undefined);
	ok('settings headless: só juice e subagent; tui/peers/megamind fora');

	const fullRun = await run(full, 'full-default');
	const enabled = await run(headless, 'headless-default');
	// Segundo processo idêntico: prompt e schema não dependem de estado ou chave.
	const disabled = await run(headless, 'headless-again');

	for (const r of [enabled, disabled]) {
		assert.ok(r.tools.includes('subagent'), `subagent ausente: ${r.tools}`);
		for (const t of r.tools) assert.ok(!/^(peers_|megamind_|ask_user|plan$|todo|checks$|project_)/.test(t), `tool fora do perfil: ${t}`);
		assert.ok(!/megamind|peers_list/i.test(r.system), 'prompt cita megamind/peers');
	}
	assert.ok(fullRun.tools.includes('tool_search'), `perfil completo deveria ter tool_search para as tools deferred: ${fullRun.tools}`);
	assert.ok(!fullRun.tools.some((t) => /^peers_|^megamind_(?!read$)/.test(t)), `peers/megamind deveriam estar deferred: ${fullRun.tools}`);
	ok(`tools headless: ${enabled.tools.join(', ')}`);

	assert.equal(enabled.system, disabled.system, 'mesma política entre processos');
	assert.deepEqual(enabled.tools, disabled.tools, 'schema estável');
	assert.equal(enabled.toolBytes, disabled.toolBytes, 'bytes do schema estáveis');
	assert.doesNotMatch(enabled.system, /<agent_complex>|Modo complex/);
	assert.match(enabled.system, /Quem decide é o seu usuário/);
	for (const r of [enabled, fullRun]) {
		assert.match(r.system, /subagent: Delegate reading, recon, review and self-contained implementation to subagents/, 'snippet de orquestrador');
		assert.match(r.system, /Act as an orchestrator: delegate recon and bulk reading to `scout`, isolated implementation to `worker`, and review to `reviewer`/, 'diretriz de orquestrador no system');
		assert.match(r.system, /only its result comes back, so delegated reading does not grow yours; to audit its steps and decisions use action `trace`/, 'guideline de auditoria');
		assert.doesNotMatch(r.system, /Optional async subagents|only when the user enables them|AGENT_SUBAGENTS|\/subagents on/, 'sem texto de opt-in');
	}
	const subagentBytes = Buffer.byteLength(JSON.stringify(enabled.payloadTools.find((t) => t.name === 'subagent')));
	// 8994 B antes da action trace; teto de +600 B porque o schema entra em toda requisição.
	assert.ok(subagentBytes <= 8994 + 600, `schema de subagent cresceu demais: ${subagentBytes} B`);
	ok(`política de autoridade e diretriz de orquestrador, sem modos nem inferência extra; schema subagent ${subagentBytes} B`);
	assert.ok(enabled.bytes < fullRun.bytes, `headless (${enabled.bytes}) não é menor que o completo (${fullRun.bytes})`);
	ok(`prompt: completo ${fullRun.bytes} B, headless ${enabled.bytes} B; schemas: completo ${fullRun.toolBytes} B, headless ${enabled.toolBytes} B`);
	console.log(`${checks} checks passed`);
} finally {
	await fake.close();
	rmSync(root, { recursive: true, force: true });
}
