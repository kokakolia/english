"""Разбор грамматических паттернов словаря.

В статьях коллокации сгруппированы по меткам вида `ADJ`, `VERB + DECISION`,
`DECISION + NOUN`, `PREP`. Здесь метка превращается в пару
(тип отношения, где стоит партнёр), от которой дальше зависит и сборка фразы,
и тип карточки.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Где относительно заголовочного слова стоит партнёр.
BEFORE = "before"      # make | decision
AFTER = "after"        # decision | maker
TEMPLATE = "template"  # партнёр содержит ~ на месте заголовочного слова
PHRASE = "phrase"      # устойчивое выражение целиком

_GLOSS_RE = re.compile(r"^\(([^)]*)\)\s*(.*)$")

# Метки частей речи, которые в `cat` стоят на месте партнёра.
_POS_LABELS = {
    "ADJ", "ADJS", "ADJECTIVE", "ADV", "ADVS", "ADVERB", "NOUN", "NOUNS",
    "VERB", "VERBS", "PREP", "PREPS", "PREPOSITION", "QUANT", "QUANTIFIER",
    "PHRASE", "PHRASES", "IDIOM", "IDIOMS", "PRON", "DET",
}


@dataclass(frozen=True)
class Pattern:
    relation: str      # adj+noun, verb+obj, noun+verb, ...
    position: str      # BEFORE / AFTER / TEMPLATE / PHRASE
    cat_raw: str


def parse_gloss(gloss: str | None) -> tuple[str | None, str | None]:
    """`(adj.) recently built/made` → ('adj', 'recently built/made')."""
    if not gloss:
        return None, None
    match = _GLOSS_RE.match(gloss.strip())
    if not match:
        return None, gloss.strip() or None
    pos_part, sense = match.group(1), match.group(2).strip()
    # Первая часть речи из списка вида "adj., pron."
    pos = pos_part.split(",")[0].strip().rstrip(".").lower() or None
    return pos, sense or None


def _relation_for_label(label: str, head_pos: str | None) -> str:
    """Тип отношения по метке партнёра и части речи заголовочного слова."""
    label = label.rstrip(".").upper()
    head = (head_pos or "").lower()

    if label in ("ADJ", "ADJS", "ADJECTIVE"):
        return "adj+noun"
    if label in ("QUANT", "QUANTIFIER", "DET"):
        return "quant+noun"
    if label in ("VERB", "VERBS"):
        # Для прилагательных и наречий это связочные глаголы (be/feel/seem good),
        # для существительных — глаголы, берущие слово дополнением.
        if head in ("adj", "adjective"):
            return "verb+adj"
        if head in ("adv", "adverb"):
            return "verb+adv"
        return "verb+obj"
    if label in ("ADV", "ADVS", "ADVERB"):
        if head in ("adj", "adjective"):
            return "adv+adj"
        if head in ("verb",):
            return "adv+verb"
        return "adv+other"
    if label in ("NOUN", "NOUNS"):
        return "noun+noun"
    if label in ("PREP", "PREPS", "PREPOSITION"):
        return "prep"
    if label in ("PHRASE", "PHRASES", "IDIOM", "IDIOMS"):
        return "phrase"
    return "other"


def parse_cat(cat: str | None, headword: str, head_pos: str | None) -> Pattern:
    """Метку группы → в структурированный паттерн."""
    raw = (cat or "").strip()
    if not raw:
        return Pattern("other", BEFORE, raw)

    if "+" in raw:
        left, _, right = raw.partition("+")
        left, right = left.strip(), right.strip()
        left_is_label = left.rstrip(".").upper() in _POS_LABELS
        right_is_label = right.rstrip(".").upper() in _POS_LABELS

        # Ровно одна сторона — метка части речи; вторая повторяет заголовочное
        # слово. Метка и указывает, где стоит партнёр.
        if left_is_label and not right_is_label:
            relation = _relation_for_label(left, head_pos)
            return Pattern(relation, BEFORE, raw)
        if right_is_label and not left_is_label:
            relation = _relation_for_label(right, head_pos)
            if relation == "verb+obj":
                relation = "noun+verb"  # слово — подлежащее: decision + comes
            return Pattern(relation, AFTER, raw)
        return Pattern("other", BEFORE, raw)

    label = raw.rstrip(".").upper()
    relation = _relation_for_label(label, head_pos)
    if relation == "prep":
        return Pattern(relation, TEMPLATE, raw)
    if relation == "phrase":
        return Pattern(relation, PHRASE, raw)
    if relation == "other":
        return Pattern(relation, BEFORE, raw)
    return Pattern(relation, BEFORE, raw)


def build_phrase(pattern: Pattern, headword: str, collocate: str) -> str:
    """Подпись коллокации.

    Это именно подпись, а не учебный материал: артикли здесь не расставляются,
    «правильная» английская фраза берётся из примера-предложения.
    """
    collocate = collocate.strip()
    if "~" in collocate:
        return re.sub(r"\s+", " ", collocate.replace("~", headword)).strip()
    if pattern.position == PHRASE:
        return collocate
    if pattern.position == AFTER:
        return f"{headword} {collocate}"
    return f"{collocate} {headword}"
