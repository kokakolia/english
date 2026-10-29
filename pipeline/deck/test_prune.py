"""Очистка общих TSV по всем колодам: python -m unittest pipeline.deck.test_prune."""
import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import build, export
from ..usage import build as usage, store as notes
from ..translate import build as translate, store as translations


class PruneTest(unittest.TestCase):
    def setUp(self):
        _, cards = export.load_deck("en-collocations")
        self.cards = cards[:2]
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patches = [patch.object(build, "DECKS_DIR", self.root / "decks"),
                        patch.object(export, "DECKS_DIR", self.root / "decks"),
                        patch.object(notes, "NOTES_DIR", self.root),
                        patch.object(notes, "TSV_PATH", self.root / "notes.tsv"),
                        patch.object(translations, "TRANSLATIONS_DIR", self.root),
                        patch.object(translations, "TSV_PATH", self.root / "translations.tsv")]
        for change in self.patches:
            change.start()
            self.addCleanup(change.stop)
        build.write_deck("full", "Full", self.cards, 1, "test")
        build.write_deck("subset", "Subset", self.cards[:1], 1, "test")
        notes.save_many([(card["id"], card["phrase"], "note") for card in self.cards] + [("orphan", "orphan", "old note")])
        translations.save_many([(card["text"].replace("___", card["answer"]), "перевод") for card in self.cards] + [("Unused sentence.", "старый перевод")])
        self.args = argparse.Namespace(deck_id="subset")

    def test_subset_prune_keeps_content_of_full_deck(self):
        usage.cmd_prune(self.args)
        translate.cmd_prune(self.args)
        self.assertEqual(set(notes.load_all()), {card["id"] for card in self.cards})
        self.assertEqual(set(translations.load_all()), {translations.key_for(card["text"].replace("___", card["answer"])) for card in self.cards})

    def test_broken_other_deck_aborts_without_changing_either_tsv(self):
        full = self.root / "decks/full"
        meta = json.loads((full / "deck.json").read_text(encoding="utf-8"))
        (full / meta["chunks"][0]).write_text("[]", encoding="utf-8")
        before_notes, before_translations = notes.TSV_PATH.read_bytes(), translations.TSV_PATH.read_bytes()
        with self.assertRaises(ValueError):
            usage.cmd_prune(self.args)
        with self.assertRaises(ValueError):
            translate.cmd_prune(self.args)
        self.assertEqual(notes.TSV_PATH.read_bytes(), before_notes)
        self.assertEqual(translations.TSV_PATH.read_bytes(), before_translations)

    def test_equal_count_but_modified_card_aborts(self):
        full = self.root / "decks/full"
        meta = json.loads((full / "deck.json").read_text(encoding="utf-8"))
        target = full / meta["chunks"][0]
        card = json.loads(target.read_text(encoding="utf-8"))
        card[0]["note"] = "tampered"
        target.write_text(json.dumps(card), encoding="utf-8")
        before = notes.TSV_PATH.read_bytes()
        with self.assertRaises(ValueError):
            usage.cmd_prune(self.args)
        self.assertEqual(notes.TSV_PATH.read_bytes(), before)

    def test_missing_catalog_is_not_an_empty_live_set(self):
        with patch.object(export, "DECKS_DIR", self.root / "missing"):
            with self.assertRaises(ValueError):
                export.all_published_cards()

    def test_manifest_missing_from_catalog_aborts(self):
        (self.root / "decks/full/deck.json").unlink()
        before = notes.TSV_PATH.read_bytes()
        with self.assertRaises(ValueError):
            usage.cmd_prune(self.args)
        self.assertEqual(notes.TSV_PATH.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
