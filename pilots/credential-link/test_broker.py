"""Real loopback HTTP + subprocess + private-file integration, no provider calls."""
import contextlib
import concurrent.futures
import http.client
import io
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
import time
import unittest
from urllib.parse import urlencode, urlsplit
from broker import Broker


class Pilot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='credential-fixture-', dir=os.environ['TMPDIR'])
        self.server = Broker(self.tmp.name)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.responses = []
        self.fixture = 'FAKE_ONLY_' + secrets.token_hex(16)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.assertFalse(self.thread.is_alive())
        self.tmp.cleanup()
        for response in self.responses:
            self.assertNotIn(self.fixture, response)

    def call(self, method, path, data=None, agent=False, cookie=None, origin=True, **extra):
        headers = dict(extra)
        if agent:
            headers['Authorization'] = 'Bearer ' + self.server.agent_token
        if cookie:
            headers['Cookie'] = cookie
        if origin:
            headers['Origin'] = self.server.origin
        if data is not None:
            headers['Content-Type'] = 'application/json' if agent else 'application/x-www-form-urlencoded'
            data = json.dumps(data) if agent else urlencode(data)
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=7)
        conn.request(method, path, data, headers)
        response = conn.getresponse()
        code, hs, text = response.status, dict(response.getheaders()), response.read().decode()
        conn.close()
        self.responses.append(text)
        self.assertEqual(hs['Cache-Control'], 'no-store')
        self.assertEqual(hs['Referrer-Policy'], 'no-referrer')
        self.assertIn("default-src 'none'", hs['Content-Security-Policy'])
        return code, hs, text

    def create(self, target='process', ttl=120, idem=None):
        code, _, text = self.call('POST', '/requests', {'target': target, 'ttl': ttl}, agent=True,
                                 **{'Idempotency-Key': idem or secrets.token_hex(8)})
        self.assertEqual(code, 200)
        return json.loads(text)

    def status(self, req):
        return json.loads(self.call('GET', '/requests/' + req['id'], agent=True)[2])['status']

    def owner(self, req):
        _, hs, text = self.call('GET', urlsplit(req['link']).path)
        cookie = hs['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly', hs['Set-Cookie'])
        self.assertIn('SameSite=Strict', hs['Set-Cookie'])
        csrf = re.search('name="csrf" value="([^"]+)"', text)[1]
        code, hs, text = self.call('POST', '/login', {'id': req['id'], 'csrf': csrf,
                                   'owner_token': self.server.owner_token}, cookie=cookie)
        self.assertEqual(code, 200)
        self.assertNotEqual(cookie, hs['Set-Cookie'].split(';')[0])
        return hs['Set-Cookie'].split(';')[0], re.search('name="csrf" value="([^"]+)"', text)[1]

    def submit(self, req, cookie, csrf, **overrides):
        data = {'id': req['id'], 'csrf': csrf, 'fixture': self.fixture, 'action': 'submit'}
        data.update(overrides)
        return self.call('POST', '/r/' + req['id'], data, cookie=cookie)

    def use(self, req):
        return self.call('POST', '/use/' + req['id'], {}, agent=True)

    def test_process_link_to_child_and_replay(self):
        req = self.create(idem='same-intention')
        self.assertEqual(req['id'], self.create(idem='same-intention')['id'])
        self.assertEqual(self.call('POST', '/requests', {'target':'dotenv','ttl':120}, agent=True,
                                  **{'Idempotency-Key':'same-intention'})[0], 400)
        self.call('GET', urlsplit(req['link']).path)
        self.call('GET', urlsplit(req['link']).path)
        self.assertEqual(self.status(req), 'pending')
        cookie, csrf = self.owner(req)
        self.assertEqual(self.submit(req, cookie, csrf)[0], 200)
        self.assertEqual(self.status(req), 'ready')
        code, _, text = self.use(req)
        self.assertEqual((code, json.loads(text)['status']), (200, 'used'))
        self.assertEqual(self.use(req)[0], 400)
        self.assertNotIn('value', self.server.requests[req['id']])
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_dotenv_private_exact_content(self):
        req = self.create('dotenv')
        self.submit(req, *self.owner(req))
        self.assertEqual(json.loads(self.use(req)[2])['status'], 'used')
        path = Path(self.tmp.name) / ('env-' + req['id'])
        self.assertEqual(path.read_text(), 'OPENAI_API_KEY=' + self.fixture + '\n')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(self.tmp.name).stat().st_mode & 0o777, 0o700)

    def test_auth_csrf_origin_and_real_key_rejected(self):
        req = self.create()
        self.assertEqual(self.call('GET', '/requests/' + req['id'])[0], 400)
        self.assertEqual(self.call('POST', '/r/' + req['id'], {'fixture':self.fixture})[0], 400)
        cookie, csrf = self.owner(req)
        self.assertEqual(self.submit(req, cookie, 'wrong')[0], 400)
        self.assertEqual(self.submit(req, cookie, csrf, fixture='NOT_A_FIXTURE')[0], 400)
        data = {'id':req['id'],'csrf':csrf,'fixture':self.fixture,'action':'submit'}
        self.assertEqual(self.call('POST','/r/'+req['id'],data,cookie=cookie,origin=False)[0],400)
        self.assertEqual(self.call('POST','/r/'+req['id'],data,cookie=cookie,origin=False,
                                  Origin='https://wrong.invalid')[0],400)
        self.assertEqual(self.call('GET','/r/'+req['id'],Host='wrong.invalid')[0],400)
        self.assertEqual(self.status(req), 'pending')

    def test_expiry_deny_and_session_timeout(self):
        req = self.create(ttl=1)
        cookie, csrf = self.owner(req)
        self.submit(req, cookie, csrf)
        time.sleep(1.05)
        self.assertEqual(self.status(req), 'expired')
        self.assertNotIn('value', self.server.requests[req['id']])
        self.assertEqual(self.use(req)[0],400)
        req = self.create()
        self.submit(req, cookie, csrf, action='deny')
        self.assertEqual(self.status(req),'denied')
        self.assertEqual(self.use(req)[0],400)
        req = self.create()
        with self.server.lock:
            for session in self.server.sessions.values():
                session['deadline'] = 0
        self.assertEqual(self.submit(req,cookie,csrf)[0],400)

    def test_race_submit_and_use(self):
        req = self.create()
        cookie, csrf = self.owner(req)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.submit(req,cookie,csrf)[0], range(2)))
        self.assertEqual(sorted(results),[200,400])
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.use(req)[0], range(2)))
        self.assertEqual(sorted(results),[200,400])

    def test_destination_policy_and_symlink_no_overwrite(self):
        self.assertEqual(self.call('POST','/requests',{'target':'https://api.openai.com','ttl':30},
                                  agent=True,**{'Idempotency-Key':'bad'})[0],400)
        req = self.create('dotenv')
        sentinel = Path(self.tmp.name)/'sentinel'
        sentinel.write_text('unchanged')
        (Path(self.tmp.name)/('env-'+req['id'])).symlink_to(sentinel)
        self.submit(req,*self.owner(req))
        self.assertEqual(json.loads(self.use(req)[2])['status'],'failed')
        self.assertEqual(sentinel.read_text(),'unchanged')
        self.assertEqual(self.use(req)[0],400)

    def test_idle_expiry_and_quotas(self):
        req = self.create(ttl=1)
        self.submit(req, *self.owner(req))
        time.sleep(1.6)  # No intervening HTTP request: service_actions must purge.
        with self.server.lock:
            self.assertEqual(self.server.requests[req['id']]['status'], 'expired')
            self.assertNotIn('value', self.server.requests[req['id']])
            self.server.MAX_REQUESTS = len(self.server.requests)
        self.assertEqual(self.call('POST','/requests',{'target':'process','ttl':30},agent=True,
                                  **{'Idempotency-Key':'quota'})[0],400)
        with self.server.lock:
            self.server.MAX_SESSIONS = len(self.server.sessions)
        self.assertEqual(self.call('GET','/r/'+req['id'])[0],400)

    def test_slow_child_does_not_hold_lock(self):
        from unittest.mock import patch
        import broker
        original = broker.subprocess.run
        req = self.create()
        self.submit(req,*self.owner(req))
        entered, release = threading.Event(), threading.Event()
        def slow(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return original(*args, **kwargs)
        with patch('broker.subprocess.run',slow):
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                future = pool.submit(self.use,req)
                self.assertTrue(entered.wait(2))
                try:
                    self.assertEqual(self.status(req),'using')
                    self.assertEqual(self.use(req)[0],400)
                finally:
                    release.set()
                self.assertEqual(json.loads(future.result()[2])['status'],'used')

    def test_total_deadline_and_shutdown_with_eight_slow_clients(self):
        import socket
        self.server.REQUEST_DEADLINE = 0.35
        sockets = []
        try:
            for _ in range(8):
                sock = socket.create_connection(('127.0.0.1',self.server.server_port),timeout=2)
                sock.settimeout(1)
                sock.sendall(b'GET / HTTP/1.1\r\nX-Slow: ')
                sockets.append(sock)
            start = time.monotonic()
            for _ in range(5):
                for sock in sockets:
                    try:
                        sock.sendall(b'x')
                    except OSError:
                        pass
                time.sleep(0.1)  # Inactivity remains below 5s, total exceeds deadline.
            for sock in sockets:
                try:
                    self.assertEqual(sock.recv(1),b'')
                except (ConnectionResetError, BrokenPipeError):
                    pass
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(2)
            self.assertLess(time.monotonic()-start,2)
        finally:
            for sock in sockets:
                sock.close()

    def test_partial_file_cleanup_and_explicit_cleanup_failure(self):
        from unittest.mock import patch
        for unlink_failure in (False,True):
            req = self.create('dotenv')
            self.submit(req,*self.owner(req))
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch('broker.os.fchmod', side_effect=OSError('fixture failure')))
                if unlink_failure:
                    stack.enter_context(patch('broker.os.unlink', side_effect=OSError('fixture failure')))
                outcome = json.loads(self.use(req)[2])['status']
            self.assertEqual(outcome,'failed_cleanup_required' if unlink_failure else 'failed')
            self.assertEqual((Path(self.tmp.name)/('env-'+req['id'])).exists(),unlink_failure)
            self.assertEqual(self.status(req),outcome)
            self.assertEqual(self.use(req)[0],400)

    def test_no_fixture_in_logs_or_child_arguments(self):
        req = self.create()
        self.submit(req,*self.owner(req))
        import broker
        original = broker.subprocess.run
        def checked(argv, **kwargs):
            self.assertNotIn(self.fixture, repr(argv))
            self.assertEqual(kwargs['env']['OPENAI_API_KEY'],self.fixture)
            return original(argv, **kwargs)
        from unittest.mock import patch
        logs = io.StringIO()
        with contextlib.redirect_stderr(logs), contextlib.redirect_stdout(logs):
            with patch('broker.subprocess.run', checked):
                self.assertEqual(json.loads(self.use(req)[2])['status'],'used')
        self.assertEqual(logs.getvalue(),'')


if __name__ == '__main__':
    unittest.main(verbosity=2)
