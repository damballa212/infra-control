import asyncio
import contextlib
import hashlib
import gzip
import json
from pathlib import Path
import sys
import tempfile
import aiohttp
from aiohttp import web
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connector import Bridge, local_url, load_config

async def main(origin):
    client_key = 'c' * 48
    connector_key = 'b' * 48
    headers = {'X-Hermes-Relay-Key': client_key, 'User-Agent': 'HermesRelayTest/1.0'}
    counts = {'commit': 0}
    commit_started = asyncio.Event()
    release_commit = asyncio.Event()
    async def backend(request):
        if request.path == '/ws':
            ws = web.WebSocketResponse(protocols=['hermes-test'])
            await ws.prepare(request)
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT: await ws.send_str(msg.data)
                elif msg.type == aiohttp.WSMsgType.BINARY: await ws.send_bytes(msg.data)
            return ws
        if request.path == '/commit':
            counts['commit'] += 1
            commit_started.set()
            await release_commit.wait()
            return web.Response(text='committed')
        if request.path == '/cookies':
            response = web.Response(text='cookies')
            response.headers.add('Set-Cookie','first=1; Path=/; HttpOnly')
            response.headers.add('Set-Cookie','second=2; Path=/; HttpOnly')
            return response
        if request.path == '/redirect':
            return web.Response(status=302,headers={'Location':'http://169.254.169.254/latest/meta-data/'})
        if request.path == '/echo':
            return web.Response(body=await request.read(),content_type='application/octet-stream')
        if request.path == '/media':
            return web.Response(body=bytes(range(256))*2048,status=206,headers={'Content-Range':'bytes 0-524287/1048576','Content-Type':'audio/mp4'})
        if request.path == '/stream':
            response=web.StreamResponse(headers={'Content-Type':'text/event-stream'})
            await response.prepare(request)
            for _ in range(8):
                await response.write(b'data: hello\n\n')
                await asyncio.sleep(.01)
            await response.write_eof()
            return response
        if request.path == '/gzip':
            return web.Response(body=gzip.compress(b'correct compression'), headers={'Content-Encoding':'gzip','Content-Type':'text/plain'})
        if request.path == '/empty': return web.Response(status=204)
        return web.json_response({'host':request.host,'cookie':request.headers.get('Cookie'),'relay_key':request.headers.get('X-Hermes-Relay-Key'),'forwarded':request.headers.get('X-Forwarded-For')})
    app=web.Application(client_max_size=33*1024*1024)
    app.router.add_route('*','/{path:.*}',backend)
    runner=web.AppRunner(app);await runner.setup()
    site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
    port=site._server.sockets[0].getsockname()[1]
    config={'backend':f'http://127.0.0.1:{port}','url':origin,'connector_key':connector_key}
    with tempfile.TemporaryDirectory() as d:
        p=Path(d)/'config.json';p.write_text(json.dumps(config))
        assert load_config(p,True)['backend']==config['backend']
        try: load_config(p)
        except ValueError: pass
        else: raise AssertionError('HTTP relay allowed in production')
    for bad in ['//evil.test/foo','http://evil.test/','/\\evil.test/','/foo\nbar']:
        try: local_url(config['backend'],bad)
        except ValueError: pass
        else: raise AssertionError('Unsafe target accepted')
    print('configuration and SSRF restrictions passed')
    bridge_socket=None;bridge_task=None
    timeout=aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout,cookie_jar=aiohttp.DummyCookieJar(),auto_decompress=True) as session, aiohttp.ClientSession(timeout=timeout,cookie_jar=aiohttp.DummyCookieJar(),auto_decompress=False) as proxy:
        async def start_bridge():
            socket=await session.ws_connect(origin+'/_relay/connect',headers={'Authorization':'Bearer '+connector_key})
            task=asyncio.create_task(Bridge(proxy,socket,config).receive())
            return socket,task
        try:
            async with session.get(origin+'/') as r: assert r.status==401
            async with session.get(origin+'/',headers=headers) as r: assert r.status==503
            async with session.get(origin+'/_relay/connect',headers={'Upgrade':'websocket',**headers}) as r: assert r.status==401
            bridge_socket,bridge_task=await start_bridge()
            async with session.get(origin+'/',headers={**headers,'Cookie':'per-client=ok','X-Forwarded-For':'spoof'}) as r:
                assert r.status==200
                data=await r.json()
                assert data['cookie']=='per-client=ok' and data['relay_key'] is None and data['forwarded'] is None
            async with session.get(origin+'/cookies',headers=headers) as r:
                assert len(r.headers.getall('Set-Cookie'))==2
                await r.read()
            async with session.get(origin+'/redirect',headers=headers,allow_redirects=False) as r:
                assert r.status==302 and r.headers['Location'].startswith('http://169.254.')
                await r.read()
            blob=bytes(range(256))*20000
            async with session.post(origin+'/echo',headers=headers,data=blob) as r:
                assert r.status==200
                assert hashlib.sha256(await r.read()).digest()==hashlib.sha256(blob).digest()
            async with session.get(origin+'/media',headers={**headers,'Range':'bytes=0-524287'}) as r:
                assert r.status==206 and r.headers['Content-Type']=='audio/mp4'
                assert len(await r.read())==524288
            async with session.get(origin+'/stream',headers=headers) as r:
                assert (await r.read()).count(b'data: hello')==8
            async with session.get(origin+'/gzip',headers=headers) as r:
                assert await r.read()==b'correct compression'
            async with session.get(origin+'/empty',headers=headers) as r: assert r.status==204
            async with session.head(origin+'/',headers=headers) as r: assert r.status==200 and await r.read()==b''
            async with session.get(origin+'/',headers=headers) as r:
                assert (await r.json())['cookie'] is None
            print('HTTP, 5 MiB upload, cookies, HEAD/204, redirect isolation, ranges and streaming passed')
            async with session.ws_connect(origin+'/ws',headers=headers,protocols=['hermes-test']) as ws:
                assert ws.protocol=='hermes-test'
                await ws.send_str('hola 世界')
                assert (await ws.receive()).data=='hola 世界'
                await ws.send_bytes(b'\x00\xff\x80')
                assert (await ws.receive()).data==b'\x00\xff\x80'
            print('WebSocket subprotocol, Unicode text and binary passed')
            pending=asyncio.create_task(session.post(origin+'/commit',headers=headers,data=b'once'))
            await asyncio.wait_for(commit_started.wait(),10)
            await bridge_socket.close()
            await asyncio.wait_for(bridge_task,5)
            response=await asyncio.wait_for(pending,5)
            assert response.status==502
            await response.read()
            bridge_socket,bridge_task=await start_bridge()
            release_commit.set()
            async with session.get(origin+'/',headers=headers) as r: assert r.status==200
            assert counts['commit']==1
            print('connector disconnect, reconnect and no mutation replay passed')
        finally:
            release_commit.set()
            if bridge_socket: await bridge_socket.close()
            if bridge_task:
                bridge_task.cancel()
                await asyncio.gather(bridge_task,return_exceptions=True)
    await runner.cleanup()
    print('ALL CHECKS PASSED')

asyncio.run(main(sys.argv[1]))
