# Phase 7: Client Generation and Frontend Integration

**Status**: ⬜ Not started
**Dependencies**: Phase 6 complete
**Estimated Effort**: 1-2 days

## Overview

Generate complete API client from OpenAPI schema and replace Flask API calls with generated v1 client shims.

## Design Principles

### Dependency Injection Architecture

Generated client receives `callApi` function that handles transport, session, errors, retries:

```javascript
export class ApiClientV1 {
  constructor(callApiFn) {
    this.callApi = callApiFn;
  }

  async authLogin(requestBody) {
    return this.callApi('/auth/login', 'POST', requestBody);
  }
}
```

The client is **framework-agnostic** - only maps endpoints to typed methods.

### Out of Scope

**File uploads**: Stay in plugin, use raw `callApi` with FormData. Upload endpoints have complex multipart handling not suitable for generation.

**SSE**: Use EventSource directly, bypass client entirely.

### Current State

**Generator** ([bin/generate-api-client.js](bin/generate-api-client.js)):
- ✅ Fetches OpenAPI schema, generates JSDoc types
- ✅ Processes `/api/v1/*` endpoints only
- ⚠️ Only has Phase 3 endpoints (9 methods)

**Frontend** ([app/src/plugins/client.js](app/src/plugins/client.js)):
- ✅ `callApi()` with session, errors, retries
- ✅ ~30 legacy API methods
- ⚠️ Calls Flask API, needs migration

**Routers**: 14 total (auth, config, files×9, validation, extraction, sync, SSE) = ~35-40 non-upload endpoints

## Tasks

### 1. Enhance Generator (1 hour)

**Update [bin/generate-api-client.js](bin/generate-api-client.js)**:

```javascript
// Skip file upload endpoints (multipart/form-data)
if (requestBodyContent['multipart/form-data']) {
  continue; // Don't generate - handle manually in plugin
}

// Skip SSE endpoints (text/event-stream)
if (operation.responses?.['200']?.content?.['text/event-stream']) {
  continue; // Don't generate - use EventSource directly
}

// Improve method naming consistency
// /api/v1/files/{document_id} GET -> filesGet
// /api/v1/files/{document_id} DELETE -> filesDelete
// /api/v1/files/save POST -> filesSave
```

**Regenerate client**:
```bash
npm run generate-client
# Expect ~800-1200 lines, ~35-40 methods (excluding uploads/SSE)
```

**Success criteria**:
- ✅ ~35-40 endpoints generated (no upload/SSE)
- ✅ All JSDoc types present
- ✅ No syntax errors

---

### 2. Build Integration (1 hour)

**Add to [package.json](package.json)**:
```json
{
  "scripts": {
    "prebuild": "npm run generate-client",
    "pretest:e2e": "npm run generate-client:check"
  }
}
```

**Create `bin/check-client-outdated.js`**:
```javascript
// Compare mtime of api-client-v1.js vs fastapi_app/routers/*.py
// Exit 1 if client is outdated
```

**Add to `.husky/pre-commit`**:
```bash
if git diff --cached --name-only | grep -q "fastapi_app/routers/"; then
  npm run generate-client:check || exit 1
fi
```

**Success criteria**:
- ✅ Client auto-regenerates on build
- ✅ Pre-commit hook detects stale client
- ✅ Generation completes in <10 seconds

---

### 3. Frontend Migration (4 hours)

**Strategy**: Replace all exported API functions in [app/src/plugins/client.js](app/src/plugins/client.js) with simple shims to generated client.

**Update [app/src/plugins/client.js](app/src/plugins/client.js)**:

```javascript
import { ApiClientV1 } from '../../fastapi_app/api-client-v1.js';

// Create singleton client instance
const apiClient = new ApiClientV1(callApi);

// Auth (3 methods)
async function login(username, passwdHash) {
  return apiClient.authLogin({ username, passwd_hash: passwdHash });
}

async function logout() {
  return apiClient.authLogout();
}

async function status() {
  return apiClient.authStatus();
}

// Config (5 methods)
async function getConfigData() {
  return apiClient.configList();
}

async function setConfigValue(key, value) {
  return apiClient.configSet({ key, value });
}

async function loadInstructions() {
  return apiClient.configGetInstructions();
}

async function saveInstructions(instructions) {
  return apiClient.configSaveInstructions({ instructions });
}

async function state() {
  return apiClient.configGetState();
}

// Files (~10 methods excluding uploads)
async function getFileList() {
  return apiClient.filesList();
}

async function saveXml(documentId, content, metadata) {
  return apiClient.filesSave({ document_id: documentId, content, ...metadata });
}

async function deleteFiles(documentIds) {
  return apiClient.filesDelete({ document_ids: documentIds });
}

async function moveFiles(documentIds, collection) {
  return apiClient.filesMove({ document_ids: documentIds, collection });
}

// Validation (2 methods)
async function validateXml(content, schemaType) {
  return apiClient.validationValidate({ content, schema_type: schemaType });
}

async function getAutocompleteData(schemaType) {
  return apiClient.validationAutocomplete({ schema_type: schemaType });
}

// Extraction (2 methods)
async function extract(file, extractorId) {
  return apiClient.extractionExtract({ file, extractor_id: extractorId });
}

async function getExtractorList() {
  return apiClient.extractionListExtractors();
}

// Sync (1 method)
async function syncFiles(force = false) {
  return apiClient.syncPerform({ force });
}

// Locks (5 methods)
async function acquireLock(documentId) {
  return apiClient.filesAcquireLock({ document_id: documentId });
}

async function releaseLock(documentId) {
  return apiClient.filesReleaseLock({ document_id: documentId });
}

async function checkLock(documentId) {
  return apiClient.filesCheckLock({ document_id: documentId });
}

async function getAllLockedFileIds() {
  return apiClient.filesGetLocks();
}

async function sendHeartbeat(documentId) {
  return apiClient.filesHeartbeat({ document_id: documentId });
}

// File uploads - keep existing implementation (FormData handling)
async function uploadFile(file, metadata) {
  const formData = new FormData();
  formData.append('file', file);
  Object.entries(metadata).forEach(([k, v]) => formData.append(k, v));

  // Direct callApi with FormData - no client wrapper
  return callApi('/files/upload', 'POST', formData);
}

async function createVersionFromUpload(file, metadata) {
  // Similar FormData handling
  return callApi('/files/create-version', 'POST', formData);
}

// SSE - keep existing implementation (EventSource)
function subscribeToSSE(clientId) {
  const url = `/api/v1/sse/subscribe?client_id=${clientId}`;
  return new EventSource(url);
}
```

**Update `callApi` to handle FormData**:
```javascript
async function callApi(endpoint, method = 'GET', body = null, retryAttempts = 3) {
  const url = `${api_base_url}${endpoint}`;
  const options = {
    method,
    headers: {
      'X-Session-ID': sessionId || '',
    }
  };

  // Handle FormData (file uploads) - don't stringify
  if (body instanceof FormData) {
    options.body = body;
    // Don't set Content-Type, browser sets with boundary
  } else if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  // ... rest of implementation
}
```

**Success criteria**:
- ✅ ~25 exported API methods replaced with shims
- ✅ ~3 upload methods keep existing FormData implementation
- ✅ ~1 SSE method keeps EventSource implementation
- ✅ No direct Flask API calls remain
- ✅ Frontend works with FastAPI backend

---

### 4. Testing (2 hours)

**Unit tests** (`tests/js/api-client-v1.test.js`):
```javascript
test('ApiClientV1 constructor accepts callApi', () => {
  const client = new ApiClientV1(() => {});
  assert.ok(client);
});

test('authLogin calls callApi correctly', async () => {
  let captured;
  const mockCallApi = async (...args) => { captured = args; return {}; };
  const client = new ApiClientV1(mockCallApi);

  await client.authLogin({ username: 'admin', passwd_hash: 'hash' });

  assert.deepStrictEqual(captured, ['/auth/login', 'POST', { username: 'admin', passwd_hash: 'hash' }]);
});

// Add 10-15 similar tests
```

**Integration tests**: Run existing E2E tests against FastAPI backend.

**Success criteria**:
- ✅ 15+ unit tests pass
- ✅ All E2E tests pass with FastAPI
- ✅ No functionality regressions

---

### 5. Documentation (1 hour)

**Create `fastapi_app/prompts/api-client-usage.md`**:
```markdown
# API Client V1 Usage

## Regenerating
\`\`\`bash
npm run generate-client
\`\`\`

## Architecture
- Generated from OpenAPI schema
- Uses dependency injection (receives callApi)
- callApi handles transport, auth, errors
- Client only maps endpoints to methods

## Excluded from Generation
- File uploads (multipart/form-data) - handled manually in plugin
- SSE (text/event-stream) - uses EventSource directly
```

**Update [fastapi_app/prompts/migration-plan.md](migration-plan.md)**:
- Mark Phase 7 as complete
- Update statistics

**Create completion report** (`fastapi_app/prompts/phase-7-completion.md`):
- List all generated methods (~35-40)
- List excluded methods (~4 upload/SSE)
- Document migration patterns
- Record test results

---

## Files

### Create
- `bin/check-client-outdated.js` - Client freshness checker
- `tests/js/api-client-v1.test.js` - Client unit tests
- `fastapi_app/prompts/api-client-usage.md` - Usage guide
- `fastapi_app/prompts/phase-7-completion.md` - Completion report

### Modify
- `bin/generate-api-client.js` - Skip upload/SSE endpoints
- `fastapi_app/api-client-v1.js` - Regenerate with all non-upload endpoints
- `app/src/plugins/client.js` - Replace API methods with shims, keep uploads/SSE
- `package.json` - Add build scripts
- `.husky/pre-commit` - Add client check
- `fastapi_app/prompts/migration-plan.md` - Update status

---

## Success Criteria

**Phase 7 Complete When:**

1. **Generation**
   - ✅ ~35-40 methods generated (excluding uploads/SSE)
   - ✅ All endpoints have JSDoc types
   - ✅ Upload/SSE endpoints skipped

2. **Build**
   - ✅ Auto-regenerates on build
   - ✅ Pre-commit hook works
   - ✅ <10 second generation

3. **Frontend**
   - ✅ ~25 API methods are shims to generated client
   - ✅ ~4 upload/SSE methods keep manual implementation
   - ✅ No Flask API calls remain

4. **Testing**
   - ✅ 15+ unit tests pass
   - ✅ E2E tests pass with FastAPI
   - ✅ No regressions

5. **Documentation**
   - ✅ Usage guide complete
   - ✅ Completion report written

---

## Timeline

- **Task 1**: Enhance generator - 1 hour
- **Task 2**: Build integration - 1 hour
- **Task 3**: Frontend migration - 4 hours
- **Task 4**: Testing - 2 hours
- **Task 5**: Documentation - 1 hour

**Total**: 9 hours (1 day)

---

## References

- [Generator](../../bin/generate-api-client.js) - Current implementation
- [Client Plugin](../../app/src/plugins/client.js) - Frontend API methods
- [Phase 3 Completion](phase-3-completion.md) - Initial client generation
- [Phase 6 Completion](phase-6-completion.md) - Latest endpoints (sync, SSE)
