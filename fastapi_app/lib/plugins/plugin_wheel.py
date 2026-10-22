"""
Inspection, verification and unpacking of plugin wheels for runtime install.

A plugin is installed from the wheel attached to a GitHub release. The wheel is unpacked,
not built or installed with pip, so no code of the plugin runs at install time. Only pure
Python wheels (``py3-none-any``) without ``.data`` directories are accepted. The plugin's
requirements are checked against the distributions installed in the environment: a plugin
that needs packages that are not installed must be installed with ``uv sync`` instead.
"""

import hashlib
import importlib.metadata
import logging
import re
import shutil
import stat
import zipfile
from dataclasses import dataclass
from email.parser import Parser
from pathlib import Path, PurePosixPath

from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

from fastapi_app.lib.plugins.plugin_manifest import MANIFEST_FILE, ManifestError, PluginManifest, parse_manifest
from fastapi_app.lib.plugins.plugin_paths import ENTRY_POINT_GROUP

logger = logging.getLogger(__name__)

MAX_WHEEL_FILES = 5000
MAX_UNPACKED_SIZE = 200 * 1024 * 1024

# Distributions that are not checked as requirements (the editor itself is not installed as a package)
IGNORED_REQUIREMENTS = frozenset({"pdf-tei-editor"})

_WHEEL_NAME = re.compile(r"^(?P<dist>[A-Za-z0-9_.]+)-(?P<version>[^-]+)(-\d[^-]*)?-(?P<tags>[^-]+-[^-]+-[^-]+)\.whl$")


class WheelError(ValueError):
    """The wheel cannot be installed."""


@dataclass(frozen=True)
class WheelInfo:
    """What a plugin wheel contains, read without importing it."""

    distribution: str
    version: str
    plugin_id: str
    package: str
    summary: str
    requires: tuple[str, ...]
    manifest: PluginManifest | None


def sha256_file(path: Path) -> str:
    """Hex sha256 digest of a file."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_checksums(text: str) -> dict[str, str]:
    """
    Parse a ``SHA256SUMS`` file (output of ``sha256sum``: ``<hex>  <file name>`` per line).

    Returns:
        Lower-case hex digest by file name
    """
    result: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) == 2 and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            result[parts[1].lstrip("*")] = parts[0].lower()
    return result


def _safe_members(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """The members of a wheel, refusing unsafe paths, links, special files and oversized content."""
    members = zf.infolist()
    if len(members) > MAX_WHEEL_FILES:
        raise WheelError(f"The wheel has more than {MAX_WHEEL_FILES} files")
    total = 0
    seen: set[str] = set()
    for info in members:
        name = info.filename
        path = PurePosixPath(name)
        if name.startswith("/") or "\\" in name or ".." in path.parts or (path.parts and ":" in path.parts[0]):
            raise WheelError(f"Unsafe path in wheel: {name}")
        file_type = stat.S_IFMT(info.external_attr >> 16)
        if file_type and file_type not in (stat.S_IFREG, stat.S_IFDIR):
            raise WheelError(f"Wheel contains a link or special file: {name}")
        if name.lower() in seen:
            raise WheelError(f"Duplicate file in wheel: {name}")
        seen.add(name.lower())
        total += info.file_size
        if total > MAX_UNPACKED_SIZE:
            raise WheelError(f"The unpacked wheel is larger than {MAX_UNPACKED_SIZE // (1024 * 1024)} MB")
    return members


def inspect_wheel(path: Path) -> WheelInfo:
    """
    Read the metadata, the ``pte.plugins`` entry point and the manifest of a plugin wheel.

    Raises:
        WheelError: If the file is not an installable plugin wheel
    """
    match = _WHEEL_NAME.match(path.name)
    if not match:
        raise WheelError(f"Not a wheel file name: {path.name}")
    if match.group("tags") != "py3-none-any":
        raise WheelError(f"Only pure Python wheels (py3-none-any) can be installed, not {match.group('tags')}")
    try:
        zf = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as e:
        raise WheelError(f"Cannot open the wheel: {e}") from e
    with zf:
        members = _safe_members(zf)
        names = [m.filename for m in members]
        dist_info = sorted({n.split("/")[0] for n in names if n.split("/")[0].endswith(".dist-info")})
        if len(dist_info) != 1:
            raise WheelError("The wheel must contain exactly one .dist-info directory")
        if any(n.split("/")[0].endswith(".data") for n in names):
            raise WheelError("Wheels with a .data directory (scripts, headers, data files) cannot be installed at runtime")

        def read(name: str) -> str:
            try:
                return zf.read(f"{dist_info[0]}/{name}").decode("utf-8")
            except KeyError as e:
                raise WheelError(f"The wheel has no {name}") from e

        wheel_meta = Parser().parsestr(read("WHEEL"))
        if (wheel_meta.get("Root-Is-Purelib") or "").strip().lower() != "true":
            raise WheelError("The wheel is not a purelib wheel")
        metadata = Parser().parsestr(read("METADATA"))
        distribution, version = metadata.get("Name"), metadata.get("Version")
        if not distribution or not version:
            raise WheelError("The wheel metadata has no Name or Version")
        try:
            Version(version)
        except InvalidVersion as e:
            raise WheelError(f"Invalid version {version}") from e

        entry_points = _parse_entry_points(read("entry_points.txt") if f"{dist_info[0]}/entry_points.txt" in names else "")
        if len(entry_points) != 1:
            raise WheelError(f"The wheel must declare exactly one '{ENTRY_POINT_GROUP}' entry point, found {len(entry_points)}")
        plugin_id, package = entry_points[0]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", package):
            raise WheelError(f"The entry point must name a top-level package, not {package}")
        if f"{package}/plugin.py" not in names:
            raise WheelError(f"The wheel has no {package}/plugin.py")
        top_level = {n.split("/")[0] for n in names} - set(dist_info)
        if top_level != {package}:
            raise WheelError(f"The wheel may only contain the package {package}, found: {', '.join(sorted(top_level))}")

        manifest: PluginManifest | None = None
        manifest_name = f"{package}/{MANIFEST_FILE}"
        if manifest_name in names:
            try:
                manifest = parse_manifest(zf.read(manifest_name).decode("utf-8"))
            except (ManifestError, UnicodeDecodeError) as e:
                raise WheelError(f"Invalid {MANIFEST_FILE}: {e}") from e

        return WheelInfo(
            distribution=distribution,
            version=version,
            plugin_id=plugin_id,
            package=package,
            summary=metadata.get("Summary") or "",
            requires=tuple(metadata.get_all("Requires-Dist") or []),
            manifest=manifest,
        )


def _parse_entry_points(text: str) -> list[tuple[str, str]]:
    """The (name, package) pairs of the ``pte.plugins`` group of an ``entry_points.txt``."""
    result: list[tuple[str, str]] = []
    group = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            group = line[1:-1].strip()
        elif group == ENTRY_POINT_GROUP and "=" in line:
            name, value = (part.strip() for part in line.split("=", 1))
            result.append((name, value.split(":")[0].strip()))
    return result


def installed_distributions() -> dict[str, str]:
    """Version of every distribution in the environment (and on sys.path), by canonical name."""
    result: dict[str, str] = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"]
        if name:
            result.setdefault(canonicalize_name(name), dist.version)
    return result


def plugin_distributions() -> dict[str, str]:
    """Plugin id of every distribution that declares a ``pte.plugins`` entry point, by canonical name."""
    result: dict[str, str] = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"]
        for ep in dist.entry_points.select(group=ENTRY_POINT_GROUP):
            if name:
                result.setdefault(canonicalize_name(name), ep.name)
    return result


def check_requirements(requires: tuple[str, ...] | list[str], available: dict[str, str]) -> list[str]:
    """
    Requirements of a wheel that the environment does not satisfy.

    Requirements of extras and requirements whose environment marker does not apply are skipped.

    Args:
        requires: ``Requires-Dist`` lines
        available: Installed versions by canonical distribution name (see installed_distributions())

    Returns:
        Human-readable descriptions of the unmet requirements
    """
    unmet: list[str] = []
    for line in requires:
        try:
            req = Requirement(line)
        except InvalidRequirement:
            unmet.append(f"{line} (invalid requirement)")
            continue
        if req.marker is not None and not req.marker.evaluate({"extra": ""}):
            continue
        name = canonicalize_name(req.name)
        if name in IGNORED_REQUIREMENTS:
            continue
        version = available.get(name)
        if version is None:
            unmet.append(f"{req} (not installed)")
        elif req.specifier and not req.specifier.contains(version, prereleases=True):
            unmet.append(f"{req} (installed: {version})")
    return unmet


def plugin_dependencies(requires: tuple[str, ...] | list[str], plugins: dict[str, str]) -> list[str]:
    """
    Ids of the plugins a wheel requires.

    Args:
        requires: ``Requires-Dist`` lines
        plugins: Plugin id by canonical distribution name (see plugin_distributions())
    """
    result: list[str] = []
    for line in requires:
        try:
            req = Requirement(line)
        except InvalidRequirement:
            continue
        if req.marker is not None and not req.marker.evaluate({"extra": ""}):
            continue
        plugin_id = plugins.get(canonicalize_name(req.name))
        if plugin_id and plugin_id not in result:
            result.append(plugin_id)
    return result


def extract_wheel(path: Path, dest: Path) -> None:
    """
    Unpack a wheel into a new directory.

    The files are written to a temporary sibling directory that is renamed to ``dest``, so an
    interrupted extraction leaves no partial version directory.

    Raises:
        WheelError: If the wheel is unsafe or ``dest`` exists
        OSError: If writing fails
    """
    if dest.exists():
        raise WheelError(f"Directory exists already: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".{dest.name}.partial"
    if tmp.exists():
        shutil.rmtree(tmp)
    try:
        with zipfile.ZipFile(path) as zf:
            for info in _safe_members(zf):
                target = tmp / info.filename
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
        tmp.rename(dest)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
