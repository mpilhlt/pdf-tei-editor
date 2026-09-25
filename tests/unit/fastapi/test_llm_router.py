"""
Unit tests for the LLM provider listing router.

@testCovers fastapi_app/routers/llm.py
"""

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.routers.llm import router
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry, ModelStatus


class _StubProvider(LLMProvider):
    def __init__(self, id: str, label: str, models: list[LLMModel], raise_on_list_models: bool = False):
        self.id = id
        self.label = label
        self._models = models
        self._raise_on_list_models = raise_on_list_models

    def list_models(self) -> list[LLMModel]:
        if self._raise_on_list_models:
            raise RuntimeError("simulated provider failure")
        return self._models

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        return ""


class TestListProvidersRoute(unittest.TestCase):
    """Test GET /llm/providers."""

    def setUp(self):
        # independent of the real llm.model-filter config; the filter itself is tested separately
        patcher = mock.patch("fastapi_app.routers.llm.is_model_allowed", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "testuser"}
        self.client = TestClient(self.app)
        LLMProviderRegistry.reset_instance()

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        self.app.dependency_overrides.clear()

    def test_empty_registry_returns_empty_list(self):
        response = self.client.get("/llm/providers")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_returns_registered_provider_with_models_and_status(self):
        LLMProviderRegistry.get_instance().register(
            _StubProvider(
                id="kisski",
                label="KISSKI",
                models=[
                    LLMModel(
                        id="gemma-3",
                        label="Gemma 3",
                        capabilities=frozenset({"chat"}),
                        status=ModelStatus(availability="busy", detail="demand: 3"),
                    )
                ],
            )
        )
        response = self.client.get("/llm/providers")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["id"], "kisski")
        self.assertEqual(body[0]["models"][0]["id"], "gemma-3")
        self.assertEqual(body[0]["models"][0]["status"]["availability"], "busy")

    def test_model_with_no_status_serializes_null(self):
        LLMProviderRegistry.get_instance().register(
            _StubProvider(
                id="p",
                label="P",
                models=[LLMModel(id="m", label="M", capabilities=frozenset({"chat"}), status=None)],
            )
        )
        response = self.client.get("/llm/providers")
        self.assertIsNone(response.json()[0]["models"][0]["status"])

    def test_failing_provider_is_skipped_others_still_returned(self):
        registry = LLMProviderRegistry.get_instance()
        registry.register(
            _StubProvider(id="broken", label="Broken", models=[], raise_on_list_models=True)
        )
        registry.register(
            _StubProvider(
                id="healthy",
                label="Healthy",
                models=[
                    LLMModel(
                        id="model-a",
                        label="Model A",
                        capabilities=frozenset({"chat"}),
                        status=None,
                    )
                ],
            )
        )
        with self.assertLogs("fastapi_app.routers.llm", level="WARNING"):
            response = self.client.get("/llm/providers")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["id"], "healthy")

    def test_requires_authentication(self):
        self.app.dependency_overrides.clear()
        response = self.client.get("/llm/providers")
        self.assertEqual(response.status_code, 401)


class TestListProvidersRouteModelFilter(unittest.TestCase):
    """Test that GET /llm/providers applies the admin-configured model filter."""

    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "testuser"}
        self.client = TestClient(self.app)
        LLMProviderRegistry.reset_instance()
        LLMProviderRegistry.get_instance().register(
            _StubProvider(
                id="kisski",
                label="KISSKI",
                models=[
                    LLMModel(id="gemma-3", label="Gemma 3", capabilities=frozenset({"chat"}), status=None),
                    LLMModel(id="gemma-27b", label="Gemma 27B", capabilities=frozenset({"chat"}), status=None),
                ],
            )
        )

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        self.app.dependency_overrides.clear()

    @mock.patch("fastapi_app.routers.llm.is_model_allowed")
    def test_only_matching_models_are_listed(self, mock_is_allowed):
        mock_is_allowed.side_effect = lambda label: label == "KISSKI/Gemma 3"
        response = self.client.get("/llm/providers")
        body = response.json()
        self.assertEqual([m["id"] for m in body[0]["models"]], ["gemma-3"])
        mock_is_allowed.assert_any_call("KISSKI/Gemma 3")
        mock_is_allowed.assert_any_call("KISSKI/Gemma 27B")

    @mock.patch("fastapi_app.routers.llm.is_model_allowed", return_value=True)
    def test_no_filtering_lists_every_model(self, mock_is_allowed):
        response = self.client.get("/llm/providers")
        body = response.json()
        self.assertEqual(len(body[0]["models"]), 2)

    @mock.patch("fastapi_app.routers.llm.is_model_allowed", return_value=False)
    def test_provider_with_no_allowed_models_is_still_listed_with_empty_models(self, mock_is_allowed):
        response = self.client.get("/llm/providers")
        body = response.json()
        self.assertEqual(body[0]["id"], "kisski")
        self.assertEqual(body[0]["models"], [])


class TestDefaultModelRoutes(unittest.TestCase):
    """Test GET/PUT /llm/default-model."""

    def setUp(self):
        # independent of the real llm.model-filter config; the filter itself is tested separately
        patcher = mock.patch("fastapi_app.routers.llm.is_model_allowed", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = FastAPI()
        self.app.include_router(router)
        self.user = {"username": "u", "roles": ["user"]}
        self.app.dependency_overrides[require_authenticated_user] = lambda: self.user
        self.client = TestClient(self.app)
        LLMProviderRegistry.reset_instance()
        LLMProviderRegistry.get_instance().register(
            _StubProvider(
                id="kisski",
                label="KISSKI",
                models=[LLMModel(id="gemma-3", label="Gemma 3", capabilities=frozenset({"chat"}), status=None, free=True)],
            )
        )

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        self.app.dependency_overrides.clear()

    @mock.patch("fastapi_app.routers.llm.get_default_model", return_value=("kisski", "gemma-3"))
    def test_get_returns_the_configured_default_to_any_user(self, _):
        response = self.client.get("/llm/default-model")
        self.assertEqual(response.json(), {"provider_id": "kisski", "model_id": "gemma-3"})

    @mock.patch("fastapi_app.routers.llm.get_default_model", return_value=None)
    def test_get_returns_null_when_no_default_is_set(self, _):
        response = self.client.get("/llm/default-model")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json())

    @mock.patch("fastapi_app.routers.llm.set_default_model")
    def test_put_is_forbidden_for_non_admins(self, mock_set):
        response = self.client.put("/llm/default-model", json={"provider_id": "kisski", "model_id": "gemma-3"})
        self.assertEqual(response.status_code, 403)
        mock_set.assert_not_called()

    @mock.patch("fastapi_app.routers.llm.is_model_allowed", return_value=True)
    @mock.patch("fastapi_app.routers.llm.set_default_model")
    def test_put_stores_the_default_for_admins(self, mock_set, _):
        self.user["roles"] = ["admin"]
        response = self.client.put("/llm/default-model", json={"provider_id": "kisski", "model_id": "gemma-3"})
        self.assertEqual(response.status_code, 200)
        mock_set.assert_called_once_with("kisski", "gemma-3")

    @mock.patch("fastapi_app.routers.llm.set_default_model")
    def test_put_rejects_unknown_provider_and_model(self, mock_set):
        self.user["roles"] = ["admin"]
        self.assertEqual(self.client.put("/llm/default-model", json={"provider_id": "nope", "model_id": "x"}).status_code, 404)
        self.assertEqual(self.client.put("/llm/default-model", json={"provider_id": "kisski", "model_id": "x"}).status_code, 404)
        mock_set.assert_not_called()

    @mock.patch("fastapi_app.routers.llm.is_model_allowed", return_value=False)
    @mock.patch("fastapi_app.routers.llm.set_default_model")
    def test_put_rejects_a_model_excluded_by_the_filter(self, mock_set, _):
        self.user["roles"] = ["admin"]
        response = self.client.put("/llm/default-model", json={"provider_id": "kisski", "model_id": "gemma-3"})
        self.assertEqual(response.status_code, 403)
        mock_set.assert_not_called()

    def test_providers_response_includes_the_free_flag(self):
        body = self.client.get("/llm/providers").json()
        self.assertTrue(body[0]["models"][0]["free"])


if __name__ == "__main__":
    unittest.main()
