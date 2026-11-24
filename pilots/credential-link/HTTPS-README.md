# Piloto HTTPS aislado — fixture-only

> **RETIRADO (2026-11-11).** Piloto de solo datos ficticios, sustituido por el sistema real `infra-secrets` (Infra Control `/secretos` + Vaultwarden; `docs/secretos-agentes.md`, #204). El servicio `credential-link-pilot` está desactivado y su pantalla salió del panel. No lo uses para credenciales reales ni como señal del estado del sistema actual.

URL: https://panel.example.com/credential-link/

Esta implementación es `https_broker.py`; `broker.py` conserva el laboratorio anterior y NO es el servicio publicado. No hay integración de claves reales ni recovery validado. El agente crea una única intención de demostración mediante control local separado; no modifica login ni esquema SQLite del panel.

## Identidad y límites

Cada petición vuelve a consultar únicamente `GET http://127.0.0.1:17600/api/auth/me`, reenviando sólo la cookie `__Host-infra`. Rechaza cualquier cabecera Authorization, cookies ambiguas, errores de backend y JSON inesperado. Exige `agent is False` y nombre exacto de policy servidor `Admin`. El código de autenticación desplegado fue inspeccionado selectivamente: su login humano único genera sesión de servidor y asigna ese principal; bearer usa `agent:true`. No se ha comprobado una sesión humana positiva en el teléfono. No hay MFA adicional verificado.

La policy root:www-data0440 contiene sólo metadata de propietario, no contraseña ni token. No hay login alternativo del piloto. Ante401 se usa exclusivamente el panel oficial en su raíz HTTPS.

## Flujo humano iPhone

1. Abrir la PWA oficial → Ajustes → Solicitudes de credenciales. La solicitud ya la crea el agente; no hay que elegir destino ni crearla manualmente. Si falta sesión, autenticarse personalmente en el panel dentro del mismo contexto. Nunca enviar contraseña, cookie o código al chat.
2. Abrir la solicitud pendiente, pulsar «Usar dato de demostración» y después «Enviar fixture». El primer botón solo rellena; el segundo confirma la entrega a un hijo aislado, sin llamar OpenAI. Debe aparecer «Usada» y el agente observa `used`.
3. GET/listado/detalle no consumen. Reenvío tras uso devuelve409; denegación es terminal. Solo se admite la fixture pública predefinida, nunca claves reales. El laboratorio HTML anterior conserva `dotenv`0600, validación y borrado inmediato en camino normal.

### Control local del agente

Socket `/run/credential-link-pilot/control.sock`,0600, sin ruta nginx ni listener TCP. Antes de leer bytes exige `SO_PEERCRED` UID0; el operador/agente autorizado usa la conexión SSH existente al host, nunca copia sesión humana. JSON exacto de una línea (máximo1024bytes incluido LF), cerrar escritura y leer respuesta: `{"op":"create"}` o `{"op":"status","id":"<32 hex minúsculas>"}`. No acepta valor, propietario, proyecto, destino ni ruta elegidos por cliente. Policy fija propietario, proyecto `infra-control-private` y destino `process`. Devuelve solo metadata pública y URL del formulario autenticado; no existe get-secret ni ejecución por control.

Una intención idempotente por vida del proceso; TTL1800s independiente de la sesión CSRF humana300s, cupo64 compartido. Una vez usada/denegada/fallida, repetir create conserva el mismo ID y resultado: no renueva TTL ni ejecuta. El TTL solo expira pendientes; terminales y limpieza pendiente siguen observables. Reiniciar pierde la intención, sin recuperación ni repetición; no reiniciar para eludir idempotencia. Creación/status no acreditan que Admin haya abierto el iPhone.

**Safari, navegador dentro del chat y la PWA instalada pueden tener sesiones/cookies distintas.** Tener el panel instalado sin pedir contraseña no demuestra que el enlace del chat pueda usar esa sesión. No extraer/copiar cookies ni simular login humano.

## Contención

- Proceso dedicado UID `credential-link-pilot`, grupo de transporte www-data; socket Unix0660 en directorio0750. No nuevo puerto TCP/público.
- Nft dedicado `inet credential_link_pilot`, limitado a ese UID: sólo salida TCP127.0.0.1:17600; el resto rechaza. Unit de red requerida antes del proceso, sin tocar reglas ajenas.
- systemd sin capacidades, NoNewPrivileges, filesystem protegido, /home /root /data /opt/infra-control y Docker socket inaccesibles; límites128M/20%CPU/32tasks. No protege de root ni de administradores autorizados que pueden cambiar estas barreras.
- Ocho workers por listener, plazo total socket4s, bucket humano60/min burst15, sesiones64/300s, peticiones64 por vida de proceso, TTL300s HTML o1800s intención agente. Retiene metadata/idempotencia hasta fin de proceso, no valores. Al llegar a capacidad falla cerrado hasta fin del piloto; no es disponibilidad indefinida.
- Servicio **no habilitado al boot**, Restart=no, RuntimeMaxSec=24h. Después no reiniciar ni ampliar plazo sin decisión humana. La ruta deja de servir formulario cuando el servicio termina.
- Nginx ruta aislada, body2k, buffering de request/respuesta deshabilitado, access log apagado/error sink para ruta; CSP sin terceros/scripts, no-store, no-referrer.
- Muerte abrupta durante dotenv puede dejar **sólo fixture**0600 en directorio0700; no hay garantía de borrado frente a SIGKILL/corte eléctrico ni limpieza automática de esos residuos. Último readback: directorio vacío. La retención residual requiere retirada selectiva por administrador al cerrar el piloto; jamás ejecutar un borrado genérico.
- Reiniciar pierde sesiones/requests; no reproduce ejecuciones. No sistema durable de credenciales.

## Pruebas y evidencia

EC2: `python3 -m unittest -v test_broker test_https_broker`:24 OK (22.294s). VPS Python3.12: suite nueva13 OK (14.676s), auth HTTP fixture independiente; **no es sesión humana real**. Incluye fallos write parcial/fsync/unlink, permisos, no overwrite, origen/CSRF, agente/owner incorrecto, replay/carreras, límites y plazo socket.

HTTPS real sin cookie, con cookie inválida, con Authorization fixture y POST no autenticado:401; TLS verify0. Root/health panel200; API me401. Nginx-t OK. Hash artifact local/remoto coincide. Egress positivo al backend y rechazo22loopback/443externo ejecutados con UID piloto. Servicios existentes preservados. Revisión Codex estática independiente consumida exit0; hallazgos de red/buffering/vida acotada corregidos y verificados operacionalmente, no atribuida ejecución a la revisión.

## Rollback selectivo

1. Retirar sólo `    include /etc/credential-link-pilot/location.conf;` del site `/etc/nginx/sites-enabled/infra-control.conf` (resolver symlink). Antes comprobar que quitando esa línea coincide con `/etc/credential-link-pilot/nginx-site.before`; si hay cambios ajenos preservar/merge manual, nunca restaurar todo ciegamente.
2. `nginx -t` y sólo entonces `systemctl reload nginx`; comprobar panel root/health200 y ruta piloto ya no servida por broker.
3. `systemctl stop credential-link-pilot.service credential-link-pilot-network.service`. La unit de red elimina exclusivamente su tabla. No tocar otros contenedores, nginx sites, cadenas nft o servicios.
4. Con procesos parados, inspeccionar sólo nombres/permisos del directorio piloto y retirar selectivamente sus fixtures si existen; no leer valores. Artefactos/root policy pueden conservarse privados para evidencia. No userdel/limpiezas globales.

Informe de despliegue y scripts operativos en scratch dev-hub `credential-https-*`, unidades y nginx `credential-link-pilot.*`. No commit/push/merge; `.orca/` y `pilots/` previos preservados.
