"""
Restarting the worker processes of a production server.

bin/start-prod runs uvicorn with several workers and sets ``PTE_WORKER_RECYCLE=1`` (not on
Windows). On SIGHUP, the uvicorn supervisor, the workers' parent process, replaces the workers
one after the other: it starts each replacement and waits until it is ready before it stops the
old worker, so the server stays available. Used to apply plugin upgrades and data restores.
"""

import os
import signal

WORKER_RECYCLE_ENV_VAR = "PTE_WORKER_RECYCLE"


def can_recycle_workers() -> bool:
    """Whether the server was started by bin/start-prod and can replace its workers."""
    return os.getenv(WORKER_RECYCLE_ENV_VAR) == "1" and hasattr(signal, "SIGHUP")


def recycle_workers() -> int:
    """
    Ask the uvicorn supervisor to replace all workers.

    Returns:
        The process id of the supervisor
    """
    supervisor = os.getppid()
    os.kill(supervisor, signal.SIGHUP)
    return supervisor
