# Incorporación de Betza a Hermes

`betza.py` es una migración de una sola ejecución para el estado verificado de Betza en EC2. No es un instalador general: fija origen, commit, destino y diez sesiones esperadas; rechaza cambios en esas precondiciones.

## Contrato

- Clona Git local sin hardlinks y conserva exactamente archivos tracked/untracked no ignorados, permisos y cambios pendientes. El destino tiene `.git` independiente y origin GitHub; añade el marcador de memoria damballa212/vault-betza-citas.
- No copia `.local`, credenciales, dependencias ni archivos ignorados; permanecen en su ubicación original. No mueve ni arranca aplicaciones, portales, agentes o servicios.
- Prepara una proyección nativa de Codex en un SQLite aislado: texto usuario/asistente y marcadores de herramientas que admite el parser Hermes, con redacción nativa. Las trazas completas, adjuntos y datos originales siguen en sus archivos originales; no se publican.
- Vincula el manifiesto a hashes de fuentes, exportaciones nativas completas e inventario exacto del workspace preparado, incluido el marcador. Apply vuelve a comprobar todo antes de publicar.
- La importación de las diez sesiones es una transacción nativa `SessionDB.import_sessions` y no cambia sesiones existentes de Desarrollo. El rename del directorio y SQLite NO forman una transacción conjunta; un fallo entre ambos exige reconciliación manual, sin borrar pruebas ni sobrescribir trabajo.
- Exige cgroup v2: MemoryMax<=384MiB, MemorySwapMax=0, CPUQuota<=50%. No usar fuera de ese presupuesto ni reejecutar contra un destino existente.

## Ejecución

Código y evidencia se mantienen privados. Preparar en `~/Backups/betza-hermes-<fecha>` con un transient unit del usuario, sin política de reinicio. Stage informa el SHA256 de manifest.json. Apply exige ese hash exacto con `--expected-manifest`; ningún cambio de hash es autorización para repetir una operación ambigua.

Registrar después el directorio mediante `projects.create` nativo, perfil dev-hub, `use=false`; no crear otro bot ni cambiar el proyecto activo del usuario. Organizar los títulos y archivos mediante PATCH nativo de sesiones, no por SQL improvisado: una conversación activa y las anteriores archivadas. Las conversaciones archivadas conservan sus mensajes. Guardar las respuestas operativas en el respaldo privado.

Pruebas offline: `python3 -B -W error::ResourceWarning -m unittest discover -s ops/hermes/migrations -q`.

## Resultado verificado — 9 de noviembre de 2026

- Workspace independiente: `/home/ubuntu/projects/hermes-workspaces/citas-betza`, rama axolotl, commit 836216b. 326 archivos fuente comprobados, incluidos los 29 elementos de estado Git sin commit; originales intactos.
- 10 conversaciones, 284 mensajes importados y comparados con la proyección nativa preparada. No se reconstruyen costes/tokens históricos; sus ceros importados no acreditan gratuidad del trabajo original.
- Proyecto nativo **Betza — Citas**, id p_f9a3591f, en Desarrollo. Una sesión activa, **Betza — Desarrollo**; 9 anteriores archivadas para evitar llenar la lista. Árbol nativo comprobado con sessionCount=1.
- Preparación: 7 segundos, 197,1 MiB de pico, 0 swap. Apply verificado, sin reinicios ni cambios a otros agentes.8 pruebas y revisión independiente aprobadas tras corregir la integridad del staging.
- Respaldo privado: `~/Backups/betza-hermes-20261109/`: manifiesto, SQLite preparado, organización y títulos posteriores. No versionar esos datos.
- El marcador de memoria quedó configurado; la comprobación MCP desde la Mac seguía inaccesible con su VPN apagada. No afirmar una validación de recuperación de memoria por esta operación.

Los nueve chats se importaron inicialmente visibles; por la corrección expresa de Admin se archivaron a través de la API nativa. El manifiesto verifica la importación inicial; session-titles.json y session-organization.json registran esos cambios de presentación posteriores. No se borró ni resumió el contenido original para obtener la vista limpia.

Después de verificar la copia se ajustó únicamente la instrucción antigua de seguimiento en el AGENTS.md del destino: GitHub Issues del repositorio del producto; Linear queda como archivo. El original de esa instrucción y los hashes del cambio están en el respaldo privado (workspace-adjustments.json). El worktree fuente de ORCA no se modifica.
