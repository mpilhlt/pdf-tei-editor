# File Data Structure Update Plan

## Executive Summary

The FastAPI server's `/api/v1/files/list` endpoint returns a different structure than the Flask server, and the frontend code expects yet another format. This document proposes a simplified, consistent data structure that:

1. Eliminates complexity around gold/version/variant handling
2. Uses stable IDs (`id`) instead of content hashes (`hash`) for client-facing operations
3. Flattens the nested variant structure for easier consumption
4. Maintains backward compatibility where possible

## Current Problems

### 1. Multiple Conflicting Structures

**FastAPI Server Returns:**

```javascript
{
  files: [{
    doc_id: "10.32361/2025170222092",
    doc_collections: ["grobid3"],           // Array
    doc_metadata: { title, authors, ... },
    pdf: {
      id: "tnc2u3",                        // stable_id (6 chars)
      filename: "...",
      // NO hash field
    },
    versions: [],                          // Empty - versions are in variants
    gold: [],                              // Empty - gold is in variants
    variants: {                            // Nested by variant name
      "grobid.training.segmentation": [{
        id: "htzgub",                      // stable_id
        variant: "grobid.training.segmentation",
        // NO hash field
      }]
    }
  }]
}
```

**Frontend Expects:**

```javascript
{
  files: [{
    id: "abc123def",                       // Some identifier
    collection: "grobid3",                 // Singular string
    label: "Document Title",
    pdf: {
      hash: "abc123def",                   // Content hash
    },
    versions: [{                           // Flat array
      hash: "xyz789",                      // Content hash
      variant_id: "grobid.training.segmentation"
    }],
    gold: [{                               // Flat array
      hash: "uvw456",                      // Content hash
      variant_id: "grobid.training.segmentation"
    }]
  }]
}
```

### 2. Hash vs Stable ID Confusion

- **Content Hash**: Changes when file content changes (used for cache validation, locking)
- **Stable ID**: Permanent identifier for a file record (used for URLs, client references)
- **Current Issue**: Frontend uses `hash` everywhere but server returns `id` (stable_id)
- **Impact**: URL parameters, state management, and file lookups are inconsistent

### 3. Variant Complexity

**Current Approach:**

- Server nests variants in a dictionary: `variants: { "variant_name": [...files] }`
- Frontend expects flat `versions` and `gold` arrays with `variant_id` property
- Filtering logic duplicated in multiple places (file-data-utils.js, file-selection.js, file-selection-drawer.js)
- Gold vs version distinction unclear (both can have variants)

### 4. Collection Handling

- Server returns `doc_collections` as an array
- Frontend expects `collection` as a singular string

## Proposed Simplified Structure

### Server Response Format

```javascript
{
  "files": [{
    // Document-level properties
    "doc_id": "10.32361/2025170222092",
    "collections": ["grobid3", "test"],    // All collections
    "doc_metadata": {                      // Metadata from TEI header
      "title": "Document Title",
      "authors": [...],
      "date": "2025",
      "publisher": "..."
    },

    // Source file (PDF or primary XML for XML-only docs)
    // Type: FileItem (base type with label)
    "source": {
      "id": "tnc2u3",                      // Stable ID (for URLs)
      "filename": "document.pdf",
      "file_type": "pdf",
      "label": "Document Title",           // Display label (from doc_metadata.title)
      "file_size": 312341,
      "created_at": "2025-10-27T16:53:50",
      "updated_at": "2025-10-27T16:53:50"
    },

    // All artifact files (flattened, no gold/version/variant distinction)
    // Type: Artifact[] (extends FileItem with artifact-specific fields)
    "artifacts": [{
      // Base FileItem fields (all required)
      "id": "htzgub",                      // Stable ID (for URLs)
      "filename": "document.grobid.xml",
      "file_type": "tei",                  // or other artifact types in future
      "label": "Annotator",                // Display label
      "file_size": 94764,
      "created_at": "2025-10-27T16:53:50",
      "updated_at": "2025-10-27T16:53:50",
      // Artifact-specific fields (all required, use null for empty)
      "variant": "grobid.training.segmentation",  // null if no variant
      "version": 1,                        // null for gold standard
      "is_gold_standard": false,
      "is_locked": false,
      "access_control": null               // null if no restrictions
    }]
  }]
}
```

### Key Simplifications

1. **Flat Artifacts Array**: No more `versions`, `gold`, `variants` nesting - just one `artifacts` array with properties that indicate category
2. **Stable IDs Only**: Use `id` field consistently (stable_id), remove `hash` from client-facing API
3. **Collections Array**: Single `collections` array field (no primary/singular needed)
4. **Nested Metadata**: Keep `doc_metadata` as nested object (no flattening)
5. **Unified Source**: Call it `source` instead of `pdf` to support XML-only workflows
6. **Generic Artifacts**: Use `artifacts` instead of `tei_files` to support future non-TEI artifacts
7. **Type Hierarchy**: `FileItem` (base type with label) and `Artifact` (extends FileItem) - eliminates optional properties and provides type safety

## Migration Strategy

### Phase 1: Server-Side Changes

**Files to Update:**

- `fastapi_app/routers/files_list.py` - Update response construction
- `fastapi_app/lib/models_files.py` - Update Pydantic models

**Changes:**

1. Create new response models with type hierarchy:
   - `FileItemModel` - Base model for files (has label field)
     - Fields: id, filename, file_type, label, file_size, created_at, updated_at
   - `ArtifactModel` - Extends FileItemModel with artifact-specific fields
     - Additional fields: variant, version, is_gold_standard, is_locked, access_control
   - `DocumentGroupModel` - Document with source (FileItemModel) + artifacts (ArtifactModel[])
   - `FileListResponseModel` - Top-level response

2. Update `list_files()` endpoint:
   - Flatten variants into single `artifacts` array
   - Keep `doc_metadata` nested (no flattening)
   - Use `collections` array (no primary collection)
   - Rename `pdf` to `source`
   - Rename `versions`/`gold`/`variants` to `artifacts`
   - Add `label` to source files (use doc_metadata.title)
   - Ensure all artifact-specific fields are present (use null where appropriate)

3. No backward compatibility needed:
   - No published URLs exist
   - Update endpoint in place at `/api/v1/files/list`

### Phase 2: Client-Side Changes

**Type Definitions (file-data-utils.js):**

```javascript
/**
 * Base file item - used for source files (PDF, primary XML)
 * @typedef {object} FileItem
 * @property {string} id - Stable ID for URLs and references
 * @property {string} filename
 * @property {string} file_type - 'pdf' or 'tei'
 * @property {string} label - Display label
 * @property {number} file_size
 * @property {string} created_at - ISO timestamp
 * @property {string} updated_at - ISO timestamp
 */

/**
 * Artifact file item - extends FileItem with artifact-specific properties
 * @typedef {FileItem & {
 *   variant: string|null,
 *   version: number|null,
 *   is_gold_standard: boolean,
 *   is_locked: boolean,
 *   access_control: object|null
 * }} Artifact
 */

/**
 * @typedef {object} DocumentMetadata
 * @property {string} title - Document title
 * @property {object[]} authors - Author objects {given, family}
 * @property {string} date - Publication date
 * @property {string} [publisher] - Publisher name
 */

/**
 * @typedef {object} DocumentItem
 * @property {string} doc_id - Document identifier
 * @property {string[]} collections - All collections for this document
 * @property {DocumentMetadata} doc_metadata - Document metadata from TEI header
 * @property {FileItem} source - Source file (PDF or primary XML)
 * @property {Artifact[]} artifacts - All artifact files (TEI, etc.)
 */

/**
 * @typedef {object} FileListResponse
 * @property {DocumentItem[]} files
 */
```

**Files Requiring Updates:**

1. **app/src/modules/file-data-utils.js**
   - Update all typedefs
   - Replace `createHashLookupIndex()` with `createIdLookupIndex()`
   - Replace `getFileDataByHash()` with `getFileDataById()`
   - Remove `filterFileDataByVariant()` complexity (just filter artifacts array)
   - Remove `filterFileContentByVariant()` (no longer nested)
   - Update `extractVariants()` to work with flat artifacts array
   - Update `findMatchingGold()` to work with flat artifacts array
   - Simplify all filtering functions
   - Update collection handling (collections array instead of singular)

2. **app/src/plugins/file-selection.js**
   - Update `populateSelectboxes()` to use new structure
   - Replace `.hash` with `.id` throughout
   - Simplify variant filtering (just filter `artifacts` array)
   - Update gold/version separation logic (filter by `is_gold_standard` flag) - note that there can be several gold standards if no variant filter is set (one gold per variant)
   - Update `onChangePdfSelection()` to use `source` instead of `pdf`
   - Update collection handling (use `collections[0]` or first available)

3. **app/src/plugins/file-selection-drawer.js**
   - Update `populateFileTree()` to use new structure
   - Replace `.hash` with `.id` throughout
   - Simplify tree building (no more nested variants)
   - Update `selectCurrentStateItem()` to use stable IDs

4. **app/src/plugins/services.js**
   - Update file loading to use stable IDs
   - Update URL construction (if any hash references exist)

5. **app/src/plugins/filedata.js**
   - Update `load()` method to fetch from new endpoint
   - Transform response if needed for compatibility

6. **app/src/plugins/url-hash-state.js**
   - Update URL parameter handling (replace `hash` with `id` if needed)

7. **app/src/plugins/xmleditor.js**
   - Update any file reference logic

8. **app/src/app.js**
   - Update state structure if needed

9. **app/src/modules/browser-utils.js**
   - Update any hash-based URL construction

### Phase 3: State Management Updates

**Current State:**

```javascript
{
  pdf: "abc123",    // Content hash
  xml: "def456",    // Content hash
  collection: "grobid3"
}
```

**New State:**

```javascript
{
  pdf: "tnc2u3",        // Stable ID (keep name as-is for now)
  xml: "htzgub",        // Stable ID (keep name as-is)
  collection: "grobid3" // First collection from collections array
}
```

**Decision**: Keep state variable names unchanged (`pdf`, `xml`) to avoid churn. The rename to `source`/`artifact` only affects the API response structure, not internal state management. This can be refactored later if needed.

### Phase 4: Testing Updates

**Test Files to Update:**

- E2E tests that expect specific response structures
- Backend tests that validate response schemas
- Any mock data in test fixtures

**Test Strategy:**

1. Update backend tests first (validate new response structure)
2. Update E2E tests incrementally
3. Add tests for backward compatibility (if maintaining old endpoint)

## Detailed File Change Checklist

### Backend Files

- [ ] `fastapi_app/lib/models_files.py`
  - [ ] Add `FileItemModel` (base model with label field)
    - [ ] Fields: id, filename, file_type, label, file_size, created_at, updated_at
  - [ ] Add `ArtifactModel` (extends FileItemModel)
    - [ ] Inherit all FileItemModel fields
    - [ ] Additional fields: variant, version, is_gold_standard, is_locked, access_control
    - [ ] All fields required (use `Optional[...]` for nullable, but always present in response)
  - [ ] Add `DocumentGroupModel` (document with source + artifacts)
    - [ ] Fields: doc_id, collections, doc_metadata, source (FileItemModel), artifacts (List[ArtifactModel])
  - [ ] Add `FileListResponseModel` (top-level response)
    - [ ] Field: files (List[DocumentGroupModel])
  - [ ] Update or deprecate old models (DocumentGroup, FileListItem, FileListResponse)

- [ ] `fastapi_app/routers/files_list.py`
  - [ ] Create `_build_file_item()` helper (creates FileItemModel from FileMetadata)
  - [ ] Create `_build_artifact()` helper (creates ArtifactModel from FileMetadata)
  - [ ] Create `_build_document_group()` helper (creates DocumentGroupModel)
  - [ ] Update `list_files()` to use new models
  - [ ] Flatten variants into `artifacts` array
  - [ ] Keep `doc_metadata` nested (no extraction)
  - [ ] Use single `collections` array field
  - [ ] Rename `pdf` → `source`
  - [ ] Rename `versions`/`gold`/`variants` → `artifacts`
  - [ ] Add `label` to source files (from doc_metadata.title)
  - [ ] Ensure all artifact fields present (variant, version, is_gold_standard, is_locked, access_control)

- [ ] `fastapi_app/lib/file_repository.py`
  - [ ] Add helper methods if needed for new structure
  - [ ] Ensure stable_id is always populated

### Frontend Files

- [ ] `app/src/modules/file-data-utils.js`
  - [ ] Update all `@typedef` comments
  - [ ] Rename `hash` → `id` in all typedefs
  - [ ] Add `DocumentMetadata` typedef
  - [ ] Update `DocumentItem` typedef to use `collections` array, `doc_metadata`, `source`, `artifacts`
  - [ ] Update `createHashLookupIndex()` → `createIdLookupIndex()`
  - [ ] Update `getFileDataByHash()` → `getFileDataById()`
  - [ ] Update `getDocumentTitle()` to use id and doc_metadata
  - [ ] Simplify `extractVariants()` (flat artifacts array)
  - [ ] Simplify `filterFileDataByVariant()` (filter artifacts array)
  - [ ] Remove `filterFileContentByVariant()` (no longer needed - just filter artifacts)
  - [ ] Update `findMatchingGold()` (filter artifacts by is_gold_standard flag)
  - [ ] Update `findCollectionByHash()` → `findCollectionById()` (use collections[0])
  - [ ] Update `findFileByPdfHash()` → `findFileBySourceId()`
  - [ ] Update `findCorrespondingPdf()` → `findCorrespondingSource()`
  - [ ] Update `groupFilesByCollection()` to handle collections array

- [ ] `app/src/plugins/file-selection.js` (674 lines)
  - [ ] Update `DocumentItem` typedef import
  - [ ] Replace `file.hash` → `file.id` (appears ~15 times)
  - [ ] Replace `pdf.hash` → `source.id` (appears ~8 times)
  - [ ] Replace `file.collection` → `file.collections[0]` (or appropriate logic)
  - [ ] Update `populateSelectboxes()` (line 334)
    - [ ] Change `file.pdf` → `file.source`
    - [ ] Change `file.versions` → filter `file.artifacts` by `!is_gold_standard && !variant`
    - [ ] Change `file.gold` → filter `file.artifacts` by `is_gold_standard`
    - [ ] Simplify variant filtering (just filter artifacts array)
  - [ ] Update `onChangePdfSelection()` (line 524)
  - [ ] Update `onChangeXmlSelection()` (line 618)
  - [ ] Update `isCurrentSelectionValid()` (line 211)

- [ ] `app/src/plugins/file-selection-drawer.js` (542 lines)
  - [ ] Replace `file.hash` → `file.id` (appears ~12 times)
  - [ ] Replace `pdf.hash` → `source.id` (appears ~6 times)
  - [ ] Replace `file.collection` → `file.collections[0]`
  - [ ] Update `populateFileTree()` (line 277)
    - [ ] Change `file.pdf` → `file.source`
    - [ ] Remove `filterFileContentByVariant()` call - filter artifacts directly
    - [ ] Update tree node data attributes
    - [ ] Filter artifacts by `is_gold_standard` flag for gold section
    - [ ] Filter artifacts by `!is_gold_standard` for versions section
  - [ ] Update `selectCurrentStateItem()` (line 413)
  - [ ] Update `onFileTreeSelection()` (line 468)
  - [ ] Update `extractVariants()` call to work with artifacts

- [ ] `app/src/plugins/services.js`
  - [ ] Search for `.hash` references
  - [ ] Update file loading logic if needed
  - [ ] Update any URL construction

- [ ] `app/src/plugins/filedata.js`
  - [ ] Update API endpoint (if changed to /list-v2)
  - [ ] Add response transformation if maintaining compatibility
  - [ ] Update `createHashLookupIndex()` call

- [ ] `app/src/plugins/url-hash-state.js`
  - [ ] Update URL parameter names if needed
  - [ ] Replace hash → id in URL construction

- [ ] `app/src/plugins/xmleditor.js`
  - [ ] Search for `.hash` references
  - [ ] Update if needed

- [ ] `app/src/app.js`
  - [ ] Update state initialization if needed
  - [ ] Update state typedef if needed

- [ ] `app/src/modules/browser-utils.js`
  - [ ] Search for hash-based URL construction
  - [ ] Update if needed

### Test Files

- [ ] `fastapi_app/tests/backend/*.test.js`
  - [ ] Update E2E tests expecting old structure
  - [ ] Update assertions to check new fields
  - [ ] Update mock data if any

- [ ] Python backend tests (if any)
  - [ ] Update response schema validation
  - [ ] Update fixture data

### Documentation

- [ ] Update API documentation
- [ ] Update architecture docs
- [ ] Update developer guide
- [ ] Add migration notes

## Breaking Changes Summary

1. **Response Structure**: `pdf` → `source`, `versions`/`gold`/`variants` → `artifacts`
2. **ID Field**: `hash` → `id` (stable_id) throughout
3. **Collection Field**: `doc_collections` (array) → `collections` (array, no singular form)
4. **Metadata**: `doc_metadata` remains nested (no change)
5. **Artifacts**: Generic term for all derived files (TEI, future formats)
6. **Type Hierarchy**:
   - Server: `FileItemModel` (base) and `ArtifactModel` (extends base)
   - Client: `FileItem` (base) and `Artifact` (extends base)
   - Both source and artifacts have `label` field (non-optional)
   - All artifact-specific fields are non-optional (use null for empty values)

## Backward Compatibility

**Decision**: No backward compatibility needed

- No published URLs exist using old structure
- Internal-only API during migration
- Update endpoint in place at `/api/v1/files/list`
- All clients updated simultaneously

## Success Criteria

- [ ] All E2E tests passing
- [ ] All unit tests passing
- [ ] No console errors in browser
- [ ] File selection works correctly
- [ ] Variant filtering works correctly
- [ ] URL state persistence works
- [ ] File locking works correctly
- [ ] Performance is equal or better than before

## Open Questions - with answers

1. Should we include content hash anywhere in the response for debugging? - No, hashes are not needed on the client at all
2. How to handle multi-collection documents (use primary, all, or first)? - just one data point (`collections`), no primary collection needed
3. Should we version the API endpoint or use content negotiation? - Leave versioned as before?
4. What to do about existing URLs with old hash parameters? - no need for BC, no URLs have been published
5. Should we maintain a hash→id mapping table for URL migration? - No.
6. Should we change the state management variable names (Phase 5) - no, leave that for a later refactoring
