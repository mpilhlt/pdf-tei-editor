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

    def __init__(self) -> None:
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
