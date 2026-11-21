"""
Exclusive locks on files, shared by all processes on the machine.

The locks are tied to an open file handle: the operating system releases them when the handle
is closed, also when the process ends or crashes, so a lock is never left behind. Two handles of
the same file exclude each other also within one process.
"""

import sys
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Iterator, Optional


def _try_lock(f: IO[bytes]) -> bool:
    """Try to lock an open file without waiting. Returns whether the lock was acquired."""
    if sys.platform == "win32":
        import msvcrt

        f.seek(0)
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True
    import fcntl

    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def _lock(f: IO[bytes]) -> None:
    """Lock an open file, waiting until the lock is free."""
    if sys.platform == "win32":
        import msvcrt

        f.seek(0)
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                # LK_LOCK gives up after 10 attempts; keep waiting
                continue
    import fcntl

    fcntl.flock(f.fileno(), fcntl.LOCK_EX)


def _unlock(f: IO[bytes]) -> None:
    if sys.platform == "win32":
        import msvcrt

        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


@contextmanager
def exclusive_file_lock(path: Path) -> Iterator[None]:
    """Hold an exclusive lock on a file, waiting until it is free. Meant for short critical sections."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+b") as f:
        _lock(f)
        try:
            yield
        finally:
            _unlock(f)


class NonBlockingFileLock:
    """
    An exclusive lock on a file that is acquired without waiting, for callers that wait
    asynchronously (by retrying `try_acquire()`) instead of blocking a thread.
    """

    def __init__(self, path: Path):
        self.path = path
        self._file: Optional[IO[bytes]] = None

    def try_acquire(self) -> bool:
        """Try to acquire the lock. Returns whether this object holds the lock."""
        if self._file is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        f = open(self.path, "a+b")
        if _try_lock(f):
            self._file = f
            return True
        f.close()
        return False

    def release(self) -> None:
        """Release the lock if it is held."""
        if self._file is None:
            return
        try:
            _unlock(self._file)
        finally:
            self._file.close()
            self._file = None
