#!/bin/sh
# Persistent files; launch must be wired to a verified boot hook separately.
export PATH=/usr/bin:/bin:/fhrom/bin
export LD_LIBRARY_PATH=/lib:/fhrom/lib
export HOME=/var
ROOT=/fhconf/infra-control
LOCK=/var/infra-control-tunnel.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then exit 0; fi
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || exit 1
  mkdir "$LOCK" || exit 1
fi
echo $$ > "$LOCK/pid"
trap 'rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null' EXIT
mkdir -p /var/.ssh
chmod 700 /var/.ssh
ln -sf "$ROOT/authorized_keys" /var/.ssh/authorized_keys
ln -sf "$ROOT/known_hosts" /var/.ssh/known_hosts
while :; do
  /fhrom/bin/dbclient -i "$ROOT/tunnel-key" -N -K 0 -I 0 \
    -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:17722:127.0.0.1:2222 \
    -R 127.0.0.1:17723:192.168.1.10:22 \
    fiberhome-tunnel@203.0.113.10 &
  client=$!
  # Vendor -K is broken; bound transport lifetime even after a WAN blackhole.
  (sleep 300; kill "$client" 2>/dev/null) &
  watchdog=$!
  wait "$client"
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  sleep 5
done
