"""
Preflight check for GROBID servers hosted on Hugging Face Spaces.

A sleeping or paused Space answers requests with errors that the retry logic would
otherwise retry until it times out. The Hugging Face runtime API reports the Space
state directly, which allows failing fast with an actionable message.
"""

import logging
import os
from typing import Any
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

HF_API_URL = "https://huggingface.co/api/spaces"
HF_SPACE_URL = "https://huggingface.co/spaces"
HF_HOST_SUFFIX = ".hf.space"

# Stages in which the Space serves requests
RUNNING_STAGES = {"RUNNING", "RUNNING_BUILDING"}

# Stages that require the owner to start the Space manually
STOPPED_STAGES = {"SLEEPING", "PAUSED", "STOPPED"}

# Resolved Space IDs by server URL, so that the hyphen-split lookup runs once per process
_resolved_spaces: dict[str, str] = {}


def _get_hf_host(server_url: str) -> str | None:
    """Return the hostname of a *.hf.space URL, or None for any other URL."""
    host = urlparse(server_url).hostname
    if host and host.endswith(HF_HOST_SUFFIX):
        return host
    return None


def _fetch_runtime(space_id: str, timeout: float) -> dict[str, Any] | None:
    """
    Fetch the runtime info of a Space from the Hugging Face API.

    Args:
        space_id: Space identifier in the form "owner/repo"
        timeout: Request timeout in seconds

    Returns:
        The runtime info dict, or None if the request failed or the Space is not accessible
        (nonexistent, or private without a valid HF_TOKEN).
    """
    headers: dict[str, str] = {}
    token = os.environ.get("HF_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = requests.get(f"{HF_API_URL}/{space_id}/runtime", headers=headers, timeout=timeout)
        if response.status_code != 200:
            return None
        runtime = response.json()
    except (requests.RequestException, ValueError) as e:
        logger.debug("Could not fetch runtime of Hugging Face Space %s: %s", space_id, e)
        return None
    return runtime if isinstance(runtime, dict) else None


def _serves_host(runtime: dict[str, Any], host: str) -> bool:
    """Return False only if the runtime lists domains and none of them is the given host."""
    domains = runtime.get("domains")
    if not domains:
        return True
    return any(d.get("domain") == host for d in domains if isinstance(d, dict))


def _guess_space(host: str, timeout: float) -> tuple[str, dict[str, Any]] | None:
    """
    Guess the Space behind "<owner>-<repo>.hf.space" by trying each hyphen as the owner/repo separator.

    Returns:
        (space_id, runtime) of the first candidate whose runtime info serves the host, or None.
    """
    label = host.removesuffix(HF_HOST_SUFFIX)
    parts = label.split("-")
    for i in range(1, len(parts)):
        space_id = f"{'-'.join(parts[:i])}/{'-'.join(parts[i:])}"
        runtime = _fetch_runtime(space_id, timeout)
        if runtime is not None and _serves_host(runtime, host):
            return space_id, runtime
    return None


def check_space_running(server_url: str, timeout: float, configured_space: str | None = None) -> str | None:
    """
    Check whether the Hugging Face Space behind a GROBID server URL is running.

    The check applies if a Space ID is configured or the URL is a *.hf.space URL. It never
    blocks extraction on its own failure: if the Space cannot be resolved or the API cannot
    be reached, the check is skipped.

    Args:
        server_url: The configured GROBID server URL
        timeout: Timeout in seconds for each Hugging Face API request
        configured_space: Optional Space ID ("owner/repo") from the plugin configuration

    Returns:
        None if the Space is running or the check was skipped, otherwise an error message
        for the user.
    """
    runtime: dict[str, Any] | None = None
    space_id = configured_space or _resolved_spaces.get(server_url)
    if space_id:
        runtime = _fetch_runtime(space_id, timeout)
    else:
        host = _get_hf_host(server_url)
        if host is None:
            return None
        guess = _guess_space(host, timeout)
        if guess:
            space_id, runtime = guess
            _resolved_spaces[server_url] = space_id
    if not space_id or runtime is None:
        return None

    stage = str(runtime.get("stage", "")).upper()
    if not stage or stage in RUNNING_STAGES:
        return None

    space_url = f"{HF_SPACE_URL}/{space_id}"
    if stage in STOPPED_STAGES:
        return f"The GROBID Hugging Face Space is {stage.lower()}. Start it first at {space_url} and try again."
    return f"The GROBID Hugging Face Space is not ready (stage: {stage}). Check {space_url} and try again."
