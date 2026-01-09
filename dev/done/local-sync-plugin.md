# Local Sync Plugin Implementation Plan

## Overview

Backend plugin that synchronizes TEI documents between a collection and a local filesystem directory, handling bidirectional sync with conflict resolution based on document timestamps.

## Configuration

### Environment Variables & Config Keys

- `PLUGIN_LOCAL_SYNC_ENABLED` / `plugin.local-sync.enabled` (boolean, default: false)
- `PLUGIN_LOCAL_SYNC_REPO_PATH` / `plugin.local-sync.repo.path` (string, path to sync directory)
- `PLUGIN_LOCAL_SYNC_BACKUP` / `plugin.local-sync.backup` (boolean, default: true)

The plugin is only active and visible if it is enabled, the user has the "reviewer" role, and a repo path is specified.

### Configuration Priority

Configuration values in `data/db/config.json` override environment variables. If config keys don't exist, they are created from environment variables on first access.

### Generic Configuration Utilities

Add to `fastapi_app/lib/plugin_tools.py`:

```python
def get_plugin_config(
    config_key: str,
    env_var: str,
    default: Any = None,
    value_type: str = "string"
) -> Any:
    """
    Get plugin configuration value with env var fallback.

    Priority: config.json > environment variable > default
    Creates config key from env var if it doesn't exist.

    Args:
        config_key: Dot-notation config key (e.g., "plugin.local-sync.enabled")
        env_var: Environment variable name
        default: Default value if neither source has value
        value_type: Type for validation ("string", "boolean", "number", "array")

    Returns:
        Configuration value
    """
    from fastapi_app.lib.config_utils import get_config
    import os

    config = get_config()

    # Try to get from config
    value = config.get(config_key)

    if value is None:
        # Check environment variable
        env_value = os.environ.get(env_var)

        if env_value is not None:
            # Parse env value based on type
            if value_type == "boolean":
                value = env_value.lower() in ("true", "1", "yes")
            elif value_type == "number":
                value = int(env_value) if env_value.isdigit() else float(env_value)
            elif value_type == "array":
                import json
                value = json.loads(env_value)
            else:
                value = env_value

            # Create config key from env var
            config.set(config_key, value)
        else:
            # Use default
            value = default
            if value is not None:
                config.set(config_key, value)

    return value
```

## Plugin Structure

### Directory Layout

```
fastapi_app/plugins/local_sync/
├── __init__.py          # Plugin registration
├── plugin.py            # Main plugin class
├── routes.py            # Custom routes (optional if needed for detailed results)
└── tests/
    └── test_plugin.py   # Unit tests
```

## Plugin Metadata

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "local-sync",
        "name": "Local Sync",
        "description": "Synchronize collection documents with local filesystem",
        "category": "sync",
        "version": "1.0.0",
        "required_roles": ["reviewer"],
        "endpoints": [
            {
                "name": "sync",
                "label": "Sync with Local Folder",
                "description": "Synchronize current collection with local filesystem",
                "state_params": ["collection", "variant"]
            }
        ]
    }

@classmethod
def is_available(cls) -> bool:
    """Only available if enabled, repo path configured, and user has reviewer role."""
    from fastapi_app.lib.plugin_tools import get_plugin_config

    # Check if enabled
    enabled = get_plugin_config(
        "plugin.local-sync.enabled",
        "PLUGIN_LOCAL_SYNC_ENABLED",
        default=False,
        value_type="boolean"
    )

    if not enabled:
        return False

    # Check if repo path is configured
    repo_path = get_plugin_config(
        "plugin.local-sync.repo.path",
        "PLUGIN_LOCAL_SYNC_REPO_PATH",
        default=None
    )

    if not repo_path:
        return False

    return True
```

## Implementation Steps

### 1. Configuration Setup

File: `fastapi_app/lib/plugin_tools.py`

- Add `get_plugin_config()` function as defined above
- Document in function docstring

### 2. Plugin Implementation

File: `fastapi_app/plugins/local_sync/plugin.py`

#### Main sync endpoint

```python
async def sync(self, context, params: dict) -> dict:
    """
    Synchronize collection with local filesystem.

    Returns HTML with statistics.
    """
    collection_id = params.get("collection")
    variant = params.get("variant", "all")

    # Get configuration
    repo_path = get_plugin_config("plugin.local-sync.repo.path", "PLUGIN_LOCAL_SYNC_REPO_PATH")
    backup_enabled = get_plugin_config("plugin.local-sync.backup", "PLUGIN_LOCAL_SYNC_BACKUP", True, "boolean")

    if not repo_path:
        return {"html": "<p>Error: Repository path not configured</p>"}

    if not Path(repo_path).exists():
        return {"html": f"<p>Error: Repository path does not exist: {repo_path}</p>"}

    # Run sync
    results = await self._sync_collection(collection_id, variant, repo_path, backup_enabled, context)

    # Generate HTML report
    html = self._generate_report_html(results)

    return {"html": html}
```

#### Core sync logic

```python
async def _sync_collection(
    self,
    collection_id: str,
    variant: str,
    repo_path: str,
    backup_enabled: bool,
    context
) -> dict:
    """
    Perform bidirectional sync between collection and filesystem.

    Returns:
        Dictionary with sync statistics and details
    """
    from fastapi_app.lib.dependencies import get_db, get_file_storage
    from fastapi_app.lib.file_repository import FileRepository
    from fastapi_app.lib.tei_utils import get_annotator_name
    from pathlib import Path
    import hashlib
    from datetime import datetime
    from lxml import etree

    results = {
        "skipped": [],
        "updated_fs": [],
        "updated_collection": [],
        "errors": []
    }

    db = get_db()
    file_repo = FileRepository(db)
    file_storage = get_file_storage()

    # 1. Scan filesystem for TEI files
    fs_docs = self._scan_filesystem(Path(repo_path))

    # 2. Get collection documents
    collection_docs = file_repo.get_files_by_collection(collection_id, file_type="tei")
    if variant != "all":
        collection_docs = [d for d in collection_docs if d.variant == variant]

    # 3. Build lookup maps
    collection_map = {}  # fileref -> (doc, content, hash, timestamp)
    for doc in collection_docs:
        content = file_storage.read_file(doc.id, "tei")
        content_hash = hashlib.sha256(content).hexdigest()
        timestamp = self._extract_timestamp(content)
        fileref = self._extract_fileref(content)
        if fileref:
            collection_map[fileref] = (doc, content, content_hash, timestamp)

    fs_map = {}  # fileref -> (path, content, hash, timestamp)
    for path, content in fs_docs.items():
        content_hash = hashlib.sha256(content).hexdigest()
        timestamp = self._extract_timestamp(content)
        fileref = self._extract_fileref(content)
        if fileref:
            fs_map[fileref] = (path, content, content_hash, timestamp)

    # 4. Compare and sync
    all_refs = set(collection_map.keys()) | set(fs_map.keys())

    for fileref in all_refs:
        try:
            if fileref in collection_map and fileref in fs_map:
                # Both exist - check for differences
                col_doc, col_content, col_hash, col_timestamp = collection_map[fileref]
                fs_path, fs_content, fs_hash, fs_timestamp = fs_map[fileref]

                if col_hash == fs_hash:
                    results["skipped"].append({
                        "fileref": fileref,
                        "reason": "identical"
                    })
                    continue

                # Content differs - check timestamps
                if col_timestamp and fs_timestamp:
                    if col_timestamp > fs_timestamp:
                        # Collection newer - update filesystem
                        self._update_filesystem(fs_path, col_content, backup_enabled)
                        results["updated_fs"].append({
                            "fileref": fileref,
                            "path": str(fs_path),
                            "col_timestamp": col_timestamp,
                            "fs_timestamp": fs_timestamp
                        })
                    elif fs_timestamp > col_timestamp:
                        # Filesystem newer - create new version
                        self._create_new_version(file_repo, file_storage, col_doc, fs_content, context.user)
                        results["updated_collection"].append({
                            "fileref": fileref,
                            "stable_id": col_doc.stable_id,
                            "col_timestamp": col_timestamp,
                            "fs_timestamp": fs_timestamp
                        })
                    else:
                        # Same timestamp but different content - conflict
                        results["errors"].append({
                            "fileref": fileref,
                            "error": "Timestamps identical but content differs"
                        })
                else:
                    results["errors"].append({
                        "fileref": fileref,
                        "error": "Missing timestamp in one or both documents"
                    })

            elif fileref in collection_map:
                # Only in collection - could add to filesystem, but skip for now
                results["skipped"].append({
                    "fileref": fileref,
                    "reason": "only_in_collection"
                })

            else:
                # Only in filesystem - could import, but skip for now
                results["skipped"].append({
                    "fileref": fileref,
                    "reason": "only_in_filesystem"
                })

        except Exception as e:
            results["errors"].append({
                "fileref": fileref,
                "error": str(e)
            })

    return results
```

#### Helper methods

```python
def _scan_filesystem(self, repo_path: Path) -> dict[Path, bytes]:
    """
    Recursively scan directory for *.tei.xml files.

    Returns:
        Dict mapping file paths to content bytes
    """
    docs = {}
    for tei_file in repo_path.rglob("*.tei.xml"):
        if tei_file.is_file():
            docs[tei_file] = tei_file.read_bytes()
    return docs

def _extract_fileref(self, content: bytes) -> str | None:
    """
    Extract fileref from TEI document.

    Path: /TEI/teiHeader/fileDesc/editionStmt/edition/idno[@type='fileref']
    """
    from lxml import etree

    try:
        root = etree.fromstring(content)
        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        fileref_elem = root.xpath(
            "//tei:fileDesc/tei:editionStmt/tei:edition/tei:idno[@type='fileref']",
            namespaces=ns
        )
        if fileref_elem:
            return fileref_elem[0].text
    except Exception:
        pass

    return None

def _extract_timestamp(self, content: bytes) -> str | None:
    """
    Extract timestamp from last revision change.

    Path: /TEI/teiHeader/revisionDesc/change[last()]/@when
    """
    from lxml import etree

    try:
        root = etree.fromstring(content)
        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        changes = root.xpath(
            "//tei:revisionDesc/tei:change",
            namespaces=ns
        )
        if changes:
            last_change = changes[-1]
            return last_change.get("when")
    except Exception:
        pass

    return None

def _update_filesystem(self, fs_path: Path, content: bytes, backup_enabled: bool):
    """
    Update filesystem file with collection content.

    Creates timestamped backup if enabled.
    """
    from datetime import datetime

    if backup_enabled and fs_path.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = fs_path.with_suffix(f".{timestamp}.backup")
        fs_path.rename(backup_path)

    fs_path.write_bytes(content)

def _create_new_version(self, file_repo, file_storage, doc, content: bytes, user):
    """
    Create new annotation version from filesystem content.

    Version name: "Imported at <human-readable date>"
    """
    from datetime import datetime
    from fastapi_app.lib.file_uploader import FileUploader

    # Format current date
    import_date = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    version_name = f"Imported at {import_date}"

    # Create new version using FileUploader
    uploader = FileUploader(file_repo, file_storage)
    uploader.upload_version(
        stable_id=doc.stable_id,
        content=content,
        file_type="tei",
        variant=doc.variant,
        version_name=version_name,
        user=user
    )

def _generate_report_html(self, results: dict) -> str:
    """Generate HTML report with sync statistics."""
    from fastapi_app.lib.plugin_tools import escape_html

    total = len(results["skipped"]) + len(results["updated_fs"]) + len(results["updated_collection"]) + len(results["errors"])

    html_parts = [
        "<div style='font-family: sans-serif; padding: 10px;'>",
        "<h3>Sync Results</h3>",
        f"<p><strong>Total documents processed:</strong> {total}</p>",
        "<ul>",
        f"<li><strong>Skipped (identical):</strong> {len(results['skipped'])}</li>",
        f"<li><strong>Updated filesystem:</strong> {len(results['updated_fs'])}</li>",
        f"<li><strong>Updated collection:</strong> {len(results['updated_collection'])}</li>",
        f"<li><strong>Errors:</strong> {len(results['errors'])}</li>",
        "</ul>"
    ]

    if results["updated_fs"]:
        html_parts.append("<h4>Filesystem Updates</h4><ul>")
        for item in results["updated_fs"]:
            html_parts.append(f"<li>{escape_html(item['fileref'])} - {escape_html(item['path'])}</li>")
        html_parts.append("</ul>")

    if results["updated_collection"]:
        html_parts.append("<h4>Collection Updates</h4><ul>")
        for item in results["updated_collection"]:
            html_parts.append(f"<li>{escape_html(item['fileref'])} - {escape_html(item['stable_id'])}</li>")
        html_parts.append("</ul>")

    if results["errors"]:
        html_parts.append("<h4>Errors</h4><ul>")
        for item in results["errors"]:
            html_parts.append(f"<li>{escape_html(item.get('fileref', 'unknown'))}: {escape_html(item['error'])}</li>")
        html_parts.append("</ul>")

    html_parts.append("</div>")

    return "".join(html_parts)
```

### 3. Plugin Registration

File: `fastapi_app/plugins/local_sync/__init__.py`

```python
from .plugin import LocalSyncPlugin

plugin = LocalSyncPlugin()
```

### 4. Documentation Updates

File: `docs/code-assistant/backend-plugins.md`

Add section after "Conditional Availability":

```markdown
## Plugin Configuration with Environment Variables

Plugins often need configuration that can be set via environment variables or config keys. Use `get_plugin_config()` for consistent configuration handling:

```python
from fastapi_app.lib.plugin_tools import get_plugin_config

# Get configuration with env var fallback
repo_path = get_plugin_config(
    "plugin.local-sync.repo.path",  # Config key
    "PLUGIN_LOCAL_SYNC_REPO_PATH",   # Environment variable
    default="/default/path",          # Default value
    value_type="string"               # Type: string, boolean, number, array
)

enabled = get_plugin_config(
    "plugin.local-sync.enabled",
    "PLUGIN_LOCAL_SYNC_ENABLED",
    default=False,
    value_type="boolean"
)
```

**Priority**: Config file > Environment variable > Default value

**Automatic initialization**: If config key doesn't exist, it's created from environment variable.

**Example - Plugin availability**:

```python
@classmethod
def is_available(cls) -> bool:
    """Only available if enabled in config."""
    return get_plugin_config(
        "plugin.my-plugin.enabled",
        "MY_PLUGIN_ENABLED",
        default=False,
        value_type="boolean"
    )
```
```

### 5. Testing

File: `fastapi_app/plugins/local_sync/tests/test_plugin.py`

```python
"""
Unit tests for Local Sync Plugin.

@testCovers fastapi_app/plugins/local_sync/plugin.py
"""

import unittest
from unittest.mock import Mock, patch, MagicMock
from pathlib import Path
import tempfile
import shutil

class TestLocalSyncPlugin(unittest.TestCase):
    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        """Clean up test fixtures."""
        shutil.rmtree(self.temp_dir)

    def test_scan_filesystem(self):
        """Test filesystem scanning for TEI files."""
        # Create test files
        test_path = Path(self.temp_dir)
        (test_path / "doc1.tei.xml").write_text("<TEI>test1</TEI>")
        (test_path / "subdir").mkdir()
        (test_path / "subdir" / "doc2.tei.xml").write_text("<TEI>test2</TEI>")
        (test_path / "ignore.xml").write_text("<TEI>ignore</TEI>")

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        docs = plugin._scan_filesystem(test_path)

        self.assertEqual(len(docs), 2)
        self.assertTrue(any("doc1.tei.xml" in str(p) for p in docs.keys()))
        self.assertTrue(any("doc2.tei.xml" in str(p) for p in docs.keys()))

    def test_extract_fileref(self):
        """Test fileref extraction from TEI content."""
        tei_content = b"""<?xml version="1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <editionStmt>
                        <edition>
                            <idno type="fileref">test-doc-123</idno>
                        </edition>
                    </editionStmt>
                </fileDesc>
            </teiHeader>
        </TEI>"""

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        fileref = plugin._extract_fileref(tei_content)
        self.assertEqual(fileref, "test-doc-123")

    def test_extract_timestamp(self):
        """Test timestamp extraction from last revision change."""
        tei_content = b"""<?xml version="1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <revisionDesc>
                    <change when="2025-01-01T10:00:00">First change</change>
                    <change when="2025-01-08T15:30:00">Latest change</change>
                </revisionDesc>
            </teiHeader>
        </TEI>"""

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        timestamp = plugin._extract_timestamp(tei_content)
        self.assertEqual(timestamp, "2025-01-08T15:30:00")

    @patch('fastapi_app.plugins.local_sync.plugin.get_plugin_config')
    def test_plugin_availability(self, mock_config):
        """Test plugin is_available respects config."""
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin

        # Test enabled
        mock_config.return_value = True
        self.assertTrue(LocalSyncPlugin.is_available())

        # Test disabled
        mock_config.return_value = False
        self.assertFalse(LocalSyncPlugin.is_available())
```

## Implementation Notes

### File Repository Methods

Use existing methods from `fastapi_app/lib/file_repository.py`:

- `get_files_by_collection(collection_id, file_type="tei")` - Get all TEI files in collection
- File metadata includes: `id` (content hash), `stable_id`, `variant`, `doc_collections`

### File Storage Methods

Use existing methods from `fastapi_app/lib/file_storage.py`:

- `read_file(file_id, file_type)` - Read file content as bytes

### File Uploader Methods

Use existing methods from `fastapi_app/lib/file_uploader.py`:

- `upload_version()` - Create new annotation version

### TEI Utilities

Use existing functions from `fastapi_app/lib/tei_utils.py`:

- `get_annotator_name(tei_root, who_id)` - Get full name from annotator ID (if needed)

### Error Handling

- Wrap individual document sync operations in try/except
- Collect errors in results["errors"] array
- Continue processing remaining documents after errors
- Display all errors in final report

### Security Considerations

- Plugin requires "reviewer" role
- Validate repository path exists before scanning
- Use Path objects to prevent path traversal
- Only process `*.tei.xml` files
- Validate TEI structure before parsing

### Performance Considerations

- Process documents in memory (no large collections expected)
- Hash comparison happens before timestamp parsing (faster for identical docs)
- Consider adding progress feedback for large collections (future enhancement)

## Future Enhancements

- Support for importing new documents from filesystem
- Support for deleting documents not in filesystem
- Dry-run mode to preview changes
- Detailed change log with diffs
- Integration with git operations (commit after sync)
- Progress indicator for large collections
- Configurable conflict resolution strategies

---

## Implementation Summary

**Files Created:**

- [fastapi_app/plugins/local_sync/__init__.py](../../fastapi_app/plugins/local_sync/__init__.py) - Plugin registration
- [fastapi_app/plugins/local_sync/plugin.py](../../fastapi_app/plugins/local_sync/plugin.py) - Main plugin implementation with sync logic (type-safe, no mypy errors)
- [fastapi_app/plugins/local_sync/tests/test_plugin.py](../../fastapi_app/plugins/local_sync/tests/test_plugin.py) - Comprehensive test suite (10 tests, all passing)
- [fastapi_app/plugins/local_sync/README.md](../../fastapi_app/plugins/local_sync/README.md) - Plugin documentation with usage guide and .env examples

**Files Modified:**

- [fastapi_app/lib/plugin_tools.py](../../fastapi_app/lib/plugin_tools.py:10-71) - Added `get_plugin_config()` utility function for generic plugin configuration with environment variable fallback
- [docs/code-assistant/backend-plugins.md](../../docs/code-assistant/backend-plugins.md:147-205) - Added "Plugin Configuration with Environment Variables" section with examples

**Features Implemented:**

1. **Configuration Management:**
   - Generic `get_plugin_config()` utility for all plugins to use
   - Priority: config.json > environment variable > default
   - Automatic config key initialization from environment variables
   - Type validation (string, boolean, number, array)

2. **Plugin Availability:**
   - Only available when enabled via config/env var
   - Only available when repo path is configured
   - Role-based access (requires "reviewer" role)

3. **Bidirectional Sync:**
   - Scans filesystem recursively for `*.tei.xml` files
   - Extracts fileref from `/TEI/teiHeader/fileDesc/editionStmt/edition/idno[@type='fileref']`
   - Compares content hashes to detect changes
   - Uses timestamps from `/TEI/teiHeader/revisionDesc/change[last()]/@when` for conflict resolution
   - Collection newer → updates filesystem (with optional timestamped backup)
   - Filesystem newer → creates new annotation version ("Imported at YYYY-MM-DD HH:MM:SS")

4. **HTML Report:**
   - Statistics on processed documents
   - Lists of updated filesystem files
   - Lists of updated collection documents
   - Error reporting with context

**Test Coverage:**

- Filesystem scanning for TEI files
- Fileref extraction from TEI documents
- Timestamp extraction from revision history
- Plugin availability checks (disabled, no repo path, enabled)
- Filesystem updates with and without backups

All 10 tests passing.

---

## Session Updates (2026-01-08)

### Implementation Changes

**TEI Utility Functions** - [fastapi_app/lib/tei_utils.py:622-733](../../fastapi_app/lib/tei_utils.py#L622-L733)

- Added `extract_xpath_text()` - generic XPath extraction with attribute support
- Added `extract_fileref()` - extracts fileref from TEI header
- Added `extract_variant_id()` - extracts variant ID from TEI encodingDesc
- Added `extract_revision_timestamp()` - extracts timestamp from last revision

**Gold Standard Filtering** - [fastapi_app/plugins/local_sync/plugin.py:156](../../fastapi_app/plugins/local_sync/plugin.py#L156)

- Plugin now filters by `is_gold_standard=1` database column

**Tuple-Based Matching** - [fastapi_app/plugins/local_sync/plugin.py:159-183](../../fastapi_app/plugins/local_sync/plugin.py#L159-L183)

- Matching key: `(doc_id, variant)` for both collection and filesystem
- Ensures different variants never overwrite each other

**Dry-Run Mode** - [fastapi_app/plugins/local_sync/plugin.py:91-93](../../fastapi_app/plugins/local_sync/plugin.py#L91-L93)

- Environment variable: `PLUGIN_LOCAL_SYNC_DRYRUN=true`
- Guards writes in [plugin.py:231-232, 241-242](../../fastapi_app/plugins/local_sync/plugin.py#L231-L242)
- Shows warning in report [plugin.py:380-381](../../fastapi_app/plugins/local_sync/plugin.py#L380-L381)

**Detailed Reporting** - [fastapi_app/plugins/local_sync/plugin.py:359-445](../../fastapi_app/plugins/local_sync/plugin.py#L359-L445)

- Report shows three skip categories: identical, only_in_collection, only_in_filesystem
- Lists affected document IDs under each category
- Shows timestamps for filesystem and collection updates

**API Method Corrections** - [fastapi_app/plugins/local_sync/plugin.py:333-363](../../fastapi_app/plugins/local_sync/plugin.py#L333-L363)

- Uses `FileStorage.save_file()` and `FileRepository.insert_file()`
- Sets `stable_id=None` to auto-generate IDs for new versions

### Environment Variables

Add to `.env`:

```bash
PLUGIN_LOCAL_SYNC_ENABLED=true
PLUGIN_LOCAL_SYNC_REPO_PATH=/path/to/local/repository
PLUGIN_LOCAL_SYNC_BACKUP=true
```

---

## Preview-then-Execute Implementation (2026-01-08)

### Changes Made

**Plugin Endpoint** - [fastapi_app/plugins/local_sync/plugin.py:68-90](../../fastapi_app/plugins/local_sync/plugin.py#L68-L90)

- Changed `sync()` endpoint to return `outputUrl` and `executeUrl` instead of inline HTML
- Preview URL points to `/api/plugins/local-sync/preview`
- Execute URL points to `/api/plugins/local-sync/execute`

**Custom Routes** - [fastapi_app/plugins/local_sync/routes.py](../../fastapi_app/plugins/local_sync/routes.py)

- Added `preview_sync()` route - runs sync in dry-run mode, shows detailed preview HTML
- Added `execute_sync()` route - runs sync in execute mode, shows summary HTML
- Both routes handle authentication using dependency injection pattern
- Configuration retrieved from `get_config()` (initialized in `__init__.py`)

**Report Generation** - [fastapi_app/plugins/local_sync/plugin.py:335-488](../../fastapi_app/plugins/local_sync/plugin.py#L335-L488)

- Removed `_generate_report_html()` method
- Added `_generate_detailed_report_html()` - full HTML document with detailed change lists for preview
- Added `_generate_summary_report_html()` - full HTML document with statistics only for execute

**Configuration Initialization** - [fastapi_app/plugins/local_sync/__init__.py:1-6](../../fastapi_app/plugins/local_sync/__init__.py#L1-L6)

- Config values initialized from environment variables at plugin registration time
- Routes use `get_config()` to retrieve already-initialized values

**Frontend Changes** - [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js)

- Added `executeBtn` to result dialog typedef
- Added `configureExecuteButton()` method to handle execute button
- Execute button fetches `executeUrl` and loads result in same iframe
- Execute button hidden after clicking

**Dialog Template** - [app/src/templates/backend-plugins-result-dialog.html:12-15](../../app/src/templates/backend-plugins-result-dialog.html#L12-L15)

- Added execute button with success variant and play icon

**Documentation** - [docs/code-assistant/backend-plugins.md:516-603](../../docs/code-assistant/backend-plugins.md#L516-L603)

- Added section "Preview-then-Execute Pattern" describing the workflow
- Documented when to use this pattern
- Provided implementation examples for preview and execute routes

### Workflow

1. User clicks "Sync with Local Folder" from plugins menu
2. Plugin returns `outputUrl` (preview) and `executeUrl`
3. Frontend displays preview in iframe with detailed change list
4. Preview HTML shows: "Preview Mode - Click Execute to apply these changes"
5. Execute button appears in dialog footer
6. User reviews changes and clicks Execute
7. Execute URL is loaded in the same iframe
8. Summary HTML shows completion message with statistics only
9. Execute button is hidden after clicking

### Environment Variable Changes

- Removed `PLUGIN_LOCAL_SYNC_DRYRUN` (no longer needed)
- Preview mode is now the default initial view
- Execute is triggered by user action, not environment variable

---

## Path Filtering Implementation (2026-01-08)

### Changes Made

**Configuration Initialization** - [fastapi_app/plugins/local_sync/__init__.py:7-8](../../fastapi_app/plugins/local_sync/__init__.py#L7-L8)

- Added `plugin.local-sync.repo.include` config key with `PLUGIN_LOCAL_SYNC_REPO_INCLUDE` env var
- Added `plugin.local-sync.repo.exclude` config key with `PLUGIN_LOCAL_SYNC_REPO_EXCLUDE` env var

**Filesystem Scanning** - [fastapi_app/plugins/local_sync/plugin.py:271-308](../../fastapi_app/plugins/local_sync/plugin.py#L271-L308)

- Updated `_scan_filesystem()` to accept `include_pattern` and `exclude_pattern` parameters
- Compile regex patterns if provided
- Apply include filter: only keep files matching the pattern
- Apply exclude filter: remove files matching the pattern
- Match against full file path string

**Sync Collection** - [fastapi_app/plugins/local_sync/plugin.py:122-128](../../fastapi_app/plugins/local_sync/plugin.py#L122-L128)

- Retrieve filter patterns from config using `get_config()`
- Pass patterns to `_scan_filesystem()` method

**Tests** - [fastapi_app/plugins/local_sync/tests/test_plugin.py:41-117](../../fastapi_app/plugins/local_sync/tests/test_plugin.py#L41-L117)

- Added `test_scan_filesystem_with_include_filter()` - tests include pattern (subdir filter)
- Added `test_scan_filesystem_with_exclude_filter()` - tests exclude pattern (subdir exclusion)
- Added `test_scan_filesystem_with_include_and_exclude_filters()` - tests combined filters (gold/ include, draft exclude)
- Added `test_scan_filesystem_with_filename_pattern()` - tests filename-based pattern (article-*.tei.xml)
- Fixed existing tests to use `tei_utils` functions instead of removed plugin methods

**Documentation** - [fastapi_app/plugins/local_sync/README.md:41-109](../../fastapi_app/plugins/local_sync/README.md#L41-L109)

- Added filter configuration examples for environment variables and config.json
- Added table row for include and exclude config options
- Added "Path Filtering" section with usage examples
- Documented filter processing order

### Features

**Include pattern** - Only files matching this regex will be synced:

- Match directory: `gold/`
- Match filename: `article-\d+\.tei\.xml$`

**Exclude pattern** - Files matching this regex will be skipped:

- Exclude directories: `draft|temp`
- Exclude file types: `\.backup$`

**Combined filters** - Both patterns can be used together for precise control

**Filter processing**:

1. Scan directory recursively for `*.tei.xml` files
2. If include is set: keep only files matching the pattern
3. If exclude is set: remove files matching the pattern
4. Sync remaining files

---

## SSE Notifications and Version Import Fix (2026-01-08)

### Changes Made

**SSE Event Broadcasting** - [fastapi_app/plugins/local_sync/routes.py:179-195](../../fastapi_app/plugins/local_sync/routes.py#L179-L195)

- Added `sse_service` dependency injection to `execute_sync()` route
- After successful sync with collection updates, broadcasts `fileDataChanged` SSE event
- Event includes metadata: reason ("local_sync"), collection ID, update count
- Uses `broadcast_to_other_sessions()` to notify all other client sessions
- Pattern follows [fastapi_app/routers/files_save.py:424-435](../../fastapi_app/routers/files_save.py#L424-L435)

**Imported Version Type Fix** - [fastapi_app/plugins/local_sync/plugin.py:328-411](../../fastapi_app/plugins/local_sync/plugin.py#L328-L411)

- Changed `_create_new_version()` to create annotation versions instead of gold standard files
- Gets next version number using `file_repo.get_latest_tei_version()`
- Creates versioned filename: `{fileref}.{variant}.v{version}.tei.xml`
- Sets `version=next_version` instead of `version=None`
- Sets `is_gold_standard=False` instead of `True`
- Imported files now require manual review/promotion by reviewers

**TEI Revision Change for Imports** - [fastapi_app/plugins/local_sync/plugin.py:346-385](../../fastapi_app/plugins/local_sync/plugin.py#L346-L385)

- Adds a revision change to TEI content before saving to ensure unique content hash
- Maintains previous status from last revision
- Creates respStmt for user if it doesn't exist (using `user['username']` and `user.get('fullname')`)
- Description: "Imported from local filesystem at YYYY-MM-DD HH:MM:SS"
- Appends " (imported at YYYY-MM-DD HH:MM:SS)" to existing edition title in `/TEI/teiHeader/fileDesc/editionStmt/edition/title`
- Uses `serialize_tei_with_formatted_header()` for proper pretty-printing of the TEI header
- This solves the identical content hash issue that prevented imports
- No longer need to check for duplicate content hash or handle that error case

**New TEI Utility Functions** - [fastapi_app/lib/tei_utils.py:736-889](../../fastapi_app/lib/tei_utils.py#L736-L889)

- `extract_last_revision_status()` - Extract status from last revision change
- `get_resp_stmt_by_id()` - Find respStmt element by persName xml:id
- `add_resp_stmt()` - Add respStmt element to titleStmt with persName and resp
- `add_revision_change()` - Add change element to revisionDesc with automatic respStmt creation

**Execute Button Reference Fix** - [app/src/plugins/backend-plugins.js:488-494](../../app/src/plugins/backend-plugins.js#L488-L494)

- Fixed undefined reference error after button clone/replace
- Changed `dialog.content.querySelector('iframe')` to `ui.pluginResultDialog.content.querySelector('iframe')`
- Changed `dialog.executeBtn.style.display` to `ui.pluginResultDialog.executeBtn.style.display`
- Ensures all references use updated UI object after `updateUi()` call

### Behavior

**Client Notification Flow:**

1. User executes sync in session A
2. Sync updates collection with new imported versions
3. Backend broadcasts `fileDataChanged` event to sessions B, C, D, etc.
4. Other clients reload file data to see new versions

**Import Workflow:**

1. Filesystem TEI file is newer than collection gold standard
2. Plugin creates new annotation version with label "Imported at YYYY-MM-DD HH:MM:SS"
3. Version appears in file list for reviewer approval
4. Reviewer can promote version to gold standard if changes are acceptable

### Notes

- SSE warnings "No SSE queue for client" are expected for inactive sessions
- The broadcast function filters out sessions without active SSE connections
- Imported versions maintain proper version numbering sequence
- Users can now safely sync from filesystem without overwriting gold standards
