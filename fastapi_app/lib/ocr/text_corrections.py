"""
Word-level corrections of the OCR text layer derived from a TEI document.

The words of each TEI page are compared with the words of the PDF's text layer. Where a word of
the layer was replaced by a word of the TEI (same number of words), the difference is a correction
that can be written back into the layer. Differences that are only tokenization or reading order
are ignored; all others cannot be written and are reported as unwritable.

Dashes and quotation marks are compared in a folded form (`_fold()`): the TEI of extraction
services such as GROBID has ASCII hyphens and quotes where the layer has typographic ones, which is
no error of the text recognition. A correction keeps the layer's characters wherever they only
differ in this way. A difference with another number of words is still written if, apart from the
whitespace, it only replaces characters within words of the layer (`_respell()`), such as
"2021?) — es" corrected to "20212) -es".
"""

from __future__ import annotations

import difflib
import unicodedata
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from fastapi_app.lib.ocr.text_layer import LayerPage, LayerWord, PageCallback
from fastapi_app.lib.tei.layout import LineLayout, get_zone_labels
from fastapi_app.lib.tei.zone_lines import read_zone_document

DIFFERENT_WORD_COUNT = "different number of words"
WORDS_DIFFER_TOO_MUCH = "words differ too much"
NO_LAYER_PAGE = "no text layer page"

_FOLD = str.maketrans({c: "-" for c in "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"} | {c: '"' for c in "\u201c\u201d\u201e\u201f\u2033"} | {c: "'" for c in "\u2018\u2019\u201a\u201b\u2032"})
"""Dashes and the minus sign to '-', typographic double quotes to '"', single quotes to "'" (one character each)."""

MIN_RESPELL_SIMILARITY = 0.75
"""A difference with another number of words is respelled only if its texts without whitespace are at least this similar."""

MIN_BLOCK_SIMILARITY = 0.5
"""Replaced blocks of two or more words in which every pair of words is less similar than this are not corrected (unrelated text)."""


@dataclass(frozen=True)
class TeiWord:
    """A word of the TEI: its page (0-based), the index of its line in `ZoneDocument.lines`, and its text."""

    page: int
    line: int
    text: str


@dataclass(frozen=True)
class WordCorrection:
    """A word of the text layer (`old`, located by `word`) to be replaced by the TEI's `new`."""

    page: int
    line: int
    old: str
    new: str
    word: LayerWord


@dataclass(frozen=True)
class UnwritableChange:
    """A difference between layer and TEI that cannot be written into the layer, with the reason."""

    page: int
    line: int | None
    layer_text: str
    tei_text: str
    reason: str


@dataclass
class CorrectionPlan:
    """The corrections to write and the differences that cannot be written."""

    corrections: list[WordCorrection] = field(default_factory=list)
    unwritable: list[UnwritableChange] = field(default_factory=list)


def tei_words(xml: str, variant_id: str, layout: LineLayout, page_indices: Collection[int] | None = None) -> dict[int, list[TeiWord]]:
    """
    The words of the TEI by page (0-based page index), or only those of the given pages; raises
    ValueError if the variant has no zone labels. Lines beyond `layout.pages` have no page and are
    skipped.
    """
    labels = get_zone_labels(variant_id)
    if labels is None:
        raise ValueError(f"Variant '{variant_id}' has no zone labels")
    doc = read_zone_document(xml, labels)
    result: dict[int, list[TeiWord]] = {}
    for line in doc.lines:
        if line.index >= len(layout.pages):
            continue
        page = layout.pages[line.index]
        if page_indices is not None and page not in page_indices:
            continue
        result.setdefault(page, []).extend(TeiWord(page, line.index, word) for word in line.text.split())
    return result


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def _fold(text: str) -> str:
    """NFC text with dashes and quotation marks folded (see `_FOLD`); keeps the length of the NFC text."""
    return _nfc(text).translate(_FOLD)


def _similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _fold(a), _fold(b)).ratio()


def _joined(words: Sequence[LayerWord] | Sequence[TeiWord]) -> str:
    return _fold("".join(w.text for w in words))


def _merge(old: str, new: str) -> str:
    """The TEI's `new`, with the characters of the layer's `old` where they only differ by folding."""
    old, new = _nfc(old), _nfc(new)
    parts: list[str] = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, _fold(old), _fold(new), autojunk=False).get_opcodes():
        parts.append(old[i1:i2] if op == "equal" else new[j1:j2])
    return "".join(parts)


def _respell(old: Sequence[LayerWord], new: Sequence[TeiWord]) -> list[tuple[LayerWord, str]] | None:
    """
    New texts for the layer words `old` if the TEI words `new` differ from them, apart from the
    whitespace and folding, only by characters replaced within single layer words; None otherwise.
    Inserted or deleted characters (such as a removed hyphen) are not respelled.
    """
    if not old or not new:
        return None
    layer = _nfc("".join(w.text for w in old))
    tei = _nfc("".join(w.text for w in new))
    matcher = difflib.SequenceMatcher(None, _fold(layer), _fold(tei), autojunk=False)
    if matcher.ratio() < MIN_RESPELL_SIMILARITY:
        return None
    ends: list[int] = []
    for w in old:
        ends.append((ends[-1] if ends else 0) + len(_nfc(w.text)))
    texts = [_nfc(w.text) for w in old]
    replaced = False
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            continue
        if op != "replace":
            return None
        word = next(k for k, end in enumerate(ends) if i1 < end)
        start = ends[word] - len(texts[word])
        if i2 > ends[word]:
            return None  # the replaced characters span a word boundary of the layer
        texts[word] = texts[word][: i1 - start] + tei[j1:j2] + texts[word][i2 - start :]
        ends = [end + (j2 - j1) - (i2 - i1) if k >= word else end for k, end in enumerate(ends)]
        replaced = True
    if not replaced:
        return None
    return [(w, t) for w, t in zip(old, texts) if t != _nfc(w.text)]


def derive_corrections(tei: Mapping[int, Sequence[TeiWord]], layer: Sequence[LayerPage], on_page: PageCallback | None = None) -> CorrectionPlan:
    """Compare the words of each page of the layer with those of the TEI and derive corrections; `on_page` is called after each page of the layer."""
    plan = CorrectionPlan()
    layer_indices = {page.index for page in layer}
    for index in sorted(set(tei) - layer_indices):
        if tei[index]:
            plan.unwritable.append(UnwritableChange(index, tei[index][0].line, "", " ".join(w.text for w in tei[index]), NO_LAYER_PAGE))
    for done, page in enumerate(layer, start=1):
        if on_page is not None:
            on_page(done, len(layer))
        if page.index not in tei:
            continue
        tws = list(tei[page.index])
        lws = list(page.words)
        matcher = difflib.SequenceMatcher(None, [_fold(w.text) for w in lws], [_fold(w.text) for w in tws], autojunk=False)
        corrections: list[WordCorrection] = []
        # differences that are not word-for-word replacements: (layer words, tei words)
        leftovers: list[tuple[list[LayerWord], list[TeiWord]]] = []
        unrelated: list[tuple[list[LayerWord], list[TeiWord]]] = []
        for op, i1, i2, j1, j2 in matcher.get_opcodes():
            if op == "equal":
                continue
            old, new = lws[i1:i2], tws[j1:j2]
            if op == "replace" and len(old) == len(new):
                if _joined(old) == _joined(new):
                    continue  # shifted token boundaries only
                if len(old) >= 2 and all(_similarity(o.text, n.text) < MIN_BLOCK_SIMILARITY for o, n in zip(old, new)):
                    unrelated.append((old, new))
                    continue
                corrections.extend(WordCorrection(page.index, n.line, o.text, _merge(o.text, n.text), o) for o, n in zip(old, new) if _fold(o.text) != _fold(n.text))
            else:
                leftovers.append((old, new))

        # tokenization differences: both sides read the same without whitespace
        leftovers = [(o, n) for o, n in leftovers if _joined(o) != _joined(n)]
        # moved blocks: a pure deletion and a pure insertion of the same text
        cancelled: set[int] = set()
        for d, (d_old, d_new) in enumerate(leftovers):
            if d_new or d in cancelled:
                continue
            for i, (i_old, i_new) in enumerate(leftovers):
                if not i_old and i not in cancelled and _joined(i_new) == _joined(d_old):
                    cancelled.update((d, i))
                    break
        # characters replaced within words of the layer, with other whitespace in the TEI
        remaining: list[tuple[list[LayerWord], list[TeiWord]]] = []
        for idx, (o, n) in enumerate(leftovers):
            if idx in cancelled:
                continue
            respelled = _respell(o, n)
            if respelled is None:
                remaining.append((o, n))
            else:
                corrections.extend(WordCorrection(page.index, n[0].line, w.text, text, w) for w, text in respelled)
        unwritable = [
            UnwritableChange(
                page.index,
                n[0].line if n else None,
                " ".join(w.text for w in o),
                " ".join(w.text for w in n),
                page.unpatchable or DIFFERENT_WORD_COUNT,
            )
            for o, n in remaining
        ]
        unwritable += [
            UnwritableChange(page.index, n[0].line, " ".join(w.text for w in o), " ".join(w.text for w in n), page.unpatchable or WORDS_DIFFER_TOO_MUCH)
            for o, n in unrelated
        ]
        if page.unpatchable:
            unwritable = [UnwritableChange(page.index, c.line, c.old, c.new, page.unpatchable) for c in corrections] + unwritable
            corrections = []
        plan.corrections.extend(corrections)
        plan.unwritable.extend(unwritable)
    return plan


CorrectedPdfHandler = Callable[[str, str, Path, str, frozenset[int]], str]
"""
`handler(xml, doc_id, pdf_path, pdf_hash, corrected_lines)`: regenerates the feature file of a corrected PDF and returns the XML with updated labels. Called in a worker thread.
"""


class CorrectedPdfMismatch(Exception):
    """A corrected PDF does not match the document; `lines` are the zone lines that could not be matched."""

    def __init__(self, message: str, lines: list[int]) -> None:
        super().__init__(message)
        self.lines = lines


_corrected_pdf_handlers: dict[str, tuple[str, CorrectedPdfHandler]] = {}


def register_corrected_pdf_handler(variant_id: str, plugin_id: str, handler: CorrectedPdfHandler) -> None:
    """Register (or replace) the corrected-PDF handler of a variant."""
    _corrected_pdf_handlers[variant_id] = (plugin_id, handler)


def unregister_corrected_pdf_handler(variant_id: str) -> None:
    """Remove the corrected-PDF handler of a variant, if any."""
    _corrected_pdf_handlers.pop(variant_id, None)


def get_corrected_pdf_handler(variant_id: str | None) -> CorrectedPdfHandler | None:
    """The corrected-PDF handler registered for the variant, or None."""
    if not variant_id or variant_id not in _corrected_pdf_handlers:
        return None
    return _corrected_pdf_handlers[variant_id][1]
