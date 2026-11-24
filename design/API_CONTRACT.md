# Contrato de integración para Claude Design → Codex

Estado: backend TypeScript; la UI de Claude queda visualmente congelada durante esta implementación. Fuente de tipos: `../contracts/api.ts` y sus exports **type-only**. OpenAPI generado: `../contracts/openapi.json`. El archivo se regenera con `npm run contract`; el diseño no modifica `server/` ni amplía capacidades silenciosamente.

## Despliegue y autenticación

Origen previsto compartido: `https://panel.example.com`. Antes de integrar, Codex debe comprobar `/health` y el estado real de despliegue; la presencia del contrato no acredita que esté desplegado.

- Navegador: sesión cookie `__Host-infra`, HttpOnly, Secure, SameSite=Strict, duración 7 días. `fetch` del mismo origen. No leer/guardar el token de sesión desde JS.
- Agentes: `Authorization: Bearer $INFRA_CONTROL_TOKEN`; `read` o `read,operate`. Tokens nuevos declaran `mcpTools`, `readPolicy` y, si operan, `operationPolicy` de mínimo alcance. `operate` solo no autoriza energía. Los tokens legacy sin `readPolicy` conservan lectura completa para compatibilidad; migrarlos a una política explícita.
- Toda escritura humana, incluido login, exige `Origin` exactamente igual al origen configurado. La envía el navegador; no implementar CORS abierto para el prototipo. Los fixtures de diseño son locales y tipados.
- `/api/*` responde `Cache-Control: no-store`. Sin caché de Service Worker ni almacenamiento persistente de datos privados en la PWA.
- Las respuestas de error tienen `{ "error": "mensaje en español" }`; no contienen stack ni credenciales. 401: volver al acceso y limpiar estado privado. 403: origen/scope no permitido. 429: respetar `Retry-After`, sin bucle de reintentos.

## Identidad AWS, producción y suspensión

- `shop-dev` es producción de la shop. Su nombre estable y sus aliases no cambian al mostrar «shop · Producción»; descubrir recursos no habilita órdenes de energía.
- Las conexiones pueden usar un rol de lectura asumido desde otra identidad dedicada del panel. ARN, fuente, claves y credenciales temporales son configuración privada: nunca forman parte de `Resource`, contratos públicos ni navegador.
- Una cuenta suspendida se excluye de inventario, costes, cobertura actual, sondas (incluido su host), eventos nuevos y replay SSE actuales. No se borra su identidad, historial, cuota de Cost Explorer ni resultados inciertos; el catálogo histórico requiere solicitud explícita del propietario y conserva `readPolicy`.
- `OperationalIncident` puede incluir `accountId`, `account`, `budgetName` y `sourceContext`. `account` es una etiqueta, nunca identidad ni permiso. `sourceContext.eventIds` referencia únicamente los eventos opening/last retenidos; metadata contradictoria se marca `conflict:true`, y su ausencia no se completa por coincidencias de etiquetas o fechas.
- Un agregado de presupuesto no es un alias de recurso. REST, SSE y MCP deben verificar cuenta/conexión y política sin enviar esos identificadores opacos al resolvedor de recursos. Las observaciones presupuestarias informativas aparecen en eventos e historia, no se convierten en incidentes abiertos por el mero umbral.
- HTTPS valida exclusivamente el endpoint configurado. No acredita una sesión WhatsApp, una transacción financiera ni toda la aplicación por el estado EC2.

## Endpoints actuales

| Método y ruta | Entrada | Resultado |
|---|---|---|
| `GET /health` | Sin autenticación | `{status:"ok"}`. Acredita el proceso, no salud de todos los proveedores. |
| `POST /api/auth/login` | `{username:"admin", password:string}` | 200 `{name:"Admin"}` y cookie. 401 credenciales, 429 tras 5 intentos fallidos/15 min/IP. |
| `GET /api/auth/me` | Sesión o bearer | `{name,agent,scopes}`; 401 sin sesión. |
| `POST /api/auth/logout` | `{}` | 200 `{ok:true}`, revoca sesión. |
| `POST /api/auth/password` | `{current,password}` | Nueva contraseña 16–256 caracteres. Solo sesión humana; revoca todas las sesiones. 5 intentos/15 min. |
| `GET /api/catalog/services` | Sesión o bearer de lectura | Servicios lógicos persistentes y relaciones `hosted_on`/`depends_on` con procedencia. Los alias aún no descubiertos permanecen sin resolver; `readPolicy` limita recursos relacionados y filtra cada relación aunque autorice el proyecto. |
| `GET /api/resources` | Ninguna | `{resources:Resource[],fetchedAt,refreshSeconds:60,cursor}`. `cursor` se captura antes de consultar proveedores para recuperar por SSE cualquier cambio ocurrido mientras llega la snapshot. Puede incluir `health.service` para un destino HTTPS explícito configurado en privado; la URL nunca se devuelve. Si el resultado venció, el estado pasa a `unknown`. |
| `GET /api/router/health` | Ninguna | Snapshot SQLite local; no llama al router, ACS ni PC. Devuelve señales separadas para túnel, telemetría, CWMP, WAN e Internet; las no medidas quedan desconocidas. La vista pasa a stale a45s; Push espera90s de silencio continuo. |
| `POST /api/router/check` | Sesión humana o bearer con lectura y operación | Comprueba una vez el canal SSH privado del FiberHome, sin consultar PC, ACS, WAN o Internet. Comparte resultado durante10s y limita a6 solicitudes/minuto. Un ACK negativo del broker significa “sin respuesta del túnel”, no router apagado ni caída de Internet. Si el broker local no responde, devuelve503 y conserva el último estado observado. |
| `POST /api/router/telemetry` | Bearer exclusivo del colector, sin sesión humana | Muestra validada con bootId, streamId, secuencia, uptime, CPU y memoria. El token se almacena como hash; la llave SSH vive solo en el host VPS. |
| `POST /api/desktop/events` | Token exclusivo del SO | Reporte saliente autenticado de Windows/CachyOS; no concede lectura ni control. |
| `GET /api/desktop/commands` / `POST /api/desktop/commands/:id/ack` | Token exclusivo del SO (el mismo de los avisos) | Canal de órdenes iniciado por la PC: long-poll de hasta 25 s con `caps` (`ping`, `power`, `boot-default`). 200 entrega `{id, command, expectedBootId, issuedAt}` de una lista cerrada; 204 si no hay. El agente confirma con `{accepted, bootId}`. No concede lectura ni operación de la API. |
| `POST /api/hermes/events` | Bearer exclusivo del reporter Hermes, sin sesión de panel | Solo estado `systemd` active/inactive/failed/unknown, contador de reinicios, bootId, streamId y secuencia. No incluye chats, argumentos, logs ni secretos. |
| `GET /api/hermes/health` | Sesión o bearer con lectura | Último snapshot de la unidad systemd configurada; stale tras45s. No consulta EC2 ni SSH. |
| `POST /api/telemetry/otlp/v1/metrics` | Bearer exclusivo por host, sin sesión de panel | Receptor OTLP/HTTP JSON con hasta8 grupos `resourceMetrics`; todos deben declarar el `host.id` ligado al recurso configurado. Máximo64 KiB,64 métricas y512 datapoints. 30 solicitudes/min por credencial y300/min por IP. Almacena muestras24h y difunde el cambio por SSE sin cursor durable. |
| `GET /api/system/health` | Sesión o bearer con lectura | Diagnóstico redactado de observadores, cobertura, colas e integraciones; no lanza sondeos por petición y un agente ve solo los componentes dentro de su política. Incluye conteos agregados de sondas HTTPS configuradas sin destinos. El monitor de nube corre independiente de Push. |
| `GET /api/push/config` | Público | Solo `{enabled,vapidPublicKey}`; nunca devuelve la clave privada o la clave de cifrado. |
| `GET /api/push/status` / `GET /api/push/subscriptions` | Sesión humana; agentes no pueden administrar avisos | Conteos y resumen de esta cuenta; nunca se devuelve endpoint Push ni claves de dispositivo. |
| `POST /api/push/subscriptions` | Sesión humana + Origin exacto | Crea/actualiza una suscripción de proveedor permitido. Hasta5 altas/min; endpoints y claves quedan cifrados en SQLite. |
| `PUT /api/push/subscriptions/:id/preferences` / `DELETE /api/push/subscriptions/:id` | Sesión humana + Origin exacto | Actualizar preferencias o revocar dispositivo; revocar elimina también su outbox. |
| `POST /api/push/subscriptions/:id/test` | Sesión humana + Origin exacto | Encola una prueba para ese dispositivo, una/minuto y TTL60s. HTTP202 solo confirma cola; verificar en el equipo que recibió la notificación. |
| `GET /api/desktop/boot-preference` | Ninguna | Preferencia deseada, último valor UEFI efectivo y versión; lectura SQLite, sin consultar a la PC. |
| `POST /api/desktop/boot-preference` | `{system,confirmed:true,expectedVersion}` + `Idempotency-Key` | 200 si el valor se verificó; 202 si queda pendiente o incierto; 409 al repetir una operación terminal fallida. No enciende ni reinicia. |
| `DELETE /api/desktop/boot-preference/pending` | `{expectedVersion}` | Cancela una intención offline que todavía no se aplicó; 409 si cambió la versión o ya no está pendiente. |
| `GET /api/desktop/boot-preference/verify` | Sesión humana o agente con `refresh` sobre `computer:desktop` | Lectura UEFI explícita con identidad SSH autenticada; detecta `drift` sin corregirlo automáticamente. Se bloquea durante una operación de PC. |
| `GET /api/costs` | Sesión humana o agente con scope de costes | `CostReport`: humano consulta bajo demanda con caché SQLite 24 h. Agentes solo leen su porción cacheada y nunca inician llamadas pagadas. |
| `POST /api/operations` | Header `Idempotency-Key` + `OperationRequest` | 202 `Operation`. Agentes requieren `operate` + `operationPolicy` de acción y recurso. Se revalidan permisos/capacidad/evidencia antes del proveedor. 403 scope, 400 capacidad inválida, 409 conflicto. |
| `GET /api/operations` | Sesión o bearer con lectura; `limit,cursor,q,actor,state,type,resourceId,view` | `{operations,nextCursor,hasMore}`. Sin query conserva el límite legacy de 100; la UI paginada solicita 20 y el servidor autoriza antes de limitar. |
| `GET /api/operations/active` / `GET /api/operations/review` | Filtros y cursor | Ejecuciones activas y revisiones pendientes independientes del historial reciente. |
| `GET /api/attention/summary` | Lectura autorizada | Conteos completos por alcance y grupos de atención sin sumar órdenes y recursos duplicados. |
| `GET /api/incidents/current` / `GET /api/incidents/history` | Filtros y cursor | `{incidents,nextCursor,hasMore}`: episodios actuales o históricos, con estado, evidencia y disposición accionable. |
| `GET /api/incidents/:id/history` | Cursor y límite | `{events,nextCursor,hasMore}` con versiones del episodio. Reconocer un informe no equivale a recuperación. |
| `POST /api/operations/:id/review` | Sesión personal, Origin exacto; `{expectedVersion,reason}` | Devuelve la orden con revisión durable. `reason`: `checked_state`, `accepted_uncertainty` o `no_further_action`. No cambia el resultado histórico ni ejecuta energía. |
| `GET /api/secrets/requests/pending` | Sesión personal; filtros y cursor | `{requests,pendingCount,nextCursor,hasMore}`; el conteo pendiente no depende de la página de historial. |
| `GET /api/secrets/audit` | Sesión personal; filtros y cursor | `{events,nextCursor,hasMore}`, eventos más recientes primero. |
| `GET /api/operations/:id` | ID de orden | `Operation`; 404 si no existe. |
| `GET /api/operations/:id/history` | ID de orden | `{events:[{id,type,aggregateId,payload,createdAt}]}`; conserva accepted/running/terminal y transiciones por reinicio. |
| `GET /api/events` | Sesión o bearer de lectura; `Last-Event-ID` o `?cursor=` opcionales | SSE durable `desktop`, `resource`, `operation`, `incident`, `coverage`; replay filtrado por `readPolicy`. `coverage` solo se envía cuando cambia el estado de un scope autorizado. `resync` pide una nueva snapshot si el cursor salió de la retención. Máximo 50 streams y replay de hasta 250 eventos. |
| `GET /api/openapi.json` | Autenticado | Especificación de integración. |
| `POST /api/mcp` | Bearer de agente o sesión humana; Host exacto, Origin exacto si se envía | MCP Streamable HTTP stateless. `initialize`, `tools/list` y `tools/call`; tools limitadas por `mcpTools` y scope. MCP solo lee caché de costes. Host ajeno 421, Origin ajeno 403. |

El cursor de inventario/SSE es numérico para sesiones sin restricciones y opaco para credenciales con `readPolicy`. Consérvalo sin interpretarlo y usa `Last-Event-ID` al reconectar. Si el cursor se invalida por un reinicio o un cambio de credencial o política, solicita un inventario nuevo.

Los agentes con `readPolicy` reciben alcance filtrado de igual forma en REST, MCP y SSE. Los selectores admitidos son `resourceIds`, `catalogIds`, `projectIds`, `connectionIds`, `accountIds` y `costs`; también filtran relaciones de servicio, operaciones, cobertura, salud e incidentes. MCP `list_projects` incluye los servicios del proyecto y únicamente las relaciones visibles para el token. Para escribir se exigen `operate`, tool permitida y `operationPolicy` con acción + selector de destino. Cambios de política invalidan planes MCP ya preparados. La API de energía comparte autorización y revalida capacidad, evidencia y estado justo antes de enviar.

No existe terminal, WebSocket, endpoint de favoritos, integración de chat Hermes, gestión Wi-Fi ni restart/deploy de Coolify. Web Push usa VAPID y outbox SQLite; queda inactivo si falta configuración VAPID y requiere validación real de PWA instalada. La salud de Hermes requiere instalar `ops/hermes/reporter.py`, configurar la unidad systemd real y registrar el token dedicado. La telemetría del FiberHome está implementada en código, pero no se considera activa hasta instalar el script, la llave restringida y el servicio colector.

## Resource y acciones

`Resource` devuelve `id`, `name`, `kind`, `state`, `location`, `account`, `detail`, `actions`, `observedAt` y opcional `note`. El backend añade `health` por señal y `actionAvailability` con `reasonCode`; los consumidores que todavía no los usan pueden ignorarlos. `kind` es `ec2 | service | router | computer`.

Las definiciones privadas `services` mantienen identidad lógica estable por `key`, proyecto/entorno, criticidad y relaciones físicas explícitas con evidencia `operator_confirmed` o `provider_metadata`. Los IDs de recurso pueden ser aliases legacy o `catalog:<uuid>`; alias aún no observados se conservan como `resolved:false` y se enlazan cuando el catálogo los descubre. Renombrar/mover un host cierra la relación anterior y crea la nueva sin cambiar el ID del servicio. No se unen servicios por nombre parecido ni se devuelven destinos de sonda o credenciales.

- **La lista `actions` es la autoridad.** No derivar un botón de la presencia de una tarjeta, ni de un color o nombre. Solo aceptar las acciones enumeradas en el tipo API: `start | stop | refresh | boot-windows | boot-cachyos`.
- `id` es opaco para UI: no construir ARNs, comandos ni URLs de proveedor. No parsear el ID para decidir permisos.
- EC2: `running` ofrece `stop,refresh`; `stopped` ofrece `start,refresh` solo si el scope está sano y snapshot/estado tienen menos de20min. `actionAvailability` explica `scope_unavailable`, `observation_stale`, `state_mismatch` o `not_in_legacy_allowlist`; `refresh` queda como lectura explícita para recursos legacy permitidos. Recursos nuevos siguen read-only.
- Coolify: conserva su `status` (`running:healthy`, `running:unknown`, etc.). Permite `refresh` de lectura cuando se pudo consultar; sin controles de despliegue.
- VPS nativo: `catalog.provider: host` distingue el host Linux y sus contenedores Docker del inventario Coolify. Ambos son de solo lectura (`actions: []`). La observación compartida tiene cadencia de 60 s y caduca a los 180 s; ausencia de datos no implica apagado. La salud Docker requiere un `Health.Status` explícito, no solo `running`. Un permiso sobre el host no concede permisos sobre sus contenedores ni revela sus conteos. Un hueco de observación no produce un aviso de recuperación.
- Router: presencia de telemetría SSH si la muestra tiene menos de45s; CWMP reciente si último Inform tiene menos de180s; `stale` si las señales expiraron; `unknown` si no hay observación. `refresh` usa un sondeo autenticado del túnel, coalescido durante10s; confirma únicamente que el FiberHome respondió por el canal privado. Túnel, telemetría, CWMP, enlace WAN e Internet son señales separadas. Ninguna señal aislada garantiza conectividad completa de Internet.
- PC de casa configurada con reporter: `running`, `stopping`, `stopped`, `pending` y `unreachable` representan la señal saliente autenticada del SO; `unreachable` nunca confirma apagado. `health.presence` usa TTL45s y `health.service` permanece `unknown` porque un heartbeat no valida aplicaciones. `health.control` no afirma que la ruta de órdenes funcione si no se probó. Si la identidad está fresca, se anuncian apagado/cambio al SO contrario; si está apagada o sin señal, `start` solicita WOL del FiberHome una vez. `refresh` lee el último reporte sin consultar al PC. Un cambio solo concluye cuando reporta un bootId nuevo y el SO objetivo. Todas las acciones no refresh requieren confirmed:true.
- Mac sin reporter configurado: `unconfigured`; con reporter configurado pero sin primer reporte: `unknown`. No confundir ninguno con apagado. El reporter envía presencia cada15s y el TTL es90s; ausencia no significa apagado.
- Hermes: `health.service` solo aparece en el recurso EC2 configurado explícitamente. `healthy` requiere un heartbeat fresco con `systemd ActiveState=active`; EC2 `running` por sí sola no valida Hermes. `stale` indica que pasó el TTL sin nuevos reportes; durante una operación EC2 `start`/`stop` reciente se marca como transición esperada y no se envía una alerta de caída.
- Hostmetrics OTLP: recursos ligados a `otelCollectors` incluyen CPU, memoria, filesystems y contadores de red bajo `hostMetrics`. `health.telemetry` pasa a `stale`90s después de la última observación y el backend difunde esa transición por SSE sin escribir cada muestra al historial durable. Esta señal describe métricas del host, no el estado de procesos o aplicaciones.
- Sondas HTTPS: `serviceProbes` es una lista de configuración privada vacía por defecto. Cada entrada ata un alias/canonical `catalog:<uuid>` a una URL HTTPS fijada y a estados 2xx esperados; máximo10 destinos, cadencia mínima30s y timeout total DNS+HTTPS máximo3s. El monitor solo consulta recursos activos ya observados. Resuelve DNS, rechaza el destino si cualquier respuesta no es IP pública, fija la conexión a una IP validada, mantiene validación TLS/SNI y no sigue redirecciones. No acepta URL de tags, petición, UI o LLM. `health.service` marca `unknown` antes del primer resultado y al vencerlo; cambios de estado se escriben en el historial y se envían por SSE. Una respuesta no esperada crea incidente; Push de infraestructura espera120s y se cancela si el servicio se recupera antes, aunque haya habido errores de transporte intermedios. Los errores de transporte quedan `unknown` y no se anuncian como caída. No hay auto-remediación. `/api/system/health` muestra solo conteos dentro del alcance del lector. Sin una ruta pública/HTTPS confirmada para un servicio real, no rellenar la configuración ni afirmar que está monitorizado.
- Push: las escrituras requieren sesión humana, Origin exacto y agente no. Solo acepta endpoints Apple/Google/Mozilla por HTTPS, comprueba DNS público al conectar, valida la clave P-256 y cifra la suscripción en SQLite. La prueba es una notificación segura a un endpoint registrado, nunca confirma recepción hasta comprobar el sistema operativo real. Los TTL son600s para órdenes/dispositivos,900s para infraestructura/router y24h para presupuestos; el servidor descarta un mensaje vencido antes de enviarlo y el Service Worker vuelve a validar la fecha antes de mostrarlo. Recuperación del router solo se notifica si previamente se envió la alarma de90s. Entregas terminales se retienen30d y claves de deduplicación400d.
- `observedAt` es la fecha real de observación/reporte. `fetchedAt` del wrapper es la respuesta del panel y **no** convierte datos cacheados en frescos.
- La consulta de inventario y el `refresh` rápido no crean una tarea CWMP. `/api/router/check` prueba solo el túnel privado; no consulta la PC y no acredita WAN/Internet. No hay una tarea de diagnóstico CWMP expuesta por esta API.

## Hoy y Actividad: lectura operacional

Hoy usa el resumen autorizado como fuente de totales. Disponibilidad, frescura y ausencia de equipos personales son información separada, no una suma de tareas. Cero scopes se muestra como «Sin comprobar». Las páginas de incidentes actuales pueden contener observaciones no accionables; se separan de las tareas y su navegación permanece disponible aunque toda una página sea informativa.

Las colecciones solicitan como máximo 20 filas y usan cursores opacos del servidor. Cambiar filtros reinicia el cursor; una respuesta anterior no sustituye la consulta nueva. Actividad abre Órdenes por defecto: se retiró «Todo» porque mezclar páginas limitadas de fuentes independientes no produce una cronología global completa. Autor es un filtro exacto para órdenes y auditoría; los episodios no ofrecen atribución de autor. El historial de una orden, que la API devuelve completo, limita su renderizado local a 20 eventos por página.

Resumen y colecciones se vuelven a leer cada 60 s después de una lectura correcta, solo visibles y online, y al reanudar o reconectar. Las colecciones con ejecución activa usan 5 s. Las esperas y errores siguen bajo `useRead`; no se solicitan refrescos externos de proveedor. Consultar el estado no marca una revisión. La revisión humana exige confirmación y versión; ante conflicto o respuesta ambigua se ofrece una lectura explícita, sin repetir automáticamente la escritura. `reviewed` y `superseded` conservan `failed`/`uncertain` como resultados históricos.

## Órdenes asíncronas

```json
{
  "resourceId": "id-opaco-devuelto-por-resources",
  "action": "stop",
  "confirmed": true
}
```

`Idempotency-Key`: 1–100 caracteres de `[a-zA-Z0-9_-]`; se recomienda `crypto.randomUUID()`. Mantener la misma clave para recuperar un envío ambiguo de **la misma** intención; generar otra solo tras una nueva acción deliberada. Energía exige `confirmed:true` tras la confirmación humana/autorización del agente. No ejecutar desde previews de diseño.

Estados: `accepted → running → succeeded | failed | uncertain`. Cada transición queda en el log durable de eventos y en `/api/operations/:id/history`. Una orden deduplicada puede devolver su estado terminal con HTTP 202; leer el objeto, no inferir estado del HTTP. El cuerpo incluye ID, nombre/ID del recurso, acción, actor, estado, mensaje y fechas.

- `accepted`: registrada, pendiente de ejecutar.
- `running`: se está ejecutando y/o comprobando; no existe porcentaje de avance.
- `succeeded`: comprobación del proveedor. AWS running no comprueba la app alojada. Router exige tarea completada y hojas recientes.
- `failed`: el backend no completó/verificó la operación. El texto pide comprobar estado; no es permiso para repetir automáticamente.
- `uncertain`: el proveedor pudo recibir la orden o falta confirmar el resultado. Primero consultar estado. El panel nunca reenvía automáticamente una escritura ambigua.
- Tras reinicio, las órdenes interrumpidas pasan a `uncertain`, sin reproducirse.

Comprobación EC2: cada 15 s, hasta 12 lecturas tras una única escritura. Router: cada 15 s, hasta 10 comprobaciones; no más de una tarea explícita cada 120 s por proceso. Una operación activa por recurso; límite general 10 órdenes/min/IP. Proveedores compartidos con otros consumidores conservan sus propios límites.

## CostReport

Campos generales: `accounts`, `fetchedAt`, `nextRefreshAt`, `periodStart`, `periodEnd` (excluido) y `policy`. Fechas de período en UTC. La fecha de consulta es del backend, no una promesa de facturación en tiempo real.

Cada cuenta: `account`, `status:available|partial|unavailable`, `net`, `usage`, `adjustments`, `currency`, `estimated`, `services`, `daily`, `budgetsStatus`, `budgets`, `fetchedAt`.

- `net` incluye créditos/reembolsos; `usage` agrupa el resto de cargos y ajustes; `adjustments` representa Credit/Refund. No llamar `usage` “gasto bruto puro” ni equivaler neto cero a infraestructura gratis.
- `null` significa sin valor disponible; no reemplazarlo por 0. Mostrar redondeo de moneda sin alterar el dato almacenado; pequeñas cantidades negativas pueden ser ajustes.
- `partial` indica que se cortó paginación por la política de gasto. Un subtotal parcial no entra silenciosamente en un total de cuentas completo.
- `services` contiene neto por servicio, incluyendo créditos. `daily` tiene los días devueltos; puede ser neto negativo. No inventar gráfica mensual completa ni datos de meses anteriores.
- Presupuestos consultados independientemente: pueden estar disponibles aunque CE falle. `budgetsStatus:available` con lista vacía significa que AWS no devolvió presupuestos de coste. `unavailable` no significa que no existan.
- Presupuesto: `name`, `limit`, `actual`, `forecast`, `currency`, `updatedAt`. `forecast:null` no es una predicción cero. No se crea ni modifica presupuesto.
- Caché persistente 24 h, deduplicada por cuenta STS y reserva previa a cada llamada Cost Explorer. Hasta 2 páginas CE/cuenta/ciclo, `maxAttempts:1`; el cálculo muestra cuentas únicas y el supuesto de precio/páginas/ciclos. Agentes nunca refrescan Cost Explorer/Budgets. No se fuerza refresco desde PWA.

## Reglas del handoff

Frontend: React + TypeScript, tipos anteriores y provider adapter sustituible. Los fixtures están identificados como prototipo; el adaptador real consume API misma-origin. Mantener el árbol visual y tokens congelados durante las mejoras del sistema. Si una interacción exige campos o endpoints adicionales, anotarla como brecha antes de inventarla.

Polling previsto para UI: inventario visible 60 s; actividad 5 s únicamente mientras haya pendientes; nada en background/offline, sin requests solapados. Respeta 429/backoff y muestra antigüedad de datos. Un refresh manual de UI no evita TTL ni genera más llamadas CE.

## PC: estado comunicado y selector de sistema (2026-10-21)

`GET /api/events` entrega SSE con cursor monotónico SQLite y autenticación de lectura. La conexión se suscribe antes del replay; al salir de la ventana de 10.000 eventos envía `resync` y pide nueva snapshot. `GET /api/resources.cursor` se toma antes de consultar proveedores, de modo que un cliente puede abrir `GET /api/events?cursor=<cursor>` después del inventario sin perder transiciones durante el fetch. Cada instancia del panel comparte hasta 50 streams; los keepalives no consultan proveedores ni equipos. Los cambios se envían al insertar un evento.

`POST /api/desktop/events` recibe `{bootId, sequence, event}`. Token exclusivo por SO, almacenado solo como hash en el panel; no permite leer ni operar. Eventos: online, heartbeat, poweroff, reboot, stopping. Secuencia monótona por arranque, recepción persistida y arranques anteriores retirados. El reporter publica online al inicio y heartbeat cada10s; los duplicados son idempotentes y no rejuvenecen presencia. La expiración a 45s y el paso de stopping a stopped generan eventos una sola vez mediante temporizador del servidor, no por polling de cada cliente.

El canal de órdenes (`/api/desktop/commands`) es un acelerador del camino SSH, no un reemplazo. El agente de cada SO mantiene una conexión HTTPS saliente en espera; el panel entrega por ahí `off`, `windows` o `cachyos` solo si el agente declaró la capacidad `power`, y el agente exige que `expectedBootId` coincida con su arranque actual antes de ejecutar. El panel espera la confirmación 3 s: si la orden no se recogió se cancela y se usa el broker SSH; si ya se entregó pero no se confirmó queda `uncertain` y jamás se reenvía por SSH (una sola ejecución). `ping` mide la latencia sin tocar la PC y se envía solo al (re)conectar. El estado del canal (`connected`, `caps`, `lastPingMs`) aparece en `GET /api/system/health` bajo `desktopChannel` y se guarda en SQLite para diagnóstico. Las capacidades las fija el dueño de la PC en `commander.json`; hasta que incluya `power`, todas las órdenes de energía siguen por SSH.

La preferencia UEFI separa `desired`, `effective`, `state`, `version`, `requestedAt`, `observedAt` y `verifiedAt`. `POST` requiere `expectedVersion` para evitar sobrescribir una intención reciente e `Idempotency-Key` para recuperar la misma petición. Si el broker no puede autenticar la PC antes de escribir, queda `pending`; esa intención no bloquea WOL y se puede cancelar con `DELETE`. El siguiente aviso PC intenta reconciliarla tras una verificación SSH; nunca se aplica por ausencia de red, no se reintenta una escritura ambigua y no se altera BootNext. Si el resultado es incierto, `GET .../verify` efectúa una lectura UEFI y resuelve el estado o registra `drift`, sin corregirlo automáticamente. El helper Windows ordena `{fwbootmgr}` y el de CachyOS `BootOrder`; ambos guardan el orden original y verifican la lectura posterior. Ninguno reinicia.

Con la PC en línea y controlada, `boot-windows` y `boot-cachyos` están siempre disponibles, también para el sistema que ya está activo: elegir el actual es «reiniciar en el mismo sistema» (mismo comando fijo; el panel lo confirma con un `bootId` nuevo del mismo SO). El broker ya no responde 409 por ello.

La PC se muestra primero y compacta: SO directo, Apagar si running, Encender si apagado anunciado/sin señal, selector modal de SO. Resource.actions sigue autorizando capacidades. No mostrar Encender durante una transición. Elegir SO con PC sin señal intenta WOL una vez; tras el aviso del SO predeterminado cambia una vez si hace falta. Los avisos no verifican alimentación eléctrica.
