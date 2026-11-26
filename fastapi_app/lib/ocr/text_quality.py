"""
Assessment of the quality of the text layer of a PDF.

The analysis combines several heuristics, since there is no reference text to
compare against:

- pages without text, and pages that only contain images (scans)
- invisible text (render mode 3), which marks an existing OCR layer
- "garbled" characters: U+FFFD, control and private-use characters and
  "(cid:NN)" or "/C80" placeholders that a PDF text extractor emits for glyphs
  that have no Unicode mapping (broken font encodings)
- characters that are not grouped into words (one character per line)
- the share of tokens that look like words or numbers; OCR errors produce
  tokens that mix letters, digits and punctuation ("tbe", "l1ne", "w,ord")
  or letter-spaced fragments
- the confidence of the language identifier, which drops for text that is not
  natural language
"""

import logging
import re
import threading
import unicodedata
from pathlib import Path
from typing import Optional

from pypdf import PdfReader
from pypdf.generic import DictionaryObject

from fastapi_app.lib.models.models_ocr import TextQualityReport, TextQualityStatus
from fastapi_app.lib.services.language_detection import classify_language

logger = logging.getLogger(__name__)

MAX_PAGES = 100
"""Maximum number of pages analyzed; larger documents are sampled evenly."""

MIN_PAGE_CHARS = 20
"""Pages with fewer non-whitespace characters count as pages without text."""

MAX_GARBLED_RATIO = 0.02
"""Maximum share of garbled characters in a good text layer."""

MIN_PLAUSIBLE_WORD_RATIO = 0.8
"""Minimum share of plausible tokens in a good text layer."""

MIN_LANGUAGE_CONFIDENCE = 0.7
"""Minimum confidence of the language identifier for a good text layer."""

MAX_SINGLE_CHAR_TOKEN_RATIO = 0.5
"""Maximum share of single-character tokens before the text counts as not grouped into words."""

MAX_EMPTY_PAGE_RATIO = 0.25
"""Maximum share of pages without text before the text layer counts as incomplete."""

SUSPICIOUS_MARKER_RE = re.compile(r"[^\W\d_][?!'\"‘’“”*>®™%]{1,4}\)")
"""A letter followed by punctuation and a closing parenthesis: a footnote marker misread by OCR, e.g. "Regel?!?)"."""

_CID_RE = re.compile(r"\(cid:\d+\)|/(?:[Cc]|[Gg]|glyph)\d+\b")
_INVISIBLE_TEXT_RE = re.compile(rb"(?<![\d.])3\s+Tr\b")
# A word: optional opening punctuation, letters (with inner hyphens, apostrophes or abbreviation
# dots), optional closing punctuation
_WORD_RE = re.compile(r"^[\"'(\[„“‚‘«»¿¡]*[^\W\d_]+(?:[-'’‐.][^\W\d_]+)*[-‐]?[\"')\]”’“‘«».,;:!?…*†‡]*$")
_NUMBER_RE = re.compile(r"^[\"'(\[]*[-+±]?[\d.,/:%–-]*\d[\d.,/:%–-]*(?:st|nd|rd|th|e|er|\.)?[\"')\].,;:!?%]*$")
_ROMAN_OR_SIGLA_RE = re.compile(r"^[\W_]{1,3}$|^[A-Z]{1,6}\d*[.,;:]?$|^§+$")


def _is_garbled_char(c: str) -> bool:
    """Return whether a character indicates an unmapped glyph or binary junk."""
    if c == "�":
        return True
    category = unicodedata.category(c)
    if category == "Co":  # private use
        return True
    return category == "Cc" and c not in "\n\r\t"


def _is_plausible_token(token: str) -> bool:
    """Return whether a whitespace-separated token looks like a word, number or sigil."""
    if _WORD_RE.match(token) or _NUMBER_RE.match(token) or _ROMAN_OR_SIGLA_RE.match(token):
        return True
    # mixed-case words like "iPhone" or "McDonald" are fine; "tHe" or "wOrd" are not
    return False


def _page_has_images(page: DictionaryObject) -> bool:
    """Return whether the page's resources (or those of its form XObjects) contain images."""
    try:
        resources = page.get("/Resources")
        resources = resources.get_object() if resources is not None else None
        xobjects = resources.get("/XObject") if resources else None
        if xobjects is None:
            return False
        for ref in xobjects.get_object().values():
            xobj = ref.get_object()
            subtype = xobj.get("/Subtype")
            if subtype == "/Image":
                return True
            if subtype == "/Form" and _page_has_images(xobj):
                return True
    except Exception as e:
        logger.debug(f"Could not inspect page images: {e}")
    return False


def _page_has_invisible_text(page: DictionaryObject, depth: int = 0) -> bool:
    """
    Return whether the page content uses text render mode 3 (invisible), typical of OCR layers.

    Form XObjects are searched as well, since OCRmyPDF puts the text layer into one.
    """
    try:
        contents = page.get_contents() if depth == 0 else page  # type: ignore[attr-defined]
        if contents is not None and _INVISIBLE_TEXT_RE.search(contents.get_data()):  # type: ignore[union-attr]
            return True
        if depth > 2:
            return False
        resources = page.get("/Resources")
        resources = resources.get_object() if resources is not None else None
        xobjects = resources.get("/XObject") if resources else None
        if xobjects is None:
            return False
        for ref in xobjects.get_object().values():
            xobj = ref.get_object()
            if xobj.get("/Subtype") == "/Form" and _page_has_invisible_text(xobj, depth + 1):
                return True
    except Exception as e:
        logger.debug(f"Could not inspect page content: {e}")
    return False


def _sample_page_indices(page_count: int) -> list[int]:
    """Return the indices of the pages to analyze."""
    if page_count <= MAX_PAGES:
        return list(range(page_count))
    step = page_count / MAX_PAGES
    return sorted({int(i * step) for i in range(MAX_PAGES)})


def _extract_page_text(page: DictionaryObject, index: int) -> str:
    """Extract the text of a page; an unreadable page gives an empty string."""
    try:
        return page.extract_text() or ""  # type: ignore[attr-defined]
    except Exception as e:
        logger.debug(f"Could not extract text of page {index + 1}: {e}")
        return ""


def _text_stats(text: str) -> tuple[str, int, int, list[str], int]:
    """
    Compute the character and token statistics of a text.

    Returns:
        The text without cid placeholders, the number of characters (placeholders count as one
        character each), the number of garbled characters, the tokens and the number of plausible tokens
    """
    cid_count = len(_CID_RE.findall(text))
    text_without_cids = _CID_RE.sub("", text)
    chars = [c for c in text_without_cids if not c.isspace()]
    garbled = sum(1 for c in chars if _is_garbled_char(c)) + cid_count
    tokens = text_without_cids.split()
    plausible = sum(1 for t in tokens if _is_plausible_token(t))
    return text_without_cids, len(chars) + cid_count, garbled, tokens, plausible


class _ThreadQuietFilter(logging.Filter):
    """Drops pypdf warnings (e.g. about font encodings) in threads that are analyzing a text layer."""

    def __init__(self) -> None:
        super().__init__()
        self.local = threading.local()

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno >= logging.ERROR or not getattr(self.local, "quiet", False)


_pypdf_filter = _ThreadQuietFilter()


_PYPDF_LOGGERS = ("pypdf", "pypdf._reader", "pypdf._page", "pypdf._cmap", "pypdf._utils", "pypdf.filters", "pypdf.generic._data_structures", "pypdf._text_extraction")
"""pypdf creates some loggers only when it first logs to them, so these are created in advance."""


def _install_pypdf_filter() -> None:
    """Attach the filter to all pypdf loggers (filters of a parent logger do not apply to its children)."""
    for name in _PYPDF_LOGGERS:
        logging.getLogger(name)
    for name, candidate in list(logging.Logger.manager.loggerDict.items()):
        if (name == "pypdf" or name.startswith("pypdf.")) and isinstance(candidate, logging.Logger):
            candidate.addFilter(_pypdf_filter)  # no-op if already attached


def analyze_text_layer(pdf_path: Path | str) -> TextQualityReport:
    """
    Analyze the text layer of a PDF.

    pypdf warnings about individual pages and fonts are suppressed, since the analysis reads up
    to MAX_PAGES pages and the report covers the problems that matter.

    Args:
        pdf_path: Path to the PDF

    Returns:
        The quality report

    Raises:
        pypdf.errors.PdfReadError: If the file is not a readable PDF
    """
    _install_pypdf_filter()
    _pypdf_filter.local.quiet = True
    try:
        return _analyze_text_layer(pdf_path)
    finally:
        _pypdf_filter.local.quiet = False


def _analyze_text_layer(pdf_path: Path | str) -> TextQualityReport:
    """Analyze the text layer of a PDF; see analyze_text_layer()."""
    reader = PdfReader(str(pdf_path))
    page_count = len(reader.pages)
    indices = _sample_page_indices(page_count)

    texts: list[str] = []
    pages_without_text = image_only_pages = ocr_layer_pages = 0
    for index in indices:
        page = reader.pages[index]
        text = _extract_page_text(page, index)
        visible_chars = sum(1 for c in text if not c.isspace())
        if visible_chars < MIN_PAGE_CHARS:
            pages_without_text += 1
            if _page_has_images(page):
                image_only_pages += 1
        elif _page_has_invisible_text(page):
            ocr_layer_pages += 1
        texts.append(text)

    full_text = "\n".join(texts)
    text_without_cids, char_count, garbled, tokens, plausible = _text_stats(full_text)
    garbled_ratio = garbled / char_count if char_count else 0.0

    single_char_ratio = (sum(1 for t in tokens if len(t) == 1) / len(tokens)) if tokens else 0.0
    plausible_ratio = (plausible / len(tokens)) if tokens else None

    language: Optional[str] = None
    language_confidence: Optional[float] = None
    classified = classify_language(text_without_cids)
    if classified:
        language, language_confidence = classified

    analyzed = len(indices)
    reasons: list[str] = []
    status: TextQualityStatus = "good"

    if analyzed == 0 or pages_without_text == analyzed:
        status = "missing"
        if image_only_pages:
            reasons.append("The pages contain only images (scans) without a text layer.")
        else:
            reasons.append("The PDF has no text layer.")
    else:
        empty_ratio = pages_without_text / analyzed
        if image_only_pages and empty_ratio > MAX_EMPTY_PAGE_RATIO:
            reasons.append(f"{image_only_pages} of {analyzed} pages are scans without a text layer.")
        if garbled_ratio > MAX_GARBLED_RATIO:
            reasons.append(f"{garbled_ratio:.0%} of the characters are garbled (unmapped glyphs or control characters).")
        if single_char_ratio > MAX_SINGLE_CHAR_TOKEN_RATIO:
            reasons.append("The characters are not grouped into words, so the text cannot be read in order.")
        elif plausible_ratio is not None and plausible_ratio < MIN_PLAUSIBLE_WORD_RATIO:
            reasons.append(f"Only {plausible_ratio:.0%} of the words look like regular words, which indicates recognition errors.")
        if language_confidence is not None and language_confidence < MIN_LANGUAGE_CONFIDENCE and single_char_ratio <= MAX_SINGLE_CHAR_TOKEN_RATIO:
            reasons.append(f"The text does not read as natural language (language detection confidence {language_confidence:.0%}).")
        if reasons:
            status = "poor"

    if status == "missing":
        summary = "No text layer: text recognition is required."
    elif status == "poor":
        summary = "The text layer is of poor quality: text recognition is recommended."
    else:
        summary = "The text layer looks fine."
        if ocr_layer_pages:
            summary = "The text layer looks fine (it was created by text recognition)."

    return TextQualityReport(
        status=status,
        summary=summary,
        reasons=reasons,
        page_count=page_count,
        pages_analyzed=analyzed,
        pages_without_text=pages_without_text,
        image_only_pages=image_only_pages,
        ocr_layer_pages=ocr_layer_pages,
        char_count=char_count,
        garbled_char_ratio=round(garbled_ratio, 4),
        plausible_word_ratio=round(plausible_ratio, 4) if plausible_ratio is not None else None,
        language=language,
        language_confidence=round(language_confidence, 4) if language_confidence is not None else None,
    )


def pages_needing_review(pdf_path: Path | str) -> list[int]:
    """
    Find the pages of a text layer that are candidates for an LLM correction pass.

    All pages are checked (no sampling). A page qualifies if it has text and either has too many
    garbled characters, too few plausible tokens, or contains a suspicious footnote marker.

    Args:
        pdf_path: Path to the PDF

    Returns:
        The 0-based indices of the pages to review

    Raises:
        pypdf.errors.PdfReadError: If the file is not a readable PDF
    """
    _install_pypdf_filter()
    _pypdf_filter.local.quiet = True
    try:
        reader = PdfReader(str(pdf_path))
        selected: list[int] = []
        for index, page in enumerate(reader.pages):
            text = _extract_page_text(page, index)
            if sum(1 for c in text if not c.isspace()) < MIN_PAGE_CHARS:
                continue
            _, char_count, garbled, tokens, plausible = _text_stats(text)
            garbled_ratio = garbled / char_count if char_count else 0.0
            plausible_ratio = plausible / len(tokens) if tokens else 1.0
            if garbled_ratio > MAX_GARBLED_RATIO or plausible_ratio < MIN_PLAUSIBLE_WORD_RATIO or SUSPICIOUS_MARKER_RE.search(text):
                selected.append(index)
        return selected
    finally:
        _pypdf_filter.local.quiet = False
