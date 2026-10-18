"""
Unit tests for LLamoreExtractor's use of the general LLM provider registry.

@testCovers fastapi_app/plugins/llamore_extractor/extractor.py
"""

import asyncio
import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry
from fastapi_app.lib.llm.model_access import ModelAccessDenied
from fastapi_app.plugins.llamore_extractor.extractor import LLamoreExtractor

EXTRACTOR_MODULE = "fastapi_app.plugins.llamore_extractor.extractor"

RESPONSE = "Doe, J. (2020). A title. Journal 1, 2-3."


class FakeProvider(LLMProvider):
    """Records calls; accepts PDF input when `pdf_input` is True."""

    def __init__(self, id: str, pdf_input: bool):
        self.id = id
        self.label = id.title()
        self._pdf_input = pdf_input
        self.calls: list[dict[str, str]] = []

    def list_models(self) -> list[LLMModel]:
        return [LLMModel(id="m1", label="M1", capabilities=frozenset({"chat"}), status=None, free=True)]

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.calls.append({"kind": "text", "model_id": model_id, "user_prompt": user_prompt})
        return RESPONSE

    def supports_pdf_input(self, model_id: str) -> bool:
        return self._pdf_input

    async def chat_completion_with_pdf(
        self, model_id: str, system_prompt: str, user_prompt: str, pdf_path: str, temperature: float = 0.2
    ) -> str:
        self.calls.append({"kind": "pdf", "model_id": model_id, "user_prompt": user_prompt, "pdf_path": pdf_path})
        return RESPONSE


class RegistryTestCase(unittest.TestCase):
    def setUp(self):
        LLMProviderRegistry.reset_instance()
        self.registry = LLMProviderRegistry.get_instance()

    def tearDown(self):
        LLMProviderRegistry.reset_instance()


class TestAvailability(RegistryTestCase):
    def test_unavailable_without_providers(self):
        self.assertFalse(LLamoreExtractor.is_available())

    def test_available_with_a_provider(self):
        self.registry.register(FakeProvider("kisski", pdf_input=False))
        self.assertTrue(LLamoreExtractor.is_available())

    def test_info_has_no_gemini_model_option(self):
        info = LLamoreExtractor.get_info()
        self.assertNotIn("model", info["options"])
        self.assertTrue(info["uses_inference_model"])


@patch(f"{EXTRACTOR_MODULE}.check_model_access")
@patch(f"{EXTRACTOR_MODULE}.get_auth_manager")
@patch(f"{EXTRACTOR_MODULE}.get_default_model")
class TestResolveModel(RegistryTestCase):
    def setUp(self):
        super().setUp()
        self.google = FakeProvider("google", pdf_input=True)
        self.kisski = FakeProvider("kisski", pdf_input=False)
        self.registry.register(self.google)
        self.registry.register(self.kisski)

    def test_uses_model_from_options(self, mock_default, mock_auth, mock_check):
        mock_default.return_value = ("google", "gemini-x")
        user = {"username": "alice", "roles": ["user"]}
        mock_auth.return_value.get_user_by_username.return_value = user

        provider, model_id = LLamoreExtractor._resolve_model({"provider_id": "kisski", "model_id": "m1", "username": "alice"})

        self.assertIs(provider, self.kisski)
        self.assertEqual(model_id, "m1")
        mock_check.assert_called_once_with(self.kisski, "m1", user)

    def test_falls_back_to_default_model(self, mock_default, mock_auth, mock_check):
        mock_default.return_value = ("google", "gemini-x")

        provider, model_id = LLamoreExtractor._resolve_model({"username": "alice"})

        self.assertIs(provider, self.google)
        self.assertEqual(model_id, "gemini-x")

    def test_error_without_any_model(self, mock_default, mock_auth, mock_check):
        mock_default.return_value = None
        with self.assertRaisesRegex(ValueError, "Tools > Default Model"):
            LLamoreExtractor._resolve_model({})

    def test_error_for_unknown_provider(self, mock_default, mock_auth, mock_check):
        with self.assertRaisesRegex(ValueError, "'gone' is not available"):
            LLamoreExtractor._resolve_model({"provider_id": "gone", "model_id": "m1"})

    def test_access_denied_propagates(self, mock_default, mock_auth, mock_check):
        mock_check.side_effect = ModelAccessDenied("not free")
        with self.assertRaises(ModelAccessDenied):
            LLamoreExtractor._resolve_model({"provider_id": "kisski", "model_id": "m1", "username": "bob"})


class TestExtractRefs(unittest.TestCase):
    def _run(self, provider: FakeProvider, pdf_text: str = "Some text with references"):
        with patch(f"{EXTRACTOR_MODULE}._pdf_text", return_value=pdf_text), \
                patch(f"{EXTRACTOR_MODULE}.TeiBiblStruct") as mock_parser_cls, \
                patch(f"{EXTRACTOR_MODULE}.LineByLinePrompter.parse", return_value=[]) as mock_parse:
            mock_parser_cls.return_value.to_xml.return_value = b'<listBibl xmlns="http://www.tei-c.org/ns/1.0"/>'
            result = asyncio.run(
                LLamoreExtractor()._extract_refs_from_pdf("/x.pdf", provider, "m1", additional_instructions_text="RULES")
            )
        return result, mock_parse

    def test_sends_pdf_when_provider_accepts_it(self):
        provider = FakeProvider("google", pdf_input=True)
        result, mock_parse = self._run(provider)

        self.assertEqual(len(provider.calls), 1)
        call = provider.calls[0]
        self.assertEqual(call["kind"], "pdf")
        self.assertEqual(call["pdf_path"], "/x.pdf")
        self.assertIn("RULES", call["user_prompt"])
        mock_parse.assert_called_once_with(RESPONSE)
        self.assertEqual(result.tag, "{http://www.tei-c.org/ns/1.0}listBibl")

    def test_sends_text_layer_otherwise(self):
        provider = FakeProvider("kisski", pdf_input=False)
        self._run(provider)

        call = provider.calls[0]
        self.assertEqual(call["kind"], "text")
        self.assertIn("Some text with references", call["user_prompt"])
        self.assertIn("RULES", call["user_prompt"])

    def test_error_when_text_fallback_finds_no_text(self):
        with self.assertRaisesRegex(ValueError, "no text layer"):
            self._run(FakeProvider("kisski", pdf_input=False), pdf_text="  ")


if __name__ == "__main__":
    unittest.main()
