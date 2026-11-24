#!/usr/bin/env bash
# Instala infra-secrets para el usuario actual (macOS/Linux) y prepara este equipo.
# Uso: install.sh "Nombre del equipo" [URL-del-panel]
# Imprime el hash del token (el token no sale del equipo) para registrarlo en el panel.
set -euo pipefail
MACHINE=${1:?uso: install.sh "Nombre del equipo" [URL]}
URL=${2:-https://panel.example.com}
SRC=$(cd "$(dirname "$0")" && pwd)
DEST=${XDG_DATA_HOME:-$HOME/.local/share}/infra-secrets
BIN=$HOME/.local/bin
mkdir -p "$DEST" "$BIN"
cp "$SRC/envfile.py" "$SRC/infra_secrets.py" "$DEST/"
chmod 0644 "$DEST/envfile.py" "$DEST/infra_secrets.py"
cat > "$BIN/infra-secrets" <<SHIM
#!/bin/sh
exec python3 -I "$DEST/infra_secrets.py" "\$@"
SHIM
chmod 0755 "$BIN/infra-secrets"
"$BIN/infra-secrets" setup --machine "$MACHINE" --url "$URL"
