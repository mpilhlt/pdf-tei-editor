"""Configuration management utilities for PDF-TEI-Editor."""

import json
from pathlib import Path
from typing import Any, Optional, List, Dict, Union
from .data_utils import load_json_file, save_json_file


def get_config_data(config_file: Path) -> Optional[Dict[str, Any]]:
    """Gets configuration data from config.json file, creating it if it doesn't exist.

    Args:
        config_file: Path to the config.json file

    Returns:
        Configuration dictionary if successful, None if error
    """
    data = load_json_file(config_file, create_if_missing=True, default_content={})
    return data if data is not None else {}


def save_config_data(config_file: Path, data: Dict[str, Any]) -> None:
    """Saves configuration data to config.json file.

    Args:
        config_file: Path to the config.json file
        data: Configuration dictionary to save
    """
    save_json_file(config_file, data)


def get_json_type(value: Any) -> str:
    """Returns the JSON type name for a Python value.

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


def validate_config_value(config_data: Dict[str, Any], key: str, value: Any) -> bool:
    """Validates a config value against constraints.

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
        actual_type = get_json_type(value)
        if actual_type != required_type:
            return False

    return True


def get_config_value(config_file: Path, key: str, default: Any = None) -> Any:
    """Gets a configuration value with dot notation support.

    Args:
        config_file: Path to the config.json file
        key: The configuration key (supports dot notation)
        default: Default value if key not found

    Returns:
        The configuration value or default
    """
    try:
        config_data = get_config_data(config_file)
        if config_data is None:
            return default

        if key in config_data:
            return config_data[key]
        else:
            return default
    except (FileNotFoundError, ValueError):
        return default


def set_config_value(config_file: Path, key: str, value: Any,
                    validate: bool = True) -> tuple[bool, str]:
    """Sets a configuration value.

    Args:
        config_file: Path to the config.json file
        key: The configuration key
        value: The value to set
        validate: Whether to validate against constraints

    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        config_data = get_config_data(config_file)
        if config_data is None:
            return False, f"Could not load configuration from {config_file}"

        # Special validation for *.values keys
        if key.endswith(".values") and not isinstance(value, list):
            return False, "Values keys must be arrays"

        # Special validation for *.type keys
        if key.endswith(".type"):
            valid_types = ["string", "number", "boolean", "array", "object", "null"]
            if value not in valid_types:
                return False, f"Type must be one of {valid_types}"

        # Validate against existing constraints
        if validate and not validate_config_value(config_data, key, value):
            return False, "Value does not meet validation constraints"

        # Set the value
        config_data[key] = value

        # Auto-set type for new keys (not ending in .values or .type)
        if not key.endswith(".values") and not key.endswith(".type"):
            type_key = f"{key}.type"
            if type_key not in config_data:
                config_data[type_key] = get_json_type(value)

        save_config_data(config_file, config_data)
        return True, f"Set {key} to {json.dumps(value)}"

    except (FileNotFoundError, ValueError) as e:
        return False, str(e)


def delete_config_key(config_file: Path, key: str) -> tuple[bool, str]:
    """Deletes a configuration key.

    Args:
        config_file: Path to the config.json file
        key: The configuration key to delete

    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        config_data = get_config_data(config_file)
        if config_data is None:
            return False, f"Could not load configuration from {config_file}"

        if key in config_data:
            del config_data[key]
            save_config_data(config_file, config_data)
            return True, f"Deleted key '{key}'"
        else:
            return False, f"Key '{key}' not found"

    except (FileNotFoundError, ValueError) as e:
        return False, str(e)


def set_config_constraint(config_file: Path, key: str, constraint_type: str,
                         constraint_value: Union[List[Any], str]) -> tuple[bool, str]:
    """Sets a configuration constraint (values or type).

    Args:
        config_file: Path to the config.json file
        key: The base configuration key
        constraint_type: Either "values" or "type"
        constraint_value: The constraint value (list for values, string for type)

    Returns:
        Tuple of (success: bool, message: str)
    """
    if constraint_type == "values":
        if not isinstance(constraint_value, list):
            return False, "Values constraint must be a list"
        constraint_key = f"{key}.values"
    elif constraint_type == "type":
        valid_types = ["string", "number", "boolean", "array", "object", "null"]
        if constraint_value not in valid_types:
            return False, f"Type must be one of {valid_types}"
        constraint_key = f"{key}.type"
    else:
        return False, "Constraint type must be 'values' or 'type'"

    return set_config_value(config_file, constraint_key, constraint_value, validate=False)


# Flask compatibility functions
try:
    from flask import current_app

    def get_config_value_flask(key: str, default: Any = None) -> Any:
        """Gets a configuration value from the Flask app config with dot notation support.

        This is the original function maintained for Flask compatibility.

        Args:
            key: The configuration key (supports dot notation)
            default: Default value if key not found

        Returns:
            The configuration value or default
        """
        try:
            config_file = current_app.config["DB_DIR"] / 'config.json'
            return get_config_value(config_file, key, default)
        except (KeyError, AttributeError):
            return default

except ImportError:
    # Flask not available, skip Flask-specific functions
    pass