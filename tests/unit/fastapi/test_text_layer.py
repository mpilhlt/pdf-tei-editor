"""
Unit tests for reading the OCR text layer of a PDF as words.

@testCovers fastapi_app/lib/ocr/text_layer.py
"""

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import pdfminer.high_level
import pikepdf
import pymupdf

from fastapi_app.lib.ocr.text_layer import LayerWord, WordPatch, parse_to_unicode, patch_text_layer, read_text_layer
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
            font = xobject.Resources.Font.F1
            assert isinstance(font, pikepdf.Dictionary)
            return font
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


def streams(pdf: pikepdf.Pdf) -> dict[int, bytes]:
    """Return the decoded data of every decodable stream by object number."""
    result: dict[int, bytes] = {}
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Stream):
            try:
                result[obj.objgen[0]] = obj.read_bytes()
            except pikepdf.PdfError:
                result[obj.objgen[0]] = obj.read_raw_bytes()
    return result


def find_word(pdf: pikepdf.Pdf, text: str) -> LayerWord:
    """Return the first word of the text layer with `text`."""
    for page in read_text_layer(pdf):
        for word in page.words:
            if word.text == text:
                return word
    raise AssertionError(f"word {text!r} not found")


def word_box(path: Path, text: str) -> pymupdf.Rect:
    """Return the box of the first word `text` that PyMuPDF extracts from the first page."""
    for word in pymupdf.open(path)[0].get_text("words"):
        if word[4] == text:
            return pymupdf.Rect(word[:4])
    raise AssertionError(f"word {text!r} not extracted")


def char_end(path: Path, text: str) -> float:
    """Return the right edge of the last character of the first occurrence of `text` in the spans of the first page."""
    for block in pymupdf.open(path)[0].get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                chars = span["chars"]
                joined = "".join(char["c"] for char in chars)
                if text in joined:
                    return chars[joined.index(text) + len(text) - 1]["bbox"][2]
    raise AssertionError(f"text {text!r} not extracted")


class TestPatchTextLayer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def patched(self, source: Path, replacements: dict[str, str]) -> Path:
        """Patch the words with the given texts and save the result."""
        pdf = pikepdf.open(source)
        patch_text_layer(pdf, [WordPatch(find_word(pdf, old), new) for old, new in replacements.items()])
        out = self.tmp / f"patched-{len(list(self.tmp.iterdir()))}.pdf"
        pdf.save(out)
        return out

    def test_round_trip_without_patches(self):
        pdf = pikepdf.open(FIXTURE)
        before = streams(pdf)
        patch_text_layer(pdf, [])
        self.assertEqual(streams(pdf), before)

    def test_patched_word_is_extracted(self):
        out = self.patched(FIXTURE, {"Regel’).": "Regel12)."})
        self.assertIn("neuen Regel12). Weitere", pymupdf.open(out)[0].get_text())
        self.assertIn("neuen Regel12). Weitere", pdfminer.high_level.extract_text(out))

    def test_patched_word_keeps_its_width(self):
        out = self.patched(FIXTURE, {"Regel’).": "Regel12)."})
        old = word_box(FIXTURE, "Regel’).")
        new = word_box(out, "Regel12).")
        self.assertAlmostEqual(old.x0, new.x0, delta=0.5)
        self.assertAlmostEqual(old.x1, new.x1, delta=0.5)

    def test_patched_operator_keeps_its_width(self):
        out = self.patched(FIXTURE, {"Regel’).": "Regel12)."})
        self.assertAlmostEqual(char_end(FIXTURE, "Regel’). "), char_end(out, "Regel12). "), delta=0.01)

    def test_quote_operator_keeps_the_width_of_the_whole_operator(self):
        path = self.tmp / "quote.pdf"
        make_layer_pdf(path, b"BT 3 Tr /F1 10 Tf 12 TL <0044 0020 0045> ' ET")
        pdf = pikepdf.open(path)
        patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "DD")])
        instructions = pikepdf.parse_content_stream(pdf.pages[0].Contents)
        self.assertEqual([str(op) for _, op in instructions[4:7]], ["Tz", "'", "Tz"])
        self.assertAlmostEqual(float(instructions[4][0][0]), 100 * 1460 / 2060, places=3)
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words], ["DD", "E"])

    def test_following_words_keep_their_position(self):
        out = self.patched(FIXTURE, {"Regel’).": "R)."})
        old = word_box(FIXTURE, "Weitere")
        new = word_box(out, "Weitere")
        self.assertAlmostEqual(old.x0, new.x0, delta=0.01)

    def test_new_character_is_added_to_tounicode(self):
        out = self.patched(FIXTURE, {"Regel’).": "RegelΩ12)."})
        self.assertIn("RegelΩ12).", pymupdf.open(out)[0].get_text())
        self.assertIn("RegelΩ12).", pdfminer.high_level.extract_text(out))
        self.assertEqual(find_word(pikepdf.open(out), "RegelΩ12).").text, "RegelΩ12).")

    def test_character_missing_in_notosans_uses_dw(self):
        out = self.patched(FIXTURE, {"Regel’).": "Regel中)."})
        self.assertIn("Regel中).", pymupdf.open(out)[0].get_text())
        pdf = pikepdf.open(out)
        font = ocr_font(pdf)
        cmap = parse_to_unicode(font.ToUnicode)
        code = next(c for c, t in cmap.items() if t == "中")
        widths = list(font.DescendantFonts[0].W)
        self.assertEqual(widths[-2:], [code, [600]])

    def test_new_character_maps_to_gid_0(self):
        out = self.patched(FIXTURE, {"Regel’).": "RegelΩ)."})
        pdf = pikepdf.open(out)
        font = ocr_font(pdf)
        code = next(c for c, t in parse_to_unicode(font.ToUnicode).items() if t == "Ω")
        data = font.DescendantFonts[0].CIDToGIDMap.read_bytes()
        self.assertEqual(data[code * 2 : code * 2 + 2], b"\x00\x00")

    def test_same_new_character_is_allocated_once(self):
        pdf = pikepdf.open(FIXTURE)
        words = read_text_layer(pdf)[0].words
        patch_text_layer(pdf, [WordPatch(words[0], "ΩΩ"), WordPatch(words[1], "Ω")])
        cmap = parse_to_unicode(ocr_font(pdf).ToUnicode)
        self.assertEqual([t for t in cmap.values()].count("Ω"), 1)
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words[:2]], ["ΩΩ", "Ω"])

    def test_tz_is_wrapped_around_the_operator(self):
        pdf = pikepdf.open(FIXTURE)
        word = find_word(pdf, "Regel’).")
        operands_before = list(pikepdf.parse_content_stream(pdf.get_object((word.stream, 0)))[word.op_index - 1][0])
        patch_text_layer(pdf, [WordPatch(word, "Regel12).")])
        instructions = pikepdf.parse_content_stream(pdf.get_object((word.stream, 0)))
        self.assertEqual(str(instructions[word.op_index - 1][1]), "Tz")  # the word's own Tz
        self.assertEqual([str(i[1]) for i in instructions[word.op_index : word.op_index + 3]], ["Tz", "TJ", "Tz"])
        self.assertEqual(list(instructions[word.op_index + 2][0]), operands_before)

    def test_tj_patch_spanning_string_elements(self):
        path = self.tmp / "tj.pdf"
        make_layer_pdf(path, b"BT 3 Tr /F1 10 Tf 50 Tz [<0044> -20 <0045 0020 0046>] TJ ET")
        pdf = pikepdf.open(path)
        word = read_text_layer(pdf)[0].words[0]
        patch_text_layer(pdf, [WordPatch(word, "F")])
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words], ["F", "F"])
        instructions = pikepdf.parse_content_stream(pdf.pages[0].Contents)
        (scale,), _ = instructions[4]
        (array,), _ = instructions[5]
        strings = [bytes(x) for x in array if isinstance(x, pikepdf.String)]
        self.assertEqual(strings, [b"\x00F", b"\x00 \x00F"])
        # the word keeps its width: old 600 + 20 + 600, new 600 (1/1000 of the font size 10)
        self.assertAlmostEqual(float(scale), 50 * 1220 / 600, places=3)
        # the kerning after the word keeps the width of the operator: old 50 * (12.2 + 8.6)
        kern = float(array[1])
        self.assertAlmostEqual(float(scale) * (6.0 + 8.6 - kern * 10 / 1000), 50 * (12.2 + 8.6), places=2)
        self.assertEqual(float(instructions[6][0][0]), 50)

    def test_several_patches_in_one_operator(self):
        path = self.tmp / "tj.pdf"
        make_layer_pdf(path, b"BT 3 Tr /F1 10 Tf <0044 0020 0045 0020 0046> Tj ET")
        pdf = pikepdf.open(path)
        words = read_text_layer(pdf)[0].words
        patch_text_layer(pdf, [WordPatch(words[0], "EE"), WordPatch(words[2], "DD")])
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words], ["EE", "E", "DD"])

    def test_stale_patch_is_rejected(self):
        pdf = pikepdf.open(FIXTURE)
        word = find_word(pdf, "Regel’).")
        before = streams(pdf)
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(word, "x"), WordPatch(replace(word, text="other"), "x")])
        self.assertEqual(streams(pdf), before)

    def test_overlapping_patches_are_rejected(self):
        pdf = pikepdf.open(FIXTURE)
        word = find_word(pdf, "Regel’).")
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(word, "x"), WordPatch(word, "y")])

    def test_patch_on_unpatchable_page_is_rejected(self):
        path = self.tmp / "visible.pdf"
        make_layer_pdf(path, b"BT 3 Tr /F1 10 Tf <0044> Tj ET BT 0 Tr /F1 10 Tf <0045> Tj ET")
        pdf = pikepdf.open(path)
        page = read_text_layer(pdf)[0]
        self.assertEqual(page.unpatchable, "visible text")
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(page.words[0], "E")])

    def test_state_is_tracked_across_content_streams(self):
        path = self.tmp / "streams.pdf"
        make_layer_pdf(path, b"BT 3 Tr /F1 10 Tf <0044> Tj ET")
        pdf = pikepdf.open(path)
        page = pdf.pages[0]
        page.Contents = pikepdf.Array([pdf.make_stream(b"60 Tz"), page.Contents])
        patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "DD")])
        instructions = pikepdf.parse_content_stream(page.Contents[1])
        self.assertEqual([str(op) for _, op in instructions], ["BT", "Tr", "Tf", "Tz", "Tj", "Tz", "ET"])
        self.assertAlmostEqual(float(instructions[3][0][0]), 30)
        self.assertEqual(float(instructions[5][0][0]), 60)
        self.assertEqual(read_text_layer(pdf)[0].words[0].text, "DD")

    def form_pdf(self, page_content: bytes) -> pikepdf.Pdf:
        """Return a PDF whose page draws the Form XObject /Fm, which shows "D" with the invisible font."""
        path = self.tmp / "form.pdf"
        make_layer_pdf(path, page_content)
        pdf = pikepdf.open(path)
        page = pdf.pages[0]
        form = pdf.make_stream(b"BT 3 Tr /F1 10 Tf <0044> Tj ET")
        form.Type = pikepdf.Name.XObject
        form.Subtype = pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 200, 200])
        form.Resources = pikepdf.Dictionary(Font=page.Resources.Font)
        page.Resources.XObject = pikepdf.Dictionary(Fm=form)
        return pdf

    def test_form_drawn_twice_with_the_same_state(self):
        pdf = self.form_pdf(b"60 Tz /Fm Do /Fm Do")
        patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "E")])
        self.assertEqual(read_text_layer(pdf)[0].words[0].text, "E")

    def test_form_drawn_with_different_state_is_rejected(self):
        pdf = self.form_pdf(b"60 Tz /Fm Do 80 Tz /Fm Do")
        before = streams(pdf)
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "E")])
        self.assertEqual(streams(pdf), before)

if __name__ == "__main__":
    unittest.main()
