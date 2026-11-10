"""
The site directory of plugins installed at runtime: ``data/plugins/site/``.

Each installed plugin version is an unpacked wheel in its own directory::

    data/plugins/site/pte-plugin-grobid/1.1.0/pte_plugin_grobid/...
    data/plugins/site/pte-plugin-grobid/1.1.0/pte_plugin_grobid-1.1.0.dist-info/...

The directories of the installed versions (``installed`` in the plugin state) are put at the
front of ``sys.path`` at startup, so a runtime-installed version takes precedence over a
version installed into the environment with ``uv sync``, and its ``pte.plugins`` entry point
is found by the normal discovery (``plugin_paths.get_installed_plugin_dirs()``). Only an
editable install of the same distribution (a plugin checkout under development, see
:func:`without_editable`) takes precedence over a runtime-installed version. The site
directory lies on the data volume, so it survives container recreation and is not touched by
``uv sync``.
"""

import importlib
import importlib.metadata
import json
import logging
import shutil
import sys
from collections.abc import Iterable
from pathlib import Path

from fastapi_app.config import get_settings
from fastapi_app.lib.plugins.plugin_state import InstalledPlugin, PluginState

logger = logging.getLogger(__name__)

SITE_DIR_NAME = "site"


def get_site_dir() -> Path:
    """The site directory of runtime-installed plugins (``data/plugins/site``)."""
    return get_settings().plugins_data_dir / SITE_DIR_NAME


def resolve_site_path(relative: str, site_dir: Path | None = None) -> Path:
    """
    Resolve a path relative to the site directory, refusing paths outside it.

    Args:
        relative: Path as stored in the plugin state
        site_dir: Site directory (default: :func:`get_site_dir`)

    Returns:
        Absolute path inside the site directory

    Raises:
        ValueError: If the path leaves the site directory
    """
    base = (site_dir or get_site_dir()).resolve()
    path = (base / relative).resolve()
    if path == base or base not in path.parents:
        raise ValueError(f"Path outside the plugin site directory: {relative}")
    return path


def version_dir(entry: InstalledPlugin, site_dir: Path | None = None) -> Path:
    """Directory of an installed plugin version."""
    return resolve_site_path(entry.path, site_dir)


def package_dir(entry: InstalledPlugin, site_dir: Path | None = None) -> Path:
    """Package directory (the plugin directory) of an installed plugin version."""
    return version_dir(entry, site_dir) / entry.package


def is_site_path(path: Path, site_dir: Path | None = None) -> bool:
    """Whether a path lies inside the site directory."""
    base = (site_dir or get_site_dir()).resolve()
    return base in path.resolve().parents


def editable_install(distribution: str) -> str | None:
    """
    The source URL of an editable install of a distribution in the environment, or None.

    An editable install (``uv pip install -e``, e.g. ``npm run dev:install`` in a pte-plugins
    checkout) records ``dir_info.editable`` in its ``direct_url.json`` (PEP 610).

    Args:
        distribution: Distribution name, e.g. ``pte-plugin-grobid``

    Returns:
        The ``url`` of the install (``file://...``), or None if the distribution is not installed editable
    """
    try:
        text = importlib.metadata.distribution(distribution).read_text("direct_url.json")
    except importlib.metadata.PackageNotFoundError:
        return None
    if not text:
        return None
    try:
        direct_url = json.loads(text)
    except ValueError:
        return None
    if not isinstance(direct_url, dict) or not (direct_url.get("dir_info") or {}).get("editable"):
        return None
    return str(direct_url.get("url", ""))


def without_editable(entries: Iterable[InstalledPlugin]) -> tuple[InstalledPlugin, ...]:
    """
    The runtime-installed plugins whose distribution is not installed editable in the environment.

    A plugin a developer installed editable from a checkout takes precedence over a version
    installed at runtime: the runtime-installed version is neither put on ``sys.path`` nor listed.

    Args:
        entries: Installed plugins (``installed`` of the plugin state)

    Returns:
        The entries to activate
    """
    return tuple(entry for entry in entries if editable_install(entry.distribution) is None)


def activate(entries: Iterable[InstalledPlugin], site_dir: Path | None = None) -> list[Path]:
    """
    Put the version directories of installed plugins at the front of ``sys.path``.

    Args:
        entries: Installed plugins (``installed`` of the plugin state)
        site_dir: Site directory (default: :func:`get_site_dir`)

    Returns:
        The directories added to ``sys.path`` in this call
    """
    added: list[Path] = []
    for entry in entries:
        try:
            directory = version_dir(entry, site_dir)
        except ValueError as e:
            logger.error(f"Installed plugin {entry.id}: {e}")
            continue
        if not directory.is_dir():
            logger.error(f"Installed plugin {entry.id} {entry.version} is missing: {directory}")
            continue
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))
            added.append(directory)
    if added:
        importlib.invalidate_caches()
    return added


def missing(entries: Iterable[InstalledPlugin], site_dir: Path | None = None) -> list[InstalledPlugin]:
    """
    Installed plugins whose package directory does not exist (anymore) in the site directory.

    Entries with a path outside the site directory are included, since they cannot be loaded either.

    Args:
        entries: Installed plugins (``installed`` of the plugin state)
        site_dir: Site directory (default: :func:`get_site_dir`)

    Returns:
        The entries without a package directory
    """
    result: list[InstalledPlugin] = []
    for entry in entries:
        try:
            directory = package_dir(entry, site_dir)
        except ValueError:
            result.append(entry)
            continue
        if not directory.is_dir():
            result.append(entry)
    return result


def remove_pending(state: PluginState, site_dir: Path | None = None) -> list[str]:
    """
    Delete the site directories marked for removal (called at startup, before :func:`activate`).

    Directories still used by an installed plugin are kept.

    Args:
        state: Plugin state with the pending removals
        site_dir: Site directory (default: :func:`get_site_dir`)

    Returns:
        The relative paths that no longer exist (deleted now or before)
    """
    in_use = {entry.path for entry in state.installed}
    done: list[str] = []
    for relative in sorted(state.pending_removal):
        if relative in in_use:
            continue
        try:
            path = resolve_site_path(relative, site_dir)
        except ValueError as e:
            logger.error(f"Not removing plugin directory: {e}")
            done.append(relative)
            continue
        try:
            if path.exists():
                shutil.rmtree(path)
                logger.info(f"Removed plugin directory {path}")
                # Remove the distribution directory once its last version is gone
                parent = path.parent
                if parent != (site_dir or get_site_dir()).resolve() and not any(parent.iterdir()):
                    parent.rmdir()
            done.append(relative)
        except OSError as e:
            logger.error(f"Could not remove plugin directory {path}: {e}")
    return done
