"""
Database and configuration initialization for FastAPI.

Implements the same pattern as Flask:
1. Copy default JSON files from config/ to db/ if they don't exist
2. Merge missing config values from config.json template into db/config.json
3. SQLite databases (sessions.db, locks.db) are created on demand by their respective modules

This ensures:
- Clean separation between defaults (config/) and runtime state (db/)
- Database files are never committed to git
- Tests can start with clean state by deleting db/ contents
- Configuration can be updated without losing user customizations
"""

import json
import shutil
from pathlib import Path
from typing import Dict
import logging

from fastapi_app.config import get_settings

logger = logging.getLogger(__name__)


def initialize_db_from_config(
    config_dir: Path,
    db_dir: Path,
    force: bool = False
) -> None:
    """
    Initialize database directory from configuration defaults.

    This function:
    1. Ensures db_dir exists
    2. Copies all .json files from config_dir to db_dir (if they don't exist)
    3. Merges missing config values from config/config.json into db/config.json

    Args:
        config_dir: Path to config directory with default files (e.g., fastapi_app/config)
        db_dir: Path to database directory for runtime files (e.g., fastapi_app/db)
        force: If True, overwrite existing files (use for tests)

    Example:
        >>> initialize_db_from_config(
        ...     Path("fastapi_app/config"),
        ...     Path("fastapi_app/db")
        ... )
    """
    # Ensure directories exist
    config_dir = Path(config_dir)
    db_dir = Path(db_dir)

    if not config_dir.exists():
        raise FileNotFoundError(f"Config directory not found: {config_dir}")

    db_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"Initializing database directory: {db_dir}")

    # Copy all JSON files from config to db
    json_files = list(config_dir.glob("*.json"))

    if not json_files:
        logger.warning(f"No JSON files found in config directory: {config_dir}")
        return

    for config_file in json_files:
        db_file = db_dir / config_file.name

        if force or not db_file.exists():
            shutil.copy(config_file, db_file)
            logger.info(f"Copied {config_file.name} to {db_dir}")
        else:
            logger.debug(f"File already exists, skipping: {db_file.name}")

    # Special handling for config.json: merge missing keys
    config_template_path = config_dir / "config.json"
    config_db_path = db_dir / "config.json"

    if config_template_path.exists() and config_db_path.exists():
        _merge_config_defaults(config_template_path, config_db_path)
    elif not config_db_path.exists() and config_template_path.exists():
        # If db config doesn't exist yet (shouldn't happen after the loop above)
        shutil.copy(config_template_path, config_db_path)
        logger.info(f"Created config.json in {db_dir}")

    logger.info(f"Database initialization complete: {db_dir}")


def _merge_config_defaults(template_path: Path, db_path: Path) -> None:
    """
    Merge missing config values from template into database config.

    This allows:
    - Adding new config keys without overwriting user customizations
    - Keeping defaults in sync with config template
    - Preserving user modifications

    Args:
        template_path: Path to config/config.json (defaults)
        db_path: Path to db/config.json (user's current config)
    """
    try:
        with open(template_path, 'r') as f:
            template_config: Dict = json.load(f)

        with open(db_path, 'r') as f:
            db_config: Dict = json.load(f)

        # Track if we added anything
        added_keys = []

        # Add missing top-level keys from template
        for key, value in template_config.items():
            if key not in db_config:
                db_config[key] = value
                added_keys.append(key)
                logger.info(f"Added missing default config value for '{key}'")

        # Write back if we made changes
        if added_keys:
            with open(db_path, 'w') as f:
                json.dump(db_config, f, indent=2)
            logger.info(f"Merged {len(added_keys)} missing config keys into {db_path}")
        else:
            logger.debug("No missing config keys to merge")

    except Exception as e:
        logger.error(f"Failed to merge config defaults: {e}")
        raise


def clean_db_directory(db_dir: Path, keep_sqlite: bool = False) -> None:
    """
    Clean database directory for testing.

    Removes all JSON and SQLite database files from db directory.
    Useful for test setup to ensure clean state.

    Args:
        db_dir: Path to database directory
        keep_sqlite: If True, only remove JSON files (keep SQLite DBs)

    Example:
        >>> # In test setup
        >>> clean_db_directory(Path("fastapi_app/db"))
        >>> initialize_db_from_config(
        ...     Path("fastapi_app/config"),
        ...     Path("fastapi_app/db")
        ... )
    """
    db_dir = Path(db_dir)

    if not db_dir.exists():
        logger.debug(f"Database directory doesn't exist, nothing to clean: {db_dir}")
        return

    # Remove JSON files
    for json_file in db_dir.glob("*.json"):
        json_file.unlink()
        logger.debug(f"Removed {json_file.name}")

    # Remove SQLite files if requested
    if not keep_sqlite:
        for db_file in db_dir.glob("*.db"):
            db_file.unlink()
            logger.debug(f"Removed {db_file.name}")

        for db_file in db_dir.glob("*.db-*"):
            db_file.unlink()
            logger.debug(f"Removed {db_file.name}")

    logger.info(f"Cleaned database directory: {db_dir}")


# Convenience function for common initialization pattern
def ensure_db_initialized(
    config_dir: Path = None,
    db_dir: Path = None
) -> None:
    """
    Ensure database is initialized with defaults.

    Uses PROJECT_ROOT/config and db_dir as defaults.
    Safe to call multiple times - only copies files that don't exist.

    Args:
        config_dir: Override default config directory (defaults to PROJECT_ROOT/config)
        db_dir: Override default db directory (required - no default)
    """
    # Default config path is at project root (same level as fastapi_app/)
    if config_dir is None:
        config_dir = get_settings().project_root_dir / "config"

    if db_dir is None:
        raise ValueError("db_dir must be provided (no default available)")

    initialize_db_from_config(config_dir, db_dir)
