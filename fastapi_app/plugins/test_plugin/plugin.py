"""
Test plugin for testing the plugin system.

This plugin demonstrates the basic plugin structure and provides
a simple text analysis endpoint. Also registers the MockExtractor
for testing extraction functionality, and frontend extensions.
"""

import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, Optional, NotRequired

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.services.service_registry import ExtractionService, ExtractionResult, get_service_registry
from .extractor import MockExtractor

logger = logging.getLogger(__name__)


class DummyExtractionService(ExtractionService):
    """Dummy extraction service for testing service registry pattern."""

    def __init__(self):
        super().__init__(
            service_id="dummy-extractor",
            service_name="Dummy Extractor",
            capabilities=["structured-data-extraction"]
        )

    async def extract(
        self,
        model: str,
        prompt: str,
        stable_id: Optional[str] = None,
        text_input: Optional[str] = None,
        json_schema: Optional[Dict[str, Any]] = None,
        temperature: float = 0.1,
        max_retries: int = 2,
        **kwargs: Any,
    ) -> ExtractionResult:
        """Simulate extraction with dummy data."""
        # Check if this is a bibliographic metadata extraction request
        if "bibliographic metadata" in prompt.lower() or (
            json_schema and "authors" in json_schema.get("properties", {})
        ):
            # Return mock bibliographic metadata
            dummy_data = {
                "title": "Mock Document Title for Testing",
                "authors": [
                    {"given": "John", "family": "Doe"},
                    {"given": "Jane", "family": "Smith"},
                ],
                "date": 2024,
                "publisher": "Mock Publisher",
                "journal": "Journal of Mock Research",
                "volume": "42",
                "issue": "3",
                "pages": "123-145",
                "doi": "10.1234/mock.doi.5678"
            }
        else:
            # Create generic dummy structured data based on the prompt
            dummy_data = {
                "extracted_text": text_input or "No text provided",
                "model_used": model,
                "prompt": prompt,
                "temperature": temperature,
                "timestamp": "2024-01-01T00:00:00Z",
                "dummy_field": "This is test data from the dummy service"
            }

            # If JSON schema provided, try to validate (basic check)
            if json_schema:
                try:
                    # Basic validation - just check if required fields are present
                    required_fields = json_schema.get("required", [])
                    for field in required_fields:
                        if field not in dummy_data:
                            dummy_data[field] = f"Missing field: {field}"
                except Exception:
                    pass

        return ExtractionResult(
            success=True,
            data=dummy_data,
            model=model,
            extractor="dummy-extractor",
            retries=0
        )


class TestPlugin(Plugin):
    """
    Test plugin that performs basic text analysis and demonstrates frontend extensions.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "test-plugin",
            "name": "Test Plugin",
            "description": "Test plugin with text analysis, service consumption, and frontend extensions",
            "version": "1.0.0",
            "category": "test",
            "required_roles": ["user"],  # Requires user role
            "endpoints": [
                {
                    "name": "execute",
                    "label": "Analyze Current XML",
                    "description": "Analyze the currently open XML document",
                    "state_params": ["xml", "variant"],
                },
                {
                    "name": "info",
                    "label": "Plugin Info",
                    "description": "Get plugin information",
                    "state_params": [],
                },
                {
                    "name": "list_services",
                    "label": "List Available Services",
                    "description": "List all registered services in the system",
                    "state_params": [],
                },
                {
                    "name": "test_service_consumption",
                    "label": "Test Service Consumption",
                    "description": "Test consuming extraction services without hard dependencies",
                    "state_params": ["xml"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "execute": self.execute,
            "info": self.info,
            "list_services": self.list_services,
            "test_service_consumption": self.test_service_consumption,
        }

    @classmethod
    def is_available(cls) -> bool:
        """Test plugin available only in testing mode."""
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        return app_mode in ("testing")

    async def initialize(self, context: PluginContext) -> None:
        """Initialize plugin, register MockExtractor, DummyExtractionService, and frontend extensions."""
        # Register MockExtractor for testing
        if MockExtractor.is_available():
            registry = ExtractorRegistry.get_instance()
            registry.register(MockExtractor)
            logger.info("MockExtractor registered for testing")

        # Register DummyExtractionService for service registry testing
        service_registry = get_service_registry()
        service_registry.register_service(DummyExtractionService())
        logger.info("DummyExtractionService registered for testing")

        # Register frontend extension
        from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry

        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_dir = Path(__file__).parent / "extensions"

        extension_file = extension_dir / "hello-world.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])

        logger.info("Test plugin initialized")

    async def cleanup(self) -> None:
        """Cleanup plugin and unregister MockExtractor and DummyExtractionService."""
        # Unregister MockExtractor
        if MockExtractor.is_available():
            registry = ExtractorRegistry.get_instance()
            registry.unregister("mock-extractor")
            logger.info("MockExtractor unregistered")

        # Unregister DummyExtractionService
        service_registry = get_service_registry()
        service_registry.unregister_service("dummy-extractor")
        logger.info("DummyExtractionService unregistered")

        logger.info("Test plugin cleaned up")

    async def execute(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Execute text analysis.

        Args:
            context: Plugin context
            params: Parameters including optional 'xml', 'variant', or 'text' to analyze

        Returns:
            Analysis results with character count, word count, line count
        """
        # Extract state parameters if provided
        xml_id = params.get("xml")
        variant = params.get("variant")

        # Get text either from params or from file content
        text = params.get("text", "")

        if not text and xml_id:
            # If xml id provided but no text, fetch file content
            from fastapi_app.lib.core.dependencies import get_db, get_file_storage

            try:
                db = get_db()
                file_storage = get_file_storage()

                # Get file metadata
                from fastapi_app.lib.repository.file_repository import FileRepository
                file_repo = FileRepository(db)
                file_metadata = file_repo.get_file_by_id_or_stable_id(xml_id)

                if file_metadata and file_metadata.file_type == "tei":
                    # Read file content
                    content_bytes = file_storage.read_file(file_metadata.id, "tei")
                    if content_bytes:
                        text = content_bytes.decode("utf-8")
                    else:
                        raise ValueError(f"File content not found for {xml_id}")
                else:
                    raise ValueError(f"XML file not found: {xml_id}")
            except Exception as e:
                logger.error(f"Failed to load XML file {xml_id}: {e}")
                raise

        if not isinstance(text, str):
            raise ValueError("Parameter 'text' must be a string")

        # Perform basic analysis
        char_count = len(text)
        word_count = len(text.split())
        line_count = len(text.splitlines())

        # Count unique words
        words = text.lower().split()
        unique_words = len(set(words))

        result = {
            "analysis": {
                "character_count": char_count,
                "word_count": word_count,
                "line_count": line_count,
                "unique_words": unique_words,
                "average_word_length": (
                    sum(len(word) for word in words) / len(words) if words else 0
                ),
            },
            "text_preview": text[:100] + ("..." if len(text) > 100 else ""),
        }

        # Include document context if provided
        if xml_id:
            result["document"] = {"xml": xml_id, "variant": variant}

        return result

    async def info(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Return plugin information.

        Args:
            context: Plugin context
            params: Parameters (unused)

        Returns:
            Plugin information
        """
        return {
            "plugin": self.metadata["name"],
            "version": self.metadata["version"],
            "message": "Test plugin ready",
        }

    async def list_services(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        List all available services in the registry.
        
        This endpoint demonstrates how to discover what services are available
        without hard dependencies on specific plugins.
        """
        service_registry = get_service_registry()
        services = service_registry.list_services()
        capabilities = service_registry.list_capabilities()
        
        return {
            "success": True,
            "services": services,
            "capabilities": capabilities,
            "message": f"Found {len(services)} services providing {len(capabilities)} capabilities"
        }

    async def test_service_consumption(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Test consuming extraction services without hard dependencies.
        
        This demonstrates the service registry pattern by consuming
        extraction services without knowing which specific implementation is available.
        Uses the dummy service registered by this plugin itself.
        """
        # Get extraction service with type safety
        extraction_service = context.get_service("structured-data-extraction", ExtractionService)
        
        if not extraction_service:
            return {
                "success": False,
                "error": "No extraction service available",
                "suggestions": [
                    "Install and configure the KISSKI plugin",
                    "Install and configure the Grobid plugin",
                    "Ensure the test plugin is properly initialized"
                ],
                "available_capabilities": self._get_available_capabilities(context)
            }
        
        try:
            # Extract text from XML if provided
            text_input = params.get("text", "")
            xml_id = params.get("xml")
            
            if xml_id and not text_input:
                # Load XML content from file
                text_input = await self._load_xml_content(context, xml_id)
                if not text_input:
                    return {
                        "success": False,
                        "error": f"Could not load content from XML file: {xml_id}"
                    }
            
            if not text_input:
                text_input = "Sample text for extraction testing"
            
            # Use the service with typed parameters
            result = await extraction_service.extract(
                model=params.get("model", "dummy-model"),
                prompt=params.get("prompt", "Extract key information from this text"),
                text_input=text_input, # type: ignore
                json_schema=params.get("json_schema"), # type: ignore
                temperature=params.get("temperature", 0.1),
                max_retries=params.get("max_retries", 2)
            )
            
            return {
                "success": True,
                "data": result,
                "service_used": extraction_service.service_name,
                "service_id": extraction_service.service_id,
                "message": f"Successfully used {extraction_service.service_name} service for extraction (no hard dependency!)"
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"Service consumption failed: {str(e)}",
                "service_used": extraction_service.service_name if extraction_service else "None",
                "service_id": extraction_service.service_id if extraction_service else "None"
            }
    
    async def _load_xml_content(self, context: PluginContext, xml_id: str) -> str | None:
        """Load XML content from file storage."""
        try:
            from fastapi_app.lib.core.dependencies import get_db, get_file_storage
            from fastapi_app.lib.repository.file_repository import FileRepository

            db = get_db()
            file_storage = get_file_storage()
            file_repo = FileRepository(db)
            
            file_metadata = file_repo.get_file_by_id_or_stable_id(xml_id)
            if file_metadata and file_metadata.file_type == "tei":
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if content_bytes:
                    return content_bytes.decode("utf-8")
        except Exception as e:
            logger.error(f"Failed to load XML content for {xml_id}: {e}")
        
        return None
    
    def _get_available_capabilities(self, context: PluginContext) -> list[str]:
        """Get list of available capabilities from the service registry."""
        service_registry = get_service_registry()
        return service_registry.list_capabilities()
