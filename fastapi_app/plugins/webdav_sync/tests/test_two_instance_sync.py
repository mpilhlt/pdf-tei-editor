"""
Two-instance sync regression tests.

Simulates two independent instances (local + server) sharing the same WebDAV
repository.  The tests expose two concrete bugs in _compare_metadata and
_sync_data_files:

  Bug 1 – Ping-pong re-upload
    A file that was synced by instance A (sync_status='synced') gets its hash
    removed from the remote DB when instance B uploads a newer version of the
    same logical file (same stable_id, different hash) via INSERT OR REPLACE.
    On A's next sync the hash is missing from remote, so _compare_metadata
    unconditionally puts it in local_new and re-uploads it.  B then re-uploads
    its version, replacing A's entry again → infinite loop.

  Bug 2 – Download IntegrityError
    When _sync_data_files tries to INSERT the remote_new file (hash_b,
    stable_id=X) it fails with a UNIQUE constraint violation because local
    already has (hash_a, stable_id=X).  The error is silently counted in
    summary.errors and the file is never downloaded.

@testCovers fastapi_app/plugins/webdav_sync/service.py
"""

import gc
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.sync.models import SyncSummary
from fastapi_app.plugins.webdav_sync.service import SyncService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_service(file_repo: FileRepository, file_storage: FileStorage) -> SyncService:
    """Create a SyncService backed by the given repo/storage (WebDAV is mocked)."""
    with patch('fastapi_app.plugins.webdav_sync.service.WebdavFileSystem'):
        return SyncService(
            file_repo, file_storage,
            {'base_url': 'http://x', 'username': 'u', 'password': 'p',
             'remote_root': '/r'},
            SSEService(None), None
        )


def _remote_mgr_mock(remote_files: list) -> Mock:
    """Return a mock RemoteMetadataManager that serves the given file list."""
    m = Mock()
    m.get_all_files.return_value = remote_files
    return m


def _remote_entry(file_id: str, stable_id: str, **kwargs) -> dict:
    """Build a minimal remote file-metadata dict."""
    return {
        'id': file_id,
        'stable_id': stable_id,
        'filename': kwargs.get('filename', 'doc.tei.xml'),
        'doc_id': kwargs.get('doc_id', 'doc1'),
        'doc_id_type': 'custom',
        'file_type': kwargs.get('file_type', 'tei'),
        'file_size': kwargs.get('file_size', 100),
        'label': None, 'variant': None, 'version': None,
        'is_gold_standard': False,
        'doc_collections': '[]', 'doc_metadata': '{}', 'file_metadata': '{}',
        'deleted': kwargs.get('deleted', False),
        'updated_at': kwargs.get('updated_at',
                                 datetime.now(timezone.utc).isoformat()),
    }


# ---------------------------------------------------------------------------
# Test suite for _compare_metadata
# ---------------------------------------------------------------------------

class TestCompareMetadataTwoInstances(unittest.TestCase):
    """Unit tests for _compare_metadata with two-instance scenarios."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.test_dir, self.db)
        self.service = _make_service(self.repo, self.storage)

    def tearDown(self):
        gc.collect()
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # -- positive cases --------------------------------------------------

    def test_new_version_appears_in_local_new(self):
        """
        A newly-created version (sync_status='modified', brand-new stable_id)
        must appear in local_new so it gets uploaded.
        """
        # Synced original
        self.repo.insert_file(FileCreate(
            id='hash_orig', stable_id='stable_orig',
            filename='doc.tei.xml', doc_id='doc1',
            file_type='tei', file_size=100
        ))
        self.repo.mark_file_synced('hash_orig', 1)

        # New version (different stable_id, not yet synced)
        self.repo.insert_file(FileCreate(
            id='hash_v2', stable_id='stable_v2',
            filename='doc.v2.tei.xml', doc_id='doc1',
            file_type='tei', file_size=150
        ))

        # Remote only knows the original
        remote_mgr = _remote_mgr_mock([
            _remote_entry('hash_orig', 'stable_orig')
        ])
        changes = self.service._compare_metadata(remote_mgr)

        local_new_ids = {f.id for f in changes['local_new']}
        self.assertIn('hash_v2', local_new_ids,
                      "New version must appear in local_new")
        self.assertNotIn('hash_orig', local_new_ids,
                         "Synced original must not appear in local_new")

    def test_unsynced_file_not_in_remote_is_local_new(self):
        """A file that was never synced and is absent from remote → local_new."""
        self.repo.insert_file(FileCreate(
            id='hash_new', stable_id='stable_new',
            filename='new.tei.xml', doc_id='doc2',
            file_type='tei', file_size=200
        ))
        changes = self.service._compare_metadata(_remote_mgr_mock([]))
        local_new_ids = {f.id for f in changes['local_new']}
        self.assertIn('hash_new', local_new_ids)

    # -- Bug 1: ping-pong ------------------------------------------------

    def test_synced_file_replaced_in_remote_not_in_local_new(self):
        """
        hash_a is marked 'synced' locally.  Remote has hash_b for the same
        stable_id (another instance replaced hash_a via INSERT OR REPLACE).
        hash_a must NOT appear in local_new (no ping-pong re-upload).
        hash_b must be in remote_modified (same stable_id, different hash).
        """
        stable_id = 'stable_x'
        self.repo.insert_file(FileCreate(
            id='hash_a', stable_id=stable_id,
            filename='doc.tei.xml', doc_id='doc1',
            file_type='tei', file_size=100
        ))
        self.repo.mark_file_synced('hash_a', 1)

        remote_mgr = _remote_mgr_mock([
            _remote_entry('hash_b', stable_id)
        ])
        changes = self.service._compare_metadata(remote_mgr)

        local_new_ids = {f.id for f in changes['local_new']}
        self.assertNotIn('hash_a', local_new_ids,
                         "Synced hash_a replaced in remote must not be re-uploaded")

        remote_modified_ids = {f['id'] for f in changes['remote_modified']}
        self.assertIn('hash_b', remote_modified_ids,
                      "Remote hash_b (same stable_id) must appear in remote_modified")



# ---------------------------------------------------------------------------
# Test suite for _sync_data_files (download path)
# ---------------------------------------------------------------------------

class TestDownloadStableIdConflict(unittest.TestCase):
    """Tests for the stable_id UNIQUE constraint error during downloads."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.test_dir, self.db)
        self.service = _make_service(self.repo, self.storage)

    def tearDown(self):
        gc.collect()
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _write_file(self, content: bytes, file_type: str = 'tei') -> str:
        file_hash, _ = self.storage.save_file(content, file_type,
                                              increment_ref=True)
        return file_hash

    def _run_download(self, remote_file: dict) -> SyncSummary:
        """Run _sync_data_files with a single remote_new entry."""
        changes = {
            'local_new': [], 'local_modified': [],
            'remote_new': [remote_file],
            'remote_modified': [], 'remote_deleted': [], 'conflicts': [],
        }
        summary = SyncSummary()
        mock_remote_mgr = Mock()
        with patch.object(self.service, '_download_file'):
            self.service._sync_data_files(
                mock_remote_mgr, changes, version=2, summary=summary)
        return summary

    # -- Bug 2 -----------------------------------------------------------

    def test_download_stable_id_conflict_applies_metadata(self):
        """
        When remote_new contains a file with the same stable_id as an
        existing local file (different hash), the conflict is resolved via
        a metadata update on the existing record — no error, no duplicate
        insert.
        """
        stable_id = 'stable_x'
        hash_a = self._write_file(b'<tei>version-a</tei>')
        hash_b = self._write_file(b'<tei>version-b</tei>')

        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id=stable_id,
            filename='doc.tei.xml', doc_id='doc1',
            file_type='tei', file_size=20
        ))
        self.repo.mark_file_synced(hash_a, 1)

        remote_file = _remote_entry(hash_b, stable_id, file_size=20)
        summary = self._run_download(remote_file)

        self.assertEqual(summary.errors, 0,
                         "Stable_id conflict must be handled without error")
        self.assertEqual(summary.downloaded, 0,
                         "File must not be counted as a full download")
        self.assertGreater(summary.metadata_synced, 0,
                           "Conflict must be counted as a metadata sync")



if __name__ == '__main__':
    unittest.main()
