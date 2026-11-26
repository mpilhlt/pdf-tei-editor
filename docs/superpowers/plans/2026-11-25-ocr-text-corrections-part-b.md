# OCR Text Corrections, Part B (write TEI corrections to the PDF text layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reviewer can write the text corrections made in a GROBID segmentation TEI document into the PDF's OCR text layer; the server stores the corrected PDF, regenerates the feature file, and the client saves the TEI as a new version tied to the corrected PDF.

**Architecture:** Core gets a text-layer reader/patcher (`fastapi_app/lib/ocr/text_layer.py`) that edits the glyph codes of single words in the invisible OCR text and keeps each word's width by adjusting `Tz`; an aligner (`fastapi_app/lib/ocr/text_corrections.py`) that derives word corrections by diffing the TEI's pages (via the line layout) against the text layer; a registry through which an extractor plugin regenerates and checks its feature file for the corrected PDF; and two routes in `fastapi_app/routers/ocr.py`. The GROBID plugin (repo `pte-plugins`) registers the handler. A new frontend plugin adds the Tools menu action and saves the returned TEI as a new version.

**Tech Stack:** Python 3.13, FastAPI, pikepdf 10, pdfminer.six (`CMapParser`), fontTools 4, PyMuPDF (tests only), vanilla JS plugins, Playwright E2E.

**Spec:** GitHub issue #931 (Part B). Parts A (LLM review) and C (post-OCR option) get separate plans. Decisions made after the issue text, which Task 8 writes back into the issue:

- B2 is implemented by **patching** the words in the existing text layer (not by synthesizing hOCR and re-rendering). Without corrections the text layer is unchanged.
- Because the editor autosaves, the version being edited keeps the corrected text and is linked to the archived (old) PDF by `replace_pdf_content()`; the new version is a copy with updated `pdf-hash`/`revision` labels, based on the corrected PDF.
- Applied corrections are recorded durably in the PDF's file metadata (`text_corrections`), not in the OCR run log (which is overwritten by every OCR run).

## Global Constraints

- Two repositories: `pdf-tei-editor` (Tasks 1–6, 8) and `pte-plugins` (Task 7). Work in a worktree of each (memory: never commit in the shared main checkout).
- Python: precise types, no `Any` where known, no bare `dict`/`tuple`; long strings as single literals; run with `uv run python`.
- JS: full JSDoc, type imports only in `@import` blocks; UI via the `ui` object and typedefs; `stable_id` on the client, never `file_id`.
- `app/src/modules/api-client-v1.js` is hand-maintained: add methods and typedefs for the new routes in the same task.
- Plugin API: new exports in `fastapi_app/plugin_api.py`, bump `PLUGIN_API_VERSION` to `1.8.0`. The GROBID plugin keeps `"pte-plugin-api": "^1.6"` and guards the import (`ImportError` → feature absent), like `register_layout_provider`.
- Permission: both routes require the `reviewer` role (or admin) and edit access to the TEI file.
- Only invisible text (`3 Tr`) in Type0 fonts with a `ToUnicode` CMap and 2-byte codes (`Identity-H`) is patched. Everything else on a page makes corrections on that page unwritable, never a crash.
- Markdown in docs: spaced table cells, fenced code with language, valid anchors.
- Finish with `npm run test:unit` and `npm run test:e2e` in `pdf-tei-editor`, and the GROBID plugin tests in `pte-plugins`.

## Review Focus

1. A TEI version whose `pdf_stable_id` is set (made from an archived PDF): its text doesn't correspond to the current text layer. Preview must say so and apply must refuse (409), not patch the wrong PDF. Test in Task 5.
2. Pages with no patchable layer (digital text, Type1 fonts, scanned page never OCR'd): corrections there are reported as unwritable with a reason, the rest still writable. Test in Task 3.
3. An OCR job queued/running for the same PDF while apply runs: refuse with 409 (`OcrJobStore.find_active`). Test in Task 5.
4. The new feature file matches fewer TEI lines than the old one (GROBID tokenized the corrected PDF differently): nothing is replaced, the mismatching TEI lines are returned (422). Test in Tasks 5 and 7.
5. A correction introducing a character the subset font lacks and NotoSans lacks too (e.g. CJK): uses `/DW` width, still extracts correctly. Test in Task 2.

---

### Task 1: Read the OCR text layer as words

**Files:**
- Create: `fastapi_app/lib/ocr/text_layer.py`
- Create: `fastapi_app/plugins/ocrmypdf/tests/fixtures/ocr-text-layer.pdf` (generated, committed)
- Modify: `fastapi_app/plugins/ocrmypdf/tests/fixtures/make_fixtures.py` (add generator)
- Test: `tests/unit/fastapi/test_text_layer.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class LayerWord: page: int; stream: int; op_index: int; start: int; end: int; text: str` — `stream` is the pikepdf object number of the content stream (page content or Form XObject) holding the `Tj`/`TJ`; `op_index` the index of the operator in `pikepdf.parse_content_stream()` of that stream; `start`/`end` code indexes (not bytes) of the word within the operator's string (for `TJ`, counted across the string elements, kerning numbers skipped).
  - `@dataclass class LayerPage: index: int; words: list[LayerWord]; unpatchable: str | None` — `unpatchable` is the reason the page can't be patched (`"no OCR text layer"`, `"visible text"`, `"font without ToUnicode"`, `"font is not Identity-H"`), else None.
  - `read_text_layer(pdf: pikepdf.Pdf) -> list[LayerPage]`
  - `parse_to_unicode(stream: pikepdf.Stream) -> dict[int, str]` (via `pdfminer.cmapdb.CMapParser` + `FileUnicodeMap`; do not parse CMaps with regexes, bfchar and bfrange sections interleave)

- [ ] **Step 1: Generate the fixture.** Add `make_ocr_text_layer()` to `make_fixtures.py`: run `ocrmypdf.ocr(footnote-markers.pdf, ocr-text-layer.pdf, language="deu", force_ocr=True, output_type="pdf", progress_bar=False)`. Run it once and commit the PDF (tests must not need Tesseract). Its first page reads `Die Gesellschaft haftet nach der neuen Regel’). Weitere …` (text layer in Form XObject `/OCR-…`, one `BT` per line, per word `Td`, `Tz`, `Tj`, font `/F1` Type0 NotoSans subset).

- [ ] **Step 2: Write the failing tests** (`unittest` style, as in `tests/unit/fastapi/test_ocr.py`)

```python
def test_reads_words_in_content_order(self):
    pages = read_text_layer(pikepdf.open(FIXTURE))
    words = [w.text for w in pages[0].words]
    self.assertEqual(words[:7], ["Die", "Gesellschaft", "haftet", "nach", "der", "neuen", "Regel’)."])
    self.assertIsNone(pages[0].unpatchable)

def test_word_location_points_at_tj(self):
    word = read_text_layer(pikepdf.open(FIXTURE))[0].words[6]
    pdf = pikepdf.open(FIXTURE)
    stream = pdf.get_object((word.stream, 0))
    operands, op = pikepdf.parse_content_stream(stream)[word.op_index]
    self.assertEqual(str(op), "Tj")

def test_page_without_text_layer(self):  # image-only PDF, see make_image_only_pdf in test_ocr.py
    self.assertEqual(read_text_layer(pikepdf.open(image_only))[0].unpatchable, "no OCR text layer")

def test_visible_text_is_unpatchable(self):  # a reportlab/pikepdf PDF with 0 Tr Helvetica text
    self.assertEqual(read_text_layer(pikepdf.open(digital))[0].unpatchable, "visible text")
```

- [ ] **Step 3: Run** `uv run python -m pytest tests/unit/fastapi/test_text_layer.py -v` — FAIL (module missing).

- [ ] **Step 4: Implement `read_text_layer`.** Walk each page's content streams and the Form XObjects they draw (`Do`, recursively, each stream once), tracking `Tf` (font resource of the current stream's `/Resources`) and `Tr` within `BT…ET`. Words are split on characters that decode to whitespace; a word that spans no whitespace may cover a whole `Tj` string minus its trailing space. Any text shown with `Tr` ≠ 3 marks the page `"visible text"`.

- [ ] **Step 5: Run** the tests — PASS.

- [ ] **Step 6: Commit** `feat(ocr): read the words of the OCR text layer (#931)`.

### Task 2: Patch words in the text layer

**Files:**
- Modify: `fastapi_app/lib/ocr/text_layer.py`
- Test: `tests/unit/fastapi/test_text_layer.py`

**Interfaces:**
- Consumes: `LayerWord`, `read_text_layer`, `parse_to_unicode` (Task 1)
- Produces:
  - `@dataclass(frozen=True) class WordPatch: word: LayerWord; new_text: str`
  - `patch_text_layer(pdf: pikepdf.Pdf, patches: Sequence[WordPatch]) -> None` — edits `pdf` in place; raises `ValueError` if a patch's word no longer matches (`text` differs at its location) or is on an unpatchable page.

- [ ] **Step 1: Write the failing tests**

```python
def test_round_trip_without_patches(self):
    pdf = pikepdf.open(FIXTURE); before = streams(pdf)   # helper: {objnum: read_bytes()}
    patch_text_layer(pdf, [])
    self.assertEqual(streams(pdf), before)

def test_patched_word_is_extracted(self):
    out = patched(FIXTURE, {"Regel’).": "Regel12)."})   # helper: read, patch by text, save to tmp
    text = pymupdf.open(out)[0].get_text()
    self.assertIn("neuen Regel12). Weitere", text)

def test_patched_word_keeps_its_width(self):
    old = word_box(FIXTURE, "Regel’).")      # pymupdf get_text("words") bbox
    new = word_box(out, "Regel12).")
    self.assertAlmostEqual(old.x0, new.x0, delta=0.5); self.assertAlmostEqual(old.x1, new.x1, delta=0.5)

def test_new_character_is_added_to_tounicode(self):
    out = patched(FIXTURE, {"Regel’).": "RegelΩ12)."})
    self.assertIn("RegelΩ12).", pymupdf.open(out)[0].get_text())
    self.assertIn("RegelΩ12).", pdfminer.high_level.extract_text(out))

def test_character_missing_in_notosans_uses_dw(self):
    out = patched(FIXTURE, {"Regel’).": "Regel中)."})
    self.assertIn("Regel中).", pymupdf.open(out)[0].get_text())

def test_stale_patch_is_rejected(self):
    with self.assertRaises(ValueError): patch_text_layer(pdf, [WordPatch(replace(word, text="other"), "x")])
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `patch_text_layer`.** Per patched operator, replace the codes of `[start, end)` with codes for `new_text`: reuse a code whose `ToUnicode` value is the character; otherwise allocate the next free code (max of `ToUnicode` keys and `/W` CIDs, + 1), append a `beginbfchar … endbfchar` section before `endcmap` in the `ToUnicode` stream, append `[cid [width]]` to the descendant font's `/W`, and if `/CIDToGIDMap` is a stream, extend it to cover the new CID with GID 0. Widths of new characters come from `ocrmypdf/data/NotoSans-Regular.ttf` (`fontTools.ttLib.TTFont`, `hmtx` advance × 1000 / `unitsPerEm`), else `/DW` (default 1000). Keep the operator's width: with `w = Σ W(code)` of the whole string before and after, emit `s·w_old/w_new Tz` before the operator and `s Tz` after it, where `s` is the `Tz` in effect (track it; 100 by default). Write the stream back with `pikepdf.unparse_content_stream()`. Several patches in one operator are applied right to left. A font object shared by several pages is updated once.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat(ocr): patch words of the OCR text layer, keeping their width (#931)`.

### Task 3: Derive word corrections from the TEI

**Files:**
- Create: `fastapi_app/lib/ocr/text_corrections.py`
- Test: `tests/unit/fastapi/test_text_corrections.py`

**Interfaces:**
- Consumes: `LayerPage`, `LayerWord` (Task 1); `zone_lines.read_zone_document`, `get_zone_labels`, `get_line_layout` (`fastapi_app/lib/tei/`)
- Produces:
  - `@dataclass(frozen=True) class TeiWord: page: int; line: int; text: str` (`line` = index in `ZoneDocument.lines`)
  - `@dataclass(frozen=True) class WordCorrection: page: int; line: int; old: str; new: str; word: LayerWord`
  - `@dataclass(frozen=True) class UnwritableChange: page: int; line: int | None; layer_text: str; tei_text: str; reason: str`
  - `@dataclass class CorrectionPlan: corrections: list[WordCorrection]; unwritable: list[UnwritableChange]`
  - `tei_words(xml: str, variant_id: str, layout: LineLayout) -> dict[int, list[TeiWord]]` — words by page; raises `ValueError` if the variant has no zone labels.
  - `derive_corrections(tei: Mapping[int, Sequence[TeiWord]], layer: Sequence[LayerPage]) -> CorrectionPlan`

- [ ] **Step 1: Write the failing tests** (synthetic `LayerPage`/`TeiWord` lists; words compared after `unicodedata.normalize("NFC", …)`)

```python
def test_equal_length_replace_gives_corrections(self):
    plan = derive_corrections(tei(0, "nach der neuen Regel12). Weitere"), layer(0, "nach der neuen Regel’). Weitere"))
    self.assertEqual([(c.old, c.new) for c in plan.corrections], [("Regel’).", "Regel12).")])
    self.assertEqual(plan.unwritable, [])

def test_tokenization_differences_are_ignored(self):      # "Regel’)." vs "Regel’) ."
    self.assertEqual(derive_corrections(tei(0, "a Regel’) . b"), layer(0, "a Regel’). b")), CorrectionPlan([], []))

def test_moved_block_is_ignored(self):                    # reading order differs (columns)
    self.assertEqual(derive_corrections(tei(0, "C D A B"), layer(0, "A B C D")).unwritable, [])

def test_word_count_change_is_unwritable(self):
    plan = derive_corrections(tei(0, "x Rechtswissenschaft y"), layer(0, "x Rechts- wissenschaft y"))
    self.assertEqual(plan.unwritable[0].reason, "different number of words")

def test_unpatchable_page(self):
    plan = derive_corrections(tei(1, "a b2"), layer(1, "a b", unpatchable="visible text"))
    self.assertEqual((plan.corrections, plan.unwritable[0].reason), ([], "visible text"))
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Per page, `difflib.SequenceMatcher(None, layer_words, tei_words, autojunk=False)`. `replace` with equal lengths → one `WordCorrection` per differing pair. Other non-equal opcodes: ignored if both sides joined without whitespace are equal (tokenization); a `delete` and an `insert` with equal joined text on the same page cancel out (moved block); otherwise `UnwritableChange(reason="different number of words")`, `line` from the first TEI word if any. A page whose layer is `unpatchable` turns all its differences into `UnwritableChange(reason=page.unpatchable)`. `tei_words` reads lines with `read_zone_document(xml, get_zone_labels(variant_id))`, `Line.text`, and pages from `layout.pages`.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat(ocr): derive text layer corrections from the TEI (#931)`.

### Task 4: Corrected-PDF handler registry in the plugin API

**Files:**
- Modify: `fastapi_app/lib/ocr/text_corrections.py`, `fastapi_app/plugin_api.py`, `fastapi_app/lib/plugins/plugin_manifest.py` (`PLUGIN_API_VERSION = "1.8.0"`), `docs/development/` plugin API changelog if present
- Test: `tests/unit/fastapi/test_text_corrections.py`

**Interfaces:**
- Produces (exported from `fastapi_app.plugin_api`):
  - `CorrectedPdfHandler = Callable[[str, str, Path, str, frozenset[int]], str]` — `handler(xml, doc_id, pdf_path, pdf_hash, corrected_lines) -> xml with updated labels`; called in a worker thread.
  - `class CorrectedPdfMismatch(Exception): def __init__(self, message: str, lines: list[int])`
  - `register_corrected_pdf_handler(variant_id: str, plugin_id: str, handler: CorrectedPdfHandler) -> None`, `unregister_corrected_pdf_handler(variant_id: str) -> None`, `get_corrected_pdf_handler(variant_id: str | None) -> CorrectedPdfHandler | None`

- [ ] **Step 1: Test** register/get/unregister round trip and that `fastapi_app.plugin_api` exports all four names. **Step 2:** FAIL. **Step 3:** implement as a module-level dict like `fastapi_app/lib/tei/layout.py`. **Step 4:** PASS. **Step 5: Commit** `feat(plugin-api): corrected PDF handlers (#931)`.

### Task 5: Preview and apply routes

**Files:**
- Modify: `fastapi_app/routers/ocr.py`, `fastapi_app/lib/models/` (OCR models module that holds `OcrResponse`), `fastapi_app/lib/repository/file_repository.py`, `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_ocr_text_corrections.py`

**Interfaces:**
- Consumes: Tasks 1–4; `OcrJobStore.find_active`, `FileStorage.save_file`, `FileRepository.replace_pdf_content`
- Produces:
  - `FileRepository.get_current_pdf_teis(doc_id: str) -> list[FileMetadata]` — TEI files of the document with `pdf_stable_id IS NULL`, not deleted.
  - Models: `TextCorrectionsRequest(stable_id: str, skip_unwritable: bool = False)`; `TextCorrectionItem(page: int, line: int, old: str, new: str)`; `UnwritableItem(page: int, line: int | None, layer_text: str, tei_text: str, reason: str)`; `AffectedFile(stable_id: str, label: str)`; `TextCorrectionsPreview(corrections: list[TextCorrectionItem], unwritable: list[UnwritableItem], affected_files: list[AffectedFile], reason: str | None)` (`reason` set ⇒ the action is not possible); `TextCorrectionsResult(xml: str, pdf_stable_id: str, archived_stable_id: str | None, corrections: int)`.
  - `POST /api/v1/ocr/text-corrections/preview` → `TextCorrectionsPreview`; `POST /api/v1/ocr/text-corrections/apply` → `TextCorrectionsResult`.
  - JS: `apiClient.ocrTextCorrectionsPreview(body)`, `apiClient.ocrTextCorrectionsApply(body)` with typedefs.

Preconditions, checked by both routes in this order, as `reason` in preview and as HTTP error in apply: not reviewer → 403; TEI not found/no edit access → 404/403; `pdf_stable_id` set → 409 `"This version was made from an earlier PDF of the document. Open a version based on the current PDF."`; no layout (`get_line_layout` is None) → 409 `MISSING_LAYOUT_MESSAGE`; no handler for the variant → 409 `"Text corrections cannot be written for this kind of document."`; OCR job active for the PDF → 409; no corrections → 409 `"The document has no text corrections to write."`.

Apply, in order: unwritable non-empty and not `skip_unwritable` → 409; patch a copy of the PDF in a temp dir (`asyncio.to_thread`); `save_file(content, "pdf", increment_ref=False)` → new hash; call the handler in a thread with the TEI xml from storage → `CorrectedPdfMismatch` → 422 with `{"message", "lines"}`, `RuntimeError` (extractor service unreachable) → 502, nothing replaced in either case; `replace_pdf_content(pdf.stable_id, new_hash, size, {**metadata, "text_corrections": [*previous, {"applied_at", "applied_by", "tei_stable_id", "corrections": [{page, old, new}]}]})`; return the handler's xml.

- [ ] **Step 1: Write failing tests** with `TestClient`, a temp storage/repo as in `tests/unit/fastapi/test_archived_pdfs.py`, the Task 1 fixture as PDF, a fake layout provider (`register_layout_provider`) and fake handler (returns `xml.replace("OLD-HASH", pdf_hash)`):
  - `test_preview_lists_corrections` (one correction `Regel’).` → `Regel12).`, `reason` None, `affected_files` lists the other current TEI)
  - `test_apply_replaces_pdf_and_returns_xml` (new PDF extracts `Regel12).`; old content archived; `text_corrections` record present; response xml contains the new hash)
  - `test_archived_version_is_refused` (409), `test_requires_reviewer` (403), `test_active_ocr_job_conflicts` (409), `test_unwritable_requires_skip` (409, then 200 with `skip_unwritable`)
  - `test_handler_mismatch_keeps_pdf` (handler raises `CorrectedPdfMismatch("…", [3])` → 422 with `lines == [3]`, PDF row unchanged)
- [ ] **Step 2: Run** `uv run python -m pytest tests/unit/fastapi/test_ocr_text_corrections.py -v` — FAIL.
- [ ] **Step 3: Implement** routes, models, repository method, API client methods.
- [ ] **Step 4: Run** — PASS; also `tests/unit/fastapi/test_ocr.py` and `test_archived_pdfs.py`.
- [ ] **Step 5: Commit** `feat(ocr): routes to write TEI text corrections to the PDF (#931)`.

### Task 6: Frontend action

**Files:**
- Create: `app/src/plugins/text-corrections.js`, `app/src/templates/text-corrections-dialog.html` (+ generated `.types.js` per template convention)
- Modify: `app/src/plugins.js` (register), `app/src/ui.js` (typedef import), `app/src/modules/api-client-v1.js` (already done in Task 5)
- Test: `tests/unit/js/text-corrections.test.js` (pure helpers), `tests/e2e/tests/ocr-text-corrections.spec.js`

**Interfaces:**
- Consumes: Task 5 API client methods; `tools.addMenuItems`, `xmleditor.saveIfDirty`, `filedata.saveXml(fileHash, true)`, `file-selection.reload`, `services.load` (pattern of `document-actions.js` `saveToNewCopy` branch, lines ~544–575)
- Produces: plugin `text-corrections` (deps: `client`, `tools`); exported pure helper `summarizePreview(preview: TextCorrectionsPreview) -> {canApply: boolean, needsSkip: boolean, text: string}`.

Flow: Tools menu item **Write text corrections to PDF** (category `ocr`, visible for reviewers, enabled when a TEI is open) → `saveIfDirty()` → preview → dialog: list of corrections (`page · old → new`), unwritable changes with a "Skip these" checkbox (required to enable **Write**), affected files ("keep the old PDF"), or `reason` alone with only **Close** → apply → put returned xml into the editor, `markAsClean()`, `saveXml(state.xml, true)`, reload file list, load the new version, `notify("Corrections written to the PDF. You are now editing a new version based on the corrected PDF.", "success", "check-circle")`. A 422 shows the message and the line numbers. `testLog('TEXT_CORRECTIONS_APPLIED', { newFileId, corrections })`.

- [ ] **Step 1:** failing node test for `summarizePreview` (reason → `canApply:false`; unwritable → `needsSkip:true`; plain → text contains `1 correction`).
- [ ] **Step 2:** FAIL. **Step 3:** implement plugin, template, typedefs. **Step 4:** PASS.
- [ ] **Step 5:** E2E spec: as reviewer on a demo document without a layout, menu item opens the dialog with the `MISSING_LAYOUT_MESSAGE` reason and no **Write** button (the full write path needs GROBID and is covered by Task 5/7 tests). Run `npm run test:e2e -- --grep "text corrections"`.
- [ ] **Step 6:** `node scripts/dev/ui-screenshot.js --out <scratchpad>/tc.png --click …` with `--mock '**/api/v1/ocr/text-corrections/preview={"json":{…one correction, one unwritable…}}'`; view it.
- [ ] **Step 7: Commit** `feat(ocr): Tools action to write text corrections to the PDF (#931)`.

### Task 7: GROBID handler (repo `pte-plugins`)

**Files:**
- Create: `plugins/grobid/src/pte_plugin_grobid/text_corrections.py`
- Modify: `plugins/grobid/src/pte_plugin_grobid/plugin.py` (register/unregister next to the layout provider), `plugins/grobid/README.md`, `plugins/grobid/src/pte_plugin_grobid/docs/training-data.md`
- Test: `plugins/grobid/src/pte_plugin_grobid/tests/test_text_corrections.py`

**Interfaces:**
- Consumes: `CorrectedPdfHandler`, `CorrectedPdfMismatch` (Task 4); `TrainingHandler._fetch_training_package`, `cache_training_data`, `get_cache_zip`, `read_feature_rows`, `align`, `first_token`, `set_revision_label`, `set_pdf_hash_label`, `parse_encoding_labels`, `check_grobid_revision`, `get_grobid_server_url`
- Produces:
  - `unmatched_lines(xml: str, doc_id: str, labels: Mapping[str, str]) -> set[int] | None` — indexes of zone lines with text whose first token has no row with that token in the cached feature file for `labels`; None if no cache entry.
  - `corrected_pdf_handler(xml: str, doc_id: str, pdf_path: Path, pdf_hash: str, corrected_lines: frozenset[int]) -> str`

Handler: `before = unmatched_lines(xml, doc_id, labels)`; fetch the training package for `pdf_path` with the TEI's flavor, `cache_training_data(..., pdf_hash=pdf_hash)`; new labels = old with `revision` = live revision and `pdf-hash` = `pdf_hash`; `after = unmatched_lines(updated_xml, doc_id, new_labels)`; if `after - (before - corrected_lines)` is non-empty → `CorrectedPdfMismatch("The feature file of the corrected PDF does not match these lines of the document.", sorted(...))`. GROBID unreachable → `RuntimeError` (route maps it to 502).

- [ ] **Step 1:** failing tests: `unmatched_lines` on a synthetic cache zip (one line whose first token differs); handler with `_fetch_training_package` monkeypatched to return a feature file where line 2 starts with `Regel12).` → returns xml with the new `pdf-hash`; variant where a previously matching line no longer matches → raises `CorrectedPdfMismatch` with that line.
- [ ] **Step 2:** FAIL. **Step 3:** implement and register (guarded import). **Step 4:** PASS: `uv run --project "$PTE_ROOT" python -m pytest plugins/grobid/src/pte_plugin_grobid -q`.
- [ ] **Step 5: Commit** in `pte-plugins` `feat(grobid): regenerate the feature file for PDFs with corrected text (#931)`.

### Task 8: Documentation, issue update, full suite

**Files:**
- Modify: user manual page on OCR (`docs/user-manual/`, the page describing text recognition), `docs/code-assistant/architecture-backend.md` (text layer modules), issue #931 body (decisions listed under **Spec** above)

- [ ] **Step 1:** Document the action (who, when, what happens to the old version and other files) and the patching approach for developers.
- [ ] **Step 2:** `gh issue edit 931` with the three decisions.
- [ ] **Step 3:** `npm run test:unit` and `npm run test:e2e` — all pass; paste the summary lines.
- [ ] **Step 4: Commit** `docs: writing text corrections to the PDF (#931)`.
