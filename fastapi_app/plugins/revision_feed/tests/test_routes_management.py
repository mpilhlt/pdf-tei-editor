"""
Unit tests for the revision feed plugin's session-authenticated management routes.

@testCovers fastapi_app/plugins/revision_feed/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


class TestManagementRoutes(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.revision_feed.routes import router
        from fastapi_app.lib.core.dependencies import (
            get_auth_manager,
            get_session_manager,
        )

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()

        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager

        self.client = TestClient(self.app)

    def test_my_feeds_no_session_returns_401(self):
        response = self.client.get("/api/plugins/revision-feed/my-feeds")
        self.assertEqual(response.status_code, 401)

    def test_my_feeds_invalid_session_returns_401(self):
        self.mock_session_manager.is_session_valid.return_value = False

        response = self.client.get(
            "/api/plugins/revision-feed/my-feeds",
            params={"session_id": "invalid"},
        )
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.config.get_settings")
    def test_my_feeds_no_user_returns_401(self, mock_settings):
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings.return_value = mock_settings_obj

        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = None

        response = self.client.get(
            "/api/plugins/revision-feed/my-feeds",
            params={"session_id": "valid-session"},
        )
        self.assertEqual(response.status_code, 401)

    def test_regenerate_token_no_session_returns_401(self):
        response = self.client.post("/api/plugins/revision-feed/token/regenerate")
        self.assertEqual(response.status_code, 401)

    def test_regenerate_token_invalid_session_returns_401(self):
        self.mock_session_manager.is_session_valid.return_value = False

        response = self.client.post(
            "/api/plugins/revision-feed/token/regenerate",
            params={"session_id": "invalid"},
        )
        self.assertEqual(response.status_code, 401)

    @patch("fastapi_app.plugins.revision_feed.token_store.get_or_create_token")
    @patch("fastapi_app.lib.utils.project_utils.get_user_projects")
    @patch("fastapi_app.config.get_settings")
    def test_my_feeds_returns_token_and_urls(self, mock_settings, mock_get_projects, mock_get_token):
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = {"username": "alice", "roles": ["user"]}
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user

        mock_get_token.return_value = "tok_abc123"
        mock_get_projects.return_value = [{"id": "proj-1", "name": "Project One"}]

        response = self.client.get(
            "/api/plugins/revision-feed/my-feeds",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["token"], "tok_abc123")
        self.assertEqual(len(data["feeds"]), 1)
        self.assertEqual(data["feeds"][0]["project_id"], "proj-1")
        self.assertIn("token=tok_abc123", data["feeds"][0]["url"])
        self.assertIn("/api/plugins/revision-feed/feed/proj-1.atom", data["feeds"][0]["url"])

    @patch("fastapi_app.plugins.revision_feed.token_store.regenerate_token")
    @patch("fastapi_app.lib.utils.project_utils.get_user_projects")
    @patch("fastapi_app.config.get_settings")
    def test_regenerate_token_returns_new_token(self, mock_settings, mock_get_projects, mock_regenerate):
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = {"username": "alice", "roles": ["user"]}
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user

        mock_regenerate.return_value = "tok_new456"
        mock_get_projects.return_value = []

        response = self.client.post(
            "/api/plugins/revision-feed/token/regenerate",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["token"], "tok_new456")

    @patch("fastapi_app.plugins.revision_feed.token_store.get_or_create_token")
    @patch("fastapi_app.lib.utils.project_utils.get_projects_with_details")
    @patch("fastapi_app.lib.utils.project_utils.get_user_projects")
    @patch("fastapi_app.config.get_settings")
    def test_my_feeds_wildcard_role_returns_all_projects(
        self, mock_settings, mock_get_user_projects, mock_get_all_projects, mock_get_token
    ):
        """A user with a wildcard ('*') role gets every project, not just their memberships."""
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings_obj.db_dir = "/tmp/db"
        mock_settings_obj.plugins_data_dir = "/tmp/plugins"
        mock_settings.return_value = mock_settings_obj

        self.mock_session_manager.is_session_valid.return_value = True
        mock_user = {"username": "admin", "roles": ["*"]}
        self.mock_auth_manager.get_user_by_session_id.return_value = mock_user

        mock_get_token.return_value = "tok_admin123"
        # If the fix is correct, the wildcard path (get_projects_with_details) is used,
        # not the membership path (get_user_projects) -- so the response must reflect
        # the 2 projects from get_projects_with_details, not the 0 from get_user_projects.
        mock_get_all_projects.return_value = [
            {"id": "proj-1", "name": "Project One"},
            {"id": "proj-2", "name": "Project Two"},
        ]
        mock_get_user_projects.return_value = []

        response = self.client.get(
            "/api/plugins/revision-feed/my-feeds",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["feeds"]), 2)
        self.assertEqual({feed["project_id"] for feed in data["feeds"]}, {"proj-1", "proj-2"})
        mock_get_user_projects.assert_not_called()


if __name__ == "__main__":
    unittest.main()
