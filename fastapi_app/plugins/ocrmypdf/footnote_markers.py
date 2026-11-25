"""
Repair of footnote markers that Tesseract misrecognizes (#904).

Tesseract reads small superscript footnote markers as punctuation, independent of the
resolution and of the model: `tut³¹²⁾` becomes `tut?!?)`, `Regel¹²` becomes `Regel"`,
`vor.¹⁴` becomes `vor.'*`. Recognizing the part of the word after its letters again,
upscaled and with a digits-only whitelist, mostly yields the digits, sometimes with an
extra leading digit from the last letter.

Candidates are words that end in a run of non-letters: with a closing parenthesis
(`tut?!?)`), which is evidence enough, or without one (`Regel"`, `vor.'*`, `streng’;`),
where the run must be raised above the baseline in the page image and the marker must be
the next number of the sequence. Raised words of their own (`Regel "`) are candidates too.
Footnote numbers at the start of footnotes that are set as superscripts as well (`» Vgl.`,
`“Vgl.` for `¹⁴ Vgl.`) are recognized again in the same way, used for the numbering, and
repaired.

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

RECOVERED_SCORE_FACTOR = 1 / 3
"""Factor on the scores of footnote numbers that were misrecognized and read again: their
readings are less reliable than numbers read as digits in the first pass."""
STRICT_MAX_STEP = 3
"""Most numbers a marker without parenthesis may advance the sequence by. These markers have
less evidence than parenthesized ones, so they are only accepted as the next number or close
to it (a marker or two may have been missed)."""
RAISED_BASELINE_FRACTION = 0.3
"""A word of its own is raised if its bottom lies at least this fraction of the x-height
above the baseline of its line."""

_FOOTNOTE_START_RE = re.compile(r"^(\d{1,5})(\)?)$")
_TRAILING_PUNCTUATION = ".,;:"
_KEPT_PUNCTUATION = ".,;:)"
"""Punctuation directly after the letters of a word that belongs to the text, not the marker."""
_OPENING_QUOTES = "„‚“‘»«\""
_CLOSING_QUOTES = "“”‘’\"'«»"
_DASHES = "-‐‑–—"

Box = tuple[int, int, int, int]
"""Pixel bounding box: left, top, right, bottom."""

DigitRecognizer = Callable[[Image.Image, Sequence[Box]], list[list[str]]]
"""Recognizes the digits in regions of a page image: returns the readings of every region (one
per model). All regions of a page are passed at once, so that a recognizer can process them in
one batch."""


@dataclass
class FootnoteStart:
    """A line that starts with a number, possibly the start of a footnote."""

    digits: str
    """The number as read, empty for a misrecognized number (see `readings`)."""
    parenthesized: bool
    """Whether the number is followed by `)`."""
    readings: list[str] = field(default_factory=list)
    """Digits read by the second pass for a misrecognized number."""
    word_id: str = ""
    """The `id` of the first word of the line, set for a misrecognized number."""
    text: str = ""
    """The first word of the line, set for a misrecognized number."""
    marker: str = ""
    """The misrecognized characters at the start of `text`."""

    @property
    def recovered(self) -> bool:
        """Whether the number was misrecognized and read again."""
        return not self.digits

    def repaired_text(self, number: int) -> str:
        """Return the first word with the misrecognized characters replaced by `number`."""
        rest = self.text[len(self.marker) :]
        separator = " " if rest[:1].isalpha() else ""
        return f"{number}{separator}{rest}"


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
    strict: bool = False
    """Whether the marker has no closing parenthesis, so it is only accepted as the next
    number of the sequence (see `STRICT_MAX_STEP`)."""

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


def _is_marker_run(marker: str) -> bool:
    """Whether a run of non-letters can be a misrecognized or correct marker."""
    if not marker or len(marker) > MAX_MARKER_LENGTH:
        return False
    if any(char.isspace() or char.isalpha() or char in "()" for char in marker):
        return False
    return not all(char in _DASHES for char in marker)


def split_trailing_marker(text: str) -> tuple[str, str, str] | None:
    """
    Split a word that ends in a marker without closing parenthesis.

    Punctuation directly after the letters (`.,;:)`) belongs to the text, and so does a
    closing quotation mark if the word has an opening one. Hyphens and dashes are no markers.

    Args:
        text: The recognized word, e.g. `Regel"`, `vor.'*` or `streng’;`

    Returns:
        (prefix, marker, suffix), e.g. ("vor.", "'*", ""), or None if the word does not end in
        a run of non-letters after a letter
    """
    core = text.rstrip(_TRAILING_PUNCTUATION)
    suffix = text[len(core) :]
    end = len(core)
    while end > 0 and not core[end - 1].isalpha():
        end -= 1
    prefix, run = core[:end], core[end:]
    if not prefix:
        return None
    kept = 0
    while kept < len(run) and run[kept] in _KEPT_PUNCTUATION:
        kept += 1
    if kept < len(run) and run[kept] in _CLOSING_QUOTES and any(char in _OPENING_QUOTES for char in prefix):
        kept += 1
    prefix, marker = prefix + run[:kept], run[kept:]
    if not _is_marker_run(marker):
        return None
    return prefix, marker, suffix


def split_standalone_marker(text: str) -> tuple[str, str] | None:
    """
    Split a word without letters into the marker and the punctuation after it.

    Args:
        text: The recognized word, e.g. `"` or `?!?).`

    Returns:
        (marker, suffix), e.g. ("?!?", ")."), or None
    """
    core = text.rstrip(_TRAILING_PUNCTUATION)
    if core.endswith(")"):
        core = core[:-1]
    if not _is_marker_run(core):
        return None
    return core, text[len(core) :]


def split_leading_marker(text: str) -> tuple[str, bool] | None:
    """
    Split off the non-letters at the start of the first word of a line.

    Args:
        text: The recognized word, e.g. `“Vgl.`, `»` or `"®)`

    Returns:
        (marker, parenthesized), e.g. ("“", False), or None if the word does not start with a
        possible misrecognized number
    """
    end = 0
    while end < len(text) and not text[end].isalpha():
        end += 1
    run = text[:end]
    parenthesized = run.endswith(")")
    marker = run[:-1] if parenthesized else run
    if marker.isdigit() or not _is_marker_run(marker):
        return None
    if end < len(text) and parenthesized is False and marker[-1] in _TRAILING_PUNCTUATION:
        return None
    return marker, parenthesized


@dataclass(frozen=True)
class LineGeometry:
    """Baseline and x-height of an hOCR line."""

    left: int
    bottom: int
    slope: float
    offset: float
    x_height: float

    @classmethod
    def from_title(cls, title: str) -> "LineGeometry | None":
        """Read the geometry from the `title` of an `ocr_line` element."""
        box = parse_bbox(title)
        baseline = re.search(r"baseline (-?[\d.]+) (-?[\d.]+)", title)
        if not box or not baseline:
            return None
        values = {key: float(value) for key, value in re.findall(r"(x_size|x_ascenders|x_descenders) ([\d.]+)", title)}
        x_height = values.get("x_size", 0) - values.get("x_ascenders", 0) - values.get("x_descenders", 0)
        if x_height <= 0:
            x_height = (box[3] - box[1]) / 2
        return cls(box[0], box[3], float(baseline.group(1)), float(baseline.group(2)), x_height)

    def is_raised(self, box: Box) -> bool:
        """Whether a word box lies well above the baseline, like a superscript."""
        baseline = self.bottom + self.slope * ((box[0] + box[2]) / 2 - self.left) + self.offset
        return box[3] <= baseline - RAISED_BASELINE_FRACTION * self.x_height


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


def make_tesseract_digit_recognizer(languages: Sequence[str] = ("eng",), timeout: float = 10.0, timeout_per_region: float = 1.0) -> DigitRecognizer:
    """
    Return a recognizer that runs Tesseract on the upscaled regions with a digits-only whitelist.

    The regions are saved as images and passed to Tesseract as a list file, so that each model
    is loaded once per page instead of once per region; starting Tesseract takes far longer
    than recognizing a region. Tesseract recognizes every image of the list separately (with
    `--psm 7`, as a single line) and separates their texts with form feeds.

    Args:
        languages: Installed Tesseract models, each recognizes every region once. Despite the
            whitelist, the models read the same digits differently (on the example of #904,
            `deu` read `1` where `eng` read `167`), so using several increases the hits.
        timeout: Base timeout in seconds per model
        timeout_per_region: Seconds added to the timeout per region

    Returns:
        A recognizer that returns the digits read by each model for every region
    """

    def recognize(image: Image.Image, boxes: Sequence[Box]) -> list[list[str]]:
        readings: list[list[str]] = [[] for _ in boxes]
        if not boxes:
            return readings
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for index, box in enumerate(boxes):
                crop = image.crop(box)
                crop = crop.resize((max(1, crop.width * 3), max(1, crop.height * 3)), Image.Resampling.LANCZOS)
                path = Path(tmp) / f"region-{index:05d}.png"
                crop.save(path)
                paths.append(str(path))
            list_file = Path(tmp) / "regions.txt"
            list_file.write_text("\n".join(paths) + "\n", encoding="utf-8")
            for language in languages:
                command = ["tesseract", str(list_file), "stdout", "-l", language, "--psm", "7", "-c", "tessedit_char_whitelist=0123456789)"]
                try:
                    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout + timeout_per_region * len(boxes), check=True)
                except (subprocess.SubprocessError, OSError) as e:
                    logger.warning(f"Footnote marker recognition failed: {e}")
                    continue
                texts = result.stdout.split("\f")
                if len(texts) < len(boxes):
                    logger.warning(f"Footnote marker recognition returned {len(texts)} texts for {len(boxes)} regions")
                    continue
                for region_readings, text in zip(readings, texts):
                    region_readings.append("".join(char for char in text if char.isdigit()))
        return readings

    return recognize


class _RecognitionQueue:
    """
    Collects the regions to recognize on a page, so that they are recognized in one batch.

    `request()` returns an empty list that `run()` fills with the readings of the regions.
    """

    def __init__(self) -> None:
        self._boxes: list[Box] = []
        self._targets: list[list[str]] = []

    def request(self, *boxes: Box) -> list[str]:
        """Queue regions; their readings are added to the returned list in this order."""
        readings: list[str] = []
        for box in boxes:
            self._boxes.append(box)
            self._targets.append(readings)
        return readings

    def run(self, image: Image.Image, recognize: DigitRecognizer) -> None:
        """Recognize all queued regions and fill in their readings."""
        if not self._boxes:
            return
        for target, readings in zip(self._targets, recognize(image, self._boxes)):
            target.extend(readings)


def _classes(element: etree._Element) -> set[str]:
    return set((element.get("class") or "").split())


def _page_lines(root: etree._Element) -> list[tuple[LineGeometry | None, list[etree._Element]]]:
    """Return the geometry and the words of every line, in reading order."""
    lines = []
    for element in root.iter(f"{{{XHTML_NS}}}span", "span"):
        if _classes(element) & LINE_CLASSES:
            words = [word for word in element.iter(f"{{{XHTML_NS}}}span", "span") if "ocrx_word" in _classes(word)]
            if words:
                lines.append((LineGeometry.from_title(element.get("title") or ""), words))
    return lines


def _word_text(word: etree._Element) -> str:
    return "".join(str(text) for text in word.itertext())


def _padded(image: Image.Image, box: Box) -> Box:
    """Return a word box with some margin, for recognizing a word of its own."""
    left, top, right, bottom = box
    padding = max(2, (bottom - top) // 4)
    return max(0, left - padding), max(0, top - padding), min(image.width, right + padding), min(image.height, bottom + padding)


def _recovered_start(words: Sequence[etree._Element], geometry: LineGeometry | None, image: Image.Image, queue: _RecognitionQueue) -> FootnoteStart | None:
    """
    Recognize a superscript footnote number at the start of a line again.

    The first word must start with non-letters that are raised: as a word of its own
    (`» Vgl.`), judged against the baseline of the line, or followed by letters (`“Vgl.`),
    judged within the word.
    """
    word = words[0]
    text = _word_text(word)
    box = parse_bbox(word.get("title") or "")
    word_id = word.get("id")
    parts = split_leading_marker(text)
    if not parts or not box or not word_id:
        return None
    marker, parenthesized = parts
    run_length = len(marker) + int(parenthesized)
    if run_length == len(text):
        if len(words) < 2 or geometry is None or not geometry.is_raised(box):
            return None
        region: Box | None = _padded(image, box)
    else:
        left, top, right, bottom = box
        end = left + (right - left) * len(marker) // len(text)
        estimate = (left, top, min(right, end + (bottom - top) // 4), bottom)
        region = raised_region(image, box, estimate)
    if region is None:
        return None
    return FootnoteStart("", parenthesized, queue.request(region), word_id, text, marker)


def _candidate(word: etree._Element, position: int, geometry: LineGeometry | None, image: Image.Image, queue: _RecognitionQueue) -> MarkerCandidate | None:
    """Return the word as a marker candidate, with its second-pass regions queued, or None."""
    text = _word_text(word)
    box = parse_bbox(word.get("title") or "")
    word_id = word.get("id")
    if not box or not word_id:
        return None
    if parts := split_marker(text):
        # Followed by a parenthesis: a candidate even if nothing raised is found
        candidate = MarkerCandidate(word_id, text, *parts)
        if not candidate.is_number:
            region = marker_box(box, text, candidate.prefix)
            raised = raised_region(image, box, region)
            candidate.readings = queue.request(raised, region) if raised else queue.request(region)
        return candidate
    if position > 0 and (standalone := split_standalone_marker(text)):
        if geometry is None or not geometry.is_raised(box):
            return None
        candidate = MarkerCandidate(word_id, text, "", *standalone, strict=True)
        if not candidate.is_number:
            candidate.readings = queue.request(_padded(image, box))
        return candidate
    if parts := split_trailing_marker(text):
        region = marker_box(box, text, parts[0])
        raised = raised_region(image, box, region)
        if raised is None:
            # Without parenthesis, only raised glyphs are evidence of a superscript
            return None
        candidate = MarkerCandidate(word_id, text, *parts, strict=True)
        if not candidate.is_number:
            candidate.readings = queue.request(raised, region)
        return candidate
    return None


def analyze_page(root: etree._Element, image: Image.Image, recognize: DigitRecognizer) -> PageAnalysis:
    """
    Collect the footnote starts and marker candidates of an hOCR page.

    Misrecognized markers and footnote numbers are recognized again here, since this is the
    step that has the page image. The regions of the whole page are recognized in one batch.

    Args:
        root: The root of the hOCR document
        image: The page image the hOCR was recognized from
        recognize: Recognizes the digits in regions of the image
    """
    analysis = PageAnalysis()
    queue = _RecognitionQueue()
    for geometry, words in _page_lines(root):
        first = 0
        if match := _FOOTNOTE_START_RE.match(_word_text(words[0])):
            analysis.footnote_starts.append(FootnoteStart(match.group(1), bool(match.group(2))))
            first = 1
        elif start := _recovered_start(words, geometry, image, queue):
            analysis.footnote_starts.append(start)
            first = 1
        for position, word in enumerate(words[first:], start=first):
            if candidate := _candidate(word, position, geometry, image, queue):
                analysis.candidates.append(candidate)
    queue.run(image, recognize)
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


def _start_variants(start: FootnoteStart) -> list[tuple[int, float]]:
    """Return the numbers a footnote start can be, with their scores."""
    if not start.recovered:
        return _read_variants(start.digits)
    best: dict[int, float] = {}
    for reading in start.readings:
        if reading:
            for value, score in _read_variants(reading):
                best[value] = max(best.get(value, 0.0), score * RECOVERED_SCORE_FACTOR)
    return list(best.items())


def fit_footnote_numbers(pages: Sequence[Sequence[FootnoteStart]]) -> list[list[int]]:
    """
    Fit the numbers at the start of lines to increasing footnote sequences.

    See `fit_footnote_starts`.

    Returns:
        The footnote numbers found on every page, in document order
    """
    return [[value for value in page if value is not None] for page in fit_footnote_starts(pages)]


def fit_footnote_starts(pages: Sequence[Sequence[FootnoteStart]]) -> list[list[int | None]]:
    """
    Fit the numbers at the start of lines to increasing footnote sequences.

    Each number is either taken as read, taken with one digit wrong, missing or extra, or
    left out (page numbers, years, misread lines). The fit maximizes the scores of the
    numbers taken minus a penalty for every number the sequence skips, up to a maximum. The
    sequence may also restart near 1 at a higher cost, for documents whose numbering
    restarts with every article or chapter. If most numbers are followed by `)`, numbers
    without it are not considered. Misrecognized numbers that were read again count less.

    Args:
        pages: The footnote starts of every page, in reading order

    Returns:
        The number fitted to every footnote start, or None if it was left out
    """
    starts = [(page, position, start) for page, page_starts in enumerate(pages) for position, start in enumerate(page_starts)]
    parenthesized = sum(1 for _, _, start in starts if start.parenthesized)
    if parenthesized * 2 >= len(starts):
        starts = [entry for entry in starts if entry[2].parenthesized]
    variants = [_start_variants(start) for _, _, start in starts]
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
    result: list[list[int | None]] = [[None] * len(page_starts) for page_starts in pages]
    node = best_node
    while node is not None:
        start_index, value, node = nodes[node]
        page, position, _ = starts[start_index]
        result[page][position] = value
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
    assigned = fit_footnote_starts([page.footnote_starts for page in pages])
    fitted = [[value for value in page if value is not None] for page in assigned]
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
        for start, value in zip(page.footnote_starts, assigned[page_index]):
            # A misrecognized footnote number is repaired if the fit took it and a reading has it
            if start.recovered and value is not None and any(str(value) in reading for reading in start.readings):
                repairs[page_index].append(MarkerRepair(start.word_id, start.text, start.repaired_text(value)))
        # Markers refer to footnotes on their own page, so a marker without parenthesis is not
        # given a number below the page's first footnote number
        floor = fitted[page_index][0] - 1 if fitted[page_index] else low - 1
        for candidate in page.candidates:
            after = max(last, floor) if candidate.strict else last
            limit = min(high, after + STRICT_MAX_STEP) if candidate.strict else high
            if candidate.is_number:
                number = int(candidate.marker)
                if after < number <= limit:
                    last = number
                continue
            chosen = _choose_number(candidate.readings, after, limit)
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
