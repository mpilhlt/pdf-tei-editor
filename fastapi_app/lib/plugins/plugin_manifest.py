"""
The optional ``pte-plugin.json`` manifest of a plugin.

    {
      "version": "1.2.0",
      "engines": { "pte": ">=0.75.0 <1.0.0" }
    }

- ``version``: semantic version of the plugin itself, shown in the plugin manager
- ``engines.pte``: npm-style semver range of the PDF-TEI-Editor versions the plugin works with
  (``>=0.75.0``, ``^0.75.0``, ``0.75.x``, ``>=0.75 <2`` ...); a plugin outside the range is not loaded

Every field is optional. A missing, empty or field-less manifest means "no declared constraints",
so plugins without one (all built-in plugins) load as before.
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from fastapi_app.config import get_settings
from fastapi_app.lib.utils.semver import SemverError, parse_version, satisfies, validate_range

logger = logging.getLogger(__name__)

MANIFEST_FILE = "pte-plugin.json"


class ManifestError(ValueError):
    """The manifest is not valid JSON or contains an invalid field."""


@dataclass(frozen=True)
class PluginManifest:
    """Contents of ``pte-plugin.json``; None fields were not declared."""

    version: str | None = None
    pte: str | None = None


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
        text = path.read_text(encoding="utf-8").strip()
        data = json.loads(text) if text else {}
    except (OSError, ValueError) as e:
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

    pte = None
    engines = data.get("engines")
    if engines is not None:
        if not isinstance(engines, dict):
            raise ManifestError("'engines' must be an object")
        pte = engines.get("pte")
        if pte is not None:
            if not isinstance(pte, str):
                raise ManifestError("'engines.pte' must be a string")
            try:
                validate_range(pte)
            except SemverError as e:
                raise ManifestError(f"Invalid 'engines.pte' range: {e}") from e
    return PluginManifest(version=version, pte=pte)


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
    if manifest is None or manifest.pte is None:
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
