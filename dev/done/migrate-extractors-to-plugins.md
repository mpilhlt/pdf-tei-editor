# Migration: Extractors to Plugin System

**Issue:** [#217](https://github.com/mpilhlt/pdf-tei-editor/issues/217)
**Status:** Completed

## Overview

Migrate the extractor system from custom auto-discovery to the plugin architecture. Extractors will register themselves via `ExtractorRegistry` which moves to `lib/extraction/`. Each extractor becomes a plugin that registers its extractor class during initialization.

## Current Architecture

```
fastapi_app/extractors/
├── __init__.py              # BaseExtractor ABC
├── discovery.py             # ExtractorRegistry with auto-discovery
├── http_utils.py            # Retry session utilities
├── llm_base_extractor.py    # LLMBaseExtractor ABC for LLM-based extractors
├── grobid_training_extractor.py
├── llamore_extractor.py
├── kisski_extractor.py
└── mock_extractor.py        # Test-only extractor
```

The current `ExtractorRegistry._discover_extractors()` scans for `*_extractor.py` files and auto-registers classes. This duplicates the plugin discovery mechanism.

## Target Architecture

```
fastapi_app/lib/extraction/
├── __init__.py              # Exports BaseExtractor, ExtractorRegistry, etc.
├── base.py                  # BaseExtractor ABC (from extractors/__init__.py)
├── llm_base.py              # LLMBaseExtractor ABC (from llm_base_extractor.py)
├── registry.py              # ExtractorRegistry (simplified, no auto-discovery)
└── http_utils.py            # Retry session utilities (from extractors/)

fastapi_app/plugins/
├── grobid/
│   ├── __init__.py
│   ├── plugin.py            # GrobidPlugin registers GrobidTrainingExtractor
│   └── extractor.py         # GrobidTrainingExtractor class
├── llamore/
│   ├── __init__.py
│   ├── plugin.py            # LLamorePlugin registers LLamoreExtractor
│   └── extractor.py         # LLamoreExtractor class
├── kisski/
│   ├── __init__.py
│   ├── plugin.py            # KisskiPlugin registers KisskiExtractor
│   └── extractor.py         # KisskiExtractor class
└── sample_analyzer/         # Existing - add MockExtractor registration
    ├── __init__.py
    ├── plugin.py            # Extend to register MockExtractor in testing mode
    └── extractor.py         # MockExtractor class (from mock_extractor.py)
```

## Implementation Steps

### Phase 1: Create lib/extraction Module

1. Create `fastapi_app/lib/extraction/` directory

2. Create `base.py` with `BaseExtractor` ABC (copy from `extractors/__init__.py`)

3. Create `llm_base.py` with `LLMBaseExtractor` ABC (copy from `llm_base_extractor.py`)

4. Create `http_utils.py` (copy from `extractors/http_utils.py`)

5. Create `registry.py` with simplified `ExtractorRegistry`:

   ```python
   class ExtractorRegistry:
       """Registry for managing extraction engines."""
       _instance: "ExtractorRegistry | None" = None

       def __init__(self):
           self._extractors: Dict[str, Type[BaseExtractor]] = {}

       @classmethod
       def get_instance(cls) -> "ExtractorRegistry":
           if cls._instance is None:
               cls._instance = cls()
           return cls._instance

       def register(self, extractor_class: Type[BaseExtractor]) -> None:
           """Register an extractor class. Called by plugins during initialization."""
           info = extractor_class.get_info()
           extractor_id = info.get('id')
           if extractor_id:
               self._extractors[extractor_id] = extractor_class
               print(f"Registered extractor: {extractor_id}")

       def unregister(self, extractor_id: str) -> None:
           """Unregister an extractor. Called by plugins during cleanup."""
           if extractor_id in self._extractors:
               del self._extractors[extractor_id]

       # Keep existing list_extractors, get_extractor, create_extractor methods
   ```

6. Create `__init__.py` exporting:
   - `BaseExtractor`
   - `LLMBaseExtractor`
   - `ExtractorRegistry`
   - Convenience functions: `list_extractors`, `get_extractor`, `create_extractor`

### Phase 2: Create Grobid Plugin

1. Create `fastapi_app/plugins/grobid/` directory

2. Create `extractor.py`:
   - Copy `GrobidTrainingExtractor` from `grobid_training_extractor.py`
   - Update imports to use `fastapi_app.lib.extraction`

3. Create `plugin.py`:

   ```python
   from fastapi_app.lib.plugin_base import Plugin, PluginContext
   from fastapi_app.lib.extraction import ExtractorRegistry
   from .extractor import GrobidTrainingExtractor

   class GrobidPlugin(Plugin):
       @property
       def metadata(self) -> dict:
           return {
               "id": "grobid",
               "name": "GROBID Extractor",
               "description": "Extract training data using GROBID server",
               "category": "extractor",
               "version": "1.0.0",
               "required_roles": ["user"],
               "endpoints": []  # No menu items - accessed via extraction API
           }

       def get_endpoints(self) -> dict:
           return {}  # Extractor accessed via /api/v1/extract endpoint

       @classmethod
       def is_available(cls) -> bool:
           return GrobidTrainingExtractor.is_available()

       async def initialize(self, context: PluginContext) -> None:
           registry = ExtractorRegistry.get_instance()
           registry.register(GrobidTrainingExtractor)

       async def cleanup(self) -> None:
           registry = ExtractorRegistry.get_instance()
           registry.unregister("grobid")
   ```

4. Create `__init__.py`:

   ```python
   from .plugin import GrobidPlugin
   __all__ = ["GrobidPlugin"]
   ```

### Phase 3: Create LLamore Plugin

1. Create `fastapi_app/plugins/llamore/` directory

2. Create `extractor.py`:
   - Copy `LLamoreExtractor` from `llamore_extractor.py`
   - Update imports to use `fastapi_app.lib.extraction`

3. Create `plugin.py`:

   ```python
   from fastapi_app.lib.plugin_base import Plugin, PluginContext
   from fastapi_app.lib.extraction import ExtractorRegistry
   from .extractor import LLamoreExtractor

   class LLamorePlugin(Plugin):
       @property
       def metadata(self) -> dict:
           return {
               "id": "llamore",
               "name": "LLamore Extractor",
               "description": "Extract references using LLamore with Gemini AI",
               "category": "extractor",
               "version": "1.0.0",
               "required_roles": ["user"],
               "endpoints": []
           }

       def get_endpoints(self) -> dict:
           return {}

       @classmethod
       def is_available(cls) -> bool:
           return LLamoreExtractor.is_available()

       async def initialize(self, context: PluginContext) -> None:
           registry = ExtractorRegistry.get_instance()
           registry.register(LLamoreExtractor)

       async def cleanup(self) -> None:
           registry = ExtractorRegistry.get_instance()
           registry.unregister("llamore-gemini")
   ```

4. Create `__init__.py`

### Phase 4: Create KISSKI Plugin

1. Create `fastapi_app/plugins/kisski/` directory

2. Create `extractor.py`:
   - Copy `KisskiExtractor` from `kisski_extractor.py`
   - Update imports to use `fastapi_app.lib.extraction`

3. Create `plugin.py` following same pattern as above

4. Create `__init__.py`

### Phase 5: Add MockExtractor to sample_analyzer Plugin

1. Create `fastapi_app/plugins/sample_analyzer/extractor.py`:
   - Copy `MockExtractor` from `mock_extractor.py`
   - Update imports to use `fastapi_app.lib.extraction`

2. Update `fastapi_app/plugins/sample_analyzer/plugin.py`:
   - Import `ExtractorRegistry` and `MockExtractor`
   - In `initialize()`: Register `MockExtractor` if in testing mode
   - In `cleanup()`: Unregister `MockExtractor`

### Phase 6: Update lib/extractor_manager.py

Update `fastapi_app/lib/extractor_manager.py` to use new registry:

```python
from fastapi_app.lib.extraction import (
    list_extractors as _list_extractors,
    create_extractor as _create_extractor,
    get_extractor as _get_extractor,
    BaseExtractor
)

# Rest of module stays the same - just updated imports
```

### Phase 7: Update Extraction Router

Update `fastapi_app/routers/extraction.py`:

- Update imports to use `fastapi_app.lib.extraction`

### Phase 8: Delete Old Extractors Directory

After verifying everything works:

1. Delete `fastapi_app/extractors/` directory entirely

2. Update any remaining imports that reference `fastapi_app.extractors`

## File Changes Summary

### New Files

- `fastapi_app/lib/extraction/__init__.py`
- `fastapi_app/lib/extraction/base.py`
- `fastapi_app/lib/extraction/llm_base.py`
- `fastapi_app/lib/extraction/registry.py`
- `fastapi_app/lib/extraction/http_utils.py`
- `fastapi_app/plugins/grobid/__init__.py`
- `fastapi_app/plugins/grobid/plugin.py`
- `fastapi_app/plugins/grobid/extractor.py`
- `fastapi_app/plugins/llamore/__init__.py`
- `fastapi_app/plugins/llamore/plugin.py`
- `fastapi_app/plugins/llamore/extractor.py`
- `fastapi_app/plugins/kisski/__init__.py`
- `fastapi_app/plugins/kisski/plugin.py`
- `fastapi_app/plugins/kisski/extractor.py`
- `fastapi_app/plugins/sample_analyzer/extractor.py`

### Modified Files

- `fastapi_app/lib/extractor_manager.py` - Update imports
- `fastapi_app/routers/extraction.py` - Update imports
- `fastapi_app/plugins/sample_analyzer/plugin.py` - Add MockExtractor registration

### Deleted Files

- `fastapi_app/extractors/__init__.py`
- `fastapi_app/extractors/discovery.py`
- `fastapi_app/extractors/http_utils.py`
- `fastapi_app/extractors/llm_base_extractor.py`
- `fastapi_app/extractors/grobid_training_extractor.py`
- `fastapi_app/extractors/llamore_extractor.py`
- `fastapi_app/extractors/kisski_extractor.py`
- `fastapi_app/extractors/mock_extractor.py`

## Testing

1. Run existing extraction tests to verify extractors still work
2. Verify plugin discovery includes new extractor plugins
3. Test each extractor via `/api/v1/extract` endpoint
4. Verify mock extractor only available in testing mode

## Notes

- The `category: "extractor"` in plugin metadata distinguishes extractor plugins from other plugins
- Extractor plugins have empty `endpoints` list since they're accessed via the extraction API
- The `is_available()` check is preserved in both the plugin and extractor level
- Plugin initialization order is not guaranteed, but extractors only need to be registered before first use

## Implementation Progress

### Completed

All phases implemented. Final structure:

```text
fastapi_app/lib/extraction/
├── __init__.py      # Exports all public APIs
├── base.py          # BaseExtractor ABC
├── llm_base.py      # LLMBaseExtractor ABC
├── registry.py      # ExtractorRegistry singleton
├── manager.py       # Convenience functions + should_use_mock_extractor
└── http_utils.py    # get_retry_session

fastapi_app/plugins/
├── grobid/          # GrobidPlugin + GrobidTrainingExtractor
├── llamore/         # LLamorePlugin + LLamoreExtractor
├── kisski/          # KisskiPlugin + KisskiExtractor
└── sample_analyzer/ # Extended with MockExtractor (testing mode only)
```

### Tests Added

- `tests/unit/fastapi/test_extraction_registry.py` - Registry singleton, register/unregister, filtering
- `tests/unit/fastapi/test_extractor_plugins.py` - Plugin registration/cleanup lifecycle
- `tests/unit/fastapi/test_extraction.py` - Updated imports to new locations

### Key Changes from Plan

- Added `manager.py` to `lib/extraction/` (moved from `lib/extractor_manager.py`) for cleaner module organization
- `should_use_mock_extractor` now exported from extraction module
- Router imports directly from `..lib.extraction` instead of separate manager module

### Post-Migration Fixes

- Fixed plugin loading to support relative imports: Updated `PluginRegistry._load_plugin()` to use standard `importlib.import_module()` with proper package paths instead of `spec_from_file_location()`, enabling relative imports in plugin modules
- Converted `print()` statements in `ExtractorRegistry` to `logger.debug()`/`logger.warning()` to suppress expected output during tests
