"""
Runtime install of plugins from GitHub release wheels into ``data/plugins/site/``.

1. The release's wheel and ``SHA256SUMS`` are downloaded; the wheel's sha256 must match.
2. The wheel is inspected without importing it (``plugin_wheel``): one ``pte.plugins`` entry
   point, compatible ``engines`` in its manifest, and all requirements satisfied by the
   distributions already installed. Plugins that need new packages must be installed with
   ``uv sync`` (see docs/user-manual/plugin-manager.md).
3. The wheel is unpacked into ``data/plugins/site/<distribution>/<version>/``.

Recording the installation in the plugin state and loading it is done by ``PluginManager``.
"""

import logging
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from packaging.utils import canonicalize_name

from fastapi_app.lib.plugins.plugin_catalog import CatalogEntry, CatalogError, CatalogRelease, GitHubClient
from fastapi_app.lib.plugins.plugin_manifest import incompatibility
from fastapi_app.lib.plugins.plugin_site import resolve_site_path
from fastapi_app.lib.plugins.plugin_state import InstalledPlugin
from fastapi_app.lib.plugins.plugin_wheel import (
    WheelError,
    WheelInfo,
    check_requirements,
    extract_wheel,
    inspect_wheel,
    installed_distributions,
    parse_checksums,
    plugin_dependencies,
    plugin_distributions,
    sha256_file,
)

logger = logging.getLogger(__name__)


class InstallError(Exception):
    """A plugin cannot be installed; carries the HTTP status to report."""

    def __init__(self, status_code: int, detail: str, unmet: list[str] | None = None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.unmet = unmet or []


@dataclass(frozen=True)
class Download:
    """A downloaded and verified release wheel."""

    path: Path
    sha256: str
    release: CatalogRelease


def download_release(client: GitHubClient, entry: CatalogEntry, release: CatalogRelease, workdir: Path) -> Download:
    """
    Download a release wheel and verify it against the release's ``SHA256SUMS``.

    Raises:
        InstallError: If the checksum file is missing, does not list the wheel, or does not match
    """
    if not release.checksums_url:
        raise InstallError(422, f"Release {release.tag} of {entry.repository} has no SHA256SUMS asset")
    try:
        checksums = parse_checksums(client.get_text(release.checksums_url))
        expected = checksums.get(release.wheel_name)
        if expected is None:
            raise InstallError(422, f"SHA256SUMS of {release.tag} does not list {release.wheel_name}")
        path = workdir / release.wheel_name
        client.download(release.wheel_url, path)
    except CatalogError as e:
        raise InstallError(502, str(e)) from e
    actual = sha256_file(path)
    if actual != expected:
        raise InstallError(422, f"Checksum mismatch for {release.wheel_name}: expected {expected}, got {actual}")
    return Download(path=path, sha256=actual, release=release)


def check_wheel(info: WheelInfo, plugin_id: str | None = None) -> list[str]:
    """
    Check that an inspected wheel can be installed here.

    Args:
        info: Inspected wheel
        plugin_id: Expected plugin id (the catalog entry's)

    Returns:
        Unmet requirements (empty if the plugin can be installed)

    Raises:
        InstallError: If the wheel is for another plugin or incompatible with this editor
    """
    if plugin_id is not None and info.plugin_id != plugin_id:
        raise InstallError(422, f"The wheel contains the plugin {info.plugin_id}, not {plugin_id}")
    reason = incompatibility(info.manifest)
    if reason:
        raise InstallError(409, f"Plugin {info.plugin_id} {info.version} is incompatible: {reason}")
    return check_requirements(info.requires, installed_distributions())


def unpack(wheel: Path, info: WheelInfo, site_dir: Path) -> str:
    """
    Unpack a checked wheel into the site directory.

    Returns:
        The version directory, relative to the site directory

    Raises:
        InstallError: If the version is unpacked already or unpacking fails
    """
    relative = f"{canonicalize_name(info.distribution)}/{info.version}"
    target = resolve_site_path(relative, site_dir)
    if target.exists():
        raise InstallError(409, f"{info.distribution} {info.version} is unpacked already in {target}")
    try:
        extract_wheel(wheel, target)
    except WheelError as e:
        raise InstallError(422, str(e)) from e
    except OSError as e:
        raise InstallError(500, f"Could not unpack {wheel.name}: {e}") from e
    return relative


def installed_entry(
    info: WheelInfo, relative: str, sha256: str, repository: str, tag: str, trusted: bool, username: str
) -> InstalledPlugin:
    """The plugin state entry for an unpacked wheel."""
    return InstalledPlugin(
        id=info.plugin_id,
        package=info.package,
        distribution=info.distribution,
        version=info.version,
        path=relative,
        repository=repository,
        tag=tag,
        sha256=sha256,
        name=info.plugin_id,
        description=info.summary,
        dependencies=tuple(plugin_dependencies(info.requires, plugin_distributions())),
        trusted=trusted,
        installed_at=time.time(),
        installed_by=username,
    )


def new_workdir(base: Path) -> tempfile.TemporaryDirectory[str]:
    """A temporary directory for downloads, inside ``base`` (the data volume)."""
    base.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=base, prefix=".download-")


def inspect(wheel: Path) -> WheelInfo:
    """Inspect a wheel, reporting problems as InstallError."""
    try:
        return inspect_wheel(wheel)
    except WheelError as e:
        raise InstallError(422, str(e)) from e
