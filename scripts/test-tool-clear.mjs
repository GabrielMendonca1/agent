#!/usr/bin/env node
// Permanent gate: branch projection + real Pi processes against loopback only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';
const repo = resolve(import.meta.dirname, '..');
const piRoot = process.env.AGENT_PI_ROOT || join(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'), 'current/lib/node_modules/@earendil-works/pi-coding-agent');
for (const k of Object.keys(process.env)) if (/^(PI|AGENT|MARK)_/.test(k)) delete process.env[k];
delete process.env.NODE_OPTIONS;
const root = mkdtempSync(join(tmpdir(), 'agent-tool-clear-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = join(root, 'profile');
const mod = await import('../agent/extensions/brain-live/compaction/tool-clear.ts');
const compaction = await import('../agent/extensions/brain-live/compaction.ts');
const { bindSessionCachePolicy } = await import('../agent/juice/cache-policy.mjs');
const text = s => [{ type: 'text', text: s }];
const usage = { input: 600_000, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 600_001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const messages = [];
const names = ['bash', 'read', 'grep', 'find', 'ls', 'codemode', 'skim', 'web_fetch', 'edit', 'write', 'ask_user', 'subagent'];
for (let turn = 0; turn < 6; turn++) {
  messages.push({ role: 'user', content: `user ${turn}`, timestamp: 1 });
  for (const name of names) {
    const id = `${turn}-${name}`;
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path: 'x' } }], api: 'anthropic-messages', provider: 'fake', model: 'claude-test', stopReason: 'toolUse', usage, timestamp: 1 });
    messages.push({ role: 'toolResult', toolName: name, toolCallId: id, content: text(`${name}\n` + 'old output '.repeat(2200)), isError: false, timestamp: 1 });
  }
  messages.push({ role: 'assistant', content: text('assistant text'), api: 'anthropic-messages', provider: 'fake', model: 'claude-test', stopReason: 'stop', usage, timestamp: 1 });
}
// An approved name is not enough: images and unmatched results must survive.
messages.splice(2, 0, { role: 'toolResult', toolName: 'read', toolCallId: 'unmatched', content: text('x'.repeat(200000)), timestamp: 1 });
messages.splice(4, 0, { role: 'toolResult', toolName: 'read', toolCallId: 'image', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], timestamp: 1 });
const entry = (m, i) => ({ id: `m${i}`, type: 'message', message: m });
const request = { type: 'custom', customType: 'agent-tool-clear-request', data: { at: Date.now() - 4000000, ttl: 3600, model: 'fake/claude-test' } };
function fixture({ tokens = 600000, warm, child = false, entries = [...messages.map(entry), structuredClone(request)] } = {}) {
  if (child) process.env.AGENT_CHILD = '1';
  const handlers = {};
  const ctx = { sessionManager: { getBranch: () => entries }, model: { provider: 'fake', id: 'claude-test' }, getContextUsage: () => ({ tokens, contextWindow: 1000000 }) };
  const pi = { on: (n, f) => { (handlers[n] ??= []).push(f); }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  compaction.default(pi); delete process.env.AGENT_CHILD;
  for (const f of handlers.session_start ?? []) f({}, ctx);
  if (warm !== undefined) bindSessionCachePolicy(ctx, { cacheState: () => ({ warm }), deferCompaction: () => warm === 'defer' });
  return { ctx, handlers, entries, context: () => handlers.context?.[0]({ messages }, ctx)?.messages ?? messages, batches: () => entries.filter(e => e.customType === 'agent-tool-clear') };
}
assert.deepEqual(fixture({ tokens: 149999, warm: false }).context(), messages);
process.env.AGENT_TOOL_CLEAR_MIN_SAVINGS = '9999999';
const small = fixture({ warm: false }); small.context(); assert.equal(small.batches().length, 0);
delete process.env.AGENT_TOOL_CLEAR_MIN_SAVINGS;
const hot = fixture({ warm: true }); hot.context(); assert.equal(hot.batches().length, 0);
const deferred = fixture({ warm: 'defer' });
assert.deepEqual(await deferred.handlers.session_before_compact[0]({ reason: 'threshold' }, deferred.ctx), { cancel: true });
assert.equal(deferred.batches().length, 0);
const unknown = fixture({ entries: messages.map(entry) }); unknown.context(); assert.equal(unknown.batches().length, 0);
const switched = fixture({ warm: true }); switched.ctx.model.id = 'other'; switched.context(); assert.equal(switched.batches().length, 1);
const cold = fixture({ warm: false });
const projected = cold.context();
assert.equal(cold.batches().length, 1);
assert.equal(cold.batches()[0].data.replacements.length, 24);
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  const changed = m.role === 'toolResult' && /^[012]-/.test(m.toolCallId) && names.slice(0, 8).includes(m.toolName);
  if (changed) assert.match(projected[i].content[0].text, /rode de novo se precisar/);
  else assert.deepEqual(projected[i], m, `protected ${i}`);
}
assert.deepEqual(cold.context(), projected, 'same next request');
assert.equal(cold.batches().length, 1, 'no duplicate write');
const resumed = fixture({ entries: structuredClone(cold.entries), warm: true });
assert.deepEqual(resumed.context(), projected, 'new runtime replays');
assert.equal(resumed.batches().length, 1);
process.env.AGENT_TOOL_CLEAR = '0';
assert.deepEqual(resumed.context(), projected, 'disabled still replays');
const disabled = fixture({ warm: false }); disabled.context(); assert.equal(disabled.batches().length, 0);
delete process.env.AGENT_TOOL_CLEAR;
const child = fixture({ child: true, warm: false }); assert.equal(child.context(), messages); assert.equal(child.batches().length, 0);
const automatic = fixture({ tokens: 460000, warm: true });
assert.equal(mod.clearBeforeAutoCompaction(automatic.ctx, 450000), true, 'warm automatic replacement suffices');
const insufficient = fixture({ tokens: 900000, warm: true });
assert.equal(mod.clearBeforeAutoCompaction(insufficient.ctx, 450000), false, 'insufficient still compacts');
assert.equal(insufficient.batches().length, 1);
for (const reason of ['manual', 'overflow']) {
  const t = fixture({ warm: true });
  await t.handlers.session_before_compact[0]({ reason }, t.ctx);
  assert.equal(t.batches().length, 0, `${reason} does not trigger cleanup`);
}
const edited = structuredClone(messages); edited[2].content = text('changed source');
assert.deepEqual(mod.replayToolClears(edited, cold.entries)[2], edited[2], 'source hash mismatch');
const fork = fixture({ entries: messages.map(entry), warm: true }); fork.context(); assert.equal(fork.batches().length, 0, 'other branch has no batches');
console.log('ok thresholds, cold/warm/unknown/model switch, selection, replay, disabled, children, compaction');

// Real journal writer and provider serializers, across three separate Pi processes.
const { SessionManager } = await import(pathToFileURL(join(piRoot, 'dist/core/session-manager.js')).href);
assert.equal(JSON.parse(readFileSync(join(piRoot, 'package.json'))).version, '1.5.2');
const profile = join(root, 'profile'); mkdirSync(profile, { recursive: true });
// Fresh copied settings only, deliberately no auth.json or real profile access.
const template = join(root, 'profile-template'); mkdirSync(template);
writeFileSync(join(template, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }));
writeFileSync(join(profile, 'settings.json'), readFileSync(join(template, 'settings.json')));
assert.equal(existsSync(join(profile, 'auth.json')), false);
const fake = await startFakeAnthropic([{ text: 'offline reply', usage: { input: 300000 } }]);
try {
  writeFileSync(join(profile, 'models.json'), JSON.stringify({ providers: { fake: { api: 'anthropic-messages', apiKey: 'offline', baseUrl: fake.baseUrl, models: [{ id: 'claude-test', name: 'test', reasoning: false, input: ['text'], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 1000000, maxTokens: 32000 }] } } }));
  const manager = SessionManager.create(root, join(root, 'sessions'));
  // Images were tested above; omit fake image bytes from wire test.
  for (const m of messages.filter(m => !m.content?.some?.(c => c.type === 'image'))) manager.appendMessage(m);
  manager.appendCustomEntry(request.customType, request.data);
  const session = manager.getSessionFile();
  const run = (extra = {}) => new Promise((resolveRun, reject) => {
    const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', PI_DURABLE_HOST: '0', PI_CACHE_RETENTION: 'long', ...extra };
    const p = spawn(process.execPath, [join(piRoot, 'dist/cli.js'), '-p', '--session', session, '--no-extensions', '-e', join(repo, 'agent/extensions/brain-live/compaction.ts'), '--model', 'fake/claude-test', '--tools', 'read', 'continue'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.on('error', reject); p.on('close', code => { clearTimeout(timer); assert.equal(code, 0, out); resolveRun(); });
  });
  await run({ AGENT_TOOL_CLEAR: '0' });
  const before = fake.messages().at(-1);
  // Expire the recorded request without changing any original message.
  const reopen = SessionManager.open(session);
  reopen.appendCustomEntry(request.customType, request.data);
  await run();
  const after = fake.messages().at(-1);
  const saved = readFileSync(session, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e => e.customType === 'agent-tool-clear');
  assert.equal(saved.length, 1, 'real Pi persisted batch');
  await run({ AGENT_TOOL_CLEAR: '0' });
  const replayed = fake.messages().at(-1);
  const results = p => p.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_result') : []);
  assert.deepEqual(results(after), results(replayed), 'cross-process provider history identical');
  assert.ok(JSON.stringify(results(before)).length > JSON.stringify(results(after)).length + 160000);
  const estimate = p => Math.ceil(JSON.stringify(p).length / 4);
  const a = estimate(before), b = estimate(after), savedTokens = a - b;
  console.log(JSON.stringify({ measurement: 'fake Anthropic, chars/4 estimate (not tokenizer or billed usage)', beforeTokens: a, afterTokens: b, savedTokens, usd: { anthropic5Input1hWriteBefore: a * 10e-6, anthropic5Input1hWriteAfter: b * 10e-6, cacheReadSavedPerRequest: savedTokens * 0.5e-6, openai1_25InputSaved: savedTokens * 1.25e-6 } }));
  assert.equal(readFileSync(session, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e => e.customType === 'agent-tool-clear').length, 1);
  // OpenAI Responses conversion consumes exactly the same projected toolResult messages.
  const { convertResponsesMessages } = await import(pathToFileURL(join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js')).href);
  const oai = convertResponsesMessages({ api: 'openai-responses', provider: 'openai', id: 'gpt-test', input: ['text'] }, { messages: projected }, new Set());
  assert.match(JSON.stringify(oai), /rode de novo se precisar/);
  assert.doesNotMatch(JSON.stringify(oai.filter(m => m.type === 'function_call_output' && m.call_id === '0-read')), /old output/);
  console.log('ok Pi 1.5.2 journal + fake wire + process resume + OpenAI serializer');
} finally { await fake.close(); }
