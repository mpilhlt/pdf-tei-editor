from datetime import datetime
import os
import json
import re
from pathlib import Path
from flask import current_app
import logging

class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.

    Attributes:
        message -- explanation of the error
        status_code -- the HTTP (or other) status code associated with the error
        
    """
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def make_timestamp():
    now = datetime.now()
    formatted_time = now.strftime("%Y-%m-%d %H:%M:%S")
    return formatted_time

def make_version_timestamp():
    """Create a timestamp formatted for version filenames (safe for filesystem)"""
    return make_timestamp().replace(" ", "_").replace(":", "-")

# Version timestamp format constants - keep these in sync!
# Format: YYYY-MM-DD_HH-MM-SS (example: 2024-01-01_12-00-00)
VERSION_TIMESTAMP_REGEX = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-')

def strip_version_timestamp_prefix(filename):
    """Remove version timestamp prefix from filename if present."""
    return VERSION_TIMESTAMP_REGEX.sub('', filename)


def get_data_file_path(path):
    data_root = current_app.config["DATA_ROOT"]
    return os.path.join(data_root, safe_file_path(path))


def resolve_document_identifier(path_or_hash) -> str | None:
    """
    Resolve a document identifier that can be either a file path (starts with /data/) or a hash.
    
    Args:
        path_or_hash (str): Either a file path starting with "/data/" or a hash string
        
    Returns:
        str: The resolved file path (always starts with "/data/") or None if the hash does not resolve
        
    Raises:
        ApiError: If hash cannot be resolved or identifier is invalid
    """
    from server.lib.hash_utils import resolve_hash_to_path
    
    if not path_or_hash:
        raise ApiError("Document identifier is empty", status_code=400)
    
    # If it starts with /data/, it's already a path
    if path_or_hash.startswith('/data/'):
        return path_or_hash
    
    # Otherwise, treat it as a hash and resolve it
    try:
        resolved_path = resolve_hash_to_path(path_or_hash)
        return f"/data/{resolved_path}" if resolved_path else None
    except KeyError:
        raise ApiError(f"Hash '{path_or_hash}' not found in lookup table", status_code=404)


def safe_file_path(file_path):
    """
    Removes any non-alphabetic leading characters for safety, strips the "/data" prefix,
    and replaces filesystem-incompatible characters with underscores in directory and filenames
    """
    if not file_path:
        raise ApiError("Invalid file path: path is empty", status_code=400)
    
    while len(file_path) > 0 and not file_path[0].isalpha():
        file_path = file_path[1:]
    if not file_path.startswith("data/"):
        raise ApiError(f"Invalid file path: {file_path}", status_code=400)
    
    # Remove the 'data/' prefix
    cleaned_path = file_path.removeprefix('data/')
    
    # Split path into components, sanitize each component, then rejoin
    path_parts = cleaned_path.split('/')
    sanitized_parts = []
    
    for part in path_parts:
        if part:  # Skip empty parts
            # Replace characters incompatible with Windows/POSIX filesystems
            # Windows forbidden: < > : " | ? * and control chars (0-31)
            # Also replace other problematic characters
            sanitized_part = ''
            for char in part:
                if char in '%<>:"|?*\\' or ord(char) < 32:
                    sanitized_part += '_'
                else:
                    sanitized_part += char
            sanitized_parts.append(sanitized_part)
    
    return '/'.join(sanitized_parts)

def get_session_id(request):
    """
    Retrieves the session ID from request cookies, falling back to headers,
    and finally to query parameters.
    """
    # 1. Try cookies (new standard method)
    session_id = request.cookies.get('sessionId')
    if session_id:
        return session_id
    
    # 2. Fall back to headers (legacy method)
    session_id = request.headers.get('X-Session-ID')
    if session_id:
        return session_id

    # 3. Fall back to query parameters (for EventSource)
    return request.args.get('session_id')


def remove_obsolete_marker_if_exists(file_path, logger):
    """
    Checks for a .deleted marker corresponding to a file path and removes it if it exists.
    """
    marker_path = str(file_path) + ".deleted"
    if os.path.exists(marker_path):
        logger.info(f"Removing obsolete deletion marker at {marker_path} before writing file.")
        os.remove(marker_path)


def get_version_path(file_id, timestamp=None, file_extension=".tei.xml"):
    """
    Computes the relative path for a version file in the new structure.
    
    Args:
        file_id (str): The file identifier
        timestamp (str, optional): Timestamp string. If None, uses current timestamp
        file_extension (str): File extension to use (default: .tei.xml)
    
    Returns:
        str: Relative path like "versions/file-id/timestamp-file-id.tei.xml"
    """
    if timestamp is None:
        timestamp = make_timestamp().replace(" ", "_").replace(":", "-")
    return Path("versions", file_id, f"{timestamp}-{file_id}{file_extension}").as_posix()


def get_version_full_path(file_id, data_root, timestamp=None, file_extension=".tei.xml"):
    """
    Computes the full absolute path for a version file in the new structure.
    
    Args:
        file_id (str): The file identifier
        data_root (str): Root data directory path
        timestamp (str, optional): Timestamp string. If None, uses current timestamp
        file_extension (str): File extension to use (default: .tei.xml)
    
    Returns:
        str: Full absolute path
    """
    rel_path = get_version_path(file_id, timestamp, file_extension)
    return os.path.join(data_root, rel_path)


def get_old_version_path(file_id, timestamp, file_extension=".xml"):
    """
    Computes the relative path for a version file in the old structure.
    This is used for migration purposes to find and clean up old version files.
    
    Args:
        file_id (str): The file identifier
        timestamp (str): Timestamp string
        file_extension (str): File extension to use (default: .xml)
    
    Returns:
        str: Relative path like "versions/timestamp/file-id.xml"
    """
    return Path("versions", timestamp, f"{file_id}{file_extension}").as_posix()


def get_old_version_full_path(file_id, data_root, timestamp, file_extension=".xml"):
    """
    Computes the full absolute path for a version file in the old structure.
    This is used for migration purposes to find and clean up old version files.
    
    Args:
        file_id (str): The file identifier
        data_root (str): Root data directory path
        timestamp (str): Timestamp string
        file_extension (str): File extension to use (default: .xml)
    
    Returns:
        str: Full absolute path
    """
    rel_path = get_old_version_path(file_id, timestamp, file_extension)
    return os.path.join(data_root, rel_path)


# no longer needed
def migrate_old_version_files(file_id, data_root, logger, webdav_enabled=False):
    """
    Scans for old version files and migrates them to the new structure if they exist.
    
    This function looks for files in the old structure (versions/timestamp/file-id.xml)
    and moves them to the new structure (versions/file-id/timestamp-file-id.xml).
    
    Args:
        file_id (str): The file identifier to migrate versions for
        data_root (str): Root data directory path
        logger: Logger instance for logging operations
        webdav_enabled (bool): Whether to create deletion markers for sync
    
    Returns:
        int: Number of files migrated
    """
    from glob import glob
    from pathlib import Path
    import shutil
    
    migrated_count = 0
    versions_dir = os.path.join(data_root, "versions")
    
    if not os.path.exists(versions_dir):
        return 0
    
    # Look for old structure files: versions/*/file-id.xml or file-id.tei.xml
    old_pattern_xml = os.path.join(versions_dir, "*", f"{file_id}.xml")
    old_pattern_tei = os.path.join(versions_dir, "*", f"{file_id}.tei.xml")
    
    old_files = glob(old_pattern_xml) + glob(old_pattern_tei)
    
    for old_file_path in old_files:
        old_path = Path(old_file_path)
        timestamp_dir = old_path.parent.name
        file_extension = ".tei.xml" if old_file_path.endswith(".tei.xml") else ".xml"
        
        # Ensure file_id doesn't contain .tei suffix (clean it if present)
        clean_file_id = file_id
        if clean_file_id.endswith('.tei'):
            clean_file_id = clean_file_id[:-4]
        
        # Skip if this is already in the new structure (timestamp_dir == clean_file_id)
        if timestamp_dir == clean_file_id:
            continue
            
        # Verify this looks like a timestamp directory
        if not timestamp_dir.replace("_", "").replace("-", "").replace(" ", "").isdigit():
            logger.warning(f"Skipping migration of {old_file_path} - parent directory '{timestamp_dir}' doesn't look like a timestamp")
            continue
        
        # Create new structure path
        new_filename = f"{timestamp_dir}-{clean_file_id}{file_extension}"
        new_dir = os.path.join(versions_dir, clean_file_id)
        new_file_path = os.path.join(new_dir, new_filename)
        
        try:
            # Create new directory structure
            os.makedirs(new_dir, exist_ok=True)
            
            # Move file to new location
            logger.info(f"Migrating version file from {old_file_path} to {new_file_path}")
            shutil.move(old_file_path, new_file_path)
            
            # Create deletion marker for old location if webdav is enabled
            if webdav_enabled:
                Path(old_file_path + ".deleted").touch()
                logger.info(f"Created deletion marker for old location at {old_file_path}.deleted")
            
            # Try to remove old timestamp directory if it's empty
            try:
                old_timestamp_dir = old_path.parent
                if old_timestamp_dir.exists() and not any(old_timestamp_dir.iterdir()):
                    logger.info(f"Removing empty old timestamp directory {old_timestamp_dir}")
                    old_timestamp_dir.rmdir()
            except OSError:
                # Directory not empty or other issue, ignore
                pass
                
            migrated_count += 1
            
        except Exception as e:
            logger.error(f"Failed to migrate {old_file_path} to {new_file_path}: {e}")
    
    if migrated_count > 0:
        logger.info(f"Successfully migrated {migrated_count} version files for file_id '{file_id}'")
    
    return migrated_count


# Colorized logging formatter for better visibility
class ColoredFormatter(logging.Formatter):
    """Add colors to log levels for better terminal visibility"""
    
    # ANSI color codes
    COLORS = {
        'DEBUG': '\033[36m',      # Cyan
        'INFO': '\033[32m',       # Green  
        'WARNING': '\033[33m',    # Yellow/Orange
        'ERROR': '\033[31m',      # Red
        'CRITICAL': '\033[91m',   # Bright Red
    }
    RESET = '\033[0m'  # Reset to default color
    
    def format(self, record):
        # Get the original formatted message
        original = super().format(record)
        
        # Add color based on log level
        level_name = record.levelname
        if level_name in self.COLORS:
            # Color the entire log message
            return f"{self.COLORS[level_name]}{original}{self.RESET}"
        return original
