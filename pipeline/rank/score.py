"""Порядок изучения коллокаций.

Чему учить раньше — вопрос не сложности материала, а его окупаемости. Партнёры
частотного слова пригодятся сразу, партнёры редкого — когда-нибудь. Поэтому
порядок строится на частотности, которая у нас измерима, а не на «уровне»,
который пришлось бы выдумывать (см. `cefr.py`).

Единица частотности — zipf из библиотеки wordfreq: логарифмическая шкала,
где 7 — служебные слова вроде `the`, 5 — обиходные (`work`, `money`),
3 — редкие, 1 — почти не встречающиеся.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..normalize.variants import PLACEHOLDERS

# Вес заголовочного слова выше: сначала набираем партнёров к словам,
# которые встретятся в речи чаще всего.
WEIGHT_HEADWORD = 2.0
WEIGHT_COLLOCATE = 1.0

# Потолок частотности партнёра. Без него верх очереди занимают предлоги:
# у них zipf 6.5–7 против 4–6 у знаменательных слов, и они механически
# обходят всё остальное. Но `cans of soup` не несёт никакой учебной ценности
# сверх того, что даёт слово `can`, — высокая частотность `of` сама по себе
# ничего не говорит о полезности пары.
COLLOCATE_ZIPF_CAP = 5.5

# Учебная ценность по типу отношения. Подобрать глагол к существительному
# («принять решение») — тот самый навык, ради которого всё затевалось;
# зависимый предлог полезен, но это скорее грамматика, чем коллокация.
RELATION_BONUS = {
    "verb+obj": 1.0,
    "adj+noun": 0.8,
    "phrase": 0.8,
    "verb+adj": 0.6,
    "adv+verb": 0.6,
    "adv+adj": 0.6,
    "noun+verb": 0.4,
    "noun+noun": 0.4,
    "prep": -1.0,
    "quant+noun": -0.5,
    "adv+other": -0.5,
}
# Запись, из которой уже получается карточка-пропуск, полезнее той,
# что ждёт примера.
BONUS_READY = 1.5
# Неоднозначная запись (слэш в многословном партнёре) требует проверки.
PENALTY_REVIEW = 1.0

# Границы полос сложности по редчайшей части коллокации.
BANDS = (
    ("core", 5.0),      # обиходная лексика
    ("common", 4.0),
    ("extended", 3.0),
    ("rare", float("-inf")),
)


@dataclass
class Score:
    head_zipf: float
    collocate_zipf: float
    band: str
    value: float


def _clean_tokens(text: str) -> list[str]:
    """Убирает тильду и плейсхолдеры: они не слова и частотности не имеют."""
    tokens = []
    for token in str(text or "").split():
        clean = token.strip(",.;:!?\"'()").lower()
        if not clean or clean == "~" or clean in PLACEHOLDERS:
            continue
        tokens.append(clean)
    return tokens


def phrase_zipf(text: str, zipf) -> float:
    """Частотность записи партнёра.

    Для многословных берём минимум по словам: трудность выражения задаёт
    самая редкая его часть.
    """
    tokens = _clean_tokens(text)
    if not tokens:
        return 0.0
    return min(zipf(token, "en") for token in tokens)


def band_for(value: float) -> str:
    for name, threshold in BANDS:
        if value >= threshold:
            return name
    return BANDS[-1][0]


def compute(headword: str, collocate: str, has_gap: bool, needs_review: bool,
            zipf, relation: str = "") -> Score:
    head_zipf = phrase_zipf(headword, zipf)
    collocate_zipf = phrase_zipf(collocate, zipf)

    value = (
        WEIGHT_HEADWORD * head_zipf
        + WEIGHT_COLLOCATE * min(collocate_zipf, COLLOCATE_ZIPF_CAP)
        + RELATION_BONUS.get(relation, 0.0)
    )
    if has_gap:
        value += BONUS_READY
    if needs_review:
        value -= PENALTY_REVIEW

    return Score(
        head_zipf=round(head_zipf, 3),
        collocate_zipf=round(collocate_zipf, 3),
        band=band_for(min(head_zipf, collocate_zipf)),
        value=round(value, 3),
    )
