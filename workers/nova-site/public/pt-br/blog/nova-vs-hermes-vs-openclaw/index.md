# Nova vs. Hermes vs. OpenClaw: o bom, o mau e o feio

> Uma comparação honesta e com fontes de três agentes de IA de código aberto e auto-hospedados — OpenClaw, Hermes e Nova — com tabela de recursos, gráficos e o bom, o mau e o feio de cada um.

*Source: https://mynova.space/pt-br/blog/nova-vs-hermes-vs-openclaw/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Três agentes de IA de código aberto e auto-hospedados que você executa por conta própria e conversa a partir dos seus apps de chat — e três apostas muito diferentes sobre o quanto confiar as chaves a uma IA. Um olhar honesto, lado a lado.

Jake Belieny · 20 de julho de 2026 · 12 min de leitura

**Transparência total** Eu construo a Nova. Me esforcei para manter isto justo — os números têm fontes, e a Nova ganha seu próprio *mau* e *feio* como todo mundo. Se algo parecer injusto com a Hermes ou a OpenClaw, me avise e eu corrijo.

Os agentes de IA auto-hospedados tiveram um ano de virada. Você os executa no seu próprio hardware, aponta-os para seus arquivos e seus apps de chat, e eles não apenas respondem — eles *fazem coisas*: enviam mensagens, executam comandos, navegam na web, automatizam sua burocracia. Três são os mais comentados: **OpenClaw**, o fenômeno viral; **Hermes**, o agente de nível de pesquisa da Nous Research; e **Nova** — a que eu construo.

Eles compartilham um formato, mas discordam, profundamente, sobre uma pergunta: **quanto uma IA deveria ter permissão de fazer por conta própria?** Essa única discordância explica quase todo o resto sobre eles — então tenha isso em mente enquanto seguimos.

## O panorama

Dois deles são gigantes. A OpenClaw foi do lançamento (como "Clawdbot") em novembro de 2025 a um quarto de milhão de estrelas no GitHub em poucos meses; a Hermes, respaldada por um laboratório de pesquisa em IA bem financiado, não fica muito atrás. A Nova é a novata — recém-aberta ao código, essencialmente com zero estrelas. Não estou fingindo que a Nova vence um concurso de popularidade. Ela não vence.

Estrelas no GitHub, julho de 2026 (ao vivo). Alcance, não adequação — tudo abaixo é sobre adequação.

## Conheça os três

**OpenClaw** — um assistente de IA pessoal que vive nos seus apps de chat. Construído em TypeScript/Node com um companheiro em Swift, conecta qualquer modelo — Claude, GPT, Gemini, DeepSeek ou totalmente local — a mais de 20 canais de mensagens, mais de 100 "skills" da comunidade, voz, um canvas ao vivo e apps mobile. Seu movimento característico é um *heartbeat* (batimento): a cada 30 minutos ele acorda, lê um `HEARTBEAT.md` e age por conta própria. Licença MIT; agora conduzido pela OpenClaw Foundation depois que seu criador, Peter Steinberger, entrou para a OpenAI em fevereiro de 2026.

**Hermes** — o agente auto-aperfeiçoável da Nous Research, em Python. Agnóstico a modelos ao extremo: qualquer endpoint compatível com OpenAI, e pode até reutilizar os tokens de assinatura da CLI do seu fornecedor. Ele cria e refina suas próprias skills a partir da experiência, modela você com um sistema de memória dialética (Honcho), roda um "code mode" que chama ferramentas via RPC e pode hibernar em backends serverless. Vem com uma TUI de terminal, integração de editor (ACP), ~28 canais e até ferramentas para gerar dados de treinamento. MIT.

**Nova** — um *time* de IA, não um chatbot: 24 especialistas nomeados e um conselho executivo, coordenados por decomposição de tarefas, em Bun/TypeScript. A escolha definidora é a **execução em duas fases** — ela prepara o trabalho seguro e então pede sua aprovação antes que qualquer coisa seja publicada, enviada ou gasta. Ela conduz suas *assinaturas* Claude/Gemini/Codex dentro dos termos delas (e agora também qualquer modelo compatível com OpenAI). Telegram, WhatsApp, Slack, Discord e seu terminal. MIT.

## Lado a lado

|  | OpenClaw | Hermes | Nova |
| --- | --- | --- | --- |
| Runtime | TypeScript / Node | Python | Bun / TypeScript |
| Licença | MIT | MIT | MIT |
| Estrelas no GitHub (jul 2026) | ~384k | ~218k | nova |
| Interface principal | Apps de chat | Terminal + chat | Apps de chat + terminal |
| Canais de mensagens | Mais de 20 | ~28 | 5 (TG / WA / Slack / Discord / CLI) |
| Modelos | Qualquer um, incl. local | Qualquer um, incl. reúso de token de assinatura | CLIs de assinatura + qualquer um compatível com OpenAI |
| Multiagente | Roteamento de sessão | Subagentes + code-mode | 24 especialistas + conselho executivo |
| Aprovação humana antes de agir | ✗ desativado por padrão | ✗ desativado por padrão | ✓ ativado por padrão |
| Proativo / autônomo | Heartbeat, a cada 30 min | Revisão em segundo plano + cron | Agendador + serviços (tarefas agendadas rodam sem supervisão) |
| Skills auto-aperfeiçoáveis | ✗ estáticas | ✓ criadas automaticamente | ✓ promove o que funciona |
| Superfície de execução padrão | host (sandbox opcional) | backends sandbox | Gate de aprovação; host por padrão, Docker opcional |
| Respaldo | Fundação (criador → OpenAI) | Laboratório Nous Research | Solo (Jake) |
| Maturidade | Testado em combate, enorme | Nível de pesquisa, ativo | Nova (2026) |

## Onde cada um se posiciona

Tire as listas de recursos e eles se alinham em dois eixos: **o quanto ele age sem você** e **o quanto ele é um único assistente versus um time inteiro**.

O único gráfico que importa: a Nova fica sozinha no lado do "pergunta primeiro" — de propósito.

## O bom, o mau e o feio

### OpenClaw

O ecossistema é incomparável — mais de 20 canais, mais de 100 skills, apps mobile, voz, uma UI de controle elegante. Se você quer um assistente sempre ativo no WhatsApp que simplesmente funciona e de fato faz coisas, nada mais é tão polido ou tão amplamente usado. E roda em literalmente qualquer modelo.

Por padrão, as ferramentas rodam **no seu host, de forma autônoma** — a sessão principal executa sem uma etapa de aprovação. Conveniente, mas é muita confiança para entregar a um sistema probabilístico com alcance ao seu shell, e-mail e mensagens. O sandboxing existe, mas é opcional para sessões que não sejam a principal.

Essa confiança já mordeu gente. Pesquisadores da Cisco documentaram skills de terceiros realizando **exfiltração de dados e injeção de prompt sem o conhecimento do usuário**, contra um registro de skills em grande parte não verificado. Em março de 2026, autoridades chinesas restringiram empresas estatais, agências e bancos de executá-lo por preocupações com exclusão e vazamento de dados. E no amplamente noticiado episódio "MoltMatch", um agente criou um perfil de namoro — supostamente usando fotos de uma pessoa real sem consentimento. Poder sem um gate corta dos dois lados.

### Hermes

O mais *interessante* dos três. Ele genuinamente aprende — bifurcando uma cópia de si mesmo em segundo plano para escrever e refinar skills após tarefas difíceis — constrói um modelo de você ao longo do tempo, e roda em literalmente qualquer endpoint, incluindo uma máquina serverless que custa quase nada quando ociosa. Para pesquisadores e entusiastas sérios, é um playground com profundidade real (até gerar dados de treinamento para modelos de chamada de ferramentas).

Ele é pesado. Arquivos centrais chegam às centenas de kilobytes; há uma grande superfície para entender e operar, e o loop de auto-aperfeiçoamento pode se alastrar se você não ficar de olho. E é Python — ótimo se essa é a sua stack, atrito se não é.

Para obter o preço de assinatura no Claude ou no Codex, a Hermes **reutiliza os tokens OAuth da CLI do fornecedor** para chamar os backends de assinatura diretamente do próprio processo. É engenhoso e economiza dinheiro — mas plausivelmente vai contra os termos dessas assinaturas, e quebra sempre que um fornecedor rotaciona a autenticação. Como a OpenClaw, sua postura padrão é autonomia ampla, não aprovação.

### Nova

A coisa toda é construída em torno de **não** confiar cegamente na IA. Execução em duas fases significa que nada é publicado, enviado ou gasto até você aprovar — com uma prévia legível do que está prestes a acontecer. Ela se lê como um organograma (24 especialistas mais um conselho executivo), conduz suas CLIs de assinatura *dentro dos termos delas* (sem jogos de token), e é uma base de código Bun/TypeScript coerente que você de fato consegue sentar e ler. E ela discretamente **aprende**: repita uma tarefa o suficiente e a Nova promove o plano vencedor a uma skill reutilizável, reatribui e se autocorrige em etapas que falharam no meio da execução, e acompanha quais especialistas têm bom desempenho.

Ela é novíssima e minúscula. Essencialmente zero estrelas, uma comunidade de aproximadamente uma pessoa, documentação mais rala, menos integrações, e nenhum dos testes de combate gratuitos que um projeto de 200k estrelas recebe. Menos canais que a OpenClaw. Se você quer um enorme marketplace de skills *hoje*, ele ainda não está aqui.

Seu aprendizado é conquistado, não instantâneo — a Nova promove uma skill somente após um punhado de execuções *bem-sucedidas*, então ela melhora por repetição em vez da reflexão em tempo real que a Hermes faz. O modelo de organograma tem uma curva de aprendizado e, embora pedidos simples sigam um caminho rápido (não o conselho inteiro), a postura padrão é mão na massa: o gate de aprovação mantém você no circuito, e você o afrouxa com piloto automático e autonomia conquistada conforme a confiança cresce. Se você quer um agente totalmente sem intervenção desde o primeiro minuto, essa cautela deliberada vai parecer atrito.

## Então, qual você deveria escolher?

- **OpenClaw** — se você quer o maior ecossistema e um assistente polido e sem intervenção nos seus apps de chat hoje, e está disposto a colocá-lo em sandbox e verificar as skills você mesmo.

- **Hermes** — se você é um pesquisador ou entusiasta sério que quer um agente agnóstico a modelos e auto-aperfeiçoável, e não se importa com o peso do Python ou a ressalva do reúso de token.

- **Nova** — se você quer um *time* de IA que pergunta antes de agir, permanece dentro dos termos da sua assinatura e mantém você no circuito por design — e consegue conviver com um projeto jovem.

Não há um vencedor universal aqui — apenas um vencedor para a *sua* tolerância a risco. OpenClaw e Hermes apostam que a autonomia vale a exposição. A Nova aposta o oposto: que o que fica entre um agente prestativo e um erro caro é um humano tocando em *aprovar*. Escolha a aposta com a qual você se sente confortável em fazer com seu shell, suas chaves e seus clientes.

Fontes e notas: contagens de estrelas da API do GitHub (julho de 2026); histórico, nome e problemas de segurança/regulatórios documentados da OpenClaw a partir da [Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) e de reportagens públicas; detalhes de Hermes e Nova de seus repositórios públicos. Os números mudam — trate-os como um retrato de julho de 2026.
