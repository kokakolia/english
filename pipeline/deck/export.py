"""Этап 0.8 — выгрузка колоды наружу.

Две цели, обе про проверку материала до того, как появится своё приложение:

* `anki` — файл `.apkg`, чтобы учить и смотреть карточки в Anki уже сейчас;
* `html` — страница со случайной сотней карточек для ручного просмотра.

Выгрузка идёт из `decks/`, а не из базы: проверять надо ровно то, что получит
приложение.

    python -m pipeline.deck.export anki
    python -m pipeline.deck.export html -n 100 --seed 1
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from .build import DECKS_DIR, content_hash, content_version

EXPORT_DIR = Path(__file__).resolve().parents[1] / "data" / "export"

GAP_HTML = '<span class="gap">_____</span>'

ANKI_CSS = """
.card {
  font-family: -apple-system, Segoe UI, Roboto, sans-serif;
  font-size: 20px;
  text-align: left;
  color: #1a1a1a;
  background: #fbfbfa;
  padding: 18px;
  line-height: 1.55;
}
.nightMode.card, .night_mode .card { color: #e8e8e6; background: #1f1f1f; }
.sentence { font-size: 23px; margin-bottom: 14px; }
.gap { color: #b0641e; font-weight: 600; letter-spacing: 1px; }
.nightMode .gap { color: #e5a05a; }
.translation { font-size: 18px; color: #6a6a66; margin-bottom: 12px; }
.nightMode .translation { color: #a8a8a2; }
.hint { font-size: 17px; color: #8a8a85; letter-spacing: 2px; font-family: monospace; }
.answer { font-size: 26px; font-weight: 600; color: #1f7a4d; margin-bottom: 10px; }
.nightMode .answer { color: #6ecf9a; }
.full b { color: #1f7a4d; }
.nightMode .full b { color: #6ecf9a; }
.note { font-size: 16px; color: #4a4a46; margin-top: 16px; padding-left: 12px;
        border-left: 3px solid #d8d3c8; line-height: 1.5; }
.nightMode .note { color: #c8c8c2; border-left-color: #4a463c; }
.accept { font-size: 15px; color: #9a9a95; margin-top: 12px; }
hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
.nightMode hr { border-top-color: #3a3a3a; }
"""

# Перевод стоит на лицевой стороне, а не на обороте: он задаёт смысл, который
# нужно выразить по-английски. Без него пропуск допускает слишком много
# осмысленных вариантов — это угадайка, а не упражнение на продукцию.
FRONT_TEMPLATE = """
<div class="sentence">{{Text}}</div>
<div class="translation">{{Translation}}</div>
<div class="hint">{{Hint}}</div>
"""

BACK_TEMPLATE = """
{{FrontSide}}
<hr>
<div class="answer">{{Answer}}</div>
<div class="full">{{Full}}</div>
<div class="note">{{Note}}</div>
<div class="accept">{{Accept}}</div>
"""


def _stable_id(text: str) -> int:
    """Anki требует числовые идентификаторы, и они должны быть постоянными:
    иначе повторный импорт создаст вторую колоду вместо обновления первой."""
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) | (1 << 30)


def load_deck(deck_id: str) -> tuple[dict, list[dict]]:
    deck_dir = DECKS_DIR / deck_id
    meta_path = deck_dir / "deck.json"
    if not meta_path.exists():
        raise SystemExit(f"колода {deck_id} не собрана — сначала `pipeline.deck.build run`")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    cards: list[dict] = []
    for chunk_name in meta["chunks"]:
        cards.extend(json.loads((deck_dir / chunk_name).read_text(encoding="utf-8")))
    return meta, cards


def all_published_cards() -> list[dict]:
    """Общий контент очищается только по полному, проверенному набору колод."""
    manifests = sorted(DECKS_DIR.glob("*/deck.json"))
    if not manifests:
        raise ValueError("нет опубликованных колод: очистка отменена")
    index = json.loads((DECKS_DIR / "index.json").read_text(encoding="utf-8"))
    if not isinstance(index, dict):
        raise ValueError("неверный каталог колод: очистка отменена")
    available = {manifest.parent.name for manifest in manifests}
    declared = index.get("decks")
    if not isinstance(declared, list) or any(
        not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or
        not re.fullmatch(r"[a-z0-9-]+", entry["id"]) or entry["id"] not in available or
        entry.get("path") != f"{entry['id']}/deck.json" for entry in declared
    ):
        raise ValueError("каталог колод неполон: очистка отменена")
    result = []
    for manifest in manifests:
        meta, cards = load_deck(manifest.parent.name)
        if len(cards) != meta["count"] or len({card["id"] for card in cards}) != len(cards):
            raise ValueError(f"неполная колода {manifest.parent.name}: очистка отменена")
        integrity = meta.get("integrity")
        if integrity:
            if integrity.get("algorithm") != "sha256-canonical-json-v1":
                raise ValueError("неизвестная проверка целостности: очистка отменена")
            for name in meta["chunks"]:
                part = json.loads((manifest.parent / name).read_text(encoding="utf-8"))
                if content_hash(part) != integrity["chunks"].get(name):
                    raise ValueError(f"повреждена часть {name}: очистка отменена")
            if content_version(cards) != meta["version"]:
                raise ValueError("неверная версия колоды: очистка отменена")
        result.extend(cards)
    return result


def _card_fields(card: dict) -> list[str]:
    text = html.escape(card["text"]).replace("___", GAP_HTML)
    full = html.escape(card["text"]).replace(
        "___", f"<b>{html.escape(card['answer'])}</b>"
    )
    also = ", ".join(card.get("also") or [])
    # Грамматическая разметка на карточку не идёт: она нужна пайплайну и
    # фильтрам, а учащемуся вместо неё полезнее заметка об употреблении.
    # Отбирать подмножества в Anki по-прежнему можно тегами.
    return [
        text,
        html.escape(card["answer"]),
        html.escape(card["hint"]),
        html.escape(card.get("translation") or ""),
        full,
        html.escape(f"другие сочетания с этим словом: {also}") if also else "",
        html.escape(card.get("note") or ""),
        card["id"],
    ]


def cmd_anki(args: argparse.Namespace) -> int:
    try:
        import genanki
    except ImportError:
        print("нужен genanki: pip install -r pipeline/requirements.txt", file=sys.stderr)
        return 1

    meta, cards = load_deck(args.deck_id)
    if args.limit:
        cards = cards[: args.limit]

    model = genanki.Model(
        # Версия в имени обязательна: Anki опознаёт тип заметки по этому
        # идентификатору, и при смене набора полей его нужно поднимать.
        _stable_id("collocation-cloze-model-v3"),
        "Коллокация (пропуск)",
        fields=[
            {"name": "Text"}, {"name": "Answer"}, {"name": "Hint"},
            {"name": "Translation"}, {"name": "Full"}, {"name": "Accept"},
            {"name": "Note"}, {"name": "CardId"},
        ],
        templates=[
            {"name": "Пропуск", "qfmt": FRONT_TEMPLATE, "afmt": BACK_TEMPLATE}
        ],
        css=ANKI_CSS,
    )

    deck = genanki.Deck(_stable_id(meta["id"]), meta["name"])
    for card in cards:
        tags = [
            f"rel::{card['relation'].replace('+', '_')}",
            f"band::{card['band']}",
            f"amb::{card['ambiguity']}",
        ]
        if card["cefr"]:
            tags.append(f"cefr::{card['cefr']}")
        tags.extend(f"flag::{flag}" for flag in card.get("flags", []))
        deck.add_note(
            genanki.Note(
                model=model,
                fields=_card_fields(card),
                # guid от нашего id: повторный экспорт обновит те же заметки,
                # а не насыплет дублей поверх выученного.
                guid=genanki.guid_for(card["id"]),
                tags=tags,
            )
        )

    out_dir = Path(args.out) if args.out else EXPORT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{meta['id']}-{meta['version']}.apkg"
    genanki.Package(deck).write_to_file(out_path)

    print(f"карточек выгружено: {len(cards)}")
    print(f"файл: {out_path}")
    print("повторный импорт обновит эти же заметки, дублей не будет")
    return 0


HTML_PAGE = """<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 840px;
         margin: 0 auto; padding: 32px 20px 80px; line-height: 1.6;
         background: Canvas; color: CanvasText; }}
  h1 {{ font-size: 22px; margin-bottom: 4px; }}
  .lead {{ color: #888; margin-bottom: 28px; font-size: 15px; }}
  .card {{ border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
          border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }}
  .num {{ float: right; color: #aaa; font-size: 13px; }}
  .sentence {{ font-size: 18px; }}
  .gap {{ color: #b0641e; font-weight: 600; letter-spacing: 1px; }}
  .translation {{ color: #888; font-size: 16px; margin-top: 8px; }}
  .hint {{ font-family: monospace; color: #999; letter-spacing: 2px; font-size: 15px;
          margin-top: 6px; }}
  details {{ margin-top: 10px; }}
  summary {{ cursor: pointer; color: #777; font-size: 14px; }}
  .answer {{ font-size: 17px; font-weight: 600; color: #1f7a4d; margin-top: 8px; }}
  .note {{ font-size: 15px; color: CanvasText; margin-top: 10px; padding-left: 10px;
          border-left: 3px solid color-mix(in srgb, CanvasText 25%, transparent); }}
  .accept, .meta {{ font-size: 14px; color: #888; margin-top: 6px; }}
  .flags {{ font-size: 13px; color: #b26b00; margin-top: 6px; }}
</style></head><body>
<h1>{title}</h1>
<div class="lead">{lead}</div>
{cards}
</body></html>
"""

HTML_CARD = """<div class="card">
  <span class="num">#{position}</span>
  <div class="sentence">{text}</div>
  <div class="translation">{translation}</div>
  <div class="hint">{hint}</div>
  <details {open}><summary>показать ответ</summary>
    <div class="answer">{answer}</div>
    {note}
    {also}
    {flags}
  </details>
</div>"""


def cmd_html(args: argparse.Namespace) -> int:
    meta, cards = load_deck(args.deck_id)
    if args.relation:
        cards = [card for card in cards if card["relation"] == args.relation]
    if args.notes_only:
        cards = [card for card in cards if card.get("note")]
    if not cards:
        print("под фильтр ничего не попало", file=sys.stderr)
        return 1

    # Фиксированное зерно: выборка воспроизводима, и замечания к карточке
    # можно потом найти по номеру.
    sample = random.Random(args.seed).sample(cards, min(args.n, len(cards)))
    sample.sort(key=lambda card: card["position"])

    expanded = args.expanded
    rendered = []
    for card in sample:
        flags = card.get("flags") or []
        rendered.append(
            HTML_CARD.format(
                open="open" if expanded else "",
                position=card["position"],
                text=html.escape(card["text"]).replace("___", GAP_HTML),
                translation=html.escape(card.get("translation") or ""),
                hint=html.escape(card["hint"]),
                answer=html.escape(card["answer"]),
                note=(f'<div class="note">{html.escape(card["note"])}</div>'
                      if card.get("note") else ""),
                also=(f'<div class="accept">другие сочетания с этим словом: '
                      f'{html.escape(", ".join(card["also"]))}</div>'
                      if card.get("also") else ""),
                flags=(f'<div class="flags">пометки: {", ".join(flags)}</div>'
                       if flags else ""),
            )
        )

    lead = (
        f"{len(sample)} случайных карточек из {len(cards)} · "
        f"версия колоды {meta['version']} · зерно выборки {args.seed} · "
        f"собрано {datetime.now(timezone.utc):%Y-%m-%d}"
    )
    out_dir = Path(args.out) if args.out else EXPORT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{meta['id']}-sample-{args.seed}.html"
    out_path.write_text(
        HTML_PAGE.format(
            title=html.escape(meta["name"]), lead=html.escape(lead),
            cards="\n".join(rendered),
        ),
        encoding="utf-8",
    )
    print(f"карточек на странице: {len(sample)}")
    print(f"файл: {out_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="export", description="Выгрузка колоды (этап 0.8)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_anki = sub.add_parser("anki", help="файл .apkg для Anki")
    p_anki.add_argument("--deck-id", default="en-collocations")
    p_anki.add_argument("--limit", type=int, default=0)
    p_anki.add_argument("--out", help="каталог для файла")
    p_anki.set_defaults(func=cmd_anki)

    p_html = sub.add_parser("html", help="страница со случайной выборкой")
    p_html.add_argument("--deck-id", default="en-collocations")
    p_html.add_argument("-n", type=int, default=100)
    p_html.add_argument("--seed", type=int, default=1)
    p_html.add_argument("--relation", help="только одно отношение")
    p_html.add_argument("--notes-only", action="store_true",
                        help="только карточки с заметкой об употреблении")
    p_html.add_argument("--expanded", action="store_true",
                        help="сразу раскрыть ответы — для просмотра, а не тренировки")
    p_html.add_argument("--out", help="каталог для файла")
    p_html.set_defaults(func=cmd_html)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
