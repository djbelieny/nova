# Nova, endurecida para producción: gobernanza, exactamente-una-vez y datos conectados

> El lanzamiento de endurecimiento: políticas de cumplimiento con bloqueo estricto, permisos basados en roles, delegación por ausencia, idempotencia duradera de exactamente-una-vez, bloqueos por aviso, secretos de conectores cifrados, conectores que los agentes descubren como herramientas MCP, y una capa de datos conectados — todo lo que necesitas para dejar a Nova corriendo sin supervisión, para un equipo.

*Source: https://mynova.space/es/blog/governance-hardening/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Construir automatizaciones es una cosa; dejarlas corriendo — para un equipo, con dinero real — es otra. Este lanzamiento va sobre esa segunda cosa: límites estrictos que se sostienen incluso cuando apruebas, permisos y delegación, garantías de exactamente-una-vez, secretos cifrados, y una forma de que Nova lea los datos con los que realmente funciona tu negocio.

Jake Belieny · 22 de julio de 2026 · 8 min de lectura

Los últimos lanzamientos le dieron a Nova alcance: una base de conocimiento, automatizaciones orientadas a eventos, playbooks, procesos duraderos, conectores, ROI. Este le da **mesura y rigor** — las garantías poco glamorosas que convierten un "demo impresionante" en un "puedes dejarla corriendo para tu equipo". Cada pieza es aditiva: sin nada configurado, Nova se comporta exactamente como antes.

**La versión de una línea** Límites estrictos que se sostienen incluso cuando apruebas, permisos basados en roles, delegación por ausencia, idempotencia de exactamente-una-vez, bloqueo contra doble disparo, secretos cifrados, conectores que los agentes descubren como herramientas MCP, y una capa de datos de solo lectura para los sistemas con los que funciona tu negocio.

## Límites estrictos que se sostienen — incluso cuando apruebas

La puerta de aprobación de Nova siempre ha sido el ancla de confianza: el trabajo consecuente espera tu sí. Pero algunas reglas no deberían ser una persona quien las pueda dispensar. Si la política dice que la PII de clientes nunca sale del edificio, un aprobador que hace clic en "aprobar" demasiado rápido no debería poder anularla.

Así que las políticas de cumplimiento ahora tienen un verdadero **bloqueo estricto**. Una revisión de contenido configurada para *bloquear* se aplica en la frontera de ejecución contra la salida realmente preparada — después de la aprobación, en la ruta de piloto automático, en todas partes. Si se activa, nada se envía, y Nova te dice por qué. *Advertir* sigue solo señalando; *bloquear* de verdad detiene.

## Quién puede hacer qué — y quién te cubre cuando no estás

Una Nova de una sola persona y una Nova de equipo necesitan controles distintos. Aquí llegan dos:

#### Permisos basados en roles

Los administradores pueden hacer de todo. Los miembros obtienen capacidades acotadas — gestionar automatizaciones, políticas, conectores, playbooks — para que tú decidas quién puede cambiar qué. Se conceden con `nova access grant @teammate automation.manage` o `/access`.

#### Delegación por ausencia

¿Te vas? `/ooo @teammate` y tus asignaciones y aprobaciones se enrutan hacia esa persona hasta que vuelvas — una cadena protegida contra ciclos, que se limpia con `/ooo off`.

## Las garantías aburridas que importan

La automatización que reacciona al mundo sin supervisión vive o muere por tres propiedades poco glamorosas:

- **Exactamente-una-vez.** Los webhooks se reintentan; un evento de pago puede llegar dos veces. Una automatización puede optar por idempotencia duradera (`--idempotent`) para que dispare una sola vez y nada más — no de nuevo una hora después cuando el emisor reintenta.

- **Sin doble disparo.** Los bloqueos por aviso ahora envuelven el sondeo de automatizaciones y el despachador de tareas, para que dos ticks solapados — o dos instancias en dos máquinas — nunca procesen el mismo trabajo dos veces.

- **Secretos cifrados.** Las credenciales de los conectores se almacenan cifradas en reposo con AES-256-GCM y se establecen con `nova connector set stripe STRIPE_API_KEY=…`, con una auditoría de rotación — no más claves de API activas descansando en un `.env` en texto plano.

## Conectores que los agentes pueden usar de verdad — sin el sobrepeso

Nova opera sus integraciones a través de **mcp2cli**, una elección deliberada: en lugar de meter el esquema completo de cada herramienta en el prompt de un agente (lo que infla el contexto y el costo), los agentes *descubren* las herramientas en tiempo de ejecución — las listan, preguntan por los parámetros de una herramienta y luego la llaman. Mantiene el prompt ligero sin importar cuántas herramientas existan.

Los conectores ahora siguen ese mismo idioma exacto. Un agente ejecuta `nova connector describe stripe` para conocer sus acciones y parámetros bajo demanda, y luego `nova connector run …` para llamar una — leyendo con libertad, y proponiendo cualquier escritura (un reembolso, un nuevo registro) para tu aprobación en vez de hacerla por su cuenta. Agregar un conector no hace crecer el prompt; el descubrimiento hace el trabajo. Es la diferencia entre entregarle a alguien un manual de 200 páginas y decirle dónde está el manual.

## Leer los datos con los que funciona tu negocio

El análisis solo es tan bueno como los datos que puede alcanzar. La nueva **capa de datos conectados** te permite registrar las fuentes en las que realmente viven tus números y consultarlas — de solo lectura, por diseño:

#### HTTP

Cualquier endpoint JSON o CSV — la URL de un reporte, una API interna.

#### SQLite

Un `SELECT` de solo lectura contra un archivo de base de datos — analítica, exportaciones, un almacén local.

#### Conector

Una acción de lectura de un conector — trae pedidos, cargos o tickets directamente.

Regístrala una vez con `nova data add`, y luego consúltala desde la terminal, desde el chat (`/data query sales`), desde un agente a mitad de una tarea, o en un horario para un reporte recurrente. Sin nuevas dependencias, sin necesidad de un almacén de datos.

## La misma promesa de siempre, solo más robusta

Nada de esto cambia lo que Nova es — la convierte en algo a lo que puedes confiarle más. La puerta de aprobación sigue en pie; ahora hay límites que ni ella puede cruzar, permisos alrededor de quién los fija, garantías de que el trabajo corre una sola vez y de forma limpia, y alcance a los datos y sistemas de los que depende tu negocio. El demo creció hasta convertirse en algo que de verdad puedes dejar corriendo.
