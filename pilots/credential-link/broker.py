import hashlib
import hmac
import html
import json
import os
import re
import secrets
import socket
import stat
import subprocess
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# Fixture-only HTTP loopback. El mismo UID no es una frontera de seguridad.
FIXTURE = re.compile(r"FAKE_ONLY_[a-f0-9]{32}", re.ASCII)
CHILD = (
    "import os,re;"
    "assert re.fullmatch(r'FAKE_ONLY_[a-f0-9]{32}',os.environ['OPENAI_API_KEY']);"
    "print('fixture_received')"
)


class Broker(ThreadingHTTPServer):
    daemon_threads = False  # server_close joins handlers before closing dir_fd.
    SESSION_TTL = 300
    REQUEST_DEADLINE = 8
    MAX_REQUESTS = 64  # Idempotency retained for the entire bounded pilot lifetime.
    MAX_SESSIONS = 128

    def service_actions(self):
        with self.lock:
            self.sweep()

    def __init__(self, private_dir):
        self.agent_token = secrets.token_urlsafe(32)
        self.owner_token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.worker_slots = threading.BoundedSemaphore(8)
        self.requests, self.sessions, self.idempotency = {}, {}, {}
        self.dir_fd = os.open(
            private_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        try:
            info = os.fstat(self.dir_fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("Directorio inválido")
            os.fchmod(self.dir_fd, 0o700)
            super().__init__(("127.0.0.1", 0), Handler)
        except BaseException:
            os.close(self.dir_fd)
            raise
        self.origin = f"http://127.0.0.1:{self.server_port}"

    def process_request(self, request, client_address):
        if not self.worker_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.worker_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.worker_slots.release()

    def handle_error(self, request, client_address):
        pass  # Never emit raw request/exception data. Status is fail-closed.

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def server_close(self):
        super().server_close()
        if self.dir_fd is not None:
            os.close(self.dir_fd)
            self.dir_fd = None

    def sweep(self):
        now = time.monotonic()
        for request in self.requests.values():
            if now >= request["deadline"]:
                request.pop("value", None)
                if request["status"] in ("pending", "ready"):
                    request["status"] = "expired"
        for key, session in list(self.sessions.items()):
            if now >= session["deadline"]:
                del self.sessions[key]


class Handler(BaseHTTPRequestHandler):
    server_version = "FixtureBroker"
    sys_version = ""

    def setup(self):
        super().setup()
        self.total_timer = threading.Timer(self.server.REQUEST_DEADLINE, self.abort_request)
        self.total_timer.daemon = True
        self.total_timer.start()

    def abort_request(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()

    def finish(self):
        try:
            super().finish()
        finally:
            self.total_timer.cancel()

    def log_message(self, *args):
        pass

    def reply(self, code, body, cookie=None):
        if getattr(self, 'deferred', False):
            self.pending_reply = (code, body, cookie)
            return None
        is_html = isinstance(body, str)
        payload = body.encode() if is_html else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8" if is_html
                         else "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; frame-ancestors 'none'; "
                         "form-action 'self'; base-uri 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        if cookie:
            self.send_header("Set-Cookie",
                             f"session={cookie}; HttpOnly; SameSite=Strict; Path=/")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def fail(self):
        self.reply(400, {"error": "Solicitud inválida"})

    def one_header(self, name):
        values = self.headers.get_all(name, [])
        return values[0] if len(values) == 1 else None

    def agent(self):
        actual = self.one_header("Authorization") or ""
        expected = "Bearer " + self.server.agent_token
        return hmac.compare_digest(actual.encode(), expected.encode())

    def session(self):
        try:
            cookie = SimpleCookie()
            cookie.load(self.one_header("Cookie") or "")
            key = cookie["session"].value
            return key, self.server.sessions.get(key)
        except (KeyError, ValueError):
            return None, None

    def new_session(self, authenticated=False):
        if len(self.server.sessions) >= self.server.MAX_SESSIONS:
            raise ValueError()
        key, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        session = {"csrf": csrf, "authenticated": authenticated,
                   "deadline": time.monotonic() + self.server.SESSION_TTL}
        self.server.sessions[key] = session
        return key, session

    def form(self, identifier, session):
        esc = lambda value: html.escape(value, quote=True)
        hidden = (f'<input type="hidden" name="id" value="{esc(identifier)}">'
                  f'<input type="hidden" name="csrf" value="{esc(session["csrf"])}">')
        if session["authenticated"]:
            action = f"/r/{identifier}"
            fields = ('<label>Fixture <input type="password" name="fixture" '
                      'autocomplete="off"></label>'
                      '<button name="action" value="submit">Enviar</button>'
                      '<button name="action" value="deny">Denegar</button>')
        else:
            action = "/login"
            fields = ('<label>Owner token <input type="password" name="owner_token" '
                      'autocomplete="off" required></label><button>Entrar</button>')
        return ('<!doctype html><meta charset="utf-8"><title>Fixture local</title>'
                '<p>Solo fixtures locales; nunca claves reales.</p>'
                '<p>Proyecto: fixture-app. Credencial: OPENAI_API_KEY. '
                f'Destino: {esc(self.server.requests[identifier]["target"])}. '
                'Uso único; sin conexión a OpenAI.</p>'
                f'<form method="post" action="{action}">{hidden}{fields}</form>')

    def body(self, api):
        if self.headers.get_all("Transfer-Encoding"):
            raise ValueError()
        length = self.one_header("Content-Length")
        if not length or not re.fullmatch(r"[0-9]{1,4}", length):
            raise ValueError()
        size = int(length)
        if not 0 < size <= 4096:
            raise ValueError()
        kind = (self.one_header("Content-Type") or "").split(";")[0].strip()
        if kind != ("application/json" if api else "application/x-www-form-urlencoded"):
            raise ValueError()
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise ValueError()
        if api:
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        fields = parse_qs(raw.decode("utf-8"), keep_blank_values=True,
                          strict_parsing=True, max_num_fields=8)
        if any(len(values) != 1 for values in fields.values()):
            raise ValueError()
        return {key: values[0] for key, values in fields.items()}

    def do_GET(self):
        self.dispatch(False)

    def do_POST(self):
        self.dispatch(True)

    def dispatch(self, post):
        try:
            if self.one_header("Host") != urlsplit(self.server.origin).netloc:
                return self.fail()
            if "?" in self.path or "#" in self.path:
                return self.fail()
            parts = self.path.split("/")
            api = len(parts) >= 2 and parts[1] in ("requests", "use")
            if api and not self.agent():
                return self.fail()
            data = self.body(api) if post else {}
            if post and not api and self.one_header("Origin") != self.server.origin:
                return self.fail()
            with self.server.lock:
                self.server.sweep()
                self.deferred = True
                operation = self.route(parts, post, data)
            self.deferred = False
            if callable(operation):
                operation()
            else:
                self.reply(*self.pending_reply)
        except Exception:
            self.deferred = False
            self.fail()

    def route(self, parts, post, data):
        broker = self.server
        if parts == ["", "requests"] and post:
            if set(data) != {"target", "ttl"}:
                return self.fail()
            target, ttl = data["target"], data["ttl"]
            idem = self.one_header("Idempotency-Key") or ""
            if (target not in ("process", "dotenv") or type(ttl) is not int
                    or not 1 <= ttl <= 300
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", idem)):
                return self.fail()
            digest = hashlib.sha256(idem.encode()).hexdigest()
            previous = broker.idempotency.get(digest)
            if previous:
                identifier = previous
                request = broker.requests[identifier]
                if (request["target"], request["ttl"]) != (target, ttl):
                    return self.fail()
            else:
                if len(broker.requests) >= broker.MAX_REQUESTS:
                    return self.fail()
                identifier = secrets.token_hex(16)
                request = {"target": target, "ttl": ttl, "status": "pending",
                           "deadline": time.monotonic() + ttl,
                           "expires": time.time() + ttl}
                broker.requests[identifier] = request
                broker.idempotency[digest] = identifier
            return self.reply(200, {"id": identifier, "expires": request["expires"],
                                   "link": broker.origin + "/r/" + identifier,
                                   "status": request["status"]})
        if parts == ["", "login"] and post:
            key, session = self.session()
            identifier = data.get("id", "")
            if (not session or data.get("csrf") != session["csrf"]
                    or identifier not in broker.requests
                    or not hmac.compare_digest(
                        data.get("owner_token", "").encode(), broker.owner_token.encode())):
                return self.fail()
            del broker.sessions[key]
            key, session = self.new_session(True)
            return self.reply(200, self.form(identifier, session), key)
        if len(parts) != 3 or parts[1] not in ("requests", "r", "use"):
            return self.fail()
        kind, identifier = parts[1:]
        request = broker.requests.get(identifier)
        if request is None:
            return self.fail()
        if kind == "requests" and not post:
            return self.reply(200, {"status": request["status"]})
        if kind == "r":
            key, session = self.session()
            if not post:
                if not session:
                    key, session = self.new_session()
                return self.reply(200, self.form(identifier, session), key)
            if (not session or not session["authenticated"]
                    or data.get("csrf") != session["csrf"]
                    or data.get("id") != identifier or request["status"] != "pending"):
                return self.fail()
            action = data.get("action")
            if action == "deny":
                request["status"] = "denied"
            elif action == "submit" and FIXTURE.fullmatch(data.get("fixture", "")):
                request["value"], request["status"] = data["fixture"], "ready"
            else:
                return self.fail()
            return self.reply(200, {"status": request["status"]})
        if kind != "use" or not post or data or request["status"] != "ready":
            return self.fail()
        value = request.pop("value")
        request["status"] = "using"
        return lambda: self.perform_use(request, identifier, value)

    def perform_use(self, request, identifier, value):
        broker = self.server
        created = False
        outcome = "failed"
        try:
            if request["target"] == "process":
                result = subprocess.run(
                    [sys.executable, "-I", "-c", CHILD],
                    env={"PATH": os.defpath, "OPENAI_API_KEY": value},
                    stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
                if result.returncode != 0 or result.stdout != b"fixture_received\n":
                    raise ValueError()
            else:
                fd = os.open("env-" + identifier,
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=broker.dir_fd)
                created = True
                with os.fdopen(fd, "w", encoding="ascii") as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    stream.write("OPENAI_API_KEY=" + value + "\n")
            outcome = "used"
        except Exception:
            if created:
                try:
                    os.unlink("env-" + identifier, dir_fd=broker.dir_fd)
                except OSError:
                    outcome = "failed_cleanup_required"
        finally:
            value = None
            with broker.lock:
                request["status"] = outcome
        return self.reply(200, {"status": outcome})


if __name__ == "__main__":
    print("Ejecuta los tests de fixtures; este módulo no publica un servidor.")