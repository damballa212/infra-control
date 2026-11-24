"""Private outbound transport. Does not execute commands or store chat content."""
import argparse
import asyncio
import contextlib
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import random
import signal
import uuid
from urllib.parse import urlsplit

import aiohttp
from yarl import URL

CHUNK = 65536
FRAME_MAX = 1024 * 1024
LOG = logging.getLogger('hermes-relay')
HOP = {'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
       'proxy-authorization', 'proxy-authenticate', 'sec-websocket-protocol',
       'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
       'sec-websocket-accept'}


def local_url(base, path):
    parsed = urlsplit(path)
    if not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc:
        raise ValueError('Invalid relative path')
    if '\\' in path or any(ord(c) < 32 for c in path):
        raise ValueError('Invalid path characters')
    url = URL(base + path, encoded=True)
    if url.host != '127.0.0.1' or url.port != urlsplit(base).port:
        raise ValueError('Non-loopback target')
    return url


def pack(kind, request_id, data):
    if isinstance(data, str):
        data = data.encode('utf-8')
    if len(data) > FRAME_MAX:
        raise ValueError('Frame limit')
    return bytes([kind]) + request_id.encode('ascii') + data


class Bridge:
    def __init__(self, session, socket, config):
        self.session, self.socket, self.config = session, socket, config
        self.requests = {}

    async def control(self, **message):
        await self.socket.send_json(message)

    async def upload(self, request_id, state):
        while True:
            chunk = await state['upload'].get()
            if chunk is None:
                return
            yield chunk
            await self.control(t='upload_ack', id=request_id)

    async def request(self, m, state):
        request_id = m['id']
        try:
            url = local_url(self.config['backend'], m['path'])
            headers = [(k, v) for k, v in m['headers'] if k.lower() not in HOP]
            # Never leak the connector credential to the dashboard.
            headers = [(k, v) for k, v in headers if k.lower() != 'x-hermes-relay-key']
            if m['ws']:
                protocols = []
                for k, v in m['headers']:
                    if k.lower() == 'sec-websocket-protocol':
                        protocols.extend(x.strip() for x in v.split(',') if x.strip())
                async with self.session.ws_connect(url, headers=headers, protocols=protocols,
                                                    max_msg_size=FRAME_MAX, compress=0,
                                                    heartbeat=30) as local:
                    state['ws'] = local
                    await self.control(t='ws_open', id=request_id, protocol=local.protocol)
                    async for frame in local:
                        if frame.type in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                            await self.socket.send_bytes(pack(2 if frame.type == aiohttp.WSMsgType.TEXT else 3,
                                                              request_id, frame.data))
                        elif frame.type == aiohttp.WSMsgType.ERROR:
                            raise ConnectionError('Backend socket failed')
                    await self.control(t='ws_close', id=request_id)
            else:
                body = self.upload(request_id, state) if m['method'] not in ('GET', 'HEAD') else None
                async with self.session.request(m['method'], url, headers=headers, data=body,
                                                allow_redirects=False) as response:
                    outgoing = [(k.decode('latin1'), v.decode('latin1')) for k, v in response.raw_headers
                                if k.decode('latin1').lower() not in HOP]
                    await self.control(t='headers', id=request_id, status=response.status, headers=outgoing)
                    while True:
                        await asyncio.wait_for(state['credit'].get(), 300)
                        chunk = await response.content.read(CHUNK)
                        if not chunk:
                            await self.control(t='end', id=request_id)
                            break
                        await self.socket.send_bytes(pack(1, request_id, chunk))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Exception text may contain request paths or credentials: log the class only.
            LOG.warning('request_failed type=%s', type(error).__name__)
            with contextlib.suppress(Exception):
                await self.control(t='error', id=request_id)
        finally:
            self.requests.pop(request_id, None)

    async def receive(self):
        try:
            async for frame in self.socket:
                if frame.type == aiohttp.WSMsgType.TEXT:
                    if len(frame.data) > 65536:
                        raise ValueError('Control limit')
                    m = json.loads(frame.data)
                    request_id = m.get('id')
                    if str(uuid.UUID(request_id)) != request_id:
                        raise ValueError('Invalid id')
                    if m['t'] == 'request':
                        if request_id in self.requests or len(self.requests) >= 20:
                            await self.control(t='error', id=request_id)
                            continue
                        state = {'upload': asyncio.Queue(maxsize=2), 'credit': asyncio.Queue(maxsize=2), 'ws': None}
                        self.requests[request_id] = state
                        state['task'] = asyncio.create_task(self.request(m, state))
                    elif request_id in self.requests:
                        state = self.requests[request_id]
                        if m['t'] == 'upload_end':
                            state['upload'].put_nowait(None)
                        elif m['t'] == 'pull':
                            state['credit'].put_nowait(None)
                        elif m['t'] == 'cancel':
                            state['task'].cancel()
                        else:
                            raise ValueError('Control type')
                elif frame.type == aiohttp.WSMsgType.BINARY:
                    data = frame.data
                    if len(data) < 37 or len(data) > FRAME_MAX + 37:
                        raise ValueError('Frame limit')
                    kind, request_id, payload = data[0], data[1:37].decode('ascii'), data[37:]
                    state = self.requests.get(request_id)
                    if not state:
                        continue
                    if kind == 0:
                        if len(payload) > CHUNK:
                            raise ValueError('Chunk limit')
                        state['upload'].put_nowait(payload)
                    elif kind in (2, 3) and state['ws'] is not None:
                        if kind == 2:
                            await state['ws'].send_str(payload.decode('utf-8'))
                        else:
                            await state['ws'].send_bytes(payload)
                        await self.control(t='ws_ack', id=request_id)
                    else:
                        raise ValueError('Frame type')
                elif frame.type == aiohttp.WSMsgType.ERROR:
                    raise ConnectionError('Relay socket failed')
        finally:
            tasks = [s['task'] for s in self.requests.values()]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


def load_config(path, allow_local=False):
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    public = urlsplit(config['url'])
    if (public.scheme != 'https' or not public.hostname.endswith('.workers.dev')) and not (
            allow_local and public.scheme == 'http' and public.hostname == '127.0.0.1'):
        raise ValueError('Relay must use HTTPS workers.dev')
    if public.username or public.password or public.path not in ('', '/') or public.query or public.fragment:
        raise ValueError('Relay must be an origin')
    target = urlsplit(config['backend'])
    if target.scheme != 'http' or target.hostname != '127.0.0.1' or not target.port or target.path not in ('', '/'):
        raise ValueError('Backend must be fixed HTTP loopback')
    if not allow_local and target.port != 9119:
        raise ValueError('Only Hermes dashboard port 9119 is allowed')
    if len(config['connector_key']) < 32:
        raise ValueError('Connector credential too short')
    config['backend'] = config['backend'].rstrip('/')
    config['url'] = config['url'].rstrip('/')
    return config


async def run(config, stop):
    timeout = aiohttp.ClientTimeout(total=None, connect=15, sock_read=None)
    delay = 1
    async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False,
                                    cookie_jar=aiohttp.DummyCookieJar(), trust_env=False) as session:
        while not stop.is_set():
            try:
                async with session.ws_connect(config['url'] + '/_relay/connect',
                                              headers={'Authorization': 'Bearer ' + config['connector_key'],
                                                       'User-Agent': 'HermesWindowsRelay/1.0'},
                                              heartbeat=20, max_msg_size=FRAME_MAX + 37, compress=0) as socket:
                    LOG.info('connected')
                    delay = 1
                    bridge = asyncio.create_task(Bridge(session, socket, config).receive())
                    stopping = asyncio.create_task(stop.wait())
                    try:
                        done, _ = await asyncio.wait([bridge, stopping], return_when=asyncio.FIRST_COMPLETED)
                        if bridge in done:
                            await bridge
                    finally:
                        bridge.cancel()
                        stopping.cancel()
                        await asyncio.gather(bridge, stopping, return_exceptions=True)
            except Exception as error:
                LOG.warning('disconnected type=%s', type(error).__name__)
            if not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), delay + random.random())
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 30)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--log-file', help='Private rotating operational log; never logs payloads')
    parser.add_argument('--test-local', action='store_true', help='Allow loopback relay only for integration tests')
    args = parser.parse_args()
    config = load_config(args.config, args.test_local)
    handlers = [RotatingFileHandler(args.log_file, maxBytes=1048576, backupCount=2, encoding='utf-8')] if args.log_file else None
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', handlers=handlers)
    async def start():
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                asyncio.get_running_loop().add_signal_handler(sig, stop.set)
        await run(config, stop)
    asyncio.run(start())


if __name__ == '__main__':
    main()
