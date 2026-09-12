"""
Unit tests for Collection Coverage Overview plugin.

@testCovers fastapi_app/plugins/collection_overview/plugin.py
@testCovers fastapi_app/plugins/collection_overview/routes.py
"""

import asyncio
import unittest
from datetime import datetime
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.plugins.collection_overview.plugin import CollectionOverviewPlugin


class TestCollectionOverviewPlugin(unittest.TestCase):
    """Test cases for CollectionOverviewPlugin metadata and endpoint."""

    def setUp(self):
        self.plugin = CollectionOverviewPlugin()

    def test_metadata(self):
        metadata = self.plugin.metadata

        self.assertEqual(metadata["id"], "collection-overview")
        self.assertEqual(metadata["category"], "collection")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertEqual(metadata["dependencies"], ["annotation-progress"])
        self.assertEqual(len(metadata["endpoints"]), 1)

        endpoint = metadata["endpoints"][0]
        self.assertEqual(endpoint["name"], "show_overview")
        self.assertEqual(endpoint["state_params"], [])

    def test_get_endpoints(self):
        endpoints = self.plugin.get_endpoints()

        self.assertIn("show_overview", endpoints)
        self.assertTrue(callable(endpoints["show_overview"]))

    def test_show_overview_returns_urls(self):
        context = MagicMock()

        result = asyncio.run(self.plugin.show_overview(context, {}))

        self.assertEqual(result["outputUrl"], "/api/plugins/collection-overview/view")
        self.assertEqual(result["exportUrl"], "/api/plugins/collection-overview/export")


class TestCollectionOverviewRoutes(unittest.TestCase):
    """Test cases for the /view, /data, and /export routes."""

    def setUp(self):
        from fastapi_app.lib.core.dependencies import (
            get_auth_manager,
            get_db,
            get_session_manager,
        )
        from fastapi_app.plugins.collection_overview.routes import router

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()
        self.mock_db = MagicMock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.mock_db

        self.client = TestClient(self.app)

    def _mock_settings(self, mock_settings):
        settings_obj = MagicMock()
        settings_obj.session_timeout = 3600
        settings_obj.db_dir = "/tmp/db"
        mock_settings.return_value = settings_obj
        return settings_obj

    # -- /data --------------------------------------------------------------

    def test_data_no_session(self):
        response = self.client.get("/api/plugins/collection-overview/data")
        self.assertEqual(response.status_code, 401)
        self.assertIn("Authentication required", response.json()["detail"])

    def test_data_invalid_session(self):
        self.mock_session_manager.is_session_valid.return_value = False

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "invalid"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("Invalid or expired session", response.json()["detail"])

    @patch("fastapi_app.config.get_settings")
    def test_data_no_user(self, mock_settings):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = None

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn("User not found", response.json()["detail"])

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_data_scopes_to_accessible_collections(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }

        mock_list_collections.return_value = [
            {"id": "coll-a", "name": "Collection A"},
            {"id": "coll-b", "name": "Collection B"},
        ]
        mock_get_user_collections.return_value = ["coll-a"]

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["lifecycle_order"], ["draft", "final"])
        collection_ids = {row["collection_id"] for row in body["rows"]}
        self.assertEqual(collection_ids, {"coll-a"})

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_data_wildcard_access_includes_all_collections(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "admin", "roles": ["*"],
        }

        mock_list_collections.return_value = [
            {"id": "coll-a", "name": "Collection A"},
            {"id": "coll-b", "name": "Collection B"},
        ]
        mock_get_user_collections.return_value = None  # wildcard access

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        collection_ids = {row["collection_id"] for row in response.json()["rows"]}
        self.assertEqual(collection_ids, {"coll-a", "coll-b"})

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_data_returns_full_row_shape_with_real_data(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }

        mock_list_collections.return_value = [{"id": "coll-a", "name": "Collection A"}]
        mock_get_user_collections.return_value = ["coll-a"]

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        pdf = MagicMock(doc_id="doc1", file_type="pdf", variant=None)
        gold_tei = MagicMock(
            doc_id="doc1", file_type="tei", variant="grobid",
            label="Gold", stable_id="s1", status="final",
            updated_at=datetime(2024, 1, 2), is_gold_standard=True,
        )
        pdf2 = MagicMock(doc_id="doc2", file_type="pdf", variant=None)
        draft_tei = MagicMock(
            doc_id="doc2", file_type="tei", variant="grobid",
            label="Draft", stable_id="s2", status="draft",
            updated_at=datetime(2024, 1, 1), is_gold_standard=False,
        )
        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [pdf, gold_tei, pdf2, draft_tei]
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/data",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        rows = response.json()["rows"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(
            set(row.keys()),
            {"collection_id", "collection_name", "variant", "total_docs",
             "gold_count", "avg_progress", "stage_counts"},
        )
        self.assertEqual(row["variant"], "grobid")
        self.assertEqual(row["total_docs"], 2)
        self.assertEqual(row["gold_count"], 1)
        self.assertEqual(row["stage_counts"]["draft"], 1)
        self.assertEqual(row["stage_counts"]["final"], 1)

    # -- /view ----------------------------------------------------------------

    def test_view_requires_authentication(self):
        response = self.client.get("/api/plugins/collection-overview/view")
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.lib.plugins.plugin_tools.load_plugin_html")
    @patch("fastapi_app.config.get_settings")
    def test_view_success(self, mock_settings, mock_load_html):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }
        mock_load_html.return_value = "<html><body>Coverage Overview</body></html>"

        response = self.client.get(
            "/api/plugins/collection-overview/view",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("Coverage Overview", response.text)

    # -- /export --------------------------------------------------------------

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_export_returns_csv(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }

        mock_list_collections.return_value = [{"id": "coll-a", "name": "Collection A"}]
        mock_get_user_collections.return_value = ["coll-a"]

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = []
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/export",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/csv", response.headers["content-type"])
        self.assertIn("Collection ID", response.text)
        self.assertIn("coll-a", response.text)

    @patch("fastapi_app.lib.repository.file_repository.FileRepository")
    @patch("fastapi_app.lib.utils.config_utils.get_config")
    @patch("fastapi_app.lib.utils.collection_utils.list_collections")
    @patch("fastapi_app.lib.permissions.user_utils.get_user_collections")
    @patch("fastapi_app.config.get_settings")
    def test_export_csv_data_row_values(
        self, mock_settings, mock_get_user_collections, mock_list_collections,
        mock_get_config, mock_repo_class,
    ):
        self._mock_settings(mock_settings)
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "alice", "roles": ["user"],
        }

        mock_list_collections.return_value = [{"id": "coll-a", "name": "Collection A"}]
        mock_get_user_collections.return_value = ["coll-a"]

        mock_config = MagicMock()
        mock_config.get.return_value = ["draft", "final"]
        mock_get_config.return_value = mock_config

        pdf = MagicMock(doc_id="doc1", file_type="pdf", variant=None)
        gold_tei = MagicMock(
            doc_id="doc1", file_type="tei", variant="grobid",
            label="Gold", stable_id="s1", status="final",
            updated_at=datetime(2024, 1, 2), is_gold_standard=True,
        )
        mock_repo = MagicMock()
        mock_repo.get_files_by_collection.return_value = [pdf, gold_tei]
        mock_repo_class.return_value = mock_repo

        response = self.client.get(
            "/api/plugins/collection-overview/export",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        lines = response.text.strip().splitlines()
        self.assertEqual(len(lines), 2)  # header + one data row
        data_row = lines[1].split(",")
        self.assertEqual(data_row[0], "coll-a")
        self.assertEqual(data_row[2], "grobid")  # Variant
        self.assertEqual(data_row[3], "1")  # Documents
        self.assertEqual(data_row[4], "1")  # Gold Standard Count
        self.assertEqual(data_row[5], "100")  # Gold Standard %
        self.assertEqual(data_row[7], "final")  # Dominant Stage


if __name__ == "__main__":
    unittest.main()
