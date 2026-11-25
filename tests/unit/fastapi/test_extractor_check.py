"""
Unit tests for `POST /api/v1/extract/check`, which the extraction dialog calls before text
recognition so that a long OCR run is not wasted on an extractor that cannot run.
"""

import unittest
from typing import Any, Optional
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.extraction.base import BaseExtractor
from fastapi_app.lib.extraction.registry import ExtractorUnavailableError
from fastapi_app.routers import extraction as extraction_router


class _Extractor(BaseExtractor):
    """Extractor whose readiness is set by the test."""

    message: Optional[str] = None
    error: Optional[Exception] = None
    seen_options: Optional[dict[str, Any]] = None

    @classmethod
    def get_info(cls) -> dict[str, Any]:
        return {"id": "fake", "name": "Fake", "input": ["pdf"], "output": ["tei-document"]}

    @classmethod
    def is_available(cls) -> bool:
        return True

    async def check_ready(self, options: Optional[dict[str, Any]] = None) -> Optional[str]:
        _Extractor.seen_options = options
        if self.error is not None:
            raise self.error
        return self.message

    async def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None, options: Optional[dict[str, Any]] = None) -> str:
        return "<TEI/>"


class _NoCheckExtractor(_Extractor):
    """Extractor that keeps the default check of the base class."""

    check_ready = BaseExtractor.check_ready


class TestExtractorCheck(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(extraction_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["user"]}
        self.client = TestClient(app)
        _Extractor.message = None
        _Extractor.error = None
        _Extractor.seen_options = None

    def check(self, extractor: type[BaseExtractor] | Exception, body: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Check an extractor class, or an extractor whose creation raises the given error."""

        def create(_extractor_id: str) -> BaseExtractor:
            if isinstance(extractor, Exception):
                raise extractor
            return extractor()

        with patch.object(extraction_router, "create_extractor", side_effect=create):
            response = self.client.post("/extract/check", json=body or {"extractor": "fake"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_ready(self):
        result = self.check(_Extractor, {"extractor": "fake", "options": {"variant_id": "v1"}})
        self.assertEqual(result, {"ready": True, "message": None})
        self.assertEqual(_Extractor.seen_options, {"variant_id": "v1"})

    def test_not_ready(self):
        _Extractor.message = "GROBID server is not reachable"
        with self.assertLogs("fastapi_app.routers.extraction", level="INFO"):
            result = self.check(_Extractor)
        self.assertEqual(result, {"ready": False, "message": "GROBID server is not reachable"})

    def test_failing_check_is_not_ready(self):
        _Extractor.error = ValueError("boom")
        with self.assertLogs("fastapi_app.routers.extraction", level="WARNING"):
            result = self.check(_Extractor)
        self.assertFalse(result["ready"])
        self.assertIn("boom", result["message"])

    def test_extractor_without_check_is_ready(self):
        self.assertEqual(self.check(_NoCheckExtractor), {"ready": True, "message": None})

    def test_unavailable_extractor(self):
        error = ExtractorUnavailableError("GROBID_SERVER_URL is not set")
        # Without a mock extractor to fall back to, the extractor is not ready
        with patch.object(extraction_router, "should_use_mock_extractor", return_value=False):
            self.assertEqual(self.check(error), {"ready": False, "message": "GROBID_SERVER_URL is not set"})
        # The extraction would use the mock extractor instead
        with patch.object(extraction_router, "should_use_mock_extractor", return_value=True):
            self.assertEqual(self.check(error), {"ready": True, "message": None})

    def test_unknown_extractor(self):
        with patch.object(extraction_router, "create_extractor", side_effect=KeyError("nope")):
            response = self.client.post("/extract/check", json={"extractor": "nope"})
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
