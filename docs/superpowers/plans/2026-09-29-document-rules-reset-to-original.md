# Document Rules "Reset to Original" Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Reset to original" on an `interpretation-ref` resource in the document-rules editor dialog re-resolve that resource's `<ref>` element(s) in the open TEI document to what the extractor's current rules configuration would generate today (not just re-fetch whatever URL is already pinned), then delete the resource's overrides as before. `schema`-kind resources keep their current, simpler reset behavior unchanged.

**Architecture:** A new read-only `plan_resource_refresh()` function in `rules_refresh.py` reuses the existing `DocumentRulesProvider.build_editorial_decl_entries()` machinery (already used by the whole-document "Refresh document rules" action) to compute what a resource's refs should be now, matching by `interpretation/@type` category rather than URL. A new reviewer/admin-gated `POST /document-rules/refresh-resource` endpoint exposes this. The frontend calls it, then — only when something changed — mutates the live DOM (`getDomNodesByXpath` + `setAttribute` + `updateEditorFromNode`, the same pattern `xml-annotation-popup.js` already uses) and saves via the existing `saveIfDirty()` auto-save hook, entirely client-side (no new document-write endpoint). Eight existing routes that were only `require_authenticated_user`-gated, relying solely on the frontend menu being hidden from non-reviewers, are switched to `require_reviewer_or_admin` to close that gap.

**Tech Stack:** FastAPI + Pydantic (backend), vanilla JS class-based plugin + CodeMirror-backed `XMLEditor` (frontend), `unittest`/`pytest` (Python tests), Node's built-in `node:test` (JS tests).

**Spec:** `docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md` — read this in full before starting; this plan implements it exactly. Also relevant: `docs/superpowers/specs/2026-09-27-document-rules-registry-design.md` and `docs/superpowers/specs/2026-09-28-document-rules-propose-upstream-design.md`.

---

## Important context (read before starting any task)

- `fastapi_app/lib/doc_rules/rules_refresh.py` already has `_plan_refresh()` (whole-document) — `plan_resource_refresh()` (this plan, Task 1) is a *new*, separate function for one resource. Do not confuse the two or try to merge them; the spec's "Non-goals" section explicitly rules out changing the whole-document action.
- `representative_ref()` lives in `fastapi_app/lib/doc_rules/interpretation_ref_kind.py` (not `rules_refresh.py`). Import it from there — there is no circular import (`interpretation_ref_kind.py` does not import `rules_refresh.py`).
- `AnnotationRuleRefTarget` and `AnnotationRuleRef` are `TypedDict`s defined in `fastapi_app/lib/utils/annotation_rules_utils.py` (lines 302-330). `AnnotationRuleRefTarget` has keys `target: str`, `content_type: Optional[str]`, `subtype: Literal["human", "machine"]`.
- `extract_annotation_rule_refs(xml_string)` (same file) parses a document's current `editorialDecl/interpretation` entries into `list[AnnotationRuleRef]`.
- On the frontend, `document-rules.js`'s `this.#xmlEditor` getter (`get #xmlEditor() { return this.getDependency('xmleditor') }`) returns a `Proxy` (built by `XmlEditorPlugin.getApi()` in `app/src/plugins/xmleditor.js`) wrapping the module-level `NavXmlEditor` instance. `getDomNodesByXpath` and `updateEditorFromNode` are **not** in that Proxy's `pluginMethods` allow-list, so calls fall through transparently to the real module-level `XMLEditor` methods (`app/src/modules/xmleditor.js:989` and `:1109`) — this already works today for other calls like `unfoldByXpath`/`selectByXpath`/`getView` in the same file, and needs **no changes** to `xmleditor.js` or `plugins/xmleditor.js` for this plan. `saveIfDirty` **is** in the allow-list and resolves to the plugin's own `async saveIfDirty()` (`app/src/plugins/xmleditor.js:1011`), which flushes any dirty editor content to the server.
- `app/src/modules/api-client-v1.js` is **hand-maintained** (see its own header comment), not generated. New methods are added by hand, one per route, mirroring the router.
- **Router test gating gotcha (read before Task 2):** `tests/unit/fastapi/test_document_rules_router.py`'s base `DocumentRulesRouterTestCase.setUp()` currently overrides `require_authenticated_user` with a plain `{"username": "alice"}` (no `roles` key). Once 8 routes are switched to `require_reviewer_or_admin` (Task 2), every existing test class that relies on that base fixture for one of those 8 routes will start failing with 403, because `user.get('roles', [])` on a dict with no `roles` key is `[]`. Task 2 includes updating that base fixture's default to include `"roles": ["reviewer"]` so existing "happy path" tests keep passing, plus a new test class asserting 403 for a plain `["user"]` role on each of the 8 routes.

---

## Task 1: `plan_resource_refresh()` in `rules_refresh.py`

**Files:**
- Modify: `fastapi_app/lib/doc_rules/rules_refresh.py`
- Test: `tests/unit/fastapi/test_doc_rules_rules_refresh.py`

This function is read-only (no file write) — it just computes what a single resource's refs should be now, by category-matching the document's existing `editorialDecl` entries against freshly-built ones from the document's `DocumentRulesProvider`.

- [ ] **Step 1: Read the full spec's "Key finding", "Matching an existing resource to its freshly-built entry", and "Backend design" sections** in `docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md` (lines 11-105) before writing any code — they explain *why* category-matching (not URL-matching) is required.

- [ ] **Step 2: Write the failing tests.** Append this new test class to the end of `tests/unit/fastapi/test_doc_rules_rules_refresh.py` (the file already defines `TEI_WITH_PI_AND_DECL`, a `FakeProvider` test double, and imports `register_document_rules_provider`/`unregister_document_rules_provider` from `fastapi_app.lib.doc_rules.rules_providers` — reuse all three, do not redefine them):

```python
from fastapi_app.lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    RefreshTarget,
    ResourceRefreshOutcome,
    perform_refresh,
    plan_resource_refresh,
    preview_refresh,
    resolve_refresh_target,
)


OLD_TARGET = "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg"


class TestPlanResourceRefresh(unittest.TestCase):
    def tearDown(self):
        unregister_document_rules_provider("GROBID")

    def test_unavailable_when_no_provider_registered(self):
        outcome = plan_resource_refresh(TEI_WITH_PI_AND_DECL, OLD_TARGET, cache=mock.MagicMock())
        self.assertEqual(outcome.status, "unavailable")
        self.assertEqual(outcome.refs, [])
        self.assertFalse(outcome.changed)

    def test_not_found_when_url_is_not_a_current_representative_target(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(entries=[]))
        outcome = plan_resource_refresh(
            TEI_WITH_PI_AND_DECL,
            "https://github.com/mpilhlt/fossil/blob/oldsha/docs/UNRELATED.md#x",
            cache=mock.MagicMock(),
        )
        self.assertEqual(outcome.status, "not_found")
        self.assertEqual(outcome.refs, [])

    def test_orphaned_when_category_missing_from_fresh_entries(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(entries=[
            {"category": "footnote-annotation", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/other.md#x",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]))
        outcome = plan_resource_refresh(TEI_WITH_PI_AND_DECL, OLD_TARGET, cache=mock.MagicMock())
        self.assertEqual(outcome.status, "orphaned")
        self.assertEqual(outcome.refs, [])

    def test_ok_with_changed_true_when_target_differs(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(entries=[
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]))
        outcome = plan_resource_refresh(TEI_WITH_PI_AND_DECL, OLD_TARGET, cache=mock.MagicMock())
        self.assertEqual(outcome.status, "ok")
        self.assertTrue(outcome.changed)
        self.assertEqual(
            outcome.refs[0]["target"],
            "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
        )

    def test_ok_with_changed_false_when_refs_are_identical(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(entries=[
            {"category": "primary", "refs": [
                {"target": OLD_TARGET, "content_type": "markdown", "subtype": "human"},
            ]},
        ]))
        outcome = plan_resource_refresh(TEI_WITH_PI_AND_DECL, OLD_TARGET, cache=mock.MagicMock())
        self.assertEqual(outcome.status, "ok")
        self.assertFalse(outcome.changed)
```

Add the `plan_resource_refresh`, `ResourceRefreshOutcome` names to the existing `from fastapi_app.lib.doc_rules.rules_refresh import (...)` block at the top of the file instead of duplicating the import statement, if that import block already exists (it does — merge into it rather than adding a second import line).

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `uv run python -m pytest tests/unit/fastapi/test_doc_rules_rules_refresh.py::TestPlanResourceRefresh -v`
Expected: FAIL (or ERROR) — `ImportError: cannot import name 'plan_resource_refresh'` / `'ResourceRefreshOutcome'`.

- [ ] **Step 4: Implement `ResourceRefreshOutcome` and `plan_resource_refresh()`.**

In `fastapi_app/lib/doc_rules/rules_refresh.py`:

1. Change the `typing` import (currently `from typing import Optional`) to also bring in `Literal`:

```python
from typing import Literal, Optional
```

2. Change the `annotation_rules_utils` import (currently `from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef, extract_annotation_rule_refs`) to also import `AnnotationRuleRefTarget`:

```python
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    extract_annotation_rule_refs,
)
```

3. Add a new import for `representative_ref` (placed after the existing `fastapi_app.lib.doc_rules.rules_providers` import, alphabetically):

```python
from fastapi_app.lib.doc_rules.interpretation_ref_kind import representative_ref
```

4. Append this dataclass and function at the end of the file (after `perform_refresh()`):

```python
@dataclass
class ResourceRefreshOutcome:
    """Result of planning a single resource's <ref> refresh - see plan_resource_refresh()."""

    status: Literal["ok", "unavailable", "not_found", "orphaned"]
    refs: list[AnnotationRuleRefTarget]  # populated only when status == "ok"
    changed: bool                        # populated only when status == "ok"
    message: str


def plan_resource_refresh(tei_content: str, url: str, cache: UrlCache) -> ResourceRefreshOutcome:
    """
    Plan refreshing one interpretation-ref resource's <ref>s to what the
    document's extractor would generate right now, by category-matching
    against a freshly-built entries list - a SHA-pinned ref can never be
    re-resolved to a newer commit from the pinned URL alone; only the
    provider's *configured* source URL (via build_editorial_decl_entries())
    can. See docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md.

    `url` is the resource's current representative ref target, exactly as
    exposed by ResourceDescriptor.url / InterpretationRefKind.discover().
    """
    lookup = get_document_rules_provider_for_document(tei_content)
    if lookup is None:
        return ResourceRefreshOutcome(
            status="unavailable", refs=[], changed=False,
            message="No rule-refresh provider for this document's extractor.",
        )
    variant_id, provider = lookup

    existing_entries = extract_annotation_rule_refs(tei_content)
    old_entry = next(
        (e for e in existing_entries if (rep := representative_ref(e["refs"])) is not None and rep["target"] == url),
        None,
    )
    if old_entry is None:
        return ResourceRefreshOutcome(
            status="not_found", refs=[], changed=False,
            message="This resource was not found in the document's current rules.",
        )

    new_entries = provider.build_editorial_decl_entries(variant_id, cache)
    new_entry = next((e for e in new_entries if e["category"] == old_entry["category"]), None)
    if new_entry is None:
        return ResourceRefreshOutcome(
            status="orphaned", refs=[], changed=False,
            message="This resource's rule configuration no longer exists upstream.",
        )

    changed = new_entry["refs"] != old_entry["refs"]
    return ResourceRefreshOutcome(
        status="ok", refs=new_entry["refs"], changed=changed,
        message="Resource is already up to date." if not changed else "Resource refreshed from upstream.",
    )
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `uv run python -m pytest tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: PASS — all tests in the file, including the 5 new ones and every pre-existing test (confirms no regression to `_plan_refresh`/`preview_refresh`/`perform_refresh`).

- [ ] **Step 6: Run type checking if configured for this file** (check `docs/code-assistant/coding-standards.md` / project pyright config) and fix any type errors before committing.

- [ ] **Step 7: Commit.**

```bash
git add fastapi_app/lib/doc_rules/rules_refresh.py tests/unit/fastapi/test_doc_rules_rules_refresh.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): add plan_resource_refresh() for single-resource ref refresh

Computes what one interpretation-ref resource's <ref>s should be now by
category-matching against a freshly-built entries list from the document's
DocumentRulesProvider - reused by the upcoming /refresh-resource endpoint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `POST /refresh-resource` endpoint + reviewer/admin gating

**Files:**
- Modify: `fastapi_app/lib/models/models_document_rules.py`
- Modify: `fastapi_app/routers/document_rules.py`
- Test: `tests/unit/fastapi/test_document_rules_router.py`

- [ ] **Step 1: Read the full existing `tests/unit/fastapi/test_document_rules_router.py` file** before making any change. Confirm which test classes rely on the base `DocumentRulesRouterTestCase.setUp()`'s `require_authenticated_user` override (as opposed to setting their own, like `TestRefreshEndpoints` already does via its own `_set_user_roles()` helper) — every one of those classes is about to be affected by Step 4 below.

- [ ] **Step 2: Add the new Pydantic models.** In `fastapi_app/lib/models/models_document_rules.py`:

1. Change the top-level typing import from `from typing import Optional` to:

```python
from typing import Literal, Optional
```

2. Append these three models after `RefreshOutcomeResponse` (i.e. right before `class ProposeChangeUrlRequest`):

```python
class RefTargetModel(BaseModel):
    target: str
    content_type: Optional[str]
    subtype: Literal["human", "machine"]


class RefreshResourceRequest(BaseModel):
    """Request to refresh one interpretation-ref resource's <ref>s from upstream. `xml` is the target document's stable_id."""
    xml: str
    url: str


class RefreshResourceResponse(BaseModel):
    """
    Response to POST /document-rules/refresh-resource.

    `status` meanings: "unavailable" (no provider for this document's
    extractor), "not_found" (`url` isn't the representative target of any
    current editorialDecl entry), "orphaned" (the entry's category no
    longer exists in a freshly-built entries list), "ok" (`refs`/`changed`
    populated). See plan_resource_refresh()'s docstring.
    """
    status: Literal["ok", "unavailable", "not_found", "orphaned"]
    refs: list[RefTargetModel] = Field(default_factory=list)
    changed: bool = False
    message: str
```

- [ ] **Step 3: Add the endpoint.** In `fastapi_app/routers/document_rules.py`:

1. Change the `rules_refresh` import block (currently):

```python
from ..lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    perform_refresh,
    preview_refresh,
    resolve_refresh_target,
)
```

to:

```python
from ..lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    perform_refresh,
    plan_resource_refresh,
    preview_refresh,
    resolve_refresh_target,
)
```

2. Change the `models_document_rules` import block to add the three new model names in alphabetical order (current block shown for context — insert `RefTargetModel` right before `RefreshOutcomeResponse`, and `RefreshResourceRequest`, `RefreshResourceResponse` right after `RefreshRequest`):

```python
from ..lib.models.models_document_rules import (
    CreateOverrideRequest,
    ListResourcesRequest,
    ListResourcesResponse,
    OkResponse,
    OverrideModel,
    ProposeChangeUrlRequest,
    ProposeChangeUrlResponse,
    QueryResourceRequest,
    QueryResourceResponse,
    RefTargetModel,
    RefreshOutcomeResponse,
    RefreshRequest,
    RefreshResourceRequest,
    RefreshResourceResponse,
    ResetSelectionRequest,
    ResourceDescriptorModel,
    SelectionInfo,
    SelectionsRequest,
    SelectionsResponse,
    SetSelectionRequest,
    UpdateOverrideRequest,
)
```

3. Append the new endpoint at the end of the file (after `propose_change_url`):

```python
@router.post("/refresh-resource", response_model=RefreshResourceResponse)
async def refresh_resource(
    request: RefreshResourceRequest,
    # Same gate as /refresh/preview and /refresh/execute - this endpoint
    # exists purely to support the same reviewer/admin-only "Document
    # rules" editing feature (see the "Server-side gating" note on the
    # other now-gated routes in this router, below).
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshResourceResponse:
    """
    Compute what one interpretation-ref resource's <ref>s should be now,
    without writing anything - the document edit itself happens client-side
    (see docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md,
    "Frontend design").
    """
    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, request.xml, user)
    except RefreshPreconditionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    outcome = plan_resource_refresh(target.tei_content, request.url, cache)
    return RefreshResourceResponse(
        status=outcome.status,
        refs=[RefTargetModel(**ref) for ref in outcome.refs],
        changed=outcome.changed,
        message=outcome.message,
    )
```

- [ ] **Step 4: Switch 8 routes' dependency from `require_authenticated_user` to `require_reviewer_or_admin`.** In `fastapi_app/routers/document_rules.py`, change the `user: dict = Depends(require_authenticated_user)` parameter to `user: dict = Depends(require_reviewer_or_admin)` in exactly these 8 route functions (identified by their `@router` decorator line above each):

- `list_document_resources` (`@router.post("/list", ...)`)
- `query_resource` (`@router.post("/query", ...)`)
- `create_override` (`@router.post("/overrides", ...)`)
- `update_override` (`@router.put("/overrides/{override_id}", ...)`)
- `delete_override` (`@router.delete("/overrides/{override_id}", ...)`)
- `set_selection` (`@router.put("/selection", ...)`)
- `reset_selection` (`@router.post("/selection/reset", ...)`)
- `get_selections` (`@router.post("/selections", ...)`)

Do **not** change `propose_change_url` (`@router.post("/propose-change-url", ...)`) — it stays `require_authenticated_user`, unchanged, per the spec ("no server-side write, only builds a URL... accidental misuse has no consequence worth gating against").

Since `require_authenticated_user` is no longer referenced by any route in this file after this change but is still used as an import target in tests, check whether it's still imported/used elsewhere in the file (it is — nowhere else in this router after this change) and remove it from the `from ..lib.core.dependencies import (...)` block only if genuinely unused; leave `require_reviewer_or_admin` in that same block (already imported, per the file's existing `/refresh/preview` and `/refresh/execute` routes).

- [ ] **Step 5: Write the failing tests.** In `tests/unit/fastapi/test_document_rules_router.py`:

1. Update the base fixture. Change `DocumentRulesRouterTestCase.setUp()`'s line:

```python
self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice"}
```

to:

```python
self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["reviewer"]}
```

This keeps every existing "happy path" test passing under the new gating (they all exercise a route that now requires reviewer/admin, except `/propose-change-url` tests, which are unaffected either way since that route ignores roles).

2. Add the import of `ResourceRefreshOutcome` alongside the existing imports:

```python
from fastapi_app.lib.doc_rules.rules_refresh import RefreshPreconditionError, ResourceRefreshOutcome
```

3. Append a new test class for the `/refresh-resource` endpoint:

```python
class TestRefreshResourceEndpoint(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.file_storage = MagicMock()
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

    def test_requires_reviewer_or_admin_role(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["user"]}
        response = self.client.post("/document-rules/refresh-resource", json={"xml": "tei-1", "url": "https://x"})
        self.assertEqual(response.status_code, 403)

    def test_reports_precondition_error_as_bad_request(self):
        with patch(
            "fastapi_app.routers.document_rules.resolve_refresh_target",
            side_effect=RefreshPreconditionError("No TEI document open."),
        ):
            response = self.client.post("/document-rules/refresh-resource", json={"xml": "missing", "url": "https://x"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("No TEI document open", response.json()["detail"])

    def test_returns_ok_outcome_with_refs(self):
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch("fastapi_app.routers.document_rules.plan_resource_refresh") as mock_plan:
            mock_resolve.return_value = MagicMock(tei_content="<TEI/>")
            mock_plan.return_value = ResourceRefreshOutcome(
                status="ok",
                refs=[{"target": "https://new", "content_type": "markdown", "subtype": "human"}],
                changed=True,
                message="Resource refreshed from upstream.",
            )
            response = self.client.post("/document-rules/refresh-resource", json={"xml": "tei-1", "url": "https://old"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["changed"])
        self.assertEqual(body["refs"][0]["target"], "https://new")

    def test_returns_not_found_outcome(self):
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch("fastapi_app.routers.document_rules.plan_resource_refresh") as mock_plan:
            mock_resolve.return_value = MagicMock(tei_content="<TEI/>")
            mock_plan.return_value = ResourceRefreshOutcome(status="not_found", refs=[], changed=False, message="not found")
            response = self.client.post("/document-rules/refresh-resource", json={"xml": "tei-1", "url": "https://old"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "not_found")
```

4. Append a new test class asserting 403 for each of the 8 newly-gated routes under a plain `["user"]` role:

```python
class TestNonReviewerCannotUseDocumentRulesRoutes(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["user"]}

    def test_list_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/list", json={"xml_string": XML_WITH_INTERPRETATION})
        self.assertEqual(response.status_code, 403)

    def test_query_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/query", json={"kind": "interpretation-ref", "url": "https://x"})
        self.assertEqual(response.status_code, 403)

    def test_create_override_requires_reviewer_or_admin(self):
        response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": "https://x"},
        )
        self.assertEqual(response.status_code, 403)

    def test_update_override_requires_reviewer_or_admin(self):
        response = self.client.put("/document-rules/overrides/some-id", json={"note": "x"})
        self.assertEqual(response.status_code, 403)

    def test_delete_override_requires_reviewer_or_admin(self):
        response = self.client.delete("/document-rules/overrides/some-id")
        self.assertEqual(response.status_code, 403)

    def test_set_selection_requires_reviewer_or_admin(self):
        response = self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": "https://x"},
        )
        self.assertEqual(response.status_code, 403)

    def test_reset_selection_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/selection/reset", json={"resources": []})
        self.assertEqual(response.status_code, 403)

    def test_get_selections_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/selections", json={"resources": []})
        self.assertEqual(response.status_code, 403)
```

- [ ] **Step 6: Run the full router test file and verify everything passes** (both the new tests and every pre-existing test, confirming the base-fixture role change didn't break anything).

Run: `uv run python -m pytest tests/unit/fastapi/test_document_rules_router.py -v`
Expected: PASS — all tests.

- [ ] **Step 7: Run the whole backend test suite once** to catch any other test file that might depend on this router's previous gating (e.g. an E2E-adjacent integration test elsewhere).

Run: `uv run python -m pytest tests/unit/fastapi -v`
Expected: PASS — all tests. If any unrelated test fails because it assumed `/document-rules/*` routes were reachable by a plain authenticated user, fix that test's fixture the same way (add `"roles": ["reviewer"]`), not the route.

- [ ] **Step 8: Commit.**

```bash
git add fastapi_app/lib/models/models_document_rules.py fastapi_app/routers/document_rules.py tests/unit/fastapi/test_document_rules_router.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): add POST /refresh-resource endpoint, gate 8 routes to reviewer/admin

The whole "Document rules" editing feature is already hidden client-side
from non-reviewers, but most routes only required authentication
server-side. Switches list/query/overrides/selection routes to
require_reviewer_or_admin (propose-change-url stays open - it performs no
write) and adds the new refresh-resource endpoint behind the same gate as
the existing whole-document refresh routes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Frontend API client method

**Files:**
- Modify: `app/src/modules/api-client-v1.js`

No dedicated test file exists for this hand-maintained client's individual methods (confirmed: no `tests/unit/js/api-client*` file, and no test in `document-rules.test.js` mocks `api-client-v1.js` itself — tests instead stub `getDependency('client')` directly). This task is implementation-only; Task 4's tests exercise the plugin code that calls this new method through a mock client.

- [ ] **Step 1: Add the typedefs.** In `app/src/modules/api-client-v1.js`, insert this block immediately after the existing `RefreshRequest`/`RefreshOutcomeResponse` typedef block (the one ending around line 608, right before the `ProposeChangeUrlRequest` typedef block):

```js
/**
 * @typedef {Object} RefTargetModel
 * @property {string} target
 * @property {string=} content_type
 * @property {'human'|'machine'} subtype
 */

/**
 * @typedef {Object} RefreshResourceRequest
 * @property {string} xml
 * @property {string} url
 */

/**
 * @typedef {Object} RefreshResourceResponse
 * @property {'ok'|'unavailable'|'not_found'|'orphaned'} status
 * @property {Array<RefTargetModel>} refs
 * @property {boolean} changed
 * @property {string} message
 */
```

- [ ] **Step 2: Add the method.** Insert this immediately after the existing `documentRulesProposeChangeUrl` method (the last `document-rules` method in the file):

```js
  /**
   * Compute what one interpretation-ref resource's <ref>s should be now,
   * without writing anything - the caller applies the returned `refs` to
   * the open document client-side. See RefreshResourceResponse's `status`
   * values.
   *
   * @param {RefreshResourceRequest} requestBody
   * @returns {Promise<RefreshResourceResponse>}
   */
  async documentRulesRefreshResource(requestBody) {
    const endpoint = `/document-rules/refresh-resource`
    return this.callApi(endpoint, 'POST', requestBody);
  }
```

- [ ] **Step 3: No test run needed for this file alone** (no dedicated test suite exists for it) — proceed to Task 4, which will exercise this method through a mocked `apiClient`.

- [ ] **Step 4: Commit.**

```bash
git add app/src/modules/api-client-v1.js
git commit -m "$(cat <<'EOF'
feat(doc-rules): add documentRulesRefreshResource API client method

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rewrite `_onReset()` in `document-rules.js`

**Files:**
- Modify: `app/src/plugins/document-rules.js`
- Test: `tests/unit/js/document-rules.test.js`

This is the frontend flow from the spec's "Frontend design" section (lines 170-190 of the spec). Read that section again before starting — it specifies the exact call order (document edit *before* override deletion, two `saveIfDirty()` calls bracketing the DOM mutation, xpath scoped to `editorialDecl`, "human ref else first" URL selection).

- [ ] **Step 1: Write the failing tests.** In `tests/unit/js/document-rules.test.js`, the existing `describe('DocumentRulesPlugin._onNewOverride/_onSave/_onDelete/_onReset', ...)` block's three `_onReset` tests (currently at lines 573-634, shown in full below for reference) must be **replaced** — the old behavior they test (delete-then-query with no document edit for *every* resource kind) is only correct now for `schema`-kind resources.

First, add a helper near the top of the file (after `makeDialogUi()`, around line 131) for a mock xmleditor dependency:

```js
/**
 * A minimal stand-in for the xmleditor dependency's DOM-mutation surface
 * (`getDomNodesByXpath`/`updateEditorFromNode`/`saveIfDirty`), tracking
 * calls so tests can assert the exact sequence _onReset() makes for an
 * interpretation-ref resource. `nodesByXpath` maps an xpath string to the
 * array of fake DOM elements it should return.
 * @param {Record<string, Element[]>} nodesByXpath
 * @returns {{ mock: any, calls: string[] }}
 */
function makeXmlEditorMock(nodesByXpath = {}) {
  const calls = [];
  const mock = {
    saveIfDirty: async () => { calls.push('saveIfDirty'); },
    getDomNodesByXpath: (xpath) => { calls.push(`getDomNodesByXpath:${xpath}`); return nodesByXpath[xpath] ?? []; },
    updateEditorFromNode: async (node) => { calls.push(`updateEditorFromNode:${node.getAttribute('target')}`); },
  };
  return { mock, calls };
}

/**
 * A fake live DOM <ref> element with a mutable `target` attribute, for
 * asserting _onReset()'s setAttribute() + updateEditorFromNode() sequence.
 * @param {string} target
 * @returns {Element}
 */
function makeRefElement(target) {
  const el = document.createElementNS('http://www.tei-c.org/ns/1.0', 'ref');
  el.setAttribute('target', target);
  return el;
}
```

Then replace the three tests at lines 573-634 (the block starting `it('_onReset asks for confirmation, deletes every override, and reloads the resource from origin', ...)` through the closing `});` before the outer `describe`'s closing brace) with:

```js
  it('_onReset (schema kind) keeps the simple delete-and-requery behavior, no document edit', async () => {
    const plugin = setup();
    plugin._currentResource = { kind: 'schema', url: 'https://example.com/schema.rng', key: 's', label: 'Schema', format: 'xml' };
    plugin._currentOverrides = [
      { id: 'ov1', note: '', text: 'x', format: 'xml', created_at: '', updated_at: '' },
      { id: 'ov2', note: '', text: 'y', format: 'xml', created_at: '', updated_at: '' },
    ];
    plugin._currentSelectedId = 'ov1';
    const deletedIds = [];
    let queryCalledWith;
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock();
    const freshResponse = { original_text: 'fresh from origin', overrides: [], selected_override_id: null };
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async (body) => { queryCalledWith = body; return freshResponse; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.deepStrictEqual(deletedIds, ['ov1', 'ov2']);
    assert.deepStrictEqual(queryCalledWith, { kind: 'schema', url: 'https://example.com/schema.rng' });
    assert.strictEqual(plugin._currentOriginalText, 'fresh from origin');
    assert.deepStrictEqual(plugin._currentOverrides, []);
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.deepStrictEqual(xmlCalls, []);
  });

  it('_onReset does nothing when the confirmation is declined', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deleteCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => false };
      if (name === 'client') return { apiClient: { documentRulesDeleteOverrides: async () => { deleteCalled = true; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.strictEqual(deleteCalled, false);
    assert.strictEqual(plugin._currentOverrides.length, 1);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
  });

  it('_onReset (interpretation-ref, changed=true) updates the document ref, then deletes overrides, then re-queries the new url', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/oldsha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/oldsha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const refEl = makeRefElement('https://github.com/o/r/blob/oldsha/docs/g.md#seg');
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock({
      '//tei:editorialDecl//tei:ref[@subtype="human"]': [refEl],
    });
    const deletedIds = [];
    let queryCalledWith;
    let refreshCalledWith;
    const freshResponse = { original_text: 'fresh new text', overrides: [], selected_override_id: null };
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async (body) => {
          refreshCalledWith = body;
          return {
            status: 'ok', changed: true,
            refs: [{ target: 'https://github.com/o/r/blob/newsha/docs/g.md#seg', content_type: 'markdown', subtype: 'human' }],
            message: 'Resource refreshed from upstream.',
          };
        },
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async (body) => { queryCalledWith = body; return freshResponse; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();

    assert.deepStrictEqual(refreshCalledWith, { xml: 'stable123', url: 'https://github.com/o/r/blob/oldsha/docs/g.md#seg' });
    assert.deepStrictEqual(xmlCalls, [
      'saveIfDirty',
      'getDomNodesByXpath://tei:editorialDecl//tei:ref[@subtype="human"]',
      'updateEditorFromNode:https://github.com/o/r/blob/newsha/docs/g.md#seg',
      'saveIfDirty',
    ]);
    assert.strictEqual(refEl.getAttribute('target'), 'https://github.com/o/r/blob/newsha/docs/g.md#seg');
    assert.deepStrictEqual(deletedIds, ['ov1']);
    assert.deepStrictEqual(queryCalledWith, { kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/newsha/docs/g.md#seg' });
    assert.strictEqual(plugin._currentResource.url, 'https://github.com/o/r/blob/newsha/docs/g.md#seg');
    assert.deepStrictEqual(plugin._currentResource.related_urls, ['https://github.com/o/r/blob/newsha/docs/g.md#seg']);
    assert.strictEqual(plugin._currentOriginalText, 'fresh new text');
    assert.match(notifyCalls[notifyCalls.length - 1][0], /refreshed from upstream and removed all overrides/);
  });

  it('_onReset (interpretation-ref, changed=false) skips the DOM edit but still deletes overrides', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock();
    const deletedIds = [];
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async () => ({ status: 'ok', changed: false, refs: [], message: 'Resource is already up to date.' }),
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async () => ({ original_text: 'same text', overrides: [], selected_override_id: null }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.deepStrictEqual(xmlCalls, []);
    assert.deepStrictEqual(deletedIds, ['ov1']);
    assert.match(notifyCalls[notifyCalls.length - 1][0], /overrides removed \(already up to date\)/);
  });

  for (const status of ['unavailable', 'orphaned']) {
    it(`_onReset (interpretation-ref, status=${status}) warns and does nothing else`, async () => {
      const plugin = setup();
      plugin._currentResource = {
        kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
        format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
      };
      plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
      plugin._currentSelectedId = 'ov1';
      let deleteCalled = false;
      let queryCalled = false;
      plugin.getDependency = (name) => {
        if (name === 'dialog') return { confirm: async () => true };
        if (name === 'client') return { apiClient: {
          documentRulesRefreshResource: async () => ({ status, changed: false, refs: [], message: `${status} message` }),
          documentRulesDeleteOverrides: async () => { deleteCalled = true; },
          documentRulesQuery: async () => { queryCalled = true; },
        } };
        throw new Error(`unexpected dependency: ${name}`);
      };
      await plugin._onReset();
      assert.strictEqual(deleteCalled, false);
      assert.strictEqual(queryCalled, false);
      assert.strictEqual(plugin._currentOverrides.length, 1);
      assert.match(notifyCalls[notifyCalls.length - 1][0], new RegExp(`${status} message`));
      assert.strictEqual(notifyCalls[notifyCalls.length - 1][1], 'warning');
    });
  }

  it('_onReset (interpretation-ref, status=not_found) shows a danger toast', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deleteCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async () => ({ status: 'not_found', changed: false, refs: [], message: 'gone' }),
        documentRulesDeleteOverrides: async () => { deleteCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.strictEqual(deleteCalled, false);
    assert.match(notifyCalls[notifyCalls.length - 1][0], /gone/);
    assert.strictEqual(notifyCalls[notifyCalls.length - 1][1], 'danger');
  });

  it('_onReset stops and notifies if deleting an override fails, without querying', async () => {
    const plugin = setup();
    plugin._currentResource = { kind: 'schema', url: 'https://example.com/schema.rng', key: 's', label: 'Schema', format: 'xml' };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'xml', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let queryCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'client') return { apiClient: {
        documentRulesDeleteOverrides: async () => { throw new Error('boom'); },
        documentRulesQuery: async () => { queryCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.strictEqual(queryCalled, false);
    assert.match(notifyCalls[0][0], /Could not remove overrides/);
  });
```

Note: `notifyCalls` is a module-level array declared at the top of the test file (line 78) and reset before every test by a file-level hook at line 187 (`beforeEach(() => { global.localStorage.clear(); notifyCalls.length = 0; });`). Since each `_onReset()` path above triggers at most one `notify()` call, **use `notifyCalls[0]` in every new test's assertion**, not `notifyCalls[notifyCalls.length - 1]` — replace every `notifyCalls[notifyCalls.length - 1]` in the test code blocks above with `notifyCalls[0]` when writing the actual test file.

Also verify `setup()`'s existing shape (shown in the "Important context" research, lines 487-497) sets `plugin._currentResource = { kind: 'interpretation-ref', ... }` by default — every new test above that needs `kind: 'schema'` or a specific `related_urls` explicitly reassigns `plugin._currentResource`, which is correct and required (don't rely on `setup()`'s default for tests that need different resource shapes).

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `node --test tests/unit/js/document-rules.test.js`
Expected: FAIL — `plugin.getDependency` throwing `unexpected dependency: xmleditor` (or similar), since `_onReset()` doesn't yet call `documentRulesRefreshResource` or use the xmleditor dependency.

- [ ] **Step 3: Implement the new `_onReset()`.** Replace the existing `_onReset()` method (currently at lines 697-741 of `app/src/plugins/document-rules.js`) with:

```js
  /**
   * Reload this resource from its origin and permanently remove every one
   * of the caller's overrides for it - unlike selecting "Original" (see
   * _selectOverride()), which only switches away from an override without
   * deleting anything. Confirmed up front since deletion can't be undone.
   *
   * For an `interpretation-ref` resource, this also re-resolves the
   * document's own `<ref target>` to what the extractor's current rules
   * configuration would generate today - not just whatever URL is already
   * pinned, which (once SHA-pinned) can never reflect a newer upstream
   * commit on its own (see
   * docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md).
   * The document edit happens before override deletion, so a failure
   * updating the document leaves overrides intact. `schema` resources keep
   * the simpler delete-and-requery behavior unchanged - their URL is never
   * permalink-pinned, so there is nothing to refresh.
   *
   * Use case: the caller proposed an override's change upstream (see
   * _onProposeUpstream()) and it was accepted, so both their now-stale
   * override and the document's stale pinned URL need to be replaced by
   * this one action.
   * @returns {Promise<void>}
   */
  async _onReset() {
    const confirmed = await this.getDependency('dialog').confirm(
      'This will reload the resource from its origin and remove all overrides.',
      'Reset to original'
    )
    if (!confirmed) return

    /** @type {import('../modules/api-client-v1.js').RefreshResourceResponse|null} */
    let refreshResult = null
    if (this._currentResource.kind === 'interpretation-ref') {
      try {
        refreshResult = await this.#client.apiClient.documentRulesRefreshResource({
          xml: this.state.xml,
          url: this._currentResource.url
        })
      } catch (error) {
        notify(`Could not refresh resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
        return
      }
      if (refreshResult.status !== 'ok') {
        const variant = refreshResult.status === 'not_found' ? 'danger' : 'warning'
        const icon = refreshResult.status === 'not_found' ? 'exclamation-octagon' : 'exclamation-triangle'
        notify(refreshResult.message, variant, icon)
        return
      }
      if (refreshResult.changed) {
        await this.#xmlEditor.saveIfDirty()
        for (const ref of refreshResult.refs) {
          const candidates = this.#xmlEditor.getDomNodesByXpath(`//tei:editorialDecl//tei:ref[@subtype="${ref.subtype}"]`)
          const node = candidates.find((n) => this._currentResource.related_urls.includes(n.getAttribute('target')))
          if (!node) continue
          node.setAttribute('target', ref.target)
          await this.#xmlEditor.updateEditorFromNode(node)
        }
        await this.#xmlEditor.saveIfDirty()

        const humanRef = refreshResult.refs.find((r) => r.subtype === 'human')
        this._currentResource.url = (humanRef ?? refreshResult.refs[0]).target
        this._currentResource.related_urls = refreshResult.refs.map((r) => r.target)
      }
    }

    try {
      for (const override of this._currentOverrides) {
        await this.#client.apiClient.documentRulesDeleteOverrides(override.id)
      }
    } catch (error) {
      notify(`Could not remove overrides: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }

    let response
    try {
      response = await this.#client.apiClient.documentRulesQuery({ kind: this._currentResource.kind, url: this._currentResource.url })
    } catch (error) {
      notify(`Could not reload resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides = response.overrides
    this._currentSelectedId = response.selected_override_id
    this._currentOriginalText = response.original_text
    this._renderEditorDialog()
    await this._refreshOverrideIndicators()

    const message = refreshResult
      ? (refreshResult.changed
          ? 'Reset to original: refreshed from upstream and removed all overrides.'
          : 'Reset to original: overrides removed (already up to date).')
      : `Reset to original: "${this._currentResource.label}" and its overrides have been reloaded.`
    notify(message, 'success', 'check-circle')
  }
```

Add `RefreshResourceResponse` to the module's `@import` typedef block at the top of the file (the one currently importing `ResourceDescriptorModel, OverrideModel, SelectionInfo` from `'../modules/api-client-v1.js'`):

```js
 * @import { ResourceDescriptorModel, OverrideModel, SelectionInfo, RefreshResourceResponse } from '../modules/api-client-v1.js'
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `node --test tests/unit/js/document-rules.test.js`
Expected: PASS — all tests in the file, including every pre-existing test not touched by this task (confirms no regression to `_onNewOverride`/`_onSave`/`_onDelete`/`_onProposeUpstream`/etc.).

- [ ] **Step 5: Visually check the change.** Per project rules, after a targeted UI change, take a screenshot to confirm the dialog still renders correctly (this task doesn't change the dialog's HTML/layout, only its reset logic, but the confirm-dialog wording and toast messages are new-ish and worth a quick visual sanity check):

Run: `node scripts/dev/ui-screenshot.js --out /private/tmp/claude-501/-Users-cboulanger-Code-pdf-tei-editor/*/scratchpad/reset-dialog.png` (use the actual scratchpad path for this session) with whatever `--click` sequence opens the document-rules editor dialog for an `interpretation-ref` resource (inspect `--help` output and the existing menu structure - "Tools" menu → "Edit prompts/schemas" submenu → a resource entry - to build the click selector chain). If reaching that dialog via clicks proves impractical for a screenshot script (it requires an open TEI document with editorialDecl content, which the demo data may not provide), it is acceptable to skip this step and instead note in the final report that visual verification wasn't performed and why - do not spend excessive time forcing a screenshot of a code-only logic change with no new HTML/CSS.

- [ ] **Step 6: Commit.**

```bash
git add app/src/plugins/document-rules.js tests/unit/js/document-rules.test.js
git commit -m "$(cat <<'EOF'
feat(doc-rules): make "Reset to original" refresh interpretation-ref <ref>s

For interpretation-ref resources, calls the new /refresh-resource endpoint
and, if the resolved refs changed, updates the document's live <ref target>
DOM nodes (saving before and after) before deleting overrides - so a
document whose upstream change was accepted stops pointing at the stale
SHA-pinned commit. schema resources keep their existing simple reset.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full suite + final review

- [ ] **Step 1: Run the full unit test suite.**

Run: `npm run test:unit`
Expected: PASS — no regressions anywhere in the repo, not just the touched files.

- [ ] **Step 2: Run the full E2E suite.**

Run: `npm run test:e2e`
Expected: PASS. (The spec's own "Testing" section says no new E2E coverage is being added for this feature - this step is only to catch a regression, per the project's "run the full suite before finishing" rule.)

- [ ] **Step 3: Re-read the spec's "Error handling" table** (lines 192-201) against the final `_onReset()` implementation and confirm every row is actually satisfied: no-provider/not_found/orphaned statuses, refresh-resource network failure, override-delete-partway failure, and re-query failure after a successful update. Fix anything that doesn't match; this is the plan's own self-review step for spec coverage, done once at the end rather than after every task.

- [ ] **Step 4: Report completion**, noting the total commit count and whether Step 5 of Task 4 (the screenshot) was performed or skipped and why.
