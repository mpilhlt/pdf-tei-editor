"""
Service registry for plugin-to-plugin communication.

Provides capability-based service discovery without hard dependencies.
Uses last-registered-wins strategy for simplicity.
"""

from typing import Dict, List, Any, Optional, Type, TypeVar, TypedDict, NotRequired


# Type definitions for extraction services
ModelCapabilityFilter = dict[str, list[str]]
"""Filter for selecting models by capability.

Each key maps to a modality axis (e.g. "input", "output") and its value
lists the required modalities for that axis.  Example: {"input": ["image"]}
selects models that support image input.
"""


class ExtractionParams(TypedDict):
    """Parameters for extraction services."""
    prompt: str
    model: NotRequired[str | None]
    model_capabilities: NotRequired[ModelCapabilityFilter | None]
    stable_id: NotRequired[str | None]
    text_input: NotRequired[str | None]
    json_schema: NotRequired[dict[str, Any] | None]
    temperature: NotRequired[float]
    max_retries: NotRequired[int]

class ExtractionResult(TypedDict):
    """Result from extraction services."""
    success: bool
    data: dict[str, Any]
    model: str
    extractor: str
    retries: int


# Type variable for generic service retrieval
S = TypeVar('S', bound='BaseService')


class BaseService:
    """Base class for all services with real type information."""
    
    def __init__(self, service_id: str, service_name: str, capabilities: list[str]):
        self._service_id = service_id
        self._service_name = service_name
        self._capabilities = capabilities
    
    @property
    def service_id(self) -> str:
        """Unique identifier for this service."""
        return self._service_id
    
    @property
    def service_name(self) -> str:
        """Human-readable name for this service."""
        return self._service_name
    
    @property
    def capabilities(self) -> list[str]:
        """List of capabilities this service provides."""
        return self._capabilities


class ExtractionService(BaseService):
    """Service that provides structured data extraction."""
    
    async def extract(
        self,
        prompt: str,
        model: str | None = None,
        model_capabilities: ModelCapabilityFilter | None = None,
        stable_id: str | None = None,
        text_input: str | None = None,
        json_schema: dict[str, Any] | None = None,
        temperature: float = 0.1,
        max_retries: int = 2,
        **kwargs: Any
    ) -> ExtractionResult:
        """Extract structured data from text or PDF.

        Either *model* (exact ID) or *model_capabilities* (filter) must be
        provided.  When *model_capabilities* is given the service selects an
        appropriate model automatically.
        """
        raise NotImplementedError("Subclasses must implement extract method")


class ServiceRegistry:
    """Registry for managing plugin services with type safety."""
    
    def __init__(self):
        self._services: Dict[str, BaseService] = {}  # service_id -> BaseService
        self._capabilities: Dict[str, str] = {}  # capability -> service_id
    
    def register_service(self, service: BaseService) -> None:
        """Register a service. Last one wins for each capability."""
        self._services[service.service_id] = service
        
        # For each capability, the last registered service wins
        for capability in service.capabilities:
            self._capabilities[capability] = service.service_id
            # TODO: Add priority system here when multiple implementations exist
    
    def unregister_service(self, service_id: str) -> None:
        """Unregister a service."""
        if service_id in self._services:
            del self._services[service_id]
            
            # Remove from capabilities mapping
            capabilities_to_remove = [
                cap for cap, sid in self._capabilities.items() 
                if sid == service_id
            ]
            for capability in capabilities_to_remove:
                del self._capabilities[capability]
    
    def get_service(self, capability: str, service_type: Type[S]) -> S | None:
        """Get a service with type safety."""
        service_id = self._capabilities.get(capability)
        if service_id:
            service = self._services.get(service_id)
            if isinstance(service, service_type):
                return service
        return None
    
    def get_extraction_service(self) -> ExtractionService | None:
        """Get an extraction service with type safety."""
        return self.get_service("structured-data-extraction", ExtractionService)
    
    def list_services(self) -> List[Dict[str, Any]]:
        """List all registered services."""
        return [
            {
                "service_id": service.service_id,
                "service_name": service.service_name,
                "capabilities": service.capabilities
            }
            for service in self._services.values()
        ]
    
    def list_capabilities(self) -> List[str]:
        """List all available capabilities."""
        return list(self._capabilities.keys())


# Global registry instance
_service_registry = ServiceRegistry()


def get_service_registry() -> ServiceRegistry:
    """Get the global service registry instance."""
    return _service_registry