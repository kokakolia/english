"""Строгое чтение ручных TSV и атомарная запись рядом с исходным файлом."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def read_tsv(path: Path, columns: tuple[int, ...]) -> list[list[str]]:
    if not path.exists():
        return []
    rows = []
    keys = set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) not in columns or any(not part.strip() for part in parts[:min(columns)]):
            raise ValueError(f"{path}:{number}: повреждённая строка TSV")
        if parts[0] in keys:
            raise ValueError(f"{path}:{number}: повторный ключ {parts[0]}")
        keys.add(parts[0])
        rows.append(parts)
    return rows


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=f".{path.name}.",
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
