"""
Plugin search paths and module import helpers.

Built-in plugins live in fastapi_app/plugins/ and are imported as
``fastapi_app.plugins.<dir>``. External plugins are found in the directories
listed in the FASTAPI_PLUGIN_PATHS environment variable (separated by
``os.pathsep``: ":" on Unix, ";" on Windows) and are imported as packages
under the synthetic namespace ``pte_external_plugins.<dir>``, so that they can
consist of several modules using relative imports (``from .extractor import ...``).

Installed plugins are Python distributions that declare an entry point in the
group ``pte.plugins`` (``<plugin-id> = "<package>"``). Their package directory is
the plugin directory, and its modules are imported under the real package name
(``pte_plugin_grobid.plugin``), so plugins can import each other's packages.

An external plugin is a directory containing both ``plugin.py`` and the manifest
file ``pte-plugin.json``. The directories in FASTAPI_PLUGIN_PATHS are searched
a few levels deep for such directories, so FASTAPI_PLUGIN_PATHS can point to a
folder of repositories without importing unrelated ``plugin.py`` files.
"""

import importlib
import importlib.machinery
import importlib.metadata
import importlib.util
import logging
import os
import sys
import types
from pathlib import Path

from fastapi_app.config import get_settings
from fastapi_app.lib.plugins.plugin_manifest import MANIFEST_FILE

logger = logging.getLogger(__name__)

PLUGIN_PATHS_ENV_VAR = "FASTAPI_PLUGIN_PATHS"
ENTRY_POINT_GROUP = "pte.plugins"
EXTERNAL_NAMESPACE = "pte_external_plugins"
EXTERNAL_SEARCH_DEPTH = 3
SKIPPED_DIR_NAMES = frozenset({"node_modules", "__pycache__", "site-packages", "venv", "env"})

# Resolved plugin directory -> package name, so that a plugin's modules
# (plugin.py, routes.py, ...) are always imported under the same package.
_package_names: dict[Path, str] = {}

# Package names of installed (entry-point) plugins, which are importable as they are
_installed_packages: set[str] = set()


def get_external_plugin_dirs() -> list[Path]:
    """
    Return the external plugin directories configured in FASTAPI_PLUGIN_PATHS.

    Each directory contains one subdirectory per plugin.

    Returns:
        List of directory paths, in the order given (empty entries skipped)
    """
    env_paths = os.getenv(PLUGIN_PATHS_ENV_VAR, "")
    return [Path(p.strip()) for p in env_paths.split(os.pathsep) if p.strip()]


def find_external_plugins(base: Path, max_depth: int = EXTERNAL_SEARCH_DEPTH) -> list[Path]:
    """
    Find external plugin directories (with ``plugin.py`` and the manifest file) below a directory.

    ``base`` itself and its subdirectories down to ``max_depth`` levels are searched.
    Hidden directories (``.git``, ``.venv``, ...), :data:`SKIPPED_DIR_NAMES` and
    the subdirectories of a plugin are not searched. Nothing is imported.

    Args:
        base: Directory listed in FASTAPI_PLUGIN_PATHS
        max_depth: Number of directory levels below ``base`` to search

    Returns:
        Plugin directories, sorted by path
    """
    found: list[Path] = []

    def visit(directory: Path, depth: int) -> None:
        if (directory / MANIFEST_FILE).is_file() and (directory / "plugin.py").is_file():
            found.append(directory)
            return
        if depth >= max_depth:
            return
        try:
            children = sorted(directory.iterdir())
        except OSError:
            return
        for child in children:
            if child.name.startswith(".") or child.name in SKIPPED_DIR_NAMES:
                continue
            if child.is_dir() and not child.is_symlink():
                visit(child, depth + 1)

    visit(base, 0)
    return found


def get_installed_plugin_dirs() -> list[Path]:
    """
    Return the package directories of installed plugins (entry point group ``pte.plugins``).

    The packages are located without being imported. Entry points whose package
    cannot be found are logged and skipped.

    Returns:
        Plugin directories, in entry point order
    """
    dirs: list[Path] = []
    for entry_point in importlib.metadata.entry_points(group=ENTRY_POINT_GROUP):
        package_name = entry_point.value.split(":")[0].strip()
        try:
            spec = importlib.util.find_spec(package_name)
        except (ImportError, ValueError) as e:
            logger.error(f"Cannot locate plugin package {package_name} of entry point {entry_point.name}: {e}")
            continue
        if spec is None or not spec.submodule_search_locations:
            logger.error(f"Entry point {entry_point.name} does not refer to a package: {package_name}")
            continue
        plugin_dir = Path(next(iter(spec.submodule_search_locations)))
        _package_names[plugin_dir.resolve()] = package_name
        _installed_packages.add(package_name)
        dirs.append(plugin_dir)
    return dirs


def register_installed_package(plugin_dir: Path, package_name: str) -> None:
    """
    Register the package of a plugin installed after discovery (see ``plugin_site``).

    Args:
        plugin_dir: Package directory of the plugin
        package_name: Importable package name
    """
    _package_names[plugin_dir.resolve()] = package_name
    _installed_packages.add(package_name)


def is_installed_package_dir(plugin_dir: Path) -> bool:
    """Whether a plugin directory is the package of an installed (entry-point) plugin."""
    return _package_names.get(plugin_dir.resolve()) in _installed_packages


def get_plugin_dirs() -> list[Path]:
    """
    Return all directories to search for plugins: built-in, then external, then installed.

    A directory is listed once, even if it is reachable in several ways.

    Returns:
        List of directory paths
    """
    dirs: list[Path] = []
    seen: set[Path] = set()
    for directory in [get_settings().plugins_code_dir, *get_external_plugin_dirs(), *get_installed_plugin_dirs()]:
        resolved = directory.resolve()
        if resolved not in seen:
            seen.add(resolved)
            dirs.append(directory)
    return dirs


def is_builtin_plugin_dir(plugin_path: Path) -> bool:
    """
    Whether a plugin directory is a built-in plugin (inside fastapi_app/plugins/).

    Args:
        plugin_path: Directory of a single plugin

    Returns:
        True for built-in plugins
    """
    return plugin_path.resolve().parent == get_settings().plugins_code_dir.resolve()


def get_plugin_package_name(plugin_path: Path) -> str:
    """
    Return the Python package name a plugin directory is imported as.

    Built-in plugins use ``fastapi_app.plugins.<dir>``; external plugins use
    ``pte_external_plugins.<dir>``, with a numeric suffix if two external
    plugin directories share the same name.

    Args:
        plugin_path: Directory of a single plugin

    Returns:
        Dotted package name
    """
    resolved = plugin_path.resolve()
    if resolved in _package_names:
        return _package_names[resolved]

    if is_builtin_plugin_dir(plugin_path):
        name = f"fastapi_app.plugins.{plugin_path.name}"
    else:
        base = f"{EXTERNAL_NAMESPACE}.{plugin_path.name}"
        taken = set(_package_names.values())
        name, n = base, 2
        while name in taken:
            name, n = f"{base}_{n}", n + 1

    _package_names[resolved] = name
    return name


def _ensure_external_package(plugin_path: Path, package_name: str) -> None:
    """Register the namespace and the plugin's package in sys.modules."""
    if EXTERNAL_NAMESPACE not in sys.modules:
        namespace = types.ModuleType(EXTERNAL_NAMESPACE)
        namespace.__path__ = []
        sys.modules[EXTERNAL_NAMESPACE] = namespace

    if package_name in sys.modules:
        return

    search_locations = [str(plugin_path.resolve())]
    init_file = plugin_path / "__init__.py"
    if init_file.exists():
        spec = importlib.util.spec_from_file_location(
            package_name, init_file, submodule_search_locations=search_locations
        )
        if spec is None or spec.loader is None:
            raise ImportError(f"Could not create package spec for {plugin_path}")
    else:
        # Plugin directory without __init__.py: an empty package
        spec = importlib.machinery.ModuleSpec(package_name, None, is_package=True)
        spec.submodule_search_locations = search_locations

    package = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = package
    try:
        if spec.loader is not None:
            spec.loader.exec_module(package)
    except BaseException:
        del sys.modules[package_name]
        raise


def import_plugin_module(plugin_path: Path, module: str) -> types.ModuleType:
    """
    Import a module (e.g. "plugin" or "routes") of a plugin as part of its package.

    Args:
        plugin_path: Directory of a single plugin
        module: Module name inside the plugin directory, without ".py"

    Returns:
        The imported module

    Raises:
        ImportError: If the module cannot be imported
    """
    package_name = get_plugin_package_name(plugin_path)
    if not package_name.startswith("fastapi_app.") and package_name not in _installed_packages:
        _ensure_external_package(plugin_path, package_name)
    return importlib.import_module(f"{package_name}.{module}")
