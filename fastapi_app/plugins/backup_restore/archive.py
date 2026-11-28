"""
Backup archive creation for the Backup & Restore plugin.

Builds the backup ZIP on disk (not in memory) and snapshots SQLite databases
with the SQLite backup API so the archive is consistent while the database is
in use.
"""

import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path

from fastapi_app.lib.core.data_restore import BACKUP_MANIFEST
from fastapi_app.plugins.backup_restore.manifest import build_manifest

logger = logging.getLogger(__name__)

# Subdirectories of the data root that are included in a backup
BACKUP_DIRS = ("db", "files")

# SQLite sidecar files that must not be archived (the snapshot is self-contained)
SQLITE_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")


# Files (relative to the data root) that are never archived: the job queue is transient and its
# SQLite file may be mid-write. The job output directory `jobs/` is outside BACKUP_DIRS, so the
# ZIP, which a backup job writes there, is not archived into itself.
EXCLUDED_FILES = ("db/jobs.db",)

PROGRESS_PHASE = "Adding files"


def snapshot_sqlite(source: Path, target: Path) -> None:
    """Write a consistent copy of a SQLite database using the backup API.

    Args:
        source: Path of the live database
        target: Path of the snapshot file to create
    """
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _is_sqlite_sidecar(path: Path) -> bool:
    return path.name.endswith(SQLITE_SIDECAR_SUFFIXES)


def _is_excluded(path: Path, data_root: Path) -> bool:
    """Whether the file is a SQLite sidecar or one of EXCLUDED_FILES (or a sidecar of one)."""
    return _is_sqlite_sidecar(path) or path.relative_to(data_root).as_posix() in EXCLUDED_FILES


def _backup_files(data_root: Path) -> list[Path]:
    """The files to archive, in archive order."""
    files: list[Path] = []
    for name in BACKUP_DIRS:
        backup_dir = data_root / name
        if backup_dir.exists():
            files.extend(p for p in sorted(backup_dir.rglob("*")) if p.is_file() and not _is_excluded(p, data_root))
    return files


def create_backup_zip(
    data_root: Path,
    tmp_dir: Path,
    pte_version: str | None,
    progress: Callable[[int, int, str], None] | None = None,
    check_cancelled: Callable[[], None] | None = None,
) -> tuple[Path, str]:
    """Create the backup ZIP of ``db/`` and ``files/`` in ``tmp_dir``.

    Args:
        data_root: Application data root
        tmp_dir: Directory in which the ZIP and temporary snapshots are created.
            Must not be inside any of the archived directories.
        pte_version: Application version recorded in the backup manifest
        progress: Called with (files added, total files, phase) after each file
        check_cancelled: Called before each file; raises to abort. The partial ZIP is deleted.

    Returns:
        Tuple of (path of the ZIP file, hex SHA-256 of the ZIP file). The caller
        deletes the file.
    """
    tmp_dir.mkdir(parents=True, exist_ok=True)
    fd, zip_name = tempfile.mkstemp(prefix="backup_", suffix=".zip", dir=tmp_dir)
    zip_path = Path(zip_name)
    os.close(fd)

    try:
        with tempfile.TemporaryDirectory(dir=tmp_dir) as snap_dir_name:
            snap_dir = Path(snap_dir_name)
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr(BACKUP_MANIFEST, json.dumps(build_manifest(pte_version), indent=2))
                files = _backup_files(data_root)
                for done, file_path in enumerate(files, 1):
                    if check_cancelled is not None:
                        check_cancelled()
                    arcname = str(file_path.relative_to(data_root))
                    if file_path.suffix == ".db":
                        snapshot = snap_dir / f"{len(list(snap_dir.iterdir()))}.db"
                        snapshot_sqlite(file_path, snapshot)
                        zf.write(snapshot, arcname)
                        snapshot.unlink()
                    else:
                        zf.write(file_path, arcname)
                    if progress is not None:
                        progress(done, len(files), PROGRESS_PHASE)

        digest = hashlib.sha256()
        with open(zip_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
        return zip_path, digest.hexdigest()
    except BaseException:
        zip_path.unlink(missing_ok=True)
        raise
