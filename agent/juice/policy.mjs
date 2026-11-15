// Stable safety policy; delegation is optional and independent of legacy modes.

/** Ponteiro por sessão; metadados vêm do chamador, nunca do cwd ou relógio aqui. */
export function notesSection({ count, ageDays }) {
  return count === 0 ? '' : `<agent_notes>Mapa de notas do projeto em .agent/notes.md (${count} linhas, atualizado há ${ageDays} dias): leia-o antes de explorar e responda pela nota quando ela cobrir a pergunta; quando a resposta for decidir algo, verifique no código.</agent_notes>`;
}

export const AUTONOMY_SECTION = 'agent_autonomy';
export const COMPLEX_SECTION = 'agent_complex';
/** Ordem fixa das seções de política (a ordem entra no texto renderizado). */
export const POLICY_SECTIONS = [AUTONOMY_SECTION, COMPLEX_SECTION];

export const AUTONOMY_POLICY = [
  'Política de trabalho:',
  '- Execute o plano até o fim: não peça para continuar nem ofereça o próximo passo.',
  '- Entre opções razoáveis, decida você e registre a decisão em uma linha no relatório.',
  '- Pergunte quando faltar informação indispensável que não possa descobrir sozinho ou para obter autorização antes de ação consequente: push, merge, deploy, ação destrutiva ou efeito em terceiros.',
  '- Quem decide é o seu usuário (a pessoa nesta sessão): pergunte a ele, não a terceiros. Aprovação e instrução explícita dele vencem esta autonomia; nunca inicie ação de terceiros por conta própria.',
].join('\n');

/** Compatibility: delegation is optional, never a required session mode. */
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
