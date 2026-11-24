# Bootstrap de monitorización productiva

El driver se monta en `/app/bootstrap-production-monitoring.mjs`, junto a `/app/dist`; sus imports `./dist/server/*` se resuelven desde esa ubicación. El plan público se monta explícitamente en `/app/activation-plan.json`. Ejecutarlo desde su ruta versionada `ops/vps` no utiliza esa disposición.

Precondiciones: API detenida, lease de despliegue vigente perteneciente a `DEPLOYMENT_GATE_OWNER`, cero operaciones accepted/running y posesión exclusiva de `/data/instance.lock`. El driver conserva las comprobaciones nativas SQLite y del entorno; el helper no sustituye esas guardas.

Con `$newImage`, `$release`, `$activeConfig` y `$leaseUuid` establecidos por el procedimiento de despliegue, la disposición prevista es:

```sh
docker run --rm \
  --entrypoint flock \
  --cap-drop ALL --read-only --pids-limit 64 --memory 256m --cpus 0.5 \
  --env INFRA_BOOTSTRAP_SINGLETON=1 --env DATA_DIR=/data \
  --env DEPLOYMENT_GATE_OWNER="$leaseUuid" \
  --mount "type=bind,src=$release/ops/vps/bootstrap-production-monitoring.mjs,dst=/app/bootstrap-production-monitoring.mjs,readonly" \
  --mount "type=bind,src=$release/research/2026-11-14-cloud-activation-plan.json,dst=/app/activation-plan.json,readonly" \
  --mount "type=bind,src=/opt/infra-control/data,dst=/data" \
  --mount "type=bind,src=$activeConfig,dst=/run/secrets/config.json,readonly" \
  "$newImage" --exclusive --nonblock --no-fork /data/instance.lock \
  node /app/bootstrap-production-monitoring.mjs /app/activation-plan.json
```

El helper tipado comprueba primero la configuración efectiva completa. Conserva las definiciones ajenas presentes en esa configuración. No activa sondas ausentes ni acepta otros parámetros, hosts, proyectos o relaciones físicas.

La evidencia productiva exige generaciones avanzadas de identity, regions y cada scope EC2 necesario, timestamps dentro del barrido y tres observaciones activas que hayan avanzado. El barrido puede durar como máximo veinte minutos. Una fila antigua o un resultado `resources` por sí solos no acreditan una lectura actual. Fallos de otras cuentas se informan, pero no invalidan producción cuando sus evidencias requeridas están completas.

Los servicios y las expectativas se escriben en una transacción. Antes de la primera expectativa se validan todas las relaciones persistidas por UUID, tipo y evidencia. Un fallo revierte el lote; los snapshots válidos adquiridos por discovery permanecen como evidencia del proveedor. Un host observado stopped puede recibir always-on: esto no simula running ni ejecuta energía.

`eligibleProbes` acredita configuración y elegibilidad, no un GET HTTPS exitoso. Este proceso no consulta Cost Explorer, no cambia IAM y no ejecuta órdenes de energía. La configuración privada permanece montada read-only y no se imprime.

La validación del padre incluye el typecheck del proyecto, las pruebas del helper con discovery real e IO dobles y `node --check ops/vps/bootstrap-production-monitoring.mjs` usando Node 24. Esta documentación no acredita ejecución del bootstrap ni despliegue.
