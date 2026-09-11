# Collection Coverage Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `collection-overview` backend plugin: a cross-collection table showing gold-standard coverage and lifecycle progress for every collection × annotation-variant combination a user can access, with a deep link into `annotation-progress` per row.

**Architecture:** Extend the existing (currently unused) `fastapi_app/lib/services/statistics.py` with `gold_count`, `get_collection_variants()`, and `build_overview_rows()`. A new plugin (`fastapi_app/plugins/collection_overview/`) exposes `/view` (a static HTML shell), `/data` (JSON the page fetches client-side), and `/export` (CSV). The page itself is plain HTML/CSS/vanilla-JS — no DataTables/jQuery — since it needs a faceted tag-multiselect filter DataTables doesn't provide, and row counts are small.

**Tech Stack:** Python 3 / FastAPI / pytest-style `unittest` / vanilla JS (no build step, served as static files).

**Reference:** `docs/superpowers/specs/2026-09-11-collection-coverage-overview-design.md` (signed off). Follow it for anything this plan doesn't spell out; this plan takes precedence on any conflicting implementation-level detail (e.g. the `/data` JSON-endpoint transport chosen here, over the spec's originally-sketched inline-`<script>` embedding, to match the newer `active_sessions` plugin's convention).

---

## Task 1: `statistics.py` — fix `variant` semantics, add `gold_count`

**Files:**
- Modify: `fastapi_app/lib/services/statistics.py`
- Test: `tests/unit/fastapi/test_statistics.py` (existing file, 12 passing tests — do not break them)

- [ ] **Step 1: Write the two new failing tests**

Append to `tests/unit/fastapi/test_statistics.py`, inside the existing `TestCalculateCollectionStatistics` class (before the final `if __name__ == "__main__":` block):

```python
    def test_gold_count_for_variant(self):
        """gold_count counts distinct doc_ids with an is_gold_standard TEI file, scoped to the variant filter."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        gold = MagicMock()
        gold.doc_id = "doc1"
        gold.file_type = "tei"
        gold.label = "Gold"
        gold.stable_id = "gold1"
        gold.status = "final"
        gold.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        gold.variant = "variant-a"
        gold.is_gold_standard = True

        pdf2 = MagicMock()
        pdf2.doc_id = "doc2"
        pdf2.file_type = "pdf"

        draft = MagicMock()
        draft.doc_id = "doc2"
        draft.file_type = "tei"
        draft.label = "Draft"
        draft.stable_id = "draft1"
        draft.status = "draft"
        draft.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        draft.variant = "variant-a"
        draft.is_gold_standard = False

        self.file_repo.get_files_by_collection.return_value = [pdf, gold, pdf2, draft]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant="variant-a",
            lifecycle_order=self.lifecycle_order,
        )

        self.assertEqual(result["gold_count"], 1)

    def test_none_variant_matches_untagged_only(self):
        """variant=None now means 'untagged only', not 'every variant' (that's variant='all')."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tagged = MagicMock()
        tagged.doc_id = "doc1"
        tagged.file_type = "tei"
        tagged.label = "Tagged"
        tagged.stable_id = "tagged1"
        tagged.status = "draft"
        tagged.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tagged.variant = "grobid"
        tagged.is_gold_standard = False

        untagged = MagicMock()
        untagged.doc_id = "doc1"
        untagged.file_type = "tei"
        untagged.label = "Untagged"
        untagged.stable_id = "untagged1"
        untagged.status = "final"
        untagged.updated_at = datetime(2024, 1, 16, 10, 0, 0)
        untagged.variant = None
        untagged.is_gold_standard = False

        self.file_repo.get_files_by_collection.return_value = [pdf, tagged, untagged]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order,
        )

        self.assertEqual(result["total_annotations"], 1)
        self.assertEqual(
            result["doc_annotations"]["doc1"][0]["annotation_label"], "Untagged"
        )
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics -v`
Expected: `test_gold_count_for_variant` FAILs with `KeyError: 'gold_count'`; `test_none_variant_matches_untagged_only` FAILs because `total_annotations` is `2` (both files currently included when `variant=None`), not `1`. All 12 pre-existing tests still PASS.

- [ ] **Step 3: Implement — read the current file, then apply these two changes**

Read `fastapi_app/lib/services/statistics.py` first. Replace the variant-filtering block and the return statement inside `calculate_collection_statistics`:

Replace:
```python
    # Filter by variant if specified
    if variant and variant not in ("all", ""):
        tei_files = [
            f for f in tei_files if getattr(f, "variant", None) == variant
        ]
```

With:
```python
    # Filter by variant. "all" means no filter (every variant, tagged or not) -
    # kept exactly as before. None/"" now means "untagged only" (previously
    # grouped with "all" - see docs/superpowers/specs/2026-09-11-collection-coverage-overview-design.md).
    if variant == "all":
        pass
    elif variant:
        tei_files = [
            f for f in tei_files if getattr(f, "variant", None) == variant
        ]
    else:
        tei_files = [f for f in tei_files if not getattr(f, "variant", None)]
```

Replace the `annotation_info` dict construction:
```python
        annotation_info = {
            "annotation_label": file_metadata.label or "Untitled",
            "stable_id": file_metadata.stable_id,
            "status": file_metadata.status or "",
            "updated_at": file_metadata.updated_at,
        }
```

With:
```python
        annotation_info = {
            "annotation_label": file_metadata.label or "Untitled",
            "stable_id": file_metadata.stable_id,
            "status": file_metadata.status or "",
            "updated_at": file_metadata.updated_at,
            "is_gold_standard": file_metadata.is_gold_standard,
        }
```

Replace the final `return` statement:
```python
    return {
        "total_docs": total_docs,
        "total_annotations": total_annotations,
        "avg_progress": avg_progress,
        "stage_counts": stage_counts,
        "doc_annotations": doc_annotations,
    }
```

With:
```python
    gold_doc_ids = {
        doc_id
        for doc_id, anns in doc_annotations.items()
        if any(a["is_gold_standard"] for a in anns)
    }

    return {
        "total_docs": total_docs,
        "total_annotations": total_annotations,
        "avg_progress": avg_progress,
        "stage_counts": stage_counts,
        "doc_annotations": doc_annotations,
        "gold_count": len(gold_doc_ids),
    }
```

- [ ] **Step 4: Run all statistics tests to verify they pass**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics -v`
Expected: all 14 tests PASS (12 original + 2 new).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/services/statistics.py tests/unit/fastapi/test_statistics.py
git commit -m "$(cat <<'EOF'
feat(statistics): add gold_count and clarify variant=None as untagged-only

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `get_collection_variants()`

**Files:**
- Modify: `fastapi_app/lib/services/statistics.py`
- Test: `tests/unit/fastapi/test_statistics.py`

- [ ] **Step 1: Write the failing tests**

Append a new test class to `tests/unit/fastapi/test_statistics.py` (before `if __name__ == "__main__":`), and add the import at the top of the file (change the existing import line):

```python
from fastapi_app.lib.services.statistics import (
    calculate_collection_statistics,
    get_collection_variants,
)
```

```python
class TestGetCollectionVariants(unittest.TestCase):
    """Test cases for get_collection_variants function."""

    def setUp(self):
        self.file_repo = MagicMock()

    def test_distinct_variants_sorted_with_none_first(self):
        pdf = MagicMock(file_type="pdf", variant=None)
        tei_a = MagicMock(file_type="tei", variant="llamore")
        tei_b = MagicMock(file_type="tei", variant="grobid")
        tei_c = MagicMock(file_type="tei", variant=None)
        self.file_repo.get_files_by_collection.return_value = [pdf, tei_a, tei_b, tei_c]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None, "grobid", "llamore"])

    def test_empty_string_variant_normalized_to_none(self):
        tei = MagicMock(file_type="tei", variant="")
        self.file_repo.get_files_by_collection.return_value = [tei]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None])

    def test_no_tei_files_returns_none_bucket(self):
        """A collection with only PDFs (no annotations yet) still produces one row."""
        pdf = MagicMock(file_type="pdf", variant=None)
        self.file_repo.get_files_by_collection.return_value = [pdf]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None])

    def test_no_files_at_all_returns_none_bucket(self):
        self.file_repo.get_files_by_collection.return_value = []

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None])
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics -v`
Expected: FAIL with `ImportError: cannot import name 'get_collection_variants'`.

- [ ] **Step 3: Implement**

Append to `fastapi_app/lib/services/statistics.py` (after `calculate_collection_statistics`):

```python
def get_collection_variants(file_repo: FileRepository, collection_id: str) -> list[Optional[str]]:
    """
    Distinct variant values among a collection's TEI files, untagged (None) first.

    Args:
        file_repo: FileRepository instance for database access
        collection_id: Collection ID to inspect

    Returns:
        Sorted list of variant values (None represents "no variant tag").
        Always contains at least [None], even if the collection has no TEI
        files yet, so every collection produces at least one overview row.
    """
    files = file_repo.get_files_by_collection(collection_id)
    variants = {f.variant for f in files if f.file_type == "tei"}
    normalized = {v if v else None for v in variants}
    ordered = sorted(normalized, key=lambda v: (v is not None, v or ""))
    return ordered or [None]
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics -v`
Expected: all tests PASS (14 + 4 new = 18).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/services/statistics.py tests/unit/fastapi/test_statistics.py
git commit -m "$(cat <<'EOF'
feat(statistics): add get_collection_variants()

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `build_overview_rows()`

**Files:**
- Modify: `fastapi_app/lib/services/statistics.py`
- Test: `tests/unit/fastapi/test_statistics.py`

- [ ] **Step 1: Write the failing tests**

Update the import at the top of `tests/unit/fastapi/test_statistics.py` once more:

```python
from fastapi_app.lib.services.statistics import (
    build_overview_rows,
    calculate_collection_statistics,
    get_collection_variants,
)
```

Append a new test class:

```python
class TestBuildOverviewRows(unittest.TestCase):
    """Test cases for build_overview_rows function."""

    def setUp(self):
        self.file_repo = MagicMock()
        self.lifecycle_order = ["draft", "final"]

    def test_one_row_per_collection_variant(self):
        def files_for(collection_id, include_deleted=False):
            if collection_id == "coll-a":
                return [
                    MagicMock(doc_id="doc1", file_type="pdf", variant=None),
                    MagicMock(
                        doc_id="doc1", file_type="tei", variant="grobid",
                        label="A", stable_id="s1", status="draft",
                        updated_at=datetime(2024, 1, 1), is_gold_standard=False,
                    ),
                ]
            return []

        self.file_repo.get_files_by_collection.side_effect = files_for

        rows = build_overview_rows(
            self.file_repo,
            [{"id": "coll-a", "name": "Collection A"}],
            self.lifecycle_order,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["collection_id"], "coll-a")
        self.assertEqual(rows[0]["collection_name"], "Collection A")
        self.assertEqual(rows[0]["variant"], "grobid")
        self.assertEqual(rows[0]["total_docs"], 1)

    def test_multiple_variants_produce_multiple_rows(self):
        def files_for(collection_id, include_deleted=False):
            return [
                MagicMock(doc_id="doc1", file_type="pdf", variant=None),
                MagicMock(
                    doc_id="doc1", file_type="tei", variant="grobid",
                    label="A", stable_id="s1", status="draft",
                    updated_at=datetime(2024, 1, 1), is_gold_standard=False,
                ),
                MagicMock(
                    doc_id="doc1", file_type="tei", variant="llamore",
                    label="B", stable_id="s2", status="final",
                    updated_at=datetime(2024, 1, 2), is_gold_standard=True,
                ),
            ]

        self.file_repo.get_files_by_collection.side_effect = files_for

        rows = build_overview_rows(
            self.file_repo,
            [{"id": "coll-a", "name": "Collection A"}],
            self.lifecycle_order,
        )

        variants = sorted(r["variant"] for r in rows)
        self.assertEqual(variants, ["grobid", "llamore"])

    def test_collection_with_no_tei_files_still_produces_one_row(self):
        self.file_repo.get_files_by_collection.return_value = []

        rows = build_overview_rows(
            self.file_repo,
            [{"id": "coll-empty", "name": "Empty Collection"}],
            self.lifecycle_order,
        )

        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["variant"])
        self.assertEqual(rows[0]["total_docs"], 0)
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics -v`
Expected: FAIL with `ImportError: cannot import name 'build_overview_rows'`.

- [ ] **Step 3: Implement**

Append to `fastapi_app/lib/services/statistics.py`:

```python
def build_overview_rows(
    file_repo: FileRepository,
    collections: list[dict],
    lifecycle_order: list[str],
) -> list[dict]:
    """
    Build one overview row per (collection, variant) combination.

    Args:
        file_repo: FileRepository instance for database access
        collections: List of {"id": ..., "name": ...} dicts, already filtered
            to what the current user can access (e.g. by the caller combining
            fastapi_app.lib.utils.collection_utils.list_collections with
            fastapi_app.lib.permissions.user_utils.get_user_collections)
        lifecycle_order: Ordered list of lifecycle stages for progress calculation

    Returns:
        List of row dicts: collection_id, collection_name, variant, plus every
        field from calculate_collection_statistics (total_docs,
        total_annotations, avg_progress, stage_counts, doc_annotations,
        gold_count).
    """
    rows = []
    for collection in collections:
        collection_id = collection["id"]
        collection_name = collection.get("name") or collection_id
        for variant in get_collection_variants(file_repo, collection_id):
            stats = calculate_collection_statistics(
                file_repo, collection_id, variant, lifecycle_order
            )
            rows.append({
                "collection_id": collection_id,
                "collection_name": collection_name,
                "variant": variant,
                **stats,
            })
    return rows
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics -v`
Expected: all tests PASS (18 + 3 new = 21).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/services/statistics.py tests/unit/fastapi/test_statistics.py
git commit -m "$(cat <<'EOF'
feat(statistics): add build_overview_rows() aggregation entry point

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Scaffold the plugin package + `plugin.py`

**Files:**
- Create: `fastapi_app/plugins/collection_overview/__init__.py`
- Create: `fastapi_app/plugins/collection_overview/plugin.py`
- Create: `fastapi_app/plugins/collection_overview/tests/test_collection_overview.py`

- [ ] **Step 1: Write the failing test**

Create `fastapi_app/plugins/collection_overview/tests/test_collection_overview.py`:

```python
"""
Unit tests for Collection Coverage Overview plugin.

@testCovers fastapi_app/plugins/collection_overview/plugin.py
@testCovers fastapi_app/plugins/collection_overview/routes.py
"""

import asyncio
import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.plugins.collection_overview.plugin import CollectionOverviewPlugin


class TestCollectionOverviewPlugin(unittest.TestCase):
    """Test cases for CollectionOverviewPlugin metadata and endpoint."""

    def setUp(self):
        self.plugin = CollectionOverviewPlugin()

    def test_metadata(self):
        metadata = self.plugin.metadata

        self.assertEqual(metadata["id"], "collection-overview")
        self.assertEqual(metadata["category"], "collection")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertEqual(metadata["dependencies"], ["annotation-progress"])
        self.assertEqual(len(metadata["endpoints"]), 1)

        endpoint = metadata["endpoints"][0]
        self.assertEqual(endpoint["name"], "show_overview")
        self.assertEqual(endpoint["state_params"], [])

    def test_get_endpoints(self):
        endpoints = self.plugin.get_endpoints()

        self.assertIn("show_overview", endpoints)
        self.assertTrue(callable(endpoints["show_overview"]))

    def test_show_overview_returns_urls(self):
        context = MagicMock()

        result = asyncio.run(self.plugin.show_overview(context, {}))

        self.assertEqual(result["outputUrl"], "/api/plugins/collection-overview/view")
        self.assertEqual(result["exportUrl"], "/api/plugins/collection-overview/export")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python -m unittest fastapi_app.plugins.collection_overview.tests.test_collection_overview -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.plugins.collection_overview'`.

- [ ] **Step 3: Write minimal implementation**

Create `fastapi_app/plugins/collection_overview/__init__.py`:

```python
from .plugin import CollectionOverviewPlugin

plugin = CollectionOverviewPlugin()

__all__ = ["CollectionOverviewPlugin"]
```

(The `router` import is added in Task 5, once `routes.py` exists — importing it now would break plugin discovery with a `ModuleNotFoundError`.)

Create `fastapi_app/plugins/collection_overview/plugin.py`:

```python
"""
Collection Coverage Overview Plugin.

Provides a cross-collection overview of gold-standard coverage and annotation
lifecycle progress for every collection/variant combination the current user
can access, with a one-click link into annotation-progress for each one.
"""

from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext


class CollectionOverviewPlugin(Plugin):
    """Plugin that generates a cross-collection annotation coverage overview."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "collection-overview",
            "name": "Collection Coverage Overview",
            "description": "Overview of gold-standard coverage and annotation progress across all accessible collections",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "dependencies": ["annotation-progress"],
            "endpoints": [
                {
                    "name": "show_overview",
                    "label": "Show Collection Coverage",
                    "description": "Overview of gold-standard coverage and annotation progress across all accessible collections",
                    "state_params": [],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_overview": self.show_overview,
        }

    async def show_overview(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Return URLs for the coverage overview view and CSV export.

        This view is not scoped to the currently-open collection/document -
        it spans every collection the user can access - so no state params
        are read from `params`.
        """
        return {
            "outputUrl": "/api/plugins/collection-overview/view",
            "exportUrl": "/api/plugins/collection-overview/export",
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python -m unittest fastapi_app.plugins.collection_overview.tests.test_collection_overview -v`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/collection_overview/__init__.py \
        fastapi_app/plugins/collection_overview/plugin.py \
        fastapi_app/plugins/collection_overview/tests/test_collection_overview.py
git commit -m "$(cat <<'EOF'
feat(collection-overview): scaffold plugin metadata and endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `routes.py` — `/view`, `/data`, `/export`

**Files:**
- Create: `fastapi_app/plugins/collection_overview/routes.py`
- Modify: `fastapi_app/plugins/collection_overview/__init__.py`
- Modify: `fastapi_app/plugins/collection_overview/tests/test_collection_overview.py`

- [ ] **Step 1: Write the failing tests**

Append to `fastapi_app/plugins/collection_overview/tests/test_collection_overview.py` (before `if __name__ == "__main__":`):

```python
class TestCollectionOverviewRoutes(unittest.TestCase):
    """Test cases for the /view, /data, and /export routes."""

    def setUp(self):
        from fastapi_app.plugins.collection_overview.routes import router
        from fastapi_app.lib.core.dependencies import (
            get_auth_manager,
            get_session_manager,
            get_db,
        )

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()
        self.mock_db = MagicMock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.mock_db

        self.client = TestClient(self.app)

    def _mock_settings(self, mock_settings):
        settings_obj = MagicMock()
        settings_obj.session_timeout = 3600
        settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = settings_obj
        return settings_obj

    # -- /data --------------------------------------------------------------

    def test_data_no_session(self):
        response = self.client.get("/api/plugins/collection-overview/data")
        self.assertEqual(response.status_code, 401)
        self.assertIn("Authentication required", response.json()["detail"])

    def test_data_invalid_session(self):
        self.mock_session_manager.is_session_valid.return_value = False

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "invalid"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("Invalid or expired session", response.json()["detail"])

    @patch("fastapi_app.config.get_settings")
    def test_data_no_user(self, mock_settings):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = None

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("User not found", response.json()["detail"])

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_data_scopes_to_accessible_collections(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }

        mock_list_collections.return_value = [
            {"id": "coll-a", "name": "Collection A"},
            {"id": "coll-b", "name": "Collection B"},
        ]
        mock_get_user_collections.return_value = ["coll-a"]

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["lifecycle_order"], ["draft", "final"])
        collection_ids = {row["collection_id"] for row in body["rows"]}
        self.assertEqual(collection_ids, {"coll-a"})

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_data_wildcard_access_includes_all_collections(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "admin", "roles": ["*"],
        }

        mock_list_collections.return_value = [
            {"id": "coll-a", "name": "Collection A"},
            {"id": "coll-b", "name": "Collection B"},
        ]
        mock_get_user_collections.return_value = None  # wildcard access

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        collection_ids = {row["collection_id"] for row in response.json()["rows"]}
        self.assertEqual(collection_ids, {"coll-a", "coll-b"})

    # -- /view ----------------------------------------------------------------

    def test_view_requires_authentication(self):
        response = self.client.get("/api/plugins/collection-overview/view")
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.lib.plugins.plugin_tools.load_plugin_html")
    @patch("fastapi_app.config.get_settings")
    def test_view_success(self, mock_settings, mock_load_html):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }
        mock_load_html.return_value = "<html><body>Coverage Overview</body></html>"

        response = self.client.get(
            "/api/plugins/collection-overview/view",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("Coverage Overview", response.text)

    # -- /export --------------------------------------------------------------

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_export_returns_csv(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }

        mock_list_collections.return_value = [{"id": "coll-a", "name": "Collection A"}]
        mock_get_user_collections.return_value = ["coll-a"]

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/export",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/csv", response.headers["content-type"])
        self.assertIn("Collection ID", response.text)
        self.assertIn("coll-a", response.text)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python -m unittest fastapi_app.plugins.collection_overview.tests.test_collection_overview -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.plugins.collection_overview.routes'`.

- [ ] **Step 3: Write minimal implementation**

Create `fastapi_app/plugins/collection_overview/routes.py`:

```python
"""
Custom routes for the Collection Coverage Overview plugin.
"""

import csv
import io
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_session_manager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/collection-overview", tags=["collection-overview"])


def _authenticate(session_id, x_session_id, session_manager, auth_manager) -> dict:
    """Shared auth check for this plugin's routes. Raises HTTPException on failure."""
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


def _resolve_accessible_collections(user: dict) -> list[dict]:
    """Collections (id + name) the given user can access, per project membership."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.permissions.user_utils import get_user_collections
    from fastapi_app.lib.utils.collection_utils import list_collections

    settings = get_settings()
    all_collections = list_collections(settings.db_dir)
    accessible_ids = get_user_collections(user, settings.db_dir)

    if accessible_ids is None:
        return [{"id": c["id"], "name": c.get("name") or c["id"]} for c in all_collections]

    accessible_set = set(accessible_ids)
    return [
        {"id": c["id"], "name": c.get("name") or c["id"]}
        for c in all_collections
        if c["id"] in accessible_set
    ]


def _build_rows(db, user: dict) -> tuple[list[dict], list[str]]:
    """Resolve accessible collections and build overview rows for them."""
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.services.statistics import build_overview_rows
    from fastapi_app.lib.utils.config_utils import get_config

    file_repo = FileRepository(db)
    lifecycle_order = get_config().get("annotation.lifecycle.order", default=[])
    collections = _resolve_accessible_collections(user)
    rows = build_overview_rows(file_repo, collections, lifecycle_order)
    return rows, lifecycle_order


@router.get("/view", response_class=HTMLResponse)
async def view_overview(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Serve the coverage overview page shell (data is fetched client-side from /data)."""
    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    _authenticate(session_id, x_session_id, session_manager, auth_manager)

    html = load_plugin_html(__file__, "view.html")
    return HTMLResponse(content=html)


@router.get("/data")
async def get_overview_data(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
):
    """Return the collection x variant overview rows as JSON for the view page."""
    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    rows, lifecycle_order = _build_rows(db, user)

    return {
        "lifecycle_order": lifecycle_order,
        "rows": [
            {
                "collection_id": r["collection_id"],
                "collection_name": r["collection_name"],
                "variant": r["variant"],
                "total_docs": r["total_docs"],
                "gold_count": r["gold_count"],
                "avg_progress": r["avg_progress"],
                "stage_counts": r["stage_counts"],
            }
            for r in rows
        ],
    }


@router.get("/export")
async def export_csv(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
):
    """Export the full (unfiltered) overview as CSV."""
    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    rows, lifecycle_order = _build_rows(db, user)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Collection ID", "Collection Name", "Variant", "Documents",
        "Gold Standard Count", "Gold Standard %", "Avg Progress %", "Dominant Stage",
    ])
    for r in rows:
        gold_pct = round((r["gold_count"] / r["total_docs"]) * 100) if r["total_docs"] else 0
        dominant = ""
        best_count = 0
        for stage in lifecycle_order:
            count = r["stage_counts"].get(stage, 0)
            if count > best_count:
                best_count = count
                dominant = stage
        writer.writerow([
            r["collection_id"],
            r["collection_name"],
            r["variant"] or "",
            r["total_docs"],
            r["gold_count"],
            gold_pct,
            round(r["avg_progress"], 1),
            dominant,
        ])

    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="collection-coverage-overview.csv"'},
    )
```

Update `fastapi_app/plugins/collection_overview/__init__.py` to also export the router:

```python
from .plugin import CollectionOverviewPlugin
from .routes import router

plugin = CollectionOverviewPlugin()

__all__ = ["CollectionOverviewPlugin", "router"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python -m unittest fastapi_app.plugins.collection_overview.tests.test_collection_overview -v`
Expected: all tests PASS (3 + 8 new = 11). Note `test_view_success` and the `/data`/`/export` success tests will still fail at this point only if `static/view.html` doesn't exist yet for `load_plugin_html` to find in a *real* (non-mocked) call — but since `load_plugin_html` is mocked in `test_view_success`, and `/data`/`/export` never call it, all 11 tests pass without `static/view.html` existing yet.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/collection_overview/routes.py \
        fastapi_app/plugins/collection_overview/__init__.py \
        fastapi_app/plugins/collection_overview/tests/test_collection_overview.py
git commit -m "$(cat <<'EOF'
feat(collection-overview): add /view, /data, /export routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `static/view.html`, `static/styles.css`, `static/view.js`

**Files:**
- Create: `fastapi_app/plugins/collection_overview/static/view.html`
- Create: `fastapi_app/plugins/collection_overview/static/styles.css`
- Create: `fastapi_app/plugins/collection_overview/static/view.js`

This task has no new automated tests — no existing plugin's `static/*.js` has JS unit tests (checked `annotation_progress`, `edit_history`, `active_sessions`), consistent with the design spec's testing section. Verification is the manual smoke test in Task 7.

- [ ] **Step 1: Create `static/view.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Collection Coverage Overview</title>
  <link rel="stylesheet" href="/api/plugins/collection-overview/static/styles.css">
</head>
<body>
  <header class="page">
    <div>
      <h1>Annotation Coverage Matrix</h1>
      <p>Every collection you can access, broken down by annotation variant — gold-standard coverage and lifecycle progress side by side, so you can see at a glance where work still needs to happen.</p>
    </div>
  </header>

  <div class="filter-bar" id="filterBar">
    <div class="fake-select" data-facet="collection">
      <span class="facet-label">Collection</span>
      <button type="button" class="facet-control" id="ctrl-collection" onclick="toggleFacetPanel('collection')">
        <span class="facet-tags" id="tags-collection"><span class="placeholder">All collections</span></span>
        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="facet-panel" id="panel-collection"></div>
    </div>
    <div class="fake-select" data-facet="variant">
      <span class="facet-label">Variant</span>
      <button type="button" class="facet-control" id="ctrl-variant" onclick="toggleFacetPanel('variant')">
        <span class="facet-tags" id="tags-variant"><span class="placeholder">All variants</span></span>
        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="facet-panel" id="panel-variant"></div>
    </div>
    <button type="button" class="clear-filters" id="clearFilters" hidden onclick="clearFacets()">Clear filters</button>
  </div>

  <div class="stat-row">
    <div class="stat">
      <div class="label">Collections in scope</div>
      <div class="value" id="kpi-collections">—</div>
    </div>
    <div class="stat">
      <div class="label">Documents tracked</div>
      <div class="value" id="kpi-docs">—</div>
    </div>
    <div class="stat">
      <div class="label">Combinations</div>
      <div class="value" id="kpi-combinations">—</div>
    </div>
    <div class="stat flag">
      <div class="label">Rows needing attention</div>
      <div class="value" id="kpi-attention">—</div>
    </div>
  </div>

  <div class="toolbar">
    <h2>Collection × Variant</h2>
    <label class="toggle" id="attnToggle" onclick="toggleAttention(event)">
      <input type="checkbox" id="attnCheck">
      Show needs-attention only
    </label>
  </div>

  <div id="app">
    <div class="table-wrap">
      <table id="matrix">
        <thead>
          <tr>
            <th onclick="sortBy(0,this)">Collection <span class="arrow">▾</span></th>
            <th onclick="sortBy(1,this)">Variant <span class="arrow">▾</span></th>
            <th onclick="sortBy(2,this)" data-num>Documents <span class="arrow">▾</span></th>
            <th onclick="sortBy(3,this)" data-num>Gold standard <span class="arrow">▾</span></th>
            <th onclick="sortBy(4,this)" data-num>Progress <span class="arrow">▾</span></th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <footer class="legend" id="legend">
    <span class="scale-legend">
      <span id="legend-start">—</span><span class="ramp" id="legend-ramp"></span><span id="legend-end">—</span>
    </span>
  </footer>

  <script type="module" src="/api/plugins/collection-overview/static/view.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `static/styles.css`**

```css
:root{
  --bg:#F5F6F9;
  --surface:#FFFFFF;
  --surface-2:#FBFBFD;
  --border:#E1E4EA;
  --border-strong:#CBCFD9;
  --text:#1C222D;
  --text-muted:#5B6472;
  --text-faint:#8991A0;
  --accent:#2E6E76;
  --accent-soft:#E4EFEE;
  --good:#3E8F5C;
  --warn:#B9791A;
  --warn-soft:#FBF0DE;
  --track:#E7E9EE;
  --row-hover:#F1F4F6;
  --shadow: 0 1px 2px rgba(20,24,32,.04), 0 6px 16px rgba(20,24,32,.05);
}
*{box-sizing:border-box;}
body{
  background:var(--bg);
  color:var(--text);
  font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  margin:0;
  padding:24px clamp(16px,4vw,40px) 48px;
}
h1,h2{margin:0;}
.num{font-variant-numeric: tabular-nums;}

header.page{margin-bottom:22px;}
header.page h1{font-size:22px; font-weight:700; margin:0 0 6px;}
header.page p{margin:0; color:var(--text-muted); font-size:13.5px; max-width:64ch;}

.filter-bar{display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; margin-bottom:18px;}
.fake-select{position:relative; display:flex; flex-direction:column; gap:5px; width:260px;}
.facet-label{font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); font-weight:600;}
.facet-control{
  display:flex; align-items:center; gap:8px; min-height:38px;
  background:var(--surface); border:1px solid var(--border); border-radius:8px;
  padding:5px 8px 5px 10px; cursor:pointer; box-shadow:var(--shadow);
}
.facet-control:hover{border-color:var(--border-strong);}
.facet-control.open{border-color:var(--accent);}
.facet-tags{display:flex; flex-wrap:wrap; gap:5px; flex:1;}
.facet-tags .placeholder{color:var(--text-faint); font-size:13px;}
.tag-chip{
  display:inline-flex; align-items:center; gap:5px; background:var(--accent-soft);
  color:var(--accent); border-radius:5px; padding:3px 6px 3px 9px; font-size:12px;
  font-weight:500; white-space:nowrap;
}
.tag-chip button{border:0; background:transparent; color:inherit; cursor:pointer; padding:0 1px; display:flex; font-size:14px; line-height:1; opacity:.75;}
.tag-chip button:hover{opacity:1;}
.facet-control .chevron{flex:none; color:var(--text-faint); transition:transform .15s;}
.facet-control.open .chevron{transform:rotate(180deg);}
.facet-panel{
  position:absolute; top:calc(100% + 4px); left:0; right:0;
  background:var(--surface); border:1px solid var(--border); border-radius:8px;
  box-shadow:var(--shadow); z-index:5; max-height:260px; overflow:auto; padding:6px; display:none;
}
.facet-panel.open{display:block;}
.facet-option{display:flex; align-items:center; gap:9px; padding:7px 8px; border-radius:6px; cursor:pointer; font-size:13px;}
.facet-option:hover{background:var(--row-hover);}
.facet-option input{accent-color:var(--accent); width:14px; height:14px; flex:none;}
.facet-option .opt-label{flex:1;}
.facet-option .opt-count{color:var(--text-faint); font-size:11px;}
.clear-filters{align-self:center; border:0; background:transparent; color:var(--accent); font-size:12.5px; font-weight:600; cursor:pointer; padding:8px 2px;}
.clear-filters:hover{text-decoration:underline;}

.stat-row{display:grid; grid-template-columns:repeat(auto-fit, minmax(180px,1fr)); gap:12px; margin-bottom:22px;}
.stat{background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px; box-shadow:var(--shadow);}
.stat .label{font-size:11.5px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px;}
.stat .value{font-size:22px; font-weight:700;}
.stat.flag .value{color:var(--warn);}

.toolbar{display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:10px;}
.toolbar h2{font-size:15px; font-weight:700; margin:0; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em;}
.toggle{display:inline-flex; align-items:center; gap:7px; cursor:pointer; user-select:none; font-size:13px; color:var(--text-muted); border:1px solid var(--border); background:var(--surface); border-radius:99px; padding:6px 12px 6px 8px;}
.toggle input{accent-color:var(--warn);}
.toggle.on{border-color:var(--warn); color:var(--warn); background:var(--warn-soft);}

.table-wrap{background:var(--surface); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow); overflow:auto;}
table{width:100%; border-collapse:collapse; font-size:13.5px; min-width:820px;}
thead th{position:sticky; top:0; background:var(--surface-2); z-index:1; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); font-weight:600; padding:11px 14px; border-bottom:1px solid var(--border); white-space:nowrap; cursor:pointer;}
thead th .arrow{opacity:.35; margin-left:4px; font-size:10px;}
thead th.sorted .arrow{opacity:1; color:var(--accent);}
tbody td{padding:11px 14px; border-bottom:1px solid var(--border); vertical-align:middle;}
tbody tr:last-child td{border-bottom:0;}
tbody tr:hover{background:var(--row-hover);}
tbody tr.attention{background:linear-gradient(90deg, var(--warn-soft), transparent 40%);}

.coll{font-weight:600;}
.coll .sub{display:block; font-size:11.5px; color:var(--text-faint); font-weight:400; margin-top:1px;}
.variant-pill{display:inline-block; font-size:11.5px; padding:2px 8px; border-radius:6px; background:var(--accent-soft); color:var(--accent);}
.variant-pill.none{background:transparent; border:1px dashed var(--border-strong); color:var(--text-faint);}

.gold{display:flex; align-items:center; gap:9px;}
.gold .frac{font-size:12.5px; white-space:nowrap; min-width:48px;}
.gold .bar{flex:1; height:6px; border-radius:99px; background:var(--track); min-width:64px; overflow:hidden;}
.gold .bar > span{display:block; height:100%; background:var(--good); border-radius:99px 0 0 99px;}
.gold.low .frac{color:var(--warn); font-weight:600;}
.gold.low .bar > span{background:var(--warn);}

.stages{display:flex; align-items:center; gap:10px; min-width:230px;}
.stages .progress-num{font-size:13px; font-weight:600; min-width:34px; text-align:right;}
.stages .bar-col{display:flex; flex-direction:column; gap:5px; flex:1;}
.stages .seg-bar{display:flex; height:8px; border-radius:99px; overflow:hidden; background:var(--track); gap:2px;}
.stages .seg-bar span{height:100%; min-width:2px;}
.stages .seg-bar.empty span{background:var(--track);}
.stages .dominant{font-size:11.5px; color:var(--text-muted); display:flex; align-items:center; gap:5px;}
.stages .dot{width:7px; height:7px; border-radius:50%; flex:none;}

.scale-legend{display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text-faint);}
.scale-legend .ramp{width:96px; height:6px; border-radius:99px;}

.action a{display:inline-flex; align-items:center; gap:5px; font-size:12.5px; font-weight:600; color:var(--accent); text-decoration:none; white-space:nowrap; padding:6px 10px; border-radius:7px; border:1px solid var(--border); background:var(--surface-2);}
.action a:hover{border-color:var(--accent); background:var(--accent-soft);}
.action a:focus-visible{outline:2px solid var(--accent); outline-offset:2px;}

footer.legend{display:flex; flex-wrap:wrap; gap:14px 20px; margin-top:16px; font-size:11.5px; color:var(--text-faint);}

.error{color:var(--warn); padding:24px; text-align:center;}
```

- [ ] **Step 3: Create `static/view.js`**

```js
/**
 * Collection Coverage Overview — client logic.
 *
 * Fetches the aggregated collection x variant rows from /data, then renders
 * KPI tiles, the faceted filter bar, and the sortable coverage table
 * entirely client-side (row counts are small - a few dozen at most - so no
 * pagination/virtualization library is needed).
 */

const sessionId = new URLSearchParams(window.location.search).get('session_id') || '';

let ROWS = [];
let LIFECYCLE_ORDER = [];
let STAGE_COLORS = [];
const facetState = { collection: new Set(), variant: new Set() };
let attentionOnly = false;
let sortState = { col: null, dir: 1 };

const ATTENTION_PROGRESS_THRESHOLD = 45;

// -- Ordinal color ramp ------------------------------------------------------
// Lifecycle stage is a position in an ordered sequence, not an identity, so
// it takes a single-hue OKLCH ramp (monotone lightness) rather than one hue
// per stage. These parameters were validated with the dataviz skill's
// validate_palette.js --ordinal (adjacent ΔL >= 0.06, light-end contrast
// >= 2:1 on white, single hue) for 8 stages. The ramp is generated at
// runtime - not hardcoded - so it always matches the server's configured
// annotation.lifecycle.order, however many stages that has.
const RAMP_HUE = 195;
const RAMP_CHROMA = 0.095;
const RAMP_L_START = 0.72; // least progress
const RAMP_L_END = 0.20;   // most progress

function oklchToHex(L, C, H) {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const toHex = (c) => {
    const clamped = Math.min(1, Math.max(0, c));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(255 * Math.min(1, Math.max(0, srgb))).toString(16).padStart(2, '0');
  };
  return `#${toHex(rl)}${toHex(gl)}${toHex(bl)}`;
}

function buildStageRamp(n) {
  if (n <= 1) return [oklchToHex(0.46, RAMP_CHROMA, RAMP_HUE)];
  const ramp = [];
  for (let i = 0; i < n; i++) {
    const L = RAMP_L_START + ((RAMP_L_END - RAMP_L_START) * i) / (n - 1);
    ramp.push(oklchToHex(L, RAMP_CHROMA, RAMP_HUE));
  }
  return ramp;
}

function stageColor(i) { return STAGE_COLORS[i] || '#888888'; }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// -- Data loading -------------------------------------------------------------

async function loadData() {
  const res = await fetch('/api/plugins/collection-overview/data', {
    headers: { 'X-Session-ID': sessionId },
  });
  if (!res.ok) {
    document.getElementById('app').innerHTML = `<p class="error">Failed to load coverage data (${res.status}).</p>`;
    return;
  }
  const data = await res.json();
  ROWS = data.rows;
  LIFECYCLE_ORDER = data.lifecycle_order;
  STAGE_COLORS = buildStageRamp(LIFECYCLE_ORDER.length);

  renderLegend();
  renderKpis();
  renderFacetPanel('collection');
  renderFacetPanel('variant');
  render();
}

function renderLegend() {
  document.getElementById('legend-start').textContent = LIFECYCLE_ORDER[0] || '';
  document.getElementById('legend-end').textContent = LIFECYCLE_ORDER[LIFECYCLE_ORDER.length - 1] || '';
  document.getElementById('legend-ramp').style.background = `linear-gradient(90deg, ${STAGE_COLORS.join(',')})`;
}

// -- Derived per-row values ---------------------------------------------------

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function dominantStage(stageCounts) {
  let best = null, bestCount = 0;
  LIFECYCLE_ORDER.forEach((name) => {
    const n = stageCounts[name] || 0;
    if (n > bestCount) { best = name; bestCount = n; }
  });
  return best;
}

function avgProgressFromRow(row) { return Math.round(row.avg_progress); }

function isAttention(row) {
  return avgProgressFromRow(row) < ATTENTION_PROGRESS_THRESHOLD || !dominantStage(row.stage_counts);
}

function variantLabel(variant) { return variant || '— none —'; }

// -- KPI tiles ------------------------------------------------------------

function renderKpis() {
  const distinctCollections = new Map();
  ROWS.forEach((r) => {
    if (!distinctCollections.has(r.collection_id)) {
      distinctCollections.set(r.collection_id, r.total_docs);
    }
  });
  const totalDocs = [...distinctCollections.values()].reduce((a, b) => a + b, 0);
  const needsAttention = ROWS.filter(isAttention).length;

  document.getElementById('kpi-collections').textContent = distinctCollections.size;
  document.getElementById('kpi-docs').textContent = totalDocs;
  document.getElementById('kpi-combinations').textContent = ROWS.length;
  document.getElementById('kpi-attention').textContent = `${needsAttention} / ${ROWS.length}`;
}

// -- Table rendering --------------------------------------------------------

function stageSegBar(row) {
  const docs = row.total_docs;
  const counts = row.stage_counts;
  const total = LIFECYCLE_ORDER.reduce((sum, name) => sum + (counts[name] || 0), 0);
  if (!docs || !total) {
    return '<span class="seg-bar empty"><span style="width:100%"></span></span>';
  }
  const segs = LIFECYCLE_ORDER.map((name, i) => {
    const n = counts[name] || 0;
    if (!n) return '';
    const share = (n / docs) * 100;
    return `<span title="${name}: ${n} of ${docs} documents (${Math.round(share)}%)" style="width:${share.toFixed(2)}%;background:${stageColor(i)}"></span>`;
  }).join('');
  return `<span class="seg-bar">${segs}</span>`;
}

function renderRow(row) {
  const goldPct = pct(row.gold_count, row.total_docs);
  const progress = avgProgressFromRow(row);
  const dom = dominantStage(row.stage_counts);
  const domIdx = dom ? LIFECYCLE_ORDER.indexOf(dom) : -1;
  const attention = isAttention(row);
  const noStatus = row.stage_counts['no-status'] || 0;
  const variantPill = row.variant
    ? `<span class="variant-pill">${escapeHtml(row.variant)}</span>`
    : `<span class="variant-pill none">— none —</span>`;
  const progressUrl = `/api/plugins/annotation-progress/view?collection=${encodeURIComponent(row.collection_id)}` +
    (row.variant ? `&variant=${encodeURIComponent(row.variant)}` : '');

  return `<tr class="${attention ? 'attention' : ''}" data-attn="${attention ? 1 : 0}"
            data-collection="${escapeHtml(row.collection_id)}" data-variant="${row.variant ? escapeHtml(row.variant) : '__none__'}">
    <td class="coll">${escapeHtml(row.collection_name)}<span class="sub">${escapeHtml(row.collection_id)}</span></td>
    <td>${variantPill}</td>
    <td class="num">${row.total_docs}</td>
    <td>
      <div class="gold ${goldPct < 50 ? 'low' : ''}">
        <span class="frac num">${row.gold_count}/${row.total_docs}</span>
        <span class="bar"><span style="width:${goldPct}%"></span></span>
      </div>
    </td>
    <td>
      <div class="stages">
        <span class="progress-num" style="color:${dom ? stageColor(domIdx) : 'var(--text-faint)'}">${dom ? progress + '%' : '—'}</span>
        <div class="bar-col">
          ${stageSegBar(row)}
          <div class="dominant">
            ${dom
              ? `<span class="dot" style="background:${stageColor(domIdx)}"></span><span>mostly ${escapeHtml(dom)}${noStatus > 0 ? ` · ${noStatus} no status` : ''}</span>`
              : `<span class="dot" style="background:var(--track)"></span><span>no status yet</span>`}
          </div>
        </div>
      </div>
    </td>
    <td class="action">
      <a href="#" onclick="event.preventDefault(); sandbox.navigateIframe('${progressUrl}');" title="Open Annotation Progress for ${escapeHtml(row.collection_name)} / ${row.variant ? escapeHtml(row.variant) : 'default'}">
        Open progress
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>
    </td>
  </tr>`;
}

function render() {
  document.getElementById('rows').innerHTML = ROWS.map(renderRow).join('');
  applyFilters();
}

// -- Sorting ---------------------------------------------------------------

function sortBy(col, th) {
  const numeric = th.hasAttribute('data-num');
  document.querySelectorAll('thead th').forEach((h) => h.classList.remove('sorted'));
  th.classList.add('sorted');
  sortState.dir = sortState.col === col ? -sortState.dir : 1;
  sortState.col = col;
  const getters = [
    (r) => r.collection_name,
    (r) => r.variant || '',
    (r) => r.total_docs,
    (r) => pct(r.gold_count, r.total_docs),
    (r) => avgProgressFromRow(r),
  ];
  ROWS.sort((a, b) => {
    const av = getters[col](a), bv = getters[col](b);
    if (numeric) return (av - bv) * sortState.dir;
    return String(av).localeCompare(String(bv)) * sortState.dir;
  });
  render();
}
window.sortBy = sortBy;

// -- Faceted filters ---------------------------------------------------------
// Stand-in for <sl-select multiple> (tag-format): a plain HTML/CSS/JS control,
// not the real Shoelace component, since this page is a standalone document
// outside the app's Shoelace bundle. Within a facet, checked values are OR'd;
// across facets, AND'd. Selecting a collection narrows the Variant facet to
// only variants present in the selected collection(s).

function facetValues(facet, { scopeToCollections } = {}) {
  const seen = new Map();
  ROWS.forEach((r) => {
    if (facet === 'variant' && scopeToCollections && scopeToCollections.size && !scopeToCollections.has(r.collection_id)) {
      return;
    }
    const value = facet === 'collection' ? r.collection_id : (r.variant || '__none__');
    const label = facet === 'collection' ? r.collection_name : variantLabel(r.variant);
    if (!seen.has(value)) seen.set(value, { label, count: 0 });
    seen.get(value).count += 1;
  });
  return [...seen.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
}

function renderFacetPanel(facet) {
  const panel = document.getElementById(`panel-${facet}`);
  const selected = facetState[facet];
  const scoped = facet === 'variant' ? facetState.collection : null;
  panel.innerHTML = facetValues(facet, { scopeToCollections: scoped }).map(([value, { label, count }]) => `
    <label class="facet-option">
      <input type="checkbox" value="${escapeHtml(value)}" ${selected.has(value) ? 'checked' : ''}
             onchange="onFacetToggle('${facet}', '${value}', this.checked)">
      <span class="opt-label">${escapeHtml(label)}</span>
      <span class="opt-count">${count}</span>
    </label>`).join('');
}

function renderFacetTags(facet) {
  const wrap = document.getElementById(`tags-${facet}`);
  const selected = [...facetState[facet]];
  if (!selected.length) {
    wrap.innerHTML = `<span class="placeholder">All ${facet === 'collection' ? 'collections' : 'variants'}</span>`;
    return;
  }
  const values = facetValues(facet);
  wrap.innerHTML = selected.map((value) => {
    const found = values.find(([v]) => v === value);
    const label = found ? found[1].label : value;
    return `<span class="tag-chip">${escapeHtml(label)}<button type="button" onclick="event.stopPropagation(); onFacetToggle('${facet}','${value}', false)">✕</button></span>`;
  }).join('');
}

function onFacetToggle(facet, value, checked) {
  checked ? facetState[facet].add(value) : facetState[facet].delete(value);
  if (facet === 'collection') {
    const offered = new Set(facetValues('variant', { scopeToCollections: facetState.collection }).map(([v]) => v));
    [...facetState.variant].forEach((v) => { if (!offered.has(v)) facetState.variant.delete(v); });
    renderFacetTags('variant');
    renderFacetPanel('variant');
  }
  renderFacetTags(facet);
  renderFacetPanel(facet);
  applyFilters();
}
window.onFacetToggle = onFacetToggle;

function toggleFacetPanel(facet) {
  const isOpen = document.getElementById(`panel-${facet}`).classList.contains('open');
  ['collection', 'variant'].forEach((f) => {
    document.getElementById(`panel-${f}`).classList.remove('open');
    document.getElementById(`ctrl-${f}`).classList.remove('open');
  });
  if (!isOpen) {
    document.getElementById(`panel-${facet}`).classList.add('open');
    document.getElementById(`ctrl-${facet}`).classList.add('open');
  }
}
window.toggleFacetPanel = toggleFacetPanel;

document.addEventListener('click', (e) => {
  if (!e.target.closest('.fake-select')) {
    ['collection', 'variant'].forEach((f) => {
      document.getElementById(`panel-${f}`).classList.remove('open');
      document.getElementById(`ctrl-${f}`).classList.remove('open');
    });
  }
});

function clearFacets() {
  facetState.collection.clear();
  facetState.variant.clear();
  ['collection', 'variant'].forEach((f) => { renderFacetTags(f); renderFacetPanel(f); });
  applyFilters();
}
window.clearFacets = clearFacets;

function toggleAttention() {
  const box = document.getElementById('attnCheck');
  const wrap = document.getElementById('attnToggle');
  attentionOnly = !box.checked;
  box.checked = attentionOnly;
  wrap.classList.toggle('on', attentionOnly);
  applyFilters();
}
window.toggleAttention = toggleAttention;

function applyFilters() {
  const anyFilterActive = facetState.collection.size || facetState.variant.size;
  document.getElementById('clearFilters').hidden = !anyFilterActive;
  document.querySelectorAll('#rows tr').forEach((tr) => {
    const okCollection = !facetState.collection.size || facetState.collection.has(tr.dataset.collection);
    const okVariant = !facetState.variant.size || facetState.variant.has(tr.dataset.variant);
    const okAttention = !attentionOnly || tr.dataset.attn === '1';
    tr.style.display = okCollection && okVariant && okAttention ? '' : 'none';
  });
}

loadData();
```

- [ ] **Step 4: Run the full plugin test suite once more (static files must not break route tests)**

Run: `uv run python -m unittest fastapi_app.plugins.collection_overview.tests.test_collection_overview -v`
Expected: all 11 tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/collection_overview/static/view.html \
        fastapi_app/plugins/collection_overview/static/styles.css \
        fastapi_app/plugins/collection_overview/static/view.js
git commit -m "$(cat <<'EOF'
feat(collection-overview): add view page, styles, and client logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full-suite regression check and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full statistics + plugin test suites together**

Run: `uv run python -m unittest tests.unit.fastapi.test_statistics fastapi_app.plugins.collection_overview.tests.test_collection_overview -v`
Expected: all tests PASS (21 + 11 = 32).

- [ ] **Step 2: Run the project's fastapi unit test suite to confirm no other test broke**

Run: `npm run test:unit:fastapi`
Expected: exit code 0, no failures (this also re-runs `tests/unit/fastapi/test_statistics.py` and picks up the new plugin's tests via the standard discovery path).

- [ ] **Step 3: Manual smoke test in the running app**

The dev server auto-reloads on file changes — do not start or restart it (per project convention); ask the user to confirm it's running, or use it if already running.

1. Log in to the app in a browser.
2. Open the "Backend Plugins" menu → Collection category → "Show Collection Coverage".
3. Confirm: the KPI row shows real numbers; the table lists one row per collection/variant combination you have access to; a collection with no TEI annotations yet shows a single row with variant "— none —" and `0` for gold standard / progress (its `Documents` count still reflects PDFs already uploaded, since that count comes from all files, not just TEI).
4. Click a Collection facet value, confirm the Variant facet narrows to only variants present in that collection.
5. Click "Open progress" on a row, confirm it navigates the same dialog to the `annotation-progress` view for that collection/variant.
6. Click the export button (if wired to a UI affordance) or fetch `/api/plugins/collection-overview/export` directly and confirm the CSV downloads with the expected columns.

- [ ] **Step 4: Update documentation, if anything learned during smoke-testing contradicts it**

If the manual smoke test surfaces anything not already covered by `docs/code-assistant/backend-plugins.md` or the design spec (e.g. an actual `annotation.lifecycle.order` value different from what's assumed, or a UI quirk in how the dialog opens), update the relevant doc per the project's "Missing or incorrect documentation" rule in the root `CLAUDE.md`.

- [ ] **Step 5: Final commit (only if Step 4 produced doc changes)**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: update backend plugin docs after collection-overview smoke test

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
