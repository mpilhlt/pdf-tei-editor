"""
Unit tests for recognizing rate limits and exhausted quotas of LLM services.

@testCovers fastapi_app/lib/llm/rate_limit.py
@testCovers fastapi_app/lib/extraction/http_utils.py
"""

import unittest
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import MagicMock, patch

import requests

from fastapi_app.lib.extraction.http_utils import get_retry_session
from fastapi_app.lib.llm.base import LLMProviderError
from fastapi_app.lib.llm.openai_compatible import get_completion_session
from fastapi_app.lib.llm.rate_limit import (
    LLMRateLimitError,
    RateLimitTracker,
    capture_rate_limit_headers,
    parse_wait_seconds,
    post_completion,
    rate_limit_http_error,
)
from fastapi_app.routers.document_rules import _llm_request_error

NOW = datetime(2026, 11, 9, 12, 0, 0, tzinfo=timezone.utc)
URL = "https://example.com/v1"


def response(status: int, headers: dict[str, str] | None = None) -> MagicMock:
    """A mocked HTTP response with the given status and headers."""
    result = MagicMock()
    result.status_code = status
    result.headers = headers or {}
    return result


def session_returning(responses: Sequence[MagicMock]) -> MagicMock:
    """A mocked session whose post() returns the given responses in order."""
    session = MagicMock()
    session.post.side_effect = list(responses)
    return session


class TestCaptureHeaders(unittest.TestCase):
    def test_keeps_only_rate_limit_headers_with_lowercase_names(self):
        captured = capture_rate_limit_headers(
            {
                "X-RateLimit-Remaining-Minute": "4",
                "RateLimit-Reset": "30",
                "Retry-After": "5",
                "anthropic-ratelimit-requests-remaining": "9",
                "Authorization": "Bearer secret",
                "Set-Cookie": "session=secret",
                "Content-Type": "application/json",
            }
        )
        self.assertEqual(
            captured,
            {
                "x-ratelimit-remaining-minute": "4",
                "ratelimit-reset": "30",
                "retry-after": "5",
                "anthropic-ratelimit-requests-remaining": "9",
            },
        )


class TestParseWaitSeconds(unittest.TestCase):
    def test_retry_after_in_seconds(self):
        self.assertEqual(parse_wait_seconds({"Retry-After": "30"}, NOW), 30.0)

    def test_retry_after_as_http_date(self):
        self.assertEqual(parse_wait_seconds({"Retry-After": "Mon, 09 Nov 2026 12:02:00 GMT"}, NOW), 120.0)

    def test_retry_after_takes_precedence(self):
        self.assertEqual(parse_wait_seconds({"RateLimit-Reset": "50", "Retry-After": "5"}, NOW), 5.0)

    def test_ratelimit_reset_seconds(self):
        self.assertEqual(parse_wait_seconds({"RateLimit-Reset": "45"}, NOW), 45.0)

    def test_x_ratelimit_reset_minute(self):
        self.assertEqual(parse_wait_seconds({"X-RateLimit-Reset-Minute": "12"}, NOW), 12.0)

    def test_unix_timestamp(self):
        self.assertEqual(parse_wait_seconds({"RateLimit-Reset": str(int(NOW.timestamp()) + 90)}, NOW), 90.0)

    def test_iso_timestamp(self):
        self.assertEqual(parse_wait_seconds({"Retry-After": "2026-11-09T12:01:00Z"}, NOW), 60.0)

    def test_past_date_means_no_wait(self):
        self.assertEqual(parse_wait_seconds({"Retry-After": "Mon, 09 Nov 2026 11:00:00 GMT"}, NOW), 0.0)

    def test_negative_seconds_mean_no_wait(self):
        self.assertEqual(parse_wait_seconds({"Retry-After": "-5"}, NOW), 0.0)

    def test_malformed_value_falls_through_to_next_header(self):
        self.assertEqual(parse_wait_seconds({"Retry-After": "soon", "RateLimit-Reset": "20"}, NOW), 20.0)

    def test_infinite_value_is_ignored(self):
        self.assertIsNone(parse_wait_seconds({"Retry-After": "inf"}, NOW))

    def test_no_timing_information(self):
        self.assertIsNone(parse_wait_seconds({"Content-Type": "application/json"}, NOW))


class TestRateLimitTracker(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.tracker = RateLimitTracker(now=lambda: self.now)

    def test_limited_until_the_given_time(self):
        until = NOW + timedelta(minutes=5)
        self.tracker.mark_limited(URL, "key", "model", until)
        self.assertEqual(self.tracker.limited_until(URL, "key", "model"), until)

    def test_limit_expires(self):
        self.tracker.mark_limited(URL, "key", "model", NOW + timedelta(minutes=5))
        self.now = NOW + timedelta(minutes=5, seconds=1)
        self.assertIsNone(self.tracker.limited_until(URL, "key", "model"))

    def test_state_is_separate_per_key_model_and_endpoint(self):
        self.tracker.mark_limited(URL, "key", "model", NOW + timedelta(minutes=5))
        self.assertIsNone(self.tracker.limited_until(URL, "other-key", "model"))
        self.assertIsNone(self.tracker.limited_until(URL, "key", "other-model"))
        self.assertIsNone(self.tracker.limited_until("https://other.example/v1", "key", "model"))

    def test_api_key_is_not_stored(self):
        self.tracker.mark_limited(URL, "very-secret-key", "model", NOW + timedelta(minutes=5))
        self.tracker.record_headers(URL, "very-secret-key", "model", {"Retry-After": "1"})
        self.assertNotIn("very-secret-key", repr(vars(self.tracker)))

    def test_records_last_headers(self):
        self.tracker.record_headers(URL, "key", "model", {"X-RateLimit-Remaining-Minute": "4"})
        self.tracker.record_headers(URL, "key", "model", {"X-RateLimit-Remaining-Minute": "3"})
        self.assertEqual(self.tracker.last_headers(URL, "key", "model"), {"x-ratelimit-remaining-minute": "3"})

    def test_headers_of_a_response_without_any_do_not_erase_the_last_ones(self):
        self.tracker.record_headers(URL, "key", "model", {"X-RateLimit-Remaining-Minute": "4"})
        self.tracker.record_headers(URL, "key", "model", {})
        self.assertEqual(self.tracker.last_headers(URL, "key", "model"), {"x-ratelimit-remaining-minute": "4"})

    def test_reports_headers_of_an_endpoint_once(self):
        with self.assertLogs("fastapi_app.lib.llm.rate_limit", level="INFO") as logs:
            self.tracker.record_headers(URL, "key", "model", {"X-RateLimit-Remaining-Minute": "4"})
            self.tracker.record_headers(URL, "key", "model", {"X-RateLimit-Remaining-Minute": "3"})
        self.assertEqual(len(logs.records), 1)
        self.assertIn("x-ratelimit-remaining-minute", logs.output[0])


class TestPostCompletion(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.tracker = RateLimitTracker(now=lambda: self.now)

    def post(self, session: MagicMock) -> MagicMock:
        return post_completion(session, f"{URL}/chat/completions", endpoint=URL, api_key="key", model_id="model", tracker=self.tracker, json={"a": 1}, timeout=10)

    def test_returns_response_and_passes_arguments(self):
        ok = response(200)
        session = session_returning([ok])
        self.assertIs(self.post(session), ok)
        session.post.assert_called_once_with(f"{URL}/chat/completions", json={"a": 1}, timeout=10)

    @patch("fastapi_app.lib.llm.rate_limit.time.sleep")
    def test_short_wait_is_retried_after_exactly_that_time(self, sleep):
        ok = response(200)
        session = session_returning([response(429, {"Retry-After": "7"}), ok])
        self.assertIs(self.post(session), ok)
        sleep.assert_called_once_with(7.0)
        self.assertIsNone(self.tracker.limited_until(URL, "key", "model"))

    @patch("fastapi_app.lib.llm.rate_limit.time.sleep")
    def test_long_wait_raises_at_once_and_is_remembered(self, sleep):
        session = session_returning([response(429, {"Retry-After": "3600"})])
        with self.assertRaises(LLMRateLimitError) as raised:
            self.post(session)
        expected = NOW + timedelta(hours=1)
        self.assertEqual(raised.exception.available_at, expected)
        self.assertEqual(self.tracker.limited_until(URL, "key", "model"), expected)
        self.assertEqual(session.post.call_count, 1)
        sleep.assert_not_called()

    @patch("fastapi_app.lib.llm.rate_limit.time.sleep")
    def test_missing_timing_is_limited_for_the_default_period(self, sleep):
        session = session_returning([response(429)])
        with self.assertRaises(LLMRateLimitError) as raised:
            self.post(session)
        self.assertEqual(raised.exception.available_at, NOW + timedelta(seconds=60))
        self.assertEqual(session.post.call_count, 1)
        sleep.assert_not_called()

    @patch("fastapi_app.lib.llm.rate_limit.time.sleep")
    def test_short_waits_are_bounded(self, sleep):
        session = session_returning([response(429, {"Retry-After": "1"}) for _ in range(3)])
        with self.assertRaises(LLMRateLimitError) as raised:
            self.post(session)
        self.assertEqual(session.post.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(raised.exception.available_at, NOW + timedelta(seconds=60))

    def test_limited_key_makes_no_request(self):
        until = NOW + timedelta(minutes=5)
        self.tracker.mark_limited(URL, "key", "model", until)
        session = session_returning([])
        with self.assertRaises(LLMRateLimitError) as raised:
            self.post(session)
        self.assertEqual(raised.exception.available_at, until)
        session.post.assert_not_called()

    def test_requests_resume_after_the_limit(self):
        self.tracker.mark_limited(URL, "key", "model", NOW + timedelta(minutes=5))
        self.now = NOW + timedelta(minutes=6)
        ok = response(200)
        self.assertIs(self.post(session_returning([ok])), ok)

    def test_other_errors_are_returned_unchanged(self):
        unauthorized = response(401)
        self.assertIs(self.post(session_returning([unauthorized])), unauthorized)
        self.assertIsNone(self.tracker.limited_until(URL, "key", "model"))

    def test_error_message_does_not_contain_the_key(self):
        session = session_returning([response(429, {"Retry-After": "3600"})])
        with self.assertRaises(LLMRateLimitError) as raised:
            post_completion(session, f"{URL}/chat/completions", endpoint=URL, api_key="very-secret-key", model_id="model", tracker=self.tracker)
        self.assertNotIn("very-secret-key", str(raised.exception))
        self.assertIn("model", str(raised.exception))


class TestLLMRateLimitError(unittest.TestCase):
    def test_is_a_provider_error(self):
        self.assertIsInstance(LLMRateLimitError("limited"), LLMProviderError)

    def test_available_at_is_optional(self):
        self.assertIsNone(LLMRateLimitError("limited").available_at)


class TestRateLimitHttpError(unittest.TestCase):
    def test_429_with_retry_after(self):
        error = LLMRateLimitError("limited", available_at=NOW + timedelta(seconds=90))
        with patch("fastapi_app.lib.llm.rate_limit.utc_now", return_value=NOW):
            result = rate_limit_http_error(error)
        self.assertEqual(result.status_code, 429)
        self.assertEqual(result.detail, "limited")
        self.assertEqual(result.headers, {"Retry-After": "90"})

    def test_partial_seconds_round_up(self):
        error = LLMRateLimitError("limited", available_at=NOW + timedelta(seconds=1, milliseconds=100))
        with patch("fastapi_app.lib.llm.rate_limit.utc_now", return_value=NOW):
            self.assertEqual(rate_limit_http_error(error).headers, {"Retry-After": "2"})

    def test_unknown_time_has_no_header(self):
        self.assertIsNone(rate_limit_http_error(LLMRateLimitError("limited")).headers)


class TestRetrySessionOptions(unittest.TestCase):
    @staticmethod
    def retry_of(session):
        return session.get_adapter("https://example.com").max_retries

    def test_respects_retry_after_by_default(self):
        self.assertTrue(self.retry_of(get_retry_session()).respect_retry_after_header)

    def test_retry_after_can_be_ignored(self):
        self.assertFalse(self.retry_of(get_retry_session(respect_retry_after=False)).respect_retry_after_header)


class TestRequestErrorOfDocumentRules(unittest.TestCase):
    def test_rate_limit_is_429(self):
        with self.assertLogs("fastapi_app.routers.document_rules", level="WARNING"):
            self.assertEqual(_llm_request_error("p", LLMRateLimitError("limited")).status_code, 429)

    def test_other_errors_stay_502(self):
        with self.assertLogs("fastapi_app.routers.document_rules", level="WARNING"):
            self.assertEqual(_llm_request_error("p", LLMProviderError("failed")).status_code, 502)


class TestCompletionSessionOverHttp(unittest.TestCase):
    """The session and post_completion against a real HTTP server, so that urllib3's actual retry behaviour is covered."""

    def setUp(self):
        self.statuses: list[tuple[int, dict[str, str]]] = []
        self.requests_received = 0
        test = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                test.requests_received += 1
                status, headers = test.statuses.pop(0)
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"
        self.tracker = RateLimitTracker()

    def post(self) -> requests.Response:
        session = get_completion_session(retries=2, backoff_factor=0.0)
        return post_completion(session, f"{self.endpoint}/chat/completions", endpoint=self.endpoint, api_key="key", model_id="model", tracker=self.tracker, json={}, timeout=10)

    def test_429_with_long_retry_after_is_requested_once(self):
        self.statuses = [(429, {"Retry-After": "3600"})]
        with self.assertRaises(LLMRateLimitError):
            self.post()
        self.assertEqual(self.requests_received, 1)

    def test_503_with_long_retry_after_does_not_block(self):
        self.statuses = [(503, {"Retry-After": "3600"}), (200, {})]
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.requests_received, 2)

    def test_500_is_retried_by_the_session(self):
        self.statuses = [(500, {}), (200, {})]
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.requests_received, 2)


if __name__ == "__main__":
    unittest.main()
