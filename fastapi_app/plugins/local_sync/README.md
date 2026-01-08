# Local Sync Plugin

Backend plugin for synchronizing TEI documents between a collection and a local filesystem directory.

## Overview

The Local Sync plugin performs bidirectional synchronization between documents in the PDF-TEI Editor collection and a local folder (typically a git repository). It intelligently resolves conflicts based on timestamps, ensuring that the newest version is preserved.

## Features

- **Bidirectional sync**: Compares collection documents with filesystem files
- **Conflict resolution**: Uses timestamps to determine which version is newer
- **Backup support**: Optional timestamped backups before overwriting files
- **Version management**: Creates new annotation versions when importing from filesystem
- **Error reporting**: Detailed HTML report with statistics and errors

## Sync Logic

1. **Scan filesystem** recursively for `*.tei.xml` files
2. **Match documents** using fileref from `/TEI/teiHeader/fileDesc/editionStmt/edition/idno[@type='fileref']`
3. **Compare content** using SHA-256 hash
4. **Resolve conflicts** using timestamp from `/TEI/teiHeader/revisionDesc/change[last()]/@when`:
   - Collection newer → Update filesystem (with optional backup)
   - Filesystem newer → Create new annotation version in collection
   - Identical content → Skip

## Configuration

The plugin requires configuration via environment variables or `data/db/config.json`:

### Environment Variables

Add to your `.env` file:

```bash
# Local Sync Plugin Configuration
PLUGIN_LOCAL_SYNC_ENABLED=true
PLUGIN_LOCAL_SYNC_REPO_PATH=/path/to/your/git/repository
PLUGIN_LOCAL_SYNC_BACKUP=true

# Optional: Filter which files to sync
PLUGIN_LOCAL_SYNC_REPO_INCLUDE=gold/.*\.tei\.xml$
PLUGIN_LOCAL_SYNC_REPO_EXCLUDE=draft|temp
```

### Configuration Keys

Alternatively, set in `data/db/config.json`:

```json
{
  "plugin.local-sync.enabled": true,
  "plugin.local-sync.repo.path": "/path/to/your/git/repository",
  "plugin.local-sync.backup": true,
  "plugin.local-sync.repo.include": "gold/.*\\.tei\\.xml$",
  "plugin.local-sync.repo.exclude": "draft|temp"
}
```

**Priority**: Config file values override environment variables.

### Configuration Options

| Key | Environment Variable | Type | Default | Description |
|-----|---------------------|------|---------|-------------|
| `plugin.local-sync.enabled` | `PLUGIN_LOCAL_SYNC_ENABLED` | boolean | `false` | Enable/disable the plugin |
| `plugin.local-sync.repo.path` | `PLUGIN_LOCAL_SYNC_REPO_PATH` | string | None | Path to local sync directory |
| `plugin.local-sync.backup` | `PLUGIN_LOCAL_SYNC_BACKUP` | boolean | `true` | Create timestamped backups before overwriting |
| `plugin.local-sync.repo.include` | `PLUGIN_LOCAL_SYNC_REPO_INCLUDE` | string (regex) | None | Only sync files matching this pattern |
| `plugin.local-sync.repo.exclude` | `PLUGIN_LOCAL_SYNC_REPO_EXCLUDE` | string (regex) | None | Exclude files matching this pattern |

### Path Filtering

The `include` and `exclude` options accept regular expressions that are matched against the complete file path.

**Include pattern** - Only files matching this pattern will be synced:

```bash
# Only sync files in the "gold" subdirectory
PLUGIN_LOCAL_SYNC_REPO_INCLUDE=gold/

# Only sync files with specific naming pattern
PLUGIN_LOCAL_SYNC_REPO_INCLUDE=article-\d+\.tei\.xml$
```

**Exclude pattern** - Files matching this pattern will be skipped:

```bash
# Exclude draft and temp directories
PLUGIN_LOCAL_SYNC_REPO_EXCLUDE=draft|temp

# Exclude backup files
PLUGIN_LOCAL_SYNC_REPO_EXCLUDE=\.backup$
```

**Combined filters** - Both patterns can be used together:

```bash
# Sync only gold directory, but exclude drafts
PLUGIN_LOCAL_SYNC_REPO_INCLUDE=gold/
PLUGIN_LOCAL_SYNC_REPO_EXCLUDE=draft
```

**Filter processing order**:

1. Scan directory recursively for `*.tei.xml` files
2. If `include` is set: keep only files matching the pattern
3. If `exclude` is set: remove files matching the pattern
4. Sync remaining files

## Availability

The plugin is only visible and usable when:

1. **Enabled**: `plugin.local-sync.enabled` is `true`
2. **Configured**: `plugin.local-sync.repo.path` is set to a valid path
3. **Authorized**: User has the `reviewer` role

## Usage

1. **Enable the plugin** via environment variables or config
2. **Set the repository path** to your local sync directory
3. **Open a collection** in the editor
4. **Click the plugin menu** in the toolbar
5. **Select "Sync → Sync with Local Folder"**
6. **Review the sync report** showing statistics and changes

## Sync Report

The plugin displays an HTML report with:

- **Total documents processed**
- **Skipped** (identical content)
- **Updated filesystem** (collection was newer)
- **Updated collection** (filesystem was newer)
- **Errors** (with details)

Each section lists affected documents with their fileref and timestamps.

## Backup Files

When `plugin.local-sync.backup` is `true`, the plugin creates timestamped backups before overwriting filesystem files:

```
document.tei.xml → document.20250108_153045.backup
```

Format: `<filename>.<YYYYmmdd_HHMMSS>.backup`

## Version Management

When importing newer versions from filesystem, the plugin creates annotation versions with descriptive names:

```
"Imported at 2025-01-08 15:30:45"
```

These versions appear in the version history and can be accessed like any other annotation version.

## Requirements

### TEI Document Structure

For the plugin to work, TEI documents must include:

1. **Fileref** for matching:

   ```xml
   <TEI>
     <teiHeader>
       <fileDesc>
         <editionStmt>
           <edition>
             <idno type="fileref">document-identifier</idno>
           </edition>
         </editionStmt>
       </fileDesc>
     </teiHeader>
   </TEI>
   ```

2. **Revision history** with timestamps:

   ```xml
   <TEI>
     <teiHeader>
       <revisionDesc>
         <change when="2025-01-08T15:30:00">Latest change</change>
       </revisionDesc>
     </teiHeader>
   </TEI>
   ```

## Limitations

Current version:

- Only syncs documents that exist in both locations
- Does not import new documents from filesystem
- Does not delete documents missing from filesystem
- Processes entire collection (no selective sync)
- No dry-run mode

See "Future Enhancements" in the implementation plan for planned features.

## Development

### Running Tests

```bash
uv run python -m pytest fastapi_app/plugins/local_sync/tests/test_plugin.py -v
```

### Test Coverage

- Filesystem scanning for TEI files
- Fileref extraction from TEI documents
- Timestamp extraction from revision history
- Plugin availability checks
- Filesystem updates with and without backups

All tests pass.

## References

- **Implementation Plan**: [dev/todo/local-sync-plugin.md](../../../../dev/todo/local-sync-plugin.md)
- **Backend Plugin Guide**: [docs/code-assistant/backend-plugins.md](../../../../docs/code-assistant/backend-plugins.md)
- **Configuration Guide**: [docs/development/configuration.md](../../../../docs/development/configuration.md)
