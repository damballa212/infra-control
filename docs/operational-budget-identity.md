# Identidad de incidentes de presupuesto

`OperationalIncident` incorpora campos opcionales `accountId`, `account`, `budgetName` y `sourceContext`. `connectionId` conserva su significado de identidad de conexión. Estos tipos siguen siendo declaraciones sin valores de runtime.

`accountId` se copia del evento de presupuesto; nunca se calcula a partir de `account`, nombres, fechas o claves de agregación. `account` y `budgetName` conservan el texto observado. La autorización sigue comprobando la identidad física, la conexión vigente y readPolicy.

`sourceContext.eventIds` identifica los eventos exactos que aportaron la metadata. En nuevas proyecciones contiene el evento original; una hidratación heredada puede usar los eventos retenidos señalados por `openingEventId` y `lastEventId`. Se conserva durablemente en la proyección y su versión, sin crear transiciones ni reemitir eventos. No se sustituye un evento eliminado por el siguiente evento del log.

`sourceContext.resourceId` y `catalogId` son referencias explícitas procedentes del evento, separadas del `resourceId` operativo del incidente. Continúan aplicando los controles de suspensión, incluso cuando todavía no existe una fila de recurso. `sourceContext.scopeKey` conserva metadata de origen y no transforma un presupuesto en un incidente de cobertura ni concede permisos de scope.

`sourceContext.conflict: true` impide publicar un incidente cuya identidad o procedencia retenida sea contradictoria. La ausencia de lineage no se rellena mediante nombres o timestamps. Las filas originales y los eventos retenidos no se eliminan.

Los umbrales presupuestarios mantienen `status: information`: aparecen en eventos e historia; la vista `current` continúa limitada a incidentes abiertos o desconocidos.

REST y MCP consumen la misma proyección enriquecida y el mismo clasificador de referencias. No se incorporan rutas ni consultas a proveedores.
