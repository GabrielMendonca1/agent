// NODE_OPTIONS=--import=file:///.../mark/juice/runtime.mjs
// Coverage: this installation's ModelRuntime provider dispatch. Not a sandbox:
// external SDK instances, HTTP tools and arbitrary plugins can bypass it.
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getJuicePreferences, getJuiceSnapshot, juiceOperation, juiceStatePath, requireJuice } from './client.mjs';
import { JUICE_KIND } from './cache-policy.mjs';
import { installSkillPolicy, restoreSkillPolicyEnvironment } from './skill-policy.mjs';

const installed = Symbol.for('mark.juice.runtime.v1');
export function installJuiceGate(ModelRuntime) {
  if (process.env.MARK_JUICE_ENABLED !== '1') return false;
  requireJuice();
  const proto = ModelRuntime.prototype;
  if (proto[installed]) return true;
  if (typeof proto.prepareRequest !== 'function') throw new Error('Juice: unsupported ModelRuntime');
  const original = proto.prepareRequest;
  let accountingFailure = null;
  const check = () => {
    if (accountingFailure) throw accountingFailure;
    requireJuice();
  };
  function dispatch(provider, method, model, context, options = {}) {
    check();
    // Already-aborted calls are proved unsent and need no admission.
    options.signal?.throwIfAborted();
    // Accounting only: the declared ceiling is recorded, never reduced.
    const declared = options.maxTokens ?? model.maxTokens;
    const requested = Number.isSafeInteger(declared) && declared > 0 ? declared : 1;
    const callId = randomUUID();
    // Chamadas marcadas (ex.: aquecimento do cache-keeper) entram com kind próprio no ledger.
    const tagged = options?.[JUICE_KIND];
    const kind = typeof tagged === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(tagged) ? tagged
      : process.env.MARK_CACHE_PREFETCH === '1' ? 'cache-prefetch' : method;
    // Filho de prefetch: o cache-keeper troca o corpo por max_tokens 1; reservar o teto do modelo
    // apertaria o em-voo à toa. É só a reserva contábil; o provider segue intacto.
    const reserved = kind === 'cache-prefetch' ? 1 : requested;
    const reservation = juiceOperation({ op: 'reserve', callId, requestedOutputTokens: reserved, model: `${model.provider}/${model.id}`, kind });
    // A fresh UUID can only replay if the ledger is inconsistent.
    if (reservation.allow !== true) throw new Error(`Juice: ledger refused the call id (${reservation.reason})`);
    function record(op, extra = {}) {
      try { juiceOperation({ op, callId, ...extra }); }
      catch (error) { accountingFailure = error; throw error; }
    }
    if (options.signal?.aborted) { record('cancel'); options.signal.throwIfAborted(); }
    // Payload FINAL (depois de toda a cadeia before_provider_request) para o cache-keeper:
    // extensões depois dele (tool-lexicon, image-normalize) mudam o corpo, e o ping tem de
    // reenviar exatamente o que foi enviado. Só números/objetos em memória; nada é gravado.
    if (kind !== 'cache-warm' && typeof options.onPayload === 'function') {
      const original = options.onPayload;
      options = { ...options, onPayload: async (payload, m) => {
        const result = await original(payload, m);
        try { globalThis[Symbol.for('mark.cache-keeper.finalPayload')]?.(result === undefined ? payload : result); } catch { /* observação apenas */ }
        return result;
      } };
    }
    let stream;
    try {
      // No cap: the model's own ceiling and the caller's options are untouched.
      stream = provider[method](model, context, options);
    } catch (error) {
      // A synchronous provider throw does not prove that no bytes were sent.
      record('unknown');
      throw error;
    }
    if (!stream || typeof stream.result !== 'function') {
      record('unknown');
      throw new Error('Juice paused: provider did not return an event stream');
    }
    // result() observes the stream's terminal promise; never consume its iterator.
    const settled = Promise.resolve(stream.result()).then(message => {
      const output = message?.usage?.output;
      // Error/abort and all-zero usage can be synthetic. With no provider-level
      // usage-presence flag, zero output is conservatively unknown in this pilot.
      if (['stop', 'length', 'toolUse'].includes(message?.stopReason) && Number.isSafeInteger(output) && output > 0) {
        const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
          .filter(key => Number.isSafeInteger(message.usage[key]) && message.usage[key] >= 0)
          .map(key => [key, message.usage[key]]));
        // Token counters plus the provider's dollar estimate; the JSON ledger accumulates cost.total.
        const cost = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total']
          .filter(key => Number.isFinite(message.usage.cost?.[key]) && message.usage.cost[key] >= 0)
          .map(key => [key, message.usage.cost[key]]));
        if (Object.keys(cost).length) usage.cost = cost;
        record('settle', { outputTokens: output, usage });
      } else record('unknown');
      return message;
    }, error => { record('unknown'); throw error; });
    // Observation is eager even when callers only iterate, without unhandled rejection.
    settled.catch(() => {});
    return new Proxy(stream, {
      get(target, key) {
        if (key === 'result') return () => settled;
        if (key === Symbol.asyncIterator) return async function* () {
          for await (const event of target) {
            if (event.type === 'done' || event.type === 'error') await settled;
            yield event;
          }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  proto.prepareRequest = async function (model, options) {
    check();
    // Before auth resolution as well as before dispatch, so ledger faults cannot
    // cause a new request. Snapshot does not admit anything.
    const state = getJuiceSnapshot();
    if (!state) throw new Error('Juice paused: no accounting run');
    const prepared = await original.call(this, model, options);
    const provider = prepared.provider;
    return { ...prepared, provider: new Proxy(provider, {
      get(target, key) {
        if (key === 'stream' || key === 'streamSimple') return (m, c, o) => dispatch(target, key, m, c, o);
        if (['classify', 'generateImages', 'fetchDeferred'].includes(key)) return () => { throw new Error(`Juice paused: ${key} unsupported in pilot`); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) };
  };
  Object.defineProperty(proto, installed, { value: true });
  return true;
}

if (process.env.MARK_JUICE_ENABLED === '1') {
  requireJuice();
  // Watchers and children must observe the same generation-specific file.
  process.env.MARK_JUICE_STATE = juiceStatePath();
  const root = process.env.MARK_JUICE_PI_ROOT;
  if (!root || !isAbsolute(root)) throw new Error('Juice: MARK_JUICE_PI_ROOT must identify the target installation');
  // Deliberately no automatic new-run transition. Reload/continue/new session in
  // this profile reuse the same ledger; the ledger only accumulates cost.
  if (process.env.MARK_JUICE_CHILD === '1') {
    if (!getJuiceSnapshot()) throw new Error('Juice child requires an existing parent run');
  } else {
    const prefs = getJuicePreferences();
    if (prefs.supportModel) process.env.MARK_JUICE_SUPPORT_MODEL = prefs.supportModel;
    else delete process.env.MARK_JUICE_SUPPORT_MODEL;
    juiceOperation({ op: 'init', runId: process.env.MARK_JUICE_RUN_ID || randomUUID(), mode: prefs.mode });
  }
  const entry = 'dist/core/model-runtime.js';
  const { ModelRuntime } = await import(pathToFileURL(join(root, entry)).href);
  const { formatSkillsForPrompt } = await import(pathToFileURL(join(root, 'dist/core/skills.js')).href);
  installSkillPolicy(formatSkillsForPrompt);
  if (typeof ModelRuntime !== 'function') throw new Error(`Juice: ${entry} does not export ModelRuntime`);
  installJuiceGate(ModelRuntime);
} else {
  restoreSkillPolicyEnvironment(process.env);
}
