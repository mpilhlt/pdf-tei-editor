# Service Registry

The service registry enables plugins to discover and consume services by capability name without hard dependencies on specific implementations.

## Overview

Plugins can:

- **Register services** with capability names (e.g., `"structured-data-extraction"`)
- **Discover services** by capability without knowing which plugin provides them
- **Consume services** with type-safe interfaces

## Registering a Service

### 1. Create a Service Class

Extend `ExtractionService` (or `BaseService` for custom services):

```python
from fastapi_app.lib.services.service_registry import ExtractionService, ExtractionParams, ExtractionResult

class MyExtractionService(ExtractionService):
    def __init__(self):
        super().__init__(
            service_id="my-extractor",
            service_name="My Extractor",
            capabilities=["structured-data-extraction"]
        )

    async def extract(self, **params: ExtractionParams) -> ExtractionResult:
        # Your extraction logic here
        return ExtractionResult(
            success=True,
            data={"extracted": "data"},
            model=params["model"],
            extractor="my-extractor",
            retries=0
        )
```

### 2. Register During Plugin Initialization

```python
from fastapi_app.lib.services.service_registry import get_service_registry

async def initialize(self, context: PluginContext) -> None:
    service_registry = get_service_registry()
    service_registry.register_service(MyExtractionService())
```

### 3. Unregister During Cleanup

```python
async def cleanup(self) -> None:
    service_registry = get_service_registry()
    service_registry.unregister_service("my-extractor")
```

## Consuming a Service

### Via PluginContext (Recommended)

```python
from fastapi_app.lib.services.service_registry import ExtractionService

async def my_endpoint(self, context: PluginContext, params: dict) -> dict:
    service = context.get_service("structured-data-extraction", ExtractionService)

    if not service:
        return {"error": "No extraction service available"}

    result = await service.extract(
        model=params.get("model", "default-model"),
        prompt=params.get("prompt", "Extract data"),
        text_input=params.get("text"),
        temperature=0.1,
        max_retries=2
    )

    return {
        "success": result["success"],
        "data": result["data"],
        "service_used": service.service_name
    }
```

### Via Direct Registry Access

```python
from fastapi_app.lib.services.service_registry import get_service_registry, ExtractionService

service_registry = get_service_registry()
service = service_registry.get_service("structured-data-extraction", ExtractionService)
```

## Available Types

### ExtractionParams

```python
class ExtractionParams(TypedDict):
    model: str
    prompt: str
    text_input: NotRequired[str | None]
    json_schema: NotRequired[dict[str, Any] | None]
    temperature: NotRequired[float]
    max_retries: NotRequired[int]
```

### ExtractionResult

```python
class ExtractionResult(TypedDict):
    success: bool
    data: dict[str, Any]
    model: str
    extractor: str
    retries: int
```

## Service Discovery

List available services and capabilities:

```python
service_registry = get_service_registry()

# List all registered services
services = service_registry.list_services()
# Returns: [{"service_id": "...", "service_name": "...", "capabilities": [...]}]

# List all available capabilities
capabilities = service_registry.list_capabilities()
# Returns: ["structured-data-extraction", ...]

# Get extraction service specifically
extraction_service = service_registry.get_extraction_service()
```

## Priority

When multiple services register the same capability, **last one wins**. Services registered later override earlier ones for that capability.

## Custom Routes for Service Testing

The test plugin provides endpoints to test service registry functionality:

- `GET /api/plugins/test-plugin/services/list` - List all services
- `GET /api/plugins/test-plugin/services/capabilities` - List capabilities
- `POST /api/plugins/test-plugin/services/test-extraction` - Test extraction service

## Example: KISSKI Service

The KISSKI plugin registers an extraction service:

```python
# fastapi_app/plugins/kisski/service.py
class KisskiService(ExtractionService):
    def __init__(self):
        super().__init__(
            service_id="kisski-extractor",
            service_name="KISSKI Extractor",
            capabilities=["structured-data-extraction"]
        )

    async def extract(self, **params: ExtractionParams) -> ExtractionResult:
        result = await self._extractor.extract(
            model=params["model"],
            prompt=params["prompt"],
            text_input=params.get("text_input"),
            json_schema=params.get("json_schema"),
            temperature=params.get("temperature", 0.1),
            max_retries=params.get("max_retries", 2)
        )
        return ExtractionResult(...)
```

## Testing

In test mode (`FASTAPI_APPLICATION_MODE=testing`), the test plugin registers a `DummyExtractionService` that returns mock data. Production services (like KISSKI) skip registration in test mode to allow the dummy service to handle requests.

See [tests/api/v1/plugin-service-registry.test.js](../../tests/api/v1/plugin-service-registry.test.js) for integration test examples.
