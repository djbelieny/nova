# Por qué Nova está construida de la forma en que está

> La filosofía detrás de la arquitectura de Nova: por qué un organigrama en lugar de un chatbot, por qué la confianza se ingeniera, por qué la autonomía debe ser ganada, y por qué el sandbox y la auditabilidad son innegociables.

*Source: https://mynova.space/es/blog/design-decisions/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Ocho decisiones de diseño que hacen Nova confiable, autónoma, y verdaderamente tuya. La filosofía detrás de cada elección, desde arquitectura hasta autonomía hasta auditabilidad.

Jake Belieny · 15 de julio de 2026 · 12 min de lectura

Construir un sistema que pueda actuar en tu nombre no es lo mismo que construir un sistema que funcione bien. La forma de Nova proviene de siete años pensando sobre la diferencia. Este ensayo describe por qué cada pieza está ahí y qué problema resuelve — y dónde elegí un buen diseño sobre otro mejor, porque "mejor" habría hecho la plataforma inutilizable.

## Un organigrama, no un chatbot

La primera decisión: Nova no es un modelo jugando el rol de cada trabajo. Son 24 especialistas, cada uno con un dominio, un manual, y herramientas dedicadas. Algunas personas ven eso y preguntan: ¿no es eso solo enrutamiento? ¿No necesitas todavía el motor de razonamiento general debajo?

No. Cada especialista lo es. Helios sabe publicidad pagada porque todo su contexto, entrenamiento, y acceso a herramientas está estructurado alrededor de ello. Cipher sabe cómo razonar sobre datos porque esa es toda la forma de su indicación de sistema. Lex no es un asistente general leyendo jerga legal; es un abogado.

La alternativa — un modelo enrutando a diferentes conjuntos de herramientas — se siente más simple. Te ahorra de gestionar 24 indicaciones. Pero pierde algo crucial: profundidad. Un modelo general razonando sobre tus campañas de Meta por primera vez hace diferentes compensaciones que un especialista que ha razonado sobre 10,000 campañas. Priorizan diferentemente. Hacen preguntas que no pensaste en hacer. Detectan riesgos porque eso es todo lo que observan.

La compensación es complejidad de enrutamiento. Tienes que clasificar cada solicitud entrante (heurístico → caché de patrones → LLM) y elegir el agente correcto. Son tres niveles de clasificación para evitar llamar al costoso cada vez. Vale la pena, porque la respuesta del especialista es mejor.

Por encima de los especialistas se sienta una **Junta Ejecutiva** — siete roles, cada uno modelado en una forma distinta de pensar. El CEO razona en términos de bucles de volante y preguntas de Día 1. El CFO piensa en economía unitaria. El Crítico hace análisis previos. Cuando preguntas algo difícil — "¿deberíamos expandirnos a un nuevo mercado?" — no solo debaten; razonan desde sus primeros principios diferentes, y obtienes siete perspectivas más una síntesis. No consenso, sino apoyo para decisiones.

**Decisión de diseño** Los especialistas vencen a los generalistas en profundidad. Un único motor de razonamiento pierde el rigor que viene de la experiencia.

## La confianza es el producto

No confías en un sistema porque esté confiado. Confías en él porque pregunta antes de hacer cualquier cosa que importe. La ejecución de dos fases es donde eso vive.

Fase uno: preparar. Investigar, escribir, generar imágenes, ejecutar el análisis. Todo lo que es seguro y reversible. Nada ha salido del edificio. Ves exactamente qué está a punto de suceder.

Fase dos: ejecutar. Publicar el post. Enviar el email. Gastar el dinero. Crear la campaña. Solo después de que toques *Aprobar* en Telegram.

Eso es. Ese es el núcleo del mecanismo de confianza. No "Nova es lo suficientemente inteligente para no hacer nada tonto" — eso no es verdad, y no es el punto. En su lugar: "Nova hace el trabajo seguro, te muestra el plan, y se detiene hasta que digas que sí." Nada consecuencial sucede sin un humano en el ciclo. Nada.

La alternativa es autonomía por nivel de confianza — algunas acciones se ejecutan sin preguntar si Nova tiene un historial limpio. Nova tiene eso (autonomía ganada, descrita abajo), pero es un potenciador. El piso es siempre: pregunta antes de ejecutar.

Lo que hace que esto realmente funcione es que el control de aprobación vive en tu aplicación de mensajería (Telegram, Slack, WhatsApp). No tienes que navegar a un panel o recordar una contraseña. Obtienes una notificación. La lees. Tocas un botón. La aprobación sin fricción lo hace válido: realmente lo haces en lugar de rechazar advertencias.

## Autonomía ganada, no un cheque en blanco

El momento en que un sistema nunca pregunta es el momento en que no puedes confiar en él. Y el momento en que pregunta por todo es el momento en que se convierte en una molestia y dejas de prestar atención.

La autonomía ganada vive en el medio. Cada tipo de acción (enviar boletines, publicar posts en redes, crear campañas de ads) comienza en *siempre preguntar*. Si un agente construye un historial limpio — digamos, tres envíos exitosos de boletín seguidos sin rechazos — se gradúa: primero a *notificarte después de que suceda*, luego a *completamente autónomo dentro de un límite de gasto*. Un fallo o un rechazo y vuelve a preguntar inmediatamente.

Estableces las reglas. Decides cuánta cuerda obtiene cada agente, por tipo de acción. Puedes ver y cambiar en el panel. El sistema aprende y se deja a tu historial, pero nunca silenciosamente. Si un agente falla suficientes veces, ha ganado su degradación.

Esto resuelve el problema real, que no es "¿debería la IA ser autónoma?" Es "¿en qué base obtiene el derecho a ser autónoma?" La base es confianza ganada — un historial en ese tipo de acción específica. No confianza global. No un interruptor. No una oración.

## Auto-alojada y local-first

Nova se ejecuta en tu máquina. Lee tus mensajes de Telegram de tu bot. Almacena tus datos en bases de datos SQLite locales en tu disco. Tus claves de API se quedan en tu archivo `.env`. Nunca envías tus datos a la nube a menos que le pidas explícitamente a un agente de Nova, y aun así solo lo necesario para esa tarea.

Esta no fue la opción más fácil. Un servicio alojado es más simple de construir, más simple de escalar, y mucho más simple de cobrar. Alojarlo significa que me convierto en el controlador de datos — colecto la información, soy responsable de la seguridad, me demandan cuando algo se rompe. El auto-alojamiento pone esa responsabilidad sobre ti. Si Nova filtra tus datos, es porque no aseguraste tu VPS adecuadamente, no porque tuve un incidente de seguridad en mi centro de datos.

Pero ese es exactamente el punto. Tus datos deberían ser tu responsabilidad. Tus mensajes de Telegram no deberían transitar a través de un servidor que controlo. Tu gasto en ads no debería requerir darme claves de API. Deberías poder leer cada línea de código, forquear todo, y no deberme nada.

El auto-alojamiento también hace Nova radicalmente más barato. No me pagas por mensaje o por mes por asiento. Pagas por tu suscripción de Claude (o Gemini, u OpenAI). Eso es todo. Nova solo usa lo que ya tienes. Esto solo funciona porque Nova es de código abierto y tiene licencia MIT — puedes tomarlo, cambiarlo, ejecutarlo para siempre.

## Enrutamiento orientado a suscripción

Cuando Nova clasifica una solicitud o descompone una tarea compleja, tiene que llamar a un modelo de IA. Tres opciones: usar tu suscripción existente de Claude/Gemini/OpenAI, o cambiar a facturación por token, o negociar una tasa mayorista con el proveedor.

Nova elige tu suscripción. Siempre. Si tienes un plan Claude Pro, Nova lo prefiere. Si tienes un plan de negocios de Gemini, lo prefiere. Solo si has configurado explícitamente una preferencia diferente — o tu suscripción alcanza su límite de velocidad — Nova vuelve a un proveedor diferente.

Esta es una pequeña decisión con grandes consecuencias. Significa que el costo de ejecutar Nova no te sorprende. No aparece en una factura separada. No requiere que configures OAuth y confíes en un tercero con tus credenciales de API. Solo usas lo que ya estás pagando.

La compensación es que Nova no puede optimizar puramente en costo o latencia. Si estás en Gemini pero Claude sería más rápido, Nova aún prefiere Gemini porque esa es tu suscripción. Esa es una pérdida deliberada de optimización a cambio de transparencia y previsibilidad.

## El sandbox es la entrada a la verdadera autonomía

Un agente que puede enviar emails o gastar presupuesto de ads es aceptable solo si no puede de alguna manera leer tus claves SSH, exfiltrar tu base de datos, o pivotar a otros sistemas. El sandbox es cómo funciona eso.

Cuando un agente Nova ejecuta una tarea que implica entrada no confiable — raspar una página web, analizar un archivo que un cliente subió, ejecutar código que alguien te pasó — esa ejecución sucede dentro de un contenedor endurecido. Sistema de solo lectura, sin acceso al sistema de archivos más allá de un directorio de preparación específico de tarea, sin camino a tus credenciales. Una página web maliciosa no puede secuestrar el agente y usarlo como un trampolín a tu máquina.

Sin sandbox, no puedes delegar con seguridad trabajo consecuencial a un agente. Un atacante que encontró un jailbreak en el razonamiento de la IA podría potencialmente comprometer tu sistema completo. El sandbox no previene el jailbreak, pero limita el radio de explosión: el agente se ejecuta en una jaula.

Esto es innegociable para cualquier sistema en el que confíes con trabajo real. Y es costoso — la containerización tiene gastos, latencia de red, costos de recursos. Pero la alternativa es: no confies en el agente con trabajo consecuencial. Elegí el camino costoso.

## Una junta ejecutiva con personas distintas

El pensamiento de verdad única es lo que mata a las compañías. Tomas una decisión basada en una perspectiva, pierdes el riesgo, y la compañía absorbe el golpe. La junta ejecutiva es la forma en que Nova previene eso.

En lugar de una respuesta confiada, obtienes siete. El CEO piensa en términos de apalancamiento y efectos de volante. El CFO piensa en economía unitaria. El CMO piensa en comunidades y permiso. El CTO piensa en sistemas fallando. El Crítico piensa en qué podría salir mal. Razonan desde primeros principios diferentes. Detectan riesgos diferentes. Ninguno es más inteligente que los otros; simplemente están pensando en direcciones diferentes.

Cuando le haces una pregunta difícil a la junta, obtienes de tres a cinco opciones calificadas, cada una con un nivel de confianza y una justificación. Eliges una. La decisión se registra. Eso importa.

La compensación es latencia y costo — estás ejecutando siete sesiones de razonamiento en lugar de una. Y tienes que elegir una opción tú mismo en lugar de obtener una recomendación. Pero esa segunda parte es todo el punto. Para decisiones que importan, deberías ver el razonamiento, pesar las opciones, y elegir. La junta te da la materia prima para pensar.

## Una pista de auditoría para todo

Después de que un agente Nova ejecuta una tarea, tienes un registro de lo que sucedió: qué agente, qué hicieron, cuánto tiempo tardó, cuánto costó, si funcionó. Después de que la tarea se completa, el agente incluso verifica su propio trabajo — "¿se envió realmente el email?" "¿se renderiza la página?" — antes de reportar hecho. Si la verificación falla, la tarea se queda abierta hasta que decidas qué hacer.

Esto no es teatro de seguridad. Es la base de la IA de grado empresarial. No puedes ser responsable de algo que no puedes explicar. No puedes depurar algo que no mediste. No puedes defender algo que no puedes describir.

El costo es que cada decisión, cada acción, se escribe en un registro. Más almacenamiento, más E/S, más datos para gestionar. Más importante, significa que tienes que enfrentar lo que el sistema realmente hizo, no lo que esperabas que hiciera. Eso es incómodo a veces. También es la única forma de ejecutar esto responsablemente.

**Decisión de diseño** "Grado empresarial" generalmente significa respondible después del hecho. La auditabilidad no es una característica; es el requisito.

## Las compensaciones son reales

Cada una de estas decisiones cuesta algo. Los especialistas vencen a los generalistas pero añaden complejidad de enrutamiento. Los controles de aprobación construyen confianza pero añaden fricción. La autonomía ganada previene cheques en blanco pero requiere rastrear estado. El sandbox bloquea ataques pero añade latencia. El auto-alojamiento es barato pero pone carga operativa en ti. Una junta ejecutiva previene pensamientos de grupo pero ralentiza decisiones. La auditabilidad construye responsabilidad pero requiere registrar todo.

Elegí cada compensación porque la alternativa — un sistema de IA confiado, autónomo, de alta velocidad en el que nadie realmente confía con nada importante — parecía peor.

Nova es más lento de lo que podría ser. Es más complejo de lo que podría ser. Cuesta más ejecutar (en tu infraestructura, no en la mía). Hace más preguntas de las que un sistema optimizado haría. Todo esto es deliberado. El objetivo no es construir una IA que se mueva rápido. El objetivo es construir un equipo de IA que realmente funcione, que puedas entregarle un problema real, en el que confiarías para ejecutar algo importante, y que puedas explicar y defender cuando algo salga mal.

Eso es más difícil. Toma más tiempo. Pero es el único tipo de sistema autónomo que vale la pena construir.
