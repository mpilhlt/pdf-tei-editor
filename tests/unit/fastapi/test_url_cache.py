"""
Unit tests for the generic URL content cache.

@testCovers fastapi_app/lib/core/url_cache.py
"""

import tempfile
import time
import unittest
from pathlib import Path

from fastapi_app.lib.core.url_cache import (
    UncacheableUrlError, UrlCache, atomic_write, atomic_write_text, get_cache_info, is_cache_stale,
)


class TestGetCacheInfo(unittest.TestCase):
    def test_derives_dir_and_file_from_url_path(self):
        cache_root = Path("/cache")
        cache_dir, cache_file, file_name = get_cache_info(
            "https://example.com/a/b/schema.rng", cache_root
        )
        self.assertEqual(cache_dir, cache_root / "example.com" / "a" / "b")
        self.assertEqual(file_name, "schema.rng")
        self.assertEqual(cache_file, cache_dir / "schema.rng")

    def test_sanitizes_unsafe_characters(self):
        cache_root = Path("/cache")
        _, cache_file, _ = get_cache_info("https://localhost:8000/a/file?.rng", cache_root)
        self.assertNotIn(":", str(cache_file.relative_to(cache_root)))
        self.assertNotIn("?", str(cache_file.relative_to(cache_root)))


    def test_rejects_path_outside_cache_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UncacheableUrlError):
                get_cache_info("https://evil.example/../../../../tmp/x.md", Path(tmp))

    def test_rejects_path_equal_to_cache_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UncacheableUrlError):
                get_cache_info("https://evil.example/..", Path(tmp))


class TestIsCacheStale(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_file = Path(self.temp_dir.name) / "f.txt"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_missing_file_is_stale(self):
        self.assertTrue(is_cache_stale(self.cache_file))

    def test_freshly_written_file_is_not_stale(self):
        self.cache_file.write_text("x")
        self.assertFalse(is_cache_stale(self.cache_file, ttl_seconds=3600))

    def test_file_older_than_ttl_is_stale(self):
        self.cache_file.write_text("x")
        old_time = time.time() - 7200
        import os
        os.utime(self.cache_file, (old_time, old_time))
        self.assertTrue(is_cache_stale(self.cache_file, ttl_seconds=3600))


class TestUrlCache(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        self.cache = UrlCache(self.cache_root, ttl_seconds=3600)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_get_text_returns_none_when_not_cached(self):
        self.assertIsNone(self.cache.get_text("https://example.com/a/b/c.md"))

    def test_set_then_get_text_round_trips(self):
        self.cache.set_text("https://example.com/a/b/c.md", "hello world")
        self.assertEqual(self.cache.get_text("https://example.com/a/b/c.md"), "hello world")

    def test_get_text_returns_none_when_stale(self):
        stale_cache = UrlCache(Path(self.temp_dir.name), ttl_seconds=0)
        stale_cache.set_text("https://example.com/a/b/c.md", "hello world")
        time.sleep(0.01)
        self.assertIsNone(stale_cache.get_text("https://example.com/a/b/c.md"))

    def test_get_text_ignores_staleness_when_ignore_ttl_is_true(self):
        cache = UrlCache(self.cache_root, ttl_seconds=0)
        cache.set_text("https://example.com/a/b.txt", "content")
        # ttl_seconds=0 means the entry is immediately stale under the default check...
        self.assertIsNone(cache.get_text("https://example.com/a/b.txt"))
        # ...but ignore_ttl=True returns it anyway, regardless of age.
        self.assertEqual(cache.get_text("https://example.com/a/b.txt", ignore_ttl=True), "content")

    def test_get_text_with_ignore_ttl_still_returns_none_when_never_cached(self):
        cache = UrlCache(self.cache_root)
        self.assertIsNone(cache.get_text("https://example.com/never/cached.txt", ignore_ttl=True))


class TestUrlCacheTraversal(unittest.TestCase):
    TRAVERSAL_URL = "https://evil.example/../../outside/x.md"

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name) / "a" / "b"
        self.cache_root.mkdir(parents=True)
        self.cache = UrlCache(self.cache_root)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_set_text_never_writes_outside_cache_root(self):
        with self.assertLogs("fastapi_app.lib.core.url_cache", level="WARNING"):
            self.cache.set_text(self.TRAVERSAL_URL, "payload")
        written = [p for p in Path(self.temp_dir.name).rglob("*") if p.is_file()]
        self.assertEqual(written, [])

    def test_get_text_returns_none_for_traversal_url(self):
        (Path(self.temp_dir.name) / "outside").mkdir()
        (Path(self.temp_dir.name) / "outside" / "x.md").write_text("secret", encoding="utf-8")
        with self.assertLogs("fastapi_app.lib.core.url_cache", level="WARNING"):
            self.assertIsNone(self.cache.get_text(self.TRAVERSAL_URL))

    def test_normal_url_still_round_trips(self):
        self.cache.set_text("https://example.com/a/b/c.md", "hello")
        self.assertEqual(self.cache.get_text("https://example.com/a/b/c.md"), "hello")


class TestAtomicWrite(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_successful_write_produces_content_and_no_temp_files(self):
        target = self.dir / "out.txt"
        atomic_write_text(target, "hello")
        self.assertEqual(target.read_text(encoding="utf-8"), "hello")
        self.assertEqual([p.name for p in self.dir.iterdir()], ["out.txt"])

    def test_failure_leaves_no_target_and_no_temp_file(self):
        target = self.dir / "out.txt"
        with self.assertRaises(RuntimeError):
            with atomic_write(target) as f:
                f.write(b"partial")
                raise RuntimeError("boom")
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_failure_keeps_previous_content(self):
        target = self.dir / "out.txt"
        atomic_write_text(target, "old")
        with self.assertRaises(RuntimeError):
            with atomic_write(target) as f:
                f.write(b"partial")
                raise RuntimeError("boom")
        self.assertEqual(target.read_text(encoding="utf-8"), "old")
        self.assertEqual([p.name for p in self.dir.iterdir()], ["out.txt"])

    def test_target_is_never_partial_during_write(self):
        target = self.dir / "out.txt"
        atomic_write_text(target, "old")
        with atomic_write(target) as f:
            f.write(b"new-partial")
            f.flush()
            self.assertEqual(target.read_text(encoding="utf-8"), "old")
        self.assertEqual(target.read_text(encoding="utf-8"), "new-partial")
