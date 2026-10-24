# Messages for reviews and comments: specification

Status: implemented (2026-10-24), see [Implementation](#implementation) for the deviations from this spec. Builds on unit review (#620) and unit comments (#621), both on `devel`.

## Goal

Users learn about feedback on their work without opening each document:

- Negative reviews (not-OK marks) on documents they own, and comments addressed to them, appear as **messages**.
- An unread count shows as a badge on the toolbar's user menu button and on a new **Messages** item in the user menu, updated live over SSE.
- The Messages list opens the document with the review or comment focused.
- Users can reply to comments in documents they do not own.

Also in scope: the crowded editor status bar (see [Status bar fix](#status-bar-fix)).

## Terms

| Term | Meaning |
| --- | --- |
| Owner | `created_by` of the TEI file (the same field the access control uses). Files without owner have no owner messages. |
| Review message | One current `not-ok` (or `final-not-ok`) mark of one reviewer on one unit of a file the recipient owns. |
| Comment message | One comment (first comment or reply) that addresses the recipient. |
| Message key | Identity of a message across copies of a document, used for deduplication and read state. |
| Occurrence | One file in which a message's source is found. A message has one or more occurrences. |

## Who receives what

### Review messages

- Recipient: the owner of the file that holds the mark. The reviewer never receives their own mark (an owner reviewing their own file gets no message).
- Source: current marks with state `not-ok` in `listAnnotation[@type="unit-review"]`. Not counted: `ok`, stale marks (`was-not-ok`), and in `final` mode not-OK marks overridden by a final OK on the same unit.
- When the mark disappears from the newest occurrence (the unit was edited, so it became `was-not-ok`, or the reviewer changed it to OK), the message is **settled**: it stays in the list, greyed, but no longer counts as unread.
- If the mark's comment contains `@`-mentions, the mentioned users also receive it (as a comment-like message, see below).

### Comment messages

A comment addresses a user when:

1. the user is `@`-mentioned in it, or
2. it is a reply in a thread the user started (thread root author), or
3. it is a reply in a thread in which the user was mentioned earlier.

The author never receives their own comment. Rules 2 and 3 make a conversation work without retyping mentions; see [Open questions](#open-questions), item 1.

A thread that is resolved settles its comment messages (as for reviews).

## Mentions

### Syntax and storage

- In the text of a comment or of a not-OK mark's comment, `@<id>` mentions the person whose `teiHeader//fileDesc//respStmt/persName/@xml:id` is `<id>`. For users, this id is the user name (`ensureRespStmtForUser`).
- Storage is the plain text, e.g. `<note type="comment">@jdoe is "ibid." correct here?</note>`. No schema change: `standOffNote` stays text-only.
- Token rule (client and server use the same regex): `(?<![\w.@])@([A-Za-z0-9_][\w.-]*[\w])`. A token counts as a mention only if the id exists in the document's `respStmt` **and** is a user account. Other tokens (e-mail addresses, `@type`) are ordinary text.
- `respStmt` entries without a user account (GROBID, LLM reviewers, imported persons) are not offered.

### Editor

- Typing `@` in the comment prompt, the reply field and the not-OK comment field opens an autocomplete list of the document's respStmt persons that are users, showing full name and user name. Picking one inserts `@jdoe `.
- In the popovers, mentions render as a chip with the full name; the stored text keeps `@jdoe`.
- Mentioning someone not yet in `respStmt` is not possible via autocomplete; typed text stays plain text (see [Open questions](#open-questions), item 2).

## Deduplication across copies

New versions keep review marks and (with **Keep comments**) comments, so the same review or comment exists in several files. Only the most recent occurrence is used.

Message keys:

| Source | Key |
| --- | --- |
| Comment | `c:<doc_id>:<comment xml:id>` (ids such as `uc-k3f9a2` are copied with the comment) |
| Review mark | `r:<doc_id>:<variant>:<reviewer id>:<unit fingerprint>` |

Rules:

- All occurrences with the same key are one message. Its *newest occurrence* is the file with the latest `updated_at`; that file decides the text, the state (settled or not) and which file opens.
- A comment edited in a later copy (`change[@status="edited"]`) is the same message with the newer text; it does not become unread again.
- A file that drops a comment (new version without **Keep comments**, deletion) only removes that occurrence. The message disappears when no occurrence is left.
- For review messages, occurrences are limited to files owned by the same recipient, so a reviewer's mark copied into somebody else's version does not create a message for the original owner.

## Server-side index

Counting messages must not parse every TEI file per request. A derived index is updated on each save and can always be rebuilt from the files.

### Storage

New SQLite database `data/db/messages.db` (WAL mode, as the other databases; see `docs/code-assistant/database-connections.md`):

```sql
CREATE TABLE message (
  key           TEXT NOT NULL,      -- message key
  recipient     TEXT NOT NULL,      -- username
  kind          TEXT NOT NULL,      -- 'review' | 'comment' | 'mention'
  reason        TEXT NOT NULL,      -- 'owner' | 'mention' | 'thread-author' | 'thread-mention'
  doc_id        TEXT NOT NULL,
  stable_id     TEXT NOT NULL,      -- newest occurrence
  author        TEXT NOT NULL,      -- user name or LLM reviewer id
  author_name   TEXT,               -- display name
  text          TEXT NOT NULL,      -- comment / mark comment, may be empty
  excerpt       TEXT,               -- first 120 characters of the target element's text
  thread_id     TEXT,               -- uc-... (comments)
  fingerprint   TEXT,               -- unit fingerprint (reviews) or element fingerprint (comments)
  settled       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,      -- first time the index saw the key (see below)
  updated_at    TEXT NOT NULL,      -- last change of text or state
  PRIMARY KEY (key, recipient)
);
CREATE TABLE occurrence (
  key        TEXT NOT NULL,
  stable_id  TEXT NOT NULL,
  PRIMARY KEY (key, stable_id)
);
CREATE TABLE read_state (
  key        TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (key, recipient)
);
CREATE INDEX idx_message_recipient ON message(recipient, settled);
```

- `created_at` for comments is the `when` of the comment's first `change`. Review marks have no per-mark timestamp (only the reviewer's last `change`), so for them `created_at` is the time the indexer first saw the key. This avoids a schema change.
- `read_state` is separate from `message`, so rebuilding the index keeps what users have read.
- Unread = `message` row with `settled = 0` and no `read_state` row.

### Indexer

`fastapi_app/lib/messages/` (core, not a backend plugin, since the user menu, permissions and save path are core):

- `standoff_reader.py`: Python reading of both `listAnnotation` types, mirroring `app/src/modules/unit-review.js` (`readReviewData`, combined state for `final` mode) and `app/src/modules/unit-comments.js` (`readComments`, `buildThreads`, `threadStatus`). Shared test fixtures between the JS and Python unit tests keep them in step.
- `mentions.py`: the token rule and the respStmt lookup.
- `indexer.py`: `index_file(stable_id)` computes the set of `(key, recipient)` for one file, diffs it against the file's current `occurrence` rows, updates `message`/`occurrence`, recomputes the newest occurrence of each touched key, and returns the recipients whose unread count changed.
- Triggers: the existing `document.saved` event (`files_save.py`), plus file delete, move and the new reply endpoint. Not on `document.save` (fires before writing, no stable_id for new versions).
- Rebuild: `bin/` CLI command and a maintenance endpoint (admin) that re-indexes all TEI files; run once as migration when the feature is deployed. Files synced from another instance are indexed by the same `fileDataChanged` path the sync uses (to be checked in `fastapi_app/lib/sync`).

## API

New router `fastapi_app/routers/messages.py`, `/api/v1/messages`. Methods and typedefs go into the hand-maintained `app/src/modules/api-client-v1.js` in the same change.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/messages/count` | `{unread: int}` for the current user |
| GET | `/messages` | List; query `status=unread\|all` (default `all`), `kind`, `limit`, `offset`; newest first |
| POST | `/messages/read` | Body `{keys: [str], read: bool}`; marks read or unread, returns the new count |
| POST | `/messages/read-all` | Marks all unread messages read |
| POST | `/files/{stable_id}/comments/{thread_id}/replies` | Adds a reply to a comment thread (see [Permissions](#permissions)) |

List item (Pydantic `MessageItem`):

```json
{
  "key": "c:doc-123:uc-p81c0d",
  "kind": "comment",
  "reason": "mention",
  "doc_id": "doc-123",
  "stable_id": "x7k2m9",
  "doc_label": "Smith 2019, version 2",
  "author": "asmith",
  "author_name": "Anna Smith",
  "text": "@jdoe yes, it points to the previous entry.",
  "excerpt": "Ibid., p. 12",
  "thread_id": "uc-k3f9a2",
  "fingerprint": "b7d7ec9c",
  "settled": false,
  "read": false,
  "created_at": "2026-10-24T09:12:40Z"
}
```

The list filters by view access at request time (`check_file_access(..., 'read')`), so messages from files the user can no longer see are hidden and not counted.

## SSE events

The existing per-session SSE connection (`app/src/plugins/sse.js`, `SSEService.send_message`) carries one new event:

| Event | Data | Sent to |
| --- | --- | --- |
| `messagesChanged` | `{unread: int, added: [key], settled: [key]}` | All sessions of each recipient whose messages changed |

- New helper `send_to_user_sessions(sse_service, session_manager, username, event, data)` in `fastapi_app/lib/sse/sse_utils.py`, using the `username` column of the sessions table.
- Sent after indexing a save or reply, and after read/unread changes (so a second tab of the same user updates too).
- If `sse.enabled` is false, the client polls `/messages/count` every 60 seconds instead.

## Permissions

### Current state (finding)

Owner-only editing is enforced when acquiring a lock (`files_locks.py`, `check_file_access(..., 'edit')`) and by the read-only editor in the frontend. `files_save.py` only checks roles (gold, versions) and calls `acquire_lock()` directly, so the save endpoint itself does not check ownership. The reply endpoint must not rely on this gap; closing it is a separate fix (see [Open questions](#open-questions), item 6).

### Relaxation for replies

Replying to an existing comment thread is allowed in documents the user cannot edit. Only this operation is relaxed; starting a thread, resolving, editing or deleting still need edit access.

- Endpoint `POST /api/v1/files/{stable_id}/comments/{thread_id}/replies`, body `{text: str}`.
- Requires view access to the file and the `annotator` or `reviewer` role (or admin). Does not require ownership, editability or the lock.
- The server applies the change itself: parses the file, appends the reply `annotation[@motivation="replying"]` after the last reply of the thread (as `addReply` does; a reply to a resolved thread reopens it), adds the user to `respStmt` with resp `Commenter` if missing, serializes and saves the file in place (same stable_id, no new version, no `revisionDesc/change`, `last_revision` and status unchanged). Only `standOff` and `respStmt` change; the rest of the bytes stay as they are.
- Emits `fileDataChanged` and `document.saved` (so the index and the recent-documents plugin see it), and `messagesChanged` to the recipients.
- 404 if the thread does not exist in that file, 409 if it was deleted meanwhile.

### Concurrent editing by the owner

The owner may have the document open with unsaved changes while someone replies.

1. **Live merge**: the server sends `commentReplyAdded` `{stable_id, annotation_xml}` to the session that holds the lock. The owner's `unit-comments` plugin inserts the annotation into its buffer (as one undoable edit that does not count as a user edit for autosave purposes), so the reply shows at once and is saved with the owner's next save.
2. **Merge on save** (safety net): when saving over an existing file, `files_save.py` compares the `unit-comment` annotations of the stored and the incoming XML. Annotations present in the stored file, missing in the incoming one, and authored by someone other than the saving user are re-inserted, unless the saving user is an admin (admins may delete others' comments). Authors can only delete their own comments, so this cannot undo a legitimate deletion by a non-admin.

### Read-only documents in the editor

When a document is read-only for the user, the thread popover still shows the reply field. Submitting it calls the reply endpoint instead of editing the buffer, then reloads the file without changing the read-only state. The **Comment…** context-menu item stays disabled ("Create your own version to comment").

## User interface

### Badge on the user menu button

- `toolbar.js` gets `setMenuButtonBadge(count: number)`: a small `sl-badge` (pill, `danger` variant) on the user menu button; hidden at 0, `99+` above 99.
- Set on login (`onUserChange` → `GET /messages/count`) and on each `messagesChanged`.

### Messages menu item

- New item **Messages** in `user-menu-items.html`, between the full name and **User Profile**, with icon `envelope` and the unread count as a suffix badge.
- Clicking it opens the Messages dialog.

### Messages dialog

New plugin `app/src/plugins/messages.js` (deps: `client`, `toolbar`, `sse`, `services`, `unit-review`, `unit-comments`), template `messages-dialog.html`.

- `sl-dialog`, wide. Toolbar: segmented filter **Unread** / **All**, kind filter (**Reviews**, **Comments**), **Mark all as read**.
- One row per message, newest first: unread dot, kind icon (review: red mark; comment: speech bubble), document label, author, excerpt of the element, text (two lines, mentions as chips), relative date. Settled messages are greyed with a note ("unit edited", "resolved", "changed to OK").
- Per row: a read/unread toggle (envelope icon) and, for comments, **Reply** (inline field, uses the reply endpoint).
- Clicking a row opens the message: marks it read, closes the dialog, opens the document, focuses the source.
- Paging: 50 per page, "Load more".

### Opening a message

1. `services.load({ xml: stable_id })` (save-if-dirty as usual, like opening from the file drawer or the dashboard).
2. After load (`onStateUpdate` with the new `xml`):
   - Comment: `unitComments.openThread(thread_id)`, which scrolls to the element and opens the thread popover.
   - Review: switch review mode on (`unitReview.setEnabled(true)`, since marks are only shown in review mode), then a new `unitReview.openReviewAtUnit(fingerprint)` that scrolls to the unit and opens its popover (`openReview(line)` exists; the new method resolves the fingerprint to a line).
3. If the target no longer exists (unit edited, comment detached), the document opens and a notification says so; detached comments are in the diagnostics drawer.

### Dashboard (optional)

A "Messages" box on the login dashboard with the five newest unread messages, using the same list endpoint. Not required for the first version.

## Status bar fix

### Cause

Right-hand widgets and their priorities today: indent (1), separator (2), cursor position (3), review meter (4), comment meter (5); the centre navigation has 0; left: permission info (1), permissions dropdown (2), annotation switch (3). The priorities already rank the review UI above indent and cursor, but `status-bar.js` only rechecks overflow on resizing the bar itself (`ResizeObserver` on the bar) and on `slotchange`. The meters switch from `display:none` to `inline-flex` and change their text without either, so nothing is hidden and the bar clips.

### Change

1. `status-bar.js`: also observe each slotted widget with the `ResizeObserver` (added in `add()`, removed in `remove()`), so a widget that appears or grows triggers `checkAndResolveOverflow()`. Coalesce with `requestAnimationFrame`.
2. Hide separators with their neighbour: a `status-separator` gets the priority of the widget before it and is hidden when that widget is hidden.
3. Priorities: indent `-2`, its separator `-2`, cursor position `-1`, so both go before everything else, including the centre navigation (0). Review meter, comment meter and the review toggle keep their values.
4. Verify with `node scripts/dev/ui-screenshot.js` at a narrow editor width with review mode on and comments present.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Owner reviews or comments on their own file | No message to themselves. |
| Ownerless file (imported gold) | No review messages; comment messages work. |
| Ownership changes (granular mode `owner`) | Re-index the file; old owner's review messages are removed, read state kept by key. |
| LLM reviewer marks many units | One message per not-OK mark (see [Open questions](#open-questions), item 3). |
| Mark comment edited by the reviewer | Same key, newer text; stays read if read. |
| Reviewer changes not-OK to OK | Message settled. |
| Majority mode, unit disputed | Each not-OK mark is still a message. |
| Mention of a user who lost view access | Not listed or counted while access is missing. |
| User deleted | Their rows are deleted with the account. |
| Same comment in gold and in two versions | One message; opens the newest file. |
| Reply posted to an older copy | Not possible from the Messages list (it always opens the newest occurrence); from the editor the reply goes to the open file and creates a new key in that file only. |
| File deleted | Its occurrences go; messages without occurrences disappear. |
| SSE reconnect | Client refetches the count on `onopen`. |
| Two tabs of one user | Both get `messagesChanged`. |

## Implementation outline

1. Status bar fix (independent, can ship first).
2. Python stand-off reader with shared fixtures; mentions module.
3. `messages.db`, indexer, `document.saved` hook, rebuild CLI and migration.
4. `/api/v1/messages` router, API client methods, `send_to_user_sessions`, `messagesChanged`.
5. Reply endpoint, merge-on-save, `commentReplyAdded` live merge, read-only reply path in the popover.
6. Mention autocomplete and chips in the comment prompt, popover and not-OK comment field.
7. Toolbar badge, Messages menu item, Messages dialog, open-and-focus flow, `openReviewAtUnit`.
8. Docs: user manual page `docs/user-manual/messages.md`, updates to `unit-comments.md`, `unit-review` docs, `docs/code-assistant/architecture-backend.md` (messages.db), and `docs/history/<date>-messages.md` on the implementing branch.

Tests: Python unit tests for the reader (against the JS fixtures), indexer (dedup, settle, ownership), reply endpoint (permissions, byte-stability outside standOff, merge-on-save); JS unit tests for the mention regex and status-bar priorities; E2E: user A comments mentioning B, B sees the badge without reload, opens the message, replies in A's document, A sees the reply in the open editor.

## Implementation

Branch `claude/message-passing-spec` (PR #623), stacked on the version freeze (#622). The open questions were answered with the recommended options: replies reach the thread author and earlier mentions, the owner is always mentionable, LLM marks are collapsed per run, owners answer a review with a new comment thread mentioning the reviewer, users with view access and the `annotator` or `reviewer` role reply (gold files included), messages are kept, no e-mail. The save endpoint ownership gap is left for a separate change.

Deviations and additions:

| Topic | Spec | Implemented |
| --- | --- | --- |
| Review recipient | Owner of the file | Nearest owner in the version lineage (`parent_stable_id` chain) who is not the reviewer, so marks a reviewer sets in their own copy (owner-based and granular access control) reach the owner of the copied version |
| Storage | `message` table with the data, `occurrence` with key and file only | `occurrence` holds the data columns per key, recipient and file, plus `settled_note`; `message` is derived from the newest occurrence and keeps the first `created_at` |
| Settling | `settled` flag | A mark that disappears from a re-saved file stays as a settled occurrence with the note `changed-to-ok`, `unit-edited` or `superseded` (LLM run); a resolved thread settles its comments (`resolved`). The dialog shows the note |
| Mention token | `[A-Za-z0-9_][\w.-]*[\w]` (at least two characters) | `[A-Za-z0-9_](?:[\w.-]*\w)?`, so one-character user names work; Python uses `re.ASCII` to match JS |
| LLM marks | One message per file | One message per LLM review run, key `r:<doc_id>:<variant>:<llm id>:run-<when>`; a new run supersedes the old one |
| Reply in the dialog | Inline field for comments | Comments: inline field (opens the document instead when it is the one open in the editor); reviews: **Reply** opens the document with a comment prompt prefilled with `@reviewer` |
| Merge on save | Re-insert other users' comments | Also restores missing `respStmt` entries of comment authors; deleting one's own thread is respected; admins' saves are not merged |
| Rebuild | CLI and maintenance endpoint | `POST /api/v1/messages/rebuild` (admin) and `manage-remote maintenance rebuild-messages`; the index is also built in the background at startup when `messages.db` is missing, which replaces the one-off migration |
| SSE | `messagesChanged` | `messagesChanged` `{unread}` to all sessions of a recipient (`send_to_user_sessions`); without SSE the client polls the count every 60 seconds |
| Status bar | Priority hiding | `ResizeObserver` per widget triggers the overflow check, and separators are hidden together with their neighbour |

Not done: indexing files that arrive by sync or by a move (a rebuild picks them up), the dashboard box, and an E2E test of the full mention and reply round trip (covered by API and unit tests and a manual check).

## Open questions

1. **Addressees of replies.** Recommended: mentions, plus replies to the thread author and to users mentioned earlier in the thread (rules 2 and 3). Alternative: mentions only.
2. **Mentioning people not in `respStmt`.** The requirement limits `@` to respStmt persons. Should the document owner always be mentionable even if missing from `respStmt` (e.g. imported files)? Recommended: yes, add the owner to the autocomplete.
3. **LLM review volume.** An LLM review can produce dozens of not-OK marks. Recommended: collapse the LLM's not-OK marks on one file into one message ("LLM Reviewer flagged 7 units"), opening at the first unit. Alternative: one message per mark like humans, or no messages for LLM marks.
4. **Replying to reviews.** Should a review message have a **Reply** too? Recommended: yes, as a new comment thread on the unit by the owner (who can edit the file), mentioning the reviewer, so reviews and comments share one conversation mechanism.
5. **Who may reply in non-owned files.** Recommended: users with view access and the `annotator` or `reviewer` role. Should gold files be included for annotators (they cannot edit gold otherwise)?
6. **Save endpoint ownership gap.** `files_save.py` does not check ownership. Fix it in the same work (reject saves to files the user cannot edit, except via the reply endpoint), or separately?
7. **Retention.** Keep settled and read messages forever, or drop settled messages after N days? Recommended: keep, the list is paged.
8. **E-mail notifications.** Out of scope here; the index and `messagesChanged` hook would allow them later.
