"""
Unit tests for the "interpretation-ref" resource kind.

@testCovers fastapi_app/lib/doc_rules/interpretation_ref_kind.py
"""

import unittest
from unittest.mock import patch

from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind

XML_ONE_ENTRY_WITH_LABEL = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="data-correction" n="Data correction">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md" subtype="human" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_TWO_REFS_HUMAN_AND_MACHINE = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary">
      <p>
        <ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#intro" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L1-L10" subtype="machine" type="markdown"/>
      </p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_MACHINE_ONLY = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="footnote-annotation">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L20-L30" subtype="machine" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_SCHEMA_FRAGMENT = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="schema-fragment" n="Segmentation schema source">
      <p><ref target="https://github.com/mpilhlt/fossil/blob/sha1/schema/grobid.training.segmentation.rng" subtype="human" type="xml"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""


class TestInterpretationRefKindDiscover(unittest.TestCase):
    def setUp(self):
        self.kind = InterpretationRefKind()

    def test_label_falls_back_to_type_when_no_n(self):
        descriptors = self.kind.discover(XML_TWO_REFS_HUMAN_AND_MACHINE)
        self.assertEqual(descriptors[0].label, "primary")

    def test_label_uses_n_when_present(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(descriptors[0].label, "Data correction")

    def test_picks_human_ref_when_both_present(self):
        descriptors = self.kind.discover(XML_TWO_REFS_HUMAN_AND_MACHINE)
        self.assertEqual(len(descriptors), 1)
        self.assertTrue(descriptors[0].url.endswith("#intro"))

    def test_related_urls_includes_both_human_and_machine_refs(self):
        descriptors = self.kind.discover(XML_TWO_REFS_HUMAN_AND_MACHINE)
        self.assertEqual(len(descriptors[0].related_urls), 2)
        self.assertTrue(any(u.endswith("#intro") for u in descriptors[0].related_urls))
        self.assertTrue(any(u.endswith("#L1-L10") for u in descriptors[0].related_urls))

    def test_falls_back_to_machine_ref_when_no_human_ref(self):
        descriptors = self.kind.discover(XML_MACHINE_ONLY)
        self.assertEqual(len(descriptors), 1)
        self.assertTrue(descriptors[0].url.endswith("#L20-L30"))
        self.assertEqual(descriptors[0].related_urls, [descriptors[0].url])

    def test_kind_and_format(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(descriptors[0].kind, "interpretation-ref")
        self.assertEqual(descriptors[0].format, "markdown")

    def test_no_editorial_decl_returns_empty(self):
        self.assertEqual(self.kind.discover("<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"), [])

    def test_schema_fragment_entry_resolves_to_xml_format_and_configured_label(self):
        descriptors = self.kind.discover(XML_SCHEMA_FRAGMENT)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].format, "xml")
        self.assertEqual(descriptors[0].label, "Segmentation schema source")
        self.assertTrue(descriptors[0].url.endswith("grobid.training.segmentation.rng"))


class TestInterpretationRefKindResolveOriginal(unittest.TestCase):
    def test_delegates_to_fetch_rule_excerpt(self):
        kind = InterpretationRefKind()
        with patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.fetch_rule_excerpt",
            return_value="fetched text",
        ) as mock_fetch:
            result = kind.resolve_original("https://example.com/rules.md")
        self.assertEqual(result, "fetched text")
        mock_fetch.assert_called_once()
        self.assertEqual(mock_fetch.call_args[0][0], "https://example.com/rules.md")
