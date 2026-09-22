# Annotation Guide Vocabulary Fix & Dual-Target Refs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `category="general"` vocabulary ambiguity and add auto-derived machine-targeted (line-range) refs alongside the existing human-targeted (heading-anchor) refs in `editorialDecl`, per the approved design spec.

**Architecture:** Config guides gain a `variant_ids` list (supporting a `"*"` wildcard for cross-variant sharing) and rename their sentinel category from `"general"` to `"primary"`. Each `<interpretation>` can now hold two `<ref>` children distinguished by a new `@subtype` ("human"/"machine"); the machine ref's line-range target is auto-derived from the human ref's heading anchor by fetching the raw document and locating that heading's section span - never hand-authored, so it can't drift out of sync. All of this is generated inside the single shared `build_editorial_decl_entries()` function, so both GROBID extraction and "Refresh Annotation Rules" pick it up automatically with no new wiring.

**Tech Stack:** Python (lxml, TypedDict), JavaScript (DOM traversal, no new dependencies).

**Reference:** [2026-09-22-annotation-guide-dual-target-refs-design.md](../specs/2026-09-22-annotation-guide-dual-target-refs-design.md)

**Note:** `fastapi_app/plugins/grobid/extractor.py` needs **no changes** in this plan - it already calls `build_editorial_decl_entries()` and passes its return value straight through to `create_encoding_desc_with_extractor()`, so it picks up the new behavior automatically once those two functions are updated (Tasks 4-5).

---

### Task 1: Config schema - `variant_ids` and `"primary"` sentinel

**Files:**
- Modify: `fastapi_app/plugins/grobid/config/annotation_guides.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_config.py` (existing file - replace the `TestAnnotationGuidesCategory` class)

- [ ] **Step 1: Write the failing test**

In `fastapi_app/plugins/grobid/tests/test_annotation_config.py`, replace the existing `TestAnnotationGuidesCategory` class (near the end of the file) with:

```python
class TestAnnotationGuidesCategory(unittest.TestCase):
    """Test that every configured guide has a category, variant_ids, and a fossil-hosted URL."""

    def test_every_entry_has_a_category(self):
        from fastapi_app.plugins.grobid.config.annotation_guides import ANNOTATION_GUIDES
        for guide in ANNOTATION_GUIDES:
            self.assertIn("category", guide)
            self.assertTrue(guide["category"])

    def test_every_entry_has_variant_ids(self):
        from fastapi_app.plugins.grobid.config.annotation_guides import ANNOTATION_GUIDES
        for guide in ANNOTATION_GUIDES:
            self.assertIn("variant_ids", guide)
            self.assertIsInstance(guide["variant_ids"], list)
            self.assertTrue(guide["variant_ids"])

    def test_segmentation_guide_points_at_fossil(self):
        from fastapi_app.plugins.grobid.config.annotation_guides import ANNOTATION_GUIDES
        segmentation = [g for g in ANNOTATION_GUIDES if "grobid.training.segmentation" in g["variant_ids"]]
        self.assertEqual(len(segmentation), 1)
        self.assertEqual(segmentation[0]["category"], "primary")
        self.assertIn("github.com/mpilhlt/fossil", segmentation[0]["url"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: FAIL - `KeyError: 'variant_ids'` (the config still uses `variant_id`), and the segmentation category assertion fails (`'general' != 'primary'`)

- [ ] **Step 3: Implement**

Replace the entire contents of `fastapi_app/plugins/grobid/config/annotation_guides.py`:

```python
"""Annotation guide URLs for GROBID variants.

Each entry names the variant(s) it applies to (`variant_ids`; the literal
"*" means "every variant") and the rule category it belongs to ("primary"
is the sentinel for the per-variant main section a human annotator should
read; other categories are optional, machine-only excerpts for LLM
validation). URLs are branch-relative GitHub blob links; they get
permalink-pinned to a commit SHA when embedded into a document's
editorialDecl, and a heading-anchor URL additionally gets an auto-derived
machine-targeted (line-range) sibling ref - see
fastapi_app/plugins/grobid/annotation_rules.py and
docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md.
"""

from typing import Literal, TypedDict


class AnnotationGuide(TypedDict):
    """A link to an annotation guide for one or more variants and a rule category."""

    variant_ids: list[str]
    category: str
    type: Literal["markdown", "html"]
    url: str


ANNOTATION_GUIDES: list[AnnotationGuide] = [
    {
        "variant_ids": ["grobid.training.segmentation"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#document-segmentation-model",
    },
    {
        "variant_ids": ["grobid.training.references.referenceSegmenter"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#reference-segmentation-model",
    },
    {
        "variant_ids": ["grobid.training.references"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#citation-model",
    },
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/config/annotation_guides.py fastapi_app/plugins/grobid/tests/test_annotation_config.py
git commit -m "feat: rename annotation guide category sentinel to 'primary', add variant_ids

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Heading-scan and anchor-to-line-range translation

**Files:**
- Modify: `fastapi_app/lib/utils/annotation_rules_utils.py` (insert after `fetch_rule_excerpt`, before the `TEI_NS = ...` line)
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py` (existing file - extend)

- [ ] **Step 1: Write the failing tests**

In `tests/unit/fastapi/test_annotation_rules_utils.py`, change the import block at the top from:

```python
from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
    resolve_forge_permalink,
)
```

to:

```python
from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
    is_line_range_fragment,
    resolve_forge_permalink,
    translate_anchor_to_line_range,
)
```

Then add these classes and fixtures anywhere after the imports (e.g. right before `class TestExtractAnnotationRuleRefs`):

```python
class TestIsLineRangeFragment(unittest.TestCase):
    def test_recognizes_github_style_range(self):
        self.assertTrue(is_line_range_fragment("L10-L50"))

    def test_recognizes_gitlab_style_range(self):
        self.assertTrue(is_line_range_fragment("L10-50"))

    def test_recognizes_single_line(self):
        self.assertTrue(is_line_range_fragment("L7"))

    def test_rejects_heading_anchor(self):
        self.assertFalse(is_line_range_fragment("document-segmentation-model"))


SAMPLE_DOC = """# Document Segmentation Model

Some intro text about segmentation.

## Details

More details here.

# Citation Model

Citation content.
"""

DUPLICATE_HEADINGS_DOC = """# Notes

First.

# Notes

Second.
"""


class TestTranslateAnchorToLineRange(unittest.TestCase):
    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_top_level_section_spans_to_next_same_level_heading(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        result = translate_anchor_to_line_range("https://example.com/g.md", "document-segmentation-model", cache)
        self.assertEqual(result, (1, 8))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_subsection_bounded_by_next_shallower_heading_not_its_own_children(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        result = translate_anchor_to_line_range("https://example.com/g.md", "details", cache)
        self.assertEqual(result, (5, 8))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_last_section_spans_to_end_of_file(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        result = translate_anchor_to_line_range("https://example.com/g.md", "citation-model", cache)
        self.assertEqual(result, (9, 11))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_deduplicates_repeated_heading_slugs_like_github(self, mock_fetch):
        mock_fetch.return_value = DUPLICATE_HEADINGS_DOC
        cache = MagicMock()
        self.assertEqual(translate_anchor_to_line_range("https://example.com/g.md", "notes", cache), (1, 4))
        self.assertEqual(translate_anchor_to_line_range("https://example.com/g.md", "notes-1", cache), (5, 7))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_returns_none_when_anchor_not_found(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        with self.assertLogs("fastapi_app.lib.utils.annotation_rules_utils", level="WARNING"):
            result = translate_anchor_to_line_range("https://example.com/g.md", "does-not-exist", cache)
        self.assertIsNone(result)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_returns_none_when_fetch_fails(self, mock_fetch):
        mock_fetch.side_effect = RuleFetchError("boom")
        cache = MagicMock()
        with self.assertLogs("fastapi_app.lib.utils.annotation_rules_utils", level="WARNING"):
            result = translate_anchor_to_line_range("https://example.com/g.md", "document-segmentation-model", cache)
        self.assertIsNone(result)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: FAIL - `ImportError: cannot import name 'is_line_range_fragment'`

- [ ] **Step 3: Implement**

In `fastapi_app/lib/utils/annotation_rules_utils.py`, insert this block after `fetch_rule_excerpt`'s closing (its last line is `return "\n".join(lines[start_idx:end_idx])`), before the `TEI_NS = "http://www.tei-c.org/ns/1.0"` line:

```python
def is_line_range_fragment(fragment: str) -> bool:
    """True if `fragment` matches a line-range anchor (GitHub's #L10-L50 or GitLab's #L10-50)."""
    return bool(_LINE_RANGE_RE.match(fragment))


_ATX_HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*#*$')
_SLUG_STRIP_RE = re.compile(r'[^\w\s-]')
_SLUG_WHITESPACE_RE = re.compile(r'\s+')


class _Heading(TypedDict):
    line: int
    level: int
    slug: str


def _slugify_heading(title: str) -> str:
    """
    Compute a GitHub-style heading anchor slug: lowercase, strip characters
    that aren't word characters/spaces/hyphens, then collapse whitespace to
    single hyphens.
    """
    slug = title.strip().lower()
    slug = _SLUG_STRIP_RE.sub("", slug)
    slug = _SLUG_WHITESPACE_RE.sub("-", slug)
    return slug


def _scan_markdown_headings(text: str) -> list[_Heading]:
    """
    Scan ATX-style Markdown headings ("# Title", "## Title", ...), returning
    each with its 1-based line number, level, and GitHub-style anchor slug.
    Repeated slugs are de-duplicated with a "-1", "-2", ... suffix, matching
    GitHub's own anchor-generation behavior.
    """
    seen: dict[str, int] = {}
    headings: list[_Heading] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        match = _ATX_HEADING_RE.match(line)
        if not match:
            continue
        level = len(match.group(1))
        slug = _slugify_heading(match.group(2))
        if slug in seen:
            seen[slug] += 1
            slug = f"{slug}-{seen[slug]}"
        else:
            seen[slug] = 0
        headings.append({"line": line_no, "level": level, "slug": slug})
    return headings


def translate_anchor_to_line_range(url: str, anchor: str, cache: UrlCache) -> Optional[tuple[int, int]]:
    """
    Find the 1-based, inclusive line range a Markdown heading anchor covers.

    `url` must have no fragment (the whole document is fetched). The range
    spans from the matched heading's own line to the line before the next
    heading at the same or shallower level (or end of file if there is
    none), so a subsection's own sub-headings never bound its parent's
    range. See
    docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md
    for the rationale.

    Returns None (never raises) if the anchor isn't found among the
    document's headings, or if fetching/parsing the document fails for any
    reason - callers should skip generating a machine-targeted ref in that
    case rather than fail extraction/refresh.
    """
    try:
        text = fetch_rule_excerpt(url, cache)
    except Exception as e:
        logger.warning(f"Could not fetch {url} to translate anchor '{anchor}': {e}", exc_info=True)
        return None

    headings = _scan_markdown_headings(text)
    matched_index = next((i for i, h in enumerate(headings) if h["slug"] == anchor), None)
    if matched_index is None:
        logger.warning(f"Heading anchor '{anchor}' not found in {url}; no machine-targeted ref generated")
        return None

    matched = headings[matched_index]
    end_line = len(text.splitlines())
    for later in headings[matched_index + 1:]:
        if later["level"] <= matched["level"]:
            end_line = later["line"] - 1
            break

    return (matched["line"], end_line)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/annotation_rules_utils.py tests/unit/fastapi/test_annotation_rules_utils.py
git commit -m "feat: add Markdown heading-to-line-range translation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `AnnotationRuleRef`/`AnnotationRuleRefTarget` shape change

**Files:**
- Modify: `fastapi_app/lib/utils/annotation_rules_utils.py`
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py` (existing file - replace `TestExtractAnnotationRuleRefs`)

- [ ] **Step 1: Write the failing tests**

In `tests/unit/fastapi/test_annotation_rules_utils.py`, replace the entire `TestExtractAnnotationRuleRefs` class with:

```python
class TestExtractAnnotationRuleRefs(unittest.TestCase):
    def test_extracts_human_and_machine_refs_for_one_interpretation(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="human" target="https://example.com/guidelines.md#segmentation" type="markdown"/>
            <ref subtype="machine" target="https://example.com/guidelines.md#L1-L20" type="markdown"/>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(refs, [
            {
                "category": "primary",
                "refs": [
                    {"target": "https://example.com/guidelines.md#segmentation", "content_type": "markdown", "subtype": "human"},
                    {"target": "https://example.com/guidelines.md#L1-L20", "content_type": "markdown", "subtype": "machine"},
                ],
            },
        ])

    def test_extracts_multiple_interpretations(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/guidelines.md#segmentation" type="markdown"/></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref subtype="machine" target="https://example.com/guidelines.md#L120-L180" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0]["category"], "primary")
        self.assertEqual(refs[1]["category"], "footnote-annotation")

    def test_returns_empty_list_when_no_editorial_decl(self):
        xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_returns_empty_list_for_malformed_xml(self):
        self.assertEqual(extract_annotation_rule_refs("<not><valid"), [])

    def test_skips_interpretation_missing_type_attribute(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation>
          <p><ref subtype="human" target="https://example.com/g.md" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_skips_interpretation_whose_only_ref_is_missing_target(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_skips_ref_with_unrecognized_subtype_but_keeps_others(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="robot" target="https://example.com/g.md#odd" type="markdown"/>
            <ref subtype="human" target="https://example.com/g.md#seg" type="markdown"/>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 1)
        self.assertEqual(len(refs[0]["refs"]), 1)
        self.assertEqual(refs[0]["refs"][0]["subtype"], "human")

    def test_skips_interpretation_whose_only_ref_has_missing_subtype(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref target="https://example.com/g.md" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_content_type_is_none_when_ref_type_absent(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/g.md"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 1)
        self.assertIsNone(refs[0]["refs"][0]["content_type"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: FAIL - `KeyError: 'refs'` (the old flat `AnnotationRuleRef` shape has `target`/`content_type` directly, not a `refs` list)

- [ ] **Step 3: Implement**

In `fastapi_app/lib/utils/annotation_rules_utils.py`, change the `typing` import line from:

```python
from typing import Optional, TypedDict
```

to:

```python
from typing import Literal, Optional, TypedDict
```

Then replace the `AnnotationRuleRef` class and `extract_annotation_rule_refs` function (the whole block from `class AnnotationRuleRef(TypedDict):` to the end of the file) with:

```python
class AnnotationRuleRefTarget(TypedDict):
    """
    One <ref> within an editorialDecl/interpretation.

    "target" is the ref's permalink-pinned URL; "content_type" is its own
    @type ("markdown"/"html", or None if absent); "subtype" distinguishes a
    "human" ref (a heading-anchor URL for the drawer) from an auto-derived
    "machine" ref (a line-range URL for token-bounded fetching) - see
    docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md.
    """

    target: str
    content_type: Optional[str]
    subtype: Literal["human", "machine"]


class AnnotationRuleRef(TypedDict):
    """
    One editorialDecl/interpretation entry: a rule category and its one or two refs.

    "category" is interpretation/@type (e.g. "primary", "footnote-annotation").
    """

    category: str
    refs: list[AnnotationRuleRefTarget]


def extract_annotation_rule_refs(xml_string: str) -> list[AnnotationRuleRef]:
    """
    Parse a TEI document's editorialDecl/interpretation entries.

    An interpretation missing its @type is skipped, as is any <ref> within
    it missing @target or whose @subtype isn't "human" or "machine" - such
    a document is malformed with respect to this app's own conventions, but
    extraction/validation elsewhere already guards against producing such
    documents, so this is treated as "nothing usable here" rather than
    raised. An interpretation whose @type is present but which ends up with
    no usable refs is also skipped entirely (not returned with an empty
    refs list). Returns an empty list if the document has no editorialDecl
    or is not well-formed XML.
    """
    try:
        root = etree.fromstring(xml_string.encode("utf-8"))
    except etree.XMLSyntaxError:
        return []

    ns = {"tei": TEI_NS}
    results: list[AnnotationRuleRef] = []
    for interpretation in root.findall(".//tei:editorialDecl/tei:interpretation", ns):
        category = interpretation.get("type")
        if category is None:
            continue

        refs: list[AnnotationRuleRefTarget] = []
        for ref in interpretation.findall(".//tei:ref", ns):
            target = ref.get("target")
            subtype_raw = ref.get("subtype")
            if target is None:
                continue
            if subtype_raw == "human":
                subtype: Literal["human", "machine"] = "human"
            elif subtype_raw == "machine":
                subtype = "machine"
            else:
                continue
            refs.append({
                "target": target,
                "content_type": ref.get("type"),
                "subtype": subtype,
            })

        if not refs:
            continue
        results.append({"category": category, "refs": refs})
    return results
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/annotation_rules_utils.py tests/unit/fastapi/test_annotation_rules_utils.py
git commit -m "feat: AnnotationRuleRef holds multiple subtype-distinguished refs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `create_encoding_desc_with_extractor()` emits multiple refs per interpretation

**Files:**
- Modify: `fastapi_app/lib/utils/tei_utils.py`
- Test: `tests/unit/fastapi/test_create_encoding_desc_with_extractor.py` (existing file - full rewrite)
- Test fix: `fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py` (existing file - one test's mock shape needs updating; this test is not the primary coverage for this task, but it will break otherwise)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/unit/fastapi/test_create_encoding_desc_with_extractor.py`:

```python
"""
Unit tests for create_encoding_desc_with_extractor()'s editorialDecl output.

@testCovers fastapi_app/lib/utils/tei_utils.py
"""

import unittest

from lxml import etree

from fastapi_app.lib.utils.tei_utils import create_encoding_desc_with_extractor

NS = {"tei": "http://www.tei-c.org/ns/1.0"}


class TestEditorialDeclEntries(unittest.TestCase):
    def _build(self, editorial_decl_entries=None):
        encoding_desc = create_encoding_desc_with_extractor(
            timestamp="2026-01-01T00:00:00Z",
            extractor_name="GROBID",
            extractor_ident="GROBID",
            variant_id="grobid.training.segmentation",
            editorial_decl_entries=editorial_decl_entries,
        )
        # create_encoding_desc_with_extractor returns an unnamespaced element;
        # wrap it in a namespaced root so XPath with the tei: prefix resolves.
        wrapper = etree.Element("{http://www.tei-c.org/ns/1.0}teiHeader")
        wrapper.append(encoding_desc)
        return wrapper

    def test_no_editorial_decl_when_entries_omitted(self):
        header = self._build(editorial_decl_entries=None)
        self.assertIsNone(header.find(".//editorialDecl"))

    def test_no_editorial_decl_when_entries_empty(self):
        header = self._build(editorial_decl_entries=[])
        self.assertIsNone(header.find(".//editorialDecl"))

    def test_editorial_decl_precedes_app_info(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
            ]},
        ])
        encoding_desc = header.find("encodingDesc")
        children = list(encoding_desc)
        self.assertEqual(children[0].tag, "editorialDecl")
        self.assertEqual(children[1].tag, "appInfo")

    def test_one_interpretation_per_entry(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
            ]},
            {"category": "footnote-annotation", "refs": [
                {"target": "https://example.com/g.md#L1-L2", "content_type": "markdown", "subtype": "machine"},
            ]},
        ])
        interpretations = header.findall(".//editorialDecl/interpretation")
        self.assertEqual(len(interpretations), 2)
        self.assertEqual(interpretations[0].get("type"), "primary")
        self.assertEqual(interpretations[1].get("type"), "footnote-annotation")

    def test_two_refs_per_interpretation_carry_subtype(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
                {"target": "https://example.com/g.md#L1-L20", "content_type": "markdown", "subtype": "machine"},
            ]},
        ])
        refs = header.findall(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0].get("target"), "https://example.com/g.md#seg")
        self.assertEqual(refs[0].get("subtype"), "human")
        self.assertEqual(refs[1].get("target"), "https://example.com/g.md#L1-L20")
        self.assertEqual(refs[1].get("subtype"), "machine")

    def test_ref_carries_target_and_content_type(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": "markdown", "subtype": "human"},
            ]},
        ])
        ref = header.find(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(ref.get("target"), "https://example.com/g.md#seg")
        self.assertEqual(ref.get("type"), "markdown")

    def test_ref_without_content_type(self):
        """Test that a None content_type doesn't break or add an empty type attribute."""
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.com/g.md#seg", "content_type": None, "subtype": "human"},
            ]},
        ])
        ref = header.find(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(ref.get("target"), "https://example.com/g.md#seg")
        self.assertIsNone(ref.get("type"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py -v`
Expected: FAIL - `KeyError: 'refs'`

- [ ] **Step 3: Implement**

In `fastapi_app/lib/utils/tei_utils.py`, replace the editorialDecl-building block inside `create_encoding_desc_with_extractor`:

```python
    if editorial_decl_entries:
        editorialDecl = etree.SubElement(encodingDesc, "editorialDecl")
        for entry in editorial_decl_entries:
            interpretation = etree.SubElement(editorialDecl, "interpretation", type=entry["category"])
            p = etree.SubElement(interpretation, "p")
            ref = etree.SubElement(p, "ref", target=entry["target"])
            if entry.get("content_type") is not None:
                ref.set("type", entry["content_type"])
```

with:

```python
    if editorial_decl_entries:
        editorialDecl = etree.SubElement(encodingDesc, "editorialDecl")
        for entry in editorial_decl_entries:
            interpretation = etree.SubElement(editorialDecl, "interpretation", type=entry["category"])
            p = etree.SubElement(interpretation, "p")
            for ref_entry in entry["refs"]:
                ref = etree.SubElement(p, "ref", target=ref_entry["target"], subtype=ref_entry["subtype"])
                if ref_entry.get("content_type") is not None:
                    ref.set("type", ref_entry["content_type"])
```

Also update the function's docstring: change the `editorial_decl_entries` Args line from:

```
        editorial_decl_entries: Optional list of AnnotationRuleRef entries (as
            returned by annotation_rules_utils.extract_annotation_rule_refs()),
            one per <interpretation> to emit. Omitted or empty: no editorialDecl is added.
```

to:

```
        editorial_decl_entries: Optional list of AnnotationRuleRef entries (as
            returned by annotation_rules_utils.extract_annotation_rule_refs()),
            one per <interpretation> to emit, each holding one or two <ref>
            children (a "human" heading-anchor ref and/or an auto-derived
            "machine" line-range ref). Omitted or empty: no editorialDecl is
            added.
```

And update the docstring's example (the `editorial_decl_entries=[...]` line in the `Examples:` section) from:

```
        ...     editorial_decl_entries=[
        ...         {"category": "general", "target": "https://example.com/guide.md#seg", "content_type": "markdown"},
        ...     ],
```

to:

```
        ...     editorial_decl_entries=[
        ...         {"category": "primary", "refs": [
        ...             {"target": "https://example.com/guide.md#seg", "content_type": "markdown", "subtype": "human"},
        ...         ]},
        ...     ],
```

Then, in `fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py`, fix `test_returned_entries_are_wired_into_encoding_desc`'s mock so it matches the new shape - change:

```python
        mock_build.return_value = [
            {"category": "general", "target": "https://example.org/guide", "content_type": "markdown"},
        ]
```

to:

```python
        mock_build.return_value = [
            {"category": "general", "refs": [
                {"target": "https://example.org/guide", "content_type": "markdown", "subtype": "human"},
            ]},
        ]
```

(The rest of that test is unchanged - it still asserts `ref.get("target") == "https://example.org/guide"` on the first `<ref>` found.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py -v`
Expected: PASS

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py -v`
Expected: PASS (all 3 tests, including the one just fixed)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/tei_utils.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py
git commit -m "feat: create_encoding_desc_with_extractor emits multiple refs per interpretation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `build_editorial_decl_entries()` - variant_ids matching and dual-ref generation

**Files:**
- Modify: `fastapi_app/plugins/grobid/annotation_rules.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules.py` (existing file - full rewrite)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`:

```python
"""
Unit tests for fastapi_app/plugins/grobid/annotation_rules.py.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v

@testCovers fastapi_app/plugins/grobid/annotation_rules.py
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.plugins.grobid.annotation_rules import build_editorial_decl_entries


class TestBuildEditorialDeclEntriesVariantMatching(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_matches_variant_listed_explicitly(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())
        self.assertEqual(len(entries), 1)

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_wildcard_matches_any_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["*"], "category": "house-style",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.header", MagicMock())
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["category"], "house-style")

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_returns_empty_list_for_unconfigured_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md"},
        ]
        entries = build_editorial_decl_entries("grobid.training.header", MagicMock())
        self.assertEqual(entries, [])
        mock_resolve.assert_not_called()


class TestBuildRefsForGuideShapeTable(unittest.TestCase):
    """
    Exercises the four ref-generation shapes documented in
    annotation_rules.py's _build_refs_for_guide(): no fragment, an
    already-machine line-range fragment, a heading-anchor with type "html",
    and a heading-anchor with type "markdown" (which additionally attempts
    translation to a machine ref).
    """

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_no_fragment_produces_human_only(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("v1", MagicMock())
        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md", "content_type": "markdown", "subtype": "human"},
            ]},
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_line_range_fragment_produces_machine_only(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "footnote-annotation", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md#L10-L50"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("v1", MagicMock())
        self.assertEqual(entries, [
            {"category": "footnote-annotation", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md#L10-L50", "content_type": "markdown", "subtype": "machine"},
            ]},
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_heading_anchor_with_html_type_produces_human_only(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "html",
             "url": "https://example.com/docs/g.html#section"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("v1", MagicMock())
        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://example.com/docs/g.html#section", "content_type": "html", "subtype": "human"},
            ]},
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.translate_anchor_to_line_range")
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_heading_anchor_with_markdown_type_produces_both_refs(
        self, mock_get_guides, mock_resolve, mock_translate
    ):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md#segmentation"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")
        mock_translate.return_value = (10, 40)

        entries = build_editorial_decl_entries("v1", MagicMock())

        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md#segmentation", "content_type": "markdown", "subtype": "human"},
                {"target": "https://github.com/x/y/blob/sha1/g.md#L10-L40", "content_type": "markdown", "subtype": "machine"},
            ]},
        ])
        mock_translate.assert_called_once()
        call_args = mock_translate.call_args[0]
        self.assertEqual(call_args[0], "https://github.com/x/y/blob/sha1/g.md")
        self.assertEqual(call_args[1], "segmentation")

    @patch("fastapi_app.plugins.grobid.annotation_rules.translate_anchor_to_line_range")
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_heading_anchor_with_markdown_type_falls_back_to_human_only_when_anchor_not_found(
        self, mock_get_guides, mock_resolve, mock_translate
    ):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md#segmentation"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")
        mock_translate.return_value = None

        entries = build_editorial_decl_entries("v1", MagicMock())

        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md#segmentation", "content_type": "markdown", "subtype": "human"},
            ]},
        ])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: FAIL - `KeyError: 'variant_ids'` and `ImportError: cannot import name 'translate_anchor_to_line_range'` (patch targets don't exist yet in `annotation_rules.py`)

- [ ] **Step 3: Implement**

Replace the entire contents of `fastapi_app/plugins/grobid/annotation_rules.py`:

```python
"""
Resolves this plugin's annotation-guide config into editorialDecl-ready
entries, shared by extraction-time generation (extractor.py) and the
"Refresh Annotation Rules" reviewer action (annotation_rules_refresh.py) so
both regenerate editorialDecl the same way. See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Parts B and G) and
docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md
(the variant_ids/"primary" schema and dual human/machine refs).
"""

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    is_line_range_fragment,
    resolve_forge_permalink,
    translate_anchor_to_line_range,
)
from fastapi_app.plugins.grobid.config import AnnotationGuide, get_annotation_guides


def build_editorial_decl_entries(variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
    """
    Resolve this variant's configured annotation guides into editorialDecl entries.

    A guide matches `variant_id` if its `variant_ids` list contains that id
    or the wildcard "*" (applies to every variant). Each matching guide
    produces one or two refs depending on its configured url/type - see
    _build_refs_for_guide(). "primary" is the category sentinel the
    frontend drawer looks up by default. Returns [] if no guides are
    configured for this variant.
    """
    entries: list[AnnotationRuleRef] = []
    for guide in get_annotation_guides():
        if variant_id not in guide["variant_ids"] and "*" not in guide["variant_ids"]:
            continue
        refs = _build_refs_for_guide(guide, cache)
        entries.append({"category": guide["category"], "refs": refs})
    return entries


def _build_refs_for_guide(guide: AnnotationGuide, cache: UrlCache) -> list[AnnotationRuleRefTarget]:
    """
    Build the one or two refs a single configured guide produces, permalink-
    pinning every target. Which refs are generated depends on the
    configured url's fragment shape and content type:

    - No fragment (whole document): a single "human" ref, unchanged.
    - An already-machine-style line-range fragment (#L10-L50): a single
      "machine" ref, unchanged - this is how a purely machine-oriented
      topic (e.g. "footnote-annotation") stays configurable without ever
      needing a human-facing anchor.
    - A heading-anchor fragment with type "html": a single "human" ref -
      there's no heading/line-range concept for HTML.
    - A heading-anchor fragment with type "markdown": both a "human" ref
      (as configured) and an auto-derived "machine" ref (a line range
      covering that heading's section, computed by
      annotation_rules_utils.translate_anchor_to_line_range). If the anchor
      can't be found in the fetched document, only the "human" ref is
      returned - this never fails extraction/refresh, matching this
      feature's established error-handling philosophy.
    """
    base_url, _, fragment = guide["url"].partition("#")
    content_type = guide["type"]

    if not fragment:
        human_target = resolve_forge_permalink(guide["url"], cache)
        return [{"target": human_target, "content_type": content_type, "subtype": "human"}]

    if is_line_range_fragment(fragment):
        machine_target = resolve_forge_permalink(guide["url"], cache)
        return [{"target": machine_target, "content_type": content_type, "subtype": "machine"}]

    human_target = resolve_forge_permalink(guide["url"], cache)
    refs: list[AnnotationRuleRefTarget] = [
        {"target": human_target, "content_type": content_type, "subtype": "human"},
    ]
    if content_type == "markdown":
        pinned_base = resolve_forge_permalink(base_url, cache)
        line_range = translate_anchor_to_line_range(pinned_base, fragment, cache)
        if line_range is not None:
            start, end = line_range
            refs.append({
                "target": f"{pinned_base}#L{start}-L{end}",
                "content_type": content_type,
                "subtype": "machine",
            })
    return refs
```

Before finishing this task, verify `AnnotationGuide` is actually importable from `fastapi_app.plugins.grobid.config` (its `__init__.py` re-exports it alongside `get_annotation_guides`) - if that import fails, import it from `fastapi_app.plugins.grobid.config.annotation_guides` instead and adjust the `from ... import` line accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: PASS

Also run the full grobid Python suite to confirm nothing else broke:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/annotation_rules.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py
git commit -m "feat: build_editorial_decl_entries matches variant_ids and generates dual refs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `_replace_editorial_decl()` emits multiple refs per interpretation

**Files:**
- Modify: `fastapi_app/plugins/grobid/annotation_rules_refresh.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py` (existing file - full rewrite)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py`:

```python
"""
Unit tests for fastapi_app/plugins/grobid/annotation_rules_refresh.py.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v

@testCovers fastapi_app/plugins/grobid/annotation_rules_refresh.py
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.plugins.grobid.annotation_rules_refresh import (
    RefreshPreconditionError,
    RefreshResult,
    RefreshTarget,
    perform_refresh,
    render_error_html,
    render_precondition_error_html,
    render_preview_html,
    render_result_html,
    resolve_refresh_target,
)

TEI_TEMPLATE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="model">segmentation</label>
          <label type="flavor">default</label>
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""


# Mismatched <p>/</div> tags: lenient-parseable (parse_encoding_labels(),
# which uses etree.XMLParser(recover=True), extracts labels from it fine)
# but not strictly well-formed, so plain etree.fromstring() raises
# XMLSyntaxError. Used to exercise perform_refresh()'s conversion of that
# into a RuntimeError.
MALFORMED_TEI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</div></body></text>
</TEI>
"""


def make_tei_file(stable_id="tei-1", file_id="hash-old"):
    content = TEI_TEMPLATE.encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content),
    )
    return meta, content


class TestResolveRefreshTarget(unittest.TestCase):
    def setUp(self):
        self.file_repo = mock.MagicMock()
        self.file_storage = mock.MagicMock()
        self.user = {"username": "reviewer1"}

    def test_raises_when_no_file(self):
        self.file_repo.get_file_by_stable_id.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "missing", self.user)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_raises_when_no_variant_label(self, _mock_access):
        meta, _content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = b'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=False)
    def test_raises_when_permission_denied(self, _mock_access):
        meta, content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.file_storage.read_file.assert_not_called()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_raises_when_content_missing(self, _mock_access):
        meta, _content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_resolves_valid_target(self, _mock_access):
        meta, content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content

        target = resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.assertEqual(target.variant_id, "grobid.training.segmentation")
        self.assertEqual(target.file_meta, meta)


class TestPerformRefresh(unittest.IsolatedAsyncioTestCase):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_replaces_editorial_decl_and_adds_change(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        result = await perform_refresh(target, file_repo, file_storage, "reviewer1")

        self.assertTrue(result.changed)
        self.assertEqual(result.entry_count, 1)

        saved_bytes = file_storage.save_file.call_args[0][0]
        saved_content = saved_bytes.decode("utf-8")
        self.assertIn("newsha", saved_content)
        self.assertNotIn("oldsha", saved_content)
        self.assertIn("Updated annotation rules reference", saved_content)
        file_repo.update_file.assert_called_once()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_preserves_both_human_and_machine_refs(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#L1-L20",
                 "content_type": "markdown", "subtype": "machine"},
            ]},
        ]

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        await perform_refresh(target, file_repo, file_storage, "reviewer1")

        saved_bytes = file_storage.save_file.call_args[0][0]
        saved_content = saved_bytes.decode("utf-8")
        self.assertIn('subtype="human"', saved_content)
        self.assertIn('subtype="machine"', saved_content)
        self.assertIn("#L1-L20", saved_content)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_removes_editorial_decl_when_entries_now_empty(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = []

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        result = await perform_refresh(target, file_repo, file_storage, "reviewer1")

        self.assertTrue(result.changed)
        self.assertEqual(result.entry_count, 0)

        saved_bytes = file_storage.save_file.call_args[0][0]
        saved_content = saved_bytes.decode("utf-8")
        self.assertNotIn("editorialDecl", saved_content)
        file_repo.update_file.assert_called_once()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_raises_runtime_error_on_malformed_xml(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        meta, _content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=MALFORMED_TEI, variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        with self.assertRaises(RuntimeError):
            await perform_refresh(target, file_repo, file_storage, "reviewer1")

        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_no_write_when_unchanged(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        result = await perform_refresh(target, file_repo, file_storage, "reviewer1")

        self.assertFalse(result.changed)
        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()


class TestRenderHtml(unittest.TestCase):
    def test_render_precondition_error_html_escapes_message(self):
        html = render_precondition_error_html("<script>alert(1)</script>")
        self.assertNotIn("<script>alert(1)</script>", html)

    def test_render_preview_html_includes_variant(self):
        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")
        html = render_preview_html(target)
        self.assertIn("grobid.training.segmentation", html)

    def test_render_result_html_includes_message(self):
        result = RefreshResult(entry_count=1, changed=True)
        html = render_result_html(result)
        self.assertIn("updated", html.lower())

    def test_render_error_html_escapes_message(self):
        html = render_error_html("<b>boom</b>")
        self.assertNotIn("<b>boom</b>", html)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v`
Expected: FAIL - `KeyError: 'refs'` in `_replace_editorial_decl` (still expects the old flat entry shape)

- [ ] **Step 3: Implement**

In `fastapi_app/plugins/grobid/annotation_rules_refresh.py`, replace the ref-building loop inside `_replace_editorial_decl`:

```python
    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        ref = etree.SubElement(p, f"{{{TEI_NS}}}ref", target=entry["target"])
        content_type = entry["content_type"]
        if content_type is not None:
            ref.set("type", content_type)
    encoding_desc.insert(0, editorial_decl)
```

with:

```python
    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        for ref_entry in entry["refs"]:
            ref = etree.SubElement(p, f"{{{TEI_NS}}}ref", target=ref_entry["target"], subtype=ref_entry["subtype"])
            content_type = ref_entry["content_type"]
            if content_type is not None:
                ref.set("type", content_type)
    encoding_desc.insert(0, editorial_decl)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v`
Expected: PASS

Also run the full grobid Python suite and the JS backend test runner:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests -v`
Expected: PASS

Run: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/annotation_rules_refresh.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py
git commit -m "feat: annotation-rules refresh emits multiple refs per interpretation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `getEditorialDeclGuides()` returns multiple subtype-distinguished refs

**Files:**
- Modify: `app/src/modules/tei-utils.js`
- Test: `tests/unit/js/tei-utils.test.js` (existing file - replace the `getEditorialDeclGuides` describe block)

- [ ] **Step 1: Write the failing tests**

In `tests/unit/js/tei-utils.test.js`, replace the entire `describe('getEditorialDeclGuides', () => { ... })` block (starting at the top of the file, right after the imports) with:

```js
describe('getEditorialDeclGuides', () => {
  function parseXml(xmlString) {
    const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
    return dom.window.document;
  }

  it('returns human and machine refs for one interpretation', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref>
            <ref subtype="machine" target="https://example.com/g.md#L1-L20" type="markdown">Guide</ref>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.strictEqual(guides.length, 1);
    assert.deepStrictEqual(guides[0], {
      category: 'primary',
      refs: [
        { target: 'https://example.com/g.md#seg', contentType: 'markdown', subtype: 'human' },
        { target: 'https://example.com/g.md#L1-L20', contentType: 'markdown', subtype: 'machine' },
      ]
    });
  });

  it('returns multiple interpretations', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref subtype="machine" target="https://example.com/g.md#L120-L180" type="markdown">Footnotes</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.strictEqual(guides.length, 2);
    assert.strictEqual(guides[0].category, 'primary');
    assert.strictEqual(guides[1].category, 'footnote-annotation');
  });

  it('returns an empty array when there is no editorialDecl', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('returns contentType: null when a ref has no type attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/g.md#seg">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.deepStrictEqual(guides, [
      { category: 'primary', refs: [
        { target: 'https://example.com/g.md#seg', contentType: null, subtype: 'human' }
      ] }
    ]);
  });

  it('skips an interpretation missing its type attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation>
          <p><ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('skips an interpretation whose only ref has no target attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('skips a ref with an unrecognized subtype but keeps its sibling', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="robot" target="https://example.com/g.md#odd" type="markdown">Odd</ref>
            <ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.strictEqual(guides.length, 1);
    assert.strictEqual(guides[0].refs.length, 1);
    assert.strictEqual(guides[0].refs[0].subtype, 'human');
  });

  it('skips an interpretation whose only ref has a missing subtype attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('throws for a plain object argument lacking getElementsByTagName', () => {
    assert.throws(() => getEditorialDeclGuides({}));
    assert.throws(() => getEditorialDeclGuides('not a document'));
  });

  it('throws for a non-XML-document argument', () => {
    assert.throws(() => getEditorialDeclGuides(null));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/tei-utils.test.js`
Expected: FAIL - the "returns human and machine refs" test fails because the current implementation only reads the first `<ref>` and returns a flat `{category, target, contentType}` shape

- [ ] **Step 3: Implement**

In `app/src/modules/tei-utils.js`, replace the entire `getEditorialDeclGuides` function (its JSDoc header and body) with:

```js
/**
 * Extracts annotation-rules references from a TEI document's editorialDecl.
 *
 * Reads `editorialDecl/interpretation[@type]` entries, each containing one
 * or two nested `<ref>` descendants distinguished by `@subtype` ("human":
 * a heading-anchor URL for the drawer; "machine": an auto-derived
 * line-range URL for token-bounded fetching) - see
 * docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md.
 * The interpretation's own `@type` is the rule category (e.g. "primary",
 * "footnote-annotation"); each ref's own `@type` is its content type
 * ("markdown" or "html") - independent from both `@subtype` and the
 * interpretation's `@type`.
 *
 * Note: this uses plain tag-name traversal (`getElementsByTagName`) rather
 * than XPath, because JSDOM's XPath engine does not reliably resolve
 * namespace-prefixed expressions against a default-namespaced XML document
 * (see "JSDOM Limitations for Browser-Targeted Code" in
 * docs/code-assistant/testing-guide.md). All TEI documents handled here use
 * a single default namespace, so unprefixed tag names are unambiguous.
 *
 * An interpretation missing `@type`, or whose only `<ref>`(s) are missing
 * `@target` or carry an unrecognized/missing `@subtype`, is skipped
 * entirely (not returned with an empty refs list).
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @returns {Array<{category: string, refs: Array<{target: string, contentType: string|null, subtype: 'human'|'machine'}>}>}
 */
export function getEditorialDeclGuides(xmlDoc) {
  if (!xmlDoc || typeof xmlDoc.getElementsByTagName !== 'function') {
    throw new Error('Valid XML Document is required');
  }

  const editorialDecl = xmlDoc.getElementsByTagName('editorialDecl')[0];
  if (!editorialDecl) {
    return [];
  }

  const guides = [];
  for (const interpretation of editorialDecl.getElementsByTagName('interpretation')) {
    const category = interpretation.getAttribute('type');
    if (!category) continue;

    const refs = [];
    for (const ref of interpretation.getElementsByTagName('ref')) {
      const target = ref.getAttribute('target');
      const subtype = ref.getAttribute('subtype');
      if (!target || (subtype !== 'human' && subtype !== 'machine')) continue;
      refs.push({
        target,
        contentType: ref.getAttribute('type'),
        subtype
      });
    }
    if (refs.length === 0) continue;
    guides.push({ category, refs });
  }
  return guides;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/tei-utils.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/tei-utils.js tests/unit/js/tei-utils.test.js
git commit -m "feat: getEditorialDeclGuides returns multiple subtype-distinguished refs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `annotation-guide.js` reads the "primary" category's "human" ref

**Files:**
- Modify: `app/src/plugins/annotation-guide.js`

This is a small, targeted change verified by code review, not a new automated test - matching the precedent already established for this file (there is no dedicated `annotation-guide.test.js`; see the earlier `feat: annotation guide drawer prefers the document's own editorialDecl` task in the original plan for the same rationale). Both pure helper functions it depends on (`getEditorialDeclGuides`, from Task 7) are already fully covered by their own tests.

- [ ] **Step 1: Read the current file**

Read `app/src/plugins/annotation-guide.js` in full to have its exact current content in context.

- [ ] **Step 2: Implement**

Rename `#getDocumentGeneralGuide` to `#getDocumentPrimaryGuide` throughout the file (its definition and its one call site inside `load()`), and update its body to use the new `category: "primary"` sentinel and to select the `subtype: "human"` ref from the matched interpretation's `refs` array. Replace:

```js
  /**
   * Reads the open document's editorialDecl `general` guide entry, if present.
   *
   * contentType can be null/unrecognized when a hand-edited or malformed
   * editorialDecl omits it (see the getEditorialDeclGuides() contract in
   * tei-utils.js) - such an entry is treated the same as "no general guide"
   * so load() falls through to the runtime per-variant config instead of a
   * dead-end "no guide" message.
   * @returns {{markdownUrl: string|null, htmlUrl: string|null}|null}
   */
  #getDocumentGeneralGuide() {
    const xmlDoc = this.#xmlEditor.getXmlTree()
    if (!xmlDoc) return null
    let guides
    try {
      guides = getEditorialDeclGuides(xmlDoc)
    } catch (error) {
      this.getDependency('logger').warn(`Could not read editorialDecl: ${String(error)}`)
      return null
    }
    const general = guides.find(g => g.category === 'general')
    if (!general) return null
    const markdownUrl = general.contentType === 'markdown' ? general.target : null
    const htmlUrl = general.contentType === 'html' ? general.target : null
    if (!markdownUrl && !htmlUrl) return null
    return { markdownUrl, htmlUrl }
  }
```

with:

```js
  /**
   * Reads the open document's editorialDecl `primary` guide entry's
   * "human" ref, if present.
   *
   * contentType can be null/unrecognized when a hand-edited or malformed
   * editorialDecl omits it, or the "primary" interpretation may have only
   * a "machine" ref and no "human" one at all (see the
   * getEditorialDeclGuides() contract in tei-utils.js) - either case is
   * treated the same as "no primary guide" so load() falls through to the
   * runtime per-variant config instead of a dead-end "no guide" message.
   * @returns {{markdownUrl: string|null, htmlUrl: string|null}|null}
   */
  #getDocumentPrimaryGuide() {
    const xmlDoc = this.#xmlEditor.getXmlTree()
    if (!xmlDoc) return null
    let guides
    try {
      guides = getEditorialDeclGuides(xmlDoc)
    } catch (error) {
      this.getDependency('logger').warn(`Could not read editorialDecl: ${String(error)}`)
      return null
    }
    const primary = guides.find(g => g.category === 'primary')
    if (!primary) return null
    const humanRef = primary.refs.find(r => r.subtype === 'human')
    if (!humanRef) return null
    const markdownUrl = humanRef.contentType === 'markdown' ? humanRef.target : null
    const htmlUrl = humanRef.contentType === 'html' ? humanRef.target : null
    if (!markdownUrl && !htmlUrl) return null
    return { markdownUrl, htmlUrl }
  }
```

Then in `load()`, update the call site from:

```js
    const docGuide = this.#getDocumentGeneralGuide()
```

to:

```js
    const docGuide = this.#getDocumentPrimaryGuide()
```

- [ ] **Step 3: Verify no other module references the renamed private method**

Run: `grep -rn "getDocumentGeneralGuide" app/src`

Confirm no matches remain (it's a private method, so nothing outside this file could reference it, but this confirms the rename was applied consistently within the file too).

- [ ] **Step 4: Run the full JS unit suite**

Run: `node tests/unit-test-runner.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/annotation-guide.js
git commit -m "feat: annotation guide drawer reads the 'primary' category's human ref

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final verification

After all 8 tasks are complete:

- [ ] Run the full backend unit suite: `npm run test:unit:fastapi`
- [ ] Run the full frontend unit suite: `npm run test:unit:js`
- [ ] Run the grobid plugin's own JS integration tests: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests`
- [ ] Run `uv run mypy fastapi_app/plugins/grobid/ fastapi_app/lib/core/git_forge_adapters.py fastapi_app/lib/core/url_cache.py fastapi_app/lib/utils/annotation_rules_utils.py fastapi_app/lib/utils/tei_utils.py` and confirm no new errors were introduced by this feature's own code (pre-existing, unrelated errors elsewhere in the codebase are out of scope).
- [ ] Manually verify in a running dev instance (ask the user to start it if not running, per project convention - never start it yourself): extract a new `grobid.training.segmentation` document, confirm its saved TEI contains an `editorialDecl` with an `interpretation type="primary"` holding two `<ref>`s - one `subtype="human"` pointing at the `#document-segmentation-model` heading anchor, one `subtype="machine"` pointing at a `#L<start>-L<end>` line range on the same permalink-pinned commit. Open the Annotation Guide drawer and confirm it still renders and scrolls to the `#document-segmentation-model` section (using the human ref). Run "Refresh Annotation Rules" and confirm both refs regenerate correctly.
