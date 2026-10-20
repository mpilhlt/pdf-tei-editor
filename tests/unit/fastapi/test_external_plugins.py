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
from fastapi_app.lib.plugins import plugin_paths
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


def write_plugin(base_dir: Path, dir_name: str, plugin_id: str, greeting: str) -> Path:
    """Write a multi-module external plugin with a route and a static file."""
    plugin_dir = base_dir / dir_name
    (plugin_dir / "static").mkdir(parents=True)
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


if __name__ == "__main__":
    unittest.main()
