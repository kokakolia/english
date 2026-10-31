"""Параллельная правка не должна исчезать за успешно завершённой записью."""
import json
import multiprocessing
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from . import files
from .locking import exclusive_file_lock
from .normalize.identities import IdentityRegistry
from .translate import store as translations
from .usage import store as notes
from .sentences import store as sentences


def write_manual(module, index):
    if module is translations:
        module.save_many([(f"Sentence {index}.", f"Перевод {index}")])
    elif module is notes:
        module.save_many([(f"card{index}", f"phrase {index}", f"Note {index}")],
                         {f"card{index}": str(index) * 64})
    else:
        module.save(f"Sentence {index}.", "Sentence ___.", str(index))


def process_write(root, name, index, ready, start):
    module = {"translations": translations, "notes": notes, "sentences": sentences}[name]
    module.TSV_PATH = Path(root) / f"{name}.tsv"
    original = module.read_tsv

    def delayed(*args):
        snapshot = original(*args)
        time.sleep(0.1)
        return snapshot

    module.read_tsv = delayed
    ready.set()
    if not start.wait(10):
        raise TimeoutError("parent did not release writers")
    write_manual(module, index)


class FileTransactionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, module, directory in (("translations", translations, "TRANSLATIONS_DIR"),
                                         ("notes", notes, "NOTES_DIR"),
                                         ("sentences", sentences, "SENTENCES_DIR")):
            self.enterContext(patch.object(module, "TSV_PATH", self.root / f"{name}.tsv"))
            self.enterContext(patch.object(module, directory, self.root))

    def test_lock_is_held_before_any_read_in_save_and_prune(self):
        for module in (translations, notes, sentences):
            operations = [lambda m=module: write_manual(m, 1)]
            if module is not sentences:
                operations.append(lambda m=module: m.forget_unused(set()))
            for operation in operations:
                started, read = threading.Event(), threading.Event()
                original = module.read_tsv

                def observed(*args):
                    read.set()
                    return original(*args)

                def run():
                    started.set()
                    operation()

                with self.subTest(module=module.__name__), patch.object(module, "read_tsv", observed):
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        with exclusive_file_lock(module.TSV_PATH.with_name(module.TSV_PATH.name + ".lock")):
                            future = pool.submit(run)
                            self.assertTrue(started.wait(3))
                            blocked = not read.wait(0.1)
                        future.result(timeout=5)
                    self.assertTrue(blocked, "read started before acquiring the transaction lock")
                    self.assertTrue(read.is_set())

    def test_independent_processes_preserve_both_updates_in_all_three_stores(self):
        context = multiprocessing.get_context("spawn")
        for name, module in (("translations", translations), ("notes", notes), ("sentences", sentences)):
            with self.subTest(store=name):
                start = context.Event()
                ready = [context.Event(), context.Event()]
                processes = [context.Process(target=process_write,
                             args=(str(self.root), name, index, ready[index - 1], start))
                             for index in (1, 2)]
                try:
                    for process in processes:
                        process.start()
                    self.assertTrue(all(event.wait(10) for event in ready))
                    start.set()
                    for process in processes:
                        process.join(10)
                        self.assertFalse(process.is_alive())
                        self.assertEqual(process.exitcode, 0)
                finally:
                    start.set()
                    for process in processes:
                        if process.is_alive():
                            process.terminate()
                            process.join(5)
                        if process.pid is not None:
                            process.close()
                self.assertEqual(len(module.load_all()), 2)
                if module is notes:
                    self.assertEqual(module.load_contexts(), {"card1": "1" * 64, "card2": "2" * 64})

    def test_note_and_context_are_read_from_one_snapshot(self):
        card = {"id": "card", "accept": ["make"], "text": "___ a decision", "answer": "make"}
        old_context = notes.context_key(card["accept"], card["text"], card["answer"])
        rows = [["card", "phrase", "stale note", "old-context"]]
        newer = [["card", "phrase", "current note", old_context]]
        with patch.object(notes, "read_tsv", side_effect=[rows, newer]) as reader:
            self.assertEqual(notes.notes_for([card]), {})
            self.assertEqual(reader.call_count, 1)


class RegistryTransactionTest(unittest.TestCase):
    def test_stale_registry_cannot_overwrite_a_successful_concurrent_save(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "identities.json"
            path.write_text("[]", encoding="utf-8")
            first, second = IdentityRegistry([]), IdentityRegistry([])
            def record(word):
                return SimpleNamespace(source_dict="test", headword=word, head_pos="noun",
                                       relation="verb+obj", sense=None, accept=["make"])
            first.resolve(record("decision"))
            second.resolve(record("choice"))
            first.save(path)
            original = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "другим процессом"):
                second.save(path)
            self.assertEqual(path.read_bytes(), original)
            first.resolve(record("choice"))
            with patch.object(files.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    first.save(path)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(folder).glob(".*.tmp")), [])
            first.save(path)
            self.assertEqual(len(json.loads(path.read_text(encoding="utf-8"))), 2)


if __name__ == "__main__":
    unittest.main()
