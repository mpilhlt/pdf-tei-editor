"""
Hash abbreviation module for client-server communication.

DEPRECATED: This module is being phased out in favor of stable_id system.
stable_id provides permanent short IDs that don't change when file content changes.

Legacy support maintained for backward compatibility during transition.

Database stores full SHA-256 hashes (64 characters) for content addressing.
API now returns stable_id (6+ characters) for user-facing identifiers.
"""

from typing import Dict, Set, Optional
import logging

logger = logging.getLogger(__name__)


class HashAbbreviator:
    """
    Manages hash abbreviation with collision detection.

    Usage:
        abbreviator = HashAbbreviator()
        short_hash = abbreviator.abbreviate("abc123...def")  # Returns "abc12"
        full_hash = abbreviator.resolve("abc12")  # Returns "abc123...def"
    """

    def __init__(self, min_length: int = 5):
        """
        Args:
            min_length: Minimum hash length to attempt (default: 5)
        """
        self.min_length = min_length
        self.full_to_short: Dict[str, str] = {}
        self.short_to_full: Dict[str, str] = {}
        self.current_length = min_length

    def find_safe_length(self, all_hashes: Set[str]) -> int:
        """
        Find minimum hash length that avoids collisions.

        Args:
            all_hashes: Set of all full hashes

        Returns:
            Minimum collision-free hash length
        """
        if not all_hashes:
            return self.min_length

        hash_length = self.min_length
        max_length = len(next(iter(all_hashes))) if all_hashes else 64

        while hash_length <= max_length:
            shortened = {h[:hash_length] for h in all_hashes}
            if len(shortened) == len(all_hashes):
                # No collisions
                return hash_length
            hash_length += 1

        return hash_length

    def rebuild_mappings(self, all_full_hashes: Set[str]) -> None:
        """
        Rebuild hash mappings with collision-free length.
        Called when collision detected or on initialization.

        Args:
            all_full_hashes: All full hashes in the system
        """
        self.current_length = self.find_safe_length(all_full_hashes)
        self.full_to_short = {h: h[:self.current_length] for h in all_full_hashes}
        self.short_to_full = {short: full for full, short in self.full_to_short.items()}

        if self.current_length > self.min_length:
            logger.warning(
                f"Hash collision detected. Using {self.current_length}-character hashes "
                f"for {len(all_full_hashes)} files."
            )

    def abbreviate(self, full_hash: str) -> str:
        """
        Get abbreviated hash for client communication.

        Args:
            full_hash: Full SHA-256 hash (64 chars)

        Returns:
            Abbreviated hash (5+ chars)
        """
        if full_hash in self.full_to_short:
            return self.full_to_short[full_hash]

        # New hash - add to mappings
        short = full_hash[:self.current_length]

        if short in self.short_to_full:
            # Collision! Rebuild everything
            logger.warning(f"Hash collision detected for {full_hash[:16]}...")
            all_hashes = set(self.full_to_short.keys()) | {full_hash}
            self.rebuild_mappings(all_hashes)
            return self.full_to_short[full_hash]

        # No collision
        self.full_to_short[full_hash] = short
        self.short_to_full[short] = full_hash
        return short

    def resolve(self, short_hash: str) -> str:
        """
        Resolve abbreviated hash to full hash.

        Args:
            short_hash: Abbreviated hash from client

        Returns:
            Full SHA-256 hash

        Raises:
            KeyError: If hash not found
        """
        if short_hash in self.short_to_full:
            return self.short_to_full[short_hash]

        # Try as full hash (client might send full hash)
        if len(short_hash) == 64 and short_hash in self.full_to_short:
            return short_hash

        raise KeyError(f"Hash not found: {short_hash}")

    def can_resolve(self, hash_value: str) -> bool:
        """Check if hash can be resolved"""
        return (hash_value in self.short_to_full or
                (len(hash_value) == 64 and hash_value in self.full_to_short))


# Global abbreviator instance (initialized per request)
_abbreviator: Optional[HashAbbreviator] = None


def get_abbreviator(repo: 'FileRepository') -> HashAbbreviator:
    """
    Get or create hash abbreviator for current request.
    Loads all hashes from database to detect collisions.

    Args:
        repo: FileRepository instance

    Returns:
        Initialized HashAbbreviator
    """
    global _abbreviator

    if _abbreviator is None:
        # Get all file hashes from database
        all_files = repo.list_files(include_deleted=True)
        all_hashes = {f.id for f in all_files}

        _abbreviator = HashAbbreviator()
        if all_hashes:
            _abbreviator.rebuild_mappings(all_hashes)

    return _abbreviator


def abbreviate_hash(full_hash: str, repo: 'FileRepository') -> str:
    """
    Get stable_id for a content hash (NEW BEHAVIOR).

    Returns the stable_id associated with this content hash.
    This ID remains constant even as file content changes.

    Args:
        full_hash: Full SHA-256 content hash
        repo: FileRepository instance

    Returns:
        Stable ID (6+ chars)
    """
    file = repo.get_file_by_id(full_hash)
    if file:
        return file.stable_id
    # Fallback to old abbreviation for non-existent files (shouldn't happen)
    abbreviator = get_abbreviator(repo)
    return abbreviator.abbreviate(full_hash)


def resolve_hash(identifier: str, repo: 'FileRepository') -> str:
    """
    Resolve stable_id or short hash to full content hash (NEW BEHAVIOR).

    Tries stable_id lookup first, falls back to legacy abbreviation resolution.

    Args:
        identifier: Stable ID (6-12 chars) or legacy abbreviated hash
        repo: FileRepository instance

    Returns:
        Full SHA-256 content hash
    """
    # Try stable_id lookup first
    try:
        return repo.resolve_file_id(identifier)
    except ValueError:
        pass

    # Fallback to legacy abbreviation resolution
    abbreviator = get_abbreviator(repo)
    return abbreviator.resolve(identifier)


def reset_abbreviator() -> None:
    """Reset global abbreviator (for testing)"""
    global _abbreviator
    _abbreviator = None
