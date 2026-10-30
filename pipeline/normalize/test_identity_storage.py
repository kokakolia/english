"""Разделение кластера и коллизии не должны уничтожать записи SQLite."""
import copy
import sqlite3
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from . import store
from .build import normalize_entry
from .identities import IdentityRegistry
from .models import Collocation


class IdentityStorageTest(unittest.TestCase):
    def setUp(self):
        self.registry = IdentityRegistry([])
        change = patch("pipeline.normalize.identities.registry", return_value=self.registry)
        change.start()
        self.addCleanup(change.stop)
        self.conn = sqlite3.connect(":memory:")
        self.conn.executescript(store.SCHEMA)
        self.addCleanup(self.conn.close)

    def record(self, accept, slug="decision"):
        return Collocation(headword="decision", head_pos="noun", sense=None,
                           relation="verb+obj", position="before", cat_raw="VERB + decision",
                           phrase="make a decision", collocate=accept[0], accept=accept,
                           variants=accept, source_dict="ozdic", source_slug=slug)

    def write(self, records, slug="decision"):
        store.replace_slug(self.conn, slug, "ozdic", "2026-10-30", "test", records)

    def test_split_fails_before_delete_and_preserves_state(self):
        old = self.record(["make", "take"])
        self.write([old])
        state = self.conn.execute("SELECT * FROM state").fetchall()
        split = [self.record(["make"]), self.record(["take"])]
        self.assertEqual(split[0].id, split[1].id)
        with self.assertRaisesRegex(ValueError, "повторный ID"):
            self.write(split)
        self.assertEqual(self.conn.execute("SELECT id, accept FROM collocations").fetchall(),
                         [(old.id, '["make", "take"]')])
        self.assertEqual(self.conn.execute("SELECT * FROM state").fetchall(), state)

    def test_normalizer_also_rejects_the_whole_split(self):
        self.record(["make", "take"])
        entry = {"word": "decision", "collocations": [{"gloss": "(noun)", "groups": [
            {"cat": "VERB + decision", "clusters": [{"words": ["make"]}, {"words": ["take"]}]}]}]}
        with self.assertRaisesRegex(ValueError, "разделение кластера"):
            normalize_entry(entry, "decision", None)

    def test_cross_article_collision_cannot_replace_original(self):
        old = self.record(["make"])
        self.write([old])
        collision = copy.copy(old)
        collision.source_slug = "other"
        with self.assertRaisesRegex(ValueError, "уже принадлежит"):
            self.write([collision], "other")
        self.assertEqual(self.conn.execute("SELECT source_slug FROM collocations").fetchall(), [("decision",)])

    def test_mid_insert_error_restores_previous_article(self):
        old = self.record(["make"])
        self.write([old])
        first = copy.copy(old)
        first.phrase = "updated"
        broken = SimpleNamespace(id="broken", source_slug="decision", source_dict="ozdic",
                                 to_row=lambda: {**old.to_row(), "id": "broken", "headword": None})
        with self.assertRaises(sqlite3.IntegrityError):
            self.write([first, broken])
        self.assertEqual(self.conn.execute("SELECT id, phrase FROM collocations").fetchall(), [(old.id, old.phrase)])

    def test_successful_write_remains_in_callers_transaction(self):
        self.write([self.record(["make"])])
        self.assertTrue(self.conn.in_transaction)
        self.conn.rollback()
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM collocations").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
