# Minutos de GitHub Actions (medidos)

Plan: repositorio privado en plan gratuito → 2 000 min/mes en runners Linux (GitHub redondea cada job hacia arriba al minuto).

## Medición (2026-11-24, PR #267 y prueba #268)
| Ejecución | Job backend | Job UI | Facturado (redondeado) |
|---|---|---|---|
| PR #267, 1.ª (UI en rojo por dependencias) | 57 s | 53 s | 2 min |
| PR #267, 2.ª (todo verde) | 51 s | 62 s | 2 min |
| PR #268 (fallo deliberado, backend rojo) | 43 s | 55 s | 2 min |

- Ejecución normal: **~2 min facturados** (backend y UI en paralelo, caché npm activo). Mucho menos que los 8–10 min estimados en #242.
- Con ~40 pushes a PR al mes: ~80 min (≈4 % del cupo). E2E no se incluye: solo con label `e2e` o manual.
- Sin cron, sin `push` a ramas, `concurrency` cancela ejecuciones obsoletas, el E2E vive en su propio workflow, así que etiquetar un PR no cancela la CI normal.
- Revisar el consumo real mensual en GitHub → Settings → Billing → Usage (la API pública no lo expone para esta cuenta).

## E2E (medido el 2026-11-24, run manual 45497835772 sobre `feat/control-panel`)
- Job `e2e`: 87 s (build UI + Chromium + 35 tests Playwright) → **2 min facturados**; con backend y UI, ~4 min la ejecución completa.
- Resultado: 34 de 35 pasan; falla una comprobación axe (#271). El CI hizo su trabajo: detectó algo que el E2E local no mostraba.
- Dependabot: sus ejecuciones «dynamic» (npm, UI, Actions, Docker) también cuentan y abren PR con CI; con límite 3 PR por ecosistema y frecuencia mensual el peor caso son ~10 PR/mes ≈ 20 min.
