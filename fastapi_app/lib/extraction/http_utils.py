"""
HTTP utilities for extractors with retry logic.
"""

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


def get_retry_session(retries=5, backoff_factor=1.0, status_forcelist=None) -> requests.Session:
    """
    Create a requests Session with retry logic.

    Args:
        retries: Maximum number of retry attempts (default: 5)
        backoff_factor: Factor for exponential backoff (delay = backoff_factor * (2 ** (retry_count - 1)))
        status_forcelist: HTTP status codes to retry on (default: [429, 500, 502, 503, 504])

    Returns:
        Configured requests.Session with retry adapter

    Example:
        >>> session = get_retry_session(retries=3, backoff_factor=2.0)
        >>> response = session.get("https://api.example.com/data", timeout=30)
    """
    if status_forcelist is None:
        status_forcelist = [429, 500, 502, 503, 504]

    session = requests.Session()
    retry_strategy = Retry(
        total=retries,
        backoff_factor=backoff_factor,
        status_forcelist=status_forcelist,
        allowed_methods=["HEAD", "GET", "POST", "PUT", "DELETE", "OPTIONS", "TRACE"]
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session
