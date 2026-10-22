"""
Staging and applying data restores from the backup-restore plugin.

A restore is staged inside the data root, not next to it, because in Docker the data root is
a volume mount point: it cannot be renamed, and directories next to it are lost when the
container is recreated.

1. The plugin extracts the backup into ``<data>/.restore/data/`` and writes the marker
   ``<data>/.restore/ready`` (see stage_restore()).
2. At the next start of a worker process, apply_pending_restore() moves the current contents
   of the data root to ``<data>/.restore-previous/<YYYYMMDD_HHMMSS>/`` and the staged contents
   into the data root. Plugins installed at runtime (``plugins/site/``) are kept.

Both steps hold an exclusive lock on ``<data>/.restore.lock``, so of several workers starting
at the same time exactly one applies the restore, before any of them opens the databases.
A swap that was interrupted is completed at the next start.
"""

import json
import logging
import shutil
import sys
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path, PurePosixPath

STAGING_DIR = ".restore"
PREVIOUS_DIR = ".restore-previous"
LOCK_FILE = ".restore.lock"

# Records the last applied restore, so that clients can notice it (see read_applied_restore())
APPLIED_FILE = ".restore-applied.json"

# Entries of the data root that a restore leaves in place
RESERVED_NAMES = frozenset({STAGING_DIR, PREVIOUS_DIR, LOCK_FILE, APPLIED_FILE, ".gitignore"})

# Directory that is carried over from the previous data: plugins installed at runtime
# (see fastapi_app.lib.plugins.plugin_site)
KEPT_PATH = ("plugins", "site")

_PAYLOAD = "data"
_READY = "ready"
_ARCHIVE = "archive"
_MOVED_OUT = "moved-out"


class RestoreError(ValueError):
    """The backup cannot be staged."""


@contextmanager
def restore_lock(data_root: Path) -> Iterator[None]:
    """
    Hold the exclusive restore lock of a data root (blocks until it is free).

    The lock is released when the process ends, also if it crashes.
    """
    data_root.mkdir(parents=True, exist_ok=True)
    with open(data_root / LOCK_FILE, "a+b") as f:
        if sys.platform == "win32":
            import msvcrt

            f.seek(0)
            while True:
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    # LK_LOCK gives up after 10 attempts; keep waiting
                    continue
            try:
                yield
            finally:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def is_restore_pending(data_root: Path) -> bool:
    """Whether a staged restore waits to be applied."""
    return (data_root / STAGING_DIR / _READY).exists()


def _member_path(name: str, strip_prefix: str | None) -> PurePosixPath | None:
    """
    The path a ZIP member is extracted to, relative to the payload directory.

    Returns:
        None for members that are not extracted (directories, members outside ``strip_prefix``,
        reserved names)

    Raises:
        RestoreError: If the member's path leaves the payload directory
    """
    path = PurePosixPath(name)
    if name.startswith("/") or "\\" in name or ".." in path.parts or (path.parts and ":" in path.parts[0]):
        raise RestoreError(f"Unsafe path in ZIP: {name}")
    if name.endswith("/"):
        return None
    if strip_prefix is not None:
        if len(path.parts) < 2 or path.parts[0] != strip_prefix:
            return None
        path = PurePosixPath(*path.parts[1:])
    if path.parts[0] in RESERVED_NAMES:
        return None
    return path


def stage_restore(zip_path: Path, data_root: Path, strip_prefix: str | None = None) -> int:
    """
    Extract a backup ZIP into the staging directory and mark it ready.

    A previously staged restore that was not applied yet is replaced.

    Args:
        zip_path: The backup ZIP
        data_root: The application data root
        strip_prefix: Top-level directory of the ZIP to extract instead of the whole ZIP
            (backups made by hand often contain ``data/...``)

    Returns:
        Number of extracted files

    Raises:
        RestoreError: If the ZIP contains unsafe paths
    """
    staging = data_root / STAGING_DIR
    with restore_lock(data_root):
        if staging.exists():
            shutil.rmtree(staging)
        payload = staging / _PAYLOAD
        payload.mkdir(parents=True)
        count = 0
        try:
            with zipfile.ZipFile(zip_path) as zf:
                for info in zf.infolist():
                    relative = _member_path(info.filename, strip_prefix)
                    if relative is None:
                        continue
                    target = payload.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                    count += 1
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        (staging / _READY).write_text(datetime.now().isoformat(), encoding="utf-8")
    return count


def _move_aside(entry: Path, archive: Path) -> None:
    """Move an entry of the data root into the archive, without overwriting what is there."""
    target = archive / entry.name
    n = 1
    while target.exists():
        target = archive / f"{entry.name}.{n}"
        n += 1
    entry.rename(target)


def apply_pending_restore(
    data_root: Path,
    logger: logging.Logger,
    now: Callable[[], datetime] = datetime.now,
) -> bool:
    """
    Apply a staged restore: archive the data root's contents and move the staged data in.

    Must run before the databases are opened. Workers that start at the same time wait for
    the one that applies the restore.

    Args:
        data_root: The application data root
        logger: Logger
        now: Clock for the archive directory name

    Returns:
        True if a restore was applied
    """
    staging = data_root / STAGING_DIR
    if not (staging / _READY).exists():
        return False
    with restore_lock(data_root):
        if not (staging / _READY).exists():
            # Another worker applied it while this one waited for the lock
            return False

        archive_file = staging / _ARCHIVE
        if archive_file.exists():
            archive_name = archive_file.read_text(encoding="utf-8").strip()
            logger.info(f"Completing an interrupted data restore (previous data in {PREVIOUS_DIR}/{archive_name})")
        else:
            archive_name = now().strftime("%Y%m%d_%H%M%S")
            archive_file.write_text(archive_name, encoding="utf-8")
            logger.info(f"Applying the staged data restore in {staging}")
        archive = data_root / PREVIOUS_DIR / archive_name
        archive.mkdir(parents=True, exist_ok=True)

        if not (staging / _MOVED_OUT).exists():
            for entry in sorted(data_root.iterdir()):
                if entry.name not in RESERVED_NAMES:
                    _move_aside(entry, archive)
            (staging / _MOVED_OUT).touch()

        payload = staging / _PAYLOAD
        for entry in sorted(payload.iterdir()):
            target = data_root / entry.name
            if target.exists():
                # Created by a worker of the previous generation since the contents were moved out
                _move_aside(target, archive)
            entry.rename(target)

        # Plugins installed at runtime are code, not data: keep them (the restored plugin
        # state decides which of them are active)
        kept = data_root.joinpath(*KEPT_PATH)
        previous = archive.joinpath(*KEPT_PATH)
        if previous.is_dir() and not kept.exists():
            kept.parent.mkdir(parents=True, exist_ok=True)
            previous.rename(kept)

        (data_root / APPLIED_FILE).write_text(
            json.dumps({"id": archive_name, "applied_at": now().isoformat(timespec="seconds")}), encoding="utf-8"
        )
        shutil.rmtree(staging)
        logger.info(
            f"Data restore complete. The previous data is in {data_root / PREVIOUS_DIR / archive_name}; delete it when it is no longer needed."
        )
        return True


def read_applied_restore(data_root: Path) -> dict[str, str] | None:
    """
    The last restore applied to a data root.

    Returns:
        ``{"id": ..., "applied_at": ...}`` (the id is the name of the directory with the
        previous data), or None if no restore was applied
    """
    try:
        value = json.loads((data_root / APPLIED_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        return None
    return {"id": value["id"], "applied_at": str(value.get("applied_at", ""))}
