# WebDAV Sync Plugin

Synchronizes the application's file store with a remote WebDAV server using an append-only operation log. When enabled, a sync icon and progress bar appear in the PDF viewer statusbar. Sync runs automatically on startup and after file operations (save, delete, duplicate), periodically in the background, and can be triggered manually by clicking the sync icon.

Conflicts (file modified locally while deleted remotely) are detected and can be resolved via the conflict resolution API. File locks acquired on one instance are propagated to other instances via the operation log.

---

## Setup

Set the following environment variables in `.env.fastapi` (or the active env file):

```env
WEBDAV_ENABLED=true
WEBDAV_BASE_URL=https://your-webdav-server/remote.php/dav/files/username
WEBDAV_USERNAME=your-username
WEBDAV_PASSWORD=your-password
WEBDAV_REMOTE_ROOT=/pdf-tei-editor   # Remote directory (default: /pdf-tei-editor)
WEBDAV_SYNC_INTERVAL=300             # Periodic sync interval in seconds (default: 300; 0 = disabled)
WEBDAV_TRANSFER_WORKERS=4            # Parallel upload/download workers (default: 4)
```

The plugin is inactive unless both `WEBDAV_ENABLED=true` and `WEBDAV_BASE_URL` are set. All other settings fall back to their defaults when omitted.

These values are also writable at runtime via the configuration API under the keys `plugin.webdav-sync.*`.

---

## Technical implementation

### Plugin structure

```text
fastapi_app/plugins/webdav_sync/
├── __init__.py          # Exports WebDavSyncPlugin, router, plugin instance
├── plugin.py            # Plugin class — availability check, endpoint registration, extension init
├── routes.py            # FastAPI routes at /api/plugins/webdav-sync/*
├── service.py           # SyncService — sync logic, conflict detection/resolution, lock sync
├── remote_queue.py      # RemoteQueueManager — queue.db download/upload/compaction
├── config.py            # init_plugin_config(), get_webdav_config(), is_configured()
├── extensions/
│   └── webdav-sync.js   # Frontend extension — sync icon, progress bar, SSE listeners, periodic sync
└── tests/
    ├── test_two_instance_sync.py   # Unit tests for _apply_ops / _collect_own_ops
    └── run-integration-tests.js
```

### Backend

**Plugin activation** (`plugin.py`): `WebDavSyncPlugin.is_available()` returns `True` only when both `plugin.webdav-sync.enabled` and `plugin.webdav-sync.base-url` are set. Discovery and route registration happen at module import time; initialization (frontend extension registration) runs in `initialize()` during app startup.

**Configuration** (`config.py`): `init_plugin_config()` is called in `__init__()` to register config keys from environment variables via `get_plugin_config()`. All other code reads values with `get_config().get(key)`.

**Routes** (`routes.py`): Unversioned routes at `/api/plugins/webdav-sync/`:

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/status` | O(1) check — returns seq numbers and unsynced file count |
| `POST` | `/sync` | Run full sync; progress via SSE (`syncProgress`, `syncMessage` events) |
| `GET` | `/conflicts` | List files with unresolved conflicts |
| `POST` | `/resolve` | Resolve a conflict (`local_wins`, `remote_wins`, `keep_both`) |

The plugin's `execute` endpoint (invoked via `POST /api/v1/plugins/webdav-sync/execute`) delegates to `execute_sync()`, which calls `SyncService.perform_sync()` and returns a `SyncSummary` dict. This is how the frontend extension triggers sync.

### Sync algorithm

The shared state on WebDAV is `queue.db` — an append-only SQLite operation log. Each sync client has a persistent UUID (`sync_metadata['sync_client_id']`) and tracks the highest sequence number it has applied (`sync_metadata['last_applied_seq']`). Because the log is append-only, an empty or missing `queue.db` means "no operations yet" — it never destroys existing client state.

**`queue.db` schema:**

```sql
CREATE TABLE ops (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  TEXT NOT NULL,
    op_type    TEXT NOT NULL,   -- 'upsert' | 'delete'
    stable_id  TEXT NOT NULL,
    file_id    TEXT NOT NULL,
    file_data  TEXT,            -- JSON metadata blob for upsert ops
    created_at TEXT NOT NULL
);

CREATE TABLE clients (
    client_id        TEXT PRIMARY KEY,
    last_applied_seq INTEGER NOT NULL DEFAULT 0,
    last_seen_at     TEXT NOT NULL,
    active_locks     TEXT NOT NULL DEFAULT '{}'  -- JSON: {stable_id: {acquired_at, updated_at}}
);
```

**Full sync cycle** (`SyncService.perform_sync()`):

1. **Skip check**: compare `last_applied_seq` with `MAX(ops.seq)` on remote and count locally unsynced files. Skip unless `force=True`.
2. **Lock**: write `{remote_root}/version.txt.lock` on WebDAV. Polls up to 300 s; stale locks (> 60 s) are forcibly removed.
3. **Download** `queue.db`.
4. **Register client**: upsert own row in `clients`, writing the current local lock state into `active_locks`.
5. **Cache remote locks**: read all other clients' `active_locks` columns and store the merged result in `sync_metadata['remote_locks']` for use by the lock system.
6. **Apply remote ops**: for each op with `seq > last_applied_seq` and `client_id != own`, apply locally:
   - `upsert`: download file if hash is new; update local DB record (un-delete if needed).
   - `delete`: soft-delete local record (skip if file is currently locked).
7. **Collect own ops**: for each locally unsynced or pending-delete file, upload content if not already on remote, then record an `upsert` or `delete` op.
8. **Compact**: remove ops already applied by all known clients; purge clients absent for > 7 days.
9. **Upload** `queue.db`, update `version.txt`, release lock.

**Bootstrap**: a new instance starts with `last_applied_seq = 0` and applies all ops in order. On first use of the new queue system, any existing locally `synced` files are re-queued as `modified` so they are uploaded and become part of the log.

**Conflict definition**: a conflict arises when a file has been modified locally (not yet synced) and simultaneously deleted on the remote. Local-modified + remote-modified is not treated as a conflict — a locally modified file is never silently overwritten by a remote modification.

**Conflict resolution** (`POST /resolve`): accepts `file_id` and one of three strategies:

| Strategy | Effect |
| -------- | ------ |
| `local_wins` | Sets `sync_status='modified'`, clears `sync_hash`. Uploaded on next sync. |
| `remote_wins` | Marks file synced against remote version. Remote deletion propagates on next sync. |
| `keep_both` | Not yet implemented. Intended to create a new variant from the local version. |

### Lock propagation

Each client writes its current active file locks into `clients.active_locks` on every sync and on every lock acquire/release (via a lightweight `sync_locks()` call that skips file transfers and op processing). Other instances read this column and cache the merged state in `sync_metadata['remote_locks']`.

The cached state is consulted in two places:
- **`acquire_lock()`** (`locking.py`): before granting a new local lock, checks whether the file appears in the remote lock cache with a non-expired TTL (local timeout 90 s + one sync-cycle buffer 360 s = 450 s). Returns `False` (→ HTTP 423) if so.
- **`/files/list`**: `_add_remote_lock_info()` marks artifacts as `is_locked=True` for the same TTL check, so the lock icon appears in the file list even when the lock is held on a remote instance.

Lock state propagation latency after a `sync_locks()` call is one WebDAV round-trip (typically < 2 s), so the remote instance sees the lock icon within seconds of the file being opened.

### Periodic sync

The frontend extension reads `plugin.webdav-sync.sync-interval` via `sandbox.config.get()` on install (default: 300 s) and starts a `setInterval` loop. Each tick calls `sync.syncFiles`, which runs a full `perform_sync()`. If the result includes downloaded or locally-deleted files, the file list is reloaded automatically.

Set `WEBDAV_SYNC_INTERVAL=0` to disable periodic sync.

### Abstract sync infrastructure

`fastapi_app/lib/sync/` defines the shared base used by this plugin:

- `base.py` — `SyncServiceBase(ABC)` with abstract methods `check_status()`, `perform_sync()`, `get_conflicts()`, `resolve_conflict()`
- `models.py` — Pydantic models: `SyncStatusResponse`, `SyncSummary`, `SyncRequest`, `ConflictInfo`, `ConflictListResponse`, `ConflictResolution`, `SSEMessage`

### Frontend extension

`extensions/webdav-sync.js` is loaded by the frontend extension system when the plugin is available. It:

- Adds a sync icon (`sl-icon[name=arrow-repeat]`) and `<status-progress>` widget to the PDF viewer statusbar
- Registers SSE listeners for `syncProgress` (updates the progress bar) and `syncMessage` (appends to a hover popup log)
- Implements the `sync.syncFiles` plugin endpoint (`ep.sync.syncFiles`), invoked by other plugins via `app.invokePluginEndpoint(ep.sync.syncFiles, state)`
- On manual icon click, invokes the endpoint and reloads the file list
- Starts a periodic sync timer based on `plugin.webdav-sync.sync-interval`

The extension uses sandbox capabilities: `sandbox.api.pluginsExecute`, `sandbox.config.get`, `sandbox.invoke`, `sandbox.sse`, and `sandbox.services.reloadFiles`.

### Testing

**Unit tests** (no server required):

```bash
uv run python -m pytest fastapi_app/plugins/webdav_sync/tests/test_two_instance_sync.py
```

The test suite covers `_apply_ops` and `_collect_own_ops` directly, verifying the key correctness properties: no ping-pong re-upload, no UNIQUE constraint errors on hash replacement, correct soft-delete and restore semantics.
