"""
Read the invisible text layer that OCRmyPDF writes (`3 Tr` text in Identity-H fonts) as words,
each with the location of the `Tj`/`TJ` operator that shows it, and patch the text of such words.

For the LLM review of OCR errors (#931), the words are grouped into lines (one text object per line).
"""

import importlib.util
import io
import zlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from functools import cache
from pathlib import Path

import pikepdf
from fontTools.ttLib import TTFont  # type: ignore[import-untyped]
from pdfminer.cmapdb import CMapParser, FileUnicodeMap

REASON_NO_LAYER = "no OCR text layer"
REASON_VISIBLE = "visible text"
REASON_NO_TOUNICODE = "font without ToUnicode"
REASON_NOT_IDENTITY = "font is not Identity-H"
REASON_NOT_ADDRESSABLE = "text layer not addressable"
REASON_ODD_STRING = "text string with an odd number of bytes"

TEXT_OPERATORS = ("Tj", "TJ", "'", '"')
DEFAULT_SCALE = 100  # horizontal scaling (Tz) at the start of a page
INVISIBLE = 3  # text rendering mode of the OCR text layer

Operand = pikepdf.Object | int | Decimal
Location = tuple[int, int]  # (object number of the content stream, operator index)


@dataclass(frozen=True)
class LayerWord:
    """A word of the text layer, located by content stream, operator and code range."""

    page: int
    stream: int  # object number of the content stream (page content or Form XObject)
    op_index: int  # index of the operator in pikepdf.parse_content_stream() of that stream
    start: int  # code index (not byte) of the first character within the operator's string
    end: int  # code index after the last character; for TJ counted across the string elements
    text: str
    line: int  # index of the text object (BT … ET) on the page in drawing order; OCRmyPDF writes one per line


@dataclass
class LayerPage:
    """The words of one page, or the reason why the page cannot be patched."""

    index: int
    words: list[LayerWord] = field(default_factory=list)
    unpatchable: str | None = None


def parse_to_unicode(stream: pikepdf.Stream) -> dict[int, str]:
    """Parse a ToUnicode CMap into a mapping from character code to text."""
    unicode_map = FileUnicodeMap()
    CMapParser(unicode_map, io.BytesIO(stream.read_bytes())).run()
    return dict(unicode_map.cid2unichr)


def _resource(resources: pikepdf.Dictionary | None, category: str, name: str) -> pikepdf.Object | None:
    """Return the resource `name` of `category` (e.g. /Font) or None."""
    entries = resources.get(category) if resources is not None else None
    return entries.get(name) if isinstance(entries, pikepdf.Dictionary) else None


def _form(resources: pikepdf.Dictionary | None, name: str) -> pikepdf.Stream | None:
    """Return the Form XObject `name` or None."""
    xobject = _resource(resources, "/XObject", name)
    return xobject if isinstance(xobject, pikepdf.Stream) and xobject.get("/Subtype") == "/Form" else None


def _form_resources(form: pikepdf.Stream, inherited: pikepdf.Dictionary | None) -> pikepdf.Dictionary | None:
    """Return the resources of a Form XObject, which inherits those of its caller when it has none."""
    resources = form.get("/Resources")
    return resources if isinstance(resources, pikepdf.Dictionary) else inherited


def _page_resources(page: pikepdf.Page) -> pikepdf.Dictionary | None:
    """Return the resources of a page."""
    resources = page.obj.get("/Resources")
    return resources if isinstance(resources, pikepdf.Dictionary) else None


def _page_streams(page: pikepdf.Page) -> list[pikepdf.Object]:
    """Return the entries of the /Contents of a page."""
    contents = page.obj.get("/Contents")
    if contents is None:
        return []
    return list(contents) if isinstance(contents, pikepdf.Array) else [contents]


@dataclass
class _Font:
    """A font resource as far as the reader needs it."""

    cmap: dict[int, str] | None
    reason: str | None  # why text in this font cannot be patched


def _load_font(font: pikepdf.Dictionary) -> _Font:
    """Check that a font is an indirect Type0 Identity-H font with a ToUnicode map and parse the map."""
    if font.get("/Subtype") != "/Type0" or font.get("/Encoding") != "/Identity-H":
        return _Font(None, REASON_NOT_IDENTITY)
    if not isinstance(font.get("/ToUnicode"), pikepdf.Stream):
        return _Font(None, REASON_NO_TOUNICODE)
    descendants = font.get("/DescendantFonts")
    if (
        not font.is_indirect
        or not isinstance(descendants, pikepdf.Array)
        or len(descendants) != 1
        or not isinstance(descendants[0], pikepdf.Dictionary)
        or not descendants[0].is_indirect
    ):
        return _Font(None, REASON_NOT_ADDRESSABLE)
    return _Font(parse_to_unicode(font["/ToUnicode"]), None)  # type: ignore[arg-type]  # checked above


def _number(value: pikepdf.Object) -> float | None:
    """Return a numeric operand as float, or None if it is not a number."""
    return float(value) if isinstance(value, (int, float, Decimal)) else None


@dataclass(frozen=True)
class _TextState:
    """The parts of the graphics state that matter for text: font, size, Tz, Tc and Tr."""

    font: pikepdf.Dictionary | None = None
    size: float = 0.0
    scale: Operand = DEFAULT_SCALE  # the Tz operand in effect
    char_spacing: float = 0.0
    render_mode: int = 0

    def key(self) -> tuple[tuple[int, int] | None, float, float, float, int]:
        """Return a comparable identity of the state."""
        font = self.font.objgen if self.font is not None else None
        return (font, self.size, float(self.scale), self.char_spacing, self.render_mode)


class _ContentWalker:
    """
    Walks the content streams of pages with the text-related graphics state: the content streams of a page
    share their state and `q`/`Q` stack, a Form XObject starts in the state of its `Do` and leaves it unchanged.
    Subclasses handle the text operators.
    """

    def walk_page(self, page: pikepdf.Page) -> None:
        """Walk the content streams of a page."""
        state = _TextState()
        stack: list[_TextState] = []
        for stream in _page_streams(page):
            state = self.walk(stream, _page_resources(page), state, stack, ())

    def walk(
        self,
        stream: pikepdf.Object,
        resources: pikepdf.Dictionary | None,
        state: _TextState,
        stack: list[_TextState],
        path: tuple[tuple[int, int], ...],
    ) -> _TextState:
        """Walk one content stream starting in `state` and return the state at its end."""
        if not isinstance(stream, pikepdf.Stream) or stream.objgen == (0, 0):
            self.on_unaddressable()
            return state
        if stream.objgen in path:
            return state
        for op_index, instruction in enumerate(pikepdf.parse_content_stream(stream)):
            operands, name = list(instruction.operands), str(instruction.operator)
            if name == "q":
                stack.append(state)
            elif name == "Q":
                state = stack.pop() if stack else state
            elif name == "Tf" and len(operands) == 2 and (size := _number(operands[1])) is not None:
                font = _resource(resources, "/Font", str(operands[0]))
                state = replace(state, font=font if isinstance(font, pikepdf.Dictionary) else None, size=size)
            elif name == "Tz" and operands and _number(operands[0]) is not None:
                state = replace(state, scale=operands[0])
            elif name == "Tc" and operands and (spacing := _number(operands[0])) is not None:
                state = replace(state, char_spacing=spacing)
            elif name == "Tr" and operands and (mode := _number(operands[0])) is not None:
                state = replace(state, render_mode=int(mode))
            elif name == "Do" and operands:
                form = _form(resources, str(operands[0]))
                if form is not None:
                    self.walk(form, _form_resources(form, resources), state, [], (*path, stream.objgen))
            elif name == "BT":
                self.on_begin_text()
            elif name in TEXT_OPERATORS:
                if name == '"' and len(operands) == 3 and (spacing := _number(operands[1])) is not None:
                    state = replace(state, char_spacing=spacing)
                self.on_text((stream.objgen[0], op_index), name, operands, state)
        return state

    def on_text(self, location: Location, name: str, operands: list[pikepdf.Object], state: _TextState) -> None:
        """Handle a text operator."""

    def on_unaddressable(self) -> None:
        """Handle a content stream that cannot be addressed by object number."""

    def on_begin_text(self) -> None:
        """Handle the start of a text object."""


def _strings(name: str, operands: list[pikepdf.Object]) -> list[bytes] | None:
    """Return the strings a text operator shows, or None if its operands are malformed."""
    if name == "TJ" and operands and isinstance(operands[0], pikepdf.Array):
        return [bytes(item) for item in operands[0] if isinstance(item, pikepdf.String)]
    if name != "TJ" and operands and isinstance(operands[-1], pikepdf.String):
        return [bytes(operands[-1])]
    return None


class _Reader(_ContentWalker):
    """Walks the content streams of one page and collects words."""

    def __init__(self, page_index: int):
        self.result = LayerPage(page_index)
        self.visible = False
        self.font_reason: str | None = None
        self.not_addressable = False
        self.odd_string = False
        self.fonts: dict[tuple[int, int], _Font] = {}
        self.known_words: set[tuple[int, int, int, int]] = set()  # (stream, op_index, start, end)
        self.line = -1  # index of the current text object

    def font_info(self, font: pikepdf.Dictionary | None) -> _Font:
        """Return the parsed font, cached per (indirect) font object."""
        if font is None:
            return _Font(None, REASON_NOT_IDENTITY)
        if not font.is_indirect:
            return _load_font(font)
        if font.objgen not in self.fonts:
            self.fonts[font.objgen] = _load_font(font)
        return self.fonts[font.objgen]

    def on_unaddressable(self) -> None:
        self.not_addressable = True

    def on_begin_text(self) -> None:
        self.line += 1

    def on_text(self, location: Location, name: str, operands: list[pikepdf.Object], state: _TextState) -> None:
        if state.render_mode != INVISIBLE:
            self.visible = True
            return
        font = self.font_info(state.font)
        if font.reason is not None:
            self.font_reason = self.font_reason or font.reason
        else:
            self.add_words(location, name, operands, font.cmap or {})

    def add_words(self, location: Location, name: str, operands: list[pikepdf.Object], cmap: dict[int, str]) -> None:
        """Split the string of a text operator into words at whitespace."""
        strings = _strings(name, operands)
        if strings is None:
            self.not_addressable = True
            return
        if any(len(string) % 2 for string in strings):
            self.odd_string = True
            return
        data = b"".join(strings)
        codes: list[int | None] = [(data[i] << 8) | data[i + 1] for i in range(0, len(data), 2)]
        codes.append(None)
        start: int | None = None
        text = ""
        for position, code in enumerate(codes):
            char = cmap.get(code, "") if code is not None else ""
            if char and not char.isspace():
                if start is None:
                    start = position
                text += char
            elif start is not None:
                key = (location[0], location[1], start, position)
                if key not in self.known_words:  # a Form XObject can be drawn more than once
                    self.known_words.add(key)
                    line = max(self.line, 0)  # text shown outside BT … ET counts to the first text object
                    self.result.words.append(LayerWord(self.result.index, location[0], location[1], start, position, text, line))
                start, text = None, ""


PageCallback = Callable[[int, int], None]
"""`callback(done, total)`: called after each page of a loop over the pages of a document."""


def read_text_layer(pdf: pikepdf.Pdf, on_page: PageCallback | None = None) -> list[LayerPage]:
    """Read the words of the OCR text layer of every page; `on_page` is called after each page."""
    pages: list[LayerPage] = []
    total = len(pdf.pages)
    for index, page in enumerate(pdf.pages):
        reader = _Reader(index)
        reader.walk_page(page)
        if reader.visible:
            reader.result.unpatchable = REASON_VISIBLE
        elif reader.not_addressable:
            reader.result.unpatchable = REASON_NOT_ADDRESSABLE
        elif reader.odd_string:
            reader.result.unpatchable = REASON_ODD_STRING
        elif reader.font_reason:
            reader.result.unpatchable = reader.font_reason
        elif not reader.result.words:
            reader.result.unpatchable = REASON_NO_LAYER
        pages.append(reader.result)
        if on_page is not None:
            on_page(index + 1, total)
    return pages


# --- Patching ---------------------------------------------------------------------------------

MAX_CODE = 0xFFFF
BFCHAR_LIMIT = 100  # entries per beginbfchar section allowed by the CMap specification


@dataclass(frozen=True)
class WordPatch:
    """Replace the text of a word of the text layer with `new_text`."""

    word: LayerWord
    new_text: str


@cache
def _notosans_widths() -> dict[int, int]:
    """Return the advance widths (1/1000 em) of NotoSans-Regular, the font of OCRmyPDF's text layer, by code point."""
    spec = importlib.util.find_spec("ocrmypdf")
    if spec is None or spec.origin is None:
        return {}
    path = Path(spec.origin).parent / "data" / "NotoSans-Regular.ttf"
    if not path.is_file():
        return {}
    font = TTFont(path, lazy=True)
    scale = 1000 / font["head"].unitsPerEm
    metrics = font["hmtx"].metrics
    return {codepoint: round(metrics[glyph][0] * scale) for codepoint, glyph in font.getBestCmap().items()}


def _parse_widths(cid_font: pikepdf.Dictionary) -> dict[int, float]:
    """Parse the /W array of a CIDFont into a mapping from CID to width."""
    widths: dict[int, float] = {}
    items = list(cid_font.get("/W", pikepdf.Array()))
    i = 0
    while i < len(items):
        first = int(items[i])
        if i + 1 < len(items) and isinstance(items[i + 1], pikepdf.Array):
            for offset, width in enumerate(items[i + 1]):
                widths[first + offset] = float(width)
            i += 2
        elif i + 2 < len(items):
            for cid in range(first, int(items[i + 1]) + 1):
                widths[cid] = float(items[i + 2])
            i += 3
        else:
            raise ValueError("malformed /W array")
    return widths


class _FontPatch:
    """The code map and widths of one Type0 font, and the characters that patches add to it."""

    def __init__(self, font: pikepdf.Dictionary, used_codes: set[int]):
        self.font = font
        to_unicode, descendants = font.get("/ToUnicode"), font.get("/DescendantFonts")
        if not isinstance(to_unicode, pikepdf.Stream) or not isinstance(descendants, pikepdf.Array):
            raise ValueError("font is not a Type0 font with ToUnicode")
        cid_font = descendants[0] if len(descendants) == 1 else None
        if not isinstance(cid_font, pikepdf.Dictionary):
            raise ValueError("font without descendant font")
        self.to_unicode: pikepdf.Stream = to_unicode
        self.cid_font: pikepdf.Dictionary = cid_font
        cmap = parse_to_unicode(to_unicode)
        self.codes: dict[str, int] = {}
        for code, text in sorted(cmap.items()):
            if len(text) == 1:
                self.codes.setdefault(text, code)
        self.widths = _parse_widths(self.cid_font)
        self.default_width = float(self.cid_font.get("/DW", 1000))
        # a new code must not be shown anywhere with this font yet, or those places would decode as the new character
        self.next_code = max([*cmap, *self.widths, *used_codes, 0]) + 1
        self.added: list[tuple[int, str, float]] = []

    def width(self, code: int) -> float:
        """Return the width of `code` in 1/1000 text space units."""
        return self.widths.get(code, self.default_width)

    def encode(self, text: str) -> list[int]:
        """Return the codes for `text`, allocating a code for each character the font does not map yet."""
        result: list[int] = []
        for char in text:
            code = self.codes.get(char)
            if code is None:
                if self.next_code > MAX_CODE:
                    raise ValueError("no free character code left in the font")
                code = self.next_code
                self.next_code += 1
                width = float(_notosans_widths().get(ord(char), self.default_width))
                self.codes[char] = code
                self.widths[code] = width
                self.added.append((code, char, width))
            result.append(code)
        return result

    def prepare(self) -> list[tuple[pikepdf.Stream, bytes]]:
        """Return the new data of the ToUnicode and CIDToGIDMap streams; raise ValueError if they cannot be changed."""
        if not self.added:
            return []
        to_unicode = self.to_unicode.read_bytes()
        position = to_unicode.rfind(b"endcmap")
        if position < 0:
            raise ValueError("ToUnicode CMap without endcmap")
        sections = b""
        for i in range(0, len(self.added), BFCHAR_LIMIT):
            chunk = self.added[i : i + BFCHAR_LIMIT]
            lines = "".join(f"<{code:04X}> <{char.encode('utf-16-be').hex().upper()}>\n" for code, char, _ in chunk)
            sections += f"{len(chunk)} beginbfchar\n{lines}endbfchar\n".encode("ascii")
        writes = [(self.to_unicode, to_unicode[:position] + sections + to_unicode[position:])]
        gid_map = self.cid_font.get("/CIDToGIDMap")
        if isinstance(gid_map, pikepdf.Stream):
            data = bytearray(gid_map.read_bytes())
            for code, _, _ in self.added:
                if len(data) < 2 * (code + 1):
                    data.extend(bytes(2 * (code + 1) - len(data)))
                data[2 * code : 2 * code + 2] = b"\x00\x00"
            writes.append((gid_map, bytes(data)))
        return writes

    def apply_widths(self) -> None:
        """Append the widths of the added characters to /W."""
        if not self.added:
            return
        widths = self.cid_font.get("/W")
        if not isinstance(widths, pikepdf.Array):
            widths = self.cid_font["/W"] = pikepdf.Array()
        for code, _, width in self.added:
            widths.append(code)
            widths.append(pikepdf.Array([int(width) if width.is_integer() else Decimal(str(width))]))


class _StateRecorder(_ContentWalker):
    """Records the text state at the operators to patch and the codes shown with each font."""

    def __init__(self, targets: set[Location]):
        self.targets = targets
        self.states: dict[Location, _TextState] = {}
        self.used_codes: dict[tuple[int, int], set[int]] = {}
        self.malformed_fonts: set[tuple[int, int]] = set()
        self.direct_fonts: list[pikepdf.Dictionary] = []

    def on_text(self, location: Location, name: str, operands: list[pikepdf.Object], state: _TextState) -> None:
        if state.font is not None:
            if not state.font.is_indirect:
                self.direct_fonts.append(state.font)
            else:
                strings = _strings(name, operands)
                if strings is None or any(len(string) % 2 for string in strings):
                    self.malformed_fonts.add(state.font.objgen)
                else:
                    self.used_codes.setdefault(state.font.objgen, set()).update(_codes(b"".join(strings)))
        if location in self.targets:
            known = self.states.setdefault(location, state)
            if known.key() != state.key():
                raise ValueError(f"text operator {location[1]} of object {location[0]} is drawn with different text states")


def _references(owner: pikepdf.Dictionary) -> list[tuple[int, int]]:
    """Return the indirect objects a font or CIDFont dictionary uses for its code map and widths."""
    values = [owner.get(key) for key in ("/ToUnicode", "/W", "/CIDToGIDMap")]
    descendants = owner.get("/DescendantFonts")
    if isinstance(descendants, pikepdf.Array):
        values.extend(descendants)
    return [value.objgen for value in values if isinstance(value, pikepdf.Object) and value.is_indirect]


def _check_not_shared(pdf: pikepdf.Pdf, fonts: list["_FontPatch"], direct_fonts: list[pikepdf.Dictionary]) -> None:
    """Refuse to extend a font whose ToUnicode, CIDFont, /W or CIDToGIDMap another font uses too."""
    owned: dict[tuple[int, int], set[tuple[int, int] | None]] = {}  # object -> the font and CIDFont that may use it
    for font in fonts:
        allowed: set[tuple[int, int] | None] = {font.font.objgen, font.cid_font.objgen}
        for objgen in (font.to_unicode.objgen, font.cid_font.objgen, *_references(font.cid_font)):
            owned[objgen] = allowed
    if not owned:
        return
    owners: list[pikepdf.Dictionary] = [obj for obj in pdf.objects if isinstance(obj, pikepdf.Dictionary)]
    for font_dict in direct_fonts:
        owners.append(font_dict)
        descendants = font_dict.get("/DescendantFonts")
        if isinstance(descendants, pikepdf.Array):
            owners.extend(item for item in descendants if isinstance(item, pikepdf.Dictionary) and not item.is_indirect)
    for owner in owners:
        identity = owner.objgen if owner.is_indirect else None
        for objgen in _references(owner):
            if objgen in owned and identity not in owned[objgen]:
                raise ValueError(f"font object {objgen[0]} is shared with another font")


@dataclass(frozen=True)
class _Kern:
    """A number in a TJ array."""

    value: float
    operand: Operand


def _codes(data: bytes) -> list[int]:
    """Split a string of 2-byte codes."""
    if len(data) % 2:
        raise ValueError("text string with an odd number of bytes")
    return [(data[i] << 8) | data[i + 1] for i in range(0, len(data), 2)]


def _to_string(codes: list[int]) -> pikepdf.String:
    """Join 2-byte codes into a string."""
    return pikepdf.String(b"".join(code.to_bytes(2, "big") for code in codes))


def _tokens(name: str, operands: Sequence[pikepdf.Object]) -> list[int | _Kern]:
    """Return the codes (and for TJ the kerning numbers) that a text operator shows."""
    if name != "TJ":
        return list(_codes(bytes(operands[-1])))
    tokens: list[int | _Kern] = []
    for item in operands[0]:
        if isinstance(item, pikepdf.String):
            tokens.extend(_codes(bytes(item)))
        elif isinstance(item, (int, float, Decimal)):
            tokens.append(_Kern(float(item), item))
        else:
            raise ValueError("unexpected element in TJ array")
    return tokens


def _operands(name: str, operands: Sequence[pikepdf.Object], tokens: list[int | _Kern]) -> list[Operand]:
    """Return the operands of a text operator that shows `tokens`."""
    if name != "TJ":
        return [*operands[:-1], _to_string([t for t in tokens if isinstance(t, int)])]
    items: list[Operand] = []
    run: list[int] = []
    for token in tokens:
        if isinstance(token, int):
            run.append(token)
            continue
        if run:
            items.append(_to_string(run))
            run = []
        items.append(token.operand)
    if run:
        items.append(_to_string(run))
    return [pikepdf.Array(items)]


def _width(tokens: list[int | _Kern], font: _FontPatch, state: _TextState) -> float:
    """Return the horizontal displacement of `tokens` in unscaled text space units."""
    width = 0.0
    for token in tokens:
        if isinstance(token, int):
            width += font.width(token) * state.size / 1000 + state.char_spacing
        else:
            width -= token.value * state.size / 1000
    return width


def _quantize(value: float) -> Decimal:
    """Round a number for a content stream."""
    return Decimal(value).quantize(Decimal("0.0001"))


def _patch_operator(
    name: str, operands: Sequence[pikepdf.Object], group: list[WordPatch], font: _FontPatch, state: _TextState
) -> tuple[Decimal, str, list[Operand]]:
    """
    Apply the patches of one text operator (ordered right to left) and return the horizontal scaling to show
    it with, the operator name and its operands.

    The scaling keeps the width of the text up to the end of the last patched word, so that the patched words
    keep their boxes. A TJ kerning number after that word keeps the width of the whole operator; a `Tj` becomes
    a `TJ` for it. `'` and `"` cannot take kerning, so for them the scaling keeps the width of the whole operator.
    """
    tokens = _tokens(name, operands)
    positions = [i for i, token in enumerate(tokens) if isinstance(token, int)]
    if group[0].word.end > len(positions):
        raise ValueError(f"word {group[0].word.text!r} is outside the operator")
    split = positions[group[0].word.end - 1] + 1
    prefix, rest = tokens[:split], tokens[split:]
    old_prefix_width = _width(prefix, font, state)
    for patch in group:
        first, last = positions[patch.word.start], positions[patch.word.end - 1]
        prefix[first : last + 1] = font.encode(patch.new_text)
    new_prefix_width = _width(prefix, font, state)
    rest_width = _width(rest, font, state)
    old_scale = float(state.scale)
    if name not in ("Tj", "TJ") and rest:
        old_width, new_width = old_prefix_width + rest_width, new_prefix_width + rest_width
        if old_width <= 0 or new_width <= 0:
            raise ValueError("cannot keep the width of the operator")
        return _quantize(old_scale * old_width / new_width), name, _operands(name, operands, prefix + rest)
    if old_prefix_width <= 0 or new_prefix_width <= 0 or state.size <= 0:
        raise ValueError("cannot keep the width of the patched words")
    scale = _quantize(old_scale * old_prefix_width / new_prefix_width)
    # with the new scaling, the rest must take the width it had with the old one
    gap = rest_width * (old_scale / float(scale) - 1)
    kern = _quantize(-gap * 1000 / state.size)
    if rest and kern != 0:
        tokens = [*prefix, _Kern(float(kern), kern), *rest]
        return scale, "TJ", _operands("TJ", operands, tokens)
    return scale, name, _operands(name, operands, prefix + rest)


def _validate(pdf: pikepdf.Pdf, patches: Sequence[WordPatch]) -> dict[tuple[int, int], list[WordPatch]]:
    """Check the patches against the current text layer and group them by operator, ordered right to left."""
    pages = read_text_layer(pdf)
    by_location: dict[tuple[int, int, int, int], WordPatch] = {}
    for patch in patches:
        word = patch.word
        if not 0 <= word.page < len(pages):
            raise ValueError(f"no page {word.page + 1}")
        page = pages[word.page]
        if page.unpatchable is not None:
            raise ValueError(f"page {word.page + 1} cannot be patched: {page.unpatchable}")
        if word not in page.words:
            raise ValueError(f"word {word.text!r} on page {word.page + 1} no longer matches the text layer")
        location = (word.stream, word.op_index, word.start, word.end)
        known = by_location.setdefault(location, patch)
        if known.new_text != patch.new_text:
            raise ValueError(f"conflicting patches for word {word.text!r} on page {word.page + 1}")
    by_operator: dict[tuple[int, int], list[WordPatch]] = {}
    for patch in by_location.values():
        by_operator.setdefault((patch.word.stream, patch.word.op_index), []).append(patch)
    for group in by_operator.values():
        group.sort(key=lambda patch: patch.word.start, reverse=True)
        for right, left in zip(group, group[1:]):
            if left.word.end > right.word.start:
                raise ValueError(f"overlapping patches for word {left.word.text!r}")
    return by_operator


def _plan(pdf: pikepdf.Pdf, patches: Sequence[WordPatch]) -> tuple[list[tuple[pikepdf.Stream, bytes]], list[_FontPatch]]:
    """Compute the new data of every stream to change, and the fonts to extend, without changing `pdf`."""
    by_operator = _validate(pdf, patches)
    walker = _StateRecorder(set(by_operator))
    for page in pdf.pages:
        walker.walk_page(page)
    by_stream: dict[int, list[tuple[int, list[WordPatch]]]] = {}
    for (stream_number, op_index), group in by_operator.items():
        by_stream.setdefault(stream_number, []).append((op_index, group))
    fonts: dict[tuple[int, int], _FontPatch] = {}
    stream_writes: list[tuple[pikepdf.Stream, bytes]] = []
    for stream_number, operators in by_stream.items():
        stream = pdf.get_object((stream_number, 0))
        if not isinstance(stream, pikepdf.Stream):
            raise ValueError(f"object {stream_number} is not a content stream")
        instructions: list[pikepdf.ContentStreamInstruction | pikepdf.ContentStreamInlineImage]
        instructions = list(pikepdf.parse_content_stream(stream))
        for op_index, group in sorted(operators, key=lambda item: item[0], reverse=True):
            state = walker.states.get((stream_number, op_index))
            if state is None or state.font is None or not state.font.is_indirect:
                raise ValueError(f"text operator {op_index} of object {stream_number} not reached")
            if state.render_mode != INVISIBLE:
                raise ValueError(f"text operator {op_index} of object {stream_number} shows visible text")
            if state.font.objgen not in fonts:
                fonts[state.font.objgen] = _FontPatch(state.font, walker.used_codes.get(state.font.objgen, set()))
            font = fonts[state.font.objgen]
            instruction = instructions[op_index]
            try:
                scale, name, new_operands = _patch_operator(str(instruction.operator), list(instruction.operands), group, font, state)
            except ValueError as error:
                raise ValueError(f"text operator {op_index} of object {stream_number}: {error}") from error
            instructions[op_index : op_index + 1] = [
                pikepdf.ContentStreamInstruction([scale], pikepdf.Operator("Tz")),
                pikepdf.ContentStreamInstruction(new_operands, pikepdf.Operator(name)),
                pikepdf.ContentStreamInstruction([state.scale], pikepdf.Operator("Tz")),
            ]
        stream_writes.append((stream, pikepdf.unparse_content_stream(instructions)))
    extended = [font for font in fonts.values() if font.added]
    for font in extended:
        if font.font.objgen in walker.malformed_fonts:
            raise ValueError(f"font object {font.font.objgen[0]} is shown with malformed strings, its used codes are unknown")
    _check_not_shared(pdf, extended, walker.direct_fonts)
    font_writes = [write for font in extended for write in font.prepare()]
    return [*stream_writes, *font_writes], extended


def patch_text_layer(pdf: pikepdf.Pdf, patches: Sequence[WordPatch]) -> None:
    """
    Replace the text of words of the OCR text layer in place, keeping the boxes of the patched words and the
    width of each patched operator.

    Characters the font does not map yet get new codes in its ToUnicode CMap and /W array. Nothing is changed
    if any patch cannot be applied.

    Raises:
        ValueError: if a patch does not match the current text layer, is on an unpatchable page, overlaps
            another patch, or the fonts or content streams cannot be changed safely.
    """
    if not patches:
        return
    try:
        writes, fonts = _plan(pdf, patches)
    except pikepdf.PdfError as error:
        raise ValueError(f"cannot patch the text layer: {error}") from error
    for stream, data in writes:
        stream.write(zlib.compress(data), filter=pikepdf.Name.FlateDecode)
    for font in fonts:
        font.apply_widths()


# --- Lines for the LLM review -----------------------------------------------------------------


@dataclass(frozen=True)
class LayerLine:
    """The words of one text object of a page."""

    page: int
    words: list[LayerWord]

    @property
    def text(self) -> str:
        """The words joined by single spaces."""
        return " ".join(word.text for word in self.words)


def layer_lines(page: LayerPage) -> list[LayerLine]:
    """Group the words of a page into lines by their text object, in drawing order."""
    lines: dict[int, list[LayerWord]] = {}
    for word in page.words:
        lines.setdefault(word.line, []).append(word)
    return [LayerLine(page.index, words) for words in lines.values()]
