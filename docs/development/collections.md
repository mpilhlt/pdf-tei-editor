# Collection Management

Technical reference for the collection management system.

## Overview

Collections organize documents into groups. Documents can belong to multiple collections simultaneously. Access control is enforced through group memberships.

## Backend (FastAPI)

### Data Storage

**Location**: `data/db/collections.json`

**Schema**:
```json
[
  {
    "id": "collection-id",
    "name": "Display Name",
    "description": "Optional description"
  }
]
```

**Database**: Document-to-collection mapping stored in `metadata.db`:
- PDF files have `doc_collections` field (JSON array: `["collection1", "collection2"]`)
- TEI files inherit collections from their parent PDF (via `doc_id`)

### API Endpoints

**Router**: `fastapi_app/routers/collections.py`

#### GET /api/v1/collections/list
Returns collections filtered by RBAC:
- Admins/wildcard roles: all collections
- Regular users: only collections their groups have access to
- Anonymous: empty list

**Implementation**:
```python
accessible_collection_ids = get_user_collections(current_user, settings.db_dir)
# Returns: None (all), [] (none), or [ids] (specific)
```

#### POST /api/v1/collections/create
Creates new collection. Requires admin or reviewer role.

**Request**:
```json
{
  "id": "collection-id",
  "name": "Display Name",  // Optional, defaults to id
  "description": ""
}
```

### RBAC Integration

**Function**: `get_user_collections(user, db_dir)` in `fastapi_app/lib/permissions/user_utils.py:325`

**Logic**:
1. Check user roles for `*` or `admin` → return `None` (all collections)
2. Check user groups for `*` → return `None`
3. Collect all collections from user's groups
4. Check each group's collections for `*` → return `None`
5. Return union of all group collections

**Files List Filtering**: `fastapi_app/routers/files_list.py:155-173`
```python
accessible_collections = get_user_collections(current_user, settings.db_dir)
if accessible_collections is not None:
    # Filter documents where ANY collection is accessible
    files_data = [
        doc_group for doc_group in documents_map.values()
        if any(col in accessible_collections for col in doc_group.collections)
    ]
```

### File Operations

**Copy**: `POST /api/v1/files/copy`
- Adds destination collection to document's collections array
- Document appears in both source and destination collections

**Move**: `POST /api/v1/files/move`
- Replaces document's collections array with destination collection
- Document only appears in destination collection

Both operations update the PDF file's `doc_collections` field in the database.

## Frontend

### State Management

**Location**: `app/src/state.js`

**Type Definition**:
```javascript
/**
 * @typedef {object} CollectionInfo
 * @property {string} id - Unique collection identifier
 * @property {string} name - Display name for the collection
 * @property {string} description - Collection description
 */
```

**State Property**: `collections: CollectionInfo[] | null`

### Loading Collections

**Plugin**: `app/src/plugins/filedata.js:87-116`

Collections loaded on startup via `client.getCollections()` and stored in state alongside fileData.

**Validation**: Warns if documents reference non-existent collections (doesn't block).

### API Client

**Location**: `app/src/plugins/client.js`

**Methods**:
- `getCollections()` - GET /api/v1/collections/list
- `createCollection(id, name, description)` - POST /api/v1/collections/create
- `copyFiles(pdf, xml, destinationCollection)` - POST /api/v1/files/copy
- `moveFiles(pdf, xml, destinationCollection)` - POST /api/v1/files/move

**Auto-generated Client**: `app/src/modules/api-client-v1.js`
- Run `npm run generate-client` after backend changes to regenerate

### Display

**Helper Function**: `getCollectionName(collectionId, collections)` in `app/src/modules/file-data-utils.js:338`

Returns display name from collections state, with fallbacks:
1. Collection name from state
2. Special case: `"__unfiled"` → `"Unfiled"`
3. Fallback: `collectionId.replaceAll("_", " ")`

**Used by**:
- `app/src/plugins/file-selection-drawer.js:329`
- `app/src/plugins/file-selection.js:379`

### Grouping

**Function**: `groupFilesByCollection(fileData)` in `app/src/modules/file-data-utils.js:225`

Groups documents by collection for UI display. Documents with multiple collections appear in all collection groups.

**Implementation**:
```javascript
for (const collection_name of file.collections) {
  groups[collection_name] ||= []
  groups[collection_name].push(file);
}
```

**Used by**:
- `app/src/plugins/file-selection-drawer.js:288`
- `app/src/plugins/file-selection.js:366`

### Move/Copy UI

**Plugin**: `app/src/plugins/move-files.js`
**Template**: `app/src/templates/move-files-dialog.html`

**Features**:
- Populate select from `state.collections`
- Checkbox toggles copy vs move mode
- Button to create new collection
- Reloads file data after operation via `fileselection.reload()`

## Special Collections

- `_inbox`: Default for newly extracted documents
- `__unfiled`: Client-side placeholder for documents with no collections

## Common Issues

### Document not appearing in collection
1. Check database: `SELECT doc_id, doc_collections FROM files WHERE doc_id = '...'`
2. Verify RBAC: User's groups must have access to at least one of the document's collections
3. Check frontend reload: Move/copy operations call `fileselection.reload()`
4. Verify grouping: Documents appear in ALL their collections (not just first)

### Collections not loading
1. Check API endpoint: `GET /api/v1/collections/list` with session header
2. Verify auto-generated client is up to date: `npm run generate-client`
3. Check browser console for errors in `filedata.js` reload

### New collection not appearing
1. Verify creation succeeded: Check `data/db/collections.json`
2. Ensure RBAC allows access: User's groups must include the collection
3. Check if file data was reloaded after creation

## Related Documentation

- [Access Control System](access-control.md) - RBAC and collection-based access control
- [Architecture Overview](architecture.md) - Complete system architecture
- [API Reference](api-reference.md) - Complete FastAPI endpoint documentation
