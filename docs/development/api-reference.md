# FastAPI REST API Reference

This document provides a comprehensive reference for all FastAPI REST endpoints in the PDF-TEI Editor.

## Base URL

- **Development**: `http://localhost:8000/api/v1`
- **Production**: Configured via deployment settings

## Authentication

Most endpoints require authentication via session cookie:

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "user",
  "passwd_hash": "sha256_hash"
}
```

Response includes `Set-Cookie` header with session ID. Include this cookie in subsequent requests.

## Common Response Patterns

### Success Response

```json
{
  "status": "success",
  "data": { ... }
}
```

### Error Response

```json
{
  "detail": "Error message"
}
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `204` - No Content (successful deletion)
- `400` - Bad Request (validation error)
- `401` - Unauthorized (authentication required)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error

## Collections API

Base path: `/api/v1/collections`

### List Collections

```http
GET /api/v1/collections
```

**Description**: List all collections accessible to the current user.

**Authorization**: Optional (anonymous users get empty list)

**Response**: `200 OK`

```json
[
  {
    "id": "manuscripts",
    "name": "Medieval Manuscripts",
    "description": "Collection of medieval manuscript transcriptions"
  }
]
```

**Access Control**:

- Admins/wildcard roles: all collections
- Regular users: only collections their groups have access to
- Anonymous: empty list

### Get Collection

```http
GET /api/v1/collections/{collection_id}
```

**Response**: `200 OK`

```json
{
  "id": "manuscripts",
  "name": "Medieval Manuscripts",
  "description": "Collection of medieval manuscript transcriptions"
}
```

### Create Collection

```http
POST /api/v1/collections
Content-Type: application/json

{
  "id": "new-collection",
  "name": "New Collection",
  "description": "Optional description"
}
```

**Authorization**: Requires `admin` or `reviewer` role

**Response**: `201 Created`

### Update Collection

```http
PUT /api/v1/collections/{collection_id}
Content-Type: application/json

{
  "name": "Updated Name",
  "description": "Updated description"
}
```

**Authorization**: Requires `admin` or `reviewer` role

**Response**: `200 OK`

### Delete Collection

```http
DELETE /api/v1/collections/{collection_id}
```

**Authorization**: Requires `admin` role

**Response**: `204 No Content`

## Files API

Base path: `/api/v1/files`

### List Files

```http
GET /api/v1/files/list
```

**Description**: Get list of all files accessible to the current user.

**Authorization**: Required (except if `FASTAPI_ALLOW_ANONYMOUS_ACCESS=true`)

**Query Parameters**:

- `collection` (optional): Filter by collection ID
- `variant` (optional): Filter by variant ID

**Response**: `200 OK`

```json
{
  "files": [
    {
      "id": "abc123...",
      "stable_id": "abc123",
      "doc_id": "document-1",
      "file_type": "pdf",
      "doc_collections": ["manuscripts"],
      "doc_metadata": {
        "title": "Medieval Text",
        "author": "Unknown"
      },
      "storage_path": "files/ab/c1/abc123...",
      "created_at": "2025-11-28T10:00:00",
      "updated_at": "2025-11-28T10:00:00"
    }
  ]
}
```

**Access Control**:

- Filters by user's accessible collections
- Excludes soft-deleted files
- Applies document-level ACL

### Serve File

```http
GET /api/v1/files/{document_id}
```

**Description**: Serve file content (PDF or XML).

**Authorization**: Required

**Query Parameters**:

- `variant` (optional): Variant ID for TEI files
- `type` (optional): `"pdf"` or `"xml"`

**Response**: `200 OK`

- Content-Type: `application/pdf` or `application/xml`
- File content in body

### Save File

```http
POST /api/v1/files/save
Content-Type: multipart/form-data

doc_id: document-1
content: <TEI>...</TEI>
variant: translation-fr
is_gold_standard: false
```

**Description**: Save TEI XML content (creates new version or updates gold standard).

**Authorization**: Required

- **Gold standard**: Requires `reviewer` role
- **Version files**: Requires `annotator` or `reviewer` role

**Request**:

- `doc_id`: Document identifier
- `content`: TEI XML content
- `variant` (optional): Variant identifier
- `is_gold_standard` (optional): Boolean, default false

**Response**: `200 OK`

```json
{
  "hash": "def456...",
  "stable_id": "def456",
  "created": true,
  "message": "File saved successfully"
}
```

**Validation**:

- User must have collection access
- Content must be valid XML
- Appropriate role required

### Upload PDF

```http
POST /api/v1/files/upload
Content-Type: multipart/form-data

file: <binary PDF data>
collection: manuscripts
metadata: {"title": "New Document"}
```

**Description**: Upload new PDF file.

**Authorization**: Requires `annotator` or `reviewer` role

**Response**: `200 OK`

```json
{
  "doc_id": "new-doc-1",
  "hash": "abc789...",
  "stable_id": "abc789",
  "collections": ["manuscripts"]
}
```

### Create Version from Upload

```http
POST /api/v1/files/create_version_from_upload
Content-Type: multipart/form-data

doc_id: document-1
file: <binary TEI XML data>
variant: translation-fr
```

**Description**: Create new TEI version from uploaded file.

**Authorization**: Requires `annotator` or `reviewer` role

**Response**: `200 OK`

### Copy Files

```http
POST /api/v1/files/copy
Content-Type: application/json

{
  "pdf": "document-1",
  "xml": "abc123",
  "destination_collection": "archive"
}
```

**Description**: Copy document to another collection (adds collection to doc_collections).

**Authorization**: Required

**Response**: `200 OK`

```json
{
  "message": "Files copied successfully"
}
```

### Move Files

```http
POST /api/v1/files/move
Content-Type: application/json

{
  "pdf": "document-1",
  "xml": "abc123",
  "destination_collection": "archive"
}
```

**Description**: Move document to another collection (replaces doc_collections).

**Authorization**: Required

**Response**: `200 OK`

```json
{
  "message": "Files moved successfully"
}
```

### Delete Files

```http
POST /api/v1/files/delete
Content-Type: application/json

{
  "pdf": "document-1",
  "xml": "abc123"
}
```

**Description**: Delete PDF and associated TEI files (soft delete).

**Authorization**: Required

**Response**: `200 OK`

```json
{
  "message": "Files deleted successfully",
  "deleted_count": 3
}
```

### Garbage Collect

```http
POST /api/v1/files/garbage_collect
```

**Description**: Remove unreferenced files from filesystem.

**Authorization**: Requires `admin` role

**Response**: `200 OK`

```json
{
  "message": "Garbage collection completed",
  "files_removed": 5,
  "space_freed": "1.2 MB"
}
```

## File Locks API

Base path: `/api/v1/files`

### Get Locks

```http
GET /api/v1/files/locks?doc_id=document-1
```

**Description**: Get current locks for a document.

**Response**: `200 OK`

```json
{
  "locks": [
    {
      "doc_id": "document-1",
      "file_type": "xml",
      "locked_by": "user1",
      "locked_at": "2025-11-28T10:00:00",
      "expires_at": "2025-11-28T10:05:00"
    }
  ]
}
```

### Check Lock

```http
POST /api/v1/files/check_lock
Content-Type: application/json

{
  "doc_id": "document-1",
  "file_type": "xml"
}
```

**Response**: `200 OK`

```json
{
  "locked": true,
  "locked_by": "user1",
  "can_override": false
}
```

### Acquire Lock

```http
POST /api/v1/files/acquire_lock
Content-Type: application/json

{
  "doc_id": "document-1",
  "file_type": "xml",
  "duration": 300
}
```

**Response**: `200 OK`

```json
{
  "success": true,
  "expires_at": "2025-11-28T10:05:00"
}
```

### Release Lock

```http
POST /api/v1/files/release_lock
Content-Type: application/json

{
  "doc_id": "document-1",
  "file_type": "xml"
}
```

**Response**: `200 OK`

```json
{
  "success": true
}
```

## Heartbeat API

```http
POST /api/v1/files/heartbeat
Content-Type: application/json

{
  "doc_id": "document-1",
  "file_type": "xml"
}
```

**Description**: Extend lock expiration time (keep-alive for editing sessions).

**Response**: `200 OK`

```json
{
  "success": true,
  "expires_at": "2025-11-28T10:10:00"
}
```

## Extraction API

Base path: `/api/v1/extraction`

### List Extractors

```http
GET /api/v1/extraction/list
```

**Description**: Get list of available extraction services.

**Response**: `200 OK`

```json
[
  {
    "id": "grobid",
    "name": "GROBID",
    "description": "Machine learning-based PDF extraction",
    "available": true
  }
]
```

### Extract Text

```http
POST /api/v1/extraction
Content-Type: multipart/form-data

pdf_hash: abc123...
extractor: grobid
```

**Description**: Extract TEI XML from PDF using specified extractor.

**Authorization**: Required

**Response**: `200 OK`

```json
{
  "xml_hash": "def456...",
  "xml_content": "<TEI>...</TEI>",
  "extractor": "grobid"
}
```

## Validation API

Base path: `/api/v1/validation`

### Validate XML

```http
POST /api/v1/validation
Content-Type: application/json

{
  "content": "<TEI>...</TEI>",
  "type": "xml"
}
```

**Description**: Validate TEI XML against schema.

**Response**: `200 OK`

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

Or if invalid:

```json
{
  "valid": false,
  "errors": [
    {
      "line": 10,
      "column": 5,
      "message": "Element 'invalid' not allowed here"
    }
  ]
}
```

### Get Autocomplete Data

```http
POST /api/v1/validation/autocomplete-data
Content-Type: application/json

{
  "content": "<TEI>...</TEI>",
  "position": { "line": 10, "column": 5 }
}
```

**Description**: Get autocomplete suggestions for current cursor position.

**Response**: `200 OK`

```json
{
  "suggestions": [
    { "label": "teiHeader", "type": "element" },
    { "label": "text", "type": "element" }
  ]
}
```

## Schema API

Base path: `/api/v1/schema`

### Get Schema

```http
GET /api/v1/schema/{schema_type}/{variant}
```

**Description**: Get XSD or RelaxNG schema for validation.

**Parameters**:

- `schema_type`: `"xsd"` or `"rng"`
- `variant`: Schema variant name

**Response**: `200 OK`

- Content-Type: `application/xml`
- Schema content in body

## Sync API

Base path: `/api/v1/sync`

### Get Sync Status

```http
GET /api/v1/sync/status
```

**Description**: Get WebDAV sync status.

**Response**: `200 OK`

```json
{
  "enabled": true,
  "last_sync": "2025-11-28T09:00:00",
  "pending_changes": 3,
  "conflicts": 0
}
```

### Sync Files

```http
POST /api/v1/sync
Content-Type: application/json

{
  "direction": "both"
}
```

**Description**: Trigger WebDAV synchronization.

**Parameters**:

- `direction`: `"upload"`, `"download"`, or `"both"`

**Response**: `200 OK`

```json
{
  "uploaded": 5,
  "downloaded": 3,
  "conflicts": 1,
  "duration_ms": 1234
}
```

### List Conflicts

```http
GET /api/v1/sync/conflicts
```

**Description**: Get list of sync conflicts.

**Response**: `200 OK`

```json
{
  "conflicts": [
    {
      "doc_id": "document-1",
      "local_hash": "abc123...",
      "remote_hash": "def456...",
      "local_modified": "2025-11-28T10:00:00",
      "remote_modified": "2025-11-28T10:05:00"
    }
  ]
}
```

### Resolve Conflict

```http
POST /api/v1/sync/resolve-conflict
Content-Type: application/json

{
  "doc_id": "document-1",
  "resolution": "local"
}
```

**Description**: Resolve sync conflict.

**Parameters**:

- `resolution`: `"local"` (keep local) or `"remote"` (keep remote)

**Response**: `200 OK`

## SSE (Server-Sent Events) API

Base path: `/api/v1/sse`

### Subscribe to Events

```http
GET /api/v1/sse/subscribe
```

**Description**: Subscribe to server-sent events stream.

**Response**: `200 OK`

- Content-Type: `text/event-stream`
- Continuous stream of events

**Event Types**:

- `file_updated`: File was modified
- `file_deleted`: File was deleted
- `sync_started`: Sync operation began
- `sync_completed`: Sync operation finished
- `lock_acquired`: Lock was acquired
- `lock_released`: Lock was released

**Event Format**:

```
event: file_updated
data: {"doc_id": "document-1", "hash": "abc123..."}

event: sync_completed
data: {"uploaded": 5, "downloaded": 3}
```

### Test Echo

```http
POST /api/v1/sse/test/echo
Content-Type: application/json

{
  "message": "test"
}
```

**Description**: Send test event to all connected SSE clients.

## Users API

Base path: `/api/v1/users`

### List Users

```http
GET /api/v1/users
```

**Authorization**: Requires `admin` role

**Response**: `200 OK`

```json
[
  {
    "username": "user1",
    "fullname": "User One",
    "email": "user1@example.com",
    "roles": ["user", "annotator"],
    "groups": ["editors"]
  }
]
```

### Get User

```http
GET /api/v1/users/{username}
```

**Authorization**: Requires `admin` role or own user

**Response**: `200 OK`

### Create User

```http
POST /api/v1/users
Content-Type: application/json

{
  "username": "newuser",
  "fullname": "New User",
  "email": "newuser@example.com",
  "passwd_hash": "sha256_hash",
  "roles": ["user"],
  "groups": ["readers"]
}
```

**Authorization**: Requires `admin` role

**Response**: `201 Created`

### Update User

```http
PUT /api/v1/users/{username}
Content-Type: application/json

{
  "fullname": "Updated Name",
  "roles": ["user", "annotator"]
}
```

**Authorization**: Requires `admin` role

**Response**: `200 OK`

### Delete User

```http
DELETE /api/v1/users/{username}
```

**Authorization**: Requires `admin` role

**Response**: `204 No Content`

## Groups API

Base path: `/api/v1/groups`

### List Groups

```http
GET /api/v1/groups
```

**Authorization**: Requires `admin` role

**Response**: `200 OK`

```json
[
  {
    "id": "editors",
    "name": "Editors Group",
    "description": "Manuscript editors",
    "collections": ["manuscripts", "letters"]
  }
]
```

### Get Group

```http
GET /api/v1/groups/{group_id}
```

### Create Group

```http
POST /api/v1/groups
Content-Type: application/json

{
  "id": "new-group",
  "name": "New Group",
  "description": "Description",
  "collections": ["manuscripts"]
}
```

### Update Group

```http
PUT /api/v1/groups/{group_id}
```

### Delete Group

```http
DELETE /api/v1/groups/{group_id}
```

## Roles API

Base path: `/api/v1/roles`

Similar CRUD operations as Groups API.

## Related Documentation

- [Architecture Overview](architecture.md) - Complete system architecture
- [Database](database.md) - Database schema and file metadata
- [Access Control](access-control.md) - RBAC and permissions
- [Collections](collections.md) - Collection management
- [Testing](testing.md) - API testing guide
