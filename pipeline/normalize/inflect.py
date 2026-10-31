"""Поиск коллокации в предложении с учётом словоформ.

Для карточки-пропуска мало знать, что пример «подходит» — нужны точные границы
партнёра в предложении, чтобы вырезать пропуск. Пример при этом почти всегда
содержит не словарную форму: `get better` → «My English has **gotten** better».

Полноценная лемматизация здесь избыточна: нам нужно не разобрать текст, а
проверить конкретное слово. Поэтому вместо spaCy — порождение всех правдоподобных
форм слова и поиск по ним. Перегенерация форм безвредна: мы ищем их в тексте,
а не предлагаем пользователю.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from .limits import (MAX_EXAMPLE_CHARS, MAX_EXPRESSION_CHARS, MAX_PHRASE_TOKENS,
                     MAX_TOKEN_CHARS, SearchBudget, require_budget)

# Неправильные глаголы: база → прочие формы.
_IRREGULAR_VERBS = {
    "be": "am is are was were been being",
    "bear": "bore borne bearing",
    "beat": "beat beaten beating",
    "become": "became become becoming",
    "begin": "began begun beginning",
    "bend": "bent bending",
    "bet": "bet betting",
    "bind": "bound binding",
    "bite": "bit bitten biting",
    "bleed": "bled bleeding",
    "blow": "blew blown blowing",
    "break": "broke broken breaking",
    "bring": "brought bringing",
    "build": "built building",
    "burn": "burnt burned burning",
    "burst": "burst bursting",
    "buy": "bought buying",
    "catch": "caught catching",
    "choose": "chose chosen choosing",
    "come": "came come coming",
    "cost": "cost costing",
    "cut": "cut cutting",
    "deal": "dealt dealing",
    "dig": "dug digging",
    "do": "does did done doing",
    "draw": "drew drawn drawing",
    "dream": "dreamt dreamed dreaming",
    "drink": "drank drunk drinking",
    "drive": "drove driven driving",
    "eat": "ate eaten eating",
    "fall": "fell fallen falling",
    "feed": "fed feeding",
    "feel": "felt feeling",
    "fight": "fought fighting",
    "find": "found finding",
    "fly": "flew flown flying",
    "forget": "forgot forgotten forgetting",
    "forgive": "forgave forgiven forgiving",
    "freeze": "froze frozen freezing",
    "get": "got gotten getting",
    "give": "gave given giving",
    "go": "goes went gone going",
    "grow": "grew grown growing",
    "hang": "hung hanged hanging",
    "have": "has had having",
    "hear": "heard hearing",
    "hide": "hid hidden hiding",
    "hit": "hit hitting",
    "hold": "held holding",
    "hurt": "hurt hurting",
    "keep": "kept keeping",
    "know": "knew known knowing",
    "lay": "laid laying",
    "lead": "led leading",
    "learn": "learnt learned learning",
    "leave": "left leaving",
    "lend": "lent lending",
    "let": "let letting",
    "lie": "lay lain lying",
    "lose": "lost losing",
    "make": "made making",
    "mean": "meant meaning",
    "meet": "met meeting",
    "pay": "paid paying",
    "put": "put putting",
    "read": "read reading",
    "ride": "rode ridden riding",
    "ring": "rang rung ringing",
    "rise": "rose risen rising",
    "run": "ran run running",
    "say": "said saying",
    "see": "saw seen seeing",
    "seek": "sought seeking",
    "sell": "sold selling",
    "send": "sent sending",
    "set": "set setting",
    "shake": "shook shaken shaking",
    "shine": "shone shined shining",
    "shoot": "shot shooting",
    "show": "showed shown showing",
    "shut": "shut shutting",
    "sing": "sang sung singing",
    "sink": "sank sunk sinking",
    "sit": "sat sitting",
    "sleep": "slept sleeping",
    "speak": "spoke spoken speaking",
    "spend": "spent spending",
    "spread": "spread spreading",
    "stand": "stood standing",
    "steal": "stole stolen stealing",
    "stick": "stuck sticking",
    "strike": "struck striking",
    "swim": "swam swum swimming",
    "take": "took taken taking",
    "teach": "taught teaching",
    "tear": "tore torn tearing",
    "tell": "told telling",
    "think": "thought thinking",
    "throw": "threw thrown throwing",
    "understand": "understood understanding",
    "wake": "woke woken waking",
    "wear": "wore worn wearing",
    "win": "won winning",
    "write": "wrote written writing",
}

# Неправильные существительные и степени сравнения.
_IRREGULAR_OTHER = {
    "child": "children",
    "foot": "feet",
    "goose": "geese",
    "good": "better best",
    "bad": "worse worst",
    "far": "further furthest farther farthest",
    "little": "less least",
    "man": "men",
    "many": "more most",
    "mouse": "mice",
    "much": "more most",
    "person": "people persons",
    "tooth": "teeth",
    "woman": "women",
    "life": "lives",
    "knife": "knives",
    "wife": "wives",
    "leaf": "leaves",
    "half": "halves",
    "shelf": "shelves",
    "thief": "thieves",
    "analysis": "analyses",
    "basis": "bases",
    "crisis": "crises",
    "criterion": "criteria",
    "phenomenon": "phenomena",
}

_VOWELS = set("aeiou")
_SIBILANT_ENDINGS = ("s", "x", "z", "ch", "sh")
# Служебные слова, которые примеры вставляют между частями коллокации.
_FILLERS = (
    "a|an|the|this|that|these|those|his|her|their|my|your|our|its|"
    "one's|some|any|no|such"
)
_WORD_CHARS = r"[A-Za-z][A-Za-z'’-]*"
# Именная группа на месте sb/sth — не более двух слов, иначе плейсхолдер
# «съедает» полпредложения вместе с глаголом.
_NOUN_PHRASE = rf"{_WORD_CHARS}(?:\s+{_WORD_CHARS})?"
# Притяжательная форма: sb's → «his», «my sister's».
_POSSESSIVE = rf"(?:his|her|their|my|your|our|its|{_WORD_CHARS}'s|{_WORD_CHARS}’s)"

_PLACEHOLDER_PATTERNS = {
    "sb": _NOUN_PHRASE,
    "sth": _NOUN_PHRASE,
    "somebody": _NOUN_PHRASE,
    "something": _NOUN_PHRASE,
    "oneself": _NOUN_PHRASE,
    "sb's": _POSSESSIVE,
    "sth's": _POSSESSIVE,
}


def _regular_forms(word: str) -> set[str]:
    """Правильные формы: -s/-es/-ed/-ing/-er/-est с обычными чередованиями."""
    out = {word}
    if not word.isalpha():
        return out

    out.add(word + "s")
    if word.endswith(_SIBILANT_ENDINGS):
        out.add(word + "es")

    if len(word) > 2 and word.endswith("y") and word[-2] not in _VOWELS:
        stem = word[:-1]
        out |= {stem + "ies", stem + "ied", stem + "ier", stem + "iest"}
        out.add(word + "ing")
    elif word.endswith("e"):
        stem = word[:-1]
        out |= {stem + "ing", word + "d", word + "r", word + "st"}
    else:
        out |= {word + "ed", word + "ing", word + "er", word + "est"}

    # Удвоение согласной: stop → stopped/stopping.
    if (
        len(word) >= 3
        and word[-1] not in _VOWELS
        and word[-1] not in "wxy"
        and word[-2] in _VOWELS
        and word[-3] not in _VOWELS
    ):
        doubled = word + word[-1]
        out |= {doubled + "ed", doubled + "ing", doubled + "er", doubled + "est"}
    return out


def forms(word: str) -> set[str]:
    """Все правдоподобные словоформы."""
    require_budget(len(word), MAX_TOKEN_CHARS, "длина токена")
    base = word.lower().strip()
    if not base:
        return set()
    out = _regular_forms(base)
    for table in (_IRREGULAR_VERBS, _IRREGULAR_OTHER):
        if base in table:
            out |= set(table[base].split())
    return out


def _token_regex(token: str) -> str:
    clean = token.lower().strip(",.;:!?\"")
    if clean in _PLACEHOLDER_PATTERNS:
        return _PLACEHOLDER_PATTERNS[clean]
    alternatives = sorted(forms(clean), key=len, reverse=True)
    if not alternatives:
        return re.escape(clean)
    return "(?:" + "|".join(re.escape(form) for form in alternatives) + ")"


@dataclass(frozen=True)
class PhraseMatch:
    bounds: tuple[int, int]
    capture: tuple[int, int]

    def span(self, group: int = 0) -> tuple[int, int]:
        if group not in (0, 1):
            raise IndexError(group)
        return self.capture if group else self.bounds

    def start(self) -> int:
        return self.bounds[0]

    def end(self) -> int:
        return self.bounds[1]


_SEPARATOR = re.compile(r"[\s-]+")
_FILLER_SEPARATOR = re.compile(rf"(?:{_FILLERS})\b[\s-]+", re.IGNORECASE)
_BOUNDARY = re.compile(r"\b")
_WORD = re.compile(_WORD_CHARS, re.IGNORECASE)


class PhrasePattern:
    """Поиск по состояниям (номер токена, позиция), без перебора всех путей.

    Локальные регулярки распознают один токен/плейсхолдер. Неоднозначные
    разделения фразы мемоизируются, в том числе неудачные; бюджет общий для
    всех начальных позиций одного поиска.
    """

    def __init__(self, tokens: list[str], gap: tuple[int, int]):
        require_budget(len(tokens), MAX_PHRASE_TOKENS, "токены фразы")
        self.gap = gap
        self.parts = []
        self.noun_parts = []
        for token in tokens:
            require_budget(len(token), MAX_TOKEN_CHARS, "длина токена")
            clean = token.lower().strip(",.;:!?\"")
            noun = clean in ("sb", "sth", "somebody", "something", "oneself")
            self.noun_parts.append(noun)
            if noun:
                # Сначала два слова, как в прежнем жадном поиске, затем одно.
                choices = [rf"{_WORD_CHARS}\s+{_WORD_CHARS}", _WORD_CHARS]
            else:
                choices = [_token_regex(token)]
            self.parts.append([re.compile(rf"(?:{choice})", re.IGNORECASE)
                               for choice in choices])

    def _find(self, text: str, full: bool, budget: SearchBudget | None) -> PhraseMatch | None:
        require_budget(len(text), MAX_EXAMPLE_CHARS, "длина примера")
        budget = budget if budget is not None else SearchBudget()
        budget.scan(len(text))
        for word in _WORD.finditer(text):
            require_budget(len(word[0]), MAX_TOKEN_CHARS, "длина слова в примере")

        @lru_cache(maxsize=None)
        def suffix(index: int, position: int):
            budget.advance()
            for pattern in self.parts[index]:
                matched = pattern.match(text, position)
                if matched is None:
                    continue
                ends = [matched.end()]
                if self.noun_parts[index]:
                    # Дефис может быть частью имени или разделителем фразы.
                    ends.extend(end for end in range(matched.end() - 1, position, -1)
                                if text[end] == "-" and _BOUNDARY.match(text, end))
                for end in ends:
                    if index == len(self.parts) - 1:
                        if _BOUNDARY.match(text, end) and (not full or end == len(text)):
                            return ((position, end),)
                        continue
                    separator = _SEPARATOR.match(text, end)
                    if separator is None:
                        continue
                    after = separator.end()
                    filler = _FILLER_SEPARATOR.match(text, after)
                    next_positions = [filler.end(), after] if filler else [after]
                    for following in next_positions:
                        # Даже попадание в кэш требует работы: повторные
                        # переходы тоже расходуют общий бюджет.
                        budget.advance()
                        rest = suffix(index + 1, following)
                        if rest is not None:
                            return ((position, end),) + rest
            return None

        try:
            starts = [0] if full else (match.start() for match in _BOUNDARY.finditer(text))
            for start in starts:
                if not _BOUNDARY.match(text, start):
                    continue
                spans = suffix(0, start)
                if spans is not None:
                    return PhraseMatch((start, spans[-1][1]),
                                       (spans[self.gap[0]][0], spans[self.gap[1] - 1][1]))
            return None
        finally:
            # Не оставляем текст и таблицу состояний в цикле замыканий до GC.
            suffix.cache_clear()

    def search(self, text: str, *, budget: SearchBudget | None = None) -> PhraseMatch | None:
        return self._find(text, False, budget)

    def fullmatch(self, text: str, *, budget: SearchBudget | None = None) -> PhraseMatch | None:
        return self._find(text, True, budget)


def phrase_regex(phrase: str) -> PhrasePattern | None:
    """Совместимый поисковый интерфейс; фраза больше не является общей регуляркой."""
    require_budget(len(phrase), MAX_EXPRESSION_CHARS, "длина фразы")
    tokens = [t for t in phrase.split() if t and t != "~"]
    if not tokens:
        return None
    return PhrasePattern(tokens, (0, len(tokens)))


def sequence_regex(tokens: list[str], gap: tuple[int, int]) -> PhrasePattern | None:
    """Поиск последовательности токенов; span(1) — границы пропуска.

    Ищем коллокацию целиком, а не партнёра отдельно: иначе в предложении
    «My sister is best at cooking» предлог `at` из пары `at best` найдётся
    в любом другом месте текста.
    """
    if not tokens or not (0 <= gap[0] < gap[1] <= len(tokens)):
        return None
    return PhrasePattern(tokens, gap)


def find_span(text: str, phrase: str) -> tuple[int, int] | None:
    """Границы первого вхождения фразы в текст с учётом словоформ."""
    pattern = phrase_regex(phrase)
    if pattern is None or not text:
        return None
    match = pattern.search(text)
    return (match.start(), match.end()) if match else None


def token_distance(text: str, first: tuple[int, int], second: tuple[int, int]) -> int:
    """Сколько слов между двумя вхождениями — мера «рядом ли они»."""
    left, right = sorted((first, second))
    if right[0] <= left[1]:
        return 0
    return len(text[left[1] : right[0]].split())
