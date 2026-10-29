"""Проверки пайплайна без скачанного сырья: python -m pipeline.check."""
import importlib
import unittest
from pathlib import Path

from .deck.export import all_published_cards


def main() -> int:
    for name in ("normalize", "rank", "deck"):
        module = importlib.import_module(f"pipeline.{name}.selftest")
        if module.main() != 0:
            return 1
    root = Path(__file__).resolve().parent
    suite = unittest.defaultTestLoader.discover(str(root), top_level_dir=str(root.parent))
    if not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful():
        return 1
    cards = all_published_cards()
    print(f"Проверена целостность опубликованных колод: {len(cards)} карточек")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
