# Access Control System

The PDF-TEI-Editor implements a multi-layered access control system that combines role-based access control (RBAC) with collection-based filtering.

## Overview

The access control system operates at three levels:

1. **Role-Based Access Control (RBAC)** - Controls what operations users can perform
2. **Collection-Based Access Control** - Controls which documents users can see and edit
3. **Document-Level Access Control** - Controls visibility and editability of individual documents

## Architecture

### User → Groups → Collections

Users are assigned to groups, and groups have access to specific collections. Documents belong to collections, and users can only access documents in collections their groups have access to.

```
User
  ↓ belongs to
Groups (one or more)
  ↓ have access to
Collections (one or more)
  ↓ contain
Documents
```

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

### groups.json

```json
[
  {
    "id": "editors",
    "name": "Editors Group",
    "description": "Editors with access to manuscripts",
    "collections": ["manuscripts", "letters"]
  }
]
```

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

The wildcard `*` character grants unrestricted access at any level:

### User-Level Wildcards

**Wildcard Roles**: Users with `"roles": ["*"]` have all permissions

```json
{
  "username": "superadmin",
  "roles": ["*"],
  "groups": ["admin"]
}
```

**Admin Role**: Users with `"roles": ["admin"]` have access to all collections

```json
{
  "username": "admin",
  "roles": ["admin", "user"],
  "groups": ["staff"]
}
```

**Wildcard Groups**: Users with `"groups": ["*"]` have access to all collections

```json
{
  "username": "manager",
  "roles": ["user"],
  "groups": ["*"]
}
```

### Group-Level Wildcards

**Wildcard Collections**: Groups with `"collections": ["*"]` grant access to all collections

```json
{
  "id": "admin-group",
  "name": "Administrators",
  "collections": ["*"]
}
```

## Collection Access Resolution

The system resolves collection access using this priority order:

1. **Check for wildcard roles** - If user has `*` or `admin` in roles → access to all collections
2. **Check for wildcard groups** - If user has `*` in groups → access to all collections
3. **Check each group** - For each group the user belongs to:
   - If group has `*` in collections → access to all collections
   - Otherwise, collect all specific collection IDs from the group
4. **Return result**:
   - `null` (if any wildcard was found) = access to all collections
   - `[]` (empty list) = no collection access
   - `["col1", "col2"]` = access to specific collections

## Implementation

### Helper Functions

The [user_utils.py](../../fastapi_app/lib/user_utils.py) module provides collection access helpers:

#### `get_user_collections(user, db_dir)`

Returns the list of collections accessible to a user.

```python
from fastapi_app.lib.user_utils import get_user_collections

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
- `[]` - User has no collection access (anonymous or no groups)
- `["col1", "col2", ...]` - User has access to specific collections

#### `user_has_collection_access(user, collection_id, db_dir)`

Checks if a user has access to a specific collection.

```python
from fastapi_app.lib.user_utils import user_has_collection_access

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

## Document-Level Access Control

Documents have individual access control settings stored in their TEI XML headers. These settings work in combination with role-based and collection-based access control to determine final permissions.

### Permission Attributes

Each document has three permission attributes:

- **visibility**: `public` | `private` - Controls who can view the document
- **editability**: `editable` | `protected` - Controls who can edit the document
- **owner**: `username` | `null` - The document owner (null for public editable documents)

### TEI XML Storage

Document permissions are stored in the `<revisionDesc>` element as `<label>` elements within a `<change>` entry:

```xml
<revisionDesc>
  <change when="2025-01-09T12:00:00Z" who="#username">
    <desc>Access permissions updated</desc>
    <label type="visibility">private</label>
    <label type="access">protected</label>
    <label type="owner" ana="#username">Full Name</label>
  </change>
</revisionDesc>
```

**Legacy support:** The `type="access"` label historically used `private` to mean `protected`. The system automatically normalizes this to `protected` when parsing.

### Permission Parsing

The [access-control.js:338-411](../../app/src/plugins/access-control.js#L338-L411) plugin parses permissions from the TEI DOM tree:

1. Finds all `<change>` elements in `<revisionDesc>`
2. Locates the last `<change>` containing permission labels
3. Extracts `visibility`, `access` (editability), and `owner` labels
4. Owner is parsed from `ana="#username"` attribute (preferred) or text content (fallback)

### Access Control Rules

**View Access:**

- Public documents: viewable by anyone
- Private documents: viewable only by owner or admins

**Edit Access:** (evaluated in order)

1. Admin users: can edit any document
2. Role-based restrictions (file type):
   - Gold files: require `reviewer` role
   - Version files: require `annotator` or `reviewer` role
3. Private documents: only owner can edit
4. Protected documents: only owner can edit

See [acl-utils.js:215-247](../../app/src/modules/acl-utils.js#L215-L247) for the complete edit permission logic.

### Permission Updates

Permissions are updated via [access-control.js:421-537](../../app/src/plugins/access-control.js#L421-L537):

1. Creates new `<change>` element with timestamp and current user
2. Adds `<label>` elements for visibility, access, and owner
3. Ensures `<respStmt>` exists for both current user and owner
4. Pretty-prints the `<teiHeader>` for proper formatting
5. Updates editor DOM and saves to file storage

When setting `private` or `protected`, the current user automatically becomes owner if no owner exists.

### Frontend Integration

The access-control plugin ([access-control.js](../../app/src/plugins/access-control.js)):

- Displays permission info in the status bar (public/private, editable/protected)
- Provides dropdown for users who can modify permissions
- Sets `editorReadOnly` state based on computed permissions
- Updates read-only widget with context (e.g., "Read-only (owned by username)")

The plugin enforces read-only state when:

- Document is private and user is not owner
- Document is protected and user is not owner
- User lacks required role for file type (gold/version)

### Backend Access Filtering

The backend `/api/v1/files/list` endpoint filters documents by document-level permissions:

```python
from fastapi_app.lib.document_access import DocumentAccessFilter

# After collection filtering
files_data = DocumentAccessFilter.filter_files_by_access(files_data, current_user)
```

This removes documents the user cannot view based on visibility and ownership.

## RBAC Manager Plugin

The frontend RBAC Manager plugin ([app/src/plugins/rbac-manager.js](../../app/src/plugins/rbac-manager.js)) provides a user interface for managing access control. It allows administrators to:

- View and manage users, groups, and collections
- Assign users to groups
- Configure group collection access
- Manage user roles

The RBAC Manager integrates with the backend API endpoints to provide real-time access control management.

## Management CLI

The `bin/manage.py` script provides commands to manage users, groups, and collections from the command line.

### User Management

```bash
# Add user to group
./bin/manage.py user add-group editor1 editors

# Remove user from group
./bin/manage.py user remove-group editor1 editors

# List users with their groups
./bin/manage.py user list
```

### Group Management

```bash
# Create group
./bin/manage.py group add editors "Editors Group" --description "Manuscript editors"

# Add collection to group
./bin/manage.py group add-collection editors manuscripts

# Add wildcard collection access
./bin/manage.py group add-collection admin-group "*"

# Remove collection from group
./bin/manage.py group remove-collection editors manuscripts

# List groups with their collections
./bin/manage.py group list
```

### Collection Management

```bash
# Create collection
./bin/manage.py collection add manuscripts "Manuscripts" --description "Medieval manuscripts"

# List collections
./bin/manage.py collection list
```

## Access Control Flow

### Reading Files (GET /api/v1/files/list)

```text
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

## Examples

### Example 1: Basic Editor Setup

```json
// users.json
{
  "username": "editor1",
  "roles": ["user", "annotator"],
  "groups": ["manuscript-editors"]
}

// groups.json
{
  "id": "manuscript-editors",
  "name": "Manuscript Editors",
  "collections": ["manuscripts"]
}
```

**Result:** User can see and edit documents in the `manuscripts` collection.

### Example 2: Multi-Collection Access

```json
// users.json
{
  "username": "researcher1",
  "roles": ["user"],
  "groups": ["manuscripts-group", "letters-group"]
}

// groups.json
[
  {
    "id": "manuscripts-group",
    "collections": ["manuscripts"]
  },
  {
    "id": "letters-group",
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
  "roles": ["admin", "reviewer"],
  "groups": ["admin-group"]
}

// groups.json
{
  "id": "admin-group",
  "name": "Administrators",
  "collections": ["*"]
}
```

**Result:** User has access to all collections and all permissions.

### Example 4: Project Manager

```json
// users.json
{
  "username": "pm1",
  "roles": ["user"],
  "groups": ["*"]
}
```

**Result:** User has access to all collections but limited to user-level permissions (read-only).

