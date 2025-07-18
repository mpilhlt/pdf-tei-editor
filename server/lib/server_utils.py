import datetime
import os
from flask import current_app

class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.
    """

    pass


def make_timestamp():
    now = datetime.datetime.now()
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