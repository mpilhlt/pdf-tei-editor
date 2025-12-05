"""Collection management utilities for PDF-TEI-Editor."""

from pathlib import Path
from typing import List, Optional, Dict, Any
from .data_utils import load_entity_data, save_entity_data, get_data_file_path, load_json_file


def find_collection(collection_id: str, collections_data: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Finds a collection by ID.

    Args:
        collection_id: The collection ID to search for
        collections_data: List of collection dictionaries

    Returns:
        Collection dictionary if found, None otherwise
    """
    for collection in collections_data:
        if collection.get('id') == collection_id:
            return collection
    return None


def collection_exists(collection_id: str, collections_data: List[Dict[str, Any]]) -> bool:
    """Checks if a collection exists.

    Args:
        collection_id: The collection ID to check
        collections_data: List of collection dictionaries

    Returns:
        True if collection exists, False otherwise
    """
    return find_collection(collection_id, collections_data) is not None


def get_available_collections(db_dir: Path) -> Optional[List[str]]:
    """Gets the list of available collections from db/collections.json.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of collection IDs if successful, None if error
    """
    collections_file = get_data_file_path(db_dir, 'collections')

    if not collections_file.exists():
        raise FileNotFoundError(f"Collections file not found at {collections_file}")

    collections_data = load_json_file(collections_file, create_if_missing=False)

    if not isinstance(collections_data, list):
        raise ValueError("Invalid collections file format. Expected a list.")

    collection_ids = [collection.get('id') for collection in collections_data
                      if isinstance(collection, dict) and 'id' in collection]
    return collection_ids


def get_collections_with_details(db_dir: Path) -> Optional[List[Dict[str, Any]]]:
    """Gets all collections with their details from db/collections.json.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of collection dictionaries if successful, None if error
    """
    collections_file = get_data_file_path(db_dir, 'collections')

    if not collections_file.exists():
        raise FileNotFoundError(f"Collections file not found at {collections_file}")

    collections_data = load_json_file(collections_file, create_if_missing=False)

    if not isinstance(collections_data, list):
        raise ValueError("Invalid collections file format. Expected a list.")

    return collections_data


def validate_collection(collection_id: str, db_dir: Path) -> bool:
    """Validates if a collection exists in the available collections.

    Args:
        collection_id: The collection ID to validate
        db_dir: Path to the db directory

    Returns:
        True if collection exists, False otherwise
    """
    try:
        available_collections = get_available_collections(db_dir)
        return collection_id in available_collections if available_collections else False
    except (FileNotFoundError, ValueError):
        return False


def add_collection(db_dir: Path, collection_id: str, name: str, description: str = "") -> tuple[bool, str]:
    """Adds a new collection to the collections.json file.

    Args:
        db_dir: Path to the db directory
        collection_id: The collection ID
        name: The collection name
        description: The collection description (optional)

    Returns:
        Tuple of (success: bool, message: str)
    """
    collections_data = load_entity_data(db_dir, 'collections')

    # Check if collection already exists
    if collection_exists(collection_id, collections_data):
        return False, f"Collection '{collection_id}' already exists."

    # Add new collection
    new_collection = {
        "id": collection_id,
        "name": name,
        "description": description
    }
    collections_data.append(new_collection)

    save_entity_data(db_dir, 'collections', collections_data)
    return True, f"Collection '{collection_id}' added successfully."


def remove_collection(db_dir: Path, collection_id: str) -> tuple[bool, str, dict]:
    """Removes a collection from the collections.json file and cleans up file metadata.

    For each file in the collection:
    - Removes the collection from the file's doc_collections array
    - If the file has no other collections after removal, marks it as deleted

    Args:
        db_dir: Path to the db directory
        collection_id: The collection ID to remove

    Returns:
        Tuple of (success: bool, message: str, stats: dict)
        where stats contains 'files_updated' and 'files_deleted' counts
    """
    collections_data = load_entity_data(db_dir, 'collections')

    if not collection_exists(collection_id, collections_data):
        return False, f"Collection '{collection_id}' not found.", {}

    # Import database utilities
    from .database import DatabaseManager
    from .file_repository import FileRepository
    from .models import FileUpdate

    # Initialize database access
    db_path = db_dir / "metadata.db"
    db_manager = DatabaseManager(db_path)
    file_repo = FileRepository(db_manager)

    files_updated = 0
    files_deleted = 0

    # Get all files that contain this collection
    files_with_collection = file_repo.get_files_by_collection(collection_id, include_deleted=False)

    # Update each file's collection list
    for file_metadata in files_with_collection:
        doc_collections = file_metadata.doc_collections.copy()

        # Remove the collection from the array
        if collection_id in doc_collections:
            doc_collections.remove(collection_id)

            # Update the file
            if len(doc_collections) == 0:
                # No collections left - mark as deleted
                file_repo.mark_deleted(file_metadata.id)
                files_deleted += 1
            else:
                # Still has other collections - just update the array
                file_repo.update_file(file_metadata.id, FileUpdate(doc_collections=doc_collections))
                files_updated += 1

    # Remove collection from collections.json
    collections_data = [collection for collection in collections_data
                        if collection.get('id') != collection_id]
    save_entity_data(db_dir, 'collections', collections_data)

    stats = {
        'files_updated': files_updated,
        'files_deleted': files_deleted
    }

    message = f"Collection '{collection_id}' removed successfully."
    if files_updated > 0 or files_deleted > 0:
        message += f" {files_updated} files updated, {files_deleted} files marked as deleted."

    return True, message, stats


def set_collection_property(db_dir: Path, collection_id: str, property_name: str, value: str) -> tuple[bool, str]:
    """Sets a property for a collection.

    Args:
        db_dir: Path to the db directory
        collection_id: The collection ID
        property_name: The property to set (name, description)
        value: The new value

    Returns:
        Tuple of (success: bool, message: str)
    """
    collections_data = load_entity_data(db_dir, 'collections')

    # Check for ID conflicts if changing ID
    if property_name == 'id':
        if collection_exists(value, collections_data):
            return False, f"Collection with ID '{value}' already exists."

    collection = find_collection(collection_id, collections_data)
    if not collection:
        return False, f"Collection '{collection_id}' not found."

    collection[property_name] = value
    save_entity_data(db_dir, 'collections', collections_data)

    if property_name == 'id':
        return True, f"Collection '{collection_id}' is now '{value}'."
    else:
        return True, f"Property '{property_name}' for collection '{collection_id}' set to '{value}'."


def list_collections(db_dir: Path) -> List[Dict[str, Any]]:
    """Lists all collections.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of collection dictionaries
    """
    return load_entity_data(db_dir, 'collections')
