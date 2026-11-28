"""
Unit tests for collecting Tesseract ground truth lines from reviewed zone documents.

@testCovers fastapi_app/lib/ocr/training_lines.py
@testCovers fastapi_app/routers/ocr.py::export_training_lines
"""

import gc
import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import pikepdf
import pypdfium2 as pdfium
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    require_admin_user,
)
from fastapi_app.lib.models import FileUpdate
from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.ocr.text_corrections import TeiWord
from fastapi_app.lib.ocr.text_layer import (
    LayerPage,
    LayerWord,
    layer_lines,
    read_text_layer,
)
from fastapi_app.lib.ocr.training_lines import (
    LineSource,
    TrainingLine,
    ground_truth_lines,
    line_boxes,
    ok_pages,
    write_lines,
)
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.tei.layout import (
    LineLayout,
    register_layout_provider,
    unregister_layout_provider,
)
from fastapi_app.lib.tei.zone_lines import ZoneLabel, pages_of, read_zone_document
from fastapi_app.routers import ocr as ocr_router
from tests.unit.fastapi.test_ocr_text_corrections import LINES, corrected

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = PROJECT_ROOT / "tests" / "unit" / "fastapi" / "fixtures" / "ocr-text-layer.pdf"
LABELS = [ZoneLabel("body", "body")]


def layer(page: int, *lines: str) -> LayerPage:
    """A layer page with one text object per line."""
    words: list[LayerWord] = []
    for line, text in enumerate(lines):
        for word in text.split():
            words.append(LayerWord(page, 1, len(words), 0, len(word), word, line))
    return LayerPage(page, words)


def tei(page: int, *lines: str) -> list[TeiWord]:
    return [TeiWord(page, line, word) for line, text in enumerate(lines) for word in text.split()]


class TestGroundTruthLines(unittest.TestCase):
    def test_corrected_and_unchanged_lines(self):
        lines = ground_truth_lines(tei(0, "nach § 12 Abs. 1", "in Tübingen erschienen"), layer(0, "nach $ 12 Abs. l", "in Tiibingen erschienen"))
        self.assertEqual([(line, text) for line, text, _ in lines], [(0, "nach § 12 Abs. 1"), (1, "in Tübingen erschienen")])
        self.assertEqual(lines[1][2], "in Tiibingen erschienen")

    def test_layer_keeps_typographic_dashes_and_quotes(self):
        lines = ground_truth_lines(tei(0, 'das "Recht" - ja'), layer(0, "das „Recht“ – ja"))
        self.assertEqual(lines[0][1], "das „Recht“ – ja")

    def test_line_with_a_different_number_of_words_is_skipped(self):
        lines = ground_truth_lines(tei(0, "erste Zeile hier", "zweite Zeile mit mehr Wörtern"), layer(0, "erste Zeile hier", "zweite Zeile Wörtern"))
        self.assertEqual([line for line, _, _ in lines], [0])

    def test_words_missing_from_the_layer_exclude_both_neighbouring_lines(self):
        lines = ground_truth_lines(tei(0, "eins zwei drei", "fehlt", "vier fünf sechs", "sieben acht neun"), layer(0, "eins zwei drei", "vier fünf sechs", "sieben acht neun"))
        self.assertEqual([line for line, _, _ in lines], [2])

    def test_whitespace_only_difference_keeps_the_layer_text(self):
        lines = ground_truth_lines(tei(0, "Rechts-staat und mehr"), layer(0, "Rechts- staat und mehr"))
        self.assertEqual(lines[0][1], "Rechts- staat und mehr")

    def test_unrelated_block_is_skipped(self):
        lines = ground_truth_lines(tei(0, "ganz anderer Wortlaut steht"), layer(0, "xyzzy qwrtz plmok steht"))
        self.assertEqual(lines, [])

    def test_short_lines_are_skipped(self):
        self.assertEqual(ground_truth_lines(tei(0, "12"), layer(0, "12")), [])

    def test_corrected_property(self):
        self.assertTrue(TrainingLine(0, 0, "§ 1", "$ 1", (0, 0, 1, 1)).corrected)
        self.assertFalse(TrainingLine(0, 0, "§ 1", "§ 1", (0, 0, 1, 1)).corrected)


def review_xml(marks: str, unit_path: str = "pages") -> str:
    body = "<lb/>erste Seite eins<lb/>erste Seite zwei<lb/>zweite Seite eins<lb/>dritte Seite"
    return (
        '<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body>' + body + "</body></text>"
        f'<standOff><listAnnotation type="unit-review"><note type="unit-xpath">{unit_path}</note>{marks}</listAnnotation></standOff></TEI>'
    )


class TestOkPages(unittest.TestCase):
    layout = LineLayout(pages=[0, 0, 1, 2])

    def fingerprints(self) -> list[str]:
        doc = read_zone_document(review_xml(""), LABELS)
        return [page.fingerprint for page in pages_of(doc, self.layout.pages)]

    def ok_pages(self, marks: str, unit_path: str = "pages") -> set[int]:
        with patch("fastapi_app.lib.ocr.training_lines.get_zone_labels", return_value=LABELS):
            return ok_pages(review_xml(marks, unit_path), "v", self.layout)

    def test_pages_marked_ok_by_a_human(self):
        fp = self.fingerprints()
        marks = f'<annotation resp="#jdoe"><note type="ok">{fp[0]} {fp[2]}</note></annotation>'
        self.assertEqual(self.ok_pages(marks), {0, 2})

    def test_a_not_ok_mark_of_another_reviewer_excludes_the_page(self):
        fp = self.fingerprints()
        marks = f'<annotation resp="#jdoe"><note type="ok">{fp[0]} {fp[1]}</note></annotation><annotation resp="#mmus"><note type="not-ok" n="{fp[1]}">wrong</note></annotation>'
        self.assertEqual(self.ok_pages(marks), {0})

    def test_llm_marks_do_not_count(self):
        fp = self.fingerprints()
        marks = f'<annotation xml:id="ur-llm-model"><note type="ok">{fp[0]}</note></annotation>'
        self.assertEqual(self.ok_pages(marks), set())

    def test_final_marks_decide(self):
        fp = self.fingerprints()
        marks = f'<annotation resp="#jdoe"><note type="not-ok" n="{fp[0]}">x</note></annotation><annotation resp="#boss"><note type="final-ok">{fp[0]}</note></annotation>'
        self.assertEqual(self.ok_pages(marks), {0})

    def test_marks_of_a_changed_page_do_not_count(self):
        marks = '<annotation resp="#jdoe"><note type="ok">deadbeef</note></annotation>'
        self.assertEqual(self.ok_pages(marks), set())

    def test_documents_not_reviewed_by_page(self):
        fp = self.fingerprints()
        self.assertEqual(self.ok_pages(f'<annotation resp="#jdoe"><note type="ok">{fp[0]}</note></annotation>', unit_path="./body/*"), set())


class TestLineImages(unittest.TestCase):
    """Uses an OCRmyPDF output with one text object per line."""

    def test_every_line_gets_a_box_in_reading_order(self):
        with pikepdf.open(FIXTURE) as pdf:
            page = read_text_layer(pdf)[0]
        document = pdfium.PdfDocument(FIXTURE)
        try:
            boxes = line_boxes(page, document[0])
        finally:
            document.close()
        lines = layer_lines(page)
        self.assertEqual(sorted(boxes), [line.words[0].line for line in lines])
        tops = [boxes[line.words[0].line][1] for line in lines]
        self.assertEqual(tops, sorted(tops))
        for left, top, right, bottom in boxes.values():
            self.assertTrue(0 <= left < right <= 1 and 0 <= top < bottom <= 1)

    def test_write_lines_in_tesstrain_layout(self):
        with pikepdf.open(FIXTURE) as pdf:
            page = read_text_layer(pdf)[0]
        document = pdfium.PdfDocument(FIXTURE)
        try:
            boxes = line_boxes(page, document[0])
        finally:
            document.close()
        line = layer_lines(page)[0]
        training = [TrainingLine(0, line.words[0].line, "Die Gesellschaft", line.text, boxes[line.words[0].line])]
        source = LineSource("doc/1", "abc", "hash", ["c"], ["de"])
        buffer = io.BytesIO()
        seen: set[tuple[str, int, int]] = set()
        with zipfile.ZipFile(buffer, "w") as archive:
            self.assertEqual(write_lines(archive, source, FIXTURE, training, seen), 1)
            self.assertEqual(write_lines(archive, source, FIXTURE, training, seen), 0)  # same PDF line again
        with zipfile.ZipFile(buffer) as archive:
            names = sorted(archive.namelist())
            self.assertEqual(names, ["lines/doc_1/p0001-l000.gt.txt", "lines/doc_1/p0001-l000.json", "lines/doc_1/p0001-l000.png"])
            self.assertEqual(archive.read(names[0]).decode(), "Die Gesellschaft\n")
            entry = json.loads(archive.read(names[1]))
            self.assertEqual((entry["doc_id"], entry["page"], entry["corrected"]), ("doc/1", 0, True))
            image = Image.open(io.BytesIO(archive.read(names[2])))
            self.assertGreater(image.width, 5 * image.height)  # a line, not a page


if __name__ == "__main__":
    unittest.main()


class TestTrainingLinesRoute(unittest.TestCase):
    """The admin export of the training lines as a zip archive."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.tmp / "metadata.db")
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.tmp / "files", self.db)
        settings = type("S", (), {"data_root": self.tmp, "db_dir": self.tmp})()
        self.patches = [
            patch("fastapi_app.config.get_settings", lambda: settings),
            patch("fastapi_app.lib.ocr.text_corrections.get_zone_labels", return_value=LABELS),
            patch("fastapi_app.lib.ocr.training_lines.get_zone_labels", return_value=LABELS),
            patch.object(ocr_router, "get_zone_labels", return_value=LABELS),
        ]
        for p in self.patches:
            p.start()
        self.layout = LineLayout(pages=[0] * len(LINES))
        register_layout_provider("test.training", "test", lambda xml, doc_id: self.layout)

        pdf_hash, _ = self.storage.save_file(FIXTURE.read_bytes(), "pdf", increment_ref=False)
        self.repo.insert_file(FileCreate(id=pdf_hash, stable_id="pdf1", filename="a.pdf", doc_id="doc1", file_type="pdf", file_size=1, doc_collections=["c1"], file_metadata={"ocr": {"engine": "ocrmypdf", "languages": ["de"]}}))
        lines = corrected(LINES)
        body = "<lb/>".join(lines)
        doc = read_zone_document(f'<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body>{body}</body></text></TEI>', LABELS)
        fingerprint = pages_of(doc, self.layout.pages)[0].fingerprint
        xml = (
            f'<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body>{body}</body></text>'
            f'<standOff><listAnnotation type="unit-review"><note type="unit-xpath">pages</note><annotation resp="#rev"><note type="ok">{fingerprint}</note></annotation></listAnnotation></standOff></TEI>'
        )
        tei_hash, _ = self.storage.save_file(xml.encode(), "tei", increment_ref=False)
        self.repo.insert_file(FileCreate(id=tei_hash, stable_id="tei1", filename="a.tei.xml", doc_id="doc1", file_type="tei", file_size=1, variant="test.training", doc_collections=["c1"]))

        app = FastAPI()
        app.include_router(ocr_router.router)
        app.dependency_overrides[require_admin_user] = lambda: {"username": "admin", "roles": ["admin"]}
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        self.client = TestClient(app)

    def tearDown(self):
        unregister_layout_provider("test.training")
        for p in self.patches:
            p.stop()
        gc.collect()
        shutil.rmtree(self.tmp)

    def export(self) -> zipfile.ZipFile:
        response = self.client.get("/ocr/training-lines")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/zip")
        return zipfile.ZipFile(io.BytesIO(response.content))

    def test_exports_the_lines_of_reviewed_pages(self):
        with self.export() as archive:
            texts = [archive.read(n).decode().strip() for n in archive.namelist() if n.endswith(".gt.txt")]
            entries = [json.loads(archive.read(n)) for n in archive.namelist() if n.endswith(".json")]
        self.assertGreater(len(texts), 3)
        corrected_lines = [e for e in entries if e["corrected"]]
        self.assertEqual(len(corrected_lines), 1)
        self.assertIn("Regel12).", corrected_lines[0]["text"])
        self.assertEqual(entries[0]["languages"], ["de"])

    def test_pdf_without_text_recognition_contributes_nothing(self):
        pdf = self.repo.get_file_by_stable_id("pdf1")
        assert pdf is not None
        self.repo.update_file(pdf.id, FileUpdate(file_metadata={}))
        with self.export() as archive:
            self.assertEqual(archive.namelist(), [])
