# API Documentation Reference

This document provides an overview of all available API documentation.

## Documentation Types

The project maintains multiple types of API documentation:

1. **FastAPI REST Endpoints** - HTTP API for client-server communication
2. **Frontend JavaScript Modules** - Client-side application code
3. **Backend Python Modules** - Server-side business logic and utilities
4. **Auto-generated OpenAPI Client** - Type-safe JavaScript client for REST endpoints

## 1. FastAPI REST API

### Live Documentation

When the development server is running, interactive API documentation is available at:

- **Swagger UI**: [http://localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc**: [http://localhost:8000/redoc](http://localhost:8000/redoc)

These provide:

- Interactive endpoint testing
- Request/response schemas
- Authentication requirements
- Parameter validation rules

### OpenAPI Schema

The complete OpenAPI 3.0 schema is available at:

- **JSON**: [http://localhost:8000/openapi.json](http://localhost:8000/openapi.json)

This schema is used to auto-generate the frontend API client.

### REST Endpoint Categories

**Authentication**

- `/api/v1/auth/login` - User login
- `/api/v1/auth/token-login` - Exchange a personal access token (`Authorization: Bearer pte_...`) for a session
- `/api/v1/auth/tokens` - List, create (`POST`) and revoke (`DELETE /{token_id}`) personal access tokens; `/eligible-users` lists the users the caller may create tokens for
- `/api/v1/auth/logout` - User logout
- `/api/v1/auth/session` - Session validation

**Collections**

- `/api/v1/collections` - List, create, update, delete collections
- `/api/v1/collections/{id}` - Get, update, delete specific collection

**Files**

- `/api/v1/files/list` - List accessible files
- `/api/v1/files/{doc_id}` - Serve file content (PDF/XML)
- `/api/v1/files/save` - Save TEI XML content
- `/api/v1/files/upload` - Upload new PDF
- `/api/v1/files/copy` - Copy files between collections
- `/api/v1/files/move` - Move files between collections
- `/api/v1/files/delete` - Soft-delete files

**File Locks**

- `/api/v1/files/locks` - Get current locks
- `/api/v1/files/check_lock` - Check lock status
- `/api/v1/files/acquire_lock` - Acquire editing lock
- `/api/v1/files/release_lock` - Release editing lock
- `/api/v1/files/heartbeat` - Extend lock expiration

**Extraction**

- `/api/v1/extraction/list` - List available extractors
- `/api/v1/extraction` - Extract TEI from PDF

**Validation**

- `/api/v1/validation` - Validate TEI XML
- `/api/v1/validation/autocomplete-data` - Get autocomplete suggestions

**Schema**

- `/api/v1/schema/{type}/{variant}` - Get XSD/RelaxNG schemas

**Sync**

- `/api/v1/sync/status` - Get WebDAV sync status
- `/api/v1/sync` - Trigger sync operation
- `/api/v1/sync/conflicts` - List sync conflicts
- `/api/v1/sync/resolve-conflict` - Resolve conflict

**SSE (Server-Sent Events)**

- `/api/v1/sse/subscribe` - Subscribe to real-time events
- `/api/v1/sse/test/echo` - Test event broadcast

**Users & RBAC**

- `/api/v1/users` - User management
- `/api/v1/groups` - Group management
- `/api/v1/roles` - Role management

## 2. Frontend JavaScript API

### Generated HTML Documentation

Frontend module documentation is auto-generated from JSDoc comments using the `jsdoc` tool with its default template.

**Generate frontend docs:**

```bash
npm run docs:frontend
```

**View frontend docs:**

```bash
npm run docs:serve
# Open http://localhost:8080/frontend
```

**Location:** `docs/api/frontend/` (git-ignored)

### Module Categories

**Plugin System**

- `plugin-base.js` - Base plugin class with lifecycle hooks
- `plugin-manager.js` - Plugin registration and lifecycle management
- `plugin-context.js` - Plugin API context for state/events

**State Management**

- `state-manager.js` - Application state with change detection
- `application.js` - Main application controller

**UI System**

- `ui-system.js` - UI element registration and navigation
- `panels/*.js` - Panel management

**RBAC**

- `rbac/entity-manager.js` - Role-based access control entities
- `acl-utils.js` - Access control utilities

**Editors**

- `xmleditor.js` - CodeMirror-based XML editor
- `navigatable-xmleditor.js` - XML editor with navigation
- `pdfviewer.js` - PDF.js viewer integration

**Utilities**

- `utils.js` - General utilities
- `sl-utils.js` - Shoelace component helpers
- `browser-utils.js` - Browser compatibility utilities

**API Client**

- `api-client-v1.js` - Auto-generated FastAPI client (DO NOT EDIT)

## 3. Backend Python API

### Generated HTML Documentation

Backend module documentation is auto-generated from Google-style docstrings using `pdoc`.

**Generate backend docs:**

```bash
npm run docs:backend
```

**View backend docs:**

```bash
npm run docs:serve
# Open http://localhost:8080/backend
```

**Location:** `docs/api/backend/` (git-ignored)

### Generated JSON Documentation

Machine-readable JSON documentation for AI code assistants.

**Generate backend JSON:**

```bash
npm run docs:backend:json
```

**Location:** `docs/api/backend-api.json` (git-ignored, ~980KB)

**Usage:** This JSON file contains complete class/function signatures with type annotations and docstrings. Use it to verify API existence and signatures before writing code that calls backend methods.

### Module Categories

**Core Libraries (`fastapi_app/lib/`)**

- `access_control.py` - Document permission checking
- `auth.py` - User authentication
- `database.py` - SQLite database operations
- `file_repository.py` - File metadata CRUD
- `file_storage.py` - Physical file storage
- `locking.py` - File editing locks
- `sessions.py` - Session management
- `tei_utils.py` - TEI XML processing utilities
- `user_utils.py` - User/group/collection utilities
- `xml_utils.py` - XML validation and processing
- `migrations/` - Database migration infrastructure

**Plugin System (`fastapi_app/plugins/`)**

- `edit_history/` - Edit history tracking
- `iaa_analyzer/` - Inter-annotator agreement analysis
- `sample_analyzer/` - Sample data analysis
- `annotation_versions_analyzer/` - Version comparison

**API Routes (`fastapi_app/routers/`)**

- `auth.py` - Authentication endpoints
- `collections.py` - Collection management
- `files_*.py` - File operations (list, serve, save, upload, locks)
- `extraction.py` - TEI extraction
- `validation.py` - XML validation
- `sync.py` - WebDAV sync
- `sse.py` - Server-sent events
- `users.py`, `groups.py`, `roles.py` - RBAC management

## 4. Hand-maintained API Client

### Maintenance

The frontend API client mirrors the FastAPI routes by hand; see [docs/code-assistant/api-client.md](../code-assistant/api-client.md) for the maintenance workflow.

**Location:** `app/src/modules/api-client-v1.js` — update the matching method here in the same change whenever you add, remove, or change a route in `fastapi_app/routers/*.py`.

### Usage

```javascript
import { ApiClientV1 } from './modules/api-client-v1.js';

const client = new ApiClientV1({ baseUrl: '/api/v1', sessionId });

// Type-safe method calls
const files = await client.files.list({ collection: 'manuscripts' });
const content = await client.files.serve({ doc_id: 'doc-123', type: 'xml' });
await client.files.save({ doc_id: 'doc-123', content: '<TEI>...</TEI>' });
```

All methods are strongly typed based on the OpenAPI schema.

## Documentation Commands

### Generate All Documentation

```bash
npm run docs:generate
```

Generates:

- Frontend HTML docs
- Backend HTML docs
- Backend JSON docs

### Generate Specific Documentation

```bash
npm run docs:frontend        # Frontend HTML only
npm run docs:backend         # Backend HTML only
npm run docs:backend:json    # Backend JSON only
```

### Serve Documentation Locally

```bash
npm run docs:serve
```

Starts HTTP server at [http://localhost:8080](http://localhost:8080) serving:

- `frontend/` - Frontend module docs
- `backend/` - Backend module docs
- `backend-api.json` - Machine-readable backend API

### Clean Generated Documentation

```bash
npm run docs:clean
```

Removes all generated documentation files.

## Programmatic API Access

Scripts and other programs call the same HTTP API as the web interface. They authenticate with a [personal access token](../user-manual/access-tokens.md) (`pte_...`), which they exchange for a session at `POST /api/v1/auth/token-login` (sending the token as `Authorization: Bearer <token>`), and then send the session ID in the `X-Session-ID` header of every request. The REST endpoints are listed in the Swagger UI at `/docs` of a running instance (see [FastAPI REST API](#1-fastapi-rest-api)).

### Calling the API with an access token

The examples below read the token from the `API_TOKEN` environment variable, list the collections the token's user can access and end the session. Run them with `API_TOKEN=pte_... API_BASE_URL=https://pdf-tei-editor.example.org` set.

**Node.js** (18 or later, no dependencies; save as `list-collections.mjs` and run `node list-collections.mjs`):

```javascript
const baseUrl = process.env.API_BASE_URL || 'http://localhost:8000';
const token = process.env.API_TOKEN;

// Exchange the token for a session
const login = await fetch(`${baseUrl}/api/v1/auth/token-login`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
if (!login.ok) {
  throw new Error(`Login failed: ${login.status} ${await login.text()}`);
}
const { username, sessionId } = await login.json();
const headers = { 'X-Session-ID': sessionId };

try {
  // Call any endpoint with the session ID
  const response = await fetch(`${baseUrl}/api/v1/collections`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  }
  const collections = await response.json();
  console.log(`Collections of ${username}:`, collections.map(c => c.id).join(', '));
} finally {
  // End the session
  await fetch(`${baseUrl}/api/v1/auth/logout`, { method: 'POST', headers });
}
```

**Python** (3.9 or later, with [requests](https://pypi.org/project/requests/); run `python list_collections.py`):

```python
import os

import requests

base_url = os.environ.get("API_BASE_URL", "http://localhost:8000")
token = os.environ["API_TOKEN"]

with requests.Session() as http:
    # Exchange the token for a session
    login = http.post(f"{base_url}/api/v1/auth/token-login", headers={"Authorization": f"Bearer {token}"})
    login.raise_for_status()
    user = login.json()
    http.headers["X-Session-ID"] = user["sessionId"]

    try:
        # Call any endpoint with the session ID
        response = http.get(f"{base_url}/api/v1/collections")
        response.raise_for_status()
        print(f"Collections of {user['username']}:", ", ".join(c["id"] for c in response.json()))
    finally:
        # End the session
        http.post(f"{base_url}/api/v1/auth/logout")
```

A session created from a token ends when the token is revoked or expires, or after the usual inactivity timeout, so long-running scripts should log in again on a `401` response.

### Environment Variables for CLI Scripts

All CLI scripts and external tools that access the HTTP API should support these environment variables (from `.env` file):

```bash
# API credentials: a personal access token (preferred) ...
API_TOKEN=pte_...
# ... or username and password (used if API_TOKEN is not set)
API_USER=admin
API_PASSWORD=admin

# API base URL (default: http://localhost:8000)
API_BASE_URL=http://localhost:8000
```

**Example usage:**

```bash
# Create .env file with a personal access token (see docs/user-manual/access-tokens.md)
cat > .env << EOF
API_TOKEN=pte_...
API_BASE_URL=http://localhost:8000
EOF

# Run CLI script (will read credentials from .env)
node bin/batch-extract.js /path/to/pdfs --collection my_collection --extractor mock-extractor

# Or override via CLI parameters (--user/--password work instead of --token)
node bin/batch-extract.js /path/to/pdfs \
  --token pte_... \
  --base-url http://localhost:8000 \
  --collection my_collection \
  --extractor mock-extractor
```

**CLI scripts should:**
- Accept optional `--env <path>` parameter (default: `./.env`)
- Support `--token`, `--user`, `--password`, `--base-url` CLI parameters that override env vars
- Log in with the shared helper in `bin/lib/api-auth.js`: a token at `/api/v1/auth/token-login`, otherwise the plain text password at `/api/v1/auth/login`
- Make authenticated requests with `X-Session-ID` header

**Example implementations:**
- [bin/batch-extract.js](bin/batch-extract.js) - Batch PDF metadata extraction

## Best Practices

### For Developers

**Before adding new code:**

1. Check generated documentation to verify APIs don't already exist
2. Use backend JSON (`docs/api/backend-api.json`) to verify method signatures
3. Consult frontend HTML docs to understand existing patterns
4. Review FastAPI docs at `/docs` for endpoint requirements

**After adding new code:**

1. Add comprehensive JSDoc comments (frontend)
2. Add Google-style docstrings (backend)
3. Regenerate documentation: `npm run docs:generate`
4. Verify documentation renders correctly: `npm run docs:serve`

**When creating new endpoints:**

1. Add endpoint to appropriate router in `fastapi_app/routers/`
2. Add the matching method by hand to `app/src/modules/api-client-v1.js`
3. Check the method's JSDoc matches the route and Pydantic models
4. Update integration tests

### For AI Code Assistants

**Before suggesting new APIs:**

1. Read class definition or module exports
2. Check `docs/api/backend-api.json` for Python signatures
3. Check frontend HTML docs for JavaScript exports
4. Verify in FastAPI docs at `/docs`

**Never:**

- Assume a method exists without verification
- Use generic "object" types when specific types exist in docs
- Skip documentation generation after adding new code

## Related Documentation

- [Architecture Overview](architecture.md) - System design and components
- [Database Schema](database.md) - Database structure and migrations
- [Access Control](access-control.md) - RBAC and permissions
- [Plugin System](plugin-system.md) - Creating plugins
- [Testing Guide](testing.md) - API testing patterns
- [Contributing](contributing.md) - Development workflow
