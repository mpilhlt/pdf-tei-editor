# Test Plugin

Plugin used by the test suite to exercise the plugin system. It is only available when `FASTAPI_APPLICATION_MODE=testing`.

## What It Registers

- **Menu endpoints**:
  - `execute` ("Analyze Current XML") - Character, word and line counts of the open XML document or of a `text` parameter
  - `info` ("Plugin Info") - Plugin information
  - `list_services` ("List Available Services") - Services in the service registry
  - `test_service_consumption` ("Test Service Consumption") - Calls an extraction service through the service registry without a hard dependency
- **`MockExtractor`** (`mock-extractor`): Extractor that produces TEI documents without external services, with variants `mock-default`, `mock-variant-a` and `mock-variant-b`
- **`DummyExtractionService`** (`dummy-extractor`): Service registry entry with the `structured-data-extraction` capability that returns fixed data, including mock bibliographic metadata
- **Frontend extension** [extensions/hello-world.js](extensions/hello-world.js): Adds a toolbar button (`data-test-id="hello-world-toolbar-btn"`) that opens a "Hello World" dialog, and handles the `hello-world-test.greet` extension point

## Routes

- `POST /api/plugins/test-plugin/analyze` - Text analysis
- `GET /api/plugins/test-plugin/status` - Plugin status
- `GET /api/plugins/test-plugin/services/list` - Registered services
- `POST /api/plugins/test-plugin/services/test-extraction` - Test extraction via the service registry
- `GET /api/plugins/test-plugin/services/capabilities` - Available capabilities

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Mock extractor**: [extractor.py](extractor.py)

## Technical Details

- Category: `test`
- Requires: User role or higher
- Also serves as a reference for plugin structure, service consumption and frontend extensions
