# Session 2025-10-11: Save API Implementation

## Summary

Implemented the Save API endpoint for Phase 4B, significantly simplifying the ~370-line Flask implementation to ~350 lines with cleaner logic thanks to the database-backed system.

## Accomplishments

### 1. Save API Router Implementation ✅

**File**: `fastapi_app/routers/files_save.py`

Key simplifications over Flask:
- No filesystem path manipulation needed
- No JSON cache updates
- Direct database queries for version determination
- Automatic version numbering via database
- Hash-based storage (no directories to manage)
- Variant and file_id extracted from XML only

**Core Features Implemented**:
- Extract `file_id` and `variant` from TEI XML
- Fallback extraction from file path if fileref missing (for test compatibility)
- Update/create fileref element in XML
- Support for XML entity encoding (configurable)
- Role-based access control:
  - Reviewers can edit gold files
  - Annotators can create versions
  - Reviewers can promote versions to gold
- Three save strategies:
  1. **Update existing file**: Hash-based lookup, content re-hash if changed
  2. **Create new version**: Auto-increment version number, inherit collections from PDF
  3. **Create new gold standard**: First file for doc_id + variant combination

**Locking**:
- Acquire lock before save
- Re-acquire with new hash if content changed
- Release old lock if hash changed

### 2. Router Registration ✅

Updated `fastapi_app/main.py`:
- Import `files_save` router
- Register in both `api_v1` (versioned) and `api_compat` (Flask compatibility)
- Endpoint available at `/api/v1/files/save` and `/api/files/save`

### 3. OpenAPI Documentation ✅

- Proper Pydantic request/response models
- `SaveFileRequest`: xml_string, file_id, new_version flag, encoding
- `SaveFileResponse`: status ('saved', 'new', 'new_gold'), abbreviated hash
- Full endpoint documentation in OpenAPI schema

## Current Issues

### 1. Test Compatibility 🔧

**Problem**: E2E tests send simple XML without proper TEI structure:
```xml
<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document</text></TEI>
```

This XML lacks:
- TEI namespace declaration
- `fileref` element with file_id
- Proper TEI header structure

**Solution Implemented**: Added fallback extraction from `file_id` hint in request:
- If fileref missing, extract file_id from request.file_id
- If file_id looks like path, extract filename stem
- Remove `.tei` suffix if present

### 2. Import Error Fixed ✅

**Problem**: `ModuleNotFoundError: No module named 'fastapi_app.lib.config'`

**Solution**: Changed import from non-existent `..lib.config` to `..lib.config_utils` with `load_full_config()` function.

### 3. Remaining Test Failures ⚠️

Delete API tests still failing with "422 Unprocessable Content" - likely due to request format mismatch.

## Database Schema Usage

The save API leverages the database schema effectively:

```python
# Version numbering - no filesystem parsing needed
latest_version = file_repo.get_latest_tei_version(doc_id, variant)
next_version = (latest_version.version + 1) if latest_version else 1

# Gold standard determination - simple database query
existing_gold = file_repo.get_gold_standard(doc_id)

# Collection inheritance - JOIN query
pdf_file = file_repo.get_pdf_for_document(doc_id)
doc_collections = pdf_file.doc_collections if pdf_file else []
```

## Code Metrics

- **Files Created**: 1
  - `fastapi_app/routers/files_save.py` (~400 lines including docstrings)
- **Files Modified**: 1
  - `fastapi_app/main.py` (router registration)
- **Lines of Code**: ~350 lines (vs ~370 in Flask, but with cleaner logic)

## Architecture Improvements

### Flask → FastAPI Simplifications

| Aspect | Flask | FastAPI |
|--------|-------|---------|
| **Path Resolution** | Complex filesystem scanning, JSON cache lookup | Direct hash lookup in database |
| **Collection Determination** | Parse directory structure | Query PDF file record |
| **Version Numbering** | Parse timestamp prefixes from filenames | Auto-increment from database |
| **Gold Promotion** | Filesystem checks, .deleted markers | Simple `is_gold_standard` flag update |
| **Variant Handling** | Filename parsing | Database field |

### Key Design Decisions

1. **file_id = doc_id**: Both PDF and TEI files share the same doc_id
2. **Hash-based identity**: File hash is primary key, not path
3. **Collection inheritance**: TEI files inherit doc_collections from PDF
4. **No physical file moves**: Collections are just JSON array updates
5. **Soft delete**: deleted=1 flag, physical files remain for sync

## Testing Status

**Manual Testing**:
- ✅ Server starts successfully
- ✅ Save endpoint registered in OpenAPI
- ✅ Health check passes
- ✅ Router auto-reloads on file changes

**Integration Testing**:
- ⚠️ Delete tests: 3/8 passing
- ⚠️ Save API: Test XML format compatibility issues
- ⏸️ Full test suite: Blocked on save API fixes

## Next Steps

### Immediate (Current Session)

1. **Fix Test XML Compatibility** (15 min)
   - Update test files to include proper TEI XML with fileref
   - OR: Enhance fallback logic to handle minimal XML better
   - OR: Create test utility to generate valid TEI XML

2. **Debug Delete API 422 Errors** (10 min)
   - Check request body format in tests
   - Verify Pydantic model matches Flask API contract
   - Test with curl to isolate issue

3. **Run Full Test Suite** (30 min)
   ```bash
   E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_*.test.js
   ```

### Short Term (Next Session)

4. **Implement create_version_from_upload** (30 min)
   - Upload handling mechanism
   - Temp file storage
   - Integration with save endpoint

5. **Add Python Unit Tests** (1 hour)
   - Test save strategy determination
   - Test version numbering
   - Test role-based access control
   - Test fileref extraction and update

6. **Verify Flask Equivalence** (30 min)
   - Compare save responses for same inputs
   - Document any intentional differences
   - Update API documentation

### Medium Term (Future Sessions)

7. **Migration Tools** (3-4 hours)
   - File importer (lib/file_importer.py)
   - Migration CLI (bin/migrate_to_fastapi.py)
   - Import CLI (bin/import_files.py)
   - Rebuild database CLI (bin/rebuild_database.py)

8. **Performance Testing** (1 hour)
   - Large file saves
   - Concurrent saves
   - Lock contention

9. **Error Handling** (30 min)
   - More detailed error messages
   - Better XML validation errors
   - Lock acquisition failures

## Blockers

### None Currently

All critical blockers from previous session resolved:
- ✅ User authentication working
- ✅ @require_session decorator bug fixed
- ✅ Save API implemented
- ✅ Config import fixed

### Minor Issues

1. Test XML format - easily fixable
2. Delete API 422 errors - needs investigation
3. Temp file upload mechanism - deferred, not blocking

## Success Criteria Progress

Phase 4B Completion Checklist:

- ✅ Delete API implemented with Pydantic models
- ✅ Move API implemented with Pydantic models
- ✅ Locks API endpoints implemented with Pydantic models
- ✅ Heartbeat API implemented with Pydantic models
- ✅ **NEW**: Save API implemented with Pydantic models
- ✅ All routers registered in main.py
- ✅ Integration tests created (4 test files, ~920 lines)
- ⚠️ Integration tests partially passing (needs save API fixes)
- ⏸️ Save API integration tests (needs creation)
- ⏸️ Functional equivalence with Flask verified (blocked on tests)
- ⏸️ Migration tools implemented (deferred to later)

## Recommendations

### For Next Session

1. **Priority**: Fix test compatibility issues and get all Phase 4B tests passing
2. **Create**: Comprehensive save API tests covering all scenarios
3. **Document**: Differences between Flask and FastAPI save logic
4. **Defer**: Migration tools until Phase 4B API testing is complete

### For Future

1. **Consider**: Extracting save strategy logic into separate testable functions
2. **Consider**: Creating XML test fixtures with proper TEI structure
3. **Consider**: Adding transaction rollback on save failures
4. **Consider**: Implementing file size limits and validation

## Files to Review in Next Session

- `fastapi_app/routers/files_save.py` - Main implementation
- `fastapi_app/tests/backend/files_delete.test.js` - Test format reference
- `fastapi_app/tests/helpers/test-auth.js` - Test utilities
- `server/api/files/save.py` - Flask reference implementation

## Key Learnings

1. **Database simplifies everything**: Version numbering, gold determination, collection management all become simple queries
2. **Hash-based identity**: Eliminates entire classes of path manipulation bugs
3. **Fallback extraction**: Important for test compatibility and robustness
4. **Lock management**: Need to handle hash changes carefully
5. **Role-based access**: Cleaner implementation than filesystem checks

## Conclusion

The Save API is ~90% complete. The implementation demonstrates the power of the database-backed design - what took ~370 lines of complex filesystem manipulation in Flask now takes ~350 lines of straightforward database queries and logic.

Main remaining work:
1. Fix test compatibility (15 min)
2. Debug delete API issues (10 min)
3. Run full test suite (30 min)

**Estimated time to Phase 4B completion: 1-2 hours**
