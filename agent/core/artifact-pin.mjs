// Pins a live process to the Agent artifact it started with.
//
// A deploy rewrites the shared settings.json (extensions/skills point at the new artifact) and the
// stable `<store>/skills` link. Pi reads settings again on /new, /resume, fork, /reload and in
// every child it spawns, so without this a live session would load the new artifact's code on top
// of its old Pi release. The preload knows which artifact it came from (its own file), so settings
// entries that name another artifact, or the stable skills link, are rewritten to this one.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACT_ID = /^[0-9a-f]{64}$/;
const PATH_KEYS = ['extensions', 'skills', 'prompts', 'themes'];
const real = (path) => { try { return realpathSync(path); } catch { return path; } };

/**
 * Artifact that contains `moduleUrl` (`<store>/runtime/releases/<id>/agent/core/*.mjs`), or null
 * for a checkout/dev tree. Paths are physical: a later symlink swap cannot move the pin.
 */
export function artifactPin(moduleUrl) {
  const agentRoot = real(resolve(dirname(fileURLToPath(moduleUrl)), '..'));
  const artifactRoot = dirname(agentRoot);
  const releasesDir = dirname(artifactRoot);
  const artifactId = basename(artifactRoot);
  if (basename(agentRoot) !== 'agent' || !ARTIFACT_ID.test(artifactId)) return null;
  if (basename(releasesDir) !== 'releases' || basename(dirname(releasesDir)) !== 'runtime') return null;
  try {
    if (JSON.parse(readFileSync(join(artifactRoot, 'manifest.json'), 'utf8')).artifactId !== artifactId) return null;
  } catch { return null; }
  const store = dirname(dirname(releasesDir));
  return { artifactId, artifactRoot, agentRoot, releasesDir, store };
}

function under(path, root) {
  return path === root || path.startsWith(`${root}${sep}`) ? path.slice(root.length) : null;
}

/** One settings entry (`[+-!]path`) mapped to the pinned artifact; null drops it. */
export function pinEntry(entry, pin) {
  if (typeof entry !== 'string') return entry;
  const sign = /^[+\-!]/.test(entry) ? entry[0] : '';
  const raw = entry.slice(sign.length);
  const path = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(path)) return entry;
  let mapped = null;
  for (const releases of new Set([pin.releasesDir, real(pin.releasesDir)])) {
    const rest = under(path, releases);
    if (rest === null || rest === '') continue;
    const [id] = rest.slice(1).split(sep);
    if (id === pin.artifactId) return entry;
    if (!ARTIFACT_ID.test(id)) continue;
    mapped = pin.artifactRoot + rest.slice(1 + id.length);
    break;
  }
  if (mapped === null) {
    const skills = join(pin.store, 'skills');
    for (const link of new Set([skills, join(real(pin.store), 'skills')])) {
      const rest = under(path, link);
      if (rest !== null) { mapped = join(pin.agentRoot, 'skills', 'standard') + rest; break; }
    }
  }
  if (mapped === null) return entry;
  // Something the newer artifact added does not exist here: it is not this build's to load.
  if ((sign === '' || sign === '+') && !existsSync(mapped)) return null;
  return sign + mapped;
}

/** Settings object with its resource paths pinned. Returns the same object, mutated. */
export function pinSettings(settings, pin) {
  if (!pin || !settings || typeof settings !== 'object') return settings;
  for (const key of PATH_KEYS) {
    if (!Array.isArray(settings[key])) continue;
    settings[key] = settings[key].map((entry) => pinEntry(entry, pin)).filter((entry) => entry !== null);
  }
  return settings;
}

const installed = Symbol.for('agent.artifact-pin.v1');
/** Wrap Pi's single settings read path (`SettingsManager.loadFromStorage`). */
export function installSettingsPin(SettingsManager, pin) {
  if (!pin || typeof SettingsManager?.loadFromStorage !== 'function') return false;
  if (SettingsManager[installed]) return true;
  const original = SettingsManager.loadFromStorage;
  SettingsManager.loadFromStorage = function (...args) {
    return pinSettings(original.apply(this, args), pin);
  };
  Object.defineProperty(SettingsManager, installed, { value: true });
  return true;
}
