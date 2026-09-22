"""
Unit tests for the generic URL content cache.

@testCovers fastapi_app/lib/core/url_cache.py
"""

import tempfile
import time
import unittest
from pathlib import Path

from fastapi_app.lib.core.url_cache import UrlCache, get_cache_info, is_cache_stale


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
        self.cache = UrlCache(Path(self.temp_dir.name), ttl_seconds=3600)

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
