# Infra Control — instrucciones de mantenimiento

## Alcance vigente
- Backend TypeScript y UI D · Pixel atardecer; la PC implementada usa energía contextual y modal de SO. El estado de propuestas de UX vive en design/handoff/UX.md.
- Claude Design entregó UI React/TypeScript en design/handoff/HANDOFF.md. Preservar componentes, tokens y assets; cambios visuales requieren validación de Admin.
- La UI de producción se construye desde design/handoff con su TSX/assets/tokens aprobados.
- No reconstruir ni reinterpretar la UI desde capturas.
- .local/paused-frontend es trabajo descartado, no referencia aprobada.
- design/CLAUDE_DESIGN_PROMPT.md y design/API_CONTRACT.md fijan el handoff.

## Comandos comprobados
- Node24+; runtime Docker Node24.
- npm ci
- npm run build
- npm test
- npm run test:coverage
- npm audit
- npm run contract
- UI, desde design/handoff: npm run typecheck, npm test, npm run build y npm run test:e2e.
- Lint: `npm run lint` (Oxlint; ESLint+typescript-eslint no soporta TypeScript 7). Prettier: `npm run format:check` aún no es obligatorio (130 archivos sin formatear; el reformateo masivo va en un PR aparte).
- CI en `.github/workflows/ci.yml`, solo en pull_request: backend (build, lint, test, audit, OpenAPI), UI (typecheck, test, build, contract); E2E aparte en `.github/workflows/e2e.yml` (label `e2e` o manual).
- Versión única en package.json; CHANGELOG.md; tag `panel-x.y.z` por relevo tras comprobar la imagen servida en el VPS. compose.yaml es ejemplo no desplegable. Relevo: `ops/vps/deploy-api.sh`.
- Tests usan proveedores simulados. No probar apagados productivos sin autorización expresa de Admin.
- Distinguir implementado, probado con fixtures, validado live y desplegado; un build local no acredita integración productiva.

## Contratos
- contracts/api.ts es una superficie type-only; no exportar valores privados.
- contracts/openapi.json se genera con npm run contract.
- Toda operación devuelve202: no equivale a éxito ni a estado específico.
- Terminales: succeeded, failed, uncertain. No inventar porcentajes.
- Resource.actions es la autoridad para habilitar controles.
- observedAt indica observación del proveedor o recepción del último aviso PC; fetchedAt no renueva datos cacheados ni versiona estados derivados.
- stateChangedAt cambia con una transición observada y permanece null si se desconoce; no sustituirlo por observedAt.
- REST, MCP y SSE aplican el mismo readPolicy, incluyendo payloads y conteos; permitir un proyecto no autoriza todas sus relaciones físicas.
- Cambios de API requieren actualizar contrato y briefing de diseño.

## Persistencia y concurrencia
- SQLite en DATA_DIR/infra.sqlite; volumen persistente obligatorio.
- Una réplica/proceso. No cluster ni réplicas con cachés/cupos independientes.
- ENTRYPOINT flock sobre /data/instance.lock excluye contenedores simultáneos.
- No quitar flock: la reserva diariaCE y recuperación de órdenes dependen del singleton.
- Índice parcial único limita una orden activa por recurso.
- Reinicio marca órdenes interrumpidas uncertain; nunca las reproduce.
- Idempotency-Key se conserva por intención, actor y payload.
- Revalidar autorización también al recuperar operaciones idempotentes; REST/MCP comparten OperationService.
- Las transiciones esperadas son durables y se consumen/expiran; no ocultar caídas nuevas con una ventana temporal antigua.
- MCP conserva entregas/leases independientemente de la retención del event log; ACK no resuelve el incidente.
- Push conserva estado de señal/ciclo entre reinicios; historia con huecos queda desconocida, sin inventar recuperación.

## Catálogo e identidad
- Catálogo SQLite compartido de conexiones, scopes y snapshots; las visitas no disparan discovery por cliente.
- Identidad física: proveedor, cuenta efectiva, región, tipo e ID. Conservar aliases legacy e historia de operaciones.
- Discovery valida STS, regiones y paginación. Fallos, 403 o snapshots parciales no acreditan ausencia ni retiran recursos.
- Si falla enumerar regiones, continuar solo con regiones legacy/previamente observadas y mantener aws:regions degradado. Una identidad STS incorrecta siempre aborta el barrido.
- Discovery y permiso de control son independientes; importar una conexión no amplía el allowlist legacy a toda la cuenta.
- services del config privado mantiene identidad lógica estable por key, proyecto/entorno y relaciones explícitas con evidencia.
- Aliases aún no descubiertos quedan sin resolver; no unir servicios por nombres parecidos.
- Omitir services al arrancar desactiva las definiciones previas, conservando historia.

## Proveedores
- AWS: conexiones configuradas y descubrimiento paginado; las instancias del config conservan aliases y allowlist legacy de control.
- Usuarios IAM dedicados; no copiar perfiles administrativos del Mac.
- No terminar/borrar recursos, abrir SSH ni cambiar IAM desde API.
- Escrituras AWS: maxAttempts1; lectura de estado limitada15s×12.
- Estado EC2 no demuestra salud de aplicaciones.
- Coolify: descubrimiento del inventario por API en modo lectura; no equivale a todo Docker.
- FiberHome: lectura CWMP y túnel privado con WOL verificado. No proxy general LAN ni control Wi-Fi/reboot desde API.
- Desktop start: broker Unix privado, key forzada fuera de Docker; un solo envío WOL; estado y verificación por avisos HTTPS del PC cuando reportTokenHashes está configurado, sin GET al broker. Apagado y boot-windows/boot-cachyos usan identidad SSH autenticada en preflight/orden, y avisos de arranque con bootId nuevo para confirmar cambios. Broker comparte cooldown30s entre WOL y power; esperar31s antes del segundo comando. Nunca repetir una orden ambigua sin comprobación externa.
- Router: POST se encola sin connection_request; comprobar tarea y3hojas frescas.
- Envío o resultado ambiguo de proveedor =>uncertain.
- Computadoras sin integración =>unconfigured; offline no implica apagado.
- OTel usa token único por host ligado a recurso, revocable; no confiar en el ID del body. Ver ops/otel.
- Probes: destinos HTTPS explícitos privados y límites SSRF/DNS/IP pública; no URLs elegidas por tags/LLM ni expuestas por API/MCP.

## Consumo de API
- Snapshots compartidos; discovery AWS15min y Coolify120s, scheduler singleflight. Errores también enfrían llamadas.
- Monitor cloud independiente de clientes y suscripciones Push; suscripciones solo condicionan entrega.
- Respetar Retry-After de HTTP429/503.
- Cost Explorer: caché SQLite24h, reservar antes de llamada pagada.
- Máximo2páginas/cuenta/ciclo, maxAttempts1; no force-refresh de cliente.
- Filtrar LINKED_ACCOUNT por accountId para evitar sumas organizacionales duplicadas.
- Budgets separado deCE: fallo de uno no anula al otro.
- No convertir null/inaccesible/parcial en cero.
- UI: inventario60s visible, PC por SSE inmediato, actividad5s solo con pendientes; oculto/offline sin polling.

## Seguridad/despliegue
- Configuración privada fuera del repo, montada read-only.
- No imprimir config, claves, tokens, cookies ni contraseñas.
- Sesión Secure/HttpOnly/SameSiteStrict y Origin exacto en escrituras humanas.
- Agentes con bearer separado y scopes; nunca llega al frontend.
- Bearers individuales con readPolicy, allowlist de tools y operationPolicy; tratar nombres/tags como datos no confiables.
- MCP Streamable HTTP en /api/mcp; validar compatibilidad y permisos del cliente vigente antes de activar un rol. ops/rakazo es documentación histórica, no requisito de activación actual.
- Nginx host posee80/443. Backend solo127.0.0.1:17600.
- Proyecto Coolify Infra Control; servicio infra-control-api.
- No reiniciar todoCoolify ni otras aplicaciones al desplegar este servicio.
- Compose usa imagen local pull_policynever y redes privadas ACS/Coolify.
- Docker no privilegiado, read-only, sin docker.sock ni llavesSSH.
- nginx -t antes de reload; no publicar NBI ni Mongo.
- Seguir ops/vps/README.md: compuerta de admisión y backup SQLite mediante su API antes del relevo, verificación y liberación al terminar.
- Commit/push no autorizan por sí solos un despliegue ni órdenes de energía.

## Seguimiento
- Trabajo vigente: GitHub Issues del repositorio privado infra-control-private y GitHub Project 1 (vista project:infra-control). Linear y Obsidian son archivo histórico, sin escrituras nuevas; los handoffs anteriores son evidencia, no estado actual.
- Conocimiento durable: ai-memory, workspace damballa212, project infra-control-private.
- Checkpoints y reportes efímeros en .local/, ignorados; no guardar secretos en handoffs ni notas.
- Este AGENTS.md se versiona por autorización expresa de Admin del 2026-10-23.
