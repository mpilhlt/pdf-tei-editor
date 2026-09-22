# editorialDecl Annotation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give TEI documents a machine-readable, document-embedded `editorialDecl` pointing at the annotation rules that governed them, addressable down to a line range for LLM excerpt-fetching, plus a `schemaRef` fallback for schema validation and a reviewer action to re-pin the rules reference to the current guidelines commit.

**Architecture:** A pluggable git-forge adapter registry (GitHub/GitLab, extensible) resolves branch-relative guideline URLs to commit-SHA permalinks and raw-fetchable URLs; a generic URL cache (extracted from the existing schema cache) backs both that and a new rules-excerpt fetch/slice utility. The grobid plugin's existing per-variant guide config gains a `category` field and is embedded into `editorialDecl` at extraction time and on demand via a new reviewer-only "Refresh Annotation Rules" action. The frontend's existing Annotation Guide drawer reads the document's own `editorialDecl` first, falling back to today's runtime config lookup for older documents.

**Tech Stack:** Python (FastAPI backend, lxml, requests), JavaScript (frontend plugins, CodeMirror/XPath), `unittest` (Python tests), Node's built-in `node:test` (JS tests).

**Spec:** `docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md`

---

## Part C — `schemaRef` fallback for schema validation

### Task 1: `extract_schema_locations()` also checks `schemaRef`

**Files:**
- Modify: `fastapi_app/lib/core/schema_validator.py:244-288`
- Test: `tests/unit/fastapi/test_schema_validator.py`

- [ ] **Step 1: Write the failing tests**

Add this test class to the end of `tests/unit/fastapi/test_schema_validator.py` (it already imports `unittest`, `Path`, etc. at the top — this class only needs `extract_schema_locations` added to the existing import block at the top of the file):

Change the import block at the top of the file from:

```python
from fastapi_app.lib.core.schema_validator import (
    SCHEMA_CACHE_TTL_SECONDS,
    is_schema_cache_stale,
    register_schema_redirect,
    resolve_schema_location,
    unregister_schema_redirect,
    validate,
)
```

to:

```python
from fastapi_app.lib.core.schema_validator import (
    SCHEMA_CACHE_TTL_SECONDS,
    extract_schema_locations,
    is_schema_cache_stale,
    register_schema_redirect,
    resolve_schema_location,
    unregister_schema_redirect,
    validate,
)
```

Then append this class at the end of the file:

```python
class TestExtractSchemaLocationsSchemaRef(unittest.TestCase):
    """Test extract_schema_locations() falling back to encodingDesc/schemaRef."""

    def test_schema_ref_only(self):
        xml = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <schemaRef target="https://example.com/schema/tei.rng" type="RELAXNG"/>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        results = extract_schema_locations(xml)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["schemaLocation"], "https://example.com/schema/tei.rng")
        self.assertEqual(results[0]["type"], "relaxng")
        self.assertEqual(results[0]["namespace"], "http://www.tei-c.org/ns/1.0")

    def test_xml_model_pi_takes_precedence_over_schema_ref(self):
        xml = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema/pi.rng" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <schemaRef target="https://example.com/schema/ref.rng" type="RELAXNG"/>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        results = extract_schema_locations(xml)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["schemaLocation"], "https://example.com/schema/pi.rng")

    def test_no_schema_declaration_at_all(self):
        xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        self.assertEqual(extract_schema_locations(xml), [])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_schema_validator.py -v`
Expected: `test_schema_ref_only` FAILs (returns `[]` instead of one result); the other two tests pass already (no behavior change needed for them).

- [ ] **Step 3: Implement the fallback**

In `fastapi_app/lib/core/schema_validator.py`, replace the `extract_schema_locations` function body's RelaxNG section:

```python
    # Then try RelaxNG-style xml-model processing instruction
    xml_model_match = re.search(
        r'<\?xml-model\s+href="([^"]+)"[^>]*schematypens="http://relaxng\.org/ns/structure/1\.0"[^>]*\?>',
        xml_string
    )
    if xml_model_match:
        schema_location = xml_model_match.group(1)
        # Extract namespace from root element (assuming TEI)
        namespace_match = re.search(r'<\w+[^>]*xmlns="([^"]+)"', xml_string)
        namespace = namespace_match.group(1) if namespace_match else "http://www.tei-c.org/ns/1.0"
        results.append({
            "namespace": namespace,
            "schemaLocation": schema_location,
            "type": "relaxng"
        })

    return results
```

with:

```python
    # Then try RelaxNG-style xml-model processing instruction; fall back to
    # the standard TEI schemaRef element only if no PI is present, so an
    # existing PI stays authoritative when both are declared.
    xml_model_match = re.search(
        r'<\?xml-model\s+href="([^"]+)"[^>]*schematypens="http://relaxng\.org/ns/structure/1\.0"[^>]*\?>',
        xml_string
    )
    schema_location = xml_model_match.group(1) if xml_model_match else None
    if schema_location is None:
        schema_ref_match = re.search(r'<schemaRef\s+[^>]*target="([^"]+)"', xml_string)
        schema_location = schema_ref_match.group(1) if schema_ref_match else None

    if schema_location:
        # Extract namespace from root element (assuming TEI)
        namespace_match = re.search(r'<\w+[^>]*xmlns="([^"]+)"', xml_string)
        namespace = namespace_match.group(1) if namespace_match else "http://www.tei-c.org/ns/1.0"
        results.append({
            "namespace": namespace,
            "schemaLocation": schema_location,
            "type": "relaxng"
        })

    return results
```

Also update the function's docstring "Supports both XSD and RelaxNG approaches" bullet to mention the fallback:

```python
    """
    Extract schema locations from XML document.

    Supports both XSD and RelaxNG approaches:
    - XSD: uses xsi:schemaLocation attribute
    - RelaxNG: uses the xml-model processing instruction, falling back to
      encodingDesc/schemaRef if no PI is present

    Args:
        xml_string: XML document as string

    Returns:
        List of dicts with keys: namespace, schemaLocation, type
    """
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_schema_validator.py -v`
Expected: PASS (all tests, including the three new ones and all pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/core/schema_validator.py tests/unit/fastapi/test_schema_validator.py
git commit -m "feat: fall back to schemaRef for schema location when no xml-model PI is present

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Part E1 — shared URL cache

### Task 2: Extract `url_cache.py`

**Files:**
- Create: `fastapi_app/lib/core/url_cache.py`
- Test: `tests/unit/fastapi/test_url_cache.py`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_url_cache.py`:

```python
"""
Unit tests for the generic URL content cache.

@testCovers fastapi_app/lib/core/url_cache.py
"""

import tempfile
import time
import unittest
from pathlib import Path

from fastapi_app.lib.core.url_cache import UrlCache, get_cache_info, is_cache_stale


class TestGetCacheInfo(unittest.TestCase):
    def test_derives_dir_and_file_from_url_path(self):
        cache_root = Path("/cache")
        cache_dir, cache_file, file_name = get_cache_info(
            "https://example.com/a/b/schema.rng", cache_root
        )
        self.assertEqual(cache_dir, cache_root / "a" / "b")
        self.assertEqual(file_name, "schema.rng")
        self.assertEqual(cache_file, cache_dir / "schema.rng")

    def test_sanitizes_unsafe_characters(self):
        cache_root = Path("/cache")
        _, cache_file, _ = get_cache_info("https://localhost:8000/a/file?.rng", cache_root)
        self.assertNotIn(":", str(cache_file.relative_to(cache_root)))
        self.assertNotIn("?", str(cache_file.relative_to(cache_root)))


class TestIsCacheStale(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_file = Path(self.temp_dir.name) / "f.txt"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_missing_file_is_stale(self):
        self.assertTrue(is_cache_stale(self.cache_file))

    def test_freshly_written_file_is_not_stale(self):
        self.cache_file.write_text("x")
        self.assertFalse(is_cache_stale(self.cache_file, ttl_seconds=3600))

    def test_file_older_than_ttl_is_stale(self):
        self.cache_file.write_text("x")
        old_time = time.time() - 7200
        import os
        os.utime(self.cache_file, (old_time, old_time))
        self.assertTrue(is_cache_stale(self.cache_file, ttl_seconds=3600))


class TestUrlCache(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache = UrlCache(Path(self.temp_dir.name), ttl_seconds=3600)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_get_text_returns_none_when_not_cached(self):
        self.assertIsNone(self.cache.get_text("https://example.com/a/b/c.md"))

    def test_set_then_get_text_round_trips(self):
        self.cache.set_text("https://example.com/a/b/c.md", "hello world")
        self.assertEqual(self.cache.get_text("https://example.com/a/b/c.md"), "hello world")

    def test_get_text_returns_none_when_stale(self):
        stale_cache = UrlCache(Path(self.temp_dir.name), ttl_seconds=0)
        stale_cache.set_text("https://example.com/a/b/c.md", "hello world")
        time.sleep(0.01)
        self.assertIsNone(stale_cache.get_text("https://example.com/a/b/c.md"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_url_cache.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.core.url_cache'`

- [ ] **Step 3: Implement `url_cache.py`**

Create `fastapi_app/lib/core/url_cache.py`:

```python
"""
Generic, directory-backed, TTL-based cache for content fetched from a URL.

Extracted from schema_validator.py so the same caching behavior can be
reused by the git-forge adapters (git_forge_adapters.py) and the
annotation-rules fetcher (annotation_rules_utils.py). See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part E) for the rationale.
"""

import os
import re
import time
from pathlib import Path
from typing import Optional, Tuple

DEFAULT_CACHE_TTL_SECONDS = 3600


def get_cache_info(url: str, cache_root: Path) -> Tuple[Path, Path, str]:
    """
    Derive the cache directory, cache file path, and file name for a URL.

    Mirrors a URL's path structure under cache_root so different URLs never
    collide, with filesystem-unsafe characters replaced.

    Args:
        url: The URL whose fetched content will be cached
        cache_root: Root directory for this cache

    Returns:
        Tuple of (cache_dir, cache_file, file_name)
    """
    url_parts = url.split("/")[2:-1]
    url_parts = [re.sub(r'[<>:"|?*]', '_', part) for part in url_parts]
    cache_dir = cache_root / Path(*url_parts)
    file_name = re.sub(r'[<>:"|?*]', '_', os.path.basename(url))
    cache_file = cache_dir / file_name
    return cache_dir, cache_file, file_name


def is_cache_stale(cache_file: Path, ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS) -> bool:
    """
    Check whether a cached file needs to be re-fetched.

    A cache entry is stale if it doesn't exist yet, or if it was last
    written longer than ttl_seconds ago.

    Args:
        cache_file: Path to the cached file
        ttl_seconds: Maximum age in seconds before the cache is considered stale

    Returns:
        True if the file is missing or older than the TTL
    """
    if not cache_file.is_file():
        return True
    age_seconds = time.time() - cache_file.stat().st_mtime
    return age_seconds > ttl_seconds


class UrlCache:
    """A directory-backed, TTL-based text cache for fetched URL content."""

    def __init__(self, cache_root: Path, ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS):
        self.cache_root = cache_root
        self.ttl_seconds = ttl_seconds

    def get_text(self, url: str) -> Optional[str]:
        """Return cached text for `url` if a fresh cache entry exists, else None."""
        _, cache_file, _ = get_cache_info(url, self.cache_root)
        if is_cache_stale(cache_file, self.ttl_seconds):
            return None
        return cache_file.read_text(encoding="utf-8")

    def set_text(self, url: str, content: str) -> None:
        """Write `content` to the cache entry for `url`, creating directories as needed."""
        cache_dir, cache_file, _ = get_cache_info(url, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(content, encoding="utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_url_cache.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/core/url_cache.py tests/unit/fastapi/test_url_cache.py
git commit -m "feat: add generic UrlCache, extracted from schema cache logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Make `schema_validator.py`'s cache functions thin wrappers

**Files:**
- Modify: `fastapi_app/lib/core/schema_validator.py:291-328`
- Test: `tests/unit/fastapi/test_schema_validator.py` (existing tests must still pass, unmodified)

- [ ] **Step 1: Run the existing tests to confirm current behavior (baseline)**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_schema_validator.py -v`
Expected: PASS (this is the regression baseline before refactoring — no test changes in this task)

- [ ] **Step 2: Replace the two functions with delegating wrappers**

In `fastapi_app/lib/core/schema_validator.py`, add this import near the top (after the existing `import requests` line):

```python
from fastapi_app.lib.core.url_cache import get_cache_info, is_cache_stale
```

Then replace:

```python
def get_schema_cache_info(schema_location: str, cache_root: Path) -> Tuple[Path, Path, str]:
    """
    Extract cache directory and file information for a schema location.

    Args:
        schema_location: URL of the schema
        cache_root: Root directory for schema cache

    Returns:
        Tuple of (cache_dir, cache_file, filename)
    """
    schema_location_parts = schema_location.split("/")[2:-1]
    # Replace filesystem-incompatible characters (e.g. colon in "localhost:8000")
    schema_location_parts = [re.sub(r'[<>:"|?*]', '_', part) for part in schema_location_parts]
    schema_cache_dir = cache_root / Path(*schema_location_parts)
    schema_file_name = re.sub(r'[<>:"|?*]', '_', os.path.basename(schema_location))
    schema_cache_file = schema_cache_dir / schema_file_name
    return schema_cache_dir, schema_cache_file, schema_file_name


def is_schema_cache_stale(schema_cache_file: Path, ttl_seconds: int = SCHEMA_CACHE_TTL_SECONDS) -> bool:
    """
    Check whether a cached schema file needs to be re-fetched.

    A cache entry is stale if it doesn't exist yet, or if it was last written
    longer than `ttl_seconds` ago.

    Args:
        schema_cache_file: Path to the cached schema file
        ttl_seconds: Maximum age in seconds before the cache is considered stale

    Returns:
        True if the file is missing or older than the TTL
    """
    if not schema_cache_file.is_file():
        return True
    age_seconds = time.time() - schema_cache_file.stat().st_mtime
    return age_seconds > ttl_seconds
```

with:

```python
def get_schema_cache_info(schema_location: str, cache_root: Path) -> Tuple[Path, Path, str]:
    """
    Extract cache directory and file information for a schema location.

    Thin wrapper around the generic url_cache.get_cache_info(), kept under
    its original name because other modules (e.g. the grobid plugin's
    annotation-tags generator) import it directly by this name.

    Args:
        schema_location: URL of the schema
        cache_root: Root directory for schema cache

    Returns:
        Tuple of (cache_dir, cache_file, filename)
    """
    return get_cache_info(schema_location, cache_root)


def is_schema_cache_stale(schema_cache_file: Path, ttl_seconds: int = SCHEMA_CACHE_TTL_SECONDS) -> bool:
    """
    Check whether a cached schema file needs to be re-fetched.

    Thin wrapper around the generic url_cache.is_cache_stale().

    Args:
        schema_cache_file: Path to the cached schema file
        ttl_seconds: Maximum age in seconds before the cache is considered stale

    Returns:
        True if the file is missing or older than the TTL
    """
    return is_cache_stale(schema_cache_file, ttl_seconds)
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_schema_validator.py -v`
Expected: PASS (identical results to the Step 1 baseline)

Also run the grobid-plugin tests that exercise `get_schema_cache_info` indirectly via `annotation_tags_generator`:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_tags_generator.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/lib/core/schema_validator.py
git commit -m "refactor: delegate schema cache functions to generic UrlCache primitives

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Part D — pluggable git-forge adapter registry

### Task 4: `GitForgeAdapterRegistry`

**Files:**
- Create: `fastapi_app/lib/core/git_forge_adapters.py`
- Test: `tests/unit/fastapi/test_git_forge_adapters.py`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_git_forge_adapters.py`:

```python
"""
Unit tests for the pluggable git-forge adapter registry.

@testCovers fastapi_app/lib/core/git_forge_adapters.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.core.git_forge_adapters import (
    BaseGitForgeAdapter,
    GitForgeAdapterRegistry,
    GitHubAdapter,
    GitLabAdapter,
)


class _AlwaysMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return True

    def to_raw_url(self, url: str) -> str:
        return "raw:" + url

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        return "sha:" + url


class _NeverMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return False

    def to_raw_url(self, url: str) -> str:
        raise AssertionError("should not be called")

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        raise AssertionError("should not be called")


class TestGitForgeAdapterRegistry(unittest.TestCase):
    def test_returns_none_when_no_adapter_registered(self):
        registry = GitForgeAdapterRegistry()
        self.assertIsNone(registry.get_adapter_for("https://example.com/x"))

    def test_returns_first_matching_adapter(self):
        registry = GitForgeAdapterRegistry()
        never = _NeverMatchesAdapter()
        always = _AlwaysMatchesAdapter()
        registry.register(never)
        registry.register(always)
        self.assertIs(registry.get_adapter_for("https://example.com/x"), always)

    def test_returns_none_when_nothing_matches(self):
        registry = GitForgeAdapterRegistry()
        registry.register(_NeverMatchesAdapter())
        self.assertIsNone(registry.get_adapter_for("https://example.com/x"))

    def test_get_instance_is_a_singleton(self):
        self.assertIs(GitForgeAdapterRegistry.get_instance(), GitForgeAdapterRegistry.get_instance())

    def test_get_instance_has_builtin_github_and_gitlab_adapters(self):
        adapter_types = [type(a) for a in GitForgeAdapterRegistry.get_instance()._adapters]
        self.assertIn(GitHubAdapter, adapter_types)
        self.assertIn(GitLabAdapter, adapter_types)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.core.git_forge_adapters'`

- [ ] **Step 3: Implement the base class and registry (adapters as stubs for now)**

Create `fastapi_app/lib/core/git_forge_adapters.py`:

```python
"""
Pluggable registry of git-forge URL adapters (GitHub, GitLab, ...).

Each adapter recognizes one forge's blob-URL shape and knows how to turn it
into a raw-fetchable URL and how to resolve a branch/tag ref to the current
commit SHA, so annotation-rules links (see annotation_rules_utils.py) can be
permalink-pinned and fetched as raw text regardless of which forge hosts
them. See docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part D) for the rationale. Modeled on the existing ExtractorRegistry pattern
(fastapi_app/lib/extraction/registry.py).

Adding a new forge: implement BaseGitForgeAdapter and register an instance
in _register_builtin_adapters() below (or, for an institution-specific host,
call GitForgeAdapterRegistry.get_instance().register(...) from anywhere,
e.g. a plugin's initialize()).
"""

import logging
import re
from abc import ABC, abstractmethod
from urllib.parse import quote, urlsplit

import requests

from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

_SHA_RE = re.compile(r'^[0-9a-f]{40}$')


class BaseGitForgeAdapter(ABC):
    """One recognized git-forge URL shape (GitHub, GitLab, ...)."""

    @abstractmethod
    def matches(self, url: str) -> bool:
        """True if this adapter recognizes the URL's host/path shape."""

    @abstractmethod
    def to_raw_url(self, url: str) -> str:
        """Transform a blob/view URL (fragment already stripped) into a directly-fetchable raw-text URL."""

    @abstractmethod
    def resolve_ref_to_sha(self, url: str, cache: UrlCache) -> str:
        """Return `url` with its branch/tag ref replaced by the current commit SHA, fragment preserved."""


class GitForgeAdapterRegistry:
    """Registry of adapters, checked in registration order."""

    _instance: "GitForgeAdapterRegistry | None" = None

    def __init__(self):
        self._adapters: list[BaseGitForgeAdapter] = []

    @classmethod
    def get_instance(cls) -> "GitForgeAdapterRegistry":
        """Get the singleton registry instance, pre-populated with the built-in adapters."""
        if cls._instance is None:
            cls._instance = cls()
            _register_builtin_adapters(cls._instance)
        return cls._instance

    def register(self, adapter: BaseGitForgeAdapter) -> None:
        """Register an adapter. Called at module import for built-ins, or by a plugin for a custom one."""
        self._adapters.append(adapter)

    def get_adapter_for(self, url: str) -> "BaseGitForgeAdapter | None":
        """First registered adapter whose matches() returns True for `url`, else None."""
        for adapter in self._adapters:
            if adapter.matches(url):
                return adapter
        return None


def _register_builtin_adapters(registry: GitForgeAdapterRegistry) -> None:
    registry.register(GitHubAdapter())
    registry.register(GitLabAdapter())
```

This references `GitHubAdapter`/`GitLabAdapter` which don't exist yet — that's intentional; Tasks 5 and 6 add them to this same file, right below the registry code (the test in Step 1 already expects both to exist and be importable, so this step alone still leaves the module broken — that's fine, Steps in Tasks 5/6 complete it before the next commit boundary).

- [ ] **Step 4: Commit is deferred to the end of Task 6**

Do not run tests or commit yet — `GitHubAdapter`/`GitLabAdapter` are referenced but not yet defined. Proceed directly to Task 5.

### Task 5: `GitHubAdapter`

**Files:**
- Modify: `fastapi_app/lib/core/git_forge_adapters.py` (append below `_register_builtin_adapters`)
- Test: `tests/unit/fastapi/test_git_forge_adapters.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fastapi/test_git_forge_adapters.py`:

```python
class TestGitHubAdapter(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()

    def test_matches_github_blob_url(self):
        self.assertTrue(self.adapter.matches("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"))

    def test_does_not_match_non_github_url(self):
        self.assertFalse(self.adapter.matches("https://gitlab.com/mpilhlt/fossil/-/blob/main/docs/guidelines.md"))

    def test_does_not_match_github_non_blob_url(self):
        self.assertFalse(self.adapter.matches("https://github.com/mpilhlt/fossil"))

    def test_to_raw_url(self):
        raw = self.adapter.to_raw_url("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md")
        self.assertEqual(raw, "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md")

    def test_resolve_ref_to_sha_returns_unchanged_when_already_a_sha(self):
        cache = MagicMock()
        sha = "a" * 40
        url = f"https://github.com/mpilhlt/fossil/blob/{sha}/docs/guidelines.md#L1-L5"
        self.assertEqual(self.adapter.resolve_ref_to_sha(url, cache), url)
        cache.get_text.assert_not_called()

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolve_ref_to_sha_resolves_branch_via_api(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"sha": "b" * 40}
        mock_get.return_value = mock_response

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#L1-L5"
        resolved = self.adapter.resolve_ref_to_sha(url, cache)

        mock_get.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil/commits/main",
            timeout=10,
            headers={"Accept": "application/vnd.github+json"},
        )
        self.assertEqual(resolved, f"https://github.com/mpilhlt/fossil/blob/{'b' * 40}/docs/guidelines.md#L1-L5")
        cache.set_text.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil/commits/main", "b" * 40
        )

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolve_ref_to_sha_uses_cache_when_available(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "c" * 40

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        resolved = self.adapter.resolve_ref_to_sha(url, cache)

        mock_get.assert_not_called()
        self.assertEqual(resolved, f"https://github.com/mpilhlt/fossil/blob/{'c' * 40}/docs/guidelines.md")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: FAIL — `NameError: name 'GitHubAdapter' is not defined` (or similar) for the whole module, since `git_forge_adapters.py` still references `GitHubAdapter`/`GitLabAdapter` without defining them.

- [ ] **Step 3: Implement `GitHubAdapter`**

In `fastapi_app/lib/core/git_forge_adapters.py`, insert this class between `BaseGitForgeAdapter` and `GitForgeAdapterRegistry`:

```python
class GitHubAdapter(BaseGitForgeAdapter):
    """Adapter for github.com blob URLs."""

    _BLOB_RE = re.compile(r'^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/blob/(?P<ref>[^/]+)/(?P<path>.+)$')

    def matches(self, url: str) -> bool:
        parts = urlsplit(url)
        return parts.hostname == "github.com" and "/blob/" in parts.path

    def _parse(self, base_url: str) -> "re.Match[str]":
        parts = urlsplit(base_url)
        match = self._BLOB_RE.match(parts.path)
        if not match:
            raise ValueError(f"Not a recognized GitHub blob URL: {base_url}")
        return match

    def to_raw_url(self, url: str) -> str:
        m = self._parse(url)
        return (
            f"https://raw.githubusercontent.com/{m['owner']}/{m['repo']}/"
            f"{m['ref']}/{m['path']}"
        )

    def resolve_ref_to_sha(self, url: str, cache: UrlCache) -> str:
        base_url, _, fragment = url.partition("#")
        m = self._parse(base_url)
        ref = m['ref']
        if _SHA_RE.match(ref):
            return url
        api_url = f"https://api.github.com/repos/{m['owner']}/{m['repo']}/commits/{ref}"
        sha = cache.get_text(api_url)
        if sha is None:
            response = requests.get(
                api_url, timeout=10, headers={"Accept": "application/vnd.github+json"}
            )
            response.raise_for_status()
            sha = response.json()["sha"]
            cache.set_text(api_url, sha)
        resolved = f"https://github.com/{m['owner']}/{m['repo']}/blob/{sha}/{m['path']}"
        return f"{resolved}#{fragment}" if fragment else resolved
```

Also update `_register_builtin_adapters` — it already calls `registry.register(GitHubAdapter())`, so no change needed there.

- [ ] **Step 4: Run tests**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: All `TestGitHubAdapter` tests PASS. `TestGitForgeAdapterRegistry.test_get_instance_has_builtin_github_and_gitlab_adapters` still FAILs (GitLab not implemented yet — expected, continue to Task 6 before committing).

- [ ] **Step 5: Commit is deferred to the end of Task 6**

### Task 6: `GitLabAdapter`

**Files:**
- Modify: `fastapi_app/lib/core/git_forge_adapters.py` (append below `GitHubAdapter`)
- Test: `tests/unit/fastapi/test_git_forge_adapters.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fastapi/test_git_forge_adapters.py`:

```python
class TestGitLabAdapter(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()

    def test_matches_gitlab_com_blob_url(self):
        self.assertTrue(self.adapter.matches("https://gitlab.com/group/project/-/blob/main/docs/guide.md"))

    def test_matches_self_hosted_gitlab_blob_url(self):
        self.assertTrue(self.adapter.matches("https://gitlab.example.org/group/sub/project/-/blob/main/docs/guide.md"))

    def test_does_not_match_github_url(self):
        self.assertFalse(self.adapter.matches("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"))

    def test_to_raw_url(self):
        raw = self.adapter.to_raw_url("https://gitlab.com/group/project/-/blob/main/docs/guide.md")
        self.assertEqual(raw, "https://gitlab.com/group/project/-/raw/main/docs/guide.md")

    def test_to_raw_url_preserves_nested_group_path(self):
        raw = self.adapter.to_raw_url("https://gitlab.com/group/subgroup/project/-/blob/main/docs/guide.md")
        self.assertEqual(raw, "https://gitlab.com/group/subgroup/project/-/raw/main/docs/guide.md")

    def test_resolve_ref_to_sha_returns_unchanged_when_already_a_sha(self):
        cache = MagicMock()
        sha = "a" * 40
        url = f"https://gitlab.com/group/project/-/blob/{sha}/docs/guide.md#L1-5"
        self.assertEqual(self.adapter.resolve_ref_to_sha(url, cache), url)
        cache.get_text.assert_not_called()

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolve_ref_to_sha_resolves_branch_via_api(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"id": "b" * 40}
        mock_get.return_value = mock_response

        url = "https://gitlab.com/group/project/-/blob/main/docs/guide.md#L1-5"
        resolved = self.adapter.resolve_ref_to_sha(url, cache)

        mock_get.assert_called_once_with(
            "https://gitlab.com/api/v4/projects/group%2Fproject/repository/commits/main",
            timeout=10,
        )
        self.assertEqual(resolved, f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guide.md#L1-5")
        cache.set_text.assert_called_once_with(
            "https://gitlab.com/api/v4/projects/group%2Fproject/repository/commits/main", "b" * 40
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: FAIL — `NameError: name 'GitLabAdapter' is not defined`

- [ ] **Step 3: Implement `GitLabAdapter`**

In `fastapi_app/lib/core/git_forge_adapters.py`, insert this class between `GitHubAdapter` and `GitForgeAdapterRegistry`:

```python
class GitLabAdapter(BaseGitForgeAdapter):
    """Adapter for GitLab blob URLs (gitlab.com and self-hosted instances)."""

    _MARKER = "/-/blob/"

    def matches(self, url: str) -> bool:
        return self._MARKER in urlsplit(url).path

    def _split(self, base_url: str) -> "tuple[str, str, str, str]":
        """Returns (origin, project_path, ref, file_path)."""
        parts = urlsplit(base_url)
        project_path, _, rest = parts.path.partition(self._MARKER)
        ref, _, file_path = rest.partition("/")
        origin = f"{parts.scheme}://{parts.netloc}"
        return origin, project_path.strip("/"), ref, file_path

    def to_raw_url(self, url: str) -> str:
        origin, project_path, ref, file_path = self._split(url)
        return f"{origin}/{project_path}/-/raw/{ref}/{file_path}"

    def resolve_ref_to_sha(self, url: str, cache: UrlCache) -> str:
        base_url, _, fragment = url.partition("#")
        origin, project_path, ref, file_path = self._split(base_url)
        if _SHA_RE.match(ref):
            return url
        encoded_project = quote(project_path, safe="")
        api_url = f"{origin}/api/v4/projects/{encoded_project}/repository/commits/{ref}"
        sha = cache.get_text(api_url)
        if sha is None:
            response = requests.get(api_url, timeout=10)
            response.raise_for_status()
            sha = response.json()["id"]
            cache.set_text(api_url, sha)
        resolved = f"{origin}/{project_path}/-/blob/{sha}/{file_path}"
        return f"{resolved}#{fragment}" if fragment else resolved
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_git_forge_adapters.py -v`
Expected: PASS (all tests from Tasks 4, 5, and 6)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/core/git_forge_adapters.py tests/unit/fastapi/test_git_forge_adapters.py
git commit -m "feat: add pluggable git-forge adapter registry with GitHub and GitLab adapters

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Part E2 — rules-excerpt fetch/slice utility

### Task 7: Add `annotation_rules_cache_dir` setting

**Files:**
- Modify: `fastapi_app/config.py:136-139`
- Test: `tests/unit/fastapi/test_config_utils.py` (existing file — add one test)

- [ ] **Step 1: Write the failing test**

Add this test to `tests/unit/fastapi/test_config_utils.py`. First read the file to find an existing `TestCase` testing a similar directory property (e.g. `schema_cache_dir`) and add a sibling test right after it, following the same pattern (construct `Settings`, assert the derived path). If no such precedent exists in this file, add a new class at the end:

```python
class TestAnnotationRulesCacheDir(unittest.TestCase):
    """Test Settings.annotation_rules_cache_dir."""

    def test_derived_from_data_root(self):
        from fastapi_app.config import Settings
        settings = Settings(DATA_ROOT="/tmp/test-data-root")
        self.assertEqual(
            str(settings.annotation_rules_cache_dir),
            "/tmp/test-data-root/annotation-rules/cache",
        )
```

(Adjust the `Settings(...)` construction call to match whatever pattern the existing tests in this file already use to instantiate `Settings` with a custom `DATA_ROOT` — read the file first and mirror it exactly; the field name and constructor signature must match what's already there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_config_utils.py -v`
Expected: FAIL with `AttributeError: 'Settings' object has no attribute 'annotation_rules_cache_dir'`

- [ ] **Step 3: Add the property**

In `fastapi_app/config.py`, add this property immediately after `schema_cache_dir` (around line 139):

```python
    @property
    def annotation_rules_cache_dir(self) -> Path:
        """Annotation-rules fetch cache directory - always data_root/annotation-rules/cache"""
        return self.data_root / "annotation-rules" / "cache"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_config_utils.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/config.py tests/unit/fastapi/test_config_utils.py
git commit -m "feat: add annotation_rules_cache_dir setting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 8: `resolve_forge_permalink` and `fetch_rule_excerpt`

**Files:**
- Create: `fastapi_app/lib/utils/annotation_rules_utils.py`
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fastapi/test_annotation_rules_utils.py`:

```python
"""
Unit tests for annotation-rules fetching and slicing.

@testCovers fastapi_app/lib/utils/annotation_rules_utils.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    fetch_rule_excerpt,
    resolve_forge_permalink,
)

SAMPLE_TEXT = "\n".join(f"line {i}" for i in range(1, 21))  # "line 1" .. "line 20"


class TestResolveForgePermalink(unittest.TestCase):
    def test_returns_url_unchanged_for_unrecognized_host(self):
        cache = MagicMock()
        url = "https://pad.gwdg.de/s/abc123/download"
        self.assertEqual(resolve_forge_permalink(url, cache), url)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolves_github_url(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"sha": "c" * 40}
        mock_get.return_value = mock_response

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#segmentation"
        resolved = resolve_forge_permalink(url, cache)
        self.assertEqual(
            resolved,
            f"https://github.com/mpilhlt/fossil/blob/{'c' * 40}/docs/guidelines.md#segmentation",
        )

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_falls_back_to_original_url_when_api_call_fails(self, mock_get):
        """
        A forge API failure (network error, rate limit, etc.) must never
        propagate out of resolve_forge_permalink - callers (extraction, the
        "Refresh Annotation Rules" action) must never fail because of it.
        """
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.side_effect = ConnectionError("boom")

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#segmentation"
        with self.assertLogs("fastapi_app.lib.utils.annotation_rules_utils", level="WARNING"):
            resolved = resolve_forge_permalink(url, cache)
        self.assertEqual(resolved, url)


class TestFetchRuleExcerpt(unittest.TestCase):
    def _mock_response(self, text, content_type="text/plain; charset=utf-8"):
        response = MagicMock()
        response.text = text
        response.headers = {"Content-Type": content_type}
        response.raise_for_status = MagicMock()
        return response

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_returns_whole_text_when_no_fragment(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download", cache)
        self.assertEqual(result, SAMPLE_TEXT)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_slices_github_style_line_range(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L3-L5", cache)
        self.assertEqual(result, "line 3\nline 4\nline 5")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_slices_gitlab_style_line_range(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L3-5", cache)
        self.assertEqual(result, "line 3\nline 4\nline 5")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_slices_single_line(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L7", cache)
        self.assertEqual(result, "line 7")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_clamps_out_of_range_end(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L18-L500", cache)
        self.assertEqual(result, "line 18\nline 19\nline 20")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_unrecognized_fragment_returns_whole_text(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#segmentation", cache)
        self.assertEqual(result, SAMPLE_TEXT)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_raises_on_html_content_type(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response("<html>not raw text</html>", content_type="text/html")

        with self.assertRaises(RuleFetchError):
            fetch_rule_excerpt("https://example.com/some/page", cache)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_uses_cache_when_available(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = SAMPLE_TEXT

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L1-L2", cache)

        mock_get.assert_not_called()
        self.assertEqual(result, "line 1\nline 2")

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_converts_github_blob_url_to_raw_before_fetching(self, mock_fetch_get, mock_adapter_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_fetch_get.return_value = self._mock_response(SAMPLE_TEXT)

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#L1-L2"
        result = fetch_rule_excerpt(url, cache)

        mock_fetch_get.assert_called_once_with(
            "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md",
            timeout=30,
        )
        self.assertEqual(result, "line 1\nline 2")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.utils.annotation_rules_utils'`

- [ ] **Step 3: Implement**

Create `fastapi_app/lib/utils/annotation_rules_utils.py`:

```python
"""
Fetches and slices annotation-rules text referenced from a TEI document's
editorialDecl, and resolves such references to forge permalinks.

See docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part E) for the rationale.
"""

import logging
import re

import requests

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry
from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

# Matches GitHub's #L10-L50 and GitLab's #L10-50 (no second "L")
_LINE_RANGE_RE = re.compile(r'^L(\d+)(?:-L?(\d+))?$')


class RuleFetchError(Exception):
    """Raised when fetched content is not usable as raw rule text (e.g. an HTML blob page)."""


def resolve_forge_permalink(url: str, cache: UrlCache) -> str:
    """
    Resolve a branch-relative git-forge URL to a commit-SHA-pinned permalink.

    Returns `url` unchanged if no registered adapter recognizes it (e.g. a
    HedgeDoc pad URL) - such URLs are assumed already stable - or if
    resolution fails for any reason (forge API unreachable, rate limited,
    unexpected response shape, etc.). A failure is logged but never raised,
    so callers (extraction, the "Refresh Annotation Rules" action) are never
    blocked by it - see the Error Handling section of
    docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md.
    """
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(url)
    if adapter is None:
        return url
    try:
        return adapter.resolve_ref_to_sha(url, cache)
    except Exception as e:
        logger.warning(f"Could not resolve permalink for {url}, using it as given: {e}")
        return url


def fetch_rule_excerpt(url: str, cache: UrlCache) -> str:
    """
    Fetch the raw text a rules-document URL points to, sliced to its
    line-range fragment if one is present (e.g. "#L10-L40" or GitLab's
    "#L10-40").

    Returns the whole fetched text if there is no fragment, or if the
    fragment doesn't parse as a recognized line-range. Line numbers are
    1-based and inclusive; out-of-range values are clamped to the available
    lines.

    Raises:
        RuleFetchError: if the fetched content's Content-Type is text/html,
            which indicates a rendered page was fetched instead of raw text
            (e.g. an unrecognized forge's blob view).
    """
    base_url, _, fragment = url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    fetch_url = adapter.to_raw_url(base_url) if adapter else base_url

    text = cache.get_text(fetch_url)
    if text is None:
        response = requests.get(fetch_url, timeout=30)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "")
        if "text/html" in content_type:
            raise RuleFetchError(
                f"Expected raw text but got '{content_type}' from {fetch_url}"
            )
        text = response.text
        cache.set_text(fetch_url, text)

    match = _LINE_RANGE_RE.match(fragment) if fragment else None
    if not match:
        return text

    lines = text.splitlines()
    start = max(1, int(match.group(1)))
    end = int(match.group(2)) if match.group(2) else start
    end = max(start, end)
    start_idx = min(start - 1, len(lines))
    end_idx = min(end, len(lines))
    return "\n".join(lines[start_idx:end_idx])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/annotation_rules_utils.py tests/unit/fastapi/test_annotation_rules_utils.py
git commit -m "feat: add resolve_forge_permalink and fetch_rule_excerpt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 9: `extract_annotation_rule_refs`

**Files:**
- Modify: `fastapi_app/lib/utils/annotation_rules_utils.py` (append)
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fastapi/test_annotation_rules_utils.py`. First add `extract_annotation_rule_refs` to the existing import at the top of the file:

```python
from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
    resolve_forge_permalink,
)
```

Then append:

```python
class TestExtractAnnotationRuleRefs(unittest.TestCase):
    def test_extracts_general_and_category_entries(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="general">
          <p><ref target="https://example.com/guidelines.md#segmentation" type="markdown">Guidelines</ref></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref target="https://example.com/guidelines.md#L120-L180" type="markdown">Footnotes</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0], {
            "category": "general",
            "target": "https://example.com/guidelines.md#segmentation",
            "content_type": "markdown",
        })
        self.assertEqual(refs[1], {
            "category": "footnote-annotation",
            "target": "https://example.com/guidelines.md#L120-L180",
            "content_type": "markdown",
        })

    def test_returns_empty_list_when_no_editorial_decl(self):
        xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_returns_empty_list_for_malformed_xml(self):
        self.assertEqual(extract_annotation_rule_refs("<not><valid"), [])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: FAIL with `ImportError: cannot import name 'extract_annotation_rule_refs'`

- [ ] **Step 3: Implement**

Append to `fastapi_app/lib/utils/annotation_rules_utils.py` (add `from lxml import etree` to the imports at the top of the file):

```python
from lxml import etree
```

(add this import line alongside the existing `import requests` line), then append this function at the end of the file:

```python
TEI_NS = "http://www.tei-c.org/ns/1.0"


def extract_annotation_rule_refs(xml_string: str) -> list[dict]:
    """
    Parse a TEI document's editorialDecl/interpretation entries.

    Returns a list of {"category": str, "target": str, "content_type": str}
    dicts - "category" from interpretation/@type, "content_type" from the
    nested ref/@type (kept as separate keys since the two @type attributes
    mean different things; see Part A of the design doc). Returns an empty
    list if the document has no editorialDecl or is not well-formed XML.
    """
    try:
        root = etree.fromstring(xml_string.encode("utf-8"))
    except etree.XMLSyntaxError:
        return []

    ns = {"tei": TEI_NS}
    results = []
    for interpretation in root.findall(".//tei:editorialDecl/tei:interpretation", ns):
        category = interpretation.get("type")
        ref = interpretation.find(".//tei:ref", ns)
        if category is None or ref is None or ref.get("target") is None:
            continue
        results.append({
            "category": category,
            "target": ref.get("target"),
            "content_type": ref.get("type"),
        })
    return results
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_annotation_rules_utils.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/annotation_rules_utils.py tests/unit/fastapi/test_annotation_rules_utils.py
git commit -m "feat: add extract_annotation_rule_refs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Part B — extraction-time generation

### Task 10: `create_encoding_desc_with_extractor()` gains `editorial_decl_entries`

**Files:**
- Modify: `fastapi_app/lib/utils/tei_utils.py:383-470`
- Test: `tests/unit/fastapi/test_tei_metadata_update.py` (existing file, following its `TestCase` pattern) — actually create a dedicated new test file since this tests a different function

**Files (corrected):**
- Modify: `fastapi_app/lib/utils/tei_utils.py:383-470`
- Test: `tests/unit/fastapi/test_create_encoding_desc_with_extractor.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fastapi/test_create_encoding_desc_with_extractor.py`:

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
            {"category": "general", "target": "https://example.com/g.md#seg", "content_type": "markdown"},
        ])
        encoding_desc = header.find("encodingDesc")
        children = list(encoding_desc)
        self.assertEqual(children[0].tag, "editorialDecl")
        self.assertEqual(children[1].tag, "appInfo")

    def test_one_interpretation_per_entry(self):
        header = self._build(editorial_decl_entries=[
            {"category": "general", "target": "https://example.com/g.md#seg", "content_type": "markdown"},
            {"category": "footnote-annotation", "target": "https://example.com/g.md#L1-L2", "content_type": "markdown"},
        ])
        interpretations = header.findall(".//editorialDecl/interpretation")
        self.assertEqual(len(interpretations), 2)
        self.assertEqual(interpretations[0].get("type"), "general")
        self.assertEqual(interpretations[1].get("type"), "footnote-annotation")

    def test_ref_carries_target_and_content_type(self):
        header = self._build(editorial_decl_entries=[
            {"category": "general", "target": "https://example.com/g.md#seg", "content_type": "markdown"},
        ])
        ref = header.find(".//editorialDecl/interpretation/p/ref")
        self.assertEqual(ref.get("target"), "https://example.com/g.md#seg")
        self.assertEqual(ref.get("type"), "markdown")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py -v`
Expected: FAIL with `TypeError: create_encoding_desc_with_extractor() got an unexpected keyword argument 'editorial_decl_entries'`

- [ ] **Step 3: Implement**

In `fastapi_app/lib/utils/tei_utils.py`, replace the `create_encoding_desc_with_extractor` function (currently lines 383-470) in full:

```python
def create_encoding_desc_with_extractor(
    timestamp: str,
    extractor_name: str,
    extractor_ident: str,
    extractor_version: str = "1.0",
    variant_id: Optional[str] = None,
    additional_labels: Optional[List[Tuple[str, str]]] = None,
    refs: Optional[List[str]] = None,
    editorial_decl_entries: Optional[List[Dict[str, str]]] = None,
) -> etree._Element:  # type: ignore[name-defined]
    """
    Create an encodingDesc element with PDF-TEI-Editor and extractor applications.

    This is a generic version of create_encoding_desc_with_grobid() that can be
    used by any extractor. It always includes the PDF-TEI-Editor application first,
    followed by the extractor-specific application, and - if editorial_decl_entries
    is given - an editorialDecl before both, documenting the annotation rules that
    apply to this document. See docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
    (Part A) for the editorialDecl shape.

    Args:
        timestamp: ISO timestamp string
        extractor_name: Human-readable extractor name (e.g., "GROBID", "LLamore")
        extractor_ident: Machine identifier (e.g., "grobid", "llamore")
        extractor_version: Version string (default: "1.0")
        variant_id: Optional variant identifier
        additional_labels: List of (type, text) tuples for extra labels on extractor app
        refs: List of target URLs for ref elements on extractor app.
        editorial_decl_entries: Optional list of {"category", "target", "content_type"}
            dicts (as returned by annotation_rules_utils.extract_annotation_rule_refs()),
            one per <interpretation> to emit. Omitted or empty: no editorialDecl is added.

    Returns:
        encodingDesc element

    Examples:
        >>> desc = create_encoding_desc_with_extractor(
        ...     timestamp="2024-01-15T10:30:00Z",
        ...     extractor_name="GROBID",
        ...     extractor_ident="grobid",
        ...     extractor_version="0.8.0",
        ...     variant_id="grobid-segmentation",
        ...     additional_labels=[
        ...         ("revision", "abc123"),
        ...         ("flavor", "fossil"),
        ...     ],
        ...     refs=[
        ...         "https://github.com/kermitt2/grobid",
        ...         "https://example.com/schema/grobid-segmentation.rng",
        ...     ],
        ...     editorial_decl_entries=[
        ...         {"category": "general", "target": "https://example.com/guide.md#seg", "content_type": "markdown"},
        ...     ],
        ... )
    """
    encodingDesc = etree.Element("encodingDesc")

    # editorialDecl, if any entries were given, precedes appInfo (TEI content-model
    # convention: editorialDecl, schemaRef, appInfo).
    if editorial_decl_entries:
        editorialDecl = etree.SubElement(encodingDesc, "editorialDecl")
        for entry in editorial_decl_entries:
            interpretation = etree.SubElement(editorialDecl, "interpretation", type=entry["category"])
            p = etree.SubElement(interpretation, "p")
            etree.SubElement(p, "ref", target=entry["target"], type=entry["content_type"])

    appInfo = etree.SubElement(encodingDesc, "appInfo")

    # PDF-TEI-Editor application (always first)
    pdf_tei_app = etree.SubElement(
        appInfo, "application",
        version="1.0",
        ident="pdf-tei-editor",
        type="editor"
    )
    etree.SubElement(pdf_tei_app, "label").text = "PDF-TEI Editor"
    etree.SubElement(
        pdf_tei_app, "ref",
        target="https://github.com/mpilhlt/pdf-tei-editor"
    )

    # Extractor application
    extractor_app = etree.SubElement(
        appInfo, "application",
        version=extractor_version,
        ident=extractor_ident,
        when=timestamp,
        type="extractor"
    )
    etree.SubElement(extractor_app, "label").text = extractor_name

    # Add variant-id label if provided
    if variant_id:
        variant_label = etree.SubElement(extractor_app, "label", type="variant-id")
        variant_label.text = variant_id

    # Add any additional labels
    if additional_labels:
        for label_type, label_text in additional_labels:
            label = etree.SubElement(extractor_app, "label", type=label_type)
            label.text = label_text

    # Add ref elements
    if refs:
        for ref_target in refs:
            etree.SubElement(extractor_app, "ref", target=ref_target)

    return encodingDesc
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py -v`
Expected: PASS

Also run the existing test that already covers this function to check nothing regressed:

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi -v`
Expected: PASS (full fastapi unit suite)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/tei_utils.py tests/unit/fastapi/test_create_encoding_desc_with_extractor.py
git commit -m "feat: create_encoding_desc_with_extractor emits editorialDecl when given entries

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 11: Migrate `annotation_guides.py` config to fossil with `category`

**Files:**
- Modify: `fastapi_app/plugins/grobid/config/annotation_guides.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_config.py` (existing file — read it first to find where `ANNOTATION_GUIDES`/`get_annotation_guides` is already tested, and update assertions there to match the new shape; do not create a new file for this)

- [ ] **Step 1: Read the existing test file and identify what to update**

Run: `grep -n "ANNOTATION_GUIDES\|annotation_guides\|category" fastapi_app/plugins/grobid/tests/test_annotation_config.py`

Read the matched sections. If tests assert on the old `pad.gwdg.de` URLs or the old two-entries-for-segmentation shape, update those assertions to match the new config below. If no existing test covers `ANNOTATION_GUIDES` content directly, add a new test class to that file:

```python
class TestAnnotationGuidesCategory(unittest.TestCase):
    """Test that every configured guide has a category and a fossil-hosted URL."""

    def test_every_entry_has_a_category(self):
        from fastapi_app.plugins.grobid.config.annotation_guides import ANNOTATION_GUIDES
        for guide in ANNOTATION_GUIDES:
            self.assertIn("category", guide)
            self.assertTrue(guide["category"])

    def test_segmentation_guide_points_at_fossil(self):
        from fastapi_app.plugins.grobid.config.annotation_guides import ANNOTATION_GUIDES
        segmentation = [g for g in ANNOTATION_GUIDES if g["variant_id"] == "grobid.training.segmentation"]
        self.assertEqual(len(segmentation), 1)
        self.assertEqual(segmentation[0]["category"], "general")
        self.assertIn("github.com/mpilhlt/fossil", segmentation[0]["url"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: FAIL (either `KeyError: 'category'`, or an assertion mismatch against the old pad.gwdg.de URL/duplicate-entry shape)

- [ ] **Step 3: Rewrite the config**

Replace the entire contents of `fastapi_app/plugins/grobid/config/annotation_guides.py`:

```python
"""Annotation guide URLs for each GROBID variant.

Each entry names the rule category it belongs to ("general" is the
per-variant primary section a human annotator should read; other categories
are optional, machine-only excerpts for LLM validation - see Part A of
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md).
URLs are branch-relative GitHub blob links; they get permalink-pinned to a
commit SHA when embedded into a document's editorialDecl - see
fastapi_app/plugins/grobid/annotation_rules.py.
"""

from typing import Literal, TypedDict


class AnnotationGuide(TypedDict):
    """A link to an annotation guide for a specific variant and rule category."""

    variant_id: str
    category: str
    type: Literal["markdown", "html"]
    url: str


ANNOTATION_GUIDES: list[AnnotationGuide] = [
    {
        "variant_id": "grobid.training.segmentation",
        "category": "general",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#segmentation",
    },
    {
        "variant_id": "grobid.training.references.referenceSegmenter",
        "category": "general",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#reference-segmenter",
    },
    {
        "variant_id": "grobid.training.references",
        "category": "general",
        "type": "html",
        "url": "https://grobid.readthedocs.io/en/latest/training/Bibliographical-references",
    },
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v`
Expected: PASS

Also check the frontend `annotation-guide.js` still works with the new shape (it only reads `variant_id`, `type`, `url` — `category` is a new, additional field it doesn't yet look at, added in Part F):

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests -v`
Expected: PASS (full grobid plugin Python suite)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/config/annotation_guides.py fastapi_app/plugins/grobid/tests/test_annotation_config.py
git commit -m "feat: migrate annotation guides config from pad.gwdg.de to fossil, add category

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 12: `build_editorial_decl_entries()`

**Files:**
- Create: `fastapi_app/plugins/grobid/annotation_rules.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`

- [ ] **Step 1: Write the failing tests**

Create `fastapi_app/plugins/grobid/tests/test_annotation_rules.py`:

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


class TestBuildEditorialDeclEntries(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_resolves_matching_variant_entries(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_id": "grobid.training.segmentation", "category": "general",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md#seg"},
            {"variant_id": "grobid.training.references", "category": "general",
             "type": "html", "url": "https://grobid.readthedocs.io/refs"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha123")

        cache = MagicMock()
        entries = build_editorial_decl_entries("grobid.training.segmentation", cache)

        self.assertEqual(entries, [
            {"category": "general", "target": "https://github.com/x/y/blob/sha123/g.md#seg", "content_type": "markdown"},
        ])
        mock_resolve.assert_called_once_with("https://github.com/x/y/blob/main/g.md#seg", cache)

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_returns_empty_list_for_unconfigured_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_id": "grobid.training.segmentation", "category": "general",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md#seg"},
        ]
        cache = MagicMock()
        entries = build_editorial_decl_entries("grobid.training.header", cache)
        self.assertEqual(entries, [])
        mock_resolve.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.plugins.grobid.annotation_rules'`

- [ ] **Step 3: Implement**

Create `fastapi_app/plugins/grobid/annotation_rules.py`:

```python
"""
Resolves this plugin's annotation-guide config into editorialDecl-ready
entries, shared by extraction-time generation (extractor.py) and the
"Refresh Annotation Rules" reviewer action (annotation_rules_refresh.py) so
both regenerate editorialDecl the same way. See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Parts B and G).
"""

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import resolve_forge_permalink
from fastapi_app.plugins.grobid.config import get_annotation_guides


def build_editorial_decl_entries(variant_id: str, cache: UrlCache) -> list[dict]:
    """
    Resolve this variant's configured annotation guides into editorialDecl entries.

    Each configured AnnotationGuide for `variant_id` has its URL resolved to
    a permalink (a no-op for non-forge URLs) and is returned as a
    {"category", "target", "content_type"} dict, ready for
    tei_utils.create_encoding_desc_with_extractor()'s editorial_decl_entries
    parameter. Returns [] if no guides are configured for this variant.
    """
    entries = []
    for guide in get_annotation_guides():
        if guide["variant_id"] != variant_id:
            continue
        entries.append({
            "category": guide["category"],
            "target": resolve_forge_permalink(guide["url"], cache),
            "content_type": guide["type"],
        })
    return entries
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/annotation_rules.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py
git commit -m "feat: add build_editorial_decl_entries for the grobid plugin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 13: Wire into `grobid/extractor.py`

**Files:**
- Modify: `fastapi_app/plugins/grobid/extractor.py` (imports near top, and the `create_encoding_desc_with_extractor` call site around line 288)
- Test: `fastapi_app/plugins/grobid/tests/` — extend an existing extraction test if one already exercises `create_encoding_desc_with_extractor`'s output; otherwise add the test below

- [ ] **Step 1: Check for an existing extraction test to extend**

Run: `grep -rln "encodingDesc\|create_encoding_desc_with_extractor" fastapi_app/plugins/grobid/tests/*.py`

If a test already builds a full extracted document and inspects `encodingDesc`, add a new test method there asserting `editorialDecl` is present for `grobid.training.segmentation` and mirroring the assertions below. Otherwise, create `fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py`:

```python
"""
Unit tests for editorialDecl generation in the GROBID extractor.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py -v

@testCovers fastapi_app/plugins/grobid/extractor.py
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))


class TestExtractorEditorialDecl(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_build_editorial_decl_entries_called_with_training_variant_id(
        self, mock_get_guides, mock_resolve
    ):
        """
        For GROBID training variants, the extractor's own `variant_id` local
        (e.g. "grobid.training.segmentation") must be used for the guide
        lookup - not the `enc_variant_id` passed to
        create_encoding_desc_with_extractor(), which is None for training
        variants (their variant-id label is emitted via additional_labels
        instead; see the comment at fastapi_app/plugins/grobid/extractor.py
        above the create_encoding_desc_with_extractor call).
        """
        from fastapi_app.plugins.grobid.annotation_rules import build_editorial_decl_entries

        mock_get_guides.return_value = [
            {"variant_id": "grobid.training.segmentation", "category": "general",
             "type": "markdown", "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#seg"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        cache = MagicMock()
        entries = build_editorial_decl_entries("grobid.training.segmentation", cache)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["category"], "general")
```

(This test directly exercises `build_editorial_decl_entries` with the training-variant id to document the exact bug this task must avoid — the actual extractor-level wiring is verified by Step 4's manual XPath check below, since a full `extract()` call requires a live/mocked GROBID server round-trip that's out of scope to stand up here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py -v`
Expected: PASS already (this test only exercises `build_editorial_decl_entries`, already implemented in Task 12) — this step's real purpose is Step 4 below; still run it now to confirm the baseline is green before editing `extractor.py`.

- [ ] **Step 3: Wire `build_editorial_decl_entries` into the extraction call site**

In `fastapi_app/plugins/grobid/extractor.py`, add these imports to the existing `from fastapi_app.lib.utils.tei_utils import (...)` block or as new lines near the other top-level imports (after the existing `from fastapi_app.plugins.grobid.config import (...)` block):

```python
from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.plugins.grobid.annotation_rules import build_editorial_decl_entries
```

Then, in the extraction method, replace:

```python
        # Create encodingDesc with PDF-TEI-Editor and GROBID applications.
        # For training variants, include model/flavor/variant-id labels in the
        # desired order via additional_labels (variant_id param would insert before them).
        schema_url = get_schema_url(variant_id)
        if variant_id.startswith("grobid.training."):
            model_name = get_model_path(variant_id)
            enc_variant_id = None
            enc_labels: list[tuple[str, str]] = [
                ("model", model_name),
                ("flavor", flavor),
                ("variant-id", variant_id),
                ("revision", grobid_revision),
            ]
        else:
            enc_variant_id = variant_id
            enc_labels = [
                ("revision", grobid_revision),
                ("flavor", flavor),
            ]
        encodingDesc = create_encoding_desc_with_extractor(
            timestamp=timestamp,
            extractor_name="GROBID",
            extractor_ident="GROBID",
            extractor_version=grobid_version,
            variant_id=enc_variant_id,
            additional_labels=enc_labels,
            refs=[
                "https://github.com/grobidOrg/grobid",
                schema_url,
            ],
        )
        tei_header.append(encodingDesc)
```

with:

```python
        # Create encodingDesc with PDF-TEI-Editor and GROBID applications.
        # For training variants, include model/flavor/variant-id labels in the
        # desired order via additional_labels (variant_id param would insert before them).
        schema_url = get_schema_url(variant_id)
        if variant_id.startswith("grobid.training."):
            model_name = get_model_path(variant_id)
            enc_variant_id = None
            enc_labels: list[tuple[str, str]] = [
                ("model", model_name),
                ("flavor", flavor),
                ("variant-id", variant_id),
                ("revision", grobid_revision),
            ]
        else:
            enc_variant_id = variant_id
            enc_labels = [
                ("revision", grobid_revision),
                ("flavor", flavor),
            ]

        # Note: `variant_id` (the local var, e.g. "grobid.training.segmentation")
        # is used here for the guide lookup, not `enc_variant_id` above - the
        # latter is None for training variants since their variant-id label
        # is emitted via additional_labels instead.
        rules_cache = UrlCache(get_settings().annotation_rules_cache_dir)
        editorial_decl_entries = build_editorial_decl_entries(variant_id, rules_cache)

        encodingDesc = create_encoding_desc_with_extractor(
            timestamp=timestamp,
            extractor_name="GROBID",
            extractor_ident="GROBID",
            extractor_version=grobid_version,
            variant_id=enc_variant_id,
            additional_labels=enc_labels,
            refs=[
                "https://github.com/grobidOrg/grobid",
                schema_url,
            ],
            editorial_decl_entries=editorial_decl_entries,
        )
        tei_header.append(encodingDesc)
```

- [ ] **Step 4: Run tests to verify nothing broke**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests -v`
Expected: PASS (full grobid plugin Python suite, including any existing extraction tests)

Also run the JS extraction tests for this plugin:

Run: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/extractor.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py
git commit -m "feat: embed editorialDecl into GROBID-extracted documents

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Part F — frontend unification

### Task 14: `getEditorialDeclGuides()` in `tei-utils.js`

**Files:**
- Modify: `app/src/modules/tei-utils.js` (add after `getDocumentMetadata`, which ends at line 706)
- Test: `tests/unit/js/tei-utils.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/unit/js/tei-utils.test.js`, change the import block at the top from:

```js
import {
  addEdition,
  encodeXmlEntities,
  ensureExtractorVariant,
  encodeFileIdForXmlId,
  decodeXmlIdToFileId,
} from '../../../app/src/modules/tei-utils.js';
```

to:

```js
import {
  addEdition,
  encodeXmlEntities,
  ensureExtractorVariant,
  encodeFileIdForXmlId,
  decodeXmlIdToFileId,
  getEditorialDeclGuides,
} from '../../../app/src/modules/tei-utils.js';
```

Then add this `describe` block right after the imports, before the existing `describe('TEI Utils', () => {` block:

```js
describe('getEditorialDeclGuides', () => {
  function parseXml(xmlString) {
    const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
    return dom.window.document;
  }

  it('returns category, target, and contentType for each interpretation', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="general">
          <p><ref target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref target="https://example.com/g.md#L1-L2" type="markdown">Footnotes</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.strictEqual(guides.length, 2);
    assert.deepStrictEqual(guides[0], {
      category: 'general', target: 'https://example.com/g.md#seg', contentType: 'markdown'
    });
    assert.deepStrictEqual(guides[1], {
      category: 'footnote-annotation', target: 'https://example.com/g.md#L1-L2', contentType: 'markdown'
    });
  });

  it('returns an empty array when there is no editorialDecl', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('throws for a non-XML-document argument', () => {
    assert.throws(() => getEditorialDeclGuides(null));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/tei-utils.test.js`
Expected: FAIL — `getEditorialDeclGuides is not a function` (or import error)

- [ ] **Step 3: Implement**

In `app/src/modules/tei-utils.js`, add this function immediately after `getDocumentMetadata` (after its closing `}` on line 706, before `ensureExtractorVariant`):

```js
/**
 * Extracts annotation-rules references from a TEI document's editorialDecl.
 *
 * Reads `editorialDecl/interpretation[@type]/p/ref` entries, where the
 * interpretation's `@type` is the rule category (e.g. "general",
 * "footnote-annotation") and the nested ref's own `@type` is its content
 * type ("markdown" or "html") - two independent attributes, not to be
 * confused with each other. See
 * docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
 * (Part A) for the rationale.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @returns {Array<{category: string, target: string, contentType: string}>}
 */
export function getEditorialDeclGuides(xmlDoc) {
  if (!xmlDoc || !xmlDoc.evaluate) {
    throw new Error('Valid XML Document with XPath support is required');
  }

  /** @param {string} prefix */
  const namespaceResolver = (prefix) => {
    return prefix === 'tei' ? 'http://www.tei-c.org/ns/1.0' : null;
  };

  const result = xmlDoc.evaluate(
    '//tei:editorialDecl/tei:interpretation',
    xmlDoc,
    namespaceResolver,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );

  const guides = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const interpretation = result.snapshotItem(i);
    const category = interpretation.getAttribute('type');
    const refResult = xmlDoc.evaluate(
      './/tei:ref',
      interpretation,
      namespaceResolver,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const ref = refResult.singleNodeValue;
    const target = ref && ref.getAttribute('target');
    if (!category || !target) continue;
    guides.push({
      category,
      target,
      contentType: ref.getAttribute('type')
    });
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
git commit -m "feat: add getEditorialDeclGuides to tei-utils.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 15: `blobUrlToRawUrl()` in new `git-forge-urls.js`

**Files:**
- Create: `app/src/modules/git-forge-urls.js`
- Test: `tests/unit/js/git-forge-urls.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/js/git-forge-urls.test.js`:

```js
/**
 * Unit tests for git-forge URL helpers.
 *
 * @testCovers app/src/modules/git-forge-urls.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { blobUrlToRawUrl } from '../../../app/src/modules/git-forge-urls.js';

describe('blobUrlToRawUrl', () => {
  it('converts a GitHub blob URL to raw.githubusercontent.com', () => {
    const url = 'https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md';
    assert.strictEqual(
      blobUrlToRawUrl(url),
      'https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md'
    );
  });

  it('converts a GitHub blob URL with a commit SHA', () => {
    const sha = 'a'.repeat(40);
    const url = `https://github.com/mpilhlt/fossil/blob/${sha}/docs/guidelines.md`;
    assert.strictEqual(
      blobUrlToRawUrl(url),
      `https://raw.githubusercontent.com/mpilhlt/fossil/${sha}/docs/guidelines.md`
    );
  });

  it('converts a GitLab blob URL to its -/raw/ equivalent', () => {
    const url = 'https://gitlab.com/group/project/-/blob/main/docs/guidelines.md';
    assert.strictEqual(
      blobUrlToRawUrl(url),
      'https://gitlab.com/group/project/-/raw/main/docs/guidelines.md'
    );
  });

  it('converts a self-hosted GitLab blob URL with a nested group path', () => {
    const url = 'https://gitlab.example.org/group/subgroup/project/-/blob/main/docs/guide.md';
    assert.strictEqual(
      blobUrlToRawUrl(url),
      'https://gitlab.example.org/group/subgroup/project/-/raw/main/docs/guide.md'
    );
  });

  it('returns an unrecognized URL unchanged', () => {
    const url = 'https://pad.gwdg.de/s/abc123/download';
    assert.strictEqual(blobUrlToRawUrl(url), url);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/git-forge-urls.test.js`
Expected: FAIL — cannot find module `app/src/modules/git-forge-urls.js`

- [ ] **Step 3: Implement**

Create `app/src/modules/git-forge-urls.js`:

```js
/**
 * Client-side mirror of the GitHub/GitLab blob-to-raw URL transforms in
 * fastapi_app/lib/core/git_forge_adapters.py. Deliberately duplicated
 * (rather than shared) since one runs in Python and one in the browser -
 * see docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
 * (Part F). Only the two built-in forges are mirrored here; a URL from an
 * unrecognized host is returned unchanged.
 */

/**
 * Transforms a git-forge blob/view URL into a directly-fetchable raw-text
 * URL. Returns the URL unchanged if it doesn't match a recognized GitHub or
 * GitLab blob shape.
 *
 * @param {string} url
 * @returns {string}
 */
export function blobUrlToRawUrl(url) {
  const parsed = new URL(url);

  if (parsed.hostname === 'github.com') {
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (match) {
      const [, owner, repo, ref, path] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    }
    return url;
  }

  const gitlabMarker = '/-/blob/';
  const markerIndex = parsed.pathname.indexOf(gitlabMarker);
  if (markerIndex !== -1) {
    const projectPath = parsed.pathname.slice(0, markerIndex);
    const rest = parsed.pathname.slice(markerIndex + gitlabMarker.length);
    return `${parsed.origin}${projectPath}/-/raw/${rest}`;
  }

  return url;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/git-forge-urls.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/git-forge-urls.js tests/unit/js/git-forge-urls.test.js
git commit -m "feat: add blobUrlToRawUrl client-side git-forge URL helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 16: `annotation-guide.js` reads the document first

**Files:**
- Modify: `app/src/plugins/annotation-guide.js` (full rewrite of the class body)

This task changes UI behavior with no automated test harness precedent in this codebase for full Plugin-class/drawer behavior (there is no existing `annotation-guide.test.js`, and `getDocumentMetadata` itself — the closest existing precedent — is also untested end-to-end for the same reason: it's exercised through the pure, already-tested helper functions in Tasks 14/15 instead). This task is verified by code review against the two pure helpers already covered by tests, not by a new behavioral test.

Note: this task also fixes a latent behavior gap - previously, "open in new window" was only ever shown for `type: "html"` guides, never for `type: "markdown"` ones. Since a markdown guide's URL is now potentially a GitHub/GitLab blob link worth opening directly (with native line-range highlighting), "open in new window" is now shown whenever any guide URL is available, regardless of content type.

- [ ] **Step 1: Read the current file**

Read `app/src/plugins/annotation-guide.js` in full (210 lines) to have its exact current content in context before rewriting.

- [ ] **Step 2: Rewrite the file**

Replace the entire contents of `app/src/plugins/annotation-guide.js`:

```js
/**
 * Annotation Guide Plugin
 *
 * Displays variant-specific annotation guidelines in a left-side drawer.
 * Prefers the currently open document's own editorialDecl (Part A/F of
 * docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md);
 * falls back to the runtime, per-variant config for documents extracted
 * before that feature existed.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import MarkdownIt from 'markdown-it'
 * @import { SlDrawer } from '../ui.js'
 * @import { annotationGuideDrawerPart } from '../templates/annotation-guide-drawer.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { getEditorialDeclGuides } from '../modules/tei-utils.js'
import { blobUrlToRawUrl } from '../modules/git-forge-urls.js'
import {
  createMarkdownRenderer,
  fetchMarkdown,
  renderMarkdown
} from '../modules/markdown-utils.js'

/**
 * Annotation guide information from extractor plugins
 * @typedef {object} AnnotationGuideInfo
 * @property {string} variant_id - The variant identifier
 * @property {"html" | "markdown"} type - The content type
 * @property {string} url - The URL to fetch the guide from
 */

// Register template
await registerTemplate('annotation-guide-drawer', 'annotation-guide-drawer.html')

class AnnotationGuidePlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'annotation-guide', deps: ['help', 'extraction', 'dialog', 'logger'] })
  }

  get #extraction() { return this.getDependency('extraction') }
  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {SlDrawer & annotationGuideDrawerPart} */
  #ui = null

  /** @type {MarkdownIt | null} */
  #md = null

  /** @type {AnnotationGuideInfo[]} */
  #annotationGuides = []

  /** @type {string | null} */
  #currentGuideUrl = null

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "annotation-guide"`)

    this.#ui = this.createUi(createSingleFromTemplate('annotation-guide-drawer', document.body))
    this.#ui.closeBtn.addEventListener('click', () => this.#ui.hide())
    this.#ui.openInNewWindowBtn.addEventListener('click', () => this.#openInNewWindow())

    this.getDependency('help').registerTopic(
      'Annotation Guide',
      'file-text',
      () => this.open()
    )

    this.#md = createMarkdownRenderer()

    // @ts-ignore
    window.appAnnotationGuide = this
  }

  /**
   * Opens the annotation guide drawer
   */
  async open() {
    this.#ui.show()

    if (this.#annotationGuides.length === 0) {
      let extractors = this.#extraction.extractorInfo()
      if (!extractors) {
        extractors = await this.#client.getExtractorList()
      }
      if (extractors) {
        this.#annotationGuides = extractors.flatMap(e => e.annotationGuides || [])
      }
    }

    const variant = this.state?.variant
    if (variant) {
      await this.load(variant)
    } else {
      this.#ui.openInNewWindowBtn.hidden = true
      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="info-circle" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p>No document loaded.</p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">
            Load a document to view its annotation guide.
          </p>
        </div>
      `
    }
  }

  /**
   * Loads annotation guide for a specific variant
   * @param {string} variant The variant identifier
   */
  async load(variant) {
    this.#ui.content.innerHTML = ""

    const docGuide = this.#getDocumentGeneralGuide()
    if (docGuide) {
      await this.#renderGuide(docGuide.markdownUrl, docGuide.htmlUrl)
      return
    }

    const variantGuides = this.#annotationGuides.filter(g => g.variant_id === variant)
    const markdownGuide = variantGuides.find(g => g.type === 'markdown')
    const htmlGuide = variantGuides.find(g => g.type === 'html')
    await this.#renderGuide(markdownGuide?.url, htmlGuide?.url, variant)
  }

  /**
   * Closes the annotation guide drawer
   */
  close() {
    this.#ui.hide()
  }

  #openInNewWindow() {
    if (this.#currentGuideUrl) {
      window.open(this.#currentGuideUrl, '_blank')
    }
  }

  /**
   * Reads the open document's editorialDecl `general` guide entry, if present.
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
    return {
      markdownUrl: general.contentType === 'markdown' ? general.target : null,
      htmlUrl: general.contentType === 'html' ? general.target : null
    }
  }

  /**
   * Renders a guide into the drawer: fetches and renders markdownUrl if
   * given, otherwise shows htmlUrl as an external-only link, otherwise
   * shows a "no guide" message. Applies the GitHub/GitLab blob-to-raw
   * transform to markdownUrl before fetching (a no-op for URLs from other
   * hosts, e.g. a HedgeDoc pad's /download URL).
   * @param {string|undefined|null} markdownUrl
   * @param {string|undefined|null} htmlUrl
   * @param {string} [variantForMessage] - Used only in the "no guide" message text
   */
  async #renderGuide(markdownUrl, htmlUrl, variantForMessage) {
    this.#currentGuideUrl = htmlUrl || markdownUrl || null
    this.#ui.openInNewWindowBtn.hidden = !this.#currentGuideUrl

    if (!markdownUrl && !htmlUrl) {
      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="info-circle" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p>No annotation guide is available${variantForMessage ? ` for variant: <strong>${variantForMessage}</strong>` : ''}</p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">
            Check back later or contact your administrator for documentation.
          </p>
        </div>
      `
      return
    }

    if (!markdownUrl && htmlUrl) {
      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="box-arrow-up-right" style="font-size: 2rem; margin-bottom: 1rem;"></sl-icon>
          <p>The annotation guide for this variant is available as an external page.</p>
          <p style="margin-top: 1rem;">
            <a href="${htmlUrl}" target="_blank" rel="noopener">Open Annotation Guide</a>
          </p>
        </div>
      `
      return
    }

    const [baseUrl, anchor] = /** @type {string} */(markdownUrl).split('#')
    const fetchUrl = blobUrlToRawUrl(baseUrl)

    try {
      const logger = this.getDependency('logger')
      logger.debug(`Loading annotation guide from: ${fetchUrl}`)
      const markdown = await fetchMarkdown(fetchUrl, true)

      const html = renderMarkdown(/** @type {MarkdownIt} */(this.#md), markdown, {
        localLinkHandler: 'appAnnotationGuide.load',
        openExternalInNewTab: true
      })

      this.#ui.content.innerHTML = html

      if (anchor) {
        setTimeout(() => {
          const targetElement = this.#ui.content.querySelector(`#${anchor}`)
          if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
          } else {
            logger.warn(`Anchor #${anchor} not found in annotation guide`)
          }
        }, 100)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.getDependency('logger').error(`Failed to load annotation guide: ${errorMessage}`)
      this.getDependency('dialog').error(`Failed to load annotation guide: ${errorMessage}`)

      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-danger-600);">
          <sl-icon name="exclamation-octagon" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p><strong>Error loading annotation guide</strong></p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">${errorMessage}</p>
        </div>
      `
    }
  }
}

export default AnnotationGuidePlugin


export const plugin = AnnotationGuidePlugin
```

- [ ] **Step 3: Verify no other module references the removed private fields**

Run: `grep -rn "AnnotationGuidePlugin\|annotation-guide" app/src --include="*.js" | grep -v "app/src/plugins/annotation-guide.js"`

Confirm none of the matches call methods removed by this rewrite (`#currentGuideUrl`, `#openInNewWindow` are private and were already private before this change, so nothing external could have referenced them).

- [ ] **Step 4: Run the full JS unit suite**

Run: `node tests/unit-test-runner.js`
Expected: PASS (this file has no dedicated unit tests, so this run just confirms the change didn't break any other suite, e.g. via a shared import)

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/annotation-guide.js
git commit -m "feat: annotation guide drawer prefers the document's own editorialDecl

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Part G — "Refresh Annotation Rules" endpoint + `reload_feature_file` rename

### Task 17: `annotation_rules_refresh.py`

**Files:**
- Create: `fastapi_app/plugins/grobid/annotation_rules_refresh.py`
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py`

- [ ] **Step 1: Write the failing tests**

Create `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py`:

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
        <interpretation type="general">
          <p><ref target="https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg" type="markdown">Guide</ref></p>
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
        meta, content = make_tei_file()
        meta_no_variant = meta
        self.file_repo.get_file_by_stable_id.return_value = meta_no_variant
        self.file_storage.read_file.return_value = b'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
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
            {"category": "general", "target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg", "content_type": "markdown"},
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
    async def test_no_write_when_unchanged(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "general", "target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg", "content_type": "markdown"},
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.plugins.grobid.annotation_rules_refresh'`

- [ ] **Step 3: Implement**

Create `fastapi_app/plugins/grobid/annotation_rules_refresh.py`:

```python
"""
Core logic for the GROBID "Refresh Annotation Rules" reviewer action.

Regenerates a document's editorialDecl guideline references from the
current annotation_guides.py config, re-resolving permalinks to whatever
commit is current now. Separated from plugin.py (trigger endpoint) and
routes.py (preview/execute HTTP routes) so both share the same precondition
checks and business logic, mirroring reload_feature_file.py. See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part G).
"""

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from lxml import etree

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.plugins.plugin_tools import escape_html, wrap_html_with_sandbox_client
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.plugins.grobid.annotation_rules import build_editorial_decl_entries
from fastapi_app.plugins.grobid.sync import parse_encoding_labels

TEI_NS = "http://www.tei-c.org/ns/1.0"


class RefreshPreconditionError(Exception):
    """Raised when the target document cannot be resolved for a refresh."""


@dataclass
class RefreshTarget:
    """The document a rules-refresh would act on."""

    file_meta: FileMetadata
    tei_content: str
    variant_id: str


@dataclass
class RefreshResult:
    """Outcome of actually performing the refresh."""

    entry_count: int
    changed: bool

    @property
    def message(self) -> str:
        if not self.changed:
            return "Annotation rules reference is already up to date."
        plural = "y" if self.entry_count == 1 else "ies"
        return f"Annotation rules reference updated ({self.entry_count} entr{plural})."


def resolve_refresh_target(
    file_repo: FileRepository,
    file_storage: FileStorage,
    stable_id: str,
    user: dict | None,
) -> RefreshTarget:
    """
    Resolve and validate the document a rules refresh would target.

    Read-only. Raises RefreshPreconditionError with a user-facing message if
    the document cannot be resolved, including when *user* lacks edit
    access to it.
    """
    file_meta = file_repo.get_file_by_stable_id(stable_id)
    if not file_meta or file_meta.file_type != "tei":
        raise RefreshPreconditionError("No TEI document open.")

    if not check_file_access(file_meta, user, "edit"):
        raise RefreshPreconditionError("You don't have permission to edit this document.")

    content_bytes = file_storage.read_file(file_meta.id, "tei")
    if not content_bytes:
        raise RefreshPreconditionError("File content not found.")
    tei_content = content_bytes.decode("utf-8")

    labels = parse_encoding_labels(tei_content)
    variant_id = labels.get("variant-id")
    if not variant_id:
        raise RefreshPreconditionError("Document has no recognizable extractor variant.")

    return RefreshTarget(file_meta=file_meta, tei_content=tei_content, variant_id=variant_id)


def _replace_editorial_decl(tei_content: str, entries: list[dict]) -> str:
    """
    Replace (or insert) the document's editorialDecl with fresh entries.

    Inserted as the first child of encodingDesc, before appInfo/schemaRef,
    matching the order create_encoding_desc_with_extractor() uses. Returns
    the content unchanged if entries is empty and there was nothing to
    replace either.
    """
    root = etree.fromstring(tei_content.encode("utf-8"))
    ns = {"tei": TEI_NS}

    encoding_desc = root.find(".//tei:encodingDesc", ns)
    if encoding_desc is None:
        return tei_content

    existing = encoding_desc.find("tei:editorialDecl", ns)
    if existing is not None:
        encoding_desc.remove(existing)

    if not entries:
        return etree.tostring(root, encoding="unicode")

    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        etree.SubElement(p, f"{{{TEI_NS}}}ref", target=entry["target"], type=entry["content_type"])
    encoding_desc.insert(0, editorial_decl)

    return etree.tostring(root, encoding="unicode")


def _add_revision_change(tei_content: str, who: str | None) -> str:
    """Append a <change> entry to revisionDesc noting the rules-reference update."""
    root = etree.fromstring(tei_content.encode("utf-8"))
    ns = {"tei": TEI_NS}

    revision_desc = root.find(".//tei:revisionDesc", ns)
    if revision_desc is None:
        tei_header = root.find(".//tei:teiHeader", ns)
        assert tei_header is not None
        revision_desc = etree.SubElement(tei_header, f"{{{TEI_NS}}}revisionDesc")

    change = etree.SubElement(revision_desc, f"{{{TEI_NS}}}change")
    change.set("when", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    if who:
        change.set("who", f"#{who}")
    desc = etree.SubElement(change, f"{{{TEI_NS}}}desc")
    desc.text = "Updated annotation rules reference to latest guidelines"

    return etree.tostring(root, encoding="unicode")


async def perform_refresh(
    target: RefreshTarget,
    file_repo: FileRepository,
    file_storage: FileStorage,
    who: str | None,
) -> RefreshResult:
    """
    Regenerate the document's editorialDecl from the current config and save it.

    Re-resolves permalinks (a fresh commit SHA if the guideline branch has
    moved on); if the resulting content is unchanged (nothing configured,
    or already current), no new version is written.
    """
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    entries = build_editorial_decl_entries(target.variant_id, cache)

    new_content = _replace_editorial_decl(target.tei_content, entries)
    changed = new_content != target.tei_content
    if changed:
        new_content = _add_revision_change(new_content, who)

        new_bytes = new_content.encode("utf-8")
        saved_hash, _ = file_storage.save_file(new_bytes, target.file_meta.file_type, increment_ref=False)
        if saved_hash != target.file_meta.id:
            file_repo.update_file(
                target.file_meta.id,
                FileUpdate(id=saved_hash, file_size=len(new_bytes)),
            )

    return RefreshResult(entry_count=len(entries), changed=changed)


_PAGE_STYLE = """
body { font-family: sans-serif; padding: 20px; max-width: 700px; margin: 0 auto; }
h2 { color: #333; border-bottom: 2px solid #ddd; padding-bottom: 10px; }
.notice { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
.notice strong { color: #856404; }
table { border-collapse: collapse; margin: 15px 0; width: 100%; }
th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid #ddd; }
.error { color: #842029; background: #f8d7da; border: 1px solid #f5c2c7; padding: 12px; border-radius: 4px; }
.success { color: #0f5132; background: #d1e7dd; border: 1px solid #badbcc; padding: 12px; border-radius: 4px; }
"""


def _page(body: str) -> str:
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<title>Refresh Annotation Rules</title>"
        f"<style>{_PAGE_STYLE}</style></head><body>"
        f"<h2>Refresh Annotation Rules</h2>{body}</body></html>"
    )


def render_precondition_error_html(message: str) -> str:
    """Render the preview page shown when the document cannot be resolved."""
    return _page(f"<div class='error'>{escape_html(message)}</div>")


def render_preview_html(target: RefreshTarget) -> str:
    """Render the reviewer confirmation page shown before executing a refresh."""
    body = (
        "<div class='notice'><strong>This re-derives the annotation rules reference</strong> "
        "for this document from the current configuration, re-resolving it to whatever commit "
        "is current now. Nothing else in the document is touched.</div>"
        "<table>"
        f"<tr><th>Document</th><td>{escape_html(target.file_meta.filename or target.file_meta.id)}</td></tr>"
        f"<tr><th>Variant</th><td>{escape_html(target.variant_id)}</td></tr>"
        "</table>"
        "<p>Click <strong>Execute</strong> below to proceed, or close this dialog to cancel.</p>"
    )
    return _page(body)


def render_result_html(result: RefreshResult) -> str:
    """Render the execute-result page: a summary plus a sandbox-driven toast and reload."""
    message = result.message
    body = (
        f"<div class='success'>{escape_html(message)}</div>"
        "<script>"
        f"sandbox.notify({json.dumps(message)}, 'success', 'check-circle');"
        "sandbox.reloadCurrentDocument();"
        "</script>"
    )
    return wrap_html_with_sandbox_client(_page(body))


def render_error_html(message: str) -> str:
    """Render the execute-result page shown when the refresh failed."""
    return _page(f"<div class='error'>{escape_html(message)}</div>")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/annotation_rules_refresh.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py
git commit -m "feat: add annotation-rules refresh core logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 18: Wire `plugin.py` — new endpoint + `reload_feature_file` rename

**Files:**
- Modify: `fastapi_app/plugins/grobid/plugin.py`
- Test: `fastapi_app/plugins/grobid/tests/test_plugin.py` (existing file — read it first to find where `metadata`/`get_endpoints` are already tested, and extend there)

- [ ] **Step 1: Write the failing tests**

Run: `grep -n "def test_\|reload_feature_file\|category.*document" fastapi_app/plugins/grobid/tests/test_plugin.py`

Read the matched sections to see the existing test structure. Add these test methods to the existing metadata-testing `TestCase` class in that file (matching its existing setup/imports):

```python
    def test_reload_feature_file_endpoint_is_grouped_under_grobid_category(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin
        plugin = GrobidPlugin()
        endpoints = {e["name"]: e for e in plugin.metadata["endpoints"]}
        self.assertEqual(endpoints["reload_feature_file"]["category"], "grobid")
        self.assertEqual(endpoints["reload_feature_file"]["label"], "Reload Feature File")

    def test_refresh_annotation_rules_endpoint_is_registered(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin
        plugin = GrobidPlugin()
        endpoints = {e["name"]: e for e in plugin.metadata["endpoints"]}
        self.assertIn("refresh_annotation_rules", endpoints)
        self.assertEqual(endpoints["refresh_annotation_rules"]["category"], "grobid")
        self.assertEqual(endpoints["refresh_annotation_rules"]["state_params"], ["xml"])
        self.assertIn("refresh_annotation_rules", plugin.get_endpoints())
```

(If the existing file has no such `TestCase` class to extend, create `fastapi_app/plugins/grobid/tests/test_plugin_endpoints.py` instead, with a minimal `unittest.TestCase` containing just these two methods plus the `sys.path.insert` boilerplate seen in `test_reload_feature_file.py`'s header.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_plugin.py -v` (or `test_plugin_endpoints.py` if created)
Expected: FAIL — `AssertionError: 'document' != 'grobid'` and `KeyError: 'refresh_annotation_rules'`

- [ ] **Step 3: Implement**

In `fastapi_app/plugins/grobid/plugin.py`, replace the `reload_feature_file` endpoint metadata entry:

```python
                {
                    "name": "reload_feature_file",
                    "label": "Reload GROBID Feature File",
                    "description": (
                        "Re-fetch the raw GROBID training package for the current document "
                        "and refresh the cached feature file used by the sync-check lint, "
                        "without re-extracting (and overwriting) the gold-standard annotation. "
                        "Use this after retraining/swapping a GROBID model."
                    ),
                    "category": "document",
                    "icon": "arrow-repeat",
                    "state_params": ["xml"],
                    "required_roles": ["reviewer"],
                },
```

with:

```python
                {
                    "name": "reload_feature_file",
                    "label": "Reload Feature File",
                    "description": (
                        "Re-fetch the raw GROBID training package for the current document "
                        "and refresh the cached feature file used by the sync-check lint, "
                        "without re-extracting (and overwriting) the gold-standard annotation. "
                        "Use this after retraining/swapping a GROBID model."
                    ),
                    "category": "grobid",
                    "icon": "arrow-repeat",
                    "state_params": ["xml"],
                    "required_roles": ["reviewer"],
                },
                {
                    "name": "refresh_annotation_rules",
                    "label": "Refresh Annotation Rules",
                    "description": (
                        "Re-derive this document's annotation rules reference from the "
                        "current configuration, re-resolving it to the guidelines' latest "
                        "commit. Use this when the guidelines document has been updated "
                        "and you want this document to point at the new version."
                    ),
                    "category": "grobid",
                    "icon": "arrow-repeat",
                    "state_params": ["xml"],
                    "required_roles": ["reviewer"],
                },
```

Then update `get_endpoints()`:

```python
    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "download_training": self.download_training,
            "reload_feature_file": self.reload_feature_file,
        }
```

to:

```python
    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "download_training": self.download_training,
            "reload_feature_file": self.reload_feature_file,
            "refresh_annotation_rules": self.refresh_annotation_rules,
        }
```

Then add this method right after `reload_feature_file` (at the end of the class):

```python
    async def refresh_annotation_rules(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Trigger the reviewer-confirmed "refresh annotation rules" flow.

        Follows the same preview-then-execute pattern as reload_feature_file:
        this only returns URLs for a confirmation page (`outputUrl`) and the
        actual operation (`executeUrl`); nothing happens until the user
        reviews the confirmation and clicks Execute. See
        annotation_rules_refresh.py for the precondition checks and business
        logic, and routes.py for the two HTTP routes.

        Args:
            context: Plugin context (used for the reviewer-role check)
            params: Must include 'xml' (stable_id of the open TEI file)

        Returns:
            Dict with 'outputUrl'/'executeUrl' on success, or 'error'.
        """
        from urllib.parse import quote

        from fastapi_app.lib.permissions.acl_utils import user_has_role

        if not user_has_role(context.user, ["reviewer", "admin"]):
            return {"error": "Reviewer role required."}

        stable_id = params.get("xml")
        if not stable_id:
            return {"error": "No TEI document open."}

        query = f"xml={quote(stable_id)}"
        return {
            "outputUrl": f"/api/plugins/grobid/refresh-annotation-rules/preview?{query}",
            "executeUrl": f"/api/plugins/grobid/refresh-annotation-rules/execute?{query}",
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_plugin.py -v` (or `test_plugin_endpoints.py`)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/plugin.py fastapi_app/plugins/grobid/tests/
git commit -m "feat: add refresh_annotation_rules endpoint, group grobid actions under one menu category

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 19: Wire `routes.py` — preview/execute HTTP routes

**Files:**
- Modify: `fastapi_app/plugins/grobid/routes.py` (append after the existing `reload-feature-file` routes, around line 327)
- Test: `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py`

- [ ] **Step 1: Write the failing tests**

Create `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py`, mirroring `test_reload_feature_file_routes.py`'s structure exactly (same imports, same `make_tei_file`/`make_pdf_file` helpers, same dependency-override pattern — read that file in full first, then adapt):

```python
"""
Unit tests for the refresh-annotation-rules preview/execute HTTP routes.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py -v

@testCovers fastapi_app/plugins/grobid/routes.py
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_auth_manager, get_db, get_file_storage, get_session_manager
from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.plugins.grobid.annotation_rules_refresh import RefreshResult
from fastapi_app.plugins.grobid.routes import router

TEI_TEMPLATE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
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


class BaseRouteTest(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)

        self.session_manager = mock.MagicMock()
        self.session_manager.is_session_valid.return_value = True
        self.auth_manager = mock.MagicMock()
        self.auth_manager.get_user_by_session_id.return_value = {
            "username": "reviewer1", "roles": ["reviewer"]
        }
        self.db = mock.MagicMock()
        self.file_storage = mock.MagicMock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

        self.client = TestClient(self.app)

    def tearDown(self):
        self.app.dependency_overrides.clear()


class TestRefreshAnnotationRulesPreview(BaseRouteTest):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_preview_shows_confirmation_for_valid_document(self, _mock_access):
        from fastapi_app.lib.repository.file_repository import FileRepository
        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta):
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/preview",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("grobid.training.segmentation", response.text)

    def test_preview_shows_error_for_missing_document(self):
        from fastapi_app.lib.repository.file_repository import FileRepository
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=None):
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/preview",
                params={"xml": "missing", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("No TEI document open", response.text)

    def test_preview_requires_authentication(self):
        response = self.client.get(
            "/api/plugins/grobid/refresh-annotation-rules/preview",
            params={"xml": "tei-1"},
        )
        self.assertEqual(response.status_code, 401)


class TestRefreshAnnotationRulesExecute(BaseRouteTest):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.perform_refresh")
    def test_execute_calls_perform_refresh_and_renders_result(self, mock_perform, _mock_access):
        from fastapi_app.lib.repository.file_repository import FileRepository

        async def fake_perform(*args, **kwargs):
            return RefreshResult(entry_count=1, changed=True)
        mock_perform.side_effect = fake_perform

        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta):
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/execute",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("updated", response.text.lower())
        mock_perform.assert_called_once()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py -v`
Expected: FAIL — `404 Not Found` for both routes (they don't exist yet)

- [ ] **Step 3: Implement the routes**

In `fastapi_app/plugins/grobid/routes.py`, add these two routes immediately after the existing `reload_feature_file_execute` function (after its closing, before the `@router.post("/cancel/{progress_id}")` route, i.e. right after line 326's closing of that function):

```python
@router.get("/refresh-annotation-rules/preview", response_class=HTMLResponse)
async def refresh_annotation_rules_preview(
    xml: str = Query(..., description="Stable ID of the open TEI file"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
):
    """
    Render the reviewer confirmation page for refreshing annotation rules.

    Read-only. Loaded in the plugin-result iframe (see the 'outputUrl'
    returned by GrobidPlugin.refresh_annotation_rules).
    """
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.plugins.grobid.annotation_rules_refresh import (
        RefreshPreconditionError,
        render_precondition_error_html,
        render_preview_html,
        resolve_refresh_target,
    )

    user = _authenticate_reviewer(x_session_id or session_id, session_manager, auth_manager)

    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, xml, user)
    except RefreshPreconditionError as e:
        return HTMLResponse(content=render_precondition_error_html(str(e)))

    return HTMLResponse(content=render_preview_html(target))


@router.get("/refresh-annotation-rules/execute", response_class=HTMLResponse)
async def refresh_annotation_rules_execute(
    xml: str = Query(..., description="Stable ID of the open TEI file"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
):
    """
    Perform the annotation-rules refresh and render a result page.

    Called when the reviewer clicks Execute on the confirmation page.
    """
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.plugins.grobid.annotation_rules_refresh import (
        RefreshPreconditionError,
        perform_refresh,
        render_error_html,
        render_precondition_error_html,
        render_result_html,
        resolve_refresh_target,
    )

    user = _authenticate_reviewer(x_session_id or session_id, session_manager, auth_manager)

    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, xml, user)
    except RefreshPreconditionError as e:
        return HTMLResponse(content=render_precondition_error_html(str(e)))

    who = user.get("username") if isinstance(user, dict) else None
    try:
        result = await perform_refresh(target, file_repo, file_storage, who)
    except Exception as e:
        return HTMLResponse(content=render_error_html(str(e)))

    return HTMLResponse(content=render_result_html(result))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py -v`
Expected: PASS

Then run the full grobid plugin suite to confirm nothing else broke:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests -v`
Expected: PASS

Run: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/routes.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py
git commit -m "feat: add refresh-annotation-rules preview/execute HTTP routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final verification

After all 19 tasks are complete:

- [ ] Run the full backend unit suite: `npm run test:unit:fastapi`
- [ ] Run the full frontend unit suite: `npm run test:unit:js`
- [ ] Run the grobid plugin's own JS integration tests: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests`
- [ ] Manually verify in a running dev instance (ask the user to start it if not running, per project convention — never start it yourself): extract a new `grobid.training.segmentation` document, confirm its saved TEI contains `editorialDecl` with a `general` interpretation pointing at a `github.com/mpilhlt/fossil/blob/<40-char-sha>/...` URL; open the Annotation Guide drawer for it and confirm it renders and scrolls to the `#segmentation` section; run "Refresh Annotation Rules" from the Tools menu (now under a "Grobid" heading, alongside the renamed "Reload Feature File") and confirm the preview/execute flow completes and the document's `editorialDecl` SHA and `revisionDesc` change entry update accordingly.
