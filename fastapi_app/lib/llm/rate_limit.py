"""
Recognizing rate limits and exhausted quotas of LLM services.

A 429 with a short announced wait is waited out. Any other 429 raises LLMRateLimitError at once, and
the key is remembered as limited, so that further requests fail without calling the service until
it accepts requests again. State is held per endpoint, API key and model, in memory: after a restart
or in another worker process, the limit is learned again from the next 429.
"""

import hashlib
import logging
import math
import threading
import time
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import requests
from fastapi import HTTPException

from .base import LLMProviderError

logger = logging.getLogger(__name__)

#: Longest announced wait that a request waits out instead of failing
MAX_SHORT_WAIT_SECONDS = 60.0
#: How long a key counts as limited when the service gave no usable time
DEFAULT_LIMITED_SECONDS = 60.0
#: Attempts of one request, while the service announces short waits
MAX_ATTEMPTS = 3

# Headers announcing the wait, in order of preference
_WAIT_HEADERS = ("retry-after", "ratelimit-reset", "x-ratelimit-reset-minute")
# Numbers from this size on are unix timestamps, not durations in seconds
_MIN_UNIX_TIMESTAMP = 1_000_000_000


def utc_now() -> datetime:
    """The current time, in UTC."""
    return datetime.now(timezone.utc)


class LLMRateLimitError(LLMProviderError):
    """The service does not accept requests for now; `available_at` is when to try again, if known."""

    def __init__(self, message: str, available_at: datetime | None = None):
        super().__init__(message)
        self.available_at = available_at


def capture_rate_limit_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """The rate-limit headers of a response, with lowercase names.

    Retry-After is standard; `ratelimit` in the name covers the draft standard and vendor forms (x-ratelimit-*, anthropic-ratelimit-*).
    Only these are kept, so that credentials cannot end up in the state or in logs.
    """
    return {name.lower(): value for name, value in headers.items() if name.lower() == "retry-after" or "ratelimit" in name.lower()}


def _parse_date(text: str) -> datetime | None:
    """An ISO 8601 or HTTP date, or None. A date without time zone is taken as UTC."""
    for parse in (lambda: datetime.fromisoformat(text.replace("Z", "+00:00")), lambda: parsedate_to_datetime(text)):
        try:
            parsed = parse()
        except (ValueError, TypeError):
            continue
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _seconds_until(value: str, now: datetime) -> float | None:
    """The seconds a header value asks to wait, or None if it cannot be read."""
    text = value.strip()
    try:
        number = float(text)
    except ValueError:
        date = _parse_date(text)
        return None if date is None else max(0.0, (date - now).total_seconds())
    if not math.isfinite(number):
        return None
    return max(0.0, number - now.timestamp() if number >= _MIN_UNIX_TIMESTAMP else number)


def parse_wait_seconds(headers: Mapping[str, str], now: datetime) -> float | None:
    """The seconds a response asks to wait, or None if it does not say."""
    captured = capture_rate_limit_headers(headers)
    for name in _WAIT_HEADERS:
        if name in captured:
            seconds = _seconds_until(captured[name], now)
            if seconds is not None:
                return seconds
    return None


class RateLimitTracker:
    """Which keys are limited until when, and the last rate-limit headers seen. Thread-safe."""

    def __init__(self, now: Callable[[], datetime] = utc_now):
        self._now = now
        self._lock = threading.Lock()
        self._limited: dict[tuple[str, str, str], datetime] = {}
        self._headers: dict[tuple[str, str, str], dict[str, str]] = {}
        self._reported_endpoints: set[str] = set()

    @staticmethod
    def _key(endpoint: str, api_key: str | None, model_id: str) -> tuple[str, str, str]:
        return endpoint, hashlib.sha256((api_key or "").encode()).hexdigest()[:16], model_id

    def now(self) -> datetime:
        """The tracker's current time."""
        return self._now()

    def limited_until(self, endpoint: str, api_key: str | None, model_id: str) -> datetime | None:
        """Until when the key is limited, or None if it is not."""
        key = self._key(endpoint, api_key, model_id)
        with self._lock:
            until = self._limited.get(key)
            if until is not None and until <= self._now():
                del self._limited[key]
                return None
            return until

    def mark_limited(self, endpoint: str, api_key: str | None, model_id: str, until: datetime) -> None:
        """Remember that the key is limited until the given time."""
        with self._lock:
            self._limited[self._key(endpoint, api_key, model_id)] = until

    def record_headers(self, endpoint: str, api_key: str | None, model_id: str, headers: Mapping[str, str]) -> None:
        """Keep the rate-limit headers of a response. What an endpoint sends is logged once."""
        captured = capture_rate_limit_headers(headers)
        with self._lock:
            first_seen = endpoint not in self._reported_endpoints
            self._reported_endpoints.add(endpoint)
            if captured:
                self._headers[self._key(endpoint, api_key, model_id)] = captured
        if first_seen:
            logger.info(f"Rate-limit headers of {endpoint}: {captured or 'none'}")

    def last_headers(self, endpoint: str, api_key: str | None, model_id: str) -> dict[str, str]:
        """The rate-limit headers last seen for the key."""
        with self._lock:
            return dict(self._headers.get(self._key(endpoint, api_key, model_id), {}))


_tracker = RateLimitTracker()


def get_rate_limit_tracker() -> RateLimitTracker:
    """The tracker shared by all LLM requests of this process."""
    return _tracker


def post_completion(
    session: requests.Session,
    url: str,
    *,
    endpoint: str,
    api_key: str | None,
    model_id: str,
    tracker: RateLimitTracker | None = None,
    **request_args: Any,
) -> requests.Response:
    """POST a completion request and apply the rate-limit rules; any response other than a 429 is returned as is.

    The session must not retry 429 itself: build it with get_completion_session().

    Raises:
        LLMRateLimitError: if the key is limited, or the service asks for a long wait or gives no time.
    """
    tracker = tracker or _tracker

    def limit_error(until: datetime) -> LLMRateLimitError:
        return LLMRateLimitError(f"Rate limit or quota reached for model '{model_id}'; try again after {until:%Y-%m-%d %H:%M:%S} UTC", available_at=until)

    until = tracker.limited_until(endpoint, api_key, model_id)
    if until is not None:
        raise limit_error(until)

    wait: float | None = None
    for attempts_left in range(MAX_ATTEMPTS - 1, -1, -1):
        response = session.post(url, **request_args)
        tracker.record_headers(endpoint, api_key, model_id, response.headers)
        if response.status_code != 429:
            return response
        wait = parse_wait_seconds(response.headers, tracker.now())
        if wait is None or wait > MAX_SHORT_WAIT_SECONDS or attempts_left == 0:
            break
        logger.info(f"Rate limit for model '{model_id}': waiting {wait:.0f} s")
        time.sleep(wait)

    limited_seconds = wait if wait is not None and wait > MAX_SHORT_WAIT_SECONDS else DEFAULT_LIMITED_SECONDS
    until = tracker.now() + timedelta(seconds=limited_seconds)
    tracker.mark_limited(endpoint, api_key, model_id, until)
    logger.info(f"Rate limit for model '{model_id}' at {endpoint}: no requests until {until.isoformat()}; headers: {capture_rate_limit_headers(response.headers)}")
    raise limit_error(until)


def rate_limit_http_error(error: LLMRateLimitError) -> HTTPException:
    """The HTTP 429 for a rate-limited request, with Retry-After if the time is known."""
    headers = None
    if error.available_at is not None:
        headers = {"Retry-After": str(max(0, math.ceil((error.available_at - utc_now()).total_seconds())))}
    return HTTPException(status_code=429, detail=str(error), headers=headers)
