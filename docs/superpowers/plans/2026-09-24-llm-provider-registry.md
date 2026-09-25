# Core LLM Provider Registry + Kisski Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic, pluggable registry for OpenAI-API-compatible LLM inference endpoints (`fastapi_app/lib/llm/`), expose it via a core REST route, and migrate the existing Kisski plugin onto it (including live per-model busy/demand status) without changing Kisski's existing extraction behavior.

**Architecture:** A new `LLMProviderRegistry` singleton (mirrors the existing `ExtractorRegistry` pattern) holds already-constructed `LLMProvider` instances, registered by provider plugins during their `initialize()` lifecycle hook. A concrete `OpenAICompatibleProvider` base class implements the standard `chat/completions` + `models` wire format; a shared free function backs both it and Kisski's existing extractor, eliminating duplicate HTTP code. A new core router exposes the registry generically (`GET /api/v1/llm/providers`), for later consumption by the default-model picker and the annotation-review plugin (subsequent plans).

**Tech Stack:** Python 3.12, FastAPI, `requests` (via the existing `get_retry_session` retry-wrapper), `unittest` (project convention, not pytest-style), `uv run python`.

**Design reference:** [docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md](../specs/2026-09-24-llm-annotation-review-design.md) (Parts A and B).

---

## File Structure

- Create `fastapi_app/lib/llm/base.py` — `ModelStatus`, `LLMModel`, `LLMProvider` (ABC).
- Create `fastapi_app/lib/llm/openai_compatible.py` — `chat_completion_sync()` free function, `OpenAICompatibleProvider`.
- Create `fastapi_app/lib/llm/registry.py` — `LLMProviderRegistry` singleton.
- Create `fastapi_app/lib/llm/__init__.py` — package re-exports.
- Create `fastapi_app/routers/llm.py` — `GET /providers` route (mounted at `/api/v1/llm`).
- Modify `fastapi_app/main.py` — import and mount the new router.
- Create `fastapi_app/plugins/kisski/llm_provider.py` — `KisskiLLMProvider(OpenAICompatibleProvider)` with demand/busy status.
- Modify `fastapi_app/plugins/kisski/plugin.py` — register/unregister the provider in `initialize()`/`cleanup()`.
- Modify `fastapi_app/plugins/kisski/extractor.py` — `_call_llm` delegates to the shared free function (behavior-preserving refactor).
- Create `tests/unit/fastapi/test_llm_registry.py` — registry tests.
- Create `tests/unit/fastapi/test_llm_openai_compatible.py` — provider/shared-function tests (mocked HTTP).
- Create `tests/unit/fastapi/test_llm_router.py` — route test.
- Create `fastapi_app/plugins/kisski/tests/test_llm_provider.py` — Kisski provider + demand-classification tests.

All new/changed Python files use `unittest.TestCase`, matching every existing test in `tests/unit/fastapi/` and `fastapi_app/plugins/kisski/tests/` — this project does not use pytest-style bare functions for backend tests.

---

### Task 1: `LLMModel`/`ModelStatus`/`LLMProvider` base types

**Files:**
- Create: `fastapi_app/lib/llm/base.py`
- Test: `tests/unit/fastapi/test_llm_registry.py` (shared file for this whole plan's registry-level tests)

- [ ] **Step 1: Write the failing test**

```python
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_registry`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.llm'`

- [ ] **Step 3: Write the implementation**

```python
"""
Core LLM provider abstraction.

Generalizes ad hoc OpenAI-compatible inference integrations (previously
duplicated per-extractor, e.g. kisski/extractor.py) into a pluggable
registry any backend plugin can register a connector into, and any
consumer can query, without hardcoding provider-specific HTTP logic or
env var names.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part A) for the design rationale.
"""

from abc import ABC, abstractmethod
from typing import Literal, TypedDict


class ModelStatus(TypedDict):
    """A model's live load state, when a provider exposes one.

    Deliberately provider-agnostic: `availability` is a fixed 3-tier enum
    any provider normalizes its own live-load signal onto (this codebase's
    only current example, Kisski's numeric "demand", is one such signal).
    `detail` carries whatever provider-specific elaboration is useful in a
    warning tooltip (e.g. Kisski's raw demand number as text).
    """

    availability: Literal["available", "busy", "very_busy"]
    detail: str


class LLMModel(TypedDict):
    """One model offered by an LLMProvider."""

    id: str
    label: str
    capabilities: frozenset[str]
    status: ModelStatus | None


class LLMProvider(ABC):
    """Base class for a registered LLM inference connector.

    Instances (not classes) are registered into LLMProviderRegistry, since
    each instance already carries its own resolved config (base URL, API
    key) constructed by the owning plugin.
    """

    id: str
    label: str

    def is_available(self) -> bool:
        """Whether this provider instance is usable (e.g. has a valid API key).

        Default True; override when a provider can be constructed without
        yet knowing whether it's actually usable.
        """
        return True

    @abstractmethod
    def list_models(self) -> list[LLMModel]:
        """Return the models this provider currently offers."""
        ...

    @abstractmethod
    async def chat_completion(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
    ) -> str:
        """Run a single chat completion and return the response text."""
        ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_registry`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/llm/base.py tests/unit/fastapi/test_llm_registry.py
git commit -m "$(cat <<'EOF'
feat(llm): add core LLMProvider/LLMModel/ModelStatus base types

First piece of the generic LLM provider registry (Part A of the
2026-09-24 annotation-review design) - generalizes the ad hoc
Kisski-only OpenAI-compatible integration so any future provider
plugin can register a connector without hardcoded coupling.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `LLMProviderRegistry`

**Files:**
- Create: `fastapi_app/lib/llm/registry.py`
- Modify: `tests/unit/fastapi/test_llm_registry.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/fastapi/test_llm_registry.py`, replacing the `if __name__` block at the end with the new class plus the same block:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_registry`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.llm.registry'`

- [ ] **Step 3: Write the implementation**

```python
"""
Registry for LLM provider connectors.

Provider plugins register an already-configured LLMProvider instance here
during their `initialize()` lifecycle hook (not `__init__` - see the
two-phase load in fastapi_app/lib/plugins/plugin_registry.py). Consumers
query it lazily (e.g. inside a route handler), never via a plugin
`dependencies` declaration - HTTP routes only start receiving requests
after every plugin has finished `initialize()`, so registration order
between provider and consumer plugins never matters.
"""

import logging

from .base import LLMProvider

logger = logging.getLogger(__name__)


class LLMProviderRegistry:
    """Singleton registry of LLM provider connectors, mirroring ExtractorRegistry."""

    _instance: "LLMProviderRegistry | None" = None

    def __init__(self):
        self._providers: dict[str, LLMProvider] = {}

    @classmethod
    def get_instance(cls) -> "LLMProviderRegistry":
        """Get the singleton registry instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton instance. Used for testing."""
        cls._instance = None

    def register(self, provider: LLMProvider) -> None:
        """Register a provider instance. Called by plugins during initialize()."""
        self._providers[provider.id] = provider
        logger.debug(f"Registered LLM provider: {provider.id}")

    def unregister(self, provider_id: str) -> None:
        """Unregister a provider. Called by plugins during cleanup(). No-op if absent."""
        if provider_id in self._providers:
            del self._providers[provider_id]

    def list_providers(self, available_only: bool = True) -> list[LLMProvider]:
        """List registered providers, optionally filtered to available ones."""
        providers = []
        for provider in self._providers.values():
            if available_only and not provider.is_available():
                continue
            providers.append(provider)
        return providers

    def get_provider(self, provider_id: str) -> LLMProvider:
        """Get a registered provider by id.

        Raises:
            KeyError: If no provider with that id is registered.
        """
        if provider_id not in self._providers:
            raise KeyError(f"LLM provider '{provider_id}' not found")
        return self._providers[provider_id]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_registry`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/llm/registry.py tests/unit/fastapi/test_llm_registry.py
git commit -m "$(cat <<'EOF'
feat(llm): add LLMProviderRegistry singleton

Mirrors the existing ExtractorRegistry pattern. Registers already-
constructed provider instances (not classes) since each instance
carries its own resolved config.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `OpenAICompatibleProvider` + shared chat-completion function

**Files:**
- Create: `fastapi_app/lib/llm/openai_compatible.py`
- Create: `tests/unit/fastapi/test_llm_openai_compatible.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for the OpenAI-compatible LLM provider connector.

@testCovers fastapi_app/lib/llm/openai_compatible.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm.openai_compatible import (
    OpenAICompatibleProvider,
    chat_completion_sync,
)


class TestChatCompletionSync(unittest.TestCase):
    """Test the shared sync HTTP call, independent of any provider instance."""

    @patch("fastapi_app.lib.llm.openai_compatible.get_retry_session")
    def test_posts_expected_payload_and_returns_content(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "hello world"}}]
        }
        mock_session.post.return_value = mock_response
        mock_get_session.return_value = mock_session

        result = chat_completion_sync(
            base_url="https://example.com/v1",
            api_key="secret-key",
            model_id="test-model",
            system_prompt="You are helpful",
            user_prompt="Hi",
            temperature=0.5,
        )

        self.assertEqual(result, "hello world")
        mock_session.post.assert_called_once()
        call_args = mock_session.post.call_args
        self.assertEqual(call_args[0][0], "https://example.com/v1/chat/completions")
        self.assertEqual(call_args[1]["headers"]["Authorization"], "Bearer secret-key")
        self.assertEqual(call_args[1]["json"]["model"], "test-model")
        self.assertEqual(call_args[1]["json"]["temperature"], 0.5)
        self.assertEqual(
            call_args[1]["json"]["messages"],
            [
                {"role": "system", "content": "You are helpful"},
                {"role": "user", "content": "Hi"},
            ],
        )

    @patch("fastapi_app.lib.llm.openai_compatible.get_retry_session")
    def test_returns_empty_string_when_no_choices(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {"choices": []}
        mock_session.post.return_value = mock_response
        mock_get_session.return_value = mock_session

        result = chat_completion_sync(
            base_url="https://example.com/v1",
            api_key="k",
            model_id="m",
            system_prompt="s",
            user_prompt="u",
        )
        self.assertEqual(result, "")


class TestOpenAICompatibleProvider(unittest.TestCase):
    """Test the provider class wrapping the shared function."""

    def test_is_available_true_with_api_key(self):
        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key="k"
        )
        self.assertTrue(provider.is_available())

    def test_is_available_false_without_api_key(self):
        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key=""
        )
        self.assertFalse(provider.is_available())

    @patch("fastapi_app.lib.llm.openai_compatible.get_retry_session")
    def test_list_models_parses_data_array(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [
                {"id": "model-a", "name": "Model A"},
                {"id": "model-b"},
            ]
        }
        mock_session.get.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key="k"
        )
        models = provider.list_models()

        self.assertEqual(len(models), 2)
        self.assertEqual(models[0]["id"], "model-a")
        self.assertEqual(models[0]["label"], "Model A")
        self.assertEqual(models[1]["label"], "model-b")  # falls back to id
        self.assertIsNone(models[0]["status"])
        self.assertIn("chat", models[0]["capabilities"])

    async def test_chat_completion_delegates_to_shared_function(self):
        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key="k"
        )
        with patch(
            "fastapi_app.lib.llm.openai_compatible.chat_completion_sync",
            return_value="async result",
        ) as mock_fn:
            result = await provider.chat_completion(
                model_id="m", system_prompt="s", user_prompt="u", temperature=0.3
            )
        self.assertEqual(result, "async result")
        mock_fn.assert_called_once_with(
            base_url="https://example.com/v1",
            api_key="k",
            model_id="m",
            system_prompt="s",
            user_prompt="u",
            temperature=0.3,
        )


if __name__ == "__main__":
    unittest.main()
```

Note: `test_chat_completion_delegates_to_shared_function` is an `async def` inside a plain `unittest.TestCase` — the project's test runner must support this (it does; see `TestExtractionFileref(unittest.IsolatedAsyncioTestCase)` precedent in `tests/unit/fastapi/test_extraction.py`). Use `unittest.IsolatedAsyncioTestCase` instead of `unittest.TestCase` for `TestOpenAICompatibleProvider` to support the `async def test_...` method — fix this in the test class declaration before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_openai_compatible`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.lib.llm.openai_compatible'`

- [ ] **Step 3: Write the implementation**

```python
"""
Concrete LLMProvider for endpoints speaking the OpenAI chat/completions
wire format: POST {base_url}/chat/completions, GET {base_url}/models.

chat_completion_sync() is a free function (not a method) so it can be
reused directly by fastapi_app/plugins/kisski/extractor.py's existing
_call_llm, eliminating duplicate HTTP-call code between the extraction
feature and this new registry, without either one depending on the
other's class hierarchy.
"""

import asyncio
import logging

from fastapi_app.lib.extraction.http_utils import get_retry_session

from .base import LLMModel, LLMProvider

logger = logging.getLogger(__name__)


def chat_completion_sync(
    base_url: str,
    api_key: str,
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.2,
) -> str:
    """Synchronously call an OpenAI-compatible chat/completions endpoint."""
    session = get_retry_session(retries=3, backoff_factor=2.0)
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    data = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
    }
    response = session.post(url, headers=headers, json=data, timeout=120)
    response.raise_for_status()
    result = response.json()
    choices = result.get("choices", [])
    if choices:
        return choices[0]["message"]["content"]
    return ""


class OpenAICompatibleProvider(LLMProvider):
    """Concrete base for providers speaking the OpenAI chat/completions wire format."""

    def __init__(self, id: str, label: str, base_url: str, api_key: str):
        self.id = id
        self.label = label
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    def is_available(self) -> bool:
        return bool(self._api_key)

    def list_models(self) -> list[LLMModel]:
        session = get_retry_session(retries=3, backoff_factor=1.0)
        url = f"{self._base_url}/models"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        entries = response.json().get("data", [])
        return [
            LLMModel(
                id=entry["id"],
                label=entry.get("name", entry["id"]),
                capabilities=frozenset({"chat"}),
                status=None,
            )
            for entry in entries
            if "id" in entry
        ]

    async def chat_completion(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
    ) -> str:
        return await asyncio.to_thread(
            chat_completion_sync,
            base_url=self._base_url,
            api_key=self._api_key,
            model_id=model_id,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
        )
```

- [ ] **Step 4: Fix the async test class and run**

In `tests/unit/fastapi/test_llm_openai_compatible.py`, change:
```python
class TestOpenAICompatibleProvider(unittest.TestCase):
```
to:
```python
class TestOpenAICompatibleProvider(unittest.IsolatedAsyncioTestCase):
```

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_openai_compatible`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/llm/openai_compatible.py tests/unit/fastapi/test_llm_openai_compatible.py
git commit -m "$(cat <<'EOF'
feat(llm): add OpenAICompatibleProvider and shared chat_completion_sync

chat_completion_sync is a free function so kisski/extractor.py's
existing _call_llm can delegate to it directly in a later task,
without introducing a dependency on the provider class hierarchy.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Package `__init__.py` re-exports

**Files:**
- Create: `fastapi_app/lib/llm/__init__.py`

- [ ] **Step 1: Write the implementation**

No test needed for this step alone — it's exercised by every subsequent task's imports (e.g. `from fastapi_app.lib.llm import LLMProviderRegistry` in Task 5).

```python
"""LLM provider registry package - see base.py for the design rationale."""

from .base import LLMModel, LLMProvider, ModelStatus
from .openai_compatible import OpenAICompatibleProvider, chat_completion_sync
from .registry import LLMProviderRegistry

__all__ = [
    "LLMModel",
    "LLMProvider",
    "ModelStatus",
    "OpenAICompatibleProvider",
    "chat_completion_sync",
    "LLMProviderRegistry",
]
```

- [ ] **Step 2: Verify existing tests still pass with the package import**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm`
Expected: PASS (all tests from Tasks 1-3, unchanged)

- [ ] **Step 3: Commit**

```bash
git add fastapi_app/lib/llm/__init__.py
git commit -m "$(cat <<'EOF'
feat(llm): re-export public symbols from fastapi_app.lib.llm

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Core router `GET /api/v1/llm/providers`

**Files:**
- Create: `fastapi_app/routers/llm.py`
- Modify: `fastapi_app/main.py:209-235` (router import block), `fastapi_app/main.py:240-266` (router mount block)
- Create: `tests/unit/fastapi/test_llm_router.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for the LLM provider listing router.

@testCovers fastapi_app/routers/llm.py
"""

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.routers.llm import router
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry, ModelStatus


class _StubProvider(LLMProvider):
    def __init__(self, id: str, label: str, models: list[LLMModel]):
        self.id = id
        self.label = label
        self._models = models

    def list_models(self) -> list[LLMModel]:
        return self._models

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        return ""


class TestListProvidersRoute(unittest.TestCase):
    """Test GET /llm/providers."""

    def setUp(self):
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

    def test_requires_authentication(self):
        self.app.dependency_overrides.clear()
        response = self.client.get("/llm/providers")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_router`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.routers.llm'`

- [ ] **Step 3: Write the router implementation**

```python
"""
LLM provider router.

Exposes the registered LLM provider connectors (fastapi_app/lib/llm/) for
any frontend consumer to list - e.g. the default-model picker and the
annotation-review plugin (both in later plans). Modeled directly on
fastapi_app/routers/extraction.py's GET /extract/list route.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..lib.core.dependencies import require_authenticated_user
from ..lib.llm import LLMProviderRegistry

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/llm", tags=["llm"])


class ModelStatusResponse(BaseModel):
    availability: str
    detail: str


class ModelResponse(BaseModel):
    id: str
    label: str
    capabilities: list[str]
    status: ModelStatusResponse | None


class ProviderResponse(BaseModel):
    id: str
    label: str
    models: list[ModelResponse]


@router.get("/providers", response_model=list[ProviderResponse])
def list_providers(
    current_user: dict = Depends(require_authenticated_user),
) -> list[ProviderResponse]:
    """List available LLM providers and their models."""
    try:
        providers = LLMProviderRegistry.get_instance().list_providers(available_only=True)
        return [
            ProviderResponse(
                id=provider.id,
                label=provider.label,
                models=[
                    ModelResponse(
                        id=model["id"],
                        label=model["label"],
                        capabilities=sorted(model["capabilities"]),
                        status=(
                            ModelStatusResponse(**model["status"])
                            if model["status"] is not None
                            else None
                        ),
                    )
                    for model in provider.list_models()
                ],
            )
            for provider in providers
        ]
    except Exception as e:
        logger.error(f"Error listing LLM providers: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list LLM providers: {str(e)}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi --grep test_llm_router`
Expected: PASS (4 tests)

- [ ] **Step 5: Mount the router in `fastapi_app/main.py`**

In `fastapi_app/main.py`, find the router import block (currently lines 209-235):

```python
from .routers import (
    plugins,
    files_list,
    files_serve,
    files_upload,
    files_save,
    files_delete,
    files_gc,
    files_repopulate,
    files_move,
    files_copy,
    files_locks,
    files_heartbeat,
    files_export,
    files_import,
    files_metadata,
    files_permissions,
    validation,
    extraction,
    sse,
    maintenance,
    collections,
    users,
    groups,
    roles,
    projects
)
```

Add `llm,` right after `extraction,`:

```python
    validation,
    extraction,
    llm,
    sse,
```

Then find the `api_v1.include_router(...)` block (currently lines 240-266) and add the new router right after `extraction.router`, before `files_serve.router` (which must stay last — it has a catch-all route):

```python
api_v1.include_router(extraction.router)
api_v1.include_router(llm.router)  # LLM provider registry
api_v1.include_router(files_list.router)
```

- [ ] **Step 6: Verify the full app still starts and the route is mounted**

Run: `uv run python -c "from fastapi_app.main import app; routes = [r.path for r in app.routes]; assert '/api/v1/llm/providers' in routes, routes; print('OK: /api/v1/llm/providers is mounted')"`
Expected: `OK: /api/v1/llm/providers is mounted`

- [ ] **Step 7: Regenerate the frontend API client**

Run: `npm run generate-client`
Expected: exits 0, and `app/src/modules/api-client-v1.js` now contains a generated method for `GET /api/v1/llm/providers` (grep the file for `llmProviders` or similar generated method name to confirm — exact naming is determined by `scripts/build/generate-api-client.js`'s own convention, not hand-written).

- [ ] **Step 8: Commit**

```bash
git add fastapi_app/routers/llm.py fastapi_app/main.py tests/unit/fastapi/test_llm_router.py app/src/modules/api-client-v1.js
git commit -m "$(cat <<'EOF'
feat(llm): add GET /api/v1/llm/providers core route

Exposes the LLM provider registry generically, mirroring how
/extract/list exposes ExtractorRegistry - not owned by any single
plugin, since both the future default-model picker and the
annotation-review plugin need to list providers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Kisski demand-classification helper + `KisskiLLMProvider`

**Files:**
- Create: `fastapi_app/plugins/kisski/llm_provider.py`
- Create: `fastapi_app/plugins/kisski/tests/test_llm_provider.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for the KISSKI LLM provider connector, including live
demand/busy status classification.

@testCovers fastapi_app/plugins/kisski/llm_provider.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.kisski.llm_provider import (
    KisskiLLMProvider,
    _demand_to_availability,
)


class TestDemandToAvailability(unittest.TestCase):
    """Test the demand->availability threshold classification.

    Thresholds match the sibling zotero-rag project's
    backend/utils/kisski.py, reused here per the design doc.
    """

    def test_zero_demand_is_available(self):
        self.assertEqual(_demand_to_availability(0), "available")

    def test_one_demand_is_busy(self):
        self.assertEqual(_demand_to_availability(1), "busy")

    def test_five_demand_is_busy(self):
        self.assertEqual(_demand_to_availability(5), "busy")

    def test_six_demand_is_very_busy(self):
        self.assertEqual(_demand_to_availability(6), "very_busy")

    def test_large_demand_is_very_busy(self):
        self.assertEqual(_demand_to_availability(100), "very_busy")


class TestKisskiLLMProviderListModels(unittest.TestCase):
    """Test that list_models() populates ModelStatus from the demand field."""

    @patch("fastapi_app.plugins.kisski.llm_provider.get_retry_session")
    def test_list_models_populates_status_from_demand(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [
                {"id": "gemma-3-27b", "name": "Gemma 3 27B", "demand": 0},
                {"id": "llama-3-70b", "name": "Llama 3 70B", "demand": 3},
                {"id": "busy-model", "name": "Busy Model", "demand": 8},
            ]
        }
        mock_session.get.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = KisskiLLMProvider(
            id="kisski", label="KISSKI", base_url="https://chat-ai.academiccloud.de/v1", api_key="k"
        )
        models = provider.list_models()

        self.assertEqual(len(models), 3)
        self.assertEqual(models[0]["status"]["availability"], "available")
        self.assertEqual(models[0]["status"]["detail"], "demand: 0")
        self.assertEqual(models[1]["status"]["availability"], "busy")
        self.assertEqual(models[2]["status"]["availability"], "very_busy")

    @patch("fastapi_app.plugins.kisski.llm_provider.get_retry_session")
    def test_list_models_defaults_missing_demand_to_zero(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"id": "m", "name": "M"}]}
        mock_session.get.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = KisskiLLMProvider(id="kisski", label="KISSKI", base_url="https://x/v1", api_key="k")
        models = provider.list_models()

        self.assertEqual(models[0]["status"]["availability"], "available")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_llm_provider`
Expected: FAIL with `ModuleNotFoundError: No module named 'fastapi_app.plugins.kisski.llm_provider'`

- [ ] **Step 3: Write the implementation**

```python
"""
KISSKI LLM provider connector.

Registers Kisski's chat/completions endpoint into the core LLM provider
registry (fastapi_app/lib/llm/), in addition to (not instead of) its
existing ExtractorRegistry/ServiceRegistry registrations in plugin.py.

Adds live per-model demand/busy status on top of the generic
OpenAICompatibleProvider - Kisski's /models response includes a `demand`
integer per entry, which this module classifies into the shared 3-tier
ModelStatus.availability vocabulary. This classification (thresholds
0 / 1-5 / 6+) matches the sibling zotero-rag project's
backend/utils/kisski.py, reused here as the canonical thresholds rather
than inventing new ones.
"""

from typing import Literal

from fastapi_app.lib.extraction.http_utils import get_retry_session
from fastapi_app.lib.llm.base import LLMModel, ModelStatus
from fastapi_app.lib.llm.openai_compatible import OpenAICompatibleProvider


def _demand_to_availability(demand: int) -> Literal["available", "busy", "very_busy"]:
    if demand == 0:
        return "available"
    if demand <= 5:
        return "busy"
    return "very_busy"


class KisskiLLMProvider(OpenAICompatibleProvider):
    """LLM provider connector for KISSKI Academic Cloud, with live demand status."""

    def list_models(self) -> list[LLMModel]:
        session = get_retry_session(retries=3, backoff_factor=1.0)
        url = f"{self._base_url}/models"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        entries = response.json().get("data", [])
        models: list[LLMModel] = []
        for entry in entries:
            if "id" not in entry:
                continue
            demand = int(entry.get("demand", 0))
            status = ModelStatus(availability=_demand_to_availability(demand), detail=f"demand: {demand}")
            models.append(
                LLMModel(
                    id=entry["id"],
                    label=entry.get("name", entry["id"]),
                    capabilities=frozenset({"chat"}),
                    status=status,
                )
            )
        return models
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_llm_provider`
Expected: PASS (7 tests)

- [ ] **Step 5: Manual verification (not automatable in this plan — record the outcome as a follow-up note, do not skip)**

The design spec flagged an open question: does Kisski's plain `GET {base_url}/models` (used above, matching the existing `_fetch_models_from_api` in `extractor.py`) actually include the `demand` field, or is the `POST` variant (used by the sibling `zotero-rag` project) required to get it? This can only be confirmed against the real, authenticated KISSKI endpoint.

Run (with a real `KISSKI_API_KEY` set in the environment):
```bash
curl -s -X GET "https://chat-ai.academiccloud.de/v1/models" \
  -H "Authorization: Bearer $KISSKI_API_KEY" \
  -H "Accept: application/json" | python3 -m json.tool | head -30
```
- If the response entries include a `"demand"` key: no code change needed, this task's `GET`-based implementation is correct as written.
- If `"demand"` is absent: change `list_models()`'s `session.get(url, ...)` to `session.post(url, headers=headers, timeout=30)` (matching `zotero-rag/backend/utils/kisski.py:70-78`), re-run the same curl check with `-X POST`, and re-run this task's test suite (no test changes needed either way — the tests mock the HTTP layer and only assert on the parsed `demand` value).

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/kisski/llm_provider.py fastapi_app/plugins/kisski/tests/test_llm_provider.py
git commit -m "$(cat <<'EOF'
feat(kisski): add KisskiLLMProvider with live demand/busy status

Classifies Kisski's per-model demand field into the shared 3-tier
ModelStatus.availability vocabulary, thresholds matching the sibling
zotero-rag project's kisski.py.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Register `KisskiLLMProvider` in `KisskiPlugin`

**Files:**
- Modify: `fastapi_app/plugins/kisski/plugin.py`
- Modify: `fastapi_app/plugins/kisski/tests/test_extractor.py` is untouched — this task adds a new test file instead, to keep plugin-lifecycle tests separate from extractor-retry-logic tests (existing file's own scope).
- Create: `fastapi_app/plugins/kisski/tests/test_plugin_llm_registration.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Unit tests for KisskiPlugin's LLM provider registration.

@testCovers fastapi_app/plugins/kisski/plugin.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.plugins.kisski.plugin import KisskiPlugin


class TestKisskiPluginLLMRegistration(unittest.IsolatedAsyncioTestCase):
    """Test that KisskiPlugin registers/unregisters its LLM provider connector."""

    def setUp(self):
        LLMProviderRegistry.reset_instance()
        # "testing" mode short-circuits initialize()'s unrelated
        # KisskiService/ServiceRegistry branch (see plugin.py's existing
        # app_mode check) - this test suite exercises only the new LLM
        # provider registration, not that separate, already-tested path.
        self.env_patcher = patch.dict("os.environ", {"FASTAPI_APPLICATION_MODE": "testing"})
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()
        LLMProviderRegistry.reset_instance()

    def _mock_config(self, api_key, base_url="https://example.com/v1"):
        """Build a get_config() replacement returning controlled values for our two keys.

        Patching fastapi_app.plugins.kisski.plugin.get_config (rather than
        relying on real env vars + get_plugin_config's global persistence)
        keeps these tests isolated from any other test's config state.
        KisskiPlugin.__init__'s own get_plugin_config(...) calls still run
        for real underneath this patch (harmless - they just read real env
        vars, usually unset in CI, and no-op if the value is None).
        """
        values = {"plugin.kisski.api.key": api_key, "plugin.kisski.api.url": base_url}
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, *a, **kw: values.get(key)
        return mock_config

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_initialize_registers_llm_provider_when_api_key_present(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = KisskiPlugin()

        await plugin.initialize(None)  # initialize() never reads from context

        provider = LLMProviderRegistry.get_instance().get_provider("kisski")
        self.assertEqual(provider.label, "KISSKI Academic Cloud")
        self.assertTrue(provider.is_available())

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_initialize_skips_llm_provider_without_api_key(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key=None)
        plugin = KisskiPlugin()

        await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("kisski")

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_cleanup_unregisters_llm_provider(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = KisskiPlugin()
        await plugin.initialize(None)
        self.assertIsNotNone(LLMProviderRegistry.get_instance().get_provider("kisski"))

        await plugin.cleanup()

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("kisski")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_plugin_llm_registration`
Expected: FAIL — `LLMProviderRegistry.get_instance().get_provider("kisski")` raises `KeyError` in the first test (provider not yet registered, since `KisskiPlugin.initialize()` doesn't do this yet).

- [ ] **Step 3: Modify `fastapi_app/plugins/kisski/plugin.py`**

Add two imports after the existing `from fastapi_app.lib.services.service_registry import get_service_registry` line:

```python
from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.lib.utils.config_utils import get_config
```

And import the new provider class after `from .service import KisskiService`:

```python
from .llm_provider import KisskiLLMProvider
```

In `initialize()`, immediately after the existing service-registration `if/elif/else` block (right before the final `logger.info(...)` call), add:

```python
        # Register LLM provider connector (new functionality)
        api_key = get_config().get("plugin.kisski.api.key")
        base_url = get_config().get("plugin.kisski.api.url")
        if api_key:
            llm_registry = LLMProviderRegistry.get_instance()
            llm_registry.register(
                KisskiLLMProvider(
                    id="kisski",
                    label="KISSKI Academic Cloud",
                    base_url=base_url,
                    api_key=api_key,
                )
            )
            logger.info("KISSKI LLM provider registered")
        else:
            logger.warning("KISSKI LLM provider not registered - missing API key")
```

In `cleanup()`, after the existing `service_registry.unregister_service("kisski-extractor")` line, add:

```python
        # Unregister LLM provider (new functionality)
        LLMProviderRegistry.get_instance().unregister("kisski")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_plugin_llm_registration`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full Kisski plugin test suite to confirm no regression**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests`
Expected: All tests pass, including the pre-existing `test_extractor.py` (534 lines, unaffected by this task) and `test_llm_provider.py` (Task 6).

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/kisski/plugin.py fastapi_app/plugins/kisski/tests/test_plugin_llm_registration.py
git commit -m "$(cat <<'EOF'
feat(kisski): register KisskiLLMProvider into the core LLM registry

KisskiPlugin.initialize() now registers into LLMProviderRegistry
alongside its existing ExtractorRegistry/ServiceRegistry
registrations, guarded by the same API-key-present check.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Refactor `KisskiExtractor._call_llm` to use the shared function

**Files:**
- Modify: `fastapi_app/plugins/kisski/extractor.py:103-140` (`_call_llm` method)

This is a pure internal refactor — no test changes, since `fastapi_app/plugins/kisski/tests/test_extractor.py`'s existing tests always mock `extractor._call_llm` wholesale (e.g. `extractor._call_llm = MagicMock(...)`), never exercising its internals. The goal here is eliminating duplicate HTTP-call code, with the exact same observable behavior (same URL, same headers, same retry parameters, same timeout).

- [ ] **Step 1: Run the existing extractor test suite to establish the baseline (must pass before touching anything)**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_extractor`
Expected: PASS (all pre-existing tests green)

- [ ] **Step 2: Modify `_call_llm` in `fastapi_app/plugins/kisski/extractor.py`**

Add the import near the top of the file, after `from fastapi_app.lib.extraction import LLMBaseExtractor, get_retry_session`:

```python
from fastapi_app.lib.llm.openai_compatible import chat_completion_sync
```

Replace the body of `_call_llm` (currently lines 103-140):

```python
    def _call_llm(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str | None = None,
        temperature: float = 0.1,
    ) -> str:
        """Call the KISSKI API and return the response text with retry logic."""
        base_url = get_config().get("plugin.kisski.api.url")
        url = f"{base_url}/chat/completions"

        if not model or model == "":
            raise RuntimeError("No model given")

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.client}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
        }

        session = get_retry_session(retries=3, backoff_factor=2.0)
        response = session.post(url, headers=headers, json=data, timeout=120)
        response.raise_for_status()

        result = response.json()
        if "choices" in result and len(result["choices"]) > 0:
            return result["choices"][0]["message"]["content"]

        return ""
```

with:

```python
    def _call_llm(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str | None = None,
        temperature: float = 0.1,
    ) -> str:
        """Call the KISSKI API and return the response text with retry logic.

        Delegates the actual HTTP call to the shared
        fastapi_app.lib.llm.openai_compatible.chat_completion_sync, so this
        codebase has one implementation of the OpenAI-compatible
        chat/completions call, reused by both the extraction feature and
        the LLM provider registry (fastapi_app/plugins/kisski/llm_provider.py).
        """
        if not model or model == "":
            raise RuntimeError("No model given")

        base_url = get_config().get("plugin.kisski.api.url")
        return chat_completion_sync(
            base_url=base_url,
            api_key=self.client,
            model_id=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
        )
```

Note: `get_retry_session` is still imported at the top of the file (used elsewhere, e.g. `_fetch_models_from_api` and `_call_llm_multimodal`) — do not remove that import.

- [ ] **Step 3: Run the existing extractor test suite again to confirm no regression**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_extractor`
Expected: PASS, identical results to Step 1 (these tests mock `_call_llm` entirely, so this refactor is invisible to them — this confirms the mocking boundary, not the new code path directly).

- [ ] **Step 4: Write a focused new test exercising the refactored `_call_llm`'s real (mocked-HTTP) path**

Add to a new file `fastapi_app/plugins/kisski/tests/test_call_llm_delegation.py`:

```python
"""
Unit test confirming KisskiExtractor._call_llm delegates to the shared
chat_completion_sync function, rather than duplicating the HTTP call.

@testCovers fastapi_app/plugins/kisski/extractor.py:_call_llm
"""

import unittest
from unittest.mock import patch

from fastapi_app.plugins.kisski.extractor import KisskiExtractor


class TestCallLlmDelegation(unittest.TestCase):
    def test_call_llm_delegates_to_shared_chat_completion_sync(self):
        extractor = KisskiExtractor()
        extractor.client = "test-api-key"

        with patch(
            "fastapi_app.plugins.kisski.extractor.chat_completion_sync",
            return_value="delegated response",
        ) as mock_fn, patch(
            "fastapi_app.plugins.kisski.extractor.get_config"
        ) as mock_get_config:
            mock_get_config.return_value.get.return_value = "https://chat-ai.academiccloud.de/v1"

            result = extractor._call_llm(
                system_prompt="sys", user_prompt="usr", model="test-model", temperature=0.7
            )

        self.assertEqual(result, "delegated response")
        mock_fn.assert_called_once_with(
            base_url="https://chat-ai.academiccloud.de/v1",
            api_key="test-api-key",
            model_id="test-model",
            system_prompt="sys",
            user_prompt="usr",
            temperature=0.7,
        )

    def test_call_llm_raises_without_model(self):
        extractor = KisskiExtractor()
        extractor.client = "test-api-key"
        with self.assertRaises(RuntimeError):
            extractor._call_llm(system_prompt="sys", user_prompt="usr", model=None)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 5: Run to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests --grep test_call_llm_delegation`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the entire Kisski test suite one final time**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/kisski/tests`
Expected: All tests pass (existing `test_extractor.py`, plus this plan's new `test_llm_provider.py`, `test_plugin_llm_registration.py`, `test_call_llm_delegation.py`).

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/plugins/kisski/extractor.py fastapi_app/plugins/kisski/tests/test_call_llm_delegation.py
git commit -m "$(cat <<'EOF'
refactor(kisski): delegate _call_llm to shared chat_completion_sync

Behavior-preserving: same URL, headers, retry params, and timeout.
Existing test_extractor.py tests are unaffected since they mock
_call_llm wholesale; this adds a focused test exercising the real
(HTTP-mocked) delegation path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full FastAPI unit test suite**

Run: `npm run test:unit:fastapi`
Expected: All tests pass, including every test added in this plan plus the full pre-existing suite (no regressions anywhere else in the backend).

- [ ] **Step 2: Confirm the app still starts cleanly with the real (non-test) plugin loader**

Run: `uv run python -c "
from fastapi_app.main import app
from fastapi_app.lib.llm import LLMProviderRegistry
print('Registered LLM providers:', [p.id for p in LLMProviderRegistry.get_instance().list_providers(available_only=False)])
"`
Expected: Exits 0. If `KISSKI_API_KEY` is set in the environment, `kisski` appears in the printed list; if not, the list is empty (or contains only whatever other plugins are configured) — either is correct, confirming the "missing key -> skipped, not crashed" behavior from Task 7.

- [ ] **Step 3: Verify `KisskiService`'s role doesn't overlap with the new LLM provider registration**

The design spec flagged this as unverified: `KisskiPlugin.initialize()` already registers a `KisskiService` into the generic `ServiceRegistry` (`fastapi_app/plugins/kisski/plugin.py`, untouched by this plan). Read `fastapi_app/plugins/kisski/service.py` in full and answer: what capability string(s) does `KisskiService` register under, and what does it actually do? Confirm it is unrelated to raw chat-completion (e.g. it's likely the existing `structured-data-extraction` capability consumed by `ExtractionService`, per `fastapi_app/lib/services/service_registry.py`'s `get_extraction_service()` convenience method) — i.e. a different concern from this plan's new `LLMProviderRegistry` registration, not a duplicate or competing implementation. Record the finding in this task's commit message or a follow-up note; no code change is expected, but if an actual overlap is found, stop and reconsider before starting the next plan.

- [ ] **Step 4: No commit needed for this task** — it's a verification checkpoint before moving to the next plan (default-model selection plugin, which depends on `GET /api/v1/llm/providers` being live).
