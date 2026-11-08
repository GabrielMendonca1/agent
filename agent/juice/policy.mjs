/**
 * Políticas GLOBAIS do Agent no system prompt do agente principal.
 *
 * Autonomia (vale sempre, nos dois modos) e complex (vale só
 * enquanto o modo for complex). Nada de receita de projeto aqui: a receita
 * (`.agent/workflow.md`) continua interna e nunca chega ao principal.
 *
 * Determinismo: o texto é constante por modo — sem contador, data, cwd ou nome de
 * projeto. Mesmo modo em turnos diferentes = texto idêntico (prefixo de cache intacto).
 * Trocar de modo muda o system efetivo: a seção `agent_complex` entra e SAI de verdade
 * (no host clássico pelo diff de seções do Pi, que manda `null` para remover; no prompt
 * forçado/durável porque o texto é remontado a cada run).
 */

/** Ponteiro por sessão; metadados vêm do chamador, nunca do cwd ou relógio aqui. */
export function notesSection({ count, ageDays }) {
  return count === 0 ? '' : `<agent_notes>Mapa de notas do projeto em .agent/notes.md (${count} linhas, atualizado há ${ageDays} dias): leia-o antes de explorar e responda pela nota quando ela cobrir a pergunta; quando a resposta for decidir algo, verifique no código.</agent_notes>`;
}

export const AUTONOMY_SECTION = 'agent_autonomy';
export const COMPLEX_SECTION = 'agent_complex';
/** Ordem fixa das seções de política (a ordem entra no texto renderizado). */
export const POLICY_SECTIONS = [AUTONOMY_SECTION, COMPLEX_SECTION];

export const AUTONOMY_POLICY = [
  'Autonomia do Agent (vale em qualquer modo):',
  '- Execute o plano até o fim: não peça para continuar nem ofereça o próximo passo.',
  '- Três ou mais leituras/comandos independentes vão em uma única chamada codemode com Promise.allSettled.',
  '- Entre opções razoáveis, decida você e registre a decisão em uma linha no relatório.',
  '- Pergunte quando faltar informação indispensável que não possa descobrir sozinho ou para obter autorização antes de ação consequente: push, merge, deploy, ação destrutiva ou efeito em terceiros.',
  '- Quem decide é o seu usuário (a pessoa nesta sessão): pergunte a ele, não a outro sócio. Aprovação e instrução explícita dele vencem esta autonomia; nunca inicie ação de terceiros por conta própria.',
].join('\n');

export const COMPLEX_POLICY = [
  'Modo complex (vale só enquanto o modo for complex):',
  '- Trabalhe com a equipe: despache subagentes por `subagent`, assíncronos e independentes, em paralelo quando as frentes não dependem uma da outra.',
  '- Delegar é o padrão e vence a regra geral de trabalhar inline: reconhecimento que passe de uma ou duas leituras, implementação e revisão do diff vão para subagentes do papel certo. Inline só a leitura pontual que você precisa para escrever o brief, a integração e a verificação final.',
  '- Terminar uma tarefa de várias etapas sem nenhum `subagent` é exceção: justifique em uma linha no relatório.',
  '- Cada brief é autocontido: objetivo, contexto já conhecido, escopo de arquivos, critério de pronto e formato de retorno; o subagente não vê esta conversa.',
  '- Por padrão, omita `model`: a ferramenta escolhe internamente o modelo por papel (apoio ou principal).',
  '- Após despachar, continue o trabalho independente e integre os resultados quando chegarem; não fique consultando status em loop.',
  '- Antes de concluir, confira você mesmo o que a equipe devolveu e rode os checks do projeto.',
].join('\n');

/** Seções de política para o modo: autonomia sempre; complex só em complex. */
export function policySections(mode) {
  return mode === 'complex'
    ? { [AUTONOMY_SECTION]: AUTONOMY_POLICY, [COMPLEX_SECTION]: COMPLEX_POLICY }
    : { [AUTONOMY_SECTION]: AUTONOMY_POLICY };
}

/** As mesmas políticas como blocos marcados, para prompt já forçado (Vault/durável). */
export function policyBlocks(mode) {
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
export function appendPolicy(forced, mode) {
  const blocks = policyBlocks(mode);
  return blocks ? `${forced}\n\n${blocks}` : forced;
}
