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
    """One model offered by an LLMProvider.

    `free` is True when using the model costs the operator nothing (e.g.
    KISSKI's academic cloud); paid models are False and are restricted to
    admins unless an admin picked them as the default model.
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


class LLMProviderError(Exception):
    """A provider's service rejected or failed a request (rate limit, overload, bad request); the message is user-presentable."""
