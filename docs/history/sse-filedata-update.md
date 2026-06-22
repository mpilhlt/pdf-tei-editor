# SSE-Based Multi-Client File Data Synchronization

## Summary

Implemented real-time file data synchronization across multiple connected clients using Server-Sent Events (SSE). When a user modifies file data (locks, saves, deletes), all other connected clients automatically receive notifications and reload their file data.

## Implementation

### 1. SSE Broadcast Utility

Created `fastapi_app/lib/sse_utils.py` with `broadcast_to_other_sessions()` function:

- Sends SSE events to all active sessions except the current one
- Takes event type and data dictionary, JSON-serializes the data
- Returns count of sessions notified
- Properly handles `SessionDict` type from `SessionManager`

```python
def broadcast_to_other_sessions(
    sse_service: SSEService,
    session_manager: SessionManager,
    current_session_id: str,
    event_type: str,
    data: dict[str, Any],
    logger: Optional[Any] = None
) -> int
```

### 2. Type Safety Improvements

Added `SessionDict` TypedDict to `fastapi_app/lib/sessions.py`:

```python
class SessionDict(TypedDict):
    """Type definition for session dictionary."""
    session_id: str
    username: str
    created_at: float
    last_access: float
```

Updated `SessionManager.get_all_sessions()` return type from `list[dict]` to `list[SessionDict]` to prevent type-related bugs when iterating over sessions.

### 3. Backend SSE Notifications

Added broadcasts in three endpoints:

**Lock Acquisition** (`fastapi_app/routers/files_locks.py:146-157`):

- Broadcasts when a file lock is acquired
- Includes `locked_by` username in event data
- Event reason: `"lock_acquired"`

**File Save** (`fastapi_app/routers/files_save.py`):

- Broadcasts on file updates (line 425-435)
- Broadcasts on new version creation (line 499-509)
- Broadcasts on new gold standard creation (line 570-580)
- Event reasons: `"file_saved"` or `"file_created"`

**File Deletion** (`fastapi_app/routers/files_delete.py:94-104`):

- Broadcasts when files are deleted
- Includes array of deleted `stable_ids`
- Event reason: `"files_deleted"`

### 4. Frontend SSE Listener

Updated `app/src/plugins/filedata.js:81-87`:

```javascript
// Listen for SSE events about file data changes
sse.addEventListener('fileDataChanged', (event) => {
  const data = JSON.parse(event.data);
  logger.debug(`File data changed (reason: ${data.reason}), reloading file data`);

  // Reload file data when changes occur from other sessions
  this.reload({ refresh: true });
});
```

## Event Structure

### fileDataChanged Events

Used for file metadata changes that require reloading file data:

```typescript
{
  reason: "lock_acquired" | "file_saved" | "file_created" | "files_deleted",
  stable_id?: string,           // For single file operations
  stable_ids?: string[],        // For bulk deletions
  locked_by?: string            // Only for lock_acquired
}
```

### lockReleased Events

Used when a file lock is released, allowing other clients to attempt acquiring it:

```typescript
{
  stable_id: string              // File that was unlocked
}
```

## Flow

### File Data Change Flow

1. User A performs action (lock, save, delete)
2. Backend endpoint executes the operation
3. Backend calls `broadcast_to_other_sessions()` with event details
4. SSE service sends event to all other connected sessions
5. User B's client receives `fileDataChanged` event via SSE listener
6. Frontend calls `FiledataPlugin.reload({ refresh: true })`
7. UI updates with latest file data

### Lock Release Flow (First Wins)

1. User A releases lock on document
2. Backend broadcasts `lockReleased` event to all other sessions
3. User B's client (viewing same doc in read-only) receives event
4. User B's client attempts to acquire lock via `client.acquireLock()`
5. First client to successfully acquire gets edit access
6. If User B wins: `editorReadOnly` set to `false`, shows success notification
7. If another client wins first: User B stays in read-only mode (silently)

### Document Deletion Flow

1. User A deletes a document (must have lock to delete)
2. Backend broadcasts `fileDataChanged` event with `reason: "files_deleted"` and `stable_ids` array
3. User B's client receives event
4. If User B is viewing one of the deleted documents:
   - Editor is cleared via `xmlEditor.clear()`
   - Application state is updated to clear `xml`, `pdf`, `diff`, and reset `editorReadOnly`
   - User sees warning notification: "The document you were viewing was deleted by another user"
5. File data list is reloaded for all clients to show updated file list

## Files Modified

### Backend

- `fastapi_app/lib/sse_utils.py` - New file with broadcast utility
- `fastapi_app/lib/sessions.py` - Added `SessionDict` TypedDict
- `fastapi_app/routers/files_locks.py` - Added lock acquisition and release broadcasts
- `fastapi_app/routers/files_save.py` - Added file save broadcasts
- `fastapi_app/routers/files_delete.py` - Added file deletion broadcast

### Frontend

- `app/src/plugins/filedata.js` - Added SSE listener for `fileDataChanged` events with document deletion handling
- `app/src/plugins/services.js` - Added SSE listener for `lockReleased` events with lock acquisition race and locked document notification
- `app/src/plugins/sse.js` - Removed debug logging

## Testing

All file locks API tests pass (10/10), confirming:

- Lock acquisition triggers broadcasts correctly
- Lock release triggers broadcasts correctly
- No type errors with `SessionDict` usage
- Broadcast function properly extracts session IDs from session dictionaries
- Events are sent to all sessions except the originating one

## User Notifications

- **Locked document on load**: When opening a document that's locked by another user, shows warning: "This document is being edited by another user"
- **Deleted document**: When viewing a document that gets deleted by another user, shows warning: "The document you were viewing was deleted by another user"
- **Lock acquired**: When successfully acquiring a lock after another user releases it, shows success: "You can now edit this document"

## Use Cases

- **Multi-user editing**: When User A locks a document, User B sees the updated lock status immediately
- **Lock handoff**: When User A releases a lock, all users viewing the same document in read-only mode race to acquire it - first wins
- **Automatic edit access**: User B viewing a locked document automatically gains edit access when User A releases the lock (if they win the race)
- **Locked document awareness**: User B trying to open a locked document sees a notification that another user is editing it
- **Deleted document handling**: User B viewing a document that User A deletes sees a notification and the editor is cleared
- **Collaborative workflows**: When User A saves changes to a gold standard, User B's file list updates automatically
- **Team coordination**: When User A deletes files, User B's view refreshes to reflect the deletions
- **Real-time awareness**: All users maintain synchronized views of file metadata across sessions
