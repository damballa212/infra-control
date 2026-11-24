import contextlib
import io
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import infra_secrets

FAKE = "FAKE_ONLY_" + "ef" * 16
TOKEN = "tok-fake"


class FakePanel(BaseHTTPRequestHandler):
    state = "approved"
    created_state = "pending"  # "approved" simula un ítem encontrado en la bóveda (autoDeliver)
    claims = 0
    seen = []
    outages = 0  # respuestas 502 antes de responder bien (relevo del panel)

    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        FakePanel.seen.append((self.path, body, self.headers.get("Idempotency-Key")))
        if not self.authorized():
            return self.reply(401, {"error": "Token no válido."})
        if self.path == "/api/secrets/requests":
            return self.reply(201, {"id": "r1", "state": FakePanel.created_state, "url": "https://panel.example/secretos/r1"})
        if self.path == "/api/secrets/requests/r1/claim":
            FakePanel.claims += 1
            return self.reply(200, {"name": "OPENAI_API_KEY", "value": FAKE, "destination": {"kind": "dotenv", "path": ".env.local"}})
        self.reply(404, {})

    def do_GET(self):
        if FakePanel.outages > 0:
            FakePanel.outages -= 1
            return self.reply(502, {})
        if self.path == "/api/secrets/requests/r1":
            FakePanel.status_gets = getattr(FakePanel, "status_gets", 0) + 1
            return self.reply(200, {"id": "r1", "state": FakePanel.state})
        if self.path.startswith("/api/secrets/available?"):
            FakePanel.seen.append((self.path, None, None))
            if not self.authorized():
                return self.reply(401, {"error": "Token no válido."})
            return self.reply(200, {"items": [{"name": "OPENAI_API_KEY", "updatedAt": "2026-11-24T00:00:00Z"}]})
        self.reply(404, {})


class CliTests(unittest.TestCase):
    def setUp(self):
        FakePanel.state, FakePanel.claims, FakePanel.seen, FakePanel.outages = "approved", 0, [], 0
        FakePanel.created_state = "pending"
        self.server = HTTPServer(("127.0.0.1", 0), FakePanel)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"INFRA_CONTROL_URL": f"http://127.0.0.1:{self.server.server_port}", "INFRA_SECRETS_TOKEN": TOKEN})
        self.env.start()
        os.environ.pop("CLAUDECODE", None)  # la detección automática no debe depender de quién ejecuta el test
        self.chdir = mock.patch("infra_secrets.Path.cwd", return_value=self.cwd)
        self.chdir.start()

    def tearDown(self):
        self.chdir.stop()
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = infra_secrets.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    BASE = ("request", "OPENAI_API_KEY", "--project", "prod-erp", "--dest", ".env.local", "--reason", "pruebas", "--machine", "mac")

    def test_approved_request_writes_env_and_never_prints_the_value(self):
        code, out, err = self.run_cli(*self.BASE, "--wait", "5")
        self.assertEqual(code, 0)
        self.assertEqual((self.cwd / ".env.local").read_text(), f"OPENAI_API_KEY={FAKE}\n")
        self.assertEqual(stat.S_IMODE((self.cwd / ".env.local").stat().st_mode), 0o600)
        self.assertNotIn(FAKE, out + err)
        self.assertEqual(json.loads(out)["written"], ["OPENAI_API_KEY"])
        self.assertIn("https://panel.example/secretos/r1", err)

    def test_found_in_vault_delivers_with_zero_wait_and_no_approval_link(self):
        FakePanel.created_state = "approved"
        FakePanel.status_gets = 0
        code, out, err = self.run_cli(*self.BASE, "--wait", "0")
        self.assertEqual(FakePanel.status_gets, 0)  # reclama directo, sin consultar el estado
        self.assertEqual(code, 0)
        self.assertEqual((self.cwd / ".env.local").read_text(), f"OPENAI_API_KEY={FAKE}\n")
        self.assertIn("Aprobada de inmediato", err)
        self.assertNotIn("Aprueba aquí", err)
        self.assertNotIn(FAKE, out + err)

    def test_list_returns_only_names(self):
        code, out, _ = self.run_cli("list", "--project", "prod-erp", "--env", "dev")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["names"], ["OPENAI_API_KEY"])
        self.assertEqual(FakePanel.seen[-1][0], "/api/secrets/available?project=prod-erp&environment=dev")

    def test_sends_bearer_idempotency_key_and_exact_body(self):
        self.run_cli(*self.BASE, "--wait", "5")
        path, body, key = FakePanel.seen[0]
        self.assertEqual(path, "/api/secrets/requests")
        self.assertTrue(key.startswith("cli-"))
        self.assertEqual(body["destination"], {"kind": "dotenv", "path": ".env.local"})
        self.assertEqual(body["machine"], "mac - agente")

    def test_client_label_reaches_the_panel_in_a_valid_form(self):
        self.run_cli(*self.BASE, "--client", "Codex · CLI", "--wait", "5")
        self.assertEqual(FakePanel.seen[0][1]["machine"], "mac - Codex CLI")

    def test_labels_are_sanitized_and_bounded(self):
        self.assertEqual(infra_secrets.machine_label("MacBook Air", "Claude Code"), "MacBook Air - Claude Code")
        self.assertEqual(infra_secrets.machine_label("·equipo/raro", "x" * 80)[:8], "equipo r")
        self.assertLessEqual(len(infra_secrets.machine_label("a" * 70, "b")), 64)

    def test_detects_claude_code_automatically(self):
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1"}):
            self.assertEqual(infra_secrets.default_client(), "Claude Code")

    def test_machine_name_comes_from_the_installer_file(self):
        config = self.cwd / "cfg"
        config.mkdir()
        (config / "machine").write_text("PC Windows\n")
        with mock.patch.object(infra_secrets, "CONFIG_DIR", config):
            self.assertEqual(infra_secrets.default_machine(), "PC Windows")

    def test_setup_creates_private_token_once_and_prints_only_its_hash(self):
        import hashlib
        config = self.cwd / "cfg-setup"
        with mock.patch.object(infra_secrets, "CONFIG_DIR", config):
            code, out, _ = self.run_cli("setup", "--machine", "MacBook Air")
            first = json.loads(out)
            token = (config / "token").read_text().strip()
            self.assertEqual(code, 0)
            self.assertEqual(first, {"machine": "MacBook Air", "tokenCreated": True, "tokenSha256": hashlib.sha256(token.encode()).hexdigest()})
            self.assertNotIn(token, out)
            self.assertEqual(stat.S_IMODE((config / "token").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o700)
            self.assertEqual((config / "machine").read_text().strip(), "MacBook Air")
            again = json.loads(self.run_cli("setup", "--machine", "MacBook Air")[1])
            self.assertFalse(again["tokenCreated"])
            self.assertEqual(again["tokenSha256"], first["tokenSha256"])
            self.assertEqual(self.run_cli("setup", "--machine", "x", "--url", "http://panel.example")[0], 1)

    def test_pending_exits_4_with_the_approval_url_and_writes_nothing(self):
        FakePanel.state = "pending"
        code, out, _ = self.run_cli(*self.BASE, "--wait", "0")
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out), {"id": "r1", "state": "pending", "url": "https://panel.example/secretos/r1"})
        self.assertFalse((self.cwd / ".env.local").exists())
        self.assertEqual(FakePanel.claims, 0)

    def test_fetch_of_a_pending_request_rebuilds_the_approval_url(self):
        FakePanel.state = "pending"
        code, out, _ = self.run_cli("fetch", "r1", "--wait", "0")
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["url"], f"http://127.0.0.1:{self.server.server_port}/secretos/r1")

    def test_denied_and_expired_have_distinct_exit_codes(self):
        FakePanel.state = "denied"
        self.assertEqual(self.run_cli(*self.BASE, "--wait", "5")[0], 2)
        FakePanel.state = "expired"
        self.assertEqual(self.run_cli(*self.BASE, "--wait", "5")[0], 3)
        self.assertEqual(FakePanel.claims, 0)

    def test_waiting_survives_a_panel_restart_and_prints_progress_once(self):
        FakePanel.outages = 2
        with mock.patch("infra_secrets.POLL_SECONDS", 0.01):
            code, out, err = self.run_cli("fetch", "r1", "--wait", "5")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["state"], "delivered")
        self.assertLessEqual(err.count("Esperando"), 1)

    def test_a_panel_outage_longer_than_the_wait_reports_pending_not_error(self):
        FakePanel.outages = 10_000
        with mock.patch("infra_secrets.POLL_SECONDS", 0.01):
            code, out, _ = self.run_cli("fetch", "r1", "--wait", "0.1")
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["state"], "pending")

    def test_fetch_resumes_a_request(self):
        code, out, _ = self.run_cli("fetch", "r1", "--wait", "5")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["state"], "delivered")

    def test_rejects_wrong_token_without_leaking_it(self):
        with mock.patch.dict(os.environ, {"INFRA_SECRETS_TOKEN": "otro"}):
            code, out, err = self.run_cli(*self.BASE, "--wait", "1")
        self.assertEqual(code, 1)
        self.assertNotIn("otro", out + err)

    def test_destination_cannot_escape_the_working_directory(self):
        code, out, _ = self.run_cli("request", "A", "--project", "p", "--dest", "../.env", "--reason", "x")
        self.assertEqual(code, 1)
        self.assertIn("sale del directorio", out)
        self.assertEqual(FakePanel.seen, [])

    def test_plain_http_only_allowed_on_loopback(self):
        with mock.patch.dict(os.environ, {"INFRA_CONTROL_URL": "http://panel.example"}):
            code, out, _ = self.run_cli(*self.BASE)
        self.assertEqual(code, 1)
        self.assertIn("https", out)

    def test_token_file_must_be_private(self):
        config = self.cwd / "cfg"
        config.mkdir()
        (config / "token").write_text(TOKEN)
        os.chmod(config / "token", 0o644)
        with mock.patch.object(infra_secrets, "CONFIG_DIR", config), mock.patch.dict(os.environ, {}, clear=True):
            os.environ["INFRA_CONTROL_URL"] = "http://127.0.0.1:1"
            code, out, _ = self.run_cli("fetch", "r1")
        self.assertEqual(code, 1)
        self.assertIn("0600", out)


if __name__ == "__main__":
    unittest.main()
