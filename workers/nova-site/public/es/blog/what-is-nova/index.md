# ¿Qué es Nova? Tu equipo de IA de código abierto, explicado

> Nova es un equipo de IA auto-alojado y de código abierto que diriges desde Telegram: 24 agentes especialistas, una junta ejecutiva, aprobación humana antes de cualquier envío o gasto, ejecución en sandbox, y autonomía ganada. Esto es lo que hace y cómo la gente la utiliza.

*Source: https://mynova.space/es/blog/what-is-nova/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova es una plataforma auto-alojada y de código abierto que convierte un grupo de agentes de IA especialistas en algo más parecido a una empresa que a un chatbot — y te pregunta antes de hacer nada que envíe, gaste o comunique.

Jake Belieny · 15 de julio de 2026 · 8 min de lectura

La mayoría de "asistentes de IA" son un modelo detrás de una caja de texto. Preguntas, contesta, y cada paso importante sigue siendo cosa tuya. Nova tiene una forma diferente. Es un **organigrama**: dos docenas de especialistas, una junta ejecutiva que razona sobre estrategia, y una capa de coordinación que descompone una solicitud en tareas, las ejecuta en paralelo, y se detiene para tu aprobación antes de tocar el mundo real.

Y funciona donde ya estás. Mensajeas a Nova en Telegram (o WhatsApp o Slack) de la misma forma que mensajearías a un compañero — y funciona en **tu** máquina, con **tus** claves API o suscripciones, con tus datos guardados en almacenamiento local. Tiene licencia MIT, así que puedes leer cada línea, cambiar cualquier cosa, y no debes nada a nadie por tarifa por asiento.

**La versión de una línea** Nova es personal de IA auto-alojado: un equipo de agentes que planifican, redactan y analizan por su cuenta — pero obtienen tu aprobación antes de que nada salga de la oficina.

## Cómo un mensaje se convierte en trabajo

Cuando envías un mensaje a Nova, primero **clasifica** qué estás pidiendo. Una pregunta rápida obtiene una respuesta directa. Una tarea enfocada se enruta al especialista correcto. Algo grande — "planifica y lanza nuestra campaña de primavera" — se **descompone** en un plan consciente de dependencias y se ejecuta en varios agentes a la vez.

Luego viene la parte que hace que Nova sea confiable. El trabajo sucede en **dos fases**:

- **Preparar** — la mitad segura. Investiga, redacta el contenido, genera la imagen, calcula los números. Nada ha salido de la oficina aún.

- **Aprobar** — Nova te muestra exactamente qué está a punto de hacer, con botones en línea: *Aprobar*, *Revisar*, o *Cancelar*.

- **Ejecutar** — solo después de que apruebes hace lo importante: publica la publicación, envía los correos, lanza la campaña, gasta el dinero.

## El equipo que realmente estás contratando

Bajo el capó, Nova tiene **24 agentes especialistas**, cada uno con su propio dominio, herramientas y indicación del sistema. No tienes que conocer sus nombres — Nova enruta al correcto — pero ayuda ver la forma del equipo:

#### Crecimiento y marketing

Helios (anuncios pagos), Pixel (redes sociales), Kai (contenido), Orion (email), Magnus (SEO), Morpheus (video), Flux (embudos).

#### Estrategia y operaciones

Athena (estrategia empresarial), Oracle (pronóstico de tendencias), Tesseract (pensamiento de sistemas), Zen (productividad), Bridge (asociaciones).

#### Datos e ingeniería

Digit (análisis), Cipher (ciencia de datos), Architect (desarrollo web), Joule (automatización), Rift (seguridad).

#### Voz y apoyo

Aura (marca de voz), Echo (servicio al cliente), Helia (relaciones públicas), Nexus (comunidad), Quill (subvenciones), Lex (legal), Cyra (optimización del sitio).

Por encima de los especialistas se sienta una **Junta Ejecutiva** — CEO, CFO, CMO, CTO, COO, Jefe de Investigación, y un Crítico — cada uno modelado en una forma distinta de pensar. Haz una pregunta estratégica difícil con `/board` y se reúnen: análisis independiente, un pre-mortem del Crítico, luego una síntesis de opciones con puntajes de confianza para que elijas.

## Construida para que realmente puedas confiarle las llaves

Un equipo de IA que puede enviar correos y gastar presupuesto de anuncios solo es útil si también es *seguro*. La versión más reciente de Nova es toda sobre eso — convirtiendo "probablemente no hará nada tonto" en garantías reales.

### Ejecución en sandbox

Las tareas del agente pueden ejecutarse dentro de un contenedor endurecido — sistema de solo lectura, sin acceso a los archivos de tu host más allá de un espacio de trabajo por tarea, sin ruta a tus credenciales — así que una página web que intente secuestrar un agente a través de un párrafo ingeniosamente redactado no puede alcanzar nada que importe. Y permanece en tu **suscripción**: Nova comparte tu plan de Claude, OpenAI o Gemini en el sandbox en lugar de cambiarte silenciosamente a facturación por token.

### Autonomía ganada, no un cheque en blanco

Todo tipo de acción comienza en **siempre preguntar**. Cuando un agente construye un registro limpio en una tarea dada — digamos, "envía el boletín semanal" — se gradúa: primero a *notificarte después*, luego a *completamente autónomo dentro de un límite de gasto*. Un fracaso o un rechazo y vuelve directamente a preguntar. Tú decides cuánta cuerda obtiene cada agente, y puedes verlo y cambiarlo desde un panel.

### Un registro de auditoría para todo

Toda acción importante se escribe en un registro — qué ejecutó, qué agente, cuánto costó, si funcionó. Después de cada tarea, un agente incluso **verifica su propio trabajo** ("¿se envió realmente el correo? ¿la página se renderiza?") antes de reportar hecho. Calidad empresarial principalmente significa *responder después del hecho*, y Nova lo es.

## Para qué lo usa la gente

Porque Nova es un equipo más que una herramienta única, las solicitudes útiles tienden a ser las que entregarías a un empleado capaz. Algunos casos reales:

### Ejecuta el marketing que se ejecuta en un cronograma

Boletines, calendarios de redes sociales, reportes de anuncios. "Publica tres veces esta semana sobre el lanzamiento", "resume cómo se desempeñó el gasto de anuncios del mes pasado", "convierte esta publicación de blog en un hilo de LinkedIn y un carrusel". Nova redacta, tú apruebas, publica — y una vez que confías en una tarea recurrente, dejas que se ejecute sola.

### Convierte un objetivo permanente en trabajo continuo

Cuéntale a Nova un objetivo — "aumenta el boletín a 5.000 suscriptores" — y no solo asiente. Desglosa el objetivo en tareas concretas, las programa, ejecuta durante días y semanas, e informa el progreso. Es la diferencia entre una herramienta que operas y personal que persigue un resultado.

### Toma las grandes decisiones con una junta detrás de ti

Para las decisiones que merecen más de una opinión, la junta ejecutiva es un socio genuino de pensamiento. "¿Deberíamos expandirnos a la UE?" reúne siete perspectivas, expone los modos de falla que no pensaste, y te entrega opciones con puntuación — no una sola suposición segura.

#### Fundadores solo

Un equipo completo de marketing, datos y operaciones que puedes permitirte — en tus propias cuentas, preguntando antes de gastar.

#### Equipos pequeños

Descarga el trabajo repetitivo (reportes, borradores, programación) con un registro de auditoría y controles de aprobación que todo el equipo puede ver.

#### Constructores y experimentadores

Con licencia MIT y auto-alojado. Léelo, haz un fork, añade tus propios agentes, conecta tus propias herramientas.

#### Conscientes de la privacidad

Tus datos residen en almacenamiento local en tu máquina. Tus claves, tu suscripción, tus reglas.

## Primeros pasos

Nova está diseñado para llevarte del clon al primer mensaje con casi ninguna fricción. Un solo comando — `bash bootstrap.sh` — instala cualquier cosa que falte ([Bun](https://bun.sh), la CLI de Claude Code) y ejecuta un asistente guiado que solicita un token de bot de Telegram y un proveedor de IA, configura algunos agentes iniciales y verifica la conexión. Incluso detecta tu ID de usuario de Telegram automáticamente, y es reanudable si te alejas. El resto (la junta ejecutiva, integraciones adicionales) puedes activarlo cuando lo desees.

- Clona el repo y ejecuta `bash bootstrap.sh`.

- Escríbele a tu bot en Telegram — Nova te saluda con ideas para empezar que puedes tocar, y `/team` presenta a tus especialistas en lenguaje sencillo.

- Activa sandboxing, autonomía, y la junta auto-alojada según crezcas en ello — todo opcional, nada obligatorio.
