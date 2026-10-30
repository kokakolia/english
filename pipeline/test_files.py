"""Проверяем сбои записи на временных файлах, не на ручном контенте проекта."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import files
from .translate import store as translations
from .usage import store as notes
from .sentences import store as sentences


class ManualFilesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for module, directory, name in ((translations, "TRANSLATIONS_DIR", "translations.tsv"),
                                        (notes, "NOTES_DIR", "notes.tsv"),
                                        (sentences, "SENTENCES_DIR", "fixes.tsv")):
            for change in (patch.object(module, directory, self.root),
                           patch.object(module, "TSV_PATH", self.root / name)):
                change.start()
                self.addCleanup(change.stop)
        translations.save_many([("A sentence.", "Предложение.")])
        notes.save_many([("card", "make a decision", "Заметка")])
        sentences.save("A sentence.", "A ___.", "sentence")

    def operations(self):
        return [(translations, lambda: translations.save_many([("New sentence.", "Перевод.")])),
                (notes, lambda: notes.save_many([("new", "new phrase", "Новая заметка")])),
                (sentences, lambda: sentences.save("New sentence.", "New ___.", "sentence"))]

    def test_write_failures_preserve_original_and_remove_temporary_files(self):
        for module, operation in self.operations():
            for stage in ("fsync", "replace"):
                with self.subTest(module=module.__name__, stage=stage):
                    before = module.TSV_PATH.read_bytes()
                    with patch.object(files.os, stage, side_effect=OSError("disk failure")):
                        with self.assertRaises(OSError):
                            operation()
                    self.assertEqual(module.TSV_PATH.read_bytes(), before)
                    self.assertEqual(list(self.root.glob(".*.tmp")), [])
            operation()
            self.assertTrue(module.load_all())

    def test_malformed_source_aborts_read_and_write(self):
        for module, operation in self.operations():
            for malformed in ("broken\trow\n", "\tmissing\tkey\n"):
                with self.subTest(module=module.__name__, malformed=malformed):
                    module.TSV_PATH.write_text(malformed, encoding="utf-8")
                    before = module.TSV_PATH.read_bytes()
                    with self.assertRaises(ValueError):
                        module.load_all()
                    with self.assertRaises(ValueError):
                        operation()
                    self.assertEqual(module.TSV_PATH.read_bytes(), before)

    def test_duplicate_keys_abort_instead_of_silently_dropping_content(self):
        for module, operation in self.operations():
            text = module.TSV_PATH.read_text(encoding="utf-8")
            module.TSV_PATH.write_text(text + text.splitlines()[1] + "\n", encoding="utf-8")
            with self.subTest(module=module.__name__):
                with self.assertRaisesRegex(ValueError, "повторный ключ"):
                    operation()

    def test_invalid_cloze_aborts_instead_of_disappearing(self):
        sentences.TSV_PATH.write_text("key\toriginal\tmissing gap\tanswer\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "ровно один пропуск"):
            sentences.load_all()
        with self.assertRaises(ValueError):
            sentences.save("Another.", "___.", "Another")

    def test_checked_in_manual_content_is_readable(self):
        root = Path(__file__).resolve().parent.parent
        for module, name in ((translations, "translations/en-ru.tsv"), (notes, "notes/usage-ru.tsv"),
                             (sentences, "sentences/fixes.tsv")):
            with self.subTest(module=module.__name__), patch.object(module, "TSV_PATH", root / name):
                self.assertTrue(module.load_all())


if __name__ == "__main__":
    unittest.main()
