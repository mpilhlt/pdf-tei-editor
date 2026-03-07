#!/usr/bin/env python3
"""
GROBID Trainer Relay Server
============================
Runs on any internet-accessible host. Accepts one WebSocket tunnel connection
from the HPC container and proxies HTTP requests through it — including full
SSE streaming for /jobs/{id}/stream.

Usage:
    pip install fastapi "uvicorn[standard]" websockets
    python relay_server.py [--host 0.0.0.0] [--port 8080] [--token SECRET]

    # Or via environment variable:
    RELAY_TOKEN=secret python relay_server.py

Endpoints:
    WS   /tunnel          Tunnel connection (from HPC container)
    GET  /tunnel/status   Check tunnel liveness
    ANY  /{path:path}     Proxy to trainer service through the tunnel
"""

import asyncio
import base64
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Dict, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
import uvicorn


# ── Tunnel state (module-level, single tunnel connection) ─────────────────────

_tunnel_ws: Optional[WebSocket] = None
_tunnel_connected_at: Optional[float] = None

# Pending non-streaming requests: req_id → Future resolved with full response dict
_pending: Dict[str, asyncio.Future[dict]] = {}

# Pending streaming requests: req_id → Queue of chunk_b64 strings (None = end-of-stream)
_queues: Dict[str, asyncio.Queue[Optional[str]]] = {}

# Serialise writes to the shared WebSocket (concurrent sends are otherwise unsafe)
_ws_lock = asyncio.Lock()


async def _ws_send(ws: WebSocket, msg: dict) -> None:
    async with _ws_lock:
        await ws.send_text(json.dumps(msg))


# ── Application ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # On shutdown, unblock any requests still waiting
    for fut in list(_pending.values()):
        if not fut.done():
            fut.set_exception(RuntimeError("Server shutting down"))
    for q in list(_queues.values()):
        await q.put(None)


app = FastAPI(
    title="GROBID Trainer Relay",
    description="WebSocket reverse-tunnel relay for GROBID training on HPC.",
    lifespan=lifespan,
)

RELAY_TOKEN: str = os.environ.get("RELAY_TOKEN", "")


# ── WebSocket tunnel endpoint ─────────────────────────────────────────────────

@app.websocket("/tunnel")
async def tunnel_endpoint(ws: WebSocket):
    global _tunnel_ws, _tunnel_connected_at

    # Auth: accept the connection first so we can send a close frame with a reason
    token = ws.query_params.get("token") or ws.headers.get("x-tunnel-token", "")
    if RELAY_TOKEN and token != RELAY_TOKEN:
        await ws.close(code=4403, reason="Unauthorized")
        return

    await ws.accept()
    _tunnel_ws = ws
    _tunnel_connected_at = time.monotonic()
    print(f"[relay] Tunnel connected from {ws.client}", flush=True)

    try:
        async for raw in ws.iter_text():
            msg: dict = json.loads(raw)
            req_id: str = msg.get("id", "")
            msg_type = msg.get("type")

            if msg_type == "response":
                # Complete non-streaming request
                fut = _pending.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_result(msg)

            elif msg_type == "response_start":
                # First frame of a streaming response: create queue, resolve future
                q = asyncio.Queue[Optional[str]]()
                _queues[req_id] = q
                fut = _pending.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_result({**msg, "_queue": q})

            elif msg_type == "response_chunk":
                q = _queues.get(req_id)
                if q:
                    await q.put(msg.get("chunk_b64", ""))

            elif msg_type == "response_end":
                q = _queues.pop(req_id, None)
                if q:
                    await q.put(None)  # sentinel → generator stops

    except WebSocketDisconnect:
        pass
    finally:
        _tunnel_ws = None
        _tunnel_connected_at = None
        # Fail all in-flight requests so callers get a clean 503 rather than hanging
        for fut in list(_pending.values()):
            if not fut.done():
                fut.set_exception(RuntimeError("Tunnel disconnected"))
        _pending.clear()
        for q in list(_queues.values()):
            await q.put(None)
        _queues.clear()
        print("[relay] Tunnel disconnected", flush=True)


@app.get("/tunnel/status", tags=["Relay management"])
async def tunnel_status():
    """Return whether an HPC tunnel is currently connected."""
    if _tunnel_ws is None:
        return {"connected": False}
    uptime = time.monotonic() - _tunnel_connected_at if _tunnel_connected_at else 0
    return {"connected": True, "uptime_s": round(uptime, 1)}


# ── HTTP proxy ────────────────────────────────────────────────────────────────

# Hop-by-hop headers that must not be forwarded
_HOP_BY_HOP = frozenset({
    "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "upgrade",
})


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"])
async def proxy(request: Request, path: str):
    """Forward any HTTP request through the WebSocket tunnel to the trainer service."""
    if _tunnel_ws is None:
        raise HTTPException(503, detail="No tunnel connected — HPC container is not running")

    body = await request.body()
    req_id = str(uuid.uuid4())[:8]

    loop = asyncio.get_running_loop()
    fut: asyncio.Future[dict] = loop.create_future()
    _pending[req_id] = fut

    envelope = {
        "id":       req_id,
        "method":   request.method,
        "path":     "/" + path,
        "query":    str(request.url.query),
        "headers":  dict(request.headers),
        "body_b64": base64.b64encode(body).decode(),
    }

    try:
        await _ws_send(_tunnel_ws, envelope)
    except Exception as exc:
        _pending.pop(req_id, None)
        raise HTTPException(503, detail=f"Failed to send request through tunnel: {exc}")

    try:
        # Wait up to 5 minutes for the initial response (headers); streaming then
        # continues until the queue drains, so long training jobs are fine.
        result: dict = await asyncio.wait_for(fut, timeout=300.0)
    except asyncio.TimeoutError:
        _pending.pop(req_id, None)
        raise HTTPException(504, detail="Tunnel request timed out (no response within 5 min)")
    except RuntimeError as exc:
        raise HTTPException(503, detail=str(exc))

    status = result["status"]
    headers = {
        k: v for k, v in result.get("headers", {}).items()
        if k.lower() not in _HOP_BY_HOP
    }

    if "_queue" in result:
        # ── Streaming (SSE) response ──────────────────────────────────────────
        q: asyncio.Queue[Optional[str]] = result["_queue"]

        async def generate():
            while True:
                chunk_b64 = await q.get()
                if chunk_b64 is None:   # end-of-stream sentinel
                    return
                yield base64.b64decode(chunk_b64)

        return StreamingResponse(generate(), status_code=status, headers=headers)

    else:
        # ── Buffered response ─────────────────────────────────────────────────
        body_out = base64.b64decode(result.get("body_b64", ""))
        return Response(content=body_out, status_code=status, headers=headers)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="GROBID Trainer Relay Server")
    parser.add_argument("--host",  default="0.0.0.0",                        help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port",  type=int, default=8080,                    help="Bind port (default: 8080)")
    parser.add_argument("--token", default=os.environ.get("RELAY_TOKEN", ""), help="Shared secret for tunnel auth")
    args = parser.parse_args()

    if args.token:
        RELAY_TOKEN = args.token
        os.environ["RELAY_TOKEN"] = args.token
        print("[relay] Token auth enabled", flush=True)
    else:
        print("[relay] WARNING: No token set — tunnel is unauthenticated", flush=True)

    print(f"[relay] Listening on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port)
