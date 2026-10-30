"""Сетевые ответы подменены: тесты не обращаются к сайту или локальным сервисам."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from . import crawl, http, payload, sitemap, storage


def response(text="", status=200, location=None):
    return SimpleNamespace(text=text, status_code=status,
                           iter_content=Mock(side_effect=lambda **kwargs: iter([text.encode("utf-8")])), encoding="utf-8",
                           headers={"Location": location} if location else {},
                           raise_for_status=Mock(), close=Mock())


def html(flat):
    return '<script id="__NUXT_DATA__">' + json.dumps(flat) + '</script>'


class SourceRequestsTest(unittest.TestCase):
    def test_unexpected_origins_are_rejected_before_any_request(self):
        urls = ["http://127.0.0.1:8080/private", "https://127.0.0.1/private",
                "http://ozdic.com/sitemap.xml", "https://localhost/sitemap.xml",
                "https://[::1]/sitemap.xml", "https://169.254.169.254/latest",
                "https://ozdic.com.evil.test/sitemap.xml", "https://user@ozdic.com/sitemap.xml",
                "https://ozdic.com:8080/sitemap.xml", "file:///etc/passwd",
                "https://ozdic.com\\@evil.test/sitemap.xml", "https://ozdic.com/api/private"]
        for url in urls:
            with self.subTest(url=url):
                session = Mock()
                with self.assertRaises(http.SourceUrlError):
                    http.source_get(session, url)
                session.get.assert_not_called()

    def test_malicious_shard_location_never_reaches_the_network(self):
        session = Mock()
        session.get.return_value = response('<loc>http://127.0.0.1:8080/private</loc>')
        with self.assertRaises(http.SourceUrlError):
            sitemap.fetch_word_slugs(session, delay=0)
        session.get.assert_called_once_with(sitemap.SITEMAP_INDEX, timeout=60, allow_redirects=False, stream=True)

    def test_redirects_are_checked_before_following(self):
        for destination in ("http://127.0.0.1:8080/private", "https://evil.test/sitemap.xml",
                            "http://ozdic.com/sitemap.xml", "https://ozdic.com/api/private"):
            with self.subTest(destination=destination):
                redirect = response(status=302, location=destination)
                session = Mock()
                session.get.return_value = redirect
                with self.assertRaises(http.SourceUrlError):
                    http.source_get(session, sitemap.SITEMAP_INDEX, sitemap=True)
                self.assertEqual(session.get.call_count, 1)
                redirect.close.assert_called_once()

    def test_same_origin_relative_redirect_and_normal_shards_work(self):
        session = Mock()
        first = response(status=302, location="/sitemap-new.xml")
        session.get.side_effect = [first, response('<loc>https://ozdic.com/sitemap-1.xml</loc>'),
                                   response('<loc>https://ozdic.com/word/make%20up</loc>')]
        self.assertEqual(sitemap.fetch_word_slugs(session, delay=0), ["make up"])
        self.assertEqual([call.args[0] for call in session.get.call_args_list],
                         [sitemap.SITEMAP_INDEX, "https://ozdic.com/sitemap-new.xml", "https://ozdic.com/sitemap-1.xml"])
        self.assertTrue(all(call.kwargs["allow_redirects"] is False for call in session.get.call_args_list))

    def test_redirect_loop_is_bounded(self):
        session = Mock()
        session.get.return_value = response(status=301, location="/sitemap.xml")
        with self.assertRaisesRegex(http.SourceUrlError, "много перенаправлений"):
            http.source_get(session, sitemap.SITEMAP_INDEX, sitemap=True)
        self.assertEqual(session.get.call_count, 6)

    def test_foreign_word_locations_are_rejected(self):
        session = Mock()
        session.get.side_effect = [response('<loc>https://ozdic.com/sitemap-1.xml</loc>'),
                                   response('<loc>https://evil.test/word/make</loc>')]
        with self.assertRaises(http.SourceUrlError):
            sitemap.fetch_word_slugs(session, delay=0)
        self.assertEqual(session.get.call_count, 2)

    def test_article_redirect_uses_the_same_boundary(self):
        session = Mock()
        session.get.return_value = response(status=302, location="http://127.0.0.1:8080/private")
        result = crawl.fetch_one(session, Mock(), "test", 60)
        self.assertEqual(result.status, "network_error")
        self.assertEqual(session.get.call_count, 1)


class PayloadBudgetTest(unittest.TestCase):
    def test_small_binary_dag_is_rejected_before_expanding_json(self):
        levels = 40
        flat = [[index + 1, index + 1] for index in range(levels)] + ["x"]
        self.assertLess(len(json.dumps(flat)), 1000)
        with self.assertRaisesRegex(payload.PayloadError, "лимит развёрнутого"):
            payload.resolve_payload(flat)

    def test_shared_objects_within_budget_still_work(self):
        flat = [[1, 1], {"word": 2}, "test"]
        resolved = payload.resolve_payload(flat)
        self.assertIs(resolved[0], resolved[1])
        self.assertEqual(json.loads(json.dumps(resolved)), [{"word": "test"}] * 2)

    def test_counts_include_repeated_occurrences_and_utf8_bytes(self):
        shared = ["Я" * 100]
        with self.assertRaises(payload.PayloadError):
            payload.validate_expanded_payload([shared] * 20, max_bytes=1000, max_nodes=1000)
        with self.assertRaises(payload.PayloadError):
            payload.validate_expanded_payload([shared] * 20, max_bytes=100000, max_nodes=20)

    def test_input_is_limited_before_json_parse(self):
        with patch.object(payload, "MAX_PAYLOAD_BYTES", 64):
            with self.assertRaisesRegex(payload.PayloadError, "исходный payload"):
                payload.extract_flat_array(html(["x" * 100]))

    def test_cycle_cannot_reach_storage_serializer(self):
        cycle = []
        cycle.append(cycle)
        with self.assertRaisesRegex(payload.PayloadError, "циклический"):
            payload.validate_expanded_payload(cycle)

    def test_storage_guard_preserves_existing_entry_and_prevents_serialization(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, "ENTRIES_DIR", Path(directory)):
            original = {"slug": "test", "entry": {"word": "test"}}
            storage.write_entry("test", original)
            path = storage.entry_path("test")
            before = path.read_bytes()
            tree = ["x"]
            for _ in range(40):
                tree = [tree, tree]
            serializer = Mock(side_effect=AssertionError("must not serialize"))
            with patch.object(storage, "json", SimpleNamespace(dumps=serializer)):
                with self.assertRaises(payload.PayloadError):
                    storage.write_entry("test", {"entry": tree})
            serializer.assert_not_called()
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(storage.read_entry("test"), original)

    def test_crawler_reports_parse_error_without_writing_payload(self):
        flat = [{"data": 1}, {"word-test": 2}] + [[index + 1, index + 1] for index in range(2, 42)] + ["x"]
        session = Mock()
        session.get.return_value = response(html(flat))
        with patch.object(storage, "write_entry") as write:
            result = crawl.fetch_one(session, Mock(), "test", 60)
        self.assertEqual(result.status, "parse_error")
        write.assert_not_called()

    def test_normal_nuxt_page_keeps_entry_and_study_banks(self):
        flat = [{"data": 1}, {"word-test": 2, "study-bank-test": 3},
                {"word": 4, "collocations": 5}, {"level": 6}, "test", [], "B1"]
        self.assertEqual(payload.parse_page(html(flat), "test"),
                         {"entry": {"word": "test", "collocations": []}, "study_banks": {"study-bank-test": {"level": "B1"}}})


if __name__ == "__main__":
    unittest.main()
