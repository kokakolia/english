"""Привязка CEFR-уровней к коллокациям.

Уровни берутся только настоящие — из тренировочных вопросов, приложенных к
статьям (`study-bank`). Там у каждого вопроса стоит `cefr_level`, а в
`supported_by.collocations` партнёр назван ровно так же, как в словарной статье,
что и позволяет их связать.

Выводить уровень из частотности мы намеренно не пытаемся. Замер по 1357
размеченным вопросам: медианный zipf правильного ответа A1 5.71, A2 5.28,
B1 5.16, B2 5.26, C1 4.52. Между A2 и B2 частотность не различает уровни вовсе,
так что вычисленный «CEFR» был бы выдумкой. Где метки нет — там `None`.
"""

from __future__ import annotations

import collections
import re
import sqlite3

from ..sources.ozdic import storage as ozdic_storage

LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")
_LEVEL_ORDER = {level: index for index, level in enumerate(LEVELS)}

# `tough (difficult, hard, tough)` → `tough`: в скобках словарь перечисляет
# остальных членов кластера, для сопоставления они не нужны.
_PAREN_TAIL_RE = re.compile(r"\s*\([^)]*\)\s*$")
_SPACES_RE = re.compile(r"\s+")


def normalize_key(text: str) -> str:
    """Приводит запись партнёра к виду, годному для сравнения."""
    cleaned = _PAREN_TAIL_RE.sub("", str(text or ""))
    cleaned = cleaned.replace("~", " ~ ")
    return _SPACES_RE.sub(" ", cleaned).strip().lower()


def _collocation_index(conn: sqlite3.Connection) -> dict[str, dict[str, list[str]]]:
    """slug → {нормализованная запись партнёра → id коллокаций}."""
    import json

    index: dict[str, dict[str, list[str]]] = collections.defaultdict(
        lambda: collections.defaultdict(list)
    )
    for record_id, slug, collocate, accept_json in conn.execute(
        "SELECT id, source_slug, collocate, accept FROM collocations"
    ):
        keys = {normalize_key(collocate)}
        keys |= {normalize_key(word) for word in json.loads(accept_json)}
        for key in keys:
            if key:
                index[slug][key].append(record_id)
    return index


def collect_levels(conn: sqlite3.Connection) -> dict[str, str]:
    """Возвращает `id коллокации → уровень` по данным тренировочных вопросов."""
    index = _collocation_index(conn)
    votes: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    state = sqlite3.connect(ozdic_storage.STATE_DB)
    slugs = [
        row[0]
        for row in state.execute(
            "SELECT slug FROM pages WHERE sources LIKE '%oxford-collocations%'"
        )
    ]
    state.close()

    for slug in slugs:
        by_key = index.get(slug)
        if not by_key:
            continue
        payload = ozdic_storage.read_entry(slug) or {}
        for bank in (payload.get("study_banks") or {}).values():
            for question in bank.get("questions") or []:
                level = question.get("cefr_level")
                if level not in _LEVEL_ORDER:
                    continue
                supported = (question.get("supported_by") or {}).get("collocations") or []
                for mention in supported:
                    for record_id in by_key.get(normalize_key(mention), ()):
                        votes[record_id][level] += 1

    # Несколько вопросов могут давать разные уровни одной коллокации.
    # Берём самый частый, при равенстве — более низкий: если материал
    # встречается в задании A2, значит на A2 он уже уместен.
    resolved: dict[str, str] = {}
    for record_id, counter in votes.items():
        best = max(counter.items(), key=lambda item: (item[1], -_LEVEL_ORDER[item[0]]))
        resolved[record_id] = best[0]
    return resolved
