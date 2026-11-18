# Agent: essência do Pi e do fx

Pesquisa: 2026-11-15. Escopo documental; sem implementação ou auditoria dos patches locais.

## Conclusão

**Manter Pi como base do Agent; aproveitar do fx minimalismo, ergonomia de shell e separação entre núcleo e integração.** O anúncio não recomenda substituir Pi: lista Pi e fx como harnesses distintos suportados pela mesma camada do AI SDK. Tornar Agent uma CLI instalável e remover Juice são decisões do produto local, não requisitos impostos por Pi ou fx. [1–4]

## O que cada nome significa

| Camada | Papel documentado |
| --- | --- |
| Modelo | LLM usado pelo agente; não é Pi, fx nem o adapter. Pi oferece API multiprovedor; fx declara independência de modelos e provedores. [1,3] |
| Harness | Runtime que organiza agente, ferramentas e estado. Pi se define como harness mínimo e extensível; fx como harness e CLI em Zig voltados a pesquisa e incorporação em outros sistemas. [1,3] |
| CLI | Interface executável para uso no terminal. Pi oferece interação, print/JSON, RPC e SDK TypeScript; fx oferece binário nativo, UI próxima de shell e execução pontual com `fx ask`, sem serviço de fundo obrigatório. [1,3] |
| Adapter | `@ai-sdk/harness-fx` conecta fx à interface `HarnessAgent` em aplicações. Não é modelo, nem distribuição do Pi, nem substituto automático da CLI Agent. [2,4] |

## O que aproveitar

- **Pi:** núcleo adaptável por extensões, skills, prompts, temas e pacotes distribuíveis por npm/git. Subagentes e modo de planejamento não fazem parte dos defaults descritos: podem ser adicionados conforme o fluxo. Para Agent, favorecer capacidades opcionais em vez de tornar toda a herança pessoal Mark obrigatória. [1; recomendação]
- **fx:** ferramentas e prompts concisos, instruções de skills e schemas MCP carregados quando necessários, histórico de terminal preservado e atividade de ferramentas junto à conversa. Usar como critérios de experiência e eficiência, sem prometer ao Agent o tamanho ou desempenho do binário Zig. [3; recomendação]
- **Distribuição:** Pi já documenta instalação de CLI, dependências fixadas pelo instalador e requisito Node >= 22.19. Priorizar instalação reproduzível do Agent e recursos pessoais opcionais; não é necessário trocar o runtime para obter uma CLI instalável. [1; recomendação]

## Limites e incompatibilidades

1. **Anúncio versus documentação atual:** o changelog de 31/08/2026 descreve ACP via `@ai-sdk/harness-acp`. Seu link `/v7/providers/ai-sdk-harnesses/fx` hoje redireciona para documentação que descreve **libfx no host**, sem processo de bridge no sandbox. Registrar as duas versões da descrição; não assumir ACP como contrato atual nem inferir quando ocorreu a mudança. [2,4]
2. **Não há equivalência automática de extensões/sessões:** Pi usa seu ecossistema TypeScript/pacotes; o adapter fx usa checkpoints libfx e estado de lifecycle. As fontes não prometem importar patches, sessões ou extensões Pi. Migração exigiria validação específica. [1,4]
3. **Adapter não expõe toda a CLI fx:** oferece ferramentas selecionadas; MCP command/stdio não é suportado, e compactação manual não é suportada pelo libfx estável. Tanto os pacotes harness quanto fx são apresentados como experimentais. [3,4]
4. **Segurança não vem do minimalismo:** Pi executa com as permissões do processo e não inclui sistema próprio de restrição de acesso. No adapter fx, ferramentas internas de filesystem/shell operam no sandbox, mas runtime, credenciais e conexões MCP ficam no host. Não transferir essas garantias para a CLI local por analogia. [1,4]

## Relação com o ambiente local

Os quatro READMEs exigidos foram lidos: `mark-pi/README.md`, `prometheus/prometheus/README.md`, `megamind/README.md` e `lucid-dream/README.md`, sob `/Users/biel/Projects/`. Mark descreve customizações sobre Pi; Prometheus aceita outros agentes CLI e não exige Mark; Megamind mantém integração Pi própria; Lucid Dream é projeto separado. Portanto, não incorporá-los como dependências obrigatórias do núcleo Agent apenas por herança. Isso é recomendação de arquitetura, não auditoria de dependências.

O contexto da tarefa informa Agent clássico 1.5.0 com dez patches; o README atual de Mark já menciona 1.5.1. Não confundir os checkouts. A fonte Pi abaixo foi fixada no commit que o README Mark identifica como base 1.5.0. A existência de pacotes durable no monorepo não demonstra que Agent os utiliza.

**Próximo passo recomendado:** concluir a auditoria local; empacotar a CLI Pi-based; retirar Juice preservando contratos necessários de uso/custo do provedor; manter integrações pessoais opcionais. Avaliar adapter apenas se houver requisito concreto de incorporar Agent em uma aplicação. Nenhuma autenticação foi usada ou testada; suporte a OpenAI não valida OAuth Anthropic expirado.

## Fontes primárias

1. [Pi — README na base f9a2636](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/README.md).
2. [Vercel — anúncio exato do adapter fx](https://vercel.com/changelog/fx-ai-sdk-harness-adapter).
3. [fx — apresentação oficial, arquitetura e ergonomia](https://fx.sh/).
4. [AI SDK — documentação atual do adapter fx](https://ai-sdk.dev/providers/ai-sdk-harnesses/fx), destino observado do link versionado do anúncio.

Verificação: fontes acessíveis e conteúdo confrontado; nenhuma execução de Pi/fx, instalação, publicação ou teste de compatibilidade. `.pi/checks.json` foi lido: não contém check dedicado a esta nota Markdown; checks de runtime não foram executados.
