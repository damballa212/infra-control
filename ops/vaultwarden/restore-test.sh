#!/usr/bin/env bash
# Restauración de prueba de un backup cifrado en un contenedor desechable (loopback, puerto 18222).
# Requiere la clave PRIVADA en el llavero gpg de quien lo ejecuta. No toca el Vaultwarden real.
# Uso: restore-test.sh vw-YYYYMMDDTHHMMSSZ.tar.gz.gpg
set -euo pipefail
umask 077
FILE=${1:?uso: restore-test.sh <backup.tar.gz.gpg>}
IMAGE=${VW_IMAGE:-vaultwarden/server:1.37.5}
NAME=vw-restore-test
work=$(mktemp -d)
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

gpg --batch --quiet --decrypt "$FILE" | tar -xz -C "$work"
docker run -d --name "$NAME" --user "$(id -u):$(id -g)" -p 127.0.0.1:18222:8080 \
  -e ROCKET_PORT=8080 -e DOMAIN=https://restore.invalid -e SIGNUPS_ALLOWED=false -v "$work":/data "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:18222/alive >/dev/null 2>&1 && break
  sleep 1
done
curl -fs http://127.0.0.1:18222/alive >/dev/null || { echo "FALLO: el contenedor restaurado no responde"; docker logs "$NAME" 2>&1 | tail -5; exit 1; }
python3 - "$work/db.sqlite3" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
users, orgs, ciphers = (db.execute(f"select count(*) from {t}").fetchone()[0] for t in ("users", "organizations", "ciphers"))
print(f"restauración OK: {users} usuarios, {orgs} organizaciones, {ciphers} ítems cifrados")
PY
