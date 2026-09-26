"""Проверки отбраковки и сборки карточек.

Запуск: `python -m pipeline.deck.selftest`
"""

from __future__ import annotations

import sys

from . import quality
from .build import content_version

_failures: list[str] = []


def check(name: str, actual, expected) -> None:
    if actual != expected:
        _failures.append(f"{name}\n    получено: {actual!r}\n    ожидалось: {expected!r}")


def check_true(name: str, value) -> None:
    if not value:
        _failures.append(f"{name}\n    получено: {value!r}, ожидалось истинное")


def test_hint() -> None:
    check("подсказка: одно слово", quality.make_hint("tough"), "t____")
    check("подсказка: несколько слов",
          quality.make_hint("go out of your way"), "g_ o__ o_ y___ w__")
    # Апостроф не показывается: подсказка — это первая буква и число букв,
    # а знак препинания внутри слова выдал бы лишнее.
    check("подсказка: апостроф не показывается",
          quality.make_hint("don't"), "d___")


def _assess(example: str, answer: str, rivals: int = 0) -> quality.Quality:
    start = example.index(answer)
    return quality.assess(example, start, start + len(answer), rivals)


def test_fatal_flags() -> None:
    # Пропуск в начале: ответ с заглавной буквы и без левого контекста.
    verdict = _assess("One day I realized that my dog had changed my life.", "One")
    check("отбраковка: пропуск в начале", (verdict.usable, verdict.reason),
          (False, "gap_at_start"))

    # Ответ можно списать из того же предложения.
    verdict = _assess(
        "She made a decision after the committee decision was announced.", "made")
    check("отбраковка: короткое предложение проходит, длинное нет",
          verdict.usable, True)
    verdict = _assess(
        "The study demonstrated what other studies had demonstrated before.",
        "demonstrated")
    check("отбраковка: ответ повторён", (verdict.usable, verdict.reason),
          (False, "answer_repeated"))

    # Пропуск длиннее трёх слов и больше трети предложения.
    verdict = _assess("She worked at the end of the day to finish.", "at the end of the day")
    check("отбраковка: пропуск слишком велик", (verdict.usable, verdict.reason),
          (False, "gap_too_large"))

    # Слишком короткое предложение.
    verdict = _assess("He made a decision.", "made")
    check("отбраковка: предложение короче шести слов",
          (verdict.usable, verdict.reason), (False, "sentence_too_short"))


def test_soft_flags() -> None:
    verdict = _assess(
        "My teacher Sarah went out of her way to help the whole class today.", "went")
    check_true("пометка: имя собственное", "proper_noun" in verdict.flags)
    check_true("пометка: карточка остаётся годной", verdict.usable)

    # Заглавное слово в начале именем собственным не считается.
    verdict = _assess("Tomato soup comes in a can if you have no time.", "comes in")
    check("пометка: первое слово не имя собственное",
          "proper_noun" in verdict.flags, False)


def test_ambiguity() -> None:
    example = "She had to make a tough decision about the job offer yesterday."
    check("неоднозначность: конкурентов нет",
          _assess(example, "tough", rivals=0).ambiguity, "low")
    check("неоднозначность: один-два конкурента",
          _assess(example, "tough", rivals=2).ambiguity, "medium")
    verdict = _assess(example, "tough", rivals=3)
    check("неоднозначность: трое и больше", verdict.ambiguity, "high")
    check_true("неоднозначность: помечена флагом", "ambiguous" in verdict.flags)
    check_true("неоднозначность: сама по себе не отбраковывает", verdict.usable)


def test_rivals() -> None:
    rows = [
        ("c_1", "decision", "adj+noun", None, ["tough", "difficult", "hard"]),
        ("c_2", "decision", "adj+noun", None, ["important", "big"]),
        ("c_3", "decision", "adj+noun", None, ["tricky"]),
        ("c_4", "decision", "verb+obj", None, ["take"]),
        ("c_5", "time", "adj+noun", None, ["tough"]),
    ]
    index = quality.rival_index(rows)
    key = ("decision", "adj+noun", None)
    own = {"tough", "difficult", "hard"}

    # Конкуренты на `t` — только `tricky`: `take` в другом отношении,
    # `tough` из статьи `time` относится к другому слову, свои не в счёт.
    check("конкуренты: та же буква, то же отношение",
          quality.count_rivals(index, "c_1", key, own, "tough"), 1)
    # На `d` конкурентов нет вовсе.
    check("конкуренты: другая буква",
          quality.count_rivals(index, "c_1", key, own, "difficult"), 0)


def test_version_hash() -> None:
    cards = [{"id": "c_1", "text": "a ___ b", "answer": "x"}]
    same = [{"id": "c_1", "text": "a ___ b", "answer": "x"}]
    other = [{"id": "c_1", "text": "a ___ b", "answer": "y"}]
    check("версия: одинаковое содержимое — одинаковый хэш",
          content_version(cards), content_version(same))
    check_true("версия: изменение ответа меняет хэш",
               content_version(cards) != content_version(other))


def test_sentence_fixes() -> None:
    """Правка предложения пересчитывает всё, что зависело от старого ответа.

    Обе проверки ниже — следы настоящих ошибок. Правка `have` → `had`
    оставила подсказку `h___` на четыре буквы при трёх; правка `thinks` → `has`
    предложила бы в «так же подошло бы» слово `have`, то есть то же самое.
    """
    from .build import other_cluster_members
    from ..sentences.store import load_all as _unused  # noqa: F401  импорт проверяет модуль

    check("правка: подсказка от нового ответа", quality.make_hint("had"), "h__")
    check("правка: подсказка многословного ответа",
          quality.make_hint("goes on to"), "g___ o_ t_")

    check("правка: also опознаёт форму have в has",
          other_cluster_members(["have", "think"], None, "has"), ["think"])
    check("правка: also опознаёт форму think в thinks",
          other_cluster_members(["have", "think"], None, "thinks"), ["have"])
    check("правка: одиночный кластер даёт пустой also",
          other_cluster_members(["have"], None, "had"), [])


def test_fix_store_rejects_bad_gaps() -> None:
    """Правка с числом пропусков не равным одному не применяется.

    Без пропуска карточка показала бы готовый ответ, с двумя — приложение
    разбирает текст на «до» и «после» и молча теряет хвост.
    """
    import tempfile
    from pathlib import Path
    from ..sentences import store as fixes

    original_path = fixes.TSV_PATH
    with tempfile.TemporaryDirectory() as tmp:
        fixes.TSV_PATH = Path(tmp) / "fixes.tsv"
        fixes.SENTENCES_DIR = Path(tmp)
        try:
            rows = [
                fixes.HEADER,
                "\t".join(["k1", "src", "no gap here", "x"]),
                "\t".join(["k2", "src", "two ___ gaps ___ here", "x"]),
                "\t".join(["k3", "src", "one ___ gap", "x"]),
            ]
            fixes.TSV_PATH.write_text("\n".join(rows) + "\n", encoding="utf-8")
            loaded = fixes.load_all()
            check("правка: без пропуска отброшена", "k1" in loaded, False)
            check("правка: с двумя пропусками отброшена", "k2" in loaded, False)
            check("правка: с одним пропуском принята", "k3" in loaded, True)

            raised = False
            try:
                fixes.save("x", "a ___ b ___ c", "y")
            except ValueError:
                raised = True
            check("правка: save не пишет два пропуска", raised, True)
        finally:
            fixes.TSV_PATH = original_path
            fixes.SENTENCES_DIR = original_path.parent


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
