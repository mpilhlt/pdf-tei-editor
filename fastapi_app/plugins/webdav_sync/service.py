"""
WebDAV synchronization service — operation-log edition.

Uses an append-only operation log (queue.db) shared on WebDAV instead of a
mutable metadata snapshot.  Each sync cycle:

  1. Lock
  2. Download queue.db
  3. Register own client ID
  4. Apply ops from other clients (download files, update local DB)
  5. Append own pending ops (upload files, record in log)
  6. Compact old ops
  7. Upload queue.db + update version.txt
  8. Release lock
"""

import json
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from webdav4.fsspec import WebdavFileSystem

from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.sync.base import SyncServiceBase
from fastapi_app.lib.sync.models import (
    ConflictInfo,
    ConflictListResponse,
    ConflictResolution,
    SyncStatusResponse,
    SyncSummary,
)
from fastapi_app.lib.core.locking import get_all_active_locks
from fastapi_app.lib.utils.hash_utils import get_file_extension, get_storage_path
from .remote_queue import RemoteQueueManager

# Remote lock TTL: local timeout + one full sync-cycle buffer
_REMOTE_LOCK_TTL_SECONDS = 90 + 360


def _parse_json_field(value: Any, default: Any) -> Any:
    """Return value parsed from JSON if it is a string, otherwise return as-is."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return default
    return value if value is not None else default


class SyncService(SyncServiceBase):
    """
    Operation-log–based WebDAV sync service.

    Key properties vs the previous metadata.db approach:
    - Append-only log: an empty or missing queue.db means "no ops yet", never
      "all files deleted".
    - Seq counter only moves forward; version regression is impossible.
    - A fresh instance with an empty local DB simply applies all ops in the log
      and rebuilds its state correctly.
    """

    def __init__(
        self,
        file_repo: FileRepository,
        file_storage: Optional[FileStorage],
        webdav_config: Dict[str, str],
        sse_service: Optional[SSEService] = None,
        logger=None,
        db_dir: Optional[Path] = None,
    ):
        self.file_repo = file_repo
        self.file_storage = file_storage
        self.webdav_config = webdav_config
        self.sse_service = sse_service
        self.logger = logger
        self.db_dir = db_dir  # for lock checks; None disables the feature

        self.fs = WebdavFileSystem(
            webdav_config["base_url"],
            auth=(webdav_config["username"], webdav_config["password"]),
        )
        self.remote_root = webdav_config["remote_root"].rstrip("/")
        self.lock_path = f"{self.remote_root}/version.txt.lock"

    # ------------------------------------------------------------------
    # SyncServiceBase interface
    # ------------------------------------------------------------------

    def check_if_sync_needed(self) -> Dict[str, Any]:
        """
        O(1) check whether synchronisation is needed.

        Returns:
            Dict with 'needs_sync', 'local_version', 'remote_version',
            'unsynced_count'.
        """
        unsynced_count = self.file_repo.count_unsynced_files()

        local_seq_str = self.file_repo.get_sync_metadata("last_applied_seq")
        local_seq = int(local_seq_str) if local_seq_str else 0

        try:
            remote_seq = self._get_remote_version()
        except Exception as exc:
            if self.logger:
                self.logger.error(f"Failed to get remote version: {exc}")
            remote_seq = local_seq

        needs_sync = (unsynced_count > 0) or (local_seq != remote_seq)

        return {
            "needs_sync": needs_sync,
            "local_version": local_seq,
            "remote_version": remote_seq,
            "unsynced_count": unsynced_count,
        }

    def check_status(self) -> SyncStatusResponse:
        """Check sync status (SyncServiceBase interface)."""
        status = self.check_if_sync_needed()
        last_sync_str = self.file_repo.get_sync_metadata("last_sync_time")
        last_sync_time = datetime.fromisoformat(last_sync_str) if last_sync_str else None
        sync_in_progress = (
            self.file_repo.get_sync_metadata("sync_in_progress") == "1"
        )
        return SyncStatusResponse(
            needs_sync=status["needs_sync"],
            local_version=status["local_version"],
            remote_version=status["remote_version"],
            unsynced_count=status["unsynced_count"],
            last_sync_time=last_sync_time,
            sync_in_progress=sync_in_progress,
        )

    def perform_sync(
        self,
        client_id: Optional[str] = None,
        force: bool = False,
    ) -> SyncSummary:
        """
        Perform one sync cycle.

        Args:
            client_id: SSE session ID for progress updates (not the sync
                client UUID — those are separate concepts).
            force: Skip the quick-check and always run a full sync.

        Returns:
            SyncSummary with counts of what was transferred.
        """
        start_time = time.time()
        summary = SyncSummary()

        try:
            def send_progress(pct: int, message: str = "") -> None:
                if self.sse_service and client_id:
                    self.sse_service.send_message(client_id, "syncProgress", str(pct))
                    if message:
                        self.sse_service.send_message(client_id, "syncMessage", message)

            send_progress(0, "Starting sync...")

            if not force:
                check = self.check_if_sync_needed()
                if not check["needs_sync"]:
                    summary.skipped = True
                    summary.duration_ms = int((time.time() - start_time) * 1000)
                    send_progress(100, "No changes to sync")
                    return summary

            send_progress(10, "Acquiring sync lock...")
            if not self._acquire_lock():
                raise Exception("Failed to acquire sync lock")

            try:
                own_client_id = self._get_or_create_client_id()

                send_progress(20, "Downloading sync queue...")
                queue_mgr = RemoteQueueManager(self.webdav_config, self.logger)
                queue_db_path = queue_mgr.download()
                queue_mgr.connect(queue_db_path)

                try:
                    # Serialize own active locks so other instances can see them
                    own_active_locks: Dict[str, Any] = {}
                    if self.db_dir:
                        try:
                            raw = get_all_active_locks(self.db_dir, self.logger or __import__('logging').getLogger(__name__))
                            now_iso = datetime.now(timezone.utc).isoformat()
                            own_active_locks = {
                                stable_id: {"acquired_at": now_iso, "updated_at": now_iso}
                                for stable_id in raw
                            }
                        except Exception:
                            pass
                    queue_mgr.register_client(own_client_id, json.dumps(own_active_locks))

                    # Cache remote lock state from other clients
                    try:
                        remote_client_locks = queue_mgr.get_all_client_locks(own_client_id)
                        merged_remote_locks: Dict[str, Any] = {}
                        for locks_json in remote_client_locks.values():
                            try:
                                client_locks = json.loads(locks_json) if locks_json else {}
                                merged_remote_locks.update(client_locks)
                            except (json.JSONDecodeError, TypeError):
                                pass
                        self.file_repo.set_remote_locks(merged_remote_locks)
                    except Exception as exc:
                        if self.logger:
                            self.logger.warning(f"Failed to cache remote locks (non-fatal): {exc}")

                    last_seq = int(
                        self.file_repo.get_sync_metadata("last_applied_seq") or "0"
                    )

                    pending_ops = queue_mgr.get_pending_ops(own_client_id, last_seq)
                    if self.logger:
                        self.logger.debug(
                            f"Pending ops from other clients: {len(pending_ops)} "
                            f"(since seq {last_seq})"
                        )

                    if pending_ops:
                        send_progress(30, f"Applying {len(pending_ops)} remote op(s)...")
                        self._apply_ops(pending_ops, summary, client_id)
                    else:
                        send_progress(30, "No remote changes")

                    own_ops = self._collect_own_ops(own_client_id, summary, client_id)
                    if self.logger:
                        self.logger.debug(f"Own ops to append: {len(own_ops)}")
                    if own_ops:
                        send_progress(60, f"Uploading {sum(1 for o in own_ops if o['op_type'] == 'upsert')} local change(s)...")
                    else:
                        send_progress(60, "No local changes to upload")
                    max_seq = queue_mgr.append_ops(own_ops)

                    queue_mgr.update_client_seq(own_client_id, max_seq)
                    queue_mgr.compact()

                    send_progress(90, "Uploading sync queue...")
                    queue_mgr.upload(queue_db_path)

                    self._set_remote_version(max_seq)
                    self.file_repo.set_sync_metadata("last_applied_seq", str(max_seq))
                    self.file_repo.set_sync_metadata(
                        "last_sync_time", datetime.now(timezone.utc).isoformat()
                    )
                    summary.new_version = max_seq

                finally:
                    queue_mgr.disconnect()

            finally:
                self._release_lock()

            send_progress(100, "Sync complete")

        except Exception as exc:
            if self.logger:
                self.logger.error(f"Sync failed: {exc}")
            summary.errors += 1
            raise

        finally:
            summary.duration_ms = int((time.time() - start_time) * 1000)

        return summary

    def sync_locks(self) -> None:
        """Push own current lock state to queue.db without a full sync.

        Downloads queue.db, updates this client's active_locks column, also
        reads other clients' lock state to refresh the local cache, then
        uploads.  No file transfers or op processing occurs.

        Skips silently if the sync lock cannot be acquired (another sync is
        already running).
        """
        _log = self.logger or __import__('logging').getLogger(__name__)
        if not self.db_dir:
            return
        if not self._acquire_lock(timeout_seconds=10):
            _log.debug("sync_locks: could not acquire sync lock, skipping")
            return
        try:
            own_client_id = self._get_or_create_client_id()

            raw = get_all_active_locks(self.db_dir, _log)
            now_iso = datetime.now(timezone.utc).isoformat()
            own_active_locks = {
                stable_id: {"acquired_at": now_iso, "updated_at": now_iso}
                for stable_id in raw
            }

            queue_mgr = RemoteQueueManager(self.webdav_config, self.logger)
            queue_db_path = queue_mgr.download()
            queue_mgr.connect(queue_db_path)
            try:
                queue_mgr.register_client(own_client_id, json.dumps(own_active_locks))

                # Refresh remote lock cache while we have the DB
                try:
                    remote_client_locks = queue_mgr.get_all_client_locks(own_client_id)
                    merged: Dict[str, Any] = {}
                    for locks_json in remote_client_locks.values():
                        try:
                            merged.update(json.loads(locks_json) if locks_json else {})
                        except (json.JSONDecodeError, TypeError):
                            pass
                    self.file_repo.set_remote_locks(merged)
                except Exception as exc:
                    _log.debug(f"sync_locks: remote cache refresh failed (non-fatal): {exc}")

                queue_mgr.upload(queue_db_path)
            finally:
                queue_mgr.disconnect()
        finally:
            self._release_lock()

    def get_conflicts(self) -> ConflictListResponse:
        """Get list of sync conflicts (SyncServiceBase interface)."""
        conflict_files = [
            f for f in self.file_repo.get_all_files() if f.sync_status == "conflict"
        ]
        conflicts = [
            ConflictInfo(
                file_id=f.id,
                stable_id=f.stable_id,
                filename=f.filename,
                doc_id=f.doc_id,
                local_modified_at=f.local_modified_at,
                local_hash=f.id,
                remote_modified_at=None,
                remote_hash=f.sync_hash,
                conflict_type="modified_both",
            )
            for f in conflict_files
        ]
        return ConflictListResponse(conflicts=conflicts, total=len(conflicts))

    def resolve_conflict(self, resolution: ConflictResolution) -> dict:
        """Resolve a sync conflict (SyncServiceBase interface)."""
        file_id = resolution.file_id

        if resolution.resolution == "local_wins":
            from fastapi_app.lib.models import SyncUpdate
            self.file_repo.update_sync_status(
                file_id, SyncUpdate(sync_status="modified", sync_hash=None)
            )
            return {"message": "Local version will be uploaded on next sync"}

        if resolution.resolution == "remote_wins":
            self.file_repo.mark_file_synced(file_id, 0)
            return {"message": "Remote version will be downloaded on next sync"}

        if resolution.resolution == "keep_both":
            if not resolution.new_variant:
                raise ValueError("new_variant required for keep_both resolution")
            return {"message": f"Created variant '{resolution.new_variant}' (not implemented)"}

        raise ValueError(f"Invalid resolution strategy: {resolution.resolution}")

    # ------------------------------------------------------------------
    # Op application
    # ------------------------------------------------------------------

    def _apply_ops(
        self,
        ops: List[Dict[str, Any]],
        summary: SyncSummary,
        client_id: Optional[str],
    ) -> None:
        """Apply a list of remote ops to the local database, downloading files as needed."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from .config import get_transfer_workers

        workers = get_transfer_workers()

        # Separate upserts from deletes so we can parallelise downloads.
        upserts = [op for op in ops if op["op_type"] == "upsert"]
        deletes = [op for op in ops if op["op_type"] == "delete"]

        # --- Downloads (parallel) ---
        if upserts:
            self._send_message(client_id, f"Downloading {len(upserts)} file(s)...")

        download_errors: Dict[str, Exception] = {}

        def _maybe_download(op: Dict[str, Any]) -> None:
            """Download file content only if we don't already have it locally."""
            file_id = op["file_id"]
            file_type = (json.loads(op["file_data"]) if op.get("file_data") else {}).get(
                "file_type", "tei"
            )
            local_path = get_storage_path(self.file_storage.data_root, file_id, file_type)
            if local_path.exists():
                return
            remote_path = self._get_remote_file_path(file_id, file_type)
            self._download_file(remote_path, local_path)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_maybe_download, op): op for op in upserts}
            for future in as_completed(futures):
                op = futures[future]
                try:
                    future.result()
                except Exception as exc:
                    download_errors[op["file_id"]] = exc
                    self._send_message(
                        client_id,
                        f"✕ {op.get('stable_id', op['file_id'][:8])}: {exc}",
                    )

        # --- Metadata (sequential) ---
        for op in upserts:
            file_id = op["file_id"]
            if file_id in download_errors:
                summary.errors += 1
                continue
            try:
                self._apply_upsert_op(op, summary, client_id)
            except Exception as exc:
                self._send_message(client_id, f"✕ {op.get('stable_id', file_id[:8])}: {exc}")
                if self.logger:
                    self.logger.error(f"Failed to apply upsert op {file_id[:8]}: {exc}")
                summary.errors += 1

        for op in deletes:
            try:
                self._apply_delete_op(op, summary, client_id)
            except Exception as exc:
                self._send_message(
                    client_id, f"✕ delete {op.get('stable_id', op['file_id'][:8])}: {exc}"
                )
                if self.logger:
                    self.logger.error(
                        f"Failed to apply delete op {op['file_id'][:8]}: {exc}"
                    )
                summary.errors += 1

    def _apply_upsert_op(
        self,
        op: Dict[str, Any],
        summary: SyncSummary,
        client_id: Optional[str],
    ) -> None:
        """Apply a single upsert op: insert/update local DB record."""
        file_id = op["file_id"]
        stable_id = op["stable_id"]
        file_data: Dict[str, Any] = json.loads(op["file_data"]) if op.get("file_data") else {}

        existing = self.file_repo.get_file_by_stable_id(stable_id, include_deleted=True)

        if existing is not None and existing.deleted:
            # Remote upsert always means "file should exist".  Regardless of
            # whether the content hash matches, un-delete the record and apply
            # the remote content/metadata.  File content was already downloaded
            # by _maybe_download if the hash changed.
            self.file_repo.restore_file(
                stable_id=stable_id,
                file_id=file_id,
                file_size=int(file_data.get("file_size") or existing.file_size or 0),
                remote_version=op["seq"],
            )
            self.file_repo.apply_remote_metadata(file_id, file_data)
            summary.downloaded += 1
            self._send_message(client_id, f"↓ {file_data.get('filename', stable_id[:8])} (restored)")
            if self.logger:
                self.logger.info(f"Restored remotely: {file_data.get('filename')}")
            return

        if existing is None:
            # Entirely new file
            file_create = FileCreate(
                id=file_id,
                stable_id=stable_id,
                filename=file_data.get("filename", ""),
                doc_id=file_data.get("doc_id", ""),
                doc_id_type=file_data.get("doc_id_type", "custom"),
                file_type=file_data.get("file_type", "tei"),
                file_size=file_data.get("file_size", 0),
                label=file_data.get("label"),
                variant=file_data.get("variant"),
                version=file_data.get("version"),
                is_gold_standard=bool(file_data.get("is_gold_standard", False)),
                doc_collections=_parse_json_field(file_data.get("doc_collections"), []),
                doc_metadata=_parse_json_field(file_data.get("doc_metadata"), {}),
                file_metadata=_parse_json_field(file_data.get("file_metadata"), {}),
                created_by=file_data.get("created_by"),
            )
            self.file_repo.insert_file(file_create)
            self.file_repo.mark_file_synced(file_id, op["seq"])
            summary.downloaded += 1
            self._send_message(client_id, f"↓ {file_data.get('filename', file_id[:8])}")
            if self.logger:
                self.logger.info(f"Downloaded: {file_data.get('filename')}")

        elif existing.id == file_id:
            # Same content; only metadata may have changed.
            self.file_repo.apply_remote_metadata(file_id, file_data)
            summary.metadata_synced += 1

        else:
            # Same logical file (stable_id), different content hash.
            if existing.sync_status == "synced":
                # Remote has a newer version — accept it.
                self.file_repo.apply_remote_metadata(existing.id, file_data)
                # Note: the new file_id content was already downloaded; update
                # the local record to point to the new hash.
                self._replace_local_file_hash(existing, file_id, file_data, op["seq"])
                summary.downloaded += 1
                self._send_message(
                    client_id, f"↓ {file_data.get('filename', stable_id[:8])} (updated)"
                )
            else:
                # Both sides modified the same file — conflict.
                self._mark_conflict(existing.id, op)
                summary.conflicts += 1
                self._send_message(
                    client_id,
                    f"⚠ conflict: {file_data.get('filename', stable_id[:8])}",
                )

    def _apply_delete_op(
        self,
        op: Dict[str, Any],
        summary: SyncSummary,
        client_id: Optional[str],
    ) -> None:
        """Apply a single delete op: soft-delete local record.

        Skips deletion if the file currently has an active lock (i.e. is open
        in the editor), and re-queues it for re-upload instead so the local
        version is preserved and propagated back to remote on the next sync.
        """
        file_id = op["file_id"]
        stable_id = op["stable_id"]

        local_file = self.file_repo.get_file_by_id(file_id, include_deleted=True)
        if local_file is None:
            local_file = self.file_repo.get_file_by_stable_id(stable_id, include_deleted=True)

        if local_file is None or local_file.deleted:
            return

        # Check whether this file is currently locked (being edited).
        if self.db_dir is not None:
            try:
                from fastapi_app.lib.core.locking import get_locked_file_ids
                locked = get_locked_file_ids(self.db_dir, self.logger or __import__('logging').getLogger(__name__))
                if local_file.stable_id in locked:
                    if self.logger:
                        self.logger.warning(
                            f"Remote deletion of {local_file.filename} rejected: "
                            f"file is currently locked (open in editor)"
                        )
                    self._send_message(
                        client_id,
                        f"⚠ {local_file.filename}: deleted remotely but open locally — kept, will re-upload"
                    )
                    # Mark as modified so it gets re-uploaded on next sync,
                    # overriding the remote deletion.
                    from fastapi_app.lib.models.models import SyncUpdate
                    self.file_repo.update_sync_status(
                        local_file.id,
                        SyncUpdate(sync_status="modified", sync_hash=None)
                    )
                    summary.conflicts += 1
                    return
            except Exception as exc:
                if self.logger:
                    self.logger.warning(f"Lock check failed (proceeding with deletion): {exc}")

        self.file_repo.delete_file(local_file.id)
        self.file_repo.mark_deletion_synced(local_file.id, op["seq"])
        summary.deleted_local += 1
        self._send_message(client_id, f"⊖ {local_file.filename}")
        if self.logger:
            self.logger.info(f"Applied remote deletion: {local_file.id[:8]}")

    # ------------------------------------------------------------------
    # Op collection
    # ------------------------------------------------------------------

    def _collect_own_ops(
        self,
        own_client_id: str,
        summary: SyncSummary,
        client_id: Optional[str],
    ) -> List[Dict[str, Any]]:
        """
        Build the list of ops to append to the log for this sync cycle.

        Uploads file content first (parallel), then assembles op records.
        Marks local files as synced/deletion_synced as ops are recorded.
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from .config import get_transfer_workers

        workers = get_transfer_workers()
        now = datetime.now(timezone.utc).isoformat()
        ops: List[Dict[str, Any]] = []

        # --- Upsert ops (new / modified files) ---
        to_upload = self.file_repo.get_files_to_upload()
        if self.logger:
            self.logger.debug(f"Files to upload: {len(to_upload)}")
        if to_upload:
            self._send_message(client_id, f"Uploading {len(to_upload)} file(s)...")

        remote_file_index = self._build_remote_file_index(to_upload) if to_upload else set()

        def _do_upload(local_file: Any) -> tuple:
            file_path = self.file_storage.get_file_path(
                local_file.id, local_file.file_type
            )
            if file_path is None or not file_path.exists():
                return local_file, FileNotFoundError(
                    f"File not on disk: {local_file.filename}"
                )
            remote_path = self._get_remote_file_path(local_file.id, local_file.file_type)
            if remote_path in remote_file_index:
                return local_file, None  # Already on remote — metadata-only op
            self._upload_file(file_path, remote_path)
            return local_file, None

        upload_errors: Dict[int, Exception] = {}
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_do_upload, f): f for f in to_upload}
            for future in as_completed(futures):
                local_file = futures[future]
                try:
                    _, err = future.result()
                    if err:
                        upload_errors[id(local_file)] = err
                        self._send_message(client_id, f"✕ {local_file.filename}: {err}")
                    else:
                        self._send_message(client_id, f"↑ {local_file.filename}")
                except Exception as exc:
                    upload_errors[id(local_file)] = exc
                    self._send_message(client_id, f"✕ {local_file.filename}: {exc}")

        for local_file in to_upload:
            err = upload_errors.get(id(local_file))
            if err is not None:
                if self.logger:
                    self.logger.error(f"Upload failed {local_file.filename}: {err}")
                summary.errors += 1
                continue
            ops.append({
                "client_id": own_client_id,
                "op_type": "upsert",
                "stable_id": local_file.stable_id,
                "file_id": local_file.id,
                "file_data": json.dumps(self._file_to_dict(local_file)),
                "created_at": now,
            })
            # Mark synced with seq=0 as placeholder; seq is assigned by
            # AUTOINCREMENT after append_ops().  The exact seq value is only
            # needed for conflict detection, which uses seq ordering — 0 is fine
            # as long as a later sync cycle updates the record normally.
            self.file_repo.mark_file_synced(local_file.id, 0)
            summary.uploaded += 1

        # --- Delete ops ---
        for deleted_file in self.file_repo.get_deleted_files():
            ops.append({
                "client_id": own_client_id,
                "op_type": "delete",
                "stable_id": deleted_file.stable_id,
                "file_id": deleted_file.id,
                "file_data": None,
                "created_at": now,
            })
            self.file_repo.mark_deletion_synced(deleted_file.id, 0)
            summary.deleted_remote += 1
            if self.logger:
                self.logger.info(f"Queued deletion: {deleted_file.id[:8]}")

        return ops

    # ------------------------------------------------------------------
    # Client identity
    # ------------------------------------------------------------------

    def _get_or_create_client_id(self) -> str:
        """
        Return this instance's sync client UUID.

        Stored in sync_metadata['sync_client_id'].  Generated once and
        persisted permanently.

        On first call (no stored ID), marks all existing synced files as
        'modified' so they are re-uploaded into the new operation log.  This
        one-time bootstrap ensures that instances migrating from the old
        metadata.db approach contribute their existing files to the queue.
        """
        stored = self.file_repo.get_sync_metadata("sync_client_id")
        if stored:
            return stored

        new_id = str(uuid.uuid4())
        self.file_repo.set_sync_metadata("sync_client_id", new_id)
        if self.logger:
            self.logger.info(f"Generated sync client ID: {new_id} — bootstrapping existing files into queue")

        # Re-queue all previously-synced files so they are uploaded as upsert
        # ops on this first sync cycle.  Without this, files synced under the
        # old metadata.db approach would be invisible to other instances.
        bootstrapped = self.file_repo.requeue_synced_files_for_bootstrap()
        if self.logger:
            self.logger.info(f"Bootstrap: re-queued {bootstrapped} synced file(s) for upload")

        return new_id

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _replace_local_file_hash(
        self,
        existing_file: Any,
        new_file_id: str,
        file_data: Dict[str, Any],
        seq: int,
    ) -> None:
        """
        Replace an existing local file record with a new content hash.

        Updates the id (PRIMARY KEY) in-place via update_file_content so the
        stable_id UNIQUE constraint is never violated.
        """
        try:
            self.file_repo.update_file_content(
                stable_id=existing_file.stable_id,
                new_file_id=new_file_id,
                new_file_size=int(file_data.get("file_size") or existing_file.file_size),
                remote_version=seq,
            )
            # Apply any metadata changes on top of the updated record.
            self.file_repo.apply_remote_metadata(new_file_id, file_data)
        except Exception as exc:
            if self.logger:
                self.logger.error(
                    f"Failed to replace local file hash for {existing_file.stable_id}: {exc}"
                )
            raise

    def _mark_conflict(self, file_id: str, op: Dict[str, Any]) -> None:
        """Mark a local file as conflicted."""
        try:
            from fastapi_app.lib.models import SyncUpdate
            self.file_repo.update_sync_status(
                file_id,
                SyncUpdate(sync_status="conflict", sync_hash=op["file_id"]),
            )
        except Exception as exc:
            if self.logger:
                self.logger.warning(f"Failed to mark conflict for {file_id[:8]}: {exc}")

    def _send_message(self, client_id: Optional[str], message: str) -> None:
        """Send a syncMessage SSE event."""
        if self.sse_service and client_id:
            self.sse_service.send_message(client_id, "syncMessage", message)

    def _get_remote_version(self) -> int:
        """Read the current max seq from version.txt."""
        version_path = f"{self.remote_root}/version.txt"
        try:
            if not self.fs.exists(version_path):
                return 0
            with self.fs.open(version_path, "r") as f:
                return int(f.read().strip())
        except Exception as exc:
            if self.logger:
                self.logger.error(f"Failed to get remote version: {exc}")
            raise

    def _set_remote_version(self, seq: int) -> None:
        """Write the current max seq to version.txt for quick-check use.

        Non-fatal: version.txt is only an optimistic skip-check. If it cannot
        be written after one retry, a warning is logged and sync continues.
        """
        version_path = f"{self.remote_root}/version.txt"
        for attempt in range(2):
            try:
                with self.fs.open(version_path, "w") as f:
                    f.write(str(seq))
                return
            except Exception as exc:
                if attempt == 0:
                    if self.logger:
                        self.logger.warning(
                            f"Failed to set remote version (retrying): {exc}"
                        )
                    time.sleep(2)
                else:
                    if self.logger:
                        self.logger.warning(
                            f"Failed to set remote version after retry, skipping: {exc}"
                        )

    def _acquire_lock(self, timeout_seconds: int = 300) -> bool:
        """Acquire sync lock on WebDAV."""
        start_time = time.time()

        try:
            if not self.fs.exists(self.remote_root):
                self.fs.makedirs(self.remote_root, exist_ok=True)
        except Exception as exc:
            if self.logger:
                self.logger.error(f"Failed to create remote root: {exc}")
            return False

        while time.time() - start_time < timeout_seconds:
            try:
                if self.fs.exists(self.lock_path):
                    info = self.fs.info(self.lock_path)
                    if info.get("modified"):
                        age = datetime.now(timezone.utc) - info["modified"]
                        if age.total_seconds() > 60:
                            self.fs.rm(self.lock_path)
                        else:
                            time.sleep(2)
                            continue

                with self.fs.open(self.lock_path, "w") as f:
                    f.write(
                        json.dumps({
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "host": "fastapi-instance",
                        })
                    )
                return True

            except Exception as exc:
                if self.logger:
                    self.logger.debug(f"Lock attempt failed: {exc}")
                time.sleep(2)

        return False

    def _release_lock(self) -> None:
        """Release sync lock."""
        try:
            if self.fs.exists(self.lock_path):
                self.fs.rm(self.lock_path)
        except Exception as exc:
            if self.logger:
                self.logger.warning(f"Failed to release lock: {exc}")

    def _build_remote_file_index(self, files: List[Any]) -> set:
        """
        Return a set of remote paths for the given files by listing each
        relevant shard directory once rather than issuing one EXISTS request
        per file.

        For N files spread across S distinct shards this is O(S) round trips
        instead of O(N).  In practice S ≤ 256 (2-char hex prefix) but is
        usually much smaller than N for typical collections.

        Args:
            files: Iterable of FileMetadata objects whose remote paths to check.

        Returns:
            Set of remote path strings that exist on the WebDAV server.
        """
        # For a small number of files, individual EXISTS checks are cheaper
        # than fetching a directory listing (each WebDAV round trip has fixed
        # overhead, and listing returns data we don't need).  The crossover is
        # roughly at the point where N individual requests cost more than one
        # listing request plus parsing: empirically ~10 files for a typical
        # internet WebDAV.
        if len(files) <= 10:
            existing: set = set()
            for f in files:
                remote_path = self._get_remote_file_path(f.id, f.file_type)
                try:
                    if self.fs.exists(remote_path):
                        existing.add(remote_path)
                except Exception:
                    pass
            return existing

        # For larger batches (e.g. bootstrap), try a single recursive
        # PROPFIND (Depth: infinity).  Servers that disable it return 403/400;
        # fall back to per-shard ls() in that case.
        try:
            return set(self.fs.find(self.remote_root))
        except Exception:
            pass

        shards: Dict[str, List[Any]] = {}
        for f in files:
            shards.setdefault(f.id[:2], [])

        existing = set()
        for shard in shards:
            shard_dir = f"{self.remote_root}/{shard}"
            try:
                if not self.fs.exists(shard_dir):
                    continue
                for entry in self.fs.ls(shard_dir, detail=False):
                    existing.add(entry)
            except Exception as exc:
                if self.logger:
                    self.logger.debug(f"Could not list shard {shard}: {exc}")
        return existing

    def _get_remote_file_path(self, file_id: str, file_type: str) -> str:
        """Return the WebDAV path for a file."""
        ext = get_file_extension(file_type)
        shard = file_id[:2]
        return f"{self.remote_root}/{shard}/{file_id}{ext}"

    def _upload_file(self, local_path: Path, remote_path: str) -> None:
        """Upload a file to WebDAV."""
        remote_dir = "/".join(remote_path.split("/")[:-1])
        if not self.fs.exists(remote_dir):
            self.fs.makedirs(remote_dir)
        with open(local_path, "rb") as lf:
            with self.fs.open(remote_path, "wb") as rf:
                shutil.copyfileobj(lf, rf)

    def _download_file(self, remote_path: str, local_path: Path) -> None:
        """Download a file from WebDAV."""
        local_path.parent.mkdir(parents=True, exist_ok=True)
        with self.fs.open(remote_path, "rb") as rf:
            with open(local_path, "wb") as lf:
                shutil.copyfileobj(rf, lf)

    # Fields that must NOT be propagated to other instances — they represent
    # local state or are managed automatically by the DB.
    _LOCAL_ONLY_FIELDS = frozenset({
        "sync_status", "sync_hash", "local_modified_at",
        "created_at", "updated_at",
    })

    def _file_to_dict(self, file_metadata: Any) -> Dict[str, Any]:
        """
        Convert a FileMetadata Pydantic model to a JSON-serialisable dict,
        including all syncable fields and excluding local-only state.
        """
        data = file_metadata.model_dump(exclude=self._LOCAL_ONLY_FIELDS)
        # Pydantic may return datetime objects; convert them for json.dumps.
        return {
            k: v.isoformat() if hasattr(v, "isoformat") else v
            for k, v in data.items()
        }
