# Setup do Agent

## Instalação por artefato

A chave pública oficial ainda não está provisionada. Sem uma chave configurada, a instalação remota é recusada. Veja [como provisionar a chave](#provisionar-a-chave-de-assinatura-mantenedor). Para instalar offline, use `AGENT_RELEASE_DIR` ou `--install-artifact <arquivo>`: esses modos conferem SHA-256 contra `SHA256SUMS`, sem verificar a assinatura Ed25519.

A v0.1.0 contém somente darwin-arm64 e não traz `latest.json` nem `SHA256SUMS.sig`, então não é instalável pelo canal HTTPS assinado. A primeira release assinada ainda não foi publicada.

Nota: a instalação no Windows nativo e o workflow no GitHub Actions ainda não foram validados.

Pré-requisitos: Bash em macOS/Linux, ou PowerShell em Windows x64. Node não é exigido na máquina: o instalador provê o Node 24 portátil em `<store>/node` (seção Node portátil). O canal HTTPS não usa `gh`; repositório privado exige `AGENT_RELEASE_TOKEN`. Em Windows x64 nativo, também instale **Git for Windows** (Git Bash é usado pelo shell do Pi). Em macOS/Linux, não precisa de Git; nenhuma plataforma precisa de npm, clone ou build na máquina do consumidor. Não use WSL para instalar o pacote win32-x64.

Com uma release publicada e assinada e a chave oficial provisionada, instale em uma linha (repositório público, sem token):

```sh
curl -fsSL https://github.com/GabrielMendonca1/agent/releases/latest/download/install.sh | bash
```

Versão fixa: `curl -fsSL https://github.com/GabrielMendonca1/agent/releases/download/<tag>/install.sh | AGENT_VERSION=<tag> bash`.

Inspecionar antes de executar (recomendado):

```sh
curl -fsSL -o install.sh https://github.com/GabrielMendonca1/agent/releases/latest/download/install.sh
less install.sh
bash install.sh
```

Depois da instalação:

```sh
export PATH="$HOME/.local/bin:$PATH"
agent
# Na conversa: /login — sua própria conta do provider
```

**Origem do script inicial.** `install.sh` e `install.ps1` não são verificados por assinatura antes de rodar: quem executa o one-liner confia na origem HTTPS do arquivo (o repositório `GabrielMendonca1/agent` ou o mirror que você escolheu). A chave pública fica dentro desse script, então um script adulterado poderia trocar a chave. A assinatura Ed25519 protege o que o script baixa depois, não o próprio script. Para outra origem, baixe, inspecione e confira por canal independente antes de executar.

### Windows x64 (PowerShell)

Uma linha, sem token em repositório público:

```powershell
irm https://github.com/GabrielMendonca1/agent/releases/latest/download/install.ps1 | iex
```

Versão fixa: `$env:AGENT_VERSION = 'vX.Y.Z'; irm https://github.com/GabrielMendonca1/agent/releases/download/vX.Y.Z/install.ps1 | iex`. `irm | iex` não passa argumentos (`--adopt-launcher`, `--store`), e o script termina com `exit`, o que pode encerrar a sessão interativa. Para argumentos ou inspeção, use a forma com arquivo:

```powershell
Invoke-WebRequest -Uri https://github.com/GabrielMendonca1/agent/releases/latest/download/install.ps1 -OutFile ./install.ps1
# inspecione ./install.ps1 antes de executar
pwsh -NoProfile -File ./install.ps1 --adopt-launcher
& "$env:USERPROFILE/.local/bin/agent.cmd" --version
& "$env:USERPROFILE/.local/bin/agent.cmd" overlay-status
& "$env:USERPROFILE/.local/bin/agent.cmd" migrate-from-mark --dry-run --json
```

O script também pode ser executado com `powershell -NoProfile -File`; respeite a política de execução local (não a altere automaticamente). O app deve aguardar o código de saída antes de lançar o Agent. `install.ps1` baixa `agent-distribution.mjs`, `SHA256SUMS` e `SHA256SUMS.sig` por HTTPS, verifica a assinatura Ed25519 e o SHA-256 do bootstrap antes de executá-lo, e chama `install`. A CLI aceita `install --tag <tag>` e opções do updater, como `--adopt-launcher` e `--store <path>`. Código 0 significa ativação concluída; falha retorna código não zero (erros do bootstrap: 1) com diagnóstico em stderr; stdout é log de progresso, não JSON. Não faça parsing de mensagens de progresso.

Os launchers são `%USERPROFILE%\.local\bin\agent.cmd` e `agent.ps1`; perfil padrão `%USERPROFILE%\.agent`, store `%USERPROFILE%\.local\share\agent`. Não há alteração de PATH, shell rc nem login automático. O comando de migração retorna JSON com `--json`; `--dry-run` não escreve. Uma migração efetiva preserva wrappers Mark reconhecidos como `pi.cmd.before-agent-migration` / `pi.ps1.before-agent-migration` (sufixo numérico se necessário), encaminha para `agent.cmd` e usa junctions absolutos para diretórios de skills. Wrappers desconhecidos são preservados.

`AGENT_RELEASE_DIR=<diretório>` permite instalar offline um dist local, sem rede: exige bootstrap, SHA256SUMS e exatamente um tarball da plataforma. Nesse modo não se infere identidade de release, e a confiança é só o diretório escolhido: a verificação é SHA-256 contra `SHA256SUMS`, sem Ed25519. O formato schema 1/runtimeContract 3 permanece compatível com v0.1.0; `install.sh` também aceita o bootstrap antigo dessa release.

Use `AGENT_VERSION=<tag>` para fixar uma release (sem ela, `latest`). `AGENT_RELEASE_REPO=owner/repo` escolhe outro repositório GitHub; `AGENT_RELEASE_BASE_URL` escolhe uma origem própria; `AGENT_RELEASE_TOKEN` (ou `GITHUB_TOKEN`) autentica o acesso. A confiança vem da assinatura Ed25519 de `SHA256SUMS`, não do canal: um mirror só instala o que estiver assinado pela chave embutida. Nenhum download usa HTTP fora de loopback, e nenhuma auth do Mark é copiada. Busca web e Megamind podem exigir configuração própria; não são autenticação do chat.

Padrões: store `~/.local/share/agent`, comando `~/.local/bin/agent`, perfil `~/.agent`. `AGENT_STORE` e `PI_CODING_AGENT_DIR` explícitos prevalecem. Para copiar o perfil Mark existente sem apagar a origem, use `agent migrate-from-mark` (detalhes abaixo). O bootstrap não altera shell rc. Adicione `~/.local/bin` ao PATH. Um store alternativo só adota `~/.local/bin/agent` com `--adopt-launcher` explícito.

```sh
agent update                 # canal configurado, sem build; erro de acesso preserva a instalação
agent overlay-rollback       # revalida o par anterior antes de trocar
agent overlay-status
node scripts/agent-update.mjs --install-artifact latest
node scripts/agent-update.mjs --install-artifact <tag>
node scripts/agent-update.mjs --install-artifact /caminho/agent-<id>-<os>-<arch>.tar.gz
# O arquivo SHA256SUMS deve estar no mesmo diretório do archive local.
```

### Estado sem chave pública

Com a chave ainda vazia, a instalação remota por `install.sh` ou `install.ps1` executa nesta ordem: (1) provisiona o Node portátil em `<store>/node`, se necessário, o que faz conexão com `nodejs.org` (ou `AGENT_NODE_BASE_URL`); (2) só então falha com `Release public key is not configured`. Nenhuma release é baixada e o Agent não é ativado, mas o Node fica instalado no store. Essa ordem é a atual. A instalação offline (`AGENT_RELEASE_DIR`) não usa a chave: confere só SHA-256 e funciona sem ela, com Node do sistema ou portátil já existente, sem conexão.

### Canal HTTPS, variáveis e origem

Sem `gh`, o instalador, `agent update` e `--install-artifact latest|<tag>` leem a release por HTTPS:

- Padrão (público, sem token): `https://github.com/<repo>/releases/latest/download/latest.json`; com `AGENT_VERSION=<tag>`, `https://github.com/<repo>/releases/download/<tag>/<arquivo>`. `<repo>` é `AGENT_RELEASE_REPO` (padrão `GabrielMendonca1/agent`).
- Repositório privado: defina `AGENT_RELEASE_TOKEN` (ou `GITHUB_TOKEN`). Com token, a descoberta usa a API de releases do GitHub e os assets são baixados pela API. O token vai só em `Authorization: Bearer` e é descartado em redirect para outra origem.
- Origem própria: `AGENT_RELEASE_BASE_URL=https://host/caminho` (CDN, R2, servidor interno). Espera `<base>/latest.json` e `<base>/<tag>/<arquivo>`. Só HTTPS; `http://127.0.0.1` e `localhost` servem apenas a testes. Ao atualizar sem `AGENT_RELEASE_BASE_URL`, o Agent reutiliza a base gravada na instalação ativa sem enviar tokens. Para autenticar no mirror, defina explicitamente `AGENT_RELEASE_BASE_URL` e `AGENT_RELEASE_TOKEN`. `GITHUB_TOKEN` nunca é enviado a um mirror.
- `AGENT_RELEASE_PUBLIC_KEY` substitui a chave pública embutida. Uso restrito a testes e canais privados explícitos: quem controla essa variável escolhe em quem confiar.
- O token não é gravado em `active.json` nem em `release-identities.json`, e não deve aparecer em logs ou no stdout.

### Node portátil

- Versão fixa: Node v24.22.3 (`scripts/lib/portable-node.mjs`; hashes oficiais também fixados em `install.sh` e `install.ps1`). Layout: `<store>/node/v24.22.3/bin/node` (Windows: `v24.22.3/node.exe`) e `<store>/node/current` (link; junction no Windows).
- Instalação remota: usa o Node portátil, salvo `AGENT_USE_SYSTEM_NODE=1` com `node` >=22.19 no PATH. Se `<store>/node/v24.22.3/bin/node` não existir, baixa o arquivo oficial (`node-v24.22.3-<alvo>`) de `AGENT_NODE_BASE_URL` (padrão `https://nodejs.org/dist`; base HTTPS, ou loopback em teste), com limite de 128 MiB no instalador Bash, e confere o SHA-256 fixo no script antes de extrair. Alvos: darwin-arm64 e darwin-x64 (`.tar.gz`), linux-x64 e linux-arm64 (`.tar.xz`), win32-x64 (`.zip`). `AGENT_NODE_SHA256` substitui o hash apenas com base em loopback. Se já existir, reaproveita: `agent update` não baixa Node de novo.
- Offline (`AGENT_RELEASE_DIR`): usa o `node` do sistema se for >=22.19. Sem ele, falha, salvo se o Node portátil já existir ou `AGENT_PORTABLE_NODE=1` (que permite baixar). `AGENT_PORTABLE_NODE=1` força o portátil em qualquer modo.
- Os wrappers `agent` e `agent.cmd` usam `<store>/node/current` quando existe e caem para `node` do PATH.
- `overlay-gc` nunca remove `<store>/node`. `agent overlay-status` imprime `Portable Node: present`, `no active binary` ou `not installed`.

### Assinatura e cadeia de confiança

- `SHA256SUMS` lista o SHA-256 de cada tarball, de `install.sh`, `install.ps1`, `agent-distribution.mjs` e de `latest.json`.
- `SHA256SUMS.sig` é a assinatura Ed25519 dos bytes exatos de `SHA256SUMS`, em base64 de 64 bytes, numa linha.
- Download remoto, em ordem fixa:
  1. baixa `latest.json` (da origem ou da tag);
  2. baixa `SHA256SUMS` e `SHA256SUMS.sig` e verifica a assinatura. Sem chave configurada, nenhuma conexão de download é aberta. Assinatura ausente, inválida ou de outra chave aborta;
  3. confere o SHA-256 de `latest.json` e do tarball contra `SHA256SUMS`;
  4. só então extrai e ativa.
- `install.sh` e `install.ps1` fazem a mesma cadeia antes de executar o bootstrap: assinatura de `SHA256SUMS` com a chave embutida; SHA-256 de `latest.json` e de `agent-distribution.mjs` contra `SHA256SUMS`; só então gravam o módulo e o executam. O `agent-distribution.mjs` verifica o tarball de novo antes de extrair.
- A assinatura prova origem e bytes, não frescor. Um mirror pode servir uma release antiga assinada. Para fixar uma versão, use a tag.
- Chave pública: constante `RELEASE_PUBLIC_KEY_PEM` em três arquivos: `scripts/lib/agent-distribution.mjs`, `scripts/install.sh` e `scripts/install.ps1` (dentro do bootstrap embutido). Hoje está vazia nos três. Sem ela, `agent update` e `--install-artifact latest|<tag>` falham antes de qualquer conexão com `no Ed25519 release public key configured`, e o bootstrap com `Release public key is not configured`. `--install-artifact <arquivo>` local não usa a chave.
- Offline não tem verificação Ed25519 (ver acima).

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

Instalações remotas registram em `<store>/active.json` o objeto opcional `release: { tag, assetId, repo, baseUrl? }`. `baseUrl` só é gravado para mirrors e indica a origem usada no próximo update se `AGENT_RELEASE_BASE_URL` não estiver definida. A tag é resolvida antes do download e usada explicitamente nele, mesmo para `latest`. `assetId` é o `releaseId` do manifesto: o `<id>` em `agent-<id>-<os>-<arch>.tar.gz`, não o ID numérico do GitHub nem o ID interno do runtime. O rollback restaura os valores do par anterior. Checkout, archive local e `AGENT_RELEASE_DIR` não declaram uma release remota. Com `AGENT_RELEASE_BASE_URL`, `release.repo` continua sendo `AGENT_RELEASE_REPO` (padrão `GabrielMendonca1/agent`), não a origem do mirror.

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

## Provisionar a chave de assinatura (mantenedor)

Esta seção é procedimento humano. Nenhum passo aqui é executado pelo código do repositório nem por este change.

Estado: não há chave pública oficial embutida. Até a provisão, instalações remotas falham fechado. Não afirme que produção tem chave enquanto o passo 3 não estiver mergeado.

1. Gerar o par uma única vez, fora do repositório (o `.gitignore` não cobre `*.pem`). Em macOS/Linux:

```sh
install -d -m 700 "$HOME/agent-release-keys"
node scripts/agent-dist.mjs --keygen \
  --out-pub "$HOME/agent-release-keys/release-public.pem" \
  --out-priv "$HOME/agent-release-keys/release-private.pem"
```

`--keygen` não sobrescreve arquivos existentes e grava a privada com modo 0600. Sem `--out-pub`/`--out-priv`, o par vai para um diretório temporário novo impresso no stdout; prefira caminhos explícitos.

2. Guardar a privada no cofre de segredos do mantenedor, com backup. Não colar em chat, issue, log, commit ou worktree. Remover a cópia de trabalho depois de configurar o segredo de CI.

3. Publicar a pública por PR: substituir `RELEASE_PUBLIC_KEY_PEM` em `scripts/lib/agent-distribution.mjs` pelo conteúdo de `release-public.pem` (SPKI PEM). Replicar o mesmo valor em `install.sh` e `install.ps1`. Antes de publicar, o workflow verifica se as três cópias contêm a chave pública correspondente ao segredo de assinatura. Nos bootstraps a constante é JS entre aspas simples; PEM multilinha precisa de crase ou escapes `\n`.

4. Configurar o segredo de CI `AGENT_RELEASE_SIGNING_KEY` com o conteúdo de `release-private.pem` (PEM literal ou base64 dele; `agent-dist.mjs` aceita os dois):

```sh
gh secret set AGENT_RELEASE_SIGNING_KEY < "$HOME/agent-release-keys/release-private.pem"
```

O job `publish` do workflow (só com `workflow_dispatch` e `publish=true`) lê esse segredo em `AGENT_SIGNING_PRIVATE_KEY`, falha se estiver vazio, faz o merge com `--tag` e publica somente nesse opt-in. Não há assinatura de fallback.

5. Verificar a cadeia antes de qualquer publicação. Gerar um dist assinado com tag de teste fora do repositório e conferir a assinatura com a pública:

```sh
OUT="$(mktemp -d)/dist"
node scripts/agent-dist.mjs --merge <dir-mac> <dir-win> --out "$OUT" --tag vX.Y.Z \
  --sign-key "$HOME/agent-release-keys/release-private.pem"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { verifyManifestSignature } from "./scripts/lib/agent-distribution.mjs";
  verifyManifestSignature(process.argv[1] + "/SHA256SUMS", process.argv[1] + "/SHA256SUMS.sig", readFileSync(process.argv[2], "utf8"));
  console.log("assinatura ok");
' "$OUT" "$HOME/agent-release-keys/release-public.pem"
```

Para testar o caminho HTTPS completo sem publicar, sirva o dist em um servidor loopback de teste e use `AGENT_RELEASE_BASE_URL=http://127.0.0.1:<porta>`, com `AGENT_RELEASE_PUBLIC_KEY="$(cat "$HOME/agent-release-keys/release-public.pem")"` (conteúdo PEM, não caminho) quando a chave embutida ainda não existir. Não use `gh release create` nem o workflow de publicação para esse teste.

Rotação e perda da privada não estão definidas no código. Perda impede novas releases com a chave embutida. Comprometimento exige decisão do mantenedor e nova versão do instalador com outra chave; não publique com chave comprometida.

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

A saída é um ustar gzip determinístico para os mesmos bytes de entrada, mais `install.sh`, `install.ps1`, bootstrap independente `agent-distribution.mjs` e SHA256SUMS. Sem chave de assinatura não há `SHA256SUMS.sig` nem `latest.json`, e o pacote serve só para instalação offline. O build normal ainda depende das fontes/dependências upstream fixadas; timestamps de builds distintos podem diferir. O pack remove `sourceRepo` da metadata e faz scan de arquivos de estado/chaves e paths pessoais em metadata. Isso não substitui revisão humana de segredos nem prova suporte a outro SO. Cada pacote declara apenas o par SO/arquitetura do build; rode startup real com provider falso e o gate completo nesse par antes de publicar. Esta implementação não publica, cria release, faz push ou migra o host.

### Distribuição multi-host e CI

Cada host gera seu próprio dist e SHA256SUMS. Una diretórios em uma saída nova; o merge verifica os hashes de entrada, recusa nomes com bytes conflitantes e calcula um único SHA256SUMS com ambos os instaladores:

```sh
node scripts/agent-dist.mjs --merge dist-mac dist-win --out dist-merged
```

Para assinar (exige tag e chave juntas): acrescente `--tag <tag> --sign-key <chave-privada.pem>` ao `--merge`, ou defina `AGENT_SIGNING_PRIVATE_KEY` (PEM ou base64). A saída ganha `latest.json` e `SHA256SUMS.sig`. `AGENT_RELEASE_REPO` define o repositório gravado em `latest.json`.

Em Windows o staging usa nomes curtos (`ad-*`, `h`, `s`); `AGENT_DIST_TMP` permite escolher uma raiz curta gravável (no CI: `C:\adtmp`). Variáveis essenciais do Windows são preservadas ao filtrar credenciais do ambiente de build. Recomenda-se uma raiz curta também para checkout e instalação.

O workflow `.github/workflows/agent-dist.yml` aceita `workflow_dispatch` ou push na branch `ci/agent-dist`. Constrói em 5 plataformas (macos-14/arm64, macos-15-intel/x64, ubuntu-24.04/x64, ubuntu-24.04-arm/arm64, windows-2022/x64) com Node 24 e salva artifacts `agent-<plataforma>`. Os smokes Linux e Windows instalam o dist local (`AGENT_RELEASE_DIR`) em HOME/store temporários, com perfil Mark falso, e verificam que nenhuma credencial é criada. O job `publish` faz o merge dos 5 hosts com `--tag`, assina com `AGENT_RELEASE_SIGNING_KEY` (falha se ausente) e cria ou atualiza a release com `dist/*`, incluindo `latest.json` e `SHA256SUMS.sig`. Nenhuma execução no GitHub foi feita nesta integração.

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

- As skills de integração `peers` e `megamind` são automáticas, assim como as de `agent/skills/system/`. `design/` e `dev/` (incluindo `/skill:pr`) ficam sob demanda e geram uma linha curta por categoria no system prompt. A curadoria usa o formatter compartilhado entre os hosts.
- `/skill` ou `/skill:` abre o catálogo agrupado por categoria.
- `/models` separa slots de execução, escolhas por papel e presets do swarm. No papel, **Enter** abre o picker com os modelos autorizados primeiro; escolher um novo o autoriza com o thinking da preferência atual. **←/→** muda o thinking só do par ativo daquele papel, sem alterar a sessão nem os tiers. Se o papel ainda não tem modelo configurado, escolha um com **Enter** antes de usar as setas. `Esc Esc` abre só a lista de fork. Falha de quota/503 não troca modelo silenciosamente: só papel somente leitura tenta, uma vez e registrando, o próximo modelo da sua lista (ver "Falha por cota").
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

### Deploy com sessões abertas

`agent update`, `agent overlay-update` e `node scripts/agent-update.mjs` podem rodar com sessões abertas. Uma sessão aberta continua no build com que começou até ser reiniciada: a release Pi e o artefato Agent (`<store>/runtime/releases/<id>`) ficam fixos no processo.

- O launcher passa caminhos físicos: `AGENT_PI_ROOT` (release Pi), `NODE_OPTIONS --import=<artefato>/agent/core/runtime.mjs` e `AGENT_ARTIFACT_ROOT` (artefato). Os filhos (subagentes) herdam os três e rodam o mesmo `dist/cli.js` do pai.
- O deploy reescreve `extensions`/`skills` do `settings.json` e o link `<store>/skills`. O Pi relê esse arquivo em `/new`, `/resume`, fork, `/reload` e em cada filho. O preload (`agent/core/artifact-pin.mjs`) reescreve, nessa leitura, toda entrada que aponta para outro artefato ou para `<store>/skills` para o artefato do processo. Uma entrada que só existe no build novo é ignorada. Se a sessão antiga gravar `extensions`/`skills` (por exemplo `pi install`), grava os caminhos do artefato dela; o próximo `agent update` reaplica o registro.
- A limpeza não apaga o que um processo vivo usa. `agent overlay-gc` e o GC do update consultam `ps eww` (argumentos e ambiente) e `lsof`. Release Pi, artefato Agent e overlay bundle citados ou abertos por um processo vivo ficam ("in use by running process N") e saem num GC depois que o processo termina. Sem inspeção de processos (Windows), artefatos e symlinks de release ficam.

## Checkpoints de arquivo e /rewind

Antes de cada `edit`/`write` do agente na sessão principal (também os chamados de dentro do `codemode`), a extensão `brain-live/checkpoints.ts` guarda o conteúdo anterior do arquivo, ou o marcador "não existia", associado à mensagem do usuário que abriu o turno. Só a primeira mudança de cada arquivo por turno é guardada. Depois de cada edição registra o hash que o agente deixou.

`/rewind` lista os turnos do ramo atual, do mais novo ao mais antigo, com o texto do pedido e os arquivos que o agente mudou nele:

```
Voltar para antes de qual turno? (edit/write da sessão e escritores sem worktree em Git; bash da sessão não é rastreado)
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

- Código: cada arquivo tocado desde o turno escolhido volta ao estado de antes dele; arquivo criado pelo agente é apagado. Vale a ordem de captura dos arquivos, de qualquer ramo da conversa.
- Conversa: `ctx.navigateTree` até a mensagem escolhida, o mesmo mecanismo do `/tree` (sem resumo do ramo abandonado). O ramo antigo continua no `/tree` e o texto do pedido volta ao editor.
- Se um arquivo mudou depois da última edição do agente (editor, `bash`, outro processo), o `/rewind` lista os arquivos e pergunta: sobrescrever, pular os alterados ou cancelar.
- Não rastreia `bash` da sessão principal nem grava checkpoints dentro dos filhos (`AGENT_CHILD=1`). O pai tenta capturar as mudanças dos escritores sem worktree próprio em Git, mesmo se o filho falhar. Espere o job terminar antes de usar `/rewind`. As mudanças detectadas pela varredura podem incluir edições suas: o `/rewind` lista os arquivos e exige confirmação explícita antes de restaurá-los. Se um arquivo mudar entre a revisão e a aplicação, ele é pulado e aparece no relatório. Arquivos acima de 20 MiB não têm restauração.
- Só roda com o agente parado. `/fork` e `/clone` criam sessão nova sem os checkpoints da anterior. O double-Esc continua abrindo o `/tree`, que não mexe em arquivos.

Disco: `<perfil>/checkpoints/<sessionId>/index.jsonl` (registro append-only) e `blobs/<sha256>` (conteúdo, deduplicado). Persistem ao retomar a sessão. No início de cada sessão, apaga os checkpoints de sessões sem uso há mais de `AGENT_CHECKPOINTS_DAYS` dias (30) e, se o total passar de `AGENT_CHECKPOINTS_MAX_MB` (500), os das sessões menos recentes; a sessão atual nunca. `AGENT_CHECKPOINTS=0` desliga a gravação e o comando. Não adiciona tool nem texto ao prompt.

## Handoff entre sessões (/next e /handoff)

- `/next [foco]` roda a skill `handoff`, espera o `.agent/handoff.md` mudar e abre uma sessão nova. `--keep` compacta a sessão atual em vez de trocar. Se o arquivo não mudou, a sessão fica como está e aparece um erro. A sessão nova recebe o handoff na primeira mensagem sem os filtros de idade e branch. A entrada `agent-next` guarda o sha256 do arquivo que o `/next` carimbou, e só esse arquivo passa sem filtro: reabrir a sessão depois, com outro handoff, volta aos filtros normais.
- A skill escreve só o corpo. O Agent carimba o frontmatter (`session`, `created_at`, `branch`, `head`) quando `write` ou `edit` gravam `.agent/handoff.md`. O `/next` carimba de novo antes de trocar, o que cobre um handoff gravado via `bash`. O carimbo substitui qualquer frontmatter anterior.
- Na primeira mensagem do usuário numa sessão nova, o handoff entra no contexto do modelo (invisível na TUI) e vira `.agent/handoff.consumed.md` quando estas condições valem juntas:
  - a sessão é nova: ainda não tem resposta do assistente;
  - a branch atual é a do carimbo;
  - o `HEAD` é o commit do carimbo ou descende dele (`git merge-base --is-ancestor`);
  - a idade é menor que `AGENT_HANDOFF_MAX_AGE`. O padrão é 24 h. Aceita número com unidade `s`, `m`, `h` ou `d`; número puro conta como horas.
- Fora de um repositório git, só a idade conta. Um repositório sem commits (branch ainda sem nascer) continua sendo git: a branch é comparada, e um carimbo sem `head` vale para qualquer `HEAD` da mesma branch. A idade vem de `created_at`; sem carimbo, do mtime do arquivo.
- Caso contrário, nada é descartado. A TUI mostra uma linha, por exemplo `A handoff from 3 h ago on branch X is pending; use /handoff to load it.`. A linha diz também se o commit do carimbo sumiu (rebase/amend), se o `HEAD` não descende dele ou se o arquivo não tem branch/commit.
- `/handoff` carrega o handoff pendente na próxima mensagem, mesmo antigo ou de outra branch. Nesse caso, o modelo recebe junto uma nota de que ele pode estar desatualizado e por quê. O `/handoff` só agenda: o arquivo vira `.agent/handoff.consumed.md` quando a mensagem sai de fato. Fechar a sessão antes disso mantém o `.agent/handoff.md`.

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

## Proteção contra loops de ferramentas

O loop guard avisa após 3 resultados idênticos seguidos, ou 3 repetições de um ciclo de 2 ou 3 chamadas com os mesmos argumentos e resultados. Após 5 repetições, bloqueia a sexta tentativa da mesma chamada. Para ciclos, só bloqueia a chamada que iniciaria a sexta repetição se todas as chamadas do ciclo retornaram erro; se houve sucesso, só avisa. Resultados diferentes quebram a repetição, chamadas aninhadas não contam e uma nova mensagem sua limpa o histórico. Para desligar: `AGENT_LOOP_GUARD=0`.

## Custo: o que roda sem prompt

Chamadas pagas que não saem de uma mensagem sua. Todas usam a sua conta ou chave do provider.

| Recurso | Gatilho | Padrão | Desligar |
|---|---|---|---|
| Cache-keeper | Sessão principal ociosa, modelo Anthropic com `cache_control`. Reenvia o último payload inteiro com `max_tokens` 1 a 90% do TTL: a cada 54 min (TTL 1h) ou 4 min 30 s (TTL 5 min). | Ligado. | `AGENT_CACHE_KEEPER=0` |
| Compactação ociosa | Contexto ≥ 200k tokens e o aquecimento acabou (janela fechada, ping pulado ou sem acerto), nunca antes de 54 min parado; agente ocioso, sem fila e editor vazio. Resume no modelo selecionado. | Ligada. | `AGENT_IDLE_COMPACT=0` |
| Compactação por limiar | Fim de turno com contexto > 450k tokens em janelas ≥ 1M, ou > 90% da janela nas menores. Com cache quente pode ser adiada por alguns turnos, nunca além do limite duro (janela − max(64k, 10%)). Resume no modelo selecionado. | Ligada. | Não há variável. |
| `web_search` | Cada chamada da tool, na sessão principal ou num subagente cujo papel a declara: uma inferência Gemini (`gemini-2.5-flash` com Google Search, fallback OpenRouter). | Até 20 buscas e 40 fetches por sessão. | `AGENT_WEB_MAX_SEARCHES=0` (`AGENT_WEB_MAX_FETCHES=0` para fetch) |

O aquecedor nativo do Pi (`cacheWarming`) fica parado, inclusive com `AGENT_CACHE_KEEPER=0`; a lane OAuth Anthropic não usa message threads (cada request leva system, tools e a conversa inteira).

Prompt cache: o launcher define `PI_CACHE_RETENTION=long` (TTL 1h) quando a variável não está definida; um valor do usuário, inclusive `none`, prevalece. Isso vale para a sessão principal; subagentes usam 5 min (ver Custo dos filhos). Escrita de cache custa 2× a entrada com TTL 1h e 1,25× com 5 min; leitura, 0,1×. Medido na auditoria do commit 6f77207: o prefixo fixo da 1ª requisição tem 10,2 KB de system e 20,0 KB de tools (8,9 KB da declaração de `subagent`), idêntico entre requisições e processos; cada passo do modelo é uma requisição. Na fixture Anthropic do check `test-agent-headless.mjs`, a compactação reduziu a declaração de `subagent` de 9.398 para 5.657 bytes e o total de tools do perfil completo de 20.239 para 16.498 bytes.

Cache-keeper em detalhe:

- Só a sessão principal aquece; subagentes não. Só Anthropic Messages API, com o mesmo provider/modelo do último request real.
- Janela de aquecimento: 3h de ociosidade com menos de 30 pausas registradas no projeto; depois, aprendida das pausas, até 24h. Pausas ficam em `<perfil>/cache-keeper/<hash do cwd>.json`.
- Teto por ping: `AGENT_CACHE_KEEPER_MAX_PING_USD` (padrão US$ 0,50). Teto por sessão: `AGENT_CACHE_KEEPER_MAX_SESSION_USD` (padrão US$ 5; `0` desliga os pings). A cada tentativa, o keeper soma a estimativa de leitura de cache e saída máxima; não agenda outro ping se o saldo não cobrir a próxima estimativa. O teto vale por sessão, inclusive ao retomá-la. O keeper guarda o gasto estimado no perfil e remove registros com mais de 30 dias ao iniciar uma sessão. O orçamento aparece no comando `/cache`; o rodapé indica quando o teto impede o aquecimento. É um teto de custo estimado, não de cobrança: um ping que erra o cache paga escrita antes de parar.
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

## Workspace concorrente

Num repositório Git, abra uma sessão isolada com `agent --worktree [slug]` (por exemplo, `agent --worktree ajuste-menu`). Sem slug, o launcher gera um nome. A sessão trabalha em `agent/session-<slug>`, a partir do `HEAD` da branch de origem; alterações sem commit da origem não entram no worktree. Subagentes lançados nessa sessão usam o checkout dela, não o da branch de origem.

| Comando na TUI | O que faz |
|---|---|
| `/workspace` ou `/workspace status` | Mostra os workspaces registrados no repositório, com branch, dono, escopo e arquivos alterados. |
| `/workspace claim <texto>` | Publica o escopo da sessão para os demais. É um aviso, não uma trava de arquivos. |
| `/workspace integrate` | Integra o worktree da sessão na branch de origem. Antes, pare o trabalho em andamento e faça commit das alterações. |
| `/workspace discard [--force]` | Remove o worktree e a branch da sessão sem integrar. Use `--force` só se também quiser perder alterações sem commit. |

O launcher informa ao runtime a raiz do worktree (`AGENT_WORKTREE_SESSION`), a raiz e a branch de origem (`AGENT_WORKTREE_SOURCE` e `AGENT_WORKTREE_BRANCH`) e a branch da sessão (`AGENT_WORKTREE_NAME`). Essas variáveis internas não são repassadas ao `bash` nem aos subagentes.

### Fila de integração

`integrate` e `discard`, tanto de `/workspace` quanto de `subagent`, usam o mesmo lock por repositório. Outra ação no mesmo processo é recusada; entre processos, a ação espera até 60 s e, se o prazo vencer, o erro identifica o dono do lock quando disponível. O lock não impede comandos Git fora do Agent.

1. Para integrar, ambos os checkouts precisam estar limpos, sem operações Git pendentes, e o checkout de origem ainda deve estar na branch registrada.
2. Se a origem avançou, o Agent tenta o merge primeiro no worktree. Em caso de conflito, aborta a tentativa e lista os arquivos em conflito; resolva no worktree (retome o escritor com `subagent continue`, se for o caso), faça commit e tente de novo.
3. Com `.pi/checks.json`, o gate roda no código já sincronizado. Se falhar, a origem fica intacta, o Agent desfaz o merge de sincronização se puder fazê-lo sem sobrescrever commits novos, e o erro lista os checks que falharam. Sem manifesto, verifique o resultado após integrar.
4. Só então o Agent revalida os checkouts e mescla na branch de origem, respeitando `branch.<nome>.mergeOptions` dela. O sucesso remove o worktree e a branch temporária. Se o escritor fizer outro commit após o merge, o worktree é preservado; integre novamente para levar o novo commit.

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

O slot `apoio` usa o modelo de apoio; `principal`, o modelo da sessão. Não há classificador de dispatch. Sem modelo de apoio configurado, o slot `apoio` cai no modelo principal: papéis sem config própria em `/models` e sem `model` no frontmatter herdam o principal; os demais seguem os itens 1 e 2. Na sessão principal, o Agent avisa uma vez por processo se o apoio estiver sem modelo e o `scout` não tiver modelo próprio em `/models`, e sugere configurá-lo em `/models`.

O repo não distribui uma lista padrão de modelos por papel. Instalações antigas liam `~/Sistema/Pi/models.json` (ou `$PI_SYSTEM_DIR/Pi/models.json`); o runtime atual não lê esse caminho. Para preservar as escolhas antigas, faça backup e copie a configuração para `<perfil>/agent-models.json`, mantendo `tiers` e `roleModels`. A primeira opção de cada papel é a preferida, com seu `thinking`.

### Isolamento

Os papéis Pi rodam em outro processo `pi -p`, com contexto próprio. Só o resultado volta ao pai. O que o filho lê não entra no contexto nem no cache do pai.

No `subagent launch` (`single` ou `parallel`), escritores (papéis com `edit`/`write` ou sem lista de tools) ganham worktrees próprios se houver, no mesmo repositório Git, dois ou mais escritores do job ou outro escritor ou sessão ativa no registro compartilhado. `isolate: true` força o isolamento de escritores e exige Git; `isolate: false` os mantém no checkout atual. O modo `chain` continua no checkout atual.

`gemini` usa o Antigravity CLI oficial (`agy` no `PATH`; faça login no CLI antes), com acesso total: lê, roda comandos e edita (`--mode auto --dangerously-skip-permissions --sandbox`). O `--sandbox` do agy é uma camada extra: shell, rede e escrita fora do checkout seguem liberados, mas ele bloqueia escrita em `<cwd>/.git` (`git add`/`git commit` falham no checkout principal; num worktree isolado o commit funciona). Como papel de escrita, exige o brief completo (`objective`, `context`, `scope`, `done_when`, `stop_if`) e entra no isolamento por worktree quando há outro escritor em paralelo. Um papel `agy` customizado sem `edit`/`write` roda em `--mode plan --sandbox`. Em `/models`, selecione a linha `gemini`: **Enter** escolhe a família, **←/→** muda o thinking (`low`, `medium`, `high`, `xhigh`). O padrão é Gemini 4 Neon com `high`; sem preferência salva, um frontmatter customizado ainda pode fornecer `model` (ID nativo) e `thinking`.

A escolha fica em `agyModels.gemini` no `agent-models.json` do perfil. O painel usa um catálogo estático, sem consultar o CLI nem cadastrar um provider no Pi. O job passa o ID nativo e o esforço efetivo ao `agy`: por exemplo, Carbon com `xhigh` aparece como `xhigh → high` e vira `--model gemini-4-carbon-high --effort high`. Famílias sem sufixo no catálogo (Orchestrator) mantêm o ID fixo e recebem o thinking via `--effort`.
O resultado e o uso disponível ficam no registro do job; não há sessão JSONL do Pi nem `trace` para esse runner.

### checks nos filhos

- O papel recebe a tool `checks` quando lista `checks` em `tools:`; o runner carrega a extensão com `-e`, como `skim` e web. Os papéis padrão `worker` e `reviewer` a listam. Nome desconhecido em `--tools` é ignorado pelo Pi, então um perfil que liste `checks` sem a extensão não quebra.
- `worker` (papel com `edit`/`write`): `gate`, `run`, `baseline`, `list` e `last`. Sem `tags` nem `only`, usa `tags: "fast"`; o gate completo roda no `integrate`. O `cwd` do filho já é o worktree.
- `reviewer` (papel sem `edit`/`write`, marcado com `AGENT_CHECKS_READONLY=1`): só `list` e `last`. `gate`, `run` e `baseline` são recusados, porque o comando vem de `.pi/checks.json`, controlado pelo projeto, e rodaria fora do sandbox do bash.
- `last` devolve a última rodada de `gate`/`run` daquele checkout. A rodada é gravada com HEAD e uma impressão digital do working tree (`git status`, `git diff HEAD` e conteúdo dos não rastreados). Se algo divergiu, a resposta é `stale` e diz o quê, em vez do resultado. Funciona dentro do sandbox só leitura: só lê.
- No fim de um job, cada tarefa de papel escritor com `checks` ganha no resultado a linha `gate: N/M green, new failures: […] (fresh|stale…)`, ou `gate: not run in this job`.
- A baseline serializa `git worktree add`/`remove`/`prune` por repositório (`<git-common-dir>/pi-checks.lock`); o cache é gravado com tmp+rename.

### Skills nos filhos

- O frontmatter do papel aceita `skills:` opcional, uma allowlist de nomes do catálogo. `skills: []` = nenhuma skill; sem o campo = catálogo inteiro, como antes. Papéis padrão: `scout`, `reviewer`, `visual` e `planner` com `[]`; `worker` com `[debug, tdd]`; `gemini` (agy) sem o campo, e papéis agy recusam skills.
- Com allowlist, o filho roda `pi --no-skills --skill <SKILL.md>…`. No Pi 1.5.2, `--no-skills` desliga a descoberta (settings, perfil, projeto), mas mantém cada `--skill`. O runner também passa `AGENT_CHILD_SKILLS` com os nomes; o preload do filho copia a lista para `PI_AUTOMATIC_SKILLS`. Sem isso, a curadoria esconderia `debug` e `tdd`, que têm `disable-model-invocation`. O bash do filho não herda `AGENT_CHILD_SKILLS`.
- O `launch` aceita `skills` (por task, ou no modo single) com nomes extras, somados aos do papel. Num papel sem o campo, os extras entram com `--skill` sobre o catálogo inteiro. Nome desconhecido, caminho ou skill pedida para um papel `agy` falham antes de qualquer spawn, com a lista das skills disponíveis.
- O catálogo usado para resolver nomes é o que o filho descobriria no `cwd`, mais as skills de empresa do usuário e as skills embutidas no runtime (`agent/skills`). Assim, `debug` e `tdd` existem mesmo num perfil sem `skills` nas settings. A resolução acontece uma vez, no `launch`, no checkout de quem lança, e os caminhos absolutos seguem com a tarefa. Um escritor que vai para um worktree isolado não recebe skills do projeto. Uma skill é do projeto quando o caminho do catálogo, ou o destino dele com os links resolvidos (arquivo ou pasta), fica dentro do repositório; o `cwd` conta como dentro, mesmo quando é um link para uma subpasta. Assim, uma skill pessoal que é link para dentro do repositório também é recusada. A contenção é por diretório (`/repo` não contém `/repo-2`). Se o nome pedido resolve para a cópia do projeto e existe outra skill com o mesmo nome fora do repositório (pessoal, de empresa ou embutida), o `launch` também falha e cita os dois caminhos: o Pi dá prioridade à cópia do projeto, e o escritor isolado nunca a recebe. Pedir uma delas, pelo `skills:` do papel ou pelo `launch`, falha no `launch`, antes de criar registro, worktree ou filho: `skill "X" is a project skill; isolated writers only get personal, company and bundled skills. Run the task in place to use it.` Skills pessoais, de empresa e embutidas mantêm o caminho absoluto. Tarefas no lugar (sem worktree) não mudam. O `continue` reusa o conjunto do launch. A proibição vale para skills pedidas explicitamente: as do `skills:` do papel e as do `launch`. Um papel sem o campo (catálogo inteiro) continua descobrindo, dentro do próprio worktree, as skills de projeto commitadas lá, como antes do item 4; ele lê a cópia commitada do worktree, não o checkout de origem. Exceção: se o `link` do `.pi/checks.json` liga `.pi/skills` (ou uma pasta acima) ao checkout de origem, esse papel também vê as skills ainda sem commit de lá; é um compartilhamento explícito do projeto.
- O conjunto efetivo (caminhos, `--no-skills` e nomes anunciados) entra no snapshot do launch. `continue` e o aquecimento do cache usam o mesmo argv do filho real.
- Override do usuário (`<perfil>/agents/<nome>.md`) ou do projeto sem `skills:` herda a allowlist do papel embutido de mesmo nome. Um papel novo sem o campo fica com o catálogo inteiro. Um override que precise de outras skills as lista no campo.
- Tamanho do bloco `<skills>` no system do filho, medido com o catálogo desta máquina: antes, 3041 bytes em todo filho Pi (7 skills automáticas). Depois, 0 bytes em `scout`, `reviewer`, `visual` e `planner`; 862 bytes em `worker` (`debug`, `tdd`).

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
- **`agent -p` (e `--mode json`) espera os jobs:** o processo não sai enquanto a sessão tiver job rodando. Quando o pai encerra o turno, a extensão espera um job terminar (cada job é limitado pelo próprio `timeoutSeconds`), entrega o `subagent-result` como follow-up e o pai roda mais um turno; repete até não restar job. SIGINT, SIGTERM ou SIGHUP interrompem a espera: o processo sai e os jobs são cancelados (SIGINT sai com código 130). TUI e `--mode rpc` não mudam: o resultado chega quando a sessão fica ociosa. Filhos não lançam jobs, então nunca esperam.
- **Worktrees de escritores:** o resultado traz `git status` e `git log` desde o commit base. Nada é integrado sozinho: use `integrate` ou `discard` (`force: true` para descartar também alterações sem commit), com `taskIndex` opcional. Ambos seguem a [fila de integração](#fila-de-integração).

### Continuar um filho (`continue`)

- Cada tarefa lançada ganha um **handle** estável na sessão do pai: `<papel>-<n>` (ex.: `worker-1`) ou o `name` dado no launch (`name` no modo single ou em cada item de `tasks`/`chain`; letras, dígitos, `-` e `_`, até 48). Nome repetido na sessão é recusado. O resultado do launch lista os handles; `list` e `status` mostram o estado de cada um.
- O estado do handle é separado do status do job. Todo job, de launch ou de continue, termina como sempre (`completed`, `failed`, `cancelled`, `timeout`). O handle fica:
  - `running`: um job está rodando o filho;
  - `waiting`: o filho terminou o turno e o processo saiu (custo zero); o JSONL e o worktree continuam;
  - `closed`: `integrate`, `discard`, worktree removido, runner agy ou tarefa que nunca abriu sessão.
- `subagent({ action: "continue", handle, message })` (ou `jobId` + `taskIndex`) lança um **job novo** e assíncrono, com `continuesFrom` no registro. O filho roda o mesmo argv do launch sobre o mesmo `--session`: mesmo modelo, thinking, tools, sandbox, extensões, system prompt e `cwd`/worktree. Só a mensagem nova é enviada, sem repetir `Task:` nem as regras do projeto, que já estão no histórico. O prefixo idêntico aproveita o cache de prompt. Prova do passo 0: `docs/harness-spec.md`, item 2.
- O registro de cada tarefa guarda o snapshot da invocação (`invocation`): modelo, thinking, tools, sandbox, extensões, texto do system prompt, `cwd` efetivo, checkout de origem e sha256 do arquivo do papel. Se o `.md` do papel mudou desde o launch, o `continue` usa o snapshot e avisa no resultado.
- Escritor sem worktree: o `continue` grava um checkpoint novo do turno do pai, como o launch, para o `/rewind` cobrir o segundo turno. Num worktree o isolamento já cobre.
- `integrate`/`discard` com o `jobId` de um continue agem na tarefa do launch, dona do worktree. Os dois fecham o handle.
- Recusas, com mensagem: handle desconhecido; papel no runner agy (sem JSONL do Pi: use `launch`); handle ainda `running`; outro `continue` gravando no mesmo JSONL (lock `<sessão>.jsonl.continue.lock` criado com O_EXCL; lock de processo morto é assumido) ou um `integrate`/`discard` em andamento no mesmo job; handle fechado ou worktree removido (lance uma tarefa nova).
- Locks (`subagent/lockfile.ts`, usado pelo lock de sessão e pelo do board) são numerados por geração: o estado é o maior `<lock>.<N>`, um dono `{token, pid, at}` ou um marcador de liberação. Cada arquivo de geração já nasce completo: o registro é gravado num arquivo temporário único no mesmo diretório, com fsync, e ligado (hard link) a `<lock>.<N>`; um arquivo de geração ilegível é corrupção e falha fechado, com erro. Para adquirir, liga-se `<lock>.<N+1>` (EEXIST: outro venceu), e só quando não há geração, quando a maior é um marcador ou quando o dono dela morreu. Num empate, só um vence. O arquivo atual nunca é apagado nem renomeado, e um dono vivo nunca é desalojado. Liberar cria primeiro o marcador `<N+1>`; se não conseguir, a liberação falha com erro (o lock continua seguro e o job ou a ação relatam a falha) e fica pendente no processo: é tentada de novo a cada aquisição ou liberação seguinte e a cada 5 s, até dar certo. As gerações abaixo da maior e os temporários com mais de 1 min são apagados aos poucos. O lock de arquivo único das versões antigas (`<lock>`) só é lido: com o dono vivo bloqueia, com o dono morto é ignorado; o código novo nunca o grava nem o apaga.
- Deploy: processos de artefatos antigos e novos não compartilham locks com segurança. Depois do deploy, reinicie as sessões abertas no artefato antigo antes de usar `continue`, swarm ou `integrate`/`discard` nelas.
- `integrate`/`discard` seguram o lock de sessão dos handles selecionados (num loop de swarm, os dois, porque o checkout é compartilhado), da checagem de ocupado até o gate e o merge/remoção. Com algum lock tomado (um `continue` ou rodada de swarm, mesmo de outro processo pai), a ação recusa com `Handle X is busy: its session is locked by job Y…`; um `continue` durante o `integrate` também recusa. Depois de pegar o lock, o `continue` relê o handle no registro e recusa se ele mudou (fechado, outro job, sessão trocada) ou se o worktree sumiu.
- Se o isolamento foi solicitado ou decidido automaticamente e não puder ser preparado, o escritor não roda no checkout de origem.
- Registro dos handles: `<perfil>/subagent-jobs/<sessionId>/handles/registry.json`, modo 0600, gravado com tmp+rename.
- Recusa de `model`: o `continue` só aceita `model` quando a última rodada do handle falhou por cota (abaixo), e só um modelo que o launch aceitaria para o papel: a lista do papel em `/models` (`roleModels`) ou, sem lista própria, o principal/apoio do piloto. Fora disso a chamada é recusada e nenhum job nasce.

#### Falha por cota

- O runner classifica a falha pelo erro do provedor ou do CLI agy, nunca pelo texto do modelo. Contam como cota: HTTP 429 e 529, `rate_limit`, `too many requests`, `quota`, `usage limit` (ex.: `Codex error: The usage limit has been reached`), `overloaded`, `capacity` e o `RESOURCE_EXHAUSTED` do Gemini. Cancelamento e timeout nunca contam.
- A tarefa ganha `failure: "quota"` no registro do job, e o handle também. O status do job não muda (`failed`), e o handle fica `waiting`. O resultado diz qual tarefa falhou e em qual modelo.
- Papel somente leitura (sem `edit`/`write`): o runner tenta sozinho **uma vez** o próximo modelo da lista do papel (com volta ao início), no mesmo JSONL, com a mensagem `The previous attempt stopped on a provider quota/rate limit…`. A troca fica em `modelSwitch` (`auto: true`) na tarefa, no snapshot do handle e numa linha do resultado. Sem outro modelo permitido, a tarefa só falha.
- Escritor nunca troca sozinho. O pai decide: `subagent({ action: "continue", handle, message, model })` roda no mesmo JSONL e no mesmo worktree, com o contexto e o trabalho preservados e o cache de prompt frio. A troca fica em `modelSwitch` (`auto: false`), e os `continue` seguintes usam o modelo novo. Depois de uma rodada sem cota, `model` volta a ser recusado.

#### Soft-timeout e commit WIP

- Cada filho do Pi carrega `subagent/child-soft-deadline.ts`. O runner passa `AGENT_CHILD_SOFT_DEADLINE_MS`, um instante absoluto: início do job + timeout − margem. A margem é 10 % do timeout, com mínimo de 3 min, limitada à metade do timeout: com timeout de até 6 min, o aviso sai na metade do tempo.
- Passado o prazo, a extensão manda uma vez `Time is almost up: commit what works and summarize what is left.` como steer (`sendUserMessage`, `deliverAs: "steer"`). O `pi -p` não tem stdin interativo; o loop do agente entrega a mensagem antes da próxima chamada ao modelo, depois das tools em curso. Não há patch no Pi.
- No timeout duro, o runner mata a árvore do filho (SIGTERM, depois SIGKILL nos descendentes, incluindo processos que eles criaram depois da foto) e espera todos saírem, até 5 s. Só então, e só no worktree do job, roda `git status --porcelain`. Se houver mudanças, faz `git add -A` (sem os links do manifesto) e `git commit --no-verify -m "WIP(agent): timeout <jobId>"`.
- O sha vai para `wipCommit` na tarefa e no handle, e numa linha do resultado. O job termina `timeout`, e o handle fica `waiting`: `continue` retoma sobre o commit WIP. Se o commit falhar, o motivo fica em `wipError`.
- O checkout do usuário nunca recebe commit. Escritor único sem worktree não ganha commit WIP: o `/rewind` cobre.

### Lacunas

- stderr do filho fica só em memória (até 64 KB) e só aparece no resultado quando a tarefa falha.
- No runner Pi, o system prompt do papel vai por arquivo temporário, apagado no fim. No agy, o prompt completo vai por stdin quando excede 16 KiB. O registro guarda o nome do papel e, no snapshot da invocação, o texto do system prompt usado. As fontes `.agent/rules.md` + `.agent/header.md` (ou workflow.md legado sem rules.md) anexadas à tarefa ficam no JSONL do filho Pi.
- Escritores sem worktree próprio gravam direto no `cwd`. Em Git, o pai compara o conteúdo antes e depois de cada filho e registra as mudanças para `/rewind` no turno que lançou o job. A captura cobre arquivos regulares rastreados ou não ignorados (até 10.000 caminhos e 64 MiB por leitura; até 20 MiB por arquivo). Não cobre `cwd` sem Git, links, arquivos ignorados, permissões, índice ou commits. A comparação não distingue uma edição concorrente de uma feita pelo filho, então o `/rewind` exige confirmação para esses arquivos. Cada varredura assíncrona tem até 3 s. Se a captura falhar, exceder os limites da varredura (tempo, caminhos ou soma dos bytes) ou for cancelada, o resultado informa que o checkpoint foi pulado e o `/rewind` não cobre aquele despacho.
- O sandbox cobre apenas o `bash` de papéis sem `edit`/`write`: Seatbelt no macOS, bwrap no Linux, `none` sem suporte. Com sandbox, o checkout (incluindo `.git` e `.pi`) não é gravável mesmo dentro de `/tmp` ou de cache; ficam graváveis temporários, caches do usuário e `<cwd>/node_modules/.cache`. O bash não lê nem altera `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube`, `~/.netrc` e `~/.git-credentials`. Em cada raiz de perfil (`~/.agent`, `~/.pi/agent` e o perfil ativo, `PI_CODING_AGENT_DIR`), também ficam ocultos `auth.json`, `accounts.json`, `accounts-mirror.json`, `models.json`, `superagent/api-token`, `accounts.rotations/` e `secrets/`. Links simbólicos são resolvidos. Ficam acessíveis `~/.config/gh`, `~/.docker/config.json` e `~/.npmrc`, porque `gh`, `docker` e `npm` dependem deles. A rede e o Keychain continuam disponíveis: o sandbox impede escrita e a leitura desses arquivos, mas não impede exfiltração. O resultado informa `sandbox=`. Sem sandbox, o detector compara só o `git status` do checkout antes e depois; escrita fora do checkout Git não é vista.
- Na sessão principal, tanto a ferramenta `bash` do modelo quanto `!cmd` e o bash via RPC usam `shellPath` e `shellCommandPrefix` do perfil global. Para permitir que `<cwd>/.pi/settings.json` sobrescreva essas opções, inicie o Agent com `AGENT_TRUST_PROJECT_SHELL=1` apenas em projetos confiáveis: essas opções podem executar código.
- `list` apaga o registro de jobs terminados há mais de 30 dias, junto com worktrees limpos e já integrados. Worktree sujo ou não integrado preserva o registro. Os JSONL dos filhos ficam.
- O prefetch (`AGENT_CACHE_PREFETCH_NEXT=1`) roda com `--no-session`; seu custo não entra em usage.

## Swarm: loop escritor ↔ revisor (`/swarm`)

Opt-in por sessão. Desligado, não custa nada: a tool `swarm` é `deferred`, fora do schema e do system prompt iniciais.

### Ligar e desligar

- `/swarm` alterna; `/swarm on`, `/swarm off` e `/swarm status` são explícitos. Toda sessão começa desligada; o estado é a última entrada `agent-swarm` do branch atual, então sobrevive a resume e segue o `/tree`.
- Ligar grava `agent-swarm {enabled:true}`, mostra `swarm` no rodapé e anexa uma mensagem oculta (`agent-swarm-mode`) com o playbook em inglês: achar a tool `swarm` pelo `tool_search`, escolher entre loop, board e subagent simples, registrar a escolha numa linha, nunca integrar sem revisar o resultado final, sem chat livre e sem chamar `swarm` depois que o usuário desligar.
- Desligar grava `enabled:false` e limpa o rodapé. Jobs de swarm em andamento terminam; chamadas novas falham com `Swarm is off in this session. Ask the user to enable it with /swarm.`
- O `/swarm` nunca muda o system prompt nem chama `setActiveTools`: o cache de prompt da sessão continua. A tool entra pelo `tool_search`, na camada de tools carregadas que só acrescenta.
- Execução não interativa (`agent -p`, `--mode json`, RPC): `AGENT_SWARM=1` liga a sessão que ainda não tem entrada `agent-swarm`. Na TUI a variável é ignorada; lá só o `/swarm` liga.

### Modelos e custo

No `/models`, as linhas `swarm writer`, `swarm reviewer` e `swarm board` guardam pares de modelo e thinking em `swarmModels` no `<perfil>/agent-models.json`. Use **Enter** para escolher um modelo de chat ou **Herdar padrão** para remover o preset. Use **←/→** para ajustar o thinking de um preset já configurado.

Em cada chamada da tool, a ordem é: **`model` explícito** do escritor, revisor ou tarefa (sujeito às regras normais do papel) → **preset** do slot correspondente (modelo e thinking, sem precisar estar na lista `roleModels`) → **resolução normal do papel** (`roleModels`, frontmatter, slots). Sem preset, o loop usa os papéis do escritor e do revisor (`worker` e `reviewer` por padrão); o board usa o papel de cada tarefa. O modelo do preset precisa existir no catálogo do Pi; modelos Google API não são aceitos.

Omitir `maxUsd` deixa ambos os modos sem corte por custo. Para definir um teto, passe um número finito de pelo menos `0.1` USD, sem máximo fixo. O custo continua sendo registrado quando não há teto; `timeoutSeconds` e `cancel` continuam disponíveis.

### Loop

`swarm({ mode: "loop", writer: { brief, agent?, task?, cwd?, model?, skills?, name? }, reviewer?: { agent?, brief?, task?, model?, skills?, name? }, isolate?, maxRounds?, maxUsd?, cwd?, agentScope?, timeoutSeconds? })` devolve um `jobId` na hora, como o `launch`.

- Padrões: escritor `worker`, revisor `reviewer`, `isolate` ligado dentro de um repositório git, `maxRounds` 3 (1..5). Sem `reviewer.brief`, objective/context/scope/done_when vêm do brief do escritor.
- Recusas antes de qualquer job ou worktree: swarm desligado; escritor sem `edit`/`write` ou no runner agy; revisor com `edit`/`write` ou no agy; brief incompleto pelo `brief_required` de cada papel; `model` explícito não autorizado ou preset com modelo que não existe no catálogo; skill desconhecida; skill de projeto num escritor isolado; nome de handle repetido; `isolate` fora de um repositório.
- Rodada 1: o escritor roda (num worktree próprio quando isolado, o mesmo mecanismo de `integrate`/`discard`). Se ele não mudou nada (HEAD, `git status --porcelain`, diff dos arquivos rastreados e nomes e conteúdo dos não rastreados, de `git ls-files --others --exclude-standard`, todos iguais, medidos na raiz do repositório mesmo com o escritor num subdiretório), o loop para em `stalled` sem chamar o revisor. O revisor roda no mesmo checkout, recebe o intervalo `base..HEAD`, a linha do gate, o resumo do escritor e o contrato: achados com `path:line` e uma última linha isolada `VERDICT: APPROVE` ou `VERDICT: REQUEST_CHANGES`.
- Veredito fail-closed: vale só se a última linha não vazia da resposta for `VERDICT: …` sem recuo (começando na coluna 0) e fora de bloco de código. Um veredito citado antes de mais texto, recuado (numa lista, por exemplo) ou dentro de um bloco de código aberto é `ambiguous`. Os blocos são reconhecidos com qualquer recuo; só fecha uma linha com o mesmo caractere (`` ` `` ou `~`), pelo menos o mesmo comprimento e sem info string. `APPROVE` termina em `approved`; sem a linha, `ambiguous`; erro do revisor, `failed` (ou `quota`). Silêncio nunca aprova.
- Rodadas 2+: antes de cada uma, o loop verifica `maxRounds` e, se definido, `maxUsd` (desfechos `max_rounds` e `max_usd`). O escritor retoma o próprio JSONL (lock de sessão, como o `continue`) e recebe só os achados, a rodada e, se houver teto de custo, o orçamento restante; se não mudar nada, `stalled`. O revisor retoma o próprio JSONL e recebe só o delta (`anterior..novo`, gate, nota curta do escritor) e o contrato. Os dois mantêm o cache de prompt quente.
- Erro, cota ou timeout do escritor terminam em `failed`/`quota`; no timeout o worktree ganha o commit WIP de sempre.
- O job é um job comum do `subagent` (modo `swarm`, tarefa 1 escritor, tarefa 2 revisor, `JobRecord.swarm` com rodadas e desfecho): `status`, `result`, `trace`, `list`, `cancel`, `integrate`, `discard` e `continue` funcionam igual. Só `approved` termina `completed`; os outros desfechos terminam `failed`, com o motivo no resultado. No fim, os dois handles ficam `waiting`. `integrate` e `discard` tratam o loop como uma unidade: com ou sem `taskIndex`, agem no worktree do escritor e fecham os dois handles.
- O resultado abre com `swarm loop · outcome: X · rounds: N/M · cost: $X.XX`, uma tabela por rodada (sha do escritor, gate, veredito, custo), os handles, o resumo do worktree e do gate, e a última resposta do revisor (até 4 KiB).
- Revise o diff final antes do `integrate`. O merge continua explícito.

### Board

`swarm({ mode: "board", tasks: [ … ], maxUsd?, cwd?, agentScope?, timeoutSeconds? })`: 2 a 32 tarefas acopladas em paralelo, com os mesmos itens de `tasks` do `subagent` (`agent`, `brief`, `task`, `cwd`, `model`, `skills`, `name`).

- Execução: o leque paralelo de sempre (job `parallel` com `JobRecord.swarm.kind = "board"`). Dois ou mais escritores do mesmo repositório ganham worktrees próprios, com a mesma recusa de skills de projeto. O system prompt do papel não muda, então o cache entre irmãos continua.
- Cada mensagem de tarefa começa com um bloco de 4 linhas: o próprio handle, os irmãos com o objetivo de cada um em uma linha, e a regra: usar o board para claim, decision, blocker e done, ler com `since` antes de mexer num contrato compartilhado, sem chat.
- Arquivo: `<perfil>/subagent-jobs/<sessionId>/<jobId>/board.jsonl`, modo 0600, criado no launch. Linha: `{seq, ts, handle, kind, text, refs?}`; `kind` é `claim`, `decision`, `note`, `blocker` ou `done`. O `seq` é estritamente crescente: cada append roda sob o lock de gerações em `board.jsonl.lock` (só é assumido se o dono morreu; nunca por idade).
- Limites: `text` aparado, não vazio, até 400 caracteres; `refs` até 8 itens de até 160 caracteres; o arquivo aceita até 100 entradas e 64 KiB. Post acima do limite volta com erro claro; leitura sempre funciona. Não há destinatário, resposta nem notificação entre filhos.
- Tool `board` só nos filhos do board (`subagent/child-board.ts`, carregada com `-e` quando a invocação tem `board`; env `AGENT_BOARD_PATH` e `AGENT_BOARD_HANDLE`, removidas do bash pelo `userCommandEnv`). `post` (kind, text, refs) responde `Posted #seq (kind).`; `read` (since, kind) devolve só as entradas com `seq > since`, uma por linha (`#3 [worker-1 · decision] … (refs: …)`), ou `No new board entries since #N.`. O `board` fica no snapshot da invocação, então um `continue` do handle mantém a tool.
- Se `maxUsd` foi definido, o board compara o teto ao custo das tarefas que já terminaram. Ao atingir o teto, o job é abortado: tarefas pendentes não começam, as que rodam param, e os worktrees ganham o commit WIP. O desfecho fica `max_usd` e o job termina `failed`.
- Resultado: `swarm board · outcome: done|failed|max_usd · tasks: N · cost: $X.XX`, o resultado paralelo de sempre (worktrees, saídas, gate) e `### board (N entradas)` compacto (até ~2 KiB) com o caminho do arquivo completo.
- Agentes no runner agy não entram em board (sem a tool `board`).
- Limite de segurança: o board é uma ajuda de coordenação, não uma barreira contra filhos que editam. Escritores rodam sem sandbox, como o próprio usuário, e conseguem reescrever o `board.jsonl` pelo bash. A tool garante limites e `seq` para quem a usa honestamente; para auditoria vale o JSONL de cada filho (`trace`).

## Dependências pessoais / degradação

O código de `agent/` não depende de caminhos fixos no diretório pessoal. `lib/paths.ts` conserva a descoberta opcional de `/mnt/garime` e `~/Sistema` (ou `PI_SYSTEM_DIR`); sem o mount usa o HOME local.

| Extensão | Sem infraestrutura pessoal |
|---|---|
| vault-runtime | Somente com `AGENT_VAULT=1`. Sem opt-in mantém o prompt nativo e não depende de Vault. Nenhum dado pessoal é migrado. |
| subagent | Papéis/modelos usam o perfil do Agent, não o Vault. Sem modelo de apoio configurado, papel sem config própria em `/models` e sem `model` no frontmatter herda o modelo principal. Allowlists e confirmações de agentes do projeto continuam aplicáveis; falhas de quota não trocam o modelo silenciosamente (papel somente leitura tenta uma vez o próximo modelo permitido e registra a troca). Gate Megamind explicitamente configurado continua falhando fechado. |
| models | `/model` mantém o seletor nativo. `/models` usa `agent-models.json` no perfil para escolhas por papel e presets do swarm; `agent-preferences.json` guarda preferências de recursos, não contabilidade. Nenhuma configuração pessoal é distribuída. |
| generate-image | Execução exige configuração do modelo de imagem no perfil e autenticação própria. Falta deles vira erro da tool, não erro de startup. |
| compaction | Usa geração, prompt e validação nativos do Pi, sem impor Luna ou executar aprendizado auxiliar. O cache-keeper mantém suas proteções de compactação. |
| herdr-agent-state | Já inerte sem HERDR_ENV=1, socket e pane; erros de socket tratados. |
| tui | Código local, não depende de serviço Garime. Recursos interativos guardados por modo/UI; logs usam HOME local. |
| accounts | Preserva autenticação e contas locais do usuário; nenhuma credencial é copiada de outro perfil. Mirror só opera com dados locais existentes. |
| peers | IPC local em HOME/PI_MESH_DIR, sem serviço pessoal remoto; pasta é criada em runtime. |
| cost, sessions | Leem sessões locais; histórico vazio é válido. `sessions` não poda no `session_start`; apagar sessão velha/vazia só por `/gc` explícito. |
| image-normalize | Normalização local; nenhuma pasta pessoal obrigatória. |
| project-operator, checks | Operam sobre o projeto atual; não exigem repositórios pessoais. |
| ask-user, btw, checkpoints, codex-fast, files, plan, slash-anywhere, todos, tool-lexicon, whimsical | Sem infraestrutura pessoal obrigatória. |

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
