"""
Ground truth lines for training Tesseract, from reviewed segmentation documents (#959).

A line of the PDF's OCR text layer (one text object, see `layer_lines()`) becomes a training line
if it lies on a page that the unit review marked OK and its words align cleanly with the words of
the TEI. Its ground truth is the TEI text, with the layer's characters where they only differ in
the folded form of dashes and quotes (as in `text_corrections.py`). The image is cut from the
rendered page; correcting the text layer does not change the page image.

A page counts as OK if it has a final mark and all final marks are OK, or else if at least one
human reviewer marked it OK and nobody marked it not OK. Marks of LLM reviewers do not count.
"""

from __future__ import annotations

import difflib
import io
import json
import unicodedata
import zipfile
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
from lxml import etree

from fastapi_app.lib.messages.standoff_reader import (
    REVIEW_LIST_TYPE,
    Reviewer,
    find_standoff_list,
    read_review_data,
)
from fastapi_app.lib.ocr.layout_check import extract_layer_words
from fastapi_app.lib.ocr.text_corrections import (
    MIN_BLOCK_SIMILARITY,
    TeiWord,
    _fold,
    _joined,
    _merge,
    _respell,
    _similarity,
    tei_words,
)
from fastapi_app.lib.ocr.text_layer import (
    LayerPage,
    layer_lines,
    read_text_layer,
)
from fastapi_app.lib.tei.layout import PAGES_UNIT_PATH, LineLayout, get_zone_labels
from fastapi_app.lib.tei.zone_lines import pages_of, read_zone_document

RENDER_DPI = 300
"""Resolution of the line images; OCRmyPDF rasterizes at 300 dpi unless a scan has another resolution."""

MIN_LINE_CHARS = 3
"""Lines with fewer non-space characters are not used."""

VERTICAL_PADDING = 0.25
"""Padding above and below a line image, as a fraction of the line height (the text layer's boxes are tight)."""

HORIZONTAL_PADDING = 0.5
"""Padding left and right of a line image, as a fraction of the line height."""

Box = tuple[float, float, float, float]
"""left, top, right, bottom as fractions of the page's crop box, origin at the top left."""


@dataclass(frozen=True)
class TrainingLine:
    """A line of the text layer with its ground truth."""

    page: int  # 0-based page of the PDF
    line: int  # index of the text object on the page
    text: str  # ground truth
    layer_text: str  # text of the layer line
    box: Box

    @property
    def corrected(self) -> bool:
        """True if the ground truth differs from the text layer."""
        return unicodedata.normalize("NFC", self.text) != unicodedata.normalize("NFC", self.layer_text)


# ── Review ───────────────────────────────────────────────────────────


def _unit_ok(reviewers: Sequence[Reviewer], fingerprint: str) -> bool:
    """The combined result of the human marks of a unit, strictly: OK only without any not-OK mark."""
    marks = [r.marks[fingerprint] for r in reviewers if not r.is_llm and fingerprint in r.marks]
    final = [m for m in marks if m.final]
    if final:
        return all(m.state == "ok" for m in final)
    return bool(marks) and all(m.state == "ok" for m in marks)


def ok_pages(xml: str, variant_id: str, layout: LineLayout) -> set[int]:
    """
    The pages (0-based layout page indices) of a zone document that the unit review marked OK, for
    their current content (fingerprint). Raises ValueError if the variant has no zone labels.
    """
    labels = get_zone_labels(variant_id)
    if labels is None:
        raise ValueError(f"Variant '{variant_id}' has no zone labels")
    root = etree.fromstring(xml.encode("utf-8"), parser=etree.XMLParser(huge_tree=True))
    review = read_review_data(find_standoff_list(root, REVIEW_LIST_TYPE))
    if review.unit_path != PAGES_UNIT_PATH or not review.reviewers:
        return set()
    reviewers = list(review.reviewers.values())
    status: dict[int, bool] = {}
    for page in pages_of(read_zone_document(xml, labels), layout.pages):
        index = page.number - 1
        status[index] = status.get(index, True) and _unit_ok(reviewers, page.fingerprint)
    return {index for index, ok in status.items() if ok}


# ── Alignment ────────────────────────────────────────────────────────


def ground_truth_words(tws: Sequence[TeiWord], page: LayerPage) -> dict[int, str | None]:
    """
    The ground truth of each word of a layer page (by position in `page.words`), or None for words
    whose alignment with the TEI is not clean: blocks that differ in more than whitespace or the
    characters within words, unrelated blocks, and words next to text missing from the layer.
    """
    lws = page.words
    result: dict[int, str | None] = {}
    suspect: set[int] = set()
    matcher = difflib.SequenceMatcher(None, [_fold(w.text) for w in lws], [_fold(w.text) for w in tws], autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        old, new = lws[i1:i2], list(tws[j1:j2])
        if op == "equal" or _joined(old) == _joined(new):
            result.update((i, lws[i].text) for i in range(i1, i2))
        elif op == "replace" and len(old) == len(new):
            if len(old) >= 2 and all(_similarity(o.text, n.text) < MIN_BLOCK_SIMILARITY for o, n in zip(old, new)):
                result.update((i, None) for i in range(i1, i2))
            else:
                result.update((i1 + k, _merge(o.text, n.text)) for k, (o, n) in enumerate(zip(old, new)))
        elif old and (respelled := _respell(old, new)) is not None:
            texts = {id(w): t for w, t in respelled}
            result.update((i1 + k, texts.get(id(w), w.text)) for k, w in enumerate(old))
        elif old:
            result.update((i, None) for i in range(i1, i2))
        else:
            # TEI words the layer does not have: the lines on both sides are suspect
            suspect.update(i for i in (i1 - 1, i1) if 0 <= i < len(lws))
    result.update((i, None) for i in suspect)
    return result


def ground_truth_lines(tws: Sequence[TeiWord], page: LayerPage) -> list[tuple[int, str, str]]:
    """(line, ground truth, layer text) of the lines of a layer page whose words all align cleanly."""
    words = ground_truth_words(tws, page)
    position = {id(w): i for i, w in enumerate(page.words)}
    lines: list[tuple[int, str, str]] = []
    for line in layer_lines(page):
        texts = [words.get(position[id(w)]) for w in line.words]
        if any(t is None for t in texts):
            continue
        text = " ".join(t for t in texts if t is not None)
        if len(text.replace(" ", "")) < MIN_LINE_CHARS:
            continue
        lines.append((line.words[0].line, text, line.text))
    return lines


# ── Boxes and images ─────────────────────────────────────────────────


def line_boxes(page: LayerPage, pdf_page: pdfium.PdfPage) -> dict[int, Box]:
    """
    The boxes of the lines of a layer page, from the character boxes pdfium reads for the same text.
    The words of the layer are matched with pdfium's words in order; a line gets a box only if all
    its words were matched.
    """
    boxes = extract_layer_words(pdf_page)
    nfc = [unicodedata.normalize("NFC", w.text) for w in page.words]
    matcher = difflib.SequenceMatcher(None, nfc, [unicodedata.normalize("NFC", b.text) for b in boxes], autojunk=False)
    matched: dict[int, Box] = {}
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            b = boxes[block.b + k]
            matched[block.a + k] = (b.left, b.top, b.right, b.bottom)
    position = {id(w): i for i, w in enumerate(page.words)}
    result: dict[int, Box] = {}
    for line in layer_lines(page):
        word_boxes = [matched.get(position[id(w)]) for w in line.words]
        if not word_boxes or any(b is None for b in word_boxes):
            continue
        present = [b for b in word_boxes if b is not None]
        result[line.words[0].line] = (min(b[0] for b in present), min(b[1] for b in present), max(b[2] for b in present), max(b[3] for b in present))
    return result


def _overlaps(box: Box, others: Sequence[Box]) -> bool:
    """True if the box overlaps another one vertically by more than a third of its height and horizontally at all."""
    height = box[3] - box[1]
    for other in others:
        if other is box:
            continue
        vertical = min(box[3], other[3]) - max(box[1], other[1])
        horizontal = min(box[2], other[2]) - max(box[0], other[0])
        if vertical > height / 3 and horizontal > 0:
            return True
    return False


def collect_training_lines(xml: str, variant_id: str, layout: LineLayout, pdf_path: Path) -> list[TrainingLine]:
    """
    The training lines of a zone document and its PDF: lines of pages marked OK whose words align
    cleanly with the TEI and that have a box which overlaps no other line.
    """
    pages = ok_pages(xml, variant_id, layout)
    if not pages:
        return []
    words = tei_words(xml, variant_id, layout, pages)
    result: list[TrainingLine] = []
    with pikepdf.open(pdf_path) as pdf:
        layer = read_text_layer(pdf, page_indices=pages)
    document = pdfium.PdfDocument(pdf_path)
    try:
        for page in layer:
            if not page.words or page.index not in words:
                continue
            pdf_page = document[page.index]
            try:
                boxes = line_boxes(page, pdf_page)
            finally:
                pdf_page.close()
            all_boxes = list(boxes.values())
            for line, text, layer_text in ground_truth_lines(words[page.index], page):
                box = boxes.get(line)
                if box is None or box[2] <= box[0] or box[3] <= box[1] or _overlaps(box, all_boxes):
                    continue
                result.append(TrainingLine(page.index, line, text, layer_text, box))
    finally:
        document.close()
    return result


def render_line_images(pdf_path: Path, lines: Sequence[TrainingLine], dpi: int = RENDER_DPI) -> Iterator[tuple[TrainingLine, bytes]]:
    """The PNG image (grayscale) of each line, cut from the rendered page with some padding."""
    by_page: dict[int, list[TrainingLine]] = {}
    for line in lines:
        by_page.setdefault(line.page, []).append(line)
    document = pdfium.PdfDocument(pdf_path)
    try:
        for index in sorted(by_page):
            page = document[index]
            try:
                image = page.render(scale=dpi / 72, grayscale=True).to_pil()  # pyright: ignore[reportArgumentType]  # pypdfium2 accepts float scales
            finally:
                page.close()
            width, height = image.size
            for line in by_page[index]:
                left, top, right, bottom = line.box
                line_height = (bottom - top) * height
                pad_x, pad_y = HORIZONTAL_PADDING * line_height, VERTICAL_PADDING * line_height
                crop = (
                    max(0, round(left * width - pad_x)),
                    max(0, round(top * height - pad_y)),
                    min(width, round(right * width + pad_x)),
                    min(height, round(bottom * height + pad_y)),
                )
                buffer = io.BytesIO()
                image.crop(crop).save(buffer, format="PNG")
                yield line, buffer.getvalue()
    finally:
        document.close()


# ── Export ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LineSource:
    """Where the lines of one document come from, recorded in the manifest of the export."""

    doc_id: str
    stable_id: str
    pdf_hash: str
    collections: list[str]
    languages: list[str]


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in name)


def write_lines(archive: zipfile.ZipFile, source: LineSource, pdf_path: Path, lines: Sequence[TrainingLine], seen: set[tuple[str, int, int]]) -> int:
    """
    Add the images, ground truth files and manifest entries of a document's lines to the archive:
    `lines/<doc>/p<page>-l<line>.png`, `.gt.txt` (tesstrain's layout) and `.json` (the source, the
    layer text and whether the line was corrected). Lines already in `seen` (same PDF, page and line,
    from another version) are skipped. Returns the number of lines added.
    """
    fresh = [line for line in lines if (source.pdf_hash, line.page, line.line) not in seen]
    folder = f"lines/{_safe(source.doc_id)}"
    count = 0
    for line, png in render_line_images(pdf_path, fresh):
        seen.add((source.pdf_hash, line.page, line.line))
        name = f"{folder}/p{line.page + 1:04d}-l{line.line:03d}"
        archive.writestr(f"{name}.png", png)
        archive.writestr(f"{name}.gt.txt", line.text + "\n")
        entry: Mapping[str, object] = {**asdict(source), "image": f"{name}.png", "page": line.page, "line": line.line, "text": line.text, "layer_text": line.layer_text, "corrected": line.corrected}
        archive.writestr(f"{name}.json", json.dumps(entry, ensure_ascii=False))
        count += 1
    return count
