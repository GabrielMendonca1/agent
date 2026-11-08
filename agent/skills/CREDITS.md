# Origem das skills deste diretório

Skills de terceiros, instaladas aqui com o nome final do Agent. Todas MIT.
Frontmatter (nome, descrição, `disable-model-invocation`) reescrito para o Pi;
referências cruzadas e trechos marcados abaixo foram adaptados. Corpo de resto
preservado. `agents/` (Codex), `tests/`, `evals/`, `.github/` não foram copiados.

| Skill | Origem | Caminho na origem | Licença | Commit |
| --- | --- | --- | --- | --- |
| `ui-review` | [jakubkrehel/skills](https://github.com/jakubkrehel/skills) | `skills/better-interface` | MIT | `c0588bb` (2026-10-10) |
| `a11y` | jakubkrehel/skills | `skills/better-accessibility` | MIT | `c0588bb` |
| `colors` | jakubkrehel/skills | `skills/better-colors` | MIT | `c0588bb` |
| `layout` | jakubkrehel/skills | `skills/better-layout` | MIT | `c0588bb` |
| `type` | jakubkrehel/skills | `skills/better-typography` | MIT | `c0588bb` |
| `polish` | jakubkrehel/skills | `skills/better-ui` | MIT | `c0588bb` |
| `microcopy` | jakubkrehel/skills | `skills/better-writing` | MIT | `c0588bb` |
| `figma-to-code` | jakubkrehel/skills | `skills/build-design` | MIT | `c0588bb` |
| `award-site` | [juliobsz/skills](https://github.com/juliobsz/skills) | `awwwards` | MIT | `2a920ea` (2026-10-12) |
| `iso-figure` | [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy) | raiz do repo | MIT (ver `iso-figure/LICENSE`) | `454a0ef` (2026-10-13) |
| `html-plan` | [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community) | `html-plan/skills/html-plan` | MIT | `f60f045` (2026-10-05) |
| `prototype` | [mattpocock/skills](https://github.com/mattpocock/skills) | `skills/engineering/prototype` | MIT | `49dd158` (2026-10-09) |
| `tdd` | mattpocock/skills | `skills/engineering/tdd` | MIT | `49dd158` |
| `pr` | mattpocock/skills | `skills/engineering/pr` (crédito próprio em `pr/CREDITS.md`) | MIT | `49dd158` |
| `sources` | mattpocock/skills | `skills/engineering/research` | MIT | `49dd158` |
| `handoff` | mattpocock/skills | `skills/productivity/handoff` | MIT | `49dd158` |
| `rea` | [morluto/rea](https://github.com/morluto/rea) | `.agents/skills/reverse-engineer-anything` | MIT | `82cfcee` (2026-10-13) |

## Categorias

`system/` (`html-plan`, `pr`, `handoff`, `sources`) é anunciado ao modelo.
`design/`, `dev/` e `plan/` mantêm `disable-model-invocation: true`; cada pasta gera
uma linha curta no system prompt e agrupa o seletor de `/skill:`.
As skills pessoais não são movidas nem modificadas.

`dev/debug` veio da antiga `skills/debug` do overlay (incluindo `references/tactics.md`).
Agora é distribuída somente pelo Agent, sob demanda, sem cópia nas skills padrão do overlay.

## Adaptações de corpo

- `ui-review`, `figma-to-code` e as especialistas: `better-*` → `a11y`, `colors`,
  `layout`, `type`, `polish`, `microcopy`, `ui-review`; `build-design` →
  `figma-to-code`. Menções às skills cortadas (`interface-review`, `variant`,
  `break`) saíram; `ui-review` passa a ler as especialistas pelo caminho irmão
  (`../a11y/SKILL.md` …), já que elas são invocáveis só pelo usuário.
- `iso-figure`: publicação na galeria pública da Anatomy removida
  (`references/publish.md`, `scripts/publish.mjs`, `scripts/session.mjs` e a linha
  do índice). HTML gerado de `examples/` não foi copiado (é reconstruível com
  `node examples/<nome>/build.mjs`).
- `html-plan`: `$ARGUMENTS` (Claude Code) → texto após `/skill:html-plan`.
- `rea`: reparo de registro por `rea setup` → a entrada `rea` do `mcp.json` do perfil, que o
  Gabriel liga em `/mcp`; `doctor` segue disponível (read-only).
- `sources`: “background agent” → `subagent` (só em complex). `handoff`: “Skill tool” →
  `/skill:<nome>`. `iso-figure`: `compatibility` sem “Written for Claude Code”.
