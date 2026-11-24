#!/usr/bin/env bash
# Relevo del servicio api con la compuerta SIEMPRE cerrada y liberada.
# Uso (en el VPS, tras construir y validar la imagen local):
#   ops/vps/deploy-api.sh <proyecto-compose> <ruta-docker-compose.yml>
# No toca Coolify ni otros servicios: solo `up -d --no-deps api`.
# Sigue siendo un procedimiento explícito: un redeploy desde la UI de Coolify no pasa por aquí (ver #242).
set -euo pipefail

project="${1:?proyecto compose (etiqueta com.docker.compose.project del contenedor api)}"
compose="${2:?ruta del docker-compose.yml generado}"
gate="${GATE:-/opt/infra-control/current/ops/vps/deployment-gate.py}"

out="$(python3 "$gate" enter)" || { echo "Compuerta rechazada: hay una orden activa. No se toca nada." >&2; exit 1; }
owner="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["owner"])')"
echo "Compuerta cerrada (owner=$owner). Backup indicado en: $out"

ok=0
trap 'if [ "$ok" = 1 ]; then python3 "$gate" release --owner "$owner"; else echo "Relevo incompleto: la compuerta sigue cerrada (vence sola). Inspecciona el servicio y las órdenes antes de liberar con: python3 $gate release --owner $owner" >&2; fi' EXIT

docker compose -p "$project" -f "$compose" up -d --no-deps api

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:17600/health/ready >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { echo "El panel no quedó listo en 60 s." >&2; exit 1; }
echo "Panel listo. Libera la compuerta tras comprobar login/SSE/datos (se libera al salir)."
