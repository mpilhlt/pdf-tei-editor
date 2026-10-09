"""
Per-user feed token storage for the revision feed plugin.

Tokens authenticate the public Atom feed endpoint (a query-string token,
not a session) and are stored separately from core `users.json` — a
single-purpose feed credential should not require changing core auth
schema. One token per user; regenerating invalidates the previous one.

Concurrency: the read-modify-write cycle in `get_or_create_token` and
`regenerate_token` is protected by a per-process thread lock plus an
OS-level file lock around the sibling `tokens.lock` file, mirroring the
pattern `AuthManager` uses for `users.json` (thread lock,
fastapi_app/lib/utils/auth.py) and `set_config_value`/`delete_config_value`
use for `config.json` (thread lock + file lock around a `.lock` sibling
file, fastapi_app/lib/utils/config_utils.py). This avoids corrupting or
losing token data when two requests race (e.g. two tabs both calling
`/token/regenerate`, or `/my-feeds` racing `/token/regenerate`).
"""

import secrets
import sys
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi_app.lib.utils.data_utils import load_json_file, save_json_file

TOKENS_FILE_NAME = "tokens.json"

# Platform-specific imports for file locking
if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

# Per-process lock guarding the token store's read-modify-write sequence
# against concurrent requests within the same process.
_lock = threading.Lock()


def _lock_file(file_handle) -> None:
    """Cross-platform file locking (mirrors fastapi_app/lib/utils/config_utils.py)."""
    if sys.platform == "win32":
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_LOCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_EX)


def _unlock_file(file_handle) -> None:
    """Cross-platform file unlocking (mirrors fastapi_app/lib/utils/config_utils.py)."""
    if sys.platform == "win32":
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_UN)


def _tokens_path(plugins_data_dir: Path) -> Path:
    return Path(plugins_data_dir) / "revision_feed" / TOKENS_FILE_NAME


def _lock_path(plugins_data_dir: Path) -> Path:
    return _tokens_path(plugins_data_dir).with_suffix(".lock")


def _load_tokens(plugins_data_dir: Path) -> dict[str, dict[str, str]]:
    data = load_json_file(_tokens_path(plugins_data_dir), create_if_missing=True, default_content={})
    return data if isinstance(data, dict) else {}


def _save_tokens(plugins_data_dir: Path, tokens: dict[str, dict[str, str]]) -> None:
    _tokens_path(plugins_data_dir).parent.mkdir(parents=True, exist_ok=True)
    save_json_file(_tokens_path(plugins_data_dir), tokens)


def _new_token_entry() -> dict[str, str]:
    return {
        "token": secrets.token_urlsafe(32),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def _with_locked_tokens(
    plugins_data_dir: Path,
    mutator: Callable[[dict[str, dict[str, str]]], str],
) -> str:
    """Run `mutator` over the loaded tokens under thread lock + OS file lock.

    `mutator` receives the loaded tokens dict, mutates it in place, and
    returns the value to hand back to the caller (e.g. the new token). The
    mutated dict is persisted before the locks are released.
    """
    tokens_path = _tokens_path(plugins_data_dir)
    tokens_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = _lock_path(plugins_data_dir)

    with _lock:
        with open(lock_path, "a", encoding="utf-8") as lf:
            _lock_file(lf)
            try:
                tokens = _load_tokens(plugins_data_dir)
                result = mutator(tokens)
                _save_tokens(plugins_data_dir, tokens)
            finally:
                _unlock_file(lf)
    return result


def get_or_create_token(username: str, plugins_data_dir: Path) -> str:
    """Return the user's existing feed token, creating one if they have none."""

    def _mutate(tokens: dict[str, dict[str, str]]) -> str:
        entry = tokens.get(username)
        if not entry:
            entry = _new_token_entry()
            tokens[username] = entry
        return entry["token"]

    return _with_locked_tokens(plugins_data_dir, _mutate)


def regenerate_token(username: str, plugins_data_dir: Path) -> str:
    """Issue a new feed token for the user, invalidating any previous one."""

    def _mutate(tokens: dict[str, dict[str, str]]) -> str:
        entry = _new_token_entry()
        tokens[username] = entry
        return entry["token"]

    return _with_locked_tokens(plugins_data_dir, _mutate)


def resolve_token(token: str, plugins_data_dir: Path) -> Optional[str]:
    """Return the username owning this token, or None if it is unknown."""
    with _lock:
        tokens = _load_tokens(plugins_data_dir)
    for username, entry in tokens.items():
        if entry.get("token") == token:
            return username
    return None
