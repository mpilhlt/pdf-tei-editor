# File Export Implementation

## Overview

The file export system provides functionality to export files from the content-addressable hash-sharded storage into human-readable directory structures. This complements the file import system and enables users to work with files in a traditional hierarchical file system format.

## Architecture

### Components

1. **DOI Utils** ([fastapi_app/lib/doi_utils.py](../../fastapi_app/lib/doi_utils.py))
   - Filesystem-safe encoding/decoding for document IDs
   - Supports DOIs and other document identifiers
   - Backward compatibility with legacy encoding

2. **File Exporter** ([fastapi_app/lib/file_exporter.py](../../fastapi_app/lib/file_exporter.py))
   - Core export logic with filtering and grouping
   - Handles multi-collection files
   - Atomic file writes for safety

3. **CLI Tool** ([bin/export_files.py](../../bin/export_files.py))
   - Command-line interface for exports
   - Flexible filtering and grouping options
   - Dry-run mode for preview

## Filename Encoding

### New Encoding (Dollar-Sign Encoding)

Document IDs (especially DOIs) can contain characters that are incompatible with various filesystems. The new encoding uses a dollar-sign based scheme:

**Encoding Rules:**
- Forward slashes (`/`) → double underscore (`__`)
- Other unsafe characters → `$XX$` where XX is the hexadecimal character code
- Dollar sign itself is encoded to avoid ambiguity

**Examples:**
```
10.1111/1467-6478.00040  →  10.1111__1467-6478.00040
10.1234/test:file        →  10.1234__test$3A$file
doc<name>                →  doc$3C$name$3E$
```

**Unsafe Characters:**
- Windows: `< > : " | ? * \` and control characters
- All systems: `/` (encoded specially as `__`)
- Dollar sign `$` (encoded to avoid ambiguity)

### Legacy Encoding (Deprecated)

The legacy encoding from [server/lib/doi_utils.py](../../server/lib/doi_utils.py) used a simpler pattern-based approach:

```
$1$ → /
$2$ → :
$3$ → ?
$4$ → *
$5$ → |
$6$ → <
$7$ → >
$8$ → "
$9$ → \
```

The `decode_filename_legacy()` function supports decoding these files for migration purposes but is marked as deprecated.

## Collection Inheritance

**Important**: In the database schema, only PDF files store collection information in their `doc_collections` field. TEI files have an empty `doc_collections` array and inherit their collections from the associated PDF file (same `doc_id`).

When exporting:
- PDF files use their stored `doc_collections` directly
- TEI files look up their associated PDF and inherit its `doc_collections`
- This ensures TEI files are exported to the same collections as their PDFs

Example:
```
PDF:  doc_id="10.1515/test", doc_collections=["corpus1", "corpus2"]
TEI:  doc_id="10.1515/test", doc_collections=[]  ← inherits from PDF
```

Both files will be exported to `corpus1/` and `corpus2/` when using `--group-by=collection`.

## Terminology: Variants vs. Versions

**Critical Distinction:**

The system has two orthogonal concepts:

1. **Variant** = The extraction method/model used to create a TEI file
   - Examples: `grobid.training.segmentation`, `llamore-default`
   - Stored in the `variant` field
   - Multiple variants can exist for the same document (different extraction methods)

2. **Version** = Edition number within a specific variant
   - Stored in the `version` field (0, 1, 2, 3...)
   - Gold status determined by `is_gold_standard` flag (only ONE gold per variant)
   - Multiple versions can exist for the same variant (editing/extraction history)
   - `version=NULL` treated as `version=0` for compatibility

**Example:**
```
Document 10.1234/test:
  Variant "grobid.training.segmentation":
    - version=0, is_gold_standard=1  → Current gold (→ tei/10.1234__test.grobid.training.segmentation.tei.xml)
    - version=0, is_gold_standard=0  → Older v0     (→ versions/10.1234__test.grobid.training.segmentation-v0.tei.xml)
    - version=1, is_gold_standard=0  → Even older   (→ versions/10.1234__test.grobid.training.segmentation-v1.tei.xml)
```

## Export Modes and Filtering

### File Selection

**By Default:**
- Exports all PDF files
- Exports only gold standard TEI files (`is_gold_standard=1`)

**With `--versions` flag:**
- Additionally exports all non-gold TEI files (`is_gold_standard=0`)
- Version number in filename comes from the `version` field (treating NULL as 0)

**Collection Filtering (`--collections=corpus1,corpus2`):**
- Exports only files belonging to specified collections
- TEI files inherit collections from their associated PDF (same `doc_id`)
- Multi-collection files are exported if they belong to any specified collection

**Variant Filtering (`--variants=pattern1,pattern2`):**
- Filters TEI files by variant name
- Supports glob patterns (e.g., `grobid*` matches `grobid-0.7.0`, `grobid-0.8.1`)
- PDFs are always included regardless of variant filter

**Regex Filtering (`--regex=pattern`):**
- Applies regular expression to constructed filenames
- Filters files after filename construction but before export

### Grouping Strategies

#### Type Grouping (Default)

Groups files by type: PDFs, gold TEI files, and versions.

```
export/
├── pdf/
│   └── 10.1111__1467-6478.00040.pdf
├── tei/
│   ├── 10.1111__1467-6478.00040.tei.xml
│   └── 10.1111__1467-6478.00040.grobid-0.8.1.tei.xml
└── versions/  (if --versions)
    └── 10.1111__1467-6478.00040.grobid-0.8.1-v2.tei.xml
```

#### Collection Grouping (`--group-by=collection`)

Groups files by collection, with type subdirectories.

```
export/
├── corpus1/
│   ├── pdf/
│   │   └── 10.1111__test.pdf
│   ├── tei/
│   │   └── 10.1111__test.grobid.tei.xml
│   └── versions/  (if --versions)
│       └── 10.1111__test.grobid-v2.tei.xml
└── corpus2/
    └── ...
```

**Multi-Collection Handling:**
- Files belonging to multiple collections are duplicated to each collection directory
- This ensures complete export for each collection independently

#### Variant Grouping (`--group-by=variant`)

Groups TEI files by variant name. PDFs always go to `pdf/` directory.

```
export/
├── pdf/
│   └── 10.1111__test.pdf
├── grobid-0.8.1/
│   └── 10.1111__test.grobid-0.8.1.tei.xml
└── metatei-1.0/
    └── 10.1111__test.metatei-1.0.tei.xml
```

## Filename Construction

### PDF Files
```
<encoded_doc_id>.pdf
```

### Gold TEI Files (with variant)
```
<encoded_doc_id>.<variant>.tei.xml
```

### Gold TEI Files (without variant)
```
<encoded_doc_id>.tei.xml
```

### Versioned TEI Files
```
<encoded_doc_id>.<variant>-v<version>.tei.xml
```

**Examples:**
```
10.1111__test.pdf
10.1111__test.tei.xml
10.1111__test.grobid-0.8.1.tei.xml
10.1111__test.grobid-0.8.1-v2.tei.xml
```

## Filename Transformations

The `--transform-filename` option allows sed-style transformations using `/search/replace/` syntax. This option can be specified multiple times to apply sequential transformations.

**Single Transformation:**

Remove DOI prefix:
```bash
--transform-filename="/^10\\.\\d+__//"
```

Replace underscores with hyphens:
```bash
--transform-filename="/__/-/"  # Note: replaces first match only
```

**Multiple Transformations:**

Transformations are applied sequentially in the order specified:

```bash
# First remove DOI prefix, then replace underscores with hyphens
--transform-filename="/^10\\.\\d+__//" --transform-filename="/__/-/"

# Example: 10.1111__test_file.pdf → test_file.pdf → test-file.pdf
```

**Validation:**
- All transform patterns are validated before export begins
- Invalid patterns raise ValueError with helpful error message
- Regex syntax errors are caught early
- Each transformation is applied to the result of the previous transformation

## CLI Usage

### Basic Examples

Export all gold files:
```bash
uv run python bin/export_files.py export/
```

Export specific collections:
```bash
uv run python bin/export_files.py --collections=corpus1,corpus2 export/
```

Export with versions:
```bash
uv run python bin/export_files.py --versions export/
```

### Advanced Examples

Export only grobid variants:
```bash
uv run python bin/export_files.py --variants="grobid*" export/
```

Group by collection:
```bash
uv run python bin/export_files.py --group-by=collection export/
```

Filter by regex and transform filenames:
```bash
uv run python bin/export_files.py \
  --regex="^10\\.1111" \
  --transform-filename="/^10\\.1111__//" \
  export/
```

Multiple sequential transformations:
```bash
uv run python bin/export_files.py \
  --transform-filename="/^10\\.\\d+__//" \
  --transform-filename="/__/-/" \
  export/
```

Dry run (preview without exporting):
```bash
uv run python bin/export_files.py --dry-run export/
```

## Integration with Import Workflow

The export system is designed to mirror the import system:

1. **Round-Trip Compatibility:**
   - Files exported with standard grouping can be re-imported
   - Filename encoding is reversible
   - Metadata is preserved in database

2. **Migration Support:**
   - Legacy encoding can be decoded for migration
   - New exports use modern encoding scheme
   - Gradual migration path supported

3. **Workflow:**
   ```
   Original Files → Import → Hash Storage + SQLite → Export → Human-Readable Files
   ```

## Implementation Details

### Atomic File Writes

All file writes use atomic operations:
1. Write to temporary file (`.tmp` suffix)
2. Rename to final destination
3. Clean up temp file on error

This prevents partial writes and ensures filesystem consistency.

### Error Handling

Errors are collected during export and reported at the end:
- Individual file errors don't stop the export
- All errors are logged with file ID and error message
- Exit code 1 if any errors occurred

### Performance Considerations

- Files are read from storage once per export location
- Multi-collection files may be read multiple times (once per collection)
- Atomic writes ensure safety at slight performance cost
- No caching between exports (each export is independent)

## Testing

### Unit Tests

**DOI Utils Tests** ([tests/unit/fastapi/test_doi_utils.py](../../tests/unit/fastapi/test_doi_utils.py)):
- Encoding/decoding round-trips
- Special character handling
- Legacy format compatibility
- Error cases

**File Exporter Tests** ([tests/unit/fastapi/test_file_exporter.py](../../tests/unit/fastapi/test_file_exporter.py)):
- All grouping strategies
- Filtering (collections, variants, regex)
- Filename construction
- Multi-collection duplication
- Transform validation and application
- Dry-run mode

### Running Tests

```bash
# Run all export-related tests
npm run test:unit:fastapi -- tests/unit/fastapi/test_doi_utils.py
npm run test:unit:fastapi -- tests/unit/fastapi/test_file_exporter.py

# Run specific test
npm run test:unit:fastapi -- tests/unit/fastapi/test_file_exporter.py::TestFileExporter::test_group_by_collection
```

## Future Enhancements

Potential improvements for future versions:

1. **Parallel Export:**
   - Multi-threaded export for large datasets
   - Progress reporting during export

2. **Incremental Export:**
   - Track last export timestamp
   - Only export changed/new files

3. **Custom Grouping:**
   - User-defined grouping strategies
   - Template-based directory structure

4. **Metadata Export:**
   - Optional JSON sidecar files with full metadata
   - CSV index of exported files

5. **Compression:**
   - Optional ZIP/tar.gz archive creation
   - Per-collection or per-variant archives

## Recent Fixes

### Variant Extraction for Non-GROBID Extractors (2025-10-30)

**Issue**: The variant extraction in [fastapi_app/lib/tei_utils.py](../../fastapi_app/lib/tei_utils.py) was hardcoded to only extract variants from GROBID application metadata. This caused TEI files from other extractors (like llamore) to have `variant=NULL` in the database, even though their TEI headers contained variant information.

**Fix**: Updated `extract_tei_metadata()` to search for variant-id labels in any extractor application (not just GROBID):

```python
# Before (GROBID-specific)
grobid_app = tei_root.find('.//tei:application[@ident="GROBID"]', ns)
if grobid_app is not None:
    variant_label = grobid_app.find('tei:label[@type="variant-id"]', ns)

# After (any extractor)
variant_label = tei_root.find('.//tei:application[@type="extractor"]/tei:label[@type="variant-id"]', ns)
```

This now correctly extracts variants from:
- GROBID: `grobid.training.segmentation`
- llamore: `llamore-default`
- Any future extractors following the TEI application metadata structure

**Impact**: Existing files in the database may still have NULL variants. To populate missing variants, re-import files using [bin/import_files.py](../../bin/import_files.py).

### Import CLI Syntax Update (2025-10-30)

The import script now accepts the directory as a positional argument instead of requiring `--directory`:

```bash
# New syntax (positional argument)
python bin/import_files.py /path/to/files --collection corpus1

# Old syntax (deprecated)
python bin/import_files.py --directory /path/to/files --collection corpus1
```

### Version Numbering and Gold Status Fix (2025-10-30)

**Critical Behavior Change**: Fixed importer and exporter to correctly handle version numbering and gold status.

**Importer Changes**:
- Version numbers now increment sequentially (0, 1, 2...) for each file with the same `(doc_id, variant)` pair
- Version numbering is independent of gold status
- Gold status is determined solely by directory structure (files in the "tei" or configured gold directory)
- **WARNING (Phase 10)**: Directory-based gold detection can lead to inconsistent state if no file in a variant is marked as gold. This needs replacement with explicit metadata-based marking before Phase 10.

**Exporter Changes**:
- Export based on `is_gold_standard` flag, not `version` number
- Gold files (is_gold_standard=1) export to `tei/` directory
- Non-gold files (is_gold_standard=0) export to `versions/` directory when `--versions` flag is used
- **Inconsistent State Handling**: If a (doc_id, variant) has no gold file, the exporter automatically promotes the most recent non-gold file (highest version number) to act as gold for export purposes, with a warning logged

**Example Database State**:
```
doc_id="10.1234/test", variant="grobid.training.segmentation":
  - version=0, is_gold_standard=1  → Exported to: tei/10.1234__test.grobid.training.segmentation.tei.xml
  - version=1, is_gold_standard=0  → Exported to: versions/10.1234__test.grobid.training.segmentation-v1.tei.xml
  - version=2, is_gold_standard=0  → Exported to: versions/10.1234__test.grobid.training.segmentation-v2.tei.xml

doc_id="10.1234/test", variant="llamore-default":
  - version=0, is_gold_standard=1  → Exported to: tei/10.1234__test.llamore-default.tei.xml
```

## See Also

- [File Import Implementation](database-config-setup.md#file-import)
- [Hash-Sharded Storage](phase-1-core-library.md#file-storage)
- [SQLite Metadata](phase-2-sqlite-metadata.md)
- [DOI Metadata Utilities](../../fastapi_app/lib/doi_utils.py)
