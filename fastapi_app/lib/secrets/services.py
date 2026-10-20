"""
Registry of services that need a secret from the user.

A plugin registers the services whose API keys users supply themselves, so that
the frontend can show a meaningful prompt (label, where to get a key) when a key
is missing.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class SecretService:
    """A service that requires a user-supplied secret."""

    id: str
    label: str
    description: str = ""
    help_url: str = ""


class MissingSecretError(Exception):
    """The user has not stored the secret a service needs."""

    def __init__(self, service: str, username: str | None = None):
        self.service = service
        self.username = username
        super().__init__(f"No API key stored for service '{service}'")


class SecretServiceRegistry:
    """Known secret services by id."""

    _services: dict[str, SecretService] = {}

    @classmethod
    def register(cls, service: SecretService) -> None:
        """Register a service; a later registration with the same id replaces the earlier one."""
        cls._services[service.id] = service

    @classmethod
    def get(cls, service_id: str) -> SecretService | None:
        """The registered service, or None."""
        return cls._services.get(service_id)

    @classmethod
    def describe(cls, service_id: str) -> SecretService:
        """The registered service, or a placeholder with the id as label for unregistered ones."""
        return cls._services.get(service_id) or SecretService(id=service_id, label=service_id)

    @classmethod
    def list(cls) -> list[SecretService]:
        """All registered services, sorted by label."""
        return sorted(cls._services.values(), key=lambda s: s.label.lower())

    @classmethod
    def clear(cls) -> None:
        """Remove all registrations (for tests)."""
        cls._services.clear()


def register_secret_service(id: str, label: str, description: str = "", help_url: str = "") -> SecretService:
    """Register a service whose secret users supply themselves, see :class:`SecretService`."""
    service = SecretService(id=id, label=label, description=description, help_url=help_url)
    SecretServiceRegistry.register(service)
    return service
