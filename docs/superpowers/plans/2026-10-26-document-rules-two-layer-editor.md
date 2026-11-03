# Document Rules Two-Layer Editor (Issue #666, Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Edit document rules" shows each rule category as two layers, **Guide (human)** and **Machine rules**, each with its own per-user overrides keyed by file + heading anchor; a selected human override is shown in the Annotation Guide drawer as a personal version and can be proposed upstream.

**Architecture:** `InterpretationRefKind.discover()` emits one descriptor per layer, grouped by category. Resource keys for interpretation refs become `strip_ref(file)#<heading-anchor>` for both layers (a line-range machine ref is mapped to the heading at its first line). Human originals are the heading *section*, not the whole file. Legacy keys are migrated: whole-file human overrides by a DB migration (sliced offline), line-range machine overrides lazily at runtime (needs the fetched file). Frontend groups descriptors by category into one submenu entry with layer tabs.

**Tech Stack:** FastAPI, SQLite (`DocumentRulesStore`), lxml; vanilla JS plugin with Shoelace + CodeMirror; Python `unittest`/pytest, `node --test`, Playwright E2E.

**Spec:** GitHub issue mpilhlt/pdf-tei-editor#666 ("Proposed design" §3 and §6, "Phases" 1). Decisions taken in the planning session (2026-10-26):

- A human override stores the **section** (heading line up to the next heading of the same or shallower level), not the whole file. The drawer and upstream proposals splice it back into the full file.
- One plan + PR per phase. This plan covers Phase 1 only. Phase 2 will locate the last synced human section by searching the guide file's history for the commit whose section hashes to the marker's `guide=` value; `base=` is only a search hint. Nothing in Phase 1 depends on that.

## Global Constraints

- Work in a worktree on branch `feat/666-two-layer-document-rules`, PR to `devel`. Commit messages reference `#666` but do not close it (later phases remain).
- Kind name stays `interpretation-ref`; schema kind keys are unchanged (`normalize_resource_key`).
- Layer values are exactly `"human"` and `"machine"`. Tab labels are exactly `Guide (human)` and `Machine rules`. Drawer badge text is exactly `Personal version`. Outdated-override tooltip text is exactly `Based on an older version of the original`.
- Every new or changed route gets matching methods/typedefs in `app/src/modules/api-client-v1.js` in the same commit.
- `representative_ref()` keeps its name and signature (pte-plugins imports it).
- JSDoc: `@import` blocks only, no inline `import()` types. Python: precise types, no bare `dict`/`tuple`.
- Run single Python tests with `uv run python -m pytest <file> -v`, single JS tests with `node --test <file>`; before finishing, `npm run test:unit` and `npm run test:e2e`.

## Review Focus

1. **Pre-#645 whole-file human overrides** reappear under the new human key. After migration they must contain only their section; one whose anchor is not found in its text is deleted, not shown as a giant "section". (Task 3)
2. **No separate machine file** (no `machine_url`: machine ref is a line range of the human file). Only the human layer is offered; its `related_urls` includes the machine ref, so clicking either `<ref>` opens the human tab, and the reviewer uses the human override. (Tasks 2, 5)
3. **Machine ref whose first line is not a heading** (hand-edited range, or file changed shape). Key falls back to the legacy line-range key; nothing is migrated or lost. (Task 1, 4)
4. **Heading anchor missing in the pinned file** for a human ref. `resolve_original` raises a clear error (502 "Heading #x not found in …") instead of returning the whole file. (Task 1, 4)
5. **Override created against an older pin.** Shown with the outdated marker, still selectable; an override with empty `base_hash` (migrated) is never marked outdated. (Task 4, 6)

---

### Task 1: Markdown section helpers

**Files:**
- Modify: `fastapi_app/lib/utils/annotation_rules_utils.py` (near `_scan_markdown_headings`, `translate_anchor_to_line_range`)
- Test: `tests/unit/fastapi/test_annotation_rules_utils.py`

**Interfaces:**
- Produces:
  - `markdown_section_range(text: str, anchor: str) -> Optional[tuple[int, int]]` — pure; 1-based inclusive range, same boundary rule as `translate_anchor_to_line_range` (which is refactored to call it).
  - `heading_anchor_at_line(text: str, line: int) -> Optional[str]` — slug of the heading on exactly `line`, else None.
  - `is_heading_anchor_fragment(fragment: str) -> bool` — non-empty and not a line range.
  - `fetch_rule_section(url: str, cache: UrlCache) -> str` — for a heading-anchor fragment, the section text; for line range / no fragment, same as `fetch_rule_excerpt`. Raises `RuleFetchError(f"Heading #{anchor} not found in {base_url}")` when the anchor is absent.
  - `splice_heading_section(full_text: str, anchor: str, section: str) -> str` — replaces the section's lines; raises `RuleFetchError` if absent. Implemented via `markdown_section_range` + `splice_line_range(full_text, f"L{start}-L{end}", section)`.

- [ ] **Step 1: Write failing tests** `TestMarkdownSections` with text `"# T\n\n## A\na1\n### A.1\na2\n## B\nb1\n"`:
  - `markdown_section_range(text, "a") == (3, 6)`, `(text, "b") == (7, 8)`, `(text, "missing") is None`, and a `## A` inside a ``` fence is ignored.
  - `heading_anchor_at_line(text, 3) == "a"`, `(text, 4) is None`.
  - `is_heading_anchor_fragment("a")`, not `("L3-L6")`, not `("")`.
  - `splice_heading_section(text, "a", "## A\nnew")` == `"# T\n\n## A\nnew\n## B\nb1\n"`; round-trip with the unchanged section returns `text`.
  - `fetch_rule_section` with a `UrlCache` pre-seeded via `cache.set_text(raw_url, text)` returns lines 3–6 for `…#a` and raises `RuleFetchError` for `…#missing`.
- [ ] **Step 2: Run** `uv run python -m pytest tests/unit/fastapi/test_annotation_rules_utils.py -v` — new tests FAIL (ImportError).
- [ ] **Step 3: Implement** the five functions; refactor `translate_anchor_to_line_range` onto `markdown_section_range`.
- [ ] **Step 4: Run** the same command — all PASS, including the existing `translate_anchor_to_line_range` tests.
- [ ] **Step 5: Commit** `feat(document-rules): markdown section helpers (#666)`.

### Task 2: Layered discovery and heading-anchor resource keys

**Files:**
- Modify: `fastapi_app/lib/doc_rules/kinds.py` (`ResourceDescriptor`, `ResourceKind`)
- Modify: `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`
- Modify: `fastapi_app/lib/models/models_document_rules.py` (`ResourceDescriptorModel`)
- Test: `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`, `tests/unit/fastapi/test_doc_rules_kinds.py`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces:
  - `ResourceDescriptor.layer: Optional[Literal["human", "machine"]] = None` and `ResourceDescriptor.group: Optional[str] = None` (both also on `ResourceDescriptorModel`, same defaults). `group` is `f"{kind}:{category}"` for interpretation refs.
  - `ResourceKind.resource_key(self, url: str) -> str` — non-abstract, default `normalize_resource_key(url)`.
  - `InterpretationRefKind.resource_key(url)`: heading-anchor fragment → `f"{strip_ref(base)}#{anchor}"` (i.e. `normalize_resource_key(url)`); line-range fragment → fetch full file (`fetch_rule_excerpt(base, cache)`), `anchor = heading_anchor_at_line(full, start)`; if found `normalize_resource_key(f"{base}#{anchor}")`, else `normalize_resource_key(url)`. Fetch failure → legacy key (log warning).
  - `legacy_resource_key(url: str) -> str` in `interpretation_ref_kind.py` = `normalize_resource_key(url)`.
  - `layer_refs(entry: AnnotationRuleRef) -> dict[Literal["human", "machine"], AnnotationRuleRefTarget]` — the layers an entry exposes: `human` = its human ref if any; `machine` = its machine ref only if there is no human ref, or the machine ref's base (fragment stripped, `strip_ref` applied) differs from the human ref's base.
  - `discover()` emits one descriptor per `layer_refs` item, in order human, machine. `related_urls`: human descriptor gets the human URL plus the machine URL when the machine layer was folded into it; machine descriptor gets only its own URL.
  - `InterpretationRefKind.resolve_original(url)` uses `fetch_rule_section`.

- [ ] **Step 1: Write failing tests** (replace `test_picks_machine_ref_when_both_present` / `test_related_urls_includes_both_human_and_machine_refs`):
  - `test_separate_machine_file_yields_two_layers`: entry with human `…/guidelines.md#citation-model` and machine `…/guidelines-llm.md#L28-L53` → two descriptors, layers `["human", "machine"]`, same `group == "interpretation-ref:primary"`, same label.
  - `test_same_file_machine_ref_folds_into_human_layer`: human `…/guide.md#a`, machine `…/guide.md#L3-L6` → one descriptor, `layer == "human"`, `related_urls == [human, machine]`.
  - `test_sole_machine_ref_is_machine_layer`.
  - `test_resource_key_maps_line_range_to_heading` (patch `fetch_rule_excerpt` to return a file with `## Citation model` on line 28) → key ends with `guidelines-llm.md#citation-model`; same key for `#L28-L60`.
  - `test_resource_key_falls_back_to_legacy_when_no_heading_at_start`.
  - `test_resolve_original_returns_section_for_heading_anchor` (patch `fetch_rule_section`).
  - In `test_doc_rules_kinds.py`: a minimal kind subclass gets the default `resource_key`.
- [ ] **Step 2: Run** `uv run python -m pytest tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py tests/unit/fastapi/test_doc_rules_kinds.py -v` — FAIL.
- [ ] **Step 3: Implement.** Update `representative_ref()`'s docstring only: it still picks the machine ref (used by `rules_refresh` and the reviewer fallback).
- [ ] **Step 4: Run** same — PASS.
- [ ] **Step 5: Commit** `feat(document-rules): human and machine layers per rule category (#666)`.

### Task 3: Migrate legacy whole-file human overrides

**Files:**
- Create: `fastapi_app/lib/core/migrations/versions/m011_document_rules_section_overrides.py` (follow `m009_document_rules_tables.py`'s class shape and registration)
- Test: `fastapi_app/lib/core/migrations/tests/test_migration_011.py`

**Interfaces:**
- Consumes: `markdown_section_range` (Task 1).
- Produces: after migration, every `resource_overrides` row with `kind = 'interpretation-ref'` whose `resource_key` fragment is a heading anchor holds only that section, with `base_hash = ''`. Rows whose anchor is not found in their text are deleted (selection cascades). Line-range and fragment-less rows are untouched. Idempotent.

- [ ] **Step 1: Write failing tests**: seed one heading-anchor row with a whole document (`"# T\n## A\na1\n## B\nb1"`, key `…/g.md#b`), one `#L1-L2` row, one `#missing` row; after `upgrade`: first text `== "## B\nb1"` and `base_hash == ''`; second unchanged; third gone; running `upgrade` twice changes nothing more.
- [ ] **Step 2: Run** `uv run python -m pytest fastapi_app/lib/core/migrations/tests/test_migration_011.py -v` — FAIL.
- [ ] **Step 3: Implement** the migration (`downgrade` is a no-op that logs; the original whole files are not recoverable).
- [ ] **Step 4: Run** same — PASS.
- [ ] **Step 5: Commit** `feat(document-rules): migrate whole-file human overrides to sections (#666)`.

### Task 4: Router and store: layer keys, lazy key migration, outdated flag, section proposals

**Files:**
- Modify: `fastapi_app/lib/doc_rules/storage.py`
- Modify: `fastapi_app/routers/document_rules.py`
- Modify: `fastapi_app/lib/doc_rules/rules_refresh.py` (`plan_resource_refresh` entry lookup)
- Modify: `fastapi_app/lib/models/models_document_rules.py`
- Modify: `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_doc_rules_storage.py`, `tests/unit/fastapi/test_document_rules_router.py`, `tests/unit/fastapi/test_doc_rules_rules_refresh.py`

**Interfaces:**
- Consumes: `ResourceKind.resource_key`, `legacy_resource_key`, `fetch_rule_section`, `splice_heading_section`.
- Produces:
  - `DocumentRulesStore.migrate_resource_key(kind: str, old_key: str, new_key: str) -> int` — moves all owners' overrides and selections from `old_key` to `new_key` when `new_key` has no rows for that owner yet; returns rows moved; no-op when keys are equal.
  - Router helper `_resource_key(kind: ResourceKind, url: str, store: DocumentRulesStore) -> str`: computes `kind.resource_key(url)`, calls `store.migrate_resource_key(kind.name, legacy_resource_key(url), key)` for `interpretation-ref`, returns key. Used by `/query`, `/overrides` (create), `/selection`, `/selection/reset`, `/selections` in place of `normalize_resource_key`.
  - `OverrideModel.outdated: bool = False` — `/query` sets it when `base_hash != ""` and `base_hash != sha256(original_text)`.
  - `POST /document-rules/selected-override` (reviewer/admin): request `ResourceRef{kind, url}`, response `SelectedOverrideResponse{override: Optional[OverrideModel]}`; no fetch of the original (`outdated` left False). Client: `documentRulesSelectedOverride(requestBody)`.
  - `/propose-change-url`: a heading-anchor fragment on a markdown URL is spliced with `splice_heading_section` into the fetched full file, like the existing line-range branch.
  - `plan_resource_refresh`: an entry matches when **any** of its refs' targets equals `url`.
  - `ResourceDescriptorModel` typedef in `api-client-v1.js` gains `layer` and `group`; `OverrideModel` gains `outdated`.

- [ ] **Step 1: Write failing tests:**
  - storage: `test_migrate_resource_key_moves_overrides_and_selection`; `test_migrate_resource_key_skips_owner_who_already_has_new_key_rows`.
  - router: `test_query_migrates_legacy_line_range_override` (create via store under the legacy key, patch `fetch_rule_excerpt`, query → override listed, selection preserved); `test_query_marks_outdated_override`; `test_query_does_not_mark_migrated_override_outdated` (empty base_hash); `test_selected_override_returns_selected_text_without_fetch` (assert `fetch_rule_excerpt` not called); `test_propose_change_url_splices_heading_section`; `test_query_unknown_heading_returns_502`.
  - rules_refresh: `test_plan_resource_refresh_matches_human_ref_url`.
- [ ] **Step 2: Run** `uv run python -m pytest tests/unit/fastapi/test_doc_rules_storage.py tests/unit/fastapi/test_document_rules_router.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v` — FAIL.
- [ ] **Step 3: Implement**, including the `api-client-v1.js` method and typedefs.
- [ ] **Step 4: Run** same plus `npm run test:unit:fastapi` — PASS.
- [ ] **Step 5: Commit** `feat(document-rules): heading-anchor override keys, outdated flag, section proposals (#666)`.

### Task 5: Reviewer reads the right layer (core helper + pte-plugins)

**Files:**
- Modify: `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`
- Test: `tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py`
- Modify (repo `mpilhlt/pte-plugins`, own branch + PR): `plugins/annotation-review/src/pte_plugin_annotation_review/review_logic.py` (`gather_rule_excerpts`), its `tests/test_review_logic.py`

**Interfaces:**
- Consumes: `layer_refs`, `InterpretationRefKind.resource_key`, `legacy_resource_key`, `DocumentRulesStore.migrate_resource_key`.
- Produces: `selected_rule_override_text(store: DocumentRulesStore, entry: AnnotationRuleRef, owner: str) -> Optional[str]` — the reviewer's layer is `machine` if `layer_refs(entry)` has it, else `human`; migrates its legacy key, returns the owner's selected override text or None.

- [ ] **Step 1: Write failing core tests:** `test_reviewer_uses_machine_layer_override_when_separate_file`; `test_reviewer_uses_human_layer_override_when_machine_folded`; `test_reviewer_ignores_human_override_when_separate_machine_file`.
- [ ] **Step 2: Run** `uv run python -m pytest tests/unit/fastapi/test_doc_rules_interpretation_ref_kind.py -v` — FAIL.
- [ ] **Step 3: Implement** the helper.
- [ ] **Step 4: Run** — PASS. Commit `feat(document-rules): reviewer override lookup by layer (#666)`.
- [ ] **Step 5: pte-plugins.** In `gather_rule_excerpts`, replace the `representative_ref` + `normalize_resource_key` lookup with `selected_rule_override_text(store, rule_ref, owner)`, imported inside `try`/`except ImportError` that falls back to the current code (older editor versions). Update the mocked-store tests (`get_selected_override_text` is still what the helper calls). Run the plugin tests per the pte-plugins README (`PTE_ROOT` pointing at the worktree). Commit `feat(annotation-review): use the editor's layer-aware override lookup (mpilhlt/pdf-tei-editor#666)`.

### Task 6: Editor dialog with layer tabs

**Files:**
- Modify: `app/src/templates/document-rules-editor-dialog.html`, `app/src/templates/document-rules-editor-dialog.types.js`
- Modify: `app/src/plugins/document-rules.js`
- Test: `tests/unit/js/document-rules.test.js`, `tests/unit/js/document-rules-editor-dialog-template.test.js`

**Interfaces:**
- Consumes: descriptors with `layer`/`group`, `OverrideModel.outdated`.
- Produces:
  - Template: `<sl-tab-group name="layerTabs">` above `overrideRow` with `<sl-tab slot="nav" panel="human" name="humanLayerTab">Guide (human)</sl-tab>` and `<sl-tab slot="nav" panel="machine" name="machineLayerTab">Machine rules</sl-tab>` (no panels needed beyond empty `sl-tab-panel`s; content stays in the shared bodies). Hidden unless the open group has two layers.
  - `_resourceGroups(): Array<Array<ResourceDescriptorModel>>` — `_resources` grouped by `group ?? url`, in first-seen order.
  - `_populateSubmenu()` — one item per group, label of its first descriptor; click → `_openResourceEditor(group[0])`.
  - `_currentGroup: Array<ResourceDescriptorModel>` set by `_openResourceEditor(resource)` to the resource's group; `sl-tab-show` on `layerTabs` calls `_openResourceEditor(<descriptor of that layer>)`. `_onRefDecorationClick(url)` opens the layer whose `url`/`related_urls` contains `url`, so the machine `<ref>` opens the machine tab.
  - `_renderOverrideRow()` — an override with `outdated` gets an `<sl-icon name="clock-history" slot="suffix">` and `title` `Based on an older version of the original` (note appended after a line break when present).
  - `_onReset()` — after refresh, set `_currentResource.url` to the refreshed ref whose `subtype` equals `_currentResource.layer ?? 'machine'` (replace the hard-coded machine preference); update each group member's `url`/`related_urls`.

- [ ] **Step 1: Write failing tests:** `_populateSubmenu` shows one item for a two-layer group; opening a grouped resource shows `layerTabs` with the active tab matching the layer; opening a single-layer resource hides `layerTabs`; switching tab queries the other layer's URL; `_onRefDecorationClick(machineUrl)` opens the machine descriptor; outdated override button has the clock icon and tooltip; `_onReset` on a human layer picks the refreshed human ref. Template test asserts `layerTabs`, `humanLayerTab`, `machineLayerTab` exist.
- [ ] **Step 2: Run** `node --test tests/unit/js/document-rules.test.js tests/unit/js/document-rules-editor-dialog-template.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same — PASS.
- [ ] **Step 5: Commit** `feat(document-rules): Guide (human) and Machine rules tabs in the rules editor (#666)`.

### Task 7: Personal version in the Annotation Guide drawer

**Files:**
- Modify: `app/src/templates/annotation-guide-drawer.html` (+ its `.types.js`), `app/src/plugins/annotation-guide.js`
- Modify: `app/src/modules/markdown-utils.js`
- Test: `tests/unit/js/` — the existing markdown-utils test file (create `markdown-utils-section.test.js` if none), `tests/e2e/tests/annotation-guide-toc.spec.js` stays green

**Interfaces:**
- Consumes: `documentRulesSelectedOverride` (Task 4).
- Produces:
  - `spliceMarkdownSection(markdown: string, anchor: string, section: string): string` in `markdown-utils.js` — same boundary rule as `markdown_section_range`, built on `findHeadingLineForAnchor`; returns `markdown` unchanged when the anchor is missing.
  - Drawer: `<sl-badge name="personalBadge" variant="primary" pill hidden>Personal version</sl-badge>` at the start of the footer. In `#renderGuide`, when the guide comes from the document's human ref, the user is reviewer or admin (`userHasRole`), and the URL has a heading anchor, call `documentRulesSelectedOverride({kind: 'interpretation-ref', url: markdownUrl})`; if an override is returned, splice its text into the fetched markdown before rendering, show the badge, set its `title` to the override note. Any error → render the original and log a warning.

- [ ] **Step 1: Write failing tests:** `spliceMarkdownSection` replaces `## A` section and keeps `## B`; missing anchor → unchanged; drawer unit test (or plugin-level test with mocked client) shows the badge and spliced text when an override is selected and hides it otherwise.
- [ ] **Step 2: Run** the new test files with `node --test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(annotation-guide): show the selected human override as a personal version (#666)`.

### Task 8: E2E, docs, full suite, screenshot

**Files:**
- Modify: `tests/e2e/tests/document-rules.spec.js`, fixture `tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml` if it lacks a separate-file machine ref (add a mocked route for both markdown files)
- Modify: `docs/user-manual/unit-review.md`, `docs/development/tei-header-integrations.md`

- [ ] **Step 1: Add E2E test** `edits a human override and a machine override in separate tabs`: open the rule category, create an override in `Guide (human)`, switch to `Machine rules`, verify the machine tab shows "Original" selected, create an override there, reopen and verify each tab keeps its own selection.
- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/tests/document-rules.spec.js` — PASS.
- [ ] **Step 3: Update docs**: user manual (two tabs, section-only human overrides, personal version in drawer, outdated marker, human proposals spliced into the file); `tei-header-integrations.md` (resource keys = file + heading anchor; layers; reviewer layer choice). Replace the #645 statement that human overrides are no longer used.
- [ ] **Step 4: Screenshot** `node scripts/dev/ui-screenshot.js --out <scratchpad>/rules-tabs.png --click '<Tools menu>' --click '<Edit document rules item>' …` and view it with Read.
- [ ] **Step 5: Run** `npm run test:unit` and `npm run test:e2e` — all PASS. Commit `docs(document-rules): two-layer editor (#666)`, push, open PR to `devel` (and the pte-plugins PR from Task 5).
