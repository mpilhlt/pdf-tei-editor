"""
Database-driven synchronization service.

Implements O(1) change detection and database-driven sync with:
- Two-tier database architecture (local + remote metadata.db)
- Deletion tracking via database flags (no .deleted marker files)
- Metadata synchronization
- Conflict detection and resolution
- Progress updates via SSE
"""

import time
import json
from pathlib import Path
from typing import Dict, List, Optional, Callable, Tuple, Any
from datetime import datetime
from webdav4.fsspec import WebdavFileSystem

from .file_repository import FileRepository
from .remote_metadata import RemoteMetadataManager
from .file_storage import FileStorage
from .sse_service import SSEService
from .models_sync import SyncSummary, ConflictInfo
from .hash_utils import get_file_extension


class SyncService:
    """
    Database-driven sync with remote metadata.db.

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

        # Initialize WebDAV filesystem
        self.fs = WebdavFileSystem(
            webdav_config['base_url'],
            auth=(webdav_config['username'], webdav_config['password'])
        )
        self.remote_root = webdav_config['remote_root'].rstrip('/')

        # Lock file paths
        self.lock_path = f"{self.remote_root}/version.txt.lock"

    def check_if_sync_needed(self) -> Dict[str, Any]:
        """
        O(1) check if synchronization is needed.

        Checks:
        1. Count of unsynced files in local database
        2. Local vs remote version comparison

        Returns:
            Dict with 'needs_sync', 'local_version', 'remote_version', 'unsynced_count'
        """
        # Check local unsynced files (O(1) COUNT query)
        unsynced_count = self.file_repo.count_unsynced_files()

        # Get local version
        local_version_str = self.file_repo.get_sync_metadata('remote_version')
        local_version = int(local_version_str) if local_version_str else 0

        # Get remote version
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

        Args:
            client_id: Optional client ID for SSE progress updates
            force: Force sync even if quick check says skip

        Returns:
            SyncSummary with operation results
        """
        start_time = time.time()
        summary = SyncSummary()

        try:
            # Progress callback
            def send_progress(progress: int, message: str = ""):
                if self.sse_service and client_id:
                    self.sse_service.send_message(
                        client_id,
                        'syncProgress',
                        str(progress)
                    )
                    if message:
                        self.sse_service.send_message(
                            client_id,
                            'syncMessage',
                            message
                        )

            send_progress(0, "Starting sync...")

            # Step 1: Quick skip check
            if not force:
                check = self.check_if_sync_needed()
                if not check['needs_sync']:
                    summary.skipped = True
                    summary.duration_ms = int((time.time() - start_time) * 1000)
                    send_progress(100, "No changes to sync")
                    return summary

            send_progress(10, "Acquiring sync lock...")

            # Step 2: Acquire lock
            if not self._acquire_lock():
                raise Exception("Failed to acquire sync lock")

            try:
                send_progress(20, "Downloading remote metadata...")

                # Step 3: Download and connect to remote metadata.db
                remote_mgr = RemoteMetadataManager(self.webdav_config, self.logger)
                remote_db_path = remote_mgr.download()
                remote_mgr.connect(remote_db_path)

                try:
                    send_progress(30, "Comparing metadata...")

                    # Step 4: Compare metadata
                    changes = self._compare_metadata(remote_mgr)

                    # Get or increment version
                    current_version = remote_mgr.get_version()
                    new_version = current_version + 1

                    send_progress(40, "Syncing deletions...")

                    # Step 5: Sync deletions
                    self._sync_deletions(remote_mgr, changes, new_version, summary)

                    send_progress(55, "Syncing files...")

                    # Step 6: Sync data files
                    self._sync_data_files(remote_mgr, changes, new_version, summary)

                    send_progress(75, "Syncing metadata...")

                    # Step 7: Sync metadata changes
                    self._sync_metadata(remote_mgr, changes, new_version, summary)

                    # Step 8: Update version
                    remote_mgr.set_sync_metadata('version', str(new_version))
                    summary.new_version = new_version

                    send_progress(90, "Uploading metadata...")

                    # Step 9: Upload updated metadata.db
                    remote_mgr.upload(remote_db_path)

                    # Step 10: Update version.txt on remote
                    self._set_remote_version(new_version)

                    # Update local version
                    self.file_repo.set_sync_metadata('remote_version', str(new_version))
                    self.file_repo.set_sync_metadata(
                        'last_sync_time',
                        datetime.now().isoformat()
                    )

                finally:
                    remote_mgr.disconnect()

            finally:
                # Step 10: Release lock
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

    def _compare_metadata(
        self,
        remote_mgr: RemoteMetadataManager
    ) -> Dict[str, List[Dict]]:
        """
        Compare local and remote metadata to find changes.

        Returns:
            Dict with keys:
            - local_new: Files only in local
            - local_modified: Files modified locally
            - remote_new: Files only in remote
            - remote_modified: Files modified remotely
            - remote_deleted: Files deleted remotely
            - conflicts: Files with conflicting changes
        """
        # Get all files from both databases
        local_files = {f.id: f for f in self.file_repo.get_all_files(include_deleted=True)}
        remote_files = {f['id']: f for f in remote_mgr.get_all_files(include_deleted=True)}

        changes = {
            'local_new': [],
            'local_modified': [],
            'remote_new': [],
            'remote_modified': [],
            'remote_deleted': [],
            'conflicts': []
        }

        # Find files only in local (need upload)
        for file_id, local_file in local_files.items():
            if file_id not in remote_files:
                if not local_file.deleted:
                    changes['local_new'].append(local_file)
            else:
                remote_file = remote_files[file_id]

                # Check for conflicts
                local_modified = local_file.sync_status != 'synced'
                remote_deleted = remote_file['deleted']

                if local_modified and remote_deleted:
                    changes['conflicts'].append((local_file, remote_file))
                elif local_modified:
                    changes['local_modified'].append(local_file)

        # Find files only in remote (need download)
        for file_id, remote_file in remote_files.items():
            if file_id not in local_files:
                if not remote_file['deleted']:
                    changes['remote_new'].append(remote_file)
            else:
                local_file = local_files[file_id]

                # Check for remote modifications (metadata changes)
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
        """
        Sync deletions via database flags (no .deleted marker files).

        Args:
            remote_mgr: Remote metadata manager
            changes: Changes dict from _compare_metadata
            version: New version number
            summary: Summary to update with counts
        """
        # Apply remote deletions to local
        for remote_file in changes['remote_deleted']:
            file_id = remote_file['id']

            try:
                # Delete local file if it exists
                local_file = self.file_repo.get_file_by_id(file_id, include_deleted=True)
                if local_file and not local_file.deleted:
                    self.file_repo.delete_file(file_id)

                    # Delete physical file (handled by file_repo via reference counting)
                    summary.deleted_local += 1

                    if self.logger:
                        self.logger.info(f"Applied remote deletion: {file_id[:8]}...")

            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to apply remote deletion {file_id[:8]}...: {e}")
                summary.errors += 1

        # Upload local deletions to remote DB
        local_deleted = self.file_repo.get_deleted_files()
        for local_file in local_deleted:
            try:
                remote_mgr.mark_deleted(local_file.id, version)
                summary.deleted_remote += 1

                # Mark deletion as synced so it doesn't get synced again
                self.file_repo.mark_deletion_synced(local_file.id, version)

                if self.logger:
                    self.logger.info(f"Marked remote as deleted: {local_file.id[:8]}...")

            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to mark remote deleted {local_file.id[:8]}...: {e}")
                summary.errors += 1

    def _sync_data_files(
        self,
        remote_mgr: RemoteMetadataManager,
        changes: Dict,
        version: int,
        summary: SyncSummary
    ) -> None:
        """
        Sync actual data files (upload/download).

        Args:
            remote_mgr: Remote metadata manager
            changes: Changes dict from _compare_metadata
            version: New version number
            summary: Summary to update with counts
        """
        # Upload new and modified files
        files_to_upload = changes['local_new'] + changes['local_modified']

        for local_file in files_to_upload:
            try:
                # Get physical file
                file_path = self.file_storage.get_file_path(
                    local_file.id,
                    local_file.file_type
                )

                if not file_path.exists():
                    if self.logger:
                        self.logger.warning(f"File not found for upload: {file_path}")
                    continue

                # Upload to WebDAV
                remote_path = self._get_remote_file_path(local_file.id, local_file.file_type)
                self._upload_file(file_path, remote_path)

                # Update remote metadata
                remote_mgr.upsert_file(self._file_to_remote_dict(local_file, version))

                # Mark local as synced
                self.file_repo.mark_file_synced(local_file.id, version)

                summary.uploaded += 1

                if self.logger:
                    self.logger.info(f"Uploaded: {local_file.filename}")

            except Exception as e:
                if self.logger:
                    self.logger.error(f"Failed to upload {local_file.filename}: {e}")
                summary.errors += 1

        # Download new files from remote
        for remote_file in changes['remote_new']:
            try:
                file_id = remote_file['id']
                file_type = remote_file['file_type']

                # Download from WebDAV
                remote_path = self._get_remote_file_path(file_id, file_type)
                local_path = self.file_storage.get_file_path(file_id, file_type)

                self._download_file(remote_path, local_path)

                # Insert into local database
                from .models import FileCreate
                file_create = FileCreate(
                    id=file_id,
                    stable_id=remote_file['stable_id'],
                    filename=remote_file['filename'],
                    doc_id=remote_file['doc_id'],
                    doc_id_type=remote_file.get('doc_id_type', 'custom'),
                    file_type=file_type,
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
                    self.logger.error(f"Failed to download {remote_file['filename']}: {e}")
                summary.errors += 1

    def _sync_metadata(
        self,
        remote_mgr: RemoteMetadataManager,
        changes: Dict,
        version: int,
        summary: SyncSummary
    ) -> None:
        """
        Sync metadata changes without transferring files.

        Args:
            remote_mgr: Remote metadata manager
            changes: Changes dict from _compare_metadata
            version: New version number
            summary: Summary to update with counts
        """
        # Apply remote metadata changes to local
        for remote_file in changes['remote_modified']:
            try:
                file_id = remote_file['id']

                # Apply metadata without marking as modified
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
                # Create version file if it doesn't exist
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

        # Ensure remote root directory exists
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
                    # Check if lock is stale (> 60 seconds)
                    lock_info = self.fs.info(self.lock_path)
                    if lock_info.get('modified'):
                        lock_age = datetime.now() - lock_info['modified']
                        if lock_age.total_seconds() > 60:
                            self.fs.rm(self.lock_path)
                        else:
                            time.sleep(2)
                            continue

                # Create lock file
                with self.fs.open(self.lock_path, 'w') as f:
                    f.write(json.dumps({
                        'timestamp': datetime.now().isoformat(),
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
        # Ensure remote directory exists
        remote_dir = '/'.join(remote_path.split('/')[:-1])
        if not self.fs.exists(remote_dir):
            self.fs.makedirs(remote_dir)

        # Upload file
        with open(local_path, 'rb') as local_file:
            with self.fs.open(remote_path, 'wb') as remote_file:
                import shutil
                shutil.copyfileobj(local_file, remote_file)

    def _download_file(self, remote_path: str, local_path: Path) -> None:
        """Download file from WebDAV."""
        # Ensure local directory exists
        local_path.parent.mkdir(parents=True, exist_ok=True)

        # Download file
        with self.fs.open(remote_path, 'rb') as remote_file:
            with open(local_path, 'wb') as local_file:
                import shutil
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
