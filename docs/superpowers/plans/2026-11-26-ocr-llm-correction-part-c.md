# OCR Text Corrections, Part C (LLM correction after OCR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OCR run can optionally let an LLM correct OCR errors on the pages that look poor, writing the corrections straight into the new text layer before the PDF is stored, with every correction recorded and reported.

**Architecture:**
- Part A's LLM review is split into a text-only core (`fastapi_app/lib/ocr/line_review.py`, which works on numbered lines and page windows) and its TEI adapter (`llm_review.py`, unchanged behaviour).
- Part C reuses the core on lines read from the new text layer (`text_layer.py`, Part B). It selects pages with a new per-page check (`text_quality.py`) and turns line corrections into Part B `WordPatch`es.
- A new module `fastapi_app/lib/ocr/llm_correction.py` runs the pass. The OCR router calls it after recognition and before the PDF is stored.

**Tech Stack:** Python 3.13, FastAPI, pikepdf (Part B patcher), the core LLM provider registry, vanilla JS (`app/src/plugins/ocr.js` and the OCR dialog), Playwright E2E.

**Spec:** GitHub issue #931, "Part C", with the decision that Part C runs only on pages flagged as poor. Parts A and B are in PRs #932 and the Part A branch. Decisions this plan makes beyond the issue text (Task 7 adds them to the issue):

- **A core OCR request option, not an engine option.** The spec puts the checkbox into the engine's `get_options()`. The pass needs the user, the model access check and per-user provider secrets, which the engine (running in a worker thread) does not have, and it should work for every engine. The checkbox is therefore shown in the OCR dialog below the engine options and sent as `llm_correction` in `OcrRequest`.
- **Per-page selection by text heuristics only.**
  - `text_quality`/`layout_check` rate the whole document, so a per-page check is added.
  - `layout_check` finds misplaced layers of digital PDFs and is meaningless right after our own OCR. The check therefore uses the character and token heuristics of `text_quality` per page.
  - It also flags pages with suspicious footnote markers (see Task 3). Otherwise well-recognized pages with misread markers, the main case of #904, would never be reviewed.
- **Stricter plausibility for unreviewed corrections.** The letter-similarity threshold is `0.7` (config key `ocr.llm-correction.min-letter-similarity`) instead of Part A's `0.5`. The fewer-than-3-letters exemption (footnote markers) stays.
- **Where corrections are recorded.**
  - Applied corrections go into the PDF's file metadata (`text_corrections`, `source: "llm-after-ocr"`, as in Part B) and into `OcrResponse.llm_corrections`, which the OCR result shows.
  - They are not written to the OCR run log. That log is overwritten by every run and has no link in the UI.

## Global Constraints

- **Repository and branch:** `pdf-tei-editor`. Branch `feat/931-ocr-llm-correction`, from `feat/931-ocr-llm-review` (Part A) until Part A is merged into `devel`, in its own worktree.
- **Python:** precise types, no `Any` where the type is known, no bare `dict`/`tuple`, long strings as single literals, `uv run python`. Core test fixtures live in `tests/unit/fastapi/fixtures/`, never under `fastapi_app/plugins/` (the `core-without-plugins` CI job deletes plugin directories).
- **JS:** full JSDoc with `@import` blocks only, UI via the `ui` object plus typedefs, `stable_id` on the client, and `api-client-v1.js` updated together with the models.
- **Off by default.** The option is off by default. It is offered only when the user has a usable default model (`inference-settings`). The server checks `check_model_access()` when the job is created and answers 403 before any OCR runs.
- **Failure never fails OCR.** An LLM failure or a patch failure does not fail the OCR run: the uncorrected text layer is stored and the failure is reported (`OcrResponse.llm_correction_error`).
- **Progress.** The phase `"Correcting OCR errors"` is reported with `done`/`total` in `window` units via `report_progress`.
- **Prompt and validation.** They are Part A's (prompt rules incl. the footnote-numbering rule; 2-page windows; 5 context lines), with the stricter threshold above.
- **Screenshots.** Use `scripts/dev/ui-screenshot.js` with **Podman** (Docker is not installed). A demo dashboard dialog opens after login; click `text=Generated with createTraining API` to open the demo document.
- **Finish:** run `npm run test:unit` and `npm run test:e2e`.

## Review Focus

1. **The model's `old` covers only part of a layer word** (`egel’)` inside `Regel’).`). The patcher replaces whole words only, so the correction is dropped, never applied to the wrong span. Test in Task 2.
2. **A page whose text layer can't be patched** (the reader reports `unpatchable`). Its corrections are skipped and counted, and the other pages are still corrected. Test in Task 4.
3. **The provider fails halfway** (window 3 of 5). Corrections from windows 1–2 are applied, the error is reported, and OCR still succeeds. Test in Task 4.
4. **The user's model access was revoked or the key is missing** when the job starts. The request is refused with 403/428 before OCR runs, not after minutes of recognition. Test in Task 5.
5. **No page is flagged.** No LLM call is made, nothing is changed, and the result says "No pages needed correction". Test in Task 4.

---

### Task 1: Text-only line review core

**Files:**
- Create: `fastapi_app/lib/ocr/line_review.py`
- Modify: `fastapi_app/lib/ocr/llm_review.py` (becomes the TEI adapter that uses the core)
- Test: `tests/unit/fastapi/test_ocr_line_review.py`; `tests/unit/fastapi/test_ocr_llm_review.py` and `test_ocr_llm_review_routes.py` must pass unchanged

**Interfaces:**
- Produces:
  - `@dataclass class ReviewLines: texts: list[str]; windows: list[range]; languages: list[str]`. `texts[i]` is the plain text of global line `i`. Each window is a range of line indices.
  - The following move from `llm_review.py`, with `OcrReviewSource`/`Sequence[Page]` replaced by `ReviewLines`/`range`. Prompt text and validation rules stay byte-identical:
    - `build_system_prompt() -> str`
    - `build_user_prompt(lines: ReviewLines, window: range, position: tuple[int, int]) -> str`
    - `build_retry_note(dropped: list[str]) -> str`
    - `letters_similar(old, new, min_letter_similarity) -> bool`
    - `parse_corrections(raw: str, lines: ReviewLines, window: range, min_letter_similarity: float) -> tuple[list[LineCorrection], list[str]]`
    - `LineCorrection`, `LOG_PREFIX`
  - `async review_lines_window(lines: ReviewLines, index: int, provider: LLMProvider, model_id: str, min_letter_similarity: float) -> tuple[list[LineCorrection], int, int]` returns `(corrections, window count, discarded)`.
  - `llm_review.py` keeps its public names (`prepare_source`, `findings_from_corrections`, `review_window`, …). It builds a `ReviewLines` from the `ZoneDocument` and its page windows (`window_lines`), and re-exports the moved names so existing imports keep working.

- [ ] **Step 1:** Write `test_ocr_line_review.py`. Using a plain `ReviewLines` with 6 lines in 2 windows:
  - `test_prompt_numbers_global_lines_with_context`
  - `test_parse_rejects_context_lines`
  - `test_review_lines_window_retries` (fake provider)
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Move the code and adapt `llm_review.py`.
- [ ] **Step 4:** The new tests and all existing `test_ocr_llm_review*.py` pass unchanged.
- [ ] **Step 5: Commit:** `refactor(ocr): text-only core of the LLM OCR review (#931)`.

### Task 2: Lines of the text layer and patches from line corrections

**Files:**
- Modify: `fastapi_app/lib/ocr/text_layer.py`
- Test: `tests/unit/fastapi/test_text_layer.py`

**Interfaces:**
- Consumes: `ReviewLines`, `LineCorrection` (Task 1); `LayerPage`, `LayerWord`, `WordPatch`, `read_text_layer` (Part B).
- Produces:
  - `LayerWord` gains `line: int`, the index of the text object (`BT … ET`) on its page in drawing order. OCRmyPDF writes one text object per line. Update all constructors; Part B tests keep passing.
  - `@dataclass(frozen=True) class LayerLine: page: int; words: list[LayerWord]` with `text` = the words joined by single spaces.
  - `layer_lines(page: LayerPage) -> list[LayerLine]`
  - `review_lines_for_pages(pages: Sequence[LayerPage], page_indices: Sequence[int], languages: list[str]) -> tuple[ReviewLines, list[LayerLine]]`. The lines of the selected pages are numbered globally. Windows are runs of up to 2 consecutive selected pages; non-consecutive pages start a new window. The second element maps global line index → `LayerLine`.
  - `patches_from_corrections(lines: Sequence[LayerLine], corrections: Sequence[LineCorrection]) -> tuple[list[WordPatch], list[str]]`
    - `old` must start and end on word boundaries of the line text and cover whole words. Otherwise the correction is dropped with the reason `"not whole words"`.
    - Each word whose text changes becomes a `WordPatch(word, new_word)`.

- [ ] **Step 1:** Write the failing tests on the committed fixture `tests/unit/fastapi/fixtures/ocr-text-layer.pdf`:
  - `test_words_carry_line_index` (the 7 words of the first line share `line` 0, the first word of the next line has 1)
  - `test_layer_lines_text`
  - `test_review_lines_windows_split_on_gaps` (pages `[0, 1, 3]` give windows over pages `{0, 1}` and `{3}`)
  - `test_patch_from_whole_word_correction` (`Regel’).` → `Regel12).` gives one `WordPatch`)
  - `test_partial_word_correction_dropped` (`egel’)` → `egel12)`)
  - `test_multi_word_correction_patches_only_changed_words`
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, together with all existing `test_text_layer.py` and `test_text_corrections.py` tests.
- [ ] **Step 5: Commit:** `feat(ocr): text layer lines for the LLM correction pass (#931)`.

### Task 3: Pages that need a review

**Files:**
- Modify: `fastapi_app/lib/ocr/text_quality.py`
- Test: the existing text-quality tests in `tests/unit/fastapi/test_ocr.py` (add a class)

**Interfaces:**
- Produces:
  - `SUSPICIOUS_MARKER_RE = re.compile(r"[^\W\d_][?!'\"‘’“”*>®™%]{1,4}\)")`
  - `pages_needing_review(pdf_path: Path | str) -> list[int]` returns the 0-based indices of all pages (no sampling limit) that have text and meet at least one condition:
    - garbled-char ratio > `MAX_GARBLED_RATIO`;
    - plausible-word ratio < `MIN_PLAUSIBLE_WORD_RATIO`;
    - at least one `SUSPICIOUS_MARKER_RE` match.

    It reuses the per-page token logic of `_analyze_text_layer` (extract a helper; do not duplicate it).

- [ ] **Step 1:** Write the failing tests:
  - `test_clean_page_not_selected`
  - `test_page_with_misread_marker_selected` (text `"haftet nach der neuen Regel?!?). Weitere"`)
  - `test_garbled_page_selected`
  - `test_page_without_text_not_selected`

  Build the PDFs with reportlab or pikepdf, as the existing tests do.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, plus the whole `test_ocr.py`.
- [ ] **Step 5: Commit:** `feat(ocr): find the pages of a text layer that need a review (#931)`.

### Task 4: The correction pass

**Files:**
- Create: `fastapi_app/lib/ocr/llm_correction.py`
- Test: `tests/unit/fastapi/test_ocr_llm_correction.py`

**Interfaces:**
- Consumes: Tasks 1–3, `patch_text_layer` (Part B), `report_progress`.
- Produces:
  - `MIN_LETTER_SIMILARITY_KEY = "ocr.llm-correction.min-letter-similarity"`, default `0.7`
  - `@dataclass class AppliedCorrection: page: int; old: str; new: str; rationale: str`
  - `@dataclass class CorrectionRun: corrections: list[AppliedCorrection]; pages_reviewed: list[int]; skipped: int; error: str | None`
  - `async correct_text_layer(pdf_path: Path, provider: LLMProvider, model_id: str, languages: list[str], min_letter_similarity: float) -> CorrectionRun`. It never raises for LLM or patch problems (it returns `error`) and edits `pdf_path` in place:
    1. Read the layer and select pages with `pages_needing_review`. If none are selected, return without any LLM call.
    2. For each window, call `review_lines_window` and turn the corrections into patches. Report progress `("Correcting OCR errors", i, n, "window")`.
    3. On a provider error, stop, keep what was collected, and set `error`.
    4. Apply the patches page by page. A page whose patches raise `ValueError` is skipped (`skipped += its corrections`) and the other pages are still patched.
    5. Save in place (`pdf.save` to a temp file, then replace).

- [ ] **Step 1:** Write the failing tests. Use the fixture PDF, a fake provider and a monkeypatched `pages_needing_review`:
  - `test_marker_corrected_in_text_layer` (afterwards `read_text_layer` shows `Regel12).`)
  - `test_no_pages_selected_makes_no_call`
  - `test_provider_failure_keeps_earlier_windows` (window 1 succeeds, window 2 raises `LLMProviderError` → window 1's correction applied, `error` set)
  - `test_unpatchable_page_skipped`
  - `test_stricter_threshold_drops_rewrite` (`Gesetz` → `Gesetze` is kept, ratio 0.92; a pair with ratio 0.6 is dropped at 0.7)
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit:** `feat(ocr): correct OCR errors with an LLM after recognition (#931)`.

### Task 5: OCR request option and router integration

**Files:**
- Modify: `fastapi_app/lib/models/models_ocr.py`, `fastapi_app/routers/ocr.py`, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_ocr_llm_correction_route.py`

**Interfaces:**
- Consumes: `correct_text_layer` (Task 4); `check_model_access`, `LLMProviderRegistry.get_instance().get_provider_for_user`, `MissingSecretError`/`secret_required_detail`, and `llm_http_error` (Part A).
- Produces:
  - `OcrRequest` gains `llm_correction: bool = False`, `provider_id: str | None = None` and `model_id: str | None = None`. Both ids are required when `llm_correction` is set, otherwise 422.
  - `OcrResponse` gains `llm_corrections: list[OcrLlmCorrection] = []` (model `{page, old, new, rationale}`) and `llm_correction_error: str | None = None`.
  - `apply_ocr` resolves the provider and checks model access before `jobs.create`. Errors: unknown provider 404, missing secret 428, denied 403.
  - `_recognize` runs `correct_text_layer(output_path, …)` after `engine.recognize`, before reading the content and analysing quality. The languages come from the request.
    - If corrections were applied, the stored PDF metadata gets `text_corrections += [{applied_at, applied_by, source: "llm-after-ocr", provider_id, model_id, corrections: [{page, old, new}]}]`.
    - The message gets `"Corrected N OCR errors with <model>."` or `"No pages needed correction."` appended. On error, the message notes it instead.
  - JS typedefs for the new fields.

- [ ] **Step 1:** Write the failing tests, with a fake OCR engine that copies the fixture PDF as its output (see `test_ocr.py`/`test_archived_pdfs.py` for engine and job fakes) and a fake provider:
  - `test_option_off_runs_no_llm`
  - `test_option_on_corrects_and_records` (stored PDF has `Regel12).`, metadata record, response lists the correction)
  - `test_denied_model_refused_before_ocr` (403, engine not called)
  - `test_missing_ids_422`
  - `test_llm_failure_keeps_ocr_result` (job succeeds, `llm_correction_error` set, PDF stored uncorrected)
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, plus `test_ocr.py`, `test_archived_pdfs.py`, `test_ocr_text_corrections.py`.
- [ ] **Step 5: Commit:** `feat(ocr): optional LLM correction in OCR runs (#931)`.

### Task 6: OCR dialog option and result

**Files:**
- Modify: `app/src/templates/ocr-dialog.html` (and its generated `.types.js`), `app/src/plugins/ocr.js`
- Test: `tests/e2e/tests/ocr-llm-correction.spec.js`

**Interfaces:**
- Consumes: Task 5's request and response fields; `inference-settings` (`getDefaultModel`, `getModelLabel`).
- Produces:
  - A checkbox **Correct OCR errors with a language model** below the engine options, with the help text: `"Uses <model label> to correct misread words, mainly footnote numbers, on pages that look poor. Changes the text without review; every correction is listed afterwards. Costs about one LLM call per two such pages."`
  - The checkbox is disabled with the tooltip `"Select a default model in Tools > Inference first."` when there is no default model. It is remembered with `uiStorage`.
  - `OcrRunOptions` gains `llmCorrection: boolean`, and the request carries `llm_correction`, `provider_id`, `model_id`.
  - Result: when `llm_corrections` is non-empty, the OCR result notification lists up to 5 corrections as `“old” → “new”`, plus `"and N more"`; `llm_correction_error` appears as a warning. `testLog('OCR_LLM_CORRECTION', { requested, corrections, error })`.

- [ ] **Step 1: Write the E2E spec.**
  - Mock `**/api/v1/llm/default-model` so a default model exists, `**/api/v1/ocr` (POST, returns a queued job) and `**/api/v1/ocr/jobs/*` (finished, with `llm_corrections` of 2 entries).
  - Open the OCR dialog for a test PDF created in the test (as `ocr-archived-pdf.spec.js` does). Check the box and run.
  - Assert that the intercepted request body has `llm_correction: true` and the model ids, and that `OCR_LLM_CORRECTION` has `corrections: 2`.
  - Second test: without a default model the checkbox is disabled.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement, then run `npm run generate` if the template types are generated.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Take a Podman screenshot of the OCR dialog with the option, view it, and fix layout problems.
- [ ] **Step 6: Commit:** `feat(ocr): option to correct OCR errors with an LLM in the OCR dialog (#931)`.

### Task 7: Docs, issue, full suite

**Files:**
- Modify:
  - the user manual's OCR section (`docs/user-manual/` page on text recognition, next to the Part A and B sections in `extraction-workflow.md`);
  - `docs/code-assistant/architecture-backend.md` (`line_review.py`, `llm_correction.py`);
  - issue #931 (append "Implementation decisions (Part C)" with the decisions from the header).

- [ ] **Step 1:** Write the docs: when to use the option, what it costs, where the corrections are listed, and that a later review with Part A plus Part B is still possible.
- [ ] **Step 2:** Update the issue (`gh issue view 931 --json body -q .body`, append, `gh issue edit 931 --body-file`).
- [ ] **Step 3:** Run `npm run test:unit` and `npm run test:e2e`; all must pass.
- [ ] **Step 4: Commit:** `docs: LLM correction after OCR (#931)`.
