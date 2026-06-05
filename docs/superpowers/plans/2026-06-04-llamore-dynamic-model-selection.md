# LLamore Dynamic Gemini Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch the list of available Gemini models from the Gemini API and present them as a selectable dropdown in the extraction dialog, so users can choose which model to use for LLamore extraction.

**Architecture:** Add `_fetch_available_models()` classmethod to `LLamoreExtractor` with a 24-hour in-process cache. Inject a `model` form option into `get_info()` and read `options["model"]` in `_extract_refs_from_pdf()`. The extraction dialog already renders string options with an `options` array as a dropdown — no frontend changes needed.

**Tech Stack:** Python, `google-genai` SDK (already installed as llamore dependency), `unittest.mock`

---

## Files

- **Modify:** `fastapi_app/plugins/llamore/extractor.py` — add caching, model fetch, update `get_info()` and `_extract_refs_from_pdf()`
- **Create:** `fastapi_app/plugins/llamore/tests/__init__.py` — empty, makes the directory a package
- **Create:** `fastapi_app/plugins/llamore/tests/test_model_selection.py` — unit tests for the new behavior

---

### Task 1: Create the test file with failing tests

**Files:**
- Create: `fastapi_app/plugins/llamore/tests/__init__.py`
- Create: `fastapi_app/plugins/llamore/tests/test_model_selection.py`

- [ ] **Step 1: Create the tests directory and empty `__init__.py`**

```bash
mkdir -p fastapi_app/plugins/llamore/tests
touch fastapi_app/plugins/llamore/tests/__init__.py
```

- [ ] **Step 2: Write the test file**

Create `fastapi_app/plugins/llamore/tests/test_model_selection.py`:

```python
"""
Unit tests for LLamoreExtractor dynamic model selection.
"""

import time
import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.llamore.extractor import LLamoreExtractor


def _make_mock_model(name: str, actions: list[str]) -> MagicMock:
    m = MagicMock()
    m.name = f"models/{name}"
    m.supported_actions = actions
    return m


GENERATE_CONTENT = "generateContent"
GEMINI_MODELS = [
    _make_mock_model("gemini-2.5-flash", [GENERATE_CONTENT, "countTokens"]),
    _make_mock_model("gemini-2.5-pro", [GENERATE_CONTENT, "countTokens"]),
    _make_mock_model("gemini-2.0-flash", [GENERATE_CONTENT, "countTokens"]),
    _make_mock_model("gemini-2.5-flash-preview-tts", ["countTokens", GENERATE_CONTENT]),
    _make_mock_model("gemma-4-26b-a4b-it", [GENERATE_CONTENT, "countTokens"]),
]


class TestFetchAvailableModels(unittest.TestCase):

    def setUp(self):
        # Clear the class-level cache before each test
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    def _mock_client(self, models=None):
        """Return a mock genai.Client whose models.list() yields GEMINI_MODELS."""
        mock_client = MagicMock()
        mock_client.models.list.return_value = models if models is not None else GEMINI_MODELS
        return mock_client

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.genai")
    def test_returns_only_gemini_generate_content_models(self, mock_genai, mock_get_config):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)
        mock_genai.Client.return_value = self._mock_client()

        result = LLamoreExtractor._fetch_available_models()

        # Only gemini- models with generateContent should be included
        self.assertIn("gemini-2.5-flash", result)
        self.assertIn("gemini-2.5-pro", result)
        self.assertIn("gemini-2.0-flash", result)
        # TTS model should be excluded (name doesn't end with -tts but it IS gemini-; actually included by filter)
        # Gemma models should be excluded (don't start with gemini-)
        self.assertNotIn("gemma-4-26b-a4b-it", result)

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.genai")
    def test_configured_model_is_first(self, mock_genai, mock_get_config):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.5-pro",
        }.get(key, default)
        mock_genai.Client.return_value = self._mock_client()

        result = LLamoreExtractor._fetch_available_models()

        self.assertEqual(result[0], "gemini-2.5-pro")

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.genai")
    def test_cache_is_used_within_ttl(self, mock_genai, mock_get_config):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)
        mock_genai.Client.return_value = self._mock_client()

        LLamoreExtractor._fetch_available_models()
        LLamoreExtractor._fetch_available_models()

        # Client should only have been constructed once
        self.assertEqual(mock_genai.Client.call_count, 1)

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.genai")
    def test_cache_is_refreshed_after_ttl(self, mock_genai, mock_get_config):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)
        mock_genai.Client.return_value = self._mock_client()

        LLamoreExtractor._fetch_available_models()
        # Expire the cache
        LLamoreExtractor._models_cache_time = time.time() - LLamoreExtractor._CACHE_TTL - 1
        LLamoreExtractor._fetch_available_models()

        self.assertEqual(mock_genai.Client.call_count, 2)

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.genai")
    def test_fallback_to_config_model_on_api_error(self, mock_genai, mock_get_config):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)
        mock_genai.Client.side_effect = Exception("API error")

        result = LLamoreExtractor._fetch_available_models()

        self.assertEqual(result, ["gemini-2.0-flash"])

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    def test_fallback_when_no_api_key(self, mock_get_config):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)

        result = LLamoreExtractor._fetch_available_models()

        self.assertEqual(result, ["gemini-2.0-flash"])


class TestGetInfoIncludesModelOption(unittest.TestCase):

    def setUp(self):
        LLamoreExtractor._models_cache = ["gemini-2.5-flash", "gemini-2.0-flash"]
        LLamoreExtractor._models_cache_time = time.time()

    def tearDown(self):
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    def test_get_info_includes_model_option(self):
        info = LLamoreExtractor.get_info()
        self.assertIn("model", info["options"])
        self.assertIn("options", info["options"]["model"])
        self.assertIn("gemini-2.5-flash", info["options"]["model"]["options"])


class TestExtractUsesModelFromOptions(unittest.TestCase):

    def setUp(self):
        LLamoreExtractor._models_cache = ["gemini-2.5-flash", "gemini-2.0-flash"]
        LLamoreExtractor._models_cache_time = time.time()

    def tearDown(self):
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.LineByLinePrompter")
    @patch("fastapi_app.plugins.llamore.extractor.GeminiExtractor")
    @patch("fastapi_app.plugins.llamore.extractor.TeiBiblStruct")
    def test_extract_uses_model_from_options(
        self, mock_parser_cls, mock_extractor_cls, mock_prompter_cls, mock_get_config
    ):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)

        mock_extractor_instance = MagicMock()
        mock_extractor_instance.return_value = []
        mock_extractor_cls.return_value = mock_extractor_instance

        mock_parser = MagicMock()
        mock_parser.to_xml.return_value = b'<listBibl xmlns="http://www.tei-c.org/ns/1.0"/>'
        mock_parser_cls.return_value = mock_parser

        extractor = LLamoreExtractor()
        extractor._extract_refs_from_pdf("/path/to/file.pdf", {"model": "gemini-2.5-flash"})

        # Verify GeminiExtractor was created with the model from options, not config default
        mock_extractor_cls.assert_called_once()
        call_kwargs = mock_extractor_cls.call_args.kwargs
        self.assertEqual(call_kwargs.get("model"), "gemini-2.5-flash")

    @patch("fastapi_app.plugins.llamore.extractor.get_config")
    @patch("fastapi_app.plugins.llamore.extractor.LineByLinePrompter")
    @patch("fastapi_app.plugins.llamore.extractor.GeminiExtractor")
    @patch("fastapi_app.plugins.llamore.extractor.TeiBiblStruct")
    def test_extract_falls_back_to_config_model_when_not_in_options(
        self, mock_parser_cls, mock_extractor_cls, mock_prompter_cls, mock_get_config
    ):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)

        mock_extractor_instance = MagicMock()
        mock_extractor_instance.return_value = []
        mock_extractor_cls.return_value = mock_extractor_instance

        mock_parser = MagicMock()
        mock_parser.to_xml.return_value = b'<listBibl xmlns="http://www.tei-c.org/ns/1.0"/>'
        mock_parser_cls.return_value = mock_parser

        extractor = LLamoreExtractor()
        extractor._extract_refs_from_pdf("/path/to/file.pdf", {})

        mock_extractor_cls.assert_called_once()
        call_kwargs = mock_extractor_cls.call_args.kwargs
        self.assertEqual(call_kwargs.get("model"), "gemini-2.0-flash")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
uv run python -m pytest fastapi_app/plugins/llamore/tests/test_model_selection.py -v 2>&1 | tail -30
```

Expected: Multiple `AttributeError` or `ImportError` failures — `_fetch_available_models`, `_CACHE_TTL`, `genai` not yet defined on `LLamoreExtractor`.

---

### Task 2: Implement the changes in `LLamoreExtractor`

**Files:**
- Modify: `fastapi_app/plugins/llamore/extractor.py`

- [ ] **Step 1: Add `genai` import and cache class variables**

In `fastapi_app/plugins/llamore/extractor.py`, replace the top-level try/except import block:

```python
# Try to import LLamore dependencies
try:
    from llamore import GeminiExtractor, LineByLinePrompter, TeiBiblStruct  # type: ignore[import-untyped]
    from google import genai  # type: ignore[import-untyped]
    LLAMORE_AVAILABLE = True
except ImportError:
    LLAMORE_AVAILABLE = False
```

- [ ] **Step 2: Add cache class variables and `_fetch_available_models()` to `LLamoreExtractor`**

After the `class LLamoreExtractor(BaseExtractor):` line and its docstring, add:

```python
    _models_cache: list[str] | None = None
    _models_cache_time: float = 0
    _CACHE_TTL: int = 86400  # 24 hours

    @classmethod
    def _fetch_available_models(cls) -> list[str]:
        """Return available Gemini models from API with 24-hour caching."""
        import time
        import logging
        logger = logging.getLogger(__name__)

        configured_model = get_config().get("plugin.llamore.model", default="gemini-2.0-flash")
        api_key = get_config().get("plugin.llamore.api.key", default="")

        if not api_key:
            return [configured_model]

        now = time.time()
        if cls._models_cache is not None and (now - cls._models_cache_time) < cls._CACHE_TTL:
            return cls._models_cache

        try:
            client = genai.Client(api_key=api_key)
            models = [
                m.name.replace("models/", "")
                for m in client.models.list()
                if m.name.startswith("models/gemini-")
                and "generateContent" in (m.supported_actions or [])
            ]
            if models:
                if configured_model in models:
                    models = [configured_model] + [m for m in models if m != configured_model]
                cls._models_cache = models
                cls._models_cache_time = now
                return models
        except Exception as exc:
            logger.warning("Could not fetch Gemini model list: %s", exc)

        return [configured_model]
```

- [ ] **Step 3: Update `get_models()` and `get_info()`**

Replace the existing `get_models()` and `get_info()` classmethods:

```python
    @classmethod
    def get_models(cls) -> list[str]:
        return cls._fetch_available_models()

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the LLamore extractor."""
        options = get_form_options()
        options["model"] = {
            "type": "string",
            "label": "Model",
            "description": "Gemini model to use for extraction",
            "required": False,
            "options": cls._fetch_available_models()
        }
        return {
            "id": "llamore-gemini",
            "name": "LLamore + Gemini",
            "description": "Extract bibliographic references from PDF using LLamore library with Gemini AI",
            "input": ["pdf"],
            "output": ["tei-document"],
            "variants": get_supported_variants(),
            "options": options,
            "navigation_xpath": get_navigation_xpath(),
            "annotationGuides": get_annotation_guides()
        }
```

- [ ] **Step 4: Update `_extract_refs_from_pdf()` to read model from options**

In `_extract_refs_from_pdf()`, replace the line that reads the model from config:

```python
        model = options.get("model") or get_config().get("plugin.llamore.model", default="gemini-2.0-flash")
```

Also update the `GeminiExtractor` instantiation to use keyword arguments so the test can assert on `call_args.kwargs`:

```python
        extractor = GeminiExtractor(api_key=gemini_api_key, prompter=CustomPrompter(), model=model)
```

(This line is the same — just confirm it uses `model=model` as a keyword argument, which it already does.)

- [ ] **Step 5: Run tests to confirm they pass**

```bash
uv run python -m pytest fastapi_app/plugins/llamore/tests/test_model_selection.py -v 2>&1 | tail -30
```

Expected: All tests PASS.

- [ ] **Step 6: Run the full unit test suite to check for regressions**

```bash
uv run python -m pytest tests/unit/fastapi/ fastapi_app/plugins/llamore/tests/ -v 2>&1 | tail -20
```

Expected: All existing tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/plugins/llamore/extractor.py \
        fastapi_app/plugins/llamore/tests/__init__.py \
        fastapi_app/plugins/llamore/tests/test_model_selection.py
git commit -m "feat: fetch available Gemini models dynamically in LLamore extractor (#378)"
```

---

## Implementation Progress

_To be filled in after implementation._
