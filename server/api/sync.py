from flask import Blueprint, current_app, request
import os
import unicodedata
import time
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from webdav4.fsspec import WebdavFileSystem

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError, get_session_id
from server.lib.locking import purge_stale_locks
from server.lib.cache_manager import get_last_modified_datetime, get_last_synced_datetime, mark_last_synced
from server.lib import auth
from server.api.sse import send_sse_message

bp = Blueprint("files", __name__, url_prefix="/api/files")

# Constants for sync metadata
SYNC_METADATA_FILENAME = ".sync-metadata.json"
SYNC_LOCK_FILENAME = ".sync-metadata.lock"

def _send_progress_update(client_id: str, progress: int):
    """Send progress update via SSE"""
    if client_id:
        send_sse_message(client_id, "syncProgress", str(progress))

def _send_sync_message(client_id: str, message: str):
    """Send sync message via SSE"""
    if client_id:
        send_sse_message(client_id, "syncMessage", message)

def _get_client_id():
    """Get the current client ID from the session"""
    try:
        session_id = get_session_id(request)
        user = auth.get_user_by_session_id(session_id)
        return user.get('id', 'anonymous') if user else 'anonymous'
    except:
        return None

def _get_sync_metadata_path(remote_root: str) -> str:
    """Get the remote path for the sync metadata file."""
    return f"{remote_root.rstrip('/')}/{SYNC_METADATA_FILENAME}"

def _get_sync_lock_path(remote_root: str) -> str:
    """Get the remote path for the sync lock file."""
    return f"{remote_root.rstrip('/')}/{SYNC_LOCK_FILENAME}"

def _acquire_sync_lock(fs: WebdavFileSystem, remote_root: str, timeout_seconds: int = 300) -> bool:
    """
    Acquire a sync lock by creating a lock file on the remote server.
    
    Args:
        fs: WebDAV filesystem instance
        remote_root: Remote root directory
        timeout_seconds: Maximum time to wait for lock acquisition
        
    Returns:
        True if lock acquired, False if timeout or error
    """
    lock_path = _get_sync_lock_path(remote_root)
    lock_content = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
        "host": os.environ.get("HOSTNAME", "unknown")
    }
    
    start_time = time.time()
    
    while time.time() - start_time < timeout_seconds:
        try:
            # Check if lock file already exists
            if fs.exists(lock_path):
                # Check if the lock is stale (older than 10 minutes)
                try:
                    lock_info = _retry_operation(fs.info, lock_path)
                    if lock_info.get('modified'):
                        lock_age = datetime.now(timezone.utc) - lock_info['modified']
                        if lock_age.total_seconds() > 600:  # 10 minutes
                            current_app.logger.warning(f"Removing stale sync lock (age: {lock_age})")
                            _retry_operation(fs.rm, lock_path)
                        else:
                            current_app.logger.debug("Sync lock exists and is recent, waiting...")
                            time.sleep(2)
                            continue
                except Exception as e:
                    current_app.logger.warning(f"Could not check lock file age: {e}")
                    time.sleep(2)
                    continue
            
            # Try to create the lock file
            lock_json = json.dumps(lock_content, indent=2)
            with fs.open(lock_path, 'w') as f:
                f.write(lock_json)
            
            current_app.logger.debug(f"Sync lock acquired: {lock_path}")
            return True
            
        except Exception as e:
            current_app.logger.debug(f"Failed to acquire sync lock: {e}")
            time.sleep(2)
    
    current_app.logger.error(f"Failed to acquire sync lock within {timeout_seconds} seconds")
    return False

def _release_sync_lock(fs: WebdavFileSystem, remote_root: str):
    """Release the sync lock by removing the lock file."""
    lock_path = _get_sync_lock_path(remote_root)
    try:
        if fs.exists(lock_path):
            _retry_operation(fs.rm, lock_path)
            current_app.logger.debug(f"Sync lock released: {lock_path}")
    except Exception as e:
        current_app.logger.warning(f"Failed to release sync lock: {e}")

def _get_sync_metadata(fs: WebdavFileSystem, remote_root: str) -> dict:
    """
    Retrieve sync metadata from the remote server.
    
    Returns:
        Dictionary with sync metadata or empty dict if not found
    """
    metadata_path = _get_sync_metadata_path(remote_root)
    
    try:
        if not fs.exists(metadata_path):
            current_app.logger.debug("Sync metadata file does not exist")
            return {}
        
        with fs.open(metadata_path, 'r') as f:
            metadata = json.load(f)
        
        current_app.logger.debug(f"Retrieved sync metadata: {metadata}")
        return metadata
        
    except Exception as e:
        current_app.logger.warning(f"Failed to retrieve sync metadata: {e}")
        return {}

def _update_sync_metadata(fs: WebdavFileSystem, remote_root: str, local_last_modified: datetime, remote_last_modified: datetime, file_count: int):
    """
    Update the sync metadata file on the remote server.
    
    Args:
        fs: WebDAV filesystem instance
        remote_root: Remote root directory
        local_last_modified: Last modification time of local files
        remote_last_modified: Last modification time of remote files
        file_count: Total number of files synced
    """
    metadata_path = _get_sync_metadata_path(remote_root)
    
    # Create a simple checksum based on timestamps and file count
    checksum_data = f"{local_last_modified.isoformat()}{remote_last_modified.isoformat()}{file_count}"
    checksum = hashlib.md5(checksum_data.encode()).hexdigest()[:12]
    
    metadata = {
        "last_sync_timestamp": datetime.now(timezone.utc).isoformat(),
        "local_last_modified": local_last_modified.isoformat() if local_last_modified else None,
        "remote_last_modified": remote_last_modified.isoformat() if remote_last_modified else None,
        "file_count": file_count,
        "checksum": checksum
    }
    
    try:
        metadata_json = json.dumps(metadata, indent=2)
        with fs.open(metadata_path, 'w') as f:
            f.write(metadata_json)
        
        current_app.logger.debug(f"Updated sync metadata: {metadata}")
        
    except Exception as e:
        current_app.logger.error(f"Failed to update sync metadata: {e}")
        raise ApiError(f"Failed to update sync metadata: {e}")

def _needs_sync(fs: WebdavFileSystem, remote_root: str) -> tuple[bool, dict]:
    """
    Determine if synchronization is needed by comparing timestamps.
    
    Returns:
        Tuple of (needs_sync: bool, metadata: dict)
    """
    try:
        # Get remote sync metadata
        remote_metadata = _get_sync_metadata(fs, remote_root)
        
        if not remote_metadata:
            current_app.logger.debug("No remote metadata found, full sync needed")
            return True, {}
        
        # Get local cache status - we need both sync time and modification time
        local_last_synced = get_last_synced_datetime()
        local_last_modified = get_last_modified_datetime()
        
        if not local_last_synced:
            current_app.logger.debug("No local sync timestamp, full sync needed")
            return True, remote_metadata
        
        # If files have been modified since our last sync, we need to sync
        if local_last_modified and local_last_modified > local_last_synced:
            current_app.logger.debug("Local files modified since last sync, full sync needed")
            return True, remote_metadata
        
        # Parse remote timestamps
        remote_local_modified = remote_metadata.get("local_last_modified")
        remote_remote_modified = remote_metadata.get("remote_last_modified")
        
        if not remote_local_modified or not remote_remote_modified:
            current_app.logger.debug("Missing timestamp data in metadata, full sync needed")
            return True, remote_metadata
        
        remote_local_dt = datetime.fromisoformat(remote_local_modified)
        remote_remote_dt = datetime.fromisoformat(remote_remote_modified)
        
        # The key insight: if our last sync time is newer than both the remote-recorded
        # local and remote modification times, then nothing has changed since our last sync
        if (local_last_synced >= remote_local_dt and local_last_synced >= remote_remote_dt):
            # Double-check: ensure the remote metadata file itself hasn't been updated
            # by another client since our last sync
            try:
                # Parse the last sync timestamp from the metadata
                last_sync_remote = remote_metadata.get("last_sync_timestamp")
                if last_sync_remote:
                    last_sync_remote_dt = datetime.fromisoformat(last_sync_remote)
                    if local_last_synced >= last_sync_remote_dt:
                        current_app.logger.info("No sync needed - no changes detected since last sync")
                        return False, remote_metadata
                    
            except Exception as e:
                current_app.logger.warning(f"Could not check metadata timestamps: {e}")
        
        current_app.logger.debug("Sync needed - changes detected since last sync")
        return True, remote_metadata
        
    except Exception as e:
        current_app.logger.warning(f"Error checking sync necessity: {e}")
        return True, {}

def _retry_operation(operation, *args, max_attempts=3, base_timeout=30, **kwargs):
    """
    Retry an operation with exponentially increasing timeouts.
    
    Args:
        operation: The function to retry
        max_attempts: Maximum number of attempts (default: 3)
        base_timeout: Base timeout in seconds (default: 30)
        *args, **kwargs: Arguments to pass to the operation
    
    Returns:
        The result of the successful operation
        
    Raises:
        ApiError: If all attempts fail
    """
    last_exception = None
    
    for attempt in range(max_attempts):
        timeout = base_timeout * (2 ** attempt)  # Exponential backoff: 30s, 60s, 120s
        
        try:
            current_app.logger.debug(f"Attempt {attempt + 1}/{max_attempts} with timeout {timeout}s")
            
            # Set timeout for webdav operations if applicable
            if hasattr(operation, '__self__') and hasattr(operation.__self__, 'session'):
                operation.__self__.session.timeout = timeout
            
            return operation(*args, **kwargs)
            
        except Exception as e:
            last_exception = e
            error_msg = str(e).lower()
            
            # Check if it's a timeout-related error
            if any(keyword in error_msg for keyword in ['timeout', 'timed out', 'connection timeout']):
                current_app.logger.warning(f"Attempt {attempt + 1} failed with timeout (timeout={timeout}s): {e}")
                if attempt < max_attempts - 1:
                    current_app.logger.info(f"Retrying in 5 seconds...")
                    time.sleep(5)  # Brief pause between retries
                    continue
            else:
                # Non-timeout error, don't retry
                current_app.logger.error(f"Non-timeout error on attempt {attempt + 1}: {type(e).__name__}: {e}")
                raise e
    
    # All attempts failed with timeout
    raise ApiError(f"Operation failed after {max_attempts} attempts with increasing timeouts. Last error: {last_exception}")

def _get_local_map(root_path: str) -> dict:
    """Gathers metadata for all local files and deletion markers."""
    local_map = {}
    for dirpath, _, filenames in os.walk(root_path):
        if os.path.basename(dirpath) == "locks":
            continue
        for filename in filenames:
            if os.path.basename(filename).startswith('.'):
                continue
            full_path = os.path.join(dirpath, filename)
            relative_path = unicodedata.normalize('NFC', Path(full_path).relative_to(root_path).as_posix())
            is_deleted = relative_path.endswith('.deleted')
            original_name = relative_path[:-len('.deleted')] if is_deleted else relative_path

            # Handle conflict: both file and marker exist locally
            if original_name in local_map:
                current_app.logger.warning(f"Conflict detected: Both a file and its deletion marker exist for '{original_name}' locally. Resolving by comparing modification times.")
                
                try:
                    existing_mtime_ts = os.path.getmtime(os.path.join(root_path, local_map[original_name]['relative_path']))
                    existing_mtime_utc = datetime.fromtimestamp(existing_mtime_ts, tz=timezone.utc)
                    current_mtime_ts = os.path.getmtime(full_path)
                    current_mtime_utc = datetime.fromtimestamp(current_mtime_ts, tz=timezone.utc)
                    
                    # Keep the newer file, delete the older one
                    if current_mtime_utc > existing_mtime_utc:
                        # Current file is newer, remove the existing one
                        older_path = os.path.join(root_path, local_map[original_name]['relative_path'])
                        current_app.logger.info(f"Removing older {'deletion marker' if local_map[original_name]['is_deleted'] else 'file'}: {older_path}")
                        os.remove(older_path)
                        # Continue with current file (will be added below)
                    else:
                        # Existing file is newer, remove the current one
                        current_app.logger.info(f"Removing older {'deletion marker' if is_deleted else 'file'}: {full_path}")
                        os.remove(full_path)
                        continue  # Skip adding current file to map
                        
                except OSError as e:
                    current_app.logger.error(f"Could not resolve file conflict for '{original_name}': {e}")
                    raise ApiError(f"Could not resolve file conflict for '{original_name}': {e}")

            try:
                mtime_ts = os.path.getmtime(full_path)
                mtime_utc = datetime.fromtimestamp(mtime_ts, tz=timezone.utc)
                local_map[original_name] = {
                    'relative_path': relative_path,
                    'mtime': mtime_utc,
                    'is_deleted': is_deleted,
                }
            except OSError as e:
                current_app.logger.warning(f"Could not read local file mtime '{full_path}': {e}")
    return local_map

def _get_remote_map(fs: WebdavFileSystem, root_path: str) -> dict:
    """Gathers metadata for all remote files and deletion markers."""
    remote_map = {}
    try:
        current_app.logger.info(f"Listing remote files from '{root_path}' with retry mechanism")
        all_files = _retry_operation(fs.find, root_path, detail=True)
    except Exception as e:
        raise ApiError(f"Failed to list remote files from '{root_path}': {type(e).__name__}: {e}")

    for details in all_files.values():
        basename = os.path.basename(details['name'])
        if basename.startswith('.') or basename.endswith('.lock') or details['type'] == 'directory':
            continue

        relative_path = unicodedata.normalize('NFC', Path(details['name']).relative_to(root_path).as_posix())
        is_deleted = relative_path.endswith('.deleted')
        original_name = relative_path[:-len('.deleted')] if is_deleted else relative_path
        
        # Handle conflict: both file and marker exist on remote server
        if original_name in remote_map:
            current_app.logger.warning(f"Conflict detected: Both a file and its deletion marker exist for '{original_name}' on the remote server. Resolving by comparing modification times.")
            
            try:
                existing_mtime = remote_map[original_name]['mtime']
                current_mtime = details.get('modified')
                
                if not existing_mtime or not current_mtime:
                    current_app.logger.warning(f"Cannot compare modification times for '{original_name}' (missing timestamps), keeping existing entry")
                    continue
                
                # Keep the newer file, delete the older one
                if current_mtime > existing_mtime:
                    # Current file is newer, remove the existing one
                    older_path = f"{root_path.rstrip('/')}/{remote_map[original_name]['relative_path']}"
                    current_app.logger.info(f"Removing older remote {'deletion marker' if remote_map[original_name]['is_deleted'] else 'file'}: {older_path}")
                    _retry_operation(fs.rm, older_path)
                    # Continue with current file (will be added below)
                else:
                    # Existing file is newer, remove the current one
                    current_path = f"{root_path.rstrip('/')}/{relative_path}"
                    current_app.logger.info(f"Removing older remote {'deletion marker' if is_deleted else 'file'}: {current_path}")
                    _retry_operation(fs.rm, current_path)
                    continue  # Skip adding current file to map
                    
            except Exception as e:
                current_app.logger.error(f"Could not resolve remote file conflict for '{original_name}': {e}")
                raise ApiError(f"Could not resolve remote file conflict for '{original_name}': {e}")
            
        mtime_utc = details.get('modified')

        remote_map[original_name] = {
            'relative_path': relative_path,
            'mtime': mtime_utc,
            'is_deleted': is_deleted,
        }
    return remote_map

def _upload_and_align(fs: WebdavFileSystem, local_path: str, remote_path: str, logger):
    """Uploads a file and aligns the local mtime with the new remote mtime."""
    try:
        _retry_operation(fs.mkdirs, os.path.dirname(remote_path), exist_ok=True)
    except Exception as e:
        raise ApiError(f"Failed to create remote directory for '{remote_path}': {e}")
    
    # Use retry mechanism for the upload operation
    logger.info(f"Uploading '{local_path}' to '{remote_path}' with retry mechanism")
    try:
        # Check if local file exists before attempting upload
        if not os.path.exists(local_path):
            raise ApiError(f"Local file does not exist: '{local_path}'")
        _retry_operation(fs.upload, local_path, remote_path)
    except ApiError:
        raise  # Re-raise our own ApiErrors
    except Exception as e:
        raise ApiError(f"Failed to upload '{local_path}' to '{remote_path}': {type(e).__name__}: {e}")
    
    try:
        new_remote_info = _retry_operation(fs.info, remote_path)
        if new_remote_info.get('modified'):
            new_mtime_ts = new_remote_info['modified'].timestamp()
            os.utime(local_path, (os.stat(local_path).st_atime, new_mtime_ts))
    except Exception as e:
        raise ApiError(f"Failed to align mtime for local file '{local_path}' after upload: {e}")

def _perform_full_sync(fs: WebdavFileSystem, local_root: str, remote_root: str, keep_deleted_markers: bool, logger, client_id: str = None) -> dict:
    """
    Perform the actual file synchronization.
    
    Returns:
        Dictionary with sync summary statistics
    """
    summary = {
        "uploads": 0, "downloads": 0, "remote_deletes": 0,
        "local_deletes": 0, "conflicts_resolved": 0,
        "local_markers_cleaned_up": 0
    }

    # Send initial progress
    _send_progress_update(client_id, 0)
    _send_sync_message(client_id, "Starting synchronization...")

    local_map = _get_local_map(local_root)
    _send_progress_update(client_id, 20)
    _send_sync_message(client_id, f"Found {len(local_map)} local files")
    
    remote_map = _get_remote_map(fs, remote_root)
    _send_progress_update(client_id, 40)
    _send_sync_message(client_id, f"Found {len(remote_map)} remote files")
    
    all_paths = set(local_map.keys()) | set(remote_map.keys())
    total_files = len(all_paths)
    _send_sync_message(client_id, f"Processing {total_files} files for synchronization")
    processed_files = 0

    for path in all_paths:
        local_info = local_map.get(path)
        remote_info = remote_map.get(path)
        
        # Define paths consistently at the start of the loop
        # Convert relative paths to proper OS paths using pathlib to avoid separator mixups
        local_path = str(Path(local_root) / local_info['relative_path']) if local_info else None
        remote_path = f"{remote_root.rstrip('/')}/{remote_info['relative_path']}" if remote_info else None
        
        # Update progress (40% for initial scan, 50% for processing files)
        processed_files += 1
        file_progress = 40 + int((processed_files / total_files) * 50)
        _send_progress_update(client_id, file_progress)
        
        try:
            # Case 1: File/marker exists on both sides
            if local_info and remote_info:
                # Conflict: One is a file, the other is a deletion marker.
                if local_info['is_deleted'] != remote_info['is_deleted']:
                    summary['conflicts_resolved'] += 1
                    marker_info, file_info = (local_info, remote_info) if local_info['is_deleted'] else (remote_info, local_info)
                    
                    # Resolve conflict based on which is newer: the file update or the deletion.
                    if file_info['mtime'] > marker_info['mtime']:
                        # The file is newer than the deletion, so we restore the file.
                        if file_info == remote_info: # Remote file is newer, restore locally.
                            message = f"Conflict: Remote file '{path}' is newer than local marker. Restoring local file."
                            logger.info(message)
                            _send_sync_message(client_id, message)
                            local_file_path = str(Path(local_root) / file_info['relative_path'])
                            _download_and_align(fs, remote_path, local_file_path, remote_info['mtime'], logger)
                            os.remove(str(Path(local_root) / marker_info['relative_path'])) # Remove the old local .deleted marker
                            summary['downloads'] += 1
                        else: # Local file is newer, restore remotely.
                            message = f"Conflict: Local file '{path}' is newer than remote marker. Restoring remote file."
                            logger.info(message)
                            _send_sync_message(client_id, message)
                            remote_file_path = f"{remote_root.rstrip('/')}/{file_info['relative_path']}"
                            _upload_and_align(fs, local_path, remote_file_path, logger)
                            _retry_operation(fs.rm, remote_path) # Remove the old remote .deleted marker
                            summary['uploads'] += 1
                    else:
                        # The deletion marker is newer, so we propagate the deletion.
                        if marker_info == local_info: # Local marker is newer, delete remote file and replace with marker.
                            logger.info(f"Conflict: Local marker for '{path}' is newer. Deleting remote file.")
                            remote_marker_path = f"{remote_root.rstrip('/')}/{marker_info['relative_path']}"
                            _retry_operation(fs.rm, remote_path)
                            _upload_and_align(fs, local_path, remote_marker_path, logger)
                            summary['remote_deletes'] += 1
                            if not keep_deleted_markers:
                                logger.info(f"Removing local marker for '{path}' as per configuration.")
                                os.remove(local_path)
                                summary['local_markers_cleaned_up'] += 1
                        else: # Remote marker is newer, delete local file and replace with marker.
                            logger.info(f"Conflict: Remote marker for '{path}' is newer. Deleting local file.")
                            local_marker_path = str(Path(local_root) / marker_info['relative_path'])
                            os.remove(local_path)
                            if keep_deleted_markers:
                                _download_and_align(fs, remote_path, local_marker_path, remote_info['mtime'], logger)
                            summary['local_deletes'] += 1

                # No conflict: Both are files, compare timestamps for updates.
                elif not local_info['is_deleted']:
                    if local_info['mtime'].replace(microsecond=0) == remote_info['mtime'].replace(microsecond=0):
                        continue
                    
                    if local_info['mtime'] > remote_info['mtime']:
                        message = f"Local file '{path}' is newer. Uploading."
                        logger.info(message)
                        _send_sync_message(client_id, message)
                        _upload_and_align(fs, local_path, remote_path, logger)
                        summary['uploads'] += 1
                    else: # Remote is newer
                        message = f"Remote file '{path}' is newer. Downloading."
                        logger.info(message)
                        _send_sync_message(client_id, message)
                        _download_and_align(fs, remote_path, local_path, remote_info['mtime'], logger)
                        summary['downloads'] += 1

            # Case 2: Exists only locally.
            elif local_info and not remote_info:
                # If the local-only item is a deletion marker...
                if local_info['is_deleted']:
                    # If we keep markers, a local-only marker means the remote file was already
                    # deleted, but we keep it for safety. A future garbage collection can remove it.
                    if keep_deleted_markers:
                        logger.info(f"Keeping redundant local deletion marker for '{path}' as per configuration.")
                    # If we DON'T keep markers, this is an un-synced deletion. Upload the marker,
                    # then remove it locally.
                    else:
                        logger.info(f"Uploading marker for '{path}' and removing locally as per configuration.")
                        remote_marker_path = f"{remote_root.rstrip('/')}/{local_info['relative_path']}"
                        _upload_and_align(fs, local_path, remote_marker_path, logger)
                        summary['uploads'] += 1
                        os.remove(local_path)
                        summary['local_markers_cleaned_up'] += 1
                        # remove empty version directories
                        container_dir = os.path.dirname(local_path)
                        if 'versions' in Path(container_dir).parts and len(os.listdir(container_dir)) == 0:
                            logger.info(f"Removing empty version directory '{container_dir}' after marker upload.")
                            os.rmdir(container_dir)    
                # Otherwise, it's a new local file that needs to be uploaded.
                else:
                    logger.info(f"File '{path}' exists only locally. Uploading.")
                    remote_path_dest = f"{remote_root.rstrip('/')}/{local_info['relative_path']}"
                    _upload_and_align(fs, local_path, remote_path_dest, logger)
                    summary['uploads'] += 1

            # Case 3: Exists only remotely, needs to be downloaded or handled.
            elif remote_info and not local_info:
                # If the remote-only item is a deletion marker...
                if remote_info['is_deleted']:
                    # If we are keeping markers, we need to create one locally to match.
                    if keep_deleted_markers:
                        logger.info(f"Marker for '{path}' exists only remotely. Creating local marker.")
                        local_path_dest = str(Path(local_root) / remote_info['relative_path'])
                        _download_and_align(fs, remote_path, local_path_dest, remote_info['mtime'], logger)
                        summary['downloads'] += 1
                    # If we don't keep markers, we do nothing. The file is already gone locally.
                    else:
                        logger.debug(f"Ignoring remote marker for '{path}' as per configuration.")
                # Otherwise, it's a new remote file that needs to be downloaded.
                else:
                    logger.info(f"File '{path}' exists only remotely. Downloading.")
                    local_path_dest = str(Path(local_root) / remote_info['relative_path'])
                    _download_and_align(fs, remote_path, local_path_dest, remote_info['mtime'], logger)
                    summary['downloads'] += 1

        except Exception as e:
            logger.error(f"Sync error for path '{path}': {type(e).__name__}: {e}")
            logger.error(f"  Local info: {local_info}")
            logger.error(f"  Remote info: {remote_info}")
            logger.error(f"  Local path: {local_path}")
            logger.error(f"  Remote path: {remote_path}")
            raise ApiError(f"Failed to sync path '{path}': {type(e).__name__}: {e}")

    # Calculate timestamps for metadata update
    local_last_modified = datetime.now(timezone.utc)
    remote_last_modified = datetime.now(timezone.utc)
    
    # If we have local files, get the latest modification time
    if local_map:
        local_times = [info['mtime'] for info in local_map.values() if info['mtime']]
        if local_times:
            local_last_modified = max(local_times)
    
    # If we have remote files, get the latest modification time
    if remote_map:
        remote_times = [info['mtime'] for info in remote_map.values() if info['mtime']]
        if remote_times:
            remote_last_modified = max(remote_times)
    
    # Update sync metadata
    _send_progress_update(client_id, 95)
    _send_sync_message(client_id, "Updating sync metadata...")
    total_files = len(all_paths)
    _update_sync_metadata(fs, remote_root, local_last_modified, remote_last_modified, total_files)
    
    # Mark when this sync completed successfully
    mark_last_synced()
    
    _send_progress_update(client_id, 100)
    _send_sync_message(client_id, "Synchronization completed successfully")
    
    return summary

def _download_and_align(fs: WebdavFileSystem, remote_path: str, local_path: str, remote_mtime: datetime, logger):
    """Downloads a file and sets the local mtime to match the remote mtime."""
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    
    # Use retry mechanism for the download operation
    logger.info(f"Downloading '{remote_path}' to '{local_path}' with retry mechanism")
    try:
        # Check if remote file exists before attempting download
        if not fs.exists(remote_path):
            raise ApiError(f"Remote file does not exist: '{remote_path}'")
        _retry_operation(fs.download, remote_path, local_path)
    except ApiError:
        raise  # Re-raise our own ApiErrors
    except Exception as e:
        raise ApiError(f"Failed to download '{remote_path}' to '{local_path}': {type(e).__name__}: {e}")
    
    if remote_mtime:
        try:
            mtime_ts = remote_mtime.timestamp()
            os.utime(local_path, (os.stat(local_path).st_atime, mtime_ts))
        except Exception as e:
            raise ApiError(f"Failed to align mtime for local file '{local_path}' after download: {e}")

@bp.route("/sync", methods=["GET"])
@handle_api_errors
@session_required
def sync():
    """
    Performs optimized bidirectional synchronization with quick change detection.
    Uses remote metadata file and locking to prevent unnecessary syncs and conflicts.
    """
    
    logger = current_app.logger
    
    if os.environ.get('WEBDAV_ENABLED', 0) != "1":
        logger.info("WebDAV sync not enabled")
        return {"error": "WebDAV sync is not enabled."}
    
    # Purge stale locks before starting the sync process
    purged_count = purge_stale_locks()
    if purged_count > 0:
        logger.info(f"Purged {purged_count} stale lock(s).")

    keep_deleted_markers = os.environ.get('WEBDAV_KEEP_DELETED', '0') == '1'
    local_root = os.environ['WEBDAV_LOCAL_ROOT']
    remote_root = os.environ['WEBDAV_REMOTE_ROOT']

    fs = WebdavFileSystem(
        os.environ['WEBDAV_HOST'],
        auth=(os.environ['WEBDAV_USER'], os.environ['WEBDAV_PASSWORD'])
    )
    
    # Quick check: do we need to sync at all?
    try:
        needs_sync, _ = _needs_sync(fs, remote_root)
        if not needs_sync:
            logger.info("Sync skipped - no changes detected")
            return {
                "skipped": True,
                "message": "No synchronization needed",
                "stale_locks_purged": purged_count
            }
    except Exception as e:
        logger.warning(f"Quick sync check failed, proceeding with full sync: {e}")
    
    # Acquire sync lock to prevent concurrent syncs
    if not _acquire_sync_lock(fs, remote_root):
        raise ApiError("Could not acquire sync lock - another sync may be in progress")
    
    try:
        logger.info("Starting full synchronization")
        
        # Get client ID for SSE messages
        client_id = _get_client_id()
        
        # Perform the actual synchronization
        summary = _perform_full_sync(fs, local_root, remote_root, keep_deleted_markers, logger, client_id)
        summary["stale_locks_purged"] = purged_count
        
        logger.info(f"Synchronization complete. Summary: {summary}")
        return summary
        
    finally:
        # Always release the sync lock
        _release_sync_lock(fs, remote_root)