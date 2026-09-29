# Document Rules — "Reset to Original" Refreshes the Resource's `<ref>`s — Design

Addendum to [2026-09-27-document-rules-registry-design.md](2026-09-27-document-rules-registry-design.md), specifically the "Reset to original" behavior most recently revised to delete overrides rather than just clear the selection. This spec covers making that reset also refresh the resource's `<ref target>` in the document itself, for `interpretation-ref` resources whose target is pinned to a commit SHA.

## Goal

When a user resets an `interpretation-ref` resource ("Reset to original" in the resource editor dialog), actually re-resolve its `<ref>` element(s) to what the extractor's current rules configuration would generate today - not just re-fetch whatever URL already happens to be pinned in the document, which (once SHA-pinned) can never reflect a newer upstream commit on its own. Overrides are deleted as before, since they're edits of now-superseded content.

**Use case:** a user proposed an override's text as an upstream change (see [2026-09-28-document-rules-propose-upstream-design.md](2026-09-28-document-rules-propose-upstream-design.md)) and it was accepted there. The document's `<ref target>` is still pinned to the *old* commit; "Reset to original" should be the action that both removes the now-stale override and points the document at the accepted change.

## Key finding

`GitHubAdapter.resolve_ref_to_sha()` / `GitLabAdapter.resolve_ref_to_sha()` treat an already-SHA-pinned URL as done (`if _SHA_RE.match(ref): return url`) - they never re-resolve to a newer commit. Once a ref is pinned, its original branch name is gone; there is no way to recover "what would this resolve to today" from the pinned URL alone.

The only place that knows the *true, current* source URL for a rule category is `DocumentRulesProvider.build_editorial_decl_entries()` - the same function the existing whole-document "Refresh document rules" action already calls (`fastapi_app/lib/doc_rules/rules_refresh.py`) - because it starts from the guide's *config* URL (e.g. GROBID's `AnnotationGuide["url"]`), not from whatever the document happens to have pinned. So a per-resource refresh must reuse that function rather than inventing new git-forge "find the latest commit" logic in `git_forge_adapters.py`.

## Non-goals

- No change to `schema`-kind resources. `GrobidRulesProvider.get_schema_url()` returns the configured RNG URL verbatim - it is never permalink-pinned via `resolve_forge_permalink()`, unlike `interpretation-ref`'s "human"/"machine" refs. There is nothing to refresh for a schema resource; "Reset to original" keeps its current behavior for it (delete overrides, re-query the same URL, no document edit).
- No change to the whole-document "Refresh document rules" action (`/refresh/preview`, `/refresh/execute`) - this is a separate, narrower entry point that happens to share `build_editorial_decl_entries()`/`extract_annotation_rule_refs()` with it.
- No new git-forge adapter method for "re-pin to the current default branch" - ruled out in favor of reusing the provider.
- No handling for a rule category whose *shape* changed (e.g. a "machine" ref added or removed since the document was generated) beyond the common case of the same one-or-two subtypes with an updated `target`. A subtype present in the old refs but absent from the new ones is left untouched in the document.

## Matching an existing resource to its freshly-built entry

Given the resource's current `url` (the representative target the dialog already has):

1. Parse the document's *existing* entries via `extract_annotation_rule_refs(tei_content)` (already used by `InterpretationRefKind.discover()` and `rules_refresh.py`).
2. Find the entry whose `representative_ref(entry["refs"])["target"] == url` - this is exactly how `InterpretationRefKind.discover()` already identifies a resource from an entry, run in reverse.
3. That entry's `category` is the stable identity to match against freshly-built entries - not the URL, which is exactly what changes on repinning. GROBID's own config confirms `category` alone isn't globally unique (several guides share `category="primary"` across different `variant_ids`), but *within one document's resolved `variant_id`*, `build_editorial_decl_entries()` produces at most one entry per category (the existing whole-document refresh already relies on this - see `_plan_refresh()`'s entry-list comparison).
4. Build fresh entries via `provider.build_editorial_decl_entries(variant_id, cache)` and find the one with the same `category`. Its `refs` list (each a `{target, content_type, subtype}` `AnnotationRuleRefTarget`) is the resource's new refs.

## Backend design

### `plan_resource_refresh()` (`fastapi_app/lib/doc_rules/rules_refresh.py`)

Read-only - no file write happens here. Unlike `perform_refresh()`, the document edit itself happens client-side (see "Frontend design"), so this function's only job is to compute what the resource's refs should be now.

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
    against a freshly-built entries list - see this file's module-level
    "Reset to original" design note for the rationale (a SHA-pinned ref
    can never be re-resolved to a newer commit from the pinned URL alone;
    only the provider's *configured* source URL can).

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

`representative_ref` is imported from `fastapi_app.lib.doc_rules.interpretation_ref_kind` (where it already lives - no circular import, since `interpretation_ref_kind.py` does not import `rules_refresh.py`).

`status` meanings:

| status | Meaning | Client action |
| --- | --- | --- |
| `unavailable` | No `DocumentRulesProvider` for this document's extractor | Warning toast with `message`, stop - no override deletion, no document edit |
| `not_found` | `url` isn't the representative target of any current entry | Danger toast with `message`, stop - defensive; shouldn't normally happen (stale client-side resource list) |
| `orphaned` | Provider available, but no fresh entry shares the old entry's `category` | Warning toast with `message`, stop - overrides and the document are left untouched (per design decision: surface the problem rather than silently degrade) |
| `ok` | `refs`/`changed` populated | Proceed - see "Frontend design" |

### REST endpoint

```python
class RefreshResourceRequest(BaseModel):
    xml: str  # stable_id, same field name/meaning as RefreshRequest.xml
    url: str


class RefTargetModel(BaseModel):
    target: str
    content_type: Optional[str]
    subtype: Literal["human", "machine"]


class RefreshResourceResponse(BaseModel):
    status: Literal["ok", "unavailable", "not_found", "orphaned"]
    refs: list[RefTargetModel] = Field(default_factory=list)
    changed: bool = False
    message: str
```

`POST /api/v1/document-rules/refresh-resource`, gated `Depends(require_reviewer_or_admin)` - same gate as `/refresh/preview` and `/refresh/execute`, since this endpoint exists purely to support the same reviewer/admin-only "Document rules" editing feature (see "Server-side gating" below). Reuses `resolve_refresh_target()` (already used by both `/refresh/preview` and `/refresh/execute`) for the file lookup/permission check from `request.xml`, then calls `plan_resource_refresh(target.tei_content, request.url, cache)`.

```python
@router.post("/refresh-resource", response_model=RefreshResourceResponse)
async def refresh_resource(
    request: RefreshResourceRequest,
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshResourceResponse:
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

### Server-side gating (separate, related fix bundled into this plan)

The whole "Document rules" editing feature (the `/document-rules/*` routes backing "Edit prompts/schemas") is already hidden client-side from any user without `reviewer`/`admin` (see commit `b00dc220`), but every route except `/refresh/preview` and `/refresh/execute` currently only requires `Depends(require_authenticated_user)` server-side - relying entirely on the frontend menu being hidden. Per the "no fine-grained access-control needed here, this is about hiding tools from users who'd otherwise mess things up by accident" principle: every route in `fastapi_app/routers/document_rules.py` that is *specific to this feature* (i.e., not a generic building block reused elsewhere) is switched from `require_authenticated_user` to `require_reviewer_or_admin`:

- `POST /list`
- `POST /query`
- `POST /overrides`
- `PUT /overrides/{override_id}`
- `DELETE /overrides/{override_id}`
- `PUT /selection`
- `POST /selection/reset`
- `POST /selections`
- `POST /refresh-resource` (new, this spec)

`POST /propose-change-url` is deliberately left as `require_authenticated_user`, unchanged: it performs no server-side write, only builds a URL (see its own design spec's rationale, "not a privileged action") - accidental misuse has no consequence worth gating against.

## Frontend design

`DocumentRulesPlugin._onReset()` (`app/src/plugins/document-rules.js`), for `_currentResource.kind === 'interpretation-ref'` only - `'schema'` keeps exactly its current behavior (confirm, delete overrides, re-query, no document edit):

1. Confirm dialog (already implemented): `dialog.confirm('This will reload the resource from its origin and remove all overrides.', 'Reset to original')`. Cancel → stop, nothing happens.
2. Call `documentRulesRefreshResource({ xml: this.state.xml, url: this._currentResource.url })`.
3. `status !== 'ok'` → toast (`warning` for `unavailable`/`orphaned`, `danger` for `not_found`) with the response's `message`; stop. No override deletion, no document edit.
4. `status === 'ok' && changed`: update the document's `<ref>`s before touching overrides, so a failure here leaves overrides intact rather than deleting them and then failing to update the document:
   a. `await this.#xmlEditor.saveIfDirty()` - flush any pre-existing unsaved edits onto a known-saved baseline first, so this action's document edit is cleanly attributable and doesn't silently bundle in unrelated in-progress work.
   b. For each ref in the response's `refs`: find the matching live node via `this.#xmlEditor.getDomNodesByXpath(`//tei:editorialDecl//tei:ref[@subtype="${ref.subtype}"]`)` (scoped to `editorialDecl` so an unrelated `<ref>` elsewhere in the document is never a candidate), filtered further to the one whose `@target` is currently in `_currentResource.related_urls`; `node.setAttribute('target', ref.target)`; `await this.#xmlEditor.updateEditorFromNode(node)` - the same `setAttribute()` + `updateEditorFromNode()` pattern already used by `xml-annotation-popup.js` for live attribute edits.
   c. `await this.#xmlEditor.saveIfDirty()` again, to deterministically persist the ref update before continuing (rather than relying on the ~100ms debounced auto-save).
5. Delete every one of the resource's overrides (existing per-id `documentRulesDeleteOverrides` loop, unchanged from the current implementation).
6. Re-query via `documentRulesQuery({ kind: 'interpretation-ref', url: newUrl })` to get fresh `original_text`, where `newUrl` (when `changed`) is the "human" ref's `target` if `refs` contains one, else the first ref's `target` - mirroring `representative_ref()`'s own rule (its docstring: "its 'human' ref if present, else its sole 'machine' ref"), so the same representative-target selection is used on both sides. Update `_currentResource.url` to `newUrl` and `_currentResource.related_urls` to `refs.map(r => r.target)` locally (when `changed`) so the dialog and subsequent actions use the new URLs.
7. `_currentOverrides = []`, `_currentSelectedId = null`, `_currentOriginalText = <fresh text>`; re-render, refresh override indicators.
8. Success toast: `"Reset to original: refreshed from upstream and removed all overrides."` when `changed` was true, or `"Reset to original: overrides removed (already up to date)."` when it was false.

Matching a ref by `@subtype` (not by position) is deliberate: `AnnotationRuleRefTarget`'s `subtype` (`"human"`/`"machine"`) is the stable role identifier across a refresh, independent of list order.

### New API client method

`app/src/modules/api-client-v1.js`: `documentRulesRefreshResource(requestBody)` posting to `/document-rules/refresh-resource`, plus `RefreshResourceRequest`/`RefreshResourceResponse`/`RefTargetModel`-equivalent typedefs, following the existing `documentRulesRefreshPreview`/`documentRulesRefreshExecute` pattern.

## Error handling

| Condition | Behavior |
| --- | --- |
| No provider for the document's extractor (`unavailable`) | Warning toast, no override deletion, no document edit |
| Resource's `url` not found in the document's current entries (`not_found`) | Danger toast, no override deletion, no document edit |
| Resource's rule category no longer exists upstream (`orphaned`) | Warning toast, no override deletion, no document edit |
| `refresh-resource` call itself fails (network/5xx) | Danger toast with the error message, no override deletion, no document edit |
| Deleting an override fails partway through the loop | Danger toast, stop - document's `<ref>`s may already have been updated at this point (step 4 runs before step 5), but no further overrides are deleted; user can retry "Reset to original", which will find `changed=False` on the retry and just finish deleting overrides |
| Re-query (step 6) fails after a successful ref update and override deletion | Danger toast; document and overrides are already correctly updated - only the dialog's own re-render is stale until the user reopens it |

## Testing

- **Python unit** for `plan_resource_refresh()`: `unavailable` (no provider), `not_found` (url not in existing entries), `orphaned` (category missing from fresh entries), `ok` with `changed=True` (target differs), `ok` with `changed=False` (identical refs) - mocking `get_document_rules_provider_for_document`/the provider's `build_editorial_decl_entries()`.
- **Python unit** for the `/refresh-resource` route: each `status` value round-trips through the response model; 400 on `RefreshPreconditionError`; reviewer/admin gating (403 for a plain authenticated user) - plus the same 403 check added for every other now-gated route in this router (`/list`, `/query`, `/overrides` POST/PUT/DELETE, `/selection`, `/selection/reset`, `/selections`).
- **Frontend unit** for `_onReset()`: `interpretation-ref` with `changed=True` (asserts `getDomNodesByXpath`/`setAttribute`/`updateEditorFromNode`/`saveIfDirty` call sequence, override deletion, re-query with the new URL); `changed=False` (asserts no DOM/save calls, overrides still deleted); each non-`ok` status (asserts no DOM edit, no override deletion, correct toast); `schema` kind (asserts today's simple behavior, untouched); confirmation declined (asserts nothing happens).
- No new E2E coverage - consistent with the existing propose-upstream and whole-document-refresh features' testing sections; a manual smoke check (reset a resource with a selected override on a document whose rules config has since changed) is sufficient.
- Run the full suite (`npm run test:unit`, backend `pytest`) before finishing, per project rules.

## Deferred

- Handling a rule category whose ref *shape* changed (added/removed subtype) - out of scope; the common "same subtypes, new target" case is what this covers.
- Any equivalent "resource-level refresh" for `schema` resources - not applicable today since schema URLs aren't pinned, but if that ever changes, this design's matching/endpoint shape would need revisiting, not schema-specific code added here speculatively.
