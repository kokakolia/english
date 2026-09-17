"""Хранилище заметок об употреблении коллокаций.

Заметка отвечает на вопрос, которого не видно из самой карточки: когда так
говорят и чем отличаются варианты внутри кластера. Карточка принимает и `make`,
и `take`, и `reach a decision` — но это не значит, что они равнозначны, и
именно это различие стоит объяснить.

Как и переводы, заметки написаны руками и повторным запуском не
восстанавливаются, поэтому лежат **в репозитории**: `notes/usage-ru.tsv`,
три колонки — идентификатор коллокации, подпись (для читаемости) и текст.

Ключ — `card.id`, то есть тот же стабильный идентификатор коллокации: хэш от
заголовочного слова, типа отношения, значения и набора партнёров. Если словарь
переcкачают и набор партнёров в кластере изменится, заметка к нему больше не
подойдёт и перестанет использоваться — это правильное поведение, потому что
она описывает именно этот набор.
"""

from __future__ import annotations

from pathlib import Path

NOTES_DIR = Path(__file__).resolve().parents[2] / "notes"
TSV_PATH = NOTES_DIR / "usage-ru.tsv"

HEADER = "# id\tподпись\tзаметка"


def _normalize(text: str) -> str:
    return " ".join(str(text or "").split())


def load_rows() -> dict[str, tuple[str, str]]:
    """id → (подпись, заметка)."""
    if not TSV_PATH.exists():
        return {}
    rows: dict[str, tuple[str, str]] = {}
    for line in TSV_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        card_id, phrase, note = parts
        rows[card_id] = (phrase, note)
    return rows


def load_all() -> dict[str, str]:
    """id → заметка."""
    return {card_id: note for card_id, (_, note) in load_rows().items()}


def _write(rows: dict[str, tuple[str, str]]) -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    # Сортируем по подписи: так соседние строки описывают похожие коллокации.
    for card_id, (phrase, note) in sorted(rows.items(), key=lambda item: item[1][0]):
        lines.append(f"{card_id}\t{phrase}\t{note}")
    TSV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def save_many(items: list[tuple[str, str, str]]) -> tuple[int, int]:
    """Сохраняет тройки (id, подпись, заметка). Возвращает (добавлено, обновлено)."""
    rows = load_rows()
    added = updated = 0
    for card_id, phrase, note in items:
        card_id, phrase, note = card_id.strip(), _normalize(phrase), _normalize(note)
        if not card_id or not note:
            continue
        existing = rows.get(card_id)
        if existing is None:
            added += 1
        elif existing[1] != note:
            updated += 1
        else:
            continue
        rows[card_id] = (phrase, note)
    if added or updated:
        _write(rows)
    return added, updated


def forget_unused(live_ids: set[str]) -> int:
    """Убирает заметки коллокаций, которых больше нет в колоде."""
    rows = load_rows()
    stale = [card_id for card_id in rows if card_id not in live_ids]
    for card_id in stale:
        del rows[card_id]
    if stale:
        _write(rows)
    return len(stale)
