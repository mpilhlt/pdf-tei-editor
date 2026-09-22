"""
Unit tests for the refresh-annotation-rules preview/execute HTTP routes.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py -v

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
from fastapi_app.plugins.grobid.annotation_rules_refresh import RefreshResult
from fastapi_app.plugins.grobid.routes import router

TEI_TEMPLATE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="model">segmentation</label>
          <label type="flavor">default</label>
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""


def make_tei_file(stable_id="tei-1", file_id="hash-old"):
    content = TEI_TEMPLATE.encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content),
    )
    return meta, content


class BaseRouteTest(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)

        self.session_manager = mock.MagicMock()
        self.session_manager.is_session_valid.return_value = True
        self.auth_manager = mock.MagicMock()
        self.auth_manager.get_user_by_session_id.return_value = {
            "username": "reviewer1", "roles": ["reviewer"]
        }
        self.db = mock.MagicMock()
        self.file_storage = mock.MagicMock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

        self.client = TestClient(self.app)

    def tearDown(self):
        self.app.dependency_overrides.clear()


class TestRefreshAnnotationRulesPreview(BaseRouteTest):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_preview_shows_confirmation_for_valid_document(self, _mock_access):
        from fastapi_app.lib.repository.file_repository import FileRepository
        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta):
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/preview",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("grobid.training.segmentation", response.text)

    def test_preview_shows_error_for_missing_document(self):
        from fastapi_app.lib.repository.file_repository import FileRepository
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=None):
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/preview",
                params={"xml": "missing", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("No TEI document open", response.text)

    def test_preview_requires_authentication(self):
        response = self.client.get(
            "/api/plugins/grobid/refresh-annotation-rules/preview",
            params={"xml": "tei-1"},
        )
        self.assertEqual(response.status_code, 401)

    def test_preview_requires_reviewer_role(self):
        self.auth_manager.get_user_by_session_id.return_value = {
            "username": "user1", "roles": ["user"],
        }
        response = self.client.get(
            "/api/plugins/grobid/refresh-annotation-rules/preview",
            params={"xml": "tei-1", "session_id": "sess-1"},
        )
        self.assertEqual(response.status_code, 403)

    def test_preview_blocks_reviewer_without_document_write_access(self):
        from fastapi_app.lib.repository.file_repository import FileRepository
        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta), mock.patch(
            "fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access",
            return_value=False,
        ) as mock_check:
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/preview",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("permission", response.text)
        mock_check.assert_called_once()
        self.assertEqual(mock_check.call_args[0][2], "edit")


class TestRefreshAnnotationRulesExecute(BaseRouteTest):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.perform_refresh")
    def test_execute_calls_perform_refresh_and_renders_result(self, mock_perform, _mock_access):
        from fastapi_app.lib.repository.file_repository import FileRepository

        async def fake_perform(*args, **kwargs):
            return RefreshResult(entry_count=1, changed=True)
        mock_perform.side_effect = fake_perform

        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta):
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/execute",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("updated", response.text.lower())
        mock_perform.assert_called_once()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.perform_refresh")
    def test_execute_reports_already_up_to_date(self, mock_perform, _mock_access):
        from fastapi_app.lib.repository.file_repository import FileRepository

        async def fake_perform(*args, **kwargs):
            return RefreshResult(entry_count=2, changed=False)
        mock_perform.side_effect = fake_perform

        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta):
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/execute",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("already up to date", response.text)

    def test_execute_requires_reviewer_role(self):
        self.auth_manager.get_user_by_session_id.return_value = {
            "username": "user1", "roles": ["user"],
        }
        response = self.client.get(
            "/api/plugins/grobid/refresh-annotation-rules/execute",
            params={"xml": "tei-1", "session_id": "sess-1"},
        )
        self.assertEqual(response.status_code, 403)

    def test_execute_shows_precondition_error_when_no_document(self):
        from fastapi_app.lib.repository.file_repository import FileRepository
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=None):
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/execute",
                params={"xml": "missing", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("No TEI document open", response.text)

    def test_execute_blocks_reviewer_without_document_write_access(self):
        from fastapi_app.lib.repository.file_repository import FileRepository
        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta), mock.patch(
            "fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access",
            return_value=False,
        ), mock.patch(
            "fastapi_app.plugins.grobid.annotation_rules_refresh.perform_refresh",
            new=mock.AsyncMock(),
        ) as mock_perform:
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/execute",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("permission", response.text)
        mock_perform.assert_not_awaited()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    @mock.patch(
        "fastapi_app.plugins.grobid.annotation_rules_refresh.perform_refresh",
        new=mock.AsyncMock(side_effect=RuntimeError("Could not parse document XML for refresh: bad xml")),
    )
    def test_execute_shows_error_when_refresh_fails(self, _mock_access):
        from fastapi_app.lib.repository.file_repository import FileRepository
        meta, content = make_tei_file()
        with mock.patch.object(FileRepository, "get_file_by_stable_id", return_value=meta):
            self.file_storage.read_file.return_value = content
            response = self.client.get(
                "/api/plugins/grobid/refresh-annotation-rules/execute",
                params={"xml": "tei-1", "session_id": "sess-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn("Could not parse document XML for refresh", response.text)


if __name__ == "__main__":
    unittest.main()
