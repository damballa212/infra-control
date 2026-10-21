# UX de Infra Control · especificación

Propuesta 2026-10-21. Variante D (Pixel atardecer). **Pendiente de validación del propietario antes de implementarla**: `AGENTS.md` pide validación para cambios visuales. Mockups: lienzo «Control · rediseño atardecer» (https://claude.ai/artifact/78r6fGoX78X2uXEnKrNCtz).

## 0. La idea en una frase

Un mando a distancia honesto: abres la app, en 2 segundos sabes si todo está bien y con 2 toques prendes la PC en el sistema que quieres. Nunca te dice que algo pasó si no lo ha comprobado.

### Principios (en orden de prioridad cuando chocan)

1. **Verdad antes que optimismo.** Todo estado lleva su antigüedad. «Orden recibida» no es «hecho». `uncertain` se trata como «no sabemos», nunca como fallo ni como éxito.
2. **Intención antes que proveedor.** La pantalla se ordena por lo que el propietario hace («prender la PC», «¿hay Internet en casa?»), no por AWS / Coolify / ACS.
3. **Lo urgente sube solo.** Si algo necesita atención, aparece arriba. Si nada lo necesita, no hay ruido.
4. **Fricción proporcional al daño.** Consultar no pide nada; encender pide un toque de confirmación; apagar algo que otros usan pide mantener pulsado.
5. **Nunca te quedas sin contexto.** Una orden se sigue en el mismo sitio donde se dio, no en otra pantalla.
6. **Nativa, no web.** Fondo de borde a borde, hojas que suben desde abajo, nada de saltos blancos, nada de esperas sin explicación.

## 1. Para qué abre el propietario la app

| # | Trabajo | Frecuencia estimada | Dónde debe resolverse |
|---|---|---|---|
| 1 | Prender la PC de casa (y elegir Windows o CachyOS) para jugar o trabajar en remoto | Varias veces por semana | Inicio, primer bloque, 2 toques |
| 2 | Saber si todo está bien | Cada vez que abre | Línea de estado de la cabecera, 0 toques |
| 3 | Apagar la PC o cambiar de sistema | Varias por semana | Inicio, misma tarjeta |
| 4 | Prender o apagar una EC2 (game-server, Hermes) | Semanal | Inicio (Hermes) o Equipos |
| 5 | ¿Hay Internet en casa? | Cuando algo falla | Inicio, bloque Casa |
| 6 | ¿Cuánto llevo gastado este mes? | Semanal | Pestaña Costes; aviso en Inicio solo si se pasa |
| 7 | ¿Qué hizo Hermes? / ¿Se aplicó mi orden? | Ocasional | Actividad |
| 8 | Resolver una orden incierta | Rara, pero crítica | Aviso arriba en Inicio y en Actividad |

Consecuencia: la PC va primero, Hermes segundo y la nube se resume. Nadie abre la app para leer una lista de 9 servicios.

## 2. Arquitectura de información

Barra inferior con **4 pestañas**. Ajustes pasa a la cabecera porque se usa poco:

| Pestaña | Contenido | Sustituye a |
|---|---|---|
| **Inicio** | Estado global, avisos, órdenes en curso, PC, Hermes, Casa y resumen de nube y gasto | «Control» |
| **Equipos** | Inventario completo con búsqueda y filtros, agrupado | Pantalla «Buscar» y la lista larga de Control |
| **Actividad** | Órdenes del propietario y de Hermes, filtrables | Igual |
| **Costes** | Gasto del mes, presupuestos y por servicio | Igual |

- **Cabecera:** botón de Ajustes (engranaje) a la derecha. La lupa se va: buscar vive en Equipos, como primer elemento.
- **Rutas:** `/` Inicio, `/equipos`, `/equipos/:id`, `/actividad`, `/actividad/:id`, `/costes`, `/ajustes/...`.
- **Detalle de equipo:** en móvil es una página con transición de empuje y gesto atrás. En escritorio es un panel lateral.
- **Estado de pestaña:** cada pestaña conserva su scroll y sus filtros al cambiar de pestaña (como en iOS). Tocar la pestaña activa sube al principio.

## 3. Inicio, bloque por bloque

El fondo es el atardecer, de borde a borde y fijo. El contenido se desliza por encima. Orden fijo de arriba abajo:

### 3.1 Cabecera (sobre el cielo)

- **Saludo según la hora de Bogotá:** «Buenas noches, Admin».
- **Línea de estado global**, la pieza más importante de la app. Es un botón que lleva a lo que corresponda. Prioridades:
  1. Sin conexión: «Sin conexión · mostrando lo de hace 4 min».
  2. Hay órdenes inciertas o fallidas: «⚠ 1 orden sin confirmar» (abre esa orden).
  3. Hay equipos que necesitan atención (`needsAttention`): «2 equipos necesitan atención» (abre Equipos filtrado).
  4. Hay órdenes en curso: «Apagando prod-erp…».
  5. Todo bien: «Todo en orden · 11 equipos reportando».
- **Frescura:** «Actualizado hace 12 s». Si el inventario tiene más de 2 min, el texto cambia de color y dice «Última lectura hace 6 min».
- **Al hacer scroll,** el título grande se encoge a una barra compacta con «Inicio» y el punto de estado (patrón de título grande de iOS). El cielo sube con efecto parallax suave; sin efecto con movimiento reducido.

### 3.2 Avisos (solo si existen; máximo 3, el resto con «Ver todos»)

Son tarjetas compactas con un borde de color según el tipo. Llevan una acción directa, en este orden:

1. **Orden incierta:** «No sabemos si se apagó orchestrator» → botón «Comprobar estado».
2. **Orden fallida en las últimas 24 h:** «No se pudo encender game-server» → «Ver qué pasó».
3. **Presupuesto previsto por encima del límite:** «agents va a pasarse: previsto $31 de $25» → «Ver costes».
4. **Datos viejos de un grupo entero:** «Coolify no responde desde hace 5 min».

Un aviso se puede descartar hasta que cambie su causa; el descarte se guarda en localStorage. Nunca se descarta una orden incierta: solo se resuelve comprobando.

### 3.3 Orden en curso (cápsula viva)

Mientras haya una orden activa aparece una cápsula fija sobre la barra inferior, visible en todas las pestañas. Lleva sprite pequeño, «Encendiendo PC · 0:42» y un indicador de etapa. Al tocarla abre el detalle de la orden. Al terminar:

- **Confirmada:** la cápsula se pone verde 4 s con «Confirmada» y Hermes feliz, y desaparece.
- **Fallida o incierta:** se queda hasta que la toques. Además se crea el aviso del punto 3.2.

### Orden de bloques (decidido 2026-10-21)

1. **Casa: PC + FiberHome unidos.** El router va justo debajo de la PC, enlazado con un conector «Encendido y cambio de sistema vía». Encender la PC depende del túnel del FiberHome, así que la dependencia se ve donde importa. Si el router falla, su tarjeta pasa a `warn` y el botón Encender de la PC dice por qué está deshabilitado.
2. **Orquestador: Hermes,** grande.
3. **Personal: MacBook** (3.6 bis). Ya no va en «Casa», porque es portátil.
4. **Nube y gasto.**

### 3.4 PC de casa (tarjeta principal)

Es una máquina de estados que siempre muestra estado, sistema, antigüedad del aviso y una acción principal:

| Estado del recurso | Sprite | Título y estado | Acción principal | Secundaria |
|---|---|---|---|---|
| `running` + system | Pantalla encendida (fondo del SO) | «En línea · CachyOS» | Apagar (mantener pulsado) | «Cambiar a Windows» |
| `stopped` | Pantalla apagada, «zzz» | «Apagada · anunció su apagado hace 2 h» | **Encender ▾**, que abre el selector de SO | — |
| `unreachable` | Pantalla apagada con «?» | «Sin señal · no confirma que esté apagada» | Encender ▾ (WOL) | «Consultar» |
| `pending` | Pantalla parpadeando | «Arrancando CachyOS… 0:35» | (deshabilitado, con motivo) | — |
| `stopping` | Pantalla apagándose | «Apagándose…» | (deshabilitado) | — |
| `unknown` / sin túnel | Gris con «?» | «Sin datos del túnel» | (deshabilitado, con motivo) | «Ver el router» |
| `unconfigured` | Contorno discontinuo | «Por conectar» | — | «Cómo conectarla» |

Reglas:

- **Encender abre una hoja con dos opciones grandes:** «CachyOS» y «Windows». Usa `boot-cachyos` o `boot-windows`, que el servidor ya ofrece cuando la PC está apagada. El último SO usado va preseleccionado y arriba. Un toque confirma: encender no destruye nada.
- **Apagar o cambiar de sistema cierra sesiones.** Se usa una hoja con la consecuencia («Se cerrarán las sesiones abiertas en CachyOS») y un botón de **mantener pulsado 1 s**.
- **Dependencia visible:** encender depende del túnel del FiberHome. Si el router está `unknown` o `stale`, el botón se deshabilita con el motivo «El router de casa no responde; sin él no se puede enviar el encendido».
- **Enfriamiento:** tras una orden, el broker exige unos 31 s. El botón muestra «Disponible en 24 s» con cuenta atrás, no un error.
- **Tiempo real:** el estado llega por SSE (`/api/events`). Al cambiar, el sprite cambia con transición, sin recargar la página.

### 3.5 Hermes

- **Tarjeta grande:** sprite de 96 px con el estado de ánimo derivado del estado real (`hermesMood`), estado, «Observado hace 40 s», «Consultar» y «Energía».
- **Línea de actividad:** «Última orden de Hermes: leyó FiberHome hace 2 h», sacada de `/api/operations` filtrando por `actor === 'hermes'`. Si no hay ninguna, la línea no aparece.
- **Apagar Hermes** detiene el orquestador. Va en una hoja con esa advertencia y mantener pulsado. Encenderlo pide un toque.

### 3.6 Casa

- **FiberHome siempre visible**, sin desplegable. Su estado se traduce a la pregunta real: «Reportando · hace 25 s». Debajo va el matiz: «Reportar no garantiza que Internet funcione completo».
- **Acción:** «Leer ahora» (`refresh`). La lectura tarda hasta 150 s, y la tarjeta lo muestra con progreso propio («Esperando el próximo reporte del router · 1:10»).
- **Forma:** FiberHome es la tarjeta compacta pegada a la PC: sprite de 48 px, «Internet de casa · reportando hace 25 s» y el botón «Leer».

### 3.6 bis MacBook

Hoy el servidor la publica fija como `unconfigured` (`server/infrastructure.ts`): no hay ningún dato real de ella.

**Corto plazo (solo UI):**
- El estado se llama «Sin agente», no «Por conectar».
- Si `navigator.userAgent` indica macOS y `navigator.maxTouchPoints === 0` (para excluir iPad), se añade la pista «Parece que abriste el panel desde una Mac. Si es esta MacBook, conéctala para ver su estado aquí».
- **Nunca** se marca «En línea» por detectar el navegador: no prueba que sea esta MacBook.

**Solución real (backend):** un reporter de macOS como los de la PC (`ops/pc/reporters`).
- Funciona como LaunchAgent con token exclusivo, heartbeat de 30 s y eventos de reposo y despertar (`NSWorkspace` sleep/wake).
- Publica `running`, `asleep` (anunciado) y `unreachable` (sin señal, que no implica apagada).
- Sin acciones de energía: es de solo lectura.
- Si el agente envía un identificador de dispositivo y la UI lo guarda, la tarjeta puede mostrar «Estás aquí».

**Sprite** (lienzo, tablero 9): MacBook frontal de 32×23 con notch, bisel, canto de aluminio y apoyo del pulgar. Se escala solo en múltiplos enteros. Cada estado tiene su animación ligada al dato real; todas se paran con movimiento reducido y con la app oculta.

| Estado | Pantalla | Animación |
|---|---|---|
| En línea | El panel abierto sobre el atardecer, con dock | Cursor a saltos, un icono del dock rebota cada 6 s |
| En reposo | Tapa cerrada | Las «z» suben |
| Sin señal | Negra | Interrogación que parpadea |
| Sin agente | Apagada con marco punteado | El enchufe late |

Al pasar de reposo a en línea, la tapa se abre en 4 pasos sobre la bisagra, una sola vez.

### 3.7 Nube y gasto (resumen)

- **Tarjeta de nube:** chips con conteos por estado (los que tienen problemas, primero y en su color) y el botón «Ver los 9 equipos», que abre Equipos.
- **Tarjeta de gasto:** «Este mes · $45,70 estimado», con barra contra la suma de presupuestos disponibles y la nota «1 cuenta sin datos» si aplica.
  - Nunca se suma una cuenta `partial` o `unavailable` al total; se marca aparte.
  - Al tocarla abre Costes.

## 4. Modelo de estado y de verdad

Todo estado se muestra con **símbolo + texto + color**; el color nunca va solo.

| Tono | Uso | Símbolo |
|---|---|---|
| `on` (menta) | Encendido o reportando confirmado | ● |
| `off` (arena) | Apagado o detenido confirmado | ■ |
| `busy` (sol) | Transición en curso | ◐ animado |
| `warn` (naranja) | Datos viejos o lectura parcial | ◷ |
| `unk` (discontinuo) | Sin datos, sin señal o incierto | ? |
| `bad` (rojo #C8102E) | Fallo reportado o fallo de orden | ✕ |

**Antigüedad (`observedAt`):**

| Antigüedad | Cómo se muestra |
|---|---|
| < 2 min | «hace 40 s», normal |
| 2–10 min | Gris más tenue con ◷: «hace 6 min» |
| > 10 min | Tono `warn` y «Último dato hace 14 min · puede haber cambiado» |
| `null` | «sin observación», nunca «hace 0 s» |

Reglas:

- **Datos que cambian:** el número se anima con un pequeño destello. No hay saltos de diseño (CLS 0).
- **Primera carga:** se usa un esqueleto con la forma exacta de las tarjetas, nunca una ruleta en pantalla completa.
- **Recargas:** se conserva lo anterior y solo se atenúa la antigüedad.
- **Regreso del segundo plano:** se pide inventario al instante. Mientras llega, se muestra lo último con «Actualizando…» en la línea de estado; no se vacía nada.
- **Después de una orden confirmada,** el inventario puede seguir mostrando el estado viejo hasta su ciclo de 60 s. La tarjeta muestra «Confirmada · la lista se pondrá al día en 35 s» y no cambia el estado por su cuenta.

## 5. Acciones: el corazón de la app

### 5.1 Matriz de fricción

| Acción | Ejemplo | Confirmación |
|---|---|---|
| Consultar (`refresh`) | Leer router, consultar EC2 | Ninguna; el botón muestra progreso |
| Encender | PC, game-server | Hoja + 1 toque |
| Encender PC eligiendo SO | Encender en Windows | La elección del SO es la confirmación |
| Apagar algo personal | PC, game-server | Hoja + mantener pulsado 1 s |
| Apagar algo que usan otros o que sostiene servicios | Hermes, `prod-*`, prod-messaging | Hoja + advertencia destacada + mantener pulsado 1,5 s |
| Cambiar de sistema con la PC encendida | CachyOS → Windows | Hoja + mantener pulsado 1 s |

La lista de equipos «críticos» es una constante de UI revisable (`CRITICAL_RESOURCE_PATTERNS`). Si el backend llega a exponer un campo para esto, se usa el campo.

### 5.2 Hoja de confirmación (bottom sheet)

- **Título con verbo + objeto:** «¿Apagar prod-erp?».
- **Consecuencias en 1–2 líneas,** sacadas de `note` y de reglas de UI: «El ERP de producción dejará de responder. AWS solo confirma el estado de la máquina, no de sus aplicaciones».
- **Contexto:** estado actual con antigüedad («Encendida · observado hace 40 s»). Si el dato tiene más de 2 min, se avisa: «Este dato es de hace 6 min».
- **Botones:** «Cancelar» (foco inicial) y la acción. Para mantener pulsado, el botón se llena de izquierda a derecha. Soltar antes cancela sin efectos. En teclado o lector de pantalla, mantener pulsado se sustituye por un segundo botón «Confirmar» (accesible; no se exige gesto largo).
- **Cierre:** se cierra con arrastre hacia abajo, toque fuera o Esc. Al cerrar, el foco vuelve al botón que la abrió.
- **Vibración:** al completar el pulsado, 15 ms en Android (`navigator.vibrate`); en iOS no hay API y no se simula.

### 5.3 Ciclo de vida, dentro de la misma hoja

Tras confirmar, la hoja no se cierra: se transforma en progreso.

1. **Enviando…** (antes de la respuesta HTTP).
2. **Recibida**: el panel la registró (`accepted`). Esto no es éxito.
3. **En curso**: con tiempo transcurrido y el máximo esperado («AWS lo comprueba cada 15 s, hasta 3 min»).
4. **Final:**
   - `succeeded`: «Confirmada» + Hermes feliz.
   - `failed`: «No se pudo» + mensaje + «Comprobar estado».
   - `uncertain`: «No sabemos si se aplicó» + «Comprobar estado» + aviso persistente.

La hoja se puede cerrar en cualquier momento («Seguirá en segundo plano») y la cápsula viva la sigue. **No se navega** a otra pantalla tras enviar; hoy `DesktopControls` navega a la operación y eso hay que corregirlo.

### 5.4 Casos difíciles

- **Envío ambiguo** (red cortada tras enviar): «No sabemos si la orden llegó». Botón «Reintentar el mismo envío» con la misma `Idempotency-Key` y la explicación «Es seguro: si ya había llegado, no se repite». Es la única repetición que se ofrece.
- **Orden incierta:** el botón de repetir está oculto. Solo existe «Comprobar estado», que pide `refresh`. Cuando llega una observación posterior a la orden, se muestra el resultado real («Ahora está detenida») y entonces se habilitan las acciones normales.
- **409, orden en curso:** «Ya hay una orden en curso para este equipo», con enlace a ella.
- **429:** «Espera 45 s», con cuenta atrás en el botón; no se reintenta solo.
- **Acción que desaparece** (`actions` cambió mientras la hoja estaba abierta): la hoja muestra «El estado cambió: esta acción ya no está disponible» y ofrece las nuevas.
- **Sesión caducada a mitad:** hoja de acceso encima, sin perder la pantalla. La orden **no** se reenvía sola tras volver a entrar.

### 5.5 Botones deshabilitados

Nunca hay un botón gris sin motivo. Debajo, una línea dice por qué: «Solo lectura: Coolify no permite control desde aquí», «Hay una orden en curso», «Disponible en 24 s», «Sin conexión».

## 6. Equipos

- **Búsqueda fija arriba;** al entrar no abre el teclado.
- **Chips de filtro:** «Necesitan atención» (con conteo, aparece primero solo si hay), «Encendidos», «Apagados», «Casa», «AWS», «Coolify». El filtro activo se refleja en la URL (`?f=atencion`).
- **Grupos:** Casa, AWS por cuenta (prod, agents, lab) y Coolify. Cada grupo tiene su frescura en el encabezado («AWS · hace 40 s»).
- **Fila:** sprite pequeño, nombre, «Estado · hace X» y chevron. Fila de 64 px; toda la fila es el objetivo táctil.
- **Detalle:**
  - Cabecera con sprite grande, estado y antigüedad.
  - Acciones según `actions`.
  - Notas honestas (`note`).
  - Datos: tipo, región, cuenta. Los IDs completos van en un desplegable «Técnico», con botón copiar.
  - Últimas 5 órdenes de ese equipo.
- **Sin resultados:** «Nada coincide con "xyz"» + «Quitar filtros».

## 7. Actividad

- **Lista agrupada por día** («Hoy», «Ayer», fecha).
- **Filtros:** «Todas», «En curso», «Por comprobar» (incierta o fallida), «Mías», «Hermes».
- **Fila:** avatar del actor (persona o Hermes), «Apagar · prod-cms», estado y hora.
- **Detalle de orden:**
  - Etapas con las marcas reales disponibles: `createdAt` y `updatedAt`. No se inventan horas de etapas intermedias.
  - Mensaje del proveedor tal cual y estado actual del equipo con su antigüedad.
  - Si está incierta o fallida: «Comprobar estado».
- **Sondeo:** cada 5 s solo si hay órdenes pendientes y la app está visible.

## 8. Costes

- **Cifra principal:** «$45,70 · estimado en lo que va de octubre». Suma solo las cuentas `available`. Debajo dice «lab: sin permiso para leer costes» y no la suma.
- **Por cuenta:** neto, uso y créditos explicados en una línea («Uso $58,40 − créditos $40,00 = $18,40 neto»). Barra de presupuesto con marca de previsión; si la previsión supera el límite, la barra se vuelve `warn` con texto.
- **Por servicio:** las 5 líneas más altas con barras horizontales del mismo color, ordenadas.
- **Diario:** gráfico de barras pequeño por día, con el día de hoy marcado como parcial.
- **Frescura:** «Datos de hace 20 min · próxima lectura en 23 h». No hay botón de refrescar: la política de coste no lo permite, y se dice.
- **Primer día del mes:** «AWS aún no publica el consumo de octubre», nunca «$0».

## 9. Ajustes y sesión

- **Cuenta:** cambiar contraseña, con la regla visible y la indicación de que al cambiarla se cierra la sesión.
- **Esta app:**
  - Instalar en pantalla de inicio. Se muestran los pasos de iOS (Compartir → Añadir) si no está instalada, y se oculta si ya corre en standalone.
  - Movimiento: «Según el sistema / Reducido».
- **Agentes:** explica qué puede hacer Hermes (`read` / `operate`) según `/api/auth/me` del agente, si está disponible. No hay botones de revocar mientras la API no los tenga.
- **Acerca de:** versión de la app y del backend, y «Hay una versión nueva · Actualizar» cuando el SW detecta una.
- **Cerrar sesión:** pide confirmación de un toque.
- **Sesión:** expira → hoja de acceso modal, conservando la ruta. Usuario y contraseña con `autocomplete` correcto para llavero de iOS, Face ID vía llavero y campos de 16 px (evita el zoom de iOS).

## 10. Sensación nativa (checklist técnico)

- [ ] `<meta name="apple-mobile-web-app-capable" content="yes">` y `apple-mobile-web-app-status-bar-style` = `black-translucent`.
- [ ] `html, body { background: #1B1A3A }`. El crema nunca es el fondo de página: elimina la franja blanca del notch y del rebote.
- [ ] Fondo del atardecer en una capa `position: fixed; inset: 0` detrás de todo, pintado también bajo `env(safe-area-inset-top)`.
- [ ] `overscroll-behavior-y: none` en `html`, para que el rebote no destape otro color.
- [ ] Safe areas en los 4 lados: `viewport-fit=cover` ya está. Añadir `padding-left/right: env(safe-area-inset-*)` en horizontal.
- [ ] Altura con `100dvh`; barra inferior con `padding-bottom: env(safe-area-inset-bottom)`.
- [ ] `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation` y `user-select: none` en controles. Cada tecla tiene estado `:active` (baja 4 px, como el pixel-art aprobado).
- [ ] Pantallas de arranque `apple-touch-startup-image` con el cielo, y `background_color` del manifest en `#1B1A3A` (hoy es `#FFF4E0` y produce un destello crema al abrir).
- [ ] `theme-color` igual al color del borde superior del cielo.
- [ ] Transiciones:
  - Empuje lateral para el detalle; hoja desde abajo para acciones (View Transitions API donde exista, CSS como respaldo).
  - Gesto atrás del sistema respetado (History API, que ya se usa).
- [ ] El SW cachea solo shell y assets, nunca `/api`. Sin red, la app abre con el último estado en memoria y el banner «Sin conexión».
- [ ] Nada de `alert()` / `confirm()` del navegador.
- [ ] Teclado: los inputs no quedan tapados (`scrollIntoView` al enfocar) y Enter envía en el acceso.

## 11. Movimiento y atardecer vivo

- **Ambiental:** las estrellas parpadean, las nubes derivan lento y las luciérnagas aparecen sobre las colinas. Todo se pausa con la app oculta y desaparece con movimiento reducido.
- **Animaciones con significado** (lo aprobado en la Fase A):
  - Hermes cambia de ánimo según su estado.
  - El router emite ondas al reportar.
  - La pantalla de la PC se enciende o apaga con la transición real.
  - Hermes celebra solo con una orden confirmada.
- **Sprites detallados** (lienzo, tableros 9 y 10). Todos usan cuadrícula entera y animaciones por pasos (`sprites.css` del lienzo).

  **PC de casa (48×32).**
  - Escritorio con monitor (bisel, LED de encendido, pie) y teclado y ratón retroiluminados.
  - Torre con cristal lateral: placa, RAM con RGB, ventilador de CPU con aro RGB, gráfica con dos ventiladores, fuente cubierta y tira frontal.
  - Pantallas por estado:

  | Estado | Pantalla |
  |---|---|
  | CachyOS | Terminal viva y gráfica de uso |
  | Windows | Fondo de flor, juego con personaje que salta, barra centrada |
  | Arrancando o cambiando | Rueda de 8 puntos, ventiladores al máximo |
  | Apagándose | Rueda con barra naranja, ventiladores frenando |
  | Apagada | Reflejo y «z», LED de reposo naranja respirando |
  | Sin señal | Interrogación |

  **FiberHome (48×32).**
  - Router blanco con 4 antenas y tapa con rejilla en perspectiva.
  - Franja con 7 indicadores (encendido, PON, LOS, Internet, LAN, 2,4 y 5 GHz) y botón WPS.
  - Fibra amarilla con conector SC verde y cable de red hacia la PC.

  | Estado | Animación |
  |---|---|
  | Reportando | Ondas, indicadores a ritmos distintos, paquetes por la fibra |
  | Leyendo | Todo acelerado |
  | Antiguo | Reloj, sin ondas |
  | Sin ACS | Indicadores apagados e interrogación |

  - Sin ACS **no** enciende LOS en rojo: eso afirmaría una pérdida de fibra que no se sabe.
  - Sustituyen a los sprites aprobados en la Fase A (router con ojos, PC de 24×20). Esto requiere la validación del propietario.
- **Propuesta opcional (validar):** el cielo refleja el estado global de forma ambiental, nunca como único indicador.
  - Atardecer limpio = todo en orden.
  - Nubes más densas = hay avisos.
  - Estrellas apagadas = sin conexión.
- **Duraciones:** 120–200 ms en controles y 280 ms en hojas, con curvas de salida suave. Sin rebotes en elementos de datos.

## 12. Accesibilidad

- **Lectores de pantalla:**
  - Cada tarjeta se anuncia en una frase: «PC de casa, en línea con CachyOS, aviso hace 8 segundos».
  - El progreso de órdenes va en `aria-live="polite"`; los resultados finales, en `assertive` solo si fallan o quedan inciertos.
- **Hojas:** son `dialog` modales con foco atrapado, Esc y foco devuelto. La raíz queda `inert`, como ya hace `Dialog.tsx`.
- **Mantener pulsado** siempre tiene alternativa sin gesto (5.2).
- **Visual:** contraste ≥ 4,5:1, incluido el texto sobre el cielo (por eso la cabecera usa crema sobre noche o violeta y nunca texto sobre la banda naranja). Objetivos ≥ 48 px. Zoom de texto al 200 % sin cortar.

## 13. Escritorio y tableta

- **≥ 701 px:** barra lateral con las 4 pestañas y Ajustes al pie.
- **≥ 1101 px:** Inicio en 2 columnas. La izquierda lleva PC, Hermes y Casa; la derecha, avisos, órdenes en curso, gasto y nube.
- **Equipos y Actividad:** lista + panel de detalle a la derecha (patrón maestro/detalle).
- **Atajos:** `/` busca, `g i` / `g e` / `g a` / `g c` cambian de pestaña, Esc cierra la hoja.
- **Fondo:** el cielo se mantiene; en pantallas anchas el sol se queda a la derecha y las tarjetas tienen ancho máximo.

## 14. Microcopy

- **Tono:** tuteo, verbos en infinitivo en botones («Encender», «Comprobar estado»). Frases cortas que dicen qué pasa y qué hacer.
- **Palabras prohibidas:** «éxito» antes de confirmar; «caído» u «offline = apagado»; «error desconocido».
- **Glosario fijo:**

| Término | Significado |
|---|---|
| Recibida | El panel guardó la orden |
| En curso | Se envió y se está comprobando |
| Confirmada | El proveedor confirmó el estado final |
| No se pudo | `failed` |
| Sin confirmar | `uncertain` |
| Sin señal | `unreachable` |
| Sin datos | `unknown` |
| Sin agente | `unconfigured` en computadoras (antes «Por conectar») |

- **Formato:**
  - Horas relativas hasta 24 h; después, «ayer 22:40» o «18 oct».
  - Dinero: «$18,40».
  - Nunca «$0» por un `null`: se escribe «—» o «sin datos».

## 15. Lo que esta UX pide y la API no da hoy

| Necesidad | Hoy | Propuesta para backend (no implementada) |
|---|---|---|
| Cuenta atrás del enfriamiento de la PC | Solo un error si se envía antes | Campo `availableAt` o `Retry-After` en el 409/429 |
| Marcar equipos críticos | No existe | Campo `critical: boolean` en `Resource` |
| Horas de cada etapa de la orden | Solo `createdAt` / `updatedAt` | `history: {state, at}[]` en `Operation` |
| Último SO usado para preseleccionar | No existe | Se puede deducir de la última orden `boot-*` en la UI |
| Revocar agentes desde la app | No existe | Fuera de alcance |
| Notificaciones push | No existe | Fuera de alcance; no mostrar como activo |

## 16. Fuera de alcance (no presentar como activo)

Chat con Hermes, terminal, notificaciones push, favoritos, control de Wi-Fi o reinicio del router, despliegues de Coolify y coste por instancia.

## 17. Cómo se verifica

- **Capturas** Playwright a 320, 390, 834 y 1440 px de cada escenario de `states/scenarios.ts`, más los nuevos (cápsula viva, hoja de SO, mantener pulsado a mitad, incierto con «Comprobar estado»).
- **Prueba en iPhone real** instalado como PWA, con 4 comprobaciones:
  - Sin franja blanca en el notch ni al rebotar.
  - Sin destello crema al abrir.
  - Gesto atrás funciona.
  - Teclado no tapa campos.
- **axe AA** en todas las rutas. Recorrido completo solo con teclado y con VoiceOver: encender la PC, apagarla y resolver una orden incierta.
- **Tests unitarios:** prioridad de la línea de estado global, matriz de fricción, umbrales de antigüedad, total de costes sin cuentas parciales.
