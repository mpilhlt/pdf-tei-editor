"""
Unit tests for the routes of the LLM review of OCR errors (#931 Part A).

@testCovers fastapi_app/routers/ocr.py::plan_ocr_llm_review
@testCovers fastapi_app/routers/ocr.py::ocr_llm_review
@testCovers fastapi_app/lib/models/models_ocr.py
"""

import gc
import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from fastapi_app.lib.llm import LLMImage, LLMModel, LLMProvider, LLMProviderRegistry, LLMRateLimitError
from fastapi_app.lib.llm.model_access import ModelAccessDenied
from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.tei.layout import LineLayout, register_layout_provider, unregister_layout_provider
from fastapi_app.lib.tei.zone_lines import ZoneLabel
from fastapi_app.routers import ocr as ocr_router

VARIANT = "test.ocr-llm-review-routes"
LABELS = [ZoneLabel("body", "body")]
LINES = ["Die Gesellschaft haftet nach der neuen Regel’). Weitere Ausführungen folgen.", "wie es das Gesetz jetzt ausdrücklich vorsieht.", "Seite zwei beginnt hier mit Text."]
XML = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/><text><body>' + "<lb/>".join(LINES) + "<lb/></body></text></TEI>"
PAGES = [0, 0, 1]
USER = {"username": "ann", "roles": ["annotator"], "groups": []}


class FakeConfig:
    def get(self, key: str, default: Any = None) -> Any:
        return default


class FakeProvider(LLMProvider):
    """Answers with the configured response, or raises it if it is an exception."""

    def __init__(self) -> None:
        self.id = "fake"
        self.label = "Fake"
        self.uses_user_key = True
        self.response: str | Exception = "[]"
        self.calls = 0
        self.vision = False
        self.image_counts: list[int] = []

    def list_models(self) -> list[LLMModel]:
        capabilities = frozenset({"chat", "vision"} if self.vision else {"chat"})
        return [LLMModel(id="m", label="m", capabilities=capabilities, status=None, free=True)]

    async def chat_completion_with_images(self, model_id: str, system_prompt: str, user_prompt: str, images: list[LLMImage], temperature: float = 0.2) -> str:
        self.image_counts.append(len(images))
        return await self.chat_completion(model_id, system_prompt, user_prompt, temperature)

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.calls += 1
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class TestOcrLlmReviewRoutes(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.tmp / "metadata.db")
        self.repo = FileRepository(self.db)
        settings = type("S", (), {"data_root": self.tmp, "db_dir": self.tmp})()
        self.patches = [
            patch("fastapi_app.config.get_settings", lambda: settings),
            patch.object(ocr_router, "get_settings", lambda: settings),
            patch("fastapi_app.lib.ocr.llm_review.get_zone_labels", return_value=LABELS),
            patch.object(ocr_router, "get_config", lambda: FakeConfig()),
        ]
        for p in self.patches:
            p.start()
        self.repo.insert_file(FileCreate(id="h" * 64, stable_id="tei1", filename="a.tei.xml", doc_id="doc1", file_type="tei", file_size=1, variant=VARIANT, doc_collections=["c1"]))
        self.layout: LineLayout | None = LineLayout(pages=PAGES)
        register_layout_provider(VARIANT, "test", lambda xml, doc_id: self.layout)
        self.allowed = True
        self.access = patch.object(ocr_router, "check_file_access", lambda file, user, op: self.allowed)
        self.access.start()
        LLMProviderRegistry.reset_instance()
        self.provider = FakeProvider()
        LLMProviderRegistry.get_instance().register(self.provider)
        app = FastAPI()
        app.include_router(ocr_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: USER
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        self.pdf_path: Path | None = None
        storage = type("Storage", (), {"get_file_path": lambda _self, file_id, file_type: self.pdf_path})()
        app.dependency_overrides[get_file_storage] = lambda: storage
        self.client = TestClient(app, headers={"X-Session-ID": "s1"})

    def tearDown(self) -> None:
        self.access.stop()
        LLMProviderRegistry.reset_instance()
        unregister_layout_provider(VARIANT)
        for p in self.patches:
            p.stop()
        gc.collect()
        shutil.rmtree(self.tmp)

    def plan(self, **body: Any) -> Any:
        return self.client.post("/ocr/llm-review/plan", json={"stable_id": "tei1", "xml": XML, **body})

    def review(self, **body: Any) -> Any:
        return self.client.post("/ocr/llm-review", json={"stable_id": "tei1", "xml": XML, "provider_id": "fake", "model_id": "m", **body})

    def test_plan_counts_windows(self):
        response = self.plan()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"window_count": 1, "pages": [0, 1]})

    def test_plan_reports_the_pages_of_a_scope(self):
        response = self.plan(scope=LINES[2])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"window_count": 1, "pages": [1]})

    def test_review_returns_findings_and_range(self):
        self.provider.response = json.dumps([{"line": "0001", "old": "Regel’).", "new": "Regel12).", "rationale": "OCR"}])
        response = self.review()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["findings"], [{"id": 0, "old": "Regel’).", "new": "Regel12).", "rationale": "“Regel’).” → “Regel12).”: OCR"}])
        self.assertEqual((result["window_count"], result["discarded"]), (1, 0))
        self.assertEqual(result["window_start"], XML.index("Die Gesellschaft"))
        self.assertEqual(result["window_end"], XML.index("</body>"))

    def two_page_pdf(self) -> Path:
        import pikepdf

        path = self.tmp / "doc.pdf"
        with pikepdf.new() as pdf:
            pdf.add_blank_page(page_size=(595, 842))
            pdf.add_blank_page(page_size=(595, 842))
            pdf.save(path)
        return path

    def test_vision_model_gets_the_window_pages(self):
        self.provider.vision = True
        self.pdf_path = self.two_page_pdf()
        self.repo.insert_file(FileCreate(id="p" * 64, stable_id="pdf1", filename="a.pdf", doc_id="doc1", file_type="pdf", file_size=1, doc_collections=["c1"]))
        response = self.review()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["page_images"])
        self.assertEqual(self.provider.image_counts, [2])

    def test_vision_model_without_pdf_gets_text_only(self):
        self.provider.vision = True
        with self.assertLogs("fastapi_app.routers.ocr", level="INFO"):
            response = self.review()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["page_images"])
        self.assertEqual(self.provider.image_counts, [])
        self.assertEqual(self.provider.calls, 1)

    def test_text_model_gets_text_only(self):
        self.pdf_path = self.two_page_pdf()
        response = self.review()
        self.assertFalse(response.json()["page_images"])
        self.assertEqual(self.provider.image_counts, [])

    def test_scope_occurring_more_than_once_is_422(self):
        response = self.plan(scope="<lb/>")
        self.assertEqual(response.status_code, 422)
        self.assertIn("occurs more than once", response.json()["detail"])

    def test_window_index_out_of_range_is_422(self):
        self.assertEqual(self.review(window_index=1).status_code, 422)
        self.assertEqual(self.provider.calls, 0)

    def test_unknown_provider_is_404(self):
        self.assertEqual(self.review(provider_id="nope").status_code, 404)

    def test_missing_layout_is_422(self):
        self.layout = None
        self.assertEqual(self.plan().status_code, 422)
        self.assertEqual(self.review().status_code, 422)
        self.assertEqual(self.provider.calls, 0)

    def test_model_access_denied_is_403(self):
        with patch.object(ocr_router, "check_model_access", side_effect=ModelAccessDenied("no")):
            response = self.review()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.provider.calls, 0)

    def test_unusable_response_is_502(self):
        self.provider.response = "I cannot do that."
        response = self.review()
        self.assertEqual(response.status_code, 502, response.text)

    def test_rate_limit_maps(self):
        self.provider.response = LLMRateLimitError("slow down", datetime.now(timezone.utc) + timedelta(seconds=30))
        response = self.review()
        self.assertEqual(response.status_code, 429, response.text)

    def test_requires_edit_access(self):
        self.allowed = False
        self.assertEqual(self.review().status_code, 403)
        self.assertEqual(self.plan().status_code, 403)
        self.allowed = True
        self.assertEqual(self.review(stable_id="missing").status_code, 404)
