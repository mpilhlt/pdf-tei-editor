# Graceful handling of requests cancelled at server shutdown

Date: 2026-10-22

## Problem

On a dev server reload (`bin/start-dev` runs uvicorn with `--timeout-graceful-shutdown 1`), a request that was still waiting, here an annotation review awaiting `EndpointLLMProvider.chat_completion` (`asyncio.to_thread` around a blocking `requests` call), was cancelled by uvicorn. The `asyncio.CancelledError` left the application, and uvicorn's `run_asgi` logs every `BaseException` from the app as "Exception in ASGI application" with the full traceback, then sends a 500.

## Analysis

- Re-raising `CancelledError` in a route or provider does not help: any exception that leaves the app produces the traceback. The only place to end it quietly is the outermost ASGI layer.
- The blocking worker thread does not delay the shutdown: uvicorn re-raises the termination signal after shutdown, so the process exits right away (checked with a uvicorn app that blocks in `asyncio.to_thread(time.sleep, 15)`: exit after 1 s with and without a daemon thread). No change to the LLM providers is needed.
- Other providers: `anthropic-llm`, `inference-endpoints`, the core `OpenAICompatibleProvider` and `kisski` use `asyncio.to_thread`; `google-llm` uses the native async client. All are covered by the core middleware, so pte-plugins needs no change.

## Change

`fastapi_app/lib/core/request_cancellation.py` adds `CancelledRequestMiddleware`, registered last in `fastapi_app/main.py` (outermost user middleware). For HTTP requests it catches `CancelledError`, calls `task.uncancel()`, logs one warning line, and sends a 503 `{"detail": "The server is restarting. Please try again."}`, or ends the body of a response that has already started (e.g. a stream). Other exceptions and non-HTTP scopes are unchanged.

uvicorn's own line "Cancel N running task(s), timeout graceful shutdown exceeded" (logged as ERROR by uvicorn) remains.

Tests: `tests/unit/fastapi/test_request_cancellation.py`.
