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
    extract_schema_locations,
    is_schema_cache_stale,
    register_schema_redirect,
    resolve_schema_location,
    unregister_schema_redirect,
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


class TestSchemaUrlRedirect(unittest.TestCase):
    """Test the generic schema URL redirect registry (#477 follow-up)."""

    def tearDown(self):
        # Registrations are process-global; never leak one between tests.
        unregister_schema_redirect("https://old.example.com/repo/")
        unregister_schema_redirect("https://old.example.com/repo/nested/")

    def test_unmatched_url_is_unchanged(self):
        url = "https://example.com/schema/tei.rng"
        self.assertEqual(resolve_schema_location(url), url)

    def test_matching_prefix_is_rewritten(self):
        register_schema_redirect("https://old.example.com/repo/", "https://new.example.com/repo2/")
        self.assertEqual(
            resolve_schema_location("https://old.example.com/repo/schema/tei.rng"),
            "https://new.example.com/repo2/schema/tei.rng"
        )

    def test_unregister_stops_redirecting(self):
        register_schema_redirect("https://old.example.com/repo/", "https://new.example.com/repo2/")
        unregister_schema_redirect("https://old.example.com/repo/")
        url = "https://old.example.com/repo/schema/tei.rng"
        self.assertEqual(resolve_schema_location(url), url)

    def test_longest_matching_prefix_wins(self):
        register_schema_redirect("https://old.example.com/repo/", "https://new.example.com/repo2/")
        register_schema_redirect("https://old.example.com/repo/nested/", "https://other.example.com/special/")
        self.assertEqual(
            resolve_schema_location("https://old.example.com/repo/nested/schema.rng"),
            "https://other.example.com/special/schema.rng"
        )
        self.assertEqual(
            resolve_schema_location("https://old.example.com/repo/schema.rng"),
            "https://new.example.com/repo2/schema.rng"
        )


class TestValidateAppliesSchemaRedirect(unittest.TestCase):
    """Integration test: validate() resolves a redirected schema location before fetching."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        register_schema_redirect("https://old.example.com/schema/", "https://example.com/schema/")
        # Pre-populate the cache at the *new* location, since that's what
        # get_schema_cache_info should now derive the path from.
        self.schema_cache_dir = self.cache_root / "example.com" / "schema"
        self.schema_cache_dir.mkdir(parents=True)
        self.schema_cache_file = self.schema_cache_dir / "tei.rng"
        self.schema_cache_file.write_text(RELAXNG_SCHEMA)
        recent_time = time.time() - 60
        os.utime(self.schema_cache_file, (recent_time, recent_time))

    def tearDown(self):
        self.temp_dir.cleanup()
        unregister_schema_redirect("https://old.example.com/schema/")

    @patch("fastapi_app.lib.core.schema_validator.validate_with_timeout", return_value=[])
    @patch("fastapi_app.lib.core.schema_validator.download_schema_file")
    def test_redirected_schema_uses_new_location_cache(self, mock_download, _mock_validate):
        xml_with_old_url = XML_WITH_RELAXNG_MODEL.replace(
            "https://example.com/schema/tei.rng", "https://old.example.com/schema/tei.rng"
        )

        validate(xml_with_old_url, cache_root=self.cache_root)

        # Cache already fresh under the new location, so no download is needed -
        # this only succeeds if the redirect was applied before the cache lookup.
        mock_download.assert_not_called()


class TestExtractSchemaLocationsSchemaRef(unittest.TestCase):
    """Test extract_schema_locations() falling back to encodingDesc/schemaRef."""

    def test_schema_ref_only(self):
        xml = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <schemaRef target="https://example.com/schema/tei.rng" type="RELAXNG"/>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        results = extract_schema_locations(xml)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["schemaLocation"], "https://example.com/schema/tei.rng")
        self.assertEqual(results[0]["type"], "relaxng")
        self.assertEqual(results[0]["namespace"], "http://www.tei-c.org/ns/1.0")

    def test_xml_model_pi_takes_precedence_over_schema_ref(self):
        xml = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema/pi.rng" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <schemaRef target="https://example.com/schema/ref.rng" type="RELAXNG"/>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        results = extract_schema_locations(xml)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["schemaLocation"], "https://example.com/schema/pi.rng")

    def test_no_schema_declaration_at_all(self):
        xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        self.assertEqual(extract_schema_locations(xml), [])


if __name__ == "__main__":
    unittest.main()
