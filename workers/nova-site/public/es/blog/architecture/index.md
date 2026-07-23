# Cómo funciona Nova: la arquitectura detrás del telón

> Un análisis técnico profundo de la arquitectura de Nova: clasificación de mensajes de 3 niveles, descomposición de tareas con resolución de dependencias, ejecución paralela, controles de aprobación en dos fases, SQLite dividido con búsqueda vectorial, y enrutamiento de IA inteligente en Claude, Gemini y Codex.

*Source: https://mynova.space/es/blog/architecture/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

El poder de Nova proviene de cómo piensa, no solo de qué puede hacer. Aquí hay un recorrido técnico del pipeline que convierte un mensaje de Telegram en trabajo coordinado en 24 agentes especialistas, cómo aprende de patrones, y por qué pregunta antes de actuar.

Jake Belieny · 15 de julio de 2026 · 13 min de lectura

Un chatbot tradicional toma tu mensaje y lo ejecuta directamente a un LLM. Nova toma una ruta más larga e inteligente. Cada mensaje se **clasifica** en uno de tres cubos, cada uno manejado diferentemente. Las cosas simples se mantienen rápidas. El trabajo enfocado se enruta a un especialista. Los problemas grandes y descomponibles se dividen en subtareas y se ejecutan en paralelo. Y nada importante sucede hasta que tú lo digas.

Es un pipeline, no una caja negra. En cada etapa — clasificación, descomposición, ejecución — el sistema toma una decisión deliberada. Puedes leer el código. Puedes cambiarlo.

## Cómo Nova decide qué hacer con tu mensaje

Cuando envías un mensaje, Nova no le pide inmediatamente a Claude que reflexione sobre él. En cambio, usa un **sistema de clasificación de 3 niveles** diseñado para mantener tantas solicitudes como sea posible fuera del LLM completamente.

### Nivel 1: La heurística (instantáneo, costo cero)

Los mensajes con menos de 15 palabras sin verbos de acción obtienen una respuesta directa de Claude. "¿Qué hora es?" permanece instantáneo. Esto captura búsquedas rápidas, verificaciones de estado, y preguntas casuales — el tipo donde el costo de enrutamiento sería tonto.

### Nivel 2: Coincidencia de patrones y enrutamiento de agente único

Nova recuerda descomposiciones de tareas exitosas. Si pediste "redacta un boletín" la semana pasada y obtuviste un plan que funcionó, y pides algo similar hoy, Nova reutiliza ese mismo plan sin volver a ejecutar el LLM. Para solicitudes nuevas, Nova coincide patrones con plantillas de tareas conocidas — cosas como "publicación de redes sociales", "campaña de correo", "artículo de blog", "creativo publicitario" — y las enruta directamente al agente especialista correcto.

### Nivel 3: Clasificación LLM (solo cuando sea necesario)

Todo lo demás va a Claude Sonnet, que lo clasifica como simple (respuesta directa), enrutado (agente único), o complejo (descomponer y paralelizar). Esto sucede una vez por tipo único de solicitud, luego se cachea.

**El resultado** Los mensajes simples se responden sin una llamada LLM en absoluto. Las tareas repetidas reutilizan un plan cacheado. Solo las solicitudes genuinamente nuevas pagan por una llamada de clasificación — y cada una se convierte en un patrón que hace que la próxima solicitud similar sea más rápida.

## Dividir el trabajo complejo en piezas independientes

Cuando le pides a Nova algo grande — "planifica y lanza nuestra campaña de Q3" — el planificador toma el control. Divide la solicitud en subtareas, calcula las dependencias, y ejecuta todo lo que puede suceder en paralelo.

Algunos de los flujos de trabajo más complejos de Nova son **pipelines determinísticos**, no generados por LLM cada vez. Una campaña de redes sociales siempre sigue la misma forma: investigar → contenido → imagen → vista previa → publicar. Un artículo de blog es siempre investigar → escribir → imagen hero → vista previa → publicar. Esto significa que obtienes un proceso predecible y reproducible para trabajo que haces repetidamente.

Para solicitudes verdaderamente nuevas, el LLM descompone la tarea. Devuelve JSON: una matriz de subtareas, cada una con una descripción, qué agente debe manejarla, y qué otras tareas depende. Las dependencias se resuelven, luego las subtareas independientes se ejecutan al mismo tiempo.

## Dos fases: preparar primero, pedir permiso, luego ejecutar

El momento en que una tarea toca el mundo real — publica una publicación, envía un correo, gasta dinero — necesita aprobación. Nova implementa esto como dos fases distintas.

**Preparar** es la mitad segura. Investiga, redacta el contenido, genera imágenes, ejecuta análisis. Los artefactos fluyen de subtarea a subtarea. Todo es reversible o al menos reembolsable. Esta fase produce un resumen y artefactos, enviados a ti en Telegram con tres botones: Aprobar, Revisar, o Cancelar.

**Ejecutar** solo se ejecuta después de que apruebes. Publica, envía, crea, gasta — todas las cosas irreversibles. Pero se ejecuta con contexto completo de preparar: el contenido ya está escrito, la imagen ya está generada, el tiempo ya está planeado.

Los usuarios que ejecutan la misma tarea semanalmente pueden eventualmente **ganar autonomía**. Después de algunas ejecuciones limpias de "envía el boletín", el sistema puede graduarlo: primero a "envíalo y notifícame después", luego a "envíalo autónomamente hasta un presupuesto de $50". Un rechazo y vuelve a preguntar. Siempre estás en control de cuánta cuerda obtiene cada tarea.

## Cómo Nova almacena lo que sabe

Nova usa una **arquitectura SQLite dividida**: una base de datos compartida para el estado de Nova, y una base de datos por usuario para todo lo privado de ese usuario.

#### Base de datos compartida

Cuentas de usuario, seguimiento de costos, registros, hechos globales, estado del servicio. Una instancia por implementación de Nova.

#### Base de datos por usuario

Mensajes, memoria personal, tareas del agente, aprobaciones, trabajo programado, patrones de ejecución. Permanece en tu máquina.

Ambas usan `sqlite-vec` para búsqueda vectorial. Cada hecho, cada memoria, cada mensaje se incrustan con `all-MiniLM-L6-v2` (384 dimensiones). Cuando el planificador necesita contexto — "¿qué sabemos sobre estrategia de precios?" — hace una búsqueda semántica en lugar de coincidencia de palabras clave. Esto significa que Nova puede encontrar contexto relevante incluso cuando no usas exactamente las mismas palabras.

Los embeddings son baratos de computar localmente, y los resultados de búsqueda se cachean. Tus datos nunca salen de tu máquina. Tus claves, tu suscripción, tu base de datos.

## Elegir la IA correcta para el trabajo

Nova puede enrutar trabajo a Claude, Gemini, Codex, o Groq. La decisión sucede automáticamente usando **enrutamiento inteligente**: invalidación de fuerza (prefijar con `/claude` o `/gemini`) vence tu predeterminado. Tu predeterminado vence el enrutamiento basado en pistas. Basado en pistas vence la alternancia de límite de velocidad.

La lógica de enrutamiento considera el tipo de tarea. El trabajo pesado en MCP (gestionar documentos de Notion, eventos del calendario, Gmail) se enruta a Claude debido a su soporte nativo de MCP. La investigación y síntesis web van a Gemini debido a su nivel gratuito y síntesis fuerte. La clasificación rápida va al proveedor que tiene el modelo rápido más barato.

Cada proveedor tiene tres niveles: `fast` (clasificación, barato), `standard` (ejecución de tarea, equilibrado), y `premium` (razonamiento crítico, mejor calidad). El enrutador elige el nivel basado en la criticidad de la tarea.

## Los bloques de construcción: patrones, memoria e integraciones

### Aprendizaje de patrones

Toda ejecución de tarea exitosa se registra como un patrón. La próxima vez que pidas algo similar, Nova califica tu solicitud contra esos patrones por solapamiento de palabras clave. Cuando una solicitud coincide estrechamente con un plan anterior que ya tiene dos o más ejecuciones limpias, Nova lo reutiliza. Esto convierte tareas repetidas en acciones de un paso — y un patrón que sigue teniendo éxito se promueve eventualmente en una habilidad reutilizable.

### Memoria persistente

Nova incrustra todo lo que le dices que recuerde. Usa `[REMEMBER: fact]` en una respuesta y guarda el hecho, desduplicó contra la memoria existente, y lo pone disponible para búsqueda semántica en toda solicitud futura. También puedes establecer `[GOAL: text | DEADLINE: date]` para rastrear objetivos, y Nova te recordará el progreso y los bloqueadores.

### 12 integraciones MCP

Nova viene preconfigurada con Notion, Google Workspace (Gmail, Calendar, Drive, Docs, Sheets), Playwright, Cloudflare Workers, Zoom, Square, ClickUp, GoHighLevel, Firecrawl, Tavily, Exa, y Browserbase. Cada agente puede acceder a los relevantes para su dominio. Proporcionas las credenciales una vez durante la configuración, y permanecen en tu máquina.

### Trabajo programado y proactivo

Nova puede ejecutar tareas en un cronograma: resúmenes diarios, reportes semanales, auditorías mensuales. Aprende tus patrones — cuándo es más probable que quieras noticias, qué reportes importan más, qué miembros del equipo incluir — y se comunica proactivamente. Un resumen matutino no es solo "aquí está tu calendario", es "aquí está tu calendario más los tres correos más importantes más tu prioridad principal para hoy basada en tus objetivos".

## La junta ejecutiva: estrategia a escala

Para las decisiones más grandes, Nova ejecuta una **reunión de junta**. Siete ejecutivos — CEO, CFO, CMO, CTO, COO, Jefe de Investigación, y Crítico — cada uno con una persona distintiva y agentes prioritarios, se reúnen en tu pregunta estratégica.

La reunión sigue un flujo estructurado: cada ejecutivo analiza independientemente la pregunta, el Crítico identifica modos de falla y da un IR/NO IR, luego Nova sintetiza 3–5 opciones clasificadas por confianza. Eliges una, la decisión se registra en el registro, y el equipo ejecutivo delega trabajo autónomo basado en la decisión a través del orquestador Nova principal.

Los ejecutivos usan diferentes proveedores de IA (Claude para estrategia, Gemini para análisis, Codex para profundidad técnica) y se coordinan a través de una base de datos compartida. Cada nodo ejecutivo se ejecuta independientemente en su propio VPS, haciendo posible escalar a través de trabajo ilimitado sin un cuello de botella central.

## ¿Por qué esta arquitectura?

El diseño de Nova hace posibles cinco cosas:

- **Velocidad** — muchos mensajes nunca tocan un LLM en absoluto. Las heurísticas y patrones cacheados mantienen el camino rápido rápido.

- **Eficiencia de costos** — Cada ruta elige el modelo más barato adecuado para la tarea. Niveles rápidos para clasificación, estándar para ejecución, premium solo cuando el razonamiento importa.

- **Paralelismo** — Las subtareas independientes se ejecutan concurrentemente. Una campaña de 10 pasos no toma 10× el tiempo; muchos pasos se colapsan en 2–3 lotes.

- **Auditabilidad** — Toda decisión se registra. Puedes ver por qué Nova enrutó a un agente, cuáles fueron las dependencias, si usó un patrón cacheado o llamó al LLM.

- **Control** — La ejecución de dos fases significa que el trabajo importante se detiene para aprobación. Los patrones y la escalada de autonomía significan que gradualmente confías más trabajo para ejecutarse sin supervisión a medida que el sistema se prueba a sí mismo.
