"""
Unit tests for the ProgressBar SSE helper.

@testCovers fastapi_app/lib/sse/sse_utils.py
"""

import json
import unittest
from unittest.mock import Mock

from fastapi_app.lib.sse.sse_utils import ProgressBar


class TestProgressBar(unittest.TestCase):
    """Test the SSE events sent by ProgressBar."""

    def setUp(self) -> None:
        self.sse_service = Mock()
        self.sse_service.send_message.return_value = True
        self.progress = ProgressBar(self.sse_service, "session-1", progress_id="p1")

    def _last_event(self) -> tuple[str, dict[str, object]]:
        kwargs = self.sse_service.send_message.call_args.kwargs
        self.assertEqual(kwargs["client_id"], "session-1")
        return kwargs["event_type"], json.loads(kwargs["data"])

    def test_show_includes_title(self) -> None:
        self.progress.show(title="Extracting", label="Starting")
        event_type, data = self._last_event()
        self.assertEqual(event_type, "progressShow")
        self.assertEqual(data["title"], "Extracting")
        self.assertEqual(data["label"], "Starting")
        self.assertEqual(data["progress_id"], "p1")

    def test_show_omits_missing_title(self) -> None:
        self.progress.show(label="Starting")
        _, data = self._last_event()
        self.assertNotIn("title", data)

    def test_set_title_sends_progress_title(self) -> None:
        self.assertTrue(self.progress.set_title("New title"))
        event_type, data = self._last_event()
        self.assertEqual(event_type, "progressTitle")
        self.assertEqual(data, {"progress_id": "p1", "title": "New title"})


if __name__ == "__main__":
    unittest.main()
