# Observación nativa del VPS

El productor es root y local. La API continúa como Node UID/GID1000, filesystem read-only, sin docker.sock, claves SSH ni puertos adicionales. El productor solo ejecuta ps e inspect contra unix:///var/run/docker.sock. No ejecuta procesos dentro de contenedores ni cambia Docker.

## Validación del código

Desde el checkout y con los recursos de desarrollo admitidos:

```sh
npm run build
npm test -- tests/host-observation.test.ts tests/host-schema.test.ts tests/host-app.test.ts tests/host-monitor.test.ts
python3 -I -m unittest discover -s ops/host-observation -p 'test_*.py'
```

El contrato Go ejecuta la plantilla exacta extraída de collector.py con missingkey=error y Health ausente/nil/healthy/unhealthy. Ejecutarlo donde Go ya esté disponible; no instalar Go en el VPS por este test:

```sh
cd ops/host-observation
go test health_template_test.go
```

Conservar el arreglo validado en Docker29.1.5: acceso a Health y Status mediante index. No volver a .State.Health, ni siquiera en el guard.

También ejecutar los tests existentes de AWS, autorización, SSE, MCP, operaciones, contrato y UI. Regenerar contracts/openapi.json con npm run contract después de aplicar y verificar el código; no editar a mano el generado.

## Instalar el productor después de la revisión secuencial

Estos comandos se ejecutan en el VPS autorizado, como root, desde la copia verificada de estos archivos. No instalan dependencias Python ni reinician Docker/Coolify.

```sh
install -d -o root -g root -m 0755 /usr/local/lib/infra-control-host-observer
install -o root -g root -m 0644 ops/host-observation/collector.py /usr/local/lib/infra-control-host-observer/collector.py
install -o root -g root -m 0644 ops/host-observation/infra-control-host-observer.service /etc/systemd/system/infra-control-host-observer.service
install -o root -g root -m 0644 ops/host-observation/infra-control-host-observer.timer /etc/systemd/system/infra-control-host-observer.timer
install -d -o root -g root -m 0750 /var/lib/infra-control-host-observer
install -d -o root -g root -m 0700 /var/lib/infra-control-host-observer/private
install -d -o root -g 1000 -m 0750 /var/lib/infra-control-host-observer/published
systemd-analyze verify /etc/systemd/system/infra-control-host-observer.service /etc/systemd/system/infra-control-host-observer.timer
systemctl daemon-reload
# Solo en un enrollment nuevo confirmado, con el timer aún inactivo.
/usr/bin/python3 -I /usr/local/lib/infra-control-host-observer/collector.py --initialize
systemctl start infra-control-host-observer.service
systemctl enable --now infra-control-host-observer.timer
```

Antes de sobrescribir destinos existentes, comprobar localmente que los directorios y archivos no sean symlinks y pertenezcan a root sin escritura de grupo/world. La configuración privada y los respaldos permanecen en el VPS; no imprimirlos ni transferirlos al chat.

Resultado requerido: published/ root:1000 modo0750; snapshot.json regular root:1000 modo0640; private/ root:root0700; checkpoint.json root:root0600. Verificar permisos numéricos, no nombres de grupo. Respaldar el checkpoint privado y el marcador initialized.json junto con la generación de SQLite que se conserva. El productor persiste el checkpoint antes de publicar. Los saltos de secuencia son válidos. Un checkpoint perdido detiene la publicación incluso si tampoco existe snapshot. Para recuperar un enrollment existente, restaurar un checkpoint verificado cuya secuencia sea como mínimo la mayor entre la última publicada y la última aceptada por SQLite. Conservar los registros de boot y el binding. Si falta evidencia para fijar ese mínimo, mantener detenida la publicación.

El timer programa60s; MemoryMax128M, TasksMax64, CPUQuota25%, TimeoutStartSec25s. No modificar unidades de otras aplicaciones.

## Configuración privada y mount

Agregar al config privado existente un host con key vps-vps-provider, displayName VPS vps-provider, enabled true, snapshotDirectory /run/infra-control-host-observations y monitoring.enabled true. expectedFingerprint debe ser el pin aprobado, comprobado localmente contra el fingerprint del archivo producido. No colocar el pin, machine-id ni rutas privadas del config en contratos públicos, logs o frontend.

Conservar sin cambios aws, services, serviceProbes, credenciales, políticas y bootstrap de los tres recursos Mue. La nueva configuración no asigna always-on a ningún contenedor.

El único mount nuevo aprobado para el servicio API es este bind de directorio:

```yaml
- type: bind
  source: /var/lib/infra-control-host-observer/published
  target: /run/infra-control-host-observations
  read_only: true
  bind:
    create_host_path: false
```

No montar el archivo individual: la publicación usa rename atómico. No montar BASE ni private/. No añadir docker.sock, capabilities, privileged, SSH keys o puertos. El destino debe coincidir exactamente con hosts[].snapshotDirectory y ser accesible por UID/GID1000 dentro del contenedor.

## Relevo de la API

El compose vigente está en /data/coolify/services/service-id/docker-compose.yml. La imagen anterior es infra-control:panel-0.13.0-1425056. Usar el procedimiento existente de ops/vps/README.md para admisión, bloqueo singleton y backup SQLite mediante su API; no copiar el archivo SQLite vivo con cp.

Preparar la nueva imagen y una comparación semántica local de compose/raw/generated antes del relevo. La lista de diferencias admitidas se limita a la imagen del servicio API y al bind de directorio anterior. Mantener pull_policy, /data persistente, flock, redes, límites, UID/GID1000, readonly y todos los demás servicios. No ejecutar un down del proyecto ni reiniciar Coolify/Docker.

Aplicar la modificación persistente en Coolify y comprobar que su compose generado conserve las mismas diferencias admitidas. Una edición únicamente del generado que se pierda al siguiente deploy no acredita instalación terminada.

Con la compuerta activa y backup validado, relevar solamente la API siguiendo el runbook existente. Verificar readiness, restauración de FKs/migraciones, recursos Mue/probes, historial, singleton y los demás contenedores antes de liberar la compuerta.

## Enrollment y obligaciones

El enrollment crea un accountId UUID privado estable en SQLite. El publicId del host es host:<UUID>:machine. Obtenerlo de la sesión personal autorizada después del primer snapshot; nunca construirlo con machine-id ni fingerprint.

Si se configura obligación always-on, efectuar PUT /api/resources/<id-del-host>/expectation con sesión humana, Origin exacto y expectedVersion vigente. Aplicarla exclusivamente al host seleccionado. No copiar políticas Mue ni activar todos los contenedores. Los jobs detenidos sin obligación mantienen modo observe y no generan avisos de disponibilidad.

CPU/memoria: abrir con90% o más durante tres observaciones distintas; limpiar con85% o menos durante tres. Root filesystem: dos muestras en ambos sentidos. Las bandas intermedias reinician candidatos. Estado, candidatos, bootId y último timestamp se conservan en SQLite. Un archivo repetido no aporta una muestra. Un hueco/reinicio de host vuelve el ciclo desconocido y una línea base posterior no se publica como recuperación.

Docker health solo afirma healthy/unhealthy cuando Docker aporta Health.Status explícito y la observación está vigente. Running, ausencia de Health y un job detenido no prueban salud de aplicación.

## Comprobación sostenida y rollback

Observar al menos cuatro publicaciones consecutivas y más de180s desde la primera. Registrar solo secuencias, edades, estados y resultados redactados. Verificar CPU inicialmente desconocida y después calculada, memoria real, rootfs real, Docker completo con segunda enumeración estable y métricas con sus timestamps originales. No asumir29 contenedores como constante.

Comparar HTTP, snapshot SSE inicial/replay y MCP: lector del host ve únicamente el host, sus métricas y scopes presencia/métricas; no ve hijos ni conteos Docker. Un grant de account/connection sí puede incluir sus recursos. Probar disabled/removed y revalidación tras IO con fixtures, sin detener aplicaciones productivas.

Verificar cadencia del productor y del coordinador sin nuevas consultas AWS/CE. La validación sostenida no implica haber mostrado una notificación en un teléfono.

El productor publica snapshot.v2.json con los tiempos por lote y después snapshot.json en v1 estricto, ambos con la misma secuencia. El lector nuevo acepta el complemento cuando coincide con el v1 publicado. El lector v1 usa snapshot.json con el mismo mount de directorio. Durante un rollback del productor, detener su timer y esperar a que termine su ejecución antes de sustituir el binario. El productor anterior usa el mismo checkpoint y el lector nuevo acepta sus publicaciones v1. En un rollback de la API, usar imagen/config/compose previos y el procedimiento de backup/gate existente. La imagen previa a la función de host seguirá mostrando sus proveedores previos; la continuidad de observaciones se comprueba con un lector que ya soporte v1. Conservar el checkpoint, SQLite y el historial; no borrar bindings para forzar aceptación de otra máquina. Liberar la compuerta solo al completar las verificaciones del runbook.
