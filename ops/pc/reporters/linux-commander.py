#!/usr/bin/env python3
"""Agente de órdenes de la PC (CachyOS). Mantiene una conexión HTTPS SALIENTE en espera hacia el panel y ejecuta
solo órdenes de una lista cerrada, llamando al mismo helper de siempre. Sin puertos abiertos, sin shell, sin
argumentos libres. Capacidades que declara: /etc/infra-control-commander.json (por defecto solo ping)."""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

CONFIG = '/etc/infra-control-reporter.json'
CAPS_FILE = '/etc/infra-control-commander.json'
HELPER = '/usr/local/sbin/infra-control-pc'
BOOT_ID = '/proc/sys/kernel/random/boot_id'
# Orden -> capacidad que exige. Cualquier otra orden se rechaza.
REQUIRED = {'ping': 'ping', 'off': 'power', 'windows': 'power', 'cachyos': 'power'}
VALID_CAPS = ('ping', 'power')
ID_PATTERN = re.compile(r'^[0-9a-f-]{36}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def load_settings(config_path=None, caps_path=None):
    with open(config_path or CONFIG) as source:
        config = json.load(source)
    endpoint = urllib.parse.urlsplit(config['endpoint'])
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password:
        raise ValueError('Commander requires an HTTPS endpoint without credentials')
    caps = ['ping']
    try:
        with open(caps_path or CAPS_FILE) as source:
            declared = json.load(source).get('caps', [])
            caps = [cap for cap in declared if cap in VALID_CAPS]
    except FileNotFoundError:
        pass
    base = re.sub(r'/events$', '/commands', config['endpoint'])
    return {'base': base, 'token': config['token'], 'caps': caps}


def decide(order, boot, caps, handled):
    """True solo si la orden es conocida, está permitida por las capacidades, es nueva y es de este arranque."""
    if not isinstance(order, dict):
        return False
    command, order_id = order.get('command'), order.get('id')
    if command not in REQUIRED or REQUIRED[command] not in caps:
        return False
    if not isinstance(order_id, str) or not ID_PATTERN.match(order_id) or order_id in handled:
        return False
    # Los ping no llevan bootId; las órdenes de energía solo valen para el arranque en que se emitieron.
    return command == 'ping' or order.get('expectedBootId') == boot


def execute(command, run=subprocess.Popen):
    """Mismo helper que el camino SSH. argv fijo: nunca se interpola texto recibido en un comando."""
    if command == 'ping':
        return None
    if command not in ('off', 'windows', 'cachyos'):
        raise ValueError('Unknown command')
    return run([HELPER, command], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def request(settings, url, body=None, timeout=5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method='POST' if body is not None else 'GET',
        headers={'Authorization': 'Bearer ' + settings['token'], **({'Content-Type': 'application/json'} if data else {})})
    return urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout)


def run_forever():
    with open(BOOT_ID) as source:
        boot = source.read().strip()
    handled = set()
    failures = 0
    while True:
        try:
            settings = load_settings()
            url = '{}?wait=25&caps={}'.format(settings['base'], ','.join(settings['caps']))
            with request(settings, url, timeout=35) as response:
                failures = 0
                if response.status != 200:
                    continue
                order = json.loads(response.read().decode())
            if not isinstance(order, dict) or not isinstance(order.get('id'), str) or order['id'] in handled:
                continue
            accept = decide(order, boot, settings['caps'], handled)
            handled.add(order['id'])
            # Confirmar ANTES de ejecutar: el apagado corta la conexión y el panel necesita saber que se recibió.
            request(settings, '{}/{}/ack'.format(settings['base'], order['id']), {'accepted': accept, 'bootId': boot}).close()
            if accept:
                execute(order['command'])
        except Exception as error:
            failures += 1
            # Nunca incluir el texto de la excepción: las librerías HTTP pueden incluir URLs sensibles.
            print('Commander error: ' + type(error).__name__, file=sys.stderr, flush=True)
            time.sleep(min(30, 2 * failures))


if __name__ == '__main__':
    run_forever()
