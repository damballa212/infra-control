#!/usr/bin/env python3
"""Cliente de línea de comandos para pedir secretos a Infra Control.

    infra_secrets.py request OPENAI_API_KEY --project prod-erp --env dev --reason "pruebas"
    infra_secrets.py fetch <id>          # retoma una solicitud que seguía pendiente

El valor llega por TLS al proceso, se escribe en el .env con permisos 0600 y NUNCA se imprime ni se
registra: la salida es solo JSON con el estado, la URL de aprobación y los nombres escritos.

Configuración: INFRA_CONTROL_URL y INFRA_SECRETS_TOKEN, o los archivos ~/.config/infra-secrets/url y
~/.config/infra-secrets/token (este último con permisos 0600).
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import stat
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # funciona también con python -I
import envfile  # noqa: E402

CONFIG_DIR = Path.home() / ".config" / "infra-secrets"
POLL_SECONDS = 1.5  # el límite del panel es 120 peticiones/min por red; 429 se trata como corte breve
HTTP_TIMEOUT = 90  # la bóveda puede tardar varios segundos en entregar
EXIT_OK, EXIT_ERROR, EXIT_DENIED, EXIT_EXPIRED, EXIT_PENDING = 0, 1, 2, 3, 4


class CliError(Exception):
    pass


def _read_private(name: str) -> str | None:
    path = CONFIG_DIR / name
    if not path.exists():
        return None
    if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise CliError(f"{path} debe tener permisos 0600.")
    return path.read_text(encoding="utf-8").strip()


def _clean_label(value: str) -> str:
    """El panel admite letras, números, espacio, punto, guion y guion bajo (máx. 64)."""
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in " ._-") else " " for ch in value)
    cleaned = " ".join(cleaned.split()).lstrip(" ._-")
    return cleaned[:64] or "equipo"


def default_machine() -> str:
    """Nombre fijado por el instalador en ~/.config/infra-secrets/machine; si no, el hostname."""
    path = CONFIG_DIR / "machine"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return socket.gethostname().split(".")[0]


def default_client() -> str:
    if os.environ.get("CLAUDECODE"):
        return "Claude Code"
    return "agente"


def machine_label(machine: str, client: str) -> str:
    return _clean_label(f"{machine} - {client}" if client else machine)


def settings() -> tuple[str, str]:
    url = os.environ.get("INFRA_CONTROL_URL") or _read_private("url")
    token = os.environ.get("INFRA_SECRETS_TOKEN") or _read_private("token")
    if not url or not token:
        raise CliError("Falta INFRA_CONTROL_URL o INFRA_SECRETS_TOKEN (o sus archivos en ~/.config/infra-secrets).")
    parsed = urllib.parse.urlparse(url)
    loopback = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise CliError("La URL del panel debe ser https (http solo en loopback).")
    return url.rstrip("/"), token


class PanelUnreachable(CliError):
    """El panel no respondió (red o reinicio): durante una espera se reintenta."""


TRANSIENT_STATUS = {429, 502, 503, 504}
_CONNECTIONS: dict[tuple[str, str, int], http.client.HTTPConnection] = {}


def _connection(base: str, fresh: bool) -> tuple[http.client.HTTPConnection, str, bool]:
    """Conexión reutilizable por panel: evita repetir el saludo TLS en cada llamada (~0,5 s cada uno)."""
    parsed = urllib.parse.urlparse(base)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    key = (parsed.scheme, parsed.hostname or "", port)
    cached = _CONNECTIONS.get(key)
    if cached is not None and not fresh:
        return cached, parsed.path.rstrip("/"), True
    if cached is not None:
        cached.close()
    cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    conn = cls(parsed.hostname, port, timeout=HTTP_TIMEOUT)
    _CONNECTIONS[key] = conn
    return conn, parsed.path.rstrip("/"), False


def call(method: str, path: str, base: str, token: str, body: dict | None = None, key: str | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if key:
        headers["Idempotency-Key"] = key
    # Solo se repite en una conexión nueva si la reutilizada murió antes de responder y la llamada es segura de repetir
    # (lecturas y la creación con Idempotency-Key); la entrega (claim) nunca se repite.
    repeatable = method == "GET" or key is not None
    for attempt in (0, 1):
        conn, prefix, reused = _connection(base, fresh=attempt == 1)
        try:
            conn.request(method, prefix + path, body=data, headers=headers)  # el bearer nunca sigue una redirección
            response = conn.getresponse()
            raw = response.read()
            if response.will_close:
                conn.close()
                _CONNECTIONS.pop(next((k for k, v in _CONNECTIONS.items() if v is conn), ("", "", 0)), None)
            try:
                return response.status, json.loads(raw or b"{}")
            except ValueError:
                return response.status, {}
        except (http.client.HTTPException, TimeoutError, OSError) as error:
            conn.close()
            _CONNECTIONS.pop(next((k for k, v in _CONNECTIONS.items() if v is conn), ("", "", 0)), None)
            if attempt == 0 and reused and repeatable:
                continue
            raise PanelUnreachable(f"No se pudo contactar con el panel: {type(error).__name__}.") from None
    raise PanelUnreachable("No se pudo contactar con el panel.")


def target_inside(cwd: Path, relative: str) -> Path:
    candidate = (cwd / relative)
    parent = candidate.parent.resolve()
    if parent != cwd.resolve() and cwd.resolve() not in parent.parents:
        raise CliError("La ruta de destino sale del directorio actual.")
    return parent / candidate.name


def deliver(request_id: str, base: str, token: str, cwd: Path) -> dict:
    status, payload = call("POST", f"/api/secrets/requests/{urllib.parse.quote(request_id)}/claim", base, token)
    if status != 200:
        raise CliError(payload.get("error", f"El panel respondió {status}."))
    destination = payload.get("destination", {})
    if destination.get("kind") != "dotenv":
        raise CliError("Este cliente solo entrega a archivos .env.")
    path = target_inside(cwd, destination["path"])
    report = envfile.write_env(path, {payload["name"]: payload["value"]})
    return {"id": request_id, "state": "delivered", "written": list(report.names), "path": str(path), "gitignored": report.gitignored}


def wait_and_deliver(request_id: str, base: str, token: str, cwd: Path, wait: float, approval_url: str | None = None) -> tuple[int, dict]:
    deadline = time.monotonic() + wait
    announced = False
    while True:
        try:
            status, request = call("GET", f"/api/secrets/requests/{urllib.parse.quote(request_id)}", base, token)
        except PanelUnreachable:
            status, request = 503, {}
        if status in TRANSIENT_STATUS:
            request = {"state": "pending"}  # reinicio o corte breve del panel: la solicitud sigue viva, seguir esperando
        elif status != 200:
            raise CliError(request.get("error", f"El panel respondió {status}."))
        state = request["state"]
        if state == "approved":
            return EXIT_OK, deliver(request_id, base, token, cwd)
        if state == "denied":
            return EXIT_DENIED, {"id": request_id, "state": "denied"}
        if state in ("expired", "failed", "delivered"):
            return EXIT_EXPIRED, {"id": request_id, "state": state}
        if time.monotonic() >= deadline:
            url = approval_url or request.get("url") or f"{base}/secretos/{urllib.parse.quote(request_id)}"
            return EXIT_PENDING, {"id": request_id, "state": "pending", "url": url}
        if not announced:
            print("Esperando tu aprobación en Infra Control…", file=sys.stderr)
            announced = True
        time.sleep(min(POLL_SECONDS, max(0.0, deadline - time.monotonic())))


def run_request(args: argparse.Namespace, cwd: Path) -> tuple[int, dict]:
    base, token = settings()
    destination = {"kind": "dotenv", "path": args.dest}
    target_inside(cwd, args.dest)
    body = {
        "name": args.name, "project": args.project, "machine": machine_label(args.machine, args.client), "reason": args.reason,
        "destination": destination, **({"environment": args.env} if args.env else {}),
    }
    status, request = call("POST", "/api/secrets/requests", base, token, body, key=f"cli-{uuid.uuid4()}")
    if status != 201:
        raise CliError(request.get("error", f"El panel respondió {status}."))
    if request.get("state") == "approved":
        print("Aprobada de inmediato: se entrega sin esperar.", file=sys.stderr)
        return EXIT_OK, deliver(request["id"], base, token, cwd)
    else:
        print(f"Solicitud creada. Aprueba aquí: {request['url']}", file=sys.stderr)
    return wait_and_deliver(request["id"], base, token, cwd, args.wait, request["url"])


def run_list(args: argparse.Namespace) -> tuple[int, dict]:
    """Nombres de variables guardadas en la bóveda para un proyecto (sin valores)."""
    base, token = settings()
    query = {"project": args.project, **({"environment": args.env} if args.env else {})}
    status, payload = call("GET", f"/api/secrets/available?{urllib.parse.urlencode(query)}", base, token)
    if status != 200:
        raise CliError(payload.get("error", f"El panel respondió {status}."))
    return EXIT_OK, {"project": args.project, "environment": args.env, "names": [item["name"] for item in payload.get("items", [])]}


def run_setup(args: argparse.Namespace) -> tuple[int, dict]:
    """Prepara este equipo: URL, nombre y un token generado aquí. Devuelve solo el hash del token."""
    import hashlib
    import secrets as pysecrets

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        os.chmod(CONFIG_DIR, 0o700)

    def write_private(name: str, value: str) -> None:
        path = CONFIG_DIR / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value + "\n")
        if os.name == "posix":
            os.chmod(path, 0o600)

    parsed = urllib.parse.urlparse(args.url)
    if parsed.scheme != "https":
        raise CliError("La URL del panel debe ser https.")
    write_private("url", args.url.rstrip("/"))
    write_private("machine", _clean_label(args.machine))
    token_path = CONFIG_DIR / "token"
    created = not (token_path.exists() and token_path.read_text(encoding="utf-8").strip())
    if created:
        write_private("token", pysecrets.token_urlsafe(36))
    token = token_path.read_text(encoding="utf-8").strip()
    digest = hashlib.sha256(token.encode()).hexdigest()
    return EXIT_OK, {"machine": _clean_label(args.machine), "tokenCreated": created, "tokenSha256": digest}


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description="Pide secretos a Infra Control sin que el valor pase por el modelo.")
    sub = main.add_subparsers(dest="command", required=True)
    req = sub.add_parser("request", help="pide una variable y la escribe en un .env")
    req.add_argument("name")
    req.add_argument("--project", required=True)
    req.add_argument("--env")
    req.add_argument("--dest", default=".env", help="ruta .env relativa al directorio actual (por defecto .env)")
    req.add_argument("--machine", default=default_machine(), help="nombre del equipo (por defecto el fijado al instalar)")
    req.add_argument("--client", default=default_client(), help="quién pide: Claude Code, Codex, OpenCode, Hermes…")
    req.add_argument("--reason", required=True)
    req.add_argument("--wait", type=float, default=300, help="segundos de espera (por defecto 300)")
    setup = sub.add_parser("setup", help="prepara este equipo y muestra el hash del token para registrarlo")
    setup.add_argument("--machine", required=True)
    setup.add_argument("--url", default="https://panel.example.com")
    listing = sub.add_parser("list", help="nombres guardados en la bóveda para un proyecto (sin valores)")
    listing.add_argument("--project", required=True)
    listing.add_argument("--env")
    fetch = sub.add_parser("fetch", help="retoma una solicitud pendiente")
    fetch.add_argument("id")
    fetch.add_argument("--wait", type=float, default=300)
    return main


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    cwd = Path.cwd()
    try:
        if args.command == "setup":
            code, result = run_setup(args)
        elif args.command == "request":
            code, result = run_request(args, cwd)
        elif args.command == "list":
            code, result = run_list(args)
        else:
            base, token = settings()
            code, result = wait_and_deliver(args.id, base, token, cwd, args.wait)
    except (CliError, envfile.EnvFileError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return EXIT_ERROR
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
