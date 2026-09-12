"""
Unit tests for Update Metadata plugin admin authentication.

Verifies that _authenticate_admin recognizes the wildcard "*" role,
not just the literal "admin" role string.

@testCovers fastapi_app/plugins/update_metadata/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


class TestUpdateMetadataAdminAuth(unittest.IsolatedAsyncioTestCase):
    """Test admin authentication on the update-metadata plugin's /options route."""

    def setUp(self):
        """Set up test fixtures."""
        from fastapi_app.plugins.update_metadata.routes import router
        from fastapi_app.lib.core.dependencies import (
            get_auth_manager,
            get_session_manager,
        )
        from fastapi_app.config import get_settings

        self.real_settings = get_settings()

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()

        self.mock_session_manager.is_session_valid.return_value = True

        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager

        self.client = TestClient(self.app)

    @patch("fastapi_app.lib.plugins.plugin_tools.get_settings")
    @patch("fastapi_app.config.get_settings")
    def test_options_wildcard_admin_role_allowed(self, mock_settings, mock_plugin_tools_settings):
        """A user whose roles include only the wildcard '*' (the actual admin
        account shape in data/db/users.json) must be treated as admin."""
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings.return_value = mock_settings_obj
        mock_plugin_tools_settings.return_value = self.real_settings

        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "admin",
            "roles": ["*", "reviewer"],
        }

        response = self.client.get(
            "/api/plugins/update-metadata/options",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 200)

    @patch("fastapi_app.config.get_settings")
    def test_options_non_admin_role_rejected(self, mock_settings):
        """A user without admin or wildcard roles must still be rejected."""
        mock_settings_obj = MagicMock()
        mock_settings_obj.session_timeout = 3600
        mock_settings.return_value = mock_settings_obj

        self.mock_auth_manager.get_user_by_session_id.return_value = {
            "username": "reviewer1",
            "roles": ["reviewer"],
        }

        response = self.client.get(
            "/api/plugins/update-metadata/options",
            params={"session_id": "valid-session"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertIn("Admin role required", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
