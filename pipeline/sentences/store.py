"""Хранилище правок предложений.

Предложения-примеры приходят из ozdic, и часть из них негодна. Не опечатки —
целые фразы, собранные машиной без оглядки на грамматику. Показательный случай:
для заголовочного слова `last` (глагол, «длиться») и наречия `never` словарь
выдал

    I have never last seen her so angry about a simple mistake.

Здесь `last` воткнут в готовую фразу «I have never seen her so angry» просто
потому, что он заголовочный. Коллокация имелась в виду совсем другая —
`never last`, «никогда не продлится».

Автоматически такое не ловится: предложение состоит из настоящих слов, в нём
есть и наречие, и заголовочное слово, а бессмысленно оно только для читающего.
Поэтому правки делаются руками и, как переводы и заметки, лежат **в
репозитории**: повторным запуском пайплайна они не восстанавливаются.

Формат — `sentences/fixes.tsv`, четыре колонки:

    ключ  исходное предложение  исправленный клоуз  ответ

Исправленный клоуз содержит `___` на месте пропуска, а ответ хранится отдельно.
Так сделано намеренно: заново искать пропуск в исправленном предложении значит
повторять тот самый поиск, который однажды уже затянул в пропуск пол-фразы.
Здесь границы заданы явно и ошибиться негде.

Ключ — хэш исходного предложения, а не идентификатор карточки: идентификатор
меняется вместе с набором партнёров в кластере, а предложение остаётся собой.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from ..files import atomic_write_text, read_tsv

# Репозиторий, а не pipeline/data: data в git не попадает.
SENTENCES_DIR = Path(__file__).resolve().parents[2] / "sentences"
TSV_PATH = SENTENCES_DIR / "fixes.tsv"

HEADER = "# ключ\tисходное\tисправленный клоуз\tответ"


def key_for(sentence: str) -> str:
    """Ключ правки — хэш нормализованного исходного предложения."""
    normalized = " ".join(str(sentence or "").split())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def load_all() -> dict[str, tuple[str, str]]:
    """ключ исходного предложения → (исправленный клоуз, ответ)."""
    fixes: dict[str, tuple[str, str]] = {}
    for parts in read_tsv(TSV_PATH, (4,)):
        key, _original, cloze, answer = parts
        # Пропуск обязан быть ровно один. Без него карточка показала бы
        # готовый ответ вместо задания, а с двумя — приложение разбирает текст
        # на «до» и «после» и молча теряет хвост. И то и другое ломается тихо,
        # поэтому повреждённый файл останавливает сборку до перезаписи.
        if cloze.count("___") != 1:
            raise ValueError(f"{TSV_PATH}: в правке {key} должен быть ровно один пропуск")
        fixes[key] = (cloze, answer)
    return fixes


def save(original: str, cloze: str, answer: str) -> None:
    """Добавляет или заменяет правку, сохраняя файл отсортированным."""
    rows: dict[str, tuple[str, str, str]] = {}
    load_all()  # Проверяем и смысл старых правок до любой перезаписи.
    for parts in read_tsv(TSV_PATH, (4,)):
        rows[parts[0]] = (parts[1], parts[2], parts[3])

    normalized = " ".join(original.split())
    fixed = " ".join(cloze.split())
    answer = " ".join(answer.split())
    if not normalized or not answer:
        raise ValueError("исходное предложение и ответ не могут быть пустыми")
    if fixed.count("___") != 1:
        raise ValueError(f"в правке должен быть ровно один пропуск: {fixed!r}")
    rows[key_for(normalized)] = (normalized, fixed, answer.strip())

    SENTENCES_DIR.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    # Сортировка по исходному предложению: правки видно в diff построчно.
    for key, (source, fixed, ans) in sorted(rows.items(), key=lambda item: item[1][0]):
        lines.append(f"{key}\t{source}\t{fixed}\t{ans}")
    atomic_write_text(TSV_PATH, "\n".join(lines) + "\n")
