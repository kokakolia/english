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
import os
import tempfile
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from ..normalize import store
from ..normalize.build import _sequence_for
from ..normalize.inflect import phrase_regex
from ..normalize.variants import expand
from ..sentences import store as sentence_fixes
from ..translate import store as translations_store
from ..usage import store as usage_store
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
               c.variants, c.position AS pattern_position,
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
    translations = translations_store.load_all()
    usage_notes = usage_store.load_all()
    note_contexts = usage_store.load_contexts()
    fixes = sentence_fixes.load_all()
    stale: list[tuple[str, str]] = []

    cards: list[dict] = []
    rejected: dict[str, int] = {}
    max_ambiguity = AMBIGUITY_ORDER[args.max_ambiguity]

    for (record_id, headword, relation, sense, phrase, accept_json, variants_json,
         pattern_position, example, gap_start, gap_end, matched,
         cefr, band, position) in candidates:
        if args.band and band != args.band:
            continue
        if args.cefr and cefr != args.cefr:
            continue

        accept = json.loads(accept_json)
        answer = example[gap_start:gap_end]

        # Правка предложения, если она есть. Проверку качества проходит
        # исходное предложение: правка делается руками и уже просмотрена
        # глазами, а прогонять её через автоматику значит рисковать тем, что
        # исправленная карточка отсеется по признакам, придуманным для сырья.
        fixed = fixes.get(sentence_fixes.key_for(example))
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

        text = example[:gap_start] + "___" + example[gap_end:]
        hint = verdict.hint
        also = other_cluster_members(accept, matched, answer)
        if fixed is not None:
            text, answer = fixed
            # «Так же подошло бы» тоже пересчитывается. Прежний `matched`
            # описывает выброшенное предложение: после правки `thinks` → `has`
            # карточка предложила бы в качестве замены `have` — то же самое
            # слово. Без `matched` функция опознаёт использованный вариант по
            # самому ответу.
            also = other_cluster_members(accept, None, answer)
            # Подсказку пересчитываем от нового ответа. Она строится по его
            # буквам, и после правки `have` → `had` старая `h___` обещала бы
            # четыре буквы при трёх — ровно та ложь, которую подсказка обязана
            # исключать.
            hint = quality.make_hint(answer)
            # Правка меняет предложение, а перевод и заметка написаны под
            # старое. Молча оставить их — худший исход: карточка выглядит
            # исправной, а объясняет выброшенный текст. Поэтому о таких
            # случаях сборка говорит вслух.
            if translations_store.key_for(text.replace("___", answer)) not in translations:
                stale.append((record_id, text))

        cards.append(
            {
                "id": record_id,
                "type": "cloze",
                "text": text,
                "answer": answer,
                "accept": accept,
                "hint": hint,
                # Исправленному предложению нужен собственный перевод.
                # Перевод исходного примера не объясняет новую фразу.
                "translation": (
                    translations.get(translations_store.key_for(text.replace("___", answer)))
                    or (translations.get(translations_store.key_for(example)) if fixed is None else None)
                ),
                "answers": answer_forms(
                    json.loads(variants_json), pattern_position, headword, answer
                ),
                "also": also,
                "note": (usage_notes.get(record_id) if note_contexts.get(record_id) ==
                         usage_store.context_key(accept, text, answer) else None),
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

    if stale:
        print("")
        print(f"правок без своего перевода: {len(stale)}")
        for record_id, text in stale[:10]:
            print(f"   {record_id}  {text}")
        print("   перевод не подставлен: исправленному предложению нужен свой перевод")

    return cards, rejected


def answer_forms(variants: list[str], pattern_position: str, headword: str,
                 answer: str) -> list[str]:
    """Формы, которые приложение засчитывает как правильный ответ.

    `accept` хранит словарные записи как есть — с тильдами, плейсхолдерами и
    сокращениями (`in (a/the)~`, `see sb home`). Сравнивать с ними ввод нельзя,
    а разворачивать их в приложении значило бы завести вторую копию логики,
    которая уже написана и покрыта тестами здесь. Поэтому разворачиваем при
    сборке: берём у каждого варианта ровно ту часть, что попадает в пропуск.
    """
    forms: list[str] = []
    for variant in variants:
        sequence = _sequence_for(pattern_position, headword, variant)
        if sequence is None:
            continue
        tokens, gap = sequence
        form = " ".join(tokens[gap[0] : gap[1]]).strip()
        if form:
            forms.append(form)
    # Форма из самого предложения — всегда правильный ответ, даже если словарь
    # даёт её в другом виде (`demonstrate` в словаре, `demonstrated` в примере).
    forms.append(answer.strip())
    seen: set[str] = set()
    unique = []
    for form in forms:
        key = form.lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(form)
    return unique


def other_cluster_members(accept: list[str], matched: str | None, answer: str
                          ) -> list[str]:
    """Партнёры кластера, кроме того, что уже стоит в предложении.

    Показывать учащемуся весь кластер вместе с ответом бессмысленно: ответ он
    только что назвал. Полезны именно остальные варианты — то, чем ещё можно
    было сказать то же самое.
    """
    others = []
    for entry in accept:
        forms, _ = expand(entry)
        if matched and matched in forms:
            continue
        # Если matched не сохранён, опознаём использованный вариант по тому,
        # что он совпадает с ответом целиком.
        pattern = phrase_regex(entry)
        if pattern is not None and pattern.fullmatch(answer.strip()):
            continue
        others.append(entry)
    return others


def content_version(cards: list[dict]) -> str:
    """Хэш содержимого: меняется только когда меняются сами карточки.

    В хэш входит всё, что пользователь видит на карточке, включая перевод:
    иначе исправленный перевод не доехал бы до приложения, которое сверяет
    версии и решило бы, что обновляться не нужно.
    """
    return content_hash(cards)[:12]



def content_hash(value) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_json_atomic(path: Path, value) -> None:
    """Публикует файл только после полной записи и flush/fsync."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".publishing-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(value, output, ensure_ascii=False, indent=1)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def validate(deck: dict, chunks: list[list[dict]]) -> list[str]:
    """Проверка по схеме; без валидатора публикация запрещена."""
    try:
        import jsonschema
    except ImportError:
        return ["jsonschema не установлен: публикация без проверки схемы запрещена"]

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
    hashes = [content_hash(chunk) for chunk in chunks]
    names = [f"cards-{index:03d}-{digest[:16]}.json" for index, digest in enumerate(hashes)]

    stats: dict[str, dict] = {"relation": {}, "band": {}, "cefr": {}, "ambiguity": {}}
    for card in cards:
        for key in stats:
            value = str(card.get(key))
            stats[key][value] = stats[key].get(value, 0) + 1

    built_at = datetime.now(timezone.utc)
    built_at = built_at.replace(microsecond=(built_at.microsecond // 1000) * 1000)
    previous = deck_dir / "deck.json"
    if previous.exists():
        previous_meta = json.loads(previous.read_text(encoding="utf-8"))
        previous_time = datetime.fromisoformat(previous_meta["built_at"].replace("Z", "+00:00"))
        built_at = max(built_at, previous_time + timedelta(milliseconds=1))

    deck = {
        "id": deck_id,
        "name": name,
        "version": content_version(cards),
        "language": "en",
        "card_type": "cloze",
        "built_at": built_at.isoformat(timespec="milliseconds"),
        "source": {"dict": "ozdic", "note": source_note},
        "count": len(cards),
        "chunk_size": chunk_size,
        "chunks": names,
        "integrity": {"algorithm": "sha256-canonical-json-v1", "chunks": dict(zip(names, hashes))},
        "stats": stats,
    }

    problems = validate(deck, chunks)
    if problems:
        print(f"проверка по схеме: {len(problems)} замечаний", file=sys.stderr)
        for problem in problems[:5]:
            print(f"  {problem}", file=sys.stderr)
        raise SystemExit("колода не записана: проверка не пройдена")

    # Имена частей зависят от содержимого: старый манифест остаётся рабочим
    # даже при обрыве публикации. Старые части не удаляем, пока их могут читать.
    for file_name, chunk in zip(names, chunks):
        write_json_atomic(deck_dir / file_name, chunk)
    write_json_atomic(deck_dir / "deck.json", deck)

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
    write_json_atomic(DECKS_DIR / "index.json", {"decks": decks})



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

    with_note = sum(1 for card in cards if card.get("note"))
    print(f"с заметкой: {with_note} из {len(cards)} ({with_note / len(cards):.0%})")
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
