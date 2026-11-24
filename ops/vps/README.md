# Operación segura en el VPS

## Permisos de descubrimiento AWS

El descubrimiento completo requiere identidad STS, `ec2:DescribeRegions` y `ec2:DescribeInstances` en las regiones consultadas. Validar esos permisos con las credenciales dedicadas antes del relevo; no copiar perfiles administrativos al VPS. Si la enumeración regional falla, el backend mantiene `aws:regions` degradado y continúa únicamente con regiones del inventario legacy, caché previa o catálogo persistido. Esa lectura limitada no acredita cobertura de regiones nuevas. Un mismatch de identidad STS impide también el fallback.

## Servicios lógicos y topología explícita

`services` es opcional en el archivo privado de `CONFIG_PATH`. Modela aplicaciones/proyectos independientemente de instancias EC2 y servicios de Coolify. Mantén `key` estable al renombrar o mover un servicio. Cada relación debe declarar `hosted_on` o `depends_on` y evidencia `operator_confirmed` o `provider_metadata`; no se infieren enlaces por nombres parecidos. Ejemplo de configuración con alias ficticio:

```json
{
  "services": [{
    "key": "example-api",
    "name": "Example API",
    "projectKey": "example-project",
    "projectName": "Example Project",
    "environment": "production",
    "criticality": "high",
    "relations": [{
      "resourceId": "aws:example:i-example",
      "relationType": "hosted_on",
      "evidence": "operator_confirmed"
    }]
  }]
}
```

El catálogo resuelve aliases cuando los descubre el inventario, conserva los IDs y marca como inactivos servicios/relaciones retirados por una actualización de configuración. Omitir `services` en el siguiente arranque también desactiva las definiciones anteriores. Para agentes, permitir lectura de un proyecto no autoriza a revelar todos sus hosts: cada relación se filtra además por el scope del recurso.

## Sondas de salud de servicios

`serviceProbes` es opcional y viene vacío en `scripts/public/config.example.json`. Solo se activa tras confirmar una ruta HTTPS de salud que no requiera credenciales; la lista pertenece al archivo privado de configuración del backend, nunca al frontend, MCP, tags del proveedor o configuración de Rakazo. Usa un alias que ya pertenezca al catálogo o `catalog:<uuid>` observado. Máximo10 destinos; intervalo30–600s; timeout total DNS+HTTPS de 250–3000ms. Solo se aceptan HTTPS en puerto443, sin query, credenciales URL ni redirecciones. La validación fija DNS a IP pública y conserva TLS/SNI. No apuntar a IPs, hostnames locales ni rutas privadas.

El backend deja la sonda en `unknown` cuando el recurso aún no se observó o la última señal venció. `health.service` y los conteos de `/api/system/health` no incluyen la URL. No hay destinos reales configurados en este repo y no se debe inventar uno; activar el monitor requiere verificar primero el endpoint público correcto. Las sondas solo observan: no reinician ni remedian servicios.

## Admitir un despliegue de Infra Control

El contenedor conserva una única conexión SQLite protegida por `flock`. Antes de reemplazarlo hay que evitar que una orden activa quede interrumpida y marcada `uncertain`.

1. Construye y valida la nueva imagen local antes de cerrar la admisión.
2. Ejecuta `python3 /opt/infra-control/current/ops/vps/deployment-gate.py enter`. La operación crea una compuerta SQLite atómica, rechaza el relevo si existe una orden `accepted` o `running`, y respalda `/opt/infra-control/data/infra.sqlite` con la API de backup de SQLite (incluye transacciones WAL confirmadas). La salida JSON devuelve el `owner` y la ruta del backup.
3. Si la compuerta rechaza el relevo, espera el resultado de la orden y repite desde el paso 2. No fuerces el cierre del panel.
4. Despliega únicamente el servicio Compose `api`; no reinicies Coolify ni otras aplicaciones. Si la release cambia el código del broker WOL del host, instala su unit file desde la release activa, ejecuta `systemctl daemon-reload` y reinicia solo `infra-control-wol.service`; comprueba el socket y conserva `/run/infra-control-wol`.
5. Comprueba `/health`, login/API, la conexión SSE, los datos persistidos y las unidades host que cambiaron. Luego libera la compuerta con `python3 /opt/infra-control/current/ops/vps/deployment-gate.py release --owner <owner-devuelto>`.

La compuerta rechaza nuevas órdenes durante el relevo y responde HTTP503 con `Retry-After: 15`. Los avisos de estado siguen entrando. El lease predeterminado dura30min, máximo60min; vence solo como recuperación ante una sesión de operador abandonada. No liberes el lease si el resultado del despliegue sigue incierto: primero inspecciona el servicio y el estado de las órdenes.

Coolify no ejecuta este script como hook automático. Un redeploy directo desde su UI omite la protección; toda operación de despliegue debe ejecutar explícitamente `enter` antes de reemplazar el servicio. La instalación de un hook debe validarse por separado antes de atribuir automatización.

## Fuente persistente de Coolify

El proyecto productivo es administrado por Coolify y su `docker-compose.yml` en `/data/coolify/services/<service-id>/` es un archivo generado. Coolify conserva la fuente Compose en su propia configuración y puede volver a generar ese archivo al recrear el servicio. El `compose.yaml` de este repositorio es plantilla y no representa por sí solo el stack productivo; ejecutarlo con otro nombre de proyecto puede crear una segunda pila.

En el relevo `panel-0.6.0-4ae0f5d` del 2026-10-23 se reconciliaron la fuente Compose persistente y el archivo generado: ambos apuntan a la imagen publicada. Se respaldaron los campos originales y se usó el modelo/parser de la aplicación Coolify por su canal administrativo autorizado. Antes de recrear `api`, se comprobó que la configuración regenerada normalizada solo cambiara la imagen. La credencial del adaptador de inventario sigue siendo de solo lectura y no se reutiliza para estas escrituras.

La compuerta sigue siendo un procedimiento explícito: un redeploy iniciado directamente desde la UI de Coolify no ejecuta automáticamente el guard. Mantener el paso de admisión/backup aunque Source Compose ya esté sincronizado.

Para cada relevo, identifica el proyecto y el compose reales a partir de las etiquetas `com.docker.compose.project` y `com.docker.compose.project.config_files` del contenedor `api`; valida la ruta antes de modificarla. Respalda el compose con permisos `0600`, cambia solo el valor esperado de `image`, verifica `docker compose config` y la imagen resuelta, y entonces recrea `api` con `--no-deps`. No uses el compose de la plantilla como atajo ni recrees todo el proyecto.

El colector del router apunta a `/opt/infra-control/current/dist/server/router-collector.js` y el broker WOL a `dist/server/wol-broker.js`; ambos usan el Node 24 versionado en `runtime/node`. El release debe permitir al usuario del servicio atravesar su directorio raíz y leer los archivos ejecutables; no guardes secretos dentro del release. `current` debe señalar al release validado que produjo la imagen desplegada y contiene `dist` y `runtime` para permitir reinicios de ambas unidades. Conserva el release previo para rollback. El broker crea `/run/infra-control-wol` con `RuntimeDirectoryPreserve=restart` para que Docker mantenga el mismo directorio montado cuando el socket se recrea; `Before=docker.service` garantiza que el directorio exista antes de iniciar contenedores en el VPS. El unit file del colector espera la llave de telemetría en `LoadCredential` y no monta secretos en el contenedor.

## Diagnóstico del stream FiberHome

El release `panel-0.5.15` registra al cerrar cada sesión SSH una categoría saneada, número de muestras, duración, código de salida y señal. Nunca registra stderr SSH bruto, host, clave ni token; limita a un log por minuto. Esto permite diferenciar corte de transporte, timeout del collector, error de autenticación y error de entrega sin abrir consultas adicionales al router. En el registro reciente se observaron 45 transiciones a `stale` en una hora pese a que el servicio del colector seguía activo; no declares estable la cadencia hasta revisar estas causas y verificar una ventana sostenida.

Las sesiones del colector se cortaban tras 2–4 muestras (32–62 s). Una prueba A/B de solo lectura con `sleep 70`, sobre el mismo listener del túnel, reprodujo el corte sin keepalive a los 33,15 s (exit 255) y completó a los 72,81 s (exit 0) con `ServerAliveInterval=10` y `ServerAliveCountMax=3`. `panel-0.5.17` aplica esas opciones exclusivamente al cliente OpenSSH del colector VPS. No cambia el `dbclient -K0` del router, Dropbear, WAN ni el watchdog del túnel. El reciclaje programado del túnel y su breve ventana de reconexión siguen existiendo. Conserva el reintento tras 1 s para sesiones productivas y el backoff 1/2/5/10/30 s con jitter para sesiones sin entregas. Registra categorías saneadas y `acceptedSamples`; preserva la causa inicial si se cancela una cola por overflow.

Para este parche, primero ejecuta `npm run build` y `npm test`. Luego usa `ops/vps/Dockerfile.panel-0.5.17`: parte de la imagen `.16` y copia únicamente `dist/server/router-collector.js`, preservando la capa pública exacta. No uses el Dockerfile general mientras haya cambios de Claude en `design/handoff/ui` que no hayan sido aprobados/publicados.

## Base de imagen para el siguiente despliegue (UI)

Los tags históricos desde `panel-0.5.18` actualizaron la UI mediante capas que reemplazaban solo `/app/public`. El relevo `panel-0.6.0-b099792` reconstruyó backend y UI desde el repositorio; `panel-0.6.0-4ae0f5d` aplica sobre esa base una corrección exclusiva de `dist/server/app.js`. La comparación de hashes de todos los archivos runtime y públicos confirmó ese único cambio.

Un parche de backend debe partir de la imagen vigente comprobada con `docker ps` y su etiqueta de revisión OCI; no fijar como base un tag histórico. Para una capa dirigida, verificar que todos los archivos no modificados, incluidos los públicos, conserven sus hashes. También se puede construir con el `Dockerfile` general porque la UI aprobada está versionada en `feat/control-panel`.

Antes de reemplazar el servicio, `deployment-gate.py enter` rechaza el relevo si hay una orden `accepted` o `running`; en ese caso no se toca nada y se reintenta cuando termine.

## Relevo `panel-0.8.0-8e68e07` (2026-11-11)

- Fuente: `migration/infra-control` en `8e68e07`, que ya incluye `feat/control-panel` (`4ae0f5d`). Construida en el VPS con el `Dockerfile` general (tests del build: 40 archivos OK), etiqueta OCI `org.opencontainers.image.revision=8e68e075c1a91041da0ee636cf850360a06d90ea`.
- Diferencia de runtime frente a `panel-0.7.1-agent-fixture` comprobada por hashes: en `dist/server` cambian solo `app.js`, `config.js` y se añaden `secrets*.js`; `router-collector.js`, `wol-broker.js` y `pc-control.js` idénticos, por lo que no se reiniciaron unidades del host. UI reconstruida (21 archivos públicos). Mismas 91 dependencias.
- Procedimiento: humo con config ficticia → `deployment-gate.py enter` (0 órdenes activas, backup SQLite) → respaldo 0600 del compose generado y de los tres campos de Coolify en `/opt/infra-control/backups/relevo-panel-0.8.0-<ts>/` → cambio solo de `image` → `up -d --no-deps api` → verificación → `release` → `current` al release nuevo.
- Verificado: contenedor `healthy` sin reinicios, `/health` y `/health/ready` OK, HTTPS público 200, `/api/secrets/requests` sin sesión 401, conteos de `operations`/`event_log`/`sessions`/`catalog_resources` idénticos al backup, socket WOL montado, unidades WOL y router activas. No se probó login humano ni SSE con sesión (no hay credenciales en el agente).
- **Fuente persistente de Coolify sincronizada**: antes de este relevo `docker_compose_raw`, `docker_compose` y `service_applications.image` seguían en `panel-0.6.0-4ae0f5d` (el relevo 0.7.1 solo había cambiado el archivo generado, así que un redeploy desde Coolify habría retrocedido). Ahora los tres apuntan a `panel-0.8.0-8e68e07`; el diff de la fuente cambia solo la línea `image`.
- Secretos: sin bóveda configurada en `server/index.ts` las rutas `/api/secrets/*` responden 503 y no se crean tablas.

Rollback: compuerta `enter`, restaurar `docker-compose.yml` y los tres campos de Coolify desde el directorio de respaldo del relevo, `up -d --no-deps api`, `current` → `releases/panel-0.6.0-4ae0f5d` (la UI 0.7.1 solo existe como imagen `panel-0.7.1-agent-fixture`), verificar y `release`.

## Relevo `panel-0.9.0-bfd0151` (2026-11-11): bóveda de secretos conectada

- Fuente `feat/control-panel` en `bfd0151`; build en el VPS con el `Dockerfile` general (41 archivos de tests OK), incluye `bw` 2026.10.0 en `/opt/bw`.
- `dist/server` frente a 0.8.0: cambian `config.js`, `index.js`, `secrets.js` y se añade `secrets-vault-bw.js`; colector, broker WOL y `pc-control` idénticos (sin reinicio de unidades).
- Humo previo con `--read-only` y tmpfs como en producción, entrando a la bóveda real: «Bóveda de secretos lista».
- Config: añadido `secretsVault` (Vaultwarden, cuenta de servicio dueña de la organización «Agentes») y `secretsPolicy: { projects: ["*"] }` para `hermes` y para el token nuevo `claude-ec2` (EC2). Validada con `parseConfig` de la imagen nueva antes de instalarla. Respaldo de la config anterior en el directorio del relevo.
- Compuerta: 0 órdenes activas. Verificado: `healthy` sin reinicios, «Bóveda de secretos lista», conteos idénticos al backup, tablas `secret_*` creadas, socket WOL y unidades activas. Coolify (raw, generado e `image`) sincronizado a 0.9.0. `current` → `releases/panel-0.9.0-bfd0151`.
- Rollback: como 0.8.0, restaurando además `config.json` desde el respaldo del relevo (la imagen 0.8.0 ignoraría `secretsVault`, pero conviene volver a la config exacta).

## Relevo `panel-0.9.2-780d449` (2026-11-11): aviso push de solicitudes de secretos

- Cambia solo `dist/server/{app,push,secrets,store}.js` y la UI (interruptor «Claves que piden los agentes»). Config sin cambios, validada con la imagen nueva.
- Compuerta: 0 órdenes activas. Verificado: `healthy` sin reinicios, «Bóveda de secretos lista», conteos idénticos al backup, socket WOL y unidades activas. Coolify (raw, generado e `image`) sincronizado. `current` → `releases/panel-0.9.2-780d449`.
- Rollback: compuerta `enter`, restaurar `docker-compose.yml` y los campos de Coolify desde `/opt/infra-control/backups/relevo-panel-0.9.2-780d449-20261111T152208Z/`, `up -d --no-deps api`, `current` → `releases/panel-0.9.1-1c62a81`, verificar y `release`.

## Relevo `panel-0.9.3-f605651` (2026-11-11): piloto de credenciales retirado

- La UI ya no incluye las pantallas del piloto (`/ajustes/credenciales` lleva a `/secretos`). Backend sin cambios.
- `credential-link-pilot.service` (ya estaba en `failed`) quedó `disabled` e `inactive`; su unidad y sus archivos se conservan. `credential-link-pilot-network.service` no se tocó.
- Compuerta: 0 órdenes activas; `healthy` sin reinicios, bóveda lista, conteos coherentes con el backup, WOL y unidades activas. Coolify sincronizado. `current` → `releases/panel-0.9.3-f605651`.
- Rollback: como 0.9.2, desde `/opt/infra-control/backups/relevo-panel-0.9.3-f605651-20261111T155022Z/` hacia `releases/panel-0.9.2-780d449`.


## Relevo `panel-0.15.0-103c818` (2026-11-24): entrega automática desde la bóveda (#258, PR #259)

- Fuente `feat/control-panel` en `103c818` (árbol idéntico al probado, `5f4920d`). Build en el VPS con el `Dockerfile` general: 66 archivos y 654 pruebas OK. Etiqueta OCI con la revisión completa.
- `dist/server` frente a 0.14.0: el colector del router, el broker WOL y `pc-control` son idénticos (no se reiniciaron unidades); los 15 archivos de la UI pública también son idénticos.
- Config: `secretsPolicy.autoDeliver: true` en `hermes`, `claude-ec2`, `mac` y `pc-windows`. No se añadió a `shop-support-prod-groq`, que es un servidor y no un equipo de Admin. Se validó con `parseConfig` de la imagen nueva; la imagen 0.14.0 **rechaza** esta config (validación estricta), así que el rollback debe restaurar también `config.before.json`. Se instaló con un renombrado atómico.
- Ejecutado como unidad systemd (`relevo.py` en el directorio del relevo): compuerta con 0 órdenes activas, respaldos 0600, transacción en Coolify (raw, generado e `image`), compose generado y `up -d --no-deps api`. Verificado: `healthy`, 0 reinicios, «Bóveda de secretos lista», mismos montajes, redes y contenedores ajenos, HTTPS público 200 y `/api/secrets/available` sin sesión 401.
- La aserción de conteos falló por `catalog_resources` 60→61: no hubo eliminados, solo 1 recurso `host:docker` nuevo del observador. Las órdenes y los conteos de secretos coinciden con el backup. Se completaron a mano `current` y `release` con el mismo owner, sin repetir el relevo. Lección: en un catálogo vivo, comparar que no falte ningún ID, no el conteo.
- Aceptación real desde EC2 (`claude-ec2`): `infra-secrets list` devolvió solo nombres. `request BW_CLIENTID --wait 0` entregó en unos 10 s sin aprobación, con la auditoría `created` → `auto_found` → `delivered`, `scope once` y `auto=1`.
- Rollback: compuerta `enter`; restaurar desde `/opt/infra-control/backups/relevo-panel-0.15.0-103c818/` los archivos `docker-compose.yml`, `coolify-fields.json` (tres campos) y `config.before.json` → `/opt/infra-control/secrets/config.json`; `up -d --no-deps api`; `current` → `releases/panel-0.14.0-0b52edf`; verificar y `release`.

## Relevos `panel-0.16.0` a `panel-0.16.4-1b38a5d` (2026-11-24): claves rápidas (#248)

- Se desplegó en cuatro relevos seguidos con la misma plantilla (0.16.0 → 0.16.4; los intermedios corrigieron sincronización del índice y de escritura). Producción queda en `infra-control:panel-0.16.4-1b38a5d`, `current` → `releases/panel-0.16.4-1b38a5d`; backups en `backups/relevo-<release>/`. Imagen de retorno inmediato: `panel-0.16.3-f356118`; la última anterior al cambio es `panel-0.15.0-103c818`.
- Cambios: conector `bw serve` (loopback, supervisado; el índice sincroniza con el servidor en segundo plano cada 30 s y `put` sincroniza antes si la copia tiene más de 30 s), plazo de solicitud de 24 h (`SECRETS_PENDING_HOURS`, 0,25–168), aviso de vencimiento y aviso de entrega automática con preferencia `secretDeliveries`. **La configuración privada no cambia**; el relevo no toca `config.json`.
- Variables opcionales del contenedor: `BW_MODE=cli` vuelve al conector anterior (una CLI por orden) sin cambiar la imagen; `BW_SERVE_PORT` (8087).
- Relevo: `ops/vps` compuerta con 0 órdenes, imagen nueva en los tres campos de Coolify, `up -d --no-deps api`, espera de «Bóveda de secretos lista» (tarda ~15 s tras `healthy`: carga y sincroniza el índice). `catalog_resources` se comprueba por IDs (ninguno ausente), no por conteo.
- La release trae `dist/` y `runtime/node` (los helpers del host corren desde `current`).
- **Rollback:** con la compuerta cerrada, restaurar los tres campos desde `backups/relevo-<release>/coolify-fields.json` y el `docker-compose.yml` respaldado (imagen `infra-control:panel-0.15.0-103c818`), `docker compose -p service-id -f <compose> up -d --no-deps api`, y volver `current` a la release anterior. La imagen anterior acepta la misma configuración. Datos: SQLite compatible hacia atrás (no hay migración); el backup de la compuerta queda en la ruta del checkpoint.
- Cliente: `tools/infra-secrets/install.sh <equipo>` en cada equipo; reclama directo cuando la solicitud nace aprobada.
