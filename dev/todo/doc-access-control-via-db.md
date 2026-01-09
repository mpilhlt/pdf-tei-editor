# Implementation Plan: Database-Backed Document Access Control

Move document-level access control from TEI-embedded storage to a dedicated SQLite database.

## Current State

Access control code exists but **has not been used in production**:

1. **Frontend**: `app/src/plugins/access-control.js` parses/writes TEI XML `<change>` elements
2. **Backend**: `fastapi_app/lib/access_control.py` reads from `file_metadata['access_control']` JSON field
3. **Cache**: `file_metadata['access_control']` in `metadata.db` files table (unused)
4. **Source**: TEI XML `<revisionDesc>` elements (unused)

**Issues with current (unused) approach:**

- Access control tied to document content
- Requires parsing TEI XML for permission checks
- Metadata cached in JSON field but still originates from XML
- Permission changes modify document content
- Feature has been disabled and never deployed

## Target State

Access control stored in dedicated SQLite database at `data/db/permissions.db`.

**Permissions are per-artifact (stable_id)** - Each TEI annotation file has its own permissions, not grouped by doc_id.

**Default permissions:** `public` visibility, `protected` editability for new artifacts.

## Database Schema

### Table: `document_permissions`

```sql
CREATE TABLE IF NOT EXISTS document_permissions (
    stable_id TEXT PRIMARY KEY,           -- Artifact stable ID (nanoid)
    visibility TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'private'
    editability TEXT NOT NULL DEFAULT 'protected', -- 'editable' | 'protected'
    owner TEXT,                           -- Username or NULL
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (visibility IN ('public', 'private')),
    CHECK (editability IN ('editable', 'protected'))
)
```

**Indexes:**

```sql
CREATE INDEX IF NOT EXISTS idx_stable_id ON document_permissions(stable_id);
CREATE INDEX IF NOT EXISTS idx_owner ON document_permissions(owner);
CREATE INDEX IF NOT EXISTS idx_visibility ON document_permissions(visibility);
```

### Table: `permission_history`

Track permission changes for audit purposes:

```sql
CREATE TABLE IF NOT EXISTS permission_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stable_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    editability TEXT NOT NULL,
    owner TEXT,
    changed_by TEXT,                      -- Username who made the change
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT,                     -- Optional change description
    FOREIGN KEY (stable_id) REFERENCES document_permissions(stable_id)
)
```

**Indexes:**

```sql
CREATE INDEX IF NOT EXISTS idx_history_stable_id ON permission_history(stable_id);
CREATE INDEX IF NOT EXISTS idx_history_changed_at ON permission_history(changed_at);
```

## Backend Implementation

### 1. Database Layer (`fastapi_app/lib/permissions_db.py`)

Create database initialization and migration following `fastapi_app/lib/locking.py` pattern:

```python
"""
Document permissions database management.

Stores document-level access control permissions in SQLite database.
"""

import sqlite3
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Optional, List
from dataclasses import dataclass
import logging

@dataclass
class DocumentPermissions:
    """Document permission data."""
    stable_id: str
    visibility: str  # 'public' | 'private'
    editability: str  # 'editable' | 'protected'
    owner: Optional[str]
    created_at: datetime
    updated_at: datetime

@contextmanager
def get_db_connection(db_dir: Path, logger: logging.Logger):
    """Context manager for database connections."""
    # Similar to locking.py pattern
    # Enable WAL mode for concurrent access
    # Use row factory for dict-like results

def init_permissions_db(db_dir: Path, logger: logging.Logger) -> None:
    """Initialize permissions database with schema and migrations."""
    # Create database if doesn't exist
    # Run migrations using centralized runner
    # Create indexes

def get_document_permissions(stable_id: str, db_dir: Path, logger: logging.Logger) -> DocumentPermissions:
    """Get permissions for an artifact, returns defaults if not found."""
    # Query database
    # Return defaults (public, protected) if not found

def set_document_permissions(
    stable_id: str,
    visibility: str,
    editability: str,
    owner: Optional[str],
    changed_by: str,
    db_dir: Path,
    logger: logging.Logger,
    description: Optional[str] = None
) -> DocumentPermissions:
    """Set permissions for an artifact, creating history entry."""
    # Validate inputs
    # UPSERT into document_permissions
    # Insert into permission_history
    # Return updated permissions

def get_permission_history(stable_id: str, db_dir: Path, logger: logging.Logger) -> List[Dict]:
    """Get permission change history for an artifact."""
    # Query permission_history table
    # Return list of changes

def delete_document_permissions(stable_id: str, db_dir: Path, logger: logging.Logger) -> bool:
    """Delete permissions record for an artifact (when artifact is deleted)."""
    # Delete from document_permissions
    # Keep history for audit trail
```

### 2. Migration (`fastapi_app/lib/migrations/versions/m002_permissions_db.py`)

Create migration to set up permissions database:

```python
"""
Migration 002: Create document permissions database

Creates permissions.db with document_permissions and permission_history tables.
This replaces TEI-embedded access control metadata.

Before: Access control stored in TEI <change> elements
After: Access control in dedicated SQLite database
"""

import sqlite3
from ..base import Migration

class Migration002PermissionsDb(Migration):
    """Create document permissions database."""

    @property
    def version(self) -> int:
        return 2

    @property
    def description(self) -> str:
        return "Create document permissions database"

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """Create permissions tables."""
        # Create document_permissions table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS document_permissions (
                stable_id TEXT PRIMARY KEY,
                visibility TEXT NOT NULL DEFAULT 'public',
                editability TEXT NOT NULL DEFAULT 'protected',
                owner TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (visibility IN ('public', 'private')),
                CHECK (editability IN ('editable', 'protected'))
            )
        """)

        # Create permission_history table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS permission_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stable_id TEXT NOT NULL,
                visibility TEXT NOT NULL,
                editability TEXT NOT NULL,
                owner TEXT,
                changed_by TEXT,
                changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                description TEXT,
                FOREIGN KEY (stable_id) REFERENCES document_permissions(stable_id)
            )
        """)

        # Create indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_stable_id ON document_permissions(stable_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_owner ON document_permissions(owner)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_visibility ON document_permissions(visibility)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_stable_id ON permission_history(stable_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_history_changed_at ON permission_history(changed_at)")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """Drop permissions tables."""
        conn.execute("DROP TABLE IF EXISTS permission_history")
        conn.execute("DROP TABLE IF EXISTS document_permissions")
```

Register in `fastapi_app/lib/migrations/versions/__init__.py`:

```python
from .m002_permissions_db import Migration002PermissionsDb

PERMISSIONS_MIGRATIONS = [
    Migration002PermissionsDb,
]

ALL_MIGRATIONS = [
    Migration001LocksFileId,
    Migration002PermissionsDb,
]
```

### 3. API Models (`fastapi_app/lib/models_permissions.py`)

```python
"""Pydantic models for permissions API."""

from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from typing import Optional

class DocumentPermissionsModel(BaseModel):
    """Document permissions response model."""
    stable_id: str
    visibility: str  # 'public' | 'private'
    editability: str  # 'editable' | 'protected'
    owner: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @field_validator('visibility')
    @classmethod
    def validate_visibility(cls, v: str) -> str:
        if v not in ('public', 'private'):
            raise ValueError("visibility must be 'public' or 'private'")
        return v

    @field_validator('editability')
    @classmethod
    def validate_editability(cls, v: str) -> str:
        if v not in ('editable', 'protected'):
            raise ValueError("editability must be 'editable' or 'protected'")
        return v

class SetPermissionsRequest(BaseModel):
    """Request to set artifact permissions."""
    stable_id: str
    visibility: str
    editability: str
    owner: Optional[str] = None
    description: Optional[str] = None

class PermissionHistoryEntry(BaseModel):
    """Single permission history entry."""
    id: int
    stable_id: str
    visibility: str
    editability: str
    owner: Optional[str]
    changed_by: str
    changed_at: datetime
    description: Optional[str]

class PermissionHistoryResponse(BaseModel):
    """Permission history response."""
    history: list[PermissionHistoryEntry]
```

### 4. API Router (`fastapi_app/routers/files_permissions.py`)

Following `fastapi_app/routers/files_locks.py` pattern:

```python
"""
File permissions API router for FastAPI.

Implements permission management endpoints:
- GET /api/v1/files/permissions/{stable_id} - Get permissions for artifact
- POST /api/v1/files/set_permissions - Set permissions for artifact
- GET /api/v1/files/permission_history/{stable_id} - Get permission change history
"""

from fastapi import APIRouter, Depends, HTTPException
from ..lib.permissions_db import (
    get_document_permissions,
    set_document_permissions,
    get_permission_history
)
from ..lib.models_permissions import (
    DocumentPermissionsModel,
    SetPermissionsRequest,
    PermissionHistoryResponse
)
from ..lib.dependencies import get_current_user, get_file_repository
from ..lib.file_repository import FileRepository
from ..config import get_settings
from ..lib.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])

@router.get("/permissions/{stable_id}", response_model=DocumentPermissionsModel)
def get_permissions_endpoint(
    stable_id: str,
    current_user: dict = Depends(get_current_user),
    repo: FileRepository = Depends(get_file_repository)
):
    """Get permissions for an artifact."""
    settings = get_settings()

    # Verify artifact exists
    # TODO: Need to verify user has access to view this artifact

    perms = get_document_permissions(stable_id, settings.db_dir, logger)
    return DocumentPermissionsModel(**perms.__dict__)

@router.post("/set_permissions", response_model=DocumentPermissionsModel)
def set_permissions_endpoint(
    request: SetPermissionsRequest,
    current_user: dict = Depends(get_current_user),
    repo: FileRepository = Depends(get_file_repository)
):
    """Set permissions for an artifact (owner/admin only)."""
    settings = get_settings()

    # Get current permissions
    current_perms = get_document_permissions(request.stable_id, settings.db_dir, logger)

    # Check if user can modify permissions
    # Only owner or admin can modify
    from ..lib.acl_utils import userIsAdmin
    if not userIsAdmin(current_user) and current_perms.owner != current_user.get('username'):
        raise HTTPException(
            status_code=403,
            detail="Only artifact owner or admin can modify permissions"
        )

    # Set new permissions
    updated = set_document_permissions(
        stable_id=request.stable_id,
        visibility=request.visibility,
        editability=request.editability,
        owner=request.owner,
        changed_by=current_user.get('username'),
        db_dir=settings.db_dir,
        logger=logger,
        description=request.description
    )

    return DocumentPermissionsModel(**updated.__dict__)

@router.get("/permission_history/{stable_id}", response_model=PermissionHistoryResponse)
def get_history_endpoint(
    stable_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get permission change history for an artifact."""
    settings = get_settings()

    # TODO: Check if user has access to view this artifact

    history = get_permission_history(stable_id, settings.db_dir, logger)
    return PermissionHistoryResponse(history=history)
```

Register router in `fastapi_app/main.py`:

```python
from .routers import files_permissions
app.include_router(files_permissions.router, prefix="/api/v1")
```

### 5. Update Access Control Module (`fastapi_app/lib/access_control.py`)

Replace metadata-based access checks with database lookups:

```python
def get_document_permissions_from_db(stable_id: str, db_dir: Path, logger: logging.Logger) -> DocumentPermissions:
    """Get permissions for an artifact from database."""
    from .permissions_db import get_document_permissions
    return get_document_permissions(stable_id, db_dir, logger)

# Update check_file_access() to use database instead of metadata
def check_file_access(file_metadata: Any, user: Optional[Dict], operation: str = 'read') -> bool:
    """Check if user has access to a file using database permissions."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.logging_utils import get_logger

    settings = get_settings()
    logger = get_logger(__name__)

    # Get stable_id from file_metadata
    stable_id = file_metadata.stable_id

    # Get permissions from database
    db_perms = get_document_permissions_from_db(stable_id, settings.db_dir, logger)

    # Convert to legacy DocumentPermissions format
    permissions = DocumentPermissions(
        visibility=db_perms.visibility,
        editability=db_perms.editability,
        owner=db_perms.owner,
        status_values=[],
        change_timestamp=db_perms.updated_at.isoformat() if db_perms.updated_at else None
    )

    # Map operation to access type
    required_access = 'write' if operation in ['write', 'edit'] else 'read'

    return AccessControlChecker.check_document_access(permissions, user, required_access)
```

### 6. File Operations Integration

Update file operations to set default permissions:

**`fastapi_app/routers/files_save.py`:**

- When creating new document (new gold or first version), set default permissions
- Use `set_document_permissions()` with `changed_by=current_user.username`

```python
# After creating new file/artifact
from ..lib.permissions_db import set_document_permissions

# Set default permissions for new artifacts
set_document_permissions(
    stable_id=stable_id,
    visibility='public',
    editability='protected',
    owner=current_user.get('username'),
    changed_by=current_user.get('username'),
    db_dir=settings.db_dir,
    logger=logger,
    description='Initial permissions for new artifact'
)
```

**`fastapi_app/routers/files_delete.py`:**

- When deleting document, optionally delete permissions record
- Use `delete_document_permissions()`

**`fastapi_app/routers/files_list.py`:**

- Filter files by permissions using database
- No longer parse `file_metadata['access_control']`

### 7. Initialize in Application Startup

In `fastapi_app/main.py` `lifespan()` function:

```python
# Initialize permissions database
from .lib.permissions_db import init_permissions_db
permissions_db_path = settings.db_dir / "permissions.db"
try:
    init_permissions_db(settings.db_dir, logger)
    logger.info(f"Permissions database initialized: {permissions_db_path}")
except Exception as e:
    logger.error(f"Error initializing permissions database: {e}")
    raise
```

## Frontend Implementation

### 1. API Client Updates (`app/src/modules/api-client-v1.js`)

Auto-generated from FastAPI OpenAPI schema - no manual changes needed after running build.

### 2. Plugin Updates (`app/src/plugins/access-control.js`)

Replace TEI XML parsing with API calls:

**Remove:**

- `parsePermissionsFromXmlTree()` - TEI parsing logic
- TEI manipulation in `updateDocumentStatus()`
- All XML DOM operations
- `ensureRespStmtForUser()` calls

**Add:**

```javascript
/**
 * Fetches artifact permissions from database via API
 * @returns {Promise<DocumentPermissions>}
 */
async function fetchDocumentPermissions() {
  const stableId = pluginState.xml // This is the stable_id

  const response = await api.files.getPermissions({ stable_id: stableId })
  return response
}

/**
 * Updates artifact permissions via API
 * @param {string} visibility
 * @param {string} editability
 * @param {string} [owner]
 * @param {string} [description]
 * @returns {Promise<DocumentPermissions>}
 */
async function updateDocumentPermissions(visibility, editability, owner, description) {
  const stableId = pluginState.xml

  const response = await api.files.setPermissions({
    stable_id: stableId,
    visibility,
    editability,
    owner,
    description
  })

  // No need to save XML - permissions are in database
  return response
}
```

**Update:**

- `computeDocumentPermissions()` to use `fetchDocumentPermissions()`
- `handlePermissionChange()` to use `updateDocumentPermissions()`
- Remove dependency on `xmleditor.api` for permissions

### 3. Remove TEI Utilities (`app/src/modules/tei-utils.js`)

Remove functions no longer needed:

- `ensureRespStmtForUser()` (if only used for permissions)

### 4. State Management

No changes needed - permissions still stored in `currentPermissions` object.

## Testing

### Backend Tests

**`tests/api/v1/files_permissions.test.js`:**

```javascript
test('Get default permissions for new document', async () => {
  // Create new document
  // Get permissions
  // Verify defaults: public, protected
})

test('Set permissions as owner', async () => {
  // Create document as user1
  // Set permissions to private
  // Verify updated
})

test('Cannot set permissions as non-owner', async () => {
  // Create document as user1
  // Try to set permissions as user2
  // Verify 403 error
})

test('Get permission history', async () => {
  // Create document
  // Change permissions twice
  // Get history
  // Verify 3 entries (initial + 2 changes)
})
```

**`fastapi_app/lib/migrations/tests/test_migration_002.py`:**

```python
def test_migration_creates_tables():
    # Run migration
    # Verify tables exist
    # Verify indexes exist

def test_migration_is_idempotent():
    # Run migration twice
    # Verify no errors
```

**Unit tests (`tests/api/v1/access_control.test.js`):**

- Test permission checks with database
- Test default permissions
- Test permission filtering

### Frontend Tests

**`tests/e2e/tests/access-control.spec.js`:**

```javascript
test('View permission status', async () => {
  // Load document
  // Verify status bar shows permissions
})

test('Change permissions via dropdown', async () => {
  // Load document as owner
  // Change to private
  // Verify UI updates
  // Reload page
  // Verify permissions persisted
})

test('Non-owner cannot change permissions', async () => {
  // Load document as non-owner
  // Verify dropdown hidden
  // Verify only permission info shown
})
```

### Integration Tests

**`tests/e2e/tests/access-control-workflow.spec.js`:**

```javascript
test('Complete permission workflow', async () => {
  // Create document → verify default permissions (public-protected)
  // Change to private → verify read-only for other users
  // Transfer ownership → verify new owner can edit
  // Delete document → verify permissions deleted
})
```

## Documentation Updates

### Technical Documentation

**`docs/development/access-control.md`:**

- Update "Architecture" section - remove TEI references
- Update "Implementation" section - document new API
- Add "Database Schema" section with table definitions
- Update "Permission Updates" section - API-based flow
- Remove "TEI XML Storage" section
- Remove "Permission Parsing" section
- Update all code examples to use database

**`docs/api/backend-api.json`:**

- Auto-generated from FastAPI OpenAPI schema

### User-Facing Documentation

**`docs/user-manual/access-control.md`:**

- Remove note about system being disabled
- Update to reflect database-backed system
- Update examples and workflows
- Document default permissions (public-protected)
- Clarify that permissions are per-document, not per-file
- All versions/artifacts of a document share permissions

## Migration Path

**No backward compatibility or data migration needed** - feature has never been used in production.

**Cleanup tasks:**

1. Remove unused TEI parsing code from `app/src/plugins/access-control.js`
2. Ignore `file_metadata['access_control']` field (no data exists)
3. All documents start fresh with default permissions (public-protected)
4. Remove TEI `<change>` element handling for permissions

## Implementation Steps

1. **Database Layer**
   - Create `fastapi_app/lib/permissions_db.py`
   - Create migration `m002_permissions_db.py`
   - Register migration in versions list
   - Write migration tests in `fastapi_app/lib/migrations/tests/test_migration_002.py`

2. **API Layer**
   - Create `fastapi_app/lib/models_permissions.py`
   - Create `fastapi_app/routers/files_permissions.py`
   - Update `fastapi_app/lib/access_control.py`
   - Initialize in `main.py` lifespan
   - Write API tests in `tests/api/v1/files_permissions.test.js`

3. **File Operations Integration**
   - Update `files_save.py` - set default permissions for new documents
   - Update `files_delete.py` - delete permissions on document delete
   - Update `files_list.py` - use database filtering
   - Write integration tests

4. **Frontend Updates**
   - Update `access-control.js` plugin to use API
   - Remove TEI parsing code
   - Add API calls for get/set permissions
   - Remove TEI utilities if no longer needed
   - Test in browser

5. **Testing**
   - Write backend unit tests
   - Write E2E tests for permission workflows
   - Test access control enforcement
   - Verify defaults applied to new documents

6. **Documentation**
   - Update `docs/development/access-control.md`
   - Update `docs/user-manual/access-control.md`
   - Update API reference (auto-generated)
   - Add migration notes if needed

## File References

**New files:**

- `fastapi_app/lib/permissions_db.py`
- `fastapi_app/lib/models_permissions.py`
- `fastapi_app/routers/files_permissions.py`
- `fastapi_app/lib/migrations/versions/m002_permissions_db.py`
- `fastapi_app/lib/migrations/tests/test_migration_002.py`
- `tests/api/v1/files_permissions.test.js`
- `tests/e2e/tests/access-control-workflow.spec.js`

**Modified files:**

- `fastapi_app/lib/access_control.py` - Use database instead of metadata
- `fastapi_app/routers/files_save.py` - Set default permissions for new documents
- `fastapi_app/routers/files_delete.py` - Delete permissions on document delete
- `fastapi_app/routers/files_list.py` - Filter by database permissions
- `fastapi_app/main.py` - Initialize permissions database in lifespan
- `app/src/plugins/access-control.js` - Use API instead of TEI parsing
- `app/src/modules/tei-utils.js` - Remove permission-related code if applicable
- `docs/development/access-control.md` - Update implementation docs
- `docs/user-manual/access-control.md` - Update user documentation
- `fastapi_app/lib/migrations/versions/__init__.py` - Register migration

## Key Design Decisions

1. **Permissions keyed by `stable_id`** - Each artifact has its own permissions (not grouped by doc_id)
2. **Default: public-protected** - New artifacts are visible to all, editable by owner only
3. **Separate history table** - Audit trail without cluttering main permissions table
4. **Owner can be NULL** - For public-editable documents (though default sets owner)
5. **Database-first** - Source of truth is database, not TEI content
6. **No metadata caching** - Direct database queries for permission checks (fast with indexes)
7. **Permission API separate from file API** - Clean separation of concerns
8. **History preserved on delete** - Keep audit trail even when permissions deleted
