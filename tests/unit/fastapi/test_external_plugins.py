"""
Unit tests for loading external plugins from FASTAPI_PLUGIN_PATHS.

External plugins live outside fastapi_app/plugins/ and are imported as packages
under the pte_external_plugins namespace, so they can be split into several
modules with relative imports.

@testCovers fastapi_app/lib/plugins/plugin_paths.py
@testCovers fastapi_app/lib/plugins/plugin_registry.py
@testCovers fastapi_app/lib/plugins/plugin_manager.py
@testCovers fastapi_app/lib/storage/file_zip_exporter.py
"""

import os
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.config import get_settings
from fastapi_app.lib.plugins import plugin_manifest, plugin_paths
from fastapi_app.lib.plugins.plugin_info import build_plugin_info
from fastapi_app.lib.plugins.plugin_manager import PluginManager
from fastapi_app.lib.storage.file_zip_exporter import FileZipExporter

PLUGIN_PY = '''
from typing import Any
from fastapi_app.lib.plugins.plugin_base import Plugin
from .helper import GREETING


class {cls}(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {{
            "id": "{plugin_id}", "name": "{plugin_id}", "description": GREETING,
            "category": "test", "version": "1.0.0", "required_roles": [],
        }}

    def get_endpoints(self):
        return {{}}
'''

ROUTES_PY = '''
from fastapi import APIRouter
from .helper import GREETING

router = APIRouter(prefix="/api/plugins/{plugin_id}")


@router.get("/hello")
async def hello() -> dict[str, str]:
    return {{"greeting": GREETING}}
'''


def write_plugin(base_dir: Path, dir_name: str, plugin_id: str, greeting: str, marker: bool = True) -> Path:
    """Write a multi-module external plugin with a route and a static file."""
    plugin_dir = base_dir / dir_name
    (plugin_dir / "static").mkdir(parents=True)
    if marker:
        (plugin_dir / plugin_paths.PLUGIN_MARKER_FILE).write_text("{}")
    (plugin_dir / "__init__.py").write_text("")
    (plugin_dir / "helper.py").write_text(f"GREETING = {greeting!r}\n")
    cls = "".join(part.capitalize() for part in dir_name.split("_")) + "Plugin"
    (plugin_dir / "plugin.py").write_text(textwrap.dedent(PLUGIN_PY.format(cls=cls, plugin_id=plugin_id)))
    (plugin_dir / "routes.py").write_text(textwrap.dedent(ROUTES_PY.format(plugin_id=plugin_id)))
    (plugin_dir / "static" / "data.txt").write_text(greeting)
    return plugin_dir


class TestExternalPlugins(unittest.TestCase):
    """Discovery, routes and static files of plugins outside fastapi_app/plugins/."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.path_a = self.tmp / "a"
        self.path_b = self.tmp / "b"
        write_plugin(self.path_a, "ext_multi", "ext-multi", "hello from a")
        # Same directory name in a second path: must not clash with the first
        write_plugin(self.path_b, "ext_multi", "ext-multi-b", "hello from b")
        # Same directory name as a built-in plugin: must not load the built-in one
        write_plugin(self.path_b, "grobid", "ext-grobid", "not the built-in")
        self._saved_modules = set(sys.modules)
        self._saved_names = dict(plugin_paths._package_names)
        PluginManager._instance = None

    def tearDown(self):
        for name in set(sys.modules) - self._saved_modules:
            if name.startswith(plugin_paths.EXTERNAL_NAMESPACE):
                del sys.modules[name]
        plugin_paths._package_names.clear()
        plugin_paths._package_names.update(self._saved_names)
        PluginManager._instance = None
        shutil.rmtree(self.tmp)

    def _discover(self) -> PluginManager:
        manager = PluginManager.get_instance()
        manager.registry.discover_plugins(
            [self.path_a, self.path_b], builtin_dir=get_settings().plugins_code_dir
        )
        return manager

    def test_get_external_plugin_dirs_splits_on_pathsep(self):
        value = os.pathsep.join([str(self.path_a), " ", str(self.path_b)])
        with patch.dict(os.environ, {plugin_paths.PLUGIN_PATHS_ENV_VAR: value}):
            self.assertEqual(plugin_paths.get_external_plugin_dirs(), [self.path_a, self.path_b])
            self.assertEqual(
                plugin_paths.get_plugin_dirs(),
                [get_settings().plugins_code_dir, self.path_a, self.path_b],
            )

    def test_multi_module_plugins_load_with_relative_imports(self):
        manager = self._discover()
        for plugin_id, greeting in [
            ("ext-multi", "hello from a"),
            ("ext-multi-b", "hello from b"),
            ("ext-grobid", "not the built-in"),
        ]:
            record = manager.registry.get_record(plugin_id)
            self.assertIsNotNone(record, plugin_id)
            assert record is not None
            self.assertEqual(record.load_status, "ok", record.error)
            self.assertTrue(record.external)
            self.assertEqual(record.metadata["description"], greeting)
        self.assertIsNone(manager.registry.get_record("grobid"))

    def test_package_names_are_unique_and_outside_fastapi_app(self):
        name_a = plugin_paths.get_plugin_package_name(self.path_a / "ext_multi")
        name_b = plugin_paths.get_plugin_package_name(self.path_b / "ext_multi")
        self.assertEqual(name_a, "pte_external_plugins.ext_multi")
        self.assertNotEqual(name_a, name_b)
        self.assertEqual(plugin_paths.get_plugin_package_name(self.path_a / "ext_multi"), name_a)
        builtin = get_settings().plugins_code_dir / "grobid"
        self.assertEqual(plugin_paths.get_plugin_package_name(builtin), "fastapi_app.plugins.grobid")

    def test_routes_and_static_files_are_served(self):
        manager = self._discover()
        app = FastAPI()
        manager.register_plugin_routes(app)
        client = TestClient(app)

        response = client.get("/api/plugins/ext-multi/hello")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"greeting": "hello from a"})
        self.assertEqual(client.get("/api/plugins/ext-multi-b/hello").json(), {"greeting": "hello from b"})
        self.assertEqual(client.get("/api/plugins/ext-multi/static/data.txt").text, "hello from a")

    def test_zip_exporter_resolves_external_static_urls(self):
        self._discover()
        exporter = FileZipExporter(MagicMock(), MagicMock(), MagicMock())
        path = exporter._url_to_path("/api/plugins/ext-multi-b/static/data.txt", get_settings())
        self.assertEqual(path, self.path_b / "ext_multi" / "static" / "data.txt")


class TestExternalPluginDiscovery(unittest.TestCase):
    """FASTAPI_PLUGIN_PATHS pointing to a folder with unrelated repositories."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.executed = self.tmp / "executed.txt"
        self._saved_modules = set(sys.modules)
        self._saved_names = dict(plugin_paths._package_names)
        PluginManager._instance = None

    def tearDown(self):
        for name in set(sys.modules) - self._saved_modules:
            if name.startswith(plugin_paths.EXTERNAL_NAMESPACE):
                del sys.modules[name]
        plugin_paths._package_names.clear()
        plugin_paths._package_names.update(self._saved_names)
        PluginManager._instance = None
        shutil.rmtree(self.tmp)

    def _unrelated(self, path: Path, code: str) -> None:
        path.mkdir(parents=True)
        (path / "plugin.py").write_text(f"open({str(self.executed)!r}, 'a').write('x')\n{code}\n")

    def _discover(self, *dirs: Path) -> PluginManager:
        manager = PluginManager.get_instance()
        manager.registry.discover_plugins(list(dirs), builtin_dir=get_settings().plugins_code_dir)
        return manager

    def test_only_marked_plugins_are_loaded_from_a_folder_of_repositories(self):
        repos = self.tmp / "repos"
        # A plugin repository with its plugins one level down, as in pte-edition-plugin
        write_plugin(repos / "edition-repo" / "plugins", "nested", "ext-nested", "nested")
        # A plugin directory directly inside the listed folder
        write_plugin(repos, "direct", "ext-direct", "direct")
        # Unrelated code with a plugin.py, which must not be imported
        self._unrelated(repos / "other-repo", "import sys; sys.exit(1)")
        write_plugin(repos / "other-repo", "unmarked", "ext-unmarked", "unmarked", marker=False)
        # Marked plugins in skipped and too deeply nested directories
        write_plugin(repos / "app" / "node_modules", "pkg", "ext-node-modules", "skipped")
        write_plugin(repos / ".git", "hooks", "ext-hidden", "skipped")
        write_plugin(repos / "a" / "b" / "c", "deep", "ext-deep", "too deep")

        found = plugin_paths.find_external_plugins(repos)
        self.assertEqual(found, [repos / "direct", repos / "edition-repo" / "plugins" / "nested"])

        manager = self._discover(repos)
        self.assertFalse(self.executed.exists())
        for plugin_id in ["ext-nested", "ext-direct"]:
            record = manager.registry.get_record(plugin_id)
            assert record is not None, plugin_id
            self.assertEqual(record.load_status, "ok", record.error)
        for plugin_id in ["ext-unmarked", "ext-node-modules", "ext-hidden", "ext-deep"]:
            self.assertIsNone(manager.registry.get_record(plugin_id), plugin_id)

    def test_listed_directory_can_be_a_plugin_itself(self):
        plugin_dir = write_plugin(self.tmp, "single", "ext-single", "single")
        record = self._discover(plugin_dir).registry.get_record("ext-single")
        assert record is not None
        self.assertEqual(record.load_status, "ok", record.error)

    def test_plugin_calling_sys_exit_fails_without_stopping_discovery(self):
        exiting = write_plugin(self.tmp / "repos", "exiting", "ext-exiting", "exiting")
        (exiting / "plugin.py").write_text("import sys\nsys.exit(1)\n")
        write_plugin(self.tmp / "repos", "working", "ext-working", "working")

        manager = self._discover(self.tmp / "repos")
        failed = manager.registry.get_record("exiting")
        assert failed is not None
        self.assertEqual(failed.load_status, "failed")
        self.assertIn("SystemExit", failed.error or "")
        working = manager.registry.get_record("ext-working")
        assert working is not None
        self.assertEqual(working.load_status, "ok", working.error)


class TestPluginManifest(unittest.TestCase):
    """version and engines.pte in pte-plugin.json."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.executed = self.tmp / "executed.txt"
        self._saved_modules = set(sys.modules)
        self._saved_names = dict(plugin_paths._package_names)
        PluginManager._instance = None
        self.pte = patch.object(plugin_manifest, "get_pte_version", return_value="0.75.2")
        self.pte.start()

    def tearDown(self):
        self.pte.stop()
        for name in set(sys.modules) - self._saved_modules:
            if name.startswith(plugin_paths.EXTERNAL_NAMESPACE):
                del sys.modules[name]
        plugin_paths._package_names.clear()
        plugin_paths._package_names.update(self._saved_names)
        PluginManager._instance = None
        shutil.rmtree(self.tmp)

    def _plugin(self, dir_name: str, manifest: str | None) -> Path:
        plugin_dir = write_plugin(self.tmp / "plugins", dir_name, dir_name.replace("_", "-"), "hello", marker=False)
        if manifest is not None:
            (plugin_dir / plugin_paths.PLUGIN_MARKER_FILE).write_text(manifest)
        (plugin_dir / "helper.py").write_text(f"open({str(self.executed)!r}, 'a').write('x')\nGREETING = 'hello'\n")
        return plugin_dir

    def _discover(self) -> PluginManager:
        manager = PluginManager.get_instance()
        manager.registry.discover_plugins([self.tmp / "plugins"], builtin_dir=get_settings().plugins_code_dir)
        return manager

    def test_read_manifest(self):
        plugin_dir = self._plugin("p", '{"version": "1.2.0", "engines": {"pte": ">=0.75.0 <1.0.0"}}')
        self.assertEqual(plugin_manifest.read_manifest(plugin_dir), plugin_manifest.PluginManifest("1.2.0", ">=0.75.0 <1.0.0"))
        (plugin_dir / plugin_paths.PLUGIN_MARKER_FILE).write_text("")
        self.assertEqual(plugin_manifest.read_manifest(plugin_dir), plugin_manifest.PluginManifest())
        (plugin_dir / plugin_paths.PLUGIN_MARKER_FILE).unlink()
        self.assertIsNone(plugin_manifest.read_manifest(plugin_dir))

    def test_invalid_manifests_are_rejected(self):
        plugin_dir = self._plugin("p", "{}")
        for bad in ("{not json", "[]", '{"version": 1}', '{"version": "1.2"}', '{"engines": []}',
                    '{"engines": {"pte": 5}}', '{"engines": {"pte": ">=foo"}}'):
            with self.subTest(bad=bad):
                (plugin_dir / plugin_paths.PLUGIN_MARKER_FILE).write_text(bad)
                with self.assertRaises(plugin_manifest.ManifestError):
                    plugin_manifest.read_manifest(plugin_dir)

    def test_compatible_plugin_loads_and_reports_manifest_version(self):
        self._plugin("fits", '{"version": "2.1.0", "engines": {"pte": "^0.75.0"}}')
        manager = self._discover()
        record = manager.registry.get_record("fits")
        assert record is not None
        self.assertEqual(record.load_status, "ok", record.error)
        info = build_plugin_info(manager.registry, record)
        self.assertEqual(info["version"], "2.1.0")
        self.assertEqual(info["requires_pte"], "^0.75.0")

    def test_incompatible_plugin_is_rejected_without_being_imported(self):
        self._plugin("too_new", '{"version": "1.0.0", "engines": {"pte": ">=0.80.0"}}')
        manager = self._discover()
        record = manager.registry.get_record("too-new")
        assert record is not None
        self.assertEqual(record.load_status, "incompatible")
        self.assertEqual(manager.registry.status("too-new"), ("incompatible", "Requires PDF-TEI-Editor >=0.80.0, but this is 0.75.2"))
        self.assertFalse(self.executed.exists())
        self.assertNotIn("too-new", manager.registry.get_all_plugins())

    def test_invalid_manifest_marks_plugin_failed_without_importing_it(self):
        self._plugin("broken", '{"engines": {"pte": ">=foo"}}')
        record = self._discover().registry.get_record("broken")
        assert record is not None
        self.assertEqual(record.load_status, "failed")
        self.assertIn("engines.pte", record.error or "")
        self.assertFalse(self.executed.exists())

    def test_manifest_without_fields_declares_no_constraints(self):
        self._plugin("plain", "")
        self._plugin("braces", "{}")
        manager = self._discover()
        for plugin_id in ("plain", "braces"):
            record = manager.registry.get_record(plugin_id)
            assert record is not None
            self.assertEqual(record.load_status, "ok", record.error)
            self.assertEqual(build_plugin_info(manager.registry, record)["version"], "1.0.0")

    def test_pte_version_comes_from_package_json(self):
        import json
        self.pte.stop()
        try:
            plugin_manifest._pte_version = None
            expected = json.loads((get_settings().project_root_dir / "package.json").read_text())["version"]
            self.assertEqual(plugin_manifest.get_pte_version(), expected)
        finally:
            plugin_manifest._pte_version = None
            self.pte.start()


if __name__ == "__main__":
    unittest.main()
