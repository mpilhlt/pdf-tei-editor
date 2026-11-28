# Optional post-OCR steps in the OCRmyPDF engine

Christian wanted to compare whether the footnote marker repair (#904) and the image optimization can be left out with the `tessdata_best` models (option "Recognition model", PR #963), which read about 95% of superscript markers correctly (step 0 of #959).

## Changes

- Two boolean options of the OCRmyPDF engine, both on by default, so the behaviour is unchanged:
  - `repair_footnote_markers` ("Repair footnote markers")
  - `optimize_images` ("Optimize images"): `optimize=1` (OCRmyPDF's default, lossless) or `optimize=0`
- The OCRmyPDF plugin stays loaded in every run, since OCRmyPDF serializes runs with different plugin sets. The repair is turned off with the keyword argument `pte_repair_footnote_markers=False` of `ocrmypdf.ocr()`, which OCRmyPDF keeps in `OcrOptions.extra_attrs` and passes to the worker processes. `FootnoteMarkerEngine.generate_hocr()` then skips the page analysis, and `repair_document()` returns without reporting the repair phase when no page was analyzed.
- The result message names the steps that were turned off ("Skipped: footnote marker repair, image optimization.").
- The OCR options dialog renders engine options generically, so no frontend change was needed.

## Tests

- `test_engine.py`: option defaults, message.
- `test_footnote_markers.py`: `repair_document()` without analyses; integration runs with each option off (markers stay unrepaired, no "Optimizing images" phase).
