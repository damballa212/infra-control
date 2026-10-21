# Integración HTTP

La selección del proveedor está en `ui/src/app/providers.ts`. Dev usa fixtures salvo `VITE_DATA_MODE=http`. Producción usa HTTP salvo build explícito `VITE_DATA_MODE=fixture`; una query nunca cambia el modo. La UI no importa implementaciones del backend.

| Método DataProvider | Endpoint | Comportamiento |
|---|---|---|
| getSession | GET /api/auth/me |401 desmonta el árbol privado |
| login | POST /api/auth/login |Cookie HttpOnly, sin token en JS;429 conserva espera |
| logout | POST /api/auth/logout |200 o401 eliminan la sesión local; otros errores permiten explicar falta de confirmación |
| changePassword | POST /api/auth/password |current/password;16–256;401 verifica sesión para distinguir contraseña actual incorrecta |
| getResources | GET /api/resources |60s visible/online; observedAt no se reemplaza por fetchedAt |
| getOperations | GET /api/operations |Inicial y al entrar/volver;5s únicamente con pendientes |
| getOperation | GET /api/operations/:id |5s con pendiente; nunca reproduce la orden |
| createOperation | POST /api/operations |Idempotency-Key;202 conserva estado del objeto; sin retries automáticos |
| getCosts | GET /api/costs |Bajo demanda; timeout120s; no fuerza CE; caché del servidor24h |

Todos usan same-origin, cache no-store, redirect error y Accept JSON. Escrituras añaden Content-Type; Origin lo controla el navegador. Las respuestas privadas nunca entran al Service Worker.

Una recuperación ambigua usa la misma intención y clave. Un cambio deliberado nuevo requiere una nueva confirmación y otra clave. Controles dependen de actions y se bloquean offline, durante comprobaciones, órdenes activas o envíos pendientes. El backend sigue siendo autoridad final de permisos y exclusión concurrente.

`npm run contract` comprueba equivalencia type-only con `contracts/api.ts`. Cambios backend futuros deben reconciliarse antes de activar capacidades nuevas. Pruebas HTTP de Playwright usan rutas simuladas en localhost; no constituyen integración verificada con producción.
