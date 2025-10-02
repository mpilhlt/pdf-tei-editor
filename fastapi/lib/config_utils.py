import json
from pathlib import Path
from typing import Any

def get_config_value(key: str, db_dir: Path, default: Any = None) -> Any:
    """
    Gets a configuration value from the config file.

    The config file uses flat string keys like "session.timeout", "xml.encode-entities.server", etc.
    No nesting is performed - keys are used as-is.

    Args:
        key: Configuration key (flat string like 'session.timeout')
        db_dir: Path to database directory containing config.json
        default: Default value if key is not found

    Returns:
        Configuration value or default
    """
    try:
        config_file = db_dir / 'config.json'
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)

        # Direct key lookup - no dot notation processing
        return config.get(key, default)

    except (FileNotFoundError, json.JSONDecodeError):
        return default


def set_config_value(key: str, value: Any, db_dir: Path) -> bool:
    """
    Sets a configuration value in the config file.

    Args:
        key: Configuration key (flat string)
        value: Value to set
        db_dir: Path to database directory containing config.json

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        config_file = db_dir / 'config.json'

        # Load existing config or create empty dict
        if config_file.exists():
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
        else:
            config = {}
            # Ensure directory exists
            config_file.parent.mkdir(parents=True, exist_ok=True)

        # Set the value directly
        config[key] = value

        # Write back to file
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

        return True
    except (OSError, json.JSONDecodeError):
        return False


def delete_config_value(key: str, db_dir: Path) -> bool:
    """
    Deletes a configuration value from the config file.

    Args:
        key: Configuration key (flat string)
        db_dir: Path to database directory containing config.json

    Returns:
        bool: True if successful or key didn't exist, False on error
    """
    try:
        config_file = db_dir / 'config.json'

        if not config_file.exists():
            return True  # Key doesn't exist, which is the desired state

        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)

        # Delete the key if it exists
        if key in config:
            del config[key]

        # Write back to file
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

        return True
    except (OSError, json.JSONDecodeError):
        return False


def load_full_config(db_dir: Path) -> dict:
    """
    Load the entire configuration as a dictionary.

    Args:
        db_dir: Path to database directory containing config.json

    Returns:
        dict: Full configuration dictionary
    """
    try:
        config_file = db_dir / 'config.json'
        with open(config_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}