"""
Core LLM provider abstraction.

Generalizes ad hoc OpenAI-compatible inference integrations (previously
duplicated per extractor plugin) into a pluggable
registry any backend plugin can register a connector into, and any
consumer can query, without hardcoding provider-specific HTTP logic or
env var names.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part A) for the design rationale.
"""

from abc import ABC, abstractmethod
from typing import Literal, TypedDict


class LLMImage(TypedDict):
    """An image sent to a model along with the prompt.

    `data` holds the raw image bytes; `media_type` is one of the image MIME
    types multimodal APIs commonly accept ("image/png", "image/jpeg",
    "image/webp", "image/gif").
    """

    data: bytes
    media_type: str


class ModelStatus(TypedDict):
    """A model's live load state, when a provider exposes one.

    Deliberately provider-agnostic: `availability` is a fixed 3-tier enum
    any provider normalizes its own live-load signal onto (e.g. a numeric
    "demand" value reported by the provider's API).
    `detail` carries whatever provider-specific elaboration is useful in a
    warning tooltip (e.g. the raw demand number as text).
    """

    availability: Literal["available", "busy", "very_busy"]
    detail: str


class LLMModel(TypedDict):
    """One model offered by an LLMProvider.

    `free` is True when using the model costs the operator nothing (e.g.
    an academic cloud); paid models are False and are restricted to
    admins unless an admin picked them as the default model. Admins can
    mark further models as free via `llm.free-models` (see model_access.py).
    """

    id: str
    label: str
    capabilities: frozenset[str]
    status: ModelStatus | None
    free: bool


class LLMProvider(ABC):
    """Base class for a registered LLM inference connector.

    Instances (not classes) are registered into LLMProviderRegistry, since
    each instance already carries its own resolved config (base URL, API
    key) constructed by the owning plugin.
    """

    id: str
    label: str

    #: Id of the user secret service (see fastapi_app/lib/secrets/) holding the
    #: API key users supply themselves, or None if the provider has no per-user keys.
    secret_service: str | None = None

    def is_available(self) -> bool:
        """Whether this provider instance is usable at all.

        Default True; override when a provider can be constructed without
        yet knowing whether it's actually usable. Not about API keys: a
        provider without a shared key stays available and uses each user's
        own key (see has_shared_key() / with_api_key()).
        """
        return True

    def has_shared_key(self) -> bool:
        """Whether the provider carries an installation-wide API key (shared infrastructure).

        Default True. Providers with per-user keys return False when they were
        registered without a configured key; the registry then resolves the
        requesting user's key via with_api_key().
        """
        return True

    def with_api_key(self, api_key: str) -> "LLMProvider":
        """A copy of this provider that authenticates with `api_key` (a user's own key).

        Must be implemented by providers that set `secret_service`.
        """
        raise NotImplementedError(f"LLM provider '{self.id}' does not support per-user API keys")

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

    def supports_pdf_input(self, model_id: str) -> bool:
        """Whether chat_completion_with_pdf() can send a PDF to `model_id` as is.

        Default False; consumers then fall back to sending the PDF's text
        layer through chat_completion().
        """
        return False

    async def chat_completion_with_pdf(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        pdf_path: str,
        temperature: float = 0.2,
    ) -> str:
        """Run a chat completion with a PDF document attached to the user prompt.

        Only called when supports_pdf_input() is True.
        """
        raise NotImplementedError(f"LLM provider '{self.id}' does not accept PDF input")

    def supports_image_input(self, model_id: str) -> bool:
        """Whether chat_completion_with_images() can send images to `model_id`.

        Default False.
        """
        return False

    async def chat_completion_with_images(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        images: list[LLMImage],
        temperature: float = 0.2,
    ) -> str:
        """Run a chat completion with images attached to the user prompt, in the given order.

        Only called when supports_image_input() is True.
        """
        raise NotImplementedError(f"LLM provider '{self.id}' does not accept image input")


class LLMProviderError(Exception):
    """A provider's service rejected or failed a request (rate limit, overload, bad request); the message is user-presentable."""
