# Phase 5: Validation and Extraction APIs

**Goal**: Migrate XML/TEI validation and AI-based metadata extraction endpoints from Flask to FastAPI.

## Overview

This phase migrates the validation and extraction APIs that provide:
- XML/TEI schema validation (XSD and RelaxNG)
- Schema downloading and caching
- CodeMirror autocomplete data generation
- AI-based metadata extraction from PDFs and XML files
- Extractor discovery and management

These APIs are critical for the document editing workflow:
1. User uploads/edits TEI document
2. Validation API checks against schema (with timeout protection)
3. Extraction API generates metadata from PDF or refines existing XML
4. Results saved using Phase 4 file management APIs

## Flask Endpoints to Migrate

From `server/api/validate.py`:
1. **POST /api/validate** - Validate XML against embedded schema references
2. **POST /api/validate/autocomplete-data** - Generate CodeMirror autocomplete from schema

From `server/api/extract.py`:
3. **GET /api/extract/list** - List available extractors with capabilities
4. **POST /api/extract** - Perform extraction using specified extractor

## Key Implementation Details

### Validation System

**Features to preserve:**
- Dual schema support: XSD and RelaxNG
- Automatic schema download and caching (`schema/cache/` directory)
- Timeout protection for complex schemas (subprocess isolation)
- Schema-specific timeout configuration
- Processing instruction parsing (`<?xml-model ... ?>`)
- Attribute-based schema location (`xsi:schemaLocation`)
- CodeMirror-compatible error format

**Critical implementation notes:**
- Uses `lxml` for XML parsing and validation
- Uses `subprocess` to isolate validation with timeout
- RelaxNG schemas require attribute stripping before validation
- XSD schemas use `xmlschema` library for includes/imports
- Autocomplete generation only supported for RelaxNG schemas
- Schema cache organized by URL path structure

### Extraction System

**Features to preserve:**
- Extractor discovery system (plugin-based)
- PDF-based extractors (e.g., Grobid)
- XML-based extractors (e.g., metadata refiners)
- RNG schema extractors (generates schema from XML)
- Mock extractor fallback for missing dependencies
- Automatic PDF file management (moves from upload dir)
- Variant-based file saving
- Hash generation and lookup table updates

**Critical implementation notes:**
- Extractors define input type (`pdf` or `xml`)
- Results integrate with Phase 4 file saving
- Extractions can create versions if file exists
- Schema extraction saves with `.rng` extension
- Must mark sync as dirty after file changes
- Hash placeholder replacement for self-referential schemas

## Migration Tasks

### 5.1 Port Validation Library Code

**Create**: `fastapi_app/lib/schema_validator.py`

Port these functions from `server/api/validate.py`:
- `extract_schema_locations(xml_string)` - Parse schema references
- `get_schema_cache_info(schema_location)` - Cache path determination
- `download_schema_file(schema_location, ...)` - Schema download
- `create_validation_script()` - Subprocess isolation script
- `validate_with_timeout(...)` - Timeout-protected validation
- `validate(xml_string)` - Main validation orchestration

**Dependencies:**
- `lxml` for XML parsing
- `requests` for schema download
- `subprocess` for timeout protection
- `xmlschema` for XSD include handling

**Framework-agnostic design:**
- Accept cache directory path as parameter (no `current_app`)
- Return structured validation results (no Flask jsonify)
- Use dependency injection for logging

### 5.2 Port Autocomplete Generation

**Create**: `fastapi_app/lib/autocomplete_generator.py`

Port from `server/lib/relaxng_to_codemirror.py`:
- `generate_autocomplete_map(schema_file, ...)` - Generate CodeMirror data
- Schema parsing and element/attribute extraction
- Caching logic for autocomplete JSON

**Dependencies:**
- `lxml` for RelaxNG parsing
- May need to check if this lib is already in the codebase

### 5.3 Port Extraction System

**Create**: `fastapi_app/lib/extractor_manager.py`

Port from `server/extractors/discovery.py`:
- `list_extractors(available_only=True)` - Discover extractors
- `create_extractor(extractor_id)` - Instantiate extractor
- Extractor base class/interface

**Note**: Extractors themselves (`server/extractors/*.py`) can remain in their current location and be imported, or migrated if needed for cleaner separation.

### 5.4 Create Pydantic Models

**Create**: `fastapi_app/lib/models_validation.py`

```python
class ValidateRequest(BaseModel):
    xml_string: str

class ValidationError(BaseModel):
    message: str
    line: int
    column: int
    severity: Optional[str] = None  # "warning" for timeouts

class ValidateResponse(BaseModel):
    errors: List[ValidationError] = []

class AutocompleteDataRequest(BaseModel):
    xml_string: str
    invalidate_cache: bool = False

# AutocompleteDataResponse is complex nested structure - document it
```

**Create**: `fastapi_app/lib/models_extraction.py`

```python
class ExtractorInfo(BaseModel):
    id: str
    name: str
    description: str
    input: List[str]  # ["pdf"] or ["xml"]
    output: List[str]  # ["xml"]
    available: bool

class ListExtractorsResponse(BaseModel):
    extractors: List[ExtractorInfo]

class ExtractRequest(BaseModel):
    extractor: str
    file_id: str  # PDF hash or XML hash
    options: Dict[str, Any] = {}

class ExtractResponse(BaseModel):
    id: Optional[str] = None  # For PDF extractions
    pdf: Optional[str] = None  # PDF hash (if applicable)
    xml: str  # XML file hash
```

### 5.5 Implement Validation Router

**Create**: `fastapi_app/routers/validation.py`

Endpoints:
- `POST /api/validate` - Validate XML document
- `POST /api/validate/autocomplete-data` - Generate autocomplete data

**Key implementation:**
```python
@router.post("/validate", response_model=ValidateResponse)
def validate_xml(
    request: ValidateRequest,
    settings = Depends(get_settings)
):
    """Validate XML against embedded schema references."""
    from ..lib.schema_validator import validate

    errors = validate(
        request.xml_string,
        cache_dir=settings.data_root / "schema" / "cache"
    )

    return ValidateResponse(errors=errors)
```

**Important:**
- Check internet connectivity before cache invalidation
- Return 503 if offline and invalidation requested
- Use subprocess timeout protection for validation
- Support both XSD and RelaxNG schemas

### 5.6 Implement Extraction Router

**Create**: `fastapi_app/routers/extraction.py`

Endpoints:
- `GET /api/extract/list` - List available extractors
- `POST /api/extract` - Perform extraction

**Key implementation:**
```python
@router.post("", response_model=ExtractResponse)
def extract_metadata(
    request: ExtractRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(require_authenticated_user),
    settings = Depends(get_settings)
):
    """Perform extraction using specified extractor."""
    from ..lib.extractor_manager import create_extractor

    # Create extractor with mock fallback
    try:
        extractor = create_extractor(request.extractor)
    except RuntimeError as e:
        if should_use_mock(request.extractor, str(e)):
            extractor = create_extractor("mock-extractor")
        else:
            raise HTTPException(status_code=400, detail=str(e))

    # Resolve file_id to physical path
    file_metadata = repo.get_file_by_id(request.file_id)
    if not file_metadata:
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_id}")

    # Get physical file path from hash-sharded storage
    file_path = get_file_storage_path(file_metadata.id, file_metadata.file_type)

    # Perform extraction based on input type
    extractor_info = extractor.__class__.get_info()
    expected_input = extractor_info['input'][0]

    if expected_input == "pdf":
        with open(file_path, 'rb') as f:
            tei_xml = extractor.extract(pdf_path=str(file_path), options=request.options)
    else:
        with open(file_path, 'r', encoding='utf-8') as f:
            xml_content = f.read()
        tei_xml = extractor.extract(xml_content=xml_content, options=request.options)

    # Save result using Phase 4 save API
    # ... integrate with file_repository.insert_file() ...

    return ExtractResponse(pdf=..., xml=...)
```

**Integration with Phase 4:**
- Use `FileRepository` to resolve file IDs
- Use `FileStorage` to read physical files
- Use `FileRepository.insert_file()` to save extraction results
- Properly handle reference counting
- Set `sync_status='modified'` for new files

### 5.7 Router Registration

Update `fastapi_app/main.py`:
```python
from .routers import (
    # ... existing routers ...
    validation,
    extraction
)

# Versioned API
api_v1.include_router(validation.router)
api_v1.include_router(extraction.router)

# Compatibility API
api_compat.include_router(validation.router)
api_compat.include_router(extraction.router)
```

### 5.8 Integration Testing

**Create**: `fastapi_app/tests/backend/validation.test.js`
- Test XML validation with XSD schema
- Test XML validation with RelaxNG schema
- Test validation timeout handling
- Test autocomplete data generation
- Test cache invalidation with/without internet

**Create**: `fastapi_app/tests/backend/extraction.test.js`
- Test extractor listing
- Test PDF-based extraction
- Test XML-based extraction
- Test mock extractor fallback
- Test file saving and hash generation
- Test variant handling

## Critical Dependencies

### Existing Libraries to Reuse
- `server/lib/relaxng_to_codemirror.py` - Autocomplete generation
- `server/extractors/` - Extractor implementations
- `server/lib/debug_utils.py` - Extraction logging

### New Framework-Agnostic Libraries
- `fastapi_app/lib/schema_validator.py` - Validation logic
- `fastapi_app/lib/autocomplete_generator.py` - Autocomplete generation
- `fastapi_app/lib/extractor_manager.py` - Extractor management

## Testing Strategy

1. **Unit Tests** (Python):
   - Test schema location extraction
   - Test cache path generation
   - Test timeout handling
   - Test extractor discovery

2. **Integration Tests** (Node.js):
   - Test validation with real schemas
   - Test extraction with mock extractors
   - Test file saving integration
   - Test error handling

3. **Manual Testing**:
   - Validate TEI documents in UI
   - Trigger extractions from UI
   - Verify schema caching works
   - Test timeout protection

## Success Criteria

Phase 5 is **COMPLETE** when:
- ✅ All 4 endpoints implemented (2 validation, 2 extraction)
- ✅ Schema caching works correctly
- ✅ Validation timeout protection functional
- ✅ Autocomplete generation works
- ✅ Extractors discoverable and functional
- ✅ Mock extractor fallback works
- ✅ Integration with Phase 4 file saving works
- ✅ All integration tests passing
- ✅ Manual testing complete

## Time Estimate

- Library migration: 3-4 hours
- Pydantic models: 1 hour
- Validation router: 2 hours
- Extraction router: 3 hours
- Integration with Phase 4: 2 hours
- Testing: 3-4 hours

**Total**: 14-18 hours

## Notes

- Validation system is relatively self-contained
- Extraction system has more integration with file management
- Both systems have complex error handling requirements
- Schema caching must work offline after initial download
- Timeout protection is critical for complex schemas
- Mock extractor provides development/testing fallback
