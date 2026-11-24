# Infra Control — exploración visual

Nueve propuestas de **Inicio móvil**, una pantalla por variante. Solicitadas por Admin el 2026-10-23 para decidir si quiere cambiar la estética. **Ninguna está aprobada ni implementada.**

Rama: `design/visual-exploration-2026-10-23`, creada desde `damballa212/whitefish` con el árbol limpio. La app y el handoff aprobado se conservan.

## Propuestas

| Variante | Imagen | Carácter |
|---|---|---|
| 01 · Carbón / cobre | [Abrir mockup](01-carbon-copper.png) | Oscuro sobrio, superficies de grafito e ilustraciones de hardware. |
| 02 · Perla / salvia | [Abrir mockup](02-pearl-sage.png) | Claro, cálido, superficies suaves y controles verdes. |
| 03 · Marfil / cobalto | [Abrir mockup](03-ivory-cobalt.png) | Editorial técnico, líneas finas, iconos dibujados y acento azul. |
| 04 · Atardecer suave | [Abrir mockup](04-dusk-atmosphere.png) | Evolución de la identidad actual: paisaje suave, ciruela y lavanda. |

## Diagnóstico y criterio

Referencias locales inspeccionadas: `scripts/public/docs/screenshots/home.png`, `design/handoff/screens/control-1440.png`, `design/handoff/HANDOFF.md` y `design/handoff/UX.md`. Las capturas son referencias guardadas; no se consultó producción. UX.md contiene propuestas históricas y no se considera una aprobación de cada interacción.

El pixel art aporta identidad, pero la repetición de bordes pesados, fuentes pixeladas y bloques ilustrados compite con los estados y controles. En la captura móvil guardada, PC y router ocupan casi todo el espacio disponible y Hermes empieza cerca de la navegación inferior.

La exploración usa tipografía más legible, jerarquía de tres niveles, router integrado a la PC y tarjetas secundarias compactas. Mantiene PC, FiberHome, Hermes, MacBook y Nube visibles en una composición. El mismo escenario simulado permite comparar el diseño sin cambiar la información.

Recomendación visual: **04** para evolucionar conservando personalidad; **02** para un cambio hacia una app doméstica clara. **01** enfatiza el carácter de consola personal y **03** ofrece la interpretación más gráfica y austera.

## Límites y revisión

- Nueve PNG de 1024×1536 generados con la herramienta integrada `imagegen`; prompts originales en [prompts.json](prompts.json) y prompt de la quinta variante en [05-prompt.txt](05-prompt.txt).
- Inspección visual de composición, etiquetas y elementos principales realizada. Son imágenes conceptuales, no capturas de una implementación.
- Datos ficticios y distintivo DEMO. «Sin alertas» no acredita salud de aplicaciones. «Reportando» no acredita acceso a Internet; «Sin agente» no implica apagado.
- Antes de implementar: ajustar la escala tipográfica a 390 px, tamaños táctiles y contraste medido; algunas etiquetas secundarias del concepto 04 necesitan más contraste. No se afirma validación responsive ni WCAG.
- La ilustración PC tiene más protagonismo que el objetivo inicial del prompt; reducirla durante una eventual implementación liberaría espacio adicional.
- «Cambiar sistema» y «Apagar» representan entradas a los flujos de confirmación existentes. Acciones habilitadas siempre dependen de Resource.actions; no se cambia la lógica energética.
- No hay cambios en frontend productivo, backend, contratos ni infraestructura. No hubo deploy ni acciones reales.

La elección final pertenece a Admin. Esta entrega no modifica los tokens ni sustituye el handoff aprobado.

## 05 · Hermes compañero — ampliación solicitada

[Abrir mockup con mascota](05-hermes-companion.png). Evolución del atardecer con Hermes como robot cerámico dorado de visor ciruela y pequeñas alas. Aparece en la cabecera y en su tarjeta, conservando los controles y el escenario ficticio. Inspeccionado visualmente; generado con imagegen usando la variante 04 como referencia. La expresión de la mascota es ilustrativa, no evidencia de salud. Galería temporal por Tailscale: http://100.64.0.10:17610/?v=5#mascota.

## 06 · Tinta / mensajero — respuesta a feedback

Admin consideró la dirección previa demasiado genérica y de IA. La recomendación de la variante 04 era criterio provisional de Codex, no aprobación humana. La nueva exploración abandona render 3D y paisaje por tipografía editorial, reglas finas, panel de PC oscuro y acento naranja. Hermes se propone como cuervo mensajero 2D; ni el personaje ni el diseño están aprobados. [Mockup](06-ink-messenger.png) · [Prompt imagegen](06-prompt.txt). Inspección visual realizada. El título todavía es muy grande y la generación introduce una ligera textura; una implementación requeriría afinar escala y superficies planas. Galería: http://100.64.0.10:17610/?v=6#tinta.

## 07 · Estudio / señal — evolución de la dirección elegida para explorar

Admin expresó que le gusta la variante 06 y pidió otra mejor. Se mantiene su lenguaje editorial y cuervo, dando más énfasis a la PC, una banda clara integrada para FiberHome y una sola mascota junto al orquestador. [Mockup](07-studio-signal.png) · [Prompt imagegen](07-prompt.txt). Imagen inspeccionada; la cabecera todavía excede la escala compacta solicitada al generador y las superficies no son perfectamente planas. No se presenta como validación de ergonomía. Aprobación de dirección exploratoria no equivale a autorización de implementación. Galería: http://100.64.0.10:17610/?v=7#estudio.

## 08 · Mineral / circuito — cambio de visión

Admin rechazó explícitamente el sprite de cuervo y pidió cambiar de camino/visión. La preferencia positiva anterior no debe tratarse como aprobación del personaje. Se propone otra dirección industrial, sin mascota, en grafito, blanco mineral y verde ácido. Eliminar la mascota es una hipótesis de esta variante, no una preferencia definitiva declarada por Admin. [Mockup](08-mineral-circuit.png) · [Prompt imagegen](08-prompt.txt). Inspeccionado visualmente. La acción Apagar PC representa abrir confirmación; este experimento cambia la jerarquía visual de acciones, no su contrato ni ejecución. Ningún cambio funcional implementado. Galería: http://100.64.0.10:17610/?v=8#mineral.

## 09 · Carbón / Atelier — evolución de la favorita explícita

Admin confirmó que sigue prefiriendo 01 · Carbón / cobre y pidió otra variante con mucha más personalidad. Esta es la dirección favorita vigente; supera las preferencias exploratorias anteriores. La nueva propuesta conserva el ambiente oscuro y cobre, añade un monograma y detalles repetidos, cabecera personal, botones más rectos y filas compactas para equipos secundarios. [Mockup](09-carbon-atelier.png) · [Prompt imagegen](09-prompt.txt). Generada usando 01 como referencia e inspeccionada visualmente. La imagen conserva más protagonismo de hardware e ilustración de servidor que el objetivo del prompt; no se afirma coincidencia exacta con él ni validación de accesibilidad. Pendiente de opinión sobre 09 y de autorización antes de implementar. Galería: http://100.64.0.10:17610/?v=9#atelier.

## Prototipo interactivo de Carbón / Atelier

Admin aclaró que necesita una maqueta navegable como un artefacto interactivo, no solo PNG. Se implementó una demo aislada HTML/CSS/JS en [atelier-live/](atelier-live/README.md), basada en 09. Acceso Tailscale: http://100.64.0.10:17611/. Selector de SO, confirmaciones, energía simulada PC/Hermes, lectura router, inventario/búsqueda, actividad, costes ficticios y reinicio. No modifica la UI productiva.

Verificado: 26 comprobaciones de interacción, tamaños 320/390/834/1440 sin desborde horizontal, cero errores JS y cero peticiones a orígenes externos. Cobertura por bytes JS V8 97,3% en el recorrido, sin afirmar cobertura de líneas/ramas. Audit raíz sin vulnerabilidades reportadas. Evidencia visual local `.local/atelier-checks/`; sin prueba física de iPhone.
