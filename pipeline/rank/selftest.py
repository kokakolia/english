"""Проверки правил ранжирования.

Запуск: `python -m pipeline.rank.selftest`
"""

from __future__ import annotations

import sys

from . import score as scoring
from .build import interleave_by_headword
from .cefr import normalize_key

_failures: list[str] = []


def check(name: str, actual, expected) -> None:
    if actual != expected:
        _failures.append(f"{name}\n    получено: {actual!r}\n    ожидалось: {expected!r}")


def check_true(name: str, value) -> None:
    if not value:
        _failures.append(f"{name}\n    получено: {value!r}, ожидалось истинное")


def fake_zipf(word: str, _lang: str = "en") -> float:
    """Частотности для проверок: предлог заведомо частотнее знаменательных."""
    return {
        "of": 7.0, "in": 6.9, "to": 7.2,
        "time": 5.8, "decision": 4.9, "make": 5.6, "can": 5.7,
        "momentous": 2.9, "sth": 0.0,
    }.get(word, 4.0)


def test_normalize_key() -> None:
    check("ключ: хвост в скобках отбрасывается",
          normalize_key("tough (difficult, hard, tough)"), "tough")
    check("ключ: тильда отделяется", normalize_key("in a/the~"), "in a/the ~")
    check("ключ: регистр", normalize_key("Come To"), "come to")


def test_phrase_zipf() -> None:
    # У многословной записи трудность задаёт самая редкая часть.
    check("частотность фразы: минимум по словам",
          scoring.phrase_zipf("make decision", fake_zipf), 4.9)
    # Плейсхолдеры и тильда словами не являются.
    check("частотность фразы: плейсхолдер игнорируется",
          scoring.phrase_zipf("take sth", fake_zipf), 4.0)
    check("частотность фразы: тильда игнорируется",
          scoring.phrase_zipf("~ of", fake_zipf), 7.0)
    check("частотность фразы: пусто", scoring.phrase_zipf("~", fake_zipf), 0.0)


def test_bands() -> None:
    check("полоса: обиходная", scoring.band_for(5.8), "core")
    check("полоса: частая", scoring.band_for(4.2), "common")
    check("полоса: расширенная", scoring.band_for(3.1), "extended")
    check("полоса: редкая", scoring.band_for(2.0), "rare")


def test_preposition_cap() -> None:
    # Предлог не должен обгонять знаменательное слово только за счёт частотности.
    verb = scoring.compute("decision", "make", True, False, fake_zipf, "verb+obj")
    prep = scoring.compute("decision", "of", True, False, fake_zipf, "prep")
    check_true("потолок: глагольная пара выше предложной", verb.value > prep.value)
    # Сам потолок применяется именно к партнёру.
    check("потолок: частотность партнёра обрезана в оценке, но не в отчёте",
          prep.collocate_zipf, 7.0)


def test_penalties() -> None:
    ready = scoring.compute("decision", "make", True, False, fake_zipf, "verb+obj")
    unready = scoring.compute("decision", "make", False, False, fake_zipf, "verb+obj")
    review = scoring.compute("decision", "make", True, True, fake_zipf, "verb+obj")
    check_true("готовая к карточке выше незаконченной", ready.value > unready.value)
    check_true("требующая проверки ниже чистой", review.value < ready.value)


def test_interleave() -> None:
    # (id, score, level, headword) — важен только четвёртый элемент.
    scored = [
        ("a1", None, None, "time"),
        ("a2", None, None, "time"),
        ("a3", None, None, "time"),
        ("b1", None, None, "will"),
        ("b2", None, None, "will"),
        ("c1", None, None, "can"),
    ]
    order = [item[0] for item in interleave_by_headword(scored)]
    check("чередование: по кругу между словами",
          order, ["a1", "b1", "c1", "a2", "b2", "a3"])
    check("чередование: ничего не теряется и не дублируется",
          sorted(order), ["a1", "a2", "a3", "b1", "b2", "c1"])
    check("чередование: пустой вход", interleave_by_headword([]), [])


def main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    if _failures:
        print(f"ПРОВАЛЕНО проверок: {len(_failures)}\n")
        for failure in _failures:
            print(f"  {failure}\n")
        return 1
    print(f"все проверки пройдены ({len(tests)} групп)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
