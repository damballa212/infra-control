# Salud de Hermes

El reporter distingue el estado de la instancia EC2 de la unidad systemd real. Cada 15 s consulta solo `ActiveState` y `NRestarts` de **un nombre de unidad que el operador verificó**, y envía esos campos por HTTPS saliente al panel. No lee conversaciones, argumentos, configuración, secretos ni logs y no acepta órdenes. Un reporte vence a los45s. El estado de unidad se publica en `/api/hermes/health` y como `health.service` en el recurso EC2 configurado.

## Antes de instalar

La instancia `orchestrator` fue verificada por SSH en 2026-10-21. Hermes corre como unidad **de usuario** `ubuntu/hermes-gateway.service`, activa; `loginctl` confirma `Linger=yes`. El reporter consulta exactamente `systemctl --user show hermes-gateway.service` y corre como unidad de usuario separada dentro del mismo gestor de usuario. No instala/reinicia ni modifica Hermes. Comparte la identidad Unix `ubuntu` con Hermes; por eso su sandbox reduce superficie, pero no constituye aislamiento frente a un proceso comprometido con ese mismo usuario. El reporter solo consulta estado/contador de reinicios y no expone una interfaz de control. El token llega mediante credencial systemd.

El `resourceId` del panel debe ser el ID AWS exacto del recurso Hermes, en formato `aws:<cuenta-configurada>:<instance-id>`. El token es exclusivo, al menos32 caracteres, y se registra en el panel como SHA-256 (`hermes.reportTokenHash`). El mismo token va en la credencial systemd `report-token` del reporter. No reutilices llaves SSH, `INFRA_CONTROL_TOKEN` ni credenciales de la aplicación.

En la EC2, `systemd --user` falla al preparar `PrivateDevices=yes` y `ProtectKernelModules=yes` con `218/CAPABILITIES`; ambas opciones quedan fuera del unit. Las demás restricciones del archivo se probaron por separado con el gestor real del usuario. No declarar el reporter activo solo porque `systemd-analyze verify` acepte la unidad.

Reporter instalado el2026-10-21. La unidad observó `hermes-gateway.service` activa y `NRestarts=0` en un evento autenticado recibido por el panel; no se reinició ni modificó Hermes.

## Despliegue controlado

1. Genera el token en el host autorizado, sin imprimirlo ni guardarlo en el repo. Calcula su SHA-256 localmente para la configuración privada del panel. La configuración debe incluir `hermes.resourceId` y `hermes.reportTokenHash`.
2. Instala este archivo en `~/.config/systemd/user/infra-control-hermes-reporter.service`, el script `reporter.py` como `/opt/infra-control/hermes/reporter.py` root-owned/read-only y crea `~/.config/infra-control/hermes-report-token` con modo0600. `LoadCredential` entrega el token sin incluirlo en argumentos ni variables de entorno.
3. Comprueba la sintaxis con `systemd-analyze --user verify` (o el validador disponible) y verifica que el reporter lee únicamente `ActiveState` y `NRestarts` de `hermes-gateway.service` mediante `systemctl --user show`. La cuenta `ubuntu` ya tiene `Linger=yes`, por lo que el gestor de usuario permanece activo tras el arranque.
4. Activa únicamente `infra-control-hermes-reporter.service` con `systemctl --user enable --now`; no habilites linger ni cambies la unidad de Hermes. No ejecutes un segundo reporter en foreground con el token de producción.
5. Confirma un reporte autenticado, secuencia creciente y estado coincidente con `systemctl show`; compara además `GET /api/hermes/health` y `GET /api/resources` autenticados. Prueba el vencimiento y recuperación solo con pausa del reporter; no apagues la instancia para probarlo.

El panel suprime alertas de salud mientras hay una operación `start` o `stop` reciente para el `resourceId` configurado. `EC2 running` continúa sin equivaler a `Hermes healthy`. Aun con el reporter instalado, este endpoint comprueba el estado systemd observado por el VPS, no disponibilidad funcional de conversaciones ni dependencias externas.

Los test unitarios son offline: `python3 -m unittest discover -s ops/hermes -p 'test_*.py'`.
