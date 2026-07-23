# Documentación de Nova

> Documentación completa de Nova: instalación, todas las variables de entorno, canales, agentes, etiquetas de memoria, programación, integraciones MCP, panel de control, voz, junta ejecutiva y resolución de problemas.

*Source: https://mynova.space/es/docs/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Todo lo que necesitas para instalar, configurar y ejecutar tu equipo de IA auto-alojado — desde el primer mensaje de Telegram hasta una junta ejecutiva de siete nodos.

## Qué es Nova

Nova es una plataforma de IA de código abierto y auto-alojada. Es un equipo de **24 agentes especialistas** más una **capa de automatización** que ejecuta el trabajo repetitivo en segundo plano — y corre sobre tus propias suscripciones de modelos y tu propia máquina. Cuatro pilares:

| Pilar | Qué significa |
| --- | --- |
| **Multi-agente** | Una solicitud se clasifica de forma económica y luego se responde, se enruta a un especialista o se descompone en un plan ordenado por dependencias que corre entre varios (una junta ejecutiva opcional de 7 roles delibera sobre la estrategia). |
| **Orientada a eventos** | No solo espera un mensaje. Un webhook, una métrica, un evento de conector o una coincidencia semántica pueden disparar una automatización o un playbook; los procesos durables abarcan días. |
| **Tus modelos, tu máquina** | Maneja las CLIs de los proveedores (Claude, Gemini, Codex) como subprocesos, así que corre sobre suscripciones que ya pagas — más cualquier API compatible con OpenAI. El almacenamiento es SQLite local; los embeddings y la base de conocimiento son locales. Tus claves, tus datos. |
| **Confianza y gobernanza** | El flujo de dos fases preparar → aprobar → ejecutar controla las solicitudes interactivas; las políticas, los topes de gasto y los permisos basados en roles gobiernan las autónomas. |

Todo corre en tu máquina: **Bun + TypeScript**, SQLite local con búsqueda vectorial, tus propias cuentas de IA y credenciales cifradas en reposo con AES-256-GCM. Licenciado bajo MIT — [código fuente en GitHub](https://github.com/djbelieny/nova).

## Instalación

### Requisitos previos

- Una **cuenta de Telegram** (para crear tu bot)

- macOS 13+ o Ubuntu 22.04+ (Windows vía WSL2); mínimo 2 GB de RAM (4 GB recomendado)

Eso es todo para empezar — el instalador se encarga del resto. Instala automáticamente **[Bun](https://bun.sh)** y la **CLI de [Claude Code](https://claude.ai/claude-code)** si faltan, para que no tengas que configurarlos a mano. Las cuentas opcionales desbloquean más: Gemini, Groq (transcripción de voz gratuita), Twilio (llamadas telefónicas), Perplexity (investigación web), Meta, Notion, Google Workspace y más — todo cubierto en Configuración.

### Opción A — una sola línea (recomendado)

Una sola línea clona Nova en `~/nova`, instala cualquier requisito que falte y luego ejecuta un amigable **asistente de configuración**. El asistente te guía para conectar Telegram y un proveedor de IA — sin editar archivos — e incluso puede **detectar tu ID de usuario de Telegram automáticamente** (solo te pide que le escribas a tu bot). Es **reanudable**: ciérralo y vuelve a ejecutarlo para retomar donde lo dejaste.

```
$ curl -fsSL https://mynova.space/install | bash
```

¿Prefieres clonarlo tú mismo? Es lo mismo que ejecutar:

```
$ git clone https://github.com/djbelieny/nova && cd nova
$ bash bootstrap.sh      # instala los requisitos y luego ejecuta el asistente de configuración
```

¿Solo quieres ver qué hay instalado? `bash bootstrap.sh --check` reporta el estado de tu sistema y no cambia nada.

### Opción B — configuración manual

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

El modelo de embeddings local (all-MiniLM-L6-v2, ~23 MB) se descarga en el primer uso. Cuando Nova arranca, te envía un mensaje de bienvenida en Telegram con ideas para empezar que puedes tocar — así tu primera interacción funciona sin escribir nada. Ejecuta `nova doctor` en cualquier momento para una verificación de salud, o `nova update` para traer lo último y reinstalar.

### Referencia de comandos

El instalador coloca un comando `nova` en tu PATH — esa es la puerta de entrada para el uso diario (`nova start`, `nova doctor`, `nova connect` y el resto). Los scripts subyacentes `bun run <script>` siguen funcionando si los prefieres, y los scripts avanzados (`test:*`, `setup:*`, `exec:*`) solo se exponen a través de `bun run`.

| Comando | Qué hace |
| --- | --- |
| `bash bootstrap.sh` | Instala los requisitos y ejecuta el asistente de configuración (`--check` para una prueba en seco) |
| `nova init` | Ejecuta el asistente de configuración por sí solo (reanudable) |
| `nova doctor` | Verificación de salud + diagnósticos copiables |
| `nova update` | Trae lo último y reinstala las dependencias |
| `nova start` | Inicia el relé (proceso principal del bot) |
| `nova dev` | Inicia con recarga automática en cambios de archivos |
| `nova chat` | Habla con Nova directamente en tu terminal |
| `nova connect` | Conéctate a una Nova en ejecución (local o remota) con vista en vivo y aprobaciones en línea |
| `nova dashboard` | Inicia el panel web en el puerto 3033 |
| `nova providers add` / `list` / `test` / `default` | Agrega y gestiona modelos de IA (ver Proveedores de IA) |
| `nova invite [member|admin]` | Genera un código de invitación para agregar un compañero |
| `nova kb add` / `list` / `search` / `remove` / `reindex` | Alimenta y gestiona la base de conocimiento (ver Base de conocimiento) |
| `nova voice` | Inicia el servidor de llamadas de voz de Twilio |
| `nova setup` | Instala dependencias, crea `.env` desde el ejemplo |
| `nova backup` | Archiva `data/`, `config/` y `.env` a `~/.nova/backups/` |
| `bun run test:telegram` / `test:sqlite` / `test:voice` | Verifica el token de Telegram, base de datos y transcripción de voz |
| `bun run setup:verify` | Verificación de salud completa de la instalación |
| `bun run setup:launchd` / `setup:systemd` / `setup:services` | Configura servicios continuos (macOS / Linux / PM2) |
| `bun run typecheck` / `bun run test` | Verificación de TypeScript; ejecuta la suite de pruebas contra una BD aislada |
| `bun run exec:ceo` … `exec:critic` | Inicia un nodo de la junta ejecutiva |

## Configuración

Todos los secretos viven en `.env` (copiado de `.env.example`). El contexto personal vive en `config/profile.md`, cargado en cada prompt. Los servidores MCP se declaran en `.mcp.json` (copiado de `.mcp.example.json`).

**`NOVA_ENCRYPTION_KEY`** — Nova no iniciará sin él. Genera con `openssl rand -hex 32`. Cifra tokens OAuth y credenciales almacenadas con AES-256-GCM.

### Núcleo

| Variable | Valor por defecto | Propósito |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Requerido.** De @BotFather |
| `TELEGRAM_USER_ID` | — | **Requerido.** Tu ID numérico, detectado automáticamente por el asistente (o desde @userinfobot) |
| `NOVA_ENCRYPTION_KEY` | — | **Requerido.** 64 caracteres hexadecimales; cifrado de credenciales en reposo |
| `BOT_NAME` | `Nova` | El nombre que tu asistente se da a sí mismo |
| `USER_NAME` | — | Tu nombre (recomendado) |
| `USER_TIMEZONE` | `UTC` | Zona horaria IANA, p. ej. `America/New_York` |
| `CLAUDE_PATH` | `claude` | Ruta de CLI de Claude (autodetectada si está en PATH) |
| `RELAY_DIR` | `~/.nova` | Directorio de datos del relé (workspace, descargas, logs) |
| `PROJECT_DIR` | directorio repo | Directorio de trabajo entregado a Claude |

### Canales

| Variable | Propósito |
| --- | --- |
| `WHATSAPP_WEBHOOK_URL` | URL pública donde Kapso publica webhooks de WhatsApp (la clave Kapso por usuario e ID de número telefónico se agregan en el panel) |
| `SLACK_BOT_TOKEN` | Token del bot de Slack (`xoxb-…`), Socket Mode |
| `SLACK_APP_TOKEN` | Token de nivel de aplicación de Slack (`xapp-…`) |
| `DISCORD_BOT_TOKEN` | Token del bot de Discord — habilita el canal de Discord |

### Proveedores de IA e investigación

| Variable | Propósito |
| --- | --- |
| `GEMINI_API_KEY` | Habilita el proveedor Gemini |
| `CODEX_PATH` | Ruta a la CLI de Codex (autodetectada si está en PATH) |
| `GROQ_API_KEY` | Transcripción de voz (tier gratuito en console.groq.com) |
| `PERPLEXITY_API_KEY` | Investigación web: sonar-pro (ask), sonar-deep-research, sonar-reasoning-pro |

### Voz y teléfono

| Variable | Valor por defecto | Propósito |
| --- | --- | --- |
| `VOICE_PROVIDER` | `groq` | `groq` o `local` (whisper.cpp) |
| `WHISPER_BINARY` / `WHISPER_MODEL_PATH` | `whisper-cpp` | Binary de transcripción local y archivo de modelo |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | — | Llamadas telefónicas y SMS |
| `USER_PHONE` / `USER_PIN` | — | Tu número y un PIN privado para autenticación de llamadas |
| `VOICE_SERVER_PORT` | `80` | Puerto del servidor de voz (los despliegues de producción típicamente usan 8080 detrás de un proxy) |
| `VOICE_SERVER_URL` / `WEBHOOK_BASE_URL` | — | URLs públicas a las que Twilio devuelve llamadas |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | George | Síntesis de voz para respuestas de voz |

### Panel, integraciones y servicios

| Variable | Propósito |
| --- | --- |
| `DASHBOARD_USER` / `DASHBOARD_PASS` | Login del panel — **el panel permanece deshabilitado hasta que `DASHBOARD_PASS` está configurado** |
| `DASHBOARD_PUBLIC_URL` | URL pública del panel; se usa como base de redirección de OAuth |
| `GOOGLE_CLIENT_ID/SECRET`, `NOTION_CLIENT_ID/SECRET`, `ZOOM_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET` | Aplicaciones OAuth que creas; los usuarios conectan cuentas desde el panel |
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET` | API de Meta Ads (formato de cuenta `act_XXXXX`) |
| `SQUARE_LOCATIONS` | Pares separados por comas `Nombre (LOCATION_ID)` que el asistente de voz puede mencionar |
| `HEYGEN_API_KEY` / `FAL_API_KEY` | Vídeo de avatar de IA / texto a vídeo |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TICKET_SUPPORT_FROM`, `TICKET_OPERATOR_USER_ID`, `TELEGRAM_ADMIN_ID`, `TICKET_DEPLOY_DRYRUN` | Tubería de tickets de soporte (ver Tickets de soporte) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Base de datos compartida de junta ejecutiva (ver Junta ejecutiva) |
| `MEMWRIGHT_URL` / `MEMWRIGHT_DATA_DIR` | Servicio de memoria a largo plazo opcional (valores por defecto `http://localhost:8765`, `./data/memwright`); Nova se degrada gracefully sin él |
| `HEARTBEAT_*` | Controles de check-in proactivo (ver Programación) |

### Tu perfil

`config/profile.md` es markdown de forma libre sobre ti — rol, negocios, preferencias, restricciones — inyectado en cada conversación. Comienza desde `config/profile.example.md`. Está gitignored; nunca sale de tu máquina.

## Conectando canales

### Telegram (requerido)

1. Envía un mensaje a **@BotFather** → `/newbot` → elige un nombre de visualización, luego un nombre de usuario terminado en `bot`.

2. Copia el token (se ve como `7123…:AAH…`) en `TELEGRAM_BOT_TOKEN`.

3. Tu ID de usuario numérico lo **detecta automáticamente** el asistente de configuración — solo te pide que le escribas a tu bot. (Si prefieres, aún puedes definir `TELEGRAM_USER_ID` a mano desde **@userinfobot**.)

4. Verifica: `bun run test:telegram`.

### WhatsApp

WhatsApp se ejecuta a través de [Kapso](https://kapso.ai) (API de nube de Meta). Establece `WHATSAPP_WEBHOOK_URL` en una URL pública que alcance el endpoint `POST /webhook/kapso` del relé, luego agrega la clave API de Kapso de cada usuario e ID de número telefónico desde la página de WhatsApp del panel.

### Slack

1. Crea una aplicación en api.slack.com/apps → *Desde cero*.

2. Habilita **Socket Mode**; crea un token de nivel de aplicación (`xapp-…`) → `SLACK_APP_TOKEN`.

3. Agrega scopes del bot `channels:history`, `chat:write`, `im:history`, `im:write`; instala en tu workspace.

4. Copia el token del bot (`xoxb-…`) → `SLACK_BOT_TOKEN`.

### Terminal

Habla con Nova directamente desde tu shell con `nova chat` — la misma tubería, clasificación y controles de aprobación que cualquier otro canal, sin token de bot requerido. Para llegar a una Nova que ya está en ejecución (localmente o en tu VPS), usa `nova connect` (ver Hablar con Nova).

### Discord

Ejecuta Nova como un bot de Discord: crea una aplicación en [discord.com/developers](https://discord.com/developers/applications), agrega un bot y establece `DISCORD_BOT_TOKEN`. Discord usa el mismo patrón de adaptador que Telegram — los mensajes fluyen por la misma tubería de dos fases y con controles de aprobación.

## Hablar con Nova

Solo escribe naturalmente. Cada mensaje se ejecuta a través de tres niveles de clasificación — una heurística rápida para mensajes cortos, un caché de patrones de planes que funcionaron antes y clasificación de LLM solo para solicitudes complejas genuinamente nuevas. También puedes dirigirte explícitamente:

- **Dirige a un agente directamente** por nombre: `Pixel, crea una semana de contenido de Instagram`.

- **Fuerza un proveedor**: prefija con `/claude`, `/gemini` o `/codex`.

- **Los mensajes de voz** se transcriben automáticamente (Groq o Whisper local).

### Desde cualquier terminal — nova connect

Como Nova se ejecuta siempre activa, puedes entrar a una instancia en ejecución desde cualquier terminal — local o tu VPS — con `nova connect --url https://tu-nova`. Obtienes una vista en vivo de lo que tus agentes están haciendo y puedes **aprobar, cambiar o cancelar** en línea, directamente desde el shell. Para una conversación simple sin conectarte a una instancia remota, `nova chat` habla con tu Nova local.

### Comandos

| Comando | Qué hace |
| --- | --- |
| `/start` / `/help` | Bienvenida amigable con ideas para empezar que puedes tocar, y ayuda en lenguaje sencillo |
| `/team` | Conoce a tus 24 especialistas, agrupados según lo que quieras lograr |
| `/examples` | Ideas para empezar que puedes tocar para ejecutar ahora mismo |
| `/agents` | Explora los 24 agentes con botones de "Usar" de un toque |
| `/memory` / `/goals` / `/tasks` | Muestra hechos almacenados, objetivos y tareas de agentes |
| `/knowledge` / `/kb` | Lista los documentos de tu base de conocimiento, agrupados por alcance |
| `/schedule`, `/schedule list` | Gestiona tareas programadas |
| `/usage` | Resumen de costo y uso |
| `/board <pregunta>` | Convoca a la junta ejecutiva (si está configurada) |
| `/voice` | Configuración de voz |
| `/feedback good|bad` (o 👍/👎) | Califica la última respuesta — alimenta el aprendizaje de patrones |
| `/settings autopilot <categoría> [límite_usd]` | Auto-aprueba una categoría, opcionalmente limitada: `social_post`, `email`, `ad_spend`, `code_deploy`, `seo`, `research`, `general`, `*` |
| `/settings access @user <nivel>` | Visibilidad por usuario: `none`, `tasks-only`, `tasks+goals`, `full-summary` |
| `/settings role <función>` | Dile a Nova tu función para mejor contexto |
| `/codebase add <nombre> <git-url>` / `list` / `remove` | Registra repositorios para tareas de desarrollo |
| `/devtask <descripción>` | Encola una tarea de codificación de fondo en un repositorio registrado |

### Comandos de administrador

Los usuarios con el rol `admin` también obtienen `/adduser`, `/removeuser`, `/listusers`, `/share <hecho>` (memoria compartida), `/status`, `/reload`, `/revert`, `/schedules`, `/budget`, `/project`, `/webhook`, `/zoom` y `/reputation`.

### Agregar compañeros — códigos de invitación

Ya no necesitas buscar un ID de usuario numérico para agregar a alguien. Ejecuta `nova invite` (`nova invite member` o `nova invite admin` para establecer el rol) para generar un código de invitación, entrégaselo a la persona, y lo canjea en **Telegram o Discord** — tú apruebas el emparejamiento con un toque. Las invitaciones también se pueden gestionar desde el panel.

## Los 24 agentes

Cada agente es un archivo markdown en `.claude/agents/` — frontmatter YAML (nombre, descripción) más un prompt del sistema. El enrutador elige agentes durante la descomposición, o los diriges por nombre.

**Helios** · anuncios pagados**Pixel** · redes sociales**Kai** · contenido**Orion** · email**Morpheus** · vídeo**Architect** · desarrollo web**Athena** · estrategia**Digit** · análisis**Echo** · soporte**Flux** · embudos**Quill** · becas**Lex** · legal**Helia** · RP**Bridge** · asociaciones**Oracle** · tendencias**Cipher** · ciencia de datos**Rift** · seguridad**Joule** · automatización**Nexus** · comunidad**Aura** · voz de marca**Zen** · productividad**Tesseract** · sistemas**Magnus** · SEO**Cyra** · optimización de sitio

### Agrega los tuyos propios

Crea `.claude/agents/tunombre.md` con frontmatter y un prompt del sistema, mapea sus herramientas y skills en `src/agent-router.ts` y se une al equipo. Los PDFs de base de conocimiento del agente se pueden dejar caer en `agent-team/knowledge_bases/` (opcional).

## Skills

45 skills reutilizables viven en `.claude/skills/` — los agentes los invocan según sea necesario. Destacados: creación de documentos (`docx`, `xlsx`, `pptx`, `pdf`), `image-gen`, `canvas-design`, `ai-video-creator`, `content-research-writer`, `ghostwriter` (tubería de libros completos), `social-media-manager`, `email-marketing`, `meta-ads-manager`, `competitive-ads-extractor`, `lead-research-assistant`, `customer-support`, `reviews-testimonials`, `platform-maker` (generador de SaaS), `ui-ux-pro-max`, `file-organizer`, `telegram-file-sender`, `notebooklm`, `skill-creator`, además de suites para Google Workspace (`gws-*`: Gmail, Calendario, Drive, Docs, Sheets), GoHighLevel (`ghl-*`: contactos, marketing, facturación, contenido, admin) y Cloudflare (`cloudflare-dns`, `cloudflare-workers`).

Para agregar uno, usa el skill `skill-creator` o escribe un `SKILL.md` manualmente en un nuevo directorio — mantenlo genérico, con credenciales referenciadas desde `.env`.

## Memoria y etiquetas de intención

Nova recuerda hechos, objetivos y tareas en SQLite local con búsqueda vectorial — recordados semánticamente e inyectados en contexto (hasta 50 hechos/objetivos, 12 mensajes recientes, 5 coincidencias semánticas, 20 tareas). El modelo gestiona la memoria a través de etiquetas de intención en sus respuestas; Nova las analiza, actúa y las elimina antes de que veas la respuesta. Puedes activarlas naturalmente ("recuerda que…", "establece un objetivo para…").

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

### DSL de recurrencia

`daily:HH:MM` · `weekly:DAY:HH:MM` (0=Domingo) · `weekdays:HH:MM` · `interval:SECONDS`

## Base de conocimiento

Donde la memoria guarda lo que Nova *aprende*, la base de conocimiento guarda lo que tú ya *tienes*. Aliméntala con un documento, archivo o URL y Nova lo ingiere — extrayendo el texto (PDF, DOCX, Markdown, texto plano o una página web), dividiéndolo en pasajes superpuestos y convirtiendo cada uno en un vector con un modelo que corre **en tu propia máquina** (all-MiniLM, el mismo embedder local que usa la memoria). Nada se envía a una API de embeddings de terceros. Cuando haces una pregunta, Nova trae los pasajes más cercanos a la respuesta y **cita el documento fuente**.

### Tres alcances

| Alcance | Quién lo ve | Bueno para |
| --- | --- | --- |
| `personal` | Solo tú (almacenado en tu propia base de datos por usuario) | Tus notas, borradores, investigación privada |
| `team` | Todos en tu Nova (base de datos compartida) | Manual, guía de marca, precios — verdad compartida |
| `agent` | El paquete de un especialista, más los documentos personales + de equipo de ese usuario | Contratos para Lex, voz de marca para Aura, docs de API para Architect |

Un agente recupera de tus documentos *personales*, la base de *equipo* *y* su propio paquete — nunca el paquete de otro agente. Los pasajes personales y de equipo también se inyectan automáticamente en las conversaciones ordinarias, así que recordar es sin esfuerzo.

### Cuatro formas de alimentarla

- **Suelta un archivo en Telegram** — envía un documento con un pie de foto como `add to knowledge`, `add to team knowledge`, o `for Lex's pack`, y se ingiere con ese alcance al instante.

- **Panel** — el panel web tiene un panel de **Conocimiento**: arrastra archivos, define el alcance de cada uno, busca y elimina.

- **El comando `nova kb`** — gestiona todo el ciclo de vida desde una terminal (abajo).

- **Una carpeta vigilada** — cualquier cosa que sueltes en `~/.nova/knowledge/` se ingiere automáticamente; las subcarpetas definen el alcance (`team/`, `agents/<slug>/`). Elimina un archivo y sus pasajes salen de la base. Desactívalo con `NOVA_KB_WATCH=false`.

### El comando nova kb

```
nova kb add report.pdf --scope team          agrega un archivo a la base de equipo
nova kb add https://example.com/spec --agent architect
nova kb add notes.md                          predeterminado al alcance personal
nova kb list                                  lista documentos, agrupados por alcance
nova kb search "refund window"                busca en los alcances visibles
nova kb remove <id> --scope team
nova kb reindex --all                         re-genera embeddings tras ediciones
```

En el chat, `/knowledge` (o `/kb`) lista todo lo que Nova conoce actualmente, agrupado por alcance.

Los pasajes recuperados se **escanean contra inyección** antes de llegar a un prompt — un documento que intenta colar instrucciones se descarta. Tus archivos se tratan como datos, nunca como comandos. Volver a ingerir un archivo editado reemplaza la versión anterior en el mismo lugar (sin duplicados), y los embeddings nunca salen de tu máquina.

## Playbooks

Un playbook es un **SOP** reutilizable — un proceso de negocio que escribes una vez y ejecutas muchas veces con distintas entradas. Cada uno tiene variables y pasos ordenados (qué agente hace qué, en qué fase); ejecutar uno convierte esos pasos en un plan y lo ejecuta a través del gate de dos fases habitual. A diferencia de los patrones que Nova aprende sola: los playbooks son intencionales, editables y compartibles.

Alcances: `personal` (tuyo) o `team` (compartido). Carga una biblioteca inicial — onboarding de clientes, gestión de reembolsos, lanzamiento de contenido, informe semanal, seguimiento de leads — con un solo comando.

```
/playbook seed                         carga los SOP iniciales
/playbook run client-onboarding client=Acme email=a@b.com
nova playbook list | show <name> | remove <name>
```

Crea y edita playbooks en el panel **Playbooks** del dashboard; ejecútalos desde el chat, o conecta uno a una automatización (más abajo). Las variables se escanean contra inyección; cada edición incrementa una versión.

## Automatizaciones — evento → condición → workflow

Las automatizaciones hacen que Nova sea **orientada a eventos**: cuando algo ocurre, ejecuta un workflow. Cada una tiene una fuente (un webhook entrante, una sonda de métrica, o un evento de conector como `stripe.payment`), condiciones opcionales y una acción — una tarea de agente o un playbook. Cada disparo sigue pasando por el gate de aprobación a menos que hayas otorgado piloto automático.

| Pieza | Qué hace |
| --- | --- |
| Condiciones | `field:op:value` — operadores `eq/neq/gt/lt/gte/lte/contains/exists`; todas deben cumplirse. Más **semánticas** (abajo). |
| Deduplicación | Omite repeticiones dentro de una hora según una clave con plantilla (p. ej. `{{contact.email}}`). |
| Límite de tasa | Limita los disparos por hora. |
| Acción | `--agent <slug> --template "…{{event.field}}…"` o `--playbook <name> --var k={{…}}`. |

```
nova automation add new-lead --playbook lead-follow-up --var lead={{contact.name}} \
    --when amount:gt:1000 --dedupe {{contact.email}} --rate 10
nova automation url new-lead      el endpoint POST firmado para dárselo a tu fuente
/automations                      lístalas en el chat
```

Los eventos entrantes llegan a `POST /automation/:userId/:id` (verificado por HMAC). El texto del evento renderizado se escanea contra inyección. Diseña y prueba en seco las automatizaciones en el panel **Automatizaciones** del dashboard.

### Disparadores semánticos

Más allá de las coincidencias exactas, una condición puede dispararse por *significado*: `body:semantic:a customer complaint:0.55` se dispara cuando el campo del evento es semánticamente similar a la frase (embeddings locales, umbral opcional). Ideal para "cuando un correo se lee como una queja / una cancelación / una oportunidad de upsell."

## Procesos duraderos

Algunos trabajos abarcan días y eventos externos: *enviar contrato → esperar firma → facturar → esperar pago → cumplir.* Un proceso duradero es una secuencia de pasos de **acción** y **espera** que sobrevive a los reinicios (estado en SQLite) y se reanuda con un temporizador vencido o un evento con nombre. Los pasos de acción se ejecutan como tareas normales (los que tienen consecuencias pasan por el gate).

```
nova process start onboarding --from-playbook client-onboarding
nova process list | show <id> | cancel <id>
/process signal signature.done         reanuda los procesos que esperan ese evento
```

Los temporizadores se reanudan automáticamente mediante el despachador de tareas; los eventos se reanudan mediante una señal (un comando de chat o una automatización). Crea secuencias de pasos (con `wait|until|+2d` o `wait|event|<name>`) en la línea de tiempo **Procesos** del dashboard.

## Extracción de documentos

La contraparte de captura de la base de conocimiento: define un esquema de campos y extrae **JSON estructurado y con tipos coercionados** de PDFs, DOCX o texto — facturas, recibos, formularios, contratos. Los valores se coercionan (número/fecha/booleano/arreglo), los campos requeridos se validan y las filas se pueden exportar a CSV.

```
nova extract schema add invoice --field invoice_number:string:required \
    --field total:number:required --field due_date:date
nova extract statement.pdf --schema invoice
nova extract list --schema invoice | nova extract export invoice
```

En el chat, arrastra un documento con un pie como *"extract as invoice"*. Gestiona esquemas, ejecuta extracciones y exporta desde el panel **Extracción** del dashboard. La extracción se ejecuta localmente sobre tu texto; los destinos (Sheets/CRM) se enrutan a través de los conectores.

## Políticas y cumplimiento

Gobernanza de negocio sobre la escalera de autonomía ganada. Las políticas son **solo restrictivas**: agregan fricción (requerir aprobación, bloquear o advertir) pero nunca otorgan más autonomía de la que la escalera ya permite. Sin ninguna definida, el comportamiento es exactamente como antes.

| Tipo | Efecto |
| --- | --- |
| `spend_cap` | Un presupuesto diario/mensual comparado con el ledger de acciones — si se supera, fuerza la aprobación. |
| `approval_matrix` | Enruta ciertas acciones a aprobadores designados, con un tiempo de escalamiento. |
| `content_check` | Escanea la salida preparada en busca de PII / lenguaje ofensivo. `warn` la marca; `block` es un verdadero **bloqueo duro** — impide la ejecución en la frontera de ejecución incluso después de que una persona aprueba (se verifica contra el contenido preparado), de modo que nada se envía. |

```
nova policy add spend-cap --cap 500 --period month --department marketing
nova policy add approval --action email.send --approver <userId> --escalate 30
nova policy add content-check --checks pii,profanity --on-fail block
/policies
```

Gestiona todo en el editor **Políticas** del dashboard. Las políticas se evalúan en el gate, justo antes de Aprobar/Revisar/Cancelar.

## ROI e informes

Hace legible el valor de la automatización. Los agentes cuantifican los resultados con una etiqueta `[VALUE: $X | SAVED: Ymin | DEPT: z]`; Nova la registra y la consolida contra el ledger de acciones en **tareas automatizadas, horas ahorradas y $ influenciados frente al costo** — por departamento y por agente.

```
/roi                 últimos 7 días, en el chat
nova roi --period 30 | nova roi --by-agent | nova roi --by-department
```

La vista **ROI** del dashboard muestra tiles destacados + gráficos; un resumen semanal envía por DM a cada usuario el valor entregado. El ranking de valor por agente/departamento puede indicar dónde apoyarse.

## Conectores

Una capa fina y uniforme sobre sistemas de negocio externos. Los integrados vienen bidireccionales: **Stripe** (cargos/clientes/reembolsos), **Shopify** (pedidos), **Zendesk** (tickets), **HubSpot** (contactos). Cada uno tiene acciones de lectura + escritura y un disparador de sondeo que alimenta las automatizaciones (p. ej. `stripe.payment`). Las credenciales vienen de variables de entorno o del almacén de credenciales compartido; las acciones de escritura tienen consecuencias.

```
nova connector list                    integrados + estado de configuración
nova connector describe stripe         sus acciones + parámetros (descubrimiento)
nova connector run stripe list_charges --input '{"limit":5}'
nova connector set stripe STRIPE_API_KEY=sk_live_…   almacenado cifrado en reposo
```

Configura y ejecuta acciones desde el panel **Conectores** del dashboard. Agregar un conector es un solo archivo que implementa la interfaz `Connector`. Los agentes llaman a los conectores ellos mismos igual que usan las herramientas MCP bajo **mcp2cli** — descubren bajo demanda (`describe`) y luego llaman — de modo que el prompt del agente se mantiene ligero sin importar cuántos conectores existan (ver Operar y observar).

## Operar y observar

Todo lo que hace la capa de automatización es observable y recuperable.

- **Feed de actividad** — una línea de tiempo unificada de cada disparo de automatización, transición de proceso y ejecución de playbook. `nova activity`, `/activity`, o la página **Actividad** del dashboard.

- **Prueba en seco** — previsualiza exactamente qué haría una automatización contra un evento de muestra antes de habilitarla (`nova automation simulate <name> --event '{…}'`, o el control "Test / dry-run" del dashboard). No ejecuta nada.

- **Reintentos y dead-letter** — un envío fallido se reintenta con backoff; si aun así falla, cae en una cola de dead-letter en lugar de desaparecer. `nova dlq list | retry <id> | drop <id>`, o la página **Dead letters** del dashboard.

### Los agentes pueden usar tus herramientas

Los agentes especialistas pueden llamar a las capacidades de Nova ellos mismos mientras trabajan — buscar en la base de conocimiento, extraer un documento, consultar una fuente de datos, ejecutar un conector configurado o correr un playbook — mediante la CLI `nova` en su entorno de ejecución. Siguiendo el patrón **mcp2cli**, *descubren* las herramientas bajo demanda (p. ej. `nova connector describe <id>`) en lugar de cargar cada esquema en el prompt, usan las acciones de lectura libremente y **proponen acciones de escritura/con consecuencias para aprobación** en lugar de ejecutarlas directamente.

## Datos conectados

Registra las fuentes donde realmente vive tu información de negocio y consúltalas — para informes, para automatizaciones o para un agente en plena tarea. De solo lectura por diseño.

| Tipo | Lee desde |
| --- | --- |
| `http` | Un endpoint JSON o CSV (apunta `rowsPath` al array dentro de un cuerpo JSON). |
| `sqlite` | Un `SELECT` de solo lectura contra un archivo SQLite — analítica, exportaciones, un almacén local. |
| `connector` | Una acción de *lectura* de un conector (Stripe, Shopify, …) — las acciones de escritura se rechazan. |

```
nova data add sales --kind http --url https://api/report.json --rows-path data
nova data add wh --kind sqlite --path /data/warehouse.db --query "SELECT day, revenue FROM metrics"
nova data query sales        columnas + filas
/data query sales            o desde el chat
```

Gestiona las fuentes y ejecuta consultas en el panel **Datos** del dashboard. Combina una fuente con el programador o un playbook para informes recurrentes. Cero dependencias adicionales.

## Gobernanza y hardening

Controles de nivel producción para ejecutar Nova sin supervisión y en equipo. Todo es aditivo — sin nada configurado, el comportamiento es exactamente como antes.

### Roles y permisos

Los admins pueden hacer todo. Los miembros obtienen **capacidades** acotadas — `automation.manage`, `policy.manage`, `connector.manage`, `playbook.manage`, `process.manage`, `access.manage` — que controlan quién puede crear o cambiar cada área gobernada (se aplican en las acciones de escritura del dashboard).

```
nova access grant @teammate automation.manage
nova access list @teammate
/access @teammate grant policy.manage
```

### Delegación por ausencia

¿Te vas? Delega tu trabajo para que las asignaciones y aprobaciones se enruten a un compañero (una cadena con protección contra ciclos) hasta que vuelvas.

```
nova ooo set @teammate "de vacaciones" --until 2026-08-01
/ooo @teammate   ·   /ooo off
```

### Idempotencia, bloqueo y secretos

- **Exactamente una vez.** Una automatización puede optar por idempotencia duradera (`--idempotent`) para que un webhook reenviado dispare una sola vez — no otra vez una hora después.

- **Sin doble disparo.** Bloqueos consultivos envuelven el sondeo de automatizaciones y el despachador de tareas, de modo que ticks solapados o múltiples instancias nunca procesen el mismo trabajo dos veces.

- **Secretos cifrados.** Las credenciales de conectores se almacenan cifradas con AES-256-GCM en reposo (configura `NOVA_ENCRYPTION_KEY`) vía `nova connector set`, con auditoría de rotación — sin claves en texto plano en `.env`.

Gestiona capacidades, delegación y secretos de conectores en el panel **Administración de gobernanza** del dashboard.

## Programación y servicios proactivos

Más allá de los horarios únicos, Nova incluye servicios de fondo que funcionan mientras tú no (los tiempos a continuación son los valores por defecto de cron, UTC):

| Servicio | Programación | Qué hace |
| --- | --- | --- |
| Despachador de tareas | cada 60s | Ejecuta tareas programadas vencidas |
| Resumen matutino | diario | Resumen del día: calendario, objetivos, tareas, noticias |
| Check-in inteligente | varios/día | Recordatorios conscientes del contexto, limitados por latidos |
| Monitor de noticias de IA | 3×/día | Noticias de IA/tecnología curadas |
| Sugeridor de publicaciones sociales | diario | Ideas de publicaciones de tu contexto |
| Sugeridor de leads | diario | Ideas de leads de negocios |
| Reporte de anuncios de Meta | diario | Resumen del rendimiento del anuncio |
| Revisión de memoria | diario | Deduplica y cura memoria |
| Monitor de salud | cada 30 min | Consulta `/health`; te envía DM después de 3 fallos consecutivos |
| Monitor de registros / Modo de sueño | periódico | Triage de errores / reflexión en tiempo de inactividad |

### Controles de latidos

`HEARTBEAT_ENABLED=true` · `HEARTBEAT_INTERVAL_MIN=30` · `HEARTBEAT_MAX_DAILY=3` (mensajes proactivos por usuario por día) · `HEARTBEAT_ACTIVE_HOURS=8-22` (tu zona horaria). Vaciar `config/heartbeat.md` desactiva los check-ins proactivos completamente.

## Proveedores de IA y enrutamiento

Nova impulsa la IA a través de CLIs que ya has autenticado — no se necesitan claves API sin procesar para Claude. Precedencia de enrutamiento: **prefijo de fuerza → preferencia del usuario → pista de tarea → dependencia MCP → resguardo de límite de tasa**.

| Proveedor | Vía | Niveles |
| --- | --- | --- |
| Claude | CLI `claude` | fast=Haiku · standard=Sonnet · premium=Opus |
| Gemini | CLI `gemini` | fast=Flash · standard=Pro · premium=Ultra |
| Codex | CLI `codex` | estándar |
| Groq | API | Transcripción de voz Whisper |

### Agregar cualquier modelo compatible con OpenAI

Más allá de las CLIs de suscripción, puedes agregar **cualquier modelo compatible con OpenAI** — una ruta de OpenRouter, un modelo de OpenAI, o un endpoint local de `Ollama` / `vLLM`. Agrega uno con `nova providers add` (o la sección **Modelos** del panel); gestiona el resto con `nova providers list`, `nova providers test` y `nova providers default`. Las definiciones viven en `config/providers.json`, y cada modelo usa su propia clave API. Las CLIs de suscripción siguen siendo el valor predeterminado — los modelos agregados se acomodan junto a ellas y usan las mismas herramientas MCP y conectores.

## Integraciones MCP

Copia `.mcp.example.json` a `.mcp.json`. Cada servidor se ejecuta bajo demanda a través de `npx`; las credenciales vienen de `.env` o almacenamiento por usuario (cifrado, gestionado en el panel — `src/integrations.ts` genera la configuración MCP de cada usuario).

| Servidor | Propósito | Credenciales |
| --- | --- | --- |
| `notion` | Documentos, bases de datos, páginas | OAuth vía panel (o `NOTION_MCP_HEADERS`) |
| `google-workspace` | Gmail, Calendario, Drive, Docs, Sheets | OAuth vía panel (`GOOGLE_CLIENT_*`) |
| `playwright` | Automatización del navegador, scraping, capturas de pantalla | ninguno |
| `cloudflare` | Workers, DNS, edge | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `zoom` | Reuniones | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_*` |
| `square` | POS, datos de ventas | `SQUARE_ACCESS_TOKEN` |
| `clickup` | Gestión de tareas | `CLICKUP_API_TOKEN` |
| `gohighlevel` | CRM, campañas, publicación | `GHL_BEARER_TOKEN` |
| `firecrawl` | Web scraping | `FIRECRAWL_API_KEY` |
| `tavily` / `exa` | Búsqueda web / búsqueda semántica | `TAVILY_API_KEY` / `EXA_API_KEY` |
| `browserbase` | Sesiones de navegador en la nube | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` |

Los MCPs basados en servicios en `services/` agregan YouTube, TikTok, Zoom y publicación social de Meta. El servidor opcional `memwright` proporciona memoria vectorial a largo plazo (puerto 8765).

### mcp2cli — herramientas sin el impuesto de contexto

Cargar el esquema JSON de cada herramienta MCP en el prompt de un agente es costoso — cientos de definiciones de herramientas pueden dominar la ventana de contexto. En cambio, Nova expone los servidores MCP a través de **mcp2cli**: los agentes reciben una instrucción breve para *descubrir* herramientas bajo demanda desde el shell — `mcp2cli … --list` para ver las herramientas de un servidor, y luego `--tool <name> --param k=v` para llamar a una — así solo las herramientas que realmente se usan cuestan contexto. El mismo enfoque de descubrimiento primero aplica a las propias capacidades de Nova (`nova connector describe <id>`, `nova kb search`, …), de modo que el conjunto de herramientas de un agente puede crecer sin inflar su prompt.

## Panel web

Una superficie completa de administrador y por usuario en el **puerto 3033**: establece `DASHBOARD_PASS` (y opcionalmente `DASHBOARD_USER`, por defecto `admin`), luego `bun run dashboard` y abre `http://localhost:3033`. Las sesiones están basadas en cookies con limitación de velocidad; los usuarios no administradores solo ven sus propios datos.

- **Panel y Kanban** — actividad en vivo, tablero de tareas, estado del agente

- **Aprobaciones** — resuelve controles de aprobación pendientes desde el navegador

- **Integraciones** — conecta Google, Notion, Zoom, TikTok vía OAuth (devolución: `http://localhost:3033/auth/<proveedor>/callback`, o tu `DASHBOARD_PUBLIC_URL`)

- **Memoria, Historial, Programación, Skills** — inspecciona y edita lo que Nova sabe y ejecuta

- **Tickets, WhatsApp, Credenciales compartidas, Salud, Costos** — páginas de operaciones

## Voz

### Mensajes de voz (transcripción)

**Groq** (recomendado, tier gratuito ~2000/día): `VOICE_PROVIDER=groq` + `GROQ_API_KEY`. **Local**: instala ffmpeg + whisper.cpp, descarga `ggml-base.en.bin` (~142 MB) a `~/whisper-models/`, establece `VOICE_PROVIDER=local`. Verifica con `bun run test:voice`.

### Llamadas telefónicas (Twilio)

Ejecuta `bun run voice` para iniciar el servidor de llamadas (puerto predeterminado 80; la producción típicamente usa 8080 detrás de un proxy inverso). Configura las variables de entorno de Twilio más `USER_PIN` — los llamadores se autentican por PIN, hablan con Nova y las solicitudes accionables se extraen de la transcripción y se ejecutan después de la llamada. Las respuestas usan TTS de ElevenLabs cuando está configurado. Los webhooks se verifican con HMAC; endpoints: `/voice/*`, `/sms/*`, `/audio/*`, `/health`.

## Tickets de soporte

Una tubería impulsada por correo electrónico: el correo electrónico de soporte entrante (vía webhooks de [Resend](https://resend.com), verificado por firma) se convierte en un ticket → triage → un agente redacta una solución en el repositorio del cliente coincidente → apruebas desde Telegram → despliegue. Configura `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TICKET_SUPPORT_FROM`, `TICKET_OPERATOR_USER_ID` y `TELEGRAM_ADMIN_ID`; el worker (`bun run ticket-worker`) consulta cada 60 segundos. `TICKET_DEPLOY_DRYRUN=true` (el valor predeterminado) mantiene los despliegues simulados hasta que lo cambies.

## Junta ejecutiva

Una capa multinodo opcional: siete roles ejecutivos — CEO, CFO, CMO, CTO, COO, Research, Critic — cada uno un proceso con una persona de razonamiento distinta y su propio proveedor de IA, coordinándose a través de una base de datos Postgres compartida mediante PostgREST. Pregunta `/board should we switch to usage-based pricing?` y obtienes análisis independientes, un pre-mortem adversarial del Critic y 3–5 opciones sintetizadas con puntuaciones de confianza. Elige una; la decisión se registra y el COO despacha la ejecución.

### Configuración

1. Levanta la base de datos compartida — **Postgres + PostgREST autoalojado** (`bun run migrate:board`, ver `deploy/board/`), o un proyecto de Supabase si prefieres uno gestionado.

2. Establece `BOARD_DB_URL` y `BOARD_DB_KEY` en `.env` (los nombres `SUPABASE_*` siguen funcionando como alias). Las tablas de la junta usan seguridad a nivel de fila sin acceso anónimo — la clave solo debe vivir en servidores de confianza.

3. Crea `.env.<role>` por nodo (`EXEC_ROLE`, `EXEC_NODE_ID`, un token de bot, `EXEC_AI_PROVIDER` opcional).

4. Inicia los roles: `bun run exec:ceo`, `exec:cfo`, … `exec:critic`. Son solo procesos — ejecuta los siete en un mismo host o distribúyelos en varias máquinas (unidades systemd `nova-exec-<role>`). Hosts separados con claves de IA separadas es una recomendación para los límites de tasa, no un requisito.

Los ejecutivos usan sus propias etiquetas de intención: `[DELEGATE: agente | tarea]` (opcionalmente `| PROVIDER: claude`), `[BRIEF: role|all | resumen]` y `[DECISION: pregunta | elegido | rationale | CONFIDENCE: 0.8]`.

## Ejecución continua

### macOS — launchd

```
$ bun run setup:launchd -- --service core   # solo el relé
$ bun run setup:launchd -- --service all    # relé + panel + servicios proactivos
$ launchctl list | grep com.nova            # verificar
$ bun run setup:logrotate                   # rotación diaria de logs
```

Los servicios se instalan como `~/Library/LaunchAgents/com.nova.*.plist`; servicios individuales: `core`, `dashboard`, `memwright`, `checkin`, `briefing`, `memory-review`, `dispatcher`, `health-monitor`, `voice`.

### Linux — systemd

```
$ sudo bun run setup:systemd --service all
$ systemctl enable --now nova-relay nova-dashboard
$ journalctl -u nova-relay -f               # logs
```

### Windows / cualquier parte — PM2

```
$ bun run setup:services -- --service all
$ npx pm2 status
```

Para exposición pública (webhooks, panel, voz), coloca Caddy u otro proxy inverso enfrente — ver `DEPLOY.md` en el repositorio para un recorrido de producción.

## Base de datos y copias de seguridad

SQLite dividido con `sqlite-vec` para búsqueda vectorial. Los embeddings se calculan localmente (all-MiniLM-L6-v2, 384 dimensiones) — nada sale de tu máquina.

```
data/shared.db       # usuarios, estado, logs, seguimiento de costos, memoria compartida
data/users/{id}.db   # por usuario: mensajes, memoria, tareas, aprobaciones, programas, patrones
data/memwright/      # almacenamiento del servicio de memoria a largo plazo opcional
```

**Copias de seguridad:** `bun run backup` archiva `data/`, `config/` y `.env` a `~/.nova/backups/` (últimas 7 conservadas; programadas diariamente cuando los servicios están instalados). Para restaurar: detén servicios, extrae el archivo, copia las tres rutas de vuelta, reinicia.

## Modelo de seguridad

- **Controles de aprobación** separan acciones consecuentes de las seguras, por categoría y por usuario — **el límite de seguridad predeterminado** (ver la salvedad más abajo).

- **El aislamiento (sandbox) es opcional.** Por defecto, las herramientas de los agentes se ejecutan **sin sandbox en tu host**. Existe un sandbox de Docker endurecido (`NOVA_SANDBOX_BACKEND=docker`: FS de solo lectura, capacidades reducidas, sin red, montaje solo del workspace) pero está desactivado por defecto y **recae en sin sandbox si Docker no está instalado**. Ejecuta Nova como un usuario dedicado / en su propio VPS, y habilita el sandbox de Docker si el aislamiento te importa.

- **Rutas autónomas.** El control de aprobación cubre las solicitudes *interactivas*. Las tareas programadas, las automatizaciones y los pasos de procesos durables están **preautorizados cuando los creas** y se ejecutan sin supervisión; ahí los controles son los **topes de gasto** de la escalera de autonomía y las políticas de contenido de **bloqueo absoluto** (que detienen la ejecución incluso en esas rutas).

- **Credenciales en reposo** — Los tokens OAuth y los secretos de conectores están cifrados con AES-256-GCM con `NOVA_ENCRYPTION_KEY`.

- **Webhooks verificados** — HMAC de Twilio con comparación segura de tiempo; firmas svix de Resend; webhooks de automatización firmados con HMAC.

- **Panel** — sesiones autenticadas, aislamiento de datos por usuario, rutas de gestión restringidas por capacidad, limitación de velocidad. Siempre establece `DASHBOARD_PASS` y sirve sobre HTTPS si está expuesto.

- **Junta ejecutiva** — RLS en todas las tablas compartidas (Postgres + PostgREST autoalojado o Supabase); la clave de la base de datos solo en servidores de confianza.

- **SQL** — consultas completamente parametrizadas; CLIs de IA invocadas con arrays argv (sin interpolación de shell de tus mensajes).

### Postura de seguridad

Nova tiene acceso a datos privados, recibe entradas no confiables (mensajes, contenido web, salida de herramientas) y tiene rutas de salida (respuestas de chat, llamadas a APIs). Esa es la "trifecta letal" — el endurecimiento de abajo corta cada pata para el caso de entrada no confiable / fuga de datos. Ejecuta `nova doctor --security` para calificar tu despliegue frente a ella.

- **Entorno de agentes con mínimo privilegio** (`NOVA_AGENT_ENV_STRICT`, activado por defecto) — los subprocesos de los agentes reciben solo las variables que necesitan, no todo el entorno del host.

- **Firewall de fuga de salida (egress)** (`NOVA_LEAK_FIREWALL`, activado por defecto) — redacta secretos de las respuestas de chat y los logs, y bloquea de forma estricta los secretos que salen en el límite de ejecución.

- **Firewall de entrada no confiable** (`NOVA_UNTRUSTED_FIREWALL`, activado por defecto) — neutraliza el contenido de herramientas/web/email antes de que entre al prompt de un agente.

- **El panel** se vincula solo a loopback a menos que se establezca `DASHBOARD_PASS`.

¿Encontraste una vulnerabilidad? Reporta en privado vía [GitHub Security Advisories](https://github.com/djbelieny/nova/security) — ver `SECURITY.md`.

## Código abierto

Nova está licenciado bajo MIT y construido sobre el trabajo de muchas otras personas. Cada proyecto de abajo se usa bajo su propia licencia (los textos completos vienen en `node_modules`) — gracias a quienes los mantienen.

| Área | Proyectos |
| --- | --- |
| Runtime e IA | [Bun](https://bun.sh), [TypeScript](https://www.typescriptlang.org), [sqlite-vec](https://github.com/asg017/sqlite-vec) (búsqueda vectorial), [Transformers.js](https://www.npmjs.com/package/@huggingface/transformers) ejecutando [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), el [MCP SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| **mcp2cli** | el puente MCP-a-CLI que Nova maneja para que los agentes llamen a herramientas MCP desde el shell (ver Integraciones MCP) |
| **[RTK](https://github.com/rtk-ai/rtk)** (Apache-2.0) | Rust Token Killer — instalado por `bootstrap.sh` y activo por defecto; comprime la salida de comandos (git, build, test, grep…) en un 60–90 % antes de que vuelva al contexto de un agente. Seguro por diseño: los comandos desconocidos pasan sin cambios. Desactívalo con `NOVA_RTK=off`. |
| Canales e interfaz | [grammY](https://grammy.dev) (Telegram), [Bolt](https://www.npmjs.com/package/@slack/bolt) (Slack), [discord.js](https://discord.js.org), [Ink](https://www.npmjs.com/package/ink) + [React](https://react.dev) |
| Documentos y medios | [pdf-parse](https://www.npmjs.com/package/pdf-parse), [mammoth](https://www.npmjs.com/package/mammoth), [docx](https://www.npmjs.com/package/docx), [PptxGenJS](https://www.npmjs.com/package/pptxgenjs), [sharp](https://sharp.pixelplumbing.com), [Playwright](https://playwright.dev) |
| Otros | [groq-sdk](https://www.npmjs.com/package/groq-sdk) (transcripción), [Resend](https://resend.com) (correo), [dotenv](https://www.npmjs.com/package/dotenv) |

Nova **corre sobre** las CLIs oficiales de los proveedores — [Claude Code](https://claude.ai/claude-code), la CLI de Gemini y Codex — manejadas como subprocesos bajo tus propias suscripciones; esas son herramientas propietarias, no incluidas. Nova también surgió del patrón minimalista [Claude Code Telegram Relay](https://github.com/godagoo) de Goda, desde entonces reescrito casi por completo.

## Resolución de problemas

| Síntoma | Verifica |
| --- | --- |
| Nova no inicia | `NOVA_ENCRYPTION_KEY` ¿está establecido? Genera con `openssl rand -hex 32` y reinicia. Luego `claude "hello"` para confirmar que la CLI está autenticada. |
| El bot no responde | El token no tiene espacios en blanco; `TELEGRAM_USER_ID` coincide con @userinfobot; `bun run test:telegram`; verifica los logs del relé. |
| Panel no accesible | `DASHBOARD_PASS` debe estar establecido o el login está deshabilitado; `curl http://localhost:3033`; ¿está ejecutándose el proceso del panel? |
| Errores de base de datos | `bun run test:sqlite`; confirma que `data/` existe y sqlite-vec está cargado. |
| CLI de Claude no encontrado | `npm install -g @anthropic-ai/claude-code` o establece `CLAUDE_PATH`. |
| La transcripción de voz falla | `bun run test:voice`; la clave Groq es válida o el binary de whisper + la ruta del modelo es correcta. |
| Alto uso de memoria | 200–500 MB es normal para el relé; reinicia el servicio si excede ~1 GB. |
| Errores de Gemini | `gemini auth login` para actualizar credenciales de CLI. |

¿Aún atrapado? [Abre un issue](https://github.com/djbelieny/nova/issues) — incluye tu SO, versión de Bun y logs del relé (secretos redactados).
