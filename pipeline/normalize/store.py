"""Хранилище нормализованных коллокаций.

SQLite, а не один большой JSON, ровно ради дозагрузки: когда докачается
следующая порция словаря, её нужно добавить к уже разобранному, а не собирать
всё заново. Таблица `state` помнит, какая статья с какой версией правил уже
обработана, поэтому повторный запуск трогает только новое.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from ..sources.ozdic.storage import DATA_DIR
from .models import Collocation

DB_PATH = DATA_DIR / "interim" / "collocations.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS collocations (
    id           TEXT PRIMARY KEY,
    headword     TEXT NOT NULL,
    head_pos     TEXT,
    sense        TEXT,
    relation     TEXT NOT NULL,
    position     TEXT NOT NULL,
    cat_raw      TEXT,
    phrase       TEXT NOT NULL,
    collocate    TEXT NOT NULL,
    accept       TEXT NOT NULL,
    variants     TEXT NOT NULL,
    example      TEXT,
    gap_start    INTEGER,
    gap_end      INTEGER,
    matched      TEXT,
    needs_review INTEGER DEFAULT 0,
    freq_pct     INTEGER,
    source_dict  TEXT,
    source_slug  TEXT
);
CREATE INDEX IF NOT EXISTS colloc_slug ON collocations(source_slug);
CREATE INDEX IF NOT EXISTS colloc_head ON collocations(headword);
CREATE INDEX IF NOT EXISTS colloc_rel  ON collocations(relation);
CREATE INDEX IF NOT EXISTS colloc_gap  ON collocations(gap_start);

CREATE TABLE IF NOT EXISTS state (
    slug          TEXT PRIMARY KEY,
    source_dict   TEXT,
    fetched_at    TEXT,
    version       TEXT,
    n_records     INTEGER,
    normalized_at TEXT
);
"""

_COLUMNS = (
    "id", "headword", "head_pos", "sense", "relation", "position", "cat_raw",
    "phrase", "collocate", "accept", "variants", "example", "gap_start",
    "gap_end", "matched", "needs_review", "freq_pct", "source_dict", "source_slug",
)


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.commit()
    return conn


def is_current(conn: sqlite3.Connection, slug: str, fetched_at: str,
               version: str) -> bool:
    """Обработана ли статья теми же правилами и по той же версии сырья."""
    row = conn.execute(
        "SELECT fetched_at, version FROM state WHERE slug = ?", (slug,)
    ).fetchone()
    return bool(row) and row[0] == fetched_at and row[1] == version


def replace_slug(conn: sqlite3.Connection, slug: str, source_dict: str,
                 fetched_at: str, version: str,
                 records: list[Collocation]) -> None:
    """Перезаписывает все записи одной статьи разом.

    Именно заменяет, а не дописывает: если правила изменились и часть записей
    исчезла, в базе не должно остаться сирот.
    """
    ids = [record.id for record in records]
    if len(set(ids)) != len(ids):
        raise ValueError(f"разделение кластера {slug}: повторный ID; проверьте card-identities.json")
    if any(record.source_slug != slug or record.source_dict != source_dict for record in records):
        raise ValueError(f"записи не принадлежат статье {slug}")
    for record_id in ids:
        owner = conn.execute("SELECT source_slug FROM collocations WHERE id = ?", (record_id,)).fetchone()
        if owner is not None and owner[0] != slug:
            raise ValueError(f"ID {record_id} уже принадлежит статье {owner[0]}")
    # Savepoint не фиксирует весь пакет вызывающего кода и откатывает статью
    # целиком даже при ошибке в середине executemany.
    if not conn.in_transaction:
        conn.execute("BEGIN")
    conn.execute("SAVEPOINT replace_slug")
    try:
        conn.execute("DELETE FROM collocations WHERE source_slug = ?", (slug,))
        if records:
            placeholders = ", ".join(f":{name}" for name in _COLUMNS)
            conn.executemany(
                f"INSERT INTO collocations ({', '.join(_COLUMNS)}) VALUES ({placeholders})",
                [record.to_row() for record in records],
            )
        _write_state(conn, slug, source_dict, fetched_at, version, len(records))
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT replace_slug")
        raise
    finally:
        conn.execute("RELEASE SAVEPOINT replace_slug")


def _write_state(conn: sqlite3.Connection, slug: str, source_dict: str,
                 fetched_at: str, version: str, count: int) -> None:
    conn.execute(
        """
        INSERT INTO state (slug, source_dict, fetched_at, version, n_records,
                           normalized_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            source_dict=excluded.source_dict, fetched_at=excluded.fetched_at,
            version=excluded.version, n_records=excluded.n_records,
            normalized_at=excluded.normalized_at
        """,
        (
            slug,
            source_dict,
            fetched_at,
            version,
            count,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ),
    )


def forget_missing(conn: sqlite3.Connection, known_slugs: set[str]) -> int:
    """Убирает записи статей, которых больше нет в сырье."""
    stale = [
        row[0]
        for row in conn.execute("SELECT slug FROM state")
        if row[0] not in known_slugs
    ]
    for slug in stale:
        conn.execute("DELETE FROM collocations WHERE source_slug = ?", (slug,))
        conn.execute("DELETE FROM state WHERE slug = ?", (slug,))
    return len(stale)
