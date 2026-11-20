"""
Check whether the text layer of a PDF matches what is shown on the page.

The character-based checks in text_quality.py cannot find text layers whose
characters are fine but whose words are split into fragments, sit in the wrong
place or are stored in the wrong order. This check renders a few pages,
recognizes the words on the page images with an OCR engine and compares them
with the words of the text layer:

- text match: how many of the words are the same (bag of words, F1 score);
  fragmented or wrong characters lower it
- position match: how many of the words found in both are at the same place
- order agreement: how many of the words found in both are in the same order
  (longest common subsequence relative to the number of matched words)
"""

import bisect
import logging
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from fastapi_app.lib.models.models_ocr import TextQualityReport
from fastapi_app.lib.ocr.base import OcrWord

logger = logging.getLogger(__name__)

SAMPLE_PAGES = 3
"""Maximum number of pages that are recognized."""

RENDER_DPI = 150
"""Resolution of the page images; enough for body text, and fast to recognize."""

MIN_PAGE_WORDS = 30
"""Pages with fewer words in the text layer are not sampled (title pages, figures)."""

MIN_COMPARED_WORDS = 20
"""Minimum number of recognized words on a page for it to count."""

MIN_TEXT_MATCH = 0.6
"""Minimum share of matching words."""

MIN_POSITION_MATCH = 0.7
"""Minimum share of matching words that are at the same place."""

MIN_ORDER_AGREEMENT = 0.6
"""Minimum share of matched words that are in the same order."""

MIN_IOU = 0.2
"""Minimum overlap (intersection over union) of two word boxes at the same place."""

WordRecognizer = Callable[[Path], list[OcrWord]]
"""Recognizes the words on a page image (see OcrEngine.recognize_words)."""


@dataclass
class LayoutCheckResult:
    """Result of comparing the text layer with the recognized words."""

    pages_checked: list[int] = field(default_factory=list)
    """0-based indices of the pages that were compared."""

    text_match: Optional[float] = None
    position_match: Optional[float] = None
    order_agreement: Optional[float] = None

    reasons: list[str] = field(default_factory=list)
    """Problems that were found."""


def normalize_word(text: str) -> str:
    """Return the comparison form of a word: lower case letters and digits without accents."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if c.isalnum())


def _iou(a: OcrWord, b: OcrWord) -> float:
    """Return the intersection over union of two word boxes."""
    width = min(a.right, b.right) - max(a.left, b.left)
    height = min(a.bottom, b.bottom) - max(a.top, b.top)
    if width <= 0 or height <= 0:
        return 0.0
    intersection = width * height
    union = (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - intersection
    return intersection / union if union > 0 else 0.0


def _longest_increasing_subsequence(values: list[int]) -> int:
    """Return the length of the longest strictly increasing subsequence."""
    tails: list[int] = []
    for value in values:
        index = bisect.bisect_left(tails, value)
        if index == len(tails):
            tails.append(value)
        else:
            tails[index] = value
    return len(tails)


@dataclass
class PageComparison:
    """Comparison of the words of one page."""

    layer_words: int
    ocr_words: int
    common_words: int
    """Words found in both (bag of words)."""

    positioned_words: int
    """Common words whose boxes overlap."""

    ordered_words: int
    """Positioned words that are in the same order in both."""


def compare_words(layer: list[OcrWord], recognized: list[OcrWord]) -> PageComparison:
    """
    Compare the words of the text layer of a page with the words recognized on its image.

    Words shorter than two letters or digits are ignored, since OCR often misses or adds them.

    Args:
        layer: Words of the text layer in the stored order
        recognized: Recognized words in reading order

    Returns:
        The counts the scores are computed from
    """
    layer = [w for w in layer if len(normalize_word(w.text)) >= 2]
    recognized = [w for w in recognized if len(normalize_word(w.text)) >= 2]
    layer_counts = Counter(normalize_word(w.text) for w in layer)
    ocr_counts = Counter(normalize_word(w.text) for w in recognized)
    common = sum((layer_counts & ocr_counts).values())

    by_text: dict[str, list[int]] = {}
    for index, word in enumerate(layer):
        by_text.setdefault(normalize_word(word.text), []).append(index)
    used: set[int] = set()
    matched_layer_indices: list[int] = []
    for word in recognized:
        best_index, best_iou = -1, MIN_IOU
        for index in by_text.get(normalize_word(word.text), []):
            if index in used:
                continue
            iou = _iou(word, layer[index])
            if iou >= best_iou:
                best_index, best_iou = index, iou
        if best_index >= 0:
            used.add(best_index)
            matched_layer_indices.append(best_index)

    return PageComparison(
        layer_words=len(layer),
        ocr_words=len(recognized),
        common_words=common,
        positioned_words=len(matched_layer_indices),
        ordered_words=_longest_increasing_subsequence(matched_layer_indices),
    )


def extract_layer_words(page: pdfium.PdfPage) -> list[OcrWord]:
    """
    Return the words of the text layer of a page with their boxes, in the stored order.

    Coordinates are fractions of the crop box, with the origin at the top left, like those of
    OcrEngine.recognize_words().
    """
    # the visible area, which is what page.render() draws
    left, bottom, right, top = page.get_bbox()
    width, height = right - left, top - bottom
    textpage = page.get_textpage()
    words: list[OcrWord] = []
    chars: list[str] = []
    box: Optional[list[float]] = None

    def flush() -> None:
        nonlocal box
        if chars and box is not None:
            words.append(OcrWord(
                text="".join(chars),
                left=(box[0] - left) / width,
                top=(top - box[3]) / height,
                right=(box[2] - left) / width,
                bottom=(top - box[1]) / height,
            ))
        chars.clear()
        box = None

    try:
        for index in range(textpage.count_chars()):
            char = chr(pdfium_c.FPDFText_GetUnicode(textpage, index) or 32)
            if char.isspace() or char == "\x00":
                flush()
                continue
            char_left, char_bottom, char_right, char_top = textpage.get_charbox(index)
            if char_right <= char_left or char_top <= char_bottom:
                chars.append(char)
                continue
            if box is None:
                box = [char_left, char_bottom, char_right, char_top]
            else:
                box = [min(box[0], char_left), min(box[1], char_bottom), max(box[2], char_right), max(box[3], char_top)]
            chars.append(char)
        flush()
    finally:
        textpage.close()
    return words


def _choose_pages(document: pdfium.PdfDocument) -> list[tuple[int, list[OcrWord]]]:
    """Choose up to SAMPLE_PAGES unrotated pages with enough text, spread over the document."""
    page_count = len(document)
    # start in the middle of the document, where body text is most likely
    order = sorted(range(page_count), key=lambda i: abs(i - page_count // 2))
    candidates: list[tuple[int, list[OcrWord]]] = []
    for index in order[:SAMPLE_PAGES * 4]:
        page = document[index]
        try:
            if page.get_rotation() != 0:
                continue
            words = extract_layer_words(page)
        finally:
            page.close()
        if len(words) >= MIN_PAGE_WORDS:
            candidates.append((index, words))
        if len(candidates) >= SAMPLE_PAGES:
            break
    return sorted(candidates)


def check_text_layout(pdf_path: Path | str, recognize: WordRecognizer) -> LayoutCheckResult:
    """
    Compare the text layer of sample pages with the words recognized on the page images.

    Args:
        pdf_path: Path to the PDF
        recognize: Recognizes the words on a page image

    Returns:
        The scores and the problems that were found; no scores if no page could be compared
    """
    result = LayoutCheckResult()
    totals = PageComparison(0, 0, 0, 0, 0)
    document = pdfium.PdfDocument(str(pdf_path))
    try:
        with tempfile.TemporaryDirectory(prefix="pte-layout-") as tmp:
            for index, layer_words in _choose_pages(document):
                page = document[index]
                try:
                    image_path = Path(tmp) / f"page-{index}.png"
                    # pypdfium2 annotates scale as int, but accepts floats
                    page.render(scale=RENDER_DPI / 72, grayscale=True).to_pil().save(image_path)  # pyright: ignore[reportArgumentType]
                finally:
                    page.close()
                recognized = recognize(image_path)
                comparison = compare_words(layer_words, recognized)
                logger.debug(f"Layout check of page {index + 1}: {comparison}")
                if comparison.ocr_words < MIN_COMPARED_WORDS:
                    continue
                result.pages_checked.append(index)
                totals.layer_words += comparison.layer_words
                totals.ocr_words += comparison.ocr_words
                totals.common_words += comparison.common_words
                totals.positioned_words += comparison.positioned_words
                totals.ordered_words += comparison.ordered_words
    finally:
        document.close()

    if not result.pages_checked:
        return result
    result.text_match = 2 * totals.common_words / (totals.layer_words + totals.ocr_words)
    result.position_match = totals.positioned_words / totals.common_words if totals.common_words else 0.0
    result.order_agreement = totals.ordered_words / totals.positioned_words if totals.positioned_words else 0.0

    pages = len(result.pages_checked)
    if result.text_match < MIN_TEXT_MATCH:
        result.reasons.append(f"Only {result.text_match:.0%} of the words recognized on {pages} sample page(s) match the text layer.")
    elif result.position_match < MIN_POSITION_MATCH:
        result.reasons.append(f"Only {result.position_match:.0%} of the words of the text layer are where they appear on the page.")
    elif result.order_agreement < MIN_ORDER_AGREEMENT:
        result.reasons.append("The words of the text layer are stored in a different order than they are read on the page.")
    return result


def apply_layout_check(report: TextQualityReport, result: LayoutCheckResult) -> TextQualityReport:
    """
    Add the result of the layout check to a text quality report, downgrading a good report to
    poor if problems were found.

    Args:
        report: The report of analyze_text_layer()
        result: The result of check_text_layout()

    Returns:
        The updated report (the same object)
    """
    report.layout_checked = bool(result.pages_checked)
    report.layout_text_match = round(result.text_match, 4) if result.text_match is not None else None
    report.layout_position_match = round(result.position_match, 4) if result.position_match is not None else None
    report.layout_order_agreement = round(result.order_agreement, 4) if result.order_agreement is not None else None
    if result.reasons:
        report.reasons.extend(result.reasons)
        if report.status == "good":
            report.status = "poor"
            report.summary = "The text layer does not match the page: text recognition is recommended."
    return report
