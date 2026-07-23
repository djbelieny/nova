# Nova ahora habla todos los modelos

> Un lote de mejoras: ejecuta cualquier modelo compatible con OpenAI junto a tus CLIs de suscripción, un verdadero comando nova con nova connect, canales de terminal + Discord e invitaciones de equipo autoservicio — sin tocar el modelo de confianza auto-alojado y con controles de aprobación.

*Source: https://mynova.space/es/blog/whats-new/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Un lote de mejoras hace a Nova más flexible y más fácil de convivir — cualquier modelo, una CLI de verdad, más lugares para hablar con ella y acceso de equipo autoservicio — sin cambiar lo que es.

Jake Belieny · 20 de julio de 2026 · 6 min de lectura

Nova siempre ha sido un equipo de IA auto-alojado y con controles de aprobación que ejecutas en tu propia máquina. Esta versión no toca nada de eso. Lo que hace es ensanchar las puertas: más modelos pueden impulsar tus agentes, por fin hay un comando de verdad para ejecutarlos, puedes hablar con Nova desde más lugares, y agregar un compañero ya no significa editar archivos de configuración.

Cuatro temas: **cualquier modelo**, **una CLI de verdad**, **más lugares para hablar con ella** y **configuración y acceso de equipo más fáciles**. Nada de esto cambia el modelo de confianza — Nova sigue preguntando antes de que algo se envíe o gaste.

## Usa cualquier modelo — sin perder la ventaja de la suscripción

Nova ya funciona con tus **suscripciones** de Claude, Gemini y Codex impulsando sus CLIs directamente. Ese es todo el truco detrás de su economía: un costo mensual fijo en lugar de una factura de API medida, y uso agéntico completo de herramientas — el mismo plan que ya pagas, puesto a trabajar por un equipo de agentes.

Ahora puedes agregar **cualquier modelo compatible con OpenAI** junto a ellos — una ruta de [OpenRouter](https://openrouter.ai), un modelo de OpenAI, o una máquina local de `Ollama` o `vLLM` en tu propia red. Agrega uno con una sola entrada en `config/providers.json`, con `nova providers add`, o con un clic en la sección Modelos del panel. Las CLIs de suscripción siguen siendo el valor predeterminado y siguen primero; los nuevos modelos se acomodan junto a ellas.

Y los modelos de API no son ciudadanos de segunda clase. También pueden usar tus herramientas — impulsando el mismísimo sandbox y puente MCP que usan las CLIs — así que un agente en un modelo local todavía puede navegar, escribir archivos y llamar integraciones bajo los mismos controles de aprobación.

**Una línea de principios** Nova sigue **impulsando las CLIs oficiales** en lugar de cosechar tokens de suscripción para golpear endpoints privados. Eso es lo que mantiene tu suscripción claramente dentro de los términos — y cualquier modelo nuevo que agregues usa su propia clave API adecuada, no una prestada.

## Un comando `nova` de verdad

Se acabó memorizar `bun run esto, bun run aquello`. Ahora hay una sola CLI `nova`, instalada en tu PATH, que da la cara por todo:

- `nova start` — levanta tu Nova.

- `nova doctor` — verificación de salud y diagnósticos copiables.

- `nova update` — trae lo último y reinstala.

- `nova providers add` — conecta un nuevo modelo.

- `nova invite` — genera un código para agregar un compañero.

Lo que más destaca es **`nova connect`** — un cliente de terminal que se conecta a tu Nova *en ejecución*, ya sea en esta laptop o en tu VPS. Obtienes una vista en vivo de lo que tus agentes están haciendo ahora mismo, y puedes **aprobar, cambiar o cancelar** en línea sin salir de la terminal. Como Nova se ejecuta siempre activa, puedes entrar desde cualquier terminal, en cualquier lugar, y retomar exactamente donde están las cosas.

## Nuevos lugares para hablar con Nova

Nova ya era multicanal — Telegram, WhatsApp y Slack alimentan todos la misma tubería. Esta versión agrega dos más:

- Tu **terminal** — `nova chat` te da una conversación completa con Nova justo en el shell.

- **Discord** — ejecuta Nova como un bot de Discord para ti o tu comunidad.

Ambos son solo nuevos adaptadores sobre el patrón existente: la misma tubería de mensajes, la misma clasificación, la misma ejecución en dos fases, los mismos controles de aprobación. Una solicitud que haces en Discord se maneja exactamente como una que enviarías en Telegram — nada sobre cómo Nova decide o actúa cambia con la superficie.

## Configuración más fácil, y agregar a tu equipo

Ahora puedes gestionar modelos, canales e invitaciones desde el **panel** o la **CLI** — sin editar la configuración a mano para activar algo. Enciende un canal, agrega un modelo, emite una invitación, todo desde una pantalla o un solo comando.

Agregar un compañero solía significar rastrear un ID de usuario numérico y pegarlo en un archivo. Ahora generas un **código de invitación** con `nova invite`, se lo entregas a la persona, y lo canjea en Telegram o Discord — tú apruebas con un toque. Los roles vienen incluidos: `nova invite member` o `nova invite admin`.

**Los secretos se quedan donde están** Nada de esto mueve tus credenciales fuera de tu servidor. Las pantallas de gestión muestran solo qué claves están *configuradas* — nunca sus valores. Tus claves nunca salen de la máquina en la que ejecutas Nova.

## Sigue siendo la misma Nova

Todo lo que hacía a Nova digna de confianza permanece intacto. Sigue siendo auto-alojada y con licencia MIT. Sigue funcionando con tus claves y tu máquina. Y sigue pidiendo tu aprobación antes de que algo se envíe, mande o gaste.

Estas mejoras añaden alcance y pulido — más modelos, un comando de verdad, más canales, invitaciones autoservicio — sin tocar el modelo de confianza que las sustenta. El mismo equipo, más puertas.
