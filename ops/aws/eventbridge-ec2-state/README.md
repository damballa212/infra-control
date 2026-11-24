# Eventos de estado EC2 hacia Infra Control

Este artefacto entrega cambios de estado EC2 mediante EventBridge API Destination. El endpoint del panel guarda primero el evento en SQLite y responde `202`; un worker local actualiza el catálogo, deduplica reintentos y compara el timestamp con el último estado conocido. El navegador y los agentes no participan en la entrega.

El template solo envía eventos de estado. No concede permisos para iniciar, detener, terminar ni modificar instancias. Las acciones siguen dependiendo del allowlist de control existente en el panel.

## Preparación por cuenta y región

1. Genera un token aleatorio independiente para cada cuenta AWS que enviará eventos. No reutilices el token entre cuentas.
2. En **cada cuenta fuente**, guarda el token como un secreto de AWS Secrets Manager con formato JSON y propiedad `token`. No lo incluyas en el template, historial de shell, parámetros visibles ni `config.json`.
3. Calcula su SHA-256 en un equipo controlado e incorpora solo el hash al secreto de configuración del panel:

   ```json
   {
     "awsEventTokenHashes": {
       "123456789012": "<sha256-del-token-de-esa-cuenta>"
     }
   }
   ```

   El account ID es la clave. Cada cuenta debe tener su propio token y hash. El panel nunca devuelve el hash por API.

4. Espera a que el catálogo registre como `healthy` el scope `aws:ec2:<region>` de esa cuenta. Si todavía no existe, el endpoint responde `503` y EventBridge reintentará.
5. Despliega `template.yaml` en **cada cuenta y región habilitada** que deba reportar. Usa un stack separado por cuenta/región:

   ```sh
   aws cloudformation deploy \
     --template-file ops/aws/eventbridge-ec2-state/template.yaml \
     --stack-name infra-control-ec2-state \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       PanelEventsEndpoint=https://TU-DOMINIO/api/aws/events \
       EventTokenSecretArn=arn:aws:secretsmanager:REGION:ACCOUNT:secret:infra-control-events
   ```

   Selecciona explícitamente el perfil y la región del stack con `--profile` y `--region`. El `SecretString` debe ser JSON y tener una clave `token`.

El template crea una conexión EventBridge API Key, un destino HTTPS, una regla de EC2, un rol que solo puede invocar ese destino y una SQS DLQ cifrada con retención de 14 días. La conexión también hace que EventBridge cree su secreto de servicio administrado.

## Comprobación

- Confirma que la conexión quede `AUTHORIZED`, el destino `ACTIVE` y la regla `ENABLED`.
- En el panel, revisa `GET /api/system/health` → `cloudEvents`: `pending`, `processed`, `ignored`, última recepción y último procesamiento.
- En CloudWatch, revisa invocaciones exitosas/fallidas de la regla y la cantidad visible en la DLQ.
- `202` significa que el inbox durable aceptó el evento; no significa que EventBridge haya consultado o corregido nada.
- Un evento duplicado recibe `202` sin volver a cambiar estado. Un evento antiguo se acepta en el inbox y se marca `ignored`; nunca reemplaza una observación más nueva.
- Corrige primero la causa antes de redirigir manualmente mensajes desde DLQ. El ID de EventBridge conserva la deduplicación.

## Límites operativos

- EventBridge debe poder alcanzar el endpoint público HTTPS con certificado confiable. El handler responde dentro de 5 segundos y no espera una consulta AWS.
- El endpoint acepta un header dedicado `x-infra-control-token`; ese token solo acredita la cuenta indicada por el evento. No es un bearer de usuario ni un token de agente.
- Cuenta desconectada o token incorrecto se rechaza. Una región sin cobertura verificada responde `503` para permitir reintentos; la cola DLQ retiene eventos que agoten los reintentos.
- Los errores del proveedor se registran con códigos seguros, nunca con el cuerpo de error ni credenciales.
- No se ha creado ningún secreto, conexión, regla, destino, rol ni cola en AWS con este artefacto. Requiere configurar los hashes del panel y desplegar cada stack desde la cuenta/región fuente autorizada.
