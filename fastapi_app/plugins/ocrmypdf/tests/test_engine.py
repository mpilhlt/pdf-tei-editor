"""
Unit tests for the OCRmyPDF engine: mapping between Tesseract models and normalized language codes.

@testCovers fastapi_app/plugins/ocrmypdf/engine.py
"""

import unittest

from fastapi_app.plugins.ocrmypdf.engine import language_to_tesseract, tesseract_to_language


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
