"""
File repository for document-centric file metadata management.

Provides CRUD operations and queries for the files table with:
- Document-centric organization (via doc_id)
- Metadata inheritance (PDF stores, TEI inherits)
- Soft delete support (deleted = 1)
- Sync tracking (for Phase 6)
- Pydantic model integration for type safety
- Storage reference counting for safe file cleanup

All queries filter deleted = 0 by default unless explicitly requesting deleted files.
"""

import json
import sqlite3
from typing import Optional, List
from datetime import datetime
from .database import DatabaseManager
from .storage_references import StorageReferenceManager
from .models import (
    FileMetadata,
    FileCreate,
    FileUpdate,
    FileWithDocMetadata,
    SyncUpdate
)


class FileRepository:
    """
    Repository for file metadata operations using Pydantic models.

    Handles all database operations for files including:
    - Basic CRUD with soft delete
    - Document-centric queries
    - Metadata inheritance via JOINs
    - Sync tracking

    All methods use Pydantic models for type safety and validation.
    """

    def __init__(self, db_manager: DatabaseManager, logger=None):
        """
        Initialize file repository with storage reference counting.

        Args:
            db_manager: DatabaseManager instance
            logger: Optional logger instance
        """
        self.db = db_manager
        self.logger = logger
        # Initialize reference manager for storage cleanup
        self.ref_manager = StorageReferenceManager(db_manager.db_path, logger)

    def resolve_file_id(self, file_id: str) -> str:
        """
        Resolve stable_id or full hash to full content hash.

        Accepts:
        - Full SHA-256 hash (64 chars) - returned as-is
        - Stable ID (6-12 chars) - looked up in database

        Args:
            file_id: Stable ID or full SHA-256 hash

        Returns:
            Full SHA-256 hash (64 chars)

        Raises:
            ValueError: If ID cannot be resolved
        """
        # If already 64 chars, assume it's a full hash
        if len(file_id) == 64:
            return file_id

        # Try as stable_id
        file = self.get_file_by_stable_id(file_id)
        if file:
            return file.id

        raise ValueError(f"Cannot resolve file ID: {file_id}")

    def get_file_by_id_or_stable_id(
        self,
        file_id: str
    ) -> Optional[FileMetadata]:
        """
        Get file by stable_id or full content hash.

        Args:
            file_id: Stable ID (6-12 chars) or full SHA-256 hash (64 chars)

        Returns:
            FileMetadata if found, None otherwise
        """
        try:
            full_hash = self.resolve_file_id(file_id)
            return self.get_file_by_id(full_hash)
        except ValueError:
            return None

    def _row_to_model(self, row: sqlite3.Row) -> FileMetadata:
        """
        Convert database row to FileMetadata model.

        Args:
            row: Database row from files table

        Returns:
            FileMetadata model instance
        """
        data = dict(row)

        # Parse JSON fields
        data['doc_collections'] = json.loads(data['doc_collections']) if data['doc_collections'] else []
        data['doc_metadata'] = json.loads(data['doc_metadata']) if data['doc_metadata'] else {}
        data['file_metadata'] = json.loads(data['file_metadata']) if data['file_metadata'] else {}

        # Convert boolean fields
        data['deleted'] = bool(data['deleted'])
        data['is_gold_standard'] = bool(data['is_gold_standard'])

        # Parse datetime fields
        for field in ['local_modified_at', 'created_at', 'updated_at']:
            if data[field]:
                data[field] = datetime.fromisoformat(data[field])

        return FileMetadata.model_validate(data)

    def _row_to_doc_model(self, row: sqlite3.Row) -> FileWithDocMetadata:
        """
        Convert joined database row to FileWithDocMetadata model.

        Args:
            row: Database row with inherited metadata fields

        Returns:
            FileWithDocMetadata model instance
        """
        data = dict(row)

        # Parse JSON fields
        data['doc_collections'] = json.loads(data['doc_collections']) if data['doc_collections'] else []
        data['doc_metadata'] = json.loads(data['doc_metadata']) if data['doc_metadata'] else {}
        data['file_metadata'] = json.loads(data['file_metadata']) if data['file_metadata'] else {}
        data['inherited_doc_collections'] = json.loads(data.get('inherited_doc_collections')) if data.get('inherited_doc_collections') else []
        data['inherited_doc_metadata'] = json.loads(data.get('inherited_doc_metadata')) if data.get('inherited_doc_metadata') else {}

        # Convert boolean fields
        data['deleted'] = bool(data['deleted'])
        data['is_gold_standard'] = bool(data['is_gold_standard'])

        # Parse datetime fields
        for field in ['local_modified_at', 'created_at', 'updated_at']:
            if data[field]:
                data[field] = datetime.fromisoformat(data[field])

        return FileWithDocMetadata.model_validate(data)

    # Basic CRUD Operations

    def insert_file(self, file_data: FileCreate) -> FileMetadata:
        """
        Insert a new file record.

        Automatically sets:
        - stable_id (if not provided) - generated using collision-resistant nanoid
        - local_modified_at = CURRENT_TIMESTAMP
        - sync_status = 'modified'
        - created_at, updated_at = CURRENT_TIMESTAMP

        Args:
            file_data: FileCreate model with required fields

        Returns:
            FileMetadata model of the inserted file

        Raises:
            sqlite3.Error: If database operation fails
        """
        # Convert Pydantic model to dict and serialize JSON fields
        data = file_data.model_dump()

        # Generate stable_id if not provided
        if not data.get('stable_id'):
            from .stable_id import generate_stable_id
            # Get all existing stable IDs to avoid collisions
            existing_ids = self._get_all_stable_ids()
            data['stable_id'] = generate_stable_id(existing_ids)

        data['doc_collections'] = json.dumps(data['doc_collections'])
        data['doc_metadata'] = json.dumps(data['doc_metadata'])
        data['file_metadata'] = json.dumps(data['file_metadata'])

        # Build column names and placeholders
        columns = list(data.keys())
        placeholders = ', '.join('?' * len(columns))
        column_names = ', '.join(columns)

        query = f"""
            INSERT INTO files ({column_names}, local_modified_at, sync_status)
            VALUES ({placeholders}, CURRENT_TIMESTAMP, 'modified')
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, tuple(data.values()))

            if self.logger:
                self.logger.debug(f"Inserted file: {file_data.id}")

        # Increment storage reference count (database entry now references this file)
        self.ref_manager.increment_reference(file_data.id, file_data.file_type)

        # Return the inserted file
        return self.get_file_by_id(file_data.id)

    def update_file(self, file_id: str, updates: FileUpdate) -> FileMetadata:
        """
        Update an existing file record.

        Automatically sets:
        - local_modified_at = CURRENT_TIMESTAMP
        - sync_status = 'modified' (if content changed)
        - updated_at = CURRENT_TIMESTAMP

        Handles reference counting when file hash changes (content update).

        Args:
            file_id: File ID (hash)
            updates: FileUpdate model with fields to update

        Returns:
            Updated FileMetadata model

        Raises:
            ValueError: If file_id not found
            sqlite3.Error: If database operation fails
        """
        # Get only provided fields
        update_data = updates.model_dump(exclude_unset=True)

        if not update_data:
            return self.get_file_by_id(file_id)

        # Check if hash is changing (content update)
        hash_changed = 'id' in update_data and update_data['id'] != file_id
        new_hash = update_data['id'] if hash_changed else None

        # Get file_type before update (needed for ref counting)
        if hash_changed:
            old_file = self.get_file_by_id(file_id)
            if not old_file:
                raise ValueError(f"File not found: {file_id}")
            file_type = old_file.file_type

        # Serialize JSON fields
        if 'doc_collections' in update_data:
            update_data['doc_collections'] = json.dumps(update_data['doc_collections'])
        if 'doc_metadata' in update_data:
            update_data['doc_metadata'] = json.dumps(update_data['doc_metadata'])
        if 'file_metadata' in update_data:
            update_data['file_metadata'] = json.dumps(update_data['file_metadata'])

        # Build SET clause
        set_clauses = [f"{col} = ?" for col in update_data.keys()]
        set_clause = ', '.join(set_clauses)

        query = f"""
            UPDATE files
            SET {set_clause},
                local_modified_at = CURRENT_TIMESTAMP,
                sync_status = 'modified',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted = 0
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            params = tuple(update_data.values()) + (file_id,)
            cursor.execute(query, params)

            if cursor.rowcount == 0:
                raise ValueError(f"File not found or already deleted: {file_id}")

            if self.logger:
                self.logger.debug(f"Updated file: {file_id}")

        # Handle reference counting for hash change
        if hash_changed:
            # Increment ref for new hash
            self.ref_manager.increment_reference(new_hash, file_type)
            # Decrement ref for old hash and delete physical file if needed
            old_count, should_delete = self.ref_manager.decrement_reference(file_id)

            if should_delete:
                # Physical file should be deleted - need FileStorage for this
                # Import here to avoid circular dependency
                from .file_storage import FileStorage
                from ..config import get_settings
                settings = get_settings()
                storage = FileStorage(settings.data_root / "files", self.db.db_path, self.logger)
                storage.delete_file(file_id, file_type, decrement_ref=False)

                if self.logger:
                    self.logger.info(f"Deleted orphaned file {file_id[:8]}... after hash change")

            if self.logger:
                self.logger.info(f"Hash changed: {file_id[:8]}... -> {new_hash[:8]}... (refs updated)")

        return self.get_file_by_id(new_hash if hash_changed else file_id)

    def get_file_by_id(self, file_id: str, include_deleted: bool = False) -> Optional[FileMetadata]:
        """
        Get file by ID (content hash).

        Args:
            file_id: File ID (SHA-256 content hash)
            include_deleted: If True, include soft-deleted files

        Returns:
            FileMetadata model or None if not found
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        query = f"SELECT * FROM files WHERE id = ? {deleted_filter}"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (file_id,))
            row = cursor.fetchone()

            if row:
                return self._row_to_model(row)
            return None

    def get_file_by_stable_id(self, stable_id: str, include_deleted: bool = False) -> Optional[FileMetadata]:
        """
        Get file by stable_id (short permanent ID).

        Args:
            stable_id: Stable ID (6+ character nanoid)
            include_deleted: If True, include soft-deleted files

        Returns:
            FileMetadata model or None if not found
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        query = f"SELECT * FROM files WHERE stable_id = ? {deleted_filter}"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (stable_id,))
            row = cursor.fetchone()

            if row:
                return self._row_to_model(row)
            return None

    def _get_all_stable_ids(self) -> set[str]:
        """
        Get all stable IDs currently in use (for collision detection).

        Returns:
            Set of all stable_id values in the database
        """
        query = "SELECT stable_id FROM files"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            rows = cursor.fetchall()
            return {row['stable_id'] for row in rows}

    def delete_file(self, file_id: str) -> None:
        """
        Soft delete a file (sets deleted = 1).

        Also updates:
        - local_modified_at = CURRENT_TIMESTAMP
        - sync_status = 'pending_delete'
        - Decrements storage reference count

        Args:
            file_id: File ID (hash)

        Raises:
            ValueError: If file_id not found
        """
        query = """
            UPDATE files
            SET deleted = 1,
                local_modified_at = CURRENT_TIMESTAMP,
                sync_status = 'pending_delete',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted = 0
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (file_id,))

            if cursor.rowcount == 0:
                raise ValueError(f"File not found or already deleted: {file_id}")

            if self.logger:
                self.logger.debug(f"Soft deleted file: {file_id}")

        # Get file metadata before decrementing (need file_type for physical deletion)
        file_metadata = self.get_file_by_id(file_id, include_deleted=True)
        if not file_metadata:
            return  # Already handled above, but safety check

        # Decrement storage reference count and delete physical file if needed
        ref_count, should_delete = self.ref_manager.decrement_reference(file_id)

        if should_delete:
            # Physical file should be deleted
            from .file_storage import FileStorage
            from ..config import get_settings
            settings = get_settings()
            storage = FileStorage(settings.data_root / "files", self.db.db_path, self.logger)
            storage.delete_file(file_id, file_metadata.file_type, decrement_ref=False)

            if self.logger:
                self.logger.info(f"Deleted physical file {file_id[:8]}... (ref_count reached 0)")

    # List and Filter Operations

    def list_files(
        self,
        collection: Optional[str] = None,
        variant: Optional[str] = None,
        file_type: Optional[str] = None,
        include_deleted: bool = False
    ) -> List[FileMetadata]:
        """
        List files with optional filters.

        Args:
            collection: Filter by collection name
            variant: Filter by variant
            file_type: Filter by file type
            include_deleted: If True, include soft-deleted files

        Returns:
            List of FileMetadata models
        """
        conditions = []
        params = []

        if not include_deleted:
            conditions.append("deleted = 0")

        if file_type:
            conditions.append("file_type = ?")
            params.append(file_type)

        if variant:
            conditions.append("variant = ?")
            params.append(variant)

        if collection:
            conditions.append("json_extract(doc_collections, '$') LIKE ?")
            params.append(f"%{collection}%")

        where_clause = " AND ".join(conditions) if conditions else "1=1"
        query = f"SELECT * FROM files WHERE {where_clause} ORDER BY created_at DESC"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, tuple(params))
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    # Document-Centric Queries

    def get_files_by_doc_id(self, doc_id: str, include_deleted: bool = False) -> List[FileMetadata]:
        """
        Get all files for a document.

        Args:
            doc_id: Document identifier
            include_deleted: If True, include soft-deleted files

        Returns:
            List of FileMetadata models
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        query = f"SELECT * FROM files WHERE doc_id = ? {deleted_filter} ORDER BY created_at"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (doc_id,))
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def get_pdf_for_document(self, doc_id: str) -> Optional[FileMetadata]:
        """
        Get PDF file for a document.

        Args:
            doc_id: Document identifier

        Returns:
            FileMetadata model or None if not found
        """
        query = """
            SELECT * FROM files
            WHERE doc_id = ?
              AND file_type = 'pdf'
              AND deleted = 0
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (doc_id,))
            row = cursor.fetchone()

            if row:
                return self._row_to_model(row)
            return None

    def get_latest_tei_version(
        self,
        doc_id: str,
        variant: Optional[str] = None
    ) -> Optional[FileMetadata]:
        """
        Get latest TEI version for a document.

        Excludes gold standards and only considers versioned files.

        Args:
            doc_id: Document identifier
            variant: Optional variant filter

        Returns:
            FileMetadata model or None if not found
        """
        variant_filter = "AND variant = ?" if variant else "AND variant IS NULL"
        params = (doc_id, variant) if variant else (doc_id,)

        query = f"""
            SELECT * FROM files
            WHERE doc_id = ?
              AND file_type = 'tei'
              {variant_filter}
              AND is_gold_standard = 0
              AND deleted = 0
            ORDER BY version DESC
            LIMIT 1
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)
            row = cursor.fetchone()

            if row:
                return self._row_to_model(row)
            return None

    def get_gold_standard(self, doc_id: str) -> Optional[FileMetadata]:
        """
        Get gold standard file for a document.

        Args:
            doc_id: Document identifier

        Returns:
            FileMetadata model or None if not found
        """
        query = """
            SELECT * FROM files
            WHERE doc_id = ?
              AND is_gold_standard = 1
              AND deleted = 0
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (doc_id,))
            row = cursor.fetchone()

            if row:
                return self._row_to_model(row)
            return None

    def get_all_versions(self, doc_id: str, variant: Optional[str] = None) -> List[FileMetadata]:
        """
        Get all TEI versions for a document.

        Args:
            doc_id: Document identifier
            variant: Optional variant filter

        Returns:
            List of FileMetadata models ordered by version
        """
        variant_filter = "AND variant = ?" if variant else "AND variant IS NULL"
        params = (doc_id, variant) if variant else (doc_id,)

        query = f"""
            SELECT * FROM files
            WHERE doc_id = ?
              AND file_type = 'tei'
              {variant_filter}
              AND is_gold_standard = 0
              AND deleted = 0
            ORDER BY version ASC
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    # Metadata Inheritance

    def get_file_with_doc_metadata(self, file_id: str) -> Optional[FileWithDocMetadata]:
        """
        Get file with inherited document metadata from PDF.

        For TEI files, JOINs with PDF to get doc_collections and doc_metadata.
        For PDF files, returns as-is.

        Args:
            file_id: File ID (hash)

        Returns:
            FileWithDocMetadata model with inherited document metadata or None if not found
        """
        query = """
            SELECT
                tei.*,
                pdf.doc_collections as inherited_doc_collections,
                pdf.doc_metadata as inherited_doc_metadata
            FROM files tei
            LEFT JOIN files pdf ON tei.doc_id = pdf.doc_id AND pdf.file_type = 'pdf' AND pdf.deleted = 0
            WHERE tei.id = ? AND tei.deleted = 0
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (file_id,))
            row = cursor.fetchone()

            if row:
                return self._row_to_doc_model(row)
            return None

    # Sync Support (Phase 6)

    def get_sync_metadata(self, key: str) -> Optional[str]:
        """
        Get sync metadata value.

        Args:
            key: Metadata key

        Returns:
            Metadata value or None if not found
        """
        query = "SELECT value FROM sync_metadata WHERE key = ?"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (key,))
            row = cursor.fetchone()

            if row:
                return row['value']
            return None

    def set_sync_metadata(self, key: str, value: str) -> None:
        """
        Set sync metadata value.

        Args:
            key: Metadata key
            value: Metadata value
        """
        query = """
            INSERT OR REPLACE INTO sync_metadata (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (key, value))

    def get_deleted_files(self) -> List[FileMetadata]:
        """
        Get all soft-deleted files (for sync).

        Returns:
            List of FileMetadata models for deleted files
        """
        query = "SELECT * FROM files WHERE deleted = 1"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def mark_deleted(self, file_id: str) -> None:
        """
        Mark file as deleted (alias for delete_file).

        Args:
            file_id: File ID (hash)
        """
        self.delete_file(file_id)

    def get_files_needing_sync(self) -> List[FileMetadata]:
        """
        Get all files that need to be synced.

        Returns:
            List of FileMetadata models with sync_status != 'synced'
        """
        query = "SELECT * FROM files WHERE sync_status != 'synced'"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def update_sync_status(self, file_id: str, sync_update: SyncUpdate) -> FileMetadata:
        """
        Update sync-related fields for a file.

        Args:
            file_id: File ID (hash)
            sync_update: SyncUpdate model with sync status and hash

        Returns:
            Updated FileMetadata model

        Raises:
            ValueError: If file_id not found
        """
        query = """
            UPDATE files
            SET sync_status = ?,
                sync_hash = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted = 0
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (sync_update.sync_status, sync_update.sync_hash, file_id))

            if cursor.rowcount == 0:
                raise ValueError(f"File not found or already deleted: {file_id}")

            if self.logger:
                self.logger.debug(f"Updated sync status for file: {file_id}")

        return self.get_file_by_id(file_id)
