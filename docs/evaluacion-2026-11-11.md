# Infra Control: evaluación de producto y arquitectura

Fecha de ejecución: 2026-11-11 UTC.

## Alcance y evidencia

Revisión directa del checkout /home/ubuntu/projects/hermes-workspaces/infra-control, rama migration/infra-control, HEAD a4f28b5; cambios locales existentes conservados. Lectura de instrucciones, memoria pertinente y GitHub, inspección del bundle público servido y pruebas locales con fixtures. No se modificó código, configuración productiva ni issues; no hubo despliegues ni órdenes de energía. Este informe no es una auditoría de seguridad completa ni una validación autenticada de todas las integraciones en producción.

CodebaseMemory no contiene este proyecto entre los proyectos devueltos; no se creó un índice ni se usó un grafo ajeno. La revisión se hizo en fuentes. El commit 4ae0f5d existe localmente y difiere de a4f28b5 en server/app.ts: wiring del descubrimiento Coolify. GitHub #200 distingue expresamente esa base de las capas UI desplegadas; no debe tratarse el checkout como una copia exacta de todos los procesos actuales.

## Dictamen

Conservar Infra Control como aplicación principal. No introducir Home Assistant como intermediario general. Antes de ampliar pantallas, corregir coherencia del estado y exponer las capacidades que el backend ya tiene. El producto debería responder: qué necesita atención, qué servicio afecta, qué puedo hacer con seguridad y qué necesita mi aprobación.

No eliminar módulos basándose únicamente en que no se ven útiles en una lectura de código. No hay medición de uso ni entrevista de tareas actuales que permita identificar funciones realmente abandonadas.

## Hallazgos prioritarios

### 1. Alta: un evento SSE puede sustituir varios equipos por el mismo

Fuente: design/handoff/ui/src/app/AppState.tsx:65–71.

La condición `row.id === resource.id || row.catalog?.catalogId === resource.catalog?.catalogId` acepta undefined === undefined. Un recurso sin catálogo puede sustituir otras filas sin catálogo.

Reproducción aislada con la expresión exacta del fuente:
- Entrada: computer:desktop, computer:mac, router:fiberhome.
- Evento: computer:mac sin catálogo.
- Salida: computer:mac, computer:mac, computer:mac.

El bundle público /assets/index-CsfgE_kI.js contiene esa misma comparación. Eso verifica presencia del código servido, no que se haya provocado o observado la corrupción en una sesión humana productiva. Corregir exigiendo identificadores de catálogo presentes e iguales y añadir regresión multi-recurso. Revisar orden temporal y carreras entre snapshot y eventos para recursos genéricos; la protección dedicada del PC no demuestra protección de todos los recursos.

### 2. Alta: el resumen puede presentar una salud demasiado optimista

Fuentes: ui/src/lib/status.ts:183–188; screens/Control.tsx:108–117; lib/inventoryNotice.ts.

needsAttention deriva de kind/state y no de Resource.health. Ejecución del módulo real: una EC2 running con health.service unhealthy y observación antigua devuelve false. La cabecera llama «al día» al número calculado desde esa clasificación y utiliza fetchedAt para la antigüedad del conjunto.

Hay banners separados que avisan de lecturas antiguas; no se afirma que la app carezca de avisos. El problema es la contradicción posible entre el titular optimista y esas señales. Separar disponibilidad, salud funcional, frescura y cobertura. La clasificación debe ser común a Inicio, filtros y detalle, y respetar los plazos por fuente.

### 3. Alta: avisos de órdenes inciertas desaparecen sin reconciliación suficiente

Fuente: screens/Control.tsx:89–100.

El aviso se oculta con cualquier observación posterior del recurso, otra orden posterior exitosa o después de 24 horas. Esto no modifica el registro durable de la operación, pero sí puede retirar la advertencia sin verificar su resultado. Una observación posterior no equivale necesariamente al resultado esperado. Diseñar reconciliación explícita y durable con evidencia; no reetiquetar historia ni habilitar reintentos automáticos de órdenes ambiguas. Fallo e incertidumbre requieren tratamientos distintos.

### 4. Media: desborde real en móvil

Playwright local: el test frontend.spec.ts:12 falla porque document.documentElement.scrollWidth supera innerWidth. El trace corresponde a viewport 320×844. Se inspeccionó el fotograma: tarjeta PC y conector se recortan horizontalmente, y la cabecera consume varias líneas. Es una captura fixture, no una captura del inventario productivo.

No requiere cambiar la identidad visual aprobada: reparar restricciones de ancho y reducir presión de contenido. Validar después 320/390/834/1440 y el iPhone real.

### 5. Media: identidad de agente confundida con identidad del host

Fuentes: lib/status.ts:217–225, screens/Control.tsx:221–253, screens/Settings.tsx:246–275.

La EC2 llamada orchestrator se convierte en «Hermes» por coincidencia de nombre. EC2 encendida no acredita servicio Hermes disponible. La página Agentes muestra estáticamente Hermes, read/operate y «Token instalado», aunque marca «Sin confirmar». No es un inventario real de identidades ni permisos actuales.

Reemplazar afirmaciones fijas por metadata comprobada. Distinguir host físico, servicio lógico, cliente/agente y credencial. No retirar el recurso real ni sus controles por limpiar una etiqueta histórica.

## Qué conservar, simplificar y añadir

### Conservar

- UI aprobada, tokens, assets y componentes; no proponer un rediseño total.
- Núcleo OperationService: idempotencia, autorización y revalidación, control de una operación activa, planes y estados terminales.
- SQLite/singleton y gate de despliegue; no quitar mecanismos por simplificar interfaz.
- Controles PC y dependencia del router.
- Costes AWS y presupuesto con caché y datos parciales explícitos.
- Actividad y seguimiento de órdenes.
- Backend de catálogo, servicios lógicos, salud, sondas y telemetría.

Se revisaron estos mecanismos en fuentes; no se ejecutaron ahora las suites backend ni pruebas de energía productivas.

### Simplificar o retirar de la experiencia principal

- Sustituir la página estática Agentes por estado comprobado o una explicación honesta; no usarla como panel de administración ficticio.
- Evitar duplicar todo el inventario de nube en Inicio y Equipos: Inicio debe resumir excepciones y accesos frecuentes.
- Reducir prominencia de diagnóstico router cuando todo funciona, manteniendo visible su dependencia del encendido del PC y el acceso al detalle.
- No añadir chat, terminal, gestor completo de contraseñas, clon de Coolify ni tablero de GitHub. Ya existen productos para esas funciones.
- No crear pestañas sin contenido real. Las nuevas vistas de servicios/agentes pueden comenzar como modos de Inventario.

### Añadir con prioridad

1. Estado fiable e incidentes en Inicio, antes de nuevas funcionalidades.
2. Servicios por proyecto/entorno, distinguidos de hosts y contenedores: servicio → recurso que lo aloja → dependencia explícita. El API ya dispone de /api/catalog/projects y /api/catalog/services; no inventar relaciones por nombres ni ampliar permisos.
3. Detalle de equipo útil: salud de aplicación, métricas disponibles y frescas, último cambio stateChangedAt, capacidad de control y motivo de indisponibilidad. Hoy hostMetrics/stateChangedAt/actionAvailability aparecen en tipos pero no se presentan en los componentes revisados.
4. Salud del propio sistema: el backend ya ofrece /api/system/health para cobertura, observadores, colas y cache; la interfaz DataProvider actual no lo integra.
5. Historial real de operación: existe GET /api/operations/:id/history, pero la pantalla usa createdAt/updatedAt y etapas genéricas. Consumir la evidencia disponible en vez de inventar tiempos.
6. Aprobaciones/credenciales como flujo humano, no como almacén de secretos dentro del panel.

Historial de métricas: Store conserva muestras limitadas, pero eso no acredita una API de series ni gráficas implementadas. Para añadir tendencias hace falta diseñar una superficie acotada, no prometer que basta con activar una gráfica.

## Sistema de keys: distinciones necesarias

Lo que se pudo verificar EN ESTE repositorio:

- Tokens de agentes de Infra Control con hashes, read/operate, readPolicy, mcpTools y operationPolicy en Config; no hay en la UI revisada una gestión dinámica y completa de alta/rotación/revocación.
- Piloto credential-link y pantallas de solicitudes. El cliente admite exclusivamente el valor ficticio fijo y el servidor rechaza claves reales.
- El runbook HTTPS y GitHub #200 describen un broker separado, vida acotada de 24 horas, requests no durables entre reinicios y validación humana/iPhone pendiente en el último comentario leído.
- Se ejecutaron 43 tests locales del laboratorio; no acreditan recepción de una key real, integración de todos los agentes ni recuperación productiva.

Esto no demuestra que no exista otro sistema nuevo instalado en la infraestructura. No se identificó su proveedor ni contrato en las fuentes consultadas, por lo que no se atribuye al piloto la condición de sistema global terminado.

Arquitectura recomendada si ya existe un gestor productivo: el panel consume metadata y aprobaciones del gestor, sin duplicar almacenamiento. Separar:
- quién es el agente/cliente y desde qué host;
- qué acciones puede ejecutar y sobre qué proyecto/entorno;
- qué credencial de proveedor puede usar, para qué destino y por cuánto tiempo.

Mostrar nombre lógico, propietario, alcance, caducidad conocida, estado de entrega/uso y referencia de auditoría; nunca el valor. «Recibida», «usada por el ejecutor» y «proveedor autenticado» son hechos distintos. Una fecha de rotación no prueba revocación efectiva. La revocación debe ejecutarse en el sistema que sea autoridad y registrar su resultado. No añadir botones antes de tener ese contrato y sus permisos.

No convertir Inicio en un listado de keys; mostrar únicamente solicitudes de intervención, fallos de uso y vencimientos conocidos relevantes. El agente inicia la solicitud, el humano aprueba/entrega en una superficie autenticada y el ejecutor recibe el secreto fuera del modelo cuando la arquitectura realmente lo garantice.

## Orden recomendado

- Primero: regresiones de estado/SSE, incertidumbre y desborde; resolver divergencia entre documentación, checkout y release antes de desplegar.
- Después: consumir salud, catálogo de servicios y detalle ya existentes, preservando diseño y políticas.
- Luego: identificar el gestor de claves real, verificar el flujo agente → solicitud → aprobación → uso → revocación, e integrar sólo su metadata/acciones autorizadas.
- Finalmente: decidir tendencias, recuperación de respaldos y mejoras adicionales con evidencia de necesidad y cobertura.

No hay autorización implícita para implementar, cerrar #157, habilitar secretos reales, retirar Home Assistant o desplegar lo descrito.

## Pruebas ejecutadas en esta evaluación

- UI npm run typecheck: correcto.
- UI npm test -- --reporter=dot: 59 tests, 7 archivos, correctos.
- UI npm run test:e2e -- --workers=1: 15 correctos, 1 fallo de desborde de Inicio a 320px. El flujo de credenciales es fixture. El test HTTP usa el dist existente; no se ejecutó un nuevo build, por lo que no certifica reconstrucción del checkout.
- PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q test_broker test_https_broker test_agent_control: 43 tests correctos, HTTP/procesos de laboratorio, sin claves reales.
- Reproducciones Node: comparación SSE produce tres filas computer:mac; needsAttention ignora la señal unhealthy del ejemplo.
- Bundle público leído con TLS validado por urllib: contiene la comparación SSE problemática y el formulario FAKE_ONLY.
- Git status y numstat finales conservan los mismos cambios locales preexistentes. Puertos temporales 5176/4176 cerrados al terminar.

Limitaciones: sin acceso autenticado a inventario productivo ni inspección de configuración privada; sin aceptación visual humana/iPhone; sin tests backend porque node_modules de raíz no está instalado y no se instalaron dependencias; sin prueba de entrega, uso o revocación de keys reales. No se auditó toda la infraestructura ni se verificó aislamiento entre todos los agentes.

## Fuentes operativas

- GitHub #200: https://github.com/damballa212/infra-control-private/issues/200 (cuerpo y comentarios leídos).
- GitHub #157: https://github.com/damballa212/infra-control-private/issues/157 (migración histórica, no cierre ni cambio de estado).
- Código citado, AGENTS.md, README.md, ops/otel/README.md y pilots/credential-link/HTTPS-README.md.
- Memoria: operations/agent-rules.md, workspace damballa212, project vault-system; búsquedas pertinentes en infra-control-private y namespaces históricos.
