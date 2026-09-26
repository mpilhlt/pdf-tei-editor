# Plugin Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-only runtime enable/disable of backend plugins with dependency cascade, plus a Tools-menu dialog showing plugin info.

**Architecture:** `PluginRegistry` keeps a `PluginRecord` per discovered plugin and a persisted set of explicitly disabled ids; status is derived (active/disabled/inactive/unavailable/failed). `PluginManager` applies changes by calling `cleanup()`/`initialize()` in dependency order and gates routes/static files at request time. A new admin router and a new frontend plugin expose it. Spec: [2026-09-26-plugin-management-design.md](../specs/2026-09-26-plugin-management-design.md).

**Tech Stack:** Python/FastAPI, unittest, vanilla JS class-based frontend plugins with Shoelace.

**Conventions (from CLAUDE.md):** `uv run python` for Python; precise type annotations; separate `@import` JSDoc blocks; never hand-edit `api-client-v1.js`; backend unit tests in `tests/unit/fastapi/`; run with `uv run python tests/unit-test-runner.py tests/unit/fastapi/<file>`.

## File structure

- Modify `fastapi_app/lib/plugins/plugin_registry.py`: records, status, graph, plan.
- Modify `fastapi_app/lib/plugins/frontend_extension_registry.py`: `unregister_plugin`.
- Modify `fastapi_app/lib/plugins/plugin_manager.py`: persistence, `set_plugin_enabled`, gated route/static registration.
- Create `fastapi_app/lib/plugins/plugin_gate.py`: `plugin_gate`, `GatedStaticFiles`.
- Create `fastapi_app/lib/plugins/plugin_info.py`: admin info + README URL.
- Create `fastapi_app/routers/plugins_admin.py`; modify `fastapi_app/main.py`.
- Modify `fastapi_app/plugins/tei_wizard/plugin.py`, `metadata_extraction/plugin.py` (symmetric cleanup); `log_viewer`, `backup_restore` (`protected`).
- Modify `fastapi_app/config.py` (repo URL), `config/config.json` (default key), `app/src/plugins/config-editor.js` (hide key).
- Create `app/src/plugins/plugin-admin.js`, templates `plugin-admin-dialog.html`, `plugin-admin-confirm-dialog.html`, `plugin-admin-menu-item.html`; modify `app/src/plugins.js`, `app/src/plugin-registry.js`, `app/src/ui.js`.
- Tests: `tests/unit/fastapi/test_plugin_management.py`, `tests/unit/fastapi/test_plugin_admin_api.py`, `tests/e2e/tests/plugin-admin.spec.js`.
- Docs: `docs/code-assistant/backend-plugins.md`, `docs/development/plugin-system-backend.md`, user manual page.

---

### Task 1: Registry records, status, dependency graph, change plan

**Files:** Modify `fastapi_app/lib/plugins/plugin_registry.py`; Test `tests/unit/fastapi/test_plugin_management.py`.

- [ ] **Step 1: Write failing tests**

```python
"""
Tests for plugin management (registry status model and change planning).

@testCovers fastapi_app/lib/plugins/plugin_registry.py
"""

import unittest

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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_plugin_management.py`
Expected: FAIL (`AttributeError: ... has no attribute 'status'`).

- [ ] **Step 3: Implement registry changes** in `plugin_registry.py`

Add imports `from dataclasses import dataclass, field` and, above `PluginRegistry`:

```python
@dataclass
class PluginRecord:
    """Discovery result for one plugin, including plugins that could not be activated."""

    id: str
    metadata: dict[str, Any]
    plugin: Plugin | None
    directory: Path | None = None
    external: bool = False
    load_status: str = "ok"  # "ok" | "unavailable" | "failed"
    error: str | None = None
    initialized: bool = False

    @property
    def dependencies(self) -> list[str]:
        return list(self.metadata.get("dependencies", []))


@dataclass
class ChangePlan:
    """Plugins whose effective state changes, in the order lifecycle hooks must run."""

    deactivate: list[str] = field(default_factory=list)  # dependents first
    activate: list[str] = field(default_factory=list)  # dependencies first
```

In `PluginRegistry.__init__` add:

```python
        self._records: dict[str, PluginRecord] = {}
        self._order: list[str] = []  # registered ids, dependencies first
        self._disabled: set[str] = set()
```

Replace `discover_plugins`'s per-plugin block and `_load_plugin` so every plugin yields a record (signature `discover_plugins(self, plugin_dirs: list[Path], builtin_dir: Path | None = None)`):

```python
                record = self._load_plugin(plugin_path, plugin_file)
                record.external = builtin_dir is not None and plugin_path.parent != builtin_dir
                if record.load_status == "ok" and record.plugin is not None:
                    self._records[record.id] = record
                    pending_plugins.append(record.plugin)
                else:
                    self._records.setdefault(record.id, record)
```

`_load_plugin(...) -> PluginRecord` never returns `None`: on import/instantiation failure return `PluginRecord(id=plugin_path.name.replace("_", "-"), metadata={"id": ..., "name": plugin_path.name, "description": "", "category": "unknown", "version": "?", "required_roles": []}, plugin=None, directory=plugin_path, load_status="failed", error=str(e))`; when no `Plugin` subclass is found return the same with `error="No Plugin subclass found"`; when `is_available()` is false return a record built from `plugin_instance.metadata` with `load_status="unavailable"` and `error=plugin_class.unavailable_reason()`; on success return `load_status="ok"`. Keep the existing import logic unchanged.

Add helpers and public API:

```python
    def _fail(self, plugin_id: str, reason: str) -> None:
        record = self._records.get(plugin_id)
        if record is not None:
            record.load_status = "failed"
            record.error = reason

    def add_unavailable(self, plugin_id: str, plugin: Plugin, directory: Path | None, reason: str | None) -> None:
        self._records[plugin_id] = PluginRecord(
            id=plugin_id, metadata=plugin.metadata, plugin=plugin, directory=directory,
            load_status="unavailable", error=reason or "Not available in this environment",
        )

    def mark_failed(self, plugin_id: str, reason: str) -> None:
        self._fail(plugin_id, reason)

    def set_disabled(self, disabled: set[str]) -> None:
        self._disabled = set(disabled)

    @property
    def disabled(self) -> set[str]:
        return set(self._disabled)

    def get_records(self) -> list[PluginRecord]:
        return list(self._records.values())

    def get_record(self, plugin_id: str) -> PluginRecord | None:
        return self._records.get(plugin_id)

    def _compute_active(self, disabled: set[str]) -> set[str]:
        active: set[str] = set()
        for pid in self._order:  # dependencies first
            record = self._records[pid]
            if record.load_status != "ok" or pid in disabled:
                continue
            if all(dep in active for dep in record.dependencies):
                active.add(pid)
        return active

    def status(self, plugin_id: str) -> tuple[str, str | None]:
        record = self._records[plugin_id]
        if record.load_status == "unavailable":
            return "unavailable", record.error
        if record.load_status == "failed":
            return "failed", record.error
        if plugin_id in self._disabled:
            return "disabled", None
        active = self._compute_active(self._disabled)
        if plugin_id in active:
            return "active", None
        waiting = [d for d in record.dependencies if d not in active]
        return "inactive", "Waiting for " + ", ".join(waiting)

    def is_active(self, plugin_id: str) -> bool:
        return plugin_id in self._compute_active(self._disabled)

    def dependents(self, plugin_id: str, transitive: bool = False) -> list[str]:
        direct = [r.id for r in self._records.values() if plugin_id in r.dependencies]
        if not transitive:
            return direct
        result: list[str] = []
        for child in direct:
            for pid in [child, *self.dependents(child, transitive=True)]:
                if pid not in result:
                    result.append(pid)
        return result

    def dependencies(self, plugin_id: str, transitive: bool = False) -> list[str]:
        record = self._records[plugin_id]
        result: list[str] = []
        for dep in record.dependencies:
            if dep not in self._records:
                continue
            for pid in [dep, *(self.dependencies(dep, True) if transitive else [])]:
                if pid not in result:
                    result.append(pid)
        return result

    def plan(self, new_disabled: set[str]) -> ChangePlan:
        before = self._compute_active(self._disabled)
        after = self._compute_active(new_disabled)
        return ChangePlan(
            deactivate=[p for p in reversed(self._order) if p in before and p not in after],
            activate=[p for p in self._order if p in after and p not in before],
        )
```

In `_register_with_dependencies`: at the start, `for p in plugins: self._records.setdefault(p.metadata["id"], PluginRecord(id=p.metadata["id"], metadata=p.metadata, plugin=p))`. On a missing dependency call `self._fail(plugin_id, f"Missing dependency: {dep}")` (in `register_plugin`, at the `plugin_id not in plugin_map` branch the failing id is the dependent, so record the failure in the dependent's loop: when `register_plugin(dep_id, ...)` returns False, call `self._fail(plugin_id, f"Dependency {dep_id} could not be loaded")`; use `self._records.get(dep_id)` error text if the dependency is `unavailable`/`failed` in `_records`, and treat a dependency that is present in `_records` as unavailable rather than `not in plugin_map`). On a cycle, `_fail` both ends (`path` members). In `_register_plugin` after success, `self._order.append(plugin_id)`. Log messages stay as they are.

Add `Plugin.unavailable_reason` in `plugin_base.py`:

```python
    @classmethod
    def unavailable_reason(cls) -> str | None:
        """Human-readable reason shown in the plugin manager when is_available() is False."""
        return None
```

Change `get_plugins` to skip non-active plugins (`if not self.is_active(plugin_id): continue` at loop start) and `initialize_all` to iterate `self._order` filtered by `is_active`, setting `record.initialized = True` after success and `self._fail(plugin_id, f"initialize() failed: {e}")` on error.

- [ ] **Step 4: Run new and existing plugin tests**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_plugin_management.py` then `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_plugin_dependencies.py` and `.../test_plugin_system.py`
Expected: all PASS. Fix regressions in existing tests only if they assert dropped-plugin behaviour that intentionally changed.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(plugins): record plugin status and dependency change plans in registry"`

---

### Task 2: Symmetric lifecycle for plugins and frontend extension unregistering

**Files:** Modify `frontend_extension_registry.py`, `plugins/tei_wizard/plugin.py`, `plugins/metadata_extraction/plugin.py`; Test `tests/unit/fastapi/test_plugin_management.py`.

Rationale: `metadata-extraction` registers an enhancement file with `tei-wizard` in `initialize()` and never removes it; `tei-wizard` has no `cleanup()`.

- [ ] **Step 1: Write failing tests** (append to the test file)

```python
from pathlib import Path
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry


class TestExtensionUnregister(unittest.TestCase):
    def setUp(self):
        FrontendExtensionRegistry.reset_instance()

    def test_unregister_plugin_removes_only_its_files(self):
        reg = FrontendExtensionRegistry.get_instance()
        a, b = Path(__file__), Path(__file__).parent / "test_auth.py"
        reg.register_extension(a, "one")
        reg.register_extension(b, "two")
        reg.unregister_plugin("one")
        self.assertEqual([pid for _, pid in reg.get_extension_files()], ["two"])


class TestTeiWizardLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_then_initialize_is_symmetric(self):
        from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin
        p = TeiWizardPlugin()
        await p.initialize(None)
        first = list(p._enhancement_files)
        self.assertTrue(first)
        await p.cleanup()
        self.assertEqual(p._enhancement_files, [])
        await p.initialize(None)
        self.assertEqual(p._enhancement_files, first)

    async def test_unregister_enhancements_by_plugin(self):
        from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin
        p = TeiWizardPlugin()
        p.register_enhancement(Path(__file__), "meta")
        p.unregister_enhancements("meta")
        self.assertEqual([pid for _, pid in p._enhancement_files], [])
```

- [ ] **Step 2: Run to verify failure** (same command as Task 1). Expected: FAIL (`unregister_plugin`/`cleanup` missing).

- [ ] **Step 3: Implement**

`frontend_extension_registry.py`:

```python
    def unregister_plugin(self, plugin_id: str) -> None:
        """Remove all extension files registered by a plugin."""
        self._extension_files = [(f, pid) for f, pid in self._extension_files if pid != plugin_id]
```

`tei_wizard/plugin.py` (read the file first to confirm `_enhancement_files` is a `list[tuple[Path, str]]`):

```python
    def unregister_enhancements(self, plugin_id: str) -> None:
        """Remove all enhancement files registered by a plugin."""
        self._enhancement_files = [(f, pid) for f, pid in self._enhancement_files if pid != plugin_id]

    async def cleanup(self) -> None:
        """Drop all registered enhancements; dependents re-register on their own initialize()."""
        self._enhancement_files = []
```

`metadata_extraction/plugin.py`; store the wizard reference in `initialize()` and undo in `cleanup()`:

```python
    async def cleanup(self) -> None:
        """Remove the enhancement registered with tei-wizard."""
        wizard = getattr(self, "_wizard", None)
        if wizard is not None:
            wizard.unregister_enhancements(self.metadata["id"])
            self._wizard = None
```
and in `initialize()` set `self._wizard = tei_wizard` inside the `isinstance` branch. Check `grobid/plugin.py` `initialize()` for the same tei-wizard registration pattern (line ~102 registers an extension only, which the manager unregisters); if it also calls `register_enhancement`, add the same cleanup.

- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plugins): symmetric cleanup for tei-wizard and metadata-extraction"`

---

### Task 3: Manager persistence and `set_plugin_enabled`

**Files:** Modify `plugin_manager.py`, `config/config.json`; Test `test_plugin_management.py`.

- [ ] **Step 1: Write failing tests** (append)

```python
from unittest.mock import patch

from fastapi_app.lib.plugins.plugin_manager import (
    CascadeRequired, PluginChangeError, PluginManager,
)


class FakeConfig:
    def __init__(self, disabled=None):
        self.store = {"plugins.disabled": disabled or []}

    def get(self, key, default=None):
        return self.store.get(key, default)

    def set(self, key, value, **kw):
        self.store[key] = value
        return True, "ok"


class RecordingPlugin(MockPlugin):
    calls: list[str] = []

    async def initialize(self, context):
        RecordingPlugin.calls.append(f"init:{self._id}")

    async def cleanup(self):
        RecordingPlugin.calls.append(f"cleanup:{self._id}")


class ManagerTestBase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        RecordingPlugin.calls = []
        self._saved = PluginManager._instance
        PluginManager._instance = None
        self.cfg = FakeConfig()
        patcher = patch("fastapi_app.lib.plugins.plugin_manager.get_config", return_value=self.cfg)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.mgr = PluginManager.get_instance()
        self.mgr.registry._register_with_dependencies([
            RecordingPlugin("wizard"), RecordingPlugin("grobid", ["wizard"]),
            RecordingPlugin("meta", ["wizard"]), RecordingPlugin("prot", protected=True),
        ])
        for r in self.mgr.registry.get_records():
            r.initialized = True
        self.mgr.load_disabled()

    def tearDown(self):
        PluginManager._instance = self._saved


class TestSetEnabled(ManagerTestBase):
    async def test_disable_requires_cascade_confirmation(self):
        with self.assertRaises(CascadeRequired) as cm:
            await self.mgr.set_plugin_enabled("wizard", False, cascade=False)
        self.assertEqual(sorted(cm.exception.affected), ["grobid", "meta"])
        self.assertEqual(cm.exception.direction, "disable")
        self.assertEqual(self.cfg.store["plugins.disabled"], [])

    async def test_disable_with_cascade_runs_cleanup_dependents_first(self):
        result = await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(self.cfg.store["plugins.disabled"], ["wizard"])
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
        self.assertEqual(self.cfg.store["plugins.disabled"], [])

    async def test_enable_with_disabled_dependency_needs_cascade(self):
        self.cfg.store["plugins.disabled"] = ["wizard", "grobid"]
        self.mgr.load_disabled()
        with self.assertRaises(CascadeRequired) as cm:
            await self.mgr.set_plugin_enabled("grobid", True, cascade=False)
        self.assertEqual((cm.exception.direction, cm.exception.affected), ("enable", ["wizard"]))
        await self.mgr.set_plugin_enabled("grobid", True, cascade=True)
        self.assertEqual(self.cfg.store["plugins.disabled"], [])

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

    async def test_config_write_failure_runs_no_hooks(self):
        self.cfg.set = lambda *a, **k: (False, "disk full")
        with self.assertRaises(PluginChangeError) as cm:
            await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(cm.exception.status_code, 500)
        self.assertEqual(RecordingPlugin.calls, [])
        self.assertTrue(self.mgr.registry.is_active("wizard"))

    async def test_cleanup_unregisters_frontend_extensions(self):
        from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
        FrontendExtensionRegistry.reset_instance()
        FrontendExtensionRegistry.get_instance().register_extension(Path(__file__), "wizard")
        await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        self.assertEqual(FrontendExtensionRegistry.get_instance().get_extension_files(), [])

    async def test_load_disabled_from_config(self):
        self.cfg.store["plugins.disabled"] = ["grobid"]
        self.mgr.load_disabled()
        self.assertEqual(self.mgr.registry.status("grobid")[0], "disabled")

    async def test_execute_rejects_inactive_plugin(self):
        await self.mgr.set_plugin_enabled("wizard", False, cascade=True)
        with self.assertRaises(ValueError):
            await self.mgr.execute_plugin("wizard", "execute", {})
```

- [ ] **Step 2: Run to verify failure.** Expected: FAIL (`ImportError: CascadeRequired`).

- [ ] **Step 3: Implement** in `plugin_manager.py`.

Imports: `import asyncio`, `from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry`, `from fastapi_app.lib.plugins.plugin_registry import ChangePlan, PluginRegistry`, `from fastapi_app.lib.utils.config_utils import get_config`. Add above the class:

```python
DISABLED_CONFIG_KEY = "plugins.disabled"


class CascadeRequired(Exception):
    """Raised when a toggle affects other plugins and the caller did not confirm."""

    def __init__(self, affected: list[str], direction: str):
        super().__init__(f"Cascade required ({direction}): {', '.join(affected)}")
        self.affected = affected
        self.direction = direction


class PluginChangeError(Exception):
    """Raised when a plugin cannot be toggled; carries the HTTP status to report."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
```

In `__init__` add `self._lock = asyncio.Lock()`. Change `discover_plugins` to call `self.registry.discover_plugins(plugin_dirs, builtin_dir=builtin_dir)` and then `self.load_disabled()`. Add:

```python
    def load_disabled(self) -> None:
        """Load the explicitly disabled plugin ids from config."""
        disabled = get_config().get(DISABLED_CONFIG_KEY, default=[])
        self.registry.set_disabled({str(p) for p in disabled})

    async def set_plugin_enabled(
        self, plugin_id: str, enabled: bool, cascade: bool = False, user: dict | None = None
    ) -> dict[str, Any]:
        """
        Enable or disable a plugin and apply lifecycle hooks without a restart.

        Returns:
            {"changed": {id: status}, "errors": {id: message}, "reload_required": True}

        Raises:
            PluginChangeError: unknown (404), protected/unavailable/failed (409), config write failed (500)
            CascadeRequired: other plugins are affected and cascade is False
        """
        async with self._lock:
            registry = self.registry
            record = registry.get_record(plugin_id)
            if record is None:
                raise PluginChangeError(404, f"Plugin not found: {plugin_id}")
            if record.load_status != "ok":
                raise PluginChangeError(409, f"Plugin is {record.load_status}: {record.error}")
            if not enabled and record.metadata.get("protected", False):
                raise PluginChangeError(409, f"Plugin {plugin_id} is protected and cannot be disabled")

            disabled = registry.disabled
            if enabled:
                needed = [d for d in registry.dependencies(plugin_id, transitive=True) if d in disabled]
                if needed and not cascade:
                    raise CascadeRequired(needed, "enable")
                new_disabled = disabled - {plugin_id} - set(needed)
            else:
                new_disabled = disabled | {plugin_id}
                affected = [p for p in registry.plan(new_disabled).deactivate if p != plugin_id]
                if affected and not cascade:
                    raise CascadeRequired(affected, "disable")

            plan = registry.plan(new_disabled)
            ok, message = get_config().set(
                DISABLED_CONFIG_KEY, sorted(new_disabled), value_type="array",
                description="IDs of backend plugins that an administrator has disabled (managed by the Plugin Manager)",
            )
            if not ok:
                raise PluginChangeError(500, f"Could not save plugin state: {message}")
            registry.set_disabled(new_disabled)

            errors = await self._apply_plan(plan)
            logger.info(
                "Plugin %s %s by %s (deactivated: %s, activated: %s)", plugin_id,
                "enabled" if enabled else "disabled", (user or {}).get("username", "unknown"),
                plan.deactivate, plan.activate,
            )
            touched = {plugin_id, *plan.deactivate, *plan.activate}
            return {
                "changed": {p: registry.status(p)[0] for p in touched},
                "errors": errors,
                "reload_required": True,
            }

    async def _apply_plan(self, plan: ChangePlan) -> dict[str, str]:
        """Run cleanup for deactivated and initialize for activated plugins. Returns errors by id."""
        errors: dict[str, str] = {}
        ext_registry = FrontendExtensionRegistry.get_instance()
        for pid in plan.deactivate:
            record = self.registry.get_record(pid)
            if record is None or record.plugin is None:
                continue
            if record.initialized:
                try:
                    await record.plugin.cleanup()
                except Exception as e:
                    logger.error(f"Error cleaning up plugin {pid}: {e}", exc_info=True)
                    errors[pid] = f"cleanup() failed: {e}"
            record.initialized = False
            ext_registry.unregister_plugin(pid)
        for pid in plan.activate:
            record = self.registry.get_record(pid)
            if record is None or record.plugin is None or not self.registry.is_active(pid):
                continue
            context = PluginContext(app=self._app, plugin_id=pid, registry=self.registry)
            try:
                await record.plugin.initialize(context)
                record.initialized = True
            except Exception as e:
                logger.error(f"Error initializing plugin {pid}: {e}", exc_info=True)
                self.registry.mark_failed(pid, f"initialize() failed: {e}")
                errors[pid] = str(e)
        return errors
```

Guard `execute_plugin`: after fetching the plugin add `if not self.registry.is_active(plugin_id): raise ValueError(f"Plugin not found: {plugin_id}")`. In `config/config.json` add before the closing brace (after `backend-plugins.open-target.values`):

```json
  "plugins.disabled": [],
  "plugins.disabled.description": "IDs of backend plugins that an administrator has disabled (managed by the Plugin Manager)",
  "plugins.disabled.type": "array"
```
(remember the comma after the preceding line).

- [ ] **Step 4: Run tests.** Expected: PASS (also rerun Task 1 file and `test_plugin_system.py`).
- [ ] **Step 5: Commit** `git commit -am "feat(plugins): runtime enable/disable with cascade in PluginManager"`

---

### Task 4: Request-time gate for routes, static files, execute

**Files:** Create `plugin_gate.py`; Modify `plugin_manager.py` (`_try_register_plugin_routes`, `_try_mount_plugin_static_files`); Test `tests/unit/fastapi/test_plugin_management.py`.

- [ ] **Step 1: Write failing tests** (append)

```python
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.plugins.plugin_gate import GatedStaticFiles, plugin_gate


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
        import tempfile
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
```

- [ ] **Step 2: Run to verify failure** (`ModuleNotFoundError: plugin_gate`).

- [ ] **Step 3: Implement** `fastapi_app/lib/plugins/plugin_gate.py`:

```python
"""
Request-time gating of plugin routes and static files.

Plugins stay mounted for the lifetime of the process; these helpers return 404
while a plugin is not active, so enable/disable needs no restart.
"""

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


def _ensure_active(plugin_id: str) -> None:
    from fastapi_app.lib.plugins.plugin_manager import PluginManager  # avoid circular import

    if not PluginManager.get_instance().registry.is_active(plugin_id):
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")


def plugin_gate(plugin_id: str) -> Callable[[], None]:
    """Return a FastAPI dependency that raises 404 while the plugin is not active."""

    def check() -> None:
        _ensure_active(plugin_id)

    return check


class GatedStaticFiles(StaticFiles):
    """StaticFiles that respond 404 while their plugin is not active."""

    def __init__(self, plugin_id: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._plugin_id = plugin_id

    async def get_response(self, path: str, scope: Scope):  # type: ignore[no-untyped-def]
        _ensure_active(self._plugin_id)
        return await super().get_response(path, scope)
```

In `plugin_manager.py` import `from fastapi import Depends` and `from fastapi_app.lib.plugins.plugin_gate import GatedStaticFiles, plugin_gate`; replace `app.include_router(module.router)` with `app.include_router(module.router, dependencies=[Depends(plugin_gate(plugin_id))])` and `StaticFiles(directory=str(static_dir))` with `GatedStaticFiles(plugin_id=plugin_id, directory=str(static_dir))` (drop the now-unused `StaticFiles` import).

- [ ] **Step 4: Run tests** (Task 1, 3, 4 files: all PASS) plus an API smoke run of one existing plugin route test, e.g. `uv run python tests/unit-test-runner.py fastapi_app/plugins/tei_wizard/tests`.
- [ ] **Step 5: Commit** `git commit -am "feat(plugins): gate plugin routes and static files by plugin state"`

---

### Task 5: Admin info builder, README URL, admin router

**Files:** Create `plugin_info.py`, `routers/plugins_admin.py`; Modify `fastapi_app/config.py`, `fastapi_app/main.py`, `plugins/log_viewer/plugin.py`, `plugins/backup_restore/plugin.py`; Test `tests/unit/fastapi/test_plugin_admin_api.py`.

- [ ] **Step 1: Write failing tests**

```python
"""
Tests for the plugin admin API.

@testCovers fastapi_app/routers/plugins_admin.py
@testCovers fastapi_app/lib/plugins/plugin_info.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_admin_user
from fastapi_app.lib.plugins.plugin_manager import PluginManager
from fastapi_app.routers import plugins_admin
from tests.unit.fastapi.test_plugin_management import FakeConfig, RecordingPlugin


class TestPluginAdminApi(unittest.TestCase):
    def setUp(self):
        self._saved = PluginManager._instance
        PluginManager._instance = None
        cfg = FakeConfig()
        p = patch("fastapi_app.lib.plugins.plugin_manager.get_config", return_value=cfg)
        p.start()
        self.addCleanup(p.stop)
        self.cfg = cfg
        self.mgr = PluginManager.get_instance()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        (Path(self.tmp.name) / "README.md").write_text("# x")
        self.mgr.registry._register_with_dependencies([
            RecordingPlugin("wizard"), RecordingPlugin("grobid", ["wizard"]),
        ])
        self.mgr.registry.get_record("wizard").directory = Path(self.tmp.name)
        self.mgr.registry.get_record("wizard").initialized = True
        self.mgr.registry.get_record("grobid").initialized = True
        app = FastAPI()
        app.include_router(plugins_admin.router, prefix="/api/v1")
        self.app = app
        app.dependency_overrides[require_admin_user] = lambda: {"username": "admin", "roles": ["admin"]}
        self.client = TestClient(app)

    def tearDown(self):
        PluginManager._instance = self._saved

    def test_list_includes_dependencies_and_status(self):
        data = self.client.get("/api/v1/plugins/admin").json()["plugins"]
        wizard = next(p for p in data if p["id"] == "wizard")
        self.assertEqual(wizard["dependents"], ["grobid"])
        self.assertEqual(wizard["status"], "active")
        self.assertTrue(wizard["enabled"])

    def test_readme_url_built_for_builtin_with_readme(self):
        rec = self.mgr.registry.get_record("wizard")
        rec.directory = Path(self.tmp.name).parent / "tei_wizard"
        wizard = next(p for p in self.client.get("/api/v1/plugins/admin").json()["plugins"] if p["id"] == "wizard")
        self.assertIsNone(wizard["readme_url"])  # directory has no README.md

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
        from fastapi import HTTPException

        def deny():
            raise HTTPException(status_code=403, detail="Admin access required")

        self.app.dependency_overrides[require_admin_user] = deny
        self.assertEqual(self.client.get("/api/v1/plugins/admin").status_code, 403)
        self.assertEqual(self.client.post("/api/v1/plugins/admin/wizard/disable", json={"cascade": True}).status_code, 403)


class TestReadmeUrl(unittest.TestCase):
    def test_builtin_with_readme(self):
        from fastapi_app.lib.plugins.plugin_info import readme_url_for
        from fastapi_app.lib.plugins.plugin_registry import PluginRecord
        with tempfile.TemporaryDirectory() as d:
            plugin_dir = Path(d) / "log_viewer"
            plugin_dir.mkdir()
            (plugin_dir / "README.md").write_text("x")
            rec = PluginRecord(id="log-viewer", metadata={}, plugin=None, directory=plugin_dir)
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
```

- [ ] **Step 2: Run to verify failure** (`ImportError: plugins_admin`).

- [ ] **Step 3: Implement.**

`fastapi_app/config.py`: add module-level `GITHUB_REPO_URL = "https://github.com/mpilhlt/pdf-tei-editor"`.

`fastapi_app/lib/plugins/plugin_info.py`:

```python
"""Serializable plugin information for the admin API."""

from typing import Any

from fastapi_app.config import GITHUB_REPO_URL
from fastapi_app.lib.plugins.plugin_registry import PluginRecord, PluginRegistry


def readme_url_for(record: PluginRecord) -> str | None:
    """README link: metadata override, else GitHub URL for built-in plugins that ship a README.md."""
    override = record.metadata.get("readme_url")
    if override:
        return str(override)
    if record.external or record.directory is None:
        return None
    if not (record.directory / "README.md").is_file():
        return None
    return f"{GITHUB_REPO_URL}/blob/main/fastapi_app/plugins/{record.directory.name}/README.md"


def build_plugin_info(registry: PluginRegistry, record: PluginRecord) -> dict[str, Any]:
    """Assemble the PluginAdminInfo dict for one plugin."""
    status, reason = registry.status(record.id)
    meta = record.metadata
    directory = record.directory
    ext_dir = directory / "extensions" if directory else None
    return {
        "id": record.id,
        "name": meta.get("name", record.id),
        "version": str(meta.get("version", "")),
        "description": meta.get("description", ""),
        "category": meta.get("category", ""),
        "required_roles": list(meta.get("required_roles", [])),
        "status": status,
        "status_reason": reason,
        "enabled": record.id not in registry.disabled,
        "protected": bool(meta.get("protected", False)),
        "dependencies": record.dependencies,
        "dependents": registry.dependents(record.id, transitive=True) if record.id in registry._records else [],
        "source": "external" if record.external else "builtin",
        "readme_url": readme_url_for(record),
        "has_routes": bool(directory and (directory / "routes.py").is_file()),
        "has_frontend_extension": bool(ext_dir and ext_dir.is_dir() and any(ext_dir.glob("*.js"))),
        "menu_endpoints": len(meta["endpoints"]) if "endpoints" in meta else 1,
    }
```

`fastapi_app/routers/plugins_admin.py`:

```python
"""
Admin API for managing backend plugins (enable/disable, info).

All endpoints require the admin role.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from fastapi_app.lib.core.dependencies import require_admin_user
from fastapi_app.lib.plugins.plugin_info import build_plugin_info
from fastapi_app.lib.plugins.plugin_manager import CascadeRequired, PluginChangeError, PluginManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugins/admin", tags=["plugins-admin"])


class PluginAdminInfo(BaseModel):
    """Plugin information for the plugin manager dialog."""

    id: str
    name: str
    version: str
    description: str
    category: str
    required_roles: list[str]
    status: str
    status_reason: str | None
    enabled: bool
    protected: bool
    dependencies: list[str]
    dependents: list[str]
    source: str
    readme_url: str | None
    has_routes: bool
    has_frontend_extension: bool
    menu_endpoints: int


class PluginAdminListResponse(BaseModel):
    plugins: list[PluginAdminInfo]


class ChangeRequest(BaseModel):
    """Body for enable/disable; cascade confirms the effect on other plugins."""

    cascade: bool = False


class ChangeResult(BaseModel):
    changed: dict[str, str]
    errors: dict[str, str]
    reload_required: bool


class CascadeRequiredResponse(BaseModel):
    detail: str
    affected: list[str]
    direction: str


@router.get("", response_model=PluginAdminListResponse)
async def plugins_admin_list(_admin: dict[str, Any] = Depends(require_admin_user)) -> PluginAdminListResponse:
    """List all discovered plugins with status, dependencies and README link."""
    registry = PluginManager.get_instance().registry
    records = sorted(registry.get_records(), key=lambda r: str(r.metadata.get("name", r.id)).lower())
    return PluginAdminListResponse(plugins=[PluginAdminInfo(**build_plugin_info(registry, r)) for r in records])


async def _change(plugin_id: str, enabled: bool, body: ChangeRequest, admin: dict[str, Any]) -> ChangeResult | JSONResponse:
    manager = PluginManager.get_instance()
    try:
        result = await manager.set_plugin_enabled(plugin_id, enabled, cascade=body.cascade, user=admin)
    except CascadeRequired as e:
        return JSONResponse(
            status_code=409,
            content={"detail": "cascade_required", "affected": e.affected, "direction": e.direction},
        )
    except PluginChangeError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return ChangeResult(**result)


@router.post("/{plugin_id}/enable", response_model=ChangeResult, responses={409: {"model": CascadeRequiredResponse}})
async def plugins_admin_enable(
    plugin_id: str, body: ChangeRequest, admin: dict[str, Any] = Depends(require_admin_user)
) -> ChangeResult | JSONResponse:
    """Enable a plugin (and, with cascade, the disabled plugins it requires)."""
    return await _change(plugin_id, True, body, admin)


@router.post("/{plugin_id}/disable", response_model=ChangeResult, responses={409: {"model": CascadeRequiredResponse}})
async def plugins_admin_disable(
    plugin_id: str, body: ChangeRequest, admin: dict[str, Any] = Depends(require_admin_user)
) -> ChangeResult | JSONResponse:
    """Disable a plugin (and, with cascade, deactivate the plugins that depend on it)."""
    return await _change(plugin_id, False, body, admin)
```

`main.py`: add `plugins_admin,` to the router import list and `api_v1.include_router(plugins_admin.router)` right **before** `api_v1.include_router(plugins.router)`. `log_viewer/plugin.py` and `backup_restore/plugin.py`: add `"protected": True,` to `metadata`.

Note `record.directory` is the plugin directory; `build_plugin_info` uses `registry._records` directly, replace with `registry.get_record(record.id) is not None` if you prefer to avoid touching a private attribute.

- [ ] **Step 4: Run tests.** Expected: PASS. Fix the `test_readme_url_built_for_builtin_with_readme` fixture if needed (it asserts the no-README case); keep `TestReadmeUrl` as the positive case.
- [ ] **Step 5: Commit** `git commit -am "feat(plugins): admin API for plugin management"`

---

### Task 6: Startup wiring and generated API client

**Files:** Modify `fastapi_app/lib/plugins/plugin_registry.py` (verify), `app/src/modules/api-client-v1.js` (generated).

- [ ] **Step 1:** Start-up sanity via existing tests: `uv run python tests/unit-test-runner.py tests/unit/fastapi` — Expected: PASS. Then `uv run python -c "from fastapi_app.main import app; print(len(app.routes))"` — Expected: prints a number, no traceback; then

```bash
uv run python - <<'EOF'
from fastapi_app.main import plugin_manager
for r in plugin_manager.registry.get_records():
    print(r.id, plugin_manager.registry.status(r.id))
EOF
```
Expected: every built-in plugin listed; unavailable ones (missing API keys) show `unavailable` with a reason. If any plugin is `failed` because a dependency plugin is `unavailable`, that is intended.

- [ ] **Step 2:** Regenerate the client: `npm run generate-client`. Then `grep -n "pluginsAdmin" app/src/modules/api-client-v1.js` — record the exact generated method names (expected `pluginsAdminList`, `pluginsAdminEnable`, `pluginsAdminDisable`); use those names verbatim in Task 7.
- [ ] **Step 3: Commit** `git add -A && git commit -m "chore(plugins): regenerate API client for plugin admin endpoints"`

---

### Task 7: Frontend plugin, templates, config-editor filter

**Files:** Create `app/src/plugins/plugin-admin.js`, `app/src/templates/plugin-admin-menu-item.html`, `plugin-admin-dialog.html`, `plugin-admin-confirm-dialog.html` (+ generated `.types.js`); Modify `app/src/plugin-registry.js`, `app/src/plugins.js`, `app/src/ui.js`, `app/src/plugins/config-editor.js`.

- [ ] **Step 1: Templates.**

`plugin-admin-menu-item.html`:

```html
<sl-menu-item name="pluginAdminMenuItem">
  <sl-icon slot="prefix" name="plug"></sl-icon>
  Manage Plugins
</sl-menu-item>
```

`plugin-admin-dialog.html`:

```html
<sl-dialog name="pluginAdminDialog" label="Plugins" class="plugin-admin-dialog" style="--width: 60rem;">
  <div style="display: flex; flex-direction: column; gap: 0.75rem; min-height: 60vh;">
    <div name="summary" style="color: var(--sl-color-neutral-600); font-size: 0.85em;"></div>
    <sl-alert name="reloadBanner" variant="warning" open hidden style="display: none;">
      <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
      <div style="display: flex; align-items: center; gap: 1rem; justify-content: space-between; flex-wrap: wrap;">
        <span>Changes apply to open pages after a reload.</span>
        <sl-button name="reloadBtn" variant="primary" size="small">Reload now</sl-button>
      </div>
    </sl-alert>
    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
      <sl-input name="searchInput" placeholder="Filter by name, description or category" clearable size="small" style="flex: 1; min-width: 14rem;">
        <sl-icon slot="prefix" name="search"></sl-icon>
      </sl-input>
      <div name="statusChips" style="display: flex; gap: 0.35rem; flex-wrap: wrap;"></div>
    </div>
    <div name="pluginList" style="overflow-y: auto; flex: 1; max-height: 60vh; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-medium);"></div>
  </div>
  <div slot="footer">
    <sl-button name="closeBtn" variant="default">Close</sl-button>
  </div>
</sl-dialog>
```

`plugin-admin-confirm-dialog.html`:

```html
<sl-dialog name="pluginAdminConfirmDialog" label="Confirm" style="--width: 30rem;">
  <p name="text" style="margin-top: 0;"></p>
  <ul name="affectedList" style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.35rem;"></ul>
  <div slot="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end;">
    <sl-button name="cancelBtn" variant="default">Cancel</sl-button>
    <sl-button name="okBtn" variant="primary">OK</sl-button>
  </div>
</sl-dialog>
```

Then run `npm run build:ui-types` to generate the `.types.js` files. Register the icons used in a comment block in the plugin file (build system needs it): `plug`, `search`, `exclamation-triangle`, `book`.

- [ ] **Step 2: Plugin `app/src/plugins/plugin-admin.js`:**

```javascript
/**
 * Plugin Manager UI
 *
 * Admin-only dialog (Tools menu, "Administration") to inspect backend plugins and
 * enable/disable them at runtime, with dependency cascade warnings.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { pluginAdminDialogPart } from '../templates/plugin-admin-dialog.types.js'
 * @import { pluginAdminConfirmDialogPart } from '../templates/plugin-admin-confirm-dialog.types.js'
 */

/**
 * @typedef {object} PluginAdminInfo
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} description
 * @property {string} category
 * @property {string} status - active | disabled | inactive | unavailable | failed
 * @property {string|null} status_reason
 * @property {boolean} enabled - explicit state (not in the disabled set)
 * @property {boolean} protected
 * @property {string[]} dependencies
 * @property {string[]} dependents - transitive
 * @property {string} source - builtin | external
 * @property {string|null} readme_url
 * @property {number} menu_endpoints
 * @property {boolean} has_frontend_extension
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'

await registerTemplate('plugin-admin-dialog', 'plugin-admin-dialog.html')
await registerTemplate('plugin-admin-confirm-dialog', 'plugin-admin-confirm-dialog.html')
await registerTemplate('plugin-admin-menu-item', 'plugin-admin-menu-item.html')

// Icons used in plugin-admin templates (needed for build system to include them)
// <sl-icon name="plug"></sl-icon>
// <sl-icon name="search"></sl-icon>
// <sl-icon name="exclamation-triangle"></sl-icon>
// <sl-icon name="book"></sl-icon>

const STATUS_LABELS = { active: 'Active', disabled: 'Disabled', inactive: 'Inactive', unavailable: 'Unavailable', failed: 'Failed' }
const STATUS_VARIANTS = { active: 'success', disabled: 'neutral', inactive: 'warning', unavailable: 'warning', failed: 'danger' }

/** @param {string} s */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

class PluginAdminPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'plugin-admin', deps: ['client', 'tools', 'logger'] })
  }

  get #logger() { return this.getDependency('logger') }
  get #api() { return this.getDependency('client').apiClient }

  /** @type {SlDialog & pluginAdminDialogPart} */
  #dialogUi = null
  /** @type {SlDialog & pluginAdminConfirmDialogPart} */
  #confirmUi = null
  /** @type {HTMLElement | null} */
  #menuItem = null
  /** @type {PluginAdminInfo[]} */
  #plugins = []
  #statusFilter = 'all'
  /** @type {(() => void) | null} */
  #onConfirm = null

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.#dialogUi = this.createUi(createSingleFromTemplate('plugin-admin-dialog', document.body))
    this.#confirmUi = this.createUi(createSingleFromTemplate('plugin-admin-confirm-dialog', document.body))

    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.searchInput.addEventListener('sl-input', () => this.#render())
    this.#dialogUi.reloadBtn.addEventListener('click', () => window.location.reload())
    this.#dialogUi.statusChips.addEventListener('click', e => {
      const chip = /** @type {HTMLElement} */ (e.target).closest('[data-status]')
      if (chip instanceof HTMLElement) {
        this.#statusFilter = chip.dataset.status
        this.#render()
      }
    })
    this.#dialogUi.pluginList.addEventListener('sl-change', e => {
      const sw = /** @type {HTMLElement} */ (e.target).closest('sl-switch')
      if (sw) this.#toggle(sw.dataset.id, /** @type {any} */ (sw).checked)
    })
    this.#dialogUi.pluginList.addEventListener('click', e => {
      const link = /** @type {HTMLElement} */ (e.target).closest('[data-go]')
      if (link instanceof HTMLElement) this.#goTo(link.dataset.go)
    })

    this.#confirmUi.cancelBtn.addEventListener('click', () => { this.#onConfirm = null; this.#confirmUi.hide() })
    this.#confirmUi.okBtn.addEventListener('click', () => {
      const run = this.#onConfirm
      this.#onConfirm = null
      this.#confirmUi.hide()
      if (run) run()
    })
  }

  async start() {
    this.#menuItem = createSingleFromTemplate('plugin-admin-menu-item')
    this.getDependency('tools').addMenuItems([this.#menuItem], 'administration')
    this.#menuItem.addEventListener('click', () => this.#open())
    this.#menuItem.style.display = userIsAdmin(this.state.user) ? '' : 'none'
  }

  /** @param {any} newUser */
  async onUserChange(newUser) {
    if (this.#menuItem) this.#menuItem.style.display = userIsAdmin(newUser) ? '' : 'none'
  }

  async #open() {
    try {
      await this.#load()
      this.#render()
      this.#dialogUi.show()
    } catch (error) {
      this.#logger.error('Failed to open plugin manager: ' + String(error))
      notify('Failed to load plugins', 'danger', 'exclamation-octagon')
    }
  }

  async #load() {
    const response = await this.#api.pluginsAdminList()
    this.#plugins = response.plugins
  }

  /** @param {string} id @returns {PluginAdminInfo} */
  #byId(id) { return this.#plugins.find(p => p.id === id) }

  #render() {
    const ui = this.#dialogUi
    const counts = { all: this.#plugins.length }
    for (const p of this.#plugins) counts[p.status] = (counts[p.status] || 0) + 1
    ui.summary.textContent = `${counts.active || 0} of ${this.#plugins.length} plugins active`

    ui.statusChips.innerHTML = ['all', 'active', 'disabled', 'inactive', 'unavailable', 'failed']
      .filter(k => k === 'all' || counts[k])
      .map(k => `<sl-button size="small" pill data-status="${k}" variant="${this.#statusFilter === k ? 'primary' : 'default'}">${k === 'all' ? 'All' : STATUS_LABELS[k]} (${counts[k]})</sl-button>`)
      .join('')

    const q = ui.searchInput.value.trim().toLowerCase()
    const rows = this.#plugins.filter(p =>
      (this.#statusFilter === 'all' || p.status === this.#statusFilter) &&
      (!q || `${p.id} ${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)))

    ui.pluginList.innerHTML = rows.length ? rows.map(p => this.#rowHtml(p)).join('') : '<div style="padding: 1.5rem; text-align: center; color: var(--sl-color-neutral-600);">No plugins match this filter.</div>'
    ui.reloadBanner.hidden = !this.#reloadPending
    ui.reloadBanner.style.display = this.#reloadPending ? '' : 'none'
  }

  #reloadPending = false

  /** @param {PluginAdminInfo} p */
  #rowHtml(p) {
    const canToggle = !p.protected && (p.status === 'active' || p.status === 'disabled' || p.status === 'inactive')
    const dim = p.status === 'active' ? '' : 'opacity: 0.65;'
    const chips = ids => ids.map(id => `<sl-button size="small" variant="default" data-go="${esc(id)}" style="font-family: var(--sl-font-mono);">${esc(id)}</sl-button>`).join(' ')
    const directDependents = this.#plugins.filter(o => o.dependencies.includes(p.id)).map(o => o.id)
    return `<div id="plugin-row-${esc(p.id)}" style="display: grid; grid-template-columns: 3rem 1fr auto; gap: 0.75rem; padding: 0.85rem 1rem; border-bottom: 1px solid var(--sl-color-neutral-200);">
      <sl-switch data-id="${esc(p.id)}" ${p.enabled ? 'checked' : ''} ${canToggle ? '' : 'disabled'} title="${p.protected ? 'Protected plugin, cannot be disabled' : ''}"></sl-switch>
      <div style="${dim}">
        <div style="display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap;">
          <strong>${esc(p.name)}</strong><small>v${esc(p.version)}</small>
          <sl-badge variant="${STATUS_VARIANTS[p.status]}" pill>${STATUS_LABELS[p.status]}</sl-badge>
          ${p.protected ? '<sl-badge variant="neutral" pill>Protected</sl-badge>' : ''}
        </div>
        <div style="color: var(--sl-color-neutral-600); margin-top: 0.15rem;">${esc(p.description)}</div>
        ${p.status_reason ? `<div style="font-size: 0.85em; margin-top: 0.3rem; color: var(--sl-color-${p.status === 'failed' ? 'danger' : 'warning'}-700);">${esc(p.status_reason)}</div>` : ''}
        ${p.dependencies.length || directDependents.length ? `<div style="margin-top: 0.4rem; display: flex; gap: 0.25rem 1rem; flex-wrap: wrap; font-size: 0.85em; color: var(--sl-color-neutral-600); align-items: center;">
          ${p.dependencies.length ? `<span>Requires ${chips(p.dependencies)}</span>` : ''}
          ${directDependents.length ? `<span>Required by ${chips(directDependents)}</span>` : ''}</div>` : ''}
        <div style="margin-top: 0.3rem; font-size: 0.8em; color: var(--sl-color-neutral-500); display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <span>${esc(p.category)}</span><span>${p.source === 'external' ? 'external' : 'built-in'}</span>
          <span>${p.menu_endpoints} menu ${p.menu_endpoints === 1 ? 'item' : 'items'}</span>${p.has_frontend_extension ? '<span>frontend extension</span>' : ''}
        </div>
      </div>
      ${p.readme_url ? `<sl-button size="small" href="${esc(p.readme_url)}" target="_blank" rel="noopener"><sl-icon slot="prefix" name="book"></sl-icon>README</sl-button>` : '<span></span>'}
    </div>`
  }

  /** @param {string} id */
  #goTo(id) {
    this.#statusFilter = 'all'
    this.#dialogUi.searchInput.value = ''
    this.#render()
    const row = this.#dialogUi.pluginList.querySelector(`#plugin-row-${CSS.escape(id)}`)
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.style.transition = 'background 0.3s'
      row.style.background = 'var(--sl-color-primary-100)'
      setTimeout(() => { row.style.background = '' }, 1200)
    }
  }

  /**
   * @param {string} title
   * @param {string} text
   * @param {string[]} ids
   * @param {string} okLabel
   * @param {'primary'|'danger'} variant
   * @param {() => void} onOk
   */
  #confirm(title, text, ids, okLabel, variant, onOk) {
    const c = this.#confirmUi
    c.label = title
    c.text.textContent = text
    c.affectedList.innerHTML = ids.map(id => {
      const p = this.#byId(id)
      return `<li style="display: flex; justify-content: space-between; padding: 0.4rem 0.6rem; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-small);"><span><strong>${esc(p?.name ?? id)}</strong> <small>${esc(id)}</small></span><sl-badge variant="${STATUS_VARIANTS[p?.status ?? 'neutral']}" pill>${STATUS_LABELS[p?.status] ?? ''}</sl-badge></li>`
    }).join('')
    c.okBtn.textContent = okLabel
    c.okBtn.variant = variant
    this.#onConfirm = onOk
    c.show()
  }

  /**
   * Toggle a plugin; the server re-validates and answers 409 if a cascade was not confirmed.
   * @param {string} id
   * @param {boolean} enable
   */
  #toggle(id, enable) {
    const p = this.#byId(id)
    if (!p) return
    if (!enable) {
      const active = p.dependents.filter(d => this.#byId(d)?.status === 'active')
      if (active.length) {
        return this.#confirm(`Disable ${p.name}?`, `${active.length === 1 ? 'This plugin depends' : 'These plugins depend'} on ${p.name} and will be deactivated as well:`, active, 'Disable all', 'danger', () => this.#apply(p, false, true))
      }
      return this.#apply(p, false, false)
    }
    const needed = this.#requiredDisabled(p)
    if (needed.length) {
      return this.#confirm(`Enable ${p.name}?`, `${p.name} requires ${needed.length === 1 ? 'a plugin that is' : 'plugins that are'} currently disabled. Enable ${needed.length === 1 ? 'it' : 'them'} as well?`, needed, 'Enable all', 'primary', () => this.#apply(p, true, true))
    }
    return this.#apply(p, true, false)
  }

  /** @param {PluginAdminInfo} p @returns {string[]} explicitly disabled transitive dependencies */
  #requiredDisabled(p) {
    const seen = new Set()
    const walk = (/** @type {PluginAdminInfo} */ x) => x.dependencies.forEach(d => {
      const dep = this.#byId(d)
      if (dep && !seen.has(d)) { seen.add(d); walk(dep) }
    })
    walk(p)
    return [...seen].filter(d => !this.#byId(d).enabled)
  }

  /**
   * @param {PluginAdminInfo} p
   * @param {boolean} enable
   * @param {boolean} cascade
   */
  async #apply(p, enable, cascade) {
    try {
      const call = enable ? this.#api.pluginsAdminEnable : this.#api.pluginsAdminDisable
      const result = await call.call(this.#api, p.id, { cascade })
      this.#reloadPending = true
      const others = Object.keys(result.changed).filter(id => id !== p.id).length
      const errors = Object.entries(result.errors)
      if (errors.length) {
        notify(`${p.name}: ${errors.map(([id, m]) => `${id}: ${m}`).join('; ')}`, 'danger', 'exclamation-octagon', 8000)
      } else {
        notify(`${enable ? 'Enabled' : 'Disabled'} ${p.name}` + (others ? ` and ${others} other plugin${others > 1 ? 's' : ''}` : ''), 'success', 'check-circle')
      }
    } catch (error) {
      this.#logger.error('Plugin change failed: ' + String(error))
      notify(`Could not ${enable ? 'enable' : 'disable'} ${p.name}: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
    }
    await this.#load()
    this.#render()
  }
}

export { PluginAdminPlugin }
export default PluginAdminPlugin
```

Before finalising: read `api-client-v1.js` to confirm how generated methods take path params and bodies (positional `(plugin_id, body)` vs an object) and how errors surface; adjust the two `call.call(...)` lines accordingly. Check `notify`'s signature (`message, variant, icon, duration`) — it matches `sl-utils.js`.

- [ ] **Step 3: Wire up.** Add `export { default as PluginAdminPlugin } from './plugins/plugin-admin.js'` to `app/src/plugin-registry.js` (mirror the `ConfigEditorPlugin` line), add `PluginAdminPlugin,` to the import list in `app/src/plugins.js` and, in the plugin array, `PluginAdminPlugin,  // Manage Plugins` right after `ConfigEditorPlugin,`. In `app/src/ui.js` add the `@import`/`@property` lines for `pluginAdminDialog` mirroring `configEditorDialog`. In `config-editor.js`, extend the key filter chain in `#renderConfigList` with `.filter(key => key !== 'plugins.disabled')`.
- [ ] **Step 4: Manual smoke test.** Ask the user to open the running app as admin (dev server auto-reloads; never restart it). Verify: menu entry visible for admin only; list renders; disabling `tei-wizard` shows the cascade dialog listing `grobid` and `metadata-extraction`; after Reload now, their menu items are gone; re-enabling restores them.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(plugins): plugin manager dialog in Tools menu"`

---

### Task 8: E2E test, conformance test, docs

**Files:** Create `tests/e2e/tests/plugin-admin.spec.js`; Test `tests/unit/fastapi/test_plugin_management.py`; Modify docs.

- [ ] **Step 1: Conformance test** (append). Runs `initialize -> cleanup -> initialize` for plugins that can be loaded in the test environment; failure of the *first* initialize is skipped since some plugins need DB/API keys:

```python
class TestBuiltinLifecycleConformance(unittest.IsolatedAsyncioTestCase):
    async def test_initialize_cleanup_initialize(self):
        from fastapi_app.config import get_settings
        registry = PluginRegistry()
        registry.discover_plugins([get_settings().plugins_code_dir], builtin_dir=get_settings().plugins_code_dir)
        checked = 0
        for record in registry.get_records():
            if record.load_status != "ok" or record.plugin is None:
                continue
            ctx = PluginContext(app=None, plugin_id=record.id, registry=registry)
            try:
                await record.plugin.initialize(ctx)
            except Exception:
                continue
            with self.subTest(plugin=record.id):
                await record.plugin.cleanup()
                await record.plugin.initialize(ctx)
                await record.plugin.cleanup()
            checked += 1
        self.assertGreater(checked, 5)
```
(import `PluginContext` from `plugin_base`). Run it; any plugin failing on the second `initialize` needs a fix in that plugin's `cleanup()` (add symmetric undo). Commit fixes separately per plugin.

- [ ] **Step 2: E2E spec.** Read an existing spec (`tests/e2e/tests/auth-workflow.spec.js`) and the "E2E" sections of `docs/code-assistant/testing-guide.md` first, then write `plugin-admin.spec.js` following the same login/helper pattern with `testLog()` and `window.client.apiClient` (no raw `fetch`). Scenarios: (a) admin opens Tools menu, "Manage Plugins" is present; (b) via the dialog, disabling `tei-wizard` shows the confirm dialog listing `grobid`; cancelling changes nothing; confirming shows the reload banner; `apiClient.pluginsAdminList()` reports `tei-wizard` disabled and `grobid` inactive; (c) cleanup: re-enable `tei-wizard` via `apiClient.pluginsAdminEnable('tei-wizard', {cascade: false})` in an `afterAll`. Add `await page.waitForTimeout(500)` before Shoelace dialog button clicks. Run: `node tests/e2e-runner.js tests/e2e/tests/plugin-admin.spec.js`.
- [ ] **Step 3: Docs.** In `docs/code-assistant/backend-plugins.md` add a "Runtime enable/disable" section: `initialize()`/`cleanup()` must be re-entrant and symmetric; optional metadata `protected` and `readme_url`; `Plugin.unavailable_reason()`; disabled plugins stay imported so module-level code must be light. In `docs/development/plugin-system-backend.md` describe `PluginRecord`, statuses, `plugin_gate`, admin API. Add a short user-manual page (find the manual directory via `ls docs/user-manual`) describing the dialog and the reload requirement. Follow markdown rules from CLAUDE.md (language on fences, table spacing).
- [ ] **Step 4: Full checks.** `npm run test:unit:fastapi`, `npm run test:unit:js`, `npm run generate-client:check`, and `npm run test:changed`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "test,docs(plugins): conformance, e2e and documentation for plugin management"`

---

## Self-review

- Spec coverage: state model and statuses (T1), persisted set and config key (T3), cascade semantics (T1/T3), lifecycle hooks and ordering (T3), extension unregistering (T2/T3), gate for routes/static/execute (T3/T4), REST API with 409 body (T5), README URL, info fields (T5), protected/readme_url/unavailable_reason metadata (T1/T5), config editor hiding (T7), UI incl. confirm flows, banner, filters, chips navigation (T7), audit log line (T3), tests (T1-T5, T8), plugin-contract audit (T2, T8 conformance), docs (T8).
- Not implemented on purpose: follow-ups listed in the spec.
- Naming consistency: `set_plugin_enabled`, `CascadeRequired(affected, direction)`, `PluginChangeError(status_code, detail)`, `ChangePlan(deactivate, activate)`, `registry.plan/status/is_active/dependents/dependencies/set_disabled/mark_failed/add_unavailable/get_record(s)`, `plugins_admin_list/enable/disable`.
