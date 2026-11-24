#!/usr/bin/env python3
"""Outbound-only systemd health reporter; it never reads Hermes conversations."""
import json
import os
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ENDPOINT = 'https://panel.example.com/api/hermes/events'
HEARTBEAT_SECONDS = 15
MAX_SEQUENCE = 2_147_483_647
UNIT_PATTERN = re.compile(r'^[A-Za-z0-9_.@:-]{1,120}\.service$')
BOOT_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
IDENTIFIER_PATTERN = re.compile(r'^[A-Za-z0-9:._+-]{8,100}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def valid_unit(unit):
    return isinstance(unit, str) and UNIT_PATTERN.fullmatch(unit) is not None


def current_boot_id(path='/proc/sys/kernel/random/boot_id'):
    with open(path, 'r', encoding='ascii') as source:
        value = source.read(128).strip().lower()
    if not BOOT_PATTERN.fullmatch(value):
        raise ValueError('Linux boot identity unavailable')
    return 'ec2-' + value


def read_service_state(unit, runner=subprocess.run):
    if not valid_unit(unit):
        raise ValueError('invalid systemd unit')
    result = runner(
        ['/usr/bin/systemctl', '--user', 'show', unit, '--property=ActiveState', '--property=NRestarts'],
        check=True, capture_output=True, text=True, timeout=3
    )
    properties = {}
    for line in result.stdout.splitlines():
        name, separator, value = line.partition('=')
        if separator:
            properties[name.strip()] = value.strip()
    active_state = properties.get('ActiveState', '').lower()
    service_state = active_state if active_state in ('active', 'inactive', 'failed') else 'unknown'
    try:
        restarts = int(properties.get('NRestarts', '0'))
    except ValueError:
        restarts = 0
    if not 0 <= restarts <= MAX_SEQUENCE:
        restarts = 0
    return service_state, restarts


def load_token(directory=None):
    credentials = directory or os.environ.get('CREDENTIALS_DIRECTORY', '')
    if not credentials:
        raise ValueError('systemd credential directory unavailable')
    with open(os.path.join(credentials, 'report-token'), 'r', encoding='ascii') as source:
        token = source.read(513).strip()
    if not 32 <= len(token) <= 512 or any(character.isspace() for character in token):
        raise ValueError('invalid reporter credential')
    return token


def send_event(token, boot_id, stream_id, sequence, service_state, restart_count, opener=None, endpoint=ENDPOINT):
    if not token or len(token) > 512 or not isinstance(boot_id, str) or not boot_id.startswith('ec2-') or not BOOT_PATTERN.fullmatch(boot_id[4:]):
        raise ValueError('invalid report identity')
    if not isinstance(stream_id, str) or not IDENTIFIER_PATTERN.fullmatch(stream_id) or not 1 <= sequence <= MAX_SEQUENCE:
        raise ValueError('invalid report sequence')
    if service_state not in ('active', 'inactive', 'failed', 'unknown') or not 0 <= restart_count <= MAX_SEQUENCE:
        raise ValueError('invalid report state')
    body = json.dumps({
        'version': 1, 'bootId': boot_id, 'streamId': stream_id, 'sequence': sequence,
        'serviceState': service_state, 'restartCount': restart_count
    }, separators=(',', ':')).encode('ascii')
    request = urllib.request.Request(
        endpoint, data=body, method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    )
    client = opener or urllib.request.build_opener(
        NoRedirect(), urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )
    try:
        with client.open(request, timeout=5) as response:
            return response.status == 204
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def main():
    unit = os.environ.get('HERMES_UNIT', '')
    if not valid_unit(unit):
        raise ValueError('HERMES_UNIT must name the verified systemd service')
    token = load_token()
    boot_id = current_boot_id()
    stream_id = 'reporter-' + uuid.uuid4().hex
    sequence = 0
    while True:
        started = time.monotonic()
        sequence = min(sequence + 1, MAX_SEQUENCE)
        try:
            service_state, restart_count = read_service_state(unit)
        except (OSError, subprocess.SubprocessError):
            service_state, restart_count = 'unknown', 0
        send_event(token, boot_id, stream_id, sequence, service_state, restart_count)
        time.sleep(max(0, HEARTBEAT_SECONDS - (time.monotonic() - started)))


if __name__ == '__main__':
    main()
