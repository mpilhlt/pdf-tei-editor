"""
Limits failed login attempts (password and access-token logins).

After ``auth.login.max-failures`` failed attempts for the same key within
``auth.login.failure-window`` seconds, further attempts with that key are refused with HTTP 429
until the oldest failure leaves the window. Password logins are keyed by client IP and username, so
that clients behind a shared reverse-proxy address do not lock each other out; token logins are keyed
by client IP.

The counters are kept in memory per server process.
"""

import threading
import time
from collections import deque

from fastapi import HTTPException, Request

DEFAULT_MAX_FAILURES = 10
DEFAULT_WINDOW_SECONDS = 300


class LoginRateLimiter:
    """Thread-safe sliding-window counter of failed attempts per key."""

    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float, window: float) -> deque[float]:
        entries = self._failures.get(key)
        if entries is None:
            return deque()
        while entries and entries[0] <= now - window:
            entries.popleft()
        if not entries:
            del self._failures[key]
        return entries

    def retry_after(self, key: str, max_failures: int, window: float) -> int | None:
        """
        Seconds until the key may try again, or None if it is not blocked.

        Args:
            key: The client key
            max_failures: Failures allowed within the window
            window: Window length in seconds
        """
        now = time.time()
        with self._lock:
            entries = self._prune(key, now, window)
            if len(entries) < max_failures:
                return None
            return max(1, int(entries[0] + window - now) + 1)

    def record_failure(self, key: str) -> None:
        """Count a failed attempt."""
        with self._lock:
            self._failures.setdefault(key, deque()).append(time.time())

    def reset(self, key: str) -> None:
        """Forget the failures of a key (after a successful login)."""
        with self._lock:
            self._failures.pop(key, None)

    def clear(self) -> None:
        """Forget all failures (for tests)."""
        with self._lock:
            self._failures.clear()


login_rate_limiter = LoginRateLimiter()


def client_ip(request: Request) -> str:
    """The client address of a request (as resolved by uvicorn, including trusted proxy headers)."""
    return request.client.host if request.client else "unknown"


def _limits() -> tuple[int, float]:
    from fastapi_app.lib.utils.config_utils import get_config

    config = get_config()
    max_failures = int(config.get("auth.login.max-failures", default=DEFAULT_MAX_FAILURES))
    window = float(config.get("auth.login.failure-window", default=DEFAULT_WINDOW_SECONDS))
    return max_failures, window


def check_login_allowed(key: str) -> None:
    """
    Raise HTTP 429 if the key has too many recent failures.

    A ``max-failures`` of 0 or less disables the limit.
    """
    max_failures, window = _limits()
    if max_failures <= 0:
        return
    retry_after = login_rate_limiter.retry_after(key, max_failures, window)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts, try again later",
            headers={"Retry-After": str(retry_after)},
        )
