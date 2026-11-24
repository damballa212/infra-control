#!/usr/bin/env python3
"""Outbound authenticated status; no inbound listener or remote execution."""
import argparse
import fcntl
import json
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request

CONFIG = '/etc/infra-control-reporter.json'
STATE = '/var/lib/infra-control-report/sequence.json'
HEARTBEAT_SECONDS = 10


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def previous_state():
    exists = False
    for path in (STATE, STATE + '.backup'):
        try:
            with open(path) as source:
                exists = True
                value = json.load(source)
            if not isinstance(value, dict) or not isinstance(value.get('sequence'), int) or value['sequence'] < 1:
                raise ValueError('Invalid sequence')
            # The backup can precede the last published sequence by one.
            if path.endswith('.backup'):
                value['sequence'] += 1
            return value
        except FileNotFoundError:
            continue
        except (ValueError, TypeError):
            exists = True
    if exists:
        raise RuntimeError('Reporter state invalid; restore sequence backup')
    return {}


def remaining_delay(started_at, interval, now=None):
    clock = now or time.monotonic
    return max(0, interval - (clock() - started_at))


def report(event):
    with open(CONFIG) as source:
        config = json.load(source)
    endpoint = urllib.parse.urlsplit(config['endpoint'])
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password:
        raise ValueError('Reporter requires an HTTPS endpoint without credentials')
    with open('/proc/sys/kernel/random/boot_id') as source:
        boot = source.read().strip()
    os.makedirs(os.path.dirname(STATE), mode=0o700, exist_ok=True)
    with open(STATE + '.lock', 'a') as lock:
        os.chmod(STATE + '.lock', 0o600)
        deadline = time.monotonic() + 6
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Reporter busy')
                time.sleep(0.05)
        previous = previous_state()
        sequence = previous.get('sequence', 0) + 1 if previous.get('bootId') == boot else 1
        data = {'bootId': boot, 'sequence': sequence, 'event': event}
        if previous:
            atomic_write(STATE + '.backup', previous)
        atomic_write(STATE, data)
        request = urllib.request.Request(
            config['endpoint'], data=json.dumps(data).encode(),
            headers={'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
            if response.status != 204:
                raise RuntimeError('Unexpected report response')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', choices=['online', 'heartbeat', 'poweroff', 'reboot', 'stopping'])
    args = parser.parse_args()
    if args.once:
        try:
            report(args.once)
        except Exception as error:
            print("Report failed: " + type(error).__name__, file=sys.stderr)
            sys.exit(1)
    else:
        announced = False
        while True:
            started = time.monotonic()
            try:
                report('heartbeat' if announced else 'online')
                announced = True
                delay = HEARTBEAT_SECONDS
            except Exception as error:
                # Never include exception text: HTTP libraries may include sensitive URLs.
                print('Report failed: ' + type(error).__name__, file=sys.stderr, flush=True)
                delay = 3 if not announced else HEARTBEAT_SECONDS
            time.sleep(remaining_delay(started, delay))
