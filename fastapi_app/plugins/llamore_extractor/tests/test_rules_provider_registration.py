"""
Unit tests for LLamore's DocumentRulesProvider registration.

@testCovers fastapi_app/plugins/llamore_extractor/plugin.py
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document

TEI_LLAMORE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="llamore" type="extractor">
      <label type="variant-id">llamore-default</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""


class TestLlamoreRulesProvider(unittest.TestCase):
    def test_build_editorial_decl_entries_returns_empty(self):
        from fastapi_app.plugins.llamore_extractor.plugin import LlamoreRulesProvider

        provider = LlamoreRulesProvider()
        self.assertEqual(provider.build_editorial_decl_entries("llamore-default", mock.MagicMock()), [])

    @mock.patch("fastapi_app.plugins.llamore_extractor.plugin.get_schema_url")
    def test_get_schema_url_delegates(self, mock_get_url):
        from fastapi_app.plugins.llamore_extractor.plugin import LlamoreRulesProvider

        mock_get_url.return_value = "https://mpilhlt.github.io/llamore/schema/llamore-default.rng"
        provider = LlamoreRulesProvider()

        result = provider.get_schema_url("llamore-default")

        self.assertEqual(result, "https://mpilhlt.github.io/llamore/schema/llamore-default.rng")
        mock_get_url.assert_called_once_with("llamore-default")


class TestLLamorePluginRegistersProvider(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.llamore_extractor.plugin import LLamorePlugin, LlamoreRulesProvider
        self.LlamoreRulesProvider = LlamoreRulesProvider
        self.plugin = LLamorePlugin.__new__(LLamorePlugin)  # skip __init__ (config bootstrap)
        asyncio.run(self.plugin.initialize(mock.Mock()))

    def tearDown(self):
        asyncio.run(self.plugin.cleanup())

    def test_registers_llamore_as_a_provider(self):
        result = get_document_rules_provider_for_document(TEI_LLAMORE)
        self.assertIsNotNone(result)
        variant_id, provider = result
        self.assertEqual(variant_id, "llamore-default")
        self.assertIsInstance(provider, self.LlamoreRulesProvider)

    def test_cleanup_unregisters_the_provider(self):
        asyncio.run(self.plugin.cleanup())
        self.assertIsNone(get_document_rules_provider_for_document(TEI_LLAMORE))


if __name__ == "__main__":
    unittest.main()
