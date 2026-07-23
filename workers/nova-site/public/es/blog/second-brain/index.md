# Dale a Nova un segundo cerebro: aliméntalo con tus documentos usando RAG

> Nova ahora tiene una base de conocimiento con alcances — un segundo cerebro. Suelta PDFs, documentos, notas o URLs y Nova los aprende: fragmentados, incrustados localmente y recuperados en cada agente con citas de la fuente. Alcances personal, de equipo y por agente. Cuatro formas de alimentarlo.

*Source: https://mynova.space/es/blog/second-brain/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova ahora tiene una base de conocimiento que alimentas tú mismo. Suelta un PDF, un documento, una nota o una URL y Nova la aprende — fragmentada, incrustada en tu propia máquina, y traída de vuelta a la respuesta de cualquier agente con una cita. Personal, para todo el equipo, o atada a un solo especialista.

Jake Belieny · 21 de julio de 2026 · 7 min de lectura

Nova siempre ha tenido memoria — recuerda datos sobre ti y tu trabajo y los trae a una conversación cuando son relevantes. Pero la memoria es para las cosas que Nova *aprende* de pasada. Nunca fue un lugar para poner las cosas que ya *tienes*: el contrato, la guía de marca, la especificación del producto, el informe de investigación de 40 páginas en el que quieres que se base cada respuesta.

Eso es lo que se lanzó esta semana. Nova ahora tiene una **base de conocimiento** propiamente dicha — un segundo cerebro que alimentas a propósito. Entrégale un documento y se convierte en algo que Nova puede citar, razonar y referenciar, en cada agente, en cada canal.

**La versión de una línea** Suelta un PDF, documento, nota o URL. Nova lo divide en pasajes, los incrusta localmente y los almacena. A partir de entonces tus agentes responden *desde tu material* — y te dicen de qué documento vino cada dato.

## Cómo funciona en realidad

Cuando llega un documento, Nova lo pasa por un flujo pequeño, aburrido y confiable — del tipo que quieres que maneje tus datos:

- **Extraer** — el texto se saca de PDFs, documentos de Word, Markdown, texto plano o una página web.

- **Fragmentar** — el texto se divide en pasajes solapados de unos pocos cientos de palabras, para que una coincidencia devuelva un fragmento enfocado y citable en lugar de un archivo entero.

- **Incrustar** — cada pasaje se convierte en un vector mediante un modelo que se ejecuta **en tu propia máquina** (`all-MiniLM`, el mismo incrustador local que Nova ya usa). Ningún documento sale jamás hacia una API de incrustación de terceros.

- **Almacenar y recuperar** — los pasajes viven en el almacén de vectores local de Nova. Cuando preguntas algo, Nova incrusta tu pregunta, encuentra los pasajes más cercanos y los integra en la respuesta.

La recuperación es **híbrida**, que es la parte que la hace sentir sin esfuerzo. El pasaje o los dos pasajes más relevantes se inyectan automáticamente en la conversación — no le pides a Nova que "busque en la base de conocimiento", simplemente lo sabe. Y cuando un agente necesita profundizar, puede consultar la base directamente. En cualquier caso, lo que regresa lleva su fuente, así que Nova puede decir *"(de contract-v3.pdf)"* en lugar de pedirte que le creas sin pruebas.

## Personal, de equipo y por agente — una base, tres alcances

No todos los documentos son de todos. La base de conocimiento de Nova tiene tres alcances, y se combinan:

#### Personal

Solo tuyo. Tus notas, tus borradores, la investigación que solo tú deberías ver. Vive en tu propia base de datos local y ningún compañero puede recuperarla.

#### De equipo

Compartido entre todos en tu Nova. El manual, la guía de marca, los precios — las cosas que quieres que cada respuesta respete.

#### Por agente

Un paquete atado a un solo especialista. Los contratos para Lex, la voz de marca para Aura, la documentación de la API para Architect — para que el experto correcto lleve el material correcto y nadie más se sature con él.

Cuando un agente responde, se apoya en tus documentos personales, la base del equipo *y* su propio paquete — pero nunca el paquete de otro agente. Un especialista sigue siendo especializado.

## Cuatro formas de alimentarla

La mejor base de conocimiento es la que realmente mantienes al día, así que Nova te da cuatro puertas — usa la que encaje en el momento:

### 1 · Suelta un archivo en Telegram

Envíale a Nova un documento con un pie de foto como *"añadir a conocimiento"* — o *"añadir a conocimiento del equipo"*, o *"para el paquete de Lex"* — y se ingiere en el acto, con alcance y todo. `/knowledge` lista todo lo que Nova conoce actualmente, agrupado por alcance.

### 2 · El panel

El panel web tiene una sección de **Conocimiento**: arrastra archivos, fija el alcance de cada uno, busca en todo y elimina lo que está desactualizado. Es el lugar cómodo para gestionar una base que crece.

### 3 · El comando `nova kb`

¿Prefieres la terminal? La CLI unificada cubre todo el ciclo de vida:

- `nova kb add report.pdf --scope team`

- `nova kb add https://example.com/spec --agent architect`

- `nova kb list` · `nova kb search "refund window"` · `nova kb reindex --all`

### 4 · Una carpeta vigilada

Apunta y olvida: cualquier cosa que sueltes en `~/.nova/knowledge/` se ingiere automáticamente, y las subcarpetas fijan el alcance — `team/` para el equipo, `agents/lex/` para un paquete de agente. Elimina un archivo y sus pasajes salen de la base. Convierte tu base de conocimiento en una carpeta que ya sabes usar.

## Construida con el mismo estándar que el resto de Nova

Un segundo cerebro solo vale la pena si puedes confiar en lo que te devuelve. Así que la base de conocimiento hereda las salvaguardas de Nova:

- **Escaneada contra inyección.** Un documento que intente colar instrucciones — *"ignora tus reglas anteriores…"* escondido en un párrafo — es detectado y descartado antes de que pueda llegar a un prompt. Tus archivos se tratan como *datos*, nunca como comandos.

- **Local y privada.** La extracción y las incrustaciones se ejecutan en tu máquina. Tus documentos no se envían a la API de nadie para ser indexados.

- **Re-ingestas limpias.** Vuelve a añadir un archivo que hayas editado y Nova reemplaza la versión anterior en su lugar — sin duplicados, sin pasajes obsoletos rezagados.

También reutiliza la maquinaria que Nova ya tenía — el mismo incrustador local, el mismo almacén de vectores, los mismos analizadores de documentos — en lugar de atornillar un sistema paralelo. Menos cosas que se rompan, y se comporta como la Nova que ya conoces.

## Hacia dónde va esto

Una base de conocimiento cambia lo que puedes entregarle a Nova. En lugar de pegar el párrafo relevante en cada solicitud, cargas la fuente una vez y cada agente queda fundamentado en ella a partir de entonces. Las respuestas de soporte coinciden con tus políticas reales. Legal lee tus contratos reales. Tu voz de marca es *tu* guía de marca, no una conjetura genérica. El equipo deja de reexplicar el mismo contexto y empieza a construir sobre él.

Es la diferencia entre un asistente que es inteligente en general y un equipo que es inteligente sobre *tu* negocio.
