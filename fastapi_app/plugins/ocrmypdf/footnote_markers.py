"""
Repair of footnote markers that Tesseract misrecognizes (#904).

Tesseract reads small superscript footnote markers as punctuation, independent of the
resolution and of the model: `tut³¹²⁾` becomes `tut?!?)`. Recognizing the part of the word
after its letters again, upscaled and with a digits-only whitelist, mostly yields the
digits, sometimes with an extra leading digit from the last letter.

Which number a marker has is decided from the numbering of the footnotes. The numbers at
the start of the footnotes are set at normal size but are not reliable either (`13)` for
113, `1835)` for 183), so they are fitted to one increasing sequence over the whole
document (`fit_footnote_numbers`). That yields the range of footnote numbers that start on
each page, and the markers of a page are assigned numbers from that range in reading
order, using the digits of their second reading (`plan_repairs`).

The repair is split into a step per page that needs the page image (`analyze_page`) and a
step for the whole document that rewrites the hOCR (`plan_repairs`, `apply_repairs`). See
`ocrmypdf_plugin.py` for how they are run inside OCRmyPDF.
"""

import json
import logging
import re
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path

from lxml import etree
from PIL import Image

logger = logging.getLogger(__name__)

XHTML_NS = "http://www.w3.org/1999/xhtml"
LINE_CLASSES = {"ocr_line", "ocr_caption", "ocr_header", "ocr_textfloat"}
MAX_MARKER_LENGTH = 6
"""Longest run of characters accepted as a misrecognized marker."""
GAP_PENALTY = 0.3
"""Score lost per footnote number that the fitted sequence skips."""
JUMP_PENALTY = 4.0
"""Most score lost when the fitted sequence skips numbers (pages missing from the PDF)."""
RESTART_PENALTY = 8.0
"""Score lost when the fitted sequence restarts at a lower number (a new article or chapter)."""
RESTART_MAX_NUMBER = 5
"""Highest number a restarted sequence may begin with. A new numbering begins at 1 (or a little
later if its first numbers were not read); misread numbers that lost a leading digit (`13)`
for 113) must not start a new sequence."""
EXACT_SCORE = 3.0
"""Score of a footnote number read exactly."""
EDIT_SCORE = 1.0
"""Score of a footnote number read with one wrong, missing or extra digit."""

_FOOTNOTE_START_RE = re.compile(r"^(\d{1,5})(\)?)$")
_TRAILING_PUNCTUATION = ".,;:"

Box = tuple[int, int, int, int]
"""Pixel bounding box: left, top, right, bottom."""

DigitRecognizer = Callable[[Image.Image, Box], list[str]]
"""Recognizes the digits in a region of a page image, possibly in several readings."""


@dataclass
class FootnoteStart:
    """A line that starts with a number, possibly the start of a footnote."""

    digits: str
    parenthesized: bool
    """Whether the number is followed by `)`."""


@dataclass
class MarkerCandidate:
    """A word that ends in a footnote marker, recognized correctly or not."""

    word_id: str
    """The `id` of the `ocrx_word` element."""
    text: str
    prefix: str
    """The word up to and including its last letter."""
    marker: str
    """The characters between the prefix and the closing parenthesis."""
    suffix: str
    """The closing parenthesis and any punctuation after it."""
    readings: list[str] = field(default_factory=list)
    """Digits read by the second pass, empty for markers recognized as digits."""

    @property
    def is_number(self) -> bool:
        """Whether the marker was recognized as digits."""
        return self.marker.isdigit()


@dataclass
class PageAnalysis:
    """What the document-wide repair needs to know about a page."""

    footnote_starts: list[FootnoteStart] = field(default_factory=list)
    candidates: list[MarkerCandidate] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, data: str) -> "PageAnalysis":
        raw = json.loads(data)
        return cls(
            footnote_starts=[FootnoteStart(**start) for start in raw["footnote_starts"]],
            candidates=[MarkerCandidate(**candidate) for candidate in raw["candidates"]],
        )


@dataclass(frozen=True)
class MarkerRepair:
    """A marker that was replaced."""

    word_id: str
    old: str
    new: str


def parse_bbox(title: str) -> Box | None:
    """Return the bounding box from an hOCR `title` attribute."""
    match = re.search(r"bbox (\d+) (\d+) (\d+) (\d+)", title)
    if not match:
        return None
    left, top, right, bottom = (int(value) for value in match.groups())
    return left, top, right, bottom


def split_marker(text: str) -> tuple[str, str, str] | None:
    """
    Split a word into the part up to its last letter, the marker and the closing parenthesis.

    Args:
        text: The recognized word, e.g. `tut?!?)` or `stellen313).`

    Returns:
        (prefix, marker, suffix), e.g. ("tut", "?!?", ")"), or None if the word does not end
        in a parenthesized marker after a letter
    """
    core = text.rstrip(_TRAILING_PUNCTUATION)
    if not core.endswith(")"):
        return None
    suffix = text[len(core) - 1 :]
    core = core[:-1]
    end = len(core)
    while end > 0 and not core[end - 1].isalpha():
        end -= 1
    prefix, marker = core[:end], core[end:]
    if not prefix or not marker or len(marker) > MAX_MARKER_LENGTH:
        return None
    if any(char.isspace() or char == "(" for char in marker):
        return None
    return prefix, marker, suffix


def marker_box(word_box: Box, text: str, prefix: str) -> Box:
    """
    Estimate the region of the marker within the word box.

    hOCR has no character boxes, so the start of the marker is estimated from the character
    count. The region starts a bit earlier and extends above the word, since superscripts
    are raised; a letter caught at the left edge is recognized as an extra leading digit,
    which the assignment tolerates.
    """
    left, top, right, bottom = word_box
    height = bottom - top
    start = left + (right - left) * len(prefix) // len(text)
    return max(0, start - height // 10), max(0, top - int(height * 0.3)), right, top + int(height * 0.75)


INK_THRESHOLD = 128
"""Gray values below this count as ink."""
RAISED_LIMIT = 0.6
"""Glyphs whose lowest ink lies above this fraction of the distance from the top of the word to
its baseline are raised (superscript digits, quotation marks)."""


def raised_region(image: Image.Image, word_box: Box, region: Box) -> Box | None:
    """
    Find the raised glyphs (the superscript marker) within a region of a word.

    Recognizing only the raised glyphs is more reliable than recognizing the region with the
    last letter and the closing parenthesis, which extend down to the baseline. A column
    counts as raised if its lowest ink lies well above the baseline of the word, which is
    the most common lowest ink row of its columns.

    Args:
        image: The page image
        word_box: The box of the word
        region: The estimated marker region within the word (see `marker_box`)

    Returns:
        The box around the widest group of adjacent raised columns in the region, or None
    """
    left, top, right, bottom = word_box
    top = max(0, top - (bottom - top) // 3)
    crop = image.crop((left, top, right, bottom)).convert("L")
    width, height = crop.size
    pixels = crop.load()
    if pixels is None or width == 0 or height == 0:
        return None
    first_ink: list[int | None] = []
    last_ink: list[int | None] = []
    for x in range(width):
        rows = [y for y in range(height) if int(pixels[x, y]) < INK_THRESHOLD]  # type: ignore[arg-type]
        first_ink.append(rows[0] if rows else None)
        last_ink.append(rows[-1] if rows else None)
    lowest = sorted(row for row in last_ink if row is not None)
    highest = [row for row in first_ink if row is not None]
    if not lowest:
        return None
    baseline = lowest[len(lowest) // 2]
    limit = min(highest) + (baseline - min(highest)) * RAISED_LIMIT
    groups: list[tuple[int, int]] = []
    start: int | None = None
    end = 0
    for x in range(max(0, region[0] - left), min(width, region[2] - left)):
        row = last_ink[x]
        if row is None:
            continue
        if row < limit:
            start = x if start is None else start
            end = x
        else:
            if start is not None:
                groups.append((start, end))
            start = None
    if start is not None:
        groups.append((start, end))
    if not groups:
        return None
    group_start, group_end = max(groups, key=lambda group: group[1] - group[0])
    group_top = min(row for row in first_ink[group_start : group_end + 1] if row is not None)
    padding = max(2, height // 20)
    return (left + max(0, group_start - padding), top + max(0, group_top - padding), left + min(width, group_end + 1 + padding), top + min(height, int(limit) + padding))


def make_tesseract_digit_recognizer(languages: Sequence[str] = ("eng",), timeout: float = 10.0) -> DigitRecognizer:
    """
    Return a recognizer that runs Tesseract on the upscaled region with a digits-only whitelist.

    Args:
        languages: Installed Tesseract models, each recognizes the region once. Despite the
            whitelist, the models read the same digits differently (on the example of #904,
            `deu` read `1` where `eng` read `167`), so using several increases the hits.
        timeout: Seconds per region and model

    Returns:
        A recognizer that returns the digits read by each model
    """

    def recognize(image: Image.Image, box: Box) -> list[str]:
        crop = image.crop(box)
        crop = crop.resize((crop.width * 3, crop.height * 3), Image.Resampling.LANCZOS)
        readings = []
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "marker.png"
            crop.save(path)
            for language in languages:
                command = ["tesseract", str(path), "stdout", "-l", language, "--psm", "7", "-c", "tessedit_char_whitelist=0123456789)"]
                try:
                    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=True)
                except (subprocess.SubprocessError, OSError) as e:
                    logger.warning(f"Footnote marker recognition failed: {e}")
                    continue
                readings.append("".join(char for char in result.stdout if char.isdigit()))
        return readings

    return recognize


def _classes(element: etree._Element) -> set[str]:
    return set((element.get("class") or "").split())


def _page_lines(root: etree._Element) -> list[list[etree._Element]]:
    """Return the words of every line, in reading order."""
    lines = []
    for element in root.iter(f"{{{XHTML_NS}}}span", "span"):
        if _classes(element) & LINE_CLASSES:
            words = [word for word in element.iter(f"{{{XHTML_NS}}}span", "span") if "ocrx_word" in _classes(word)]
            if words:
                lines.append(words)
    return lines


def _word_text(word: etree._Element) -> str:
    return "".join(str(text) for text in word.itertext())


def analyze_page(root: etree._Element, image: Image.Image, recognize: DigitRecognizer) -> PageAnalysis:
    """
    Collect the footnote starts and marker candidates of an hOCR page.

    Misrecognized markers are recognized again here, since this is the step that has the
    page image.

    Args:
        root: The root of the hOCR document
        image: The page image the hOCR was recognized from
        recognize: Recognizes the digits in a region of the image
    """
    analysis = PageAnalysis()
    for words in _page_lines(root):
        if match := _FOOTNOTE_START_RE.match(_word_text(words[0])):
            analysis.footnote_starts.append(FootnoteStart(match.group(1), bool(match.group(2))))
        for word in words:
            text = _word_text(word)
            parts = split_marker(text)
            box = parse_bbox(word.get("title") or "")
            word_id = word.get("id")
            if not parts or not box or not word_id:
                continue
            candidate = MarkerCandidate(word_id, text, *parts)
            if not candidate.is_number:
                region = marker_box(box, text, candidate.prefix)
                raised = raised_region(image, box, region)
                candidate.readings = (recognize(image, raised) if raised else []) + recognize(image, region)
            analysis.candidates.append(candidate)
    return analysis


def _read_variants(digits: str) -> list[tuple[int, float]]:
    """Return the numbers a footnote number read as `digits` can be, with their scores."""
    variants: dict[str, float] = {digits: EXACT_SCORE}
    numerals = "0123456789"
    edits = set()
    for i in range(len(digits) + 1):
        edits.update(digits[:i] + numeral + digits[i:] for numeral in numerals)
    for i in range(len(digits)):
        edits.add(digits[:i] + digits[i + 1 :])
        edits.update(digits[:i] + numeral + digits[i + 1 :] for numeral in numerals)
    for edit in edits:
        variants.setdefault(edit, EDIT_SCORE)
    return [(int(value), score) for value, score in variants.items() if value and not value.startswith("0")]


class _PrefixMax:
    """Fenwick tree for the maximum over a prefix of positions, with a payload."""

    def __init__(self, size: int) -> None:
        self.values = [float("-inf")] * (size + 1)
        self.payloads: list[int | None] = [None] * (size + 1)

    def update(self, position: int, value: float, payload: int) -> None:
        position += 1
        while position < len(self.values):
            if value > self.values[position]:
                self.values[position], self.payloads[position] = value, payload
            position += position & -position

    def query(self, position: int) -> tuple[float, int | None]:
        """Maximum over positions 0..position-1."""
        best, payload = float("-inf"), None
        while position > 0:
            if self.values[position] > best:
                best, payload = self.values[position], self.payloads[position]
            position -= position & -position
        return best, payload


def fit_footnote_numbers(pages: Sequence[Sequence[FootnoteStart]]) -> list[list[int]]:
    """
    Fit the numbers at the start of lines to increasing footnote sequences.

    Each number is either taken as read, taken with one digit wrong, missing or extra, or
    left out (page numbers, years, misread lines). The fit maximizes the scores of the
    numbers taken minus a penalty for every number the sequence skips, up to a maximum. The
    sequence may also restart near 1 at a higher cost, for documents whose numbering
    restarts with every article or chapter. If most numbers are followed by `)`, numbers
    without it are not considered.

    Args:
        pages: The footnote starts of every page, in reading order

    Returns:
        The footnote numbers found on every page, in document order
    """
    starts = [(page, start) for page, page_starts in enumerate(pages) for start in page_starts]
    parenthesized = sum(1 for _, start in starts if start.parenthesized)
    if parenthesized * 2 >= len(starts):
        starts = [(page, start) for page, start in starts if start.parenthesized]
    variants = [_read_variants(start.digits) for _, start in starts]
    values = sorted({value for options in variants for value, _ in options})
    index = {value: i for i, value in enumerate(values)}
    # Best totals of the numbers taken so far, by their value: with the gap penalty folded in
    # (total + GAP_PENALTY * value), and plain for jumps
    gapped = _PrefixMax(len(values))
    plain = _PrefixMax(len(values))
    nodes: list[tuple[int, int, int | None]] = []  # (start index, number, previous node)
    best_score, best_node = float("-inf"), None
    for i, options in enumerate(variants):
        new_nodes = []
        for value, score in options:
            # Start a sequence, continue one from a smaller number, jump ahead, or restart
            total, previous = score, None
            gapped_key, gapped_node = gapped.query(index[value])
            if gapped_node is not None and score + gapped_key - GAP_PENALTY * (value - 1) > total:
                total, previous = score + gapped_key - GAP_PENALTY * (value - 1), gapped_node
            plain_total, plain_node = plain.query(index[value])
            if plain_node is not None and score + plain_total - JUMP_PENALTY > total:
                total, previous = score + plain_total - JUMP_PENALTY, plain_node
            if best_node is not None and value <= RESTART_MAX_NUMBER and score + best_score - RESTART_PENALTY > total:
                total, previous = score + best_score - RESTART_PENALTY, best_node
            nodes.append((i, value, previous))
            new_nodes.append((index[value], total, len(nodes) - 1))
        for position, total, node in new_nodes:
            gapped.update(position, total + GAP_PENALTY * values[position], node)
            plain.update(position, total, node)
            if total > best_score:
                best_score, best_node = total, node
    chain = []
    node = best_node
    while node is not None:
        start_index, value, node = nodes[node]
        chain.append((starts[start_index][0], value))
    result: list[list[int]] = [[] for _ in pages]
    for page, value in reversed(chain):
        result[page].append(value)
    return result


def _page_ranges(fitted: Sequence[Sequence[int]], candidate_counts: Sequence[int]) -> list[tuple[int, int]]:
    """
    Return the range of footnote numbers that can have a marker on each page.

    A page can have the numbers after the last fitted number before it up to the number
    before the next fitted number after it. Where the sequence restarts, a side is bounded
    by the page's own numbers and its number of candidates instead.

    Returns:
        (low, high) for every page, inclusive
    """
    ranges = []
    for page, own in enumerate(fitted):
        before = next((numbers[-1] for numbers in reversed(fitted[:page]) if numbers), None)
        after = next((numbers[0] for numbers in fitted[page + 1 :] if numbers), None)
        slack = candidate_counts[page] + 1
        if own:
            low = before + 1 if before is not None and before < own[0] else max(1, own[0] - slack)
            high = after - 1 if after is not None and after > own[-1] else own[-1] + slack
        elif before is not None and after is not None and before < after:
            low, high = before + 1, after - 1
        elif before is not None:
            low, high = before + 1, before + slack
        elif after is not None:
            low, high = max(1, after - slack), after - 1
        else:
            low, high = 1, slack
        ranges.append((low, high))
    return ranges


def _choose_number(readings: Sequence[str], after: int, high: int) -> int | None:
    """
    Choose the number of a marker from its second-pass readings.

    The next number in sequence wins if a reading ends with it; otherwise the number in
    range matching the most digits at the end of a reading.
    """
    readings = [reading for reading in readings if reading]
    if any(reading.endswith(str(after + 1)) for reading in readings) and after + 1 <= high:
        return after + 1
    best: int | None = None
    for reading in readings:
        for length in range(len(reading), 0, -1):
            tail = reading[-length:]
            if tail.startswith("0"):
                continue
            number = int(tail)
            if after < number <= high:
                if best is None or len(str(number)) > len(str(best)) or (len(str(number)) == len(str(best)) and number < best):
                    best = number
                break
    return best


def plan_repairs(pages: Sequence[PageAnalysis]) -> list[list[MarkerRepair]]:
    """
    Decide the number of every misrecognized marker of a document.

    Args:
        pages: The analyses of all pages, in page order

    Returns:
        The repairs of every page
    """
    fitted = fit_footnote_numbers([page.footnote_starts for page in pages])
    repairs: list[list[MarkerRepair]] = [[] for _ in pages]
    if not any(fitted):
        # Without footnote numbers there is nothing to check the readings against
        return repairs
    ranges = _page_ranges(fitted, [len(page.candidates) for page in pages])
    last = 0
    for page_index, (page, (low, high)) in enumerate(zip(pages, ranges)):
        # Continue from the previous page unless the page's range lies elsewhere
        if not low - 1 <= last <= high:
            last = low - 1
        for candidate in page.candidates:
            if candidate.is_number:
                number = int(candidate.marker)
                if last < number <= high:
                    last = number
                continue
            chosen = _choose_number(candidate.readings, last, high)
            if chosen is None:
                continue
            last = chosen
            repairs[page_index].append(MarkerRepair(candidate.word_id, candidate.text, f"{candidate.prefix}{chosen}{candidate.suffix}"))
    return repairs


def apply_repairs(root: etree._Element, repairs: Sequence[MarkerRepair]) -> None:
    """Replace the text of the repaired words in an hOCR document in place."""
    by_id = {repair.word_id: repair for repair in repairs}
    for element in root.iter(f"{{{XHTML_NS}}}span", "span"):
        repair = by_id.get(element.get("id") or "")
        if repair is None:
            continue
        for child in list(element):
            element.remove(child)
        element.text = repair.new


def parse_hocr(path: Path) -> etree._ElementTree:
    """Parse an hOCR file written by Tesseract."""
    return etree.parse(str(path), etree.XMLParser(resolve_entities=False, no_network=True))


def write_hocr(tree: etree._ElementTree, path: Path) -> None:
    """Write an hOCR document, keeping its doctype."""
    # The lxml stubs lack DocInfo.doctype
    doctype = str(getattr(tree.docinfo, "doctype", "") or "")
    body = etree.tostring(tree.getroot(), encoding="unicode")
    path.write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n{doctype}\n{body}\n', encoding="utf-8")
