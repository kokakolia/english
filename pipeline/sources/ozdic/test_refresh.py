"""Последняя неудачная попытка не удаляет последний успешно скачанный материал."""
import argparse
from contextlib import closing, redirect_stdout
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import crawl, storage
from .payload import summarize_entry
from ...normalize import build, store, identities


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(redirect_stdout(io.StringIO()))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        registry = identities.IdentityRegistry([])
        for change in (patch.object(storage, "STATE_DB", self.root / "crawl.sqlite"),
                       patch.object(storage, "ENTRIES_DIR", self.root / "entries"),
                       patch.object(store, "DB_PATH", self.root / "normalized.sqlite"),
                       patch.object(identities, "_registry", registry),
                       patch.object(registry, "save")):
            change.start()
            self.addCleanup(change.stop)
        self.args = argparse.Namespace(all_sources=False, force=False)

    def seed(self, slug="decision", source="oxford-collocations"):
        entry = {"word": slug, "sources": [source], "freq": {"pct": 70}, "collocations": [
            {"gloss": "(noun)", "groups": [{"cat": f"VERB + {slug.upper()}", "clusters": [
                {"words": ["make"], "example": f"We need to make a {slug}."}]}]}]}
        size = storage.write_entry(slug, {"fetched_at": "2026-10-30T10:00:00Z", "entry": entry})
        conn = crawl.open_db()
        crawl.record(conn, crawl.Result(slug, "ok", 200, summarize_entry(entry), size))
        conn.commit()
        conn.close()
        return entry

    def normalized(self):
        with closing(store.connect()) as conn:
            return conn.execute("SELECT id, source_slug, accept FROM collocations ORDER BY id").fetchall()

    def test_error_keeps_successful_metadata_and_normalized_material(self):
        self.seed()
        self.assertEqual(build.cmd_run(self.args), 0)
        original = self.normalized()
        self.assertTrue(original)
        raw = storage.entry_path("decision").read_bytes()
        for status, code in (("http_error", 503), ("network_error", None), ("parse_error", 200)):
            with self.subTest(status=status), closing(crawl.open_db()) as conn:
                before = conn.execute("SELECT fetched_at, has_collocations, sources, n_clusters, bytes_stored FROM pages").fetchone()
                crawl.record(conn, crawl.Result("decision", status, code, error="temporary failure"))
                conn.commit()
                after = conn.execute("SELECT fetched_at, has_collocations, sources, n_clusters, bytes_stored FROM pages").fetchone()
                self.assertEqual(after, before)
                self.assertEqual(conn.execute("SELECT status FROM pages").fetchone()[0], status)
                self.assertIsNotNone(conn.execute("SELECT attempted_at FROM pages").fetchone()[0])
                self.assertEqual(crawl.pending_slugs(conn, ["decision"], False, True), ["decision"])
            self.args.force = status == "parse_error"
            self.assertEqual(build.cmd_run(self.args), 0)
            self.assertEqual(self.normalized(), original)
            self.assertEqual(storage.entry_path("decision").read_bytes(), raw)

    def test_switching_source_filter_is_not_deletion(self):
        self.seed()
        self.seed("choice", "other-source")
        self.args.all_sources = True
        self.assertEqual(build.cmd_run(self.args), 0)
        before = self.normalized()
        self.assertEqual(len(before), 2)
        self.args.all_sources = False
        self.assertEqual(build.cmd_run(self.args), 0)
        self.assertEqual(self.normalized(), before)

    def test_confirmed_empty_article_can_still_be_removed(self):
        self.seed()
        self.assertEqual(build.cmd_run(self.args), 0)
        with closing(crawl.open_db()) as conn:
            crawl.record(conn, crawl.Result("decision", "no_entry", 200, summarize_entry(None)))
            conn.commit()
        self.assertEqual(build.cmd_run(self.args), 0)
        self.assertEqual(self.normalized(), [])

    def test_old_failed_catalog_is_repaired_from_cached_success(self):
        entry = {"word": "decision", "sources": ["oxford-collocations"],
                 "collocations": [{"groups": [{"clusters": [{"example": "example"}]}]}]}
        storage.write_entry("decision", {"fetched_at": "2026-10-29T10:00:00Z", "entry": entry})
        with sqlite3.connect(storage.STATE_DB) as conn:
            conn.executescript(crawl.SCHEMA.replace("    attempted_at    TEXT,\n", ""))
            conn.execute("INSERT INTO pages(slug,status,http_code,fetched_at,error) VALUES(?,?,?,?,?)",
                         ("decision", "http_error", 503, "2026-10-30T10:00:00Z", "temporary failure"))
        conn.close()
        with closing(crawl.open_db()) as conn:
            row = conn.execute("SELECT status,http_code,fetched_at,attempted_at,has_collocations,sources,error FROM pages").fetchone()
        self.assertEqual(row, ("http_error", 503, "2026-10-29T10:00:00Z", "2026-10-30T10:00:00Z",
                               1, "oxford-collocations", "temporary failure"))


if __name__ == "__main__":
    unittest.main()
