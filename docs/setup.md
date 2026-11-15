# Setup do Agent

## Instalação privada por artefato

O pipeline está implementado, mas **não há release publicada por esta mudança**. Os comandos remotos abaixo só funcionarão depois da publicação aprovada e dos checks de cada plataforma.

Pré-requisitos: Node externo >=22.19 (recomendado Node 24), Bash em macOS/Linux e GitHub CLI (`gh`) autenticado com acesso a `GabrielMendonca1/agent`. Não precisa de Git, npm, clone ou build na máquina do consumidor. Windows não foi validado; não há bootstrap Windows distribuído.

Após existir uma release aprovada, obtenha `install.sh` pelo canal privado e execute:

```sh
gh release download -R GabrielMendonca1/agent -p install.sh -O ./install.sh
bash ./install.sh
export PATH="$HOME/.local/bin:$PATH"
agent
# Na conversa: /login — sua própria conta do provider
```

Use `AGENT_VERSION=<tag>` para fixar uma release e `AGENT_RELEASE_REPO=owner/repo` para escolher explicitamente outro canal privado confiável. Não use um mirror não confiável: SHA256SUMS detecta corrupção, **não é assinatura**. O transporte autenticado do `gh` é a origem de confiança. Nenhum download usa HTTP público nem copia auth do Mark. Busca web e Megamind podem exigir configuração própria; não são autenticação do chat.

Padrões: store `~/.local/share/agent`, comando `~/.local/bin/agent`, perfil `~/.agent`. `AGENT_STORE` e `PI_CODING_AGENT_DIR` explícitos prevalecem. Não existe migração de `~/.pi/agent` ou do store Mark. O bootstrap não altera shell rc; configure o PATH também para o Node em terminais novos. Um store alternativo só adota `~/.local/bin/agent` com `--adopt-launcher` explícito.

```sh
agent update                 # canal privado, sem build; erro de acesso preserva a instalação
agent overlay-rollback       # revalida o par anterior antes de trocar
agent overlay-status
node scripts/agent-update.mjs --install-artifact /caminho/agent-<id>-<os>-<arch>.tar.gz
# O arquivo SHA256SUMS deve estar no mesmo diretório do archive local.
```

`agent update --extensions` e outras opções nativas de atualização de pacotes continuam delegadas ao Pi. `agent update --all` instala o artefato e depois atualiza as extensões pelo Pi. Print/JSON/RPC, SDK e códigos de saída pertencem ao Pi; o launcher não reescreve stdout.

## Validação e ativação

- O bootstrap verifica SHA256SUMS, interpreta todos os headers ustar e recusa travessia, entradas duplicadas, tipos especiais, links absolutos/externos/encadeados e arquivos sob symlinks **antes de extrair**. Só então verifica o inventário integral antes de executar o updater do bundle.
- O manifesto de distribuição (`artifact.json`, schema 1, `runtimeContract:3`) fixa commit, plataforma/arquitetura, Node mínimo, perfil, hash do manifesto overlay e inventário de arquivos/modos/links. O digest cobre release e bundle; o releaseId inclui o digest portátil para distinguir atualizações só do Agent, mesmo com Pi idêntico. Nenhum recibo host-bound de `--prepare` é aceito como prova portátil.
- Antes de ativar, o updater revalida pacote/entrypoint, seleção, hashes dos patches, fingerprint, tree digest, markers e `pi --version`. O inventário portátil substitui a prova de conteúdo do recibo local, não a verificação da release. `--force` não dispensa isso.
- Sob lock do store, copia em stage e renomeia a release, prepara o par físico Pi+Agent e o plano de recursos, troca current/previous e escreve recursos/config/active. Falhas verificadas restauram o par anterior, os registros e o recibo. Diretórios candidatos não ativos podem permanecer para diagnóstico; auth e sessões nunca fazem parte da transação. Falha de recuperação é reportada, não declarada sucesso.
- Uma desativação explícita é preservada nas atualizações por artefato. O runtime registra extensões core, Megamind e skills padrão pelo mesmo recibo/CAS em `runtime/resources-backup`. Cópias pessoais são preservadas, colisões recebem exclusões reversíveis; `-megamind`/`-nome` e `-agent-setup` são respeitados. Temas pessoais e settings de modelo/thinking não são substituídos. O caminho novo não roda os syncs legados sem recibo nem reserva Shift+Tab.

## Contrato do runtime novo e rollback histórico

Novos artefatos internos têm manifesto **v3**, config **v2** e preload `agent/juice/runtime.mjs`. O nome do arquivo foi mantido por compatibilidade; não implica contabilidade. O launcher exporta `AGENT_RUNTIME_ENABLED=1` e `AGENT_PI_ROOT` físico/absoluto. Filhos usam `AGENT_CHILD=1`; subagentes são opt-in com `AGENT_SUBAGENTS=1`, sem modo complex obrigatório. Preferências pertencem ao perfil `PI_CODING_AGENT_DIR`, não a Juice.

Não há `juiceHome`, ledger, runId nem `AGENT_JUICE_HOME/STATE` no contrato novo. `--agent-enable` liga o runtime sobre a release ativa sem build; `--juice-home <absoluto>` ainda é aceito com aviso, mas é ignorado e não acessado para artefatos novos. `--agent-disable` fecha o opt-in e desfaz os recursos por recibo. `AGENT_DISABLED=1` é um escape por processo. Preloads herdados do Agent são removidos de NODE_OPTIONS (inclusive forma separada e com aspas); opções alheias são preservadas.

Artefatos históricos **v1/v2** continuam imutáveis e usam config **v1**, com `juiceHome` e seu preload/entrada/broker declarados. O índice de pares guarda a config anterior para rollback. Voltar a eles pode religar contabilidade Juice; o updater avisa antes de ativar e recusa o rollback se o contrato antigo não puder ser recuperado. Não reescreve manifests, digests ou dados históricos.

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

A saída é um ustar gzip determinístico para os mesmos bytes de entrada, mais `install.sh`, bootstrap independente e SHA256SUMS. O build normal ainda depende das fontes/dependências upstream fixadas; timestamps de builds distintos podem diferir. O pack remove `sourceRepo` da metadata e faz scan de arquivos de estado/chaves e paths pessoais em metadata. Isso não substitui revisão humana de segredos nem prova suporte a outro SO. Cada pacote declara apenas o par SO/arquitetura do build; rode startup real com provider falso e o gate completo nesse par antes de publicar. Esta implementação não publica, cria release, faz push ou migra o host.

## Desenvolvimento por checkout (legado)

Requer Git, npm e Node >=22.19. `node scripts/agent-update.mjs --prepare` constrói/testa sem ativar; `--promote <ID>` exige o recibo local host-bound intacto. `node scripts/agent-update.mjs` constrói e ativa; `--agent-enable` liga o runtime novo. O caminho legado sem runtime ainda pode copiar recursos e defaults ausentes e editar `.zshrc`/`.bashrc`; não o use como teste de distribuição no HOME real.

### Skills, papéis e mídia

- As skills pessoais `peers`, `megamind`, `prometheus`, `tasks` e as de `agent/skills/system/` são automáticas. `design/` e `plan/` ficam sob demanda e geram uma linha curta por categoria no system prompt. A curadoria usa o formatter compartilhado entre os hosts.
- `/skill` ou `/skill:` abre o catálogo agrupado por categoria; o runtime novo não exige modos simple/complex.
- `/models` separa slots de execução e escolhas por papel e preserva as escolhas pessoais. O picker de um papel lista primeiro os pares autorizados e depois todo modelo disponível; escolher um novo o autoriza naquele papel com o thinking da preferência atual. `Esc Esc` abre só a lista de fork. Falha de quota/503 não troca modelo silenciosamente.
- `read` é o nativo do Pi clássico: imagens, texto, offset/limit e cancelamento. O loadout controla quais papéis recebem `read`. Principal, scout e visual precisam de modelo capaz de receber imagens; anexos diretos continuam suportados.
- `scout` continua read-only (`read, grep, find, ls`). Transcrição que exija `ffmpeg`, Whisper ou outro executável deve ir para um papel com `bash`, não para o scout. Não se promete leitura/transcrição nativa de qualquer formato binário.
- JEV e cache observam compactação confirmada no branch para resetar sua época; pedido, cancelamento, queda de tokens ou erro não contam como compactação concluída. Nenhum evento sintético por correlação FIFO é usado.

## Estado da instalação e limpeza

```sh
agent overlay-status            # o que está rodando e se o checkout está à frente
agent overlay-gc --dry-run      # o que a limpeza apagaria (nada é apagado)
agent overlay-gc                # apaga, guardando 1 item sem uso de cada tipo
```

`/agent-doctor` mostra as tools registradas e declaradas na sessão, exposição (`direct`, `codemode`, `deferred`, etc.), origem real do registry e comandos/skills observados. Usa as APIs públicas do Pi; não adiciona tool ao prompt, não chama modelo, não faz probes e não altera settings. Na TUI/RPC abre o editor nativo como visualizador: o texto devolvido é descartado, nunca salvo ou enviado; em print escreve texto em stderr e em JSON emite `{ "type": "agent_doctor", "report": "..." }` em stderr, sem alterar o protocolo oficial em stdout. Funciona mesmo sem projeto Git. Configuração não prova atividade: hooks sem tool/comando e cobranças auxiliares ficam explicitamente como não observados; uma integração registrada não prova conexão. Para instalação use `agent overlay-status`; para recursos configurados, `agent config`; para uso/cache, `/session`, `/cost` e `/cache` quando disponíveis.

Defaults de inferência auxiliar no checkout: aprendizado automático exige `AGENT_LEARN=1` (receitas existentes permanecem intactas). O recap da TUI publica fallback local imediato e tenta Haiku (`PI_TUI_RECAP_MODEL`) → Luna, deduplicados, com até duas tentativas. Resumo em terceira pessoa, até 240 caracteres, sem hint. Erro terminal ou cancelamento não chamam modelo; retry recuperado permite resumo. Avisos semânticos exigem `PI_TUI_FEEDBACK=1` ou `/heads-up on`. `PI_TUI_FEEDBACK=0` e `/heads-up off` desativam também os cards. Cache-keeper e compatibilidade de imagens históricas permanecem.

Instalações por artefato atualizam com `agent update`, não com commits do checkout. `agent overlay-update` continua sendo o caminho de desenvolvimento que reconstrói a release.

## Dependências pessoais / degradação

O código de `agent/` não depende de caminhos literais `/Users/biel` (só um exemplo em `agent/extensions/agent/web/README.md`). `lib/paths.ts` conserva a descoberta opcional de `/mnt/garime` e `~/Sistema` (ou `PI_SYSTEM_DIR`); sem o mount usa o HOME local.

| Extensão | Sem infraestrutura pessoal |
|---|---|
| vault-runtime | `vault-runtime-quiet.patch`: Vault ausente não gera validação/rodapé com erros; mantém prompt nativo. Comandos explícitos de dump/sync continuam disponíveis. |
| subagent | `02-optional-role-models.patch`: models.json do Vault ausente não impede listar papéis nem iniciar jobs sem override; usa o modelo herdado. Allowlist existente continua sendo validada; override explícito sem allowlist continua recusado. Gate Megamind ausente é inerte; se explicitamente configurado e quebrado, continua falhando fechado. |
| models | Carrega normalmente; `/models` informa falta do arquivo de tiers somente quando solicitado. Use `/model` nativo sem Vault. Não distribuímos models.json. |
| generate-image | Carrega normalmente; execução exige tier image do Vault e login Codex próprios. Falta deles vira erro da tool, não erro de startup. |
| compaction | Sempre usa geração/prompt/validação nativos do Pi, mantendo Luna como modelo separado. Sem Luna/auth ou em falha, volta ao modelo atual. Não lê compactacao.md; arquivo pessoal preservado. |
| herdr-agent-state | Já inerte sem HERDR_ENV=1, socket e pane; erros de socket tratados. |
| tui | Código local, não depende de serviço Garime. Recursos interativos guardados por modo/UI; logs usam HOME local. |
| accounts | Usa contas/autenticação locais do parceiro; nada é copiado de Gabriel. Mirror só opera com dados locais existentes. |
| peers | IPC local em HOME/PI_MESH_DIR, sem serviço pessoal remoto; pasta é criada em runtime. |
| cost, sessions | Leem sessões locais; histórico vazio é válido. `03-sessions-explicit-gc-only.patch`: `sessions` não poda no `session_start`; apagar sessão velha/vazia só por `/gc` explícito. |
| image-normalize | Normalização local; nenhuma pasta pessoal obrigatória. |
| project-operator, checks | Operam sobre o projeto atual; não exigem repositório do Gabriel. |
| ask-user, btw, codex-fast, files, plan, slash-anywhere, todos, tool-lexicon, whimsical | Sem infraestrutura pessoal obrigatória. |

Os três patches citados ficam em `agent-patches/`.

## Verificação

```sh
for t in scripts/test-*.mjs; do ORCA_BACKGROUND_LAUNCH=1 node "$t" || exit; done
```

O teste de startup usa o Pi instalado, mas HOME, agent-dir, cwd e store temporários e ambiente sem credenciais herdadas. Carrega exatamente os registros instalados e abre `pi --mode json -p`, conferindo tools e os cinco papéis. O provider aponta para loopback fechado com chave fictícia: a falha de conexão é esperada, não há inferência real. Sem Pi instalado o teste informa que pulou; isso não equivale a validar startup. Não é teste visual da TUI.
