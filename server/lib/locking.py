import os
import io
import requests
from abc import ABC, abstractmethod
from datetime import datetime, timezone, timedelta
from pathlib import Path
from flask import current_app
from webdav4.client import Client, ResourceAlreadyExists, ResourceNotFound
from server.api.config import read_config

# a custom exception class is not needed since ApiError is defined in server_utils
from .server_utils import ApiError

LOCK_TIMEOUT_SECONDS = 30

class LockStorage(ABC):
    @abstractmethod
    def read(self, lock_path):
        pass

    @abstractmethod
    def write(self, lock_path, content, overwrite=True):
        pass

    @abstractmethod
    def delete(self, lock_path):
        pass

    @abstractmethod
    def exists(self, lock_path):
        pass
    
    @abstractmethod
    def get_mtime(self, lock_path):
        pass

    @abstractmethod
    def list_locks(self):
        pass

    @abstractmethod
    def mkdir(self):
        pass

class WebDavLockStorage(LockStorage):
    def __init__(self):
        self.client = Client(
            base_url=os.environ['WEBDAV_HOST'],
            auth=(os.environ['WEBDAV_USER'], os.environ['WEBDAV_PASSWORD'])
        )
        self.locks_dir = f"{os.environ['WEBDAV_REMOTE_ROOT'].rstrip('/')}/locks/"

    def read(self, lock_path):
        file_obj = io.BytesIO()
        self.client.download_fileobj(lock_path, file_obj)
        file_obj.seek(0)
        return file_obj.read().decode('utf-8')

    def write(self, lock_path, content, overwrite=True):
        lock_content = io.BytesIO(content.encode('utf-8'))
        self.client.upload_fileobj(lock_content, lock_path, overwrite=overwrite)

    def delete(self, lock_path):
        self.client.remove(lock_path)

    def exists(self, lock_path):
        return self.client.exists(lock_path)
    
    def get_mtime(self, lock_path):
        return self.client.info(lock_path).get('modified')

    def list_locks(self):
        return self.client.ls(self.locks_dir, detail=True)

    def mkdir(self):
        if not self.client.exists(self.locks_dir):
            self.client.mkdir(self.locks_dir)

class LocalLockStorage(LockStorage):
    def __init__(self):
        self.locks_dir = os.path.join(current_app.config["DATA_ROOT"], "locks")

    def read(self, lock_path):
        with open(lock_path, 'r') as f:
            return f.read()

    def write(self, lock_path, content, overwrite=True):
        if not overwrite and os.path.exists(lock_path):
            raise FileExistsError
        with open(lock_path, 'w') as f:
            f.write(content)

    def delete(self, lock_path):
        os.remove(lock_path)

    def exists(self, lock_path):
        return os.path.exists(lock_path)
    
    def get_mtime(self, lock_path):
        return datetime.fromtimestamp(os.path.getmtime(lock_path), tz=timezone.utc)

    def list_locks(self):
        return [
            {
                'name': os.path.join(self.locks_dir, f),
                'type': 'file',
                'modified': self.get_mtime(os.path.join(self.locks_dir, f))
            }
            for f in os.listdir(self.locks_dir)
        ]

    def mkdir(self):
        os.makedirs(self.locks_dir, exist_ok=True)

def get_lock_storage():
#    if current_app.config.get('WEBDAV_ENABLED'):
#        return WebDavLockStorage()
#    else:
    
    # always use local storage at the moment
    return LocalLockStorage()

def get_lock_path(file_path):
    """Constructs the lock file path."""
    from .server_utils import safe_file_path
    safe_path = safe_file_path(file_path)
    # Convert to POSIX format to ensure consistent path separators
    posix_path = Path(safe_path).as_posix()
    lock_file_name = posix_path.replace('/', '$$$') + '.lock'
    storage = get_lock_storage()
    return os.path.join(storage.locks_dir, lock_file_name)

def get_file_from_lock_path(lock_path):
    """Extracts the original file path from a lock file path."""
    lock_file_name = os.path.basename(lock_path)
    return "/data/" + lock_file_name.replace('$$$', '/').replace('.lock', '')



def is_lock_stale(lock_mtime):
    """Checks if a lock's modification time is older than the timeout."""
    if not lock_mtime:
        return True
    return (datetime.now(timezone.utc) - lock_mtime) > timedelta(seconds=LOCK_TIMEOUT_SECONDS)


def acquire_lock(file_path, session_id):
    """
    Tries to acquire a lock for a given file. Returns True on success, False on failure.
    Raises ApiError for configuration issues.
    """

    current_app.logger.debug(f"Acquiring lock for {file_path}")
    storage = get_lock_storage()

    # Ensure locks directory exists
    try:
        storage.mkdir()
    except Exception as e:
        current_app.logger.error(f"Could not create locks directory: {e}")
        raise RuntimeError(f"Could not create locks directory: {e}")

    lock_path = get_lock_path(file_path)

    def write_lock(overwrite=True):
        storage.write(lock_path, session_id, overwrite=overwrite)

    try:
        # Atomically create the lock file. Fails if it already exists.
        write_lock(overwrite=False)
        current_app.logger.info(f"Lock acquired for {file_path} by session {session_id}")
        return True
    except (ResourceAlreadyExists, FileExistsError, requests.exceptions.HTTPError):
        # Lock exists. Check if it's ours or if it's stale.
        try:
            existing_lock_id = storage.read(lock_path)

            if existing_lock_id == session_id:
                # It's our own lock, just refresh it.
                write_lock(overwrite=True)
                current_app.logger.info(f"Refreshed own lock for {file_path}")
                return True

            if not existing_lock_id or existing_lock_id =="" or is_lock_stale(storage.get_mtime(lock_path)):
                # Lock is empty or stale, take it over.
                write_lock(overwrite=True)
                current_app.logger.warning(f"Took over stale lock for {file_path} and session id {session_id} from session {existing_lock_id}")
                return True
            else:
                # Lock is held by another active session.
                current_app.logger.warning(f"Failed to acquire lock for {file_path} and session id {session_id}. Held by {existing_lock_id}.")
                return False
        except Exception as e:
            raise RuntimeError(f"Error checking existing lock for {file_path}: {e}")
            
        
def release_lock(file_path, session_id):
    """
    Releases the lock for a given file if it is held by the current session.

    Returns:
        dict: Structured response with status, action, and message
            - status: "success" or "error"
            - action: "released", "already_released", "not_owned"
            - message: Human-readable description
    """
    storage = get_lock_storage()

    # Ensure locks directory exists
    try:
        storage.mkdir()
    except Exception as e:
        current_app.logger.error(f"Could not create locks directory: {e}")
        raise RuntimeError(f"Could not create locks directory: {e}")

    lock_path = get_lock_path(file_path)

    try:
        if storage.exists(lock_path):
            existing_lock_id = storage.read(lock_path)
            if existing_lock_id == session_id:
                storage.delete(lock_path)
                current_app.logger.info(f"Lock released for {file_path} by session {session_id}")
                return {
                    "status": "success",
                    "action": "released",
                    "message": f"Lock successfully released for {file_path}"
                }
            else:
                # This is an unexpected state. Fail loudly.
                raise ApiError(f"Session {session_id} attempted to release a lock owned by {existing_lock_id}", status_code=409)
        else:
            # Lock doesn't exist, which is a success state (idempotent operation)
            current_app.logger.info(f"Attempted to release lock for {file_path}, but no lock exists (idempotent success)")
            current_app.logger.debug(f"Session {session_id} release attempt on unlocked file - this may indicate upstream logic issues")
            return {
                "status": "success",
                "action": "already_released",
                "message": f"Lock was already released for {file_path}"
            }
    except (FileNotFoundError, ResourceNotFound):
        # Lock already gone, which is a success state.
        current_app.logger.info(f"Attempted to release lock for {file_path}, but it was already gone.")
        return {
            "status": "success",
            "action": "already_released",
            "message": f"Lock was already released for {file_path}"
        }
    except Exception as e:
        message = f"Error releasing lock for {file_path}: {str(e)}"
        current_app.logger.error(message)
        # Re-raise
        e.args = (message,)
        raise
    

def purge_stale_locks():
    """Removes all stale lock files."""
    storage = get_lock_storage()
    try:
        storage.mkdir()
    except Exception as e:
        current_app.logger.error(f"Could not create locks directory: {e}")
        return 0

    purged_count = 0
    try:
        lock_files = storage.list_locks()
        for lock in lock_files:
            if lock['type'] == 'file' and is_lock_stale(lock.get('modified')):
                try:
                    storage.delete(lock['name'])
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
    storage = get_lock_storage()
    try:
        storage.mkdir()
    except Exception as e:
        current_app.logger.error(f"Could not create locks directory: {e}")
        return {}
        
    active_locks = {}

    try:
        lock_files = storage.list_locks()
        for lock in lock_files:
            if lock['type'] == 'file' and not is_lock_stale(lock.get('modified')):
                try:
                    lock_file_session_id = storage.read(lock['name'])
                    original_file_path = get_file_from_lock_path(lock['name'])
                    active_locks[original_file_path] = lock_file_session_id
                except Exception as e:
                    current_app.logger.error(f"Error reading lock file {lock['name']}: {e}")
    except FileNotFoundError:
        current_app.logger.warning(f"Could not find locks directory")
        return {}
    except Exception as e:
        raise e
    
    return active_locks

def check_lock(file_path, session_id):
    """Checks if a single file is locked by another session."""
    storage = get_lock_storage()

    # Ensure locks directory exists
    try:
        storage.mkdir()
    except Exception as e:
        current_app.logger.error(f"Could not create locks directory: {e}")
        return { "is_locked": False }  # Assume not locked if we can't check

    active_locks = get_all_active_locks()

    if file_path in active_locks and active_locks[file_path] != session_id:
        current_app.logger.debug(f"File is locked by another session: {active_locks[file_path]}")
        return { "is_locked": True }

    return { "is_locked": False }
