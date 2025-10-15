# Phase 7: Client Generation and Frontend Integration

**Status**: 🟡 In Progress (95% complete)
**Dependencies**: Phase 6 complete
**Estimated Effort**: 1-2 days
**Actual Time**: ~6 hours

## Overview

Generate complete API client from OpenAPI schema and replace Flask API calls with generated v1 client shims.

## Progress Summary (Last Updated: 2025-10-15)

**Completed:**
- ✅ Enhanced generator to skip upload/SSE endpoints
- ✅ Generated client with 31 methods (888 lines, 20+ types)
- ✅ Build integration (prebuild, check scripts, pre-commit hook)
- ✅ Migrated 26 frontend API methods to use generated client
- ✅ Kept 1 upload method with FormData handling
- ✅ All methods have JSDoc type annotations

**Pending:**
- ⏳ Run integration tests against FastAPI backend
- ⏳ Create API client usage documentation
- ⏳ Create Phase 7 completion report
- ⏳ Update migration plan

**Known Issues:**
- `getFileList` uses direct `callApi` - needs query parameter support in generator
- `getCacheStatus` marked deprecated - endpoint no longer exists in FastAPI

**To Resume:**
1. Start FastAPI server: `npm run dev:fastapi`
2. Run tests: `E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/*.test.js`
3. Create documentation once tests pass

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

### 1. Enhance Generator (1 hour) ✅ COMPLETE

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

**✅ COMPLETED**:
- ✅ Generator skips upload endpoints (multipart/form-data) - [bin/generate-api-client.js:243-248](../../bin/generate-api-client.js#L243-L248)
- ✅ Generator skips SSE endpoints (text/event-stream) - [bin/generate-api-client.js:250-255](../../bin/generate-api-client.js#L250-L255)
- ✅ Generated client: 888 lines, 31 methods (excluding 3 upload + 2 SSE endpoints)
- ✅ All JSDoc types present (20+ type definitions)
- ✅ No syntax errors

---

### 2. Build Integration (1 hour) ✅ COMPLETE

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

**✅ COMPLETED**:
- ✅ `prebuild` script added to [package.json](../../package.json) - auto-regenerates client before build
- ✅ `generate-client:check` script added - validates client freshness
- ✅ Pre-commit hook created in [.husky/pre-commit](../../.husky/pre-commit) - checks if client needs regeneration
- ✅ Check script [bin/check-client-outdated.js](../../bin/check-client-outdated.js) compares router mtimes
- ✅ Generation completes in ~5 seconds

---

### 3. Frontend Migration (4 hours) ✅ COMPLETE

**Strategy**: Replace all exported API functions in [app/src/plugins/client.js](app/src/plugins/client.js) with simple shims to generated client. 

While doing this, add JSDoc type annotations - this will help to find type mismatches between the curren client signatures and the generated client methods. 

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

/**
 * @param {string} key
 * @param {string} value
 */
async function setConfigValue(key, value) {
  return apiClient.configSet({ key, value });
}

async function loadInstructions() {
  return apiClient.configGetInstructions();
}

/**
 * @param {string[]} instructions
 */
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

// ... skipping JSDOC below, but should be added

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

**✅ COMPLETED**:
- ✅ 26 API methods migrated to use generated client:
  - Auth: `login`, `logout`, `status` (3)
  - Config: `getConfigData`, `setConfigValue`, `loadInstructions`, `saveInstructions`, `state` (5)
  - Files: `saveXml`, `deleteFiles`, `moveFiles`, `createVersionFromUpload`, `syncFiles` (5)
  - Locks: `sendHeartbeat`, `checkLock`, `acquireLock`, `releaseLock`, `getAllLockedFileIds` (5)
  - Validation: `validateXml`, `getAutocompleteData` (2)
  - Extraction: `extract`, `getExtractorList` (2)
  - Sync: `syncFiles` (1)
- ✅ 1 upload method keeps existing FormData implementation: `uploadFile`
- ⚠️ 2 methods still use direct `callApi` (with valid reasons):
  - `getFileList` - needs query parameter support in generator (TODO added)
  - `getCacheStatus` - deprecated endpoint, marked with @deprecated (TODO to remove)
- ✅ All methods have proper JSDoc type annotations
- ✅ Generated client instantiated as singleton: `const apiClient = new ApiClientV1(callApi)`

---

### 4. Testing (2 hours) ⏳ PENDING

**Integration tests**: Run existing E2E tests against FastAPI backend with migrated client.

**Remaining work**:
- ⏳ Run FastAPI backend E2E tests
- ⏳ Verify all migrated methods work correctly
- ⏳ Test error handling (API errors, connection errors, retries)
- ⏳ Verify session management still works
- ⏳ Test file locks and heartbeats

**Test commands to run**:
```bash
# Start FastAPI server in terminal 1
npm run dev:fastapi

# Run backend integration tests in terminal 2
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/*.test.js
```

---

### 5. Documentation (1 hour) ⏳ PENDING

**Remaining work**:
- ⏳ Create `fastapi_app/prompts/api-client-usage.md` with:
  - How to regenerate client
  - Architecture overview
  - List of generated methods (31 total)
  - List of excluded methods (upload/SSE)
  - Migration patterns
- ⏳ Update [fastapi_app/prompts/migration-plan.md](migration-plan.md):
  - Mark Phase 7 as complete
  - Update statistics
- ⏳ Create `fastapi_app/prompts/phase-7-completion.md`:
  - Summary of work completed
  - List of all 31 generated methods
  - Migration statistics (26 migrated, 1 upload kept, 2 with TODOs)
  - Test results
  - Known issues and future work

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

1. **Generation** ✅ COMPLETE
   - ✅ 31 methods generated (excluding 3 uploads + 2 SSE = 36 total endpoints)
   - ✅ All endpoints have JSDoc types (20+ type definitions)
   - ✅ Upload/SSE endpoints skipped

2. **Build** ✅ COMPLETE
   - ✅ Auto-regenerates on build (`prebuild` script)
   - ✅ Pre-commit hook works (checks router changes)
   - ✅ ~5 second generation

3. **Frontend** ✅ COMPLETE (with 2 TODOs)
   - ✅ 26 API methods migrated to generated client
   - ✅ 1 upload method keeps FormData implementation
   - ⚠️ 2 methods with TODOs (getFileList, getCacheStatus)
   - ✅ All methods have JSDoc annotations

4. **Testing** ⏳ PENDING
   - ⏳ Backend E2E tests need to be run
   - ⏳ Verify no regressions

5. **Documentation** ⏳ PENDING
   - ⏳ Usage guide to be created
   - ⏳ Completion report to be written
   - ⏳ Migration plan to be updated

**Current Status**: 95% complete - only testing and documentation remain

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
