"""
Tests that the file serving route logs a file only once per load, not once per range request.

@testCovers fastapi_app/routers/files_serve.py
"""

import unittest

from fastapi_app.routers.files_serve import is_initial_request


class TestIsInitialRequest(unittest.TestCase):
    def test_no_range_header(self) -> None:
        self.assertTrue(is_initial_request(None))
        self.assertTrue(is_initial_request(""))

    def test_range_from_first_byte(self) -> None:
        self.assertTrue(is_initial_request("bytes=0-"))
        self.assertTrue(is_initial_request("bytes=0-65535"))
        self.assertTrue(is_initial_request(" Bytes= 0-65535"))

    def test_range_after_first_byte(self) -> None:
        self.assertFalse(is_initial_request("bytes=65536-131071"))
        self.assertFalse(is_initial_request("bytes=10-20"))
        self.assertFalse(is_initial_request("bytes=-500"))

    def test_unknown_unit(self) -> None:
        self.assertTrue(is_initial_request("items=5-10"))


if __name__ == "__main__":
    unittest.main()
