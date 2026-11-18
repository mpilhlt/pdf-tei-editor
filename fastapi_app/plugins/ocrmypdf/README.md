# OCRmyPDF Plugin

Registers the text recognition engine "OCRmyPDF (Tesseract)" with the OCR engine registry. It is used by the option "Apply text recognition before extraction" in the extraction dialog (see the [user manual](../../../docs/user-manual/extraction-workflow.md#text-recognition-ocr)).

## Requirements

- The Python package `ocrmypdf` (a core dependency)
- The `tesseract` program and the language data of the languages to recognize. On Debian: `apt-get install tesseract-ocr tesseract-ocr-deu ...`, on macOS: `brew install tesseract tesseract-lang`.

The Docker image installs the languages listed in the build argument `TESSERACT_LANGS`. The plugin is unavailable if `tesseract` is not installed.

## Languages

The installed Tesseract models are mapped to the normalized language codes of the application (`deu` → `de`, `chi_sim` → `zh-Hans`, `frk` → `de-Latf`). Script models (`script/Latin`), vertical text models and historical variants with a suffix (`ita_old`) are not offered.

## Parameters

| Parameter | Description |
| --- | --- |
| `mode` | `auto` (default) chooses from the text layer check: `skip` if there is no text layer or it is fine, `redo` if an existing OCR layer is poor, `force` otherwise (garbled digital text, partly scanned) |
| `deskew` | Straighten skewed pages (not in `redo` mode) |
| `rotate_pages` | Fix the orientation of pages; may invalidate annotation coordinates |

The output is a regular PDF (not PDF/A), so Ghostscript is not needed.
