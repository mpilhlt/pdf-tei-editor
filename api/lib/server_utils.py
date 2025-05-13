import datetime
import os
from flask import current_app

class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.
    """

    pass

def get_gold_tei_path(file_id):
    WEB_ROOT = current_app.config['WEB_ROOT']
    return os.path.join(WEB_ROOT, "data", "tei", f"{file_id}.tei.xml")


def make_timestamp():
    now = datetime.datetime.now()
    formatted_time = now.strftime("%Y-%m-%d %H:%M:%S")
    return formatted_time
