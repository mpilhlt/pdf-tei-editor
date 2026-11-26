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
import re
import sqlite3
from typing import Optional, List
from datetime import datetime
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.storage.storage_references import StorageReferenceManager
from fastapi_app.lib.models.models import (
    FileMetadata,
    FileCreate,
    FileUpdate,
    FileWithDocMetadata,
    SyncUpdate
)


# PDFs of a document (#944): each TEI file is attached to the PDF it was made from
# (`pdf_stable_id`); a PDF never changes, a new text layer is a new PDF row. The canonical PDF of
# a document stands for the document where no version is involved (file list, document fields).

def canonical_pdf_sql(doc_id_sql: str) -> str:
    """
    SQL expression for the stable_id of the canonical PDF of a document: the PDF of its most
    recently changed gold version, else its most recently created PDF (non-deleted ones first).

    Args:
        doc_id_sql: SQL expression for the doc_id, e.g. a column of the outer query
    """
    return f"""COALESCE(
        (SELECT g.pdf_stable_id FROM files g
         WHERE g.doc_id = {doc_id_sql} AND g.file_type = 'tei' AND g.is_gold_standard = 1
           AND g.deleted = 0 AND g.pdf_stable_id IS NOT NULL
         ORDER BY g.updated_at DESC, g.rowid DESC LIMIT 1),
        (SELECT p.stable_id FROM files p
         WHERE p.doc_id = {doc_id_sql} AND p.file_type = 'pdf'
         ORDER BY p.deleted ASC, p.created_at DESC, p.rowid DESC LIMIT 1))"""


def listed_file_sql(alias: str = "files") -> str:
    """
    SQL condition that is false only for the PDFs of a document that are not its canonical PDF,
    so that lists of files contain one PDF per document.

    Args:
        alias: Name or alias of the files table in the outer query
    """
    return f"({alias}.file_type != 'pdf' OR {alias}.stable_id = {canonical_pdf_sql(f'{alias}.doc_id')})"


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
        self.ref_manager = StorageReferenceManager(db_manager, logger)

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

    def get_doc_id_by_file_id(self, file_id: str) -> Optional[str]:
        """
        Get doc_id from a file's stable_id or full content hash.

        Args:
            file_id: Stable ID (6-12 chars) or full SHA-256 hash (64 chars)

        Returns:
            Document ID if file found, None otherwise
        """
        file = self.get_file_by_id_or_stable_id(file_id)
        return file.doc_id if file else None

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
        - pdf_stable_id of a TEI file without one: the canonical PDF of its document (#944)
        - pdf_stable_id of the TEI files of the document that have none, when a PDF is inserted

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
            from fastapi_app.lib.utils.stable_id import generate_stable_id
            # Get all existing stable IDs to avoid collisions
            existing_ids = self._get_all_stable_ids()
            data['stable_id'] = generate_stable_id(existing_ids)

        if data['file_type'] == 'tei' and not data.get('pdf_stable_id'):
            pdf = self.get_pdf_for_document(data['doc_id'])
            data['pdf_stable_id'] = pdf.stable_id if pdf else None

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
            if data['file_type'] == 'pdf':
                # TEI files imported before their PDF
                cursor.execute(
                    "UPDATE files SET pdf_stable_id = ? WHERE doc_id = ? AND file_type = 'tei' AND pdf_stable_id IS NULL",
                    (data['stable_id'], data['doc_id']),
                )

            if self.logger:
                self.logger.debug(f"Inserted file: {file_data.id}")

        # Increment storage reference count (database entry now references this file)
        self.ref_manager.increment_reference(file_data.id, file_data.file_type)

        # Return the inserted file
        return self.get_file_by_id(file_data.id)

    def update_file(self, file_id: str, updates: FileUpdate, stable_id: Optional[str] = None) -> FileMetadata:
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
            stable_id: Only update the row with this stable_id. Without it, every non-deleted row
                with the content hash is updated (rows of different documents can share content)

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
            WHERE id = ? AND deleted = 0 {"AND stable_id = ?" if stable_id else ""}
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            params = tuple(update_data.values()) + (file_id,) + ((stable_id,) if stable_id else ())
            cursor.execute(query, params)
            doc_fields = {k: v for k, v in update_data.items() if k in ('doc_collections', 'doc_metadata')}
            if doc_fields and cursor.rowcount:
                self._share_document_fields(conn, file_id, stable_id, doc_fields)

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
                from fastapi_app.lib.storage.file_storage import FileStorage
                from fastapi_app.config import get_settings
                settings = get_settings()
                storage = FileStorage(settings.data_root / "files", self.db, self.logger)
                deleted = storage.delete_file(file_id, file_type, decrement_ref=False)

                # Clean up reference entry after successful deletion
                if deleted:
                    self.ref_manager.remove_reference_entry(file_id)

                if self.logger:
                    self.logger.info(f"Deleted orphaned file {file_id[:8]}... after hash change")

            if self.logger:
                self.logger.info(f"Hash changed: {file_id[:8]}... -> {new_hash[:8]}... (refs updated)")

        if stable_id:
            return self.get_file_by_stable_id(stable_id)
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

    def get_file_by_content_and_doc(
        self,
        content_hash: str,
        doc_id: str,
        variant: Optional[str] = None,
        include_deleted: bool = False
    ) -> Optional[FileMetadata]:
        """
        Get file by content hash for a specific document and variant.

        This is used to check if a version with identical content already exists
        for the same document, without matching files from different documents.

        Args:
            content_hash: SHA-256 content hash
            doc_id: Document identifier
            variant: Optional variant (None matches files without variant)
            include_deleted: If True, include soft-deleted files

        Returns:
            FileMetadata model or None if not found
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"

        if variant is None:
            variant_filter = "AND (variant IS NULL OR variant = '')"
            params = (content_hash, doc_id)
        else:
            variant_filter = "AND variant = ?"
            params = (content_hash, doc_id, variant)

        query = f"""
            SELECT * FROM files
            WHERE id = ?
              AND doc_id = ?
              AND {listed_file_sql()}
              {variant_filter}
              {deleted_filter}
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)
            row = cursor.fetchone()

            if row:
                return self._row_to_model(row)
            return None

    def get_files_by_content_hash(
        self,
        content_hash: str,
        include_deleted: bool = False
    ) -> List[FileMetadata]:
        """
        Get all files with a given content hash.

        After migration 008, multiple files can share the same content hash.
        Use this method when you need to find all files referencing the same content.

        Args:
            content_hash: SHA-256 content hash
            include_deleted: If True, include soft-deleted files

        Returns:
            List of FileMetadata models (empty list if none found)
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        query = f"SELECT * FROM files WHERE id = ? {deleted_filter}"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (content_hash,))
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def delete_file(self, file_id: str, stable_id: Optional[str] = None) -> None:
        """
        Soft delete a file (sets deleted = 1).

        Also updates:
        - local_modified_at = CURRENT_TIMESTAMP
        - sync_status = 'pending_delete'
        - Decrements storage reference count

        Args:
            file_id: File ID (hash)
            stable_id: Only delete the row with this stable_id (rows can share content)

        Raises:
            ValueError: If file_id not found
        """
        query = f"""
            UPDATE files
            SET deleted = 1,
                local_modified_at = CURRENT_TIMESTAMP,
                sync_status = 'pending_delete',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted = 0 {"AND stable_id = ?" if stable_id else ""}
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (file_id, stable_id) if stable_id else (file_id,))

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
            from fastapi_app.lib.storage.file_storage import FileStorage
            from fastapi_app.config import get_settings
            settings = get_settings()
            storage = FileStorage(settings.data_root / "files", self.db, self.logger)
            deleted = storage.delete_file(file_id, file_metadata.file_type, decrement_ref=False)

            # Clean up reference entry after successful deletion
            if deleted:
                self.ref_manager.remove_reference_entry(file_id)

            if self.logger:
                self.logger.info(f"Deleted physical file {file_id[:8]}... (ref_count reached 0)")

    def undelete_file(self, file_id: str, label: Optional[str] = None, stable_id: Optional[str] = None) -> FileMetadata:
        """
        Restore a soft-deleted file (sets deleted = 0).

        Also updates:
        - local_modified_at = CURRENT_TIMESTAMP
        - sync_status = 'modified'
        - Increments storage reference count
        - Optionally updates label

        Args:
            file_id: File ID (hash)
            label: Optional new label to set
            stable_id: Only restore the row with this stable_id (rows can share content)

        Returns:
            Updated FileMetadata

        Raises:
            ValueError: If file_id not found or not deleted
        """
        # Get file metadata first (need file_type for reference counting)
        if stable_id:
            file_metadata = self.get_file_by_stable_id(stable_id, include_deleted=True)
            if file_metadata and file_metadata.id != file_id:
                file_metadata = None
        else:
            file_metadata = self.get_file_by_id(file_id, include_deleted=True)
        if not file_metadata:
            raise ValueError(f"File not found: {file_id}")
        if not file_metadata.deleted:
            raise ValueError(f"File is not deleted: {file_id}")

        # Build SET clause with optional label
        set_parts = [
            "deleted = 0",
            "local_modified_at = CURRENT_TIMESTAMP",
            "sync_status = 'modified'",
            "updated_at = CURRENT_TIMESTAMP"
        ]
        params = []

        if label is not None:
            set_parts.append("label = ?")
            params.append(label)

        params.append(file_id)
        if stable_id:
            params.append(stable_id)

        query = f"""
            UPDATE files
            SET {', '.join(set_parts)}
            WHERE id = ? AND deleted = 1 {"AND stable_id = ?" if stable_id else ""}
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)

            if cursor.rowcount == 0:
                raise ValueError(f"File not found or not deleted: {file_id}")

            if self.logger:
                self.logger.debug(f"Undeleted file: {file_id}")

        # Increment storage reference count (undoes the decrement from delete)
        self.ref_manager.increment_reference(file_id, file_metadata.file_type)

        # Return updated file metadata
        if stable_id:
            return self.get_file_by_stable_id(stable_id)
        return self.get_file_by_id(file_id)

    # List and Filter Operations

    def list_files(
        self,
        collection: Optional[str] = None,
        variant: Optional[str] = None,
        file_type: Optional[str] = None,
        include_deleted: bool = False,
        include_all_pdfs: bool = False
    ) -> List[FileMetadata]:
        """
        List files with optional filters.

        Args:
            collection: Filter by collection name
            variant: Filter by variant
            file_type: Filter by file type
            include_deleted: If True, include soft-deleted files
            include_all_pdfs: If True, include the PDFs of a document that are not its canonical PDF

        Returns:
            List of FileMetadata models
        """
        conditions = []
        params = []

        if not include_deleted:
            conditions.append("deleted = 0")

        if not include_all_pdfs:
            conditions.append(listed_file_sql())

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

    def get_tei_files_by_status(self, statuses: List[str]) -> List[FileMetadata]:
        """
        Get all non-deleted TEI files whose lifecycle status is one of `statuses`.

        Args:
            statuses: Lifecycle statuses to match

        Returns:
            List of FileMetadata models, most recently updated first
        """
        if not statuses:
            return []
        placeholders = ", ".join("?" for _ in statuses)
        query = f"""
            SELECT * FROM files
            WHERE file_type = 'tei' AND deleted = 0 AND status IN ({placeholders})
            ORDER BY updated_at DESC
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, tuple(statuses))
            return [self._row_to_model(row) for row in cursor.fetchall()]

    # Document-Centric Queries

    def get_files_by_doc_id(
        self, doc_id: str, include_deleted: bool = False, include_all_pdfs: bool = False
    ) -> List[FileMetadata]:
        """
        Get all files for a document.

        Args:
            doc_id: Document identifier
            include_deleted: If True, include soft-deleted files
            include_all_pdfs: If True, include the PDFs of a document that are not its canonical PDF

        Returns:
            List of FileMetadata models
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        pdf_filter = "" if include_all_pdfs else f"AND {listed_file_sql()}"
        query = f"SELECT * FROM files WHERE doc_id = ? {deleted_filter} {pdf_filter} ORDER BY created_at"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (doc_id,))
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def get_max_collection_counter(self, prefix: str) -> int:
        """Return the max numeric suffix N in non-deleted doc_ids '{prefix}-NNNN', or 0."""
        suffix_re = re.compile(rf"^{re.escape(prefix)}-(\d+)$")
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT doc_id FROM files WHERE doc_id LIKE ? AND deleted = 0",
                (f"{prefix}-%",)
            )
            rows = cursor.fetchall()
        max_n = 0
        for row in rows:
            m = suffix_re.match(row['doc_id'])
            if m:
                n = int(m.group(1))
                if n > max_n:
                    max_n = n
        return max_n

    def get_pdf_for_document(self, doc_id: str) -> Optional[FileMetadata]:
        """
        Get the canonical PDF of a document (#944): the PDF of its most recently changed gold
        version, else its most recently created PDF. For the PDF of a version, use
        `get_pdf_for_file`.

        Args:
            doc_id: Document identifier

        Returns:
            FileMetadata model or None if the document has no (non-deleted) PDF
        """
        query = f"SELECT * FROM files WHERE stable_id = {canonical_pdf_sql('?')} AND deleted = 0"

        with self.db.get_connection() as conn:
            row = conn.execute(query, (doc_id, doc_id)).fetchone()
        return self._row_to_model(row) if row else None

    def get_pdf_for_file(self, file: FileMetadata) -> Optional[FileMetadata]:
        """
        Get the PDF a TEI file is attached to (`pdf_stable_id`), or the canonical PDF of the
        document if it has none.

        Args:
            file: The (TEI) file

        Returns:
            FileMetadata of the PDF, or None if there is none
        """
        if file.pdf_stable_id:
            pdf = self.get_file_by_stable_id(file.pdf_stable_id)
            if pdf is not None:
                return pdf
        return self.get_pdf_for_document(file.doc_id)

    def get_document_pdfs(self, doc_id: str, include_deleted: bool = False) -> List[FileMetadata]:
        """
        Get all PDFs of a document, oldest first.

        Args:
            doc_id: Document identifier
            include_deleted: If True, include soft-deleted PDFs

        Returns:
            List of FileMetadata models
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        with self.db.get_connection() as conn:
            rows = conn.execute(
                f"SELECT * FROM files WHERE doc_id = ? AND file_type = 'pdf' {deleted_filter} ORDER BY created_at, rowid",
                (doc_id,),
            ).fetchall()
        return [self._row_to_model(row) for row in rows]

    def create_pdf_version(
        self,
        stable_id: str,
        new_file_id: str,
        file_size: int,
        file_metadata: dict,
        created_by: Optional[str] = None,
    ) -> FileMetadata:
        """
        Create a new PDF of a document from an existing one with new content, e.g. after text
        recognition changed its text layer (#944). PDFs are never changed: the new PDF gets a new
        stable_id and the document fields of the source. The TEI files attached to the source stay
        attached to it.

        Args:
            stable_id: Stable ID of the source PDF
            new_file_id: Content hash of the new content (already in storage)
            file_size: Size of the new content
            file_metadata: File metadata of the new PDF
            created_by: Username of the user who created it (default: the creator of the source)

        Returns:
            The new PDF

        Raises:
            ValueError: If the source PDF is not found or the content is unchanged
        """
        source = self.get_file_by_stable_id(stable_id)
        if source is None or source.file_type != 'pdf':
            raise ValueError(f"PDF not found: {stable_id}")
        if new_file_id == source.id:
            raise ValueError(f"The content of PDF {stable_id} is unchanged")
        from fastapi_app.lib.utils.stable_id import generate_stable_id
        new_stable_id = generate_stable_id(self._get_all_stable_ids())
        self.insert_file(FileCreate(
            id=new_file_id,
            stable_id=new_stable_id,
            filename=source.filename,
            doc_id=source.doc_id,
            file_type='pdf',
            file_size=file_size,
            label=source.label,
            doc_collections=source.doc_collections,
            doc_metadata=source.doc_metadata,
            file_metadata=file_metadata,
            created_by=created_by or source.created_by,
        ))
        created = self.get_file_by_stable_id(new_stable_id)
        assert created is not None
        if self.logger:
            self.logger.info(f"Created PDF {new_stable_id} ({new_file_id[:8]}) of document {source.doc_id} from {stable_id} ({source.id[:8]})")
        return created

    def get_unreferenced_pdfs(self) -> List[FileMetadata]:
        """
        Get the non-deleted PDFs that no file record references through `pdf_stable_id` and that
        are neither the canonical nor the most recent PDF of their document (garbage-collection
        candidates). The most recent PDF is kept so that the result of a text recognition run that
        no version was made from yet is not lost. Soft-deleted versions still count: they can be
        restored, so their PDF goes only once they are purged.

        Returns:
            List of FileMetadata models
        """
        query = f"""
            SELECT pdf.* FROM files pdf
            WHERE pdf.file_type = 'pdf'
              AND pdf.deleted = 0
              AND pdf.stable_id != {canonical_pdf_sql('pdf.doc_id')}
              AND pdf.stable_id != (SELECT latest.stable_id FROM files latest
                                    WHERE latest.doc_id = pdf.doc_id AND latest.file_type = 'pdf' AND latest.deleted = 0
                                    ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM files ref WHERE ref.pdf_stable_id = pdf.stable_id)
        """
        with self.db.get_connection() as conn:
            return [self._row_to_model(row) for row in conn.execute(query).fetchall()]

    def _share_document_fields(self, conn: sqlite3.Connection, file_id: str, stable_id: Optional[str], fields: dict) -> None:
        """
        Copy changed document fields (already JSON-serialized) of a PDF to the other PDFs of its
        document, so that they do not depend on which PDF is canonical.
        """
        where = "id = ? AND stable_id = ?" if stable_id else "id = ?"
        params = (file_id, stable_id) if stable_id else (file_id,)
        rows = conn.execute(f"SELECT DISTINCT doc_id FROM files WHERE {where} AND file_type = 'pdf'", params).fetchall()
        set_clause = ', '.join(f"{col} = ?" for col in fields)
        for row in rows:
            conn.execute(
                f"UPDATE files SET {set_clause} WHERE doc_id = ? AND file_type = 'pdf' AND id != ?",
                tuple(fields.values()) + (row['doc_id'], file_id),
            )

    def get_files_by_collection(
        self, collection_id: str, include_deleted: bool = False, include_all_pdfs: bool = False
    ) -> List[FileMetadata]:
        """
        Get all files that belong to a specific collection.

        Args:
            collection_id: Collection identifier
            include_deleted: If True, include soft-deleted files
            include_all_pdfs: If True, include the PDFs of a document that are not its canonical PDF

        Returns:
            List of FileMetadata models
        """
        deleted_filter = "" if include_deleted else "AND deleted = 0"
        pdf_filter = "" if include_all_pdfs else f"AND {listed_file_sql()}"
        query = f"""
            SELECT * FROM files
            WHERE json_extract(doc_collections, '$') LIKE ?
            {deleted_filter}
            {pdf_filter}
            ORDER BY created_at
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (f'%"{collection_id}"%',))
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

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

    def get_child_stable_ids(self, stable_id: str) -> list[str]:
        """
        Get the stable_ids of the non-deleted files copied from a file (see `parent_stable_id`).

        Args:
            stable_id: Stable ID of the parent file

        Returns:
            List of stable IDs, empty if the file has no descendants
        """
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT stable_id FROM files WHERE parent_stable_id = ? AND deleted = 0 ORDER BY created_at",
                (stable_id,)
            )
            return [row['stable_id'] for row in cursor.fetchall()]

    def is_frozen(self, stable_id: str) -> bool:
        """
        Check whether a file is frozen: another version was copied from it, so it is part of the
        history and must not change (see docs/history/2026-10-24-version-freeze.md).

        Args:
            stable_id: Stable ID of the file

        Returns:
            True if a non-deleted file has this file as its parent
        """
        return bool(self.get_child_stable_ids(stable_id))

    def get_exclusive_history(self, stable_id: str) -> list[FileMetadata]:
        """
        Get a version together with the ancestors that exist only for it: walks up the
        `parent_stable_id` chain and stops before the first ancestor that has another non-deleted
        descendant, is a gold standard, or is missing or deleted. That ancestor and everything
        above it belong to other versions as well.

        Args:
            stable_id: Stable ID of the version (must not have descendants itself)

        Returns:
            The version first, then its exclusive ancestors, nearest first
        """
        start = self.get_file_by_stable_id(stable_id)
        if start is None:
            return []
        history = [start]
        seen = {start.stable_id}
        current = start
        while current.parent_stable_id and current.parent_stable_id not in seen:
            parent = self.get_file_by_stable_id(current.parent_stable_id)
            if parent is None or parent.is_gold_standard:
                break
            if [c for c in self.get_child_stable_ids(parent.stable_id) if c != current.stable_id]:
                break
            history.append(parent)
            seen.add(parent.stable_id)
            current = parent
        return history

    def get_frozen_stable_ids(self) -> set[str]:
        """
        Get the stable_ids of all frozen files (files that a non-deleted file was copied from).

        Returns:
            Set of stable IDs
        """
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT DISTINCT parent_stable_id FROM files WHERE parent_stable_id IS NOT NULL AND deleted = 0"
            )
            return {row['parent_stable_id'] for row in cursor.fetchall()}

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
        query = f"""
            SELECT
                tei.*,
                pdf.doc_collections as inherited_doc_collections,
                pdf.doc_metadata as inherited_doc_metadata
            FROM files tei
            LEFT JOIN files pdf ON pdf.stable_id = {canonical_pdf_sql('tei.doc_id')} AND pdf.deleted = 0
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

    def get_remote_locks(self) -> dict:
        """Return the cached remote lock state (from last sync).

        Returns:
            Dict mapping stable_id → {client_id, acquired_at, updated_at}.
            Empty dict if not yet populated.
        """
        import json
        raw = self.get_sync_metadata("remote_locks")
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}

    def set_remote_locks(self, locks: dict) -> None:
        """Persist the merged remote lock state from the last sync.

        Args:
            locks: Dict mapping stable_id → {client_id, acquired_at, updated_at}.
        """
        import json
        self.set_sync_metadata("remote_locks", json.dumps(locks))

    def get_files_to_upload(self) -> List[FileMetadata]:
        """
        Return non-deleted files whose content has not yet been pushed to remote.

        Returns:
            Files with deleted=0 and sync_status not in ('synced', 'deletion_synced')
        """
        query = """
            SELECT * FROM files
            WHERE deleted = 0
            AND sync_status NOT IN ('synced', 'deletion_synced')
        """
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            return [self._row_to_model(r) for r in cursor.fetchall()]

    def get_deleted_files(self) -> List[FileMetadata]:
        """
        Get all soft-deleted files that need to be synced to remote.
        Excludes files whose deletion has already been synced.

        Returns:
            List of FileMetadata models for deleted files pending sync
        """
        query = """
            SELECT * FROM files
            WHERE deleted = 1
            AND sync_status != 'deletion_synced'
        """

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
            List of FileMetadata models with sync_status not in ('synced', 'deletion_synced')
        """
        query = """
            SELECT * FROM files
            WHERE sync_status NOT IN ('synced', 'deletion_synced')
        """

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

    def count_unsynced_files(self) -> int:
        """
        Count files that need to be synced (O(1) operation).

        Returns:
            Number of files with sync_status not in ('synced', 'deletion_synced')
        """
        query = """
            SELECT COUNT(*) as count FROM files
            WHERE sync_status NOT IN ('synced', 'deletion_synced')
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            row = cursor.fetchone()

            return row['count'] if row else 0

    def get_all_files(self, include_deleted: bool = False, include_all_pdfs: bool = False) -> List[FileMetadata]:
        """
        Get all files (for metadata comparison during sync).

        Args:
            include_deleted: If True, include soft-deleted files
            include_all_pdfs: If True, include the PDFs of a document that are not its canonical PDF

        Returns:
            List of all FileMetadata models
        """
        conditions = []
        if not include_deleted:
            conditions.append("deleted = 0")
        if not include_all_pdfs:
            conditions.append(listed_file_sql())
        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"SELECT * FROM files {where_clause}"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def mark_file_synced(self, file_id: str, remote_version: int) -> None:
        """
        Mark file as synced with remote.

        Args:
            file_id: File ID (hash)
            remote_version: Remote version number at sync time
        """
        query = """
            UPDATE files
            SET sync_status = 'synced',
                remote_version = ?,
                sync_hash = id,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (remote_version, file_id))

            if self.logger:
                self.logger.debug(f"Marked file as synced: {file_id}")

    def mark_deletion_synced(self, file_id: str, remote_version: int) -> None:
        """
        Mark a deleted file's deletion as synced to remote.
        This prevents the deletion from being synced again on subsequent syncs.

        Args:
            file_id: File ID (hash)
            remote_version: Remote version number at sync time
        """
        query = """
            UPDATE files
            SET sync_status = 'deletion_synced',
                remote_version = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted = 1
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (remote_version, file_id))

            if self.logger:
                self.logger.debug(f"Marked deletion as synced: {file_id}")

    def requeue_synced_files_for_bootstrap(self) -> int:
        """
        Mark all non-deleted synced files as 'modified' so they are uploaded
        as upsert ops on the next sync cycle.

        Called once per instance when migrating to the operation-log sync
        approach.  Without this, files synced under the old metadata.db
        approach would never appear in the shared queue.

        Returns:
            Number of files re-queued
        """
        query = """
            UPDATE files
            SET sync_status = 'modified',
                updated_at  = CURRENT_TIMESTAMP
            WHERE deleted = 0
            AND sync_status = 'synced'
        """
        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            return cursor.rowcount

    def requeue_deletion_synced_files(self) -> int:
        """
        Reset deletion_synced files to pending_delete so they are re-pushed.

        Called when a remote metadata.db version regression is detected (another
        instance overwrote the shared DB with a lower version), which means
        deletions previously marked as synced may no longer be reflected remotely.

        Returns:
            Number of files re-queued
        """
        query = """
            UPDATE files
            SET sync_status = 'pending_delete',
                updated_at = CURRENT_TIMESTAMP
            WHERE deleted = 1
            AND sync_status = 'deletion_synced'
        """
        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            return cursor.rowcount

    def update_file_content(
        self,
        stable_id: str,
        new_file_id: str,
        new_file_size: int,
        remote_version: int,
    ) -> None:
        """
        Replace the content hash (id) of a file record in-place.

        Used when a remote sync op delivers a new version of a logical file
        (same stable_id, different content hash).  Updating the id column in
        place avoids the stable_id UNIQUE constraint issue that would arise
        from a delete + insert.

        Args:
            stable_id: Stable file identifier (identifies which record to update)
            new_file_id: New content hash to store as the primary key
            new_file_size: Size of the new content
            remote_version: Remote seq/version at sync time
        """
        query = """
            UPDATE files
            SET id             = ?,
                file_size      = ?,
                sync_status    = 'synced',
                sync_hash      = ?,
                remote_version = ?,
                updated_at     = CURRENT_TIMESTAMP
            WHERE stable_id = ? AND deleted = 0
        """
        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (new_file_id, new_file_size, new_file_id, remote_version, stable_id))

    def restore_file(
        self,
        stable_id: str,
        file_id: str,
        file_size: int,
        remote_version: int,
    ) -> None:
        """
        Un-delete a file and set its content hash, restoring it as synced.

        Works on both deleted and non-deleted records.  Used when a remote
        upsert op arrives for a file that was previously deleted locally —
        the remote is asserting the file should exist.

        Args:
            stable_id: Stable file identifier (locates the record)
            file_id: New (or same) content hash
            file_size: File size in bytes
            remote_version: Remote seq at sync time
        """
        query = """
            UPDATE files
            SET id             = ?,
                file_size      = ?,
                deleted        = 0,
                sync_status    = 'synced',
                sync_hash      = ?,
                remote_version = ?,
                updated_at     = CURRENT_TIMESTAMP
            WHERE stable_id = ?
        """
        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (file_id, file_size, file_id, remote_version, stable_id))

    def apply_remote_metadata(self, file_id: str, remote_metadata: dict) -> None:
        """
        Apply metadata changes from remote without triggering sync.

        This is used when remote metadata changes (collections, labels, etc.)
        need to be applied locally without marking the file as modified.

        Args:
            file_id: File ID (hash)
            remote_metadata: Dict with metadata fields to update
        """
        # Fields that must not be overwritten — they are either identity keys or
        # local-only state managed outside this method.
        _SKIP = frozenset({
            'id', 'stable_id',               # identity
            'sync_status', 'sync_hash',      # local state machine
            'local_modified_at',             # local timestamp
            'created_at', 'updated_at',      # timestamps managed by DB
            'deleted',                       # managed by delete_file / restore_file
        })
        _JSON_FIELDS = frozenset({'doc_collections', 'doc_metadata', 'file_metadata'})

        update_data = {}
        for field, value in remote_metadata.items():
            if field in _SKIP or value is None:
                continue
            if field in _JSON_FIELDS:
                update_data[field] = json.dumps(value) if not isinstance(value, str) else value
            else:
                update_data[field] = value

        if not update_data:
            return

        # Build SET clause
        set_clauses = [f"{col} = ?" for col in update_data.keys()]
        set_clause = ', '.join(set_clauses)

        query = f"""
            UPDATE files
            SET {set_clause},
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            params = tuple(update_data.values()) + (file_id,)
            cursor.execute(query, params)

            if self.logger:
                self.logger.debug(f"Applied remote metadata to file: {file_id}")

    def get_deleted_files_for_gc(
        self,
        deleted_before: datetime,
        sync_status: Optional[str] = None
    ) -> List[FileMetadata]:
        """
        Get deleted files eligible for garbage collection.

        Filters are additive - all conditions must match if they have a value.

        Args:
            deleted_before: Purge files with updated_at before this timestamp
            sync_status: Optional filter by sync_status

        Returns:
            List of FileMetadata models for deleted files eligible for garbage collection
        """
        conditions = ["deleted = 1", "updated_at < ?"]
        params = [deleted_before.isoformat()]

        if sync_status is not None:
            conditions.append("sync_status = ?")
            params.append(sync_status)

        where_clause = " AND ".join(conditions)
        query = f"SELECT * FROM files WHERE {where_clause}"

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, tuple(params))
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def get_orphaned_xml_files(self) -> List[FileMetadata]:
        """
        Find XML files that have no corresponding PDF for the same doc_id.

        An orphaned XML file is one where:
        - file_type = 'tei' (XML file)
        - deleted = 0 (not soft-deleted)
        - No non-deleted PDF exists with the same doc_id

        Returns:
            List of FileMetadata models for orphaned XML files
        """
        query = """
            SELECT xml.*
            FROM files xml
            LEFT JOIN files pdf ON xml.doc_id = pdf.doc_id
                AND pdf.file_type = 'pdf'
                AND pdf.deleted = 0
            WHERE xml.file_type = 'tei'
                AND xml.deleted = 0
                AND pdf.id IS NULL
        """

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            rows = cursor.fetchall()

            return [self._row_to_model(row) for row in rows]

    def sync_tei_collections_with_pdf(self) -> int:
        """
        Sync doc_collections on TEI files to match their parent PDF.

        TEI files should inherit doc_collections from their PDF. This method
        finds TEI files where doc_collections differs from the parent PDF and
        updates them. Does not modify sync_status or timestamps since this is
        a metadata correction, not a content change.

        Returns:
            Number of TEI files updated
        """
        query = f"""
            UPDATE files
            SET doc_collections = (
                SELECT pdf.doc_collections
                FROM files pdf
                WHERE pdf.stable_id = {canonical_pdf_sql('files.doc_id')}
                    AND pdf.deleted = 0
            )
            WHERE file_type = 'tei'
                AND deleted = 0
                AND doc_collections IS NOT NULL
                AND doc_collections != '[]'
                AND EXISTS (
                    SELECT 1 FROM files pdf
                    WHERE pdf.stable_id = {canonical_pdf_sql('files.doc_id')}
                        AND pdf.deleted = 0
                        AND pdf.doc_collections != files.doc_collections
                )
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            count = cursor.rowcount

            if self.logger and count > 0:
                self.logger.info(
                    f"Synced doc_collections for {count} TEI file(s) "
                    f"to match their parent PDF"
                )

            return count

    def assign_inbox_to_collectionless_files(self) -> int:
        """
        Assign '_inbox' collection to files that have no collection.

        Finds non-deleted files with NULL, empty string, or empty JSON array
        doc_collections and sets them to '["_inbox"]'.

        Returns:
            Number of files updated
        """
        query = """
            UPDATE files
            SET doc_collections = '["_inbox"]'
            WHERE deleted = 0
                AND (
                    doc_collections IS NULL
                    OR doc_collections = ''
                    OR doc_collections = '[]'
                )
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            count = cursor.rowcount

            if self.logger and count > 0:
                self.logger.info(
                    f"Assigned '_inbox' collection to {count} file(s) "
                    f"with empty doc_collections"
                )

            return count

    def remove_duplicate_entries(self) -> int:
        """
        Remove duplicate database entries for the same file content.

        A duplicate is defined as multiple rows sharing the same (id, doc_id,
        file_type) combination. For each group of duplicates, the oldest entry
        (earliest created_at) is kept and the rest are deleted.

        Returns:
            Number of duplicate entries removed
        """
        query = """
            DELETE FROM files
            WHERE rowid NOT IN (
                SELECT MIN(rowid)
                FROM files
                GROUP BY id, doc_id, file_type
            )
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query)
            count = cursor.rowcount

            if self.logger and count > 0:
                self.logger.info(
                    f"Removed {count} duplicate database entries"
                )

            return count

    def permanently_delete_file(self, file_id: str, stable_id: Optional[str] = None) -> None:
        """
        Permanently delete a file record from the database.

        This is for garbage collection only - removes the database record entirely.
        Does NOT handle physical file deletion or reference counting
        (caller must handle that separately).

        Args:
            file_id: File ID (hash)
            stable_id: Only delete the row with this stable_id. Without it, all rows with the
                content hash are deleted (rows of different documents can share content)

        Raises:
            ValueError: If file_id not found
        """
        query = f"DELETE FROM files WHERE id = ? {'AND stable_id = ?' if stable_id else ''}"

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (file_id, stable_id) if stable_id else (file_id,))

            if cursor.rowcount == 0:
                raise ValueError(f"File not found: {file_id}")

            if self.logger:
                self.logger.debug(f"Permanently deleted file record: {file_id}")

    def rename_created_by(self, old_username: str, new_username: str) -> int:
        """
        Replace a username in the `created_by` column of all files, including deleted ones.

        Args:
            old_username: The current username
            new_username: The username that replaces it

        Returns:
            Number of updated file records
        """
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE files
                SET created_by = ?,
                    sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END,
                    local_modified_at = CURRENT_TIMESTAMP
                WHERE created_by = ?
                """,
                (new_username, old_username),
            )
            return cursor.rowcount

    def rename_collection(self, old_collection_id: str, new_collection_id: str) -> int:
        """
        Replace a collection id in the `doc_collections` of all files, including deleted ones.

        Files that are already in the new collection keep a single entry. Synced files are marked as
        modified so that the change reaches the sync target.

        Args:
            old_collection_id: The current collection id
            new_collection_id: The collection id that replaces it

        Returns:
            Number of updated file records
        """
        files = self.get_files_by_collection(old_collection_id, include_deleted=True)
        updated = 0
        with self.db.transaction() as conn:
            for file in files:
                if old_collection_id not in file.doc_collections:
                    continue
                collections: list[str] = []
                for collection_id in file.doc_collections:
                    renamed = new_collection_id if collection_id == old_collection_id else collection_id
                    if renamed not in collections:
                        collections.append(renamed)
                conn.execute(
                    """
                    UPDATE files
                    SET doc_collections = ?,
                        sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END,
                        local_modified_at = CURRENT_TIMESTAMP
                    WHERE stable_id = ?
                    """,
                    (json.dumps(collections), file.stable_id),
                )
                updated += 1
        return updated

    def update_file_metadata(
        self,
        stable_id: str,
        fileref: str | None = None,
        title: str | None = None,
        doi: str | None = None,
        variant: str | None = None,
        label: str | None = None
    ) -> None:
        """
        Update file metadata fields (fileref, title, DOI, variant, label).

        Args:
            stable_id: The stable_id of the file to update
            fileref: Optional new fileref value
            title: Optional new title value
            doi: Optional new DOI value
            variant: Optional new variant value
            label: Optional new label value

        Raises:
            ValueError: If file not found
            sqlite3.Error: If database operation fails
        """
        # Build update clauses for provided fields
        updates = {}
        if fileref is not None:
            updates['fileref'] = fileref
        if title is not None:
            updates['title'] = title
        if doi is not None:
            updates['doi'] = doi
        if variant is not None:
            updates['variant'] = variant
        if label is not None:
            updates['label'] = label

        if not updates:
            return

        set_clause = ', '.join([f"{col} = ?" for col in updates.keys()])
        values = list(updates.values())
        values.append(stable_id)

        query = f"""
            UPDATE files
            SET {set_clause},
                local_modified_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE stable_id = ? AND deleted = 0
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, values)

            if cursor.rowcount == 0:
                raise ValueError(f"File not found: {stable_id}")

            if self.logger:
                self.logger.debug(f"Updated metadata for file {stable_id}: {updates}")

    def update_doc_id(
        self,
        stable_id: str,
        new_doc_id: str,
        file_storage=None
    ) -> None:
        """
        Update doc_id for all files belonging to the same document.

        This updates the doc_id for:
        - The source PDF file
        - All artifact files (TEI, variants, etc.) associated with the document
        - The fileref in all TEI XML files

        Args:
            stable_id: The stable_id of any file belonging to the document
            new_doc_id: New document ID value
            file_storage: Optional FileStorage instance for updating XML content

        Raises:
            ValueError: If file not found or new_doc_id is empty
            sqlite3.Error: If database operation fails
        """
        if not new_doc_id:
            raise ValueError("new_doc_id cannot be empty")

        file = self.get_file_by_stable_id(stable_id)
        if not file:
            raise ValueError(f"File not found: {stable_id}")

        old_doc_id = file.doc_id
        if not old_doc_id:
            raise ValueError(f"File {stable_id} has no doc_id to update")

        # Get all TEI files that need fileref updates
        tei_files = []
        if file_storage:
            from fastapi_app.lib.utils.tei_utils import update_fileref_in_xml

            # Query all TEI files with this doc_id
            query_tei = """
                SELECT id, stable_id, file_type
                FROM files
                WHERE doc_id = ? AND file_type = 'tei' AND deleted = 0
            """
            with self.db.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(query_tei, (old_doc_id,))
                tei_files = cursor.fetchall()

            # Update fileref in each TEI file
            for tei_file in tei_files:
                file_id, file_stable_id, file_type = tei_file
                try:
                    # Read XML content
                    xml_content = file_storage.read_file(file_id, file_type)
                    if xml_content:
                        # Update fileref
                        updated_xml = update_fileref_in_xml(xml_content, new_doc_id)

                        # Save updated XML if it changed
                        xml_to_compare = xml_content.decode('utf-8') if isinstance(xml_content, bytes) else xml_content
                        if updated_xml != xml_to_compare:
                            new_hash, _ = file_storage.save_file(
                                updated_xml.encode('utf-8') if isinstance(updated_xml, str) else updated_xml,
                                file_type,
                                increment_ref=False
                            )

                            # Update file record if hash changed
                            if new_hash != file_id:
                                update_query = """
                                    UPDATE files
                                    SET id = ?,
                                        local_modified_at = CURRENT_TIMESTAMP,
                                        updated_at = CURRENT_TIMESTAMP
                                    WHERE id = ? AND deleted = 0
                                """
                                with self.db.transaction() as update_conn:
                                    update_cursor = update_conn.cursor()
                                    update_cursor.execute(update_query, (new_hash, file_id))

                            if self.logger:
                                self.logger.debug(f"Updated fileref in {file_stable_id}")
                except Exception as e:
                    if self.logger:
                        self.logger.warning(f"Failed to update fileref in {file_stable_id}: {e}")

        # Update all files with the same doc_id
        query = """
            UPDATE files
            SET doc_id = ?,
                local_modified_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE doc_id = ? AND deleted = 0
        """

        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (new_doc_id, old_doc_id))

            if self.logger:
                self.logger.info(
                    f"Updated doc_id from '{old_doc_id}' to '{new_doc_id}' "
                    f"for {cursor.rowcount} files"
                )

    def set_gold_standard(
        self,
        stable_id: str,
        variant: str | None = None
    ) -> None:
        """
        Set a file as the gold standard for its document and variant.

        Unsets is_gold_standard for all other files with the same doc_id and variant,
        then sets is_gold_standard = 1 for the specified file.

        Args:
            stable_id: The stable_id of the file to make gold standard
            variant: Optional variant to match (None matches files without variant)

        Raises:
            ValueError: If file not found
            sqlite3.Error: If database operation fails
        """
        # Get the file to find its doc_id
        file = self.get_file_by_stable_id(stable_id)
        if not file:
            raise ValueError(f"File not found: {stable_id}")

        doc_id = file.doc_id
        if not doc_id:
            raise ValueError(f"File has no doc_id: {stable_id}")

        with self.db.transaction() as conn:
            cursor = conn.cursor()

            # Unset gold standard for all files with same doc_id and variant
            if variant is None:
                cursor.execute("""
                    UPDATE files
                    SET is_gold_standard = 0,
                        local_modified_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE doc_id = ?
                      AND (variant IS NULL OR variant = '')
                      AND is_gold_standard = 1
                      AND deleted = 0
                """, (doc_id,))
            else:
                cursor.execute("""
                    UPDATE files
                    SET is_gold_standard = 0,
                        local_modified_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE doc_id = ?
                      AND variant = ?
                      AND is_gold_standard = 1
                      AND deleted = 0
                """, (doc_id, variant))

            # Set the specified file as gold standard
            cursor.execute("""
                UPDATE files
                SET is_gold_standard = 1,
                    local_modified_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE stable_id = ?
                  AND deleted = 0
            """, (stable_id,))

            if cursor.rowcount == 0:
                raise ValueError(f"File not found or deleted: {stable_id}")

            if self.logger:
                self.logger.info(f"Set gold standard: {stable_id} (doc_id={doc_id}, variant={variant})")
