# OCR job files of older versions break text corrections

"Write text corrections to PDF" failed with a 500 error. `_correction_context()` calls `OcrJobStore.find_active()`, which reads every job file in the jobs directory. A job file written before #944 (a finished job whose LLM correction pass had timed out) had a `result` without `source_stable_id`, which is now required, so validating it raised a `ValidationError` and every lookup of the store failed until the file was older than 24 hours.

## Fix

- `OcrJobStore.get()` migrates job files of older versions: a `result` without `source_stable_id` gets the result's `stable_id`, since the result was stored in the source PDF before #944.
- A job file that cannot be parsed or validated is logged as a warning and treated as missing, so one bad file no longer breaks `find_active()`, `create()` or the job polling. `cleanup()` deletes it once it is older than `JOB_MAX_AGE_SECONDS`.

Tests: `TestOcrJobStore` in `tests/unit/fastapi/test_ocr.py`.
