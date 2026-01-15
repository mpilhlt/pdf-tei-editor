# SQLite Connection Management

## Overview

The application uses a robust SQLite connection management strategy designed to handle high concurrency and prevent "database is locked" errors, specifically when using WAL (Write-Ahead Logging) mode.

## Key Components

### 1. DatabaseManager (`fastapi_app/lib/database.py`)

The core class for database interaction. It implements:

- **Connection Pooling**: Uses `queue.Queue` to reuse connections, reducing the overhead of opening/closing files and avoiding file descriptor exhaustion.
- **WAL Mode Initialization**: Ensures WAL mode is enabled safely using a raw connection and file locking during startup (`_ensure_db_exists`).
- **Transaction Management**: Provides a `transaction()` context manager that explicitly handles `BEGIN`, `COMMIT`, and `ROLLBACK`.
- **Autocommit Mode**: Connections are opened with `isolation_level=None` (autocommit) to allow manual transaction control and prevent implicit transactions from locking the database unexpectedly.

### 2. Singleton Pattern (`fastapi_app/lib/dependencies.py`)

- `_DatabaseManagerSingleton` ensures only one `DatabaseManager` instance exists per database file.
- This allows the connection pool to be shared across the application, preventing multiple pools from competing for the same database file.

### 3. Locking (`fastapi_app/lib/sqlite_utils.py`)

- `with_db_lock(db_path)`: Uses a reentrant lock (`threading.RLock`) to serialize schema initialization and WAL mode setup per database file.

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
- **Avoid `sqlite_utils.get_connection`**: This is a legacy helper; `DatabaseManager` now handles connections directly.
