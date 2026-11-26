"""
The LLM correction pass of the OCR text layer (#931): run right after OCR, without human review.

The pages that need a review (see `pages_needing_review`) are cut into windows of their lines, an
LLM proposes line corrections for each window, and the corrections are written into the invisible
text layer of the PDF in place. Only words that a correction refers to are patched. Problems with
the LLM or with patching are reported in the result, never raised.

Pure module: no FastAPI imports.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pikepdf
import requests
from pypdf.errors import PyPdfError

from fastapi_app.lib.llm.base import LLMProvider, LLMProviderError
from fastapi_app.lib.llm.json_response import UnusableResponseError
from fastapi_app.lib.ocr.line_review import (
    LOG_PREFIX,
    MIN_LETTERS,
    LineCorrection,
    ReviewLines,
    letters_similar,
    review_lines_window,
)
from fastapi_app.lib.ocr.progress import report_progress
from fastapi_app.lib.ocr.text_layer import (
    LayerLine,
    LayerPage,
    LayerWord,
    WordPatch,
    layer_lines,
    patch_text_layer,
    read_text_layer,
)
from fastapi_app.lib.ocr.text_quality import MARKER_GARBAGE, pages_needing_review

logger = logging.getLogger(__name__)

MIN_LETTER_SIMILARITY_KEY = "ocr.llm-correction.min-letter-similarity"
DEFAULT_MIN_LETTER_SIMILARITY = 0.7
MAX_PAGES_KEY = "ocr.llm-correction.max-pages"
DEFAULT_MAX_PAGES = 50

WINDOW_PAGES = 2  # consecutive pages reviewed together
MAX_LINE_WORDS = 80  # more words in one text object: the renderer did not write one text object per line

REASON_NOT_WHOLE_WORDS = "not whole words"
REASON_NOT_LINES = f"text not structured in lines (a text object with more than {MAX_LINE_WORDS} words)"
REASON_LETTERS = "letters differ too much"
REASON_NUMBER = "number change outside a footnote marker"
REASON_FEW_LETTERS = "too few letters to check the change"

MARKER_WORD = re.compile(r"^([^\W\d_]*)(\d{1,3})([)\].,;:]*)$")
"""
A word with a footnote marker: optional letters, 1 to 3 digits, and optional closing brackets and punctuation,
e.g. "tut312", "Regel12)." or "12".
"""
MAX_MISREAD_MARKER = 4
"""The most characters OCR reads a footnote marker as."""
MISREAD_MARKER_CHARS = frozenset(MARKER_GARBAGE + ")].,;:")
"""The characters a misread footnote marker may consist of."""

PROGRESS_PHASE = "Correcting OCR errors"

PROVIDER_ERRORS = (LLMProviderError, UnusableResponseError, requests.RequestException)
"""
Expected errors of a review call (LLMRateLimitError is an LLMProviderError); they are logged without a
traceback. Any other error stops the pass too, but is logged with one.
"""
READ_ERRORS = (PyPdfError, pikepdf.PdfError, OSError)
"""Expected errors when reading or saving the PDF; they are logged without a traceback."""


@dataclass
class AppliedCorrection:
    """A line correction written into the text layer."""

    page: int
    old: str
    new: str
    rationale: str


@dataclass
class CorrectionRun:
    """The result of a correction pass."""

    corrections: list[AppliedCorrection]
    """The corrections written into the text layer."""
    pages_reviewed: list[int]
    """The pages of the windows the LLM reviewed."""
    skipped: int
    """Corrections not applied because patching their page or saving the PDF failed."""
    error: str | None
    """Why the pass stopped early or could not save, if it did."""
    pages_skipped: list[int] = field(default_factory=list)
    """
    Selected pages not reviewed: their text layer cannot be patched or is not structured in lines, or they are
    beyond the page limit (also in `pages_over_limit`).
    """
    pages_selected: list[int] = field(default_factory=list)
    """The pages `pages_needing_review` selected."""
    pages_over_limit: list[int] = field(default_factory=list)
    """Reviewable pages not reviewed because the pass reviews at most `max_pages` pages."""
    max_pages: int = DEFAULT_MAX_PAGES
    """The most pages the pass reviews."""
    found: int = 0
    """The plausible corrections the LLM proposed (applied or not)."""


# ── Lines and patches ────────────────────────────────────────────────


def review_lines_for_pages(
    pages: Sequence[LayerPage], page_indices: Sequence[int], languages: list[str]
) -> tuple[ReviewLines, list[LayerLine]]:
    """
    Number the lines of the selected pages globally and cut them into windows of up to 2 consecutive pages;
    a page that does not follow the previous selected page starts a new window. Returns the review lines and
    the layer line of each global line index.

    Each run of consecutive selected pages is surrounded by the lines of its neighbouring pages (if they could
    be reviewed themselves), which belong to no window. They are the only lines besides the run's own that the
    context of the run's windows may come from, so a window never gets context from a page far away.
    """
    runs: list[list[int]] = []
    for index in sorted(set(page_indices)):
        if runs and index == runs[-1][-1] + 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    lines: list[LayerLine] = []
    windows: list[range] = []
    context: list[range] = []
    after_starts: dict[int, int] = {}  # neighbouring page after a run -> the index of its first line

    def add(page: int) -> int:
        start = len(lines)
        lines.extend(layer_lines(pages[page]))
        return start

    def neighbour(page: int) -> bool:
        return 0 <= page < len(pages) and _not_reviewable(pages[page]) is None

    for run in runs:
        before = run[0] - 1
        if before in after_starts:  # one page between this run and the previous one
            context_start = after_starts[before]
        else:
            context_start = add(before) if neighbour(before) else len(lines)
        run_windows = len(windows)
        for offset in range(0, len(run), WINDOW_PAGES):
            window_start = len(lines)
            for page in run[offset : offset + WINDOW_PAGES]:
                add(page)
            if len(lines) > window_start:
                windows.append(range(window_start, len(lines)))
        after = run[-1] + 1
        if neighbour(after):
            after_starts[after] = add(after)
        context.extend(range(context_start, len(lines)) for _ in windows[run_windows:])
    return ReviewLines([line.text for line in lines], windows, languages, context), lines


def _word_offsets(line: LayerLine) -> list[int]:
    """Return the offset of each word in the line text."""
    offsets: list[int] = []
    offset = 0
    for word in line.words:
        offsets.append(offset)
        offset += len(word.text) + 1
    return offsets


def _marker_change(old: str, new: str) -> bool:
    """
    Whether the change from `old` to `new` restores a footnote marker that OCR misread, judged by its shape
    (with or without a bracket): `new` is letters W, 1-3 digits and trailing punctuation P (see `MARKER_WORD`),
    and `old` is W, 1-4 characters OCR reads a marker as (`MISREAD_MARKER_CHARS`), and P. W may be empty for a
    standalone marker. E.g. "tut?!?" -> "tut312", "würde‘." -> "würde165.", "?!" -> "12", "*," -> "7,".
    """
    match = MARKER_WORD.match(new)
    if match is None:
        return False
    word, _, end = match.groups()
    if not old.startswith(word) or not old.endswith(end):
        return False
    misread = old[len(word) : len(old) - len(end)]
    return 1 <= len(misread) <= MAX_MISREAD_MARKER and all(c in MISREAD_MARKER_CHARS for c in misread)


def _digits(text: str) -> str:
    return "".join(char for char in text if char.isdigit())


def _implausible_word(old: str, new: str, min_letter_similarity: float) -> str | None:
    """
    Why the change of a single word from `old` to `new` is not plausible as an OCR fix, or None. A change of
    the digits of a word is only accepted as a restored footnote marker (see `_marker_change`), whatever the
    length of the word. Otherwise the letters must be similar (see `letters_similar`), and a word with fewer
    than 3 letters on either side cannot be checked and is not changed.
    """
    if _digits(old) != _digits(new):
        return None if _marker_change(old, new) else REASON_NUMBER
    letters = [sum(char.isalpha() for char in text.casefold()) for text in (old, new)]
    if min(letters) < MIN_LETTERS:
        return REASON_FEW_LETTERS
    return None if letters_similar(old, new, min_letter_similarity) else REASON_LETTERS


def _correction_patches(
    lines: Sequence[LayerLine], corrections: Sequence[LineCorrection], min_letter_similarity: float
) -> tuple[list[tuple[LineCorrection, list[WordPatch]]], list[str]]:
    """
    Turn line corrections into word patches, see :func:`patches_from_corrections`. Returns each correction
    that gives new patches together with them, and a description of each dropped correction.
    """
    result: list[tuple[LineCorrection, list[WordPatch]]] = []
    dropped: list[str] = []
    patched: dict[LayerWord, str] = {}
    for correction in corrections:
        description = f"line {correction.line + 1}: {correction.old!r} -> {correction.new!r}"
        if not 0 <= correction.line < len(lines):
            dropped.append(f"{description}: no such line")
            continue
        line = lines[correction.line]
        text = line.text
        old_words, new_words = correction.old.split(), correction.new.split()
        position = text.find(correction.old)
        offsets = _word_offsets(line)
        if (
            not old_words
            or position < 0
            or text.find(correction.old, position + 1) >= 0
            or position not in offsets
            or " ".join(old_words) != correction.old
        ):
            dropped.append(f"{description}: {REASON_NOT_WHOLE_WORDS}")
            continue
        first = offsets.index(position)
        words = line.words[first : first + len(old_words)]
        if [word.text for word in words] != old_words:
            dropped.append(f"{description}: {REASON_NOT_WHOLE_WORDS}")
            continue
        if len(new_words) != len(old_words):
            dropped.append(f"{description}: different number of words")
            continue
        changed = [(word, new) for word, new in zip(words, new_words) if new != word.text]
        reasons = [_implausible_word(word.text, new, min_letter_similarity) for word, new in changed]
        reason = next((r for r in reasons if r is not None), None)
        if reason is not None:
            dropped.append(f"{description}: {reason}")
            continue
        if any(patched.get(word, new) != new for word, new in changed):
            dropped.append(f"{description}: conflicts with another correction")
            continue
        patches: list[WordPatch] = []
        for word, new in changed:
            if word not in patched:
                patched[word] = new
                patches.append(WordPatch(word, new))
        if patches:
            result.append((correction, patches))
    return result, dropped


def patches_from_corrections(
    lines: Sequence[LayerLine], corrections: Sequence[LineCorrection], min_letter_similarity: float
) -> tuple[list[WordPatch], list[str]]:
    """
    Turn line corrections into word patches: `old` must occur exactly once in the line text and cover a run of
    whole words, and `new` must have as many words. Each changed word must be plausible on its own (see
    `_implausible_word`), otherwise the whole correction is dropped. Each word whose text changes gives a patch;
    a correction that would patch an already patched word differently is dropped. Returns the patches and a
    description of each dropped correction.
    """
    result, dropped = _correction_patches(lines, corrections, min_letter_similarity)
    return [patch for _, patches in result for patch in patches], dropped


def _not_reviewable(page: LayerPage) -> str | None:
    """Why a page is not reviewed, or None."""
    if page.unpatchable is not None:
        return page.unpatchable
    if any(len(line.words) > MAX_LINE_WORDS for line in layer_lines(page)):
        return REASON_NOT_LINES
    return None


# ── The pass ─────────────────────────────────────────────────────────


def _log_failure(message: str, error: Exception, expected: tuple[type[Exception], ...]) -> None:
    """Log a failure of the pass as a warning, with a traceback if `error` is not of an `expected` type."""
    if isinstance(error, expected):
        logger.warning(f"{LOG_PREFIX}: {message}: {error}")
    else:
        logger.exception(f"{LOG_PREFIX}: {message}: {error!r}")


def _apply_corrections(
    pdf: pikepdf.Pdf,
    lines: Sequence[LayerLine],
    corrections: Sequence[LineCorrection],
    min_letter_similarity: float,
    run: CorrectionRun,
) -> None:
    """
    Patch the corrections page by page into `pdf` and record the applied and skipped ones in `run`.
    `patch_text_layer` changes nothing when it fails, so a failing page leaves `pdf` as it was.
    """
    with_patches, dropped = _correction_patches(lines, corrections, min_letter_similarity)
    for description in dropped:
        logger.info(f"{LOG_PREFIX}: correction not applied, {description}")
    by_page: dict[int, list[tuple[LineCorrection, list[WordPatch]]]] = {}
    for correction, patches in with_patches:
        by_page.setdefault(lines[correction.line].page, []).append((correction, patches))
    for page, items in sorted(by_page.items()):
        try:
            patch_text_layer(pdf, [patch for _, patches in items for patch in patches])
        except Exception as error:  # noqa: BLE001 - one page must not discard the others
            _log_failure(f"{len(items)} correction(s) on page {page + 1} not applied", error, (ValueError,))
            run.skipped += len(items)
            continue
        run.corrections.extend(AppliedCorrection(page, c.old, c.new, c.rationale) for c, _ in items)


def _save_in_place(pdf: pikepdf.Pdf, pdf_path: Path) -> Path:
    """Save `pdf` to a temp file in the directory of `pdf_path` and return its path."""
    fd, name = tempfile.mkstemp(dir=pdf_path.parent, prefix=f".{pdf_path.stem}.", suffix=".tmp")
    os.close(fd)
    temp = Path(name)
    try:
        pdf.save(temp)
        shutil.copymode(pdf_path, temp)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return temp


def _select_pages(pdf_path: Path, pages: list[int], run: CorrectionRun) -> tuple[list[LayerPage], list[int]]:
    """
    Read the text layer of `pdf_path` and return its pages and the selected pages that can be reviewed, in
    page order.
    """
    with pikepdf.open(pdf_path) as pdf:
        layer = read_text_layer(pdf)
    reviewable: list[int] = []
    for index in sorted(set(pages)):
        if not 0 <= index < len(layer):
            logger.info(f"{LOG_PREFIX}: page {index + 1} not reviewed: not in the text layer")
            run.pages_skipped.append(index)
            continue
        reason = _not_reviewable(layer[index])
        if reason is not None:
            logger.info(f"{LOG_PREFIX}: page {index + 1} not reviewed: {reason}")
            run.pages_skipped.append(index)
        else:
            reviewable.append(index)
    return layer, reviewable


def _write_corrections(
    pdf_path: Path,
    lines: Sequence[LayerLine],
    corrections: Sequence[LineCorrection],
    min_letter_similarity: float,
    run: CorrectionRun,
) -> None:
    """Patch the corrections into `pdf_path` in place (if any of them applies)."""
    temp: Path | None = None
    with pikepdf.open(pdf_path) as pdf:
        _apply_corrections(pdf, lines, corrections, min_letter_similarity, run)
        if run.corrections:
            temp = _save_in_place(pdf, pdf_path)
    if temp is not None:
        os.replace(temp, pdf_path)


async def correct_text_layer(
    pdf_path: Path,
    provider: LLMProvider,
    model_id: str,
    languages: list[str],
    min_letter_similarity: float,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> CorrectionRun:
    """
    Let an LLM correct the OCR errors of the text layer of `pdf_path` and write the corrections into it in place.

    Only pages selected by `pages_needing_review` whose text layer can be patched and is structured in lines are
    reviewed, and of these only the first `max_pages`. An error of a review call stops the review; the corrections collected so far are still applied. A
    page whose patches cannot be applied is left unchanged, and if saving fails the file stays as it was. These
    problems are reported in `error` and `skipped` of the result; the function does not raise.

    Args:
        pdf_path: The PDF with the OCR text layer; changed in place.
        provider: The LLM provider.
        model_id: The model to use.
        languages: The document's languages, for the prompt.
        min_letter_similarity: Minimum `difflib` ratio of the letters of `old` and `new` of a correction, and
            of each changed word.
        max_pages: The most pages reviewed; further reviewable pages are recorded in `pages_over_limit`.

    Returns:
        The applied corrections, the reviewed and skipped pages, the number of corrections not applied and
        the error that stopped the pass, if any.
    """
    run = CorrectionRun(corrections=[], pages_reviewed=[], skipped=0, error=None, max_pages=max_pages)
    try:
        selected = await asyncio.to_thread(pages_needing_review, pdf_path)
        run.pages_selected = sorted(set(selected))
        if not selected:
            return run
        layer, reviewable = await asyncio.to_thread(_select_pages, pdf_path, selected, run)
    except Exception as error:  # noqa: BLE001 - the pass must never fail the OCR run
        _log_failure(f"cannot read the text layer of {pdf_path.name}", error, READ_ERRORS)
        run.error = f"cannot read the text layer: {error}"
        return run
    reviewable, over_limit = reviewable[: max(0, max_pages)], reviewable[max(0, max_pages) :]
    if over_limit:
        logger.info(f"{LOG_PREFIX}: {len(over_limit)} page(s) not reviewed: the pass reviews at most {max_pages} pages")
        run.pages_over_limit = over_limit
        run.pages_skipped.extend(over_limit)
    if not reviewable:
        return run

    review, lines = review_lines_for_pages(layer, reviewable, languages)
    total = len(review.windows)
    corrections: list[LineCorrection] = []
    report_progress(PROGRESS_PHASE, 0, total, "window")
    for index, window in enumerate(review.windows):
        try:
            found, _, _ = await review_lines_window(review, index, provider, model_id, min_letter_similarity)
        except Exception as error:  # noqa: BLE001 - keep the corrections of the windows reviewed so far
            _log_failure(f"review stopped at window {index + 1} of {total}", error, PROVIDER_ERRORS)
            run.error = f"LLM review stopped at window {index + 1} of {total}: {error}"
            break
        corrections.extend(found)
        run.found += len(found)
        run.pages_reviewed.extend(sorted({lines[i].page for i in window}))
        report_progress(PROGRESS_PHASE, index + 1, total, "window")

    if corrections:
        try:
            await asyncio.to_thread(_write_corrections, pdf_path, lines, corrections, min_letter_similarity, run)
        except Exception as error:  # noqa: BLE001 - the temp file and atomic replace keep the original intact
            _log_failure(f"cannot save the corrected text layer of {pdf_path.name}", error, READ_ERRORS)
            run.error = f"cannot save the corrected text layer: {error}"
            run.skipped += len(run.corrections)
            run.corrections = []
    applied, reviewed = len(run.corrections), len(run.pages_reviewed)
    logger.info(f"{LOG_PREFIX}: {applied} correction(s) applied on {reviewed} reviewed page(s), {run.skipped} skipped")
    return run
