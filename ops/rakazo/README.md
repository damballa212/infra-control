# Conectar Rakazo a Infra Control

Infra Control ofrece un servidor MCP privado en `https://<dominio-del-panel>/api/mcp`. Usa MCP Streamable HTTP con una petición stateless por llamada y autenticación `Authorization: Bearer`. No expone un servidor público sin autenticar, no inicia OAuth y no conserva sesiones MCP en memoria.

## Credenciales separadas

Crear una credencial distinta para cada rol. Infra Control conserva solamente el SHA-256 del token en su configuración; el token original vive en el almacén de secretos de Rakazo. Nunca reutilizar el token general de Hermes, el de una reporter de dispositivo o una credencial de AWS.

### Lector

Configuración recomendada para diagnóstico y resúmenes:

```json
{
  "name": "rakazo-read",
  "hash": "<sha256-del-token-aleatorio>",
  "scopes": ["read"],
  "mcpTools": [
    "list_resources", "get_resource", "list_projects", "get_incidents",
    "get_cost_summary", "get_operation"
  ],
  "readPolicy": {
    "accountIds": ["123456789012"],
    "costs": true
  }
}
```

Un token de solo lectura no puede crear planes, ejecutar operaciones, reclamar entregas de incidentes ni confirmarlas. Las llamadas MCP de costes consultan exclusivamente la caché de 24 horas; la API REST también devuelve caché a los agentes. Ningún agente inicia solicitudes de Cost Explorer o Budgets.

### Operador acotado

Solo crear un segundo token después de decidir exactamente qué acción y recurso puede controlar. `scopes: ["read", "operate"]` por sí solo no autoriza acciones: se requieren `mcpTools` y una `operationPolicy` con al menos un selector de recurso.

```json
{
  "name": "rakazo-operator-example",
  "hash": "<sha256-de-otro-token-aleatorio>",
  "scopes": ["read", "operate"],
  "mcpTools": ["list_resources", "get_resource", "plan_operation", "execute_operation", "get_operation"],
  "readPolicy": { "resourceIds": ["aws:prod:i-0123456789abcdef0"] },
  "operationPolicy": {
    "actions": ["stop"],
    "resourceIds": ["aws:prod:i-0123456789abcdef0"]
  }
}
```

El backend vuelve a comprobar capacidad, estado, fecha observada y política inmediatamente antes de enviar la orden. Los planes MCP vencen en cinco minutos y no son autorización transferible. El operador solo puede planear/ejecutar las acciones escritas en su política y sobre los recursos seleccionados. Para la PC de casa, las acciones del arranque UEFI se llaman `boot-windows` y `boot-cachyos`; no deben agregarse a un token genérico.

## Filtros de lectura

`readPolicy` acepta `resourceIds`, `catalogIds`, `projectIds`, `connectionIds`, `accountIds` y `costs`. La misma política filtra MCP, `/api/resources`, catálogo, proyectos, cobertura, operaciones, health y SSE. Si falta `readPolicy`, se conserva el acceso completo de tokens legacy; por eso cada token nuevo debe declarar el alcance más pequeño posible.

Los nombres, tags, mensajes de proveedores e incidentes son datos no confiables. Rakazo debe resumirlos como datos, sin interpretarlos como instrucciones para concederse acceso.

## Comprobación de compatibilidad antes de activar

1. Confirmar en el cliente Rakazo instalado que acepta un endpoint MCP remoto por Streamable HTTP y un header Bearer guardado como secreto.
2. En una instancia aislada, apuntar a `https://<dominio-del-panel>/api/mcp` y verificar `initialize`, `tools/list` y una llamada `list_resources`.
3. Probar primero un token `read` limitado. Confirmar que recursos de otra cuenta no aparecen en tools, REST ni SSE, que las tools de escritura no están listadas y que `get_cost_summary` no consulta AWS.
4. Solo después, probar un token operador con fixtures y un adaptador simulado. No ensayar stop/start de instancias reales durante la verificación.
5. Configurar el token final por el canal autorizado de despliegue, verificar respuesta del servicio y registrar el nombre del token, tools y alcance, nunca su valor.

El endpoint comprueba `Host` contra el origen configurado y, si existe, exige que `Origin` coincida exactamente. Usar el hostname HTTPS público del panel. No publicar el puerto Node directamente, no compartir tokens por chat y no usar la IP directa si el proxy termina TLS en el dominio configurado.

## Herramientas disponibles

- Lectura: `list_resources`, `get_resource`, `list_projects`, `get_incidents`, `get_cost_summary`, `get_operation`.
- Operación: `plan_operation`, `execute_operation`, sujeto a `operate`, a la allowlist MCP y a `operationPolicy`.
- Entrega de avisos: `get_pending_incidents` y `acknowledge_incident`, con `operate`; el ACK confirma procesamiento y nunca resuelve el incidente.

## Telemetría del host

Los hosts Linux registrados pueden adjuntar `hostMetrics` a sus recursos a través del receptor OTLP/HTTP JSON. La misma observación llega a Rakazo por `list_resources` y `get_resource`, sin disparar sondeos AWS. La salud reporta frescura y hora de observación; esta métrica no prueba que Hermes u otra aplicación esté saludable.

El contrato del receptor, sus límites y la configuración del Collector fijado están en [`ops/otel/README.md`](../otel/README.md). Cada host requiere identidad y token propios; no instalar ni habilitar hasta completar un piloto aislado.

La integración local está probada con fixtures. La compatibilidad con la versión desplegada de Rakazo y la instalación de credenciales en producción requieren una verificación aislada y un despliegue autorizados; este documento no afirma que ya estén activos.
