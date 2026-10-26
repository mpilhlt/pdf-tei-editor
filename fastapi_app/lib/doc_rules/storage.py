"""
Generic storage for the document rules registry: user-owned overrides of
a resource and each user's current selection per resource. Both tables
are resource-kind-agnostic (see migration 009); business logic that
knows about specific kinds lives in kinds.py and its implementations,
not here.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi_app.lib.core.database import DatabaseManager


class DocumentRulesStore:
    """CRUD for resource_overrides and resolution/selection for resource_selection."""

    def __init__(self, db: DatabaseManager):
        self.db = db

    def list_overrides(self, kind: str, resource_key: str, owner: str) -> list[dict]:
        return self.db.execute_query(
            "SELECT * FROM resource_overrides WHERE kind = ? AND resource_key = ? AND owner = ? ORDER BY created_at",
            (kind, resource_key, owner),
        )

    def get_override(self, override_id: str) -> Optional[dict]:
        return self.db.execute_query(
            "SELECT * FROM resource_overrides WHERE id = ?", (override_id,), fetch_one=True
        )

    def create_override(
        self,
        kind: str,
        resource_key: str,
        owner: str,
        note: str,
        text: str,
        format: str,
        base_url: str,
        base_hash: str,
    ) -> dict:
        override_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        self.db.execute_update(
            """
            INSERT INTO resource_overrides
                (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (override_id, kind, resource_key, owner, note, text, format, base_url, base_hash, now, now),
        )
        # Built from the values just inserted rather than re-queried, so this
        # can never race with a concurrent delete of the row we just wrote.
        return {
            "id": override_id,
            "kind": kind,
            "resource_key": resource_key,
            "owner": owner,
            "note": note,
            "text": text,
            "format": format,
            "base_url": base_url,
            "base_hash": base_hash,
            "created_at": now,
            "updated_at": now,
        }

    def update_override(
        self, override_id: str, owner: str, note: Optional[str], text: Optional[str]
    ) -> Optional[dict]:
        """Update note and/or text (whichever is not None). Returns None if not found or not owned by `owner`."""
        existing = self.get_override(override_id)
        if existing is None or existing["owner"] != owner:
            return None
        new_note = existing["note"] if note is None else note
        new_text = existing["text"] if text is None else text
        now = datetime.now(timezone.utc).isoformat()
        self.db.execute_update(
            "UPDATE resource_overrides SET note = ?, text = ?, updated_at = ? WHERE id = ?",
            (new_note, new_text, now, override_id),
        )
        return self.get_override(override_id)

    def delete_override(self, override_id: str, owner: str) -> bool:
        """Delete an override owned by `owner`. Cascades to any selection pointing at it (foreign key). Returns False if not found or not owned by `owner`."""
        existing = self.get_override(override_id)
        if existing is None or existing["owner"] != owner:
            return False
        self.db.execute_update("DELETE FROM resource_overrides WHERE id = ?", (override_id,))
        return True

    def get_selection(self, kind: str, resource_key: str, owner: str) -> Optional[str]:
        row = self.db.execute_query(
            "SELECT override_id FROM resource_selection WHERE owner = ? AND kind = ? AND resource_key = ?",
            (owner, kind, resource_key),
            fetch_one=True,
        )
        return row["override_id"] if row else None

    def set_selection(self, kind: str, resource_key: str, owner: str, override_id: Optional[str]) -> None:
        """Select `override_id` for this resource, or clear the selection (back to "original") if None."""
        if override_id is None:
            self.db.execute_update(
                "DELETE FROM resource_selection WHERE owner = ? AND kind = ? AND resource_key = ?",
                (owner, kind, resource_key),
            )
            return
        self.db.execute_update(
            """
            INSERT INTO resource_selection (owner, kind, resource_key, override_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(owner, kind, resource_key) DO UPDATE SET override_id = excluded.override_id
            """,
            (owner, kind, resource_key, override_id),
        )

    def reset_selection(self, owner: str, resources: list[tuple[str, str]]) -> None:
        """
        Clear the selection for each (kind, resource_key) pair, keeping all
        overrides. Each pair is cleared in its own transaction; a failure
        partway through leaves earlier pairs cleared and later ones
        untouched rather than rolling back as a whole. Acceptable given the
        expected size of `resources` (the rule/schema resources of one
        document, typically single digits).
        """
        for kind, resource_key in resources:
            self.set_selection(kind, resource_key, owner, None)

    def migrate_resource_key(self, kind: str, old_key: str, new_key: str) -> int:
        """
        Move every owner's overrides and selection of `kind` from `old_key` to
        `new_key`, skipping an owner who already has an override or selection
        under `new_key` (their old-key rows are left as they are). A selection
        whose override no longer exists is cleared rather than moved, since
        foreign keys may not be enforced. Returns the number of rows moved;
        a no-op when the keys are equal.
        """
        if old_key == new_key:
            return 0
        moved = 0
        with self.db.transaction() as conn:
            owners = [row[0] for row in conn.execute(
                "SELECT owner FROM resource_overrides WHERE kind = ? AND resource_key = ? UNION SELECT owner FROM resource_selection WHERE kind = ? AND resource_key = ?",
                (kind, old_key, kind, old_key),
            ).fetchall()]
            for owner in owners:
                has_new_rows = conn.execute(
                    "SELECT 1 FROM resource_overrides WHERE kind = ? AND resource_key = ? AND owner = ? UNION ALL SELECT 1 FROM resource_selection WHERE kind = ? AND resource_key = ? AND owner = ? LIMIT 1",
                    (kind, new_key, owner, kind, new_key, owner),
                ).fetchone()
                if has_new_rows is not None:
                    continue
                params = (new_key, kind, old_key, owner)
                moved += conn.execute(
                    "UPDATE resource_overrides SET resource_key = ? WHERE kind = ? AND resource_key = ? AND owner = ?",
                    params,
                ).rowcount
                moved += conn.execute(
                    "UPDATE resource_selection SET resource_key = ? WHERE kind = ? AND resource_key = ? AND owner = ? AND override_id IN (SELECT id FROM resource_overrides)",
                    params,
                ).rowcount
                conn.execute(
                    "DELETE FROM resource_selection WHERE kind = ? AND resource_key = ? AND owner = ?",
                    (kind, old_key, owner),
                )
        return moved

    def get_selected_override_text(self, kind: str, resource_key: str, owner: str) -> Optional[str]:
        """The selected override's text, or None if this resource currently uses the original."""
        override_id = self.get_selection(kind, resource_key, owner)
        if override_id is None:
            return None
        override = self.get_override(override_id)
        return override["text"] if override else None
