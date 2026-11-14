"""
Storage of the users' bookmarks in `data/db/bookmarks.db` (see docs/user-manual/bookmarks.md).

A bookmark belongs to one user and is visible only to them. It points at an element below
`/TEI/text` of one file (`stable_id`), anchored like a unit comment by the element's XPath and a
fingerprint of its content (see `app/src/modules/node-anchor.js`), so that the element is found
again after edits.

A bookmark is deleted together with its file: the `file.deleted` event removes the bookmarks of
a deleted file. The garbage collection removes those of files that are deleted or purged by other
means (e.g. synchronization) and of removed users.
"""

import logging
import sqlite3
import asyncio
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi_app.config import get_settings
from fastapi_app.lib.core.db_utils import get_connection, init_database, transaction
from fastapi_app.lib.core.gc_registry import GcContext, GcResult, register_gc_task
from fastapi_app.lib.permissions.user_utils import list_users

logger = logging.getLogger(__name__)

DB_FILE_NAME = "bookmarks.db"

BOOKMARKS_SCHEMA = """
CREATE TABLE IF NOT EXISTS bookmark (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    stable_id   TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    path        TEXT NOT NULL,
    fingerprint TEXT,
    element     TEXT NOT NULL,
    title       TEXT NOT NULL,
    excerpt     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmark_username ON bookmark(username, created_at);
CREATE INDEX IF NOT EXISTS idx_bookmark_stable_id ON bookmark(stable_id);
"""


def now_iso() -> str:
    """The current time as an ISO timestamp in UTC."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Bookmark:
    """A stored bookmark."""

    id: str
    username: str
    stable_id: str
    doc_id: str
    path: str
    fingerprint: str | None
    element: str
    title: str
    excerpt: str | None
    created_at: str
    updated_at: str


def _row_to_bookmark(row: sqlite3.Row) -> Bookmark:
    return Bookmark(
        id=row["id"], username=row["username"], stable_id=row["stable_id"], doc_id=row["doc_id"], path=row["path"],
        fingerprint=row["fingerprint"], element=row["element"], title=row["title"], excerpt=row["excerpt"],
        created_at=row["created_at"], updated_at=row["updated_at"],
    )


class BookmarkStore:
    """The bookmarks of all users."""

    def __init__(self, db_dir: Path):
        """
        Args:
            db_dir: Directory of the application databases
        """
        self.db_path = Path(db_dir) / DB_FILE_NAME
        init_database(self.db_path, BOOKMARKS_SCHEMA, logger)

    def add(
        self, username: str, stable_id: str, doc_id: str, path: str, fingerprint: str | None, element: str,
        title: str, excerpt: str | None,
    ) -> Bookmark:
        """Adds a bookmark of a user and returns it."""
        now = now_iso()
        bookmark = Bookmark(
            id=uuid.uuid4().hex, username=username, stable_id=stable_id, doc_id=doc_id, path=path,
            fingerprint=fingerprint, element=element, title=title, excerpt=excerpt, created_at=now, updated_at=now,
        )
        with transaction(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO bookmark (id, username, stable_id, doc_id, path, fingerprint, element, title, excerpt,
                    created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (bookmark.id, username, stable_id, doc_id, path, fingerprint, element, title, excerpt, now, now),
            )
        return bookmark

    def get(self, username: str, bookmark_id: str) -> Bookmark | None:
        """A bookmark of a user, or None if the user has no bookmark with this id."""
        row = get_connection(self.db_path).execute(
            "SELECT * FROM bookmark WHERE id = ? AND username = ?", (bookmark_id, username)
        ).fetchone()
        return _row_to_bookmark(row) if row else None

    def list(self, username: str, stable_id: str | None = None) -> list[Bookmark]:
        """The bookmarks of a user, newest first, optionally only those of one file."""
        if stable_id is None:
            rows = get_connection(self.db_path).execute(
                "SELECT * FROM bookmark WHERE username = ? ORDER BY created_at DESC, id", (username,)
            ).fetchall()
        else:
            rows = get_connection(self.db_path).execute(
                "SELECT * FROM bookmark WHERE username = ? AND stable_id = ? ORDER BY created_at DESC, id",
                (username, stable_id),
            ).fetchall()
        return [_row_to_bookmark(row) for row in rows]

    def rename(self, username: str, bookmark_id: str, title: str) -> Bookmark | None:
        """Changes the title of a bookmark; returns it, or None if the user has no such bookmark."""
        with transaction(self.db_path) as conn:
            cursor = conn.execute(
                "UPDATE bookmark SET title = ?, updated_at = ? WHERE id = ? AND username = ?",
                (title, now_iso(), bookmark_id, username),
            )
            if cursor.rowcount == 0:
                return None
        return self.get(username, bookmark_id)

    def delete(self, username: str, bookmark_id: str) -> bool:
        """Deletes a bookmark of a user; returns False if the user has no such bookmark."""
        with transaction(self.db_path) as conn:
            cursor = conn.execute("DELETE FROM bookmark WHERE id = ? AND username = ?", (bookmark_id, username))
            return cursor.rowcount > 0

    def delete_of_file(self, stable_id: str) -> set[str]:
        """Deletes the bookmarks of a file; returns the users who had bookmarks on it."""
        with transaction(self.db_path) as conn:
            rows = conn.execute("SELECT DISTINCT username FROM bookmark WHERE stable_id = ?", (stable_id,)).fetchall()
            conn.execute("DELETE FROM bookmark WHERE stable_id = ?", (stable_id,))
        return {row["username"] for row in rows}

    def stable_ids(self) -> set[str]:
        """The files that have bookmarks."""
        rows = get_connection(self.db_path).execute("SELECT DISTINCT stable_id FROM bookmark").fetchall()
        return {row["stable_id"] for row in rows}

    def usernames(self) -> set[str]:
        """The users who have bookmarks."""
        rows = get_connection(self.db_path).execute("SELECT DISTINCT username FROM bookmark").fetchall()
        return {row["username"] for row in rows}

    def count_of(self, *, stable_ids: set[str] | None = None, usernames: set[str] | None = None) -> int:
        """The number of bookmarks of the given files or users."""
        column, values = ("stable_id", stable_ids) if stable_ids is not None else ("username", usernames or set())
        if not values:
            return 0
        placeholders = ",".join("?" for _ in values)
        row = get_connection(self.db_path).execute(
            f"SELECT COUNT(*) AS n FROM bookmark WHERE {column} IN ({placeholders})", tuple(values)
        ).fetchone()
        return int(row["n"])

    def delete_of(self, *, stable_ids: set[str] | None = None, usernames: set[str] | None = None) -> int:
        """Deletes the bookmarks of the given files or users; returns their number."""
        column, values = ("stable_id", stable_ids) if stable_ids is not None else ("username", usernames or set())
        if not values:
            return 0
        placeholders = ",".join("?" for _ in values)
        with transaction(self.db_path) as conn:
            cursor = conn.execute(f"DELETE FROM bookmark WHERE {column} IN ({placeholders})", tuple(values))
            return cursor.rowcount


_stores: dict[str, BookmarkStore] = {}
_stores_lock = threading.Lock()


def get_bookmark_store(db_dir: Path | None = None) -> BookmarkStore:
    """The bookmark store of a db directory (default: the configured one)."""
    db_dir = Path(db_dir or get_settings().db_dir)
    with _stores_lock:
        store = _stores.get(str(db_dir))
        if store is None:
            store = BookmarkStore(db_dir)
            _stores[str(db_dir)] = store
        return store


def reset_bookmark_stores() -> None:
    """Forgets the store singletons (tests)."""
    with _stores_lock:
        _stores.clear()


def collect_bookmark_garbage(ctx: GcContext) -> GcResult:
    """GC task: removes the bookmarks of deleted or purged files and of removed users."""
    store = get_bookmark_store(ctx.db_dir)
    dead_files = {sid for sid in store.stable_ids() if ctx.file_repo.get_file_by_stable_id(sid) is None}
    existing_users = {u["username"] for u in list_users(ctx.db_dir) if u.get("username")}
    removed_users = store.usernames() - existing_users
    if ctx.dry_run:
        files_count = store.count_of(stable_ids=dead_files)
        users_count = store.count_of(usernames=removed_users)
    else:
        files_count = store.delete_of(stable_ids=dead_files)
        users_count = store.delete_of(usernames=removed_users)
    return GcResult(
        items_deleted=files_count + users_count,
        details={"deleted_file_bookmarks": files_count, "removed_user_bookmarks": users_count},
    )


def register_bookmark_gc_task() -> None:
    """Registers the cleanup of the bookmarks; runs after the file purge."""
    register_gc_task("bookmarks", "Bookmarks", collect_bookmark_garbage, order=610)


def delete_file_bookmarks(stable_id: str, db_dir: Path | None = None) -> set[str]:
    """Deletes the bookmarks of a deleted file; returns the users who had bookmarks on it."""
    usernames = get_bookmark_store(db_dir).delete_of_file(stable_id)
    if usernames:
        logger.info(f"Deleted the bookmarks of {len(usernames)} user(s) on deleted file {stable_id}")
    return usernames


async def on_file_deleted(stable_id: str, **kwargs: Any) -> None:
    """`file.deleted` handler: deletes the bookmarks of the file and refreshes the owners' open lists."""
    if not stable_id:
        return
    from fastapi_app.lib.core.dependencies import get_session_manager, get_sse_service
    from fastapi_app.lib.sse.sse_utils import send_to_user_sessions

    usernames = await asyncio.to_thread(delete_file_bookmarks, stable_id)
    for username in usernames:
        send_to_user_sessions(get_sse_service(), get_session_manager(), username, "bookmarksChanged", {})


_hooks_registered = threading.Event()


def register_bookmark_hooks() -> None:
    """Subscribes the bookmark cleanup to the `file.deleted` event (once per process)."""
    from fastapi_app.lib.sse.event_bus import get_event_bus

    if _hooks_registered.is_set():
        return
    get_event_bus().on("file.deleted", on_file_deleted)
    _hooks_registered.set()
