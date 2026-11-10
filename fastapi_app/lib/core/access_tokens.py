"""
Personal access tokens for API authentication.

A token has the form ``pte_<id>_<secret>``: ``<id>`` is 8 random base32 characters (public, used to
list and revoke the token), ``<secret>`` is 32 random bytes in URL-safe base64. Only the SHA-256 hash
of the secret is stored; the full token is returned once, by :meth:`AccessTokenStore.create`.

A token carries no roles of its own. It authenticates as its user, whose current roles and groups
apply. Clients exchange it for a normal session with ``POST /api/v1/auth/token-login``.

Tokens are stored in ``access_tokens.db`` in the db directory.
"""

import hashlib
import hmac
import secrets
import sqlite3
import time
from pathlib import Path
from typing import TYPE_CHECKING, Optional, TypedDict

from fastapi_app.lib.core.db_utils import get_connection, init_database

if TYPE_CHECKING:
    from fastapi_app.lib.core.sessions import SessionManager

TOKEN_PREFIX = "pte_"
TOKEN_ID_LENGTH = 8
_TOKEN_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
_SECRET_BYTES = 32

ACCESS_TOKENS_SCHEMA = """
CREATE TABLE IF NOT EXISTS access_tokens (
    token_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    username TEXT NOT NULL,
    created_by TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL,
    last_used_at REAL,
    revoked_at REAL
);

CREATE INDEX IF NOT EXISTS idx_tokens_username ON access_tokens(username);
CREATE INDEX IF NOT EXISTS idx_tokens_created_by ON access_tokens(created_by);
"""

_COLUMNS = "token_id, username, created_by, label, created_at, expires_at, last_used_at, revoked_at"


class AccessTokenDict(TypedDict):
    """Metadata of a stored token; never contains the secret or its hash."""

    token_id: str
    username: str
    """The user the token authenticates as"""
    created_by: str
    """The user who created the token"""
    label: str
    created_at: float
    expires_at: Optional[float]
    """Epoch seconds; None means the token does not expire"""
    last_used_at: Optional[float]
    revoked_at: Optional[float]


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _row_to_token(row: sqlite3.Row) -> AccessTokenDict:
    return {
        "token_id": row["token_id"],
        "username": row["username"],
        "created_by": row["created_by"],
        "label": row["label"],
        "created_at": row["created_at"],
        "expires_at": row["expires_at"],
        "last_used_at": row["last_used_at"],
        "revoked_at": row["revoked_at"],
    }


def parse_token(token: str) -> Optional[tuple[str, str]]:
    """
    Split a token into its public id and its secret.

    Args:
        token: A token of the form ``pte_<id>_<secret>``

    Returns:
        ``(token_id, secret)``, or None if the token is malformed
    """
    if not token or not token.startswith(TOKEN_PREFIX):
        return None
    parts = token.split("_", 2)
    if len(parts) != 3:
        return None
    _, token_id, secret = parts
    if len(token_id) != TOKEN_ID_LENGTH or any(c not in _TOKEN_ID_ALPHABET for c in token_id) or not secret:
        return None
    return token_id, secret


def is_token_expired(token: AccessTokenDict, now: Optional[float] = None) -> bool:
    """Whether the token has an expiry that has passed."""
    expires_at = token["expires_at"]
    return expires_at is not None and (now if now is not None else time.time()) >= expires_at


class AccessTokenStore:
    """SQLite store of personal access tokens."""

    def __init__(self, db_dir: Path, logger=None):
        """
        Open (and create if needed) the token database.

        Args:
            db_dir: Path to the database directory
            logger: Optional logger instance
        """
        from fastapi_app.lib.core.migration_runner import run_migrations_if_needed
        from fastapi_app.lib.core.migrations.versions import ACCESS_TOKENS_MIGRATIONS

        self.db_dir = db_dir
        self.logger = logger
        self.db_path = db_dir / "access_tokens.db"
        init_database(self.db_path, ACCESS_TOKENS_SCHEMA, self.logger)
        run_migrations_if_needed(db_path=self.db_path, migrations=ACCESS_TOKENS_MIGRATIONS, logger=self.logger)

    def create(
        self, username: str, created_by: str, label: str, expires_at: Optional[float]
    ) -> tuple[str, AccessTokenDict]:
        """
        Create a token.

        Args:
            username: The user the token authenticates as
            created_by: The user who creates the token
            label: Human-readable name of the token
            expires_at: Expiry in epoch seconds, or None for no expiry

        Returns:
            The full token (shown to the user once) and its metadata
        """
        conn = get_connection(self.db_path)
        now = time.time()
        secret = secrets.token_urlsafe(_SECRET_BYTES)
        while True:
            token_id = "".join(secrets.choice(_TOKEN_ID_ALPHABET) for _ in range(TOKEN_ID_LENGTH))
            try:
                conn.execute(
                    """
                    INSERT INTO access_tokens (token_id, token_hash, username, created_by, label, created_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (token_id, _hash_secret(secret), username, created_by, label, now, expires_at),
                )
                conn.commit()
                break
            except sqlite3.IntegrityError:
                conn.rollback()  # token_id collision, try another one

        if self.logger:
            self.logger.info(f"Access token {token_id} ('{label}') created for {username} by {created_by}")
        token = self.get(token_id)
        assert token is not None
        return f"{TOKEN_PREFIX}{token_id}_{secret}", token

    def get(self, token_id: str) -> Optional[AccessTokenDict]:
        """The metadata of a token, or None if there is no token with that id."""
        conn = get_connection(self.db_path)
        row = conn.execute(f"SELECT {_COLUMNS} FROM access_tokens WHERE token_id = ?", (token_id,)).fetchone()
        return _row_to_token(row) if row else None

    def verify(self, token: str) -> Optional[AccessTokenDict]:
        """
        Check a token and record its use.

        Args:
            token: The full token as presented by a client

        Returns:
            The token's metadata if it is known, not revoked and not expired; None otherwise
        """
        parsed = parse_token(token)
        if parsed is None:
            return None
        token_id, secret = parsed
        conn = get_connection(self.db_path)
        row = conn.execute(
            f"SELECT token_hash, {_COLUMNS} FROM access_tokens WHERE token_id = ?", (token_id,)
        ).fetchone()
        if row is None or not hmac.compare_digest(row["token_hash"], _hash_secret(secret)):
            return None
        info = _row_to_token(row)
        now = time.time()
        if info["revoked_at"] is not None or is_token_expired(info, now):
            return None
        conn.execute("UPDATE access_tokens SET last_used_at = ? WHERE token_id = ?", (now, token_id))
        conn.commit()
        info["last_used_at"] = now
        return info

    def list_tokens(
        self,
        username: Optional[str] = None,
        created_by: Optional[str] = None,
        include_revoked: bool = False,
    ) -> list[AccessTokenDict]:
        """
        List tokens, newest first.

        Args:
            username: Only tokens that authenticate as this user
            created_by: Only tokens created by this user
            include_revoked: Also list revoked tokens

        Returns:
            Matching tokens; both filters must match if both are given
        """
        conditions: list[str] = []
        params: list[str] = []
        if username is not None:
            conditions.append("username = ?")
            params.append(username)
        if created_by is not None:
            conditions.append("created_by = ?")
            params.append(created_by)
        if not include_revoked:
            conditions.append("revoked_at IS NULL")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        conn = get_connection(self.db_path)
        rows = conn.execute(
            f"SELECT {_COLUMNS} FROM access_tokens {where} ORDER BY created_at DESC", tuple(params)
        ).fetchall()
        return [_row_to_token(row) for row in rows]

    def revoke(self, token_id: str) -> bool:
        """
        Revoke a token. Sessions created from it are not touched here; see ``revoke_token``.

        Returns:
            True if the token existed and was not revoked yet
        """
        conn = get_connection(self.db_path)
        cursor = conn.execute(
            "UPDATE access_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL",
            (time.time(), token_id),
        )
        conn.commit()
        if cursor.rowcount > 0 and self.logger:
            self.logger.info(f"Access token {token_id} revoked")
        return cursor.rowcount > 0

    def revoke_all_for_user(self, username: str) -> list[str]:
        """
        Revoke all tokens that authenticate as a user.

        Returns:
            The ids of the tokens that were revoked
        """
        token_ids = [t["token_id"] for t in self.list_tokens(username=username)]
        for token_id in token_ids:
            self.revoke(token_id)
        return token_ids

    def purge(self, older_than: float, dry_run: bool = False) -> int:
        """
        Delete tokens that were revoked or expired before a point in time.

        Args:
            older_than: Epoch seconds
            dry_run: Only count the tokens

        Returns:
            Number of tokens deleted (or that would be deleted)
        """
        condition = "(revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)"
        conn = get_connection(self.db_path)
        if dry_run:
            row = conn.execute(f"SELECT COUNT(*) AS n FROM access_tokens WHERE {condition}", (older_than, older_than)).fetchone()
            return int(row["n"])
        cursor = conn.execute(f"DELETE FROM access_tokens WHERE {condition}", (older_than, older_than))
        conn.commit()
        return cursor.rowcount


_instances: dict[Path, AccessTokenStore] = {}


def get_access_token_store() -> AccessTokenStore:
    """The token store of the configured db directory (FastAPI dependency)."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.utils.logging_utils import get_logger

    db_dir = get_settings().db_dir
    if db_dir not in _instances:
        _instances[db_dir] = AccessTokenStore(db_dir, logger=get_logger(__name__))
    return _instances[db_dir]


TOKEN_RETENTION_DAYS = 30
"""Revoked and expired tokens are removed by garbage collection this many days after revocation or expiry."""


def revoke_token(store: AccessTokenStore, session_manager: "SessionManager", token_id: str) -> bool:
    """
    Revoke a token and end the sessions created from it.

    Returns:
        True if the token existed and was not revoked yet
    """
    revoked = store.revoke(token_id)
    session_manager.delete_token_sessions(token_id)
    return revoked


def revoke_user_tokens(db_dir: Path, username: str) -> int:
    """
    Revoke all tokens of a user and end their sessions; called when the user is deleted.

    Args:
        db_dir: The db directory
        username: The deleted user

    Returns:
        Number of tokens revoked
    """
    from fastapi_app.lib.core.sessions import SessionManager

    store = AccessTokenStore(db_dir)
    session_manager = SessionManager(db_dir)
    token_ids = store.revoke_all_for_user(username)
    for token_id in token_ids:
        session_manager.delete_token_sessions(token_id)
    return len(token_ids)


def register_access_token_gc_task() -> None:
    """Register the removal of tokens revoked or expired more than TOKEN_RETENTION_DAYS ago."""
    from fastapi_app.lib.core.gc_registry import GcContext, GcResult, register_gc_task

    def collect(context: GcContext) -> GcResult:
        older_than = time.time() - TOKEN_RETENTION_DAYS * 86400
        count = AccessTokenStore(context.db_dir).purge(older_than, dry_run=context.dry_run)
        return GcResult(items_deleted=count, details={"tokens_removed": count})

    register_gc_task("access-tokens", "Revoked and expired access tokens", collect, order=700)
