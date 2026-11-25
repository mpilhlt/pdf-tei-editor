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


if __name__ == "__main__":
    unittest.main()
