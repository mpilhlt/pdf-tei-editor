# Active Sessions Plugin

Admin plugin that lists all active user sessions and lets an administrator end them.

## Features

- Lists every session with abbreviated session ID, age, last access time and owner (full name and username)
- Removes a single session, or all sessions except the administrator's own
- Sends a `forceLogout` SSE event with a configurable message to each affected client before deleting its session
- Refreshes the table every 5 seconds

## Usage

1. Open the "Backend Plugins" menu
2. Select "Active Sessions"
3. Click "Remove" on a row, or "End All Sessions" in the footer. The text field next to the button sets the message shown to logged-out users.

The administrator's own session cannot be removed.

## Routes

All routes require the admin role.

- `GET /api/plugins/active-sessions/view` - HTML page (DataTables)
- `GET /api/plugins/active-sessions/data` - Session rows as DataTables JSON
- `POST /api/plugins/active-sessions/remove` - Body `{"target_session_id": "...", "message": "..."}`
- `POST /api/plugins/active-sessions/remove-all` - Body `{"message": "..."}` (optional); returns the number of removed sessions

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **View**: [static/view.html](static/view.html), [static/view.js](static/view.js)

## Technical Details

- Category: `admin`
- Requires: Admin role
- State parameters: none
