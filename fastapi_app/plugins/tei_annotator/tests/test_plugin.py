"""
Unit tests for the tei-annotator plugin.

@testCovers fastapi_app/plugins/tei_annotator/extractor.py
@testCovers fastapi_app/plugins/tei_annotator/config.py
"""

import unittest
from lxml import etree

from fastapi_app.plugins.tei_annotator.config import (
    LB_PLACEHOLDER,
    TEI_NS,
    VARIANT_REFERENCES,
    VARIANT_SEGMENTER,
    bibl_to_plain_text,
    build_references_schema,
    build_segmenter_schema,
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


class TestSchemas(unittest.TestCase):
    """Validate schema dict structure."""

    def test_references_schema_has_elements(self):
        schema = build_references_schema()
        self.assertIn("elements", schema)
        self.assertIn("rules", schema)
        tags = {e["tag"] for e in schema["elements"]}
        for expected in ("author", "title", "date", "publisher", "pubPlace"):
            self.assertIn(expected, tags, f"Expected tag '{expected}' in references schema")

    def test_references_schema_rules_non_empty(self):
        schema = build_references_schema()
        self.assertTrue(len(schema["rules"]) >= 4)

    def test_segmenter_schema_has_bibl(self):
        schema = build_segmenter_schema()
        tags = {e["tag"] for e in schema["elements"]}
        self.assertIn("bibl", tags)

    def test_segmenter_schema_rules_non_empty(self):
        schema = build_segmenter_schema()
        self.assertTrue(len(schema["rules"]) >= 4)

    def test_references_schema_title_has_level_attribute(self):
        schema = build_references_schema()
        title = next(e for e in schema["elements"] if e["tag"] == "title")
        attr_names = {a["name"] for a in title.get("attributes", [])}
        self.assertIn("level", attr_names)


class TestExtractorMetadata(unittest.TestCase):
    """Test extractor get_info() and is_available()."""

    def test_get_info_structure(self):
        from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor

        info = TeiAnnotatorExtractor.get_info()
        self.assertEqual(info["id"], "tei-annotator")
        self.assertIn("xml", info["input"])
        self.assertIn("tei-document", info["output"])
        options = info["options"]
        self.assertIn("variant_id", options)
        self.assertNotIn("provider", options)
        self.assertIn("model", options)
        self.assertIn("batch_size", options)

    def test_model_option_uses_groups(self):
        from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor

        info = TeiAnnotatorExtractor.get_info()
        model_option = info["options"]["model"]
        self.assertIn("groups", model_option)
        self.assertNotIn("options", model_option)
        self.assertTrue(len(model_option["groups"]) > 0)
        first_group = model_option["groups"][0]
        self.assertIn("label", first_group)
        self.assertIn("options", first_group)

    def test_batch_size_has_depends(self):
        from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor

        info = TeiAnnotatorExtractor.get_info()
        batch = info["options"]["batch_size"]
        self.assertIn("depends", batch)
        self.assertEqual(batch["depends"]["variant_id"], VARIANT_REFERENCES)

    def test_variant_options_include_both_variants(self):
        from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor

        info = TeiAnnotatorExtractor.get_info()
        variant_options = info["options"]["variant_id"]["options"]
        self.assertIn(VARIANT_REFERENCES, variant_options)
        self.assertIn(VARIANT_SEGMENTER, variant_options)

    def test_is_available_false_without_config(self):
        from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor
        from unittest.mock import patch

        with patch(
            "fastapi_app.plugins.tei_annotator.extractor.get_config"
        ) as mock_cfg:
            mock_cfg.return_value.get.return_value = None
            self.assertFalse(TeiAnnotatorExtractor.is_available())

    def test_is_available_true_with_url(self):
        from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor
        from unittest.mock import patch

        with patch(
            "fastapi_app.plugins.tei_annotator.extractor.get_config"
        ) as mock_cfg:
            mock_cfg.return_value.get.return_value = "http://localhost:8099"
            self.assertTrue(TeiAnnotatorExtractor.is_available())


if __name__ == "__main__":
    unittest.main()
