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

## Management CLI

The `bin/manage.py` script provides commands to manage users, groups, and collections.

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

## Migration Notes

If migrating from a system without collection-based access control:

1. **Create default collection**:

   ```bash
   ./bin/manage.py collection add default "Default Collection"
   ```

2. **Create default group**:

   ```bash
   ./bin/manage.py group add default "Default Group"
   ./bin/manage.py group add-collection default default
   ```

3. **Add all users to default group**:

   ```bash
   ./bin/manage.py user add-group user1 default
   ./bin/manage.py user add-group user2 default
   # ... for all users
   ```

4. **Assign collections to existing documents** (requires database update):

   ```sql
   UPDATE files SET doc_collections = '["default"]' WHERE doc_collections IS NULL;
   ```

## Troubleshooting

### User cannot see any documents

**Check:**

1. User has at least one group: `./bin/manage.py user list`
2. Groups have collections: `./bin/manage.py group list`
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
