"""
Unit tests for installing the Python packages of runtime-installed plugins.

The uv tests resolve and install from a local wheel directory (UV_NO_INDEX, UV_FIND_LINKS),
so they need uv but no network.

@testCovers fastapi_app/lib/plugins/plugin_deps.py
@testCovers fastapi_app/lib/plugins/plugin_install.py
@testCovers fastapi_app/lib/plugins/plugin_manager.py
"""

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from fastapi_app.lib.plugins import plugin_deps
from fastapi_app.lib.plugins.plugin_install import InstallError
from fastapi_app.lib.plugins.plugin_wheel import installed_distributions
from tests.unit.fastapi.test_plugin_runtime_install import (
    RuntimeInstallTestCase,
    build_wheel,
    sha256_file,
)

DEP_DIST = "rt-hello-dep"
DEP_MODULE = "rt_hello_dep"


def build_dependency_wheel(directory: Path, version: str = "1.0.0") -> Path:
    """A minimal pure-Python wheel of a third-party package."""
    dist_info = f"{DEP_MODULE}-{version}.dist-info"
    files = {
        f"{DEP_MODULE}/__init__.py": f"VERSION = '{version}'\n",
        f"{dist_info}/METADATA": f"Metadata-Version: 2.1\nName: {DEP_DIST}\nVersion: {version}\n",
        f"{dist_info}/WHEEL": "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        f"{dist_info}/RECORD": "",
    }
    path = directory / f"{DEP_MODULE}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return path


def have_uv() -> bool:
    try:
        plugin_deps.uv_command()
        return True
    except plugin_deps.DependencyError:
        return False


class TestRequirementCheck(unittest.TestCase):
    def test_splits_missing_and_blocking_requirements(self):
        available = {"requests": "2.32.0", "pte-plugin-grobid": "1.0.0"}
        result = plugin_deps.check(
            ["requests>=2", "requests>=3", "pymupdf>=1.25", "pte-plugin-anthropic-llm", "pte-plugin-grobid",
             "pdf-tei-editor", "x; extra == 'dev'", "not a requirement!"],
            available,
        )
        self.assertEqual(result.missing, ["pymupdf>=1.25"])
        self.assertEqual(len(result.blocking), 3)
        self.assertTrue(any("installed: 2.32.0" in b for b in result.blocking))
        self.assertTrue(any("pte-plugin-anthropic-llm" in b and "install it first" in b for b in result.blocking))

    def test_packages_of_other_runtime_plugins_count_as_missing(self):
        available = {"pymupdf": "1.25.5", "pte-plugin-anthropic-llm": "1.0.0"}
        result = plugin_deps.check(["pymupdf>=1.25", "pte-plugin-anthropic-llm"], available, packages={})
        self.assertEqual(result.missing, ["pymupdf>=1.25"])
        self.assertEqual(result.blocking, [])

    def test_unmet_depends_on_the_operator_setting(self):
        result = plugin_deps.RequirementCheck(missing=["pymupdf"], blocking=[])
        self.assertEqual(result.unmet(install_missing=False), ["pymupdf (not installed)"])
        self.assertEqual(result.unmet(install_missing=True), [])

    def test_to_install_skips_what_the_environment_provides(self):
        self.assertEqual(
            plugin_deps.to_install(["pymupdf==1.26.0", "requests==2.32.0"], {"requests": "2.32.0"}),
            ["pymupdf==1.26.0"],
        )

    def test_environment_distributions_exclude_the_site_directory(self):
        with tempfile.TemporaryDirectory() as d:
            site = Path(d)
            target = site / "pte-plugin-x" / "1.0.0"
            with zipfile.ZipFile(build_dependency_wheel(site)) as zf:
                zf.extractall(target)
            sys.path.insert(0, str(target))
            try:
                self.assertIn(DEP_DIST, installed_distributions())
                self.assertNotIn(DEP_DIST, plugin_deps.environment_distributions(site))
            finally:
                sys.path.remove(str(target))


@unittest.skipUnless(have_uv(), "uv is not installed")
class TestUvResolveAndInstall(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.links = self.dir / "links"
        self.links.mkdir()
        build_dependency_wheel(self.links, "1.0.0")
        build_dependency_wheel(self.links, "2.0.0")
        env = patch.dict(os.environ, {"UV_NO_INDEX": "1", "UV_FIND_LINKS": str(self.links), "UV_CACHE_DIR": str(self.dir / "cache")})
        env.start()
        self.addCleanup(env.stop)

    def test_resolves_the_newest_version_without_pins(self):
        self.assertEqual(plugin_deps.resolve([DEP_DIST], {}, self.dir), [f"{DEP_DIST}==2.0.0"])

    def test_pins_keep_the_installed_version(self):
        self.assertEqual(plugin_deps.resolve([DEP_DIST], {DEP_DIST: "1.0.0"}, self.dir), [f"{DEP_DIST}==1.0.0"])

    def test_conflict_with_a_pin_is_refused(self):
        with self.assertRaises(plugin_deps.DependencyError):
            plugin_deps.resolve([f"{DEP_DIST}>=2"], {DEP_DIST: "1.0.0"}, self.dir)

    def test_installs_into_the_target_directory(self):
        site = self.dir / "site"
        target = site / "pte-plugin-x" / "1.0.0"
        target.mkdir(parents=True)
        packages = plugin_deps.install_missing([DEP_DIST], site, target, self.dir)
        self.assertEqual(packages, [f"{DEP_DIST}==2.0.0"])
        self.assertTrue((target / DEP_MODULE / "__init__.py").is_file())


class TestInstallWithDependencies(RuntimeInstallTestCase):
    def setUp(self):
        super().setUp()
        os.environ.pop("PTE_PLUGIN_INSTALL_DEPENDENCIES", None)

    def install_with_dep(self):
        wheel = build_wheel(self.wheels, requires=[f"{DEP_DIST}>=1"])
        return asyncio.run(self.mgr.install_wheel(wheel, sha256_file(wheel), "mpilhlt/pte-plugins", "rt-hello-v1.0.0", True))

    def test_refused_without_the_operator_setting(self):
        with self.assertRaises(InstallError) as ctx:
            self.install_with_dep()
        self.assertIn("PTE_PLUGIN_INSTALL_DEPENDENCIES", ctx.exception.detail)
        self.assertEqual(ctx.exception.unmet, [f"{DEP_DIST}>=1 (not installed)"])

    def test_installs_the_missing_packages_into_the_version_directory(self):
        calls = []

        def fake_install(missing, site_dir, target, workdir, replaced=None):
            calls.append((missing, target))
            (target / DEP_MODULE).mkdir()
            return [f"{DEP_DIST}==1.0.0"]

        with patch.dict(os.environ, {"PTE_PLUGIN_INSTALL_DEPENDENCIES": "1"}), \
                patch("fastapi_app.lib.plugins.plugin_deps.install_missing", side_effect=fake_install):
            result = self.install_with_dep()
        self.assertEqual(result["packages"], [f"{DEP_DIST}==1.0.0"])
        ((missing, target),) = calls
        self.assertEqual(missing, [f"{DEP_DIST}>=1"])
        self.assertEqual(target, self.site_dir.resolve() / "pte-plugin-rt-hello" / "1.0.0")
        self.assertTrue((target / DEP_MODULE).is_dir())

    def test_failed_package_install_removes_the_plugin(self):
        with patch.dict(os.environ, {"PTE_PLUGIN_INSTALL_DEPENDENCIES": "1"}), \
                patch("fastapi_app.lib.plugins.plugin_deps.install_missing",
                      side_effect=plugin_deps.DependencyError("no matching distribution")):
            with self.assertRaises(InstallError) as ctx:
                self.install_with_dep()
        self.assertIn("no matching distribution", ctx.exception.detail)
        self.assertFalse((self.site_dir / "pte-plugin-rt-hello" / "1.0.0").exists())
        self.assertIsNone(self.mgr.state_store.read().get_installed("rt-hello"))

    def test_available_lists_the_packages_to_install(self):
        from tests.unit.fastapi.test_plugin_runtime_install import FakeGitHub, repository_responses
        from fastapi_app.lib.plugins.plugin_catalog import PluginCatalog
        from fastapi_app.lib.plugins.plugin_wheel import sha256_file as sha

        wheel = build_wheel(self.wheels)
        self.mgr.catalog = PluginCatalog(FakeGitHub(
            repository_responses("mpilhlt/pte-plugins", wheel, sha(wheel), dependencies=[f"{DEP_DIST}>=1"]),
            {f"https://dl/mpilhlt/pte-plugins/{wheel.name}": wheel},
        ))
        client = TestClient(self.make_app(self.mgr))
        with patch.dict(os.environ, {"PTE_PLUGIN_INSTALL": "1", "PTE_PLUGIN_DISCOVER_TOPIC": ""}):
            (plugin,) = client.get("/api/v1/plugins/admin/available").json()["plugins"]
            self.assertFalse(plugin["installable"])
            self.assertEqual(plugin["install_packages"], [])
            with patch.dict(os.environ, {"PTE_PLUGIN_INSTALL_DEPENDENCIES": "1"}):
                (plugin,) = client.get("/api/v1/plugins/admin/available").json()["plugins"]
        self.assertTrue(plugin["installable"])
        self.assertEqual(plugin["install_packages"], [f"{DEP_DIST}>=1"])
        self.assertEqual(plugin["unmet_requirements"], [])


if __name__ == "__main__":
    unittest.main()
