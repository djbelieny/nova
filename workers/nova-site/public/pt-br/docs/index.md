# Documentação Nova

> Documentação completa da Nova: instalação, todas as variáveis de ambiente, canais, agentes, tags de memória, agendamento, integrações MCP, dashboard, voz, conselho executivo e resolução de problemas.

*Source: https://mynova.space/pt-br/docs/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Tudo que você precisa para instalar, configurar e executar seu time de IA auto-hospedado — do primeiro message no Telegram até um conselho executivo de sete nós.

## O que é Nova

Nova é uma plataforma de IA de código aberto e auto-hospedada. É um time de **24 agentes especialistas** mais uma **camada de automação** que roda o trabalho repetitivo em segundo plano — e ela funciona sobre as suas próprias assinaturas de modelo e a sua própria máquina. Quatro pilares:

| Pilar | O que significa |
| --- | --- |
| **Multi-agente** | Uma solicitação é classificada de forma barata, depois respondida, roteada para um especialista, ou decomposta em um plano ordenado por dependências rodado entre vários (um conselho executivo opcional de 7 papéis delibera sobre estratégia). |
| **Orientada a eventos** | Ela não fica só esperando uma mensagem. Um webhook, uma métrica, um evento de conector ou uma correspondência semântica pode disparar uma automação ou playbook; processos duráveis se estendem por dias. |
| **Seus modelos, sua máquina** | Ela dirige as CLIs dos fornecedores (Claude, Gemini, Codex) como subprocessos, então roda sobre assinaturas que você já paga — mais qualquer API compatível com OpenAI. O armazenamento é SQLite local; os embeddings e a base de conhecimento são locais. Suas chaves, seus dados. |
| **Confiança & governança** | Duas fases preparar → aprovar → executar controlam solicitações interativas; políticas, limites de gasto e permissões baseadas em papéis governam as autônomas. |

Tudo roda na sua máquina: **Bun + TypeScript**, SQLite local com busca vetorial, suas próprias contas de IA, e credenciais criptografadas em repouso com AES-256-GCM. Licença MIT — [código no GitHub](https://github.com/djbelieny/nova).

## Instalação

### Pré-requisitos

- Uma **conta Telegram** (para criar seu bot)

- macOS 13+ ou Ubuntu 22.04+ (Windows via WSL2); mínimo 2 GB RAM (4 GB recomendado)

É só isso para começar — o instalador cuida do resto. Ele instala automaticamente o **[Bun](https://bun.sh)** e a **CLI do [Claude Code](https://claude.ai/claude-code)** caso estejam faltando, então você não precisa configurá-los manualmente. Contas opcionais desbloqueiam mais: Gemini, Groq (transcrição de voz gratuita), Twilio (chamadas telefônicas), Perplexity (pesquisa na web), Meta, Notion, Google Workspace, e mais — tudo coberto em Configuração.

### Opção A — uma linha (recomendado)

Uma única linha clona o Nova em `~/nova`, instala qualquer pré-requisito que esteja faltando e, em seguida, abre um amigável **assistente de configuração**. O assistente conduz você pela conexão do Telegram e de um provedor de IA — sem editar arquivos — e pode até **detectar seu ID de usuário do Telegram automaticamente** (ele apenas pede que você mande uma mensagem para o seu bot). Ele é **retomável**: feche-o e execute novamente para continuar de onde parou.

```
$ curl -fsSL https://mynova.space/install | bash
```

Prefere cloná-lo você mesmo? É o mesmo que executar:

```
$ git clone https://github.com/djbelieny/nova && cd nova
$ bash bootstrap.sh      # instala os pré-requisitos e abre o assistente de configuração
```

Só quer verificar o que já está instalado? `bash bootstrap.sh --check` relata o estado do seu sistema e não altera nada.

### Opção B — configuração manual

```
$ git clone https://github.com/djbelieny/nova && cd nova
$ bun run setup           # install deps, create .env
$ vim .env                # bot token, user ID, encryption key
$ cp .mcp.example.json .mcp.json
$ cp config/profile.example.md config/profile.md
$ bun run test:telegram   # verify the bot connects
$ bun run test:sqlite     # verify the database
$ bun run start
```

O modelo de embedding local (all-MiniLM-L6-v2, ~23 MB) é baixado na primeira utilização. Quando a Nova inicia, ela envia uma mensagem de boas-vindas no Telegram com ideias iniciais que você pode tocar para executar — então sua primeira interação funciona sem precisar digitar nada. Execute `nova doctor` a qualquer momento para uma verificação de saúde, ou `nova update` para baixar a versão mais recente e reinstalar.

### Referência de comandos

O instalador coloca um comando `nova` no seu PATH — é a porta de entrada para o uso diário (`nova start`, `nova doctor`, `nova connect` e o resto). Os scripts `bun run <script>` subjacentes ainda funcionam se você preferir, e os scripts avançados (`test:*`, `setup:*`, `exec:*`) só são expostos através de `bun run`.

| Comando | O que faz |
| --- | --- |
| `bash bootstrap.sh` | Instala os pré-requisitos e abre o assistente de configuração (`--check` para uma simulação) |
| `nova init` | Executa o assistente de configuração por conta própria (retomável) |
| `nova doctor` | Verificação de saúde + diagnósticos copiáveis |
| `nova update` | Baixa a versão mais recente e reinstala as dependências |
| `nova start` | Inicia o relay (processo principal do bot) |
| `nova dev` | Inicia com recarga automática em mudanças de arquivo |
| `nova chat` | Converse com a Nova direto no seu terminal |
| `nova connect` | Conecta a uma Nova em execução (local ou remota) com visão ao vivo e aprovações embutidas |
| `nova dashboard` | Inicia o dashboard web na porta 3033 |
| `nova providers add` / `list` / `test` / `default` | Adiciona e gerencia modelos de IA (ver Provedores de IA) |
| `nova invite [member|admin]` | Gera um código de convite para adicionar um colega de equipe |
| `nova kb add` / `list` / `search` / `remove` / `reindex` | Alimenta e gerencia a base de conhecimento (ver Base de conhecimento) |
| `nova voice` | Inicia o servidor de chamada de voz Twilio |
| `nova setup` | Instala dependências, cria `.env` a partir do exemplo |
| `nova backup` | Arquiva `data/`, `config/`, e `.env` para `~/.nova/backups/` |
| `bun run test:telegram` / `test:sqlite` / `test:voice` | Verifica token Telegram, banco de dados e transcrição de voz |
| `bun run setup:verify` | Verificação de saúde de instalação completa |
| `bun run setup:launchd` / `setup:systemd` / `setup:services` | Configura serviços sempre ativos (macOS / Linux / PM2) |
| `bun run typecheck` / `bun run test` | Verificação TypeScript; executa o suite de testes contra um DB isolado |
| `bun run exec:ceo` … `exec:critic` | Inicia um nó de conselho executivo |

## Configuração

Todos os segredos ficam em `.env` (copiado de `.env.example`). Contexto pessoal fica em `config/profile.md`, carregado em cada prompt. Servidores MCP são declarados em `.mcp.json` (copiado de `.mcp.example.json`).

**`NOVA_ENCRYPTION_KEY`** — Nova não iniciará sem ele. Gere com `openssl rand -hex 32`. Criptografa tokens OAuth e credenciais armazenadas com AES-256-GCM.

### Núcleo

| Variável | Padrão | Propósito |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Obrigatório.** Do @BotFather |
| `TELEGRAM_USER_ID` | — | **Obrigatório.** Seu ID numérico, do @userinfobot |
| `NOVA_ENCRYPTION_KEY` | — | **Obrigatório.** Hex de 64 caracteres; criptografia de credenciais em repouso |
| `BOT_NAME` | `Nova` | O nome que seu assistente chama a si mesmo |
| `USER_NAME` | — | Seu primeiro nome (recomendado) |
| `USER_TIMEZONE` | `UTC` | Fuso horário IANA, ex. `America/New_York` |
| `CLAUDE_PATH` | `claude` | Caminho CLI Claude (auto-detectado se em PATH) |
| `RELAY_DIR` | `~/.nova` | Diretório de dados de relay (workspace, uploads, logs) |
| `PROJECT_DIR` | dir do repo | Diretório de trabalho entregue ao Claude |

### Canais

| Variável | Propósito |
| --- | --- |
| `WHATSAPP_WEBHOOK_URL` | URL pública para a qual Kapso posta webhooks WhatsApp (chave Kapso por usuário + ID do número de telefone são adicionados no dashboard) |
| `SLACK_BOT_TOKEN` | Token do bot Slack (`xoxb-…`), Socket Mode |
| `SLACK_APP_TOKEN` | Token de nível de app Slack (`xapp-…`) |
| `DISCORD_BOT_TOKEN` | Token do bot Discord — ativa o canal Discord |

### Provedores de IA & pesquisa

| Variável | Propósito |
| --- | --- |
| `GEMINI_API_KEY` | Ativa o provedor Gemini |
| `CODEX_PATH` | Caminho para CLI Codex (auto-detectado se em PATH) |
| `GROQ_API_KEY` | Transcrição de voz (tier gratuito em console.groq.com) |
| `PERPLEXITY_API_KEY` | Pesquisa na web: sonar-pro (ask), sonar-deep-research, sonar-reasoning-pro |

### Voz & telefone

| Variável | Padrão | Propósito |
| --- | --- | --- |
| `VOICE_PROVIDER` | `groq` | `groq` ou `local` (whisper.cpp) |
| `WHISPER_BINARY` / `WHISPER_MODEL_PATH` | `whisper-cpp` | Binário de transcrição local e arquivo de modelo |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | — | Chamadas telefônicas & SMS |
| `USER_PHONE` / `USER_PIN` | — | Seu número e um PIN privado para autenticação de chamada |
| `VOICE_SERVER_PORT` | `80` | Porta do servidor de voz (implantações de produção normalmente usam 8080 atrás de um proxy) |
| `VOICE_SERVER_URL` / `WEBHOOK_BASE_URL` | — | URLs públicas para as quais Twilio faz callbacks |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | George | Text-to-speech para respostas de voz |

### Dashboard, integrações & serviços

| Variável | Propósito |
| --- | --- |
| `DASHBOARD_USER` / `DASHBOARD_PASS` | Login do dashboard — **o dashboard permanece desabilitado até que `DASHBOARD_PASS` seja definido** |
| `DASHBOARD_PUBLIC_URL` | URL do dashboard público; usado como base de redirecionamento OAuth |
| `GOOGLE_CLIENT_ID/SECRET`, `NOTION_CLIENT_ID/SECRET`, `ZOOM_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET` | Apps OAuth que você cria; usuários conectam contas do dashboard |
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET` | API Meta Ads (formato de conta `act_XXXXX`) |
| `SQUARE_LOCATIONS` | Pares `Name (LOCATION_ID)` separados por vírgula que o assistente de voz pode mencionar |
| `HEYGEN_API_KEY` / `FAL_API_KEY` | Vídeo de avatar de IA / text-to-video |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TICKET_SUPPORT_FROM`, `TICKET_OPERATOR_USER_ID`, `TELEGRAM_ADMIN_ID`, `TICKET_DEPLOY_DRYRUN` | Pipeline de support-ticket (ver Tickets de suporte) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Banco de dados compartilhado do conselho executivo (ver Conselho executivo) |
| `MEMWRIGHT_URL` / `MEMWRIGHT_DATA_DIR` | Serviço de memória de longo prazo opcional (padrões `http://localhost:8765`, `./data/memwright`); Nova degrada elegantemente sem ele |
| `HEARTBEAT_*` | Controles de check-in proativo (ver Agendamento) |

### Seu perfil

`config/profile.md` é markdown de forma livre sobre você — papel, negócios, preferências, restrições — injetado em cada conversa. Comece com `config/profile.example.md`. É gitignored; nunca sai da sua máquina.

## Conectando canais

### Telegram (obrigatório)

1. Message **@BotFather** → `/newbot` → escolha um nome de exibição, depois um nome de usuário terminando em `bot`.

2. Copie o token (parecido com `7123…:AAH…`) para `TELEGRAM_BOT_TOKEN`.

3. Seu ID de usuário numérico é **detectado automaticamente** pelo assistente de configuração — ele apenas pede que você mande uma mensagem para o seu bot. (Se preferir, você ainda pode definir `TELEGRAM_USER_ID` manualmente a partir do **@userinfobot**.)

4. Verifique: `bun run test:telegram`.

### WhatsApp

WhatsApp funciona através de [Kapso](https://kapso.ai) (Meta Cloud API). Defina `WHATSAPP_WEBHOOK_URL` para uma URL pública que alcance o endpoint `POST /webhook/kapso` do relay, depois adicione a chave API Kapso de cada usuário e o ID do número de telefone na página WhatsApp do dashboard.

### Slack

1. Crie um app em api.slack.com/apps → *From scratch*.

2. Ative **Socket Mode**; crie um token de nível de app (`xapp-…`) → `SLACK_APP_TOKEN`.

3. Adicione scopes de bot `channels:history`, `chat:write`, `im:history`, `im:write`; instale no seu workspace.

4. Copie o token do bot (`xoxb-…`) → `SLACK_BOT_TOKEN`.

### Terminal

Converse com a Nova direto do seu shell com `nova chat` — o mesmo pipeline, classificação e etapas de aprovação de todos os outros canais, sem token de bot necessário. Para alcançar uma Nova que já está em execução (localmente ou no seu VPS), use `nova connect` (ver Conversando com Nova).

### Discord

Execute a Nova como um bot do Discord: crie um aplicativo em [discord.com/developers](https://discord.com/developers/applications), adicione um bot e defina `DISCORD_BOT_TOKEN`. O Discord usa o mesmo padrão de adaptador que o Telegram — as mensagens fluem pelo pipeline idêntico de duas fases e com etapas de aprovação.

## Conversando com Nova

Apenas escreva naturalmente. Cada mensagem passa por três camadas de classificação — uma heurística rápida para mensagens curtas, um cache de padrão de planos que funcionaram antes, e classificação LLM apenas para solicitações complexas genuinamente novas. Você também pode conduzir explicitamente:

- **Aborde um agente diretamente** pelo nome: `Pixel, create a week of Instagram content`.

- **Force um provedor**: prefixe com `/claude`, `/gemini`, ou `/codex`.

- **Mensagens de voz** são transcritas automaticamente (Groq ou Whisper local).

### De qualquer terminal — nova connect

Como a Nova roda sempre ativa, você pode entrar em uma instância em execução a partir de qualquer terminal — local ou seu VPS — com `nova connect --url https://your-nova`. Você tem uma visão ao vivo do que seus agentes estão fazendo e pode **aprovar, alterar ou cancelar** de forma embutida, direto do shell. Para uma conversa simples sem se conectar a uma instância remota, `nova chat` conversa com sua Nova local.

### Comandos

| Comando | O que faz |
| --- | --- |
| `/start` / `/help` | Boas-vindas amigáveis com ideias iniciais tocáveis, e ajuda em linguagem simples |
| `/team` | Conheça seus 24 especialistas, agrupados pelo que você quer realizar |
| `/examples` | Ideias iniciais que você pode tocar para executar agora mesmo |
| `/agents` | Navegue todos os 24 agentes com botões "Use" de um toque |
| `/memory` / `/goals` / `/tasks` | Mostrar fatos armazenados, objetivos e tarefas de agentes |
| `/knowledge` / `/kb` | Lista os documentos da sua base de conhecimento, agrupados por escopo |
| `/schedule`, `/schedule list` | Gerenciar tarefas agendadas |
| `/usage` | Resumo de custo e uso |
| `/board <question>` | Convocar o conselho executivo (se configurado) |
| `/voice` | Configurações de voz |
| `/feedback good|bad` (ou 👍/👎) | Avalie a última resposta — alimenta aprendizado de padrão |
| `/settings autopilot <category> [limit_usd]` | Auto-aprovar uma categoria, opcionalmente limitado: `social_post`, `email`, `ad_spend`, `code_deploy`, `seo`, `research`, `general`, `*` |
| `/settings access @user <level>` | Visibilidade por usuário: `none`, `tasks-only`, `tasks+goals`, `full-summary` |
| `/settings role <job_role>` | Diga à Nova seu papel para melhor contexto |
| `/codebase add <name> <git-url>` / `list` / `remove` | Registrar repos para tarefas dev |
| `/devtask <description>` | Enfileirar uma tarefa de codificação de fundo em um repo registrado |

### Comandos de admin

Usuários com o papel `admin` também obtêm `/adduser`, `/removeuser`, `/listusers`, `/share <fact>` (memória compartilhada), `/status`, `/reload`, `/revert`, `/schedules`, `/budget`, `/project`, `/webhook`, `/zoom`, e `/reputation`.

### Adicionando colegas de equipe — códigos de convite

Você não precisa mais procurar um ID de usuário numérico para adicionar alguém. Execute `nova invite` (`nova invite member` ou `nova invite admin` para definir o papel) para gerar um código de convite, entregue-o à pessoa, e ela o resgata no **Telegram ou Discord** — você aprova o pareamento com um toque. Convites também podem ser gerenciados a partir do dashboard.

## Os 24 agentes

Cada agente é um arquivo markdown em `.claude/agents/` — YAML frontmatter (nome, descrição) mais um prompt de sistema. O roteador escolhe agentes durante a decomposição, ou você aborda um pelo nome.

**Helios** · anúncios pagos**Pixel** · mídia social**Kai** · conteúdo**Orion** · email**Morpheus** · vídeo**Architect** · web dev**Athena** · estratégia**Digit** · análise**Echo** · suporte**Flux** · funnels**Quill** · grants**Lex** · legal**Helia** · PR**Bridge** · parcerias**Oracle** · tendências**Cipher** · ciência de dados**Rift** · segurança**Joule** · automação**Nexus** · comunidade**Aura** · voz de marca**Zen** · produtividade**Tesseract** · sistemas**Magnus** · SEO**Cyra** · otimização de site

### Adicionando o seu próprio

Crie `.claude/agents/yourname.md` com frontmatter e um prompt de sistema, mapeie suas tools e skills em `src/agent-router.ts`, e ele se junta ao elenco. PDFs de base de conhecimento de agente podem ser colocados em `agent-team/knowledge_bases/` (opcional).

## Skills

45 skills reutilizáveis vivem em `.claude/skills/` — agentes os invocam conforme necessário. Destaques: criação de documentos (`docx`, `xlsx`, `pptx`, `pdf`), `image-gen`, `canvas-design`, `ai-video-creator`, `content-research-writer`, `ghostwriter` (pipeline de livro completo), `social-media-manager`, `email-marketing`, `meta-ads-manager`, `competitive-ads-extractor`, `lead-research-assistant`, `customer-support`, `reviews-testimonials`, `platform-maker` (gerador SaaS), `ui-ux-pro-max`, `file-organizer`, `telegram-file-sender`, `notebooklm`, `skill-creator`, mais suites para Google Workspace (`gws-*`: Gmail, Calendar, Drive, Docs, Sheets), GoHighLevel (`ghl-*`: contacts, marketing, billing, content, admin), e Cloudflare (`cloudflare-dns`, `cloudflare-workers`).

Para adicionar um, use a skill `skill-creator` ou escreva um `SKILL.md` manualmente em um novo diretório — mantenha genérico, com credenciais referenciadas de `.env`.

## Memória & tags de intenção

Nova lembra fatos, objetivos e tarefas em SQLite local com busca vetorial — recuperados semanticamente e injetados no contexto (até 50 fatos/objetivos, 12 mensagens recentes, 5 correspondências semânticas, 20 tarefas). O modelo gerencia memória através de tags de intenção em suas respostas; Nova as analisa, age, e as remove antes de você ver a resposta. Você pode acioná-las naturalmente ("lembre-se que…", "defina um objetivo para…").

```
[REMEMBER: fact]                      save a fact (with embedding)
[SHARE: fact]                         fact visible to all users
[GOAL: text | DEADLINE: date]         save a goal
[DONE: search text]                   complete a matching goal
[TASK: agent | description]           create an agent task
[TASK_START|TASK_DONE|TASK_BLOCKED|TASK_CANCEL: …]
[SCHEDULE: title | datetime | instructions]
[SCHEDULE: … | RECUR: rule]           recurring
[SCHEDULE: … | RECUR: rule | IF: condition]
[SCHEDULE_CANCEL: search text]
[DEVTASK: project | description]      queue a background dev task
```

### DSL de recorrência

`daily:HH:MM` · `weekly:DAY:HH:MM` (0=Sunday) · `weekdays:HH:MM` · `interval:SECONDS`

## Base de conhecimento

Enquanto a memória guarda o que a Nova *aprende*, a base de conhecimento guarda o que você *já tem*. Alimente-a com um documento, arquivo ou URL e a Nova o ingere — extraindo o texto (PDF, DOCX, Markdown, texto simples ou uma página web), dividindo-o em passagens sobrepostas e transformando cada uma em um vetor com um modelo que roda **na sua própria máquina** (all-MiniLM, o mesmo embedder local usado pela memória). Nada é enviado a uma API de embedding de terceiros. Quando você faz uma pergunta, a Nova traz as passagens mais próximas para a resposta e **cita o documento de origem**.

### Três escopos

| Escopo | Quem vê | Bom para |
| --- | --- | --- |
| `personal` | Só você (armazenado no seu próprio banco de dados por usuário) | Suas notas, rascunhos, pesquisa privada |
| `team` | Todos na sua Nova (banco de dados compartilhado) | Manual, guia de marca, preços — verdade compartilhada |
| `agent` | O pacote de um especialista, mais os documentos pessoais + de equipe daquele usuário | Contratos para Lex, voz de marca para Aura, docs de API para Architect |

Um agente recupera dos seus documentos *pessoais*, da base de *equipe* *e* do seu próprio pacote — nunca do pacote de outro agente. Passagens pessoais + de equipe também são injetadas automaticamente em conversas comuns, então a recuperação é natural.

### Quatro formas de alimentá-la

- **Solte um arquivo no Telegram** — envie um documento com uma legenda como `add to knowledge`, `add to team knowledge` ou `for Lex's pack`, e ele é ingerido com aquele escopo na hora.

- **Dashboard** — o dashboard web tem um painel **Knowledge**: arraste arquivos, defina o escopo de cada um, pesquise e apague.

- **O comando `nova kb`** — gerencie todo o ciclo de vida a partir de um terminal (abaixo).

- **Uma pasta monitorada** — qualquer coisa solta em `~/.nova/knowledge/` é ingerida automaticamente; as subpastas definem o escopo (`team/`, `agents/<slug>/`). Apague um arquivo e suas passagens saem da base. Desative com `NOVA_KB_WATCH=false`.

### O comando nova kb

```
nova kb add report.pdf --scope team          adiciona um arquivo à base de equipe
nova kb add https://example.com/spec --agent architect
nova kb add notes.md                          padrão é o escopo personal
nova kb list                                  lista os docs, agrupados por escopo
nova kb search "refund window"                busca nos escopos visíveis
nova kb remove <id> --scope team
nova kb reindex --all                         re-embeda após edições
```

No chat, `/knowledge` (ou `/kb`) lista tudo o que a Nova sabe no momento, agrupado por escopo.

As passagens recuperadas passam por **varredura contra injeção** antes de chegarem a um prompt — um documento que tente contrabandear instruções é descartado. Seus arquivos são tratados como dados, nunca como comandos. Reingerir um arquivo editado substitui a versão antiga no lugar (sem duplicatas), e os embeddings nunca saem da sua máquina.

## Playbooks

Um playbook é um **POP** (procedimento operacional padrão) reutilizável — um processo de negócio que você escreve uma vez e executa muitas vezes com entradas diferentes. Cada um tem variáveis e passos ordenados (qual agente faz o quê, em qual fase); executá-lo renderiza esses passos em um plano e o executa pelo fluxo normal de duas fases. Diferente dos padrões que a Nova aprende sozinha: playbooks são intencionais, editáveis e compartilháveis.

Escopos: `personal` (seus) ou `team` (compartilhados). Carregue uma biblioteca inicial — onboarding de cliente, tratamento de reembolso, lançamento de conteúdo, relatório semanal, follow-up de lead — com um único comando.

```
/playbook seed                         carrega os POPs iniciais
/playbook run client-onboarding client=Acme email=a@b.com
nova playbook list | show <name> | remove <name>
```

Crie e edite playbooks no painel **Playbooks** do dashboard; execute-os pelo chat, ou conecte um a uma automação (abaixo). As variáveis passam por varredura contra injeção; edições incrementam uma versão.

## Automações — evento → condição → workflow

Automações tornam a Nova **orientada a eventos**: quando algo acontece, execute um workflow. Cada uma tem uma origem (um webhook de entrada, uma sonda de métrica ou um evento de conector como `stripe.payment`), condições opcionais e uma ação — uma tarefa de agente ou um playbook. Cada disparo ainda passa pelo portão de aprovação, a menos que você tenha concedido piloto automático.

| Peça | O que faz |
| --- | --- |
| Condições | `field:op:value` — operadores `eq/neq/gt/lt/gte/lte/contains/exists`; todas devem passar. Além de **semântica** (abaixo). |
| Deduplicação | Ignora repetições dentro de uma hora por uma chave modelada (ex.: `{{contact.email}}`). |
| Limite de taxa | Limita os disparos por hora. |
| Ação | `--agent <slug> --template "…{{event.field}}…"` ou `--playbook <name> --var k={{…}}`. |

```
nova automation add new-lead --playbook lead-follow-up --var lead={{contact.name}} \
    --when amount:gt:1000 --dedupe {{contact.email}} --rate 10
nova automation url new-lead      o endpoint POST assinado para dar à sua origem
/automations                      liste-as no chat
```

Eventos de entrada chegam em `POST /automation/:userId/:id` (verificado por HMAC). O texto renderizado do evento passa por varredura contra injeção. Projete e teste automações a seco no painel **Automations** do dashboard.

### Gatilhos semânticos

Além de correspondências exatas, uma condição pode disparar por *significado*: `body:semantic:a customer complaint:0.55` dispara quando o campo do evento é semanticamente similar à frase (embeddings locais, limiar opcional). Ótimo para "quando um e-mail parece uma reclamação / um cancelamento / uma oportunidade de upsell."

## Processos duradouros

Alguns trabalhos se estendem por dias e dependem de eventos externos: *enviar contrato → aguardar assinatura → faturar → aguardar pagamento → entregar.* Um processo duradouro é uma sequência de passos de **ação** e **espera** que sobrevive a reinicializações (estado no SQLite) e retoma por um temporizador vencido ou um evento nomeado. Os passos de ação rodam como tarefas normais (os consequentes passam pelo portão).

```
nova process start onboarding --from-playbook client-onboarding
nova process list | show <id> | cancel <id>
/process signal signature.done         retoma processos aguardando esse evento
```

Os temporizadores retomam automaticamente via o despachante de tarefas; os eventos retomam via um sinal (um comando de chat ou uma automação). Crie as sequências de passos (com `wait|until|+2d` ou `wait|event|<name>`) na linha do tempo **Processes** do dashboard.

## Extração de documentos

A contraparte de captura da base de conhecimento: defina um esquema de campos e extraia **JSON estruturado e com tipos coeridos** de PDFs, DOCX ou texto — faturas, recibos, formulários, contratos. Os valores são coeridos (número/data/booleano/array), os campos obrigatórios são validados e as linhas são exportáveis para CSV.

```
nova extract schema add invoice --field invoice_number:string:required \
    --field total:number:required --field due_date:date
nova extract statement.pdf --schema invoice
nova extract list --schema invoice | nova extract export invoice
```

No chat, envie um documento com uma legenda como *"extract as invoice"*. Gerencie esquemas, execute extrações e exporte pelo painel **Extraction** do dashboard. A extração roda localmente sobre o seu texto; os destinos (Sheets/CRM) passam pelos conectores.

## Políticas & conformidade

Governança de negócios sobre a escada de autonomia conquistada. As políticas são **apenas restritivas**: elas adicionam atrito (exigir aprovação, bloquear ou avisar), mas nunca concedem mais autonomia do que a escada já permite. Sem nenhuma definida, o comportamento é exatamente como antes.

| Tipo | Efeito |
| --- | --- |
| `spend_cap` | Um orçamento diário/mensal verificado contra o livro-razão de ações — ao ultrapassá-lo, força a aprovação. |
| `approval_matrix` | Encaminha certas ações a aprovadores nomeados, com um tempo limite de escalonamento. |
| `content_check` | Varre a saída preparada em busca de PII / palavrões. `warn` sinaliza; `block` é um verdadeiro **bloqueio absoluto** — ele impede a execução no limite de execução mesmo depois que um humano aprova (verificado contra o conteúdo preparado), então nada é enviado. |

```
nova policy add spend-cap --cap 500 --period month --department marketing
nova policy add approval --action email.send --approver <userId> --escalate 30
nova policy add content-check --checks pii,profanity --on-fail block
/policies
```

Gerencie tudo no editor **Policies** do dashboard. As políticas são avaliadas no portão, logo antes de Aprovar/Revisar/Cancelar.

## ROI & relatórios

Torna o valor da automação legível. Os agentes quantificam resultados com uma tag `[VALUE: $X | SAVED: Ymin | DEPT: z]`; a Nova a registra e a consolida contra o livro-razão de ações em **tarefas automatizadas, horas economizadas e $ influenciados vs. custo** — por departamento e agente.

```
/roi                 últimos 7 dias, no chat
nova roi --period 30 | nova roi --by-agent | nova roi --by-department
```

A visão **ROI** do dashboard mostra tiles de destaque + gráficos; um resumo semanal envia por DM a cada usuário o valor entregue. O ranking de valor por agente/departamento pode indicar onde vale a pena investir mais.

## Conectores

Uma camada fina e uniforme sobre sistemas de negócio externos. Os nativos vêm bidirecionais: **Stripe** (cobranças/clientes/reembolsos), **Shopify** (pedidos), **Zendesk** (tickets), **HubSpot** (contatos). Cada um tem ações de leitura + escrita e um gatilho de sondagem que alimenta automações (ex.: `stripe.payment`). As credenciais vêm de variáveis de ambiente ou do repositório de credenciais compartilhado; as ações de escrita são consequentes.

```
nova connector list                    nativos + status configurado
nova connector describe stripe         suas ações + parâmetros (descoberta)
nova connector run stripe list_charges --input '{"limit":5}'
nova connector set stripe STRIPE_API_KEY=sk_live_…   armazenado criptografado em repouso
```

Configure e execute ações pelo painel **Connectors** do dashboard. Adicionar um conector é um único arquivo que implementa a interface `Connector`. Os próprios agentes chamam conectores da mesma forma que usam ferramentas MCP sob o **mcp2cli** — descobrem sob demanda (`describe`) e então chamam — de modo que o prompt do agente permanece enxuto por mais conectores que existam (veja Operar & observar).

## Operar & observar

Tudo o que a camada de automação faz é observável e recuperável.

- **Feed de atividades** — uma linha do tempo unificada de cada disparo de automação, transição de processo e execução de playbook. `nova activity`, `/activity`, ou a página **Activity** do dashboard.

- **Teste a seco** — pré-visualize exatamente o que uma automação faria contra um evento de amostra antes de habilitá-la (`nova automation simulate <name> --event '{…}'`, ou o controle "Test / dry-run" no dashboard). Não executa nada.

- **Novas tentativas & dead-letter** — um despacho que falha é repetido com backoff; se ainda assim falhar, ele vai para uma fila dead-letter em vez de desaparecer. `nova dlq list | retry <id> | drop <id>`, ou a página **Dead letters** do dashboard.

### Os agentes podem usar suas ferramentas

Os agentes especialistas chamam as capacidades da Nova por conta própria enquanto trabalham — pesquisar a base de conhecimento, extrair um documento, consultar uma fonte de dados, executar um conector configurado ou rodar um playbook — através da CLI `nova` em seu ambiente de execução. Seguindo o padrão **mcp2cli**, eles *descobrem* ferramentas sob demanda (ex.: `nova connector describe <id>`) em vez de carregar todo esquema no prompt, usam ações de leitura livremente e **propõem ações de escrita/consequentes para aprovação** em vez de executá-las diretamente.

## Dados conectados

Registre as fontes onde os dados do seu negócio realmente vivem e consulte-as — para relatórios, para automações ou para um agente no meio de uma tarefa. Somente leitura por design.

| Tipo | Lê de |
| --- | --- |
| `http` | Um endpoint JSON ou CSV (aponte `rowsPath` para o array no corpo JSON). |
| `sqlite` | Um `SELECT` somente leitura contra um arquivo SQLite — análises, exportações, um data warehouse local. |
| `connector` | Uma ação de *leitura* de conector (Stripe, Shopify, …) — ações de escrita são recusadas. |

```
nova data add sales --kind http --url https://api/report.json --rows-path data
nova data add wh --kind sqlite --path /data/warehouse.db --query "SELECT day, revenue FROM metrics"
nova data query sales        colunas + linhas
/data query sales            ou pelo chat
```

Gerencie fontes e execute consultas no painel **Data** do dashboard. Combine uma fonte com o agendador ou um playbook para relatórios recorrentes. Zero dependências extras.

## Governança & hardening

Controles de nível de produção para rodar a Nova sem supervisão e para uma equipe. Todos aditivos — sem nada configurado, o comportamento é exatamente como antes.

### Papéis & permissões

Os administradores podem fazer tudo. Os membros recebem **capacidades** restritas — `automation.manage`, `policy.manage`, `connector.manage`, `playbook.manage`, `process.manage`, `access.manage` — que controlam quem pode criar ou alterar cada área governada (aplicadas nas ações de escrita do dashboard).

```
nova access grant @teammate automation.manage
nova access list @teammate
/access @teammate grant policy.manage
```

### Delegação de ausência

Vai se ausentar? Delegue seu trabalho para que atribuições e aprovações sejam encaminhadas a um colega (uma cadeia protegida contra ciclos) até você voltar.

```
nova ooo set @teammate "on vacation" --until 2026-08-01
/ooo @teammate   ·   /ooo off
```

### Idempotência, travas & segredos

- **Exatamente uma vez.** Uma automação pode optar por idempotência durável (`--idempotent`) para que um webhook reentregue dispare uma vez — não de novo uma hora depois.

- **Sem disparo duplo.** Travas de aviso envolvem o poller de automações e o despachante de tarefas, então ticks sobrepostos ou múltiplas instâncias nunca processam o mesmo trabalho duas vezes.

- **Segredos criptografados.** As credenciais de conectores são armazenadas criptografadas com AES-256-GCM em repouso (defina `NOVA_ENCRYPTION_KEY`) via `nova connector set`, com uma auditoria de rotação — nenhuma chave em texto puro no `.env`.

Gerencie capacidades, delegação e segredos de conectores no painel **Governance Admin** do dashboard.

## Agendamento & serviços proativos

Além de agendamentos únicos, Nova fornece serviços de fundo que funcionam enquanto você não (os tempos abaixo são os padrões cron, UTC):

| Serviço | Agendamento | O que faz |
| --- | --- | --- |
| Despachador de tarefas | a cada 60s | Executa tarefas agendadas vencidas |
| Briefing matinal | diário | Resumo do dia: calendário, objetivos, tarefas, notícias |
| Check-in inteligente | vários/dia | Toques cientes de contexto, limitados por limites de heartbeat |
| Monitor de notícias de IA | 3×/dia | Notícias de IA/tech curadas |
| Sugestor de posts sociais | diário | Ideias de posts do seu contexto |
| Sugestor de leads | diário | Ideias de leads de negócio |
| Relatório de anúncios Meta | diário | Resumo de desempenho de anúncios |
| Revisão de memória | diário | Deduplicação e curação de memória |
| Monitor de saúde | a cada 30 min | Pesquisa `/health`; envia DM após 3 falhas consecutivas |
| Monitor de log / Modo de sonho | periódico | Triagem de erro / reflexão em tempo ocioso |

### Controles de heartbeat

`HEARTBEAT_ENABLED=true` · `HEARTBEAT_INTERVAL_MIN=30` · `HEARTBEAT_MAX_DAILY=3` (mensagens proativas por usuário por dia) · `HEARTBEAT_ACTIVE_HOURS=8-22` (seu fuso horário). Esvaziar `config/heartbeat.md` desabilita check-ins proativos inteiramente.

## Provedores de IA & roteamento

Nova dirige IA através de CLIs que você já autenticou — sem chaves de API brutos necessários para Claude. Precedência de roteamento: **force prefix → preferência do usuário → dica de tarefa → dependência MCP → fallback de limite de taxa**.

| Provedor | Via | Camadas |
| --- | --- | --- |
| Claude | `claude` CLI | fast=Haiku · standard=Sonnet · premium=Opus |
| Gemini | `gemini` CLI | fast=Flash · standard=Pro · premium=Ultra |
| Codex | `codex` CLI | standard |
| Groq | API | Transcrição de voz Whisper |

### Adicionando qualquer modelo compatível com OpenAI

Além das CLIs de assinatura, você pode adicionar **qualquer modelo compatível com OpenAI** — uma rota do OpenRouter, um modelo da OpenAI, ou um endpoint local `Ollama` / `vLLM`. Adicione um com `nova providers add` (ou o painel **Models** do dashboard); gerencie o resto com `nova providers list`, `nova providers test`, e `nova providers default`. As definições ficam em `config/providers.json`, e cada modelo usa sua própria chave de API. As CLIs de assinatura continuam sendo o padrão — modelos adicionados se encaixam ao lado delas e podem conduzir as mesmas ferramentas MCP e conectores.

## Integrações MCP

Copie `.mcp.example.json` para `.mcp.json`. Cada servidor roda sob demanda via `npx`; credenciais vêm de `.env` ou armazenamento por usuário (criptografado, gerenciado no dashboard — `src/integrations.ts` gera a configuração MCP de cada usuário).

| Servidor | Propósito | Credenciais |
| --- | --- | --- |
| `notion` | Docs, bancos de dados, páginas | OAuth via dashboard (ou `NOTION_MCP_HEADERS`) |
| `google-workspace` | Gmail, Calendar, Drive, Docs, Sheets | OAuth via dashboard (`GOOGLE_CLIENT_*`) |
| `playwright` | Automação de navegador, scraping, screenshots | nenhum |
| `cloudflare` | Workers, DNS, edge | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `zoom` | Reuniões | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_*` |
| `square` | POS, dados de vendas | `SQUARE_ACCESS_TOKEN` |
| `clickup` | Gerenciamento de tarefas | `CLICKUP_API_TOKEN` |
| `gohighlevel` | CRM, campanhas, publicação | `GHL_BEARER_TOKEN` |
| `firecrawl` | Web scraping | `FIRECRAWL_API_KEY` |
| `tavily` / `exa` | Busca na web / busca semântica | `TAVILY_API_KEY` / `EXA_API_KEY` |
| `browserbase` | Sessões de navegador na nuvem | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` |

MCPs baseados em serviço em `services/` adicionam YouTube, TikTok, Zoom e publicação em redes sociais Meta. O servidor opcional `memwright` fornece memória vetorial de longo prazo (porta 8765).

### mcp2cli — ferramentas sem o imposto de contexto

Carregar o esquema JSON de cada ferramenta MCP no prompt de um agente é caro — centenas de definições de ferramentas podem dominar a janela de contexto. Em vez disso, a Nova expõe os servidores MCP através do **mcp2cli**: os agentes recebem uma instrução curta para *descobrir* as ferramentas sob demanda a partir do shell — `mcp2cli … --list` para ver as ferramentas de um servidor, depois `--tool <name> --param k=v` para chamar uma — de modo que apenas as ferramentas realmente usadas custam contexto. O mesmo idioma de descoberta-primeiro se aplica às próprias capacidades da Nova (`nova connector describe <id>`, `nova kb search`, …), então o conjunto de ferramentas de um agente pode crescer sem inchar o prompt.

## Dashboard web

Uma superfície completa de admin e por usuário na **porta 3033**: defina `DASHBOARD_PASS` (e opcionalmente `DASHBOARD_USER`, padrão `admin`), depois `bun run dashboard` e abra `http://localhost:3033`. Sessões são baseadas em cookie com rate limiting; usuários não-admin só veem seus próprios dados.

- **Dashboard & Kanban** — atividade ao vivo, quadro de tarefas, status de agente

- **Aprovações** — resolver etapas de aprovação pendentes do navegador

- **Integrações** — conecte Google, Notion, Zoom, TikTok via OAuth (callback: `http://localhost:3033/auth/<provider>/callback`, ou seu `DASHBOARD_PUBLIC_URL`)

- **Memória, Histórico, Agendamentos, Skills** — inspecione e edite o que Nova sabe e executa

- **Tickets, WhatsApp, Credenciais compartilhadas, Saúde, Custos** — páginas de operações

## Voz

### Mensagens de voz (transcrição)

**Groq** (recomendado, tier gratuito ~2000/dia): `VOICE_PROVIDER=groq` + `GROQ_API_KEY`. **Local**: instale ffmpeg + whisper.cpp, baixe `ggml-base.en.bin` (~142 MB) para `~/whisper-models/`, defina `VOICE_PROVIDER=local`. Verifique com `bun run test:voice`.

### Chamadas telefônicas (Twilio)

Execute `bun run voice` para iniciar o servidor de chamadas (porta padrão 80; produção normalmente 8080 atrás de um proxy reverso). Configure as variáveis de ambiente Twilio mais `USER_PIN` — chamadores autenticam por PIN, conversam com Nova, e solicitações acionáveis são extraídas da transcrição e executadas após a chamada. As respostas usam ElevenLabs TTS quando configurado. Webhooks são verificados por HMAC; endpoints: `/voice/*`, `/sms/*`, `/audio/*`, `/health`.

## Tickets de suporte

Um pipeline orientado por email: email de suporte de entrada (via webhooks [Resend](https://resend.com), assinatura verificada) torna-se um ticket → triagem → um agente rascunha uma correção no repo do cliente correspondente → você aprova do Telegram → implanta. Configure `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TICKET_SUPPORT_FROM`, `TICKET_OPERATOR_USER_ID`, e `TELEGRAM_ADMIN_ID`; o worker (`bun run ticket-worker`) pesquisa a cada 60 segundos. `TICKET_DEPLOY_DRYRUN=true` (o padrão) mantém implantações simuladas até que você a ative.

## Conselho executivo

Uma camada opcional de múltiplos nós: sete papéis executivos — CEO, CFO, CMO, CTO, COO, Pesquisa, Crítico — cada um um processo com uma persona de raciocínio distinta e seu próprio provedor de IA, coordenando através de um banco de dados Postgres compartilhado via PostgREST. Pergunte `/board should we switch to usage-based pricing?` e você obtém análises independentes, uma pré-mortem adversarial do Crítico, e 3–5 opções sintetizadas com pontuações de confiança. Escolha uma; a decisão é registrada e o COO despacha a execução.

### Configuração

1. Suba o banco de dados compartilhado — **Postgres + PostgREST auto-hospedado** (`bun run migrate:board`, veja `deploy/board/`), ou um projeto Supabase se preferir um hospedado.

2. Defina `BOARD_DB_URL` e `BOARD_DB_KEY` em `.env` (os nomes `SUPABASE_*` ainda funcionam como aliases). As tabelas do conselho usam segurança em nível de linha sem acesso anônimo — a chave deve viver apenas em servidores confiáveis.

3. Crie `.env.<role>` por nó (`EXEC_ROLE`, `EXEC_NODE_ID`, um token de bot, `EXEC_AI_PROVIDER` opcional).

4. Inicie os papéis: `bun run exec:ceo`, `exec:cfo`, … `exec:critic`. São apenas processos — rode todos os sete em um único host, ou distribua-os por várias máquinas (unidades systemd `nova-exec-<role>`). Hosts separados com chaves de IA separadas são uma recomendação para limites de taxa, não uma exigência.

Executivos usam suas próprias tags de intenção: `[DELEGATE: agent | task]` (opcionalmente `| PROVIDER: claude`), `[BRIEF: role|all | summary]`, e `[DECISION: question | chosen | rationale | CONFIDENCE: 0.8]`.

## Rodando sempre ativo

### macOS — launchd

```
$ bun run setup:launchd -- --service core   # just the relay
$ bun run setup:launchd -- --service all    # relay + dashboard + proactive services
$ launchctl list | grep com.nova            # verify
$ bun run setup:logrotate                   # daily log rotation
```

Serviços instalam como `~/Library/LaunchAgents/com.nova.*.plist`; serviços individuais: `core`, `dashboard`, `memwright`, `checkin`, `briefing`, `memory-review`, `dispatcher`, `health-monitor`, `voice`.

### Linux — systemd

```
$ sudo bun run setup:systemd --service all
$ systemctl enable --now nova-relay nova-dashboard
$ journalctl -u nova-relay -f               # logs
```

### Windows / qualquer lugar — PM2

```
$ bun run setup:services -- --service all
$ npx pm2 status
```

Para exposição pública (webhooks, dashboard, voz), coloque Caddy ou outro proxy reverso na frente — veja `DEPLOY.md` no repositório para um passo a passo de produção.

## Banco de dados & backups

SQLite dividido com `sqlite-vec` para busca vetorial. Embeddings são computados localmente (all-MiniLM-L6-v2, 384 dimensões) — nada sai da sua máquina.

```
data/shared.db       # users, status, logs, cost tracking, shared memory
data/users/{id}.db   # per-user: messages, memory, tasks, approvals, schedules, patterns
data/memwright/      # optional long-term memory service store
```

**Backups:** `bun run backup` arquiva `data/`, `config/`, e `.env` para `~/.nova/backups/` (últimos 7 mantidos; agendados diariamente quando serviços estão instalados). Para restaurar: pare os serviços, extraia o arquivo, copie os três caminhos de volta, reinicie.

## Modelo de segurança

- **Etapas de aprovação** separam ações consequentes de ações seguras, por categoria e por usuário — **a fronteira de segurança padrão** (veja a ressalva abaixo).

- **Sandbox é opcional.** Por padrão, as ferramentas dos agentes rodam **sem sandbox no seu host**. Existe um sandbox Docker reforçado (`NOVA_SANDBOX_BACKEND=docker`: FS somente leitura, capabilities removidas, sem rede, montagem apenas do workspace), mas ele fica desligado por padrão e **recai para execução sem sandbox se o Docker não estiver instalado**. Rode a Nova como um usuário dedicado / em seu próprio VPS, e ative o sandbox Docker se o isolamento importar para você.

- **Caminhos autônomos.** A etapa de aprovação cobre solicitações *interativas*. Tarefas agendadas, automações e etapas de processos duráveis são **pré-autorizadas quando você as cria** e rodam sem supervisão; os controles ali são os **limites de gasto** da escada de autonomia e as políticas de conteúdo de **bloqueio rígido** (que interrompem a execução mesmo nesses caminhos).

- **Credenciais em repouso** — tokens OAuth e segredos de conectores são criptografados com AES-256-GCM usando `NOVA_ENCRYPTION_KEY`.

- **Webhooks verificados** — HMAC Twilio com comparação segura em tempo; assinaturas Resend svix; webhooks de automação assinados com HMAC.

- **Dashboard** — sessões autenticadas, isolamento de dados por usuário, rotas de gerenciamento restritas por capacidade, rate limiting. Sempre defina `DASHBOARD_PASS` e sirva via HTTPS se exposto.

- **Conselho executivo** — RLS em todas as tabelas compartilhadas (Postgres + PostgREST auto-hospedado ou Supabase); a chave do banco apenas em servidores confiáveis.

- **SQL** — consultas totalmente parametrizadas; CLIs de IA invocados com arrays argv (sem interpolação de shell de suas mensagens).

### Postura de segurança

A Nova tem acesso a dados privados, recebe entradas não confiáveis (mensagens, conteúdo web, saída de ferramentas) e possui caminhos de saída (respostas de chat, chamadas de API). Essa é a "trifecta letal" — o endurecimento abaixo corta cada perna para o caso de entrada não confiável / vazamento. Rode `nova doctor --security` para avaliar sua implantação diante disso.

- **Ambiente de agentes com privilégio mínimo** (`NOVA_AGENT_ENV_STRICT`, ativado por padrão) — os subprocessos dos agentes recebem apenas as variáveis de que precisam, não todo o ambiente do host.

- **Firewall de vazamento de saída (egress)** (`NOVA_LEAK_FIREWALL`, ativado por padrão) — redige segredos das respostas de chat e dos logs, e bloqueia rigorosamente segredos que saem na fronteira de execução.

- **Firewall de entrada não confiável** (`NOVA_UNTRUSTED_FIREWALL`, ativado por padrão) — neutraliza conteúdo de ferramentas/web/email antes de entrar no prompt de um agente.

- **O dashboard** vincula-se apenas a loopback a menos que `DASHBOARD_PASS` esteja definido.

Encontrou uma vulnerabilidade? Denuncie em particular via [GitHub Security Advisories](https://github.com/djbelieny/nova/security) — veja `SECURITY.md`.

## Código aberto

A Nova tem licença MIT e é construída sobre o trabalho de muita gente. Cada projeto abaixo é usado sob sua própria licença (os textos completos acompanham o `node_modules`) — obrigado aos seus mantenedores.

| Área | Projetos |
| --- | --- |
| Runtime & IA | [Bun](https://bun.sh), [TypeScript](https://www.typescriptlang.org), [sqlite-vec](https://github.com/asg017/sqlite-vec) (busca vetorial), [Transformers.js](https://www.npmjs.com/package/@huggingface/transformers) rodando [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), o [MCP SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| **mcp2cli** | a ponte MCP-para-CLI que a Nova dirige para que os agentes chamem ferramentas MCP a partir do shell (veja Integrações MCP) |
| **[RTK](https://github.com/rtk-ai/rtk)** (Apache-2.0) | Rust Token Killer — instalado pelo `bootstrap.sh` e ativo por padrão; comprime a saída de comandos (git, build, test, grep…) em 60–90 % antes de voltar ao contexto de um agente. Seguro por design: comandos desconhecidos passam sem alteração. Desative com `NOVA_RTK=off`. |
| Canais & UI | [grammY](https://grammy.dev) (Telegram), [Bolt](https://www.npmjs.com/package/@slack/bolt) (Slack), [discord.js](https://discord.js.org), [Ink](https://www.npmjs.com/package/ink) + [React](https://react.dev) |
| Documentos & mídia | [pdf-parse](https://www.npmjs.com/package/pdf-parse), [mammoth](https://www.npmjs.com/package/mammoth), [docx](https://www.npmjs.com/package/docx), [PptxGenJS](https://www.npmjs.com/package/pptxgenjs), [sharp](https://sharp.pixelplumbing.com), [Playwright](https://playwright.dev) |
| Outros | [groq-sdk](https://www.npmjs.com/package/groq-sdk) (transcrição), [Resend](https://resend.com) (e-mail), [dotenv](https://www.npmjs.com/package/dotenv) |

A Nova **roda sobre** as CLIs oficiais dos fornecedores — [Claude Code](https://claude.ai/claude-code), a Gemini CLI e o Codex — dirigidas como subprocessos sob as suas próprias assinaturas; essas são ferramentas proprietárias, não incluídas. A Nova também nasceu do padrão minimalista [Claude Code Telegram Relay](https://github.com/godagoo) do Goda, desde então quase inteiramente reescrito.

## Resolução de problemas

| Sintoma | Verificar |
| --- | --- |
| Nova não inicia | `NOVA_ENCRYPTION_KEY` definido? Gere com `openssl rand -hex 32` e reinicie. Depois `claude "hello"` para confirmar que o CLI está autenticado. |
| Bot não responde | Token não tem espaços aleatórios; `TELEGRAM_USER_ID` corresponde @userinfobot; `bun run test:telegram`; verifique logs de relay. |
| Dashboard inacessível | `DASHBOARD_PASS` deve ser definido ou login está desabilitado; `curl http://localhost:3033`; o processo do dashboard está em execução? |
| Erros de banco de dados | `bun run test:sqlite`; confirme que `data/` existe e sqlite-vec carregado. |
| CLI Claude não encontrado | `npm install -g @anthropic-ai/claude-code`, ou defina `CLAUDE_PATH`. |
| Falha na transcrição de voz | `bun run test:voice`; chave Groq válida, ou binário whisper + caminho do modelo correto. |
| Alto uso de memória | 200–500 MB é normal para o relay; reinicie o serviço se exceder ~1 GB. |
| Erros Gemini | `gemini auth login` para atualizar credenciais CLI. |

Ainda preso? [Abra uma issue](https://github.com/djbelieny/nova/issues) — inclua seu SO, versão Bun e logs de relay (segredos removidos).
