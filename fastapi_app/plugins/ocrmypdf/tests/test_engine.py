"""
Unit tests for the OCRmyPDF engine: mapping between Tesseract models and normalized language
codes, choice of the method and word recognition.

@testCovers fastapi_app/plugins/ocrmypdf/engine.py
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from fastapi_app.lib.models.models_ocr import TextQualityReport
from fastapi_app.plugins.ocrmypdf.engine import (
    MODE_REDO,
    MODE_SKIP,
    MODE_VECTORIZE,
    OcrmypdfEngine,
    language_to_tesseract,
    parse_tesseract_tsv,
    tesseract_to_language,
)


def report(status: str, **values) -> TextQualityReport:
    """Create a text quality report."""
    return TextQualityReport(status=status, summary="", **values)  # type: ignore[arg-type]


class TestChooseMode(unittest.TestCase):
    def test_choose_mode(self):
        choose = OcrmypdfEngine.choose_mode
        cases = [
            (None, False, MODE_VECTORIZE),
            (report("missing"), True, MODE_SKIP),
            (report("good"), False, MODE_SKIP),
            (report("good"), True, MODE_VECTORIZE),
            (report("good", ocr_layer_pages=3), True, MODE_REDO),
            (report("poor", garbled_char_ratio=0.5), False, MODE_VECTORIZE),
            (report("poor", ocr_layer_pages=3), False, MODE_REDO),
            (report("poor", ocr_layer_pages=3, garbled_char_ratio=0.1), False, MODE_VECTORIZE),
            (report("poor", ocr_layer_pages=3, image_only_pages=2), False, MODE_VECTORIZE),
            (report("poor", image_only_pages=2), False, MODE_VECTORIZE),
        ]
        for quality, rebuild, expected in cases:
            self.assertEqual(choose(quality, rebuild), expected, f"{quality and quality.model_dump(exclude_defaults=True)}, rebuild={rebuild}")


class TestWordRecognition(unittest.TestCase):
    def test_parse_tesseract_tsv(self):
        tsv = "\n".join([
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "1\t1\t0\t0\t0\t0\t0\t0\t1000\t2000\t-1\t",
            "4\t1\t1\t1\t1\t0\t100\t200\t300\t20\t-1\t",
            "5\t1\t1\t1\t1\t1\t100\t200\t100\t20\t96.5\tHello",
            "5\t1\t1\t1\t1\t2\t250\t200\t150\t20\t90\t\"world\"",
            "5\t1\t1\t1\t1\t3\t450\t200\t10\t20\t-1\t ",
        ])
        words = parse_tesseract_tsv(tsv)
        self.assertEqual([w.text for w in words], ["Hello", "\"world\""])
        self.assertEqual((words[0].left, words[0].top, words[0].right, words[0].bottom), (0.1, 0.1, 0.2, 0.11))
        self.assertAlmostEqual(words[0].confidence, 0.965)
        self.assertEqual(parse_tesseract_tsv(""), [])

    @unittest.skipUnless(shutil.which("tesseract"), "Tesseract is not installed")
    def test_recognize_words(self):
        engine = OcrmypdfEngine()
        image = Image.new("L", (1200, 300), 255)
        font = ImageFont.load_default(size=60)
        ImageDraw.Draw(image).text((100, 100), "Recognition works", fill=0, font=font)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "page.png"
            image.save(path)
            words = engine.recognize_words(path, ["en"])
        self.assertEqual([w.text for w in words], ["Recognition", "works"])
        self.assertTrue(0.05 < words[0].left < words[0].right < words[1].left < 0.9)


class TestTesseractLanguageMapping(unittest.TestCase):
    def test_tesseract_to_language(self):
        self.assertEqual(tesseract_to_language("deu"), "de")
        self.assertEqual(tesseract_to_language("chi_sim"), "zh-Hans")
        self.assertEqual(tesseract_to_language("frk"), "de-Latf")
        self.assertEqual(tesseract_to_language("grc"), "grc")
        self.assertIsNone(tesseract_to_language("osd"))
        self.assertIsNone(tesseract_to_language("script/Latin"))
        self.assertIsNone(tesseract_to_language("chi_sim_vert"))

    def test_language_to_tesseract(self):
        available = ["eng", "deu", "chi_sim", "frk", "grc"]
        self.assertEqual(language_to_tesseract("de", available), "deu")
        self.assertEqual(language_to_tesseract("de-Latf", available), "frk")
        self.assertEqual(language_to_tesseract("zh-Hans", available), "chi_sim")
        self.assertEqual(language_to_tesseract("en-US", available), "eng")
        self.assertIsNone(language_to_tesseract("fr", available))


if __name__ == "__main__":
    unittest.main()
