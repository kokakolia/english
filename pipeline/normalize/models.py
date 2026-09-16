"""Промежуточный формат коллокации — граница между источником и остальным пайплайном.

Ниже этой границы живут особенности конкретного словаря, выше — только эта
структура. Смена источника данных не должна затрагивать ничего, кроме адаптера
(принцип 3 в PLAN.md).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field


@dataclass
class Collocation:
    headword: str                  # заголовочное слово
    head_pos: str | None           # его часть речи
    sense: str | None              # уточнение значения, если статья его делит
    relation: str                  # adj+noun, verb+obj, noun+verb, prep, ...
    position: str                  # before / after / template / phrase
    cat_raw: str                   # исходная метка словаря
    phrase: str                    # подпись коллокации
    collocate: str                 # основной вариант партнёра
    accept: list[str]              # все засчитываемые варианты
    variants: list[str]            # раскрытые формы записи
    example: str | None = None
    gap_start: int | None = None   # границы партнёра в примере — место пропуска
    gap_end: int | None = None
    matched: str | None = None     # вариант, найденный в примере
    needs_review: bool = False
    freq_pct: int | None = None
    source_dict: str = ""
    source_slug: str = ""
    id: str = field(default="", init=False)

    def __post_init__(self) -> None:
        self.id = self.make_id()

    def make_id(self) -> str:
        """Стабильный идентификатор.

        Пример в него не входит: замена предложения не должна создавать новую
        карточку и обнулять прогресс (принцип 2 в PLAN.md).
        """
        key = "|".join(
            [
                self.source_dict,
                self.headword.lower(),
                (self.head_pos or "").lower(),
                self.relation,
                self.sense or "",
                "/".join(sorted(word.lower() for word in self.accept)),
            ]
        )
        return "c_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]

    @property
    def has_cloze(self) -> bool:
        """Годится ли запись на карточку-пропуск прямо сейчас."""
        return bool(self.example) and self.gap_start is not None

    def to_row(self) -> dict:
        row = asdict(self)
        row["id"] = self.id
        row["accept"] = json.dumps(self.accept, ensure_ascii=False)
        row["variants"] = json.dumps(self.variants, ensure_ascii=False)
        row["needs_review"] = int(self.needs_review)
        return row
