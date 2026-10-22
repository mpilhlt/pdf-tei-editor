"""
Tests for installing plugins at runtime: wheel checks, catalog, site directory,
live route registration, upgrade, removal and the admin API.

@testCovers fastapi_app/lib/plugins/plugin_wheel.py
@testCovers fastapi_app/lib/plugins/plugin_install.py
@testCovers fastapi_app/lib/plugins/plugin_catalog.py
@testCovers fastapi_app/lib/plugins/plugin_site.py
@testCovers fastapi_app/lib/plugins/plugin_install_policy.py
@testCovers fastapi_app/lib/plugins/plugin_manager.py
@testCovers fastapi_app/routers/plugins_admin.py
"""

import asyncio
import hashlib
import json
import os
import signal
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_admin_user
from fastapi_app.lib.plugins import plugin_paths, plugin_site
from fastapi_app.lib.plugins.plugin_catalog import CatalogError, PluginCatalog
from fastapi_app.lib.plugins.plugin_install import InstallError, download_release
from fastapi_app.lib.plugins.plugin_manager import ConfirmationRequired, PluginChangeError, PluginManager
from fastapi_app.lib.plugins.plugin_state import InstalledPlugin, PluginState, PluginStateStore
from fastapi_app.lib.plugins.plugin_wheel import (
    WheelError,
    check_requirements,
    extract_wheel,
    inspect_wheel,
    parse_checksums,
    sha256_file,
)
from fastapi_app.routers import plugins_admin

PACKAGE = "pte_plugin_rt_hello"
PLUGIN_ID = "rt-hello"

PLUGIN_PY = '''
from fastapi_app.lib.plugins.plugin_base import Plugin

VERSION = "{version}"


class HelloPlugin(Plugin):
    @property
    def metadata(self):
        return {{
            "id": "rt-hello", "name": "Hello", "description": "A runtime-installed plugin",
            "category": "test", "version": VERSION, "required_roles": ["*"], "dependencies": [],
        }}

    def get_endpoints(self):
        return {{}}
'''

ROUTES_PY = '''
from fastapi import APIRouter

from .plugin import VERSION

router = APIRouter(prefix="/api/plugins/rt-hello", tags=["rt-hello"])


@router.get("/ping")
async def ping():
    return {"pong": VERSION}
'''


def build_wheel(
    directory: Path,
    version: str = "1.0.0",
    requires: list[str] | None = None,
    engines: dict[str, str] | None = None,
    extra_files: dict[str, str] | None = None,
    tags: str = "py3-none-any",
) -> Path:
    """Write a plugin wheel like the ones hatchling builds for pte-plugins."""
    dist_info = f"{PACKAGE}-{version}.dist-info"
    metadata = f"Metadata-Version: 2.4\nName: pte-plugin-rt-hello\nVersion: {version}\nSummary: Hello at runtime\n"
    for req in requires or []:
        metadata += f"Requires-Dist: {req}\n"
    files = {
        f"{PACKAGE}/__init__.py": "",
        f"{PACKAGE}/plugin.py": PLUGIN_PY.format(version=version),
        f"{PACKAGE}/routes.py": ROUTES_PY,
        f"{PACKAGE}/pte-plugin.json": json.dumps({"version": version, "engines": engines or {"pte-plugin-api": "^1.0"}}),
        f"{dist_info}/METADATA": metadata,
        f"{dist_info}/WHEEL": f"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: {tags}\n",
        f"{dist_info}/entry_points.txt": f"[pte.plugins]\n{PLUGIN_ID} = {PACKAGE}\n",
        f"{dist_info}/RECORD": "",
        **(extra_files or {}),
    }
    path = directory / f"{PACKAGE}-{version}-{tags}.whl"
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return path


def forget_plugin_modules() -> None:
    """Remove the test plugin from sys.modules, sys.path and the package registry."""
    for name in [m for m in sys.modules if m == PACKAGE or m.startswith(PACKAGE + ".")]:
        del sys.modules[name]
    for entry in [p for p in sys.path if "pte-plugin-rt-hello" in p]:
        sys.path.remove(entry)
    for path in [p for p, name in plugin_paths._package_names.items() if name == PACKAGE]:
        del plugin_paths._package_names[path]
    plugin_paths._installed_packages.discard(PACKAGE)


class TestWheel(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_inspect_reads_metadata_entry_point_and_manifest(self):
        info = inspect_wheel(build_wheel(self.dir, requires=["requests>=2", "llamore; extra == 'x'"]))
        self.assertEqual((info.plugin_id, info.package, info.version), (PLUGIN_ID, PACKAGE, "1.0.0"))
        self.assertEqual(info.distribution, "pte-plugin-rt-hello")
        self.assertEqual(info.manifest.plugin_api if info.manifest else None, "^1.0")
        self.assertEqual(len(info.requires), 2)

    def test_rejects_unsafe_and_non_pure_wheels(self):
        cases = {
            "path": {"extra_files": {"../evil.py": ""}},
            "top-level": {"extra_files": {"other_pkg/__init__.py": ""}},
            "data": {"extra_files": {f"{PACKAGE}-1.0.0.data/scripts/x": ""}},
            "tags": {"tags": "cp313-cp313-linux_x86_64"},
        }
        for name, kwargs in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                with self.assertRaises(WheelError):
                    inspect_wheel(build_wheel(Path(d), **kwargs))

    def test_rejects_symlinks(self):
        path = build_wheel(self.dir)
        with zipfile.ZipFile(path, "a") as zf:
            info = zipfile.ZipInfo(f"{PACKAGE}/link")
            info.external_attr = (0o120777 << 16)
            zf.writestr(info, "/etc/passwd")
        with self.assertRaises(WheelError):
            inspect_wheel(path)

    def test_check_requirements(self):
        available = {"requests": "2.33.0", "pte-plugin-grobid": "1.0.0"}
        self.assertEqual(check_requirements(["requests>=2", "pte-plugin-grobid>=1,<2", "x; extra == 'dev'"], available), [])
        unmet = check_requirements(["requests>=3", "llamore", "pdf-tei-editor>=0.1"], available)
        self.assertEqual(len(unmet), 2)
        self.assertIn("installed: 2.33.0", unmet[0])
        self.assertIn("not installed", unmet[1])

    def test_parse_checksums(self):
        digest = "a" * 64
        self.assertEqual(parse_checksums(f"{digest}  x.whl\n{digest} *y.whl\nnonsense\n"), {"x.whl": digest, "y.whl": digest})

    def test_extract_is_atomic(self):
        target = self.dir / "site" / "pte-plugin-rt-hello" / "1.0.0"
        extract_wheel(build_wheel(self.dir), target)
        self.assertTrue((target / PACKAGE / "plugin.py").is_file())
        with self.assertRaises(WheelError):
            extract_wheel(build_wheel(self.dir), target)


class FakeGitHub:
    """GitHubClient serving canned responses."""

    def __init__(self, responses: dict[str, Any], files: dict[str, Path] | None = None):
        self.responses = responses
        self.files = files or {}
        self.requests: list[str] = []

    def get_json(self, url: str) -> Any:
        self.requests.append(url)
        if url not in self.responses:
            raise CatalogError(f"HTTP 404 for {url}")
        return self.responses[url]

    def get_text(self, url: str) -> str:
        return str(self.get_json(url))

    def download(self, url: str, dest: Path) -> None:
        self.requests.append(url)
        dest.write_bytes(self.files[url].read_bytes())


def repository_responses(
    repo: str, wheel: Path | None = None, checksum: str | None = None, branch: str = "main",
    dependencies: list[str] | None = None,
) -> dict[str, Any]:
    """Canned GitHub answers for a plugin repository with one release of the test plugin."""
    assets = []
    if wheel is not None:
        assets = [
            {"name": wheel.name, "browser_download_url": f"https://dl/{repo}/{wheel.name}"},
            {"name": "SHA256SUMS", "browser_download_url": f"https://dl/{repo}/SHA256SUMS"},
        ]
    return {
        f"https://api.github.com/repos/{repo}": {"default_branch": branch},
        f"https://raw.githubusercontent.com/{repo}/{branch}/pte-plugins.json": {
            "plugins": [{
                "id": PLUGIN_ID, "package": "pte-plugin-rt-hello", "module": PACKAGE, "path": "plugins/rt-hello",
                "version": "1.0.0", "description": "Hello", "requires": [], "dependencies": dependencies or [],
                "engines": {"pte-plugin-api": "^1.0"},
            }],
        },
        f"https://api.github.com/repos/{repo}/releases?per_page=100": [
            {"tag_name": f"{PLUGIN_ID}-v1.0.0", "assets": assets, "published_at": "2026-10-22T00:00:00Z"},
            {"tag_name": "other-v2.0.0", "assets": []},
        ],
        f"https://dl/{repo}/SHA256SUMS": f"{checksum or '0' * 64}  {wheel.name if wheel else 'x'}\n",
    }


class TestCatalog(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"PTE_PLUGIN_DISCOVER_TOPIC": ""}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for name in ("PTE_PLUGIN_SOURCES", "PTE_PLUGIN_TRUSTED_OWNERS", "PTE_PLUGIN_TRUSTED_ONLY"):
            os.environ.pop(name, None)

    def test_default_source_is_mpilhlt(self):
        client = FakeGitHub(repository_responses("mpilhlt/pte-plugins", Path("pte_plugin_rt_hello-1.0.0-py3-none-any.whl")))
        catalog = PluginCatalog(client).get()
        self.assertEqual(catalog.errors, {})
        (entry,) = catalog.entries
        self.assertEqual((entry.repository, entry.trusted), ("mpilhlt/pte-plugins", True))
        self.assertEqual([r.version for r in entry.releases], ["1.0.0"])
        self.assertEqual(entry.latest.tag if entry.latest else None, "rt-hello-v1.0.0")

    def test_sources_and_trusted_owners_from_environment(self):
        os.environ["PTE_PLUGIN_SOURCES"] = "someone/plugins, not a repo"
        client = FakeGitHub(repository_responses("someone/plugins"))
        catalog = PluginCatalog(client).get()
        self.assertEqual([e.repository for e in catalog.entries], ["someone/plugins"])
        self.assertFalse(catalog.entries[0].trusted)
        self.assertEqual(catalog.entries[0].releases, [])  # no wheel asset
        os.environ["PTE_PLUGIN_TRUSTED_OWNERS"] = "mpilhlt,someone"
        self.assertTrue(PluginCatalog(client).get().entries[0].trusted)

    def test_topic_search_and_trusted_only(self):
        os.environ["PTE_PLUGIN_DISCOVER_TOPIC"] = "pte-plugin"
        responses = {
            **repository_responses("mpilhlt/pte-plugins"),
            **repository_responses("stranger/plugin"),
            "https://api.github.com/search/repositories?q=topic:pte-plugin&per_page=50": {
                "items": [{"full_name": "stranger/plugin"}, {"full_name": "old/archived", "archived": True}],
            },
        }
        catalog = PluginCatalog(FakeGitHub(responses)).get()
        self.assertEqual(sorted(e.repository for e in catalog.entries), ["mpilhlt/pte-plugins", "stranger/plugin"])
        os.environ["PTE_PLUGIN_TRUSTED_ONLY"] = "1"
        catalog = PluginCatalog(FakeGitHub(responses)).get()
        self.assertEqual([e.repository for e in catalog.entries], ["mpilhlt/pte-plugins"])

    def test_unreadable_repository_is_reported(self):
        catalog = PluginCatalog(FakeGitHub({})).get()
        self.assertEqual(catalog.entries, [])
        self.assertIn("mpilhlt/pte-plugins", catalog.errors)

    def test_cache(self):
        client = FakeGitHub(repository_responses("mpilhlt/pte-plugins"))
        catalog = PluginCatalog(client)
        catalog.get()
        count = len(client.requests)
        catalog.get()
        self.assertEqual(len(client.requests), count)
        catalog.get(refresh=True)
        self.assertGreater(len(client.requests), count)

    def test_download_verifies_checksum(self):
        with tempfile.TemporaryDirectory() as d:
            wheel = build_wheel(Path(d))
            good = repository_responses("mpilhlt/pte-plugins", wheel, sha256_file(wheel))
            bad = repository_responses("mpilhlt/pte-plugins", wheel, "f" * 64)
            for responses, ok in ((good, True), (bad, False)):
                client = FakeGitHub(responses, {f"https://dl/mpilhlt/pte-plugins/{wheel.name}": wheel})
                entry = PluginCatalog(client).get().entries[0]
                assert entry.latest is not None
                with tempfile.TemporaryDirectory() as work:
                    if ok:
                        self.assertEqual(download_release(client, entry, entry.latest, Path(work)).sha256, sha256_file(wheel))
                    else:
                        with self.assertRaises(InstallError) as ctx:
                            download_release(client, entry, entry.latest, Path(work))
                        self.assertIn("Checksum mismatch", ctx.exception.detail)


class TestPluginStateInstalled(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            store = PluginStateStore(Path(d))
            entry = InstalledPlugin(
                id="x", package="pte_plugin_x", distribution="pte-plugin-x", version="1.0.0", path="pte-plugin-x/1.0.0",
                repository="mpilhlt/pte-plugins", tag="x-v1.0.0", sha256="0" * 64, dependencies=("grobid",),
            )
            store.update(lambda s: PluginState(
                disabled=frozenset({"x"}), installed=(entry,), pending_removal=frozenset({"pte-plugin-x/0.9.0"}),
                restart_required_at=5.0, restart_plugins=frozenset({"x"}),
            ))
            state = store.read()
            self.assertEqual(state.generation, 1)
            self.assertEqual(state.get_installed("x"), entry)
            self.assertEqual(state.pending_removal, frozenset({"pte-plugin-x/0.9.0"}))
            self.assertEqual((state.restart_required_at, state.restart_plugins), (5.0, frozenset({"x"})))
            # changing the disabled set keeps the installations
            store.write(set())
            self.assertEqual(store.read().installed, (entry,))

    def test_site_paths_stay_inside_the_site_directory(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                plugin_site.resolve_site_path("../db", Path(d))
            self.assertEqual(plugin_site.resolve_site_path("a/1.0", Path(d)), (Path(d) / "a" / "1.0").resolve())


class RuntimeInstallTestCase(unittest.TestCase):
    """A PluginManager with an app, a temporary data directory and the test plugin's wheels."""

    def setUp(self):
        forget_plugin_modules()
        self.addCleanup(forget_plugin_modules)
        self._saved = PluginManager._instance
        self.addCleanup(setattr, PluginManager, "_instance", self._saved)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.site_dir = root / "plugins" / "site"
        self.db_dir = root / "db"
        self.wheels = root / "wheels"
        self.wheels.mkdir()
        self.builtin_dir = root / "builtin"
        self.builtin_dir.mkdir()
        p = patch("fastapi_app.lib.plugins.plugin_site.get_site_dir", return_value=self.site_dir)
        p.start()
        self.addCleanup(p.stop)
        self.mgr = self.new_manager()

    def new_manager(self) -> PluginManager:
        """A fresh manager (like another worker process) on the shared state."""
        PluginManager._instance = None
        mgr = PluginManager.get_instance()
        mgr.state_store = PluginStateStore(self.db_dir)
        mgr.load_disabled()
        return mgr

    def make_app(self, mgr: PluginManager) -> FastAPI:
        """An app shaped like main.py: plugin routes, admin router, then a catch-all static mount."""
        app = FastAPI()
        app.include_router(plugins_admin.router, prefix="/api/v1")
        mgr.register_plugin_routes(app)
        static = Path(self.tmp.name) / "web"
        static.mkdir(exist_ok=True)
        app.mount("/", StaticFiles(directory=str(static), html=True), name="static")
        app.dependency_overrides[require_admin_user] = lambda: {"username": "admin", "roles": ["admin"]}
        return app

    def install(self, mgr: PluginManager, version: str = "1.0.0", **kwargs: Any) -> dict[str, Any]:
        wheel = build_wheel(self.wheels, version=version, **kwargs)
        return asyncio.run(mgr.install_wheel(wheel, sha256_file(wheel), "mpilhlt/pte-plugins", f"{PLUGIN_ID}-v{version}", True))

    def discover(self, mgr: PluginManager) -> None:
        """Startup discovery limited to the site directory (no built-in or environment plugins)."""
        def site_dirs() -> list[Path]:
            return [self.builtin_dir, *[d for d in plugin_paths.get_installed_plugin_dirs() if plugin_site.is_site_path(d)]]

        with patch("fastapi_app.lib.plugins.plugin_manager.get_plugin_dirs", side_effect=site_dirs), \
                patch("fastapi_app.lib.plugins.plugin_manager.get_settings") as settings:
            settings.return_value.plugins_code_dir = self.builtin_dir
            mgr.discover_plugins()


class TestRuntimeInstall(RuntimeInstallTestCase):
    def test_install_lists_plugin_without_importing_it(self):
        result = self.install(self.mgr)
        self.assertEqual((result["action"], result["restart_required"]), ("install", False))
        record = self.mgr.registry.get_record(PLUGIN_ID)
        assert record is not None
        self.assertTrue(record.deferred and record.site)
        self.assertEqual(self.mgr.registry.status(PLUGIN_ID)[0], "disabled")
        self.assertNotIn(f"{PACKAGE}.plugin", sys.modules)
        state = self.mgr.state_store.read()
        self.assertIn(PLUGIN_ID, state.disabled)
        self.assertEqual(state.get_installed(PLUGIN_ID).path if state.get_installed(PLUGIN_ID) else None, "pte-plugin-rt-hello/1.0.0")
        self.assertTrue((self.site_dir / "pte-plugin-rt-hello" / "1.0.0" / PACKAGE / "plugin.py").is_file())

    def test_enable_imports_plugin_and_registers_routes_live(self):
        app = self.make_app(self.mgr)
        client = TestClient(app)
        self.install(self.mgr)
        self.assertEqual(client.get("/api/plugins/rt-hello/ping").status_code, 404)
        r = client.post(f"/api/v1/plugins/admin/{PLUGIN_ID}/enable", json={"cascade": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(f"{PACKAGE}.plugin", sys.modules)
        self.assertEqual(client.get("/api/plugins/rt-hello/ping").json(), {"pong": "1.0.0"})
        self.assertIn("/api/plugins/rt-hello/ping", client.get("/openapi.json").json()["paths"])
        # the routes were inserted before the catch-all mount (which would answer 404 otherwise)
        self.assertEqual(getattr(app.router.routes[-1], "name", None), "static")
        # disabling gates the live routes
        client.post(f"/api/v1/plugins/admin/{PLUGIN_ID}/disable", json={"cascade": False})
        self.assertEqual(client.get("/api/plugins/rt-hello/ping").status_code, 404)

    def test_other_workers_list_and_load_the_plugin(self):
        self.install(self.mgr)
        worker = self.new_manager()
        worker.generation = 0
        asyncio.run(worker.reconcile())
        record = worker.registry.get_record(PLUGIN_ID)
        self.assertTrue(record is not None and record.deferred)
        PluginManager._instance = self.mgr
        asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, True))
        asyncio.run(worker.reconcile())
        self.assertTrue(worker.registry.is_active(PLUGIN_ID))

    def test_startup_defers_disabled_and_loads_enabled_site_plugins(self):
        self.install(self.mgr)
        forget_plugin_modules()
        worker = self.new_manager()
        self.discover(worker)
        record = worker.registry.get_record(PLUGIN_ID)
        self.assertTrue(record is not None and record.deferred and record.site)
        self.assertNotIn(f"{PACKAGE}.plugin", sys.modules)
        # enabled: imported at startup
        worker.state_store.write(set())
        forget_plugin_modules()
        worker = self.new_manager()
        self.discover(worker)
        record = worker.registry.get_record(PLUGIN_ID)
        self.assertTrue(record is not None and not record.deferred and record.site)
        self.assertTrue(worker.registry.is_active(PLUGIN_ID))

    def test_incompatible_or_unmet_requirements_are_refused(self):
        with self.assertRaises(InstallError) as ctx:
            self.install(self.mgr, requires=["surely-not-installed-package>=1"])
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(len(ctx.exception.unmet), 1)
        with self.assertRaises(InstallError):
            self.install(self.mgr, version="1.0.1", engines={"pte-plugin-api": "^9.0"})
        self.assertFalse((self.site_dir / "pte-plugin-rt-hello").exists())

    def test_upgrade_of_imported_plugin_requires_restart(self):
        self.install(self.mgr)
        asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, True))
        with self.assertRaises(InstallError):
            self.install(self.mgr)  # same version
        result = self.install(self.mgr, version="1.1.0")
        self.assertEqual((result["action"], result["restart_required"]), ("upgrade", True))
        state = self.mgr.state_store.read()
        self.assertEqual(state.get_installed(PLUGIN_ID).version if state.get_installed(PLUGIN_ID) else None, "1.1.0")
        self.assertIn("pte-plugin-rt-hello/1.0.0", state.pending_removal)
        self.assertEqual(state.restart_plugins, frozenset({PLUGIN_ID}))
        self.assertEqual(self.mgr.restart_pending(), 1)
        self.assertEqual(self.mgr.propagation()["restart_pending"], 1)
        # still enabled, still running the old code
        self.assertTrue(self.mgr.registry.is_active(PLUGIN_ID))
        # a worker started after the upgrade deletes the old version and runs the new one
        forget_plugin_modules()
        worker = self.new_manager()
        worker.started = state.restart_required_at + 1  # type: ignore[operator]
        self.discover(worker)
        self.assertFalse((self.site_dir / "pte-plugin-rt-hello" / "1.0.0").exists())
        self.assertEqual(worker.restart_pending(), 0)
        plugin = worker.registry.get_plugin(PLUGIN_ID)
        self.assertEqual(plugin.metadata["version"] if plugin else None, "1.1.0")

    def test_upgrade_of_deferred_plugin_needs_no_restart(self):
        self.install(self.mgr)
        result = self.install(self.mgr, version="1.1.0")
        self.assertFalse(result["restart_required"])
        asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, True))
        plugin = self.mgr.registry.get_plugin(PLUGIN_ID)
        self.assertEqual(plugin.metadata["version"] if plugin else None, "1.1.0")

    def test_enable_is_refused_while_restart_is_pending(self):
        self.install(self.mgr)
        asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, True))
        self.install(self.mgr, version="1.1.0")
        asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, False))
        with self.assertRaises(PluginChangeError) as ctx:
            asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, True))
        self.assertEqual(ctx.exception.status_code, 409)

    def test_remove(self):
        self.install(self.mgr)
        result = asyncio.run(self.mgr.remove_plugin(PLUGIN_ID))
        self.assertFalse(result["restart_required"])
        self.assertIsNone(self.mgr.registry.get_record(PLUGIN_ID))
        state = self.mgr.state_store.read()
        self.assertIsNone(state.get_installed(PLUGIN_ID))
        self.assertEqual(state.pending_removal, frozenset({"pte-plugin-rt-hello/1.0.0"}))
        self.discover(self.new_manager())
        self.assertFalse((self.site_dir / "pte-plugin-rt-hello").exists())
        self.assertEqual(self.mgr.state_store.read().pending_removal, frozenset())
        with self.assertRaises(PluginChangeError):
            asyncio.run(self.mgr.remove_plugin(PLUGIN_ID))

    def test_remove_of_enabled_plugin_disables_it_and_requires_restart(self):
        self.install(self.mgr)
        asyncio.run(self.mgr.set_plugin_enabled(PLUGIN_ID, True))
        result = asyncio.run(self.mgr.remove_plugin(PLUGIN_ID))
        self.assertTrue(result["restart_required"])
        self.assertFalse(self.mgr.registry.is_active(PLUGIN_ID))

    def test_built_in_plugins_cannot_be_replaced(self):
        from tests.unit.fastapi.test_plugin_management import MockPlugin

        self.mgr.registry._register_with_dependencies([MockPlugin(PLUGIN_ID)])
        with self.assertRaises(InstallError) as ctx:
            self.install(self.mgr)
        self.assertIn("Built-in", ctx.exception.detail)


class TestInstallPolicyAndApi(RuntimeInstallTestCase):
    def setUp(self):
        super().setUp()
        for name in ("PTE_PLUGIN_INSTALL", "PTE_PLUGIN_SOURCES", "PTE_PLUGIN_TRUSTED_OWNERS", "PTE_PLUGIN_TRUSTED_ONLY", "PTE_WORKER_RECYCLE"):
            os.environ.pop(name, None)
        env = patch.dict(os.environ, {"PTE_PLUGIN_DISCOVER_TOPIC": ""})
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(self.make_app(self.mgr))

    def use_repository(self, repo: str, dependencies: list[str] | None = None) -> None:
        wheel = build_wheel(self.wheels)
        self.mgr.catalog = PluginCatalog(FakeGitHub(
            repository_responses(repo, wheel, sha256_file(wheel), dependencies=dependencies),
            {f"https://dl/{repo}/{wheel.name}": wheel},
        ))

    def test_available_reports_unmet_requirements(self):
        os.environ["PTE_PLUGIN_INSTALL"] = "1"
        self.use_repository("mpilhlt/pte-plugins", dependencies=["requests>=2", "surely-not-installed-package"])
        (plugin,) = self.client.get("/api/v1/plugins/admin/available").json()["plugins"]
        self.assertFalse(plugin["installable"])
        self.assertEqual(len(plugin["unmet_requirements"]), 1)

    def test_install_requires_operator_opt_in(self):
        self.assertFalse(self.client.get("/api/v1/plugins/admin").json()["install_enabled"])
        self.assertEqual(self.client.get("/api/v1/plugins/admin/available").status_code, 403)
        r = self.client.post("/api/v1/plugins/admin/install", json={"repository": "mpilhlt/pte-plugins", "id": PLUGIN_ID})
        self.assertEqual(r.status_code, 403)

    def test_available_and_install_through_the_api(self):
        os.environ["PTE_PLUGIN_INSTALL"] = "1"
        self.use_repository("mpilhlt/pte-plugins")
        available = self.client.get("/api/v1/plugins/admin/available").json()
        (plugin,) = available["plugins"]
        self.assertEqual((plugin["id"], plugin["latest_version"], plugin["installable"]), (PLUGIN_ID, "1.0.0", True))
        self.assertIsNone(plugin["installed_version"])
        r = self.client.post("/api/v1/plugins/admin/install", json={"repository": "mpilhlt/pte-plugins", "id": PLUGIN_ID})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["action"], "install")
        listed = next(p for p in self.client.get("/api/v1/plugins/admin").json()["plugins"] if p["id"] == PLUGIN_ID)
        self.assertEqual((listed["source"], listed["status"], listed["removable"]), ("site", "disabled", True))
        self.assertEqual(listed["installed_from"], "mpilhlt/pte-plugins@rt-hello-v1.0.0")
        r = self.client.post(f"/api/v1/plugins/admin/{PLUGIN_ID}/remove", json={"cascade": False})
        self.assertEqual(r.status_code, 200, r.text)
        audit = [json.loads(line)["action"] for line in (self.db_dir / "plugin-audit.jsonl").read_text().splitlines()]
        self.assertEqual(audit, ["discover", "install", "remove"])

    def test_untrusted_repository_needs_confirmation(self):
        os.environ["PTE_PLUGIN_INSTALL"] = "1"
        os.environ["PTE_PLUGIN_SOURCES"] = "stranger/plugins"
        self.use_repository("stranger/plugins")
        body = {"repository": "stranger/plugins", "id": PLUGIN_ID}
        r = self.client.post("/api/v1/plugins/admin/install", json=body)
        self.assertEqual(r.status_code, 409)
        detail = r.json()["detail"]
        self.assertEqual((detail["code"], detail["repository"]), ("confirmation_required", "stranger/plugins"))
        r = self.client.post("/api/v1/plugins/admin/install", json={**body, "confirm": "stranger/plugins"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.mgr.state_store.read().installed[0].trusted)

    def test_trusted_only_refuses_untrusted_repositories(self):
        os.environ.update({"PTE_PLUGIN_INSTALL": "1", "PTE_PLUGIN_TRUSTED_ONLY": "1"})
        with self.assertRaises(PluginChangeError) as ctx:
            asyncio.run(self.mgr.install_plugin("stranger/plugins", PLUGIN_ID, confirm="stranger/plugins"))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_repository_must_be_listed(self):
        os.environ["PTE_PLUGIN_INSTALL"] = "1"
        self.use_repository("mpilhlt/pte-plugins")
        with self.assertRaises(ConfirmationRequired):
            asyncio.run(self.mgr.install_plugin("other/repo", PLUGIN_ID))
        with self.assertRaises(PluginChangeError) as ctx:
            asyncio.run(self.mgr.install_plugin("other/repo", PLUGIN_ID, confirm="other/repo"))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_restart(self):
        r = self.client.post("/api/v1/plugins/admin/restart")
        self.assertEqual(r.status_code, 409)
        self.assertFalse(self.client.get("/api/v1/plugins/admin").json()["restart_supported"])
        os.environ["PTE_WORKER_RECYCLE"] = "1"
        with patch("fastapi_app.lib.plugins.plugin_manager.os.kill") as kill, \
                patch.object(PluginManager, "_schedule") as schedule:
            r = self.client.post("/api/v1/plugins/admin/restart")
            self.assertEqual(r.json(), {"restarting": True})
            delay, callback = schedule.call_args.args
            callback()
            kill.assert_called_once_with(os.getppid(), signal.SIGHUP)


if __name__ == "__main__":
    unittest.main()
