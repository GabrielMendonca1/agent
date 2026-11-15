# Agent

Agent é o agente de terminal pessoal do Gabriel, usado na ARCA, no Omni e em projetos pessoais, com o Megamind como integração. É o [Pi oficial](https://github.com/earendil-works/pi) **1.5.0 clássico** (base `f9a26365568127461c47a07a37dcb42c140a3ac5`) com 10 patches pequenos (`overlay/`), mais:

- `agent/`: extensões (`agent/extensions/agent`, `agent/extensions/brain-live`), temas, skills por categoria e papéis de subagente (`agent/agents/`);
- `skills/`: skills padrão copiadas para o store a cada ativação;
- `extensions/megamind/`: extensão Megamind;
- `agent-patches/`: patches aplicados sobre a árvore `agent/` para rodar sem infraestrutura pessoal;
- `scripts/`: updater, launcher e testes do portão de checks (`.pi/checks.json`).

Runtime novo sem contabilidade Juice; subagentes são opt-in (`AGENT_SUBAGENTS=1`), sem modo complex obrigatório. Cache-keeper e Megamind permanecem. Subagentes rodam em processos `pi -p`, vinculados por `parentSession`. Sessões JSONL, `/resume` e `--session` são os oficiais do Pi.

Distribuição privada por artefatos prontos, com Node externo >=22.19 e acesso autenticado via `gh`: sem clone/build para o consumidor. Pipeline implementado, ainda sem release publicada por esta mudança. Instalação em `~/.local/share/agent`, perfil próprio `~/.agent` e comando `~/.local/bin/agent`; `/login` usa a conta do usuário. Update e rollback verificam o par Pi+Agent antes da troca. Nenhuma credencial ou estado pessoal é distribuído.

- Repositório: [GabrielMendonca1/agent](https://github.com/GabrielMendonca1/agent)
- Instalar e configurar: [docs/setup.md](docs/setup.md)
- Overlay, store, updater e port: [overlay/README.md](overlay/README.md)
- Nomes antigos → novos: [docs/rename-map.md](docs/rename-map.md)
- Contrato com consumidores externos: [docs/consumer-contract.md](docs/consumer-contract.md)

Licença MIT ([LICENSE](LICENSE)); atribuições em [NOTICE](NOTICE).
