import datetime
import os
from flask import current_app

class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.
    """

    pass

def get_gold_tei_path(file_id):
    DATA_ROOT = current_app.config['DATA_ROOT']
    return os.path.join(DATA_ROOT, "tei", f"{file_id}.tei.xml")


def make_timestamp():
    now = datetime.datetime.now()
    formatted_time = now.strftime("%Y-%m-%d %H:%M:%S")
    return formatted_time

def get_data_file_path(path):
    data_root = current_app.config["DATA_ROOT"]
    return data_root + path.removeprefix("/data")