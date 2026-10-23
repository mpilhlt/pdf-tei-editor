"""
Unit tests for LLM providers that use per-user API keys when no shared key is configured.

@testCovers fastapi_app/lib/llm/registry.py
@testCovers fastapi_app/routers/llm.py
"""

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.lib.llm.openai_compatible import OpenAICompatibleProvider
from fastapi_app.lib.secrets import MissingSecretError, SecretServiceRegistry, register_secret_service, secret_required_detail
from fastapi_app.routers import llm as llm_router

USER = {"username": "alice", "roles": ["user"]}


def make_provider(api_key: str | None) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        id="test", label="Test", base_url="https://example.invalid/v1", api_key=api_key, secret_service="test-svc"
    )


class TestPerUserProviderKeys(unittest.TestCase):
    def setUp(self):
        LLMProviderRegistry.reset_instance()
        SecretServiceRegistry.clear()
        register_secret_service("test-svc", "Test Service", "Used for tests", "https://example.invalid/keys")

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        SecretServiceRegistry.clear()

    def test_provider_without_shared_key_stays_available(self):
        provider = make_provider(None)
        self.assertTrue(provider.is_available())
        self.assertFalse(provider.has_shared_key())

    def test_shared_key_is_used_for_everyone(self):
        registry = LLMProviderRegistry.get_instance()
        shared = make_provider("shared")
        registry.register(shared)
        with patch("fastapi_app.lib.llm.registry.require_user_secret") as lookup:
            self.assertIs(registry.get_provider_for_user("test", "alice"), shared)
            lookup.assert_not_called()
        self.assertFalse(shared.uses_user_key)

    def test_user_key_is_used_without_shared_key(self):
        registry = LLMProviderRegistry.get_instance()
        registry.register(make_provider(None))
        with patch("fastapi_app.lib.llm.registry.require_user_secret", return_value="user-key") as lookup:
            resolved = registry.get_provider_for_user("test", "alice")
        lookup.assert_called_once_with("alice", "test-svc")
        self.assertTrue(resolved.has_shared_key())
        assert isinstance(resolved, OpenAICompatibleProvider)
        self.assertEqual(resolved._api_key, "user-key")
        self.assertEqual(resolved.id, "test")
        self.assertTrue(resolved.uses_user_key)
        # the registered provider stays keyless and unmarked
        self.assertFalse(registry.get_provider("test").has_shared_key())
        self.assertFalse(registry.get_provider("test").uses_user_key)

    def test_missing_user_key_raises(self):
        registry = LLMProviderRegistry.get_instance()
        registry.register(make_provider(None))
        with patch("fastapi_app.lib.llm.registry.require_user_secret", side_effect=MissingSecretError("test-svc", "alice")):
            with self.assertRaises(MissingSecretError):
                registry.get_provider_for_user("test", "alice")

    def test_unknown_provider_raises_key_error(self):
        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider_for_user("nope", "alice")


class TestLlmRouter(unittest.TestCase):
    def setUp(self):
        LLMProviderRegistry.reset_instance()
        SecretServiceRegistry.clear()
        register_secret_service("test-svc", "Test Service")
        LLMProviderRegistry.get_instance().register(make_provider(None))

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        SecretServiceRegistry.clear()

    def test_listing_flags_provider_without_user_key(self):
        with patch("fastapi_app.lib.llm.registry.require_user_secret", side_effect=MissingSecretError("test-svc", "alice")):
            providers = llm_router.list_providers(current_user=USER)
        self.assertEqual(len(providers), 1)
        self.assertTrue(providers[0].key_required)
        self.assertEqual(providers[0].secret_service, "test-svc")
        self.assertEqual(providers[0].models, [])

    def test_listing_uses_user_key(self):
        with patch("fastapi_app.lib.llm.registry.require_user_secret", return_value="user-key"), \
                patch.object(OpenAICompatibleProvider, "list_models", return_value=[
                    {"id": "m", "label": "M", "capabilities": frozenset({"chat"}), "status": None, "free": True}]):
            providers = llm_router.list_providers(current_user=USER)
        self.assertFalse(providers[0].key_required)
        self.assertEqual([m.id for m in providers[0].models], ["m"])

    def test_listing_shows_paid_models_to_non_admin_with_own_key(self):
        paid = [{"id": "paid", "label": "Paid", "capabilities": frozenset({"chat"}), "status": None, "free": False}]
        with patch("fastapi_app.lib.llm.registry.require_user_secret", return_value="user-key"), \
                patch.object(OpenAICompatibleProvider, "list_models", return_value=paid), \
                patch("fastapi_app.routers.llm.is_free_model", return_value=False), \
                patch("fastapi_app.lib.llm.model_access.is_free_model", return_value=False), \
                patch("fastapi_app.lib.llm.model_access.is_default_model", return_value=False):
            providers = llm_router.list_providers(current_user=USER)
        self.assertEqual([m.id for m in providers[0].models], ["paid"])

    def test_listing_hides_paid_models_of_shared_key_provider_from_non_admin(self):
        LLMProviderRegistry.get_instance().register(make_provider("shared"))
        paid = [{"id": "paid", "label": "Paid", "capabilities": frozenset({"chat"}), "status": None, "free": False}]
        with patch.object(OpenAICompatibleProvider, "list_models", return_value=paid), \
                patch("fastapi_app.routers.llm.is_free_model", return_value=False), \
                patch("fastapi_app.lib.llm.model_access.is_free_model", return_value=False), \
                patch("fastapi_app.lib.llm.model_access.is_default_model", return_value=False):
            providers = llm_router.list_providers(current_user=USER)
        self.assertEqual(providers[0].models, [])

    def test_setting_default_model_without_key_answers_428(self):
        admin = {"username": "root", "roles": ["admin"]}
        body = llm_router.DefaultModelResponse(provider_id="test", model_id="m")
        with patch("fastapi_app.lib.llm.registry.require_user_secret", side_effect=MissingSecretError("test-svc", "root")):
            with self.assertRaises(HTTPException) as ctx:
                llm_router.set_default(body, current_user=admin)
        self.assertEqual(ctx.exception.status_code, 428)
        self.assertEqual(ctx.exception.detail, secret_required_detail(MissingSecretError("test-svc")))


if __name__ == "__main__":
    unittest.main()
