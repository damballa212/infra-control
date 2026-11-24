"""Read-only native auth/WS checks plus an owned temporary media file.
Run in Windows via SSH stdin; keys are supplied in memory, never command arguments.
"""
import asyncio
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import uuid
import wave
import aiohttp

async def verify(settings):
    origin = settings['url']
    home = Path.home() / 'AppData/Local/hermes'
    credentials = home / 'backups/local-general-20261109T001627Z/hermex-acceso.txt'
    fields = {line.split(':', 1)[0].strip().lower(): line.split(':', 1)[1].strip()
              for line in credentials.read_text(encoding='utf-8').splitlines() if ':' in line}
    headers = {'X-Hermes-Relay-Key': settings['client_key'], 'Origin': origin,
               'User-Agent': 'HermesRelayVerifier/1.0'}
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b'\0' * 16000)
    payload = audio.getvalue()
    target = Path.home() / 'AppData/Local/hermes-relay' / ('relay-check-' + str(uuid.uuid4()) + '.wav')
    try:
        async with aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.get(origin + '/api/auth/providers') as r:
                assert r.status == 200
                provider = next(p for p in (await r.json())['providers'] if p.get('supports_password'))['name']
            async with session.post(origin + '/auth/password-login', json={
                    'provider': provider, 'username': fields['usuario'], 'password': fields['contraseña']}) as r:
                assert r.status == 200, 'login failed'
                await r.read()
                print('login=200', flush=True)
            for path in ['/api/auth/me', '/api/config']:
                async with session.get(origin + path) as r:
                    assert r.status == 200, path + ' failed'
                    await r.read()
                    print(path + '=200', flush=True)
            async with session.post(origin + '/api/auth/ws-ticket', json={}) as r:
                assert r.status == 200, 'ticket failed'
                ticket = (await r.json())['ticket']
            async with session.ws_connect(origin + '/api/ws?ticket=' + ticket,
                                          timeout=aiohttp.ClientWSTimeout(ws_receive=20)) as ws:
                m = await ws.receive()
                assert m.type == aiohttp.WSMsgType.TEXT, 'gateway message missing'
                data = json.loads(m.data)
                print('websocket=' + str(data.get('type') or data.get('method') or list(data)[:3]), flush=True)
                # Native greeting proves transport; never start a model or modify a chat.
            target.write_bytes(payload)
            async with session.get(origin + '/api/fs/download', params={'path': str(target)}) as r:
                received = await r.read()
                assert r.status == 200 and hashlib.sha256(received).digest() == hashlib.sha256(payload).digest(), 'media integrity failed'
                print('media=200 hash_matches mime=' + r.headers.get('Content-Type', ''), flush=True)
            async with session.get(origin + '/api/fs/download', params={'path': str(target)}, headers={'Range':'bytes=0-255'}) as r:
                assert r.status == 206 and await r.read() == payload[:256], 'media range failed'
                print('media_range=206', flush=True)
            async with session.post(origin + '/auth/logout') as r:
                assert r.status in (200, 204, 303), 'logout failed'
                await r.read()
    finally:
        if target.exists():
            assert hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(payload).digest()
            target.unlink()

if __name__ == '__main__':
    try:
        asyncio.run(verify(json.loads(sys.stdin.read())))
    except Exception as error:
        # Library exception strings can contain single-use WS tickets: never print them.
        print('verification_failed type=' + type(error).__name__)
        sys.exit(1)
