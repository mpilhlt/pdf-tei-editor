from flask import Blueprint, request
import os
import unicodedata
import time
import json
import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from webdav4.fsspec import WebdavFileSystem

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError, get_session_id
from server.lib.locking import purge_stale_locks
from server.lib.cache_manager import is_sync_needed, mark_sync_completed
from server.lib import auth
from server.api.sse import send_sse_message

logger = logging.getLogger(__name__)
bp = Blueprint("files", __name__, url_prefix="/api/files")

# Constants for sync versioning
VERSION_FILENAME = "version.txt"
VERSION_LOCK_FILENAME = "version.txt.lock"
LOCAL_VERSION_FILENAME = ".version"

def _send_progress_update(client_id: str, progress: int, logger):
    """Send progress update via SSE"""
    send_sse_message(client_id, "syncProgress", str(progress))

def _send_sync_message(client_id: str, message: str, logger):
    """Send sync message via SSE"""
    send_sse_message(client_id, "syncMessage", message)

def _get_client_id():
    """Get the current client ID from the session"""
    try:
        session_id = get_session_id(request)
        # Use session_id as client_id to match SSE message queue keys
        return session_id
    except:
        return None

def _get_version_path(remote_root: str) -> str:
    """Get the remote path for the version file."""
    return f"{remote_root.rstrip('/')}/{VERSION_FILENAME}"

def _get_version_lock_path(remote_root: str) -> str:
    """Get the remote path for the version lock file."""
    return f"{remote_root.rstrip('/')}/{VERSION_LOCK_FILENAME}"

def _acquire_version_lock(fs: WebdavFileSystem, remote_root: str, timeout_seconds: int = 300) -> bool:
    """
    Acquire a sync lock by creating a lock file on the remote server.
    
    Args:
        fs: WebDAV filesystem instance
        remote_root: Remote root directory
        timeout_seconds: Maximum time to wait for lock acquisition
        
    Returns:
        True if lock acquired, False if timeout or error
    """
    lock_path = _get_version_lock_path(remote_root)
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
                        logger.debug(f"Sync lock age: {lock_age} (threshold: 1 minute)")
                        if lock_age.total_seconds() > 60:  # 1 minute
                            logger.warning(f"Removing stale sync lock (age: {lock_age})")
                            _retry_operation(fs.rm, lock_path)
                        else:
                            logger.debug(f"Sync lock exists and is recent (age: {lock_age}), waiting...")
                            time.sleep(2)
                            continue
                except Exception as e:
                    logger.warning(f"Could not check lock file age: {e}")
                    time.sleep(2)
                    continue
            
            # Try to create the lock file
            lock_json = json.dumps(lock_content, indent=2)
            with fs.open(lock_path, 'w') as f:
                f.write(lock_json)
            
            logger.debug(f"Sync lock acquired: {lock_path}")
            return True
            
        except Exception as e:
            logger.debug(f"Failed to acquire sync lock: {e}")
            time.sleep(2)
    
    logger.error(f"Failed to acquire sync lock within {timeout_seconds} seconds")
    return False

def _release_version_lock(fs: WebdavFileSystem, remote_root: str):
    """Release the sync lock by removing the lock file."""
    lock_path = _get_version_lock_path(remote_root)
    try:
        if fs.exists(lock_path):
            _retry_operation(fs.rm, lock_path)
            logger.debug(f"Sync lock released: {lock_path}")
    except Exception as e:
        logger.warning(f"Failed to release sync lock: {e}")

def _get_remote_version(fs: WebdavFileSystem, remote_root: str) -> int:
    """
    Retrieve the version number from the remote server.
    If the version file does not exist, it is created with version 1.
    """
    version_path = _get_version_path(remote_root)
    try:
        if not fs.exists(version_path):
            logger.info("Version file not found on remote. Creating with version 1.")
            with fs.open(version_path, 'w') as f:
                f.write("1")
            return 1
        
        with fs.open(version_path, 'r') as f:
            version = int(f.read().strip())
        
        logger.debug(f"Retrieved remote version: {version}")
        return version
        
    except Exception as e:
        logger.error(f"Failed to retrieve or create remote version: {e}")
        raise ApiError(f"Failed to retrieve or create remote version: {e}")

def _increment_remote_version(fs: WebdavFileSystem, remote_root: str) -> int:
    """
    Increment the version number on the remote server.
    """
    version_path = _get_version_path(remote_root)
    try:
        # It's crucial that this operation is atomic, which the lock should ensure.
        current_version = _get_remote_version(fs, remote_root)
        new_version = current_version + 1
        
        with fs.open(version_path, 'w') as f:
            f.write(str(new_version))
            
        logger.info(f"Incremented remote version to {new_version}")
        return new_version
        
    except Exception as e:
        logger.error(f"Failed to increment remote version: {e}")
        raise ApiError(f"Failed to increment remote version: {e}")

def _get_local_version(local_root: str) -> int:
    """
    Retrieve the version number from the local cache file.
    Returns 0 if the file does not exist.
    """
    local_version_path = os.path.join(local_root, LOCAL_VERSION_FILENAME)
    try:
        if not os.path.exists(local_version_path):
            return 0
        
        with open(local_version_path, 'r') as f:
            version = int(f.read().strip())
        
        logger.debug(f"Retrieved local version: {version}")
        return version
        
    except (IOError, ValueError) as e:
        logger.warning(f"Could not read local version file, assuming 0: {e}")
        return 0

def _set_local_version(local_root: str, version: int):
    """
    Update the local version cache file.
    """
    local_version_path = os.path.join(local_root, LOCAL_VERSION_FILENAME)
    try:
        with open(local_version_path, 'w') as f:
            f.write(str(version))
        logger.debug(f"Set local version to {version}")
    except IOError as e:
        logger.error(f"Failed to update local version file: {e}")
        # This is not a critical error, but should be logged.




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
            logger.debug(f"Attempt {attempt + 1}/{max_attempts} with timeout {timeout}s")
            
            # Set timeout for webdav operations if applicable
            if hasattr(operation, '__self__') and hasattr(operation.__self__, 'session'):
                operation.__self__.session.timeout = timeout
            
            return operation(*args, **kwargs)
            
        except Exception as e:
            last_exception = e
            error_msg = str(e).lower()
            
            # Check if it's a timeout-related error
            if any(keyword in error_msg for keyword in ['timeout', 'timed out', 'connection timeout']):
                logger.warning(f"Attempt {attempt + 1} failed with timeout (timeout={timeout}s): {e}")
                if attempt < max_attempts - 1:
                    logger.info(f"Retrying in 5 seconds...")
                    time.sleep(5)  # Brief pause between retries
                    continue
            else:
                # Non-timeout error, don't retry
                logger.error(f"Non-timeout error on attempt {attempt + 1}: {type(e).__name__}: {e}")
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
                logger.warning(f"Conflict detected: Both a file and its deletion marker exist for '{original_name}' locally. Resolving by comparing modification times.")
                
                try:
                    existing_mtime_ts = os.path.getmtime(os.path.join(root_path, local_map[original_name]['relative_path']))
                    existing_mtime_utc = datetime.fromtimestamp(existing_mtime_ts, tz=timezone.utc)
                    current_mtime_ts = os.path.getmtime(full_path)
                    current_mtime_utc = datetime.fromtimestamp(current_mtime_ts, tz=timezone.utc)
                    
                    # Keep the newer file, delete the older one
                    if current_mtime_utc > existing_mtime_utc:
                        # Current file is newer, remove the existing one
                        older_path = os.path.join(root_path, local_map[original_name]['relative_path'])
                        logger.info(f"Removing older {'deletion marker' if local_map[original_name]['is_deleted'] else 'file'}: {older_path}")
                        os.remove(older_path)
                        # Continue with current file (will be added below)
                    else:
                        # Existing file is newer, remove the current one
                        logger.info(f"Removing older {'deletion marker' if is_deleted else 'file'}: {full_path}")
                        os.remove(full_path)
                        continue  # Skip adding current file to map
                        
                except OSError as e:
                    logger.error(f"Could not resolve file conflict for '{original_name}': {e}")
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
                logger.warning(f"Could not read local file mtime '{full_path}': {e}")
    return local_map

def _get_remote_map(fs: WebdavFileSystem, root_path: str) -> dict:
    """Gathers metadata for all remote files and deletion markers."""
    remote_map = {}
    try:
        logger.info(f"Listing remote files from '{root_path}'")
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
            logger.warning(f"Conflict detected: Both a file and its deletion marker exist for '{original_name}' on the remote server. Resolving by comparing modification times.")
            
            try:
                existing_mtime = remote_map[original_name]['mtime']
                current_mtime = details.get('modified')
                
                if not existing_mtime or not current_mtime:
                    logger.warning(f"Cannot compare modification times for '{original_name}' (missing timestamps), keeping existing entry")
                    continue
                
                # Keep the newer file, delete the older one
                if current_mtime > existing_mtime:
                    # Current file is newer, remove the existing one
                    older_path = f"{root_path.rstrip('/')}/{remote_map[original_name]['relative_path']}"
                    logger.info(f"Removing older remote {'deletion marker' if remote_map[original_name]['is_deleted'] else 'file'}: {older_path}")
                    _retry_operation(fs.rm, older_path)
                    # Continue with current file (will be added below)
                else:
                    # Existing file is newer, remove the current one
                    current_path = f"{root_path.rstrip('/')}/{relative_path}"
                    logger.info(f"Removing older remote {'deletion marker' if is_deleted else 'file'}: {current_path}")
                    _retry_operation(fs.rm, current_path)
                    continue  # Skip adding current file to map
                    
            except Exception as e:
                logger.error(f"Could not resolve remote file conflict for '{original_name}': {e}")
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
    logger.info(f"Uploading '{local_path}' to '{remote_path}'")
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
    logger.debug(f"_perform_full_sync called with client_id='{client_id}'")
    summary = {
        "uploads": 0, "downloads": 0, "remote_deletes": 0,
        "local_deletes": 0, "conflicts_resolved": 0,
        "local_markers_cleaned_up": 0
    }

    # Send initial progress
    _send_progress_update(client_id, 0, logger)
    _send_sync_message(client_id, "Starting synchronization...", logger)

    local_map = _get_local_map(local_root)
    _send_progress_update(client_id, 20, logger)
    _send_sync_message(client_id, f"Found {len(local_map)} local files", logger)
    
    remote_map = _get_remote_map(fs, remote_root)
    _send_progress_update(client_id, 40, logger)
    _send_sync_message(client_id, f"Found {len(remote_map)} remote files", logger)
    
    all_paths = set(local_map.keys()) | set(remote_map.keys())
    total_files = len(all_paths)
    _send_sync_message(client_id, f"Processing {total_files} files for synchronization", logger)
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
        _send_progress_update(client_id, file_progress, logger)
        
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
                            _send_sync_message(client_id, message, logger)
                            local_file_path = str(Path(local_root) / file_info['relative_path'])
                            _download_and_align(fs, remote_path, local_file_path, remote_info['mtime'], logger)
                            os.remove(str(Path(local_root) / marker_info['relative_path'])) # Remove the old local .deleted marker
                            summary['downloads'] += 1
                        else: # Local file is newer, restore remotely.
                            message = f"Conflict: Local file '{path}' is newer than remote marker. Restoring remote file."
                            logger.info(message)
                            _send_sync_message(client_id, message, logger)
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
                        _send_sync_message(client_id, message, logger)
                        _upload_and_align(fs, local_path, remote_path, logger)
                        summary['uploads'] += 1
                    else: # Remote is newer
                        message = f"Remote file '{path}' is newer. Downloading."
                        logger.info(message)
                        _send_sync_message(client_id, message, logger)
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

    _send_progress_update(client_id, 100, logger)
    _send_sync_message(client_id, "Synchronization completed successfully", logger)
    
    return summary

def _download_and_align(fs: WebdavFileSystem, remote_path: str, local_path: str, remote_mtime: datetime, logger):
    """Downloads a file and sets the local mtime to match the remote mtime."""
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    
    # Use retry mechanism for the download operation
    logger.info(f"Downloading '{remote_path}' to '{local_path}'")
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
    Performs optimized bidirectional synchronization using a versioning system.
    Uses a remote version.txt file and locking to prevent unnecessary syncs and conflicts.
    """
    if os.environ.get('WEBDAV_ENABLED', 0) != "1":
        logger.info("WebDAV sync not enabled")
        return {"error": "WebDAV sync is not enabled."}

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

    # Check if sync is needed
    if not is_sync_needed():
        try:
            local_version = _get_local_version(local_root)
            remote_version = _get_remote_version(fs, remote_root)

            if local_version == remote_version:
                logger.info(f"Sync not needed. Local version: {local_version}, Remote version: {remote_version}")
                return {
                    "skipped": True,
                    "message": "No synchronization needed",
                    "stale_locks_purged": purged_count
                }

        except Exception as e:
            logger.warning(f"Could not check versions, proceeding with full sync: {e}")
    else:
        logger.info("Sync needed because local files have changed.")

    if not _acquire_version_lock(fs, remote_root):
        raise ApiError("Could not acquire sync lock - another sync may be in progress")

    try:
        # Re-check versions after acquiring lock
        local_version = _get_local_version(local_root)
        remote_version = _get_remote_version(fs, remote_root)

        if not is_sync_needed() and local_version == remote_version:
            logger.info(f"Sync not needed after acquiring lock. Local: {local_version}, Remote: {remote_version}")
            return {
                "skipped": True,
                "message": "No synchronization needed",
                "stale_locks_purged": purged_count
            }

        logger.info(f"Starting synchronization. Local version: {local_version}, Remote version: {remote_version}")
        
        client_id = _get_client_id()
        logger.debug(f"Retrieved client_id='{client_id}' for sync operation")
        
        summary = _perform_full_sync(fs, local_root, remote_root, keep_deleted_markers, logger, client_id)
        summary["stale_locks_purged"] = purged_count

        remote_changed = summary.get("uploads", 0) > 0 or summary.get("remote_deletes", 0) > 0
        if remote_changed:
            logger.info("Remote files changed, incrementing remote version.")
            new_remote_version = _increment_remote_version(fs, remote_root)
            _set_local_version(local_root, new_remote_version)
        else:
            # No remote changes, so local is just outdated. Set local to remote version.
            _set_local_version(local_root, remote_version)

        mark_sync_completed()
        logger.info(f"Synchronization complete. Summary: {summary}")
        return summary

    finally:
        _release_version_lock(fs, remote_root)