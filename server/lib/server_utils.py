import datetime
import os
from flask import current_app

class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.

    Attributes:
        message -- explanation of the error
        status_code -- the HTTP (or other) status code associated with the error
        
    """
    def __init__(self, message, status_code=500):
        super().__init__(message)
        self.status_code = status_code


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
    if not file_path:
        raise ApiError("Invalid file path: path is empty", status_code=400)
    
    while len(file_path) > 0 and not file_path[0].isalpha():
        file_path = file_path[1:]
    if not file_path.startswith("data/"):
        raise ApiError(f"Invalid file path: {file_path}", status_code=400) 
    return file_path.removeprefix('data/')

def get_session_id(request):
    """
    Retrieves the session ID from the request header.
    """
    session_id = request.headers.get('X-Session-ID')
    if not session_id:
        raise ApiError("X-Session-ID header is missing", status_code=400)
    return session_id


def remove_obsolete_marker_if_exists(file_path, logger):
    """
    Checks for a .deleted marker corresponding to a file path and removes it if it exists.
    """
    marker_path = str(file_path) + ".deleted"
    if os.path.exists(marker_path):
        logger.info(f"Removing obsolete deletion marker at {marker_path} before writing file.")
        os.remove(marker_path)