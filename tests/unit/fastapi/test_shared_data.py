"""
Unit tests for the host-wide shared data directory.

@testCovers fastapi_app/lib/core/shared_data.py
@testCovers fastapi_app/config.py
"""

import fcntl
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.config import Settings
from fastapi_app.lib.core import shared_data
from fastapi_app.lib.core.shared_data import download_shared_file, get_shared_data_dir


class FakeResponse(io.BytesIO):
    """Response of a patched urlopen."""

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class FailingResponse(FakeResponse):
    """Response that fails after the first chunk."""

    def read(self, size: int | None = -1) -> bytes:
        if self.tell() > 0:
            raise OSError("connection reset")
        return super().read(2)


class TestSharedDataDir(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.settings = Settings(DATA_ROOT=str(self.root / "data"), SHARED_DATA_DIR=str(self.root / "shared"))
        patcher = patch.object(shared_data, "get_settings", return_value=self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_name_validation(self) -> None:
        for name in ["", "../x", "/abs", "a//b", "a/./b", "a/../b", "a/b c", "a\\b"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                get_shared_data_dir(name)

    def test_dir_created_under_setting(self) -> None:
        path = get_shared_data_dir("tesseract/tessdata_best-4.1.0")
        self.assertEqual(path, (self.root / "shared" / "tesseract" / "tessdata_best-4.1.0").resolve())
        self.assertTrue(path.is_dir())

    def test_default_under_data_root(self) -> None:
        settings = Settings(DATA_ROOT=str(self.root / "data"), SHARED_DATA_DIR="")
        self.assertEqual(settings.shared_data_dir, self.root / "data" / "shared")


class TestDownloadSharedFile(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "models" / "deu.traineddata"

    def leftovers(self) -> list[str]:
        """Return the files in the target directory other than the lock file."""
        return sorted(p.name for p in self.target.parent.iterdir() if not p.name.endswith(".lock"))

    def test_download_atomic(self) -> None:
        with patch("urllib.request.urlopen", return_value=FakeResponse(b"model data")):
            self.assertTrue(download_shared_file("https://example.org/deu.traineddata", self.target))
        self.assertEqual(self.target.read_bytes(), b"model data")
        self.assertEqual(self.leftovers(), ["deu.traineddata"])
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)

    def test_failed_download_leaves_nothing(self) -> None:
        with patch("urllib.request.urlopen", return_value=FailingResponse(b"model data")):
            with self.assertRaises(OSError):
                download_shared_file("https://example.org/deu.traineddata", self.target)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.leftovers(), [])

    def test_skip_existing(self) -> None:
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"old")
        with patch("urllib.request.urlopen") as urlopen:
            self.assertFalse(download_shared_file("https://example.org/deu.traineddata", self.target))
            urlopen.assert_not_called()
        self.assertEqual(self.target.read_bytes(), b"old")

    def test_skip_when_locked(self) -> None:
        self.target.parent.mkdir(parents=True)
        with open(self.target.with_name(self.target.name + ".lock"), "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch("urllib.request.urlopen") as urlopen:
                self.assertFalse(download_shared_file("https://example.org/deu.traineddata", self.target))
                urlopen.assert_not_called()
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
