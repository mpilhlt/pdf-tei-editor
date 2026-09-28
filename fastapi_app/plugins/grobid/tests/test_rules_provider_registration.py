"""
Unit tests for GROBID's DocumentRulesProvider registration.

@testCovers fastapi_app/plugins/grobid/plugin.py
@testCovers fastapi_app/plugins/grobid/annotation_rules.py
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document
from fastapi_app.plugins.grobid.annotation_rules import GrobidRulesProvider

TEI_GROBID = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="GROBID" type="extractor">
      <label type="variant-id">grobid.training.segmentation</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""


class TestGrobidRulesProvider(unittest.TestCase):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules.build_editorial_decl_entries")
    def test_build_editorial_decl_entries_delegates(self, mock_build):
        mock_build.return_value = [{"category": "primary", "refs": []}]
        provider = GrobidRulesProvider()
        cache = mock.MagicMock()

        result = provider.build_editorial_decl_entries("grobid.training.segmentation", cache)

        self.assertEqual(result, [{"category": "primary", "refs": []}])
        mock_build.assert_called_once_with("grobid.training.segmentation", cache)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules.get_schema_url")
    def test_get_schema_url_delegates(self, mock_get_url):
        mock_get_url.return_value = "https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"
        provider = GrobidRulesProvider()

        result = provider.get_schema_url("grobid.training.segmentation")

        self.assertEqual(result, "https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng")
        mock_get_url.assert_called_once_with("grobid.training.segmentation")


class TestGrobidPluginRegistersProvider(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin
        self.plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        context = mock.Mock()
        context.get_dependency.return_value = None  # no tei-wizard dependency in this test
        asyncio.run(self.plugin.initialize(context))

    def tearDown(self):
        asyncio.run(self.plugin.cleanup())

    def test_registers_grobid_as_a_provider(self):
        result = get_document_rules_provider_for_document(TEI_GROBID)
        self.assertIsNotNone(result)
        variant_id, provider = result
        self.assertEqual(variant_id, "grobid.training.segmentation")
        self.assertIsInstance(provider, GrobidRulesProvider)

    def test_cleanup_unregisters_the_provider(self):
        asyncio.run(self.plugin.cleanup())
        self.assertIsNone(get_document_rules_provider_for_document(TEI_GROBID))


if __name__ == "__main__":
    unittest.main()
