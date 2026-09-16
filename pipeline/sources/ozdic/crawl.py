"""Краулер словарных статей ozdic.com.

Этап 0.1 плана: получить сырьё и сложить его локально, чтобы дальше парсер
можно было переписывать сколько угодно, ни разу больше не сходив в сеть.

Что делает:
  * берёт список слов из sitemap (кэшируется в data/raw/ozdic/words.txt);
  * качает `/word/<slug>`, вынимает SSR-payload, сохраняет статью в gzip-JSON;
  * состояние пишет в SQLite, поэтому обход прерывается и продолжается свободно;
  * держит заданную частоту запросов глобально, независимо от числа потоков.

Примеры:
    python -m pipeline.sources.ozdic.crawl words
    python -m pipeline.sources.ozdic.crawl run --order freq --limit 15000
    python -m pipeline.sources.ozdic.crawl run            # весь словарь
    python -m pipeline.sources.ozdic.crawl stats
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import quote

import requests

from . import sitemap, storage
from .http import BASE_URL, is_allowed, make_session
from .payload import PayloadError, parse_page, summarize_entry

# Средний вес страницы на проводе (brotli) — для оценки трафика перед запуском.
# Без разжатия brotli страница весит ~450 КБ, со сжатием ~100 КБ.
AVG_PAGE_BYTES = 100_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
    slug            TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    http_code       INTEGER,
    fetched_at      TEXT,
    has_entry       INTEGER DEFAULT 0,
    has_collocations INTEGER DEFAULT 0,
    n_clusters      INTEGER DEFAULT 0,
    n_examples      INTEGER DEFAULT 0,
    freq_pct        INTEGER,
    sources         TEXT,
    bytes_stored    INTEGER,
    error           TEXT
);
CREATE INDEX IF NOT EXISTS pages_status ON pages(status);
CREATE INDEX IF NOT EXISTS pages_colloc ON pages(has_collocations);
"""

# Статусы, при которых повторно ходить в сеть не нужно.
DONE_STATUSES = ("ok", "no_entry")


@dataclass
class Result:
    slug: str
    status: str
    http_code: int | None = None
    summary: dict[str, Any] | None = None
    bytes_stored: int | None = None
    error: str | None = None


class RateLimiter:
    """Глобальный ограничитель частоты: не более 1 запроса в `interval` секунд."""

    def __init__(self, interval: float) -> None:
        self._interval = max(interval, 0.0)
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        if self._interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            delay = self._next_at - now
            if delay > 0:
                time.sleep(delay)
                now = self._next_at
            self._next_at = now + self._interval


def open_db() -> sqlite3.Connection:
    storage.STATE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(storage.STATE_DB)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.commit()
    return conn


def record(conn: sqlite3.Connection, result: Result) -> None:
    summary = result.summary or {}
    conn.execute(
        """
        INSERT INTO pages (slug, status, http_code, fetched_at, has_entry,
                           has_collocations, n_clusters, n_examples, freq_pct,
                           sources, bytes_stored, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            status=excluded.status, http_code=excluded.http_code,
            fetched_at=excluded.fetched_at, has_entry=excluded.has_entry,
            has_collocations=excluded.has_collocations,
            n_clusters=excluded.n_clusters, n_examples=excluded.n_examples,
            freq_pct=excluded.freq_pct, sources=excluded.sources,
            bytes_stored=excluded.bytes_stored, error=excluded.error
        """,
        (
            result.slug,
            result.status,
            result.http_code,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            int(bool(summary.get("has_entry"))),
            int(bool(summary.get("has_collocations"))),
            summary.get("n_clusters") or 0,
            summary.get("n_examples") or 0,
            summary.get("freq_pct"),
            summary.get("sources") or "",
            result.bytes_stored,
            result.error,
        ),
    )


def fetch_one(
    session: requests.Session, limiter: RateLimiter, slug: str, timeout: int
) -> Result:
    path = f"/word/{quote(slug, safe='')}"
    if not is_allowed(path):
        return Result(slug, "skipped", error="путь закрыт в robots.txt")

    limiter.wait()
    try:
        response = session.get(f"{BASE_URL}{path}", timeout=timeout)
    except requests.RequestException as exc:
        return Result(slug, "network_error", error=f"{type(exc).__name__}: {exc}"[:300])

    if response.status_code != 200:
        return Result(slug, "http_error", http_code=response.status_code)

    try:
        parsed = parse_page(response.text, slug)
    except PayloadError as exc:
        return Result(slug, "parse_error", http_code=200, error=str(exc)[:300])

    entry = parsed["entry"]
    summary = summarize_entry(entry)
    if entry is None:
        # Страница отдаётся для любого слова из сайтмапа, но статьи может не быть.
        return Result(slug, "no_entry", http_code=200, summary=summary)

    stored = storage.write_entry(
        slug,
        {
            "slug": slug,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "entry": entry,
            "study_banks": parsed["study_banks"],
        },
    )
    return Result(slug, "ok", http_code=200, summary=summary, bytes_stored=stored)


def order_slugs(slugs: list[str], order: str) -> list[str]:
    """Порядок обхода. `freq` ставит вперёд частотные слова — именно они
    почти наверняка окажутся заголовочными словами словаря коллокаций."""
    if order == "alpha":
        return sorted(slugs)
    if order == "freq":
        try:
            from wordfreq import zipf_frequency
        except ImportError:
            print(
                "  wordfreq не установлен (pip install wordfreq) — "
                "иду в порядке sitemap",
                file=sys.stderr,
            )
            return slugs
        return sorted(
            slugs,
            key=lambda s: (-zipf_frequency(s.replace("-", " "), "en"), s),
        )
    return slugs


def pending_slugs(
    conn: sqlite3.Connection, slugs: Iterable[str], refresh: bool, retry_failed: bool
) -> list[str]:
    if refresh:
        return list(slugs)
    done = {
        row[0]
        for row in conn.execute(
            f"SELECT slug FROM pages WHERE status IN ({','.join('?' * len(DONE_STATUSES))})",
            DONE_STATUSES,
        )
    }
    if not retry_failed:
        done |= {row[0] for row in conn.execute("SELECT slug FROM pages")}
    return [slug for slug in slugs if slug not in done]


def cmd_words(args: argparse.Namespace) -> int:
    slugs = sitemap.ensure_word_slugs(refresh=args.refresh, delay=args.delay)
    print(f"слов в sitemap: {len(slugs)} → {storage.WORDS_FILE}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    slugs = sitemap.ensure_word_slugs(refresh=False, delay=args.delay)
    if not slugs:
        print("список слов пуст: сначала `crawl words`", file=sys.stderr)
        return 1

    conn = open_db()
    queue = pending_slugs(conn, order_slugs(slugs, args.order), args.refresh,
                          args.retry_failed)
    if args.limit:
        queue = queue[: args.limit]

    if not queue:
        print("всё уже скачано — нечего делать")
        return 0

    rps = args.workers / args.delay if args.delay else float("inf")
    eta_hours = len(queue) / rps / 3600 if rps else 0
    print(
        f"к обходу: {len(queue)} страниц | {args.workers} потоков, "
        f"пауза {args.delay}s → ~{rps:.1f} rps\n"
        f"оценка: ~{eta_hours:.1f} ч, ~{len(queue) * AVG_PAGE_BYTES / 1e9:.1f} ГБ трафика"
    )

    limiter = RateLimiter(args.delay / args.workers if args.workers else args.delay)
    session = make_session()
    counts: dict[str, int] = {}
    started = time.monotonic()
    processed = 0
    interrupted = False

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            batch_size = max(args.workers * 16, 32)
            for start in range(0, len(queue), batch_size):
                batch = queue[start : start + batch_size]
                futures = [
                    pool.submit(fetch_one, session, limiter, slug, args.timeout)
                    for slug in batch
                ]
                for future in futures:
                    result = future.result()
                    record(conn, result)
                    counts[result.status] = counts.get(result.status, 0) + 1
                    processed += 1
                conn.commit()

                elapsed = time.monotonic() - started
                rate = processed / elapsed if elapsed else 0
                left = (len(queue) - processed) / rate / 3600 if rate else 0
                summary = " ".join(f"{k}={v}" for k, v in sorted(counts.items()))
                print(
                    f"[{processed}/{len(queue)}] {rate:.1f}/s "
                    f"осталось ~{left:.1f} ч | {summary}",
                    flush=True,
                )
    except KeyboardInterrupt:
        interrupted = True
        print("\nпрерывание — сохраняю состояние", file=sys.stderr)
    finally:
        conn.commit()
        conn.close()
        session.close()

    print("готово" if not interrupted else "остановлено, продолжить: тот же `run`")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    conn = open_db()
    total = conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
    if not total:
        print("состояние пустое — краулер ещё не запускался")
        return 0

    print(f"страниц обработано: {total}")
    print("\nпо статусам:")
    for status, count in conn.execute(
        "SELECT status, COUNT(*) FROM pages GROUP BY status ORDER BY COUNT(*) DESC"
    ):
        print(f"  {status:<14} {count}")

    row = conn.execute(
        """
        SELECT COUNT(*), SUM(n_clusters), SUM(n_examples), SUM(bytes_stored)
        FROM pages WHERE has_collocations = 1
        """
    ).fetchone()
    words, clusters, examples, size = (row[0] or 0, row[1] or 0, row[2] or 0, row[3] or 0)
    print(f"\nсо словарными коллокациями: {words} слов")
    print(f"  кластеров:  {clusters}")
    share = f" ({examples / clusters:.0%})" if clusters else ""
    print(f"  с примером: {examples}{share}")
    print(f"  на диске:   {size / 1e6:.1f} МБ")

    print("\nошибки (топ-5):")
    errors = conn.execute(
        """
        SELECT status, http_code, error, COUNT(*) FROM pages
        WHERE status NOT IN ('ok', 'no_entry')
        GROUP BY status, http_code, error ORDER BY COUNT(*) DESC LIMIT 5
        """
    ).fetchall()
    for status, code, error, count in errors or []:
        print(f"  {count:>6} × {status} {code or ''} {(error or '')[:60]}")
    if not errors:
        print("  нет")

    conn.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="crawl", description="Краулер словарных статей ozdic.com"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_words = sub.add_parser("words", help="собрать список слов из sitemap")
    p_words.add_argument("--refresh", action="store_true", help="перекачать sitemap")
    p_words.add_argument("--delay", type=float, default=1.0)
    p_words.set_defaults(func=cmd_words)

    p_run = sub.add_parser("run", help="обойти страницы слов")
    p_run.add_argument("--limit", type=int, default=0, help="сколько страниц за запуск")
    p_run.add_argument("--workers", type=int, default=3, help="параллельных потоков")
    p_run.add_argument(
        "--delay", type=float, default=1.0,
        help="секунд на запрос на поток (общая частота = workers/delay)",
    )
    p_run.add_argument("--timeout", type=int, default=45)
    p_run.add_argument(
        "--order", choices=("freq", "alpha", "sitemap"), default="freq",
        help="порядок обхода; freq требует wordfreq",
    )
    p_run.add_argument("--refresh", action="store_true", help="перекачать всё заново")
    p_run.add_argument(
        "--retry-failed", action="store_true", help="повторить неудачные страницы"
    )
    p_run.set_defaults(func=cmd_run)

    p_stats = sub.add_parser("stats", help="сводка по скачанному")
    p_stats.set_defaults(func=cmd_stats)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
