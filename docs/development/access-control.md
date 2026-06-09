# Access Control System

The PDF-TEI-Editor implements a multi-layered access control system that combines role-based access control (RBAC) with project-based collection filtering.

## Overview

The access control system operates at three levels:

1. **Role-Based Access Control (RBAC)** - Controls what operations users can perform
2. **Project-Based Access Control** - Controls which documents users can see and edit via project membership
3. **Document-Level Access Control** - Controls visibility and editability of individual documents

## Architecture

### User → Projects → Collections

Users are members of projects, and projects contain collections. Documents belong to collections, and users can only access documents in collections included in their projects.

```text
User
  ↓ is member of
Projects (one or more)
  ↓ contain
Collections (one or more)
  ↓ contain
Documents
```

**Groups** are purely organisational labels (used for tagging users). They have no role in collection access resolution.

## Configuration Files

Access control is configured through JSON files in the `data/db/` directory (or `config/` for defaults):

### users.json

```json
[
  {
    "username": "editor1",
    "fullname": "Jane Editor",
    "email": "editor1@example.com",
    "passwd_hash": "...",
    "roles": ["user", "annotator"],
    "groups": ["editors"],
    "session_id": null
  }
]
```

### projects.json

```json
[
  {
    "id": "manuscripts-project",
    "name": "Manuscripts Project",
    "description": "Editors working on medieval manuscripts",
    "members": ["editor1", "editor2"],
    "collections": ["manuscripts", "letters"],
    "config": {}
  }
]
```

### groups.json

```json
[
  {
    "id": "editors",
    "name": "Editors Group",
    "description": "Editors team (organisational label only)"
  }
]
```

Groups no longer have a `collections` field. Collection access is controlled entirely by projects.

### collections.json

```json
[
  {
    "id": "manuscripts",
    "name": "Medieval Manuscripts",
    "description": "Collection of medieval manuscript transcriptions"
  }
]
```

### roles.json

```json
[
  {
    "id": "user",
    "roleName": "User",
    "description": "Basic user with read access"
  },
  {
    "id": "annotator",
    "roleName": "Annotator",
    "description": "Can create and edit version files"
  },
  {
    "id": "reviewer",
    "roleName": "Reviewer",
    "description": "Can edit gold standard files and promote versions"
  }
]
```

## Wildcard Access (`*`)

### User-Level Wildcard Role

**Wildcard Roles**: Users with `"roles": ["*"]` bypass all collection filtering and have access to all collections.

```json
{
  "username": "superadmin",
  "roles": ["*"],
  "groups": ["admin"]
}
```

### Project-Level Wildcard Collections

**Wildcard Collections**: Projects with `"collections": ["*"]` grant all members access to all collections.

```json
{
  "id": "admin-project",
  "name": "Administrators",
  "members": ["admin"],
  "collections": ["*"]
}
```

## Collection Access Resolution

The system resolves collection access using this priority order:

1. **Check for wildcard role** - If user has `*` in roles → access to all collections
2. **Load user's projects** - Find all projects where the user appears in `members[]`
3. **Check each project** - For each project the user belongs to:
   - If project has `*` in collections → access to all collections
   - Otherwise, add the specific collection IDs to the accessible set
4. **Return result**:
   - `None` (if any wildcard was found) = access to all collections
   - `[]` (empty list) = no collection access
   - `["col1", "col2"]` = access to specific collections

## Implementation

### Helper Functions

The [user_utils.py](../../fastapi_app/lib/permissions/user_utils.py) module provides collection access helpers:

#### `get_user_collections(user, db_dir)`

Returns the list of collections accessible to a user based on their project memberships.

```python
from fastapi_app.lib.permissions.user_utils import get_user_collections

# Get accessible collections
accessible_collections = get_user_collections(current_user, settings.db_dir)

if accessible_collections is None:
    # User has access to all collections
    pass
elif not accessible_collections:
    # User has no collection access
    pass
else:
    # User has access to specific collections
    print(f"User can access: {accessible_collections}")
```

**Returns:**

- `None` - User has access to all collections (wildcard)
- `[]` - User has no collection access (anonymous or no project memberships)
- `["col1", "col2", ...]` - User has access to specific collections

The [project_utils.py](../../fastapi_app/lib/utils/project_utils.py) module provides project helpers:

#### `get_user_projects(user, db_dir)`

Returns all projects where the user is listed in `members[]`.

```python
from fastapi_app.lib.utils.project_utils import get_user_projects

projects = get_user_projects(current_user, settings.db_dir)
for project in projects:
    print(f"Project: {project['name']}, collections: {project['collections']}")
```

#### `user_has_collection_access(user, collection_id, db_dir)`

Checks if a user has access to a specific collection.

```python
from fastapi_app.lib.permissions.user_utils import user_has_collection_access

# Check access to specific collection
if user_has_collection_access(current_user, 'manuscripts', settings.db_dir):
    # User has access
    pass
```

**Returns:** `True` if user has access, `False` otherwise

### API Endpoints

#### Files List Endpoint

The `/api/v1/files/list` endpoint ([files_list.py:155-178](../../fastapi_app/routers/files_list.py#L155-L178)) filters files based on collection access:

```python
# Get user's accessible collections
accessible_collections = get_user_collections(current_user, settings.db_dir)

if accessible_collections is not None:
    # Filter documents by collections
    files_data = []
    for doc_group in documents_map.values():
        doc_collections = doc_group.collections or []
        # Include if document has any accessible collection
        if any(col in accessible_collections for col in doc_collections):
            files_data.append(doc_group)
else:
    # User has access to all collections
    files_data = list(documents_map.values())

# Apply document-level access control
files_data = DocumentAccessFilter.filter_files_by_access(files_data, current_user)
```

#### File Save Endpoint

The `/api/v1/files/save` endpoint ([files_save.py:56-89](../../fastapi_app/routers/files_save.py#L56-L89)) validates collection access before saving:

```python
def _validate_collection_access(user, doc_collections, db_dir, logger_inst):
    """Validate user has access to document's collections."""
    # Documents must have at least one collection
    if not doc_collections:
        raise HTTPException(403, "Cannot save file: document has no collections")

    # Check if user has access to any of the document's collections
    has_access = any(
        user_has_collection_access(user, col_id, db_dir)
        for col_id in doc_collections
    )

    if not has_access:
        raise HTTPException(
            403,
            f"You do not have access to any of this document's collections: {', '.join(doc_collections)}"
        )
```

This validation is performed before:

- Updating existing files
- Creating new versions
- Creating new gold standard files

## Document Collections

Documents inherit their collections from their source PDF file. All TEI artifacts (gold standards and versions) for a document share the same collections.

```python
# Get PDF file to inherit collections
pdf_file = file_repo.get_pdf_for_document(doc_id)
doc_collections = pdf_file.doc_collections if pdf_file else []

# Create file with inherited collections
created_file = file_repo.insert_file(FileCreate(
    id=saved_hash,
    doc_id=doc_id,
    doc_collections=doc_collections,  # Inherited from PDF
    # ... other fields
))
```

## RBAC Manager Plugin

The frontend RBAC Manager plugin ([app/src/plugins/rbac-manager.js](../../app/src/plugins/rbac-manager.js)) provides a user interface for managing access control. It allows administrators to:

- View and manage users, groups, roles, collections, and projects
- Assign users to groups (organisational labels only)
- Configure project members and collections
- Manage user roles
- Set per-collection and per-project configuration overrides

The RBAC Manager integrates with the backend API endpoints to provide real-time access control management.

## Access Control Flow

### Reading Files (GET /api/v1/files/list)

```
1. User authenticates
2. System loads user's groups from users.json
3. System resolves accessible collections:
   - Check for wildcards (*, admin role)
   - Collect collections from all user's groups
4. System queries all files from database
5. System filters files by collections:
   - Keep only documents in accessible collections
6. System applies document-level ACL:
   - Check visibility (public/private)
   - Check editability (editable/protected)
7. Return filtered file list
```

### Writing Files (POST /api/v1/files/save)

```
1. User authenticates
2. System determines document collections:
   - For existing files: use file's doc_collections
   - For new files: inherit from PDF's doc_collections
3. System validates collection access:
   - Resolve user's accessible collections
   - Check if user has access to any doc collection
   - Reject if no access
4. System validates role permissions:
   - Check if user can edit gold/versions
5. System saves file
```

## Security Considerations

### Collection Requirement

Documents **must** belong to at least one collection. Attempting to save a file with no collections will result in an HTTP 403 error.

### Anonymous Access

Anonymous users (not authenticated) have:

- No collection access
- Only read access to public documents
- No write access

### Wildcard Security

Use wildcards carefully:

- `"roles": ["*"]` grants superuser permissions
- `"groups": ["*"]` grants access to all collections
- `"collections": ["*"]` in a group grants all members access to all collections

### Collection Inheritance

Collections are inherited from the source PDF file. Users cannot:

- Change a document's collections via the save endpoint
- Create files in collections they don't have access to
- Edit files in collections they don't have access to

## Testing

The [test_collection_access_control.py](../../tests/unit/fastapi/test_collection_access_control.py) test suite verifies:

- Anonymous user has no collection access
- Wildcard roles grant access to all collections
- Admin role grants access to all collections
- Wildcard groups grant access to all collections
- Specific group collections work correctly
- Multiple group memberships combine collections
- Group wildcard collections grant access to all
- Users with no groups have no collection access
- Nonexistent groups don't grant access
- Mixed wildcard and specific groups resolve correctly

### Test Isolation

The tests use **isolated temporary directories** and do not modify the main application's data files in `data/db/`. Each test:

1. Creates a `tempfile.TemporaryDirectory()` for the test database
2. Passes the temporary `db_dir` to all utility functions
3. Cleans up the temporary directory after the test completes

This ensures tests are:

- **Safe** - Never modify production/development data
- **Fast** - No I/O to main filesystem
- **Isolated** - Each test has a clean environment
- **Repeatable** - No side effects between test runs

Run tests:

```bash
uv run python -m pytest tests/unit/fastapi/test_collection_access_control.py -v
```

## Examples

### Example 1: Basic Editor Setup

```json
// users.json
{
  "username": "editor1",
  "roles": ["user", "annotator"],
  "groups": []
}

// projects.json
{
  "id": "manuscript-project",
  "name": "Manuscript Editors",
  "members": ["editor1"],
  "collections": ["manuscripts"],
  "config": {}
}
```

**Result:** User can see and edit documents in the `manuscripts` collection.

### Example 2: Multi-Collection Access via Multiple Projects

```json
// users.json
{
  "username": "researcher1",
  "roles": ["user"],
  "groups": []
}

// projects.json
[
  {
    "id": "manuscripts-project",
    "members": ["researcher1"],
    "collections": ["manuscripts"]
  },
  {
    "id": "letters-project",
    "members": ["researcher1"],
    "collections": ["letters", "correspondence"]
  }
]
```

**Result:** User can access documents in `manuscripts`, `letters`, and `correspondence` collections.

### Example 3: Administrator Setup

```json
// users.json
{
  "username": "admin",
  "roles": ["*"],
  "groups": []
}
```

**Result:** User has access to all collections (wildcard role bypasses project resolution).

Alternatively, without a wildcard role:

```json
// projects.json
{
  "id": "admin-project",
  "members": ["admin"],
  "collections": ["*"]
}
```

**Result:** User has access to all collections via wildcard project collections.

## Migration Notes

When migrating from the old group-based access control:

The startup migration (`fastapi_app/lib/utils/project_utils.py`) automatically converts `groups[].collections` entries into projects. Each group that had collections becomes a project with those collections and the group's members as project members. After migration, `groups[].collections` is ignored by the access control layer.

To create a project granting all existing users access to a collection:

```bash
node bin/debug-api.js POST /api/v1/projects '{"id":"default","name":"Default","members":["user1","user2"],"collections":["default"]}'
```

## Document-Level Access Control Modes

In addition to collection-based access control, the system supports three modes for document-level permissions. This is configured application-wide via `access-control.mode` in `config/config.json`.

### Configuration

```json
{
  "access-control.mode": "role-based",
  "access-control.default-visibility": "collection",
  "access-control.default-editability": "owner"
}
```

**Mode values:**

- `role-based` (default) - No document-level permissions, only role restrictions
- `owner-based` - Documents editable only by their creator
- `granular` - Database-backed per-document visibility and editability settings

### Mode 1: Role-Based (Default)

In role-based mode, document access is determined solely by user roles and file types:

- **Gold files**: Only reviewers can edit
- **Version files**: Annotators and reviewers can edit
- **Deletion**: Only reviewers and document owners can delete

No document-level permission UI is shown. This mode is suitable for teams where role-based restrictions are sufficient.

### Mode 2: Owner-Based

In owner-based mode, documents are editable only by their creator:

- Documents are read-only for everyone except the owner
- Reviewers can delete any document
- To edit a non-owned document, users must create their own version

When a non-owner opens a document, they see a notification: "This document is owned by [username]. Create your own version to edit."

### Mode 3: Granular

Granular mode provides per-document visibility and editability settings stored in a SQLite database (`data/db/permissions.db`).

**Permission attributes:**

- `visibility`: `'collection'` (visible to all with collection access) or `'owner'` (visible only to owner and reviewers)
- `editability`: `'collection'` (editable by all) or `'owner'` (editable only by owner)
- `owner`: Username of the document creator

**UI:** Owners and reviewers see two toggle switches in the status bar:

- **Visibility switch**: Toggle between "Visible to all" and "Visible to owner"
- **Editability switch**: Toggle between "Editable by all" and "Editable by owner"

**Default permissions for new documents:**

- `visibility`: value of `access-control.default-visibility` (default: `collection`)
- `editability`: value of `access-control.default-editability` (default: `owner`)

### Backend Implementation

**Core modules:**

- [access_control.py](../../fastapi_app/lib/permissions/access_control.py) - Mode-aware permission checking functions
- [acl_utils.py](../../fastapi_app/lib/permissions/acl_utils.py) - Role checking and high-level permission API
- [permissions_db.py](../../fastapi_app/lib/repository/permissions_db.py) - SQLite database for granular permissions

**API endpoints (granular mode only):**

- `GET /api/v1/files/access_control_mode` - Returns current mode and defaults
- `GET /api/v1/files/permissions/{stable_id}` - Get permissions for a document
- `POST /api/v1/files/set_permissions` - Set permissions for a document

**Permission checking functions:**

```python
from fastapi_app.lib.permissions.access_control import (
    can_view_document,
    can_edit_document,
    can_delete_document,
    can_modify_permissions,
    can_promote_demote,
    check_file_access,  # Backwards-compatible wrapper
    DocumentAccessFilter  # For filtering file lists
)
```

**High-level API (handles mode internally):**

```python
from fastapi_app.lib.permissions.acl_utils import (
    get_access_control_mode,
    get_file_permissions,
    set_default_permissions_for_new_file,
    delete_permissions_for_file
)
```

### Frontend Implementation

The [access-control.js](../../app/src/plugins/access-control.js) plugin:

1. Fetches the access control mode on startup via `filesAccessControlMode()`
2. Shows/hides UI elements based on mode
3. In granular mode, displays switches for owners/reviewers to modify permissions
4. Enforces read-only state when user lacks edit permissions

**ACL utilities in frontend:**

```javascript
import {
  canEditDocumentWithPermissions,
  canViewDocumentWithPermissions,
  canEditFile,
  userHasReviewerRole,
  userHasAnnotatorRole
} from '../modules/acl-utils.js'
```

### Database Schema (Granular Mode)

```sql
CREATE TABLE document_permissions (
    stable_id TEXT PRIMARY KEY,
    visibility TEXT NOT NULL DEFAULT 'collection',
    editability TEXT NOT NULL DEFAULT 'owner',
    owner TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (visibility IN ('collection', 'owner')),
    CHECK (editability IN ('collection', 'owner'))
)
```

### Reviewer Override Rules

Reviewers have elevated privileges but with intentional limitations:

- **Can always**: View all documents, delete any document, modify permissions
- **Cannot**: Edit documents with `editability: 'owner'` when not the owner (prevents accidental overwriting)
- To edit such documents, reviewers must create their own version or change the editability first

## Troubleshooting

### User cannot see any documents

**Check:**

1. User is a member of at least one project: check `data/db/projects.json`
2. That project includes the relevant collection in its `collections[]` array
3. Documents have collections assigned (check `doc_collections` in database)

### User can see documents but cannot edit

**Check:**

1. User has required role (annotator/reviewer) for the operation
2. User has collection access to the document
3. Document's visibility/editability settings (document-level ACL)

### Wildcard not working

**Check:**

1. Wildcard is exactly `"*"` (string with single asterisk)
2. Wildcard is in the correct field (roles/groups/collections)
3. No typos in JSON configuration files
