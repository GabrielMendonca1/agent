# Juice do Agent — ledger + aprendizado (TS/JS)

O Agent interativo não usa binário nativo. `client.mjs` mantém preferências em
`AGENT_JUICE_HOME/preferences.v3.json` (padrão `~/.pi/agent/agent-juice/`) e contabilidade
em `AGENT_JUICE_STATE` (padrão `<home>/run.v3.json`). Opt-in: `AGENT_JUICE_ENABLED=1`.
Caminhos devem ser absolutos. Nenhum limite de token ou grant é imposto.

Escrita: trava de diretório com dono PID/nonce, leitura/alteração sob a trava,
arquivo temporário privado e rename atômico. Dono comprovadamente morto pode ser
reaproveitado; trava sem dono exige limpeza manual, nunca é roubada por idade.
O conteúdo mantém schema v2; versões inválidas falham explicitamente.
A geração Rust/v1 continua em `run.json` e `preferences.json`, com seu ambiente
histórico. O launcher JS usa `run.v3.json`, inclusive em episódios. O client JS
usa somente esse nome no diretório indicado por `AGENT_JUICE_STATE` (ou no home);
nunca abre, migra ou altera o ledger Rust. O preload publica o caminho resolvido
no env para watchers, subagentes e `pi -p`. As preferências JS são independentes:
na primeira leitura/escrita, apenas o modo válido de `preferences.json` pode ser
usado como valor inicial e persistido no arquivo novo, sob trava; o arquivo antigo
nunca é escrito. Mudanças posteriores no modo antigo não são importadas.
Não há reset automático de custo em reload ou nova sessão.

## API

As exportações compartilhadas continuam: `juiceEnabled`, `juiceOperation`,
`getJuiceSnapshot`, `getJuiceSnapshotAsync`, `getJuiceReport`,
`recordJuiceCacheEvent`, `getJuiceReceipts`, `getJuicePreferences`,
`setJuicePreferences`, `setJuiceMode`, `formatJuiceStatus`.

- `init`: cria run ausente; `mode`: altera o campo legado de contabilidade sem reset.
  Esse campo não autoriza subagentes nem define o modo da sessão.
- `reserve`, `settle`, `cancel`, `unknown`: contabilizam chamadas e custo conhecido.
  Resultado desconhecido conserva a reserva; não significa uso zero.
- `snapshot` e `report`: contadores, custo, agregados por modelo/tipo e cache.
  Snapshot traz somente as últimas 50 chamadas pendentes, nunca todos os receipts.
- `cache`: telemetria fechada (gaps, quebras, warm skips, decisões de compactação/poda),
  sem texto de payload. Os gaps persistem 10 buckets antes do incremento, com bordas
  300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400 e null; cada um
  guarda `returned` e `censored`. Observabilidade nunca lança.
- A paginação de auditoria não tem consumidor interativo: `getJuiceReceipts` retorna
  `null`; a operação `receipts` retorna página vazia. Agregados continuam disponíveis.
- Preferências guardam o `mode` inicial e `supportModel`; filhos não podem alterá-las.
  `setJuiceMode` define o modo padrão, não muda sessões existentes.

`runtime.mjs` continua como preload do ModelRuntime do Pi, antes do dispatch.
Reserva e liquida no JSON via client JS, preservando o teto declarado pelo chamador,
o stream e os custos do provider. Pai e subagentes compartilham o ledger. Não cobre
SDKs arbitrários nem tools HTTP externas; não é sandbox nem teto universal de custo.

## Modo da sessão

O branch ativo do Pi guarda uma entrada `custom` de tipo `agent-mode`, com
`{ version: 1, mode: 'simple' | 'complex' }`. A última entrada desse tipo
é a autoridade para prompt, interface e bloqueio de subagentes. Sem entrada,
a sessão salva uma vez o padrão das preferências; dados inválidos bloqueiam o dispatch.
Retomada e fork preservam o modo salvo no branch. Shift+Tab e `/mode` alteram
somente a sessão atual, não as preferências nem o ledger compartilhado.

## Aprendizado

`juice.ts` mantém a interface simple/complex, compactação e bloqueio de
subagent em simple. Após run com checks verdes, o modelo de apoio pode escrever
0–3 regras em `.agent/workflow.md`. Cada regra recebe `[by: Agent; proven: no]`;
`.agent/history.json` guarda também `by` (modelo de apoio), `mode` e `proven: no`.
`parseWorkflow` continua lendo as regras. Não existe prova local automática nem
estado de prova no rodapé.
