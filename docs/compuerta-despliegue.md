# Compuerta de despliegue (continuación de #132)

## Estado
- `ops/vps/deployment-gate.py enter|release|status`: rechaza si hay órdenes `accepted`/`running` y respalda SQLite. Probado (`ops/vps/test_deployment_gate.py`).
- Nuevo `ops/vps/deploy-api.sh`: un solo comando que cierra la compuerta, hace `up -d --no-deps api`, espera `/health/ready` y libera solo si el panel quedó listo; si algo falla, deja la compuerta cerrada (vence sola) y explica cómo liberar.

## Lo que sigue sin ser imposible de saltar
Coolify no ejecuta el guard: un redeploy desde su UI, un webhook o un reinicio del stack lo omite. Esto **no se resolvió** en este PR porque requiere tocar Coolify/VPS en producción.

## Opciones para cerrar el hueco (decisión de Admin, con el procedimiento de despliegue)
1. **Preferida**: pre-deployment command de Coolify que ejecute `deployment-gate.py enter` y falle si hay órdenes activas (hay que validar que Coolify lo permita para servicios Compose).
2. Deshabilitar el auto-deploy/webhooks de Coolify para este servicio y exigir `deploy-api.sh`, de modo que solo una persona pueda iniciar un relevo.
3. Defensa en el arranque: el contenedor nuevo ya marca `uncertain` lo interrumpido (nunca reproduce órdenes); no impide la interrupción, solo evita el daño mayor.
