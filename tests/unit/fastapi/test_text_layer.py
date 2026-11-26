"""
Unit tests for reading the OCR text layer of a PDF as words.

@testCovers fastapi_app/lib/ocr/text_layer.py
"""

import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Literal

import pdfminer.high_level
import pikepdf
import pymupdf

from fastapi_app.lib.ocr.line_review import LineCorrection
from fastapi_app.lib.ocr.text_layer import (
    LayerLine,
    LayerPage,
    LayerWord,
    WordPatch,
    layer_lines,
    parse_to_unicode,
    patch_text_layer,
    patches_from_corrections,
    read_text_layer,
    review_lines_for_pages,
)
from tests.unit.fastapi.test_ocr import make_image_only_pdf

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = PROJECT_ROOT / "tests" / "unit" / "fastapi" / "fixtures" / "ocr-text-layer.pdf"


def make_digital_pdf(path: Path) -> None:
    """Write a one-page PDF with visible Helvetica text."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = pdf.make_stream(b"BT /F1 12 Tf 20 100 Td (Hello world) Tj ET")
    pdf.save(path)


def to_unicode_cmap(mapping: dict[int, str]) -> bytes:
    """Return a ToUnicode CMap with one bfchar entry per code."""
    entries = "".join(f"<{code:04X}> <{ord(char):04X}>\n" for code, char in mapping.items())
    return f"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
{len(mapping)} beginbfchar
{entries}endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
""".encode("ascii")


SYNTHETIC_TO_UNICODE = to_unicode_cmap({0x20: " ", 0x44: "D", 0x45: "E", 0x46: "F"})
SecondFont = Literal["own", "shared-tounicode", "shared-descendant"]


def make_descendant() -> pikepdf.Dictionary:
    """Return a CIDFontType2 with widths for space (260) and D, E, F (600)."""
    return pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.CIDFontType2,
        BaseFont=pikepdf.Name("/Test"),
        CIDSystemInfo=pikepdf.Dictionary(Registry=pikepdf.String("Adobe"), Ordering=pikepdf.String("UCS"), Supplement=0),
        CIDToGIDMap=pikepdf.Name.Identity,
        DW=1000,
        W=pikepdf.Array([0x20, pikepdf.Array([260]), 0x44, 0x46, 600]),
    )


def make_type0(subtype: str, descendant: pikepdf.Object, to_unicode: pikepdf.Stream) -> pikepdf.Dictionary:
    """Return an Identity-H font dictionary."""
    return pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name(subtype),
        BaseFont=pikepdf.Name("/Test"),
        Encoding=pikepdf.Name("/Identity-H"),
        DescendantFonts=pikepdf.Array([descendant]),
        ToUnicode=to_unicode,
    )


def make_layer_pdf(
    path: Path, content: bytes, subtype: str = "/Type0", indirect: bool = True, second_font: SecondFont | None = None
) -> None:
    """
    Write a one-page PDF whose content is drawn with an Identity-H font /F1 mapping D, E, F and space.
    `second_font` adds a font /F2 that maps <0044> to X, or that shares the ToUnicode or descendant font of /F1.
    """
    pdf = pikepdf.new()
    descendant = make_descendant()
    to_unicode = pdf.make_stream(SYNTHETIC_TO_UNICODE)
    font = make_type0(subtype, pdf.make_indirect(descendant) if indirect else descendant, to_unicode)
    fonts = pikepdf.Dictionary(F1=pdf.make_indirect(font) if indirect else font)
    if second_font is not None:
        other_descendant = fonts.F1.DescendantFonts[0] if second_font == "shared-descendant" else pdf.make_indirect(make_descendant())
        other_to_unicode = to_unicode if second_font == "shared-tounicode" else pdf.make_stream(to_unicode_cmap({0x44: "X"}))
        fonts.F2 = pdf.make_indirect(make_type0(subtype, other_descendant, other_to_unicode))
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = pikepdf.Dictionary(Font=fonts)
    page.Contents = pdf.make_stream(content)
    pdf.save(path)


def add_form(pdf: pikepdf.Pdf, content: bytes) -> pikepdf.Stream:
    """Add the Form XObject /Fm with `content` and the fonts of the first page to the first page."""
    page = pdf.pages[0]
    form = pdf.make_stream(content)
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([0, 0, 200, 200])
    form.Resources = pikepdf.Dictionary(Font=page.Resources.Font)
    page.Resources.XObject = pikepdf.Dictionary(Fm=form)
    return form


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

    def layer(self, content: bytes, **kwargs: str | bool) -> list[LayerPage]:
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

    def test_tr_is_restored_by_q(self):
        page = self.layer(b"q BT 3 Tr /F1 10 Tf <0044> Tj ET Q BT /F1 10 Tf <0045> Tj ET")[0]
        self.assertEqual(page.unpatchable, "visible text")

    def test_font_is_restored_by_q(self):
        content = b"BT /F1 10 Tf ET q BT /F2 10 Tf ET Q BT 3 Tr <0044> Tj ET"
        page = self.layer(content, second_font="own")[0]
        self.assertEqual([w.text for w in page.words], ["D"])

    def test_form_inherits_the_state_of_its_caller(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "form.pdf"
            make_layer_pdf(path, b"BT 3 Tr /F1 10 Tf ET /Fm Do")
            pdf = pikepdf.open(path)
            add_form(pdf, b"BT <0044> Tj ET")
            page = read_text_layer(pdf)[0]
        self.assertIsNone(page.unpatchable)
        self.assertEqual([w.text for w in page.words], ["D"])

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
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

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
        add_form(pdf, b"BT 3 Tr /F1 10 Tf <0044> Tj ET")
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

    def synthetic(self, content: bytes, second_font: SecondFont | None = None) -> pikepdf.Pdf:
        """Open a synthetic one-page PDF with `content`."""
        path = self.tmp / f"synthetic-{len(list(self.tmp.iterdir()))}.pdf"
        make_layer_pdf(path, content, second_font=second_font)
        return pikepdf.open(path)

    def test_visible_text_after_q_is_not_patched(self):
        pdf = self.synthetic(b"q BT 3 Tr /F1 10 Tf <0044> Tj ET Q BT /F1 10 Tf <0045> Tj ET")
        word = LayerWord(0, pdf.pages[0].Contents.objgen[0], 9, 0, 1, "E", 1)  # the second Tj
        before = streams(pdf)
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(word, "DD")])
        self.assertEqual(streams(pdf), before)

    def test_patch_uses_the_font_restored_by_q(self):
        pdf = self.synthetic(b"BT /F1 10 Tf ET q BT /F2 10 Tf ET Q BT 3 Tr <0044> Tj ET", second_font="own")
        patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "DΩ")])
        f1, f2 = pdf.pages[0].Resources.Font.F1, pdf.pages[0].Resources.Font.F2
        self.assertIn("Ω", parse_to_unicode(f1.ToUnicode).values())
        self.assertNotIn("Ω", parse_to_unicode(f2.ToUnicode).values())
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words], ["DΩ"])

    def test_shared_tounicode_is_not_extended(self):
        pdf = self.synthetic(b"BT 3 Tr /F1 10 Tf <0044> Tj ET", second_font="shared-tounicode")
        before = streams(pdf)
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "Ω")])
        self.assertEqual(streams(pdf), before)

    def test_shared_descendant_font_is_not_extended(self):
        pdf = self.synthetic(b"BT 3 Tr /F1 10 Tf <0044> Tj ET", second_font="shared-descendant")
        with self.assertRaises(ValueError):
            patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "Ω")])

    def test_shared_font_is_fine_without_new_characters(self):
        pdf = self.synthetic(b"BT 3 Tr /F1 10 Tf <0044> Tj ET", second_font="shared-tounicode")
        patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "EF")])
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words], ["EF"])

    def test_new_code_is_not_used_in_the_content_yet(self):
        # <0047> is in neither ToUnicode nor /W, but shown with /F1: it must not become the code of the new character
        pdf = self.synthetic(b"BT 3 Tr /F1 10 Tf <0044 0020 0047> Tj ET")
        patch_text_layer(pdf, [WordPatch(read_text_layer(pdf)[0].words[0], "Ω")])
        cmap = parse_to_unicode(pdf.pages[0].Resources.Font.F1.ToUnicode)
        self.assertNotIn(0x47, cmap)
        self.assertEqual(cmap[0x48], "Ω")
        self.assertEqual([w.text for w in read_text_layer(pdf)[0].words], ["Ω"])


FIRST_LINE = "Die Gesellschaft haftet nach der neuen Regel’). Weitere Ausführungen"


def fixture_page(index: int) -> LayerPage:
    """Return the words of the fixture's page as page `index`."""
    page = read_text_layer(pikepdf.open(FIXTURE))[0]
    return LayerPage(index, [replace(word, page=index) for word in page.words], page.unpatchable)


class TestLayerLines(unittest.TestCase):
    def setUp(self):
        self.page = read_text_layer(pikepdf.open(FIXTURE))[0]
        self.lines = layer_lines(self.page)

    def test_words_carry_line_index(self):
        count = len(FIRST_LINE.split())
        self.assertEqual([w.line for w in self.page.words[:count]], [0] * count)
        self.assertEqual(self.page.words[count].line, 1)

    def test_layer_lines_text(self):
        self.assertEqual(self.lines[0].text, FIRST_LINE)
        self.assertEqual(self.lines[0].page, 0)
        self.assertEqual(len(self.lines), 9)
        self.assertEqual([w for line in self.lines for w in line.words], self.page.words)

    def test_line_of_a_form_drawn_twice_is_read_once(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        path = tmp / "form.pdf"
        make_layer_pdf(path, b"/Fm Do /Fm Do")
        pdf = pikepdf.open(path)
        add_form(pdf, b"BT 3 Tr /F1 10 Tf <0044> Tj ET BT 3 Tr /F1 10 Tf <0045> Tj ET")
        lines = layer_lines(read_text_layer(pdf)[0])
        self.assertEqual([line.text for line in lines], ["D", "E"])

    def test_review_lines_windows_split_on_gaps(self):
        pages = [fixture_page(i) for i in range(4)]
        review, lines = review_lines_for_pages(pages, [0, 1, 3], ["de"])
        per_page = len(self.lines)
        self.assertEqual(len(review.texts), 3 * per_page)
        self.assertEqual(review.texts[per_page], FIRST_LINE)
        self.assertEqual(review.windows, [range(0, 2 * per_page), range(2 * per_page, 3 * per_page)])
        self.assertEqual({lines[i].page for i in review.windows[0]}, {0, 1})
        self.assertEqual({lines[i].page for i in review.windows[1]}, {3})
        self.assertEqual(review.languages, ["de"])

    def test_review_lines_windows_hold_at_most_two_pages(self):
        pages = [fixture_page(i) for i in range(3)]
        review, lines = review_lines_for_pages(pages, [0, 1, 2], [])
        self.assertEqual([sorted({lines[i].page for i in w}) for w in review.windows], [[0, 1], [2]])

    def test_patch_from_whole_word_correction(self):
        patches, dropped = patches_from_corrections(self.lines, [LineCorrection(0, "Regel’).", "Regel12).", "")])
        word = next(w for w in self.page.words if w.text == "Regel’).")
        self.assertEqual(patches, [WordPatch(word, "Regel12).")])
        self.assertEqual(dropped, [])

    def test_partial_word_correction_dropped(self):
        patches, dropped = patches_from_corrections(self.lines, [LineCorrection(0, "egel’)", "egel12)", "")])
        self.assertEqual(patches, [])
        self.assertEqual(len(dropped), 1)
        self.assertIn("not whole words", dropped[0])

    def test_correction_occurring_twice_dropped(self):
        line = LayerLine(0, [LayerWord(0, 1, 0, i * 4, i * 4 + 3, w, 0) for i, w in enumerate("der und der".split())])
        patches, dropped = patches_from_corrections([line], [LineCorrection(0, "der", "den", "")])
        self.assertEqual(patches, [])
        self.assertIn("not whole words", dropped[0])

    def test_multi_word_correction_patches_only_changed_words(self):
        correction = LineCorrection(0, "neuen Regel’). Weitere", "neuen Regel12). Weitere", "")
        patches, dropped = patches_from_corrections(self.lines, [correction])
        self.assertEqual([(p.word.text, p.new_text) for p in patches], [("Regel’).", "Regel12).")])
        self.assertEqual(dropped, [])

    def test_conflicting_correction_dropped(self):
        corrections = [
            LineCorrection(0, "Regel’).", "Regel12).", ""),
            LineCorrection(0, "Regel’).", "Regel12).", ""),
            LineCorrection(0, "neuen Regel’).", "neuen Regel13).", ""),
        ]
        patches, dropped = patches_from_corrections(self.lines, corrections)
        self.assertEqual([p.new_text for p in patches], ["Regel12)."])
        self.assertEqual(len(dropped), 1)
        self.assertIn("conflicts", dropped[0])

    def test_patches_apply_to_the_fixture(self):
        patches, _ = patches_from_corrections(self.lines, [LineCorrection(0, "Regel’).", "Regel12).", "")])
        pdf = pikepdf.open(FIXTURE)
        patch_text_layer(pdf, patches)
        self.assertIn("Regel12).", [w.text for w in read_text_layer(pdf)[0].words])


if __name__ == "__main__":
    unittest.main()
