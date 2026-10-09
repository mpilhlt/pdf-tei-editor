"""
Unit tests for the revision feed plugin's public, token-authenticated feed route.

@testCovers fastapi_app/plugins/revision_feed/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

TEI_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Sample</title></titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-01-01T10:00:00" who="jdoe" status="approved">
        <desc>Reviewed</desc>
      </change>
    </revisionDesc>
  </teiHeader>
</TEI>"""


class TestFeedRoute(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.revision_feed.routes import router
        from fastapi_app.lib.core.dependencies import get_auth_manager, get_db, get_file_storage

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_db = MagicMock()
        self.mock_storage = MagicMock()
        self.mock_auth_manager = MagicMock()

        self.app.dependency_overrides[get_db] = lambda: self.mock_db
        self.app.dependency_overrides[get_file_storage] = lambda: self.mock_storage
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager

        self.client = TestClient(self.app)

    def test_missing_token_returns_422(self):
        response = self.client.get("/api/plugins/revision-feed/feed/proj-1.atom")
        self.assertEqual(response.status_code, 422)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.config.get_settings")
    def test_unknown_token_returns_401(self, mock_settings, mock_resolve):
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj
        mock_resolve.return_value = None

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "bad-token"}
        )
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.config.get_settings")
    def test_unknown_project_returns_403(self, mock_settings, mock_get_projects, mock_resolve):
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        self.mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}
        mock_get_projects.return_value = []

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )
        self.assertEqual(response.status_code, 403)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.permissions.user_utils.user_has_collection_access")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.config.get_settings")
    def test_project_exists_but_user_lost_access_returns_403(
        self, mock_settings, mock_get_projects, mock_access, mock_resolve
    ):
        """User's token is valid, but they were since removed from the project."""
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        self.mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}

        mock_get_projects.return_value = [
            {"id": "proj-1", "name": "Project One", "collections": ["col-1"]}
        ]
        mock_access.return_value = False  # no longer a member of any of the project's collections

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )
        self.assertEqual(response.status_code, 403)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.permissions.user_utils.user_has_collection_access")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.config.get_settings")
    def test_success_returns_atom_feed(
        self,
        mock_settings,
        mock_get_config,
        mock_repo_class,
        mock_get_projects,
        mock_access,
        mock_resolve,
    ):
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        self.mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}

        mock_get_projects.return_value = [
            {"id": "proj-1", "name": "Project One", "collections": ["col-1"]}
        ]
        mock_access.return_value = True

        mock_config = MagicMock()
        mock_config.get.return_value = ["approved"]
        mock_get_config.return_value = mock_config

        mock_file = MagicMock()
        mock_file.id = "file-1"
        mock_file.file_type = "tei"
        mock_file.stable_id = "stable-1"
        mock_file.doc_id = "doc-1"
        mock_file.label = "Sample Doc"

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [mock_file]
        mock_repo_class.return_value = mock_repo

        self.mock_storage.read_file.return_value = TEI_SAMPLE.encode("utf-8")

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("atom+xml", response.headers["content-type"])
        self.assertIn("Sample Doc", response.text)
        self.assertIn("approved", response.text)

    @patch("fastapi_app.plugins.revision_feed.token_store.resolve_token")
    @patch("fastapi_app.lib.permissions.user_utils.user_has_collection_access")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.config.get_settings")
    def test_malformed_file_is_skipped_but_feed_still_renders(
        self,
        mock_settings,
        mock_get_config,
        mock_repo_class,
        mock_get_projects,
        mock_access,
        mock_resolve,
    ):
        """One file has malformed XML; the rest of the feed should still render."""
        mock_settings_obj = MagicMock()
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        mock_resolve.return_value = "alice"
        self.mock_auth_manager.get_user_by_username.return_value = {"username": "alice", "roles": ["user"]}

        mock_get_projects.return_value = [
            {"id": "proj-1", "name": "Project One", "collections": ["col-1"]}
        ]
        mock_access.return_value = True

        mock_config = MagicMock()
        mock_config.get.return_value = ["approved"]
        mock_get_config.return_value = mock_config

        mock_bad_file = MagicMock()
        mock_bad_file.id = "file-bad"
        mock_bad_file.file_type = "tei"
        mock_bad_file.stable_id = "stable-bad"
        mock_bad_file.doc_id = "doc-bad"
        mock_bad_file.label = "Broken Doc"

        mock_good_file = MagicMock()
        mock_good_file.id = "file-1"
        mock_good_file.file_type = "tei"
        mock_good_file.stable_id = "stable-1"
        mock_good_file.doc_id = "doc-1"
        mock_good_file.label = "Sample Doc"

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [mock_bad_file, mock_good_file]
        mock_repo_class.return_value = mock_repo

        def read_file_side_effect(file_id, file_type):
            if file_id == "file-bad":
                return b"<not-well-formed-xml"
            return TEI_SAMPLE.encode("utf-8")

        self.mock_storage.read_file.side_effect = read_file_side_effect

        response = self.client.get(
            "/api/plugins/revision-feed/feed/proj-1.atom", params={"token": "tok_abc"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("atom+xml", response.headers["content-type"])
        self.assertIn("Sample Doc", response.text)
        self.assertNotIn("Broken Doc", response.text)


if __name__ == "__main__":
    unittest.main()
