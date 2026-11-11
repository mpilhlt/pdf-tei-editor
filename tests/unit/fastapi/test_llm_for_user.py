"""
Unit tests for per-user provider resolution (LLMProvider.for_user()).

@testCovers fastapi_app/lib/llm/base.py
@testCovers fastapi_app/lib/llm/registry.py
@testCovers fastapi_app/routers/llm.py
"""

import copy
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry, ProviderNotAvailableError
from fastapi_app.routers.llm import router


class _PerUserProvider(LLMProvider):
    """Offers a model only to the users in `owners`, like endpoints started with a user's own account."""

    def __init__(self, owners: set[str]):
        self.id = "per-user"
        self.label = "Per User"
        self.owners = owners
        self.bound_to: str | None = None

    def for_user(self, username: str | None) -> "LLMProvider | None":
        if username not in self.owners:
            return None
        bound = copy.copy(self)
        bound.bound_to = username
        bound.uses_user_key = True
        return bound

    def list_models(self) -> list[LLMModel]:
        return [LLMModel(id="m", label="M", capabilities=frozenset({"chat"}), status=None, free=False)]

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        return self.bound_to or ""


class _PlainProvider(LLMProvider):
    def __init__(self):
        self.id = "plain"
        self.label = "Plain"

    def list_models(self) -> list[LLMModel]:
        return []

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        return ""


class TestRegistryForUser(unittest.TestCase):
    def setUp(self):
        LLMProviderRegistry.reset_instance()
        self.registry = LLMProviderRegistry.get_instance()
        self.registry.register(_PerUserProvider({"alice"}))
        self.registry.register(_PlainProvider())

    def tearDown(self):
        LLMProviderRegistry.reset_instance()

    def test_default_hook_returns_the_registered_provider(self):
        provider = self.registry.get_provider("plain")
        self.assertIs(provider.for_user("bob"), provider)
        self.assertIs(self.registry.get_provider_for_user("plain", None), provider)

    def test_bound_copy_for_owner(self):
        provider = self.registry.get_provider_for_user("per-user", "alice")
        self.assertIsNot(provider, self.registry.get_provider("per-user"))
        self.assertEqual(provider.bound_to, "alice")
        self.assertTrue(provider.uses_user_key)
        self.assertFalse(self.registry.get_provider("per-user").uses_user_key)

    def test_not_available_to_other_users_and_without_user(self):
        for username in ("bob", None):
            with self.assertRaises(ProviderNotAvailableError) as ctx:
                self.registry.get_provider_for_user("per-user", username)
            self.assertIsInstance(ctx.exception, KeyError)
            self.assertEqual(str(ctx.exception), "LLM provider 'Per User' is not available to you")


class TestProvidersRouteForUser(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("fastapi_app.lib.llm.model_access.is_model_allowed", return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        LLMProviderRegistry.reset_instance()
        LLMProviderRegistry.get_instance().register(_PerUserProvider({"alice"}))
        self.app = FastAPI()
        self.app.include_router(router)
        self.client = TestClient(self.app)

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        self.app.dependency_overrides.clear()

    def _list(self, username: str) -> list[dict]:
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": username, "roles": ["user"]}
        response = self.client.get("/llm/providers")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_owner_sees_paid_filtered_model(self):
        body = self._list("alice")
        self.assertEqual([p["id"] for p in body], ["per-user"])
        self.assertEqual([m["id"] for m in body[0]["models"]], ["m"])

    def test_other_user_does_not_see_provider(self):
        self.assertEqual(self._list("bob"), [])

    def test_setting_default_to_unavailable_provider_answers_404(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob", "roles": ["admin"]}
        from fastapi_app.lib.core.dependencies import require_admin_user
        self.app.dependency_overrides[require_admin_user] = lambda: {"username": "bob", "roles": ["admin"]}
        response = self.client.put("/llm/default-model", json={"provider_id": "per-user", "model_id": "m"})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "LLM provider 'Per User' is not available to you")


if __name__ == "__main__":
    unittest.main()
