"""Проверка порядка изучения на независимом сигнале.

Веса в `score.py` подобраны рассуждением, а не выведены из данных: разметки
вида «коллокацию A правильно учить раньше B» не существует. Но у нас есть 579
настоящих CEFR-меток, которые в формулу не входят, — на них можно проверить,
раскладывает ли порядок материал от простого к сложному.

Это проверка, а не подгонка: как только веса начнут подбираться под эти метки,
независимого сигнала не останется. Поэтому результат здесь — показание прибора,
а не цель оптимизации.

    python -m pipeline.rank.validate
"""

from __future__ import annotations

import statistics
import sys
from typing import Callable

from ..normalize import store
from . import score as scoring
from .cefr import LEVELS

_LEVEL_ORDER = {level: index for index, level in enumerate(LEVELS)}

# Лёгкими считаем A1–A2, трудными B2 и выше; B1 — середина, в сравнении
# пар не участвует.
EASY_MAX = 1
HARD_MIN = 3


def _ranks(values: list[float]) -> list[float]:
    """Ранги, одинаковым значениям — средний ранг."""
    order = sorted(range(len(values)), key=lambda index: values[index])
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and values[order[end + 1]] == values[order[start]]:
            end += 1
        average = (start + end) / 2 + 1
        for position in range(start, end + 1):
            result[order[position]] = average
        start = end + 1
    return result


def _pearson(xs: list[float], ys: list[float]) -> float:
    mean_x, mean_y = statistics.fmean(xs), statistics.fmean(ys)
    numerator = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    dev_x = sum((x - mean_x) ** 2 for x in xs) ** 0.5
    dev_y = sum((y - mean_y) ** 2 for y in ys) ** 0.5
    return numerator / (dev_x * dev_y) if dev_x and dev_y else 0.0


def spearman(xs: list[float], ys: list[float]) -> float:
    return _pearson(_ranks(xs), _ranks(ys))


def auc(values: list[float], levels: list[int]) -> tuple[float, int, int]:
    """Доля пар «лёгкая, трудная», где лёгкая получила оценку выше.

    0.5 — формула не отличает одно от другого, 1.0 — отличает безошибочно,
    ниже 0.5 — систематически путает.
    """
    easy = [value for value, level in zip(values, levels) if level <= EASY_MAX]
    hard = [value for value, level in zip(values, levels) if level >= HARD_MIN]
    if not easy or not hard:
        return 0.0, len(easy), len(hard)
    wins = sum(
        1.0 if e > h else 0.5 if e == h else 0.0 for e in easy for h in hard
    )
    return wins / (len(easy) * len(hard)), len(easy), len(hard)


def _variants(zipf) -> list[tuple[str, Callable[[str, str, str], float]]]:
    """Варианты формулы — от простейшего к нынешнему.

    Сравнение показывает, какая поправка действительно работает, а какая
    только усложняет формулу.
    """
    def head_only(headword, collocate, relation):
        return scoring.WEIGHT_HEADWORD * scoring.phrase_zipf(headword, zipf)

    def collocate_only(headword, collocate, relation):
        return scoring.phrase_zipf(collocate, zipf)

    def plain_sum(headword, collocate, relation):
        return head_only(headword, collocate, relation) + collocate_only(
            headword, collocate, relation
        )

    def with_cap(headword, collocate, relation):
        return head_only(headword, collocate, relation) + min(
            scoring.phrase_zipf(collocate, zipf), scoring.COLLOCATE_ZIPF_CAP
        )

    def current(headword, collocate, relation):
        return with_cap(headword, collocate, relation) + scoring.RELATION_BONUS.get(
            relation, 0.0
        )

    return [
        ("только частотность заголовка", head_only),
        ("только частотность партнёра", collocate_only),
        ("сумма без поправок", plain_sum),
        ("+ потолок партнёра", with_cap),
        ("+ вес отношения (текущая)", current),
    ]


def main() -> int:
    try:
        from wordfreq import zipf_frequency
    except ImportError:
        print("нужен wordfreq: pip install -r pipeline/requirements.txt", file=sys.stderr)
        return 1

    conn = store.connect()
    try:
        rows = conn.execute(
            "SELECT c.headword, c.collocate, c.relation, r.cefr, r.position "
            "FROM collocations c JOIN ranking r ON r.id = c.id "
            "WHERE r.cefr IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        print("нет размеченных записей — сначала `pipeline.rank.build run`", file=sys.stderr)
        return 1

    levels = [_LEVEL_ORDER[row[3]] for row in rows]
    positions = [float(row[4]) for row in rows]

    print(f"размеченных коллокаций: {len(rows)}")
    print("по уровням: " + ", ".join(
        f"{level} {levels.count(_LEVEL_ORDER[level])}"
        for level in LEVELS if levels.count(_LEVEL_ORDER[level])
    ))

    print(f"\n{'вариант формулы':<32}{'Spearman':>10}{'AUC':>8}")
    print("-" * 50)
    easy_count = hard_count = 0
    for name, formula in _variants(zipf_frequency):
        values = [formula(row[0], row[1], row[2]) for row in rows]
        score_auc, easy_count, hard_count = auc(values, levels)
        print(f"{name:<32}{spearman(values, [float(l) for l in levels]):>10.3f}"
              f"{score_auc:>8.3f}")
    print(f"\nлёгких (A1–A2): {easy_count}, трудных (B2+): {hard_count}")
    print("Spearman отрицательный — выше оценка, ниже уровень: так и должно быть.")

    position_auc, _, _ = auc([-position for position in positions], levels)
    print(f"\nитоговая очередь (после чередования): "
          f"Spearman {spearman(positions, [float(l) for l in levels]):+.3f}, "
          f"AUC {position_auc:.3f}")

    print("\nмедианная позиция в очереди по уровням:")
    for level in LEVELS:
        subset = [
            position
            for position, value in zip(positions, levels)
            if value == _LEVEL_ORDER[level]
        ]
        if subset:
            print(f"  {level}: {statistics.median(subset):>7.0f}   (n={len(subset)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
