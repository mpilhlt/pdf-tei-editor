# Importing and Exporting Files

This guide explains how to import PDF and TEI/XML files into the PDF-TEI Editor and export them for backup or sharing.

## Overview

The PDF-TEI Editor uses a content-addressable file storage system with SQLite metadata. Files can be imported using the `import_files.py` script, which automatically:

- Detects document IDs from filenames or TEI metadata
- Groups related PDF and TEI files together
- Assigns files to collections
- Identifies gold standard files
- Stores files in hash-sharded storage for deduplication

## Importing Files

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
   from fastapi_app.lib.database import DatabaseManager
   from fastapi_app.lib.file_repository import FileRepository

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

## Related Documentation

- [CLI Reference](cli.md) - Other command-line tools
- [Collection Management](collection-management.md) - Managing collections in the web interface
- [Docker Deployment](docker-deployment.md) - Running in Docker
- [Development: Database](../development/database.md) - Technical database details
