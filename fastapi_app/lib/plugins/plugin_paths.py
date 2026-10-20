"""
Plugin search paths and module import helpers.

Built-in plugins live in fastapi_app/plugins/ and are imported as
``fastapi_app.plugins.<dir>``. External plugins are found in the directories
listed in the FASTAPI_PLUGIN_PATHS environment variable (separated by
``os.pathsep``: ":" on Unix, ";" on Windows) and are imported as packages
under the synthetic namespace ``pte_external_plugins.<dir>``, so that they can
consist of several modules using relative imports (``from .extractor import ...``).
"""

import importlib
import importlib.machinery
import importlib.util
import os
import sys
import types
from pathlib import Path

from fastapi_app.config import get_settings

PLUGIN_PATHS_ENV_VAR = "FASTAPI_PLUGIN_PATHS"
EXTERNAL_NAMESPACE = "pte_external_plugins"

# Resolved plugin directory -> package name, so that a plugin's modules
# (plugin.py, routes.py, ...) are always imported under the same package.
_package_names: dict[Path, str] = {}


def get_external_plugin_dirs() -> list[Path]:
    """
    Return the external plugin directories configured in FASTAPI_PLUGIN_PATHS.

    Each directory contains one subdirectory per plugin.

    Returns:
        List of directory paths, in the order given (empty entries skipped)
    """
    env_paths = os.getenv(PLUGIN_PATHS_ENV_VAR, "")
    return [Path(p.strip()) for p in env_paths.split(os.pathsep) if p.strip()]


def get_plugin_dirs() -> list[Path]:
    """
    Return all directories to search for plugins: built-in first, then external.

    Returns:
        List of directory paths
    """
    return [get_settings().plugins_code_dir, *get_external_plugin_dirs()]


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
    except Exception:
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
    if not package_name.startswith("fastapi_app."):
        _ensure_external_package(plugin_path, package_name)
    return importlib.import_module(f"{package_name}.{module}")
