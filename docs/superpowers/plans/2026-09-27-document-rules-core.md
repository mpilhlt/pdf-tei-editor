# Document Rules Registry — Core (Plan 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pluggable resource-kind registry, generic override/selection storage, and the REST API for discovering, querying, and overriding the resources a TEI document references (interpretation-ref prompt/rule fragments and its schema) — everything described in [docs/superpowers/specs/2026-09-27-document-rules-registry-design.md](../specs/2026-09-27-document-rules-registry-design.md) except the schema-validator seam, extraction-time contribution/consumers, the "Refresh document rules" action, and the frontend, which are separate follow-up plans (2–5) building on this one.

**Architecture:** A new `fastapi_app/lib/doc_rules/` package: a `ResourceKind` ABC + lazy-singleton registry (mirroring the existing `GitForgeAdapterRegistry` pattern in `git_forge_adapters.py`), two built-in kinds (`InterpretationRefKind`, `SchemaKind`) that each reuse existing, already-tested fetch/cache logic (`annotation_rules_utils.fetch_rule_excerpt`, `schema_validator`'s locate/download/cache functions), a `DocumentRulesStore` repository over two new SQLite tables, and a `/api/v1/document-rules` FastAPI router. No document is parsed twice: the router receives posted XML content, exactly like the existing `/validate` endpoint.

**Tech Stack:** FastAPI, Pydantic, sqlite3 (via the existing `DatabaseManager`/migration infrastructure), lxml, Python `unittest`.

---

## File Structure

Create:

- `fastapi_app/lib/doc_rules/__init__.py` — public API re-exports
- `fastapi_app/lib/doc_rules/kinds.py` — `ResourceKind`, `ResourceDescriptor`, `ResourceKindRegistry`, `register_resource_kind`, `get_resource_kind`, `list_resources`
- `fastapi_app/lib/doc_rules/resource_key.py` — `normalize_resource_key`, `infer_format`
- `fastapi_app/lib/doc_rules/interpretation_ref_kind.py` — `InterpretationRefKind`
- `fastapi_app/lib/doc_rules/schema_kind.py` — `SchemaKind`
- `fastapi_app/lib/doc_rules/builtins.py` — `register_builtin_kinds`
- `fastapi_app/lib/doc_rules/storage.py` — `DocumentRulesStore`
- `fastapi_app/lib/core/migrations/versions/m009_document_rules_tables.py` — the `resource_overrides`/`resource_selection` migration
- `fastapi_app/lib/core/migrations/tests/test_migration_009.py`
- `fastapi_app/lib/models/models_document_rules.py` — Pydantic request/response models
- `fastapi_app/routers/document_rules.py` — the REST router
- `tests/unit/fastapi/test_doc_rules_kinds.py`
- `tests/unit/fastapi/test_doc_rules_resource_key.py`
- `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`
- `tests/unit/fastapi/test_doc_rules_schema_kind.py`
- `tests/unit/fastapi/test_doc_rules_storage.py`
- `tests/unit/fastapi/test_document_rules_router.py`

Modify:

- `fastapi_app/lib/utils/annotation_rules_utils.py` — `@n` label parsing (Task 1)
- `fastapi_app/lib/core/git_forge_adapters.py` — add `strip_ref()` (Task 2)
- `fastapi_app/lib/core/migrations/versions/__init__.py` — register migration 009
- `fastapi_app/main.py` — mount the new router
- `app/src/modules/api-client-v1.js` — regenerated (Task 10)
- `tests/unit/fastapi/test_annotation_rules_utils.py` — new `@n` cases (Task 1)
- `tests/unit/fastapi/test_git_forge_adapters.py` — new `strip_ref()` cases (Task 2)

---

### Task 1: `@n` category-label parsing

**Files:**
- Modify: `fastapi_app/lib/utils/annotation_rules_utils.py`
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py`

`interpretation/@n` is the (optional) short display label a plugin writes alongside `@type` (see the spec's "`interpretation/@n` — category label" section). `extract_annotation_rule_refs()` must read it without breaking the existing `entries != existing_entries` comparison in `fastapi_app/plugins/grobid/annotation_rules_refresh.py`, which relies on entries that don't carry `@n` yet comparing equal — so the key must be genuinely *absent* from the parsed dict when the document has no `@n`, not present with value `None`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/fastapi/test_annotation_rules_utils.py` (append a new test class; keep existing imports and classes untouched):

```python
class TestExtractAnnotationRuleRefsLabel(unittest.TestCase):
    def test_includes_n_when_present(self):
        xml = """<?xml version="1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader><encodingDesc><editorialDecl>
            <interpretation type="data-correction" n="Data correction">
              <p><ref target="https://example.com/rules.md" subtype="human"/></p>
            </interpretation>
          </editorialDecl></encodingDesc></teiHeader>
        </TEI>"""
        entries = extract_annotation_rule_refs(xml)
        self.assertEqual(entries[0].get("n"), "Data correction")

    def test_omits_n_key_entirely_when_absent(self):
        xml = """<?xml version="1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader><encodingDesc><editorialDecl>
            <interpretation type="primary">
              <p><ref target="https://example.com/rules.md" subtype="human"/></p>
            </interpretation>
          </editorialDecl></encodingDesc></teiHeader>
        </TEI>"""
        entries = extract_annotation_rule_refs(xml)
        self.assertNotIn("n", entries[0])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: FAIL — `test_includes_n_when_present` fails because `entries[0].get("n")` is `None` (the attribute isn't read yet); `test_omits_n_key_entirely_when_absent` passes already (nothing sets it).

- [ ] **Step 3: Implement**

In `fastapi_app/lib/utils/annotation_rules_utils.py`, update the imports and the `AnnotationRuleRef` TypedDict:

```python
from typing import Literal, NotRequired, Optional, TypedDict
```

```python
class AnnotationRuleRef(TypedDict):
    """
    One editorialDecl/interpretation entry: a rule category and its one or two refs.

    "category" is interpretation/@type (e.g. "primary", "footnote-annotation").
    "n" is interpretation/@n, a short display label (TEI's att.global.attribute.n);
    absent (not merely None) when the document has no @n, so equality checks
    against entries built before this attribute existed are unaffected.
    """

    category: str
    n: NotRequired[Optional[str]]
    refs: list[AnnotationRuleRefTarget]
```

Update `extract_annotation_rule_refs()`'s loop body (replace the final `results.append({"category": category, "refs": refs})` line):

```python
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

        entry: AnnotationRuleRef = {"category": category, "refs": refs}
        n = interpretation.get("n")
        if n is not None:
            entry["n"] = n
        results.append(entry)
    return results
```

(Only the last block of the loop changes — the rest of the function body above it is unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Regression-check the existing consumers**

`grobid/annotation_rules.py`'s `build_editorial_decl_entries` still never sets `"n"`, so its output continues to compare equal against parsed entries from documents without `@n` — confirm this hasn't regressed:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v`
Expected: PASS (unchanged)

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/lib/utils/annotation_rules_utils.py tests/unit/fastapi/test_annotation_rules_utils.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): parse interpretation/@n as an optional category label

@n is TEI's standard alternative-name attribute; used as a short display
label for a rule category once the document rules registry lands. Kept
NotRequired (absent, not None, when the document has no @n) so the
existing entries != existing_entries comparison in GROBID's rules-refresh
action is unaffected.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `strip_ref()` on git-forge adapters

**Files:**
- Modify: `fastapi_app/lib/core/git_forge_adapters.py`
- Test: `tests/unit/fastapi/test_git_forge_adapters.py`

The resource key (see spec's "Resource key" concept) must make `blob/<sha>/path` and `blob/main/path` URLs for the same file collide, regardless of which ref a document happened to pin. Neither existing adapter method does this (`to_raw_url` keeps the ref in the raw-fetch URL; `resolve_ref_to_sha` replaces a branch with a SHA, the opposite direction), so add a new method.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/fastapi/test_git_forge_adapters.py`:

```python
class TestGitHubAdapterStripRef(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()

    def test_sha_and_branch_urls_normalize_to_the_same_key(self):
        sha_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/abc123def456/rules.md"
        branch_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
        self.assertEqual(self.adapter.strip_ref(sha_url), self.adapter.strip_ref(branch_url))

    def test_strip_ref_keeps_owner_repo_and_path(self):
        url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/rules.md"
        stripped = self.adapter.strip_ref(url)
        self.assertIn("mpilhlt/pdf-tei-editor", stripped)
        self.assertIn("docs/rules.md", stripped)
        self.assertNotIn("/main/", stripped)


class TestGitLabAdapterStripRef(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()

    def test_sha_and_branch_urls_normalize_to_the_same_key(self):
        sha_url = "https://gitlab.com/group/project/-/blob/abc123/rules.md"
        branch_url = "https://gitlab.com/group/project/-/blob/main/rules.md"
        self.assertEqual(self.adapter.strip_ref(sha_url), self.adapter.strip_ref(branch_url))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: FAIL with `AttributeError: 'GitHubAdapter' object has no attribute 'strip_ref'`

- [ ] **Step 3: Implement**

In `fastapi_app/lib/core/git_forge_adapters.py`, add the abstract method to `BaseGitForgeAdapter` (after `resolve_ref_to_sha`'s declaration):

```python
    @abstractmethod
    def strip_ref(self, url: str) -> str:
        """Return `url` (fragment removed) with its branch/tag/SHA ref segment replaced by a fixed placeholder, so two URLs to the same file differing only in ref normalize to the same string."""
```

Add to `GitHubAdapter` (after `resolve_ref_to_sha`):

```python
    def strip_ref(self, url: str) -> str:
        base_url, _, _ = url.partition("#")
        m = self._parse(base_url)
        return f"https://github.com/{m['owner']}/{m['repo']}/blob/_/{m['path']}"
```

Add to `GitLabAdapter` (after `resolve_ref_to_sha`):

```python
    def strip_ref(self, url: str) -> str:
        base_url, _, _ = url.partition("#")
        origin, project_path, _ref, file_path = self._split(base_url)
        return f"{origin}/{project_path}/-/blob/_/{file_path}"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/core/git_forge_adapters.py tests/unit/fastapi/test_git_forge_adapters.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): add strip_ref() to git-forge adapters

Needed by the document rules registry's resource-key normalization: a
key must be stable across which ref (branch or pinned SHA) a document
happens to embed, which neither existing adapter method provides.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Resource key normalization and format inference

**Files:**
- Create: `fastapi_app/lib/doc_rules/__init__.py` (empty for now; populated in Task 9)
- Create: `fastapi_app/lib/doc_rules/resource_key.py`
- Test: `tests/unit/fastapi/test_doc_rules_resource_key.py`

- [ ] **Step 1: Create the package**

```bash
mkdir -p fastapi_app/lib/doc_rules
touch fastapi_app/lib/doc_rules/__init__.py
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/fastapi/test_doc_rules_resource_key.py`:

```python
"""
Unit tests for resource key normalization and format inference.

@testCovers fastapi_app/lib/doc_rules/resource_key.py
"""

import unittest

from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key


class TestNormalizeResourceKey(unittest.TestCase):
    def test_sha_and_branch_github_urls_collide(self):
        sha_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/abc123/rules.md"
        branch_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
        self.assertEqual(normalize_resource_key(sha_url), normalize_resource_key(branch_url))

    def test_line_range_fragment_is_retained(self):
        url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L10-L20"
        self.assertTrue(normalize_resource_key(url).endswith("#L10-L20"))

    def test_different_line_ranges_produce_different_keys(self):
        base = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
        self.assertNotEqual(
            normalize_resource_key(f"{base}#L1-L5"),
            normalize_resource_key(f"{base}#L6-L10"),
        )

    def test_unrecognized_url_used_verbatim(self):
        url = "https://example.com/schema/tei.rng"
        self.assertEqual(normalize_resource_key(url), url)


class TestInferFormat(unittest.TestCase):
    def test_markdown_extension(self):
        self.assertEqual(infer_format("https://example.com/a/rules.md"), "markdown")
        self.assertEqual(infer_format("https://example.com/a/rules.markdown"), "markdown")

    def test_xml_and_rng_extensions(self):
        self.assertEqual(infer_format("https://example.com/schema/tei.rng"), "xml")
        self.assertEqual(infer_format("https://example.com/a/data.xml"), "xml")

    def test_default_is_text(self):
        self.assertEqual(infer_format("https://example.com/a/notes"), "text")

    def test_extension_check_ignores_fragment(self):
        self.assertEqual(infer_format("https://example.com/a/rules.md#L1-L5"), "markdown")
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_resource_key.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'fastapi_app.lib.doc_rules.resource_key'`

- [ ] **Step 4: Implement**

Create `fastapi_app/lib/doc_rules/resource_key.py`:

```python
"""
Resource key normalization and format inference for the document rules
registry. See docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Resource key").
"""

from typing import Literal
from urllib.parse import urlsplit

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry


def normalize_resource_key(url: str) -> str:
    """
    Normalize a resource URL to a key stable across which ref/commit a
    document happens to pin: the git-forge ref segment is replaced by a
    fixed placeholder (via the matching adapter's strip_ref()), any line-
    range fragment is retained, and a URL no adapter recognizes is used
    verbatim.
    """
    base_url, _, fragment = url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    key_base = adapter.strip_ref(base_url) if adapter else base_url
    return f"{key_base}#{fragment}" if fragment else key_base


def infer_format(url: str) -> Literal["markdown", "text", "xml"]:
    """
    Infer a resource's editor format from its URL's file extension
    (fragment ignored): ".md"/".markdown" -> "markdown"; ".xml"/".rng" ->
    "xml"; anything else (including no extension) -> "text".
    """
    path = urlsplit(url.partition("#")[0]).path.lower()
    if path.endswith(".md") or path.endswith(".markdown"):
        return "markdown"
    if path.endswith(".xml") or path.endswith(".rng"):
        return "xml"
    return "text"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_resource_key.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/lib/doc_rules tests/unit/fastapi/test_doc_rules_resource_key.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): resource key normalization and format inference

First module of the document rules registry package. Reuses the
git-forge adapters' new strip_ref() for key normalization; format is
inferred from the URL's file extension so it never depends on a live
document being present.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Resource-kind registry core

**Files:**
- Create: `fastapi_app/lib/doc_rules/kinds.py`
- Test: `tests/unit/fastapi/test_doc_rules_kinds.py`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_doc_rules_kinds.py`:

```python
"""
Unit tests for the resource-kind registry.

@testCovers fastapi_app/lib/doc_rules/kinds.py
"""

import unittest

from fastapi_app.lib.doc_rules.kinds import (
    ResourceDescriptor,
    ResourceKind,
    ResourceKindRegistry,
    get_resource_kind,
    list_resources,
    register_resource_kind,
)


class _FakeKind(ResourceKind):
    name = "fake-kind"

    def __init__(self, descriptors):
        self._descriptors = descriptors

    def discover(self, xml_string):
        return self._descriptors

    def resolve_original(self, url):
        return f"original:{url}"


class TestResourceKindRegistry(unittest.TestCase):
    def setUp(self):
        # Isolate from the process-wide singleton and its built-in kinds.
        self._saved_instance = ResourceKindRegistry._instance
        ResourceKindRegistry._instance = ResourceKindRegistry()

    def tearDown(self):
        ResourceKindRegistry._instance = self._saved_instance

    def test_register_and_get(self):
        kind = _FakeKind([])
        register_resource_kind(kind)
        self.assertIs(get_resource_kind("fake-kind"), kind)

    def test_get_unregistered_kind_returns_none(self):
        self.assertIsNone(get_resource_kind("does-not-exist"))

    def test_list_resources_concatenates_all_registered_kinds(self):
        d1 = ResourceDescriptor(kind="fake-kind", url="https://a", key="https://a", label="A", format="text")
        d2 = ResourceDescriptor(kind="fake-kind", url="https://b", key="https://b", label="B", format="text")
        register_resource_kind(_FakeKind([d1]))

        class _OtherKind(_FakeKind):
            name = "other-kind"

        register_resource_kind(_OtherKind([d2]))

        self.assertEqual(list_resources("<xml/>"), [d1, d2])


class TestBuiltinKindsRegisterLazily(unittest.TestCase):
    """Uses the real, process-wide singleton (not reset), so built-ins are exercised."""

    def test_interpretation_ref_and_schema_are_registered(self):
        self.assertIsNotNone(get_resource_kind("interpretation-ref"))
        self.assertIsNotNone(get_resource_kind("schema"))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_kinds.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'fastapi_app.lib.doc_rules.kinds'`

- [ ] **Step 3: Implement**

Create `fastapi_app/lib/doc_rules/kinds.py`:

```python
"""
Pluggable registry of resource kinds for the document rules registry. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Resource kind"). Modeled on the lazy-singleton pattern in
git_forge_adapters.py's GitForgeAdapterRegistry.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar, Literal, Optional


@dataclass(frozen=True)
class ResourceDescriptor:
    """One resource a document references, as found by a kind's discover()."""

    kind: str
    url: str            # exact URL as found in the document (may be SHA-pinned)
    key: str             # normalized resource key (see resource_key.py)
    label: str           # human-readable label for the UI
    format: Literal["markdown", "text", "xml"]


class ResourceKind(ABC):
    """A pluggable way of finding and fetching one category of document-linked resource."""

    name: str

    @abstractmethod
    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        """Find this kind's resources referenced by the document."""

    @abstractmethod
    def resolve_original(self, url: str) -> str:
        """Fetch/read the resource's original text."""


class ResourceKindRegistry:
    """Registry of resource kinds, pre-populated with the built-in kinds on first access."""

    _instance: ClassVar[Optional["ResourceKindRegistry"]] = None

    def __init__(self):
        self._kinds: dict[str, ResourceKind] = {}

    @classmethod
    def get_instance(cls) -> "ResourceKindRegistry":
        """Get the singleton registry instance, pre-populated with the built-in kinds."""
        if cls._instance is None:
            cls._instance = cls()
            from fastapi_app.lib.doc_rules.builtins import register_builtin_kinds
            register_builtin_kinds(cls._instance)
        return cls._instance

    def register(self, kind: ResourceKind) -> None:
        """Register a kind. Called once by core at startup for the two built-in kinds, or by a plugin for a custom one."""
        self._kinds[kind.name] = kind

    def get(self, name: str) -> Optional[ResourceKind]:
        return self._kinds.get(name)

    def all(self) -> list[ResourceKind]:
        return list(self._kinds.values())


def register_resource_kind(kind: ResourceKind) -> None:
    """Register a resource kind. See ResourceKindRegistry.register()."""
    ResourceKindRegistry.get_instance().register(kind)


def get_resource_kind(name: str) -> Optional[ResourceKind]:
    """The registered kind named `name`, or None if nothing has registered under that name."""
    return ResourceKindRegistry.get_instance().get(name)


def list_resources(xml_string: str) -> list[ResourceDescriptor]:
    """Every resource every registered kind finds referenced by the document."""
    results: list[ResourceDescriptor] = []
    for kind in ResourceKindRegistry.get_instance().all():
        results.extend(kind.discover(xml_string))
    return results
```

This imports `fastapi_app.lib.doc_rules.builtins`, which doesn't exist yet (Task 6) — that's fine, the import is inside `get_instance()`, evaluated lazily. `TestResourceKindRegistry` in this task's test never calls a path that reaches it because it replaces `_instance` with a manually-constructed empty registry (bypassing `get_instance()`'s lazy-registration branch) and registers directly via `register_resource_kind()`, which only calls `get_instance()` — since `_instance` is already set (non-`None`) at that point, the `if cls._instance is None` branch (and thus the `builtins` import) is never entered. `TestBuiltinKindsRegisterLazily`, which *does* need `builtins` to exist, is satisfied once Task 6 lands — leave it failing for now and confirm in Task 6's step that it then passes.

- [ ] **Step 4: Run the test to verify it passes (partially)**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_kinds.py -v`
Expected: `TestResourceKindRegistry`'s 3 tests PASS; `TestBuiltinKindsRegisterLazily`'s test FAILS with `ModuleNotFoundError: No module named 'fastapi_app.lib.doc_rules.builtins'` — expected at this point, resolved in Task 6.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/kinds.py tests/unit/fastapi/test_doc_rules_kinds.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): resource-kind registry core

ResourceKind ABC + a lazy-singleton registry, mirroring the existing
GitForgeAdapterRegistry pattern. Built-in kinds (interpretation-ref,
schema) are registered lazily on first access so this module has no
import-time dependency on them; that wiring lands in the next two tasks.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `InterpretationRefKind`

**Files:**
- Create: `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`
- Test: `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`

**Design note carried over from the spec review:** an `editorialDecl/interpretation` can have both a "human" ref (a whole section, for a person to read/edit) and a "machine" ref (an auto-derived line-range slice of that same section — see `grobid/annotation_rules.py`'s `_build_refs_for_guide`). The spec's frontend section shows **one** submenu entry per `interpretation`, so `discover()` must pick exactly one representative ref per entry: the "human" ref when present, else the sole "machine" ref (a topic configured with only a pre-set line-range fragment and no heading anchor). The machine ref is never treated as a second, independently editable resource.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`:

```python
"""
Unit tests for the "interpretation-ref" resource kind.

@testCovers fastapi_app/lib/doc_rules/interpretation_ref_kind.py
"""

import unittest
from unittest.mock import patch

from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind

XML_ONE_ENTRY_WITH_LABEL = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="data-correction" n="Data correction">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md" subtype="human" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_TWO_REFS_HUMAN_AND_MACHINE = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary">
      <p>
        <ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#intro" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L1-L10" subtype="machine" type="markdown"/>
      </p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_MACHINE_ONLY = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="footnote-annotation">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L20-L30" subtype="machine" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""


class TestInterpretationRefKindDiscover(unittest.TestCase):
    def setUp(self):
        self.kind = InterpretationRefKind()

    def test_label_falls_back_to_type_when_no_n(self):
        descriptors = self.kind.discover(XML_TWO_REFS_HUMAN_AND_MACHINE)
        self.assertEqual(descriptors[0].label, "primary")

    def test_label_uses_n_when_present(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(descriptors[0].label, "Data correction")

    def test_picks_human_ref_when_both_present(self):
        descriptors = self.kind.discover(XML_TWO_REFS_HUMAN_AND_MACHINE)
        self.assertEqual(len(descriptors), 1)
        self.assertTrue(descriptors[0].url.endswith("#intro"))

    def test_falls_back_to_machine_ref_when_no_human_ref(self):
        descriptors = self.kind.discover(XML_MACHINE_ONLY)
        self.assertEqual(len(descriptors), 1)
        self.assertTrue(descriptors[0].url.endswith("#L20-L30"))

    def test_kind_and_format(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(descriptors[0].kind, "interpretation-ref")
        self.assertEqual(descriptors[0].format, "markdown")

    def test_no_editorial_decl_returns_empty(self):
        self.assertEqual(self.kind.discover("<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"), [])


class TestInterpretationRefKindResolveOriginal(unittest.TestCase):
    def test_delegates_to_fetch_rule_excerpt(self):
        kind = InterpretationRefKind()
        with patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.fetch_rule_excerpt",
            return_value="fetched text",
        ) as mock_fetch:
            result = kind.resolve_original("https://example.com/rules.md")
        self.assertEqual(result, "fetched text")
        mock_fetch.assert_called_once()
        self.assertEqual(mock_fetch.call_args[0][0], "https://example.com/rules.md")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement**

Create `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`:

```python
"""
The "interpretation-ref" resource kind: prompt/rule fragments referenced
by editorialDecl/interpretation. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md.
"""

from typing import Optional

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.kinds import ResourceDescriptor, ResourceKind
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRefTarget,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
)


def _representative_ref(refs: list[AnnotationRuleRefTarget]) -> Optional[AnnotationRuleRefTarget]:
    """
    The one ref of an interpretation entry that represents it as a single
    editable resource: its "human" ref (the whole section a person edits)
    if present, else its sole "machine" ref (a topic configured with only
    a pre-set line-range fragment and no heading anchor). A "machine" ref
    alongside a "human" one is auto-derived from it (see
    grobid/annotation_rules.py's _build_refs_for_guide) and is never
    treated as a second, independently editable resource.
    """
    for ref in refs:
        if ref["subtype"] == "human":
            return ref
    return refs[0] if refs else None


class InterpretationRefKind(ResourceKind):
    name = "interpretation-ref"

    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        descriptors: list[ResourceDescriptor] = []
        for entry in extract_annotation_rule_refs(xml_string):
            ref = _representative_ref(entry["refs"])
            if ref is None:
                continue
            label = entry.get("n") or entry["category"]
            descriptors.append(ResourceDescriptor(
                kind=self.name,
                url=ref["target"],
                key=normalize_resource_key(ref["target"]),
                label=label,
                format=infer_format(ref["target"]),
            ))
        return descriptors

    def resolve_original(self, url: str) -> str:
        cache = UrlCache(get_settings().annotation_rules_cache_dir)
        return fetch_rule_excerpt(url, cache)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/interpretation_ref_kind.py tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): InterpretationRefKind

Discovers editorialDecl/interpretation entries as resources (one per
entry, preferring its "human" ref over an auto-derived "machine" one)
and resolves original text by delegating to the existing
annotation_rules_utils.fetch_rule_excerpt/UrlCache machinery.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `SchemaKind` and built-in registration

**Files:**
- Create: `fastapi_app/lib/doc_rules/schema_kind.py`
- Create: `fastapi_app/lib/doc_rules/builtins.py`
- Test: `tests/unit/fastapi/test_doc_rules_schema_kind.py`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_doc_rules_schema_kind.py`:

```python
"""
Unit tests for the "schema" resource kind.

@testCovers fastapi_app/lib/doc_rules/schema_kind.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi_app.lib.doc_rules.schema_kind import SchemaKind

SCHEMA_LOCATION = "https://example.com/schema/tei.rng"

XML_RELAXNG = f"""<?xml version="1.0"?>
<?xml-model href="{SCHEMA_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"/>
"""

XML_XSD = """<?xml version="1.0"?>
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://example.com/ns https://example.com/schema/doc.xsd">
</root>
"""


class TestSchemaKindDiscover(unittest.TestCase):
    def setUp(self):
        self.kind = SchemaKind()

    def test_relaxng_schema_is_discovered(self):
        descriptors = self.kind.discover(XML_RELAXNG)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].kind, "schema")
        self.assertEqual(descriptors[0].url, SCHEMA_LOCATION)
        self.assertEqual(descriptors[0].format, "xml")
        self.assertEqual(descriptors[0].label, "Schema (RelaxNG)")

    def test_xsd_schema_is_not_discovered_v1_scope(self):
        # XSD schemas can expand into multiple included/imported files with
        # no single "original text" to present as one editable resource -
        # deferred (see the spec's Deferred section).
        self.assertEqual(self.kind.discover(XML_XSD), [])

    def test_no_schema_location_returns_empty(self):
        self.assertEqual(self.kind.discover("<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"), [])


class TestSchemaKindResolveOriginal(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        self.mock_settings = MagicMock()
        self.mock_settings.schema_cache_dir = self.cache_root

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_downloads_when_cache_is_stale_and_returns_content(self):
        kind = SchemaKind()
        with patch("fastapi_app.lib.doc_rules.schema_kind.get_settings", return_value=self.mock_settings), \
             patch("fastapi_app.lib.doc_rules.schema_kind.download_schema_file") as mock_download:
            def fake_download(location, cache_dir, cache_file):
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_file.write_text("<grammar/>", encoding="utf-8")
            mock_download.side_effect = fake_download

            result = kind.resolve_original(SCHEMA_LOCATION)

        self.assertEqual(result, "<grammar/>")
        mock_download.assert_called_once()

    def test_uses_fresh_cache_without_downloading(self):
        from fastapi_app.lib.core.schema_validator import get_schema_cache_info
        cache_dir, cache_file, _ = get_schema_cache_info(SCHEMA_LOCATION, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text("<grammar/>", encoding="utf-8")

        kind = SchemaKind()
        with patch("fastapi_app.lib.doc_rules.schema_kind.get_settings", return_value=self.mock_settings), \
             patch("fastapi_app.lib.doc_rules.schema_kind.download_schema_file") as mock_download:
            result = kind.resolve_original(SCHEMA_LOCATION)

        self.assertEqual(result, "<grammar/>")
        mock_download.assert_not_called()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_schema_kind.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement `SchemaKind`**

Create `fastapi_app/lib/doc_rules/schema_kind.py`:

```python
"""
The "schema" resource kind: the RelaxNG schema referenced by a document's
<?xml-model?> PI or schemaRef. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Schema validation integration"). XSD is out of scope for v1 (deferred):
a multi-file XSD has no single "original text" to present as one
editable resource.
"""

from fastapi_app.config import get_settings
from fastapi_app.lib.core.schema_validator import (
    download_schema_file,
    extract_schema_locations,
    get_schema_cache_info,
    is_schema_cache_stale,
    resolve_schema_location,
)
from fastapi_app.lib.doc_rules.kinds import ResourceDescriptor, ResourceKind
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key


class SchemaKind(ResourceKind):
    name = "schema"

    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        descriptors: list[ResourceDescriptor] = []
        for location in extract_schema_locations(xml_string):
            if location["type"] != "relaxng":
                continue
            url = location["schemaLocation"]
            descriptors.append(ResourceDescriptor(
                kind=self.name,
                url=url,
                key=normalize_resource_key(url),
                label="Schema (RelaxNG)",
                format=infer_format(url),
            ))
        return descriptors

    def resolve_original(self, url: str) -> str:
        settings = get_settings()
        location = resolve_schema_location(url)
        cache_dir, cache_file, _ = get_schema_cache_info(location, settings.schema_cache_dir)
        if is_schema_cache_stale(cache_file):
            download_schema_file(location, cache_dir, cache_file)
        return cache_file.read_text(encoding="utf-8")
```

- [ ] **Step 4: Run the test to verify `SchemaKind` passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_schema_kind.py -v`
Expected: PASS

- [ ] **Step 5: Implement built-in registration**

Create `fastapi_app/lib/doc_rules/builtins.py`:

```python
"""Registers the two resource kinds core ships: interpretation-ref and schema."""

from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.kinds import ResourceKindRegistry
from fastapi_app.lib.doc_rules.schema_kind import SchemaKind


def register_builtin_kinds(registry: ResourceKindRegistry) -> None:
    """Called once, lazily, by ResourceKindRegistry.get_instance() on first access."""
    registry.register(InterpretationRefKind())
    registry.register(SchemaKind())
```

- [ ] **Step 6: Confirm Task 4's deferred test now passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_kinds.py -v`
Expected: PASS (all tests, including `TestBuiltinKindsRegisterLazily`, which was left failing at the end of Task 4)

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/doc_rules/schema_kind.py fastapi_app/lib/doc_rules/builtins.py tests/unit/fastapi/test_doc_rules_schema_kind.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): SchemaKind and built-in kind registration

SchemaKind delegates original-text resolution entirely to the existing
schema_validator locate/download/cache functions - one fetch/cache
implementation for schemas, not duplicated. Wires both built-in kinds
into ResourceKindRegistry's lazy singleton.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Storage migration (`resource_overrides` / `resource_selection`)

**Files:**
- Create: `fastapi_app/lib/core/migrations/versions/m009_document_rules_tables.py`
- Create: `fastapi_app/lib/core/migrations/tests/test_migration_009.py`
- Modify: `fastapi_app/lib/core/migrations/versions/__init__.py`

Before starting, confirm 9 is still the next free migration version (another worktree may have taken it in the meantime):

- [ ] **Step 1: Verify the next free migration number**

Run: `grep -n "version" fastapi_app/lib/core/migrations/versions/__init__.py | tail -5` and `ls fastapi_app/lib/core/migrations/versions/`
Expected: the highest existing file is `m008_change_primary_key.py`; if a `m009_*.py` already exists from other work, use `m010` instead and adjust every reference below accordingly.

- [ ] **Step 2: Write the migration test**

Create `fastapi_app/lib/core/migrations/tests/test_migration_009.py` (manual verification only — not part of the main suite, per [docs/development/migrations.md](../../development/migrations.md)):

```python
"""
Unit tests for migration 009 (document rules tables).

@testCovers fastapi_app/lib/core/migrations/versions/m009_document_rules_tables.py
"""

import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.core.migrations.versions.m009_document_rules_tables import (
    Migration009DocumentRulesTables,
)


class TestMigration009(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        self.logger = logging.getLogger("test_migration_009")
        self.logger.setLevel(logging.ERROR)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_migration_creates_both_tables(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration009DocumentRulesTables(self.logger))
        applied = manager.run_migrations(skip_backup=True)
        self.assertEqual(applied, 1)

        with sqlite3.connect(str(self.db_path)) as conn:
            tables = {
                row[0] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        self.assertIn("resource_overrides", tables)
        self.assertIn("resource_selection", tables)

    def test_migration_is_idempotent(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration009DocumentRulesTables(self.logger))
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)
        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)

    def test_deleting_an_override_cascades_to_its_selection(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration009DocumentRulesTables(self.logger))
        manager.run_migrations(skip_backup=True)

        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute(
                """INSERT INTO resource_overrides
                   (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
                   VALUES ('ov1', 'schema', 'key1', 'alice', '', 'text', 'xml', 'https://x', 'hash', 't', 't')"""
            )
            conn.execute(
                "INSERT INTO resource_selection (owner, kind, resource_key, override_id) "
                "VALUES ('alice', 'schema', 'key1', 'ov1')"
            )
            conn.execute("DELETE FROM resource_overrides WHERE id = 'ov1'")
            conn.commit()

            remaining = conn.execute("SELECT * FROM resource_selection").fetchall()
        self.assertEqual(remaining, [])
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `uv run python -m pytest fastapi_app/lib/core/migrations/tests/test_migration_009.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Implement the migration**

Create `fastapi_app/lib/core/migrations/versions/m009_document_rules_tables.py`:

```python
"""
Migration 009: Add document-rules override/selection tables

Adds the generic, resource-kind-agnostic storage for the document rules
registry (see
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md):
user-owned editable copies of a document-referenced resource
(resource_overrides) and each user's current selection per resource
(resource_selection). Neither table references "prompt" or "schema" by
name, so a future resource kind needs no schema change.

Before: neither table exists.
After: resource_overrides and resource_selection exist, with
resource_selection.override_id cascading on delete.
"""

import sqlite3
from fastapi_app.lib.core.migrations.base import Migration


class Migration009DocumentRulesTables(Migration):
    @property
    def version(self) -> int:
        return 9

    @property
    def description(self) -> str:
        return "Add resource_overrides and resource_selection tables for the document rules registry"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_overrides'"
        )
        if cursor.fetchone() is not None:
            self.logger.info("Migration already applied (resource_overrides exists)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Creating resource_overrides and resource_selection tables")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS resource_overrides (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                resource_key TEXT NOT NULL,
                owner TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL,
                format TEXT NOT NULL,
                base_url TEXT NOT NULL,
                base_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_resource_overrides_owner_key "
            "ON resource_overrides (owner, kind, resource_key)"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS resource_selection (
                owner TEXT NOT NULL,
                kind TEXT NOT NULL,
                resource_key TEXT NOT NULL,
                override_id TEXT NOT NULL REFERENCES resource_overrides (id) ON DELETE CASCADE,
                PRIMARY KEY (owner, kind, resource_key)
            )
        """)
        self.logger.info("Migration 009 complete")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Reverting migration 009")
        conn.execute("DROP TABLE IF EXISTS resource_selection")
        conn.execute("DROP TABLE IF EXISTS resource_overrides")
```

- [ ] **Step 5: Register the migration**

In `fastapi_app/lib/core/migrations/versions/__init__.py`, add the import:

```python
from .m009_document_rules_tables import Migration009DocumentRulesTables
```

Add it to `METADATA_MIGRATIONS`:

```python
METADATA_MIGRATIONS = [
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
    Migration004EncodePdfDocIds,
    Migration005AddStatusColumn,
    Migration006AddLastRevisionColumn,
    Migration007AddCreatedByColumn,
    Migration008ChangePrimaryKey,
    Migration009DocumentRulesTables,
]
```

Add it to `ALL_MIGRATIONS`:

```python
ALL_MIGRATIONS = [
    Migration001LocksFileId,
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
    Migration004EncodePdfDocIds,
    Migration005AddStatusColumn,
    Migration006AddLastRevisionColumn,
    Migration007AddCreatedByColumn,
    Migration008ChangePrimaryKey,
    Migration009DocumentRulesTables,
]
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `uv run python -m pytest fastapi_app/lib/core/migrations/tests/test_migration_009.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/core/migrations/versions/m009_document_rules_tables.py \
        fastapi_app/lib/core/migrations/tests/test_migration_009.py \
        fastapi_app/lib/core/migrations/versions/__init__.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): migration 009 - resource_overrides/resource_selection tables

Generic, resource-kind-agnostic storage for the document rules registry.
Runs automatically on next app startup via the existing metadata.db
migration runner.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `DocumentRulesStore` repository

**Files:**
- Create: `fastapi_app/lib/doc_rules/storage.py`
- Test: `tests/unit/fastapi/test_doc_rules_storage.py`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_doc_rules_storage.py`:

```python
"""
Unit tests for DocumentRulesStore.

@testCovers fastapi_app/lib/doc_rules/storage.py
"""

import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore


class TestDocumentRulesStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _create(self, owner="alice", note="my note", text="override text"):
        return self.store.create_override(
            kind="interpretation-ref",
            resource_key="https://example.com/rules.md",
            owner=owner,
            note=note,
            text=text,
            format="markdown",
            base_url="https://example.com/rules.md",
            base_hash="deadbeef",
        )

    def test_create_and_get_override(self):
        created = self._create()
        fetched = self.store.get_override(created["id"])
        self.assertEqual(fetched["note"], "my note")
        self.assertEqual(fetched["text"], "override text")
        self.assertEqual(fetched["owner"], "alice")

    def test_list_overrides_scoped_to_owner_kind_and_key(self):
        self._create(owner="alice")
        self._create(owner="bob")
        alice_overrides = self.store.list_overrides("interpretation-ref", "https://example.com/rules.md", "alice")
        self.assertEqual(len(alice_overrides), 1)
        self.assertEqual(alice_overrides[0]["owner"], "alice")

    def test_update_override_owner_only(self):
        created = self._create(owner="alice")
        updated = self.store.update_override(created["id"], "alice", note="new note", text=None)
        self.assertEqual(updated["note"], "new note")
        self.assertEqual(updated["text"], "override text")  # unchanged

        rejected = self.store.update_override(created["id"], "bob", note="hijack", text=None)
        self.assertIsNone(rejected)

    def test_delete_override_owner_only(self):
        created = self._create(owner="alice")
        self.assertFalse(self.store.delete_override(created["id"], "bob"))
        self.assertTrue(self.store.delete_override(created["id"], "alice"))
        self.assertIsNone(self.store.get_override(created["id"]))

    def test_selection_roundtrip(self):
        created = self._create(owner="alice")
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))

        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.assertEqual(
            self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"),
            created["id"],
        )

        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", None)
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))

    def test_deleting_selected_override_clears_selection(self):
        created = self._create(owner="alice")
        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.store.delete_override(created["id"], "alice")
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))

    def test_get_selected_override_text_falls_back_to_none(self):
        self._create(owner="alice")
        self.assertIsNone(
            self.store.get_selected_override_text("interpretation-ref", "https://example.com/rules.md", "alice")
        )

    def test_reset_selection_keeps_overrides(self):
        created = self._create(owner="alice")
        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.store.reset_selection("alice", [("interpretation-ref", "https://example.com/rules.md")])
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))
        self.assertIsNotNone(self.store.get_override(created["id"]))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_storage.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement**

Create `fastapi_app/lib/doc_rules/storage.py`:

```python
"""
Generic storage for the document rules registry: user-owned overrides of
a resource and each user's current selection per resource. Both tables
are resource-kind-agnostic (see migration 009); business logic that
knows about specific kinds lives in kinds.py and its implementations,
not here.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi_app.lib.core.database import DatabaseManager


class DocumentRulesStore:
    """CRUD for resource_overrides and resolution/selection for resource_selection."""

    def __init__(self, db: DatabaseManager):
        self.db = db

    def list_overrides(self, kind: str, resource_key: str, owner: str) -> list[dict]:
        return self.db.execute_query(
            "SELECT * FROM resource_overrides WHERE kind = ? AND resource_key = ? AND owner = ? ORDER BY created_at",
            (kind, resource_key, owner),
        )

    def get_override(self, override_id: str) -> Optional[dict]:
        return self.db.execute_query(
            "SELECT * FROM resource_overrides WHERE id = ?", (override_id,), fetch_one=True
        )

    def create_override(
        self,
        kind: str,
        resource_key: str,
        owner: str,
        note: str,
        text: str,
        format: str,
        base_url: str,
        base_hash: str,
    ) -> dict:
        override_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        self.db.execute_update(
            """
            INSERT INTO resource_overrides
                (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (override_id, kind, resource_key, owner, note, text, format, base_url, base_hash, now, now),
        )
        override = self.get_override(override_id)
        assert override is not None
        return override

    def update_override(
        self, override_id: str, owner: str, note: Optional[str], text: Optional[str]
    ) -> Optional[dict]:
        """Update note and/or text (whichever is not None). Returns None if not found or not owned by `owner`."""
        existing = self.get_override(override_id)
        if existing is None or existing["owner"] != owner:
            return None
        new_note = existing["note"] if note is None else note
        new_text = existing["text"] if text is None else text
        now = datetime.now(timezone.utc).isoformat()
        self.db.execute_update(
            "UPDATE resource_overrides SET note = ?, text = ?, updated_at = ? WHERE id = ?",
            (new_note, new_text, now, override_id),
        )
        return self.get_override(override_id)

    def delete_override(self, override_id: str, owner: str) -> bool:
        """Delete an override owned by `owner`. Cascades to any selection pointing at it (foreign key). Returns False if not found or not owned by `owner`."""
        existing = self.get_override(override_id)
        if existing is None or existing["owner"] != owner:
            return False
        self.db.execute_update("DELETE FROM resource_overrides WHERE id = ?", (override_id,))
        return True

    def get_selection(self, kind: str, resource_key: str, owner: str) -> Optional[str]:
        row = self.db.execute_query(
            "SELECT override_id FROM resource_selection WHERE owner = ? AND kind = ? AND resource_key = ?",
            (owner, kind, resource_key),
            fetch_one=True,
        )
        return row["override_id"] if row else None

    def set_selection(self, kind: str, resource_key: str, owner: str, override_id: Optional[str]) -> None:
        """Select `override_id` for this resource, or clear the selection (back to "original") if None."""
        if override_id is None:
            self.db.execute_update(
                "DELETE FROM resource_selection WHERE owner = ? AND kind = ? AND resource_key = ?",
                (owner, kind, resource_key),
            )
            return
        self.db.execute_update(
            """
            INSERT INTO resource_selection (owner, kind, resource_key, override_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(owner, kind, resource_key) DO UPDATE SET override_id = excluded.override_id
            """,
            (owner, kind, resource_key, override_id),
        )

    def reset_selection(self, owner: str, resources: list[tuple[str, str]]) -> None:
        """Clear the selection for each (kind, resource_key) pair, keeping all overrides."""
        for kind, resource_key in resources:
            self.set_selection(kind, resource_key, owner, None)

    def get_selected_override_text(self, kind: str, resource_key: str, owner: str) -> Optional[str]:
        """The selected override's text, or None if this resource currently uses the original."""
        override_id = self.get_selection(kind, resource_key, owner)
        if override_id is None:
            return None
        override = self.get_override(override_id)
        return override["text"] if override else None
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_storage.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/storage.py tests/unit/fastapi/test_doc_rules_storage.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): DocumentRulesStore repository

CRUD for resource_overrides and selection resolution over
resource_selection. Deletion-clears-selection relies on the migration's
ON DELETE CASCADE foreign key (enabled by DatabaseManager's
PRAGMA foreign_keys = ON), verified here at the repository level too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Package exports and Pydantic models

**Files:**
- Modify: `fastapi_app/lib/doc_rules/__init__.py`
- Create: `fastapi_app/lib/models/models_document_rules.py`

- [ ] **Step 1: Populate the package `__init__.py`**

Replace the (empty) contents of `fastapi_app/lib/doc_rules/__init__.py`:

```python
"""
Document rules registry: a pluggable resource-kind registry plus generic
override/selection storage for the resources a TEI document references
(interpretation-ref prompt/rule fragments and its schema). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md.
"""

from fastapi_app.lib.doc_rules.kinds import (
    ResourceDescriptor,
    ResourceKind,
    get_resource_kind,
    list_resources,
    register_resource_kind,
)
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

__all__ = [
    "ResourceDescriptor",
    "ResourceKind",
    "register_resource_kind",
    "get_resource_kind",
    "list_resources",
    "normalize_resource_key",
    "infer_format",
    "DocumentRulesStore",
]
```

- [ ] **Step 2: Create the Pydantic models**

Create `fastapi_app/lib/models/models_document_rules.py`:

```python
"""
Pydantic models for the document rules registry REST API. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("REST API").
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field

ResourceFormat = Literal["markdown", "text", "xml"]


class ResourceDescriptorModel(BaseModel):
    """One resource a document references, as returned by /list."""
    kind: str
    url: str
    key: str
    label: str
    format: ResourceFormat


class ListResourcesRequest(BaseModel):
    """Request to discover the resources a (possibly unsaved) document references."""
    xml_string: str = Field(..., min_length=1)


class ListResourcesResponse(BaseModel):
    resources: list[ResourceDescriptorModel]


class QueryResourceRequest(BaseModel):
    """Request for one resource's original text, overrides, and selection."""
    kind: str
    url: str


class OverrideModel(BaseModel):
    """One user-owned editable copy of a resource."""
    id: str
    note: str
    text: str
    format: ResourceFormat
    created_at: str
    updated_at: str


class QueryResourceResponse(BaseModel):
    original_text: str
    overrides: list[OverrideModel]
    selected_override_id: Optional[str] = Field(
        None, description="The caller's selected override id, or null if this resource currently uses the original."
    )


class CreateOverrideRequest(BaseModel):
    """Request to create a new override. `text` defaults to the resource's original text when omitted."""
    kind: str
    fragment_url: str
    note: str = ""
    text: Optional[str] = None


class UpdateOverrideRequest(BaseModel):
    """Request to update an override's note and/or text. Omitted fields are left unchanged."""
    note: Optional[str] = None
    text: Optional[str] = None


class SetSelectionRequest(BaseModel):
    """Request to select an override for one resource, or `null` to select the original."""
    kind: str
    fragment_url: str
    override_id: Optional[str] = None


class ResourceRef(BaseModel):
    kind: str
    url: str


class ResetSelectionRequest(BaseModel):
    """Request to clear the caller's selection for each listed resource. Overrides are kept."""
    resources: list[ResourceRef]


class OkResponse(BaseModel):
    result: str = "ok"
```

- [ ] **Step 3: Verify the modules import cleanly**

Run: `uv run python -c "import fastapi_app.lib.doc_rules; import fastapi_app.lib.models.models_document_rules; print('ok')"`
Expected: prints `ok` with no errors

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/lib/doc_rules/__init__.py fastapi_app/lib/models/models_document_rules.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): public package exports and REST Pydantic models

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: REST router

**Files:**
- Create: `fastapi_app/routers/document_rules.py`
- Modify: `fastapi_app/main.py`
- Modify: `app/src/modules/api-client-v1.js` (regenerated, not hand-edited)

- [ ] **Step 1: Implement the router**

Create `fastapi_app/routers/document_rules.py`:

```python
"""
REST API for the document rules registry: discovering, querying, and
overriding the resources a TEI document references (interpretation-ref
prompt/rule fragments and its schema). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("REST API"). Write endpoints only ever touch the caller's own rows.
"""

import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException

from ..lib.core.database import DatabaseManager
from ..lib.core.dependencies import get_db, require_authenticated_user
from ..lib.doc_rules.kinds import get_resource_kind, list_resources
from ..lib.doc_rules.resource_key import infer_format, normalize_resource_key
from ..lib.doc_rules.storage import DocumentRulesStore
from ..lib.models.models_document_rules import (
    CreateOverrideRequest,
    ListResourcesRequest,
    ListResourcesResponse,
    OkResponse,
    OverrideModel,
    QueryResourceRequest,
    QueryResourceResponse,
    ResetSelectionRequest,
    ResourceDescriptorModel,
    SetSelectionRequest,
    UpdateOverrideRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/document-rules", tags=["document-rules"])


def get_document_rules_store(db: DatabaseManager = Depends(get_db)) -> DocumentRulesStore:
    return DocumentRulesStore(db)


def _override_to_model(override: dict) -> OverrideModel:
    return OverrideModel(
        id=override["id"],
        note=override["note"],
        text=override["text"],
        format=override["format"],
        created_at=override["created_at"],
        updated_at=override["updated_at"],
    )


@router.post("/list", response_model=ListResourcesResponse)
async def list_document_resources(
    request: ListResourcesRequest,
    user: dict = Depends(require_authenticated_user),
) -> ListResourcesResponse:
    """List every resource the posted document content references. Used to build the "Edit prompts/schemas" submenu."""
    resources = list_resources(request.xml_string)
    return ListResourcesResponse(
        resources=[
            ResourceDescriptorModel(kind=r.kind, url=r.url, key=r.key, label=r.label, format=r.format)
            for r in resources
        ]
    )


@router.post("/query", response_model=QueryResourceResponse)
async def query_resource(
    request: QueryResourceRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> QueryResourceResponse:
    """Original text, the caller's overrides, and the caller's current selection for one resource."""
    kind = get_resource_kind(request.kind)
    if kind is None:
        raise HTTPException(status_code=400, detail=f"Unknown resource kind: {request.kind}")

    try:
        original_text = kind.resolve_original(request.url)
    except Exception as e:
        logger.error(f"Failed to resolve original text for {request.kind} {request.url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")

    resource_key = normalize_resource_key(request.url)
    owner = user["username"]
    overrides = store.list_overrides(request.kind, resource_key, owner)
    selected_override_id = store.get_selection(request.kind, resource_key, owner)

    return QueryResourceResponse(
        original_text=original_text,
        overrides=[_override_to_model(o) for o in overrides],
        selected_override_id=selected_override_id,
    )


@router.post("/overrides", response_model=OverrideModel)
async def create_override(
    request: CreateOverrideRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OverrideModel:
    """Create a new override, copying the resource's original text unless `text` is given."""
    kind = get_resource_kind(request.kind)
    if kind is None:
        raise HTTPException(status_code=400, detail=f"Unknown resource kind: {request.kind}")

    try:
        original_text = kind.resolve_original(request.fragment_url)
    except Exception as e:
        logger.error(f"Failed to resolve original text for {request.kind} {request.fragment_url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")

    base_hash = hashlib.sha256(original_text.encode("utf-8")).hexdigest()
    override = store.create_override(
        kind=request.kind,
        resource_key=normalize_resource_key(request.fragment_url),
        owner=user["username"],
        note=request.note,
        text=request.text if request.text is not None else original_text,
        format=infer_format(request.fragment_url),
        base_url=request.fragment_url,
        base_hash=base_hash,
    )
    return _override_to_model(override)


@router.put("/overrides/{override_id}", response_model=OverrideModel)
async def update_override(
    override_id: str,
    request: UpdateOverrideRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OverrideModel:
    """Update an override's note and/or text. Owner only."""
    updated = store.update_override(override_id, user["username"], request.note, request.text)
    if updated is None:
        raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    return _override_to_model(updated)


@router.delete("/overrides/{override_id}", response_model=OkResponse)
async def delete_override(
    override_id: str,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Delete an override. Owner only; also clears any selection pointing at it."""
    deleted = store.delete_override(override_id, user["username"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    return OkResponse()


@router.put("/selection", response_model=OkResponse)
async def set_selection(
    request: SetSelectionRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Select an override (or `null` for the original) for one resource."""
    if request.override_id is not None:
        override = store.get_override(request.override_id)
        if override is None or override["owner"] != user["username"]:
            raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    resource_key = normalize_resource_key(request.fragment_url)
    store.set_selection(request.kind, resource_key, user["username"], request.override_id)
    return OkResponse()


@router.post("/selection/reset", response_model=OkResponse)
async def reset_selection(
    request: ResetSelectionRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Clear the caller's selection for each listed resource, keeping all overrides."""
    resources = [(r.kind, normalize_resource_key(r.url)) for r in request.resources]
    store.reset_selection(user["username"], resources)
    return OkResponse()
```

- [ ] **Step 2: Mount the router**

In `fastapi_app/main.py`, add `document_rules` to the `from .routers import (...)` block (alphabetically near `collections`/`extraction` is fine — exact position doesn't matter, FastAPI routing isn't order-sensitive here since the new prefix `/document-rules` doesn't collide with any existing route):

```python
from .routers import (
    plugins,
    plugins_admin,
    files_list,
    files_serve,
    files_upload,
    files_save,
    files_delete,
    files_gc,
    files_repopulate,
    files_move,
    files_copy,
    files_locks,
    files_heartbeat,
    files_export,
    files_import,
    files_metadata,
    files_permissions,
    validation,
    extraction,
    document_rules,
    llm,
    sse,
    maintenance,
    collections,
    users,
    groups,
    roles,
    projects
)
```

And add it to the `api_v1` router (near `validation`/`extraction`):

```python
api_v1.include_router(validation.router)
api_v1.include_router(extraction.router)
api_v1.include_router(document_rules.router)
```

- [ ] **Step 3: Regenerate the API client**

Run: `npm run generate-client`
Expected: `app/src/modules/api-client-v1.js` is regenerated with new methods for the `/api/v1/document-rules/*` endpoints; check `git diff --stat app/src/modules/api-client-v1.js` shows only additive changes.

- [ ] **Step 4: Manual smoke test**

Since the app auto-reloads (per project convention, never restart it yourself — ask the user to start it if it isn't running), verify the new router is mounted:

Run: `node scripts/dev/debug-api.js POST /api/v1/document-rules/list '{"xml_string": "<TEI xmlns=\"http://www.tei-c.org/ns/1.0\"/>"}'`
Expected: `{"resources": []}` (a bare `TEI` root has no interpretation/schema references)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/routers/document_rules.py fastapi_app/main.py app/src/modules/api-client-v1.js
git commit -m "$(cat <<'EOF'
feat(doc-rules): mount the /api/v1/document-rules REST router

/list, /query, /overrides (create/update/delete), /selection,
/selection/reset. Regenerates the typed API client. The "Refresh
document rules" endpoints and the frontend that consumes this router
are separate follow-up plans.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Router integration tests

**Files:**
- Create: `tests/unit/fastapi/test_document_rules_router.py`

- [ ] **Step 1: Write the tests**

Create `tests/unit/fastapi/test_document_rules_router.py`, modeled on `tests/unit/fastapi/test_validation_router.py`'s dependency-override pattern:

```python
"""
Integration tests for the document rules REST router.

@testCovers fastapi_app/routers/document_rules.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.routers.document_rules import get_db, router

XML_WITH_INTERPRETATION = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary" n="Primary rules">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md" subtype="human" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""


class DocumentRulesRouterTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")

        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice"}
        self.client = TestClient(self.app)

        self.fetch_patcher = patch(
            "fastapi_app.routers.document_rules.get_resource_kind"
        )
        self._real_get_resource_kind = None  # set per test if needed

    def tearDown(self):
        self.temp_dir.cleanup()


class TestListEndpoint(DocumentRulesRouterTestCase):
    def test_list_finds_interpretation_ref_resource(self):
        response = self.client.post("/document-rules/list", json={"xml_string": XML_WITH_INTERPRETATION})
        self.assertEqual(response.status_code, 200)
        resources = response.json()["resources"]
        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]["kind"], "interpretation-ref")
        self.assertEqual(resources[0]["label"], "Primary rules")

    def test_list_empty_document_returns_no_resources(self):
        response = self.client.post(
            "/document-rules/list",
            json={"xml_string": "<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["resources"], [])


class TestQueryAndOverrideLifecycle(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.resolve_patcher = patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original",
            return_value="original text",
        )
        self.resolve_patcher.start()
        self.addCleanup(self.resolve_patcher.stop)
        self.url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"

    def test_query_with_no_overrides(self):
        response = self.client.post(
            "/document-rules/query", json={"kind": "interpretation-ref", "url": self.url}
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["original_text"], "original text")
        self.assertEqual(body["overrides"], [])
        self.assertIsNone(body["selected_override_id"])

    def test_create_update_select_and_delete_override(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": "first note"},
        )
        self.assertEqual(create_response.status_code, 200)
        override = create_response.json()
        self.assertEqual(override["text"], "original text")  # defaulted
        self.assertEqual(override["note"], "first note")
        self.assertEqual(override["format"], "markdown")

        update_response = self.client.put(
            f"/document-rules/overrides/{override['id']}",
            json={"note": "updated note", "text": "edited text"},
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()["text"], "edited text")

        select_response = self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "override_id": override["id"]},
        )
        self.assertEqual(select_response.status_code, 200)

        query_response = self.client.post(
            "/document-rules/query", json={"kind": "interpretation-ref", "url": self.url}
        )
        self.assertEqual(query_response.json()["selected_override_id"], override["id"])

        reset_response = self.client.post(
            "/document-rules/selection/reset",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        self.assertEqual(reset_response.status_code, 200)
        query_after_reset = self.client.post(
            "/document-rules/query", json={"kind": "interpretation-ref", "url": self.url}
        )
        self.assertIsNone(query_after_reset.json()["selected_override_id"])
        # The override itself must survive a reset.
        self.assertEqual(len(query_after_reset.json()["overrides"]), 1)

        delete_response = self.client.delete(f"/document-rules/overrides/{override['id']}")
        self.assertEqual(delete_response.status_code, 200)

    def test_cannot_update_or_delete_someone_elses_override(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": "alice's"},
        )
        override_id = create_response.json()["id"]

        # Switch the authenticated user for this one request.
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob"}

        update_response = self.client.put(
            f"/document-rules/overrides/{override_id}", json={"note": "hijacked"}
        )
        self.assertEqual(update_response.status_code, 404)

        delete_response = self.client.delete(f"/document-rules/overrides/{override_id}")
        self.assertEqual(delete_response.status_code, 404)

    def test_unknown_resource_kind_returns_400(self):
        response = self.client.post(
            "/document-rules/query", json={"kind": "no-such-kind", "url": self.url}
        )
        self.assertEqual(response.status_code, 400)
```

Note: this test module does not use `Depends(get_document_rules_store)` overrides directly — `get_document_rules_store` itself depends on `get_db`, which is overridden, so the real `DocumentRulesStore` is constructed against the temp SQLite database created in `setUp()`. Remove the unused `get_document_rules_store` import if your editor flags it (it was listed for clarity but isn't referenced directly).

- [ ] **Step 2: Run the tests**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_document_rules_router.py -v`
Expected: PASS. If `test_list_finds_interpretation_ref_resource` fails because `normalize_resource_key`/`infer_format` produce something unexpected, print the actual `resources[0]` dict and adjust the assertion to match — don't change the implementation to fit a wrong expectation.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/fastapi/test_document_rules_router.py
git commit -m "$(cat <<'EOF'
test(doc-rules): integration tests for the document-rules router

Covers list/query/override CRUD/selection/reset, ownership enforcement,
and the unknown-kind error path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Full suite and final review

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, no regressions in existing suites (in particular `fastapi_app/plugins/grobid/tests/test_annotation_rules*.py`, `tests/unit/fastapi/test_annotation_rules_utils.py`, `tests/unit/fastapi/test_git_forge_adapters.py`, `tests/unit/fastapi/test_validation_router.py`).

- [ ] **Step 2: Run the API test suite**

Run: `npm run test:api`
Expected: PASS — this plan adds no `tests/api/v1/*.test.js` file (the router is covered by the Python integration tests in Task 11), so this just confirms nothing else broke.

- [ ] **Step 3: Run the full E2E suite**

Run: `npm run test:e2e`
Expected: PASS. This plan adds no user-visible feature yet (no frontend consumes the new router), so this is purely a regression check.

- [ ] **Step 4: Check the API client is committed and current**

Run: `npm run generate-client:check`
Expected: reports the client is up to date (it was regenerated in Task 10).

- [ ] **Step 5: Report completion**

No further commit needed if all prior tasks were committed individually. Summarize for the user: the resource-kind registry, storage, and REST API for `/api/v1/document-rules` are implemented and tested; the schema-validator seam, extraction-time contribution, "Refresh document rules", and the frontend are separate follow-up plans against this same worktree/branch.
