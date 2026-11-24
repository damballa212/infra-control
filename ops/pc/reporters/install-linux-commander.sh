#!/bin/sh
# Instala (o retira) el agente de órdenes de la PC en CachyOS. Ejecutar como root, desde esta carpeta:
#   sudo sh install-linux-commander.sh [--check] [--caps ping|ping,power] [--remove]
# Por defecto solo declara "ping" (mide la latencia sin ejecutar nada). No toca el reporter, GRUB ni el firmware.
set -eu
MAC='02:00:00:00:00:01'
DEST=/usr/local/lib/infra-control/commander.py
UNIT=/etc/systemd/system/infra-control-commander.service
CAPS_FILE=/etc/infra-control-commander.json
here=$(cd "$(dirname "$0")" && pwd)
mode=install; caps=
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check ;;
    --remove) mode=remove ;;
    --caps) shift; caps="$1" ;;
    *) echo "Opción desconocida: $1" >&2; exit 64 ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { echo 'ERROR: ejecuta como root (sudo).' >&2; exit 1; }
ip link | grep -qi "$MAC" || { echo 'ERROR: esta no es la PC de Infra Control (MAC distinta). No se instaló nada.' >&2; exit 1; }
if [ "$mode" = remove ]; then
  systemctl disable --now infra-control-commander.service 2>/dev/null || true
  rm -f "$UNIT" "$DEST"; systemctl daemon-reload
  echo 'Agente retirado. /etc/infra-control-commander.json se conserva.'; exit 0
fi
for f in linux-commander.py infra-control-commander.service; do [ -f "$here/$f" ] || { echo "ERROR: falta $f junto al instalador." >&2; exit 1; }; done
[ -f /etc/infra-control-reporter.json ] || { echo 'ERROR: falta /etc/infra-control-reporter.json (reporter no instalado).' >&2; exit 1; }
[ -x /usr/local/sbin/infra-control-pc ] || { echo 'ERROR: falta el helper /usr/local/sbin/infra-control-pc.' >&2; exit 1; }
python3 -m py_compile "$here/linux-commander.py" || { echo 'ERROR: el agente tiene errores de sintaxis.' >&2; exit 1; }
case "$caps" in ''|ping|ping,power) ;; *) echo 'ERROR: --caps solo admite ping o ping,power.' >&2; exit 64 ;; esac
[ "$mode" = check ] && { echo 'Todo listo para instalar (no se cambió nada).'; exit 0; }
install -d -m 0755 /usr/local/lib/infra-control
install -m 0755 -o root -g root "$here/linux-commander.py" "$DEST"
install -m 0644 -o root -g root "$here/infra-control-commander.service" "$UNIT"
if [ -n "$caps" ] || [ ! -f "$CAPS_FILE" ]; then
  chosen=${caps:-ping}; json=''; old_ifs=$IFS; IFS=,
  for cap in $chosen; do json="$json${json:+, }\"$cap\""; done
  IFS=$old_ifs
  printf '{"caps": [%s]}\n' "$json" > "$CAPS_FILE"
  chmod 0644 "$CAPS_FILE"
fi
echo "capacidades: $(cat "$CAPS_FILE")"
systemctl daemon-reload
systemctl enable --now infra-control-commander.service
sleep 6
systemctl is-active --quiet infra-control-commander.service || { echo 'ERROR: el servicio no quedó activo. Retíralo con --remove y revisa journalctl.' >&2; exit 1; }
echo 'Listo. Agente en ejecución; el panel debería verlo conectado en unos segundos.'
