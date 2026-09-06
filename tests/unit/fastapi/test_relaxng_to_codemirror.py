"""
Unit tests for RelaxNGParser.extract_tag_definitions() — the annotation-chip
extraction added on top of the existing CodeMirror-autocomplete parser.

@testCovers fastapi_app/lib/utils/relaxng_to_codemirror.py
"""

import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.utils.relaxng_to_codemirror import RelaxNGParser

FIXTURE_RNG = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:a="http://relaxng.org/ns/compatibility/annotations/1.0"
  ns="http://example.org/ns">

  <start><ref name="root"/></start>

  <define name="root">
    <element name="root">
      <zeroOrMore>
        <choice>
          <ref name="bibl"/>
          <ref name="author"/>
          <ref name="title"/>
          <ref name="idno"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>

  <define name="bibl">
    <element name="bibl">
      <a:documentation>An individual bibliographic reference</a:documentation>
      <optional>
        <attribute name="type">
          <choice>
            <value>footnote<a:documentation>A footnote reference</a:documentation></value>
            <value>decision</value>
          </choice>
        </attribute>
      </optional>
      <zeroOrMore>
        <choice>
          <ref name="author"/>
          <ref name="title"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>

  <define name="author">
    <element name="author">
      <text/>
    </element>
  </define>

  <define name="idno">
    <element name="idno">
      <optional>
        <attribute name="type"/>
      </optional>
      <text/>
    </element>
  </define>

  <define name="title">
    <element name="title">
      <optional>
        <attribute name="key"/>
      </optional>
      <choice>
        <group>
          <a:documentation>Article or chapter title</a:documentation>
          <attribute name="level"><value>a</value></attribute>
        </group>
        <group>
          <a:documentation>Title of a statute</a:documentation>
          <attribute name="level"><value>m</value></attribute>
          <attribute name="type"><value>legislation</value></attribute>
        </group>
      </choice>
    </element>
  </define>

</grammar>
"""


class TestExtractTagDefinitions(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.schema_path = Path(self.tmpdir.name) / "fixture.rng"
        self.schema_path.write_text(FIXTURE_RNG, encoding="utf-8")
        self.parser = RelaxNGParser(include_global_attrs=False)
        self.parser.parse_file(str(self.schema_path))

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_root_and_children_included(self):
        result = self.parser.extract_tag_definitions("root", set())
        self.assertIn("root", result)
        self.assertIn("bibl", result)
        self.assertIn("author", result)
        self.assertIn("title", result)
        self.assertIn("idno", result)

    def test_exclude_removes_tag(self):
        result = self.parser.extract_tag_definitions("root", {"author"})
        self.assertNotIn("author", result)
        self.assertIn("bibl", result)

    def test_element_level_description(self):
        result = self.parser.extract_tag_definitions("root", set())
        self.assertEqual(result["bibl"]["description"], "An individual bibliographic reference")

    def test_independent_enumerated_attribute_becomes_variants(self):
        result = self.parser.extract_tag_definitions("root", set())
        bibl = result["bibl"]
        variant_attrs = [v["attrs"] for v in bibl["variants"]]
        self.assertIn({"type": "footnote"}, variant_attrs)
        self.assertIn({"type": "decision"}, variant_attrs)
        self.assertTrue(bibl["bareAllowed"], "type is optional on bibl, so the bare tag must be allowed")

    def test_variant_value_documentation(self):
        result = self.parser.extract_tag_definitions("root", set())
        bibl = result["bibl"]
        footnote_variant = next(v for v in bibl["variants"] if v["attrs"] == {"type": "footnote"})
        self.assertEqual(footnote_variant["description"], "A footnote reference")
        decision_variant = next(v for v in bibl["variants"] if v["attrs"] == {"type": "decision"})
        self.assertIsNone(decision_variant["description"])

    def test_freeform_attribute_not_a_variant_but_listed_in_attributes(self):
        result = self.parser.extract_tag_definitions("root", set())
        idno = result["idno"]
        self.assertEqual(idno["variants"], [])
        self.assertTrue(idno["bareAllowed"])
        attr_names = [a["name"] for a in idno["attributes"]]
        self.assertIn("type", attr_names)
        type_attr = next(a for a in idno["attributes"] if a["name"] == "type")
        self.assertIsNone(type_attr["values"])

    def test_grouped_choice_becomes_correlated_presets(self):
        result = self.parser.extract_tag_definitions("root", set())
        title = result["title"]
        self.assertFalse(title["bareAllowed"], "title's choice is a required direct child, not wrapped in <optional>")
        variant_attrs = [v["attrs"] for v in title["variants"]]
        self.assertIn({"level": "a"}, variant_attrs)
        self.assertIn({"level": "m", "type": "legislation"}, variant_attrs)
        legislation_variant = next(v for v in title["variants"] if v["attrs"] == {"level": "m", "type": "legislation"})
        self.assertEqual(legislation_variant["description"], "Title of a statute")

    def test_children_derived_from_content_model(self):
        result = self.parser.extract_tag_definitions("root", set())
        self.assertEqual(sorted(result["bibl"]["children"]), ["author", "title"])

    def test_missing_root_returns_empty(self):
        result = self.parser.extract_tag_definitions("nonexistent", set())
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
