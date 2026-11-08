#!/usr/bin/env node
// Inspect real adapter payloads; abort IN onPayload before any transport.
// This proves why the pilot labels output as soft, not a universal wire cap.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = process.env.AGENT_JUICE_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');
const api = join(root, 'node_modules/@earendil-works/pi-ai/dist/api');
const codex = await import(pathToFileURL(join(api, 'openai-codex-responses.js')).href);
const responses = await import(pathToFileURL(join(api, 'openai-responses.js')).href);
let network = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('No network permitted in juice fixture'); };
const jwt = ['fixture', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'juice-fixture' } })).toString('base64'), 'fixture'].join('.');
const base = { type:'chat', id:'gpt-5.4', name:'Fixture', provider:'openai', api:'openai-responses', baseUrl:'http://127.0.0.1:1/v1', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:20000, maxTokens:4000 };
async function payload(adapter, model, maxTokens, key) {
  let body;
  const stream = adapter.streamSimple(model, { messages:[{role:'user',content:'fixture',timestamp:0}] }, { apiKey:key,maxTokens,reasoning:'off',transport:'sse',onPayload(value){ body=structuredClone(value); throw new Error('JUICE_PAYLOAD_CAPTURED'); } });
  const result = await stream.result();
  assert.equal(result.stopReason,'error');
  assert.ok(body, result.errorMessage || 'Adapter did not reach onPayload');
  assert.match(result.errorMessage,/JUICE_PAYLOAD_CAPTURED/);
  return body;
}
try {
  const c = await payload(codex,{...base,provider:'openai-codex',api:'openai-codex-responses'},4000,jwt);
  assert.equal(c.max_output_tokens,undefined);
  console.log('ok actual Codex payload has no output cap: pilot must disclose soft output budget');
  const r = await payload(responses,base,1,'fake-not-secret');
  assert.equal(r.max_output_tokens,16);
  console.log('ok actual Responses payload raises a requested cap of 1 to provider minimum 16');
  const normal = await payload(responses,base,4000,'fake-not-secret');
  assert.equal(normal.max_output_tokens,4000);
  console.log('ok actual Responses carries supported requested cap; no transport was used');
  assert.equal(network,0);
} finally { globalThis.fetch=originalFetch; }
