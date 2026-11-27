"""
Host-wide shared data directory.

Data that the application downloads or produces itself and that is not specific to one
installation (downloaded models, models shared by all instances) is stored once per host,
in the directory set by `SHARED_DATA_DIR` (default: `<DATA_ROOT>/shared`). Several workers
and several installations, possibly of different versions, may use the same directory at
the same time.

Core and plugins get named subdirectories with `get_shared_data_dir()`. By convention a name
starts with its owner and contains a version (`tesseract/tessdata_best-4.1.0`), so that
installations needing different versions do not overwrite each other. Instance-specific data
(user data, settings) does not belong here.

`download_shared_file()` downloads a file into such a directory atomically: the file appears
under its final name only when it is complete, and a lock file keeps concurrent processes from
downloading the same file twice.
"""

import fcntl
import logging
import os
import re
import tempfile
import urllib.request
from pathlib import Path

from fastapi_app.config import get_settings

logger = logging.getLogger(__name__)

_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")

DOWNLOAD_CHUNK_SIZE = 1024 * 1024

SHARED_FILE_MODE = 0o644
"""Permissions of downloaded files, readable by installations running as other users."""


def _validate_name(name: str) -> list[str]:
    """
    Split a shared directory name into its segments.

    Raises:
        ValueError: If the name is empty, absolute, or contains empty, `.`, `..` or invalid segments
    """
    segments = name.split("/")
    if not name or any(not _SEGMENT.match(segment) or segment in (".", "..") for segment in segments):
        raise ValueError(f"Invalid shared data directory name: {name!r} (expected slash-separated segments of letters, digits, '.', '_' and '-')")
    return segments


def get_shared_data_dir(name: str) -> Path:
    """
    Return a named subdirectory of the shared data directory, creating it if needed.

    Args:
        name: Slash-separated name, starting with the owner and containing a version,
            e.g. "tesseract/tessdata_best-4.1.0"

    Returns:
        The absolute path of the directory

    Raises:
        ValueError: If the name is invalid
    """
    segments = _validate_name(name)
    path = get_settings().shared_data_dir.resolve().joinpath(*segments)
    path.mkdir(parents=True, exist_ok=True)
    return path


def download_shared_file(url: str, target: Path, timeout: float = 300) -> bool:
    """
    Download a file to `target` unless it exists or another process is downloading it.

    The file is written to a temporary file in the target directory and renamed when it is
    complete. A lock on `<target>.lock` keeps other processes (other workers, other
    installations sharing the directory) from downloading it at the same time.

    Args:
        url: URL of the file
        target: Final path of the file, usually in a directory from get_shared_data_dir()
        timeout: Timeout of the connection in seconds

    Returns:
        True if the file was downloaded, False if it exists or another process holds the lock

    Raises:
        OSError: If the download or writing the file fails (including urllib errors)
    """
    if target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_name(target.name + ".lock")
    with open(lock_path, "a") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        try:
            # another process may have finished the download before the lock was free
            if target.exists():
                return False
            fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent)
            try:
                with os.fdopen(fd, "wb") as tmp_file, urllib.request.urlopen(url, timeout=timeout) as response:
                    while chunk := response.read(DOWNLOAD_CHUNK_SIZE):
                        tmp_file.write(chunk)
                # mkstemp creates the file readable by the owner only; installations running
                # as other users share the directory
                os.chmod(tmp_name, SHARED_FILE_MODE)
                os.replace(tmp_name, target)
            except BaseException:
                Path(tmp_name).unlink(missing_ok=True)
                raise
            logger.info(f"Downloaded {url} to {target}")
            return True
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
