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
@testCovers fastapi_app/lib/ocr/job_types.py
@testCovers fastapi_app/lib/ocr/progress.py
"""

import gc
import io
import logging
import os
import shutil
import tempfile
import threading
import time
import unittest
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi_jobqueue import JobManager, MemoryJobStore
from fastapi_jobqueue.errors import JobCancelled
from PIL import Image, ImageDraw
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from fastapi_app.config import get_settings
from fastapi_app.lib.core import locking
from fastapi_app.lib.core.db_utils import close_all_connections
from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from fastapi_app.lib.core.locking import acquire_lock, check_lock, release_lock, reset_locks_db_initialized
from fastapi_app.lib.jobs import create_job_manager, set_job_manager
from fastapi_app.lib.jobs import manager as manager_module
import pypdfium2 as pdfium

from fastapi_app.lib.models.models_ocr import TextQualityReport
from fastapi_app.lib.ocr import job_types as ocr_job_types
from fastapi_app.lib.ocr.base import OcrEngine, OcrOption, OcrOptionValue, OcrResult, OcrWord
from fastapi_app.lib.ocr.progress import ProgressTracker, progress_reporter, report_progress
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
from fastapi_app.lib.ocr.text_quality import _CID_RE, _is_plausible_token, analyze_text_layer, has_suspicious_marker, pages_needing_review
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


def make_text_pdf(path: Path, page_texts: list[str]) -> None:
    """Write a PDF with one line of Helvetica text per page (an empty string gives a blank page)."""
    writer = PdfWriter()
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    font_ref = writer._add_object(font)
    for text in page_texts:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})})
        if text:
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream = DecodedStreamObject()
            stream.set_data(f"BT /F1 12 Tf 50 700 Td ({escaped}) Tj ET".encode("latin-1"))
            page[NameObject("/Contents")] = writer._add_object(stream)
    with open(path, "wb") as f:
        writer.write(f)


CLEAN_TEXT = "The court held that the contract was valid and binding on all parties."


class TestPagesNeedingReview(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _review(self, texts: list[str]) -> list[int]:
        path = self.tmp / "doc.pdf"
        make_text_pdf(path, texts)
        return pages_needing_review(path)

    def test_clean_page_not_selected(self):
        self.assertEqual(self._review([CLEAN_TEXT]), [])

    def test_page_with_misread_marker_selected(self):
        self.assertEqual(self._review([CLEAN_TEXT, "haftet nach der neuen Regel?!?). Weitere Folgen sind nicht zu erwarten"]), [1])

    def test_page_with_misread_marker_without_bracket_selected(self):
        self.assertEqual(self._review([CLEAN_TEXT, "haftet nach der neuen Regel?!? Weitere Folgen sind nicht zu erwarten"]), [1])

    def test_misread_markers_flagged(self):
        markers = [
            "tut?!?)", "tut?'?)", 'stellen?">)', "lassen‘'”).", "kénne!).", "sei!™).", "würde‘).", "werden“!%).",
            "Regel’).", "persönlich'‘).", "vorsieht'*).",
            "tut?!?", "sei!™.", "werden“!%", "lassen‘'”.", "Regel®", "vorsieht*", "siehe ?! unten",
        ]
        for marker in markers:
            self.assertTrue(has_suspicious_marker(f"Das {marker} und mehr"), marker)

    def test_ordinary_prose_not_flagged(self):
        prose = [
            "sei!", "(siehe oben!)", "Peter’s", "„Wort“.", "Regel’.", "kénne!.", "„Was nun?“", "sagte „Nein!“, und",
            "(vgl. „Wort“)", "Er sagte: 'Ja'.", "50 % der Fälle", "um 20° gedreht",
        ]
        for text in prose:
            self.assertFalse(has_suspicious_marker(f"Das {text} und mehr"), text)
        self.assertFalse(has_suspicious_marker(CLEAN_TEXT))

    def test_garbled_page_selected(self):
        self.assertEqual(self._review([CLEAN_TEXT, "l1ne w,ord t)h(e ii;:j x9z#q tb3 k8j2 m,n,b vv;; qq!!zz"]), [1])

    def test_page_without_text_not_selected(self):
        self.assertEqual(self._review(["", "ab"]), [])


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

    def update_file(self, file_id: str, updates, stable_id: Optional[str] = None) -> Optional[SimpleNamespace]:
        self.updates.append((file_id, updates.model_dump(exclude_unset=True)))
        return self.files.get(stable_id) if stable_id else None

    def create_pdf_version(self, stable_id: str, new_file_id: str, file_size: int, file_metadata: dict, created_by: Optional[str] = None):
        source = self.files[stable_id]
        self.updates.append((source.id, {"id": new_file_id, "file_size": file_size, "file_metadata": file_metadata}))
        new_stable_id = f"{stable_id}-new"
        self.files[new_stable_id] = SimpleNamespace(id=new_file_id, stable_id=new_stable_id, file_type="pdf", file_metadata=file_metadata)
        return self.files[new_stable_id]


class OcrJobsHarness:
    """
    Runs the OCR router with a job manager on a MemoryJobStore: the handlers of the OCR jobs use
    the fake repository and storage of the test, and the job's owner is looked up as the user.
    """

    tmp: Path
    client: TestClient
    manager: JobManager

    def start_app(self, test: unittest.TestCase, repo: object, storage: object, user: dict[str, Any]) -> TestClient:
        """Create the app and the manager, start the manager (TestClient context) and return the client."""
        test.enterContext(patch.dict(os.environ, {"DATA_ROOT": str(self.tmp)}))
        get_settings.cache_clear()
        reset_locks_db_initialized()
        test.addCleanup(self._restore, manager_module._manager)
        self.manager = create_job_manager(MemoryJobStore())
        self.manager.poll_interval = 0.02
        set_job_manager(self.manager)
        auth_manager = MagicMock()
        auth_manager.get_user_by_username.side_effect = lambda username: user if username == user["username"] else None
        test.enterContext(patch("fastapi_app.lib.jobs.auth.get_auth_manager", lambda: auth_manager))
        test.enterContext(patch.object(ocr_job_types, "_file_repository", lambda: repo))
        test.enterContext(patch("fastapi_app.lib.jobs.hooks._file_repository", lambda: repo))
        test.enterContext(patch.object(ocr_job_types, "_file_storage", lambda: storage))
        app = FastAPI(lifespan=self.manager.lifespan)
        app.include_router(ocr_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: user
        app.dependency_overrides[get_file_repository] = lambda: repo
        app.dependency_overrides[get_file_storage] = lambda: storage
        # the context manager runs the lifespan, which starts the manager, and keeps the event loop running
        self.client = TestClient(app).__enter__()
        test.addCleanup(self.client.__exit__, None, None, None)
        return self.client

    @staticmethod
    def _restore(saved: JobManager | None) -> None:
        manager_module._manager = saved
        get_settings.cache_clear()
        reset_locks_db_initialized()
        close_all_connections()
        gc.collect()

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self.client.portal.call(self.manager.get, job_id).model_dump(mode="json")

    def wait_for(self, job: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        """Wait until a job is finished and return it."""
        deadline = time.monotonic() + timeout
        while job["status"] in ("queued", "active"):
            if time.monotonic() > deadline:
                raise AssertionError(f"Job did not finish: {job}")
            time.sleep(0.02)
            job = self.get_job(job["id"])
        return job

    def active_job_id(self) -> str:
        """The id of the job that runs (called from the engine's worker thread)."""
        jobs = self.client.portal.call(partial(self.manager.list, statuses=("active",)))
        assert len(jobs) == 1, jobs
        return jobs[0].id

    def cancel(self, job_id: str) -> None:
        """Cancel a job; called from the engine's worker thread or the test thread."""
        self.client.portal.call(self.manager.cancel, job_id)


class TestOcrRouter(OcrJobsHarness, unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        make_image_only_pdf(self.tmp / "oldhash.pdf")
        shutil.copy(TEXT_PDF, self.tmp / "texthash.pdf")
        self.pdf = SimpleNamespace(id="oldhash", stable_id="pdf1", file_type="pdf", file_metadata={"x": 1})
        self.text_pdf = SimpleNamespace(id="texthash", stable_id="pdf2", file_type="pdf", file_metadata={})
        self.tei = SimpleNamespace(id="teihash", stable_id="tei1", file_type="tei", file_metadata={})
        self.repo = FakeRepo({"pdf1": self.pdf, "pdf2": self.text_pdf, "tei1": self.tei})
        self.storage = FakeStorage(self.tmp)
        self.engine = FakeEngine()
        OcrEngineRegistry.reset_instance()
        self.addCleanup(OcrEngineRegistry.reset_instance)
        OcrEngineRegistry.get_instance().register(self.engine)
        OcrEngineRegistry.get_instance().register(UnavailableEngine())
        self.allowed = True
        self.enterContext(patch.object(ocr_job_types, "check_file_access", lambda file, user, op: self.allowed))
        self.enterContext(patch("fastapi_app.lib.jobs.hooks.check_file_access", lambda file, user, op: self.allowed))
        self.start_app(self, self.repo, self.storage, USER)

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Submit an OCR job and return it."""
        response = self.client.post("/ocr", json=payload)
        self.assertEqual(response.status_code, 202, response.text)
        job = response.json()
        self.assertEqual(job["type"], "ocr")
        self.assertEqual(job["resources"], [f"file:{payload['stable_id']}"])
        return job

    def run_ocr(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Submit an OCR job, wait for it and return the finished job."""
        return self.wait_for(self.start(payload))

    def ocr_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Run OCR and return the result of the successful job."""
        job = self.run_ocr(payload)
        self.assertEqual(job["status"], "done", job.get("error"))
        return job["result"]

    def lock_of(self, stable_id: str) -> locking.LockStatus:
        return check_lock(stable_id, "other-session", get_settings().db_dir, logging.getLogger(__name__))

    def assert_unlocked(self, stable_id: str) -> None:
        """The lock is released right after the job is finished, possibly after the status was read."""
        deadline = time.monotonic() + 5
        while self.lock_of(stable_id)["is_locked"] and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(self.lock_of(stable_id)["is_locked"])

    def block_engine(self) -> tuple[threading.Event, threading.Event]:
        """Make the engine wait in its runs until the returned `release` event is set."""
        started = threading.Event()
        release = threading.Event()

        def during_recognize() -> None:
            started.set()
            release.wait(10)

        self.engine.during_recognize = during_recognize
        return started, release

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

    def test_apply_ocr_creates_a_new_pdf(self):
        body = self.ocr_result({"stable_id": "pdf1", "engine": "fake", "languages": ["deu", "zh-hans"], "options": {"flag": True}})
        self.assertTrue(body["changed"])
        self.assertEqual((body["stable_id"], body["source_stable_id"]), ("pdf1-new", "pdf1"))
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

    def test_the_pdf_is_locked_while_the_job_runs(self):
        started, release = self.block_engine()
        job = self.start({"stable_id": "pdf1", "engine": "fake"})
        try:
            self.assertTrue(started.wait(10))
            self.assertEqual(self.lock_of("pdf1"), {"is_locked": True, "locked_by": f"job:{job['id']}"})
        finally:
            release.set()
        self.assertEqual(self.wait_for(job)["status"], "done")
        self.assert_unlocked("pdf1")

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
        seen: list[dict[str, Any]] = []

        def during_recognize() -> None:
            report_progress("Recognizing text", 1, 4, "page")
            job_id = self.active_job_id()
            deadline = time.monotonic() + 10
            # the manager writes the progress with its next poll
            while time.monotonic() < deadline:
                progress = self.get_job(job_id)["progress"]
                if progress["phase"] == "Recognizing text":
                    seen.append(progress)
                    return
                time.sleep(0.02)

        self.engine.during_recognize = during_recognize
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(job["status"], "done")
        progress = seen[0]
        self.assertEqual((progress["phase"], progress["done"], progress["total"], progress["unit"], progress["value"]), ("Recognizing text", 1, 4, "page", 25))

    def test_failed_job_reports_the_error(self):
        self.engine.error = ValueError("The PDF is protected by a password")
        with self.assertLogs("fastapi_jobqueue", level="ERROR"):
            job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(job["status"], "error")
        self.assertEqual(job["error"], {"message": "The PDF is protected by a password", "status": 400})
        self.engine.error = RuntimeError("tesseract crashed")
        with self.assertLogs("fastapi_app.lib.ocr.job_types", level="ERROR"), self.assertLogs("fastapi_jobqueue", level="ERROR"):
            job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual((job["status"], job["error"]["status"]), ("error", 500))
        self.assertIn("tesseract crashed", job["error"]["message"])
        self.assertEqual(self.repo.updates, [])
        self.assert_unlocked("pdf1")

    def test_second_ocr_for_same_pdf_conflicts(self):
        started, release = self.block_engine()
        try:
            first = self.start({"stable_id": "pdf1", "engine": "fake"})
            self.assertTrue(started.wait(10))
            response = self.client.post("/ocr", json={"stable_id": "pdf1", "engine": "fake"})
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], "Text recognition is already running for this PDF")
            # another PDF is queued behind the first job (one text recognition at a time)
            other = self.start({"stable_id": "pdf2", "engine": "fake"})
            time.sleep(0.2)
            self.assertEqual(self.get_job(other["id"])["status"], "queued")
            self.assertEqual(len(self.engine.calls), 1)
        finally:
            release.set()
        self.assertEqual(self.wait_for(first)["status"], "done")
        self.assertEqual(self.wait_for(other)["status"], "done")
        # once the job is finished, the PDF can be processed again
        self.assertEqual(self.run_ocr({"stable_id": "pdf1", "engine": "fake"})["status"], "done")

    def test_running_job_is_cancelled_at_the_next_progress_report(self):
        reports_after_cancel = []

        def during_recognize() -> None:
            self.cancel(self.active_job_id())
            report_progress("Recognizing text", 1, 4, "page")
            reports_after_cancel.append(True)

        self.engine.during_recognize = during_recognize
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(job["status"], "cancelled")
        self.assertIsNone(job["error"])
        self.assertEqual(reports_after_cancel, [])
        # the PDF is not replaced
        self.assertEqual(self.repo.updates, [])
        self.assertEqual(self.storage.saved, [])
        # the PDF can be processed again
        self.engine.during_recognize = None
        self.assertEqual(self.run_ocr({"stable_id": "pdf1", "engine": "fake"})["status"], "done")

    def test_cancelled_run_of_an_engine_without_progress_reports_is_discarded(self):
        self.engine.during_recognize = lambda: self.cancel(self.active_job_id())
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(self.repo.updates, [])

    def test_engine_error_after_cancel_is_reported_as_cancelled(self):
        self.engine.during_recognize = lambda: self.cancel(self.active_job_id())
        # e.g. an engine that wraps the cancellation raised in its progress report in its own error
        self.engine.error = RuntimeError("pipeline aborted")
        job = self.run_ocr({"stable_id": "pdf1", "engine": "fake"})
        self.assertEqual(job["status"], "cancelled")

    def test_engine_lock_is_kept_until_a_cancelled_engine_returns(self):
        # the job task is cancelled while the engine thread runs on, e.g. when the worker stops,
        # the job loses its lease or an admin deletes the active job
        db_dir, log = get_settings().db_dir, logging.getLogger(__name__)

        def engine_lock_free() -> bool:
            """Whether another job could take the OCR engine lock (which check_lock does not report)."""
            if not acquire_lock(ocr_job_types.OCR_ENGINE_LOCK_ID, "job:probe", db_dir, log):
                return False
            release_lock(ocr_job_types.OCR_ENGINE_LOCK_ID, "job:probe", db_dir, log)
            return True

        started, release = self.block_engine()
        try:
            job = self.start({"stable_id": "pdf1", "engine": "fake"})
            self.assertTrue(started.wait(10))
            self.assertFalse(engine_lock_free())

            async def cancel_task() -> None:
                self.manager._running[job["id"]].task.cancel()

            with self.assertLogs(ocr_job_types.logger.name, level="WARNING") as logs:
                self.client.portal.call(cancel_task)
                time.sleep(0.5)
                # another worker must not start a second engine run meanwhile
                self.assertFalse(engine_lock_free())
                release.set()
                deadline = time.monotonic() + 5
                while not engine_lock_free() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(engine_lock_free())
            self.assertTrue(any("still runs" in line for line in logs.output), logs.output)
        finally:
            release.set()

    def test_queued_job_is_cancelled_at_once(self):
        started, release = self.block_engine()
        try:
            first = self.start({"stable_id": "pdf1", "engine": "fake"})
            self.assertTrue(started.wait(10))
            queued = self.start({"stable_id": "pdf2", "engine": "fake"})
            self.cancel(queued["id"])
            self.assertEqual(self.get_job(queued["id"])["status"], "cancelled")
        finally:
            release.set()
        self.assertEqual(self.wait_for(first)["status"], "done")
        self.assertEqual(len(self.engine.calls), 1)

    def test_job_must_hold_the_lock_of_its_pdf(self):
        # a job submitted through the job API without the resource of its PDF is refused
        job = self.client.portal.call(partial(self.manager.submit, "ocr", {"stable_id": "pdf1", "engine": "fake"}, owner="alice", resources=["file:pdf2"]))
        with self.assertLogs("fastapi_jobqueue", level="ERROR"):
            finished = self.wait_for(job.model_dump(mode="json"))
        self.assertEqual((finished["status"], finished["error"]["status"]), ("error", 400))
        self.assertEqual(self.engine.calls, [])

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
        self.assertEqual(self.client.portal.call(self.manager.list), [])

    def test_old_job_routes_are_gone(self):
        self.assertEqual(self.client.get("/ocr/jobs/x").status_code, 404)
        self.assertEqual(self.client.post("/ocr/jobs/x/cancel").status_code, 404)


class TestProgressTracker(unittest.TestCase):
    def test_eta_is_extrapolated_per_phase(self):
        now = [100.0]
        reports: list[dict[str, Any]] = []
        tracker = ProgressTracker(lambda **fields: reports.append(fields), clock=lambda: now[0])
        tracker.report("Recognizing text", 0, 10, "page")
        now[0] = 120.0
        tracker.report("Recognizing text", 2, 10, "page")
        # 2 pages in 20 s: 8 pages left take 80 s
        self.assertEqual(reports[-1], {"phase": "Recognizing text", "done": 2, "total": 10, "unit": "page", "eta_seconds": 80})
        # a new phase starts its own clock; phases without counts have no estimate
        tracker.report("Repairing footnote numbers")
        self.assertIsNone(reports[-1]["eta_seconds"])
        now[0] = 130.0
        tracker.report("Optimizing images", 5, 5, "image")
        self.assertEqual(reports[-1]["eta_seconds"], 0)

    def test_report_without_reporter_is_ignored(self):
        report_progress("Recognizing text", 1, 2)

    def test_report_raises_when_cancelled(self):
        cancelled = [False]
        reports: list[dict[str, Any]] = []

        def check_cancelled() -> None:
            if cancelled[0]:
                raise JobCancelled()

        with progress_reporter(lambda **fields: reports.append(fields), check_cancelled):
            report_progress("Recognizing text", 1, 2)
            cancelled[0] = True
            with self.assertRaises(JobCancelled):
                report_progress("Recognizing text", 2, 2)
        self.assertEqual(len(reports), 1)


class UnavailableEngine(FakeEngine):
    id = "unavailable"

    def is_available(self) -> bool:
        return False


if __name__ == "__main__":
    unittest.main()
