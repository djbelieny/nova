# Implantando Nova: um guia prático para auto-hospedagem

> Auto-hospede Nova em menos de 5 minutos. Do assistente de configuração até produção em um VPS, aqui está tudo que você precisa saber para rodar seu próprio time de IA na sua máquina, suas chaves, suas etapas de aprovação.

*Source: https://mynova.space/pt-br/blog/deployment/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

De um clone fresco até rodando na sua máquina ou VPS. Aprenda como inicializar Nova, configurá-la para seu provedor de IA e integrações, habilitar sandbox e configurar o conselho executivo — com etapas de aprovação que mantêm você no controle.

Jake Belieny · 15 de julho de 2026 · 10 min de leitura

Nova é projetado para ser auto-hospedado. Sua máquina, suas chaves de API, seus dados, suas etapas de aprovação. Este guia percorre cada passo: desde o primeiro `bash bootstrap.sh` até uma instância de produção rodando em um VPS, com recursos opcionais como execução em sandbox e um conselho executivo distribuído.

A maioria disso leva menos de cinco minutos. Os bits opcionais — sandbox, coordenação de conselho multi-VPS, governança avançada — você liga quando estiver pronto.

## O que você precisará

Antes de começar, junte estas peças:

#### Um computador ou servidor

macOS, Linux ou Windows via WSL2. O instalador configura todo o resto — o runtime Bun e a CLI do Claude Code são instalados para você automaticamente.

#### Uma conta Telegram

Nova se comunica via Telegram por padrão (WhatsApp e Slack também funcionam). Você pega um bot token de @BotFather.

#### Uma chave de provedor IA

Claude (recomendado), Gemini, Codex ou Groq. Comece com o que você já usa; Nova troca provedores baseado no tipo de tarefa.

#### Credenciais MCP (opcional)

Google Workspace, Notion, Cloudflare, etc. Cada uma adiciona uma ferramenta aos seus agentes. Você pode pular por enquanto e adicionar depois.

## O caminho rápido: `bash bootstrap.sh`

Nova vem com um instalador de um único comando e um assistente de configuração guiado que pergunta exatamente o que precisa e nada mais. Clone o repo, execute um comando, e pronto em cerca de 3 minutos:

**Início rápido** 
 `git clone https://github.com/djbelieny/nova.git`

 `cd nova`

 `bash bootstrap.sh`

O `bootstrap.sh` instala qualquer pré-requisito que esteja faltando (Bun, a CLI do Claude Code) e, em seguida, abre o assistente. Ele é retomável — feche-o e execute novamente para continuar — e `bash bootstrap.sh --check` relata o estado do seu sistema sem alterar nada. O assistente vai perguntar por:

- Um token de bot Telegram do @BotFather (siga os prompts)

- É tudo o que você digita para o Telegram — seu ID de usuário é **detectado automaticamente** quando você manda uma mensagem para o seu bot (sem a etapa do @userinfobot)

- Qual provedor IA você quer começar (Claude/Gemini/etc.)

- Sua chave de API para esse provedor

- Seu nome e timezone (para personalização)

Ele escreve um arquivo `.env` mínimo, cria `.mcp.json` do exemplo e verifica a conexão Telegram. Quando a Nova inicia, ela te cumprimenta no Telegram com ideias iniciais tocáveis — então sua primeira interação funciona sem precisar digitar. Execute `bun run doctor` a qualquer momento para uma verificação de saúde.

**É isso** Você agora tem uma instância Nova funcionando que entende requisições classificadas, roteia para o agente certo e pede aprovação antes que algo consequente aconteça.

## Configuração: conheça seus três arquivos

A configuração do Nova vive em três lugares. Você raramente precisa editá-los diretamente — `bun run init` cuida do básico — mas entendê-los ajuda quando você quer adicionar um recurso ou fazer debug.

### .env — Segredos e chaves de API

Nunca faça commit deste arquivo. Ele contém seu token de bot Telegram, chaves de provedor IA e qualquer credencial de terceiros. Comece com o exemplo:

**Variáveis essenciais** 
 TELEGRAM_BOT_TOKEN=seu_token_aqui

 TELEGRAM_USER_ID=seu_id

 ANTHROPIC_API_KEY=sk-ant-...

 USER_NAME=Jake

 USER_TIMEZONE=America/New_York

Variáveis opcionais habilitam recursos conforme você adiciona: `GROQ_API_KEY` para transcrição de voz, `GOOGLE_WORKSPACE_CREDS` para Gmail/Drive, `CLOUDFLARE_API_TOKEN` para workers, e assim por diante.

### config/profile.md — Quem você é

Um arquivo markdown descrevendo seu contexto. É carregado em cada mensagem para Nova entender seus objetivos, restrições e estilo de comunicação. Preencha uma vez:

**Exemplo profile.md** 
 # Seu Perfil

 

 Seu nome: Jake

 O que você faz: Rodar uma empresa SaaS

 Seus objetivos: 10x saída de conteúdo, crescer para 5k subscribers de newsletter

 Restrições: Tenho 4 horas por semana livres

 Timezone: America/New_York

### .mcp.json — Integrações e ferramentas

Especifica quais servidores MCP Nova pode conectar: Notion, Google Workspace, Playwright, Cloudflare, Square, GoHighLevel e 12 outros. O assistente init copia `mcp.example.json` e configura placeholders. Conforme você adiciona integrações, descomente as que usa e adicione credenciais.

## Rodando Nova: inicie, mantenha rodando

Uma vez configurado, inicie o bot:

**Desenvolvimento** 
 `bun run start`

Ele escuta mensagens Telegram. Ctrl+C para parar. Teste: envie uma mensagem ao seu bot no Telegram e espere a resposta.

Para produção — para que Nova rode no background e reinicie em crash — use o gerenciador de processos do seu OS:

### macOS: launchd

**Configure e habilite** 
 `bun run setup:launchd -- --service core`

Isto auto-gera um arquivo plist com os caminhos certos e carrega em launchd. Nova roda no background, inicia no boot e reinicia se falhar. Verifique status com `launchctl list | grep nova`.

### Linux/Windows: PM2

**Configure e habilite** 
 `bun run setup:services -- --service core`

Usa PM2 para gerenciamento de processos. Verifique com `npx pm2 status`.

## Execução em sandbox (0.2.0)

Quando agentes executam tarefas, eles rodam na memória da sua máquina por padrão. Sandbox é opcional mas poderoso: roda cada tarefa em um container Docker hardened — filesystem read-only exceto por um workspace por-tarefa, sem acesso às suas credenciais, chamadas de sistema limitadas.

Uma página maliciosa que tenta enganar um agente para exfiltrar dados não consegue escapar do sandbox. E Nova continua na sua assinatura: em vez de mudar para faturamento por-token, compartilha seu plano Claude/Gemini no sandbox.

Para habilitar sandbox:

**Opcional: habilitar sandbox** 
 `NOVA_SANDBOX_BACKEND=docker`

 Construir a imagem: `bun run sandbox:verify`

 Definir modo assinatura: `NOVA_SANDBOX_SHARE_AUTH=true`

É isso. Agentes agora rodam dentro de um container. Você pode ver os logs do container e ajustar isolamento conforme necessário.

## O conselho executivo (0.2.0)

Para questões estratégicas difíceis, Nova tem um conselho executivo opcional: CEO, CFO, CMO, CTO, COO, Chefe de Pesquisa e um Crítico. Cada um modela um jeito diferente de pensar. Eles se reúnem, dão análise independente, o Crítico faz uma pré-análise para surfaçar modos de falha, e Nova sintetiza opções com scores de confiança.

O conselho pode rodar em um VPS único ou distribuído em 7 máquinas separadas. Os 7 executivos coordenam através de um banco de dados Postgres compartilhado.

### Configuração de conselho single-VPS

Execute Postgres localmente e registre:

**Banco do conselho** 
 `bash deploy/board/setup.sh`

 Defina em .env: `BOARD_DB_URL=postgres://...seu-db-local...`

Depois inicie os serviços executivos:

**Habilitar executivos** 
 `bun run setup:launchd -- --service all`

Sete novos serviços launchd começam: `nova-exec-ceo`, `nova-exec-cfo` e assim por diante. Cada um pode receber DMs no Telegram (ou rodar autonomamente com rate limiting).

### Conselho multi-VPS (avançado)

Implante uma API PostgREST em um VPS e aponte cada nó executivo para ela. Cada executivo roda em um container separado com sua própria chave de provedor IA. Eles coordenam inteiramente através do banco de dados compartilhado. Isto é opcional e só vale a pena se você precisar que os executivos rodem independentemente e escalem.

## Governança: etapas de aprovação e autonomia conquistada

Fora da caixa, Nova sempre pergunta antes de publicar, enviar ou gastar. Você toca Aprovar/Revisar/Cancelar em botões inline do Telegram.

Conforme um agente constrói um histórico limpo, se gradua: primeiro para *notificar você depois*, depois para *completamente autônomo dentro de um limite de gasto*. Uma falha e volta a perguntar. Você gerencia níveis de autonomia de um dashboard:

**Dashboard de governança** 
 `GET /governance`

 Veja e ajuste níveis de autonomia por agente

 Defina orçamentos de gasto

 Revise o registro de auditoria

Cada ação é registrada: quem rodou o quê, ao que custo, se foi bem-sucedido. Você pode reverter qualquer decisão, ajustar níveis de confiança e ver um histórico completo.

## Checklist de segurança

Antes de confiar Nova com trabalho real:

**Antes de produção** 
 Nunca faça commit de .env ou .mcp.json com credenciais reais

 Defina TELEGRAM_USER_ID para que só você possa mensagear o bot

 Use um token de bot Telegram forte (se exposto, regenere de @BotFather)

 Se usar sandbox, verifique que a imagem Docker constrói e roda

 Teste o fluxo de aprovação numa tarefa baixo-risco primeiro

 Revise o registro de auditoria na primeira semana de uso

 Habilite limites de gasto em agentes que toquem APIs de faturamento

As etapas de aprovação, sandbox e rastros de auditoria do Nova são projetados para tornar consequências reversíveis. Mas a posição inicial é sempre "pergunte primeiro, depois execute" — você continua no controle.

## Próximo: execute, construa em cima

Você agora tem tudo que precisa para rodar Nova na sua máquina ou num VPS. Envie uma mensagem e veja funcionar. Ligue sandbox e o conselho executivo quando estiver pronto. Ajuste níveis de autonomia conforme confiar mais. Adicione integrações MCP conforme precisar.

Nova é licenciado MIT. Leia o código, faça fork, customize agentes, adicione suas próprias ferramentas. É seu time agora.
