# Setup distribuído do Agent

`agent/` leva extensões de brain-live e do próprio Agent (`agent/extensions/agent`: accounts, peers, tui, web, whimsical, lib), 7 temas e os papéis planner, reviewer, scout, visual e worker. Não exige checkout de ARCA, Garime ou Sistema. Megamind e skills vêm do mesmo instalador.

## Instalar no Mac

Pré-requisitos: Git e Node >= 22.19 (recomendado Node 24), npm no PATH. Com Homebrew já instalado:

```sh
brew install git node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
git clone https://github.com/GabrielMendonca1/agent.git "$HOME/agent"
cd "$HOME/agent"
node scripts/agent-update.mjs
export PATH="$HOME/.local/bin:$PATH"
agent
```

O updater constrói/testa a release antes de ativar e instala em `~/.local/share/agent`, com o comando `agent` em `~/.local/bin`. O perfil do Agent (settings, auth, sessões, extensões) fica em `~/.agent` (`PI_CODING_AGENT_DIR`, fixado pelo wrapper): rode o updater com `PI_CODING_AGENT_DIR="$HOME/.agent"` para registrar os recursos nesse perfil e não no `~/.pi/agent` de um Pi/Mark já instalado. Abra `/login` para autenticar sua própria conta. Nenhuma credencial vem no bundle. O PATH do Node também precisa estar configurado para terminais futuros (siga as instruções do Homebrew).

`agent overlay-update` roda o updater do bundle instalado e não baixa commits novos do checkout; para isso rode `node scripts/agent-update.mjs` no checkout. Para preparar sem ativar: `node scripts/agent-update.mjs --prepare`; depois promover o ID impresso com `node scripts/agent-update.mjs --promote <ID>`.

Para importar conversas do host durável no `/resume` do Pi clássico: no checkout, rode `node scripts/import-durable-sessions.mjs --dry-run`, depois `node scripts/import-durable-sessions.mjs --limit 1`; valide uma cópia temporária do JSONL com `agent --session <copia.jsonl> -p 'resuma em 1 linha o que conversamos'` (para não alterar o importado), e então rode `node scripts/import-durable-sessions.mjs`. O script lê cópias SQLite/WAL/SHM, recupera o cwd original e nunca substitui JSONLs; IDs existentes, sessões vazias e artefatos `.lock` são pulados com motivo. Cwds antigos inexistentes continuam preservados: o Pi interativo pede confirmação para usar outro diretório. O relatório conta entradas sem equivalente; timestamps ausentes usam o anterior e `tokensBefore` indisponível vira zero.

## Contrato da ativação

- O bundle autocontido inclui `agent/` e `scripts/lib/agent-setup.mjs`. A ativação com adoção do launcher copia os recursos para `<store>/agent`.
- Registra cada extensão em `settings.extensions`; nomes já auto-carregados em `<agent-dir>/extensions` (inclusive links) ou registrados pelo usuário prevalecem. Entradas próprias obsoletas saem; entradas pessoais nunca são removidas.
- `tui` (antes `garime-tui`) é registrado da árvore `agent/extensions/agent`; a cópia pessoal `garime-tui` é tratada como a mesma extensão e cede/é excluída.
- `settings.themes` aceita diretórios/arquivos segundo a documentação do Pi. Temas pessoais prevalecem pelo nome declarado no JSON. Os temas do Agent vão para `<agent-dir>/themes` com o marcador `.agent-themes` (sem sufixo `.json`, que o Pi leria como tema e reportaria inválido).
- Colisão de nome com tema pessoal: a cópia que o marcador prova ser do Agent sai de cena (um nome, um arquivo — dois seriam colisão de recurso no Pi) e nenhum tema fora do marcador é tocado. Retirado o tema pessoal, a próxima ativação reinstala e volta a atualizar o do Agent.
- A extensão subagent procura papéis em `getAgentDir()/agents`, não em uma chave de settings. O instalador copia ali e usa `.agent-agents.json` para atualizações. Diretório pessoal preexistente ou symlink fica intocado; os papéis distribuídos continuam disponíveis no store.
- Defaults somente para chaves de primeiro nível ausentes: Anthropic / `claude-opus-5-5`, thinking `medium`, tema `grayscale-baimin-claude-cc-agent-light/grayscale-baimin-claude-cc-agent`, `tuiMode=fullscreen`, `quietStartup=false`, `hideThinkingBlock=false`. Um `contextWindows` já presente no settings do usuário não é tocado; nada o lê.
- Acrescenta um bloco marcado/idempotente para `~/.local/bin` em `.zshrc` e `.bashrc`, criando ambos quando ausentes. Reconhece configurações PATH equivalentes com `$HOME`, `${HOME}` ou `~`.
- `-agent-setup` impede a sincronização inteira; não desinstala registros de uma ativação anterior. `-nome`/`!nome` impede o registro daquela extensão.
- Windows: o updater já fornece seu launcher nativo; este módulo não altera rc nem PATH do Windows. Verificado no macOS, não certificado no Windows.

## Runtime do Agent no updater (opt-in persistente)

O updater instala o runtime do Agent como opt-in do store, em `<store>/runtime/` (`config.json` e `releases/<id>/agent`). Ele não muda modelo, thinking, papéis, HOME, `PI_CODING_AGENT_DIR`, SYSTEM/Vault nem OAuth.

```sh
# Para um perfil novo; para preservar contabilidade, use o diretório Juice já existente.
mkdir -p -m 700 "$HOME/.agent-juice"
# ligar sobre a release que já está ativa (não reconstrói nem promove nada)
node scripts/agent-update.mjs --agent-enable --juice-home "$HOME/.agent-juice"

# informa o status e também roda a verificação/build do overlay (pode demorar)
node scripts/agent-update.mjs --check

# desligar (volta o delta de recursos e mantém o artefato para religar)
node scripts/agent-update.mjs --agent-disable
```

`--agent-enable` exige `--juice-home <caminho absoluto>` apontando para um diretório existente; a validação acontece antes de qualquer escrita. `--juice-home` só vale com ele. Os modos `--prepare`, `--promote`, `--check`, `--rollback`, `--agent-enable` e `--agent-disable` são mutuamente exclusivos, e os dois modos do runtime recusam flags de build (`--ref`, `--with`, `--without`, `--hydrate`, `--simulate-conflict`, `--no-prune`, `--vendor-model-data`): eles operam sobre o par já instalado. `--store`, `--force` e `--adopt-launcher` continuam valendo.

Ordem do `--agent-enable` (artefatos antes de launcher, recursos e configuração):

1. a release de `current` é verificada contra o contrato do overlay (`--force` aceita uma release degradada de propósito);
2. o artefato é preparado e validado para a release — o `piRoot` do par é a cópia instalada do pacote oficial (`<release>/lib/node_modules/<pacote>`, que tem `dist/bundle/cli.js`), não a raiz da release;
3. o registro de recursos é planejado (nada é escrito nesta fase);
4. backup seletivo em `<store>/backups/<timestamp>-agent-enable/` com `active.json`, o wrapper do store, o comando de restauração do launcher e a config anterior — sem settings inteiro, sem auth/Vault/ledger;
5. bundle + wrapper novos (o bundle instalado passa a levar `scripts/agent-launch.mjs`, `scripts/lib/agent-runtime.mjs` e `scripts/lib/agent-resources.mjs`);
6. os recursos são aplicados com backup/CAS/recibo no caminho estável `<store>/runtime/resources-backup/`;
7. a configuração (`enabled:true`, `artifactId`, `piRoot`, `juiceHome`, `resourceReceipt`) é o último passo, e só então `active.json` registra o resumo.

`--agent-enable` sobre um opt-in que já vale com **outro** artefato é troca de par, não primeira ativação: em vez do passo 6, roda a mesma sequência de troca descrita abaixo (snapshot do recibo → rollback do par antigo → replanejar/aplicar o novo). Religar o **mesmo** artefato continua idempotente.

Qualquer falha antes do passo 7 deixa o runtime **desligado**: nenhuma configuração é escrita, `agent` continua no caminho legado (Pi do overlay sem o runtime) e o que já tinha sido aplicado é desfeito pelo recibo (quando o helper devolve um). Se o helper aplicar recursos sem devolver recibo, o updater recusa a ativação e diz exatamente o que ficou para trás — não declara limpeza que não fez.

`--agent-disable` fecha o opt-out primeiro (config `enabled:false`) e só depois devolve o delta de recursos: se o rollback falhar, `agent` já voltou ao legado e o comando pode ser repetido (é idempotente). O artefato, o ledger e os arquivos pessoais não são removidos. Depois do opt-out, a ativação volta a rodar o sync legado de `agent/`.

Com o runtime ligado, `update`/`--promote`/`--rollback` preparam e validam o **par novo** (Pi + artefato) antes de trocar qualquer ponteiro e preservam `enabled` e `juiceHome`; se o par não puder ser preparado, a troca é recusada e nada muda. A release que a configuração aponta como `piRoot` nunca é coletada pela poda.

Trocar o par troca também os **registros efetivos** de recursos, não só `artifactId`/`piRoot`: depois de os ponteiros já valerem e antes de a configuração nova ser escrita, o updater

1. copia o recibo do par antigo (que é reescrito pela aplicação) para `<store>/runtime/resource-snapshots/`;
2. desfaz o recibo antigo — o settings volta ao estado **pessoal original** guardado em CAS;
3. replaneja e aplica a árvore `agent/` do artefato novo sobre esse estado (mesmo `backupDir`).

Assim nunca ficam as extensões de duas gerações carregadas ao mesmo tempo (par misturado, tools duplicadas), e o recibo resultante continua descrevendo o estado pessoal como “antes” — por isso um `--agent-disable` posterior devolve os registros genuinamente originais, e não o estado intermediário de uma geração anterior. Um rollback de recursos que devolve `conflicts` (mudança posterior do usuário preservada) é tratado como **erro**, nunca como sucesso.

Falha no meio da troca: o updater reaplica os registros do par anterior, volta a configuração e os ponteiros, e diz exatamente o que ficou de pé; se nem a reaplicação funcionar, o relatório diz que o settings está no estado pessoal (sem o runtime) e aponta o snapshot do recibo — em vez de alegar “nada mudou”. Um opt-in cujo `resourceReceipt` desapareceu faz a atualização ser **recusada antes dos ponteiros** (sem recibo não há como desfazer o par antigo).

Nesse modo os syncs legados (setup — settings/temas/papéis e blocos de `.zshrc`/`.bashrc` —, skills e extensões) não rodam na ativação: todos escrevem `settings.extensions`/`settings.skills` **sem recibo**, ou seja, entradas que nem o opt-out nem a troca de par saberiam desfazer. Consequência conhecida: com o runtime ligado, as cópias de `<store>/skills` e `<store>/extensions/megamind` deixam de ser atualizadas pela ativação (o Megamind não está no plano de recursos, que cobre `agent/extensions/agent`, `agent/extensions/brain-live`, `agent/skills` e temas). Com `--agent-disable`, a ativação volta a rodar os três syncs legados.

Restaurar à mão, se preciso: cada backup traz `restore.txt` com os comandos (`cp .../active.json <store>/active.json`, `cp -p .../pi-wrapper <store>/bin/pi-wrapper`, `ln -sfn <alvo> ~/.local/bin/agent`) e aponta o diretório do recibo/CAS dos recursos. Um store que não é o padrão só registra recursos com `PI_CODING_AGENT_DIR` definido: fixtures e testes não escrevem no perfil real.

### Atalhos

- `Shift+Tab`: modo simple/complex; `Ctrl+T`: thinking nativo do Pi.
- O helper suspende somente Shift+Tab em `app.thinking.cycle`, com recibo/CAS e rollback. Não altera nível/visibilidade do thinking nem modelo; mantém outros atalhos canônicos personalizados. Nomes legados são conservados e reportados como limitação (o SDK prioriza a chave canônica).
- É preciso abrir um novo `agent` para carregar a atualização; sessões existentes não são reiniciadas.

### Skills, papéis e mídia

- As skills pessoais `peers`, `megamind`, `prometheus`, `tasks` e as de `agent/skills/system/` são automáticas. `design/` e `plan/` ficam sob demanda e geram uma linha curta por categoria no system prompt. A curadoria usa o formatter compartilhado entre os hosts.
- `/skill` ou `/skill:` abre o catálogo agrupado por categoria. `◆` indica skill automática. `Tab` visita categorias; filtro por nome/descrição, setas para escolher, `Enter` insere sem enviar e `Esc` fecha. Não muda simple/complex.
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

Publicar o repo não atualiza ninguém: com o runtime ligado, o Agent avisa ao abrir quando o checkout de origem tem commits não instalados; atualize com `node <checkout>/scripts/agent-update.mjs`. Detalhes em [overlay/README.md](../overlay/README.md#estado-e-limpeza-do-store--overlay-status-overlay-gc).

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
