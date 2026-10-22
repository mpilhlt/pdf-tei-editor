"""
Ending requests that the server cancels when it shuts down.

When uvicorn stops (on a dev server reload, or when a production worker is replaced), it waits
``--timeout-graceful-shutdown`` seconds for running requests and then cancels them. The
``asyncio.CancelledError`` then propagates out of the application, and uvicorn logs every
exception that leaves the application as "Exception in ASGI application" with a full traceback,
for example for a request that waits for an LLM response.

CancelledRequestMiddleware is the outermost user middleware. It ends a cancelled request with a
503 response (or ends a response that has already started), logs one line instead of the
traceback, and does not re-raise the CancelledError, so that uvicorn sees a completed request.
Swallowing the cancellation is safe here because the request task is the outermost task:
nothing else awaits it but uvicorn's shutdown.
"""

import asyncio
import json
import logging

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

SHUTDOWN_DETAIL = "The server is restarting. Please try again."


class CancelledRequestMiddleware:
    """ASGI middleware that ends HTTP requests cancelled at server shutdown without an error."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_state = {"started": False, "complete": False}

        async def tracking_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_state["started"] = True
            elif message["type"] == "http.response.body" and not message.get("more_body", False):
                response_state["complete"] = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None:
                task.uncancel()
            logger.warning(f"{scope['method']} {scope['path']} cancelled because the server is shutting down")
            try:
                await _end_response(send, response_state["started"], response_state["complete"])
            except Exception as e:
                logger.debug(f"Could not end the cancelled response: {e}")


async def _end_response(send: Send, started: bool, complete: bool) -> None:
    """Send a 503 response, or end the body of a response that has already started."""
    if complete:
        return
    if not started:
        body = json.dumps({"detail": SHUTDOWN_DETAIL}).encode()
        await send({
            "type": "http.response.start",
            "status": 503,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
        return
    await send({"type": "http.response.body", "body": b"", "more_body": False})
