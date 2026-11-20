"""
Tests for restarting the server processes (fastapi_app/lib/core/worker_recycle.py).

@testCovers fastapi_app/lib/core/worker_recycle.py
"""

import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.core.worker_recycle import can_recycle_workers, recycle_workers


class TestWorkerRecycle(unittest.TestCase):

    def test_no_restart_without_supervisor(self):
        with patch.dict("os.environ", {"PTE_WORKER_RECYCLE": "", "PTE_DEV_RELOAD_TRIGGER": ""}):
            self.assertFalse(can_recycle_workers())
            with self.assertRaises(RuntimeError):
                recycle_workers()

    def test_production_server_sends_sighup_to_the_supervisor(self):
        with patch.dict("os.environ", {"PTE_WORKER_RECYCLE": "1", "PTE_DEV_RELOAD_TRIGGER": ""}), \
                patch("os.kill") as kill, patch("os.getppid", return_value=4242):
            self.assertTrue(can_recycle_workers())
            self.assertEqual(recycle_workers(), 4242)
        kill.assert_called_once_with(4242, signal.SIGHUP)

    def test_dev_server_writes_the_reload_trigger(self):
        with tempfile.TemporaryDirectory() as tmp:
            trigger = Path(tmp) / "plugins" / "dev-reload-trigger.py"
            with patch.dict("os.environ", {"PTE_WORKER_RECYCLE": "", "PTE_DEV_RELOAD_TRIGGER": str(trigger)}), \
                    patch("os.kill") as kill:
                self.assertTrue(can_recycle_workers())
                recycle_workers()
                first = trigger.read_text()
                recycle_workers()
            kill.assert_not_called()
            self.assertTrue(first.startswith("#"))
            self.assertTrue(trigger.exists())


if __name__ == "__main__":
    unittest.main()
