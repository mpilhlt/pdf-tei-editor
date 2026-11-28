"""
Unit tests for extraction functionality

Tests that extractors set the correct fileref (doc_id) in extracted TEI.

@testCovers tests/fixtures/plugins/test_plugin/extractor.py
@testCovers fastapi_app/routers/extraction.py
@testCovers fastapi_app/lib/extraction/run.py
@testCovers fastapi_app/lib/extraction/job_types.py
"""

import unittest
import tempfile
import json
from pathlib import Path
import sys
from lxml import etree

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from tests.fixtures.plugins.test_plugin.extractor import MockExtractor


XML_NS = "http://www.w3.org/XML/1998/namespace"


def _get_file_desc_xml_id(root: etree._Element) -> str | None:
    """Helper: return decoded fileref from fileDesc/@xml:id."""
    from fastapi_app.lib.utils.doi_utils import decode_from_xml_id
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    file_desc = root.find('.//tei:fileDesc', ns)
    if file_desc is None:
        return None
    xml_id = file_desc.get(f"{{{XML_NS}}}id")
    return decode_from_xml_id(xml_id) if xml_id else None


class TestExtractionFileref(unittest.IsolatedAsyncioTestCase):
    """Test that extractors write doc_id to fileDesc/@xml:id."""

    async def test_mock_extractor_uses_doc_id_from_options(self):
        """Test that MockExtractor uses doc_id from options for fileDesc/@xml:id."""
        extractor = MockExtractor()

        pdf_path = "/path/to/storage/a1b2c3d4e5f6.pdf"
        doc_id = "my-document-2024"

        result = await extractor.extract(
            pdf_path=pdf_path,
            options={'doc_id': doc_id}
        )

        root = etree.fromstring(result.encode('utf-8'))
        fileref = _get_file_desc_xml_id(root)

        self.assertIsNotNone(fileref, "fileDesc/@xml:id should be set")
        self.assertEqual(fileref, doc_id,
                         f"fileref should be '{doc_id}', not derived from storage path")

    async def test_mock_extractor_fallback_to_pdf_path(self):
        """Test that MockExtractor falls back to PDF path when no doc_id in options."""
        extractor = MockExtractor()

        pdf_path = "/path/to/my-document.pdf"

        result = await extractor.extract(
            pdf_path=pdf_path,
            options={}
        )

        root = etree.fromstring(result.encode('utf-8'))
        fileref = _get_file_desc_xml_id(root)

        self.assertIsNotNone(fileref, "fileDesc/@xml:id should be set")
        self.assertEqual(fileref, "my-document",
                         "fileref should be derived from PDF filename when no doc_id provided")

    async def test_mock_extractor_without_pdf_path(self):
        """Test that MockExtractor generates a fileref when no PDF path provided."""
        extractor = MockExtractor()

        result = await extractor.extract(
            xml_content="<TEI></TEI>",
            options={}
        )

        root = etree.fromstring(result.encode('utf-8'))
        fileref = _get_file_desc_xml_id(root)

        self.assertIsNotNone(fileref, "fileDesc/@xml:id should be set")
        self.assertTrue(fileref.startswith("mock-extracted-"),
                        "fileref should be auto-generated when no PDF path")


class TestExtractionRevisionDesc(unittest.IsolatedAsyncioTestCase):
    """Test that extractors add revisionDesc with change element."""

    async def test_mock_extractor_includes_revision_desc(self):
        """Test that MockExtractor includes revisionDesc with change element."""
        extractor = MockExtractor()

        result = await extractor.extract(
            pdf_path="/path/to/test.pdf",
            options={}
        )

        # Parse the result
        root = etree.fromstring(result.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Check for revisionDesc
        revision_desc = root.find('.//tei:revisionDesc', ns)
        self.assertIsNotNone(revision_desc, "revisionDesc should exist")

        # Check for change element
        change_elem = revision_desc.find('.//tei:change', ns)
        self.assertIsNotNone(change_elem, "change element should exist in revisionDesc")

        # Check attributes
        self.assertIsNotNone(change_elem.get('when'), "change element should have 'when' attribute")
        self.assertEqual(change_elem.get('status'), 'extraction', "change element should have status='extraction'")

        # Check desc element inside change
        desc_elem = change_elem.find('tei:desc', ns)
        self.assertIsNotNone(desc_elem, "desc element should exist inside change")
        self.assertIsNotNone(desc_elem.text, "desc element should have text content")
        self.assertIn("mock extractor", desc_elem.text.lower(), "desc text should mention mock extractor")


class TestMockExtractorVariants(unittest.TestCase):
    """Test that MockExtractor exposes variants correctly in get_info()."""

    def test_variants_field_present(self):
        """get_info() must include a top-level 'variants' list."""
        info = MockExtractor.get_info()
        self.assertIn('variants', info)
        self.assertIsInstance(info['variants'], list)

    def test_variants_not_empty(self):
        """variants list must contain at least one entry."""
        info = MockExtractor.get_info()
        self.assertGreater(len(info['variants']), 0)

    def test_variants_match_options(self):
        """variants must equal options.variant_id.options."""
        info = MockExtractor.get_info()
        option_variants = info['options']['variant_id']['options']
        self.assertEqual(info['variants'], option_variants)

    def test_all_variants_have_string_ids(self):
        """Every variant id must be a non-empty string."""
        info = MockExtractor.get_info()
        for v in info['variants']:
            self.assertIsInstance(v, str)
            self.assertTrue(v, f"variant id must not be empty, got {v!r}")

    def test_navigation_xpath_is_subset_of_variants(self):
        """navigation_xpath keys must be a subset of variants."""
        info = MockExtractor.get_info()
        xpath_keys = set(info.get('navigation_xpath', {}).keys())
        variant_ids = set(info['variants'])
        self.assertTrue(xpath_keys.issubset(variant_ids),
                        f"navigation_xpath keys {xpath_keys - variant_ids} not in variants")


class TestExtractionFailurePreservesCollection(unittest.TestCase):
    """
    Test that a PDF is moved into the user-selected collection before extraction
    is attempted, so a failed extraction (e.g. Grobid down) doesn't leave it stuck
    in the upload-time default "_inbox" collection (#477).
    """

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_failed_extraction_still_moves_pdf_out_of_inbox(self):
        import hashlib
        from unittest.mock import patch
        from fastapi.testclient import TestClient

        from fastapi_app.config import Settings, get_settings
        from fastapi_app.lib.core.database import DatabaseManager
        from fastapi_app.lib.repository.file_repository import FileRepository
        from fastapi_app.lib.storage.file_storage import FileStorage
        from fastapi_app.lib.models.models import FileCreate
        from fastapi_app.lib.core.dependencies import (
            get_file_repository,
            get_file_storage,
            require_authenticated_user,
        )
        from fastapi_app.main import app

        db = DatabaseManager(self.test_dir / "test.db")
        repo = FileRepository(db)
        storage = FileStorage(self.test_dir / "files", db)

        pdf_content = b"%PDF-1.4 test content for issue 477"
        file_hash = hashlib.sha256(pdf_content).hexdigest()
        storage.save_file(pdf_content, 'pdf')
        repo.insert_file(FileCreate(
            id=file_hash,
            filename=f"{file_hash}.pdf",
            doc_id="test-doc-477",
            file_type='pdf',
            file_size=len(pdf_content),
            label="Test doc",
            doc_collections=["_inbox"],
        ))

        class _FailingExtractor:
            """Stands in for an extractor whose backend (e.g. Grobid) is down."""

            @classmethod
            def get_info(cls):
                return {'input': ['pdf'], 'output': ['tei-document']}

            async def extract(self, pdf_path=None, xml_content=None, options=None):
                raise RuntimeError("Grobid server down")

        fake_settings = Settings(DATA_ROOT=str(self.test_dir))

        app.dependency_overrides[get_file_repository] = lambda: repo
        app.dependency_overrides[get_file_storage] = lambda: storage
        app.dependency_overrides[require_authenticated_user] = lambda: {
            "username": "testuser", "roles": ["admin"]
        }
        app.dependency_overrides[get_settings] = lambda: fake_settings

        try:
            with patch("fastapi_app.lib.extraction.run.create_extractor", return_value=_FailingExtractor()):
                client = TestClient(app)
                with self.assertLogs("fastapi_app.lib.extraction.run", level="ERROR"):
                    response = client.post(
                        "/api/v1/extract",
                        json={
                            "extractor": "mock-extractor",
                            "file_id": file_hash,
                            "options": {"collection": "my_project_collection"}
                        }
                    )
            self.assertEqual(response.status_code, 500)

            updated = repo.get_file_by_id(file_hash)
            self.assertEqual(
                updated.doc_collections,
                ["my_project_collection"],
                "PDF should be moved to the selected collection even though extraction failed"
            )
        finally:
            app.dependency_overrides.clear()


class TestExtractionJob(unittest.TestCase):
    """
    The UI's extraction as a job (`POST /api/v1/extract/job`, type `extract`): the request is
    validated at once, the job runs the extraction (with OCR as its optional first step) and its
    result is the `ExtractResponse` of the synchronous route.
    """

    def setUp(self):
        import gc
        import hashlib
        import os
        import shutil
        from unittest.mock import MagicMock, patch
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from fastapi_jobqueue import MemoryJobStore

        from fastapi_app.config import get_settings
        from fastapi_app.lib.core.database import DatabaseManager
        from fastapi_app.lib.core.db_utils import close_all_connections
        from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
        from fastapi_app.lib.core.locking import reset_locks_db_initialized
        from fastapi_app.lib.extraction import job_types as extraction_job_types
        from fastapi_app.lib.extraction import run as extraction_run
        from fastapi_app.lib.jobs import create_job_manager, set_job_manager
        from fastapi_app.lib.jobs import manager as manager_module
        from fastapi_app.lib.models.models import FileCreate
        from fastapi_app.lib.ocr import job_types as ocr_job_types
        from fastapi_app.lib.ocr.registry import OcrEngineRegistry
        from fastapi_app.lib.repository.file_repository import FileRepository
        from fastapi_app.lib.storage.file_storage import FileStorage
        from fastapi_app.routers import extraction as extraction_router
        from tests.unit.fastapi.test_ocr import FakeEngine

        self.test_dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.test_dir, True)
        self.enterContext(patch.dict(os.environ, {"DATA_ROOT": str(self.test_dir)}))
        get_settings.cache_clear()
        reset_locks_db_initialized()
        saved_manager = manager_module._manager

        def restore():
            manager_module._manager = saved_manager
            get_settings.cache_clear()
            reset_locks_db_initialized()
            close_all_connections()
            gc.collect()
        self.addCleanup(restore)

        self.user = {"username": "alice", "roles": ["admin"], "groups": []}
        db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(db)
        self.storage = FileStorage(self.test_dir / "files", db)
        pdf_content = b"%PDF-1.4 test content for the extraction job"
        self.pdf_hash = hashlib.sha256(pdf_content).hexdigest()
        self.storage.save_file(pdf_content, "pdf")
        self.pdf = self.repo.insert_file(FileCreate(
            id=self.pdf_hash,
            filename=f"{self.pdf_hash}.pdf",
            doc_id="test-doc-job",
            file_type="pdf",
            file_size=len(pdf_content),
            label="Test doc",
            doc_collections=["_inbox"],
        ))

        # what ran, in order
        self.calls: list[str] = []
        calls = self.calls

        class RecordingExtractor(MockExtractor):
            async def extract(self, pdf_path=None, xml_content=None, options=None):
                calls.append(f"extract:{(options or {}).get('stable_id')}")
                return await super().extract(pdf_path=pdf_path, xml_content=xml_content, options=options)

        def create_extractor(extractor_id: str):
            if extractor_id != "mock-extractor":
                raise KeyError(extractor_id)
            return RecordingExtractor()

        self.enterContext(patch.object(extraction_run, "create_extractor", create_extractor))
        self.enterContext(patch.object(extraction_run, "extract_pdf_text", lambda path: ""))
        self.enterContext(patch.object(extraction_job_types, "_file_repository", lambda: self.repo))
        self.enterContext(patch.object(extraction_job_types, "_file_storage", lambda: self.storage))
        self.enterContext(patch.object(ocr_job_types, "_file_repository", lambda: self.repo))
        self.enterContext(patch("fastapi_app.lib.jobs.hooks._file_repository", lambda: self.repo))
        self.enterContext(patch.object(ocr_job_types, "_file_storage", lambda: self.storage))
        self.enterContext(patch.object(ocr_job_types, "check_file_access", lambda file, user, op: True))
        self.enterContext(patch("fastapi_app.lib.jobs.hooks.check_file_access", lambda file, user, op: True))
        auth_manager = MagicMock()
        auth_manager.get_user_by_username.side_effect = lambda username: self.user if username == "alice" else None
        self.enterContext(patch("fastapi_app.lib.jobs.auth.get_auth_manager", lambda: auth_manager))

        OcrEngineRegistry.reset_instance()
        self.addCleanup(OcrEngineRegistry.reset_instance)
        OcrEngineRegistry.get_instance().register(FakeEngine())

        self.manager = create_job_manager(MemoryJobStore())
        self.manager.poll_interval = 0.02
        set_job_manager(self.manager)
        app = FastAPI(lifespan=self.manager.lifespan)
        app.include_router(extraction_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        self.client = TestClient(app).__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def get_job(self, job_id: str) -> dict:
        return self.client.portal.call(self.manager.get, job_id).model_dump(mode="json")

    def wait_for(self, job: dict, timeout: float = 30) -> dict:
        import time
        deadline = time.monotonic() + timeout
        while job["status"] in ("queued", "active"):
            if time.monotonic() > deadline:
                raise AssertionError(f"Job did not finish: {job}")
            time.sleep(0.02)
            job = self.get_job(job["id"])
        return job

    def submit(self, payload: dict) -> dict:
        response = self.client.post("/extract/job", json=payload)
        self.assertEqual(response.status_code, 202, response.text)
        job = response.json()
        self.assertEqual(job["type"], "extract")
        self.assertEqual(job["resources"], [f"file:{self.pdf.stable_id}"])
        return job

    def steps(self, job_id: str) -> set[str]:
        return set(self.manager.store.steps(job_id))

    def test_extract_job_returns_202_and_result(self):
        from fastapi_app.lib.models.models_extraction import ExtractResponse
        payload = {"extractor": "mock-extractor", "file_id": self.pdf.stable_id, "options": {"collection": "c1", "variant_id": "mock-default"}}
        job = self.wait_for(self.submit(payload))
        self.assertEqual(job["status"], "done", job.get("error"))
        result = ExtractResponse.model_validate(job["result"])
        sync = ExtractResponse.model_validate(self.client.post("/extract", json=payload).json())
        self.assertEqual((result.id, result.pdf, result.language_conflict), (sync.id, sync.pdf, sync.language_conflict))
        self.assertIsNone(job["result"]["ocr"])
        tei = self.repo.get_file_by_stable_id(result.xml)
        self.assertIsNotNone(tei)
        self.assertEqual(tei.doc_collections, ["c1"])
        self.assertEqual(self.calls, [f"extract:{self.pdf.stable_id}", f"extract:{self.pdf.stable_id}"])
        self.assertEqual(self.steps(job["id"]), {"extract"})

    def test_extract_job_validation_is_synchronous(self):
        response = self.client.post("/extract/job", json={"extractor": "no-such-extractor", "file_id": self.pdf.stable_id})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Unknown extractor: no-such-extractor")
        response = self.client.post("/extract/job", json={"extractor": "mock-extractor", "file_id": "no-such-file"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "File not found: no-such-file")
        self.assertEqual(self.client.portal.call(self.manager.list), [])
        self.assertEqual(self.calls, [])

    def test_extract_job_with_ocr_runs_ocr_step_first(self):
        from unittest.mock import patch
        from fastapi_app.lib.extraction import job_types as extraction_job_types
        from fastapi_app.lib.models.models_ocr import OcrResponse, TextQualityReport

        async def recognize(ctx, params, user):
            self.calls.append(f"ocr:{params.stable_id}:{','.join(params.languages)}")
            return OcrResponse(stable_id=params.stable_id, source_stable_id=params.stable_id, changed=False, message="done",
                               quality=TextQualityReport(status="good", summary="ok", reasons=[]))

        with patch.object(extraction_job_types, "recognize_for_job", recognize):
            job = self.wait_for(self.submit({
                "extractor": "mock-extractor",
                "file_id": self.pdf.stable_id,
                "options": {},
                "ocr": {"stable_id": self.pdf.stable_id, "engine": "fake", "languages": ["en"]},
            }))
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(self.calls, [f"ocr:{self.pdf.stable_id}:en", f"extract:{self.pdf.stable_id}"])
        self.assertEqual(self.steps(job["id"]), {"ocr", "extract"})
        self.assertEqual(job["result"]["ocr"]["stable_id"], self.pdf.stable_id)
        self.assertIsNotNone(job["result"]["xml"])

    def test_extract_job_ocr_parameters_are_checked_synchronously(self):
        response = self.client.post("/extract/job", json={
            "extractor": "mock-extractor",
            "file_id": self.pdf.stable_id,
            "ocr": {"stable_id": self.pdf.stable_id, "engine": "no-such-engine"},
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.portal.call(self.manager.list), [])

    def test_extract_job_cancelled_during_ocr_extracts_nothing(self):
        from unittest.mock import patch
        from fastapi_jobqueue.errors import JobCancelled
        from fastapi_app.lib.extraction import job_types as extraction_job_types

        async def recognize(ctx, params, user):
            self.calls.append("ocr")
            raise JobCancelled()

        with patch.object(extraction_job_types, "recognize_for_job", recognize):
            job = self.wait_for(self.submit({
                "extractor": "mock-extractor",
                "file_id": self.pdf.stable_id,
                "ocr": {"stable_id": self.pdf.stable_id, "engine": "fake"},
            }))
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(self.calls, ["ocr"])

    def test_extract_job_cancelled_after_ocr_keeps_the_ocr_result(self):
        import asyncio
        from unittest.mock import patch
        from fastapi_app.lib.extraction import job_types as extraction_job_types
        from fastapi_app.lib.models.models_ocr import OcrResponse, TextQualityReport

        async def recognize(ctx, params, user):
            self.calls.append("ocr")
            # the OCR result is stored, then the user cancels
            await self.manager.cancel(ctx.job_id)
            while not ctx.cancel_requested:
                await asyncio.sleep(0.01)
            return OcrResponse(stable_id="new-pdf", source_stable_id=params.stable_id, changed=True, message="done",
                               quality=TextQualityReport(status="good", summary="ok", reasons=[]))

        with patch.object(extraction_job_types, "recognize_for_job", recognize):
            job = self.wait_for(self.submit({
                "extractor": "mock-extractor",
                "file_id": self.pdf.stable_id,
                "ocr": {"stable_id": self.pdf.stable_id, "engine": "fake"},
            }))
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertTrue(job["result"]["cancelled"])
        self.assertIsNone(job["result"]["xml"])
        self.assertEqual(job["result"]["ocr"]["stable_id"], "new-pdf")
        self.assertEqual(self.calls, ["ocr"])

    def test_extract_job_cancelled_while_extracting_saves_nothing(self):
        import asyncio
        from unittest.mock import patch
        from fastapi_app.lib.extraction import run as extraction_run
        manager = self.manager
        stopped: list[bool] = []

        class Slow(MockExtractor):
            async def extract(self, pdf_path=None, xml_content=None, options=None):
                jobs = await manager.list(statuses=("active",))
                await manager.cancel(jobs[0].id)
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    stopped.append(True)
                    raise
                return "<TEI/>"

        files_before = len(self.repo.get_all_files())
        with patch.object(extraction_run, "create_extractor", lambda extractor_id: Slow()), \
                patch.object(extraction_run, "CANCEL_CHECK_INTERVAL", 0.05):
            job = self.wait_for(self.submit({"extractor": "mock-extractor", "file_id": self.pdf.stable_id}), timeout=10)
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(stopped, [True])
        self.assertEqual(len(self.repo.get_all_files()), files_before)

    def test_extract_job_asks_for_a_missing_llm_key_before_submitting(self):
        from unittest.mock import MagicMock, patch
        from fastapi_app.lib.extraction import job_types as extraction_job_types
        from fastapi_app.lib.extraction import run as extraction_run
        from fastapi_app.lib.secrets import MissingSecretError

        class LlmExtractor(MockExtractor):
            @classmethod
            def get_info(cls):
                return {**MockExtractor.get_info(), "uses_inference_model": True}

        registry = MagicMock()
        registry.get_provider_for_user.side_effect = MissingSecretError("anthropic", "alice")
        detail = {"code": "secret_required", "message": "Anthropic needs your API key", "service": "anthropic"}
        with patch.object(extraction_run, "create_extractor", lambda extractor_id: LlmExtractor()), \
                patch.object(extraction_job_types.LLMProviderRegistry, "get_instance", lambda: registry), \
                patch.object(extraction_job_types, "secret_required_detail", lambda e: detail):
            response = self.client.post("/extract/job", json={"extractor": "mock-extractor", "file_id": self.pdf.stable_id, "options": {"provider_id": "anthropic", "model_id": "m"}})
        self.assertEqual(response.status_code, 428)
        self.assertEqual(response.json()["detail"], detail)
        registry.get_provider_for_user.assert_called_once_with("anthropic", "alice")
        self.assertEqual(self.client.portal.call(self.manager.list), [])

    def add_pdf(self, content: bytes, doc_id: str):
        """Store another PDF and return its metadata."""
        import hashlib
        from fastapi_app.lib.models.models import FileCreate
        file_hash = hashlib.sha256(content).hexdigest()
        self.storage.save_file(content, "pdf")
        return self.repo.insert_file(FileCreate(id=file_hash, filename=f"{file_hash}.pdf", doc_id=doc_id, file_type="pdf", file_size=len(content), label=doc_id, doc_collections=["_inbox"]))

    def test_one_ocr_engine_run_at_a_time_across_job_types(self):
        """An `ocr` job and the OCR step of an `extract` job for another PDF do not run the engine at the same time."""
        import threading
        import time
        from functools import partial
        from unittest.mock import patch
        from fastapi_app.lib.ocr import job_types as ocr_job_types
        from fastapi_app.lib.ocr.registry import OcrEngineRegistry

        engine = OcrEngineRegistry.get_instance().get_engine("fake")
        events: list[str] = []
        first_started = threading.Event()
        release_first = threading.Event()

        def during_recognize():
            run = sum(1 for e in events if e.startswith("start"))  # 0 for the first run
            events.append(f"start{run + 1}")
            if run == 0:
                first_started.set()
                release_first.wait(10)
            events.append(f"end{run + 1}")
        engine.during_recognize = during_recognize

        other_pdf = self.add_pdf(b"%PDF-1.4 the PDF of the ocr job", "ocr-job-doc")
        with patch.object(ocr_job_types, "OCR_ENGINE_POLL_INTERVAL", 0.05):
            ocr_job = self.client.portal.call(partial(self.manager.submit, "ocr", {"stable_id": other_pdf.stable_id, "engine": "fake"}, owner="alice", resources=[f"file:{other_pdf.stable_id}"]))
            self.assertTrue(first_started.wait(10))
            extract_job = self.submit({
                "extractor": "mock-extractor",
                "file_id": self.pdf.stable_id,
                "ocr": {"stable_id": self.pdf.stable_id, "engine": "fake"},
            })
            # the extract job waits for the engine
            deadline = time.monotonic() + 10
            while self.get_job(extract_job["id"])["progress"]["phase"] != ocr_job_types.OCR_ENGINE_WAIT_PHASE:
                self.assertLess(time.monotonic(), deadline, self.get_job(extract_job["id"]))
                time.sleep(0.02)
            self.assertEqual(events, ["start1"])
            release_first.set()
            ocr_done = self.wait_for(ocr_job.model_dump(mode="json"))
            extract_done = self.wait_for(extract_job)
        self.assertEqual(ocr_done["status"], "done", ocr_done.get("error"))
        self.assertEqual(extract_done["status"], "done", extract_done.get("error"))
        self.assertEqual(events, ["start1", "end1", "start2", "end2"])

    def test_job_cancelled_while_waiting_for_the_ocr_engine(self):
        import time
        from fastapi_app.config import get_settings
        from fastapi_app.lib.core.locking import acquire_lock, release_lock
        from fastapi_app.lib.ocr import job_types as ocr_job_types
        from fastapi_app.lib.ocr.registry import OcrEngineRegistry
        import logging

        engine = OcrEngineRegistry.get_instance().get_engine("fake")
        logger = logging.getLogger(__name__)
        db_dir = get_settings().db_dir
        # another job runs the engine
        self.assertTrue(acquire_lock(ocr_job_types.OCR_ENGINE_LOCK_ID, "job:other", db_dir, logger))
        self.addCleanup(release_lock, ocr_job_types.OCR_ENGINE_LOCK_ID, "job:other", db_dir, logger)
        job = self.submit({
            "extractor": "mock-extractor",
            "file_id": self.pdf.stable_id,
            "ocr": {"stable_id": self.pdf.stable_id, "engine": "fake"},
        })
        deadline = time.monotonic() + 10
        while self.get_job(job["id"])["progress"]["phase"] != ocr_job_types.OCR_ENGINE_WAIT_PHASE:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        self.client.portal.call(self.manager.cancel, job["id"])
        job = self.wait_for(job, timeout=10)
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(engine.calls, [])
        self.assertEqual(self.calls, [])

    def test_extract_job_reports_a_missing_secret_as_428(self):
        from unittest.mock import patch
        from fastapi_app.lib.extraction import run as extraction_run
        from fastapi_app.lib.secrets import MissingSecretError

        class NeedsKey(MockExtractor):
            async def extract(self, pdf_path=None, xml_content=None, options=None):
                raise MissingSecretError("anthropic", "alice")

        with patch.object(extraction_run, "create_extractor", lambda extractor_id: NeedsKey()), \
                patch.object(extraction_run, "secret_required_detail", lambda e: {"code": "secret_required", "message": "Anthropic needs your API key"}):
            with self.assertLogs("fastapi_jobqueue", level="ERROR"):
                job = self.wait_for(self.submit({"extractor": "mock-extractor", "file_id": self.pdf.stable_id}))
        self.assertEqual(job["status"], "error")
        self.assertEqual(job["error"], {"message": "Anthropic needs your API key", "status": 428})


if __name__ == '__main__':
    unittest.main()
