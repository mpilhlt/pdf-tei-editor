# API Client Usage Guide

## Overview

The FastAPI backend provides an automatically-generated, type-safe JavaScript client for all API endpoints. The client is generated from the OpenAPI schema and provides complete JSDoc type annotations for IDE support.

**Client File**: [fastapi_app/api-client-v1.js](../../fastapi_app/api-client-v1.js)
**Generator**: [bin/generate-api-client.js](../../bin/generate-api-client.js)

## Quick Start

### Using the Generated Client

The client is already integrated into the frontend via [app/src/plugins/client.js](../../app/src/plugins/client.js):

```javascript
import { ApiClientV1 } from '../../fastapi_app/api-client-v1.js';

// The client receives the callApi function for transport
const apiClient = new ApiClientV1(callApi);

// Use typed methods
const files = await apiClient.filesList({ collection: 'corpus1' });
const status = await apiClient.authStatus();
```

### Regenerating the Client

The client regenerates automatically, but you can trigger it manually:

```bash
# Regenerate client from current OpenAPI schema
npm run generate-client

# Check if client is outdated (exits with code 1 if stale)
npm run generate-client:check
```

**When client regenerates automatically:**
- Before production build (`npm run build` → `prebuild` hook)
- When committing router changes (pre-commit hook checks freshness)

## Architecture

### Dependency Injection Pattern

The generated client is **framework-agnostic** and uses dependency injection:

```javascript
export class ApiClientV1 {
  constructor(callApiFn) {
    this.callApi = callApiFn;  // Injected transport function
  }

  async authLogin(requestBody) {
    return this.callApi('/api/v1/auth/login', 'POST', requestBody);
  }
}
```

**Why this pattern?**
- Client doesn't depend on fetch, session management, error handling
- Transport function (`callApi`) handles retries, authentication, errors
- Easy to mock for testing (inject fake transport)
- Client focuses purely on API method signatures

### Type Safety

Every method includes complete JSDoc type definitions:

```javascript
/**
 * List all files with optional collection filter
 * @param {Object} [params]
 * @param {string} [params.collection] - Filter by collection name
 * @returns {Promise<FileMetadata[]>}
 */
async filesList(params) {
  return this.callApi('/api/v1/files', 'GET', params);
}
```

IDEs provide autocomplete, parameter hints, and type checking based on these annotations.

## Generated Methods (31 total)

### Authentication (3 methods)

```javascript
// Login with username and password hash
await apiClient.authLogin({
  username: 'user',
  passwd_hash: 'sha256hash'
});
// Returns: { session_id: string, message: string }

// Logout and end session
await apiClient.authLogout();
// Returns: { message: string }

// Check current authentication status
await apiClient.authStatus();
// Returns: { authenticated: boolean, username?: string }
```

### Configuration (7 methods)

```javascript
// Get all configuration key-value pairs
await apiClient.configList();
// Returns: { [key: string]: string }

// Get specific config value
await apiClient.configGet({ key: 'some_key' });
// Returns: { key: string, value: string }

// Set config value
await apiClient.configSet({ key: 'some_key', value: 'some_value' });
// Returns: { message: string }

// Delete config key
await apiClient.configDelete({ key: 'some_key' });
// Returns: { message: string }

// Get user instructions (array of strings)
await apiClient.configGetInstructions();
// Returns: { instructions: string[] }

// Save user instructions
await apiClient.configSaveInstructions({
  instructions: ['step 1', 'step 2']
});
// Returns: { message: string }

// Get application state
await apiClient.configGetState();
// Returns: { [key: string]: any }
```

### Files (13 methods)

```javascript
// List all files, optionally filtered by collection
await apiClient.filesList({ collection: 'corpus1' });
// Returns: FileMetadata[]

// Get specific file by document_id
await apiClient.filesGet({ document_id: 'abc123' });
// Returns: FileMetadata

// Save TEI XML content
await apiClient.filesSave({
  document_id: 'doc123',
  content: '<TEI>...</TEI>',
  label: 'v2',
  variant: 'edited',
  version: 2
});
// Returns: { message: string, document_id: string, file_hash: string }

// Delete files by document IDs
await apiClient.filesDelete({
  document_ids: ['doc1', 'doc2']
});
// Returns: { message: string, deleted_count: number }

// Move files to different collection
await apiClient.filesMove({
  document_ids: ['doc1', 'doc2'],
  target_collection: 'archive'
});
// Returns: { message: string, moved_count: number }

// Copy files to different collection
await apiClient.filesCopy({
  document_ids: ['doc1', 'doc2'],
  target_collection: 'backup'
});
// Returns: { message: string, copied_count: number }

// Acquire edit lock on document
await apiClient.filesAcquireLock({ document_id: 'doc123' });
// Returns: { success: boolean, message?: string }

// Release edit lock
await apiClient.filesReleaseLock({ document_id: 'doc123' });
// Returns: { success: boolean }

// Check lock status
await apiClient.filesCheckLock({ document_id: 'doc123' });
// Returns: { locked: boolean, locked_by?: string, locked_at?: string }

// Get all currently locked files
await apiClient.filesGetLocks();
// Returns: { document_id: string, locked_by: string }[]

// Send heartbeat to keep lock alive
await apiClient.filesHeartbeat({ document_id: 'doc123' });
// Returns: { success: boolean }
```

### Validation (2 methods)

```javascript
// Validate XML against schema (XSD or RelaxNG)
await apiClient.validationValidate({
  content: '<TEI>...</TEI>',
  schema_type: 'tei'  // or 'rng'
});
// Returns: { valid: boolean, errors?: ValidationError[] }

// Get CodeMirror autocomplete data for schema
await apiClient.validationAutocomplete({
  schema_type: 'tei'
});
// Returns: { elements: string[], attributes: { [elem: string]: string[] } }
```

### Extraction (2 methods)

```javascript
// Extract metadata from file using specific extractor
await apiClient.extractionExtract({
  file: base64EncodedFile,  // or file data
  extractor_id: 'grobid'
});
// Returns: { metadata: object, extractor_id: string }

// Get list of available extractors
await apiClient.extractionListExtractors();
// Returns: { id: string, name: string, description: string }[]
```

### Sync (4 methods)

```javascript
// Get sync configuration status
await apiClient.syncStatus();
// Returns: { enabled: boolean, remote_url?: string }

// Perform full document sync with remote
await apiClient.syncPerform({ force: false });
// Returns: SSE stream of sync progress

// Delete files from remote server
await apiClient.syncDeleteRemote({
  document_ids: ['doc1', 'doc2']
});
// Returns: { message: string, deleted_count: number }

// Update remote metadata without file content
await apiClient.syncMetadata({
  document_ids: ['doc1', 'doc2']
});
// Returns: { message: string, updated_count: number }
```

## Excluded Endpoints

The following endpoints are **not generated** and must be handled manually:

### File Uploads (3 endpoints)

Upload endpoints use `multipart/form-data` encoding with complex boundary handling:

```javascript
// Manual upload implementation in client.js
async function uploadFile(file, metadata) {
  const formData = new FormData();
  formData.append('file', file);
  Object.entries(metadata).forEach(([k, v]) =>
    formData.append(k, v)
  );

  // Use callApi directly with FormData
  return callApi('/api/v1/files/upload', 'POST', formData);
}
```

**Endpoints excluded:**
- `POST /api/v1/files/upload` - Upload new PDF
- `POST /api/v1/files/create-version` - Create TEI version from upload
- `POST /api/v1/files/upload-rng` - Upload RelaxNG schema

### Server-Sent Events (2 endpoints)

SSE endpoints use `text/event-stream` responses that require EventSource:

```javascript
// Manual SSE implementation
function subscribeToSSE(clientId) {
  const url = `/api/v1/sse/subscribe?client_id=${clientId}`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // Handle SSE message
  };

  return eventSource;
}
```

**Endpoints excluded:**
- `GET /api/v1/sse/subscribe` - Subscribe to server-sent events
- `POST /api/v1/sse/test-message` - Send test SSE message

## Type Definitions

The generated client includes 28 TypeScript-style JSDoc type definitions. Here are key types:

### FileMetadata

```javascript
/**
 * @typedef {Object} FileMetadata
 * @property {string} document_id - Stable document identifier
 * @property {string} file_hash - Content hash
 * @property {string} file_type - 'pdf' | 'tei' | 'rng'
 * @property {number} file_size - Size in bytes
 * @property {string} created_at - ISO timestamp
 * @property {string} updated_at - ISO timestamp
 * @property {string[]} doc_collections - Collections containing document
 * @property {Object} doc_metadata - Document metadata (title, author, etc.)
 * @property {string} [label] - Optional version label
 * @property {string} [variant] - Variant identifier (TEI only)
 * @property {number} [version] - Version number
 * @property {boolean} [is_gold_standard] - Gold standard flag
 * @property {Object} [file_metadata] - Extraction metadata
 */
```

### ValidationError

```javascript
/**
 * @typedef {Object} ValidationError
 * @property {string} message - Error description
 * @property {number} [line] - Line number
 * @property {number} [column] - Column number
 * @property {string} [type] - Error type (error, warning)
 */
```

See [fastapi_app/api-client-v1.js](../../fastapi_app/api-client-v1.js) for all type definitions.

## Customization & Extension

### Adding New Endpoints

When you add new FastAPI endpoints:

1. **Define router endpoint** in `fastapi_app/routers/*.py`
2. **Add Pydantic models** for request/response validation
3. **Regenerate client**: `npm run generate-client`
4. **Add shim in client.js** if needed for backward compatibility

The generator automatically:
- Creates typed method from OpenAPI operation
- Generates JSDoc annotations from Pydantic schemas
- Handles path parameters, query params, request bodies
- Skips upload/SSE endpoints

### Modifying Generator Behavior

Edit [bin/generate-api-client.js](../../bin/generate-api-client.js) to customize:

**Skip additional endpoints:**
```javascript
// Skip specific endpoint patterns
if (path.includes('/admin/')) {
  continue;  // Don't generate admin methods
}
```

**Change method naming:**
```javascript
// Customize method name generation
const methodName = operationId
  .replace(/^api_v1_/, '')  // Remove prefix
  .replace(/_/g, '');        // camelCase conversion
```

**Modify type annotations:**
```javascript
// Customize JSDoc type generation
const jsDocType = schemaToJSDoc(schema, {
  preferInterfaces: true,
  includeDescriptions: true
});
```

### Testing Generated Client

Create unit tests that mock the `callApi` function:

```javascript
import { ApiClientV1 } from './fastapi_app/api-client-v1.js';
import { test } from 'node:test';
import assert from 'node:assert';

test('auth login calls correct endpoint', async () => {
  const mockCallApi = async (endpoint, method, body) => {
    assert.strictEqual(endpoint, '/api/v1/auth/login');
    assert.strictEqual(method, 'POST');
    assert.deepStrictEqual(body, {
      username: 'test',
      passwd_hash: 'hash'
    });
    return { session_id: 'abc', message: 'ok' };
  };

  const client = new ApiClientV1(mockCallApi);
  const result = await client.authLogin({
    username: 'test',
    passwd_hash: 'hash'
  });

  assert.strictEqual(result.session_id, 'abc');
});
```

## Build Integration

### Automatic Regeneration

The client regenerates automatically in these scenarios:

**1. Production builds** (`npm run build`)
```json
{
  "scripts": {
    "prebuild": "npm run generate-client"
  }
}
```

**2. Pre-commit hook** (when router files change)
```bash
# .husky/pre-commit
if git diff --cached --name-only | grep -q "fastapi_app/routers/"; then
  npm run generate-client:check || exit 1
fi
```

### Manual Regeneration

```bash
# Regenerate from current OpenAPI schema
npm run generate-client

# Check if outdated (useful in CI)
npm run generate-client:check
# Exits with code 1 if client is stale
```

### Schema Source

The generator fetches the OpenAPI schema from:
```
http://localhost:8000/openapi.json
```

**Requirements:**
- FastAPI dev server must be running
- Server must be accessible on port 8000
- Schema must be valid JSON

## Common Patterns

### Error Handling

The `callApi` function handles errors, not the generated client:

```javascript
try {
  await apiClient.filesSave({ ... });
} catch (error) {
  // callApi throws on HTTP errors, network failures
  if (error.status === 401) {
    // Handle authentication error
  }
}
```

### Query Parameters (GET requests)

GET requests with body parameters are converted to query strings:

```javascript
// This call:
await apiClient.filesList({ collection: 'corpus1' });

// Becomes:
// GET /api/v1/files?collection=corpus1
```

The `callApi` function handles this conversion automatically.

### Request Bodies (POST/PUT/PATCH)

Request bodies are sent as JSON:

```javascript
// This call:
await apiClient.filesSave({
  document_id: 'doc123',
  content: '<TEI>...</TEI>'
});

// Sends:
// POST /api/v1/files/save
// Content-Type: application/json
// Body: {"document_id":"doc123","content":"<TEI>...</TEI>"}
```

## Troubleshooting

### Client Generation Fails

**Problem**: `npm run generate-client` fails with fetch error

**Solutions:**
1. Ensure FastAPI server is running: `npm run dev:fastapi`
2. Check server logs: `log/fastapi-server.log`
3. Verify OpenAPI endpoint: `curl http://localhost:8000/openapi.json`

### Type Errors in IDE

**Problem**: IDE shows type errors for client methods

**Solutions:**
1. Ensure client is up-to-date: `npm run generate-client:check`
2. Regenerate if outdated: `npm run generate-client`
3. Restart IDE/TypeScript server to pick up new types

### Pre-commit Hook Blocks Commit

**Problem**: Git commit blocked with "Client is outdated"

**Solutions:**
1. Regenerate client: `npm run generate-client`
2. Stage updated client: `git add fastapi_app/api-client-v1.js`
3. Retry commit

### Method Not Generated

**Problem**: Expected method missing from generated client

**Possible causes:**
1. Endpoint uses `multipart/form-data` → Upload endpoints excluded
2. Endpoint uses `text/event-stream` → SSE endpoints excluded
3. Endpoint not exposed in OpenAPI schema → Check FastAPI router
4. Operation ID collision → Check for duplicate `operation_id` values

## Best Practices

### DO ✅

- **Regenerate after router changes**: Always run `npm run generate-client` after adding/modifying endpoints
- **Use typed parameters**: Let IDE autocomplete guide you with type hints
- **Commit generated client**: Check in `api-client-v1.js` with router changes
- **Handle errors at transport layer**: Let `callApi` manage retries, sessions, errors
- **Add JSDoc to shims**: Include type annotations in client.js wrapper functions

### DON'T ❌

- **Don't modify generated client**: Changes will be overwritten on next generation
- **Don't bypass the client**: Use generated methods instead of raw `callApi` calls
- **Don't generate for uploads/SSE**: Keep manual implementations for complex endpoints
- **Don't skip pre-commit checks**: Client freshness is critical for type safety

## Migration from Legacy API

If migrating from Flask API calls:

**Before (direct callApi):**
```javascript
async function getFiles() {
  return callApi('/files', 'GET');
}
```

**After (generated client):**
```javascript
import { apiClient } from './client.js';

async function getFiles() {
  return apiClient.filesList();
}
```

**Benefits:**
- Type safety with JSDoc
- Automatic parameter validation
- IDE autocomplete
- Self-documenting API

## References

- [Phase 7 Completion Report](phase-7-completion.md) - Migration summary
- [FastAPI OpenAPI Docs](https://fastapi.tiangolo.com/tutorial/metadata/) - Schema customization
- [JSDoc Type Annotations](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html) - Type syntax reference
- [Generator Implementation](../../bin/generate-api-client.js) - Source code

---

**Last Updated**: 2025-10-16
**Client Version**: v1
**Generated Methods**: 31
**Type Definitions**: 28
