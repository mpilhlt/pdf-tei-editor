# Document rules: clean up after a merged upstream proposal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rule editor marks the user's overrides that upstream now contains, and "Update to upstream" re-pins the category's refs and removes exactly those overrides.

**Architecture:** A new backend module `upstream_cleanup.py` computes, for the category a document ref belongs to, whether the refs are behind the default branch and which of the caller's overrides match the default-branch section; two routes expose it (status, removal). The frontend requests the status when the editor shows an interpretation-ref category, marks overrides, and replaces "Reset to original" by "Update to upstream" for that kind.

**Tech Stack:** FastAPI, Pydantic, lxml (existing), vanilla JS plugin with Shoelace, node:test, unittest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-document-rules-upstream-cleanup-design.md`

## Global Constraints

- Branch `feat/666-upstream-cleanup`, stacked on `feat/666-phase4b-github-pr` (PR #673). Commit messages end with `(Refs #666)` and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push after every commit.
- Python: `uv run python`; precise type annotations, no `Any`; long strings as one literal. Python tests must be `unittest.TestCase` classes (the runner ignores pytest-style tests). Run: `uv run python tests/unit-test-runner.py <file>`.
- JS: JSDoc on every new method, `@import` blocks for types (never inline `import()`), UI access via the `ui`/`_editorDialogUi` hierarchy, never `querySelector`. Run: `node --test tests/unit/js/document-rules.test.js`.
- After a template change regenerate types: `npm run build:ui-types`.
- `app/src/modules/api-client-v1.js` is hand-maintained: add typed methods and typedefs for new routes.
- Never start or restart the dev server. E2E needs network: run with sandbox disabled, never two E2E runs at once.
- Only the caller's own overrides are read or deleted (store `owner` = `user["username"]`).
- Never delete an override whose text upstream does not contain (anti-goal). `DocumentRulesStore.delete_override()` cascades to the selection, so a deleted selected override falls back to the original by itself.

## Review Focus

1. Machine override whose sync marker differs from upstream's but whose rules are identical → must match (markers ignored).
2. Human override in absolute-link form vs upstream section in relative-link form → must match.
3. A layer whose section anchor no longer exists at the default branch head → that layer reports an `error`, none of its overrides is deleted, the other layer still works.
4. A `url` that is not one of the document's refs → 400, no network fetch.
5. Override text that differs from upstream only by an added rule → kept, never deleted, also by the removal route even if an earlier status call (stale) reported it as matching.

---

### Task 1: Backend module `upstream_cleanup.py`

**Files:**
- Create: `fastapi_app/lib/doc_rules/upstream_cleanup.py`
- Test: `tests/unit/fastapi/test_doc_rules_upstream_cleanup.py`

**Interfaces:**
- Consumes (existing): `InterpretationRefKind().discover(xml) -> list[ResourceDescriptor]` (fields `url`, `layer`, `group`, `related_urls`), `InterpretationRefKind().resource_key(url, strict=True)`; `DocumentRulesStore.list_overrides(kind, key, owner) -> list[OverrideRow]` (`id`, `text`), `.delete_override(id, owner) -> bool`; `plan_resource_refresh(tei, url, cache) -> ResourceRefreshOutcome` (`status`, `changed`, `message`); from `upstream_proposal`: `_adapter`, `_repo_path`, `_default_branch`, `_fetch_raw_file`, `_section`, `section_anchor` (make the private ones you use importable by dropping the leading underscore only if needed elsewhere; importing module-private names from a sibling module is acceptable here); `section_hash()` from `guide_sync`; `derelativize_markdown_urls(text, url)`.
- Produces:
  - `class CategoryNotFoundError(Exception)`
  - `@dataclass(frozen=True) class LayerUpstreamStatus: layer: str; url: str; error: Optional[str]; in_upstream: list[str]; kept: list[str]` — `in_upstream` = ids of matching overrides, `kept` = ids of the other overrides of the layer.
  - `@dataclass(frozen=True) class UpstreamStatus: refs_behind: bool; refresh_message: Optional[str]; layers: list[LayerUpstreamStatus]`
  - `def category_layers(tei_content: str, url: str) -> list[ResourceDescriptor]` — the descriptors of the group whose member has `url` as `url` or in `related_urls`; raises `CategoryNotFoundError` otherwise. Order human, machine.
  - `def upstream_section(url: str, cache: UrlCache) -> str` — section of `url`'s heading anchor in the file at the default branch head, raw repository form.
  - `def matches_upstream(text: str, upstream: str, url: str) -> bool` — `section_hash(derelativize_markdown_urls(text.replace("\r\n", "\n"), url)) == section_hash(derelativize_markdown_urls(upstream.replace("\r\n", "\n"), url))`.
  - `def upstream_status(tei_content: str, url: str, store: DocumentRulesStore, owner: str, cache: UrlCache) -> UpstreamStatus`
  - `def remove_overrides_in_upstream(tei_content: str, url: str, store: DocumentRulesStore, owner: str, cache: UrlCache) -> UpstreamStatus` — recomputes the status, deletes each layer's `in_upstream` overrides, returns the recomputed status (its `in_upstream` lists = deleted ids).

- [ ] **Step 1: Write the failing tests** (`unittest.TestCase`; patch `upstream_section` / `_fetch_raw_file` and `plan_resource_refresh` in the module namespace; real `DocumentRulesStore` on a temp `DatabaseManager` as in `tests/unit/fastapi/test_document_rules_router.py` setUp). Use a TEI fixture with one `<interpretation>` holding a human ref `https://github.com/o/r/blob/abc/docs/g.md#data-correction` and a machine ref `https://github.com/o/r/blob/abc/docs/g-llm.md#data-correction`; patch `InterpretationRefKind.resource_key` to `normalize_resource_key`.
  - `test_category_layers_finds_both_layers_from_either_url` — both URLs return `[human, machine]` by `layer`.
  - `test_category_layers_unknown_url_raises` — `CategoryNotFoundError`.
  - `test_matches_upstream_ignores_sync_markers` — `"## A\n\n<!-- sync: guide=1 llm=2 -->\n\nRule.\n"` vs `"## A\n<!-- sync: guide=3 llm=4 -->\nRule."` → True.
  - `test_matches_upstream_ignores_link_form` — text with `[x](https://github.com/o/r/blob/abc/docs/other.md)` vs upstream `[x](other.md)`, url `https://github.com/o/r/blob/abc/docs/g.md#a` → True.
  - `test_matches_upstream_detects_a_changed_rule` → False for an added line.
  - `test_status_marks_matching_and_keeps_others` — two machine overrides, one matching: `in_upstream == [id1]`, `kept == [id2]`, `error is None`.
  - `test_status_layer_error_marks_nothing` — `upstream_section` raises `ProposalError("gone")` for the human URL only: human layer `error == "gone"`, `in_upstream == []`, `kept` lists all its overrides; machine layer unaffected.
  - `test_status_refs_behind_from_refresh` — `plan_resource_refresh` returns status `ok`, `changed=True` → `refs_behind is True`; status `unavailable` → `refs_behind is False`, `refresh_message` = its message.
  - `test_remove_deletes_only_matching_overrides` — after the call, `store.list_overrides` holds only the non-matching one; a selected matching override leaves `get_selection(...)` `None`.
  - `test_remove_rechecks_instead_of_trusting_an_earlier_status` — status computed, then upstream patched to differ, then remove → nothing deleted.
  - `test_remove_ignores_other_users_overrides` — an override of owner `bob` with matching text survives `remove_overrides_in_upstream(..., owner="alice", ...)`.

- [ ] **Step 2: Run** `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_upstream_cleanup.py` — expect import failure.

- [ ] **Step 3: Implement** the module. `upstream_section`: `_default_branch(_adapter(url), url, cache)` → `(branch, main_url)`; `_section(_fetch_raw_file(main_url), section_anchor(url, cache), _repo_path(url)[1], branch)`. In `upstream_status`, per layer catch `(ProposalError, RuleFetchError, requests.RequestException)` and use `str(e)` as `error`. Overrides of a layer: `store.list_overrides("interpretation-ref", kind.resource_key(layer.url, strict=True), owner)`. `refs_behind`: call `plan_resource_refresh(tei_content, url, cache)`; `outcome.status == "ok" and outcome.changed`; `refresh_message = None if outcome.status == "ok" else outcome.message`. Module docstring states the anti-goal (never delete a non-matching override).

- [ ] **Step 4: Run** the tests — expect PASS.

- [ ] **Step 5: Commit** `feat(document-rules): upstream status of a rule category's overrides (Refs #666)`.

### Task 2: Routes, models, API client

**Files:**
- Modify: `fastapi_app/lib/models/models_document_rules.py`, `fastapi_app/routers/document_rules.py`, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_document_rules_router.py`

**Interfaces:**
- Consumes: Task 1's `upstream_status`, `remove_overrides_in_upstream`, `CategoryNotFoundError`, `UpstreamStatus`; existing `_document_tei_or_http_error(file_repo, file_storage, stable_id, user) -> str` in the router (read access; 400/403).
- Produces:
  - Models: `UpstreamStatusRequest(xml: str, url: str)`; `LayerUpstreamStatusModel(layer: str, url: str, error: Optional[str], in_upstream: list[str], kept: list[str])`; `UpstreamStatusResponse(refs_behind: bool, refresh_message: Optional[str], layers: list[LayerUpstreamStatusModel])`. Docstrings: `xml` is the open document's stable id; `url` one of its refs.
  - `POST /document-rules/upstream-status` → `UpstreamStatusResponse`; `POST /document-rules/remove-overrides-in-upstream` (same request) → `UpstreamStatusResponse` whose `in_upstream` lists are the deleted ids. Both plain `def`, `Depends(require_reviewer_or_admin)`, `get_document_rules_store`, `get_db`, `get_file_storage`. `CategoryNotFoundError` → 400 `"This rule is not referenced by the document."`.
  - JS: `documentRulesUpstreamStatus(requestBody)`, `documentRulesRemoveOverridesInUpstream(requestBody)` with typedefs `UpstreamStatusRequest`, `LayerUpstreamStatus`, `UpstreamStatusResponse`.

- [ ] **Step 1: Write failing tests** (new `TestUpstreamCleanupRoutes(DocumentRulesRouterTestCase)`; patch `fastapi_app.routers.document_rules._document_tei_or_http_error` to return a TEI string and patch `upstream_status` / `remove_overrides_in_upstream` in the router namespace):
  - `test_status_returns_the_module_result` — fields serialized as above.
  - `test_unknown_url_is_400` — module raises `CategoryNotFoundError` → 400.
  - `test_remove_returns_the_deleted_ids`.
  - `test_non_reviewer_is_forbidden_on_both_routes` → 403.
- [ ] **Step 2: Run** `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_document_rules_router.py` — expect FAIL.
- [ ] **Step 3: Implement** models, routes, API client methods.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(document-rules): upstream-status and remove-overrides-in-upstream routes (Refs #666)`.

### Task 3: Rule editor — status, marks, "Update to upstream"

**Files:**
- Modify: `app/src/templates/document-rules-editor-dialog.html` (+ regenerated `.types.js`), `app/src/plugins/document-rules.js`
- Test: `tests/unit/js/document-rules.test.js`

**Interfaces:**
- Consumes: Task 2's API client methods; existing `_currentGroup`, `_currentResource`, `_renderOverrideRow()`, `_renderEditorDialog()`, `_onReset()`, `_refreshOverrideIndicators()`, `_openResourceEditor()`.
- Produces:
  - Template: `<div name="upstreamStatus" style="display: none; margin-bottom: 0.75rem; font-size: var(--sl-font-size-small);"></div>` directly after `syncStatus`; `<sl-button name="updateToUpstreamBtn" size="small" style="display: none;">Update to upstream</sl-button>` next to `resetBtn`.
  - `_upstreamStatus` (`UpstreamStatusResponse|null`) and `_upstreamStatusRequest` counter (same stale-response pattern as `_syncStatusRequest`).
  - `async _refreshUpstreamStatus()` — never rejects; for `_currentResource.kind === 'interpretation-ref'` calls `documentRulesUpstreamStatus({ xml: this.state.xml, url: this._currentResource.url })`, stores the result, re-renders the override row, status line and buttons; for other kinds or on error sets `_upstreamStatus = null` and hides the line (error logged via `#logger.warn`). Called from `_openResourceEditor()` (next to `_refreshSyncStatus()`), not on a layer-tab switch within the same group (keep the last result; the status covers both layers).
  - `_inUpstream(overrideId) -> boolean` — id is in some layer's `in_upstream`.
  - `_applyRefreshedRefs(refreshResult)` — the existing document edit block of `_onReset()` (from `if (refreshResult.changed)` through updating `member.url` / `related_urls`), moved verbatim into its own async method and called from `_onReset()`; no behaviour change.
  - `async _onUpdateToUpstream()`.
- Copy (exact):
  - Override tooltip/icon: icon `cloud-check` in the `suffix` slot; tooltip `IN_UPSTREAM_OVERRIDE_TOOLTIP = 'Upstream contains this text; it is removed when you update to upstream.'` (takes precedence over the outdated clock; note appended on a new line as for the clock).
  - Status line (icon `arrow-repeat`), shown when `refs_behind` or any `in_upstream` is non-empty: parts joined by a space — `'The guide upstream has changed since this document was annotated.'` if `refs_behind`; `'N override(s) now in upstream.'` (`1 override` / `N overrides`) if any; then `'Use "Update to upstream" to apply it.'`. Each layer `error` appends `'Could not compare the <Guide|Machine rules> with upstream: <error>'` on its own line (shown even when nothing else is).
  - Confirmation: title `'Update to upstream'`, text `'This updates the document to the current upstream rules and removes N override(s) that upstream now contains. M other override(s) are kept.'` (omit the first count sentence part when N is 0, the second sentence when M is 0).
  - Success: `'Updated to upstream: removed N override(s), kept M.'`
- Buttons in `_renderEditorDialog()`: for `kind === 'interpretation-ref'` hide `resetBtn` always; show `updateToUpstreamBtn` when `_upstreamStatus` has `refs_behind` or any `in_upstream`, and the document is not read-only. Other kinds keep `resetBtn` as now and hide `updateToUpstreamBtn`.
- `_onUpdateToUpstream()` order: confirm → `documentRulesRefreshResource({ xml, url })`; non-`ok` status → notify as `_onReset()` does and stop; `changed` → `_applyRefreshedRefs(result)` (document edit + save) → `documentRulesRemoveOverridesInUpstream({ xml: this.state.xml, url: this._currentResource.url })` (url after the re-pin) → on error notify danger and continue to reload → `documentRulesQuery` reload of `_currentResource` as in `_onReset()`, `_renderEditorDialog()`, `_refreshSyncStatus()`, `_refreshUpstreamStatus()`, `_refreshOverrideIndicators()` → success notify with the counts from the removal response (sum of `in_upstream` / `kept` lengths). The button is disabled and `loading` while it runs.

- [ ] **Step 1: Write failing tests** in a new `describe('DocumentRulesPlugin upstream cleanup', ...)` using the existing fake-UI/fake-client helpers of the file:
  - `_refreshUpstreamStatus requests the status with the stable id and the shown url`.
  - `marks overrides that upstream contains with the cloud-check icon and tooltip`.
  - `shows the status line with counts and per-layer errors`; `hides the status line when nothing is behind and nothing matches`.
  - `shows "Update to upstream" instead of "Reset to original" for interpretation-ref; schema keeps "Reset to original"`.
  - `_onUpdateToUpstream re-pins the document before removing overrides` (call order recorded: refreshResource, document edit, removeOverridesInUpstream, query).
  - `_onUpdateToUpstream stops before removal when the refresh is not ok`.
  - `_onUpdateToUpstream does nothing when the confirmation is declined`.
  - `_onUpdateToUpstream reports the counts of the removal response`.
  - existing `_onReset` tests still pass unchanged (refactor guard).
- [ ] **Step 2: Run** `node --test tests/unit/js/document-rules.test.js` — FAIL.
- [ ] **Step 3: Implement**; `npm run build:ui-types`.
- [ ] **Step 4: Run** — PASS; `npm run test:unit:js` all green.
- [ ] **Step 5: Commit** `feat(document-rules): show overrides upstream contains and update to upstream (Refs #666)`.

### Task 4: E2E, docs, full suites

**Files:**
- Modify: `tests/e2e/tests/document-rules.spec.js`, `docs/user-manual/unit-review.md`, `docs/development/tei-header-integrations.md`

- [ ] **Step 1: E2E test** `updates to upstream and removes overrides upstream contains` in the existing two-layer section of the spec: mock `**/api/v1/document-rules/upstream-status` (one machine override in `in_upstream`, `refs_behind: true`), `**/refresh-resource` (`ok`, `changed: false`), `**/remove-overrides-in-upstream`; open the editor, assert the status line text contains `now in upstream`, the "Update to upstream" button is visible and "Reset to original" is not, click it (500 ms wait before dialog clicks), confirm, assert the success toast text `Updated to upstream: removed 1 override, kept 0.`
- [ ] **Step 2: Docs.** User manual: a paragraph after the "Propose upstream" section — after a proposal is merged, the editor marks the overrides upstream contains and "Update to upstream" applies the upstream rules, removing only those overrides; differing overrides are kept. Developer doc: the two routes (request/response fields, 400 for a URL not in the document, server-side recheck before deletion) in the document-rules section next to the pull-request bullet.
- [ ] **Step 3: Full suites**: `npm run test:unit` and `npm run test:e2e` (sandbox disabled), all green.
- [ ] **Step 4: Commit** `test(document-rules): e2e and docs for updating to upstream (Refs #666)`; push.
