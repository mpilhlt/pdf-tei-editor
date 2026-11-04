"""
Fernet-encrypted storage of per-user, per-service secrets in SQLite.

The encryption key comes from the ``SECRETS_ENCRYPTION_KEY`` environment variable
(a Fernet key) or the ``<db_dir>/secrets.key`` file, see encryption.py. The same
key encrypts the masked values in ``config.json``.

Secret values never appear in logs, listings or exceptions.
"""

import logging
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from fastapi_app.config import get_settings
from fastapi_app.lib.core.db_utils import get_connection, init_database

from .encryption import ENCRYPTION_KEY_ENV_VAR, KEY_FILE_NAME, EncryptionKeyError, load_fernet
from .services import MissingSecretError

logger = logging.getLogger(__name__)

__all__ = ["ENCRYPTION_KEY_ENV_VAR", "KEY_FILE_NAME", "SecretStore", "SecretsError", "get_secret_store", "require_user_secret"]

DB_FILE_NAME = "secrets.db"

SECRETS_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_secrets (
    username TEXT NOT NULL,
    service TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (username, service)
);
"""


class SecretsError(RuntimeError):
    """The secret store is misconfigured or a stored secret cannot be decrypted."""


def _load_fernet(db_dir: Path) -> Fernet:
    """The Fernet from the environment variable or the key file (created on first use)."""
    try:
        fernet = load_fernet(db_dir, create=True)
    except EncryptionKeyError as e:
        raise SecretsError(f"Invalid encryption key for user secrets: {e}") from e
    assert fernet is not None  # create=True always returns a key
    return fernet


class SecretStore:
    """Encrypted secrets by (username, service)."""

    def __init__(self, db_dir: Path):
        """
        Args:
            db_dir: Directory of the application databases; holds ``secrets.db`` and the fallback key file
        """
        self.db_path = Path(db_dir) / DB_FILE_NAME
        self._fernet = _load_fernet(Path(db_dir))
        init_database(self.db_path, SECRETS_SCHEMA, logger)
        self.db_path.chmod(0o600)

    def set(self, username: str, service: str, value: str) -> None:
        """Store (or replace) the secret of a user for a service."""
        if not value:
            raise ValueError("The secret must not be empty")
        token = self._fernet.encrypt(value.encode()).decode()
        now = time.time()
        conn = get_connection(self.db_path)
        conn.execute(
            """
            INSERT INTO user_secrets (username, service, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(username, service) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at
            """,
            (username, service, token, now, now),
        )
        conn.commit()

    def get(self, username: str, service: str) -> str | None:
        """
        The decrypted secret, or None if the user has none for the service.

        Raises:
            SecretsError: If the stored token cannot be decrypted (wrong encryption key)
        """
        row = get_connection(self.db_path).execute(
            "SELECT token FROM user_secrets WHERE username = ? AND service = ?", (username, service)
        ).fetchone()
        if row is None:
            return None
        try:
            return self._fernet.decrypt(row["token"].encode()).decode()
        except InvalidToken as e:
            raise SecretsError(
                f"Cannot decrypt the secret of '{username}' for '{service}': the encryption key has changed"
            ) from e

    def has(self, username: str, service: str) -> bool:
        """Whether the user has a secret for the service (without decrypting it)."""
        row = get_connection(self.db_path).execute(
            "SELECT 1 FROM user_secrets WHERE username = ? AND service = ?", (username, service)
        ).fetchone()
        return row is not None

    def delete(self, username: str, service: str) -> bool:
        """Remove a secret; returns whether one existed."""
        conn = get_connection(self.db_path)
        cursor = conn.execute("DELETE FROM user_secrets WHERE username = ? AND service = ?", (username, service))
        conn.commit()
        return cursor.rowcount > 0

    def delete_all(self, username: str) -> int:
        """Remove all secrets of a user, including those of services that are no longer registered; returns how many existed."""
        conn = get_connection(self.db_path)
        cursor = conn.execute("DELETE FROM user_secrets WHERE username = ?", (username,))
        conn.commit()
        return cursor.rowcount

    def list_services(self, username: str) -> list[str]:
        """Ids of the services the user has a secret for (never the values)."""
        rows = get_connection(self.db_path).execute(
            "SELECT service FROM user_secrets WHERE username = ? ORDER BY service", (username,)
        ).fetchall()
        return [row["service"] for row in rows]


_instances: dict[Path, SecretStore] = {}


def get_secret_store() -> SecretStore:
    """The secret store of the configured data directory."""
    db_dir = get_settings().db_dir
    if db_dir not in _instances:
        _instances[db_dir] = SecretStore(db_dir)
    return _instances[db_dir]


def require_user_secret(username: str | None, service: str) -> str:
    """
    The secret of a user for a service, for use in plugins that run on behalf of a user.

    Raises:
        MissingSecretError: If there is no user or the user has not stored a secret; the extraction
            endpoint turns this into a response that makes the frontend prompt for the key
    """
    value = get_secret_store().get(username, service) if username else None
    if not value:
        raise MissingSecretError(service, username)
    return value
