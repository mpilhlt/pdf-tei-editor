# OCRmyPDF Plugin

Registers the text recognition engine "OCRmyPDF (Tesseract)" with the OCR engine registry. It is used by the option "Apply text recognition before extraction" in the extraction dialog (see the [user manual](../../../docs/user-manual/extraction-workflow.md#text-recognition-ocr)).

## Requirements

- The Python package `ocrmypdf` (a core dependency)
- The `tesseract` program and the language data of the languages to recognize. On Debian: `apt-get install tesseract-ocr tesseract-ocr-deu ...`, on macOS: `brew install tesseract tesseract-lang`.
- Optional: the `gs` program (Ghostscript) to replace a broken digital text layer without rasterizing the pages. On Debian: `apt-get install ghostscript`, on macOS: `brew install ghostscript`. Without it, such PDFs are rasterized.

The Docker image installs Ghostscript and the languages listed in the build argument `TESSERACT_LANGS`. The `tessdata_best` models of the languages in `TESSERACT_BEST_LANGS` are downloaded at startup (see below). The plugin is unavailable if `tesseract` is not installed.

## Languages

The installed Tesseract models are mapped to the normalized language codes of the application (`deu` → `de`, `chi_sim` → `zh-Hans`, `frk` → `de-Latf`). Script models (`script/Latin`), vertical text models and historical variants with a suffix (`ita_old`) are not offered.

## Recognition models (`fast` / `best`)

The Debian packages `tesseract-ocr-<lang>` contain the `tessdata_fast` models (integer LSTM, e.g. 1.5 MB for `deu`). The more accurate `tessdata_best` models (float LSTM, 8 MB for `deu`, several times slower) are selected with the parameter `model` (#959). It is only offered once at least one best model is present. Languages without a best model use the fast one. The models used are recorded in `file_metadata.ocr.models` and named in the result message. The word recognition of the text layer check always uses the fast models.

The best models are not part of the image. At startup the plugin (`tessdata.py`):

1. downloads the missing best models of the languages in `TESSERACT_BEST_LANGS` (config key `ocr.tesseract.best_languages`; Tesseract codes separated by spaces or commas, e.g. `eng deu`; default empty: no best models are downloaded) from `tessdata_best` 4.1.0, in a background thread, into the shared data directory `<SHARED_DATA_DIR>/tesseract/tessdata_best-4.1.0/` (see `fastapi_app/lib/core/shared_data.py`). With `SHARED_DATA_DIR` pointing to a host directory used by all installations, each model is downloaded once per host. A failed download is logged and retried at the next start. The option `best` appears as soon as the first model is there, without a restart.
2. builds the link folder `data/plugins/ocrmypdf/tessdata/` with a symlink to every entry of the system model folder (fast models, `configs/`, `tessconfigs/`) and `best` pointing to the shared folder, and sets `TESSDATA_PREFIX` to it. Tesseract then lists the best models as `best/<lang>` and selects them with `-l best/deu`; they are not offered as languages. OCRmyPDF's worker processes inherit the variable. An up-to-date link folder is left alone; otherwise it is rebuilt next to the old one and swapped in.

If the setup fails (Tesseract does not report its model folder, the shared directory is not writable), a warning is logged and the system models are used. Without network access, the models can be copied into the shared folder by hand.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `TESSERACT_BEST_LANGS` | Tesseract codes of the languages whose `tessdata_best` models are downloaded at startup, separated by spaces or commas (`eng deu`). Only codes with a fast model installed are useful. Mirrored by the config key `ocr.tesseract.best_languages`: if the key is empty (the default), the variable applies; a non-empty value set in the configuration editor overrides it. | empty: no best models |
| `SHARED_DATA_DIR` | Core setting: host-wide directory that holds the downloaded best models in `tesseract/tessdata_best-4.1.0/`. Point all installations on a host to the same directory to download each model once. | `<DATA_ROOT>/shared` |
| `TESSDATA_PREFIX` | Tesseract's model folder. Normally not set: Tesseract reports its system folder. If set at startup, its folder is used as the system folder that the link folder points to. The plugin then overwrites the variable in its process with the link folder `data/plugins/ocrmypdf/tessdata/`. | Tesseract's built-in folder |
| `LOG_DIR` | Core setting: directory of `ocr-last-run.log` | `<project root>/log` |
| `TESSERACT_LANGS` | Docker build argument, not a runtime variable: the fast models installed as Debian packages `tesseract-ocr-<lang>` | `eng deu fra ita spa por nld lat grc ell rus pol ces` |
| `DEPLOY_SHARED_DIR` | `.env.deploy.*` files of `scripts/deploy/container.js` (`--shared-dir`): host directory mounted at `/app/shared`, sets `SHARED_DATA_DIR` in the container | none: data directory of the instance |

### `.env` template

```bash
# --- OCRmyPDF plugin (fastapi_app/plugins/ocrmypdf/README.md) ---
# Languages whose more accurate (and slower) tessdata_best models are downloaded at startup,
# Tesseract codes separated by spaces or commas, about 10 MB each. Empty: none, only the fast
# models of the Tesseract installation are used. A non-empty value of the config key
# ocr.tesseract.best_languages overrides it.
# TESSERACT_BEST_LANGS="eng deu"

# Host-wide directory for downloaded data such as the tessdata_best models; share it between
# all installations on a host so each model is downloaded once. Default: <DATA_ROOT>/shared
# SHARED_DATA_DIR=/opt/pdf-tei-editor-shared

# Tesseract's model folder; only needed if Tesseract does not find its models by itself.
# TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
```

For a container deployed with `scripts/deploy/container.js`, set `DEPLOY_SHARED_DIR=/opt/pdf-tei-editor-shared` in the `.env.deploy.*` file instead of `SHARED_DATA_DIR`.

## Parameters

| Parameter | Description |
| --- | --- |
| `mode` | `auto` (default) chooses from the text layer check, see below. `skip`: recognize pages without text only. `redo`: replace an existing OCR layer. `vectorize`: replace a digital text layer and keep the pages as vector graphics. `force`: rasterize all pages and recognize them. |
| `rasterize_fallback` | If `vectorize` is not possible, rasterize the pages instead (default). If unchecked, the run fails instead. |
| `deskew` | Straighten skewed pages (not in `redo` mode, not applied when the pages are kept as vector graphics) |
| `rotate_pages` | Fix the orientation of pages; may invalidate annotation coordinates |
| `model` | `fast` (default) or `best`, see above. Only offered if `tessdata_best` models are installed. |

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

Tesseract reads small superscript footnote markers as punctuation or quotation marks (`tut³¹²⁾` → `tut?!?)`, `Regel¹²` → `Regel"`, `vor.¹⁴` → `vor.'*`, #904). Higher resolutions (300 to 800 dpi) and the `tessdata_best` models do not help: on the example document of the issue, none of the markers was read correctly in any combination. The engine therefore repairs the markers in Tesseract's hOCR output before OCRmyPDF builds the text layer from it (`footnote_markers.py`, `ocrmypdf_plugin.py`):

1. **Per page** (in OCRmyPDF's worker processes, `FootnoteMarkerEngine.generate_hocr()`): words ending in a run of non-letters are marker candidates. For each, the columns whose ink lies well above the baseline of the word (the superscript) are cropped, upscaled and recognized with a digits-only whitelist, with the `eng` model and the document languages (the models read digits differently). All regions of a page are passed to Tesseract in one call per model, as a list of images (`make_tesseract_digit_recognizer()`): starting Tesseract and loading a model takes far longer than recognizing a region, and one call per region made the run take about 60% longer on ten cores. Candidates come in three kinds:
   - followed by `)` (`tut?!?)`): a candidate even if no raised glyphs are found;
   - without `)` (`Regel"`, `vor.'*`, `streng’;`): only if raised glyphs are found. Punctuation directly after the letters (`.,;:)`) and a closing quotation mark of a word with an opening one stay part of the text; hyphens and dashes are no markers;
   - words of their own without letters (`Regel "`) whose box lies at least 0.3 x-heights above the baseline of the hOCR line.

   The numbers at the start of lines (`312) Anders …`) are collected as footnote starts. A line that starts with raised non-letters (`» Vgl.`, `“Vgl.`, from a superscript footnote number) is read again in the same way and collected as a recovered footnote start. The result is written next to the hOCR file (`<hocr>.markers.json`).
2. **For the document** (in the main process, `FootnoteMarkerExecutor`, after all pages are recognized and before `OcrGrafter.finalize()` parses the hOCR files): the footnote starts are fitted to an increasing sequence over the whole document (`fit_footnote_numbers()`). The footnote numbers themselves are often misread too (`13)` for 113, `1835)` for 183), so each may be taken as read, with one digit wrong, missing or extra, or left out (recovered starts count a third); skipped numbers cost a penalty, and the sequence may restart near 1 (a new article). This yields the range of footnote numbers on every page. The candidates of a page get numbers from that range in reading order, from the readings that end with them (`plan_repairs()`). Candidates without `)` have less evidence: they get a number only if it is at most three ahead of the previous marker and not below the first footnote number of the page. Recovered footnote starts that the fit took are repaired if one of their readings contains the fitted number (`» Vgl.` → `12 Vgl.`). Then the hOCR files are rewritten.

A marker is only changed if a reading fits the numbering, and markers read correctly by Tesseract advance it. On the 71-page example document, 286 of 313 markers were repaired, all in ascending order. The repair needs the default PDF renderer (fpdf2), which builds the text layer from the hOCR files; with the `sandwich` renderer nothing is repaired. A failure of the repair is logged and does not fail the recognition. The number of repaired markers is reported in the result message.

The document step relies on two details of OCRmyPDF 17 that are not part of its plugin API: the page results passed to the executor's `task_finished` callback carry the hOCR file in `ocr`, and the hOCR files are parsed only in `OcrGrafter.finalize()`. If a later version changes this, the repair does nothing; `TestRepairIntegration` in `tests/test_footnote_markers.py` detects it.

The plugin is passed to every OCRmyPDF run: OCRmyPDF serializes runs with different plugin sets, so making it optional would block concurrent jobs. Markers that Tesseract drops (`„Wort“¹²` read as `„Wort“`) or reads as letters are not detected.

## Logging and progress

The details of a run (OCRmyPDF's steps and subprocesses, the repaired markers of every page) are written to `ocr-last-run.log` in the log directory, which the next run overwrites (`run_log.py`). Only warnings and errors of these loggers, and a summary line at the start and the end of the run, reach `app.log`.

The engine reports the progress of the run with `fastapi_app.lib.ocr.progress.report_progress()`: its own steps (text layer analysis, conversion to outlines) and every step of OCRmyPDF that runs on its executor, with the pages done (`FootnoteMarkerExecutor`), and the footnote marker repair ("Repairing footnote numbers") after every repaired page, counting the pages with markers to repair (`repair_document()`). Reports only reach the router from the thread that called `ocrmypdf.ocr()`, which inherits the reporter from `asyncio.to_thread()`; the executor's `task_finished` callbacks and the repair run there, OCRmyPDF's worker processes do not report. The router records the reports in the OCR job, and the extraction dialog shows them with the estimated remaining time.

## Word recognition

The engine implements `recognize_words()` (Tesseract TSV output), which the text layer check uses to compare the text layer with the words recognized on sample pages (`fastapi_app/lib/ocr/layout_check.py`).

## Tests

`tests/fixtures/make_fixtures.py` creates the fixture PDFs (a broken ToUnicode map and a misplaced text layer). The integration tests in `tests/test_vectorize.py` are skipped if Ghostscript or Tesseract are not installed.
