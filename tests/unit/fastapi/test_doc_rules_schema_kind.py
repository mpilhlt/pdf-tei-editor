"""
Unit tests for the "schema" resource kind.

@testCovers fastapi_app/lib/doc_rules/schema_kind.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi_app.lib.doc_rules.schema_kind import SchemaKind

SCHEMA_LOCATION = "https://example.com/schema/tei.rng"

XML_RELAXNG = f"""<?xml version="1.0"?>
<?xml-model href="{SCHEMA_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"/>
"""

XML_XSD = """<?xml version="1.0"?>
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://example.com/ns https://example.com/schema/doc.xsd">
</root>
"""


class TestSchemaKindDiscover(unittest.TestCase):
    def setUp(self):
        self.kind = SchemaKind()

    def test_relaxng_schema_is_discovered(self):
        descriptors = self.kind.discover(XML_RELAXNG)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].kind, "schema")
        self.assertEqual(descriptors[0].url, SCHEMA_LOCATION)
        self.assertEqual(descriptors[0].format, "xml")
        self.assertEqual(descriptors[0].label, "Schema (RelaxNG)")

    def test_xsd_schema_is_not_discovered_v1_scope(self):
        # XSD schemas can expand into multiple included/imported files with
        # no single "original text" to present as one editable resource -
        # deferred (see the spec's Deferred section).
        self.assertEqual(self.kind.discover(XML_XSD), [])

    def test_no_schema_location_returns_empty(self):
        self.assertEqual(self.kind.discover("<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"), [])


class TestSchemaKindResolveOriginal(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        self.mock_settings = MagicMock()
        self.mock_settings.schema_cache_dir = self.cache_root

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_downloads_when_cache_is_stale_and_returns_content(self):
        kind = SchemaKind()
        with patch("fastapi_app.lib.doc_rules.schema_kind.get_settings", return_value=self.mock_settings), \
             patch("fastapi_app.lib.doc_rules.schema_kind.download_schema_file") as mock_download:
            def fake_download(location, cache_dir, cache_file):
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_file.write_text("<grammar/>", encoding="utf-8")
            mock_download.side_effect = fake_download

            result = kind.resolve_original(SCHEMA_LOCATION)

        self.assertEqual(result, "<grammar/>")
        mock_download.assert_called_once()

    def test_uses_fresh_cache_without_downloading(self):
        from fastapi_app.lib.core.schema_validator import get_schema_cache_info
        cache_dir, cache_file, _ = get_schema_cache_info(SCHEMA_LOCATION, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text("<grammar/>", encoding="utf-8")

        kind = SchemaKind()
        with patch("fastapi_app.lib.doc_rules.schema_kind.get_settings", return_value=self.mock_settings), \
             patch("fastapi_app.lib.doc_rules.schema_kind.download_schema_file") as mock_download:
            result = kind.resolve_original(SCHEMA_LOCATION)

        self.assertEqual(result, "<grammar/>")
        mock_download.assert_not_called()
