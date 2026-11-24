# Piloto local de recepción de credenciales — SOLO fixtures

> **RETIRADO (2026-11-11).** Piloto de solo datos ficticios, sustituido por el sistema real `infra-secrets` (Infra Control `/secretos` + Vaultwarden; `docs/secretos-agentes.md`, #204). El servicio `credential-link-pilot` está desactivado y su pantalla salió del panel. No lo uses para credenciales reales ni como señal del estado del sistema actual.

**No es apto para producción ni para claves reales.** No es una bóveda instalada, no conecta con OpenAI y no expone un enlace accesible desde el teléfono. Es una implementación ejecutable de referencia para separar recibir una API key de iniciar sesión en un navegador.

## Reproducir

Desde este directorio, con Python 3 y `TMPDIR` apuntando al scratch privado del perfil activo:

```sh
python3 -m unittest -v test_broker
python3 -m py_compile broker.py test_broker.py browser_probe.py
```

Sin dependencias ni builds de la aplicación. Los tests crean un servidor real exclusivamente en `127.0.0.1` con puerto asignado por el SO, fixture aleatorio ficticio, sesiones HTTP y procesos hijos reales; los detienen al terminar. `browser_probe.py` abre un servidor aislado durante 60 segundos para verificar renderizado: no imprime tokens ni permite recibir claves reales; su metadata temporal privada se retira al acabar. No ejecutar instancias concurrentes de ese probe (metadata O_EXCL).

## Flujo implementado

1. Identidad de agente fija del piloto crea `POST /requests` con bearer propio, `Idempotency-Key`, destino `process` o `dotenv` y TTL1–300s. Proyecto único `fixture-app`, nombre `OPENAI_API_KEY`, sin parámetros para URL, comando, ruta o proyecto alternativo.
2. Devuelve enlace opaco `/r/<id>`, identificador, estado y vencimiento, nunca valor ni ruta de archivo. GET muestra proyecto, credencial y destino y no consume la solicitud.
3. Humano entra con token owner distinto del bearer del agente, sesión HttpOnly/SameSiteStrict, rotación tras login y CSRF; POST exige Origin y Host exactos. El enlace por sí solo no autoriza recepción. Es autenticación ficticia de laboratorio, **no passkey/MFA productivo**; ningún token se publica en chat.
4. El formulario admite únicamente `FAKE_ONLY_` seguido por32 hexadecimales; el test lo genera internamente. Permite enviar o denegar. TTL y replay son fail-closed, hay purga periódica de referencias en memoria, cupos de64 solicitudes/128 sesiones y8 workers, timeout de inactividad5s y plazo total8s por conexión/solicitud HTTP.
5. `POST /use/<id>` reclama una sola vez en transición atómica `ready → using`; ejecuta fuera del lock. `process` inyecta la fixture en `OPENAI_API_KEY` de un proceso Python fijo y aislado (`-I`), entorno mínimo y sin red de proveedor. Sólo devuelve estado. `dotenv` crea un archivo dotenv dentro del directorio privado preregistrado,0700/0600, mediante descriptor de directorio y O_EXCL/O_NOFOLLOW. No sobrescribe archivos, sigue symlinks ni escribe el `.env` del producto. Una falla de limpieza se comunica como `failed_cleanup_required`, nunca como eliminación garantizada.

## Evidencia y alcance

Ejecución final: **11 tests OK**. Cubre HTTP real, hijo real, archivo exacto/permisos, cookie/CSRF/Origin/Host, GET sin consumo, idempotencia/conflicto, denegación, vencimiento y purga idle, sesión vencida, cuotas, doble submit/use concurrente, rechazo de destino arbitrario y symlink, logs sin fixture y argv sin fixture; hijo lento sin lock global;8 clientes slowloris y cierre acotado; fallo de escritura y fallo de unlink explícito. Fallos de escritura/limpieza e hijo lento se inyectan para esas pruebas; el camino normal ejecuta el proceso y filesystem reales.

Se comprobó además renderizado del formulario owner en Chromium local y GET no consumidor; **no se introdujo una credencial mediante el navegador ni se probó iPhone/Safari/Edge reales**. Las pruebas de envío son clientes HTTP reales. La revisión Codex fue estática con fuente suministrada por stdin, vía suscripción ChatGPT; no ejecutó los tests. Hallazgos se corrigieron y se añadieron regresiones, sin tercera revisión grande. No se deshabilitó sandbox para sortear bwrap.

## Límites importantes

- HTTP de loopback únicamente. No HTTPS, túnel, DNS, autenticación owner real ni integración multiagente/multiproyecto. No soporte productivo de reinicios: solicitudes e idempotencia son de memoria y sólo del lifetime acotado del piloto.
- El broker usa proceso/hilos de laboratorio del **mismo UID**. Agentes con shell del mismo usuario pueden leer memoria/entorno/archivos o instrumentar Python.0700/0600 no protegen de ese agente/root. No afirmar aislamiento model-blind de producción.
- Quitar referencias Python no garantiza zeroization de memoria. TTL limita recepción/consumo, no duración del hijo ya autorizado ni borrado automático del dotenv consumido. El archivo privado persiste hasta que el dueño lo retira; los tests usan TemporaryDirectory y lo retiran al finalizar. Sin promesa de fsync/durabilidad o backups.
- Comprobación de ausencia de fixture acotada a respuestas HTTP, logs stdout/stderr del piloto y argv del hijo interceptado en test. No se inspeccionaron bases de sesiones globales, historial completo, memoria del navegador ni logs de otros servicios. No hay secreto real en estas pruebas.
- El plazo total cierra el socket; no puede interrumpir una syscall de filesystem bloqueada indefinidamente. No constituye resistencia DoS general ni revisión criptográfica.
- Las extensiones Bitwarden son comodidad humana de autofill; no reciben por sí mismas una nueva API key para agentes. `bw` Password Manager/Vaultwarden no es `bws` Secrets Manager.

## Autorización futura necesaria

Diseñar/revisar un servicio separado bajo UID/contenedor sin acceso del agente al storage, propietario autenticado por mecanismo existente aprobado (passkey/MFA), transporte HTTPS y destinos por identidad/proyecto asignados por servidor; acordar retención/revocación/backup. Pedir autorización específica antes de publicar endpoint/túnel/puerto, instalar componentes o tocar producción. Sólo entonces probar entrada desde iPhone real, inyección a ejecutor aprobado y `.env` privado cuando sea imprescindible. Nunca pedir que el usuario pegue claves o rutas sensibles en el chat.
