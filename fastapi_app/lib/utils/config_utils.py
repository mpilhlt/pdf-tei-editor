"""
Configuration management utilities for PDF-TEI-Editor.

This module provides framework-agnostic configuration utilities with dependency injection.

High-level API (recommended - uses settings injection):
    from fastapi_app.lib.utils.config_utils import get_config

    config = get_config()
    value = config.get('key', default='fallback')
    config.set('key', value)
    config.delete('key')
    all_config = config.load()

Alternative - create Config instance with custom db_dir:
    from fastapi_app.lib.utils.config_utils import Config

    custom_config = Config(custom_db_dir)
    value = custom_config.get('key')

Low-level API (for advanced use):
    from fastapi_app.lib.utils.config_utils import get_config_value

    get_config_value(key, db_dir, default)
    set_config_value(key, value, db_dir)
    get_config_metadata(key, db_dir)

Masked values (keys with ``{key}.masked = True``) are encrypted at rest with the key of the
secret store (``SECRETS_ENCRYPTION_KEY`` or ``data/db/secrets.key``, see
fastapi_app/lib/secrets/encryption.py). ``get()``/``get_config_value()`` decrypt them
transparently; ``load()``/``load_full_config()`` return them as stored, i.e. as encrypted
tokens, since none of their callers needs the secrets.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional
from fastapi_app.lib.utils.data_utils import get_data_file_path

MASKED_SENTINEL = "****"

# Prefix of masked values that are encrypted at rest; the rest is a Fernet token of the JSON-encoded value
ENCRYPTED_PREFIX = "fernet:"

METADATA_SUFFIXES = ('.type', '.values', '.description', '.masked')


# Platform-specific imports for file locking
if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl


def _lock_file(file_handle):
    """Cross-platform file locking"""
    if sys.platform == 'win32':
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_LOCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_EX)


def _unlock_file(file_handle):
    """Cross-platform file unlocking"""
    if sys.platform == 'win32':
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_UN)


class ConfigSecretError(RuntimeError):
    """A masked config value cannot be encrypted or decrypted (missing or wrong encryption key)."""


def is_encrypted_value(value: Any) -> bool:
    """True if `value` is a masked config value encrypted at rest."""
    return isinstance(value, str) and value.startswith(ENCRYPTED_PREFIX)


def _needs_encryption(value: Any) -> bool:
    """True if a masked value must be encrypted: it is set and not encrypted yet."""
    return value not in (None, "") and not is_encrypted_value(value)


def encrypt_config_value(value: Any, db_dir: Path) -> str:
    """
    Encrypt a masked config value for storage in config.json.

    Creates the key file in `db_dir` if no encryption key is configured yet.

    Raises:
        ConfigSecretError: If the encryption key is invalid
    """
    from fastapi_app.lib.secrets.encryption import EncryptionKeyError, load_fernet
    try:
        fernet = load_fernet(db_dir, create=True)
    except EncryptionKeyError as e:
        raise ConfigSecretError(str(e)) from e
    assert fernet is not None  # create=True always returns a key
    return ENCRYPTED_PREFIX + fernet.encrypt(json.dumps(value).encode()).decode()


def decrypt_config_value(value: Any, db_dir: Path, key: str = "") -> Any:
    """
    Decrypt a masked config value stored by encrypt_config_value(); other values are returned unchanged.

    Args:
        value: The stored value
        db_dir: Directory of the application databases (holds the fallback key file)
        key: The config key, for the error message

    Raises:
        ConfigSecretError: If no encryption key is configured or the value was encrypted with another key.
            The message never contains the value.
    """
    if not is_encrypted_value(value):
        return value
    from cryptography.fernet import InvalidToken
    from fastapi_app.lib.secrets.encryption import ENCRYPTION_KEY_ENV_VAR, KEY_FILE_NAME, EncryptionKeyError, load_fernet
    label = f"'{key}'" if key else "a masked value"
    try:
        fernet = load_fernet(db_dir, create=False)
    except EncryptionKeyError as e:
        raise ConfigSecretError(f"Cannot decrypt config value {label}: {e}") from e
    if fernet is None:
        raise ConfigSecretError(
            f"Cannot decrypt config value {label}: no encryption key is configured (set {ENCRYPTION_KEY_ENV_VAR} or restore {Path(db_dir) / KEY_FILE_NAME})"
        )
    try:
        return json.loads(fernet.decrypt(value[len(ENCRYPTED_PREFIX):].encode()).decode())
    except (InvalidToken, ValueError) as e:
        raise ConfigSecretError(
            f"Cannot decrypt config value {label}: it was encrypted with a different key than the configured one ({ENCRYPTION_KEY_ENV_VAR} or {Path(db_dir) / KEY_FILE_NAME})"
        ) from e


def check_config_secrets(db_dir: Path) -> tuple[int, list[str]]:
    """
    Check that every encrypted value in config.json can be decrypted with the configured key.

    Args:
        db_dir: Directory of the application databases

    Returns:
        Tuple of (number of encrypted values, keys of masked values still stored as plain text)

    Raises:
        ConfigSecretError: If any encrypted value cannot be decrypted; the message names the keys
    """
    config_data = load_full_config(db_dir)
    encrypted = [k for k, v in config_data.items() if not k.endswith(METADATA_SUFFIXES) and is_encrypted_value(v)]
    failed: list[str] = []
    first_error: ConfigSecretError | None = None
    for key in encrypted:
        try:
            decrypt_config_value(config_data[key], db_dir, key)
        except ConfigSecretError as e:
            failed.append(key)
            first_error = first_error or e
    if failed:
        from fastapi_app.lib.secrets.encryption import ENCRYPTION_KEY_ENV_VAR, KEY_FILE_NAME
        raise ConfigSecretError(
            f"{len(failed)} masked value(s) in config.json cannot be decrypted ({', '.join(failed)}): {first_error}. "
            f"Configure the key they were encrypted with ({ENCRYPTION_KEY_ENV_VAR} or {Path(db_dir) / KEY_FILE_NAME}), "
            "or, if that key is lost, delete these values and set them again (see docs/user-manual/docker-deployment.md#encryption-of-secrets)."
        )
    plaintext = [
        k for k, v in config_data.items()
        if not k.endswith(METADATA_SUFFIXES) and config_data.get(f"{k}.masked") is True and _needs_encryption(v)
    ]
    return len(encrypted), plaintext


def _encrypt_masked_entries(config_data: dict[str, Any], key: str, db_dir: Path, previous: Any = None) -> None:
    """
    Bring the stored form of `key` (a value key or its .masked flag) in line with its masked flag,
    in place: encrypt the value of a masked key, decrypt it again when the flag is removed.

    Args:
        config_data: The config about to be written
        key: The key that was just set
        db_dir: Directory of the application databases
        previous: The value stored for `key` before it was set. If it is encrypted and decrypts to
            the new value, its token is kept, so that re-registering a plugin setting on startup does
            not rewrite config.json with a new token.
    """
    base = key[:-len(".masked")] if key.endswith(".masked") else key
    if base.endswith(METADATA_SUFFIXES) or base not in config_data:
        return
    value = config_data[base]
    if config_data.get(f"{base}.masked") is True:
        if _needs_encryption(value):
            if base == key and is_encrypted_value(previous):
                try:
                    if decrypt_config_value(previous, db_dir, key) == value:
                        config_data[base] = previous
                        return
                except ConfigSecretError:
                    pass  # replaced by a value encrypted with the current key
            config_data[base] = encrypt_config_value(value, db_dir)
    elif is_encrypted_value(value):
        config_data[base] = decrypt_config_value(value, db_dir, base)


class Config:
    """
    High-level configuration API that abstracts away storage details.

    Similar to the frontend config.js API, this class provides a clean interface
    for configuration management without requiring callers to know about db_dir
    or implementation details.

    Usage:
        config = Config(db_dir)
        value = config.get('session.timeout', default=3600)
        config.set('session.timeout', 7200)
        config.delete('old.key')
        all_config = config.load()

    Args:
        db_dir: Path to the database directory containing config.json
    """

    def __init__(self, db_dir: Path):
        """
        Initialize Config with database directory.

        Args:
            db_dir: Path to the database directory containing config.json
        """
        self.db_dir = db_dir

    def get(self, key: str, default: Any = None) -> Any:
        """
        Get a configuration value.

        Args:
            key: The configuration key (supports dot notation)
            default: Default value if key not found

        Returns:
            The configuration value or default
        """
        return get_config_value(key, self.db_dir, default)

    def set(
        self,
        key: str,
        value: Any,
        value_type: str | None = None,
        allowed_values: list[Any] | None = None,
        description: str | None = None,
        masked: bool | None = None,
    ) -> tuple[bool, str]:
        """
        Set a configuration value.

        Args:
            key: The configuration key
            value: The value to set
            value_type: Optional explicit JSON type (overrides auto-inferred type)
            allowed_values: Optional list of allowed values to store as key.values
            description: Optional description stored as key.description
            masked: When True, writes {key}.masked = True alongside the value

        Returns:
            Tuple of (success: bool, message: str)
        """
        return set_config_value(key, value, self.db_dir,
                                value_type=value_type,
                                allowed_values=allowed_values,
                                description=description,
                                masked=masked)

    def get_metadata(self, key: str) -> dict[str, Any]:
        """Return metadata dict with type, values, description for key."""
        return get_config_metadata(key, self.db_dir)

    def delete(self, key: str, with_metadata: bool = False) -> tuple[bool, str]:
        """
        Delete a configuration key.

        Args:
            key: The configuration key to delete
            with_metadata: When True, also delete the key's .type, .values and .description entries
                (.masked is kept, see delete_config_value())

        Returns:
            Tuple of (success: bool, message: str)
        """
        return delete_config_value(key, self.db_dir, with_metadata=with_metadata)

    def load(self, apply_masks: bool = False) -> dict:
        """
        Load the complete configuration.

        Args:
            apply_masks: When True, replace masked values with MASKED_SENTINEL

        Returns:
            Configuration dictionary
        """
        return load_full_config(self.db_dir, apply_masks=apply_masks)


def load_full_config(db_dir: Path, apply_masks: bool = False) -> dict:
    """
    Load complete configuration from config.json.

    Masked values are returned as stored, i.e. encrypted (see decrypt_config_value()).

    Args:
        db_dir: Path to the database directory containing config.json
        apply_masks: When True, replace values of masked keys with MASKED_SENTINEL

    Returns:
        Configuration dictionary
    """
    config_file = get_data_file_path(db_dir, 'config')

    if not config_file.exists():
        # Create empty config if it doesn't exist
        config_file.parent.mkdir(parents=True, exist_ok=True)
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump({}, f, indent=2)
        return {}

    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (IOError, json.JSONDecodeError):
        return {}

    if apply_masks:
        for key in list(data.keys()):
            if not key.endswith(METADATA_SUFFIXES):
                # An empty masked value stays empty, so that the editor shows it as not set
                if data.get(f"{key}.masked") is True and data[key] not in (None, ""):
                    data[key] = MASKED_SENTINEL

    return data


def get_config_value(key: str, db_dir: Path, default: Any = None, apply_masks: bool = False) -> Any:
    """
    Get a configuration value with dot notation support. Masked values encrypted at rest are decrypted.

    Args:
        key: The configuration key (supports dot notation like "session.timeout")
        db_dir: Path to the database directory containing config.json
        default: Default value if key not found
        apply_masks: When True, return MASKED_SENTINEL for masked keys

    Returns:
        The configuration value or default

    Raises:
        ConfigSecretError: If the value is encrypted and cannot be decrypted with the configured key
    """
    try:
        config_data = load_full_config(db_dir)
        if apply_masks and config_data.get(f"{key}.masked") is True and config_data.get(key) not in (None, ""):
            return MASKED_SENTINEL
        return decrypt_config_value(config_data.get(key, default), db_dir, key)
    except (FileNotFoundError, ValueError):
        return default


def get_config_metadata(key: str, db_dir: Path) -> dict[str, Any]:
    """Return type, values, description, and masked metadata for a config key.

    Args:
        key: The configuration key
        db_dir: Path to the database directory containing config.json

    Returns:
        Dict with 'type', 'values', 'description', and 'masked' entries (values may be None)
    """
    config_data = load_full_config(db_dir)
    return {
        "type": config_data.get(f"{key}.type"),
        "values": config_data.get(f"{key}.values"),
        "description": config_data.get(f"{key}.description"),
        "masked": config_data.get(f"{key}.masked", False),
    }


def set_config_value(
    key: str,
    value: Any,
    db_dir: Path,
    value_type: str | None = None,
    allowed_values: list[Any] | None = None,
    description: str | None = None,
    masked: bool | None = None,
) -> tuple[bool, str]:
    """
    Set a configuration value with atomic write and file locking.

    Uses a lock file + atomic rename (write to temp file then os.replace) so
    concurrent readers never observe a truncated or partially-written config file.

    Args:
        key: The configuration key
        value: The value to set
        db_dir: Path to the database directory containing config.json
        value_type: Optional explicit type name ("string", "number", "boolean", "array", "object", "null").
            Overrides inferred type. Ignored for metadata sub-keys.
        allowed_values: Optional list of permitted values. Written as key.values. Ignored for metadata sub-keys.
        description: Optional human-readable description. Written as key.description. Ignored for metadata sub-keys.
        masked: When True, writes {key}.masked = True alongside the value. Never pass False to avoid
            overwriting an existing masked=True with False on re-registration.

    Returns:
        Tuple of (success: bool, message: str)
    """
    import tempfile

    try:
        config_file = get_data_file_path(db_dir, 'config')
        config_file.parent.mkdir(parents=True, exist_ok=True)
        lock_file = config_file.with_suffix('.lock')

        with open(lock_file, 'a', encoding='utf-8') as lf:
            _lock_file(lf)
            try:
                # Read current config while holding the lock
                if config_file.exists():
                    try:
                        with open(config_file, 'r', encoding='utf-8') as f:
                            content = f.read()
                        config_data = json.loads(content) if content else {}
                    except (IOError, json.JSONDecodeError):
                        config_data = {}
                else:
                    config_data = {}

                # Special validation for *.values keys
                if key.endswith(".values") and not isinstance(value, list):
                    return False, "Values keys must be arrays"

                # Special validation for *.type keys
                if key.endswith(".type"):
                    valid_types = ["string", "number", "boolean", "array", "object", "null"]
                    if value not in valid_types:
                        return False, f"Type must be one of {valid_types}"

                # Validate against incoming allowed_values (before they are persisted)
                if allowed_values is not None and value not in allowed_values:
                    return False, f"Value {json.dumps(value)} is not in allowed values {json.dumps(allowed_values)}"

                # Validate against existing constraints
                if not _validate_config_value(config_data, key, value):
                    return False, "Value does not meet validation constraints"

                previous = config_data.get(key)

                # Set the value
                config_data[key] = value

                # Auto-set type (explicit takes priority over inferred)
                if not key.endswith(".values") and not key.endswith(".type") and not key.endswith(".description"):
                    type_key = f"{key}.type"
                    resolved_type: str | None
                    if value_type is not None:
                        resolved_type = value_type
                    else:
                        resolved_type = _get_json_type(value) if type_key not in config_data else None
                    if resolved_type:
                        config_data[type_key] = resolved_type

                    if allowed_values is not None:
                        config_data[f"{key}.values"] = allowed_values

                    if description is not None:
                        config_data[f"{key}.description"] = description

                    if masked is True:
                        config_data[f"{key}.masked"] = True

                # Masked values are stored encrypted; removing the flag stores the value as plain text again
                _encrypt_masked_entries(config_data, key, db_dir, previous)

                # Atomic write: write to temp file then rename
                tmp_fd, tmp_path = tempfile.mkstemp(dir=config_file.parent, suffix='.tmp')
                try:
                    with os.fdopen(tmp_fd, 'w', encoding='utf-8') as tf:
                        json.dump(config_data, tf, indent=2)
                        tf.flush()
                        os.fsync(tf.fileno())
                    os.replace(tmp_path, config_file)
                except Exception:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    raise
            finally:
                _unlock_file(lf)

        if config_data.get(f"{key}.masked") is True:
            return True, f"Set {key}"
        return True, f"Set {key} to {json.dumps(value)}"

    except (FileNotFoundError, ValueError, ConfigSecretError) as e:
        return False, str(e)


def delete_config_value(key: str, db_dir: Path, with_metadata: bool = False) -> tuple[bool, str]:
    """
    Delete a configuration key with thread-safe file locking.

    Args:
        key: The configuration key to delete
        db_dir: Path to the database directory containing config.json
        with_metadata: When True, also delete the key's .type, .values and .description entries in the
            same write. The .masked flag is kept, so that a secret that is set again later (by the
            plugin's registration or an environment variable) stays hidden.

    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        config_file = get_data_file_path(db_dir, 'config')

        if not config_file.exists():
            return False, f"Configuration file not found"

        import tempfile
        lock_file = config_file.with_suffix('.lock')

        with open(lock_file, 'a', encoding='utf-8') as lf:
            _lock_file(lf)
            try:
                try:
                    with open(config_file, 'r', encoding='utf-8') as f:
                        config_data = json.load(f)
                except (IOError, json.JSONDecodeError):
                    config_data = {}

                if key not in config_data:
                    return False, f"Key '{key}' not found"

                del config_data[key]
                if with_metadata:
                    for suffix in ('.type', '.values', '.description'):
                        config_data.pop(f"{key}{suffix}", None)

                tmp_fd, tmp_path = tempfile.mkstemp(dir=config_file.parent, suffix='.tmp')
                try:
                    with os.fdopen(tmp_fd, 'w', encoding='utf-8') as tf:
                        json.dump(config_data, tf, indent=2)
                        tf.flush()
                        os.fsync(tf.fileno())
                    os.replace(tmp_path, config_file)
                except Exception:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    raise
            finally:
                _unlock_file(lf)

        return True, f"Deleted key '{key}'"

    except (FileNotFoundError, ValueError) as e:
        return False, str(e)


def _get_json_type(value: Any) -> str:
    """
    Returns the JSON type name for a Python value.

    Args:
        value: The value to get the type for

    Returns:
        The JSON type name
    """
    if isinstance(value, bool):
        return "boolean"
    elif isinstance(value, int):
        return "number"
    elif isinstance(value, float):
        return "number"
    elif isinstance(value, str):
        return "string"
    elif isinstance(value, list):
        return "array"
    elif isinstance(value, dict):
        return "object"
    elif value is None:
        return "null"
    else:
        return "unknown"


def _validate_config_value(config_data: dict, key: str, value: Any) -> bool:
    """
    Validates a config value against constraints.

    Args:
        config_data: The configuration data containing constraints
        key: The configuration key
        value: The value to validate

    Returns:
        True if valid, False otherwise
    """
    values_key = f"{key}.values"
    type_key = f"{key}.type"

    # Check if value must be one of specific values
    if values_key in config_data:
        allowed_values = config_data[values_key]
        if value not in allowed_values:
            return False

    # Check if value must be of specific type
    if type_key in config_data:
        required_type = config_data[type_key]
        actual_type = _get_json_type(value)
        if actual_type != required_type:
            return False

    return True


def _get_default_config() -> Config:
    """
    Get a Config instance using settings from fastapi_app.config.

    This provides a preconfigured instance that doesn't require
    passing db_dir explicitly.

    Returns:
        Config instance configured with settings.db_dir
    """
    from fastapi_app.config import get_settings
    settings = get_settings()
    return Config(settings.db_dir)


# Module-level config instance for convenience
# Usage: from fastapi_app.lib.utils.config_utils import get_config
_config_instance = None


def get_config() -> Config:
    """
    Get the module-level config instance (lazy initialization).

    Returns:
        Config instance configured with settings.db_dir
    """
    global _config_instance
    if _config_instance is None:
        _config_instance = _get_default_config()
    return _config_instance
