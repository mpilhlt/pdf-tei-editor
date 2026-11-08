"""
Password hashing for user accounts.

Clients send the plain text password to `/api/v1/auth/login` over HTTPS. The server stores a salted
scrypt hash of the password's SHA-256 hex digest in the `passwd_hash` field of `users.json`:

    scrypt$<n>$<r>$<p>$<salt (base64)>$<hash (base64)>

The SHA-256 pre-hash exists for migration: accounts created before this scheme stored the bare SHA-256
hex digest, which worked as a credential on its own (the login endpoint accepted it in place of the
password). `upgrade_stored_hashes` wraps such digests in scrypt at server startup, without knowing
the passwords, so existing users keep their passwords.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path

SCHEME = "scrypt"
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
KEY_BYTES = 32

_LEGACY_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def _sha256_hex(password: str) -> str:
    """Return the SHA-256 hex digest of a password (the pre-hash and the legacy stored format)."""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _scrypt(prehash: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(prehash.encode("ascii"), salt=salt, n=n, r=r, p=p, maxmem=128 * n * r * p + 1024 * 1024, dklen=KEY_BYTES)


def _encode(prehash: str) -> str:
    """Hash a SHA-256 pre-hash with scrypt and a new random salt."""
    salt = secrets.token_bytes(SALT_BYTES)
    key = _scrypt(prehash, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"{SCHEME}${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(key)}"


def hash_password(password: str) -> str:
    """
    Hash a plain text password for storage.

    Args:
        password: Plain text password

    Returns:
        Encoded scrypt hash (see module docstring)
    """
    return _encode(_sha256_hex(password))


def is_legacy_hash(stored: str) -> bool:
    """Return True if a stored `passwd_hash` is a bare SHA-256 hex digest from before the scrypt scheme."""
    return bool(_LEGACY_HASH_RE.match(stored))


def upgrade_legacy_hash(stored: str) -> str:
    """
    Wrap a legacy SHA-256 hex digest in scrypt. The result verifies against the same password.

    Args:
        stored: Legacy stored hash (see `is_legacy_hash`)

    Returns:
        Encoded scrypt hash
    """
    return _encode(stored)


def verify_password(password: str, stored: str) -> bool:
    """
    Check a plain text password against a stored hash.

    Accepts the scrypt format and, for users.json files edited by hand or not yet upgraded, the legacy
    SHA-256 format.

    Args:
        password: Plain text password sent by the client
        stored: The user's `passwd_hash`

    Returns:
        True if the password matches
    """
    if not password or not stored:
        return False
    prehash = _sha256_hex(password)
    if is_legacy_hash(stored):
        return hmac.compare_digest(prehash, stored)
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != SCHEME:
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt = base64.b64decode(parts[4])
        expected = base64.b64decode(parts[5])
    except ValueError:
        return False
    return hmac.compare_digest(_scrypt(prehash, salt, n, r, p), expected)


def upgrade_stored_hashes(users_file: Path) -> int:
    """
    Wrap every legacy SHA-256 `passwd_hash` in a users.json file in scrypt.

    Writes the file atomically and only if a hash was upgraded.

    Args:
        users_file: Path to users.json

    Returns:
        Number of upgraded users
    """
    if not users_file.exists():
        return 0
    with open(users_file, "r", encoding="utf-8") as f:
        users = json.load(f)
    upgraded = 0
    for user in users:
        stored = user.get("passwd_hash")
        if isinstance(stored, str) and is_legacy_hash(stored):
            user["passwd_hash"] = upgrade_legacy_hash(stored)
            upgraded += 1
    if upgraded:
        tmp_file = users_file.with_name(f".{users_file.name}.{os.getpid()}.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, users_file)
    return upgraded
