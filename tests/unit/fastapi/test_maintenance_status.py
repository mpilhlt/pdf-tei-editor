"""
Tests for GET /api/v1/maintenance/status and the plugin change notifications behind it.

@testCovers fastapi_app/routers/maintenance.py
@testCovers fastapi_app/lib/plugins/plugin_manager.py
"""

import asyncio
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.data_restore import APPLIED_FILE
from fastapi_app.routers import maintenance


class TestMaintenanceStatus(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.data)
        app = FastAPI()
        app.include_router(maintenance.router, prefix="/api/v1")
        self.client = TestClient(app)
        self.manager = MagicMock()
        self.manager.plugins_version.return_value = 7
        for target, value in (
            ("fastapi_app.routers.maintenance.get_settings", MagicMock(return_value=MagicMock(data_root=self.data))),
            ("fastapi_app.routers.maintenance.PluginManager.get_instance", MagicMock(return_value=self.manager)),
        ):
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_status_without_authentication(self):
        r = self.client.get("/api/v1/maintenance/status")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"data_restore": None, "plugins_version": 7})

    def test_status_reports_restore_and_pending_restart(self):
        (self.data / APPLIED_FILE).write_text(json.dumps({"id": "20261022_101010", "applied_at": "2026-10-22T10:10:10"}))
        self.manager.plugins_version.return_value = None
        r = self.client.get("/api/v1/maintenance/status")
        self.assertEqual(r.json(), {
            "data_restore": {"id": "20261022_101010", "applied_at": "2026-10-22T10:10:10"},
            "plugins_version": None,
        })

    def test_unreadable_plugin_state(self):
        self.manager.plugins_version.side_effect = OSError("gone")
        self.assertIsNone(self.client.get("/api/v1/maintenance/status").json()["plugins_version"])


class TestPluginChangeListener(unittest.TestCase):
    def _manager(self, generation: int, restart_pending: int = 0):
        from fastapi_app.lib.plugins.plugin_manager import PluginManager

        manager = object.__new__(PluginManager)
        manager._change_listeners = []
        manager.state_store = MagicMock()
        manager.state_store.read.return_value = MagicMock(generation=generation)
        manager.restart_pending = MagicMock(return_value=restart_pending)
        return manager

    def test_plugins_version_is_none_while_restart_pending(self):
        self.assertEqual(self._manager(5).plugins_version(), 5)
        self.assertIsNone(self._manager(5, restart_pending=2).plugins_version())

    def test_listeners_run_and_failures_are_contained(self):
        manager = self._manager(1)
        calls = []
        manager.add_change_listener(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        manager.add_change_listener(lambda: calls.append(1))
        manager._notify_change()
        self.assertEqual(calls, [1])

    def test_reconcile_notifies_only_on_change(self):
        manager = self._manager(2)
        manager.generation = 2
        manager._lock = asyncio.Lock()
        calls = []
        manager.add_change_listener(lambda: calls.append(1))
        self.assertFalse(asyncio.run(manager.reconcile()))
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
