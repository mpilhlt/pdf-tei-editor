"""
Unit tests for the core LLM provider registry.

@testCovers fastapi_app/lib/llm/base.py
@testCovers fastapi_app/lib/llm/registry.py
"""

import unittest

from fastapi_app.lib.llm.base import LLMModel, LLMProvider, ModelStatus


class DummyProvider(LLMProvider):
    """Minimal concrete LLMProvider for testing the ABC contract."""

    def __init__(self, id: str, label: str, available: bool = True):
        self.id = id
        self.label = label
        self._available = available

    def is_available(self) -> bool:
        return self._available

    def list_models(self) -> list[LLMModel]:
        return [LLMModel(id="m1", label="Model 1", capabilities=frozenset({"chat"}), status=None)]

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        return "ok"


class TestLLMProviderBase(unittest.TestCase):
    """Test the base types can be constructed and satisfy the ABC contract."""

    def test_model_status_shape(self):
        status = ModelStatus(availability="busy", detail="demand: 3")
        self.assertEqual(status["availability"], "busy")
        self.assertEqual(status["detail"], "demand: 3")

    def test_llm_model_shape_with_status(self):
        model = LLMModel(
            id="gemma-3-27b",
            label="Gemma 3 27B",
            capabilities=frozenset({"chat", "json_mode"}),
            status=ModelStatus(availability="available", detail="demand: 0"),
        )
        self.assertEqual(model["id"], "gemma-3-27b")
        self.assertIn("json_mode", model["capabilities"])
        self.assertEqual(model["status"]["availability"], "available")

    def test_llm_model_shape_without_status(self):
        model = LLMModel(id="gpt-x", label="GPT X", capabilities=frozenset({"chat"}), status=None)
        self.assertIsNone(model["status"])

    def test_dummy_provider_satisfies_contract(self):
        provider = DummyProvider(id="dummy", label="Dummy")
        self.assertTrue(provider.is_available())
        models = provider.list_models()
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["id"], "m1")

    def test_provider_cannot_be_instantiated_without_list_models(self):
        """LLMProvider is abstract - list_models and chat_completion must be implemented."""
        with self.assertRaises(TypeError):
            LLMProvider()  # type: ignore[abstract]


from fastapi_app.lib.llm.registry import LLMProviderRegistry


class TestLLMProviderRegistry(unittest.TestCase):
    """Test provider registration, listing, and lookup."""

    def setUp(self):
        LLMProviderRegistry.reset_instance()
        self.registry = LLMProviderRegistry.get_instance()

    def tearDown(self):
        LLMProviderRegistry.reset_instance()

    def test_register_and_get_provider(self):
        provider = DummyProvider(id="dummy", label="Dummy")
        self.registry.register(provider)
        self.assertIs(self.registry.get_provider("dummy"), provider)

    def test_get_provider_raises_keyerror_when_not_found(self):
        with self.assertRaises(KeyError):
            self.registry.get_provider("nonexistent")

    def test_list_providers_available_only_filters_unavailable(self):
        self.registry.register(DummyProvider(id="a", label="A", available=True))
        self.registry.register(DummyProvider(id="b", label="B", available=False))
        available = self.registry.list_providers(available_only=True)
        self.assertEqual([p.id for p in available], ["a"])

    def test_list_providers_available_only_false_includes_all(self):
        self.registry.register(DummyProvider(id="a", label="A", available=True))
        self.registry.register(DummyProvider(id="b", label="B", available=False))
        all_providers = self.registry.list_providers(available_only=False)
        self.assertEqual(sorted(p.id for p in all_providers), ["a", "b"])

    def test_unregister_removes_provider(self):
        self.registry.register(DummyProvider(id="a", label="A"))
        self.registry.unregister("a")
        with self.assertRaises(KeyError):
            self.registry.get_provider("a")

    def test_unregister_nonexistent_is_a_noop(self):
        self.registry.unregister("nonexistent")  # must not raise

    def test_get_instance_returns_singleton(self):
        self.assertIs(LLMProviderRegistry.get_instance(), self.registry)


if __name__ == "__main__":
    unittest.main()
