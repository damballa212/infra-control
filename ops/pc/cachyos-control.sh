#!/bin/sh
# Root-owned forced command for the dedicated infrastructure key.
set -eu
export PATH=/usr/bin:/bin
MAC=02:00:00:00:00:01
grep -qil "$MAC" /sys/class/net/*/address || exit 2
COMMAND=${1:-}
firmware_output() { efibootmgr -v 2>/dev/null; }
firmware_default() {
  output=$(efibootmgr -v 2>/dev/null) || { printf 'unknown'; return; }
  first=$(printf '%s\n' "$output" | sed -n 's/^BootOrder: *\([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\).*$/\1/p' | head -n 1 | tr 'a-f' 'A-F')
  entry=$(printf '%s\n' "$output" | awk -v wanted="Boot$first" 'substr($1,1,8)==wanted {print; exit}')
  case "$(printf '%s' "$entry" | tr 'A-Z' 'a-z')" in
    *'windows boot manager'*'bootmgfw.efi'*) [ "$first" = 0000 ] && printf 'windows' || printf 'unknown' ;;
    *cachyos*grubx64.efi*) [ "$first" = 0004 ] && printf 'cachyos' || printf 'unknown' ;;
    *) printf 'unknown' ;;
  esac
}
verify_cachyos_default() {
  [ -r /etc/default/grub ] && [ -r /boot/grub/grub.cfg ] || return 1
  configured=$(sed -n 's/^[[:space:]]*GRUB_DEFAULT="\{0,1\}\([^"#]*\)"\{0,1\}[[:space:]]*$/\1/p' /etc/default/grub | tail -n 1)
  [ "$configured" = 0 ] || return 1
  first_entry=$(awk '/^[[:space:]]*menuentry[[:space:]]/ {print; exit}' /boot/grub/grub.cfg | tr 'A-Z' 'a-z')
  case "$first_entry" in *cachyos*installer*) return 1 ;; *cachyos*) return 0 ;; *) return 1 ;; esac
}
set_boot_default() {
  target=$1
  case "$target" in windows) target_id=0000; label='windows boot manager' ;; cachyos) target_id=0004; label='cachyos' ;; *) exit 64 ;; esac
  if [ "$target" = cachyos ] && ! verify_cachyos_default; then
    printf '{"error":"grub_default_not_verified"}\n' >&2
    exit 3
  fi
  entries=$(firmware_output) || exit 3
  case "$target:$entries" in
    windows:*) printf '%s\n' "$entries" | awk -v wanted="Boot$target_id" 'substr($1,1,8)==wanted && index(tolower($0),"windows boot manager")>0 && index(tolower($0),"bootmgfw.efi")>0 {found=1} END {exit !found}' || { printf '{"error":"boot_entry_not_verified"}\n' >&2; exit 3; } ;;
    cachyos:*) printf '%s\n' "$entries" | awk -v wanted="Boot$target_id" 'substr($1,1,8)==wanted && index(tolower($0),"cachyos")>0 && index(tolower($0),"grubx64.efi")>0 && index(tolower($0),"installer")==0 {found=1} END {exit !found}' || { printf '{"error":"boot_entry_not_verified"}\n' >&2; exit 3; } ;;
  esac
  count=$(printf '%s\n' "$entries" | awk -v wanted="Boot$target_id" -v label="$label" 'substr($1,1,8)==wanted && index(tolower($0),label)>0 {count++} END {print count+0}')
  [ "$count" -eq 1 ] || { printf '{"error":"boot_entry_not_verified"}\n' >&2; exit 3; }
  old_order=$(printf '%s\n' "$entries" | sed -n 's/^BootOrder: *//p' | head -n 1 | tr 'a-f' 'A-F')
  old_next=$(printf '%s\n' "$entries" | sed -n 's/^BootNext: *//p' | head -n 1 | tr 'a-f' 'A-F')
  case "$old_order" in ''|*[!0-9A-F,]*) printf '{"error":"boot_order_not_verified"}\n' >&2; exit 3 ;; esac
  case "$old_next" in ''|[0-9A-F][0-9A-F][0-9A-F][0-9A-F]) ;; *) printf '{"error":"boot_next_not_verified"}\n' >&2; exit 3 ;; esac
  found=no
  remaining=''
  old_ifs=$IFS; IFS=,
  for entry in $old_order; do
    [ ${#entry} -eq 4 ] || { IFS=$old_ifs; exit 3; }
    if [ "$entry" = "$target_id" ]; then found=yes; else remaining=${remaining:+$remaining,}$entry; fi
  done
  IFS=$old_ifs
  [ "$found" = yes ] || { printf '{"error":"boot_entry_not_in_order"}\n' >&2; exit 3; }
  new_order=$target_id${remaining:+,$remaining}
  if [ "$old_order" = "$new_order" ]; then
    effective=$(firmware_default)
    [ "$effective" = "$target" ] || { printf '{"error":"boot_default_readback_failed"}\n' >&2; exit 5; }
    printf '{"accepted":true,"applied":true,"defaultSystem":"%s","verified":true}\n' "$effective"
    return
  fi
  mkdir -p /var/lib/infra-control || exit 4
  chmod 700 /var/lib/infra-control || exit 4
  umask 077
  backup_tmp=/var/lib/infra-control/boot-default.$$
  printf '%s\n%s\n' "$old_order" "$old_next" > "$backup_tmp" || exit 4
  mv -f "$backup_tmp" /var/lib/infra-control/boot-default.previous || exit 4
  restore_order() {
    efibootmgr -o "$old_order" >/dev/null 2>&1 || return 1
  }
  efibootmgr -o "$new_order" >/dev/null 2>&1 || { restore_order; printf '{"error":"boot_order_write_failed"}\n' >&2; exit 5; }
  verified=$(efibootmgr 2>/dev/null) || { restore_order; printf '{"error":"boot_order_readback_failed"}\n' >&2; exit 5; }
  actual=$(printf '%s\n' "$verified" | sed -n 's/^BootOrder: *//p' | head -n 1 | tr 'a-f' 'A-F')
  actual_next=$(printf '%s\n' "$verified" | sed -n 's/^BootNext: *//p' | head -n 1 | tr 'a-f' 'A-F')
  effective=$(firmware_default)
  if [ "$actual" != "$new_order" ] || [ "$actual_next" != "$old_next" ] || [ "$effective" != "$target" ]; then
    restore_order || printf '{"error":"boot_order_rollback_failed"}\n' >&2
    printf '{"error":"boot_order_or_boot_next_verification_failed"}\n' >&2
    exit 5
  fi
  printf '{"accepted":true,"applied":true,"defaultSystem":"%s","verified":true}\n' "$effective"
}
case "$COMMAND" in
 status)
  printf '{"os":"cachyos","bootId":"%s","mac":"%s","defaultSystem":"%s"}\n' "$(cat /proc/sys/kernel/random/boot_id)" "$MAC" "$(firmware_default)" ;;
 off|windows|cachyos)
  case "$COMMAND" in
   windows) efibootmgr -v | grep -q '^Boot0000.*Windows Boot Manager' || exit 3; efibootmgr -n 0000 >/dev/null; mode=reboot ;;
   cachyos) efibootmgr -v | grep -q '^Boot0004.*cachyos' || exit 3; efibootmgr -n 0004 >/dev/null; mode=reboot ;;
   off) mode=poweroff ;;
  esac
  systemd-run --quiet --unit="infra-control-power-$(date +%s)" --on-active=3s /usr/local/sbin/infra-control-pc-power "$mode"
  printf '{"accepted":true}\n' ;;
 default-windows) set_boot_default windows ;;
 default-cachyos) set_boot_default cachyos ;;
 *) exit 64 ;;
esac
