# Annotation Chip Schema-Driven Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-curated `ANNOTATION_TAGS` dict in `fastapi_app/plugins/grobid/config/annotation_tags.py` with a generator that builds the annotation chip palette directly from the cached RelaxNG schemas, and redesign the chip UI from "one flat chip per attribute-value variant" to "one chip per tag, with a split-button dropdown for attribute variants."

**Architecture:** A new `extract_tag_definitions()` method on the existing `RelaxNGParser` (`fastapi_app/lib/utils/relaxng_to_codemirror.py`) pulls per-tag description, attributes, and enumerated attribute-value "variants" straight from an `.rng` file. A new `annotation_tags_generator.py` calls it per GROBID training variant (scoped by a small `annotation_tags_scope.py` config) and assigns colors deterministically. The Pydantic response model gains a `variants`/`bareAllowed` shape; the frontend popup and decoration layer render one chip with a dropdown instead of many flat chips.

**Tech Stack:** Python (FastAPI, Pydantic, `xml.etree.ElementTree`), JavaScript (CodeMirror 6, Shoelace web components), `unittest` (Python), no new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-09-05-annotation-chip-schema-redesign-design.md`

**Related upstream work (separate repo, not part of this plan):** `/Users/cboulanger/Code/grobid-footnote-flavour/docs/2026-09-05-annotation-chip-schema-changes-plan.md` adds the `<a:documentation>` annotations and the `references_title`/`references_idno`/`references_biblScope` enum overrides this plan's generator depends on for full chip coverage. Until that lands, tags/attributes it covers (`idno`, `biblScope`, `title`'s legislation/caseName presets) will generate with fewer or no dropdown variants — everything else (`orgName`, `citedRange`, `date`, `seg`, `ref`, `div`, `bibl`) already has full schema support today and works immediately.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `fastapi_app/lib/utils/relaxng_to_codemirror.py` | **Modify.** Add `extract_tag_definitions()` and its private helpers to `RelaxNGParser`. Purely additive — existing autocomplete-map behavior (`parse_file()`, `_build_autocomplete_map()`, etc.) is untouched. |
| `fastapi_app/plugins/grobid/config/annotation_tags_scope.py` | **Create.** Per-variant `{root, exclude}` config — the only hand-maintained input left. |
| `fastapi_app/plugins/grobid/config/annotation_tags_generator.py` | **Create.** `generate_annotation_tags(variant_id, schema_path)` — builds the chip list for one variant from its schema. |
| `fastapi_app/plugins/grobid/config/annotation_tags.py` | **Delete.** Replaced entirely by the generator. |
| `fastapi_app/plugins/grobid/config/__init__.py` | **Modify.** `get_annotation_tags()` now calls the generator with mtime-based regeneration instead of returning a static dict. |
| `fastapi_app/lib/models/models_extraction.py` | **Modify.** `AnnotationTagDef` gains `variants`/`bareAllowed`, drops `labelMap`/`priority`/`defaultAttributes`. New `AnnotationTagVariant` model. |
| `tests/unit/fastapi/test_relaxng_to_codemirror.py` | **Create.** Unit tests for the new parser methods, against small inline fixture schemas. |
| `fastapi_app/plugins/grobid/tests/test_annotation_config.py` | **Modify.** Rewritten for the new generator-backed behavior (real cached schemas). |
| `tests/unit/fastapi/test_annotation_tag_models.py` | **Modify.** Rewritten for the new `AnnotationTagDef`/`AnnotationTagVariant` shape. |
| `app/src/modules/codemirror/xml-annotation-decorations.js` | **Modify.** `tagMap` becomes one def per tag (no more bucket/`defaultAttributes` matching); badge label computed from `variants` + live attribute values. |
| `app/src/modules/codemirror/xml-annotation-popup.js` | **Modify.** `#renderPalette` renders a split-button (chip + dropdown) per tag; `#retag`/`setWrapCallback`/`showForSelection` carry an explicit attribute-override object instead of relying on a chosen def's `defaultAttributes`. |
| `app/src/plugins/xml-annotation.js` | **Modify.** `AnnotationTagDef` typedef updated; `#wrapSelectionWith`/`#splitAnnotation` take an explicit attrs argument instead of reading `def.defaultAttributes`. |
| `app/src/modules/api-client-v1.js` | **Regenerate** via `npm run generate-client` (auto-generated — never hand-edit) after the backend model changes land. |

---

### Task 1: Extend `RelaxNGParser` with `extract_tag_definitions()`

**Files:**
- Modify: `fastapi_app/lib/utils/relaxng_to_codemirror.py`
- Test: `tests/unit/fastapi/test_relaxng_to_codemirror.py`

This adds the ability to pull, for a given tag name, its description, its enumerated "variants" (attribute-value combinations for the split-button dropdown), and whether the bare tag (no attributes) is schema-valid — all purely additive; no existing method's behavior changes.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fastapi/test_relaxng_to_codemirror.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_relaxng_to_codemirror.py -v`
Expected: FAIL with `AttributeError: 'RelaxNGParser' object has no attribute 'extract_tag_definitions'`

- [ ] **Step 3: Add `self.root` retention in `parse_file()`**

In `fastapi_app/lib/utils/relaxng_to_codemirror.py`, modify `parse_file` (around line 153-174):

```python
    def parse_file(self, file_path: str) -> Dict[str, Dict]:
        """Parse a RelaxNG file and return autocomplete map."""
        try:
            tree = ET.parse(file_path)
            root = tree.getroot()
            self.root = root  # Retained for extract_tag_definitions()

            # Extract namespace prefixes
            self._extract_namespaces(root)

            # First pass: collect all define patterns
            self._collect_define_patterns(root)

            # Second pass: process element definitions
            self._process_elements(root)

            # Build the final autocomplete map
            return self._build_autocomplete_map()

        except ET.ParseError as e:
            raise ValueError(f"Failed to parse RelaxNG file: {e}")
        except FileNotFoundError:
            raise FileNotFoundError(f"RelaxNG file not found: {file_path}")
```

Also initialize `self.root: Optional[ET.Element] = None` in `__init__` (add this line right after `self.namespace_map = {}` around line 122):

```python
        self.namespace_map = {}
        self.root: Optional[ET.Element] = None
```

- [ ] **Step 4: Add the `RNG_NS` module constant**

Near the top of the file, right after the imports (around line 25), add:

```python
RNG_NS = '{http://relaxng.org/ns/structure/1.0}'
```

- [ ] **Step 5: Add the new private helpers and `extract_tag_definitions()`**

Insert these methods into the `RelaxNGParser` class, directly after `_extract_attribute_values` (which currently ends around line 370, right before `_build_autocomplete_map`):

```python
    def _find_element_definition(self, tag_name: str) -> Optional[ET.Element]:
        """
        Find the `<element name=tag_name>` definition to use for tag
        generation. When a tag name is defined more than once in a
        flattened schema (e.g. a training-content `bibl` vs. an unrelated
        header `sourceDescBibl`'s trivial `<element name="bibl">`), the
        LAST occurrence in document order wins — matching
        `_process_elements()`'s own overwrite-on-reprocess behavior, which
        is why the existing autocomplete map already resolves to the
        richer definition for such names today.
        """
        if self.root is None:
            return None
        match = None
        for element in self.root.findall(f'.//{RNG_NS}element'):
            if element.get('name') == tag_name:
                match = element
        return match

    def _is_attribute_required(self, container: ET.Element, attr_name: str) -> bool:
        """
        True if `<attribute name=attr_name>` is a mandatory direct
        descendant of `container` — i.e. reachable without passing through
        an `<optional>` or `<choice>`, either of which would make its
        presence conditional. Does not resolve `<ref>`s: only used on
        already-resolved `<element>` nodes whose attributes are declared
        inline, which is the case for every schema this parser targets.
        """
        for attr in container.findall(f'./{RNG_NS}attribute'):
            if attr.get('name') == attr_name:
                return True
        for group in container.findall(f'./{RNG_NS}group'):
            if self._is_attribute_required(group, attr_name):
                return True
        for interleave in container.findall(f'./{RNG_NS}interleave'):
            if self._is_attribute_required(interleave, attr_name):
                return True
        return False

    def _extract_value_documentation(self, attr_element: ET.Element) -> Dict[str, str]:
        """Map enumerated `<value>` text to its own `<a:documentation>`,
        for values that declare one. Values without documentation are
        omitted from the result."""
        docs = {}
        for value in attr_element.findall(f'.//{RNG_NS}value'):
            if not value.text:
                continue
            doc = self._extract_documentation(value)
            if doc:
                docs[value.text.strip()] = doc
        return docs

    def _extract_grouped_presets(self, choice: ET.Element) -> Optional[List[Dict]]:
        """
        If `choice` (a `<choice>` element) is a set of `<group>`
        alternatives that each assign one or more attributes to a single
        literal `<value>`, return one preset per group:
        `[{'attrs': {attr_name: value}, 'description': str|None}, ...]`.
        Returns None if `choice` isn't shaped this way (e.g. it has no
        `<group>` children, or a group has no attribute assignments) —
        the independent-enumerated-attribute path in `extract_tag_definitions`
        applies instead.
        """
        groups = choice.findall(f'./{RNG_NS}group')
        if not groups:
            return None
        presets = []
        for group in groups:
            attrs = {}
            for attr in group.findall(f'./{RNG_NS}attribute'):
                attr_name = attr.get('name')
                value = attr.find(f'./{RNG_NS}value')
                if attr_name and value is not None and value.text:
                    attrs[attr_name] = value.text.strip()
            if not attrs:
                return None
            presets.append({'attrs': attrs, 'description': self._extract_documentation(group)})
        return presets

    def _extract_variants(self, element: ET.Element) -> "tuple[List[Dict], bool]":
        """
        Returns `(variants, bare_allowed)` for `element`, covering two
        shapes:

        1. A `<choice>` of `<group>`s (correlated multi-attribute presets,
           e.g. `references_title`'s level+type combinations) — found
           either as a direct, mandatory child of `element` (bare_allowed
           = False) or wrapped in `<optional>` (bare_allowed = True).
        2. One or more independently enumerated attributes (the common
           case, e.g. `citedRange@unit`, `orgName@type`) — each
           attribute's values become independent variants; bare_allowed
           is False only if the schema does not wrap that attribute in
           `<optional>`.

        Freeform attributes (no enumerated `<value>`s at all) never
        produce variants — they stay editable as free text via the
        existing per-element `attributes` list instead.
        """
        direct_choice = element.find(f'./{RNG_NS}choice')
        optional = element.find(f'./{RNG_NS}optional')
        optional_choice = optional.find(f'./{RNG_NS}choice') if optional is not None else None

        for choice, bare_allowed in ((direct_choice, False), (optional_choice, True)):
            if choice is None:
                continue
            presets = self._extract_grouped_presets(choice)
            if presets is not None:
                return presets, bare_allowed

        variants = []
        required_attr_found = False
        for attr_name, attr_data in self._extract_attributes(element).items():
            values = attr_data['values'] if isinstance(attr_data, dict) else attr_data
            if not values:
                continue
            value_docs = {}
            for attr_el in element.iter(f'{RNG_NS}attribute'):
                if attr_el.get('name') == attr_name:
                    value_docs.update(self._extract_value_documentation(attr_el))
            for v in values:
                variants.append({'attrs': {attr_name: v}, 'description': value_docs.get(v)})
            if self._is_attribute_required(element, attr_name):
                required_attr_found = True
        return variants, not required_attr_found

    def extract_tag_definitions(self, root_tag: str, exclude: "Set[str]" = frozenset()) -> Dict[str, Dict]:
        """
        Extract per-tag data for annotation-chip generation: `root_tag`
        plus every element name allowed as its child in the content model
        (per `_extract_child_elements`), minus `exclude`. Must be called
        after `parse_file()`.

        Distinct from `_extract_attributes()`/`_extract_attribute_values()`
        (used for the CodeMirror autocomplete map, which only needs
        attribute *names* and value lists) — this is purely additive and
        does not change their behavior or the autocomplete map's shape.

        Returns `{tag_name: {
            'description': str | None,
            'children': list[str],
            'attributes': [{'name': str, 'values': list[str] | None}],
            'variants': [{'attrs': dict[str, str], 'description': str | None}],
            'bareAllowed': bool,
        }}`. A `root_tag` not found as an `<element>` anywhere in the
        schema yields an empty dict.
        """
        root_element = self._find_element_definition(root_tag)
        if root_element is None:
            return {}

        tag_names = ({root_tag} | set(self._extract_child_elements(root_element))) - set(exclude)

        result = {}
        for tag_name in tag_names:
            element = self._find_element_definition(tag_name)
            if element is None:
                continue
            attributes = []
            for attr_name, attr_data in self._extract_attributes(element).items():
                values = attr_data['values'] if isinstance(attr_data, dict) else attr_data
                attributes.append({'name': attr_name, 'values': values})
            variants, bare_allowed = self._extract_variants(element)
            result[tag_name] = {
                'description': self._extract_documentation(element),
                'children': self._extract_child_elements(element),
                'attributes': attributes,
                'variants': variants,
                'bareAllowed': bare_allowed,
            }
        return result
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_relaxng_to_codemirror.py -v`
Expected: All tests PASS.

- [ ] **Step 7: Run the existing autocomplete-generator tests to confirm no regression**

Run: `uv run python tests/unit-test-runner.py --pattern "*autocomplete*" -v` (if this finds no files, instead run: `grep -rl "generate_autocomplete_map\|RelaxNGParser" tests/ fastapi_app/*/tests/` to locate any existing coverage and run it directly with `uv run python tests/unit-test-runner.py <path> -v`.)
Expected: All PASS (no existing test references `self.root` or breaks from its addition, since it's a brand-new attribute).

- [ ] **Step 8: Commit**

```bash
git add fastapi_app/lib/utils/relaxng_to_codemirror.py tests/unit/fastapi/test_relaxng_to_codemirror.py
git commit -m "feat: add extract_tag_definitions() to RelaxNGParser for schema-driven annotation chips"
```

---

### Task 2: Create the per-variant scope config

**Files:**
- Create: `fastapi_app/plugins/grobid/config/annotation_tags_scope.py`

- [ ] **Step 1: Write the file**

```python
"""
Per-variant scope for schema-driven annotation tag generation: which
element is the "root" whose content-model children become chips, and
which of those children are excluded (never meaningfully "annotated" via
the chip popup, e.g. a bare line break).

Unlike the annotation tag data itself (generated from the schema), this
config only changes if a variant's overall document shape changes, which
is rare — see docs/superpowers/specs/2026-09-05-annotation-chip-schema-redesign-design.md.
"""

from typing import TypedDict


class TagScope(TypedDict):
    root: str
    exclude: set[str]


ANNOTATION_TAG_SCOPE: dict[str, TagScope] = {
    "grobid.training.segmentation": {
        "root": "text",
        "exclude": {"lb"},
    },
    "grobid.training.references.referenceSegmenter": {
        "root": "bibl",
        "exclude": {"lb"},
    },
    "grobid.training.references": {
        "root": "bibl",
        "exclude": {"lb"},
    },
}
```

- [ ] **Step 2: Commit**

```bash
git add fastapi_app/plugins/grobid/config/annotation_tags_scope.py
git commit -m "feat: add per-variant scope config for schema-driven annotation tags"
```

---

### Task 3: Create the annotation tags generator

**Files:**
- Create: `fastapi_app/plugins/grobid/config/annotation_tags_generator.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py`

- [ ] **Step 1: Write the failing test**

Create `fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.plugins.grobid.config.annotation_tags_generator'`

- [ ] **Step 3: Write the generator**

Create `fastapi_app/plugins/grobid/config/annotation_tags_generator.py`:

```python
"""
Generates the annotation-chip data (AnnotationTagsMap) for a GROBID
training variant from its cached RelaxNG schema, replacing the previous
hand-curated fastapi_app/plugins/grobid/config/annotation_tags.py.

See docs/superpowers/specs/2026-09-05-annotation-chip-schema-redesign-design.md.
"""

import hashlib
from pathlib import Path
from typing import TypedDict

from fastapi_app.lib.utils.relaxng_to_codemirror import RelaxNGParser
from fastapi_app.plugins.grobid.config.annotation_tags_scope import ANNOTATION_TAG_SCOPE


class AnnotationTagAttribute(TypedDict):
    name: str
    values: list[str] | None


class AnnotationTagVariant(TypedDict):
    attrs: dict[str, str]
    description: str | None


class AnnotationTag(TypedDict):
    tag: str
    label: str
    color: str
    description: str | None
    attributes: list[AnnotationTagAttribute]
    variants: list[AnnotationTagVariant]
    bareAllowed: bool
    childTags: list[str]


AnnotationTagsMap = dict[str, list[AnnotationTag]]


# Same palette as the previous hand-curated config (Catppuccin Mocha accents).
PALETTE: list[str] = [
    "#89dceb", "#f38ba8", "#89b4fa", "#cba6f7", "#94e2d5", "#f9e2af",
    "#a6e3a1", "#f5c2e7", "#74c7ec", "#585b70", "#f2cdcd", "#eba0ac",
    "#b4befe", "#45475a", "#fab387", "#9399b2", "#d18455",
]


def _color_for_tag(tag_name: str, taken: set[str]) -> str:
    """
    Deterministic palette color for `tag_name`: hashed on the tag name
    alone (not the variant), so the same tag name gets the same color in
    every variant's toolbar. Uses hashlib rather than Python's built-in
    hash(), which is randomized per-process and would reshuffle colors on
    every server restart. `taken` holds colors already assigned within the
    current variant's chip set; on a collision the next free palette slot
    is used instead, so two tags in one toolbar are never the same color
    even if their hashes coincide.
    """
    digest = hashlib.sha256(tag_name.encode("utf-8")).hexdigest()
    index = int(digest, 16) % len(PALETTE)
    for _ in range(len(PALETTE)):
        color = PALETTE[index]
        if color not in taken:
            return color
        index = (index + 1) % len(PALETTE)
    return PALETTE[int(digest, 16) % len(PALETTE)]  # palette exhausted; accept a collision


def generate_annotation_tags(variant_id: str, schema_path: Path) -> list[AnnotationTag]:
    """
    Build the chip list for one GROBID training variant from its cached
    RelaxNG schema file. Returns an empty list if the variant has no scope
    configured in ANNOTATION_TAG_SCOPE, or the schema file doesn't exist
    yet — a schema declaration is required to get any chips at all.
    """
    scope = ANNOTATION_TAG_SCOPE.get(variant_id)
    if scope is None or not schema_path.is_file():
        return []

    parser = RelaxNGParser(include_global_attrs=False, sort_alphabetically=True)
    parser.parse_file(str(schema_path))
    definitions = parser.extract_tag_definitions(scope["root"], scope["exclude"])

    tags: list[AnnotationTag] = []
    taken_colors: set[str] = set()
    for tag_name in sorted(definitions):
        data = definitions[tag_name]
        color = _color_for_tag(tag_name, taken_colors)
        taken_colors.add(color)
        tags.append({
            "tag": tag_name,
            "label": tag_name,
            "color": color,
            "description": data["description"],
            "attributes": data["attributes"],
            "variants": data["variants"],
            "bareAllowed": data["bareAllowed"],
            "childTags": data["children"],
        })
    return tags
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py -v`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/config/annotation_tags_generator.py fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py
git commit -m "feat: generate annotation tags from schema instead of a curated dict"
```

---

### Task 4: Update the Pydantic response models

**Files:**
- Modify: `fastapi_app/lib/models/models_extraction.py:26-67` (the `AnnotationTagAttribute`/`AnnotationTagDef` classes)

- [ ] **Step 1: Replace the model definitions**

In `fastapi_app/lib/models/models_extraction.py`, replace the existing `AnnotationTagAttribute` and `AnnotationTagDef` classes (currently lines 26-67) with:

```python
class AnnotationTagAttribute(BaseModel):
    """An attribute editable in the post-hoc properties popup for an
    already-tagged element (enumerated or freeform)."""
    name: str = Field(..., description="XML attribute name")
    values: Optional[List[str]] = Field(
        None,
        description="Allowed values; if None, a free-text input is shown"
    )


class AnnotationTagVariant(BaseModel):
    """One split-button dropdown entry: an attribute-value combination
    (one or more attributes assigned together) applied when wrapping a
    selection or retagging an element."""
    attrs: Dict[str, str] = Field(
        ..., description="Attribute name/value pairs applied when this variant is chosen"
    )
    description: Optional[str] = Field(
        None, description="Tooltip text for this specific variant"
    )


class AnnotationTagDef(BaseModel):
    """Definition of an annotation tag contributed by a variant plugin."""
    tag: str = Field(..., description="XML element name (e.g. 'bibl')")
    label: str = Field(..., description="Chip label; always the bare tag name")
    color: str = Field(..., description="CSS colour for this tag's badge and underline")
    attributes: List[AnnotationTagAttribute] = Field(
        default_factory=list,
        description="Attributes shown in the properties popup for an already-tagged element"
    )
    variants: List[AnnotationTagVariant] = Field(
        default_factory=list,
        description="Attribute-value dropdown options for the split-button chip; empty if the tag has no enumerated attributes"
    )
    bareAllowed: bool = Field(
        True,
        description="Whether clicking the chip body (as opposed to only the dropdown) inserts the bare tag with no attributes"
    )
    description: Optional[str] = Field(
        None,
        description="Tooltip text for the chip itself"
    )
    childTags: List[str] = Field(
        default_factory=list,
        description="Tag names that may be nested inside this element rather than splitting it"
    )
```

This drops `labelMap`, `priority`, and `defaultAttributes` — dead fields under the new one-def-per-tag model (ordering is alphabetical by tag name, computed at generation time; attribute-value combinations live in `variants` instead of one `AnnotationTagDef` per combination).

- [ ] **Step 2: Re-export `AnnotationTagVariant` from `fastapi_app/lib/models/__init__.py`**

This package re-exports the extraction models so other modules can `from fastapi_app.lib.models import ...` instead of reaching into `models_extraction` directly. Add the new class to the existing import block (around line 45-53):

```python
from fastapi_app.lib.models.models_extraction import (
    AnnotationGuideInfo,
    AnnotationTagAttribute,
    AnnotationTagDef,
    AnnotationTagVariant,
    ExtractorInfo,
    ListExtractorsResponse,
    ExtractRequest,
    ExtractResponse,
)
```

And add `"AnnotationTagVariant",` next to the existing `"AnnotationTagAttribute",`/`"AnnotationTagDef",` entries in this file's `__all__` list (around line 114-115).

- [ ] **Step 3: Run the type check**

Run: `cd /Users/cboulanger/Code/pdf-tei-editor && uv run python -c "from fastapi_app.lib.models import AnnotationTagDef, AnnotationTagVariant, AnnotationTagAttribute; print('ok')"`
Expected: prints `ok` (Tasks 6/7 will fix the now-broken existing tests that reference the removed fields — don't fix them here).

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/lib/models/models_extraction.py
git commit -m "feat: replace defaultAttributes/priority/labelMap with variants/bareAllowed on AnnotationTagDef"
```

---

### Task 5: Wire `get_annotation_tags()` to the generator and delete the old config

**Files:**
- Modify: `fastapi_app/plugins/grobid/config/__init__.py`
- Delete: `fastapi_app/plugins/grobid/config/annotation_tags.py`

- [ ] **Step 1: Replace the import and `get_annotation_tags()` in `config/__init__.py`**

Replace this line (currently near the top of the imports):

```python
from fastapi_app.plugins.grobid.config.annotation_tags import ANNOTATION_TAGS, AnnotationTagsMap
```

with:

```python
from fastapi_app.config import get_settings
from fastapi_app.lib.core.schema_validator import get_schema_cache_info
from fastapi_app.plugins.grobid.config.annotation_tags_generator import (
    AnnotationTag,
    AnnotationTagsMap,
    generate_annotation_tags,
)
from fastapi_app.plugins.grobid.config.annotation_tags_scope import ANNOTATION_TAG_SCOPE
```

Then replace the existing `get_annotation_tags()` function:

```python
def get_annotation_tags() -> AnnotationTagsMap:
    """Return annotation tag definitions keyed by variant_id."""
    return copy.deepcopy(ANNOTATION_TAGS)
```

with:

```python
_ANNOTATION_TAGS_CACHE: dict[str, tuple[float | None, list[AnnotationTag]]] = {}


def get_annotation_tags() -> AnnotationTagsMap:
    """
    Return annotation tag definitions keyed by variant_id, generated from
    each variant's cached RelaxNG schema (see annotation_tags_generator.py).
    A variant's chip list is regenerated only when its cached schema
    file's mtime changes since the last build; a variant whose schema
    hasn't been downloaded/cached yet gets an empty list rather than an
    error — a schema declaration is required to get any chips at all.
    """
    result: AnnotationTagsMap = {}
    cache_root = get_settings().schema_cache_dir
    for variant_id in ANNOTATION_TAG_SCOPE:
        _, schema_cache_file, _ = get_schema_cache_info(get_schema_url(variant_id), cache_root)
        mtime = schema_cache_file.stat().st_mtime if schema_cache_file.is_file() else None
        cached = _ANNOTATION_TAGS_CACHE.get(variant_id)
        if cached is not None and cached[0] == mtime:
            result[variant_id] = copy.deepcopy(cached[1])
            continue
        tags = generate_annotation_tags(variant_id, schema_cache_file)
        _ANNOTATION_TAGS_CACHE[variant_id] = (mtime, tags)
        result[variant_id] = copy.deepcopy(tags)
    return result
```

Note: `get_schema_url` and `copy` are already imported/available in this file (`get_schema_url` is defined earlier in the same module; `copy` is imported at the top for the existing `get_annotation_guides`/`get_form_options` functions) — don't re-add those imports.

- [ ] **Step 2: Delete the old config file**

```bash
git rm fastapi_app/plugins/grobid/config/annotation_tags.py
```

- [ ] **Step 3: Verify the module imports cleanly**

Run: `cd /Users/cboulanger/Code/pdf-tei-editor && uv run python -c "from fastapi_app.plugins.grobid.config import get_annotation_tags; import json; print(json.dumps(get_annotation_tags(), indent=2)[:2000])"`
Expected: prints JSON with keys `grobid.training.segmentation`, `grobid.training.references.referenceSegmenter`, `grobid.training.references` (each a list — populated if the schema is already cached at `data/schema/cache/mpilhlt.github.io/grobid-footnote-flavour/schema/`, otherwise `[]`; both are correct depending on whether validation has run recently in this checkout).

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/plugins/grobid/config/__init__.py
git commit -m "feat: generate annotation tags from cached schemas instead of a static dict"
```

---

### Task 6: Rewrite the GROBID plugin's annotation config test

**Files:**
- Modify: `fastapi_app/plugins/grobid/tests/test_annotation_config.py`

The old tests assert on `defaultAttributes`/`priority` and hardcoded multi-entry-per-tag shapes (`title[legislation]`, `bibl[footnote]`, etc. as separate list entries) that no longer exist. This forces the schema to be cached first (via the app's own validation endpoint or a prior test run) since these tests exercise the real cached schema, not a fixture — matching the previous test file's own approach of calling the real `get_annotation_tags()`.

- [ ] **Step 1: Ensure the schema is cached before running these tests**

Run: `uv run python -c "
from pathlib import Path
from fastapi_app.config import get_settings
from fastapi_app.lib.core.schema_validator import get_schema_cache_info, download_schema_file
from fastapi_app.plugins.grobid.config import get_schema_url
for variant in ['grobid.training.segmentation', 'grobid.training.references.referenceSegmenter', 'grobid.training.references']:
    url = get_schema_url(variant)
    cache_dir, cache_file, _ = get_schema_cache_info(url, get_settings().schema_cache_dir)
    if not cache_file.is_file():
        cache_dir.mkdir(parents=True, exist_ok=True)
        download_schema_file(url, cache_dir, cache_file)
    print(variant, cache_file.is_file())
"`
Expected: prints `True` for all three variants. (This step just guarantees the fixtures the rewritten test relies on exist — the app already does this download lazily inside request handling; this just does it once up front for the test run.)

- [ ] **Step 2: Replace the test file contents**

```python
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
```

- [ ] **Step 3: Run the tests**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: All tests PASS. If `test_references_bibl_has_type_variants`/`test_references_citedrange_units_collapsed_into_variants`/etc. fail because the currently-cached schema (fetched before the upstream `docs/2026-09-05-annotation-chip-schema-changes-plan.md` changes have landed) doesn't yet enumerate everything expected — that's an accurate reflection of current schema state, not a bug in this plan. Re-run once the upstream schema is updated and the local cache has refreshed (delete `data/schema/cache/` to force a re-download, per the project's own schema-cache-refresh instructions).

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/plugins/grobid/tests/test_annotation_config.py
git commit -m "test: rewrite annotation config tests for schema-driven generation"
```

---

### Task 7: Rewrite the Pydantic model tests

**Files:**
- Modify: `tests/unit/fastapi/test_annotation_tag_models.py`

- [ ] **Step 1: Replace the test file contents**

```python
"""
Unit tests for AnnotationTagDef/AnnotationTagVariant models in models_extraction.py

@testCovers fastapi_app/lib/models/models_extraction.py
"""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.models.models_extraction import (
    AnnotationTagAttribute,
    AnnotationTagDef,
    AnnotationTagVariant,
    ExtractorInfo,
)


class TestAnnotationTagAttribute(unittest.TestCase):

    def test_required_fields(self):
        attr = AnnotationTagAttribute(name="key")
        self.assertEqual(attr.name, "key")
        self.assertIsNone(attr.values)

    def test_optional_values(self):
        attr = AnnotationTagAttribute(name="level", values=["m", "a", "j"])
        self.assertEqual(attr.values, ["m", "a", "j"])


class TestAnnotationTagVariant(unittest.TestCase):

    def test_single_attribute_variant(self):
        variant = AnnotationTagVariant(attrs={"type": "court"})
        self.assertEqual(variant.attrs, {"type": "court"})
        self.assertIsNone(variant.description)

    def test_correlated_multi_attribute_variant(self):
        variant = AnnotationTagVariant(
            attrs={"level": "m", "type": "legislation"},
            description="Title of a statute / legislative act",
        )
        self.assertEqual(variant.attrs["level"], "m")
        self.assertEqual(variant.attrs["type"], "legislation")
        self.assertEqual(variant.description, "Title of a statute / legislative act")


class TestAnnotationTagDef(unittest.TestCase):

    def test_minimal(self):
        tag = AnnotationTagDef(tag="bibl", label="bibl", color="#89dceb")
        self.assertEqual(tag.tag, "bibl")
        self.assertEqual(tag.label, "bibl")
        self.assertEqual(tag.color, "#89dceb")
        self.assertEqual(tag.attributes, [])
        self.assertEqual(tag.variants, [])
        self.assertTrue(tag.bareAllowed)
        self.assertIsNone(tag.description)
        self.assertEqual(tag.childTags, [])

    def test_with_variants(self):
        tag = AnnotationTagDef(
            tag="title",
            label="title",
            color="#a6e3a1",
            bareAllowed=False,
            variants=[
                AnnotationTagVariant(attrs={"level": "a"}, description="Article or chapter title"),
                AnnotationTagVariant(attrs={"level": "m", "type": "legislation"}, description="Statute title"),
            ],
        )
        self.assertFalse(tag.bareAllowed)
        self.assertEqual(len(tag.variants), 2)
        self.assertEqual(tag.variants[1].attrs, {"level": "m", "type": "legislation"})

    def test_serialization(self):
        tag = AnnotationTagDef(
            tag="citedRange", label="citedRange", color="#89b4fa", bareAllowed=False,
            description="Pinpoint into a statute or decision",
            variants=[AnnotationTagVariant(attrs={"unit": "page"}, description="Pinpoint by printed page number")],
        )
        data = tag.model_dump()
        self.assertEqual(data["tag"], "citedRange")
        self.assertFalse(data["bareAllowed"])
        self.assertEqual(data["variants"][0]["attrs"], {"unit": "page"})
        self.assertEqual(data["description"], "Pinpoint into a statute or decision")


class TestExtractorInfoAnnotationTags(unittest.TestCase):

    def test_default_empty_dict(self):
        info = ExtractorInfo(
            id="grobid", name="Grobid", description="Grobid extractor",
            input=["pdf"], output=["xml"], available=True,
        )
        self.assertEqual(info.annotationTags, {})

    def test_with_annotation_tags_dict(self):
        info = ExtractorInfo(
            id="grobid", name="Grobid", description="Grobid extractor",
            input=["pdf"], output=["xml"], available=True,
            annotationTags={
                "grobid.training.references": [
                    AnnotationTagDef(tag="bibl", label="bibl", color="#89dceb")
                ]
            },
        )
        tags = info.annotationTags.get("grobid.training.references", [])
        self.assertEqual(len(tags), 1)
        self.assertEqual(tags[0].tag, "bibl")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_tag_models.py -v`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/fastapi/test_annotation_tag_models.py
git commit -m "test: rewrite AnnotationTagDef model tests for variants/bareAllowed shape"
```

---

### Task 8: Regenerate the API client

**Files:**
- Regenerate: `app/src/modules/api-client-v1.js` (auto-generated — never hand-edit)

- [ ] **Step 1: Run the generator**

Run: `npm run generate-client`
Expected: exits 0; `git diff app/src/modules/api-client-v1.js` shows the `AnnotationTagDef`/`AnnotationTagAttribute` JSDoc typedefs updated (new `AnnotationTagVariant` typedef added, `labelMap`/`priority`/`defaultAttributes` properties removed, `variants`/`bareAllowed` added).

- [ ] **Step 2: Commit**

```bash
git add app/src/modules/api-client-v1.js
git commit -m "chore: regenerate API client for AnnotationTagDef variants/bareAllowed"
```

---

### Task 9: Update the decoration layer (badges)

**Files:**
- Modify: `app/src/modules/codemirror/xml-annotation-decorations.js`

The old code kept a `Map<string, Def[]>` (a bucket of defs per tag name, one per attribute-value combination) and picked the best match by comparing the element's live attributes against each candidate's `defaultAttributes`. With one `AnnotationTagDef` per tag now, this collapses to a plain `Map<string, Def>`; the badge's per-instance label (e.g. showing `title[m]` vs `title[a]`) is now computed from the def's `variants` plus the element's actual attribute values, since there's no longer a separate def per combination to pick a label from.

- [ ] **Step 1: Replace `resolveLabel` (lines 19-50)**

```javascript
/**
 * Resolves the display label for a badge: the bare tag name, or
 * `tag[value1,value2]` listing the live values of whichever attributes
 * this tag's variants control (e.g. `title[m]` for a `<title level="m">`
 * whose def has a `level` variant).
 * @param {{ tag: string, variants?: Array<{attrs: Record<string,string>}>|null }} tagDef
 * @param {Element} element
 * @returns {string}
 */
export function resolveLabel(tagDef, element) {
  const variantAttrNames = [...new Set((tagDef.variants ?? []).flatMap(v => Object.keys(v.attrs)))];
  const parts = variantAttrNames.map(name => element.getAttribute(name)).filter(Boolean);
  return parts.length ? `${tagDef.tag}[${parts.join(',')}]` : tagDef.tag;
}
```

- [ ] **Step 2: Replace `simplifiedLabel` and add a `readAttributes`-based badge label helper (lines 121-133)**

Replace:

```javascript
/**
 * Computes a simplified badge label from tagDef.label at decoration-build time.
 * The XML DOM is not available here, so we strip {@attr} tokens and clean up brackets.
 * Full label resolution (via resolveLabel) happens at popup click time.
 * @param {{ label: string, tag: string }} tagDef
 * @returns {string}
 */
function simplifiedLabel(tagDef) {
  return tagDef.label
    .replace(/\[?\{@[^}]+\}\]?/g, '')
    .replace(/\[+\]+/g, '')
    .trim() || tagDef.tag.toUpperCase();
}
```

with:

```javascript
/**
 * Computes the badge label at decoration-build time, mirroring
 * `resolveLabel()` but reading from the plain attrs object `readAttributes()`
 * parses from the Lezer syntax tree (no live DOM element exists at this
 * layer).
 * @param {{ tag: string, variants?: Array<{attrs: Record<string,string>}>|null }} tagDef
 * @param {Record<string,string>} elemAttrs
 * @returns {string}
 */
function badgeLabel(tagDef, elemAttrs) {
  const variantAttrNames = [...new Set((tagDef.variants ?? []).flatMap(v => Object.keys(v.attrs)))];
  const parts = variantAttrNames.map(name => elemAttrs[name]).filter(Boolean);
  return parts.length ? `${tagDef.tag}[${parts.join(',')}]` : tagDef.tag;
}
```

- [ ] **Step 3: Simplify `buildAll()`'s def lookup (lines 181-236)**

Replace this block:

```javascript
          const defs = tagMap.get(tagName);

          if (!defs) {
            // Non-annotation element: make its open/close tags atomic
            pendingAtomic.push({ from: firstChild.from, to: firstChild.to });
            const lastChild = node.node.lastChild;
            if (lastChild && (lastChild.name === 'CloseTag' || lastChild.name === 'MismatchedCloseTag')) {
              pendingAtomic.push({ from: lastChild.from, to: lastChild.to });
            }
            return;
          }

          // Pick the best matching def: prefer one whose defaultAttributes all match,
          // fall back to the generic def (defaultAttributes null/undefined).
          let def = null;
          let fallbackDef = null;
          let elemAttrs = /** @type {Record<string,string>|null} */ (null);
          for (const candidate of defs) {
            if (!candidate.defaultAttributes) {
              fallbackDef = candidate;
            } else {
              if (!elemAttrs) elemAttrs = readAttributes(firstChild, state);
              if (elemAttrs && Object.entries(candidate.defaultAttributes).every(([k, v]) => elemAttrs[k] === v)) {
                def = candidate;
                break;
              }
            }
          }
          def = def ?? fallbackDef;
          if (!def) return;
```

with:

```javascript
          const def = tagMap.get(tagName);

          if (!def) {
            // Non-annotation element: make its open/close tags atomic
            pendingAtomic.push({ from: firstChild.from, to: firstChild.to });
            const lastChild = node.node.lastChild;
            if (lastChild && (lastChild.name === 'CloseTag' || lastChild.name === 'MismatchedCloseTag')) {
              pendingAtomic.push({ from: lastChild.from, to: lastChild.to });
            }
            return;
          }

          const elemAttrs = (def.variants?.length ?? 0) > 0 ? readAttributes(firstChild, state) : {};
```

- [ ] **Step 4: Update the badge-label call site (around line 246)**

Replace:

```javascript
          // Badge for the OpenTag
          const label = simplifiedLabel(def);
```

with:

```javascript
          // Badge for the OpenTag
          const label = badgeLabel(def, elemAttrs);
```

- [ ] **Step 5: Update `createAnnotationField()`'s map construction (lines 355-362)**

Replace:

```javascript
export function createAnnotationField(tagDefs) {
  /** @type {Map<string, typeof tagDefs>} */
  const tagMap = new Map();
  for (const d of tagDefs) {
    const bucket = tagMap.get(d.tag);
    if (bucket) bucket.push(d);
    else tagMap.set(d.tag, [d]);
  }
```

with:

```javascript
export function createAnnotationField(tagDefs) {
  /** @type {Map<string, typeof tagDefs[number]>} */
  const tagMap = new Map();
  for (const d of tagDefs) {
    tagMap.set(d.tag, d);
  }
```

- [ ] **Step 6: Update the JSDoc typedefs referencing the old bucket/`defaultAttributes` shape**

Update the `@param` typedef on `buildAll` (line 178) from:

```javascript
 * @param {Map<string, Array<{tag: string, label: string, labelMap?: Record<string,string>|null, color: string, attributes: any[], defaultAttributes?: Record<string,string>|null}>>} tagMap
```

to:

```javascript
 * @param {Map<string, {tag: string, label: string, color: string, attributes: any[], variants?: Array<{attrs: Record<string,string>, description?: string|null}>|null, bareAllowed?: boolean, childTags?: string[]|null}>} tagMap
```

Update the inline `stack`/`pendingDecos`-adjacent typedef comment (line 187) similarly, replacing every occurrence of `labelMap?: Record<string,string>|null, ..., defaultAttributes?: Record<string,string>|null` in this file with `variants?: Array<{attrs: Record<string,string>, description?: string|null}>|null, bareAllowed?: boolean` (there are three such occurrences total in this file: lines 178, 187, and the `createAnnotationField` `@param` at line 352 — update all three the same way).

- [ ] **Step 7: Manual smoke check**

Run: `node --check app/src/modules/codemirror/xml-annotation-decorations.js`
Expected: no output (syntax is valid). Full behavioral verification happens in Task 12 once the popup (Task 10) and plugin (Task 11) changes are also in place — this file alone can't be exercised in isolation.

- [ ] **Step 8: Commit**

```bash
git add app/src/modules/codemirror/xml-annotation-decorations.js
git commit -m "refactor: one def per tag in the decoration layer, drop defaultAttributes matching"
```

---

### Task 10: Update the properties popup (split-button chips)

**Files:**
- Modify: `app/src/modules/codemirror/xml-annotation-popup.js`

- [ ] **Step 1: Update the `AnnotationTagDef` typedef (lines 12-17)**

Replace:

```javascript
/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null, color: string,
 *   attributes?: Array<{ name: string, values?: string[]|null }>|null,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null }} AnnotationTagDef
 */
```

with:

```javascript
/**
 * @typedef {{ attrs: Record<string,string>, description?: string|null }} AnnotationTagVariant
 * @typedef {{ tag: string, label: string, color: string,
 *   attributes?: Array<{ name: string, values?: string[]|null }>|null,
 *   variants?: AnnotationTagVariant[]|null, bareAllowed?: boolean,
 *   description?: string|null, childTags?: string[]|null }} AnnotationTagDef
 */
```

- [ ] **Step 2: Simplify `#buildTagMap`/`#tagMap` and remove `#selectDef` (lines 87-91, 180-209)**

Replace the field declarations:

```javascript
  /** @type {AnnotationTagDef[]} */
  #tagDefs = [];

  /** @type {Map<string, AnnotationTagDef[]>} */
  #tagMap = new Map();
```

with:

```javascript
  /** @type {AnnotationTagDef[]} */
  #tagDefs = [];

  /** @type {Map<string, AnnotationTagDef>} */
  #tagMap = new Map();
```

Replace `#buildTagMap` and `#selectDef` (currently lines 180-209):

```javascript
  /** @param {AnnotationTagDef[]} tagDefs */
  #buildTagMap(tagDefs) {
    this.#tagDefs = tagDefs;
    this.#tagMap = new Map();
    for (const d of tagDefs) {
      const bucket = this.#tagMap.get(d.tag);
      if (bucket) bucket.push(d);
      else this.#tagMap.set(d.tag, [d]);
    }
  }

  /**
   * Picks the best-matching def for `element` from a bucket of defs for the same tag name.
   * Prefers a def whose `defaultAttributes` all match the element's attributes; falls back to
   * the first def with no `defaultAttributes`.  Mirrors the selection logic in buildAll().
   * @param {AnnotationTagDef[]} defs
   * @param {Element} element
   * @returns {AnnotationTagDef|null}
   */
  #selectDef(defs, element) {
    let fallback = /** @type {AnnotationTagDef|null} */ (null);
    for (const d of defs) {
      if (!d.defaultAttributes) {
        if (!fallback) fallback = d;
      } else if (Object.entries(d.defaultAttributes).every(([k, v]) => element.getAttribute(k) === v)) {
        return d;
      }
    }
    return fallback;
  }
```

with:

```javascript
  /** @param {AnnotationTagDef[]} tagDefs */
  #buildTagMap(tagDefs) {
    this.#tagDefs = tagDefs;
    this.#tagMap = new Map();
    for (const d of tagDefs) {
      this.#tagMap.set(d.tag, d);
    }
  }
```

- [ ] **Step 3: Update the `ann-badge-click` handler (lines 111-121) to drop the `#selectDef` call**

Replace:

```javascript
    parent.addEventListener('ann-badge-click', (e) => {
      const { tag, from, clientX = 0, clientY = 0 } = /** @type {CustomEvent} */ (e).detail;
      const defs = this.#tagMap.get(tag);
      if (!defs) return;
      let element;
      try { element = /** @type {Element} */ (this.#editor.getDomNodeAt(from)); } catch { return; }
      if (!element) return;
      const def = this.#selectDef(defs, element);
      if (!def) return;
      this.#show({ clientX, clientY }, def, element);
    });
```

with:

```javascript
    parent.addEventListener('ann-badge-click', (e) => {
      const { tag, from, clientX = 0, clientY = 0 } = /** @type {CustomEvent} */ (e).detail;
      const def = this.#tagMap.get(tag);
      if (!def) return;
      let element;
      try { element = /** @type {Element} */ (this.#editor.getDomNodeAt(from)); } catch { return; }
      if (!element) return;
      this.#show({ clientX, clientY }, def, element);
    });
```

- [ ] **Step 4: Update `setWrapCallback`'s JSDoc and `showForSelection`'s call site (lines 140-169)**

Replace:

```javascript
  /**
   * Register the callback invoked when the user picks a chip in the selection popup.
   * Must be called once from the annotation plugin after `mount()`.
   * @param {(def: AnnotationTagDef) => void} fn
   */
  setWrapCallback(fn) {
    this.#wrapCallback = fn;
  }
```

with:

```javascript
  /**
   * Register the callback invoked when the user picks a chip (or one of its
   * dropdown variants) in the selection popup.
   * Must be called once from the annotation plugin after `mount()`.
   * @param {(def: AnnotationTagDef, attrs: Record<string,string>) => void} fn
   */
  setWrapCallback(fn) {
    this.#wrapCallback = fn;
  }
```

Replace the `showForSelection` render call:

```javascript
    this.#renderPalette(this.#overlay, null, (def) => {
      this.#hide();
      this.#wrapCallback?.(def);
    });
```

with:

```javascript
    this.#renderPalette(this.#overlay, null, (def, attrs) => {
      this.#hide();
      this.#wrapCallback?.(def, attrs);
    });
```

Also update the `#wrapCallback` field's typedef declaration (line 93-94):

```javascript
  /** @type {((def: AnnotationTagDef) => void)|null} */
  #wrapCallback = null;
```

to:

```javascript
  /** @type {((def: AnnotationTagDef, attrs: Record<string,string>) => void)|null} */
  #wrapCallback = null;
```

- [ ] **Step 5: Update `#show()`'s "Change to" call site (line 318)**

Replace:

```javascript
    this.#renderPalette(this.#overlay, def, async (newDef) => {
      this.#hide();
      await this.#retag(element, def, newDef);
    });
```

with:

```javascript
    this.#renderPalette(this.#overlay, def, async (newDef, attrs) => {
      this.#hide();
      await this.#retag(element, def, newDef, attrs);
    });
```

- [ ] **Step 6: Rewrite `#renderPalette()` for the split-button dropdown (lines 331-366)**

Replace the whole method:

```javascript
  /**
   * Renders one chip per tag definition into `container`.
   * The chip whose def is `currentDef` (by object identity) is muted and non-interactive.
   * @param {HTMLElement} container
   * @param {AnnotationTagDef|null} currentDef
   * @param {(def: AnnotationTagDef) => void} onChipClick
   */
  #renderPalette(container, currentDef, onChipClick) {
    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' });
    for (const def of sorted) {
      const chip = document.createElement('span');
      chip.textContent = def.label.replace(/\{@[^}]+\}/g, '…');
      chip.title = def.description || def.label;
      const isCurrent = def === currentDef;
      Object.assign(chip.style, {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: '3px',
        padding: '2px 6px 3px',
        cursor: isCurrent ? 'default' : 'pointer',
        opacity: isCurrent ? '0.4' : '1',
        userSelect: 'none',
      });
      if (!isCurrent) chip.addEventListener('click', () => onChipClick(def));
      row.appendChild(chip);
    }
    container.appendChild(row);
  }
```

with:

```javascript
  /**
   * Renders one split-button chip per tag definition into `container`, sorted
   * alphabetically by tag name. The chip whose def is `currentDef` (by object
   * identity) is muted and non-interactive. A tag with `variants` gets a
   * caret trigger opening a dropdown of attribute-value combinations; if
   * `bareAllowed` is false, the chip body itself is inert and only the
   * dropdown (opened from anywhere on the chip) can select something.
   * @param {HTMLElement} container
   * @param {AnnotationTagDef|null} currentDef
   * @param {(def: AnnotationTagDef, attrs: Record<string,string>) => void} onPick
   */
  #renderPalette(container, currentDef, onPick) {
    const sorted = [...this.#tagDefs].sort((a, b) => a.tag.localeCompare(b.tag));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' });
    for (const def of sorted) {
      const isCurrent = def === currentDef;
      const hasVariants = (def.variants?.length ?? 0) > 0;
      const bareAllowed = def.bareAllowed !== false;

      const wrapper = document.createElement('span');
      Object.assign(wrapper.style, { display: 'inline-flex', borderRadius: '3px', overflow: 'hidden' });

      const chipStyle = {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '2px 6px 3px',
        cursor: isCurrent ? 'default' : 'pointer',
        opacity: isCurrent ? '0.4' : '1',
        userSelect: 'none',
      };

      const chip = document.createElement('span');
      chip.textContent = def.label;
      chip.title = def.description || def.label;
      Object.assign(chip.style, chipStyle);
      wrapper.appendChild(chip);

      if (!isCurrent && bareAllowed) {
        chip.addEventListener('click', () => onPick(def, {}));
      }

      if (hasVariants) {
        const dropdown = document.createElement('sl-dropdown');
        const caret = document.createElement('span');
        caret.textContent = '▾';
        caret.slot = 'trigger';
        Object.assign(caret.style, { ...chipStyle, borderLeft: '1px solid rgba(0,0,0,.25)', padding: '2px 4px 3px' });
        dropdown.appendChild(caret);

        const menu = document.createElement('sl-menu');
        for (const variant of def.variants ?? []) {
          const item = document.createElement('sl-menu-item');
          const suffix = Object.values(variant.attrs).join(',');
          item.textContent = `${def.tag}[${suffix}]`;
          item.title = variant.description || def.description || def.label;
          if (!isCurrent) {
            item.addEventListener('click', () => onPick(def, variant.attrs));
          } else {
            item.disabled = true;
          }
          menu.appendChild(item);
        }
        dropdown.appendChild(menu);

        if (!bareAllowed && !isCurrent) {
          // No bare-tag action: clicking the chip body also opens the dropdown.
          chip.addEventListener('click', () => { dropdown.open = true; });
        }

        wrapper.appendChild(dropdown);
      }

      row.appendChild(wrapper);
    }
    container.appendChild(row);
  }
```

- [ ] **Step 7: Rewrite `#retag()` for explicit attribute overrides (lines 368-408)**

Replace:

```javascript
  /**
   * Retags `element` from `currentDef` to `newDef`. If the tag name changes, a new
   * element is created (copying existing attributes) and swapped into the parent, as
   * before; if the tag name is unchanged, `element` is mutated in place. Either way,
   * any attribute key present in `currentDef.defaultAttributes` but absent from
   * `newDef.defaultAttributes` is removed, then `newDef.defaultAttributes` is applied
   * on top. Truly identical tag+defaultAttributes (a genuine no-op) does nothing.
   * @param {Element} element
   * @param {AnnotationTagDef} currentDef
   * @param {AnnotationTagDef} newDef
   */
  async #retag(element, currentDef, newDef) {
    const currentAttrs = currentDef.defaultAttributes ?? {};
    const newAttrs = newDef.defaultAttributes ?? {};
    const tagChanged = element.localName !== newDef.tag;
    const attrsChanged = !this.#attrsEqual(currentAttrs, newAttrs);
    if (!tagChanged && !attrsChanged) return;

    const parent = element.parentNode;
    if (!parent) return;

    let target = element;
    if (tagChanged) {
      const newEl = document.createElementNS(element.namespaceURI, newDef.tag);
      for (const attr of element.attributes) {
        newEl.setAttribute(attr.name, attr.value);
      }
      while (element.firstChild) newEl.appendChild(element.firstChild);
      parent.replaceChild(newEl, element);
      target = newEl;
    }

    for (const key of Object.keys(currentAttrs)) {
      if (!(key in newAttrs)) target.removeAttribute(key);
    }
    for (const [k, v] of Object.entries(newAttrs)) {
      target.setAttribute(k, v);
    }

    await this.#editor.updateEditorFromNode(parent);
  }
```

with:

```javascript
  /**
   * Retags `element` from `currentDef` to `newDef`, applying `attrs` (the
   * chosen variant's attribute-value pairs, or `{}` for a bare-tag pick).
   * If the tag name changes, a new element is created (copying existing
   * attributes) and swapped into the parent; if unchanged, `element` is
   * mutated in place. Either way, any attribute name controlled by
   * `currentDef`'s own variants but absent from `attrs` is removed first
   * (so switching from `bibl[type=decision]` to plain `bibl` doesn't leave
   * a stale `type` attribute behind), then `attrs` is applied on top.
   * @param {Element} element
   * @param {AnnotationTagDef} currentDef
   * @param {AnnotationTagDef} newDef
   * @param {Record<string,string>} attrs
   */
  async #retag(element, currentDef, newDef, attrs) {
    const tagChanged = element.localName !== newDef.tag;
    const currentVariantAttrNames = new Set((currentDef.variants ?? []).flatMap(v => Object.keys(v.attrs)));
    const attrsChanged = [...currentVariantAttrNames].some(name => element.getAttribute(name) !== (attrs[name] ?? null))
      || Object.entries(attrs).some(([k, v]) => element.getAttribute(k) !== v);
    if (!tagChanged && !attrsChanged) return;

    const parent = element.parentNode;
    if (!parent) return;

    let target = element;
    if (tagChanged) {
      const newEl = document.createElementNS(element.namespaceURI, newDef.tag);
      for (const attr of element.attributes) {
        newEl.setAttribute(attr.name, attr.value);
      }
      while (element.firstChild) newEl.appendChild(element.firstChild);
      parent.replaceChild(newEl, element);
      target = newEl;
    }

    for (const name of currentVariantAttrNames) {
      if (!(name in attrs)) target.removeAttribute(name);
    }
    for (const [k, v] of Object.entries(attrs)) {
      target.setAttribute(k, v);
    }

    await this.#editor.updateEditorFromNode(parent);
  }
```

- [ ] **Step 8: Remove the now-unused `#attrsEqual` helper (lines 410-421)**

Delete:

```javascript
  /**
   * Shallow key/value equality check for two `defaultAttributes`-shaped objects.
   * @param {Record<string,string>} a
   * @param {Record<string,string>} b
   * @returns {boolean}
   */
  #attrsEqual(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  }
```

- [ ] **Step 9: Syntax check**

Run: `node --check app/src/modules/codemirror/xml-annotation-popup.js`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add app/src/modules/codemirror/xml-annotation-popup.js
git commit -m "feat: render annotation chips as split-buttons with a variant dropdown"
```

---

### Task 11: Update the annotation plugin (wrap/split with explicit attrs)

**Files:**
- Modify: `app/src/plugins/xml-annotation.js`

- [ ] **Step 1: Update the `AnnotationTagDef` typedef (lines 23-29)**

Replace:

```javascript
/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null,
 *   color: string, attributes?: Array<{name:string, values?: string[]|null}>|null,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null,
 *   childTags?: string[]|null }} AnnotationTagDef
 */
```

with:

```javascript
/**
 * @typedef {{ attrs: Record<string,string>, description?: string|null }} AnnotationTagVariant
 * @typedef {{ tag: string, label: string, color: string,
 *   attributes?: Array<{name:string, values?: string[]|null}>|null,
 *   variants?: AnnotationTagVariant[]|null, bareAllowed?: boolean,
 *   description?: string|null, childTags?: string[]|null }} AnnotationTagDef
 */
```

- [ ] **Step 2: Update the `setWrapCallback` wiring (line 91)**

Replace:

```javascript
      this.#popup.setWrapCallback(def => this.#wrapSelectionWith(def))
```

with:

```javascript
      this.#popup.setWrapCallback((def, attrs) => this.#wrapSelectionWith(def, attrs))
```

- [ ] **Step 3: Update `#wrapSelectionWith` to take explicit attrs (lines 236-271)**

Replace:

```javascript
  /**
   * Wraps the current CM selection in the given annotation tag and re-syncs.
   * If the selection falls inside an existing annotation element whose tag does not
   * list `def.tag` in `childTags`, the parent element is split around the selection
   * instead of nesting the new tag inside it.
   * @param {AnnotationTagDef} def
   */
  async #wrapSelectionWith(def) {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const { from, to } = view.state.selection.main
    if (from === to) return

    const enclosing = this.#findEnclosingAnnotation(view.state, from, to)
    if (enclosing) {
      const parentDefs = this.#tagDefs.filter(d => d.tag === enclosing.tagName)
      const isChildTag = parentDefs.some(d => d.childTags?.includes(def.tag))
      if (!isChildTag) {
        await this.#splitAnnotation(view, from, to, def, enclosing)
        return
      }
    }

    const selectedText = view.state.doc.sliceString(from, to)
    const attrStr = def.defaultAttributes
      ? ' ' + Object.entries(def.defaultAttributes).map(([k, v]) => `${k}="${v}"`).join(' ')
      : ''
    const wrapped = `<${def.tag}${attrStr}>${selectedText}</${def.tag}>`
    view.dispatch({ changes: { from, to, insert: wrapped }, userEvent: 'input.annotate' })
    try {
      const ancestor = this.#xmlEditor.getDomNodeAt?.(from)
      if (ancestor) await this.#xmlEditor.updateEditorFromNode?.(ancestor.parentNode ?? ancestor)
    } catch (e) {
      this.#logger.debug('[xml-annotation] wrap sync failed: ' + String(e))
    }
  }
```

with:

```javascript
  /**
   * Wraps the current CM selection in the given annotation tag (with the
   * given attribute-value pairs — `{}` for a bare-tag pick) and re-syncs.
   * If the selection falls inside an existing annotation element whose tag does not
   * list `def.tag` in `childTags`, the parent element is split around the selection
   * instead of nesting the new tag inside it.
   * @param {AnnotationTagDef} def
   * @param {Record<string,string>} attrs
   */
  async #wrapSelectionWith(def, attrs) {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const { from, to } = view.state.selection.main
    if (from === to) return

    const enclosing = this.#findEnclosingAnnotation(view.state, from, to)
    if (enclosing) {
      const parentDefs = this.#tagDefs.filter(d => d.tag === enclosing.tagName)
      const isChildTag = parentDefs.some(d => d.childTags?.includes(def.tag))
      if (!isChildTag) {
        await this.#splitAnnotation(view, from, to, def, attrs, enclosing)
        return
      }
    }

    const selectedText = view.state.doc.sliceString(from, to)
    const attrStr = Object.keys(attrs).length
      ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')
      : ''
    const wrapped = `<${def.tag}${attrStr}>${selectedText}</${def.tag}>`
    view.dispatch({ changes: { from, to, insert: wrapped }, userEvent: 'input.annotate' })
    try {
      const ancestor = this.#xmlEditor.getDomNodeAt?.(from)
      if (ancestor) await this.#xmlEditor.updateEditorFromNode?.(ancestor.parentNode ?? ancestor)
    } catch (e) {
      this.#logger.debug('[xml-annotation] wrap sync failed: ' + String(e))
    }
  }
```

- [ ] **Step 4: Update `#splitAnnotation` to take explicit attrs (lines 316-349)**

Replace:

```javascript
  /**
   * Splits the enclosing annotation element around the selection [from, to] and
   * applies `def` to the selected text. The text before and after the selection
   * each become separate elements of the original parent type (preserving its
   * open-tag markup including attributes). Empty before/after parts are omitted.
   * @param {import('@codemirror/view').EditorView} view
   * @param {number} from
   * @param {number} to
   * @param {AnnotationTagDef} def
   * @param {{ tagName: string, openTagText: string, contentFrom: number, contentTo: number, elementFrom: number, elementTo: number }} enclosing
   */
  async #splitAnnotation(view, from, to, def, enclosing) {
    const { tagName, openTagText, contentFrom, contentTo, elementFrom, elementTo } = enclosing
    const state = view.state
    const beforeText = state.doc.sliceString(contentFrom, from)
    const selectedText = state.doc.sliceString(from, to)
    const afterText = state.doc.sliceString(to, contentTo)
    const attrStr = def.defaultAttributes
      ? ' ' + Object.entries(def.defaultAttributes).map(([k, v]) => `${k}="${v}"`).join(' ')
      : ''
```

with:

```javascript
  /**
   * Splits the enclosing annotation element around the selection [from, to] and
   * applies `def`/`attrs` to the selected text. The text before and after the selection
   * each become separate elements of the original parent type (preserving its
   * open-tag markup including attributes). Empty before/after parts are omitted.
   * @param {import('@codemirror/view').EditorView} view
   * @param {number} from
   * @param {number} to
   * @param {AnnotationTagDef} def
   * @param {Record<string,string>} attrs
   * @param {{ tagName: string, openTagText: string, contentFrom: number, contentTo: number, elementFrom: number, elementTo: number }} enclosing
   */
  async #splitAnnotation(view, from, to, def, attrs, enclosing) {
    const { tagName, openTagText, contentFrom, contentTo, elementFrom, elementTo } = enclosing
    const state = view.state
    const beforeText = state.doc.sliceString(contentFrom, from)
    const selectedText = state.doc.sliceString(from, to)
    const afterText = state.doc.sliceString(to, contentTo)
    const attrStr = Object.keys(attrs).length
      ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')
      : ''
```

(The rest of `#splitAnnotation`'s body, which uses `attrStr`, is unchanged.)

- [ ] **Step 5: Syntax check**

Run: `node --check app/src/plugins/xml-annotation.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "refactor: pass explicit attribute overrides through wrap/split instead of defaultAttributes"
```

---

### Task 12: Manual verification in the running app

**Files:** none (verification only)

- [ ] **Step 1: Confirm the dev server is already running**

This project's dev server auto-reloads on file changes — do not start or restart it. Ask the user to confirm it's running if unsure.

- [ ] **Step 2: Force a fresh schema + tag regeneration**

Run: `rm -rf data/schema/cache/mpilhlt.github.io` then open the app and load (or re-validate) a `grobid.training.references` document so `schema_validator.py` re-downloads the schema on demand — or call `POST /api/v1/validate/autocomplete-data` with `invalidate_cache: true` per `docs/code-assistant/development-commands.md`'s schema-cache-refresh instructions, for the variant(s) you want to test.

- [ ] **Step 3: Use the `run` skill to drive the app in a browser**

Load a `grobid.training.references` (or `.referenceSegmenter`, or `.segmentation`) document, switch to annotation ("Visual") mode, and check:
- The toolbar shows one chip per tag, alphabetically ordered, each a distinct color.
- A tag with enumerated attributes (e.g. `orgName`, `citedRange`) shows a caret; clicking it opens a dropdown of `tag[value]` items with tooltips.
- `citedRange`'s chip body itself does nothing when clicked directly (only the dropdown works), since `unit` is required in the schema.
- Selecting a dropdown item wraps the selection with that tag and attribute.
- Clicking an existing badge opens the properties popup; its "Change to" section still offers every tag as before, now via the same split-button chips.
- Retagging (via "Change to") from one variant to another (e.g. `bibl[type=decision]` → `bibl` bare) removes the stale `type` attribute.

- [ ] **Step 4: Report findings**

If anything doesn't behave as expected, fix it before proceeding to the final commit — do not mark this task done until the manual check passes.

---

### Task 13: Full test suite run and final commit

**Files:** none (verification only)

- [ ] **Step 1: Run all affected Python unit tests together**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_relaxng_to_codemirror.py tests/unit/fastapi/test_annotation_tag_models.py fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: All PASS.

- [ ] **Step 2: Grep for any remaining references to removed fields**

Run: `grep -rn "defaultAttributes\|labelMap\b" app/src fastapi_app --include="*.js" --include="*.py"`
Expected: no output (everything referencing the removed fields has been updated or deleted). If anything remains, fix it before continuing.

- [ ] **Step 3: Confirm `annotation_tags.py` is gone**

Run: `git status --short fastapi_app/plugins/grobid/config/`
Expected: no `annotation_tags.py` listed as untracked/modified (it was removed in Task 5).

- [ ] **Step 4: Final status check and summary commit if anything is left uncommitted**

Run: `git status --short`
Expected: clean (everything was committed at the end of each task). If anything remains, commit it with a message describing what was missed.
