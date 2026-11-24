#!/usr/bin/env python3
"""Fixture-only unittest suite. Temporary directory selection is external."""
import concurrent.futures
import datetime
import http.client
import http.server
import json
import os
import re
import socket
import tempfile
import threading
import time
import unittest
import urllib.parse
from unittest import mock

import https_broker as b


class Auth(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.seen.append((self.path, list(self.headers.items())))
        payload = self.server.payload
        if payload is None:
            self.connection.close()
            return
        self.send_response(self.server.code)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.auth = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Auth)
        self.auth.daemon_threads = True
        self.auth.seen = []
        self.auth.code = 200
        self.auth.payload = b'{"agent":false,"name":"Owner"}'
        self.auth_thread = threading.Thread(target=self.auth.serve_forever)
        self.auth_thread.start()
        self.now = 100.0
        self.server = b.make_server(test_mode=True, owner='Owner',
            directory=self.temp.name, auth_endpoint=self.auth.server_address,
            clock=lambda: self.now)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.token = None
        self.key = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.server.state.close()
        self.auth.shutdown()
        self.auth.server_close()
        self.auth_thread.join()
        self.temp.cleanup()

    def refill(self):
        # Tests may refill admission state; production has no such HTTP route.
        with self.server.state.lock:
            self.server.state.tokens = 15

    def request(self, method='GET', path=b.BASE, form=None, headers=None,
                authenticated=True, refill=True):
        if refill:
            self.refill()
        values = {'Host': b.HOST}
        if authenticated:
            cookie = '__Host-infra=human_cookie'
            if self.token:
                cookie += '; ' + b.CSRF_COOKIE + '=' + self.token
            values['Cookie'] = cookie
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form)
            values['Content-Type'] = 'application/x-www-form-urlencoded'
            values['Origin'] = b.ORIGIN
        if headers:
            values.update(headers)
        client = http.client.HTTPConnection(*self.server.server_address, timeout=6)
        try:
            client.request(method, path, body=data, headers=values)
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            client.close()

    def home(self):
        code, headers, body = self.request()
        self.assertEqual(code, 200)
        cookie = headers['Set-Cookie']
        self.token = cookie.split(';')[0].split('=', 1)[1]
        self.key = re.search(r'name="idempotency" value="([0-9a-f]{32})"', body)[1]
        return headers, body

    def create(self, destination='process'):
        code, _, body = self.request('POST', b.BASE + 'request', {
            'csrf': self.token, 'idempotency': self.key,
            'destination': destination})
        self.assertIn(code, (200, 201))
        return re.search(r'/r/([0-9a-f]{32})', body)[1]

    def action(self, rid, action='submit', value=b.FIXTURE):
        return self.request('POST', b.BASE + 'r/' + rid,
            {'csrf': self.token, 'action': action, 'value': value})

    def test_human_gate_fail_closed(self):
        self.assertEqual(self.request(authenticated=False)[0], 401)
        cases = [b'{"agent":true,"name":"Owner"}',
                 b'{"agent":false,"name":"Other"}',
                 b'{"name":"Owner"}', b'{"agent":0,"name":"Owner"}',
                 b'{"agent":false,"name":""}', b'not-json', b'[]',
                 b'{"agent":false,"agent":false,"name":"Owner"}',
                 b'x' * 4097, None]
        for payload in cases:
            self.auth.payload = payload
            code, headers, body = self.request()
            self.assertEqual(code, 401)
            self.assertNotIn('Set-Cookie', headers)
            self.assertIn(b.ORIGIN + '/', body)
        self.auth.payload = b'{"agent":false,"name":"Owner"}'
        for code in (302, 401, 500):
            self.auth.code = code
            self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.server.state.sessions, {})
        self.server.state.endpoint = ('127.0.0.1', 0)
        self.assertEqual(self.request()[0], 401)

    def test_headers_cookies_and_forwarding(self):
        for cookie in ('__Host-infra=a; __Host-infra=b',
                       '__Host-infra="quoted"', '__Host-infra=',
                       '__Host-infra=a; x=1; x=2', '__Host-infra=a; bad'):
            self.assertEqual(self.request(headers={'Cookie': cookie})[0], 401)
        self.assertEqual(self.request(headers={'Authorization': 'Bearer forbidden'})[0], 401)
        self.assertEqual(self.auth.seen, [])
        self.assertEqual(self.request(headers={'Host': 'evil.example'})[0], 401)
        code, headers, body = self.request(headers={
            'Cookie': '__Host-infra=human_cookie; unrelated=never_forward',
            'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-Proto': 'http'})
        self.assertEqual(code, 200)
        path, received = self.auth.seen[-1]
        received = {key.lower(): value for key, value in received}
        self.assertEqual(path, '/api/auth/me')
        self.assertEqual(received['cookie'], '__Host-infra=human_cookie')
        self.assertNotIn('authorization', received)
        self.assertNotIn('human_cookie', body + str(headers))
        self.assertNotIn('never_forward', body + str(headers))
        self.assertIn('Secure; HttpOnly; SameSite=Strict', headers['Set-Cookie'])
        self.assertIn('Path=' + b.BASE, headers['Set-Cookie'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertIn("default-src 'none'", headers['Content-Security-Policy'])

    def test_duplicate_cookie_and_host_headers(self):
        self.refill()
        client = http.client.HTTPConnection(*self.server.server_address)
        client.putrequest('GET', b.BASE, skip_host=True)
        client.putheader('Host', b.HOST)
        client.putheader('Cookie', '__Host-infra=a')
        client.putheader('Cookie', '__Host-infra=b')
        client.endheaders()
        response = client.getresponse()
        self.assertEqual(response.status, 401)
        response.read()
        client.close()
        self.assertEqual(self.auth.seen, [])

    def test_sessions_csrf_origin_and_framing(self):
        self.home()
        self.assertNotIn('Set-Cookie', self.request()[1])
        self.assertEqual(len(self.server.state.sessions), 1)
        form = {'csrf': self.token, 'idempotency': self.key, 'destination': 'process'}
        for origin in ('https://evil.example', 'null', ''):
            self.assertEqual(self.request('POST', b.BASE + 'request', form,
                {'Origin': origin})[0], 403)
        form['csrf'] = 'wrong'
        self.assertEqual(self.request('POST', b.BASE + 'request', form)[0], 400)
        self.assertEqual(self.request('POST', b.BASE + 'request',
            {'csrf': self.token, 'padding': 'x' * 2048})[0], 400)
        self.assertEqual(self.request('POST', b.BASE + 'request', form,
            {'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request(path=b.BASE + '?secret=ignored')[0], 404)
        self.assertEqual(self.server.state.requests, {})

    def test_process_idempotency_preview_replay(self):
        self.home()
        rid = self.create()
        self.assertEqual(self.create(), rid)
        path = b.BASE + 'r/' + rid
        for _ in range(2):
            self.assertIn('pending', self.request(path=path)[2])
        self.assertEqual(self.action(rid, value='sk-real-key-rejected')[0], 400)
        self.assertIn('pending', self.request(path=path)[2])
        code, _, body = self.action(rid)
        self.assertEqual(code, 200)
        self.assertEqual(body, 'Status: used')
        self.assertNotIn(b.FIXTURE, body)
        self.assertEqual(self.action(rid)[0], 409)
        self.assertEqual(self.create(), rid)
        self.assertNotIn(b.FIXTURE, repr(self.server.state.requests))
        self.assertNotIn('value', self.server.state.requests[rid])

    def test_deny_expiration_and_ownership(self):
        self.home()
        rid = self.create()
        self.assertEqual(self.action(rid, 'deny', '')[2], 'Status: denied')
        self.assertEqual(self.action(rid)[0], 409)
        self.assertEqual(self.create(), rid)
        old_token = self.token
        self.token = None
        self.home()
        self.assertEqual(self.request(path=b.BASE + 'r/' + rid)[0], 404)
        self.assertEqual(self.action(rid)[0], 404)
        rid2 = self.create()
        # Keep the session alive independently so request expiration is observable.
        self.now += 301
        self.server.state.sessions[self.token]['expires'] = self.now + 100
        self.assertEqual(self.request(path=b.BASE + 'r/' + rid2)[0], 410)
        # Direct preview/action also refuse an expired record before pruning.
        with self.server.state.lock:
            self.server.state.requests['a' * 32] = {
                'session': self.token, 'owner': 'Owner', 'key': self.key,
                'destination': 'process', 'expires': self.now - 1, 'status': 'pending'}
        self.assertEqual(self.server.state.preview(self.token, 'a' * 32)['status'], 'expired')
        self.assertEqual(self.server.state.action(self.token, 'a' * 32, 'submit', b.FIXTURE)[0], 410)
        self.assertNotEqual(old_token, self.token)

    def test_race_one_action_and_no_ambiguous_repeat(self):
        self.home()
        rid = self.create()
        entered = threading.Event()
        release = threading.Event()
        def delivery(destination, value):
            entered.set()
            release.wait(2)
            return 'failed'
        with mock.patch.object(self.server.state, 'deliver', side_effect=delivery) as call:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self.action, rid)
                self.assertTrue(entered.wait(1))
                self.assertEqual(self.action(rid)[0], 409)
                self.assertIn('using', self.request(path=b.BASE + 'r/' + rid)[2])
                release.set()
                self.assertEqual(first.result()[2], 'Status: failed')
            self.assertEqual(self.action(rid)[0], 409)
            self.assertEqual(call.call_count, 1)

    def test_destination_policy_and_dotenv(self):
        self.home()
        for destination in ('/tmp/anything', 'https://evil.example', 'shell'):
            self.assertEqual(self.request('POST', b.BASE + 'request', {
                'csrf': self.token, 'idempotency': self.key,
                'destination': destination})[0], 400)
        self.assertEqual(self.request('POST', b.BASE + 'request', {
            'csrf': self.token, 'idempotency': self.key,
            'destination': 'process', 'owner': 'Other'})[0], 400)
        rid = self.create('dotenv')
        observed = []
        real_write = os.write
        def partial(fd, data):
            observed.append(os.fstat(fd).st_mode & 0o777)
            return real_write(fd, data[:3])
        self.server.state.write = partial
        self.assertEqual(self.action(rid)[2], 'Status: used')
        self.assertTrue(observed)
        self.assertEqual(set(observed), {0o600})
        self.assertEqual(os.listdir(self.temp.name), [])

    def test_dotenv_partial_failure_flush_and_unlink(self):
        state = self.server.state
        real_write = os.write
        calls = []
        def broken(fd, data):
            if calls:
                raise OSError('fixture write failure')
            calls.append(True)
            return real_write(fd, data[:2])
        state.write = broken
        self.assertEqual(state.deliver('dotenv', b.FIXTURE), 'failed')
        self.assertEqual(os.listdir(self.temp.name), [])
        state.write = real_write
        def bad_sync(fd):
            raise OSError('fixture flush failure')
        state.sync = bad_sync
        self.assertEqual(state.deliver('dotenv', b.FIXTURE), 'failed')
        self.assertEqual(os.listdir(self.temp.name), [])
        state.sync = os.fsync
        with mock.patch.object(b.os, 'unlink', side_effect=OSError('blocked')):
            self.assertEqual(state.deliver('dotenv', b.FIXTURE), 'failed_cleanup_required')
        leftovers = os.listdir(self.temp.name)
        self.assertEqual(len(leftovers), 1)
        os.unlink(leftovers[0], dir_fd=state.dirfd)
        self.assertEqual(state.deliver('unknown', b.FIXTURE), 'failed')
        self.assertEqual(state.deliver('process', 'sk-rejected'), 'failed')

    def test_no_overwrite(self):
        state = self.server.state
        name = 'fixture-' + 'c' * 32 + '.env'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=state.dirfd)
        os.write(fd, b'existing')
        os.close(fd)
        with mock.patch.object(b.secrets, 'token_hex', return_value='c' * 32):
            self.assertEqual(state.deliver('dotenv', b.FIXTURE), 'failed')
        fd = os.open(name, os.O_RDONLY, dir_fd=state.dirfd)
        self.assertEqual(os.read(fd, 20), b'existing')
        os.close(fd)
        os.unlink(name, dir_fd=state.dirfd)

    def test_rate_session_and_request_bounds(self):
        for _ in range(15):
            self.assertEqual(self.request(authenticated=False, refill=False)[0], 401)
        self.assertEqual(self.request(refill=False)[0], 429)
        self.assertEqual(self.auth.seen, [])
        self.now += 1
        self.assertEqual(self.request(authenticated=False, refill=False)[0], 401)
        state = self.server.state
        tokens = []
        for _ in range(64):
            token, session, fresh = state.session(None, True)
            self.assertTrue(fresh)
            tokens.append((token, session))
        self.assertEqual(state.session(None, True), (None, None, False))
        for token, session in tokens:
            self.assertEqual(state.create(token, session['idempotency'], 'process')[0], 201)
        self.assertEqual(len(state.requests), 64)
        # A different valid intent cannot exceed request capacity.
        token, session = tokens[0]
        state.sessions[token]['idempotency'] = 'f' * 32
        self.assertEqual(state.create(token, 'f' * 32, 'process')[0], 503)
        self.now += 301
        self.assertTrue(state.session(None, True)[2])
        self.assertEqual(len(state.requests), 64)

    def test_total_socket_deadline_and_worker_bound(self):
        clients = []
        try:
            for _ in range(8):
                client = socket.create_connection(self.server.server_address, timeout=2)
                clients.append(client)
                client.sendall(b'GET /credential-link/ HTTP/1.1\r\nHost: ')
            deadline = time.monotonic() + 2
            while len(self.server.timers) < 8 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertLessEqual(len(self.server.timers), 8)
            ninth = socket.create_connection(self.server.server_address, timeout=2)
            try:
                ninth.settimeout(2)
                self.assertEqual(ninth.recv(1), b'')
            finally:
                ninth.close()
            # Continuous partial header progress cannot extend the absolute timer.
            client = clients[0]
            started = time.monotonic()
            client.settimeout(5)
            try:
                result = client.recv(1)
                self.assertEqual(result, b'')
            except ConnectionResetError:
                pass
            self.assertLess(time.monotonic() - started, 4.8)
            self.assertEqual(self.auth.seen, [])
        finally:
            for client in clients:
                client.close()

    def test_production_overrides_rejected(self):
        with self.assertRaises(ValueError):
            b.make_server(owner='Owner')
        with self.assertRaises(ValueError):
            b.make_server(test_mode=True, owner='Owner', directory=self.temp.name,
                          auth_endpoint=('example.com', 80))
        with self.assertRaises(ValueError):
            b.State('', self.temp.name, self.auth.server_address)

    def json_reply(self, response, code):
        status, headers, body = response
        self.assertEqual(status, code)
        self.assertEqual(headers['Content-Type'], 'application/json; charset=utf-8')
        self.assertEqual(int(headers['Content-Length']), len(body.encode('utf-8')))
        self.assertEqual(headers['Connection'], 'close')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertNotIn(b.FIXTURE, body)
        return json.loads(body)

    def json_action(self, rid, action='submit', value=b.FIXTURE, headers=None):
        values = {'X-Credential-Link-CSRF': self.token}
        if headers:
            values.update(headers)
        return self.request('POST', b.BASE + 'api/r/' + rid,
                            {'action': action, 'value': value}, values)

    def test_json_bootstrap(self):
        path = b.BASE + 'api/bootstrap.json'
        code, headers, body = self.request(path=path, authenticated=False)
        self.assertEqual(code, 401)
        self.assertNotIn('Set-Cookie', headers)
        self.assertEqual(body, 'Human owner authentication required. Open the official panel at ' + b.ORIGIN + '/')
        self.assertEqual(self.server.state.sessions, {})
        wall = 1700000000.25
        with mock.patch.object(b.time, 'time', return_value=wall):
            response = self.request(path=path)
        obj = self.json_reply(response, 200)
        self.assertEqual(set(obj), {'csrf', 'expiresAt'})
        self.assertRegex(obj['csrf'], r'^[0-9a-f]{64}$')
        self.token = obj['csrf']
        self.assertEqual(response[1]['Set-Cookie'], b.CSRF_COOKIE + '=' + self.token
                         + '; Path=' + b.BASE + '; Secure; HttpOnly; SameSite=Strict; Max-Age=300')
        self.assertTrue(obj['expiresAt'].endswith('Z'))
        self.assertEqual(datetime.datetime.fromisoformat(obj['expiresAt'].replace('Z', '+00:00')).timestamp(), wall + 300)
        self.now += 10
        repeated = self.request(path=path)
        self.assertEqual(self.json_reply(repeated, 200), obj)
        self.assertNotIn('Set-Cookie', repeated[1])
        self.assertEqual(len(self.server.state.sessions), 1)
        self.assertNotIn('Set-Cookie', self.request()[1])
        self.now += 291
        renewed = self.json_reply(self.request(path=path), 200)
        self.assertNotEqual(renewed['csrf'], self.token)

    def test_json_bootstrap_capacity(self):
        state = self.server.state
        for _ in range(64):
            self.assertTrue(state.session(None, True)[2])
        for path in (b.BASE, b.BASE + 'api/bootstrap.json'):
            code, headers, body = self.request(path=path)
            self.assertEqual(code, 503)
            self.assertNotIn('Set-Cookie', headers)
            self.assertEqual(body, 'Open the authenticated pilot homepage first.')
        self.assertEqual(self.request(path=b.BASE + 'api/requests.json')[0], 403)
        self.token = next(iter(state.sessions))
        self.assertNotIn('Set-Cookie', self.request(path=b.BASE + 'api/bootstrap.json')[1])
        self.assertEqual(len(state.sessions), 64)

    def test_json_listing_and_detail(self):
        listing = b.BASE + 'api/requests.json'
        detail = b.BASE + 'api/r/'
        for path in (listing, detail + 'a' * 32 + '.json'):
            code, headers, body = self.request(path=path)
            self.assertEqual(code, 403)
            self.assertEqual(body, 'Open the authenticated pilot homepage first.')
            self.assertNotIn('Set-Cookie', headers)
        self.assertEqual(self.server.state.sessions, {})
        self.home()
        with mock.patch.object(b.time, 'time', return_value=1700000000):
            older = self.create()
        old_token = self.token
        old_key = self.key
        self.token = None
        self.home()
        with mock.patch.object(b.time, 'time', return_value=1700000001):
            newer = self.create('dotenv')
        self.assertEqual(self.action(newer, 'deny', '')[0], 200)
        response = self.request(path=listing)
        obj = self.json_reply(response, 200)
        self.assertEqual(set(obj), {'requests'})
        self.assertEqual([entry['id'] for entry in obj['requests']], [newer, older])
        for entry, status, destination, wall in (
                (obj['requests'][0], 'denied', 'dotenv', 1700000001),
                (obj['requests'][1], 'pending', 'process', 1700000000)):
            self.assertEqual(set(entry), {'id', 'status', 'destination', 'createdAt', 'expiresAt'})
            self.assertEqual(entry['status'], status)
            self.assertEqual(entry['destination'], destination)
            self.assertEqual(datetime.datetime.fromisoformat(entry['createdAt'].replace('Z', '+00:00')).timestamp(), wall)
            self.assertEqual(datetime.datetime.fromisoformat(entry['expiresAt'].replace('Z', '+00:00')).timestamp(), wall + 300)
            self.assertEqual(self.json_reply(self.request(path=detail + entry['id'] + '.json'), 200), entry)
        for forbidden in (old_token, self.token, old_key, self.key, 'csrf', 'session', 'idempotency', 'value', 'secret'):
            self.assertNotIn(forbidden, response[2])
        self.assertNotIn('Set-Cookie', response[1])
        self.assertEqual(self.request(path=b.BASE + 'r/' + older)[0], 404)
        self.assertEqual(self.action(older)[0], 404)
        for rid in ('f' * 32, 'malformed', 'A' * 32, 'a' * 31):
            self.assertEqual(self.json_reply(self.request(path=detail + rid + '.json'), 404), {'error': 'not found'})
        self.assertEqual(self.request(path=listing + '?x=1')[0], 404)
        self.assertEqual(self.request(path=listing + '#x')[0], 404)
        self.now += 301
        self.server.state.sessions[self.token]['expires'] = self.now + 100
        entries = self.json_reply(self.request(path=listing), 200)['requests']
        self.assertEqual([entry['status'] for entry in entries], ['denied', 'expired'])
        self.assertEqual(self.json_reply(self.request(path=detail + older + '.json'), 410), {'error': 'expired'})
        self.assertEqual(self.json_reply(self.json_action(older), 410), {'error': 'expired'})

    def test_json_action_validation_and_submit(self):
        self.home()
        rid = self.create()
        path = b.BASE + 'api/r/' + rid
        form = {'action': 'submit', 'value': b.FIXTURE}
        for headers in ({}, {'X-Credential-Link-CSRF': 'wrong'}):
            self.assertEqual(self.json_reply(self.request('POST', path, form, headers), 403), {'error': 'csrf'})
        for origin in ('https://evil.example', 'null', ''):
            response = self.json_action(rid, headers={'Origin': origin, 'Content-Length': '9999'})
            self.assertEqual(response[0], 403)
            self.assertEqual(response[2], 'Origin rejected.')
        csrf = {'X-Credential-Link-CSRF': self.token}
        for fields in ({'action': 'submit'},
                       {'action': 'submit', 'value': b.FIXTURE, 'unknown': ''},
                       {'action': 'submit', 'value': b.FIXTURE, 'csrf': self.token},
                       {'action': 'unknown'},
                       [('action', 'submit'), ('action', 'deny'), ('value', '')]):
            self.json_reply(self.request('POST', path, fields, csrf), 400)
        self.json_reply(self.json_action(rid, 'deny', b.FIXTURE), 400)
        self.assertEqual(self.json_reply(self.json_action(rid, value='sk-rejected'), 400), {'error': 'invalid fixture'})
        for headers in ({'Content-Type': 'application/json'},
                        {'Transfer-Encoding': 'chunked'},
                        {'Content-Length': '2049'},
                        {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'}):
            self.json_reply(self.json_action(rid, headers=headers), 400)
        self.assertEqual(self.server.state.requests[rid]['status'], 'pending')
        response = self.json_action(rid)
        self.assertEqual(self.json_reply(response, 200), {'status': 'used'})
        self.assertNotIn(self.token, response[2])
        self.assertNotIn('Set-Cookie', response[1])
        self.assertEqual(self.server.state.requests[rid]['status'], 'used')
        self.assertEqual(self.json_reply(self.json_action(rid), 409), {'status': 'used'})
        self.assertNotIn(b.FIXTURE, repr(self.server.state.requests))
        self.assertNotIn('value', self.server.state.requests[rid])
        self.assertEqual(self.json_reply(self.json_action('f' * 32), 404), {'error': 'not found'})
        self.assertEqual(self.json_reply(self.json_action('bad'), 404), {'error': 'not found'})

    def test_json_deny_and_no_creation_routes(self):
        self.home()
        rid = self.create()
        self.token = None
        self.home()
        self.assertEqual(self.request(path=b.BASE + 'r/' + rid)[0], 404)
        self.assertEqual(self.json_reply(self.request('POST', b.BASE + 'api/r/' + rid,
            {'action': 'deny'}, {'X-Credential-Link-CSRF': self.token}), 200), {'status': 'denied'})
        self.assertEqual(self.json_reply(self.json_action(rid), 409), {'status': 'denied'})
        rid2 = self.create()
        self.assertEqual(self.json_reply(self.json_action(rid2, 'deny', ''), 200), {'status': 'denied'})
        for path in ('api/request', 'api/requests.json', 'api/bootstrap.json', 'api/r/' + rid + '.json'):
            self.json_reply(self.request('POST', b.BASE + path, {'action': 'deny'},
                {'X-Credential-Link-CSRF': self.token}), 404)
        self.assertEqual(len(self.server.state.requests), 2)
        self.assertEqual(self.request('OPTIONS', b.BASE + 'api/requests.json')[0], 405)

    def test_json_cross_session_race_one_delivery(self):
        self.home()
        rid = self.create()
        original = self.token
        self.token = None
        self.home()
        self.assertNotEqual(self.token, original)
        self.assertEqual(self.request(path=b.BASE + 'r/' + rid)[0], 404)
        self.assertEqual(self.action(rid)[0], 404)
        self.assertEqual(self.json_reply(self.request(path=b.BASE + 'api/r/' + rid + '.json'), 200)['status'], 'pending')
        entered = threading.Event()
        release = threading.Event()
        def delivery(destination, value):
            self.assertEqual(destination, 'process')
            self.assertEqual(value, b.FIXTURE)
            entered.set()
            release.wait(2)
            return 'used'
        with mock.patch.object(self.server.state, 'deliver', side_effect=delivery) as call:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self.json_action, rid)
                try:
                    self.assertTrue(entered.wait(1))
                    self.assertEqual(self.json_reply(self.json_action(rid), 409), {'status': 'using'})
                    self.assertEqual(self.json_reply(self.request(path=b.BASE + 'api/r/' + rid + '.json'), 200)['status'], 'using')
                finally:
                    release.set()
                self.assertEqual(self.json_reply(first.result(), 200), {'status': 'used'})
            self.assertEqual(self.json_reply(self.json_action(rid), 409), {'status': 'used'})
            self.assertEqual(call.call_count, 1)

    def test_json_delivery_failure_outcomes(self):
        self.home()
        for outcome in ('failed', 'failed_cleanup_required'):
            rid = self.create()
            with mock.patch.object(self.server.state, 'deliver', return_value=outcome) as call:
                self.assertEqual(self.json_reply(self.json_action(rid), 200), {'status': outcome})
                self.assertEqual(self.json_reply(self.json_action(rid), 409), {'status': outcome})
                self.assertEqual(call.call_count, 1)
            self.token = None
            self.home()

    def test_json_shared_admission(self):
        path = b.BASE + 'api/bootstrap.json'
        for _ in range(15):
            self.assertEqual(self.request(path=path, authenticated=False, refill=False)[0], 401)
        self.assertEqual(self.request(refill=False)[0], 429)
        self.assertEqual(self.auth.seen, [])
        self.refill()
        for _ in range(15):
            self.assertEqual(self.request(authenticated=False, refill=False)[0], 401)
        self.assertEqual(self.request(path=path, refill=False)[0], 429)
        self.refill()
        response = self.request(path=path, refill=False)
        self.token = self.json_reply(response, 200)['csrf']
        self.assertEqual(self.server.state.tokens, 14)
        for _ in range(14):
            self.json_reply(self.request(path=b.BASE + 'api/requests.json', refill=False), 200)
        self.assertEqual(self.request(refill=False)[0], 429)

    def test_json_human_gates_and_missing_wall_times(self):
        self.home()
        rid = self.create()
        paths = ('api/bootstrap.json', 'api/requests.json', 'api/r/' + rid + '.json')
        for path in paths:
            for headers in ({'Authorization': 'Bearer forbidden'},
                            {'Host': 'evil.example'},
                            {'Cookie': '__Host-infra=a; x=1; x=2'}):
                response = self.request(path=b.BASE + path, headers=headers)
                self.assertEqual(response[0], 401)
                self.assertNotIn('Set-Cookie', response[1])
            self.auth.payload = b'{"agent":true,"name":"Owner"}'
            self.assertEqual(self.request(path=b.BASE + path)[0], 401)
            self.auth.payload = b'{"agent":false,"name":"Owner"}'
        self.auth.payload = b'{"agent":true,"name":"Owner"}'
        self.assertEqual(self.json_action(rid)[0], 401)
        self.assertEqual(self.server.state.requests[rid]['status'], 'pending')
        self.auth.payload = b'{"agent":false,"name":"Owner"}'
        with self.server.state.lock:
            record = self.server.state.requests[rid]
            del record['createdAt']
            del record['expiresAt']
            del record['created']
        entry = self.json_reply(self.request(path=b.BASE + 'api/r/' + rid + '.json'), 200)
        self.assertEqual(set(entry), {'id', 'status', 'destination'})
        self.assertEqual(self.json_reply(self.request(path=b.BASE + 'api/requests.json'), 200), {'requests': [entry]})
        with self.server.state.lock:
            record['owner'] = 'Other'
        self.assertEqual(self.json_reply(self.request(path=b.BASE + 'api/requests.json'), 200), {'requests': []})
        self.assertEqual(self.json_reply(self.request(path=b.BASE + 'api/r/' + rid + '.json'), 404), {'error': 'not found'})
        self.assertEqual(self.json_reply(self.json_action(rid), 404), {'error': 'not found'})


if __name__ == '__main__':
    unittest.main()
