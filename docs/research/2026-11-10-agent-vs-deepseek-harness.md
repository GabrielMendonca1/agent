# Agent vs DeepSeek Harness — arquitetura comparada

Data: 2026-11-10. Escopo: arquitetura distribuída por este repositório (Agent) e documentação/árvore pública do DeepSeek Harness (dsh). Não houve execução do dsh, benchmark nem auditoria de segurança.

Marcadores usados em cada alegação:

- **[código]**: lido no código-fonte ou na árvore do repositório;
- **[doc]**: afirmado em documentação oficial, sem conferir a implementação;
- **[inferência]**: conclusão deste documento.

## Resumo

- Agent é o Pi oficial 1.5.0 clássico com 10 patches e extensões próprias; o loop, as sessões JSONL e o modelo de extensão são do Pi **[código]**. dsh é um harness TypeScript sobre Cordis em que loop, sessão, adapter de modelo e registro de tools são plugins substituíveis por configuração **[doc]**.
- Ambos têm extensões, hooks, log de sessão, subagentes, execução programática de tools e sandbox de processos. A diferença está em **quanto do núcleo pode ser substituído e quão formal é o contrato**: no Agent, o núcleo do Pi é modificado por patch e estendido por `ExtensionAPI`; no dsh, cada capacidade é um seam (definição, provider, consumidor) e o produto é uma composição de bundles **[doc + inferência]**.
- dsh se declara *developer preview* com mudanças incompatíveis, sem auditoria de segurança e não pronto para produção **[doc]**. Não identificamos, nas fontes consultadas, resultados de qualidade de agente comparáveis ao Agent; `BENCHMARK.md` fornece instruções de execução, não esse comparativo **[doc]**.
- Recomendação: manter o Agent como runtime operacional; importar ideias de contrato (seams de capacidade, regra "o que o modelo vê está no log", fatos de enforcement do sandbox); experimentar dsh como backend isolado antes de qualquer decisão de migração; comparar só com benchmark controlado (mesmo modelo, tarefa e orçamento).

## Fontes e versões

| Lado | Referência fixa | Observação |
|---|---|---|
| Agent | repositório local, `HEAD f65f904aae6b7236af6ddf32885c6c2a23d3e150` (2026-11-09) | checkout limpo antes deste arquivo |
| Pi base do Agent | `@earendil-works/pi-coding-agent` v1.5.0, `f9a26365568127461c47a07a37dcb42c140a3ac5` ([manifest](../../overlay/manifest.json)) | versão declarada; não prova o binário de uma instalação |
| dsh | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `master` em `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (2026-11-04) | links abaixo fixados nesse commit |

Base de URL do dsh usada abaixo: `https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/`.

Instalações locais observadas, que não são o objeto da comparação: `~/.local/share/agent/current` aponta para `releases/1.5.0-f9a2636556-a1fe83215f-8026a6708f`; `~/.local/share/pi-overlay/current` aponta para `releases/1.5.1-dd30101cfc-…` e pertence à instalação Mark, não a este repositório.

`deepseek-ai/dsh-superagent-prototype` é outro repositório: um agente proativo que roda sobre o dsh e se declara protótipo de pesquisa, não produto oficial ([README](https://github.com/deepseek-ai/dsh-superagent-prototype)) **[doc]**. Ele não entra na comparação.

## Agent em camadas

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Consumidores externos (Superagent)                                    │
│   contrato por caminho: runtime/config.json, releases/<id>/agent,     │
│   extensões de worker obrigatórias, tools checks/plan/subagent/jobs   │
├───────────────────────────────────────────────────────────────────────┤
│ Distribuição: scripts/agent-update.mjs → aplica patches, confere      │
│   sha256, constrói, testa, promove release; launcher; runtime opt-in  │
├───────────────────────────────────────────────────────────────────────┤
│ Políticas e dados: agent/agents (papéis), skills/, agent/skills,      │
│   temas; perfil do usuário fora do repo (~/.agent)                    │
├───────────────────────────────────────────────────────────────────────┤
│ Extensões: brain-live (modo simple/complex, subagent, jobs, checks,   │
│   plan, compaction, sessions, bash-sandbox, cache-keeper…),           │
│   agent (tui, web, accounts, peers), megamind                         │
├───────────────────────────────────────────────────────────────────────┤
│ agent-patches/: 3 patches sobre a árvore agent/                       │
├───────────────────────────────────────────────────────────────────────┤
│ overlay/: 10 patches no Pi (provider, TUI, contas, recap, codemode    │
│   typed results/background, tool-load-append, nomes CC)               │
├───────────────────────────────────────────────────────────────────────┤
│ Pi 1.5.0 clássico: loop, providers, tools nativas, codemode,          │
│   ExtensionAPI, sessões JSONL (/resume, --session)                    │
└───────────────────────────────────────────────────────────────────────┘
```

Evidências:

- Base, patches e camadas de diretório: [README.md](../../README.md), [overlay/README.md](../../overlay/README.md), [overlay/manifest.json](../../overlay/manifest.json) (cada patch tem `sha256` e testes upstream associados) **[código]**.
- Modos: `simple` bloqueia `subagent` na chamada, `complex` libera; a lista de tools ativa não muda e inclui `subagent`, `codemode` e `tool_search` quando registradas ([juice.ts:69-83](../../agent/extensions/brain-live/juice.ts)). Os hooks só existem com o runtime opt-in ligado (`if (!juiceEnabled()) return;`, [juice.ts:89-91](../../agent/extensions/brain-live/juice.ts)) **[código]**.
- Codemode: tool nativa do Pi; o overlay acrescenta resultados tipados de read/grep/find, execução em background com saída parcial e cancelamento, e anexação de tools carregadas no meio da sessão sem reescrever o system prompt ([overlay/README.md](../../overlay/README.md), itens 7-9) **[código]**.
- Subagentes: chamada assíncrona devolve `jobId`; o resultado volta como mensagem à sessão de origem ([subagent/index.ts:3-14](../../agent/extensions/brain-live/subagent/index.ts)). O filho é `pi --mode json -p --no-extensions` com sessão JSONL ligada por `parentSession`; `--no-skills` só fora do runtime Juice; extensões web/cache/sandbox são adicionadas explicitamente ([subagent/runner.ts:764-805](../../agent/extensions/brain-live/subagent/runner.ts)) **[código]**.
- Sessões: JSONL clássico é a fonte de retomada; sessões SQLite antigas são listadas só para leitura ([sessions.ts:1-5](../../agent/extensions/brain-live/sessions.ts)); importação opcional por script ([docs/setup.md](../../docs/setup.md), linha 23); poda só por `/gc` explícito ([agent-patches/03-sessions-explicit-gc-only.patch](../../agent-patches/03-sessions-explicit-gc-only.patch)) **[código]**.
- Sandbox: [bash-sandbox.ts:8-11](../../agent/extensions/brain-live/bash-sandbox.ts) só registra o Bash confinado com `AGENT_BASH_SANDBOX=seatbelt|bwrap` e `AGENT_SANDBOX_CWD`. O despachante de subagentes liga isso automaticamente apenas para papéis cujas tools não incluem `edit`/`write`, quando a plataforma oferece `sandbox-exec` ou `bwrap` ([runner.ts:251-262](../../agent/extensions/brain-live/subagent/runner.ts)). O perfil Seatbelt nega escrita fora de temporários, caches e `<cwd>/.pi`, e bloqueia `<cwd>/.git` ([sandbox/readonly.sb](../../agent/extensions/brain-live/sandbox/readonly.sb)). Esse despachante não aplica o confinamento a papéis com edição; não demonstra confinamento da sessão principal, que depende da configuração e do ambiente **[código]**.
- Contrato externo: [docs/consumer-contract.md](../../docs/consumer-contract.md) fixa raízes, `config.json` (`enabled`, `artifactId`), sete extensões de worker obrigatórias e as tools `checks`, `plan`, `subagent`, `jobs` **[código]**.
- Verificação permanente: `.pi/checks.json` com 42 checks em `scripts/test-*.mjs` ([AGENTS.md](../../AGENTS.md), [.pi/checks.json](../../.pi/checks.json)) **[código]**.

## dsh em camadas

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Aplicações: Web UI, Electron (desktop-host), CLI headless,            │
│   SDK TypeScript, SDK Python (wheel com o CLI), servidor ACP          │
├───────────────────────────────────────────────────────────────────────┤
│ Perfis: web | headless | sdk | sdk-minimal | acp                      │
│   = bundles ordenados + cordis.patch.yml + patch do home + --patch    │
├───────────────────────────────────────────────────────────────────────┤
│ Bundles: dsh-base (adapters, tools, persistência, sandbox, aprovação, │
│   settings, credenciais, telemetria) + app (web/headless/sdk/acp)     │
├───────────────────────────────────────────────────────────────────────┤
│ Seams de capacidade (definição / provider / consumidor):              │
│   fs, subprocess, sandbox, shell, terminals, jobs, ptcRuntime,        │
│   subagents (spawn, fork, Codex, Claude Code, ACP, DSH SDK), approval │
├───────────────────────────────────────────────────────────────────────┤
│ Núcleo como plugins: session (log append-only), system-prompt,        │
│   tools (pipeline pre/execute/post), agent + agent-loop, llm adapter  │
├───────────────────────────────────────────────────────────────────────┤
│ Cordis: serviços, eventos tipados, efeitos reversíveis no unload      │
└───────────────────────────────────────────────────────────────────────┘
```

Evidências (todas **[doc]**, salvo indicação):

- Tudo é plugin, inclusive adapter, registro de tools, log de sessão e loop; "não há núcleo privilegiado para patchear" ([docs/architecture.md:7-11](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#cordis)).
- Perfis e bundles, ordem de camadas, `dsh --profile web --dump-config` para ver a árvore ([architecture.md:13-39](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#profiles-and-bundles)); SDK Python lança `dsh --profile sdk` (linha 47); Electron empacota o runtime (linhas 49-53).
- Turno e passo: eventos `turn/*`, `step/*`, `*/message`, `tool/*` registrados no log lógico da sessão (durabilidade depende do backend e de flush); pipeline `tools/pre-execute → execute → post-execute` ([architecture.md:81-122](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#turn-flow)).
- Log de sessão: `deriveMessages()` projeta o histórico; tentativas falhas ficam em `assistant/attempt` sem entrar no histórico do modelo; formato JSONL versionado com migrações adjacentes; regra "Model-visible means logged": toda requisição ao modelo deve ser reconstruível do log ([architecture.md:124-132](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#session-log)).
- Seams e tabela "onde entra comportamento novo" ([architecture.md:136-169](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#capability-seams); [docs/capability-seams.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/capability-seams.md)).
- Subagentes: API de ativação única; providers `spawn` e `fork` criam agentes locais continuáveis; Codex, Claude Code, ACP e DSH SDK contribuem uma execução externa; capacidades declaradas (`agentPreset`, `outputSchema`, `depthLimit`); entrega ao pai ou ao chamador; catálogo durável no log do pai ([docs/subsystems/subagent.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/subagent.md), seções "Capabilities" e "The provider contract"). Agent Teams é opcional por sessão raiz ([agent-team.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/agent-team.md)).
- Execução programática: PTC (ex-"code mode", renomeado em nota de 2026-08-25 na árvore **[código]**) é um seam opcional `ctx.ptcRuntime` com retornos tipados e provider Node em sandbox ([ptc-runtime.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/ptc-runtime.md)).
- Sandbox: modos `read-only`, `workspace-write`, `danger-full-access`; backends bwrap/Landlock, Seatbelt, token restrito no Windows e SSH; o backend reporta enforcement `full` ou `partial`; rede e visibilidade de processos ficam fora do vocabulário ([sandbox.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/sandbox.md)). Aprovação com política `ask`/`never` por sessão, eventos de auditoria e falha fechada fora de `allowed-once` ([approval.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/approval.md)).
- Status: preview sem auditoria, não tratar como seguro nem pronto para produção; recomenda VM ou container descartável ([SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/SAFETY.md)). [BENCHMARK.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/BENCHMARK.md) só indica usar o SDK Python e a variante mínima; `benchmarks/` contém medições de infraestrutura (abertura de sessão, terminal, stream) **[código]**, não resultados de qualidade de agente.

## Matriz

| Dimensão | Agent | dsh | Natureza da diferença |
|---|---|---|---|
| Núcleo | Loop do Pi; runtime customizado por 10 patches versionados | Loop é plugin substituível (`ctx.agentLoop`) | grau de substituição |
| Extensão | `ExtensionAPI` do Pi: tools, hooks (`session_start`, `before_provider_request`…), comandos | plugins Cordis com efeitos reversíveis; eventos waterfall com `next()` | formalidade do contrato |
| Composição | uma release; extensões registradas em `settings.extensions`; runtime opt-in | perfis = bundles + patches YAML por linha de config | granularidade |
| Superfícies | TUI de terminal; `pi -p` JSON para filhos e SDK | Web, Electron, headless, SDK TS/Python, ACP | escopo de produto |
| Sessão | JSONL do Pi com `parentSession`; SQLite legado só leitura | log append-only de eventos, projeções, formato versionado com migrações | regra explícita de reconstrução |
| Tools programáticas | `codemode` nativo + patches typed results/background | PTC como seam opcional com retornos tipados | ambos têm; implementação difere |
| Subagentes | processo `pi -p` assíncrono, papéis por frontmatter, `jobId` | providers locais e externos atrás de uma interface, catálogo durável | número de backends e contrato |
| Sandbox | opt-in por env; automático para papéis sem edição quando disponível | seam com modos e enforcement reportado; política depende do perfil | abrangência dos contratos, não isolamento universal |
| Aprovação | não há seam equivalente no código lido | `ctx.approval` com auditoria | presença de seam dedicado (Agent pode ter outros controles fora do lido) |
| Contrato externo | doc de caminhos e tools para o Superagent | SDK e ACP versionados com o CLI | caminho no disco vs protocolo |
| Verificação | 42 checks no portão + testes upstream por patch | testes no monorepo, benchmarks de infraestrutura | não comparável sem execução |
| Maturidade | uso diário pessoal (ARCA, Omni) | preview, sem auditoria, quebras anunciadas | risco operacional |

## Tradeoffs

**Patch sobre Pi (Agent).** Reaproveita o runtime upstream; o custo de manutenção não foi medido: o updater aplica patches com `git apply --3way`, confere hash e roda os testes associados ([overlay/README.md](../../overlay/README.md)). O limite é que mudanças no loop ou no formato de sessão exigem patch, e cada port carrega risco de drift **[código + inferência]**. Os contratos internos ficam espalhados entre patches, extensões e o doc do consumidor **[inferência]**.

**Composição por seams (dsh).** Trocar um provider (fs, subprocess, sandbox) muda Bash, PTY e LSP juntos, segundo a documentação **[doc]**. O custo é superfície grande (dezenas de pacotes em `packages/`) e API em fluxo durante o preview **[código + doc]**. Adotar o dsh como runtime significaria reescrever extensões do Agent como plugins Cordis; não há camada de compatibilidade com a `ExtensionAPI` do Pi na documentação lida **[inferência]**.

**Auditabilidade.** O Pi já grava a sessão em JSONL e o Agent tem hooks de request (o cache-keeper observa `before_provider_request`, [cache-keeper.ts](../../agent/extensions/brain-live/cache-keeper.ts)) **[código]**. O dsh transforma isso em regra de arquitetura: entrada nova visível ao modelo exige evento de sessão **[doc]**. Exemplo no Agent: injeções de política por modo e notas de projeto entram no system prompt por extensão; não foi verificado se toda requisição é reconstruível só pelo JSONL **[inferência; não verificado]**.

**Segurança.** O dsh tem vocabulário mais completo (modos, enforcement parcial reportado, aprovação auditada), mas declara não ter auditoria **[doc]**. O Agent confina apenas subagentes de leitura e sessões com opt-in explícito **[código]**. Nenhum dos dois controla rede pelo sandbox de arquivos (no dsh, rede está fora do vocabulário; no perfil Seatbelt do Agent, `allow default` deixa rede liberada) **[doc + código]**. Não há base para dizer qual é mais seguro na prática.

**Velocidade, custo, qualidade de código.** Sem dados. Nenhuma alegação deste documento cobre esses eixos.

## Verificação crítica do código dsh

A revisão estática confirmou mecanismos, não garantias irrestritas:

- **Loop substituível [código]:** `AgentLoop extends Service implements AgentFactory` registra-se com `ctx.agents.setFactory(this)`. Há uma separação concreta entre fábrica e driver; trocar o driver ainda exige respeitar os contratos e o teardown. [agent-loop/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/index.ts).
- **Contexto lógico rastreável [código]:** o driver registra mensagens e headers e usa `session.deriveMessages()` antes do streaming. Isso não prova identidade byte a byte com o HTTP emitido pelo adapter nem cumprimento por plugins substitutos. [agent-loop/src/agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts).
- **Append-only não é flush síncrono [código]:** `Session.append()` congela eventos; emissão a observadores e `session/flush` são mecanismos distintos. O loop admite ausência de backend de persistência e grava o stream ao encerrar a tentativa, não cada chunk. Não prometer recuperação integral após crash. [session/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts).
- **Plugin não é sandbox [código + inferência]:** o boot importa módulos e o registro delega execução ao executor selecionado. Escopos Cordis e filtros de tools não confinam código hostil carregado no host. O sandbox de Bash depende de consumidor, backend e política; `danger-full-access` não confina. [app-boot](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/src/index.ts), [tools](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/index.ts), [bash-sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/shell/bash-sandbox/src/index.ts).
- **PTC não é vantagem exclusiva nem economia garantida [doc]:** `run_code` expõe SDK gerado de tools, serializa programas raiz e permite subchamadas seguras paralelas. Valores intermediários permanecem locais à execução, não são reconstruíveis pelo replay e efeitos concluídos não são desfeitos pelo cancelamento. O custo do SDK depende das definições visíveis. [tool-executor-ptc/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tool-executor-ptc/README.md).

## Prioridades

1. **Manter o Agent como runtime operacional.** Ele atende ao contrato do Superagent e ao uso diário; o dsh não oferece garantia de estabilidade **[doc]**.
2. **Formalizar contratos internos, sem migrar.** Escrever, ao lado de `docs/consumer-contract.md`, a lista de capacidades com definição, implementação e consumidor (sandbox, subagente, jobs, sessão), no estilo dos seams do dsh. Sem código novo nesta etapa.
3. **Projeção auditável.** Verificar se cada requisição ao modelo pode ser reconstruída do JSONL mais o estado das extensões; onde não puder, decidir se a injeção deve virar entrada de sessão. Começar pelas injeções do modo `simple`/`complex` e pelo `tool-load-append`.
4. **Sandbox com fatos explícitos.** O runner já carrega `sandbox` no resultado ([runner.ts](../../agent/extensions/brain-live/subagent/runner.ts)), e o pai recebe `Sandbox: <modo>` na resposta de despacho e nos resultados ([index.ts:949-950](../../agent/extensions/brain-live/subagent/index.ts), [jobs.ts:657-709](../../agent/extensions/brain-live/subagent/jobs.ts)). Avaliar formalizar, além do nome do backend, os limites realmente aplicados e a degradação para `none`, sem apresentar detecção como isolamento garantido.
5. **Experimento isolado com dsh.** Rodar `dsh --profile headless` ou `sdk-minimal` em VM ou container descartável, sem credenciais pessoais, como backend separado (por exemplo, mediante um novo adapter de subagente externo; compatibilidade ACP direta com o Agent não foi demonstrada). Não substituir nada antes do resultado.
6. **Benchmark controlado antes de qualquer decisão de migração.** Mesmo modelo e thinking, mesmo conjunto de tarefas com checkout fixo, mesmo orçamento de tokens e tempo, sandbox equivalente, sessões e workspaces separados por tarefa (como pede o BENCHMARK.md do dsh). Medir taxa de sucesso por checks, tokens, custo e tempo. Não executado neste trabalho.

## Evidências e limitações

- Lado Agent: código e docs do checkout em `f65f904`. Não foram inspecionados o perfil `~/.agent`, credenciais, o ambiente de processo nem o binário ativo; modo, modelo e sandbox efetivos de uma instalação não estão provados aqui.
- Portão de checks rodado pelo orquestrador desta pesquisa no mesmo checkout: 39 de 42 verdes, sem regressão em relação ao `HEAD`; as falhas são herdadas (`overlay-prepare-promote`, `juice-panel`, `agent-runtime`). Este documento não altera código.
- Lado dsh: README, SAFETY, BENCHMARK, arquitetura e subsistemas citados, no commit `fcc0ad4`, mais inspeção estática pontual do código de agent-loop, session, tools, app-boot e bash-sandbox. Não houve instalação nem execução do dsh. A revisão estática não constitui auditoria de segurança.
- Não verificado no dsh: defaults efetivos de sandbox e aprovação no perfil `web`, cache de prompt dos providers, comportamento das tools de edição.
- O dsh está em preview com quebras anunciadas; os links fixados em `fcc0ad4` podem divergir do `master` atual.
