# Importing and Exporting Files

This guide explains how to import PDF and TEI/XML files into the PDF-TEI Editor and export them for backup or sharing.

## Overview

The PDF-TEI Editor uses a content-addressable file storage system with SQLite metadata. Files can be imported and exported in two ways:

1. **Web Interface** - Buttons in the file selection drawer
2. **Command Line** - Python scripts for batch operations and automation

## Using the Web Interface

### Exporting Files

The export feature allows you to download collections as ZIP archives directly from the web interface:

1. **Open the File Selection Drawer**
   - Click the <sl-icon name="list"></sl-icon> icon in the toolbar

2. **Select Collections to Export**
   - Check the collections you want to export
   - Use "Select all/none" to quickly select or deselect all collections

3. **Filter by Variant (Optional)**
   - Use the variant dropdown to filter which TEI files to export
   - When a variant is selected, only PDFs with matching TEI files of that variant are exported

4. **Click Export**
   - The Export button is enabled when at least one collection is selected
   - Click to download a ZIP file containing your selected collections
   - Files are organized by collection and type (PDF/TEI)

**Export Behavior:**

- Only exports **PDF-TEI pairs** where both files exist
- Only exports **gold standard** TEI files by default (no versions)
- When variant filter is applied, only exports PDFs that have a matching TEI file with that variant
- Files are organized in the ZIP with collection-based grouping:
  ```
  export.zip
  ├── collection1/
  │   ├── pdf/
  │   │   └── document.pdf
  │   └── tei/
  │       └── document.tei.xml
  └── collection2/
      └── ...
  ```

### Importing Files via UI

The import feature allows you to upload ZIP archives containing PDF and TEI files:

1. **Open the File Selection Drawer**
   - Click the folder icon in the toolbar

2. **Click Import**
   - Located next to the Export button in the drawer footer
   - Opens a file selection dialog

3. **Select ZIP Archive**
   - Choose a ZIP file from your computer
   - The ZIP should contain files in one of these structures:
     - Type-grouped: `pdf/`, `tei/`, `versions/`
     - Collection-grouped: `collection1/pdf/`, `collection1/tei/` or `collection1/file1.pdf`
     - Variant-grouped: `pdf/`, `grobid-0.8.1/`

4. **Wait for Upload**
   - Progress indicator shows during upload and import
   - Files are automatically imported and assigned to collections
   - Collections are created automatically if they don't exist

5. **View Results**
   - Success notification shows number of files imported
   - File tree refreshes automatically to show new files
   - Any errors are displayed in the notification

**Import Behavior:**

- Collections are automatically created from directory structure
- Files are deduplicated using content hashing
- Metadata is extracted from filenames and TEI content
- Files are validated before import
- metadata files are automatically filtered out

## Command Line Tools

The PDF-TEI Editor provides command-line scripts for automated batch operations. Files can be imported using the `import_files.py` script, which automatically:

- Detects document IDs from filenames or TEI metadata
- Groups related PDF and TEI files together
- Assigns files to collections
- Identifies gold standard files
- Stores files in hash-sharded storage for deduplication

## Importing Files with CLI

### Basic Import

Import files from a directory:

```bash
python bin/import_files.py /path/to/files
```

Import with collection assignment:

```bash
python bin/import_files.py /path/to/files --collection my_collection
```

### Preview Without Importing (Dry Run)

Preview what would be imported without making changes:

```bash
python bin/import_files.py /path/to/files --dry-run
```

### Recursive Import

By default, the importer scans subdirectories. To import only from the root directory:

```bash
python bin/import_files.py /path/to/files --no-recursive
```

## Collection Management

### Manual Collection Assignment

Assign all imported files to a single collection:

```bash
python bin/import_files.py /path/to/files --collection corpus1
```

### Automatic Collection Assignment

Use subdirectory names as collection names:

```bash
python bin/import_files.py /path/to/data --recursive-collections
```

**Directory structure example:**

```
/path/to/data/
├── corpus1/
│   ├── doc1.pdf
│   └── doc1.tei.xml
├── corpus2/
│   ├── doc2.pdf
│   └── doc2.tei.xml
└── root-file.pdf
```

**Result:**

- Files in `corpus1/` → collection "corpus1"
- Files in `corpus2/` → collection "corpus2"
- Files in root → no collection

### Skipping Organizational Directories

The importer skips certain directory names when determining collections:

```bash
python bin/import_files.py /path/to/data --recursive-collections \
  --skip-dirs pdf tei versions version
```

**Directory structure example:**

```
/path/to/data/
└── corpus1/
    ├── pdf/
    │   └── doc1.pdf
    └── tei/
        └── doc1.tei.xml
```

**Result:** Both files get collection "corpus1" (not "pdf" or "tei")

## Gold Standard Detection

Gold standard files are reference versions used for comparison and validation.

### Version Marker Detection (Default)

By default, files **without** a `.vN.` version marker are treated as gold standard:

```bash
python bin/import_files.py /path/to/files
```

**Filename examples:**

```
/path/to/files/
├── doc1.pdf
├── doc1.tei.xml              # Gold (no version marker)
├── doc1.grobid.tei.xml       # Gold with variant (no version marker)
├── doc1.v1.tei.xml           # Version 1 (not gold)
└── doc1.grobid.v2.tei.xml    # Version 2 with variant (not gold)
```

**Version pattern:** The default pattern `\.v\d+\.` matches `.v1.`, `.v2.`, etc. Files with this pattern are NOT gold.

### Custom Version Pattern

Use a custom pattern to identify versions:

```bash
python bin/import_files.py /path/to/files --version-pattern '\.version\d+\.'
```

This would match `.version1.`, `.version2.`, etc.

### Legacy: Pattern-Based Gold Detection

For backward compatibility with legacy imports, you can still use pattern-based gold detection:

```bash
python bin/import_files.py /path/to/files --gold-pattern '\.gold\.'
```

**Filename examples:**

- `doc1.gold.tei.xml` → Marked as gold, pattern stripped for matching
- `doc1.tei.xml` → Not gold (no pattern match)

**Common patterns:**

```bash
# Files with .gold. in name
python bin/import_files.py /path/to/files --gold-pattern '\.gold\.'

# Files in 'tei' directory
python bin/import_files.py /path/to/files --gold-dir-name tei
```

**Important:** When `--gold-pattern` is provided, it overrides the default version marker detection.

## File Organization

### Expected File Naming

The importer uses intelligent filename matching to group related files:

**PDF files:**

- `10.1234_article.pdf`
- `article.pdf`

**TEI files:**

- `10.1234_article.tei.xml` (gold - no version marker)
- `10.1234_article.grobid.tei.xml` (gold with variant)
- `article.v1.tei.xml` (version 1)
- `article.grobid.v2.tei.xml` (version 2 with variant)

### Document ID Resolution

Document IDs are resolved in this order:

1. **DOI from TEI metadata** (highest priority)

   ```xml
   <idno type="DOI">10.1234/article</idno>
   ```

2. **Filename-based ID**
   - `10.1234_article.pdf` → doc_id: `10.1234/article`
   - Pattern: underscores converted to slashes for DOI-like IDs

3. **Custom ID from filename**
   - `my_document.pdf` → doc_id: `my_document`

### Variant Detection

TEI files can specify variants in metadata:

```xml
<edition>grobid-0.8.1</edition>
```

Files with different variants are tracked separately under the same document ID.

## Database Management

### Custom Database Location

Specify a custom database path:

```bash
python bin/import_files.py /path/to/files \
  --db-path /custom/path/metadata.db \
  --storage-root /custom/path/storage
```

### Clearing Existing Data

Clear all existing data before importing:

```bash
python bin/import_files.py /path/to/files --clean
```

**Warning:** This deletes all existing files and metadata. Use with caution.

## Advanced Options

### Verbose Logging

Enable detailed logging for debugging:

```bash
python bin/import_files.py /path/to/files --verbose
```

### Complete Example

Import files with all options:

```bash
python bin/import_files.py /path/to/data \
  --recursive-collections \
  --skip-dirs pdf tei versions \
  --gold-pattern '\.gold\.' \
  --db-path ./data/db/metadata.db \
  --storage-root ./data/files \
  --verbose
```

## Exporting Files

### Export from Storage

Files are stored in content-addressable storage using SHA-256 hashes. To export:

1. **Query the database** to find file metadata:

   ```python
   from fastapi_app.lib.core.database import DatabaseManager
   from fastapi_app.lib.repository.file_repository import FileRepository

   db = DatabaseManager("data/db/metadata.db")
   repo = FileRepository(db)
   files = repo.list_files()

   for f in files:
       print(f"{f.id}: {f.filename} (doc_id: {f.doc_id})")
   ```

2. **Retrieve files** from hash-sharded storage:

   ```
   data/files/{first-2-chars}/{next-2-chars}/{hash}.{extension}
   ```

   Example: `data/files/a1/b2/a1b2c3d4...xyz.pdf`

### Backup Strategy

**Full backup:**

```bash
# Backup both database and storage
tar -czf backup.tar.gz data/db/metadata.db data/files/
```

**Database-only backup:**

```bash
# Backup just the metadata
cp data/db/metadata.db backup/metadata.db
```

**Selective export:**

Use the API or database queries to export specific collections or documents.

## Troubleshooting

### Files Not Importing

**Check file extensions:**

- PDFs must have `.pdf` extension
- TEI files must have `.xml` extension

**Check file permissions:**

```bash
ls -la /path/to/files
```

**Use dry-run mode:**

```bash
python bin/import_files.py /path/to/files --dry-run --verbose
```

### Duplicate Files Skipped

The system uses content hashing for deduplication. Identical file content results in the same hash, so duplicates are automatically skipped. This is expected behavior.

### Gold Files Not Detected

**Verify directory structure:**

```bash
find /path/to/files -name "*.xml" -type f
```

**Check gold pattern:**

```bash
# Test pattern with verbose logging
python bin/import_files.py /path/to/files \
  --gold-pattern '\.gold\.' \
  --dry-run \
  --verbose
```

### Collection Not Assigned

**With `--recursive-collections`:**

- Ensure files are in subdirectories
- Check `--skip-dirs` isn't excluding your directory names

**Without `--recursive-collections`:**

- Use `--collection` to manually assign collections

### Performance Optimization

**For large imports:**

1. Use `--no-recursive` if you don't need subdirectories
2. Import in smaller batches
3. Use SSD storage for better I/O performance
4. Ensure sufficient disk space (files are duplicated in storage)

## Integration with Docker

When using Docker, mount your data directory:

```bash
docker run -v /path/to/data:/data/import \
  pdf-tei-editor \
  python bin/import_files.py /data/import --recursive-collections
```

See [Docker Deployment](docker-deployment.md) for details.

## Best Practices

### Organizing Source Files

**Recommended structure:**

```
source-data/
├── collection1/
│   ├── pdf/
│   │   └── *.pdf
│   └── tei/
│       └── *.tei.xml (gold standard)
├── collection2/
│   ├── pdf/
│   │   └── *.pdf
│   └── tei/
│       └── *.tei.xml (gold standard)
```

**Import command:**

```bash
python bin/import_files.py source-data \
  --recursive-collections \
  --skip-dirs pdf tei
```

### Validation Before Import

**Check file structure:**

```bash
# List all PDF files
find /path/to/files -name "*.pdf" -type f

# List all TEI files
find /path/to/files -name "*.xml" -type f

# Count files
echo "PDFs: $(find /path/to/files -name '*.pdf' | wc -l)"
echo "TEIs: $(find /path/to/files -name '*.xml' | wc -l)"
```

**Validate TEI files:**

```bash
# Check for valid XML (requires xmllint)
find /path/to/files -name "*.xml" -exec xmllint --noout {} \;
```

## API Endpoints

### Export Endpoint

Files can be exported programmatically via the REST API at `/api/v1/export`.

**Endpoint:** `GET /api/v1/export`

**Authentication:** Requires valid session ID via query parameter `?sessionId=xxx`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | **Required.** Session ID for authentication |
| `collections` | string | Comma-separated list of collections to export (e.g., `corpus1,corpus2`). If not specified, exports all collections the user has access to |
| `variants` | string | Comma-separated list of variants to export. Supports glob patterns (e.g., `grobid*`) |
| `include_versions` | boolean | Include versioned TEI files (default: `false`) |
| `group_by` | string | Directory grouping strategy: `collection` (default), `type`, or `variant` |

**Access Control:**

- Only collections the user has access to are exported
- Admin users have access to all collections
- Regular users are limited by their group memberships

**Response:**

Returns a ZIP file as an HTTP attachment (`application/zip`) with the filename `export.zip`.

**Grouping Strategies:**

- `collection` (default): Groups files by collection name

  ```text
  export.zip
  ├── corpus1/
  │   ├── pdf/
  │   │   └── document.pdf
  │   └── tei/
  │       └── document.tei.xml
  └── corpus2/
      └── ...
  ```

- `type`: Groups files by file type

  ```text
  export.zip
  ├── pdf/
  │   └── document.pdf
  ├── tei/
  │   └── document.tei.xml
  └── versions/
      └── document.v1.tei.xml
  ```

- `variant`: Groups TEI files by variant name

  ```text
  export.zip
  ├── pdf/
  │   └── document.pdf
  ├── grobid-0.8.1/
  │   └── document.tei.xml
  └── metatei/
      └── document.tei.xml
  ```

**Example Usage:**

Export all accessible collections:

```bash
curl -O "http://localhost:8000/api/v1/export?sessionId=YOUR_SESSION_ID"
```

Export specific collections:

```bash
curl -O "http://localhost:8000/api/v1/export?sessionId=YOUR_SESSION_ID&collections=corpus1,corpus2"
```

Export with type-based grouping:

```bash
curl -O "http://localhost:8000/api/v1/export?sessionId=YOUR_SESSION_ID&group_by=type"
```

Export grobid variants only:

```bash
curl -O "http://localhost:8000/api/v1/export?sessionId=YOUR_SESSION_ID&variants=grobid*"
```

Export including all versions:

```bash
curl -O "http://localhost:8000/api/v1/export?sessionId=YOUR_SESSION_ID&include_versions=true"
```

**Error Responses:**

- `401 Unauthorized`: No valid session provided
- `403 Forbidden`: User has no access to any requested collections
- `400 Bad Request`: Invalid parameters (e.g., invalid `group_by` value)
- `500 Internal Server Error`: Export failed due to server error

### Import Endpoint

*Coming soon* - API endpoint for programmatic file import

## Related Documentation

- [CLI Reference](cli.md) - Other command-line tools
- [Collection Management](collection-management.md) - Managing collections in the web interface
- [Docker Deployment](docker-deployment.md) - Running in Docker
- [Development: Database](../development/database.md) - Technical database details
