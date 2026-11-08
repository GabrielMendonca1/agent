# checks

Portão de verificação por projeto: responde, em segundos, **o que esta mudança quebrou** — não "os
testes passam".

## Por que existe

Worktree isola escrita. Ele não protege comportamento: dois agentes podem terminar verdes
isoladamente e quebrar um ao outro no merge. E sem um veredito atribuível, o vermelho herdado vira
paisagem, todo mundo passa a ignorar, e a suíte morre.

Evidência que motivou: a suíte do brain existia mas **ninguém rodava inteira** — o `brain-check` só
valida frontmatter e faz parse das extensions. Na primeira execução com um comando só, o
`vault-runtime` estava vermelho fazia tempo, invisível, porque o comando declarado usava `bun run` num
teste que exige `bun test`.

## Manifesto

`.pi/checks.json` na raiz do projeto — é ele que define a raiz, não um marcador de VCS.

```json
{
  "defaultTimeoutMs": 420000,
  "parallel": 4,
  "link": [],
  "checks": [
    { "name": "estrutura", "cmd": "bin/brain-check", "tags": ["fast"] },
    { "name": "vault-runtime", "cmd": "bun run test/vault_runtime.test.ts", "tags": ["fast"] }
  ]
}
```

`name` é obrigatório e único: é o que torna a falha atribuível ("quebrou `vault-runtime`", não
"quebrou alguma coisa"). `link` espelha caminhos do checkout real dentro do worktree da baseline
(`node_modules`, `.venv`) para projetos que precisam deles.

## Baseline

O veredito compara contra o **commit base**: em branch de trabalho, o `merge-base` com o tronco;
no tronco, o próprio `HEAD`. Se tudo está verde, o gate dispensa a baseline. Caso contrário,
consulta somente os checks que falharam, separando `newFailures` de `stillFailing`.

O cache v2 em `~/.claude/tmp/pi-checks/` guarda resultados por sha e por check, com fingerprint
do comando e timeout efetivo. Seleções parciais são mescladas; comandos alterados rodam de novo.
Somente entradas ausentes ou inválidas rodam num worktree efêmero (nenhum worktree em cache hit).
A cada escrita, arquivos com mais de 14 dias são removidos, em todos os projetos, sem bloquear o
veredito em caso de erro. `PI_CHECKS_CACHE_DIR` sobrescreve o diretório de cache.
Como o gate consulta apenas falhas atuais, ele não enumera correções (`fixed`) da baseline.

## Superfícies

| onde | como |
|---|---|
| agente | tool `checks {action:"gate"\|"run"\|"baseline"\|"list", tags?, only?, cwd?}` |
| operador | `/checks [gate\|run\|list] [tags]` |
| shell, hook e portão de merge | `bin/pi-checks gate [--tags fast] [--cwd DIR] [--json]` |

`bin/pi-checks` sai `0` quando nada novo quebrou, `1` quando há regressão e `2` em erro de
uso/config — é esse contrato que o `hooks.onStepEnd` do omni e o portão de merge consomem.

Sempre passe `cwd` do worktree ao verificar trabalho de um agente: o veredito é sobre aquele
checkout, não sobre o seu.

## Portão de merge (`bin/pi-merge`)

Verde no worktree isolado **não prova nada**: dois agentes podem terminar verdes sozinhos e quebrar
um ao outro ao juntar, porque cada um mexeu numa metade de um invariante que ninguém sozinho violou.

```
pi-merge <branch|worktree> [--repo DIR] [--trunk main] [--tags fast] [--integrate]
```

Monta a junção num worktree efêmero do tronco, roda os checks **nesse resultado** e compara com a
baseline do tronco. Só integra depois de verde, e por padrão só opina — `--integrate` é explícito.

- conflito textual: reportado com os arquivos nomeados, `merge --abort`, tronco intocado;
- regressão de comportamento: bloqueia dizendo o que quebrou, deixando claro que cada lado podia
  estar verde sozinho;
- integração: `merge --ff-only` no worktree do tronco quando ele está checkado e limpo; se o tronco
  não estiver em lugar nenhum, move a ref por compare-and-swap, que falha se alguém avançou o tronco
  durante a verificação;
- tronco sujo: recusa (exit 2) em vez de integrar por trás de trabalho não commitado;
- um lock por repo (`.git/pi-merge.lock`, com detecção de dono morto) serializa integrações
  concorrentes — a corrida entre dois agentes é justamente o que o portão existe para evitar.

## O caminho fácil é o caminho verificado

Ferramenta que depende de lembrança não é usada. Por isso o portão está plugado no `brain-commit`:

- **commit direto na `main` é recusado** — trabalho novo entra por branch e integra por
  `bin/pi-merge <branch> --integrate`, que verifica a junção. Emergência: `--force-main`;
- antes de criar o commit (não depois), roda `pi-checks gate --tags fast`; regressão nova aborta com
  as mudanças intactas no worktree. Vermelho legítimo passa com `--no-checks`, que é uma decisão
  explícita e visível no histórico do terminal.

O gate roda antes do commit de propósito: melhor não criar o commit ruim do que revertê-lo depois.
