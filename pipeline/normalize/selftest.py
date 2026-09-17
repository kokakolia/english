"""Проверки правил нормализации.

Запуск: `python -m pipeline.normalize.selftest`

Правила разбора — самое хрупкое место пайплайна: каждая правка легко ломает
случай, разобранный неделю назад. Все примеры ниже взяты из реальных статей.
Внешних зависимостей нет намеренно, чтобы проверки запускались одной командой.
"""

from __future__ import annotations

import sys

from .build import _locate, _sequence_for
from .inflect import find_span, forms
from .patterns import AFTER, BEFORE, PHRASE, TEMPLATE, build_phrase, parse_cat, parse_gloss
from .variants import expand

_failures: list[str] = []


def check(name: str, actual, expected) -> None:
    if actual != expected:
        _failures.append(f"{name}\n    получено: {actual!r}\n    ожидалось: {expected!r}")


def rel_pos(pattern) -> tuple[str, str]:
    return pattern.relation, pattern.position


def check_true(name: str, value) -> None:
    if not value:
        _failures.append(f"{name}\n    получено: {value!r}, ожидалось истинное")


def test_gloss() -> None:
    check("gloss: часть речи", parse_gloss("(noun.)"), ("noun", None))
    check("gloss: с уточнением значения",
          parse_gloss("(adj.) recently built/made"), ("adj", "recently built/made"))
    check("gloss: несколько частей речи", parse_gloss("(adj., pron.)"), ("adj", None))
    check("gloss: пусто", parse_gloss(None), (None, None))


def test_cat() -> None:
    # Метка части речи указывает, где стоит партнёр.
    check("cat: VERB + DECISION",
          rel_pos(parse_cat("VERB + DECISION", "decision", "noun")), ("verb+obj", BEFORE))
    check("cat: DECISION + NOUN",
          rel_pos(parse_cat("DECISION + NOUN", "decision", "noun")), ("noun+noun", AFTER))
    check("cat: TIME + VERB",
          rel_pos(parse_cat("TIME + VERB", "time", "noun")), ("noun+verb", AFTER))
    check("cat: ADJ.", rel_pos(parse_cat("ADJ.", "decision", "noun")), ("adj+noun", BEFORE))
    check("cat: PREP", rel_pos(parse_cat("PREP", "decision", "noun")), ("prep", TEMPLATE))
    check("cat: PHRASES",
          rel_pos(parse_cat("PHRASES", "decision", "noun")), ("phrase", PHRASE))
    # VERBS у прилагательного — связочные глаголы, а не глаголы с дополнением.
    check("cat: VERBS при прилагательном",
          parse_cat("VERBS", "good", "adj").relation, "verb+adj")
    check("cat: VERBS при существительном",
          parse_cat("VERBS", "decision", "noun").relation, "verb+obj")
    check("cat: ADV при прилагательном", parse_cat("ADV", "good", "adj").relation, "adv+adj")
    check("cat: ADV при глаголе", parse_cat("ADV", "run", "verb").relation, "adv+verb")


def test_phrase_label() -> None:
    pattern = parse_cat("VERB + DECISION", "decision", "noun")
    check("подпись: партнёр впереди",
          build_phrase(pattern, "decision", "make"), "make decision")
    pattern = parse_cat("DECISION + NOUN", "decision", "noun")
    check("подпись: партнёр сзади",
          build_phrase(pattern, "decision", "maker"), "decision maker")
    pattern = parse_cat("PREP", "decision", "noun")
    check("подпись: тильда — это заголовочное слово",
          build_phrase(pattern, "decision", "~ about"), "decision about")


def test_variants() -> None:
    check("варианты: необязательная часть",
          expand("(very) much")[0], ["very much", "much"])
    check("варианты: слэш в одном слове",
          expand("a/the")[0], ["a", "the"])
    check("варианты: also — равноправная форма",
          expand("leg (also legwork)")[0], ["leg", "legwork"])
    check("варианты: плейсхолдеры", expand("give sb/sth")[0], ["give sb", "give sth"])
    # Тильда, слипшаяся с соседним токеном, должна отделиться.
    check("варианты: тильда отделяется",
          expand("in (a/the)~")[0], ["in a ~", "in the ~", "in ~"])
    check_true("варианты: многословный слэш помечен на проверку",
               expand("ahead of/behind ~")[1])
    check("варианты: однословный слэш проверки не требует", expand("a/the")[1], False)


def test_forms() -> None:
    check_true("формы: неправильный глагол get", "gotten" in forms("get"))
    check_true("формы: неправильный глагол come", "came" in forms("come"))
    check_true("формы: правильный глагол", "demonstrated" in forms("demonstrate"))
    check_true("формы: удвоение согласной", "stopped" in forms("stop"))
    check_true("формы: -y → -ies", "studies" in forms("study"))
    check_true("формы: степень сравнения", "best" in forms("good"))
    check_true("формы: множественное число", "children" in forms("child"))


def test_find_span() -> None:
    text = "My English has gotten better since I started practicing."
    span = find_span(text, "gotten")
    check_true("поиск: находит словоформу", span is not None)
    check("поиск: границы совпадают", text[span[0]:span[1]], "gotten")
    check("поиск: чего нет — того нет", find_span(text, "decision"), None)


def test_sequence() -> None:
    # Один партнёр перед заголовочным словом.
    tokens, gap = _sequence_for(BEFORE, "decision", "make")
    check("последовательность: партнёр впереди", (tokens, gap), (["make", "decision"], (0, 1)))
    # Тильда одна — прячем только партнёра.
    tokens, gap = _sequence_for(TEMPLATE, "way", "~ through")
    check("последовательность: одна тильда", (tokens, gap), (["way", "through"], (1, 2)))
    # Тильд несколько — выражение прячется целиком, иначе в пропуск попадёт
    # само заголовочное слово.
    tokens, gap = _sequence_for(TEMPLATE, "house", "from ~ to ~")
    check("последовательность: две тильды",
          (tokens, gap), (["from", "house", "to", "house"], (0, 4)))


def test_placeholder_not_hidden() -> None:
    # Плейсхолдер держит произвольное дополнение — прятать его нельзя.
    tokens, gap = _sequence_for(BEFORE, "show", "let sth")
    check("последовательность: sth не попадает в пропуск",
          (tokens, gap), (["let", "sth", "show"], (0, 1)))
    tokens, gap = _sequence_for(PHRASE, "home", "see sb home")
    check("последовательность: пропуск обрывается на плейсхолдере",
          (tokens, gap), (["see", "sb", "home"], (0, 1)))
    # Запись целиком из плейсхолдеров прятать нечего.
    check("последовательность: прятать нечего",
          _sequence_for(BEFORE, "x", "sb"), None)


def test_locate() -> None:
    # Пример использует не тот вариант, что стоит в словаре первым.
    example = "The study demonstrated the need for better mental health services."
    located = _locate(example, "need", BEFORE, ["demonstrate", "prove", "show"])
    check_true("поиск в примере: найдено", located is not None)
    check("поиск в примере: вырезан партнёр",
          example[located[0]:located[1]], "demonstrated")

    # Плейсхолдер находится, но в пропуск уходит только то, что после него.
    example = "When he's reading comics, my brother disappears into his own little world."
    located = _locate(example, "world", BEFORE, ["sb's own little"])
    check_true("поиск в примере: плейсхолдер найден", located is not None)
    check("поиск в примере: прячется только собственно партнёр",
          example[located[0]:located[1]], "own little")

    # Дополнение, пойманное плейсхолдером, остаётся в предложении.
    example = "I heard my neighbor play the violin beautifully last night."
    located = _locate(example, "play", BEFORE, ["hear sb"])
    check_true("поиск в примере: запись с sb найдена", located is not None)
    check("поиск в примере: дополнение не уезжает в пропуск",
          example[located[0]:located[1]], "heard")

    # Дефис вместо пробела.
    example = "The movie was based on real-life events that happened here."
    located = _locate(example, "life", BEFORE, ["real"])
    check_true("поиск в примере: дефис", located is not None)
    check("поиск в примере: дефис, границы", example[located[0]:located[1]], "real")

    # Партнёра в примере нет — пропуска быть не должно.
    example = "My family enjoys playing board games on rainy days."
    check("поиск в примере: несовпадение",
          _locate(example, "game", BEFORE, ["indoor", "outdoor"]), None)


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
