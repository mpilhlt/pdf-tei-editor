"""
The optional ``pte-plugin.json`` manifest of a plugin.

    {
      "version": "1.2.0",
      "readme": "https://github.com/me/my-plugin#readme",
      "engines": { "pte": ">=0.75.0 <1.0.0", "pte-plugin-api": "^1.0" },
      "manual": [
        { "id": "tutorial", "slot": "tutorials", "title": "...", "file": "docs/tutorial.md" }
      ]
    }

- ``version``: semantic version of the plugin itself, shown in the plugin manager
- ``readme``: http(s) URL of the plugin's documentation, linked as "README" in the plugin manager
- ``engines.pte``: npm-style semver range of the PDF-TEI-Editor versions the plugin works with
  (``>=0.75.0``, ``^0.75.0``, ``0.75.x``, ``>=0.75 <2`` ...); a plugin outside the range is not loaded
- ``engines.pte-plugin-api``: semver range of the plugin API versions (``fastapi_app.plugin_api``,
  :data:`PLUGIN_API_VERSION`) the plugin works with; a plugin outside the range is not loaded
- ``manual``: pages the plugin contributes to the user manual (see :class:`ManualPage` and
  ``fastapi_app/lib/plugins/plugin_manual.py``)

Every field is optional. A missing, empty or field-less manifest means "no declared constraints",
so plugins without one (all built-in plugins) load as before.
"""

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from fastapi_app.config import get_settings
from fastapi_app.lib.utils.semver import SemverError, parse_version, satisfies, validate_range

logger = logging.getLogger(__name__)

MANIFEST_FILE = "pte-plugin.json"

PLUGIN_API_VERSION = "1.9.0"
"""Version of the supported plugin API (``fastapi_app.plugin_api``); the major changes only for breaking changes."""


MANUAL_FILE_SUFFIX = ".md"

_MANUAL_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_LANGUAGE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$")
_ANCHOR = re.compile(r"^[a-z0-9_-]+$")
"""Heading anchors as the manual renderer creates them (``headingAnchor()`` in ``app/src/modules/markdown-utils.js``)"""


class ManifestError(ValueError):
    """The manifest is not valid JSON or contains an invalid field."""


@dataclass(frozen=True)
class ManualPage:
    """A page a plugin contributes to a slot of the user manual (an entry of ``manual`` in the manifest)."""

    id: str
    """Id of the page, unique within the plugin (lowercase letters, digits and hyphens)"""
    slot: str
    """Name of the manual slot the page is listed in, e.g. ``tutorials``"""
    title: str
    """Link text in the slot"""
    files: dict[str, str]
    """One Markdown file per language code, as paths relative to the plugin directory; ``file`` in the manifest
    is either such a map or a single path, which is the English page"""
    anchors: dict[str, str] = field(default_factory=dict)
    """Heading anchor per language code, for files given as ``path#anchor`` in the manifest: the page opens at that
    heading"""
    description: str = ""
    """One sentence shown after the link"""
    requires: tuple[str, ...] = ()
    """Ids of other plugins that must be active for the page to be listed"""
    roles: tuple[str, ...] = ()
    """The page is listed only for users with one of these roles; empty: for everyone"""
    order: int = 500
    """Sort key within the slot, then the title"""


@dataclass(frozen=True)
class PluginManifest:
    """Contents of ``pte-plugin.json``; None fields were not declared."""

    version: str | None = None
    pte: str | None = None
    readme: str | None = None
    plugin_api: str | None = None
    manual: tuple[ManualPage, ...] = field(default_factory=tuple)


def read_manifest(plugin_dir: Path) -> PluginManifest | None:
    """
    Read and validate the manifest of a plugin directory.

    Returns:
        The manifest, or None if the directory has no manifest file

    Raises:
        ManifestError: If the file cannot be parsed or a field is invalid
    """
    path = plugin_dir / MANIFEST_FILE
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise ManifestError(f"Cannot read {MANIFEST_FILE}: {e}") from e
    return parse_manifest(text)


def parse_manifest(text: str) -> PluginManifest:
    """
    Parse and validate the contents of a manifest file.

    Raises:
        ManifestError: If the text cannot be parsed or a field is invalid
    """
    try:
        text = text.strip()
        data = json.loads(text) if text else {}
    except ValueError as e:
        raise ManifestError(f"Cannot read {MANIFEST_FILE}: {e}") from e
    if not isinstance(data, dict):
        raise ManifestError(f"{MANIFEST_FILE} must contain a JSON object")

    version = data.get("version")
    if version is not None:
        if not isinstance(version, str):
            raise ManifestError("'version' must be a string")
        try:
            parse_version(version)
        except SemverError as e:
            raise ManifestError(f"Invalid 'version': {e}") from e

    readme = data.get("readme")
    if readme is not None:
        if not isinstance(readme, str):
            raise ManifestError("'readme' must be a string")
        if urlparse(readme).scheme not in ("http", "https") or not urlparse(readme).netloc:
            raise ManifestError("'readme' must be an http(s) URL")

    pte = plugin_api = None
    engines = data.get("engines")
    if engines is not None:
        if not isinstance(engines, dict):
            raise ManifestError("'engines' must be an object")
        pte = _read_range(engines, "pte")
        plugin_api = _read_range(engines, "pte-plugin-api")
    manual = _read_manual(data.get("manual"))
    return PluginManifest(version=version, pte=pte, readme=readme, plugin_api=plugin_api, manual=manual)


def _read_manual(value: object) -> tuple[ManualPage, ...]:
    """Read and validate the ``manual`` list of the manifest."""
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ManifestError("'manual' must be a list")
    pages: list[ManualPage] = []
    ids: set[str] = set()
    for index, entry in enumerate(value):
        where = f"'manual[{index}]'"
        if not isinstance(entry, dict):
            raise ManifestError(f"{where} must be an object")
        page_id = _read_string(entry, "id", where)
        if not _MANUAL_ID.match(page_id):
            raise ManifestError(f"{where}.id must consist of lowercase letters, digits and hyphens")
        if page_id in ids:
            raise ManifestError(f"{where}.id '{page_id}' is used twice")
        ids.add(page_id)
        description = entry.get("description", "")
        if not isinstance(description, str):
            raise ManifestError(f"{where}.description must be a string")
        order = entry.get("order", 500)
        if not isinstance(order, int) or isinstance(order, bool):
            raise ManifestError(f"{where}.order must be an integer")
        files, anchors = _read_files(entry.get("file"), where)
        pages.append(ManualPage(
            id=page_id,
            slot=_read_string(entry, "slot", where),
            title=_read_string(entry, "title", where),
            files=files,
            anchors=anchors,
            description=description,
            requires=_read_string_list(entry, "requires", where),
            roles=_read_string_list(entry, "roles", where),
            order=order,
        ))
    return tuple(pages)


def _read_string(entry: dict[str, object], key: str, where: str) -> str:
    """A required non-empty string field of a ``manual`` entry."""
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{where}.{key} must be a non-empty string")
    return value.strip()


def _read_string_list(entry: dict[str, object], key: str, where: str) -> tuple[str, ...]:
    """An optional list of strings of a ``manual`` entry."""
    value = entry.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ManifestError(f"{where}.{key} must be a list of strings")
    return tuple(value)


def _read_files(value: object, where: str) -> tuple[dict[str, str], dict[str, str]]:
    """
    The ``file`` of a ``manual`` entry: a path (the English page) or a map from language code to path.

    A path may end with ``#<anchor>``, the anchor of the heading the page opens at.

    Returns:
        (file per language code, anchor per language code for the paths that have one)
    """
    if isinstance(value, str):
        value = {"en": value}
    if not isinstance(value, dict) or not value:
        raise ManifestError(f"{where}.file must be a path or an object mapping language codes to paths")
    files: dict[str, str] = {}
    anchors: dict[str, str] = {}
    for language, entry in value.items():
        if not _LANGUAGE.match(language):
            raise ManifestError(f"{where}.file: invalid language code '{language}'")
        if not isinstance(entry, str):
            raise ManifestError(f"{where}.file: '{entry}' must be a relative path of a {MANUAL_FILE_SUFFIX} file inside the plugin directory")
        path, _, anchor = entry.partition("#")
        if not is_safe_relative_path(path) or not path.endswith(MANUAL_FILE_SUFFIX):
            raise ManifestError(f"{where}.file: '{entry}' must be a relative path of a {MANUAL_FILE_SUFFIX} file inside the plugin directory")
        if "#" in entry:
            if not _ANCHOR.match(anchor):
                raise ManifestError(f"{where}.file: '{entry}' has an invalid anchor (lowercase letters, digits, '_' and '-')")
            anchors[language] = anchor
        files[language] = path
    return files, anchors


def is_safe_relative_path(path: str) -> bool:
    """Whether ``path`` is a relative POSIX path without ``..``, ``.`` or empty segments and without backslashes."""
    if not path or "\\" in path or path.startswith("/"):
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def _read_range(engines: dict[str, object], key: str) -> str | None:
    """Read and validate a semver range from the manifest's ``engines`` object."""
    value = engines.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ManifestError(f"'engines.{key}' must be a string")
    try:
        validate_range(value)
    except SemverError as e:
        raise ManifestError(f"Invalid 'engines.{key}' range: {e}") from e
    return value


_pte_version: str | None = None


def get_pte_version() -> str | None:
    """The version of this PDF-TEI-Editor (``version`` in package.json), or None if it cannot be determined."""
    global _pte_version
    if _pte_version is None:
        try:
            package = json.loads((get_settings().project_root_dir / "package.json").read_text(encoding="utf-8"))
            _pte_version = str(package["version"])
        except (OSError, ValueError, KeyError):
            logger.warning("Cannot determine the PDF-TEI-Editor version; plugin version requirements are not checked")
            return None
    return _pte_version


def incompatibility(manifest: PluginManifest | None, pte_version: str | None = None) -> str | None:
    """
    Why a plugin cannot run with this PDF-TEI-Editor, or None if it can.

    Args:
        manifest: The plugin's manifest, if it has one
        pte_version: Editor version to check against (default: this installation's)
    """
    if manifest is None:
        return None
    if manifest.plugin_api is not None:
        try:
            if not satisfies(PLUGIN_API_VERSION, manifest.plugin_api):
                return f"Requires plugin API {manifest.plugin_api}, but this is {PLUGIN_API_VERSION}"
        except SemverError:
            pass
    if manifest.pte is None:
        return None
    current = pte_version or get_pte_version()
    if current is None:
        return None
    try:
        if satisfies(current, manifest.pte):
            return None
    except SemverError:
        return None
    return f"Requires PDF-TEI-Editor {manifest.pte}, but this is {current}"
