# Database Schema Design

## Overview

The FastAPI migration uses a document-centric SQLite database with hash-sharded file storage.

**Key Innovation**: Multi-collection support - documents can belong to multiple collections simultaneously.

## Database Schema

### Files Table

```sql
-- Main files table
-- Each file is stored once by content hash, linked to documents via doc_id
CREATE TABLE files (
    id TEXT PRIMARY KEY,               -- Content hash (SHA-256) - physical file identifier
    filename TEXT NOT NULL,            -- Stored filename: {hash}{extension}

    -- Document identifier (groups related files: PDF + TEI versions)
    doc_id TEXT NOT NULL,              -- Document identifier (DOI, custom ID, etc.)
    doc_id_type TEXT DEFAULT 'doi',    -- Type of identifier: 'doi', 'custom', 'isbn', 'arxiv', etc.

    -- File properties
    file_type TEXT NOT NULL,           -- 'pdf', 'tei', 'rng' (determines file extension)
    mime_type TEXT,
    file_size INTEGER,

    -- File-specific metadata (TEI files only)
    label TEXT,                        -- User-assigned label (can override doc_metadata.title)
    variant TEXT,                      -- Variant identifier (TEI files only, NULL for PDF)

    -- Version management (TEI files only)
    version INTEGER DEFAULT 1,         -- Version number for TEI files (NULL for PDF)
    is_gold_standard BOOLEAN DEFAULT 0,-- Mark as gold standard/reference version

    -- Synchronization tracking (see phase-6-completion.md for details)
    deleted BOOLEAN DEFAULT 0,         -- Soft delete marker (for sync, filter with WHERE deleted = 0)
    local_modified_at TIMESTAMP,       -- When local file last changed (triggers sync)
    remote_version INTEGER,            -- Remote version when last synced
    sync_status TEXT DEFAULT 'synced', -- 'synced', 'modified', 'pending_upload', 'pending_delete', 'conflict'
    sync_hash TEXT,                    -- Content hash at last sync (for conflict detection)

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Document-level metadata (populated only for PDF files, inherited by TEI files)
    -- NULL for TEI files - use JOIN to get from PDF when needed
    doc_collections TEXT,              -- JSON array: ["corpus1", "corpus2"] (PDF only)
    doc_metadata TEXT,                 -- JSON object: {author, title, date, doi, ...} (PDF only)

    -- File-specific metadata (extraction method, custom fields, etc.)
    file_metadata TEXT                 -- JSON object: {extraction_method: "grobid", ...}
);

-- Indexes for efficient queries
CREATE INDEX idx_doc_id ON files(doc_id);                    -- Find all files for a document
CREATE INDEX idx_doc_id_type ON files(doc_id, file_type);    -- Find PDF or latest TEI for a doc
CREATE INDEX idx_file_type ON files(file_type);              -- Filter by type
CREATE INDEX idx_variant ON files(variant);                  -- Filter by variant (TEI files)
CREATE INDEX idx_created_at ON files(created_at DESC);       -- Recent files
CREATE INDEX idx_is_gold ON files(is_gold_standard) WHERE is_gold_standard = 1;  -- Gold standards

-- Sync-related indexes (see phase-6-completion.md)
CREATE INDEX idx_sync_status ON files(sync_status) WHERE sync_status != 'synced';  -- Files needing sync
CREATE INDEX idx_deleted ON files(deleted) WHERE deleted = 1;                       -- Soft-deleted files
CREATE INDEX idx_local_modified ON files(local_modified_at DESC);                   -- Recent changes
CREATE INDEX idx_remote_version ON files(remote_version);                           -- Sync version tracking
```

### Sync Metadata Table

Tracks global synchronization state (see [phase-6-completion.md](phase-6-completion.md) for usage):

```sql
CREATE TABLE sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Initial sync state
INSERT INTO sync_metadata (key, value) VALUES
    ('last_sync_time', '1970-01-01T00:00:00Z'),
    ('remote_version', '0'),
    ('sync_in_progress', '0'),
    ('last_sync_summary', '{}');
```

## Design Rationale

### 1. Document-Centric Model

- `doc_id` is the primary organizing principle
- One document → multiple files (PDF + TEI versions + gold)
- No `file_relations` table needed - query by `doc_id`

### 2. Content-Addressable Storage

- `id` = SHA-256 hash of file content
- Automatic deduplication (same content = one file)
- `filename` derived from hash + file_type

### 3. File Type → Extension Mapping

| file_type | Extension |
|-----------|-----------|
| `'pdf'`   | `.pdf` |
| `'tei'`   | `.tei.xml` |
| `'rng'`   | `.rng` |

**Never** use `'gold'` as file_type - it's a boolean flag.

### 4. Metadata Inheritance

**PDF files** store document metadata:
- `doc_collections`: `["corpus1", "corpus2"]`
- `doc_metadata`: `{author, title, date, doi, journal, ...}`
- `file_metadata`: `{uploaded_by, source, ...}`

**TEI files** have these NULL:
- Inherit via JOIN when needed
- Store only file-specific data: `{extraction_method, edited_by, ...}`

**Benefits**:
- No redundancy
- Update metadata once (on PDF)
- Clear separation of concerns

### 5. Multi-Collection Support

**Major upgrade from old system:**

Old system: One file → One collection
New system: One document → Multiple collections

```json
{
  "doc_collections": ["main_corpus", "gold_subset", "2024_batch"]
}
```

Query documents in a collection:
```sql
SELECT DISTINCT doc_id, doc_metadata
FROM files
WHERE file_type = 'pdf'
  AND json_extract(doc_collections, '$') LIKE '%gold_subset%';
```

### 6. Variant Support

- Only TEI files can have `variant`
- Allows multiple extraction methods per document
- Example: grobid variant vs cermine variant

### 7. Flexible Identifiers

`doc_id_type` supports:
- `'doi'` - Digital Object Identifier
- `'custom'` - User-generated
- `'isbn'` - Books
- `'arxiv'` - Papers
- Future: any system

## File Storage

### Git-Style Hash Sharding

```
fastapi/data/
├── ab/
│   ├── abcdef123456789....pdf
│   └── ab9876543210fed....tei.xml
├── cd/
│   ├── cdef123456789abc....pdf
│   └── cd9876543210fed....tei.xml
└── ef/
    └── ef123456789abcdef....rng
```

**Pattern**: `{hash[:2]}/{hash}{extension}`

**Why?**
- Most filesystems slow with >10k files per directory
- 256 possible shard directories (00-ff)
- ~390 files per shard with 100k total files
- Git uses this successfully for millions of objects

## Example Data

### Complete Document Example

```sql
-- Document: Research paper with DOI
-- Collections: main_corpus, gold_subset, 2024_batch
-- Files: 1 PDF + 2 TEI versions (one variant) + 1 gold standard

-- PDF (contains all document metadata)
INSERT INTO files (
    id, filename, doc_id, doc_id_type,
    file_type, mime_type, file_size,
    label, variant, version, is_gold_standard,
    doc_collections, doc_metadata, file_metadata
) VALUES (
    'abc123def456...', 'abc123def456....pdf',
    '10.1234/paper.2024', 'doi',
    'pdf', 'application/pdf', 1234567,
    NULL, NULL, NULL, 0,
    '["main_corpus", "gold_subset", "2024_batch"]',
    '{"author": "Smith et al", "title": "Important Research", "date": "2024", "doi": "10.1234/paper.2024", "journal": "Nature"}',
    '{"uploaded_by": "admin", "source": "publisher"}'
);

-- TEI version 1 (grobid extraction)
INSERT INTO files (
    id, filename, doc_id, doc_id_type,
    file_type, mime_type, file_size,
    label, variant, version, is_gold_standard,
    doc_collections, doc_metadata, file_metadata
) VALUES (
    'def456ghi789...', 'def456ghi789....tei.xml',
    '10.1234/paper.2024', 'doi',
    'tei', 'application/xml', 45678,
    NULL, NULL, 1, 0,
    NULL, NULL,
    '{"extraction_method": "grobid", "extraction_date": "2024-01-15"}'
);

-- TEI variant (cermine extraction)
INSERT INTO files (
    id, filename, doc_id, doc_id_type,
    file_type, mime_type, file_size,
    label, variant, version, is_gold_standard,
    doc_collections, doc_metadata, file_metadata
) VALUES (
    'ghi789jkl012...', 'ghi789jkl012....tei.xml',
    '10.1234/paper.2024', 'doi',
    'tei', 'application/xml', 47123,
    NULL, 'cermine', 1, 0,
    NULL, NULL,
    '{"extraction_method": "cermine", "extraction_date": "2024-01-15"}'
);

-- TEI version 2 (user-edited)
INSERT INTO files (
    id, filename, doc_id, doc_id_type,
    file_type, mime_type, file_size,
    label, variant, version, is_gold_standard,
    doc_collections, doc_metadata, file_metadata
) VALUES (
    'jkl012mno345...', 'jkl012mno345....tei.xml',
    '10.1234/paper.2024', 'doi',
    'tei', 'application/xml', 46012,
    'Corrected version', NULL, 2, 0,
    NULL, NULL,
    '{"based_on": "def456ghi789...", "edited_by": "admin", "edit_date": "2024-02-01"}'
);

-- Gold standard (manually verified)
INSERT INTO files (
    id, filename, doc_id, doc_id_type,
    file_type, mime_type, file_size,
    label, variant, version, is_gold_standard,
    doc_collections, doc_metadata, file_metadata
) VALUES (
    'mno345pqr678...', 'mno345pqr678....tei.xml',
    '10.1234/paper.2024', 'doi',
    'tei', 'application/xml', 46200,
    'Gold standard', NULL, NULL, 1,
    NULL, NULL,
    '{"verified_by": "expert", "verification_date": "2024-03-01", "notes": "Double-checked all entities"}'
);
```

## Common Queries

**Important**: Always filter `deleted = 0` in queries to exclude soft-deleted files.

### Get all files for a document

```sql
SELECT * FROM files
WHERE doc_id = '10.1234/paper.2024'
  AND deleted = 0;
-- Returns: 5 rows (PDF + 4 TEI files)
```

### Get latest TEI version (excluding gold and variants)

```sql
SELECT * FROM files
WHERE doc_id = '10.1234/paper.2024'
  AND file_type = 'tei'
  AND variant IS NULL
  AND is_gold_standard = 0
  AND deleted = 0
ORDER BY version DESC LIMIT 1;
-- Returns: Version 2
```

### Get PDF with document metadata

```sql
SELECT id, filename, file_type, doc_collections, doc_metadata
FROM files
WHERE doc_id = '10.1234/paper.2024'
  AND file_type = 'pdf'
  AND deleted = 0;
```

### Get TEI file with inherited document metadata

```sql
SELECT
    tei.*,
    COALESCE(tei.label, json_extract(pdf.doc_metadata, '$.title')) as display_title,
    pdf.doc_metadata,
    pdf.doc_collections
FROM files tei
LEFT JOIN files pdf ON tei.doc_id = pdf.doc_id AND pdf.file_type = 'pdf' AND pdf.deleted = 0
WHERE tei.id = 'def456ghi789...'
  AND tei.deleted = 0;
```

### Get gold standard

```sql
SELECT * FROM files
WHERE doc_id = '10.1234/paper.2024'
  AND is_gold_standard = 1
  AND deleted = 0;
```

### Filter documents by collection

```sql
SELECT DISTINCT doc_id, doc_metadata
FROM files
WHERE file_type = 'pdf'
  AND json_extract(doc_collections, '$') LIKE '%gold_subset%'
  AND deleted = 0;
```

### Get all variants for a document

```sql
SELECT id, variant, file_metadata
FROM files
WHERE doc_id = '10.1234/paper.2024'
  AND file_type = 'tei'
  AND variant IS NOT NULL
  AND deleted = 0;
```

### Sync-specific queries

See [phase-6-completion.md](phase-6-completion.md) for complete sync implementation.

```sql
-- Get files needing sync
SELECT * FROM files
WHERE sync_status != 'synced'
   OR deleted = 1;  -- Include deleted files for sync

-- Get soft-deleted files
SELECT * FROM files WHERE deleted = 1;

-- Check if sync needed (instant O(1) query)
SELECT COUNT(*) FROM files
WHERE sync_status != 'synced'
   OR local_modified_at > (SELECT value FROM sync_metadata WHERE key = 'last_sync_time');
```

## Benefits Summary

✅ **No redundancy** - Document metadata stored once
✅ **Multi-collection** - Documents in multiple collections
✅ **Performance** - Indexed queries + hash sharding
✅ **Flexibility** - JSON for extensible metadata
✅ **Deduplication** - Content-addressable storage
✅ **Scalability** - Handles millions of files
✅ **Simple queries** - No mandatory JOINs
