"""
Unit tests for schema-driven annotation tag generation in the grobid plugin.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v

@testCovers fastapi_app/plugins/grobid/config/__init__.py
@testCovers fastapi_app/plugins/grobid/config/annotation_tags_generator.py
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
                self.assertIn("bareAllowed", d, f"Missing 'bareAllowed' in {variant}")
                self.assertIn("variants", d, f"Missing 'variants' in {variant}")

    def test_one_entry_per_tag_name(self):
        """The old design had one flat entry per attribute-value combination
        (title[a], title[j], ...); the new design collapses these into a
        single entry per distinct tag name, with combinations moved into
        that entry's 'variants' list."""
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        tag_names = [t["tag"] for t in refs]
        self.assertEqual(len(tag_names), len(set(tag_names)), f"Duplicate tag entries: {tag_names}")

    def test_alphabetical_order(self):
        tags = self.get_annotation_tags()
        for variant, defs in tags.items():
            names = [d["tag"] for d in defs]
            self.assertEqual(names, sorted(names), f"{variant} chip list is not alphabetical")

    def test_returns_deep_copy(self):
        tags1 = self.get_annotation_tags()
        tags2 = self.get_annotation_tags()
        tags1["grobid.training.segmentation"][0]["tag"] = "MUTATED"
        self.assertNotEqual(
            tags2["grobid.training.segmentation"][0]["tag"], "MUTATED",
            "get_annotation_tags() must return a deep copy"
        )

    # --- grobid.training.segmentation ---

    def test_segmentation_note_has_place_variants(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.segmentation"]
        note = next(t for t in seg if t["tag"] == "note")
        variant_attrs = [v["attrs"] for v in note["variants"]]
        self.assertIn({"place": "footnote"}, variant_attrs)
        self.assertIn({"place": "headnote"}, variant_attrs)

    def test_segmentation_div_has_type_variants(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.segmentation"]
        div = next(t for t in seg if t["tag"] == "div")
        variant_values = {v["attrs"].get("type") for v in div["variants"]}
        for expected in ["acknowledgement", "toc", "annex", "funding", "conflict"]:
            self.assertIn(expected, variant_values)

    def test_segmentation_excludes_lb(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.segmentation"]
        self.assertNotIn("lb", {t["tag"] for t in seg})

    # --- grobid.training.references.referenceSegmenter ---

    def test_reference_segmenter_bibl_has_type_variants(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.references.referenceSegmenter"]
        bibl = next(t for t in seg if t["tag"] == "bibl")
        self.assertTrue(bibl["bareAllowed"])
        variant_values = {v["attrs"].get("type") for v in bibl["variants"]}
        self.assertIn("footnote", variant_values)

    def test_reference_segmenter_bibl_childtags_include_label(self):
        tags = self.get_annotation_tags()
        seg = tags["grobid.training.references.referenceSegmenter"]
        bibl = next(t for t in seg if t["tag"] == "bibl")
        self.assertIn("label", bibl["childTags"])

    # --- grobid.training.references ---

    def test_references_bibl_has_type_variants(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        bibl = next(t for t in refs if t["tag"] == "bibl")
        self.assertTrue(bibl["bareAllowed"])
        variant_values = {v["attrs"].get("type") for v in bibl["variants"]}
        for expected in ["footnote", "decision", "legislation"]:
            self.assertIn(expected, variant_values)

    def test_references_citedrange_units_collapsed_into_variants(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        cited_range_entries = [t for t in refs if t["tag"] == "citedRange"]
        self.assertEqual(len(cited_range_entries), 1, "citedRange must be a single collapsed entry")
        cited_range = cited_range_entries[0]
        self.assertFalse(cited_range["bareAllowed"], "citedRange@unit is required in the schema")
        units = {v["attrs"].get("unit") for v in cited_range["variants"]}
        for expected in ["section", "sub-section", "sentence", "number", "letter", "margin", "recital", "page"]:
            self.assertIn(expected, units)

    def test_references_orgname_has_type_variants(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        org_name = next(t for t in refs if t["tag"] == "orgName")
        self.assertTrue(org_name["bareAllowed"])
        variant_values = {v["attrs"].get("type") for v in org_name["variants"]}
        self.assertIn("court", variant_values)
        self.assertIn("collaboration", variant_values)

    def test_references_seg_signal_variant(self):
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        seg = next(t for t in refs if t["tag"] == "seg")
        variant_values = {v["attrs"].get("type") for v in seg["variants"]}
        self.assertIn("signal", variant_values)

    def test_references_ref_anaphoric_cataphoric_variants(self):
        """references_ref (anaphoric/cataphoric) is fully enumerated in the
        schema but had no chip at all in the old manual config — schema
        generation surfaces it as a new chip, which is intended."""
        tags = self.get_annotation_tags()
        refs = tags["grobid.training.references"]
        ref_entries = [t for t in refs if t["tag"] == "ref"]
        self.assertTrue(ref_entries, "ref tag should now be generated from the schema")
        ref = ref_entries[0]
        variant_values = {v["attrs"].get("type") for v in ref["variants"]}
        self.assertIn("anaphoric", variant_values)
        self.assertIn("cataphoric", variant_values)

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
        self.assertTrue(bibl_entries, "No bibl-tagged entry found in grobid.training.references")
        for entry in bibl_entries:
            child_tags = set(entry.get("childTags", []))
            missing = other_tags - child_tags
            self.assertEqual(
                missing, set(),
                f"childTags of '{entry['tag']}' is missing tags: {missing}"
            )


if __name__ == "__main__":
    unittest.main()
