"""Этап 0.4 — ранжирование коллокаций.

Считает частотность, полосу сложности, подтягивает настоящие CEFR-метки и
выстраивает сквозной порядок изучения.

Таблица `ranking` пересчитывается целиком при каждом запуске: это чистая
функция от содержимого `collocations` плюс частотного словаря, и стоит она
секунды. Так после дозагрузки новых статей порядок сам пересобирается
согласованно, без миграций и без риска оставить устаревшие строки.

    python -m pipeline.rank.build run
    python -m pipeline.rank.build top -n 20
    python -m pipeline.rank.build stats
"""

from __future__ import annotations

import argparse
import sys

from ..normalize import store
from . import score as scoring
from .cefr import LEVELS, collect_levels

SCHEMA = """
CREATE TABLE IF NOT EXISTS ranking (
    id              TEXT PRIMARY KEY,
    head_zipf       REAL,
    collocate_zipf  REAL,
    band            TEXT,
    cefr            TEXT,
    cefr_source     TEXT,
    value           REAL,
    position        INTEGER
);
CREATE INDEX IF NOT EXISTS ranking_position ON ranking(position);
CREATE INDEX IF NOT EXISTS ranking_band ON ranking(band);
CREATE INDEX IF NOT EXISTS ranking_cefr ON ranking(cefr);
"""


def interleave_by_headword(scored: list[tuple]) -> list[tuple]:
    """Чередует коллокации разных заголовочных слов.

    Само по себе ранжирование по частотности ставит подряд все 30 коллокаций
    слова `time`, потом все 30 слова `will`. Учить так нельзя: карточки одного
    гнезда сливаются и мешают друг другу вспоминаться. Поэтому очередь
    раскладывается по кругу — по одной коллокации от каждого слова.

    Внутри слова порядок сохраняется, слова идут в порядке своей лучшей оценки.
    На вход ожидается список, уже отсортированный по убыванию оценки.
    """
    groups: dict[str, list[tuple]] = {}
    for item in scored:
        groups.setdefault(item[3], []).append(item)

    queues = list(groups.values())   # порядок слов = порядок первого появления
    result: list[tuple] = []
    while queues:
        remaining = []
        for queue in queues:
            result.append(queue.pop(0))
            if queue:
                remaining.append(queue)
        queues = remaining
    return result


def cmd_run(args: argparse.Namespace) -> int:
    try:
        from wordfreq import zipf_frequency
    except ImportError:
        print("нужен wordfreq: pip install -r pipeline/requirements.txt", file=sys.stderr)
        return 1

    conn = store.connect()
    conn.executescript(SCHEMA)

    rows = conn.execute(
        "SELECT id, headword, collocate, gap_start, needs_review, relation "
        "FROM collocations"
    ).fetchall()
    if not rows:
        print("нет коллокаций — сначала `pipeline.normalize.build run`", file=sys.stderr)
        return 1

    levels = collect_levels(conn)
    print(f"CEFR-меток привязано: {len(levels)} из {len(rows)} коллокаций")

    scored = []
    for record_id, headword, collocate, gap_start, needs_review, relation in rows:
        result = scoring.compute(
            headword, collocate, gap_start is not None, bool(needs_review),
            zipf_frequency, relation,
        )
        level = levels.get(record_id)
        scored.append((record_id, result, level, headword))

    # Порядок: по убыванию оценки, при равенстве — устойчиво по id,
    # чтобы позиции не прыгали между запусками.
    scored.sort(key=lambda item: (-item[1].value, item[0]))
    scored = interleave_by_headword(scored)

    conn.execute("DELETE FROM ranking")
    conn.executemany(
        "INSERT INTO ranking (id, head_zipf, collocate_zipf, band, cefr, "
        "cefr_source, value, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                record_id,
                result.head_zipf,
                result.collocate_zipf,
                result.band,
                level,
                "study-bank" if level else None,
                result.value,
                position,
            )
            for position, (record_id, result, level, _) in enumerate(scored, 1)
        ],
    )
    conn.commit()
    print(f"проранжировано: {len(scored)}")
    conn.close()
    return cmd_stats(args)


def cmd_stats(args: argparse.Namespace) -> int:
    conn = store.connect()
    conn.executescript(SCHEMA)
    total = conn.execute("SELECT COUNT(*) FROM ranking").fetchone()[0]
    if not total:
        print("ранжирование пустое — сначала `run`")
        return 0

    print(f"\nвсего: {total}")
    print("\nпо полосам сложности:")
    for band, count, ready in conn.execute(
        "SELECT r.band, COUNT(*), SUM(c.gap_start IS NOT NULL) "
        "FROM ranking r JOIN collocations c ON c.id = r.id "
        "GROUP BY r.band ORDER BY COUNT(*) DESC"
    ):
        print(f"  {band:<10} {count:>5}   с пропуском: {ready or 0}")

    print("\nпо уровням CEFR:")
    labelled = 0
    for level in LEVELS:
        count = conn.execute(
            "SELECT COUNT(*) FROM ranking WHERE cefr = ?", (level,)
        ).fetchone()[0]
        labelled += count
        if count:
            print(f"  {level:<10} {count:>5}")
    print(f"  {'без метки':<10} {total - labelled:>5}")
    conn.close()
    return 0


def cmd_top(args: argparse.Namespace) -> int:
    conn = store.connect()
    conn.executescript(SCHEMA)
    where = "1=1"
    params: list = []
    if args.band:
        where += " AND r.band = ?"
        params.append(args.band)
    if args.cefr:
        where += " AND r.cefr = ?"
        params.append(args.cefr)
    if args.cloze_only:
        where += " AND c.gap_start IS NOT NULL"

    rows = conn.execute(
        f"SELECT r.position, c.phrase, c.relation, r.band, r.cefr, r.value, "
        f"c.example, c.gap_start, c.gap_end "
        f"FROM ranking r JOIN collocations c ON c.id = r.id "
        f"WHERE {where} ORDER BY r.position LIMIT ?",
        (*params, args.n),
    ).fetchall()

    for pos, phrase, relation, band, cefr, value, example, gap_start, gap_end in rows:
        level = cefr or "—"
        print(f"{pos:>5}. {phrase:<30} {relation:<10} {band:<9} CEFR {level:<3} {value:>6.2f}")
        if example and gap_start is not None and args.show_cards:
            print(f"        {example[:gap_start]}___{example[gap_end:]}")
    conn.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rank", description="Ранжирование коллокаций (этап 0.4)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="пересчитать ранжирование")
    p_run.set_defaults(func=cmd_run)

    p_stats = sub.add_parser("stats", help="сводка")
    p_stats.set_defaults(func=cmd_stats)

    p_top = sub.add_parser("top", help="показать начало очереди изучения")
    p_top.add_argument("-n", type=int, default=25)
    p_top.add_argument("--band", choices=[name for name, _ in scoring.BANDS])
    p_top.add_argument("--cefr", choices=list(LEVELS))
    p_top.add_argument("--cloze-only", action="store_true")
    p_top.add_argument("--show-cards", action="store_true", help="печатать и сам пропуск")
    p_top.set_defaults(func=cmd_top)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
