"""
Unit tests for the repair of misrecognized footnote markers (#904).

The cases of the sequence fit are taken from the footnote numbers that Tesseract read in the
example document of the issue (`13) 14) 15) 116) 17) 18)` for 113-118, `3) 4)` for 93 and 94).

@testCovers fastapi_app/plugins/ocrmypdf/footnote_markers.py
"""

import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from lxml import etree
from PIL import Image

from fastapi_app.plugins.ocrmypdf.engine import OcrmypdfEngine
from fastapi_app.plugins.ocrmypdf.footnote_markers import (
    FootnoteStart,
    LineGeometry,
    MarkerCandidate,
    MarkerRepair,
    PageAnalysis,
    analyze_page,
    apply_repairs,
    fit_footnote_numbers,
    fit_footnote_starts,
    plan_repairs,
    raised_region,
    split_leading_marker,
    split_marker,
    split_standalone_marker,
    split_trailing_marker,
)

FIXTURES = Path(__file__).parent / "fixtures"
"""Fixture PDFs, created by fixtures/make_fixtures.py."""


def starts(*numbers: str) -> list[FootnoteStart]:
    """Footnote starts read as `<number>)`."""
    return [FootnoteStart(number, True) for number in numbers]


def candidate(word_id: str, text: str, *readings: str) -> MarkerCandidate:
    """A marker candidate with second-pass readings."""
    parts = split_marker(text)
    assert parts is not None, text
    return MarkerCandidate(word_id, text, *parts, readings=list(readings))


def plain_candidate(word_id: str, text: str, *readings: str) -> MarkerCandidate:
    """A raised marker candidate without parenthesis, with second-pass readings."""
    parts = split_trailing_marker(text)
    assert parts is not None, text
    return MarkerCandidate(word_id, text, *parts, readings=list(readings), strict=True)


def recovered(word_id: str, text: str, marker: str, *readings: str) -> FootnoteStart:
    """A misrecognized superscript footnote number that was read again."""
    return FootnoteStart("", False, list(readings), word_id, text, marker)


HOCR = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><body><div class='ocr_page' title='bbox 0 0 1000 1000'>
<span class='ocr_line' title='bbox 0 0 1000 50'>
<span class='ocrx_word' id='word_1_1' title='bbox 0 0 100 50'>das</span>
<span class='ocrx_word' id='word_1_2' title='bbox 120 0 300 50'>tut?!?)</span>
<span class='ocrx_word' id='word_1_3' title='bbox 320 0 500 50'>(Hgg.),</span>
</span>
<span class='ocr_line' title='bbox 0 900 1000 950'>
<span class='ocrx_word' id='word_1_4' title='bbox 0 900 80 950'>312)</span>
<span class='ocrx_word' id='word_1_5' title='bbox 100 900 300 950'>Anders</span>
</span>
</div></body></html>"""


class TestSplitMarker(unittest.TestCase):
    def test_split(self):
        cases = {
            "tut?!?)": ("tut", "?!?", ")"),
            "stellen>!).": ("stellen", ">!", ")."),
            "stellen313).": ("stellen", "313", ")."),
            "„Doppelverpflichtung‘“‘),": ("„Doppelverpflichtung", "‘“‘", "),"),
            "(Hgg.),": ("(Hgg", ".", "),"),
            "tut": None,
            "(1999)": None,
            "Wort)": None,
            "Wort?!?!?!?!)": None,
        }
        for text, expected in cases.items():
            self.assertEqual(split_marker(text), expected, text)

    def test_is_number(self):
        self.assertTrue(candidate("w", "stellen313).").is_number)
        self.assertFalse(candidate("w", "tut?!?)").is_number)


class TestSplitTrailingMarker(unittest.TestCase):
    """Markers without parenthesis, as read by Tesseract 5 from `Regel¹²` etc."""

    def test_split(self):
        cases = {
            'Regel"': ("Regel", '"', ""),
            "persönlich\".": ("persönlich", '"', "."),
            "vor.'*": ("vor.", "'*", ""),
            "Bundesgerichtshof,'": ("Bundesgerichtshof,", "'", ""),
            "streng’;": ("streng", "’", ";"),
            "Verwaltung'”,": ("Verwaltung", "'”", ","),
            "Kommentar217": ("Kommentar", "217", ""),
            "Regel?!?": ("Regel", "?!?", ""),
            # A closing quotation mark belongs to the text if the word has an opening one
            "„Doppelverpflichtung“'": ("„Doppelverpflichtung“", "'", ""),
            "„Doppelverpflichtung“": None,
            "(siehe oben)'": ("(siehe oben)", "'", ""),
            "Regel": None,
            "Regel.": None,
            "Rechts-": None,
            "Wort–": None,
            "123": None,
            "Wort?!?!?!?!": None,
        }
        for text, expected in cases.items():
            self.assertEqual(split_trailing_marker(text), expected, text)

    def test_standalone(self):
        self.assertEqual(split_standalone_marker('"'), ('"', ""))
        self.assertEqual(split_standalone_marker("?!?)."), ("?!?", ")."))
        self.assertEqual(split_standalone_marker("12,"), ("12", ","))
        self.assertIsNone(split_standalone_marker("–"))
        self.assertIsNone(split_standalone_marker("Wort"))

    def test_leading(self):
        self.assertEqual(split_leading_marker("»"), ("»", False))
        self.assertEqual(split_leading_marker("“Vgl."), ("“", False))
        self.assertEqual(split_leading_marker('"®)'), ('"®', True))
        self.assertIsNone(split_leading_marker("12"))
        self.assertIsNone(split_leading_marker("Vgl."))
        self.assertIsNone(split_leading_marker("(Hgg.)"))
        self.assertIsNone(split_leading_marker("–"))


class TestLineGeometry(unittest.TestCase):
    def test_raised(self):
        geometry = LineGeometry.from_title("bbox 253 2000 1879 2041; baseline 0 -9; x_size 40; x_descenders 9; x_ascenders 10")
        assert geometry is not None
        self.assertTrue(geometry.is_raised((254, 2005, 274, 2020)))
        # A guillemet sits just above the baseline, a word on it
        self.assertFalse(geometry.is_raised((254, 2015, 274, 2028)))
        self.assertFalse(geometry.is_raised((300, 2000, 400, 2032)))

    def test_no_baseline(self):
        self.assertIsNone(LineGeometry.from_title("bbox 0 0 100 50"))


class TestFitFootnoteNumbers(unittest.TestCase):
    def test_exact_sequence(self):
        self.assertEqual(fit_footnote_numbers([starts("1", "2"), starts("3")]), [[1, 2], [3]])

    def test_lost_leading_digit(self):
        pages = [starts("107", "108", "109", "110", "112"), starts("13", "14", "15", "116", "17", "18"), starts("119", "120")]
        self.assertEqual(fit_footnote_numbers(pages)[1], [113, 114, 115, 116, 117, 118])

    def test_numbers_between_neighbors(self):
        pages = [starts("84", "85", "86", "88"), starts("3", "4"), starts("100", "101")]
        self.assertEqual(fit_footnote_numbers(pages)[1], [93, 94])

    def test_extra_and_wrong_digit(self):
        pages = [starts("181", "182"), starts("1835", "184"), starts("261", "22", "263", "764")]
        fitted = fit_footnote_numbers(pages)
        self.assertEqual(fitted[1], [183, 184])
        self.assertEqual(fitted[2], [261, 262, 263, 264])

    def test_numbers_without_parenthesis_are_ignored(self):
        pages = [[FootnoteStart("356", False), *starts("5", "6")], [FootnoteStart("357", False), *starts("7")]]
        self.assertEqual(fit_footnote_numbers(pages), [[5, 6], [7]])

    def test_jump_ahead(self):
        self.assertEqual(fit_footnote_numbers([starts("162", "163"), starts("312", "313")]), [[162, 163], [312, 313]])

    def test_restart(self):
        pages = [starts("1", "2", "3"), starts("4", "5", "6"), starts("1", "2", "3"), starts("4", "5")]
        self.assertEqual(fit_footnote_numbers(pages), [[1, 2, 3], [4, 5, 6], [1, 2, 3], [4, 5]])

    def test_no_footnotes(self):
        self.assertEqual(fit_footnote_numbers([[], []]), [[], []])

    def test_recovered_numbers(self):
        # Superscript footnote numbers misrecognized as `»`, `“Vgl.` etc. and read again
        page = [recovered("a", "»", "»", "12", "12"), recovered("b", "“Vgl.", "“", "13"), recovered("c", "»", "»", "714", "14"), recovered("d", "“", "“", "")]
        self.assertEqual(fit_footnote_starts([page]), [[12, 13, 14, None]])

    def test_recovered_numbers_count_less(self):
        # A quotation mark at the start of a line read as `3` does not displace a number read as digits
        page = [*starts("1", "2"), recovered("a", "“Das", "“", "3"), FootnoteStart("3", True)]
        self.assertEqual(fit_footnote_starts([page]), [[1, 2, None, 3]])


class TestPlanRepairs(unittest.TestCase):
    def test_extra_leading_digit(self):
        page = PageAnalysis(starts("162", "163", "164"), [candidate("a", "lassen‘'”).", "795162", "65162"), candidate("b", "könne!).", "4163"), candidate("c", "sei!™).", "1164")])
        repairs = plan_repairs([page])
        self.assertEqual([repair.new for repair in repairs[0]], ["lassen162).", "könne163).", "sei164)."])

    def test_reading_of_one_model_is_enough(self):
        page = PageAnalysis(starts("166", "167"), [candidate("a", "werden“).", "166", "1"), candidate("b", "handelt“).", "1", "167")])
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["werden166).", "handelt167)."])

    def test_out_of_range_reading_is_not_used(self):
        page = PageAnalysis(starts("113", "114"), [candidate("a", "Sonderhaftung“).", "13"), candidate("b", "usw.)", "7")])
        self.assertEqual(plan_repairs([page]), [[]])

    def test_correct_markers_advance_the_sequence(self):
        page = PageAnalysis(starts("20", "21", "22"), [candidate("a", "Wort20)"), candidate("b", "Satz?)", "2120", "21"), candidate("c", "Ende?)", "22")])
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["Satz21)", "Ende22)"])

    def test_markers_on_page_without_footnote_numbers(self):
        pages = [PageAnalysis(starts("94")), PageAnalysis([], [candidate("a", "folgt“).", "95"), candidate("b", "ist“).", "96")]), PageAnalysis(starts("97"))]
        self.assertEqual([repair.new for repair in plan_repairs(pages)[1]], ["folgt95).", "ist96)."])

    def test_plain_markers(self):
        page = PageAnalysis(
            starts("12", "13", "14", "15"),
            [plain_candidate("a", 'Regel"', "12", "12"), plain_candidate("b", "persönlich\".", "13", "73"), plain_candidate("c", "vor.'*", "14"), plain_candidate("d", "streng’;", "115", "15")],
        )
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["Regel12", "persönlich13.", "vor.14", "streng15;"])

    def test_plain_markers_must_be_close_to_the_sequence(self):
        # A raised quotation mark that is read as a number far ahead is not a marker
        page = PageAnalysis(starts("12", "13", "14", "15", "16", "17"), [plain_candidate("a", 'Regel"', "12"), plain_candidate("b", "'unverändert'", "17")])
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["Regel12"])

    def test_plain_markers_start_at_the_first_footnote_of_the_page(self):
        # Without parenthesis, a marker is not given a number below the page's first footnote
        page = PageAnalysis(starts("12", "13"), [plain_candidate("a", 'Regel"', "3"), plain_candidate("b", 'Satz"', "13")])
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["Satz13"])

    def test_plain_correct_markers_advance_the_sequence(self):
        page = PageAnalysis(starts("20", "21"), [MarkerCandidate("a", "Wort20", "Wort", "20", "", strict=True), plain_candidate("b", 'Satz"', "2021", "21")])
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["Satz21"])

    def test_recovered_footnote_numbers_are_repaired(self):
        page = PageAnalysis(
            [recovered("s1", "»", "»", "12"), recovered("s2", "“Vgl.", "“", "13"), recovered("s3", '"®', '"®', "714")],
            [plain_candidate("a", 'Regel"', "12"), plain_candidate("b", "vor.'*", "13"), plain_candidate("c", "streng’;", "14")],
        )
        self.assertEqual([repair.new for repair in plan_repairs([page])[0]], ["12", "13 Vgl.", "14", "Regel12", "vor.13", "streng14;"])

    def test_recovered_footnote_number_needs_its_reading(self):
        # The fit fills in 13, but no reading has it, so the word is left alone
        page = PageAnalysis([*starts("12"), recovered("s", "»", "»", "18"), *starts("14")])
        self.assertEqual(plan_repairs([page]), [[]])

    def test_no_repairs_without_footnotes(self):
        page = PageAnalysis([], [candidate("a", "tut?!?)", "312")])
        self.assertEqual(plan_repairs([page]), [[]])


PLAIN_HOCR = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><div class='ocr_page' title='bbox 0 0 1000 1000'>
<span class='ocr_line' title='bbox 0 0 1000 80; baseline 0 -20; x_size 60; x_descenders 20; x_ascenders 10'>
<span class='ocrx_word' id='w1' title='bbox 0 0 100 80'>Regel"</span>
<span class='ocrx_word' id='w2' title='bbox 120 0 300 80'>Wort"</span>
<span class='ocrx_word' id='w3' title='bbox 320 0 360 30'>'</span>
<span class='ocrx_word' id='w4' title='bbox 380 0 500 80'>Rechts-</span>
</span>
<span class='ocr_line' title='bbox 0 900 1000 980; baseline 0 -20; x_size 60; x_descenders 20; x_ascenders 10'>
<span class='ocrx_word' id='w5' title='bbox 0 900 30 930'>»</span>
<span class='ocrx_word' id='w6' title='bbox 50 900 200 980'>Vgl.</span>
</span>
</div></body></html>"""


class TestRaisedRegion(unittest.TestCase):
    def test_finds_the_superscript(self):
        # A word `tut¹²)`: letters from y=20 to the baseline at y=60, two raised digits from
        # y=5 to 30 and a parenthesis from y=10 to 65
        image = Image.new("L", (200, 80), 255)
        for left, top, right, bottom in [(10, 20, 30, 60), (40, 20, 60, 60), (70, 20, 90, 60), (100, 5, 110, 30), (115, 5, 125, 30), (135, 10, 140, 65)]:
            image.paste(0, (left, top, right, bottom))
        region = raised_region(image, (0, 0, 200, 80), (80, 0, 200, 80))
        assert region is not None
        left, top, right, bottom = region
        self.assertTrue(90 < left <= 100 and 124 <= right < 135, region)
        self.assertTrue(top <= 5 and 30 <= bottom < 60, region)

    def test_nothing_raised(self):
        image = Image.new("L", (100, 80), 255)
        image.paste(0, (10, 20, 30, 60))
        self.assertIsNone(raised_region(image, (0, 0, 100, 80), (0, 0, 100, 80)))


class TestHocr(unittest.TestCase):
    def test_analyze_and_apply(self):
        root = etree.fromstring(HOCR.encode())
        image = Image.new("L", (1000, 1000), 255)
        regions = []

        def recognize(_image: Image.Image, boxes: Sequence[tuple[int, int, int, int]]) -> list[list[str]]:
            regions.extend(boxes)
            return [["312"] for _ in boxes]

        analysis = analyze_page(root, image, recognize)
        self.assertEqual(analysis.footnote_starts, [FootnoteStart("312", True)])
        self.assertEqual([c.text for c in analysis.candidates], ["tut?!?)", "(Hgg.),"])
        # The region starts after the letters, a bit to the left, and extends above the word
        left, top, right, _bottom = regions[0]
        self.assertLess(left, 120 + 180 * 3 // 7)
        self.assertGreater(left, 120)
        self.assertLess(top, 0 + 1)
        self.assertEqual(right, 300)

        repairs = plan_repairs([PageAnalysis.from_json(analysis.to_json())])[0]
        self.assertEqual(repairs, [MarkerRepair("word_1_2", "tut?!?)", "tut312)")])
        apply_repairs(root, repairs)
        words = cast(list[etree._Element], root.xpath("//*[@class='ocrx_word']"))
        self.assertEqual(["".join(str(text) for text in word.itertext()) for word in words], ["das", "tut312)", "(Hgg.),", "312)", "Anders"])


    def test_analyze_plain_markers(self):
        root = etree.fromstring(PLAIN_HOCR.encode())
        # `Regel"`: letters on the baseline at y=60, a raised marker at the end; `Wort"`: letters only
        image = Image.new("L", (1000, 1000), 255)
        image.paste(0, (5, 20, 70, 60))
        image.paste(0, (80, 5, 95, 30))
        image.paste(0, (125, 20, 295, 60))
        regions = []

        def recognize(_image: Image.Image, boxes: Sequence[tuple[int, int, int, int]]) -> list[list[str]]:
            regions.extend(boxes)
            return [["12"] for _ in boxes]

        analysis = analyze_page(root, image, recognize)
        # `Regel"` has a raised marker, the word `'` lies above the baseline; `Wort"` has
        # nothing raised and `Rechts-` ends in a hyphen
        self.assertEqual([(c.text, c.strict) for c in analysis.candidates], [('Regel"', True), ("'", True)])
        # The `»` at the start of the second line lies above the baseline as well
        self.assertEqual([(s.text, s.readings) for s in analysis.footnote_starts], [("»", ["12"])])
        left, _top, right, _bottom = regions[0]
        self.assertTrue(70 <= left <= 80 and 95 <= right <= 100, regions[0])


@unittest.skipUnless(shutil.which("tesseract") and shutil.which("pdftotext"), "Tesseract or pdftotext is not installed")
class TestRepairIntegration(unittest.TestCase):
    """The repair inside OCRmyPDF with the real tools (takes about 10 seconds)."""

    def test_markers_are_repaired_in_the_text_layer(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out.pdf"
            result = OcrmypdfEngine().recognize(FIXTURES / "footnote-markers.pdf", output, ["de"], {"mode": "force"})
            text = subprocess.run(["pdftotext", str(output), "-"], capture_output=True, text=True, check=True).stdout
        for word in ("Regel12)", "persönlich13)", "vorsieht14)"):
            self.assertIn(word, text)
        self.assertIn("3 misrecognized footnote markers were corrected", result.message or "")

    def test_plain_markers_are_repaired_in_the_text_layer(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out.pdf"
            OcrmypdfEngine().recognize(FIXTURES / "footnote-markers-plain.pdf", output, ["de"], {"mode": "force"})
            text = subprocess.run(["pdftotext", str(output), "-"], capture_output=True, text=True, check=True).stdout
        for word in ("Regel12", "persönlich13.", "vor.14", "Bundesgerichtshof,15", "Kommentar17", "streng18;", "Verwaltung19,"):
            self.assertIn(word, text)
        for number in range(12, 20):
            self.assertIn(f"{number} Vgl.", text)
        # Quotation marks and apostrophes without a marker are left alone
        self.assertIn("„Haftung“ ist weit", text)
        self.assertIn("Müller's Ansicht", text)


if __name__ == "__main__":
    unittest.main()
