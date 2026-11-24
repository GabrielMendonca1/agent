# agent/core — contrato do runtime

Módulos compartilhados pelas extensões, launcher e subagentes.
Não há ledger, contabilidade, grant nem teto de custo no runtime atual.

## Preload

`runtime.mjs` é o preload do launcher (`NODE_OPTIONS`). Só age com
`AGENT_RUNTIME_ENABLED=1` e exige `AGENT_PI_ROOT` absoluto. Envolve
`ModelRuntime.prepareRequest` do Pi apenas para entregar o payload final ao
cache-keeper; stream, erros, cancelamento e uso voltam inalterados. Também instala
a política de skills.

## Preferências e processo

`client.mjs`:

- `runtimeEnabled()`: `AGENT_RUNTIME_ENABLED=1` (aceita `AGENT_JUICE_ENABLED` legado).
- `isChild()`: `AGENT_CHILD=1`. Filho não lança subagentes nem altera preferências.
- Preferências em `<perfil>/agent-preferences.json` (`PI_CODING_AGENT_DIR`, padrão
  `~/.agent`): só `supportModel` (modelo de apoio, `provider/id` ou `null`).
  Escrita sob trava de preferências e rename atômico.

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

`gemini` com `runner: agy` não usa slots, tiers ou allowlists do Pi. Sua
preferência opcional no `agent-models.json` do perfil é `agyModels.gemini`, com
`{ "model": "antigravity/<família>", "thinking": "<nível solicitado>" }`.
A referência virtual é só do painel/arquivo. Ao criar o job, ela vira o ID nativo
(e o esforço mais próximo disponível quando a família tem sufixos). Sem essa
preferência, vale o frontmatter nativo se definido; senão, Gemini 4 Neon `high`.

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

## Compatibilidade de leitura

Não há ledger, aprendizado, mineração nem state lock no runtime atual.
A trava de `lock.mjs` protege apenas a atualização de preferências.

O launcher valida e lança artefatos imutáveis antigos com o preload declarado
`agent/juice/runtime.mjs`, sem reescrevê-los. Configs v1 mantêm `juiceHome` para
rollback; somente esses artefatos recebem o ambiente `AGENT_JUICE_*` histórico.
A limpeza de processos/ambiente reconhece esses nomes para não vazar ativação,
preloads ou curadoria para comandos do usuário. A leitura de
`AGENT_JUICE_SKILLS_BEFORE` restaura snapshots de processos antigos; novos snapshots
usam `AGENT_SKILLS_BEFORE`. Os leitores de ativação ainda aceitam env legado.

`project-prompt` reconhece o nome pessoal/settings `juice` somente para respeitar
opt-out e excluir a cópia antiga durante o registro novo (recibo reversível).
Não são criados aliases de arquivo no artefato novo. A instalação anterior
continua usando seus próprios arquivos até a troca; rollback usa seu manifesto.

## Contexto do projeto

- Pessoal: `~/.agent/AGENTS.md`, injetado inteiro pelo Pi, sem entrar no arquivo gerado do projeto.
- Fontes: `.agent/rules.md` e `.agent/header.md`. `project-context.mjs` monta
  `AGENTS.md` com marcador na primeira linha, header + rules e ponteiros relativos
  para notes, STATUS, HISTORY e docs existentes, nessa ordem. Não inclui corpos desses documentos.
- AGENTS.md sem marcador nunca é sobrescrito pelo montador; entra inteiro no
  contexto, com dica de `/rules init`. Esse comando pede ao agente a migração
  explícita, incluindo o workflow legado.
- `project-prompt.ts` instala `lib/project-context.ts`: remonta no session_start e fixa
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
