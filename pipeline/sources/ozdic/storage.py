"""Пути и раскладка файлов сырых данных ozdic."""

from __future__ import annotations

import gzip
import json
import re
from pathlib import Path
from typing import Any
from .payload import validate_expanded_payload

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


def safe_filename(slug: str) -> str:
    """Имя файла для слова: безопасное на Windows и обратимо однозначное.

    Небезопасные символы кодируются как `-XX` (hex), зарезервированные имена
    получают суффикс `_`. Регистр приводится к нижнему, чтобы на
    регистронезависимой ФС не было коллизий.
    """
    lowered = slug.lower()
    encoded = _SAFE_CHARS.sub(lambda m: f"-{ord(m.group()):02x}", lowered)
    if encoded in _RESERVED:
        encoded += "_"
    return encoded or "-empty"


def entry_path(slug: str) -> Path:
    """Путь до файла статьи. Двухуровневый шардинг: 84k файлов в одной папке
    NTFS обрабатывает очень медленно."""
    name = safe_filename(slug)
    first = name[0] if name[0].isalnum() else "_"
    second = name[:2] if len(name) >= 2 and name[1].isalnum() else f"{first}_"
    return ENTRIES_DIR / first / second / f"{name}.json.gz"


def write_entry(slug: str, payload: dict[str, Any]) -> int:
    """Пишет распарсенную статью в gzip-JSON. Возвращает размер файла."""
    validate_expanded_payload(payload)
    path = entry_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wb", compresslevel=6) as fh:
        fh.write(blob)
    tmp.replace(path)  # атомарная замена: недописанных файлов не остаётся
    return path.stat().st_size


def read_entry(slug: str) -> dict[str, Any] | None:
    """Читает ранее сохранённую статью, если она есть."""
    path = entry_path(slug)
    if not path.exists():
        return None
    with gzip.open(path, "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def iter_entry_files():
    """Все сохранённые файлы статей."""
    if not ENTRIES_DIR.exists():
        return
    yield from ENTRIES_DIR.rglob("*.json.gz")
