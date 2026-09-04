"""
Unit tests for annotation tag config in the grobid plugin.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v

@testCovers fastapi_app/plugins/grobid/config/annotation_tags.py
"""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))


class TestGetAnnotationTags(unittest.TestCase):

    def setUp(self):
        from fastapi_app.plugins.grobid.config import get_annotation_tags
        self.get_annotation_tags = get_annotation_tags

    def test_returns_dict_with_three_variants(self):
        tags = self.get_annotation_tags()
        self.assertIn("grobid.training.segmentation", tags)
        self.assertIn("grobid.training.references.referenceSegmenter", tags)
        self.assertIn("grobid.training.references", tags)

    def test_each_tag_has_required_fields(self):
        tags = self.get_annotation_tags()
        for variant, defs in tags.items():
            for d in defs:
                self.assertIn("tag", d, f"Missing 'tag' in {variant}")
                self.assertIn("label", d, f"Missing 'label' in {variant}")
                self.assertIn("color", d, f"Missing 'color' in {variant}")
                self.assertIn("priority", d, f"Missing 'priority' in {variant}")

    def test_default_attributes_note_footnote(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.segmentation"]
        footnote = next(t for t in seg if t["label"] == "note[foot]")
        self.assertEqual(footnote["defaultAttributes"], {"place": "footnote"})

    def test_default_attributes_div_acknowledgement(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.segmentation"]
        ack = next(t for t in seg if t["label"] == "acknowledgement")
        self.assertEqual(ack["defaultAttributes"], {"type": "acknowledgement"})
        self.assertEqual(ack["tag"], "div")

    def test_returns_deep_copy(self):
        tags1 = self.get_annotation_tags()
        tags2 = self.get_annotation_tags()
        tags1["grobid.training.segmentation"][0]["tag"] = "MUTATED"
        self.assertNotEqual(
            tags2["grobid.training.segmentation"][0]["tag"], "MUTATED",
            "get_annotation_tags() must return a deep copy"
        )

    # --- Legal citation annotation tags (grobid.training.references) ---

    def test_default_attributes_bibl_plain_in_references(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        bibl = next(t for t in refs if t["label"] == "bibl")
        self.assertIsNone(bibl["defaultAttributes"])
        self.assertEqual(bibl["tag"], "bibl")

    def test_default_attributes_bibl_footnote_in_references(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        bibl_footnote = next(t for t in refs if t["label"] == "bibl[footnote]")
        self.assertEqual(bibl_footnote["defaultAttributes"], {"type": "footnote"})
        self.assertEqual(bibl_footnote["tag"], "bibl")

    def test_default_attributes_bibl_decision_in_references(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        bibl_decision = next(t for t in refs if t["label"] == "bibl[decision]")
        self.assertEqual(bibl_decision["defaultAttributes"], {"type": "decision"})
        self.assertEqual(bibl_decision["tag"], "bibl")

    def test_default_attributes_bibl_legislation_in_references(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        bibl_legislation = next(t for t in refs if t["label"] == "bibl[legislation]")
        self.assertEqual(bibl_legislation["defaultAttributes"], {"type": "legislation"})
        self.assertEqual(bibl_legislation["tag"], "bibl")

    def test_default_attributes_title_legislation(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        title_legislation = next(t for t in refs if t["label"] == "title[legislation]")
        self.assertEqual(
            title_legislation["defaultAttributes"], {"level": "m", "type": "legislation"}
        )
        self.assertEqual(title_legislation["tag"], "title")

    def test_default_attributes_title_casename(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        title_casename = next(t for t in refs if t["label"] == "title[caseName]")
        self.assertEqual(
            title_casename["defaultAttributes"], {"level": "a", "type": "caseName"}
        )
        self.assertEqual(title_casename["tag"], "title")

    def test_date_type_options_collapsed_into_single_chip(self):
        """date[decision]/date[enacted] are not separate chips; the single
        'date' entry exposes them as an in-popup 'type' dropdown, like idno."""
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        date_entries = [t for t in refs if t["tag"] == "date"]
        self.assertEqual(len(date_entries), 1, "date must be a single collapsed chip")
        date = date_entries[0]
        self.assertEqual(date["label"], "date")
        self.assertIsNone(date["defaultAttributes"])
        self.assertEqual(date["attributes"][0]["name"], "type")
        for expected in ["decision", "enacted"]:
            self.assertIn(expected, date["attributes"][0]["values"])

    def test_default_attributes_orgname_court(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        orgname_court = next(t for t in refs if t["label"] == "orgName[court]")
        self.assertEqual(orgname_court["defaultAttributes"], {"type": "court"})
        self.assertEqual(orgname_court["tag"], "orgName")

    def test_cited_range_units_collapsed_into_single_chip(self):
        """citedRange's 8 @unit values are not separate chips; a single
        'citedRange' entry exposes them as an in-popup 'unit' dropdown,
        like idno."""
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        units = [
            "section", "sub-section", "sentence", "number",
            "letter", "margin", "recital", "page",
        ]
        cited_range_entries = [t for t in refs if t["tag"] == "citedRange"]
        self.assertEqual(len(cited_range_entries), 1, "citedRange must be a single collapsed chip")
        cited_range = cited_range_entries[0]
        self.assertEqual(cited_range["label"], "citedRange")
        self.assertIsNone(cited_range["defaultAttributes"])
        self.assertEqual(cited_range["attributes"][0]["name"], "unit")
        self.assertEqual(cited_range["attributes"][0]["values"], units)

    def test_seg_signal_in_references(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        seg_signal = next(t for t in refs if t["label"] == "seg[signal]")
        self.assertEqual(seg_signal["tag"], "seg")
        self.assertEqual(seg_signal["defaultAttributes"], {"type": "signal"})

    def test_idno_attributes_include_legal_values(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        idno = next(t for t in refs if t["label"] == "idno")
        values = idno["attributes"][0]["values"]
        for expected in ["DOI", "arXiv", "report", "docket", "ECLI", "CELEX"]:
            self.assertIn(expected, values)

    def test_default_attributes_bibl_decision_in_reference_segmenter(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.references.referenceSegmenter"]
        bibl_decision = next(t for t in seg if t["label"] == "bibl[decision]")
        self.assertEqual(bibl_decision["defaultAttributes"], {"type": "decision"})
        self.assertEqual(bibl_decision["tag"], "bibl")
        self.assertEqual(bibl_decision["childTags"], ["label"])

    def test_default_attributes_bibl_legislation_in_reference_segmenter(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.references.referenceSegmenter"]
        bibl_legislation = next(t for t in seg if t["label"] == "bibl[legislation]")
        self.assertEqual(bibl_legislation["defaultAttributes"], {"type": "legislation"})
        self.assertEqual(bibl_legislation["tag"], "bibl")
        self.assertEqual(bibl_legislation["childTags"], ["label"])

    def test_bibl_childtags_cover_all_references_variant_tags(self):
        """Every bibl-tagged entry in grobid.training.references must list
        every other distinct tag used in that variant as a childTag, so the
        split-vs-wrap logic never mistakenly splits a bibl. This is a
        structural check (derived from the variant's own data), not a
        hardcoded list, so it stays correct as the variant's tag set grows.
        """
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        other_tags = {t["tag"] for t in refs if t["tag"] != "bibl"}
        bibl_entries = [t for t in refs if t["tag"] == "bibl"]
        self.assertTrue(
            bibl_entries, "No bibl-tagged entries found in grobid.training.references"
        )
        for entry in bibl_entries:
            child_tags = set(entry.get("childTags", []))
            missing = other_tags - child_tags
            self.assertEqual(
                missing, set(),
                f"childTags of '{entry['label']}' is missing tags: {missing}"
            )


if __name__ == "__main__":
    unittest.main()
