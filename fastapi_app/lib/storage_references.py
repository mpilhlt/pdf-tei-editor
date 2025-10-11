"""
Storage reference counting for safe file cleanup.

This module manages reference counting for physical files in hash-sharded storage.
Multiple database entries can reference the same physical file (content deduplication),
so we track reference counts to safely delete files only when no longer needed.

Design:
- storage_refs table tracks ref_count per content hash
- Increment when file is saved/created
- Decrement when file is deleted or hash changes
- Physical file deletion only when ref_count reaches 0

This prevents:
- Orphaned files (no cleanup strategy)
- Premature deletion (breaking deduplication)
- Race conditions (atomic ref counting)
"""

import sqlite3
from pathlib import Path
from typing import Optional
from contextlib import contextmanager


class StorageReferenceManager:
    """
    Manages reference counting for physical storage files.

    Ensures safe deletion of content-addressed storage files
    by tracking how many database entries reference each hash.
    """

    def __init__(self, db_path: Path, logger=None):
        """
        Initialize storage reference manager.

        Args:
            db_path: Path to metadata.db (same as main database)
            logger: Optional logger instance
        """
        self.db_path = db_path
        self.logger = logger
        self._ensure_table_exists()

    @contextmanager
    def _get_connection(self):
        """Get database connection with proper settings."""
        conn = None
        try:
            conn = sqlite3.connect(str(self.db_path), timeout=10.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            yield conn
        except sqlite3.Error as e:
            if self.logger:
                self.logger.error(f"Database error: {e}")
            raise
        finally:
            if conn:
                conn.close()

    def _ensure_table_exists(self) -> None:
        """
        Create storage_refs table if it doesn't exist.

        Schema:
        - file_hash: SHA-256 hash (PRIMARY KEY)
        - file_type: 'pdf', 'tei', 'rng' (for garbage collection)
        - ref_count: Number of database entries referencing this file
        - created_at: When first reference was added
        - updated_at: When ref_count last changed
        """
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS storage_refs (
                    file_hash TEXT PRIMARY KEY,
                    file_type TEXT NOT NULL,
                    ref_count INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CHECK(ref_count >= 0)
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_ref_count
                ON storage_refs(ref_count)
                WHERE ref_count = 0
            """)
            conn.commit()

            if self.logger:
                self.logger.debug("Storage references table initialized")

    def increment_reference(self, file_hash: str, file_type: str) -> int:
        """
        Increment reference count for a file.

        Creates entry if it doesn't exist, otherwise increments existing count.
        This should be called when:
        - New file is saved to storage
        - Database entry is created pointing to this hash

        Args:
            file_hash: SHA-256 hash of file content
            file_type: File type ('pdf', 'tei', 'rng')

        Returns:
            New reference count
        """
        with self._get_connection() as conn:
            # Use INSERT OR IGNORE + UPDATE pattern for atomicity
            conn.execute("""
                INSERT OR IGNORE INTO storage_refs (file_hash, file_type, ref_count)
                VALUES (?, ?, 0)
            """, (file_hash, file_type))

            conn.execute("""
                UPDATE storage_refs
                SET ref_count = ref_count + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE file_hash = ?
            """, (file_hash,))

            # Get new count
            cursor = conn.execute(
                "SELECT ref_count FROM storage_refs WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()
            new_count = row['ref_count'] if row else 0

            conn.commit()

            if self.logger:
                self.logger.debug(f"Incremented ref count for {file_hash[:8]}... to {new_count}")

            return new_count

    def decrement_reference(self, file_hash: str) -> tuple[int, bool]:
        """
        Decrement reference count for a file.

        This should be called when:
        - Database entry is deleted
        - Database entry's hash changes (old hash gets decremented)

        Args:
            file_hash: SHA-256 hash of file content

        Returns:
            Tuple of (new_ref_count, should_delete_file)
            should_delete_file is True when ref_count reaches 0
        """
        with self._get_connection() as conn:
            # Check if entry exists
            cursor = conn.execute(
                "SELECT ref_count FROM storage_refs WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()

            if not row:
                if self.logger:
                    self.logger.warning(f"No reference entry for {file_hash[:8]}... (orphaned file?)")
                return (0, True)  # Should clean up orphaned file

            current_count = row['ref_count']

            if current_count <= 0:
                if self.logger:
                    self.logger.warning(f"Reference count already 0 for {file_hash[:8]}...")
                return (0, True)

            # Decrement
            conn.execute("""
                UPDATE storage_refs
                SET ref_count = ref_count - 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE file_hash = ?
            """, (file_hash,))

            # Get new count
            cursor = conn.execute(
                "SELECT ref_count FROM storage_refs WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()
            new_count = row['ref_count'] if row else 0

            conn.commit()

            should_delete = (new_count == 0)

            if self.logger:
                action = "SHOULD DELETE" if should_delete else f"now {new_count}"
                self.logger.debug(f"Decremented ref count for {file_hash[:8]}... - {action}")

            return (new_count, should_delete)

    def get_reference_count(self, file_hash: str) -> Optional[int]:
        """
        Get current reference count for a file.

        Args:
            file_hash: SHA-256 hash of file content

        Returns:
            Reference count, or None if not tracked
        """
        with self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT ref_count FROM storage_refs WHERE file_hash = ?",
                (file_hash,)
            )
            row = cursor.fetchone()
            return row['ref_count'] if row else None

    def cleanup_zero_refs(self) -> list[tuple[str, str]]:
        """
        Get list of files with zero references (garbage collection).

        Returns list of (file_hash, file_type) tuples that can be deleted.
        Does NOT delete the entries - caller should delete files and then
        call remove_reference_entry().

        Returns:
            List of (file_hash, file_type) tuples ready for deletion
        """
        with self._get_connection() as conn:
            cursor = conn.execute("""
                SELECT file_hash, file_type
                FROM storage_refs
                WHERE ref_count = 0
            """)
            return [(row['file_hash'], row['file_type']) for row in cursor.fetchall()]

    def remove_reference_entry(self, file_hash: str) -> None:
        """
        Remove reference tracking entry (after file is physically deleted).

        Only call this after the physical file has been deleted.

        Args:
            file_hash: SHA-256 hash of file content
        """
        with self._get_connection() as conn:
            conn.execute("DELETE FROM storage_refs WHERE file_hash = ?", (file_hash,))
            conn.commit()

            if self.logger:
                self.logger.debug(f"Removed reference entry for {file_hash[:8]}...")

    def rebuild_from_files_table(self) -> dict[str, int]:
        """
        Rebuild reference counts from files table (recovery/migration).

        This scans the files table and rebuilds storage_refs based on
        current database state. Useful for:
        - Initial migration to reference counting system
        - Recovery after corruption
        - Verification of reference counts

        Returns:
            Dictionary of {file_hash: ref_count} for verification
        """
        with self._get_connection() as conn:
            # Clear existing refs
            conn.execute("DELETE FROM storage_refs")

            # Count references per hash from files table
            cursor = conn.execute("""
                SELECT id, file_type, COUNT(*) as ref_count
                FROM files
                WHERE deleted = 0
                GROUP BY id, file_type
            """)

            ref_counts = {}
            for row in cursor.fetchall():
                file_hash = row['id']
                file_type = row['file_type']
                count = row['ref_count']

                conn.execute("""
                    INSERT INTO storage_refs (file_hash, file_type, ref_count)
                    VALUES (?, ?, ?)
                """, (file_hash, file_type, count))

                ref_counts[file_hash] = count

            conn.commit()

            if self.logger:
                self.logger.info(f"Rebuilt references for {len(ref_counts)} files")

            return ref_counts

    def get_orphaned_files(self, storage_root: Path) -> list[tuple[str, str]]:
        """
        Find files in storage that have no reference tracking entry.

        This indicates orphaned files that should be cleaned up.

        Args:
            storage_root: Root directory of hash-sharded storage

        Returns:
            List of (file_hash, file_type) tuples for orphaned files
        """
        orphaned = []

        # Scan storage directories
        if not storage_root.exists():
            return orphaned

        # Get all tracked hashes
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT file_hash FROM storage_refs")
            tracked_hashes = {row['file_hash'] for row in cursor.fetchall()}

        # Scan storage shards (2-char hex directories)
        for shard_dir in storage_root.iterdir():
            if not shard_dir.is_dir() or len(shard_dir.name) != 2:
                continue

            for file_path in shard_dir.iterdir():
                if not file_path.is_file():
                    continue

                # Extract hash from filename (hash + extension)
                filename = file_path.name

                # Determine file type from extension
                if filename.endswith('.pdf'):
                    file_hash = filename[:-4]
                    file_type = 'pdf'
                elif filename.endswith('.tei.xml'):
                    file_hash = filename[:-8]
                    file_type = 'tei'
                elif filename.endswith('.rng'):
                    file_hash = filename[:-4]
                    file_type = 'rng'
                else:
                    continue  # Unknown file type

                # Check if tracked
                if file_hash not in tracked_hashes:
                    orphaned.append((file_hash, file_type))

        if self.logger and orphaned:
            self.logger.warning(f"Found {len(orphaned)} orphaned files in storage")

        return orphaned
