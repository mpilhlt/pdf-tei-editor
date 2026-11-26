# OCR Text Corrections, Part A (find OCR errors with an LLM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the editor, a user can let an LLM review a GROBID segmentation TEI document page by page for OCR misreadings. Its suggestions appear as diagnostics with "Propose fix"/**Apply**, and accepted corrections can then be written into the PDF with Part B's **Write text corrections to PDF**.

**Architecture:** The infrastructure that `annotation-review` (repo `pte-plugins`) and the new review share moves to core:
- tolerant JSON parsing, an LLM call with one retry, and the mapping of LLM errors to HTTP responses (`fastapi_app/lib/llm/`);
- page-window helpers (`zone_lines`);
- the editor-side findings display (`app/src/modules/llm-findings.js`).

`annotation-review` is switched to these core versions. The OCR review itself lives in the core OCR subsystem:
- `fastapi_app/lib/ocr/llm_review.py`: prompt, validation, and the mapping of line corrections to TEI findings;
- two routes in `fastapi_app/routers/ocr.py`;
- a frontend plugin `app/src/plugins/ocr-review.js`.

**Tech Stack:** Python 3.13, FastAPI, the core LLM provider registry (`LLMProvider.chat_completion`), vanilla JS plugins with CodeMirror diagnostics (`lint-utils`), Playwright E2E.

**Spec:** GitHub issue #931, sections "Where it lives" and "Part A". Part B is implemented in PR #932 (pdf-tei-editor) and mpilhlt/pte-plugins#76; Part C gets its own plan. Decisions this plan makes beyond the issue text (Task 8 adds them to the issue):

- **Plausibility check.** The spec's "normalized edit distance" check would reject exactly the footnote cases (`?!?)` → `312)` has distance 0.75). It is therefore applied to the *letters* only. A correction is kept if the case-folded Unicode letters of `old` and `new` have a `difflib` ratio of at least `0.5`, or if either side has fewer than 3 letters. The threshold is the config key `ocr.llm-review.min-letter-similarity`.
- **No `crosses markup` corrections.** A correction whose `old` span in the TEI contains a tag, comment or `<lb/>` is dropped, so only text nodes change.
- **Plugin API version.** It becomes `1.9.0`. `annotation-review` then requires `^1.9` and loses its own copies of the moved code; no compatibility shim is kept.

## Global Constraints

- Two repositories:
  - `pdf-tei-editor` (Tasks 1–3 and 5–8): branch `feat/931-ocr-llm-review`, from `devel` if #932 is merged, otherwise from `feat/931-text-corrections`.
  - `pte-plugins` (Task 4): branch from `main`.
  - Use a worktree for each, and never commit in the shared main checkouts.
- Python: precise types, no `Any` where the type is known, no bare `dict`/`tuple`, long strings as single literals, `uv run python`.
- JS: full JSDoc, type imports only in `@import` blocks, UI via the `ui` object plus typedefs, `stable_id` on the client, templates registered at module level, getDependency at call time instead of new hard deps. `api-client-v1.js` is updated together with the routes.
- Behaviour of `annotation-review` must not change. Its existing Python and JS tests must pass after Task 4, with only their imports changed.
- Plugin API exports are added to `fastapi_app/plugin_api.py`, and `PLUGIN_API_VERSION = "1.9.0"`.
- LLM access: the model selected in **Tools > Inference** (`inference-settings`). On the server, `check_model_access()` is applied, as in `annotation-review`.
- Prompt rules, copied verbatim from the spec into the system prompt (Task 5):
  - Correct only OCR misreadings, i.e. text that differs from what is printed on the page. Do not modernize spelling, fix the author's errors, normalize historical orthography, resolve hyphenation or change punctuation that is plausibly in the original.
  - Check that footnote numbers are consecutive, both the markers in the body text and the numbers at the start of the footnotes, across the pages of the window. Footnote markers in the body are usually superscript and often misread as punctuation or merged with the preceding word; the numbers at the start of the footnotes are usually recognized reliably. Use the sequence on one side to correct gaps and misreadings on the other. Body markers appear in the order of the footnotes on the page.
  - `old` must be the verbatim text of a whole word or run of words on that line; `new` the corrected form.
  - When unsure, don't suggest.
- Known OCR confusions listed in the prompt: `rn`/`m`, `li`/`h`, `é`/`ö`, digits read as `?!>"'®™`.
- Window size: 2 pages (`zone_lines.page_windows(..., max_pages=2)`), plus 5 lines of context on each side (`zone_lines.DEFAULT_CONTEXT_LINES`).
- Markdown in docs: spaced table cells, fenced code with a language, valid anchors.
- Finish with `npm run test:unit` and `npm run test:e2e` in the editor, and the `annotation-review` tests in `pte-plugins`.

## Review Focus

1. **The model quotes `old` slightly wrong** (an extra space, a different quote character). Expect the correction to be dropped and counted as discarded, then one retry with the dropped snippets quoted back to the model. A garbled correction must never be shown. Test in Task 5.
2. **The same word occurs twice on a line** (`der … der`). `old` must be unique in the line, otherwise the correction is dropped. The finding's `old` in the TEI is widened until it is unique in the document. Test in Task 5.
3. **The document changes between review and apply** (the user edits while windows are still being reviewed). Findings whose `old` no longer occurs exactly once are not shown and are pruned later, as in `annotation-review`. Test in Task 3.
4. **The provider fails mid-run** (rate limit, 502). Suggestions from earlier windows stay visible, the error names the failing window, and a rerun is possible. Test in Task 7 (E2E with a mocked failure on window 2).
5. **A correction touches `<lb/>`, a tag or an entity** (`&amp;`). Tags and `<lb/>` cause the correction to be dropped. Entities are decoded for the model and re-escaped in `new`. Test in Task 5.

---

### Task 1: Core LLM response utilities

**Files:**
- Create: `fastapi_app/lib/llm/json_response.py`, `fastapi_app/lib/llm/review_call.py`, `fastapi_app/lib/llm/http_errors.py`
- Modify: `fastapi_app/plugin_api.py`, `fastapi_app/lib/plugins/plugin_manifest.py` (`PLUGIN_API_VERSION = "1.9.0"`), `docs/code-assistant/backend-plugins.md` (plugin API entry)
- Test: `tests/unit/fastapi/test_llm_json_response.py`, `tests/unit/fastapi/test_llm_review_call.py`

**Interfaces:**
- Produces (all exported from `fastapi_app.plugin_api`):
  - `class UnusableResponseError(Exception)`
  - `extract_json_list(raw_response: str, log_prefix: str) -> list[object]`. This is `_extract_json_list` with its helpers `_find_json_list`, `_repair_json_strings` and `_salvage_truncated_list`, moved verbatim from `pte_plugin_annotation_review/prompts.py`. `log_prefix` replaces the hard-coded `"annotation-review:"` in log lines.
  - `T = TypeVar("T")`; `async complete_with_retry(provider: LLMProvider, model_id: str, system_prompt: str, user_prompt: str, parse: Callable[[str], tuple[list[T], list[str]]], retry_note: Callable[[list[str]], str], log_prefix: str) -> tuple[list[T], list[str]]`. It returns `(kept, dropped)`. If `kept` is empty and `dropped` is not, it calls the model once more with `user_prompt + retry_note(dropped)`. If that retry raises `UnusableResponseError`, the first result is kept and a warning is logged. This is the pattern of `run_review`/`_run_zone_review`.
  - `llm_http_error(error: Exception, provider_id: str) -> HTTPException | None`. It maps errors as in `pte_plugin_annotation_review/routes.py`:
    - `ModelAccessDenied` → 403
    - `UnusableResponseError` → 502
    - `LLMRateLimitError` → `rate_limit_http_error(e)`
    - `LLMProviderError` → 502 `"LLM provider request failed: …"`
    - `requests.RequestException` → 502 with the provider's own message (`_upstream_error_message`)
    - anything else → `None`

- [ ] **Step 1: Port the parsing tests.** Copy the test cases for `_extract_json_list`, the repair and the salvage from `pte_plugin_annotation_review/tests/test_prompts.py` into `test_llm_json_response.py`, with `extract_json_list(raw, "test")`: fenced list, prose around the list, unescaped attribute quotes, invalid backslash, truncated list salvage, no list → `UnusableResponseError`.
- [ ] **Step 2: Write the `complete_with_retry` tests** with a fake provider whose `chat_completion` returns queued strings:
  - `test_no_retry_when_kept`
  - `test_retry_once_when_all_dropped` (asserts that the second user prompt ends with the retry note)
  - `test_unusable_retry_keeps_first_result` (uses `assertLogs`)
  - `test_unusable_first_response_raises`
- [ ] **Step 3:** Run `uv run python -m pytest tests/unit/fastapi/test_llm_json_response.py tests/unit/fastapi/test_llm_review_call.py -q`. Expect FAIL.
- [ ] **Step 4:** Implement the three modules and the exports, and bump the version.
- [ ] **Step 5:** Run the tests again (PASS), plus `tests/unit/fastapi/test_llm_registry.py`.
- [ ] **Step 6: Commit:** `feat(llm): shared JSON parsing, retry and error mapping for LLM reviews (#931)`.

### Task 2: Page-window helpers in `zone_lines`

**Files:**
- Modify: `fastapi_app/lib/tei/zone_lines.py`
- Test: the existing zone_lines test file under `tests/unit/fastapi/` (find it with `grep -l zone_lines tests/unit/fastapi`)

**Interfaces:**
- Produces:
  - `window_lines(window: Sequence[Page]) -> range`
  - `window_range(doc: ZoneDocument, xml: str, window: Sequence[Page]) -> tuple[int, int]` (UTF-16 offsets)

  Both are moved from `pte_plugin_annotation_review/zones.py` (`window_range` took a `ZoneSource` there; here it takes `doc` and `xml`).

- [ ] **Step 1:** Write two tests on a small segmentation TEI: `window_lines` of a 2-page window covers exactly those pages' lines; `window_range` of a window that starts after a non-BMP character returns UTF-16 offsets (put an emoji before the window and assert the offset counts it as 2).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit:** `feat(tei): page window helpers in zone_lines (#931)`.

### Task 3: Core findings display (`llm-findings`)

**Files:**
- Create: `app/src/modules/llm-findings.js` (`@registerModule`, so frontend extensions reach it via `getDependency('llm-findings')`)
- Test: `tests/unit/js/llm-findings.test.js`

**Interfaces:**
- Produces:
  - `@typedef {{id: number, old: string, new: string, rationale: string}} Finding`
  - `locateFinding(finding, docText) -> {from, to}|null`, `buildModifiedText(docText, from, to, finding) -> string|null`, `findingsToDiagnostics(findings, docText, onProposeFix) -> FixableDiagnostic[]`, `class FindingsCache` (with `CACHE_VERSION = 1`). All are moved verbatim from the `annotation-review` extension.
  - `class FindingsDisplay`. It holds the stateful part of the extension (`_setFindings`, `_restoreFindings`, `_forgetDismissed`, `showFindings`, `clearFindings`, `_pruneFindings`, `_renderFindings` with the `_rendering` guard, and the update-listener logic):
    - `constructor({ source, getXmleditor, getLintUtils, sessionStorage, proposeFix })`. `source` is the diagnostic source tag. `sessionStorage` is an instance of `session-storage`'s `SessionStorage`. `proposeFix(finding, from, to)` is supplied by the owner.
    - `attach()` registers the update listener, `editorAfterLoad` and the dismiss listener.
    - `show(findings, openPanel = true)`, `clear()`, `restore(docId)`, `get findings()`.

- [ ] **Step 1: Port the tests.** Move the `locateFinding`, `buildModifiedText`, `findingsToDiagnostics` and `FindingsCache` cases from `annotation-review.test.js`. Add `FindingsDisplay` tests with fakes for the xmleditor view, lint-utils and storage:
  - `show` then an edit that removes `old` → the finding is pruned after the debounce;
  - `restore` drops cached findings that no longer occur exactly once;
  - findings dismissed in the drawer are not re-merged.
- [ ] **Step 2:** `node --test tests/unit/js/llm-findings.test.js`. Expect FAIL.
- [ ] **Step 3:** Implement, then run `npm run generate` (module registry).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit:** `feat(frontend): shared LLM findings display (#931)`.

### Task 4: `annotation-review` uses the core code (repo `pte-plugins`)

**Files:**
- Modify in `plugins/annotation-review/src/pte_plugin_annotation_review/`:
  - `prompts.py` (drop the parsing helpers, import `extract_json_list`/`UnusableResponseError`)
  - `review_logic.py` (both call sites use `complete_with_retry`)
  - `routes.py` (`llm_http_error`)
  - `zones.py` (`window_lines`/`window_range` from `zone_lines`)
  - `extensions/annotation-review.js` (`getDependency('llm-findings')`: helpers and `FindingsDisplay`)
  - `pte-plugin.json` (`"pte-plugin-api": "^1.9"`)
  - `README.md` (Layout/Key design points: name the core modules)
- Test: the existing plugin tests. Only imports change, and the moved tests are deleted (they now live in core).

**Interfaces:**
- Consumes: Task 1, Task 2 and Task 3 interfaces.

- [ ] **Step 1:** Run the plugin tests before the change and note the counts: `uv run --project "$PTE_ROOT" python -m pytest plugins/annotation-review/src/pte_plugin_annotation_review -q` and `node --test plugins/annotation-review/src/pte_plugin_annotation_review/tests/annotation-review.test.js`, with `PTE_ROOT` set to the Part A editor worktree.
- [ ] **Step 2:** Switch to the core code and delete the moved code and its tests.
- [ ] **Step 3:** Run the same commands. Expect all remaining tests to pass; the count drops by exactly the moved tests (list them in the commit message body).
- [ ] **Step 4:** Manual smoke test in the editor worktree with a configured provider, if one is available: **Review document annotations** on a document still shows findings. If no provider is configured, state this in the report.
- [ ] **Step 5: Commit:** `refactor(annotation-review): use the editor's shared LLM review code (#931)`.

### Task 5: OCR review logic

**Files:**
- Create: `fastapi_app/lib/ocr/llm_review.py`
- Test: `tests/unit/fastapi/test_ocr_llm_review.py`

**Interfaces:**
- Consumes: `extract_json_list`, `complete_with_retry` (Task 1), `window_lines` (Task 2), `zone_lines` (`read_zone_document`, `pages_of`, `page_windows`, `line_id`, `line_id_width`), `get_line_layout`, `get_zone_labels`, `tei_utils.get_document_language`, and the `Finding` shape `{id, old, new, rationale}`.
- Produces:
  - `MIN_LETTER_SIMILARITY_KEY = "ocr.llm-review.min-letter-similarity"` (default `0.5`)
  - `@dataclass class OcrReviewSource: xml: str; doc: ZoneDocument; windows: list[list[Page]]; languages: list[str]`
  - `prepare_source(xml: str, doc_id: str, variant_id: str, scope: str | None = None) -> OcrReviewSource`
    - Raises `MissingLayoutError(MISSING_LAYOUT_MESSAGE)` (define it here, subclass of `ValueError`) or `ValueError` (not a zone document, or the scope is outside `<text>`).
    - With a scope, the single window is the set of pages the scope lies on, as in `annotation-review`'s `zones.prepare`.
  - `@dataclass(frozen=True) class LineCorrection: line: int; old: str; new: str; rationale: str`
  - `build_system_prompt() -> str`: the Global Constraints' prompt rules and confusions, plus the output format `[{"line": "0412", "old": "…", "new": "…", "rationale": "…"}]`.
  - `build_user_prompt(source: OcrReviewSource, window: Sequence[Page], position: tuple[int, int]) -> str`. It contains the numbered plain-text lines of the window, prefixed `line_id`, with entities decoded. Context lines are marked as such. The languages are included.
  - `parse_corrections(raw: str, source: OcrReviewSource, window: Sequence[Page], min_letter_similarity: float) -> tuple[list[LineCorrection], list[str]]`. It returns `(kept, dropped descriptions)` and drops a correction when:
    - its line is outside the window;
    - `old` does not occur exactly once in the line;
    - the word counts of `old` and `new` differ;
    - it fails the letter-similarity rule (see the Spec decisions);
    - `old == new`.
  - `build_retry_note(dropped: list[str]) -> str`
  - `findings_from_corrections(source: OcrReviewSource, corrections: Sequence[LineCorrection]) -> list[Finding]`
    - `old` is mapped to its character atoms in the line (`ZoneDocument.atoms`). If any non-CHAR/SPACE atom lies between the first and the last atom, the correction is dropped ("crosses markup").
    - The finding's `old` is the raw XML span, widened by whole atoms on both sides until it occurs exactly once in `xml`. `new` is the same span with the corrected text, XML-escaped.
    - Ids are sequential.
    - If the correction changes the first word of its line, the rationale gets this suffix: `" (This changes the first word of the line, so the sync check reports the line until the corrections are written to the PDF.)"`. This is the spec's tooltip note for segmentation documents.
  - `async review_window(source: OcrReviewSource, index: int, provider: LLMProvider, model_id: str, min_letter_similarity: float) -> tuple[list[Finding], int, int]` returns `(findings, window count, discarded)` and uses `complete_with_retry` with `log_prefix="ocr-review:"`.

- [ ] **Step 1: Write the failing tests.** Use a small segmentation TEI fixture: two pages, one body line `… nach der neuen Regel’). Weitere …`, footnote lines `12) Vgl. …`, `13) …`, and one line containing `&amp;`.
  - `test_prompt_contains_numbered_lines_and_rules`
  - `test_parse_keeps_marker_fix` (`Regel’).` → `Regel12).` is kept)
  - `test_parse_drops_old_not_in_line`
  - `test_parse_drops_ambiguous_old` (the word occurs twice in the line)
  - `test_parse_drops_word_count_change`
  - `test_parse_drops_rewrite` (`Gesetz` → `Rechtslage`: letter ratio < 0.5)
  - `test_parse_keeps_garbage_digits` (`?!?)` → `312)`: fewer than 3 letters)
  - `test_findings_map_to_unique_xml_span` (applying the finding to the XML yields the corrected line)
  - `test_entity_is_escaped_in_new`
  - `test_crossing_lb_or_tag_is_dropped`
  - `test_first_word_correction_notes_sync_check` (the suffix appears only when the line's first word changes)
  - `test_review_window_retries_with_dropped_snippets` (fake provider)
  - `test_scope_selects_its_pages`
- [ ] **Step 2:** Run `uv run python -m pytest tests/unit/fastapi/test_ocr_llm_review.py -q`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit:** `feat(ocr): LLM review of OCR errors (#931)`.

### Task 6: Routes

**Files:**
- Modify: `fastapi_app/routers/ocr.py`, the OCR models module, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_ocr_llm_review_routes.py`

**Interfaces:**
- Consumes: Task 5, `llm_http_error` (Task 1), `check_model_access`, `LLMProviderRegistry.get_instance().get_provider_for_user(provider_id, username)`, and `get_config().get(MIN_LETTER_SIMILARITY_KEY, 0.5)`.
- Produces:
  - `OcrReviewPlanRequest(stable_id: str, xml: str, scope: str | None = None)` → `OcrReviewPlanResponse(window_count: int)`
  - `OcrReviewRequest(stable_id: str, xml: str, provider_id: str, model_id: str, window_index: int = 0, scope: str | None = None)` → `OcrReviewResponse(findings: list[FindingResponse], window_count: int, discarded: int, window_start: int | None, window_end: int | None)` (UTF-16 offsets from `window_range`)
  - `POST /api/v1/ocr/llm-review/plan` and `POST /api/v1/ocr/llm-review`. Both require an authenticated user with edit access to the TEI (`stable_id`, used for `doc_id`/`variant`). `xml` is the possibly unsaved editor content.
  - Errors:
    - missing layout or not a zone document: 422
    - unknown provider: 404
    - `MissingSecretError`: 428 (`secret_required_detail`)
    - otherwise `llm_http_error`
  - JS: `apiClient.ocrLlmReviewPlan(body)`, `apiClient.ocrLlmReview(body)`, with typedefs.

- [ ] **Step 1: Write the failing tests.** Use a fake provider registered for the test (see `tests/unit/fastapi/test_llm_for_user.py` for the pattern) and a fake layout provider:
  - `test_plan_counts_windows`
  - `test_review_returns_findings_and_range`
  - `test_missing_layout_is_422`
  - `test_model_access_denied_is_403`
  - `test_unusable_response_is_502`
  - `test_rate_limit_maps`
  - `test_requires_edit_access`
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, plus `test_ocr.py`.
- [ ] **Step 5: Commit:** `feat(ocr): routes for the LLM review of OCR errors (#931)`.

### Task 7: Frontend plugin

**Files:**
- Create: `app/src/plugins/ocr-review.js`
- Modify: `app/src/plugins.js`, `app/src/ui.js` (only if the plugin adds named UI)
- Test: `tests/e2e/tests/ocr-review.spec.js`

**Interfaces:**
- Consumes: `apiClient.ocrLlmReviewPlan`, `apiClient.ocrLlmReview` (Task 6); `getDependency('llm-findings')` (`FindingsDisplay`, `buildModifiedText`) from Task 3; `inference-settings` (`getDefaultModel`, `getModelLabel`), `dialog.confirm`, `progress`, `xmleditor` (`getView`, `getXML`, `showMergeView`, `setFocusAction`), `tools.addMenuItems`, `sl-utils.notify`.
- Produces: plugin `ocr-review` (deps: `client`, `tools`).
  - Menu item **Find OCR errors (LLM)** in the `ocr` category. It is enabled only when a TEI is open and the server reports a layout; otherwise it is disabled with `MISSING_LAYOUT_MESSAGE` as tooltip (use `GET /api/v1/files/{stable_id}/layout`, as `annotation-review` does).
  - Focus action **LLM OCR review** reviews the pages of the focused node (sends `scope`).
  - The flow mirrors `annotation-review`'s `runReview`: confirm with the model label, a progress widget "page window i of n" with cancel, findings shown after each window via `FindingsDisplay({source: 'ocr-review', …})`, and "Propose fix" opening the merge view.
  - Success notify: `"Found N possible OCR errors. Accept the ones you agree with, then use Tools > Write text corrections to PDF."`
  - Failure notify names the window and keeps the earlier findings.
  - `testLog('OCR_REVIEW_DONE', { findings, windows })`.

- [ ] **Step 1: Write the E2E spec.** It mocks `**/api/v1/ocr/llm-review/plan` (`window_count: 2`) and `**/api/v1/ocr/llm-review`:
  - window 0 returns one finding whose `old` occurs once in the loaded test document (create the document in the test, as `ocr-text-corrections.spec.js` does);
  - window 1 returns 502.

  Assert that:
  - the diagnostic for window 0 is present (via `testLog`/lint state);
  - the failure is notified with "page window 2";
  - window 0's finding stays.

  Add a second test: everything succeeds → `OCR_REVIEW_DONE` with `findings: 1`.
- [ ] **Step 2:** Run `node tests/e2e-runner.js tests/e2e/tests/ocr-review.spec.js`. Expect FAIL.
- [ ] **Step 3:** Implement, then run `npm run generate`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Take a screenshot with `scripts/dev/ui-screenshot.js --mock` for the plan and review routes, if Docker is available. Otherwise say so in the report.
- [ ] **Step 6: Commit:** `feat(ocr): Tools action to find OCR errors with an LLM (#931)`.

### Task 8: Docs, issue, full suite

**Files:**
- Modify:
  - the user manual: the section added in Part B in `docs/user-manual/extraction-workflow.md`, extended with "Finding OCR errors with a language model" before "Write text corrections to PDF";
  - `docs/code-assistant/architecture-backend.md` (`llm/` and `ocr/llm_review.py`);
  - `docs/code-assistant/architecture-frontend.md` (`llm-findings` module);
  - issue #931 (append "Implementation decisions (Part A)" with the three decisions from the header).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Append the decisions to the issue (`gh issue view 931 --json body -q .body`, append, `gh issue edit 931 --body-file`).
- [ ] **Step 3:** Run `npm run test:unit` and `npm run test:e2e` in the editor, and the `annotation-review` plus `grobid` tests in `pte-plugins` with `PTE_ROOT` set to the editor worktree. All pass; paste the summary lines.
- [ ] **Step 4: Commit:** `docs: finding OCR errors with a language model (#931)`.
