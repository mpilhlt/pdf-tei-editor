"""
Unit tests for generate_annotation_tags(): the chip list of the XML
editor's visual annotation mode, generated from a RelaxNG schema.

@testCovers fastapi_app/lib/utils/annotation_tags.py
"""

import os
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.utils.annotation_tags import (
    PALETTE,
    clear_annotation_tags_cache,
    generate_annotation_tags,
)

FIXTURE_RNG = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:a="http://relaxng.org/ns/compatibility/annotations/1.0">
  <start><ref name="p"/></start>
  <define name="p">
    <element name="p">
      <mixed>
        <zeroOrMore>
          <choice>
            <ref name="lb"/>
            <ref name="unclear"/>
            <ref name="choice"/>
          </choice>
        </zeroOrMore>
      </mixed>
    </element>
  </define>
  <define name="lb"><element name="lb"><empty/></element></define>
  <define name="unclear">
    <element name="unclear">
      <a:documentation>text that cannot be read with certainty</a:documentation>
      <optional><attribute name="reason"><choice><value>illegible</value><value>faded</value></choice></attribute></optional>
      <text/>
    </element>
  </define>
  <define name="choice">
    <element name="choice">
      <ref name="abbr"/>
      <ref name="expan"/>
    </element>
  </define>
  <define name="abbr"><element name="abbr"><text/></element></define>
  <define name="expan"><element name="expan"><mixed><zeroOrMore><ref name="lb"/></zeroOrMore></mixed></element></define>
</grammar>
"""


class TestGenerateAnnotationTags(unittest.TestCase):

    def setUp(self):
        clear_annotation_tags_cache()
        self.addCleanup(clear_annotation_tags_cache)
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.schema_path = Path(self.tmpdir.name) / "fixture.rng"
        self.schema_path.write_text(FIXTURE_RNG, encoding="utf-8")

    def _tags(self, **kwargs):
        return {t["tag"]: t for t in generate_annotation_tags(self.schema_path, "p", **kwargs)}

    def test_root_and_children_minus_exclude(self):
        self.assertEqual(sorted(self._tags(exclude={"lb"})), ["choice", "p", "unclear"])

    def test_exclude_is_removed_from_child_tags(self):
        self.assertEqual(self._tags(exclude={"lb"})["p"]["childTags"], ["choice", "unclear"])

    def test_expand_adds_children_of_named_chips(self):
        tags = self._tags(exclude={"lb"}, expand=["choice"])
        self.assertEqual(sorted(tags), ["abbr", "choice", "expan", "p", "unclear"])
        self.assertEqual(tags["expan"]["childTags"], [])

    def test_tag_data(self):
        unclear = self._tags()["unclear"]
        self.assertEqual(unclear["label"], "unclear")
        self.assertEqual(unclear["description"], "text that cannot be read with certainty")
        self.assertIn({"reason": "faded"}, [v["attrs"] for v in unclear["variants"]])
        self.assertTrue(unclear["bareAllowed"])

    def test_colors_distinct_and_from_palette(self):
        colors = [t["color"] for t in self._tags(expand=["choice"]).values()]
        self.assertEqual(len(colors), len(set(colors)))
        self.assertTrue(set(colors) <= set(PALETTE))

    def test_missing_schema_returns_empty(self):
        self.assertEqual(generate_annotation_tags(self.schema_path.with_name("missing.rng"), "p"), [])

    def test_unknown_root_returns_empty(self):
        self.assertEqual(generate_annotation_tags(self.schema_path, "div"), [])

    def test_result_is_a_copy(self):
        generate_annotation_tags(self.schema_path, "p")[0]["label"] = "changed"
        self.assertNotIn("changed", [t["label"] for t in generate_annotation_tags(self.schema_path, "p")])

    def test_regenerated_when_schema_changes(self):
        self.assertIn("unclear", self._tags())
        self.schema_path.write_text(FIXTURE_RNG.replace("<ref name=\"unclear\"/>", ""), encoding="utf-8")
        stat = self.schema_path.stat()
        os.utime(self.schema_path, (stat.st_atime, stat.st_mtime + 10))
        self.assertNotIn("unclear", self._tags())


if __name__ == "__main__":
    unittest.main()
