# Spec — evolução do harness (5 movimentos)

Estado: aprovada em 2026-11-25 com as decisões abaixo; implementação começa pelo item 0. Base: `main` em `c11f098`. Fatos levantados no código (arquivo:linha) em 2026-11-25.

Ordem de execução proposta: **0 → 1 → 2 → 3 → 4**. A suíte de evals entra primeiro numa versão mínima, porque medir os ganhos de 1 a 4 exige uma linha de base de antes das mudanças.

## Decisões tomadas

| # | Decisão |
|---|---|
| (a) | O reviewer não executa checks. Recebe `checks list` e `checks last`. |
| (b) | No worker, o gate usa `tags: "fast"` por default; `only`/`tags` explícitos continuam aceitos. |
| (c) | A ação se chama `continue`. |
| (d) | Revisada em 2026-11-25: o `continue` normal fica no mesmo modelo (preserva o cache). Exceção: falha de cota, rate limit ou capacidade permite trocar o modelo explicitamente, no mesmo JSONL e no mesmo worktree. Papéis somente leitura podem cair sozinhos no próximo modelo da lista do papel. |
| (e) | O que o modelo lê fica em inglês; o que o usuário lê fica em português; a policy ganha "Reply to the user in their language." |
| (f) | `plan` (só `steps`) e `todo` viram duas tools. `todo` é registrada dentro de `plan.ts` com `exposure: "deferred"`, sem mexer na lista de arquivos de `docs/consumer-contract.md:85-97`. |
| (g) | O handoff vale por até 24 h. |
| (h) | Worker recebe `skills: [debug, tdd]`; scout, reviewer, visual e planner recebem `[]`. O `launch` aceita `skills?: string[]` para anexar uma skill pontual. |

---

## 0. Evals fim a fim (`scripts/bench/`), versão mínima primeiro

**Status:** implementado (pontos 1 a 5): `AGENT_BIN`, custo dos filhos pelos registros de job, conjunto `orchestration` com 3 trials e mediana, proveniência no relatório, README e check `bench-dry`. Falta o ponto 6, a linha de base paga (comando e custo estimado em `scripts/bench/README.md`). Ela exige um Agent instalado com `a037391`.

**Hoje**
- `scripts/bench/` já existe e funciona, mas não tem README e ninguém o referencia.
  - `tasks.mjs`: 6 tarefas de código.
  - `checkers.mjs`: verificadores por probe.
  - `run.mjs`: compara arms e tem `--dry` sem inferência.
  - `report.mjs`: calcula `passRate`, `totalCostUsd`, `costPerPassedTaskUsd` e `secondsPerPassedTask`.
- O prefixo das tarefas proíbe delegar (`tasks.mjs:26`), então a suíte não mede orquestração.
- O binário está fixo em `/Users/biel/.local/bin/agent` (`run.mjs:125`).
- O custo dos filhos não entra na conta: `trace.mjs` só soma o JSON do processo pai.
- Já existe um provedor falso reutilizável, `scripts/lib/fake-anthropic.mjs`, com SSE real em loopback.

**Proposta**
1. Trocar o caminho fixo por `AGENT_BIN ?? which agent` e escrever `scripts/bench/README.md`.
2. Somar o custo dos filhos. O pai recebe `usage` por job no resultado do `subagent`, e `jobs.ts` grava `usage` no registro. Incluir isso em `trace.mjs` e `report.mjs`.
3. Criar o conjunto `orchestration` com 4 tarefas que **exigem** delegar:
   - recon em repo grande;
   - dois writers em paralelo;
   - implementação seguida de revisão;
   - correção depois da revisão, que é onde o `continue` do item 2 deve brilhar.
4. Comparar antes e depois por commit instalado, sem flags A/B permanentes. O idioma (item 3), por exemplo, compara a linha de base (`c11f098`, que já é mista) com o commit do item 3. Manter duas versões de texto em todas as tools só para um A/B seria código descartável.
5. Colocar no gate só `node scripts/bench/run.mjs --dry`, que valida que as fixtures falham e as referências passam, sem rede e sem custo. A rodada real fica manual, com `--max-usd`.
6. Rodar a **linha de base** (main atual) antes de começar o item 1 e guardar `report.json` em `docs/research/`.

**Métricas por arm:** pass-rate, wall-clock, US$ total (pai + filhos), requests, tokens do pai, quantidade de chamadas a `subagent`, `skim` e `codemode`.

**Risco:** variância alta com 1 trial. Usar 3 trials nas tarefas `orchestration` e reportar a mediana.

---

## 1. `checks` dentro de worker e reviewer

**Hoje**
- Os filhos não recebem `checks`: o runner só injeta via `-e` cache-keeper, output-cap, cache-prefix, sandbox, web e skim (`subagent/runner.ts:964-1012`).
- O `tools:` do papel vira `--tools` sem filtro (`agents.ts:108`).
- O gate encontra `.pi/checks.json` subindo a partir do `cwd`. Num worktree, a raiz e a baseline (merge-base com `main`) são do próprio worktree (`checks/runner.ts:60-69`).
- A baseline roda num `git worktree add --detach` temporário. Isso escreve em `<repo>/.git/worktrees/` e no cache `~/.claude/tmp/pi-checks`.
- A gravação do cache não é atômica (`checks/runner.ts:252`).
- **Os checks rodam com `spawn(shell:true)` fora de qualquer sandbox** (`checks/runner.ts:104`).
- `integrate` já roda o gate antes do merge (`worktrees.ts:119`). Hoje o worker só descobre a regressão quando o pai integra.
- `writeLastRun` (`checks/runner.ts:351`) é código morto: grava a última rodada e ninguém chama.

**Proposta**
- **Worker:** `checks` completo (`gate`, `run`, `list`).
  - Carregado com `-e checks/index.ts` quando `tools:` do papel inclui `checks`, no mesmo padrão de skim e web.
  - O `cwd` do filho já é o worktree, então nada muda no tool.
  - O resultado do job ganha uma linha `gate: N/M verdes, novas falhas: […]`.
- **Reviewer (somente leitura):** **não executa** checks. Executar checks seria escapar do sandbox, porque o comando vem de `.pi/checks.json`, controlado pelo projeto: é o mesmo problema que tratamos no `shellCommandPrefix`.
  - Ganha só `checks list` e uma ação nova, `checks last`, que lê o resultado da última rodada do worktree. Isso reativa `writeLastRun`.
  - A rodada é gravada com `head` **e** a impressão digital do working tree: hash de `git status --porcelain` mais `git diff HEAD`. Se qualquer um divergir na leitura, `checks last` responde `stale` em vez do resultado.
  - O reviewer passa a citar "o gate do worker em `<sha>` deu X" com evidência, em vez de confiar no relato.
- **Concorrência:**
  - Gravar o cache com tmp+rename.
  - Serializar a baseline por repositório com um lock simples (`.git/pi-checks.lock`, mesmo estilo de `test-store-lock`). Vários workers em paralelo não podem disputar `worktree add`/`prune`.
- **Custo:** o gate completo leva cerca de 90 s, e 4 workers em paralelo dariam 4× isso.
  - Nos filhos, o default é `tags: "fast"`.
  - O gate completo fica com o `integrate`, que já o roda.
- **Antes, corrigir uma divergência:** `docs/setup.md:184` diz que o scout tem `skim`, mas o arquivo do papel não tem.

**Decididas** (ver a tabela no topo)

**Verificação:** estender `test-subagent-dispatch.mjs` para afirmar o `-e checks` só quando `tools:` tem `checks`. Um teste temporário confirma que dois gates em worktrees paralelos não corrompem o cache.

**Tamanho:** pequeno (cerca de 1 dia). **Risco:** baixo.

---

## 2. Subagentes continuáveis + hierarquia codemode / skim / subagent

**Status:** implementado (partes 1 e 2).
- Parte 1: snapshot da invocação por tarefa, handles com estado `running|waiting|closed` num registro por sessão (sem novo status de job), ação `continue`, recusas, `integrate`/`discard` fechando o handle e a hierarquia nas `promptGuidelines`.
- Parte 2: falha classificada pelo erro do provedor (`failure: "quota"` na tarefa e no handle); `model` no `continue` só depois de cota e dentro da allowlist do papel; papel somente leitura troca sozinho uma vez no mesmo JSONL; soft-timeout por extensão no filho (steer, sem stdin); no timeout duro, árvore do filho morta antes do commit `WIP(agent): timeout <jobId>` no worktree do job.
- Provas no `test-subagent-dispatch` com o provider falso: blocos "quota" e "timeout".
- Detalhes em `docs/setup.md` ("Continuar um filho").
- Pendente: a medição no bench ("correção depois da revisão").

**Hoje**
- O filho já roda `--mode json -p … --session <arquivo>` sobre um JSONL criado pelo runner (`runner.ts:975-983`).
- O JSONL nunca é apagado.
- O registro do job guarda `sessionFile`, `cwd`, `worktree`, `model` e `thinking` por task (`jobs.ts:106-130`).
- Não existe ação `continue` nem `reply`: o enum é `launch|status|result|trace|list|cancel|integrate|discard` (`index.ts:230`).
- `resumes`/`MAX_RESUMES` (`jobs.ts:236`) é **recuperação de crash**, não continuação. Usar outro nome para não colidir.
- O Pi abre uma sessão existente por caminho (`dist/main.js:238-241,333+`).
- **Confirmado em 2026-11-25 (passo 0):** `-p` sobre uma sessão não vazia preserva o histórico e acrescenta o turno. Prova com provedor falso: `runSingleAgent` real lançou o filho; o mesmo argv, com o mesmo `--session` e só a mensagem trocada, rodou de novo. O provedor recebeu `[system, user "Task: …", assistant, user novo]`, e as mensagens da 1ª chamada são prefixo exato da 2ª. A mensagem `system` (preâmbulo do papel e `toolsAdded`) é a mesma entrada do JSONL. O arquivo foi de 6 para 8 linhas (user + assistant novos), com um único header.

**Proposta**
- Ação nova: `subagent({ action: "continue", jobId, taskIndex?, message })`.
  - Lança um **job novo**, assíncrono como `launch`, com `continuesFrom: { jobId, taskIndex }`.
  - Reusa o mesmo `sessionFile`, `cwd`/worktree, modelo, thinking, tools, sandbox e system prompt.
  - O prefixo idêntico aproveita o cache de prompt (`child-cache-prefix.ts`).
- O registro do job passa a guardar um **snapshot da invocação**: `model`, `thinking`, `tools`, `sandbox`, `systemPromptSha` e `cwd` efetivo. Se o papel mudou desde então, o `continue` usa o snapshot e avisa.
- **Escritor único sem worktree:** o `continue` captura um `writerCheckpoint` novo, como o `launch` faz (`subagent/index.ts:858`), para o segundo turno continuar coberto pelo `/rewind`.
- **Papel alterado:** o registro guarda o texto do system prompt usado no launch. O `continue` reusa esse texto e avisa se o `.md` do papel mudou desde então, sem trocar o prompt nem quebrar o cache.
- **Recusas:**
  - papel com `runner: agy` (gemini), porque não gera JSONL do Pi; a mensagem manda usar `launch`;
  - a task ainda está rodando;
  - já existe outro `continue` na mesma sessão (lock no JSONL);
  - o worktree já foi integrado ou descartado. A mensagem de erro diz para relançar.
- Hierarquia, escrita uma vez nas `promptGuidelines` do `subagent`, em inglês:

  | Necessidade | Ferramenta |
  |---|---|
  | Uma pergunta sobre uma fonte grande (arquivo, saída, página), sem precisar do texto exato | `skim` |
  | Várias chamadas determinísticas, filtragem, encadear resultados sem julgamento | `codemode` |
  | Julgamento em vários passos ou arquivos, escrita isolada, revisão | `subagent launch` |
  | Ajuste ou pergunta de follow-up para um filho que já tem o contexto | `subagent continue` |

**Decididas** (ver a tabela no topo)

**Ajustes de 2026-11-25 (antes de implementar)**
- **Handle e estado `waiting`.** Cada task ganha um `handle` estável (`<papel>-<n>` ou nome dado no launch). Estados: `queued → running → waiting → running … → done | failed | cancelled`. Em `waiting` o filho terminou o turno, o processo saiu (custo zero), JSONL e worktree continuam vivos; `continue` acorda a task pelo handle (`continue({ handle, message })`, além de `jobId`/`taskIndex`). O worktree só sai com `integrate` ou `discard`.
- **Troca de modelo por cota.** Quando a task falha por cota, rate limit ou capacidade (classificar o erro do provedor, não o texto do modelo), o registro marca `failure: "quota"`. Só nesse caso o `continue` aceita `model` explícito (da allowlist do papel), no mesmo JSONL e no mesmo worktree: perde o cache, mantém contexto e trabalho. Em papéis somente leitura, o runner tenta sozinho o próximo modelo da lista do papel, uma vez, e registra a troca. Em writers a troca nunca é automática.
- **Soft-timeout e commit WIP.** A uma margem do teto (10 % do timeout, mínimo 3 min), o runner injeta no filho: "commit what works and summarize what is left". Se o teto duro chegar, antes de matar o processo o runner faz `WIP(agent): timeout <jobId>` no worktree do job (só se houver mudanças) e grava o hash no resultado; a task fica `waiting`, retomável por `continue`. Escritor único sem worktree não ganha commit: o `/rewind` cobre.

**Verificação:**
- Fake-anthropic: o segundo turno vê o histórico do primeiro.
- Fake-anthropic devolvendo 429: a task fica `failure: "quota"`; `continue` com outro modelo reusa o JSONL; papel somente leitura troca sozinho uma vez.
- Timeout curto num worker de teste com arquivo sujo: o resultado traz o commit WIP e a task fica `waiting`.
- `test-subagent-dispatch` afirma o mesmo argv do launch mais o mesmo `--session`.
- No bench, a tarefa "correção depois da revisão" deve ficar mais barata do que com relaunch.

**Tamanho:** médio (2–3 dias). **Risco:** médio. Concorrência no JSONL e worktree removido são os casos de borda.

---

## 3. Ontologia das tools + idioma do prompt

**Status:** implementado no `main` (merge `5066629`). `plan` aceita só `steps`; `todo` é registrada em `plan.ts` com `exposure: "deferred"` e fica fora do schema declarado. O texto lido pelo modelo está em inglês: descriptions e parâmetros de `ask_user`, `peers_*`, `web_*` e `megamind_*`, a política (com "Reply to the user in their language."), `agent_notes`, as categorias de skills, o slot de peers, os avisos do loop guard, os prompts de `/notes` e `/rules init` e o `description:` dos papéis. O check `tool-language` guarda tudo isso. Bytes medidos por commit com `scripts/test-agent-headless.mjs` (mesmo Pi do store, mesmo provedor falso, `claude-sonnet-4-5`):

| | base `209a8bc` | item 3 |
|---|---|---|
| system prompt, perfil completo | 8176 B | 8153 B |
| system prompt, headless | 6040 B | 6074 B |
| schemas das tools, perfil completo | 17202 B | 16097 B |
| schemas das tools, headless | 12326 B | 12301 B |

Os blocos de mensagem, pedido e resposta de `peers` e `megamind` também estão em inglês, com a orientação de autoridade, o rodapé, a linha de anexos, o aviso de sobreposição de arquivos e as dicas de coordenação. As cercas (`[peers …]`, `[arca-megamind …]`), os ids e a linha `megamind:` não mudam. O peers renderiza pelos `details`, e o parser do Megamind lê os cabeçalhos novos e os antigos em português, então transcritos antigos mostram o mesmo cabeçalho em português na TUI. A orientação ao modelo, que a TUI mostra só expandida, fica em inglês. O `headless` prova no runtime real que o `tool_search` encontra `todo` com uma consulta em linguagem natural e que a chamada executa.

**Antes do item 3**
- `plan` é uma tool só com dois domínios (`plan.ts:236-258`):
  - `steps`: checklist efêmero, guardado como entrada da sessão (`appendEntry('garime-plan')`);
  - ações de task: `.pi/todos/*.md` persistentes, delegadas para `todos.ts:673`, cujo `createTaskTool` não é registrado sozinho.
  - O schema junta os parâmetros dos dois mundos (`plan.ts:43-46`).
- Idioma, por tool:
  - em português: `ask_user`, `checks`, `web_*` e `peers_*`;
  - em inglês: `plan`, `subagent`, `skim`, `jobs`, `generate_image` e `project_overview`.
  - As seções `agent_autonomy`, `agent_skill_categories` e `agent_notes` são injetadas em português (`policy.mjs:4-19`, `skill-categories.mjs:30-33`).
  - O preâmbulo do Pi é em inglês.
- `tool-lexicon.ts` permite sobrescrever descrições via `~/.agent/tools.md`, mas esse arquivo não existe.

**Proposta**
- **Separar** `plan` (só `steps`, efêmero) de `todo` (tasks persistentes, registrando o `createTaskTool` que já existe).
  - Cada schema fica menor e sem campos que se excluem.
  - Só `plan` continua em `alwaysDeclared` (`codemode-mode.ts:10`); `todo` é deferred e o `tool_search` a encontra (decisão f).
- **Regra de idioma:**
  - tudo que o **modelo** lê (description, promptSnippet, promptGuidelines e seções de policy) fica em **inglês**;
  - tudo que o **usuário** lê (UI, notificações e docs) fica em **português**.
  - A política de autonomia ganha uma linha: "Reply to the user in their language."
- **Guarda permanente:** um check `scripts/test-tool-language.mjs` que carrega as extensões com jiti e falha se o texto lido pelo modelo tiver diacríticos do português.
- O `subagent` injeta o `description:` dos arquivos de papel na descrição da tool, então os `description:` de `agent/agents/*.md` também passam para inglês e entram no check.

**Decididas** (ver a tabela no topo)

**Verificação:**
- Bench: comparar pass-rate e tokens do pai entre a linha de base e o commit do item 3, sem flag de idioma (ponto 4 do item 0).
- Medir os bytes do system prompt antes e depois (tabela no status).

**Tamanho:** pequeno a médio. **Risco:** baixo. O ganho de idioma é incerto, e o bench decide se fica.

---

## 4. `handoff.md` sem TTL frágil + skills nos filhos

**Hoje (handoff)**
- O handoff só é injetado se `mtime` tiver menos de **10 min, fixo no código** (`project-prompt.ts:27-32`, travado em `test-agent-compaction.mjs:83-89`).
- Ele só vale no primeiro `before_agent_start` da sessão.
- Fora da janela, é descartado **em silêncio** (`project-prompt.ts:63,67`).
- Nem a skill nem `docs/setup.md` mencionam o TTL.
- O `.agent/handoff.md` atual está velho e não seria injetado.

**Proposta (handoff)**
- A skill escreve só o corpo. O Node carimba o frontmatter (`session`, `created_at`, `branch`, `head`) de forma determinística, num hook de `tool_result` quando o arquivo `.agent/handoff.md` é gravado, e no `/next`. O modelo não sabe o id real da sessão e erra sha e horário.
- Na primeira mensagem do usuário numa sessão nova, o handoff é **injetado** se:
  - não foi consumido;
  - está na mesma branch;
  - o `HEAD` atual é igual a `head` ou descendente dele;
  - tem menos de `AGENT_HANDOFF_MAX_AGE` (default 24 h).
- Num `cwd` sem git, vale só a idade.
- Caso contrário, aparece **uma linha visível**: "Há um handoff de 3 h atrás na branch X; use /handoff para carregar." Nada de descarte silencioso.
- `/next` continua forçando a injeção imediata.
- Documentar em `docs/setup.md` e atualizar `test-agent-compaction`.

**Hoje (skills nos filhos)**
- O Pi anexa o catálogo de skills mesmo com `--system-prompt`, sempre que `read` ou `bash` estão declarados (`dist/core/system-prompt.js:96-107`).
- Os filhos **já recebem** o catálogo, e os testes confirmam (`test-agent-dispatch.mjs:108,209`, `test-agent-child-env.mjs:47`).
- Os comentários dizem o contrário: `runner.ts:961` e `subagent/index.ts:13` estão desatualizados.

**Proposta (skills)**
- Corrigir os comentários.
- Adicionar `skills:` opcional no frontmatter do papel (allowlist; vazio = nenhuma).
  - Scout, reviewer e visual vêm com `skills: []`, para economizar prompt.
  - Worker recebe `debug, tdd`.
- O `launch` aceita `skills?: string[]` por task, para o pai anexar uma skill pontual (por exemplo `ui-ux` ou `computer-use`).
- Medir o tamanho do catálogo por filho antes e depois.

**Decididas** (ver a tabela no topo)

**Verificação:**
- `test-agent-compaction` cobre branch e `HEAD`, idade e aviso.
- `test-agent-dispatch` cobre a allowlist.

**Tamanho:** pequeno. **Risco:** baixo.

---

## 5. Camada Swarm opcional (só desenho; implementar depois do item 2)

**Princípio:** o `launch` simples continua sendo o caminho para tarefas pequenas. O Swarm é opt-in (`swarm: { … }` no launch) e só existe quando 2+ agentes colaboram na mesma meta. Ficam como estão: worktree isolado por writer, `integrate`/`discard` explícitos e sandbox somente leitura.

**Primitivos**
- **Board compartilhado append-only.** `<job>/board.jsonl`, só quando o swarm tem 2+ membros. Cada linha: `{ts, handle, kind: note|claim|done|question|decision, text, refs}`. Os filhos ganham uma tool `board` (`post`, `read since`). O pai lê o board no resultado do job. Sem edição nem remoção. Teto de tamanho por linha e total.
- **Loop reviewer ↔ worker.** `swarm.loop: { writer, reviewer, maxRounds: 3, maxUsd }`. O runner alterna sozinho: o reviewer devolve `approve` ou uma lista de achados, e o worker recebe os achados via `continue`. Para em `approve`, no teto de rodadas ou no teto de custo, e devolve o histórico de rodadas. Não há chat peer-to-peer livre: só esse par e com teto duro.
- **Fork de sessão.** `launch` com `fork: { from: handle }` cria um filho a partir do JSONL de outro (o Pi tem `--fork`). Herda o prefixo e o cache de prompt. Usar só quando o contexto herdado vale mais que um brief novo (ex.: dois writers depois de um recon longo).
- **Watchdog de stall.** Por task: tempo sem novo evento no JSONL, chamadas repetidas (o loop-guard já detecta ciclos) e custo sem progresso (sem commit nem arquivo alterado). Primeiro avisa o filho; na segunda vez, marca `stalled`, faz o commit WIP e libera a vaga.

**Fora do escopo:** agentes conversando livremente entre si, eleição de líder, memória global entre jobs.

**Verificação:** tarefas de swarm no bench (`orchestration`) comparando launch simples, loop e fork em custo e taxa de acerto.

**Tamanho:** médio a grande, em partes (board → loop → watchdog → fork). **Risco:** médio.

---

## Resumo

| # | Movimento | Tamanho | Risco | Depende de |
|---|---|---|---|---|
| 0 | Bench mínimo + linha de base | pequeno | baixo | — |
| 1 | `checks` no worker; `checks last` no reviewer | pequeno | baixo | 0 |
| 2 | `subagent continue` + hierarquia | médio | médio | 0, 1 |
| 3 | `plan`/`todo` + inglês para o modelo | pequeno–médio | baixo | 0 |
| 4 | Handoff por branch/HEAD + `skills:` por papel | pequeno | baixo | — |
| H | Hotfix: sessão viva presa ao próprio build (Pi + extensões) | pequeno–médio | médio | — |
| 5 | Swarm opcional: board, loop reviewer↔worker, fork, watchdog | médio–grande | médio | 2 |

Todos os itens seguem a regra do repo: nenhum teste permanente fora do gate. As guardas novas entram como `scripts/test-*.mjs` em `.pi/checks.json`.
