"""
Unit tests for DemoteToDebugFilter, which logs chatty third-party INFO messages at DEBUG level.

@testCovers fastapi_app/lib/utils/logging_utils.py
"""

import io
import logging
import unittest

from fastapi_app.lib.utils.logging_utils import DemoteToDebugFilter


class TestDemoteToDebugFilter(unittest.TestCase):
    def make_logger(self, level: int) -> io.StringIO:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setLevel(level)
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
        handler.addFilter(DemoteToDebugFilter(handler.level))
        root = logging.getLogger("demotion-test")
        root.handlers = [handler]
        root.setLevel(logging.DEBUG)
        root.propagate = False
        self.root = root
        return stream

    def log(self, name: str, level: int, message: str) -> None:
        # child loggers of the test root, named like the library loggers
        record = logging.LogRecord(name, level, __file__, 1, message, None, None)
        self.root.handle(record)

    def test_info_level_hides_demoted_messages(self):
        stream = self.make_logger(logging.INFO)
        self.log("fontTools.subset", logging.INFO, "Glyph names: [...]")
        self.log("ocrmypdf._pipeline", logging.INFO, "redoing OCR")
        self.log("ocrmypdf._graft", logging.INFO, "Parsing 71 pages with HocrParser")
        self.log("ocrmypdf._pipelines.ocr", logging.INFO, "Postprocessing...")
        self.log("ocrmypdf._pipeline", logging.INFO, "Total file size ratio: 0.99 savings: -0.8%")
        self.log("ocrmypdf.optimize", logging.INFO, "Image optimization did not improve the file")
        self.log("ocrmypdf._exec", logging.WARNING, "tesseract warning")
        self.log("fastapi_app.routers.ocr", logging.INFO, "Applied OCR")
        self.log("ocrmypdfx", logging.INFO, "other library")
        lines = stream.getvalue().splitlines()
        self.assertEqual(lines, [
            "INFO ocrmypdf._pipelines.ocr Postprocessing...",
            "INFO ocrmypdf._pipeline Total file size ratio: 0.99 savings: -0.8%",
            "INFO ocrmypdf.optimize Image optimization did not improve the file",
            "WARNING ocrmypdf._exec tesseract warning",
            "INFO fastapi_app.routers.ocr Applied OCR",
            "INFO ocrmypdfx other library",
        ])

    def test_debug_level_shows_demoted_messages_as_debug(self):
        stream = self.make_logger(logging.DEBUG)
        self.log("fontTools.subset", logging.INFO, "cmap pruned")
        self.assertEqual(stream.getvalue().splitlines(), ["DEBUG fontTools.subset cmap pruned"])


if __name__ == "__main__":
    unittest.main()
