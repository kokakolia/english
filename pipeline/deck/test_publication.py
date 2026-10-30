"""Проверки публикации: python -m unittest pipeline.deck.test_publication."""
import json
import multiprocessing
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path
from unittest.mock import patch

from . import build


def publish_in_process(folder, deck_id, cards):
    build.DECKS_DIR = Path(folder)
    for _ in range(3):
        build.write_deck(deck_id, deck_id, cards, 2, "test")


class PublicationTest(unittest.TestCase):
    def setUp(self):
        root = build.DECKS_DIR / "en-collocations"
        meta = json.loads((root / "deck.json").read_text(encoding="utf-8"))
        self.cards = json.loads((root / meta["chunks"][0]).read_text(encoding="utf-8"))[:4]
        self.temporary = tempfile.TemporaryDirectory()
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

    def test_stale_index_writer_cannot_overwrite_another_publication(self):
        entered, release, beta_started = threading.Event(), threading.Event(), threading.Event()
        original = build.write_json_atomic

        def pause_index(path, value):
            if path.name == "index.json" and "alpha" in {deck["id"] for deck in value["decks"]} and "beta" not in {deck["id"] for deck in value["decks"]}:
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("test did not release publication")
            return original(path, value)

        def second():
            beta_started.set()
            return build.write_deck("beta", "Beta", self.cards, 2, "test")

        with patch.object(build, "write_json_atomic", pause_index), ThreadPoolExecutor(max_workers=2) as pool:
            alpha = pool.submit(build.write_deck, "alpha", "Alpha", self.cards, 2, "test")
            try:
                self.assertTrue(entered.wait(5))
                beta = pool.submit(second)
                self.assertTrue(beta_started.wait(5))
                with self.assertRaises(FutureTimeout):
                    beta.result(timeout=0.2)
            finally:
                release.set()
            alpha.result(timeout=5)
            beta.result(timeout=5)
        index = json.loads((build.DECKS_DIR / "index.json").read_text(encoding="utf-8"))
        self.assertEqual({deck["id"] for deck in index["decks"]}, {"audit", "alpha", "beta"})

    def test_separate_processes_keep_both_decks_and_monotonic_publications(self):
        context = multiprocessing.get_context("spawn")
        processes = [context.Process(target=publish_in_process, args=(str(build.DECKS_DIR), name, self.cards))
                     for name in ("alpha", "beta")]
        try:
            for process in processes:
                process.start()
            for process in processes:
                process.join(15)
                self.assertFalse(process.is_alive())
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(5)
                if process.pid is not None:
                    process.close()
        index = json.loads((build.DECKS_DIR / "index.json").read_text(encoding="utf-8"))
        self.assertEqual({deck["id"] for deck in index["decks"]}, {"audit", "alpha", "beta"})
        for entry in index["decks"]:
            manifest = json.loads((build.DECKS_DIR / entry["path"]).read_text(encoding="utf-8"))
            self.assertEqual(entry["version"], manifest["version"])


if __name__ == "__main__":
    unittest.main()
