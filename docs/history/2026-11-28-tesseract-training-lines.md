# Tesseract training lines from reviewed pages (phase 1 of #959)

## Goal

Find out with real data whether fine-tuning Tesseract on the lines that annotators and reviewers have corrected lowers the error rate on our documents, and how long fine-tuning takes on a CPU, before building the nightly training job of #959.

## Step 0 (done by Christian)

The `tessdata_best` models are downloadable at startup (PR #963, option "Recognition model"). On the documents tried, they read about 95% of the superscript footnote markers correctly where the fast models failed, but still read some `§` as `$`. The OCRmyPDF README's claim that best models do not help with markers is corrected.

## Implemented

- `fastapi_app/lib/ocr/training_lines.py`: which pages count as reviewed OK (`ok_pages()`), the ground truth of each layer line from the existing TEI↔layer word alignment (`ground_truth_lines()`), line boxes from pdfium's character boxes matched to the layer's words (`line_boxes()`), line images cut from the rendered page (`render_line_images()`), archive entries (`write_lines()`).
- `GET /api/v1/ocr/training-lines` (admin): zip archive of all exported lines, optionally of one collection.
- `scripts/dev/tesseract-lines.py`: `fetch` (download with an access token), `split` (train/eval by document, corrected lines repeated in train), `eval` (CER/WER overall and on corrected lines, frequent confusions, time per line).

## Decisions

- A page counts as OK if a final mark decides it, or else with at least one human OK and no not-OK mark. LLM marks do not count, since the LLM corrections are only proposals until a human confirms the page.
- Lines are left out rather than guessed when the alignment is not clean, including both lines next to TEI text the layer does not have.
- The image is rendered from the PDF the TEI version is attached to; correcting the text layer does not change the page image, so nothing is captured at OCR time.
- The export is synchronous (a zip built in a worker thread). For the experiment this is enough; the nightly job (phase 4) collects incrementally.

## How to run the experiment

```bash
set -a && source .env && set +a
uv run python scripts/dev/tesseract-lines.py fetch -o lines.zip
uv run python scripts/dev/tesseract-lines.py split lines.zip gt
uv run python scripts/dev/tesseract-lines.py eval gt/eval -m deu -m best/deu --tessdata-dir data/plugins/ocrmypdf/tessdata
git clone https://github.com/tesseract-ocr/tesstrain
make -C tesstrain tesseract-langdata
time make -C tesstrain training MODEL_NAME=deu_pte START_MODEL=deu TESSDATA=<folder with the best deu.traineddata> GROUND_TRUTH_DIR=$PWD/gt/train MAX_ITERATIONS=10000
cp tesstrain/data/deu_pte.traineddata <tessdata folder>/
uv run python scripts/dev/tesseract-lines.py eval gt/eval -m best/deu -m deu_pte --tessdata-dir <tessdata folder>
```

## Fine-tuning speed

Measured in the cloud container (4 cores, Tesseract 5.3.4 from Ubuntu, `tessdata_best` `deu` as start model) on 800 synthetic German lines (Liberation Serif, about 1,200 × 70 px, with `§`, umlauts and abbreviations):

| Run | Wall time |
| --- | --- |
| tesstrain `training`, 1,000 iterations, including the preparation of the 800 lines | 2 min 7 s |
| `lstmtraining`, 300 iterations, `OMP_THREAD_LIMIT=1` | 55 s (about 0.18 s per line) |
| `lstmtraining`, 300 iterations, 4 threads | 36 s (about 0.12 s per line) |

Tesseract scales every line to a fixed height, so the time per iteration grows with the width-to-height ratio of a line. Lines of a book page at 300 dpi are about twice as wide relative to their height as the synthetic ones, so roughly 0.3–0.4 s per iteration on one core: 10,000 iterations take about an hour on one core, or 20–40 minutes on four threads. Memory stayed below 1 GB. The Ubuntu/Debian package `tesseract-ocr` ships `lstmtraining` and the other training programs, so no extra build is needed. tesstrain downloads its stock unicharsets with `wget` from github.com (`make tesseract-langdata`); behind a proxy that blocks this, fetch them from raw.githubusercontent.com into `data/langdata/`.

## Next

Decide from the CER of `best/deu` vs. the fine-tuned model on held-out documents whether phases 2–4 of #959 (incremental collection, training/evaluation/deployment, nightly job) are worth building.
