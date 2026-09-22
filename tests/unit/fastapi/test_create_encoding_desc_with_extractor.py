"""
Unit tests for create_encoding_desc_with_extractor()'s editorialDecl output.

@testCovers fastapi_app/lib/utils/tei_utils.py
"""

import unittest

from lxml import etree

from fastapi_app.lib.utils.tei_utils import create_encoding_desc_with_extractor

NS = {"tei": "http://www.tei-c.org/ns/1.0"}


class TestEditorialDeclEntries(unittest.TestCase):
    def _build(self, editorial_decl_entries=None):
        encoding_desc = create_encoding_desc_with_extractor(
            timestamp="2026-01-01T00:00:00Z",
            extractor_name="GROBID",
            extractor_ident="GROBID",
            variant_id="grobid.training.segmentation",
            editorial_decl_entries=editorial_decl_entries,
        )
        # create_encoding_desc_with_extractor returns an unnamespaced element;
        # wrap it in a namespaced root so XPath with the tei: prefix resolves.
        wrapper = etree.Element("{http://www.tei-c.org/ns/1.0}teiHeader")
        wrapper.append(encoding_desc)
        return wrapper

    def test_no_editorial_decl_when_entries_omitted(self):
        header = self._build(editorial_decl_entries=None)
        self.assertIsNone(header.find(".//editorialDecl"))

    def test_no_editorial_decl_when_entries_empty(self):
        header = self._build(editorial_decl_entries=[])
        self.assertIsNone(header.find(".//editorialDecl"))

    def test_editorial_decl_precedes_app_info(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
            ]},
        ])
        encoding_desc = header.find("encodingDesc")
        children = list(encoding_desc)
        self.assertEqual(children[0].tag, "editorialDecl")
        self.assertEqual(children[1].tag, "appInfo")

    def test_one_interpretation_per_entry(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
            ]},
            {"category": "footnote-annotation", "refs": [
                {"target": "https://example.com/g.md#L1-L2", "content_type": "markdown", "subtype": "machine"},
            ]},
        ])
        interpretations = header.findall(".//editorialDecl/interpretation")
        self.assertEqual(len(interpretations), 2)
        self.assertEqual(interpretations[0].get("type"), "primary")
        self.assertEqual(interpretations[1].get("type"), "footnote-annotation")

    def test_two_refs_per_interpretation_carry_subtype(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
                {"target": "https://example.com/g.md#L1-L20", "content_type": "markdown", "subtype": "machine"},
            ]},
        ])
        refs = header.findall(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0].get("target"), "https://example.com/g.md#seg")
        self.assertEqual(refs[0].get("subtype"), "human")
        self.assertEqual(refs[1].get("target"), "https://example.com/g.md#L1-L20")
        self.assertEqual(refs[1].get("subtype"), "machine")

    def test_ref_carries_target_and_content_type(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
            ]},
        ])
        ref = header.find(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(ref.get("target"), "https://example.com/g.md#seg")
        self.assertEqual(ref.get("type"), "markdown")

    def test_ref_without_content_type(self):
        """Test that a None content_type doesn't break or add an empty type attribute."""
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": None, "subtype": "human"},
            ]},
        ])
        ref = header.find(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(ref.get("target"), "https://example.com/g.md#seg")
        self.assertIsNone(ref.get("type"))


if __name__ == "__main__":
    unittest.main()
