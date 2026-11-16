# Overlay do Agent — Pi oficial v1.5.0 clássico

O entrypoint é o main oficial do Pi, com patches pequenos na ordem do manifesto:

1. `pi-black` — lane OAuth Anthropic.
2. `garime-frame` — margens, respiro e cores inline na TUI clássica.
3. `pi-account-env` — conta por projeto e `--arca-capabilities` (`{"accountEnv":1}`).
4. `transcript-feedback` — observador e widgets após o transcript clássico; até 3 tentativas de aviso por execução, a cada 3 resultados novos e 45 s por padrão.
5. `stream-markdown` — agrupamento de deltas e PI_TUI_HZ; cache Markdown upstream.
6. `agent-skill-curation` — curadoria opt-in do anúncio de skills.
7. `codemode-typed-results` — resultados estruturados de read/grep/find em scripts, sem mudar o texto das chamadas diretas.
8. `codemode-background` — espera padrão de 5 minutos, saída parcial, conclusão e cancelamento de jobs.
9. `tool-load-append` — tool carregada no meio da sessão não reescreve o system prompt; as instruções dela vão no fim da conversa, pelo mesmo caminho da seção MCP.
10. `cc-hidden-tool-names` — no OAuth Anthropic, `Bash`/`Read` de uma tool escondida pelo codemode `only` voltam em minúsculas.

Total: 10 patches, além das extensões do Agent.

## Port 1.5.0

Base `f9a26365568127461c47a07a37dcb42c140a3ac5`. O cache Markdown, o reuso de componentes, thinking oculto sem espaçador e entry graphs POSIX são upstream. Sai `win-entry-graphs`; `stream-markdown` mantém batching e PI_TUI_HZ. Resumo Haiku → Luna → local em terceira pessoa (até 240 caracteres), sem hint. Erro recuperado por retry não é cancelamento; erro terminal/cancelamento ficam locais.

Updater e Agent interativo não compilam nem usam broker Rust: artefatos contêm a árvore `agent/` sem broker.

Pendências: propor o batching/PI_TUI_HZ de `stream-markdown` upstream e validar em Windows real (launcher, codemode, JSONL, subagentes e contas). Sessões SQLite antigas não são migradas por este overlay.

Camadas opcionais:

Nenhuma camada opcional está declarada hoje. `context-windows` (boundaries append-only, notas duráveis, histórico de branches) foi removida do repo; o histórico fica no git. O mecanismo de camadas opcionais (`"optional": true` no manifesto, `--with`/`--without`, `layers.json`) continua. Camadas opcionais seriam grandes e invasivas; mantê-las fora do default significa que o port delas travado nunca bloqueia o update de quem não as usa.

A ordem do manifesto é autoritativa. Pi Black mantém a compatibilidade de provider em `packages/ai`; o frame cuida da interface e `pi-account-env` da seleção/refresh de contas. `git apply --3way` absorve offsets comuns e rejeita drift real.

### Selecionar camadas

```sh
agent overlay-update --with <camada>     # instala base + camada
agent overlay-update --without <camada>  # volta para só base
agent overlay-update                     # repete a última seleção instalada
```

`--with`/`--without` são repetíveis e aceitam lista separada por vírgula. Um nome que não existe, ou um `--with` de patch base, aborta com erro antes de qualquer clone.

A seleção vive em `<store>/layers.json` (`{"optional":["<camada>"]}`) e só é gravada **depois de uma instalação real bem-sucedida** — nunca em `--check`, nunca num gate vermelho. Sem flags e sem arquivo, a seleção é só a base.

A tool nativa `codemode` do Pi é ativada em toda sessão do Agent quando registrada, por `activeToolsFor` em `agent/extensions/brain-live/juice.ts`. Ela executa JavaScript isolado e chama as tools do Pi; substitui ipython, sem kernel adicional para compilar.

`agent-patches/` contém `02-optional-role-models.patch`, `03-sessions-explicit-gc-only.patch` e `vault-runtime-quiet.patch`. `agent/juice/` guarda o preload, as preferências, o modo simple/complex e a política de cache, sem binário. Ledger, contabilidade e aprendizado automático foram removidos no runtime atual; contrato em `agent/juice/PROTOCOL.md`.

Subagentes são processos `pi -p`; `parentSession` liga o JSONL do filho ao do pai. Não há execução de subagente em host durável nem retomada automática de run interrompida.

Cache de abertura: depois de ativar uma release (instalação, `--promote`, `--agent-enable`) no store padrão, o updater roda `agent --offline --list-models` pelo launcher instalado para transpilar as extensões e preencher o cache de compilação do Node. Sem isso a primeira sessão da release nova abre em ~1,5 s em vez de ~0,5 s. Melhor esforço; `AGENT_WARM_START=0` desliga.

Um store instalado antes de `layers.json` existir não registrou seleção nenhuma, e um `agent overlay-update` sem flags tiraria dele a camada que ele tinha. Quando o arquivo falta, a seleção é **semeada** pelo que a release ativa registrou (`active.json:optionalLayers`, ou os nomes em `active.json:patches` que o manifesto declara como opcionais), com um aviso dizendo de onde veio; se aquela camada não aplicar na release nova, a mensagem de erro sugere `--without <nome>`. Um `layers.json` já gravado (inclusive `{"optional":[]}`) é escolha explícita e nunca é semeado por cima.

`agent overlay-rollback` também sincroniza `layers.json` com as camadas opcionais da release de destino: depois de voltar para uma release só-base, o próximo `agent overlay-update` sem flags não reintroduz a camada.

A seleção é identidade: `overlayFingerprint`, os testes executados, os markers exigidos, `patches`/`optionalLayers` na metadata da release e `active.json` cobrem exatamente os patches selecionados. Base e base+camada nunca compartilham diretório de release.

Se uma camada opcional não aplicar, a mensagem nomeia a camada e sugere `--without <nome>`; a instalação ativa continua intocada.

Verificação e rollback usam o que **a release registrou**, não a seleção atual: fazer rollback para uma release antiga que carregava três patches continua funcionando depois de a camada sair do default, e releases anteriores a `optionalLayers` continuam verificáveis. Cada `compatibility.bundleMarkers[]` declara o `patch` a que pertence, e um marker só é exigido quando aquele patch está na release conferida.

### Garime fullscreen frame

Em fullscreen, `insetLayoutRoot` mantém o transcript afastado das bordas. `PI_TUI_MARGIN_X` (default 2) e `PI_TUI_MARGIN_Y` (default 0, sem margem externa no topo e no fundo) são limitados e viram no-op em zero. Um `Spacer` de `PI_TUI_TRANSCRIPT_TAIL` fecha o container do documento (default 2 no frame base, elevado a 3 no host clássico pela camada `transcript-feedback`; override 0..8 preservado). A camada `transcript-feedback` move `Working…` para o fim do documento rolável, após as mensagens/tools, com duas linhas em branco e intervalo padrão de 60 ms (no pi-tui, só `frames` próprios são renderizados verbatim; um intervalo isolado mantém a cor do tema). Retry/compaction mantêm a posição upstream.

`readTuiBlockGap` (mesmo helper, mesma semântica de leitura) governa a separação **entre blocos** do transcript: mensagem do usuário, mensagem/pensamento do assistente, card de tool, execução de bash, mensagem e entry de extensão, e os resumos de compaction/branch. `PI_TUI_BLOCK_GAP` aceita 0..4 e vale 2 por padrão — upstream usava 1 linha; valor acima do teto é limitado a 4, e valor vazio, negativo ou não numérico volta ao default. Zero cola os blocos, como no Pi antes do overlay. Espaçamentos internos de cards, editor, footer e seletores continuam sendo os do upstream.

#### Respiro R3 e `código` inline por tipo

A casa adotou o respiro **R3 "bem arejado"** (prévia em `arca-pi/docs/tui-catalog`), e os defaults do frame são os dele. Todos continuam sendo envs, lidos a cada render, no host clássico:

| env | faixa | default | o que mexe |
|---|---|---|---|
| `PI_TUI_MARGIN_X` | 0..8 | **2** | margem lateral |
| `PI_TUI_BLOCK_GAP` | 0..4 | 2 | linhas entre blocos do transcript |
| `PI_TUI_AGENT_TAIL` | 0..4 | 2 | linhas antes do próximo pedido do usuário — o respiro FINAL do turno, separado do gap comum |
| `PI_TUI_PROSE_GAP` | 0..4 | = `PI_TUI_BLOCK_GAP` | linhas antes da FALA do agente (pensamento e cards seguem o gap comum) |
| `PI_TUI_AGENT_INDENT` | 0..4 | 2 | recuo pendente da fala: a primeira linha leva o bullet que a extensão escreve, as seguintes alinham sob ele (`HangingIndent`) |
| `PI_TUI_THINK_INDENT` | 0..4 | 2 | recuo do CORPO do pensamento, sem a barra de citação (o cabeçalho fica na margem) |

O bullet `⏺` e o cabeçalho `✻ Thinking…` continuam sendo texto da extensão `garime-tui`: o frame só cuida de layout, então `GARIME_CLAUDE_STYLE=0` continua devolvendo a tela antiga, e um pi sem a extensão não ganha marcador nenhum.

`MarkdownTheme` ganhou quatro funções opcionais — `codeCommand`, `codeSymbol`, `codePath`, `codeUrl` — e o tema, quatro tokens opcionais de mesmo nome (`mdCodeCommand`, `mdCodeSymbol`, `mdCodePath`, `mdCodeUrl`). O renderer classifica o conteúdo entre crases (URL, comando, caminho, símbolo) com a mesma regra dos cards da extensão. **Tema que não declara os tokens cai em `mdCode`**, então todo tema existente continua válido e idêntico.

### Retomar uma sessão — `/resume` e `--session`

São os comandos oficiais do Pi 1.5.0, com sessões JSONL oficiais. Não há dispatcher durável, `PI_DURABLE_HOST`, `durableSessions` nem resolução customizada de sessões SQLite.

### Taxa de quadros — `PI_TUI_HZ`

O render não vindo de tecla (streaming, timers, spinner) era limitado a 16 ms fixos. Agora `PI_TUI_HZ` escolhe a taxa: aceita **30..240**, default **60** (16 ms); vazio, não numérico ou fora da faixa volta ao default. Teclado continua **imediato** (`requestImmediateRender`), então subir o Hz não muda latência de digitação.

Acima de 60 Hz vale um **teto adaptativo**: o intervalo volta a 16 ms quando o quadro medido passa de ~4 ms (mensagem enorme em streaming) ou quando a sessão é tmux (`$TMUX`) ou SSH (`$SSH_CONNECTION`/`$SSH_TTY`), onde cada byte é caro.

O cache de Markdown e o reuso dos blocos pertencem ao Pi 1.5.0 upstream. O overlay não mantém cache próprio nem seus testes. Thinking oculto e espaçamento lazy do upstream são preservados, combinados com os gaps e recuos do frame. As medições históricas do cache próprio não caracterizam esta implementação.

O agrupamento de deltas usa `modes/interactive/streaming-batch.ts`: vários deltas no mesmo quadro viram um `updateContent` com o último estado. A janela é o intervalo **efetivo** da TUI (`frameIntervalMs()`, já com o teto adaptativo). O gatilho é `message_update`, com flush garantido em `message_end`, início de tool e `agent_end`; o `requestRender()` sai do flush, não de cada delta.

### Conta por sessão — `PI_ACCOUNT_<PROVIDER>`

`PI_ACCOUNT_ANTHROPIC=<nome>` / `PI_ACCOUNT_OPENAI_CODEX=<nome>` (id do provider em maiúsculas, não alfanumérico vira `_`) fazem **este processo** ler a credencial daquele provider da conta `<nome>` do bucket `accounts.json` (o mesmo de `/accounts`, ao lado do `auth.json`) em vez do `auth.json`. Os filhos herdam pelo ambiente — inclusive subagentes, porque a seleção está no core e não numa extensão (`--no-extensions` não a desliga). Providers sem variável seguem no `auth.json`.

- **Estrito:** conta inexistente, sem refresh token ou refresh recusado é erro que cita a conta e a variável. Nunca cai para o `auth.json`. `/logout` desse provider é recusado (a conta é gerida por `/accounts`).
- **Refresh:** sob a trava `proper-lockfile` do `accounts.json` (diretório `accounts.json.lock`, stale 30 s, o mesmo protocolo do `auth.json`), relê e regrava **só** a entrada selecionada. Sessões concorrentes na mesma conta fazem um único refresh — o token rotacionado nunca é reusado.
- **Conta que também é a ativa global:** o refresh roda dentro da trava do `auth.json` também (ordem fixa `accounts.json` → `auth.json`); se a sessão global já rotacionou o token, ele é adotado em vez de refrescar de novo, e o slot recebe o token novo. Slot de outra identidade (`accountId` diferente) nunca é tocado.
- **Descoberta:** `pi --arca-capabilities` imprime `{"accountEnv":1}` e sai. Um pi sem o patch sai com `Unknown option` — o app só oferece conta por projeto quando o marcador existe.
- **Diário de rotação:** toda rotação é gravada primeiro em `accounts.rotations/<ts>-<pid>.json`, depois no `accounts.json`, depois no `auth.json`, e o diário é apagado por último. Um kill (fechar a aba) ou trava comprometida no meio deixa o diário; a próxima operação travada de qualquer processo o reaplica em toda cópia que ainda tenha o refresh token consumido (entradas do bucket e slot do `auth.json`). Token renovado nunca é perdido. A sessão global (sem env) também passa por esse caminho quando renova um token que existe no bucket.
- **Lockstep com `/accounts`:** a extensão que registra `/accounts` precisa declarar o protocolo novo (`globalThis[Symbol.for("arca.accounts.lockProtocol")] = 2`, ARCA/arca ≥ `3baf05e` + declaração). Se um `/accounts` sem a declaração estiver carregado, `PI_ACCOUNT_*` é recusado com erro que cita o arquivo da extensão. Sem nenhuma extensão `/accounts` (subagente com `--no-extensions`) a env vale.
- **Escritores do `accounts.json`** (extensão `/accounts`, ARCA Desktop) precisam usar o mesmo protocolo e reler+mesclar dentro da trava; regravar uma cópia antiga apagaria um token que o pi acabou de rotacionar.

## Skills padrão

`skills/` deste repositório são as skills que todo Agent leva (contrato em `prometheus/docs/reference/skills-distribution.md`). Elas viajam no bundle; a cada ativação no store padrão o updater copia para `<store>/skills` e acrescenta esse caminho a `skills[]` de `~/.pi/agent/settings.json` (ou `$PI_CODING_AGENT_DIR`). É a única entrada que o Agent escreve. Como o Pi carrega os caminhos do settings antes de `~/.pi/agent/skills` e `~/.agents/skills` e fica com o primeiro nome, uma skill padrão com o mesmo nome de uma do usuário não é copiada (aviso no update). A skill `megamind` mora aqui (vale para ARCA e Omni, como a extensão). As demais skills de empresa (`arca-ops`, `omni-ops`) não moram aqui: o Prometheus as coloca depois da conexão com o Megamind.

As skills padrão são `goal`, `grill`, `megamind`, `peers`, `prometheus`, `repitch`, `review`, `skills` e `ui-ux`. Não duplicam nomes de `agent/skills/**`: `debug` fica apenas em `agent/skills/dev/debug`, sob demanda (assim como `tdd`), não automática.

O sync substitui integralmente a cópia gerenciada em `<store>/skills` pelo conteúdo do bundle: diretórios que saíram do repo desaparecem na próxima ativação. Com o Agent ativo (`--agent-enable`), atualiza essa cópia somente se ela já existir, sem alterar settings (`register: false`). Não apaga skills em `~/.pi/agent/skills`, `~/.agents/skills` ou `~/.claude/skills`.

## Extensão Megamind

`extensions/megamind/` é a extensão Megamind que todo Agent leva (antes vivia em `~/ARCA/arca/extensions/arca-megamind`; identificadores internos, blocos `[arca-megamind …]` e variáveis como `ARCA_MEGAMIND_CONFIG` seguem iguais). Ela viaja no bundle; a cada ativação no store padrão o updater copia para `<store>/extensions/megamind` (cópia atômica) e garante esse caminho em `extensions[]` de `~/.pi/agent/settings.json` (ou `$PI_CODING_AGENT_DIR`), removendo entradas que carregariam um segundo Megamind (`…/arca-megamind` ou `extensions/megamind` de outro store). As demais entradas de `extensions[]` não são tocadas. Para desligar, ponha `"-megamind"` em `extensions[]`: o updater então não copia nem registra nada.

Sem `ARCA_MEGAMIND_CONFIG`, o perfil da sessão é o enrollment que a máquina tem: ARCA (`~/.config/arca-projects/config.json`) na frente, Omni (`~/.config/omni-megamind/config.json`, movida por `OMNI_MEGAMIND_CONFIG`) quando só ela existe, e a ARCA como padrão inerte quando não há nenhum — numa máquina só Omni a sessão de terminal falava com a ARCA. `ARCA_MEGAMIND_CONFIG=none` e caminho explícito seguem iguais. Testes: `node scripts/test-extensions.mjs`, `node scripts/test-megamind-profile.mjs`.

O Pi resolve `@earendil-works/*` e `typebox` das extensões por alias do próprio loader, não por `node_modules` ao lado do arquivo — a extensão roda igual a partir do store.

`megamind_who` lista pessoas e sessões; metadados de org e maintainers, quando fornecidos, são informativos. Todos os sócios têm o mesmo acesso. Não há bloqueio de ferramentas por pedidos recebidos, nem estado de permissões herdado pelos subagentes.

`megamind_ask {to, title, body}` cria um pedido: para pessoas (`@handle` ou `actor:pb:<id>`), chama `request_create` com o endereço original, resolvido pelo servidor e exibido em **For you** no app. Pedidos a sessões mantêm o caminho existente. Não há parâmetro `action`. Eventos legados `decision` são ignorados sem erro. Verificação: `node scripts/test-megamind-requests.mjs`.

## Packaging boundary — `releaseOverlays`

O updater publica diretamente apenas `packages/coding-agent` com `npm pack --workspace packages/coding-agent`. Como a instalação resolveria `@earendil-works/pi-ai` do npm público, o código do Pi Black em `packages/ai` não chegaria ao runtime somente porque build e testes passaram.

`manifest.json:releaseOverlays` fecha essa lacuna: o updater empacota o workspace extra da fonte patched, substitui todas as cópias instaladas e exige `requiredMarker` em `markerFile`. Ausência do pacote ou marker aborta antes da ativação. O marker também é conferido dentro do bundle efetivamente carregado pelo CLI. Não instale simultaneamente a extensão upstream do Pi Black, pois isso transformaria cada request duas vezes.

Desde o respiro R3 há **dois** release overlays: `packages/ai` (Pi Black) e `packages/tui` (o `código` inline colorido por tipo vive no renderer de markdown do pi-tui). O CLI carrega o bundle, que já traz o patch; o overlay de `packages/tui` existe para que a cópia instalada do pacote — usada pelo caminho não-bundled e por quem importa o pi-tui da release (prévias, ferramentas) — não fique uma versão atrás do que o bundle desenha.

## Model data snapshot

`npm -w packages/ai run hydrate-model-data` busca o catálogo ao vivo (models.dev, openrouter, nvidia, vercel). Como esse catálogo muda sob uma tag congelada — provedores renomeados, ids de modelo trocados —, uma release que construía ontem passa a falhar hoje na hidratação ou nos testes upstream fixados naquela tag. O install deixa de ser reproduzível justamente quando um parceiro tenta instalar de uma máquina limpa.

`overlay/model-data/<officialVersion>/` versiona um dataset já hidratado e aprovado no gate completo (42 JSON de provedores + `.manifest.json` no Pi 1.5.0). `manifest.json:modelData` declara `officialVersion`, `path` e o `manifestSha256` do `.manifest.json` — que por sua vez fixa o sha256 de cada arquivo de provedor, então um único checksum no manifesto trava todos os bytes do snapshot.

Depois de `npm ci --ignore-scripts`, quando existe entrada para a versão oficial resolvida e `--hydrate` não foi passado, o updater verifica os checksums, copia o snapshot para `packages/ai/src/providers/data/` e roda `npm -w packages/ai run check:model-data` (validação upstream: schemaVersion 6 no Pi 1.5.0 (manifest v2), structureHash contra `src/models.generated.ts` e sha256 por arquivo). O build usa então `npm run build:offline`, porque o `build` padrão regenera o catálogo pela rede e sobrescreveria tanto o snapshot quanto os shards de provedor fixados pela tag. Sem entrada correspondente, ou com `--hydrate`, o caminho continua sendo hidratação ao vivo + `npm run build`.

Para renovar o snapshot, use `--vendor-model-data` (só válido com `--check --hydrate`): depois de o gate passar, o updater copia o dataset recém-hidratado — os mesmos arquivos, inclusive o dotfile `.manifest.json` — para `overlay/model-data/<version>/` e cria ou substitui a entrada em `modelData` com o `manifestSha256` correto.

```sh
node scripts/agent-update.mjs --check --hydrate --ref v1.5.0 --vendor-model-data
node scripts/agent-update.mjs --check --ref v1.5.0   # agora offline, contra o snapshot
```

Como o passo grava `overlay/manifest.json`, o fingerprint impresso naquele check é o de antes da gravação; o check offline seguinte é quem valida o snapshot já declarado. O caminho manual equivalente (copiar `…/releases/<releaseId>/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/` e recalcular o sha à mão) continua possível, mas não é mais necessário.

Identidade: `overlayFingerprint` cobre os bytes do manifesto e dos patches; o snapshot entra nessa identidade pelo `manifestSha256` declarado no manifesto, não por um segundo hash de árvore. Editar qualquer json do snapshot sem atualizar o manifesto não muda o fingerprint, mas aborta o update na verificação de checksums. O snapshot também viaja no bundle instalado, para que um `agent overlay-update` a partir do store não dependa do catálogo remoto.

## Garantias e gates

- O manifesto fixa o SHA-256 de cada patch e mantém `forbiddenOverlayMarkers` contra resíduos do Prime Agent.
- O updater resolve a versão oficial para a tag `v<version>`, verifica identidade, entrypoint e layout do pacote e aplica cada patch com `git apply --3way`.
- Cada entrada em `patches` precisa declarar testes existentes; o updater roda a união das suítes dos patches selecionados sob vitest antes do pack.
- Pi Black executa `anthropic-claude-code.test.ts` e `anthropic-auth-token.test.ts`.
- Garime frame executa `garime-frame.test.ts` e `interactive-tui.test.ts`.
- Conta por sessão executa `account-selection.test.ts` e `auth-storage.test.ts`.
- Transcript feedback e stream markdown executam as suítes clássicas declaradas no manifesto; nenhum teste durável é selecionado. `PI_TUI_FEEDBACK_MAX_NOTICES` limita tentativas de aviso por execução (default 3, faixa 0..10; 0 desliga só avisos). `PI_TUI_FEEDBACK_TOOL_RESULTS` (default 3) exige resultados novos desde a última observação e `PI_TUI_FEEDBACK_MIN_MS` (default 45000) o intervalo desde ela e desde o início. Sem avisos concorrentes; summary diferente substitui o visível, summary visto continua deduplicado, e 1/2/0 avalia só o visível. Recap inalterado.
- A ativação ocorre somente após dependency install, model data (snapshot verificado ou hidratação), repository checks, build, focused tests, package inspection, installation e CLI smoke.
- Conflito, checksum incorreto, gate falho ou pacote inválido deixa a instalação ativa intacta.
- Releases são diretórios imutáveis; a ativação troca `current` atomicamente e preserva `previous` para rollback.

### Fingerprint e identidade da árvore

`releaseId` é `<version>-<officialCommit>-<overlayFingerprint>-<treeDigest>`. `overlayFingerprint` cobre os bytes do manifesto e dos patches selecionados, portanto edição, remoção ou reordenação coberta por essa identidade gera fingerprint novo. `treeDigest` cobre a árvore instalada resultante do build, evitando sobrescrever uma release viva quando hidratação ou build produzem bytes diferentes.

O algoritmo 3 ignora `.DS_Store` e normaliza apenas `generatedAt` em `dist/providers/data/.manifest.json`; todo o resto é hashed. Releases antigas são verificadas com o algoritmo que registraram quando ele ainda é suportado. Uma cópia existente só é reutilizada quando metadata, fingerprint, checksums, digest, markers e `bin/pi --version` conferem. Uma cópia divergente permanece no lugar para inspeção, e o build novo recebe um diretório irmão `+2`, `+3`, etc.

Cada release grava a metadata em `agent-release.json`; `active.json` é derivado desse arquivo para não divergir. `active.json` também registra `updaterGeneration: 4`. Este updater opera somente no store `~/.local/share/agent` (ou no indicado por `--store`) e não tem como alvo stores de gerações anteriores.

### Falha durante a ativação

A ativação tem três trechos, e cada um relata o que de fato aconteceu:

1. **Antes de qualquer mutação** a metadata da release (`officialVersion`, `overlayFingerprint`, `treeDigest`) e o tipo de `active.json` são validados. Falha aqui não move ponteiro nenhum: `active pi was not changed` é verdade.
2. **Ponteiros e wrapper** (`previous`, `current`, wrapper do store, launcher): se falharem, `current`/`previous` voltam ao valor anterior e `active.json` não é tocado. O wrapper, o launcher de `~/.local/bin` e o bundle instalado **não** voltam — eles podem já referenciar o bundle novo, e a mensagem de erro diz isso.
3. **Sync de recursos** (skills, Megamind, setup do Agent) e gravação de `active.json`: se o sync falhar, o runtime **já está ativo**. Não existe transação de settings/temas/pasta de papéis, então `active.json` é gravado apontando para a release nova com `partialActivation: true` e `partialActivationReason`, e o erro diz **partial activation**, nunca "unchanged". `current` e a metadata registrada nunca divergem em silêncio. Se a própria gravação de `active.json` falhar, os ponteiros voltam para manter ponteiro e metadata de acordo (recursos já sincronizados permanecem).

`active.json` é gravado em temporário e renomeado, então um leitor vê o registro antigo ou o novo, nunca metade. Limites que permanecem: **crash abrupto** (queda de energia, `SIGKILL`) entre a troca de `current` e a gravação de `active.json` ainda deixa os dois divergentes — nada é reconstruído no próximo arranque; rode o updater de novo ou `agent overlay-rollback`. E **recursos parcialmente sincronizados** (um tema copiado, uma entrada de `extensions[]` ainda não escrita) não são revertidos em nenhum caso; a correção é repetir a ativação depois de resolver a causa.

O staging dentro do store (`releases/.staging-<pid>`) é removido quando a tentativa falha — somente o caminho que aquele processo criou, sob o lock do store, nunca varrendo `.staging-*` por prefixo (o staging vivo de outro updater fica onde está). Já o `stageRoot` em `$TMPDIR` continua preservado para diagnóstico.

### Preparar, testar e promover sem rebuild

```sh
node scripts/agent-update.mjs --prepare --store /caminho/store-isolado
# Use o ID e o caminho FINAL impressos pelo preparo:
/caminho/store-isolado/releases/<releaseId>/bin/pi --version
node scripts/agent-update.mjs --promote <releaseId> --store /caminho/store-isolado
```

No Windows, o binário de smoke é `releases\<releaseId>\pi.cmd`. Execute o smoke com configurações e credenciais de teste, sem escrever na árvore preparada.

`--prepare` executa o pipeline completo de update: clone, patches selecionados, model data, check, build, testes dos patches, pack, install, `applyReleaseOverlays`, digest, markers e smoke. A release recebe seu caminho final antes da verificação e não é movida depois. Um novo preparo usa um diretório novo (sufixo `+2`, etc. se necessário), sem reutilizar metadata de um build anterior; nomes reservados por recibos antigos também são pulados. Não altera `current`, `previous`, `active.json`, `layers.json`, wrapper ou launcher; não coleta órfãos. `--ref`, `--hydrate`, `--with` e `--without` continuam disponíveis no preparo.

O recibo separado `prepared/<releaseId>.json` tem schema 1, geração 4, store canônico, plataforma, arquitetura, versão **exata** do Node, instante do preparo, `currentAtPrepare`, proveniência do build (repositório/ref solicitado/layout/entrypoint), metadata completa, seleção opcional, hash do manifesto e da metadata e hash adicional dos bytes/modos da árvore. Este último não normaliza `generatedAt`, mas mantém a exceção de `.DS_Store` já adotada pelo store, para que abrir a pasta no Finder não invalide o payload; `agent-release.json` é coberto pelo hash separado. A validade exige esses mesmos dados/ambiente, sem expiração por tempo. Mudança de manifesto, Node ou árvore exige novo preparo. Recibo é registro local de integridade, **não assinatura criptográfica contra o dono que pode editar todos os arquivos**. Imutabilidade é contrato do updater, não proteção por permissões do sistema operacional.

`--promote` aceita somente um ID no mesmo store, nunca caminho ou separadores. Recibos/releases redirecionados por symlink/junction e links internos que escapem da release são recusados. Valida novamente metadata integral, proveniência, seleção, patches/fingerprint, hashes, markers e identidade/entrypoint instalado antes do smoke. Não executa git/npm, clone, hidratação, build, pack ou install. Ativa a mesma pasta, preserva `previous`/rollback e só depois sincroniza `layers.json` pela seleção do recibo, ignorando a seleção atual do store.

Preparo e promoção usam o lock existente. O CAS da promoção compara `current` com o capturado **no preparo**. Uma promoção repetida normalmente falha nesse CAS; não é um no-op implícito. Após falha de validação/lock, corrigir a causa permite repetir com o mesmo recibo. `--force` permite ignorar somente o CAS (e a regra existente de downgrade de geração), nunca recibo inválido/corrupção. Repetir com `--force` na mesma release não troca `previous`, mas regrava os registros de ativação. Não há nova transação geral para falhas de I/O durante a ativação.

`--prepare`, `--promote`, `--check` e `--rollback` são mutuamente exclusivos. Promoção recusa `--ref`, `--with`, `--without`, `--hydrate`, `--vendor-model-data` e `--simulate-conflict`. Preparo recusa `--adopt-launcher`, `--no-prune` e `--force`. As opções antes aceitas por check/rollback continuam aceitas, inclusive as que esses modos ignoravam (por exemplo `--check --no-prune`). Promoção não coleta releases ou bundles (mesmo sem `--no-prune`). Update sem flags e check/rollback mantêm seu pipeline anterior.

A coleta da geração 4 preserva qualquer release que tenha recibo em `prepared/`, inclusive depois da promoção, para não apagar um runtime ainda em teste. A limpeza desses recibos/releases é manual, somente após encerrar os testes e sessões. Updaters antigos não conhecem essa retenção: **não os use em stores com preparos pendentes**. O bump para geração 4 protege contra updaters antigos após a primeira ativação (salvo downgrade explícito com `--force`); o preparo não pode atualizar `active.json` para antecipar essa proteção. Prefira store isolado nesse intervalo. O bundle instalado leva o updater completo e seus imports, incluindo suporte a promoção sem checkout.

Teste rápido isolado: `node scripts/test-prepare-promote.mjs` (fixtures, stubs git/npm, sem build real). Está no gate `.pi/checks.json` junto com layers e store-lock.

### Rollback e retenção

`agent overlay-rollback` verifica o target de `previous` pelo mesmo contrato: patches, markers, digest e execução do binário. `--force` permite um target degradado e registra `degraded`, `degradedReasons` e o algoritmo no `active.json`.

Depois da ativação, somente releases não referenciadas são coletadas; `current`, `previous`, releases com recibo de preparo e a órfã mais recente permanecem. Bundles superseded também são removidos para impedir que lifecycle antigo reassuma o store. `--no-prune` desativa essa coleta.

### Estado e limpeza do store — `overlay-status`, `overlay-gc`

`agent overlay-status` (ou `node scripts/agent-update.mjs --status`) é somente leitura: Pi instalado, `current`/`previous`, Agent ligado/desligado com o artefato, o checkout de origem e quantos commits ele está à frente da instalação (git local), e o tamanho do store. A ativação grava `sourceRepo`/`sourceCommit` em `active.json` quando o updater roda de um checkout git; instalação anterior a isso aparece como `source unknown`.

`agent overlay-gc [--dry-run] [--keep N]` libera espaço; `--keep` padrão 1 (um item sem uso de cada tipo). `--dry-run` lista caminho, tamanho e total, sem lock e sem apagar. Apaga releases órfãs, artefatos do Agent sem uso, recibos `prepared` sem release, backups além dos 5 mais recentes e `runtime/build-cache`. Nunca apaga `current`, `previous`, o artefato do Agent ativo e o de rollback, nem releases preparadas ainda promovíveis. `candidates/` e `runtime/resource-snapshots/` só são reportados.

Aviso de defasagem: ao abrir o Agent interativo ligado, se o checkout de origem estiver N commits à frente da instalação, sai uma linha em stderr com o comando do updater do checkout (`agent overlay-update` roda o updater do bundle, que não traz commits novos). Só git local, cache de 1h em `stale-notice.json`, limite de 300 ms, nunca bloqueia; não aparece em `-p`/`--mode` nem fora de TTY. Desligue com `AGENT_STALE_NOTICE=0`.

Camada removida: `context-windows` saiu em 2026-10. `--with context-windows` falha; registrada em `layers.json`, o updater avisa e ignora.

## Store hermético e launcher

O store padrão é `~/.local/share/agent`:

- `releases/<releaseId>/` — instalação npm imutável;
- `overlay-bundles/<fingerprints>/` — updater, wrappers (`.sh` e `.cmd`), manifesto, documentação e patches autocontidos; o id do bundle deriva de **todos** os patches do manifesto, porque o bundle carrega todos (instalar base ou base+camada usa o mesmo bundle);
- `current` e `previous` — symlinks de ativação e rollback (junctions no Windows);
- `bin/pi-wrapper` (POSIX) ou `bin/pi-wrapper.cmd` (Windows) — launcher estável;
- `runtime/` — configuração (`config.json`) e artefatos (`releases/<id>/agent`) do Agent ligado por `--agent-enable`;
- `backups/<timestamp>/<launcher>` — launcher anterior, acompanhado de `restore.txt` com o comando exato de restauração.

`~/.local/bin/agent` só é adotado pelo store padrão. Antes de substituí-lo, o updater move o launcher existente, preservando inclusive seu tipo, para o backup datado e escreve `restore.txt`. `--store <path>` mantém o launcher real intocado; `--adopt-launcher` habilita explicitamente sua adoção. `AGENT_STORE` seleciona o store e `AGENT_REPO` seleciona o bundle usado pelo wrapper.

Autoridade do overlay: `github.com/GabrielMendonca1/agent`. O bundle instalado é autocontido, de modo que updates futuros não dependem do checkout de autoria.

## Windows nativo

Os sócios rodam Windows com PowerShell, sem WSL, e o updater é nativo lá: nenhum shim de `npm.exe` é necessário — se alguma instalação antiga criou um, ele pode sair do PATH.

- **npm por shell.** `npm` e `npx` são scripts `.cmd`; desde a correção de CVE-2024-27980 o Node recusa spawná-los sem shell. O updater monta a linha de comando com quoting explícito (um caminho com espaço, como `C:\Users\João Silva\...`, vai inteiro num argumento só). Argumento com `%` ou quebra de linha é recusado com erro em vez de virar outra coisa dentro do `cmd.exe`.
- **Binário instalado.** `npm install --global --prefix X` grava `X\pi.cmd` no Windows (sem `bin\`). O smoke pós-instalação, `verifyRelease` e o launcher procuram `pi.cmd`, `pi.ps1`, `pi` e, por último, `bin/pi`.
- **`current`/`previous` são junctions.** Symlink de diretório no Windows exige administrador ou Developer Mode; junction não exige nada. Como `rename` no Windows não substitui um destino existente, o ponteiro antigo é removido (`rmdir` da junction, nunca do alvo) logo antes da troca.
- **Fim de linha.** O clone oficial é configurado com `core.autocrlf=false`/`core.eol=lf` antes do checkout: com o padrão do Git for Windows a árvore viria em CRLF, os patches não aplicariam e o `treeDigest` seria outro em cada plataforma. `scripts/port.mjs` faz o mesmo no clone em cache.
- **Launcher.** `~/.local/bin/agent.cmd` e `~/.local/bin/agent.ps1` encaminham para `<store>/bin/pi-wrapper.cmd`, que tem a mesma semântica do `agent-wrapper.sh`: `overlay-update`/`overlay-rollback` vão para o updater do bundle, `update` decide entre updater, delegação ao Pi ou os dois (`--all`), e qualquer outra coisa executa o CLI da release `current`. Um `agent.cmd`/`agent.ps1` que já existia é movido para `backups/<timestamp>/` com `restore.txt` (`move /y ...`). Se `~/.local/bin` não estiver no PATH, o updater imprime o `setx` correspondente.

```powershell
node scripts\agent-update.mjs --check
node scripts\agent-update.mjs
agent overlay-update --with <camada>
agent overlay-rollback
```

## Comandos

No checkout:

```sh
# Validar uma release sem instalar ou promover
node scripts/agent-update.mjs --check
node scripts/agent-update.mjs --check --ref v0.85.1

# Ignorar o snapshot versionado e hidratar o catálogo ao vivo
node scripts/agent-update.mjs --check --ref v0.85.1 --hydrate

# Hidratar e vendorar o snapshot novo no checkout
node scripts/agent-update.mjs --check --hydrate --ref v1.5.0 --vendor-model-data

# Camadas opcionais
node scripts/agent-update.mjs --check --ref v1.5.0 --with <camada>

# Construir, instalar e ativar
node scripts/agent-update.mjs
node scripts/agent-update.mjs --no-prune

# Testes rápidos dos scripts (segundos, sem construir release)
node scripts/test-layers.mjs
node scripts/test-store-lock.mjs
```

Portar os patches para uma release nova:

```sh
node scripts/port.mjs start --ref v1.4.0 [--with <camada>] [--src <clone>] [--worktree <dir>]
node scripts/port.mjs status
node scripts/port.mjs continue
node scripts/port.mjs export
```

Depois da instalação:

```sh
agent update
agent update self
agent overlay-update
agent overlay-update --ref v0.85.1
agent overlay-update --with <camada>
agent overlay-update --without <camada>
agent overlay-rollback
agent overlay-rollback --force
```

`agent update --all` ativa primeiro o overlay verificado e depois delega o update de extensões ao Pi. Updates apenas de packages/modelos continuam upstream (`agent update --extensions`, `agent update --models`).

Sem `--ref`, o updater instala `manifest.overlayRef`: a release oficial que a casa portou e testou (o `port.mjs export` atualiza esse campo). Nesse caminho o commit da tag precisa ser exatamente `manifest.overlayBase`; uma tag movida no upstream aborta o update com a diferença impressa, em vez de instalar código que ninguém portou. `--ref <tag>` explícito constrói a tag como ela está hoje. `--ref latest` pega a última do npm, que pode ainda não aceitar os patches; teste-a com `--check` antes.

`--check` constrói em um diretório temporário, não toma lock, não promove release e não instala no store. `--store <path>` altera o store de instalações reais; `--no-prune` conserva releases e bundles existentes.

Para abandonar o overlay por completo, execute o comando em `restore.txt` do backup desejado sob `~/.local/share/agent/backups/`. Backups de symlinks permanecem symlinks.

## Portar para uma release nova

`scripts/port.mjs` faz o trabalho que antes era manual e, por isso, irregular: clone, worktree, aplicação patch a patch, resolução, e a regravação dos `overlay/*.patch` com sha256 e `overlayBase` novos.

- `port.mjs start --ref vX.Y.Z [--with <camada>] [--src <clone>] [--worktree <dir>]` garante um clone oficial em cache (`~/.cache/arca-pi/pi`, `ARCA_PI_CACHE` muda a raiz) com as tags atualizadas, cria o worktree `~/.cache/arca-pi/port-<versão>` na tag (`--worktree <dir>` escolhe outro caminho sem destruir uma série anterior) e aplica os patches selecionados em ordem com `git apply --3way`, **um commit por patch** (mensagem = nome do patch). O clone é completo de propósito: num clone parcial faltam os blobs de pré-imagem citados pelas linhas `index` do patch, e o 3-way degrada para aplicação direta.
- No conflito, para e lista os arquivos em conflito com o que fazer (resolver, `git add`, `port.mjs continue`).
- `port.mjs continue` retoma: commita a resolução como o patch pendente e segue a série.
- `port.mjs export` regrava cada patch da série a partir do diff do seu commit contra o pai e atualiza `sha256` e `overlayBase` no manifesto. O diff é isolado da configuração de quem exporta (`-c diff.noprefix=false -c diff.mnemonicPrefix=false -c color.ui=never diff --no-ext-diff --no-color --no-renames --full-index`) e é gravado como bytes crus, sem decodificar: um `~/.gitconfig` diferente não pode mudar os bytes do patch nem, com eles, o sha256 do manifesto. Patch fora da série fica intocado, então portar só uma camada não mexe nas outras.
- `port.mjs status` mostra a série, o que já virou commit e o que está em conflito.

O estado do port mora no git dir do worktree (`arca-pi-port.json`), fora da árvore de trabalho — nunca entra num commit nem aparece no diff exportado. `port.mjs` não toca no store.

### Fluxo recomendado de update

1. Rodar os `scripts/test-*.mjs` e `node scripts/agent-update.mjs --check --ref latest` contra a **última** release oficial, só com as camadas base.
11. `node scripts/port.mjs start --ref vX.Y.Z` — os patches que aplicam limpo já viram commit.
3. Resolver o que conflitar e `node scripts/port.mjs continue`.
12. `node scripts/port.mjs export`.
13. `node scripts/agent-update.mjs --check --hydrate --ref vX.Y.Z --vendor-model-data`, e depois o `--check` offline contra o snapshot recém-vendorado.
6. Com o manifesto e snapshot fixados, execute `node scripts/agent-update.mjs --prepare` no store de destino. Teste o binário final impresso, inclusive o E2E externo desejado, sem editar a árvore da release.
7. Registre commit/tag e publique conforme a aprovação humana. Depois use `node scripts/agent-update.mjs --promote <ID>` **no mesmo store/ambiente**, promovendo exatamente o pacote testado. Não rode o update legado depois do preparo: ele reconstruiria o pacote e pode invalidar o CAS.

O fluxo legado sem flags permanece disponível por compatibilidade. O novo fluxo é explícito: não alteramos automaticamente automações dos sócios nem afirmamos que um E2E externo foi executado pelo preparo.

### Whitespace dos patches

`.gitattributes` limpa `whitespace` e `text` somente para `overlay/*.patch`: um patch é um diff cujas linhas de payload têm prefixos próprios, e normalizar EOL mudaria bytes presos por SHA-256. `git diff --check` continua válido para scripts, manifesto e este README.

### Codemode PTC patches

- `codemode-typed-results`: scripts always receive structured text-file `read` records (`path`, `text`, `offset`, `limit?`, `totalLines`, `truncated`), `grep` match records and `find` paths. Direct display text and image results do not change. Existing scripts that expect strings must use the new fields.
- `tool-load-append`: adding tools to a session with messages keeps the system prompt byte-identical; the new tools' snippets and guidelines are appended through the system-update path. Removal, mode/model changes and fresh sessions rebuild as before; resume/reload does not duplicate them.
- `codemode-background`: `@options` accepts `background` and `wait_ms` (default 300000). Detached scripts keep their worker, expose partial output and emit `codemode:job` completion events. `codemode:job:cancel` stops a job; session shutdown cancels outstanding runs.
- Agent's auto-discovered `brain-live/jobs` extension provides `jobs` actions `start`, `status`, `wait`, `output`, `cancel`, logs bash output under `<sessionDir>/jobs/`, and delivers one completion follow-up when the originating session is idle. `timeout_s` defaults to 300 and can also shorten the initial start wait. Jobs are process-local, not restartable; logs survive process exit. Background codemode jobs still share the default two-worker limit.
