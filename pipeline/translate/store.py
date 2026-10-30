"""Хранилище переводов предложений.

Переводы сделаны руками и, в отличие от скачанного сырья, повторным запуском
не восстанавливаются. Поэтому они лежат **в репозитории**, обычным текстовым
файлом: `translations/en-ru.tsv`, три колонки — ключ, английский, русский.
Файл отсортирован по английскому предложению, так что изменения видно в diff
построчно и их можно просматривать как код.

Перевод привязан к **тексту предложения**, а не к карточке. Это важно в обе
стороны: набор партнёров в кластере может измениться, идентификатор карточки
вместе с ним — а предложение останется прежним, и переводить его заново
незачем. И наоборот, если пример заменили, перевод старого предложения к новому
не подходит и перестаёт использоваться.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from ..files import atomic_write_text, read_tsv

# Репозиторий, а не pipeline/data: data в git не попадает.
TRANSLATIONS_DIR = Path(__file__).resolve().parents[2] / "translations"
TSV_PATH = TRANSLATIONS_DIR / "en-ru.tsv"

HEADER = "# ключ\tанглийский\tрусский"


def key_for(sentence: str) -> str:
    """Ключ перевода — хэш нормализованного предложения."""
    normalized = " ".join(str(sentence or "").split())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def _normalize(text: str) -> str:
    return " ".join(str(text or "").split())


def load_pairs() -> dict[str, tuple[str, str]]:
    """ключ → (английское предложение, перевод)."""
    pairs: dict[str, tuple[str, str]] = {}
    for parts in read_tsv(TSV_PATH, (3,)):
        key, english, russian = parts
        pairs[key] = (english, russian)
    return pairs


def load_all() -> dict[str, str]:
    """ключ → перевод."""
    return {key: russian for key, (_, russian) in load_pairs().items()}


def _write(pairs: dict[str, tuple[str, str]]) -> None:
    TRANSLATIONS_DIR.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    # Сортируем по английскому: так diff читается по-человечески.
    for key, (english, russian) in sorted(pairs.items(), key=lambda item: item[1][0]):
        lines.append(f"{key}\t{english}\t{russian}")
    atomic_write_text(TSV_PATH, "\n".join(lines) + "\n")


def save_many(items: list[tuple[str, str]]) -> tuple[int, int]:
    """Сохраняет пары (английское предложение, перевод).

    Возвращает (добавлено, обновлено).
    """
    pairs = load_pairs()
    added = updated = 0
    for english, russian in items:
        english, russian = _normalize(english), _normalize(russian)
        if not english or not russian:
            continue
        key = key_for(english)
        existing = pairs.get(key)
        if existing is None:
            added += 1
        elif existing[1] != russian:
            updated += 1
        else:
            continue
        pairs[key] = (english, russian)
    if added or updated:
        _write(pairs)
    return added, updated


def forget_unused(live_keys: set[str]) -> int:
    """Убирает переводы предложений, которых больше нет ни в одной карточке."""
    pairs = load_pairs()
    stale = [key for key in pairs if key not in live_keys]
    for key in stale:
        del pairs[key]
    if stale:
        _write(pairs)
    return len(stale)
