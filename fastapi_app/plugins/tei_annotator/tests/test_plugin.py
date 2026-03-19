"""
Unit tests for the tei-annotator plugin.

@testCovers fastapi_app/plugins/tei_annotator/annotators/base.py
@testCovers fastapi_app/plugins/tei_annotator/annotators/reference.py
@testCovers fastapi_app/plugins/tei_annotator/annotators/footnote.py
@testCovers fastapi_app/plugins/tei_annotator/config.py
@testCovers fastapi_app/plugins/tei_annotator/utils.py
"""

import unittest
from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators import (
    FootnoteAnnotator,
    ReferenceAnnotator,
    get_annotator,
    ANNOTATORS,
)
from fastapi_app.plugins.tei_annotator.config import (
    LB_PLACEHOLDER,
    TEI_NS,
    get_annotators,
)
from fastapi_app.plugins.tei_annotator.utils import (
    bibl_to_plain_text,
    element_to_plain_text_with_lb,
    restore_lb,
)


class TestTextHelpers(unittest.TestCase):
    """Test lb-placeholder round-trip and plain-text extraction helpers."""

    def _bibl(self, inner_xml: str) -> etree._Element:
        """Parse a <bibl> element from an inner XML string."""
        return etree.fromstring(
            f'<bibl xmlns="{TEI_NS}">{inner_xml}</bibl>'.encode("utf-8")
        )

    def test_plain_bibl(self):
        """Bare text bibl returns text unchanged."""
        bibl = self._bibl("Doe, J. (2024). A paper.")
        self.assertEqual(bibl_to_plain_text(bibl), "Doe, J. (2024). A paper.")

    def test_lb_becomes_placeholder(self):
        """<lb/> is replaced with LB_PLACEHOLDER."""
        bibl = self._bibl("Doe, J.<lb/>Smith, A. (2024).")
        result = bibl_to_plain_text(bibl)
        self.assertIn(LB_PLACEHOLDER, result)
        self.assertNotIn("<lb", result)

    def test_annotation_tags_stripped(self):
        """Existing annotation elements are stripped; their text content is preserved."""
        bibl = self._bibl("<author>Doe, J.</author> (<date>2024</date>). <title>A paper</title>.")
        result = bibl_to_plain_text(bibl)
        self.assertIn("Doe, J.", result)
        self.assertIn("2024", result)
        self.assertIn("A paper", result)
        self.assertNotIn("<author", result)
        self.assertNotIn("<date", result)

    def test_restore_lb(self):
        """restore_lb converts placeholder back to <lb/>."""
        fragment = f"text{LB_PLACEHOLDER}more"
        self.assertEqual(restore_lb(fragment), "text<lb/>more")

    def test_restore_lb_no_placeholder(self):
        """restore_lb is a no-op when no placeholder is present."""
        fragment = "<author>Doe</author> text"
        self.assertEqual(restore_lb(fragment), fragment)

    def test_element_to_plain_text_strips_bibl(self):
        """element_to_plain_text_with_lb strips <bibl> wrappers."""
        list_bibl = etree.fromstring(
            f'<listBibl xmlns="{TEI_NS}">'
            "<bibl>Doe, J. (2024). Paper.</bibl>"
            "<bibl>Smith, A. (2023). Book.</bibl>"
            "</listBibl>".encode("utf-8")
        )
        result = element_to_plain_text_with_lb(list_bibl)
        self.assertIn("Doe, J.", result)
        self.assertIn("Smith, A.", result)
        self.assertNotIn("<bibl", result)

    def test_lb_round_trip(self):
        """Full round-trip: lb → placeholder → lb restored."""
        bibl = self._bibl("Line one<lb/>Line two")
        plain = bibl_to_plain_text(bibl)
        annotated = f"<author>Line one</author>{LB_PLACEHOLDER}Line two"
        restored = restore_lb(annotated)
        self.assertIn("<lb/>", restored)
        self.assertNotIn(LB_PLACEHOLDER, restored)


class TestAnnotatorSchemas(unittest.TestCase):
    """Validate annotator schema dict structure."""

    def test_reference_annotator_schema_has_elements(self):
        """Reference annotator schema contains expected bibliographic elements."""
        annotator = ReferenceAnnotator()
        schema = annotator.get_schema()
        self.assertIn("elements", schema)
        self.assertIn("rules", schema)
        tags = {e["tag"] for e in schema["elements"]}
        for expected in ("author", "title", "date", "publisher", "pubPlace"):
            self.assertIn(expected, tags, f"Expected tag '{expected}' in reference schema")

    def test_reference_annotator_schema_rules_non_empty(self):
        """Reference annotator schema has rules."""
        annotator = ReferenceAnnotator()
        schema = annotator.get_schema()
        self.assertTrue(len(schema["rules"]) >= 4)

    def test_reference_annotator_schema_title_has_level_attribute(self):
        """Reference annotator title element has level attribute."""
        annotator = ReferenceAnnotator()
        schema = annotator.get_schema()
        title = next(e for e in schema["elements"] if e["tag"] == "title")
        attr_names = {a["name"] for a in title.get("attributes", [])}
        self.assertIn("level", attr_names)

    def test_footnote_annotator_schema_has_bibl(self):
        """Footnote annotator schema contains bibl element."""
        annotator = FootnoteAnnotator()
        schema = annotator.get_schema()
        tags = {e["tag"] for e in schema["elements"]}
        self.assertIn("bibl", tags)

    def test_footnote_annotator_schema_has_label(self):
        """Footnote annotator schema contains label element."""
        annotator = FootnoteAnnotator()
        schema = annotator.get_schema()
        tags = {e["tag"] for e in schema["elements"]}
        self.assertIn("label", tags)

    def test_footnote_annotator_schema_rules_non_empty(self):
        """Footnote annotator schema has rules."""
        annotator = FootnoteAnnotator()
        schema = annotator.get_schema()
        self.assertTrue(len(schema["rules"]) >= 4)


class TestAnnotatorProperties(unittest.TestCase):
    """Test annotator instance properties and metadata."""

    def test_reference_annotator_metadata(self):
        """ReferenceAnnotator has correct id and target_tag."""
        annotator = ReferenceAnnotator()
        self.assertEqual(annotator.id, "reference")
        self.assertEqual(annotator.target_tag, "bibl")
        self.assertTrue(len(annotator.display_name) > 0)
        self.assertTrue(len(annotator.description) > 0)

    def test_footnote_annotator_metadata(self):
        """FootnoteAnnotator has correct id and target_tag."""
        annotator = FootnoteAnnotator()
        self.assertEqual(annotator.id, "footnote")
        self.assertEqual(annotator.target_tag, "bibl")
        self.assertTrue(len(annotator.display_name) > 0)
        self.assertTrue(len(annotator.description) > 0)


class TestAnnotatorApplyResult(unittest.TestCase):
    """Test annotator apply_result methods."""

    def _bibl(self, inner_xml: str) -> etree._Element:
        """Parse a <bibl> element from an inner XML string."""
        return etree.fromstring(
            f'<bibl xmlns="{TEI_NS}">{inner_xml}</bibl>'.encode("utf-8")
        )

    def test_reference_apply_result_with_empty_xml(self):
        """ReferenceAnnotator returns original element on empty annotated_xml."""
        annotator = ReferenceAnnotator()
        original = self._bibl("Doe, J. (2024). A paper.")
        result = annotator.apply_result(original, "")
        self.assertEqual(len(result), 1)
        self.assertIs(result[0], original)

    def test_reference_apply_result_with_valid_xml(self):
        """ReferenceAnnotator parses valid annotated XML into a new bibl."""
        annotator = ReferenceAnnotator()
        original = self._bibl("Doe, J. (2024). A paper.")
        annotated_xml = "<author>Doe, J.</author> (2024). <title>A paper</title>."
        result = annotator.apply_result(original, annotated_xml)
        self.assertEqual(len(result), 1)
        new_bibl = result[0]
        self.assertEqual(etree.QName(new_bibl.tag).localname, "bibl")
        children = list(new_bibl)
        self.assertTrue(len(children) > 0)

    def test_footnote_apply_result_with_empty_xml(self):
        """FootnoteAnnotator returns original element on empty annotated_xml."""
        annotator = FootnoteAnnotator()
        original = self._bibl("1. Doe, J. (2024). A paper.")
        result = annotator.apply_result(original, "")
        self.assertEqual(len(result), 1)
        self.assertIs(result[0], original)

    def test_footnote_apply_result_splits_bibls(self):
        """FootnoteAnnotator splits multiple references into separate bibl elements."""
        annotator = FootnoteAnnotator()
        original = self._bibl("1. Doe, J. (2024). Paper. 2. Smith, A. (2023). Book.")
        annotated_xml = (
            '<bibl><label>1.</label> Doe, J. (2024). Paper. </bibl>'
            '<bibl><label>2.</label> Smith, A. (2023). Book.</bibl>'
        )
        result = annotator.apply_result(original, annotated_xml)
        self.assertEqual(len(result), 2)
        for bibl in result:
            self.assertEqual(etree.QName(bibl.tag).localname, "bibl")


class TestAnnotatorRegistry(unittest.TestCase):
    """Test annotator registry functions."""

    def test_get_annotators_returns_list(self):
        """get_annotators returns a non-empty list."""
        annotators = get_annotators()
        self.assertIsInstance(annotators, list)
        self.assertTrue(len(annotators) >= 2)

    def test_get_annotator_by_id_reference(self):
        """get_annotator returns ReferenceAnnotator for 'reference' id."""
        annotator = get_annotator("reference")
        self.assertIsNotNone(annotator)
        self.assertIsInstance(annotator, ReferenceAnnotator)

    def test_get_annotator_by_id_footnote(self):
        """get_annotator returns FootnoteAnnotator for 'footnote' id."""
        annotator = get_annotator("footnote")
        self.assertIsNotNone(annotator)
        self.assertIsInstance(annotator, FootnoteAnnotator)

    def test_get_annotator_unknown_returns_none(self):
        """get_annotator returns None for unknown id."""
        annotator = get_annotator("nonexistent")
        self.assertIsNone(annotator)

    def test_annotators_all_have_required_attributes(self):
        """All registered annotators have required attributes."""
        for annotator in ANNOTATORS:
            self.assertTrue(hasattr(annotator, "id"))
            self.assertTrue(hasattr(annotator, "display_name"))
            self.assertTrue(hasattr(annotator, "description"))
            self.assertTrue(hasattr(annotator, "target_tag"))
            self.assertTrue(hasattr(annotator, "get_schema"))
            self.assertTrue(hasattr(annotator, "apply_result"))
            self.assertTrue(hasattr(annotator, "get_plain_text"))


if __name__ == "__main__":
    unittest.main()