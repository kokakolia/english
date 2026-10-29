"""Постоянные ID кластеров: изменение набора партнёров не стирает выученное.

Реестр коммитится вместе с контентом. При неоднозначном разделении/слиянии
кластеров нормализация останавливается: переносить прогресс наугад нельзя.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

PATH = Path(__file__).resolve().parents[2] / "schema" / "card-identities.json"


def legacy_id(record) -> str:
    key = "|".join([record.source_dict, record.headword.lower(),
                    (record.head_pos or "").lower(), record.relation,
                    record.sense or "", "/".join(sorted(w.lower() for w in record.accept))])
    return "c_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def scope(record) -> list:
    return [record.source_dict, record.headword.lower(), (record.head_pos or "").lower(),
            record.relation, record.sense or ""]


class IdentityRegistry:
    def __init__(self, entries: list[dict]):
        self.entries = entries

    def resolve(self, record) -> str:
        alias = legacy_id(record)
        candidates = [entry for entry in self.entries if entry["scope"] == scope(record)]
        exact = [entry for entry in candidates if alias in entry["aliases"]]
        partners = {word.lower() for word in record.accept}
        overlap = [entry for entry in candidates if partners.intersection(entry["partners"])]
        # Добавление/удаление партнёров однозначно продолжают старый кластер.
        # Частичное пересечение двух разных наборов требует ручного решения.
        matches = exact or overlap
        if len(matches) > 1:
            raise ValueError(f"неоднозначная идентичность кластера {record.headword}: "
                             f"{record.accept}; проверьте {PATH.name}")
        if matches:
            entry = matches[0]
            previous = set(entry["partners"])
            if not exact and not (partners <= previous or previous <= partners):
                raise ValueError(f"изменилось значение кластера {record.headword}: "
                                 f"проверьте {PATH.name}")
            entry["aliases"] = sorted(set(entry["aliases"]) | {alias})
            entry["partners"] = sorted(set(entry["partners"]) | partners)
            return entry["id"]
        self.entries.append({"id": alias, "scope": scope(record),
                             "partners": sorted(partners), "aliases": [alias]})
        return alias

    def save(self, path: Path = PATH) -> None:
        # По одной записи в строке: изменения конкретного кластера видны в diff.
        payload = "[\n" + ",\n".join(
            " " + json.dumps(entry, ensure_ascii=False, sort_keys=True)
            for entry in sorted(self.entries, key=lambda entry: entry["id"])
        ) + "\n]\n"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(payload, encoding="utf-8")
        temporary.replace(path)


_registry: IdentityRegistry | None = None


def registry() -> IdentityRegistry:
    global _registry
    if _registry is None:
        _registry = IdentityRegistry(json.loads(PATH.read_text(encoding="utf-8")))
    return _registry
