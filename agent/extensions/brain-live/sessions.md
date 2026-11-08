# sessions.ts — `/sessions`

Lista sessões salvas e troca para a escolhida. O alias `/resume` não é registrado porque esse nome pertence ao comando interativo nativo do Pi.

- **Escopo.** Por padrão só as sessões cujo `cwd` do header bate com o `cwd` atual (o diretório de sessões do pi é global, compartilhado por todos os projetos). `/sessions all` lista todos os projetos, com o `cwd` no label.
- **Sessão atual.** Excluída por caminho canônico (`realpathSync`, com `resolve` como fallback), então symlink no diretório ou no arquivo não a faz reaparecer.
- **Leitura limitada.** De cada arquivo lê só os primeiros 64 KiB + 1 byte: o byte extra diz se ainda há arquivo além da janela, e só nesse caso a última linha (possivelmente cortada) é descartada. Arquivo que cabe exatamente em 64 KiB é lido inteiro, com ou sem newline final. Arquivo de 2 GiB custa o mesmo que um de 2 KiB. Sem header `type:"session"` válido nesse trecho, o arquivo é ignorado.
- **Preview honesto.** Sem mensagem de usuário no trecho lido, o label distingue os dois casos: `(no preview)` quando o arquivo cabe na janela e realmente não tem turno de usuário, `(preview past 64 KiB)` quando a janela foi cortada e a mensagem pode estar além dela.
- **Provider/model.** Best-effort, só para exibir. Vem do último `model_change` (ou do `provider`/`model` da última mensagem assistant) visto na janela de 64 KiB; para arquivo maior que isso, lê também os últimos 64 KiB e a cauda vence. Ausente = coluna omitida, nunca `?`.
- **Ordem e labels.** `mtime` decrescente, empate pelo nome do arquivo. Label = `NN  YY-MM-DD HH:mm  <projeto>  <id-curto>  [provider/model]  <preview>` — determinístico e sempre distinto entre linhas (o prefixo `NN` garante).
- **Troca.** Só para um caminho descoberto na listagem. Esc não faz nada; `cancelled` avisa e não muda nada; qualquer erro do `switchSession` (ex.: `cwd` da sessão sumiu) vira `notify(..., "error")` em vez de exceção.
- **Outro projeto.** Retomar sessão cujo `cwd` canônico difere do atual leva o diretório de trabalho junto, então pede confirmação antes via `ui.confirm(title, message)` — os dois argumentos são obrigatórios em todos os modos do runtime (interativo, RPC, daemon, print), então não há fallback. Recusar não troca nada e não notifica.

## Decisões e limites conhecidos

- **Parser próprio em vez de `readSessionInfo()`.** `readSessionInfo` streama o arquivo inteiro no primeiro acesso; aqui são 64 KiB fixos por arquivo, sem acoplar a extensão ao runtime — o que também mantém os testes offline. Revisitar se aparecer session version 4, ou se o label precisar de `name`/`messageCount`/`agentStatus`.
- **O JSONL é árvore, não lista.** O `model_change` lido da cauda pode pertencer a um ramo que não é o ativo, então o provider/model do label é indicativo. Quem decide o modelo ao retomar continua sendo o runtime (`buildSessionContext`); a extensão só passa o path para `ctx.switchSession` e não escreve nada.
- **Escritor concorrente.** Um arquivo sendo escrito por outra sessão pode render linha final parcial: ela cai no `catch` do `JSON.parse` e é ignorada. Arbitrar duas sessões sobre o mesmo arquivo é do runtime, não daqui.

Testes: `bun test ./test/test_sessions_ext.ts` (offline, fixtures em tmp, independente de timezone).
