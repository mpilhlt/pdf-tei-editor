"""
Operator settings for installing plugins at runtime, and the audit log of plugin changes.

Installing a plugin installs server-side code with access to all documents, users and
secrets. The settings are therefore environment variables set by the operator, not config
keys that an administrator account could change from the web UI:

- ``PTE_PLUGIN_INSTALL=1``: enables discovering and installing plugins at runtime (off by default)
- ``PTE_PLUGIN_SOURCES``: comma-separated ``owner/repo`` list of plugin repositories that are
  always listed (default: ``mpilhlt/pte-plugins``)
- ``PTE_PLUGIN_DISCOVER_TOPIC``: GitHub topic searched for further plugin repositories
  (default: ``pte-plugin``; empty disables the search)
- ``PTE_PLUGIN_TRUSTED_OWNERS``: comma-separated GitHub owners whose plugins are trusted
  (default: ``mpilhlt``); installing other plugins requires typing the repository name to confirm
- ``PTE_PLUGIN_TRUSTED_ONLY=1``: hides and refuses plugins of untrusted owners
- ``GITHUB_TOKEN``: optional, raises the GitHub API rate limit

The topic can be set by anyone on GitHub; it is a discovery hint, never a trust signal.
"""

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi_app.config import get_settings

logger = logging.getLogger("fastapi_app.plugins.audit")

INSTALL_ENV_VAR = "PTE_PLUGIN_INSTALL"
SOURCES_ENV_VAR = "PTE_PLUGIN_SOURCES"
TOPIC_ENV_VAR = "PTE_PLUGIN_DISCOVER_TOPIC"
TRUSTED_OWNERS_ENV_VAR = "PTE_PLUGIN_TRUSTED_OWNERS"
TRUSTED_ONLY_ENV_VAR = "PTE_PLUGIN_TRUSTED_ONLY"
GITHUB_TOKEN_ENV_VAR = "GITHUB_TOKEN"

DEFAULT_SOURCES = ("mpilhlt/pte-plugins",)
DEFAULT_TOPIC = "pte-plugin"
DEFAULT_TRUSTED_OWNERS = ("mpilhlt",)

AUDIT_LOG_FILE = "plugin-audit.jsonl"

_TRUE = {"1", "true", "yes", "on"}


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in _TRUE


def _list(name: str, default: tuple[str, ...]) -> list[str]:
    value = os.getenv(name)
    if value is None:
        return list(default)
    return [item.strip() for item in value.split(",") if item.strip()]


def install_enabled() -> bool:
    """Whether the operator enabled runtime install (``PTE_PLUGIN_INSTALL``)."""
    return _flag(INSTALL_ENV_VAR)


def plugin_sources() -> list[str]:
    """Plugin repositories (``owner/repo``) that are always listed."""
    return [s for s in _list(SOURCES_ENV_VAR, DEFAULT_SOURCES) if is_repository_name(s)]


def discover_topic() -> str:
    """GitHub topic to search for plugin repositories; empty if the search is disabled."""
    return os.getenv(TOPIC_ENV_VAR, DEFAULT_TOPIC).strip()


def trusted_owners() -> list[str]:
    """GitHub owners whose plugins are trusted, lower case."""
    return [o.lower() for o in _list(TRUSTED_OWNERS_ENV_VAR, DEFAULT_TRUSTED_OWNERS)]


def trusted_only() -> bool:
    """Whether plugins of untrusted owners are hidden and refused."""
    return _flag(TRUSTED_ONLY_ENV_VAR)


def is_repository_name(value: str) -> bool:
    """Whether a string has the form ``owner/repo`` with GitHub-safe characters."""
    parts = value.split("/")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
    return len(parts) == 2 and all(p and set(p) <= allowed and p not in (".", "..") for p in parts)


def is_trusted(repository: str) -> bool:
    """Whether a repository (``owner/repo``) belongs to a trusted owner."""
    return repository.split("/")[0].lower() in trusted_owners()


def github_token() -> str | None:
    """The optional GitHub token for API requests."""
    return os.getenv(GITHUB_TOKEN_ENV_VAR) or None


def audit(action: str, user: dict[str, Any] | None = None, log_dir: Path | None = None, **fields: Any) -> None:
    """
    Record a plugin change in the audit log (``data/db/plugin-audit.jsonl``) and the server log.

    Args:
        action: e.g. "discover", "install", "upgrade", "remove", "enable", "disable", "restart"
        user: Acting user (None for the command line)
        log_dir: Directory of the audit log (default: ``data/db``)
        **fields: Details such as plugin, repository, tag, version and sha256
    """
    entry: dict[str, Any] = {"time": time.time(), "action": action, "user": (user or {}).get("username", "cli")}
    entry.update(fields)
    logger.info(f"Plugin audit: {json.dumps(entry, sort_keys=True)}")
    try:
        path = (log_dir or get_settings().db_dir) / AUDIT_LOG_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
    except OSError as e:
        logger.error(f"Could not write the plugin audit log: {e}")
