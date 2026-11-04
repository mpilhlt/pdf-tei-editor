"""
The Fernet key that encrypts secrets at rest: the users' API keys in ``secrets.db``
and the masked values in ``config.json``.

The key comes from the ``SECRETS_ENCRYPTION_KEY`` environment variable (a Fernet
key). Without it, a key is generated once and kept in ``<db_dir>/secrets.key``
(mode 0600). That file protects against a leaked database or backup, not against
someone with access to the data directory, so production deployments should set
the environment variable instead.

This module only depends on ``cryptography`` so that low-level modules such as
``config_utils`` can use it without import cycles.
"""

import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

ENCRYPTION_KEY_ENV_VAR = "SECRETS_ENCRYPTION_KEY"
KEY_FILE_NAME = "secrets.key"


class EncryptionKeyError(RuntimeError):
    """The configured encryption key is invalid or cannot be read."""


# Fernet instances by (environment key, key file); the key file is read once per process
_cache: dict[tuple[str, Path], Fernet] = {}


def load_fernet(db_dir: Path, create: bool = True) -> Fernet | None:
    """
    The Fernet from the environment variable or the key file.

    Args:
        db_dir: Directory of the application databases, which holds the fallback key file
        create: Generate the key file if there is neither an environment variable nor a key file.
            Pass False when only decrypting: a new key cannot decrypt anything.

    Returns:
        The Fernet, or None if ``create`` is False and no key is configured

    Raises:
        EncryptionKeyError: If the key is malformed or the key file cannot be read or created
    """
    env_key = os.environ.get(ENCRYPTION_KEY_ENV_VAR, "").strip()
    key_file = Path(db_dir) / KEY_FILE_NAME
    cache_key = (env_key, key_file.resolve())
    if cache_key in _cache:
        return _cache[cache_key]
    try:
        if env_key:
            fernet = Fernet(env_key.encode())
        else:
            if not key_file.exists():
                if not create:
                    return None
                key_file.parent.mkdir(parents=True, exist_ok=True)
                # Create with 0600 from the start so the key is never readable by others
                fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(Fernet.generate_key().decode())
                logger.info("Generated an encryption key for secrets at %s", key_file)
            # Every copy of the data directory (backups, sync mirrors) contains the key next to
            # the secrets it encrypts
            logger.warning(
                "Secrets are encrypted with the key file %s, which is part of the data directory and its backups. Set %s to keep the key outside of it.",
                key_file, ENCRYPTION_KEY_ENV_VAR,
            )
            fernet = Fernet(key_file.read_text().strip().encode())
    except (ValueError, OSError) as e:
        raise EncryptionKeyError(f"Invalid encryption key for secrets: {e}") from e
    _cache[cache_key] = fernet
    return fernet


def reset_fernet_cache() -> None:
    """Forget the loaded keys, e.g. after a test changed the environment variable or key file."""
    _cache.clear()
