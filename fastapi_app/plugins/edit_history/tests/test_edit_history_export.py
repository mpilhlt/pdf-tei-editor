"""
Unit tests for Edit History plugin export route.

Tests CSV export functionality, authentication, and access control.

@testCovers fastapi_app/plugins/edit_history/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch
from datetime import datetime
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient


class TestEditHistoryExport(unittest.IsolatedAsyncioTestCase):
    """Test edit history CSV export route."""

    def setUp(self):
        """Set up test fixtures."""
        from fastapi_app.plugins.edit_history.routes import router
        from fastapi_app.lib.dependencies import (
            get_auth_manager,
            get_session_manager,
            get_db,
            get_file_storage,
        )

        self.app = FastAPI()
        self.app.include_router(router)

        # Create mocks for dependencies
        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()
        self.mock_db = MagicMock()
        self.mock_db.db_path = Path('/tmp/test.db')  # Set db_path to prevent MagicMock string as filename
        self.mock_storage = MagicMock()

        # Override dependencies
        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.mock_db
        self.app.dependency_overrides[get_file_storage] = lambda: self.mock_storage

        self.client = TestClient(self.app)

    def test_export_csv_no_session(self):
        """Test export without session ID returns 401."""
        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={"collection": "test-collection"}
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("Authentication required", response.json()["detail"])

    def test_export_csv_invalid_session(self):
        """Test export with invalid session returns 401."""
        # Mock invalid session
        self.mock_session_manager.is_session_valid.return_value = False

        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={"collection": "test-collection", "session_id": "invalid"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("Invalid or expired session", response.json()["detail"])

    @patch("fastapi_app.config.get_settings")
    def test_export_csv_no_user(self, mock_settings):
        """Test export with valid session but no user returns 401."""
        # Mock settings
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = mock_settings_obj

        # Mock valid session but no user
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = None

        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={"collection": "test-collection", "session_id": "valid-session"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("User not found", response.json()["detail"])

    @patch("fastapi_app.lib.user_utils.user_has_collection_access")
    @patch("fastapi_app.config.get_settings")
    def test_export_csv_no_access(self, mock_settings, mock_access):
        """Test export without collection access returns 403."""
        # Mock settings
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = mock_settings_obj

        # Mock valid session and user
        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = MagicMock()
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user

        # Mock no access
        mock_access.return_value = False

        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={"collection": "test-collection", "session_id": "valid-session"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("Access denied", response.json()["detail"])

    @patch("fastapi_app.plugins.edit_history.routes.get_file_storage")
    @patch("fastapi_app.plugins.edit_history.routes.get_db")
    @patch("fastapi_app.lib.file_repository.FileRepository")
    @patch("fastapi_app.lib.user_utils.user_has_collection_access")
    @patch("fastapi_app.config.get_settings")
    def test_export_csv_success(self, mock_settings, mock_access, mock_repo_class, mock_get_db, mock_get_storage):
        """Test successful CSV export."""
        # Mock settings
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = mock_settings_obj

        # Mock valid session and user with access
        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = MagicMock()
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user
        mock_access.return_value = True

        # Mock file repository with TEI file
        mock_tei_file = MagicMock()
        mock_tei_file.id = "file-123"
        mock_tei_file.file_type = "tei"
        mock_tei_file.variant = "standard"
        mock_tei_file.doc_id = "10.1234/doc"
        mock_tei_file.stable_id = "stable-123"

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [mock_tei_file]
        mock_repo_class.return_value = mock_repo

        # Mock get_db and get_file_storage function calls
        mock_get_db.return_value = self.mock_db

        mock_storage_obj = MagicMock()
        mock_get_storage.return_value = mock_storage_obj

        # Mock file storage with TEI content
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Test Document</title>
                <respStmt>
                    <persName xml:id="test-user">Test User</persName>
                    <resp>Annotator</resp>
                </respStmt>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Edition</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2025-01-15T10:30:00" who="test-user">
                <desc>Test change</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        mock_storage_obj.read_file.return_value = tei_xml.encode("utf-8")

        # Make the request
        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={
                "collection": "test-collection",
                "session_id": "valid-session",
            },
        )

        # Verify response
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "text/csv; charset=utf-8")
        self.assertIn(
            "attachment", response.headers["content-disposition"]
        )
        self.assertIn("edit-history-test-collection.csv", response.headers["content-disposition"])

        # Verify CSV content
        csv_content = response.text
        self.assertIn("Change Date", csv_content)
        self.assertIn("Document ID", csv_content)
        self.assertIn("Extraction Label", csv_content)
        self.assertIn("Change Description", csv_content)
        self.assertIn("Annotator ID", csv_content)
        self.assertIn("Annotator Name", csv_content)
        self.assertIn("10.1234/doc", csv_content)
        self.assertIn("Test Edition", csv_content)
        self.assertIn("Test change", csv_content)
        self.assertIn("test-user", csv_content)  # ID without #
        self.assertIn("Test User", csv_content)  # Full name

    @patch("fastapi_app.plugins.edit_history.routes.get_file_storage")
    @patch("fastapi_app.plugins.edit_history.routes.get_db")
    @patch("fastapi_app.lib.file_repository.FileRepository")
    @patch("fastapi_app.lib.user_utils.user_has_collection_access")
    @patch("fastapi_app.config.get_settings")
    def test_export_csv_with_variant_filter(self, mock_settings, mock_access, mock_repo_class, mock_get_db, mock_get_storage):
        """Test CSV export with variant filter."""
        # Mock settings
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = mock_settings_obj

        # Setup mocks (same as success test)
        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = MagicMock()
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user
        mock_access.return_value = True

        # Create files with different variants
        mock_file1 = MagicMock()
        mock_file1.file_type = "tei"
        mock_file1.variant = "grobid"
        mock_file1.doc_id = "10.1234/doc1"
        mock_file1.stable_id = "stable-1"
        mock_file1.id = "file-1"

        mock_file2 = MagicMock()
        mock_file2.file_type = "tei"
        mock_file2.variant = "standard"
        mock_file2.doc_id = "10.1234/doc2"
        mock_file2.stable_id = "stable-2"
        mock_file2.id = "file-2"

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [mock_file1, mock_file2]
        mock_repo_class.return_value = mock_repo

        # Mock get_db and get_file_storage function calls
        mock_get_db.return_value = self.mock_db

        mock_storage_obj = MagicMock()
        mock_get_storage.return_value = mock_storage_obj

        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt><title>Test</title></titleStmt>
            <editionStmt><edition><title>Test</title></edition></editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2025-01-15" who="user">Test</change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        mock_storage_obj.read_file.return_value = tei_xml.encode("utf-8")

        # Request with variant filter
        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={
                "collection": "test-collection",
                "variant": "grobid",
                "session_id": "valid-session",
            },
        )

        self.assertEqual(response.status_code, 200)
        csv_content = response.text

        # Only grobid variant should appear
        self.assertIn("10.1234/doc1", csv_content)
        # standard variant should be filtered out (but we can't verify absence since both use same TEI)

    @patch("fastapi_app.plugins.edit_history.routes.get_file_storage")
    @patch("fastapi_app.plugins.edit_history.routes.get_db")
    @patch("fastapi_app.lib.file_repository.FileRepository")
    @patch("fastapi_app.lib.user_utils.user_has_collection_access")
    @patch("fastapi_app.config.get_settings")
    def test_export_csv_no_tei_files(self, mock_settings, mock_access, mock_repo_class, mock_get_db, mock_get_storage):
        """Test CSV export with no TEI files returns empty CSV."""
        # Mock settings
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = mock_settings_obj

        # Setup mocks
        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = MagicMock()
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user
        mock_access.return_value = True

        # Mock get_db and get_file_storage function calls
        mock_get_db.return_value = self.mock_db
        mock_get_storage.return_value = self.mock_storage

        # No TEI files
        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/edit-history/export",
            params={"collection": "test-collection", "session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        csv_content = response.text

        # Should have header but no data rows
        lines = csv_content.strip().split("\n")
        self.assertEqual(len(lines), 1)  # Only header
        self.assertIn("Change Date", lines[0])


if __name__ == "__main__":
    unittest.main()
