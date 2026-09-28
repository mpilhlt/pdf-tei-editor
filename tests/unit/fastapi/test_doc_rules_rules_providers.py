"""
Unit tests for the document rules registry's extractor-provider registry.

@testCovers fastapi_app/lib/doc_rules/rules_providers.py
"""

import unittest

from fastapi_app.lib.doc_rules.rules_providers import (
    extract_extractor_provenance,
    get_document_rules_provider_for_document,
    register_document_rules_provider,
    unregister_document_rules_provider,
)

TEI_WITH_PROVENANCE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="GROBID" type="extractor">
      <label type="variant-id">grobid.training.segmentation</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""

TEI_WITHOUT_VARIANT_ID = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="GROBID" type="extractor"/>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""

TEI_WITHOUT_APP_INFO = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc/></teiHeader>
</TEI>"""


class TestExtractExtractorProvenance(unittest.TestCase):
    def test_reads_ident_and_variant_id(self):
        self.assertEqual(
            extract_extractor_provenance(TEI_WITH_PROVENANCE),
            ("GROBID", "grobid.training.segmentation"),
        )

    def test_returns_none_when_variant_id_missing(self):
        self.assertIsNone(extract_extractor_provenance(TEI_WITHOUT_VARIANT_ID))

    def test_returns_none_when_no_application_element(self):
        self.assertIsNone(extract_extractor_provenance(TEI_WITHOUT_APP_INFO))

    def test_returns_none_for_malformed_xml(self):
        self.assertIsNone(extract_extractor_provenance("<TEI><unclosed></TEI>"))


class TestProviderRegistry(unittest.TestCase):
    def tearDown(self):
        unregister_document_rules_provider("GROBID")
        unregister_document_rules_provider("TEST-IDENT")

    def test_unregistered_ident_returns_none(self):
        self.assertIsNone(get_document_rules_provider_for_document(TEI_WITH_PROVENANCE))

    def test_registered_provider_is_found_by_ident(self):
        provider = object()
        register_document_rules_provider("GROBID", "grobid", provider)

        result = get_document_rules_provider_for_document(TEI_WITH_PROVENANCE)

        self.assertIsNotNone(result)
        variant_id, found_provider = result
        self.assertEqual(variant_id, "grobid.training.segmentation")
        self.assertIs(found_provider, provider)

    def test_unregister_then_lookup_returns_none(self):
        register_document_rules_provider("TEST-IDENT", "test-plugin", object())
        unregister_document_rules_provider("TEST-IDENT")

        tei = TEI_WITH_PROVENANCE.replace("GROBID", "TEST-IDENT")
        self.assertIsNone(get_document_rules_provider_for_document(tei))

    def test_no_provenance_returns_none_even_if_a_provider_is_registered(self):
        register_document_rules_provider("GROBID", "grobid", object())
        self.assertIsNone(get_document_rules_provider_for_document(TEI_WITHOUT_APP_INFO))


if __name__ == "__main__":
    unittest.main()
