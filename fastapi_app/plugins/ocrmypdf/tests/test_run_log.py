"""
Unit tests for the run log of the OCRmyPDF engine (#904): the detail of a run goes to a file of
its own, which the next run overwrites; only warnings reach the application log.
"""

import logging
import tempfile
import unittest
from pathlib import Path

from fastapi_app.plugins.ocrmypdf.run_log import ocr_run_log


class _Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


class TestRunLog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app_log = _Collect()
        root = logging.getLogger()
        self.root_level = root.level
        root.setLevel(logging.DEBUG)
        root.addHandler(self.app_log)

    def tearDown(self):
        root = logging.getLogger()
        root.removeHandler(self.app_log)
        root.setLevel(self.root_level)
        self.tmp.cleanup()

    def test_detail_goes_to_the_run_log(self):
        path = Path(self.tmp.name) / "ocr-last-run.log"
        detail = logging.getLogger("ocrmypdf._pipeline")
        summary = logging.getLogger("fastapi_app.plugins.ocrmypdf.engine")
        with ocr_run_log(path) as log_file:
            self.assertEqual(log_file, path)
            detail.debug("detail message")
            detail.warning("warning message")
            summary.info("summary message")
        content = path.read_text(encoding="utf-8")
        for message in ("detail message", "warning message", "summary message"):
            self.assertIn(message, content)
        self.assertEqual(self.app_log.messages, ["warning message", "summary message"])
        # outside a run, the loggers propagate as usual
        detail.warning("after the run")
        self.assertIn("after the run", self.app_log.messages)
        self.assertTrue(logging.getLogger("ocrmypdf").propagate)

    def test_next_run_overwrites_the_run_log(self):
        path = Path(self.tmp.name) / "ocr-last-run.log"
        detail = logging.getLogger("ocrmypdf")
        with ocr_run_log(path):
            detail.debug("first run")
        with ocr_run_log(path):
            detail.debug("second run")
        content = path.read_text(encoding="utf-8")
        self.assertNotIn("first run", content)
        self.assertIn("second run", content)

    def test_without_file_the_detail_is_dropped(self):
        detail = logging.getLogger("ocrmypdf")
        with ocr_run_log(None) as log_file:
            self.assertIsNone(log_file)
            detail.info("dropped")
            detail.error("kept")
        self.assertEqual(self.app_log.messages, ["kept"])


if __name__ == "__main__":
    unittest.main()
