"""Этап 0.7 — сборка колоды.

Берёт нормализованные коллокации с проставленным пропуском, отсеивает негодные
(этап 0.6), проставляет подсказки и пишет колоду в формат, который читает
приложение.

Колода иммутабельна и версионируется хэшем содержимого: приложение по нему
понимает, изменились ли карточки. Прогресс с колодой не смешивается — он
связывается по `card.id`, который не зависит от примера.

    python -m pipeline.deck.build run
    python -m pipeline.deck.build run --band core --deck-id core-collocations
    python -m pipeline.deck.build preview -n 10
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from ..normalize import store
from ..translate import store as translations_store
from . import quality

DECKS_DIR = Path(__file__).resolve().parents[2] / "decks"
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "deck.schema.json"

DEFAULT_DECK_ID = "en-collocations"
DEFAULT_NAME = "Английские коллокации"
DEFAULT_CHUNK_SIZE = 250

AMBIGUITY_ORDER = {"low": 0, "medium": 1, "high": 2}


def _load_rows(conn):
    """Кандидаты в карточки и полный список коллокаций для подсчёта конкурентов."""
    everything = [
        (row[0], row[1], row[2], row[3], json.loads(row[4]))
        for row in conn.execute(
            "SELECT id, headword, relation, sense, accept FROM collocations"
        )
    ]
    candidates = conn.execute(
        """
        SELECT c.id, c.headword, c.relation, c.sense, c.phrase, c.accept,
               c.example, c.gap_start, c.gap_end, c.matched,
               r.cefr, r.band, r.position
        FROM collocations c
        JOIN ranking r ON r.id = c.id
        WHERE c.gap_start IS NOT NULL
        ORDER BY r.position
        """
    ).fetchall()
    return everything, candidates


def make_cards(conn, args) -> tuple[list[dict], dict[str, int]]:
    everything, candidates = _load_rows(conn)
    index = quality.rival_index(everything)

    # Переводы живут отдельно и привязаны к тексту предложения, а не к карточке.
    translations_conn = translations_store.connect()
    try:
        translations = translations_store.load_all(translations_conn)
    finally:
        translations_conn.close()

    cards: list[dict] = []
    rejected: dict[str, int] = {}
    max_ambiguity = AMBIGUITY_ORDER[args.max_ambiguity]

    for (record_id, headword, relation, sense, phrase, accept_json, example,
         gap_start, gap_end, matched, cefr, band, position) in candidates:
        if args.band and band != args.band:
            continue
        if args.cefr and cefr != args.cefr:
            continue

        accept = json.loads(accept_json)
        answer = example[gap_start:gap_end]
        own = {word.lower() for word in accept}
        rivals = quality.count_rivals(
            index, record_id, (headword, relation, sense), own, answer
        )
        verdict = quality.assess(example, gap_start, gap_end, rivals)

        if not verdict.usable:
            reason = verdict.reason or "unknown"
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        if AMBIGUITY_ORDER[verdict.ambiguity] > max_ambiguity:
            rejected["ambiguous"] = rejected.get("ambiguous", 0) + 1
            continue

        cards.append(
            {
                "id": record_id,
                "type": "cloze",
                "text": example[:gap_start] + "___" + example[gap_end:],
                "answer": answer,
                "accept": accept,
                "hint": verdict.hint,
                "translation": translations.get(translations_store.key_for(example)),
                "phrase": phrase,
                "relation": relation,
                "headword": headword,
                "sense": sense,
                "cefr": cefr,
                "band": band,
                "ambiguity": verdict.ambiguity,
                "flags": [f for f in verdict.flags if f != "ambiguous"],
                "position": position,
            }
        )
        if args.limit and len(cards) >= args.limit:
            break

    return cards, rejected


def content_version(cards: list[dict]) -> str:
    """Хэш содержимого: меняется только когда меняются сами карточки.

    В хэш входит всё, что пользователь видит на карточке, включая перевод:
    иначе исправленный перевод не доехал бы до приложения, которое сверяет
    версии и решило бы, что обновляться не нужно.
    """
    digest = hashlib.sha1()
    for card in cards:
        digest.update(
            f"{card['id']}|{card['text']}|{card['answer']}"
            f"|{card.get('translation') or ''}".encode("utf-8")
        )
    return digest.hexdigest()[:12]


def validate(deck: dict, chunks: list[list[dict]]) -> list[str]:
    """Проверка по схеме. Без jsonschema — предупреждение, но не отказ."""
    try:
        import jsonschema
    except ImportError:
        return ["jsonschema не установлен, проверка по схеме пропущена"]

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    card_schema = {**schema["$defs"]["card"], "$defs": schema["$defs"]}
    problems: list[str] = []

    validator = jsonschema.Draft202012Validator(schema)
    for error in validator.iter_errors(deck):
        problems.append(f"deck.json: {'/'.join(map(str, error.path))}: {error.message}")

    card_validator = jsonschema.Draft202012Validator(card_schema)
    for chunk_index, chunk in enumerate(chunks):
        for card in chunk:
            for error in card_validator.iter_errors(card):
                problems.append(
                    f"cards-{chunk_index:03d} {card.get('id')}: "
                    f"{'/'.join(map(str, error.path))}: {error.message}"
                )
                break  # по одной жалобе на карточку достаточно
    return problems


def write_deck(deck_id: str, name: str, cards: list[dict], chunk_size: int,
               source_note: str) -> Path:
    deck_dir = DECKS_DIR / deck_id
    deck_dir.mkdir(parents=True, exist_ok=True)

    chunks = [cards[i : i + chunk_size] for i in range(0, len(cards), chunk_size)]
    names = [f"cards-{index:03d}.json" for index in range(len(chunks))]

    stats: dict[str, dict] = {"relation": {}, "band": {}, "cefr": {}, "ambiguity": {}}
    for card in cards:
        for key in stats:
            value = str(card.get(key))
            stats[key][value] = stats[key].get(value, 0) + 1

    deck = {
        "id": deck_id,
        "name": name,
        "version": content_version(cards),
        "language": "en",
        "card_type": "cloze",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"dict": "ozdic", "note": source_note},
        "count": len(cards),
        "chunk_size": chunk_size,
        "chunks": names,
        "stats": stats,
    }

    problems = validate(deck, chunks)
    if problems:
        print(f"проверка по схеме: {len(problems)} замечаний", file=sys.stderr)
        for problem in problems[:5]:
            print(f"  {problem}", file=sys.stderr)
        if not problems[0].startswith("jsonschema не установлен"):
            raise SystemExit("колода не записана: она не соответствует схеме")

    # Старые части убираем: иначе после уменьшения колоды останутся лишние файлы.
    for stale in deck_dir.glob("cards-*.json"):
        if stale.name not in names:
            stale.unlink()

    for file_name, chunk in zip(names, chunks):
        (deck_dir / file_name).write_text(
            json.dumps(chunk, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    (deck_dir / "deck.json").write_text(
        json.dumps(deck, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    _refresh_index()
    return deck_dir


def _refresh_index() -> None:
    """Перечень колод — точка входа для приложения."""
    decks = []
    for deck_file in sorted(DECKS_DIR.glob("*/deck.json")):
        meta = json.loads(deck_file.read_text(encoding="utf-8"))
        decks.append(
            {
                "id": meta["id"],
                "name": meta["name"],
                "version": meta["version"],
                "count": meta["count"],
                "path": f"{meta['id']}/deck.json",
            }
        )
    DECKS_DIR.mkdir(parents=True, exist_ok=True)
    (DECKS_DIR / "index.json").write_text(
        json.dumps({"decks": decks}, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def cmd_run(args: argparse.Namespace) -> int:
    conn = store.connect()
    try:
        cards, rejected = make_cards(conn, args)
    finally:
        conn.close()

    if not cards:
        print("не набралось ни одной карточки", file=sys.stderr)
        return 1

    source_note = (
        "Словарные статьи ozdic (материал восходит к Oxford Collocations "
        "Dictionary); примеры и уровни — из данных того же сайта."
    )
    deck_dir = write_deck(args.deck_id, args.name, cards, args.chunk_size, source_note)

    print(f"карточек в колоде: {len(cards)}")
    print(f"отсеяно: {sum(rejected.values())}")
    for reason, count in sorted(rejected.items(), key=lambda item: -item[1]):
        print(f"  {count:>5}  {reason}")

    translated = sum(1 for card in cards if card.get("translation"))
    print(f"с переводом: {translated} из {len(cards)} "
          f"({translated / len(cards):.0%})")

    by_ambiguity: dict[str, int] = {}
    for card in cards:
        by_ambiguity[card["ambiguity"]] = by_ambiguity.get(card["ambiguity"], 0) + 1
    print("по неоднозначности:", ", ".join(
        f"{key} {value}" for key, value in sorted(by_ambiguity.items())
    ))
    print(f"\nзаписано: {deck_dir}")
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    deck_dir = DECKS_DIR / args.deck_id
    if not (deck_dir / "deck.json").exists():
        print("колода не собрана — сначала `run`", file=sys.stderr)
        return 1
    meta = json.loads((deck_dir / "deck.json").read_text(encoding="utf-8"))
    print(f"{meta['name']} · версия {meta['version']} · {meta['count']} карточек\n")

    shown = 0
    for chunk_name in meta["chunks"]:
        cards = json.loads((deck_dir / chunk_name).read_text(encoding="utf-8"))
        for card in cards:
            if shown >= args.n:
                return 0
            shown += 1
            level = card["cefr"] or "—"
            print(f"{card['position']:>5}. {card['text']}")
            if card.get("translation"):
                print(f"       {card['translation']}")
            print(f"       ответ: {card['answer']}   подсказка: {card['hint']}")
            print(f"       принимаем: {', '.join(card['accept'])}")
            print(f"       {card['relation']} · {card['band']} · CEFR {level} · "
                  f"неоднозначность {card['ambiguity']}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="deck", description="Сборка колоды (этапы 0.6–0.7)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="собрать колоду")
    p_run.add_argument("--deck-id", default=DEFAULT_DECK_ID)
    p_run.add_argument("--name", default=DEFAULT_NAME)
    p_run.add_argument("--band", choices=("core", "common", "extended", "rare"))
    p_run.add_argument("--cefr", choices=("A1", "A2", "B1", "B2", "C1", "C2"))
    p_run.add_argument(
        "--max-ambiguity", choices=("low", "medium", "high"), default="medium",
        help="сколько конкурентов допускать после подсказки",
    )
    p_run.add_argument("--limit", type=int, default=0)
    p_run.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    p_run.set_defaults(func=cmd_run)

    p_preview = sub.add_parser("preview", help="показать начало колоды")
    p_preview.add_argument("--deck-id", default=DEFAULT_DECK_ID)
    p_preview.add_argument("-n", type=int, default=8)
    p_preview.set_defaults(func=cmd_preview)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
