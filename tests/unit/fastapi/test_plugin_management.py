"""
Tests for plugin management (registry status model and change planning).

@testCovers fastapi_app/lib/plugins/plugin_registry.py
"""

import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin
from fastapi_app.lib.plugins.plugin_registry import PluginRegistry


class MockPlugin(Plugin):
    def __init__(self, plugin_id: str, deps: list[str] | None = None, **extra):
        self._id = plugin_id
        self._deps = deps or []
        self._extra = extra

    @property
    def metadata(self):
        return {
            "id": self._id, "name": f"Mock {self._id}", "description": "d",
            "category": "test", "version": "1.0.0", "required_roles": ["*"],
            "dependencies": self._deps, **self._extra,
        }

    def get_endpoints(self):
        return {}


def make_registry() -> PluginRegistry:
    """wizard <- grobid, wizard <- meta, progress <- overview"""
    r = PluginRegistry()
    r._register_with_dependencies([
        MockPlugin("grobid", ["wizard"]), MockPlugin("meta", ["wizard"]),
        MockPlugin("wizard"), MockPlugin("overview", ["progress"]), MockPlugin("progress"),
    ])
    return r


class TestStatus(unittest.TestCase):
    def test_all_active_by_default(self):
        r = make_registry()
        self.assertTrue(all(r.status(i)[0] == "active" for i in ["grobid", "meta", "wizard"]))

    def test_disabled_and_inactive(self):
        r = make_registry()
        r.set_disabled({"wizard"})
        self.assertEqual(r.status("wizard"), ("disabled", None))
        self.assertEqual(r.status("grobid"), ("inactive", "Waiting for wizard"))
        self.assertFalse(r.is_active("grobid"))
        self.assertTrue(r.is_active("overview"))

    def test_reenabling_restores_dependents(self):
        r = make_registry()
        r.set_disabled({"wizard"})
        r.set_disabled(set())
        self.assertTrue(r.is_active("grobid"))

    def test_explicitly_disabled_dependent_stays_disabled(self):
        r = make_registry()
        r.set_disabled({"wizard", "grobid"})
        r.set_disabled({"grobid"})
        self.assertEqual(r.status("grobid")[0], "disabled")
        self.assertTrue(r.is_active("meta"))

    def test_missing_dependency_is_failed(self):
        r = PluginRegistry()
        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR"):
            r._register_with_dependencies([MockPlugin("a", ["nope"])])
        status, reason = r.status("a")
        self.assertEqual(status, "failed")
        self.assertIn("nope", reason)

    def test_cycle_is_failed(self):
        r = PluginRegistry()
        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR"):
            r._register_with_dependencies([MockPlugin("a", ["b"]), MockPlugin("b", ["a"])])
        self.assertEqual(r.status("a")[0], "failed")
        self.assertEqual(r.status("b")[0], "failed")

    def test_mark_failed(self):
        r = make_registry()
        r.mark_failed("wizard", "boom")
        self.assertEqual(r.status("wizard"), ("failed", "boom"))
        self.assertEqual(r.status("grobid")[0], "inactive")

    def test_unavailable_record(self):
        r = make_registry()
        r.add_unavailable("llm", MockPlugin("llm"), None, "no key")
        self.assertEqual(r.status("llm"), ("unavailable", "no key"))

    def test_dependency_on_unavailable_plugin_is_failed(self):
        r = PluginRegistry()
        r.add_unavailable("llm", MockPlugin("llm"), None, "no key")
        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR"):
            r._register_with_dependencies([MockPlugin("child", ["llm"])])
        status, reason = r.status("child")
        self.assertEqual(status, "failed")
        self.assertIn("llm", reason)


class TestGraphAndPlan(unittest.TestCase):
    def test_dependents_direct_and_transitive(self):
        r = PluginRegistry()
        r._register_with_dependencies([MockPlugin("a"), MockPlugin("b", ["a"]), MockPlugin("c", ["b"])])
        self.assertEqual(r.dependents("a"), ["b"])
        self.assertEqual(sorted(r.dependents("a", transitive=True)), ["b", "c"])
        self.assertEqual(sorted(r.dependencies("c", transitive=True)), ["a", "b"])

    def test_plan_disable_orders_dependents_first(self):
        r = PluginRegistry()
        r._register_with_dependencies([MockPlugin("c", ["b"]), MockPlugin("b", ["a"]), MockPlugin("a")])
        plan = r.plan({"a"})
        self.assertEqual(plan.deactivate, ["c", "b", "a"])
        self.assertEqual(plan.activate, [])

    def test_plan_enable_orders_dependencies_first(self):
        r = PluginRegistry()
        r._register_with_dependencies([MockPlugin("c", ["b"]), MockPlugin("b", ["a"]), MockPlugin("a")])
        r.set_disabled({"a"})
        plan = r.plan(set())
        self.assertEqual(plan.activate, ["a", "b", "c"])
        self.assertEqual(plan.deactivate, [])

    def test_plan_is_pure(self):
        r = make_registry()
        r.plan({"wizard"})
        self.assertTrue(r.is_active("wizard"))

    def test_get_plugins_returns_only_active(self):
        r = make_registry()
        r.set_disabled({"wizard"})
        ids = {p["id"] for p in r.get_plugins()}
        self.assertEqual(ids, {"overview", "progress"})



class TestExtensionUnregister(unittest.TestCase):
    def setUp(self):
        FrontendExtensionRegistry.reset_instance()

    def tearDown(self):
        FrontendExtensionRegistry.reset_instance()

    def test_unregister_plugin_removes_only_its_files(self):
        reg = FrontendExtensionRegistry.get_instance()
        a, b = Path(__file__), Path(__file__).parent / "test_auth.py"
        reg.register_extension(a, "one")
        reg.register_extension(b, "two")
        reg.unregister_plugin("one")
        self.assertEqual([pid for _, pid in reg.get_extension_files()], ["two"])


# ---- PluginManager ---------------------------------------------------------------

import tempfile
from unittest.mock import patch

from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.plugins.plugin_gate import GatedStaticFiles, plugin_gate
from fastapi_app.lib.plugins.plugin_manager import CascadeRequired, PluginChangeError, PluginManager
from fastapi_app.lib.plugins.plugin_state import PluginStateStore


class FakeConfig:
    def __init__(self, disabled=None):
        self.store = {"plugins.disabled": disabled or []}

    def get(self, key, default=None):
        return self.store.get(key, default)

    def set(self, key, value, **kw):
        self.store[key] = value
        return True, "ok"


def make_state_store(db_dir: Path, cfg: "FakeConfig") -> PluginStateStore:
    """A plugin state store in db_dir that migrates the legacy config key from cfg."""
    return PluginStateStore(db_dir, legacy_disabled=lambda: list(cfg.get("plugins.disabled", [])))


def set_shared_disabled(manager: PluginManager, disabled: list[str]) -> None:
    """Store a disabled set as another worker would, and load it into the manager."""
    manager.state_store.write(set(disabled))
    manager.load_disabled()


class RecordingPlugin(MockPlugin):
    calls: list[str] = []

    async def initialize(self, context):
        RecordingPlugin.calls.append(f"init:{self._id}")

    async def cleanup(self):
        RecordingPlugin.calls.append(f"cleanup:{self._id}")


class ManagerTestBase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        RecordingPlugin.calls = []
        FrontendExtensionRegistry.reset_instance()
        self._saved = PluginManager._instance
        PluginManager._instance = None
        self.cfg = FakeConfig()
        patcher = patch("fastapi_app.lib.plugins.plugin_manager.get_config", return_value=self.cfg)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.mgr = PluginManager.get_instance()
        self.state_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.state_dir.cleanup)
        self.mgr.state_store = make_state_store(Path(self.state_dir.name), self.cfg)
        self.mgr.registry._register_with_dependencies([
            RecordingPlugin("wizard"), RecordingPlugin("grobid", ["wizard"]),
            RecordingPlugin("meta", ["wizard"]), RecordingPlugin("prot", protected=True),
        ])
        for r in self.mgr.registry.get_records():
            r.initialized = True
        self.mgr.load_disabled()

    def tearDown(self):
        PluginManager._instance = self._saved
        FrontendExtensionRegistry.reset_instance()


class TestSetEnabled(ManagerTestBase):
    async def test_disable_requires_cascade_confirmation(self):
        with self.assertRaises(CascadeRequired) as cm:
            await self.mgr.set_plugin_enabled("wizard", False, cascade=False)
        self.assertEqual(sorted(cm.exception.affected), ["grobid", "meta"])
        self.assertEqual(cm.exception.direction, "disable")
        self.assertEqual(sorted(self.mgr.state_store.read().disabled), [])

    async def test_disable_with_cascade_runs_cleanup_dependents_first(self):
        result = await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(sorted(self.mgr.state_store.read().disabled), ["wizard"])
        self.assertEqual(RecordingPlugin.calls[-1], "cleanup:wizard")
        self.assertEqual(sorted(RecordingPlugin.calls[:2]), ["cleanup:grobid", "cleanup:meta"])
        self.assertEqual(result["changed"]["grobid"], "inactive")
        self.assertEqual(result["changed"]["wizard"], "disabled")
        self.assertTrue(result["reload_required"])

    async def test_enable_restores_and_initializes_dependencies_first(self):
        await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        RecordingPlugin.calls.clear()
        result = await self.mgr.set_plugin_enabled("wizard", True)
        self.assertEqual(RecordingPlugin.calls[0], "init:wizard")
        self.assertEqual(result["changed"]["grobid"], "active")
        self.assertEqual(sorted(self.mgr.state_store.read().disabled), [])

    async def test_enable_with_disabled_dependency_needs_cascade(self):
        set_shared_disabled(self.mgr, ["wizard", "grobid"])
        with self.assertRaises(CascadeRequired) as cm:
            await self.mgr.set_plugin_enabled("grobid", True, cascade=False)
        self.assertEqual((cm.exception.direction, cm.exception.affected), ("enable", ["wizard"]))
        await self.mgr.set_plugin_enabled("grobid", True, cascade=True)
        self.assertEqual(sorted(self.mgr.state_store.read().disabled), [])

    async def test_protected_cannot_be_disabled(self):
        with self.assertRaises(PluginChangeError) as cm:
            await self.mgr.set_plugin_enabled("prot", False)
        self.assertEqual(cm.exception.status_code, 409)

    async def test_unknown_plugin(self):
        with self.assertRaises(PluginChangeError) as cm:
            await self.mgr.set_plugin_enabled("nope", False)
        self.assertEqual(cm.exception.status_code, 404)

    async def test_unavailable_cannot_be_toggled(self):
        self.mgr.registry.add_unavailable("llm", MockPlugin("llm"), None, "no key")
        with self.assertRaises(PluginChangeError) as cm:
            await self.mgr.set_plugin_enabled("llm", True)
        self.assertEqual(cm.exception.status_code, 409)

    async def test_initialize_failure_marks_failed(self):
        await self.mgr.set_plugin_enabled("wizard", False, cascade=True)

        async def boom(context):
            raise RuntimeError("boom")

        self.mgr.registry.get_plugin("wizard").initialize = boom
        with self.assertLogs("fastapi_app.lib.plugins.plugin_manager", level="ERROR"):
            result = await self.mgr.set_plugin_enabled("wizard", True)
        self.assertEqual(self.mgr.registry.status("wizard")[0], "failed")
        self.assertIn("wizard", result["errors"])

    async def test_state_write_failure_runs_no_hooks(self):
        def fail(disabled):
            raise OSError("disk full")

        self.mgr.state_store.write = fail
        with self.assertRaises(PluginChangeError) as cm:
            await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(cm.exception.status_code, 500)
        self.assertEqual(RecordingPlugin.calls, [])
        self.assertTrue(self.mgr.registry.is_active("wizard"))

    async def test_cleanup_unregisters_frontend_extensions(self):
        FrontendExtensionRegistry.get_instance().register_extension(Path(__file__), "wizard")
        await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(FrontendExtensionRegistry.get_instance().get_extension_files(), [])

    async def test_load_disabled_from_shared_state(self):
        set_shared_disabled(self.mgr, ["grobid"])
        self.assertEqual(self.mgr.registry.status("grobid")[0], "disabled")

    async def test_legacy_config_key_is_migrated_once(self):
        # A fresh manager over a new state directory, as on the first start after an upgrade
        with tempfile.TemporaryDirectory() as d:
            self.cfg.store["plugins.disabled"] = ["grobid"]
            self.mgr.state_store = make_state_store(Path(d), self.cfg)
            self.mgr.load_disabled()
            self.assertEqual(self.mgr.registry.status("grobid")[0], "disabled")
            self.assertTrue((Path(d) / "plugins-state.json").is_file())
            # the state file is the source from now on
            self.cfg.store["plugins.disabled"] = []
            self.mgr.load_disabled()
            self.assertEqual(self.mgr.registry.status("grobid")[0], "disabled")

    async def test_execute_rejects_inactive_plugin(self):
        await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        with self.assertRaises(ValueError):
            await self.mgr.execute_plugin("wizard", "execute", {})


class TestGate(ManagerTestBase):
    def _client(self, static_dir: Path) -> TestClient:
        app = FastAPI()
        router = APIRouter()

        @router.get("/api/plugins/wizard/ping")
        def ping() -> dict[str, bool]:
            return {"ok": True}

        app.include_router(router, dependencies=[Depends(plugin_gate("wizard"))])
        app.mount("/api/plugins/wizard/static", GatedStaticFiles(plugin_id="wizard", directory=str(static_dir)))
        return TestClient(app)

    async def test_gate_returns_404_when_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.txt").write_text("hi")
            client = self._client(Path(d))
            self.assertEqual(client.get("/api/plugins/wizard/ping").status_code, 200)
            self.assertEqual(client.get("/api/plugins/wizard/static/a.txt").status_code, 200)
            await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
            self.assertEqual(client.get("/api/plugins/wizard/ping").status_code, 404)
            self.assertEqual(client.get("/api/plugins/wizard/static/a.txt").status_code, 404)
            await self.mgr.set_plugin_enabled("wizard", True)
            self.assertEqual(client.get("/api/plugins/wizard/ping").status_code, 200)



class TestBuiltinLifecycleConformance(unittest.IsolatedAsyncioTestCase):
    """Every built-in plugin must survive initialize -> cleanup -> initialize."""

    async def test_initialize_cleanup_initialize(self):
        from fastapi_app.config import get_settings
        from fastapi_app.lib.plugins.plugin_testing import check_lifecycle_conformance

        builtin = get_settings().plugins_code_dir
        if not any((p / "plugin.py").is_file() for p in builtin.iterdir()):
            self.skipTest("no built-in plugins installed")
        checked = await check_lifecycle_conformance([builtin], builtin_dir=builtin)
        self.assertTrue(checked)


if __name__ == "__main__":
    unittest.main()
