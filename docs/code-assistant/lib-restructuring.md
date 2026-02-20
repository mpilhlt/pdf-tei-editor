# Library Directory Restructuring

## Overview

The `fastapi_app/lib/` directory has been restructured to improve modularity, maintainability, and clarity of the codebase. This document describes the new organization and the rationale behind the changes.

## New Directory Structure

```
lib/
├── core/                    # Core infrastructure
│   ├── database.py         # Database manager and connection pooling
│   ├── db_schema.py        # Schema initialization
│   ├── db_utils.py         # Database utilities
│   ├── sqlite_utils.py     # SQLite-specific utilities
│   ├── database_init.py    # Database initialization
│   ├── db_init.py          # DB initialization helpers
│   ├── dependencies.py     # FastAPI dependency injection
│   ├── locking.py          # File locking system
│   ├── sessions.py         # Session management
│   ├── schema_validator.py # Schema validation
│   ├── data_restore.py     # Data restoration utilities
│   ├── migration_runner.py # Migration execution
│   └── migrations/         # Migration system
│       ├── base.py
│       ├── manager.py
│       ├── utils.py
│       └── versions/       # Migration versions (m001-m008)
├── models/                  # Pydantic data models
│   ├── models.py           # Core models (FileMetadata, etc.)
│   ├── models_files.py     # File operation models
│   ├── models_extraction.py # Extraction models
│   ├── models_permissions.py # Permission models
│   ├── models_sync.py      # Sync models
│   └── models_validation.py # Validation models
├── repository/              # Data access layer
│   ├── file_repository.py  # File metadata repository
│   └── permissions_db.py   # Permissions database
├── services/                # Business logic services
│   ├── metadata_extraction.py # Metadata extraction service
│   ├── metadata_update_utils.py # Metadata update utilities
│   ├── sync_service.py     # WebDAV sync service
│   ├── statistics.py       # Statistics calculation
│   └── service_registry.py # Service registry
├── storage/                 # File storage system
│   ├── file_storage.py     # File storage operations
│   ├── file_importer.py    # File import utilities
│   ├── file_exporter.py    # File export utilities
│   ├── file_zip_exporter.py # ZIP export
│   ├── file_zip_importer.py # ZIP import
│   ├── storage_gc.py       # Garbage collection
│   └── storage_references.py # Reference counting
├── permissions/             # Access control system
│   ├── access_control.py   # Access control manager
│   ├── acl_utils.py        # ACL utilities
│   ├── role_utils.py       # Role management
│   ├── group_utils.py      # Group management
│   └── user_utils.py       # User utilities
├── plugins/                 # Plugin system (generic)
│   ├── plugin_base.py      # Plugin base classes
│   ├── plugin_manager.py   # Plugin lifecycle management
│   ├── plugin_registry.py  # Plugin registration
│   ├── plugin_tools.py     # Plugin utilities
│   └── frontend_extension_registry.py # Frontend extensions
├── extraction/              # Extraction framework (generic)
│   ├── base.py             # BaseExtractor class
│   ├── llm_base.py         # LLM extractor base
│   ├── registry.py         # Extractor registry
│   ├── manager.py          # Extractor management
│   └── http_utils.py       # HTTP utilities
├── sse/                     # Server-Sent Events
│   ├── sse_service.py      # SSE service
│   ├── sse_utils.py        # SSE utilities
│   ├── sse_log_handler.py  # Log streaming
│   └── event_bus.py        # Event bus
├── utils/                   # Common utilities
│   ├── config_utils.py     # Configuration management
│   ├── auth.py             # Authentication
│   ├── doi_utils.py        # DOI utilities
│   ├── tei_utils.py        # TEI processing
│   ├── xml_utils.py        # XML utilities
│   ├── cache_utils.py      # Caching
│   ├── logging_utils.py    # Logging configuration
│   ├── data_utils.py       # Data utilities
│   ├── debug_utils.py      # Debugging utilities
│   ├── hash_utils.py       # Hashing utilities
│   ├── stable_id.py        # Stable ID generation
│   ├── relaxng_to_codemirror.py # Schema conversion
│   ├── remote_metadata.py  # Remote metadata
│   ├── doc_id_resolver.py  # Document ID resolution
│   ├── autocomplete_generator.py # Autocomplete
│   ├── collection_utils.py # Collection utilities
│   ├── server_utils.py     # Server utilities
│   └── server_startup.py   # Server startup
├── interfaces/              # Abstract base classes
│   └── __init__.py         # Repository, Service, Plugin interfaces
└── tests/                   # Test utilities only
    └── utils.py            # Test helpers
```

## Key Changes

### 1. Logical Module Organization

- **Core**: Infrastructure components (database, migrations, sessions)
- **Models**: All Pydantic models centralized
- **Repository**: Data access layer with clear separation
- **Services**: Business logic services
- **Storage**: File I/O operations
- **Permissions**: Access control and user management
- **Plugins**: Generic plugin system (no specific implementations)
- **Extraction**: Generic extraction framework (no specific extractors)
- **SSE**: Real-time event system
- **Utils**: Common utilities
- **Interfaces**: Abstract base classes for contracts

### 2. No Plugin-Specific Code

All plugin-specific implementations (like GROBID) remain in `fastapi_app/plugins/<name>/`. The `lib/` directory contains only generic, reusable code.

### 3. No Production Tests in lib/

All test files have been moved to the project-level `tests/` directory. Only test utilities remain in `lib/tests/utils.py`.

### 4. Clear Dependency Hierarchy

```
core/ → models/ → repository/ → services/ → plugins/
     ↘︎ extraction/ ↗︎ utils/
```

- `core/` depends only on Python standard library
- `models/` depends on `core/` and Pydantic
- `repository/` depends on `core/` and `models/`
- `services/` depends on `core/`, `models/`, and `repository/`
- `plugins/` depends on `services/` and `utils/`
- `extraction/` depends on `services/` and `utils/`
- `utils/` depends on `core/` only

### 5. Import Path Updates

All imports have been updated to use absolute paths:
- `from fastapi_app.lib.database import DatabaseManager`
  → `from fastapi_app.lib.core.database import DatabaseManager`
- `from fastapi_app.lib.models import FileMetadata`
  → `from fastapi_app.lib.models.models import FileMetadata`
- `from fastapi_app.lib.config_utils import get_config`
  → `from fastapi_app.lib.utils.config_utils import get_config`

## Benefits

1. **Improved Modularity**: Clear separation of concerns with logical grouping
2. **Better Testability**: Isolated modules with clear interfaces
3. **Easier Maintenance**: Related code grouped together
4. **Enhanced Extensibility**: Clean interfaces for plugins and services
5. **Clearer Dependencies**: Well-defined dependency hierarchy prevents circular imports
6. **Better Documentation**: Module-level documentation for each package

## Migration Guide

### For Developers

When importing from the lib module, use the new paths:

```python
# Before
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.models import FileMetadata
from fastapi_app.lib.config_utils import get_config

# After
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.models import FileMetadata  # Re-exported from models/__init__.py
from fastapi_app.lib.utils.config_utils import get_config
```

### For Plugin Developers

No changes needed for existing plugins. Import paths have been automatically updated across the codebase. New plugins should follow the new import patterns.

## Files Changed

- 170 files modified
- Files moved to appropriate modules
- All imports updated
- Test files relocated
- Documentation updated

## Future Improvements

1. Add more abstract base classes to `interfaces/`
2. Create comprehensive API documentation for each module
3. Add usage examples for common patterns
4. Consider further decomposition of large modules (e.g., `file_repository.py`)
