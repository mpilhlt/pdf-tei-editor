"""
Per-user record of document edits for the recent documents plugin.

The files table only records who created a file, not who saved it last, so this
plugin keeps its own record in `<plugins_data_dir>/recent_documents/recent_edits.json`:

    {"seeded": true, "users": {"<username>": {"<stable_id>": "<ISO timestamp>"}}}

Writes are protected by a per-process thread lock plus an OS-level file lock around
a sibling `.lock` file, following the revision feed token store.
"""

import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict, TypeVar

from fastapi_app.lib.utils.config_utils import _lock_file, _unlock_file
from fastapi_app.lib.utils.data_utils import load_json_file, save_json_file

EDITS_FILE_NAME = "recent_edits.json"

# Number of edited files remembered per user; older entries are dropped
MAX_ENTRIES_PER_USER = 300

_lock = threading.Lock()

T = TypeVar("T")

class EditData(TypedDict):
    seeded: bool
    users: dict[str, dict[str, str]]


def _edits_path(plugins_data_dir: Path) -> Path:
    return Path(plugins_data_dir) / "recent_documents" / EDITS_FILE_NAME


def _load(plugins_data_dir: Path) -> EditData:
    try:
        data = load_json_file(_edits_path(plugins_data_dir), create_if_missing=False, default_content=None)
    except ValueError:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
        return {"seeded": False, "users": {}}
    return {"seeded": bool(data.get("seeded")), "users": data["users"]}


def _with_locked_edits(plugins_data_dir: Path, mutator: Callable[[EditData], T]) -> T:
    """Run `mutator` over the loaded data under thread lock and file lock, then persist it."""
    edits_path = _edits_path(plugins_data_dir)
    edits_path.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        with open(edits_path.with_suffix(".lock"), "a", encoding="utf-8") as lock_file:
            _lock_file(lock_file)
            try:
                data = _load(plugins_data_dir)
                result = mutator(data)
                save_json_file(edits_path, data)
            finally:
                _unlock_file(lock_file)
    return result


def _add_entries(data: EditData, username: str, entries: dict[str, str]) -> None:
    users = data["users"]
    user_edits = users.setdefault(username, {})
    for stable_id, edited_at in entries.items():
        if edited_at > user_edits.get(stable_id, ""):
            user_edits[stable_id] = edited_at
    if len(user_edits) > MAX_ENTRIES_PER_USER:
        newest = sorted(user_edits.items(), key=lambda item: item[1], reverse=True)[:MAX_ENTRIES_PER_USER]
        users[username] = dict(newest)


def record_edit(username: str, stable_id: str, plugins_data_dir: Path, edited_at: datetime | None = None) -> None:
    """Record that `username` saved the file `stable_id` (now, unless `edited_at` is given)."""
    timestamp = (edited_at or datetime.now(timezone.utc)).isoformat()
    _with_locked_edits(plugins_data_dir, lambda data: _add_entries(data, username, {stable_id: timestamp}))


def seed_edits(entries: dict[str, dict[str, str]], plugins_data_dir: Path) -> bool:
    """Add initial edits (`{username: {stable_id: iso_timestamp}}`) once.

    Returns False without changing anything if the store has been seeded before.
    """

    def _mutate(data: EditData) -> bool:
        if data["seeded"]:
            return False
        for username, user_entries in entries.items():
            _add_entries(data, username, user_entries)
        data["seeded"] = True
        return True

    return _with_locked_edits(plugins_data_dir, _mutate)


def is_seeded(plugins_data_dir: Path) -> bool:
    """Return True if `seed_edits` has run for this data directory."""
    with _lock:
        return _load(plugins_data_dir)["seeded"]


def get_user_edits(username: str, plugins_data_dir: Path) -> list[tuple[str, str]]:
    """Return the user's edits as `(stable_id, iso_timestamp)` pairs, newest first."""
    with _lock:
        users = _load(plugins_data_dir)["users"]
    user_edits = users.get(username, {})
    return sorted(user_edits.items(), key=lambda item: item[1], reverse=True)
