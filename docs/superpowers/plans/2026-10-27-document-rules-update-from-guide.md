# Document Rules "Update from Guide" (Issue #666, Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Machine rules tab of "Edit document rules", reviewers and admins can bring the machine rules up to date with the human guide section. A language model applies the change in the human section (old → new) to the current machine section. The user reviews the result as a diff and accepts it into a new machine override. When no model is available, the dialog shows the human change and the user edits the machine rules by hand.

**Architecture:**
- A backend module `guide_update.py` gathers the inputs for the user's current pair:
  - **old human section:** the section at the last-synced commit, found by Phase 2's `find_synced_human_commit`;
  - **new human section:** the user's selected human override, else the pinned original;
  - **current machine section:** the selected machine override, else the original, without its sync marker.

  It builds the delta prompt, with the condensing prompt (Phase 2's `resolve_condense_prompt`) as system prompt, and cleans the model's answer.
- Two reviewer/admin routes:
  - `POST /document-rules/human-change` returns the inputs (no LLM), for the diff and the manual fallback;
  - `POST /document-rules/update-from-guide` also runs the model.
- In the frontend, a sub-dialog shows:
  - the human change as a CodeMirror unified merge view;
  - a model picker, fed by `inference-settings`;
  - the proposed machine text as a merge view against the current one.

  "Accept" creates and selects a new machine override. Upstream is never written: that is Phase 4.

**Tech Stack:** FastAPI, `LLMProviderRegistry` + `check_model_access`, `UrlCache`; vanilla JS + Shoelace + `@codemirror/merge`; pytest, `node --experimental-test-module-mocks --test`, Playwright with `page.route` mocks.

**Spec:** GitHub issue mpilhlt/pdf-tei-editor#666, "Proposed design" §2 and §4, "Decisions" 4, "Phases" 3. Planning decisions (2026-10-27):
- **Inputs follow Phase 2's status semantics:** the texts the user currently uses (selected override, else the original).
- **No sync base:** if the marker is missing, or the last-synced commit is not found, the request still runs, in "align" mode. The model gets the human section and the machine rules, without the old section, and is told to bring the machine rules in line. The UI says that no sync base was found.
- **The model's result never replaces anything directly.** It becomes a new machine override (note `Updated from guide with <model label>`), which the user can edit, select, or delete as usual.
- **Sync marker:** the existing marker line of the machine text is kept unchanged in the result. It records the last *upstream* sync; Phase 4 recomputes it when proposing upstream.

Phases 1 and 2 are merged. APIs to use:
- `fastapi_app/lib/doc_rules/guide_sync.py`: `parse_sync_marker`, `SyncMarker`, `find_synced_human_commit(human_url, marker, cache, limit=20, *, deadline_seconds=20.0)`, `human_section_hash`.
- `fastapi_app/lib/doc_rules/condense_prompt.py`: `resolve_condense_prompt(xml_string, guide_url)`. Provider exceptions propagate.
- `fastapi_app/lib/doc_rules/interpretation_ref_kind.py`: `InterpretationRefKind.resource_key`, `resolve_original`.
- `fastapi_app/lib/utils/annotation_rules_utils.py`: `fetch_rule_excerpt`, `markdown_section_range`.
- `GitForgeAdapterRegistry`, `adapter.url_at_commit`.
- `DocumentRulesStore.get_selected_override_text`, `create_override`.
- The router helper `_resource_key` and the `/sync-status` route in `fastapi_app/routers/document_rules.py`. The human/machine text resolution there must be reused, not duplicated.
- LLM: `LLMProviderRegistry.get_instance().get_provider_for_user`, `check_model_access`, `ModelAccessDenied`, `LLMProviderError`, `MissingSecretError`, `secret_required_detail`, and `provider.chat_completion(model_id, system_prompt, user_prompt, temperature)`. The error mapping is in pte-plugins `annotation-review/routes.py` `review()`.
- Frontend: `app/src/plugins/document-rules.js` (`_currentGroup`, `_currentResource`, `_refreshSyncStatus`, `_onNewOverride`, `_selectOverride`); `app/src/plugins/inference-settings.js` (`getDefaultModel()`, `getModelLabel()`, `_providers`); `@codemirror/merge` `unifiedMergeView` (used in `app/src/modules/xmleditor.js`).

## Global Constraints

- Branch `feat/666-phase3-update-from-guide`. Worktree: `/Users/cboulanger/Code/pdf-tei-editor/.claude/worktrees/feat+666-two-layer-document-rules`. PR to `devel`. Commits reference `#666` and do not close it.
- Both routes are gated by `require_reviewer_or_admin` (Decision 4).
- Delta user prompt, exact template. Python `str.format` fields `{old}`, `{new}` and `{machine}`; the blank lines are literal:

  ```text
  The guide section below changed. Update the machine rules so that they reflect this change and nothing else. Keep the wording, order and format of every part the change does not affect. Return only the updated machine rules as Markdown, starting with their heading, without explanations and without a code fence.

  <guide_before>
  {old}
  </guide_before>

  <guide_after>
  {new}
  </guide_after>

  <machine_rules>
  {machine}
  </machine_rules>
  ```

- Align user prompt, exact template:

  ```text
  Bring the machine rules in line with the guide section below. Keep the wording, order and format of rules that are already correct. Return only the updated machine rules as Markdown, starting with their heading, without explanations and without a code fence.

  <guide>
  {new}
  </guide>

  <machine_rules>
  {machine}
  </machine_rules>
  ```

- System prompt: `resolve_condense_prompt(xml, human_url)`, stripped. If the result is whitespace-only, use `DEFAULT_CONDENSE_PROMPT`. `temperature=0.2`.
- Answer cleanup, in this order:
  1. Strip surrounding whitespace.
  2. Remove one surrounding fenced code block (```` ``` ```` or ```` ```markdown ````) if the whole answer is one.
  3. If the first line is not a Markdown heading, prepend the current machine section's heading line and a blank line.
  4. Re-insert the original sync marker line (if any) after the heading as `heading\n\n<marker>\n\n<rest>`, collapsing extra blank lines at that seam.
- An empty answer after cleanup → 502 `The model returned no machine rules`.
- UI copy, exact:
  - Machine-tab button: `Update from guide`
  - Sub-dialog label: `Update machine rules from guide`
  - Section headings: `Change in the guide` and `Proposed machine rules`
  - Run button: `Generate`
  - Accept button: `Accept as new override`
  - Override note: `Updated from guide with <model label>`
  - Align-mode notice: `No sync base found: the model compares the whole guide section with the machine rules.`
  - No-model notice: `No language model is available. Update the machine rules by hand, using the change shown above.`
  - Unchanged-guide notice, when old == new: `The guide section has not changed since the last sync.`
- `api-client-v1.js` is updated in the same commit as each route. JSDoc `@import` only. Precise Python types. Template `.types.js` files are regenerated with `npm run build:ui-types`.
- Tests: Python with `uv run python -m pytest <file> -v`; JS with `node --experimental-test-module-mocks --test <file>`. Before finishing: `npm run test:unit` and `npm run test:e2e`, never two E2E runs at once.

## Review Focus

1. **Human override selected.** "New" must be the override text, so a personal guide edit can be condensed before it is proposed upstream. (Task 1)
2. **No marker, or base commit not found.** Run align mode and say so; never 500. (Tasks 1, 2)
3. **Model answers with a fence, a preamble line, or without the heading.** The cleanup keeps the result usable; an empty answer gives 502. (Task 1)
4. **Provider without a key, model the user may not use, or a provider failure.** Map to 428, 403 and 502 with readable messages, as the annotation reviewer does. The sub-dialog shows the message and keeps the dialog open. (Tasks 2, 4)
5. **No models listed.** The picker and Generate are hidden, and the no-model notice and the human diff are shown (manual fallback). (Task 4)

---

### Task 1: `guide_update.py`: inputs, prompt, answer cleanup

**Files:**
- Create: `fastapi_app/lib/doc_rules/guide_update.py`
- Modify: `fastapi_app/routers/document_rules.py`. Move the per-layer text resolution out of `/sync-status` into a reusable function (below) and call it from `/sync-status`. The `/sync-status` behaviour stays unchanged.
- Test: `tests/unit/fastapi/test_doc_rules_guide_update.py`, plus the existing `/sync-status` router tests, which must stay green.

**Interfaces:**
- Produces:
  - `layer_text(kind: InterpretationRefKind, url: str, store: DocumentRulesStore, owner: str) -> tuple[str, Literal["original", "override"]]`: the selected override, else `resolve_original`. It raises what `resolve_original` raises.
  - `human_section_at_commit(human_url: str, sha: str, cache: UrlCache) -> Optional[str]`: fetches the file at `url_at_commit(base, sha)` without a fragment, slices the anchor section, and returns None on any failure (logged).
  - `@dataclass(frozen=True) class GuideChange`, with fields `old_human: Optional[str]`, `new_human: str`, `machine: str` (without the marker), `marker_line: Optional[str]`, `base_commit: Optional[str]`, `human_source` and `machine_source`. It also has `@property mode -> Literal["delta", "align"]`, which is `"delta"` iff `old_human is not None`.
  - `gather_guide_change(human_url: str, machine_url: str, store: DocumentRulesStore, owner: str, cache: UrlCache) -> GuideChange`. It uses `layer_text` for both layers, `parse_sync_marker` on the machine text, and, when the marker exists, `find_synced_human_commit` followed by `human_section_at_commit`.
  - `build_update_prompts(change: GuideChange, condense_prompt: str) -> tuple[str, str]`: the system prompt and the user prompt, using the exact templates from Global Constraints.
  - `clean_model_answer(answer: str, change: GuideChange) -> str`: the cleanup steps from Global Constraints. It raises `ValueError("The model returned no machine rules")` when the result is empty.

- [ ] **Step 1: Write the failing tests.**
  - `gather_guide_change` in delta mode: patch `layer_text`, `find_synced_human_commit` and `human_section_at_commit`.
  - Align mode with no marker, and align mode when no commit is found.
  - With a human override, `new_human` is the override and `human_source == "override"`.
  - `machine` has no marker line, and `marker_line` keeps it verbatim.
  - The prompt texts equal the templates for both modes.
  - A whitespace-only condense prompt falls back to `DEFAULT_CONDENSE_PROMPT`.
  - `clean_model_answer` cases:
    - a plain answer;
    - an answer wrapped in a ```` ```markdown ```` fence;
    - an answer without a heading, so the heading is prepended;
    - the marker is re-inserted after the heading;
    - an answer that is empty or only a fence raises `ValueError`.
- [ ] **Step 2–4:** Watch them FAIL, implement, and see them PASS. The `/sync-status` tests must still pass after the refactor.
- [ ] **Step 5: Commit** `feat(document-rules): gather guide change and build the update prompt (#666)`.

### Task 2: Routes `/human-change` and `/update-from-guide`

**Files:**
- Modify: `fastapi_app/routers/document_rules.py`, `fastapi_app/lib/models/models_document_rules.py`, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_document_rules_router.py`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `HumanChangeRequest{human_url: str, machine_url: str}` → `HumanChangeResponse{mode: Literal["delta", "align"], old_human: Optional[str], new_human: str, machine: str, base_commit: Optional[str]}`.
    - `POST /document-rules/human-change` is a plain `def`.
    - `machine` here is the full current machine text, marker included, so the frontend can diff against exactly what the user has.
    - A failure to resolve the original gives 502.
  - `UpdateFromGuideRequest{xml: str, human_url: str, machine_url: str, provider_id: str, model_id: str}` → `UpdateFromGuideResponse{mode, old_human, new_human, machine: str, proposed: str, base_commit: Optional[str]}`.
    - `POST /document-rules/update-from-guide` is an `async def`.
    - The blocking parts (`gather_guide_change`, `resolve_condense_prompt`) run via `starlette.concurrency.run_in_threadpool`.
  - Error mapping:
    - unknown provider → 404;
    - `MissingSecretError` → 428 with `secret_required_detail(e)`;
    - `ModelAccessDenied` → 403;
    - `LLMProviderError` or `requests.RequestException` → 502 `LLM provider request failed: …`;
    - `clean_model_answer`'s `ValueError` → 502 with its message;
    - an exception from the condense-prompt provider → 500, logged with traceback, detail `Could not resolve the condensing prompt`.
  - Client: `documentRulesHumanChange(requestBody)` and `documentRulesUpdateFromGuide(requestBody)`, plus the four typedefs.

- [ ] **Step 1: Write the failing tests**, using a fake `LLMProvider` registered in the registry, as `test_review_logic.py` / `test_routes.py` in pte-plugins do. Cover:
  - `/human-change` in delta and align mode;
  - `/update-from-guide` returns the cleaned `proposed` text, and the prompts the fake provider received equal the templates;
  - the 428, 403 and 502 cases, including an empty answer;
  - non-reviewers get 403 on both routes.
- [ ] **Step 2–4:** Watch them FAIL, implement, and see them PASS. Then run `npm run test:unit:fastapi`.
- [ ] **Step 5: Commit** `feat(document-rules): update machine rules from the guide with a language model (#666)`.

### Task 3: `inference-settings.getModels()`

**Files:**
- Modify: `app/src/plugins/inference-settings.js`
- Test: its existing unit test file (find it via the plugin name in `tests/unit/js/`).

**Interfaces:**
- Produces: `getModels(): Array<{providerId: string, modelId: string, label: string}>`. It flattens `_providers` in their order, with `label` built as `getModelLabel()` builds it. It returns an empty array before the first fetch.

- [ ] **Step 1: Write the failing tests:**
  - the list is empty before the fetch;
  - the list is flattened in order with labels after a stubbed fetch;
  - the list reflects a refresh.
- [ ] **Step 2–4:** Watch them FAIL, implement, and see them PASS.
- [ ] **Step 5: Commit** `feat(inference-settings): list the available models (#666)`.

### Task 4: "Update from guide" sub-dialog

**Files:**
- Create: `app/src/templates/document-rules-update-dialog.html`. Its `.types.js` is generated by `npm run build:ui-types`.
- Modify: `app/src/templates/document-rules-editor-dialog.html` (add `<sl-button name="updateFromGuideBtn" size="small" style="display: none;">Update from guide</sl-button>` to the footer) and `app/src/plugins/document-rules.js`. Add `'inference-settings'` to the plugin's `deps`.
- Test: `tests/unit/js/document-rules.test.js`, `tests/unit/js/document-rules-editor-dialog-template.test.js`, and a new template test for the update dialog.

**Interfaces:**
- Consumes: `documentRulesHumanChange`, `documentRulesUpdateFromGuide` and `getModels()`/`getDefaultModel()`/`getModelLabel()`.
- Produces:
  - Template `<sl-dialog name="documentRulesUpdateDialog" label="Update machine rules from guide" style="--width: 80vw;">`, with these named parts:
    - `notice`: a div for the align-mode, unchanged and no-model notices;
    - `humanDiffHeading`: the text `Change in the guide`;
    - `humanDiff`: the merge view container;
    - `modelRow`: a div holding `<sl-select name="modelSelect" size="small">` and `<sl-button name="generateBtn" variant="primary" size="small">Generate</sl-button>`;
    - `proposedHeading`: the text `Proposed machine rules`, hidden until a result exists;
    - `proposedDiff`: the merge view container, hidden until a result exists;
    - in the footer, `acceptBtn` (`Accept as new override`, disabled until a result exists) and `closeBtn` (`Close`).
  - `updateFromGuideBtn` is visible only on the machine layer of a two-layer group, and only when the document is not read-only.
  - `async _openUpdateDialog(): Promise<void>`:
    1. Call `documentRulesHumanChange` for `_currentGroup`'s human/machine URLs.
    2. Render `humanDiff` as a read-only `unifiedMergeView`. Old is `old_human ?? ''` and new is `new_human`. Use the markdown language, as the editor dialog does.
    3. Set the notices: align mode → the align notice; `old_human === new_human` → the unchanged notice.
    4. Fill `modelSelect` from `getModels()`, preselecting `getDefaultModel()`. If there are no models, hide `modelRow` and show the no-model notice.
    5. Show the dialog.
  - `async _onGenerate()`:
    - Disable `generateBtn` and show a spinner (`loading` attribute) while the request runs.
    - Call `documentRulesUpdateFromGuide` with `xml: this.state.xml`, the URLs and the selected model.
    - Render `proposedDiff` with original = `machine` and modified = `proposed`. Keep `proposed` in `_proposedMachineText`, and enable `acceptBtn`.
    - On error: `notify` with the message and keep the dialog open.
  - `async _onAcceptProposal()`:
    - Call `documentRulesOverrides({kind, fragment_url: <machine url>, note: 'Updated from guide with ' + getModelLabel(...), text: _proposedMachineText})`.
    - Then make sure the machine layer is the open layer, push the override to `_currentOverrides` and call `_selectOverride(id)`, which refreshes the status line.
    - Close the sub-dialog.
  - Merge views are destroyed when the sub-dialog closes.

- [ ] **Step 1: Write the failing tests:**
  - button visibility: human layer hidden, machine layer of a pair visible, single layer hidden, read-only hidden;
  - `_openUpdateDialog` fills the select and preselects the default;
  - with no models, the picker is hidden and the no-model notice shows;
  - the align and unchanged notices;
  - `_onGenerate` sends the right body and enables accept;
  - on a `_onGenerate` error, the dialog stays open, the user is notified and accept stays disabled;
  - `_onAcceptProposal` creates the override with the note and text and selects it;
  - template tests for all named parts and the exact copy.
- [ ] **Step 2–4:** Watch them FAIL, implement, and see them PASS. Then run `npm run test:unit:js`.
- [ ] **Step 5: Commit** `feat(document-rules): "Update from guide" dialog (#666)`.

### Task 5: Plugin pin, E2E, docs, full suite, screenshot

**Files:**
- Modify: `pyproject.toml` and `uv.lock`. Bump `pte-plugin-grobid`'s `rev` to the merge commit of mpilhlt/pte-plugins#26: get it with `gh pr view 26 --repo mpilhlt/pte-plugins --json mergeCommit`. Then `uv lock`, and check the plugin's `engines.pte` against the current version.
- Modify: `tests/e2e/tests/document-rules.spec.js`, `docs/user-manual/unit-review.md`, `docs/development/tei-header-integrations.md`.

- [ ] **Step 1: E2E** `updates the machine rules from the guide`:
  - Reuse the two-layer local markdown server.
  - Mock `**/api/v1/llm/providers` (one provider with one model) and `**/api/v1/llm/default-model` with `page.route`.
  - Mock `**/api/v1/document-rules/update-from-guide`, returning a `proposed` text.
  - Then: open the machine tab, click `Update from guide`, click `Generate`, click `Accept as new override`, and assert that the machine tab now selects the new override and its text equals the proposed text.
  - A second E2E with the providers mocked as `[]` asserts the no-model notice.
  - Clean up in `finally`.
- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/tests/document-rules.spec.js` and see it PASS.
- [ ] **Step 3: Docs.**
  - User manual: what "Update from guide" does, delta vs align mode, that the result is a personal override, and the manual fallback.
  - Developer doc: the two routes, the prompt templates (reference the module rather than copying them), the inputs and the error mapping.
- [ ] **Step 4: Screenshot** of the sub-dialog with a proposal, via the same Playwright fallback if Docker is unavailable. Save it to the session scratchpad and view it.
- [ ] **Step 5: Run** `npm run test:unit` and then `npm run test:e2e`, one at a time, and see all PASS. Commit `docs(document-rules): update from guide (#666)`.
