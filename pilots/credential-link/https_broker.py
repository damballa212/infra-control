#!/usr/bin/env python3
"""Single-process, fixture-only broker. Run behind the configured nginx origin."""
import argparse
import collections
import datetime
import grp
import hashlib
import hmac
import html
import http.client
import http.server
import json
import os
import re
import secrets
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

ORIGIN = 'https://panel.example.com'
HOST = 'panel.example.com'
BASE = '/credential-link/'
SOCKET = '/run/credential-link-pilot/http.sock'
CONTROL_SOCKET = '/run/credential-link-pilot/control.sock'
POLICY = '/etc/credential-link-pilot/policy.json'
PRIVATE = '/var/lib/credential-link-pilot'
FIXTURE = 'FAKE_ONLY_0123456789abcdef0123456789abcdef'
CSRF_COOKIE = '__Secure-credential_link_pilot_csrf'
HEX = re.compile(r'^[0-9a-f]{32}$')
COOKIE_VALUE = re.compile(r'^[!#-+\--:<-\[\]-~]+$')
CHILD = "import os,sys; v=os.environ.get('OPENAI_API_KEY'); sys.stdout.write('fixture_received' if v=='FAKE_ONLY_0123456789abcdef0123456789abcdef' else 'rejected'); sys.exit(0 if v=='FAKE_ONLY_0123456789abcdef0123456789abcdef' else 1)"


class Reject(Exception):
    pass


def cookies(headers):
    """Reject ambiguous cookie syntax, including duplicate unrelated cookies."""
    values = headers.get_all('Cookie', [])
    if len(values) != 1 or len(values[0]) > 4096:
        raise Reject()
    result = {}
    for part in values[0].split(';'):
        part = part.strip()
        if not part or '=' not in part:
            raise Reject()
        name, value = part.split('=', 1)
        if not re.fullmatch(r'[!#$%&\x27*+.^_`|~0-9A-Za-z-]+', name):
            raise Reject()
        if not value or not COOKIE_VALUE.fullmatch(value) or name in result:
            raise Reject()
        result[name] = value
    if '__Host-infra' not in result:
        raise Reject()
    return result


def verify_human(owner, cookie, endpoint):
    """Fixed destination in production; never forward inbound headers wholesale."""
    connection = http.client.HTTPConnection(endpoint[0], endpoint[1], timeout=2)
    try:
        connection.request('GET', '/api/auth/me', headers={
            'Cookie': '__Host-infra=' + cookie,
            'Accept': 'application/json',
            'Connection': 'close',
        })
        response = connection.getresponse()
        if response.status != 200:
            return False
        data = response.read(4097)
        if len(data) > 4096:
            return False
        def unique(pairs):
            obj = {}
            for key, value in pairs:
                if key in obj:
                    raise ValueError('duplicate JSON member')
                obj[key] = value
            return obj
        obj = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
        return (isinstance(obj, dict) and obj.get('agent') is False
                and isinstance(obj.get('name'), str) and obj['name'] == owner)
    except Exception:
        return False
    finally:
        connection.close()


def timestamp(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


class State:
    def __init__(self, owner, directory, endpoint, clock=time.monotonic,
                 write=os.write, sync=os.fsync):
        if not isinstance(owner, str) or not owner.strip():
            raise ValueError('expected owner required')
        self.owner = owner
        self.endpoint = endpoint
        self.clock = clock
        self.write = write
        self.sync = sync
        self.lock = threading.Lock()
        self.sessions = {}
        self.requests = {}
        self.agent_request_id = None
        self.agent_key = secrets.token_hex(32)
        self.tokens = 15.0
        self.refill = clock()
        self.dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(self.dirfd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            os.close(self.dirfd)
            raise ValueError('private directory must be owned by runtime uid and mode 0700')

    def close(self):
        os.close(self.dirfd)

    def admit(self):
        with self.lock:
            now = self.clock()
            self.tokens = min(15.0, self.tokens + max(0, now - self.refill))
            self.refill = now
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True

    def prune(self):
        now = self.clock()
        for key, session in list(self.sessions.items()):
            if now >= session['expires']:
                del self.sessions[key]
        # Retain requests and idempotency for the entire bounded process lifetime.
        # Expired requests remain terminal and cannot be submitted or reused.

    def session(self, token, create=False):
        with self.lock:
            self.prune()
            if token in self.sessions:
                return token, dict(self.sessions[token]), False
            if not create or len(self.sessions) >= 64:
                return None, None, False
            token = secrets.token_hex(32)
            session = {'expires': self.clock() + 300,
                       'expiresAt': timestamp(time.time() + 300),
                       'idempotency': secrets.token_hex(16)}
            self.sessions[token] = session
            return token, dict(session), True

    def create(self, token, key, destination):
        if destination not in ('process', 'dotenv') or not HEX.fullmatch(key):
            return 400, None
        with self.lock:
            self.prune()
            session = self.sessions.get(token)
            if not session or not hmac.compare_digest(key, session['idempotency']):
                return 403, None
            for rid, request in self.requests.items():
                if request['session'] == token and request['key'] == key:
                    if request['destination'] != destination:
                        return 409, None
                    return 200, rid
            if len(self.requests) >= 64:
                return 503, None
            rid = secrets.token_hex(16)
            created = time.time()
            self.requests[rid] = {
                'session': token, 'owner': self.owner, 'key': key,
                'destination': destination, 'expires': self.clock() + 300,
                'createdAt': timestamp(created), 'expiresAt': timestamp(created + 300),
                'created': created, 'status': 'pending',
            }
            return 201, rid

    def agent_create(self):
        """One fixed intent per process; independent of human CSRF sessions."""
        with self.lock:
            if self.agent_request_id is not None:
                rid = self.agent_request_id
                return 200, self.summary(rid, self.requests[rid], self.clock())
            if len(self.requests) >= 64:
                return 503, None
            rid = secrets.token_hex(16)
            while rid in self.requests:
                rid = secrets.token_hex(16)
            created = time.time()
            request = {
                'session': None, 'owner': self.owner, 'key': self.agent_key,
                'project': 'infra-control-private', 'destination': 'process',
                'expires': self.clock() + 1800,
                'createdAt': timestamp(created), 'expiresAt': timestamp(created + 1800),
                'created': created, 'status': 'pending',
            }
            self.requests[rid] = request
            self.agent_request_id = rid
            return 201, self.summary(rid, request, self.clock())

    def agent_status(self, rid):
        with self.lock:
            # The local interface only observes its own fixed intent.
            if rid != self.agent_request_id:
                return 404, None
            request = self.requests.get(rid)
            if request is None:
                return 404, None
            return 200, self.summary(rid, request, self.clock())

    def lookup(self, token, rid, owner_scope=False):
        # Call only while holding the state lock.
        request = self.requests.get(rid)
        if not request:
            return None
        if owner_scope:
            if request['owner'] != self.owner:
                return None
        elif request['session'] != token:
            return None
        return request

    def summary(self, rid, request, now):
        result = {'id': rid, 'status': 'expired' if request['status'] == 'pending' and now >= request['expires'] else request['status'],
                  'destination': request['destination']}
        for key in ('createdAt', 'expiresAt'):
            if key in request:
                result[key] = request[key]
        return result

    def listing(self, token):
        with self.lock:
            now = self.clock()
            records = [(rid, request) for rid, request in self.requests.items()
                       if self.lookup(token, rid, True) is not None]
            records.sort(key=lambda item: item[1].get('created', float('-inf')), reverse=True)
            return [self.summary(rid, request, now) for rid, request in records]

    def preview(self, token, rid, owner_scope=False):
        with self.lock:
            request = self.lookup(token, rid, owner_scope)
            if request is None:
                return None
            if owner_scope:
                return self.summary(rid, request, self.clock())
            if request['status'] == 'pending' and self.clock() >= request['expires']:
                return {'status': 'expired'}
            return {'status': request['status']}

    def action(self, token, rid, action, value, owner_scope=False):
        if action not in ('submit', 'deny'):
            return 400, 'invalid action'
        if action == 'submit' and value != FIXTURE:
            return 400, 'only the predefined fixture is accepted'
        if action == 'deny' and value:
            return 400, 'deny does not accept a value'
        with self.lock:
            request = self.lookup(token, rid, owner_scope)
            if request is None:
                return 404, 'not found'
            if request['status'] == 'pending' and self.clock() >= request['expires']:
                return 410, 'expired'
            # Revalidate at the mutation boundary, not only before body IO.
            session = self.sessions.get(token)
            if session is None or self.clock() >= session['expires']:
                return 403, 'session expired'
            if request['status'] != 'pending':
                return 409, request['status']
            if action == 'deny':
                request['status'] = 'denied'
                return 200, 'denied'
            request['status'] = 'using'
            destination = request['destination']
        # No secret or fixture value is retained in request/session state.
        try:
            outcome = self.deliver(destination, value)
        except Exception:
            outcome = 'failed'
        finally:
            value = None
        with self.lock:
            request['status'] = outcome
        return 200, outcome

    def deliver(self, destination, value):
        if value != FIXTURE:
            return 'failed'
        if destination == 'process':
            try:
                result = subprocess.run(
                    [sys.executable, '-I', '-c', CHILD],
                    env={'OPENAI_API_KEY': value}, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    timeout=2, check=False, close_fds=True,
                )
                return ('used' if result.returncode == 0
                        and result.stdout == b'fixture_received' else 'failed')
            except Exception:
                return 'failed'
        if destination != 'dotenv':
            return 'failed'
        name = 'fixture-' + secrets.token_hex(16) + '.env'
        fd = None
        created = False
        outcome = 'failed'
        try:
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=self.dirfd)
            created = True
            info = os.fstat(fd)
            if stat.S_IMODE(info.st_mode) != 0o600 or not stat.S_ISREG(info.st_mode):
                raise OSError('unsafe file')
            data = ('OPENAI_API_KEY=' + value + '\n').encode('ascii')
            offset = 0
            while offset < len(data):
                count = self.write(fd, data[offset:])
                if not isinstance(count, int) or count <= 0 or count > len(data) - offset:
                    raise OSError('invalid write')
                offset += count
            self.sync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            if os.read(fd, len(data) + 1) != data:
                raise OSError('validation failed')
            # A close failure is terminal, even if unlink succeeds.
            closing = fd
            fd = None
            os.close(closing)
            outcome = 'used'
        except Exception:
            outcome = 'failed'
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    outcome = 'failed'
            if created:
                try:
                    os.unlink(name, dir_fd=self.dirfd)
                except OSError:
                    outcome = 'failed_cleanup_required'
        return outcome


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'FixtureBroker'
    sys_version = ''

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, 'Request rejected.', False)

    def reply(self, status, content, markup=True, cookie=None):
        if markup:
            content = '<!doctype html><html><head><meta charset="utf-8"><title>Fixture pilot</title></head><body>' + content + '</body></html>'
        data = content.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8' if markup else 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header('Set-Cookie', CSRF_COOKIE + '=' + cookie + '; Path=' + BASE + '; Secure; HttpOnly; SameSite=Strict; Max-Age=300')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def reply_json(self, status, content, cookie=None):
        data = json.dumps(content, ensure_ascii=True, separators=(',', ':')).encode('ascii')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', CSRF_COOKIE + '=' + cookie + '; Path=' + BASE + '; Secure; HttpOnly; SameSite=Strict; Max-Age=300')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def handle_expect_100(self):
        # Do not emit an interim response or read a body before the human gate.
        return True

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch()

    def do_PUT(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def do_PATCH(self):
        self.dispatch()

    def do_OPTIONS(self):
        self.dispatch()

    def do_TRACE(self):
        self.dispatch()

    def dispatch(self):
        state = self.server.state
        if not state.admit():
            return self.reply(429, 'Request limit reached.', False)
        try:
            if self.headers.get_all('Host', []) != [HOST]:
                raise Reject()
            if self.headers.get_all('Authorization', []):
                raise Reject()
            parsed = cookies(self.headers)
            if not verify_human(state.owner, parsed['__Host-infra'], state.endpoint):
                raise Reject()
        except Exception:
            return self.reply(401, 'Human owner authentication required. Open the official panel at ' + ORIGIN + '/', False)
        if self.command not in ('GET', 'POST'):
            return self.reply(405, 'Method not allowed.', False)
        if '?' in self.path or '#' in self.path:
            return self.reply(404, 'Not found.', False)
        root = self.command == 'GET' and self.path == BASE
        bootstrap = self.command == 'GET' and self.path == BASE + 'api/bootstrap.json'
        token, session, fresh = state.session(parsed.get(CSRF_COOKIE), create=root or bootstrap)
        if not session:
            return self.reply(503 if root or bootstrap else 403, 'Open the authenticated pilot homepage first.', False)
        if self.command == 'GET':
            # No bodies or ambiguous request framing are supported.
            if self.headers.get_all('Transfer-Encoding', []) or self.headers.get_all('Content-Length', []) not in ([], ['0']):
                return self.reply(400, 'Invalid framing.', False)
            if bootstrap:
                return self.reply_json(200, {'csrf': token, 'expiresAt': session['expiresAt']},
                                       cookie=token if fresh else None)
            if self.path == BASE + 'api/requests.json':
                return self.reply_json(200, {'requests': state.listing(token)})
            if self.path.startswith(BASE + 'api/'):
                match = re.fullmatch(re.escape(BASE) + r'api/r/([0-9a-f]{32})\.json', self.path)
                if not match:
                    return self.reply_json(404, {'error': 'not found'})
                preview = state.preview(token, match[1], owner_scope=True)
                if preview is None:
                    return self.reply_json(404, {'error': 'not found'})
                if preview['status'] == 'expired':
                    return self.reply_json(410, {'error': 'expired'})
                return self.reply_json(200, preview)
            if root:
                body = '<h1>Fixture-only credential pilot</h1><p>Only this fake fixture is accepted: <code>' + html.escape(FIXTURE) + '</code></p>'
                body += '<form method="post" action="' + BASE + 'request">'
                body += self.hidden('csrf', token) + self.hidden('idempotency', session['idempotency'])
                body += '<label>Destination <select name="destination"><option value="process">process</option><option value="dotenv">dotenv</option></select></label><button>Create fixture request</button></form>'
                return self.reply(200, body, cookie=token if fresh else None)
            match = re.fullmatch(re.escape(BASE) + r'r/([0-9a-f]{32})', self.path)
            if not match:
                return self.reply(404, 'Not found.', False)
            preview = state.preview(token, match[1])
            if preview is None:
                return self.reply(404, 'Not found.', False)
            body = '<p>Status: ' + html.escape(preview['status']) + '</p>'
            if preview['status'] == 'pending':
                body += '<form method="post" action="' + html.escape(self.path, quote=True) + '">' + self.hidden('csrf', token)
                body += '<label>Fixture <input name="value" type="password" autocomplete="off" maxlength="128"></label><button name="action" value="submit">Submit fixture</button><button name="action" value="deny">Deny</button></form>'
            return self.reply(410 if preview['status'] == 'expired' else 200, body)
        if self.headers.get_all('Origin', []) != [ORIGIN]:
            return self.reply(403, 'Origin rejected.', False)
        if self.path.startswith(BASE + 'api/'):
            match = re.fullmatch(re.escape(BASE) + r'api/r/([0-9a-f]{32})', self.path)
            if not match:
                return self.reply_json(404, {'error': 'not found'})
            csrf = self.headers.get_all('X-Credential-Link-CSRF', [])
            if len(csrf) != 1 or not hmac.compare_digest(csrf[0].encode('utf-8'), token.encode('ascii')):
                return self.reply_json(403, {'error': 'csrf'})
            try:
                form = self.read_form()
            except Exception:
                return self.reply_json(400, {'error': 'invalid form'})
            action = form.get('action')
            if (action == 'submit' and set(form) != {'action', 'value'}
                    or action == 'deny' and set(form) not in ({'action'}, {'action', 'value'})
                    or action not in ('submit', 'deny')):
                return self.reply_json(400, {'error': 'invalid fields'})
            code, status = state.action(token, match[1], action, form.get('value', ''), owner_scope=True)
            if code in (200, 409):
                return self.reply_json(code, {'status': status})
            if code == 400:
                status = 'invalid fixture' if action == 'submit' else 'invalid value'
            return self.reply_json(code, {'error': status})
        try:
            form = self.read_form()
            csrf = form.get('csrf', '')
            if not hmac.compare_digest(csrf, token):
                raise Reject()
        except Exception:
            return self.reply(400, 'Invalid form or CSRF token.', False)
        if self.path == BASE + 'request':
            if set(form) != {'csrf', 'idempotency', 'destination'}:
                return self.reply(400, 'Invalid fields.', False)
            code, rid = state.create(token, form['idempotency'], form['destination'])
            if rid:
                return self.reply(code, '<a href="' + BASE + 'r/' + rid + '">Preview fixture request</a>')
            return self.reply(code, 'Request rejected.', False)
        match = re.fullmatch(re.escape(BASE) + r'r/([0-9a-f]{32})', self.path)
        if not match:
            return self.reply(404, 'Not found.', False)
        if not {'csrf', 'action'} <= set(form) or not set(form) <= {'csrf', 'action', 'value'}:
            return self.reply(400, 'Invalid fields.', False)
        code, status = state.action(token, match[1], form['action'], form.get('value', ''))
        return self.reply(code, 'Status: ' + status, False)

    @staticmethod
    def hidden(name, value):
        return '<input type="hidden" name="' + name + '" value="' + html.escape(value, quote=True) + '">'

    def read_form(self):
        if self.headers.get_all('Transfer-Encoding', []):
            raise Reject()
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,4}', lengths[0]):
            raise Reject()
        size = int(lengths[0])
        if size > 2048 or self.headers.get_all('Content-Type', []) != ['application/x-www-form-urlencoded']:
            raise Reject()
        data = self.rfile.read(size)
        if len(data) != size:
            raise Reject()
        text = data.decode('ascii')
        if re.search(r'%(?![0-9A-Fa-f]{2})', text):
            raise Reject()
        pairs = urllib.parse.parse_qsl(text, keep_blank_values=True,
                                      strict_parsing=True, encoding='utf-8',
                                      errors='strict', max_num_fields=8)
        form = {}
        for key, value in pairs:
            if key in form:
                raise Reject()
            form[key] = value
        return form


class BoundedServer(socketserver.ThreadingMixIn):
    daemon_threads = False
    block_on_close = True

    def initialize_limits(self):
        self.slots = threading.BoundedSemaphore(8)
        self.timers = {}
        self.timer_lock = threading.Lock()

    def get_request(self):
        client, address = super().get_request()
        client.settimeout(4)
        def expire():
            # Closing the client does not cancel an admitted destination action.
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            client.close()
        timer = threading.Timer(4, expire)
        timer.daemon = True
        with self.timer_lock:
            self.timers[client] = timer
        timer.start()
        return client, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def shutdown_request(self, request):
        with self.timer_lock:
            timer = self.timers.pop(request, None)
        if timer:
            timer.cancel()
        super().shutdown_request(request)

    def handle_error(self, request, client_address):
        pass


class TCPServer(BoundedServer, http.server.HTTPServer):
    allow_reuse_address = False
    request_queue_size = 8


class UnixServer(BoundedServer, socketserver.UnixStreamServer):
    request_queue_size = 8


class ControlHandler(socketserver.BaseRequestHandler):
    """One JSON line and write EOF per connection; no retrieval or actions."""

    def handle(self):
        # Authenticate the kernel peer before reading any application bytes.
        try:
            credentials = self.request.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            _, uid, _ = struct.unpack('3i', credentials)
            if uid != self.server.allowed_uid:
                self.reply({'error': 'denied'})
                return
        except (OSError, AttributeError, struct.error):
            return
        try:
            data = bytearray()
            while True:
                chunk = self.request.recv(1025 - len(data))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 1024:
                    raise ValueError()
            if not data.endswith(b'\n') or data.count(b'\n') != 1:
                raise ValueError()
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError()
                    result[key] = value
                return result
            obj = json.loads(data[:-1].decode('utf-8'), object_pairs_hook=unique,
                             parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
            if not isinstance(obj, dict):
                raise ValueError()
            if obj == {'op': 'create'}:
                code, summary = self.server.state.agent_create()
            elif (set(obj) == {'op', 'id'} and obj['op'] == 'status'
                  and isinstance(obj['id'], str) and HEX.fullmatch(obj['id'])):
                code, summary = self.server.state.agent_status(obj['id'])
            else:
                raise ValueError()
        except (ValueError, UnicodeError, OSError, RecursionError):
            self.reply({'error': 'invalid request'})
            return
        if summary is None:
            self.reply({'error': 'capacity' if code == 503 else 'not found'})
            return
        result = {'request': summary}
        if obj['op'] == 'create':
            result['url'] = ORIGIN + '/ajustes/credenciales/' + summary['id']
        self.reply(result)

    def reply(self, content):
        try:
            self.request.sendall(json.dumps(content, separators=(',', ':')).encode('ascii') + b'\n')
        except OSError:
            pass


def make_control_server(state, *, test_mode=False, path=None, allowed_uid=None):
    if not test_mode:
        if path is not None or allowed_uid is not None:
            raise ValueError('production overrides forbidden')
        path, allowed_uid = CONTROL_SOCKET, 0
    elif (not isinstance(path, str) or not os.path.isabs(path)
          or type(allowed_uid) is not int or allowed_uid < 0):
        raise ValueError('explicit test configuration required')
    if not hasattr(socket, 'SO_PEERCRED'):
        raise ValueError('Linux SO_PEERCRED required')
    parent = os.stat(os.path.dirname(path), follow_symlinks=False)
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid()
            or parent.st_mode & 0o022):
        raise ValueError('socket parent must be runtime-owned and not writable by others')
    if os.path.lexists(path):
        raise ValueError('socket already exists')
    server = UnixServer(path, ControlHandler, bind_and_activate=False)
    server.initialize_limits()
    server.state = state
    server.allowed_uid = allowed_uid
    try:
        old = os.umask(0o177)
        try:
            server.server_bind()
        finally:
            os.umask(old)
        info = os.lstat(path)
        server.socket_path = path
        server.socket_identity = (info.st_dev, info.st_ino)
        os.chmod(path, 0o600)
        server.server_activate()
        return server
    except Exception:
        server.server_close()
        remove_socket(server)
        raise


def make_server(*, test_mode=False, owner=None, directory=None,
                auth_endpoint=None, clock=None, write=None, sync=None):
    """Test injections are explicit Python arguments, never environment switches."""
    if not test_mode:
        if any(x is not None for x in (owner, directory, auth_endpoint, clock, write, sync)):
            raise ValueError('production overrides forbidden')
        owner = load_policy()
        directory = PRIVATE
        auth_endpoint = ('127.0.0.1', 17600)
    else:
        if not owner or directory is None or auth_endpoint is None:
            raise ValueError('explicit test configuration required')
        if auth_endpoint[0] != '127.0.0.1':
            raise ValueError('test authentication must use loopback')
    state = State(owner, directory, auth_endpoint, clock or time.monotonic,
                  write or os.write, sync or os.fsync)
    server = None
    try:
        if test_mode:
            server = TCPServer(('127.0.0.1', 0), Handler, bind_and_activate=False)
            server.initialize_limits()
            server.state = state
            server.server_bind()
            server.server_activate()
        else:
            parent = os.stat(os.path.dirname(SOCKET), follow_symlinks=False)
            if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid()
                    or parent.st_mode & 0o022):
                raise ValueError('socket parent must be runtime-owned and not writable by others')
            # Never remove an existing socket or another process's endpoint.
            if os.path.lexists(SOCKET):
                raise ValueError('socket already exists')
            old = os.umask(0o177)
            try:
                server = UnixServer(SOCKET, Handler, bind_and_activate=False)
                server.initialize_limits()
                server.state = state
                server.server_bind()
            finally:
                os.umask(old)
            info = os.lstat(SOCKET)
            server.socket_identity = (info.st_dev, info.st_ino)
            server.socket_path = SOCKET
            os.chown(SOCKET, os.geteuid(), grp.getgrnam('www-data').gr_gid)
            os.chmod(SOCKET, 0o660)
            server.server_activate()
        return server
    except Exception:
        if server is not None:
            server.server_close()
            remove_socket(server)
        state.close()
        raise


def load_policy():
    fd = os.open(POLICY, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o440
                or info.st_gid != grp.getgrnam('www-data').gr_gid):
            raise ValueError('policy must be a private root-owned regular file')
        data = os.read(fd, 4097)
        if len(data) > 4096:
            raise ValueError('policy too large')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('duplicate policy key')
                result[key] = value
            return result
        policy = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
        if not isinstance(policy, dict) or set(policy) != {'owner'}:
            raise ValueError('policy must contain only owner')
        owner = policy['owner']
        if not isinstance(owner, str) or not owner.strip():
            raise ValueError('owner required')
        return owner
    finally:
        os.close(fd)


def remove_socket(server):
    identity = getattr(server, 'socket_identity', None)
    if identity:
        path = server.socket_path
        try:
            info = os.lstat(path)
            if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == identity:
                os.unlink(path)
        except FileNotFoundError:
            pass


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    server = None
    control = None
    control_thread = None
    stopping = threading.Event()
    serving = threading.Event()
    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            if serving.is_set():
                threading.Thread(target=server.shutdown, daemon=True).start()
    # Signals during partial initialization request cleanup instead of exiting.
    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        server = make_server()
        if stopping.is_set():
            return
        control = make_control_server(server.state)
        control_thread = threading.Thread(
            target=control.serve_forever, kwargs={'poll_interval': 0.1})
        control_thread.start()
        serving.set()
        if not stopping.is_set():
            server.serve_forever(poll_interval=0.1)
    finally:
        try:
            if control_thread is not None and control_thread.ident is not None:
                control.shutdown()
                control_thread.join()
        finally:
            try:
                if control is not None:
                    try:
                        control.server_close()
                    finally:
                        remove_socket(control)
            finally:
                try:
                    if server is not None:
                        try:
                            server.server_close()
                        finally:
                            try:
                                remove_socket(server)
                            finally:
                                server.state.close()
                finally:
                    for sig, handler in previous.items():
                        signal.signal(sig, handler)


if __name__ == '__main__':
    main()
