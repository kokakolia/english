"""Этап 0.2 — сборка нормализованных коллокаций из скачанных статей.

Запуск инкрементальный: обрабатываются только те статьи, которых ещё нет в базе
или которые скачаны заново. Поэтому после дозагрузки словаря достаточно
повторить ту же команду — разобранное не пересчитывается.

Изменение правил разбора требует пересчёта всего, и это учтено: подняв
VERSION, вы автоматически заставите пересобрать каждую статью.

    python -m pipeline.normalize.build run
    python -m pipeline.normalize.build run --all-sources --force
    python -m pipeline.normalize.build stats
    python -m pipeline.normalize.build sample --relation verb+obj
"""

from __future__ import annotations

import argparse
import hashlib
from contextlib import closing
import json
import sqlite3
import sys

from ..sources.ozdic import storage as ozdic_storage
from . import store
from .inflect import sequence_regex
from .models import Collocation
from .limits import MAX_CLUSTER_VARIANTS, SearchBudget, require_budget
from .patterns import AFTER, PHRASE, TEMPLATE, build_phrase, parse_cat, parse_gloss
from .variants import PLACEHOLDERS, expand

# Версия правил разбора. Поднять при любом изменении логики нормализации —
# тогда следующий `run` пересоберёт базу целиком.
VERSION = "0.5.0"

SOURCE_DICT = "ozdic"

# Максимальное расстояние между партнёром и заголовочным словом в примере.
MAX_GAP_TOKENS = 6


def _head_tokens(headword: str) -> list[str]:
    return [token for token in headword.split() if token]


def _sequence_for(position: str, headword: str, variant: str
                  ) -> tuple[list[str], tuple[int, int]] | None:
    """Токены коллокации целиком и границы пропуска внутри них.

    В пропуск попадает только то, что учащийся может произвести: сам партнёр.
    Заголовочное слово остаётся видимым как опора, а плейсхолдеры `sb`/`sth` —
    потому что на их месте в предложении стоит произвольное дополнение.
    Без этого правила запись `see sb home` превращала предложение в
    «Tom ___ through the dark streets» с ответом «saw his elderly neighbor
    home», который угадать нельзя.
    """
    head = _head_tokens(headword)
    partner = [token for token in variant.split() if token]
    if not partner:
        return None

    # Собираем последовательность, помечая токены, которые можно прятать.
    tokens: list[str] = []
    hideable: list[bool] = []

    def add_partner() -> None:
        for token in partner:
            if token == "~":
                tokens.extend(head)
                hideable.extend([False] * len(head))
                continue
            tokens.append(token)
            hideable.append(token.lower() not in PLACEHOLDERS)

    def add_head() -> None:
        tokens.extend(head)
        hideable.extend([False] * len(head))

    if position == PHRASE or position == TEMPLATE or "~" in variant:
        add_partner()
    elif position == AFTER:
        add_head()
        add_partner()
    else:
        add_partner()
        add_head()

    if partner.count("~") > 1:
        # `from ~ to ~` — единое выражение, прячем его целиком.
        return tokens, (0, len(tokens))

    # Первый непрерывный кусок из тех токенов, что можно спрятать.
    start = None
    for index, can_hide in enumerate(hideable):
        if can_hide and start is None:
            start = index
        elif not can_hide and start is not None:
            return tokens, (start, index)
    if start is None:
        return None
    return tokens, (start, len(tokens))


def _locate(example: str, headword: str, position: str, candidates: list[str]
            ) -> tuple[int, int, str] | None:
    """Находит в примере коллокацию и возвращает границы пропуска.

    Перебирает варианты партнёра: пример нередко использует не первый из них
    (`get better` в словаре, «has gotten better» в предложении).
    """
    if not example:
        return None
    best: tuple[int, int, str] | None = None
    budget = SearchBudget()
    for variant in candidates:
        sequence = _sequence_for(position, headword, variant)
        if sequence is None:
            continue
        tokens, gap = sequence
        if len(tokens) - (gap[1] - gap[0]) > MAX_GAP_TOKENS + len(_head_tokens(headword)):
            continue
        pattern = sequence_regex(tokens, gap)
        if pattern is None:
            continue
        match = pattern.search(example, budget=budget)
        if match is None:
            continue
        start, end = match.span(1)
        # Из нескольких подходящих вариантов берём самый ранний в предложении.
        if best is None or start < best[0]:
            best = (start, end, variant)
    return best


def normalize_entry(entry: dict, slug: str, freq_pct: int | None) -> list[Collocation]:
    """Одна словарная статья → список записей промежуточного формата."""
    headword = (entry.get("word") or slug).strip()
    records: list[Collocation] = []
    seen: set[tuple] = set()

    for block in entry.get("collocations") or []:
        if not isinstance(block, dict):
            continue
        head_pos, sense = parse_gloss(block.get("gloss"))

        for group in block.get("groups") or []:
            if not isinstance(group, dict):
                continue
            pattern = parse_cat(group.get("cat"), headword, head_pos)

            for cluster in group.get("clusters") or []:
                if not isinstance(cluster, dict):
                    continue
                accept = [
                    str(w).strip()
                    for w in (cluster.get("words") or [])
                    # `etc.` в словаре означает «и подобные», партнёром не является.
                    if w and str(w).strip().rstrip(".").lower() != "etc"
                ]
                if not accept:
                    continue

                # Один и тот же блок повторяется в разных частях речи статьи.
                key = (headword, head_pos, sense, pattern.cat_raw, tuple(accept))
                if key in seen:
                    continue
                seen.add(key)

                variants: list[str] = []
                needs_review = False
                for word in accept:
                    expanded, review = expand(word)
                    require_budget(len(variants) + len(expanded), MAX_CLUSTER_VARIANTS,
                                   f"варианты кластера {slug}")
                    variants.extend(expanded)
                    needs_review = needs_review or review
                # Дубликаты между вариантами разных партнёров не нужны.
                variants = list(dict.fromkeys(variants))

                example = (cluster.get("example") or "").strip() or None
                located = _locate(example or "", headword, pattern.position, variants)

                records.append(
                    Collocation(
                        headword=headword,
                        head_pos=head_pos,
                        sense=sense,
                        relation=pattern.relation,
                        position=pattern.position,
                        cat_raw=pattern.cat_raw,
                        # Подпись строим из раскрытой формы: `night (also
                        # nightlife)` в подписи выглядел бы как мусор.
                        phrase=build_phrase(
                            pattern, headword, variants[0] if variants else accept[0]
                        ),
                        collocate=accept[0],
                        accept=accept,
                        variants=variants,
                        example=example,
                        gap_start=located[0] if located else None,
                        gap_end=located[1] if located else None,
                        matched=located[2] if located else None,
                        needs_review=needs_review,
                        freq_pct=freq_pct,
                        source_dict=SOURCE_DICT,
                        source_slug=slug,
                    )
                )
    if len({record.id for record in records}) != len(records):
        raise ValueError(f"разделение кластера {headword}: назначьте отдельные ID в card-identities.json")
    return records


def _crawled_slugs(all_sources: bool) -> list[tuple[str, int | None]]:
    """Слаги скачанных статей и их частотность.

    По умолчанию только словарные: у слов вне словаря блок коллокаций
    автосгенерирован и негоден (см. README источника).
    """
    conn = sqlite3.connect(ozdic_storage.STATE_DB)
    where = "has_collocations = 1"
    if not all_sources:
        where += " AND sources LIKE '%oxford-collocations%'"
    rows = conn.execute(
        f"SELECT slug, freq_pct FROM pages WHERE {where} ORDER BY freq_pct DESC, slug"
    ).fetchall()
    conn.close()
    return rows


def cmd_run(args: argparse.Namespace) -> int:
    if not ozdic_storage.STATE_DB.exists():
        print("сырья нет: сначала `pipeline.sources.ozdic.crawl run`", file=sys.stderr)
        return 1

    rows = _crawled_slugs(args.all_sources)
    with closing(sqlite3.connect(ozdic_storage.STATE_DB)) as catalog:
        retired = {row[0] for row in catalog.execute(
            "SELECT slug FROM pages WHERE status IN ('ok', 'no_entry') "
            "AND has_collocations = 0 AND fetched_at IS NOT NULL")}
    if not rows and not retired:
        print("нет скачанных статей, подходящих под фильтр", file=sys.stderr)
        return 1

    with closing(store.connect()) as conn:
        _run_normalization(conn, rows, retired, args)
    return cmd_stats(args)


def source_fingerprint(entry: dict, freq_pct: int | None) -> str:
    """Все входы нормализации, кроме служебного времени скачивания."""
    serialized = json.dumps([SOURCE_DICT, entry, freq_pct], ensure_ascii=False,
                            sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _run_normalization(conn, rows, retired, args) -> None:
    # Отсутствие в выборке может означать ошибку скачивания или другой фильтр.
    # Удалять материал разрешено только после успешного подтверждения пустоты.
    existing = {row[0] for row in conn.execute("SELECT slug FROM state")}
    removed = store.forget_missing(conn, (existing - retired) | {slug for slug, _ in rows})
    if removed:
        print(f"убрано статей, пропавших из сырья: {removed}")

    processed = skipped = total_records = 0
    for slug, freq_pct in rows:
        payload = ozdic_storage.read_entry(slug)
        if not payload or not payload.get("entry"):
            continue
        fetched_at = payload.get("fetched_at") or ""
        source_hash = source_fingerprint(payload["entry"], freq_pct)

        if not args.force and store.is_current(conn, slug, source_hash, VERSION):
            skipped += 1
            continue

        records = normalize_entry(payload["entry"], slug, freq_pct)
        store.replace_slug(conn, slug, SOURCE_DICT, fetched_at, VERSION, records,
                           source_hash=source_hash)
        processed += 1
        total_records += len(records)
        if processed % 200 == 0:
            from .identities import registry
            registry().save()
            conn.commit()
            print(f"  обработано статей: {processed}", flush=True)

    from .identities import registry
    registry().save()
    conn.commit()
    print(
        f"статей разобрано: {processed}, пропущено как актуальные: {skipped}\n"
        f"записей добавлено: {total_records}"
    )


def cmd_stats(args: argparse.Namespace) -> int:
    conn = store.connect()
    total = conn.execute("SELECT COUNT(*) FROM collocations").fetchone()[0]
    if not total:
        print("база пуста — сначала `run`")
        conn.close()
        return 0

    words = conn.execute("SELECT COUNT(DISTINCT headword) FROM collocations").fetchone()[0]
    with_example = conn.execute(
        "SELECT COUNT(*) FROM collocations WHERE example IS NOT NULL"
    ).fetchone()[0]
    with_gap = conn.execute(
        "SELECT COUNT(*) FROM collocations WHERE gap_start IS NOT NULL"
    ).fetchone()[0]
    review = conn.execute(
        "SELECT COUNT(*) FROM collocations WHERE needs_review = 1"
    ).fetchone()[0]
    pairs = sum(
        len(json.loads(row[0])) for row in conn.execute("SELECT accept FROM collocations")
    )

    print(f"коллокаций:        {total}  (из {words} заголовочных слов)")
    print(f"вариантов-партнёров: {pairs}")
    print(f"с примером:        {with_example} ({with_example / total:.0%})")
    print(f"готовых к cloze:   {with_gap} ({with_gap / total:.0%} от всех, "
          f"{with_gap / with_example:.0%} от тех, где есть пример)")
    print(f"на ручную проверку: {review}")

    print("\nпо типам отношений:")
    for relation, count, gaps in conn.execute(
        "SELECT relation, COUNT(*), SUM(gap_start IS NOT NULL) FROM collocations "
        "GROUP BY relation ORDER BY COUNT(*) DESC"
    ):
        print(f"  {relation:<12} {count:>5}   с пропуском: {gaps or 0}")
    conn.close()
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    conn = store.connect()
    where, params = "1=1", []
    if args.relation:
        where += " AND relation = ?"
        params.append(args.relation)
    if args.cloze_only:
        where += " AND gap_start IS NOT NULL"

    rows = conn.execute(
        f"SELECT phrase, accept, example, gap_start, gap_end, relation, needs_review "
        f"FROM collocations WHERE {where} ORDER BY RANDOM() LIMIT ?",
        (*params, args.n),
    ).fetchall()

    for phrase, accept_json, example, gap_start, gap_end, relation, review in rows:
        accept = json.loads(accept_json)
        flag = " [проверить]" if review else ""
        print(f"\n[{relation}] {phrase}{flag}")
        print(f"   принимаем: {', '.join(accept)}")
        if example and gap_start is not None:
            cloze = example[:gap_start] + "___" + example[gap_end:]
            print(f"   карточка:  {cloze}")
            print(f"   ответ:     {example[gap_start:gap_end]}")
        elif example:
            print(f"   пример без пропуска: {example}")
    conn.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="normalize", description="Нормализация коллокаций (этап 0.2)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="разобрать скачанные статьи")
    p_run.add_argument("--force", action="store_true",
                       help="пересобрать всё, игнорируя состояние")
    p_run.add_argument("--all-sources", action="store_true",
                       help="включая статьи без метки oxford-collocations")
    p_run.set_defaults(func=cmd_run)

    p_stats = sub.add_parser("stats", help="сводка по базе")
    p_stats.set_defaults(func=cmd_stats)

    p_sample = sub.add_parser("sample", help="показать случайные записи")
    p_sample.add_argument("-n", type=int, default=15)
    p_sample.add_argument("--relation", help="фильтр по типу отношения")
    p_sample.add_argument("--cloze-only", action="store_true",
                          help="только записи с готовым пропуском")
    p_sample.set_defaults(func=cmd_sample)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
