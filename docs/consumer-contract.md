# Contrato com consumidores externos

Um consumidor externo localiza a instalação por caminho, em tempo de execução. Não importa código deste repositório, não escreve no store nem no settings do Pi. O consumidor de referência hoje é o Superagent (`/Users/biel/Projects/superagent`, `src/infra/mark-release.ts`, `scripts/lib/superagent-loader.mjs`).

## Hoje (instalação Mark) e Agent

A coluna "Hoje" descreve o que o Superagent lê agora, numa instalação feita com os nomes antigos. A coluna "Agent" é o que uma instalação feita por este repositório produz.

| Item | Hoje | Agent |
|---|---|---|
| Store | `~/.local/share/pi-overlay` | `~/.local/share/agent` |
| Configuração do runtime | `<store>/mark-ii/config.json` | `<store>/runtime/config.json` |
| Releases do runtime | `<store>/mark-ii/releases/` | `<store>/runtime/releases/` |
| Raiz da release | `<store>/mark-ii/releases/<artifactId>/mark` | `<store>/runtime/releases/<artifactId>/agent` |
| Extensões de worker | `<raiz>/extensions/brain-live/…` | `<raiz>/extensions/brain-live/…` (na árvore: `agent/extensions/brain-live`) |
| Skills da release | `<raiz>/skills` | `<raiz>/skills` |
| Raiz do Pi (SDK) | `<store>/current/lib/node_modules/@earendil-works/pi-coding-agent` | igual, com o store novo |
| Override da raiz do Pi | `MARK_JUICE_PI_ROOT` | `AGENT_PI_ROOT` (v3); `AGENT_JUICE_PI_ROOT` somente legado |
| Tools exigidas | `checks`, `plan`, `subagent`, `jobs` | inalteradas |

## Identidade da release instalada (Megamind)

O app Megamind lê `<store>/active.json`, sem importar código do updater. O campo aditivo e opcional `release` identifica a distribuição GitHub que instalou o par ativo:

```json
{
  "release": {
    "tag": "v-agent-2026.07.16",
    "assetId": "<id>",
    "repo": "GabrielMendonca1/agent"
  }
}
```

- `release.tag`: tag retornada por `gh release view`; não é a versão do Pi (`officialVersion`). O instalador resolve a tag antes de baixar e fixa o download nela, inclusive para `latest`.
- `release.assetId`: string `releaseId` do `artifact.json`, exatamente o `<id>` em `agent-<id>-<platform>-<arch>.tar.gz`. Não é o ID numérico do asset no GitHub nem o `artifactId` do runtime em `runtime/config.json`. Inclui o digest portátil que distingue mudanças só do Agent.
- `release.repo`: canal `owner/repo` usado no download, respeitando `AGENT_RELEASE_REPO`.

O consumidor compara esses valores com `gh release view -R <repo> --json tagName,assets`: `tagName` e o nome do tarball da plataforma/arquitetura esperada. Igualdade de tag e assetId identifica a mesma distribuição; diferença indica outra distribuição disponível, não uma ordenação cronológica. Não compare `installedAt`/`activatedAt`, versão do Pi ou ordem lexical das tags. Ausência de `release` significa identidade desconhecida (instalação antiga, checkout ou archive local), não “atualizado”.

`install.sh` remoto, `agent update` e `--install-artifact latest|<tag>` preenchem o objeto. Instalação por archive local ou `AGENT_RELEASE_DIR` não infere uma tag. Rollback recupera a identidade do par anterior, inclusive ausência; falhas de ativação restauram o registro anterior. O índice `<store>/release-identities.json` é estado interno do updater, fora da árvore verificada, e não é contrato de leitura para consumidores.

`agent overlay-status` é textual, sem modo JSON próprio. Inclui uma destas linhas:

```text
Release: <tag> (assetId <id>, repo <owner/repo>)
Release: unknown (local install or unrecorded release)
```

Para consumo estruturado, leia `active.json`; campos existentes permanecem inalterados.

## Configuração do runtime

`config.json` é JSON. O consumidor usa:

- `enabled`: `false` significa runtime desligado; o consumidor falha fechado.
- `artifactId`: string `^[\w.-]+$`; nomeia o diretório em `releases/`.

Configs v2 acompanham artefatos internos v3: não têm `juiceHome`. Configs v1 e artefatos v1/v2 são históricos e preservam o contrato de accounting histórico para rollback. `piRoot` e `resourceReceipt` pertencem ao updater; o consumidor não deve editá-los. O preload novo fica em `agent/core/runtime.mjs`, mas v3 usa `AGENT_RUNTIME_ENABLED=1` e `AGENT_PI_ROOT` absoluto, sem accounting. Filhos usam `AGENT_CHILD=1`. A tool `subagent` está sempre ligada na sessão principal; filhos não lançam subagentes. Não há modo de sessão nem variável para desligar. Preferências (só `supportModel`) ficam em `PI_CODING_AGENT_DIR` (default `~/.agent`).

## Extensões de worker

Relativas a `<raiz>/extensions/brain-live`. Todas obrigatórias; falta de qualquer uma é erro.

- `checks/`
- `jobs/`
- `subagent/`
- `plan.ts`
- `loop-guard.ts`
- `compaction.ts`
- `vault-runtime.ts`

Depois do carregamento, as tools `checks`, `plan`, `subagent` e `jobs` precisam estar registradas e ativas. Os nomes das tools e dos arquivos acima não mudam no Agent.

## O que o consumidor precisa trocar

1. Caminho da configuração: `~/.local/share/agent/runtime/config.json`.
2. Diretório de releases: `~/.local/share/agent/runtime/releases`, subdiretório `agent` em vez do antigo.
3. Raiz do Pi padrão: `~/.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent`; variável `AGENT_PI_ROOT` (v3); `AGENT_JUICE_PI_ROOT` somente legado.
4. Variáveis próprias do consumidor (por exemplo `MARK_SUPERAGENT_MARK_ROOT`) pertencem a ele; o Agent não as define nem lê.

Os stores são diferentes e não há migração automática entre eles. Um consumidor que aceite os dois durante a transição deve escolher um de forma explícita, sem misturar config de um com releases do outro.
