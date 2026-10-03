"""
Backup archive creation for the Backup & Restore plugin.

Builds the backup ZIP on disk (not in memory) and snapshots SQLite databases
with the SQLite backup API so the archive is consistent while the database is
in use.
"""

import hashlib
import logging
import os
import sqlite3
import tempfile
import zipfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Subdirectories of the data root that are included in a backup
BACKUP_DIRS = ("db", "files")

# SQLite sidecar files that must not be archived (the snapshot is self-contained)
SQLITE_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")


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


def create_backup_zip(data_root: Path, tmp_dir: Path) -> tuple[Path, str]:
    """Create the backup ZIP of ``db/`` and ``files/`` in ``tmp_dir``.

    Args:
        data_root: Application data root
        tmp_dir: Directory in which the ZIP and temporary snapshots are created.
            Must not be inside any of the archived directories.

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
                for name in BACKUP_DIRS:
                    backup_dir = data_root / name
                    if not backup_dir.exists():
                        continue
                    for file_path in sorted(backup_dir.rglob("*")):
                        if not file_path.is_file() or _is_sqlite_sidecar(file_path):
                            continue
                        arcname = str(file_path.relative_to(data_root))
                        if file_path.suffix == ".db":
                            snapshot = snap_dir / f"{len(list(snap_dir.iterdir()))}.db"
                            snapshot_sqlite(file_path, snapshot)
                            zf.write(snapshot, arcname)
                            snapshot.unlink()
                        else:
                            zf.write(file_path, arcname)

        digest = hashlib.sha256()
        with open(zip_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
        return zip_path, digest.hexdigest()
    except BaseException:
        zip_path.unlink(missing_ok=True)
        raise
