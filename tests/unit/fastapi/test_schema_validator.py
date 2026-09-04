"""
Unit tests for schema_validator.py schema cache TTL behavior.

@testCovers fastapi_app/lib/core/schema_validator.py
"""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.core.schema_validator import (
    SCHEMA_CACHE_TTL_SECONDS,
    is_schema_cache_stale,
    validate,
)

RELAXNG_SCHEMA = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <element name="root">
      <text/>
    </element>
  </start>
</grammar>
"""

XML_WITH_RELAXNG_MODEL = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema/tei.rng" schematypens="http://relaxng.org/ns/structure/1.0"?>
<root xmlns="http://www.tei-c.org/ns/1.0">test</root>
"""


class TestIsSchemaCacheStale(unittest.TestCase):
    """Test the standalone TTL staleness check."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_file = Path(self.temp_dir.name) / "schema.rng"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_missing_file_is_stale(self):
        self.assertTrue(is_schema_cache_stale(self.cache_file))

    def test_freshly_written_file_is_not_stale(self):
        self.cache_file.write_text("data")
        self.assertFalse(is_schema_cache_stale(self.cache_file, ttl_seconds=3600))

    def test_file_older_than_ttl_is_stale(self):
        self.cache_file.write_text("data")
        old_time = time.time() - 7200  # 2 hours ago
        os.utime(self.cache_file, (old_time, old_time))
        self.assertTrue(is_schema_cache_stale(self.cache_file, ttl_seconds=3600))

    def test_file_within_ttl_is_not_stale(self):
        self.cache_file.write_text("data")
        recent_time = time.time() - 60  # 1 minute ago
        os.utime(self.cache_file, (recent_time, recent_time))
        self.assertFalse(is_schema_cache_stale(self.cache_file, ttl_seconds=3600))

    def test_default_ttl_is_one_hour(self):
        self.assertEqual(SCHEMA_CACHE_TTL_SECONDS, 3600)


class TestValidateRedownloadsStaleSchema(unittest.TestCase):
    """Integration test: validate() re-fetches a schema whose cache entry is stale."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        # Pre-populate the cache location the way get_schema_cache_info would.
        self.schema_cache_dir = self.cache_root / "example.com" / "schema"
        self.schema_cache_dir.mkdir(parents=True)
        self.schema_cache_file = self.schema_cache_dir / "tei.rng"
        self.schema_cache_file.write_text(RELAXNG_SCHEMA)

    def tearDown(self):
        self.temp_dir.cleanup()

    @patch("fastapi_app.lib.core.schema_validator.validate_with_timeout", return_value=[])
    @patch("fastapi_app.lib.core.schema_validator.download_schema_file")
    def test_redownloads_when_cache_is_stale(self, mock_download, _mock_validate):
        old_time = time.time() - 7200
        os.utime(self.schema_cache_file, (old_time, old_time))

        validate(XML_WITH_RELAXNG_MODEL, cache_root=self.cache_root)

        mock_download.assert_called_once()

    @patch("fastapi_app.lib.core.schema_validator.validate_with_timeout", return_value=[])
    @patch("fastapi_app.lib.core.schema_validator.download_schema_file")
    def test_skips_download_when_cache_is_fresh(self, mock_download, _mock_validate):
        recent_time = time.time() - 60
        os.utime(self.schema_cache_file, (recent_time, recent_time))

        validate(XML_WITH_RELAXNG_MODEL, cache_root=self.cache_root)

        mock_download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
