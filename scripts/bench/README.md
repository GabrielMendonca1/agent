# Bench de tarefas (`scripts/bench/`)

Mede o Agent instalado de ponta a ponta em tarefas de código com verificador confiável: taxa de acerto, tempo de parede e US$ total (pai + subagentes). Cada execução roda `agent -p --mode json` num repositório-fixture descartável e verifica o resultado com asserções que ficam fora da fixture.

## Conjuntos de tarefas

`--tasks` aceita ids e nomes de conjunto, separados por vírgula. Sem `--tasks`, ou com `--tasks all`, entram os dois conjuntos.

| Conjunto | Tarefas | Trials por padrão | O que mede |
|---|---|---:|---|
| `solo` | `invoice`, `topic-search`, `rename`, `config-docs`, `records`, `long-command` | 1 | agente sozinho; o prompt proíbe delegar |
| `orchestration` | `recon`, `parallel-writers`, `implement-review`, `review-fix` | 3 | delegação a subagentes; o relatório usa a mediana |

Tarefas de `orchestration`:

- `recon`: cerca de 480 módulos em `src/`. Um `scout` descobre quem chama `legacyCharge`, inclusive por alias e por re-export, e ignora as armadilhas: import sem chamada, comentário, string e função local homônima. Verificação: `answer.json` exato.
- `parallel-writers`: duas mudanças independentes (`slugify`, `parseDuration`) feitas por dois `worker`s em paralelo.
- `implement-review`: um `worker` implementa `paginate` segundo `SPEC.md`, e um `reviewer` revisa depois. A spec tem um requisito plantado na seção "Compatibility" (`options.size`), que o verificador cobra.
- `review-fix`: ciclo `worker` → `reviewer` → `worker` sobre o mesmo trabalho (parser CSV). Hoje o follow-up é um novo `launch`; quando houver `continue` (item 2 da spec), deve ser o mesmo filho.

Uma tarefa de `orchestration` só passa se o verificador passar **e** os registros de job mostrarem o padrão de delegação exigido: `scout`, dois `worker`s em paralelo (job `parallel` ou jobs sobrepostos no tempo), `worker`→`reviewer`, ou `worker`→`reviewer`→`worker`. Se o item 2 registrar o `continue` sem criar uma nova tarefa no registro, o predicado `delegation` de `review-fix` em `orchestration.mjs` precisa acompanhar essa mudança.

`--trials N` vale para todas as tarefas e substitui os padrões.

## Verificação sem custo (`--dry`)

```sh
node scripts/bench/run.mjs --dry --tasks all
```

Para cada tarefa, monta a fixture, confirma que ela **falha** no verificador, aplica a referência e confirma que a referência **passa**. Nas tarefas de `orchestration`, também confirma que o predicado de delegação rejeita uma execução sem jobs. Não usa rede nem modelo. Leva cerca de 25 s, dos quais 20 s são o `batch.mjs` de `long-command`. Roda no portão como check `bench-dry`.

## Execução real

Pré-requisitos:

- `agent` no `PATH`, ou `AGENT_BIN=/caminho/do/agent`. Sem binário, o bench para com erro.
- O Agent instalado precisa conter `a037391` (`agent -p` espera os jobs de subagente em segundo plano). Sem esse commit, o pai sai antes dos filhos e as tarefas de `orchestration` falham.
- Credenciais do modelo no perfil (`PI_CODING_AGENT_DIR`, padrão `~/.agent`, o mesmo do launcher).

O ambiente do processo medido é limpo de variáveis de sessão herdadas (`AGENT_NO_DELEGATE`, `AGENT_CHILD`, `NODE_OPTIONS`, `PI_SESSION_*` e similares; lista em `run.mjs`). Assim, o bench também funciona quando é disparado de dentro de uma sessão do Agent.

Smoke barato, uma execução:

```sh
node scripts/bench/run.mjs --tasks recon --modes on --trials 1 --models anthropic/claude-haiku-5-5 --max-usd 1 --out ~/bench/smoke
```

Linha de base completa, com o modelo padrão (`anthropic/claude-opus-5-5`), arms `on` e `only`, 12 execuções solo e 24 de orquestração:

```sh
node scripts/bench/run.mjs --tasks all --max-usd 60 --out ~/bench/baseline-$(git rev-parse --short HEAD)
```

Opções: `--models a,b`, `--modes on,only` (vai para `AGENT_CODEMODE_MODE`), `--trials N`, `--tasks …`, `--out dir` (precisa estar vazio), `--concurrency K` (padrão 2), `--max-usd X` (padrão 5, teto suave).

### Custo estimado da linha de base

**US$ 30, numa faixa de US$ 20 a 50.** Por isso o comando acima usa `--max-usd 60`. Tempo estimado: 1 a 2,5 h com concorrência 2.

Como a estimativa foi feita (sem probe pago; o `--max-usd` protege de erro na estimativa):

- Preço de lista do `claude-opus-5-5` no Pi instalado: US$ 4 por Mtok de input, 20 de output, 0,20 de cache read e 5 de cache write. Nas sessões reais deste perfil, uma requisição Opus 5.5 custa US$ 0,05 na mediana. Com o contexto curto das fixtures, usei US$ 0,04.
- Pai, solo: 12 execuções × ~12 requisições × US$ 0,04 ≈ US$ 6.
- Pai, orquestração: 24 execuções × ~15 requisições (lançar, receber, integrar, verificar) × US$ 0,04 ≈ US$ 14.
- Filhos: usam os modelos de papel do perfil (`roleModels`), não `--models`. Pelas medianas dos registros de job do perfil, um `scout` em Haiku 5.5 custa ~US$ 0,02 e um `worker` em gpt-6.2-sol ~US$ 0,43, mas as tarefas do bench são menores. Por rodada das 4 tarefas, contei ~US$ 0,05 (scout) + 0,50 (2 workers) + 0,55 (worker + reviewer) + 0,80 (worker + reviewer + worker) ≈ US$ 1,9. Com 6 rodadas (3 trials × 2 modos), dá ≈ US$ 11.
- Papéis que rodam por `agy` (por exemplo, o `reviewer` em Gemini) podem não informar custo. Nesse caso, o total dos filhos é um piso.

## Saídas

Tudo fica em `--out` (modo 0700):

- `report.md`: tabela por arm (aprovadas, US$ total/pai/filhos, mediana de segundos, custo e segundos por tarefa aprovada, requisições, chamadas a `subagent`/`skim`/`codemode`, jobs/tarefas filhas), tabela por tarefa com medianas, tabela por execução e trechos de falha.
- `report.json`: os mesmos dados. Por execução, inclui `parentCostUsd`, `children` (custo, tokens, papéis, `complete`), `childJobs` sanitizados e `delegation` (motivo da reprovação de delegação, ou `null`). Também registra `config.provenance`, com `artifactId` (de `<store>/runtime/config.json`), `installedSourceCommit` (de `<store>/active.json`), `benchCommit`/`benchDirty` deste checkout e o binário usado.
- `traces/*.jsonl`: eventos do pai, redigidos. `sessions/`: sessões do pai. `fixtures/`: só as fixtures das execuções que falharam.

Atribuição do custo dos filhos: a primeira linha de `--mode json` (`type: session`) dá o id da sessão do pai. Por isso o bench usa `--session-dir <out>/sessions`, nunca `--no-session`. Os registros em `$PI_CODING_AGENT_DIR/subagent-jobs/<sessionId>/*.json` trazem `usage.cost` por tarefa. O bench lê esses registros a cada 5 s e no fim, e copia só o papel, o modelo, o estado, o uso e os horários. Não copia texto de tarefa, resultado, caminhos, credenciais nem nada mais do perfil. Um `+` no relatório marca um total com filho sem custo registrado (morto, interrompido ou ainda rodando): o valor é um piso.

## Comparar dois commits

Não há flags A/B: compara-se o Agent **instalado** em cada commit.

1. No checkout do commit A: `git checkout <A> && node scripts/agent-update.mjs` (constrói e ativa; ver docs/setup.md).
2. `node scripts/bench/run.mjs --tasks all --max-usd 60 --out ~/bench/A`
3. Repita com o commit B e `--out ~/bench/B`.
4. Compare `report.md` e `report.json`. Confira se `config.taskVersion` é igual nos dois e se `config.provenance.installedSourceCommit` é o commit esperado. Uma diferença de taxa de acerto em 1 trial não basta como evidência. Use a mediana dos 3 trials de `orchestration`.

O bench sempre roda a partir do checkout atual (as tarefas e os verificadores vêm de `benchCommit`). Use a mesma versão do bench nas duas medições. Mudar prompt, fixture, referência ou verificador exige incrementar `version` em `tasks.mjs`.

Guarde o `report.json` da linha de base em `docs/research/` (spec, item 0.6). Traces, sessões e fixtures ficam locais.
