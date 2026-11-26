"""
LLM review of OCR errors in zone documents (such as `grobid.training.segmentation`), page window
by page window (#931 Part A).

The model sees the plain text of the window's lines, numbered with their line ids (entities
decoded), and answers with line corrections:

    [{"line": "0412", "old": "Regel’).", "new": "Regel12).", "rationale": "..."}]

Implausible corrections are dropped (see :func:`parse_corrections`), the others are turned into
editor findings `{id, old, new, rationale}` whose `old` is an exact, unique substring of the TEI
XML (see :func:`findings_from_corrections`). Corrections whose text spans markup (a tag, comment,
`<lb/>` or `<pb/>`) are dropped, so only text nodes change.

Pure module: no FastAPI imports.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TypedDict
from xml.sax.saxutils import escape

from lxml import etree

from fastapi_app.lib.llm.base import LLMProvider
from fastapi_app.lib.ocr.line_review import (  # noqa: F401  (re-exported)
    LOG_PREFIX,
    LineCorrection,
    ReviewLines,
    build_retry_note,
    build_system_prompt,
    letters_similar,
    review_lines_window,
)
from fastapi_app.lib.ocr.line_review import build_user_prompt as _build_user_prompt
from fastapi_app.lib.ocr.line_review import parse_corrections as _parse_corrections
from fastapi_app.lib.tei.layout import MISSING_LAYOUT_MESSAGE, get_line_layout, get_zone_labels
from fastapi_app.lib.tei.zone_lines import (
    CHAR,
    SPACE,
    Line,
    Page,
    ZoneDocument,
    page_windows,
    pages_of,
    read_zone_document,
    window_lines,
)
from fastapi_app.lib.utils.tei_utils import get_document_language

logger = logging.getLogger(__name__)

MIN_LETTER_SIMILARITY_KEY = "ocr.llm-review.min-letter-similarity"
"""Config key of the minimal `difflib` ratio of the letters of `old` and `new`."""

DEFAULT_MIN_LETTER_SIMILARITY = 0.5

WINDOW_PAGES = 2

FIRST_WORD_NOTE = " (This changes the first word of the line, so the sync check reports the line until the corrections are written to the PDF.)"
"""Suffix of the rationale of a correction that changes the first word of its line."""

_TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


class MissingLayoutError(ValueError):
    """The document is a zone document, but its line layout is missing."""


class Finding(TypedDict):
    """An editor finding: replace `old` (unique in the document) by `new`."""

    id: int
    old: str
    new: str
    rationale: str


@dataclass
class OcrReviewSource:
    """A zone document cut into page windows."""

    xml: str
    doc: ZoneDocument
    windows: list[list[Page]]
    languages: list[str]
    lines: ReviewLines = field(init=False)
    """The text-only view of the document's lines, windowed like `windows`."""

    def __post_init__(self) -> None:
        self.lines = ReviewLines(
            [_line_text(self.doc, line) for line in self.doc.lines],
            [window_lines(window) for window in self.windows],
            self.languages,
        )


# ── Source ───────────────────────────────────────────────────────────


def _languages(xml: str) -> list[str]:
    """The languages of the document: all of its langUsage, else the language of get_document_language()."""
    try:
        root = etree.fromstring(xml.encode("utf-8"))
    except etree.XMLSyntaxError:
        return []
    found = root.xpath("tei:teiHeader/tei:profileDesc/tei:langUsage/tei:language/@ident", namespaces=_TEI_NS)
    idents = [str(i) for i in found if i] if isinstance(found, list) else []
    if idents:
        return list(dict.fromkeys(idents))
    language = get_document_language(root)
    return [language] if language else []


def prepare_source(xml: str, doc_id: str, variant_id: str, scope: str | None = None) -> OcrReviewSource:
    """
    The page windows of a zone document (two pages each). With a scope (the raw XML of a node
    selected in the editor), the single window holds the pages the scope lies on.

    Raises:
        MissingLayoutError: the document has no line layout.
        ValueError: the variant is not a zone document, the document cannot be read as zones, or
            the scope is not part of its `<text>` or occurs more than once in the document.
    """
    labels = get_zone_labels(variant_id)
    if labels is None:
        raise ValueError(f"Variant '{variant_id}' is not a zone document")
    layout = get_line_layout(xml, doc_id, variant_id)
    if layout is None:
        raise MissingLayoutError(MISSING_LAYOUT_MESSAGE)
    doc = read_zone_document(xml, labels)
    pages = pages_of(doc, layout.pages)
    if scope is not None:
        start = xml.find(scope)
        if start >= 0 and xml.find(scope, start + 1) >= 0:
            raise ValueError("The node to review occurs more than once in the document; review the whole document instead.")
        if start < doc.start or start + len(scope) > doc.end:
            raise ValueError("The node to review is not part of the document's <text>")
        end = start + len(scope)
        lines = {a.line for a in doc.atoms if a.line >= 0 and a.start < end and a.end > start}
        if not lines:
            raise ValueError("The node to review has no text")
        windows = [[p for p in pages if set(p.lines) & lines]]
    else:
        windows = page_windows(doc, pages, max_pages=WINDOW_PAGES)
    return OcrReviewSource(xml, doc, windows, _languages(xml))


def _line_chars(doc: ZoneDocument, line: Line) -> list[tuple[str, int | None]]:
    """
    The plain text of a line as (character, atom index): entities decoded, whitespace runs
    collapsed to one space (mapped to the run's first atom) and trimmed. Text of different zones
    without whitespace between them is separated by a space that maps to no atom.
    """
    chars: list[tuple[str, int | None]] = []
    pending: int | None = None
    previous_item = -1
    for index in line.atoms:
        atom = doc.atoms[index]
        if atom.kind == SPACE:
            if pending is None:
                pending = index
        elif atom.kind == CHAR:
            if chars and pending is not None:
                chars.append((" ", pending))
            elif chars and atom.item != previous_item:
                chars.append((" ", None))
            chars.append((atom.char, index))
            pending = None
            previous_item = atom.item
    return chars


def _line_text(doc: ZoneDocument, line: Line) -> str:
    return "".join(char for char, _ in _line_chars(doc, line))


# ── Prompts and answers (text-only core in line_review) ──────────────


def build_user_prompt(source: OcrReviewSource, window: Sequence[Page], position: tuple[int, int]) -> str:
    """The document's languages and the window's lines, with context lines (see line_review.build_user_prompt)."""
    return _build_user_prompt(source.lines, window_lines(window), position)


def parse_corrections(
    raw: str, source: OcrReviewSource, window: Sequence[Page], min_letter_similarity: float
) -> tuple[list[LineCorrection], list[str]]:
    """The plausible corrections of an answer (see line_review.parse_corrections)."""
    kept, dropped = _parse_corrections(raw, source.lines, window_lines(window), min_letter_similarity)
    logger.info(f"{LOG_PREFIX}: kept {len(kept)} of {len(kept) + len(dropped)} corrections")
    return kept, dropped


# ── Findings ─────────────────────────────────────────────────────────


def _occurs_once(xml: str, text: str) -> bool:
    first = xml.find(text)
    return first >= 0 and xml.find(text, first + 1) < 0


@dataclass(frozen=True)
class _Mapped:
    first_atom: int
    last_atom: int
    new_core: str  # replacement of xml[atoms[first_atom].start:atoms[last_atom].end]
    first_word: bool


def _map_correction(doc: ZoneDocument, correction: LineCorrection) -> _Mapped | str:
    """The atoms of the correction's `old` and their replacement, or the reason it cannot be mapped."""
    chars = _line_chars(doc, doc.lines[correction.line])
    text = "".join(char for char, _ in chars)
    offset = text.find(correction.old)
    if offset < 0 or text.find(correction.old, offset + 1) >= 0:
        return "old text does not occur exactly once in the line"
    spans = [(offset + m.start(), offset + m.end()) for m in re.finditer(r"\S+", correction.old)]
    old_words = correction.old.split()
    new_words = correction.new.split()
    if len(old_words) != len(new_words):
        return "different number of words"
    atoms = [atom for _, atom in chars[offset:offset + len(correction.old)]]
    if any(atom is None for atom in atoms):
        return "crosses markup"
    first_atom, last_atom = atoms[0], atoms[-1]
    assert first_atom is not None and last_atom is not None
    for index in range(first_atom, last_atom + 1):
        atom = doc.atoms[index]
        if atom.kind not in (CHAR, SPACE) or (index < last_atom and atom.end != doc.atoms[index + 1].start):
            return "crosses markup"
    xml = doc.xml
    parts: list[str] = []
    previous_end = doc.atoms[first_atom].start
    for (start, end), old_word, new_word in zip(spans, old_words, new_words):
        word_first = chars[start][1]
        word_last = chars[end - 1][1]
        assert word_first is not None and word_last is not None
        word_start, word_end = doc.atoms[word_first].start, doc.atoms[word_last].end
        parts.append(xml[previous_end:word_start])
        parts.append(xml[word_start:word_end] if new_word == old_word else escape(new_word))
        previous_end = word_end
    first_word = offset == 0 and old_words[0] != new_words[0]
    return _Mapped(first_atom, last_atom, "".join(parts), first_word)


def findings_from_corrections(source: OcrReviewSource, corrections: Sequence[LineCorrection]) -> list[Finding]:
    """
    The findings of the corrections: `old` is the raw XML of the corrected words, widened by whole
    atoms on both sides until it is unique in the document, `new` the same span with the corrected
    words XML-escaped. The rationale starts with the plain correction (`“old” → “new”: `).
    Corrections spanning markup, overlapping an earlier correction, not unique within the
    document's text or not changing the XML are dropped (and logged).
    """
    doc, xml = source.doc, source.xml
    findings: list[Finding] = []
    taken: list[tuple[int, int]] = []
    for correction in corrections:
        mapped = _map_correction(doc, correction)
        if isinstance(mapped, str):
            logger.info(f"{LOG_PREFIX}: dropped correction of line {correction.line + 1} {correction.old!r}: {mapped}")
            continue
        if any(mapped.first_atom <= last and first <= mapped.last_atom for first, last in taken):
            logger.info(f"{LOG_PREFIX}: dropped correction of line {correction.line + 1} {correction.old!r}: overlaps another correction")
            continue
        first, last = mapped.first_atom, mapped.last_atom
        core_start, core_end = doc.atoms[first].start, doc.atoms[last].end
        while not _occurs_once(xml, xml[doc.atoms[first].start:doc.atoms[last].end]):
            if first == 0 and last == len(doc.atoms) - 1:
                break
            first, last = max(0, first - 1), min(len(doc.atoms) - 1, last + 1)
        start, end = doc.atoms[first].start, doc.atoms[last].end
        old = xml[start:end]
        if not _occurs_once(xml, old):
            logger.info(f"{LOG_PREFIX}: dropped correction of line {correction.line + 1} {correction.old!r}: not unique in the document")
            continue
        new = xml[start:core_start] + mapped.new_core + xml[core_end:end]
        if new == old:
            logger.info(f"{LOG_PREFIX}: dropped correction of line {correction.line + 1} {correction.old!r}: changes nothing")
            continue
        taken.append((mapped.first_atom, mapped.last_atom))
        change = f"“{correction.old}” → “{correction.new}”"
        rationale = (f"{change}: {correction.rationale}" if correction.rationale else change) + (FIRST_WORD_NOTE if mapped.first_word else "")
        findings.append({"id": len(findings), "old": old, "new": new, "rationale": rationale})
    return findings


# ── Review ───────────────────────────────────────────────────────────


async def review_window(
    source: OcrReviewSource, index: int, provider: LLMProvider, model_id: str, min_letter_similarity: float
) -> tuple[list[Finding], int, int]:
    """
    Review one page window: `(findings, window count, discarded)`, where `discarded` counts the
    corrections of the (last) answer that were dropped.

    Raises:
        UnusableResponseError: the model's answer contains no JSON list.
        IndexError: there is no window `index`.
    """
    kept, count, dropped = await review_lines_window(source.lines, index, provider, model_id, min_letter_similarity)
    findings = findings_from_corrections(source, kept)
    return findings, count, dropped + len(kept) - len(findings)
