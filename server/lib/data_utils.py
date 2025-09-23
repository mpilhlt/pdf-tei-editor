"""Common data management utilities for PDF-TEI-Editor."""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional


def load_json_file(file_path: Path, create_if_missing: bool = True,
                  default_content: Any = None) -> Optional[Any]:
    """Loads data from a JSON file, optionally creating it if it doesn't exist.

    Args:
        file_path: Path to the JSON file
        create_if_missing: Whether to create the file if it doesn't exist
        default_content: Default content to create (defaults to empty list for .json files)

    Returns:
        The loaded data, or None if error and not creating
    """
    if not file_path.exists():
        if create_if_missing:
            # Create the directory if it doesn't exist
            file_path.parent.mkdir(parents=True, exist_ok=True)

            # Use sensible default based on file purpose or provided default
            if default_content is None:
                if 'users' in file_path.name:
                    default_content = []
                elif 'config' in file_path.name:
                    default_content = {}
                elif 'roles' in file_path.name:
                    default_content = []
                else:
                    default_content = {}

            # Create the file with default content
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(default_content, f, indent=2)

            return default_content
        else:
            return None

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {file_path}: {e}")


def save_json_file(file_path: Path, data: Any) -> None:
    """Saves data to a JSON file.

    Args:
        file_path: Path to the JSON file
        data: Data to save
    """
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
        f.truncate()


def get_project_paths(db_path: Optional[str] = None,
                     config_path: Optional[str] = None) -> tuple[Path, Path]:
    """Get project paths for db and config directories.

    Supports environment variable overrides for testing:
    - PDF_TEI_EDITOR_BASE_DIR: Override the base directory (default: project root)
    - PDF_TEI_EDITOR_DB_DIR: Override the db directory
    - PDF_TEI_EDITOR_CONFIG_DIR: Override the config directory

    Args:
        db_path: Optional custom path to the db directory
        config_path: Optional custom path to the config directory

    Returns:
        Tuple of (db_dir, config_dir) paths
    """
    # Check for environment variable overrides
    base_dir_override = os.getenv('PDF_TEI_EDITOR_BASE_DIR')
    db_dir_override = os.getenv('PDF_TEI_EDITOR_DB_DIR')
    config_dir_override = os.getenv('PDF_TEI_EDITOR_CONFIG_DIR')

    if db_path:
        db_dir = Path(db_path)
    elif db_dir_override:
        db_dir = Path(db_dir_override)
    elif base_dir_override:
        db_dir = Path(base_dir_override) / 'db'
    else:
        # Get project root (parent of bin directory where manage.py is located)
        project_root = Path(__file__).resolve().parent.parent.parent
        db_dir = project_root / 'db'

    if config_path:
        config_dir = Path(config_path)
    elif config_dir_override:
        config_dir = Path(config_dir_override)
    elif base_dir_override:
        config_dir = Path(base_dir_override) / 'config'
    else:
        # Get project root (parent of bin directory where manage.py is located)
        project_root = Path(__file__).resolve().parent.parent.parent
        config_dir = project_root / 'config'

    return db_dir, config_dir


def ensure_directory_exists(directory: Path) -> None:
    """Ensures a directory exists, creating it if necessary.

    Args:
        directory: Path to the directory
    """
    directory.mkdir(parents=True, exist_ok=True)