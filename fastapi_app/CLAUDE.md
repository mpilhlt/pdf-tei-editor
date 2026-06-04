# Backend Rules

Rules specific to backend code in `fastapi_app/`. The root [CLAUDE.md](../CLAUDE.md) applies here too.

When working on frontend extension files (`plugins/*/extensions/*.js`), also apply the frontend rules in [app/CLAUDE.md](../app/CLAUDE.md).

## Database Access

- **ALWAYS use API methods** from `fastapi_app/lib/repository/file_repository.py`, `fastapi_app/lib/core/database.py`, and related modules to read and mutate database items
- **AVOID raw SQL queries** except in exceptional cases where no API method exists
- **If a read/write operation is missing**, add it to the appropriate repository/module rather than using ad-hoc SQL
- **ALWAYS pass `DatabaseManager` instances** to classes that need database access, do not pass file paths or create new `DatabaseManager` instances. This ensures connection pooling works correctly.
- **Use `db.transaction()`** for write operations to ensure atomicity and proper locking.
- This prevents breaking changes when the database schema evolves

## Database Migrations

- **ALWAYS use the migration infrastructure** when database schema changes are needed - see [docs/development/migrations.md](../docs/development/migrations.md)
- **NEVER modify the database schema directly** - create a versioned migration instead
- Migrations provide automatic backups, rollback support, and version tracking
- See `fastapi_app/lib/core/migrations/versions/m001_locks_file_id.py` for a complete example
- **When adding a new database**, use the centralized migration runner - see [docs/development/adding-new-databases.md](../docs/development/adding-new-databases.md)
  - Call `run_migrations_if_needed()` from `fastapi_app/lib/core/migration_runner.py` in your database initialization
  - This ensures migrations run automatically on application startup for all databases
- **Migration tests location** - ALWAYS place migration tests in `fastapi_app/lib/core/migrations/tests/` directory (not in the main test suite). These tests are for manual verification and should not run automatically in CI/CD. Name test files as `test_migration_XXX.py` where XXX is the migration number

## TEI Document Processing

- **ALWAYS use utility functions** from `fastapi_app/lib/utils/tei_utils.py` when working with TEI XML documents
- **Use `extract_tei_metadata()`** to extract metadata (title, authors, DOI, variant, etc.) from TEI documents instead of manual XPath queries
- **Use lxml** (not xml.etree) for TEI processing - it's what `tei_utils.py` uses and ensures consistency
- **Add new utility functions** to `tei_utils.py` when you need TEI processing functionality that doesn't exist yet
- This ensures consistent TEI handling across the codebase and prevents duplication

## User Authentication and Access Control

**Authentication Pattern for Custom Routes:**

When implementing authenticated routes (e.g., plugin routes), use dependency injection:

```python
from fastapi import APIRouter, Depends, Header, Query
from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_session_manager,
)

@router.get("/endpoint")
async def my_endpoint(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    from fastapi_app.config import get_settings

    # Extract session ID (header takes precedence)
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate session
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
```

**Access Control Pattern for Documents/Files:**

Access control is **collection-based**, not direct user-document relationships. Use utility functions from `fastapi_app/lib/permissions/user_utils.py`:

```python
from fastapi_app.lib.permissions.user_utils import user_has_collection_access

# Check if user has access to a document via its collections
file = file_repo.get_file_by_stable_id(stable_id)
user_has_access = False

for collection_id in file.doc_collections or []:
    if user_has_collection_access(user, collection_id, settings.db_dir):
        user_has_access = True
        break

if not user_has_access:
    raise HTTPException(status_code=403, detail="Access denied")
```

**Key Points:**

- Users access documents through **collection membership**, not direct user-document links
- Use `user_has_collection_access(user, collection_id, db_dir)` to check access to a specific collection
- Use `get_user_collections(user, db_dir)` from `fastapi_app.lib.permissions.user_utils` to get all collections a user can access (returns `None` if user has wildcard access)
- Admin users and users with wildcard (`*`) in their groups have access to all collections
- Import settings with `from fastapi_app.config import get_settings` (not `fastapi_app.lib.settings`)
- See [fastapi_app/routers/files_save.py](routers/files_save.py) for reference implementation

## Configuration Access

**ALWAYS use the high-level config API** to retrieve configuration values. Do NOT use `ConfigManager` directly.

```python
from fastapi_app.lib.utils.config_utils import get_config

# Get config instance
config = get_config()

# Get configuration values with defaults
value = config.get('annotation.lifecycle.order', default=[])
timeout = config.get('session.timeout', default=3600)
```

**Key Points:**

- Use `get_config()` to get the config instance (lazy initialization)
- Use `config.get(key, default)` to retrieve any configuration value
- The config instance handles initialization and caching automatically
- Never instantiate `ConfigManager` directly - use `get_config()` instead

**Backend Plugin Configuration:**

- **CRITICAL**: Initialize plugin config in the plugin class `__init__()` method, NOT in `__init__.py`
- Plugin `__init__.py` files are NEVER executed during plugin discovery (plugins are loaded directly via `importlib`)
- Use `get_plugin_config()` in the plugin class `__init__()` to create config keys from environment variables
- Access config everywhere else using `get_config()` (retrieves existing keys)
- See [Backend Plugins - Plugin Configuration](../docs/code-assistant/backend-plugins.md#plugin-configuration-with-environment-variables) for details

## Logging Configuration

**Log Files:**

The application writes to two separate log files:

- `app.log` - Application-level logs (Python logging, consistent format)
- `server.log` - Uvicorn server logs (access logs, startup messages)

**Log Directory Configuration:**

The log directory can be configured via the `LOG_DIR` environment variable:

```bash
# In .env.fastapi or environment
LOG_DIR=/var/log/pdf-tei-editor
```

Default: `project_root/log`

**Log Format:**

Application logs use the format:

```text
2026-02-06 21:06:30.036 [INFO    ] logger.name - message
```

**Accessing Log Paths in Code:**

```python
from fastapi_app.config import get_settings

settings = get_settings()
app_log = settings.app_log_file      # Path to app.log
server_log = settings.server_log_file  # Path to server.log
log_dir = settings.log_dir            # Log directory
```

## FastAPI and Plugin Patterns

- **FastAPI routes must use dependency injection** - ALWAYS use `Depends(get_db)` and `Depends(get_file_storage)` as route parameters, NEVER call `db = get_db()` or `file_storage = get_file_storage()` inside route functions. This enables proper test mocking via `app.dependency_overrides` and prevents CI failures when databases don't exist. See [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md) for details
- **Check backend plugin guide when creating backend plugins** - ALWAYS consult [docs/code-assistant/backend-plugins.md](../docs/code-assistant/backend-plugins.md) before creating or modifying backend plugins. It contains the plugin architecture, patterns, and Shadow DOM handling requirements
- **Backend plugins must not add frontend code to `app/`** - NEVER add files to `app/` (plugins, templates, modules) for functionality that belongs to a backend plugin. All frontend code for a backend plugin MUST be implemented as a frontend extension in `fastapi_app/plugins/<name>/extensions/<name>.js` and registered via `FrontendExtensionRegistry` in the plugin's `initialize()` method. See [docs/development/frontend-extensions.md](../docs/development/frontend-extensions.md) for the pattern. Architectural changes to `app/` (e.g., exposing a new PluginManager endpoint) are acceptable when the extension mechanism itself is insufficient.
- **Backend plugin HTML templates** - NEVER inline long HTML strings in route files. Place HTML in the plugin's `static/` directory (e.g., `fastapi_app/plugins/<name>/static/view.html`) and load it with `load_plugin_html(__file__, "view.html")` from `fastapi_app.lib.plugin_tools`. This function looks in `static/` first (falling back to the deprecated `html/` for backwards compatibility) and injects the sandbox client script automatically. NEVER put significant JavaScript inline in HTML templates — place it in a separate `.js` file in `static/` (auto-served at `/api/plugins/<name>/static/<file>.js`) and reference it with `<script type="module" src="...">`. This enables IDE type-checking and JSDoc type resolution
- **Use Settings for path resolution** - NEVER use `Path(__file__).parent.parent...` chains to navigate to well-known application directories. Always use the canonical properties from `get_settings()` in `fastapi_app/config.py`: `project_root_dir` (project root), `app_root_dir` (`fastapi_app/`), `plugins_code_dir` (`fastapi_app/plugins/`), `plugins_data_dir` (`data/plugins/`). Only use `Path(__file__).parent` when referencing files local to the current file's own directory (e.g., within a plugin's own subdirectory).
