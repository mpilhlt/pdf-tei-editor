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

Frontend module documentation is auto-generated from JSDoc comments using the `jsdoc` tool with the `better-docs` theme.

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

## 4. Auto-generated API Client

### Generation

The frontend API client is auto-generated from the FastAPI OpenAPI schema:

**Regenerate client:**

```bash
npm run generate-client
```

**Check if outdated:**

```bash
npm run generate-client:check
```

**Location:** `app/src/modules/api-client-v1.js` (DO NOT EDIT MANUALLY)

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

### Environment Variables for CLI Scripts

All CLI scripts and external tools that access the HTTP API should support these environment variables (from `.env` file):

```bash
# API credentials
API_USER=admin
API_PASSWORD=admin

# API base URL (default: http://localhost:8000)
API_BASE_URL=http://localhost:8000
```

**Example usage:**

```bash
# Create .env file with credentials
cat > .env << EOF
API_USER=admin
API_PASSWORD=admin
API_BASE_URL=http://localhost:8000
EOF

# Run CLI script (will read credentials from .env)
node bin/batch-extract.js /path/to/pdfs --collection my_collection --extractor mock-extractor

# Or override via CLI parameters
node bin/batch-extract.js /path/to/pdfs \
  --user admin \
  --password admin \
  --base-url http://localhost:8000 \
  --collection my_collection \
  --extractor mock-extractor
```

**CLI scripts should:**
- Accept optional `--env <path>` parameter (default: `./.env`)
- Support `--user`, `--password`, `--base-url` CLI parameters that override env vars
- Use SHA-256 password hashing for authentication (matching frontend)
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
2. Regenerate API client: `npm run generate-client`
3. Check client was updated correctly
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
