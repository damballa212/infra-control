#!/usr/bin/env python3
"""Small outbound-only macOS presence reporter. It never accepts remote commands."""
import json
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.request

ENDPOINT = 'https://panel.example.com/api/mac/events'
TOKEN_FILE = '~/.config/infra-control/mac-report-token'
HEARTBEAT_SECONDS = 15
MAX_SEQUENCE = 2_147_483_647


def current_boot_id(sysctl_output):
    match = re.search(r'\bsec\s*=\s*(\d+)', sysctl_output)
    if not match:
        raise ValueError('macOS boot time unavailable')
    return 'mac-' + match.group(1)


def sequence_from_uptime(monotonic_seconds):
    return min(max(1, int(monotonic_seconds)), MAX_SEQUENCE)


def remaining_delay(started_at, interval=HEARTBEAT_SECONDS, now=None):
    clock = now or time.monotonic
    return max(0, interval - (clock() - started_at))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def send_event(token, boot_id, sequence, event, opener=None):
    if not token or len(token) < 32 or len(token) > 512:
        raise ValueError('invalid report token')
    body = json.dumps({'bootId': boot_id, 'sequence': sequence, 'event': event}, separators=(',', ':')).encode()
    request = urllib.request.Request(
        ENDPOINT, data=body, method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    )
    client = opener or urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )
    try:
        with client.open(request, timeout=5) as response:
            return response.status == 204
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def load_token():
    from pathlib import Path
    token = Path(TOKEN_FILE).expanduser().read_text(encoding='utf-8').strip()
    if len(token) < 32 or len(token) > 512:
        raise ValueError('invalid report token')
    return token


def main():
    token = load_token()
    boot_output = subprocess.run(
        ['/usr/sbin/sysctl', '-n', 'kern.boottime'],
        check=True, capture_output=True, text=True, timeout=3
    ).stdout
    boot_id = current_boot_id(boot_output)
    first = True
    while True:
        started = time.monotonic()
        sequence = sequence_from_uptime(time.monotonic())
        send_event(token, boot_id, sequence, 'online' if first else 'heartbeat')
        first = False
        time.sleep(remaining_delay(started))


if __name__ == '__main__':
    main()
