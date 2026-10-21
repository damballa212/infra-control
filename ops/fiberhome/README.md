# FiberHome SR1021D RP0102 — WOL desde VPS

Prueba física: Windows apagado por SSH con autorización, tres magic packets emitidos por el router desde el VPS y arranque autenticado en CachyOS con la MAC esperada. Segundo reinicio del router confirmó bootstrap BOOT automático, uptime nuevo y acceso privado sin relay Mac. No se modificó Arris ni se abrió SSH WAN.

`wol.c` fija una sola MAC/interfaz/destino; `--check` no envía paquetes. `wol-command.sh` restringe la llave operacional a check/wake. `start.sh` inicia Dropbear loopback y el supervisor `tunnel.sh`. Claves y binarios instalados viven fuera del repo; nunca incluirlos en handoff UI.

La telemetría usa una segunda llave SSH, separada de WOL, cuya entrada `authorized_keys` fuerza directamente `telemetry-command.sh` y desactiva PTY/forwarding. El comando solo lee `/proc/{stat,meminfo,uptime,sys/kernel/random/boot_id}`, escribe una muestra JSON cada15s en stdout y no escribe en flash ni llama CWMP. El colector está en el VPS; ningún proceso del panel dentro de Docker recibe una llave SSH.

El broker admite además `GET /router/status`, que ejecuta únicamente `check` por la llave WOL ya fijada y no llama al estado de la PC. La API lo comparte10s para las comprobaciones manuales. Un ACK negativo indica que el túnel no respondió; si el socket del broker falla, la API conserva el último probe y responde503. El broker del host ejecuta la versión compilada desde `current/dist/server/wol-broker.js`; al cambiar su código, se reinicia solo esa unidad systemd. Esto confirma el canal privado; no prueba ACS, WAN ni acceso a Internet y no modifica el router.

Instalación real verificada el2026-10-21: llave dedicada ECDSA, forced command activo y unidad `infra-control-router-telemetry.service` estable en el VPS. Dos muestras consecutivas llegaron a SQLite y confirmaron `reporting`, CPU y memoria; no se tocó WAN, Wi-Fi, ACS ni se reinició el router. La unidad usa Node con `--preserve-symlinks-main` porque `current` apunta a la release mediante symlink.

El binario probado usa MIPS32 o32 soft-float con el loader/libc uClibc del mismo router. Un binario estático glibc falló con illegal instruction. Toolchain `mips-linux-gnu-gcc`; startup `start-mips.S`, `-DROUTER_UCLIBC -msoft-float -march=mips32 -mabi=32 -fPIC -no-pie -G0 -nostdlib -nostartfiles -nodefaultlibs`, entrada `_start`, loader `/lib/ld-uClibc.so.0`, enlace con la libc exacta del firmware. No reemplazar librerías del dispositivo.

Provisions de GenieACS1.2.16:

- `infra-tunnel-bootstrap`: evento `1 BOOT` exclusivamente, precondition `DeviceID.ID = "CPE esperado"`; código exige además identidad exacta. Leer las hojas frescas antes de escribir, pues la caché sobrevive al reinicio del CPE.
- `infra-tunnel-cleanup`: presets separados para `8 DIAGNOSTICS COMPLETE` y `2 PERIODIC`, identidad exacta y `Tags.InfraTunnelCleanupPending = true`. Espera≥10s para evitar limpiar antes de ejecutar el comando. Restaura solo el diagnóstico propio, a partir de60s o finalización. Corta lecturas después de180s y marca Unconfirmed.
- No usar `_id` Mongo como parámetro del precondition: se evalúa contra el modelo de datos, no la colección.

El firmware permite ejecutar un comando fijo autenticado en IPPingDiagnostics.Host; el payload probado usa punto y coma, no sustitución `$()`. Es específico de este firmware y está limitado a arrancar el script persistente. No exponer una API de comandos arbitrarios.

Dropbear vendor falla con keepalive cliente: -K30 cerraba transportes sanos. -K0/-I0 más keepalive VPS15s×3 y watchdog300s limita transportes colgados. Cada5min hay una breve reconexión, incluida si el transporte estaba sano. Ambos listeners VPS son loopback; servidor restringe PermitListen a17722/17723.

GenieACS VM tiene50ms de límite de ejecución. Con CPU0.5 aparecieron timeouts; límite CWMP actualizado en vivo y compose a1CPU, sin reiniciar Internet. No cambiar todos los límites Docker ni reiniciar Coolify.

El broker TypeScript del host expone estado por socket Unix privado: `GET /status` incluye PC y túnel, mientras `GET /router/status` prueba únicamente el túnel; `POST /wake` envía WOL. Las órdenes controladas de PC y el cambio de arranque predeterminado usan los endpoints privados correspondientes. Las llaves quedan en `/etc/infra-control-wol`, fuera del contenedor. WOL backend conserva idempotencia, no repite escrituras ambiguas y verifica únicamente accesibilidad SSH. El banner no autentica identidad, OS ni salud de aplicaciones.
