"""Переводы предложений для карточек.

Перевод на карточке решает главную проблему cloze для коллокаций: без него
пропуск «My grandmother ___ her great-grandchildren graduate» допускает
множество осмысленных вариантов, а с переводом «дожила до того, как правнуки
окончили университет» задача становится настоящим упражнением на продукцию —
смысл известен, нужно выдать английскую коллокацию.

Рабочий цикл — выгрузить непереведённое, перевести, загрузить обратно:

    python -m pipeline.translate.build todo --batch 120 --out батч.tsv
    python -m pipeline.translate.build load батч-готово.tsv
    python -m pipeline.translate.build stats

`todo` выдаёт строки вида `<ключ> <TAB> <предложение>`, где ключ — восемь первых
знаков хэша предложения. Обратно достаточно прислать `<ключ> <TAB> <перевод>`:
переписывать английский текст второй раз не нужно, а сопоставление
восстанавливается из самой колоды и потому не требует никакого состояния между
запусками. Пара `<английское предложение> <TAB> <перевод>` тоже принимается.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..deck.export import load_deck
from . import store

DEFAULT_DECK = "en-collocations"


def sentences_of(deck_id: str) -> list[str]:
    """Полные предложения всех карточек колоды, без повторов и по порядку."""
    _, cards = load_deck(deck_id)
    seen: dict[str, None] = {}
    for card in cards:
        seen.setdefault(card["text"].replace("___", card["answer"]), None)
    return list(seen)


def cmd_todo(args: argparse.Namespace) -> int:
    known = store.load_all()

    pending = [s for s in sentences_of(args.deck_id) if store.key_for(s) not in known]
    if not pending:
        print("всё переведено")
        return 0

    batch = pending[: args.batch] if args.batch else pending
    lines = "\n".join(f"{store.key_for(item)[:8]}\t{item}" for item in batch)
    if args.out:
        Path(args.out).write_text(lines + "\n", encoding="utf-8")
        print(f"непереведённых всего: {len(pending)}")
        print(f"в файл записано: {len(batch)} → {args.out}")
    else:
        print(lines)
    return 0


def cmd_load(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.exists():
        print(f"нет файла {path}", file=sys.stderr)
        return 1

    # Короткий ключ → предложение: восстанавливается из колоды, состояния между
    # запусками не нужно.
    by_short = {store.key_for(s)[:8]: s for s in sentences_of(args.deck_id)}

    items: list[tuple[str, str]] = []
    bad = 0
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 2 or not parts[1].strip():
            bad += 1
            print(f"  строка {number}: нет двух колонок", file=sys.stderr)
            continue

        left, russian = parts[0].strip(), parts[1]
        if left in by_short:
            items.append((by_short[left], russian))
        elif " " in left:
            items.append((left, russian))   # прислали само предложение
        else:
            bad += 1
            print(f"  строка {number}: ключ {left} не найден в колоде",
                  file=sys.stderr)

    added, updated = store.save_many(items)
    print(f"добавлено: {added}, обновлено: {updated}, пропущено строк: {bad}")
    print(f"файл: {store.TSV_PATH}")
    return 1 if bad else 0


def cmd_stats(args: argparse.Namespace) -> int:
    known = store.load_all()
    sentences = sentences_of(args.deck_id)
    live = {store.key_for(s) for s in sentences}
    covered = sum(1 for key in live if key in known)

    print(f"предложений в колоде: {len(sentences)}")
    print(f"переведено:           {covered} ({covered / len(sentences):.0%})")
    print(f"осталось:             {len(sentences) - covered}")
    stale = len(set(known) - live)
    if stale:
        print(f"переводов от исчезнувших предложений: {stale} "
              f"(убрать: `prune`)")
    return 0


def cmd_prune(args: argparse.Namespace) -> int:
    live = {store.key_for(s) for s in sentences_of(args.deck_id)}
    removed = store.forget_unused(live)
    print(f"убрано переводов: {removed}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="translate", description="Переводы предложений для карточек"
    )
    parser.add_argument("--deck-id", default=DEFAULT_DECK)
    sub = parser.add_subparsers(dest="command", required=True)

    p_todo = sub.add_parser("todo", help="выгрузить непереведённые предложения")
    p_todo.add_argument("--batch", type=int, default=0, help="сколько за раз")
    p_todo.add_argument("--out", help="файл вместо вывода на экран")
    p_todo.set_defaults(func=cmd_todo)

    p_load = sub.add_parser("load", help="загрузить переводы из TSV")
    p_load.add_argument("file")
    p_load.set_defaults(func=cmd_load)

    p_stats = sub.add_parser("stats", help="покрытие переводами")
    p_stats.set_defaults(func=cmd_stats)

    p_prune = sub.add_parser("prune", help="убрать переводы исчезнувших предложений")
    p_prune.set_defaults(func=cmd_prune)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
