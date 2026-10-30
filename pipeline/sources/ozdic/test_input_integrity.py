import gzip
import io
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from urllib3.response import HTTPResponse

from . import crawl, http, storage
from .payload import PayloadError
from .test_boundaries import response


def page(entry):
    nodes = []
    def encode(value):
        index = len(nodes)
        nodes.append(None)
        nodes[index] = ({key: encode(child) for key, child in value.items()} if isinstance(value, dict)
                        else [encode(child) for child in value] if isinstance(value, list) else value)
        return index
    encode({"data": {"word-test": entry}})
    return '<script id="__NUXT_DATA__">' + json.dumps(nodes) + '</script>'


class RawStorageTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(patch.object(storage, "ENTRIES_DIR", self.root))

    def test_colliding_legacy_names_and_case_have_distinct_windows_paths(self):
        for left, right in (("con", "con_"), ("a/b", "a-2fb"), ("rock'n'roll", "rock-27n-27roll"),
                            ("Alpha", "alpha"), ("a" * 200, "a" * 201)):
            with self.subTest(left=left, right=right):
                self.assertNotEqual(str(storage.entry_path(left)).casefold(), str(storage.entry_path(right)).casefold())
                self.assertLessEqual(len(storage.entry_path(left).name), 121)

    def test_parallel_colliding_slugs_do_not_overwrite_each_other(self):
        slugs = ["con", "con_", "a/b", "a-2fb", "rock'n'roll", "rock-27n-27roll"]
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda slug: storage.write_entry(slug, {"entry": {"word": slug}}), slugs))
        for slug in slugs:
            self.assertEqual(storage.read_entry(slug), {"slug": slug, "entry": {"word": slug}})
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_parallel_same_slug_has_unique_temporary_files(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda value: storage.write_entry("same", {"value": value}), range(24)))
        self.assertIn(storage.read_entry("same")["value"], range(24))
        self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_legacy_file_is_read_only_for_its_recorded_owner(self):
        legacy = self.root / "c/co/con_.json.gz"
        legacy.parent.mkdir(parents=True)
        original = {"slug": "con", "entry": {"word": "con"}}
        with gzip.open(legacy, "wt", encoding="utf-8") as stream:
            json.dump(original, stream)
        self.assertEqual(storage.read_entry("con"), original)
        with self.assertRaises(PayloadError):
            storage.read_entry("con_")
        storage.write_entry("con_", {"entry": {"word": "con_"}})
        self.assertEqual(storage.read_entry("con"), original)
        self.assertEqual(storage.read_entry("con_")["slug"], "con_")

    def test_wrong_owner_cannot_be_written_or_read_from_hashed_path(self):
        with self.assertRaises(PayloadError):
            storage.write_entry("test", {"slug": "other"})
        path = storage.entry_path("test")
        path.parent.mkdir(parents=True)
        with gzip.open(path, "wt", encoding="utf-8") as stream:
            json.dump({"slug": "other"}, stream)
        with self.assertRaises(PayloadError):
            storage.read_entry("test")

    def test_failed_atomic_replace_preserves_old_content(self):
        storage.write_entry("test", {"value": "old"})
        before = storage.entry_path("test").read_bytes()
        with patch.object(storage.os, "replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                storage.write_entry("test", {"value": "new"})
        self.assertEqual(storage.entry_path("test").read_bytes(), before)
        self.assertEqual(list(self.root.rglob("*.tmp")), [])


class HttpBodyTest(unittest.TestCase):
    def test_status_retry_closes_the_body_instead_of_draining_it(self):
        session = Mock()
        session._source_status_retries = 1
        session._source_backoff = 0
        failed, good = response("never read this body", status=503), response("ok")
        failed.headers["Retry-After"] = "99999999"
        session.get.side_effect = [failed, good]
        with patch.object(http.time, "sleep") as sleep:
            self.assertIs(http.source_get(session, "https://ozdic.com/word/test"), good)
        failed.close.assert_called_once()
        failed.iter_content.assert_not_called()
        sleep.assert_called_once_with(60)
        with http.make_session() as real_session:
            self.assertEqual(real_session.get_adapter(http.BASE_URL).max_retries.status, 0)

    def test_reader_stops_at_decoded_limit_and_closes_response(self):
        reads = []
        def chunks(**kwargs):
            for index in range(1000):
                reads.append(index)
                yield b"x" * 8
        reply = SimpleNamespace(iter_content=chunks, encoding="utf-8", close=Mock())
        with self.assertRaises(http.ResponseLimitError):
            http.read_source_text(reply, max_bytes=16)
        self.assertEqual(reads, [0, 1, 2])
        reply.close.assert_called_once()

    def test_limit_counts_gzip_output_instead_of_compressed_length(self):
        packed = gzip.compress(b"x" * 1024 * 1024)
        self.assertLess(len(packed), 32 * 1024)
        reply = requests.Response()
        reply.status_code, reply.encoding = 200, "utf-8"
        reply.raw = HTTPResponse(body=io.BytesIO(packed), headers={"Content-Encoding": "gzip"}, preload_content=False)
        with self.assertRaises(http.ResponseLimitError):
            http.read_source_text(reply, max_bytes=32 * 1024)
        self.assertTrue(reply.raw.closed)

    def test_large_html_with_small_payload_is_rejected_before_parse(self):
        def chunks(**kwargs):
            for _ in range(320):
                yield b" " * (64 * 1024)
            yield page({"word": "test"}).encode()
        reply = SimpleNamespace(status_code=200, iter_content=chunks, encoding="utf-8", close=Mock())
        session = Mock()
        session.get.return_value = reply
        with patch.object(crawl, "parse_page") as parse:
            result = crawl.fetch_one(session, Mock(), "test", 60)
        self.assertEqual(result.status, "network_error")
        parse.assert_not_called()
        session.get.assert_called_once_with("https://ozdic.com/word/test", timeout=60, allow_redirects=False, stream=True)
        reply.close.assert_called_once()


class ArticleShapeTest(unittest.TestCase):
    def test_bad_nested_fields_are_parse_errors_and_do_not_reach_storage(self):
        entries = [{"collocations": [{"groups": 1}]}, {"collocations": [{"groups": [{"clusters": 1}]}]},
                   {"collocations": {}}, {"freq": {"pct": {"bad": 1}}}, {"sources": [1]},
                   {"collocations": [{"groups": [{"clusters": [{"words": 1}]}]}]},
                   {"collocations": [{"groups": [{"clusters": [{"example": 1}]}]}]}]
        for entry in entries:
            with self.subTest(entry=entry):
                session = Mock()
                session.get.return_value = response(page(entry))
                with patch.object(storage, "write_entry") as write:
                    result = crawl.fetch_one(session, Mock(), "test", 60)
                self.assertEqual(result.status, "parse_error")
                write.assert_not_called()

    def test_malformed_article_does_not_abort_other_futures(self):
        session = Mock()
        session.get.side_effect = [response(page({"collocations": [{"groups": 1}]})),
                                   response(page({"word": "test", "collocations": []}))]
        with patch.object(storage, "write_entry", return_value=100), ThreadPoolExecutor(max_workers=1) as pool:
            futures = [pool.submit(crawl.fetch_one, session, Mock(), "test", 60) for _ in range(2)]
            results = [future.result() for future in futures]
        self.assertEqual([result.status for result in results], ["parse_error", "ok"])
        with sqlite3.connect(":memory:") as conn:
            conn.executescript(crawl.SCHEMA)
            for result in results:
                crawl.record(conn, result)
            self.assertEqual(conn.execute("SELECT status FROM pages").fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main()
