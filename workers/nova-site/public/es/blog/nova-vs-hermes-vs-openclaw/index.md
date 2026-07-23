# Nova vs. Hermes vs. OpenClaw: el bueno, el malo y el feo

> Una comparación honesta y con fuentes de tres agentes de IA de código abierto y auto-alojados — OpenClaw, Hermes y Nova — con una tabla de características, gráficos, y el bueno, el malo y el feo de cada uno.

*Source: https://mynova.space/es/blog/nova-vs-hermes-vs-openclaw/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Tres agentes de IA de código abierto y auto-alojados que ejecutas tú mismo y con los que hablas desde tus apps de chat — y tres apuestas muy distintas sobre cuánto confiar en una IA con las llaves. Una mirada honesta, lado a lado.

Jake Belieny · 20 de julio de 2026 · 12 min de lectura

**Transparencia total** Yo construyo Nova. He trabajado para que esto sea justo — los números tienen fuentes, y Nova recibe su propio *malo* y *feo* como todos los demás. Si algo te parece injusto con Hermes u OpenClaw, dímelo y lo corregiré.

Los agentes de IA auto-alojados tuvieron un año de despegue. Los ejecutas en tu propio hardware, los apuntas a tus archivos y tus apps de chat, y no solo responden — *hacen cosas*: envían mensajes, ejecutan comandos, navegan la web, automatizan tu trabajo tedioso. Tres son los más comentados: **OpenClaw**, el coloso viral; **Hermes**, el agente de grado investigación de Nous Research; y **Nova** — el que yo construyo.

Comparten una forma pero discrepan, profundamente, en una pregunta: **¿cuánto debería permitírsele a una IA hacer por su cuenta?** Ese único desacuerdo explica casi todo lo demás sobre ellos — así que tenlo en mente mientras avanzamos.

## El panorama

Dos de estos son gigantes. OpenClaw pasó de su lanzamiento (como "Clawdbot") en noviembre de 2025 a un cuarto de millón de estrellas en GitHub en cuestión de meses; Hermes, respaldado por un laboratorio de investigación de IA bien financiado, no se queda muy atrás. Nova es la recién llegada — apenas liberada como código abierto, esencialmente cero estrellas. No pretendo que Nova gane un concurso de popularidad. No lo gana.

Estrellas en GitHub, julio de 2026 (en vivo). Alcance, no encaje — todo lo de abajo trata sobre el encaje.

## Conoce a los tres

**OpenClaw** — un asistente de IA personal que vive en tus apps de chat. Construido en TypeScript/Node con un compañero en Swift, conecta cualquier modelo — Claude, GPT, Gemini, DeepSeek o totalmente local — a más de 20 canales de mensajería, más de 100 "skills" comunitarias, voz, un lienzo en vivo y apps móviles. Su jugada característica es un *heartbeat* (latido): cada 30 minutos despierta, lee un `HEARTBEAT.md` y actúa por su cuenta. Con licencia MIT; ahora administrado por la OpenClaw Foundation después de que su creador, Peter Steinberger, se uniera a OpenAI en febrero de 2026.

**Hermes** — el agente auto-mejorable de Nous Research, en Python. Agnóstico al modelo hasta el extremo: cualquier endpoint compatible con OpenAI, e incluso puede reutilizar los tokens de suscripción del CLI de tu proveedor. Crea y refina sus propias skills a partir de la experiencia, te modela con un sistema de memoria dialéctica (Honcho), ejecuta un "code mode" que llama herramientas por RPC y puede hibernar en backends serverless. Incluye una TUI de terminal, integración con editores (ACP), unos 28 canales, e incluso herramientas para generar datos de entrenamiento. MIT.

**Nova** — un *equipo* de IA, no un chatbot: 24 especialistas con nombre y una junta ejecutiva, coordinados mediante descomposición de tareas, en Bun/TypeScript. La decisión que la define es la **ejecución en dos fases** — prepara trabajo seguro y luego pide tu aprobación antes de que nada se publique, se envíe o se gaste. Impulsa tus *suscripciones* de Claude/Gemini/Codex dentro de sus términos (y ahora también cualquier modelo compatible con OpenAI). Telegram, WhatsApp, Slack, Discord y tu terminal. MIT.

## Lado a lado

|  | OpenClaw | Hermes | Nova |
| --- | --- | --- | --- |
| Runtime | TypeScript / Node | Python | Bun / TypeScript |
| Licencia | MIT | MIT | MIT |
| Estrellas en GitHub (jul 2026) | ~384k | ~218k | nueva |
| Interfaz principal | Apps de chat | Terminal + chat | Apps de chat + terminal |
| Canales de mensajería | 20+ | ~28 | 5 (TG / WA / Slack / Discord / CLI) |
| Modelos | Cualquiera, incl. local | Cualquiera, incl. reuso de token de suscripción | CLIs de suscripción + cualquiera compatible con OpenAI |
| Multi-agente | Enrutamiento de sesiones | Subagentes + code-mode | 24 especialistas + junta ejecutiva |
| Aprobación humana antes de actuar | ✗ desactivado por defecto | ✗ desactivado por defecto | ✓ activado por defecto |
| Proactivo / autónomo | Heartbeat, cada 30 min | Revisión en segundo plano + cron | Programador + servicios (tareas programadas sin supervisión) |
| Skills auto-mejorables | ✗ estáticas | ✓ auto-creadas | ✓ promueve lo que funciona |
| Superficie de ejecución por defecto | host (sandbox opcional) | backends en sandbox | Control con aprobación; host por defecto, Docker opcional |
| Respaldo | Fundación (creador → OpenAI) | Laboratorio Nous Research | En solitario (Jake) |
| Madurez | Probado en batalla, enorme | Grado investigación, activo | Nueva (2026) |

## Dónde se ubica cada uno

Quita las listas de características y se alinean en dos ejes: **cuánto actúa sin ti**, y **cuánto es un asistente único frente a un equipo completo**.

El único gráfico que importa: Nova está sola en el lado de "pregunta primero" — a propósito.

## El bueno, el malo y el feo

### OpenClaw

El ecosistema es inigualable — más de 20 canales, más de 100 skills, apps móviles, voz, una UI de control pulida. Si quieres un asistente siempre activo en WhatsApp que simplemente funcione y de verdad haga cosas, nada más es tan pulido ni tan ampliamente usado. Y corre con literalmente cualquier modelo.

Por defecto, las herramientas se ejecutan **en tu host, de forma autónoma** — la sesión principal ejecuta sin un paso de aprobación. Cómodo, pero es mucha confianza para entregarle a un sistema probabilístico con alcance a tu shell, tu email y tus mensajes. El sandboxing existe, pero es opcional para las sesiones que no son la principal.

Esa confianza ha mordido a la gente. Investigadores de Cisco documentaron skills de terceros que realizaban **exfiltración de datos e inyección de prompts sin que el usuario lo supiera**, contra un registro de skills en gran medida sin verificar. En marzo de 2026, las autoridades chinas restringieron a empresas estatales, agencias y bancos su uso por preocupaciones de borrado y filtración de datos. Y en el ampliamente reportado episodio "MoltMatch", un agente creó un perfil de citas — presuntamente usando fotos de una persona real sin su consentimiento. El poder sin un control corta en ambos sentidos.

### Hermes

El más *interesante* de los tres. Genuinamente aprende — bifurcando una copia de sí mismo en segundo plano para escribir y refinar skills tras tareas difíciles — construye un modelo de ti con el tiempo, y correrá en literalmente cualquier endpoint, incluida una caja serverless que casi no cuesta nada cuando está inactiva. Para investigadores y aficionados serios, es un patio de juegos con profundidad real (hasta generar datos de entrenamiento para modelos que llaman herramientas).

Es pesado. Los archivos centrales llegan a cientos de kilobytes; hay una gran superficie que entender y operar, y el bucle de auto-mejora puede desbordarse si no lo vigilas. Y es Python — genial si ese es tu stack, fricción si no lo es.

Para obtener el precio de suscripción en Claude o Codex, Hermes **reutiliza los tokens OAuth del CLI del proveedor** para llamar a los backends de suscripción directamente desde su propio proceso. Es ingenioso y ahorra dinero — pero plausiblemente va en contra de los términos de esas suscripciones, y se rompe cada vez que un proveedor rota la autenticación. Como OpenClaw, su postura por defecto es autonomía amplia, no aprobación.

### Nova

Todo el asunto está construido en torno a **no** confiar ciegamente en la IA. La ejecución en dos fases significa que nada se publica, se envía ni se gasta hasta que tú lo apruebas — con una vista previa legible de lo que está a punto de suceder. Se lee como un organigrama (24 especialistas más una junta ejecutiva), impulsa tus CLIs de suscripción *dentro de sus términos* (sin juegos de tokens), y es una base de código coherente en Bun/TypeScript que de verdad puedes sentarte a leer. Y aprende en silencio: repite una tarea las veces suficientes y Nova promueve el plan ganador a una skill reutilizable, reasigna y auto-repara los pasos fallidos a mitad de ejecución, y hace seguimiento de qué especialistas rinden.

Es totalmente nueva y diminuta. Esencialmente cero estrellas, una comunidad de aproximadamente una persona, documentación más delgada, menos integraciones, y nada de las pruebas de batalla gratuitas que recibe un proyecto de 200k estrellas. Menos canales que OpenClaw. Si quieres un enorme mercado de skills *hoy*, aún no está aquí.

Su aprendizaje se gana, no es instantáneo — Nova promueve una skill solo tras un puñado de ejecuciones *exitosas*, así que mejora mediante la repetición en lugar de la reflexión sobre la marcha que hace Hermes. El modelo de organigrama tiene una curva de aprendizaje, y aunque las peticiones simples toman una vía rápida (no la junta completa), la postura por defecto es participativa: el control de aprobación te mantiene en el bucle, y lo aflojas con piloto automático y autonomía ganada a medida que crece la confianza. Si quieres un agente totalmente sin intervención desde el primer minuto, esa cautela deliberada se sentirá como fricción.

## Entonces, ¿cuál deberías elegir?

- **OpenClaw** — si quieres el ecosistema más grande y un asistente pulido y sin intervención en tus apps de chat hoy, y estás dispuesto a ponerlo en sandbox y verificar las skills tú mismo.

- **Hermes** — si eres investigador o aficionado serio que quiere un agente agnóstico al modelo y auto-mejorable, y no te importa el peso de Python ni la salvedad del reuso de tokens.

- **Nova** — si quieres un *equipo* de IA que pregunta antes de actuar, se mantiene dentro de los términos de tu suscripción y te mantiene en el bucle por diseño — y puedes vivir con un proyecto joven.

Aquí no hay un ganador universal — solo un ganador para *tu* tolerancia al riesgo. OpenClaw y Hermes apuestan a que la autonomía vale la exposición. Nova apuesta lo contrario: que lo que se interpone entre un agente útil y un error costoso es un humano tocando *aprobar*. Elige la apuesta con la que te sientas cómodo haciéndola con tu shell, tus llaves y tus clientes.

Fuentes y notas: conteos de estrellas de la API de GitHub (julio de 2026); historia, nombres y problemas de seguridad/regulatorios documentados de OpenClaw de [Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) e informes públicos; detalles de Hermes y Nova de sus repositorios públicos. Los números se mueven — trátalos como una instantánea de julio de 2026.
