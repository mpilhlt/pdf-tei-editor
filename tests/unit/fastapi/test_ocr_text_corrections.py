"""
Unit tests for the routes that write the text corrections of a TEI document into the PDF's OCR
text layer (#931).

@testCovers fastapi_app/routers/ocr.py::preview_text_corrections
@testCovers fastapi_app/routers/ocr.py::apply_text_corrections
@testCovers fastapi_app/lib/ocr/job_types.py
@testCovers fastapi_app/lib/repository/file_repository.py::get_current_pdf_teis
@testCovers fastapi_app/lib/models/models_ocr.py
@testCovers fastapi_app/lib/ocr/text_layer.py::read_text_layer
@testCovers fastapi_app/lib/ocr/text_corrections.py::tei_words
"""

import gc
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pikepdf
from lxml import etree
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from fastapi_jobqueue import MemoryJobStore

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, get_session_manager, get_sse_service, require_authenticated_user
from fastapi_app.lib.core.locking import acquire_lock, check_lock
from fastapi_app.lib.models.models import FileCreate, FileMetadata
from fastapi_app.lib.jobs import create_job_manager, set_job_manager
from fastapi_app.lib.jobs import manager as manager_module
from fastapi_app.lib.jobs.routes import include_job_routes
from fastapi_app.lib.ocr.text_corrections import CorrectedPdfMismatch, register_corrected_pdf_handler, unregister_corrected_pdf_handler
from fastapi_app.lib.ocr.text_layer import read_text_layer
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.tei.layout import LineLayout, register_layout_provider, unregister_layout_provider
from fastapi_app.lib.tei.zone_lines import ZoneLabel
from fastapi_app.lib.ocr import job_types as ocr_job_types
from fastapi_app.routers import ocr as ocr_router

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PDF = PROJECT_ROOT / "tests" / "unit" / "fastapi" / "fixtures" / "ocr-text-layer.pdf"
VARIANT = "test.text-corrections"
REVIEWER = {"username": "rev", "roles": ["reviewer"], "groups": []}
ANNOTATOR = {"username": "ann", "roles": ["annotator"], "groups": []}
SESSION = "session-1"

LINES = [
    "Die Gesellschaft haftet nach der neuen Regel’). Weitere Ausführungen folgen im nächsten Abschnitt der Darstellung.",
    "und die Gesellschafter haften daneben persönlich'‘). Weitere Ausführungen folgen im nächsten Abschnitt der Darstellung.",
    "wie es das Gesetz jetzt ausdrücklich vorsieht'*). Weitere Ausführungen folgen ım nächsten Abschnitt der Darstellung.",
    "12) Vgl. die Begründung des Entwurfs, S. 120.",
    "13) Vgl. die Begründung des Entwurfs, S. 130.",
    "14) Vgl. die Begründung des Entwurfs, S. 140.",
]


def tei_xml(lines: list[str]) -> str:
    body = "<lb/>".join(lines)
    return f'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><idno type="pdf-hash">OLD-HASH</idno></teiHeader><text><body>{body}</body></text></TEI>'


def corrected(lines: list[str]) -> list[str]:
    return [lines[0].replace("Regel’).", "Regel12)."), *lines[1:]]


class TestTextCorrectionRoutes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.tmp / "metadata.db")
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.tmp / "files", self.db)
        # FileRepository creates its own FileStorage under settings.data_root / "files" to delete content
        settings = type("S", (), {"data_root": self.tmp, "db_dir": self.tmp})()
        self.settings_patch = patch("fastapi_app.config.get_settings", lambda: settings)
        self.settings_patch.start()
        self.router_settings_patch = patch.object(ocr_router, "get_settings", lambda: settings)
        self.router_settings_patch.start()
        self.collections_patch = patch("fastapi_app.lib.services.tei_versions.user_has_collection_access", return_value=True)
        self.collections_patch.start()
        self.labels_patch = patch("fastapi_app.lib.ocr.text_corrections.get_zone_labels", return_value=[ZoneLabel("body", "body")])
        self.labels_patch.start()

        self.pdf_hash = self.save(FIXTURE_PDF.read_bytes(), "pdf")
        self.insert(self.pdf_hash, "pdf", stable_id="pdf1", doc_collections=["c1"])
        self.tei = self.add_tei(corrected(LINES), "tei1", version=1, label="Version 1")
        self.other = self.add_tei(LINES, "tei2", version=2, label="Other version")

        self.layout: LineLayout | None = LineLayout(pages=[0] * len(LINES))
        register_layout_provider(VARIANT, "test", lambda xml, doc_id: self.layout)
        self.handler_calls: list[tuple[str, str, Path, str, frozenset[int]]] = []
        self.handler_error: Exception | None = None
        self.cancel_in_handler = False
        register_corrected_pdf_handler(VARIANT, "test", self.handler)

        self.allowed = True
        self.access = patch.object(ocr_router, "check_file_access", lambda file, user, op: self.allowed)
        # the PDF checks are shared with the OCR jobs
        self.enterContext(patch.object(ocr_job_types, "check_file_access", lambda file, user, op: self.allowed))
        self.access.start()
        self.user: dict[str, Any] = REVIEWER
        self.saved_manager = manager_module._manager
        self.manager = create_job_manager(MemoryJobStore())
        self.manager.poll_interval = 0.05
        self.manager.lease_ttl = 0.3
        set_job_manager(self.manager)

        @asynccontextmanager
        async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
            async with self.manager.lifespan():
                yield

        app = FastAPI(lifespan=lifespan)
        app.include_router(ocr_router.router)
        api_v1 = APIRouter(prefix="/api/v1")
        include_job_routes(api_v1)
        app.include_router(api_v1)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        self.sse = MagicMock()
        app.dependency_overrides[get_sse_service] = lambda: self.sse
        app.dependency_overrides[get_session_manager] = lambda: MagicMock()
        self.client = TestClient(app, headers={"X-Session-ID": SESSION})
        self.enterContext(self.client)

    def tearDown(self):
        manager_module._manager = self.saved_manager
        self.access.stop()
        unregister_layout_provider(VARIANT)
        unregister_corrected_pdf_handler(VARIANT)
        self.labels_patch.stop()
        self.collections_patch.stop()
        self.router_settings_patch.stop()
        self.settings_patch.stop()
        gc.collect()
        shutil.rmtree(self.tmp)

    def handler(self, xml: str, doc_id: str, pdf_path: Path, pdf_hash: str, corrected_lines: frozenset[int]) -> str:
        self.handler_calls.append((xml, doc_id, pdf_path, pdf_hash, corrected_lines))
        if self.cancel_in_handler:
            self.cancel_job(self.running_job_id)
        if self.handler_error is not None:
            raise self.handler_error
        return xml.replace("OLD-HASH", pdf_hash)

    def save(self, content: bytes, file_type: str) -> str:
        file_hash, _ = self.storage.save_file(content, file_type, increment_ref=False)
        return file_hash

    def insert(self, file_hash: str, file_type: str, **kwargs: Any) -> FileMetadata:
        stable_id = kwargs.pop("stable_id")
        self.repo.insert_file(FileCreate(id=file_hash, stable_id=stable_id, filename=f"{file_hash[:8]}.{file_type}", doc_id="doc1", file_type=file_type, file_size=1, **kwargs))
        file = self.repo.get_file_by_stable_id(stable_id)
        assert file is not None
        return file

    def add_tei(self, lines: list[str], stable_id: str, **kwargs: Any) -> FileMetadata:
        return self.insert(self.save(tei_xml(lines).encode(), "tei"), "tei", stable_id=stable_id, variant=VARIANT, doc_collections=["c1"], **kwargs)

    def preview(self, **body: Any) -> dict[str, Any]:
        response = self.client.post("/ocr/text-corrections/preview", json={"stable_id": "tei1", **body})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def apply(self, **body: Any) -> Any:
        return self.client.post("/ocr/text-corrections/apply", json={"stable_id": "tei1", **body})

    def test_preview_lists_corrections(self):
        preview = self.preview()
        self.assertIsNone(preview["reason"])
        self.assertEqual(preview["corrections"], [{"page": 0, "line": 0, "old": "Regel’).", "new": "Regel12)."}])
        self.assertEqual(preview["unwritable"], [])

    def test_apply_creates_corrected_pdf_and_returns_xml(self):
        response = self.apply()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["source_pdf_stable_id"], "pdf1")
        pdf = self.repo.get_file_by_stable_id(result["pdf_stable_id"])
        assert pdf is not None
        self.assertNotEqual(pdf.stable_id, "pdf1")
        self.assertNotEqual(pdf.id, self.pdf_hash)
        self.assertEqual(pdf.doc_id, "doc1")
        self.assertEqual(result["corrections"], 1)
        self.assertIn(pdf.id, result["xml"])
        self.assertNotIn("OLD-HASH", result["xml"])
        # the new PDF has the corrected word
        path = self.storage.get_file_path(pdf.id, "pdf")
        assert path is not None
        with pikepdf.open(path) as new_pdf:
            words = [w.text for w in read_text_layer(new_pdf)[0].words]
        self.assertIn("Regel12).", words)
        self.assertNotIn("Regel’).", words)
        # the source PDF and the versions attached to it are not changed
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]
        self.assertEqual(self.repo.get_file_by_stable_id("tei2").pdf_stable_id, "pdf1")  # type: ignore[union-attr]
        self.assertEqual(self.repo.get_file_by_stable_id("tei1").pdf_stable_id, "pdf1")  # type: ignore[union-attr]
        record = pdf.file_metadata["text_corrections"][-1]
        self.assertEqual(record["applied_by"], "rev")
        self.assertEqual(record["tei_stable_id"], "tei1")
        self.assertEqual(record["corrections"], [{"page": 0, "line": 0, "old": "Regel’).", "new": "Regel12)."}])
        self.assertIn("applied_at", record)
        # the handler got the corrected PDF and the corrected lines
        _, doc_id, pdf_path, pdf_hash, lines = self.handler_calls[0]
        self.assertEqual((doc_id, pdf_hash, lines), ("doc1", pdf.id, frozenset({0})))

    def submit_job(self, mode: str = "apply") -> str:
        """Submit the client job that the client passes to the route."""
        response = self.client.post("/api/v1/jobs", json={"type": "ocr.text-corrections", "params": {"stable_id": "tei1", "mode": mode}})
        self.assertEqual(response.status_code, 201, response.text)
        job_id = response.json()["id"]
        self.running_job_id = job_id
        return job_id

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self.client.get(f"/api/v1/jobs/{job_id}").json()

    def wait_for_job(self, job_id: str, status: str) -> dict[str, Any]:
        deadline = time.monotonic() + 5
        job = self.get_job(job_id)
        while job["status"] != status and time.monotonic() < deadline:
            time.sleep(0.02)
            job = self.get_job(job_id)
        self.assertEqual(job["status"], status, job)
        return job

    def cancel_job(self, job_id: str) -> None:
        """Cancel through the job API, and wait until the request has seen it (its heartbeat)."""
        response = self.client.post(f"/api/v1/jobs/{job_id}/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        time.sleep(self.manager.lease_ttl)

    def test_preview_reports_to_its_job(self):
        job_id = self.submit_job("preview")
        self.preview(job_id=job_id)
        job = self.wait_for_job(job_id, "done")
        self.assertEqual(job["progress"]["phase"], "Comparing the document with the text layer")
        self.assertEqual((job["progress"]["done"], job["progress"]["total"], job["progress"]["unit"]), (1, 1, "pages"))

    def test_apply_reports_to_its_job_and_finishes_it(self):
        job_id = self.submit_job()
        self.assertEqual(self.apply(job_id=job_id).status_code, 200)
        job = self.wait_for_job(job_id, "done")
        self.assertEqual(job["progress"]["phase"], "Saving the new version of the document")
        self.assertEqual(job["result"]["corrections"], 1)

    def test_failed_apply_finishes_its_job_with_the_error(self):
        job_id = self.submit_job()
        response = self.apply(job_id=job_id, pages=[1])
        self.assertEqual(response.status_code, 409)
        job = self.wait_for_job(job_id, "error")
        self.assertEqual(job["error"]["status"], 409)

    def test_unknown_job_is_refused(self):
        self.assertEqual(self.apply(job_id="nope").status_code, 404)
        self.assertEqual(self.client.post("/ocr/text-corrections/preview", json={"stable_id": "tei1", "job_id": "nope"}).status_code, 404)

    def test_no_job_without_job_id(self):
        self.preview()
        self.assertEqual(self.apply().status_code, 200)
        self.assertEqual(self.client.get("/api/v1/jobs").json(), [])

    def test_version_of_an_older_pdf_writes_from_its_own_pdf(self):
        # another lineage has a newer PDF, which is the canonical one
        newer = self.repo.create_pdf_version("pdf1", self.save(b"%PDF other", "pdf"), 10, {})
        self.assertEqual(self.repo.get_pdf_for_document("doc1").stable_id, newer.stable_id)  # type: ignore[union-attr]
        self.assertIsNone(self.preview()["reason"])
        response = self.apply()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["source_pdf_stable_id"], "pdf1")

    def test_requires_reviewer(self):
        self.user = ANNOTATOR
        self.assertEqual(self.client.post("/ocr/text-corrections/preview", json={"stable_id": "tei1"}).status_code, 403)
        self.assertEqual(self.apply().status_code, 403)

    def test_tei_not_found_or_denied(self):
        self.assertEqual(self.client.post("/ocr/text-corrections/preview", json={"stable_id": "nope"}).status_code, 404)
        self.assertEqual(self.apply(stable_id="pdf1").status_code, 404)
        self.allowed = False
        self.assertEqual(self.apply().status_code, 403)

    def test_missing_layout_and_handler(self):
        self.layout = None
        self.assertEqual(self.apply().status_code, 409)
        self.assertIn("layout information", self.preview()["reason"])
        self.layout = LineLayout(pages=[0] * len(LINES))
        unregister_corrected_pdf_handler(VARIANT)
        self.assertEqual(self.preview()["reason"], "Text corrections cannot be written for this kind of document.")
        self.assertEqual(self.apply().status_code, 409)

    def test_no_corrections(self):
        self.tei = self.add_tei(LINES, "tei3", version=3)
        response = self.client.post("/ocr/text-corrections/apply", json={"stable_id": "tei3"})
        self.assertEqual((response.status_code, response.json()["detail"]), (409, "The document has no text corrections to write."))

    def test_preview_without_corrections_lists_unwritable(self):
        lines = list(LINES)
        lines[3] = lines[3].replace("Vgl.", "Vgl. neu")
        self.add_tei(lines, "tei3", version=3)
        preview = self.client.post("/ocr/text-corrections/preview", json={"stable_id": "tei3"}).json()
        self.assertEqual(preview["reason"], "The document has no text corrections to write.")
        self.assertEqual(preview["corrections"], [])
        self.assertEqual([(u["line"], u["tei_text"]) for u in preview["unwritable"]], [(3, "neu")])

    def test_active_ocr_job_conflicts(self):
        # a job (e.g. text recognition) holds the lock of the PDF
        self.assertTrue(acquire_lock("pdf1", "job:ocr-1", self.tmp, ocr_router.logger))
        self.assertIsNotNone(self.preview()["reason"])
        self.assertEqual(self.apply().status_code, 409)
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]

    def test_unwritable_requires_skip(self):
        lines = corrected(LINES)
        lines[3] = lines[3].replace("Vgl.", "Vgl. neu")
        self.add_tei(lines, "tei3", version=3)
        preview = self.client.post("/ocr/text-corrections/preview", json={"stable_id": "tei3"}).json()
        self.assertIsNone(preview["reason"])
        self.assertEqual(len(preview["corrections"]), 1)
        self.assertEqual([(u["line"], u["tei_text"], u["reason"]) for u in preview["unwritable"]], [(3, "neu", "different number of words")])
        response = self.client.post("/ocr/text-corrections/apply", json={"stable_id": "tei3"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]
        response = self.client.post("/ocr/text-corrections/apply", json={"stable_id": "tei3", "skip_unwritable": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["corrections"], 1)

    def test_handler_mismatch_keeps_pdf(self):
        self.handler_error = CorrectedPdfMismatch("The corrected PDF does not match", [3])
        with self.assertLogs("fastapi_app.routers.ocr", level="WARNING"):
            response = self.apply()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], {"message": "The corrected PDF does not match", "lines": [3]})
        pdf = self.repo.get_file_by_stable_id("pdf1")
        assert pdf is not None
        self.assertEqual(pdf.id, self.pdf_hash)
        self.assertNotIn("text_corrections", pdf.file_metadata)
        self.assertEqual([p.stable_id for p in self.repo.get_document_pdfs("doc1")], ["pdf1"])

    def test_handler_service_error_is_502(self):
        self.handler_error = RuntimeError("GROBID is not reachable")
        with self.assertLogs("fastapi_app.routers.ocr", level="WARNING"):
            response = self.apply()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]

    def test_handler_unexpected_error_is_502(self):
        self.handler_error = KeyError("zone")
        with self.assertLogs("fastapi_app.routers.ocr", level="ERROR") as logs:
            response = self.apply()
        self.assertEqual(response.status_code, 502)
        self.assertIn("Traceback", "\n".join(logs.output))
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]

    def test_apply_creates_version_based_on_corrected_pdf(self):
        response = self.apply()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        pdf = self.repo.get_file_by_stable_id(result["pdf_stable_id"])
        assert pdf is not None
        version = self.repo.get_file_by_stable_id(result["tei_stable_id"])
        assert version is not None
        # a new version attached to the corrected PDF, made from the edited TEI
        self.assertNotIn(version.stable_id, ("tei1", "tei2"))
        self.assertEqual((version.file_type, version.doc_id, version.variant, version.version), ("tei", "doc1", VARIANT, 3))
        self.assertEqual(version.pdf_stable_id, pdf.stable_id)
        self.assertEqual(version.parent_stable_id, "tei1")
        self.assertEqual(version.created_by, "rev")
        self.assertEqual(version.doc_collections, ["c1"])
        content = self.storage.read_file(version.id, "tei")
        assert content is not None
        self.assertEqual(content.decode("utf-8"), result["xml"])
        self.assertIn(f'<idno type="pdf-hash">{pdf.id}</idno>', result["xml"])
        # a revision change records the corrections and labels the version
        changes = etree.fromstring(content).findall("{*}teiHeader/{*}revisionDesc/{*}change")
        self.assertEqual(len(changes), 1)
        self.assertEqual((changes[0].get("who"), changes[0].get("status")), ("#rev", "draft"))
        self.assertEqual(changes[0].findtext("{*}note[@type='label']"), ocr_router.TEXT_CORRECTIONS_LABEL)
        self.assertEqual(changes[0].findtext("{*}desc"), "Wrote 1 text correction into the text layer of a new PDF and attached this version to it")
        self.assertEqual(version.label, ocr_router.TEXT_CORRECTIONS_LABEL)
        # locked for the session that wrote the corrections
        self.assertTrue(check_lock(version.stable_id, "other-session", self.tmp, ocr_router.logger)["is_locked"])
        self.assertFalse(check_lock(version.stable_id, SESSION, self.tmp, ocr_router.logger)["is_locked"])
        # the edited TEI stays attached to its PDF; both versions can be corrected further
        tei = self.repo.get_file_by_stable_id("tei1")
        assert tei is not None
        self.assertEqual(tei.pdf_stable_id, "pdf1")
        self.assertNotEqual(self.preview(stable_id=version.stable_id)["reason"], ocr_router.LOCKED_MESSAGE)
        self.assertIsNone(self.preview()["reason"])

    def test_version_keeps_history_and_status_of_its_source(self):
        header = ('<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc><idno type="pdf-hash">OLD-HASH</idno>'
                  '<revisionDesc><change when="2026-01-01T00:00:00Z" status="extraction" who="#grobid"><note type="label">Extraction</note><desc>Extracted</desc></change></revisionDesc></teiHeader>')
        xml = tei_xml(corrected(LINES)).replace('<teiHeader><idno type="pdf-hash">OLD-HASH</idno></teiHeader>', header)
        self.insert(self.save(xml.encode(), "tei"), "tei", stable_id="tei3", variant=VARIANT, doc_collections=["c1"], version=3, label="Extraction")
        self.user = {**REVIEWER, "fullname": "Rita Reviewer"}
        response = self.apply(stable_id="tei3")
        self.assertEqual(response.status_code, 200, response.text)
        root = etree.fromstring(response.json()["xml"].encode())
        changes = root.findall("{*}teiHeader/{*}revisionDesc/{*}change")
        self.assertEqual([c.findtext("{*}note[@type='label']") for c in changes], ["Extraction", ocr_router.TEXT_CORRECTIONS_LABEL])
        self.assertEqual((changes[1].get("who"), changes[1].get("status")), ("#rev", "extraction"))
        self.assertEqual(root.findtext(".//{*}titleStmt/{*}respStmt/{*}persName"), "Rita Reviewer")
        version = self.repo.get_file_by_stable_id(response.json()["tei_stable_id"])
        assert version is not None
        self.assertEqual((version.label, version.status), (ocr_router.TEXT_CORRECTIONS_LABEL, "extraction"))

    def test_unchanged_pdf_is_refused(self):
        with patch.object(ocr_router, "_patch_pdf", lambda source, target, corrections: shutil.copyfile(source, target)):
            response = self.apply()
        self.assertEqual((response.status_code, response.json()["detail"]), (409, ocr_router.NO_CORRECTIONS_MESSAGE))
        self.assertEqual(self.handler_calls, [])
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]
        self.assertEqual(self.repo.get_latest_tei_version("doc1", VARIANT).stable_id, "tei2")  # type: ignore[union-attr]

    def test_lock_of_other_session_is_refused(self):
        self.assertTrue(acquire_lock("tei1", "other-session", self.tmp, ocr_router.logger))
        self.assertEqual(self.preview()["reason"], ocr_router.LOCKED_MESSAGE)
        response = self.apply()
        self.assertEqual((response.status_code, response.json()["detail"]), (423, ocr_router.LOCKED_MESSAGE))
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]

    def test_lock_of_own_session_is_accepted(self):
        self.assertTrue(acquire_lock("tei1", SESSION, self.tmp, ocr_router.logger))
        self.assertIsNone(self.preview()["reason"])
        self.assertEqual(self.apply().status_code, 200)

    def test_invalid_handler_xml_keeps_pdf(self):
        register_corrected_pdf_handler(VARIANT, "test", lambda xml, doc_id, pdf_path, pdf_hash, lines: "<TEI")
        with self.assertLogs("fastapi_app.routers.ocr", level="WARNING"):
            response = self.apply()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]

    def test_version_creation_failure_reports_written_pdf(self):
        with patch.object(ocr_router, "create_tei_version", side_effect=RuntimeError("disk full")):
            with self.assertLogs("fastapi_app.routers.ocr", level="ERROR"):
                response = self.apply()
        self.assertEqual(response.status_code, 500)
        self.assertIn("The corrections were written to the PDF", response.json()["detail"])

    def test_page_write_updates_the_version_in_place(self):
        response = self.apply(pages=[0])
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual((result["tei_stable_id"], result["new_version"], result["corrections"]), ("tei1", False, 1))
        pdf = self.repo.get_file_by_stable_id(result["pdf_stable_id"])
        assert pdf is not None
        self.assertNotEqual(pdf.stable_id, "pdf1")
        # the extractor is not asked to update the document: it keeps the data of the old PDF
        self.assertEqual(self.handler_calls, [])
        self.assertIn("OLD-HASH", result["xml"])
        # no new version: the edited version is attached to the corrected PDF and stores the xml
        self.assertEqual(self.repo.get_latest_tei_version("doc1", VARIANT).stable_id, "tei2")  # type: ignore[union-attr]
        tei = self.repo.get_file_by_stable_id("tei1")
        assert tei is not None
        self.assertEqual((tei.pdf_stable_id, tei.label), (pdf.stable_id, "Version 1"))
        content = self.storage.read_file(tei.id, "tei")
        assert content is not None
        self.assertEqual(content.decode("utf-8"), result["xml"])
        changes = etree.fromstring(content).findall("{*}teiHeader/{*}revisionDesc/{*}change")
        self.assertEqual(len(changes), 1)
        self.assertIsNone(changes[0].find("{*}note[@type='label']"))
        self.assertEqual(changes[0].findtext("{*}desc"), "Wrote 1 text correction on page 1 into the text layer of a new PDF and attached this version to it")
        self.assertEqual(tei.status, "draft")
        record = pdf.file_metadata["text_corrections"][-1]
        self.assertEqual((record["pages"], record["corrections"]), ([0], [{"page": 0, "line": 0, "old": "Regel’).", "new": "Regel12)."}]))
        # the other version stays on the old PDF
        self.assertEqual(self.repo.get_file_by_stable_id("tei2").pdf_stable_id, "pdf1")  # type: ignore[union-attr]

    def test_page_write_only_reads_its_pages(self):
        preview = self.preview(pages=[1])
        self.assertEqual((preview["corrections"], preview["reason"]), ([], ocr_router.NO_PAGE_CORRECTIONS_MESSAGE))
        response = self.apply(pages=[1])
        self.assertEqual((response.status_code, response.json()["detail"]), (409, ocr_router.NO_PAGE_CORRECTIONS_MESSAGE))

    def test_whole_document_write_updates_the_document_after_page_writes(self):
        self.assertEqual(self.apply(pages=[0]).status_code, 200)
        preview = self.preview()
        self.assertEqual((preview["corrections"], preview["reason"], preview["update_pending"]), ([], None, True))
        response = self.apply()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        tei = self.repo.get_file_by_stable_id("tei1")
        assert tei is not None
        # a new version on the same PDF, updated by the extractor for it
        self.assertTrue(result["new_version"])
        self.assertEqual((result["pdf_stable_id"], result["corrections"]), (tei.pdf_stable_id, 0))
        pdf = self.repo.get_file_by_stable_id(result["pdf_stable_id"])
        assert pdf is not None
        _, _, _, pdf_hash, lines = self.handler_calls[0]
        self.assertEqual((pdf_hash, lines), (pdf.id, frozenset({0})))
        self.assertIn(pdf.id, result["xml"])
        changes = etree.fromstring(result["xml"].encode()).findall("{*}teiHeader/{*}revisionDesc/{*}change")
        self.assertEqual(changes[-1].findtext("{*}desc"), "Updated the document for the text corrections written into the text layer of its PDF page by page")
        # done: nothing is pending any more
        self.assertNotIn("pages", pdf.file_metadata["text_corrections"][-1])
        self.assertFalse(self.preview(stable_id=result["tei_stable_id"])["update_pending"])

    def test_page_write_of_frozen_version_is_refused(self):
        self.insert(self.save(tei_xml(LINES).encode(), "tei"), "tei", stable_id="tei3", variant=VARIANT, doc_collections=["c1"], version=3, parent_stable_id="tei1")
        response = self.apply(pages=[0])
        self.assertEqual((response.status_code, response.json()["detail"]), (409, ocr_router.FROZEN_MESSAGE))
        self.assertEqual(self.repo.get_file_by_stable_id("tei1").pdf_stable_id, "pdf1")  # type: ignore[union-attr]

    def cancel_while_reading(self) -> None:
        """Cancel the job of the request while it reads the lines of the document."""
        def layout(xml: str, doc_id: str) -> LineLayout | None:
            self.cancel_job(self.running_job_id)
            return self.layout
        unregister_layout_provider(VARIANT)
        register_layout_provider(VARIANT, "test", layout)

    def assert_cancelled(self, response: Any, job_id: str) -> None:
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"], {"code": "cancelled", "message": ocr_router.CANCELLED_MESSAGE})
        self.wait_for_job(job_id, "cancelled")
        # nothing was changed
        self.assertEqual([p.stable_id for p in self.repo.get_document_pdfs("doc1")], ["pdf1"])
        tei = self.repo.get_file_by_stable_id("tei1")
        assert tei is not None
        self.assertEqual(tei.pdf_stable_id, "pdf1")
        self.assertEqual(self.storage.read_file(tei.id, "tei"), tei_xml(corrected(LINES)).encode())
        self.assertEqual(self.repo.get_latest_tei_version("doc1", VARIANT).stable_id, "tei2")  # type: ignore[union-attr]

    def test_cancel_preview(self):
        self.cancel_while_reading()
        job_id = self.submit_job("preview")
        with self.assertLogs("fastapi_app.routers.ocr", level="INFO"):
            response = self.client.post("/ocr/text-corrections/preview", json={"stable_id": "tei1", "job_id": job_id})
        self.assert_cancelled(response, job_id)

    def test_cancel_write_of_pages(self):
        self.cancel_while_reading()
        job_id = self.submit_job()
        with self.assertLogs("fastapi_app.routers.ocr", level="INFO"):
            response = self.apply(pages=[0], job_id=job_id)
        self.assert_cancelled(response, job_id)

    def test_cancel_write_while_the_extractor_runs(self):
        stored = set(self.stored_pdfs())
        self.assertTrue(stored)
        self.cancel_in_handler = True
        job_id = self.submit_job()
        with self.assertLogs("fastapi_app.routers.ocr", level="INFO"):
            response = self.apply(job_id=job_id)
        self.assertEqual(len(self.handler_calls), 1)
        self.assert_cancelled(response, job_id)
        # the corrected PDF stored for the extractor is removed again
        self.assertEqual(set(self.stored_pdfs()), stored)

    def test_the_cancel_route_is_gone(self):
        self.assertEqual(self.client.post("/ocr/text-corrections/cancel/p1").status_code, 404)

    def test_cancelling_an_unclaimed_job_finishes_it(self):
        # the client does so when its request fails before the route takes the job (e.g. a validation error)
        job_id = self.submit_job()
        self.assertEqual(self.client.post("/ocr/text-corrections/apply", json={"job_id": job_id}).status_code, 422)
        self.assertEqual(self.get_job(job_id)["status"], "queued")
        self.client.post(f"/api/v1/jobs/{job_id}/cancel")
        self.assertEqual(self.get_job(job_id)["status"], "cancelled")

    def stored_pdfs(self) -> list[Path]:
        return sorted((self.tmp / "files").rglob("*.pdf"))


if __name__ == "__main__":
    unittest.main()
