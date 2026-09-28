# GROBID Schema-Fragment Source Refs, `@n` Labels & Header Pretty-Print Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permalink-pinned `editorialDecl/interpretation` ref pointing at each GROBID training variant's upstream, hand-editable fossil RNG source file (distinct from the generated/validated-against schema), give every `interpretation` entry (guide-based and schema-fragment) a proper `@n` label instead of falling back to the raw category slug, and make "Refresh document rules" always pretty-print the header, matching extraction-time output.

**Architecture:** A small, purpose-built `get_schema_fragment_url()` accessor lives next to the existing `get_schema_url()` in the GROBID plugin's config module and is consulted directly by `build_editorial_decl_entries()` — it does not go through `AnnotationGuide`/`ANNOTATION_GUIDES`, which remains scoped to the unrelated, API-exposed "Annotation Guide" drawer feature. Both guide-based and schema-fragment entries now carry an explicit `n` label. `rules_refresh.py`'s write path is refactored from three separate string round-trips (one of which used regex PI surgery) into a single in-memory `etree._Element` pipeline serialized once via the existing `serialize_tei_with_formatted_header()`.

**Tech Stack:** Python 3, lxml, FastAPI backend, `unittest` (Python unit tests under `fastapi_app/plugins/grobid/tests/` and `tests/unit/fastapi/`).

**Design spec:** [docs/superpowers/specs/2026-09-28-grobid-schema-fragment-refs-design.md](../specs/2026-09-28-grobid-schema-fragment-refs-design.md)

---

## File Structure

- Modify `fastapi_app/plugins/grobid/config/annotation_guides.py` — add `label: str` to the `AnnotationGuide` TypedDict and to all four `ANNOTATION_GUIDES` entries.
- Modify `fastapi_app/plugins/grobid/config/__init__.py` — add `SCHEMA_SOURCE_BASE_URL`, `SCHEMA_FRAGMENT_VARIANTS`, `SCHEMA_FRAGMENT_LABELS`, `get_schema_fragment_url()`.
- Modify `fastapi_app/plugins/grobid/annotation_rules.py` — `build_editorial_decl_entries()` passes `guide["label"]` through as `"n"`, and appends a schema-fragment entry when `get_schema_fragment_url()` returns non-`None`.
- Modify `fastapi_app/lib/doc_rules/rules_refresh.py` — `_replace_editorial_decl()` preserves `@n`; `perform_refresh()`, `_replace_editorial_decl()`, `_add_revision_change()` are refactored to operate on one shared in-memory element and serialize once via `serialize_tei_with_formatted_header()`; `_replace_schema_pi()` and its regexes are removed.
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules.py` — extend/add cases for label propagation and schema-fragment entries.
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_config.py` — new test class for `get_schema_fragment_url()`.
- Test: `tests/unit/fastapi/test_doc_rules_rules_refresh.py` — new cases for `@n` preservation and header pretty-printing.
- Test: `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py` — new case locking in the schema-fragment resource's format/label.

No new files, no new `ResourceKind`, no changes to `app/src/modules/document-rules-decorations.js`, `app/src/plugins/annotation-guide.js`, or any non-GROBID provider — all inherited for free per the design spec's Non-goals.

---

### Task 1: Add `label` to `AnnotationGuide` config and plumb it into `build_editorial_decl_entries()`

**Files:**

- Modify: `fastapi_app/plugins/grobid/config/annotation_guides.py`
- Modify: `fastapi_app/plugins/grobid/annotation_rules.py:37-43`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`

- [ ] **Step 1: Write the failing test**

Add a new test class to `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`, right after `TestBuildEditorialDeclEntriesVariantMatching`:

```python
class TestBuildEditorialDeclEntriesLabel(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_guide_label_becomes_entry_n(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md", "label": "Citation model guidelines"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("v1", MagicMock())

        self.assertEqual(entries[0]["n"], "Citation model guidelines")
```

Also update the three existing mocked guide dicts in `TestBuildEditorialDeclEntriesVariantMatching` (`test_matches_variant_listed_explicitly`, `test_wildcard_matches_any_variant`) and the five in `TestBuildRefsForGuideShapeTable` to each include a `"label"` key (any short string, e.g. `"label": "Guide"`), since `AnnotationGuide` will become a `TypedDict` where every real config entry always has one, and `build_editorial_decl_entries()` will unconditionally read `guide["label"]`.

- [ ] **Step 2: Run tests to verify the new one fails and the others error**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: `test_guide_label_becomes_entry_n` FAILs with `KeyError: 'n'`; the two `test_returns_empty_list_for_unconfigured_variant`-style paths still pass since they never reach the label lookup, but this is fine — the point is `test_guide_label_becomes_entry_n` fails.

- [ ] **Step 3: Implement `label` in `AnnotationGuide` and its four entries**

Edit `fastapi_app/plugins/grobid/config/annotation_guides.py`:

```python
class AnnotationGuide(TypedDict):
    """A link to an annotation guide for one or more variants and a rule category."""

    variant_ids: list[str]
    category: str
    type: Literal["markdown", "html"]
    url: str
    label: str


ANNOTATION_GUIDES: list[AnnotationGuide] = [
    {
        "variant_ids": ["grobid.training.segmentation"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#document-segmentation-model",
        "label": "Document segmentation guidelines",
    },
    {
        "variant_ids": ["grobid.training.references.referenceSegmenter"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#reference-segmentation-model",
        "label": "Reference segmentation guidelines",
    },
    {
        "variant_ids": ["grobid.training.references"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#citation-model",
        "label": "Citation model guidelines",
    },
    {
        "variant_ids": ["*"],
        "category": "data-correction",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#data-correction",
        "label": "Data correction guidelines",
    },
]
```

- [ ] **Step 4: Plumb `guide["label"]` through as `"n"` in `build_editorial_decl_entries()`**

Edit `fastapi_app/plugins/grobid/annotation_rules.py:37-43`:

```python
    entries: list[AnnotationRuleRef] = []
    for guide in get_annotation_guides():
        if variant_id not in guide["variant_ids"] and "*" not in guide["variant_ids"]:
            continue
        refs = _build_refs_for_guide(guide, cache)
        entries.append({"category": guide["category"], "refs": refs, "n": guide["label"]})
    return entries
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 6: Run the extractor's editorialDecl tests too (they mock `build_editorial_decl_entries` directly, but confirm no import-time breakage)**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/plugins/grobid/config/annotation_guides.py fastapi_app/plugins/grobid/annotation_rules.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py
git commit -m "feat(grobid): give every annotation guide entry a display label

editorialDecl/interpretation/@n was never populated by GROBID's
build_editorial_decl_entries(), so InterpretationRefKind.discover()'s
fallback (entry.get(\"n\") or entry[\"category\"]) always surfaced the raw
type slug (\"primary\", \"data-correction\") as the label. AnnotationGuide
now carries an explicit label, passed through as interpretation/@n.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Add `get_schema_fragment_url()` to the GROBID config module

**Files:**

- Modify: `fastapi_app/plugins/grobid/config/__init__.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_config.py`

- [ ] **Step 1: Write the failing test**

Add a new test class to `fastapi_app/plugins/grobid/tests/test_annotation_config.py`, after the imports (no fixture/settings patching needed — this is a pure function):

```python
class TestGetSchemaFragmentUrl(unittest.TestCase):
    def setUp(self):
        import fastapi_app.plugins.grobid.config as grobid_config
        self.get_schema_fragment_url = grobid_config.get_schema_fragment_url
        self.SCHEMA_FRAGMENT_VARIANTS = grobid_config.SCHEMA_FRAGMENT_VARIANTS
        self.SCHEMA_FRAGMENT_LABELS = grobid_config.SCHEMA_FRAGMENT_LABELS

    def test_returns_url_for_each_fragment_variant(self):
        self.assertEqual(
            self.get_schema_fragment_url("grobid.training.segmentation"),
            "https://github.com/mpilhlt/fossil/blob/main/schema/grobid.training.segmentation.rng",
        )
        self.assertEqual(
            self.get_schema_fragment_url("grobid.training.references"),
            "https://github.com/mpilhlt/fossil/blob/main/schema/grobid.training.references.rng",
        )
        self.assertEqual(
            self.get_schema_fragment_url("grobid.training.references.referenceSegmenter"),
            "https://github.com/mpilhlt/fossil/blob/main/schema/grobid.training.references.referenceSegmenter.rng",
        )

    def test_returns_none_for_variant_without_a_fossil_source_file(self):
        self.assertIsNone(self.get_schema_fragment_url("grobid.training.header"))
        self.assertIsNone(self.get_schema_fragment_url("grobid.training.table"))
        self.assertIsNone(self.get_schema_fragment_url("grobid.training.figure"))

    def test_every_fragment_variant_has_a_label(self):
        for variant_id in self.SCHEMA_FRAGMENT_VARIANTS:
            self.assertIn(variant_id, self.SCHEMA_FRAGMENT_LABELS)
            self.assertTrue(self.SCHEMA_FRAGMENT_LABELS[variant_id])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: FAIL with `AttributeError: module 'fastapi_app.plugins.grobid.config' has no attribute 'get_schema_fragment_url'`.

- [ ] **Step 3: Implement `get_schema_fragment_url()`**

Edit `fastapi_app/plugins/grobid/config/__init__.py`. Add `Optional` to the typing import at the top (there is currently no `typing` import in this file):

```python
from typing import Optional
```

Then add, immediately after `get_schema_url()` (after line 79):

```python
SCHEMA_SOURCE_BASE_URL = "https://github.com/mpilhlt/fossil/blob/main/schema"

# Variants with a dedicated top-level source file in fossil/schema/ (as
# opposed to sharing/inheriting validation from another variant's schema).
SCHEMA_FRAGMENT_VARIANTS: set[str] = {
    "grobid.training.segmentation",
    "grobid.training.references",
    "grobid.training.references.referenceSegmenter",
}

SCHEMA_FRAGMENT_LABELS: dict[str, str] = {
    "grobid.training.segmentation": "Segmentation schema source",
    "grobid.training.references.referenceSegmenter": "Reference segmentation schema source",
    "grobid.training.references": "Citation model schema source",
}


def get_schema_fragment_url(variant_id: str) -> Optional[str]:
    """
    URL of the upstream, hand-editable RNG source for a variant's generated/
    published schema (see get_schema_url()), or None if this variant has no
    dedicated fossil source file.
    """
    if variant_id not in SCHEMA_FRAGMENT_VARIANTS:
        return None
    return f"{SCHEMA_SOURCE_BASE_URL}/{variant_id}.rng"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/config/__init__.py fastapi_app/plugins/grobid/tests/test_annotation_config.py
git commit -m "feat(grobid): add get_schema_fragment_url() accessor

Sibling to get_schema_url(): points at the hand-editable upstream RNG
source in mpilhlt/fossil for the three variants that have a dedicated
top-level schema/*.rng file, vs. the generated/published schema
get_schema_url() already points at. Not yet wired into
build_editorial_decl_entries().

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the schema-fragment ref into `build_editorial_decl_entries()`

**Files:**

- Modify: `fastapi_app/plugins/grobid/annotation_rules.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`

- [ ] **Step 1: Write the failing tests**

Add a new test class to `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`:

```python
class TestBuildEditorialDeclEntriesSchemaFragment(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_appends_schema_fragment_entry_for_a_fragment_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = []
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())

        self.assertEqual(entries, [
            {
                "category": "schema-fragment",
                "n": "Segmentation schema source",
                "refs": [{
                    "target": "https://github.com/mpilhlt/fossil/blob/sha1/schema/grobid.training.segmentation.rng",
                    "content_type": "xml",
                    "subtype": "human",
                }],
            },
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_no_schema_fragment_entry_for_a_variant_without_a_fossil_source_file(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = []
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.header", MagicMock())

        self.assertEqual(entries, [])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_schema_fragment_entry_appended_alongside_guide_entries(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md", "label": "Document segmentation guidelines"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())

        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["category"], "primary")
        self.assertEqual(entries[1]["category"], "schema-fragment")
```

Also fix the two now-stale assertions in `TestBuildEditorialDeclEntriesVariantMatching.test_matches_variant_listed_explicitly` (`fastapi_app/plugins/grobid/tests/test_annotation_rules.py`, currently around line 23-32): it uses `variant_id="grobid.training.segmentation"`, which is now in `SCHEMA_FRAGMENT_VARIANTS`, so a second, schema-fragment entry will legitimately appear. Change its assertions to check only the guide-derived entry instead of the full list length:

```python
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_matches_variant_listed_explicitly(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())
        guide_entries = [e for e in entries if e["category"] == "primary"]
        self.assertEqual(len(guide_entries), 1)
```

The other three matching/shape tests (`test_wildcard_matches_any_variant`, `test_returns_empty_list_for_unconfigured_variant`, and all of `TestBuildRefsForGuideShapeTable`) use variant ids (`"grobid.training.header"`, `"v1"`) that are not in `SCHEMA_FRAGMENT_VARIANTS`, so they are unaffected and need no change.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: `TestBuildEditorialDeclEntriesSchemaFragment`'s three tests FAIL (`test_no_schema_fragment_entry_for_a_variant_without_a_fossil_source_file` passes trivially since nothing appends yet, but the "appends" and "alongside" tests fail on empty/short `entries`). `test_matches_variant_listed_explicitly` passes already since it doesn't yet assert against the old full-list length.

- [ ] **Step 3: Implement**

Edit `fastapi_app/plugins/grobid/annotation_rules.py`. Update the import block (currently lines 13-23):

```python
from typing import Optional

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    is_line_range_fragment,
    resolve_forge_permalink,
    translate_anchor_to_line_range,
)
from fastapi_app.plugins.grobid.config import (
    AnnotationGuide,
    SCHEMA_FRAGMENT_LABELS,
    get_annotation_guides,
    get_schema_fragment_url,
    get_schema_url,
)
```

Then extend `build_editorial_decl_entries()` (currently lines 26-43):

```python
def build_editorial_decl_entries(variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
    """
    Resolve this variant's configured annotation guides, plus its upstream
    schema-fragment source (if any), into editorialDecl entries.

    A guide matches `variant_id` if its `variant_ids` list contains that id
    or the wildcard "*" (applies to every variant). Each matching guide
    produces one or two refs depending on its configured url/type - see
    _build_refs_for_guide(). "primary" is the category sentinel the
    frontend drawer looks up by default. A variant with a dedicated
    fossil/schema/*.rng source file (see get_schema_fragment_url()) also
    gets one "schema-fragment" entry, appended last, pointing at that
    upstream, hand-editable source - distinct from get_schema_url()'s
    generated/validated-against schema. Returns [] if neither applies.
    """
    entries: list[AnnotationRuleRef] = []
    for guide in get_annotation_guides():
        if variant_id not in guide["variant_ids"] and "*" not in guide["variant_ids"]:
            continue
        refs = _build_refs_for_guide(guide, cache)
        entries.append({"category": guide["category"], "refs": refs, "n": guide["label"]})

    schema_fragment_url = get_schema_fragment_url(variant_id)
    if schema_fragment_url is not None:
        target = resolve_forge_permalink(schema_fragment_url, cache)
        entries.append({
            "category": "schema-fragment",
            "n": SCHEMA_FRAGMENT_LABELS[variant_id],
            "refs": [{"target": target, "content_type": "xml", "subtype": "human"}],
        })

    return entries
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Confirm the `annotationGuides` API field is unaffected**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py -v`
Expected: PASS. This confirms `_build_encoding_desc()`/`create_encoding_desc_with_extractor()` wiring still works; `get_annotation_guides()` itself was not touched by this task (only consumed inside `build_editorial_decl_entries()`), so `extractor.py:88`'s `"annotationGuides": get_annotation_guides()` still returns exactly the four `ANNOTATION_GUIDES` entries, never a `"schema-fragment"` one.

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/grobid/annotation_rules.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py
git commit -m "feat(grobid): embed a ref to the upstream schema-fragment source

build_editorial_decl_entries() now appends one schema-fragment
editorialDecl/interpretation entry (subtype=human, type=xml) for
variants with a dedicated fossil/schema/*.rng source file, permalink-
pinned like guide refs. Reuses the generic interpretation-ref layer
only - AnnotationGuide/ANNOTATION_GUIDES/get_annotation_guides() are
untouched, so the annotationGuides API field and the Annotation Guide
drawer are unaffected. See
docs/superpowers/specs/2026-09-28-grobid-schema-fragment-refs-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Preserve `@n` on "Refresh document rules"

**Files:**

- Modify: `fastapi_app/lib/doc_rules/rules_refresh.py:151-187` (`_replace_editorial_decl()`)
- Test: `tests/unit/fastapi/test_doc_rules_rules_refresh.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/fastapi/test_doc_rules_rules_refresh.py`, inside `TestPreviewAndPerformRefresh` (after `test_replaces_editorial_decl_and_schema_pi_and_adds_change`):

```python
    async def test_refresh_writes_the_n_attribute_when_the_provider_sets_it(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "n": "Citation model guidelines", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn('n="Citation model guidelines"', saved_content)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: FAIL — `saved_content` has no `n="Citation model guidelines"` because `_replace_editorial_decl()` never calls `.set("n", ...)`.

- [ ] **Step 3: Implement**

Edit `_replace_editorial_decl()` in `fastapi_app/lib/doc_rules/rules_refresh.py` (currently lines 176-184):

```python
    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        if entry.get("n"):
            interpretation.set("n", entry["n"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        for ref_entry in entry["refs"]:
            ref = etree.SubElement(p, f"{{{TEI_NS}}}ref", target=ref_entry["target"], subtype=ref_entry["subtype"])
            content_type = ref_entry["content_type"]
            if content_type is not None:
                ref.set("type", content_type)
    encoding_desc.insert(0, editorial_decl)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: PASS (all tests in the file — this also confirms the fix doesn't disturb any existing no-`n` case, since `entry.get("n")` is falsy for those).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/rules_refresh.py tests/unit/fastapi/test_doc_rules_rules_refresh.py
git commit -m "fix(document-rules): preserve interpretation/@n on rules refresh

_replace_editorial_decl() rebuilt every <interpretation> with only its
@type, silently dropping @n on every 'Refresh document rules' rebuild -
the landmine the function's own comment already flagged, now live
since GROBID's build_editorial_decl_entries() sets @n (see the schema-
fragment-refs design spec, part 2b).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Pretty-print the header after refresh

**Files:**

- Modify: `fastapi_app/lib/doc_rules/rules_refresh.py`
- Test: `tests/unit/fastapi/test_doc_rules_rules_refresh.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/fastapi/test_doc_rules_rules_refresh.py`, inside `TestPreviewAndPerformRefresh`:

```python
    async def test_refresh_output_header_is_pretty_printed(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "n": "Citation model guidelines", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_LEGACY_NO_EDITORIAL_DECL_NO_PI)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        header_only = saved_content.split("<teiHeader>", 1)[1].split("</teiHeader>", 1)[0]
        # Pretty-printed: each interpretation/ref/etc. lands on its own,
        # indented line - not all packed onto one line as raw etree.tostring()
        # without pretty_print produces.
        self.assertIn("\n", header_only)
        self.assertIn('  <encodingDesc>', saved_content)
        self.assertIn('    <editorialDecl>', saved_content)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: FAIL — `perform_refresh()` currently serializes with plain `etree.tostring(root, encoding="unicode")` (no `pretty_print=True`), so the header is emitted with no consistent indentation.

- [ ] **Step 3: Refactor `_replace_editorial_decl()` and `_add_revision_change()` to element-mutating helpers**

Replace both functions in `fastapi_app/lib/doc_rules/rules_refresh.py` (currently lines 151-209):

```python
def _replace_editorial_decl(root: etree._Element, entries: list[AnnotationRuleRef]) -> None:
    """
    Replace (or insert) the document's editorialDecl with fresh entries, in
    place on the already-parsed root.

    Inserted as the first child of encodingDesc, before appInfo/schemaRef,
    matching the order create_encoding_desc_with_extractor() uses. Does
    nothing if entries is empty and there was nothing to replace either, or
    if the document has no encodingDesc at all (defensive - expected
    unreachable in practice since every TEI document created by this app
    has an encodingDesc).
    """
    ns = {"tei": TEI_NS}

    encoding_desc = root.find(".//tei:encodingDesc", ns)
    if encoding_desc is None:
        return

    existing = encoding_desc.find("tei:editorialDecl", ns)
    if existing is not None:
        encoding_desc.remove(existing)

    if not entries:
        return

    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        if entry.get("n"):
            interpretation.set("n", entry["n"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        for ref_entry in entry["refs"]:
            ref = etree.SubElement(p, f"{{{TEI_NS}}}ref", target=ref_entry["target"], subtype=ref_entry["subtype"])
            content_type = ref_entry["content_type"]
            if content_type is not None:
                ref.set("type", content_type)
    encoding_desc.insert(0, editorial_decl)


def _add_revision_change(root: etree._Element, who: Optional[str]) -> None:
    """Append a <change> entry to revisionDesc noting the rules refresh, in place on the already-parsed root."""
    ns = {"tei": TEI_NS}

    revision_desc = root.find(".//tei:revisionDesc", ns)
    if revision_desc is None:
        tei_header = root.find(".//tei:teiHeader", ns)
        if tei_header is None:
            raise RuntimeError("Document has no teiHeader; cannot record the refresh as a revision.")
        revision_desc = etree.SubElement(tei_header, f"{{{TEI_NS}}}revisionDesc")

    change = etree.SubElement(revision_desc, f"{{{TEI_NS}}}change")
    change.set("when", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    if who:
        change.set("who", f"#{who}")
    desc = etree.SubElement(change, f"{{{TEI_NS}}}desc")
    desc.text = "Updated document rules"
```

- [ ] **Step 4: Remove `_replace_schema_pi()` and its regexes**

Delete `_XML_MODEL_PI_RE`, `_XML_DECL_RE`, and `_replace_schema_pi()` entirely (currently lines 115-148 in `fastapi_app/lib/doc_rules/rules_refresh.py`). Also remove the now-unused `import re` at the top of the file (line 14) — `re` is no longer used anywhere else in this module.

- [ ] **Step 5: Rewrite `perform_refresh()`'s write path**

Edit `fastapi_app/lib/doc_rules/rules_refresh.py`. Update the import block at the top of the file:

```python
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from lxml import etree

from fastapi_app.lib.core.schema_validator import extract_schema_locations
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document
from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef, extract_annotation_rule_refs
from fastapi_app.lib.utils.tei_utils import create_schema_processing_instruction, serialize_tei_with_formatted_header
```

Then replace the body of `perform_refresh()` from the `try:` block onward (currently lines 317-338):

```python
    try:
        root = etree.fromstring(target.tei_content.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise RuntimeError(f"Could not parse document XML for refresh: {e}") from e

    if plan.editorial_decl_changed:
        _replace_editorial_decl(root, plan.new_entries)
    _add_revision_change(root, who)

    final_schema_url = plan.new_schema_url if plan.new_schema_url is not None else plan.existing_schema_url
    schema_pi = create_schema_processing_instruction(final_schema_url) if final_schema_url is not None else None
    new_content = serialize_tei_with_formatted_header(root, [schema_pi] if schema_pi else [])

    new_bytes = new_content.encode("utf-8")
    saved_hash, _ = file_storage.save_file(new_bytes, target.file_meta.file_type, increment_ref=False)
    if saved_hash != target.file_meta.id:
        file_repo.update_file(target.file_meta.id, FileUpdate(id=saved_hash, file_size=len(new_bytes)))
```

The docstring of `perform_refresh()` already documents the `RuntimeError` on unparseable XML and on a missing `teiHeader` (now raised from `_add_revision_change()`) — no change needed there.

- [ ] **Step 6: Run all rules-refresh tests to verify everything passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: PASS (all tests in the file, including the two written in Task 4 and Step 1 of this task, and every pre-existing test — `test_replaces_editorial_decl_and_schema_pi_and_adds_change`, `test_regenerates_only_the_half_that_changed`, `test_schema_pi_survives_an_editorial_decl_only_refresh`, `test_generates_editorial_decl_and_schema_pi_on_legacy_document`, `test_raises_runtime_error_on_malformed_xml` all assert only on substring presence/absence in the final saved content, which the new pipeline still produces correctly).

- [ ] **Step 7: Run the router test that exercises this path end-to-end**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_document_rules_router.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add fastapi_app/lib/doc_rules/rules_refresh.py tests/unit/fastapi/test_doc_rules_rules_refresh.py
git commit -m "refactor(document-rules): pretty-print the header on refresh

perform_refresh() rewrote the header via three separate string round-
trips (one a regex-based <?xml-model?> PI hack, needed because lxml
drops a PI preceding the root element on a bare parse/serialize
round-trip), never pretty-printing - unlike extraction time. Now
builds one in-memory element through the whole pipeline and serializes
it once via the existing serialize_tei_with_formatted_header(), which
already solves the same PI-loss problem by design.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Lock in the schema-fragment resource's format and label in the generic `interpretation-ref` layer

**Files:**

- Test only: `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`

No production code changes in this task — `InterpretationRefKind.discover()` and `infer_format()` are already fully generic (confirmed by reading `fastapi_app/lib/doc_rules/interpretation_ref_kind.py` and `fastapi_app/lib/doc_rules/resource_key.py`: `.rng` already maps to `"xml"`, and label already falls back through `entry.get("n") or entry["category"]`). This task adds a regression test that pins the schema-fragment shape specifically, so a future change to either function is caught here rather than only failing silently in the GROBID plugin's own tests.

- [ ] **Step 1: Write the test**

Add to `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`, a new fixture constant near the top (after `XML_MACHINE_ONLY`):

```python
XML_SCHEMA_FRAGMENT = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="schema-fragment" n="Segmentation schema source">
      <p><ref target="https://github.com/mpilhlt/fossil/blob/sha1/schema/grobid.training.segmentation.rng" subtype="human" type="xml"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""
```

And a new test method in `TestInterpretationRefKindDiscover`:

```python
    def test_schema_fragment_entry_resolves_to_xml_format_and_configured_label(self):
        descriptors = self.kind.discover(XML_SCHEMA_FRAGMENT)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].format, "xml")
        self.assertEqual(descriptors[0].label, "Segmentation schema source")
        self.assertTrue(descriptors[0].url.endswith("grobid.training.segmentation.rng"))
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py -v`
Expected: PASS on the first run — this confirms the generic layer already handles the new entry shape correctly with zero code changes, which is the point of this task.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py
git commit -m "test(document-rules): pin schema-fragment resource format/label

Regression test locking in that InterpretationRefKind.discover() and
infer_format() already handle a schema-fragment interpretation entry
correctly (format xml via the existing .rng mapping, label via the
existing @n fallback) with no code changes needed - see
docs/superpowers/specs/2026-09-28-grobid-schema-fragment-refs-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full unit suite: `npm run test:unit:fastapi`
- [ ] Run the full test suite (per CLAUDE.md, before considering the feature done): `npm run test:unit && npm run test:e2e`
