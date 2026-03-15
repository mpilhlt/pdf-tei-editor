"""
Two-instance sync regression tests for the operation-log–based SyncService.

These tests exercise _apply_ops / _collect_own_ops directly to verify the key
correctness properties that were previously broken:

  Bug 1 – Ping-pong re-upload
    Resolved by design: once a file is marked synced (via mark_file_synced) it
    does not appear in get_files_to_upload(), so it is never re-uploaded.

  Bug 2 – Stable_id UNIQUE conflict during download
    When an upsert op arrives for a stable_id that already exists locally with
    a different hash, _apply_upsert_op performs a hash-replacement rather than
    a bare INSERT, avoiding the UNIQUE constraint error.

@testCovers fastapi_app/plugins/webdav_sync/service.py
"""

import gc
import json
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
    """Create a SyncService with mocked WebDAV transport."""
    with patch('fastapi_app.plugins.webdav_sync.service.WebdavFileSystem'):
        return SyncService(
            file_repo, file_storage,
            {'base_url': 'http://x', 'username': 'u', 'password': 'p',
             'remote_root': '/r'},
            SSEService(None), None
        )


def _upsert_op(seq: int, file_id: str, stable_id: str, **kwargs) -> dict:
    """Build a minimal upsert op dict (as returned by RemoteQueueManager)."""
    file_data = {
        'id': file_id,
        'stable_id': stable_id,
        'filename': kwargs.get('filename', 'doc.tei.xml'),
        'doc_id': kwargs.get('doc_id', 'doc1'),
        'doc_id_type': 'custom',
        'file_type': kwargs.get('file_type', 'tei'),
        'file_size': kwargs.get('file_size', 100),
        'label': None, 'variant': None, 'version': kwargs.get('version', 1),
        'is_gold_standard': False,
        'doc_collections': [], 'doc_metadata': {}, 'file_metadata': {},
        'deleted': False,
    }
    return {
        'seq': seq,
        'client_id': kwargs.get('client_id', 'remote-client-uuid'),
        'op_type': 'upsert',
        'stable_id': stable_id,
        'file_id': file_id,
        'file_data': json.dumps(file_data),
        'created_at': datetime.now(timezone.utc).isoformat(),
    }


def _delete_op(seq: int, file_id: str, stable_id: str, **kwargs) -> dict:
    return {
        'seq': seq,
        'client_id': kwargs.get('client_id', 'remote-client-uuid'),
        'op_type': 'delete',
        'stable_id': stable_id,
        'file_id': file_id,
        'file_data': None,
        'created_at': datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Test suite: _apply_ops
# ---------------------------------------------------------------------------

class TestApplyOps(unittest.TestCase):

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / 'test.db')
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.test_dir, self.db)
        self.service = _make_service(self.repo, self.storage)
        # Prevent real file downloads
        self.service._download_file = Mock()

    def tearDown(self):
        gc.collect()
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _write_file(self, content: bytes, file_type: str = 'tei') -> str:
        file_hash, _ = self.storage.save_file(content, file_type, increment_ref=True)
        return file_hash

    # -- new file -----------------------------------------------------------

    def test_new_file_is_inserted(self):
        """An upsert op for a file absent locally inserts it into the DB."""
        op = _upsert_op(seq=1, file_id='hash_new', stable_id='stable_new')
        summary = SyncSummary()
        self.service._apply_ops([op], summary, client_id=None)

        file = self.repo.get_file_by_id('hash_new')
        self.assertIsNotNone(file)
        self.assertEqual(file.stable_id, 'stable_new')
        self.assertEqual(summary.downloaded, 1)
        self.assertEqual(summary.errors, 0)

    def test_new_file_marked_synced_after_insert(self):
        """After applying an upsert op the record is in sync_status='synced'."""
        op = _upsert_op(seq=1, file_id='hash_a', stable_id='stable_a')
        self.service._apply_ops([op], SyncSummary(), client_id=None)

        file = self.repo.get_file_by_id('hash_a')
        self.assertEqual(file.sync_status, 'synced')

    # -- metadata-only update -----------------------------------------------

    def test_same_hash_is_metadata_update(self):
        """An upsert op for a hash already in local DB updates metadata, not downloads."""
        hash_a = self._write_file(b'<tei/>')
        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id='stable_a',
            filename='old.tei.xml', doc_id='doc1',
            file_type='tei', file_size=6
        ))
        self.repo.mark_file_synced(hash_a, 1)

        op = _upsert_op(seq=2, file_id=hash_a, stable_id='stable_a',
                        filename='renamed.tei.xml')
        summary = SyncSummary()
        self.service._apply_ops([op], summary, client_id=None)

        self.assertEqual(summary.metadata_synced, 1)
        self.assertEqual(summary.downloaded, 0)

    # -- Bug 2: stable_id conflict ------------------------------------------

    def test_upsert_op_different_hash_same_stable_id_replaces(self):
        """
        Bug 2 regression: when remote op has same stable_id but different hash
        than local, the local record is replaced without UNIQUE constraint error.
        """
        hash_a = self._write_file(b'<tei>version-a</tei>')
        hash_b = self._write_file(b'<tei>version-b</tei>')
        stable_id = 'stable_x'

        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id=stable_id,
            filename='doc.tei.xml', doc_id='doc1',
            file_type='tei', file_size=20
        ))
        self.repo.mark_file_synced(hash_a, 1)

        op = _upsert_op(seq=2, file_id=hash_b, stable_id=stable_id)
        summary = SyncSummary()
        self.service._apply_ops([op], summary, client_id=None)

        self.assertEqual(summary.errors, 0, 'No errors expected')
        self.assertEqual(summary.downloaded, 1)

        # New hash is now in the DB; old hash should be gone (or deleted).
        new_file = self.repo.get_file_by_stable_id(stable_id)
        self.assertIsNotNone(new_file)
        self.assertEqual(new_file.id, hash_b)

    # -- Bug 1: no ping-pong re-upload --------------------------------------

    def test_synced_file_not_re_uploaded(self):
        """
        Bug 1 regression: a file marked synced must NOT appear in
        get_files_to_upload() and must not generate a new upsert op.
        """
        hash_a = self._write_file(b'<tei>synced</tei>')
        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id='stable_a',
            filename='doc.tei.xml', doc_id='doc1',
            file_type='tei', file_size=10
        ))
        self.repo.mark_file_synced(hash_a, 5)

        to_upload = self.repo.get_files_to_upload()
        self.assertNotIn(hash_a, [f.id for f in to_upload],
                         'Synced file must not appear in get_files_to_upload()')

    # -- delete op ----------------------------------------------------------

    def test_delete_op_soft_deletes_local_file(self):
        """A delete op marks the local file as deleted and deletion_synced."""
        hash_a = self._write_file(b'<tei/>')
        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id='stable_del',
            filename='del.tei.xml', doc_id='doc1',
            file_type='tei', file_size=6
        ))
        self.repo.mark_file_synced(hash_a, 1)

        op = _delete_op(seq=2, file_id=hash_a, stable_id='stable_del')
        summary = SyncSummary()
        self.service._apply_ops([op], summary, client_id=None)

        file = self.repo.get_file_by_id(hash_a, include_deleted=True)
        self.assertIsNotNone(file)
        self.assertTrue(file.deleted)
        self.assertEqual(file.sync_status, 'deletion_synced')
        self.assertEqual(summary.deleted_local, 1)
        self.assertEqual(summary.errors, 0)

    def test_delete_op_idempotent_for_unknown_file(self):
        """A delete op for a file not in local DB is silently ignored."""
        op = _delete_op(seq=1, file_id='unknown_hash', stable_id='unknown_stable')
        summary = SyncSummary()
        self.service._apply_ops([op], summary, client_id=None)
        self.assertEqual(summary.errors, 0)
        self.assertEqual(summary.deleted_local, 0)


# ---------------------------------------------------------------------------
# Test suite: _collect_own_ops
# ---------------------------------------------------------------------------

class TestCollectOwnOps(unittest.TestCase):

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / 'test.db')
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.test_dir, self.db)
        self.service = _make_service(self.repo, self.storage)
        self.service._upload_file = Mock()

    def tearDown(self):
        gc.collect()
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _write_file(self, content: bytes, file_type: str = 'tei') -> str:
        file_hash, _ = self.storage.save_file(content, file_type, increment_ref=True)
        return file_hash

    def test_new_file_produces_upsert_op(self):
        """An unsynced file produces one upsert op."""
        hash_a = self._write_file(b'<tei/>')
        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id='stable_new',
            filename='new.tei.xml', doc_id='doc1',
            file_type='tei', file_size=6
        ))

        summary = SyncSummary()
        ops = self.service._collect_own_ops('client-uuid', summary, client_id=None)

        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]['op_type'], 'upsert')
        self.assertEqual(ops[0]['file_id'], hash_a)
        self.assertEqual(summary.uploaded, 1)

    def test_pending_delete_produces_delete_op(self):
        """A pending_delete file produces one delete op."""
        hash_a = self._write_file(b'<tei/>')
        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id='stable_del',
            filename='del.tei.xml', doc_id='doc1',
            file_type='tei', file_size=6
        ))
        self.repo.mark_file_synced(hash_a, 1)
        self.repo.delete_file(hash_a)

        summary = SyncSummary()
        ops = self.service._collect_own_ops('client-uuid', summary, client_id=None)

        delete_ops = [o for o in ops if o['op_type'] == 'delete']
        self.assertEqual(len(delete_ops), 1)
        self.assertEqual(delete_ops[0]['file_id'], hash_a)
        self.assertEqual(summary.deleted_remote, 1)

    def test_synced_file_produces_no_op(self):
        """A file already in sync_status='synced' must not produce any op."""
        hash_a = self._write_file(b'<tei/>')
        self.repo.insert_file(FileCreate(
            id=hash_a, stable_id='stable_synced',
            filename='synced.tei.xml', doc_id='doc1',
            file_type='tei', file_size=6
        ))
        self.repo.mark_file_synced(hash_a, 5)

        summary = SyncSummary()
        ops = self.service._collect_own_ops('client-uuid', summary, client_id=None)

        self.assertEqual(ops, [])
        self.assertEqual(summary.uploaded, 0)


if __name__ == '__main__':
    unittest.main()
