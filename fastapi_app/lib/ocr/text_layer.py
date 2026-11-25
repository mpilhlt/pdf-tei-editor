"""
Read the invisible text layer that OCRmyPDF writes (`3 Tr` text in Identity-H fonts) as words,
each with the location of the `Tj`/`TJ` operator that shows it, so that words can be patched later.
"""

import io
from dataclasses import dataclass, field

import pikepdf
from pdfminer.cmapdb import CMapParser, FileUnicodeMap

REASON_NO_LAYER = "no OCR text layer"
REASON_VISIBLE = "visible text"
REASON_NO_TOUNICODE = "font without ToUnicode"
REASON_NOT_IDENTITY = "font is not Identity-H"
REASON_NOT_ADDRESSABLE = "text layer not addressable"

TEXT_OPERATORS = ("Tj", "TJ", "'", '"')


@dataclass(frozen=True)
class LayerWord:
    """A word of the text layer, located by content stream, operator and code range."""

    page: int
    stream: int  # object number of the content stream (page content or Form XObject)
    op_index: int  # index of the operator in pikepdf.parse_content_stream() of that stream
    start: int  # code index (not byte) of the first character within the operator's string
    end: int  # code index after the last character; for TJ counted across the string elements
    text: str


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


@dataclass
class _Font:
    """A font resource as far as the reader needs it."""

    cmap: dict[int, str] | None
    reason: str | None  # why text in this font cannot be patched


def _load_font(font: pikepdf.Dictionary | None) -> _Font:
    """Check that a font is Identity-H with a ToUnicode map and parse the map."""
    if font is None or str(font.get("/Encoding", "")) != "/Identity-H":
        return _Font(None, REASON_NOT_IDENTITY)
    if "/ToUnicode" not in font:
        return _Font(None, REASON_NO_TOUNICODE)
    return _Font(parse_to_unicode(font.ToUnicode), None)


class _Reader:
    """Walks the content streams of one page and collects words."""

    def __init__(self, page_index: int):
        self.result = LayerPage(page_index)
        self.visible = False
        self.font_reason: str | None = None
        self.not_addressable = False
        self.seen: set[tuple[int, int]] = set()
        self.fonts: dict[tuple[int, int], _Font] = {}

    def font_for(self, resources: pikepdf.Dictionary | None, name: str) -> _Font:
        """Return the parsed font resource `name`, cached per font object."""
        fonts = resources.get("/Font") if resources is not None else None
        font = fonts.get(name) if fonts is not None else None
        if font is None:
            return _Font(None, REASON_NOT_IDENTITY)
        key = font.objgen if font.is_indirect else (id(font), -1)
        if key not in self.fonts:
            self.fonts[key] = _load_font(font)
        return self.fonts[key]

    def read_stream(self, stream: pikepdf.Stream, resources: pikepdf.Dictionary | None) -> None:
        """Read one content stream and the Form XObjects it draws."""
        if stream.objgen == (0, 0):
            self.not_addressable = True
            return
        if stream.objgen in self.seen:
            return
        self.seen.add(stream.objgen)
        font = _Font(None, REASON_NOT_IDENTITY)
        render_mode = 0
        for op_index, (operands, operator) in enumerate(pikepdf.parse_content_stream(stream)):
            name = str(operator)
            if name == "Tr" and operands:
                render_mode = int(operands[0])
            elif name == "Tf" and operands:
                font = self.font_for(resources, str(operands[0]))
            elif name == "Do" and operands:
                xobjects = resources.get("/XObject") if resources is not None else None
                xobject = xobjects.get(str(operands[0])) if xobjects is not None else None
                if xobject is not None and xobject.get("/Subtype") == "/Form":
                    self.read_stream(xobject, xobject.get("/Resources", resources))
            elif name in TEXT_OPERATORS:
                if render_mode != 3:
                    self.visible = True
                elif font.reason is not None:
                    self.font_reason = self.font_reason or font.reason
                else:
                    self.add_words(stream.objgen[0], op_index, name, operands, font.cmap or {})

    def add_words(self, stream: int, op_index: int, name: str, operands: pikepdf.Array, cmap: dict[int, str]) -> None:
        """Split the string of a text operator into words at whitespace."""
        if name == "TJ":
            strings = [bytes(item) for item in operands[0] if isinstance(item, pikepdf.String)]
        else:
            strings = [bytes(operands[-1])]
        data = b"".join(strings)
        codes: list[int | None] = [(data[i] << 8) | data[i + 1] for i in range(0, len(data) - 1, 2)]
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
                self.result.words.append(LayerWord(self.result.index, stream, op_index, start, position, text))
                start, text = None, ""


def read_text_layer(pdf: pikepdf.Pdf) -> list[LayerPage]:
    """Read the words of the OCR text layer of every page."""
    pages: list[LayerPage] = []
    for index, page in enumerate(pdf.pages):
        reader = _Reader(index)
        contents = page.obj.get("/Contents")
        if contents is not None:
            streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
            for stream in streams:
                reader.read_stream(stream, page.obj.get("/Resources"))
        if reader.visible:
            reader.result.unpatchable = REASON_VISIBLE
        elif reader.not_addressable:
            reader.result.unpatchable = REASON_NOT_ADDRESSABLE
        elif reader.font_reason:
            reader.result.unpatchable = reader.font_reason
        elif not reader.result.words:
            reader.result.unpatchable = REASON_NO_LAYER
        pages.append(reader.result)
    return pages
