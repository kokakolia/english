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
import sys
from datetime import datetime, timezone
from pathlib import Path

from .build import DECKS_DIR

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
.hint { font-size: 17px; color: #8a8a85; letter-spacing: 2px; font-family: monospace; }
.answer { font-size: 26px; font-weight: 600; color: #1f7a4d; margin-bottom: 10px; }
.nightMode .answer { color: #6ecf9a; }
.full b { color: #1f7a4d; }
.nightMode .full b { color: #6ecf9a; }
.accept { font-size: 16px; color: #6a6a66; margin-top: 12px; }
.meta { font-size: 14px; color: #9a9a95; margin-top: 14px; }
hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
.nightMode hr { border-top-color: #3a3a3a; }
"""

FRONT_TEMPLATE = """
<div class="sentence">{{Text}}</div>
<div class="hint">{{Hint}}</div>
"""

BACK_TEMPLATE = """
{{FrontSide}}
<hr>
<div class="answer">{{Answer}}</div>
<div class="full">{{Full}}</div>
<div class="accept">{{Accept}}</div>
<div class="meta">{{Phrase}} · {{Meta}}</div>
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


def _card_fields(card: dict) -> list[str]:
    text = html.escape(card["text"]).replace("___", GAP_HTML)
    full = html.escape(card["text"]).replace(
        "___", f"<b>{html.escape(card['answer'])}</b>"
    )
    accept = ", ".join(card["accept"])
    level = card["cefr"] or "уровень не размечен"
    meta = f"{card['relation']} · {card['band']} · {level}"
    return [
        text,
        html.escape(card["answer"]),
        html.escape(card["hint"]),
        full,
        html.escape(f"варианты кластера: {accept}"),
        html.escape(card["phrase"]),
        html.escape(meta),
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
        _stable_id("collocation-cloze-model-v1"),
        "Коллокация (пропуск)",
        fields=[
            {"name": "Text"}, {"name": "Answer"}, {"name": "Hint"}, {"name": "Full"},
            {"name": "Accept"}, {"name": "Phrase"}, {"name": "Meta"}, {"name": "CardId"},
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
  .hint {{ font-family: monospace; color: #999; letter-spacing: 2px; font-size: 15px;
          margin-top: 6px; }}
  details {{ margin-top: 10px; }}
  summary {{ cursor: pointer; color: #777; font-size: 14px; }}
  .answer {{ font-size: 17px; font-weight: 600; color: #1f7a4d; margin-top: 8px; }}
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
  <div class="hint">{hint}</div>
  <details><summary>показать ответ</summary>
    <div class="answer">{answer}</div>
    <div class="accept">варианты кластера: {accept}</div>
    <div class="meta">{phrase} · {relation} · {band} · {level} · неоднозначность {ambiguity}</div>
    {flags}
  </details>
</div>"""


def cmd_html(args: argparse.Namespace) -> int:
    meta, cards = load_deck(args.deck_id)
    if args.relation:
        cards = [card for card in cards if card["relation"] == args.relation]
    if not cards:
        print("под фильтр ничего не попало", file=sys.stderr)
        return 1

    # Фиксированное зерно: выборка воспроизводима, и замечания к карточке
    # можно потом найти по номеру.
    sample = random.Random(args.seed).sample(cards, min(args.n, len(cards)))
    sample.sort(key=lambda card: card["position"])

    rendered = []
    for card in sample:
        flags = card.get("flags") or []
        rendered.append(
            HTML_CARD.format(
                position=card["position"],
                text=html.escape(card["text"]).replace("___", GAP_HTML),
                hint=html.escape(card["hint"]),
                answer=html.escape(card["answer"]),
                accept=html.escape(", ".join(card["accept"])),
                phrase=html.escape(card["phrase"]),
                relation=card["relation"],
                band=card["band"],
                level=card["cefr"] or "уровень не размечен",
                ambiguity=card["ambiguity"],
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
    p_html.add_argument("--out", help="каталог для файла")
    p_html.set_defaults(func=cmd_html)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
