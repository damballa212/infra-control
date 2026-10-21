#!/bin/sh
# Launched by the authenticated ACS after BOOT; never changes WAN or Wi-Fi.
export PATH=/usr/bin:/bin:/fhrom/bin
export LD_LIBRARY_PATH=/lib:/fhrom/lib
export HOME=/var
ROOT=/fhconf/infra-control
LOCK=/var/infra-control-start.lock
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
umask 077
mkdir -p /var/.ssh
chmod 700 /var/.ssh
ln -sf "$ROOT/authorized_keys" /var/.ssh/authorized_keys
ln -sf "$ROOT/known_hosts" /var/.ssh/known_hosts
if [ ! -s /var/infra-control-dropbear.pid ] || ! kill -0 "$(cat /var/infra-control-dropbear.pid)" 2>/dev/null; then
  /fhrom/bin/dropbear -p 127.0.0.1:2222 -r "$ROOT/router-host-key" \
    -P /var/infra-control-dropbear.pid -s -j -k -m -K 30 -I 300 \
    >> /var/infra-control-sshd.log 2>&1 || exit 1
fi
nohup /bin/sh "$ROOT/tunnel.sh" </dev/null >> /var/infra-tunnel-supervisor.log 2>&1 &
printf 'ready\n' > /var/infra-control-started
