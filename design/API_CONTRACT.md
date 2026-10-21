# Contrato de integración para Claude Design → Codex

Estado: backend TypeScript; la UI de Claude queda visualmente congelada durante esta implementación. Fuente de tipos: `../contracts/api.ts` y sus exports **type-only**. OpenAPI generado: `../contracts/openapi.json`. El archivo se regenera con `npm run contract`; el diseño no modifica `server/` ni amplía capacidades silenciosamente.

## Despliegue y autenticación

Origen previsto compartido: `https://panel.example.com`. Antes de integrar, Codex debe comprobar `/health` y el estado real de despliegue; la presencia del contrato no acredita que esté desplegado.

- Navegador: sesión cookie `__Host-infra`, HttpOnly, Secure, SameSite=Strict, duración 7 días. `fetch` del mismo origen. No leer/guardar el token de sesión desde JS.
- Agentes: `Authorization: Bearer $INFRA_CONTROL_TOKEN`; scopes `read` o `read,operate`. El frontend no necesita ni recibe ese token.
- Toda escritura humana, incluido login, exige `Origin` exactamente igual al origen configurado. La envía el navegador; no implementar CORS abierto para el prototipo. Los fixtures de diseño son locales y tipados.
- `/api/*` responde `Cache-Control: no-store`. Sin caché de Service Worker ni almacenamiento persistente de datos privados en la PWA.
- Las respuestas de error tienen `{ "error": "mensaje en español" }`; no contienen stack ni credenciales. 401: volver al acceso y limpiar estado privado. 403: origen/scope no permitido. 429: respetar `Retry-After`, sin bucle de reintentos.

## Endpoints actuales

| Método y ruta | Entrada | Resultado |
|---|---|---|
| `GET /health` | Sin autenticación | `{status:"ok"}`. Acredita el proceso, no salud de todos los proveedores. |
| `POST /api/auth/login` | `{username:"admin", password:string}` | 200 `{name:"Admin"}` y cookie. 401 credenciales, 429 tras 5 intentos fallidos/15 min/IP. |
| `GET /api/auth/me` | Sesión o bearer | `{name,agent,scopes}`; 401 sin sesión. |
| `POST /api/auth/logout` | `{}` | 200 `{ok:true}`, revoca sesión. |
| `POST /api/auth/password` | `{current,password}` | Nueva contraseña 16–256 caracteres. Solo sesión humana; revoca todas las sesiones. 5 intentos/15 min. |
| `GET /api/resources` | Ninguna | `{resources:Resource[],fetchedAt,refreshSeconds:60,cursor}`. `cursor` se captura antes de consultar proveedores para recuperar por SSE cualquier cambio ocurrido mientras llega la snapshot. |
| `GET /api/router/health` | Ninguna | Snapshot SQLite local; no llama al router, ACS ni PC. Devuelve señales separadas para túnel, telemetría, CWMP, WAN e Internet; las no medidas quedan desconocidas. La vista pasa a stale a45s; Push espera90s de silencio continuo. |
| `POST /api/router/check` | Sesión humana o bearer con lectura y operación | Comprueba una vez el canal SSH privado del FiberHome, sin consultar PC, ACS, WAN o Internet. Comparte resultado durante10s y limita a6 solicitudes/minuto. Un ACK negativo del broker significa “sin respuesta del túnel”, no router apagado ni caída de Internet. Si el broker local no responde, devuelve503 y conserva el último estado observado. |
| `POST /api/router/telemetry` | Bearer exclusivo del colector, sin sesión humana | Muestra validada con bootId, streamId, secuencia, uptime, CPU y memoria. El token se almacena como hash; la llave SSH vive solo en el host VPS. |
| `POST /api/desktop/events` | Token exclusivo del SO | Reporte saliente autenticado de Windows/CachyOS; no concede lectura ni control. |
| `GET /api/desktop/commands` / `POST /api/desktop/commands/:id/ack` | Token exclusivo del SO (el mismo de los avisos) | Canal de órdenes iniciado por la PC: long-poll de hasta 25 s con `caps` (`ping`, `power`, `boot-default`). 200 entrega `{id, command, expectedBootId, issuedAt}` de una lista cerrada; 204 si no hay. El agente confirma con `{accepted, bootId}`. No concede lectura ni operación de la API. |
| `POST /api/hermes/events` | Bearer exclusivo del reporter Hermes, sin sesión de panel | Solo estado `systemd` active/inactive/failed/unknown, contador de reinicios, bootId, streamId y secuencia. No incluye chats, argumentos, logs ni secretos. |
| `GET /api/hermes/health` | Sesión o bearer con lectura | Último snapshot de la unidad systemd configurada; stale tras45s. No consulta EC2 ni SSH. |
| `GET /api/system/health` | Sesión o bearer con lectura | Diagnóstico del backend y observadores; Cloud solo consulta cada300s cuando hay suscripciones Push y costos conservan su caché24h. |
| `GET /api/push/config` | Público | Solo `{enabled,vapidPublicKey}`; nunca devuelve la clave privada o la clave de cifrado. |
| `GET /api/push/status` / `GET /api/push/subscriptions` | Sesión humana; agentes no pueden administrar avisos | Conteos y resumen de esta cuenta; nunca se devuelve endpoint Push ni claves de dispositivo. |
| `POST /api/push/subscriptions` | Sesión humana + Origin exacto | Crea/actualiza una suscripción de proveedor permitido. Hasta5 altas/min; endpoints y claves quedan cifrados en SQLite. |
| `PUT /api/push/subscriptions/:id/preferences` / `DELETE /api/push/subscriptions/:id` | Sesión humana + Origin exacto | Actualizar preferencias o revocar dispositivo; revocar elimina también su outbox. |
| `POST /api/push/subscriptions/:id/test` | Sesión humana + Origin exacto | Encola una prueba para ese dispositivo, una/minuto y TTL60s. HTTP202 solo confirma cola; verificar en el equipo que recibió la notificación. |
| `GET /api/desktop/boot-preference` | Ninguna | Preferencia deseada, último valor UEFI efectivo y versión; lectura SQLite, sin consultar a la PC. |
| `POST /api/desktop/boot-preference` | `{system,confirmed:true,expectedVersion}` + `Idempotency-Key` | 200 si el valor se verificó; 202 si queda pendiente o incierto; 409 al repetir una operación terminal fallida. No enciende ni reinicia. |
| `DELETE /api/desktop/boot-preference/pending` | `{expectedVersion}` | Cancela una intención offline que todavía no se aplicó; 409 si cambió la versión o ya no está pendiente. |
| `GET /api/desktop/boot-preference/verify` | Ninguna | Lectura UEFI explícita con identidad SSH autenticada; detecta `drift` sin corregirlo automáticamente. Se bloquea durante una operación de PC. |
| `GET /api/costs` | Ninguna | `CostReport`: consulta bajo demanda con caché SQLite 24 h. Primer cálculo puede ser lento; contempla espera larga/timeout sin forzar llamadas adicionales a AWS. |
| `POST /api/operations` | Header `Idempotency-Key` + `OperationRequest` | 202 `Operation`. 400 orden/capacidad inválida, 409 clave reutilizada con otra orden u operación activa del mismo recurso. |
| `GET /api/operations` | Ninguna | `{operations:Operation[]}`, hasta 100 más recientes. |
| `GET /api/operations/:id` | ID de orden | `Operation`; 404 si no existe. |
| `GET /api/operations/:id/history` | ID de orden | `{events:[{id,type,aggregateId,payload,createdAt}]}`; conserva accepted/running/terminal y transiciones por reinicio. |
| `GET /api/events` | Sesión o bearer de lectura; `Last-Event-ID` o `?cursor=` opcionales | SSE durable `desktop`, `resource`, `operation`, `incident`. `resync` pide una nueva snapshot si el cursor salió de la retención. Máximo 50 streams y replay de hasta 250 eventos. |
| `GET /api/openapi.json` | Autenticado | Especificación de integración. |

No existe terminal, WebSocket, endpoint de favoritos, integración de chat Hermes, gestión Wi-Fi ni restart/deploy de Coolify. Web Push usa VAPID y outbox SQLite; queda inactivo si falta configuración VAPID y requiere validación real de PWA instalada. La salud de Hermes requiere instalar `ops/hermes/reporter.py`, configurar la unidad systemd real y registrar el token dedicado. La telemetría del FiberHome está implementada en código, pero no se considera activa hasta instalar el script, la llave restringida y el servicio colector.

## Resource y acciones

`Resource` devuelve `id`, `name`, `kind`, `state`, `location`, `account`, `detail`, `actions`, `observedAt` y opcional `note`. El backend añade `health` por señal y `actionAvailability` con `reasonCode`; los consumidores que todavía no los usan pueden ignorarlos. `kind` es `ec2 | service | router | computer`.

- **La lista `actions` es la autoridad.** No derivar un botón de la presencia de una tarjeta, ni de un color o nombre. Solo aceptar las acciones enumeradas en el tipo API: `start | stop | refresh | boot-windows | boot-cachyos`.
- `id` es opaco para UI: no construir ARNs, comandos ni URLs de proveedor. No parsear el ID para decidir permisos.
- EC2: `running` ofrece `stop,refresh`; `stopped` ofrece `start,refresh`; estados transitorios solo `refresh`. Si el proveedor no pudo consultarse: `unknown`, sin acciones.
- Coolify: conserva su `status` (`running:healthy`, `running:unknown`, etc.). Permite `refresh` de lectura cuando se pudo consultar; sin controles de despliegue.
- Router: presencia de telemetría SSH si la muestra tiene menos de45s; CWMP reciente si último Inform tiene menos de180s; `stale` si las señales expiraron; `unknown` si no hay observación. `refresh` usa un sondeo autenticado del túnel, coalescido durante10s; confirma únicamente que el FiberHome respondió por el canal privado. Túnel, telemetría, CWMP, enlace WAN e Internet son señales separadas. Ninguna señal aislada garantiza conectividad completa de Internet.
- PC de casa configurada con reporter: `running`, `stopping`, `stopped`, `pending` y `unreachable` representan la señal saliente autenticada del SO; `unreachable` nunca confirma apagado. `health.presence` usa TTL45s y `health.service` permanece `unknown` porque un heartbeat no valida aplicaciones. `health.control` no afirma que la ruta de órdenes funcione si no se probó. Si la identidad está fresca, se anuncian apagado/cambio al SO contrario; si está apagada o sin señal, `start` solicita WOL del FiberHome una vez. `refresh` lee el último reporte sin consultar al PC. Un cambio solo concluye cuando reporta un bootId nuevo y el SO objetivo. Todas las acciones no refresh requieren confirmed:true.
- Mac sin reporter configurado: `unconfigured`; con reporter configurado pero sin primer reporte: `unknown`. No confundir ninguno con apagado. El reporter envía presencia cada15s y el TTL es90s; ausencia no significa apagado.
- Hermes: `health.service` solo aparece en el recurso EC2 configurado explícitamente. `healthy` requiere un heartbeat fresco con `systemd ActiveState=active`; EC2 `running` por sí sola no valida Hermes. `stale` indica que pasó el TTL sin nuevos reportes; durante una operación EC2 `start`/`stop` reciente se marca como transición esperada y no se envía una alerta de caída.
- Push: las escrituras requieren sesión humana, Origin exacto y agente no. Solo acepta endpoints Apple/Google/Mozilla por HTTPS, comprueba DNS público al conectar, valida la clave P-256 y cifra la suscripción en SQLite. La prueba es una notificación segura a un endpoint registrado, nunca confirma recepción hasta comprobar el sistema operativo real. Los TTL son600s para órdenes/dispositivos,900s para infraestructura/router y24h para presupuestos; el servidor descarta un mensaje vencido antes de enviarlo y el Service Worker vuelve a validar la fecha antes de mostrarlo. Recuperación del router solo se notifica si previamente se envió la alarma de90s. Entregas terminales se retienen30d y claves de deduplicación400d.
- `observedAt` es la fecha real de observación/reporte. `fetchedAt` del wrapper es la respuesta del panel y **no** convierte datos cacheados en frescos.
- La consulta de inventario y el `refresh` rápido no crean una tarea CWMP. `/api/router/check` prueba solo el túnel privado; no consulta la PC y no acredita WAN/Internet. No hay una tarea de diagnóstico CWMP expuesta por esta API.

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
- Caché persistente 24 h, single-flight y reserva previa a llamada pagada. Hasta 2 páginas CE/cuenta/ciclo, `maxAttempts:1`. Para 3 cuentas y vista primaria: hasta 6 solicitudes/ciclo; a US$0,01, hasta US$1,80 por 30 ciclos, excluyendo exploración manual y otros consumidores. No se fuerza refresco desde UI.

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
