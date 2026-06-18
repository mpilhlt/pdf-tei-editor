# Annotation Tag Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make visual annotation mode usable by defining GROBID tag sets, fixing the context menu build bug, adding submenu support, wiring per-variant data from backend, and cleaning up the statusbar switch.

**Architecture:** Backend changes are confined to `models_extraction.py` (data model) and the grobid plugin (`config.py`, `extractor.py`). All frontend changes are in `app/src/plugins/xml-annotation.js`. The context menu is rebuilt dynamically on every `onBeforeShow` via a sentinel `<sl-divider>`, so no changes to `XmlEditorContextMenu` or `XmlEditorPlugin` are needed.

**Tech Stack:** Python/Pydantic (backend models), FastAPI (extractor info endpoint), JavaScript/Shoelace (frontend plugin, context menu)

---

## Note on "Remove annotation" vs "Remove Tag"

The native "Remove Tag" item in `XmlEditorContextMenu` is disabled whenever `isReadOnly()` is true. Annotation mode forces the editor into read-only mode, so "Remove Tag" is always disabled during annotation. Merging the two would require cross-plugin changes to `XmlEditorContextMenu` that the spec explicitly prohibits. **"Remove annotation" stays as a separate item.**

---

## File Map

| File | Change |
| --- | --- |
| `fastapi_app/lib/models/models_extraction.py` | Add 3 fields to `AnnotationTagDef`; change `annotationTags` to `Dict`; add `annotationTagsCutoff` |
| `fastapi_app/plugins/grobid/config.py` | Add `ANNOTATION_TAGS`, `ANNOTATION_TAGS_CUTOFF`, two getter functions |
| `fastapi_app/plugins/grobid/extractor.py` | Import getters; expose in `get_info()` |
| `tests/unit/fastapi/test_annotation_tag_models.py` | Update existing tests for changed defaults; add new field tests |
| `fastapi_app/plugins/grobid/tests/test_annotation_config.py` | New — test config getters (plugin-local, run manually) |
| `fastapi_app/plugins/grobid/CLAUDE.md` | New — note on running plugin tests |
| `app/src/plugins/xml-annotation.js` | All frontend changes (typedef, fields, methods) |

---

## Task 1: Update `AnnotationTagDef` model — add new fields

**Files:**

- Modify: `fastapi_app/lib/models/models_extraction.py:36-51`
- Modify: `tests/unit/fastapi/test_annotation_tag_models.py`

- [ ] **Step 1.1: Add failing tests for new fields**

In `tests/unit/fastapi/test_annotation_tag_models.py`, add to class `TestAnnotationTagDef`:

```python
def test_new_fields_defaults(self):
    tag = AnnotationTagDef(tag="bibl", label="BIBL", color="#89dceb")
    self.assertIsNone(tag.description)
    self.assertEqual(tag.priority, 100)
    self.assertIsNone(tag.defaultAttributes)

def test_description_field(self):
    tag = AnnotationTagDef(
        tag="bibl", label="BIBL", color="#89dceb",
        description="An individual bibliographic reference"
    )
    self.assertEqual(tag.description, "An individual bibliographic reference")

def test_priority_field(self):
    tag = AnnotationTagDef(tag="body", label="body", color="#89dceb", priority=1)
    self.assertEqual(tag.priority, 1)

def test_default_attributes_field(self):
    tag = AnnotationTagDef(
        tag="note", label="note[footnote]", color="#94e2d5",
        defaultAttributes={"place": "footnote"}
    )
    self.assertEqual(tag.defaultAttributes, {"place": "footnote"})

def test_serialization_with_new_fields(self):
    tag = AnnotationTagDef(
        tag="note", label="note[footnote]", color="#94e2d5",
        priority=5, defaultAttributes={"place": "footnote"},
        description="A footnote"
    )
    data = tag.model_dump()
    self.assertEqual(data["priority"], 5)
    self.assertEqual(data["defaultAttributes"], {"place": "footnote"})
    self.assertEqual(data["description"], "A footnote")
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_tag_models.py -v 2>&1 | tail -15
```

Expected: FAIL — `AttributeError: 'AnnotationTagDef' object has no attribute 'description'`

- [ ] **Step 1.3: Add the three new fields to `AnnotationTagDef`**

In `fastapi_app/lib/models/models_extraction.py`, replace the `AnnotationTagDef` class body (lines 36-51):

```python
class AnnotationTagDef(BaseModel):
    """Definition of an annotation tag contributed by a variant plugin."""
    tag: str = Field(..., description="XML element name (e.g. 'bibl')")
    label: str = Field(
        ...,
        description="Badge label; may contain {@attrName} template tokens"
    )
    labelMap: Optional[Dict[str, str]] = Field(
        None,
        description="Attribute-value → label overrides, e.g. {'level=m': 'TITLE[M]'}"
    )
    color: str = Field(..., description="CSS colour for this tag's badge and underline")
    attributes: List[AnnotationTagAttribute] = Field(
        default_factory=list,
        description="Attributes shown in the properties popup"
    )
    description: Optional[str] = Field(
        None,
        description="Tooltip text for the context menu item"
    )
    priority: int = Field(
        100,
        description="Sort order; lower = shown first in the menu"
    )
    defaultAttributes: Optional[Dict[str, str]] = Field(
        None,
        description="Attribute key/value pairs baked into the opening tag when wrapping a selection"
    )
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_tag_models.py -v 2>&1 | tail -15
```

Expected: All 12 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add fastapi_app/lib/models/models_extraction.py tests/unit/fastapi/test_annotation_tag_models.py
git commit -m "feat: add description, priority, defaultAttributes to AnnotationTagDef"
```

---

## Task 2: Update `ExtractorInfo` model — dict type + cutoff field

**Files:**

- Modify: `fastapi_app/lib/models/models_extraction.py:54-99`
- Modify: `tests/unit/fastapi/test_annotation_tag_models.py`

- [ ] **Step 2.1: Update existing `ExtractorInfo` tests and add new ones**

In `tests/unit/fastapi/test_annotation_tag_models.py`, **replace** class `TestExtractorInfoAnnotationTags` with:

```python
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
                    AnnotationTagDef(tag="bibl", label="BIBL", color="#89dceb")
                ]
            },
        )
        tags = info.annotationTags.get("grobid.training.references", [])
        self.assertEqual(len(tags), 1)
        self.assertEqual(tags[0].tag, "bibl")

    def test_annotation_tags_cutoff_default(self):
        info = ExtractorInfo(
            id="grobid", name="Grobid", description="Grobid extractor",
            input=["pdf"], output=["xml"], available=True,
        )
        self.assertEqual(info.annotationTagsCutoff, {})

    def test_annotation_tags_cutoff_values(self):
        info = ExtractorInfo(
            id="grobid", name="Grobid", description="Grobid extractor",
            input=["pdf"], output=["xml"], available=True,
            annotationTagsCutoff={"grobid.training.segmentation": 6}
        )
        self.assertEqual(info.annotationTagsCutoff["grobid.training.segmentation"], 6)
```

- [ ] **Step 2.2: Run tests to confirm failures**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_tag_models.py -v 2>&1 | tail -15
```

Expected: `test_default_empty_dict` fails with `AssertionError: [] != {}`, `test_annotation_tags_cutoff_*` fail with `AttributeError`.

- [ ] **Step 2.3: Update `ExtractorInfo` in the model file**

In `fastapi_app/lib/models/models_extraction.py`, replace the `annotationTags` field and add `annotationTagsCutoff` (around lines 92-99):

```python
    annotationTags: Dict[str, List[AnnotationTagDef]] = Field(
        default_factory=dict,
        description="Annotation tag definitions keyed by variant_id"
    )
    annotationTagsCutoff: Dict[str, int] = Field(
        default_factory=dict,
        description="Per-variant count of top-level menu items; tags beyond this go in 'More...' submenu"
    )
```

- [ ] **Step 2.4: Run all annotation model tests**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_tag_models.py -v 2>&1 | tail -15
```

Expected: All 16 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add fastapi_app/lib/models/models_extraction.py tests/unit/fastapi/test_annotation_tag_models.py
git commit -m "feat: change ExtractorInfo.annotationTags to Dict; add annotationTagsCutoff"
```

---

## Task 3: Add plugin CLAUDE.md, then add annotation tag data to grobid config

**Files:**

- Create: `fastapi_app/plugins/grobid/CLAUDE.md`
- Modify: `fastapi_app/plugins/grobid/config.py` (append at bottom)
- Create: `fastapi_app/plugins/grobid/tests/test_annotation_config.py`

- [ ] **Step 3.1: Create `fastapi_app/plugins/grobid/CLAUDE.md`**

```markdown
# GROBID Plugin — Code Assistant Notes

## Tests

Plugin tests live in `fastapi_app/plugins/grobid/tests/`. JavaScript tests are run via the backend test runner:

```bash
node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests
```

Python unit tests must be run manually using the Python test runner:

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v
```

**All new tests for this plugin go in `fastapi_app/plugins/grobid/tests/`**, not in `tests/unit/`.
```

- [ ] **Step 3.2: Write failing tests for config getters**

Create `fastapi_app/plugins/grobid/tests/test_annotation_config.py`:

```python
"""
Unit tests for annotation tag config in the grobid plugin.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v

@testCovers fastapi_app/plugins/grobid/config.py
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

    def test_segmentation_has_14_tags(self):
        tags = self.get_annotation_tags()
        self.assertEqual(len(tags["grobid.training.segmentation"]), 14)

    def test_reference_segmenter_has_3_tags(self):
        tags = self.get_annotation_tags()
        self.assertEqual(len(tags["grobid.training.references.referenceSegmenter"]), 3)

    def test_references_has_18_tags(self):
        tags = self.get_annotation_tags()
        self.assertEqual(len(tags["grobid.training.references"]), 18)

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
        footnote = next(t for t in seg if t["label"] == "note[footnote]")
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


class TestGetAnnotationTagsCutoff(unittest.TestCase):

    def setUp(self):
        from fastapi_app.plugins.grobid.config import get_annotation_tags_cutoff
        self.get_annotation_tags_cutoff = get_annotation_tags_cutoff

    def test_returns_dict(self):
        cutoff = self.get_annotation_tags_cutoff()
        self.assertIsInstance(cutoff, dict)

    def test_segmentation_cutoff(self):
        cutoff = self.get_annotation_tags_cutoff()
        self.assertEqual(cutoff["grobid.training.segmentation"], 6)

    def test_reference_segmenter_cutoff(self):
        cutoff = self.get_annotation_tags_cutoff()
        self.assertEqual(cutoff["grobid.training.references.referenceSegmenter"], 3)

    def test_references_cutoff(self):
        cutoff = self.get_annotation_tags_cutoff()
        self.assertEqual(cutoff["grobid.training.references"], 6)

    def test_returns_copy(self):
        c1 = self.get_annotation_tags_cutoff()
        c1["grobid.training.segmentation"] = 999
        c2 = self.get_annotation_tags_cutoff()
        self.assertEqual(c2["grobid.training.segmentation"], 6)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3.3: Run tests to confirm they fail**

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v 2>&1 | tail -10
```

Expected: `ImportError: cannot import name 'get_annotation_tags' from 'fastapi_app.plugins.grobid.config'`

- [ ] **Step 3.4: Add tag data and getters to grobid config**

Append the following to the bottom of `fastapi_app/plugins/grobid/config.py`:

```python
ANNOTATION_TAGS_CUTOFF: dict[str, int] = {
    "grobid.training.segmentation": 6,
    "grobid.training.references.referenceSegmenter": 3,
    "grobid.training.references": 6,
}

ANNOTATION_TAGS: dict[str, list[dict]] = {
    "grobid.training.segmentation": [
        {"tag": "body", "label": "body", "color": "#89dceb", "priority": 1, "defaultAttributes": None, "description": "The main body of the document", "attributes": []},
        {"tag": "listBibl", "label": "listBibl", "color": "#f38ba8", "priority": 2, "defaultAttributes": None, "description": "Bibliographical section", "attributes": []},
        {"tag": "front", "label": "front", "color": "#89b4fa", "priority": 3, "defaultAttributes": None, "description": "Document header / front matter", "attributes": []},
        {"tag": "titlePage", "label": "titlePage", "color": "#cba6f7", "priority": 4, "defaultAttributes": None, "description": "Cover page", "attributes": []},
        {"tag": "note", "label": "note[footnote]", "color": "#94e2d5", "priority": 5, "defaultAttributes": {"place": "footnote"}, "description": "Page footer or numbered footnote", "attributes": []},
        {"tag": "page", "label": "page", "color": "#f9e2af", "priority": 6, "defaultAttributes": None, "description": "Page number indicator", "attributes": []},
        {"tag": "div", "label": "acknowledgement", "color": "#a6e3a1", "priority": 7, "defaultAttributes": {"type": "acknowledgement"}, "description": "Acknowledgement statement in the annex", "attributes": []},
        {"tag": "div", "label": "toc", "color": "#f5c2e7", "priority": 8, "defaultAttributes": {"type": "toc"}, "description": "Table of contents", "attributes": []},
        {"tag": "note", "label": "note[headnote]", "color": "#74c7ec", "priority": 9, "defaultAttributes": {"place": "headnote"}, "description": "Page header / running head", "attributes": []},
        {"tag": "div", "label": "annex", "color": "#585b70", "priority": 10, "defaultAttributes": {"type": "annex"}, "description": "Any other annex section", "attributes": []},
        {"tag": "div", "label": "funding", "color": "#f2cdcd", "priority": 11, "defaultAttributes": {"type": "funding"}, "description": "Funding information annex", "attributes": []},
        {"tag": "div", "label": "conflict", "color": "#eba0ac", "priority": 12, "defaultAttributes": {"type": "conflict"}, "description": "Conflict of interest statement", "attributes": []},
        {"tag": "div", "label": "contribution", "color": "#b4befe", "priority": 13, "defaultAttributes": {"type": "contribution"}, "description": "Author contribution statement", "attributes": []},
        {"tag": "div", "label": "availability", "color": "#45475a", "priority": 14, "defaultAttributes": {"type": "availability"}, "description": "Data/code availability statement", "attributes": []},
    ],
    "grobid.training.references.referenceSegmenter": [
        {"tag": "bibl", "label": "bibl", "color": "#89dceb", "priority": 1, "defaultAttributes": None, "description": "An individual bibliographic reference", "attributes": []},
        {"tag": "bibl", "label": "bibl[footnote]", "color": "#94e2d5", "priority": 2, "defaultAttributes": {"type": "footnote"}, "description": "A note or comment that is not a bibliographic reference", "attributes": []},
        {"tag": "label", "label": "label", "color": "#a6e3a1", "priority": 3, "defaultAttributes": None, "description": "Reference number or footnote marker (e.g. [1], ¹)", "attributes": []},
    ],
    "grobid.training.references": [
        {"tag": "author", "label": "author", "color": "#89b4fa", "priority": 1, "defaultAttributes": None, "description": "Complete sequence of author names", "attributes": []},
        {"tag": "title", "label": "title[a]", "color": "#a6e3a1", "priority": 2, "defaultAttributes": {"level": "a"}, "description": "Article or chapter title (analytics)", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "title", "label": "title[j]", "color": "#74c7ec", "priority": 3, "defaultAttributes": {"level": "j"}, "description": "Journal title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "date", "label": "date", "color": "#fab387", "priority": 4, "defaultAttributes": None, "description": "Publication date sequence", "attributes": []},
        {"tag": "biblScope", "label": "pages", "color": "#f9e2af", "priority": 5, "defaultAttributes": {"unit": "page"}, "description": "Full page range of the article", "attributes": []},
        {"tag": "title", "label": "title[m]", "color": "#94e2d5", "priority": 6, "defaultAttributes": {"level": "m"}, "description": "Monograph, proceedings, book, or thesis title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "publisher", "label": "publisher", "color": "#cba6f7", "priority": 7, "defaultAttributes": None, "description": "Publisher name; also used for corporate authors such as web pages", "attributes": []},
        {"tag": "biblScope", "label": "volume", "color": "#f5c2e7", "priority": 8, "defaultAttributes": {"unit": "volume"}, "description": "Volume number", "attributes": []},
        {"tag": "biblScope", "label": "issue", "color": "#eba0ac", "priority": 9, "defaultAttributes": {"unit": "issue"}, "description": "Issue / number", "attributes": []},
        {"tag": "orgName", "label": "orgName", "color": "#f38ba8", "priority": 10, "defaultAttributes": None, "description": "Institution for theses or technical reports", "attributes": []},
        {"tag": "pubPlace", "label": "pubPlace", "color": "#89dceb", "priority": 11, "defaultAttributes": None, "description": "Publication place or location of publishing institution", "attributes": []},
        {"tag": "editor", "label": "editor", "color": "#b4befe", "priority": 12, "defaultAttributes": None, "description": "Sequence of editor names", "attributes": []},
        {"tag": "ptr", "label": "URL", "color": "#74c7ec", "priority": 13, "defaultAttributes": {"type": "web"}, "description": "Web URL (exclude prefixes like 'URL:' and trailing periods)", "attributes": []},
        {"tag": "idno", "label": "idno", "color": "#45475a", "priority": 14, "defaultAttributes": None, "description": "Document identifier (DOI, arXiv, etc.)", "attributes": [{"name": "type", "values": ["DOI", "arXiv", "report"]}]},
        {"tag": "note", "label": "note", "color": "#9399b2", "priority": 15, "defaultAttributes": None, "description": "Any note not covered by another tag", "attributes": []},
        {"tag": "title", "label": "title[s]", "color": "#b4befe", "priority": 16, "defaultAttributes": {"level": "s"}, "description": "Series title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "orgName", "label": "collaboration", "color": "#f2cdcd", "priority": 17, "defaultAttributes": {"type": "collaboration"}, "description": "Project-based collaboration acting as an author group", "attributes": []},
        {"tag": "note", "label": "note[report]", "color": "#585b70", "priority": 18, "defaultAttributes": {"type": "report"}, "description": "Type of report or thesis (e.g. 'Ph.D. thesis', 'Technical Report')", "attributes": []},
    ],
}


def get_annotation_tags() -> dict[str, list[dict]]:
    """Return annotation tag definitions keyed by variant_id."""
    import copy
    return copy.deepcopy(ANNOTATION_TAGS)


def get_annotation_tags_cutoff() -> dict[str, int]:
    """Return per-variant top-level menu item counts."""
    return ANNOTATION_TAGS_CUTOFF.copy()
```

- [ ] **Step 3.5: Run config tests to confirm they pass**

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v 2>&1 | tail -20
```

Expected: All 13 tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add fastapi_app/plugins/grobid/config.py fastapi_app/plugins/grobid/tests/test_annotation_config.py fastapi_app/plugins/grobid/CLAUDE.md
git commit -m "feat: add ANNOTATION_TAGS and ANNOTATION_TAGS_CUTOFF to grobid config"
```

---

## Task 4: Wire grobid extractor `get_info()` to expose tag data

**Files:**

- Modify: `fastapi_app/plugins/grobid/extractor.py:15-18` (import block) and `:71-83` (get_info)

- [ ] **Step 4.1: Update import block in `extractor.py`**

In `fastapi_app/plugins/grobid/extractor.py`, the import from `config` currently ends with `get_annotation_guides`. Add the two new getters. Find this section (around line 15-18):

```python
from fastapi_app.plugins.grobid.config import (
    get_annotation_guides,
    get_form_options,
```

Replace with:

```python
from fastapi_app.plugins.grobid.config import (
    get_annotation_guides,
    get_annotation_tags,
    get_annotation_tags_cutoff,
    get_form_options,
```

- [ ] **Step 4.2: Update `get_info()` to include the new fields**

In `fastapi_app/plugins/grobid/extractor.py`, replace the `get_info` return dict (around lines 73-83):

```python
    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the GROBID extractor."""
        return {
            "id": "grobid",
            "name": "GROBID Extraction",
            "description": "Extract TEI from PDF using remote GROBID server (training data or full documents)",
            "input": ["pdf"],
            "output": ["tei-document"],
            "variants": get_supported_variants(),
            "options": get_form_options(),
            "navigation_xpath": get_navigation_xpath(),
            "annotationGuides": get_annotation_guides(),
            "annotationTags": get_annotation_tags(),
            "annotationTagsCutoff": get_annotation_tags_cutoff(),
        }
```

- [ ] **Step 4.3: Verify via Python import**

```bash
uv run python -c "
from fastapi_app.plugins.grobid.extractor import GrobidExtractor
info = GrobidExtractor.get_info()
tags = info['annotationTags']
cutoff = info['annotationTagsCutoff']
print('variants in annotationTags:', list(tags.keys()))
print('segmentation tags count:', len(tags.get('grobid.training.segmentation', [])))
print('cutoff:', cutoff)
" 2>&1
```

Expected output:

```text
variants in annotationTags: ['grobid.training.segmentation', 'grobid.training.references.referenceSegmenter', 'grobid.training.references']
segmentation tags count: 14
cutoff: {'grobid.training.segmentation': 6, 'grobid.training.references.referenceSegmenter': 3, 'grobid.training.references': 6}
```

- [ ] **Step 4.4: Commit**

```bash
git add fastapi_app/plugins/grobid/extractor.py
git commit -m "feat: expose annotationTags and annotationTagsCutoff in grobid extractor get_info"
```

---

## Task 5: Frontend — typedef, private fields, fix `#updateTagDefs()`

**Files:**

- Modify: `app/src/plugins/xml-annotation.js`

This task covers three related changes: typedef update, new private fields, and the broken `#updateTagDefs()` fix. They are small and tightly coupled.

- [ ] **Step 5.1: Update `AnnotationTagDef` typedef**

In `app/src/plugins/xml-annotation.js`, replace the existing typedef (line 22-24):

```js
/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null,
 *   color: string, attributes: Array<{name:string, values?: string[]|null}>,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null }} AnnotationTagDef
 */
```

- [ ] **Step 5.2: Add two new private fields after `#menuRemoveItem`**

In `app/src/plugins/xml-annotation.js`, after the line:

```js
  /** @type {HTMLElement|null} */
  #menuRemoveItem = null;
```

Add:

```js
  /** @type {HTMLElement|null} */
  #menuSentinel = null;

  /** @type {number|null} */
  #topLevelCount = null;
```

- [ ] **Step 5.3: Fix `#updateTagDefs()` — field name, dict access, reset `#topLevelCount`**

In `app/src/plugins/xml-annotation.js`, replace the entire `#updateTagDefs` method:

```js
  /** @param {ApplicationState} state */
  async #updateTagDefs(state) {
    const variant = state.variant
    const extractors = this.#extraction.extractorInfo()
    /** @type {AnnotationTagDef[]} */
    const newDefs = []
    this.#topLevelCount = null

    if (extractors && variant) {
      for (const ext of extractors) {
        if (!ext.variants || ext.variants.includes(variant)) {
          const variantTags = /** @type {any} */ (ext).annotationTags?.[variant]
          if (Array.isArray(variantTags)) newDefs.push(...variantTags)
          const cutoff = /** @type {any} */ (ext).annotationTagsCutoff?.[variant]
          if (cutoff != null) this.#topLevelCount = cutoff
        }
      }
    }

    this.#tagDefs = newDefs
    const hasTagDefs = newDefs.length > 0

    if (this.#switch) {
      this.#switch.hidden = !hasTagDefs
      this.#switch.helpText = hasTagDefs ? '' : 'No annotation tags defined for this variant'
    }

    this.#popup?.updateTagDefs(newDefs)

    if (this.#annotationMode) {
      if (!hasTagDefs) {
        await this.#disableAnnotationMode()
      } else {
        this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])
      }
    }
  }
```

- [ ] **Step 5.4: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "fix: update AnnotationTagDef typedef and fix #updateTagDefs dict access and topLevelCount"
```

---

## Task 6: Frontend — `#wrapSelectionWith()` with defaultAttributes

**Files:**

- Modify: `app/src/plugins/xml-annotation.js`

- [ ] **Step 6.1: Update `#wrapSelectionWith()` to include `defaultAttributes`**

In `app/src/plugins/xml-annotation.js`, replace the body of `#wrapSelectionWith`:

```js
  /**
   * Wraps the current CM selection in the given annotation tag and re-syncs.
   * @param {AnnotationTagDef} def
   */
  async #wrapSelectionWith(def) {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const { from, to } = view.state.selection.main
    if (from === to) return
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

- [ ] **Step 6.2: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "feat: include defaultAttributes when wrapping selection with annotation tag"
```

---

## Task 7: Frontend — context menu sentinel + rebuild methods

**Files:**

- Modify: `app/src/plugins/xml-annotation.js`

This is the largest frontend change. It replaces the tag item loop in `#contextMenuItems()` with a sentinel-based dynamic rebuild system.

- [ ] **Step 7.1: Replace `#contextMenuItems()` — remove tag item loop, add sentinel**

In `app/src/plugins/xml-annotation.js`, replace the entire `#contextMenuItems()` method:

```js
  /**
   * Returns annotation context menu items: divider + remove item + sentinel.
   * Tag items are built dynamically in #rebuildTagMenuItems() each time the menu opens.
   * @returns {Array<{element: HTMLElement, onBeforeShow?: () => void}>}
   */
  #contextMenuItems() {
    const divider = document.createElement('sl-divider')
    divider.hidden = true
    this.#menuDivider = divider

    const removeItem = document.createElement('sl-menu-item')
    removeItem.textContent = 'Remove annotation'
    removeItem.hidden = true
    removeItem.disabled = true
    this.#menuRemoveItem = removeItem
    removeItem.addEventListener('click', () => this.#removeAnnotationAtClick())

    const sentinel = document.createElement('sl-divider')
    sentinel.hidden = true
    this.#menuSentinel = sentinel

    return [
      {
        element: divider,
        onBeforeShow: () => { divider.hidden = !this.#annotationMode }
      },
      {
        element: removeItem,
        onBeforeShow: () => {
          removeItem.hidden = !this.#annotationMode
          if (!this.#annotationMode) return
          const view = this.#xmlEditor.getView?.()
          const synced = this.#xmlEditor.isSynced?.()
          if (!view || !synced) { removeItem.disabled = true; return }
          try {
            const el = /** @type {Element|null} */ (this.#xmlEditor.getDomNodeAt?.(view.state.selection.main.head))
            removeItem.disabled = !el || !this.#tagDefs.some(d => d.tag === el.localName)
          } catch { removeItem.disabled = true }
        }
      },
      {
        element: sentinel,
        onBeforeShow: () => this.#rebuildTagMenuItems()
      }
    ]
  }
```

- [ ] **Step 7.2: Add `#rebuildTagMenuItems()`**

In `app/src/plugins/xml-annotation.js`, add after `#contextMenuItems()`:

```js
  /**
   * Rebuilds tag menu items in the context menu each time it opens.
   * Called via the sentinel element's onBeforeShow callback.
   */
  #rebuildTagMenuItems() {
    const menu = this.#menuSentinel?.parentElement
    if (!menu) return
    for (const item of this.#menuTagItems) item.remove()
    this.#menuTagItems = []
    if (!this.#annotationMode || this.#tagDefs.length === 0) return
    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    const cutoff = this.#topLevelCount
    const topDefs = cutoff != null ? sorted.slice(0, cutoff) : sorted
    const moreDefs = cutoff != null ? sorted.slice(cutoff) : []
    const view = this.#xmlEditor.getView?.()
    const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 }
    const hasSelection = from !== to && !!this.#xmlEditor.isSynced?.()
    for (const def of topDefs) {
      const item = this.#createTagItem(def, hasSelection)
      menu.insertBefore(item, this.#menuSentinel)
      this.#menuTagItems.push(item)
    }
    if (moreDefs.length > 0) {
      const submenu = this.#createTagSubmenu(moreDefs, hasSelection)
      menu.insertBefore(submenu, this.#menuSentinel)
      this.#menuTagItems.push(submenu)
    }
  }
```

- [ ] **Step 7.3: Add `#createTagItem(def, hasSelection)`**

In `app/src/plugins/xml-annotation.js`, add after `#rebuildTagMenuItems()`:

```js
  /**
   * Creates a single tag menu item for the context menu.
   * @param {AnnotationTagDef} def
   * @param {boolean} hasSelection
   * @returns {HTMLElement}
   */
  #createTagItem(def, hasSelection) {
    const item = document.createElement('sl-menu-item')
    item.textContent = def.label.replace(/\{@[^}]+\}/g, '…')
    item.dataset.tag = def.tag
    item.disabled = !hasSelection
    if (def.description) item.title = def.description
    item.addEventListener('click', () => this.#wrapSelectionWith(def))
    return item
  }
```

- [ ] **Step 7.4: Add `#createTagSubmenu(defs, hasSelection)`**

In `app/src/plugins/xml-annotation.js`, add after `#createTagItem()`:

```js
  /**
   * Creates a "More…" submenu containing the lower-priority tag items.
   * @param {AnnotationTagDef[]} defs
   * @param {boolean} hasSelection
   * @returns {HTMLElement}
   */
  #createTagSubmenu(defs, hasSelection) {
    const wrapper = document.createElement('sl-menu-item')
    wrapper.textContent = 'More…'
    const inner = document.createElement('sl-menu')
    inner.slot = 'submenu'
    for (const def of defs) inner.appendChild(this.#createTagItem(def, hasSelection))
    wrapper.appendChild(inner)
    return wrapper
  }
```

- [ ] **Step 7.5: Simplify `#setContextMenuItemsVisible()` — remove tag item loop**

In `app/src/plugins/xml-annotation.js`, replace `#setContextMenuItemsVisible`:

```js
  /** @param {boolean} visible */
  #setContextMenuItemsVisible(visible) {
    if (this.#menuDivider) this.#menuDivider.hidden = !visible
    if (this.#menuRemoveItem) this.#menuRemoveItem.hidden = !visible
  }
```

Tag items are now managed exclusively by `#rebuildTagMenuItems()`.

- [ ] **Step 7.6: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "feat: rebuild context menu tag items dynamically via sentinel onBeforeShow"
```

---

## Task 8: Frontend — switch `disabled` → `hidden`, priority 90 → 3

**Files:**

- Modify: `app/src/plugins/xml-annotation.js`

- [ ] **Step 8.1: Update `install()` — change priority 90 → 3**

In `app/src/plugins/xml-annotation.js`, in the `install()` method, find:

```js
    this.#xmlEditor.addStatusbarWidget(this.#switch, 'left', 90)
```

Replace with:

```js
    this.#xmlEditor.addStatusbarWidget(this.#switch, 'left', 3)
```

- [ ] **Step 8.2: Update switch construction — remove `disabled: true`, initialize as hidden**

In `app/src/plugins/xml-annotation.js`, in `install()`, find the `PanelUtils.createSwitch` call and the line after it:

```js
    this.#switch = PanelUtils.createSwitch({
      name: 'annotationModeSwitch',
      text: 'Annotate',
      disabled: true,
      helpText: 'No annotation tags defined for this variant'
    })
    this.#switch.addEventListener('widget-change', () => this.#onSwitchChange())
```

Replace with:

```js
    this.#switch = PanelUtils.createSwitch({
      name: 'annotationModeSwitch',
      text: 'Annotate',
      helpText: 'No annotation tags defined for this variant'
    })
    this.#switch.hidden = true
    this.#switch.addEventListener('widget-change', () => this.#onSwitchChange())
```

Starting hidden ensures the switch stays invisible until `#updateTagDefs()` un-hides it for a variant that has tags. Without this, if `initialState.variant` is falsy on startup, the switch is visible with no tags defined.

- [ ] **Step 8.3: Verify `#updateTagDefs()` uses `.hidden` not `.disabled`**

Confirm the `#updateTagDefs()` method (replaced in Task 5) contains:

```js
      this.#switch.hidden = !hasTagDefs
```

and does NOT contain `this.#switch.disabled`. This was done in Task 5; this step is a consistency check.

- [ ] **Step 8.4: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "feat: hide annotation switch instead of disabling; lower statusbar priority to 3"
```

---

## Task 9: Run all unit tests and manual smoke-test

- [ ] **Step 9.1: Run all Python unit tests**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/ -v 2>&1 | tail -20
```

Expected: All tests pass (including the updated `TestExtractorInfoAnnotationTags` class).

- [ ] **Step 9.2: Run grobid plugin Python tests**

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v 2>&1 | tail -10
```

Expected: All 13 tests pass.

- [ ] **Step 9.3: Manual smoke-test (requires running app)**

If the app is running at `http://localhost:8000`:

1. Open a PDF file and select the `grobid.training.segmentation` variant.
2. Confirm the "Annotate" switch appears in the statusbar (was previously hidden or greyed out for most variants).
3. Enable annotation mode.
4. Right-click in the XML editor. Confirm:
   - A divider appears above the annotation section.
   - "Remove annotation" is present (disabled until cursor is on a known tag).
   - The first 6 tags (`body`, `listBibl`, `front`, `titlePage`, `note[footnote]`, `page`) appear as top-level items.
   - A "More…" submenu contains the remaining 8 tags.
5. Select some text and right-click. Confirm tag items are enabled.
6. Click `note[footnote]`. Confirm the inserted XML is `<note place="footnote">…</note>`.
7. Click `acknowledgement`. Confirm the inserted XML is `<div type="acknowledgement">…</div>`.
8. Switch to `grobid.training.references` variant. Right-click → confirm 6 top-level items + "More…" with 12 items.
9. Switch to a variant with no annotation tags. Confirm the switch becomes hidden.

- [ ] **Step 9.4: Final commit if any last-minute fixes**

If step 9.3 reveals issues, fix them and commit. Otherwise this step is a no-op.
