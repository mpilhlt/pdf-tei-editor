"""
Plugin state shared by all server processes.

Production runs several uvicorn workers, each with its own PluginRegistry. The set of
plugins disabled by an administrator is therefore kept in ``data/db/plugins-state.json``::

    {"generation": 3, "disabled": ["grobid"]}

The worker that serves a change request writes the file and applies the change; the
other workers watch the file and apply it when ``generation`` changes (see
``PluginManager.watch_state()``). Each worker reports the generation it has applied
in a heartbeat file in ``data/db/plugin-workers/``, so that the plugin manager can show
when a change has reached all workers.

The state used to be stored in the config key ``plugins.disabled``; it is migrated
when the state file is created.
"""

import json
import logging
import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

from fastapi_app.lib.utils.config_utils import _lock_file, _unlock_file

logger = logging.getLogger(__name__)

STATE_FILE = "plugins-state.json"
LOCK_FILE = "plugins-state.lock"
WORKERS_DIR = "plugin-workers"

# Config key that held the disabled plugin ids before the state file existed
LEGACY_DISABLED_CONFIG_KEY = "plugins.disabled"

# A worker whose heartbeat is older than this is considered gone
HEARTBEAT_MAX_AGE = 15.0
# Heartbeat files older than this are deleted
HEARTBEAT_STALE_AGE = 300.0


@dataclass(frozen=True)
class PluginState:
    """Desired plugin state; ``generation`` increases with every change."""

    generation: int = 0
    disabled: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class WorkerHeartbeat:
    """The plugin state generation a worker process has applied."""

    pid: int
    generation: int
    time: float


class PluginStateStore:
    """Reads and writes the shared plugin state and the worker heartbeats in a directory."""

    def __init__(self, db_dir: Path, legacy_disabled: Callable[[], list[str]] | None = None):
        """
        Args:
            db_dir: Directory of the state file (``data/db``)
            legacy_disabled: Returns the disabled ids of the former config key; used once,
                when the state file does not exist yet
        """
        self.db_dir = db_dir
        self.state_file = db_dir / STATE_FILE
        self.workers_dir = db_dir / WORKERS_DIR
        self._legacy_disabled = legacy_disabled

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self.db_dir.mkdir(parents=True, exist_ok=True)
        with open(self.db_dir / LOCK_FILE, "a", encoding="utf-8") as lock:
            _lock_file(lock)
            try:
                yield
            finally:
                _unlock_file(lock)

    def _read_unlocked(self) -> PluginState | None:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            logger.error(f"Cannot read {self.state_file}, assuming no disabled plugins: {e}")
            return PluginState()
        return PluginState(
            generation=int(data.get("generation", 0)),
            disabled=frozenset(str(p) for p in data.get("disabled", [])),
        )

    def _write_unlocked(self, state: PluginState) -> None:
        content = json.dumps({"generation": state.generation, "disabled": sorted(state.disabled)}, indent=2)
        fd, tmp = tempfile.mkstemp(dir=self.db_dir, prefix=".plugins-state-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content + "\n")
            os.replace(tmp, self.state_file)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def read(self) -> PluginState:
        """
        Return the current state, creating the state file (from the legacy config key) if needed.

        Returns:
            The current plugin state
        """
        state = self._read_unlocked()
        if state is not None:
            return state
        with self._locked():
            state = self._read_unlocked()
            if state is None:
                disabled = frozenset(str(p) for p in (self._legacy_disabled() if self._legacy_disabled else []))
                state = PluginState(generation=0, disabled=disabled)
                self._write_unlocked(state)
                if disabled:
                    logger.info(f"Migrated disabled plugins from config to {self.state_file}: {sorted(disabled)}")
        return state

    def write(self, disabled: set[str] | frozenset[str]) -> PluginState:
        """
        Store a new set of disabled plugins with the next generation.

        Args:
            disabled: Ids of the plugins disabled by an administrator

        Returns:
            The stored state

        Raises:
            OSError: If the file cannot be written
        """
        with self._locked():
            current = self._read_unlocked() or PluginState()
            state = PluginState(generation=current.generation + 1, disabled=frozenset(disabled))
            self._write_unlocked(state)
        return state

    def mtime(self) -> float | None:
        """Modification time of the state file, None if it does not exist."""
        try:
            return self.state_file.stat().st_mtime
        except OSError:
            return None

    def write_heartbeat(self, generation: int, pid: int | None = None) -> None:
        """Record that this worker process has applied a generation."""
        pid = os.getpid() if pid is None else pid
        self.workers_dir.mkdir(parents=True, exist_ok=True)
        path = self.workers_dir / f"{pid}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"pid": pid, "generation": generation, "time": time.time()}), encoding="utf-8")
        os.replace(tmp, path)

    def remove_heartbeat(self, pid: int | None = None) -> None:
        """Remove the heartbeat of a worker process that shuts down."""
        pid = os.getpid() if pid is None else pid
        (self.workers_dir / f"{pid}.json").unlink(missing_ok=True)

    def heartbeats(self, max_age: float = HEARTBEAT_MAX_AGE) -> list[WorkerHeartbeat]:
        """
        Return the heartbeats of the running workers; deletes long-stale heartbeat files.

        Args:
            max_age: Heartbeats older than this many seconds are ignored

        Returns:
            Heartbeats of the workers considered running
        """
        now = time.time()
        result: list[WorkerHeartbeat] = []
        if not self.workers_dir.is_dir():
            return result
        for path in self.workers_dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                beat = WorkerHeartbeat(pid=int(data["pid"]), generation=int(data["generation"]), time=float(data["time"]))
            except (OSError, ValueError, KeyError, TypeError):
                continue
            age = now - beat.time
            if age > HEARTBEAT_STALE_AGE:
                path.unlink(missing_ok=True)
            elif age <= max_age:
                result.append(beat)
        return result
