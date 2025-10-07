"""
Hash utility functions for file identification and lookup.
This module centralizes all hashing logic to ensure consistency across the application.
"""

import hashlib
import json
import sys
from pathlib import Path
from typing import Optional, Dict

# Platform-specific imports for file locking
if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl


def _lock_file(file_handle):
    """Cross-platform file locking"""
    if sys.platform == 'win32':
        # On Windows, msvcrt.locking locks the entire file
        # LK_NBLCK for non-blocking lock, but we want blocking behavior like fcntl
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_LOCK, 1)
        except OSError:
            # If locking fails, continue anyway (Windows file locking is advisory)
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_EX)


def _unlock_file(file_handle):
    """Cross-platform file unlocking"""
    if sys.platform == 'win32':
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            # If unlocking fails, it might already be unlocked
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_UN)


# Global cache for hash lookup table
_hash_lookup_cache = None
_hash_lookup_mtime = None


def generate_file_hash(file_path: str) -> str:
    """
    Generate a hash for the file path for use as ID.

    Args:
        file_path (str): File path relative to data root

    Returns:
        str: MD5 hash of the file path
    """
    return hashlib.md5(file_path.encode('utf-8')).hexdigest()


def shorten_hash(full_hash: str, target_length: int) -> str:
    """
    Shorten a hash to the specified length.

    Args:
        full_hash (str): Full hash string
        target_length (int): Desired hash length

    Returns:
        str: Shortened hash
    """
    return full_hash[:target_length]


def find_safe_hash_length(all_hashes: set) -> int:
    """
    Find minimum hash length to avoid collisions.

    Args:
        all_hashes (set): Set of all full hashes

    Returns:
        int: Minimum hash length that avoids collisions
    """
    if not all_hashes:
        return 5

    hash_length = 5
    while hash_length <= 32:  # MD5 hashes are 32 characters
        shortened_hashes = {h[:hash_length] for h in all_hashes}
        if len(shortened_hashes) == len(all_hashes):
            # No collisions at this length
            break
        hash_length += 1

    return hash_length


def create_hash_mapping(all_hashes: set) -> dict:
    """
    Create mapping from long hash to short hash with collision avoidance.

    Args:
        all_hashes (set): Set of all full hashes

    Returns:
        dict: Mapping from full hash to shortened hash
    """
    hash_length = find_safe_hash_length(all_hashes)
    return {long_hash: long_hash[:hash_length] for long_hash in all_hashes}


def load_hash_lookup(db_dir: Path, logger=None) -> Dict[str, str]:
    """
    Load and cache the hash lookup table from disk.
    Only reloads if the file has been modified since last load.

    Args:
        db_dir: Path to database directory
        logger: Optional logger for debug output

    Returns:
        dict: Hash to file path lookup table
    """
    global _hash_lookup_cache, _hash_lookup_mtime

    try:
        lookup_file = db_dir / 'lookup.json'

        if not lookup_file.exists():
            if logger:
                logger.warning("Hash lookup table not found")
            return {}

        # Check if we need to reload (file modified or not cached)
        current_mtime = lookup_file.stat().st_mtime
        if _hash_lookup_cache is None or _hash_lookup_mtime != current_mtime:
            with open(lookup_file, 'r', encoding='utf-8') as f:
                _hash_lookup_cache = json.load(f)
            _hash_lookup_mtime = current_mtime
            if logger:
                logger.debug(f"Loaded hash lookup table with {len(_hash_lookup_cache)} entries")

        return _hash_lookup_cache

    except (OSError, json.JSONDecodeError) as e:
        if logger:
            logger.error(f"Failed to load hash lookup table: {e}")
        return {}


def resolve_hash_to_path(file_hash: str, db_dir: Path, logger=None) -> str:
    """
    Resolve a file hash to its path using the lookup table.

    Args:
        file_hash: Hash to resolve
        db_dir: Path to database directory
        logger: Optional logger for debug output

    Returns:
        str: File path relative to data root

    Raises:
        KeyError: If hash is not found in lookup table
    """
    lookup_table = load_hash_lookup(db_dir, logger)

    if file_hash not in lookup_table:
        raise KeyError(f"Hash '{file_hash}' not found in lookup table")

    return lookup_table[file_hash]


def add_path_to_lookup(file_path: str, db_dir: Path, logger=None) -> str:
    """
    Generates a hash for a file path, adds it to the lookup table,
    and saves the updated table.
    If the path already exists, it returns the existing hash.
    This function is thread-safe using file locks.

    Args:
        file_path: File path to add
        db_dir: Path to database directory
        logger: Optional logger for debug output

    Returns:
        str: Hash for the file path
    """
    lookup_file = db_dir / 'lookup.json'

    # Ensure the directory exists
    lookup_file.parent.mkdir(parents=True, exist_ok=True)

    # File lock to handle concurrency
    # Use 'r+' to read and write, 'w+' for creation if not exists
    with open(lookup_file, 'r+' if lookup_file.exists() else 'w+') as f:
        _lock_file(f)

        f.seek(0)
        try:
            # Handle empty file case
            content = f.read()
            if not content:
                lookup_table = {}
            else:
                lookup_table = json.loads(content)
        except json.JSONDecodeError:
            lookup_table = {}

        # Invalidate cache so it's re-read next time by other processes
        invalidate_hash_lookup_cache()

        reverse_lookup = {v: k for k, v in lookup_table.items()}
        if file_path in reverse_lookup:
            _unlock_file(f)
            return reverse_lookup[file_path]

        # --- It's a new path, add it ---

        # Determine current hash length
        hash_length = 5 # Default length
        if lookup_table:
            hash_length = len(next(iter(lookup_table.keys())))

        new_full_hash = generate_file_hash(file_path)
        new_short_hash = new_full_hash[:hash_length]

        if new_short_hash not in lookup_table:
            # No collision, just add it
            lookup_table[new_short_hash] = file_path
            new_hash_to_return = new_short_hash
        else:
            # Collision detected! Re-hash everything.
            if logger:
                logger.warning(f"Hash collision detected for {file_path} at length {hash_length}. Re-hashing lookup table.")

            all_paths = list(lookup_table.values()) + [file_path]
            all_full_hashes = {generate_file_hash(p) for p in all_paths}

            new_hash_length = find_safe_hash_length(all_full_hashes)
            if logger:
                logger.info(f"New safe hash length is {new_hash_length}.")

            lookup_table = {}
            path_to_new_hash = {}

            # Create new lookup table
            for p in all_paths:
                full_h = generate_file_hash(p)
                short_h = full_h[:new_hash_length]
                lookup_table[short_h] = p
                path_to_new_hash[p] = short_h

            new_hash_to_return = path_to_new_hash[file_path]

        # Write back to file
        f.seek(0)
        f.truncate()
        json.dump(lookup_table, f, indent=2)

        _unlock_file(f)

        # Invalidate cache again after modification
        invalidate_hash_lookup_cache()

        return new_hash_to_return


def generate_hashes_for_saved_file(pdf_absolute_path: str, tei_absolute_path: str,
                                 data_root: str, db_dir: Path, logger=None) -> dict:
    """
    Generate shortened hashes for saved PDF and TEI files that match the current lookup table format.

    Args:
        pdf_absolute_path: Absolute path to PDF file
        tei_absolute_path: Absolute path to TEI file
        data_root: Data root directory path
        db_dir: Path to database directory
        logger: Optional logger for debug output

    Returns:
        dict: Dictionary with 'pdf' and 'xml' shortened hash keys
    """
    # Convert absolute paths to relative paths
    pdf_relative_path_str = Path(pdf_absolute_path).relative_to(Path(data_root)).as_posix()
    tei_relative_path_str = Path(tei_absolute_path).relative_to(Path(data_root)).as_posix()

    # Generate full hashes using the standard method
    pdf_full_hash = generate_file_hash(pdf_relative_path_str)
    tei_full_hash = generate_file_hash(tei_relative_path_str)

    # Load the current lookup table to determine the hash length being used
    lookup_table = load_hash_lookup(db_dir, logger)

    # Determine hash length from existing hashes (they should all be the same length)
    hash_length = 32  # Default to full hash if lookup is empty
    if lookup_table:
        # Get length from first hash in lookup table
        sample_hash = next(iter(lookup_table.keys()))
        hash_length = len(sample_hash)

    # Return shortened hashes that match the lookup table format
    return {
        'pdf': pdf_full_hash[:hash_length],
        'xml': tei_full_hash[:hash_length]
    }


def invalidate_hash_lookup_cache():
    """
    Invalidate the cached hash lookup table.
    This forces a reload on the next access.
    """
    global _hash_lookup_cache, _hash_lookup_mtime
    _hash_lookup_cache = None
    _hash_lookup_mtime = None