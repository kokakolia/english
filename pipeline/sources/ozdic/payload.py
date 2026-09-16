"""Извлечение структурированных данных из страниц ozdic.com.

Страницы `/word/<slug>` отдают SSR-payload Nuxt в теге `<script id="__NUXT_DATA__">`.
Формат — devalue: плоский массив, где элементы ссылаются друг на друга по индексу.
Здесь он разворачивается обратно в обычные вложенные структуры.

Из payload нас интересуют два ключа `data`:
  * `word-<slug>`       — словарная статья (collocations, definitions, freq, ipa, ...)
  * `study-bank-<...>`  — готовые тренировочные вопросы с CEFR-уровнями
"""

from __future__ import annotations

import json
import re
from typing import Any

_PAYLOAD_RE = re.compile(
    r'<script[^>]*\bid="__NUXT_DATA__"[^>]*>(.*?)</script>', re.DOTALL
)

# Обёртки Nuxt в devalue: ["ИмяТипа", <ссылка>].
_WRAPPERS = frozenset(
    {
        "ShallowReactive",
        "Reactive",
        "Ref",
        "ShallowRef",
        "EmptyRef",
        "EmptyShallowRef",
        "NuxtError",
        "Object",
    }
)

_MAX_DEPTH = 100


class PayloadError(RuntimeError):
    """Payload отсутствует или не разбирается."""


def extract_flat_array(html: str) -> list[Any]:
    """Достаёт плоский devalue-массив из HTML страницы."""
    match = _PAYLOAD_RE.search(html)
    if match is None:
        raise PayloadError("на странице нет <script id=__NUXT_DATA__>")
    try:
        arr = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise PayloadError(f"payload не является JSON: {exc}") from exc
    if not isinstance(arr, list):
        raise PayloadError(f"payload не массив, а {type(arr).__name__}")
    return arr


def _resolve(arr: list[Any], idx: Any, cache: dict[int, Any],
             stack: frozenset[int], depth: int) -> Any:
    # Не ссылка, а литерал (bool в Python — подкласс int, поэтому проверяем явно).
    if isinstance(idx, bool) or not isinstance(idx, int):
        return idx
    # Отрицательные индексы в devalue — служебные: undefined, дырка, NaN, ±Infinity.
    if idx < 0 or idx >= len(arr):
        return None
    if idx in cache:
        return cache[idx]
    if idx in stack or depth > _MAX_DEPTH:
        return None  # цикл или слишком глубокая вложенность

    value = arr[idx]
    inner_stack = stack | {idx}

    if isinstance(value, list):
        # Массив ссылок — это список int. Если первый элемент строка,
        # перед нами типизированная обёртка devalue.
        if value and isinstance(value[0], str):
            tag = value[0]
            if tag in _WRAPPERS and len(value) == 2:
                resolved: Any = _resolve(arr, value[1], cache, inner_stack, depth + 1)
            elif tag in ("Set", "Map"):
                resolved = [
                    _resolve(arr, item, cache, inner_stack, depth + 1)
                    for item in value[1:]
                ]
            elif tag == "Date":
                resolved = _resolve(arr, value[1], cache, inner_stack, depth + 1)
            else:
                resolved = [tag] + [
                    _resolve(arr, item, cache, inner_stack, depth + 1)
                    for item in value[1:]
                ]
        else:
            resolved = [
                _resolve(arr, item, cache, inner_stack, depth + 1) for item in value
            ]
    elif isinstance(value, dict):
        resolved = {
            key: _resolve(arr, ref, cache, inner_stack, depth + 1)
            for key, ref in value.items()
        }
    else:
        resolved = value

    cache[idx] = resolved
    return resolved


def resolve_payload(arr: list[Any]) -> Any:
    """Разворачивает плоский devalue-массив в обычную структуру."""
    return _resolve(arr, 0, {}, frozenset(), 0)


def parse_page(html: str, slug: str) -> dict[str, Any]:
    """Разбирает страницу `/word/<slug>` в словарь с нужными нам частями.

    Возвращает `{"entry": <статья или None>, "study_banks": {...}}`.
    `entry is None` — страница есть, но словарной статьи для слова нет.
    """
    root = resolve_payload(extract_flat_array(html))
    if not isinstance(root, dict):
        raise PayloadError(f"корень payload не объект, а {type(root).__name__}")

    data = root.get("data")
    if not isinstance(data, dict):
        raise PayloadError("в payload нет объекта data")

    entry = data.get(f"word-{slug}")
    if not isinstance(entry, dict):
        entry = None

    study_banks = {
        key: value
        for key, value in data.items()
        if key.startswith("study-bank-") and isinstance(value, dict)
    }
    return {"entry": entry, "study_banks": study_banks}


def summarize_entry(entry: dict[str, Any] | None) -> dict[str, Any]:
    """Короткая сводка по статье — для таблицы состояния краулера."""
    summary = {
        "has_entry": entry is not None,
        "has_collocations": False,
        "n_clusters": 0,
        "n_examples": 0,
        "freq_pct": None,
        "sources": "",
    }
    if entry is None:
        return summary

    freq = entry.get("freq")
    if isinstance(freq, dict):
        summary["freq_pct"] = freq.get("pct")

    sources = entry.get("sources")
    if isinstance(sources, list):
        summary["sources"] = ",".join(str(s) for s in sources if s)

    blocks = entry.get("collocations")
    if not isinstance(blocks, list):
        return summary

    for block in blocks:
        if not isinstance(block, dict):
            continue
        for group in block.get("groups") or []:
            if not isinstance(group, dict):
                continue
            for cluster in group.get("clusters") or []:
                if not isinstance(cluster, dict):
                    continue
                summary["n_clusters"] += 1
                if cluster.get("example"):
                    summary["n_examples"] += 1

    summary["has_collocations"] = summary["n_clusters"] > 0
    return summary
