#!/bin/sh
set -eu
case "${1:-}" in poweroff) event=poweroff;; reboot) event=reboot;; *)exit 64;; esac
# If shutdown is inhibited, restore reports during this same boot.
systemd-run --quiet --unit="infra-control-reporter-resume-$(date +%s)" --on-active=40s /usr/bin/systemctl start infra-control-reporter.service
# Stop heartbeats before announcing the actual power transition.
systemctl stop infra-control-reporter.service 2>/dev/null || true
/usr/bin/python3 /usr/local/lib/infra-control/reporter.py --once "$event" 2>/dev/null || true
systemctl "$1" || { systemctl start infra-control-reporter.service; exit 1; }
