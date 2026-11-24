# Vaultwarden (secretos de agentes)

Estado: **en producción**: cuenta del dueño creada, organización «Agentes», cuenta de servicio del broker y backups verificados. Seguimiento: issue #204.

- Host: VPS `srv1292436`, directorio `/opt/vaultwarden` (`compose.yaml`, `.env` 0600, `data/` 0700 con UID 1100).
- Contenedor `vaultwarden-vaultwarden-1`: usuario no-root, FS de solo lectura, `cap_drop: ALL`, 256 MB, solo `127.0.0.1:8222`; el acceso externo es el sitio nginx HTTPS.

## Alta inicial (hecha; la contraseña maestra no pasa por ningún agente)
- URL: `https://vault.203.0.113.10.example.com` (nginx `sites-available/vaultwarden.conf`, certificado Let's Encrypt por webroot, renovación con el certbot del VPS). `/admin` devuelve 404 en nginx.
- Registros cerrados (`VAULTWARDEN_SIGNUPS=false`). El dueño fue invitado desde loopback con un token de administración efímero ya retirado (panel `/admin` desactivado: «The admin panel is disabled»).
- Por qué no un túnel `http://localhost`: el cliente web de Bitwarden rechaza URLs que no sean HTTPS («Insecure URL not allowed»).

Pasos del dueño: registrarse en la URL con el correo invitado y una contraseña maestra larga y única (guardada fuera de la bóveda); activar 2FA (TOTP) y guardar el código de recuperación fuera de la bóveda; crear la organización «Agentes» con colecciones `proyecto/entorno` (p. ej. `prod-erp/dev`) y una cuenta de servicio con acceso de solo lectura a las colecciones que los agentes pueden pedir.

Para invitar a otra cuenta: poner `VAULTWARDEN_ADMIN_TOKEN` temporal en `/opt/vaultwarden/.env`, `docker compose up -d`, login en `http://127.0.0.1:8222/admin` y `POST /admin/invite` desde el propio VPS, y retirar el token y recrear.

## Organización y cuenta de servicio
- Organización «Agentes» (`6e5e16f0-920d-4edd-8767-6fa9970785ec`). Dueña: la cuenta de servicio `infra-control-broker@vault.203.0.113.10.example.com`; Admin es Owner confirmado.
- La cuenta de servicio la creó un agente (decisión de Admin): su contraseña vive solo en el VPS (`/root/vault-broker/password`, 0600) y en `secretsVault` de la config del panel. No tiene acceso a la bóveda personal de Admin.
- Cada `proyecto/entorno` es una colección; el conector la crea al primer guardado. Los valores son notas seguras con el nombre de la variable; también se leen contraseñas de ítems tipo login creados a mano en esas colecciones.

## Operación
- Arrancar/parar: `cd /opt/vaultwarden && docker compose up -d | down`.
- Actualizar: cambiar la etiqueta de imagen en `compose.yaml`, `docker compose pull && docker compose up -d`.
- Quitar todo: `docker compose down` y retirar `/opt/vaultwarden` solo tras exportar y confirmar que no hay datos que conservar.

## Backups (verificados)
- VPS: `vaultwarden-backup.timer` (diario 03:30 UTC) ejecuta `/opt/vaultwarden/backup.sh`: instantánea nativa (`vaultwarden backup`) + `rsa_key.pem` + adjuntos/config, cifrado **solo con la clave pública** `vaultwarden-backup` (huella en `/opt/vaultwarden/backup.env`); el VPS no puede descifrar. Retiene 14.
- EC2: cron diario 04:15 UTC trae una copia a `~/backups/vaultwarden/` (la clave privada vive en el llavero gpg de la EC2; **guarda además una copia de esa clave privada fuera de las máquinas**, p. ej. `gpg --export-secret-keys` a un medio seguro: sin ella los backups no se pueden abrir).
- Restauración de prueba: `ops/vaultwarden/restore-test.sh <backup.gpg>` (contenedor desechable en 127.0.0.1:18222). Última ejecución: OK, 1 usuario, 0 organizaciones, 0 ítems.
- Repetir la restauración de prueba cuando ya haya ítems reales.

## No hacer
- No habilitar `/admin` de forma permanente; si hace falta, con token efímero y retirarlo después.
- No guardar la contraseña maestra ni la de la cuenta de servicio en el repo, en Coolify visible a agentes, ni en el panel.
- No dar a los agentes acceso directo a Vaultwarden.
- No guardar claves reales hasta tener backup cifrado y una restauración de prueba verificada.
