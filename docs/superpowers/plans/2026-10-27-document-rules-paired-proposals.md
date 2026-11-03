# Document Rules Paired Upstream Proposals (Issue #666, Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a two-layer category in "Edit document rules", a reviewer can propose the human guide section, the machine rules, or both upstream as one downloadable patch. When the machine rules are included, the sync marker is recomputed, so the pair is valid in the guide repository and fossil's CI check passes.

**Architecture:**
- A backend module `upstream_proposal.py` builds the proposal.
  - It takes each included layer's text (the user's selected override, otherwise the original) and converts it back to repository form with `derelativize_markdown_urls`.
  - It fetches the current file on the guide repository's default branch and splices the section in by heading anchor. Splicing by anchor survives line shifts, unlike line ranges.
  - For the machine file it replaces the sync marker. It produces a `git apply`-compatible unified diff over the changed files.
- A reviewer/admin route `POST /document-rules/propose-patch` returns the per-file before/after texts and the patch.
- A "Propose upstream" sub-dialog for two-layer groups shows:
  - checkboxes for the two layers;
  - a per-file diff;
  - "Download patch".
- Single-layer resources keep the existing forge-edit-page flow (`/propose-change-url`).

**Tech Stack:** FastAPI, `difflib`, `UrlCache`, forge adapters; vanilla JS + Shoelace + `@codemirror/merge`; pytest via the unittest runner, `node --experimental-test-module-mocks --test`, Playwright.

**Spec:** GitHub issue mpilhlt/pdf-tei-editor#666, "Proposed design" §5, "Decisions" 2–3, "Phases" 4.

Planning decisions (2026-10-27):

- **No `base=` field.** Proposals write `<!-- sync: guide=<sha256> llm=<sha256> -->` without `base=`. That is exactly fossil's current format, so `scripts/check-llm-digest.py` keeps passing and Phase 5 has no ordering constraint. The last sync is still found by hash (Phase 2).
- **Marker rule:**
  - *Human only:* the machine file and its marker are untouched. After merge, the pair reads "machine rules outdated".
  - *Machine included* (alone or with human): the marker is recomputed. `guide` is `human_section_hash` of the human section after the proposal, that is, the proposed human text or else the current upstream human section. `llm` is `section_hash` of the proposed machine section. Including the machine rules asserts that the pair is in sync.
- **Transport:** patch download only. The server-side branch + PR with a stored GitHub token becomes a separate later plan (Phase 4b).
- **Base of the patch:** the current file on the repository's default branch, not the document's pinned commit. The section is spliced by heading anchor, so the patch applies to today's upstream.

Phases 1–3 are merged. APIs to use:

- `fastapi_app/lib/doc_rules/guide_update.py`: `layer_text(kind, url, store, owner) -> (text, source)`, which raises `OriginalUnavailableError`.
- `fastapi_app/lib/doc_rules/guide_sync.py`: `split_sync_marker`, `format_sync_marker`, `SyncMarker`, `section_hash`, `human_section_hash`, `sync_status`.
- `fastapi_app/lib/utils/annotation_rules_utils.py`: `derelativize_markdown_urls`, `fetch_rule_excerpt`, `markdown_section_range`, `heading_anchor_at_line`, `splice_heading_section`, `is_line_range_fragment`, `line_range_start`.
- `GitForgeAdapterRegistry` adapters: `parse_repo_path`, `strip_ref`, `url_at_commit`, the private `_default_branch`, `is_sha_pinned`.
- The router helpers `_interpretation_ref_kind()` and `_layer_text_or_502` in `fastapi_app/routers/document_rules.py`.
- Frontend `app/src/plugins/document-rules.js`:
  - `_currentGroup`, `_currentPair()` and `_onProposeUpstream()`, which is the existing single-file flow;
  - the "Update from guide" sub-dialog as the pattern for a sub-dialog with merge views: session counter, `_createMergeView` and reset on hide.

## Global Constraints

- **Branch and PR.** Use branch `feat/666-phase4-paired-proposals` in the worktree `/Users/cboulanger/Code/pdf-tei-editor/.claude/worktrees/feat+666-two-layer-document-rules`. Open the PR to `devel`. Commits reference `#666` and must not close it.
- **Access.** The route is gated by `require_reviewer_or_admin`, and is a plain `def` because it fetches.
- **Marker format.** Exactly `format_sync_marker(SyncMarker(guide_hash=…, llm_hash=…, base=None))`, so no `base=` is ever written. It sits on its own line directly after the machine section's heading, separated by one blank line on each side. That is fossil's layout, as in `docs/guidelines-llm.md`.
- **Patch format.** A plain unified diff that `git apply` accepts at the repository root:
  - a preamble of lines starting with `# ` (git ignores text before the first `diff --git`):
    - `# Annotation rules update: <category label>`
    - `# Proposed with the PDF-TEI-Editor by <username>`
    - `# Includes: guide section` / `machine rules` / `guide section and machine rules`
  - then, per changed file, `diff --git a/<path> b/<path>`, `--- a/<path>`, `+++ b/<path>`, and the hunks with 3 lines of context;
  - files in the order human, machine;
  - a trailing newline handled correctly, including `\ No newline at end of file` when the upstream file has none.
- **Download file name.** `<category-slug>-rules.patch`. The slug is the lowercased label with runs of non-alphanumerics replaced by `-`.
- **Errors.**
  - The two files are in different repositories → 422 `The guide and the machine rules are in different repositories; propose them separately.`
  - Nothing would change → 422 `There are no changes to propose.`
  - No layer included → 422 `Select at least one of the guide section and the machine rules.`
  - A heading anchor is not found in the current upstream file → 422 `The section "<anchor>" no longer exists in <path> on <branch>.`
  - A fetch or resolve failure → 502.
- **UI copy, exact:**
  - sub-dialog label: `Propose upstream`
  - checkboxes: `Guide section (human)` and `Machine rules`
  - per-file heading: the repository path, e.g. `docs/guidelines.md`
  - download button: `Download patch`
  - notice when the human layer is included and the machine layer is not: `The machine rules will be marked as outdated until they are updated from the guide.`
  - notice when the machine layer is included: `The sync marker is updated: the machine rules are marked as in sync with the guide.`
  - apply hint, always shown: `Apply the patch in a clone of the guide repository with "git apply <file>", then commit and open a pull request.`
- **API client and code style.**
  - `api-client-v1.js` is updated in the same commit as the route.
  - JSDoc `@import` only.
  - Precise Python types.
  - Templates' `.types.js` are regenerated with `npm run build:ui-types`.
- **Tests.**
  - Python tests are `unittest.TestCase`, because the runner only collects those. Run them with `uv run python -m pytest <file> -v`.
  - JS: `node --experimental-test-module-mocks --test <file>`.
  - Before finishing, run `npm run test:unit`, then `npm run test:e2e`, one at a time.

## Review Focus

1. **Upstream moved since the pin.** Splicing by heading anchor into the default-branch file must apply cleanly to today's upstream. A golden test applies the patch with `git apply --check` to a temporary repository holding the fixture files. (Task 1)
2. **Marker correctness.** After a machine-included proposal is applied, `sync_status` on the resulting sections is `in_sync`. Test this with the fossil fixtures. (Task 1)
3. **Link form.** Overrides hold absolute same-repo links, so the patch must contain the relative, repository form, and the unchanged parts of the file must not show up in the diff. (Task 1)
4. **Machine ref is a line range.** Its heading anchor comes from the line at the start of the pinned range. If that line is not a heading → 422 with a clear message. (Task 1)
5. **Nothing selected, or nothing changed.** Readable 422s, which the dialog shows. Download stays disabled until a proposal exists. (Tasks 2, 3)

---

### Task 1: `upstream_proposal.py`: build the files and the patch

**Files:**
- Create: `fastapi_app/lib/doc_rules/upstream_proposal.py`
- Modify:
  - `fastapi_app/lib/doc_rules/guide_sync.py`: add `with_sync_marker`, and reuse it in `guide_update.clean_model_answer` instead of its inline insertion code.
  - `fastapi_app/lib/core/git_forge_adapters.py`: add `url_at_default_branch`.
- Test:
  - `tests/unit/fastapi/test_doc_rules_upstream_proposal.py`
  - `tests/unit/fastapi/test_doc_rules_guide_sync.py`
  - `tests/unit/fastapi/test_git_forge_adapters.py`

**Interfaces:**
- Produces:
  - `with_sync_marker(text: str, marker_line: str) -> str` (guide_sync.py). It removes every existing marker, then places `marker_line` after the first heading line in fossil's layout, or at the top if there is no heading. `clean_model_answer` must keep its current behaviour, and the existing tests must stay green.
  - `BaseGitForgeAdapter.url_at_default_branch(self, url: str, cache: UrlCache) -> str`. It replaces the ref with the repository's default branch and keeps the fragment. GitHub and GitLab implement it with their `_default_branch`. The default body raises `NotImplementedError`, like the history methods.
  - In upstream_proposal.py:
    - `@dataclass(frozen=True) class ProposedFile: path: str; before: str; after: str` (whole files, repository form).
    - `@dataclass(frozen=True) class UpstreamProposal: files: list[ProposedFile]; patch: str; filename: str; branch: str`
    - `class ProposalError(Exception)`. Its message is one of the 422 texts in Global Constraints.
    - `section_anchor(url: str, cache: UrlCache) -> str`. For a heading-anchor URL it returns the anchor. For a line-range URL it fetches the pinned file and uses `heading_anchor_at_line` at the range start. It raises `ProposalError` when no anchor can be found.
    - `build_upstream_proposal(kind: InterpretationRefKind, human_url: str, machine_url: str, include_human: bool, include_machine: bool, store: DocumentRulesStore, owner: str, label: str, cache: UrlCache) -> UpstreamProposal`. Its algorithm:
      1. Validate the selection.
      2. Check that both URLs resolve to the same `repo_id` via `parse_repo_path`. Do this only when both layers are involved, i.e. `include_machine` is set; a human-only proposal needs the human repository alone.
      3. Get each included layer's text with `layer_text`, then `derelativize_markdown_urls(text, url)` and CRLF → LF.
      4. Fetch the default-branch file for each touched path via `url_at_default_branch`, without a fragment, as `before`.
      5. Splice:
         - Human: `splice_heading_section(before, human_anchor, human_text)`.
         - Machine:
           1. Strip the markers from the machine text.
           2. Compute `guide = human_section_hash(human_after_section, human_url)`, where `human_after_section` is the proposed human text if included, else the section sliced from the default-branch human file.
           3. Compute `llm = section_hash(machine_text_without_marker)`.
           4. `with_sync_marker(machine_text, format_sync_marker(SyncMarker(guide, llm, None)))`.
           5. `splice_heading_section(before, machine_anchor, that)`.
      6. Drop files where `after == before`. If none remain, raise `ProposalError("There are no changes to propose.")`.
      7. Build the patch.
    - `build_patch(files: list[ProposedFile], label: str, username: str, includes: str) -> str`. Uses `difflib.unified_diff` with `a/`/`b/` paths and `n=3`, plus the preamble and the `\ No newline at end of file` handling from Global Constraints.

- [ ] **Step 1: Write the failing tests.** Use the fossil fixtures in `tests/unit/fastapi/fixtures/fossil/` as the default-branch files, patching the fetch per URL.
  - Human-only: only `docs/guidelines.md` changes, and the machine file is untouched.
  - Machine-only: the marker is recomputed, `base=` is absent, and `sync_status(new human section, new machine section, …)` is `in_sync`.
  - Both: two files in human→machine order, and the result reads `in_sync`.
  - A human override containing absolute same-repo links produces relative links in `after`, and no other lines change.
  - The upstream file has extra lines inserted above the section, simulating a moved upstream. The patch still targets the right section.
  - Golden: write the fixtures into a temporary `git init` repository, run `git apply --check` with the generated patch via `subprocess`, then apply it and compare against `after`. Skip the test if `git` is not on PATH.
  - A line-range machine URL whose start line is not a heading → `ProposalError`.
  - Different repositories, no selection, no changes, and a missing anchor upstream → the exact messages.
  - `with_sync_marker`: no marker yet, a marker already present, no heading.
  - `url_at_default_branch` for GitHub and GitLab, with a pinned SHA and a fragment.
- [ ] **Steps 2–4:** run the tests and watch them FAIL; implement; watch them PASS. The `clean_model_answer` tests must stay green.
- [ ] **Step 5: Commit** `feat(document-rules): build paired upstream proposals as a patch (#666)`.

### Task 2: Route `POST /document-rules/propose-patch`

**Files:**
- Modify: `fastapi_app/routers/document_rules.py`, `fastapi_app/lib/models/models_document_rules.py`, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_document_rules_router.py`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - Request `ProposePatchRequest{human_url: str, machine_url: str, include_human: bool, include_machine: bool, label: str}`.
  - Response `ProposePatchResponse{files: list[ProposedFileModel{path: str, before: str, after: str}], patch: str, filename: str, branch: str}`.
  - The route is a plain `def`, gated by `require_reviewer_or_admin`.
  - Error mapping: `ProposalError` → 422 with its message; `OriginalUnavailableError` and fetch failures → 502.
  - Client: `documentRulesProposePatch(requestBody)` plus the typedefs.
- [ ] **Step 1: Write the failing tests:**
  - a human-only 200 response with one file;
  - both layers → two files and a patch containing two `diff --git` headers;
  - the 422 messages;
  - 403 for a non-reviewer.
- [ ] **Steps 2–4:** FAIL, implement, PASS. Then run `npm run test:unit:fastapi`.
- [ ] **Step 5: Commit** `feat(document-rules): propose-patch route (#666)`.

### Task 3: "Propose upstream" sub-dialog

**Files:**
- Create: `app/src/templates/document-rules-propose-dialog.html`. Its `.types.js` file is generated.
- Modify: `app/src/plugins/document-rules.js`
- Test: `tests/unit/js/document-rules.test.js`, and a template test for the new dialog.

**Interfaces:**
- Consumes: `documentRulesProposePatch`, and `_currentPair()`, `_currentGroup` and the sub-dialog patterns from Phase 3.
- Produces:
  - Template `<sl-dialog name="documentRulesProposeDialog" label="Propose upstream" style="--width: 80vw;">` with these parts:
    - `includeHuman`: `<sl-checkbox>` with the text `Guide section (human)`;
    - `includeMachine`: `<sl-checkbox>` with the text `Machine rules`;
    - `notice`: a div for the notices;
    - `files`: a container. For each file it holds a heading with the path and a merge view;
    - `hint`: the apply hint;
    - footer: `downloadBtn` (`Download patch`, disabled until a proposal exists) and `closeBtn` (`Close`).
  - In a two-layer group, the existing `proposeUpstreamBtn` opens this dialog through `_openProposeDialog()`, and is visible whenever the document isn't read-only. Single-layer resources keep `_onProposeUpstream()` unchanged, with the old visibility rule.
  - `_openProposeDialog()`:
    - preselects each checkbox whose layer has a selected override, and falls back to the current tab's layer if neither has one;
    - then calls `_refreshProposal()` and shows the dialog.
  - `_refreshProposal()`:
    - runs on open and on every checkbox change;
    - guards against stale responses with a session counter;
    - calls the route with `label: <group label>`;
    - renders one read-only unified merge view per file (`before` → `after`) under its path heading;
    - sets the notices according to the selection;
    - enables `downloadBtn`.
    - On a 422 or 502 it clears the files, disables download and shows the message in `notice`. This is not a toast, because selecting nothing is a normal state.
  - `_onDownloadPatch()` builds a `Blob` (`text/x-diff`) from `patch` and downloads it as `filename` through a temporary `<a download>`. Use the same pattern if the app already has a download helper: search for an existing one first.
  - Merge views are destroyed when the sub-dialog closes.
- [ ] **Step 1: Write the failing tests:**
  - in a two-layer group the button opens the new dialog; in a single-layer group it uses the old flow;
  - checkbox preselection;
  - toggling a checkbox requests again with the new flags;
  - a stale response is dropped;
  - a 422 shows the message inline and disables download;
  - download creates a Blob with the patch and the file name;
  - the notices per selection, with exact copy;
  - template tests for the parts and the copy.
- [ ] **Steps 2–4:** FAIL, implement, PASS. Then run `npm run test:unit:js`.
- [ ] **Step 5: Commit** `feat(document-rules): "Propose upstream" dialog with patch download (#666)`.

### Task 4: E2E, docs, full suite, screenshot

**Files:**
- Modify: `tests/e2e/tests/document-rules.spec.js`, inside the existing serial `two-layer categories` describe; reuse `startRulesServer`.
- Modify: `docs/user-manual/unit-review.md`, `docs/development/tei-header-integrations.md`.

**Steps:**

- [ ] **Step 1: E2E** `proposes the guide section and the machine rules as a patch`.
  - Create a human override and a machine override.
  - Open "Propose upstream", check that both checkboxes are on and both file paths are listed.
  - Click "Download patch" and capture the download with `page.waitForEvent('download')`.
  - Assert the file name, and that the patch contains `diff --git a/` twice and a `<!-- sync: guide=` line without `base=`.
  - Clean up in `finally`.
  - The local rules server must serve the human and machine files under paths that `parse_repo_path` treats as one repository. If it can't, because local URLs have no forge adapter, mock `**/api/v1/document-rules/propose-patch` with `page.route` and note that in the test.
- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/tests/document-rules.spec.js` and get PASS.
- [ ] **Step 3: Docs.**
  - User manual: the dialog, the marker rule (human only → outdated; machine included → in sync), and how to apply the patch.
  - Developer doc: the route, the splicing against the default branch by anchor, the marker recompute without `base=`, and the patch format.
- [ ] **Step 4: Screenshot** of the dialog with two files, saved to the session scratchpad and viewed. Use `scripts/dev/ui-screenshot.js` if Docker is available; otherwise take a temporary Playwright screenshot.
- [ ] **Step 5: Run** `npm run test:unit`, then `npm run test:e2e`, one at a time, and get PASS. Commit `docs(document-rules): paired upstream proposals (#666)`.
