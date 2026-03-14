"""
WebDAV synchronization service.

Implements O(1) change detection and database-driven sync with:
- Two-tier database architecture (local + remote metadata.db)
- Deletion tracking via database flags (no .deleted marker files)
- Metadata synchronization
- Conflict detection and resolution
- Progress updates via SSE
"""

import time
import json
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from webdav4.fsspec import WebdavFileSystem

from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.sync.base import SyncServiceBase
from fastapi_app.lib.sync.models import (
    SyncSummary,
    SyncStatusResponse,
    ConflictInfo,
    ConflictListResponse,
    ConflictResolution,
)
from fastapi_app.lib.utils.hash_utils import get_file_extension
from .remote_metadata import RemoteMetadataManager


class SyncService(SyncServiceBase):
    """
    Database-driven WebDAV sync service.

    Key features:
    - O(1) quick skip check (count unsynced files + version comparison)
    - Database-driven change detection (no filesystem scanning)
    - Deletion propagation via database flags
    - Metadata sync without file transfers
    - Version-based conflict detection
    """

    def __init__(
        self,
        file_repo: FileRepository,
        file_storage: FileStorage,
        webdav_config: Dict[str, str],
        sse_service: Optional[SSEService] = None,
        logger=None
    ):
        """
        Initialize sync service.

        Args:
            file_repo: FileRepository instance for local database
            file_storage: FileStorage instance for local files
            webdav_config: WebDAV configuration dict
            sse_service: Optional SSEService for progress updates
            logger: Optional logger instance
        """
        self.file_repo = file_repo
        self.file_storage = file_storage
        self.webdav_config = webdav_config
        self.sse_service = sse_service
        self.logger = logger

        self.fs = WebdavFileSystem(
            webdav_config['base_url'],
            auth=(webdav_config['username'], webdav_config['password'])
        )
        self.remote_root = webdav_config['remote_root'].rstrip('/')
        self.lock_path = f"{self.remote_root}/version.txt.lock"

    def check_if_sync_needed(self) -> Dict[str, Any]:
        """
        O(1) check if synchronization is needed.

        Returns:
            Dict with 'needs_sync', 'local_version', 'remote_version', 'unsynced_count'
        """
        unsynced_count = self.file_repo.count_unsynced_files()

        local_version_str = self.file_repo.get_sync_metadata('remote_version')
        local_version = int(local_version_str) if local_version_str else 0

        try:
            remote_version = self._get_remote_version()
        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to get remote version: {e}")
            remote_version = local_version

        needs_sync = (unsynced_count > 0) or (local_version != remote_version)

        return {
            'needs_sync': needs_sync,
            'local_version': local_version,
            'remote_version': remote_version,
            'unsynced_count': unsynced_count
        }

    def check_status(self) -> SyncStatusResponse:
        """Check sync status (SyncServiceBase interface)."""
        status = self.check_if_sync_needed()

        last_sync_str = self.file_repo.get_sync_metadata('last_sync_time')
        from datetime import datetime
        last_sync_time = datetime.fromisoformat(last_sync_str) if last_sync_str else None

        sync_in_progress_str = self.file_repo.get_sync_metadata('sync_in_progress')
        sync_in_progress = sync_in_progress_str == '1' if sync_in_progress_str else False

        return SyncStatusResponse(
            needs_sync=status['needs_sync'],
            local_version=status['local_version'],
            remote_version=status['remote_version'],
            unsynced_count=status['unsynced_count'],
            last_sync_time=last_sync_time,
            sync_in_progress=sync_in_progress
        )

    def perform_sync(
        self,
        client_id: Optional[str] = None,
        force: bool = False
    ) -> SyncSummary:
        """
        Perform database-driven synchronization.

        Steps:
        1. Quick skip check (unless forced)
        2. Acquire remote lock
        3. Download remote metadata.db
        4. Compare metadata (find changes)
        5. Sync deletions (database-driven)
        6. Sync data files (upload/download)
        7. Sync metadata changes (no file transfers)
        8. Upload updated metadata.db
        9. Release lock
        """
        start_time = time.time()
        summary = SyncSummary()

        try:
            def send_progress(progress: int, message: str = ""):
                if self.sse_service and client_id:
                    self.sse_service.send_message(client_id, 'syncProgress', str(progress))
                    if message:
                        self.sse_service.send_message(client_id, 'syncMessage', message)

            send_progress(0, "Starting sync...")

            if not force:
                check = self.check_if_sync_needed()
                if not check['needs_sync']:
                    summary.skipped = True
                    summary.duration_ms = int((time.time() - start_time) * 1000)
                    send_progress(100, "No changes to sync")
                    return summary

            send_progress(10, "Acquiring sync lock...")

            if not self._acquire_lock():
                raise Exception("Failed to acquire sync lock")

            try:
                send_progress(20, "Downloading remote metadata...")

                remote_mgr = RemoteMetadataManager(self.webdav_config, self.logger)
                remote_db_path = remote_mgr.download()
                remote_mgr.connect(remote_db_path)

                try:
                    send_progress(30, "Comparing metadata...")

                    changes = self._compare_metadata(remote_mgr)

                    current_version = remote_mgr.get_version()
                    new_version = current_version + 1

                    send_progress(40, "Syncing deletions...")
                    self._sync_deletions(remote_mgr, changes, new_version, summary)

                    send_progress(55, "Syncing files...")
                    self._sync_data_files(remote_mgr, changes, new_version, summary, client_id=client_id)

                    send_progress(75, "Syncing metadata...")
                    self._sync_metadata(remote_mgr, changes, new_version, summary)

                    remote_mgr.set_sync_metadata('version', str(new_version))
                    summary.new_version = new_version

                    send_progress(90, "Uploading metadata...")
                    remote_mgr.upload(remote_db_path)

                    self._set_remote_version(new_version)

                    self.file_repo.set_sync_metadata('remote_version', str(new_version))
                    self.file_repo.set_sync_metadata(
                        'last_sync_time',
                        datetime.now(timezone.utc).isoformat()
                    )

                finally:
                    remote_mgr.disconnect()

            finally:
                self._release_lock()

            send_progress(100, "Sync complete")

        except Exception as e:
            if self.logger:
                self.logger.error(f"Sync failed: {e}")
            summary.errors = 1
            raise

        finally:
            summary.duration_ms = int((time.time() - start_time) * 1000)

        return summary

    def get_conflicts(self) -> ConflictListResponse:
        """Get list of sync conflicts (SyncServiceBase interface)."""
        conflicts = []
        conflict_files = [
            f for f in self.file_repo.get_all_files()
            if f.sync_status == 'conflict'
        ]

        for file in conflict_files:
            conflict = ConflictInfo(
                file_id=file.id,
                stable_id=file.stable_id,
                filename=file.filename,
                doc_id=file.doc_id,
                local_modified_at=file.local_modified_at,
                local_hash=file.id,
                remote_modified_at=None,
                remote_hash=file.sync_hash,
                conflict_type='modified_both'
            )
            conflicts.append(conflict)

        return ConflictListResponse(conflicts=conflicts, total=len(conflicts))

    def resolve_conflict(self, resolution: ConflictResolution) -> dict:
        """Resolve a sync conflict (SyncServiceBase interface)."""
        file_id = resolution.file_id

        if resolution.resolution == 'local_wins':
            from fastapi_app.lib.models import SyncUpdate
            self.file_repo.update_sync_status(
                file_id,
                SyncUpdate(sync_status='modified', sync_hash=None)
            )
            return {"message": "Local version will be uploaded on next sync"}

        elif resolution.resolution == 'remote_wins':
            remote_version_str = self.file_repo.get_sync_metadata('remote_version')
            remote_version = int(remote_version_str) if remote_version_str else 0
            self.file_repo.mark_file_synced(file_id, remote_version)
            return {"message": "Remote version will be downloaded on next sync"}

        elif resolution.resolution == 'keep_both':
            if not resolution.new_variant:
                raise ValueError("new_variant required for keep_both resolution")
            return {"message": f"Created variant '{resolution.new_variant}' (not implemented)"}

        raise ValueError(f"Invalid resolution strategy: {resolution.resolution}")

    def _compare_metadata(
        self,
        remote_mgr: RemoteMetadataManager
    ) -> Dict[str, List]:
        """Compare local and remote metadata to find changes."""
        local_files = {f.id: f for f in self.file_repo.get_all_files(include_deleted=True)}
        remote_files = {f['id']: f for f in remote_mgr.get_all_files(include_deleted=True)}

        changes: Dict[str, List] = {
            'local_new': [],
            'local_modified': [],
            'remote_new': [],
            'remote_modified': [],
            'remote_deleted': [],
            'conflicts': []
        }

        for file_id, local_file in local_files.items():
            if file_id not in remote_files:
                if not local_file.deleted:
                    changes['local_new'].append(local_file)
            else:
                remote_file = remote_files[file_id]
                local_modified = local_file.sync_status != 'synced'
                remote_deleted = remote_file['deleted']

                if local_modified and remote_deleted:
                    changes['conflicts'].append((local_file, remote_file))
                elif local_modified:
                    changes['local_modified'].append(local_file)

        for file_id, remote_file in remote_files.items():
            if file_id not in local_files:
                if not remote_file['deleted']:
                    changes['remote_new'].append(remote_file)
            else:
                local_file = local_files[file_id]
                remote_updated = remote_file.get('updated_at', '')
                local_updated = local_file.updated_at.isoformat() if local_file.updated_at else ''

                if remote_file['deleted']:
                    changes['remote_deleted'].append(remote_file)
                elif remote_updated > local_updated and local_file.sync_status == 'synced':
                    changes['remote_modified'].append(remote_file)

        return changes

    def _sync_deletions(
        self,
        remote_mgr: RemoteMetadataManager,
        changes: Dict,
        version: int,
        summary: SyncSummary
    ) -> None:
        """Sync deletions via database flags."""
        for remote_file in changes['remote_deleted']:
            file_id = remote_file['id']
            try:
                local_file = self.file_repo.get_file_by_id(file_id, include_deleted=True)
                if local_file and not local_file.deleted:
                    self.file_repo.delete_file(file_id)
                    summary.deleted_local += 1
                    if self.logger:
                        self.logger.info(f"Applied remote deletion: {file_id[:8]}...")
            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to apply remote deletion {file_id[:8]}...: {e}")
                summary.errors += 1

        local_deleted = self.file_repo.get_deleted_files()
        for local_file in local_deleted:
            try:
                remote_mgr.mark_deleted(local_file.id, version)
                summary.deleted_remote += 1
                self.file_repo.mark_deletion_synced(local_file.id, version)
                if self.logger:
                    self.logger.info(f"Marked remote as deleted: {local_file.id[:8]}...")
            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to mark remote deleted {local_file.id[:8]}...: {e}")
                summary.errors += 1

    def _send_message(self, client_id: Optional[str], message: str) -> None:
        """Send a syncMessage SSE event to the client."""
        if self.sse_service and client_id:
            self.sse_service.send_message(client_id, 'syncMessage', message)

    def _sync_data_files(
        self,
        remote_mgr: RemoteMetadataManager,
        changes: Dict,
        version: int,
        summary: SyncSummary,
        client_id: Optional[str] = None,
    ) -> None:
        """Sync actual data files using parallel HTTP transfers and sequential metadata writes."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from .config import get_transfer_workers

        workers = get_transfer_workers()

        # --- Uploads ---
        to_upload = changes['local_new'] + changes['local_modified']
        n_upload = len(to_upload)
        upload_done = 0

        if n_upload:
            self._send_message(client_id, f"Uploading {n_upload} file(s)...")

        def _do_upload(local_file: Any) -> tuple[Any, None]:
            file_path = self.file_storage.get_file_path(local_file.id, local_file.file_type)
            if not file_path.exists():
                if self.logger:
                    self.logger.warning(f"File not found for upload: {file_path}")
                return local_file, None
            remote_path = self._get_remote_file_path(local_file.id, local_file.file_type)
            self._upload_file(file_path, remote_path)
            return local_file, None

        upload_errors: dict[int, Exception] = {}
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_do_upload, f): f for f in to_upload}
            for future in as_completed(futures):
                local_file = futures[future]
                upload_done += 1
                try:
                    future.result()
                    self._send_message(
                        client_id,
                        f"\u2191 {local_file.filename} ({upload_done}/{n_upload})"
                    )
                except Exception as e:
                    upload_errors[id(local_file)] = e
                    self._send_message(
                        client_id,
                        f"\u2715 {local_file.filename}: {e}"
                    )

        for local_file in to_upload:
            err = upload_errors.get(id(local_file))
            if err is not None:
                if self.logger:
                    self.logger.error(f"Failed to upload {local_file.filename}: {err}")
                summary.errors += 1
                continue
            file_path = self.file_storage.get_file_path(local_file.id, local_file.file_type)
            if not file_path.exists():
                continue
            try:
                remote_mgr.upsert_file(self._file_to_remote_dict(local_file, version))
                self.file_repo.mark_file_synced(local_file.id, version)
                summary.uploaded += 1
                if self.logger:
                    self.logger.info(f"Uploaded: {local_file.filename}")
            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to record upload metadata {local_file.filename}: {e}")
                summary.errors += 1

        # --- Downloads ---
        to_download = changes['remote_new']
        n_download = len(to_download)
        download_done = 0

        if n_download:
            self._send_message(client_id, f"Downloading {n_download} file(s)...")

        def _do_download(remote_file: dict[str, Any]) -> tuple[dict[str, Any], None]:
            from fastapi_app.lib.utils.hash_utils import get_storage_path
            file_id = remote_file['id']
            file_type = remote_file['file_type']
            remote_path = self._get_remote_file_path(file_id, file_type)
            # Use get_storage_path directly — file_storage.get_file_path returns None for files
            # that don't exist yet, which is always the case for remote_new files.
            local_path = get_storage_path(self.file_storage.data_root, file_id, file_type)
            self._download_file(remote_path, local_path)
            return remote_file, None

        download_errors: dict[str, Exception] = {}
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_do_download, f): f for f in to_download}
            for future in as_completed(futures):
                remote_file = futures[future]
                download_done += 1
                try:
                    future.result()
                    self._send_message(
                        client_id,
                        f"\u2193 {remote_file['filename']} ({download_done}/{n_download})"
                    )
                except Exception as e:
                    download_errors[remote_file['id']] = e
                    self._send_message(
                        client_id,
                        f"\u2715 {remote_file['filename']}: {e}"
                    )

        for remote_file in to_download:
            file_id = remote_file['id']
            err = download_errors.get(file_id)
            if err is not None:
                if self.logger:
                    self.logger.error(f"Failed to download {remote_file['filename']}: {err}")
                summary.errors += 1
                continue
            try:
                from fastapi_app.lib.models.models import FileCreate
                file_create = FileCreate(
                    id=file_id,
                    stable_id=remote_file['stable_id'],
                    filename=remote_file['filename'],
                    doc_id=remote_file['doc_id'],
                    doc_id_type=remote_file.get('doc_id_type', 'custom'),
                    file_type=remote_file['file_type'],
                    file_size=remote_file['file_size'],
                    label=remote_file.get('label'),
                    variant=remote_file.get('variant'),
                    version=remote_file.get('version'),
                    is_gold_standard=bool(remote_file.get('is_gold_standard', False)),
                    doc_collections=json.loads(remote_file.get('doc_collections', '[]')),
                    doc_metadata=json.loads(remote_file.get('doc_metadata', '{}')),
                    file_metadata=json.loads(remote_file.get('file_metadata', '{}'))
                )
                self.file_repo.insert_file(file_create)
                self.file_repo.mark_file_synced(file_id, version)
                summary.downloaded += 1
                if self.logger:
                    self.logger.info(f"Downloaded: {remote_file['filename']}")
            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to record download metadata {remote_file['filename']}: {e}")
                summary.errors += 1

    def _sync_metadata(
        self,
        remote_mgr: RemoteMetadataManager,
        changes: Dict,
        version: int,
        summary: SyncSummary
    ) -> None:
        """Sync metadata changes without transferring files."""
        for remote_file in changes['remote_modified']:
            try:
                file_id = remote_file['id']
                self.file_repo.apply_remote_metadata(file_id, remote_file)
                summary.metadata_synced += 1
                if self.logger:
                    self.logger.info(f"Applied remote metadata: {file_id[:8]}...")
            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to apply remote metadata {file_id[:8]}...: {e}")
                summary.errors += 1

    def _get_remote_version(self) -> int:
        """Get remote version number."""
        version_path = f"{self.remote_root}/version.txt"
        try:
            if not self.fs.exists(version_path):
                with self.fs.open(version_path, 'w') as f:
                    f.write('1')
                return 1
            with self.fs.open(version_path, 'r') as f:
                return int(f.read().strip())
        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to get remote version: {e}")
            raise

    def _set_remote_version(self, version: int) -> None:
        """Set remote version number in version.txt."""
        version_path = f"{self.remote_root}/version.txt"
        try:
            with self.fs.open(version_path, 'w') as f:
                f.write(str(version))
            if self.logger:
                self.logger.info(f"Updated remote version to {version}")
        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to set remote version: {e}")
            raise

    def _acquire_lock(self, timeout_seconds: int = 300) -> bool:
        """Acquire sync lock."""
        start_time = time.time()

        try:
            if not self.fs.exists(self.remote_root):
                if self.logger:
                    self.logger.info(f"Creating remote root directory: {self.remote_root}")
                self.fs.makedirs(self.remote_root, exist_ok=True)
        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to create remote root directory: {e}")
            return False

        while time.time() - start_time < timeout_seconds:
            try:
                if self.fs.exists(self.lock_path):
                    lock_info = self.fs.info(self.lock_path)
                    if lock_info.get('modified'):
                        lock_age = datetime.now(timezone.utc) - lock_info['modified']
                        if lock_age.total_seconds() > 60:
                            self.fs.rm(self.lock_path)
                        else:
                            time.sleep(2)
                            continue

                with self.fs.open(self.lock_path, 'w') as f:
                    f.write(json.dumps({
                        'timestamp': datetime.now(timezone.utc).isoformat(),
                        'host': 'fastapi-instance'
                    }))
                return True

            except Exception as e:
                if self.logger:
                    self.logger.debug(f"Lock acquisition attempt failed: {e}")
                time.sleep(2)

        return False

    def _release_lock(self) -> None:
        """Release sync lock."""
        try:
            if self.fs.exists(self.lock_path):
                self.fs.rm(self.lock_path)
        except Exception as e:
            if self.logger:
                self.logger.warning(f"Failed to release lock: {e}")

    def _get_remote_file_path(self, file_id: str, file_type: str) -> str:
        """Get remote path for a file."""
        ext = get_file_extension(file_type)
        shard = file_id[:2]
        return f"{self.remote_root}/{shard}/{file_id}{ext}"

    def _upload_file(self, local_path: Path, remote_path: str) -> None:
        """Upload file to WebDAV."""
        remote_dir = '/'.join(remote_path.split('/')[:-1])
        if not self.fs.exists(remote_dir):
            self.fs.makedirs(remote_dir)

        with open(local_path, 'rb') as local_file:
            with self.fs.open(remote_path, 'wb') as remote_file:
                shutil.copyfileobj(local_file, remote_file)

    def _download_file(self, remote_path: str, local_path: Path) -> None:
        """Download file from WebDAV."""
        local_path.parent.mkdir(parents=True, exist_ok=True)

        with self.fs.open(remote_path, 'rb') as remote_file:
            with open(local_path, 'wb') as local_file:
                shutil.copyfileobj(remote_file, local_file)

    def _file_to_remote_dict(self, file_metadata, version: int) -> Dict[str, Any]:
        """Convert FileMetadata to dict for remote database."""
        return {
            'id': file_metadata.id,
            'stable_id': file_metadata.stable_id,
            'filename': file_metadata.filename,
            'doc_id': file_metadata.doc_id,
            'doc_id_type': getattr(file_metadata, 'doc_id_type', 'custom'),
            'file_type': file_metadata.file_type,
            'mime_type': getattr(file_metadata, 'mime_type', None),
            'file_size': file_metadata.file_size,
            'label': file_metadata.label,
            'variant': file_metadata.variant,
            'version': file_metadata.version,
            'is_gold_standard': file_metadata.is_gold_standard,
            'doc_collections': json.dumps(file_metadata.doc_collections),
            'doc_metadata': json.dumps(file_metadata.doc_metadata),
            'file_metadata': json.dumps(file_metadata.file_metadata),
            'deleted': file_metadata.deleted,
            'remote_version': version
        }
