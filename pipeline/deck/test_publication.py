"""Проверки публикации: python -m unittest pipeline.deck.test_publication."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import build


class PublicationTest(unittest.TestCase):
    def setUp(self):
        root = build.DECKS_DIR / "en-collocations"
        meta = json.loads((root / "deck.json").read_text(encoding="utf-8"))
        self.cards = json.loads((root / meta["chunks"][0]).read_text(encoding="utf-8"))[:4]
        data = Path(__file__).resolve().parents[1] / "data"
        data.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=data)
        self.addCleanup(self.temporary.cleanup)
        self.root_patch = patch.object(build, "DECKS_DIR", Path(self.temporary.name) / "decks")
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.folder = build.write_deck("audit", "Audit", self.cards, 2, "test")
        self.old_manifest = (self.folder / "deck.json").read_bytes()
        self.old = json.loads(self.old_manifest)
        self.changed = [{**card, "note": "Updated note."} for card in self.cards]

    def assert_previous_is_intact(self):
        self.assertEqual((self.folder / "deck.json").read_bytes(), self.old_manifest)
        parts = [json.loads((self.folder / name).read_text(encoding="utf-8")) for name in self.old["chunks"]]
        self.assertEqual(build.content_version(sum(parts, [])), self.old["version"])
        for name, part in zip(self.old["chunks"], parts):
            self.assertEqual(build.content_hash(part), self.old["integrity"]["chunks"][name])

    def test_interruption_while_writing_parts(self):
        original = build.write_json_atomic
        writes = 0

        def interrupt(path, value):
            nonlocal writes
            if path.name.startswith("cards-"):
                writes += 1
                if writes == 2:
                    raise OSError("interrupted")
            return original(path, value)

        with patch.object(build, "write_json_atomic", interrupt), self.assertRaises(OSError):
            build.write_deck("audit", "Audit", self.changed, 2, "test")
        self.assert_previous_is_intact()

    def test_interruption_before_manifest_replacement(self):
        original = build.os.replace

        def interrupt(source, target):
            if Path(target) == self.folder / "deck.json":
                raise OSError("interrupted")
            return original(source, target)

        with patch.object(build.os, "replace", interrupt), self.assertRaises(OSError):
            build.write_deck("audit", "Audit", self.changed, 2, "test")
        self.assert_previous_is_intact()

    def test_success_keeps_previous_parts_available(self):
        build.write_deck("audit", "Audit", self.changed, 2, "test")
        current = json.loads((self.folder / "deck.json").read_text(encoding="utf-8"))
        self.assertNotEqual(current["chunks"], self.old["chunks"])
        self.assertEqual(current["version"], build.content_version(self.changed))
        self.assertGreater(current["built_at"], self.old["built_at"])
        self.assertTrue(all((self.folder / name).exists() for name in self.old["chunks"]))
        for name in current["chunks"]:
            part = json.loads((self.folder / name).read_text(encoding="utf-8"))
            self.assertEqual(build.content_hash(part), current["integrity"]["chunks"][name])


if __name__ == "__main__":
    unittest.main()
