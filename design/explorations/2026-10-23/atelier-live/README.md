# Carbón / Atelier — prototipo interactivo

Maqueta HTML/CSS/JavaScript de la dirección visual 09. Pedida por Admin para poder usar el diseño como un artefacto navegable. **No sustituye la UI aprobada ni controla infraestructura.**

## Abrir

En esta EC2: http://100.64.0.10:17611/ (Tailscale).

Servicio temporal del usuario: `infra-atelier-live.service`.

Para servirlo en otra sesión, desde esta carpeta:

```sh
python3 -m http.server 17611 --bind 0.0.0.0
```

No requiere build, npm, servicios externos ni configuración privada. Mantenerlo separado del origen productivo.

## Recorridos

- Inicio: PC con cambio CachyOS/Windows, apagado con confirmación y encendido; progreso y resultado simulados.
- FiberHome: lectura simulada, sin afirmar que reportar demuestra acceso a Internet.
- Hermes: consulta y energía con advertencia sobre el orquestador.
- Equipos: búsqueda, filtros y detalle; MacBook sin agente, sin inventar su estado.
- Actividad: intenciones y resultados de esta sesión.
- Costes: composición visual con importes explícitamente ficticios.
- Ajustes: reinicio de la demo, incluso con una operación pendiente.

El estado vive solo en memoria. Recargar reinicia el escenario. `connect-src 'none'` impide peticiones de datos; imágenes y fuentes son locales. El buscador no inserta la entrada del usuario en HTML.

## Archivos

`index.html`, `style.css`, `app.js` y `assets/` constituyen la maqueta. `check.mjs` verifica recorridos con Playwright. La ilustración de PC se generó con imagegen como asset independiente; **la interfaz es DOM real**, no una imagen con zonas pulsables. Router y servidor son ilustraciones CSS. Fuentes DM Sans y Manrope con sus licencias OFL incluidas.

## Verificación reproducible

Usar una instalación de `playwright-core` (verificado con 1.58.2) y Chromium. Si está disponible por resolución de módulos normal, no hace falta `PLAYWRIGHT_MODULE`. Ejemplo en este host, ejecutado desde la raíz del repositorio:

```sh
PLAYWRIGHT_MODULE=/home/ubuntu/experimentos/mori-chat-ui/node_modules/playwright-core/index.mjs \
CHROMIUM_PATH=/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome \
node design/explorations/2026-10-23/atelier-live/check.mjs
```

Variables opcionales: `PROTOTYPE_URL`, `CHECK_OUTPUT`. Salida por defecto: `.local/atelier-checks/`, ignorada. La prueba captura anchos 320, 390, 834 y 1440, revisa desbordes, errores de JavaScript, ausencia de solicitudes externas y rutas interactivas. La cobertura reportada es por bytes de JavaScript de V8; no representa cobertura de ramas o líneas ni del producto real.

No se afirma validación física en iPhone ni certificación de accesibilidad. El prototipo incluye diálogos nativos con foco/Escape, navegación rotulada, texto de estado, contraste cuidado y reducción de movimiento. No se ejecutan suites del backend, dado que no se modifica ni se integra.
