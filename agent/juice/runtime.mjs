// Compatibility preload path. No accounting or provider result interception.
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeEnabled } from './client.mjs';
import { JUICE_KIND } from './cache-policy.mjs';
import { installSkillPolicy, restoreSkillPolicyEnvironment } from './skill-policy.mjs';

const installed = Symbol.for('agent.runtime.v2');
export function installAgentRuntime(ModelRuntime) {
  if (!runtimeEnabled()) return false;
  const proto = ModelRuntime.prototype;
  if (proto[installed]) return true;
  if (typeof proto.prepareRequest !== 'function') throw new Error('Agent: unsupported ModelRuntime');
  const original = proto.prepareRequest;
  proto.prepareRequest = async function (model, options) {
    const prepared = await original.call(this, model, options);
    return { ...prepared, provider: new Proxy(prepared.provider, {
      get(target, key) {
        if (key === 'stream' || key === 'streamSimple') return (m, c, o = {}) => {
          if (o[JUICE_KIND] !== 'cache-warm' && typeof o.onPayload === 'function') {
            const onPayload = o.onPayload;
            o = { ...o, onPayload: async (payload, model) => {
              const result = await onPayload(payload, model);
              try { globalThis[Symbol.for('agent.cache-keeper.finalPayload')]?.(result === undefined ? payload : result); } catch { /* observer only */ }
              return result;
            } };
          }
          // Return the original stream, errors, cancellation and usage unchanged.
          return target[key](m, c, o);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) };
  };
  Object.defineProperty(proto, installed, { value: true });
  return true;
}
// Existing hosts can retain the old installer name; it never accounts.
export const installJuiceGate = installAgentRuntime;

if (runtimeEnabled()) {
  const root = process.env.AGENT_PI_ROOT || process.env.AGENT_JUICE_PI_ROOT;
  if (!root || !isAbsolute(root)) throw new Error('Agent: AGENT_PI_ROOT must identify the target installation');
  const { ModelRuntime } = await import(pathToFileURL(join(root, 'dist/core/model-runtime.js')).href);
  const { formatSkillsForPrompt } = await import(pathToFileURL(join(root, 'dist/core/skills.js')).href);
  installSkillPolicy(formatSkillsForPrompt);
  if (typeof ModelRuntime !== 'function') throw new Error('Agent: ModelRuntime export missing');
  installAgentRuntime(ModelRuntime);
} else {
  restoreSkillPolicyEnvironment(process.env);
}
