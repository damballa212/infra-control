"""Fixture-only local control tests. No execution results are asserted here.

Control clients send one JSON line (including LF, at most 1024 bytes), then
shutdown(SHUT_WR) before reading the reply. EOF makes trailing framing strict.
"""
import http.client as http_client
import http.server as http_server
import json
import os
import socket
import stat
import tempfile
import threading
import unittest
import urllib.parse
from unittest import mock

import https_broker as broker



class AgentControlTests(unittest.TestCase):

    def environment(self, uid=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        os.chmod(directory.name, 0o700)
        now = [100.0]
        state = broker.State('Admin', directory.name, ('127.0.0.1', 1), clock=lambda: now[0])
        self.addCleanup(state.close)
        path = os.path.join(directory.name, 'control.sock')
        server = broker.make_control_server(
            state, test_mode=True, path=path,
            allowed_uid=os.geteuid() if uid is None else uid)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
        thread.start()
        def cleanup():
            server.shutdown()
            thread.join()
            server.server_close()
            broker.remove_socket(server)
        self.addCleanup(cleanup)
        return state, path, now, server

    def exchange(self, path, payload):
        if isinstance(payload, dict):
            payload = json.dumps(payload).encode() + b'\n'
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(path)
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            result = bytearray()
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    break
                result.extend(chunk)
        return json.loads(result)

    def assert_public(self, result):
        self.assertEqual(set(result) - {'url'}, {'request'})
        self.assertEqual(set(result['request']), {'id', 'status', 'destination', 'createdAt', 'expiresAt'})
        encoded = json.dumps(result)
        for forbidden in (broker.FIXTURE, 'csrf', 'cookie', 'controller', 'OPENAI_API_KEY'):
            self.assertNotIn(forbidden, encoded)

    def test_create_status_singleton_and_ttl(self):
        state, path, now, server = self.environment()
        self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o600)
        first = self.exchange(path, {'op': 'create'})
        self.assert_public(first)
        rid = first['request']['id']
        self.assertRegex(rid, r'^[0-9a-f]{32}$')
        self.assertEqual(first['url'], broker.ORIGIN + '/ajustes/credenciales/' + rid)
        self.assertEqual(first, self.exchange(path, {'op': 'create'}))
        self.assertEqual(state.sessions, {})
        stored = state.requests[rid]
        self.assertIsNone(stored['session'])
        self.assertEqual(stored['owner'], 'Admin')
        self.assertEqual(stored['project'], 'infra-control-private')
        self.assertEqual(stored['destination'], 'process')
        self.assertEqual(stored['expires'], 1900.0)
        self.assertNotEqual(stored['key'], rid)
        status = self.exchange(path, {'op': 'status', 'id': rid})
        self.assert_public(status)
        self.assertNotIn('url', status)
        self.assertEqual(status['request']['status'], 'pending')
        now[0] += 1799
        self.assertEqual(self.exchange(path, {'op': 'status', 'id': rid})['request']['status'], 'pending')
        now[0] += 1
        self.assertEqual(self.exchange(path, {'op': 'create'})['request']['status'], 'expired')
        self.assertEqual(state.action(None, rid, 'submit', broker.FIXTURE, True)[0], 410)
        self.assertEqual(len(state.requests), 1)
        self.assertEqual(self.exchange(path, {'op': 'status', 'id': 'f' * 32}), {'error': 'not found'})

    def test_terminal_status_survives_request_ttl(self):
        state, path, now, _ = self.environment()
        rid = self.exchange(path, {'op': 'create'})['request']['id']
        now[0] += 1801
        for status in ('using', 'used', 'denied', 'failed', 'failed_cleanup_required'):
            with self.subTest(status=status):
                state.requests[rid]['status'] = status
                self.assertEqual(self.exchange(path, {'op': 'status', 'id': rid})['request']['status'], status)
                self.assertEqual(state.preview(None, rid, owner_scope=True)['status'], status)

    def test_capacity_shared_with_human_requests(self):
        state, path, _, _ = self.environment()
        token, session, _ = state.session(None, True)
        for index in range(64):
            state.requests[f'{index:032x}'] = {
                'session': token, 'key': str(index), 'owner': state.owner,
                'destination': 'process', 'status': 'pending', 'expires': 1000,
            }
        self.assertEqual(self.exchange(path, {'op': 'create'}), {'error': 'capacity'})
        self.assertIsNone(state.agent_request_id)
        del state.requests['0' * 32]
        created = self.exchange(path, {'op': 'create'})
        self.assertEqual(len(state.requests), 64)
        self.assertEqual(state.create(token, session['idempotency'], 'process'), (503, None))
        self.assertEqual(created, self.exchange(path, {'op': 'create'}))

    def test_wrong_peer_denied_before_input(self):
        state, path, _, _ = self.environment(os.geteuid() + 1)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(path)
            self.assertEqual(json.loads(client.recv(1024)), {'error': 'denied'})
        self.assertFalse(state.requests)
        self.assertFalse(state.sessions)

    def test_strict_protocol(self):
        state, path, _, _ = self.environment()
        invalid = [
            b'', b'{"op":"create"}', b'{"op":"create"}\n\n',
            b'{"op":"create"}\n{"op":"create"}\n',
            b'{"op":"create","op":"create"}\n',
            b'{"op":"status","id":"a","id":"b"}\n',
            b'[]\n', b'null\n', b'\xff\n', b' ' * 1024 + b'\n',
            b'{"op":"submit"}\n', b'{"op":"retrieve"}\n',
            b'{"op":"create","destination":"dotenv"}\n',
            b'{"op":"create","owner":"other"}\n',
            b'{"op":"create","project":"other"}\n',
            b'{"op":"create","path":"/tmp/value"}\n',
            b'{"op":"create","value":"anything"}\n',
            b'{"op":"status"}\n', b'{"op":"status","id":42}\n',
            b'{"op":"status","id":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n',
        ]
        for payload in invalid:
            with self.subTest(payload=payload[:100]):
                self.assertIn('error', self.exchange(path, payload))
        self.assertFalse(state.requests)
        self.assertFalse(state.sessions)

    def test_factory_and_identity_cleanup(self):
        state, path, _, server = self.environment()
        for kwargs in ({'path': path}, {'allowed_uid': 0}):
            with self.assertRaises(ValueError):
                broker.make_control_server(state, **kwargs)
        with self.assertRaises(ValueError):
            broker.make_control_server(state, test_mode=True, path=path, allowed_uid=os.geteuid())
        os.unlink(path)
        with open(path, 'w', encoding='ascii') as replacement:
            replacement.write('preserve')
        broker.remove_socket(server)
        with open(path, encoding='ascii') as replacement:
            self.assertEqual(replacement.read(), 'preserve')
        unsafe = os.path.join(os.path.dirname(path), 'unsafe')
        os.mkdir(unsafe, 0o700)
        os.chmod(unsafe, 0o777)
        with self.assertRaises(ValueError):
            broker.make_control_server(state, test_mode=True,
                                       path=os.path.join(unsafe, 'control.sock'), allowed_uid=os.geteuid())

    def human_server(self, state):
        identity = {'agent': False, 'name': 'Admin'}
        class Auth(http_server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                data = json.dumps(identity).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        auth = http_server.HTTPServer(('127.0.0.1', 0), Auth)
        auth_thread = threading.Thread(target=auth.serve_forever, kwargs={'poll_interval': 0.01})
        auth_thread.start()
        state.endpoint = auth.server_address
        http = broker.TCPServer(('127.0.0.1', 0), broker.Handler)
        http.initialize_limits()
        http.state = state
        thread = threading.Thread(target=http.serve_forever, kwargs={'poll_interval': 0.01})
        thread.start()
        def cleanup():
            http.shutdown()
            thread.join()
            http.server_close()
            auth.shutdown()
            auth_thread.join()
            auth.server_close()
        self.addCleanup(cleanup)
        return http, identity

    def human(self, http, method, suffix, token=None, form=None, **overrides):
        # Refill only the test rate limiter; keep the human authentication gate real.
        with http.state.lock:
            http.state.tokens = 15.0
        headers = {'Host': broker.HOST, 'Cookie': '__Host-infra=test-human'}
        if token is not None:
            headers['Cookie'] += '; ' + broker.CSRF_COOKIE + '=' + token
        body = None
        if method == 'POST':
            headers.update({'Origin': broker.ORIGIN, 'X-Credential-Link-CSRF': token or '',
                            'Content-Type': 'application/x-www-form-urlencoded'})
            body = urllib.parse.urlencode(form or {})
        headers.update(overrides)
        connection = http_client.HTTPConnection(*http.server_address, timeout=5)
        try:
            connection.request(method, broker.BASE + suffix, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read()) if response.getheader('Content-Type', '').startswith('application/json') else response.read()
        finally:
            connection.close()

    def test_human_cross_session_preview_auth_and_actual_child(self):
        state, path, _, _ = self.environment()
        created = self.exchange(path, {'op': 'create'})
        rid = created['request']['id']
        http, identity = self.human_server(state)
        code, boot = self.human(http, 'GET', 'api/bootstrap.json')
        self.assertEqual(code, 200)
        old_token = boot['csrf']
        with state.lock:
            state.sessions[old_token]['expires'] = 0
        code, boot = self.human(http, 'GET', 'api/bootstrap.json')
        token = boot['csrf']
        self.assertNotEqual(token, old_token)
        code, listing = self.human(http, 'GET', 'api/requests.json', token)
        self.assertEqual(code, 200)
        self.assertEqual([item['id'] for item in listing['requests']], [rid])
        for _ in range(2):
            code, preview = self.human(http, 'GET', 'api/r/' + rid + '.json', token)
            self.assertEqual(code, 200)
            self.assertEqual(preview['status'], 'pending')
        self.assertEqual(state.requests[rid]['status'], 'pending')
        target = 'api/r/' + rid
        form = {'action': 'submit', 'value': broker.FIXTURE}
        for changes in ({'agent': True}, {'name': 'other'}):
            identity.update(changes)
            self.assertEqual(self.human(http, 'POST', target, token, form)[0], 401)
            identity.update({'agent': False, 'name': 'Admin'})
        self.assertEqual(self.human(http, 'POST', target, token, form,
                                    **{'X-Credential-Link-CSRF': 'wrong'})[0], 403)
        self.assertEqual(self.human(http, 'POST', target, token, form,
                                    Origin='https://other.invalid')[0], 403)
        self.assertEqual(self.human(http, 'POST', target, token,
                                    {'action': 'submit', 'value': 'not-fixture'})[0], 400)
        self.assertEqual(state.requests[rid]['status'], 'pending')
        # No deliver/subprocess mock: this exercises the actual isolated fixture child.
        self.assertEqual(self.human(http, 'POST', target, token, form), (200, {'status': 'used'}))
        self.assertEqual(self.human(http, 'POST', target, token, form), (409, {'status': 'used'}))
        summary = self.exchange(path, {'op': 'status', 'id': rid})
        self.assert_public(summary)
        self.assertEqual(summary['request']['status'], 'used')
        encoded = json.dumps(summary)
        for private in (token, old_token, state.agent_key):
            self.assertNotIn(private, encoded)
        self.assertEqual(self.exchange(path, {'op': 'create'})['request']['id'], rid)
    def test_csrf_expiry_at_mutation_boundary(self):
        state, path, now, _ = self.environment()
        rid = self.exchange(path, {'op': 'create'})['request']['id']
        http, _ = self.human_server(state)
        _, boot = self.human(http, 'GET', 'api/bootstrap.json')
        token = boot['csrf']
        original = broker.Handler.read_form
        def expiring(handler):
            fields = original(handler)
            now[0] += 301
            return fields
        with mock.patch.object(broker.Handler, 'read_form', expiring):
            self.assertEqual(self.human(http, 'POST', 'api/r/' + rid, token,
                             {'action': 'submit', 'value': broker.FIXTURE})[0], 403)
        self.assertEqual(self.exchange(path, {'op': 'status', 'id': rid})['request']['status'], 'pending')
        # The HTML path shares the same mutation-boundary guard.
        token, session, _ = state.session(None, True)
        code, html_rid = state.create(token, session['idempotency'], 'process')
        self.assertEqual(code, 201)
        # Keep this request alive after its independent CSRF session expires.
        state.requests[html_rid]['expires'] += 600
        with mock.patch.object(broker.Handler, 'read_form', expiring):
            self.assertEqual(self.human(http, 'POST', 'r/' + html_rid, token,
                             {'csrf': token, 'action': 'deny'})[0], 403)
        self.assertEqual(state.requests[html_rid]['status'], 'pending')

    def test_concurrent_control_create_is_singleton(self):
        import concurrent.futures
        state, path, _, _ = self.environment()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.exchange(path, {'op': 'create'}), range(4)))
        self.assertEqual(len({item['request']['id'] for item in results}), 1)
        self.assertEqual(len(state.requests), 1)

    def test_main_lifecycle_and_partial_startup_cleanup(self):
        import subprocess
        import sys
        import time
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            http_path = os.path.join(directory, 'http.sock')
            control_path = os.path.join(directory, 'control.sock')
            script = ('import sys; sys.path.insert(0,' + repr(os.path.dirname(broker.__file__))
                + '); import https_broker as b; b.SOCKET=' + repr(http_path)
                + '; b.CONTROL_SOCKET=' + repr(control_path) + '; b.PRIVATE=' + repr(directory)
                + '; b.load_policy=lambda: "Admin"; import types,os; b.grp.getgrnam=lambda _:types.SimpleNamespace(gr_gid=os.getegid()); sys.argv=["pilot-test"]; b.main()')
            process = subprocess.Popen([sys.executable, '-I', '-c', script],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            clients = []
            try:
                deadline = time.monotonic() + 5
                while not (os.path.exists(http_path) and os.path.exists(control_path)):
                    if process.poll() is not None:
                        self.fail(process.stderr.read().decode('utf-8', errors='replace'))
                    if time.monotonic() >= deadline:
                        self.fail('test broker socket readiness timeout')
                    time.sleep(0.01)
                for endpoint in (http_path, control_path):
                    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    client.connect(endpoint)
                    client.sendall(b'{')
                    clients.append(client)
                process.terminate()
                self.assertEqual(process.wait(timeout=7), 0)
                self.assertFalse(os.path.exists(http_path))
                self.assertFalse(os.path.exists(control_path))
            finally:
                for client in clients:
                    client.close()
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stderr.close()
            # An existing control endpoint must be preserved; HTTP cleaned up.
            with open(control_path, 'w') as retained:
                retained.write('preserve')
            result = subprocess.run([sys.executable, '-I', '-c', script],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(os.path.exists(http_path))
            with open(control_path) as retained:
                self.assertEqual(retained.read(), 'preserve')
            os.unlink(control_path)
            # Deliver SIGTERM deterministically inside make_server initialization.
            initializing = script.replace('; b.main()',
                '; original=b.make_server; import signal; '
                'b.make_server=lambda: (os.kill(os.getpid(),signal.SIGTERM),original())[1]; b.main()')
            result = subprocess.run([sys.executable, '-I', '-c', initializing],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertFalse(os.path.exists(http_path))
            self.assertFalse(os.path.exists(control_path))


if __name__ == '__main__':
    unittest.main()
