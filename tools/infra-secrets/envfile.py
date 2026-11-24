"""Escritura segura de archivos .env para el cliente infra-secrets.

Recibe valores ya entregados por el broker y los deja en un dotenv sin que el modelo los vea:
- el archivo se crea o reemplaza de forma atómica con permisos 0600;
- se niega a seguir enlaces simbólicos;
- mantiene las demás líneas del archivo;
- si está dentro de un repositorio git, se asegura de que quede ignorado;
- ningún mensaje de error ni el informe devuelto contiene valores, solo nombres.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
BARE_RE = re.compile(r"^[A-Za-z0-9_./:@%+=,-]*$")
MAX_VALUE_BYTES = 8192


class EnvFileError(Exception):
    """Fallo de validación o de E/S. El mensaje nunca incluye valores."""


@dataclass(frozen=True)
class WriteReport:
    path: str
    names: tuple[str, ...]
    gitignored: bool | None  # None: fuera de un repositorio git


def _format_value(value: str) -> str:
    if BARE_RE.match(value):
        return value
    if "'" not in value:
        return f"'{value}'"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`")
    return f'"{escaped}"'


def _validate(values: Mapping[str, str]) -> None:
    if not values:
        raise EnvFileError("No hay variables que escribir.")
    for name, value in values.items():
        if not NAME_RE.match(name):
            raise EnvFileError(f"Nombre de variable no válido: {name!r}.")
        if not isinstance(value, str) or any(ch in value for ch in "\n\r\x00"):
            raise EnvFileError(f"El valor de {name} no es una sola línea de texto.")
        if len(value.encode()) > MAX_VALUE_BYTES:
            raise EnvFileError(f"El valor de {name} supera {MAX_VALUE_BYTES} bytes.")


def _merge(existing: str, values: Mapping[str, str]) -> str:
    pending = dict(values)
    out: list[str] = []
    for line in existing.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if match and match.group(1) in pending:
            name = match.group(1)
            out.append(f"{name}={_format_value(pending.pop(name))}")
        else:
            out.append(line)
    out.extend(f"{name}={_format_value(value)}" for name, value in pending.items())
    return "\n".join(out) + "\n"


# Windows no tiene O_NOFOLLOW ni fchmod: allí el archivo hereda la ACL del perfil del usuario.
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
HAS_FCHMOD = hasattr(os, "fchmod")


def _read_existing(path: Path) -> str:
    try:
        fd = os.open(path, os.O_RDONLY | O_NOFOLLOW)
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise EnvFileError(f"No se puede leer {path.name}: {error.strerror}.") from None
    with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read()


def _git_root(start: Path) -> Path | None:
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _ensure_gitignored(path: Path) -> bool | None:
    root = _git_root(path.parent)
    if root is None:
        return None
    relative = path.relative_to(root).as_posix()

    def ignored() -> bool:
        result = subprocess.run(
            ["git", "-C", str(root), "check-ignore", "-q", "--", relative],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0

    if ignored():
        return True
    gitignore = root / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    prefix = "" if not existing or existing.endswith("\n") else "\n"
    with open(gitignore, "a", encoding="utf-8") as handle:
        handle.write(f"{prefix}/{relative}\n")
    return ignored()


def write_env(path: str | os.PathLike[str], values: Mapping[str, str]) -> WriteReport:
    """Escribe o actualiza `values` en el dotenv `path` y devuelve un informe sin valores."""
    target = Path(path)
    _validate(values)
    if not target.parent.is_dir():
        raise EnvFileError(f"El directorio {target.parent.name!r} no existe.")
    if target.is_symlink():
        raise EnvFileError(f"{target.name} es un enlace simbólico; no se escribe.")
    content = _merge(_read_existing(target), values)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        if HAS_FCHMOD:
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return WriteReport(str(target), tuple(values), _ensure_gitignored(target))
