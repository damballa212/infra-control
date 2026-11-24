# Reporter del MacBook

El LaunchAgent nativo de macOS anuncia presencia por HTTPS saliente. Envía `online` al iniciar, `heartbeat` cada 15 segundos mientras la sesión está activa y avisos best-effort `sleep`/`wake` desde las notificaciones de `NSWorkspace`. La muestra vence a los 45 segundos (tres latidos perdidos). El aviso `sleep` solo significa que macOS notificó que iba a suspenderse; el panel no afirma que el reposo se haya completado. La ausencia de señal puede deberse a reposo, tapa cerrada, apagado o falta de red.

El agente no despierta el Mac, no lee SSID ni ubicación, no acepta órdenes y no actúa como relay hacia la red de casa. Los datos enviados se limitan a `bootId`, secuencia monotónica y tipo de evento. La API descarta boot IDs retirados y secuencias antiguas.

## Preparación e instalación

1. Genera un token exclusivo del reporter (mínimo 32 caracteres, base64url). No reutilices la sesión del panel, el token de Hermes, una llave SSH ni el token de otro agente. El valor en claro solo va en `~/.config/infra-control/mac-report-token` del Mac:

   ```sh
   install -d -m 700 "$HOME/.config/infra-control"
   umask 077
   openssl rand -hex 32 > "$HOME/.config/infra-control/mac-report-token"
   chmod 600 "$HOME/.config/infra-control/mac-report-token"
   ```

2. Calcula el hash del token sin mostrarlo y configura ese valor como `macTelemetryTokenHash` en la configuración privada del backend:

   ```sh
   python3 -c 'import hashlib,pathlib; p=pathlib.Path.home()/".config/infra-control/mac-report-token"; print(hashlib.sha256(p.read_text().strip().encode()).hexdigest())' > "$HOME/.config/infra-control/mac-report-token.sha256"
   chmod 600 "$HOME/.config/infra-control/mac-report-token.sha256"
   ```

   Transfiere solo el hash por el canal privado de configuración. No lo añadas al repositorio, issues, chat o logs. No regeneres el token después de fijar su hash.

3. En el checkout autorizado, ejecuta `ops/mac/install-launch-agent.sh` como el usuario que debe reportar. Requiere `swiftc`, `python3` y `plutil`. El instalador compila y ejecuta el self-test, valida la configuración del token y el plist, y solo entonces cambia el LaunchAgent. Si la carga falla, intenta restaurar el plist anterior. El agente corre en la sesión de usuario y conserva la identidad de servicio `com.infra-control.mac-reporter`.

4. Verifica la carga con `launchctl print "gui/$(id -u)/com.infra-control.mac-reporter"` y confirma una muestra reciente en `GET /api/mac/health` (edad menor a 45 segundos). No declares el reporter activo por el solo hecho de que `launchctl bootstrap` haya terminado.

## Pruebas locales

```sh
python3 -m unittest discover -s ops/mac -p 'test_*.py'
```

La prueba Swift compila el binario y ejecuta validaciones offline de identidad de arranque, secuencia monotónica, forma del evento y permisos del token. No realiza llamadas de red ni expone secretos.

## Retirada

```sh
launchctl bootout "gui/$(id -u)/com.infra-control.mac-reporter"
rm -f "$HOME/Library/LaunchAgents/com.infra-control.mac-reporter.plist"
rm -f "$HOME/.local/share/infra-control/reporter.py" "$HOME/.local/share/infra-control"/mac-reporter-*
rm -f "$HOME/.config/infra-control/mac-report-token"
```

La eliminación de un archivo en SSD no certifica borrado físico. Revoca también el hash en la configuración del panel y despliega esa configuración antes de considerar invalidado el token.
