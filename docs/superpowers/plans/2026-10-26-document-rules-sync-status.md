# Document Rules Sync Status (Issue #666, Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core understands the `<!-- sync: … -->` markers that pair a human guide section with its condensed machine section, computes the pair's sync status, finds the guide commit of the last sync by hash, and shows the status in the "Edit document rules" dialog. The condensing prompt becomes a core default, which the plugin config can override per guide.

**Architecture:** A pure module `guide_sync.py` ports fossil's `check-llm-digest.py` hashing and adds marker parsing and the status computation. Two new forge-adapter methods (list a file's commits, URL at a commit) feed `find_synced_human_commit()`. That function walks the guide file's history and returns the newest commit whose section hashes to the marker's `guide=` value; `base=` only bounds the search. A reviewer/admin route `POST /document-rules/sync-status` computes the status for the texts the user currently uses (selected override, else the pinned original). The dialog shows it as a status line. `DocumentRulesProvider` gains an optional `get_condense_prompt()`; the GROBID plugin implements it from an optional `condense_prompt` field in `annotation_guides.py`.

**Tech Stack:** FastAPI, requests + `UrlCache`, lxml; vanilla JS + Shoelace; pytest/unittest, `node --experimental-test-module-mocks --test`, Playwright.

**Spec:** GitHub issue mpilhlt/pdf-tei-editor#666, "Proposed design" §1 and §2, and "Phases" 2. Decisions from planning (2026-10-26):

- The last-synced human section is found **by hash**. Core searches the guide file's history (newest first) for the commit whose section hashes to the marker's `guide=` value; `base=<commit>` is an optional hint where to stop. Reason: an upstream proposal cannot know the merge commit.
- The status describes the texts the **user currently uses**: their selected override for each layer, else the document's pinned original. So a personal human edit shows up as "machine rules outdated".

Phase 1 (merged in #668, #669) built the layers. Use its APIs, all in `fastapi_app/lib/doc_rules/interpretation_ref_kind.py` and `fastapi_app/lib/utils/annotation_rules_utils.py`:
- `layer_refs(entry)` and `InterpretationRefKind.resource_key(url, strict=…)`;
- `resolve_original(url)`, which returns the heading section or line-range excerpt, with relative links rewritten to absolute;
- `markdown_section_range`;
- `derelativize_markdown_urls(text, base_url)`;
- `DocumentRulesStore.get_selected_override_text`.

## Global Constraints

- Branch `feat/666-phase2-sync-status` (worktree `/Users/cboulanger/Code/pdf-tei-editor/.claude/worktrees/feat+666-two-layer-document-rules`), PR to `devel`. Commits reference `#666` without closing it.
- Hashing must be byte-for-byte the algorithm of fossil's `scripts/check-llm-digest.py` (`section_hash`: remove the sync comment, drop blank lines, `rstrip` each line, join with `\n`, SHA-256 hex). Hash the human section **after** `derelativize_markdown_urls(text, human_url)`, because core rewrites relative links on fetch.
- Marker regex accepts an optional base: `<!-- sync: guide=<hex> llm=<hex>( base=<hex>)? -->`.
- `SyncStatus` values are exactly `"in_sync"`, `"machine_outdated"`, `"machine_edited"`, `"both_changed"`, `"no_marker"`.
- Status-line copy, exact:
  - `in_sync` → `In sync with the guide`
  - `machine_outdated` → `Machine rules outdated: the guide changed since the last sync`
  - `machine_edited` → `Machine rules edited by hand since the last sync`
  - `both_changed` → `Machine rules outdated and edited by hand`
  - `no_marker` → `No sync marker`
- Default condensing prompt, exact text (`DEFAULT_CONDENSE_PROMPT`): `You maintain a condensed version of annotation guidelines for language models. Write terse rules and tables; no rationale, no links, few and short examples. Keep every rule, element and attribute value. Write attribute values out one by one (`@type` is one of `court`, `legislature`), never as `type="a|b"`, which a model may copy literally. Keep the section heading exactly as it is.`
- `api-client-v1.js` is updated in the same commit as any route change. JSDoc `@import` only. Precise Python types.
- pte-plugins changes go on the branch `feat/666-condense-prompt` in a separate pte-plugins worktree. Its tests must pass against editor `devel` **and** this branch (plugin CI runs against `devel`): guard new-core-only tests with an import check, as in `test_review_logic.py`'s `EDITOR_HAS_LAYER_LOOKUP`.
- Single tests: `uv run python -m pytest <file> -v`; `node --experimental-test-module-mocks --test <file>`. Before finishing: `npm run test:unit` and `npm run test:e2e`.

## Review Focus

1. **Relative links in the human guide** (fossil's `guidelines.md` has three). Without derelativizing, every hash mismatches and every pair reads "outdated". (Task 1's golden test exercises the fetch → rewrite → derelativize path.)
2. **CRLF or trailing whitespace** in fetched files must not change hashes, because `section_hash` normalizes. (Task 1)
3. **Commit listing fails** (GitHub's unauthenticated rate limit, 403, network). `/sync-status` must still return the status, with `synced_commit: null`, not an error. (Tasks 3, 4)
4. **Machine section without a marker, or with a malformed marker** → `no_marker`, never a 500. (Tasks 1, 4)
5. **Category without a separate machine file** (no `machine_url`): there is no pair, so no status request and no status line. (Tasks 4, 6)

---

### Task 1: `guide_sync.py`, the marker and hashing port, with a golden test against fossil

**Files:**
- Create: `fastapi_app/lib/doc_rules/guide_sync.py`
- Create: `tests/unit/fastapi/fixtures/fossil/guidelines.md`, `tests/unit/fastapi/fixtures/fossil/guidelines-llm.md`. Copy them verbatim from `https://raw.githubusercontent.com/mpilhlt/fossil/eab669d4d093c54dd1990b4a0bf017d00f82d5a8/docs/…` (check first that fixtures dirs exist, and follow their convention).
- Test: `tests/unit/fastapi/test_doc_rules_guide_sync.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class SyncMarker: guide_hash: str; llm_hash: str; base: Optional[str]`
  - `SyncStatus = Literal["in_sync", "machine_outdated", "machine_edited", "both_changed", "no_marker"]`
  - `parse_sync_marker(machine_section: str) -> Optional[SyncMarker]`
  - `format_sync_marker(marker: SyncMarker) -> str`, which returns the comment line without a trailing newline and omits ` base=` when `base` is None.
  - `section_hash(text: str) -> str`, ported verbatim from fossil.
  - `human_section_hash(section: str, human_url: str) -> str`, which equals `section_hash(derelativize_markdown_urls(section, human_url))`.
  - `sync_status(human_section: str, machine_section: str, human_url: str) -> SyncStatus`, where outdated means the guide hash differs and edited means the llm hash differs.

- [ ] **Step 1: Write failing tests**
  - `test_golden_fossil_sections_are_in_sync`: for each of `data-correction`, `document-segmentation-model`, `reference-segmentation-model` and `citation-model`, slice both fixture files with `markdown_section_range`. With `human_url = "https://github.com/mpilhlt/fossil/blob/eab669d4d093c54dd1990b4a0bf017d00f82d5a8/docs/guidelines.md"`, pass the human section through the module's relative-link rewrite (`_rewrite_relative_markdown_urls(text, <raw dir url>)`), as `fetch_rule_excerpt` does. Assert `sync_status(...) == "in_sync"`.
  - `test_human_change_is_outdated` (append a line to the human section), `test_machine_change_is_edited`, `test_both_changed`, `test_missing_marker_is_no_marker`, `test_malformed_marker_is_no_marker`.
  - `test_parse_marker_with_base` / `without_base`, and `format_sync_marker` round trip.
  - `test_hash_ignores_crlf_trailing_whitespace_and_blank_lines`.
- [ ] **Step 2: Run** `uv run python -m pytest tests/unit/fastapi/test_doc_rules_guide_sync.py -v` and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again and expect PASS. If the golden test fails, compare against `python3 /Users/cboulanger/Code/fossil/scripts/check-llm-digest.py` logic; don't change the expected values.
- [ ] **Step 5: Commit** `feat(document-rules): sync marker parsing and hashing (#666)`.

### Task 2: Forge adapters, file history and URL at a commit

**Files:**
- Modify: `fastapi_app/lib/core/git_forge_adapters.py` (`BaseGitForgeAdapter`, `GitHubAdapter`, `GitLabAdapter`)
- Test: the existing forge adapter test file in `tests/unit/fastapi/` (find it via `@testCovers`)

**Interfaces:**
- Produces:
  - `BaseGitForgeAdapter.list_file_commits(self, url: str, cache: UrlCache, limit: int = 50) -> list[str]`. It returns full commit SHAs that touched the file, newest first, on the URL's ref if that is a branch, else on the default branch.
    - GitHub: `GET https://api.github.com/repos/{o}/{r}/commits?path=<path>&sha=<ref>&per_page=<limit>`.
    - GitLab: `GET {origin}/api/v4/projects/{enc}/repository/commits?path=<path>&ref_name=<ref>&per_page=<limit>`.
    - The result is cached as JSON text under `f"{api_url}/_file_commits/{ref}/{path}"` with the normal TTL. It raises on HTTP errors; callers handle them.
  - `BaseGitForgeAdapter.url_at_commit(self, url: str, sha: str) -> str`: the same blob URL with its ref replaced by `sha`, keeping any fragment.

- [ ] **Step 1: Write failing tests** with `requests.get` patched. For each adapter, check the request URL and params, the SHA list order, cache reuse (one HTTP call for two invocations), and `url_at_commit` for a branch URL and a SHA URL, with and without a fragment.
- [ ] **Step 2: Run** and expect FAIL. **Step 3: Implement.** **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(forge): list a file's commits and build URLs at a commit (#666)`.

### Task 3: `find_synced_human_commit`

**Files:**
- Modify: `fastapi_app/lib/doc_rules/guide_sync.py`
- Test: `tests/unit/fastapi/test_doc_rules_guide_sync.py`

**Interfaces:**
- Consumes: Task 1 `human_section_hash` and `SyncMarker`; Task 2 adapter methods; `fetch_rule_excerpt`; `markdown_section_range`.
- Produces: `find_synced_human_commit(human_url: str, marker: SyncMarker, cache: UrlCache, limit: int = 50) -> Optional[str]`.
  - `human_url` is a heading-anchor blob URL. For each SHA from `list_file_commits` (newest first), it fetches the file at `url_at_commit(base, sha)`, slices the anchor's section, and returns the SHA whose `human_section_hash` equals `marker.guide_hash`.
  - It stops after checking `marker.base` if that SHA is reached.
  - It returns None when nothing matches, the anchor is absent, there is no adapter, or any listing or fetch error occurs (log a warning; never raise).
  - Pinned fetches are cached forever via the existing `is_sha_pinned` behaviour of `fetch_rule_excerpt`.

- [ ] **Step 1: Write failing tests** (patch `list_file_commits` and `fetch_rule_excerpt` per URL):
  - the match is the second-newest commit;
  - there is no match;
  - the search stops at `base`;
  - a listing `HTTPError` gives None without raising;
  - the anchor is missing in an old commit, which is skipped and the search continues.
- [ ] **Step 2–4:** FAIL, then implement, then PASS.
- [ ] **Step 5: Commit** `feat(document-rules): find the guide commit of the last sync by hash (#666)`.

### Task 4: `POST /document-rules/sync-status`

**Files:**
- Modify: `fastapi_app/routers/document_rules.py`, `fastapi_app/lib/models/models_document_rules.py`, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_document_rules_router.py`

**Interfaces:**
- Consumes: Tasks 1 and 3; `InterpretationRefKind.resource_key` (lenient) and `resolve_original`; `store.get_selected_override_text`.
- Produces:
  - Request `SyncStatusRequest{human_url: str, machine_url: str}`.
  - Response `SyncStatusResponse{status: SyncStatus, human_source: Literal["original", "override"], machine_source: Literal["original", "override"], base: Optional[str], synced_commit: Optional[str]}`.
  - The route is a plain `def` (threadpool, because it fetches), gated by `require_reviewer_or_admin`.
  - Each layer's text is the caller's selected override if there is one, else `resolve_original(url)`.
  - `synced_commit` is computed only for `machine_outdated` and `both_changed`, and only when the marker exists; otherwise it is null.
  - A resolve failure gives 502. Parsing never raises.
  - Client: `documentRulesSyncStatus(requestBody)`, with typedefs `SyncStatusRequest` and `SyncStatusResponse`.

- [ ] **Step 1: Write failing tests:**
  - `in_sync` for originals (patch `resolve_original` with golden fixture sections);
  - `machine_outdated` when the caller selected a human override, with `human_source == "override"`;
  - `synced_commit` returned for outdated (patch `find_synced_human_commit`) and null for `in_sync`;
  - `no_marker`;
  - 403 for a non-reviewer.
- [ ] **Step 2–4:** FAIL, then implement, then PASS. Then run `npm run test:unit:fastapi`.
- [ ] **Step 5: Commit** `feat(document-rules): sync status route (#666)`.

### Task 5: Condensing prompt, core default and per-guide override (core + pte-plugins)

**Files:**
- Create: `fastapi_app/lib/doc_rules/condense_prompt.py`
- Modify: `fastapi_app/lib/doc_rules/rules_providers.py`
- Test: `tests/unit/fastapi/test_doc_rules_condense_prompt.py`
- pte-plugins: `plugins/grobid/src/pte_plugin_grobid/config/annotation_guides.py`, `plugins/grobid/src/pte_plugin_grobid/annotation_rules.py` (`GrobidRulesProvider`), and its tests.

**Interfaces:**
- Produces (core):
  - `DEFAULT_CONDENSE_PROMPT: str`, exact text from Global Constraints.
  - `DocumentRulesProvider.get_condense_prompt(self, guide_url: str) -> Optional[str]`, documented as optional. Core calls it via `getattr`, so older plugins without it still work.
  - `resolve_condense_prompt(xml_string: str, guide_url: str) -> str`: the provider's prompt for the document's extractor if it returns one, else `DEFAULT_CONDENSE_PROMPT`.
- Produces (plugin):
  - `AnnotationGuide.condense_prompt: NotRequired[str]`.
  - `GrobidRulesProvider.get_condense_prompt(guide_url)` returns the `condense_prompt` of the guide whose `url` matches `guide_url`. Compare both via `normalize_resource_key` after dropping the fragment, so a pinned URL matches the branch URL. Otherwise it returns None.
  - No guide in the shipped config sets `condense_prompt`.
- No route uses the prompt yet; Phase 3 does.

- [ ] **Step 1: Core failing tests:**
  - default when there is no provider;
  - default when the provider lacks the method (a plain object);
  - the provider's value when it returns one;
  - default when it returns None.
- [ ] **Step 2–4:** FAIL, then implement, then PASS. Commit `feat(document-rules): default condensing prompt with per-guide override hook (#666)`.
- [ ] **Step 5: Plugin.** Create the pte-plugins worktree: `git -C /Users/cboulanger/Code/pte-plugins fetch origin`, then `git -C /Users/cboulanger/Code/pte-plugins worktree add -b feat/666-condense-prompt /Users/cboulanger/Code/pte-plugins/.claude/worktrees/feat-666-condense-prompt origin/main`. Don't touch the main pte-plugins checkout.
  - Tests: a pinned URL matches; another guide returns None.
  - Guard the tests that need the new core hook with an import check.
  - Run against this core worktree: `PYTHONPATH=<core>:<plugin>/plugins/grobid/src uv run python -m pytest <plugin>/plugins/grobid/src/pte_plugin_grobid/tests`, from the core worktree.
  - Commit `feat(grobid): optional per-guide condensing prompt (mpilhlt/pdf-tei-editor#666)`. Don't push.

### Task 6: Status line in the editor dialog

**Files:**
- Modify: `app/src/templates/document-rules-editor-dialog.html` (then `npm run build:ui-types`; don't hand-edit `.types.js`), `app/src/plugins/document-rules.js`
- Test: `tests/unit/js/document-rules.test.js`, `tests/unit/js/document-rules-editor-dialog-template.test.js`

**Interfaces:**
- Consumes: `documentRulesSyncStatus` (Task 4) and the group/layer model from Phase 1 (`_currentGroup`).
- Produces:
  - Template: `<div name="syncStatus" style="display: none; margin-bottom: 0.75rem; font-size: var(--sl-font-size-small);"></div>` directly below `layerTabs`.
  - `SYNC_STATUS_TEXT`: a frozen map from status to the exact copy in Global Constraints.
  - `async _refreshSyncStatus(): Promise<void>`.
    - It hides the line unless `_currentGroup` has both a human and a machine descriptor.
    - Otherwise it requests the status for the two URLs and shows the text, with the variant icon `check-circle` for `in_sync` and `exclamation-triangle` otherwise.
    - When `synced_commit` is present, it appends ` (last sync: <sha7>)`.
    - On error it hides the line and logs a warning.
  - It is called after `_openResourceEditor`, after a successful `_selectOverride`, `_onSave`, `_onDelete` and `_onReset`.
  - It ignores stale responses: compare a request counter, so a slow response for an earlier group or selection can't overwrite a newer one.

- [ ] **Step 1: Write failing tests:**
  - the line is hidden for a single-layer group;
  - it shows the exact text for each of the five statuses;
  - the ` (last sync: abc1234)` suffix appears;
  - the line is refreshed after `_selectOverride`;
  - a stale response is ignored;
  - an error hides the line;
  - the template test asserts `syncStatus` exists.
- [ ] **Step 2–4:** FAIL, then implement, then PASS. Then run `npm run test:unit:js`.
- [ ] **Step 5: Commit** `feat(document-rules): sync status line in the rules editor (#666)`.

### Task 7: E2E, docs, full suite, screenshot

**Files:**
- Modify: `tests/e2e/tests/document-rules.spec.js`. Extend the two-layer test's local markdown server so the machine file carries a valid marker for the human fixture section; compute the hashes in the test with the same algorithm, or precompute them and add a comment.
- Modify: `docs/user-manual/unit-review.md` (what the status line means), `docs/development/tei-header-integrations.md` (marker format with `base`, the hashing rule including derelativizing, history search by hash, `/sync-status`, the condensing prompt hook).

- [ ] **Step 1: E2E** `shows the sync status of a two-layer category`:
  - the line reads `In sync with the guide`;
  - after creating and selecting a human override with changed text, it reads `Machine rules outdated: the guide changed since the last sync`.
- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/tests/document-rules.spec.js` and expect PASS.
- [ ] **Step 3: Docs.**
- [ ] **Step 4: Screenshot.** Use `node scripts/dev/ui-screenshot.js` if Docker is available, else a temporary Playwright screenshot from the E2E test (removed afterwards). Save it in the session scratchpad and view it.
- [ ] **Step 5: Run** `npm run test:unit` and `npm run test:e2e` and expect all PASS. Commit `docs(document-rules): sync status (#666)`.
