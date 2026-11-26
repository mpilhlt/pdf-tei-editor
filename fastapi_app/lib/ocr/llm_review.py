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

import difflib
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TypedDict
from xml.sax.saxutils import escape

from lxml import etree

from fastapi_app.lib.llm.base import LLMProvider
from fastapi_app.lib.llm.json_response import extract_json_list
from fastapi_app.lib.llm.review_call import complete_with_retry
from fastapi_app.lib.tei.layout import MISSING_LAYOUT_MESSAGE, get_line_layout, get_zone_labels
from fastapi_app.lib.tei.zone_lines import (
    CHAR,
    DEFAULT_CONTEXT_LINES,
    SPACE,
    Line,
    Page,
    ZoneDocument,
    line_id,
    line_id_width,
    page_windows,
    pages_of,
    read_zone_document,
    window_lines,
)
from fastapi_app.lib.utils.tei_utils import get_document_language

logger = logging.getLogger(__name__)

LOG_PREFIX = "ocr-review"

MIN_LETTER_SIMILARITY_KEY = "ocr.llm-review.min-letter-similarity"
"""Config key of the minimal `difflib` ratio of the letters of `old` and `new`."""

DEFAULT_MIN_LETTER_SIMILARITY = 0.5

MIN_LETTERS = 3
"""Corrections where `old` or `new` has fewer letters are not checked for letter similarity."""

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


@dataclass(frozen=True)
class LineCorrection:
    """A plausible correction of a line (0-based index): `old` occurs exactly once in the line's text."""

    line: int
    old: str
    new: str
    rationale: str


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
            the scope is not part of its `<text>`.
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


# ── Prompts ──────────────────────────────────────────────────────────


def build_system_prompt() -> str:
    """Instructions for finding the OCR errors of a page window."""
    return (
        "You are proofreading the text of a scanned document that was recognized by OCR. You will be given the "
        "document's languages and the lines of one or two of its pages, each as `<id> | <text>`. Lines under a "
        "\"Context\" heading are only shown for orientation: do not correct them.\n\n"
        "Rules:\n"
        "- Correct only OCR misreadings, i.e. text that differs from what is printed on the page. Do not modernize spelling, fix the author's errors, normalize historical orthography, resolve hyphenation or change punctuation that is plausibly in the original.\n"
        "- Check that footnote numbers are consecutive, both the markers in the body text and the numbers at the start of the footnotes, across the pages of the window. Footnote markers in the body are usually superscript and often misread as punctuation or merged with the preceding word; the numbers at the start of the footnotes are usually recognized reliably. Use the sequence on one side to correct gaps and misreadings on the other. Body markers appear in the order of the footnotes on the page.\n"
        "- `old` must be the verbatim text of a whole word or run of words on that line; `new` the corrected form.\n"
        "- When unsure, don't suggest.\n\n"
        "Known OCR confusions: `rn`/`m`, `li`/`h`, `é`/`ö`, digits read as `?!>\"'®™`.\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown fence) of corrections:\n"
        '[{"line": "0412", "old": "…", "new": "…", "rationale": "…"}]\n\n'
        "`line` is the id of the line, `old` must occur exactly once in that line, and `new` must have the same "
        "number of words as `old`. If there are no OCR errors, respond with an empty JSON array: []"
    )


def build_user_prompt(source: OcrReviewSource, window: Sequence[Page], position: tuple[int, int]) -> str:
    """The document's languages and the window's lines, with up to 5 context lines before and after it."""
    doc = source.doc
    width = line_id_width(len(doc.lines))
    lines = window_lines(window)

    def rows(indices: range) -> str:
        return "\n".join(f"{line_id(i, width)} | {_line_text(doc, doc.lines[i])}".rstrip() for i in indices)

    before = range(max(0, lines.start - DEFAULT_CONTEXT_LINES), lines.start)
    after = range(lines.stop, min(len(doc.lines), lines.stop + DEFAULT_CONTEXT_LINES))
    languages = ", ".join(source.languages) if source.languages else "unknown"
    index, total = position
    part = f" (part {index} of {total} of the document)" if total > 1 else ""
    sections = [f"## Languages\n\n{languages}"]
    if before:
        sections.append(f"## Context before (do not correct)\n\n{rows(before)}")
    sections.append(f"## Lines to proofread{part}\n\n{rows(lines)}")
    if after:
        sections.append(f"## Context after (do not correct)\n\n{rows(after)}")
    return "\n\n".join(sections)


def build_retry_note(dropped: list[str]) -> str:
    """Appended to the user prompt when every correction of a first attempt was dropped."""
    listed = "\n".join(f"- {d}" for d in dropped[:20])
    return (
        "\n\n## Note on a previous attempt\n\n"
        f"A previous review of these lines proposed corrections that were all dropped:\n\n{listed}\n\n"
        "Review the lines again. Use only line ids of the lines to proofread (not of the context), copy `old` "
        "exactly as it appears in the line (same spaces and quote characters), keep the number of words, and "
        "correct only OCR misreadings."
    )


# ── Answers ──────────────────────────────────────────────────────────


def _letters(text: str) -> str:
    return "".join(char for char in text.casefold() if char.isalpha())


def letters_similar(old: str, new: str, min_letter_similarity: float) -> bool:
    """
    Whether a correction is plausible as an OCR fix: the case-folded letters of `old` and `new`
    have a `difflib` ratio of at least `min_letter_similarity`, or one side has fewer than 3 letters.
    """
    a, b = _letters(old), _letters(new)
    if len(a) < MIN_LETTERS or len(b) < MIN_LETTERS:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= min_letter_similarity


def _line_index(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value - 1
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip()) - 1
    return None


def parse_corrections(
    raw: str, source: OcrReviewSource, window: Sequence[Page], min_letter_similarity: float
) -> tuple[list[LineCorrection], list[str]]:
    """
    The plausible corrections of an answer and a description of each dropped one: unreadable
    entries, lines outside the window, `old` not occurring exactly once in the line, a different
    number of words, and letters that differ too much. Corrections that change nothing are
    ignored without a description.

    Raises:
        UnusableResponseError: the response contains no JSON list.
    """
    items = extract_json_list(raw, LOG_PREFIX)
    doc = source.doc
    width = line_id_width(len(doc.lines))
    lines = window_lines(window)
    kept: list[LineCorrection] = []
    dropped: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        old, new, rationale = item.get("old"), item.get("new"), item.get("rationale")
        index = _line_index(item.get("line"))
        if index is None or not isinstance(old, str) or not isinstance(new, str):
            dropped.append(f"unreadable: {item!r}"[:200])
            continue
        old, new = old.strip(), new.strip()
        if old == new:
            continue
        label = f'line {line_id(index, width) if index >= 0 else item.get("line")}: "{old}" -> "{new}"'
        reason: str | None = None
        if index not in lines:
            reason = "line outside the lines to proofread"
        elif not old:
            reason = "empty old text"
        else:
            count = _line_text(doc, doc.lines[index]).count(old)
            if count == 0:
                reason = "old text does not occur in the line"
            elif count > 1:
                reason = "old text occurs more than once in the line"
            elif len(old.split()) != len(new.split()):
                reason = "different number of words"
            elif not letters_similar(old, new, min_letter_similarity):
                reason = "letters differ too much for an OCR misreading"
        if reason is not None:
            dropped.append(f"{label}: {reason}"[:300])
            continue
        kept.append(LineCorrection(index, old, new, rationale if isinstance(rationale, str) else ""))
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
    words XML-escaped. Corrections spanning markup, overlapping an earlier correction or not unique
    within the document's text are dropped (and logged).
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
        taken.append((mapped.first_atom, mapped.last_atom))
        new = xml[start:core_start] + mapped.new_core + xml[core_end:end]
        rationale = correction.rationale + (FIRST_WORD_NOTE if mapped.first_word else "")
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
    window = source.windows[index]

    def parse(raw: str) -> tuple[list[LineCorrection], list[str]]:
        return parse_corrections(raw, source, window, min_letter_similarity)

    kept, dropped = await complete_with_retry(
        provider,
        model_id,
        build_system_prompt(),
        build_user_prompt(source, window, (index + 1, len(source.windows))),
        parse,
        build_retry_note,
        LOG_PREFIX,
    )
    findings = findings_from_corrections(source, kept)
    return findings, len(source.windows), len(dropped) + len(kept) - len(findings)
