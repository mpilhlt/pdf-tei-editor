"""
Unit tests for LLM model access authorization.

@testCovers fastapi_app/lib/llm/model_access.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.llm import LLMModel, LLMProvider
from fastapi_app.lib.llm.model_access import ModelAccessDenied, check_model_access, is_free_model, reset_registration

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


@mock.patch("fastapi_app.lib.llm.model_access.is_free_model", side_effect=lambda provider, model: bool(model.get("free")))
@mock.patch("fastapi_app.lib.llm.model_access.is_default_model", return_value=False)
@mock.patch("fastapi_app.lib.llm.model_access.has_model_filter", return_value=False)
class TestCheckModelAccess(unittest.TestCase):
    def test_admin_without_filter_is_allowed_without_listing(self, _f, _d, _free):
        provider = _Provider()
        check_model_access(provider, "anything", ADMIN)
        self.assertEqual(provider.list_calls, 0)

    def test_user_may_use_free_model(self, _f, _d, _free):
        check_model_access(_Provider(), "free", USER)

    def test_user_may_not_use_paid_model(self, _f, _d, _free):
        with self.assertRaisesRegex(ModelAccessDenied, "not free"):
            check_model_access(_Provider(), "paid", USER)

    def test_user_may_not_use_unlisted_model(self, _f, _d, _free):
        with self.assertRaises(ModelAccessDenied):
            check_model_access(_Provider(), "ghost", USER)

    def test_user_may_use_paid_model_that_is_the_default(self, _f, mock_default, _free):
        mock_default.return_value = True
        check_model_access(_Provider(), "paid", USER)

    def test_user_may_use_paid_model_that_counts_as_free(self, _f, _d, mock_free):
        mock_free.side_effect = None
        mock_free.return_value = True
        check_model_access(_Provider(), "paid", USER)

    def test_admin_may_use_paid_model_when_filter_allows_it(self, mock_filter, _d, _free):
        mock_filter.return_value = True
        with mock.patch("fastapi_app.lib.llm.model_access.is_model_allowed", return_value=True):
            check_model_access(_Provider(), "paid", ADMIN)

    def test_filter_applies_to_admins(self, mock_filter, _d, _free):
        mock_filter.return_value = True
        with mock.patch("fastapi_app.lib.llm.model_access.is_model_allowed", return_value=False) as allowed:
            with self.assertRaisesRegex(ModelAccessDenied, "model filter"):
                check_model_access(_Provider(), "paid", ADMIN)
        allowed.assert_called_once_with("Prov/Paid One")

    def test_unlisted_model_is_denied_when_a_filter_is_active(self, mock_filter, _d, _free):
        mock_filter.return_value = True
        with self.assertRaisesRegex(ModelAccessDenied, "model filter"):
            check_model_access(_Provider(), "ghost", ADMIN)


class TestIsFreeModel(unittest.TestCase):
    def setUp(self):
        reset_registration()
        patcher = mock.patch("fastapi_app.lib.llm.model_access.get_plugin_config")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _is_free(self, model_id: str, patterns: str) -> bool:
        config = mock.Mock()
        config.get.return_value = patterns
        model = next(m for m in _Provider().list_models() if m["id"] == model_id)
        with mock.patch("fastapi_app.lib.llm.model_access.get_config", return_value=config):
            return is_free_model(_Provider(), model)

    def test_provider_flag(self):
        self.assertTrue(self._is_free("free", ""))
        self.assertFalse(self._is_free("paid", ""))

    def test_pattern_matches_provider_and_model_label(self):
        self.assertTrue(self._is_free("paid", '"^Prov/Paid"'))
        self.assertTrue(self._is_free("paid", "Paid One"))
        self.assertFalse(self._is_free("paid", '"^Other/"'))


if __name__ == "__main__":
    unittest.main()
