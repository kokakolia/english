"""Хранилище заметок об употреблении коллокаций.

Заметка отвечает на вопрос, которого не видно из самой карточки: когда так
говорят и чем отличаются варианты внутри кластера. Карточка принимает и `make`,
и `take`, и `reach a decision` — но это не значит, что они равнозначны, и
именно это различие стоит объяснить.

Как и переводы, заметки написаны руками и повторным запуском не
восстанавливаются, поэтому лежат **в репозитории**: `notes/usage-ru.tsv`,
четыре колонки — ID, подпись, текст и хэш контекста.

Ключ — постоянный card.id из реестра. Четвёртая колонка хранит хэш
контекста (набор партнёров, клоуз и ответ). При его изменении заметка
потребует проверки, но ID карточки и прогресс сохранятся.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from ..files import atomic_write_text, read_tsv
from ..locking import serialized_file_update

NOTES_DIR = Path(__file__).resolve().parents[2] / "notes"
TSV_PATH = NOTES_DIR / "usage-ru.tsv"

HEADER = "# id\tподпись\tзаметка\tконтекст"


def _normalize(text: str) -> str:
    return " ".join(str(text or "").split())


def load_rows() -> dict[str, tuple[str, str]]:
    """id → (подпись, заметка)."""
    return _snapshot()[0]


def _snapshot() -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    """Текст и контекст читаются из одной версии файла."""
    rows: dict[str, tuple[str, str]] = {}
    contexts: dict[str, str] = {}
    for parts in read_tsv(TSV_PATH, (3, 4)):
        card_id, phrase, note = parts[:3]
        rows[card_id] = (phrase, note)
        if len(parts) == 4:
            contexts[card_id] = parts[3]
    return rows, contexts


def load_all() -> dict[str, str]:
    """id → заметка."""
    return {card_id: note for card_id, (_, note) in load_rows().items()}


def context_key(accept: list[str], text: str, answer: str) -> str:
    payload = [sorted(w.lower() for w in accept), _normalize(text), _normalize(answer)]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode("utf-8")).hexdigest()


def load_contexts() -> dict[str, str]:
    return _snapshot()[1]


def notes_for(cards: list[dict]) -> dict[str, str]:
    rows, contexts = _snapshot()
    return {c["id"]: rows[c["id"]][1] for c in cards if c["id"] in rows and
            contexts.get(c["id"]) == context_key(c["accept"], c["text"], c["answer"])}


def _write(rows: dict[str, tuple[str, str]], contexts: dict[str, str] | None = None) -> None:
    contexts = contexts if contexts is not None else load_contexts()
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    # Сортируем по подписи: так соседние строки описывают похожие коллокации.
    for card_id, (phrase, note) in sorted(rows.items(), key=lambda item: item[1][0]):
        lines.append(f"{card_id}\t{phrase}\t{note}\t{contexts.get(card_id, '')}")
    atomic_write_text(TSV_PATH, "\n".join(lines) + "\n")


@serialized_file_update(lambda: TSV_PATH)
def save_many(items: list[tuple[str, str, str]], contexts: dict[str, str] | None = None) -> tuple[int, int]:
    """Сохраняет тройки (id, подпись, заметка). Возвращает (добавлено, обновлено)."""
    rows, saved_contexts = _snapshot()
    context_changed = False
    added = updated = 0
    for card_id, phrase, note in items:
        card_id, phrase, note = card_id.strip(), _normalize(phrase), _normalize(note)
        if not card_id or not phrase or not note:
            continue
        if any(character.isspace() for character in card_id):
            raise ValueError(f"неверный ID карточки: {card_id!r}")
        if contexts and card_id in contexts and any(character.isspace() for character in contexts[card_id]):
            raise ValueError(f"неверный контекст карточки {card_id}")
        if contexts and card_id in contexts and saved_contexts.get(card_id) != contexts[card_id]:
            saved_contexts[card_id] = contexts[card_id]
            context_changed = True
        existing = rows.get(card_id)
        if existing is None:
            added += 1
        elif existing[1] != note:
            updated += 1
        else:
            continue
        rows[card_id] = (phrase, note)
    if added or updated or context_changed:
        _write(rows, saved_contexts)
    return added, updated


@serialized_file_update(lambda: TSV_PATH)
def forget_unused(live_ids: set[str]) -> int:
    """Убирает заметки коллокаций, которых больше нет в колоде."""
    rows, contexts = _snapshot()
    stale = [card_id for card_id in rows if card_id not in live_ids]
    for card_id in stale:
        del rows[card_id]
    if stale:
        _write(rows, contexts)
    return len(stale)
