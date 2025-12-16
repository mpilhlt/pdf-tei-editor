"""
Unit tests for database components (Phase 2).

Tests:
- Database schema creation
- Database manager operations
- File repository CRUD with Pydantic models
- Document-centric queries
- Metadata inheritance
- Multi-collection support
- Soft delete
- File storage

@testCovers fastapi_app/lib/db_schema.py
@testCovers fastapi_app/lib/database.py
@testCovers fastapi_app/lib/file_repository.py
@testCovers fastapi_app/lib/file_storage.py
"""

import unittest
import tempfile
import shutil
import json
from pathlib import Path

# Import modules to test
from fastapi_app.lib.db_schema import initialize_database, get_schema_version
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.models import FileCreate, FileUpdate, SyncUpdate


class TestDatabaseSchema(unittest.TestCase):
    """Test database schema creation."""

    def setUp(self):
        """Create temporary directory for test database."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"

    def tearDown(self):
        """Clean up temporary directory."""
        import gc
        gc.collect()  # Force garbage collection to close lingering connections
        shutil.rmtree(self.test_dir)

    def test_schema_creation(self):
        """Test that database schema creates successfully."""
        db = DatabaseManager(self.db_path)

        # Check that database file was created
        self.assertTrue(self.db_path.exists())

        # Check that files table exists
        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='files'"
            )
            result = cursor.fetchone()
            self.assertIsNotNone(result)

    def test_sync_metadata_table(self):
        """Test that sync_metadata table is created."""
        db = DatabaseManager(self.db_path)

        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'"
            )
            result = cursor.fetchone()
            self.assertIsNotNone(result)

    def test_indexes_created(self):
        """Test that all indexes are created."""
        db = DatabaseManager(self.db_path)

        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
            )
            indexes = cursor.fetchall()

            # Should have at least 10 indexes
            self.assertGreaterEqual(len(indexes), 10)

    def test_initial_sync_metadata(self):
        """Test that initial sync metadata is inserted."""
        db = DatabaseManager(self.db_path)

        with db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT key, value FROM sync_metadata")
            rows = cursor.fetchall()

            # Convert to dict
            metadata = {row['key']: row['value'] for row in rows}

            # Check required keys exist
            self.assertIn('last_sync_time', metadata)
            self.assertIn('remote_version', metadata)
            self.assertIn('sync_in_progress', metadata)
            self.assertIn('last_sync_summary', metadata)

    def test_schema_version(self):
        """Test schema version function."""
        version = get_schema_version()
        self.assertIsInstance(version, str)
        self.assertRegex(version, r'^\d+\.\d+\.\d+$')


class TestDatabaseManager(unittest.TestCase):
    """Test DatabaseManager operations."""

    def setUp(self):
        """Create temporary directory for test database."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.db = DatabaseManager(self.db_path)

    def tearDown(self):
        """Clean up temporary directory."""
        import gc
        gc.collect()  # Force garbage collection to close lingering connections
        shutil.rmtree(self.test_dir)

    def test_connection_context_manager(self):
        """Test connection context manager."""
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            result = cursor.fetchone()
            self.assertEqual(result[0], 1)

    def test_transaction_commit(self):
        """Test transaction auto-commit."""
        with self.db.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO files (id, stable_id, filename, doc_id, file_type) VALUES (?, ?, ?, ?, ?)",
                ('test123', 'tst123', 'test123.pdf', '10.1234/test', 'pdf')
            )

        # Verify data was committed
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM files WHERE id = 'test123'")
            result = cursor.fetchone()
            self.assertIsNotNone(result)

    def test_transaction_rollback(self):
        """Test transaction auto-rollback on error."""
        try:
            with self.db.transaction() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO files (id, stable_id, filename, doc_id, file_type) VALUES (?, ?, ?, ?, ?)",
                    ('test456', 'tst456', 'test456.pdf', '10.1234/test', 'pdf')
                )
                # Force error
                raise ValueError("Test error")
        except ValueError:
            pass

        # Verify data was not committed
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM files WHERE id = 'test456'")
            result = cursor.fetchone()
            self.assertIsNone(result)


class TestFileRepository(unittest.TestCase):
    """Test FileRepository CRUD operations with Pydantic models."""

    def setUp(self):
        """Create temporary directory and repository."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.db = DatabaseManager(self.db_path)
        self.repo = FileRepository(self.db)

    def tearDown(self):
        """Clean up temporary directory."""
        import gc
        gc.collect()  # Force garbage collection to close lingering connections
        shutil.rmtree(self.test_dir)

    def test_insert_file(self):
        """Test file insertion with Pydantic model."""
        file_data = FileCreate(
            id='abc123',
            filename='abc123.pdf',
            doc_id='10.1234/test',
            file_type='pdf',
            file_size=1234567,
            doc_collections=['corpus1', 'corpus2'],
            doc_metadata={'author': 'Test Author', 'title': 'Test Paper'}
        )

        file = self.repo.insert_file(file_data)
        self.assertEqual(file.id, 'abc123')

        # Verify insertion
        file = self.repo.get_file_by_id('abc123')
        self.assertIsNotNone(file)
        self.assertEqual(file.doc_id, '10.1234/test')
        self.assertEqual(file.doc_collections, ['corpus1', 'corpus2'])
        self.assertEqual(file.doc_metadata['author'], 'Test Author')

    def test_update_file(self):
        """Test file update with Pydantic model."""
        # Insert file
        self.repo.insert_file(FileCreate(
            id='abc123',
            filename='abc123.pdf',
            doc_id='10.1234/test',
            file_type='pdf',
            file_size=1000
        ))

        # Update file
        file = self.repo.update_file('abc123', FileUpdate(
            file_size=9999,
            doc_metadata={'author': 'Updated Author'}
        ))

        # Verify update
        self.assertEqual(file.file_size, 9999)
        self.assertEqual(file.doc_metadata['author'], 'Updated Author')
        self.assertEqual(file.sync_status, 'modified')

    def test_soft_delete(self):
        """Test soft delete."""
        # Insert file
        self.repo.insert_file(FileCreate(
            id='abc123',
            filename='abc123.pdf',
            doc_id='10.1234/test',
            file_type='pdf',
            file_size=1000
        ))

        # Delete file
        self.repo.delete_file('abc123')

        # File should not be found by default
        file = self.repo.get_file_by_id('abc123')
        self.assertIsNone(file)

        # File should be found when including deleted
        file = self.repo.get_file_by_id('abc123', include_deleted=True)
        self.assertIsNotNone(file)
        self.assertTrue(file.deleted)
        self.assertEqual(file.sync_status, 'pending_delete')

    def test_list_files_with_filters(self):
        """Test listing files with filters."""
        # Insert multiple files
        self.repo.insert_file(FileCreate(
            id='pdf1',
            filename='pdf1.pdf',
            doc_id='10.1234/doc1',
            file_type='pdf',
            file_size=1000,
            doc_collections=['corpus1']
        ))
        self.repo.insert_file(FileCreate(
            id='tei1',
            filename='tei1.tei.xml',
            doc_id='10.1234/doc1',
            file_type='tei',
            file_size=500,
            variant='grobid'
        ))
        self.repo.insert_file(FileCreate(
            id='pdf2',
            filename='pdf2.pdf',
            doc_id='10.1234/doc2',
            file_type='pdf',
            file_size=2000,
            doc_collections=['corpus2']
        ))

        # Test file_type filter
        pdfs = self.repo.list_files(file_type='pdf')
        self.assertEqual(len(pdfs), 2)

        # Test variant filter
        grobid_files = self.repo.list_files(variant='grobid')
        self.assertEqual(len(grobid_files), 1)

        # Test collection filter
        corpus1_files = self.repo.list_files(collection='corpus1')
        self.assertEqual(len(corpus1_files), 1)

    def test_document_centric_queries(self):
        """Test document-centric queries."""
        doc_id = '10.1234/test'

        # Insert PDF
        self.repo.insert_file(FileCreate(
            id='pdf123',
            filename='pdf123.pdf',
            doc_id=doc_id,
            file_type='pdf',
            file_size=10000,
            doc_collections=['corpus1'],
            doc_metadata={'author': 'Test', 'title': 'Paper'}
        ))

        # Insert TEI versions
        self.repo.insert_file(FileCreate(
            id='tei1',
            filename='tei1.tei.xml',
            doc_id=doc_id,
            file_type='tei',
            file_size=5000,
            version=1
        ))
        self.repo.insert_file(FileCreate(
            id='tei2',
            filename='tei2.tei.xml',
            doc_id=doc_id,
            file_type='tei',
            file_size=5500,
            version=2
        ))

        # Insert gold standard
        self.repo.insert_file(FileCreate(
            id='gold1',
            filename='gold1.tei.xml',
            doc_id=doc_id,
            file_type='tei',
            file_size=6000,
            is_gold_standard=True
        ))

        # Test get_files_by_doc_id
        files = self.repo.get_files_by_doc_id(doc_id)
        self.assertEqual(len(files), 4)

        # Test get_pdf_for_document
        pdf = self.repo.get_pdf_for_document(doc_id)
        self.assertIsNotNone(pdf)
        self.assertEqual(pdf.id, 'pdf123')

        # Test get_latest_tei_version
        latest = self.repo.get_latest_tei_version(doc_id)
        self.assertIsNotNone(latest)
        self.assertEqual(latest.version, 2)

        # Test get_gold_standard
        gold = self.repo.get_gold_standard(doc_id)
        self.assertIsNotNone(gold)
        self.assertEqual(gold.id, 'gold1')

        # Test get_all_versions
        versions = self.repo.get_all_versions(doc_id)
        self.assertEqual(len(versions), 2)

    def test_get_doc_id_by_file_id(self):
        """Test get_doc_id_by_file_id method."""
        doc_id = '10.1234/test'
        full_hash = 'a' * 64  # 64-character SHA-256 hash

        # Insert a file with stable_id
        self.repo.insert_file(FileCreate(
            id=full_hash,
            filename='test.pdf',
            doc_id=doc_id,
            file_type='pdf',
            file_size=1000,
            stable_id='abc123'
        ))

        # Test with stable_id
        result_doc_id = self.repo.get_doc_id_by_file_id('abc123')
        self.assertEqual(result_doc_id, doc_id)

        # Test with full hash
        result_doc_id = self.repo.get_doc_id_by_file_id(full_hash)
        self.assertEqual(result_doc_id, doc_id)

        # Test with non-existent ID
        result_doc_id = self.repo.get_doc_id_by_file_id('nonexistent')
        self.assertIsNone(result_doc_id)

    def test_metadata_inheritance(self):
        """Test metadata inheritance via JOIN."""
        doc_id = '10.1234/test'

        # Insert PDF with metadata
        self.repo.insert_file(FileCreate(
            id='pdf123',
            filename='pdf123.pdf',
            doc_id=doc_id,
            file_type='pdf',
            file_size=10000,
            doc_collections=['corpus1', 'corpus2'],
            doc_metadata={'author': 'Test Author', 'title': 'Test Paper'}
        ))

        # Insert TEI without metadata
        self.repo.insert_file(FileCreate(
            id='tei123',
            filename='tei123.tei.xml',
            doc_id=doc_id,
            file_type='tei',
            file_size=5000,
            version=1,
            file_metadata={'extraction_method': 'grobid'}
        ))

        # Get TEI with inherited metadata
        tei = self.repo.get_file_with_doc_metadata('tei123')
        self.assertIsNotNone(tei)

        # Should have inherited doc_collections and doc_metadata
        self.assertEqual(tei.inherited_doc_collections, ['corpus1', 'corpus2'])
        self.assertEqual(tei.inherited_doc_metadata['author'], 'Test Author')

        # Should still have its own file_metadata
        self.assertEqual(tei.file_metadata['extraction_method'], 'grobid')

    def test_multi_collection_support(self):
        """Test multi-collection support."""
        # Insert PDF in multiple collections
        self.repo.insert_file(FileCreate(
            id='pdf123',
            filename='pdf123.pdf',
            doc_id='10.1234/test',
            file_type='pdf',
            file_size=10000,
            doc_collections=['main_corpus', 'gold_subset', '2024_batch']
        ))

        # Query by each collection
        for collection in ['main_corpus', 'gold_subset', '2024_batch']:
            files = self.repo.list_files(collection=collection)
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].id, 'pdf123')

    def test_sync_metadata(self):
        """Test sync metadata operations."""
        # Set sync metadata
        self.repo.set_sync_metadata('test_key', 'test_value')

        # Get sync metadata
        value = self.repo.get_sync_metadata('test_key')
        self.assertEqual(value, 'test_value')

        # Update sync metadata
        self.repo.set_sync_metadata('test_key', 'updated_value')
        value = self.repo.get_sync_metadata('test_key')
        self.assertEqual(value, 'updated_value')

    def test_get_deleted_files(self):
        """Test getting deleted files."""
        # Insert and delete files
        self.repo.insert_file(FileCreate(
            id='file1',
            filename='file1.pdf',
            doc_id='10.1234/doc1',
            file_type='pdf',
            file_size=1000
        ))
        self.repo.insert_file(FileCreate(
            id='file2',
            filename='file2.pdf',
            doc_id='10.1234/doc2',
            file_type='pdf',
            file_size=2000
        ))

        self.repo.delete_file('file1')

        # Get deleted files
        deleted = self.repo.get_deleted_files()
        self.assertEqual(len(deleted), 1)
        self.assertEqual(deleted[0].id, 'file1')

    def test_get_files_needing_sync(self):
        """Test getting files needing sync."""
        # All new files should have sync_status = 'modified'
        self.repo.insert_file(FileCreate(
            id='file1',
            filename='file1.pdf',
            doc_id='10.1234/doc1',
            file_type='pdf',
            file_size=1000
        ))

        files = self.repo.get_files_needing_sync()
        self.assertGreaterEqual(len(files), 1)

    def test_update_sync_status(self):
        """Test updating sync status."""
        # Insert file
        self.repo.insert_file(FileCreate(
            id='file1',
            filename='file1.pdf',
            doc_id='10.1234/doc1',
            file_type='pdf',
            file_size=1000
        ))

        # Update sync status
        file = self.repo.update_sync_status('file1', SyncUpdate(
            sync_status='synced',
            sync_hash='abc123hash'
        ))

        self.assertEqual(file.sync_status, 'synced')
        self.assertEqual(file.sync_hash, 'abc123hash')


class TestFileStorage(unittest.TestCase):
    """Test FileStorage operations."""

    def setUp(self):
        """Create temporary directory for file storage."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.storage = FileStorage(self.test_dir, self.db_path)

    def tearDown(self):
        """Clean up temporary directory."""
        import gc
        gc.collect()  # Force garbage collection to close lingering connections
        shutil.rmtree(self.test_dir)

    def test_save_and_read_file(self):
        """Test saving and reading files."""
        content = b"Test PDF content"
        file_hash, path = self.storage.save_file(content, 'pdf')

        # Verify file was saved
        self.assertTrue(path.exists())

        # Verify content
        read_content = self.storage.read_file(file_hash, 'pdf')
        self.assertEqual(read_content, content)

    def test_hash_sharding(self):
        """Test that files are stored in shard directories."""
        content = b"Test content"
        file_hash, path = self.storage.save_file(content, 'pdf')

        # Path should be: {data_root}/{hash[:2]}/{hash}.pdf
        self.assertEqual(path.parent.name, file_hash[:2])
        self.assertTrue(path.name.startswith(file_hash))
        self.assertTrue(path.name.endswith('.pdf'))

    def test_deduplication(self):
        """Test that duplicate content is deduplicated."""
        content = b"Test content"

        # Save same content twice
        hash1, path1 = self.storage.save_file(content, 'pdf')
        hash2, path2 = self.storage.save_file(content, 'pdf')

        # Should have same hash and path
        self.assertEqual(hash1, hash2)
        self.assertEqual(path1, path2)

    def test_different_file_types(self):
        """Test storing different file types."""
        pdf_content = b"PDF content"
        tei_content = b"<TEI>XML content</TEI>"

        pdf_hash, pdf_path = self.storage.save_file(pdf_content, 'pdf')
        tei_hash, tei_path = self.storage.save_file(tei_content, 'tei')

        # Verify extensions
        self.assertTrue(pdf_path.name.endswith('.pdf'))
        self.assertTrue(tei_path.name.endswith('.tei.xml'))

    def test_delete_file(self):
        """Test file deletion."""
        content = b"Test content"
        file_hash, path = self.storage.save_file(content, 'pdf')

        # Delete file
        result = self.storage.delete_file(file_hash, 'pdf')
        self.assertTrue(result)

        # File should not exist
        self.assertFalse(path.exists())

        # Shard directory should be cleaned up if it was empty
        shard_dir = path.parent
        # Directory might already be removed if it was empty
        if shard_dir.exists():
            # If it still exists, it should have other files
            self.assertTrue(any(shard_dir.iterdir()))

    def test_file_exists(self):
        """Test checking file existence."""
        content = b"Test content"
        file_hash, _ = self.storage.save_file(content, 'pdf')

        # File should exist
        self.assertTrue(self.storage.file_exists(file_hash, 'pdf'))

        # Non-existent file
        self.assertFalse(self.storage.file_exists('nonexistent', 'pdf'))

    def test_storage_stats(self):
        """Test storage statistics."""
        # Add some files
        self.storage.save_file(b"PDF 1", 'pdf')
        self.storage.save_file(b"PDF 2", 'pdf')
        self.storage.save_file(b"TEI 1", 'tei')

        stats = self.storage.get_storage_stats()

        self.assertGreater(stats['total_files'], 0)
        self.assertGreater(stats['total_size'], 0)
        self.assertEqual(stats['files_by_type']['pdf'], 2)
        self.assertEqual(stats['files_by_type']['tei'], 1)

    def test_verify_file(self):
        """Test file integrity verification."""
        content = b"Test content"
        file_hash, _ = self.storage.save_file(content, 'pdf')

        # Verify file
        self.assertTrue(self.storage.verify_file(file_hash, 'pdf'))

        # Non-existent file should fail verification
        self.assertFalse(self.storage.verify_file('nonexistent', 'pdf'))


if __name__ == '__main__':
    unittest.main()
