# SQLite WAL Mode Concurrency Problem

## Problem Summary

After merging the `feat-discord-plugin` branch, 70+ API tests fail with `sqlite3.OperationalError: disk I/O error` or `database disk image is malformed` errors. The errors occur during `PRAGMA journal_mode = WAL` execution when multiple concurrent requests try to initialize database connections simultaneously.

### Key Observations

1. **Tests pass on `devel` branch** - All 223 tests pass with zero database errors
2. **Tests fail on `feat-discord-plugin` branch** - ~90 tests fail with database corruption/I/O errors
3. **Individual test files pass** - Running single test files works; failures only occur when full suite runs
4. **Same number of DB initializations** - Both branches have ~495 database initializations during tests
5. **Error location**: `fastapi_app/lib/database.py:78` during `conn.execute("PRAGMA journal_mode = WAL")`

### Root Cause Analysis

The `feat-discord-plugin` branch added code that increases request processing time (diff computation, event emission, status extraction in `files_save.py`). This creates more overlapping database connections, triggering SQLite WAL race conditions.

The core issue is that **every request creates a new `DatabaseManager`** via FastAPI's `get_db()` dependency, and each one tries to:
1. Set WAL mode on the database
2. Initialize the schema (CREATE TABLE IF NOT EXISTS)

When multiple threads from FastAPI's asyncio threadpool do this simultaneously, SQLite's WAL file gets corrupted.

## Attempted Solutions (Unsuccessful)

### 1. Centralized `sqlite_utils.py` Module
Created a centralized module with:
- `_ensure_wal_mode()` - Sets WAL mode once per database
- `get_connection()` - Returns connections with retry logic
- `with_db_lock()` - Per-database locking for schema initialization
- `reset_initialized_databases()` - For test cleanup

**Result**: Partial improvement but still ~77 errors

### 2. Threading Lock Protection
Added `threading.Lock()` to protect WAL mode initialization and schema creation.

**Result**: Still fails because FastAPI runs sync dependencies in different threads from the asyncio threadpool - locks don't synchronize across these threads effectively.

### 3. File-Based Locking with fcntl
Replaced threading locks with `fcntl.flock()` for cross-process/thread synchronization.

**Result**: Caused server startup to hang - blocking `flock()` blocks the asyncio event loop.

### 4. Non-Blocking File Lock with Timeout
Changed to `fcntl.LOCK_NB` with retry loop to avoid blocking the event loop.

**Result**: Caused deadlock - `_ensure_db_exists()` acquires file lock, then calls `get_connection()` which calls `_ensure_wal_mode()` which tries to acquire the same file lock.

### 5. Reentrant Locks (RLock)
Switched to `threading.RLock()` to allow the same thread to acquire the lock multiple times.

**Result**: Server starts but still ~77 database errors. RLock only works within the same thread, but FastAPI's dependency injection runs in different threads from the threadpool.

### 6. Singleton DatabaseManager
Made `get_db()` return a singleton `DatabaseManager` instance with double-checked locking.

**Result**: Doesn't help because other database managers (`SessionManager`, `AuthManager`, `init_locks_db`) also create connections independently.

## Files Modified

- `fastapi_app/lib/sqlite_utils.py` (new file)
- `fastapi_app/lib/database.py`
- `fastapi_app/lib/dependencies.py`
- `fastapi_app/lib/db_utils.py`
- `fastapi_app/lib/locking.py`
- `fastapi_app/lib/storage_references.py`

## Possible Further Solutions

### 1. Application-Level Database Initialization
Initialize all databases **once** during FastAPI startup (`lifespan` context), before any requests are handled. This ensures WAL mode and schemas are set up before concurrent access begins.

```python
# In main.py lifespan
async def lifespan(app):
    # Initialize all databases synchronously at startup
    init_metadata_db()
    init_sessions_db()
    init_locks_db()
    # Now ready for concurrent requests
    yield
```

### 2. Connection Pooling
Use a proper connection pool (e.g., `aiosqlite` with connection pooling) instead of creating new connections per request. This reduces concurrent connection creation.

### 3. Async-Safe Locking
Use `asyncio.Lock` instead of `threading.Lock` for async-aware synchronization. However, this requires making all database access async.

### 4. SQLite Busy Timeout
Increase SQLite's busy timeout significantly:
```python
conn = sqlite3.connect(db_path, timeout=60.0)
conn.execute("PRAGMA busy_timeout = 60000")
```

### 5. Serialize Database Initialization
Use a process-level lock file (with proper async handling) to serialize database initialization across all threads/processes during the first few seconds of startup.

### 6. Revert to Original Code + Selective Fix
Revert all changes and instead:
- Only fix the specific code path that changed in `feat-discord-plugin`
- Add retry logic specifically to the `files_save.py` code path
- Keep database initialization code unchanged

### 7. Use WAL2 Mode (SQLite 3.37+)
WAL2 mode provides better concurrent writer support. Check if available:
```python
conn.execute("PRAGMA journal_mode = WAL2")
```

## Recommended Next Step

**Option 1 (Application-Level Init)** is the cleanest solution. Move all database initialization to the FastAPI `lifespan` startup phase, ensuring databases are fully initialized before the server accepts requests. This eliminates concurrent initialization entirely.

## Related Files to Review

- `fastapi_app/main.py` - Lifespan context, startup sequence
- `fastapi_app/lib/dependencies.py` - Dependency injection functions
- `fastapi_app/api/auth.py` - Creates SessionManager/AuthManager per request
- `fastapi_app/lib/sessions.py` - SessionManager initialization
- `fastapi_app/lib/auth.py` - AuthManager initialization
