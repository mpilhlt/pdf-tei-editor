# Revision Feed Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backend plugin (`revision_feed`) that exposes a per-user-token-authenticated Atom feed of qualifying TEI `revisionDesc` changes, scoped per project, plus a small frontend UI for users to get/regenerate their feed URLs.

**Architecture:** New plugin at `fastapi_app/plugins/revision_feed/`. A plugin-owned JSON token store maps `username -> token` (separate from core `users.json`). Two session-authenticated management routes (`/my-feeds`, `/token/regenerate`) and one public, token-authenticated route (`/feed/{project_id}.atom`) that re-checks project access on every request, parses every `<tei:revisionDesc><tei:change>` across the project's collections, filters by a configurable status allowlist, and renders hand-rolled Atom XML (via `lxml`, no new dependency). A frontend extension adds a "Revision Feeds" entry to the existing user menu via the `toolbar.menuItems` extension point.

**Tech Stack:** FastAPI, lxml, Python stdlib (`secrets`, `datetime`), vanilla JS frontend extension (`FrontendExtensionPlugin`), Playwright E2E.

**Full spec:** `docs/superpowers/specs/2026-10-07-revision-feed-plugin-design.md`

---

## Reference facts (verified against the codebase, used throughout this plan)

- Plugin dirs use underscores (`revision_feed`, not `revision-feed`); the plugin `id`/routes/config keys still use hyphens by convention.
- `PluginRegistry` auto-imports `fastapi_app.plugins.revision_feed.plugin`, finds the `Plugin` subclass. `PluginManager` separately auto-loads `routes.py`'s module-level `router` and calls `app.include_router()`.
- `fastapi_app/lib/plugins/plugin_base.py`: `Plugin.metadata` (required: `id`, `name`, `description`, `category`, `version`, `required_roles`; optional `endpoints: []` is valid and adds no menu items), `get_endpoints() -> dict[str, Callable]`, optional `async def initialize(self, context: PluginContext) -> None` / `async def cleanup(self) -> None`.
- `get_plugin_config(config_key, env_var, default=None, value_type="string", allowed_values=None, description=None, masked=False) -> Any` (`fastapi_app/lib/plugins/plugin_tools.py:26`). `env_var` is a required positional even if never expected to be set. `value_type="array"` parses a JSON string from the env var; the default is used as-is if config.json has no stored value yet. Call once, in the plugin's `__init__`.
- `get_config().get(key, default=...)` reads config (`fastapi_app/lib/utils/config_utils.py`). Canonical lifecycle statuses: `config/config.json` key `annotation.lifecycle.order` = `["extraction", "unfinished", "draft", "checked", "in-review", "approved", "candidate", "published"]`.
- `fastapi_app/lib/utils/data_utils.py`: `load_json_file(path, create_if_missing=True, default_content=None)` / `save_json_file(path, data)` — generic, no entity-type restriction (unlike `load_entity_data`/`save_entity_data`, which only accept `users|roles|groups|collections|projects|config`). Use these generic functions for the plugin's own token store file.
- `get_settings().plugins_data_dir` → `data/plugins/` (canonical path property, `fastapi_app/config.py`). `get_settings().db_dir` → `data/db/`.
- `fastapi_app/lib/utils/project_utils.py`: `find_project(project_id, projects_data) -> Optional[dict]`, `get_projects_with_details(db_dir) -> list[dict]` (project shape: `{id, name, description, members: list[str], collections: list[str], config: dict}`), `get_user_projects(user, db_dir) -> list[dict]` (plain membership filter — already exists, no need to add it).
- `fastapi_app/lib/permissions/user_utils.py`: `user_has_collection_access(user, collection_id, db_dir) -> bool` (wildcard-role-aware).
- `fastapi_app/lib/utils/auth.py`: `AuthManager.get_user_by_username(username: str) -> Optional[dict]`. User dict has `username`, `roles`, `email`, `fullname` — no `id` field; `username` is the identity key everywhere.
- `fastapi_app/lib/core/dependencies.py`: `get_db() -> DatabaseManager`, `get_file_storage() -> FileStorage`, `get_session_manager() -> SessionManager`, `get_auth_manager() -> AuthManager` — all plain functions used as FastAPI deps via `Depends(...)`.
- `fastapi_app/lib/repository/file_repository.py:705`: `FileRepository(db).get_files_by_collection(collection_id: str, include_deleted: bool = False) -> List[FileMetadata]`. `FileMetadata` (`fastapi_app/lib/models/models.py:13`) has `id`, `stable_id`, `doc_id`, `file_type`, `label`, `variant`, `status`, `doc_collections`, etc.
- `fastapi_app/lib/storage/file_storage.py:135`: `file_storage.read_file(file_metadata.id, "tei") -> Optional[bytes]`.
- `fastapi_app/lib/utils/tei_utils.py:1066`: `get_annotator_name(tei_root, who_id) -> str`. No existing helper walks *every* `<change>` (only the last) — this plan adds that logic locally in the new plugin.
- No Atom/RSS library exists in `pyproject.toml`/`uv.lock` — build XML with `lxml.etree` (already a dependency, and the mandated XML library per `fastapi_app/CLAUDE.md`).
- Session-route auth pattern (copy from `fastapi_app/plugins/collection_overview/routes.py:27-48`): a module-level `_authenticate(session_id, x_session_id, session_manager, auth_manager) -> dict` helper, called from each session-authenticated route with `session_id: str | None = Query(None)`, `x_session_id: str | None = Header(None, alias="X-Session-ID")`.
- Frontend: `FrontendExtensionPlugin` (`app/src/modules/frontend-extension-plugin.js`) exposes `callPluginApi(endpoint, method='GET', params=null)` (auto-sends `X-Session-ID` from `this.state.sessionId`) and `fetchText(url)`. Extensions are IIFEs with imports stripped — build DOM with `document.createElement`, no `registerTemplate`. The existing user menu (`app/src/plugins/user-account.js`) collects contributions via extension point `toolbar.menuItems` (string value, from `app/src/extension-points.js:133`): any plugin (including a frontend extension) can declare `static extensionPoints = ['toolbar.menuItems'];` and implement `['toolbar.menuItems']()` returning `[{element}, ...]`.
- Deep link into the editor: `{app_base_url}#xml={stable_id}&collection={collection_id}` (`xml`/`collection` are both in `config/config.json`'s `state.allowSetFromUrl`).
- Plugin-local Python tests live in `fastapi_app/plugins/<name>/tests/test_*.py`, run via `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`. Reference test harness: `fastapi_app/plugins/edit_history/tests/test_edit_history_export.py` (FastAPI `TestClient` + `app.dependency_overrides` for `get_session_manager`/`get_auth_manager`/`get_db`/`get_file_storage`, `@patch` for module-level functions imported inside route bodies).
- E2E tests live in `tests/e2e/tests/*.spec.js`, using `performLogin` from `tests/e2e/tests/helpers/login-helper.js` and the `debug-on-failure` fixture (see `tests/e2e/tests/frontend-extension.spec.js` for the pattern).

---

## Task 1: Token store

**Files:**
- Create: `fastapi_app/plugins/revision_feed/__init__.py` (empty for now — filled in Task 2)
- Create: `fastapi_app/plugins/revision_feed/token_store.py`
- Test: `fastapi_app/plugins/revision_feed/tests/test_token_store.py`

- [ ] **Step 1: Create the plugin package directories**

```bash
mkdir -p fastapi_app/plugins/revision_feed/tests
mkdir -p fastapi_app/plugins/revision_feed/extensions
touch fastapi_app/plugins/revision_feed/__init__.py
touch fastapi_app/plugins/revision_feed/tests/__init__.py
```

- [ ] **Step 2: Write the failing test**

```python
"""
Unit tests for the revision feed plugin's token store.

@testCovers fastapi_app/plugins/revision_feed/token_store.py
"""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi_app.plugins.revision_feed.token_store import (
    get_or_create_token,
    regenerate_token,
    resolve_token,
)


class TestTokenStore(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.plugins_data_dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_get_or_create_token_creates_new_token(self):
        token = get_or_create_token("alice", self.plugins_data_dir)
        self.assertTrue(len(token) > 20)

    def test_get_or_create_token_is_stable(self):
        first = get_or_create_token("alice", self.plugins_data_dir)
        second = get_or_create_token("alice", self.plugins_data_dir)
        self.assertEqual(first, second)

    def test_different_users_get_different_tokens(self):
        alice_token = get_or_create_token("alice", self.plugins_data_dir)
        bob_token = get_or_create_token("bob", self.plugins_data_dir)
        self.assertNotEqual(alice_token, bob_token)

    def test_resolve_token_returns_username(self):
        token = get_or_create_token("alice", self.plugins_data_dir)
        self.assertEqual(resolve_token(token, self.plugins_data_dir), "alice")

    def test_resolve_unknown_token_returns_none(self):
        self.assertIsNone(resolve_token("not-a-real-token", self.plugins_data_dir))

    def test_regenerate_token_invalidates_old_token(self):
        old_token = get_or_create_token("alice", self.plugins_data_dir)
        new_token = regenerate_token("alice", self.plugins_data_dir)

        self.assertNotEqual(old_token, new_token)
        self.assertIsNone(resolve_token(old_token, self.plugins_data_dir))
        self.assertEqual(resolve_token(new_token, self.plugins_data_dir), "alice")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: FAIL (import error — `token_store` module does not exist yet)

- [ ] **Step 4: Write the implementation**

```python
"""
Per-user feed token storage for the revision feed plugin.

Tokens authenticate the public Atom feed endpoint (a query-string token,
not a session) and are stored separately from core `users.json` — a
single-purpose feed credential should not require changing core auth
schema. One token per user; regenerating invalidates the previous one.
"""

import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi_app.lib.utils.data_utils import load_json_file, save_json_file

TOKENS_FILE_NAME = "tokens.json"


def _tokens_path(plugins_data_dir: Path) -> Path:
    return Path(plugins_data_dir) / "revision_feed" / TOKENS_FILE_NAME


def _load_tokens(plugins_data_dir: Path) -> dict[str, dict[str, str]]:
    data = load_json_file(_tokens_path(plugins_data_dir), create_if_missing=True, default_content={})
    return data if isinstance(data, dict) else {}


def _save_tokens(plugins_data_dir: Path, tokens: dict[str, dict[str, str]]) -> None:
    _tokens_path(plugins_data_dir).parent.mkdir(parents=True, exist_ok=True)
    save_json_file(_tokens_path(plugins_data_dir), tokens)


def _new_token_entry() -> dict[str, str]:
    return {
        "token": secrets.token_urlsafe(32),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def get_or_create_token(username: str, plugins_data_dir: Path) -> str:
    """Return the user's existing feed token, creating one if they have none."""
    tokens = _load_tokens(plugins_data_dir)
    entry = tokens.get(username)
    if entry:
        return entry["token"]

    entry = _new_token_entry()
    tokens[username] = entry
    _save_tokens(plugins_data_dir, tokens)
    return entry["token"]


def regenerate_token(username: str, plugins_data_dir: Path) -> str:
    """Issue a new feed token for the user, invalidating any previous one."""
    tokens = _load_tokens(plugins_data_dir)
    entry = _new_token_entry()
    tokens[username] = entry
    _save_tokens(plugins_data_dir, tokens)
    return entry["token"]


def resolve_token(token: str, plugins_data_dir: Path) -> Optional[str]:
    """Return the username owning this token, or None if it is unknown."""
    tokens = _load_tokens(plugins_data_dir)
    for username, entry in tokens.items():
        if entry.get("token") == token:
            return username
    return None
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/revision_feed/
git commit -m "feat(revision-feed): add per-user feed token store"
```

---

## Task 2: Plugin skeleton and config registration

**Files:**
- Create: `fastapi_app/plugins/revision_feed/plugin.py`
- Modify: `fastapi_app/plugins/revision_feed/__init__.py`
- Test: `fastapi_app/plugins/revision_feed/tests/test_plugin.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for the revision feed plugin's metadata and config registration.

@testCovers fastapi_app/plugins/revision_feed/plugin.py
"""

import unittest

from fastapi_app.plugins.revision_feed.plugin import RevisionFeedPlugin


class TestRevisionFeedPlugin(unittest.TestCase):
    def test_metadata_has_required_fields(self):
        plugin = RevisionFeedPlugin()
        metadata = plugin.metadata

        self.assertEqual(metadata["id"], "revision-feed")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertEqual(metadata["endpoints"], [])

    def test_get_endpoints_is_empty(self):
        plugin = RevisionFeedPlugin()
        self.assertEqual(plugin.get_endpoints(), {})

    def test_registers_default_included_statuses_from_lifecycle_order(self):
        from fastapi_app.lib.utils.config_utils import get_config

        RevisionFeedPlugin()
        statuses = get_config().get("plugin.revision-feed.included-statuses")

        self.assertNotIn("extraction", statuses)
        self.assertIn("draft", statuses)
        self.assertIn("published", statuses)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: FAIL (import error — `plugin` module does not exist yet)

- [ ] **Step 3: Write the implementation**

```python
"""
Revision Feed Plugin.

Exposes a per-user-token-authenticated Atom feed (per project) of TEI
revisionDesc changes whose status is in a configurable allowlist. See
docs/superpowers/specs/2026-10-07-revision-feed-plugin-design.md.
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class RevisionFeedPlugin(Plugin):
    """Plugin providing per-project Atom feeds of document revisions."""

    def __init__(self):
        from fastapi_app.lib.utils.config_utils import get_config

        lifecycle_order = get_config().get("annotation.lifecycle.order", default=[])
        default_statuses = [status for status in lifecycle_order if status != "extraction"]

        get_plugin_config(
            "plugin.revision-feed.included-statuses",
            "REVISION_FEED_INCLUDED_STATUSES",
            default=default_statuses,
            value_type="array",
            description="Lifecycle statuses whose revisionDesc changes appear in the revision feed",
        )

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "revision-feed",
            "name": "Revision Feed",
            "description": "Per-project Atom feeds of document revisions",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension that adds the user-menu entry."""
        from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry

        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "revision-feed.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])

        logger.info("Revision feed plugin initialized")
```

```python
from .plugin import RevisionFeedPlugin
from .routes import router

plugin = RevisionFeedPlugin()

__all__ = ["RevisionFeedPlugin", "router"]
```

(the second code block replaces the full contents of `fastapi_app/plugins/revision_feed/__init__.py` — note this import of `.routes` will fail until Task 5 creates `routes.py`; see Step 4 below)

- [ ] **Step 4: Run test to verify it passes**

`__init__.py`'s `from .routes import router` doesn't exist yet, but the test imports `fastapi_app.plugins.revision_feed.plugin` directly, not the package's `__init__.py`'s re-export — so this still works. Confirm:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: PASS (3 tests)

- [ ] **Step 5: Temporarily simplify `__init__.py` until routes.py exists**

Replace `__init__.py` with just the plugin import, so nothing else in the test suite that imports the package breaks before Task 5:

```python
from .plugin import RevisionFeedPlugin

plugin = RevisionFeedPlugin()

__all__ = ["RevisionFeedPlugin"]
```

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/revision_feed/
git commit -m "feat(revision-feed): add plugin skeleton and status-allowlist config"
```

---

## Task 3: Revision parsing and Atom feed building

**Files:**
- Create: `fastapi_app/plugins/revision_feed/revisions.py`
- Test: `fastapi_app/plugins/revision_feed/tests/test_revisions.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for revision extraction and Atom feed building.

@testCovers fastapi_app/plugins/revision_feed/revisions.py
"""

import unittest
from datetime import datetime

from fastapi_app.plugins.revision_feed.revisions import (
    RevisionEntry,
    build_atom_feed,
    extract_revision_entries,
)

TEI_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Sample</title>
        <respStmt>
          <persName xml:id="jdoe">Jane Doe</persName>
          <resp>Annotator</resp>
        </respStmt>
      </titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-01-01T10:00:00" who="#jdoe" status="draft">
        <desc>First pass</desc>
      </change>
      <change when="2026-02-01T10:00:00" who="#jdoe" status="approved">
        <desc>Reviewed and approved</desc>
      </change>
      <change when="2026-03-01T10:00:00" who="#jdoe" status="extraction">
        <desc>Should be filtered out</desc>
      </change>
    </revisionDesc>
  </teiHeader>
</TEI>"""


class TestExtractRevisionEntries(unittest.TestCase):
    def test_extracts_one_entry_per_qualifying_change(self):
        entries = extract_revision_entries(
            TEI_SAMPLE,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["draft", "approved"],
        )

        self.assertEqual(len(entries), 2)
        statuses = {entry.status for entry in entries}
        self.assertEqual(statuses, {"draft", "approved"})

    def test_filters_out_excluded_statuses(self):
        entries = extract_revision_entries(
            TEI_SAMPLE,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["approved"],
        )

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].status, "approved")
        self.assertEqual(entries[0].description, "Reviewed and approved")
        self.assertEqual(entries[0].who, "Jane Doe")

    def test_no_qualifying_changes_returns_empty_list(self):
        entries = extract_revision_entries(
            TEI_SAMPLE,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["candidate"],
        )
        self.assertEqual(entries, [])


class TestBuildAtomFeed(unittest.TestCase):
    def setUp(self):
        self.entries = [
            RevisionEntry(
                stable_id="stable-1",
                doc_label="Sample Doc",
                status="approved",
                when=datetime(2026, 2, 1, 10, 0, 0),
                who="Jane Doe",
                description="Reviewed and approved",
                collection_id="col-1",
            ),
            RevisionEntry(
                stable_id="stable-2",
                doc_label="Other Doc",
                status="draft",
                when=datetime(2026, 1, 1, 10, 0, 0),
                who="Jane Doe",
                description="First pass",
                collection_id="col-1",
            ),
        ]

    def test_builds_valid_atom_xml(self):
        from lxml import etree

        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/api/plugins/revision-feed/feed/proj-1.atom?token=abc",
            entries=self.entries,
            app_base_url="http://example.test/",
        )

        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        entries = root.findall("atom:entry", ns)

        self.assertEqual(len(entries), 2)
        # Sorted newest-first
        first_title = entries[0].find("atom:title", ns).text
        self.assertIn("Sample Doc", first_title)
        self.assertIn("approved", first_title)

    def test_entry_link_uses_deep_link_scheme(self):
        from lxml import etree

        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/feed",
            entries=self.entries[:1],
            app_base_url="http://example.test/",
        )

        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        link = root.find("atom:entry/atom:link", ns)

        self.assertEqual(link.get("href"), "http://example.test/#xml=stable-1&collection=col-1")

    def test_respects_max_entries(self):
        many_entries = self.entries * 30  # 60 entries
        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/feed",
            entries=many_entries,
            app_base_url="http://example.test/",
            max_entries=10,
        )

        from lxml import etree
        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        self.assertEqual(len(root.findall("atom:entry", ns)), 10)

    def test_empty_entries_produces_valid_empty_feed(self):
        from lxml import etree

        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/feed",
            entries=[],
            app_base_url="http://example.test/",
        )

        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        self.assertEqual(root.findall("atom:entry", ns), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: FAIL (import error — `revisions` module does not exist yet)

- [ ] **Step 3: Write the implementation**

```python
"""
Revision extraction and Atom feed building for the revision feed plugin.

Parses every <tei:revisionDesc><tei:change> in a TEI document (not just the
last one, unlike edit_history's _extract_revision_info) and renders the
qualifying changes as a hand-rolled Atom 1.0 feed via lxml — there is no
feed-generation library in this project's dependencies.
"""

from dataclasses import dataclass
from datetime import datetime, timezone

from lxml import etree

from fastapi_app.lib.utils.tei_utils import get_annotator_name

TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}
ATOM_NS = "http://www.w3.org/2005/Atom"


@dataclass
class RevisionEntry:
    stable_id: str
    doc_label: str
    status: str
    when: datetime
    who: str
    description: str
    collection_id: str


def extract_revision_entries(
    xml_content: str,
    stable_id: str,
    doc_label: str,
    collection_id: str,
    included_statuses: list[str],
) -> list[RevisionEntry]:
    """Parse every revisionDesc/change whose @status is in included_statuses."""
    root = etree.fromstring(xml_content.encode("utf-8"))
    entries: list[RevisionEntry] = []

    for change in root.findall(".//tei:revisionDesc/tei:change", TEI_NS):
        status = change.get("status", "draft")
        if status not in included_statuses:
            continue

        when_raw = change.get("when", "")
        try:
            when = datetime.fromisoformat(when_raw.replace("Z", "+00:00"))
            if when.tzinfo is not None:
                when = when.replace(tzinfo=None)
        except (ValueError, AttributeError):
            continue

        who_id = change.get("who", "")
        who = get_annotator_name(root, who_id) if who_id else "Unknown"

        desc_elem = change.find("tei:desc", TEI_NS)
        if desc_elem is not None and desc_elem.text:
            description = desc_elem.text.strip()
        elif change.text and change.text.strip():
            description = change.text.strip()
        else:
            description = "No description"

        entries.append(
            RevisionEntry(
                stable_id=stable_id,
                doc_label=doc_label,
                status=status,
                when=when,
                who=who,
                description=description,
                collection_id=collection_id,
            )
        )

    return entries


def build_atom_feed(
    project_id: str,
    project_name: str,
    feed_url: str,
    entries: list[RevisionEntry],
    app_base_url: str,
    max_entries: int = 50,
) -> str:
    """Build an Atom 1.0 XML document (as a UTF-8 string) from revision entries."""
    sorted_entries = sorted(entries, key=lambda entry: entry.when, reverse=True)[:max_entries]

    feed = etree.Element("feed", nsmap={None: ATOM_NS})

    etree.SubElement(feed, "title").text = f"{project_name} — Revision Feed"
    etree.SubElement(feed, "id").text = f"urn:revision-feed:project:{project_id}"

    latest_when = sorted_entries[0].when if sorted_entries else datetime.now(timezone.utc)
    etree.SubElement(feed, "updated").text = latest_when.strftime("%Y-%m-%dT%H:%M:%SZ")
    etree.SubElement(feed, "link", rel="self", href=feed_url)

    for entry in sorted_entries:
        entry_el = etree.SubElement(feed, "entry")
        etree.SubElement(entry_el, "title").text = f"{entry.doc_label} — {entry.status}"
        etree.SubElement(entry_el, "id").text = (
            f"urn:revision-feed:{entry.stable_id}:{entry.when.isoformat()}:{entry.status}"
        )
        etree.SubElement(entry_el, "updated").text = entry.when.strftime("%Y-%m-%dT%H:%M:%SZ")

        author_el = etree.SubElement(entry_el, "author")
        etree.SubElement(author_el, "name").text = entry.who

        etree.SubElement(entry_el, "summary").text = entry.description

        doc_link = f"{app_base_url.rstrip('/')}/#xml={entry.stable_id}&collection={entry.collection_id}"
        etree.SubElement(entry_el, "link", href=doc_link)

    return etree.tostring(
        feed, xml_declaration=True, encoding="UTF-8", pretty_print=True
    ).decode("utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/revision_feed/revisions.py fastapi_app/plugins/revision_feed/tests/test_revisions.py
git commit -m "feat(revision-feed): add revision extraction and Atom feed building"
```

---

## Task 4: Management routes (`/my-feeds`, `/token/regenerate`)

**Files:**
- Create: `fastapi_app/plugins/revision_feed/routes.py` (feed route added in Task 5)
- Test: `fastapi_app/plugins/revision_feed/tests/test_routes_management.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for the revision feed plugin's session-authenticated management routes.

@testCovers fastapi_app/plugins/revision_feed/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


class TestManagementRoutes(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.revision_feed.routes import router
        from fastapi_app.lib.core.dependencies import (
            get_auth_manager,
            get_session_manager,
        )

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager

        self.client = TestClient(self.app)

    def test_my_feeds_no_session_returns_401(self):
        response = self.client.get("/api/plugins/revision-feed/my-feeds")
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.plugins.revision_feed.token_store.get_or_create_token")
    @patch("fastapi_app.lib.utils.project_utils.get_user_projects")
    @patch("fastapi_app.config.get_settings")
    def test_my_feeds_returns_token_and_urls(self, mock_settings, mock_get_projects, mock_get_token):
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = {"username": "alice", "roles": ["user"]}
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user

        mock_get_token.return_value = "tok_abc123"
        mock_get_projects.return_value = [{"id": "proj-1", "name": "Project One"}]

        response = self.client.get(
            "/api/plugins/revision-feed/my-feeds",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["token"], "tok_abc123")
        self.assertEqual(len(data["feeds"]), 1)
        self.assertEqual(data["feeds"][0]["project_id"], "proj-1")
        self.assertIn("token=tok_abc123", data["feeds"][0]["url"])
        self.assertIn("/api/plugins/revision-feed/feed/proj-1.atom", data["feeds"][0]["url"])

    @patch("fastapi_app.plugins.revision_feed.token_store.regenerate_token")
    @patch("fastapi_app.lib.utils.project_utils.get_user_projects")
    @patch("fastapi_app.config.get_settings")
    def test_regenerate_token_returns_new_token(self, mock_settings, mock_get_projects, mock_regenerate):
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = {"username": "alice", "roles": ["user"]}
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user

        mock_regenerate.return_value = "tok_new456"
        mock_get_projects.return_value = []

        response = self.client.post(
            "/api/plugins/revision-feed/token/regenerate",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["token"], "tok_new456")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: FAIL (import error — `routes` module does not exist yet)

- [ ] **Step 3: Write the implementation**

```python
"""Custom routes for the Revision Feed plugin."""

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.auth import AuthManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/revision-feed", tags=["revision-feed"])


def _authenticate(
    session_id: str | None,
    x_session_id: str | None,
    session_manager: SessionManager,
    auth_manager: AuthManager,
) -> dict[str, Any]:
    """Shared session-based auth check for the management endpoints."""
    from fastapi_app.config import get_settings

    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def _feed_urls_for_user(user: dict[str, Any], token: str, request: Request) -> list[dict[str, str]]:
    from fastapi_app.config import get_settings
    from fastapi_app.lib.utils.project_utils import get_user_projects

    settings = get_settings()
    projects = get_user_projects(user, settings.db_dir)
    base = str(request.base_url).rstrip("/")

    return [
        {
            "project_id": project["id"],
            "project_name": project.get("name") or project["id"],
            "url": f"{base}/api/plugins/revision-feed/feed/{project['id']}.atom?token={token}",
        }
        for project in projects
    ]


@router.get("/my-feeds")
async def my_feeds(
    request: Request,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> dict[str, Any]:
    """Return the user's feed token and feed URLs for every project they belong to."""
    from fastapi_app.config import get_settings
    from fastapi_app.plugins.revision_feed.token_store import get_or_create_token

    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    settings = get_settings()
    token = get_or_create_token(user["username"], settings.plugins_data_dir)

    return {"token": token, "feeds": _feed_urls_for_user(user, token, request)}


@router.post("/token/regenerate")
async def regenerate_token_endpoint(
    request: Request,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> dict[str, Any]:
    """Issue a new feed token for the user, invalidating the previous one."""
    from fastapi_app.config import get_settings
    from fastapi_app.plugins.revision_feed.token_store import regenerate_token

    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    settings = get_settings()
    token = regenerate_token(user["username"], settings.plugins_data_dir)

    return {"token": token, "feeds": _feed_urls_for_user(user, token, request)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: PASS (3 tests)

- [ ] **Step 5: Restore the full `__init__.py` now that `routes.py` exists**

```python
from .plugin import RevisionFeedPlugin
from .routes import router

plugin = RevisionFeedPlugin()

__all__ = ["RevisionFeedPlugin", "router"]
```

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/revision_feed/
git commit -m "feat(revision-feed): add session-authenticated feed management routes"
```

---

## Task 5: Public token-authenticated feed route

**Files:**
- Modify: `fastapi_app/plugins/revision_feed/routes.py`
- Test: `fastapi_app/plugins/revision_feed/tests/test_routes_feed.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for the revision feed plugin's public, token-authenticated feed route.

@testCovers fastapi_app/plugins/revision_feed/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

TEI_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Sample</title></titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-01-01T10:00:00" who="jdoe" status="approved">
        <desc>Reviewed</desc>
      </change>
    </revisionDesc>
  </teiHeader>
</TEI>"""


class TestFeedRoute(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.revision_feed.routes import router
        from fastapi_app.lib.core.dependencies import get_db, get_file_storage

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_db = MagicMock()
        self.mock_storage = MagicMock()

        self.app.dependency_overrides[get_db] = lambda: self.mock_db
        self.app.dependency_overrides[get_file_storage] = lambda: self.mock_storage

        self.client = TestClient(self.app)

    def test_missing_token_returns_422(self):
        response = self.client.get("/api/plugins/revision-feed/feed/proj-1.atom")
        self.assertEqual(response.status_code, 422)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.config.get_settings")
    def test_unknown_token_returns_401(self, mock_settings, mock_resolve):
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj
        mock_resolve.return_value = None

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "bad-token"}
        )
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.core.dependencies.get_auth_manager")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.config.get_settings")
    def test_unknown_project_returns_403(
        self, mock_settings, mock_get_projects, mock_get_auth_manager, mock_resolve
    ):
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        mock_auth_manager = MagicMock()
        mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}
        mock_get_auth_manager.return_value = mock_auth_manager
        mock_get_projects.return_value = []

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )
        self.assertEqual(response.status_code, 403)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.core.dependencies.get_auth_manager")
    @patch("fastapi_app.lib.permissions.user_utils.user_has_collection_access")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.config.get_settings")
    def test_project_exists_but_user_lost_access_returns_403(
        self, mock_settings, mock_get_projects, mock_access, mock_get_auth_manager, mock_resolve
    ):
        """User's token is valid, but they were since removed from the project."""
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        mock_auth_manager = MagicMock()
        mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}
        mock_get_auth_manager.return_value = mock_auth_manager

        mock_get_projects.return_value = [
            {"id": "proj-1", "name": "Project One", "collections": ["col-1"]}
        ]
        mock_access.return_value = False  # no longer a member of any of the project's collections

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )
        self.assertEqual(response.status_code, 403)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.core.dependencies.get_auth_manager")
    @patch("fastapi_app.lib.permissions.user_utils.user_has_collection_access")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.config.get_settings")
    def test_success_returns_atom_feed(
        self,
        mock_settings,
        mock_get_config,
        mock_repo_class,
        mock_get_projects,
        mock_access,
        mock_get_auth_manager,
        mock_resolve,
    ):
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        mock_auth_manager = MagicMock()
        mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}
        mock_get_auth_manager.return_value = mock_auth_manager

        mock_get_projects.return_value = [
            {"id": "proj-1", "name": "Project One", "collections": ["col-1"]}
        ]
        mock_access.return_value = True

        mock_config = MagicMock()
        mock_config.get.return_value = ["approved"]
        mock_get_config.return_value = mock_config

        mock_file = MagicMock()
        mock_file.id = "file-1"
        mock_file.file_type = "tei"
        mock_file.stable_id = "stable-1"
        mock_file.doc_id = "doc-1"
        mock_file.label = "Sample Doc"

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [mock_file]
        mock_repo_class.return_value = mock_repo

        self.mock_storage.read_file.return_value = TEI_SAMPLE.encode("utf-8")

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("atom+xml", response.headers["content-type"])
        self.assertIn("Sample Doc", response.text)
        self.assertIn("approved", response.text)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: FAIL (404 — route doesn't exist yet)

- [ ] **Step 3: Add the feed route to `routes.py`**

Append to `fastapi_app/plugins/revision_feed/routes.py` (after the existing imports, add `FileRepository`/config imports at top; the route itself goes after `regenerate_token_endpoint`):

```python
@router.get("/feed/{project_id}.atom")
async def project_feed(
    project_id: str,
    request: Request,
    token: str = Query(...),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> Response:
    """Public Atom feed of qualifying revisionDesc changes for one project."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.permissions.user_utils import user_has_collection_access
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.utils.config_utils import get_config
    from fastapi_app.lib.utils.project_utils import find_project, get_projects_with_details
    from fastapi_app.plugins.revision_feed.revisions import build_atom_feed, extract_revision_entries
    from fastapi_app.plugins.revision_feed.token_store import resolve_token

    settings = get_settings()

    username = resolve_token(token, settings.plugins_data_dir)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid feed token")

    user = auth_manager.get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid feed token")

    projects = get_projects_with_details(settings.db_dir)
    project = find_project(project_id, projects)
    if not project:
        raise HTTPException(status_code=403, detail="Project not found or access denied")

    collections = project.get("collections", [])
    has_access = any(
        user_has_collection_access(user, collection_id, settings.db_dir)
        for collection_id in collections
    )
    if not has_access:
        raise HTTPException(status_code=403, detail="Project not found or access denied")

    included_statuses = get_config().get("plugin.revision-feed.included-statuses", default=[])

    file_repo = FileRepository(db)
    all_entries = []
    for collection_id in collections:
        for file_metadata in file_repo.get_files_by_collection(collection_id):
            if file_metadata.file_type != "tei":
                continue
            content_bytes = file_storage.read_file(file_metadata.id, "tei")
            if not content_bytes:
                continue
            try:
                xml_content = content_bytes.decode("utf-8")
                doc_label = file_metadata.label or file_metadata.doc_id
                all_entries.extend(
                    extract_revision_entries(
                        xml_content,
                        stable_id=file_metadata.stable_id,
                        doc_label=doc_label,
                        collection_id=collection_id,
                        included_statuses=included_statuses,
                    )
                )
            except Exception:
                logger.exception(f"Failed to parse revisions for file {file_metadata.stable_id}")
                continue

    atom_xml = build_atom_feed(
        project_id=project_id,
        project_name=project.get("name") or project_id,
        feed_url=str(request.url),
        entries=all_entries,
        app_base_url=str(request.base_url),
    )

    return Response(content=atom_xml, media_type="application/atom+xml")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full plugin test suite**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/revision_feed/tests`
Expected: PASS (21 tests total across Tasks 1-5)

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/revision_feed/routes.py fastapi_app/plugins/revision_feed/tests/test_routes_feed.py
git commit -m "feat(revision-feed): add public token-authenticated Atom feed route"
```

---

## Task 6: Frontend extension (user menu entry)

**Files:**
- Create: `fastapi_app/plugins/revision_feed/extensions/revision-feed.js`
- Test: `tests/e2e/tests/revision-feed-plugin.spec.js`

- [ ] **Step 1: Write the extension**

```javascript
/**
 * @file Frontend Extension: Revision Feed
 * Adds a "Revision Feeds" entry to the user menu. Shows the user's
 * per-project Atom feed URLs (token-authenticated) and lets them
 * regenerate their feed token.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class RevisionFeedExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'revision-feed', deps: ['dialog'] });
  }

  static extensionPoints = ['toolbar.menuItems'];

  /** @type {HTMLElement} */
  #menuItem = null;

  /** @type {HTMLElement} */
  #dialog = null;

  /** @type {HTMLElement} */
  #feedList = null;

  /**
   * @param {Object} state - Initial application state
   */
  async install(state) {
    await super.install(state);

    this.#menuItem = document.createElement('sl-menu-item');
    this.#menuItem.innerHTML = '<sl-icon slot="prefix" name="rss"></sl-icon>Revision Feeds';
    this.#menuItem.dataset.testId = 'revision-feed-menu-item';
    this.#menuItem.addEventListener('click', () => this.#openDialog());

    this.#buildDialog();
  }

  #buildDialog() {
    this.#dialog = document.createElement('sl-dialog');
    this.#dialog.label = 'Revision Feeds';
    this.#dialog.dataset.testId = 'revision-feed-dialog';

    this.#feedList = document.createElement('div');
    this.#dialog.appendChild(this.#feedList);

    const regenerateButton = document.createElement('sl-button');
    regenerateButton.slot = 'footer';
    regenerateButton.variant = 'warning';
    regenerateButton.textContent = 'Regenerate token';
    regenerateButton.dataset.testId = 'revision-feed-regenerate-btn';
    regenerateButton.addEventListener('click', () => this.#regenerateToken());

    const closeButton = document.createElement('sl-button');
    closeButton.slot = 'footer';
    closeButton.variant = 'primary';
    closeButton.textContent = 'Close';
    closeButton.addEventListener('click', () => this.#dialog.hide());

    this.#dialog.appendChild(regenerateButton);
    this.#dialog.appendChild(closeButton);

    document.body.appendChild(this.#dialog);
  }

  async #openDialog() {
    const data = await this.callPluginApi('/api/plugins/revision-feed/my-feeds');
    this.#renderFeeds(data.feeds);
    this.#dialog.show();
  }

  async #regenerateToken() {
    const data = await this.callPluginApi('/api/plugins/revision-feed/token/regenerate', 'POST');
    this.#renderFeeds(data.feeds);
    this.getDependency('dialog').info('Feed token regenerated. Previous feed URLs no longer work.');
  }

  /**
   * @param {Array<{project_id: string, project_name: string, url: string}>} feeds
   */
  #renderFeeds(feeds) {
    this.#feedList.innerHTML = '';

    if (feeds.length === 0) {
      const empty = document.createElement('p');
      empty.dataset.testId = 'revision-feed-empty-message';
      empty.textContent = 'You are not a member of any project yet.';
      this.#feedList.appendChild(empty);
      return;
    }

    for (const feed of feeds) {
      const row = document.createElement('div');
      row.style.marginBottom = '0.75rem';

      const label = document.createElement('div');
      label.textContent = feed.project_name;
      label.style.fontWeight = 'bold';

      const input = document.createElement('sl-input');
      input.value = feed.url;
      input.readonly = true;
      input.dataset.testId = `revision-feed-url-${feed.project_id}`;

      const copyButton = document.createElement('sl-button');
      copyButton.slot = 'suffix';
      copyButton.size = 'small';
      copyButton.innerHTML = '<sl-icon name="clipboard"></sl-icon>';
      copyButton.addEventListener('click', async () => {
        await navigator.clipboard.writeText(feed.url);
        this.getDependency('dialog').info('Feed URL copied to clipboard.');
      });
      input.appendChild(copyButton);

      row.appendChild(label);
      row.appendChild(input);
      this.#feedList.appendChild(row);
    }
  }

  /**
   * Extension point handler for `toolbar.menuItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's user-menu contribution.
   * Delegates to {@link RevisionFeedExtension#getMenuItems}.
   * @returns {Array<{element: HTMLElement}>}
   */
  ['toolbar.menuItems']() {
    return this.getMenuItems();
  }

  /**
   * @returns {Array<{element: HTMLElement}>}
   */
  getMenuItems() {
    return [{ element: this.#menuItem }];
  }
}
```

- [ ] **Step 2: Write the E2E test**

```javascript
/**
 * Revision Feed Plugin E2E Tests
 *
 * @testCovers fastapi_app/plugins/revision_feed/extensions/revision-feed.js
 * @testCovers fastapi_app/plugins/revision_feed/routes.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { performLogin } from './helpers/login-helper.js';

test.describe('Revision Feed Plugin', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await performLogin(page);
  });

  test('Revision Feeds menu item exists in user menu', async ({ page }) => {
    await page.waitForTimeout(1000);
    const menuItem = page.locator('[data-test-id="revision-feed-menu-item"]');
    await expect(menuItem).toBeAttached();
  });

  test('Clicking the menu item opens the feed dialog', async ({ page }) => {
    await page.waitForTimeout(1000);

    await page.locator('[data-test-id="revision-feed-menu-item"]').click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-test-id="revision-feed-dialog"]');
    await expect(dialog).toBeVisible();

    // Either at least one feed URL input, or the "no projects" message —
    // depends on the logged-in test user's project membership fixture data.
    const hasFeedRow = await page.locator('[data-test-id^="revision-feed-url-"]').count();
    const hasEmptyMessage = await page.locator('[data-test-id="revision-feed-empty-message"]').count();
    expect(hasFeedRow + hasEmptyMessage).toBeGreaterThan(0);
  });

  test('Feed endpoint rejects an invalid token', async ({ page }) => {
    const response = await page.request.get(
      '/api/plugins/revision-feed/feed/some-project.atom?token=not-a-real-token'
    );
    expect(response.status()).toBe(401);
  });

});
```

- [ ] **Step 3: Run the E2E test**

Run: `node tests/e2e-runner.js tests/e2e/tests/revision-feed-plugin.spec.js`
Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/plugins/revision_feed/extensions/ tests/e2e/tests/revision-feed-plugin.spec.js
git commit -m "feat(revision-feed): add user-menu frontend extension"
```

---

## Task 7: Full suite and docs cross-check

**Files:**
- Modify (if gaps found): `docs/code-assistant/backend-plugins.md` (only if this plan's `value_type="array"` usage surfaces an undocumented edge case)

- [ ] **Step 1: Run full unit test suite**

Run: `npm run test:unit`
Expected: PASS (same baseline as before, plus the ~20 new revision-feed unit tests; the one pre-existing `test_uses_cached_script_when_source_missing` failure is unrelated and was already failing before this branch)

- [ ] **Step 2: Run full E2E suite**

Run: `npm run test:e2e`
Expected: PASS, including the 3 new `revision-feed-plugin.spec.js` tests

- [ ] **Step 3: Verify plugin loads in a real dev server (manual spot check)**

Since the dev server auto-reloads and must not be restarted by the agent, ask the user to confirm (or use `node scripts/dev/debug-api.js GET /api/v1/plugins`) that `revision-feed` appears in the plugin list with no load errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test(revision-feed): verify full suite passes"
```

- [ ] **Step 5: Hand off**

Report back: implementation complete on branch `worktree-revision-feed-plugin`, all tests passing, ready for `superpowers:finishing-a-development-branch` to decide on PR/merge.
