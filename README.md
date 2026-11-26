# Agent

Agent é o agente de terminal pessoal do Gabriel, usado na ARCA, no Omni e em projetos pessoais, com o Megamind como integração. É o [Pi oficial](https://github.com/earendil-works/pi) **1.5.2 clássico** (base `b4afdddf44e059c67ccf5097e5317d913521b470`) com 12 patches pequenos (`overlay/`), mais:

- `agent/`: extensões (`agent/extensions/agent`, `agent/extensions/brain-live`), temas, skills por categoria e papéis de subagente (`agent/agents/`);
- `skills/`: skills padrão copiadas para o store a cada ativação;
- `extensions/megamind/`: extensão Megamind;
- `scripts/`: updater, launcher e testes do portão de checks (`.pi/checks.json`).

Runtime novo sem contabilidade. A tool `subagent` está sempre ligada na sessão principal, e o system prompt pede ao modelo que atue como orquestrador; isolamento, auditoria e lacunas em [docs/setup.md](docs/setup.md#subagentes-sempre-ligados-isolamento-e-auditoria). Cache-keeper e compactação ociosa ficam ligados por padrão; custo e como desligar em [docs/setup.md](docs/setup.md#custo-o-que-roda-sem-prompt). `/rewind` desfaz as edições de arquivo do agente (edit/write, não bash) e/ou a conversa até um turno escolhido; snapshots e limpeza em [docs/setup.md](docs/setup.md#checkpoints-de-arquivo-e-rewind). Megamind permanece. Subagentes rodam em processos `pi -p`, vinculados por `parentSession`. Sessões JSONL, `/resume` e `--session` são os oficiais do Pi.

Distribuição por artefatos prontos via HTTPS (GitHub Releases público ou origem própria), com verificação Ed25519 de `SHA256SUMS`: sem clone/build para o consumidor. O alvo dispensa `gh` e Node na máquina (Node 24 portátil em `<store>/node`). Estado por parte e pendências em [docs/setup.md](docs/setup.md#instalação-por-artefato). A chave pública oficial ainda não está provisionada nesta base; procedimento em [Provisionar a chave](docs/setup.md#provisionar-a-chave-de-assinatura-mantenedor). Instalação em `~/.local/share/agent`, perfil próprio `~/.agent` e comando `~/.local/bin/agent`; `/login` usa a conta do usuário. Update e rollback verificam o par Pi+Agent antes da troca. Nenhuma credencial ou estado pessoal é distribuído.

- Repositório: [GabrielMendonca1/agent](https://github.com/GabrielMendonca1/agent)
- Instalar e configurar: [docs/setup.md](docs/setup.md)
- Overlay, store, updater e port: [overlay/README.md](overlay/README.md)
- Nomes antigos → novos: [docs/rename-map.md](docs/rename-map.md)
- Contrato com consumidores externos: [docs/consumer-contract.md](docs/consumer-contract.md)

Licença MIT ([LICENSE](LICENSE)); atribuições em [NOTICE](NOTICE).
