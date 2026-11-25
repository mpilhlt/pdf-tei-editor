"""
OCRmyPDF plugin that repairs misrecognized footnote markers (#904).

Loaded by passing its module name in the `plugins` argument of `ocrmypdf.ocr()`. The
repair (see `footnote_markers.py`) needs the page images and the footnote numbering of the
whole document, so it runs in two places:

1. `FootnoteMarkerEngine.generate_hocr()` runs Tesseract on a page as usual, then analyzes
   the page (which needs the page image) and writes the result next to the hOCR file
   (`<hocr>.markers.json`). This runs in OCRmyPDF's worker processes.
2. `FootnoteMarkerExecutor` wraps OCRmyPDF's executor. While the pages are recognized, it
   records the hOCR file of every page; when all pages are done, it decides the repairs for
   the document and rewrites the hOCR files. This runs in the main process, before OCRmyPDF
   builds the text layer from the hOCR files (`OcrGrafter.finalize()`).

The executor also reports the progress of every step of OCRmyPDF that runs on it (see
`fastapi_app.lib.ocr.progress`).

Both are returned by OCRmyPDF hooks. OCRmyPDF calls plugins registered after its built-in
ones first, so they take precedence. Only the hOCR path is covered, which OCRmyPDF uses with
its default PDF renderer (fpdf2); with the `sandwich` renderer Tesseract writes the PDF
directly and nothing is repaired.
"""

import logging
import threading
from collections.abc import Callable, Iterable
from pathlib import Path

from ocrmypdf import Executor, OcrOptions, hookimpl
from ocrmypdf._progressbar import ProgressBar
from ocrmypdf.builtin_plugins.concurrency import StandardExecutor
from ocrmypdf.builtin_plugins.tesseract_ocr import TesseractOcrEngine
from PIL import Image

from fastapi_app.lib.ocr.progress import report_progress
from fastapi_app.plugins.ocrmypdf.footnote_markers import (
    PageAnalysis,
    analyze_page,
    apply_repairs,
    make_tesseract_digit_recognizer,
    parse_hocr,
    plan_repairs,
    write_hocr,
)

logger = logging.getLogger(__name__)

ANALYSIS_SUFFIX = ".markers.json"

PHASES: dict[str, str] = {
    "Scanning contents": "Analyzing the pages",
    "OCR": "Recognizing text",
    "hOCR": "Recognizing text",
    "Image processing": "Processing the page images",
    "Grafting hOCR to PDF": "Building the text layer",
    "JBIG2": "Optimizing images",
    "PNGs": "Optimizing images",
    "Recompressing JPEGs": "Optimizing images",
    "Deflating JPEGs": "Optimizing images",
}
"""Descriptions of OCRmyPDF's steps for the user, by OCRmyPDF's description."""
REPAIR_PHASE = "Repairing footnote markers"

# OCRmyPDF runs the executor in the thread that called `ocrmypdf.ocr()`, so the count of a
# run is kept per thread; several OCR jobs may run concurrently in their own threads
_state = threading.local()


def reset_repair_count() -> None:
    """Reset the number of repaired markers before a run in the current thread."""
    _state.count = 0


def repair_count() -> int:
    """Return the number of markers repaired by the last run in the current thread."""
    return int(getattr(_state, "count", 0))


def analysis_path(hocr_path: Path) -> Path:
    """Return the path of the page analysis written next to an hOCR file."""
    return hocr_path.with_name(hocr_path.name + ANALYSIS_SUFFIX)


class FootnoteMarkerEngine(TesseractOcrEngine):
    """Tesseract engine that also analyzes the footnote markers of every page."""

    @staticmethod
    def generate_hocr(input_file: Path, output_hocr: Path, output_text: Path, options: OcrOptions) -> None:
        TesseractOcrEngine.generate_hocr(input_file, output_hocr, output_text, options)
        # The English model reads digits best; the document languages add further readings
        languages = list(dict.fromkeys(["eng", *options.languages]))
        try:
            with Image.open(input_file) as image:
                analysis = analyze_page(parse_hocr(Path(output_hocr)).getroot(), image, make_tesseract_digit_recognizer(languages))
            analysis_path(Path(output_hocr)).write_text(analysis.to_json(), encoding="utf-8")
        except Exception as e:
            # The repair is an improvement, a failure must not fail the recognition
            logger.warning(f"Footnote marker analysis failed for {Path(input_file).name}: {type(e).__name__}: {e}")


def repair_document(hocr_files: dict[int, Path]) -> int:
    """
    Repair the footnote markers in the hOCR files of a document.

    Args:
        hocr_files: The hOCR file of every recognized page, by page number

    Returns:
        The number of repaired markers
    """
    pages = sorted(hocr_files)
    analyses = []
    for page in pages:
        path = analysis_path(hocr_files[page])
        analyses.append(PageAnalysis.from_json(path.read_text(encoding="utf-8")) if path.exists() else PageAnalysis())
    count = 0
    for page, repairs in zip(pages, plan_repairs(analyses)):
        if not repairs:
            continue
        tree = parse_hocr(hocr_files[page])
        apply_repairs(tree.getroot(), repairs)
        write_hocr(tree, hocr_files[page])
        count += len(repairs)
        logger.debug(f"Page {page + 1}: repaired footnote markers " + ", ".join(f"{repair.old!r} -> {repair.new!r}" for repair in repairs))
    return count


class FootnoteMarkerExecutor(StandardExecutor):
    """OCRmyPDF executor that repairs the footnote markers once all pages are recognized."""

    def _execute(
        self,
        *,
        use_threads: bool,
        max_workers: int,
        progress_kwargs: dict[str, object],
        worker_initializer: Callable[..., object],
        task: Callable[..., object],
        task_arguments: Iterable[object],
        task_finished: Callable[[object, ProgressBar], None],
    ) -> None:
        hocr_files: dict[int, Path] = {}
        desc = str(progress_kwargs.get("desc") or "")
        phase = PHASES.get(desc, desc or "Processing")
        unit = progress_kwargs.get("unit")
        # Pipelines that count two tasks per page scale the count by 0.5
        scale = progress_kwargs.get("unit_scale")
        scale = float(scale) if isinstance(scale, (int, float)) else 1.0
        total_tasks = progress_kwargs.get("total")
        total = round(total_tasks * scale) if isinstance(total_tasks, (int, float)) else None
        finished = 0
        report_progress(phase, 0 if total else None, total or None, str(unit) if unit else None)

        def record(result: object, pbar: ProgressBar) -> None:
            nonlocal finished
            # Page results of the OCR step carry the hOCR file in `ocr`; other steps
            # (page analysis, optimization) use the executor too and are passed through
            hocr = getattr(result, "ocr", None)
            pageno = getattr(result, "pageno", None)
            if isinstance(hocr, Path) and hocr.suffix == ".hocr" and isinstance(pageno, int):
                hocr_files[pageno] = hocr
            task_finished(result, pbar)
            finished += 1
            if total:
                report_progress(phase, min(total, int(finished * scale)), total, str(unit) if unit else None)

        super()._execute(
            use_threads=use_threads,
            max_workers=max_workers,
            progress_kwargs=progress_kwargs,
            worker_initializer=worker_initializer,
            task=task,
            task_arguments=task_arguments,
            task_finished=record,
        )
        if not hocr_files:
            return
        report_progress(REPAIR_PHASE)
        try:
            count = repair_document(hocr_files)
        except Exception as e:
            logger.warning(f"Footnote marker repair failed: {type(e).__name__}: {e}")
            return
        _state.count = repair_count() + count
        logger.debug(f"Repaired {count} footnote markers on {len(hocr_files)} pages")


@hookimpl
def get_ocr_engine(options: OcrOptions | None) -> TesseractOcrEngine | None:
    """Return the analyzing engine wherever OCRmyPDF would use Tesseract."""
    if options is not None and getattr(options, "ocr_engine", "auto") not in ("auto", "tesseract"):
        return None
    return FootnoteMarkerEngine()


@hookimpl
def get_executor(progressbar_class: type[ProgressBar]) -> Executor:
    """Return the executor that runs the document-wide repair."""
    return FootnoteMarkerExecutor(pbar_class=progressbar_class)
