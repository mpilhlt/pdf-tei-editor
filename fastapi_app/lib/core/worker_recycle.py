"""
Restarting the worker processes of the server.

bin/start-prod runs uvicorn with several workers and sets ``PTE_WORKER_RECYCLE=1`` (not on
Windows). On SIGHUP, the uvicorn supervisor, the workers' parent process, replaces the workers
one after the other: it starts each replacement and waits until it is ready before it stops the
old worker, so the server stays available.

bin/start-dev runs uvicorn with auto-reload and sets ``PTE_DEV_RELOAD_TRIGGER`` to the path of a
Python file that the reloader watches. Writing to that file makes the reloader restart the
server process.

Used to apply plugin upgrades and data restores.
"""

import os
import signal
import time
from pathlib import Path

WORKER_RECYCLE_ENV_VAR = "PTE_WORKER_RECYCLE"
DEV_RELOAD_TRIGGER_ENV_VAR = "PTE_DEV_RELOAD_TRIGGER"


def _dev_reload_trigger() -> Path | None:
    """The file whose change restarts the dev server, or None if the server is not a reloading dev server."""
    value = os.getenv(DEV_RELOAD_TRIGGER_ENV_VAR)
    return Path(value) if value else None


def can_recycle_workers() -> bool:
    """Whether the server was started by bin/start-prod or bin/start-dev and can replace its workers."""
    if os.getenv(WORKER_RECYCLE_ENV_VAR) == "1" and hasattr(signal, "SIGHUP"):
        return True
    return _dev_reload_trigger() is not None


def recycle_workers() -> int:
    """
    Ask the uvicorn supervisor to replace all workers.

    Returns:
        The process id of the supervisor
    """
    supervisor = os.getppid()
    if os.getenv(WORKER_RECYCLE_ENV_VAR) == "1" and hasattr(signal, "SIGHUP"):
        os.kill(supervisor, signal.SIGHUP)
        return supervisor
    trigger = _dev_reload_trigger()
    if trigger is None:
        raise RuntimeError("The server cannot restart its workers")
    trigger.parent.mkdir(parents=True, exist_ok=True)
    trigger.write_text(f"# Written by the server to restart the dev server: {time.time()}\n", encoding="utf-8")
    return supervisor
