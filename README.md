# mark-pi — Mark II

`mark-pi` é o agente de terminal pessoal do Gabriel, usado na ARCA, no Omni e em projetos pessoais, com o Megamind como integração. Ele leva as skills padrão (`skills/`), o Megamind (`extensions/megamind/`) e o setup vendorizado do Gabriel (`mark/`: extensões, temas e papéis de subagente). O updater instala os recursos, preenche somente defaults ausentes e coloca `pi` no PATH, sem duplicar extensões pessoais.

A base nova é o [Pi oficial](https://github.com/earendil-works/pi) **1.5.0 clássico**, com 10 patches, extensões e instalação/rollback locais. Não há host durável nem ipython: sessões JSONL, `/resume` e `--session` são os oficiais. Os nomes internos de compatibilidade — store `~/.local/share/pi-overlay`, comandos, flags, variáveis e arquivos `pi-overlay-*` — permanecem inalterados.

O Mark II adiciona os modos `simple` (agente sozinho) e `complex` (subagentes assíncronos), skills por categoria, papéis de subagente (`mark/agents/`) e a tool nativa `codemode` do Pi ativa em toda sessão. Subagentes rodam em processos `pi -p`, vinculados por `parentSession`. Detalhes em [STATUS.md](STATUS.md).

- Repositório: [GabrielMendonca1/mark-pi](https://github.com/GabrielMendonca1/mark-pi)
- Operação e arquitetura: [overlay/README.md](overlay/README.md)
- Estado atual: [STATUS.md](STATUS.md)

## Instalar e atualizar

[Comandos para Mac limpo e Gabriel, contrato de instalação e dependências opcionais](docs/mark-setup.md). Requer Git e Node >= 22.19. Nenhuma credencial ou estado pessoal é distribuído.

## Port 1.5.0

Base `f9a26365568127461c47a07a37dcb42c140a3ac5`. Cache Markdown e entry graphs POSIX são upstream; o overlay mantém batching, PI_TUI_HZ e TUI/resumo do Mark. Ativação local de `378c3ad` confirmada pelo agente pai; detalhes em [STATUS.md](STATUS.md).

## Estado da distribuição — 2026-11-02

- Mac do Gabriel ativo: `1.5.0-f9a2636556-5758bef0a3-f6a843b39a`, artefato `3ff60e38bc4a` (clássico, sem durable-host).
- Mark interativo e updater sem Rust: artefatos novos levam a árvore `mark/`, sem broker. Juice usa ledger JSON e aprendizado em TS/JS; regras aprendidas ficam marcadas como escritas pelo Mark e não provadas. Artefatos antigos mantêm seu runtime declarado para rollback.
- Pendente: propor o batching/PI_TUI_HZ de `stream-markdown` upstream como PR e validar em Windows real.

[Visão geral](docs/diagrams/mark-blocos/0-visao-geral.png) · [codemode](docs/diagrams/mark-blocos/5-codemode.png) · [situação histórica (21/10)](docs/diagrams/mark-situacao-2026-10-21.png).

Lucid Dream vive somente no repo `/Users/biel/Projects/lucid-dream`; não faz parte do Mark nem do seu setup.

Super-agent lives in /Users/biel/Projects/superagent
