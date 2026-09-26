"""
Tests for the plugin admin API.

@testCovers fastapi_app/routers/plugins_admin.py
@testCovers fastapi_app/lib/plugins/plugin_info.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_admin_user
from fastapi_app.lib.plugins.plugin_info import readme_url_for
from fastapi_app.lib.plugins.plugin_manager import PluginManager
from fastapi_app.lib.plugins.plugin_registry import PluginRecord
from fastapi_app.routers import plugins_admin
from tests.unit.fastapi.test_plugin_management import FakeConfig, RecordingPlugin


class TestPluginAdminApi(unittest.TestCase):
    def setUp(self):
        self._saved = PluginManager._instance
        PluginManager._instance = None
        self.cfg = FakeConfig()
        p = patch("fastapi_app.lib.plugins.plugin_manager.get_config", return_value=self.cfg)
        p.start()
        self.addCleanup(p.stop)
        self.mgr = PluginManager.get_instance()
        self.mgr.registry._register_with_dependencies([
            RecordingPlugin("wizard"), RecordingPlugin("grobid", ["wizard"]),
        ])
        for r in self.mgr.registry.get_records():
            r.initialized = True
        app = FastAPI()
        app.include_router(plugins_admin.router, prefix="/api/v1")
        app.dependency_overrides[require_admin_user] = lambda: {"username": "admin", "roles": ["admin"]}
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        PluginManager._instance = self._saved

    def test_list_includes_dependencies_and_status(self):
        data = self.client.get("/api/v1/plugins/admin").json()["plugins"]
        wizard = next(p for p in data if p["id"] == "wizard")
        self.assertEqual(wizard["dependents"], ["grobid"])
        self.assertEqual(wizard["status"], "active")
        self.assertTrue(wizard["enabled"])
        self.assertIsNone(wizard["readme_url"])

    def test_disable_without_cascade_returns_409(self):
        r = self.client.post("/api/v1/plugins/admin/wizard/disable", json={"cascade": False})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json(), {"detail": "cascade_required", "affected": ["grobid"], "direction": "disable"})

    def test_disable_with_cascade(self):
        r = self.client.post("/api/v1/plugins/admin/wizard/disable", json={"cascade": True})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["changed"]["grobid"], "inactive")
        self.assertEqual(self.cfg.store["plugins.disabled"], ["wizard"])

    def test_enable(self):
        self.client.post("/api/v1/plugins/admin/wizard/disable", json={"cascade": True})
        r = self.client.post("/api/v1/plugins/admin/wizard/enable", json={"cascade": False})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["changed"]["grobid"], "active")

    def test_unknown_plugin_404(self):
        r = self.client.post("/api/v1/plugins/admin/nope/enable", json={"cascade": False})
        self.assertEqual(r.status_code, 404)

    def test_requires_admin(self):
        def deny():
            raise HTTPException(status_code=403, detail="Admin access required")

        self.app.dependency_overrides[require_admin_user] = deny
        self.assertEqual(self.client.get("/api/v1/plugins/admin").status_code, 403)
        r = self.client.post("/api/v1/plugins/admin/wizard/disable", json={"cascade": True})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.cfg.store["plugins.disabled"], [])


class TestReadmeUrl(unittest.TestCase):
    def test_builtin_with_readme(self):
        with tempfile.TemporaryDirectory() as d:
            plugin_dir = Path(d) / "log_viewer"
            plugin_dir.mkdir()
            rec = PluginRecord(id="log-viewer", metadata={}, plugin=None, directory=plugin_dir)
            self.assertIsNone(readme_url_for(rec))  # no README.md yet
            (plugin_dir / "README.md").write_text("x")
            self.assertEqual(
                readme_url_for(rec),
                "https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/log_viewer/README.md",
            )
            rec.external = True
            self.assertIsNone(readme_url_for(rec))
            rec.metadata = {"readme_url": "https://example.org/r"}
            self.assertEqual(readme_url_for(rec), "https://example.org/r")


if __name__ == "__main__":
    unittest.main()
