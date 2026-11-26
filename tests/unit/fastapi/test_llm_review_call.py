"""
Unit tests for the shared LLM review call (retry on all-dropped results) and error mapping.

@testCovers fastapi_app/lib/llm/review_call.py
@testCovers fastapi_app/lib/llm/http_errors.py
"""

import asyncio
import unittest
from datetime import datetime, timezone

import requests
from fastapi import HTTPException

from fastapi_app.lib.llm.base import LLMProvider, LLMProviderError
from fastapi_app.lib.llm.http_errors import llm_http_error
from fastapi_app.lib.llm.json_response import UnusableResponseError
from fastapi_app.lib.llm.model_access import ModelAccessDenied
from fastapi_app.lib.llm.rate_limit import LLMRateLimitError
from fastapi_app.lib.llm.review_call import complete_with_retry

LOGGER = "fastapi_app.lib.llm.review_call"


class FakeProvider:
    """Returns queued responses and records the user prompts."""

    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.user_prompts: list[str] = []

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.user_prompts.append(user_prompt)
        return self.responses.pop(0)


def parse(raw: str) -> tuple[list[str], list[str]]:
    if raw == "unusable":
        raise UnusableResponseError("unusable")
    parts = [p for p in raw.split(",") if p]
    return [p for p in parts if p.startswith("ok")], [p for p in parts if p.startswith("bad")]


def note(dropped: list[str]) -> str:
    return "\nRETRY " + ";".join(dropped)


def run(provider: FakeProvider) -> tuple[list[str], list[str]]:
    fake: LLMProvider = provider  # type: ignore[assignment]
    return asyncio.run(complete_with_retry(fake, "m", "sys", "user", parse, note, "test"))


class TestCompleteWithRetry(unittest.TestCase):
    def test_no_retry_when_kept(self):
        provider = FakeProvider(["ok1,bad1"])
        self.assertEqual(run(provider), (["ok1"], ["bad1"]))
        self.assertEqual(provider.user_prompts, ["user"])

    def test_no_retry_when_nothing_dropped(self):
        provider = FakeProvider([""])
        self.assertEqual(run(provider), ([], []))
        self.assertEqual(len(provider.user_prompts), 1)

    def test_retry_once_when_all_dropped(self):
        provider = FakeProvider(["bad1,bad2", "ok3"])
        self.assertEqual(run(provider), (["ok3"], []))
        self.assertEqual(len(provider.user_prompts), 2)
        self.assertTrue(provider.user_prompts[1].endswith("\nRETRY bad1;bad2"))

    def test_unusable_retry_keeps_first_result(self):
        provider = FakeProvider(["bad1", "unusable"])
        with self.assertLogs(LOGGER, level="WARNING"):
            self.assertEqual(run(provider), ([], ["bad1"]))

    def test_unusable_first_response_raises(self):
        provider = FakeProvider(["unusable"])
        with self.assertRaises(UnusableResponseError):
            run(provider)


class TestLlmHttpError(unittest.TestCase):
    def test_model_access_denied(self):
        result = llm_http_error(ModelAccessDenied("no"), "p")
        assert result is not None
        self.assertEqual(result.status_code, 403)

    def test_unusable_response(self):
        result = llm_http_error(UnusableResponseError("x"), "p")
        assert result is not None
        self.assertEqual(result.status_code, 502)

    def test_rate_limit(self):
        result = llm_http_error(LLMRateLimitError("limit", available_at=datetime.now(timezone.utc)), "p")
        self.assertIsInstance(result, HTTPException)
        assert result is not None
        self.assertEqual(result.status_code, 429)

    def test_provider_error(self):
        with self.assertLogs("fastapi_app.lib.llm.http_errors", level="WARNING"):
            result = llm_http_error(LLMProviderError("boom"), "p")
        assert result is not None
        self.assertEqual(result.status_code, 502)
        self.assertEqual(result.detail, "LLM provider request failed: boom")

    def test_request_exception_uses_provider_message(self):
        response = requests.Response()
        response.status_code = 400
        response._content = b'{"error": {"message": "bad model"}}'
        with self.assertLogs("fastapi_app.lib.llm.http_errors", level="WARNING"):
            result = llm_http_error(requests.HTTPError("400", response=response), "p")
        assert result is not None
        self.assertEqual(result.status_code, 502)
        self.assertEqual(result.detail, "LLM provider request failed: bad model")

    def test_other_error_is_not_mapped(self):
        self.assertIsNone(llm_http_error(ValueError("x"), "p"))
