# agent/juice — contrato do runtime

O diretório mantém o nome `juice` por compatibilidade de caminhos e imports.
Não há ledger, contabilidade, grant nem teto de custo no runtime atual.

## Preload

`runtime.mjs` é o preload do launcher (`NODE_OPTIONS`). Só age com
`AGENT_RUNTIME_ENABLED=1` e exige `AGENT_PI_ROOT` absoluto. Envolve
`ModelRuntime.prepareRequest` do Pi apenas para entregar o payload final ao
cache-keeper; stream, erros, cancelamento e uso voltam inalterados. Também instala
a política de skills. `installJuiceGate` é alias de `installAgentRuntime`.

## Preferências e processo

`client.mjs`:

- `runtimeEnabled()`: `AGENT_RUNTIME_ENABLED=1` (aceita `AGENT_JUICE_ENABLED` legado).
- `isChild()`: `AGENT_CHILD=1`. Filho não lança subagentes nem altera preferências.
- Preferências em `<perfil>/agent-preferences.json` (`PI_CODING_AGENT_DIR`, padrão
  `~/.agent`): só `supportModel` (modelo de apoio, `provider/id` ou `null`).
  Escrita sob trava e rename atômico. `getJuicePreferences`/`setJuicePreferences`
  são aliases.

## Subagentes

A tool `subagent` está sempre ligada na sessão principal. Não há modos, atalho,
comando nem variável para desligar. O system prompt da sessão principal traz a
diretriz de orquestrador: scout para reconhecimento e leitura em volume, worker
para implementação isolada, reviewer para revisão; o pai guarda o contexto para
decisão e integração. Isolamento, auditoria e lacunas: `docs/setup.md`,
"Subagentes: sempre ligados, isolamento e auditoria".

## Receita e modelo por papel

`workflow.mjs` lê `.agent/rules.md`, com fallback para `.agent/workflow.md`; o arquivo não é criado
automaticamente. Sem ele, scout=apoio e os demais papéis=principal. Ordem de
decisão do modelo de um papel: config do papel em `/models` > frontmatter do
papel > slot. Não há classificador de dispatch. Sem modelo de apoio, o slot
`apoio` cai no principal: herdam o modelo principal os papéis sem config própria
em `/models` e sem `model` no frontmatter.

`contextFilesMessage` substitui AGENTS.md gerado por `.agent/rules.md` +
`.agent/header.md` e ponteiros na tarefa de cada filho. Não duplica as fontes em
`projectRules`; quando o projeto de origem difere do checkout do filho, recebe
também as fontes da origem como orientação. Sem rules.md, mantém o fallback
legado de workflow.md (até 8 KB; fonte acima de 64 KB é ignorada).

## Cache

`cache-policy.mjs` tem funções puras usadas por
`extensions/brain-live/cache-keeper.ts`, pela compactação e pelo runner de
subagentes: plano de ping (`warmPlan`), adiamento da compactação por limiar
(`compactionDecision`), compactação ociosa, chave `prompt_cache_key` da OpenAI,
causa de quebra de cache e leque escalonado. Não guarda texto de payload. Custos,
gatilhos e variáveis: `docs/setup.md`, "Custo: o que roda sem prompt".

## Removido

Ledger e accounting Juice, aprendizado/mineração automáticos e recaps por modelo.
`learn.mjs` e `mine.mjs` continuam na árvore, mas o runtime não os importa.

## Histórico: contrato v1/v2

Vale só para artefatos v1/v2 com config v1 (rollback). Não descreve o runtime atual.

- `client.mjs` mantinha preferências em `AGENT_JUICE_HOME/preferences.v3.json`
  (o launcher define `AGENT_JUICE_HOME` a partir de `juiceHome` na config v1;
  instalações do Agent usam `~/.agent-juice`) e contabilidade em `AGENT_JUICE_STATE`
  (padrão `<home>/run.v3.json`), opt-in por `AGENT_JUICE_ENABLED=1`. A geração
  Rust/v1 usava `run.json` e `preferences.json`.
- Escrita sob trava de diretório com dono PID/nonce e rename atômico; schema v2.
- Exportações: `juiceOperation`, `getJuiceSnapshot(Async)`, `getJuiceReport`,
  `recordJuiceCacheEvent`, `getJuiceReceipts`, `setJuiceMode`, `formatJuiceStatus`.
  Operações `init`, `mode`, `reserve`, `settle`, `cancel`, `unknown`, `snapshot`,
  `report`, `cache` e `receipts`.
- O preload reservava e liquidava cada chamada no ledger, compartilhado por pai e
  subagentes.
- O modo ficava numa entrada `custom` `agent-mode` (`{ version: 1, mode }`) no branch.
- Após run com checks verdes, o modelo de apoio escrevia 0–3 regras em
  `.agent/workflow.md` (`[by: Agent; proven: no]`) e `.agent/history.json`.

## Contexto do projeto

- Pessoal: `~/.agent/AGENTS.md`, injetado inteiro pelo Pi, sem entrar no arquivo gerado do projeto.
- Fontes: `.agent/rules.md` e `.agent/header.md`. `project-context.mjs` monta
  `AGENTS.md` com marcador na primeira linha, header + rules e ponteiros relativos
  para notes, STATUS, HISTORY e docs existentes, nessa ordem. Não inclui corpos desses documentos.
- AGENTS.md sem marcador nunca é sobrescrito pelo montador; entra inteiro no
  contexto, com dica de `/rules init`. Esse comando pede ao agente a migração
  explícita, incluindo o workflow legado.
- `juice.ts` instala `lib/project-context.ts`: remonta no session_start e fixa
  `systemPromptOptions.contextFiles` pelo SDK do Pi 1.5.2. AGENTS.md gerado vira
  rules + header inteiros e ponteiro absoluto para o arquivo completo; notes e
  STATUS são ponteiros, não corpos. A descoberta de ancestrais e shadowing é do Pi.
- edit/write das fontes e `/remember <texto>` só remontam o disco, nunca o snapshot
  em uso. Nova sessão lê as mudanças. `/remember` oferece pessoal/projeto via
  ui.select; sem UI exige rules.md existente e grava nele. Cancelamento não escreve.
- Arquivo gerado usa LF, uma linha vazia entre blocos e newline final; fontes
  são preservadas no disco e injetadas inteiras. Não há relógio na montagem.
- Verificação: `scripts/test-agent-project-context.mjs` no portão, incluindo
  sincronia byte a byte do AGENTS.md deste repo e captura offline com Pi real.
