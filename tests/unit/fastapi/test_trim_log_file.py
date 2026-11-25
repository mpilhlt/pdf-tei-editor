"""Unit tests for trim_log_file(), which shortens app.log when the dev server is started."""

import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.utils.server_startup import trim_log_file


class TestTrimLogFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "app.log"

    def tearDown(self):
        self.tmp.cleanup()

    def write_lines(self, count: int, trailing_newline: bool = True) -> list[str]:
        lines = [f"line {i} " + "x" * (i % 50) for i in range(count)]
        self.path.write_text("\n".join(lines) + ("\n" if trailing_newline else ""), encoding="utf-8")
        return lines

    def test_keeps_the_last_lines(self):
        lines = self.write_lines(5000)
        # A small chunk size reads the file in many steps
        trim_log_file(self.path, keep_lines=1000, chunk_size=1000)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "\n".join(lines[-1000:]) + "\n")

    def test_last_line_without_newline(self):
        lines = self.write_lines(50, trailing_newline=False)
        trim_log_file(self.path, keep_lines=10, chunk_size=64)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "\n".join(lines[-10:]))

    def test_short_file_is_unchanged(self):
        for count in (0, 999, 1000):
            self.write_lines(count)
            before = self.path.read_bytes()
            trim_log_file(self.path, keep_lines=1000, chunk_size=128)
            self.assertEqual(self.path.read_bytes(), before, count)

    def test_missing_file(self):
        trim_log_file(self.path)
        self.assertFalse(self.path.exists())

    def test_multibyte_characters(self):
        self.path.write_text("".join(f"Größe {i} → ü\n" for i in range(100)), encoding="utf-8")
        trim_log_file(self.path, keep_lines=3, chunk_size=7)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "Größe 97 → ü\nGröße 98 → ü\nGröße 99 → ü\n")


if __name__ == "__main__":
    unittest.main()
