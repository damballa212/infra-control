# Operación segura en el VPS

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

El release `panel-0.5.14` se activó modificando el campo `image` del compose generado, con respaldo previo, gate de despliegue, recreate exclusivo del servicio `api` y verificación posterior. La fuente Compose persistente de Coolify sigue pendiente de actualizar; un redeploy desde Coolify puede restaurar la referencia de imagen previa. La credencial disponible para el adaptador de Coolify es de solo lectura y no se reutiliza para escrituras. No marques esta integración como persistente hasta comprobar una actualización de Source Compose por su interfaz/API autorizada y una regeneración controlada.

Para cada relevo, identifica el proyecto y el compose reales a partir de las etiquetas `com.docker.compose.project` y `com.docker.compose.project.config_files` del contenedor `api`; valida la ruta antes de modificarla. Respalda el compose con permisos `0600`, cambia solo el valor esperado de `image`, verifica `docker compose config` y la imagen resuelta, y entonces recrea `api` con `--no-deps`. No uses el compose de la plantilla como atajo ni recrees todo el proyecto.

El colector del router apunta a `/opt/infra-control/current/dist/server/router-collector.js` y el broker WOL a `dist/server/wol-broker.js`; ambos usan el Node 24 versionado en `runtime/node`. El release debe permitir al usuario del servicio atravesar su directorio raíz y leer los archivos ejecutables; no guardes secretos dentro del release. `current` debe señalar al release validado que produjo la imagen desplegada y contiene `dist` y `runtime` para permitir reinicios de ambas unidades. Conserva el release previo para rollback. El broker crea `/run/infra-control-wol` con `RuntimeDirectoryPreserve=restart` para que Docker mantenga el mismo directorio montado cuando el socket se recrea; `Before=docker.service` garantiza que el directorio exista antes de iniciar contenedores en el VPS. El unit file del colector espera la llave de telemetría en `LoadCredential` y no monta secretos en el contenedor.

## Diagnóstico del stream FiberHome

El release `panel-0.5.15` registra al cerrar cada sesión SSH una categoría saneada, número de muestras, duración, código de salida y señal. Nunca registra stderr SSH bruto, host, clave ni token; limita a un log por minuto. Esto permite diferenciar corte de transporte, timeout del collector, error de autenticación y error de entrega sin abrir consultas adicionales al router. En el registro reciente se observaron 45 transiciones a `stale` en una hora pese a que el servicio del colector seguía activo; no declares estable la cadencia hasta revisar estas causas y verificar una ventana sostenida.

Las sesiones del colector se cortaban tras 2–4 muestras (32–62 s). Una prueba A/B de solo lectura con `sleep 70`, sobre el mismo listener del túnel, reprodujo el corte sin keepalive a los 33,15 s (exit 255) y completó a los 72,81 s (exit 0) con `ServerAliveInterval=10` y `ServerAliveCountMax=3`. `panel-0.5.17` aplica esas opciones exclusivamente al cliente OpenSSH del colector VPS. No cambia el `dbclient -K0` del router, Dropbear, WAN ni el watchdog del túnel. El reciclaje programado del túnel y su breve ventana de reconexión siguen existiendo. Conserva el reintento tras 1 s para sesiones productivas y el backoff 1/2/5/10/30 s con jitter para sesiones sin entregas. Registra categorías saneadas y `acceptedSamples`; preserva la causa inicial si se cancela una cola por overflow.

Para este parche, primero ejecuta `npm run build` y `npm test`. Luego usa `ops/vps/Dockerfile.panel-0.5.17`: parte de la imagen `.16` y copia únicamente `dist/server/router-collector.js`, preservando la capa pública exacta. No uses el Dockerfile general mientras haya cambios de Claude en `design/handoff/ui` que no hayan sido aprobados/publicados.

## Base de imagen para el siguiente despliegue (UI)

Desde `panel-0.5.18` la UI se despliega como capas UI-only encima de la imagen anterior (`Dockerfile.panel-0.5.18` en adelante: reemplazan solo `/app/public`, el backend queda igual). Producción corre la última de esas capas, con la UI nueva (Hermes, ícono, Equipos, avisos).

Un parche de backend debe partir de la imagen vigente (`docker ps` en el VPS, p. ej. `FROM infra-control:panel-0.5.24`), no de una anterior como `panel-0.5.17`: partir de una anterior devuelve la UI vieja sin avisar. Alternativa equivalente: construir con el `Dockerfile` general, porque los cambios de `design/handoff/ui` ya están en commits de `feat/control-panel`.

Antes de reemplazar el servicio, `deployment-gate.py enter` rechaza el relevo si hay una orden `accepted` o `running`; en ese caso no se toca nada y se reintenta cuando termine.
