# Claude Code é open source? — 2026-11-14

Pergunta: Claude Code é open source hoje? E o anúncio de self-hosted Claude Managed Agents muda isso?

## Conclusão

Não. Claude Code é proprietário. O repositório `anthropics/claude-code` é público, mas a licença reserva todos os direitos e remete aos Commercial Terms of Service. O pacote npm declara `SEE LICENSE IN README.md`, não uma licença OSI. Self-hosted Claude Managed Agents é outro produto e é uma opção de implantação. O artigo não fala em código aberto nem em licença aberta.

## Fontes primárias (consultadas em 2026-11-14 ~19:20 UTC)

### Licença — `anthropics/claude-code`

URL: https://github.com/anthropics/claude-code/blob/main/LICENSE.md (lido via `raw.githubusercontent.com`, `main` em `b539f1f3032a2b41d057996333229bba4fcde116`, commit de 2026-11-14T18:49:46Z).

Texto integral:

> © Anthropic PBC. All rights reserved. Use is subject to Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

Último commit que alterou `LICENSE.md`: `6f27711e04` (2025-05-22, "Release Claude Code 1.0.0 with general availability"). O texto não mudou desde então.

API do GitHub (`GET /repos/anthropics/claude-code`): `"license": null`, `"visibility": "public"`. O GitHub não detecta nenhuma licença padrão.

### README — `anthropics/claude-code`

URL: https://github.com/anthropics/claude-code/blob/main/README.md. Trechos:

> Claude Code is an agentic coding tool that lives in your terminal, ...

> Installation via npm is deprecated. Use one of the recommended methods below.

> For full details, please review our [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) and [Privacy Policy](https://www.anthropic.com/legal/privacy).

O README não se refere ao projeto como open source. A raiz do repo tem `.claude-plugin`, `.claude`, `.devcontainer`, `.github`, `.vscode`, `CHANGELOG.md`, `CLAUDE.md`, `LICENSE.md`, `README.md`, `SECURITY.md`, `Script`, `demo.gif`, `examples`, `feed.xml`, `mods`, `plugins` e `scripts`. Não há árvore de código-fonte do CLI. O repo serve para issues, changelog, plugins e exemplos.

### npm — `@anthropic-ai/claude-code`

URL: https://registry.npmjs.org/@anthropic-ai/claude-code/latest — `version: 2.1.325`, `license: "SEE LICENSE IN README.md"`.

### Artigo de self-hosted Managed Agents

URL: https://claude.com/resources/articles/self-hosted-claude-managed-agents (data: November 12, 2026). Trechos:

> Self-hosted Claude Managed Agents is now available in private beta.

> With self-hosted Managed Agents, every part of the service runs in your own cloud or on-premise, including the harness, sandboxes, credentials, and session history. You operate the Managed Agents server, its database, and the workers where agents run their shell and file tools.

> Contact your Anthropic account team to request access

O artigo não menciona código aberto, licença ou Claude Code como o produto self-hosted. Ele fala de Managed Agents, uma "suite of composable APIs" da Claude Platform. O acesso é por beta privado via account team.

## Distinções

- Repositório público não significa open source. Sem licença que conceda direitos ("All rights reserved"), ver o código não dá permissão de uso, modificação ou redistribuição.
- Self-hosted não significa open source. Rodar o servidor no próprio ambiente é uma forma de implantação. Os termos de uso do beta não foram verificados.
- Managed Agents e Claude Code são produtos distintos: plataforma de APIs/harness no primeiro caso, CLI de terminal no segundo.

## Limitações

- Não li os Commercial Terms of Service nem a documentação https://platform.claude.com/docs/en/managed-agents/self-hosted. Os termos de licença do servidor self-hosted ficam em aberto.
- Não verifiquei outros repositórios da Anthropic, como Agent SDKs e `claude-plugins-official`, que podem ter licenças diferentes.
- Conteúdo lido via fetch HTTP sem login. Páginas que dependem de JS podem ter mais texto do que o capturado.
