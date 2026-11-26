"""
Unit tests for the optional LLM correction pass of OCR runs (#931 Part C).

@testCovers fastapi_app/routers/ocr.py::apply_ocr
@testCovers fastapi_app/routers/ocr.py::_recognize
@testCovers fastapi_app/lib/models/models_ocr.py
"""

import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import patch

import pikepdf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry
from fastapi_app.lib.llm.base import LLMProviderError
from fastapi_app.lib.llm.model_access import ModelAccessDenied
from fastapi_app.lib.ocr import llm_correction
from fastapi_app.lib.ocr.base import OcrOptionValue, OcrResult
from fastapi_app.lib.ocr.jobs import OcrJobStore
from fastapi_app.lib.ocr.registry import OcrEngineRegistry
from fastapi_app.lib.ocr.text_layer import read_text_layer
from fastapi_app.routers import ocr as ocr_router
from tests.unit.fastapi.test_ocr import FakeEngine, FakeRepo, FakeStorage, make_image_only_pdf

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = PROJECT_ROOT / "tests" / "unit" / "fastapi" / "fixtures" / "ocr-text-layer.pdf"
USER = {"username": "alice", "roles": ["user", "annotator"], "groups": []}
ANSWER = json.dumps([{"line": "0001", "old": "Regel’).", "new": "Regel12).", "rationale": "OCR"}])


class FixtureEngine(FakeEngine):
    """Writes the OCR text layer fixture as its output."""

    def recognize(self, input_path: Path, output_path: Path, languages: list[str], options: dict[str, OcrOptionValue], rebuild: bool = False) -> Optional[str | OcrResult]:
        self.calls.append((languages, options))
        shutil.copy(FIXTURE, output_path)
        return self.result


class FakeProvider(LLMProvider):
    """Answers with the configured response, or raises it if it is an exception."""

    def __init__(self) -> None:
        self.id = "fake"
        self.label = "Fake"
        self.uses_user_key = True
        self.response: str | Exception = ANSWER
        self.calls = 0

    def list_models(self) -> list[LLMModel]:
        return []

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.calls += 1
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class FakeConfig:
    def get(self, key: str, default: Any = None) -> Any:
        return default


def layer_words(content: bytes, path: Path) -> list[str]:
    """The words of the first page of the PDF `content`."""
    path.write_bytes(content)
    with pikepdf.open(path) as pdf:
        return [w.text for w in read_text_layer(pdf)[0].words]


class TestOcrLlmCorrectionRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        make_image_only_pdf(self.tmp / "oldhash.pdf")
        self.pdf = SimpleNamespace(id="oldhash", stable_id="pdf1", file_type="pdf", file_metadata={"text_corrections": [{"source": "earlier"}]}, superseded_by=None)
        self.repo = FakeRepo({"pdf1": self.pdf})
        self.storage = FakeStorage(self.tmp)
        self.engine = FixtureEngine()
        OcrEngineRegistry.reset_instance()
        OcrEngineRegistry.get_instance().register(self.engine)
        LLMProviderRegistry.reset_instance()
        self.provider = FakeProvider()
        LLMProviderRegistry.get_instance().register(self.provider)
        app = FastAPI()
        app.include_router(ocr_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: USER
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        self.jobs = OcrJobStore(self.tmp / "jobs", poll_seconds=0.02)
        app.dependency_overrides[ocr_router.get_ocr_job_store] = lambda: self.jobs
        self.enterContext(patch.object(ocr_router, "check_file_access", lambda file, user, op: True))
        self.enterContext(patch.object(ocr_router, "get_config", lambda: FakeConfig()))
        self.enterContext(patch.object(llm_correction, "pages_needing_review", return_value=[0]))
        self.client = TestClient(app).__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        OcrEngineRegistry.reset_instance()
        LLMProviderRegistry.reset_instance()
        shutil.rmtree(self.tmp)

    def start(self, **body: Any) -> Any:
        return self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake", "languages": ["de"], **body})

    def run_ocr(self, **body: Any) -> dict[str, Any]:
        """Start an OCR job, wait for it and return the finished job."""
        response = self.start(**body)
        self.assertEqual(response.status_code, 202, response.text)
        job = response.json()
        deadline = time.monotonic() + 30
        while job["status"] in ("queued", "running"):
            self.assertLess(time.monotonic(), deadline, "OCR job did not finish")
            time.sleep(0.05)
            job = self.client.get(f"/ocr/jobs/{job['job_id']}").json()
        self.assertEqual(job["status"], "done", job.get("error"))
        return job["result"]

    def stored_metadata(self) -> dict[str, Any]:
        return self.repo.updates[-1][1]["file_metadata"]

    def test_option_off_runs_no_llm(self) -> None:
        result = self.run_ocr()
        self.assertEqual(self.provider.calls, 0)
        self.assertEqual(result["llm_corrections"], [])
        self.assertIsNone(result["llm_correction_error"])
        self.assertEqual(result["message"], "done")
        self.assertEqual(self.stored_metadata()["text_corrections"], [{"source": "earlier"}])

    def test_option_on_corrects_and_records(self) -> None:
        result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertEqual(self.provider.calls, 1)
        self.assertEqual(result["llm_corrections"], [{"page": 0, "old": "Regel’).", "new": "Regel12).", "rationale": "OCR"}])
        self.assertIsNone(result["llm_correction_error"])
        self.assertEqual(result["message"], "done Corrected 1 OCR error with m.")
        # the OCR result is stored before the correction starts, the corrected PDF afterwards
        self.assertEqual(len(self.storage.saved), 2)
        ocr_only = layer_words(self.storage.saved[0], self.tmp / "check-ocr.pdf")
        self.assertIn("Regel’).", ocr_only)
        stored = layer_words(self.storage.saved[-1], self.tmp / "check.pdf")
        self.assertIn("Regel12).", stored)
        self.assertNotIn("Regel’).", stored)
        records = self.stored_metadata()["text_corrections"]
        self.assertEqual(records[0], {"source": "earlier"})
        record = records[1]
        self.assertEqual(record["source"], "llm-after-ocr")
        self.assertEqual((record["provider_id"], record["model_id"], record["applied_by"]), ("fake", "m", "alice"))
        self.assertIn("applied_at", record)
        self.assertEqual(record["corrections"], [{"page": 0, "old": "Regel’).", "new": "Regel12)."}])

    def test_no_correction_needed(self) -> None:
        self.provider.response = "[]"
        result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertEqual(result["message"], "done No OCR errors found on 1 reviewed page.")
        self.assertEqual(self.stored_metadata()["text_corrections"], [{"source": "earlier"}])

    def test_no_pages_selected(self) -> None:
        with patch.object(llm_correction, "pages_needing_review", return_value=[]):
            result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertEqual(self.provider.calls, 0)
        self.assertEqual(result["message"], "done No pages needed correction.")

    def test_page_limit_from_config(self) -> None:
        class LimitConfig:
            def get(self, key: str, default: Any = None) -> Any:
                return 0 if key == llm_correction.MAX_PAGES_KEY else default

        with patch.object(ocr_router, "get_config", lambda: LimitConfig()), self.assertLogs("fastapi_app.lib.ocr", level="INFO"):
            result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertEqual(self.provider.calls, 0)
        self.assertEqual(result["message"], "done 1 page was not reviewed: the correction reviews at most 0 pages per run.")

    def test_denied_model_refused_before_ocr(self) -> None:
        with patch.object(ocr_router, "check_model_access", side_effect=ModelAccessDenied("not allowed")):
            response = self.start(llm_correction=True, provider_id="fake", model_id="m")
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.engine.calls, [])

    def test_unknown_provider_is_404(self) -> None:
        self.assertEqual(self.start(llm_correction=True, provider_id="nope", model_id="m").status_code, 404)
        self.assertEqual(self.engine.calls, [])

    def test_missing_ids_422(self) -> None:
        self.assertEqual(self.start(llm_correction=True, model_id="m").status_code, 422)
        self.assertEqual(self.start(llm_correction=True, provider_id="fake").status_code, 422)
        self.assertEqual(self.engine.calls, [])

    def test_llm_failure_keeps_ocr_result(self) -> None:
        self.provider.response = LLMProviderError("down")
        with self.assertLogs("fastapi_app.lib.ocr", level="WARNING"):
            result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertIn("down", result["llm_correction_error"])
        self.assertEqual(result["llm_corrections"], [])
        self.assertIn("LLM correction failed", result["message"])
        stored = layer_words(self.storage.saved[0], self.tmp / "check.pdf")
        self.assertIn("Regel’).", stored)

    def test_cancelled_correction_keeps_ocr_result(self) -> None:
        jobs = self.jobs
        original = self.provider.chat_completion

        async def cancel_then_answer(model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
            # the user cancels while the LLM reviews the first window
            job_id = next(jobs.directory.glob("*.json")).stem
            (jobs.directory / f"{job_id}.cancel").touch()
            return await original(model_id, system_prompt, user_prompt, temperature)

        with patch.object(self.provider, "chat_completion", cancel_then_answer):
            result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertTrue(result["llm_correction_cancelled"])
        self.assertEqual(result["llm_corrections"], [])
        self.assertIsNone(result["llm_correction_error"])
        self.assertEqual(result["message"], "done The correction with m was cancelled.")
        # only the OCR result is stored, with its OCR record and without the correction
        self.assertEqual(len(self.storage.saved), 1)
        self.assertIn("Regel’).", layer_words(self.storage.saved[0], self.tmp / "check.pdf"))
        metadata = self.stored_metadata()
        self.assertIn("ocr", metadata)
        self.assertEqual(metadata["text_corrections"], [{"source": "earlier"}])

    def test_unexpected_exception_keeps_ocr_result(self) -> None:
        with patch.object(ocr_router.llm_correction, "correct_text_layer", side_effect=RuntimeError("boom")), self.assertLogs(ocr_router.logger.name, level="ERROR"):
            result = self.run_ocr(llm_correction=True, provider_id="fake", model_id="m")
        self.assertIn("boom", result["llm_correction_error"])


def correction_run(**fields: Any) -> llm_correction.CorrectionRun:
    return llm_correction.CorrectionRun(**{"corrections": [], "pages_reviewed": [], "skipped": 0, "error": None, **fields})


class TestLlmCorrectionMessage(unittest.TestCase):
    def message(self, **fields: Any) -> str:
        return ocr_router._llm_correction_message(correction_run(**fields), "m")

    def test_no_page_selected(self) -> None:
        self.assertEqual(self.message(), "No pages needed correction.")

    def test_all_selected_pages_skipped(self) -> None:
        self.assertEqual(self.message(pages_selected=[0, 1], pages_skipped=[0, 1]), "2 pages could not be corrected (text layer not patchable or not line-structured).")
        self.assertEqual(self.message(pages_selected=[0], pages_skipped=[0]), "1 page could not be corrected (text layer not patchable or not line-structured).")

    def test_selected_pages_outside_the_layer(self) -> None:
        self.assertEqual(self.message(pages_selected=[7]), "1 page could not be corrected (text layer not patchable or not line-structured).")

    def test_one_correction_dropped(self) -> None:
        self.assertEqual(self.message(pages_selected=[0], pages_reviewed=[0], found=1), "1 correction was dropped or could not be applied.")

    def test_nothing_found(self) -> None:
        self.assertEqual(self.message(pages_selected=[0, 1, 2], pages_reviewed=[0, 1], pages_skipped=[2]), "No OCR errors found on 2 reviewed pages.")

    def test_found_but_not_applied(self) -> None:
        self.assertEqual(self.message(pages_selected=[0], pages_reviewed=[0], found=3, skipped=1), "3 corrections were dropped or could not be applied.")

    def test_corrected(self) -> None:
        applied = [llm_correction.AppliedCorrection(0, "a’)", "a1)", ""), llm_correction.AppliedCorrection(0, "b’)", "b2)", "")]
        self.assertEqual(self.message(pages_selected=[0], pages_reviewed=[0], found=2, corrections=applied), "Corrected 2 OCR errors with m.")

    def test_limit_note(self) -> None:
        message = self.message(pages_selected=[0, 1, 2], pages_reviewed=[0], pages_skipped=[1, 2], pages_over_limit=[1, 2], max_pages=1)
        self.assertEqual(message, "No OCR errors found on 1 reviewed page. 2 pages were not reviewed: the correction reviews at most 1 pages per run.")

    def test_error(self) -> None:
        self.assertEqual(self.message(pages_selected=[0], error="down"), "The LLM correction failed: down")


if __name__ == "__main__":
    unittest.main()
