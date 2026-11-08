# project-operator

Extensão global do Pi que mantém um **painel operacional passivo** do projeto da sessão atual:
estado do git, sessões Claude/Pi e runtimes cujo `cwd` está dentro do projeto, metadados de
transcripts recentes e um log de intervenções registradas manualmente.

É auto-descoberta por estar em `~/.pi/agent/extensions/project-operator/index.ts`. Não tem
dependências npm próprias: usa apenas `node:*` e os módulos que o Pi já resolve
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`).

## O que faz

- Detecta o root do projeto via `git rev-parse --show-toplevel`, com fallback para `ctx.cwd`. Diretório
  sem git é projeto de primeira classe, dentro ou fora do `$HOME`.
- Coleta um snapshot **somente leitura** e mostra uma linha discreta no footer, ex.: `po ⎇master* · cc2 · pi1 · :3000`.
- Atualiza a cada ~30 s em modos com UI (`tui`, `rpc`). O timer nasce no `session_start`, é `unref`
  (nunca segura o processo vivo) e é limpo no `session_shutdown`.
- Em `print` e `json`: no máximo o snapshot inicial. Sem timer, sem UI.
- Escreve um sidecar por projeto em `~/.pi/agent/project-overviews/<slug>-<hash>/`, mas só quando o
  conteúdo operacional muda (ver **Escrita**). O footer continua vivo a cada tick.

## O que **nunca** faz

- Nunca inicia, para, reinicia ou mata processo algum. Não há `kill`, `pkill`, `spawn` de escrita.
- Nunca intercepta, bloqueia ou reescreve chamadas de ferramenta.
- Nunca altera o system prompt via `before_agent_start` (esse handler não é registrado).
- Nunca escreve, copia ou cria symlink dentro de qualquer repositório. O sidecar é o único destino
  de escrita, sempre sob `~/.pi/agent/project-overviews/`.
- Nunca roda git de escrita: há uma allowlist de binários (`git`, `ps`, `lsof`) e de subcomandos git
  (`rev-parse`, `status`, `log`, `stash`, `rev-list`, `worktree`), mais uma lista de tokens proibidos.
- Nunca usa shell: todo subprocesso passa por `execFile` com argv em array. Nenhuma interpolação de
  `cwd` em string de comando. Argumentos com metacaracteres de shell são rejeitados antes do spawn.
- Nunca lê o **conteúdo** de transcripts: apenas basename, mtime e tamanho. O basename é dado
  não-confiável e passa por `safeInline` (redaction de segredos, remoção de controles/quebras de linha,
  neutralização de crase) antes de truncar em 28 chars — vale tanto para o sidecar quanto para o
  payload da tool.
- Nunca lê linha de comando completa nem env de outros processos: de `ps` sai apenas
  pid/ppid/etime/rss e um rótulo de uma tabela fechada. O `comm` bruto não escapa do parser.
- Não governa o Claude Code. É o painel do Pi; observa, não comanda.

`GIT_OPTIONAL_LOCKS=0` é injetado em toda chamada git, então nem `git status` toca `.git/index`.

## Root e modo inert

`detectRoot(cwd)` resolve `cwd` para caminho absoluto e decide assim:

- **Inert se e somente se** o `cwd` for exatamente o `$HOME` ou exatamente a raiz do filesystem. Nesse
  caso nem se roda git: sem footer, sem timer, sem sidecar, sem diretório criado. Evita poluir `~` e
  varreduras absurdas. A comparação com `$HOME` tolera home symlinkado (compara também `realpath`).
- Caso contrário roda `git rev-parse --show-toplevel` com `cwd` no diretório. Se houver toplevel e ele
  **não** contiver o `$HOME` (nem for o próprio `$HOME`), o projeto é esse repositório — subdiretórios e
  worktrees continuam consolidando no root do git, como sempre.
- Sem toplevel, **ou** toplevel igual a/ancestral do `$HOME` (o caso do repositório de dotfiles em `~`,
  e o caso patológico de um repo em `/Users` ou `/`), o
  diretório vira um **projeto não-git enraizado no próprio `cwd`**. Um diretório qualquer sob `~` não
  colapsa mais em `$HOME`, e um diretório sem git fora do `$HOME` também é ativo — isso é intencional.

Como um projeto não-git pode estar dentro de algum repositório ancestral, `collectGit` tem um guarda:
antes de coletar qualquer coisa ele roda `git rev-parse --show-toplevel` e exige que o toplevel seja
**exatamente** o root observado (comparação por caminho resolvido, com `realpath` dos dois lados para
que `/tmp` vs `/private/tmp` não gere falso negativo). Prefixo/ancestral não vale. Na divergência
devolve `{unavailable:true, reason:"nonrepo"}` e não roda mais nenhum comando git — nunca se reporta o
branch de um repositório ancestral como se fosse o do projeto.

## Comandos

| Comando | Efeito |
|---|---|
| `/overview` ou `/overview show` | mostra o widget compacto acima do editor |
| `/overview refresh` | força novo snapshot, reescreve o `OVERVIEW.md` e atualiza footer/widget |
| `/overview hide` | esconde o widget (o footer permanece) |
| `/overview path` | mostra o caminho do sidecar |
| `/overview record <texto>` | registra uma intervenção manual (sanitizada) e atualiza o snapshot |

Sem texto e com UI disponível, `record` abre um input. Em modos sem UI, `record`, `path` e `refresh`
continuam funcionando; `show`/`hide` viram no-op silencioso.

## Tool `project_overview`

- `{action:"snapshot"}` — devolve o painel em JSON compacto (teto de 16 KB, truncado com aviso).
- `{action:"record", text:"..."}` — registra uma intervenção já executada, com sanitização.

O payload da tool **não carrega nome de arquivo nem assunto de commit**. Esses textos são controlados
por quem escreve no repositório (PII, segredo, injeção de prompt), então `summarize()` não os inclui:
o objeto `git` da tool tem só `branch`, `head`, `dirty`, `upstream`, `stashes`. O sidecar humano
continua mostrando os arquivos sujos e o último commit — quem lê ali é uma pessoa, não o modelo.

O `promptSnippet`/`promptGuidelines` deixam explícito que o snapshot é passivo, que o estado vivo é a
autoridade, que a tool não governa o Claude, e que intervenção real se faz com as ferramentas normais
**somente** quando o usuário pede ou há incidente concreto — registrando depois. Não há instrução
para chamar a tool todo turno.

## Sidecar

```
~/.pi/agent/project-overviews/<basename>-<sha256(root)[0..8]>/
  OVERVIEW.md     render derivado, reescrito por inteiro (escrita atômica: tmp + rename)
  journal.jsonl   append-only, fonte de verdade das intervenções
  metadata.json   root, slug, quem atualizou e quando
```

Diretórios `0700`, arquivos `0600`. Nomes de temporário incluem pid + 6 bytes aleatórios, então
várias instâncias do Pi no mesmo projeto não colidem. O journal é append-only (linha < 4 KB), de modo
que escritas concorrentes de sessões diferentes não perdem registros; o `OVERVIEW.md` é
last-writer-wins e sempre reconstruível a partir do journal. Acima de 1 MB o journal rotaciona para
`journal.jsonl.1`.

### Escrita

O timer de 30 s nunca é desacelerado e nunca pula a coleta: a cada tick ele coleta e atualiza footer e
widget. O que é regulado é o disco. `snapshotFingerprint()` gera um hash estável sobre o conteúdo
**operacional** (root, slug; disponibilidade/motivo do git, branch, head, assunto, contadores de dirty,
upstream, stashes, worktrees e as entradas de arquivo; contagens claude/pi e pid/ppid/label/rel/portas
de cada runtime; nome, `active` e `current` de cada sessão; e os avisos). Fica de fora tudo que anda
sozinho com o relógio: `at`, `commitTs`, qualquer `ageSec`/`ageMs` e `sizeKb` — o transcript da própria
sessão viva cresce a cada tick, e incluir o tamanho anularia o ganho.

`shouldPersist()` decide: escreve se for forçado, se o fingerprint mudou, ou se passaram 5 minutos
desde a última escrita (heartbeat, que acaba capturando a variação de tamanho). Escrita **imediata e
forçada** em: refresh inicial do `session_start`, `/overview refresh`, `{action:'snapshot'}` da tool e
o refresh que segue um `record` — nesse último caso o journal mudou e o fingerprint não cobre o
journal, então sem forçar o `OVERVIEW.md` omitiria a entrada nova. O tick de 30 s e `/overview show`
usam o caminho regulado.

O `OVERVIEW.md` é apenas o **último snapshot**. O estado dinâmico (git, processos) é a autoridade.
Ele não substitui nem toca `PROJECT_OVERVIEW.md` / `STATUS.md` do repositório.

## Privacidade

Todo texto de intervenção passa por `redact()` antes de chegar ao disco: ANSI e caracteres de
controle removidos (todos, exceto `\n` e `\t` — inclusive CR, que senão permitiria gravar um
registro que renderiza diferente do que contém); e-mails, `sk-`/`sk_`/`ghp_`/`github_pat_`/
`npm_`/`AIza`/`AKIA`/`xox*`, webhook do Slack, JWT, `Bearer <token>`, credencial em URL,
`chave=valor` sensível e blobs hex ou base64 ≥ 40 chars viram `[REDACTED]`; o resto é truncado
em 500 chars. Todo caminho exibido é reescrito para a forma `~/...`.

Todo texto vindo do git (branch, head, assunto do commit, caminho de arquivo sujo, caminho de
worktree) passa por `safeInline()` antes de entrar no Markdown: `redact()`, depois remoção de CR/LF/TAB
(o `redact` preserva `\n` e `\t`, o que serve para registros mas não para um span de uma linha só),
depois troca de crase por um caractere visualmente parecido que não fecha código, e por fim corte de
tamanho. Cada arquivo do status vira **um** span de código com status e caminho juntos, de modo que um
caminho hostil não consegue fechar o span, injetar heading/lista/link nem criar uma segunda linha. O
mesmo saneamento de uma linha vale para o branch no footer e no widget.

Consequência assumida da família base64: qualquer sequência alfanumérica contígua de 40+ chars
é tratada como segredo. Texto operacional normal não tem palavras desse tamanho; separadores
(espaço, `-`, `/`) quebram o casamento.

## Avisos

O painel só reporta **fato observado** — por exemplo, dois ou mais runtimes com o mesmo rótulo e
`cwd` no projeto, ou três ou mais sessões Claude no mesmo root. Ele nunca age e nunca sugere agir.
Como a linha de comando não é lida por decisão de privacidade, a duplicidade é detectada por rótulo
de processo (`node`, `vite`, …), não por nome de script.

## Testes

```
cd ~/.pi/agent/extensions/project-operator
node --test test/*.test.mjs
```

Os testes não usam rede nem provider e não tocam projeto real algum: usam fixtures de string,
executores injetados e `os.tmpdir()`.

Smoke manual do coletor, sem escrever no projeto observado:

```
node ~/.pi/agent/extensions/project-operator/init.mjs --root /caminho/do/projeto --base /tmp/state
```

## Operação

- `pi --no-extensions` desliga esta extensão junto com todas as outras — é a válvula de escape.
- Sessões Pi já abertas não veem alterações neste diretório até um `/reload` (ou uma sessão nova).
- `/reload` dispara `session_shutdown` seguido de `session_start` no mesmo processo; o timer antigo é
  cancelado e um guard de geração impede que um refresh em voo da sessão morta escreva no footer da nova.
