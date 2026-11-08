import { getJuicePreferences } from '../../../juice/client.mjs';
/** @typedef {import('@earendil-works/pi-coding-agent').ExtensionAPI} ExtensionAPI */
/** @typedef {import('@earendil-works/pi-coding-agent').ExtensionContext} ExtensionContext */
/** @typedef {import('../../../juice/protocol.d.ts').JuiceMode} JuiceMode */

const ENTRY_TYPE = 'agent-mode';
// Pi mutates the branch before _persist. A thrown append must not authorize
// that in-memory entry, even through a fresh context for the same session.
// Native ESM cache shares this guard across Pi's independent Jiti loaders/reloads.
/** @type {WeakMap<ExtensionContext['sessionManager'], Set<string | undefined>>} */
const failedWrites = new WeakMap();
const writeError = () => new Error('Agent: falha ao salvar o modo da sessão. Use /mode simple ou /mode complex para recuperar.');
/** @param {unknown} mode @returns {mode is JuiceMode} */
function validMode(mode) {
  return mode === 'simple' || mode === 'complex';
}

/**
 * Only custom entries on the active branch count; conversation notes do not.
 * @param {ExtensionContext} ctx
 * @returns {JuiceMode | null}
 */
export function readSessionMode(ctx) {
  if (failedWrites.get(ctx.sessionManager)?.has(ctx.sessionManager.getSessionId?.())) throw writeError();
  return readBranchMode(ctx);
}

/** @param {ExtensionContext} ctx @returns {JuiceMode | null} */
function readBranchMode(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue;
    const data = /** @type {{ version?: unknown; mode?: unknown } | null} */ (entry.data);
    if (data?.version !== 1 || !validMode(data.mode)) throw new Error('Agent: modo da sessão inválido. Use /mode simple ou /mode complex.');
    return data.mode;
  }
  return null;
}

/**
 * @param {ExtensionAPI} pi
 * @param {ExtensionContext} ctx
 * @param {JuiceMode} mode
 * @returns {void}
 */
export function saveSessionMode(pi, ctx, mode) {
  if (!validMode(mode)) throw new Error('Agent: modo inválido.');
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId?.();
  try {
    pi.appendEntry(ENTRY_TYPE, { version: 1, mode });
    // Native entries may stay in memory before the first message or with
    // --no-session. Require a successful append, not an on-disk file.
    if (readBranchMode(ctx) !== mode) throw writeError();
  } catch (error) {
    let failed = failedWrites.get(manager);
    if (!failed) failedWrites.set(manager, failed = new Set());
    failed.add(sessionId);
    throw error;
  }
  failedWrites.get(manager)?.delete(sessionId);
}

/**
 * Old and new sessions seed the branch once, never from the accounting ledger.
 * @param {ExtensionAPI} pi
 * @param {ExtensionContext} ctx
 * @returns {JuiceMode}
 */
export function ensureSessionMode(pi, ctx) {
  const saved = readSessionMode(ctx);
  if (saved !== null) return saved;
  const mode = getJuicePreferences().mode;
  saveSessionMode(pi, ctx, mode);
  return mode;
}
