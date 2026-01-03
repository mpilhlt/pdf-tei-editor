# API Client Usage Guide

Guide for using the automatically-generated, type-safe FastAPI client.

For comprehensive API client documentation, see the full guide at [fastapi_app/prompts/api-client-usage.md](../../fastapi_app/prompts/api-client-usage.md).

## Overview

The FastAPI backend provides an automatically-generated JavaScript client with complete JSDoc type annotations for all API endpoints.

**Client File**: `app/src/modules/api-client-v1.js`
**Generator**: `bin/generate-api-client.js`

## Quick Start

```javascript
import { apiClient } from './client.js';

// Use typed methods
const files = await apiClient.filesList({ collection: 'corpus1' });
const status = await apiClient.authStatus();
```

## Regenerating the Client

```bash
# Regenerate client from current OpenAPI schema
npm run generate-client

# Check if client is outdated
npm run generate-client:check
```

**Automatic regeneration:**
- Before production build (`npm run build`)
- Pre-commit hook when router files change

## Architecture

### Dependency Injection Pattern

The generated client uses dependency injection for transport:

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

**Benefits:**
- Framework-agnostic (no fetch/axios dependency)
- Transport handles retries, authentication, errors
- Easy to mock for testing
- Client focuses on API method signatures

### Type Safety

Every method includes complete JSDoc annotations:

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

## Key Method Categories

### Authentication

```javascript
await apiClient.authLogin({ username: 'user', passwd_hash: 'hash' });
await apiClient.authLogout();
await apiClient.authStatus();
```

### Files

```javascript
// List and retrieve
await apiClient.filesList({ collection: 'corpus1' });
await apiClient.filesGet({ document_id: 'abc123' });

// Save TEI content
await apiClient.filesSave({
  document_id: 'doc123',
  content: '<TEI>...</TEI>',
  label: 'v2',
  variant: 'edited',
  version: 2
});

// File operations
await apiClient.filesDelete({ document_ids: ['doc1', 'doc2'] });
await apiClient.filesMove({ document_ids: ['doc1'], target_collection: 'archive' });
await apiClient.filesCopy({ document_ids: ['doc1'], target_collection: 'backup' });

// Lock management
await apiClient.filesAcquireLock({ document_id: 'doc123' });
await apiClient.filesReleaseLock({ document_id: 'doc123' });
await apiClient.filesCheckLock({ document_id: 'doc123' });
await apiClient.filesHeartbeat({ document_id: 'doc123' });
```

### Configuration

```javascript
await apiClient.configList();
await apiClient.configGet({ key: 'some_key' });
await apiClient.configSet({ key: 'some_key', value: 'value' });
await apiClient.configDelete({ key: 'some_key' });
```

### Validation

```javascript
await apiClient.validationValidate({
  content: '<TEI>...</TEI>',
  schema_type: 'tei'
});

await apiClient.validationAutocomplete({ schema_type: 'tei' });
```

## Excluded Endpoints (Manual Implementation Required)

### File Uploads

Upload endpoints use `multipart/form-data` and must be handled manually:

```javascript
async function uploadFile(file, metadata) {
  const formData = new FormData();
  formData.append('file', file);
  Object.entries(metadata).forEach(([k, v]) =>
    formData.append(k, v)
  );
  return callApi('/api/v1/files/upload', 'POST', formData);
}
```

**Excluded upload endpoints:**
- `POST /api/v1/files/upload`
- `POST /api/v1/files/create-version`
- `POST /api/v1/files/upload-rng`

### Server-Sent Events

SSE endpoints use `text/event-stream` and require EventSource:

```javascript
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

**Excluded SSE endpoints:**
- `GET /api/v1/sse/subscribe`
- `POST /api/v1/sse/test-message`

## Key Type Definitions

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

## Adding New Endpoints

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

## Common Patterns

### Error Handling

The `callApi` function handles errors:

```javascript
try {
  await apiClient.filesSave({ ... });
} catch (error) {
  if (error.status === 401) {
    // Handle authentication error
  }
}
```

### Query Parameters (GET requests)

GET requests with parameters become query strings:

```javascript
await apiClient.filesList({ collection: 'corpus1' });
// → GET /api/v1/files?collection=corpus1
```

### Request Bodies (POST/PUT/PATCH)

Request bodies are sent as JSON:

```javascript
await apiClient.filesSave({
  document_id: 'doc123',
  content: '<TEI>...</TEI>'
});
// → POST /api/v1/files/save
// → Content-Type: application/json
```

## Testing Generated Client

Mock the `callApi` function for tests:

```javascript
import { ApiClientV1 } from './app/src/modules/api-client-v1.js';
import { test } from 'node:test';
import assert from 'node:assert';

test('auth login calls correct endpoint', async () => {
  const mockCallApi = async (endpoint, method, body) => {
    assert.strictEqual(endpoint, '/api/v1/auth/login');
    assert.strictEqual(method, 'POST');
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

## Programmatic API Access (CLI Scripts)

### Environment Variables for HTTP API Access

When creating CLI scripts or external tools that access the HTTP API programmatically, support these standard environment variables:

```bash
# API credentials
API_USER=admin
API_PASSWORD=admin

# API base URL (default: http://localhost:8000)
API_BASE_URL=http://localhost:8000
```

**Standard pattern for CLI scripts:**

```javascript
import dotenv from 'dotenv';
import { createHash } from 'crypto';

// Load .env file
dotenv.config({ path: envPath });

// Get credentials from env or CLI args
const username = cliUser || process.env.API_USER;
const password = cliPassword || process.env.API_PASSWORD;
const baseUrl = cliBaseUrl || process.env.API_BASE_URL || 'http://localhost:8000';

// Hash password (SHA-256, matching frontend)
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

// Login and get session
const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username,
    passwd_hash: hashPassword(password)
  })
});
const { sessionId } = await response.json();

// Make authenticated requests with X-Session-ID header
await fetch(`${baseUrl}/api/v1/files/list`, {
  headers: { 'X-Session-ID': sessionId }
});
```

**CLI parameter conventions:**

- `--env <path>` - Path to .env file (default: `./.env`)
- `--user <username>` - Override API_USER from env
- `--password <password>` - Override API_PASSWORD from env
- `--base-url <url>` - Override API_BASE_URL from env

**Example implementations:**

- [bin/batch-extract.js](../../bin/batch-extract.js) - Batch PDF metadata extraction

## Best Practices

### DO ✅

- **Regenerate after router changes**: `npm run generate-client`
- **Use typed parameters**: Let IDE autocomplete guide you
- **Commit generated client**: Check in with router changes
- **Handle errors at transport layer**: Let `callApi` manage retries
- **Add JSDoc to shims**: Type annotations in wrapper functions
- **Support standard env vars in CLI scripts**: Use API_USER, API_PASSWORD, API_BASE_URL

### DON'T ❌

- **Don't modify generated client**: Changes will be overwritten
- **Don't bypass the client**: Use generated methods instead of raw `callApi`
- **Don't generate for uploads/SSE**: Keep manual implementations
- **Don't skip pre-commit checks**: Client freshness is critical

## Troubleshooting

### Client Generation Fails

1. Ensure FastAPI server is running: `npm run start:dev`
2. Verify OpenAPI endpoint: `curl http://localhost:8000/openapi.json`

### Type Errors in IDE

1. Ensure client is up-to-date: `npm run generate-client:check`
2. Regenerate if outdated: `npm run generate-client`
3. Restart IDE/TypeScript server

### Pre-commit Hook Blocks Commit

1. Regenerate client: `npm run generate-client`
2. Stage updated client: `git add app/src/modules/api-client-v1.js`
3. Retry commit
