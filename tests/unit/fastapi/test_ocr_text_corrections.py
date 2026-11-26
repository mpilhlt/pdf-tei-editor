"""
Unit tests for the routes that write the text corrections of a TEI document into the PDF's OCR
text layer (#931).

@testCovers fastapi_app/routers/ocr.py::preview_text_corrections
@testCovers fastapi_app/routers/ocr.py::apply_text_corrections
@testCovers fastapi_app/lib/repository/file_repository.py::get_current_pdf_teis
@testCovers fastapi_app/lib/models/models_ocr.py
"""

import gc
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pikepdf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, get_session_manager, get_sse_service, require_authenticated_user
from fastapi_app.lib.core.locking import acquire_lock, check_lock
from fastapi_app.lib.models.models import FileCreate, FileMetadata
from fastapi_app.lib.ocr.jobs import OcrJobStore
from fastapi_app.lib.ocr.text_corrections import CorrectedPdfMismatch, register_corrected_pdf_handler, unregister_corrected_pdf_handler
from fastapi_app.lib.ocr.text_layer import read_text_layer
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.tei.layout import LineLayout, register_layout_provider, unregister_layout_provider
from fastapi_app.lib.tei.zone_lines import ZoneLabel
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
        register_corrected_pdf_handler(VARIANT, "test", self.handler)

        self.allowed = True
        self.access = patch.object(ocr_router, "check_file_access", lambda file, user, op: self.allowed)
        self.access.start()
        self.jobs = OcrJobStore(self.tmp / "jobs")
        self.user: dict[str, Any] = REVIEWER
        app = FastAPI()
        app.include_router(ocr_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        app.dependency_overrides[ocr_router.get_ocr_job_store] = lambda: self.jobs
        app.dependency_overrides[get_sse_service] = lambda: MagicMock()
        app.dependency_overrides[get_session_manager] = lambda: MagicMock()
        self.client = TestClient(app, headers={"X-Session-ID": SESSION})

    def tearDown(self):
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

    def test_get_current_pdf_teis(self):
        self.assertEqual(sorted(f.stable_id for f in self.repo.get_current_pdf_teis("doc1")), ["tei1", "tei2"])
        self.repo.delete_file(self.other.id, stable_id="tei2")
        self.assertEqual([f.stable_id for f in self.repo.get_current_pdf_teis("doc1")], ["tei1"])

    def test_preview_lists_corrections(self):
        preview = self.preview()
        self.assertIsNone(preview["reason"])
        self.assertEqual(preview["corrections"], [{"page": 0, "line": 0, "old": "Regel’).", "new": "Regel12)."}])
        self.assertEqual(preview["unwritable"], [])
        self.assertEqual(preview["affected_files"], [{"stable_id": "tei2", "label": "Other version"}])

    def test_apply_replaces_pdf_and_returns_xml(self):
        response = self.apply()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        pdf = self.repo.get_file_by_stable_id("pdf1")
        assert pdf is not None
        self.assertNotEqual(pdf.id, self.pdf_hash)
        self.assertEqual(result["pdf_stable_id"], "pdf1")
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
        # the old content is archived, and the versions are linked to it
        archived = self.repo.get_file_by_stable_id(result["archived_stable_id"])
        assert archived is not None
        self.assertEqual(archived.id, self.pdf_hash)
        self.assertEqual(self.repo.get_file_by_stable_id("tei2").pdf_stable_id, archived.stable_id)  # type: ignore[union-attr]
        self.assertEqual(self.repo.get_file_by_stable_id("tei1").pdf_stable_id, archived.stable_id)  # type: ignore[union-attr]
        record = pdf.file_metadata["text_corrections"][-1]
        self.assertEqual(record["applied_by"], "rev")
        self.assertEqual(record["tei_stable_id"], "tei1")
        self.assertEqual(record["corrections"], [{"page": 0, "old": "Regel’).", "new": "Regel12)."}])
        self.assertIn("applied_at", record)
        # the handler got the corrected PDF and the corrected lines
        _, doc_id, pdf_path, pdf_hash, lines = self.handler_calls[0]
        self.assertEqual((doc_id, pdf_hash, lines), ("doc1", pdf.id, frozenset({0})))

    def test_archived_version_is_refused(self):
        self.repo.replace_pdf_content("pdf1", self.save(b"%PDF other", "pdf"), 10, {})
        message = "This version was made from an earlier PDF of the document. Open a version based on the current PDF."
        self.assertEqual(self.preview()["reason"], message)
        response = self.apply()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], message)

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
        self.assertEqual(sorted(f["stable_id"] for f in preview["affected_files"]), ["tei1", "tei2"])

    def test_pdf_changed_during_apply_conflicts(self):
        other_hash = self.save(b"%PDF other", "pdf")

        def replace_meanwhile(xml: str, doc_id: str, pdf_path: Path, pdf_hash: str, lines: frozenset[int]) -> str:
            self.repo.replace_pdf_content("pdf1", other_hash, 10, {"ocr": {"engine": "other"}})
            return xml

        register_corrected_pdf_handler(VARIANT, "test", replace_meanwhile)
        response = self.apply()
        self.assertEqual(response.status_code, 409, response.text)
        pdf = self.repo.get_file_by_stable_id("pdf1")
        assert pdf is not None
        self.assertEqual(pdf.id, other_hash)
        self.assertEqual(pdf.file_metadata, {"ocr": {"engine": "other"}})

    def test_ocr_job_started_during_apply_conflicts(self):
        def start_job(xml: str, doc_id: str, pdf_path: Path, pdf_hash: str, lines: frozenset[int]) -> str:
            self.jobs.create("pdf1", "someone")
            return xml

        register_corrected_pdf_handler(VARIANT, "test", start_job)
        self.assertEqual(self.apply().status_code, 409)
        self.assertEqual(self.repo.get_file_by_stable_id("pdf1").id, self.pdf_hash)  # type: ignore[union-attr]

    def test_replace_value_error_is_409(self):
        with patch.object(self.repo, "replace_pdf_content", side_effect=ValueError("The content of PDF pdf1 is unchanged")):
            with self.assertLogs("fastapi_app.routers.ocr", level="WARNING"):
                response = self.apply()
        self.assertEqual(response.status_code, 409)

    def test_active_ocr_job_conflicts(self):
        self.jobs.create("pdf1", "someone")
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
        self.assertIsNone(self.repo.get_file_by_stable_id("tei2").pdf_stable_id)  # type: ignore[union-attr]

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
        pdf = self.repo.get_file_by_stable_id("pdf1")
        assert pdf is not None
        version = self.repo.get_file_by_stable_id(result["tei_stable_id"])
        assert version is not None
        # a new version based on the corrected (current) PDF, made from the edited TEI
        self.assertNotIn(version.stable_id, ("tei1", "tei2"))
        self.assertEqual((version.file_type, version.doc_id, version.variant, version.version), ("tei", "doc1", VARIANT, 3))
        self.assertIsNone(version.pdf_stable_id)
        self.assertEqual(version.parent_stable_id, "tei1")
        self.assertEqual(version.created_by, "rev")
        self.assertEqual(version.doc_collections, ["c1"])
        content = self.storage.read_file(version.id, "tei")
        assert content is not None
        self.assertEqual(content.decode("utf-8"), result["xml"])
        self.assertIn(f'<idno type="pdf-hash">{pdf.id}</idno>', result["xml"])
        # locked for the session that wrote the corrections
        self.assertTrue(check_lock(version.stable_id, "other-session", self.tmp, ocr_router.logger)["is_locked"])
        self.assertFalse(check_lock(version.stable_id, SESSION, self.tmp, ocr_router.logger)["is_locked"])
        # the edited TEI is linked to the archived PDF
        tei = self.repo.get_file_by_stable_id("tei1")
        assert tei is not None
        self.assertEqual(tei.pdf_stable_id, result["archived_stable_id"])
        # the new version can be corrected further, the edited one not
        self.assertNotEqual(self.preview(stable_id=version.stable_id)["reason"], ocr_router.ARCHIVED_VERSION_MESSAGE)
        response = self.apply()
        self.assertEqual((response.status_code, response.json()["detail"]), (409, ocr_router.ARCHIVED_VERSION_MESSAGE))

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


if __name__ == "__main__":
    unittest.main()
