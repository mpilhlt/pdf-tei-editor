# Document Rules Registry — Extraction-Time Contribution & Consumer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let extractor plugins contribute their editable prompt fragments through the document rules registry (`for_extraction()`), migrate the two real consumers (llamore-extractor, annotation-review) onto the registry so a user's override selection actually takes effect, and delete the now-obsolete `config/prompt.json` / `data/db/prompt.json` mechanism and its endpoints and frontend UI.

**Architecture:** Two backend seams (`for_extraction()` for extraction-time contribution, plus a small cache-permanence fix for SHA-pinned URLs that `for_extraction()`'s "documents stay resolvable offline" guarantee depends on) feed the two real consumers. llamore-extractor gains exactly one new `editorialDecl/interpretation` entry ("additional instructions"), replacing its ad-hoc `options["instructions"]` extraction option. annotation-review's rule-excerpt gathering gains an override short-circuit ahead of its existing (deliberately unchanged) SSRF-hardened fetch fallback. The old instruction-set JSON files, their two endpoints, and the frontend dialog/select that drove them are then deleted outright — this repo's only real consumer of that data (llamore-gemini's "Default instructions") is being replaced by the new mechanism; the other three `config/prompt.json` entries (`gemini-pro`, `claude-sonnet`, `kisski-neural-chat`) match no actual extractor plugin and are dropped with no replacement.

**Tech Stack:** Python (FastAPI backend), vanilla JS + Lit-adjacent Shoelace components (frontend), unittest.

**Context carried into every task below:** this plan continues the Document Rules Registry work (see `docs/superpowers/specs/2026-09-27-document-rules-registry-design.md`). Plans 1 and 2 already landed: the resource-kind registry (`fastapi_app/lib/doc_rules/kinds.py`, `interpretation_ref_kind.py`, `schema_kind.py`), the override/selection storage (`fastapi_app/lib/doc_rules/storage.py`, `DocumentRulesStore`), the REST API (`fastapi_app/routers/document_rules.py`), and the schema-validation override seam (`fastapi_app/lib/core/schema_validator.py`'s `schema_text_override` parameter, wired into `/validate`). This plan does not touch any of that; it only adds the extraction-time contribution API and migrates the two real consumers.

---

### Task 1: Cache permanence for SHA-pinned URLs

**Why this task exists:** the design spec says a resource behind a SHA-pinned URL is cached "without expiry" because its content is immutable, so a user working offline (or in development, with no network) can still resolve a resource whose commit-pinned cache entry has outlived the normal 1-hour TTL. Nothing in the codebase implements this yet — every existing cache read uses the same fixed TTL regardless of whether the URL is pinned. Task 2's `for_extraction()` depends on this: it seeds the cache with a shipped file's text under a SHA-pinned URL specifically so that guarantee holds, and would silently lose that guarantee after an hour without this task.

**Files:**
- Modify: `fastapi_app/lib/core/url_cache.py`
- Modify: `fastapi_app/lib/core/git_forge_adapters.py`
- Modify: `fastapi_app/lib/utils/annotation_rules_utils.py`
- Test: `tests/unit/fastapi/test_url_cache.py`
- Test: `tests/unit/fastapi/test_git_forge_adapters.py`
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py`

- [ ] **Step 1: Write the failing tests for `UrlCache.get_text(url, ignore_ttl=...)`**

Add to `tests/unit/fastapi/test_url_cache.py`, inside `class TestUrlCache(unittest.TestCase):` (after the existing `test_get_text_returns_none_when_stale` method):

```python
    def test_get_text_ignores_staleness_when_ignore_ttl_is_true(self):
        cache = UrlCache(self.cache_root, ttl_seconds=0)
        cache.set_text("https://example.com/a/b.txt", "content")
        # ttl_seconds=0 means the entry is immediately stale under the default check...
        self.assertIsNone(cache.get_text("https://example.com/a/b.txt"))
        # ...but ignore_ttl=True returns it anyway, regardless of age.
        self.assertEqual(cache.get_text("https://example.com/a/b.txt", ignore_ttl=True), "content")

    def test_get_text_with_ignore_ttl_still_returns_none_when_never_cached(self):
        cache = UrlCache(self.cache_root)
        self.assertIsNone(cache.get_text("https://example.com/never/cached.txt", ignore_ttl=True))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_url_cache.py -v`
Expected: FAIL with `TypeError: get_text() got an unexpected keyword argument 'ignore_ttl'`

- [ ] **Step 3: Implement `ignore_ttl` on `UrlCache.get_text`**

In `fastapi_app/lib/core/url_cache.py`, replace the `get_text` method:

```python
    def get_text(self, url: str, ignore_ttl: bool = False) -> Optional[str]:
        """
        Return cached text for `url`, or None if there is no cache entry.

        Normally an entry older than `ttl_seconds` is treated as missing
        (the default, staleness-checked behavior every existing caller
        keeps). Pass `ignore_ttl=True` for a URL whose content is known to
        be immutable (a commit-SHA-pinned git-forge URL - see
        git_forge_adapters.py's `is_sha_pinned()`) to return any existing
        entry regardless of age, so pinned content stays resolvable
        offline/in development long after the normal TTL would have
        expired it.
        """
        _, cache_file, _ = get_cache_info(url, self.cache_root)
        if not cache_file.is_file():
            return None
        if not ignore_ttl and is_cache_stale(cache_file, self.ttl_seconds):
            return None
        return cache_file.read_text(encoding="utf-8")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_url_cache.py -v`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Write the failing tests for `is_sha_pinned()`**

In `tests/unit/fastapi/test_git_forge_adapters.py`, first add `is_sha_pinned` to both test fake adapters (they will fail to instantiate as abstract classes once Step 7 adds the new abstract method):

```python
class _AlwaysMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return True

    def to_raw_url(self, url: str) -> str:
        return "raw:" + url

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        return "sha:" + url

    def strip_ref(self, url: str) -> str:
        return "stripped:" + url

    def is_sha_pinned(self, url: str) -> bool:
        return False


class _NeverMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return False

    def to_raw_url(self, url: str) -> str:
        raise AssertionError("should not be called")

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        raise AssertionError("should not be called")

    def strip_ref(self, url: str) -> str:
        raise AssertionError("should not be called")

    def is_sha_pinned(self, url: str) -> bool:
        raise AssertionError("should not be called")
```

Then add new test classes at the end of the file:

```python
class TestGitHubAdapterIsShaPinned(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()

    def test_branch_ref_is_not_pinned(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        self.assertFalse(self.adapter.is_sha_pinned(url))

    def test_sha_ref_is_pinned(self):
        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        self.assertTrue(self.adapter.is_sha_pinned(url))

    def test_fragment_is_ignored(self):
        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md#L1-L5"
        self.assertTrue(self.adapter.is_sha_pinned(url))


class TestGitLabAdapterIsShaPinned(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()

    def test_branch_ref_is_not_pinned(self):
        url = "https://gitlab.com/group/project/-/blob/main/docs/guidelines.md"
        self.assertFalse(self.adapter.is_sha_pinned(url))

    def test_sha_ref_is_pinned(self):
        url = f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guidelines.md"
        self.assertTrue(self.adapter.is_sha_pinned(url))
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: FAIL with `AttributeError: 'GitHubAdapter' object has no attribute 'is_sha_pinned'` (and the two fake adapters not yet failing since Step 7 hasn't landed - that's fine, this step is about the real adapters)

- [ ] **Step 7: Implement `is_sha_pinned()`**

In `fastapi_app/lib/core/git_forge_adapters.py`, add to `BaseGitForgeAdapter`:

```python
    @abstractmethod
    def is_sha_pinned(self, url: str) -> bool:
        """True if `url`'s ref segment is already a 40-character commit SHA (immutable content)."""
```

Add to `GitHubAdapter` (after `strip_ref`):

```python
    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        m = self._parse(base_url)
        return bool(_SHA_RE.match(m['ref']))
```

Add to `GitLabAdapter` (after `strip_ref`):

```python
    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        _origin, _project_path, ref, _file_path = self._split(base_url)
        return bool(_SHA_RE.match(ref))
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: PASS (all tests)

- [ ] **Step 9: Write the failing tests for `fetch_rule_excerpt()`'s use of `ignore_ttl`**

Add to `tests/unit/fastapi/test_annotation_rules_utils.py`, inside `class TestFetchRuleExcerpt(unittest.TestCase):`:

```python
    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_sha_pinned_github_url_reads_cache_with_ignore_ttl(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "cached content"

        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        result = fetch_rule_excerpt(url, cache)

        self.assertEqual(result, "cached content")
        cache.get_text.assert_called_once_with(
            f"https://raw.githubusercontent.com/mpilhlt/fossil/{'a' * 40}/docs/guidelines.md",
            ignore_ttl=True,
        )
        mock_get.assert_not_called()

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_branch_ref_github_url_reads_cache_without_ignore_ttl(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "cached content"

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        fetch_rule_excerpt(url, cache)

        cache.get_text.assert_called_once_with(
            "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md",
            ignore_ttl=False,
        )

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_unrecognized_host_reads_cache_without_ignore_ttl(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "cached content"

        fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download", cache)

        cache.get_text.assert_called_once_with("https://pad.gwdg.de/s/abc/download", ignore_ttl=False)
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: FAIL - `cache.get_text` is called with just one positional argument, not `ignore_ttl=...`, so `assert_called_once_with(..., ignore_ttl=...)` fails.

- [ ] **Step 11: Wire `is_sha_pinned` into `fetch_rule_excerpt()`**

In `fastapi_app/lib/utils/annotation_rules_utils.py`, replace the start of `fetch_rule_excerpt`:

```python
    base_url, _, fragment = url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    fetch_url = adapter.to_raw_url(base_url) if adapter else base_url
    pinned = adapter.is_sha_pinned(base_url) if adapter else False

    text = cache.get_text(fetch_url, ignore_ttl=pinned)
    if text is None:
```

(leave everything after that `if text is None:` line unchanged)

- [ ] **Step 12: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS (all tests, old and new)

- [ ] **Step 13: Run the full annotation-rules-adjacent test suite**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_url_cache.py tests/unit/fastapi/test_git_forge_adapters.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS (no regressions in any of the three files)

- [ ] **Step 14: Commit**

```bash
git add fastapi_app/lib/core/url_cache.py fastapi_app/lib/core/git_forge_adapters.py fastapi_app/lib/utils/annotation_rules_utils.py tests/unit/fastapi/test_url_cache.py tests/unit/fastapi/test_git_forge_adapters.py tests/unit/fastapi/test_annotation_rules_utils.py
git commit -m "feat(doc-rules): cache SHA-pinned rule URLs without TTL expiry"
```

---

### Task 2: `for_extraction()` — extraction-time contribution API

**Files:**
- Create: `fastapi_app/lib/doc_rules/extraction_contribution.py`
- Modify: `fastapi_app/lib/doc_rules/__init__.py`
- Test: `tests/unit/fastapi/test_doc_rules_extraction_contribution.py`

**Design context:** `for_extraction()` is what an extractor plugin calls at extraction time to resolve its shipped prompt/rule-fragment files. For each fragment: resolve its (branch-relative) URL to a commit-SHA-pinned permalink, seed the annotation-rules cache with the *shipped file's own current text* under that pinned URL (so the resource is resolvable later without a live fetch - this is what Task 1's cache-permanence fix protects), then check whether the given user has a selected override for that resource; return the override's text if so, else the shipped file's text.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fastapi/test_doc_rules_extraction_contribution.py`:

```python
"""
Unit tests for the document rules registry's extraction-time contribution API.

@testCovers fastapi_app/lib/doc_rules/extraction_contribution.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.extraction_contribution import ExtractionFragment, for_extraction
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

FRAGMENT_URL = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/some/prompt.md"


class TestForExtraction(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

        self.shipped_file = Path(self.temp_dir.name) / "prompt.md"
        self.shipped_file.write_text("Shipped default text.", encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _fragment(self):
        return ExtractionFragment(url=FRAGMENT_URL, file=self.shipped_file, label="Reference extraction instructions")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_no_override_returns_shipped_text(self, mock_resolve):
        mock_resolve.return_value = FRAGMENT_URL.replace("main", "c" * 40)

        results = for_extraction("alice", [self._fragment()], self.store)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].text, "Shipped default text.")
        self.assertEqual(results[0].label, "Reference extraction instructions")
        self.assertEqual(results[0].url_pinned, FRAGMENT_URL.replace("main", "c" * 40))

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_selected_override_wins_over_shipped_text(self, mock_resolve):
        pinned_url = FRAGMENT_URL.replace("main", "c" * 40)
        mock_resolve.return_value = pinned_url

        override = self.store.create_override(
            kind="interpretation-ref",
            resource_key=normalize_resource_key(pinned_url),
            owner="alice",
            note="",
            text="Alice's override text.",
            format="markdown",
            base_url=pinned_url,
            base_hash="hash",
        )
        self.store.set_selection("interpretation-ref", normalize_resource_key(pinned_url), "alice", override["id"])

        results = for_extraction("alice", [self._fragment()], self.store)

        self.assertEqual(results[0].text, "Alice's override text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_another_users_override_is_ignored(self, mock_resolve):
        pinned_url = FRAGMENT_URL.replace("main", "c" * 40)
        mock_resolve.return_value = pinned_url

        override = self.store.create_override(
            kind="interpretation-ref",
            resource_key=normalize_resource_key(pinned_url),
            owner="alice",
            note="",
            text="Alice's override text.",
            format="markdown",
            base_url=pinned_url,
            base_hash="hash",
        )
        self.store.set_selection("interpretation-ref", normalize_resource_key(pinned_url), "alice", override["id"])

        results = for_extraction("bob", [self._fragment()], self.store)

        self.assertEqual(results[0].text, "Shipped default text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_none_user_never_looks_up_an_override(self, mock_resolve):
        mock_resolve.return_value = FRAGMENT_URL.replace("main", "c" * 40)
        self.store.get_selected_override_text = MagicMock(side_effect=AssertionError("should not be called"))

        results = for_extraction(None, [self._fragment()], self.store)

        self.assertEqual(results[0].text, "Shipped default text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_seeds_the_cache_under_the_pinned_url_with_the_shipped_text(self, mock_resolve):
        pinned_url = FRAGMENT_URL.replace("main", "c" * 40)
        mock_resolve.return_value = pinned_url

        with patch("fastapi_app.lib.doc_rules.extraction_contribution.UrlCache") as MockUrlCache:
            mock_cache = MagicMock()
            MockUrlCache.return_value = mock_cache

            for_extraction("alice", [self._fragment()], self.store)

            mock_cache.set_text.assert_called_once_with(pinned_url, "Shipped default text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_multiple_descriptors_each_resolved_independently(self, mock_resolve):
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "c" * 40)
        second_file = Path(self.temp_dir.name) / "prompt2.md"
        second_file.write_text("Second shipped text.", encoding="utf-8")

        results = for_extraction("alice", [
            self._fragment(),
            ExtractionFragment(url=FRAGMENT_URL.replace("prompt.md", "prompt2.md"), file=second_file, label="Second"),
        ], self.store)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].text, "Shipped default text.")
        self.assertEqual(results[1].text, "Second shipped text.")
        self.assertEqual(results[1].label, "Second")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_extraction_contribution.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.doc_rules.extraction_contribution'`

- [ ] **Step 3: Implement `for_extraction()`**

Create `fastapi_app/lib/doc_rules/extraction_contribution.py`:

```python
"""
Extraction-time contribution: lets an extractor plugin resolve its shipped
prompt/rule-fragment files through the document rules registry, so a user's
selected override (if any) is used instead of the shipped default. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Extraction-time contribution").
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import resolve_forge_permalink


@dataclass(frozen=True)
class ExtractionFragment:
    """One shipped prompt/rule-fragment file an extractor plugin contributes."""

    url: str    # the file's (branch-relative) git-forge blob URL, as committed
    file: Path  # local path to the shipped file, read for its current text
    label: str  # human-readable label; becomes the editorialDecl interpretation's @n


@dataclass(frozen=True)
class ResolvedFragment:
    """What an extractor plugin actually uses: the resolved permalink, label, and text to feed the model/prompt."""

    url_pinned: str  # url resolved to a SHA-pinned permalink
    label: str
    text: str        # the user's selected override text if any, else the shipped file's current text


def for_extraction(
    user: Optional[str],
    descriptors: list[ExtractionFragment],
    store: DocumentRulesStore,
) -> list[ResolvedFragment]:
    """
    Resolve each descriptor: pin its URL to the current commit SHA, seed the
    annotation-rules cache with the shipped file's own current text under
    that pinned URL (so the resource is resolvable later without a live
    fetch - see git_forge_adapters.py's is_sha_pinned()/UrlCache's
    ignore_ttl for why this stays fresh indefinitely), then return the
    text to actually use: `user`'s selected "interpretation-ref" override
    for that resource, if any, else the shipped text. `user=None` never
    looks up an override (used text is always the shipped default).
    """
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    results: list[ResolvedFragment] = []
    for descriptor in descriptors:
        pinned_url = resolve_forge_permalink(descriptor.url, cache)
        shipped_text = descriptor.file.read_text(encoding="utf-8")
        cache.set_text(pinned_url, shipped_text)

        override_text = None
        if user is not None:
            resource_key = normalize_resource_key(pinned_url)
            override_text = store.get_selected_override_text("interpretation-ref", resource_key, user)

        results.append(ResolvedFragment(
            url_pinned=pinned_url,
            label=descriptor.label,
            text=override_text if override_text is not None else shipped_text,
        ))
    return results
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_extraction_contribution.py -v`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Export from `doc_rules/__init__.py`**

In `fastapi_app/lib/doc_rules/__init__.py`, add to the imports:

```python
from fastapi_app.lib.doc_rules.extraction_contribution import ExtractionFragment, ResolvedFragment, for_extraction
```

And to `__all__`:

```python
    "ExtractionFragment",
    "ResolvedFragment",
    "for_extraction",
```

- [ ] **Step 6: Run the full doc_rules test suite to check for regressions**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/ -v --grep doc_rules`
Expected: PASS (no regressions in any existing doc_rules test file)

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/doc_rules/extraction_contribution.py fastapi_app/lib/doc_rules/__init__.py tests/unit/fastapi/test_doc_rules_extraction_contribution.py
git commit -m "feat(doc-rules): add for_extraction() extraction-time contribution API"
```

---

### Task 3: `interpretation/@n` support in `create_encoding_desc_with_extractor()`

**Why this task exists:** the design spec's `interpretation/@n` section says an extractor writing `editorialDecl` entries should add `n="<short title>"` alongside `@type`, so the UI can show a human label without exposing the category slug. `AnnotationRuleRef` already has an optional `n` field (added in an earlier plan for `InterpretationRefKind.discover()`'s own label-reading side), but the writer function that actually serializes `editorialDecl` never emits it. Task 4's new llamore editorialDecl entry needs `@n` written correctly from day one; GROBID's existing entries are unaffected (they don't set `n` on the dicts they build, so this change is a no-op for them until a future plan updates GROBID's own guide config).

**Files:**
- Modify: `fastapi_app/lib/utils/tei_utils.py`
- Test: `tests/unit/fastapi/test_create_encoding_desc_with_extractor.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/fastapi/test_create_encoding_desc_with_extractor.py`, after `test_ref_without_content_type`:

```python
    def test_interpretation_carries_n_when_entry_has_one(self):
        header = self._build(editorial_decl_entries=[
            {"category": "additional-instructions", "n": "Reference extraction instructions", "refs": [
                {"target": "https://example.org/guide", "content_type": "markdown", "subtype": "human"},
            ]},
        ])
        interpretation = header.find(".//editorialDecl/interpretation")
        self.assertEqual(interpretation.get("n"), "Reference extraction instructions")

    def test_interpretation_has_no_n_attribute_when_entry_lacks_one(self):
        header = self._build(editorial_decl_entries=[
            {"category": "primary", "refs": [
                {"target": "https://example.org/guide", "content_type": "markdown", "subtype": "human"},
            ]},
        ])
        interpretation = header.find(".//editorialDecl/interpretation")
        self.assertIsNone(interpretation.get("n"))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py -v`
Expected: FAIL on `test_interpretation_carries_n_when_entry_has_one` - `interpretation.get("n")` is `None`

- [ ] **Step 3: Implement `@n` writing**

In `fastapi_app/lib/utils/tei_utils.py`, inside `create_encoding_desc_with_extractor()`, replace:

```python
        for entry in editorial_decl_entries:
            interpretation = etree.SubElement(editorialDecl, "interpretation", type=entry["category"])
            p = etree.SubElement(interpretation, "p")
```

with:

```python
        for entry in editorial_decl_entries:
            interpretation = etree.SubElement(editorialDecl, "interpretation", type=entry["category"])
            n = entry.get("n")
            if n is not None:
                interpretation.set("n", n)
            p = etree.SubElement(interpretation, "p")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py -v`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/tei_utils.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py
git commit -m "feat(doc-rules): write interpretation/@n in create_encoding_desc_with_extractor"
```

---

### Task 4: llamore-extractor migration — additional-instructions fragment

**Files:**
- Create: `fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md`
- Modify: `fastapi_app/plugins/llamore_extractor/extractor.py`
- Modify: `fastapi_app/plugins/llamore_extractor/config.py`
- Modify: `fastapi_app/routers/extraction.py`
- Test: `fastapi_app/plugins/llamore_extractor/tests/test_extractor_editorial_decl.py`

**Design context:** llamore-extractor currently reads a free-text `options["instructions"]` extraction option (populated by the frontend's now-removed instruction-set select, see Task 6/7) and appends it to the LLM prompt. This task replaces that with one new `editorialDecl/interpretation` entry ("additional-instructions" category) sourced from a shipped markdown file via `for_extraction()`, exactly the mechanism `config/prompt.json`'s `"llamore-gemini"` entry is being replaced by. Note llamore's *existing* `ANNOTATION_GUIDES`/`get_annotation_guides()` config (the `pad.gwdg.de` primary annotation guide, surfaced via `get_info()`'s `annotationGuides` field, consumed by the frontend's `annotation-guide.js` drawer) is unrelated to this and untouched - it isn't an `editorialDecl` resource today and this plan doesn't change that.

- [ ] **Step 1: Create the shipped fragment file**

Create `fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md` with exactly the text that was `config/prompt.json`'s `"llamore-gemini"` entry's `text` array, joined with newlines:

```markdown
Always properly capitalize names. Do not use small or all caps even if they appear in the document. 

Do not list references which have already been mentioned in a previous footnote, if they refer to the same analytic item. 
Example: "See Miller, Confessions (fn. 11)." 

However, include them if they refer to the same monographic item mentioned previously, but to a different analytic. 
Example "Bacon, "Nova lux". in "Works" (fn. 11), p 45-34.

A monograph must always have a title. A single analytic title without an additional monographic title does not exist. A book title is always the monographic title. For example, in "Ludwig Wittgenstein, Tractatus logico-philosophicus, London 1922", "Tractatus logico-philosophicus" is the monographic title, not the analytic.

When you encounter incomplete references such as in "Vgl. die Artikel »Fact« im Oxford English Dictionary und »Thatsache« in Grimms Wörterbuch.", extract the analytic titles ("Fact", "Thatsache") and monographic titles ("Oxford English Dictionary", "Grimms Wörterbuch")
```

- [ ] **Step 2: Write the failing test for the new resolution seam**

Create `fastapi_app/plugins/llamore_extractor/tests/test_extractor_editorial_decl.py`:

```python
"""
Unit tests for the "additional instructions" editorialDecl contribution in
the LLamore extractor.

@testCovers fastapi_app/plugins/llamore_extractor/extractor.py
"""

import unittest
from unittest.mock import patch

from fastapi_app.lib.doc_rules.extraction_contribution import ResolvedFragment
from fastapi_app.plugins.llamore_extractor.extractor import LLamoreExtractor


class TestResolveAdditionalInstructions(unittest.TestCase):
    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_db")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_document_rules_store")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.for_extraction")
    def test_resolves_via_for_extraction_and_builds_editorial_decl_entry(
        self, mock_for_extraction, mock_get_store, mock_get_db
    ):
        mock_for_extraction.return_value = [
            ResolvedFragment(
                url_pinned=f"https://github.com/mpilhlt/pdf-tei-editor/blob/{'a' * 40}/fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md",
                label="Reference extraction instructions",
                text="Do the thing.",
            ),
        ]

        extractor = LLamoreExtractor()
        text, entries = extractor._resolve_additional_instructions("alice")

        self.assertEqual(text, "Do the thing.")
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["category"], "additional-instructions")
        self.assertEqual(entry["n"], "Reference extraction instructions")
        self.assertEqual(len(entry["refs"]), 1)
        ref = entry["refs"][0]
        self.assertEqual(ref["target"], mock_for_extraction.return_value[0].url_pinned)
        self.assertEqual(ref["subtype"], "human")
        self.assertEqual(ref["content_type"], "markdown")

        mock_for_extraction.assert_called_once()
        call_args = mock_for_extraction.call_args
        self.assertEqual(call_args[0][0], "alice")
        descriptors = call_args[0][1]
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(
            descriptors[0].url,
            "https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md",
        )
        self.assertTrue(descriptors[0].file.name == "additional-instructions.md")
        self.assertEqual(descriptors[0].label, "Reference extraction instructions")

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_db")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_document_rules_store")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.for_extraction")
    def test_username_none_is_passed_through_unchanged(self, mock_for_extraction, mock_get_store, mock_get_db):
        mock_for_extraction.return_value = [
            ResolvedFragment(url_pinned="https://example.org/x.md", label="Reference extraction instructions", text="Shipped."),
        ]

        extractor = LLamoreExtractor()
        extractor._resolve_additional_instructions(None)

        call_args = mock_for_extraction.call_args
        self.assertIsNone(call_args[0][0])
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/llamore_extractor/tests/test_extractor_editorial_decl.py -v`
Expected: FAIL - `LLamoreExtractor` has no attribute `_resolve_additional_instructions`

- [ ] **Step 4: Remove the "instructions" form option**

In `fastapi_app/plugins/llamore_extractor/config.py`, remove this entry from `FORM_OPTIONS`:

```python
    "instructions": {
        "type": "string",
        "label": "Instructions",
        "description": "Additional instructions for the extraction process",
        "required": False
    },
```

- [ ] **Step 5: Implement the resolution method and wire it into `extract()`**

In `fastapi_app/plugins/llamore_extractor/extractor.py`, add imports at the top:

```python
from pathlib import Path
```

and, alongside the existing local imports:

```python
from fastapi_app.lib.core.dependencies import get_db, get_document_rules_store
from fastapi_app.lib.doc_rules.extraction_contribution import ExtractionFragment, for_extraction
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef
```

Add a module-level constant near the top (after `logger = logging.getLogger(__name__)`):

```python
ADDITIONAL_INSTRUCTIONS_URL = (
    "https://github.com/mpilhlt/pdf-tei-editor/blob/main/"
    "fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md"
)
```

Add a new method to `LLamoreExtractor` (e.g. directly above `_extract_refs_from_pdf`):

```python
    def _resolve_additional_instructions(self, username: Optional[str]) -> tuple[str, list[AnnotationRuleRef]]:
        """
        Resolve the "additional instructions" fragment via for_extraction():
        the text to feed the prompter (the user's selected override, if
        any, else the shipped default) and the one editorialDecl entry
        documenting it.
        """
        store = get_document_rules_store(get_db())
        fragments = for_extraction(username, [
            ExtractionFragment(
                url=ADDITIONAL_INSTRUCTIONS_URL,
                file=Path(__file__).parent / "prompts" / "additional-instructions.md",
                label="Reference extraction instructions",
            ),
        ], store)
        fragment = fragments[0]
        editorial_decl_entries: list[AnnotationRuleRef] = [{
            "category": "additional-instructions",
            "n": fragment.label,
            "refs": [{
                "target": fragment.url_pinned,
                "content_type": "markdown",
                "subtype": "human",
            }],
        }]
        return fragment.text, editorial_decl_entries
```

In `extract()`, right after `options = {}` (the `if options is None:` guard), add:

```python
        username = options.get("username")
        additional_instructions, editorial_decl_entries = self._resolve_additional_instructions(username)
```

Then update the `create_encoding_desc_with_extractor(...)` call (a few lines down) to add the new kwarg:

```python
        encodingDesc = create_encoding_desc_with_extractor(
            timestamp=timestamp,
            extractor_name="LLamore",
            extractor_ident="llamore",
            extractor_version="1.0",
            variant_id=variant_id,
            additional_labels=[
                ("prompter", "LineByLinePrompter"),
                ("model", model),
            ],
            refs=[
                "https://github.com/mpilhlt/llamore",
                schema_url,
            ],
            editorial_decl_entries=editorial_decl_entries,
        )
```

Update the `_extract_refs_from_pdf` call site. Note the keyword argument name, `additional_instructions_text`, deliberately differs from the local variable `additional_instructions` holding its value, to avoid colliding with the nested `CustomPrompter.user_prompt`'s own `additional_instructions` parameter below:

```python
        listBibl = self._extract_refs_from_pdf(pdf_path, options, additional_instructions_text=additional_instructions)
```

Update `_extract_refs_from_pdf`'s signature and body to take the resolved text directly instead of reading `options.get("instructions")`:

```python
    def _extract_refs_from_pdf(self, pdf_path: str, options: Dict[str, Any], additional_instructions_text: str) -> etree._Element:  # type: ignore[name-defined]
        """Extract references from PDF using LLamore."""
        logger.info("Extracting references from %s via LLamore/Gemini", pdf_path)

        gemini_api_key = get_config().get("plugin.llamore.api.key", default="")
        model = options.get("model") or get_config().get("plugin.llamore.model", default="gemini-2.0-flash")

        class CustomPrompter(LineByLinePrompter):
            def user_prompt(self, text=None, additional_instructions="") -> str:
                if additional_instructions_text:
                    additional_instructions += "In particular, follow these rules:\n\n" + additional_instructions_text
                return super().user_prompt(text, additional_instructions)

        extractor = GeminiExtractor(api_key=gemini_api_key, prompter=CustomPrompter(), model=model)
```

(leave the rest of `_extract_refs_from_pdf` - from `references = extractor(pdf_path)` onward - unchanged)

- [ ] **Step 6: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/llamore_extractor/tests/test_extractor_editorial_decl.py -v`
Expected: PASS (both tests)

- [ ] **Step 7: Thread `username` from the extraction router into `options`**

In `fastapi_app/routers/extraction.py`, in `extract_metadata()`, update the block that builds `extraction_options`:

```python
        extraction_options = {**(request.options or {})}
        extraction_options['doc_id'] = file_metadata.doc_id
        extraction_options['stable_id'] = file_metadata.stable_id
        extraction_options['base_url'] = str(http_request.base_url).rstrip('/')
        extraction_options['username'] = current_user.get('username') if current_user else None
```

- [ ] **Step 8: Run the llamore plugin's full test suite and the extraction router's tests**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/llamore_extractor/tests/ tests/unit/fastapi/ -v --grep extraction`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md fastapi_app/plugins/llamore_extractor/extractor.py fastapi_app/plugins/llamore_extractor/config.py fastapi_app/routers/extraction.py fastapi_app/plugins/llamore_extractor/tests/test_extractor_editorial_decl.py
git commit -m "feat(doc-rules): resolve llamore's additional instructions via for_extraction()"
```

---

### Task 5: annotation-review — honor the caller's override selection

**Design context - read carefully before implementing:** `gather_rule_excerpts()` currently fetches each category's "machine"-subtype ref directly (behind an SSRF check and `allow_redirects=False`, since the ref target is a URL taken straight from client-supplied XML - see the existing docstring on `_is_safe_fetch_url`). The override must be looked up by the category's *representative* ref (its "human" ref when present, matching how `InterpretationRefKind.discover()` reports this resource to the rest of the registry, and how the override/selection REST API's `resource_key` is therefore computed) - **not** the "machine" ref used for fetching. The two refs normalize to different resource keys (their fragments differ: a heading anchor vs. a line range), so looking up the override by the machine ref's key would silently never find a selected override. When an override is selected, its text is used directly - no fetch, no SSRF check needed (the text is already stored, already trusted). When no override is selected, the existing safe-fetch fallback runs completely unchanged - **do not** route this fallback through `InterpretationRefKind.resolve_original()` or any generic registry `get()`-style helper: doing so would silently drop the `allow_redirects=False` hardening this plugin specifically needs, since it resolves URLs taken directly from untrusted, client-supplied XML rather than from server config or a write-time-pinned ref.

**Files:**
- Modify: `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`
- Modify: `fastapi_app/plugins/annotation_review/review_logic.py`
- Modify: `fastapi_app/plugins/annotation_review/routes.py`
- Test: `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`
- Test: `fastapi_app/plugins/annotation_review/tests/test_review_logic.py`
- Test: `fastapi_app/plugins/annotation_review/tests/test_routes.py`

- [ ] **Step 1: Promote `_representative_ref` to a public, reusable helper**

In `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`, rename `_representative_ref` to `representative_ref` (drop the leading underscore - both its definition and its one call site inside `discover()`):

```python
def representative_ref(refs: list[AnnotationRuleRefTarget]) -> Optional[AnnotationRuleRefTarget]:
    """
    The one ref of an interpretation entry that represents it as a single
    editable resource: its "human" ref (the whole section a person edits)
    if present, else its sole "machine" ref (a topic configured with only
    a pre-set line-range fragment and no heading anchor). A "machine" ref
    alongside a "human" one is auto-derived from it (see
    grobid/annotation_rules.py's _build_refs_for_guide) and is never
    treated as a second, independently editable resource. Exported (not
    module-private) so other consumers of editorialDecl (e.g.
    annotation_review/review_logic.py) can compute the same resource key
    this kind's discover() reports, when they need to look up an override
    by a different ref of the same entry (e.g. a "machine" ref used for a
    narrower fetch) - see that module's gather_rule_excerpts().
    """
    for ref in refs:
        if ref["subtype"] == "human":
            return ref
    return refs[0] if refs else None
```

and in `discover()`:

```python
            ref = representative_ref(entry["refs"])
```

Update `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py` if it imports `_representative_ref` directly anywhere (search for it); rename any such import/reference to `representative_ref`.

- [ ] **Step 2: Run the interpretation-ref-kind tests to verify no regressions**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py -v`
Expected: PASS

- [ ] **Step 3: Write the failing tests for `gather_rule_excerpts()`'s override check**

In `fastapi_app/plugins/annotation_review/tests/test_review_logic.py`, first add a module-level helper near the top (after the imports, before `SAMPLE_TEXT`/`TEI_DOC` fixtures - check the exact existing fixture names in the file and place this alongside them):

```python
def _no_override_store() -> mock.MagicMock:
    """A DocumentRulesStore stand-in reporting no selected override for anything."""
    store = mock.MagicMock()
    store.get_selected_override_text.return_value = None
    return store
```

Then update **every** existing call to `gather_rule_excerpts(...)` and `run_review(...)` in this file to add `store=_no_override_store(), owner="alice"` as keyword arguments (do not change positional args already present, such as `cache=mock.MagicMock()`). There are calls in `TestGatherRuleExcerpts` (4 calls) and `TestRunReview` (6 calls) - find each with `grep -n "gather_rule_excerpts(\|run_review("` on this file and update all of them.

Then add new tests to `class TestGatherRuleExcerpts(unittest.TestCase):`:

```python
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_uses_the_selected_override_instead_of_fetching(self, mock_fetch):
        store = mock.MagicMock()
        store.get_selected_override_text.return_value = "Overridden rule text."

        excerpts = gather_rule_excerpts(TEI_DOC, cache=mock.MagicMock(), store=store, owner="alice")

        self.assertEqual(excerpts, [("primary", "Overridden rule text.")])
        mock_fetch.assert_not_called()

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_override_lookup_uses_the_human_ref_key_not_the_machine_ref_key(self, mock_fetch):
        from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key

        doc_with_human_and_machine_refs = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref target="https://raw.example.org/guide.md#heading" subtype="human" type="markdown"/>
            <ref target="https://raw.example.org/guide.md#L10-L20" subtype="machine"/>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
  <text><body>x</body></text>
</TEI>
"""
        store = mock.MagicMock()
        store.get_selected_override_text.return_value = "Overridden."

        gather_rule_excerpts(doc_with_human_and_machine_refs, cache=mock.MagicMock(), store=store, owner="alice")

        store.get_selected_override_text.assert_called_once_with(
            "interpretation-ref",
            normalize_resource_key("https://raw.example.org/guide.md#heading"),
            "alice",
        )
        mock_fetch.assert_not_called()

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic._is_safe_fetch_url", return_value=True)
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_falls_back_to_fetch_when_owner_has_no_selected_override(self, mock_fetch, mock_is_safe):
        mock_fetch.return_value = "Fetched rule text."

        excerpts = gather_rule_excerpts(TEI_DOC, cache=mock.MagicMock(), store=_no_override_store(), owner="alice")

        self.assertEqual(excerpts, [("primary", "Fetched rule text.")])
        mock_fetch.assert_called_once()
```

Check the exact fixture name used for the single-category, single-machine-ref TEI document already used by `test_fetches_one_excerpt_per_category_machine_ref` (referred to above as `TEI_DOC`) - use whatever that module's existing constant is actually named.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests/test_review_logic.py -v`
Expected: FAIL - `gather_rule_excerpts() got an unexpected keyword argument 'store'`

- [ ] **Step 5: Implement the override check in `gather_rule_excerpts()` and thread `store`/`owner` through `run_review()`**

In `fastapi_app/plugins/annotation_review/review_logic.py`, update imports:

```python
from fastapi_app.lib.doc_rules.interpretation_ref_kind import representative_ref
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
```

Replace `gather_rule_excerpts()`:

```python
def gather_rule_excerpts(
    xml_string: str,
    cache: UrlCache,
    store: DocumentRulesStore,
    owner: str,
) -> list[tuple[str, str]]:
    """
    Resolve one rule excerpt per editorialDecl category. `owner`'s selected
    override for the category's resource (if any) is used verbatim - no
    fetch, no SSRF check needed, since override text is already stored and
    trusted. Otherwise falls back to fetching the category's "machine"-
    subtype ref (a raw URL taken directly from client-supplied XML, so kept
    behind the existing SSRF/redirect hardening below), sliced to just the
    relevant excerpt. A category with no machine ref, or whose excerpt
    fails to fetch, is skipped (logged), not raised.

    The override lookup is keyed by the category's *representative* ref
    (its "human" ref when present - see interpretation_ref_kind.py's
    representative_ref(), matching how the document-rules registry stores
    and selects overrides for this resource), not the "machine" ref used
    for the actual fetch: the two refs normalize to different resource
    keys (their fragments differ), so looking up by the machine ref would
    silently miss every selected override.
    """
    excerpts: list[tuple[str, str]] = []
    for rule_ref in extract_annotation_rule_refs(xml_string):
        rep_ref = representative_ref(rule_ref["refs"])
        if rep_ref is not None:
            resource_key = normalize_resource_key(rep_ref["target"])
            override_text = store.get_selected_override_text("interpretation-ref", resource_key, owner)
            if override_text is not None:
                excerpts.append((rule_ref["category"], override_text))
                continue

        machine_ref = next((r for r in rule_ref["refs"] if r["subtype"] == "machine"), None)
        if machine_ref is None:
            continue
        if not _is_safe_fetch_url(machine_ref["target"]):
            logger.warning(
                f"annotation-review: skipping rule category '{rule_ref['category']}' "
                f"- unsafe fetch target: {machine_ref['target']!r}"
            )
            continue
        try:
            excerpt = fetch_rule_excerpt(machine_ref["target"], cache, allow_redirects=False)
        except Exception as e:  # noqa: BLE001 - any fetch failure for one category is skip-worthy, not fatal
            logger.warning(
                f"annotation-review: skipping rule category '{rule_ref['category']}' "
                f"- could not fetch excerpt from {machine_ref['target']}: {e}"
            )
            continue
        excerpts.append((rule_ref["category"], excerpt))
    return excerpts
```

Update `run_review()`'s signature and its call to `gather_rule_excerpts`:

```python
async def run_review(
    xml_string: str,
    provider: LLMProvider,
    model_id: str,
    cache: UrlCache,
    store: DocumentRulesStore,
    owner: str,
    chunk_index: int = 0,
) -> tuple[list[Finding], int]:
    """
    Review one chunk of the document's <text>: gather rule excerpts, build the
    prompt, call the LLM, and return (validated findings, total chunk count).
    Findings are validated against the whole <text>, so "old" must be unique
    in the document, not just in the chunk.

    Raises:
        ValueError: document is malformed, has no <text> element, or chunk_index is out of range.
        NoRuleExcerptsError: no rule excerpt could be resolved for any category.
    """
    text_content = extract_text_content(xml_string)
    chunks = split_into_chunks(text_content)
    if not 0 <= chunk_index < len(chunks):
        raise ValueError(f"chunk_index {chunk_index} out of range (document has {len(chunks)} chunks)")
    rule_excerpts = await asyncio.to_thread(gather_rule_excerpts, xml_string, cache, store, owner)
    if not rule_excerpts:
        raise NoRuleExcerptsError("No rule excerpts could be resolved for this document")

    system_prompt = build_system_prompt()
    user_prompt = build_user_prompt(rule_excerpts, chunks[chunk_index], (chunk_index + 1, len(chunks)))
    raw_response = await provider.chat_completion(model_id, system_prompt, user_prompt)
    return parse_and_validate_findings(raw_response, text_content), len(chunks)
```

- [ ] **Step 6: Run the review_logic tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests/test_review_logic.py -v`
Expected: PASS (all tests, old and new)

- [ ] **Step 7: Wire `store`/`owner` through the `/review` route**

In `fastapi_app/plugins/annotation_review/routes.py`, update imports:

```python
from fastapi_app.lib.core.dependencies import get_document_rules_store, require_authenticated_user
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
```

Update the `review()` endpoint's signature and its call to `run_review`:

```python
@router.post("/review", response_model=ReviewResponse)
async def review(
    body: ReviewRequest,
    current_user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> ReviewResponse:
    """
    Review one chunk of the given (possibly unsaved) document content against
    its own editorialDecl rules, using the given provider/model. The response
    reports how many chunks the document has; the client requests each
    chunk_index in turn.
    """
    try:
        provider = LLMProviderRegistry.get_instance().get_provider(body.provider_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    try:
        check_model_access(provider, body.model_id, current_user)
    except ModelAccessDenied as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    cache = UrlCache(get_settings().annotation_rules_cache_dir)

    try:
        findings, chunk_count = await run_review(
            body.xml, provider, body.model_id, cache, store, current_user["username"], body.chunk_index
        )
```

(leave the rest of the function - the `except` clauses and return - unchanged)

- [ ] **Step 8: Update `test_routes.py` to override `get_document_rules_store` with a temp-DB-backed store**

In `fastapi_app/plugins/annotation_review/tests/test_routes.py`, add imports:

```python
import tempfile
from pathlib import Path

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_document_rules_store
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
```

In `TestReviewRoute.setUp()`, add a temp DB and override the dependency (matching the pattern in `tests/unit/fastapi/test_validation_router.py`):

```python
    def setUp(self):
        # model access is covered in test_llm_model_access.py; keep these tests independent of the real config
        patcher = mock.patch.object(routes_module, "check_model_access")
        patcher.start()
        self.addCleanup(patcher.stop)

        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(db)

        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "testuser", "roles": ["admin"]}
        self.app.dependency_overrides[get_document_rules_store] = lambda: self.store
        self.client = TestClient(self.app)
        LLMProviderRegistry.reset_instance()
        LLMProviderRegistry.get_instance().register(_StubProvider())
```

Do the same in `TestReviewRouteModelAccess.setUp()` (the second test class in the file, around line 182-195) - add the same temp DB + `get_document_rules_store` override there too, so any test in that class that reaches `run_review` also has a working store.

- [ ] **Step 9: Run the full annotation-review test suite**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests/ -v`
Expected: PASS (all tests across all files in the plugin's test directory)

- [ ] **Step 10: Commit**

```bash
git add fastapi_app/lib/doc_rules/interpretation_ref_kind.py fastapi_app/plugins/annotation_review/review_logic.py fastapi_app/plugins/annotation_review/routes.py tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py fastapi_app/plugins/annotation_review/tests/test_review_logic.py fastapi_app/plugins/annotation_review/tests/test_routes.py
git commit -m "feat(doc-rules): honor the caller's override selection in annotation-review"
```

---

### Task 6: Delete `config/prompt.json` / `data/db/prompt.json` and their endpoints

**Files:**
- Delete: `config/prompt.json`
- Delete: `data/db/prompt.json` (if present in the working tree; it is user/instance data, not tracked the same way as `config/` - check with `git status`/`ls data/db/prompt.json` first)
- Modify: `fastapi_app/api/config.py`
- Modify: `tests/unit/fastapi/test_db_init.py`

- [ ] **Step 1: Check whether `data/db/prompt.json` is tracked or gitignored**

Run: `git check-ignore -v data/db/prompt.json || echo "not ignored"` and `git ls-files data/db/prompt.json`

If it's tracked, delete it with `git rm`; if it's gitignored/untracked (created lazily at runtime), just remove the file from the working tree with `rm -f data/db/prompt.json` (no `git rm` needed, but note it in the commit description if relevant).

- [ ] **Step 2: Delete `config/prompt.json`**

```bash
git rm config/prompt.json
```

- [ ] **Step 3: Update the failing test first**

In `tests/unit/fastapi/test_db_init.py`, in `TestProjectStructure.test_config_directory_exists`, remove this line:

```python
        assert (config_dir / "prompt.json").exists(), "prompt.json should exist"
```

- [ ] **Step 4: Run the test to verify it now passes (it would otherwise fail once Step 2's deletion lands)**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_db_init.py -v`
Expected: PASS

- [ ] **Step 5: Remove the instructions endpoints from `fastapi_app/api/config.py`**

Remove the `InstructionItem` model:

```python
class InstructionItem(BaseModel):
    """Model for extraction instructions"""
    label: str
    extractor: List[str]
    text: List[str]
```

Remove the `get_instructions` endpoint:

```python
@router.get("/instructions", response_model=List[InstructionItem])
async def get_instructions(user: dict = Depends(require_authenticated_user)) -> List[InstructionItem]:
    """
    Get extraction instructions.

    Requires authentication.
    Returns list of instruction items.
    """
    from ..config import get_settings
    settings = get_settings()
    instruction_file = settings.db_dir / "prompt.json"

    if instruction_file.exists():
        with open(instruction_file, 'r', encoding='utf-8') as f:
            instructions = json.load(f)
    else:
        instructions = [{
            "label": "Default instructions",
            "extractor": ["llamore-gemini"],
            "text": []
        }]

    return instructions
```

Remove the `SaveInstructionsResponse` model and `save_instructions` endpoint:

```python
class SaveInstructionsResponse(BaseModel):
    """Response for saving instructions"""
    result: str


@router.post("/instructions", response_model=SaveInstructionsResponse)
async def save_instructions(
    instructions: List[InstructionItem],
    user: dict = Depends(require_authenticated_user)
) -> SaveInstructionsResponse:
    """
    Save extraction instructions.

    Requires authentication.
    """
    from ..config import get_settings
    settings = get_settings()
    instruction_file = settings.db_dir / "prompt.json"

    # Ensure directory exists
    instruction_file.parent.mkdir(parents=True, exist_ok=True)

    # Convert Pydantic models to dicts for JSON serialization
    instructions_data = [item.model_dump() for item in instructions]

    with open(instruction_file, 'w', encoding='utf-8') as f:
        json.dump(instructions_data, f, indent=4)

    logger.info(f"User {user['username']} saved instructions")

    return SaveInstructionsResponse(result="ok")
```

Check whether `json` and `List` are still used elsewhere in the file after these removals (`grep -n "json\.\|List\[" fastapi_app/api/config.py`); if not, remove their now-unused imports too.

- [ ] **Step 6: Check for any other test referencing these endpoints**

Run: `grep -rln "configListInstructions\|configSaveInstructions\|/config/instructions\|InstructionItem" tests/`

If any Python test file references these (besides `test_db_init.py`, already handled), remove or update the referencing test(s) - there should be none based on this plan's research, but verify.

- [ ] **Step 7: Run the config API's test suite**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/ -v --grep config`
Expected: PASS (no regressions; confirms nothing else depended on the removed endpoints)

- [ ] **Step 8: Regenerate the API client**

Run: `npm run generate-client`
Expected: reports the client changed (the two `/config/instructions` methods and the `InstructionItem`-derived type are removed from `app/src/modules/api-client-v1.js`)

- [ ] **Step 9: Commit**

```bash
git add -A config/prompt.json fastapi_app/api/config.py tests/unit/fastapi/test_db_init.py app/src/modules/api-client-v1.js
git commit -m "feat(doc-rules): delete the config/prompt.json instructions mechanism"
```

(Adjust the `git add` file list to match whatever Step 1 determined about `data/db/prompt.json`, and include it if it was tracked.)

---

### Task 7: Frontend cleanup — remove the prompt-editor plugin and the instruction-set select

**Why now, not deferred to the later frontend plan:** Task 6 deletes the backend endpoints these two pieces of frontend code call. Leaving them in place would break the app (a 404 on every "Edit the prompt instructions" open, and a permanently-empty instruction-set select in the extraction dialog). The full "Edit prompts/schemas" dynamic submenu that eventually replaces the editing UI is out of scope for this plan; this task only removes what's now dead weight so the app stays fully functional and green through `npm run test:e2e`.

**Files:**
- Delete: `app/src/plugins/prompt-editor.js`
- Delete: `app/src/templates/prompt-editor.html`
- Delete: `app/src/templates/prompt-editor.types.js`
- Modify: `app/src/plugins.js`
- Modify: `app/src/plugin-registry.js`
- Modify: `app/src/ui.js`
- Modify: `app/src/plugins/client.js`
- Modify: `app/src/plugins/extraction.js`

- [ ] **Step 1: Delete the prompt-editor plugin files**

```bash
git rm app/src/plugins/prompt-editor.js app/src/templates/prompt-editor.html app/src/templates/prompt-editor.types.js
```

- [ ] **Step 2: Remove its registration from `app/src/plugins.js`**

Remove both occurrences of `PromptEditorPlugin,` from the import list and from the `plugins` array (search with `grep -n PromptEditorPlugin app/src/plugins.js` to find both exact lines - one in the import block, one in the array).

- [ ] **Step 3: Remove its export from `app/src/plugin-registry.js`**

Remove this line:

```js
export { default as PromptEditorPlugin } from './plugins/prompt-editor.js';
```

And this line from the JSDoc-documented map further down the file:

```js
 *   "prompt-editor": import('./plugins/prompt-editor.js').default,
```

- [ ] **Step 4: Remove its typedef references from `app/src/ui.js`**

Remove:

```js
 * @import {promptEditorPart} from './plugins/prompt-editor.js'
```

and:

```js
 * @property {UIPart<SlDialog, promptEditorPart>} promptEditor - A dialog to edit the prompt instructions
```

- [ ] **Step 5: Remove `loadInstructions`/`saveInstructions` from `app/src/plugins/client.js`**

Remove the two functions:

```js
/**
 * Returns the current prompt extraction instruction data
 * @returns {Promise<Array<Object>>} An array of {active,label,text} objects
 */
async function loadInstructions() {
  return await apiClient.configListInstructions();
}

/**
 * Saves the prompt extraction instruction data
 * @param {Array<Object>} instructions An array of {active,label,text} objects
 * @returns {Promise<Object>} The result object
 */
async function saveInstructions(instructions) {
  if (!Array.isArray(instructions)) {
    throw new Error("Instructions must be an array");
  }
  // Send the instructions to the server
  return await apiClient.configSaveInstructions({ instructions });
}
```

Remove their two entries from the file's exports object (search `grep -n "loadInstructions\|saveInstructions" app/src/plugins/client.js` to find the export lines, e.g. `loadInstructions,` and `saveInstructions,`).

- [ ] **Step 6: Remove the instruction-set select from `app/src/plugins/extraction.js`**

Remove the `InstructionData` typedef:

```js
/**
 * Instruction data object
 * @typedef {object} InstructionData
 * @property {string} label - Display label for the instruction
 * @property {string[]} text - Array of instruction text lines
 * @property {string[]} [extractor] - Array of extractor IDs this instruction supports
 */
```

Remove the `@property {string} [instructions]` line from both the `ExtractionFormData` and `ExtractionOptions` typedefs (two separate JSDoc blocks; leave everything else in each typedef unchanged).

In `#promptForExtractionOptions()`, remove:

```js
    const instructionsData = await this.#client.loadInstructions()
    /** @type {string[]} */
    const instructions = []
```

(these two lines sit right before the `documentMetadata` declaration - remove them, leave the rest of the method's setup unchanged)

Remove the entire `else if (optionKey === 'instructions' && ...)` branch:

```js
      } else if (optionKey === 'instructions' && extractorId && instructionsData) {
        const select = Object.assign(new SlSelect, {
          name: 'instructions',
          label: 'Instructions',
          size: 'small'
        })
        select.setAttribute('help-text', 'Choose the instruction set that is added to the prompt')

        let instructionIndex = 0
        for (const instructionData of instructionsData) {
          /** @type {InstructionData} */
          const instructionDataTyped = /** @type {InstructionData} */(instructionData)
          const { label, text, extractor = [] } = instructionDataTyped

          if (extractor.includes(extractorId)) {
            const option = Object.assign(new SlOption, {
              value: String(instructionIndex),
              textContent: label
            })
            instructions[instructionIndex] = text.join('\n')
            select.appendChild(option)
            instructionIndex++
          }
        }

        if (instructionIndex === 0) {
          const option = Object.assign(new SlOption, {
            value: '0',
            textContent: 'No custom instructions'
          })
          instructions[0] = ''
          select.appendChild(option)
        }

        return { element: select, chosenValue: '0' }
      } else if (optionConfig.type === 'string') {
```

(note the `} else if (optionConfig.type === 'string') {` line is kept - only the `instructions` branch above it is removed, so the surrounding `if/else if` chain remains syntactically valid)

Remove the value-substitution branch further down:

```js
        if (name === 'instructions' && instructions[parseInt(String(value))]) {
          value = instructions[parseInt(String(value))]
        }

```

(leave the surrounding `for (const input of dynamicInputs) { ... }` loop's other lines, e.g. the `variant_id` check right after it, unchanged)

- [ ] **Step 7: Search for any remaining reference**

Run: `grep -rn "loadInstructions\|saveInstructions\|InstructionItem\|InstructionData\|prompt-editor\|PromptEditorPlugin\|promptEditorPart" app/src`
Expected: no results

- [ ] **Step 8: Run the JS unit test suite**

Run: `npm run test:unit`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add -A app/src
git commit -m "feat(doc-rules): remove the prompt-editor plugin and instruction-set select"
```

---

### Final verification (after all tasks)

- [ ] **Step 1: Run the full unit test suite**

Run: `npm run test:unit`
Expected: PASS - same pre-existing, unrelated failure as prior plans in this branch (`tests/unit/fastapi/test_plugin_tools_sandbox_client.py::TestGenerateSandboxClientScript::test_uses_cached_script_when_source_missing`, confirmed via git blame to predate this branch), no other failures.

- [ ] **Step 2: Run the full API test suite**

Run: `npm run test:api`
Expected: PASS

- [ ] **Step 3: Run the full E2E test suite**

Run: `npm run test:e2e`
Expected: PASS - in particular, confirm no test exercises "Edit the prompt instructions" or the extraction dialog's old instruction-set select (a test that does would need updating/removal as part of this plan, not left broken)

- [ ] **Step 4: Dispatch a final code-reviewer subagent for the entire implementation**

Use the `superpowers:requesting-code-review` template, comparing the branch's state before Task 1's first commit against `HEAD`, describing the full scope of this plan (extraction-time contribution, llamore/annotation-review consumer migration, config/prompt.json deletion, frontend cleanup).

- [ ] **Step 5: Report to the user**

Summarize what was built, the key review-driven fixes (in particular the human-ref-vs-machine-ref override lookup bug found and fixed during planning/Task 5, and the SHA-pinned cache-permanence addition), and the full-suite verification results. Ask whether to continue to the next plan (the generalized "Refresh document rules" action, per the design spec) or pause for review.
