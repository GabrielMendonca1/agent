// Resource preferences only. This compatibility module has no accounting state.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withDirectoryLock } from './lock.mjs';

export const runtimeEnabled = () => (process.env.AGENT_RUNTIME_ENABLED ?? process.env.AGENT_JUICE_ENABLED) === '1';
export const juiceEnabled = runtimeEnabled;
export const isChild = () => (process.env.AGENT_CHILD ?? process.env.AGENT_JUICE_CHILD) === '1';
export const preferencesPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.agent'), 'agent-preferences.json');
function readPreferences() {
  try { return JSON.parse(readFileSync(preferencesPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { supportModel: null }; throw error; }
}
function validate(prefs) {
  if (!(prefs.supportModel === null || (typeof prefs.supportModel === 'string' && prefs.supportModel.includes('/')))) throw new Error('Agent: invalid support model');
  return { supportModel: prefs.supportModel };
}
export function getAgentPreferences() { return validate(readPreferences()); }
export function setAgentPreferences(patch) {
  if (isChild()) throw new Error('Agent children cannot change preferences');
  const file = preferencesPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const result = withDirectoryLock(`${file}.lock-dir`, () => {
    const prefs = validate({ ...readPreferences(), ...patch });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(prefs) + '\n', { mode: 0o600 });
      renameSync(temp, file);
      return prefs;
    } finally { rmSync(temp, { force: true }); }
  });
  if (result === undefined) throw new Error(`Agent: preferences lock timeout: ${file}`);
  return result;
}
export const getJuicePreferences = getAgentPreferences;
export const setJuicePreferences = setAgentPreferences;
