#!/bin/sh
# Fixed read-only stream; no CWMP tasks, WAN edits, SSH listeners or file logging.
export PATH=/usr/bin:/bin:/fhrom/bin
export LD_LIBRARY_PATH=/lib:/fhrom/lib
umask 077
LOCK=/var/infra-control-telemetry.lock
PID="$LOCK/pid"

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -s "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    printf '{"error":"telemetry_already_running"}\n' >&2
    exit 1
  fi
  rm -f "$PID"
  rmdir "$LOCK" 2>/dev/null || exit 1
  mkdir "$LOCK" || exit 1
fi
echo $$ > "$PID"
cleanup() { rm -f "$PID"; rmdir "$LOCK" 2>/dev/null; }
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

if [ ! -r /proc/sys/kernel/random/boot_id ] || [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ] || [ ! -r /proc/uptime ]; then
  printf '{"error":"proc_telemetry_unavailable"}\n' >&2
  exit 1
fi
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id | tr -cd 'a-fA-F0-9:-')
boot_id_length=${#BOOT_ID}
case "$BOOT_ID" in *[!a-fA-F0-9:-]*|'') printf '{"error":"boot_id_unavailable"}\n' >&2; exit 1 ;; esac
[ "$boot_id_length" -ge 8 ] && [ "$boot_id_length" -le 100 ] || { printf '{"error":"boot_id_unavailable"}\n' >&2; exit 1; }

cpu_counters() {
  # /proc/stat's guest fields are already included in user/nice; omit them.
  awk '$1 == "cpu" { total=0; for (i=2; i<=9 && i<=NF; i++) total += $i; idle=$5+$6; printf "%.0f %.0f\n", total, idle; exit }' /proc/stat
}
memory_bytes() {
  awk '
    /^MemTotal:/ { total=$2*1024 }
    /^MemAvailable:/ { available=$2*1024 }
    /^MemFree:/ { free=$2*1024 }
    /^Buffers:/ { buffers=$2*1024 }
    /^Cached:/ { cached=$2*1024 }
    END {
      if (available == 0) available=free+buffers+cached
      if (available > total) available=total
      printf "%.0f %.0f\n", total, available
    }
  ' /proc/meminfo
}
read_cpu_counters() {
  set -- $(cpu_counters)
  current_total=$1
  current_idle=$2
}
cpu_percent() {
  read_cpu_counters
  awk -v old_total="$previous_total" -v old_idle="$previous_idle" \
      -v new_total="$current_total" -v new_idle="$current_idle" \
      'BEGIN { total=new_total-old_total; idle=new_idle-old_idle; if (total <= 0) { print 0; exit } value=(total-idle)*100/total; if (value < 0) value=0; if (value > 100) value=100; printf "%.0f", value }'
  previous_total=$current_total
  previous_idle=$current_idle
}

read_cpu_counters
previous_total=$current_total
previous_idle=$current_idle
set -- $(memory_bytes)
total_memory=$1
available_memory=$2
printf '{"version":1,"bootId":"%s","uptimeSeconds":%s,"cpuPercent":null,"memTotalBytes":%s,"memAvailableBytes":%s}\n' \
  "$BOOT_ID" "$(awk '{printf "%.0f", $1}' /proc/uptime)" "$total_memory" "$available_memory"

while :; do
  sleep 15 || exit 0
  cpu=$(cpu_percent)
  set -- $(memory_bytes)
  total_memory=$1
  available_memory=$2
  printf '{"version":1,"bootId":"%s","uptimeSeconds":%s,"cpuPercent":%s,"memTotalBytes":%s,"memAvailableBytes":%s}\n' \
    "$BOOT_ID" "$(awk '{printf "%.0f", $1}' /proc/uptime)" "$cpu" "$total_memory" "$available_memory" || exit 0
done
