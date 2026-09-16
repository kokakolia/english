"""Этап 0.6 — годность пропуска.

Не всякая найденная коллокация даёт рабочую карточку. Здесь считаются признаки,
по которым запись либо отбраковывается, либо помечается.

Главный из них — **неоднозначность**. У слова `decision` полтора десятка
кластеров прилагательных, и в пропуск «She had to make a ___ decision about the
job» грамматически встанет и `tough`, и `important`, и `big`. Замер по 1186
карточкам: без подсказки у 72% есть три и более конкурента из соседних кластеров
того же слова. С подсказкой по первой букве у 55% конкурентов не остаётся вовсе,
и только у 15% их трое и больше.

Отсюда решение: подсказка — не украшение, а часть карточки. Конкуренты
считаются уже с её учётом.
"""

from __future__ import annotations

import collections
import re
from dataclasses import dataclass, field

from ..normalize.inflect import forms

# Служебные слова: их повтор в предложении ответа не выдаёт.
_FUNCTION_WORDS = {
    "a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "with", "from",
    "up", "out", "off", "over", "into", "your", "his", "her", "their", "my",
    "its", "our", "be", "is", "are", "was", "were", "and", "or", "as", "that",
    "this", "it", "sb", "sth", "one", "own", "no", "not", "so", "if",
}

MIN_SENTENCE_WORDS = 6
MAX_SENTENCE_WORDS = 20
# Пропуск, занимающий треть предложения и длиннее трёх слов, оставляет слишком
# мало контекста, чтобы его можно было восстановить.
MAX_GAP_SHARE = 1 / 3
MAX_GAP_WORDS = 3

AMBIGUITY_LOW, AMBIGUITY_MEDIUM, AMBIGUITY_HIGH = "low", "medium", "high"

# Заглавное слово не в начале предложения — имя собственное.
_PROPER_NOUN_RE = re.compile(r"(?<=[a-z,] )\b[A-Z][a-z]{2,}")


@dataclass
class Quality:
    hint: str
    rivals: int                  # конкуренты, оставшиеся после подсказки
    ambiguity: str
    usable: bool
    flags: list[str] = field(default_factory=list)
    reason: str | None = None    # по какому признаку карточка отбракована


def make_hint(answer: str) -> str:
    """`tough` → `t____`, `go out of your way` → `g_ o__ o_ y___ w__`."""
    parts = []
    for token in answer.split():
        letters = [char for char in token if char.isalpha()]
        if not letters:
            parts.append(token)
            continue
        parts.append(token[0] + "_" * (len(letters) - 1))
    return " ".join(parts)


def rival_index(rows) -> dict[tuple, list[tuple[str, set[str]]]]:
    """Группирует коллокации по (заголовок, отношение, значение).

    Партнёры из одной группы конкурируют за один и тот же пропуск: они стоят
    в той же грамматической позиции при том же слове в том же значении.
    """
    index: dict[tuple, list[tuple[str, set[str]]]] = collections.defaultdict(list)
    for record_id, headword, relation, sense, accept in rows:
        key = (headword, relation, sense)
        index[key].append((record_id, {word.lower() for word in accept}))
    return index


def count_rivals(index, record_id: str, key: tuple, own: set[str], answer: str) -> int:
    """Сколько чужих партнёров начинаются с той же буквы, что и ответ."""
    letter = answer[:1].lower()
    if not letter:
        return 0
    rivals: set[str] = set()
    for other_id, words in index.get(key, ()):
        if other_id == record_id:
            continue
        rivals |= {word for word in words if word[:1].lower() == letter}
    return len(rivals - own)


def _answer_repeated(example: str, gap: tuple[int, int], answer: str) -> bool:
    """Встречается ли ответ где-то ещё в предложении — тогда его можно списать."""
    rest = example[: gap[0]] + " " + example[gap[1]:]
    for token in answer.lower().split():
        clean = token.strip(".,;:!?'\"")
        if len(clean) <= 3 or clean in _FUNCTION_WORDS:
            continue
        for form in forms(clean):
            if len(form) > 3 and re.search(rf"\b{re.escape(form)}\b", rest, re.IGNORECASE):
                return True
    return False


def assess(example: str, gap_start: int, gap_end: int, rivals: int) -> Quality:
    """Признаки годности одной карточки."""
    answer = example[gap_start:gap_end]
    words = example.split()
    gap_words = len(answer.split())
    flags: list[str] = []

    # Отбраковка: такие карточки не учат ничему. Причина запоминается первая —
    # иначе в отчёте одна карточка попадёт сразу в несколько строк.
    reason: str | None = None
    if gap_start == 0:
        # Ответ с заглавной буквы и без левого контекста.
        flags.append("gap_at_start")
        reason = reason or "gap_at_start"
    if _answer_repeated(example, (gap_start, gap_end), answer):
        flags.append("answer_repeated")
        reason = reason or "answer_repeated"
    if gap_words > MAX_GAP_WORDS and gap_words > len(words) * MAX_GAP_SHARE:
        flags.append("gap_too_large")
        reason = reason or "gap_too_large"
    if len(words) < MIN_SENTENCE_WORDS:
        flags.append("sentence_too_short")
        reason = reason or "sentence_too_short"

    # Пометки: карточка рабочая, но на любителя.
    if len(words) > MAX_SENTENCE_WORDS:
        flags.append("sentence_long")
    if _PROPER_NOUN_RE.search(example):
        flags.append("proper_noun")

    if rivals == 0:
        ambiguity = AMBIGUITY_LOW
    elif rivals <= 2:
        ambiguity = AMBIGUITY_MEDIUM
    else:
        ambiguity = AMBIGUITY_HIGH
        flags.append("ambiguous")

    return Quality(
        hint=make_hint(answer),
        rivals=rivals,
        ambiguity=ambiguity,
        usable=reason is None,
        flags=flags,
        reason=reason,
    )
