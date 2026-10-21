#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SWIFTC=$(command -v swiftc || true)
PYTHON3=$(command -v python3 || true)
[ -n "$SWIFTC" ] && [ -x "$SWIFTC" ] || { echo 'swiftc no está instalado; no se modificó el reporter activo.' >&2; exit 1; }
[ -n "$PYTHON3" ] && [ -x "$PYTHON3" ] || { echo 'python3 no está instalado; no se modificó el reporter activo.' >&2; exit 1; }

INSTALL_DIR="$HOME/.local/share/infra-control"
CONFIG_DIR="$HOME/.config/infra-control"
AGENT_DIR="$HOME/Library/LaunchAgents"
TOKEN_FILE="$CONFIG_DIR/mac-report-token"
LABEL='com.infra-control.mac-reporter'
PLIST="$AGENT_DIR/$LABEL.plist"
UID_VALUE=$(id -u)

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$AGENT_DIR"
chmod 700 "$INSTALL_DIR" "$CONFIG_DIR"
[ -s "$TOKEN_FILE" ] || { echo "Falta el token privado $TOKEN_FILE; no se modificó el reporter activo." >&2; exit 1; }
[ ! -L "$TOKEN_FILE" ] || { echo 'El token no puede ser un enlace simbólico; no se modificó el reporter activo.' >&2; exit 1; }
TOKEN_OWNER=$(stat -f '%u' "$TOKEN_FILE")
[ "$TOKEN_OWNER" = "$UID_VALUE" ] || { echo 'El token no pertenece a este usuario; no se modificó el reporter activo.' >&2; exit 1; }
chmod 600 "$TOKEN_FILE"

TEMP_DIR=$(mktemp -d "$INSTALL_DIR/.mac-reporter-install.XXXXXX")
STAGED_PLIST=$(mktemp "$AGENT_DIR/.com.infra-control.mac-reporter.XXXXXX")
BUILD_ID=$(date '+%Y%m%d%H%M%S')-$$
BINARY_PATH="$INSTALL_DIR/mac-reporter-$BUILD_ID"
trap 'rm -rf "$TEMP_DIR"; rm -f "$STAGED_PLIST"' EXIT HUP INT TERM

# Compile and validate everything before touching the currently loaded LaunchAgent.
"$SWIFTC" -O -framework AppKit -o "$TEMP_DIR/mac-reporter" "$SOURCE_DIR/reporter.swift"
chmod 700 "$TEMP_DIR/mac-reporter"
"$TEMP_DIR/mac-reporter" --self-test >/dev/null
"$TEMP_DIR/mac-reporter" --check-config >/dev/null
mv "$TEMP_DIR/mac-reporter" "$BINARY_PATH"

"$PYTHON3" - "$STAGED_PLIST" "$BINARY_PATH" <<'PY'
import plistlib
import sys

path, binary = sys.argv[1:]
with open(path, 'wb') as stream:
    plistlib.dump({
        'Label': 'com.infra-control.mac-reporter',
        'ProgramArguments': [binary],
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 10,
        'ProcessType': 'Background',
        'StandardOutPath': '/dev/null',
        'StandardErrorPath': '/dev/null',
    }, stream, fmt=plistlib.FMT_XML, sort_keys=True)
PY
chmod 600 "$STAGED_PLIST"
plutil -lint "$STAGED_PLIST" >/dev/null

HAD_OLD_PLIST=false
if [ -f "$PLIST" ]; then
  cp "$PLIST" "$TEMP_DIR/previous.plist"
  HAD_OLD_PLIST=true
fi

launchctl bootout "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true
mv "$STAGED_PLIST" "$PLIST"
if ! launchctl bootstrap "gui/$UID_VALUE" "$PLIST"; then
  launchctl bootout "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true
  if [ "$HAD_OLD_PLIST" = true ]; then
    cp "$TEMP_DIR/previous.plist" "$PLIST"
    chmod 600 "$PLIST"
    launchctl bootstrap "gui/$UID_VALUE" "$PLIST" >/dev/null 2>&1 || true
  else
    rm -f "$PLIST"
  fi
  rm -f "$BINARY_PATH"
  echo 'No se pudo cargar el reporter nuevo; se restauró la configuración anterior.' >&2
  exit 1
fi

# Keep the current binary and remove superseded native builds after the new job loads.
for old_binary in "$INSTALL_DIR"/mac-reporter-*; do
  [ -f "$old_binary" ] || continue
  [ "$old_binary" = "$BINARY_PATH" ] || rm -f "$old_binary"
done
echo 'Reporter nativo instalado. Envía presencia y avisos best-effort de reposo/despertar; no acepta órdenes ni despierta el Mac.'
