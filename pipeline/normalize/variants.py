"""Раскрытие сокращённой записи партнёров.

Словарь пишет несколько вариантов одной строкой:
    `(very) important`        → «very important», «important»
    `in a/the ~`              → «in a ~», «in the ~»
    `leg (also legwork)`      → «leg», «legwork»
    `give sb/sth`             → «give sb», «give sth»

Слэш — главная неоднозначность. В `a/the` он разделяет одно слово, а в
`ahead of/behind ~` — на самом деле «ahead of» против «behind», то есть
относится к куску из двух слов. Автоматически это не различить, поэтому
многословные записи со слэшем помечаются `needs_review` и уходят в ручную
или LLM-проверку на этапе 0.8.
"""

from __future__ import annotations

import re

from .limits import MAX_EXPRESSION_CHARS, MAX_VARIANTS, require_budget

# Плейсхолдеры словаря: somebody / something.
PLACEHOLDERS = {"sb", "sth", "sb's", "sth's", "oneself", "yourself"}

_ALSO_RE = re.compile(r"\(\s*(?:also|or)\s+([^)]+)\)")
_OPTIONAL_RE = re.compile(r"\(([^)]+)\)")
_SPACES_RE = re.compile(r"\s+")


def _tidy(text: str) -> str:
    # Тильду отделяем пробелами: словарь пишет `in (a/the)~` слитно, а дальше
    # по пайплайну она должна быть самостоятельным токеном.
    return _SPACES_RE.sub(" ", text.replace("~", " ~ ")).strip()


def _expand_optional(text: str) -> list[str]:
    """`(very) much` → ['very much', 'much']. Раскрывает все скобки разом."""
    results = [text]
    while True:
        grown: list[str] = []
        changed = False
        for item in results:
            match = _OPTIONAL_RE.search(item)
            if not match:
                require_budget(len(grown) + 1, MAX_VARIANTS, "варианты скобок")
                grown.append(item)
                continue
            changed = True
            require_budget(len(grown) + 2, MAX_VARIANTS, "варианты скобок")
            with_part = item[: match.start()] + match.group(1) + item[match.end():]
            without = item[: match.start()] + item[match.end():]
            grown.extend([with_part, without])
        results = grown
        if not changed:
            break
    return [_tidy(item) for item in results if _tidy(item)]


def _expand_slashes(text: str, limit: int = MAX_VARIANTS) -> tuple[list[str], bool]:
    """Раскрывает слэши по токенам. Второе значение — нужна ли проверка."""
    tokens = text.split(" ")
    slashed = [i for i, token in enumerate(tokens) if "/" in token]
    if not slashed:
        require_budget(1, limit, "варианты слова")
        return [text], False

    results = [""]
    for token in tokens:
        parts = token.split("/") if "/" in token else [token]
        require_budget(len(results) * len(parts), limit, "варианты слэшей")
        results = [f"{prefix} {part}".strip() for prefix in results for part in parts]

    # Слэш внутри многословной записи может относиться к куску из двух слов —
    # такие случаи размечаем на проверку.
    needs_review = len(tokens) > 1
    return [_tidy(item) for item in results if _tidy(item)], needs_review


def expand(word: str) -> tuple[list[str], bool]:
    """Все формы записи партнёра. Возвращает (варианты, нужна ли проверка)."""
    require_budget(len(word), MAX_EXPRESSION_CHARS, "длина словарной записи")
    text = _tidy(word)
    if not text:
        return [], False

    extra: list[str] = []
    also = _ALSO_RE.search(text)
    if also:
        # `leg (also legwork)` — отдельная равноправная форма, а не опция.
        extra.append(_tidy(also.group(1)))
        text = _tidy(text[: also.start()] + text[also.end():])

    variants: list[str] = []
    needs_review = False
    for optional_form in _expand_optional(text) or [text]:
        expanded, review = _expand_slashes(optional_form, MAX_VARIANTS - len(variants))
        variants.extend(expanded)
        needs_review = needs_review or review

    for item in extra:
        expanded, review = _expand_slashes(item, MAX_VARIANTS - len(variants))
        variants.extend(expanded)
        needs_review = needs_review or review

    # Убираем дубликаты, сохраняя порядок: первый вариант — основной.
    seen: set[str] = set()
    unique = []
    for item in variants:
        key = item.lower()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique, needs_review


def strip_placeholders(text: str) -> str:
    """`consider sth` → `consider`. Для построения подписи без служебных слов."""
    tokens = [t for t in text.split() if t.lower().strip(",.") not in PLACEHOLDERS]
    return " ".join(tokens)
