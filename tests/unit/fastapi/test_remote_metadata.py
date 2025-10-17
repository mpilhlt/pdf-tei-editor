"""
Unit tests for RemoteMetadataManager (Phase 6).

Tests:
- Database download/upload to WebDAV
- Schema initialization
- File metadata queries (get_all_files, get_deleted_files)
- File metadata CRUD (upsert_file, mark_deleted)
- Sync metadata management
- Version tracking
- Transaction handling
"""

import unittest
import tempfile
import shutil
import sqlite3
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch, mock_open
from datetime import datetime

from fastapi_app.lib.remote_metadata import RemoteMetadataManager, REMOTE_SCHEMA


class MockWebdavFS:
    """Mock WebDAV filesystem for testing."""

    def __init__(self):
        self.files = {}
        self.dirs = set()

    def exists(self, path):
        return path in self.files or path in self.dirs

    def open(self, path, mode='r'):
        """Return a mock file object."""
        if 'r' in mode:
            content = self.files.get(path, b'')
            mock_file = MagicMock()
            mock_file.__enter__ = lambda self: self
            mock_file.__exit__ = lambda *args: None
            mock_file.read = lambda: content
            return mock_file
        else:  # write mode
            mock_file = MagicMock()
            mock_file.__enter__ = lambda self: self
            mock_file.__exit__ = lambda *args: None

            def write_fn(data):
                self.files[path] = data

            mock_file.write = write_fn
            return mock_file

    def makedirs(self, path):
        self.dirs.add(path)

    def info(self, path):
        return {'modified': datetime.now()}


class TestRemoteMetadataManager(unittest.TestCase):
    """Test RemoteMetadataManager operations."""

    def setUp(self):
        """Set up test environment."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.mock_fs = MockWebdavFS()

        # WebDAV config
        self.webdav_config = {
            'base_url': 'http://localhost:8080/webdav',
            'username': 'test_user',
            'password': 'test_pass',
            'remote_root': '/test_root'
        }

        # Mock logger
        self.logger = Mock()

    def tearDown(self):
        """Clean up test environment."""
        import gc
        gc.collect()  # Force garbage collection to close lingering connections
        shutil.rmtree(self.test_dir)

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_initialization(self, mock_webdav_class):
        """Test manager initialization."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)

        # Check initialization
        self.assertEqual(mgr.remote_root, '/test_root')
        self.assertEqual(mgr.remote_db_path, '/test_root/metadata.db')
        self.assertIsNone(mgr.local_db_conn)
        self.assertIsNone(mgr.temp_db_path)

        # Verify WebDAV FS was initialized with correct credentials
        mock_webdav_class.assert_called_once_with(
            'http://localhost:8080/webdav',
            auth=('test_user', 'test_pass')
        )

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_download_existing_database(self, mock_webdav_class):
        """Test downloading existing metadata.db from WebDAV."""
        # Create a real test database to use as remote
        test_db_path = self.test_dir / 'remote.db'
        with sqlite3.connect(test_db_path) as conn:
            conn.executescript(REMOTE_SCHEMA)
            conn.execute(
                "INSERT INTO sync_metadata (key, value) VALUES (?, ?)",
                ('version', '5')
            )
            conn.commit()

        # Read the database content
        with open(test_db_path, 'rb') as f:
            db_content = f.read()

        # Mock filesystem with existing database
        self.mock_fs.files['/test_root/metadata.db'] = db_content
        mock_webdav_class.return_value = self.mock_fs

        # Mock copyfileobj to actually copy
        with patch('shutil.copyfileobj') as mock_copy:
            def copy_effect(src, dst):
                dst.write(db_content)
            mock_copy.side_effect = copy_effect

            mgr = RemoteMetadataManager(self.webdav_config, self.logger)
            temp_path = mgr.download()

        # Verify temp file was created
        self.assertTrue(temp_path.exists())
        self.assertEqual(mgr.temp_db_path, temp_path)

        # Verify logger was called
        self.logger.info.assert_called()

        # Verify database content
        with sqlite3.connect(temp_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM sync_metadata WHERE key = 'version'")
            version = cursor.fetchone()[0]
        self.assertEqual(version, '5')

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_download_creates_new_database(self, mock_webdav_class):
        """Test that download creates new database if remote doesn't exist."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()

        # Verify temp file was created
        self.assertTrue(temp_path.exists())

        # Verify schema was created
        with sqlite3.connect(temp_path) as conn:
            cursor = conn.cursor()

            # Check tables exist
            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='file_metadata'"
            )
            self.assertIsNotNone(cursor.fetchone())

            cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'"
            )
            self.assertIsNotNone(cursor.fetchone())

            # Check initial version
            cursor.execute("SELECT value FROM sync_metadata WHERE key = 'version'")
            version = cursor.fetchone()[0]
            self.assertEqual(version, '1')

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_upload_database(self, mock_webdav_class):
        """Test uploading metadata.db to WebDAV."""
        mock_webdav_class.return_value = self.mock_fs

        # Create a test database to upload
        test_db_path = self.test_dir / 'upload.db'
        with sqlite3.connect(test_db_path) as conn:
            conn.executescript(REMOTE_SCHEMA)
            conn.execute(
                "INSERT INTO sync_metadata (key, value) VALUES (?, ?)",
                ('version', '10')
            )
            conn.commit()

        # Upload
        with patch('shutil.copyfileobj') as mock_copy:
            mgr = RemoteMetadataManager(self.webdav_config, self.logger)
            mgr.upload(test_db_path)

        # Verify upload was called
        mock_copy.assert_called_once()
        self.logger.info.assert_called()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_connect_and_disconnect(self, mock_webdav_class):
        """Test database connection and disconnection."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)

        # Download and connect
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Verify connection
        self.assertIsNotNone(mgr.local_db_conn)

        # Disconnect
        mgr.disconnect()

        # Verify cleanup
        self.assertIsNone(mgr.local_db_conn)
        self.assertFalse(temp_path.exists())

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_transaction_context_manager(self, mock_webdav_class):
        """Test transaction context manager."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Test successful transaction
        with mgr.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type) "
                "VALUES (?, ?, ?, ?, ?)",
                ('test123', 'tst123', 'test.pdf', '10.1234/test', 'pdf')
            )

        # Verify commit
        cursor = mgr.local_db_conn.cursor()
        cursor.execute("SELECT id FROM file_metadata WHERE id = 'test123'")
        self.assertIsNotNone(cursor.fetchone())

        # Test rollback on error
        try:
            with mgr.transaction() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type) "
                    "VALUES (?, ?, ?, ?, ?)",
                    ('test456', 'tst456', 'test456.pdf', '10.1234/test', 'pdf')
                )
                raise ValueError("Test error")
        except ValueError:
            pass

        # Verify rollback
        cursor = mgr.local_db_conn.cursor()
        cursor.execute("SELECT id FROM file_metadata WHERE id = 'test456'")
        self.assertIsNone(cursor.fetchone())

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_get_all_files(self, mock_webdav_class):
        """Test retrieving all file metadata."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Insert test files
        with mgr.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('file1', 'f1', 'file1.pdf', '10.1234/test1', 'pdf', 0)
            )
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('file2', 'f2', 'file2.pdf', '10.1234/test2', 'pdf', 1)
            )
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('file3', 'f3', 'file3.tei.xml', '10.1234/test1', 'tei', 0)
            )

        # Get all files (excluding deleted)
        files = mgr.get_all_files(include_deleted=False)
        self.assertEqual(len(files), 2)
        file_ids = [f['id'] for f in files]
        self.assertIn('file1', file_ids)
        self.assertIn('file3', file_ids)
        self.assertNotIn('file2', file_ids)

        # Get all files (including deleted)
        files = mgr.get_all_files(include_deleted=True)
        self.assertEqual(len(files), 3)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_get_deleted_files(self, mock_webdav_class):
        """Test retrieving deleted files."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Insert test files
        with mgr.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('file1', 'f1', 'file1.pdf', '10.1234/test1', 'pdf', 0)
            )
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('file2', 'f2', 'file2.pdf', '10.1234/test2', 'pdf', 1)
            )
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('file3', 'f3', 'file3.tei.xml', '10.1234/test3', 'tei', 1)
            )

        # Get deleted files
        deleted = mgr.get_deleted_files()
        self.assertEqual(len(deleted), 2)
        deleted_ids = [f['id'] for f in deleted]
        self.assertIn('file2', deleted_ids)
        self.assertIn('file3', deleted_ids)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_get_file_by_id(self, mock_webdav_class):
        """Test retrieving file by ID."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Insert test file
        with mgr.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, file_size) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('test123', 'tst123', 'test.pdf', '10.1234/test', 'pdf', 12345)
            )

        # Get file
        file = mgr.get_file_by_id('test123')
        self.assertIsNotNone(file)
        self.assertEqual(file['filename'], 'test.pdf')
        self.assertEqual(file['file_size'], 12345)

        # Get non-existent file
        file = mgr.get_file_by_id('nonexistent')
        self.assertIsNone(file)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_upsert_file(self, mock_webdav_class):
        """Test upserting file metadata."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Insert new file
        file_data = {
            'id': 'test123',
            'stable_id': 'tst123',
            'filename': 'test.pdf',
            'doc_id': '10.1234/test',
            'file_type': 'pdf',
            'file_size': 12345
        }
        mgr.upsert_file(file_data)

        # Verify insert
        file = mgr.get_file_by_id('test123')
        self.assertIsNotNone(file)
        self.assertEqual(file['file_size'], 12345)

        # Update existing file
        file_data['file_size'] = 99999
        mgr.upsert_file(file_data)

        # Verify update
        file = mgr.get_file_by_id('test123')
        self.assertEqual(file['file_size'], 99999)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_mark_deleted(self, mock_webdav_class):
        """Test marking file as deleted."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Insert file
        with mgr.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO file_metadata (id, stable_id, filename, doc_id, file_type, deleted) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ('test123', 'tst123', 'test.pdf', '10.1234/test', 'pdf', 0)
            )

        # Mark as deleted
        mgr.mark_deleted('test123', remote_version=5)

        # Verify deletion
        file = mgr.get_file_by_id('test123')
        self.assertEqual(file['deleted'], 1)
        self.assertEqual(file['remote_version'], 5)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_sync_metadata_operations(self, mock_webdav_class):
        """Test sync metadata get/set operations."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Set metadata
        mgr.set_sync_metadata('test_key', 'test_value')

        # Get metadata
        value = mgr.get_sync_metadata('test_key')
        self.assertEqual(value, 'test_value')

        # Update metadata
        mgr.set_sync_metadata('test_key', 'updated_value')
        value = mgr.get_sync_metadata('test_key')
        self.assertEqual(value, 'updated_value')

        # Get non-existent key
        value = mgr.get_sync_metadata('nonexistent')
        self.assertIsNone(value)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_version_tracking(self, mock_webdav_class):
        """Test version increment and retrieval."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)
        temp_path = mgr.download()
        mgr.connect(temp_path)

        # Get initial version
        version = mgr.get_version()
        self.assertEqual(version, 1)

        # Increment version
        new_version = mgr.increment_version()
        self.assertEqual(new_version, 2)

        # Verify version was updated
        version = mgr.get_version()
        self.assertEqual(version, 2)

        # Increment again
        new_version = mgr.increment_version()
        self.assertEqual(new_version, 3)

        mgr.disconnect()

    @patch('fastapi_app.lib.remote_metadata.WebdavFileSystem')
    def test_not_connected_errors(self, mock_webdav_class):
        """Test that operations fail when not connected."""
        mock_webdav_class.return_value = self.mock_fs

        mgr = RemoteMetadataManager(self.webdav_config, self.logger)

        # All these should raise RuntimeError
        with self.assertRaises(RuntimeError):
            mgr.get_all_files()

        with self.assertRaises(RuntimeError):
            mgr.get_file_by_id('test')

        with self.assertRaises(RuntimeError):
            mgr.upsert_file({'id': 'test'})

        with self.assertRaises(RuntimeError):
            mgr.mark_deleted('test', 1)

        with self.assertRaises(RuntimeError):
            mgr.get_sync_metadata('test')

        with self.assertRaises(RuntimeError):
            mgr.set_sync_metadata('test', 'value')


if __name__ == '__main__':
    unittest.main()
