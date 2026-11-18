"""
Unit tests for the OCR infrastructure: language normalization, text layer analysis,
engine registry and the OCR endpoints.

@testCovers fastapi_app/lib/ocr/languages.py
@testCovers fastapi_app/lib/ocr/registry.py
@testCovers fastapi_app/lib/ocr/text_quality.py
@testCovers fastapi_app/lib/models/models_ocr.py
@testCovers fastapi_app/routers/ocr.py
"""

import io
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pypdf import PdfWriter

from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from fastapi_app.lib.ocr.base import OcrEngine, OcrOption, OcrOptionValue
from fastapi_app.lib.ocr.languages import normalize_ocr_language, to_iso639_3
from fastapi_app.lib.ocr.registry import OcrEngineRegistry
from fastapi_app.lib.ocr.text_quality import _CID_RE, _is_plausible_token, analyze_text_layer
from fastapi_app.routers import ocr as ocr_router

PROJECT_ROOT = Path(__file__).resolve().parents[3]
TEXT_PDF = PROJECT_ROOT / "tests" / "e2e" / "fixtures" / "pdf" / "test-document.pdf"
EMPTY_PDF = PROJECT_ROOT / "app" / "web" / "empty.pdf"
USER = {"username": "alice", "roles": ["user", "annotator"], "groups": []}


def make_image_only_pdf(path: Path) -> None:
    """Write a one-page PDF that contains only an image (a fake scan)."""
    image = Image.new("RGB", (600, 800), "white")
    ImageDraw.Draw(image).rectangle((50, 50, 550, 100), fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PDF", resolution=72)
    path.write_bytes(buffer.getvalue())


class TestLanguages(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_ocr_language("de"), "de")
        self.assertEqual(normalize_ocr_language("deu"), "de")
        self.assertEqual(normalize_ocr_language("ger"), "de")
        self.assertEqual(normalize_ocr_language("EN_us"), "en-US")
        self.assertEqual(normalize_ocr_language("zh-hans"), "zh-Hans")
        self.assertEqual(normalize_ocr_language("grc"), "grc")
        self.assertIsNone(normalize_ocr_language("English"))
        self.assertIsNone(normalize_ocr_language(None))

    def test_to_iso639_3(self):
        self.assertEqual(to_iso639_3("de-Latf"), "deu")
        self.assertEqual(to_iso639_3("fr"), "fra")
        self.assertEqual(to_iso639_3("grc"), "grc")
        self.assertIsNone(to_iso639_3("x"))


class TestTextQuality(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_good_text_layer(self):
        report = analyze_text_layer(TEXT_PDF)
        self.assertEqual(report.status, "good")
        self.assertEqual(report.language, "en")
        self.assertEqual(report.page_count, 5)
        self.assertEqual(report.reasons, [])

    def test_missing_text_layer(self):
        report = analyze_text_layer(EMPTY_PDF)
        self.assertEqual(report.status, "missing")
        self.assertEqual(report.char_count, 0)

    def test_scanned_pages_are_detected(self):
        path = self.tmp / "scan.pdf"
        make_image_only_pdf(path)
        report = analyze_text_layer(path)
        self.assertEqual(report.status, "missing")
        self.assertEqual(report.image_only_pages, 1)
        self.assertIn("scans", report.reasons[0])

    def test_token_heuristics(self):
        for token in ["word", "(Smith,", "1999.", "§", "e.g.", "well-known", "GmbH", "„Zitat“"]:
            self.assertTrue(_is_plausible_token(token), token)
        for token in ["l1ne", "w,ord", "t)h(e", "ii;:j"]:
            self.assertFalse(_is_plausible_token(token), token)
        self.assertEqual(len(_CID_RE.findall("(cid:12)(cid:3) /C80/C117 normal")), 4)


class FakeEngine(OcrEngine):
    id = "fake"
    name = "Fake OCR"
    description = "Copies the input"

    def __init__(self):
        self.calls: list[tuple[list[str], dict[str, OcrOptionValue]]] = []

    def get_options(self) -> dict[str, OcrOption]:
        return {
            "mode": {"type": "string", "options": ["a", "b"], "default": "a"},
            "flag": {"type": "boolean", "default": False},
        }

    def is_available(self) -> bool:
        return True

    def get_languages(self) -> list[str]:
        return ["de", "en", "zh-Hans"]

    def recognize(self, input_path: Path, output_path: Path, languages: list[str], options: dict[str, OcrOptionValue]) -> Optional[str]:
        self.calls.append((languages, options))
        shutil.copy(TEXT_PDF, output_path)
        return "done"


class FakeStorage:
    def __init__(self, root: Path):
        self.root = root
        self.saved: list[bytes] = []

    def get_file_path(self, file_hash: str, file_type: str) -> Optional[Path]:
        path = self.root / f"{file_hash}.{file_type}"
        return path if path.exists() else None

    def save_file(self, content: bytes, file_type: str, increment_ref: bool = True) -> tuple[str, Path]:
        self.saved.append(content)
        path = self.root / f"newhash.{file_type}"
        path.write_bytes(content)
        return "newhash", path


class FakeRepo:
    def __init__(self, files: dict[str, SimpleNamespace]):
        self.files = files
        self.updates: list[tuple[str, dict]] = []

    def get_file_by_stable_id(self, stable_id: str, include_deleted: bool = False) -> Optional[SimpleNamespace]:
        return self.files.get(stable_id)

    def update_file(self, file_id: str, updates) -> None:
        self.updates.append((file_id, updates.model_dump(exclude_unset=True)))


class TestOcrRouter(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        make_image_only_pdf(self.tmp / "oldhash.pdf")
        self.pdf = SimpleNamespace(id="oldhash", stable_id="pdf1", file_type="pdf", file_metadata={"x": 1})
        self.tei = SimpleNamespace(id="teihash", stable_id="tei1", file_type="tei", file_metadata={})
        self.repo = FakeRepo({"pdf1": self.pdf, "tei1": self.tei})
        self.storage = FakeStorage(self.tmp)
        self.engine = FakeEngine()
        OcrEngineRegistry.reset_instance()
        OcrEngineRegistry.get_instance().register(self.engine)
        OcrEngineRegistry.get_instance().register(UnavailableEngine())
        self.allowed = True
        app = FastAPI()
        app.include_router(ocr_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: USER
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        self.client = TestClient(app)
        self.access = patch.object(ocr_router, "check_file_access", lambda file, user, op: self.allowed)
        self.access.start()

    def tearDown(self):
        self.access.stop()
        OcrEngineRegistry.reset_instance()
        shutil.rmtree(self.tmp)

    def test_list_engines_only_lists_available_engines(self):
        response = self.client.get("/ocr/engines")
        self.assertEqual(response.status_code, 200)
        engines = response.json()
        self.assertEqual([e["id"] for e in engines], ["fake"])
        self.assertEqual(engines[0]["languages"], ["de", "en", "zh-Hans"])
        self.assertEqual(engines[0]["default_languages"], ["en"])
        self.assertEqual(engines[0]["options"]["mode"]["options"], ["a", "b"])

    def test_text_quality(self):
        response = self.client.get("/ocr/text-quality/pdf1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "missing")
        self.assertEqual(self.client.get("/ocr/text-quality/tei1").status_code, 404)
        self.assertEqual(self.client.get("/ocr/text-quality/nope").status_code, 404)
        self.allowed = False
        self.assertEqual(self.client.get("/ocr/text-quality/pdf1").status_code, 403)

    def test_apply_ocr_replaces_the_pdf(self):
        response = self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake", "languages": ["deu", "zh-hans"], "options": {"flag": True}})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["stable_id"], "pdf1")
        self.assertEqual(body["quality"]["status"], "good")
        self.assertEqual(body["quality"]["ocr_applied"]["languages"], ["de", "zh-Hans"])
        self.assertEqual(self.engine.calls, [(["de", "zh-Hans"], {"mode": "a", "flag": True})])
        file_id, update = self.repo.updates[0]
        self.assertEqual(file_id, "oldhash")
        self.assertEqual(update["id"], "newhash")
        self.assertEqual(update["file_size"], TEXT_PDF.stat().st_size)
        self.assertEqual(update["file_metadata"]["x"], 1)
        self.assertEqual(update["file_metadata"]["ocr"]["engine"], "fake")
        self.assertEqual(update["file_metadata"]["ocr"]["applied_by"], "alice")

    def test_apply_ocr_uses_default_languages(self):
        response = self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.engine.calls[0][0], ["en"])

    def test_apply_ocr_validation(self):
        cases = [
            ({"engine": "unknown"}, 400),
            ({"engine": "unavailable"}, 400),
            ({"engine": "fake", "languages": ["fr"]}, 400),
            ({"engine": "fake", "languages": ["English"]}, 400),
            ({"engine": "fake", "options": {"other": 1}}, 400),
            ({"engine": "fake", "options": {"mode": "c"}}, 400),
            ({"engine": "fake", "options": {"flag": "yes"}}, 400),
            ({"engine": "fake", "stable_id": "tei1"}, 404),
        ]
        for payload, status in cases:
            response = self.client.post("/ocr", json={"stable_id": "pdf1", **payload})
            self.assertEqual(response.status_code, status, f"{payload}: {response.text}")
        self.allowed = False
        self.assertEqual(self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake"}).status_code, 403)
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(self.repo.updates, [])


class UnavailableEngine(FakeEngine):
    id = "unavailable"

    def is_available(self) -> bool:
        return False


if __name__ == "__main__":
    unittest.main()
