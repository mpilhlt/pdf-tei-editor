"""
Pluggable registry of resource kinds for the document rules registry. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Resource kind"). Modeled on the lazy-singleton pattern in
git_forge_adapters.py's GitForgeAdapterRegistry.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar, Literal, Optional


@dataclass(frozen=True)
class ResourceDescriptor:
    """One resource a document references, as found by a kind's discover()."""

    kind: str
    url: str    # exact URL as found in the document (may be SHA-pinned)
    key: str    # normalized resource key (see resource_key.py)
    label: str  # human-readable label for the UI
    format: Literal["markdown", "text", "xml"]


class ResourceKind(ABC):
    """A pluggable way of finding and fetching one category of document-linked resource."""

    name: str

    @abstractmethod
    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        """Find this kind's resources referenced by the document."""

    @abstractmethod
    def resolve_original(self, url: str) -> str:
        """Fetch/read the resource's original text."""


class ResourceKindRegistry:
    """Registry of resource kinds, pre-populated with the built-in kinds on first access."""

    _instance: ClassVar[Optional["ResourceKindRegistry"]] = None

    def __init__(self):
        self._kinds: dict[str, ResourceKind] = {}

    @classmethod
    def get_instance(cls) -> "ResourceKindRegistry":
        """Get the singleton registry instance, pre-populated with the built-in kinds."""
        if cls._instance is None:
            cls._instance = cls()
            from fastapi_app.lib.doc_rules.builtins import register_builtin_kinds
            register_builtin_kinds(cls._instance)
        return cls._instance

    def register(self, kind: ResourceKind) -> None:
        """
        Register a kind. Called once by core at startup for the two
        built-in kinds, or by a plugin for a custom one. A second
        registration under a name already in use silently replaces the
        first (last registration wins) - callers are responsible for
        name uniqueness; this registry does not warn on collision.
        """
        self._kinds[kind.name] = kind

    def get(self, name: str) -> Optional[ResourceKind]:
        """The registered kind named `name`, or None if nothing has registered under that name."""
        return self._kinds.get(name)

    def all(self) -> list[ResourceKind]:
        """Every registered kind, in registration order."""
        return list(self._kinds.values())


def register_resource_kind(kind: ResourceKind) -> None:
    """Register a resource kind. See ResourceKindRegistry.register()."""
    ResourceKindRegistry.get_instance().register(kind)


def get_resource_kind(name: str) -> Optional[ResourceKind]:
    """The registered kind named `name`, or None if nothing has registered under that name."""
    return ResourceKindRegistry.get_instance().get(name)


def list_resources(xml_string: str) -> list[ResourceDescriptor]:
    """
    Every resource every registered kind finds referenced by the
    document. A kind whose discover() raises propagates that exception
    to the caller rather than being skipped - deliberately deferred
    rather than an oversight, since no kind implementation exists yet
    at this point in the plan; revisit once the built-in kinds land.
    """
    results: list[ResourceDescriptor] = []
    for kind in ResourceKindRegistry.get_instance().all():
        results.extend(kind.discover(xml_string))
    return results
