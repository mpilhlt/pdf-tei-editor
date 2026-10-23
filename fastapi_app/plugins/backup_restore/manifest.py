"""
Version manifest of backups made by the Backup & Restore plugin.

Every backup contains ``backup-manifest.json`` at the top level of the ZIP:

    {"format": 1, "pte_version": "0.76.0", "created_at": "2026-10-23T08:00:00+00:00"}

A backup can be restored only into a PDF-TEI-Editor of a compatible version: from 1.0.0 on the
major version must match, before 1.0.0 the minor version (``0.76.x`` backups restore into any
``0.76.x``). Backups without a manifest are refused, since their compatibility cannot be checked.
"""

import json
import zipfile
from datetime import datetime, timezone

from fastapi_app.lib.core.data_restore import BACKUP_MANIFEST
from fastapi_app.lib.utils.semver import SemverError, Version, parse_version

MANIFEST_FORMAT = 1

RULE = "backups can only be restored into the same minor version (0.x.*) before version 1.0.0, and into the same major version (x.*.*) from 1.0.0 on"


class IncompatibleBackupError(ValueError):
    """The backup cannot be restored into this version of the application."""


def build_manifest(pte_version: str | None) -> dict[str, str | int | None]:
    """The manifest for a backup made now by the given application version."""
    return {
        "format": MANIFEST_FORMAT,
        "pte_version": pte_version,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def compatibility_line(version: str | Version) -> tuple[int, ...]:
    """
    The part of a version that must match for a backup to be restorable.

    Returns:
        ``(major,)`` from 1.0.0 on, ``(0, minor)`` before

    Raises:
        SemverError: If the version is not a complete semantic version
    """
    major, minor, _ = parse_version(version) if isinstance(version, str) else version
    return (major,) if major >= 1 else (0, minor)


def _line_label(line: tuple[int, ...]) -> str:
    return f"{line[0]}.x" if len(line) == 1 else f"{line[0]}.{line[1]}.x"


def read_backup_version(zf: zipfile.ZipFile, prefix: str | None = None) -> str | None:
    """
    The application version recorded in a backup's manifest.

    Args:
        zf: The backup ZIP
        prefix: Top-level directory the backup's contents are nested in (``data``), if any

    Returns:
        The version, or None if the backup has no manifest

    Raises:
        IncompatibleBackupError: If the manifest is unreadable or has no valid version
    """
    name = f"{prefix}/{BACKUP_MANIFEST}" if prefix else BACKUP_MANIFEST
    try:
        raw = zf.read(name)
    except KeyError:
        return None
    try:
        manifest = json.loads(raw)
    except ValueError:
        raise IncompatibleBackupError(f"The backup's {BACKUP_MANIFEST} is not valid JSON")
    version = manifest.get("pte_version") if isinstance(manifest, dict) else None
    if not isinstance(version, str):
        raise IncompatibleBackupError(f"The backup's {BACKUP_MANIFEST} does not record the application version")
    return version


def check_compatible(backup_version: str | None, current_version: str | None) -> None:
    """
    Verify that a backup made by ``backup_version`` can be restored into ``current_version``.

    Raises:
        IncompatibleBackupError: With a message for the user if it cannot
    """
    if backup_version is None:
        raise IncompatibleBackupError(
            f"The backup has no {BACKUP_MANIFEST}, so its version is unknown. It was made by a version that did not record its version, or not by this plugin. Restoring is refused because {RULE}."
        )
    if current_version is None:
        raise IncompatibleBackupError("The version of this server cannot be determined, so the backup's compatibility cannot be checked")
    try:
        backup_line = compatibility_line(backup_version)
    except SemverError:
        raise IncompatibleBackupError(f"The backup records an invalid application version: '{backup_version}'")
    current_line = compatibility_line(current_version)
    if backup_line != current_line:
        raise IncompatibleBackupError(
            f"This backup was made with version {backup_version} and cannot be restored into version {current_version}: {RULE}. Restore it into a {_line_label(backup_line)} installation instead."
        )
