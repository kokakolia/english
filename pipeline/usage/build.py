"""Заметки об употреблении коллокаций.

На обороте карточки вместо технической строки (`verb+obj · core · неоднозначность
low`) показывается объяснение: когда так говорят и чем различаются варианты
внутри кластера. Техническая разметка никуда не делась — она осталась в данных
колоды и в тегах Anki, просто учащемуся её видеть незачем.

    python -m pipeline.usage.build todo --batch 100
    python -m pipeline.usage.build load батч-готово.tsv
    python -m pipeline.usage.build stats
    python -m pipeline.usage.build show -n 5

`todo` печатает всё, что нужно для написания заметки: подпись коллокации, весь
набор партнёров, тип отношения и пример. Обратно ждём `<id> <TAB> <заметка>`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..deck.export import load_deck, all_published_cards
from . import store

DEFAULT_DECK = "en-collocations"


def cards_of(deck_id: str) -> list[dict]:
    _, cards = load_deck(deck_id)
    return cards


def cmd_todo(args: argparse.Namespace) -> int:
    cards = cards_of(args.deck_id)
    known = store.notes_for(cards)
    pending = [card for card in cards if card["id"] not in known]
    if not pending:
        print("все заметки написаны")
        return 0

    batch = pending[: args.batch] if args.batch else pending
    lines = []
    for card in batch:
        accept = ", ".join(card["accept"])
        lines.append(
            f"{card['id']}\t{card['phrase']}\t[{card['relation']}]\t"
            f"варианты: {accept}\t{card['text'].replace('___', card['answer'])}"
        )
    text = "\n".join(lines)

    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"без заметки всего: {len(pending)}")
        print(f"в файл записано: {len(batch)} → {args.out}")
    else:
        print(f"# без заметки всего: {len(pending)}")
        print(text)
    return 0


def cmd_load(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.exists():
        print(f"нет файла {path}", file=sys.stderr)
        return 1

    cards = cards_of(args.deck_id)
    phrases = {card["id"]: card["phrase"] for card in cards}
    items: list[tuple[str, str, str]] = []
    bad = 0
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 2 or not parts[1].strip():
            bad += 1
            print(f"  строка {number}: нет двух колонок", file=sys.stderr)
            continue
        card_id = parts[0].strip()
        if card_id not in phrases:
            bad += 1
            print(f"  строка {number}: {card_id} нет в колоде", file=sys.stderr)
            continue
        items.append((card_id, phrases[card_id], parts[1]))

    added, updated = store.save_many(items, {c["id"]: store.context_key(c["accept"], c["text"], c["answer"]) for c in cards})
    print(f"добавлено: {added}, обновлено: {updated}, пропущено строк: {bad}")
    print(f"файл: {store.TSV_PATH}")
    return 1 if bad else 0


def cmd_stats(args: argparse.Namespace) -> int:
    cards = cards_of(args.deck_id)
    known = store.notes_for(cards)
    live = {card["id"] for card in cards}
    covered = sum(1 for card_id in live if card_id in known)

    print(f"коллокаций в колоде: {len(cards)}")
    print(f"с заметкой:          {covered} ({covered / len(cards):.0%})")
    print(f"осталось:            {len(cards) - covered}")
    all_live = {card["id"] for card in all_published_cards()}
    stale = len(set(store.load_all()) - all_live)
    if stale:
        print(f"заметок от исчезнувших коллокаций: {stale} (убрать: `prune`)")
    return 0


def cmd_prune(args: argparse.Namespace) -> int:
    cards_of(args.deck_id)  # Ошибка в выбранном ID не должна запускать очистку.
    live = {card["id"] for card in all_published_cards()}
    removed = store.forget_unused(live)
    print(f"убрано заметок: {removed}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    cards = cards_of(args.deck_id)
    known = store.notes_for(cards)
    shown = 0
    for card in cards:
        note = known.get(card["id"])
        if not note:
            continue
        if shown >= args.n:
            break
        shown += 1
        print(f"\n{card['text']}")
        print(f"  {card['translation']}")
        print(f"  ответ: {card['answer']}   подсказка: {card['hint']}")
        print(f"  {note}")
    if not shown:
        print("заметок пока нет")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="usage", description="Заметки об употреблении коллокаций"
    )
    parser.add_argument("--deck-id", default=DEFAULT_DECK)
    sub = parser.add_subparsers(dest="command", required=True)

    p_todo = sub.add_parser("todo", help="выгрузить коллокации без заметки")
    p_todo.add_argument("--batch", type=int, default=0)
    p_todo.add_argument("--out")
    p_todo.set_defaults(func=cmd_todo)

    p_load = sub.add_parser("load", help="загрузить заметки из TSV")
    p_load.add_argument("file")
    p_load.set_defaults(func=cmd_load)

    p_stats = sub.add_parser("stats", help="покрытие заметками")
    p_stats.set_defaults(func=cmd_stats)

    p_prune = sub.add_parser("prune", help="убрать заметки исчезнувших коллокаций")
    p_prune.set_defaults(func=cmd_prune)

    p_show = sub.add_parser("show", help="показать карточки с заметками")
    p_show.add_argument("-n", type=int, default=5)
    p_show.set_defaults(func=cmd_show)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
