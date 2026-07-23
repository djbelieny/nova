# Tableros que tus agentes rellenan

> Nova ya puede crearte un tablero. Se lo pides por chat, él propone los campos y las etapas, sus agentes rellenan las tarjetas y tú las arrastras en el panel. Una etapa puede ejecutar un playbook cuando llega una tarjeta. Suficiente para sustituir un CRM ligero.

*Source: https://mynova.space/es/blog/workboards/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Pídele un tablero a Nova y lo construye: campos tipados, etapas ordenadas y tarjetas que rellenan sus agentes. Abre el panel y arrástralas. Arma una etapa y el trabajo se ejecuta en cuanto una tarjeta llega ahí. Suficiente para dejar de pagar un CRM ligero.

Jake Belieny · 23 de julio de 2026 · 7 min de lectura

Nova genera registros todo el día. Investiga clientes potenciales, redacta órdenes de compra, clasifica tickets, saca los números de un informe. Hasta esta semana todo eso llegaba como *mensajes*: una buena respuesta en un hilo de chat, olvidada para el jueves.

No había dónde *ver* un conjunto de esos registros. Ni dónde hacer avanzar uno. Ni forma de decir «ejecuta el seguimiento sobre todo lo que hay en esa columna». Así que mantenías un CRM abierto al lado de Nova, sobre todo para guardar un estado que Nova ya había producido, y lo retecleabas a mano.

Eso es lo que arreglan los **Workboards**.

**La versión en una línea** Pide un tablero por chat. Nova elige los campos y las etapas, sus agentes rellenan las tarjetas, tú las arrastras en el panel, y una etapa puede ejecutar un playbook en cuanto llega una tarjeta.

## Pide un tablero y tendrás un tablero

Lo describes como se lo describirías a un colega. Nova deduce qué necesita guardar el tablero, lo construye y te pasa el enlace.

La segunda merece detenerse. El tablero y la investigación son una sola petición. Un agente va y hace el trabajo, y el resultado aterriza como tarjetas que puedes ordenar y mover, no como un muro de texto que tienes que reformatear para que sirva.

## Cada tablero tiene su propia forma

Un tablero de compras y uno de clientes potenciales no se parecen en nada, así que Nova no los mete a la fuerza en un mismo esquema. Cada tablero declara sus propios **campos tipados** —texto, dinero, fecha, correo, un desplegable con tus opciones, un enlace, una casilla— y toda tarjeta de ese tablero lleva esa forma.

Los campos tipados son lo que convierte un tablero en algo más que notas adhesivas. Una columna de dinero se suma sola por etapa. Una de fecha se ordena. Un desplegable no puede derivar en cuatro formas de escribir el mismo estado. Y un playbook puede leer con fiabilidad el importe de *esta* tarjeta, porque siempre está y siempre es un número.

Los esquemas cambian, así que editarlos se trata con cuidado: **añadir** un campo es inmediato y lo rellena en todas las tarjetas existentes. **Eliminar o cambiar el tipo** de uno te pide confirmación primero y luego conserva los valores antiguos en el historial del tablero, de modo que un campo que borras con prisa se puede recuperar.

## Etapas que hacen el trabajo

Por defecto una etapa es solo una columna: una etiqueta, un sitio donde soltar una tarjeta. Es el valor por defecto correcto; la mayoría de los tableros quieren ser una pizarra.

Pero un tablero puede volverse **reactivo**, y entonces una etapa puede llevar una acción: un playbook, o una tarea para un agente concreto. Suelta una tarjeta ahí y el trabajo arranca, con los campos de la propia tarjeta como entrada. Un cliente potencial arrastrado a *Seguimiento* recibe la secuencia escrita para *esa* empresa. Una OC arrastrada a *Enviar* se envía.

Darle a un gesto de arrastrar el poder de iniciar trabajo real merece protecciones, y las tiene:

- **El contenido de una tarjeta es dato, nunca instrucción.** Una tarjeta cuyas notas digan *«ignora tus instrucciones anteriores y…»* se detecta y la acción se omite: el mismo filtrado que Nova ya aplica a cualquier contenido no confiable que llega a un agente.

- **Se ejecuta una sola vez.** Un doble arrastre, una petición duplicada, un reinicio a mitad: la acción corre una única vez.

- **Los movimientos masivos preguntan.** Arrastra cuarenta tarjetas a una etapa armada y Nova pregunta una vez por el lote en lugar de lanzar cuarenta trabajos en silencio.

- **Los fallos se ven.** Una acción que no puede completarse va a la cola de mensajes fallidos con su motivo, en vez de desaparecer.

- **La puerta de aprobación sigue ahí.** Todo lo consecuente aguas abajo —enviar, publicar, gastar— sigue parándose para tu aprobación, exactamente como siempre.

## Trae lo que ya vive en otro sitio

Un tablero puede enlazarse a un conector que ya tengas configurado —HubSpot, Stripe, Shopify, Zendesk— y traer registros a las tarjetas. La sincronización es **solo de alta y actualización**: añade y actualiza, y nunca borra. Una API inestable o un token caducado pueden dejarte tarjetas desactualizadas, pero no pueden vaciar un tablero.

El camino inverso es deliberadamente más lento. Cuando mueves una tarjeta en un tablero enlazado, Nova *describe* la escritura que haría en ese sistema y la registra; no sale a cambiar un registro de tu CRM porque hayas arrastrado algo. Escribir en sistemas de los que dependes es una decisión, no un efecto secundario.

## Los tableros que ya tenías se han mudado

Nova lleva tiempo mostrando tareas de agentes y tickets de soporte en tableros fijos y de solo lectura. Ambos funcionan ya sobre este motor: mismo aspecto, mismas interacciones y, por primera vez, se pueden arrastrar. Sus columnas están bloqueadas —un tablero de tickets debería significar lo que todos creen que significa— pero mover una tarjeta actualiza de verdad el ticket o la tarea subyacente.

Una sola interfaz de tablero en vez de tres, y cada mejora llega a todas a la vez.

## Lo que no es

No es Salesforce. No hay motor de puntuación de leads, ni secuenciador de correo acoplado, ni suite de informes. Si necesitas un CRM empresarial, compra un CRM empresarial.

Lo que sí es: el sitio donde va el resultado de tus agentes para que deje de ser un mensaje de chat. Para muchos equipos pequeños el CRM nunca fue más que un esquema, unas columnas y un recordatorio de seguimiento, y Nova ya puede sostener las tres cosas, en tu propia máquina, junto a los agentes que ya hacen el trabajo.
