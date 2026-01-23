# Implementation Plan: Document Access Control System

Implement a configurable document-level access control system with three modes: role-based, owner-based, and granular permissions.

## Current State

Access control code exists but **has not been used in production**:

1. **Frontend**: `app/src/plugins/access-control.js` parses/writes TEI XML `<change>` elements
2. **Backend**: `fastapi_app/lib/access_control.py` reads from `file_metadata['access_control']` JSON field
3. **Cache**: `file_metadata['access_control']` in `metadata.db` files table (unused)
4. **Source**: TEI XML `<revisionDesc>` elements (unused)

**Issues with current (unused) approach:**

- Access control tied to document content
- Requires parsing TEI XML for permission checks
- Permission changes modify document content
- Feature has been disabled and never deployed

## Target State

**Application-wide configurable access control** with three modes.

**Ownership tracking** via `created_by` field in file metadata (added by migration 007).

**Granular mode only** uses dedicated SQLite database at `data/db/permissions.db` for visibility/editability settings.

## Access Control Modes

### Configuration

```python
# Application-wide setting (cannot be mixed per collection)
access-control.mode: 'role-based' | 'owner-based' | 'granular'  # default: 'role-based'

# Only used in 'granular' mode
access-control.default-visibility: 'collection' | 'owner'       # default: 'collection'
access-control.default-editability: 'collection' | 'owner'      # default: 'owner'
```

### Mode 1: Role-Based (Default)

**No document-level permissions.**

**Rules:**

- Gold versions: only reviewers can edit
- Other versions: everyone with collection access can edit
- Deletion: only reviewers and document owners can delete (documents without owner: only reviewers)
- Promotion/demotion: only reviewers

**UI:**

- No permission controls shown
- Standard role-based behavior

**Storage:**

- No permissions database needed
- Only uses `created_by` field for audit trail

### Mode 2: Owner-Based

**Documents editable only by owner (creator).**

**Rules:**

- Documents are read-only for everyone except owner
- Reviewers can delete any version (including gold)
- Reviewers can replace gold versions with their own versions
- Promotion/demotion: only reviewers
- To edit a non-owned document, user must create their own version

**UI:**

- No permission controls shown (automatic based on ownership)
- Show notification when non-owner loads document: "This document is owned by [username]. Create your own version to edit."

**Storage:**

- No permissions database needed
- Uses `created_by` field from file metadata

**Reviewer override:**

- Reviewers can always delete any document
- Reviewers cannot edit non-owned documents (must create own version or replace gold)

### Mode 3: Granular

**Database-backed per-document permissions.**

**Attributes per document:**

- `visibility`: `'collection'` | `'owner'`
- `editability`: `'collection'` | `'owner'`
- `owner`: username (always required, set to creator)

**Permission semantics:**

- `visibility: 'collection'` → visible to anyone with collection access
- `visibility: 'owner'` → visible only to owner (+ reviewers)
- `editability: 'collection'` → editable by anyone with collection access
- `editability: 'owner'` → editable only by owner

**Rules:**

- Collection access is baseline requirement (no "public" beyond collection)
- Deletion follows same rules as editability
- Promotion/demotion: only reviewers (independent of document permissions)
- Permission modification: only owner + reviewers

**Reviewer override:**

- Reviewers can always read, delete, and modify permissions
- Reviewers **cannot** edit non-owned documents when `editability: 'owner'` (prevents accidental overwriting)
- To edit, reviewers must create their own version or change permissions first

**UI:**

- Two status switches in status bar (visible to owner + reviewers):
  - **Visibility switch**: `label: "Visibility"`, `checkedText: "Collection"`, `uncheckedText: "Owner"`
  - **Editability switch**: `label: "Editability"`, `checkedText: "Collection"`, `uncheckedText: "Owner"`
- Tooltip on hover: "Collection = all users with collection access, Owner = document owner only"
- Switches hidden for non-owners (non-reviewers)

**Storage:**

- SQLite database `data/db/permissions.db`
- Table `document_permissions` (see schema below)

**Default permissions for new documents:**

- `visibility: 'collection'` (visible to all collection members)
- `editability: 'owner'` (editable only by owner)
- `owner: <creator_username>`

## Database Schema (Granular Mode Only)

### Table: `document_permissions`

```sql
CREATE TABLE IF NOT EXISTS document_permissions (
    stable_id TEXT PRIMARY KEY,                      -- Artifact stable ID (nanoid)
    visibility TEXT NOT NULL DEFAULT 'collection',   -- 'collection' | 'owner'
    editability TEXT NOT NULL DEFAULT 'owner',       -- 'collection' | 'owner'
    owner TEXT NOT NULL,                             -- Username (always required)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (visibility IN ('collection', 'owner')),
    CHECK (editability IN ('collection', 'owner'))
)
```

**Indexes:**

```sql
CREATE INDEX IF NOT EXISTS idx_stable_id ON document_permissions(stable_id);
CREATE INDEX IF NOT EXISTS idx_owner ON document_permissions(owner);
CREATE INDEX IF NOT EXISTS idx_visibility ON document_permissions(visibility);
```

**No permission history table needed** - audit trail not required.

## Backend Implementation

### 1. Configuration (`fastapi_app/lib/config_utils.py`)

Add configuration keys:

```python
# In config schema or environment variables
ACCESS_CONTROL_MODE = 'role-based'  # role-based | owner-based | granular
ACCESS_CONTROL_DEFAULT_VISIBILITY = 'collection'  # collection | owner
ACCESS_CONTROL_DEFAULT_EDITABILITY = 'owner'      # collection | owner
```

Load via `get_config()`:

```python
from fastapi_app.lib.config_utils import get_config

config = get_config()
mode = config.get('access-control.mode', default='role-based')
default_visibility = config.get('access-control.default-visibility', default='collection')
default_editability = config.get('access-control.default-editability', default='owner')
```

### 2. Database Layer (`fastapi_app/lib/permissions_db.py`)

**Only used in granular mode.**

```python
"""
Document permissions database management (granular mode only).

Stores document-level visibility/editability permissions in SQLite database.
Uses DELETE journal mode (simple database with infrequent writes).
"""

import sqlite3
import queue
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Generator
from dataclasses import dataclass
import logging

from . import sqlite_utils

@dataclass
class DocumentPermissions:
    """Document permission data."""
    stable_id: str
    visibility: str      # 'collection' | 'owner'
    editability: str     # 'collection' | 'owner'
    owner: str           # Username (never None)
    created_at: datetime
    updated_at: datetime


class PermissionsDB:
    """
    Manages permissions database connections with pooling.

    Uses DELETE journal mode (not WAL) since this is a simple database
    with infrequent writes that doesn't benefit from WAL's read concurrency.
    """

    def __init__(self, db_path: Path, logger=None):
        self.db_path = db_path
        self.logger = logger
        self._pool = queue.Queue()
        self._ensure_db_exists()

    def _ensure_db_exists(self) -> None:
        """Ensure database and schema exist with migrations."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # Use per-database lock to prevent concurrent schema initialization
        with sqlite_utils.with_db_lock(self.db_path):
            conn = sqlite3.connect(str(self.db_path), timeout=60.0, isolation_level=None)
            try:
                conn.execute("PRAGMA journal_mode = DELETE")
                conn.execute("PRAGMA busy_timeout = 30000")
                conn.execute("PRAGMA foreign_keys = ON")
                initialize_permissions_schema(conn, self.logger, db_path=self.db_path)
            finally:
                conn.close()

    @contextmanager
    def get_connection(self) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for database connections with pooling."""
        try:
            conn = self._pool.get(block=False)
        except queue.Empty:
            conn = sqlite3.connect(
                str(self.db_path),
                timeout=60.0,
                check_same_thread=False,
                isolation_level=None
            )
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout = 30000")
            conn.execute("PRAGMA foreign_keys = ON")

        try:
            yield conn
        finally:
            try:
                conn.rollback()
            except sqlite3.OperationalError:
                pass
            self._pool.put(conn)


def initialize_permissions_schema(conn: sqlite3.Connection, logger=None, db_path=None) -> None:
    """
    Initialize permissions database schema.

    Creates tables and runs any pending migrations.
    """
    try:
        cursor = conn.cursor()

        if logger:
            logger.info("Creating permissions tables...")

        # Create document_permissions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS document_permissions (
                stable_id TEXT PRIMARY KEY,
                visibility TEXT NOT NULL DEFAULT 'collection',
                editability TEXT NOT NULL DEFAULT 'owner',
                owner TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (visibility IN ('collection', 'owner')),
                CHECK (editability IN ('collection', 'owner'))
            )
        """)

        # Create indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_permissions_owner ON document_permissions(owner)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_permissions_visibility ON document_permissions(visibility)")

        conn.commit()

        if logger:
            logger.info("Permissions database schema initialized")

        # Run migrations if db_path provided
        if db_path:
            from pathlib import Path
            from .migration_runner import run_migrations_if_needed
            from .migrations.versions import PERMISSIONS_MIGRATIONS

            run_migrations_if_needed(
                db_path=Path(db_path),
                migrations=PERMISSIONS_MIGRATIONS,
                logger=logger
            )

    except sqlite3.Error as e:
        if logger:
            logger.error(f"Failed to initialize permissions database: {e}")
        raise

def get_document_permissions(
    stable_id: str,
    permissions_db: PermissionsDB,
    default_visibility: str = 'collection',
    default_editability: str = 'owner',
    default_owner: Optional[str] = None
) -> DocumentPermissions:
    """
    Get permissions for an artifact.

    Returns defaults if not found in database.

    Args:
        stable_id: Artifact stable ID
        permissions_db: PermissionsDB instance (use dependency injection)
        default_visibility: Default visibility if not in database
        default_editability: Default editability if not in database
        default_owner: Default owner if not in database
    """
    with permissions_db.get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM document_permissions WHERE stable_id = ?",
            (stable_id,)
        ).fetchone()

        if row:
            return DocumentPermissions(
                stable_id=row['stable_id'],
                visibility=row['visibility'],
                editability=row['editability'],
                owner=row['owner'],
                created_at=datetime.fromisoformat(row['created_at']),
                updated_at=datetime.fromisoformat(row['updated_at'])
            )
        else:
            # Return defaults
            return DocumentPermissions(
                stable_id=stable_id,
                visibility=default_visibility,
                editability=default_editability,
                owner=default_owner or 'unknown',
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc)
            )

def set_document_permissions(
    stable_id: str,
    visibility: str,
    editability: str,
    owner: str,
    permissions_db: PermissionsDB
) -> DocumentPermissions:
    """
    Set permissions for an artifact.

    Args:
        stable_id: Artifact stable ID
        visibility: 'collection' or 'owner'
        editability: 'collection' or 'owner'
        owner: Username (required)
        permissions_db: PermissionsDB instance (use dependency injection)
    """
    # Validate inputs
    if visibility not in ('collection', 'owner'):
        raise ValueError(f"Invalid visibility: {visibility}")
    if editability not in ('collection', 'owner'):
        raise ValueError(f"Invalid editability: {editability}")
    if not owner:
        raise ValueError("Owner is required")

    now = datetime.now(timezone.utc).isoformat()

    with permissions_db.get_connection() as conn:
        # UPSERT into document_permissions
        conn.execute("""
            INSERT INTO document_permissions (stable_id, visibility, editability, owner, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(stable_id) DO UPDATE SET
                visibility = excluded.visibility,
                editability = excluded.editability,
                owner = excluded.owner,
                updated_at = excluded.updated_at
        """, (stable_id, visibility, editability, owner, now, now))
        conn.commit()

    return DocumentPermissions(
        stable_id=stable_id,
        visibility=visibility,
        editability=editability,
        owner=owner,
        created_at=datetime.fromisoformat(now),
        updated_at=datetime.fromisoformat(now)
    )

def delete_document_permissions(stable_id: str, permissions_db: PermissionsDB) -> bool:
    """
    Delete permissions record for an artifact (when artifact is deleted).

    Args:
        stable_id: Artifact stable ID
        permissions_db: PermissionsDB instance (use dependency injection)
    """
    with permissions_db.get_connection() as conn:
        conn.execute("DELETE FROM document_permissions WHERE stable_id = ?", (stable_id,))
        conn.commit()
        return True
```

### 3. Migration Registration

Since the schema is created in `initialize_permissions_schema()`, migrations are only needed for future schema changes.

Register in `fastapi_app/lib/migrations/versions/__init__.py`:

```python
# Permissions database migrations (for future schema changes)
PERMISSIONS_MIGRATIONS = []

# Add to ALL_MIGRATIONS if needed for tooling
ALL_MIGRATIONS = [
    Migration001LocksFileId,
    # Future: add permissions migrations here
]
```

**Note:** The base schema is created by `initialize_permissions_schema()` in the database layer. Only add migrations here for subsequent schema changes (adding columns, indexes, etc.).

### 4. API Models (`fastapi_app/lib/models_permissions.py`)

```python
"""Pydantic models for permissions API (granular mode only)."""

from pydantic import BaseModel, field_validator
from datetime import datetime
from typing import Literal

class DocumentPermissionsModel(BaseModel):
    """Document permissions response model."""
    stable_id: str
    visibility: Literal['collection', 'owner']
    editability: Literal['collection', 'owner']
    owner: str
    created_at: datetime
    updated_at: datetime

class SetPermissionsRequest(BaseModel):
    """Request to set artifact permissions."""
    stable_id: str
    visibility: Literal['collection', 'owner']
    editability: Literal['collection', 'owner']
    owner: str

    @field_validator('visibility', 'editability')
    @classmethod
    def validate_permission_values(cls, v: str) -> str:
        if v not in ('collection', 'owner'):
            raise ValueError(f"Invalid permission value: {v}")
        return v
```

### 5. API Router (`fastapi_app/routers/files_permissions.py`)

**Only active in granular mode.**

```python
"""
File permissions API router for FastAPI.

Only active when access-control.mode = 'granular'.

Implements permission management endpoints:
- GET /api/v1/files/permissions/{stable_id} - Get permissions for artifact
- POST /api/v1/files/set_permissions - Set permissions for artifact
"""

from fastapi import APIRouter, Depends, HTTPException
from ..lib.permissions_db import (
    PermissionsDB,
    get_document_permissions,
    set_document_permissions
)
from ..lib.models_permissions import (
    DocumentPermissionsModel,
    SetPermissionsRequest
)
from ..lib.dependencies import get_current_user, get_file_repository, get_permissions_db
from ..lib.file_repository import FileRepository
from ..lib.config_utils import get_config
from ..lib.logging_utils import get_logger
from ..lib.acl_utils import userHasReviewerRole

logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])

@router.get("/permissions/{stable_id}", response_model=DocumentPermissionsModel)
def get_permissions_endpoint(
    stable_id: str,
    current_user: dict = Depends(get_current_user),
    repo: FileRepository = Depends(get_file_repository),
    permissions_db: PermissionsDB = Depends(get_permissions_db)
):
    """Get permissions for an artifact (granular mode only)."""
    config = get_config()
    mode = config.get('access-control.mode', default='role-based')

    if mode != 'granular':
        raise HTTPException(
            status_code=400,
            detail=f"Permissions API only available in granular mode (current: {mode})"
        )

    # Get file to find owner
    file = repo.get_file_by_stable_id(stable_id)
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    default_visibility = config.get('access-control.default-visibility', default='collection')
    default_editability = config.get('access-control.default-editability', default='owner')

    perms = get_document_permissions(
        stable_id,
        permissions_db,
        default_visibility=default_visibility,
        default_editability=default_editability,
        default_owner=file.created_by
    )

    return DocumentPermissionsModel(**perms.__dict__)

@router.post("/set_permissions", response_model=DocumentPermissionsModel)
def set_permissions_endpoint(
    request: SetPermissionsRequest,
    current_user: dict = Depends(get_current_user),
    repo: FileRepository = Depends(get_file_repository),
    permissions_db: PermissionsDB = Depends(get_permissions_db)
):
    """Set permissions for an artifact (owner/reviewer only, granular mode only)."""
    config = get_config()
    mode = config.get('access-control.mode', default='role-based')

    if mode != 'granular':
        raise HTTPException(
            status_code=400,
            detail=f"Permissions API only available in granular mode (current: {mode})"
        )

    # Get current permissions
    file = repo.get_file_by_stable_id(request.stable_id)
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    current_perms = get_document_permissions(
        request.stable_id,
        permissions_db,
        default_owner=file.created_by
    )

    # Check if user can modify permissions (owner or reviewer)
    is_reviewer = userHasReviewerRole(current_user)
    is_owner = current_perms.owner == current_user.get('username')

    if not (is_reviewer or is_owner):
        raise HTTPException(
            status_code=403,
            detail="Only artifact owner or reviewer can modify permissions"
        )

    # Set new permissions
    updated = set_document_permissions(
        stable_id=request.stable_id,
        visibility=request.visibility,
        editability=request.editability,
        owner=request.owner,
        permissions_db=permissions_db
    )

    return DocumentPermissionsModel(**updated.__dict__)
```

**Add dependency provider in `fastapi_app/lib/dependencies.py`:**

```python
from .permissions_db import PermissionsDB

class _PermissionsDBSingleton:
    """Singleton for PermissionsDB to enable connection pooling."""
    _instance: PermissionsDB | None = None

    @classmethod
    def get_instance(cls, db_path: Path, logger=None) -> PermissionsDB:
        if cls._instance is None:
            cls._instance = PermissionsDB(db_path, logger)
        return cls._instance

def get_permissions_db() -> PermissionsDB:
    """
    Dependency provider for PermissionsDB.

    Returns None if not in granular mode (caller should check mode first).
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.config_utils import get_config
    from fastapi_app.lib.logging_utils import get_logger

    config = get_config()
    mode = config.get('access-control.mode', default='role-based')

    if mode != 'granular':
        return None

    settings = get_settings()
    logger = get_logger(__name__)
    db_path = settings.db_dir / "permissions.db"

    return _PermissionsDBSingleton.get_instance(db_path, logger)
```

Register router in `fastapi_app/main.py`:

```python
from .routers import files_permissions
app.include_router(files_permissions.router, prefix="/api/v1")
```

### 6. Access Control Logic (`fastapi_app/lib/access_control.py`)

Update to handle three modes. Uses dependency injection for `PermissionsDB`:

```python
"""
Access control logic supporting three modes:
- role-based: only role restrictions (gold = reviewers only)
- owner-based: documents editable only by owner
- granular: database-backed per-document permissions
"""

from typing import Optional, Dict, Any
import logging
from fastapi_app.lib.config_utils import get_config
from fastapi_app.lib.acl_utils import (
    userHasReviewerRole,
    userHasAnnotatorRole,
    isGoldFile,
    isVersionFile
)

def can_view_document(
    stable_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can view document.

    Assumes user already has collection access.

    Args:
        stable_id: Artifact stable ID
        file_metadata: File metadata object with created_by attribute
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    config = get_config()
    mode = config.get('access-control.mode', default='role-based')

    # Reviewers can always view
    if userHasReviewerRole(user):
        return True

    if mode == 'role-based':
        # Everyone with collection access can view
        return True

    elif mode == 'owner-based':
        # Everyone with collection access can view
        return True

    elif mode == 'granular':
        if permissions_db is None:
            raise ValueError("permissions_db required for granular mode")

        from fastapi_app.lib.permissions_db import get_document_permissions

        default_visibility = config.get('access-control.default-visibility', default='collection')
        default_owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None

        perms = get_document_permissions(
            stable_id,
            permissions_db,
            default_visibility=default_visibility,
            default_owner=default_owner
        )

        if perms.visibility == 'collection':
            return True
        elif perms.visibility == 'owner':
            return perms.owner == user.get('username') if user else False

    return True  # Default: allow view

def can_edit_document(
    stable_id: str,
    file_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can edit document.

    Assumes user already has collection access.

    Args:
        stable_id: Artifact stable ID
        file_id: File ID (content hash)
        file_metadata: File metadata object with created_by attribute
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    config = get_config()
    mode = config.get('access-control.mode', default='role-based')

    if mode == 'role-based':
        # Reviewers can always edit in role-based mode
        if userHasReviewerRole(user):
            return True

        # Role-based restrictions for file types
        if isGoldFile(file_id):
            return userHasReviewerRole(user)
        if isVersionFile(file_id):
            return userHasAnnotatorRole(user) or userHasReviewerRole(user)
        return True

    elif mode == 'owner-based':
        # Only owner can edit (reviewers cannot edit to prevent accidental overwriting)
        owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None
        return owner == user.get('username') if user and owner else False

    elif mode == 'granular':
        if permissions_db is None:
            raise ValueError("permissions_db required for granular mode")

        from fastapi_app.lib.permissions_db import get_document_permissions

        default_editability = config.get('access-control.default-editability', default='owner')
        default_owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None

        perms = get_document_permissions(
            stable_id,
            permissions_db,
            default_editability=default_editability,
            default_owner=default_owner
        )

        if perms.editability == 'collection':
            # Reviewers can edit in collection mode
            if userHasReviewerRole(user):
                return True
            # Still apply role-based restrictions for file types
            if isGoldFile(file_id):
                return userHasReviewerRole(user)
            return True
        elif perms.editability == 'owner':
            # Only owner can edit (reviewers cannot edit to prevent accidental overwriting)
            return perms.owner == user.get('username') if user else False

    return False

def can_delete_document(
    stable_id: str,
    file_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can delete document.

    Deletion rules:
    - Reviewers can always delete
    - In role-based and owner-based modes: only owner can delete (besides reviewers)
    - Documents without owner: only reviewers can delete
    - In granular mode: follows editability rules

    Args:
        stable_id: Artifact stable ID
        file_id: File ID (content hash)
        file_metadata: File metadata object with created_by attribute
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    # Reviewers can always delete
    if userHasReviewerRole(user):
        return True

    config = get_config()
    mode = config.get('access-control.mode', default='role-based')

    if mode in ('role-based', 'owner-based'):
        # Only owner can delete (reviewers already handled above)
        # Documents without owner can only be deleted by reviewers
        owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None
        if not owner:
            return False  # No owner = only reviewers can delete
        return owner == user.get('username') if user else False

    elif mode == 'granular':
        # Granular mode: follows editability rules
        return can_edit_document(stable_id, file_id, file_metadata, user, permissions_db)

    return False
```

### 7. File Operations Integration

**`fastapi_app/routers/files_save.py`:**

Set default permissions when creating new documents (granular mode only). Use dependency injection:

```python
from fastapi_app.lib.dependencies import get_permissions_db

@router.post("/save")
async def save_file(
    # ... other params ...
    permissions_db: PermissionsDB = Depends(get_permissions_db)
):
    # ... file creation logic ...

    # After creating new file/artifact (granular mode only)
    if permissions_db is not None:
        from fastapi_app.lib.config_utils import get_config
        from fastapi_app.lib.permissions_db import set_document_permissions

        config = get_config()
        default_visibility = config.get('access-control.default-visibility', default='collection')
        default_editability = config.get('access-control.default-editability', default='owner')

        set_document_permissions(
            stable_id=stable_id,
            visibility=default_visibility,
            editability=default_editability,
            owner=current_user.get('username'),
            permissions_db=permissions_db
        )
```

**`fastapi_app/routers/files_delete.py`:**

Delete permissions when deleting document (granular mode only):

```python
from fastapi_app.lib.dependencies import get_permissions_db

@router.delete("/delete/{stable_id}")
async def delete_file(
    stable_id: str,
    # ... other params ...
    permissions_db: PermissionsDB = Depends(get_permissions_db)
):
    # ... deletion logic ...

    # After deleting file (granular mode only)
    if permissions_db is not None:
        from fastapi_app.lib.permissions_db import delete_document_permissions
        delete_document_permissions(stable_id, permissions_db)
```

**`fastapi_app/routers/files_list.py`:**

Filter files by access control:

```python
from fastapi_app.lib.access_control import can_view_document
from fastapi_app.lib.dependencies import get_permissions_db

@router.get("/list")
async def list_files(
    # ... other params ...
    permissions_db: PermissionsDB = Depends(get_permissions_db)
):
    # ... get files_data ...

    # Filter by access control (granular mode uses permissions_db)
    filtered_files = []
    for file in files_data:
        if can_view_document(file.stable_id, file, current_user, permissions_db):
            filtered_files.append(file)

    files_data = filtered_files
```

### 8. Initialize in Application Startup

The `PermissionsDB` is initialized lazily via the dependency provider `get_permissions_db()`. No explicit initialization in `main.py` is needed.

The singleton pattern in `dependencies.py` ensures:

1. Database is only created when first accessed (lazy initialization)
2. Only created if mode is 'granular'
3. Connection pool is shared across all requests

**Optional: Pre-warm the database on startup (only if immediate startup validation is needed):**

```python
# In fastapi_app/main.py lifespan() function
from fastapi_app.lib.config_utils import get_config

config = get_config()
mode = config.get('access-control.mode', default='role-based')

if mode == 'granular':
    # Pre-initialize permissions database to catch startup errors early
    from fastapi_app.lib.dependencies import get_permissions_db
    try:
        permissions_db = get_permissions_db()
        if permissions_db:
            logger.info(f"Permissions database initialized: {permissions_db.db_path}")
    except Exception as e:
        logger.error(f"Error initializing permissions database: {e}")
        raise
```

## Frontend Implementation

### 1. API Client Updates (`app/src/modules/api-client-v1.js`)

Auto-generated from FastAPI OpenAPI schema - no manual changes needed.

### 2. Plugin Updates (`app/src/plugins/access-control.js`)

Replace TEI XML parsing with mode-aware logic:

**Remove:**

- `parsePermissionsFromXmlTree()` - TEI parsing logic
- TEI manipulation in `updateDocumentStatus()`
- All XML DOM operations
- `ensureRespStmtForUser()` calls

**Add:**

```javascript
/**
 * Fetches artifact permissions from backend
 * - granular mode: calls API
 * - owner-based mode: uses file metadata created_by
 * - role-based mode: no permissions needed
 * @returns {Promise<DocumentPermissions>}
 */
async function fetchDocumentPermissions() {
  const stableId = pluginState.xml
  const mode = await getAccessControlMode()

  if (mode === 'granular') {
    // Fetch from database via API
    const response = await api.files.getPermissions({ stable_id: stableId })
    return {
      visibility: response.visibility,
      editability: response.editability,
      owner: response.owner,
      can_modify: canModifyPermissions(response.owner)
    }
  } else if (mode === 'owner-based') {
    // Use file metadata
    const fileData = fileselection.getCurrentFileData()
    return {
      visibility: 'collection',  // Always collection in owner-based
      editability: 'owner',       // Always owner in owner-based
      owner: fileData?.created_by,
      can_modify: false           // No UI for owner-based
    }
  } else {
    // role-based: no permissions
    return {
      visibility: 'collection',
      editability: 'collection',
      owner: null,
      can_modify: false
    }
  }
}

/**
 * Updates artifact permissions via API (granular mode only)
 * @param {string} visibility
 * @param {string} editability
 * @returns {Promise<DocumentPermissions>}
 */
async function updateDocumentPermissions(visibility, editability) {
  const stableId = pluginState.xml
  const fileData = fileselection.getCurrentFileData()

  const response = await api.files.setPermissions({
    stable_id: stableId,
    visibility,
    editability,
    owner: fileData?.created_by  // Owner doesn't change
  })

  return {
    visibility: response.visibility,
    editability: response.editability,
    owner: response.owner,
    can_modify: canModifyPermissions(response.owner)
  }
}

/**
 * Gets access control mode from backend config
 * @returns {Promise<string>}
 */
async function getAccessControlMode() {
  // TODO: Add API endpoint to get config value
  // For now, could be cached in app state
  return 'role-based'  // default
}

/**
 * Checks if current user can modify permissions
 * @param {string|null} owner
 * @returns {boolean}
 */
function canModifyPermissions(owner) {
  const currentUser = authentication.getUser()
  if (!currentUser) return false

  // Owner or reviewer can modify
  const isOwner = owner === currentUser.username
  const isReviewer = userHasReviewerRole(currentUser)

  return isOwner || isReviewer
}
```

**Update:**

- `computeDocumentPermissions()` to use `fetchDocumentPermissions()`
- `handlePermissionChange()` to use `updateDocumentPermissions()`
- `createStatusDropdown()` → replace with two `status-switch` widgets

### 3. UI Widgets

Replace status dropdown with two status switches:

```javascript
/**
 * Creates the visibility switch widget
 * @returns {StatusSwitch}
 */
function createVisibilitySwitch() {
  const visibilitySwitch = PanelUtils.createSwitch({
    label: 'Visibility',
    checkedText: 'Collection',
    uncheckedText: 'Owner',
    checked: true,  // default: collection
    tooltip: 'Collection = all users with collection access, Owner = document owner only'
  })

  visibilitySwitch.addEventListener('sl-change', handleVisibilityChange)
  return visibilitySwitch
}

/**
 * Creates the editability switch widget
 * @returns {StatusSwitch}
 */
function createEditabilitySwitch() {
  const editabilitySwitch = PanelUtils.createSwitch({
    label: 'Editability',
    checkedText: 'Collection',
    uncheckedText: 'Owner',
    checked: false,  // default: owner
    tooltip: 'Collection = all users with collection access, Owner = document owner only'
  })

  editabilitySwitch.addEventListener('sl-change', handleEditabilityChange)
  return editabilitySwitch
}
```

### 4. State Management

Update `currentPermissions` object to use new vocabulary:

```javascript
/** @type {DocumentPermissions} */
let currentPermissions = {
    visibility: 'collection',    // 'collection' | 'owner'
    editability: 'owner',        // 'collection' | 'owner'
    owner: null,
    can_modify: false
}
```

### 5. Mode-Specific UI Behavior

```javascript
/**
 * Updates UI based on access control mode
 * @param {string} mode - 'role-based' | 'owner-based' | 'granular'
 */
function updateUIForMode(mode) {
  if (mode === 'granular') {
    // Show permission switches (if user can modify)
    if (currentPermissions.can_modify) {
      showPermissionSwitches()
    } else {
      showPermissionInfo()
    }
  } else if (mode === 'owner-based') {
    // Show notification if non-owner
    const currentUser = authentication.getUser()
    if (currentPermissions.owner && currentPermissions.owner !== currentUser?.username) {
      notify(
        `This document is owned by ${currentPermissions.owner}. Create your own version to edit.`,
        'warning',
        'exclamation-triangle'
      )
    }
    hidePermissionWidgets()
  } else {
    // role-based: hide all permission widgets
    hidePermissionWidgets()
  }
}
```

## Testing

### Backend Tests

**`fastapi_app/lib/migrations/tests/test_migration_002.py`:**

```python
def test_migration_creates_tables():
    # Run migration
    # Verify document_permissions table exists
    # Verify indexes exist

def test_migration_is_idempotent():
    # Run migration twice
    # Verify no errors
```

**`tests/api/v1/files_permissions.test.js`:**

```javascript
test('Get permissions in granular mode', async () => {
  // Set mode to granular
  // Create document
  // Get permissions
  // Verify defaults: visibility=collection, editability=owner
})

test('Set permissions as owner', async () => {
  // Create document as user1
  // Set permissions to visibility=owner
  // Verify updated
})

test('Cannot set permissions as non-owner non-reviewer', async () => {
  // Create document as user1
  // Try to set permissions as user2 (not reviewer)
  // Verify 403 error
})

test('Reviewer can set permissions', async () => {
  // Create document as user1
  // Set permissions as reviewer
  // Verify success
})

test('Permissions API disabled in role-based mode', async () => {
  // Set mode to role-based
  // Try to get/set permissions
  // Verify 400 error
})
```

**`tests/api/v1/access_control.test.js`:**

```javascript
test('Role-based mode: everyone can edit non-gold', async () => {
  // Set mode to role-based
  // Create version file
  // Verify user2 can edit
})

test('Owner-based mode: only owner can edit', async () => {
  // Set mode to owner-based
  // Create file as user1
  // Verify user2 cannot edit
  // Verify user1 can edit
})

test('Granular mode: collection editability allows all', async () => {
  // Set mode to granular
  // Create file with editability=collection
  // Verify user2 can edit
})

test('Granular mode: owner editability restricts to owner', async () => {
  // Set mode to granular
  // Create file with editability=owner
  // Verify user2 cannot edit
  // Verify owner can edit
})
```

### Frontend Tests

**`tests/e2e/tests/access-control.spec.js`:**

```javascript
test('Granular mode: shows permission switches for owner', async () => {
  // Set mode to granular
  // Load document as owner
  // Verify visibility switch shown
  // Verify editability switch shown
})

test('Granular mode: change permissions via switches', async () => {
  // Load document as owner
  // Toggle visibility switch
  // Verify API called
  // Verify state updated
})

test('Owner-based mode: shows notification for non-owner', async () => {
  // Set mode to owner-based
  // Create document as user1
  // Load as user2
  // Verify notification shown
  // Verify editor read-only
})

test('Role-based mode: no permission widgets shown', async () => {
  // Set mode to role-based
  // Load document
  // Verify no permission widgets
})
```

## Documentation Updates

### Technical Documentation

**`docs/development/access-control.md`:**

- Add "Access Control Modes" section describing three modes
- Add "Configuration" section with config keys
- Update "Architecture" section - remove TEI references
- Add "Granular Mode Database Schema" section
- Update "Permission Logic" section with mode-specific rules
- Remove "TEI XML Storage" section
- Remove "Permission Parsing" section
- Update all code examples

### User-Facing Documentation

**`docs/user-manual/access-control.md`:**

- Add "Understanding Access Control Modes" section
- Document mode switching (admin/config task)
- Document owner-based workflow ("create your own version")
- Document granular mode UI (visibility/editability switches)
- Clarify reviewer override privileges

## Migration Path

**No data migration needed** - feature has never been used in production.

**Cleanup tasks:**

1. Remove unused TEI parsing code from `app/src/plugins/access-control.js`
2. Remove TEI manipulation in `updateDocumentStatus()`
3. Remove `ensureRespStmtForUser()` if only used for permissions
4. All documents start with mode-appropriate default behavior

**Mode switching:**

- Changing mode at runtime just changes behavior
- Existing permissions in database (if any) are ignored in non-granular modes
- Switching to granular mode: documents get defaults until permissions are set

## Implementation Steps

1. **Configuration & Backend Core**
   - Add config keys to `config_utils.py`
   - Create `fastapi_app/lib/permissions_db.py`
   - Create migration `m002_permissions_db.py`
   - Update `fastapi_app/lib/access_control.py` with mode logic
   - Write migration tests

2. **API Layer (Granular Mode)**
   - Create `fastapi_app/lib/models_permissions.py`
   - Create `fastapi_app/routers/files_permissions.py`
   - Initialize permissions DB in `main.py` lifespan (conditional)
   - Write API tests

3. **File Operations Integration**
   - Update `files_save.py` - set default permissions (granular mode)
   - Update `files_delete.py` - delete permissions (granular mode)
   - Update `files_list.py` - filter by access control (all modes)
   - Write integration tests

4. **Frontend Updates**
   - Update `access-control.js` plugin
   - Replace dropdown with status switches
   - Add mode detection logic
   - Implement fetchDocumentPermissions() with mode handling
   - Implement updateDocumentPermissions() (granular only)
   - Add owner-based notification
   - Remove TEI parsing code

5. **Testing**
   - Write backend unit tests for all modes
   - Write E2E tests for mode-specific behavior
   - Test mode switching
   - Test reviewer override

6. **Documentation**
   - Update `docs/development/access-control.md`
   - Update `docs/user-manual/access-control.md`
   - Add mode comparison guide
   - Document configuration

## File References

**New files:**

- `fastapi_app/lib/permissions_db.py`
- `fastapi_app/lib/models_permissions.py`
- `fastapi_app/routers/files_permissions.py`
- `fastapi_app/lib/migrations/versions/m002_permissions_db.py`
- `fastapi_app/lib/migrations/tests/test_migration_002.py`
- `tests/api/v1/files_permissions.test.js`
- `tests/api/v1/access_control.test.js`
- `tests/e2e/tests/access-control-modes.spec.js`

**Modified files:**

- `fastapi_app/lib/config_utils.py` - Add config keys
- `fastapi_app/lib/access_control.py` - Mode-aware logic
- `fastapi_app/routers/files_save.py` - Set default permissions (granular)
- `fastapi_app/routers/files_delete.py` - Delete permissions (granular)
- `fastapi_app/routers/files_list.py` - Filter by access control
- `fastapi_app/main.py` - Initialize permissions DB (conditional)
- `app/src/plugins/access-control.js` - Mode-aware UI and API calls
- `app/src/modules/tei-utils.js` - Remove permission-related code
- `docs/development/access-control.md` - Document modes and implementation
- `docs/user-manual/access-control.md` - User guide for modes
- `fastapi_app/lib/migrations/versions/__init__.py` - Register migration

## Key Design Decisions

1. **Three distinct modes** - Clear separation of concerns, no mixing
2. **Application-wide mode** - Cannot be set per collection (simplicity)
3. **Granular uses database** - Owner-based uses file metadata only
4. **Reviewer override limited** - Reviewers can delete/modify permissions but cannot edit non-owned documents when `editability: 'owner'` (prevents accidental overwriting)
5. **Collection access is baseline** - No "public" beyond collection membership
6. **Two permission levels** - 'collection' and 'owner' (not 'public/private')
7. **Owner always set** - Tracked in file metadata `created_by` field
8. **No permission history** - Audit trail not required
9. **Status switches for UI** - Simple on/off toggles (granular mode)
10. **Mode switching is clean** - Just hide/show UI, permissions ignored in other modes

## Implementation Progress

### Completed: Backend Implementation

**Configuration:**

- Added access control config keys to `config/config.json`:
  - `access-control.mode` (role-based/owner-based/granular)
  - `access-control.default-visibility` (collection/owner)
  - `access-control.default-editability` (collection/owner)

**Core Access Control Logic (`fastapi_app/lib/access_control.py`):**

- Rewrote with mode-aware functions:
  - `can_view_document()` - view access based on mode
  - `can_edit_document()` - edit access based on mode
  - `can_delete_document()` - deletion rules (reviewers + owners)
  - `can_modify_permissions()` - permission modification rights
  - `can_promote_demote()` - promotion/demotion rights
- Backwards-compatible `check_file_access()` function
- `DocumentAccessFilter` class for list filtering

**ACL Utilities (`fastapi_app/lib/acl_utils.py`):**

- Role checking: `user_has_role`, `user_has_reviewer_role`, `user_has_annotator_role`, `user_is_admin`
- File type checking: `is_gold_file`, `is_version_file`
- High-level permission API (hides implementation details):
  - `get_access_control_mode()` - returns current mode
  - `get_file_permissions(stable_id, default_owner)` - read permissions
  - `set_default_permissions_for_new_file(stable_id, owner)` - set defaults
  - `delete_permissions_for_file(stable_id)` - cleanup on delete

**Permissions Database (`fastapi_app/lib/permissions_db.py`):**

- `PermissionsDB` class with connection pooling
- DELETE journal mode (simple database, infrequent writes)
- `DocumentPermissions` dataclass
- Functions: `get_document_permissions`, `set_document_permissions`, `delete_document_permissions`
- Schema initialization with migration support
- Registered `PERMISSIONS_MIGRATIONS` in `migrations/versions/__init__.py`

**API Models (`fastapi_app/lib/models_permissions.py`):**

- `DocumentPermissionsModel` - full permission record
- `SetPermissionsRequest` - request for setting permissions
- `AccessControlModeResponse` - mode and defaults

**Permissions Router (`fastapi_app/routers/files_permissions.py`):**

- `GET /files/access_control_mode` - current mode and defaults
- `GET /files/permissions/{stable_id}` - get permissions (granular only)
- `POST /files/set_permissions` - set permissions (granular only)
- Singleton pattern for PermissionsDB connection pooling

**Router Updates:**

- `files_save.py` - calls `set_default_permissions_for_new_file()` after file creation
- `files_delete.py` - calls `delete_permissions_for_file()` after successful delete
- `main.py` - registered `files_permissions` router

### Completed: Frontend Implementation

**Frontend Plugin (`app/src/plugins/access-control.js`):**

- Rewrote plugin to use mode-aware permission logic
- Fetches access control mode from `GET /files/access_control_mode` on start
- Mode-specific behavior:
  - **Role-based**: Hides all permission widgets, uses role-based file type restrictions
  - **Owner-based**: Shows notification when non-owner loads document, enforces owner-only editing
  - **Granular**: Shows visibility/editability switches for owners and reviewers
- Visibility switch: toggles between "collection" (visible to all) and "owner" (visible only to owner)
- Editability switch: toggles between "collection" (editable by all) and "owner" (editable only by owner)
- Calls `POST /files/set_permissions` when switches change
- Updates read-only context text based on access control reason

**Frontend Utilities (`app/src/modules/acl-utils.js`):**

- Updated `canEditDocumentWithPermissions()` to use new vocabulary (collection/owner)
- Updated `canViewDocumentWithPermissions()` to use new vocabulary
- Updated `canEditFile()` to use new vocabulary

**API Client:**

- Regenerated `app/src/modules/api-client-v1.js` with new permission endpoints:
  - `filesAccessControlMode()` - get current mode
  - `filesPermissions(stable_id)` - get permissions for artifact
  - `filesSetPermissions(request)` - set permissions for artifact

### Completed: Backend Tests

**API Tests (`tests/api/v1/files_permissions.test.js`):**

- Tests for `GET /files/access_control_mode` endpoint
- Tests for permissions API returning 400 in role-based mode
- Tests for getting permissions in granular mode
- Tests for setting permissions as owner in granular mode
- Tests for non-owner being rejected when setting permissions
- Tests for restoring default permissions

### Completed: Documentation

**Developer Documentation (`docs/development/access-control.md`):**

Added new section "Document-Level Access Control Modes" covering:

- Mode overview (role-based, owner-based, granular)
- Configuration via `config/config.json`
- Permission semantics (collection vs owner)
- Database schema for granular mode
- API endpoints reference
- Reviewer override rules
- Mode-specific behavior details

**User Documentation (`docs/user-manual/access-control.md`):**

Complete rewrite covering:

- Access Control Layers (collection-based, role-based, document-level)
- Role capabilities table (User, Annotator, Reviewer, Admin)
- Access Control Modes explanations for end users
- Using Permission Controls (status bar switches in granular mode)
- Read-Only Indicators and their meanings
- Creating your own version workflow
- Document Ownership rules (upload, extraction, new versions, gold files)
- Ownership and Deletion permissions
- Tips for Collaborative Editing
- Troubleshooting section
- Administrator configuration section

### Completed: File Ownership Tracking (`created_by` Field)

**Database Migration 007 (`fastapi_app/lib/migrations/versions/m007_add_created_by_column.py`):**

- Added `created_by TEXT` column to `files` table
- Created `idx_created_by` index for efficient owner lookups
- Existing files have `created_by=NULL` (reviewers can manage them)
- Migration is idempotent with `check_can_apply()` verification
- Downgrade support: drops index and column

**Model Updates (`fastapi_app/lib/models.py`):**

- Added `created_by: Optional[str] = None` to `FileMetadata` model
- Added `created_by: Optional[str] = None` to `FileCreate` model

**Schema Documentation (`fastapi_app/lib/db_schema.py`):**

- Removed `created_by` from base schema (added by migration only)
- Added comment: `-- Note: created_by column is added by migration 007`
- Added comment: `# idx_created_by is created by migration 007`

**File Creation Points Updated:**

- `fastapi_app/routers/files_save.py` - Sets `created_by=user.get('username')` when:
  - Creating new version files
  - Creating gold standard files
- `fastapi_app/routers/files_upload.py` - Sets `created_by=user.get('username')` on PDF/TEI upload
- `fastapi_app/routers/extraction.py` - Sets `created_by=current_user.get('username')` when extracting TEI from PDF

**Migration Registration (`fastapi_app/lib/migrations/versions/__init__.py`):**

- Added `Migration007AddCreatedByColumn` import
- Added to `METADATA_MIGRATIONS` list
- Added to `ALL_MIGRATIONS` list

**Migration Tests (`fastapi_app/lib/migrations/tests/test_migrations_005-007.py`):**

- Renamed from `test_migrations_005_006.py`
- Added tests for migration 007:
  - `test_migration_007_adds_created_by_column` - verifies column addition
  - `test_migration_007_creates_index` - verifies index creation
  - `test_migration_007_existing_files_have_null_created_by` - verifies NULL for existing files
  - `test_migration_007_is_idempotent` - verifies repeated application
  - `test_migration_007_skips_if_column_exists` - verifies skip when already applied
  - `test_migration_007_downgrade` - verifies rollback removes column and index
