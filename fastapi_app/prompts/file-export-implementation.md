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

## Export Modes and Filtering

### File Selection

**By Default:**
- Exports all PDF files
- Exports all gold standard TEI files (version IS NULL or is_gold_standard=true with version=1)

**With `--versions` flag:**
- Additionally exports all versioned TEI files (version > 1)

**Collection Filtering (`--collections=corpus1,corpus2`):**
- Exports only files belonging to specified collections
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

The `--translate-filename` option allows sed-style transformations using `/search/replace/` syntax.

**Examples:**

Remove DOI prefix:
```bash
--translate-filename="/^10\\.\\d+__//"
```

Replace underscores with hyphens:
```bash
--translate-filename="/__/-/g"  # Note: 'g' flag not supported, only first match
```

**Validation:**
- Transform pattern is validated before export begins
- Invalid patterns raise ValueError with helpful error message
- Regex syntax errors are caught early

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
  --translate-filename="/^10\\.1111__//" \
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

## See Also

- [File Import Implementation](database-config-setup.md#file-import)
- [Hash-Sharded Storage](phase-1-core-library.md#file-storage)
- [SQLite Metadata](phase-2-sqlite-metadata.md)
- [DOI Metadata Utilities](../../fastapi_app/lib/doi_utils.py)
