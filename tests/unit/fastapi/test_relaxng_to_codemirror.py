"""
Unit tests for RelaxNGParser.extract_tag_definitions() — the annotation-chip
extraction added on top of the existing CodeMirror-autocomplete parser.

@testCovers fastapi_app/lib/utils/relaxng_to_codemirror.py
"""

import tempfile
import unittest
import xml.etree.ElementTree as ET
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
          <ref name="note"/>
          <ref name="ptr"/>
          <ref name="quote"/>
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
            <group>
              <a:documentation>A footnote reference</a:documentation>
              <value>footnote</value>
            </group>
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

  <define name="note">
    <element name="note">
      <ref name="unitAttrs"/>
      <attribute name="resp">
        <a:documentation>Who is responsible for this note</a:documentation>
      </attribute>
      <text/>
    </element>
  </define>

  <define name="unitAttrs">
    <ref name="unitAttr"/>
  </define>

  <define name="unitAttr">
    <attribute name="unit">
      <choice>
        <group>
          <a:documentation>Word-level unit</a:documentation>
          <value>word</value>
        </group>
        <value>char</value>
      </choice>
    </attribute>
  </define>

  <define name="ptr">
    <element name="ptr">
      <attribute name="target"/>
      <empty/>
    </element>
  </define>

  <define name="quote">
    <element name="quote">
      <attribute name="source"/>
      <optional>
        <choice>
          <group>
            <a:documentation>direct quotation</a:documentation>
            <attribute name="type"><value>direct</value></attribute>
          </group>
          <group>
            <a:documentation>paraphrase</a:documentation>
            <attribute name="type"><value>paraphrase</value></attribute>
            <attribute name="cert"><value>medium</value></attribute>
          </group>
        </choice>
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

    def test_documented_freeform_attribute_does_not_raise_keyerror(self):
        # Regression: `resp` has an <a:documentation> but no enumerated
        # <value>s, so _extract_attributes() returns {'doc': ...} with no
        # 'values' key. extract_tag_definitions() must not raise KeyError.
        result = self.parser.extract_tag_definitions("root", set())
        note = result["note"]
        attr_names = [a["name"] for a in note["attributes"]]
        self.assertIn("resp", attr_names)
        resp_attr = next(a for a in note["attributes"] if a["name"] == "resp")
        self.assertIsNone(resp_attr["values"])

    def test_ref_nested_required_attribute_detected_as_required(self):
        # Regression: `unit` is a mandatory attribute of `note`, but it is
        # declared two <ref> levels deep (note -> unitAttrs -> unitAttr ->
        # <attribute name="unit">). bareAllowed must be False.
        result = self.parser.extract_tag_definitions("root", set())
        note = result["note"]
        self.assertFalse(note["bareAllowed"], "unit is required on note (declared via nested <ref>), so the bare tag must not be allowed")

    def test_value_doc_wrapper_group_not_mistaken_for_attribute_preset_group(self):
        # A <choice> whose <group>s wrap a single <value> (the required
        # documentation-wrapper shape, since <value> cannot carry an
        # <a:documentation> child directly) but contain no <attribute> at
        # all must not be treated as a set of correlated attribute-value
        # presets by _extract_grouped_presets - it must return None so the
        # independent-enumerated-attribute path in _extract_variants
        # handles it instead, still producing per-value variants.
        choice_xml = (
            '<choice xmlns="http://relaxng.org/ns/structure/1.0" '
            'xmlns:a="http://relaxng.org/ns/compatibility/annotations/1.0">'
            '<group><a:documentation>doc</a:documentation><value>a</value></group>'
            '<value>b</value>'
            '</choice>'
        )
        choice = ET.fromstring(choice_xml)
        self.assertIsNone(self.parser._extract_grouped_presets(choice))

    def test_bibl_type_choice_of_value_only_groups_yields_nonzero_variants(self):
        # bibl@type uses exactly this shape (one group-wrapped documented
        # value, one bare value) - end-to-end, it must still produce two
        # independent variants, not zero.
        result = self.parser.extract_tag_definitions("root", set())
        bibl = result["bibl"]
        self.assertEqual(len(bibl["variants"]), 2)

    def test_required_freeform_attribute_forces_bare_not_allowed(self):
        # Regression: `target` on `ptr` is required (no <optional>
        # wrapper) and freeform (no enumerated <value>s at all). The old
        # code did `if not values: continue` before checking
        # _is_attribute_required, so required-freeform attributes never
        # reached the required check and bareAllowed wrongly stayed True.
        result = self.parser.extract_tag_definitions("root", set())
        ptr = result["ptr"]
        self.assertEqual(ptr["variants"], [], "a freeform attribute must never produce dropdown variants")
        self.assertFalse(ptr["bareAllowed"], "target is required on ptr, so the bare tag must not be allowed")

    def test_grouped_preset_with_separate_required_attribute_forces_not_bare_allowed(self):
        # Regression: `quote`'s type/cert choice is wrapped in <optional>,
        # so the choice alone would allow bareAllowed=True - but `source`
        # is a separate, independently required attribute outside the
        # choice entirely. The grouped-preset branch used to return
        # immediately without checking for such "other" required
        # attributes, so bareAllowed wrongly came out True.
        result = self.parser.extract_tag_definitions("root", set())
        quote = result["quote"]
        variant_attrs = [v["attrs"] for v in quote["variants"]]
        self.assertIn({"type": "direct"}, variant_attrs)
        self.assertIn({"type": "paraphrase", "cert": "medium"}, variant_attrs)
        self.assertFalse(
            quote["bareAllowed"],
            "source is a separate required attribute outside the optional choice, "
            "so bareAllowed must be False even though the choice itself is optional",
        )

    def test_ref_nested_attribute_variant_documentation(self):
        # Regression: per-value documentation lookup must resolve <ref>
        # to find the <attribute> node declared in a referenced <define>.
        result = self.parser.extract_tag_definitions("root", set())
        note = result["note"]
        variant_attrs = [v["attrs"] for v in note["variants"]]
        self.assertIn({"unit": "word"}, variant_attrs)
        self.assertIn({"unit": "char"}, variant_attrs)
        word_variant = next(v for v in note["variants"] if v["attrs"] == {"unit": "word"})
        self.assertEqual(word_variant["description"], "Word-level unit")
        char_variant = next(v for v in note["variants"] if v["attrs"] == {"unit": "char"})
        self.assertIsNone(char_variant["description"])


class TestExtractTagDefinitionsRealSchema(unittest.TestCase):
    """
    Regression coverage against the real, vendored project schema, which
    exercises ref-nested required attributes and documented-but-freeform
    attributes that the synthetic fixture above did not originally cover.
    """

    REAL_SCHEMA = Path(__file__).parent.parent.parent.parent / "schema" / "rng" / "tei-bib.rng"

    def setUp(self):
        if not self.REAL_SCHEMA.exists():
            self.skipTest(f"real schema fixture not found: {self.REAL_SCHEMA}")
        self.parser = RelaxNGParser(include_global_attrs=False)
        self.parser.parse_file(str(self.REAL_SCHEMA))

    def test_extract_tag_definitions_does_not_raise_on_real_schema(self):
        # Regression for the KeyError('values') bug: bibl has several
        # documented-but-freeform attributes (e.g. xml:id, rend) that must
        # not crash extraction.
        result = self.parser.extract_tag_definitions("bibl", set())
        self.assertIn("bibl", result)

    def test_ref_nested_required_attribute_detected_as_required_real_schema(self):
        result = self.parser.extract_tag_definitions("bibl", set())
        self.assertIn("milestone", result, "milestone must be a valid child of bibl in this schema for the test to be meaningful")
        milestone = result["milestone"]
        self.assertFalse(
            milestone["bareAllowed"],
            "milestone's 'unit' attribute is required and declared two <ref> levels deep "
            "(tbibatt.milestoneUnit.attributes -> tbibatt.milestoneUnit.attribute.unit); "
            "the bare <milestone/> tag is not schema-valid",
        )
        variant_attrs = [v["attrs"] for v in milestone["variants"]]
        self.assertIn({"unit": "page"}, variant_attrs)


if __name__ == "__main__":
    unittest.main()
