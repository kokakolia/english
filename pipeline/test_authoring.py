"""Импорт ручного материала должен проверять полную идентичность задания."""
import argparse
import io
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

from .translate import build as translations, store as translation_store
from .usage import build as notes, store as note_store

SENTENCES = ["This is collision test sentence 149244.", "This is collision test sentence 173907."]


class TranslationKeysTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(redirect_stdout(io.StringIO()))
        self.enterContext(redirect_stderr(io.StringIO()))
        self.enterContext(patch.object(translation_store, "TSV_PATH", self.root / "translations.tsv"))
        self.enterContext(patch.object(translation_store, "TRANSLATIONS_DIR", self.root))
        self.sentences = SENTENCES[:]
        self.enterContext(patch.object(translations, "sentences_of", side_effect=lambda _: self.sentences))
        self.args = argparse.Namespace(deck_id="test", file=str(self.root / "response.tsv"), batch=0, out=str(self.root / "todo.tsv"))

    def write(self, text):
        Path(self.args.file).write_text(text, encoding="utf-8")

    def test_real_short_collision_is_rejected_without_partial_import(self):
        first, second = map(translation_store.key_for, SENTENCES)
        self.assertEqual(first[:8], second[:8])
        self.assertNotEqual(first, second)
        self.write(f"{first}\tПервый перевод\n{first[:8]}\tНеоднозначный перевод\n")
        self.assertEqual(translations.cmd_load(self.args), 1)
        self.assertFalse(translation_store.TSV_PATH.exists())

    def test_todo_and_full_keys_distinguish_the_colliding_sentences(self):
        self.assertEqual(translations.cmd_todo(self.args), 0)
        rows = Path(self.args.out).read_text(encoding="utf-8").splitlines()
        keys = [line.split("\t")[0] for line in rows]
        self.assertTrue(all(len(key) == 40 for key in keys))
        self.write(f"{keys[0]}\tПервый перевод\n{keys[1]}\tВторой перевод\n")
        self.assertEqual(translations.cmd_load(self.args), 0)
        self.assertEqual(translation_store.load_all(), {keys[0]: "Первый перевод", keys[1]: "Второй перевод"})

    def test_unambiguous_old_short_key_and_sentence_pair_still_work(self):
        self.sentences = SENTENCES[:1]
        key = translation_store.key_for(self.sentences[0])
        self.write(f"{key[:8]}\tПеревод\n")
        self.assertEqual(translations.cmd_load(self.args), 0)
        self.write(f"{self.sentences[0]}\tОбновлённый перевод\n")
        self.assertEqual(translations.cmd_load(self.args), 0)
        self.assertEqual(translation_store.load_all()[key], "Обновлённый перевод")


class NoteContextTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(redirect_stdout(io.StringIO()))
        self.enterContext(redirect_stderr(io.StringIO()))
        self.enterContext(patch.object(note_store, "TSV_PATH", self.root / "notes.tsv"))
        self.enterContext(patch.object(note_store, "NOTES_DIR", self.root))
        self.old = {"id": "c_test", "phrase": "make decision", "relation": "verb+obj", "accept": ["make"],
                    "text": "Yesterday I ___ a decision.", "answer": "made"}
        self.new = {**self.old, "text": "I need to ___ a decision.", "answer": "make"}
        self.cards = [self.old]
        self.enterContext(patch.object(notes, "cards_of", side_effect=lambda _: self.cards))
        self.args = argparse.Namespace(deck_id="test", file=str(self.root / "response.tsv"), batch=0, out=str(self.root / "todo.tsv"))

    def context(self, card):
        return note_store.context_key(card["accept"], card["text"], card["answer"])

    def write(self, text):
        Path(self.args.file).write_text(text, encoding="utf-8")

    def test_stale_task_is_rejected_and_old_note_is_not_marked_current(self):
        self.assertEqual(notes.cmd_todo(self.args), 0)
        token = Path(self.args.out).read_text(encoding="utf-8").split("\t")[1]
        self.assertEqual(token, self.context(self.old))
        note_store.save_many([("c_test", "make decision", "Old note")], {"c_test": token})
        before = note_store.TSV_PATH.read_bytes()
        self.cards = [self.new]
        self.write(f"c_test\t{token}\tNote about made\n")
        self.assertEqual(notes.cmd_load(self.args), 1)
        self.assertEqual(note_store.TSV_PATH.read_bytes(), before)
        self.assertEqual(note_store.notes_for(self.cards), {})

    def test_verified_context_is_saved_verbatim(self):
        self.cards = [self.new]
        token = self.context(self.new)
        self.write(f"c_test\t{token}\tNote about make\n")
        self.assertEqual(notes.cmd_load(self.args), 0)
        self.assertEqual(note_store.load_contexts()["c_test"], token)
        self.assertEqual(note_store.notes_for(self.cards), {"c_test": "Note about make"})

    def test_legacy_response_without_context_is_not_automatically_certified(self):
        self.write("c_test\tNote with no context\n")
        self.assertEqual(notes.cmd_load(self.args), 1)
        self.assertFalse(note_store.TSV_PATH.exists())

    def test_bad_context_cancels_the_whole_batch(self):
        self.cards = [self.old, {**self.new, "id": "second"}]
        self.write(f"c_test\t{self.context(self.old)}\tGood note\nsecond\t{self.context(self.old)}\tStale note\n")
        self.assertEqual(notes.cmd_load(self.args), 1)
        self.assertFalse(note_store.TSV_PATH.exists())


if __name__ == "__main__":
    unittest.main()
