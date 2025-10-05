"""
Hash utility functions for file identification and storage.

This module provides framework-agnostic hashing utilities with dependency injection.
Implements git-style hash-sharded storage for the new SQLite-based system.
No Flask or FastAPI dependencies - all parameters are explicitly passed.
"""

import hashlib
from pathlib import Path
from typing import Optional


def generate_file_hash(content: bytes) -> str:
    """
    Generate SHA-256 hash of file content.

    This is used for content-addressable storage in the new system.
    Note: Different from the old MD5 path-based hashing.

    Args:
        content: File content bytes

    Returns:
        SHA-256 hash (64 hex characters)
    """
    return hashlib.sha256(content).hexdigest()


def get_file_extension(file_type: str) -> str:
    """
    Get file extension for file_type.

    Maps file types to their appropriate extensions:
    - 'pdf' -> '.pdf'
    - 'tei' -> '.tei.xml'
    - 'rng' -> '.rng'

    Args:
        file_type: Type of file ('pdf', 'tei', 'rng')

    Returns:
        File extension including the dot

    Raises:
        ValueError: If file_type is unknown
    """
    extensions = {
        'pdf': '.pdf',
        'tei': '.tei.xml',
        'rng': '.rng'
    }
    if file_type not in extensions:
        raise ValueError(f"Unknown file_type: {file_type}")
    return extensions[file_type]


def get_storage_path(data_root: Path, file_hash: str, file_type: str) -> Path:
    """
    Get storage path using git-style hash sharding.

    Pattern: {data_root}/{hash[:2]}/{hash}{extension}
    Example: data/ab/abcdef123....tei.xml

    Creates the shard directory if it doesn't exist.

    Args:
        data_root: Root directory for file storage
        file_hash: SHA-256 hash of file content
        file_type: Type of file ('pdf', 'tei', 'rng')

    Returns:
        Full path to where the file should be stored

    Raises:
        ValueError: If file_type is unknown
    """
    # Create shard directory (first 2 characters of hash)
    shard_dir = data_root / file_hash[:2]
    shard_dir.mkdir(parents=True, exist_ok=True)

    # Get extension and build full path
    extension = get_file_extension(file_type)
    return shard_dir / f"{file_hash}{extension}"


def get_relative_storage_path(file_hash: str, file_type: str) -> str:
    """
    Get relative storage path (without data_root) for database storage.

    Pattern: {hash[:2]}/{hash}{extension}
    Example: ab/abcdef123....tei.xml

    Args:
        file_hash: SHA-256 hash of file content
        file_type: Type of file ('pdf', 'tei', 'rng')

    Returns:
        Relative path string (POSIX format)

    Raises:
        ValueError: If file_type is unknown
    """
    extension = get_file_extension(file_type)
    return f"{file_hash[:2]}/{file_hash}{extension}"


# Legacy hash lookup functions (for migration compatibility)
# These will be removed once migration to SQLite is complete


def generate_path_hash(file_path: str) -> str:
    """
    Generate MD5 hash for a file path (legacy function).

    This is the old method used for path-based hashing.
    Kept for migration purposes only.

    Args:
        file_path: File path relative to data root

    Returns:
        MD5 hash of the file path
    """
    return hashlib.md5(file_path.encode('utf-8')).hexdigest()


def shorten_hash(full_hash: str, target_length: int) -> str:
    """
    Shorten a hash to the specified length (legacy function).

    Args:
        full_hash: Full hash string
        target_length: Desired hash length

    Returns:
        Shortened hash
    """
    return full_hash[:target_length]


def find_safe_hash_length(all_hashes: set) -> int:
    """
    Find minimum hash length to avoid collisions (legacy function).

    Args:
        all_hashes: Set of all full hashes

    Returns:
        Minimum hash length that avoids collisions
    """
    if not all_hashes:
        return 5

    hash_length = 5
    max_length = len(next(iter(all_hashes))) if all_hashes else 32

    while hash_length <= max_length:
        shortened_hashes = {h[:hash_length] for h in all_hashes}
        if len(shortened_hashes) == len(all_hashes):
            # No collisions at this length
            break
        hash_length += 1

    return hash_length
