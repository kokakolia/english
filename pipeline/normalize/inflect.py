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
# Между частями коллокации допускаем пробел или дефис: `real life` в примере
# нередко пишется как `real-life`.
_JOINER = rf"[\s-]+(?:(?:{_FILLERS})[\s-]+)?"

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


def phrase_regex(phrase: str) -> re.Pattern[str] | None:
    """Регулярка для многословного партнёра, допускающая артикли внутри."""
    tokens = [t for t in phrase.split() if t and t != "~"]
    if not tokens:
        return None
    body = _JOINER.join(_token_regex(token) for token in tokens)
    try:
        return re.compile(rf"\b{body}\b", re.IGNORECASE)
    except re.error:
        return None


def sequence_regex(tokens: list[str], gap: tuple[int, int]) -> re.Pattern[str] | None:
    """Регулярка для последовательности токенов; группа 1 — место пропуска.

    Ищем коллокацию целиком, а не партнёра отдельно: иначе в предложении
    «My sister is best at cooking» предлог `at` из пары `at best` найдётся
    в любом другом месте текста.
    """
    if not tokens or not (0 <= gap[0] < gap[1] <= len(tokens)):
        return None
    joiner = _JOINER
    parts = [_token_regex(token) for token in tokens]

    head = joiner.join(parts[: gap[0]])
    middle = joiner.join(parts[gap[0] : gap[1]])
    tail = joiner.join(parts[gap[1] :])

    body = f"({middle})"
    if head:
        body = head + joiner + body
    if tail:
        body = body + joiner + tail
    try:
        return re.compile(rf"\b{body}\b", re.IGNORECASE)
    except re.error:
        return None


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
