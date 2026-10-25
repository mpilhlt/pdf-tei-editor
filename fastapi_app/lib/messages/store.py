"""
Storage of the message index in `data/db/messages.db` (see docs/user-manual/messages.md).

The index is derived from the TEI files and can be rebuilt from them, except for the read state
(`read_state`, kept by message key) and the settled state of review marks that have since been
removed from a file (see `indexer.py`).

Tables:

- `occurrence`: one message source (a comment or review mark addressed to a recipient) in one
  file, with the data the file holds for it.
- `message`: one row per message key and recipient, taken from its newest occurrence (the file
  with the latest `updated_at`).
- `read_state`: which recipient has read which message.
"""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi_app.lib.core.db_utils import get_connection, init_database, transaction

logger = logging.getLogger(__name__)

DB_FILE_NAME = "messages.db"

MessageKind = Literal["review", "comment", "mention", "review-request"]
MessageReason = Literal["owner", "mention", "thread-author", "thread-mention", "reviewer"]

MESSAGES_SCHEMA = """
CREATE TABLE IF NOT EXISTS occurrence (
    key             TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    stable_id       TEXT NOT NULL,
    doc_id          TEXT NOT NULL,
    kind            TEXT NOT NULL,
    reason          TEXT NOT NULL,
    author          TEXT NOT NULL,
    author_name     TEXT,
    text            TEXT NOT NULL,
    excerpt         TEXT,
    thread_id       TEXT,
    fingerprint     TEXT,
    settled         INTEGER NOT NULL DEFAULT 0,
    settled_note    TEXT,
    source_created_at TEXT,
    file_updated_at TEXT NOT NULL,
    PRIMARY KEY (key, recipient, stable_id)
);
CREATE INDEX IF NOT EXISTS idx_occurrence_stable_id ON occurrence(stable_id);

CREATE TABLE IF NOT EXISTS message (
    key           TEXT NOT NULL,
    recipient     TEXT NOT NULL,
    kind          TEXT NOT NULL,
    reason        TEXT NOT NULL,
    doc_id        TEXT NOT NULL,
    stable_id     TEXT NOT NULL,
    author        TEXT NOT NULL,
    author_name   TEXT,
    text          TEXT NOT NULL,
    excerpt       TEXT,
    thread_id     TEXT,
    fingerprint   TEXT,
    settled       INTEGER NOT NULL DEFAULT 0,
    settled_note  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (key, recipient)
);
CREATE INDEX IF NOT EXISTS idx_message_recipient ON message(recipient, settled);

CREATE TABLE IF NOT EXISTS read_state (
    key        TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    read_at    TEXT NOT NULL,
    PRIMARY KEY (key, recipient)
);
"""

# Columns that an occurrence and a message share
_DATA_COLUMNS = (
    "doc_id", "kind", "reason", "author", "author_name", "text", "excerpt", "thread_id", "fingerprint",
    "settled", "settled_note",
)


def now_iso() -> str:
    """The current time as an ISO timestamp in UTC."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Occurrence:
    """One message source in one file."""

    key: str
    recipient: str
    stable_id: str
    doc_id: str
    kind: MessageKind
    reason: MessageReason
    author: str
    author_name: str | None
    text: str
    excerpt: str | None
    thread_id: str | None
    fingerprint: str | None
    settled: bool
    settled_note: str | None
    source_created_at: str | None
    file_updated_at: str


@dataclass
class MessageRow:
    """A message of one recipient, as stored."""

    key: str
    recipient: str
    kind: MessageKind
    reason: MessageReason
    doc_id: str
    stable_id: str
    author: str
    author_name: str | None
    text: str
    excerpt: str | None
    thread_id: str | None
    fingerprint: str | None
    settled: bool
    settled_note: str | None
    created_at: str
    updated_at: str
    read: bool


class MessageStore:
    """The message index and read state."""

    def __init__(self, db_dir: Path):
        """
        Args:
            db_dir: Directory of the application databases
        """
        self.db_path = Path(db_dir) / DB_FILE_NAME
        init_database(self.db_path, MESSAGES_SCHEMA, logger)

    # ── Occurrences ─────────────────────────────────────────────────────

    def occurrences_of_file(self, stable_id: str) -> list[Occurrence]:
        """All occurrences in one file."""
        rows = get_connection(self.db_path).execute(
            "SELECT * FROM occurrence WHERE stable_id = ?", (stable_id,)
        ).fetchall()
        return [_row_to_occurrence(row) for row in rows]

    def occurrences_of_message(self, key: str, recipient: str) -> list[Occurrence]:
        """All occurrences of one message."""
        rows = get_connection(self.db_path).execute(
            "SELECT * FROM occurrence WHERE key = ? AND recipient = ?", (key, recipient)
        ).fetchall()
        return [_row_to_occurrence(row) for row in rows]

    def replace_file_occurrences(self, stable_id: str, occurrences: list[Occurrence]) -> None:
        """Replaces the occurrences of a file."""
        with transaction(self.db_path) as conn:
            conn.execute("DELETE FROM occurrence WHERE stable_id = ?", (stable_id,))
            conn.executemany(
                """
                INSERT INTO occurrence (key, recipient, stable_id, doc_id, kind, reason, author, author_name, text, excerpt,
                    thread_id, fingerprint, settled, settled_note, source_created_at, file_updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (o.key, o.recipient, o.stable_id, o.doc_id, o.kind, o.reason, o.author, o.author_name, o.text,
                     o.excerpt, o.thread_id, o.fingerprint, int(o.settled), o.settled_note, o.source_created_at,
                     o.file_updated_at)
                    for o in occurrences
                ],
            )

    def indexed_stable_ids(self) -> set[str]:
        """The files that have occurrences."""
        rows = get_connection(self.db_path).execute("SELECT DISTINCT stable_id FROM occurrence").fetchall()
        return {row["stable_id"] for row in rows}

    # ── Messages ────────────────────────────────────────────────────────

    def get_message(self, key: str, recipient: str) -> MessageRow | None:
        """One message, or None."""
        row = get_connection(self.db_path).execute(
            """
            SELECT m.*, r.read_at IS NOT NULL AS is_read FROM message m
            LEFT JOIN read_state r ON r.key = m.key AND r.recipient = m.recipient
            WHERE m.key = ? AND m.recipient = ?
            """,
            (key, recipient),
        ).fetchone()
        return _row_to_message(row) if row else None

    def refresh_message(self, key: str, recipient: str) -> bool:
        """
        Recomputes a message from its newest occurrence, or deletes it if it has none left.

        Returns:
            True if the message was added, removed, or its data changed
        """
        occurrences = self.occurrences_of_message(key, recipient)
        existing = self.get_message(key, recipient)
        with transaction(self.db_path) as conn:
            if not occurrences:
                if existing is None:
                    return False
                conn.execute("DELETE FROM message WHERE key = ? AND recipient = ?", (key, recipient))
                return True
            newest = max(occurrences, key=lambda o: (o.file_updated_at, o.stable_id))
            data = {column: getattr(newest, column) for column in _DATA_COLUMNS}
            data["settled"] = int(newest.settled)
            if existing is not None:
                old = {column: getattr(existing, column) for column in _DATA_COLUMNS}
                old["settled"] = int(existing.settled)
                if old == data and existing.stable_id == newest.stable_id:
                    return False
                created_at = existing.created_at
            else:
                created_at = min(
                    (o.source_created_at for o in occurrences if o.source_created_at), default=None
                ) or now_iso()
            conn.execute(
                """
                INSERT INTO message (key, recipient, kind, reason, doc_id, stable_id, author, author_name, text, excerpt,
                    thread_id, fingerprint, settled, settled_note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key, recipient) DO UPDATE SET
                    kind = excluded.kind, reason = excluded.reason, doc_id = excluded.doc_id,
                    stable_id = excluded.stable_id, author = excluded.author, author_name = excluded.author_name,
                    text = excluded.text, excerpt = excluded.excerpt, thread_id = excluded.thread_id,
                    fingerprint = excluded.fingerprint, settled = excluded.settled,
                    settled_note = excluded.settled_note, updated_at = excluded.updated_at
                """,
                (key, recipient, data["kind"], data["reason"], data["doc_id"], newest.stable_id, data["author"],
                 data["author_name"], data["text"], data["excerpt"], data["thread_id"], data["fingerprint"],
                 data["settled"], data["settled_note"], created_at, now_iso()),
            )
            return True

    def list_messages(self, recipient: str, unread_only: bool = False, kind: MessageKind | None = None) -> list[MessageRow]:
        """The messages of a recipient, newest first (unpaged; access filtering and paging happen in the caller)."""
        conditions = ["m.recipient = ?"]
        params: list[str] = [recipient]
        if unread_only:
            conditions.append("m.settled = 0 AND r.read_at IS NULL")
        if kind == "review":
            conditions.append("(m.key LIKE 'r:%' OR m.key LIKE 'q:%')")
        elif kind == "comment":
            conditions.append("m.key LIKE 'c:%'")
        elif kind is not None:
            conditions.append("m.kind = ?")
            params.append(kind)
        rows = get_connection(self.db_path).execute(
            f"""
            SELECT m.*, r.read_at IS NOT NULL AS is_read FROM message m
            LEFT JOIN read_state r ON r.key = m.key AND r.recipient = m.recipient
            WHERE {' AND '.join(conditions)}
            ORDER BY m.created_at DESC, m.key
            """,
            tuple(params),
        ).fetchall()
        return [_row_to_message(row) for row in rows]

    def delete_recipient(self, recipient: str) -> None:
        """Removes all rows of a recipient (when the user account is deleted)."""
        with transaction(self.db_path) as conn:
            for table in ("occurrence", "message", "read_state"):
                conn.execute(f"DELETE FROM {table} WHERE recipient = ?", (recipient,))

    def clear_index(self) -> None:
        """Removes all occurrences and messages, keeping the read state (before a rebuild)."""
        with transaction(self.db_path) as conn:
            conn.execute("DELETE FROM occurrence")
            conn.execute("DELETE FROM message")

    # ── Read state ──────────────────────────────────────────────────────

    def set_read(self, recipient: str, keys: list[str], read: bool) -> None:
        """Marks messages of a recipient as read or unread."""
        with transaction(self.db_path) as conn:
            if read:
                conn.executemany(
                    "INSERT OR IGNORE INTO read_state (key, recipient, read_at) VALUES (?, ?, ?)",
                    [(key, recipient, now_iso()) for key in keys],
                )
            else:
                conn.executemany(
                    "DELETE FROM read_state WHERE key = ? AND recipient = ?", [(key, recipient) for key in keys]
                )


def _row_to_occurrence(row: sqlite3.Row) -> Occurrence:
    return Occurrence(
        key=row["key"], recipient=row["recipient"], stable_id=row["stable_id"], doc_id=row["doc_id"],
        kind=row["kind"], reason=row["reason"], author=row["author"], author_name=row["author_name"],
        text=row["text"], excerpt=row["excerpt"], thread_id=row["thread_id"], fingerprint=row["fingerprint"],
        settled=bool(row["settled"]), settled_note=row["settled_note"], source_created_at=row["source_created_at"],
        file_updated_at=row["file_updated_at"],
    )


def _row_to_message(row: sqlite3.Row) -> MessageRow:
    return MessageRow(
        key=row["key"], recipient=row["recipient"], kind=row["kind"], reason=row["reason"], doc_id=row["doc_id"],
        stable_id=row["stable_id"], author=row["author"], author_name=row["author_name"], text=row["text"],
        excerpt=row["excerpt"], thread_id=row["thread_id"], fingerprint=row["fingerprint"],
        settled=bool(row["settled"]), settled_note=row["settled_note"], created_at=row["created_at"],
        updated_at=row["updated_at"], read=bool(row["is_read"]),
    )
