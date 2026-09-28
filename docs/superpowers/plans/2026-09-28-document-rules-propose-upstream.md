# Document Rules — Propose Upstream Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Propose change upstream" button to the document rules resource editor dialog that opens a GitHub prefilled "new file" tab (or a GitLab edit-page tab plus a clipboard copy) for the currently selected override, per [docs/superpowers/specs/2026-09-28-document-rules-propose-upstream-design.md](../specs/2026-09-28-document-rules-propose-upstream-design.md).

**Architecture:** Two new methods on each of `GitHubAdapter`/`GitLabAdapter` in the existing `fastapi_app/lib/core/git_forge_adapters.py` registry build the target URL from the resource's own URL (blob or raw shape); a new stateless `POST /document-rules/propose-change-url` endpoint calls them; a new dialog button in `app/src/plugins/document-rules.js` calls that endpoint, copies the text to the clipboard, and opens the returned URL in a new tab. No server-side git write, no stored credential.

**Tech Stack:** Python (FastAPI, `requests`, existing `UrlCache`), vanilla JS class-based plugin, Node's built-in `node:test`.

---

## Important context for every task below

- **The feature this extends is already fully shipped**, not hypothetical — `app/src/plugins/document-rules.js`, `fastapi_app/routers/document_rules.py`, `fastapi_app/lib/core/git_forge_adapters.py`, and their test files all exist in the repo today with the exact shapes referenced below (confirmed by reading each file directly, not assumed from an older planning doc).
- **`app/src/modules/api-client-v1.js` is hand-maintained**, not auto-generated (see its own header comment) — Task 4 edits it by hand, mirroring the new router endpoint exactly.
- **`.types.js` files are auto-generated — never hand-write them.** Task 3 ends with `node scripts/build/generate-ui-types.js` (equivalently `npm run build:ui-types`); let the generator produce `document-rules-editor-dialog.types.js`'s new `proposeUpstreamBtn` property.
- **`app/CLAUDE.md` rules that apply**: never use `querySelector`/`querySelectorAll` for UI elements (use `this._editorDialogUi.*`); `notify(message, variant, icon)` from `app/src/modules/sl-utils.js` for toasts (variants: `primary`/`success`/`warning`/`danger`; icons used in this plugin already: `check-circle`, `exclamation-triangle`, `exclamation-octagon`, `info-circle`).
- **Adding a new `@abstractmethod` to `BaseGitForgeAdapter` breaks its two test-double subclasses** in `tests/unit/fastapi/test_git_forge_adapters.py` (`_AlwaysMatchesAdapter`/`_NeverMatchesAdapter` — Python refuses to instantiate an `ABC` subclass missing an abstract method). Task 1 updates both.

---

### Task 1: `git_forge_adapters.py` — `build_propose_change_url()` on both adapters

**Files:**
- Modify: `fastapi_app/lib/core/git_forge_adapters.py`
- Modify: `tests/unit/fastapi/test_git_forge_adapters.py`

- [ ] **Step 1: Update the two test-double adapter classes so they still satisfy the (soon-to-be-extended) ABC**

In `tests/unit/fastapi/test_git_forge_adapters.py`, add `from urllib.parse import urlencode` to the top imports (alongside the existing `unittest`/`unittest.mock` imports), then add a `build_propose_change_url` method to each of the two existing test-double classes:

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

    def build_propose_change_url(self, url: str, text: str, cache):
        return None


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

    def build_propose_change_url(self, url: str, text: str, cache):
        raise AssertionError("should not be called")
```

- [ ] **Step 2: Add the new tests (registry + both adapters)**

Add this test class anywhere after `TestGitForgeAdapterRegistry` (e.g. right after it):

```python
class TestGitForgeAdapterRegistryAllAdapters(unittest.TestCase):
    def test_all_adapters_returns_every_registered_adapter_in_order(self):
        registry = GitForgeAdapterRegistry()
        never = _NeverMatchesAdapter()
        always = _AlwaysMatchesAdapter()
        registry.register(never)
        registry.register(always)
        self.assertEqual(registry.all_adapters(), [never, always])
```

Add this test class at the end of the file (after `TestGitLabAdapterIsShaPinned`):

```python
class TestGitHubAdapterBuildProposeChangeUrl(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()
        self.cache = MagicMock()

    def test_builds_prefilled_url_from_blob_url_with_branch_ref(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        expected_query = urlencode({"filename": "docs/guidelines.md", "value": "new content"})
        self.assertEqual(target.url, f"https://github.com/mpilhlt/fossil/new/main?{expected_query}")
        self.assertTrue(target.content_prefilled)
        self.cache.get_text.assert_not_called()

    def test_builds_prefilled_url_from_raw_url(self):
        url = "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        expected_query = urlencode({"filename": "docs/guidelines.md", "value": "new content"})
        self.assertEqual(target.url, f"https://github.com/mpilhlt/fossil/new/main?{expected_query}")
        self.assertTrue(target.content_prefilled)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolves_sha_pinned_ref_to_default_branch_via_api(self, mock_get):
        self.cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"default_branch": "main"}
        mock_get.return_value = mock_response

        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "text", self.cache)

        mock_get.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil",
            timeout=10,
            headers={"Accept": "application/vnd.github+json"},
        )
        self.assertIn("/new/main?", target.url)
        self.cache.set_text.assert_called_once_with("https://api.github.com/repos/mpilhlt/fossil", "main")

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_uses_cached_default_branch(self, mock_get):
        self.cache.get_text.return_value = "develop"
        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "text", self.cache)
        mock_get.assert_not_called()
        self.assertIn("/new/develop?", target.url)

    def test_falls_back_to_unprefilled_when_url_too_long(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        huge_text = "x" * 8000
        target = self.adapter.build_propose_change_url(url, huge_text, self.cache)
        self.assertFalse(target.content_prefilled)
        self.assertNotIn("value=", target.url)
        self.assertIn("filename=", target.url)

    def test_returns_none_for_unrecognized_host(self):
        target = self.adapter.build_propose_change_url("https://example.com/docs/guidelines.md", "text", self.cache)
        self.assertIsNone(target)


class TestGitLabAdapterBuildProposeChangeUrl(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()
        self.cache = MagicMock()

    def test_builds_edit_url_from_blob_url(self):
        url = "https://gitlab.com/group/project/-/blob/main/docs/guide.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
        self.assertFalse(target.content_prefilled)

    def test_builds_edit_url_from_raw_url(self):
        url = "https://gitlab.com/group/project/-/raw/main/docs/guide.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
        self.assertFalse(target.content_prefilled)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolves_sha_pinned_ref_to_default_branch_via_api(self, mock_get):
        self.cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"default_branch": "main"}
        mock_get.return_value = mock_response

        url = f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guide.md"
        target = self.adapter.build_propose_change_url(url, "text", self.cache)

        mock_get.assert_called_once_with("https://gitlab.com/api/v4/projects/group%2Fproject", timeout=10)
        self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
        self.cache.set_text.assert_called_once_with(
            "https://gitlab.com/api/v4/projects/group%2Fproject", "main"
        )

    def test_returns_none_for_unrecognized_host(self):
        target = self.adapter.build_propose_change_url("https://example.com/docs/guide.md", "text", self.cache)
        self.assertIsNone(target)
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
uv run python -m pytest tests/unit/fastapi/test_git_forge_adapters.py -v
```

Expected: failures — `TypeError: Can't instantiate abstract class ... with abstract method build_propose_change_url` is not yet the error (the method isn't abstract yet either), so instead expect `AttributeError: 'GitHubAdapter' object has no attribute 'build_propose_change_url'` (and similarly for GitLab and the registry's `all_adapters`).

- [ ] **Step 4: Implement — imports, constant, and `ProposeChangeTarget` dataclass**

In `fastapi_app/lib/core/git_forge_adapters.py`, replace the top of the file:

```python
import logging
import re
from abc import ABC, abstractmethod
from urllib.parse import quote, urlsplit

import requests

from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

_SHA_RE = re.compile(r'^[0-9a-f]{40}$')
```

with:

```python
import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from urllib.parse import quote, urlencode, urlsplit

import requests

from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

_SHA_RE = re.compile(r'^[0-9a-f]{40}$')

# Conservative margin under common browser/proxy URL-length limits (~8KB) -
# see BaseGitForgeAdapter.build_propose_change_url()'s docstring.
_MAX_PROPOSE_URL_LENGTH = 7600


@dataclass(frozen=True)
class ProposeChangeTarget:
    """Where build_propose_change_url() sends the visitor, and whether `text` made it into the URL itself."""

    url: str
    content_prefilled: bool
```

- [ ] **Step 5: Implement — new abstract method on `BaseGitForgeAdapter`**

Replace:

```python
    @abstractmethod
    def is_sha_pinned(self, url: str) -> bool:
        """True if `url`'s ref segment is already a 40-character commit SHA (immutable content)."""


class GitHubAdapter(BaseGitForgeAdapter):
```

with:

```python
    @abstractmethod
    def is_sha_pinned(self, url: str) -> bool:
        """True if `url`'s ref segment is already a 40-character commit SHA (immutable content)."""

    @abstractmethod
    def build_propose_change_url(self, url: str, text: str, cache: UrlCache) -> "ProposeChangeTarget | None":
        """
        Build a URL that lets the visitor's own forge session propose `text`
        as the new content of the file `url` points to (blob or raw form,
        any ref - branch, tag, or commit SHA). Returns None if `url`'s
        owner/repo/ref/path can't be parsed. A SHA-pinned ref is resolved to
        the repo's default branch via one `cache`-backed, unauthenticated API
        call, mirroring resolve_ref_to_sha().
        """


class GitHubAdapter(BaseGitForgeAdapter):
```

- [ ] **Step 6: Implement — `GitHubAdapter.build_propose_change_url()`**

Replace the end of `GitHubAdapter` (its `is_sha_pinned` method, immediately followed by `class GitLabAdapter`):

```python
    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        m = self._parse(base_url)
        return bool(_SHA_RE.match(m['ref']))


class GitLabAdapter(BaseGitForgeAdapter):
```

with:

```python
    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        m = self._parse(base_url)
        return bool(_SHA_RE.match(m['ref']))

    _RAW_RE = re.compile(r'^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?P<ref>[^/]+)/(?P<path>.+)$')

    def _parse_any(self, base_url: str) -> "re.Match[str]":
        """Parse either a github.com blob URL or a raw.githubusercontent.com URL into the same named groups."""
        parts = urlsplit(base_url)
        if parts.hostname == "github.com" and "/blob/" in parts.path:
            return self._parse(base_url)
        if parts.hostname == "raw.githubusercontent.com":
            match = self._RAW_RE.match(parts.path)
            if not match:
                raise ValueError(f"Not a recognized raw.githubusercontent.com URL: {base_url}")
            return match
        raise ValueError(f"Not a recognized GitHub URL: {base_url}")

    def _default_branch(self, owner: str, repo: str, cache: UrlCache) -> str:
        api_url = f"https://api.github.com/repos/{owner}/{repo}"
        branch = cache.get_text(api_url)
        if branch is None:
            response = requests.get(
                api_url, timeout=10, headers={"Accept": "application/vnd.github+json"}
            )
            response.raise_for_status()
            branch = response.json()["default_branch"]
            cache.set_text(api_url, branch)
        return branch

    def build_propose_change_url(self, url: str, text: str, cache: UrlCache) -> "ProposeChangeTarget | None":
        base_url, _, _ = url.partition("#")
        try:
            m = self._parse_any(base_url)
        except ValueError:
            return None
        owner, repo, ref, path = m['owner'], m['repo'], m['ref'], m['path']
        branch = ref if not _SHA_RE.match(ref) else self._default_branch(owner, repo, cache)

        prefilled_url = f"https://github.com/{owner}/{repo}/new/{branch}?{urlencode({'filename': path, 'value': text})}"
        if len(prefilled_url) <= _MAX_PROPOSE_URL_LENGTH:
            return ProposeChangeTarget(url=prefilled_url, content_prefilled=True)

        fallback_url = f"https://github.com/{owner}/{repo}/new/{branch}?{urlencode({'filename': path})}"
        return ProposeChangeTarget(url=fallback_url, content_prefilled=False)


class GitLabAdapter(BaseGitForgeAdapter):
```

- [ ] **Step 7: Implement — `GitLabAdapter.build_propose_change_url()`**

Replace the end of `GitLabAdapter` (its `is_sha_pinned` method, immediately followed by `class GitForgeAdapterRegistry`):

```python
    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        _origin, _project_path, ref, _file_path = self._split(base_url)
        return bool(_SHA_RE.match(ref))


class GitForgeAdapterRegistry:
```

with:

```python
    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        _origin, _project_path, ref, _file_path = self._split(base_url)
        return bool(_SHA_RE.match(ref))

    _RAW_MARKER = "/-/raw/"

    def _split_any(self, base_url: str) -> "tuple[str, str, str, str]":
        """Like _split(), but also recognizes a `/-/raw/` (rather than only `/-/blob/`) URL shape."""
        parts = urlsplit(base_url)
        for marker in (self._MARKER, self._RAW_MARKER):
            if marker in parts.path:
                project_path, _, rest = parts.path.partition(marker)
                ref, _, file_path = rest.partition("/")
                origin = f"{parts.scheme}://{parts.netloc}"
                return origin, project_path.strip("/"), ref, file_path
        raise ValueError(f"Not a recognized GitLab URL: {base_url}")

    def _default_branch(self, origin: str, project_path: str, cache: UrlCache) -> str:
        encoded_project = quote(project_path, safe="")
        api_url = f"{origin}/api/v4/projects/{encoded_project}"
        branch = cache.get_text(api_url)
        if branch is None:
            response = requests.get(api_url, timeout=10)
            response.raise_for_status()
            branch = response.json()["default_branch"]
            cache.set_text(api_url, branch)
        return branch

    def build_propose_change_url(self, url: str, text: str, cache: UrlCache) -> "ProposeChangeTarget | None":
        base_url, _, _ = url.partition("#")
        try:
            origin, project_path, ref, file_path = self._split_any(base_url)
        except ValueError:
            return None
        branch = ref if not _SHA_RE.match(ref) else self._default_branch(origin, project_path, cache)
        edit_url = f"{origin}/{project_path}/-/edit/{branch}/{file_path}"
        return ProposeChangeTarget(url=edit_url, content_prefilled=False)


class GitForgeAdapterRegistry:
```

- [ ] **Step 8: Implement — `GitForgeAdapterRegistry.all_adapters()`**

Replace:

```python
    def get_adapter_for(self, url: str) -> "BaseGitForgeAdapter | None":
        """First registered adapter whose matches() returns True for `url`, else None."""
        for adapter in self._adapters:
            if adapter.matches(url):
                return adapter
        return None
```

with:

```python
    def get_adapter_for(self, url: str) -> "BaseGitForgeAdapter | None":
        """First registered adapter whose matches() returns True for `url`, else None."""
        for adapter in self._adapters:
            if adapter.matches(url):
                return adapter
        return None

    def all_adapters(self) -> "list[BaseGitForgeAdapter]":
        """Every registered adapter, in registration order - unlike get_adapter_for(), not filtered by matches()."""
        return list(self._adapters)
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
uv run python -m pytest tests/unit/fastapi/test_git_forge_adapters.py -v
```

Expected: all tests pass, 0 failures.

- [ ] **Step 10: Commit**

```bash
git add fastapi_app/lib/core/git_forge_adapters.py tests/unit/fastapi/test_git_forge_adapters.py
git commit -m "feat(doc-rules): add build_propose_change_url() to the git-forge adapters"
```

---

### Task 2: `propose-change-url` REST endpoint

**Files:**
- Modify: `fastapi_app/lib/models/models_document_rules.py`
- Modify: `fastapi_app/routers/document_rules.py`
- Modify: `tests/unit/fastapi/test_document_rules_router.py`

- [ ] **Step 1: Add the request/response models**

Append to the end of `fastapi_app/lib/models/models_document_rules.py` (after the existing `RefreshOutcomeResponse` class):

```python


class ProposeChangeUrlRequest(BaseModel):
    """Request to build a URL that lets the caller's own forge session propose `text` as this resource's new upstream content."""
    url: str
    text: str


class ProposeChangeUrlResponse(BaseModel):
    """
    `url` is None when the resource's host isn't a recognized git forge - not
    an error, just nothing to propose a change through. `content_prefilled`
    is only ever True for a GitHub URL short enough to embed `text` directly;
    otherwise the frontend must fall back to a clipboard copy.
    """
    url: Optional[str] = None
    content_prefilled: bool = False
```

- [ ] **Step 2: Add the router test (written first, will fail until Step 3)**

In `tests/unit/fastapi/test_document_rules_router.py`, add this test class at the end of the file:

```python
class TestProposeChangeUrlEndpoint(DocumentRulesRouterTestCase):
    def test_builds_prefilled_url_for_a_github_blob_url(self):
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md", "text": "new content"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["content_prefilled"])
        self.assertTrue(body["url"].startswith("https://github.com/mpilhlt/pdf-tei-editor/new/main?"))
        self.assertIn("new+content", body["url"])

    def test_builds_unprefilled_edit_url_for_a_gitlab_blob_url(self):
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://gitlab.com/group/project/-/blob/main/rules.md", "text": "new content"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["content_prefilled"])
        self.assertEqual(body["url"], "https://gitlab.com/group/project/-/edit/main/rules.md")

    def test_returns_null_url_for_an_unrecognized_host(self):
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://example.com/rules.md", "text": "new content"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIsNone(body["url"])
        self.assertFalse(body["content_prefilled"])
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
uv run python -m pytest tests/unit/fastapi/test_document_rules_router.py -v -k ProposeChangeUrl
```

Expected: `404 Not Found` (the route doesn't exist yet).

- [ ] **Step 4: Implement — imports**

In `fastapi_app/routers/document_rules.py`, add the adapter registry import. Replace:

```python
from ..config import get_settings
from ..lib.core.database import DatabaseManager
from ..lib.core.dependencies import (
    get_db,
    get_document_rules_store,
    get_file_storage,
    require_authenticated_user,
    require_reviewer_or_admin,
)
from ..lib.core.url_cache import UrlCache
```

with:

```python
from ..config import get_settings
from ..lib.core.database import DatabaseManager
from ..lib.core.dependencies import (
    get_db,
    get_document_rules_store,
    get_file_storage,
    require_authenticated_user,
    require_reviewer_or_admin,
)
from ..lib.core.git_forge_adapters import GitForgeAdapterRegistry
from ..lib.core.url_cache import UrlCache
```

Then, in the same file's `from ..lib.models.models_document_rules import (...)` block, add the two new model names in their alphabetical place. Replace:

```python
    OverrideModel,
    QueryResourceRequest,
```

with:

```python
    OverrideModel,
    ProposeChangeUrlRequest,
    ProposeChangeUrlResponse,
    QueryResourceRequest,
```

- [ ] **Step 5: Implement — the endpoint**

Append to the end of `fastapi_app/routers/document_rules.py`:

```python


@router.post("/propose-change-url", response_model=ProposeChangeUrlResponse)
async def propose_change_url(
    request: ProposeChangeUrlRequest,
    user: dict = Depends(require_authenticated_user),
) -> ProposeChangeUrlResponse:
    """
    Build a URL that lets the caller's own GitHub/GitLab session propose
    `text` as the resource's new upstream content - no server-side git write
    or stored credential involved (see
    docs/superpowers/specs/2026-09-28-document-rules-propose-upstream-design.md).
    Returns url=None when the resource's host isn't a recognized git forge.
    """
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    for adapter in GitForgeAdapterRegistry.get_instance().all_adapters():
        try:
            target = adapter.build_propose_change_url(request.url, request.text, cache)
        except Exception as e:
            logger.warning(
                f"Could not build propose-change URL via {type(adapter).__name__} for {request.url}: {e}",
                exc_info=True,
            )
            continue
        if target is not None:
            return ProposeChangeUrlResponse(url=target.url, content_prefilled=target.content_prefilled)
    return ProposeChangeUrlResponse(url=None, content_prefilled=False)
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
uv run python -m pytest tests/unit/fastapi/test_document_rules_router.py -v
```

Expected: all tests pass, including the three new `TestProposeChangeUrlEndpoint` tests and every pre-existing test in the file (no regressions).

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/models/models_document_rules.py fastapi_app/routers/document_rules.py tests/unit/fastapi/test_document_rules_router.py
git commit -m "feat(doc-rules): add POST /document-rules/propose-change-url"
```

---

### Task 3: Dialog template — the button

**Files:**
- Modify: `app/src/templates/document-rules-editor-dialog.html`
- Generated (do not hand-write): `app/src/templates/document-rules-editor-dialog.types.js`

- [ ] **Step 1: Add the button**

In `app/src/templates/document-rules-editor-dialog.html`, replace:

```html
    <sl-button name="resetBtn" size="small" style="display: none;">Reset to original</sl-button>
    <sl-button name="closeBtn" size="small">Close</sl-button>
```

with:

```html
    <sl-button name="resetBtn" size="small" style="display: none;">Reset to original</sl-button>
    <sl-button name="proposeUpstreamBtn" size="small" style="display: none;">Propose change upstream</sl-button>
    <sl-button name="closeBtn" size="small">Close</sl-button>
```

- [ ] **Step 2: Regenerate the types file**

```bash
node scripts/build/generate-ui-types.js
```

- [ ] **Step 3: Verify the generated type includes the new property**

```bash
grep -n "proposeUpstreamBtn" app/src/templates/document-rules-editor-dialog.types.js
```

Expected: one line, `* @property {import('../ui.js').SlButton} proposeUpstreamBtn`.

- [ ] **Step 4: Commit**

```bash
git add app/src/templates/document-rules-editor-dialog.html app/src/templates/document-rules-editor-dialog.types.js
git commit -m "feat(doc-rules): add the propose-upstream button to the resource editor dialog"
```

---

### Task 4: API client method

**Files:**
- Modify: `app/src/modules/api-client-v1.js`

- [ ] **Step 1: Add the request/response typedefs**

`api-client-v1.js`'s type definitions are kept alphabetically sorted. Find the existing `ProjectConfigSetRequest` typedef, immediately followed by the `ProviderResponse` typedef:

```js
/**
 * @typedef {Object} ProjectConfigSetRequest
 * @property {string} key
 * @property {any} value
 */

/**
 * @typedef {Object} ProviderResponse
 * @property {string} id
 * @property {string} label
 * @property {Array<ModelResponse>} models
 */
```

Insert the two new typedefs between them (`"Propose"` sorts before `"Provider"`):

```js
/**
 * @typedef {Object} ProjectConfigSetRequest
 * @property {string} key
 * @property {any} value
 */

/**
 * @typedef {Object} ProposeChangeUrlRequest
 * @property {string} url
 * @property {string} text
 */

/**
 * @typedef {Object} ProposeChangeUrlResponse
 * @property {string=} url - The forge URL to open, or null if the resource's host isn't a recognized git forge.
 * @property {boolean} content_prefilled - Whether `url` already embeds the override text.
 */

/**
 * @typedef {Object} ProviderResponse
 * @property {string} id
 * @property {string} label
 * @property {Array<ModelResponse>} models
 */
```

- [ ] **Step 2: Add the client method**

Methods in the `documentRules*` group are kept in the same order as the router's endpoints. Find the existing `documentRulesRefreshExecute` method:

```js
  /**
   * Perform the document rules refresh: regenerate and save if anything changed.
   *
   * @param {RefreshRequest} requestBody
   * @returns {Promise<RefreshOutcomeResponse>}
   */
  async documentRulesRefreshExecute(requestBody) {
    const endpoint = `/document-rules/refresh/execute`
    return this.callApi(endpoint, 'POST', requestBody);
  }
```

Add the new method immediately after it:

```js
  /**
   * Perform the document rules refresh: regenerate and save if anything changed.
   *
   * @param {RefreshRequest} requestBody
   * @returns {Promise<RefreshOutcomeResponse>}
   */
  async documentRulesRefreshExecute(requestBody) {
    const endpoint = `/document-rules/refresh/execute`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Build a URL that lets the caller's own GitHub/GitLab session propose
   * `text` as the resource's new upstream content - no server-side git
   * write or stored credential involved. `url` is null when the resource's
   * host isn't a recognized git forge.
   *
   * @param {ProposeChangeUrlRequest} requestBody
   * @returns {Promise<ProposeChangeUrlResponse>}
   */
  async documentRulesProposeChangeUrl(requestBody) {
    const endpoint = `/document-rules/propose-change-url`
    return this.callApi(endpoint, 'POST', requestBody);
  }
```

- [ ] **Step 3: Verify the file still parses**

```bash
node -e "import('./app/src/modules/api-client-v1.js').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1) })"
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/api-client-v1.js
git commit -m "feat(doc-rules): add documentRulesProposeChangeUrl to the API client"
```

---

### Task 5: Plugin wiring and unit tests

**Files:**
- Modify: `app/src/plugins/document-rules.js`
- Modify: `tests/unit/js/document-rules.test.js`

- [ ] **Step 1: Add `navigator` fallback and `proposeUpstreamBtn` to the test double, write the failing tests**

In `tests/unit/js/document-rules.test.js`, right after the existing block of `global.X = dom.window.X` assignments near the top of the file (the one ending with `global.CSS = dom.window.CSS;`), add a guard so `global.navigator.clipboard` can always be assigned in tests regardless of the Node version's built-in `navigator` support:

```js
if (typeof global.navigator === 'undefined') {
  global.navigator = {};
}
```

In `makeDialogUi()`, add the new button. Replace:

```js
  el.resetBtn = document.createElement('sl-button');
  el.closeBtn = document.createElement('sl-button');
```

with:

```js
  el.resetBtn = document.createElement('sl-button');
  el.proposeUpstreamBtn = document.createElement('sl-button');
  el.closeBtn = document.createElement('sl-button');
```

Add this new describe block right after the `describe('DocumentRulesPlugin._onNewOverride/_onSave/_onDelete/_onReset', ...)` block closes (i.e. immediately before `describe('DocumentRulesPlugin.onUserChange / role gating', ...)`):

```js
describe('DocumentRulesPlugin._onProposeUpstream', () => {
  function setup() {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'old text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value = 'shown text';
    return plugin;
  }

  let clipboardCalls;
  let openCalls;

  beforeEach(() => {
    clipboardCalls = [];
    openCalls = [];
    global.navigator.clipboard = { writeText: async (text) => { clipboardCalls.push(text); } };
    dom.window.open = (...args) => { openCalls.push(args); };
  });

  it('copies the shown text to the clipboard and opens a prefilled tab', async () => {
    const plugin = setup();
    let calledWith;
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesProposeChangeUrl: async (body) => { calledWith = body; return { url: 'https://github.com/mpilhlt/pdf-tei-editor/new/main?filename=rules.md&value=shown+text', content_prefilled: true }; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onProposeUpstream();
    assert.deepStrictEqual(calledWith, { url: 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md', text: 'shown text' });
    assert.deepStrictEqual(clipboardCalls, ['shown text']);
    assert.strictEqual(openCalls.length, 1);
    assert.strictEqual(openCalls[0][0], 'https://github.com/mpilhlt/pdf-tei-editor/new/main?filename=rules.md&value=shown+text');
    assert.match(notifyCalls[0][0], /prefilled/);
  });

  it('opens an unprefilled tab and notes the clipboard fallback when content_prefilled is false', async () => {
    const plugin = setup();
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesProposeChangeUrl: async () => ({ url: 'https://gitlab.com/group/project/-/edit/main/rules.md', content_prefilled: false }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onProposeUpstream();
    assert.deepStrictEqual(clipboardCalls, ['shown text']);
    assert.strictEqual(openCalls[0][0], 'https://gitlab.com/group/project/-/edit/main/rules.md');
    assert.match(notifyCalls[0][0], /clipboard/);
  });

  it('shows a warning and opens nothing when the resource host is not a recognized forge', async () => {
    const plugin = setup();
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesProposeChangeUrl: async () => ({ url: null, content_prefilled: false }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onProposeUpstream();
    assert.strictEqual(openCalls.length, 0);
    assert.strictEqual(clipboardCalls.length, 0);
    assert.match(notifyCalls[0][0], /not hosted on a recognized git forge/);
  });

  it('shows a danger toast and opens nothing when the backend call fails', async () => {
    const plugin = setup();
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesProposeChangeUrl: async () => { throw new Error('network down'); },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onProposeUpstream();
    assert.strictEqual(openCalls.length, 0);
    assert.match(notifyCalls[0][0], /Could not build the upstream link/);
  });

  it('still opens the tab when the clipboard write is denied', async () => {
    const plugin = setup();
    global.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesProposeChangeUrl: async () => ({ url: 'https://github.com/mpilhlt/pdf-tei-editor/new/main?filename=rules.md&value=shown+text', content_prefilled: true }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onProposeUpstream();
    assert.strictEqual(openCalls.length, 1);
  });
});

describe('DocumentRulesPlugin._renderEditorDialog proposeUpstreamBtn visibility', () => {
  it('is hidden when Original is selected and shown when an override is selected', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'text';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];

    plugin._currentSelectedId = null;
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.proposeUpstreamBtn.style.display, 'none');

    plugin._currentSelectedId = 'ov1';
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.proposeUpstreamBtn.style.display, '');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test tests/unit/js/document-rules.test.js
```

Expected: failures in the new `_onProposeUpstream` tests (`plugin._onProposeUpstream is not a function`) and the new visibility test (`plugin._editorDialogUi.proposeUpstreamBtn` is `undefined`, so `.style` throws).

- [ ] **Step 3: Implement — wire the button and its visibility**

In `app/src/plugins/document-rules.js`, in `install()`, replace:

```js
    this._editorDialogUi.resetBtn.addEventListener('click', () => this._onReset())
```

with:

```js
    this._editorDialogUi.resetBtn.addEventListener('click', () => this._onReset())
    this._editorDialogUi.proposeUpstreamBtn.addEventListener('click', () => this._onProposeUpstream())
```

In `_renderEditorDialog()`, replace:

```js
    dialogUi.newOverrideBtn.disabled = this._documentReadOnly
    dialogUi.saveBtn.style.display = selected && !this._documentReadOnly ? '' : 'none'
    dialogUi.deleteBtn.style.display = selected ? '' : 'none'
    dialogUi.resetBtn.style.display = selected ? '' : 'none'
  }
```

with:

```js
    dialogUi.newOverrideBtn.disabled = this._documentReadOnly
    dialogUi.saveBtn.style.display = selected && !this._documentReadOnly ? '' : 'none'
    dialogUi.deleteBtn.style.display = selected ? '' : 'none'
    dialogUi.resetBtn.style.display = selected ? '' : 'none'
    dialogUi.proposeUpstreamBtn.style.display = selected ? '' : 'none'
  }
```

`proposeUpstreamBtn` is not gated by `_documentReadOnly` like `saveBtn` is — it doesn't write to the host document at all, so it stays available even while the document itself is read-only.

- [ ] **Step 4: Implement — `_onProposeUpstream()`**

Add this method to the class body, right after `_onReset()` and before `_setXmlContent()`:

```js
  /**
   * Build a URL that lets the caller's own GitHub/GitLab session propose the
   * currently shown override text as the resource's new upstream content,
   * copy that text to the clipboard as a paste-ready fallback (GitLab, and
   * GitHub when the text is too long to embed in the URL, can't prefill the
   * content), and open the forge's page in a new tab. No server-side git
   * write happens anywhere in this flow - see
   * docs/superpowers/specs/2026-09-28-document-rules-propose-upstream-design.md.
   * @returns {Promise<void>}
   */
  async _onProposeUpstream() {
    const text = this._currentShownText()
    let response
    try {
      response = await this.#client.apiClient.documentRulesProposeChangeUrl({ url: this._currentResource.url, text })
    } catch (error) {
      notify(`Could not build the upstream link: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    if (!response.url) {
      notify('This resource is not hosted on a recognized git forge; no upstream link is available.', 'warning', 'exclamation-triangle')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard denied/unavailable - non-fatal whether or not the URL
      // itself already carries the text.
    }
    window.open(response.url, '_blank', 'noopener')
    notify(
      response.content_prefilled
        ? 'Opening a prefilled upstream editor in a new tab.'
        : 'Opening the upstream editor in a new tab — the override text has been copied to your clipboard, paste it in.',
      'primary', 'info-circle'
    )
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test tests/unit/js/document-rules.test.js
```

Expected: all tests pass, including the new ones, with no regressions in the rest of the file.

- [ ] **Step 6: Commit**

```bash
git add app/src/plugins/document-rules.js tests/unit/js/document-rules.test.js
git commit -m "feat(doc-rules): add the propose-upstream button's behavior"
```

---

### Task 6: Full-suite verification and manual smoke check

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

```bash
npm run test:unit
```

Expected: all JS and Python unit tests pass, including every test touched by Tasks 1-5.

- [ ] **Step 2: Run the full E2E suite**

```bash
npm run test:e2e
```

Expected: all pre-existing E2E tests still pass. No new E2E test is added for this feature (see the design spec's "Testing" section for why); this run only confirms no regression.

- [ ] **Step 3: Manual smoke check**

Ask the user to open the app (per this project's rule, never start/restart the dev server yourself), open a document with at least one `editorialDecl/interpretation` entry hosted on GitHub, open its resource editor via Tools → Document Rules → "Edit prompts/schemas", click "New override" (or select an existing one), then click "Propose change upstream". Confirm: a new browser tab opens on GitHub's file editor at the right path with the override text already filled in, and a toast confirms this in the app. Repeat with a GitLab-hosted resource if one is available, confirming the edit page opens and the override text is on the clipboard (paste to verify).

- [ ] **Step 4: Request code review**

Per `superpowers:requesting-code-review`, dispatch a code-reviewer subagent against the whole plan's diff (`BASE_SHA` = the commit before Task 1, `HEAD_SHA` = HEAD), asking it to specifically check:

1. **No server-side git write or stored credential** anywhere in the diff — grep for any new outbound `requests.post`/`requests.put`/`requests.patch` call, which would indicate an accidental write path; only `requests.get` (default-branch lookups) should appear.
2. **The `matches()` contract is unchanged** — `GitHubAdapter.matches()`/`GitLabAdapter.matches()` must still only recognize blob-shaped URLs, exactly as before this plan; the new raw-URL recognition must live only in `_parse_any()`/`_split_any()`, not in `matches()` itself (changing `matches()` would silently alter `resolve_forge_permalink()`/`fetch_rule_excerpt()`/`normalize_resource_key()`'s existing behavior for raw URLs).
3. **`proposeUpstreamBtn` visibility matches `deleteBtn`/`resetBtn`, not `saveBtn`** — it must show whenever an override is selected, regardless of `_documentReadOnly` (unlike `saveBtn`, which additionally requires `!_documentReadOnly`).
