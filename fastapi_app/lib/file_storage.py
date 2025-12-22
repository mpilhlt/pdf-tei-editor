"""
Hash-based file storage with git-style sharding and reference counting.

Provides content-addressable file storage with:
- Git-style hash sharding (hash[:2]/hash.ext)
- Automatic deduplication (same content = one file)
- Safe file operations (atomic writes, cleanup)
- Reference counting for safe cleanup (no orphaned files)
"""

import shutil
from pathlib import Path
from typing import Optional, Tuple, Dict
from .hash_utils import generate_file_hash, get_storage_path, get_file_extension
from .storage_references import StorageReferenceManager


class FileStorage:
    """
    Content-addressable file storage with hash sharding and reference counting.

    Files are stored as: {data_root}/{hash[:2]}/{hash}{extension}
    Example: data/ab/abcdef123....tei.xml

    This provides:
    - Automatic deduplication (same hash = same file)
    - Fast filesystem operations (max ~390 files per shard with 100k files)
    - Reference counting for safe cleanup
    - No orphaned files from content changes
    """

    def __init__(self, data_root: Path, db_path: Path, logger=None):
        """
        Initialize file storage with reference counting.

        Args:
            data_root: Root directory for file storage
            db_path: Path to metadata database (for reference counting)
            logger: Optional logger instance
        """
        self.data_root = Path(data_root)
        self.logger = logger
        self.ref_manager = StorageReferenceManager(db_path, logger)

        # Ensure data root exists
        self.data_root.mkdir(parents=True, exist_ok=True)

    def save_file(self, content: bytes, file_type: str, increment_ref: bool = True) -> Tuple[str, Path]:
        """
        Save file content and return hash and path.

        If file with same hash already exists, does nothing (deduplication).
        Uses atomic write (write to temp, then move) to prevent partial writes.

        Reference counting: By default, increments ref count when saving.
        Set increment_ref=False if reference will be managed separately.

        Args:
            content: File content bytes
            file_type: Type of file ('pdf', 'tei', 'rng')
            increment_ref: Whether to increment reference count (default: True)

        Returns:
            Tuple of (file_hash, storage_path)

        Raises:
            ValueError: If file_type is unknown
            OSError: If file write fails
        """
        # Generate hash
        file_hash = generate_file_hash(content)

        # Get storage path
        storage_path = get_storage_path(self.data_root, file_hash, file_type)

        # Check if file already exists (deduplication)
        file_existed = storage_path.exists()

        if file_existed:
            if self.logger:
                self.logger.debug(f"File already exists (deduplicated): {file_hash[:8]}...")
        else:
            # Write file atomically (temp file + move)
            temp_path = storage_path.with_suffix(storage_path.suffix + '.tmp')

            try:
                # Ensure shard directory exists
                storage_path.parent.mkdir(parents=True, exist_ok=True)

                # Write to temp file
                temp_path.write_bytes(content)

                # Atomic move
                temp_path.rename(storage_path)

                if self.logger:
                    self.logger.debug(f"Saved file: {file_hash[:8]}... ({len(content)} bytes)")

            except Exception as e:
                # Cleanup temp file on error
                if temp_path.exists():
                    temp_path.unlink()

                if self.logger:
                    self.logger.error(f"Failed to save file {file_hash[:8]}...: {e}")
                raise

        # Increment reference count (whether file existed or was newly created)
        if increment_ref:
            self.ref_manager.increment_reference(file_hash, file_type)

        return file_hash, storage_path

    def get_file_path(self, file_hash: str, file_type: str) -> Optional[Path]:
        """
        Get storage path for a file.

        Args:
            file_hash: SHA-256 hash of file content
            file_type: Type of file ('pdf', 'tei', 'rng')

        Returns:
            Path to file if it exists, None otherwise

        Raises:
            ValueError: If file_type is unknown
        """
        storage_path = get_storage_path(self.data_root, file_hash, file_type)

        if storage_path.exists():
            return storage_path
        return None

    def read_file(self, file_hash: str, file_type: str) -> Optional[bytes]:
        """
        Read file content.

        Args:
            file_hash: SHA-256 hash of file content
            file_type: Type of file ('pdf', 'tei', 'rng')

        Returns:
            File content bytes or None if file not found

        Raises:
            ValueError: If file_type is unknown
            OSError: If file read fails
        """
        file_path = self.get_file_path(file_hash, file_type)

        if file_path:
            return file_path.read_bytes()
        return None

    def delete_file(self, file_hash: str, file_type: str, decrement_ref: bool = True) -> bool:
        """
        Delete a file with reference counting support.

        By default, decrements reference count and only physically deletes
        the file when ref_count reaches 0.

        Set decrement_ref=False to force delete without checking references
        (use with caution - only for garbage collection).

        Args:
            file_hash: SHA-256 hash of file content
            file_type: Type of file ('pdf', 'tei', 'rng')
            decrement_ref: Whether to use reference counting (default: True)

        Returns:
            True if file was deleted, False if file didn't exist or still has references

        Raises:
            ValueError: If file_type is unknown
            OSError: If file deletion fails
        """
        file_path = self.get_file_path(file_hash, file_type)

        if not file_path:
            return False

        # Check reference count before deleting
        should_delete_physical = False

        if decrement_ref:
            new_count, should_delete = self.ref_manager.decrement_reference(file_hash)
            should_delete_physical = should_delete

            if not should_delete_physical:
                if self.logger:
                    self.logger.debug(
                        f"Not deleting {file_hash[:8]}... - still has {new_count} reference(s)"
                    )
                return False
        else:
            # Force delete without ref counting (garbage collection)
            should_delete_physical = True

        # Delete physical file
        try:
            file_path.unlink()

            if self.logger:
                self.logger.info(f"Deleted file: {file_hash[:8]}... (ref_count reached 0)")

            # Remove reference entry after successful deletion
            if decrement_ref:
                self.ref_manager.remove_reference_entry(file_hash)

            # Cleanup empty shard directory
            shard_dir = file_path.parent
            try:
                if shard_dir.exists() and not any(shard_dir.iterdir()):
                    shard_dir.rmdir()

                    if self.logger:
                        self.logger.debug(f"Removed empty shard directory: {shard_dir.name}")
            except (OSError, FileNotFoundError):
                # Directory not empty or was already removed
                pass

            return True

        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to delete file {file_hash[:8]}...: {e}")
            raise

    def file_exists(self, file_hash: str, file_type: str) -> bool:
        """
        Check if file exists.

        Args:
            file_hash: SHA-256 hash of file content
            file_type: Type of file ('pdf', 'tei', 'rng')

        Returns:
            True if file exists, False otherwise

        Raises:
            ValueError: If file_type is unknown
        """
        return self.get_file_path(file_hash, file_type) is not None

    def get_storage_stats(self) -> Dict[str, any]:
        """
        Get storage statistics.

        Returns:
            Dictionary with storage statistics:
            - total_shards: Number of shard directories
            - total_files: Total number of files
            - total_size: Total size in bytes
            - files_by_type: Dict of file counts by type
        """
        total_shards = 0
        total_files = 0
        total_size = 0
        files_by_type = {'pdf': 0, 'tei': 0, 'rng': 0, 'other': 0}

        # Scan all shard directories
        for shard_dir in self.data_root.iterdir():
            if shard_dir.is_dir() and len(shard_dir.name) == 2:
                total_shards += 1

                # Count files in shard
                for file_path in shard_dir.iterdir():
                    if file_path.is_file():
                        total_files += 1
                        total_size += file_path.stat().st_size

                        # Count by type
                        if file_path.suffix == '.pdf':
                            files_by_type['pdf'] += 1
                        elif file_path.name.endswith('.tei.xml'):
                            files_by_type['tei'] += 1
                        elif file_path.suffix == '.rng':
                            files_by_type['rng'] += 1
                        else:
                            files_by_type['other'] += 1

        return {
            'total_shards': total_shards,
            'total_files': total_files,
            'total_size': total_size,
            'files_by_type': files_by_type,
            'avg_files_per_shard': total_files / total_shards if total_shards > 0 else 0
        }

    def verify_file(self, file_hash: str, file_type: str) -> bool:
        """
        Verify file integrity by recomputing hash.

        Args:
            file_hash: Expected SHA-256 hash
            file_type: Type of file ('pdf', 'tei', 'rng')

        Returns:
            True if file exists and hash matches, False otherwise

        Raises:
            ValueError: If file_type is unknown
        """
        content = self.read_file(file_hash, file_type)

        if content is None:
            return False

        # Recompute hash and compare
        computed_hash = generate_file_hash(content)
        return computed_hash == file_hash

    def find_orphaned_files(self, file_repository) -> list:
        """
        Find files in storage that have no corresponding database entry.

        An orphaned file is one that exists in storage but has no entry in the
        files database. This can happen due to:
        - Failed database operations during file deletion
        - System crashes
        - Manual database modifications

        Args:
            file_repository: FileRepository instance to check database

        Returns:
            List of tuples: (file_hash, file_type, file_path, file_size)
        """
        orphaned = []

        # Scan all shard directories
        for shard_dir in self.data_root.iterdir():
            if not shard_dir.is_dir() or len(shard_dir.name) != 2:
                continue

            # Check each file in the shard
            for file_path in shard_dir.iterdir():
                if not file_path.is_file() or file_path.suffix == '.tmp':
                    continue

                # Extract hash from filename
                file_name = file_path.stem
                # Handle .tei.xml files
                if file_path.name.endswith('.tei.xml'):
                    file_hash = file_name[:-4]  # Remove .tei
                    file_type = 'tei'
                elif file_path.suffix == '.pdf':
                    file_hash = file_name
                    file_type = 'pdf'
                elif file_path.suffix == '.rng':
                    file_hash = file_name
                    file_type = 'rng'
                else:
                    # Unknown file type, skip
                    if self.logger:
                        self.logger.debug(f"Skipping unknown file type: {file_path}")
                    continue

                # Check if there's a database entry for this file
                file_metadata = file_repository.get_file_by_id(file_hash, include_deleted=True)

                if file_metadata is None:
                    # No database entry - this is an orphan
                    file_size = file_path.stat().st_size
                    orphaned.append((file_hash, file_type, file_path, file_size))

                    if self.logger:
                        self.logger.debug(
                            f"Found orphaned file: {file_hash[:8]}... ({file_type}, {file_size} bytes)"
                        )

        return orphaned
