# Metadata System Overhaul - Implementation Plan

## Problem Statement

Current metadata storage is incomplete:
- TEI headers lack journal, volume, issue, pages, URL needed for complete `biblStruct`
- Database `doc_metadata` column stores minimal data (title, authors, date, publisher)
- Migration script `migrate-tei-biblstruct.py` only uses existing incomplete metadata
- No systematic way to enrich documents with complete bibliographic data

## Technical Approach

### Metadata Enrichment Strategy

1. **For documents with DOI**: Fetch complete metadata from CrossRef/DataCite
2. **For documents without DOI**: Use LLM extraction (KISSKI) from PDF content
3. **Canonical source**: Make `//sourceDesc/biblStruct` the primary metadata location in TEI
4. **Database sync**: Extract `doc_metadata` from `biblStruct` when saving TEI files

### Architecture Changes

```
Current flow:
  TEI titleStmt/publicationStmt → extract_tei_metadata() → doc_metadata (incomplete)

New flow:
  DOI/PDF → get_metadata_for_document() → biblStruct (complete) → doc_metadata (complete)
```

## Implementation Steps

### 1. Update Migration Script

**File**: `bin/migrate-tei-biblstruct.py` → `bin/update-tei-metadata.py`

**Changes**:
- Rename to reflect broader scope
- Extract existing DOI from TEI header if present
- Call `get_metadata_for_document(doi=doi, stable_id=stable_id)` to get complete metadata
- For documents with DOI: use DOI lookup
- For documents without DOI: use LLM extraction via file stable_id
- Update both TEI `biblStruct` and database `doc_metadata` column
- Handle edge cases: missing PDF file, extraction failures

**New logic**:
```python
async def enrich_document_metadata(file_obj, file_storage, file_repo, logger):
    # Load TEI
    content = file_storage.read_file(file_obj.id, "tei")
    tei_root = etree.fromstring(content)

    # Extract existing DOI if present
    doi = extract_doi_from_tei(tei_root)

    # Get complete metadata (DOI lookup or LLM extraction)
    metadata = await get_metadata_for_document(
        doi=doi,
        stable_id=file_obj.stable_id  # For LLM extraction if no DOI
    )

    # Update biblStruct in TEI
    update_biblstruct_in_tei(tei_root, metadata)

    # Save updated TEI
    updated_xml = serialize_tei_with_formatted_header(tei_root, processing_instructions)
    new_file_id, _ = file_storage.save_file(updated_xml.encode('utf-8'), "tei")

    # Update database with complete metadata
    file_repo.update_file(file_obj.id, FileUpdate(
        id=new_file_id,
        doc_metadata=metadata  # Complete metadata from API/LLM
    ))
```

### 2. Update TEI Metadata Extraction

**File**: `fastapi_app/lib/tei_utils.py`

**Function**: `extract_tei_metadata()`

**Changes**:
- Prioritize reading from `//sourceDesc/biblStruct` over legacy locations
- Fallback to legacy locations only if `biblStruct` is missing
- Extract journal metadata: `journal`, `volume`, `issue`, `pages`
- Extract URL from `biblStruct/ptr[@target]`

**Current extraction locations** (in priority order):
```python
# 1. Try biblStruct first (NEW - highest priority)
journal = tei_root.find('.//tei:sourceDesc/tei:biblStruct/tei:monogr/tei:title[@level="j"]', ns)
volume = tei_root.find('.//tei:biblStruct/tei:monogr/tei:imprint/tei:biblScope[@unit="volume"]', ns)
issue = tei_root.find('.//tei:biblStruct/tei:monogr/tei:imprint/tei:biblScope[@unit="issue"]', ns)
pages = tei_root.find('.//tei:biblStruct/tei:monogr/tei:imprint/tei:biblScope[@unit="page"]', ns)
publisher = tei_root.find('.//tei:biblStruct/tei:monogr/tei:imprint/tei:publisher', ns)
url = tei_root.find('.//tei:biblStruct/tei:ptr[@target]', ns)

# 2. Fallback to legacy locations if biblStruct missing
title = tei_root.find('.//tei:titleStmt/tei:title[@level="a"]', ns)
# ... (existing fallback logic)
```

### 3. Update File Save Logic

**File**: `fastapi_app/routers/files_save.py`

**Function**: `save_file()`

**Changes**:
- Extract metadata using updated `extract_tei_metadata()` which prioritizes `biblStruct`
- Build `doc_metadata` from extracted metadata including journal fields
- Update PDF metadata only for gold standard files (existing behavior preserved)

**No major changes needed** - existing code already uses `extract_tei_metadata()` and `update_pdf_metadata_from_tei()`. These functions will automatically use the new `biblStruct`-first logic.

### 4. Update Frontend Enhancement

**File**: `fastapi_app/plugins/metadata_extraction/enhancements/enrich-tei-header.js`

**Function**: `execute()`

**Changes**:
- Create/update `biblStruct` instead of populating legacy `titleStmt`/`publicationStmt` fields
- Use same structure as `create_tei_header()` in Python
- Handle analytic section (article metadata: title, authors)
- Handle monograph section (journal metadata: journal, volume, issue, pages, publisher, date)
- Add identifiers and URLs at `biblStruct` level

**New logic**:
```javascript
// Find or create biblStruct in sourceDesc
const sourceDesc = findTei(fileDesc, "sourceDesc") || fileDesc.appendChild(createTei(xmlDoc, "sourceDesc"));
let biblStruct = findTei(sourceDesc, "biblStruct");
if (!biblStruct) {
  biblStruct = sourceDesc.appendChild(createTei(xmlDoc, "biblStruct"));
}

// Build analytic section (article-level)
if (meta.title || meta.authors?.length) {
  let analytic = findTei(biblStruct, "analytic");
  if (!analytic) {
    analytic = biblStruct.insertBefore(createTei(xmlDoc, "analytic"), biblStruct.firstChild);
  }
  // ... update title, authors
}

// Build monograph section (journal-level)
if (meta.journal || meta.publisher || meta.date || meta.volume || meta.issue || meta.pages) {
  let monogr = findTei(biblStruct, "monogr");
  if (!monogr) {
    monogr = biblStruct.appendChild(createTei(xmlDoc, "monogr"));
  }
  // ... update journal, imprint (volume, issue, pages, date, publisher)
}

// Add identifiers and URL
if (meta.doi) {
  // ... update biblStruct/idno[@type="DOI"]
}
if (meta.url) {
  // ... update biblStruct/ptr[@target]
}
```

### 5. Update Example TEI Document

**File**: `docs/development/example.tei.xml`

**Changes**:
- Ensure `sourceDesc` contains complete `biblStruct` with:
  - `analytic/title[@level="a"]` and `analytic/author`
  - `monogr/title[@level="j"]` for journal
  - `monogr/imprint` with `biblScope[@unit="volume|issue|page"]`, `date`, `publisher`
  - `idno[@type="DOI"]` and `ptr[@target]` for identifiers/URLs
- Keep legacy `bibl` for backward compatibility but show it as less important

### 6. Update Tests

**Files**:
- `tests/unit/fastapi/test_tei_utils.py`
- `tests/api/v1/files_save.test.js`

**Test cases to add/update**:
- `test_extract_tei_metadata_from_biblstruct()` - verify journal fields extracted
- `test_extract_tei_metadata_fallback_to_legacy()` - verify fallback still works
- `test_round_trip_metadata()` - verify complete metadata survives create → extract cycle
- API test: verify saving gold TEI updates PDF with journal metadata

## Implementation Order

1. ✅ Create this plan document
2. Update `extract_tei_metadata()` in `tei_utils.py` to prioritize `biblStruct`
3. Add tests for updated extraction logic
4. Update `enrich-tei-header.js` to populate `biblStruct`
5. Update `example.tei.xml` to show complete structure
6. Rename and expand migration script to `update-tei-metadata.py`
7. Test migration script on sample documents
8. Update any other references to legacy metadata fields

## Files to Modify

### Core Files
- [ ] `fastapi_app/lib/tei_utils.py` - Update `extract_tei_metadata()`
- [ ] `fastapi_app/lib/metadata_extraction.py` - No changes (already supports DOI + LLM)
- [ ] `fastapi_app/plugins/metadata_extraction/enhancements/enrich-tei-header.js` - Update to use `biblStruct`
- [ ] `bin/migrate-tei-biblstruct.py` → `bin/update-tei-metadata.py` - Expand functionality

### Documentation
- [ ] `docs/development/example.tei.xml` - Show complete `biblStruct`

### Tests
- [ ] `tests/unit/fastapi/test_tei_utils.py` - Add `biblStruct` extraction tests
- [ ] `tests/api/v1/files_save.test.js` - Verify journal metadata in PDF updates

### Potentially Affected
- [ ] `fastapi_app/routers/files_save.py` - Review metadata extraction (likely no changes)
- [ ] Search codebase for direct references to `titleStmt`/`publicationStmt` metadata

## Testing Strategy

### Unit Tests
- Extract metadata from TEI with complete `biblStruct`
- Extract metadata from TEI without `biblStruct` (fallback to legacy)
- Round-trip metadata through create → extract cycle

### API Tests
- Save gold TEI with journal metadata → verify PDF `doc_metadata` updated
- Save version TEI → verify PDF `doc_metadata` NOT updated

### Migration Script Tests
- Test on document with DOI → verify CrossRef lookup
- Test on document without DOI → verify LLM extraction
- Test on document with existing `biblStruct` → verify update
- Test with `--dry-run` flag
- Test with `--limit` flag

## Edge Cases

1. **Document has DOI but lookup fails**: Fall back to LLM extraction using stable_id
2. **Document has no DOI and no PDF file**: Skip enrichment, log warning
3. **LLM extraction fails**: Log error, preserve existing metadata
4. **Existing biblStruct differs from fetched metadata**: Overwrite with fetched (use `--force` flag)
5. **Document has partial metadata**: Merge with fetched, preferring fetched for conflicts

## Migration Script Usage

```bash
# Dry run to preview changes
uv run python bin/update-tei-metadata.py --dry-run

# Test on limited set
uv run python bin/update-tei-metadata.py --limit 10 --verbose

# Full migration
uv run python bin/update-tei-metadata.py --verbose

# Force update even if biblStruct exists
uv run python bin/update-tei-metadata.py --force
```

## Implementation Progress

### Completed

1. ✅ **Updated `extract_tei_metadata()` in `tei_utils.py`** (lines 649-856)
   - Now prioritizes `//sourceDesc/biblStruct` for all bibliographic metadata
   - Falls back to legacy locations (titleStmt, publicationStmt) when biblStruct missing
   - Extracts: title, authors, date, DOI, URL from biblStruct first
   - Already was extracting journal, volume, issue, pages, publisher from biblStruct
   - Added DOI extraction from biblStruct
   - Updated docstring to document extraction strategy

2. ✅ **Added comprehensive tests** (`tests/unit/fastapi/test_tei_utils.py`)
   - `TestBiblStructPriorityExtraction` class with 3 test cases:
     - `test_extract_complete_metadata_from_biblstruct` - verifies biblStruct values used over legacy
     - `test_fallback_to_legacy_when_biblstruct_missing` - verifies fallback to titleStmt/publicationStmt
     - `test_round_trip_with_complete_metadata` - verifies complete metadata survives create→extract cycle
   - All 44 tests in test_tei_utils.py pass ✓

3. ✅ **Updated frontend enhancement** (`fastapi_app/plugins/metadata_extraction/enhancements/enrich-tei-header.js`)
   - Keeps legacy field population for backward compatibility
   - Added complete biblStruct population with:
     - Analytic section: title, authors
     - Monograph section: journal title, imprint (volume, issue, pages, date, publisher)
     - Identifiers: DOI or generic ID
     - URL: ptr element with target
   - Only creates biblStruct if substantial metadata present

4. ✅ **Updated example TEI** (`docs/development/example.tei.xml`)
   - Added complete biblStruct showing proper structure
   - Includes analytic (title, authors), monograph (journal, imprint), DOI, URL
   - Removed GROBID schema reference (biblStruct not part of that schema)
   - Updated bibl citation to include page range

5. ✅ **Created new migration script** (`bin/update-tei-metadata.py`)
   - Renamed from `migrate-tei-biblstruct.py` to reflect broader scope
   - Uses `get_metadata_for_document()` for DOI lookup + LLM fallback
   - Updates both TEI biblStruct and database doc_metadata
   - Async implementation using asyncio
   - Handles edge cases: missing PDFs, failed lookups, existing biblStruct
   - Key functions:
     - `extract_doi_from_tei()` - extract DOI from biblStruct or publicationStmt
     - `update_biblstruct_in_tei()` - create/update complete biblStruct structure
     - `update_tei_files()` - async main loop with comprehensive error handling

### Implementation Notes

**No changes needed to `files_save.py`**:
- Already uses `extract_tei_metadata()` which now prioritizes biblStruct
- Already calls `update_pdf_metadata_from_tei()` for gold standard files
- Extraction automatically uses new biblStruct-first logic

**Backward compatibility**:
- Legacy locations still populated by frontend enhancement
- Fallback to legacy locations when biblStruct missing
- Existing workflows continue to work

**Database updates**:
- `doc_metadata` column now includes complete metadata (journal, volume, issue, pages, DOI, URL)
- Extracted from biblStruct when saving TEI files
- Migration script updates doc_metadata for all files

6. ✅ **Fixed migration script database schema understanding** (`bin/update-tei-metadata.py`)
   - **Critical fix**: Script now correctly uses PDF→TEI relationship via `doc_id`
   - Workflow: Query PDF entries → find linked TEI files → update TEI files
   - Added DOI extraction from encoded `doc_id` using `decode_filename()` + `validate_doi()`
   - 103 out of 142 PDFs have DOI-encoded doc_ids, enabling CrossRef lookup
   - Successfully tested: 12 TEI files updated from 6 PDFs with DOI lookup
   - Updates both TEI biblStruct and PDF doc_metadata

### Testing Results

Tested with `--force --limit 20`:
- **PDFs processed**: 20
- **TEI files updated**: 12 (from 6 PDFs with DOIs)
- **PDFs skipped**: 14 (no DOI, LLM extraction not configured)
- **Errors**: 0

Verified TEI file `hd4xsz` has complete biblStruct with:
- Title: "Reconstruction of Financing Agreement Based on the Principle of Profit and Loss..."
- Journal: "Hasanuddin Law Review"
- DOI: extracted from CrossRef
- Authors: 2

### Next Steps

- [ ] Run full migration on all 142 PDFs (103 with DOIs will succeed)
- [ ] Configure KISSKI LLM service for remaining 39 PDFs without DOIs
- [ ] Review other code that may reference legacy metadata fields
- [ ] Consider deprecating direct reads from titleStmt/publicationStmt in future
- [ ] Delete old `bin/migrate-tei-biblstruct.py` script
