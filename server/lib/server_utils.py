import datetime
import os
from flask import current_app
import uuid
from webdav4.fsspec import WebdavFileSystem
from webdav4.client import Client
from datetime import datetime, timezone, timedelta
import io

class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.
    """
    pass


def make_timestamp():
    now = datetime.now()
    formatted_time = now.strftime("%Y-%m-%d %H:%M:%S")
    return formatted_time

def get_data_file_path(path):
    data_root = current_app.config["DATA_ROOT"]
    return os.path.join(data_root, safe_file_path(path))

def safe_file_path(file_path):
    """
    Removes any non-alphabetic leading characters for safety, and strips the "/data" prefix
    """
    
    while not file_path[0].isalpha():
        file_path = file_path[1:]
    if not file_path.startswith("data/"):
        raise ApiError("Invalid file path") 
    return file_path.removeprefix('data/')

def remove_obsolete_marker_if_exists(file_path, logger):
    """
    Checks for a .deleted marker corresponding to a file path and removes it if it exists.
    """
    marker_path = str(file_path) + ".deleted"
    if os.path.exists(marker_path):
        logger.info(f"Removing obsolete deletion marker at {marker_path} before writing file.")
        os.remove(marker_path)

#
# Locking mechanism
#

LOCK_TIMEOUT_SECONDS = 60

def get_webdav_client():
    """Initializes and returns a WebDAV client from environment variables."""
    if not current_app.config.get('WEBDAV_ENABLED'):
        return None
    return Client(
        base_url=os.environ['WEBDAV_HOST'],
        auth=(os.environ['WEBDAV_USER'], os.environ['WEBDAV_PASSWORD'])
    )

def get_lock_path(file_path):
    """Constructs the remote lock file path."""
    remote_root = os.environ['WEBDAV_REMOTE_ROOT']
    # We use the relative path of the file to create a unique lock file name
    lock_file_name = safe_file_path(file_path).replace('/', '_') + '.lock'
    return f"{remote_root.rstrip('/')}/locks/{lock_file_name}"

def is_lock_stale(lock_mtime):
    """Checks if a lock's modification time is older than the timeout."""
    if not lock_mtime:
        return True
    return (datetime.now(timezone.utc) - lock_mtime) > timedelta(seconds=LOCK_TIMEOUT_SECONDS)

def acquire_lock(file_path):
    """
    Tries to acquire a lock for a given file. Returns True on success, False on failure.
    Raises ApiError for configuration issues.
    """
    client = get_webdav_client()
    if not client:
        raise ApiError("WebDAV is not configured, cannot acquire lock.")

    lock_path = get_lock_path(file_path)
    session_id = current_app.config['SESSION_ID']
    
    try:
        # Atomically create the lock file. Fails if it already exists.
        client.upload_fileobj(io.BytesIO(session_id.encode('utf-8')), lock_path, overwrite=False)
        current_app.logger.info(f"Lock acquired for {file_path} by session {session_id}")
        return True
    except FileExistsError:
        # Lock exists. Check if it's ours or if it's stale.
        try:
            info = client.info(lock_path)
            existing_lock_id = client.download_fileobj(lock_path).read().decode('utf-8')
            
            if existing_lock_id == session_id:
                # It's our own lock, just refresh it.
                client.upload_fileobj(io.BytesIO(session_id.encode('utf-8')), lock_path, overwrite=True)
                current_app.logger.info(f"Refreshed own lock for {file_path}")
                return True

            if is_lock_stale(info.get('modified')):
                # Lock is stale, take it over.
                client.upload_fileobj(io.BytesIO(session_id.encode('utf-8')), lock_path, overwrite=True)
                current_app.logger.warning(f"Took over stale lock for {file_path} from session {existing_lock_id}")
                return True
            else:
                # Lock is held by another active session.
                current_app.logger.warning(f"Failed to acquire lock for {file_path}. Held by {existing_lock_id}.")
                return False
        except Exception as e:
            current_app.logger.error(f"Error checking existing lock for {file_path}: {e}")
            return False

def release_lock(file_path):
    """Releases the lock for a given file if it is held by the current session."""
    client = get_webdav_client()
    if not client:
        return # Silently fail if WebDAV is not on

    lock_path = get_lock_path(file_path)
    session_id = current_app.config['SESSION_ID']

    try:
        # Verify we own the lock before deleting
        info = client.info(lock_path)
        if info:
            existing_lock_id = client.download_fileobj(lock_path).read().decode('utf-8')
            if existing_lock_id == session_id:
                client.remove(lock_path)
                current_app.logger.info(f"Lock released for {file_path} by session {session_id}")
            else:
                current_app.logger.warning(f"Session {session_id} attempted to release a lock owned by {existing_lock_id}")
    except FileNotFoundError:
        # Lock already gone, which is fine.
        pass
    except Exception as e:
        current_app.logger.error(f"Error releasing lock for {file_path}: {e}")

def purge_stale_locks():
    """Removes all stale lock files from the WebDAV server."""
    client = get_webdav_client()
    if not client:
        return 0
        
    remote_root = os.environ['WEBDAV_REMOTE_ROOT']
    locks_dir = f"{remote_root.rstrip('/')}/locks/"
    
    try:
        # Ensure the locks directory exists
        client.mkdir(locks_dir)
    except FileExistsError:
        pass # Directory already exists
    except Exception as e:
        current_app.logger.error(f"Could not create remote locks directory '{locks_dir}': {e}")
        return 0

    purged_count = 0
    try:
        lock_files = client.ls(locks_dir, detail=True)
        for lock in lock_files:
            if lock['type'] == 'file' and is_lock_stale(lock.get('modified')):
                try:
                    client.remove(lock['name'])
                    current_app.logger.info(f"Purged stale lock file: {lock['name']}")
                    purged_count += 1
                except Exception as e:
                    current_app.logger.error(f"Failed to purge stale lock {lock['name']}: {e}")
    except FileNotFoundError:
        # No locks directory, nothing to purge.
        pass
    except Exception as e:
        current_app.logger.error(f"Error listing or purging stale locks: {e}")
    
    return purged_count

def get_all_active_locks():
    """Fetches all non-stale lock files and returns a map of locked_file_path -> session_id."""
    client = get_webdav_client()
    if not client:
        return {}

    remote_root = os.environ['WEBDAV_REMOTE_ROOT']
    locks_dir = f"{remote_root.rstrip('/')}/locks/"
    active_locks = {}

    try:
        lock_files = client.ls(locks_dir, detail=True)
        for lock in lock_files:
            if lock['type'] == 'file' and not is_lock_stale(lock.get('modified')):
                try:
                    session_id = client.download_fileobj(lock['name']).read().decode('utf-8')
                    # The lock file name is the original file path with slashes replaced by underscores
                    original_file_path = lock['name'].split('/')[-1].replace('_', '/').replace('.lock', '')
                    active_locks["/data/" + original_file_path] = session_id
                except Exception as e:
                    current_app.logger.error(f"Error reading lock file {lock['name']}: {e}")
    except FileNotFoundError:
        return {}
    except Exception as e:
        current_app.logger.error(f"Error listing active locks: {e}")
    
    return active_locks

def check_lock(file_path):
    """Checks if a single file is locked by another session."""
    active_locks = get_all_active_locks()
    session_id = current_app.config['SESSION_ID']
    
    if file_path in active_locks and active_locks[file_path] != session_id:
        return { "is_locked": True }
    
    return { "is_locked": False }