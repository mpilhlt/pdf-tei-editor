# OCRmyPDF Plugin

Registers the text recognition engine "OCRmyPDF (Tesseract)" with the OCR engine registry. It is used by the option "Apply text recognition before extraction" in the extraction dialog (see the [user manual](../../../docs/user-manual/extraction-workflow.md#text-recognition-ocr)).

## Requirements

- The Python package `ocrmypdf` (a core dependency)
- The `tesseract` program and the language data of the languages to recognize. On Debian: `apt-get install tesseract-ocr tesseract-ocr-deu ...`, on macOS: `brew install tesseract tesseract-lang`.
- Optional: the `gs` program (Ghostscript) to replace a broken digital text layer without rasterizing the pages. On Debian: `apt-get install ghostscript`, on macOS: `brew install ghostscript`. Without it, such PDFs are rasterized.

The Docker image installs Ghostscript and the languages listed in the build argument `TESSERACT_LANGS`. The plugin is unavailable if `tesseract` is not installed.

## Languages

The installed Tesseract models are mapped to the normalized language codes of the application (`deu` → `de`, `chi_sim` → `zh-Hans`, `frk` → `de-Latf`). Script models (`script/Latin`), vertical text models and historical variants with a suffix (`ita_old`) are not offered.

## Parameters

| Parameter | Description |
| --- | --- |
| `mode` | `auto` (default) chooses from the text layer check, see below. `skip`: recognize pages without text only. `redo`: replace an existing OCR layer. `vectorize`: replace a digital text layer and keep the pages as vector graphics. `force`: rasterize all pages and recognize them. |
| `rasterize_fallback` | If `vectorize` is not possible, rasterize the pages instead (default). If unchecked, the run fails instead. |
| `deskew` | Straighten skewed pages (not in `redo` mode, not applied when the pages are kept as vector graphics) |
| `rotate_pages` | Fix the orientation of pages; may invalidate annotation coordinates |

`auto` chooses:

| Text layer | Mode |
| --- | --- |
| missing | `skip` |
| fine, created by OCR | `redo` |
| fine, digital | `vectorize` if the user asked for text recognition (the check cannot find all problems), `skip` otherwise |
| poor, created by OCR, no garbled characters | `redo` |
| poor otherwise (garbled characters, misplaced text, partly scanned) | `vectorize` |

"The user asked for text recognition" is the `rebuild` flag of `POST /api/v1/ocr`, which the extraction dialog sets when its checkbox is checked.

## Replacing a digital text layer (`vectorize`)

OCRmyPDF can only add a text layer to pages without text. To replace a digital text layer while keeping the appearance of the pages (`vectorize.py`):

1. Ghostscript converts all text to vector outlines (`-dNoOutputFonts`). Images are passed through unchanged.
2. Ghostscript writes every glyph as a separate path, which makes the file 20 to 50 times larger. Each distinct glyph shape is stored once as a form XObject and its occurrences are replaced by references, which brings the size back to 1.5 to 3 times the original.
3. The result is verified: same page count, page boxes and rotation, no text left, no page with more than 4% visibly changed areas, and a size of at most 8 times the original or 250 KB per page.
4. OCRmyPDF adds the new text layer in `skip` mode.

If Ghostscript is missing, fails or times out, the PDF is encrypted, or the verification fails, the pages are rasterized (`force`) unless `rasterize_fallback` is off. The method used and the reason for a fallback are recorded in the PDF's `file_metadata.ocr` (`method`, `fallback_reason`).

The output is a regular PDF (not PDF/A).

## Footnote marker repair

Tesseract reads small superscript footnote markers as punctuation (`tut³¹²⁾` → `tut?!?)`, #904). Higher resolutions (300 to 800 dpi) and the `tessdata_best` models do not help: on the example document of the issue, none of the markers was read correctly in any combination. The engine therefore repairs the markers in Tesseract's hOCR output before OCRmyPDF builds the text layer from it (`footnote_markers.py`, `ocrmypdf_plugin.py`):

1. **Per page** (in OCRmyPDF's worker processes, `FootnoteMarkerEngine.generate_hocr()`): words ending in a run of non-letters followed by `)` are marker candidates. For each, the columns whose ink lies well above the baseline of the word (the superscript) are cropped, upscaled and recognized with a digits-only whitelist, with the `eng` model and the document languages (the models read digits differently). The numbers at the start of lines (`312) Anders …`) are collected as footnote starts. The result is written next to the hOCR file (`<hocr>.markers.json`).
2. **For the document** (in the main process, `FootnoteMarkerExecutor`, after all pages are recognized and before `OcrGrafter.finalize()` parses the hOCR files): the footnote starts are fitted to an increasing sequence over the whole document (`fit_footnote_numbers()`). The footnote numbers themselves are often misread too (`13)` for 113, `1835)` for 183), so each may be taken as read, with one digit wrong, missing or extra, or left out; skipped numbers cost a penalty, and the sequence may restart near 1 (a new article). This yields the range of footnote numbers on every page. The candidates of a page get numbers from that range in reading order, from the readings that end with them (`plan_repairs()`), and the hOCR files are rewritten.

A marker is only changed if a reading fits the numbering, and markers read correctly by Tesseract advance it. On the 71-page example document, 286 of 313 markers were repaired, all in ascending order. The repair needs the default PDF renderer (fpdf2), which builds the text layer from the hOCR files; with the `sandwich` renderer nothing is repaired. A failure of the repair is logged and does not fail the recognition. The number of repaired markers is reported in the result message.

The document step relies on two details of OCRmyPDF 17 that are not part of its plugin API: the page results passed to the executor's `task_finished` callback carry the hOCR file in `ocr`, and the hOCR files are parsed only in `OcrGrafter.finalize()`. If a later version changes this, the repair does nothing; `TestRepairIntegration` in `tests/test_footnote_markers.py` detects it.

The plugin is passed to every OCRmyPDF run: OCRmyPDF serializes runs with different plugin sets, so making it optional would block concurrent jobs. The markers handled are those followed by `)`; plain superscript numbers without a parenthesis are not recognized as candidates yet.

## Word recognition

The engine implements `recognize_words()` (Tesseract TSV output), which the text layer check uses to compare the text layer with the words recognized on sample pages (`fastapi_app/lib/ocr/layout_check.py`).

## Tests

`tests/fixtures/make_fixtures.py` creates the fixture PDFs (a broken ToUnicode map and a misplaced text layer). The integration tests in `tests/test_vectorize.py` are skipped if Ghostscript or Tesseract are not installed.
