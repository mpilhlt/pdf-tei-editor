# Release document locks when a session ends (issue #851)

## Problem

A user who logged out while editing a document, logged in again (e.g. after switching to the admin account) and reopened the document got *This document is being edited by another user* until the lock went stale (90 seconds without heartbeat).

## Cause

Locks in `locks.db` are held by a session id. `POST /api/v1/auth/logout` deleted the session but not its locks, and the frontend could not release the lock afterwards because its session was gone. The new login creates a new session, so `acquire_lock` refused the lock. `describe_lock_holder()` could not find the user of the deleted session and fell back to "another user" instead of the "own session" notice.

## Fix

- `release_session_locks(session_ids, db_dir, logger)` in `fastapi_app/lib/core/locking.py` deletes the locks of the given sessions.
- `SessionManager` releases the locks of every session it deletes: `delete_session()`, `delete_all_user_sessions()`, `delete_token_sessions()` and `cleanup_expired_sessions()`. This covers logout, sessions ended by an admin, revoked access tokens and expired sessions.
- Logout releases the locks before deleting the session and sends `lockReleased` to the other sessions, so a window that shows the document read-only can take the lock, and emits `file.lock_changed` for sync plugins.

## Tests

`tests/unit/fastapi/test_session_locks.py` covers each session deletion and the logout endpoint.
