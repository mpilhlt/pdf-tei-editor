# Backend Class Dependencies

Guide to FastAPI's dependency injection system and available dependencies in the PDF-TEI Editor.

## Overview

The application uses FastAPI's dependency injection system to provide reusable components to route handlers. This approach:

- Enables proper mocking in tests via `app.dependency_overrides`
- Prevents database access failures in CI environments
- Improves code testability and maintainability
- Provides automatic resource lifecycle management

## How Depends() Works

FastAPI's `Depends()` creates injectable dependencies that are resolved automatically when a route is called:

```python
from fastapi import APIRouter, Depends
from fastapi_app.lib.dependencies import get_db, get_file_storage

router = APIRouter()

@router.get("/files")
async def list_files(
    db=Depends(get_db),                    # Injected automatically
    file_storage=Depends(get_file_storage) # Injected automatically
):
    """db and file_storage are provided by FastAPI's DI system."""
    file_repo = FileRepository(db)
    # ... use db and file_storage ...
```

**Key Points:**

- Dependencies are declared as function parameters with `Depends(dependency_function)`
- FastAPI calls the dependency function and injects the result
- Dependencies can depend on other dependencies (nested dependencies)
- Each dependency is cached per request by default
- Tests can override dependencies using `app.dependency_overrides`

## Available Dependencies

All dependency functions are defined in [fastapi_app/lib/dependencies.py](../../fastapi_app/lib/dependencies.py).

### Database Dependencies

#### `get_db() -> DatabaseManager`

Returns a configured DatabaseManager instance for metadata.db.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_db
from fastapi_app.lib.database import DatabaseManager

@router.get("/example")
async def example(db: DatabaseManager = Depends(get_db)):
    # Use db to execute SQL queries
    result = db.execute("SELECT * FROM files")
```

**Used for:**
- Direct database queries
- Creating FileRepository instances
- Transaction management

#### `get_file_repository(db: DatabaseManager = Depends(get_db)) -> FileRepository`

Returns a FileRepository instance with injected database.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_file_repository
from fastapi_app.lib.file_repository import FileRepository

@router.get("/files")
async def list_files(file_repo: FileRepository = Depends(get_file_repository)):
    # Use file_repo for high-level file operations
    files = file_repo.get_all_files()
```

**Used for:**
- File metadata queries
- Collection management
- File versioning operations

**Note:** Depends on `get_db()` internally.

#### `get_file_storage() -> FileStorage`

Returns a FileStorage instance for physical file access.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_file_storage
from fastapi_app.lib.file_storage import FileStorage

@router.get("/file/{file_id}")
async def read_file(
    file_id: str,
    file_storage: FileStorage = Depends(get_file_storage)
):
    # Read physical file from content-addressable storage
    content = file_storage.read_file(file_id, "tei")
```

**Used for:**
- Reading file content from disk
- Writing files to content-addressable storage
- File reference counting and cleanup

### Authentication Dependencies

#### `get_session_manager() -> SessionManager`

Returns a SessionManager instance for session validation.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_session_manager
from fastapi_app.lib.sessions import SessionManager

@router.get("/protected")
async def protected_route(
    session_manager: SessionManager = Depends(get_session_manager)
):
    # Validate session manually if needed
    is_valid = session_manager.is_session_valid(session_id, timeout)
```

**Used for:**
- Session validation in custom auth logic
- Session lifecycle management
- Testing authentication flows

#### `get_auth_manager() -> AuthManager`

Returns an AuthManager instance for user authentication.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_auth_manager
from fastapi_app.lib.auth import AuthManager

@router.post("/login")
async def login(
    auth_manager: AuthManager = Depends(get_auth_manager)
):
    # Authenticate user
    user = auth_manager.authenticate(username, password_hash)
```

**Used for:**
- User authentication
- Password validation
- User lookup by session ID

#### `get_session_id(request: Request) -> Optional[str]`

Extracts session ID from request headers or query parameters (returns None if not present).

```python
from fastapi import Request, Depends
from fastapi_app.lib.dependencies import get_session_id

@router.get("/optional-auth")
async def optional_auth(
    request: Request,
    session_id: str | None = Depends(get_session_id)
):
    if session_id:
        # User is authenticated
        pass
    else:
        # Anonymous access
        pass
```

**Session ID Sources (in order of precedence):**
1. `X-Session-ID` header
2. `X-Session-Id` header (case variation)
3. `session_id` query parameter

#### `require_session_id(request: Request) -> str`

Extracts session ID from request (raises 401 if not present).

```python
from fastapi import Request, Depends
from fastapi_app.lib.dependencies import require_session_id

@router.get("/requires-session")
async def requires_session(
    request: Request,
    session_id: str = Depends(require_session_id)
):
    # session_id is guaranteed to be present (or 401 raised)
```

**Raises:** `HTTPException(401)` if session ID not found.

#### `get_current_user(request: Request, ...) -> Optional[Dict]`

Returns authenticated user or None (does not raise errors).

```python
from fastapi import Request, Depends
from typing import Optional, Dict
from fastapi_app.lib.dependencies import get_current_user

@router.get("/optional-user")
async def optional_user(
    request: Request,
    user: Optional[Dict] = Depends(get_current_user)
):
    if user:
        # User is authenticated
        username = user['username']
        roles = user['roles']
    else:
        # Anonymous access allowed
        pass
```

**Returns:** User dict with keys: `username`, `email`, `roles`, `groups`, etc.

**Use when:** Endpoints support both authenticated and anonymous access.

#### `require_authenticated_user(request: Request, ...) -> Dict`

Returns authenticated user (raises 401 if not authenticated).

```python
from fastapi import Request, Depends
from typing import Dict
from fastapi_app.lib.dependencies import require_authenticated_user

@router.get("/protected")
async def protected(
    request: Request,
    user: Dict = Depends(require_authenticated_user)
):
    # user is guaranteed to be authenticated (or 401 raised)
    username = user['username']
    roles = user['roles']
```

**Returns:** User dict with keys: `username`, `email`, `roles`, `groups`, etc.

**Raises:** `HTTPException(401)` if not authenticated or session expired.

**Use when:** Endpoint requires authentication.

**Development Mode:** Set `FASTAPI_ALLOW_ANONYMOUS_ACCESS=true` to bypass authentication (returns mock user with admin roles).

#### `require_admin_user(user: Dict = Depends(require_authenticated_user)) -> Dict`

Returns authenticated user with admin role (raises 403 if not admin).

```python
from fastapi import Depends
from typing import Dict
from fastapi_app.lib.dependencies import require_admin_user

@router.delete("/users/{username}")
async def delete_user(
    username: str,
    user: Dict = Depends(require_admin_user)
):
    # user is guaranteed to have admin role (or 403 raised)
```

**Returns:** User dict (same as `require_authenticated_user`).

**Raises:**
- `HTTPException(401)` if not authenticated
- `HTTPException(403)` if authenticated but not admin

**Admin Check:** User must have `'admin'` role or wildcard `'*'` in their roles array.

**Use when:** Endpoint requires admin privileges (user management, system config, etc.).

### SSE and Sync Dependencies

#### `get_sse_service() -> SSEService`

Returns singleton SSEService instance for server-sent events.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_sse_service
from fastapi_app.lib.sse_service import SSEService

@router.post("/broadcast")
async def broadcast(
    sse_service: SSEService = Depends(get_sse_service)
):
    # Broadcast event to all connected clients
    await sse_service.broadcast("event_type", {"data": "value"})
```

**Used for:**
- Broadcasting events to all clients
- Session-specific event delivery
- Real-time notifications

#### `get_sync_service(...) -> Optional[SyncService]`

Returns SyncService instance with dependencies (returns None if WebDAV not configured).

```python
from fastapi import Depends
from typing import Optional
from fastapi_app.lib.dependencies import get_sync_service
from fastapi_app.lib.sync_service import SyncService

@router.post("/sync")
async def sync_files(
    sync_service: Optional[SyncService] = Depends(get_sync_service)
):
    if not sync_service:
        raise HTTPException(503, "WebDAV not configured")

    # Perform sync operation
    result = await sync_service.sync_collection(collection_id)
```

**Returns:** `SyncService` instance or `None` if WebDAV not configured.

**Dependencies:** Automatically injects `FileRepository`, `FileStorage`, and `SSEService`.

**Use when:** Implementing WebDAV synchronization features.

#### `get_event_bus() -> EventBus`

Returns singleton EventBus instance for decoupled component communication.

```python
from fastapi import Depends
from fastapi_app.lib.dependencies import get_event_bus
from fastapi_app.lib.event_bus import EventBus

@router.post("/files/{file_id}")
async def update_file(
    file_id: str,
    event_bus: EventBus = Depends(get_event_bus)
):
    # Update file...

    # Notify other components about the change
    await event_bus.emit("file.updated", file_id=file_id, variant="tei")
```

**Used for:**
- Loose coupling between plugins and application components
- Event-driven architecture patterns
- Broadcasting state changes without direct dependencies

**Key Features:**
- Async-native (handlers are async functions)
- Error isolation (exceptions in one handler don't affect others)
- Concurrent handler execution
- Singleton instance shared across application

**Common Events:**
- `file.updated` - File content or metadata changed
- `file.deleted` - File removed
- `collection.modified` - Collection membership changed
- `plugin.initialized` - Plugin finished initialization

**Handler Registration:**

Plugins typically register handlers during initialization:

```python
class MyPlugin(PluginBase):
    async def initialize(self):
        bus = get_event_bus()
        bus.on("file.updated", self._handle_file_update)

    async def _handle_file_update(self, file_id: str, variant: str, **kwargs):
        # Handle the event
        pass
```

## Dependency Nesting

Dependencies can depend on other dependencies. FastAPI resolves the entire dependency tree:

```python
# get_file_repository depends on get_db
def get_file_repository(db: DatabaseManager = Depends(get_db)) -> FileRepository:
    return FileRepository(db)

# get_sync_service depends on get_file_repository (which depends on get_db)
def get_sync_service(
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
    sse_service: SSEService = Depends(get_sse_service)
) -> SyncService:
    return SyncService(file_repo, file_storage, sse_service)

# Your route only needs to declare the top-level dependency
@router.post("/sync")
async def sync_files(sync_service: SyncService = Depends(get_sync_service)):
    # All nested dependencies (db, file_repo, etc.) are resolved automatically
```

FastAPI caches dependency results per request, so `get_db()` is called once even if multiple dependencies need it.

## Testing with Dependency Overrides

Dependencies can be overridden in tests using `app.dependency_overrides`:

```python
from unittest.mock import MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi_app.lib.dependencies import get_db, get_auth_manager

# Create test app
app = FastAPI()
app.include_router(router)

# Create mocks
mock_db = MagicMock()
mock_auth = MagicMock()

# Override dependencies
app.dependency_overrides[get_db] = lambda: mock_db
app.dependency_overrides[get_auth_manager] = lambda: mock_auth

# Test client will use mocks
client = TestClient(app)
response = client.get("/files")
```

**Key Points:**

- Override in `setUp()` to apply to all tests
- Mock return values: `mock_db.execute.return_value = [...]`
- Individual tests can modify mock behavior
- Always use dependency injection (not direct calls) to enable mocking

See [testing-guide.md](../code-assistant/testing-guide.md#python-unit-tests-with-fastapi-routes) for complete testing patterns.

## Common Patterns

### Basic Authenticated Route

```python
from fastapi import APIRouter, Depends, Request
from typing import Dict
from fastapi_app.lib.dependencies import require_authenticated_user

router = APIRouter()

@router.get("/profile")
async def get_profile(
    request: Request,
    user: Dict = Depends(require_authenticated_user)
):
    return {
        "username": user['username'],
        "roles": user['roles']
    }
```

### Admin-Only Route

```python
from fastapi import APIRouter, Depends
from typing import Dict
from fastapi_app.lib.dependencies import require_admin_user

router = APIRouter()

@router.delete("/users/{username}")
async def delete_user(
    username: str,
    user: Dict = Depends(require_admin_user)
):
    # Only admin users can reach here
    # ... delete user logic ...
```

### File Operation Route

```python
from fastapi import APIRouter, Depends
from fastapi_app.lib.dependencies import get_file_repository, get_file_storage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage

router = APIRouter()

@router.get("/files/{file_id}")
async def get_file(
    file_id: str,
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage)
):
    # Get metadata
    file_metadata = file_repo.get_file_by_stable_id(file_id)

    # Read content
    content = file_storage.read_file(file_metadata.file_id, file_metadata.file_type)

    return {"content": content.decode('utf-8')}
```

### Custom Authentication Route

When implementing custom authentication logic (e.g., plugin routes), use the individual auth dependencies:

```python
from fastapi import APIRouter, Depends, Header, Query, HTTPException
from fastapi_app.lib.dependencies import get_auth_manager, get_session_manager
from fastapi_app.lib.auth import AuthManager
from fastapi_app.lib.sessions import SessionManager

router = APIRouter(prefix="/api/plugins/my-plugin")

@router.get("/custom")
async def custom_route(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager)
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

    # ... use user ...
```

**Note:** For standard routes, prefer `require_authenticated_user` instead of manual authentication.

## Anti-Patterns

### ❌ Direct Function Calls (Wrong)

```python
# BAD - Cannot be mocked in tests, fails if database doesn't exist
@router.get("/files")
async def list_files():
    db = get_db()  # Direct call - bad!
    file_storage = get_file_storage()  # Direct call - bad!
    # ...
```

**Problems:**
- Tests cannot override these dependencies
- Fails in CI if database doesn't exist
- Not following FastAPI patterns

### ✅ Dependency Injection (Correct)

```python
# GOOD - Can be mocked in tests, follows FastAPI patterns
@router.get("/files")
async def list_files(
    db=Depends(get_db),
    file_storage=Depends(get_file_storage)
):
    # ...
```

## Related Documentation

- [Testing Guide](../code-assistant/testing-guide.md) - Dependency mocking patterns
- [Backend Plugins](../code-assistant/backend-plugins.md) - Using dependencies in plugins
- [Architecture](./architecture.md) - System architecture overview
