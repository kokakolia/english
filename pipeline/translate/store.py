"""Хранилище переводов предложений.

Перевод привязан к **тексту предложения**, а не к карточке. Это важно: набор
партнёров в кластере может поменяться, идентификатор карточки вместе с ним —
а предложение останется тем же, и переводить его заново незачем. И наоборот:
если пример заменили, перевод старого предложения к новому не подходит и
должен пропасть сам.

Переводы стоят дорого (их делает человек или языковая модель), поэтому таблица
живёт отдельно от колоды и переживает любые пересборки.
"""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timezone

from ..sources.ozdic.storage import DATA_DIR

DB_PATH = DATA_DIR / "interim" / "translations.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS translations (
    text_sha1   TEXT PRIMARY KEY,
    en          TEXT NOT NULL,
    ru          TEXT NOT NULL,
    source      TEXT,
    created_at  TEXT
);
"""


def key_for(sentence: str) -> str:
    """Ключ перевода — хэш нормализованного предложения."""
    normalized = " ".join(sentence.split())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def load_all(conn: sqlite3.Connection) -> dict[str, str]:
    """Все переводы: ключ предложения → русский текст."""
    return {row[0]: row[1] for row in conn.execute("SELECT text_sha1, ru FROM translations")}


def save_many(conn: sqlite3.Connection, items: list[tuple[str, str]],
              source: str) -> tuple[int, int]:
    """Сохраняет пары (английское предложение, перевод).

    Возвращает (добавлено, обновлено).
    """
    added = updated = 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for english, russian in items:
        english = " ".join(english.split())
        russian = " ".join(russian.split())
        if not english or not russian:
            continue
        key = key_for(english)
        existing = conn.execute(
            "SELECT ru FROM translations WHERE text_sha1 = ?", (key,)
        ).fetchone()
        if existing is None:
            added += 1
        elif existing[0] != russian:
            updated += 1
        else:
            continue
        conn.execute(
            "INSERT INTO translations (text_sha1, en, ru, source, created_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(text_sha1) DO UPDATE SET ru=excluded.ru, "
            "source=excluded.source, created_at=excluded.created_at",
            (key, english, russian, source, now),
        )
    conn.commit()
    return added, updated


def forget_unused(conn: sqlite3.Connection, live_keys: set[str]) -> int:
    """Убирает переводы предложений, которых больше нет ни в одной карточке."""
    stale = [
        row[0]
        for row in conn.execute("SELECT text_sha1 FROM translations")
        if row[0] not in live_keys
    ]
    for key in stale:
        conn.execute("DELETE FROM translations WHERE text_sha1 = ?", (key,))
    conn.commit()
    return len(stale)
