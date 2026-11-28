"""
Unit tests for sending page images to vision models in the LLM review of OCR errors (#960).

@testCovers fastapi_app/lib/llm/base.py
@testCovers fastapi_app/lib/llm/openai_compatible.py
@testCovers fastapi_app/lib/llm/review_call.py
@testCovers fastapi_app/lib/ocr/page_images.py
@testCovers fastapi_app/lib/ocr/line_review.py
@testCovers fastapi_app/lib/ocr/llm_correction.py
"""

import asyncio
import base64
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from fastapi_app.lib.llm.base import VISION_CAPABILITY, LLMImage, LLMModel, LLMProvider
from fastapi_app.lib.llm.openai_compatible import user_content
from fastapi_app.lib.llm.review_call import complete_with_retry
from fastapi_app.lib.ocr import llm_correction
from fastapi_app.lib.ocr.line_review import IMAGES_NOTE, build_system_prompt
from fastapi_app.lib.ocr.llm_correction import correct_text_layer
from fastapi_app.lib.ocr.page_images import MAX_IMAGE_EDGE_PX, render_page_images

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = PROJECT_ROOT / "tests" / "unit" / "fastapi" / "fixtures" / "ocr-text-layer.pdf"
IMAGE = LLMImage(data=b"\xff\xd8jpeg", media_type="image/jpeg")


class ListingProvider(LLMProvider):
    """A provider whose models are given; records chat calls."""

    id = "fake"
    label = "Fake"

    def __init__(self, models: list[LLMModel] | Exception, responses: list[str] | None = None) -> None:
        self.models = models
        self.responses = list(responses or [])
        self.text_calls: list[str] = []
        self.image_calls: list[tuple[str, int]] = []

    def list_models(self) -> list[LLMModel]:
        if isinstance(self.models, Exception):
            raise self.models
        return self.models

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.text_calls.append(system_prompt)
        return self.responses.pop(0)

    async def chat_completion_with_images(
        self, model_id: str, system_prompt: str, user_prompt: str, images: list[LLMImage], temperature: float = 0.2
    ) -> str:
        self.image_calls.append((system_prompt, len(images)))
        return self.responses.pop(0)


def model(model_id: str, *capabilities: str) -> LLMModel:
    return LLMModel(id=model_id, label=model_id, capabilities=frozenset({"chat", *capabilities}), status=None, free=True)


class SupportsImageInputTest(unittest.TestCase):
    def test_derived_from_capabilities(self) -> None:
        provider = ListingProvider([model("text"), model("eyes", VISION_CAPABILITY)])
        self.assertTrue(provider.supports_image_input("eyes"))
        self.assertFalse(provider.supports_image_input("text"))
        self.assertFalse(provider.supports_image_input("unknown"))

    def test_false_when_models_cannot_be_listed(self) -> None:
        provider = ListingProvider(RuntimeError("down"))
        with self.assertLogs("fastapi_app.lib.llm.base", level="WARNING"):
            self.assertFalse(provider.supports_image_input("eyes"))


class UserContentTest(unittest.TestCase):
    def test_text_only(self) -> None:
        self.assertEqual(user_content("hello"), "hello")
        self.assertEqual(user_content("hello", []), "hello")

    def test_images_before_text(self) -> None:
        parts = user_content("hello", [IMAGE, IMAGE])
        assert isinstance(parts, list)
        self.assertEqual([p["type"] for p in parts], ["image_url", "image_url", "text"])
        url = parts[0]["image_url"]["url"]  # type: ignore[index]
        self.assertEqual(url, "data:image/jpeg;base64," + base64.b64encode(IMAGE["data"]).decode("ascii"))
        self.assertEqual(parts[2]["text"], "hello")


class CompleteWithRetryImagesTest(unittest.TestCase):
    def test_images_sent_with_first_call_and_retry(self) -> None:
        provider = ListingProvider([], ["bad", "ok"])

        def parse(raw: str) -> tuple[list[str], list[str]]:
            return ([raw], []) if raw == "ok" else ([], [raw])

        kept, _ = asyncio.run(complete_with_retry(provider, "m", "sys", "user", parse, lambda d: " retry", "test", images=[IMAGE]))
        self.assertEqual(kept, ["ok"])
        self.assertEqual(provider.image_calls, [("sys", 1), ("sys", 1)])
        self.assertEqual(provider.text_calls, [])


class SystemPromptTest(unittest.TestCase):
    def test_images_note_only_with_images(self) -> None:
        self.assertIn(IMAGES_NOTE, build_system_prompt(with_images=True))
        self.assertNotIn(IMAGES_NOTE, build_system_prompt())


class RenderPageImagesTest(unittest.TestCase):
    def test_jpeg_within_size_limit(self) -> None:
        images = render_page_images(FIXTURE, [0])
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["media_type"], "image/jpeg")
        image = Image.open(io.BytesIO(images[0]["data"]))
        self.assertEqual(image.format, "JPEG")
        self.assertLessEqual(max(image.size), MAX_IMAGE_EDGE_PX)

    def test_page_out_of_range(self) -> None:
        with self.assertRaises(IndexError):
            render_page_images(FIXTURE, [5])


class CorrectTextLayerImagesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.path = self.tmp / "doc.pdf"
        shutil.copy(FIXTURE, self.path)

    def run_pass(self, provider: LLMProvider) -> llm_correction.CorrectionRun:
        with mock.patch.object(llm_correction, "pages_needing_review", return_value=[0]):
            return asyncio.run(correct_text_layer(self.path, provider, "m", ["de"], 0.7))

    def test_vision_model_gets_page_images(self) -> None:
        provider = ListingProvider([model("m", VISION_CAPABILITY)], [json.dumps([])])
        run = self.run_pass(provider)
        self.assertIsNone(run.error)
        self.assertTrue(run.page_images)
        self.assertEqual(len(provider.image_calls), 1)
        self.assertIn(IMAGES_NOTE, provider.image_calls[0][0])
        self.assertEqual(provider.image_calls[0][1], 1)

    def test_text_model_gets_text_only(self) -> None:
        provider = ListingProvider([model("m")], [json.dumps([])])
        run = self.run_pass(provider)
        self.assertFalse(run.page_images)
        self.assertEqual(provider.image_calls, [])
        self.assertEqual(len(provider.text_calls), 1)

    def test_text_only_when_rendering_fails(self) -> None:
        provider = ListingProvider([model("m", VISION_CAPABILITY)], [json.dumps([])])
        with mock.patch.object(llm_correction, "render_page_images", side_effect=RuntimeError("broken")):
            with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING"):
                run = self.run_pass(provider)
        self.assertIsNone(run.error)
        self.assertEqual(provider.image_calls, [])
        self.assertEqual(len(provider.text_calls), 1)


if __name__ == "__main__":
    unittest.main()
