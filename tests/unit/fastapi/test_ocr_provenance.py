"""
Unit tests for the label and revision change of an extraction from a PDF whose text layer was made
by text recognition.

@testCovers fastapi_app/lib/ocr/provenance.py
@testCovers fastapi_app/lib/utils/tei_utils.py::amend_last_revision_change
@testCovers fastapi_app/routers/extraction.py::_note_text_layer_provenance
"""

import unittest

from lxml import etree

from fastapi_app.lib.ocr.provenance import text_layer_provenance
from fastapi_app.lib.utils.tei_utils import amend_last_revision_change, extract_tei_metadata
from fastapi_app.routers.extraction import _note_text_layer_provenance

OCR = {"engine": "tesseract", "languages": ["deu", "eng"], "applied_at": "2026-11-27T10:00:00+00:00", "applied_by": "rev"}

TEI = (
    '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc/>'
    '<revisionDesc><change when="2026-11-27T10:05:00Z" status="extraction"><note type="label">Extraction</note><desc>Extraction</desc></change></revisionDesc>'
    "</teiHeader><text><body><p>Text</p></body></text></TEI>"
)


class TestTextLayerProvenance(unittest.TestCase):
    def test_no_ocr(self):
        self.assertIsNone(text_layer_provenance({}))
        self.assertIsNone(text_layer_provenance({"text_corrections": [{"model_id": "m", "corrections": []}]}))

    def test_ocr(self):
        provenance = text_layer_provenance({"ocr": OCR})
        assert provenance is not None
        self.assertEqual(provenance.label_suffix, "after OCR")
        self.assertEqual(provenance.description, "The text layer of the PDF was created by text recognition (tesseract, languages: deu, eng) on 2026-11-27.")

    def test_llm_corrections_after_the_ocr(self):
        corrections = [
            {"applied_at": "2026-11-01T00:00:00+00:00", "model_id": "older", "corrections": [{"page": 0, "old": "a", "new": "b"}]},
            {"applied_at": "2026-11-27T10:01:00+00:00", "model_id": "flash", "corrections": [{"page": 0, "old": "a", "new": "b"}, {"page": 1, "old": "c", "new": "d"}]},
            {"applied_at": "2026-11-27T10:02:00+00:00", "tei_stable_id": "x", "corrections": [{"page": 0, "old": "e", "new": "f"}]},
        ]
        provenance = text_layer_provenance({"ocr": OCR, "text_corrections": corrections})
        assert provenance is not None
        self.assertTrue(provenance.description.endswith(" 2 OCR errors of it were corrected by flash."))


class TestAmendLastRevisionChange(unittest.TestCase):
    def test_amends_label_and_desc(self):
        root = etree.fromstring(TEI.encode())
        self.assertTrue(amend_last_revision_change(root, "after OCR", "More."))
        change = root.find(".//{*}revisionDesc/{*}change")
        assert change is not None
        self.assertEqual(change.findtext("{*}note[@type='label']"), "Extraction after OCR")
        self.assertEqual(change.findtext("{*}desc"), "Extraction More.")
        self.assertEqual(extract_tei_metadata(root).get("edition_title"), "Extraction after OCR")

    def test_creates_label(self):
        root = etree.fromstring(TEI.replace('<note type="label">Extraction</note>', "").encode())
        self.assertTrue(amend_last_revision_change(root, "after OCR", "More."))
        self.assertEqual(root.findtext(".//{*}change/{*}note[@type='label']"), "after OCR")

    def test_no_change(self):
        root = etree.fromstring(b'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>')
        self.assertFalse(amend_last_revision_change(root, "after OCR", "More."))


class TestNoteTextLayerProvenance(unittest.TestCase):
    def test_extraction_from_ocr_pdf(self):
        xml = _note_text_layer_provenance(TEI, {"ocr": OCR})
        root = etree.fromstring(xml.encode())
        self.assertEqual(extract_tei_metadata(root).get("edition_title"), "Extraction after OCR")
        self.assertIn("created by text recognition (tesseract", root.findtext(".//{*}change/{*}desc") or "")
        # only the change differs
        self.assertIn("<text><body><p>Text</p></body></text>", xml)

    def test_extraction_from_original_pdf_is_unchanged(self):
        self.assertEqual(_note_text_layer_provenance(TEI, {}), TEI)


if __name__ == "__main__":
    unittest.main()
