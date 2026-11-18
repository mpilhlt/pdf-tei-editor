"""
The `<text>` of a zone document as lines and pieces, and changing its zone labels.

In a zone document (such as `grobid.training.segmentation`), the children of `<text>` are zones
(`<front>`, `<body>`, `<note place="headnote">`, ...) that partition one text stream. The `<lb/>`
elements belong to that stream: they are never added or moved. Correcting the document means
moving zone boundaries and relabeling zones, so this module reads the stream as

- lines: the content up to and including an `<lb/>` (text after the last `<lb/>` is a last line)
- pieces: the parts of a line that lie in different zones, each with the short code of its zone
  (see :class:`ZoneLabel`), `-` for text outside any zone

and writes label changes back into the XML with :func:`apply_labels`, keeping the raw XML of the
text byte for byte. It also groups the lines into pages (from a line layout, see
`fastapi_app/lib/tei/layout.py`), computes the fingerprints of page review units, renders the
line listing that models see, and parses their answers.

The JavaScript mirror `app/src/modules/zone-lines.js` reads lines, pieces and page fingerprints
the same way; `tests/fixtures/zone-lines/` holds the fixtures both are tested with.

Pure module: no FastAPI imports.
"""

from __future__ import annotations

import hashlib
import html
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

OUTSIDE = "-"
"""Label of text outside any zone."""

LAYOUT_HINTS: dict[str, str] = {
    "top": "the line is at the top of the page",
    "bottom": "the line is at the bottom of the page",
    "repeated": "the line repeats at the same position on other pages (typical of running headers and footers)",
    "larger": "the font is larger than in the line before",
    "smaller": "the font is smaller than in the line before",
    "bold": "bold font",
    "italic": "italic font",
    "figure": "a figure (bitmap or vector graphic) is next to the line",
    "margin": "the line is outside the main text area of the page",
    "block": "the line starts a new text block",
}
"""Layout hints of a line, as they appear in the listing, with their explanation for the system prompt."""

DEFAULT_CONTEXT_LINES = 5
"""Lines of context shown before and after a processing window."""


class ZoneDocumentError(ValueError):
    """The document cannot be read as a zone document (no `<text>`, or markup other than zones and `<lb/>`)."""


@dataclass(frozen=True)
class ZoneLabel:
    """A zone label: its short code and the element (with attributes) it stands for."""

    code: str
    element: str
    attributes: tuple[tuple[str, str], ...] = ()

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "ZoneLabel":
        """From the `zoneLabels` entry of an extractor's info: `{code, element, attributes}`."""
        attrs = data.get("attributes") or {}
        if not isinstance(attrs, Mapping):
            raise ValueError(f"Invalid attributes of zone label {data.get('code')!r}")
        return cls(str(data["code"]), str(data["element"]), tuple(sorted((str(k), str(v)) for k, v in attrs.items())))

    def open_tag(self) -> str:
        """The start tag of a new zone with this label."""
        attrs = "".join(f' {name}="{_escape_attr(value)}"' for name, value in self.attributes)
        return f"<{self.element}{attrs}>"


def zone_labels(entries: Iterable[Mapping[str, object]]) -> list[ZoneLabel]:
    """The zone labels of an extractor's `zoneLabels` entry for a variant."""
    return [ZoneLabel.from_dict(entry) for entry in entries]


# ── Reading ──────────────────────────────────────────────────────────

# kinds of atoms
CHAR = "char"  # one non-whitespace character (or entity reference)
SPACE = "space"  # one whitespace character
LB = "lb"  # an <lb/> element
OTHER = "other"  # a comment, processing instruction


@dataclass
class Atom:
    """One unit of the text stream with its position in the XML string."""

    kind: str
    start: int
    end: int
    char: str  # decoded character ('' for LB and OTHER)
    label: str  # code of the zone it lies in, OUTSIDE if none
    item: int  # index of the top-level item of <text> it lies in (see ZoneDocument.items)
    line: int = -1


@dataclass
class Item:
    """A top-level item of `<text>`: a zone, or a stretch of text between zones."""

    start: int
    end: int
    label: str  # OUTSIDE for text between zones
    open_tag: str = ""  # raw start tag of a zone
    element: str = ""  # element name of a zone, as written (with prefix)
    atoms: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class Piece:
    """The part of a line in one zone."""

    label: str
    text: str  # whitespace collapsed


@dataclass
class Line:
    """A line of the text stream."""

    index: int
    atoms: list[int]
    pieces: list[Piece]
    # label of a line without text: the zone of its <lb/>
    empty_label: str = OUTSIDE

    @property
    def text(self) -> str:
        """The text of the line, pieces separated by one space."""
        return " ".join(p.text for p in self.pieces)

    @property
    def label(self) -> str | None:
        """The line's label if it has one piece (or no text), else None."""
        if not self.pieces:
            return self.empty_label
        return self.pieces[0].label if len(self.pieces) == 1 else None


_TOKEN_RE = re.compile(
    r"<!--.*?-->|<\?.*?\?>|<!\[CDATA\[(?P<cdata>.*?)\]\]>"
    r"|<(?P<close>/)?(?P<name>[\w:.-]+)(?P<attrs>(?:\"[^\"]*\"|'[^']*'|[^>\"'])*?)(?P<self>/)?>"
    r"|&(?:#(?P<dec>\d+)|#x(?P<hex>[0-9a-fA-F]+)|(?P<named>\w+));",
    re.DOTALL,
)
_TEXT_OPEN_RE = re.compile(r"<(?:[\w.-]+:)?text\b(?:\"[^\"]*\"|'[^']*'|[^>\"'])*>")
_TEXT_CLOSE_RE = re.compile(r"</(?:[\w.-]+:)?text\s*>")
_ATTR_RE = re.compile(r"([\w:.-]+)\s*=\s*(\"[^\"]*\"|'[^']*')")
# whitespace as JavaScript's \s, so that the mirror in zone-lines.js reads the same text
_WS_CLASS = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_RE = re.compile(f"[{_WS_CLASS}]+")
_IS_WS_RE = re.compile(f"[{_WS_CLASS}]")


def is_space(char: str) -> bool:
    """Whether a character is whitespace (as JavaScript's \\s)."""
    return bool(_IS_WS_RE.fullmatch(char))


def _local(name: str) -> str:
    return name.rsplit(":", 1)[-1]


def _escape_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")


def collapse(text: str) -> str:
    """Collapse whitespace runs to one space and trim."""
    return _WS_RE.sub(" ", text).strip()


def _parse_attrs(raw: str) -> dict[str, str]:
    return {(name if name.startswith("xml:") else _local(name)): html.unescape(value[1:-1]) for name, value in _ATTR_RE.findall(raw)}


def _decode_entity(match: re.Match[str]) -> str:
    if match.group("dec"):
        return chr(int(match.group("dec")))
    if match.group("hex"):
        return chr(int(match.group("hex"), 16))
    named = match.group("named")
    return {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}.get(named, html.unescape(match.group(0)))


class ZoneDocument:
    """
    The `<text>` of a zone document as atoms, top-level items, lines and pieces.

    Raises:
        ZoneDocumentError: no `<text>` element, or a zone contains elements other than `<lb/>`.
    """

    def __init__(self, xml: str, labels: Sequence[ZoneLabel]):
        self.xml = xml
        self.labels = list(labels)
        self.by_code = {label.code: label for label in self.labels}
        open_match = _TEXT_OPEN_RE.search(xml)
        if open_match is None:
            raise ZoneDocumentError("The document has no <text> element")
        close_match = None
        for close_match in _TEXT_CLOSE_RE.finditer(xml, open_match.end()):
            pass
        if close_match is None:
            raise ZoneDocumentError("The <text> element is not closed")
        self.start = open_match.end()
        self.end = close_match.start()
        self.atoms: list[Atom] = []
        self.items: list[Item] = []
        # raw start tags and element names of zones whose code is not in the vocabulary
        self.unknown: dict[str, tuple[str, str]] = {}
        self._read()
        self.lines = self._lines()

    # labels of zone elements

    def code_of(self, element: str, attrs: Mapping[str, str], open_tag: str) -> str:
        """The code of a zone element: the most specific matching label, else `<element>[:<first attribute value>]`."""
        name = _local(element)
        best: ZoneLabel | None = None
        for label in self.labels:
            if label.element != name or any(attrs.get(k) != v for k, v in label.attributes):
                continue
            if best is None or len(label.attributes) > len(best.attributes):
                best = label
        if best is not None:
            return best.code
        values = [v for k, v in attrs.items() if not k.startswith("xml")]
        code = f"{name}:{values[0]}" if values else name
        self.unknown.setdefault(code, (open_tag, element))
        return code

    def _read(self) -> None:
        xml = self.xml
        pos = self.start
        zone: Item | None = None
        outside: Item | None = None

        def add(kind: str, start: int, end: int, char: str) -> None:
            nonlocal outside
            if zone is not None:
                item = zone
            else:
                if outside is None:
                    outside = Item(start, end, OUTSIDE)
                    self.items.append(outside)
                item = outside
                item.end = end
            atom = Atom(kind, start, end, char, item.label, len(self.items) - 1)
            item.atoms.append(len(self.atoms))
            self.atoms.append(atom)

        def add_text(text: str, offset: int) -> None:
            for i, ch in enumerate(text):
                add(SPACE if is_space(ch) else CHAR, offset + i, offset + i + 1, ch)

        for match in _TOKEN_RE.finditer(xml, self.start, self.end):
            if match.start() > pos:
                add_text(xml[pos:match.start()], pos)
            pos = match.end()
            token = match.group(0)
            if token.startswith("&"):
                char = _decode_entity(match)
                add(SPACE if is_space(char) else CHAR, match.start(), match.end(), char)
            elif match.group("cdata") is not None:
                start = match.start() + len("<![CDATA[")
                add_text(match.group("cdata"), start)
            elif token.startswith("<!--") or token.startswith("<?"):
                add(OTHER, match.start(), match.end(), "")
            else:
                name = match.group("name")
                is_close = bool(match.group("close"))
                is_self = bool(match.group("self"))
                if _local(name) == "lb":
                    if is_close:
                        continue
                    add(LB, match.start(), match.end(), "")
                    if not is_self:
                        raise ZoneDocumentError("<lb> must be an empty element")
                    continue
                if zone is None and not is_close:
                    attrs = _parse_attrs(match.group("attrs") or "")
                    code = self.code_of(name, attrs, token)
                    zone = Item(match.start(), match.end(), code, token, name)
                    self.items.append(zone)
                    outside = None
                    if is_self:
                        zone = None
                    continue
                if zone is not None and is_close and name == zone.element:
                    zone.end = match.end()
                    zone = None
                    continue
                raise ZoneDocumentError(
                    f"Unexpected <{'/' if is_close else ''}{name}> in <text>: zones may only contain text and <lb/>"
                )
        if pos < self.end:
            add_text(xml[pos:self.end], pos)
        if zone is not None:
            raise ZoneDocumentError(f"The zone <{zone.element}> is not closed")

    def _lines(self) -> list[Line]:
        lines: list[Line] = []
        current: list[int] = []
        for index, atom in enumerate(self.atoms):
            current.append(index)
            if atom.kind == LB:
                lines.append(self._make_line(len(lines), current))
                current = []
        if any(self.atoms[i].kind == CHAR for i in current):
            lines.append(self._make_line(len(lines), current))
        for line in lines:
            for i in line.atoms:
                self.atoms[i].line = line.index
        return lines

    def _make_line(self, index: int, atoms: list[int]) -> Line:
        labels = [self.atoms[i].label for i in atoms]
        pieces = pieces_of([self.atoms[i] for i in atoms], labels)
        empty_label = next((self.atoms[i].label for i in atoms if self.atoms[i].kind == LB), OUTSIDE)
        return Line(index, atoms, pieces, empty_label)

    # derived views

    def line_pieces(self, overrides: Mapping[int, str] | None = None) -> list[list[Piece]]:
        """The pieces of every line, with atom labels from `overrides` (atom index -> label) where given."""
        if not overrides:
            return [line.pieces for line in self.lines]
        return [
            pieces_of([self.atoms[i] for i in line.atoms], [overrides.get(i, self.atoms[i].label) for i in line.atoms])
            for line in self.lines
        ]


def pieces_of(atoms: Sequence[Atom], labels: Sequence[str]) -> list[Piece]:
    """The pieces of a line's atoms: runs of text with the same label; whitespace between pieces is dropped."""
    pieces: list[tuple[str, list[str]]] = []
    pending = ""
    for atom, label in zip(atoms, labels):
        if atom.kind == SPACE:
            pending += atom.char
        elif atom.kind == CHAR:
            if pieces and pieces[-1][0] == label:
                pieces[-1][1].append(pending + atom.char)
            else:
                pieces.append((label, [atom.char]))
            pending = ""
    return [Piece(label, collapse("".join(chars))) for label, chars in pieces]


def read_zone_document(xml: str, labels: Sequence[ZoneLabel]) -> ZoneDocument:
    """Read the `<text>` of a zone document (see :class:`ZoneDocument`)."""
    return ZoneDocument(xml, labels)


# ── Pages ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Page:
    """A page: a range of lines, with its number in the document (1-based) and its fingerprint."""

    index: int  # position among the pages of the document
    number: int  # page number from the layout (1-based)
    first_line: int
    end_line: int  # exclusive
    fingerprint: str

    @property
    def lines(self) -> range:
        return range(self.first_line, self.end_line)


def page_canonical(pieces: Sequence[Sequence[Piece]]) -> str:
    """The canonical form of a page: one row per line, each piece as `[label]text`, pieces separated by a space."""
    return "\n".join(" ".join(f"[{p.label}]{p.text}" for p in line) for line in pieces)


def fingerprint_of(canonical: str) -> str:
    """First 8 hex characters of the SHA-256 of the canonical form (as unit review fingerprints)."""
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]


def page_line_ranges(line_pages: Sequence[int], line_count: int) -> list[tuple[int, int, int]]:
    """
    (page number, first line, end line) of the pages: consecutive lines with the same page index of
    the layout. Lines beyond the layout belong to the last page.
    """
    ranges: list[tuple[int, int, int]] = []
    previous: int | None = None
    for line in range(line_count):
        page = line_pages[line] if line < len(line_pages) else (previous if previous is not None else 0)
        if previous is None or page != previous:
            ranges.append((page + 1, line, line + 1))
        else:
            number, first, _ = ranges[-1]
            ranges[-1] = (number, first, line + 1)
        previous = page
    return ranges


def pages_of(doc: ZoneDocument, line_pages: Sequence[int], pieces: Sequence[Sequence[Piece]] | None = None) -> list[Page]:
    """The pages of a document, from the page index of every line (see LineLayout.pages)."""
    pieces = pieces if pieces is not None else doc.line_pieces()
    pages: list[Page] = []
    seen: dict[str, int] = {}
    for index, (number, first, end) in enumerate(page_line_ranges(line_pages, len(doc.lines))):
        base = fingerprint_of(page_canonical(pieces[first:end]))
        count = seen.get(base, 0) + 1
        seen[base] = count
        pages.append(Page(index, number, first, end, base if count == 1 else f"{base}.{count}"))
    return pages


# ── Processing windows ───────────────────────────────────────────────


def page_windows(
    doc: ZoneDocument,
    pages: Sequence[Page],
    max_pages: int | None = None,
    max_chars: int | None = None,
    hints: Sequence[Sequence[str]] | None = None,
) -> list[list[Page]]:
    """
    Groups consecutive whole pages into the windows sent to a model in one request: at most
    `max_pages` pages, or at most `max_chars` characters of their listing (a page longer than that
    forms a window of its own). Without either limit, all pages are one window.
    """
    if max_pages is None and max_chars is None:
        return [list(pages)] if pages else []
    width = line_id_width(len(doc.lines))
    windows: list[list[Page]] = []
    current: list[Page] = []
    size = 0
    for page in pages:
        length = sum(len(format_line(doc, i, width, hints[i] if hints and i < len(hints) else ())) + 1 for i in page.lines)
        if current and ((max_pages is not None and len(current) >= max_pages) or (max_chars is not None and size + length > max_chars)):
            windows.append(current)
            current, size = [], 0
        current.append(page)
        size += length
    if current:
        windows.append(current)
    return windows


# ── Listing ──────────────────────────────────────────────────────────


def line_id_width(line_count: int) -> int:
    """Digits of the line ids: at least 4."""
    return max(4, len(str(line_count)))


def line_id(index: int, width: int) -> str:
    """The id of a line in a listing (1-based, zero-padded)."""
    return str(index + 1).zfill(width)


def format_pieces(pieces: Sequence[Piece]) -> str:
    """A line's pieces with inline `[label]` markers."""
    return " ".join(f"[{p.label}]{p.text}" for p in pieces)


def format_line(doc: ZoneDocument, index: int, width: int, hints: Sequence[str] = (), pieces: Sequence[Piece] | None = None) -> str:
    """
    One line of the listing: `0413 note:headnote {top repeated} | text` for a line with one label,
    `0412 {top} | [page]12 [note:headnote]text` for a line with several pieces.
    """
    line = doc.lines[index]
    pieces = pieces if pieces is not None else line.pieces
    hint = f" {{{' '.join(hints)}}}" if hints else ""
    if len(pieces) > 1:
        return f"{line_id(index, width)}{hint} | {format_pieces(pieces)}"
    label = pieces[0].label if pieces else line.empty_label
    text = pieces[0].text if pieces else ""
    return f"{line_id(index, width)} {label}{hint} | {text}".rstrip()


def format_listing(
    doc: ZoneDocument,
    pages: Sequence[Page],
    hints: Sequence[Sequence[str]] | None = None,
    context: int = DEFAULT_CONTEXT_LINES,
) -> str:
    """
    The listing of a window of consecutive pages, with up to `context` lines before and after it,
    which are marked as not to be changed.
    """
    width = line_id_width(len(doc.lines))
    first, end = pages[0].first_line, pages[-1].end_line

    def row(i: int) -> str:
        return format_line(doc, i, width, hints[i] if hints and i < len(hints) else ())

    parts: list[str] = []
    before = range(max(0, first - context), first)
    if before:
        parts.append("=== Context before (do not change) ===\n" + "\n".join(row(i) for i in before))
    for page in pages:
        parts.append(f"=== Page {page.number} ===\n" + "\n".join(row(i) for i in page.lines))
    after = range(end, min(len(doc.lines), end + context))
    if after:
        parts.append("=== Context after (do not change) ===\n" + "\n".join(row(i) for i in after))
    return "\n\n".join(parts)


def format_label_table(labels: Sequence[ZoneLabel]) -> str:
    """The label vocabulary for a prompt: `code  <element attr="value">`, plus `-` for text outside zones."""
    rows = [f"{label.code}\t{label.open_tag()}" for label in labels]
    rows.append(f"{OUTSIDE}\ttext outside any zone")
    return "\n".join(rows)


def format_hint_table() -> str:
    """The layout hints for a prompt."""
    return "\n".join(f"{name}\t{text}" for name, text in LAYOUT_HINTS.items())


# ── Changes ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LabelChange:
    """
    A change of labels: either a range of whole lines (`first`..`last`, inclusive) with one label,
    or one line (`first` == `last`) with its pieces.
    """

    first: int
    last: int
    label: str | None = None
    pieces: tuple[tuple[str, str], ...] | None = None

    def format(self, width: int) -> str:
        """The change in the line form of the answers."""
        if self.pieces is not None:
            return f"{line_id(self.first, width)} | " + " ".join(f"[{label}]{text}" for label, text in self.pieces)
        if self.first == self.last:
            return f"{line_id(self.first, width)} {self.label}"
        return f"{line_id(self.first, width)}-{line_id(self.last, width)} {self.label}"


_MARKER_RE = re.compile(r"\[([^\[\]\s]+)\]")
_ANSWER_RE = re.compile(r"^\s*(\d+)(?:\s*[-–]\s*(\d+))?(?:\s+([^\s{|]+))?\s*(?:\{[^}]*\})?\s*(?:\|\s?(.*))?$")


def parse_pieces(text: str) -> tuple[tuple[str, str], ...] | None:
    """`[page]12 [note:headnote]Iacino` -> (("page", "12"), ("note:headnote", "Iacino")); None without a leading marker."""
    text = text.strip()
    if not text.startswith("["):
        return None
    markers = list(_MARKER_RE.finditer(text))
    if not markers or markers[0].start() != 0:
        return None
    pieces: list[tuple[str, str]] = []
    for i, marker in enumerate(markers):
        end = markers[i + 1].start() if i + 1 < len(markers) else len(text)
        pieces.append((marker.group(1), collapse(text[marker.end():end])))
    return tuple(pieces)


def parse_line_answer(line: str) -> LabelChange | None:
    """
    One line of an answer: `0413-0420 body`, `0413 body`, `0412 | [page]12 [note:headnote]...` (a
    line copied from the listing, with label, hints and text, is read as well). Ids are 1-based as
    in the listing. Returns None for lines in neither form.
    """
    match = _ANSWER_RE.match(line)
    if not match:
        return None
    first = int(match.group(1)) - 1
    last = int(match.group(2)) - 1 if match.group(2) else first
    label, text = match.group(3), match.group(4)
    if text is not None:
        pieces = parse_pieces(text)
        if pieces is not None:
            if match.group(2):
                return None
            return LabelChange(first, first, pieces=pieces)
    if label is None or first < 0 or last < first:
        return None
    return LabelChange(first, last, label=label)


def parse_answer(raw: str) -> list[LabelChange]:
    """All changes in a plain-text answer; other lines (headers, prose, `NO CHANGES`) are ignored."""
    changes: list[LabelChange] = []
    for row in raw.splitlines():
        row = row.strip().strip("`")
        if not row or row.startswith("==="):
            continue
        change = parse_line_answer(row)
        if change is not None:
            changes.append(change)
    return changes


@dataclass(frozen=True)
class ChangeProblem:
    """Why a change was dropped."""

    change: LabelChange
    reason: str  # "outside", "label", "text", "noop", "overlap"


def _text_key(text: str) -> str:
    return _WS_RE.sub("", text)


def check_changes(
    doc: ZoneDocument,
    changes: Sequence[LabelChange],
    lines: range,
    pieces: Sequence[Sequence[Piece]] | None = None,
) -> tuple[list[LabelChange], list[ChangeProblem]]:
    """
    The valid changes and the problems of the others. A change is dropped if one of its lines lies
    outside `lines` (the window without its context), it uses an unknown label, the text of a piece
    line differs from the line's text (whitespace ignored), it changes nothing, or it overlaps an
    earlier change.
    """
    pieces = pieces if pieces is not None else doc.line_pieces()
    known = set(doc.by_code) | {OUTSIDE} | set(doc.unknown)
    valid: list[LabelChange] = []
    problems: list[ChangeProblem] = []
    taken: set[int] = set()
    for change in changes:
        span = range(change.first, change.last + 1)
        if change.first not in lines or change.last not in lines:
            problems.append(ChangeProblem(change, "outside"))
            continue
        used = [label for label, _ in change.pieces] if change.pieces is not None else [change.label]
        if any(label not in known for label in used):
            problems.append(ChangeProblem(change, "label"))
            continue
        if change.pieces is not None:
            line_text = "".join(_text_key(p.text) for p in pieces[change.first])
            if "".join(_text_key(text) for _, text in change.pieces) != line_text or any(not _text_key(t) for _, t in change.pieces):
                problems.append(ChangeProblem(change, "text"))
                continue
        if any(i in taken for i in span):
            problems.append(ChangeProblem(change, "overlap"))
            continue
        if _is_noop(doc, change, pieces):
            problems.append(ChangeProblem(change, "noop"))
            continue
        taken.update(span)
        valid.append(change)
    return valid, problems


def _wanted_pieces(change: LabelChange, line: Line, current: Sequence[Piece]) -> list[Piece]:
    if change.pieces is not None:
        merged: list[Piece] = []
        for label, text in change.pieces:
            if merged and merged[-1].label == label:
                merged[-1] = Piece(label, f"{merged[-1].text} {text}")
            else:
                merged.append(Piece(label, text))
        return merged
    assert change.label is not None
    return [Piece(change.label, p.text) for p in current][:1] if len(current) <= 1 else [Piece(change.label, " ".join(p.text for p in current))]


def _is_noop(doc: ZoneDocument, change: LabelChange, pieces: Sequence[Sequence[Piece]]) -> bool:
    for i in range(change.first, change.last + 1):
        current = pieces[i]
        if not current:
            if change.label is not None and change.label != doc.lines[i].empty_label:
                return False
            continue
        if change.pieces is not None:
            wanted = [(p.label, _text_key(p.text)) for p in _wanted_pieces(change, doc.lines[i], current)]
            if wanted != [(p.label, _text_key(p.text)) for p in current]:
                return False
        elif any(p.label != change.label for p in current):
            return False
    return True


def atom_labels(doc: ZoneDocument, changes: Sequence[LabelChange]) -> dict[int, str]:
    """
    The new label of the atoms whose lines the changes cover (atom index -> label). Text atoms take
    the label of their piece; an `<lb/>` takes the label of the last text before it in its line.
    """
    labels: dict[int, str] = {}
    for change in changes:
        for i in range(change.first, change.last + 1):
            line = doc.lines[i]
            chars = [a for a in line.atoms if doc.atoms[a].kind == CHAR]
            if change.pieces is not None:
                sequence: list[str] = []
                for label, text in change.pieces:
                    sequence.extend(label for _ in _text_key(text))
                if len(sequence) != len(chars):
                    raise ValueError(f"The pieces of line {i + 1} do not match its text")
                for atom, label in zip(chars, sequence):
                    labels[atom] = label
            else:
                assert change.label is not None
                for atom in chars:
                    labels[atom] = change.label
            last = change.label
            for atom in line.atoms:
                if doc.atoms[atom].kind == CHAR:
                    last = labels[atom]
                elif doc.atoms[atom].kind == LB and last is not None:
                    labels[atom] = last
    return labels


def changed_pieces(doc: ZoneDocument, changes: Sequence[LabelChange]) -> list[list[Piece]]:
    """The pieces of every line after the changes."""
    return doc.line_pieces(atom_labels(doc, changes))


def changes_between(doc: ZoneDocument, target: Sequence[Sequence[Piece]], lines: Iterable[int]) -> list[LabelChange]:
    """
    The changes that turn the document's pieces into `target` on the given lines: ranges of whole
    lines with one label where possible, piece lines otherwise.
    """
    changes: list[LabelChange] = []
    for i in lines:
        current, wanted = doc.lines[i].pieces, target[i]
        if [(p.label, p.text) for p in current] == [(p.label, p.text) for p in wanted]:
            continue
        if len(wanted) == 1:
            label = wanted[0].label
            previous = changes[-1] if changes else None
            if previous is not None and previous.pieces is None and previous.label == label and previous.last == i - 1:
                changes[-1] = LabelChange(previous.first, i, label=label)
            else:
                changes.append(LabelChange(i, i, label=label))
        elif wanted:
            changes.append(LabelChange(i, i, pieces=tuple((p.label, p.text) for p in wanted)))
    return changes


# ── Writing ──────────────────────────────────────────────────────────


def _indent_before(xml: str, position: int) -> str:
    """The whitespace between the line start and `position`, if only whitespace precedes it on its line."""
    line_start = xml.rfind("\n", 0, position) + 1
    prefix = xml[line_start:position]
    return prefix if not prefix.strip() else ""


def apply_labels(xml: str, labels: Sequence[ZoneLabel], changes: Sequence[LabelChange]) -> str:
    """
    The document with the label changes applied: the children of `<text>` are rebuilt where labels
    change. Consecutive text with the same label forms one zone, piece boundaries are mapped to the
    characters of the line, each `<lb/>` stays with the text before it, and the raw XML of the text
    (characters, entity references, `<lb/>`, comments) is kept byte for byte. New zone tags take the
    indentation of the zone tags around them. Parts of `<text>` the changes do not touch keep their
    zones as they are.

    Raises:
        ZoneDocumentError: see :class:`ZoneDocument`.
        ValueError: the pieces of a change do not match the text of its line.
    """
    doc = ZoneDocument(xml, labels)
    new = atom_labels(doc, changes)
    changed = [i for i, label in new.items() if label != doc.atoms[i].label]
    if not changed:
        return xml
    first_item = min(doc.atoms[i].item for i in changed)
    last_item = max(doc.atoms[i].item for i in changed)

    def content_label(atom: int) -> str:
        return new.get(atom, doc.atoms[atom].label)

    def edge_label(item: int, from_start: bool) -> str | None:
        atoms = doc.items[item].atoms if from_start else list(reversed(doc.items[item].atoms))
        return next((content_label(a) for a in atoms if doc.atoms[a].kind in (CHAR, LB)), None)

    # take in neighbouring zones that the region's edge text joins, and the whitespace between
    while True:
        grown = False
        before = first_item - 1
        while before >= 0 and doc.items[before].label == OUTSIDE and edge_label(before, False) is None:
            before -= 1
        if before >= 0 and doc.items[before].label != OUTSIDE and doc.items[before].label == edge_label(first_item, True):
            first_item, grown = before, True
        after = last_item + 1
        while after < len(doc.items) and doc.items[after].label == OUTSIDE and edge_label(after, True) is None:
            after += 1
        if after < len(doc.items) and doc.items[after].label != OUTSIDE and doc.items[after].label == edge_label(last_item, False):
            last_item, grown = after, True
        if not grown:
            break

    region = doc.items[first_item:last_item + 1]
    atoms = [a for item in region for a in item.atoms]
    kinds = [doc.atoms[a].kind for a in atoms]
    result: list[str | None] = [content_label(a) if kinds[k] in (CHAR, LB) else None for k, a in enumerate(atoms)]
    # an <lb/> stays with the text before it in its line
    last_char_label: dict[int, str] = {}
    for k, a in enumerate(atoms):
        if kinds[k] == CHAR:
            last_char_label[doc.atoms[a].line] = content_label(a)
        elif kinds[k] == LB and doc.atoms[a].line in last_char_label:
            result[k] = last_char_label[doc.atoms[a].line]
    # whitespace and comments: between text of one label they are part of its zone; at a boundary
    # they stay in the zone they were in if that zone continues on either side, else outside
    # whitespace between zones that ends up inside a zone after a line end is indentation: it is dropped
    content = [k for k in range(len(atoms)) if result[k] is not None]
    dropped: set[int] = set()
    for k in range(len(atoms)):
        if result[k] is not None:
            continue
        before = next((j for j in reversed(content) if j < k), None)
        prev = result[before] if before is not None else None
        nxt = next((result[j] for j in content if j > k), None)
        old = doc.atoms[atoms[k]].label
        if prev is not None and prev == nxt:
            result[k] = prev
            if old == OUTSIDE and prev != OUTSIDE and kinds[k] == SPACE and before is not None and kinds[before] == LB:
                dropped.add(k)
        elif old in (prev, nxt):
            result[k] = old
        else:
            result[k] = OUTSIDE

    zone_items = [item for item in region if item.label != OUTSIDE]
    indent = _indent_before(xml, zone_items[0].start) if zone_items else ""
    open_tags: dict[str, tuple[str, str]] = {}
    for item in zone_items:
        open_tags.setdefault(item.label, (item.open_tag, item.element))

    def tags(code: str) -> tuple[str, str]:
        if code in open_tags:
            return open_tags[code]
        label = doc.by_code.get(code)
        if label is not None:
            return label.open_tag(), label.element
        if code in doc.unknown:
            return doc.unknown[code]
        raise ValueError(f"Unknown zone label {code!r}")

    out: list[str] = []
    current = OUTSIDE
    closed_after_lb = False
    previous_content_kind: str | None = None
    for k, a in enumerate(atoms):
        label = result[k]
        assert label is not None
        if label != current:
            if current != OUTSIDE:
                out.append(f"</{tags(current)[1]}>")
                closed_after_lb = previous_content_kind == LB
            if label != OUTSIDE:
                if out and closed_after_lb and out[-1].startswith("</"):
                    out.append("\n" + indent)
                out.append(tags(label)[0])
            current = label
        atom = doc.atoms[a]
        if k in dropped:
            continue
        out.append(xml[atom.start:atom.end])
        if atom.kind in (CHAR, LB):
            previous_content_kind = atom.kind
        if label == OUTSIDE:
            closed_after_lb = False
    if current != OUTSIDE:
        out.append(f"</{tags(current)[1]}>")
    return xml[:region[0].start] + "".join(out) + xml[region[-1].end:]
