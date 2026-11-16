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
- Uma desativação explícita é preservada nas atualizações por artefato. O runtime registra extensões core, Megamind e skills padrão pelo mesmo recibo/CAS em `runtime/resources-backup`. Cópias pessoais são preservadas, colisões recebem exclusões reversíveis; `-megamind`/`-nome` e `-agent-setup` são respeitados. Temas pessoais e settings de modelo/thinking não são substituídos. O caminho novo não roda os syncs legados sem recibo. A instalação por artefato não reserva tecla: Shift+Tab e Ctrl+T seguem nativos do Pi. No `settings.json` do perfil entra `warnings.anthropicExtraUsage: false` só quando a chave falta, pelo mesmo recibo; valor seu nunca é sobrescrito, e o rollback só remove o `false` que ainda estiver lá.

## Contrato do runtime novo e rollback histórico

Novos artefatos internos têm manifesto **v3**, config **v2** e preload `agent/juice/runtime.mjs`. O nome do arquivo foi mantido por compatibilidade; não implica contabilidade. O launcher exporta `AGENT_RUNTIME_ENABLED=1` e `AGENT_PI_ROOT` físico/absoluto. Filhos usam `AGENT_CHILD=1`. A tool `subagent` fica sempre ligada na sessão principal; ver "Subagentes: sempre ligados, isolamento e auditoria". Preferências pertencem ao perfil `PI_CODING_AGENT_DIR`, não a Juice.

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

- As skills de integração `peers`, `megamind`, `prometheus`, `tasks` e as de `agent/skills/system/` são automáticas. `design/` e `plan/` ficam sob demanda e geram uma linha curta por categoria no system prompt. A curadoria usa o formatter compartilhado entre os hosts.
- `/skill` ou `/skill:` abre o catálogo agrupado por categoria, nos dois modos.
- `/models` separa slots de execução e escolhas por papel e preserva as escolhas pessoais. O picker de um papel lista primeiro os pares autorizados e depois todo modelo disponível; escolher um novo o autoriza naquele papel com o thinking da preferência atual. `Esc Esc` abre só a lista de fork. Falha de quota/503 não troca modelo silenciosamente.
- `read` é o nativo do Pi clássico: imagens, texto, offset/limit e cancelamento. O loadout controla quais papéis recebem `read`. Principal, scout e visual precisam de modelo capaz de receber imagens; anexos diretos continuam suportados.
- `scout` não edita: tem `read, grep, find, ls, bash, web_search, web_fetch`, com `bash` sob sandbox de escrita. Transcrição que exija `ffmpeg`, Whisper ou outro executável que grave arquivos deve ir para um papel com `edit`/`write` (worker). Não se promete leitura/transcrição nativa de qualquer formato binário.
- JEV e cache observam compactação confirmada no branch para resetar sua época; pedido, cancelamento, queda de tokens ou erro não contam como compactação concluída. Nenhum evento sintético por correlação FIFO é usado.

## Estado da instalação e limpeza

```sh
agent overlay-status            # o que está rodando e se o checkout está à frente
agent overlay-gc --dry-run      # o que a limpeza apagaria (nada é apagado)
agent overlay-gc                # apaga, guardando 1 item sem uso de cada tipo
```

`/agent-doctor` mostra as tools registradas e declaradas na sessão, exposição (`direct`, `codemode`, `deferred`, etc.), origem real do registry e comandos/skills observados. Usa as APIs públicas do Pi; não adiciona tool ao prompt, não chama modelo, não faz probes e não altera settings. Na TUI/RPC abre o editor nativo como visualizador: o texto devolvido é descartado, nunca salvo ou enviado; em print escreve texto em stderr e em JSON emite `{ "type": "agent_doctor", "report": "..." }` em stderr, sem alterar o protocolo oficial em stdout. Funciona mesmo sem projeto Git. Configuração não prova atividade: hooks sem tool/comando e cobranças auxiliares ficam explicitamente como não observados; uma integração registrada não prova conexão. Para instalação use `agent overlay-status`; para recursos configurados, `agent config`; para uso/cache, `/session`, `/cost` e `/cache` quando disponíveis.

O runtime novo não executa aprendizado/mineração automáticos nem chama modelos para recaps ou avisos semânticos. O recap usa apenas texto local; o chat, o mascaramento de dados e a compatibilidade de imagens históricas permanecem. Cache-keeper e prefetch continuam com seus limites próprios e sem ledger Juice. `/cache` mostra métricas da sessão; custos do provedor continuam nas métricas nativas do Pi.

Instalações por artefato atualizam com `agent update`, não com commits do checkout. `agent overlay-update` continua sendo o caminho de desenvolvimento que reconstrói a release.

## Atualizar o Pi

O Agent traz o próprio Pi dentro do store, em releases imutáveis. Um Pi global instalado por npm não afeta o Agent.

| Comando | Faz |
|---|---|
| `agent update` | Instala o último artefato do Agent. Não chama o auto-update do Pi. |
| `agent update --extensions`, `--models` ou outros argumentos | Delega ao Pi. |
| `agent update --all` | Instala o artefato e depois atualiza as extensões pelo Pi. |

Pi novo só chega com artefato novo. Quem faz o quê:

- Mantenedor: reaplica os 10 patches de `overlay/manifest.json` sobre o Pi upstream novo, passa o portão e publica o artefato.
- Consumidor: roda `agent update`.

Nenhum patch é necessário para as extensões carregarem; eles dão funcionalidade. Linhas: inserções/remoções de `git apply --stat`, testes incluídos. Fragilidade: risco de conflito num port, pelo quanto o patch mexe em arquivo central do upstream.

| Patch | Função | Linhas | Fragilidade |
|---|---|---|---|
| `pi-black` | Lane Anthropic OAuth com identidade Claude Code. | +471/−9 | Média: arquivo novo, mas edita `anthropic-messages.ts`. |
| `garime-frame` | Moldura, margens e tema da TUI. | +495/−31 | Alta: 13 arquivos, componentes e `interactive-mode.ts`. |
| `pi-account-env` | Conta por projeto via `PI_ACCOUNT_<PROVIDER>`. | +887/−9 | Média: arquivo novo, mas edita `auth-storage.ts` e `model-runtime.ts`. |
| `transcript-feedback` | Widgets e recap local após o transcript. | +2077/−17 | Alta: maior patch, 12 arquivos, `interactive-mode.ts`. |
| `stream-markdown` | Agrupa deltas por quadro e `PI_TUI_HZ`. | +288/−6 | Alta: `interactive-mode.ts` e `tui.ts`. |
| `agent-skill-curation` | Curadoria opt-in do anúncio de skills. | +119/−1 | Baixa: um arquivo de código. |
| `codemode-typed-results` | Resultados estruturados de read/grep/find em scripts. | +113/−7 | Baixa: acréscimos nas tools. |
| `codemode-background` | Codemode em segundo plano após 5 min, saída parcial e cancelamento. | +333/−149 | Alta: reescreve boa parte de `execute.ts`. |
| `tool-load-append` | Tool carregada no meio da sessão não reescreve o system prompt. | +211/−26 | Média: `agent-session.ts`. |
| `cc-hidden-tool-names` | No OAuth Anthropic, `Bash`/`Read` de tool escondida voltam em minúsculas. | +30/−3 | Baixa: poucas linhas, mas no mesmo arquivo de `pi-black`. |

## Avisos da TUI e como desligar

| Aviso | Desligar |
|---|---|
| "Anthropic subscription auth is active. Third-party harness usage draws from extra usage..." | `warnings.anthropicExtraUsage: false` no settings, ou `/settings`. Instalação por artefato já grava `false` se a chave faltar. |
| "Update Available ... Run agent update" | `PI_SKIP_VERSION_CHECK=1`, ou `PI_OFFLINE=1` / `--offline`. |
| "Package Updates Available" | Só `PI_OFFLINE=1` ou `--offline`. |
| Changelog após troca de versão do Pi | Não desliga. `collapseChangelog: true` reduz a uma linha. Só aparece em sessão nova. |
| Cabeçalho e detalhes de startup | `quietStartup: true` esconde os dois; `"header"` mantém o cabeçalho e esconde os detalhes. |
| Frases enquanto o modelo pensa ("Schlepping...") | Extensão `whimsical`: `"-whimsical"` em `extensions[]`. Ver abaixo. |

```json
{
  "warnings": { "anthropicExtraUsage": false },
  "collapseChangelog": true,
  "quietStartup": "header"
}
```

- O aviso de versão é enganoso no Agent: `agent update` só traz Pi novo quando houver artefato novo.
- `PI_OFFLINE=1` também desliga o refresh do catálogo de modelos no startup e a checagem de pacotes. Use `PI_SKIP_VERSION_CHECK=1` se quiser calar só o aviso de versão.
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
| `web_search` | Cada chamada da tool por um subagente cujo papel a declara: uma inferência Gemini (`gemini-2.5-flash` com Google Search, fallback OpenRouter). A sessão principal não carrega a extensão web. | Até 20 buscas e 40 fetches por sessão. | `AGENT_WEB_MAX_SEARCHES=0` (`AGENT_WEB_MAX_FETCHES=0` para fetch) |

Prompt cache: o launcher define `PI_CACHE_RETENTION=long` (TTL 1h) quando a variável não está definida; um valor do usuário, inclusive `none`, prevalece. Escrita de cache custa 2× a entrada com TTL 1h e 1,25× com 5 min; leitura, 0,1×. Medido na auditoria do commit 6f77207: o prefixo fixo da 1ª requisição tem 10,2 KB de system e 20,0 KB de tools (o schema de `subagent` ocupa 8,9 KB), idêntico entre requisições e processos; cada passo do modelo é uma requisição.

Cache-keeper em detalhe:

- Só a sessão principal aquece; subagentes não. Só Anthropic Messages API, com o mesmo provider/modelo do último request real.
- Janela de aquecimento: 3h de ociosidade com menos de 30 pausas registradas no projeto; depois, aprendida das pausas, até 24h. Pausas ficam em `<perfil>/cache-keeper/<hash do cwd>.json`.
- Teto por ping: `AGENT_CACHE_KEEPER_MAX_PING_USD` (padrão 0.5), calculado a preço de leitura de cache. Um ping que erra o cache paga escrita antes de parar. Não há teto por sessão: o custo total é pings × janela.
- Thinking com budget fixo B: o ping usa `max_tokens` B+1 e só sai se o pior caso couber no teto e em 25% da perda evitada; senão é pulado. Sem thinking, ou thinking adaptive, `max_tokens` 1.
- Para no primeiro ping sem acerto, em qualquer entrada sua e no fim da sessão.

`AGENT_IDLE_COMPACT_MIN_TOKENS` ajusta o mínimo da compactação ociosa (piso 100k). `AGENT_CACHE_PREFETCH_NEXT=1` liga o prefetch do próximo papel de uma chain; é desligado por padrão e custa mais do que não aquecer.

## Subagentes: sempre ligados, isolamento e auditoria

### Contrato

- A tool `subagent` está sempre ligada na sessão principal. Não há modos, atalho, comando nem variável para ligar ou desligar.
- Filhos (`AGENT_CHILD=1`) não lançam subagentes.
- O system prompt da sessão principal traz a diretriz de orquestrador: "Act as an orchestrator: delegate recon and bulk reading to scout, isolated implementation to worker, and review to reviewer; keep your own context for decisions and integration".
- `.agent/workflow.md` não é criado automaticamente.
- `<perfil>/agent-preferences.json` guarda só `supportModel`.

### Modelo por papel

Ordem de decisão:

1. Config do papel em `/models` (`<perfil>/agent-models.json`).
2. Frontmatter do papel (`model`, `thinking`).
3. Slot: `.agent/workflow.md`, se existir; senão scout=apoio e os demais=principal.

O slot `apoio` usa o modelo de apoio; `principal`, o modelo da sessão. Não há classificador de dispatch. Sem modelo de apoio configurado, todos os filhos herdam o modelo principal. Risco de custo: configure o apoio em `/models`.

### Isolamento

Cada filho é outro processo `pi -p`, com contexto próprio. Só o resultado volta ao pai. O que o filho lê não entra no contexto nem no cache do pai.

### O que o pai consegue auditar

- **Registro do job:** `<perfil>/subagent-jobs/<sessionId>/<jobId>.json`, modo 0600, gravado atomicamente. Uma entrada por tarefa: papel, brief, `cwd`, modelo usado, thinking, usage e caminho do JSONL do filho. O caminho do JSONL entra no registro quando a tarefa começa. Tarefa que falhou também tem entrada; tarefa não executada fica marcada como tal.
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
- O system prompt do papel vai por arquivo temporário, apagado no fim. O registro guarda o nome do papel, não o texto. As regras de `.agent/workflow.md` anexadas à tarefa ficam no JSONL do filho.
- Escritor único (single, chain, ou `parallel` com um só escritor) grava direto no `cwd`, sem worktree nem diff registrado. Use `git` para ver o que mudou.
- Sandbox só cobre o `bash` de papéis sem `edit`/`write`: seatbelt no macOS, bwrap no Linux, `none` sem suporte. O resultado informa `sandbox=`. Sem sandbox, o detector compara só o `git status` do checkout antes e depois; escrita fora do checkout Git não é vista.
- `list` apaga o registro de jobs terminados há mais de 30 dias, junto com worktrees limpos e já integrados. Worktree sujo ou não integrado preserva o registro. Os JSONL dos filhos ficam.
- O prefetch (`AGENT_CACHE_PREFETCH_NEXT=1`) roda com `--no-session`; seu custo não entra em usage.

## Dependências pessoais / degradação

O código de `agent/` não depende de caminhos literais `/Users/biel` (só um exemplo em `agent/extensions/agent/web/README.md`). `lib/paths.ts` conserva a descoberta opcional de `/mnt/garime` e `~/Sistema` (ou `PI_SYSTEM_DIR`); sem o mount usa o HOME local.

| Extensão | Sem infraestrutura pessoal |
|---|---|
| vault-runtime | Somente com `AGENT_VAULT=1`. Sem opt-in mantém o prompt nativo e não depende de Vault. Nenhum dado pessoal é migrado. |
| subagent | Papéis/modelos usam o perfil do Agent, não o Vault. Sem modelo de apoio configurado, o filho herda o modelo principal. Allowlists e confirmações de agentes do projeto continuam aplicáveis; falhas de quota não trocam o modelo silenciosamente. Gate Megamind explicitamente configurado continua falhando fechado. |
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
| ask-user, btw, codex-fast, files, plan, slash-anywhere, todos, tool-lexicon, whimsical | Sem infraestrutura pessoal obrigatória. |

Patches de compatibilidade ficam em `agent-patches/`.

## Verificação

```sh
for t in scripts/test-*.mjs; do ORCA_BACKGROUND_LAUNCH=1 node "$t" || exit; done
```

O teste de startup usa o Pi instalado, mas HOME, agent-dir, cwd e store temporários e ambiente sem credenciais herdadas. Carrega exatamente os registros instalados e abre `pi --mode json -p`, conferindo tools e os cinco papéis. O provider aponta para loopback fechado com chave fictícia: a falha de conexão é esperada, não há inferência real. Sem Pi instalado o teste informa que pulou; isso não equivale a validar startup. Não é teste visual da TUI.
