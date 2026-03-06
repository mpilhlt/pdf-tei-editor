# SQLite Connection Management

## Overview

The application uses a robust SQLite connection management strategy designed to handle high concurrency and prevent "database is locked" errors.

## Journal Mode Selection

The application uses different journal modes depending on database characteristics:

### WAL Mode (Write-Ahead Logging)

Used for databases with high concurrency and frequent reads:

- `metadata.db` - Main file metadata database
- `sessions.db` - User session data

**Benefits**: Allows concurrent reads during writes, better performance for read-heavy workloads.

**Drawback**: WAL files can become corrupted under rapid concurrent access during initialization.

### DELETE Mode

Used for simple databases with infrequent writes:

- `locks.db` - File locking database

**Benefits**: Simpler, no WAL file corruption issues, sufficient for low-concurrency use cases.

**When to use DELETE mode**:

- Small databases with infrequent writes
- Short-lived data (like locks)
- Databases that don't benefit from WAL's read concurrency
- When rapid concurrent access during tests causes WAL corruption

See `fastapi_app/lib/core/locking.py` for an example of DELETE mode implementation.

## Key Components

### 1. DatabaseManager (`fastapi_app/lib/core/database.py`)

The core class for database interaction. It implements:

- **Connection Pooling**: Uses `queue.Queue` to reuse connections, reducing the overhead of opening/closing files and avoiding file descriptor exhaustion.
- **WAL Mode Initialization**: Ensures WAL mode is enabled safely using a raw connection and file locking during startup (`_ensure_db_exists`).
- **Transaction Management**: Provides a `transaction()` context manager that explicitly handles `BEGIN`, `COMMIT`, and `ROLLBACK`.
- **Autocommit Mode**: Connections are opened with `isolation_level=None` (autocommit) to allow manual transaction control and prevent implicit transactions from locking the database unexpectedly.

### 2. Singleton Pattern (`fastapi_app/lib/core/dependencies.py`)

- `_DatabaseManagerSingleton` ensures only one `DatabaseManager` instance exists per database file.
- This allows the connection pool to be shared across the application, preventing multiple pools from competing for the same database file.

### 3. Locking (`fastapi_app/lib/core/sqlite_utils.py`)

- `with_db_lock(db_path)`: Uses a reentrant lock (`threading.RLock`) to serialize schema initialization and WAL mode setup per database file.

### 4. Busy Timeout

All connections set `PRAGMA busy_timeout = 30000` (30 seconds) to wait for locks instead of failing immediately with "database is locked" errors.

## Connection Lifecycle

1.  **Acquisition**: `get_connection()` attempts to retrieve a connection from the pool. If empty, it creates a new `sqlite3.Connection` with `timeout=60.0` and `isolation_level=None`.
2.  **Usage**: The connection is yielded to the caller.
3.  **Release**:
    - `conn.rollback()` is called to ensure no uncommitted state leaks to the next user.
    - The connection is put back into the pool.

## Best Practices for Code Assistants

- **Always use `DatabaseManager`**: Do not create raw `sqlite3.connect()` calls in business logic.
- **Use `transaction()` for writes**: Ensure atomicity for INSERT/UPDATE/DELETE operations.
- **Pass `DatabaseManager` instances**: When classes need database access (e.g., `StorageReferenceManager`), pass the initialized manager instance, not the file path, to utilize the pool.
- **Choose the right journal mode**: Use WAL for high-concurrency databases, DELETE for simple low-write databases.
- **Always set busy_timeout**: Use `conn.execute("PRAGMA busy_timeout = 30000")` to prevent immediate failures on lock contention.
