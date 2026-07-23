# Nova ahora dirige la operación: playbooks, automatizaciones y conectores

> El mayor lanzamiento de Nova la vuelve orientada a eventos y duradera a nivel de procesos: playbooks (SOPs reutilizables), automatizaciones por eventos con disparadores semánticos, procesos duraderos de varios días, extracción de documentos, conectores de negocio (Stripe/Shopify/Zendesk/HubSpot), políticas de cumplimiento y reportes de ROI — con cada paso consecuente aún bajo aprobación.

*Source: https://mynova.space/es/blog/business-automation/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Un chatbot responde. Un negocio necesita que el trabajo ocurra — en un horario, en respuesta a eventos, a lo largo de días, con un registro. El mayor lanzamiento de Nova la transforma de un asistente al que preguntas a un sistema que ejecuta el trabajo repetible en segundo plano — y aún así pregunta antes de que cualquier cosa se publique, gaste o envíe.

Jake Belieny · 21 de julio de 2026 · 9 min de lectura

Durante un tiempo, Nova ha sido muy buena en aquello que le pides que haga *ahora mismo*: descomponer una solicitud, dirigirla a especialistas, preparar el trabajo y esperar tu aprobación antes de que nada salga a producción. Eso es el asistente. Pero un negocio no funciona a base de solicitudes — funciona a base de **trabajo repetible** que ocurre en un horario, reacciona a eventos, abarca días y deja un registro.

Este lanzamiento cierra esa brecha. Nova ahora es **orientada a eventos y duradera a nivel de procesos** — toda una capa para construir, ejecutar y vigilar operaciones automatizadas. Y llega sobre el mismo principio que todo lo demás: la mitad segura corre libremente; la mitad consecuente todavía pregunta.

**La versión de una línea** Escribe un proceso una vez y ejecútalo muchas veces; dispara flujos de trabajo a partir de eventos del mundo real; mantén en marcha procesos de varios días; extrae datos estructurados de documentos; lee y escribe en tus herramientas de negocio; pon límites al gasto y al cumplimiento; y ve el valor que todo esto entrega — auto-alojado, con tus propias claves.

## Qué se lanzó

#### Playbooks

SOPs reutilizables — escribe un proceso una vez, ejecútalo muchas veces con variables.

#### Automatizaciones

Evento → condición → flujo de trabajo, con deduplicación, límites de frecuencia y disparadores semánticos.

#### Procesos duraderos

Flujos de varios días que esperan un temporizador o un evento, y luego se reanudan — sobreviviendo a reinicios.

#### Extracción de documentos

Facturas, recibos y formularios → datos estructurados y validados.

#### Conectores

Stripe, Shopify, Zendesk, HubSpot — leen y escriben, en ambos sentidos.

#### Políticas

Topes de gasto, matrices de aprobación y revisiones de contenido — límites que solo restringen.

#### Reportes de ROI

Tareas automatizadas, horas ahorradas y valor frente a costo — por departamento y agente.

#### Operar y observar

Un feed de actividad unificado, vistas previas de simulación y una cola de mensajes fallidos.

## Playbooks: tus procesos, escritos y ejecutables

Todo negocio tiene un conjunto de procesos del tipo "así hacemos X" — dar de alta a un cliente, gestionar un reembolso, lanzar un producto. Un **playbook** es ese proceso, hecho ejecutable: unos pocos pasos ordenados, cada uno asignado a un especialista, con variables que rellenas al momento de ejecutar. Escríbelo una vez; ejecútalo cuando quieras, con distintas entradas.

Los playbooks son personales o para todo el equipo, y están versionados — editarlos incrementa la versión, para que una automatización pueda fijar aquella contra la que se construyó. Nova incluye una biblioteca inicial que puedes clonar y editar.

## Automatizaciones: cuando algo pasa, haz el trabajo

El mayor cambio es que Nova ahora **reacciona**. Una automatización tiene una fuente (un webhook entrante, una métrica que cruza un umbral, o un evento de negocio como un nuevo pago de Stripe), condiciones opcionales y una acción — ejecutar un agente, o ejecutar un playbook. Llega un nuevo prospecto, falla un pago, entra un formulario — Nova lo recoge y hace lo siguiente, a través de la misma puerta de aprobación.

- **Las condiciones** filtran por campos (`amount > 1000`, remitentes VIP, y así), con deduplicación por hora y límites de frecuencia para que una fuente ruidosa no te sature.

- **Los disparadores semánticos** van más allá: se activan por *significado*, no por coincidencias exactas. "Cuando un correo se lee como una queja" o "suena a una cancelación" — detectado con las mismas incrustaciones locales que impulsan la base de conocimiento.

## Procesos: para trabajo que abarca días

Algunas cosas no terminan en una sola ejecución: *envía el contrato → espera una firma → factura → espera el pago → cumple.* Un **proceso duradero** es una secuencia de pasos de acción y espera que sobrevive a reinicios y se reanuda con un temporizador vencido o un evento con nombre. Nova mantiene el estado, espera con paciencia y retoma justo donde lo dejó — sin enredos de cron, sin hilos perdidos.

## Extracción: convierte documentos en datos

La base de conocimiento se trataba de *recuperación* — pregunta, y Nova responde desde tu material. La extracción es la imagen espejo: **captura**. Define los campos que te importan y Nova saca JSON limpio y verificado por tipos de un PDF, un DOCX o un formulario escaneado — número de factura, total, fecha de vencimiento, líneas de detalle — validado y listo para enviarlo a una hoja o a tu CRM. Suelta un documento en el chat con "extract as invoice", o conéctalo a una automatización para que cada factura entrante se archive sola.

## Conectores: Nova, te presento tu stack

La automatización tiene que vivir donde tu negocio ya funciona. Nova ahora habla con sistemas externos a través de una capa de **conectores** delgada y uniforme, con cuatro incluidos y bidireccionales: **Stripe** (cargos, clientes, reembolsos), **Shopify** (pedidos), **Zendesk** (tickets) y **HubSpot** (contactos). Cada uno aporta acciones de lectura y escritura además de un disparador que alimenta automatizaciones — así que `stripe.payment` o `shopify.order` pueden iniciar un flujo de trabajo. Agregar el tuyo propio es un solo archivo.

## Políticas: límites que solo se ajustan

Entregarle trabajo a un sistema autónomo solo resulta cómodo si puedes acotarlo. Las políticas se sitúan sobre la escalera de autonomía ganada de Nova y **solo restringen** — pueden exigir aprobación, bloquear o advertir, pero nunca otorgan más libertad de la que la escalera ya permite. Fija un tope de gasto mensual por departamento, dirige ciertas acciones a un aprobador designado con un tiempo de escalamiento, o escanea el contenido saliente en busca de PII antes de que se envíe. Sin políticas configuradas, nada cambia.

## ROI: demuestra que funciona

Una automatización que no puedes medir es una automatización que tarde o temprano apagarás. Cuando un agente termina algo cuantificable, etiqueta el resultado; Nova los suma frente a su propio libro de costos hasta llegar a los números que importan — **tareas automatizadas, horas ahorradas y dólares influidos frente a lo que costó la IA**, desglosado por departamento y agente. Un resumen semanal llega a tu chat, y el panel muestra la tendencia.

## Construida para dejarla corriendo

Reaccionar al mundo sin supervisión eleva el listón de la operabilidad, así que este lanzamiento también incluye las partes aburridas y esenciales:

- **Simulación.** Previsualiza exactamente lo que haría una automatización contra un evento de muestra antes de activarla. No ejecuta nada — solo ves la decisión.

- **Un feed de actividad unificado.** Cada disparo de automatización, transición de proceso y ejecución de playbook en una sola línea de tiempo — en el chat, la CLI o el panel.

- **Reintentos + una cola de mensajes fallidos.** Un envío fallido se reintenta con retroceso; si aun así falla, va a parar a una cola que puedes inspeccionar y reintentar, en lugar de desvanecerse.

Y los propios agentes ahora pueden usar estas capacidades mientras trabajan — buscando en tu base de conocimiento, extrayendo un documento, ejecutando un conector configurado — usando acciones de lectura libremente y **proponiendo para tu aprobación cualquier cosa consecuente** en lugar de hacerla por su cuenta.

## La misma promesa de siempre

Nada de esto afloja el modelo de confianza — lo extiende. Cada paso consecuente que da una automatización, un proceso o un playbook sigue fluyendo por preparar → aprobar → ejecutar. La diferencia es que ahora el *disparador* puede ser un evento, un horario o una firma en lugar de únicamente un mensaje que escribiste. Nova creció de algo con lo que hablas a algo que dirige tu operación — y sigue preguntando primero.
