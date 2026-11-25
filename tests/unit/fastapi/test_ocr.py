"""
Unit tests for the OCR infrastructure: language normalization, text layer analysis,
engine registry and the OCR endpoints.

@testCovers fastapi_app/lib/ocr/languages.py
@testCovers fastapi_app/lib/ocr/registry.py
@testCovers fastapi_app/lib/ocr/text_quality.py
@testCovers fastapi_app/lib/ocr/layout_check.py
@testCovers fastapi_app/lib/ocr/base.py
@testCovers fastapi_app/lib/models/models_ocr.py
@testCovers fastapi_app/routers/ocr.py
"""

import io
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Optional
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pypdf import PdfWriter

from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
import pypdfium2 as pdfium

from fastapi_app.lib.models.models_ocr import OcrJob, TextQualityReport
from fastapi_app.lib.ocr.base import OcrEngine, OcrOption, OcrOptionValue, OcrResult, OcrWord
from fastapi_app.lib.ocr.jobs import OcrJobConflict, OcrJobStore
from fastapi_app.lib.ocr.progress import ProgressTracker, report_progress
from fastapi_app.lib.utils.file_lock import NonBlockingFileLock
from fastapi_app.lib.ocr.languages import normalize_ocr_language, to_iso639_3
from fastapi_app.lib.ocr.layout_check import (
    LayoutCheckResult,
    apply_layout_check,
    check_text_layout,
    compare_words,
    extract_layer_words,
    normalize_word,
)
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


def word(text: str, left: float, top: float, width: float = 0.05, height: float = 0.01) -> OcrWord:
    """Create a word box."""
    return OcrWord(text=text, left=left, top=top, right=left + width, bottom=top + height)


def page_words(page_index: int) -> list[OcrWord]:
    """Return the words of the text layer of a page of TEXT_PDF."""
    document = pdfium.PdfDocument(str(TEXT_PDF))
    try:
        return extract_layer_words(document[page_index])
    finally:
        document.close()


def shifted(words: list[OcrWord], dy: float) -> list[OcrWord]:
    """Move word boxes down by a fraction of the page height."""
    return [OcrWord(w.text, w.left, w.top + dy, w.right, w.bottom + dy) for w in words]


class TestLayoutCheck(unittest.TestCase):
    def test_normalize_word(self):
        self.assertEqual(normalize_word("Müller,"), "muller")
        self.assertEqual(normalize_word("(e.g."), "eg")
        self.assertEqual(normalize_word("—"), "")

    def test_identical_words_match(self):
        words = [word(f"word{i}", 0.1 + (i % 10) * 0.08, 0.1 + (i // 10) * 0.02) for i in range(40)]
        comparison = compare_words(words, words)
        self.assertEqual((comparison.common_words, comparison.positioned_words, comparison.ordered_words), (40, 40, 40))

    def test_fragmented_words_do_not_match(self):
        recognized = [word("recognition", 0.1, 0.1, 0.2), word("quality", 0.32, 0.1, 0.15)]
        layer = [word("recog", 0.1, 0.1, 0.09), word("nition", 0.2, 0.1, 0.1), word("qua", 0.32, 0.1, 0.07), word("lity", 0.4, 0.1, 0.07)]
        self.assertEqual(compare_words(layer, recognized).common_words, 0)

    def test_misplaced_words_are_not_positioned(self):
        recognized = [word(f"word{i}", 0.1, 0.1 + i * 0.02) for i in range(30)]
        comparison = compare_words(shifted(recognized, 0.3), recognized)
        self.assertEqual(comparison.common_words, 30)
        self.assertEqual(comparison.positioned_words, 0)

    def test_reordered_words(self):
        recognized = [word(f"word{i}", 0.1, 0.1 + i * 0.02) for i in range(30)]
        layer = recognized[15:] + recognized[:15]
        comparison = compare_words(layer, recognized)
        self.assertEqual(comparison.positioned_words, 30)
        self.assertEqual(comparison.ordered_words, 15)

    def test_extract_layer_words(self):
        words = page_words(1)
        self.assertGreater(len(words), 100)
        self.assertEqual(words[0].text, "used")
        for w in words:
            self.assertTrue(0 <= w.left < w.right <= 1 and 0 <= w.top < w.bottom <= 1, w)

    def test_check_text_layout_good(self):
        result = check_text_layout(TEXT_PDF, lambda image: page_words(int(image.stem.split("-")[1])))
        self.assertEqual(len(result.pages_checked), 3)
        self.assertEqual((result.text_match, result.position_match, result.order_agreement), (1.0, 1.0, 1.0))
        self.assertEqual(result.reasons, [])

    def test_check_text_layout_misplaced(self):
        result = check_text_layout(TEXT_PDF, lambda image: shifted(page_words(int(image.stem.split("-")[1])), 0.05))
        self.assertEqual(result.text_match, 1.0)
        self.assertLess(result.position_match or 0, 0.2)
        self.assertEqual(len(result.reasons), 1)
        self.assertIn("where they appear on the page", result.reasons[0])

    def test_check_text_layout_mismatch(self):
        result = check_text_layout(TEXT_PDF, lambda image: [word(f"other{i}", 0.1, 0.1 + i * 0.01) for i in range(40)])
        self.assertEqual(result.text_match, 0.0)
        self.assertIn("match the text layer", result.reasons[0])

    def test_check_text_layout_without_comparable_pages(self):
        self.assertEqual(check_text_layout(TEXT_PDF, lambda image: []).pages_checked, [])
        self.assertEqual(check_text_layout(EMPTY_PDF, lambda image: []).pages_checked, [])

    def test_apply_layout_check(self):
        report = TextQualityReport(status="good", summary="fine")
        apply_layout_check(report, LayoutCheckResult(pages_checked=[1], text_match=0.9, position_match=0.95, order_agreement=1.0))
        self.assertEqual((report.status, report.layout_checked, report.layout_text_match), ("good", True, 0.9))
        apply_layout_check(report, LayoutCheckResult(pages_checked=[1], text_match=0.9, position_match=0.1, order_agreement=1.0, reasons=["misplaced"]))
        self.assertEqual((report.status, report.reasons), ("poor", ["misplaced"]))
        self.assertIn("does not match the page", report.summary)


class FakeEngine(OcrEngine):
    id = "fake"
    name = "Fake OCR"
    description = "Copies the input"

    def __init__(self):
        self.calls: list[tuple[list[str], dict[str, OcrOptionValue]]] = []
        self.rebuild_flags: list[bool] = []
        self.result: Optional[str | OcrResult] = "done"
        self.words: Optional[list[OcrWord]] = None
        """Words returned by recognize_words(); word recognition is unsupported if None."""
        self.error: Optional[Exception] = None
        """Exception raised by recognize(), if set."""
        self.during_recognize: Optional[Callable[[], None]] = None
        """Called inside recognize(), if set."""

    def get_options(self) -> dict[str, OcrOption]:
        return {
            "mode": {"type": "string", "options": ["a", "b"], "default": "a"},
            "flag": {"type": "boolean", "default": False},
        }

    def is_available(self) -> bool:
        return True

    def get_languages(self) -> list[str]:
        return ["de", "en", "zh-Hans"]

    def supports_word_recognition(self) -> bool:
        return self.words is not None

    def recognize_words(self, image_path: Path, languages: list[str]) -> list[OcrWord]:
        return self.words or []

    def recognize(
        self,
        input_path: Path,
        output_path: Path,
        languages: list[str],
        options: dict[str, OcrOptionValue],
        rebuild: bool = False,
    ) -> Optional[str | OcrResult]:
        self.calls.append((languages, options))
        self.rebuild_flags.append(rebuild)
        if self.during_recognize is not None:
            self.during_recognize()
        if self.error is not None:
            raise self.error
        shutil.copy(TEXT_PDF, output_path)
        return self.result


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
        shutil.copy(TEXT_PDF, self.tmp / "texthash.pdf")
        self.pdf = SimpleNamespace(id="oldhash", stable_id="pdf1", file_type="pdf", file_metadata={"x": 1})
        self.text_pdf = SimpleNamespace(id="texthash", stable_id="pdf2", file_type="pdf", file_metadata={})
        self.tei = SimpleNamespace(id="teihash", stable_id="tei1", file_type="tei", file_metadata={})
        self.repo = FakeRepo({"pdf1": self.pdf, "pdf2": self.text_pdf, "tei1": self.tei})
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
        self.jobs = OcrJobStore(self.tmp / "jobs", poll_seconds=0.02)
        app.dependency_overrides[ocr_router.get_ocr_job_store] = lambda: self.jobs
        # the context manager keeps the event loop running between requests, so background jobs finish
        self.client = TestClient(app).__enter__()
        self.access = patch.object(ocr_router, "check_file_access", lambda file, user, op: self.allowed)
        self.access.start()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.access.stop()
        OcrEngineRegistry.reset_instance()
        shutil.rmtree(self.tmp)

    def run_ocr(self, payload: dict) -> dict:
        """Start an OCR job, wait for it and return the finished job."""
        response = self.client.post("/ocr", json=payload)
        self.assertEqual(response.status_code, 202, response.text)
        job = response.json()
        self.assertEqual(job["status"], "queued")
        return self.wait_for(job)

    def wait_for(self, job: dict) -> dict:
        """Poll a job until it is finished."""
        deadline = time.monotonic() + 30
        while job["status"] in ("queued", "running"):
            self.assertLess(time.monotonic(), deadline, "OCR job did not finish")
            time.sleep(0.05)
            response = self.client.get(f"/ocr/jobs/{job['job_id']}")
            self.assertEqual(response.status_code, 200, response.text)
            job = response.json()
        return job

    def ocr_result(self, payload: dict) -> dict:
        """Run OCR and return the result of the successful job."""
        job = self.run_ocr(payload)
        self.assertEqual(job["status"], "done", job.get("error"))
        return job["result"]

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
        body = self.ocr_result({"stable_id": "pdf1", "engine": "fake", "languages": ["deu", "zh-hans"], "options": {"flag": True}})
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

    def test_text_quality_layout_check(self):
        # without an engine that recognizes words, the layout check is skipped
        body = self.client.get("/ocr/text-quality/pdf2?layout=true").json()
        self.assertEqual((body["status"], body["layout_checked"]), ("good", False))
        # recognized words at other places than in the text layer
        self.engine.words = shifted(page_words(2), 0.05)
        body = self.client.get("/ocr/text-quality/pdf2?layout=true").json()
        self.assertEqual((body["status"], body["layout_checked"]), ("poor", True))
        self.assertLess(body["layout_position_match"], 0.5)
        # without the parameter, only the character checks run
        body = self.client.get("/ocr/text-quality/pdf2").json()
        self.assertEqual((body["status"], body["layout_checked"]), ("good", False))
        # a missing text layer is not compared
        body = self.client.get("/ocr/text-quality/pdf1?layout=true").json()
        self.assertEqual((body["status"], body["layout_checked"]), ("missing", False))

    def test_apply_ocr_records_method_and_rebuild(self):
        self.engine.result = OcrResult(message="rasterized", method="force", fallback_reason="Ghostscript is not installed")
        body = self.ocr_result({"stable_id": "pdf1", "engine": "fake", "rebuild": True})
        self.assertEqual((body["message"], body["method"], body["fallback_reason"]), ("rasterized", "force", "Ghostscript is not installed"))
        self.assertEqual(body["quality"]["ocr_applied"]["method"], "force")
        self.assertEqual(self.engine.rebuild_flags, [True])
        record = self.repo.updates[0][1]["file_metadata"]["ocr"]
        self.assertEqual((record["method"], record["fallback_reason"]), ("force", "Ghostscript is not installed"))
        # engines that return a plain message record no method
        self.engine.result = "done"
        body = self.ocr_result({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual((body["message"], body["method"]), ("done", None))
        self.assertNotIn("method", body["quality"]["ocr_applied"])
        self.assertEqual(self.engine.rebuild_flags, [True, False])

    def test_apply_ocr_uses_default_languages(self):
        self.ocr_result({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(self.engine.calls[0][0], ["en"])

    def test_progress_is_recorded_while_running(self):
        seen = []

        def during_recognize() -> None:
            report_progress("Recognizing text", 1, 4, "page")
            job_file = next((self.tmp / "jobs").glob("*.json"))
            seen.append(OcrJob.model_validate_json(job_file.read_text()).progress)

        self.engine.during_recognize = during_recognize
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(job["status"], "done")
        progress = seen[0]
        self.assertEqual((progress.phase, progress.done, progress.total, progress.unit), ("Recognizing text", 1, 4, "page"))
        # the finished job has no progress
        self.assertIsNone(job["progress"])

    def test_failed_job_reports_the_error(self):
        self.engine.error = ValueError("The PDF is protected by a password")
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual((job["status"], job["error_status"]), ("failed", 400))
        self.assertEqual(job["error"], "The PDF is protected by a password")
        self.engine.error = RuntimeError("tesseract crashed")
        with self.assertLogs("fastapi_app.routers.ocr", level="ERROR"):
            job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual((job["status"], job["error_status"]), ("failed", 500))
        self.assertIn("tesseract crashed", job["error"])
        self.assertEqual(self.repo.updates, [])

    def test_second_job_for_the_same_pdf_is_rejected(self):
        run_lock = NonBlockingFileLock(self.jobs.directory / ".run.lock")
        self.assertTrue(run_lock.try_acquire())
        try:
            first = self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake"}).json()
            response = self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake"})
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIn("already queued", response.json()["detail"])
            # another PDF is queued behind the first job
            other = self.client.post("/ocr", json={"stable_id": "pdf2", "engine": "fake"})
            self.assertEqual(other.status_code, 202, other.text)
        finally:
            run_lock.release()
        self.assertEqual(self.wait_for(first)["status"], "done")
        self.assertEqual(self.wait_for(other.json())["status"], "done")
        # once the job is finished, the PDF can be processed again
        self.assertEqual(self.run_ocr({"stable_id": "pdf1", "engine": "fake"})["status"], "done")

    def test_job_is_queued_while_another_run_holds_the_lock(self):
        run_lock = NonBlockingFileLock(self.jobs.directory / ".run.lock")
        self.assertTrue(run_lock.try_acquire())
        try:
            job = self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake"}).json()
            time.sleep(0.2)
            self.assertEqual(self.client.get(f"/ocr/jobs/{job['job_id']}").json()["status"], "queued")
            self.assertEqual(self.engine.calls, [])
        finally:
            run_lock.release()
        self.assertEqual(self.wait_for(job)["status"], "done")
        self.assertEqual(len(self.engine.calls), 1)

    def test_jobs_are_private(self):
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(self.client.get("/ocr/jobs/nope").status_code, 404)
        self.assertEqual(self.client.get("/ocr/jobs/..%2Fx").status_code, 404)
        self.client.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob"}
        self.assertEqual(self.client.get(f"/ocr/jobs/{job['job_id']}").status_code, 404)

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


class TestOcrJobStore(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = OcrJobStore(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_job_of_a_dead_process_fails(self):
        job = self.store.create("pdf1", "alice")
        self.assertEqual(self.store.get(job.job_id).status, "queued")
        dead = job.model_copy(update={"pid": 2**22 + 12345})
        self.store._write(dead)
        failed = self.store.get(job.job_id)
        self.assertEqual((failed.status, failed.error_status), ("failed", 503))

    def test_invalid_ids_and_cleanup(self):
        self.assertIsNone(self.store.get("../etc"))
        self.assertIsNone(self.store.get(".hidden"))
        active = self.store.create("pdf1", "alice")
        finished = self.store.fail(self.store.create("pdf2", "alice"), "error")
        self.store.cleanup(max_age=-1)
        # active jobs are kept, finished ones deleted
        self.assertIsNotNone(self.store.get(active.job_id))
        self.assertIsNone(self.store.get(finished.job_id))

    def test_conflict_and_dead_jobs(self):
        job = self.store.create("pdf1", "alice")
        with self.assertRaises(OcrJobConflict):
            self.store.create("pdf1", "bob")
        # a job of a dead process does not block a new one
        self.store._write(job.model_copy(update={"pid": 2**22 + 12345}))
        self.assertEqual(self.store.create("pdf1", "bob").status, "queued")

    def test_run_lock_excludes_other_holders(self):
        import asyncio

        async def scenario() -> list[str]:
            events: list[str] = []
            store = OcrJobStore(self.tmp, poll_seconds=0.01)

            async def run(name: str) -> None:
                job = store.create(name, "alice")
                async with store.run_slot(job) as running:
                    self.assertEqual(running.status, "running")
                    events.append(f"start {name}")
                    await asyncio.sleep(0.05)
                    events.append(f"end {name}")

            await asyncio.gather(run("a"), run("b"))
            return events

        events = asyncio.run(scenario())
        # the runs do not overlap
        self.assertEqual([e.split()[0] for e in events], ["start", "end", "start", "end"])


class TestProgressTracker(unittest.TestCase):
    def test_eta_is_extrapolated_per_phase(self):
        now = [100.0]
        reports = []
        tracker = ProgressTracker(reports.append, clock=lambda: now[0])
        tracker.report("Recognizing text", 0, 10, "page")
        now[0] = 120.0
        tracker.report("Recognizing text", 2, 10, "page")
        # 2 pages in 20 s: 8 pages left take 80 s
        self.assertEqual(reports[-1].eta_seconds, 80)
        # a new phase starts its own clock; phases without counts have no estimate
        tracker.report("Repairing footnote numbers")
        self.assertIsNone(reports[-1].eta_seconds)
        now[0] = 130.0
        tracker.report("Optimizing images", 5, 5, "image")
        self.assertEqual(reports[-1].eta_seconds, 0)

    def test_report_without_reporter_is_ignored(self):
        report_progress("Recognizing text", 1, 2)


class UnavailableEngine(FakeEngine):
    id = "unavailable"

    def is_available(self) -> bool:
        return False


if __name__ == "__main__":
    unittest.main()
