"""
Tests for the plugin state shared by the worker processes.

@testCovers fastapi_app/lib/plugins/plugin_state.py
@testCovers fastapi_app/lib/plugins/plugin_manager.py
"""

import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_manager import PluginManager
from fastapi_app.lib.plugins.plugin_state import HEARTBEAT_STALE_AGE, PluginState, PluginStateStore
from tests.unit.fastapi.test_plugin_management import FakeConfig, RecordingPlugin, make_state_store


class TestPluginStateStore(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.store = PluginStateStore(self.dir)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir)

    def test_missing_file_is_created_empty(self):
        self.assertEqual(self.store.read(), PluginState(0, frozenset()))
        self.assertEqual(json.loads((self.dir / "plugins-state.json").read_text()), {"generation": 0, "disabled": []})

    def test_write_increments_generation(self):
        self.assertEqual(self.store.write({"b", "a"}), PluginState(1, frozenset({"a", "b"})))
        self.assertEqual(self.store.write(set()).generation, 2)
        self.assertEqual(self.store.read(), PluginState(2, frozenset()))
        self.assertEqual(list(self.dir.glob(".plugins-state-*")), [])

    def test_legacy_key_is_used_only_without_state_file(self):
        calls = []

        def legacy():
            calls.append(1)
            return ["grobid"]

        store = PluginStateStore(self.dir, legacy_disabled=legacy)
        self.assertEqual(store.read().disabled, frozenset({"grobid"}))
        self.assertEqual(store.read().disabled, frozenset({"grobid"}))
        self.assertEqual(len(calls), 1)

    def test_corrupt_file_reads_as_empty(self):
        (self.dir / "plugins-state.json").write_text("{not json")
        with self.assertLogs("fastapi_app.lib.plugins.plugin_state", level="ERROR"):
            self.assertEqual(self.store.read(), PluginState())

    def test_heartbeats(self):
        self.store.write_heartbeat(3, pid=101)
        self.store.write_heartbeat(2, pid=102)
        beats = sorted(self.store.heartbeats(), key=lambda b: b.pid)
        self.assertEqual([(b.pid, b.generation) for b in beats], [(101, 3), (102, 2)])
        self.store.remove_heartbeat(pid=101)
        self.assertEqual([b.pid for b in self.store.heartbeats()], [102])

    def test_old_heartbeats_are_ignored_and_stale_ones_deleted(self):
        now = time.time()
        workers = self.dir / "plugin-workers"
        workers.mkdir()
        (workers / "1.json").write_text(json.dumps({"pid": 1, "generation": 0, "time": now - 60}))
        (workers / "2.json").write_text(json.dumps({"pid": 2, "generation": 0, "time": now - HEARTBEAT_STALE_AGE - 1}))
        self.assertEqual(self.store.heartbeats(), [])
        self.assertTrue((workers / "1.json").exists())
        self.assertFalse((workers / "2.json").exists())


class TwoWorkersBase(unittest.IsolatedAsyncioTestCase):
    """Two PluginManagers over the same state directory stand for two worker processes."""

    def setUp(self):
        RecordingPlugin.calls = []
        FrontendExtensionRegistry.reset_instance()
        self._saved = PluginManager._instance
        self.cfg = FakeConfig()
        p = patch("fastapi_app.lib.plugins.plugin_manager.get_config", return_value=self.cfg)
        p.start()
        self.addCleanup(p.stop)
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.a = self._worker()
        self.b = self._worker()
        RecordingPlugin.calls = []

    def _worker(self) -> PluginManager:
        PluginManager._instance = None
        manager = PluginManager.get_instance()
        manager.state_store = make_state_store(Path(self.dir.name), self.cfg)
        manager.registry._register_with_dependencies([RecordingPlugin("wizard"), RecordingPlugin("grobid", ["wizard"])])
        for r in manager.registry.get_records():
            r.initialized = True
        manager.load_disabled()
        return manager

    def tearDown(self):
        PluginManager._instance = self._saved
        FrontendExtensionRegistry.reset_instance()


class TestReconcile(TwoWorkersBase):
    async def test_other_worker_applies_change(self):
        await self.a.set_plugin_enabled("wizard", False, cascade=True)
        self.assertTrue(self.b.registry.is_active("wizard"))
        RecordingPlugin.calls.clear()

        self.assertTrue(await self.b.reconcile())
        self.assertEqual(self.b.registry.status("wizard")[0], "disabled")
        self.assertEqual(self.b.registry.status("grobid")[0], "inactive")
        self.assertEqual(sorted(RecordingPlugin.calls), ["cleanup:grobid", "cleanup:wizard"])
        self.assertEqual(self.b.generation, self.a.generation)

    async def test_reconcile_without_change_does_nothing(self):
        self.assertFalse(await self.b.reconcile())
        await self.a.set_plugin_enabled("wizard", False, cascade=True)
        await self.b.reconcile()
        RecordingPlugin.calls.clear()
        self.assertFalse(await self.b.reconcile())
        self.assertFalse(await self.a.reconcile())
        self.assertEqual(RecordingPlugin.calls, [])

    async def test_enable_reaches_other_worker(self):
        await self.a.set_plugin_enabled("wizard", False, cascade=True)
        await self.b.reconcile()
        await self.a.set_plugin_enabled("wizard", True)
        RecordingPlugin.calls.clear()
        await self.b.reconcile()
        self.assertTrue(self.b.registry.is_active("grobid"))
        self.assertEqual(RecordingPlugin.calls, ["init:wizard", "init:grobid"])

    async def test_both_workers_notify_their_clients(self):
        notified: list[str] = []
        self.a.add_change_listener(lambda: notified.append("a"))
        self.b.add_change_listener(lambda: notified.append("b"))
        await self.a.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(notified, ["a"])
        await self.b.reconcile()
        self.assertEqual(notified, ["a", "b"])
        await self.b.reconcile()
        self.assertEqual(notified, ["a", "b"])
        self.assertEqual(self.a.plugins_version(), self.a.generation)

    async def test_propagation_counts_workers_behind(self):
        self.a.state_store.write_heartbeat(self.a.generation, pid=os.getpid())
        self.b.state_store.write_heartbeat(self.b.generation, pid=999999)
        await self.a.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(self.a.propagation(), {"generation": 1, "workers": 2, "pending": 1, "restart_pending": 0})
        await self.b.reconcile()
        self.b.state_store.write_heartbeat(self.b.generation, pid=999999)
        self.assertEqual(self.a.propagation(), {"generation": 1, "workers": 2, "pending": 0, "restart_pending": 0})


class TestWatchState(TwoWorkersBase):
    async def test_watcher_applies_change_and_writes_heartbeat(self):
        task = asyncio.create_task(self.b.watch_state(interval=0.05))
        try:
            await asyncio.sleep(0.1)
            await self.a.set_plugin_enabled("wizard", False, cascade=True)
            for _ in range(100):
                if self.b.generation == self.a.generation:
                    break
                await asyncio.sleep(0.02)
            self.assertEqual(self.b.registry.status("wizard")[0], "disabled")
            await asyncio.sleep(0.1)
            beats = {beat.pid: beat.generation for beat in self.b.state_store.heartbeats()}
            self.assertEqual(beats.get(os.getpid()), self.a.generation)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_stop_removes_heartbeat(self):
        self.b.start_state_watcher()
        await asyncio.sleep(0.05)
        self.assertTrue(self.b.state_store.heartbeats())
        await self.b.stop_state_watcher()
        self.assertEqual(self.b.state_store.heartbeats(), [])


if __name__ == "__main__":
    unittest.main()
