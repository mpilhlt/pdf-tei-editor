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



if __name__ == "__main__":
    unittest.main()
