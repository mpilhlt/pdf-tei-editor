"""
Unit tests for the reload-feature-file preview/execute HTTP routes.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_reload_feature_file_routes.py -v

@testCovers fastapi_app/plugins/grobid/routes.py
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_auth_manager, get_db, get_file_storage, get_session_manager
from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.plugins.grobid.reload_feature_file import ReloadResult
from fastapi_app.plugins.grobid.routes import router

TEI_TEMPLATE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="model">segmentation</label>
          <label type="flavor">default</label>
          <label type="variant-id">grobid.training.segmentation</label>
          <label type="revision">{revision}</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""


def make_tei_file(stable_id="tei-1", file_id="hash-old", revision="rev-1"):
    content = TEI_TEMPLATE.format(revision=revision).encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content),
    )
    return meta, content


def make_pdf_file(file_id="pdf-hash"):
    return FileMetadata(
        id=file_id,
        stable_id="pdf-1",
        filename="doc.pdf",
        doc_id="doc-1",
        file_type="pdf",
        file_size=100,
    )


class ReloadFeatureFileRoutesTestCase(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_session_manager = mock.Mock()
        self.mock_session_manager.is_session_valid.return_value = True

        self.mock_auth_manager = mock.Mock()
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "reviewer1",
            "roles": ["reviewer"],
        }

        self.mock_db = mock.Mock()

        self.file_repo = mock.Mock()
        self.file_storage = mock.Mock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.mock_db
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

        self.client = TestClient(self.app)

        settings_patch = mock.patch(
            "fastapi_app.config.get_settings",
            return_value=mock.Mock(session_timeout=3600),
        )
        settings_patch.start()
        self.addCleanup(settings_patch.stop)

        file_repo_patch = mock.patch(
            "fastapi_app.lib.repository.file_repository.FileRepository",
            return_value=self.file_repo,
        )
        file_repo_patch.start()
        self.addCleanup(file_repo_patch.stop)

    def _set_up_valid_target(self, revision="rev-1"):
        meta, content = make_tei_file(revision=revision)
        pdf_meta = make_pdf_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_repo.get_pdf_for_document.return_value = pdf_meta
        self.file_storage.read_file.return_value = content
        self.file_storage.get_file_path.return_value = Path("/fake/doc.pdf")
        return meta

    # --- auth ---

    def test_preview_requires_authentication(self):
        response = self.client.get("/api/plugins/grobid/reload-feature-file/preview?xml=tei-1")
        self.assertEqual(response.status_code, 401)

    def test_preview_requires_reviewer_role(self):
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "user1",
            "roles": ["user"],
        }
        response = self.client.get(
            "/api/plugins/grobid/reload-feature-file/preview?xml=tei-1&session_id=abc"
        )
        self.assertEqual(response.status_code, 403)

    def test_execute_requires_reviewer_role(self):
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "user1",
            "roles": ["user"],
        }
        response = self.client.get(
            "/api/plugins/grobid/reload-feature-file/execute?xml=tei-1&session_id=abc"
        )
        self.assertEqual(response.status_code, 403)

    # --- preview ---

    def test_preview_shows_precondition_error_when_no_document(self):
        self.file_repo.get_file_by_stable_id.return_value = None

        response = self.client.get(
            "/api/plugins/grobid/reload-feature-file/preview?xml=tei-1&session_id=abc"
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("No TEI document open", response.text)

    def test_preview_shows_live_revision_when_grobid_reachable(self):
        self._set_up_valid_target(revision="rev-1")

        with mock.patch(
            "fastapi_app.plugins.grobid.config.get_grobid_server_url",
            return_value="http://grobid.example",
        ), mock.patch(
            "fastapi_app.plugins.grobid.reload_feature_file.check_grobid_revision",
            return_value=("0.8.1", "rev-2"),
        ):
            response = self.client.get(
                "/api/plugins/grobid/reload-feature-file/preview?xml=tei-1&session_id=abc"
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("rev-1", response.text)
        self.assertIn("rev-2", response.text)
        self.assertIn("will be updated to match", response.text)

    def test_preview_reports_unreachable_grobid_without_failing(self):
        self._set_up_valid_target(revision="rev-1")

        with mock.patch(
            "fastapi_app.plugins.grobid.config.get_grobid_server_url",
            return_value="http://grobid.example",
        ), mock.patch(
            "fastapi_app.plugins.grobid.reload_feature_file.check_grobid_revision",
            side_effect=RuntimeError("Connection refused"),
        ):
            response = self.client.get(
                "/api/plugins/grobid/reload-feature-file/preview?xml=tei-1&session_id=abc"
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("Could not reach the GROBID server", response.text)

    # --- execute ---

    def test_execute_shows_precondition_error_when_no_document(self):
        self.file_repo.get_file_by_stable_id.return_value = None

        response = self.client.get(
            "/api/plugins/grobid/reload-feature-file/execute?xml=tei-1&session_id=abc"
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("No TEI document open", response.text)

    def test_execute_performs_reload_and_renders_result(self):
        self._set_up_valid_target(revision="rev-1")

        with mock.patch(
            "fastapi_app.plugins.grobid.config.get_grobid_server_url",
            return_value="http://grobid.example",
        ), mock.patch(
            "fastapi_app.plugins.grobid.reload_feature_file.perform_reload",
            new=mock.AsyncMock(
                return_value=ReloadResult(grobid_revision="rev-2", updated_label=True)
            ),
        ) as mock_perform:
            response = self.client.get(
                "/api/plugins/grobid/reload-feature-file/execute?xml=tei-1&session_id=abc"
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("rev-2", response.text)
        self.assertIn("sandbox.reloadCurrentDocument()", response.text)
        mock_perform.assert_awaited_once()

    def test_execute_shows_error_when_reload_fails(self):
        self._set_up_valid_target(revision="rev-1")

        with mock.patch(
            "fastapi_app.plugins.grobid.config.get_grobid_server_url",
            return_value="http://grobid.example",
        ), mock.patch(
            "fastapi_app.plugins.grobid.reload_feature_file.perform_reload",
            new=mock.AsyncMock(side_effect=RuntimeError("GROBID request failed")),
        ):
            response = self.client.get(
                "/api/plugins/grobid/reload-feature-file/execute?xml=tei-1&session_id=abc"
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("GROBID request failed", response.text)


if __name__ == "__main__":
    unittest.main()
