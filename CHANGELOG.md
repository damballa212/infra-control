# Changelog

Versión única en `package.json`. Cada relevo productivo lleva un tag `panel-x.y.z`
(la imagen desplegada es `infra-control:panel-x.y.z-<sha>`; el procedimiento está en `ops/vps/README.md`).
Antes de crear un tag se confirma en el VPS qué imagen sirve producción (`docker ps`); el tag apunta al `<sha>` de la imagen.

## [Sin publicar]
### Añadido
- CI en GitHub Actions solo en `pull_request` (backend, UI, E2E bajo demanda), Dependabot mensual, Oxlint y Prettier, `ops/vps/deploy-api.sh`, guía de monitor externo, medición de minutos de Actions (#242).

## [0.16.4] — 2026-11-24 · `panel-0.16.4-1b38a5d` (en producción)
- Claves rápidas para agentes (#248): conector `bw serve`, sincronización perezosa del índice y de escritura, sondeo cada 1,5 s.

## [0.16.0 – 0.16.3] — 2026-11-24
- Relevos consecutivos de #248 (ver `ops/vps/README.md`).

## [0.15.0] — 2026-11-24 · `panel-0.15.0-103c818`
- Entrega automática desde la bóveda (#258).

## [0.11.0] — 2026-11-13 · `panel-0.11.0-b9dd186`
- Ciclo operativo, revisión durable y paginación real (#230, PR #231).

## [0.10.1] — 2026-11-12 · `panel-0.10.1-e7aafe4`
- Jerarquía de avisos y espacios del shell (PR #229).

## [0.9.x] — 2026-11-11
- Bóveda de secretos, aviso push de solicitudes y retiro del piloto de credenciales (#204, #200).

## Anteriores (0.5 – 0.8)
Detalle en `ops/vps/README.md` y en el historial de Git; no se etiquetan retroactivamente.
