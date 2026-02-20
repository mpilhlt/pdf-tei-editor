"""
Configuration management utilities for PDF-TEI-Editor.

This module provides framework-agnostic configuration utilities with dependency injection.

High-level API (recommended - uses settings injection):
    from fastapi_app.lib.config_utils import get_config

    config = get_config()
    value = config.get('key', default='fallback')
    config.set('key', value)
    config.delete('key')
    all_config = config.load()

Alternative - create Config instance with custom db_dir:
    from fastapi_app.lib.config_utils import Config

    custom_config = Config(custom_db_dir)
    value = custom_config.get('key')

Low-level API (for advanced use):
    from fastapi_app.lib.config_utils import get_config_value

    get_config_value(key, db_dir, default)
    set_config_value(key, value, db_dir)
"""

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional
from .data_utils import get_data_file_path


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

    def set(self, key: str, value: Any) -> tuple[bool, str]:
        """
        Set a configuration value.

        Args:
            key: The configuration key
            value: The value to set

        Returns:
            Tuple of (success: bool, message: str)
        """
        return set_config_value(key, value, self.db_dir)

    def delete(self, key: str) -> tuple[bool, str]:
        """
        Delete a configuration key.

        Args:
            key: The configuration key to delete

        Returns:
            Tuple of (success: bool, message: str)
        """
        return delete_config_value(key, self.db_dir)

    def load(self) -> dict:
        """
        Load the complete configuration.

        Returns:
            Configuration dictionary
        """
        return load_full_config(self.db_dir)


def load_full_config(db_dir: Path) -> dict:
    """
    Load complete configuration from config.json.

    Args:
        db_dir: Path to the database directory containing config.json

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
            return json.load(f)
    except (IOError, json.JSONDecodeError):
        return {}


def get_config_value(key: str, db_dir: Path, default: Any = None) -> Any:
    """
    Get a configuration value with dot notation support.

    Args:
        key: The configuration key (supports dot notation like "session.timeout")
        db_dir: Path to the database directory containing config.json
        default: Default value if key not found

    Returns:
        The configuration value or default
    """
    try:
        config_data = load_full_config(db_dir)
        return config_data.get(key, default)
    except (FileNotFoundError, ValueError):
        return default


def set_config_value(key: str, value: Any, db_dir: Path) -> tuple[bool, str]:
    """
    Set a configuration value with thread-safe file locking.

    Args:
        key: The configuration key
        value: The value to set
        db_dir: Path to the database directory containing config.json

    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        config_file = get_data_file_path(db_dir, 'config')
        config_file.parent.mkdir(parents=True, exist_ok=True)

        # Use file locking for thread safety
        with open(config_file, 'r+' if config_file.exists() else 'w+', encoding='utf-8') as f:
            _lock_file(f)

            f.seek(0)
            try:
                content = f.read()
                if not content:
                    config_data = {}
                else:
                    config_data = json.loads(content)
            except json.JSONDecodeError:
                config_data = {}

            # Special validation for *.values keys
            if key.endswith(".values") and not isinstance(value, list):
                _unlock_file(f)
                return False, "Values keys must be arrays"

            # Special validation for *.type keys
            if key.endswith(".type"):
                valid_types = ["string", "number", "boolean", "array", "object", "null"]
                if value not in valid_types:
                    _unlock_file(f)
                    return False, f"Type must be one of {valid_types}"

            # Validate against existing constraints
            if not _validate_config_value(config_data, key, value):
                _unlock_file(f)
                return False, "Value does not meet validation constraints"

            # Set the value
            config_data[key] = value

            # Auto-set type for new keys (not ending in .values or .type)
            if not key.endswith(".values") and not key.endswith(".type"):
                type_key = f"{key}.type"
                if type_key not in config_data:
                    config_data[type_key] = _get_json_type(value)

            # Write back to file
            f.seek(0)
            f.truncate()
            json.dump(config_data, f, indent=2)
            f.flush()  # Ensure data is written to disk
            os.fsync(f.fileno())  # Force OS-level flush

            _unlock_file(f)

        return True, f"Set {key} to {json.dumps(value)}"

    except (FileNotFoundError, ValueError) as e:
        return False, str(e)


def delete_config_value(key: str, db_dir: Path) -> tuple[bool, str]:
    """
    Delete a configuration key with thread-safe file locking.

    Args:
        key: The configuration key to delete
        db_dir: Path to the database directory containing config.json

    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        config_file = get_data_file_path(db_dir, 'config')

        if not config_file.exists():
            return False, f"Configuration file not found"

        with open(config_file, 'r+', encoding='utf-8') as f:
            _lock_file(f)

            f.seek(0)
            try:
                config_data = json.load(f)
            except json.JSONDecodeError:
                config_data = {}

            if key in config_data:
                del config_data[key]

                # Write back to file
                f.seek(0)
                f.truncate()
                json.dump(config_data, f, indent=2)
                f.flush()  # Ensure data is written to disk
                os.fsync(f.fileno())  # Force OS-level flush

                _unlock_file(f)
                return True, f"Deleted key '{key}'"
            else:
                _unlock_file(f)
                return False, f"Key '{key}' not found"

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
# Usage: from fastapi_app.lib.config_utils import get_config
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
