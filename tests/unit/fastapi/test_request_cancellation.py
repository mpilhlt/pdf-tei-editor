"""Unit tests for CancelledRequestMiddleware."""

import asyncio
import json
import unittest

from starlette.types import Message, Receive, Scope, Send

from fastapi_app.lib.core.request_cancellation import SHUTDOWN_DETAIL, CancelledRequestMiddleware


async def _cancelled_app(scope: Scope, receive: Receive, send: Send) -> None:
    """An app that is cancelled while it waits, like a request at server shutdown."""
    asyncio.current_task().cancel()
    await asyncio.sleep(1)


async def _cancelled_stream_app(scope: Scope, receive: Receive, send: Send) -> None:
    """An app that is cancelled after it started a streamed response."""
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"data", "more_body": True})
    await _cancelled_app(scope, receive, send)


async def _ok_app(scope: Scope, receive: Receive, send: Send) -> None:
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


async def _failing_app(scope: Scope, receive: Receive, send: Send) -> None:
    raise ValueError("boom")


def _run(app, scope_type: str = "http") -> list[Message]:
    """Run the app wrapped in the middleware in its own task and return the sent messages."""
    messages: list[Message] = []

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        messages.append(message)

    scope = {"type": scope_type, "method": "POST", "path": "/api/v1/test"}

    async def main() -> None:
        await asyncio.create_task(CancelledRequestMiddleware(app)(scope, receive, send))

    asyncio.run(main())
    return messages


class TestCancelledRequestMiddleware(unittest.TestCase):

    def test_cancelled_request_gets_503(self):
        with self.assertLogs("fastapi_app.lib.core.request_cancellation", level="WARNING") as logs:
            messages = _run(_cancelled_app)
        self.assertEqual(messages[0]["status"], 503)
        self.assertEqual(json.loads(messages[1]["body"]), {"detail": SHUTDOWN_DETAIL})
        self.assertIn("POST /api/v1/test cancelled", logs.output[0])

    def test_cancelled_stream_is_ended(self):
        with self.assertLogs("fastapi_app.lib.core.request_cancellation", level="WARNING"):
            messages = _run(_cancelled_stream_app)
        self.assertEqual(len(messages), 3)
        self.assertEqual(messages[2], {"type": "http.response.body", "body": b"", "more_body": False})

    def test_completed_request_is_unchanged(self):
        messages = _run(_ok_app)
        self.assertEqual([m["type"] for m in messages], ["http.response.start", "http.response.body"])

    def test_other_exceptions_propagate(self):
        with self.assertRaises(ValueError):
            _run(_failing_app)

    def test_non_http_cancellation_propagates(self):
        with self.assertRaises(asyncio.CancelledError):
            _run(_cancelled_app, scope_type="websocket")


if __name__ == "__main__":
    unittest.main()
