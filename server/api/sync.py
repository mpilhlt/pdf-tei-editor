from flask import Blueprint, jsonify, request, current_app
import os
import unicodedata
import time
from datetime import datetime, timezone
from webdav4.fsspec import WebdavFileSystem

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError
from server.lib.locking import purge_stale_locks

bp = Blueprint("files", __name__, url_prefix="/api/files")

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
                current_app.logger.error(f"Non-timeout error on attempt {attempt + 1}: {e}")
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
            relative_path = unicodedata.normalize('NFC', os.path.relpath(full_path, root_path))
            is_deleted = relative_path.endswith('.deleted')
            original_name = relative_path[:-len('.deleted')] if is_deleted else relative_path

            # Check for invalid state: both file and marker exist
            if original_name in local_map:
                raise ApiError(f"Invalid state: Both a file and its deletion marker exist for '{original_name}' locally.")

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
        raise ApiError(f"Failed to list remote files from '{root_path}': {e}")

    for details in all_files.values():
        basename = os.path.basename(details['name'])
        if basename.startswith('.') or basename.endswith('.lock') or details['type'] == 'directory':
            continue

        relative_path = unicodedata.normalize('NFC', os.path.relpath(details['name'], root_path))
        is_deleted = relative_path.endswith('.deleted')
        original_name = relative_path[:-len('.deleted')] if is_deleted else relative_path
        
        # Check for invalid state: both file and marker exist
        if original_name in remote_map:
            raise ApiError(f"Invalid state: Both a file and its deletion marker exist for '{original_name}' on the remote server.")
            
        mtime_utc = details.get('modified')

        remote_map[original_name] = {
            'relative_path': relative_path,
            'mtime': mtime_utc,
            'is_deleted': is_deleted,
        }
    return remote_map

def _upload_and_align(fs: WebdavFileSystem, local_path: str, remote_path: str, logger):
    """Uploads a file and aligns the local mtime with the new remote mtime."""
    _retry_operation(fs.mkdirs, os.path.dirname(remote_path), exist_ok=True)
    
    # Use retry mechanism for the upload operation
    logger.info(f"Uploading '{local_path}' to '{remote_path}' with retry mechanism")
    _retry_operation(fs.upload, local_path, remote_path)
    
    try:
        new_remote_info = _retry_operation(fs.info, remote_path)
        if new_remote_info.get('modified'):
            new_mtime_ts = new_remote_info['modified'].timestamp()
            os.utime(local_path, (os.stat(local_path).st_atime, new_mtime_ts))
    except Exception as e:
        raise ApiError(f"Failed to align mtime for local file '{local_path}' after upload: {e}")

def _download_and_align(fs: WebdavFileSystem, remote_path: str, local_path: str, remote_mtime: datetime, logger):
    """Downloads a file and sets the local mtime to match the remote mtime."""
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    
    # Use retry mechanism for the download operation
    logger.info(f"Downloading '{remote_path}' to '{local_path}' with retry mechanism")
    _retry_operation(fs.download, remote_path, local_path)
    
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
    Performs a robust bidirectional synchronization by aligning timestamps after transfers
    to prevent re-syncing of identical files. Also purges stale locks.
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
    logger = current_app.logger

    fs = WebdavFileSystem(
        os.environ['WEBDAV_HOST'],
        auth=(os.environ['WEBDAV_USER'], os.environ['WEBDAV_PASSWORD'])
    )
    
    summary = {
        "uploads": 0, "downloads": 0, "remote_deletes": 0,
        "local_deletes": 0, "conflicts_resolved": 0,
        "local_markers_cleaned_up": 0,
        "stale_locks_purged": purged_count
    }

    local_map = _get_local_map(local_root)
    remote_map = _get_remote_map(fs, remote_root)
    all_paths = set(local_map.keys()) | set(remote_map.keys())

    for path in all_paths:
        local_info = local_map.get(path)
        remote_info = remote_map.get(path)
        
        # Define paths consistently at the start of the loop
        local_path = os.path.join(local_root, local_info['relative_path']) if local_info else None
        remote_path = f"{remote_root.rstrip('/')}/{remote_info['relative_path']}" if remote_info else None
        
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
                            logger.info(f"Conflict: Remote file '{path}' is newer than local marker. Restoring local file.")
                            local_file_path = os.path.join(local_root, file_info['relative_path'])
                            _download_and_align(fs, remote_path, local_file_path, remote_info['mtime'], logger)
                            os.remove(os.path.join(local_root, marker_info['relative_path'])) # Remove the old local .deleted marker
                            summary['downloads'] += 1
                        else: # Local file is newer, restore remotely.
                            logger.info(f"Conflict: Local file '{path}' is newer than remote marker. Restoring remote file.")
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
                            local_marker_path = os.path.join(local_root, marker_info['relative_path'])
                            os.remove(local_path)
                            if keep_deleted_markers:
                                _download_and_align(fs, remote_path, local_marker_path, remote_info['mtime'], logger)
                            summary['local_deletes'] += 1

                # No conflict: Both are files, compare timestamps for updates.
                elif not local_info['is_deleted']:
                    if local_info['mtime'].replace(microsecond=0) == remote_info['mtime'].replace(microsecond=0):
                        continue
                    
                    if local_info['mtime'] > remote_info['mtime']:
                        logger.info(f"Local file '{path}' is newer. Uploading.")
                        _upload_and_align(fs, local_path, remote_path, logger)
                        summary['uploads'] += 1
                    else: # Remote is newer
                        logger.info(f"Remote file '{path}' is newer. Downloading.")
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
                        if 'versions' in container_dir.split(os.sep) and len(os.listdir(container_dir)) == 0:
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
                        local_path_dest = os.path.join(local_root, remote_info['relative_path'])
                        _download_and_align(fs, remote_path, local_path_dest, remote_info['mtime'], logger)
                        summary['downloads'] += 1
                    # If we don't keep markers, we do nothing. The file is already gone locally.
                    else:
                        logger.info(f"Ignoring remote marker for '{path}' as per configuration.")
                # Otherwise, it's a new remote file that needs to be downloaded.
                else:
                    logger.info(f"File '{path}' exists only remotely. Downloading.")
                    local_path_dest = os.path.join(local_root, remote_info['relative_path'])
                    _download_and_align(fs, remote_path, local_path_dest, remote_info['mtime'], logger)
                    summary['downloads'] += 1

        except Exception as e:
            raise ApiError(f"Failed to sync path '{path}': {e}")

    logger.info(f"Synchronization complete. Summary: {summary}")
    return summary