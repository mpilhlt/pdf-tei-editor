# WebDAV Sync Plugin

Synchronizes the application's file store with a remote WebDAV server. When enabled, a sync icon and progress bar appear in the PDF viewer statusbar. Sync runs automatically on startup and after file operations (save, delete, duplicate), and can be triggered manually by clicking the sync icon.

Conflicts (file modified on both sides) are detected and can be resolved via the conflict resolution API.

---

## Setup

Set the following environment variables in `.env.fastapi` (or the active env file):

```env
WEBDAV_ENABLED=true
WEBDAV_BASE_URL=https://your-webdav-server/remote.php/dav/files/username
WEBDAV_USERNAME=your-username
WEBDAV_PASSWORD=your-password
WEBDAV_REMOTE_ROOT=/pdf-tei-editor   # Remote directory to sync into (default: /pdf-tei-editor)
```

The plugin is inactive unless both `WEBDAV_ENABLED=true` and `WEBDAV_BASE_URL` are set. All other settings fall back to their defaults when omitted.

These values are also writable at runtime via the configuration API under the keys `plugin.webdav-sync.*`.

---

## Technical implementation

### Plugin structure

```
fastapi_app/plugins/webdav_sync/
├── __init__.py          # Exports WebDavSyncPlugin, router, plugin instance
├── plugin.py            # Plugin class — availability check, endpoint registration, extension init
├── routes.py            # FastAPI routes at /api/plugins/webdav-sync/*
├── service.py           # SyncService — sync logic, conflict detection/resolution
├── remote_metadata.py   # RemoteMetadataManager — WebDAV metadata.db download/upload
├── config.py            # init_plugin_config(), get_webdav_config(), is_configured()
├── extensions/
│   └── webdav-sync.js   # Frontend extension — sync icon, progress bar, SSE listeners
└── tests/
    ├── test_sync_service.py
    ├── test_remote_metadata.py
    ├── sync.test.js
    └── run-integration-tests.js
```

### Backend

**Plugin activation** (`plugin.py`): `WebDavSyncPlugin.is_available()` returns `True` only when both `plugin.webdav-sync.enabled` and `plugin.webdav-sync.base-url` are set (checked via `is_configured()`). Discovery and route registration happen at module import time; initialization (frontend extension registration) runs in `initialize()` during app startup.

**Configuration** (`config.py`): `init_plugin_config()` is called in `__init__()` to register config keys from environment variables via `get_plugin_config()`. All other code reads values with `get_config().get(key)`.

**Routes** (`routes.py`): Unversioned routes at `/api/plugins/webdav-sync/`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | O(1) check — returns version numbers and unsynced file count |
| `POST` | `/sync` | Run full sync; progress sent via SSE (`syncProgress`, `syncMessage` events) |
| `GET` | `/conflicts` | List files with unresolved conflicts |
| `POST` | `/resolve` | Resolve a conflict (`local_wins`, `remote_wins`, `keep_both`) |

The plugin's `execute` endpoint (invoked via `POST /api/v1/plugins/webdav-sync/execute`) delegates to `execute_sync()`, which calls `SyncService.perform_sync()` and returns a `SyncSummary` dict. This is how the frontend extension triggers sync.

**Sync logic** (`service.py`): `SyncService` implements `SyncServiceBase`. The core algorithm:

1. **Skip check**: Compare local and remote version numbers. If equal and there are no locally unsynced files, return early unless `force=True`.
2. **Lock**: Write `{remote_root}/version.txt.lock` on the WebDAV server. Polls up to 300 seconds if a lock already exists. Stale locks (older than 60 seconds) are forcibly removed.
3. **Download remote metadata**: Fetch `metadata.db` from the WebDAV server via `RemoteMetadataManager`.
4. **Classify changes** (`_compare_metadata`): Diff local and remote metadata records to produce five change sets:
   - `local_new` — file exists locally, absent from remote, not marked deleted locally
   - `local_modified` — file exists on both sides, local `sync_status != 'synced'`, remote not deleted
   - `remote_new` — file exists on remote, absent locally, not marked deleted on remote
   - `remote_modified` — file exists on both sides, remote `updated_at > local updated_at`, local `sync_status == 'synced'`
   - `remote_deleted` — file exists locally, remote record is present but marked deleted
   - `conflicts` — file is `local_modified` AND remote record is marked deleted simultaneously
5. **Transfer files**: Upload `local_new` and `local_modified`; download `remote_new` and `remote_modified`; propagate `remote_deleted` locally.
6. **Sync metadata**: Apply metadata-only changes (no file transfer needed for records already in sync).
7. **Update version**: Increment the remote version number and write it back to `{remote_root}/version.txt`.
8. **Upload metadata**: Push the updated `metadata.db` to the WebDAV server.
9. **Release lock**: Delete `{remote_root}/version.txt.lock`.

Progress is reported via SSE `syncProgress` events at fixed checkpoints (0 → 10 → 20 → 30 → 40 → 55 → 75 → 90 → 100).

**Conflict definition**: A conflict arises when a file has been modified locally (not yet synced) and simultaneously deleted on the remote. Local-modified + remote-modified is not currently treated as a conflict — remote changes only apply when the local file is in `sync_status == 'synced'` state, so a locally modified file is never overwritten by a remote modification.

**Conflict resolution** (`POST /resolve`): Accepts `file_id` and one of three strategies:

| Strategy | Effect |
| --- | --- |
| `local_wins` | Sets `sync_status='modified'` and clears `sync_hash`. The file is treated as locally modified and uploaded on the next sync. |
| `remote_wins` | Marks the file as synced against the remote version (`mark_file_synced`). The remote deletion propagates on the next sync. |
| `keep_both` | Not yet implemented. Intended to create a new variant from the local version. Requires a `new_variant` value in the request. |

**Remote metadata** (`remote_metadata.py`): `RemoteMetadataManager` handles uploading and downloading `metadata.db` (the SQLite file) to/from the WebDAV server using Python's `http.client`. Temporary files are cleaned up after each operation.

### Abstract sync infrastructure

`fastapi_app/lib/sync/` defines the shared base used by this plugin:

- `base.py` — `SyncServiceBase(ABC)` with abstract methods `check_status()`, `perform_sync()`, `get_conflicts()`, `resolve_conflict()`
- `models.py` — Pydantic models: `SyncStatusResponse`, `SyncSummary`, `SyncRequest`, `ConflictInfo`, `ConflictListResponse`, `ConflictResolution`, `SSEMessage`

### Frontend extension

`extensions/webdav-sync.js` is loaded by the frontend extension system when the plugin is available. It:

- Adds a sync icon (`sl-icon[name=arrow-repeat]`) and `<status-progress>` widget to the PDF viewer statusbar
- Registers SSE listeners for `syncProgress` (updates the progress bar) and `syncMessage` (logs to console)
- Implements the `sync.syncFiles` plugin endpoint (`ep.sync.syncFiles`), which is invoked by other plugins (on startup, after save/delete/duplicate) via `app.invokePluginEndpoint(ep.sync.syncFiles, state)`
- On manual icon click, invokes the endpoint and then reloads the file list

The extension uses sandbox capabilities: `sandbox.api.pluginsExecute`, `sandbox.updateState`, `sandbox.sse`, and `sandbox.services.reloadFiles`.

### Testing

**Unit tests** (no server required):

```bash
uv run python -m pytest fastapi_app/plugins/webdav_sync/tests/test_sync_service.py fastapi_app/plugins/webdav_sync/tests/test_remote_metadata.py
```

**Integration tests** (requires a WebDAV server):

```bash
node fastapi_app/plugins/webdav_sync/tests/run-integration-tests.js
```

The runner starts a local FastAPI instance with WebDAV config and a test WebDAV server, executes `sync.test.js`, then shuts both down.
