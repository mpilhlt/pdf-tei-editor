"""
Authentication of backend plugin pages without the session id in the URL.

The frontend opens a plugin page (in the result dialog's iframe or in a separate window) with a
single-use launch token instead of the session id: ``/api/plugins/<id>/view?launch=<token>``. The
token comes from ``POST /api/v1/plugins/launch-token``. :class:`PluginWindowAuthMiddleware`
exchanges it for an HttpOnly cookie scoped to ``/api/plugins/`` and redirects to the same URL
without the token, so the address bar, the browser history and the access logs never show the
session id.

All later requests of the page under ``/api/plugins/`` (fetch, EventSource, links, downloads, reload)
carry the cookie. For requests that bring no session id of their own (``X-Session-ID`` header or
legacy ``session_id`` query parameter), the middleware copies the cookie's session id into the
``X-Session-ID`` header, so plugin routes keep authenticating through the header and need no
changes.

The cookie belongs to the browser profile, not to a tab: the most recently opened plugin page
decides which session plugin pages without their own session id use.
"""

from http.cookies import CookieError, SimpleCookie
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from fastapi_app.lib.utils.logging_utils import get_logger

logger = get_logger(__name__)

PLUGIN_ROUTES_PREFIX = "/api/plugins/"
"""Path prefix of the backend plugin routes, and the path of the plugin session cookie"""

PLUGIN_SESSION_COOKIE = "pte_plugin_session"
"""Name of the cookie that authenticates plugin pages"""

LAUNCH_TOKEN_PARAM = "launch"
"""Query parameter that carries a launch token"""

LEGACY_SESSION_PARAM = "session_id"
"""Query parameter in which older frontends and plugins pass the session id"""

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# Values that plugin pages send when they read a session id from a URL that has none
_EMPTY_SESSION_VALUES = {"", "null", "undefined"}

_EXPIRED_LINK_HTML = (
    b"<!DOCTYPE html><html><head><meta charset='utf-8'><title>Link expired</title></head>"
    b"<body style='font-family: sans-serif; padding: 2em'>"
    b"<p>This link has expired or was already used. Open the window again from the application.</p>"
    b"</body></html>"
)


def build_plugin_session_cookie(session_id: str, secure: bool) -> str:
    """
    Build the ``Set-Cookie`` value of the plugin session cookie.

    Args:
        session_id: Session the cookie authenticates
        secure: Add the ``Secure`` attribute (request came in over HTTPS)

    Returns:
        Header value for ``Set-Cookie``
    """
    value = f"{PLUGIN_SESSION_COOKIE}={session_id}; Path={PLUGIN_ROUTES_PREFIX}; HttpOnly; SameSite=Strict"
    if secure:
        value += "; Secure"
    return value


def _headers_dict(scope: Scope) -> dict[str, str]:
    """Return the request headers as a dict with lowercase names (last value wins)."""
    return {name.decode("latin-1").lower(): value.decode("latin-1") for name, value in scope.get("headers", [])}


def _is_https(scope: Scope, headers: dict[str, str]) -> bool:
    """True if the client connected over HTTPS, directly or through a proxy."""
    forwarded_proto = headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return scope.get("scheme") == "https" or forwarded_proto == "https"


def _read_cookie(headers: dict[str, str], name: str) -> str | None:
    """Return the value of a request cookie, or None."""
    raw = headers.get("cookie")
    if not raw:
        return None
    try:
        cookie = SimpleCookie()
        cookie.load(raw)
    except CookieError:
        return None
    morsel = cookie.get(name)
    return morsel.value if morsel else None


def _origin_matches_host(headers: dict[str, str]) -> bool:
    """False if the request has an ``Origin`` header that names another host than the request's."""
    origin = headers.get("origin")
    if not origin:
        # SameSite=Strict already keeps the cookie out of cross-site requests
        return True
    host = headers.get("x-forwarded-host", "").split(",")[0].strip() or headers.get("host", "")
    return urlsplit(origin).netloc.lower() == host.lower()


async def _send_simple_response(send: Send, status: int, body: bytes, headers: list[tuple[bytes, bytes]]) -> None:
    """Send a complete response."""
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-length", str(len(body)).encode("latin-1")), *headers],
    })
    await send({"type": "http.response.body", "body": body})


class PluginWindowAuthMiddleware:
    """ASGI middleware that exchanges launch tokens for the plugin session cookie and applies the cookie."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(PLUGIN_ROUTES_PREFIX):
            await self.app(scope, receive, send)
            return

        headers = _headers_dict(scope)
        query = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
        query_keys = {key for key, _ in query}

        if LAUNCH_TOKEN_PARAM in query_keys and scope["method"] in ("GET", "HEAD"):
            await self._exchange_launch_token(scope, send, headers, query)
            return

        cookie_session = _read_cookie(headers, PLUGIN_SESSION_COOKIE)
        if cookie_session and not self._has_own_session(headers, query):
            if scope["method"] not in _SAFE_METHODS and not _origin_matches_host(headers):
                logger.warning(f"Rejected cross-origin {scope['method']} {scope['path']} authenticated by the plugin session cookie")
                await _send_simple_response(send, 403, b"Cross-origin request rejected", [(b"content-type", b"text/plain")])
                return
            scope = dict(scope)
            scope["headers"] = [
                (name, value) for name, value in scope.get("headers", []) if name.lower() != b"x-session-id"
            ] + [(b"x-session-id", cookie_session.encode("latin-1"))]

        await self.app(scope, receive, send)

    @staticmethod
    def _has_own_session(headers: dict[str, str], query: list[tuple[str, str]]) -> bool:
        """True if the request names a session itself, in the header or the legacy query parameter."""
        if headers.get("x-session-id", "").strip() not in _EMPTY_SESSION_VALUES:
            return True
        return any(key == LEGACY_SESSION_PARAM and value.strip() not in _EMPTY_SESSION_VALUES for key, value in query)

    async def _exchange_launch_token(
        self,
        scope: Scope,
        send: Send,
        headers: dict[str, str],
        query: list[tuple[str, str]],
    ) -> None:
        """Redeem the launch token, set the cookie and redirect to the URL without the token."""
        from fastapi_app.config import get_settings
        from fastapi_app.lib.core.dependencies import get_session_manager

        token = next(value for key, value in query if key == LAUNCH_TOKEN_PARAM)
        session_manager = get_session_manager()
        session_id = session_manager.consume_launch_token(token)
        if not session_id or not session_manager.is_session_valid(session_id, get_settings().session_timeout):
            await _send_simple_response(send, 401, _EXPIRED_LINK_HTML, [(b"content-type", b"text/html; charset=utf-8")])
            return
        session_manager.update_session_access_time(session_id)

        remaining = [(key, value) for key, value in query if key not in (LAUNCH_TOKEN_PARAM, LEGACY_SESSION_PARAM)]
        raw_path = scope.get("raw_path")
        location = raw_path.decode("latin-1") if raw_path else quote(scope["path"])
        if remaining:
            location += "?" + urlencode(remaining)

        cookie = build_plugin_session_cookie(session_id, _is_https(scope, headers))
        await _send_simple_response(send, 303, b"", [
            (b"location", location.encode("latin-1")),
            (b"set-cookie", cookie.encode("latin-1")),
            (b"cache-control", b"no-store"),
            (b"referrer-policy", b"no-referrer"),
        ])
