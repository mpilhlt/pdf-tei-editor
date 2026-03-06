# Backend Architecture

Quick reference for understanding the FastAPI backend structure.

For frontend architecture, see [architecture-frontend.md](./architecture-frontend.md).

## Overview

- **Main application**: [fastapi_app/main.py](../../fastapi_app/main.py) - FastAPI app with router and plugin registration
- **API routes**: [fastapi_app/routers/](../../fastapi_app/routers/) - Route handlers (`files_*.py`, `users.py`, etc.)
- **Library**: [fastapi_app/lib/](../../fastapi_app/lib/) - Core logic organized by domain
- **Plugins**: [fastapi_app/plugins/](../../fastapi_app/plugins/) - Plugin implementations
- **Data storage**: `data/` - PDFs and TEI/XML files
- **Configuration**: `config/` (defaults) and `data/db/` (runtime)
- **Database**: `data/db/metadata.db` - SQLite file metadata database

## Library Structure (`fastapi_app/lib/`)

### `core/` — Infrastructure

| File | Purpose |
|------|---------|
| `database.py` | `DatabaseManager`, connection pooling |
| `db_schema.py` | Schema initialization |
| `db_utils.py` | Database utilities |
| `sqlite_utils.py` | SQLite-specific utilities |
| `db_init.py` | DB initialization helpers |
| `dependencies.py` | FastAPI dependency injection providers |
| `locking.py` | File locking system |
| `sessions.py` | Session management |
| `schema_validator.py` | Schema validation |
| `data_restore.py` | Data restoration utilities |
| `migration_runner.py` | Migration execution |
| `migrations/` | Migration system (`base.py`, `manager.py`, `utils.py`, `versions/`) |

### `models/` — Pydantic Data Models

| File | Purpose |
|------|---------|
| `models.py` | Core models (`FileMetadata`, etc.) |
| `models_files.py` | File operation models |
| `models_extraction.py` | Extraction models |
| `models_permissions.py` | Permission models |
| `models_sync.py` | Sync models |
| `models_validation.py` | Validation models |

### `repository/` — Data Access Layer

| File | Purpose |
|------|---------|
| `file_repository.py` | File metadata repository |
| `permissions_db.py` | Permissions database |

### `services/` — Business Logic

| File | Purpose |
|------|---------|
| `metadata_extraction.py` | Metadata extraction service |
| `metadata_update_utils.py` | Metadata update utilities |
| `sync_service.py` | WebDAV sync service |
| `statistics.py` | Statistics calculation |
| `service_registry.py` | Service registry |

### `storage/` — File I/O

| File | Purpose |
|------|---------|
| `file_storage.py` | File storage operations |
| `file_importer.py` | File import utilities |
| `file_exporter.py` | File export utilities |
| `file_zip_exporter.py` | ZIP export |
| `file_zip_importer.py` | ZIP import |
| `storage_gc.py` | Garbage collection |
| `storage_references.py` | Reference counting |

### `permissions/` — Access Control

| File | Purpose |
|------|---------|
| `access_control.py` | Access control manager |
| `acl_utils.py` | ACL utilities |
| `role_utils.py` | Role management |
| `group_utils.py` | Group management |
| `user_utils.py` | User utilities |

### `plugins/` — Plugin System (Generic)

| File | Purpose |
|------|---------|
| `plugin_base.py` | Plugin base classes |
| `plugin_manager.py` | Plugin lifecycle management |
| `plugin_registry.py` | Plugin registration |
| `plugin_tools.py` | Plugin utilities |
| `frontend_extension_registry.py` | Frontend extension registration |

### `extraction/` — Extraction Framework (Generic)

| File | Purpose |
|------|---------|
| `base.py` | `BaseExtractor` class |
| `llm_base.py` | LLM extractor base |
| `registry.py` | Extractor registry |
| `manager.py` | Extractor management |
| `http_utils.py` | HTTP utilities |

### `sse/` — Server-Sent Events

| File | Purpose |
|------|---------|
| `sse_service.py` | SSE service |
| `sse_utils.py` | SSE utilities (`ProgressBar`, `send_notification`) |
| `sse_log_handler.py` | Log streaming |
| `event_bus.py` | Event bus |

### `utils/` — Common Utilities

| File | Purpose |
|------|---------|
| `config_utils.py` | Configuration management (`get_config`) |
| `auth.py` | Authentication (`AuthManager`) |
| `tei_utils.py` | TEI document processing |
| `xml_utils.py` | XML utilities |
| `doi_utils.py` | DOI utilities |
| `cache_utils.py` | Caching |
| `logging_utils.py` | Logging configuration |
| `data_utils.py` | Data utilities |
| `debug_utils.py` | Debugging utilities |
| `hash_utils.py` | Hashing utilities |
| `stable_id.py` | Stable ID generation |
| `relaxng_to_codemirror.py` | Schema conversion |
| `remote_metadata.py` | Remote metadata |
| `doc_id_resolver.py` | Document ID resolution |
| `autocomplete_generator.py` | Autocomplete |
| `collection_utils.py` | Collection utilities |
| `server_utils.py` | Server utilities |
| `server_startup.py` | Server startup |

### `interfaces/` — Abstract Base Classes

- `__init__.py` — Repository, Service, Plugin interfaces

## Dependency Hierarchy

```
core/ → models/ → repository/ → services/ → plugins/
     ↘ extraction/ ↗ utils/
```

- `core/` — depends only on Python standard library
- `models/` — depends on `core/` and Pydantic
- `repository/` — depends on `core/` and `models/`
- `services/` — depends on `core/`, `models/`, and `repository/`
- `plugins/` — depends on `services/` and `utils/`
- `extraction/` — depends on `services/` and `utils/`
- `utils/` — depends on `core/` only

## Plugin Implementations

Plugin-specific implementations live in `fastapi_app/plugins/<name>/`. The `lib/` directory contains only generic, reusable code. See [backend-plugins.md](./backend-plugins.md) for plugin development guide.

## Common Import Patterns

```python
# Core infrastructure
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_db, get_file_storage
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.core.locking import FileLock
from fastapi_app.lib.core.migration_runner import run_migrations_if_needed

# Models
from fastapi_app.lib.models.models import FileMetadata

# Data access
from fastapi_app.lib.repository.file_repository import FileRepository

# Storage
from fastapi_app.lib.storage.file_storage import FileStorage

# Services
from fastapi_app.lib.services.sync_service import SyncService
from fastapi_app.lib.services.service_registry import get_service_registry

# Permissions
from fastapi_app.lib.permissions.user_utils import user_has_collection_access
from fastapi_app.lib.permissions.access_control import AccessControlManager

# Plugins
from fastapi_app.lib.plugins.plugin_base import Plugin
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config, load_plugin_html
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry

# SSE
from fastapi_app.lib.sse.sse_utils import ProgressBar, send_notification
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.sse.event_bus import EventBus

# Utilities
from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.lib.utils.auth import AuthManager
from fastapi_app.lib.utils.tei_utils import extract_tei_metadata
```
