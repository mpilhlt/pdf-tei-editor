# Revision Feed Plugin

Provides one Atom feed per project with the TEI `<revisionDesc>` changes of its documents, so users can follow annotation progress in a feed reader.

## Features

- One feed per project, covering all TEI documents in the project's collections
- Includes every `<change>` element whose `@status` is in a configurable allowlist, not only the last change of a document
- Newest 50 entries per feed; each entry links back to the document in the editor
- Feeds are authenticated with a per-user token in the query string, so they work in feed readers without a session
- "Revision Feeds" entry in the user menu that lists the user's feed URLs and regenerates the token

## Usage

1. Open the user menu and select "Revision Feeds"
2. Copy the URL of a project's feed into a feed reader
3. Click "Regenerate token" to invalidate all previously issued feed URLs

## Configuration

| Config key | Environment variable | Default |
| --- | --- | --- |
| `plugin.revision-feed.included-statuses` | `REVISION_FEED_INCLUDED_STATUSES` | All statuses in `annotation.lifecycle.order` except `extraction` |

## Routes

- `GET /api/plugins/revision-feed/my-feeds` - Token and feed URLs for the current user's projects (session auth)
- `POST /api/plugins/revision-feed/token/regenerate` - Issue a new token (session auth)
- `GET /api/plugins/revision-feed/feed/<project_id>.atom?token=<token>` - Atom feed (token auth; the token's user must have access to one of the project's collections)

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Revision parsing and Atom generation**: [revisions.py](revisions.py)
- **Token storage**: [token_store.py](token_store.py)
- **Frontend extension**: [extensions/revision-feed.js](extensions/revision-feed.js)
- **Tests**: [tests/](tests/)

## Technical Details

- Category: `collection`
- Requires: User role or higher
- Tokens are stored in `data/plugins/revision_feed/tokens.json` (one per user), guarded by a thread lock and a file lock
- The Atom feed is built with lxml; there is no feed library dependency
