"""
Regression test for a deadlock between SSEService and SSELogHandler.

@testCovers fastapi_app/lib/sse/sse_service.py
@testCovers fastapi_app/lib/sse/sse_log_handler.py
"""

import logging
import threading
import unittest

from fastapi_app.lib.sse.sse_log_handler import SSELogHandler
from fastapi_app.lib.sse.sse_service import SSEService


class TestSSELogHandlerDeadlock(unittest.TestCase):
    """
    SSEService.send_message() logs through the logger it was constructed with
    while holding self.lock. If that logger has an SSELogHandler attached and
    at least one log-viewer subscriber exists, the handler forwards the record
    by calling send_message() again on the same thread, which then blocks
    forever trying to re-acquire the non-reentrant lock.
    """

    def setUp(self):
        self.logger = logging.getLogger("test.sse_deadlock_regression")
        self.logger.setLevel(logging.DEBUG)
        self.service = SSEService(self.logger)
        self.handler = SSELogHandler(self.service)
        self.logger.addHandler(self.handler)

    def tearDown(self):
        self.logger.removeHandler(self.handler)

    def _send_without_deadlock(self, client_id: str, event_type: str, data: str) -> bool:
        # A daemon thread is used (instead of e.g. ThreadPoolExecutor) so that a
        # deadlocked call can be abandoned after the timeout without blocking
        # process/test-runner exit.
        result_holder: dict = {}

        def target():
            result_holder["result"] = self.service.send_message(client_id, event_type, data)

        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        thread.join(timeout=5)

        if thread.is_alive():
            self.fail(
                "SSEService.send_message() deadlocked: it logs while holding "
                "self.lock, and the log record was forwarded by SSELogHandler "
                "back into send_message() on the same thread, which blocked "
                "trying to re-acquire the lock."
            )

        return result_holder["result"]

    def test_send_message_to_unknown_client_does_not_deadlock(self):
        # A log-viewer subscriber with an active queue is required so that
        # SSELogHandler actually forwards the record via send_message().
        subscriber_id = "subscriber-session"
        self.service.create_queue(subscriber_id)
        self.handler.subscribe_session(subscriber_id)

        # Logs "No SSE queue for client" while holding self.lock.
        result = self._send_without_deadlock("unknown-client", "test", "data")
        self.assertFalse(result)

    def test_send_message_success_does_not_deadlock(self):
        subscriber_id = "subscriber-session"
        self.service.create_queue(subscriber_id)
        self.handler.subscribe_session(subscriber_id)

        # Logs "Sent SSE ... to ..." while holding self.lock.
        result = self._send_without_deadlock(subscriber_id, "test", "data")
        self.assertTrue(result)


if __name__ == "__main__":
    unittest.main()
