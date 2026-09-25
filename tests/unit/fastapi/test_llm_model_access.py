"""
Unit tests for LLM model access authorization.

@testCovers fastapi_app/lib/llm/model_access.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.llm import LLMModel, LLMProvider
from fastapi_app.lib.llm.model_access import ModelAccessDenied, check_model_access

ADMIN = {"username": "a", "roles": ["admin"]}
USER = {"username": "u", "roles": ["user"]}


class _Provider(LLMProvider):
    id = "prov"
    label = "Prov"

    def __init__(self):
        self.list_calls = 0

    def list_models(self) -> list[LLMModel]:
        self.list_calls += 1
        return [
            LLMModel(id="free", label="Free One", capabilities=frozenset({"chat"}), status=None, free=True),
            LLMModel(id="paid", label="Paid One", capabilities=frozenset({"chat"}), status=None, free=False),
        ]

    async def chat_completion(self, *a, **k) -> str:
        return ""


@mock.patch("fastapi_app.lib.llm.model_access.is_default_model", return_value=False)
@mock.patch("fastapi_app.lib.llm.model_access.has_model_filter", return_value=False)
class TestCheckModelAccess(unittest.TestCase):
    def test_admin_without_filter_is_allowed_without_listing(self, _f, _d):
        provider = _Provider()
        check_model_access(provider, "anything", ADMIN)
        self.assertEqual(provider.list_calls, 0)

    def test_user_may_use_free_model(self, _f, _d):
        check_model_access(_Provider(), "free", USER)

    def test_user_may_not_use_paid_model(self, _f, _d):
        with self.assertRaisesRegex(ModelAccessDenied, "not free"):
            check_model_access(_Provider(), "paid", USER)

    def test_user_may_not_use_unlisted_model(self, _f, _d):
        with self.assertRaises(ModelAccessDenied):
            check_model_access(_Provider(), "ghost", USER)

    def test_user_may_use_paid_model_that_is_the_default(self, _f, mock_default):
        mock_default.return_value = True
        check_model_access(_Provider(), "paid", USER)

    def test_admin_may_use_paid_model_when_filter_allows_it(self, mock_filter, _d):
        mock_filter.return_value = True
        with mock.patch("fastapi_app.lib.llm.model_access.is_model_allowed", return_value=True):
            check_model_access(_Provider(), "paid", ADMIN)

    def test_filter_applies_to_admins(self, mock_filter, _d):
        mock_filter.return_value = True
        with mock.patch("fastapi_app.lib.llm.model_access.is_model_allowed", return_value=False) as allowed:
            with self.assertRaisesRegex(ModelAccessDenied, "model filter"):
                check_model_access(_Provider(), "paid", ADMIN)
        allowed.assert_called_once_with("Prov/Paid One")

    def test_unlisted_model_is_denied_when_a_filter_is_active(self, mock_filter, _d):
        mock_filter.return_value = True
        with self.assertRaisesRegex(ModelAccessDenied, "model filter"):
            check_model_access(_Provider(), "ghost", ADMIN)


if __name__ == "__main__":
    unittest.main()
