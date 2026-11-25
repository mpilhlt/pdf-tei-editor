"""
Unit tests for reading the OCR text layer of a PDF as words.

@testCovers fastapi_app/lib/ocr/text_layer.py
"""

import tempfile
import unittest
from pathlib import Path

import pikepdf

from fastapi_app.lib.ocr.text_layer import parse_to_unicode, read_text_layer
from tests.unit.fastapi.test_ocr import make_image_only_pdf

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = PROJECT_ROOT / "fastapi_app" / "plugins" / "ocrmypdf" / "tests" / "fixtures" / "ocr-text-layer.pdf"


def make_digital_pdf(path: Path) -> None:
    """Write a one-page PDF with visible Helvetica text."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = pdf.make_stream(b"BT /F1 12 Tf 20 100 Td (Hello world) Tj ET")
    pdf.save(path)


SYNTHETIC_TO_UNICODE = b"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
4 beginbfchar
<0020> <0020>
<0044> <0044>
<0045> <0045>
<0046> <0046>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"""


def make_layer_pdf(path: Path, content: bytes, subtype: str = "/Type0", indirect: bool = True) -> None:
    """Write a one-page PDF whose content is drawn with an invisible Identity-H font mapping D, E, F and space."""
    pdf = pikepdf.new()
    descendant = pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.CIDFontType2,
        BaseFont=pikepdf.Name("/Test"),
        CIDSystemInfo=pikepdf.Dictionary(Registry=pikepdf.String("Adobe"), Ordering=pikepdf.String("UCS"), Supplement=0),
        CIDToGIDMap=pikepdf.Name.Identity,
        DW=1000,
        W=pikepdf.Array([0x20, pikepdf.Array([260]), 0x44, 0x46, 600]),
    )
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name(subtype),
        BaseFont=pikepdf.Name("/Test"),
        Encoding=pikepdf.Name("/Identity-H"),
        DescendantFonts=pikepdf.Array([pdf.make_indirect(descendant) if indirect else descendant]),
        ToUnicode=pdf.make_stream(SYNTHETIC_TO_UNICODE),
    )
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font) if indirect else font))
    page.Contents = pdf.make_stream(content)
    pdf.save(path)


def ocr_font(pdf: pikepdf.Pdf) -> pikepdf.Dictionary:
    """Return the font /F1 of the OCR Form XObject of the first page."""
    for name, xobject in pdf.pages[0].Resources.XObject.items():
        if name.startswith("/OCR"):
            return xobject.Resources.Font.F1
    raise AssertionError("no OCR form")


class TestTextLayer(unittest.TestCase):
    def test_reads_words_in_content_order(self):
        pages = read_text_layer(pikepdf.open(FIXTURE))
        words = [w.text for w in pages[0].words]
        self.assertEqual(words[:7], ["Die", "Gesellschaft", "haftet", "nach", "der", "neuen", "Regel’)."])
        self.assertIsNone(pages[0].unpatchable)

    def test_word_location_points_at_tj(self):
        word = read_text_layer(pikepdf.open(FIXTURE))[0].words[6]
        pdf = pikepdf.open(FIXTURE)
        stream = pdf.get_object((word.stream, 0))
        operands, op = pikepdf.parse_content_stream(stream)[word.op_index]
        self.assertEqual(str(op), "Tj")
        self.assertEqual(word.end - word.start, len(word.text))

    def test_word_codes_decode_to_text(self):
        word = read_text_layer(pikepdf.open(FIXTURE))[0].words[1]
        pdf = pikepdf.open(FIXTURE)
        stream = pdf.get_object((word.stream, 0))
        operands, _ = pikepdf.parse_content_stream(stream)[word.op_index]
        data = bytes(operands[-1])
        cmap = parse_to_unicode(ocr_font(pdf).ToUnicode)
        codes = [(data[i] << 8) | data[i + 1] for i in range(word.start * 2, word.end * 2, 2)]
        self.assertEqual("".join(cmap[c] for c in codes), word.text)

    def test_page_without_text_layer(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.pdf"
            make_image_only_pdf(path)
            self.assertEqual(read_text_layer(pikepdf.open(path))[0].unpatchable, "no OCR text layer")

    def test_visible_text_is_unpatchable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "digital.pdf"
            make_digital_pdf(path)
            self.assertEqual(read_text_layer(pikepdf.open(path))[0].unpatchable, "visible text")


    def layer(self, content: bytes, **kwargs: str | bool) -> list:
        """Read the text layer of a synthetic one-page PDF with `content`."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "layer.pdf"
            make_layer_pdf(path, content, **kwargs)  # type: ignore[arg-type]
            return read_text_layer(pikepdf.open(path))

    def test_tj_words_span_string_elements(self):
        page = self.layer(b"BT 3 Tr /F1 10 Tf [<0044> -20 <0045 0020 0046>] TJ ET")[0]
        self.assertIsNone(page.unpatchable)
        self.assertEqual([(w.op_index, w.start, w.end, w.text) for w in page.words], [(3, 0, 2, "DE"), (3, 3, 4, "F")])

    def test_odd_length_string_is_unpatchable(self):
        page = self.layer(b"BT 3 Tr /F1 10 Tf [<0044> -20 <0045 00>] TJ ET")[0]
        self.assertEqual(page.unpatchable, "text string with an odd number of bytes")
        self.assertEqual(page.words, [])

    def test_font_must_be_type0(self):
        page = self.layer(b"BT 3 Tr /F1 10 Tf <0044> Tj ET", subtype="/TrueType")[0]
        self.assertEqual(page.unpatchable, "font is not Identity-H")

    def test_direct_font_is_unpatchable(self):
        page = self.layer(b"BT 3 Tr /F1 10 Tf <0044> Tj ET", indirect=False)[0]
        self.assertEqual(page.unpatchable, "text layer not addressable")


if __name__ == "__main__":
    unittest.main()
