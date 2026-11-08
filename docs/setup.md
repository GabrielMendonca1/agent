# Setup distribuído do Mark II

`mark/` leva extensões de brain-live e do próprio Mark (`mark/extensions/mark`: accounts, peers, tui, whimsical, lib), 7 temas e os papéis planner, reviewer, scout, visual e worker. Não exige checkout de ARCA, Garime ou Sistema. Megamind e skills continuam no instalador existente.

## Instalar no Mac

Pré-requisitos: Git e Node >= 22.19 (recomendado Node 24), npm no PATH. Com Homebrew já instalado:

```sh
brew install git node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
git clone https://github.com/GabrielMendonca1/mark-pi.git "$HOME/mark-pi"
cd "$HOME/mark-pi"
node scripts/pi-overlay-update.mjs
export PATH="$HOME/.local/bin:$PATH"
pi
```

O updater constrói/testa a release antes de ativar. Abra `/login` para autenticar sua própria conta. Nenhuma credencial vem no bundle. O PATH do Node também precisa estar configurado para terminais futuros (siga as instruções do Homebrew).

Gabriel, para adotar o checkout atualizado (não executado nesta entrega):

```sh
cd /Users/biel/ARCA/clientes/arca-pi
git pull --ff-only
node scripts/pi-overlay-update.mjs
```

`pi overlay-update` de um bundle antigo não baixa este checkout. Para preparar sem ativar: `node scripts/pi-overlay-update.mjs --prepare`; depois promover o ID impresso com `node scripts/pi-overlay-update.mjs --promote <ID>`.

Para importar conversas do host durável no `/resume` do Pi clássico: no checkout, rode `node scripts/import-durable-sessions.mjs --dry-run`, depois `node scripts/import-durable-sessions.mjs --limit 1`; valide uma cópia temporária do JSONL com `pi --session <copia.jsonl> -p 'resuma em 1 linha o que conversamos'` (para não alterar o importado), e então rode `node scripts/import-durable-sessions.mjs`. O script lê cópias SQLite/WAL/SHM, recupera o cwd original e nunca substitui JSONLs; IDs existentes, sessões vazias e artefatos `.lock` são pulados com motivo. Cwds antigos inexistentes continuam preservados: o Pi interativo pede confirmação para usar outro diretório. O relatório conta entradas sem equivalente; timestamps ausentes usam o anterior e `tokensBefore` indisponível vira zero.

## Contrato da ativação

- O bundle autocontido inclui `mark/` e `scripts/lib/mark-setup.mjs`. A ativação com adoção do launcher copia os recursos para `<store>/mark`.
- Registra cada extensão em `settings.extensions`; nomes já auto-carregados em `<agent-dir>/extensions` (inclusive links) ou registrados pelo usuário prevalecem. Entradas próprias obsoletas saem; entradas pessoais nunca são removidas.
- `tui` (antes `garime-tui`) é registrado da árvore `mark/extensions/mark`; a cópia pessoal `garime-tui` é tratada como a mesma extensão e cede/é excluída. Uma cópia interna em brain-live satisfaz o import relativo de ipython, sem registro duplicado.
- `settings.themes` aceita diretórios/arquivos segundo a documentação do Pi. Temas pessoais prevalecem pelo nome declarado no JSON. Os temas do Mark vão para `<agent-dir>/themes` com o marcador `.mark-themes` (sem sufixo `.json`, que o Pi leria como tema e reportaria inválido); o marcador antigo `.mark-themes.json` é migrado e removido, sem perder a propriedade dos temas já instalados.
- Colisão de nome com tema pessoal: a cópia que o marcador prova ser do Mark sai de cena (um nome, um arquivo — dois seriam colisão de recurso no Pi) e nenhum tema fora do marcador é tocado. Retirado o tema pessoal, a próxima ativação reinstala e volta a atualizar o do Mark.
- A extensão subagent procura papéis em `getAgentDir()/agents`, não em uma chave de settings. O instalador copia ali e usa `.mark-agents.json` para atualizações. Diretório pessoal preexistente ou symlink fica intocado; os papéis distribuídos continuam disponíveis no store.
- Defaults somente para chaves de primeiro nível ausentes: Anthropic / `claude-opus-5-5`, thinking `medium`, tema `grayscale-baimin-claude-cc-mark-light/grayscale-baimin-claude-cc-mark`, `tuiMode=fullscreen`, `quietStartup=false`, `hideThinkingBlock=false`. A camada opcional `context-windows` foi removida do repo e nada lê `contextWindows`; o default deixou de ser escrito (um `contextWindows` já presente no settings do usuário não é tocado).
- Acrescenta um bloco marcado/idempotente para `~/.local/bin` em `.zshrc` e `.bashrc`, criando ambos quando ausentes. Reconhece configurações PATH equivalentes com `$HOME`, `${HOME}` ou `~`.
- `-mark-setup` impede a sincronização inteira; não desinstala registros de uma ativação anterior. `-nome`/`!nome` impede o registro daquela extensão.
- Windows: o updater já fornece seu launcher nativo; este módulo não altera rc nem PATH do Windows. Esta entrega foi verificada no macOS, não certifica Windows.

## Mark II no updater (opt-in persistente)

O updater instala o Mark II como opt-in do store: ele não muda modelo, thinking, papéis, HOME, `PI_CODING_AGENT_DIR`, SYSTEM/Vault, OAuth nem `mark2`.

```sh
# Para um perfil novo; para preservar contabilidade, use o diretório Juice já existente.
mkdir -p -m 700 "$HOME/.mark-juice"
# ligar sobre a release que já está ativa (não reconstrói nem promove nada)
node scripts/pi-overlay-update.mjs --mark-ii-enable --juice-home "$HOME/.mark-juice"

# informa o status e também roda a verificação/build do overlay (pode demorar)
node scripts/pi-overlay-update.mjs --check

# desligar (volta o delta de recursos e mantém o artefato para religar)
node scripts/pi-overlay-update.mjs --mark-ii-disable
```

`--mark-ii-enable` exige `--juice-home <caminho absoluto>` apontando para um diretório existente; a validação acontece antes de qualquer escrita. `--juice-home` só vale com ele. Os modos `--prepare`, `--promote`, `--check`, `--rollback`, `--mark-ii-enable` e `--mark-ii-disable` são mutuamente exclusivos, e os dois modos do Mark II recusam flags de build (`--ref`, `--with`, `--without`, `--hydrate`, `--simulate-conflict`, `--no-prune`, `--vendor-model-data`): eles operam sobre o par já instalado. `--store`, `--force` e `--adopt-launcher` continuam valendo.

Ordem do `--mark-ii-enable` (artefatos antes de launcher, recursos e configuração):

1. a release de `current` é verificada contra o contrato do overlay (`--force` aceita uma release degradada de propósito);
2. `prepareMarkIIArtifact` + `validateMarkIIArtifact` para o host durável da release — o `piRoot` do par é a cópia instalada do pacote oficial (`<release>/lib/node_modules/<pacote>`, que tem `dist/bundle/cli.js`), não a raiz da release;
3. `planMarkIIResources` planeja o registro (nada é escrito nesta fase);
4. backup seletivo em `<store>/backups/<timestamp>-mark-ii-enable/` com `active.json`, o wrapper do store, o comando de restauração do launcher e a config anterior — sem settings inteiro, sem auth/Vault/ledger;
5. bundle + wrapper novos (o bundle instalado passa a levar `scripts/mark-ii-launch.mjs`, `scripts/lib/mark-ii-runtime.mjs` e `scripts/lib/mark-ii-resources.mjs`);
6. `applyMarkIIResources` com backup/CAS/recibo no caminho estável `<store>/mark-ii/resources-backup/`;
7. a configuração (`enabled:true`, `artifactId`, `piRoot`, `juiceHome`, `resourceReceipt`) é o último passo, e só então `active.json` registra o resumo em `markII`.

`--mark-ii-enable` sobre um opt-in que já vale com **outro** artefato é troca de par, não primeira ativação: em vez do passo 6, roda a mesma sequência de troca descrita abaixo (snapshot do recibo → rollback do par antigo → replanejar/aplicar o novo). Religar o **mesmo** artefato continua idempotente.

Qualquer falha antes do passo 7 deixa o Mark II **desligado**: nenhuma configuração é escrita, `pi` continua no caminho legado e o que já tinha sido aplicado é desfeito pelo recibo (quando o helper devolve um). Se o helper aplicar recursos sem devolver recibo, o updater recusa a ativação e diz exatamente o que ficou para trás — não declara limpeza que não fez.

`--mark-ii-disable` fecha o opt-out primeiro (config `enabled:false`) e só depois devolve o delta de recursos: se o rollback falhar, `pi` já voltou ao legado e o comando pode ser repetido (é idempotente). O artefato, o ledger, o `mark2` e os arquivos pessoais não são removidos. Depois do opt-out, a ativação volta a rodar o sync legado do `mark/`.

Com o Mark II ligado, `update`/`--promote`/`--rollback` preparam e validam o **par novo** (Pi + artefato) antes de trocar qualquer ponteiro e preservam `enabled` e `juiceHome`; se o par não puder ser preparado, a troca é recusada e nada muda. A release que a configuração aponta como `piRoot` nunca é coletada pela poda.

Trocar o par troca também os **registros efetivos** de recursos, não só `artifactId`/`piRoot`: depois de os ponteiros já valerem e antes de a configuração nova ser escrita, o updater

1. copia o recibo do par antigo (que é reescrito pela aplicação) para `<store>/mark-ii/resource-snapshots/`;
2. desfaz o recibo antigo com `rollbackMarkIIResources` — o settings volta ao estado **pessoal original** guardado em CAS;
3. replaneja e aplica o `markRoot` do artefato novo sobre esse estado (`planMarkIIResources` + `applyMarkIIResources`, mesmo `backupDir`).

Assim nunca ficam as extensões de duas gerações carregadas ao mesmo tempo (par misturado, tools duplicadas), e o recibo resultante continua descrevendo o estado pessoal como “antes” — por isso um `--mark-ii-disable` posterior devolve os registros genuinamente originais, e não o estado intermediário de uma geração anterior. Um `rollbackMarkIIResources` que devolve `conflicts` (mudança posterior do usuário preservada) é tratado como **erro**, nunca como sucesso.

Falha no meio da troca: o updater reaplica os registros do par anterior, volta a configuração e os ponteiros, e diz exatamente o que ficou de pé; se nem a reaplicação funcionar, o relatório diz que o settings está no estado pessoal (sem Mark II) e aponta o snapshot do recibo — em vez de alegar “nada mudou”. Um opt-in cujo `resourceReceipt` desapareceu faz a atualização ser **recusada antes dos ponteiros** (sem recibo não há como desfazer o par antigo).

Nesse modo os syncs legados não rodam na ativação: nem `syncMarkSetup` (settings/temas/papéis e blocos de `.zshrc`/`.bashrc`), nem `syncMarkSkills`, nem `syncMarkExtensions` — todos escrevem `settings.extensions`/`settings.skills` **sem recibo**, ou seja, entradas que nem o opt-out nem a troca de par saberiam desfazer. Consequência conhecida: com o Mark II ligado, as cópias de `<store>/skills` e `<store>/extensions/megamind` deixam de ser atualizadas pela ativação (o Megamind não está no plano de recursos do Mark III, que cobre `mark/extensions/mark`, `mark/extensions/brain-live`, `mark/skills` e temas). Com `--mark-ii-disable`, a ativação volta a rodar os três syncs legados.

Restaurar à mão, se preciso: cada backup traz `restore.txt` com os comandos (`cp .../active.json <store>/active.json`, `cp -p .../pi-wrapper <store>/bin/pi-wrapper`, `ln -sfn <alvo> ~/.local/bin/pi`) e aponta o diretório do recibo/CAS dos recursos. Um store que não é o padrão só registra recursos com `PI_CODING_AGENT_DIR` definido: fixtures e testes não escrevem no perfil real.

### Atalhos do MARK II

- `Shift+Tab`: modo simple/complex; `Ctrl+T`: thinking nativo do Pi.
- O helper suspende somente Shift+Tab em `app.thinking.cycle`, com recibo/CAS e rollback. Não altera nível/visibilidade do thinking nem modelo; mantém outros atalhos canônicos personalizados. Nomes legados são conservados e reportados como limitação (o SDK prioriza a chave canônica).
- É preciso abrir um novo `pi` para carregar a atualização; sessões existentes não são reiniciadas.

### Skills, papéis e mídia

- As skills pessoais `peers`, `megamind`, `prometheus`, `tasks` e as de `mark/skills/system/` são automáticas. `design/` e `plan/` ficam sob demanda e geram uma linha curta por categoria no system prompt. A curadoria usa o formatter compartilhado entre os hosts.
- `/skill` ou `/skill:` abre o catálogo agrupado por categoria. `◆` indica skill automática. `Tab` visita categorias; filtro por nome/descrição, setas para escolher, `Enter` insere sem enviar e `Esc` fecha. Não muda simple/complex.
- `/models` separa slots de execução e escolhas por papel e preserva as escolhas pessoais. O picker de um papel lista primeiro os pares autorizados e depois todo modelo disponível; escolher um novo o autoriza naquele papel com o thinking da preferência atual. `Esc Esc` abre só a lista de fork (o grafo de sessão foi removido). Falha de quota/503 não troca modelo silenciosamente.
- `read` é o nativo do Pi clássico: imagens, texto, offset/limit e cancelamento. O override `read-media`, criado para o host durável antigo, foi retirado do bundle e dos filhos; cópias pessoais antigas são excluídas pelo recibo na próxima ativação. O loadout continua controlando quais papéis recebem `read`. Principal, scout e visual precisam de modelo capaz de receber imagens; anexos diretos continuam suportados.
- `scout` continua read-only (`read, grep, find, ls`). Transcrição que exija `ffmpeg`, Whisper ou outro executável deve ir para um papel com `bash`, não para o scout. Não se promete leitura/transcrição nativa de qualquer formato binário.
- JEV e cache observam compactação confirmada no branch para resetar sua época; pedido, cancelamento, queda de tokens ou erro não contam como compactação concluída. Nenhum evento sintético por correlação FIFO é usado.

## Atualizar a cópia

Na máquina com as fontes vivas:

```sh
node scripts/vendor-gabriel-setup.mjs
node scripts/vendor-gabriel-setup.mjs --check
```

O script copia as fontes, aplica `mark-patches/*.patch`, recusa nomes de arquivos privados e padrões conhecidos de tokens, e só então substitui `mark/`. Falha de patch exige revisão; não é ignorada. A cópia temporária é removida também em falhas. Nunca copiar auth.json, accounts*.json, secrets, sessions, durable-sessions, mcp.json, models.json, logs ou caches. A varredura é uma proteção adicional, não uma garantia geral de detecção de segredos.

## Estado da instalação e limpeza

```sh
pi overlay-status            # o que está rodando e se o checkout está à frente
pi overlay-gc --dry-run      # o que a limpeza apagaria (nada é apagado)
pi overlay-gc                # apaga, guardando 1 item sem uso de cada tipo
```

`/mark-doctor` mostra as tools registradas e declaradas na sessão, exposição (`direct`, `codemode`, `deferred`, etc.), origem real do registry e comandos/skills observados. Usa as APIs públicas do Pi; não adiciona tool ao prompt, não chama modelo, não faz probes e não altera settings. Na TUI/RPC abre o editor nativo como visualizador: o texto devolvido é descartado, nunca salvo ou enviado; em print escreve texto em stderr e em JSON emite `{ "type": "mark_doctor", "report": "..." }` em stderr, sem alterar o protocolo oficial em stdout. Funciona mesmo sem projeto Git. Configuração não prova atividade: hooks sem tool/comando e cobranças auxiliares ficam explicitamente como não observados; uma integração registrada não prova conexão. Para instalação use `pi overlay-status`; para recursos configurados, `pi config`; para uso/cache, `/session`, `/cost` e `/cache` quando disponíveis.

Defaults de inferência auxiliar no checkout: aprendizado automático exige `MARK_LEARN=1` (receitas existentes permanecem intactas). O recap da TUI publica fallback local imediato e tenta Haiku (`PI_TUI_RECAP_MODEL`) → Luna, deduplicados, com até duas tentativas. Resumo em terceira pessoa, até 240 caracteres, sem hint. Erro terminal ou cancelamento não chamam modelo; retry recuperado permite resumo. Avisos semânticos exigem `PI_TUI_FEEDBACK=1` ou `/heads-up on`. `PI_TUI_FEEDBACK=0` e `/heads-up off` desativam também os cards. Cache-keeper e compatibilidade de imagens históricas permanecem. Esses defaults só chegam à instalação após uma promoção autorizada.

Publicar o repo não atualiza ninguém: com Mark II ligado, o Pi avisa ao abrir quando o checkout de origem tem commits não instalados; atualize com `node <checkout>/scripts/pi-overlay-update.mjs`. Detalhes em [overlay/README.md](../overlay/README.md#estado-e-limpeza-do-store--overlay-status-overlay-gc).

## Dependências pessoais / degradação

A varredura não encontrou caminhos literais `/Users/biel` em `mark/`. `lib/paths.ts` conserva a descoberta opcional de `/mnt/garime` e `~/Sistema` (ou `PI_SYSTEM_DIR`); sem o mount usa o HOME local. Nenhuma extensão foi excluída.

| Extensão | Sem infraestrutura pessoal |
|---|---|
| vault-runtime | `vault-runtime-quiet.patch`: Vault ausente não gera validação/rodapé com erros; mantém prompt nativo. Comandos explícitos de dump/sync continuam disponíveis. |
| subagent | `02-optional-role-models.patch`: models.json do Vault ausente não impede listar papéis nem iniciar jobs sem override; usa o modelo herdado. Allowlist existente continua sendo validada; override explícito sem allowlist continua recusado. Gate Megamind ausente é inerte; se explicitamente configurado e quebrado, continua falhando fechado. |
| models | Carrega normalmente; `/models` informa falta do arquivo de tiers somente quando solicitado. Use `/model` nativo sem Vault. Não distribuímos models.json. |
| generate-image | Carrega normalmente; execução exige tier image do Vault e login Codex próprios. Falta deles vira erro da tool, não erro de startup. |
| compaction | Sempre usa geração/prompt/validação nativos do Pi, mantendo Luna como modelo separado. Sem Luna/auth ou em falha, volta ao modelo atual. Não lê mais compactacao.md; arquivo pessoal preservado. |
| herdr-agent-state | Já inerte sem HERDR_ENV=1, socket e pane; erros de socket tratados. |
| tui | Código local, não depende de serviço Garime. Recursos interativos guardados por modo/UI; logs usam HOME local. |
| ipython | Import relativo de `../tui/compact-tools` satisfeito pela cópia interna. Kernel só é iniciado ao executar a tool; Python/uv e dependências são necessários nesse momento, não no startup. |
| accounts | Usa contas/autenticação locais do parceiro; nada é copiado de Gabriel. Mirror só opera com dados locais existentes. |
| peers | IPC local em HOME/PI_MESH_DIR, sem serviço pessoal remoto; pasta é criada em runtime. |
| cost, sessions | Leem sessões locais; histórico vazio é válido. `03-sessions-explicit-gc-only.patch`: `sessions` não poda no `session_start`; apagar sessão velha/vazia só por `/gc` explícito. |
| image-normalize | Normalização local; nenhuma pasta pessoal obrigatória. |
| project-operator, checks | Operam sobre o projeto atual; não exigem repositório do Gabriel. |
| ask-user, btw, codex-fast, files, plan, slash-anywhere, todos, tool-lexicon, whimsical | Sem infraestrutura pessoal obrigatória; código mantido fiel à fonte. |

## Verificação

```sh
for t in scripts/test-*.mjs; do ORCA_BACKGROUND_LAUNCH=1 node "$t" || exit; done
node scripts/vendor-gabriel-setup.mjs --check
```

O teste de startup usa o Pi instalado, mas HOME, agent-dir, cwd e store temporários e ambiente sem credenciais herdadas. Carrega exatamente os registros instalados e abre `pi --mode json -p`, conferindo tools e os cinco papéis. O provider aponta para loopback fechado com chave fictícia: a falha de conexão é esperada, não há inferência real. Sem Pi instalado o teste informa que pulou; isso não equivale a validar startup. Não é teste visual da TUI.
