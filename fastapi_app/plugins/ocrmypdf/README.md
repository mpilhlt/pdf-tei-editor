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

## Word recognition

The engine implements `recognize_words()` (Tesseract TSV output), which the text layer check uses to compare the text layer with the words recognized on sample pages (`fastapi_app/lib/ocr/layout_check.py`).

## Tests

`tests/fixtures/make_fixtures.py` creates the fixture PDFs (a broken ToUnicode map and a misplaced text layer). The integration tests in `tests/test_vectorize.py` are skipped if Ghostscript or Tesseract are not installed.
