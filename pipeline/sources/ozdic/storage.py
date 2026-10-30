"""Пути и раскладка файлов сырых данных ozdic."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any
from .payload import PayloadError, MAX_EXPANDED_BYTES, validate_expanded_payload

# pipeline/data/ — всё сырьё лежит здесь и не коммитится (см. .gitignore).
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
RAW_DIR = DATA_DIR / "raw" / "ozdic"
ENTRIES_DIR = RAW_DIR / "entries"
WORDS_FILE = RAW_DIR / "words.txt"
STATE_DB = RAW_DIR / "crawl.sqlite"

# Имена, запрещённые в Windows. Среди них есть настоящие английские слова
# (con, aux, nul, prn), которые обязательно встретятся в словаре.
_RESERVED = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)

_SAFE_CHARS = re.compile(r"[^a-z0-9._-]")
_WRITE_LOCKS = [threading.Lock() for _ in range(64)]


def _legacy_filename(slug: str) -> str:
    """Старое неоднозначное кодирование — только для совместимого чтения."""
    lowered = slug.lower()
    encoded = _SAFE_CHARS.sub(lambda m: f"-{ord(m.group()):02x}", lowered)
    if encoded in _RESERVED:
        encoded += "_"
    return encoded or "-empty"


def safe_filename(slug: str) -> str:
    """Читаемый префикс и SHA-256 полного исходного слага, включая регистр."""
    if not isinstance(slug, str) or not slug.strip():
        raise PayloadError("пустой или неверный слаг статьи")
    prefix = _legacy_filename(slug)[:48].rstrip(" .") or "word"
    return f"{prefix}-{hashlib.sha256(slug.encode('utf-8')).hexdigest()}"


def entry_path(slug: str) -> Path:
    """Путь до файла статьи. Двухуровневый шардинг: 84k файлов в одной папке
    NTFS обрабатывает очень медленно."""
    return _path_for_name(safe_filename(slug))


def _path_for_name(name: str) -> Path:
    first = name[0] if name[0].isalnum() else "_"
    second = name[:2] if len(name) >= 2 and name[1].isalnum() else f"{first}_"
    return ENTRIES_DIR / first / second / f"{name}.json.gz"


def existing_entry_path(slug: str) -> Path:
    current = entry_path(slug)
    return current if current.exists() else _path_for_name(_legacy_filename(slug))


def write_entry(slug: str, payload: dict[str, Any]) -> int:
    """Пишет распарсенную статью в gzip-JSON. Возвращает размер файла."""
    path = entry_path(slug)
    # В Windows одновременная замена одного назначения может быть запрещена.
    # Разные слаги имеют разные пути, один и тот же слаг сериализуется в потоке.
    stripe = int(hashlib.sha256(slug.encode("utf-8")).hexdigest()[:4], 16) % len(_WRITE_LOCKS)
    with _WRITE_LOCKS[stripe]:
        return _write_entry(path, slug, payload)


def _write_entry(path: Path, slug: str, payload: dict[str, Any]) -> int:
    if "slug" in payload and payload["slug"] != slug:
        raise PayloadError("сырьё принадлежит другой статье")
    payload = {**payload, "slug": slug}
    validate_expanded_payload(payload)
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".entry-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            with gzip.GzipFile(fileobj=stream, mode="wb", compresslevel=6, mtime=0) as packed:
                packed.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return path.stat().st_size


def read_entry(slug: str) -> dict[str, Any] | None:
    """Читает ранее сохранённую статью, если она есть."""
    path = existing_entry_path(slug)
    if not path.exists():
        return None
    with gzip.open(path, "rb") as fh:
        blob = fh.read(MAX_EXPANDED_BYTES + 1)
    if len(blob) > MAX_EXPANDED_BYTES:
        raise PayloadError("превышен размер сохранённого сырья")
    payload = json.loads(blob.decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("slug") != slug:
        raise PayloadError(f"нельзя подтвердить принадлежность сырья статье {slug!r}; перекачайте её")
    return payload


def iter_entry_files():
    """Все сохранённые файлы статей."""
    if not ENTRIES_DIR.exists():
        return
    yield from ENTRIES_DIR.rglob("*.json.gz")
