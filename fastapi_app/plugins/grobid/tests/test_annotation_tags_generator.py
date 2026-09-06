"""
Unit tests for generate_annotation_tags() — builds one variant's chip
list from its RelaxNG schema.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py -v

@testCovers fastapi_app/plugins/grobid/config/annotation_tags_generator.py
"""

import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.plugins.grobid.config.annotation_tags_generator import generate_annotation_tags

FIXTURE_RNG = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:a="http://relaxng.org/ns/compatibility/annotations/1.0"
  ns="http://example.org/ns">
  <start><ref name="text"/></start>
  <define name="text">
    <element name="text">
      <zeroOrMore>
        <choice>
          <ref name="div"/>
          <ref name="page"/>
          <ref name="lb"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="div">
    <element name="div">
      <optional>
        <attribute name="type">
          <choice><value>toc</value><value>annex</value></choice>
        </attribute>
      </optional>
      <text/>
    </element>
  </define>
  <define name="page">
    <element name="page"><text/></element>
  </define>
  <define name="lb">
    <element name="lb"><empty/></element>
  </define>
</grammar>
"""


class TestGenerateAnnotationTags(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.schema_path = Path(self.tmpdir.name) / "grobid.training.segmentation.rng"
        self.schema_path.write_text(FIXTURE_RNG, encoding="utf-8")

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_unknown_variant_returns_empty(self):
        tags = generate_annotation_tags("no.such.variant", self.schema_path)
        self.assertEqual(tags, [])

    def test_missing_schema_file_returns_empty(self):
        tags = generate_annotation_tags(
            "grobid.training.segmentation", Path(self.tmpdir.name) / "missing.rng"
        )
        self.assertEqual(tags, [])

    def test_generates_expected_tags_excluding_lb(self):
        tags = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        tag_names = {t["tag"] for t in tags}
        self.assertEqual(tag_names, {"text", "div", "page"})

    def test_alphabetical_order(self):
        tags = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        self.assertEqual([t["tag"] for t in tags], sorted(t["tag"] for t in tags))

    def test_colors_assigned_and_distinct_within_variant(self):
        tags = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        colors = [t["color"] for t in tags]
        self.assertEqual(len(colors), len(set(colors)), "colors must be distinct within one variant")
        for c in colors:
            self.assertRegex(c, r"^#[0-9a-fA-F]{6}$")

    def test_color_deterministic_across_calls(self):
        tags1 = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        tags2 = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        colors1 = {t["tag"]: t["color"] for t in tags1}
        colors2 = {t["tag"]: t["color"] for t in tags2}
        self.assertEqual(colors1, colors2)

    def test_div_has_variants_and_is_bare_allowed(self):
        tags = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        div = next(t for t in tags if t["tag"] == "div")
        self.assertTrue(div["bareAllowed"])
        variant_attrs = [v["attrs"] for v in div["variants"]]
        self.assertIn({"type": "toc"}, variant_attrs)
        self.assertIn({"type": "annex"}, variant_attrs)

    def test_page_has_no_variants(self):
        tags = generate_annotation_tags("grobid.training.segmentation", self.schema_path)
        page = next(t for t in tags if t["tag"] == "page")
        self.assertEqual(page["variants"], [])
        self.assertTrue(page["bareAllowed"])


if __name__ == "__main__":
    unittest.main()
