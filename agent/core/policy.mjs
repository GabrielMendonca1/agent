// Stable safety policy; delegation is always available and independent of legacy modes.

/** Ponteiro por sessão; metadados vêm do chamador, nunca do cwd ou relógio aqui. */
export function notesSection({ count, ageDays }) {
  return count === 0 ? '' : `<agent_notes>Project notes map at .agent/notes.md (${count} lines, updated ${ageDays} days ago): read it before exploring and answer from the note when it covers the question; when the answer decides something, verify it in the code.</agent_notes>`;
}

export const AUTONOMY_SECTION = 'agent_autonomy';
export const COMPLEX_SECTION = 'agent_complex';
/** Ordem fixa das seções de política (a ordem entra no texto renderizado). */
export const POLICY_SECTIONS = [AUTONOMY_SECTION, COMPLEX_SECTION];

export const AUTONOMY_POLICY = [
  'Work policy:',
  '- Carry the plan through to the end: do not ask to continue or offer the next step.',
  '- Among reasonable options, decide yourself and record the decision in one line of the report.',
  '- Ask only when essential information is missing and you cannot find it yourself, or to get authorization before a consequential action: push, merge, deploy, a destructive action or an effect on third parties.',
  '- Your user (the person in this session) decides: ask them, not third parties. Their approval and explicit instruction override this autonomy; never start a third-party action on your own.',
  '- Reply to the user in their language.',
].join('\n');

/** Compatibility: delegation guidance lives in the subagent tool, never in a session mode. */
export const COMPLEX_POLICY = '';
export function policySections(_mode = undefined) {
  return { [AUTONOMY_SECTION]: AUTONOMY_POLICY };
}

/** As mesmas políticas como blocos marcados, para prompt já forçado (Vault/durável). */
export function policyBlocks(mode = undefined) {
  const sections = policySections(mode);
  return POLICY_SECTIONS
    .filter((name) => sections[name])
    .map((name) => `<${name}>\n${sections[name]}\n</${name}>`)
    .join('\n\n');
}

/**
 * Anexa as políticas do modo a um prompt já forçado. Sempre anexa: no host durável o
 * texto recebido é o prompt EFETIVO do turno anterior e o Pi usa a diferença como seção
 * de extensões — anexar é o que mantém a política viva e troca o bloco do modo antigo
 * pelo do atual. O chamador garante uma única chamada por run.
 */
export function appendPolicy(forced, mode = undefined) {
  const blocks = policyBlocks(mode);
  return blocks ? `${forced}\n\n${blocks}` : forced;
}
