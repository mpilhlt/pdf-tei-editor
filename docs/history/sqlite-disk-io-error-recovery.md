# SQLite "disk I/O error" in CI container E2E runs (issue #589)

## Symptom

In three consecutive container E2E runs of PR #586, `GET /api/v1/files/list` returned 500 with `sqlite3.OperationalError: disk I/O error` from `metadata.db` queries. From the first error on, every `metadata.db` query failed until the server stopped. Logins kept working, so `sessions.db` was not affected. The fourth run with the same test order passed.

## Findings

Verified locally (SQLite 3.45 and the project's Python 3.13 environment):

- Removing the `-wal` file of a WAL-mode database while one connection stays open makes every new connection in the same process fail with "disk I/O error". Once all connections of the process are closed, a new connection works again. Removing only the `-shm` file or replacing the database file via `os.replace` did not cause the error.
- `DatabaseManager` pools its connections and never closes them, so it never recovers: with the old code the error persists for every later query (reproduced in `tests/unit/fastapi/test_database_connection_recovery.py`).
- `sessions.db` kept working although `db_utils` also keeps connections open (one per thread). Whatever invalidated the WAL file therefore affected `metadata.db` only, not the whole directory or file system.
- A connection whose statement raised stays open in SQLite after `close()` until the cursor is garbage-collected, because the cursor, the exception and the generator frame form a reference cycle. Recovery therefore also needs a `gc.collect()`.

Not verified: what removed or replaced the WAL file in the CI container. The CI log of the failing runs only contains the last three tracebacks. No code in the repository deletes database files while the server runs (the test runner wipes `runtime/db` before it starts the server). Disk exhaustion is unlikely because a full disk makes SQLite report `SQLITE_FULL` ("database or disk is full"), not an I/O error, and `sessions.db` writes kept working.

## Changes

- `fastapi_app/lib/core/database.py`: `get_connection()` detects SQLite I/O and corruption errors (`is_connection_broken()`), closes the failing connection and all idle pooled connections, retires connections in use via a pool generation counter, collects garbage before opening the next connection and logs the state of `metadata.db`, `-wal`, `-shm` (size, inode) and the free disk space. The failing request still returns an error, later requests work.
- `docker/entrypoint-ci.sh`: prints `df -h` before the tests run.
- `docs/code-assistant/database-connections.md`: documents the recovery.

## Next occurrence

Look for the warning `SQLite error on metadata.db: ... Closed N pooled connection(s)` in the server log output printed by `LocalServerManager.printServerTracebacks()`. A missing or 0-byte `-wal` file, or a changed inode, points to a file replaced from outside the server process.
