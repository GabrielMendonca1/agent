# Skills de empresa

Skills do Agent com escopo de empresa: `arca/<skill>/SKILL.md` e `omni/<skill>/SKILL.md`.

- Ficam fora de `agent/skills` porque aquela pasta vai para todo usuário em `settings.skills`.
- Cada pasta só entra na sessão (via `resources_discover` em `extensions/brain-live/juice.ts`) para
  quem tem o enrollment da empresa: `~/.config/arca-projects/config.json` ou
  `~/.config/omni-megamind/config.json` (critério em `juice/companies.mjs`, o mesmo do Megamind).
- Para quem as recebe, são automáticas (anunciadas ao modelo) e aparecem no seletor `/skill:`
  numa categoria com o nome da empresa.
- Frontmatter: `name` igual à pasta, `description` curta; sem `disable-model-invocation`.
