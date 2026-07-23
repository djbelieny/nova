# Nova

> Nova es una plataforma de IA de código abierto auto-alojada: 24 agentes especialistas, una base de conocimiento que tú alimentas, automatizaciones orientadas a eventos, playbooks, procesos duraderos, conectores de negocio y aprobación humana antes de que nada se publique, gaste o envíe — desde Telegram hasta tu terminal.

*Source: https://mynova.space/es/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova son 24 agentes especialistas más una capa de automatización que reacciona a eventos — webhooks, métricas, eventos de conectores — y ejecuta el trabajo repetitivo en segundo plano: playbooks, procesos duraderos, una base de conocimiento que tú alimentas. Accede desde Telegram, Slack, Discord o tu terminal; ejecútalo con tus propias suscripciones de modelos y tu propia máquina. Prepara con libertad, y luego pregunta antes de que algo se publique, gaste o envíe.

## Cada solicitud ejecuta el mismo flujo honesto.

Sin enrutador mágico, sin caja negra. Ya sea que comience como un mensaje que envías o como un evento que dispara una automatización, una solicitud se clasifica, se desglosa si es grande y se ejecuta en dos fases — con la mitad consecuente controlada por ti.

01 · clasificar

### Tres niveles, el más barato primero

Los mensajes cortos van directamente al modelo. Las solicitudes repetidas se resuelven desde un caché de patrones de planes que funcionaron antes. Solo las solicitudes genuinamente nuevas y complejas pagan por la clasificación de LLM.

02 · desglozar

### Subtareas con dependencias

Las solicitudes complejas se convierten en un plan: subtareas, orden de dependencias y un agente especialista para cada una. Las ramas independientes se ejecutan en paralelo.

03 · preparar → aprobar → ejecutar

### Trabajo seguro primero, luego el control

Investigación, borradores e imágenes suceden libremente. Publicación, envío y gasto esperan la tarjeta de aprobación — Aprobar, Revisar o Cancelar, desde tu chat.

## Construido como si manejara tus credenciales — porque lo hace.

Nova se conecta a tu correo electrónico, calendario, CRM y cuentas de anuncios. La postura de seguridad lo trata en serio.

- aprobación →**Ejecución en dos fases.** Las acciones consecuentes se separan de las seguras y se controlan con aprobación explícita, por categoría, por usuario.

- local →**Tus datos se quedan en casa.** Los mensajes, la memoria y las tareas viven en SQLite local con aislamiento por usuario. Las incrustaciones se calculan en tu máquina.

- encriptado →**Credenciales en reposo.** Los tokens OAuth se encriptan con AES-256-GCM; las firmas de webhook se verifican; las sesiones del panel se autentican.

- tuyo →**Tus claves, tus modelos.** Se enruta a través de CLIs de Claude, Gemini y Codex bajo tus propias cuentas, con alternancia de límite de velocidad.

- gobernado →**Salvaguardas para un negocio.** Límites de gasto, matrices de aprobación y verificaciones de PII; permisos basados en roles; secretos encriptados; y un registro de auditoría de cada acción consecuente.

## Ahora dirige la operación, no solo el chat.

Nova está orientada a eventos y es resistente en procesos: aliméntala con tu conocimiento, conéctala a tus herramientas y deja que ejecute el trabajo repetible en segundo plano — con cada paso consecuente pasando por la misma barrera de aprobación.

Segundo cerebroAliméntala con PDFs, documentos y URLs — recuperados con citas, incrustados en tu máquina
 PlaybooksEscribe un procedimiento una vez, ejecútalo muchas veces con variables
 AutomatizacionesEvento → condición → flujo de trabajo, incluyendo disparadores semánticos
 Procesos duraderosFlujos de varios días que esperan un temporizador o una firma, y luego continúan
 Extracción de documentosFacturas y formularios → datos estructurados y validados
 ConectoresStripe, Shopify, Zendesk, HubSpot — lectura y escritura, bidireccional
 PolíticasLímites de gasto, matrices de aprobación, verificaciones de PII — barreras que solo agregan fricción
 Reportes de ROITareas automatizadas, horas ahorradas, valor vs. costo — por departamento

## 24 especialistas. Un chat.

Cada agente tiene su propio prompt del sistema, herramientas, habilidades y acceso MCP — un equipo de trabajo orientado hacia marketing y operaciones, y completamente tuyo para editar. Agregar un agente es escribir un archivo markdown.

HeliosPublicidad pagada
 PixelRedes sociales
 KaiEscritura de contenido
 OrionMarketing por email
 MorpheusContenido de video
 ArchitectDesarrollo web
 AthenaEstrategia empresarial
 DigitAnálisis de datos
 EchoSoporte al cliente
 FluxIngeniería de embudo
 QuillEscritura de becas
 LexLegal y cumplimiento
 HeliaRelaciones públicas
 BridgeAsociaciones
 OraclePredicción de tendencias
 CipherCiencia de datos
 RiftCiberseguridad
 JouleAutomatización de flujos de trabajo
 NexusConstrucción de comunidad
 AuraVoz de marca
 ZenProductividad
 TesseractPensamiento sistémico
 MagnusSEO
 CyraOptimización de sitios web

## Convoca una reunión de junta cuando la pregunta es lo suficientemente importante.

Una capa distribuida opcional: siete nodos ejecutivos, cada uno con su propia persona de razonamiento, deliberando sobre una base de datos compartida. Análisis independiente, una pre-mortem adversarial, luego opciones sintetizadas con puntuaciones de confianza — tú eliges, ella ejecuta.

/board ¿deberíamos cambiar a precios basados en el uso?

CEOPensamiento del primer día, volantes, obsesión por el clientevisión a largo plazo
 CFOEconomía unitaria y disciplina de precioseficiencia de capital
 CMOExtraordinario sobre incremental; tribus sobre embudosaudiencia y marca
 CTOTodo falla; diseña para elloarquitectura y confiabilidad
 COOSeguimiento de ejecución, búsqueda de cuellos de botellaconvierte decisiones en trabajo
 ResearchTeoría de agregación, economía de plataformasinteligencia de mercado
 CriticInversión y pre-mortem; solo análisismantiene a todos honestos

## Baterías incluidas, nada bloqueado.

### Cualquier modelo, sin ataduras

Funciona con tus suscripciones de Claude, Gemini o Codex vía sus CLIs, o añade cualquier modelo compatible con OpenAI — OpenRouter, OpenAI, Ollama o vLLM locales — con un solo comando. Suscripción primero, tus claves.

### Una verdadera CLI nova

Un solo comando `nova` lo ejecuta todo, y `nova connect` te lleva a tu Nova en marcha desde cualquier terminal — local o VPS — con actividad de agentes en vivo y aprobaciones en línea.

### Base de conocimiento (RAG)

Aliméntala con PDFs, documentos y URLs — fragmentados e incrustados en tu máquina, recuperados en todos los agentes con citas de fuentes. Personal, de equipo o por agente.

### Memoria persistente

Hechos, objetivos y tareas con búsqueda vectorial local — Nova recuerda entre conversaciones e inyecta el contexto correcto.

### Aprendizaje y caché de patrones

Los planes exitosos se almacenan en caché y se reutilizan; con el tiempo, los aciertos comprobados se promueven a habilidades aprendidas.

### Programador y servicios proactivos

Resúmenes matutinos, controles inteligentes, tareas recurrentes y condicionales — funciona mientras tú no lo haces.

### Integraciones y conectores

Servidores MCP (Notion, Google Workspace, Playwright, Cloudflare, GoHighLevel) más conectores de negocio bidireccionales — Stripe, Shopify, Zendesk, HubSpot — con credenciales por usuario.

### mcp2cli — herramientas sin el impuesto de contexto

Los agentes descubren herramientas bajo demanda desde la shell en lugar de cargar cada esquema en el prompt, así el conjunto de herramientas crece sin inflar el contexto. Las propias capacidades de Nova funcionan igual.

### Datos conectados

Consulta los sistemas donde viven tus números — un endpoint HTTP, un archivo SQLite de solo lectura o un conector — para reportes y para los agentes en plena tarea.

### Gobernanza y auditoría

Escalera de autonomía ganada, límites de gasto y matrices de aprobación, permisos basados en roles, secretos encriptados y un registro completo de acciones con reportes de ROI.

### 45 habilidades

Generación de imágenes, creación de DOCX/XLSX/PPTX/PDF, escritura de investigación, extracción de anuncios — invocadas por agentes según sea necesario.

### Voz

Llamadas entrantes y salientes vía Twilio; mensajes de voz transcritos con Groq o Whisper local.

## En una sola línea.

$ curl -fsSL https://mynova.space/install | bash

Una línea clona Nova, configura [Bun](https://bun.sh) y la CLI de [Claude Code](https://claude.ai/claude-code) por ti, y luego un asistente guiado conecta Telegram y tu proveedor de IA — sin editar archivos, y detecta tu ID de usuario de Telegram automáticamente. Lo único que necesitas antes es un token de bot de @BotFather. ¿Prefieres clonarlo tú mismo? `git clone https://github.com/djbelieny/nova && cd nova && bash bootstrap.sh`. Todo lo demás es opcional y está documentado en el repositorio.

## ¿Quieres Nova — sin la configuración?

No todos tienen el tiempo — ni un ingeniero disponible — para montar su propio equipo de IA. Si quieres Nova funcionando para tu negocio pero no quieres construirlo tú mismo, trabaja conmigo directamente: **configuración hecha por ti**, **consultoría y asesoría**, y **agentes e integraciones a medida** construidos en torno a cómo trabajas de verdad. Servicios pagados, ajustados a lo que necesitas.

Reservado directamente conmigo, Jake Belieny.
