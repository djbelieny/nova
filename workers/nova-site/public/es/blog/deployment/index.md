# Despliegue de Nova: una guía práctica para auto-alojamiento

> Auto-aloja Nova en menos de 5 minutos. Del asistente de inicialización a producción en una VPS, aquí está todo lo que necesitas saber para ejecutar tu propio equipo de IA en tu máquina, tus claves, tus controles de aprobación.

*Source: https://mynova.space/es/blog/deployment/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

De un clon fresco a ejecutar en tu máquina o VPS. Aprende cómo inicializar Nova, configurarla para tu proveedor de IA e integraciones, habilitar sandbox, y configurar la junta ejecutiva — con controles de aprobación que te mantengan en control.

Jake Belieny · 15 de julio de 2026 · 10 min de lectura

Nova está diseñado para ser auto-alojado. Tu máquina, tus claves de API, tus datos, tus controles de aprobación. Esta guía te lleva a través de cada paso: desde el primer `bash bootstrap.sh` hasta una instancia de producción ejecutando en una VPS, con características opcionales como ejecución en sandbox y una junta ejecutiva distribuida.

La mayoría de esto toma menos de cinco minutos. Las partes opcionales — sandbox, coordinación de junta multi-VPS, gobernanza avanzada — las activas cuando estés listo.

## Lo que necesitarás

Antes de comenzar, reúne estas piezas:

#### Una computadora o servidor

macOS, Linux o Windows vía WSL2. El instalador configura todo lo demás — el tiempo de ejecución Bun y la CLI de Claude Code se instalan por ti automáticamente.

#### Una cuenta de Telegram

Nova se comunica a través de Telegram por defecto (WhatsApp y Slack también funcionan). Obtendrás un token de bot de @BotFather.

#### Una clave de proveedor de IA

Claude (recomendado), Gemini, Codex, o Groq. Comienza con lo que ya usas; Nova cambia proveedores basado en el tipo de tarea.

#### Credenciales de MCP (opcional)

Google Workspace, Notion, Cloudflare, etc. Cada una añade una herramienta a tus agentes. Puedes saltarte estas por ahora y añadirlas después.

## La vía rápida: `bash bootstrap.sh`

Nova viene con un instalador de un solo comando y un asistente de configuración guiado que pregunta exactamente lo que necesita y nada más. Clona el repo, ejecuta un solo comando, y estás listo en aproximadamente 3 minutos:

**Inicio rápido** 
 `git clone https://github.com/djbelieny/nova.git`

 `cd nova`

 `bash bootstrap.sh`

`bootstrap.sh` instala cualquier requisito que falte (Bun, la CLI de Claude Code) y luego ejecuta el asistente. Es reanudable — ciérralo y vuelve a ejecutarlo para continuar — y `bash bootstrap.sh --check` reporta el estado de tu sistema sin cambiar nada. El asistente te preguntará por:

- Un token de bot de Telegram de @BotFather (sigue los prompts)

- Eso es todo lo que escribes para Telegram — tu ID de usuario se **detecta automáticamente** cuando le escribes a tu bot (sin paso de @userinfobot)

- Qué proveedor de IA quieres comenzar con (Claude/Gemini/etc.)

- Tu clave de API para ese proveedor

- Tu nombre y zona horaria (para personalización)

Escribe un archivo `.env` mínimo, crea `.mcp.json` del ejemplo, y verifica la conexión de Telegram. Cuando Nova arranca, te saluda en Telegram con ideas para empezar que puedes tocar — así tu primera interacción funciona sin escribir nada. Ejecuta `bun run doctor` en cualquier momento para una verificación de salud.

**Eso es todo** Ahora tienes una instancia de Nova funcionando que entiende solicitudes clasificadas, enruta al agente correcto, y pide aprobación antes de que algo consecuencial suceda.

## Configuración: Conoce tus tres archivos

La configuración de Nova vive en tres lugares. Raramente necesitas editarlos directamente — `bun run init` maneja lo básico — pero entenderlos ayuda cuando quieres añadir una característica o depurar.

### .env — Secretos y claves de API

Nunca cometas este archivo. Contiene tu token de bot de Telegram, claves del proveedor de IA, y cualquier credencial de terceros. Comienza con el ejemplo:

**Variables esenciales** 
 TELEGRAM_BOT_TOKEN=your_token_here

 TELEGRAM_USER_ID=your_id

 ANTHROPIC_API_KEY=sk-ant-...

 USER_NAME=Jake

 USER_TIMEZONE=America/New_York

Las variables opcionales habilitan características a medida que las añades: `GROQ_API_KEY` para transcripción de voz, `GOOGLE_WORKSPACE_CREDS` para Gmail/Drive, `CLOUDFLARE_API_TOKEN` para workers, y así sucesivamente.

### config/profile.md — Quién eres

Un archivo markdown describiendo tu contexto. Se carga en cada mensaje para que Nova entienda tus objetivos, restricciones, y estilo de comunicación. Rellena una vez:

**Ejemplo profile.md** 
 # Tu Perfil

 

 Tu nombre: Jake

 Qué haces: Dirigir una empresa SaaS

 Tus objetivos: 10x salida de contenido, crecer a 5k suscriptores de boletín

 Restricciones: Tengo 4 horas libres por semana

 Zona horaria: America/New_York

### .mcp.json — Integraciones y herramientas

Especifica qué servidores MCP puede conectar Nova: Notion, Google Workspace, Playwright, Cloudflare, Square, GoHighLevel, y 12 otros. El asistente de inicialización copia `.mcp.example.json` y configura placeholders. A medida que añades integraciones, descomenta las que uses y añade credenciales.

## Ejecutar Nova: Iniciarlo, mantenerlo ejecutando

Una vez configurado, inicia el bot:

**Desarrollo** 
 `bun run start`

Escucha mensajes de Telegram. Ctrl+C para detener. Pruébalo: envía un mensaje a tu bot en Telegram y espera a que responda.

Para producción — para que Nova se ejecute en el fondo y reinicie en caso de fallo — usa el gestor de procesos de tu SO:

### macOS: launchd

**Configurar y habilitar** 
 `bun run setup:launchd -- --service core`

Esto genera automáticamente un archivo plist con las rutas correctas y lo carga en launchd. Nova se ejecuta en el fondo, comienza en el arranque, y reinicia si se cae. Verifica el estado con `launchctl list | grep nova`.

### Linux/Windows: PM2

**Configurar y habilitar** 
 `bun run setup:services -- --service core`

Usa PM2 para gestión de procesos. Verifica con `npx pm2 status`.

## Ejecución en sandbox (0.2.0)

Cuando los agentes ejecutan tareas, se ejecutan en la memoria de tu máquina por defecto. El sandbox es opcional pero poderoso: ejecuta cada tarea en un contenedor Docker endurecido — sistema de archivos de solo lectura excepto para un área de trabajo por tarea, sin acceso a tus credenciales, llamadas al sistema limitadas.

Una página web maliciosa que intenta engañar a un agente para que exfiltre datos no puede escapar del sandbox. Y Nova se mantiene en tu suscripción: en lugar de cambiar a facturación por token, comparte tu plan de Claude/Gemini en el sandbox.

Para habilitar el sandbox:

**Opcional: Habilitar sandbox** 
 `NOVA_SANDBOX_BACKEND=docker`

 Construir la imagen: `bun run sandbox:verify`

 Establecer modo de suscripción: `NOVA_SANDBOX_SHARE_AUTH=true`

Eso es todo. Los agentes ahora se ejecutan dentro de un contenedor. Puedes ver los registros del contenedor y ajustar el aislamiento según sea necesario.

## La junta ejecutiva (0.2.0)

Para preguntas estratégicas difíciles, Nova tiene una junta ejecutiva opcional: CEO, CFO, CMO, CTO, COO, Jefe de Research, y un Crítico. Cada uno modela una forma diferente de pensar. Se convocan, dan análisis independiente, el Crítico hace un pre-mortem para exponer modos de fallo, y Nova sintetiza opciones con puntuaciones de confianza.

La junta puede ejecutarse en una sola VPS o distribuida en 7 máquinas separadas. Los 7 ejecutivos se coordinan a través de una base de datos Postgres compartida.

### Configuración de junta en una sola VPS

Ejecuta Postgres localmente y regístralo:

**Base de datos de junta** 
 `bash deploy/board/setup.sh`

 Establecer en .env: `BOARD_DB_URL=postgres://...your-local-db...`

Luego inicia los servicios ejecutivos:

**Habilitar ejecutivos** 
 `bun run setup:launchd -- --service all`

Siete nuevos servicios launchd comienzan: `nova-exec-ceo`, `nova-exec-cfo`, y así sucesivamente. Cada uno puede recibir mensajes directos en Telegram (o ejecutarse de forma autónoma con limitación de velocidad).

### Junta multi-VPS (avanzada)

Despliega una API PostgREST en una VPS y apunta cada nodo ejecutivo a ella. Cada ejecutivo se ejecuta en un contenedor separado con su propia clave de proveedor de IA. Se coordinan completamente a través de la base de datos compartida. Esto es opcional y solo vale la pena hacer si necesitas que los ejecutivos se ejecuten de forma independiente y se escalen.

## Gobernanza: Controles de aprobación y autonomía ganada

De fábrica, Nova siempre pide antes de publicar, enviar, o gastar. Tocas Aprobar/Revisar/Cancelar en botones inline de Telegram.

A medida que un agente construye un historial limpio, se gradúa: primero a *notificarte después*, luego a *completamente autónomo dentro de un límite de gasto*. Un fallo y vuelve a pedir. Gestionas niveles de autonomía desde un panel:

**Panel de gobernanza** 
 `GET /governance`

 Ver y ajustar niveles de autonomía por agente

 Establecer presupuestos de gasto

 Revisar el registro de auditoría

Cada acción es registrada: quién ejecutó qué, a qué costo, si tuvo éxito. Puedes revertir cualquier decisión, ajustar niveles de confianza, y ver el historial completo.

## Lista de verificación de seguridad

Antes de confiar Nova con trabajo real:

**Antes de producción** 
 Nunca cometas .env o .mcp.json con credenciales reales

 Establece TELEGRAM_USER_ID para que solo tú puedas enviar mensajes al bot

 Usa un token de bot de Telegram fuerte (si se expone, regenera de @BotFather)

 Si usas sandbox, verifica que la imagen Docker se construye y ejecuta

 Prueba el flujo de aprobación en una tarea de bajo riesgo primero

 Revisa el registro de auditoría para la primera semana de uso

 Habilita límites de gasto en agentes que tocan APIs de facturación

Los controles de aprobación de Nova, sandbox, y pistas de auditoría están diseñados para hacer que las consecuencias sean reversibles. Pero la posición inicial es siempre "pide primero, luego ejecuta" — permaneces en control.

## Siguiente: Ejecútalo, construye sobre ello

Ahora tienes todo lo que necesitas para ejecutar Nova en tu máquina o en una VPS. Envíale un mensaje y míralo funcionar. Activa el sandbox y la junta ejecutiva cuando estés listo. Ajusta niveles de autonomía conforme confíes más. Añade integraciones MCP conforme las necesites.

Nova tiene licencia MIT. Lee el código, forkéalo, personaliza agentes, añade tus propias herramientas. Es tu equipo ahora.
