"""
Unit tests for plugin window launch tokens and the plugin session cookie.

@testCovers fastapi_app/lib/plugins/plugin_window_auth.py
@testCovers fastapi_app/lib/core/sessions.py
@testCovers fastapi_app/routers/plugins.py
"""

import gc
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi import FastAPI, Header, Query
from fastapi.testclient import TestClient

from fastapi_app.lib.core.db_utils import close_all_connections
from fastapi_app.lib.core.dependencies import get_session_manager
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.plugins.plugin_window_auth import PLUGIN_SESSION_COOKIE, PluginWindowAuthMiddleware
from fastapi_app.routers import plugins as plugins_router


def _build_app() -> FastAPI:
    """App with a plugin route that reports the session it was authenticated with, like real plugin routes."""
    app = FastAPI()
    app.add_middleware(PluginWindowAuthMiddleware)

    @app.get("/api/plugins/demo/view")
    async def view(
        session_id: str | None = Query(None),
        x_session_id: str | None = Header(None, alias="X-Session-ID"),
        q: str | None = Query(None),
    ) -> dict[str, str | None]:
        return {"session": x_session_id or session_id, "q": q}

    @app.post("/api/plugins/demo/action")
    async def action(x_session_id: str | None = Header(None, alias="X-Session-ID")) -> dict[str, str | None]:
        return {"session": x_session_id}

    @app.get("/api/v1/other")
    async def other(x_session_id: str | None = Header(None, alias="X-Session-ID")) -> dict[str, str | None]:
        return {"session": x_session_id}

    app.include_router(plugins_router.router, prefix="/api/v1")
    return app


class TestLaunchTokens(unittest.TestCase):
    """SessionManager launch token storage."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.session_mgr = SessionManager(Path(self.temp_dir.name))
        self.session_id = self.session_mgr.create_session("alice")

    def tearDown(self) -> None:
        close_all_connections()
        gc.collect()
        self.temp_dir.cleanup()

    def test_token_is_single_use(self) -> None:
        token = self.session_mgr.create_launch_token(self.session_id)
        self.assertEqual(self.session_mgr.consume_launch_token(token), self.session_id)
        self.assertIsNone(self.session_mgr.consume_launch_token(token))

    def test_expired_token_is_rejected(self) -> None:
        token = self.session_mgr.create_launch_token(self.session_id, ttl_seconds=-1)
        self.assertIsNone(self.session_mgr.consume_launch_token(token))

    def test_unknown_and_empty_tokens_are_rejected(self) -> None:
        self.assertIsNone(self.session_mgr.consume_launch_token("nope"))
        self.assertIsNone(self.session_mgr.consume_launch_token(""))

    def test_token_is_not_stored_in_plain_text(self) -> None:
        token = self.session_mgr.create_launch_token(self.session_id)
        with sqlite3.connect(self.session_mgr.db_path) as db:
            stored = [row[0] for row in db.execute("SELECT token_hash FROM launch_tokens")]
        self.assertNotIn(token, stored)
        self.assertEqual(len(stored), 1)


class TestPluginWindowAuthMiddleware(unittest.TestCase):
    """Exchange of launch tokens for the cookie, and authentication with the cookie."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.session_mgr = SessionManager(Path(self.temp_dir.name))
        self.session_id = self.session_mgr.create_session("alice")
        self.patcher = patch("fastapi_app.lib.core.dependencies.get_session_manager", return_value=self.session_mgr)
        self.patcher.start()
        app = _build_app()
        app.dependency_overrides[get_session_manager] = lambda: self.session_mgr
        self.client = TestClient(app, follow_redirects=False)

    def tearDown(self) -> None:
        self.patcher.stop()
        close_all_connections()
        gc.collect()
        self.temp_dir.cleanup()

    def _launch(self, query: str = "") -> str:
        """Create a token through the endpoint and return the launch URL."""
        response = self.client.post("/api/v1/plugins/launch-token", headers={"X-Session-ID": self.session_id})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertGreater(body["expires_in"], 0)
        separator = "&" if query else ""
        return f"/api/plugins/demo/view?{query}{separator}launch={body['token']}"

    def test_launch_token_endpoint_requires_session(self) -> None:
        self.assertEqual(self.client.post("/api/v1/plugins/launch-token").status_code, 401)
        response = self.client.post("/api/v1/plugins/launch-token", headers={"X-Session-ID": "invalid"})
        self.assertEqual(response.status_code, 401)

    def test_exchange_redirects_to_clean_url_and_sets_cookie(self) -> None:
        response = self.client.get(self._launch("q=a+b&session_id=old"))
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/api/plugins/demo/view?q=a+b")
        cookie = response.headers["set-cookie"]
        self.assertIn(f"{PLUGIN_SESSION_COOKIE}={self.session_id}", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Path=/api/plugins/", cookie)
        self.assertNotIn("Secure", cookie)

    def test_cookie_is_secure_behind_https_proxy(self) -> None:
        response = self.client.get(self._launch(), headers={"X-Forwarded-Proto": "https"})
        self.assertIn("Secure", response.headers["set-cookie"])

    def test_token_cannot_be_reused(self) -> None:
        url = self._launch()
        self.assertEqual(self.client.get(url).status_code, 303)
        self.client.cookies.clear()
        response = self.client.get(url)
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("set-cookie", response.headers)

    def test_token_of_ended_session_is_rejected(self) -> None:
        url = self._launch()
        self.session_mgr.delete_session(self.session_id)
        self.assertEqual(self.client.get(url).status_code, 401)

    def test_redirect_target_is_authenticated_by_cookie(self) -> None:
        response = self.client.get(self._launch("q=x"), follow_redirects=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"session": self.session_id, "q": "x"})

    def test_cookie_fills_in_missing_or_empty_session(self) -> None:
        self.client.cookies.set(PLUGIN_SESSION_COOKIE, self.session_id)
        for headers, params in (({}, {}), ({"X-Session-ID": ""}, {}), ({}, {"session_id": "null"})):
            response = self.client.get("/api/plugins/demo/view", headers=headers, params=params)
            self.assertEqual(response.json()["session"], self.session_id)

    def test_explicit_session_wins_over_cookie(self) -> None:
        self.client.cookies.set(PLUGIN_SESSION_COOKIE, self.session_id)
        response = self.client.get("/api/plugins/demo/view", headers={"X-Session-ID": "other"})
        self.assertEqual(response.json()["session"], "other")
        response = self.client.get("/api/plugins/demo/view", params={"session_id": "legacy"})
        self.assertEqual(response.json()["session"], "legacy")

    def test_cookie_is_not_applied_outside_plugin_routes(self) -> None:
        self.client.cookies.set(PLUGIN_SESSION_COOKIE, self.session_id)
        self.assertIsNone(self.client.get("/api/v1/other").json()["session"])

    def test_cross_origin_post_with_cookie_is_rejected(self) -> None:
        self.client.cookies.set(PLUGIN_SESSION_COOKIE, self.session_id)
        with self.assertLogs("fastapi_app.lib.plugins.plugin_window_auth", level="WARNING"):
            response = self.client.post("/api/plugins/demo/action", headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status_code, 403)
        response = self.client.post("/api/plugins/demo/action", headers={"Origin": "http://testserver"})
        self.assertEqual(response.json()["session"], self.session_id)


if __name__ == "__main__":
    unittest.main()
