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
    return data_root + path.removeprefix("/data")