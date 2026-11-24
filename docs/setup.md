# Setup do Agent

## Instalação privada por artefato

A v0.1.0 publicada contém somente darwin-arm64. Esta mudança não publica uma release: os comandos Windows exigem uma release posterior com o asset win32-x64, aprovada após o smoke nativo.

Pré-requisitos: Node externo >=22.19 (recomendado Node 24), Bash em macOS/Linux e GitHub CLI (`gh`) autenticado com acesso a `GabrielMendonca1/agent`. Em Windows x64 nativo, também instale **Git for Windows** (Git Bash é usado pelo shell do Pi). Em macOS/Linux, não precisa de Git; nenhuma plataforma precisa de npm, clone ou build na máquina do consumidor. Não use WSL para instalar o pacote win32-x64.

Após existir uma release aprovada, obtenha `install.sh` pelo canal privado e execute:

```sh
gh release download -R GabrielMendonca1/agent -p install.sh -O ./install.sh
bash ./install.sh
export PATH="$HOME/.local/bin:$PATH"
agent
# Na conversa: /login — sua própria conta do provider
```

### Windows x64 (PowerShell)

```powershell
gh auth status
gh release download -R GabrielMendonca1/agent -p install.ps1 -O ./install.ps1
# Opcional: $env:AGENT_VERSION = 'vX.Y.Z' (baixe install.ps1 da mesma tag)
pwsh -NoProfile -File ./install.ps1 --adopt-launcher
& "$env:USERPROFILE/.local/bin/agent.cmd" --version
& "$env:USERPROFILE/.local/bin/agent.cmd" overlay-status
& "$env:USERPROFILE/.local/bin/agent.cmd" migrate-from-mark --dry-run --json
```

O script também pode ser executado com `powershell -NoProfile -File`; respeite a política de execução local (não a altere automaticamente). O app deve aguardar o código de saída antes de lançar o Agent. `install.ps1` exige Node >=22.19 e `gh auth status` válido, baixa o bootstrap e SHA256SUMS via `gh`, confere o bootstrap e chama `node agent-distribution.mjs install`. A CLI aceita `install --tag <tag>` e opções do updater, como `--adopt-launcher` e `--store <path>`. Código 0 significa ativação concluída; falha retorna código não zero (erros do bootstrap: 1) com diagnóstico em stderr; stdout é log de progresso, não JSON. Não faça parsing de mensagens de progresso.

Os launchers são `%USERPROFILE%\.local\bin\agent.cmd` e `agent.ps1`; perfil padrão `%USERPROFILE%\.agent`, store `%USERPROFILE%\.local\share\agent`. Não há alteração de PATH, shell rc nem login automático. O comando de migração retorna JSON com `--json`; `--dry-run` não escreve. Uma migração efetiva preserva wrappers Mark reconhecidos como `pi.cmd.before-agent-migration` / `pi.ps1.before-agent-migration` (sufixo numérico se necessário), encaminha para `agent.cmd` e usa junctions absolutos para diretórios de skills. Wrappers desconhecidos são preservados.

`AGENT_RELEASE_DIR=<diretório>` permite instalar offline um dist local, sem `gh`: exige bootstrap, SHA256SUMS e exatamente um tarball da plataforma. Nesse modo não se infere identidade de release. O formato schema 1/runtimeContract 3 permanece compatível com v0.1.0; `install.sh` também aceita o bootstrap antigo dessa release.

Use `AGENT_VERSION=<tag>` para fixar uma release e `AGENT_RELEASE_REPO=owner/repo` para escolher explicitamente outro canal privado confiável. Não use um mirror não confiável: SHA256SUMS detecta corrupção, **não é assinatura**. O transporte autenticado do `gh` é a origem de confiança. Nenhum download usa HTTP público nem copia auth do Mark. Busca web e Megamind podem exigir configuração própria; não são autenticação do chat.

Padrões: store `~/.local/share/agent`, comando `~/.local/bin/agent`, perfil `~/.agent`. `AGENT_STORE` e `PI_CODING_AGENT_DIR` explícitos prevalecem. Para copiar o perfil Mark existente sem apagar a origem, use `agent migrate-from-mark` (detalhes abaixo). O bootstrap não altera shell rc; configure o PATH também para o Node em terminais novos. Um store alternativo só adota `~/.local/bin/agent` com `--adopt-launcher` explícito.

```sh
agent update                 # canal privado, sem build; erro de acesso preserva a instalação
agent overlay-rollback       # revalida o par anterior antes de trocar
agent overlay-status
node scripts/agent-update.mjs --install-artifact latest
node scripts/agent-update.mjs --install-artifact <tag>
node scripts/agent-update.mjs --install-artifact /caminho/agent-<id>-<os>-<arch>.tar.gz
# O arquivo SHA256SUMS deve estar no mesmo diretório do archive local.
```

### Dependências externas (skills e papéis)

Três ferramentas externas ficam fora do artefato. O manifesto único está em `scripts/lib/agent-deps.mjs`:

| Ferramenta | Mínimo | Quem usa | macOS (`agent deps --install`) | Linux / Windows (só instrução) |
|---|---|---|---|---|
| `agent-browser` | 0.43.0 | skill computer-use (web) | `brew install agent-browser` e `agent-browser install` (baixa o Chrome) | `npm install -g agent-browser && agent-browser install` |
| `cua-driver` | 0.36.0 | skill computer-use (janelas macOS) | instalador oficial `https://cua.ai/driver/install.sh` com `--no-connect --no-test` | o mesmo script / `install.ps1` |
| `agy` | 1.5.16 | papel `gemini` | `brew install --cask antigravity-cli` | `https://antigravity.google/cli/install.sh` / `install.ps1` |

```sh
agent deps             # status (somente leitura): versão, caminho, permissões do cua-driver
agent deps --install   # instala as ausentes pela fonte oficial; mostra os passos manuais
```

No fim de `install.sh` e de `agent update`, o Agent confere o que falta. Em terminal interativo, ele lista as ausentes e pede uma única confirmação para instalar todas. Sem TTY, com `CI` definido ou quando o app Megamind executa o install, nada é instalado: só aparece uma linha com `agent deps --install`. `AGENT_INSTALL_DEPS=1` instala sem perguntar; `AGENT_INSTALL_DEPS=0` pula a verificação. Uma dependência que falha só gera log: a instalação do Agent continua e mantém o código de saída. Sem Homebrew, `agent-browser` e `agy` são pulados com a instrução de instalá-lo em https://brew.sh. A instalação automática existe só no macOS; Linux e Windows recebem os comandos para rodar manualmente. Versões abaixo do mínimo aparecem como `desatualizado` e não são atualizadas sozinhas.

`--no-connect` impede o instalador do cua-driver de registrar MCP no Claude Code, Codex e Cursor, porque a skill usa o CLI. Os passos que exigem você nunca são automatizados, apenas indicados no fim:

- `agy`: rode uma vez e faça o login Google (OAuth).
- `cua-driver permissions grant`: conceda Acessibilidade e Gravação de Tela ao CuaDriver. `agent deps` lê `cua-driver permissions status` e avisa quando falta permissão.

### Identidade instalada

Instalações remotas registram em `<store>/active.json` o objeto opcional `release: { tag, assetId, repo }`. A tag é resolvida antes do download e usada explicitamente nele, mesmo para `latest`. `assetId` é o `releaseId` do manifesto: o `<id>` em `agent-<id>-<os>-<arch>.tar.gz`, não o ID numérico do GitHub nem o ID interno do runtime. O rollback restaura os valores do par anterior. Checkout, archive local e `AGENT_RELEASE_DIR` não declaram uma release remota.

`agent overlay-status` mostra `Release: <tag> (assetId <id>, repo <owner/repo>)`, ou `Release: unknown (local install or unrecorded release)` quando não há identidade. A saída é textual; o app Megamind usa o JSON de `active.json`, comparando tag e nome do asset remoto sem depender de datas. Veja [o contrato de consumo](consumer-contract.md#identidade-da-release-instalada-megamind).

### Migração Mark → Agent

Depois de instalar/ativar o Agent:

```sh
agent migrate-from-mark --dry-run         # inventário sem alterar o perfil
agent migrate-from-mark --dry-run --json  # relatório para o Megamind
agent migrate-from-mark                  # copia somente dados ausentes
agent migrate-from-mark --json            # pode repetir; não sobrescreve dados
```

Origem fixa: `~/.pi/agent`; destino: `PI_CODING_AGENT_DIR` ou `~/.agent`. O store segue `AGENT_STORE`. Execute com o HOME do sócio que está migrando. Não use o perfil real em testes.

Sessões JSONL, jobs, credenciais/contas, modelos, MCP, keybindings, índices, overviews e secrets são copiados sem sobrescrita, preservando mtime e com arquivos privados (0600). Durable sessions usam exclusivamente `scripts/import-durable-sessions.mjs --source ... --destination ...`; falhas aparecem como pendência e saída não zero. O dry-run do importador usa snapshots descartáveis em `os.tmpdir()`, sem escrever em `~/.pi` ou `~/.agent`. A raiz de sessões e cada destino durable são validados sem seguir componentes symlink; destinos redirecionados são pulados e reportados também como pendência.

Só `defaultProvider`, `defaultModel`, `theme` e `defaultThinkingLevel` ausentes entram em settings. `extensions`/`skills` e outras configurações do Mark não entram: o recibo de recursos do Agent continua sendo a autoridade. Revise os itens pulados e as entradas Mark específicas nas pendências. Arquivos existentes (incluindo auth/accounts) nunca são mesclados: mantenha o relatório para revisar diferenças manualmente, sem expor seu conteúdo.

O wrapper bash `~/.local/bin/pi` reconhecido como Mark ganha backup e passa a executar `~/.local/bin/agent`, fixando o perfil Agent (inclusive em terminais do Megamind). Wrappers desconhecidos ou symlinks são preservados e reportados. Links de `~/.agents/skills` para o store Mark são reapontados quando a skill existe no Agent; os obsoletos são removidos com backup fora da pasta de skills, em `~/.agents/mark-migration-backups/`. Nenhum outro link é alterado. O caminho estável `<store>/skills` acompanha o artefato ativo e resolve para a mesma árvore padrão usada pelo Pi; não cria cópias de skills. Diretórios legados (vazios ou contendo apenas diretórios de skills padrão conhecidas) são convertidos em symlink com backup `<store>/skills.before-agent-migration[-N]`. Conteúdo desconhecido também é preservado nesse backup e gera aviso de pendência para revisão, sem bloquear a ativação. Se a gravação da configuração falhar, o diretório original é restaurado.

O relatório textual/JSON separa `copied` (planejado no dry-run), `alreadyExisted`, `skipped` (com motivo) e `manual`. Estado `superagent` nunca é migrado; pare/reconfigure o daemon manualmente. Worktrees não são movidas: branches sujas, à frente do upstream ou sem prova de integração são listadas para revisão. A origem Mark e seu store permanecem intactos. Windows aceita o subcomando `.cmd`, mas não converte o wrapper bash `pi`; a instalação Windows continua não validada.

`agent update --extensions` e outras opções nativas de atualização de pacotes continuam delegadas ao Pi. `agent update --all` instala o artefato e depois atualiza as extensões pelo Pi. Print/JSON/RPC, SDK e códigos de saída pertencem ao Pi; o launcher não reescreve stdout.

## Validação e ativação

- O bootstrap verifica SHA256SUMS, interpreta todos os headers ustar e recusa travessia, entradas duplicadas, tipos especiais, links absolutos/externos/encadeados e arquivos sob symlinks **antes de extrair**. Só então verifica o inventário integral antes de executar o updater do bundle.
- O manifesto de distribuição (`artifact.json`, schema 1, `runtimeContract:3`) fixa commit, plataforma/arquitetura, Node mínimo, perfil, hash do manifesto overlay e inventário de arquivos/modos/links. O digest cobre release e bundle; o releaseId inclui o digest portátil para distinguir atualizações só do Agent, mesmo com Pi idêntico. Nenhum recibo host-bound de `--prepare` é aceito como prova portátil.
- Antes de ativar, o updater revalida pacote/entrypoint, seleção, hashes dos patches, fingerprint, tree digest, markers e `pi --version`. O inventário portátil substitui a prova de conteúdo do recibo local, não a verificação da release. `--force` não dispensa isso.
- Sob lock do store, copia em stage e renomeia a release, prepara o par físico Pi+Agent e o plano de recursos, troca current/previous e escreve recursos/config/active. Falhas verificadas restauram o par anterior, os registros e o recibo. Diretórios candidatos não ativos podem permanecer para diagnóstico; auth e sessões nunca fazem parte da transação. Falha de recuperação é reportada, não declarada sucesso.
- Uma desativação explícita é preservada nas atualizações por artefato. O runtime registra extensões core, Megamind e skills padrão pelo mesmo recibo/CAS em `runtime/resources-backup`. Cópias pessoais são preservadas, colisões recebem exclusões reversíveis; `-megamind`/`-nome` e `-agent-setup` são respeitados. Temas pessoais e settings de modelo/thinking não são substituídos. O caminho novo não roda os syncs legados sem recibo. A instalação por artefato não reserva tecla: Shift+Tab e Ctrl+T seguem nativos do Pi. No `settings.json` do perfil entra `warnings.anthropicExtraUsage: false` só quando a chave falta, pelo mesmo recibo; valor seu nunca é sobrescrito, e o rollback só remove o `false` que ainda estiver lá.

## Contrato do runtime novo e rollback histórico

Novos artefatos internos têm manifesto **v3**, config **v2** e preload `agent/core/runtime.mjs`. O launcher exporta `AGENT_RUNTIME_ENABLED=1` e `AGENT_PI_ROOT` físico/absoluto. Filhos usam `AGENT_CHILD=1`. A tool `subagent` fica sempre ligada na sessão principal; ver "Subagentes: sempre ligados, isolamento e auditoria". Preferências pertencem ao perfil `PI_CODING_AGENT_DIR`.

Não há `juiceHome`, ledger, runId nem `AGENT_JUICE_HOME/STATE` no contrato novo. `--agent-enable` liga o runtime sobre a release ativa sem build; `--juice-home <absoluto>` ainda é aceito com aviso, mas é ignorado e não acessado para artefatos novos. `--agent-disable` fecha o opt-in e desfaz os recursos por recibo. `AGENT_DISABLED=1` é um escape por processo. Preloads herdados do Agent são removidos de NODE_OPTIONS (inclusive forma separada e com aspas); opções alheias são preservadas.

Artefatos históricos **v1/v2** continuam imutáveis e usam config **v1**, com `juiceHome` e seu preload/entrada/broker declarados. O índice de pares guarda a config anterior para rollback. Voltar a eles pode religar contabilidade histórica; o updater avisa antes de ativar e recusa o rollback se o contrato antigo não puder ser recuperado. Não reescreve manifests, digests ou dados históricos.

## Produzir e verificar sem instalar no host

```sh
# Mantenedor: pipeline padrão --prepare em HOME/store temporários.
node scripts/agent-dist.mjs --out dist
# Alternativa readonly: empacotar candidato já preparado/instalado e revalidá-lo.
node scripts/agent-dist.mjs --release /caminho/fisico/releases/<id> --out dist

# Gate offline, HOME/store isolados internamente; não usa provider real nem gh real.
node scripts/test-install-artifact.mjs
node scripts/test-agent-runtime.mjs
node scripts/test-prepare-promote.mjs

# Instalação manual exclusivamente temporária do pacote real:
H=$(mktemp -d)
HOME="$H" USERPROFILE="$H" PI_CODING_AGENT_DIR="$H/.agent" \
  AGENT_STORE="$H/store" AGENT_RELEASE_DIR="$PWD/dist" AGENT_WARM_START=0 \
  bash dist/install.sh --adopt-launcher
HOME="$H" PI_CODING_AGENT_DIR="$H/.agent" AGENT_STORE="$H/store" \
  "$H/.local/bin/agent" --version
```

A saída é um ustar gzip determinístico para os mesmos bytes de entrada, mais `install.sh`, `install.ps1`, bootstrap independente `agent-distribution.mjs` e SHA256SUMS. O build normal ainda depende das fontes/dependências upstream fixadas; timestamps de builds distintos podem diferir. O pack remove `sourceRepo` da metadata e faz scan de arquivos de estado/chaves e paths pessoais em metadata. Isso não substitui revisão humana de segredos nem prova suporte a outro SO. Cada pacote declara apenas o par SO/arquitetura do build; rode startup real com provider falso e o gate completo nesse par antes de publicar. Esta implementação não publica, cria release, faz push ou migra o host.

### Distribuição multi-host e CI

Cada host gera seu próprio dist e SHA256SUMS. Una diretórios em uma saída nova; o merge verifica os hashes de entrada, recusa nomes com bytes conflitantes e calcula um único SHA256SUMS com ambos os instaladores:

```sh
node scripts/agent-dist.mjs --merge dist-mac dist-win --out dist-merged
```

Em Windows o staging usa nomes curtos (`ad-*`, `h`, `s`); `AGENT_DIST_TMP` permite escolher uma raiz curta gravável (no CI: `C:\adtmp`). Variáveis essenciais do Windows são preservadas ao filtrar credenciais do ambiente de build. Recomenda-se uma raiz curta também para checkout e instalação.

O workflow `.github/workflows/agent-dist.yml` aceita `workflow_dispatch` ou push na branch `ci/agent-dist`, constrói em macos-14/arm64 e windows-2022/x64 com Node 24 e salva artifacts `agent-darwin-arm64` / `agent-win32-x64`. O smoke Windows instala o dist local em USERPROFILE/store temporários e verifica versão, status e migração dry-run de um perfil Mark falso.

Disparo sem publicação (padrão): `gh workflow run agent-dist.yml --ref <branch>`. O workflow precisa existir no ref e estar disponível no GitHub. Para publicação explicitamente aprovada: `gh workflow run agent-dist.yml --ref <branch> -f tag=vX.Y.Z -f publish=true`. Apenas esse opt-in habilita o job final que faz merge e `gh release create` ou `upload` (sem sobrescrever assets existentes). Não publique antes de validar os artifacts e os checks; a execução desse workflow não foi feita localmente.

### Portão contra a release candidata

Os checks de UI/inferência precisam do Pi recém-compilado: a instalação global antiga ainda pode conter recaps removidos nesta versão. Não atualize o perfil real apenas para testar. Depois da instalação temporária acima, rode o manifesto completo contra o candidato:

```sh
AGENT_STORE="$H/store" \
AGENT_PI_ROOT="$H/store/current/lib/node_modules/@earendil-works/pi-coding-agent" \
node --input-type=module -e '
  import { findManifest, gate, formatResults } from "./agent/extensions/brain-live/checks/runner.ts";
  const result = await gate(findManifest(process.cwd()));
  console.log(result.verdict);
  console.log(formatResults(result.results));
  process.exitCode = result.results.every(check => check.ok) ? 0 : 1;
'
```

O comando exige todos os checks verdes para o pacote, mesmo quando o gate identifica uma falha como herdada. Endpoints de inferência dos checks são fixtures locais; isso não substitui uma validação de login real feita pelo usuário.

## Desenvolvimento por checkout (legado)

Requer Git, npm e Node >=22.19. `node scripts/agent-update.mjs --prepare` constrói/testa sem ativar; `--promote <ID>` exige o recibo local host-bound intacto. `node scripts/agent-update.mjs` constrói e ativa; `--agent-enable` liga o runtime novo. O caminho legado sem runtime ainda pode copiar recursos e defaults ausentes e editar `.zshrc`/`.bashrc`; não o use como teste de distribuição no HOME real.

### Skills, papéis e mídia

- As skills de integração `peers`, `megamind`, `tasks` e as de `agent/skills/system/` são automáticas. `design/` e `plan/` ficam sob demanda e geram uma linha curta por categoria no system prompt. A curadoria usa o formatter compartilhado entre os hosts.
- `/skill` ou `/skill:` abre o catálogo agrupado por categoria.
- `/models` separa slots de execução e escolhas por papel e preserva as escolhas pessoais. O picker de um papel lista primeiro os pares autorizados e depois todo modelo disponível; escolher um novo o autoriza naquele papel com o thinking da preferência atual. `Esc Esc` abre só a lista de fork. Falha de quota/503 não troca modelo silenciosamente.
- `read` é o nativo do Pi clássico: imagens, texto, offset/limit e cancelamento. O loadout controla quais papéis recebem `read`. Principal, scout e visual precisam de modelo capaz de receber imagens; anexos diretos continuam suportados.
- `scout` não edita: tem `read, grep, find, ls, bash, skim, web_search, web_fetch`, com `bash` sob sandbox de escrita. Transcrição que exija `ffmpeg`, Whisper ou outro executável que grave arquivos deve ir para um papel com `edit`/`write` (worker). Não se promete leitura/transcrição nativa de qualquer formato binário.
- JEV e cache observam compactação confirmada no branch para resetar sua época; pedido, cancelamento, queda de tokens ou erro não contam como compactação concluída. Nenhum evento sintético por correlação FIFO é usado.

## Estado da instalação e limpeza

```sh
agent overlay-status            # o que está rodando e se o checkout está à frente
agent overlay-gc --dry-run      # o que a limpeza apagaria (nada é apagado)
agent overlay-gc                # apaga, guardando 1 item sem uso de cada tipo
```

`/agent-doctor` mostra as tools registradas e declaradas na sessão, exposição (`direct`, `codemode`, `deferred`, etc.), origem real do registry e comandos/skills observados. Usa as APIs públicas do Pi; não adiciona tool ao prompt, não chama modelo, não faz probes e não altera settings. Na TUI/RPC abre o editor nativo como visualizador: o texto devolvido é descartado, nunca salvo ou enviado; em print escreve texto em stderr e em JSON emite `{ "type": "agent_doctor", "report": "..." }` em stderr, sem alterar o protocolo oficial em stdout. Funciona mesmo sem projeto Git. Configuração não prova atividade: hooks sem tool/comando e cobranças auxiliares ficam explicitamente como não observados; uma integração registrada não prova conexão. Para instalação use `agent overlay-status`; para recursos configurados, `agent config`; para uso/cache, `/session`, `/cost` e `/cache` quando disponíveis.

O runtime novo não executa aprendizado/mineração automáticos nem chama modelos para recaps ou avisos semânticos. O recap usa apenas texto local; o chat, o mascaramento de dados e a compatibilidade de imagens históricas permanecem. Cache-keeper e prefetch continuam com seus limites próprios e sem ledger. `/cache` mostra métricas da sessão; custos do provedor continuam nas métricas nativas do Pi.

Instalações por artefato atualizam com `agent update`, não com commits do checkout. `agent overlay-update` continua sendo o caminho de desenvolvimento que reconstrói a release.

## Checkpoints de arquivo e /rewind

Antes de cada `edit`/`write` do agente na sessão principal (também os chamados de dentro do `codemode`), a extensão `brain-live/checkpoints.ts` guarda o conteúdo anterior do arquivo, ou o marcador "não existia", associado à mensagem do usuário que abriu o turno. Só a primeira mudança de cada arquivo por turno é guardada. Depois de cada edição registra o hash que o agente deixou.

`/rewind` lista os turnos do ramo atual, do mais novo ao mais antigo, com o texto do pedido e os arquivos que o agente mudou nele:

```
Voltar para antes de qual turno? (só edições feitas por edit/write do agente; bash (rm, mv, sed…) não é rastreado)
→ 2. segundo pedido · novo.txt
  1. primeiro pedido · a.txt

Arquivos desde esse turno:
  novo.txt: remover (criado pelo agente)
O que desfazer?
→ Código e conversa
  Só código
  Só conversa
  Cancelar
```

- Código: cada arquivo tocado desde o turno escolhido volta ao estado de antes dele; arquivo criado pelo agente é apagado. Vale a ordem em que as edições aconteceram no disco, de qualquer ramo da conversa.
- Conversa: `ctx.navigateTree` até a mensagem escolhida, o mesmo mecanismo do `/tree` (sem resumo do ramo abandonado). O ramo antigo continua no `/tree` e o texto do pedido volta ao editor.
- Se um arquivo mudou depois da última edição do agente (editor, `bash`, outro processo), o `/rewind` lista os arquivos e pergunta: sobrescrever, pular os alterados ou cancelar.
- Não rastreia `bash` (rm, mv, `sed -i`, geradores) nem filhos (`AGENT_CHILD=1`), que escrevem em worktree próprio. Arquivo acima de 20 MB fica marcado como não restaurável.
- Só roda com o agente parado. `/fork` e `/clone` criam sessão nova sem os checkpoints da anterior. O double-Esc continua abrindo o `/tree`, que não mexe em arquivos.

Disco: `<perfil>/checkpoints/<sessionId>/index.jsonl` (registro append-only) e `blobs/<sha256>` (conteúdo, deduplicado). Persistem ao retomar a sessão. No início de cada sessão, apaga os checkpoints de sessões sem uso há mais de `AGENT_CHECKPOINTS_DAYS` dias (30) e, se o total passar de `AGENT_CHECKPOINTS_MAX_MB` (500), os das sessões menos recentes; a sessão atual nunca. `AGENT_CHECKPOINTS=0` desliga a gravação e o comando. Não adiciona tool nem texto ao prompt.

## Atualizar o Pi

O Agent traz o próprio Pi dentro do store, em releases imutáveis. Um Pi global instalado por npm não afeta o Agent.

| Comando | Faz |
|---|---|
| `agent update` | Instala o último artefato do Agent. Não chama o auto-update do Pi. |
| `agent update --extensions`, `--models` ou outros argumentos | Delega ao Pi. |
| `agent update --all` | Instala o artefato e depois atualiza as extensões pelo Pi. |

Pi novo só chega com artefato novo. Quem faz o quê:

- Mantenedor: reaplica os 12 patches de `overlay/manifest.json` sobre o Pi upstream novo, passa o portão e publica o artefato.
- Consumidor: roda `agent update`.

Nenhum patch é necessário para as extensões carregarem; eles dão funcionalidade. Linhas: inserções/remoções de `git apply --stat`, testes incluídos. Fragilidade: risco de conflito num port, pelo quanto o patch mexe em arquivo central do upstream.

| Patch | Função | Linhas | Fragilidade |
|---|---|---|---|
| `pi-black` | Lane Anthropic OAuth com identidade Claude Code (2.1.322), sem message threads. | +525/−15 | Média: arquivo novo, mas edita `anthropic-messages.ts`. |
| `garime-frame` | Moldura, margens e tema da TUI. | +495/−31 | Alta: 13 arquivos, componentes e `interactive-mode.ts`. |
| `pi-account-env` | Conta por projeto via `PI_ACCOUNT_<PROVIDER>`. | +887/−9 | Média: arquivo novo, mas edita `auth-storage.ts` e `model-runtime.ts`. |
| `transcript-feedback` | Widgets e recap local após o transcript. | +2077/−17 | Alta: maior patch, 12 arquivos, `interactive-mode.ts`. |
| `stream-markdown` | Agrupa deltas por quadro e `PI_TUI_HZ`. | +288/−6 | Alta: `interactive-mode.ts` e `tui.ts`. |
| `agent-skill-curation` | Curadoria opt-in do anúncio de skills. | +119/−1 | Baixa: um arquivo de código. |
| `codemode-typed-results` | Resultados estruturados de read/grep/find em scripts. | +104/−8 | Baixa: acréscimos nas tools. |
| `codemode-background` | Codemode em segundo plano após 5 min, saída parcial e cancelamento. | +333/−149 | Alta: reescreve boa parte de `execute.ts`. |
| `tool-load-append` | Tool carregada no meio da sessão não reescreve o system prompt. | +211/−26 | Média: `agent-session.ts`. |
| `cc-hidden-tool-names` | No OAuth Anthropic, `Bash`/`Read` de tool escondida voltam em minúsculas. | +22/−2 | Baixa: poucas linhas, mas no mesmo arquivo de `pi-black`. |
| `auth-guidance-short` | Avisos de falta de login/modelo/chave e diálogo de login do Bedrock sem "See:" e sem os caminhos de `providers.md`/`models.md`. | +43/−12 | Baixa: uma função em `auth-guidance.ts` e três linhas em `interactive-mode.ts`. |
| `mcp-structured-content` | Chamada direta de tool MCP mostra ao modelo o `structuredContent` que o texto do servidor não traz. | +103/−6 | Baixa: uma função em `extensions/mcp/tools.ts`. |

## Avisos da TUI e como desligar

| Aviso | Desligar |
|---|---|
| "Anthropic subscription auth is active. Third-party harness usage draws from extra usage..." | `warnings.anthropicExtraUsage: false` no settings, ou `/settings`. Instalação por artefato já grava `false` se a chave faltar. |
| "Update Available ... Run agent update" | Já desligado: o launcher do Agent exporta `PI_SKIP_VERSION_CHECK=1` quando a variável não está definida. `PI_SKIP_VERSION_CHECK=` (vazio) religa. |
| "Package Updates Available" | Só `PI_OFFLINE=1` ou `--offline`. |
| Changelog após troca de versão do Pi | Não desliga. `collapseChangelog: true` reduz a uma linha. Só aparece em sessão nova. |
| Cabeçalho e detalhes de startup | `quietStartup: true` esconde os dois; `"header"` mantém o cabeçalho e esconde os detalhes. |
| Frases enquanto o modelo pensa ("Schlepping...") | Extensão `whimsical`: `"-whimsical"` em `extensions[]`. Ver abaixo. |
| "No models available. Use /login to log into a provider via OAuth or API key." | Some ao fazer `/login` ou configurar uma chave. Os caminhos de `docs/providers.md` e `docs/models.md` que vinham abaixo foram removidos pelo patch `auth-guidance-short`. |
| "You can also use an AWS profile, IAM keys, or role-based credentials." (`/login` do Amazon Bedrock) | Só aparece nesse diálogo. O "See:" e o caminho de `docs/providers.md` que vinham abaixo foram removidos pelo patch `auth-guidance-short`. |

```json
{
  "warnings": { "anthropicExtraUsage": false },
  "collapseChangelog": true,
  "quietStartup": "header"
}
```

- O aviso de versão é enganoso no Agent: `agent update` só traz Pi novo quando houver artefato novo.
- `PI_OFFLINE=1` também desliga o refresh do catálogo de modelos no startup e a checagem de pacotes; não é necessário para o aviso de versão.
- `-whimsical` só vale quando o plano de recursos roda. Com o Agent já instalado: `agent overlay-update --agent-disable`, acrescente `"-whimsical"` em `extensions[]`, `agent overlay-update --agent-enable`. Editar `extensions[]` com o Agent ligado faz o próximo `agent update` recusar por conflito no recibo.
- O banner "pi has joined Earendil" não é automático; só aparece por comando.
- Custo em USD no rodapé é preço de lista calculado localmente, não fatura. Com assinatura, representa consumo de cota.

## Custo: o que roda sem prompt

Chamadas pagas que não saem de uma mensagem sua. Todas usam a sua conta ou chave do provider.

| Recurso | Gatilho | Padrão | Desligar |
|---|---|---|---|
| Cache-keeper | Sessão principal ociosa, modelo Anthropic com `cache_control`. Reenvia o último payload inteiro com `max_tokens` 1 a 90% do TTL: a cada 54 min (TTL 1h) ou 4 min 30 s (TTL 5 min). | Ligado. | `AGENT_CACHE_KEEPER=0` |
| Compactação ociosa | Contexto ≥ 200k tokens e o aquecimento acabou (janela fechada, ping pulado ou sem acerto), nunca antes de 54 min parado; agente ocioso, sem fila e editor vazio. Resume no modelo selecionado. | Ligada. | `AGENT_IDLE_COMPACT=0` |
| Compactação por limiar | Fim de turno com contexto > 450k tokens em janelas ≥ 1M, ou > 90% da janela nas menores. Com cache quente pode ser adiada por alguns turnos, nunca além do limite duro (janela − max(64k, 10%)). Resume no modelo selecionado. | Ligada. | Não há variável. |
| `web_search` | Cada chamada da tool, na sessão principal ou num subagente cujo papel a declara: uma inferência Gemini (`gemini-2.5-flash` com Google Search, fallback OpenRouter). | Até 20 buscas e 40 fetches por sessão. | `AGENT_WEB_MAX_SEARCHES=0` (`AGENT_WEB_MAX_FETCHES=0` para fetch) |

O aquecedor nativo do Pi (`cacheWarming`) fica parado, inclusive com `AGENT_CACHE_KEEPER=0`; a lane OAuth Anthropic não usa message threads (cada request leva system, tools e a conversa inteira).

Prompt cache: o launcher define `PI_CACHE_RETENTION=long` (TTL 1h) quando a variável não está definida; um valor do usuário, inclusive `none`, prevalece. Isso vale para a sessão principal; subagentes usam 5 min (ver Custo dos filhos). Escrita de cache custa 2× a entrada com TTL 1h e 1,25× com 5 min; leitura, 0,1×. Medido na auditoria do commit 6f77207: o prefixo fixo da 1ª requisição tem 10,2 KB de system e 20,0 KB de tools (o schema de `subagent` ocupa 8,9 KB), idêntico entre requisições e processos; cada passo do modelo é uma requisição.

Cache-keeper em detalhe:

- Só a sessão principal aquece; subagentes não. Só Anthropic Messages API, com o mesmo provider/modelo do último request real.
- Janela de aquecimento: 3h de ociosidade com menos de 30 pausas registradas no projeto; depois, aprendida das pausas, até 24h. Pausas ficam em `<perfil>/cache-keeper/<hash do cwd>.json`.
- Teto por ping: `AGENT_CACHE_KEEPER_MAX_PING_USD` (padrão 0.5), calculado a preço de leitura de cache. Um ping que erra o cache paga escrita antes de parar. Não há teto por sessão: o custo total é pings × janela.
- Thinking com budget fixo B: o ping usa `max_tokens` B+1 e só sai se o pior caso couber no teto e em 25% da perda evitada; senão é pulado. Sem thinking, ou thinking adaptive, `max_tokens` 1.
- Para no primeiro ping sem acerto, em qualquer entrada sua e no fim da sessão.
- Message threads (chave de API Anthropic, padrão do Pi em `api.anthropic.com` desde a 1.5.2, ou `compat.supportsMessageThreads`): não aquece. O keeper guarda o request completo (o hook roda antes de o provider aplicar a thread), mas o request seguinte sai como `thread: continue` só com as mensagens novas, e o ping sairia completo e sem `thread`. Que um acerte o cache do outro não foi verificado com chamada real; um erro pagaria escrita do contexto inteiro. A barra mostra `cache ❄ (message-threads)` e a compactação ociosa segue o fim do TTL. A lane OAuth não usa threads e continua aquecendo.

`AGENT_IDLE_COMPACT_MIN_TOKENS` ajusta o mínimo da compactação ociosa (piso 100k). `AGENT_CACHE_PREFETCH_NEXT=1` liga o prefetch do próximo papel de uma chain; é desligado por padrão e custa mais do que não aquecer.

### Limpeza local de resultados antigos

Não chama modelo nem resume conteúdo. Antes de enviar o histórico, a sessão principal pode substituir resultados antigos de `bash`, `read`, `grep`, `find`, `ls`, `codemode`, `skim` e `web_fetch` por um marcador com tool, argumentos resumidos (até 160 caracteres), tamanho original e “rode de novo se precisar”. Só resultados inteiramente textuais e ligados à chamada original são elegíveis. Imagens, mensagens do usuário, texto do assistente, chamadas de tools, `edit`/`write`, `ask_user` e resultados de subagentes ficam intactos.

- Exige contexto ≥ 150k tokens **e** economia estimada ≥ 40k tokens no lote; preserva os últimos 3 turnos, contados pelas mensagens do usuário, inclusive o turno atual. Estimativa da economia: diferença de caracteres / 4, descontando os marcadores; não é um tokenizer.
- Cache quente: só tenta no lugar de uma compactação automática já autorizada pelo gate de cache (por limiar ou ociosa). Se o contexto restante cabe abaixo do limiar daquela compactação, adia o resumo; caso contrário, a compactação nativa continua. `/compact` manual e recuperação de overflow não iniciam lotes.
- Cache frio: pode limpar no próximo envio após expirar o TTL ou trocar de modelo. Consulta o estado do keeper, incluindo refreshes; grava também relógio/modelo dos requests e dos refreshes para a retomada. Sem estado conhecido, não presume cache frio: sessões antigas sem esses registros esperam uma observação nova. O relógio de fallback usa 1h com `PI_CACHE_RETENTION=long`, 5 min nos demais casos; não mede o TTL efetivo do OpenAI.
- Mesma transformação local para Anthropic e OpenAI, antes da serialização do provider. Não usa context management/betas da API Anthropic nem pressupõe compatibilidade dessa API com OAuth. Alterar o prefixo pode exigir reescrita do cache; a política evita fazê-lo gratuitamente com cache quente.
- Cada lote `agent-tool-clear` é anexado ao branch ativo **antes** do envio, com IDs, hashes dos resultados originais e marcadores exatos. Turnos seguintes, reload, fork e retomada reaplicam os mesmos marcadores sem regravar o lote. A compactação também recebe esses marcadores. Os resultados originais continuam no journal: a economia é de contexto enviado, não de disco. A economia pendente só é descontada dos gatilhos até a próxima resposta com usage.

| Variável | Padrão | Efeito |
|---|---|---|
| `AGENT_TOOL_CLEAR` | ligada | `0` impede novos lotes; lotes já salvos continuam sendo reaplicados. |
| `AGENT_TOOL_CLEAR_MIN_TOKENS` | `150000` | Contexto mínimo para um lote. |
| `AGENT_TOOL_CLEAR_MIN_SAVINGS` | `40000` | Economia mínima estimada, já descontados os marcadores. |
| `AGENT_TOOL_CLEAR_KEEP_TURNS` | `3` | Turnos recentes preservados; nunca menos de 1. |

Valores numéricos inválidos, não inteiros ou ≤ 0 voltam ao padrão. `AGENT_CHILD=1` não instala os hooks de limpeza nem de replay.

Verificação offline: `scripts/test-tool-clear.mjs`, no portão de checks, usa Pi 1.5.2, perfil temporário sem credenciais e fake Anthropic em loopback; verifica também o serializador OpenAI. Na sessão sintética, o payload completo caiu de ~490.432 para ~249.305 tokens estimados por caracteres/4 (−241.127, ~49%). Com entrada a US$5/M, isso equivale a US$4,90 → US$2,49 numa escrita integral Anthropic de 1h e ~US$0,121 de leitura evitada por request seguinte; entrada OpenAI a US$1,25/M: ~US$0,301 evitado sem cache. São cenários de preço de lista, não usage medido nem cobrança. O controle com limpeza desligada preserva a saída original; mutações que retiram limpeza, replay, gate de cache quente ou compartilhamento entre loaders fazem os asserts falharem.

### skim e web_fetch com prompt

`skim` não roda sem prompt: só quando o agente chama a tool (sessão principal; filhos `scout`, `reviewer`, `planner`, `worker`). `web_fetch` com `prompt` faz o mesmo sobre a página inteira. Cada chamada é uma inferência num modelo barato com a sua conta; a resposta é curta, cita trechos com linha (`L<n>`) ou URL, diz quando a resposta não está na fonte e termina com `[skim: fonte · tamanho · model …]`. Não há resumo automático de saídas.

- `AGENT_SKIM_MODEL` (padrão `openai/gpt-6-luna,anthropic/claude-haiku-4-5`): lista `provider/id` em ordem de preferência. Modelo desconhecido, sem credencial ou com erro passa ao próximo; se todos falham, a tool devolve erro com o motivo de cada um, nunca a fonte. Thinking `minimal`, até 2000 tokens de saída, 120 s por tentativa.
- `AGENT_SKIM_MAX_CHARS` (padrão 400000, mínimo 1000): teto da fonte enviada. Acima disso vai cabeça (3/4) + cauda (1/4) com marcador, numeração de linha original, e o rodapé diz o corte. A 400k caracteres (~100k tokens) uma chamada custa ~US$ 0,01 no gpt-6-luna (US$ 0,10/M de entrada) e ~US$ 0,10 no Haiku 4.5 (US$ 1/M).
- `command` roda pela tool `bash` da própria sessão (`ctx.executeTool`): mesmos hooks, permissões e sandbox somente leitura dos filhos. A saída lida é a completa do bash (até 1 MiB), não o corte de 2000 linhas nem o corte dos filhos.
- Custo: o uso do modelo barato vai no resultado da tool, que o Pi soma no custo da sessão (rodapé e `/session`, bucket "Tools/summaries"); nos filhos, o runner soma esse custo ao do filho.

## Subagentes: sempre ligados, isolamento e auditoria

### Contrato

- A tool `subagent` está sempre ligada na sessão principal. Não há modos, atalho, comando nem variável para ligar ou desligar na sessão principal.
- Filhos (`AGENT_CHILD=1`) não lançam subagentes.
- Filhos também recebem `AGENT_NO_DELEGATE=1`, que o bash e o launcher preservam: um `agent` aberto de dentro de um filho não delega. Numa sessão humana aberta assim, remova a variável (`unset AGENT_NO_DELEGATE`) antes de abrir o `agent`.
- O system prompt da sessão principal traz a diretriz de orquestrador: "Act as an orchestrator: delegate recon and bulk reading to scout, isolated implementation to worker, and review to reviewer; keep your own context for decisions and integration".
- Outra diretriz pede ao pai que solicite caminhos, linhas e trechos curtos no resultado e não releia arquivos que o filho já resumiu, salvo para verificar um ponto específico. Motivo: reler o que o filho leu paga a mesma entrada de novo no contexto mais caro, o do pai.
- `.agent/workflow.md` não é criado automaticamente.
- `<perfil>/agent-preferences.json` guarda só `supportModel`.

### Modelo por papel

Ordem de decisão:

1. Config do papel em `/models` (`<perfil>/agent-models.json`).
2. Frontmatter do papel (`model`, `thinking`).
3. Slot: `.agent/rules.md`, com fallback para `.agent/workflow.md`; senão scout=apoio e os demais=principal.

O slot `apoio` usa o modelo de apoio; `principal`, o modelo da sessão. Não há classificador de dispatch. Sem modelo de apoio configurado, o slot `apoio` cai no modelo principal: papéis sem config própria em `/models` e sem `model` no frontmatter herdam o principal; os demais seguem os itens 1 e 2. Risco de custo: configure o apoio em `/models`.

O repo não distribui uma lista padrão de modelos por papel. Instalações antigas liam `~/Sistema/Pi/models.json` (ou `$PI_SYSTEM_DIR/Pi/models.json`); o runtime atual não lê esse caminho. Para preservar as escolhas antigas, faça backup e copie a configuração para `<perfil>/agent-models.json`, mantendo `tiers` e `roleModels`. A primeira opção de cada papel é a preferida, com seu `thinking`.

### Isolamento

Os papéis Pi rodam em outro processo `pi -p`, com contexto próprio. Só o resultado volta ao pai. O que o filho lê não entra no contexto nem no cache do pai.

`gemini` usa o Antigravity CLI oficial (`agy` no `PATH`; faça login no CLI antes), com acesso total: lê, roda comandos e edita (`--mode auto --dangerously-skip-permissions --sandbox`). O `--sandbox` do agy é uma camada extra: shell, rede e escrita fora do checkout seguem liberados, mas ele bloqueia escrita em `<cwd>/.git` (`git add`/`git commit` falham no checkout principal; num worktree isolado o commit funciona). Como papel de escrita, exige o brief completo (`objective`, `context`, `scope`, `done_when`, `stop_if`) e entra no isolamento por worktree quando há outro escritor em paralelo. Um papel `agy` customizado sem `edit`/`write` roda em `--mode plan --sandbox`. Em `/models`, selecione a linha `gemini`: **Enter** escolhe a família, **←/→** muda o thinking (`low`, `medium`, `high`, `xhigh`). O padrão é Gemini 4 Neon com `high`; sem preferência salva, um frontmatter customizado ainda pode fornecer `model` (ID nativo) e `thinking`.

A escolha fica em `agyModels.gemini` no `agent-models.json` do perfil. O painel usa um catálogo estático, sem consultar o CLI nem cadastrar um provider no Pi. O job passa o ID nativo e o esforço efetivo ao `agy`: por exemplo, Carbon com `xhigh` aparece como `xhigh → high` e vira `--model gemini-4-carbon-high --effort high`. Famílias sem sufixo no catálogo (Orchestrator) mantêm o ID fixo e recebem o thinking via `--effort`.
O resultado e o uso disponível ficam no registro do job; não há sessão JSONL do Pi nem `trace` para esse runner.

### Custo dos filhos

- `AGENT_CHILD_TOOL_OUTPUT_MAX` (padrão 8000 caracteres; `0` desliga): saída de `bash`/`read`/`grep`/`find`/`ls` maior que isso chega ao filho como cabeça (~6k) + cauda (~2k) e uma linha com o total omitido e o arquivo com a saída completa (`$TMPDIR/agent-child-output/<sessão>/`); com `skim` no papel, a linha sugere `skim path=<arquivo>`. A chamada de `bash` feita pelo próprio `skim` não é cortada. Motivo: saídas acima de 10k caracteres nos filhos custaram ~US$ 327 no 1º envio e ~US$ 390 em leitura de cache nos turnos seguintes em 30 dias. `read` com `limit` ≤ 200 linhas não é cortado. Os papéis pedem `rg -n` e trechos de até ~150 linhas.
- `AGENT_CHILD_CACHE_RETENTION` (padrão `short`, TTL 5 min; `long` = 1h): retenção de cache dos filhos, independente do `PI_CACHE_RETENTION=long` da sessão principal; `none` herdado continua `none`. Motivo: 100% da escrita de cache dos filhos Anthropic era TTL 1h (2× a entrada contra 1,25×), sobrepreço de ~US$ 198 contra ~US$ 45 de releitura perdida em 30 dias. O prefetch usa o TTL do filho.
- Prefixo estável: o filho roda com `--no-context-files`; o runner carrega os mesmos AGENTS.md/CLAUDE.md (perfil e ancestrais do `cwd` do filho, pela função do Pi) e os põe uma vez na mensagem da tarefa. O system fica papel + skills + `<cwd>`, e uma extensão do filho move o breakpoint de cache Anthropic para antes de `<cwd>`. Em Codex/OpenAI, a `prompt_cache_key` dos filhos ignora `<cwd>`/`<project_context>`: mesmo papel e modelo, mesma chave. Motivo: o 1º request de cada filho Codex acertava 3% do cache, e caminhos de worktree no meio do system impediam o reuso entre filhos.

### O que o pai consegue auditar

- **Registro do job:** `<perfil>/subagent-jobs/<sessionId>/<jobId>.json`, modo 0600, gravado atomicamente. Uma entrada por tarefa: papel, brief, `cwd`, modelo usado, thinking, usage e caminho do JSONL do filho. O caminho do JSONL entra no registro quando a tarefa começa. Estado por tarefa: `running`, `completed`, `failed`, `not_run` (o job parou antes dela) ou `interrupted` (o pai caiu com a tarefa rodando; o JSONL fica no registro). Estado e usage são gravados quando a tarefa termina, não só no fim do job. Num job `parallel`, uma tarefa que lança exceção não derruba as outras: o job espera todas, continua cancelável até lá e termina `failed` com o resultado das que concluíram. Registros anteriores a essa auditoria mostram `legacy`: `status`/`trace` associam as sessões do job às tarefas por índice quando as contagens batem; senão `trace` lista as sessões sem atribuí-las.
- **Sessões filhas:** cada filho grava o JSONL oficial do Pi, com `parentSession` apontando para a sessão do pai. O JSONL tem mensagens, tool calls, resultados e uso por turno.
- **Ações da tool**, sempre com `jobId` da sessão atual:
  - `status`: estado do job e, por tarefa, o caminho do JSONL, já durante a execução.
  - `result`: saída final (`offset`/`limit` em bytes, até 8 KB por leitura).
  - `trace`: resumo passo a passo do JSONL de um filho (`jobId`, `taskIndex` opcional, `offset`/`limit`). Mostra texto do assistant, tool calls com argumentos resumidos, `ok`|`erro` com bytes do resultado, modelo, turnos e usage. Thinking bruto não sai.
  - `list` e `cancel`.
- Ao terminar, o pai recebe uma mensagem `subagent-result` com até 4 KB do resultado, o caminho do registro, modelos e uso; essa mensagem fica no JSONL do pai.
- **Escritores em paralelo:** dois ou mais papéis com `edit`/`write` no mesmo repositório, num job `parallel`, rodam cada um num worktree próprio (`<perfil>/agent/worktrees/<jobId>-<n>`, branch `agent/<jobId>-<n>`). O resultado traz `git status` e `git log` desde o commit base. Nada é integrado sozinho: `integrate` (roda o portão de checks se houver manifesto e faz `merge --no-ff`) ou `discard` (`force:true` para descartar trabalho não commitado), com `taskIndex` opcional.

### Lacunas

- stderr do filho fica só em memória (até 64 KB) e só aparece no resultado quando a tarefa falha.
- O system prompt do papel vai por arquivo temporário, apagado no fim. O registro guarda o nome do papel, não o texto. As fontes `.agent/rules.md` + `.agent/header.md` (ou workflow.md legado sem rules.md) anexadas à tarefa ficam no JSONL do filho.
- Escritor único (single, chain, ou `parallel` com um só escritor) grava direto no `cwd`, sem worktree nem diff registrado. Use `git` para ver o que mudou.
- Sandbox só cobre o `bash` de papéis sem `edit`/`write`: seatbelt no macOS, bwrap no Linux, `none` sem suporte. O resultado informa `sandbox=`. Sem sandbox, o detector compara só o `git status` do checkout antes e depois; escrita fora do checkout Git não é vista.
- `list` apaga o registro de jobs terminados há mais de 30 dias, junto com worktrees limpos e já integrados. Worktree sujo ou não integrado preserva o registro. Os JSONL dos filhos ficam.
- O prefetch (`AGENT_CACHE_PREFETCH_NEXT=1`) roda com `--no-session`; seu custo não entra em usage.

## Dependências pessoais / degradação

O código de `agent/` não depende de caminhos literais `/Users/biel` (só um exemplo em `agent/extensions/agent/web/README.md`). `lib/paths.ts` conserva a descoberta opcional de `/mnt/garime` e `~/Sistema` (ou `PI_SYSTEM_DIR`); sem o mount usa o HOME local.

| Extensão | Sem infraestrutura pessoal |
|---|---|
| vault-runtime | Somente com `AGENT_VAULT=1`. Sem opt-in mantém o prompt nativo e não depende de Vault. Nenhum dado pessoal é migrado. |
| subagent | Papéis/modelos usam o perfil do Agent, não o Vault. Sem modelo de apoio configurado, papel sem config própria em `/models` e sem `model` no frontmatter herda o modelo principal. Allowlists e confirmações de agentes do projeto continuam aplicáveis; falhas de quota não trocam o modelo silenciosamente. Gate Megamind explicitamente configurado continua falhando fechado. |
| models | `/model` mantém o seletor nativo. `/models` usa `agent-models.json` no perfil para escolhas por papel; `agent-preferences.json` guarda preferências de recursos, não contabilidade. Nenhuma configuração pessoal é distribuída. |
| generate-image | Execução exige configuração do modelo de imagem no perfil e autenticação própria. Falta deles vira erro da tool, não erro de startup. |
| compaction | Usa geração, prompt e validação nativos do Pi, sem impor Luna ou executar aprendizado auxiliar. O cache-keeper mantém suas proteções de compactação. |
| herdr-agent-state | Já inerte sem HERDR_ENV=1, socket e pane; erros de socket tratados. |
| tui | Código local, não depende de serviço Garime. Recursos interativos guardados por modo/UI; logs usam HOME local. |
| accounts | Preserva autenticação e contas locais do usuário; nenhuma credencial é copiada de outro perfil. Mirror só opera com dados locais existentes. |
| peers | IPC local em HOME/PI_MESH_DIR, sem serviço pessoal remoto; pasta é criada em runtime. |
| cost, sessions | Leem sessões locais; histórico vazio é válido. `03-sessions-explicit-gc-only.patch`: `sessions` não poda no `session_start`; apagar sessão velha/vazia só por `/gc` explícito. |
| image-normalize | Normalização local; nenhuma pasta pessoal obrigatória. |
| project-operator, checks | Operam sobre o projeto atual; não exigem repositórios pessoais. |
| ask-user, btw, checkpoints, codex-fast, files, plan, slash-anywhere, todos, tool-lexicon, whimsical | Sem infraestrutura pessoal obrigatória. |

Patches de compatibilidade ficam em `agent-patches/`.

## Verificação

```sh
for t in scripts/test-*.mjs; do ORCA_BACKGROUND_LAUNCH=1 node "$t" || exit; done
```

O teste de startup usa o Pi instalado, mas HOME, agent-dir, cwd e store temporários e ambiente sem credenciais herdadas. Carrega exatamente os registros instalados e abre `pi --mode json -p`, conferindo tools e os cinco papéis. O provider aponta para loopback fechado com chave fictícia: a falha de conexão é esperada, não há inferência real. Sem Pi instalado o teste informa que pulou; isso não equivale a validar startup. Não é teste visual da TUI.

## Contexto do projeto e regras

Edite `.agent/rules.md` (regras, incluindo a receita antes em workflow.md) e
`.agent/header.md` (cabeçalho curto). O Agent gera `AGENTS.md` para outras CLIs:
marcador de gerado no topo, header + rules e ponteiros para `.agent/notes.md`,
`STATUS.md`, `HISTORY.md` e `docs` quando existirem. O pessoal
`~/.agent/AGENTS.md` continua inteiro no Pi e nunca é copiado para o projeto.

No Agent, AGENTS.md gerado não é injetado: entram rules + header inteiros e
ponteiros absolutos para AGENTS.md e os documentos existentes. STATUS é só
ponteiro; seu corpo não entra. Arquivos manuais continuam inteiros, com uma
dica de `/rules init`. O montador nunca sobrescreve um AGENTS.md manual.

- `/rules init` envia ao agente o pedido de separar o AGENTS.md manual nas duas
  fontes, incorporar workflow.md e substituir explicitamente o arquivo manual
  pela versão marcada. Confira a migração como qualquer edição do agente.
- `/remember <texto>` oferece salvar em `~/.agent/AGENTS.md` ou
  `.agent/rules.md` e acrescenta `- texto`. Cancelar não grava. Sem UI, grava
  no projeto somente se rules.md existir; caso contrário informa erro.
- O AGENTS.md em disco é remontado no início da sessão, após `/remember` e
  após edit/write em rules/header. Alterações externas são lidas na próxima
  sessão. O contexto injetado é um snapshot fixo por sessão, inclusive após
  esses comandos: abra outra sessão para usar regras novas. Não há patch no Pi.
- Filhos recebem as mesmas fontes no lugar do AGENTS.md gerado, na mensagem
  da tarefa. workflow.md só é fallback se rules.md não existir.

O check `agent-project-context` valida a montagem determinística, a sincronia
deste repo e o system prompt realmente enviado pelo Pi a um provider falso
em loopback, sem credenciais e sem chamadas pagas.
