---
name: handoff
description: "Encerra a tarefa com um handoff curto para a próxima sessão."
argument-hint: "Foco da próxima sessão"
---

Encerre a tarefa atual escrevendo um handoff de no máximo 40 linhas em
`.agent/handoff.md` do cwd (crie `.agent/` se necessário) com a tool `write`.
Sobrescreva o handoff anterior; não grave em diretório temporário.
Escreva só o corpo, sem frontmatter: o Agent carimba sessão, horário, branch e
HEAD sozinho. A próxima sessão nesta branch recebe o handoff na primeira mensagem.

Inclua apenas o necessário para continuar:
- Objetivo e estado atual, considerando os argumentos como foco da próxima sessão.
- Decisões tomadas e seus motivos, de forma curta.
- Commits relevantes do ramo: consulte `git log --oneline` e registre hashes e títulos.
- Pendências, bloqueios e checks que falharam ou não foram executados.
- Caminhos tocados; referencie planos, notas e diffs existentes em vez de copiá-los.
- Um próximo passo concreto.

Não inclua segredos nem invente commits, resultados ou verificações. Fora de um
repositório git, indique que commits não se aplicam. Não faça commit automaticamente.
Termine o handoff lembrando: se criou ou alterou uma nota, atualize `.agent/notes.md`.
Confirme brevemente o caminho gravado.
