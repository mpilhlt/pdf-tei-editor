# Schema Generation & Validation Workflow

## Overview

The RNG (RelaxNG) schema generation feature allows extracting validation schemas from TEI documents and serving them via stable URLs for XML validation.

## Backend Implementation

### Extraction Endpoint

`POST /api/v1/extract` with `extractor: "rng"`

**Required options:**
- `variant_id`: Variant identifier (e.g., "grobid.training.segmentation")
- Optional: `schema_strictness`, `include_namespaces`, `add_documentation`

**Response:**
```json
{
  "id": null,
  "pdf": null,
  "xml": "stable_id_of_rng_file"
}
```

### File Storage

RNG schemas use a stable doc_id format:
- Pattern: `schema-rng-{variant_id}`
- Example: `schema-rng-grobid.training.segmentation`

**Versioning:**
- First extraction: Gold standard (`is_gold_standard=True`, `version=None`)
- Subsequent extractions: Versioned files (`version=1, 2, 3...`)
- File type: `'rng'` (not `'tei'`)
- Variant stored in `variant` field for filtering

### Schema Serving

`GET /api/v1/schema/rng/{variant}`

- Serves the gold standard RNG schema for the specified variant
- Returns 404 if schema doesn't exist
- Content-Type: `application/xml`
- Implementation: [schema.py](../routers/schema.py)

### Files List API

RNG schemas appear in `/api/v1/files/list` as XML-only documents:

```json
{
  "doc_id": "schema-rng-{variant}",
  "source": {
    "id": "stable_id",
    "file_type": "rng",
    "label": "RelaxNG Schema"
  },
  "artifacts": [
    {
      "id": "stable_id",  // Same as source for gold standard
      "file_type": "rng",
      "variant": "variant_id",
      "version": null,
      "is_gold_standard": true
    }
    // Additional artifacts for versioned schemas
  ]
}
```

**Key logic** ([files_list.py:103-136](../routers/files_list.py#L103-L136)):
- Documents without PDF source are treated as XML-only (standalone)
- Source becomes first artifact if it has a variant
- RNG files must be included in artifact loop (`file_type in ['tei', 'rng']`)

## Frontend Issues (Incomplete)

### Current Limitations

The file selection UI was designed for PDF→XML workflow and has workarounds for XML-only files:

1. **State management:** Uses `state.pdf` and `state.xml`, but XML-only files need `pdf=null` and `xml=source_id`
2. **Selectbox population:** XML selectbox only populates when a PDF is selected or special conditions met
3. **File drawer:** Requires `type='xml-only'` distinction from `type='pdf'`

### Partial Fixes Applied

**Backend:**
- [files_list.py:134](../routers/files_list.py#L134) - Include RNG in artifact loop

**Frontend:**
- [file-selection.js:420-422](../../app/src/plugins/file-selection.js#L420-L422) - Check for XML-only selection
- [file-selection-drawer.js:361](../../app/src/plugins/file-selection-drawer.js#L361) - Distinguish xml-only type
- [file-selection-drawer.js:522-527](../../app/src/plugins/file-selection-drawer.js#L522-L527) - Handle xml-only selection

### Known Issues (RESOLVED)

~~- Setting `state.pdf = null` for XML-only files can trigger state resets~~
~~- Selectbox behavior inconsistent when switching between PDF-XML and XML-only workflows~~
~~- File drawer selection may not properly load XML-only files~~

**Fixed in 2025-11-27 session:**

- ✅ RNG files now save with correct `.rng` extension (was incorrectly using `.tei.xml`)
- ✅ File content hash properly updates in database when RNG schemas are modified
- ✅ XML comments in RNG schemas (including processing instructions) no longer get corrupted during save
- ✅ Files load correctly via stable_id after save operations

**Related fixes:**

- [files_save.py:304](../routers/files_save.py#L304) - Use `existing_file.file_type` instead of hardcoded `'tei'`
- [models.py:109](../lib/models.py#L109) - Added `id` field to `FileUpdate` model for hash updates
- [xml_utils.py:23](../lib/xml_utils.py#L23) - Enhanced entity encoding to preserve comments, CDATA, and PIs
- [tei-utils.js:298](../../app/src/modules/tei-utils.js#L298) - Client-side equivalent encoding fix

### Future Work Needed

The file selection system needs architectural changes to properly support both workflows:
- Refactor state model to distinguish source type (PDF vs XML-only)
- Separate selection logic for PDF-based vs standalone XML workflows
- Consider using `state.source` and `state.target` instead of `pdf`/`xml`

## Testing

E2E tests: [tests/api/v1/extraction_rng.test.js](../../tests/api/v1/extraction_rng.test.js)

**Coverage:**
- ✅ RNG extraction with variant
- ✅ File list includes RNG with correct structure
- ✅ RNG accessible via `/api/files/{id}`
- ✅ Schema endpoint `/api/v1/schema/rng/{variant}`
- ✅ Versioning (re-extraction creates new version)
- ✅ 404 for non-existent variants

## Related Files

**Backend:**
- [routers/extraction.py](../routers/extraction.py) - Extraction endpoint and RNG-specific logic
- [routers/schema.py](../routers/schema.py) - Schema serving endpoint
- [routers/files_list.py](../routers/files_list.py) - File listing with XML-only support
- [extractors/rng_extractor.py](../extractors/rng_extractor.py) - RNG schema generator

**Frontend:**
- [app/src/plugins/file-selection.js](../../app/src/plugins/file-selection.js) - Selectbox-based file selection
- [app/src/plugins/file-selection-drawer.js](../../app/src/plugins/file-selection-drawer.js) - Drawer-based file selection
